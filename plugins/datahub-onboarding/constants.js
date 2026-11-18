export const PLUGIN_ID = 'datahub-onboarding';
export const CLIENT_LOCALE = 'datahub.onboarding';
export const ENVIRONMENT_EVENT = 'xiaozhi-account/environment-changed';
export const FORMAL_CREDENTIAL_REF = 'XIAOZHI_DATAHUB_API_KEY';
export const STAGING_CREDENTIAL_REF = 'XIAOZHI_DATAHUB_API_KEY_STAGING';
export const LEGACY_ENTRY_IDS = Object.freeze(['mcp-datahub-ask-data', 'mcp-datahub-knowledge']);

export const SERVICES = Object.freeze([
  Object.freeze({ name: 'datahub-ask-data', path: '/api/mcp/ask-data', toolCallTimeoutMs: 180_000 }),
  Object.freeze({ name: 'datahub-knowledge', path: '/api/mcp/knowledge', toolCallTimeoutMs: 120_000 }),
]);

export const SERVICE_NAMES = Object.freeze(SERVICES.map(service => service.name));
