import {
  FORMAL_CREDENTIAL_REF,
  SERVICES,
  STAGING_CREDENTIAL_REF,
} from './constants.js';
import { normalizeOrigin, registrationEntry } from './endpoints.js';
import { OnboardingError, asOnboardingError, throwIfAborted } from './errors.js';

const idleProbeStates = () => Object.fromEntries(SERVICES.map(service => [service.name, 'idle']));
const runtimeStates = new Set(['closed', 'waiting-credentials', 'connecting', 'connected', 'reconnecting', 'failed', 'disabled']);
const contextOf = controller => ({ origin: controller.origin, version: controller.environmentVersion });

function combinedSignal(controller, external) {
  const signals = [controller.signal, external].filter(Boolean);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function safeDetails(error) {
  const details = error.details;
  if (!details || typeof details !== 'object') return undefined;
  const result = {};
  if (SERVICES.some(service => service.name === details.service)) result.service = details.service;
  if (['connect', 'list', 'cleanup'].includes(details.stage)) result.stage = details.stage;
  if (Array.isArray(details.failures)) {
    result.failures = details.failures.map(failure => ({
      service: failure.service,
      stage: ['connect', 'list', 'cleanup'].includes(failure.stage) ? failure.stage : 'connect',
    })).filter(failure => SERVICES.some(service => service.name === failure.service));
  }
  return Object.keys(result).length ? result : undefined;
}

/**
 * Host-side state machine. Every network/commit operation is serialized; an
 * environment event synchronously withdraws registrations before cleanup drains.
 */
export class OnboardingController {
  constructor(options) {
    this.credentials = options.credentials;
    this.mcpManager = options.mcpManager;
    this.probe = options.probe;
    this.persistBoundOrigin = options.saveBoundOrigin;
    this.hasLegacy = options.hasLegacy ?? (() => false);
    this.readOrigin = options.readOrigin ?? (() => options.origin);
    this.logger = options.logger ?? { warn() {} };
    this.origin = normalizeOrigin(options.origin);
    this.boundOrigin = normalizeOrigin(options.boundOrigin);
    this.configured = false;
    this.legacyManaged = false;
    this.registrations = new Map();
    this.probeStates = idleProbeStates();
    this.operation = undefined;
    this.current = undefined;
    this.environmentVersion = 0;
    this.environmentInvalid = false;
    this.error = undefined;
    this.warning = undefined;
    this.ready = false;
    this.stopped = false;
    this.lifetime = new AbortController();
    this.tail = Promise.resolve();
    this.stopEnvironment = options.onEnvironment?.(value => this.environmentChanged(value)) ?? (() => {});
    this.readyPromise = this.schedule('initializing', undefined, async signal => {
      try { await this.restore(signal); }
      catch (error) { this.recordError(error); }
      finally { this.ready = true; }
    }).then(() => this.snapshot());
  }

  log(error) {
    const safe = asOnboardingError(error);
    this.logger.warn(`datahub-onboarding: ${safe.code}`);
  }

  readLegacy() {
    return this.hasLegacy() === true;
  }

  schedule(operation, externalSignal, fn) {
    const run = this.tail.then(async () => {
      if (this.stopped) throw new OnboardingError('CANCELLED');
      const controller = new AbortController();
      const signal = combinedSignal(controller, externalSignal);
      const current = { controller, operation };
      this.current = current;
      this.operation = operation;
      try { return await fn(signal); }
      finally {
        if (this.current === current) {
          this.current = undefined;
          this.operation = undefined;
        }
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  context(signal, expectedOrigin) {
    this.syncEnvironment();
    throwIfAborted(signal);
    if (!this.origin) throw new OnboardingError(this.environmentInvalid ? 'INVALID_ORIGIN' : 'ENVIRONMENT_REQUIRED');
    if (expectedOrigin !== undefined && expectedOrigin !== this.origin) throw new OnboardingError('ENVIRONMENT_CHANGED');
    return contextOf(this);
  }

  assertContext(context, signal) {
    throwIfAborted(signal);
    if (context.version !== this.environmentVersion || context.origin !== this.origin) {
      throw new OnboardingError('ENVIRONMENT_CHANGED');
    }
    if (this.readLegacy()) {
      this.legacyManaged = true;
      this.releaseRegistrations();
      throw new OnboardingError('LEGACY_MANAGED');
    }
  }

  async restore(signal) {
    this.legacyManaged = this.readLegacy();
    const described = await this.credentials.describe(FORMAL_CREDENTIAL_REF);
    this.configured = described?.configured === true;
    const context = contextOf(this);
    throwIfAborted(signal);
    if (this.legacyManaged || !this.origin || !this.configured) return;
    if (this.boundOrigin !== this.origin) return;
    this.registerMissing(context, signal);
  }

  registerMissing(context, signal) {
    const before = new Set(this.registrations.keys());
    try {
      for (const service of SERVICES) {
        this.assertContext(context, signal);
        if (this.registrations.has(service.name)) continue;
        const entry = registrationEntry(context.origin, service, FORMAL_CREDENTIAL_REF);
        const dispose = this.mcpManager.register(service.name, entry);
        this.registrations.set(service.name, dispose);
      }
    } catch (error) {
      this.rollbackRegistrations(before);
      if (error instanceof OnboardingError) throw error;
      throw new OnboardingError('REGISTRATION_FAILED');
    }
  }

  rollbackRegistrations(before) {
    for (const [name, dispose] of [...this.registrations]) {
      if (before.has(name)) continue;
      try { dispose(); }
      catch (error) { this.log(error); }
      this.registrations.delete(name);
    }
  }

  releaseRegistrations() {
    for (const [name, dispose] of [...this.registrations]) {
      try { dispose(); }
      catch (error) { this.log(error); }
      this.registrations.delete(name);
    }
  }

  async probeAll(origin, credentialRef, signal, context) {
    const failures = [];
    for (const service of SERVICES) {
      this.assertContext(context, signal);
      this.probeStates[service.name] = 'validating';
      let result;
      try {
        result = await this.probe(origin, service, credentialRef, signal);
      } catch (error) {
        if (signal.aborted || context.version !== this.environmentVersion) this.assertContext(context, signal);
        result = { ok: false, stage: 'connect' };
      }
      const cleanupFailed = result?.closeConfirmed === false || result?.cleanupError !== undefined;
      if (result?.ok === true && !cleanupFailed) this.probeStates[service.name] = 'succeeded';
      else {
        this.probeStates[service.name] = 'failed';
        failures.push({ service: service.name, stage: cleanupFailed ? 'cleanup' : result?.stage === 'list' ? 'list' : 'connect' });
      }
    }
    this.assertContext(context, signal);
    if (failures.length) throw new OnboardingError('PROBE_FAILED', { failures });
  }

  async performConnect(apiKey, expectedOrigin, signal) {
    const context = this.context(signal, expectedOrigin);
    this.legacyManaged = this.readLegacy();
    if (this.legacyManaged) throw new OnboardingError('LEGACY_MANAGED');
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 16_384) {
      throw new OnboardingError('INVALID_API_KEY');
    }
    const key = apiKey.trim();
    const beforeRegistrations = new Set(this.registrations.keys());
    const previousBound = this.boundOrigin;
    let previousFormal;
    let formalChanged = false;
    let boundChanged = false;
    try {
      await this.credentials.set(STAGING_CREDENTIAL_REF, key);
      this.assertContext(context, signal);
      await this.probeAll(context.origin, STAGING_CREDENTIAL_REF, signal, context);
      previousFormal = await this.credentials.resolve(FORMAL_CREDENTIAL_REF);
      this.assertContext(context, signal);
      await this.credentials.set(FORMAL_CREDENTIAL_REF, key);
      formalChanged = true;
      this.configured = true;
      this.assertContext(context, signal);
      await this.persistBoundOrigin(context.origin);
      boundChanged = true;
      this.boundOrigin = context.origin;
      this.assertContext(context, signal);
      this.registerMissing(context, signal);
    } catch (error) {
      this.rollbackRegistrations(beforeRegistrations);
      if (formalChanged) {
        try {
          if (previousFormal?.value) await this.credentials.set(FORMAL_CREDENTIAL_REF, previousFormal.value);
          else await this.credentials.unset(FORMAL_CREDENTIAL_REF);
          this.configured = previousFormal?.value !== undefined;
        } catch (rollbackError) { this.log(rollbackError); this.warning = 'ROLLBACK_FAILED'; }
      }
      if (boundChanged) {
        try { await this.persistBoundOrigin(previousBound); this.boundOrigin = previousBound; }
        catch (rollbackError) { this.log(rollbackError); this.warning = 'ROLLBACK_FAILED'; }
      }
      throw error;
    } finally {
      try { await this.credentials.unset(STAGING_CREDENTIAL_REF); }
      catch (error) { this.log(error); this.warning = 'STAGING_CLEANUP_FAILED'; }
    }
  }

  connect(request, signal) {
    this.syncEnvironment();
    return this.schedule('validating', signal, async lifetime => {
      this.error = undefined;
      this.warning = undefined;
      this.probeStates = idleProbeStates();
      try { await this.performConnect(request?.apiKey, request?.origin, lifetime); }
      catch (error) { this.recordError(error); }
    }).then(() => this.snapshot());
  }

  retry(request, signal) {
    this.syncEnvironment();
    return this.schedule('validating', signal, async lifetime => {
      this.error = undefined;
      this.warning = undefined;
      this.probeStates = idleProbeStates();
      try {
        const context = this.context(lifetime, request?.origin);
        this.legacyManaged = this.readLegacy();
        if (this.legacyManaged) throw new OnboardingError('LEGACY_MANAGED');
        if (!this.configured) throw new OnboardingError('KEY_REQUIRED');
        if (this.boundOrigin !== context.origin) throw new OnboardingError('ENVIRONMENT_CHANGED');
        await this.probeAll(context.origin, FORMAL_CREDENTIAL_REF, lifetime, context);
        this.registerMissing(context, lifetime);
      } catch (error) { this.recordError(error); }
    }).then(() => this.snapshot());
  }

  disconnect(signal) {
    this.syncEnvironment();
    this.cancel();
    return this.schedule('disconnecting', signal, async lifetime => {
      this.error = undefined;
      this.warning = undefined;
      try {
        if (this.readLegacy()) throw new OnboardingError('LEGACY_MANAGED');
        throwIfAborted(lifetime);
        this.releaseRegistrations();
        this.probeStates = idleProbeStates();
        await this.persistBoundOrigin(undefined);
        this.boundOrigin = undefined;
      } catch (error) { this.recordError(error); }
    }).then(() => this.snapshot());
  }

  clearKey(signal) {
    this.syncEnvironment();
    this.cancel();
    return this.schedule('clearing', signal, async lifetime => {
      this.error = undefined;
      this.warning = undefined;
      let failure;
      try {
        if (this.readLegacy()) throw new OnboardingError('LEGACY_MANAGED');
        throwIfAborted(lifetime);
        this.releaseRegistrations();
        this.probeStates = idleProbeStates();
        try { await this.credentials.unset(FORMAL_CREDENTIAL_REF); this.configured = false; }
        catch (error) { failure = error; }
        try { await this.credentials.unset(STAGING_CREDENTIAL_REF); }
        catch (error) { failure ??= error; }
        try { await this.persistBoundOrigin(undefined); this.boundOrigin = undefined; }
        catch (error) { failure ??= error; }
        if (failure) throw failure;
      } catch (error) { this.recordError(error); }
    }).then(() => this.snapshot());
  }

  cancel() {
    this.current?.controller.abort();
    return this.refreshState();
  }

  applyEnvironment(next, invalid) {
    if (next === this.origin && invalid === this.environmentInvalid) return;
    this.origin = next;
    this.environmentInvalid = invalid;
    this.environmentVersion += 1;
    this.current?.controller.abort();
    this.releaseRegistrations();
    this.probeStates = idleProbeStates();
    this.error = invalid ? { code: 'INVALID_ORIGIN' } : undefined;
    this.warning = undefined;
    if (!invalid && next) this.restoreEnvironment();
  }

  syncEnvironment() {
    if (this.stopped) return;
    let next;
    let invalid = false;
    try { next = normalizeOrigin(this.readOrigin()); }
    catch { next = undefined; invalid = true; }
    this.applyEnvironment(next, invalid);
  }

  restoreEnvironment() {
    void this.schedule('restoring-environment', undefined, async signal => {
      try { await this.restore(signal); }
      catch (error) { this.recordError(error); }
    }).catch(() => {});
  }

  environmentChanged(value) {
    let next;
    let invalid = false;
    try { next = normalizeOrigin(value); }
    catch { next = undefined; invalid = true; }
    this.applyEnvironment(next, invalid);
  }

  recordError(error) {
    const safe = asOnboardingError(error);
    if (!['CANCELLED', 'ENVIRONMENT_CHANGED'].includes(safe.code)) {
      const details = safeDetails(safe);
      this.error = { code: safe.code, ...(details ? { details } : {}) };
    }
    if (!['CANCELLED', 'ENVIRONMENT_CHANGED', 'PROBE_FAILED', 'INVALID_API_KEY', 'KEY_REQUIRED',
      'ENVIRONMENT_REQUIRED', 'ENVIRONMENT_CHANGED', 'LEGACY_MANAGED', 'INVALID_ORIGIN',
      'REGISTRATION_FAILED', 'INTERNAL_ERROR'].includes(safe.code)) this.log(safe);
  }

  refreshState() {
    this.syncEnvironment();
    try {
      const legacy = this.readLegacy();
      if (legacy && !this.legacyManaged) {
        this.current?.controller.abort();
        this.releaseRegistrations();
      }
      this.legacyManaged = legacy;
    } catch { /* Retain the last safe legacy decision until the next read. */ }
    return this.snapshot();
  }

  snapshot() {
    let views = [];
    try { views = this.mcpManager.list(); }
    catch { views = []; }
    const services = SERVICES.map(service => {
      const view = views.find(item => item?.name === service.name);
      const registered = this.registrations.has(service.name);
      const result = {
        name: service.name,
        registered,
        managedBy: this.legacyManaged ? 'legacy' : registered ? 'plugin' : 'none',
        state: this.legacyManaged && !view?.status ? 'configured'
          : runtimeStates.has(view?.status?.state) ? view.status.state
            : view?.status ? 'unknown' : registered ? 'connecting' : 'disconnected',
        probe: this.probeStates[service.name],
      };
      if (typeof view?.status?.toolCount === 'number') result.toolCount = view.status.toolCount;
      return result;
    });
    const fullyRegistered = SERVICES.every(service => this.registrations.has(service.name));
    const validating = this.operation === 'validating';
    const environmentMismatch = this.boundOrigin !== undefined && this.boundOrigin !== this.origin;
    let phase = 'unconfigured';
    if (this.legacyManaged) phase = 'legacy-managed';
    else if (!this.origin) phase = this.environmentInvalid ? 'error' : 'environment-required';
    else if (validating) phase = 'validating';
    else if (this.error) phase = 'error';
    else if (environmentMismatch) phase = 'environment-changed';
    else if (fullyRegistered && this.boundOrigin === this.origin) phase = 'connected';
    const state = {
      ready: this.ready,
      phase,
      origin: this.origin,
      boundOrigin: this.boundOrigin,
      configured: this.configured === true,
      legacyManaged: this.legacyManaged === true,
      busy: this.operation !== undefined,
      canRetry: this.ready && !this.operation && !!this.origin && this.configured && this.boundOrigin === this.origin && !this.legacyManaged,
      services,
    };
    if (this.error) state.error = { code: this.error.code, ...(this.error.details ? { details: this.error.details } : {}) };
    if (this.warning) state.warning = this.warning;
    return state;
  }

  async dispose() {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.current?.controller.abort();
    this.releaseRegistrations();
    this.stopEnvironment();
    await this.tail;
    try { await this.credentials.unset(STAGING_CREDENTIAL_REF); }
    catch (error) { this.log(error); }
  }
}
