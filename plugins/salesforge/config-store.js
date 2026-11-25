import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 本文件只保存非机密配置：服务器地址、当前账户和账户的公开信息（姓名、部门等）。
// 令牌存在凭据存储里（见 credential-store.js）。配置只存在本地文件里，不读写宿主 settings。

export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: 'http://132.232.203.59:7001/api/v1',
});

const ACCOUNT_STATUSES = new Set(['ok', 'expired', 'revoked']);

export function resolveConfigPath(options = {}) {
  if (typeof options.configPath === 'string' && options.configPath.trim()) {
    return options.configPath.trim();
  }
  if (typeof process.env.SALESFORGE_CONFIG_PATH === 'string' && process.env.SALESFORGE_CONFIG_PATH.trim()) {
    return process.env.SALESFORGE_CONFIG_PATH.trim();
  }
  return join(homedir(), '.salesforge', 'dsh-config.json');
}

function cleanUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/u, '');
  return trimmed || fallback;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return Number.isNaN(Date.parse(value)) ? '' : value.trim();
}

/** 令牌只能是可见 ASCII 字符：不能有空格、换行等控制字符，避免写进请求头时出错或回显。 */
export function isHeaderSafeSecret(value) {
  return typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value);
}

export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = Number(raw.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return {
    id: `u${userId}`,
    userId,
    username: cleanText(raw.username),
    realName: cleanText(raw.realName),
    deptName: cleanText(raw.deptName),
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
    // Windows 或受限文件系统可能不支持 chmod。
  }
}

export function loadConfig(options = {}) {
  return normalizeConfig(readConfigFile(resolveConfigPath(options)) || {});
}

export function saveConfig(config, options = {}) {
  const normalized = normalizeConfig(config);
  writePrivateJsonFile(resolveConfigPath(options), { version: 1, ...normalized });
  return normalized;
}
