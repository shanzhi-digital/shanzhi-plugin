import { FORMAL_CREDENTIAL_REF, LEGACY_ENTRY_IDS } from './constants.js';
import { OnboardingError } from './errors.js';

/** Only the account plugin's explicit, normalized HTTP(S) origin is accepted. */
export function normalizeOrigin(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    if (typeof value === 'string') return undefined;
    throw new OnboardingError('INVALID_ORIGIN');
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new OnboardingError('INVALID_ORIGIN'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new OnboardingError('INVALID_ORIGIN');
  return url.origin;
}

/** Deliberately does not inspect tokens, legacy MCP URLs, Alpha, or browserOrigin. */
export function readAccountOrigin(account) {
  if (typeof account?.getXiaozhiEnvironment !== 'function') return undefined;
  return normalizeOrigin(account.getXiaozhiEnvironment()?.origin);
}

export function registrationEntry(origin, service, credentialRef = FORMAL_CREDENTIAL_REF) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new OnboardingError('ENVIRONMENT_REQUIRED');
  return {
    transport: 'streamable-http',
    url: new URL(service.path, normalized).href,
    headers: { 'X-API-Key': `\${credential:${credentialRef}}` },
    toolCallTimeoutMs: service.toolCallTimeoutMs,
  };
}

/** probeServer consumes mcp-client Config, not the manager's registration shape. */
export function probeConfig(origin, service, credentialRef) {
  return {
    ...registrationEntry(origin, service, credentialRef),
    serverName: service.name,
    expandTemplates: true,
    failOnStartupError: false,
    closeTimeoutMs: 5_000,
  };
}

export function legacyEntryIds(entries) {
  const ids = new Set(LEGACY_ENTRY_IDS);
  const found = new Set();
  for (const entry of entries ?? []) {
    const id = entry?.options?.id;
    if (ids.has(id)) found.add(id);
  }
  return [...found];
}

/** Settings.update treats undefined as a sparse no-op; replace resets this plugin's volatile field. */
export async function writeBoundOrigin(settings, entryId, value) {
  if (!settings || !entryId) throw new OnboardingError('SETTINGS_UNAVAILABLE');
  await settings.replace(entryId, value === undefined ? {} : { boundOrigin: value });
}
