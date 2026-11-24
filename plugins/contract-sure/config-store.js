import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const SETTINGS_NAMESPACE = 'contract-sure';

export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:8081/api/v1',
  apiToken: '',
  ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr',
  ocrApiKey: '',
});

const CONFIG_KEYS = Object.freeze(['serverUrl', 'apiToken', 'ocrApiUrl', 'ocrApiKey']);

export function resolveConfigPath(options = {}) {
  if (typeof options.configPath === 'string' && options.configPath.trim()) {
    return options.configPath.trim();
  }
  if (typeof process.env.CONTRACT_SURE_CONFIG_PATH === 'string' && process.env.CONTRACT_SURE_CONFIG_PATH.trim()) {
    return process.env.CONTRACT_SURE_CONFIG_PATH.trim();
  }
  return join(homedir(), '.contract-sure', 'dsh-config.json');
}

function cleanUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/u, '');
  return trimmed || fallback;
}

function cleanSecret(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    serverUrl: cleanUrl(src.serverUrl, DEFAULT_CONFIG.serverUrl),
    apiToken: cleanSecret(src.apiToken),
    ocrApiUrl: cleanUrl(src.ocrApiUrl, DEFAULT_CONFIG.ocrApiUrl),
    ocrApiKey: cleanSecret(src.ocrApiKey),
  };
}

function readLocalFile(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLocalFile(filePath, config) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows or restricted filesystems may ignore chmod.
  }
}

function getSettingsService(ctx) {
  if (!ctx) return null;
  if (typeof ctx.get === 'function') return ctx.get('settings') || null;
  return ctx.settings || null;
}

function readHostSettings(ctx) {
  const settings = getSettingsService(ctx);
  if (!settings) return null;
  try {
    if (typeof settings.get === 'function') {
      const value = settings.get(SETTINGS_NAMESPACE);
      if (value && typeof value === 'object') return value;
    }
    if (typeof settings.getSnapshot === 'function') {
      const snap = settings.getSnapshot(SETTINGS_NAMESPACE);
      const value = snap?.value ?? snap;
      if (value && typeof value === 'object') return value;
    }
  } catch {
    // Host settings may not be initialized yet.
  }
  return null;
}

export function syncToHostSettings(ctx, config) {
  const settings = getSettingsService(ctx);
  if (!settings) return false;
  try {
    if (typeof settings.set === 'function') {
      settings.set(SETTINGS_NAMESPACE, config);
      return true;
    }
    if (typeof settings.mutate === 'function') {
      const ops = CONFIG_KEYS.map((key) => ({ op: 'set', path: [key], value: config[key] }));
      const maybePromise = settings.mutate(SETTINGS_NAMESPACE, ops);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
      return true;
    }
  } catch {
    // Non-fatal: local fallback file already persisted.
  }
  return false;
}

export function loadConfig(options = {}) {
  const filePath = resolveConfigPath(options);
  const local = readLocalFile(filePath);
  const host = options.ctx ? readHostSettings(options.ctx) : null;
  const merged = { ...DEFAULT_CONFIG };
  if (host) {
    for (const key of CONFIG_KEYS) {
      if (host[key] !== undefined && host[key] !== null) merged[key] = host[key];
    }
  }
  if (local) {
    for (const key of CONFIG_KEYS) {
      if (local[key] !== undefined && local[key] !== null) merged[key] = local[key];
    }
  }
  return normalizeConfig(merged);
}

export function saveConfig(patch = {}, options = {}) {
  const filePath = resolveConfigPath(options);
  const current = loadConfig(options);
  const next = { ...current };
  if (patch && typeof patch === 'object') {
    for (const key of CONFIG_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined && patch[key] !== null) {
        next[key] = patch[key];
      }
    }
  }
  const normalized = normalizeConfig(next);
  writeLocalFile(filePath, normalized);
  if (options.ctx && options.syncHost !== false) {
    syncToHostSettings(options.ctx, normalized);
  }
  return normalized;
}

export function resolveOcrApiKey(cfg = {}) {
  const fromConfig = cleanSecret(cfg?.ocrApiKey);
  if (fromConfig) return { apiKey: fromConfig, source: 'config' };
  const fromEnv = cleanSecret(process.env.DEEPSEEK_API_KEY);
  if (fromEnv) return { apiKey: fromEnv, source: 'env' };
  return { apiKey: '', source: 'none' };
}

export function maskSecret(value) {
  const raw = cleanSecret(value);
  if (!raw) return '';
  if (raw.length <= 8) return '*'.repeat(raw.length);
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

export function maskConfig(cfg, options = {}) {
  const normalized = normalizeConfig(cfg);
  const ocrKey = resolveOcrApiKey(normalized);
  return {
    serverUrl: normalized.serverUrl,
    apiTokenConfigured: normalized.apiToken.length > 0,
    apiTokenMasked: maskSecret(normalized.apiToken),
    ocrApiUrl: normalized.ocrApiUrl,
    ocrApiKeyConfigured: ocrKey.apiKey.length > 0,
    ocrApiKeySource: ocrKey.source,
    ocrApiKeyMasked: maskSecret(ocrKey.apiKey),
    configPath: resolveConfigPath(options),
  };
}

export const SETTINGS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    serverUrl: {
      type: 'string',
      title: '后端接口地址',
      default: DEFAULT_CONFIG.serverUrl,
    },
    apiToken: {
      type: 'string',
      title: '长期访问令牌',
      default: DEFAULT_CONFIG.apiToken,
    },
    ocrApiUrl: {
      type: 'string',
      title: 'DeepSeek OCR 地址',
      default: DEFAULT_CONFIG.ocrApiUrl,
    },
    ocrApiKey: {
      type: 'string',
      title: 'DeepSeek OCR API Key',
      default: DEFAULT_CONFIG.ocrApiKey,
    },
  },
});

/**
 * Register namespace "contract-sure" with DSH host settings when available,
 * keeping host settings and ~/.contract-sure/dsh-config.json synchronized.
 */
export function registerSettingsSync(ctx, options = {}) {
  const disposers = [];
  const filePath = resolveConfigPath(options);
  const settings = getSettingsService(ctx);
  if (!settings || typeof settings.register !== 'function') {
    return () => {};
  }

  const initial = loadConfig({ configPath: filePath });
  const handleChange = (nextValue) => {
    if (!nextValue || typeof nextValue !== 'object') return;
    try {
      const normalized = normalizeConfig({ ...loadConfig({ configPath: filePath }), ...nextValue });
      writeLocalFile(filePath, normalized);
    } catch {
      // Never crash host event dispatch on disk errors.
    }
  };

  try {
    const registration = settings.register({
      namespace: SETTINGS_NAMESPACE,
      defaults: initial,
      schema: SETTINGS_SCHEMA,
      onChange: handleChange,
    });
    if (typeof registration === 'function') {
      disposers.push(registration);
    } else if (registration && typeof registration.dispose === 'function') {
      disposers.push(() => registration.dispose());
    }
  } catch {
    try {
      const registration = settings.register(SETTINGS_NAMESPACE, {
        defaults: initial,
        schema: SETTINGS_SCHEMA,
        onChange: handleChange,
      });
      if (typeof registration === 'function') {
        disposers.push(registration);
      } else if (registration && typeof registration.dispose === 'function') {
        disposers.push(() => registration.dispose());
      }
    } catch {
      // Host settings schema contract differs; local store remains authoritative.
    }
  }

  if (typeof settings.subscribe === 'function') {
    try {
      const unsub = settings.subscribe(SETTINGS_NAMESPACE, (snap) => {
        handleChange(snap?.value ?? snap);
      });
      if (typeof unsub === 'function') disposers.push(unsub);
    } catch {
      // Optional listener.
    }
  }

  if (typeof ctx?.on === 'function') {
    try {
      const off = ctx.on('settings/change', (event) => {
        if (event?.namespace === SETTINGS_NAMESPACE) {
          handleChange(event.value ?? event.next);
        }
      });
      if (typeof off === 'function') disposers.push(off);
    } catch {
      // Optional event.
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Ignore cleanup errors.
      }
    }
  };
}
