import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { probeServer } from '@deepseek-ai/dsh-mcp-client';
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import {
  ENVIRONMENT_EVENT,
  PLUGIN_ID,
  SERVICES,
} from './constants.js';
import { OnboardingController } from './core.js';
import { legacyEntryIds, probeConfig, readAccountOrigin, writeBoundOrigin } from './endpoints.js';
import { OnboardingError } from './errors.js';
import { createBundledSkillProvider } from './skills.js';

export const name = PLUGIN_ID;
export const inject = ['mcpManager', 'credentials', 'skills', 'settings'];
export const Config = z.object({
  /** Non-secret environment binding; the API Key remains in CredentialRef storage. */
  boundOrigin: z.string().volatile(),
});

function credentialAdapter(ctx) {
  const safe = operation => async (...args) => {
    try { return await operation(...args); }
    catch { throw new OnboardingError('CREDENTIAL_ERROR'); }
  };
  return {
    describe: safe(ref => ctx.credentials.describe(credentialRef(ref))),
    resolve: safe(ref => ctx.credentials.resolve(credentialRef(ref))),
    set: safe((ref, value) => ctx.credentials.set(credentialRef(ref), value)),
    unset: safe(ref => ctx.credentials.unset(credentialRef(ref))),
  };
}

export function registerOnboardingService(ctx, config, dependencies = {}) {
  const RemoteDecorator = dependencies.Remote ?? Remote;
  const ServiceBase = dependencies.TypertRemoteService ?? TypertRemoteService;
  const probe = dependencies.probeServer ?? probeServer;
  const initializers = [];
  class DataHubOnboarding extends ServiceBase {
    static inject = ['mcpManager', 'credentials'];

    constructor(hostCtx) {
      super(hostCtx, 'datahubOnboarding');
      for (const initialize of initializers) initialize.call(this);
      let origin;
      let environmentInvalid = false;
      try { origin = readAccountOrigin(hostCtx.get('deepseekAccount')); }
      catch { origin = undefined; environmentInvalid = true; }
      const settings = hostCtx.get('settings');
      const entryId = hostCtx.fiber.entry?.options.id;
      const saveBoundOrigin = value => writeBoundOrigin(settings, entryId, value);
      this.controller = new OnboardingController({
        origin,
        boundOrigin: config.boundOrigin?.get?.(),
        credentials: credentialAdapter(hostCtx),
        mcpManager: hostCtx.mcpManager,
        probe: (targetOrigin, service, ref, signal) => probe(hostCtx, probeConfig(targetOrigin, service, ref), {
          timeoutMs: 30_000,
          signal,
        }),
        saveBoundOrigin,
        hasLegacy: () => legacyEntryIds(hostCtx.get('configEditor')?.entries()).length > 0,
        onEnvironment: callback => hostCtx.on(ENVIRONMENT_EVENT, callback),
        logger: hostCtx.logger,
      });
      if (environmentInvalid) {
        this.controller.environmentInvalid = true;
        this.controller.error = { code: 'INVALID_ORIGIN' };
      }
      hostCtx.effect(() => () => this.controller.dispose(), 'datahub-onboarding: connection lifetime');
    }

    state() { return this.controller.refreshState(); }
    connect(apiKey, origin, signal) { return this.controller.connect({ apiKey, origin }, signal); }
    retry(origin, signal) { return this.controller.retry({ origin }, signal); }
    disconnect(signal) { return this.controller.disconnect(signal); }
    cancel() { return this.controller.cancel(); }
    clearKey(signal) { return this.controller.clearKey(signal); }
  }
  for (const method of ['state', 'connect', 'retry', 'disconnect', 'cancel', 'clearKey']) {
    RemoteDecorator({ name: method })(DataHubOnboarding.prototype[method], {
      kind: 'method', name: method, static: false, private: false,
      addInitializer(initialize) { initializers.push(initialize); },
    });
  }
  ctx.plugin(DataHubOnboarding);
  return DataHubOnboarding;
}

export function apply(ctx, config) {
  const provider = createBundledSkillProvider({
    assetRoot: fileURLToPath(new URL('./assets/skills/', import.meta.url)),
    bundledRank: BUNDLED_SKILL_RANK,
  });
  ctx.skills.registerProvider(() => provider);
  registerOnboardingService(ctx, config);
}

export { SERVICES };
