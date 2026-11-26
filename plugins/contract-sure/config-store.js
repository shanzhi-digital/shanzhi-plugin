import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// 本文件只保存非机密配置：服务器地址、OCR 地址、当前账户和账户的公开信息。
// 令牌和 OCR Key 存在凭据存储里（见 credential-store.js）。
// 配置只存在本地文件里，不读写宿主 settings。

export const DEFAULT_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:8081/api/v1',
  ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr',
});

// 环境变量 DEEPSEEK_API_KEY 只会发给官方 DeepSeek 接口。
export const OFFICIAL_OCR_ORIGIN = 'https://api.deepseek.com';

const ACCOUNT_STATUSES = new Set(['ok', 'expired', 'revoked']);

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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return Number.isNaN(Date.parse(value)) ? '' : value.trim();
}

/** 机密（令牌、OCR Key）只能是可见 ASCII 字符：不能有空格、换行等控制字符，避免写进请求头时出错或回显。 */
export function isHeaderSafeSecret(value) {
  return typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value);
}

/** 地址的 origin；不是合法 URL 时返回空字符串。 */
export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
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
    ocrApiUrl: cleanUrl(src.ocrApiUrl, DEFAULT_CONFIG.ocrApiUrl),
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

/**
 * 写配置文件。旧版本明文 ocrApiKey 还没迁进凭据存储（迁移失败、等下次启动重试）时原样保留，
 * 普通保存不会把这份唯一的副本丢掉；只有 scrubLegacySecrets 能删它。
 */
export function saveConfig(config, options = {}) {
  const filePath = resolveConfigPath(options);
  const normalized = normalizeConfig(config);
  const pendingOcrApiKey = cleanText(readConfigFile(filePath)?.ocrApiKey);
  writePrivateJsonFile(filePath, { version: 2, ...normalized, ...(pendingOcrApiKey ? { ocrApiKey: pendingOcrApiKey } : {}) });
  return normalized;
}

/** 读取旧版本明文保存在配置文件里的机密，以及当时配套的 OCR 地址。 */
export function readLegacySecrets(options = {}) {
  const local = readConfigFile(resolveConfigPath(options)) || {};
  return {
    apiToken: cleanText(local.apiToken),
    ocrApiKey: cleanText(local.ocrApiKey),
    ocrApiUrl: normalizeConfig(local).ocrApiUrl,
  };
}

/**
 * 从配置文件里删掉旧的机密字段。apiToken 一律删掉；
 * keepOcrApiKey 为 true 时保留 ocrApiKey（迁移进凭据存储没成功，下次启动再试）。
 */
export function scrubLegacySecrets(options = {}, { keepOcrApiKey = false } = {}) {
  const filePath = resolveConfigPath(options);
  const local = readConfigFile(filePath) || {};
  const config = normalizeConfig(local);
  const keep = keepOcrApiKey && cleanText(local.ocrApiKey) ? { ocrApiKey: cleanText(local.ocrApiKey) } : {};
  writePrivateJsonFile(filePath, { version: 2, ...config, ...keep });
  return config;
}

export function isOfficialOcrUrl(url) {
  return originOf(url) === OFFICIAL_OCR_ORIGIN;
}

/**
 * OCR 用的 Key：cfg.ocrApiKey 是账户管理器按 OCR 地址的 origin 核对过的凭据；
 * 没有时，只有 OCR 地址是官方 api.deepseek.com 才用环境变量 DEEPSEEK_API_KEY。
 */
export function resolveOcrApiKey(cfg = {}) {
  const fromCredentials = cleanText(cfg?.ocrApiKey);
  if (fromCredentials) return { apiKey: fromCredentials, source: 'credentials' };
  const fromEnv = cleanText(process.env.DEEPSEEK_API_KEY);
  if (fromEnv && isHeaderSafeSecret(fromEnv) && isOfficialOcrUrl(cleanText(cfg?.ocrApiUrl) || DEFAULT_CONFIG.ocrApiUrl)) {
    return { apiKey: fromEnv, source: 'env' };
  }
  return { apiKey: '', source: 'none' };
}

export function maskSecret(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  if (raw.length <= 8) return '*'.repeat(raw.length);
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}
