import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 非机密配置：服务器地址、镜像源、工作区录音目录、多账户公开元数据（不含令牌）。
// 令牌统一存储在 credential-store.js（优先宿主 ~/.dsh/.credentials.yaml）。

export const DEFAULT_SERVER_URL = 'https://58.87.77.127:8443';

export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: DEFAULT_SERVER_URL,
  binaryMirrorUrl: '',
  modelMirrorUrl: '',
  recordingsDir: '',
  lastJoinCode: '',
});

const ACCOUNT_STATUSES = new Set(['ok', 'expired', 'revoked']);

export function resolveConfigPath(options = {}) {
  if (typeof options.configPath === 'string' && options.configPath.trim()) {
    return options.configPath.trim();
  }
  if (typeof process.env.ECHOMIND_CONFIG_PATH === 'string' && process.env.ECHOMIND_CONFIG_PATH.trim()) {
    return process.env.ECHOMIND_CONFIG_PATH.trim();
  }
  return join(homedir(), '.dsh', 'storages', 'echomind', 'config.json');
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanUrl(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/u, '');
  return trimmed || fallback;
}

function cleanIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return Number.isNaN(Date.parse(value)) ? '' : value.trim();
}

export function isHeaderSafeSecret(value) {
  return typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value);
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanText(raw.id);
  const openId = cleanText(raw.openId);
  if (!id || !openId) return null;
  const missingScopes = Array.isArray(raw.missingScopes)
    ? raw.missingScopes.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];
  return {
    id,
    openId,
    name: cleanText(raw.name) || openId,
    enName: cleanText(raw.enName),
    email: cleanText(raw.email),
    companyName: cleanText(raw.companyName),
    joinCode: cleanText(raw.joinCode).toUpperCase(),
    admin: Boolean(raw.admin),
    missingScopes,
    expiresAt: cleanIsoDate(raw.expiresAt),
    addedAt: cleanIsoDate(raw.addedAt),
    status: ACCOUNT_STATUSES.has(raw.status) ? raw.status : 'ok',
  };
}

export function normalizeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const accounts = [];
  for (const item of Array.isArray(src.accounts) ? src.accounts : []) {
    const account = normalizeAccount(item);
    if (account && !accounts.some((existing) => existing.id === account.id)) accounts.push(account);
  }
  const activeAccountId = accounts.some((account) => account.id === src.activeAccountId) ? src.activeAccountId : null;
  return {
    serverUrl: cleanUrl(src.serverUrl, DEFAULT_CONFIG.serverUrl),
    binaryMirrorUrl: cleanUrl(src.binaryMirrorUrl, DEFAULT_CONFIG.binaryMirrorUrl),
    modelMirrorUrl: cleanUrl(src.modelMirrorUrl, DEFAULT_CONFIG.modelMirrorUrl),
    recordingsDir: cleanText(src.recordingsDir),
    lastJoinCode: cleanText(src.lastJoinCode).toUpperCase(),
    activeAccountId,
    accounts,
  };
}

function readConfigFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writePrivateJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows or restricted FS may ignore chmod.
  }
}

export function loadConfig(options = {}) {
  return normalizeConfig(readConfigFile(resolveConfigPath(options)) || {});
}

export function saveConfig(config, options = {}) {
  const filePath = resolveConfigPath(options);
  const normalized = normalizeConfig(config);
  writePrivateJsonFile(filePath, { version: 1, ...normalized });
  return normalized;
}
