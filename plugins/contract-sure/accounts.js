import { hostname } from 'node:os';
import { ApiError, defaultApiClient, normalizeHttpUrl, normalizeServerUrl, safeErrorMessage } from './api-client.js';
import {
  DEFAULT_CONFIG,
  OFFICIAL_OCR_ORIGIN,
  isHeaderSafeSecret,
  loadConfig,
  maskSecret,
  originOf,
  readLegacySecrets,
  resolveConfigPath,
  resolveOcrApiKey,
  saveConfig,
  scrubLegacySecrets,
} from './config-store.js';
import { createCredentialStore, credentialsFilePath } from './credential-store.js';

// 履约系统账户管理与浏览器授权（宿主侧）。
// - 接口约定 A：调用后端 A1 发起授权、A5 轮询结果、A8 吊销令牌、A9 /auth/me。
// - 接口约定 B：getState / saveSettings / testConnection / startAuthorization / pollAuthorization /
//   cancelAuthorization / setActiveAccount / disconnectAccount 的实现都在这里，preview-service.js 负责暴露成 RPC。
// - 接口约定 C：没有账户或后端返回 401 时，工具返回 kind 为 contract-sure-auth-required 的对象。
// 令牌、grantId、pollSecret、OCR Key 只在宿主内存和凭据存储里，State 和工具输出都不含明文。
// 报错和日志只用固定文案，不回显底层异常、请求头或后端返回的原文。

export const AUTH_REQUIRED_KIND = 'contract-sure-auth-required';
export const CLIENT_NAME = '小智办公 · 履约无忧';
export const NOT_UPGRADED_MESSAGE = '履约系统还没升级到支持插件授权的版本，请联系管理员';

const OCR_KEY_RECORD_ID = 'ocr-api-key';
const OCR_KEY_PAYLOAD_TYPE = 'ocr-api-key';
const MAX_ACTIVE_AUTHORIZATIONS = 3;
const MAX_TRACKED_AUTHORIZATIONS = 10;
// 轮询失败时的最长退避间隔。
const MAX_POLL_BACKOFF_MS = 30_000;
const POLL_REQUEST_TIMEOUT_MS = 10_000;
const REVOKE_TIMEOUT_MS = 10_000;
// 测试连接时探测 A5 用的占位值：服务器上不存在这个授权请求，只会回「授权请求不存在」。
const PROBE_REQUEST_ID = 'contract-sure-connection-test';
const PROBE_POLL_SECRET = 'contract-sure-connection-test-not-a-real-poll-secret';
const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const DEFAULT_AUTHORIZATION_TTL_SECONDS = 600;
const SETTINGS_PATCH_KEYS = new Set(['serverUrl', 'ocrApiUrl', 'ocrApiKey', 'disconnectAccounts']);
const SERVER_CHANGED_MESSAGE = '服务器地址已经变更，这次授权作废，请重新连接账户。';

const accountRecordId = (userId) => `account-${userId}`;

export class AuthRequiredError extends Error {
  constructor(reason, account = null) {
    super(reason);
    this.name = 'AuthRequiredError';
    this.reason = reason;
    this.account = account;
  }
}

export function authRequiredOutput(reason, serverUrl, account = null) {
  const who = account ? `「${account.realName || account.username || account.id}」` : '';
  let message = '需要先连接履约系统账户：请点下方卡片的「连接账户」，在浏览器里完成授权后，回复「继续」。';
  if (reason === 'expired') {
    message = `履约系统账户${who}的授权已过期：请点下方卡片的「连接账户」，在浏览器里重新授权后，回复「继续」。`;
  } else if (reason === 'revoked') {
    message = `履约系统账户${who}的授权已失效（可能已被吊销）：请点下方卡片的「连接账户」，在浏览器里重新授权后，回复「继续」。`;
  }
  return { kind: AUTH_REQUIRED_KIND, reason, serverUrl, message };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, num));
}

const isUnauthorizedError = (error) => error instanceof ApiError && error.code === 'UNAUTHORIZED';

// IPv6 地址里映射或兼容的 IPv4（::ffff:7f00:1、::7f00:1、::ffff:127.0.0.1）取出第一段。
function embeddedIpv4FirstOctet(host) {
  const dotted = /^::(?:ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.exec(host);
  if (dotted) return Number(dotted[1]);
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(host);
  if (hex) return Number.parseInt(hex[1], 16) >> 8;
  return null;
}

// 本机地址：localhost、*.localhost（含结尾的点）、127.0.0.0/8、0.0.0.0、::1、::，以及映射到本机的 IPv6 地址。
export function isLoopbackHost(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.+$/u, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127(?:\.\d{1,3}){3}$/u.test(host) || host === '0.0.0.0') return true;
  if (host === '::1' || host === '::') return true;
  const octet = embeddedIpv4FirstOctet(host);
  return octet === 127 || octet === 0;
}

// 确认页地址：优先用后端 A1 给的 verifyUrl。
// 后端 verifyUrl 取自 SSO_FRONTEND_URL，没配置时默认是 http://localhost:3001；
// 所以它指向本机、而履约服务器本身不在本机时不采用，改用 serverUrl 的 origin + verifyPath。
// 回退地址解析之后必须仍是 serverUrl 的 origin（防止 //host、反斜杠之类的路径被解析成别的主机）。
function resolveVerifyUrl(serverUrl, data) {
  const server = new URL(serverUrl);
  if (typeof data.verifyUrl === 'string' && data.verifyUrl.trim()) {
    try {
      const parsed = new URL(data.verifyUrl.trim());
      const usable =
        ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        (!isLoopbackHost(parsed.hostname) || isLoopbackHost(server.hostname));
      if (usable) return parsed.href;
    } catch {
      // 落到下面用服务器地址拼。
    }
  }
  const defaultPath = `/plugin-authorize?req=${encodeURIComponent(data.requestId)}`;
  const candidates = typeof data.verifyPath === 'string' && data.verifyPath.startsWith('/') ? [data.verifyPath, defaultPath] : [defaultPath];
  for (const path of candidates) {
    try {
      const resolved = new URL(path, server.origin);
      if (resolved.origin === server.origin) return resolved.href;
    } catch {
      // 换下一个候选。
    }
  }
  return `${server.origin}${defaultPath}`;
}

function grantPayloadOf(record) {
  if (record?.kind !== 'grant' || !isPlainObject(record.payload)) return null;
  if (record.payload.type === OCR_KEY_PAYLOAD_TYPE) return null;
  return typeof record.payload.token === 'string' && record.payload.token ? record.payload : null;
}

function cleanGrantId(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 128);
  return null;
}

function warn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message);
  } catch {
    // 拿不到 logger 时静默。
  }
}

/**
 * @param ctx 插件 Context；只通过 ctx.get('credentials') 读取可选服务。
 * @param deps.configPath 非机密配置文件路径；凭据文件（退回模式）放在同目录 credentials.json。
 * @param deps.apiClient、deps.fetchImpl 用于测试注入。
 * @param deps.schedule / deps.cancelSchedule 后台轮询用的定时器，默认 setTimeout / clearTimeout。
 */
export function createAccountManager(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const fetchImpl = deps.fetchImpl;
  const configOptions = { configPath: deps.configPath };
  const store =
    deps.credentialStore ||
    createCredentialStore(ctx, { filePath: credentialsFilePath(resolveConfigPath(configOptions)) });
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancelSchedule = deps.cancelSchedule || ((handle) => clearTimeout(handle));
  const deviceName = String((deps.hostname || hostname)() || '').trim().slice(0, 64);
  const authorizations = new Map();
  let disposed = false;
  // 换服务器或卸载插件时加一：之前发起、还没回来的授权一律作废。
  let epoch = 0;
  // 已经发出、还没收到响应的 A1 请求数，也占同时进行的授权名额。
  let startsInFlight = 0;

  const requestOptions = (extra = {}) => ({ ...(fetchImpl ? { fetchImpl } : {}), ...extra });

  // 改配置文件和凭据的操作排队执行，避免后台轮询与界面操作交错写坏数据。
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const readConfig = () => loadConfig(configOptions);
  const writeConfig = (config) => saveConfig(config, configOptions);
  const isExpired = (account) => Boolean(account.expiresAt) && Date.parse(account.expiresAt) <= now();
  const effectiveStatus = (account) => (account.status === 'ok' && isExpired(account) ? 'expired' : account.status);
  const publicAccount = (account) => ({
    id: account.id,
    userId: account.userId,
    username: account.username,
    realName: account.realName,
    deptName: account.deptName,
    expiresAt: account.expiresAt,
    addedAt: account.addedAt,
    status: effectiveStatus(account),
  });

  // ---------- 凭据 ----------

  /** 账户的授权记录；没有时返回 null，读取失败时抛错（不当成没有）。 */
  async function readGrant(userId) {
    return grantPayloadOf(await store.read(accountRecordId(userId)));
  }

  /** OCR Key 记录：{ key, origin }，Key 只用于这个 origin。 */
  async function readOcrKeyRecord() {
    const record = await store.read(OCR_KEY_RECORD_ID);
    if (record?.kind === 'grant' && isPlainObject(record.payload) && record.payload.type === OCR_KEY_PAYLOAD_TYPE) {
      const key = cleanText(record.payload.key);
      const origin = cleanText(record.payload.origin);
      return key && origin ? { key, origin } : null;
    }
    // 早先开发版本写的 api-key 记录没有记 origin：只当作官方 DeepSeek 接口的 Key。
    if (record?.kind === 'api-key' && cleanText(record.key)) return { key: cleanText(record.key), origin: OFFICIAL_OCR_ORIGIN };
    return null;
  }

  async function writeOcrKey(key, origin) {
    await store.write(OCR_KEY_RECORD_ID, { kind: 'grant', payload: { version: 1, type: OCR_KEY_PAYLOAD_TYPE, key, origin } });
  }

  /** 当前 OCR 地址可用的 Key 和来源（credentials / env / none）。 */
  async function ocrKeyFor(ocrApiUrl) {
    const record = await readOcrKeyRecord();
    const origin = originOf(ocrApiUrl);
    const boundKey = record && origin && record.origin === origin ? record.key : '';
    const { apiKey, source } = resolveOcrApiKey({ ocrApiKey: boundKey, ocrApiUrl });
    return { boundKey, apiKey, source };
  }

  /** 吊销令牌。服务端确认吊销（或令牌本来就已失效）时返回 true。 */
  async function revokeToken(serverUrl, token) {
    if (!serverUrl || !token) return false;
    try {
      await apiClient.revokePluginToken({ serverUrl, apiToken: token }, requestOptions({ timeoutMs: REVOKE_TIMEOUT_MS }));
      return true;
    } catch (error) {
      return isUnauthorizedError(error);
    }
  }

  /** 尽力吊销并删除本地凭据。凭据读取失败时抛错，不删记录（留着下次还能吊销）。返回服务端是否确认吊销。 */
  async function revokeAndForget(serverUrl, userId) {
    const payload = await readGrant(userId);
    const revoked = payload ? await revokeToken(payload.serverUrl || serverUrl, payload.token) : false;
    await store.remove(accountRecordId(userId));
    return revoked;
  }

  // 旧版本把 apiToken、ocrApiKey 明文写在配置文件里：
  // 旧令牌没有 jti，后端会一律 401，直接丢弃；OCR Key 迁进凭据存储，写入并回读核对成功后才从配置文件删掉。
  async function migrateLegacySecrets() {
    const legacy = readLegacySecrets(configOptions);
    if (!legacy.apiToken && !legacy.ocrApiKey) return;
    let keepOcrApiKey = false;
    if (legacy.ocrApiKey && !isHeaderSafeSecret(legacy.ocrApiKey)) {
      warn(ctx, '@local/contract-sure: 旧配置里的 OCR Key 含有空格或控制字符，无法使用，已丢弃，请在设置里重新填写。');
    } else if (legacy.ocrApiKey) {
      try {
        if (!(await readOcrKeyRecord())) {
          const origin = originOf(legacy.ocrApiUrl) || OFFICIAL_OCR_ORIGIN;
          await writeOcrKey(legacy.ocrApiKey, origin);
          const check = await readOcrKeyRecord();
          if (check?.key !== legacy.ocrApiKey || check.origin !== origin) throw new Error('verify');
        }
      } catch {
        keepOcrApiKey = true;
        warn(ctx, '@local/contract-sure: OCR Key 迁移到凭据存储失败，旧值暂时保留在配置文件里，下次启动重试。');
      }
    }
    scrubLegacySecrets(configOptions, { keepOcrApiKey });
  }

  const ready = serialize(migrateLegacySecrets).catch(() => {
    warn(ctx, '@local/contract-sure: 旧配置迁移失败，下次启动重试。');
  });

  /**
   * 更新账户状态，但只在凭据里仍是 observedToken 这份授权时才改：
   * 同一用户已经重新授权后，旧令牌迟到的 401 不会把新授权标成失效。observedToken 为 null 表示「当时没有可用凭据」。
   */
  function markStatus(accountId, status, observedToken) {
    return serialize(async () => {
      const config = readConfig();
      const account = config.accounts.find((item) => item.id === accountId);
      if (!account || account.status === status) return;
      let payload;
      try {
        payload = await readGrant(account.userId);
      } catch {
        return;
      }
      if ((payload?.token ?? null) !== (observedToken ?? null)) return;
      account.status = status;
      writeConfig(config);
    });
  }

  async function markUnauthorized(cfg) {
    const account = readConfig().accounts.find((item) => item.id === cfg.accountId) || null;
    const reason = account && isExpired(account) ? 'expired' : 'revoked';
    await markStatus(cfg.accountId, reason, cfg.apiToken);
    return authRequiredOutput(reason, cfg.serverUrl, account);
  }

  async function buildState() {
    const config = readConfig();
    const ocr = await ocrKeyFor(config.ocrApiUrl);
    return {
      serverUrl: config.serverUrl,
      activeAccountId: config.activeAccountId,
      accounts: config.accounts.map(publicAccount),
      ocr: {
        apiUrl: config.ocrApiUrl,
        keyConfigured: ocr.source !== 'none',
        keyMasked: ocr.source === 'credentials' ? maskSecret(ocr.apiKey) : '',
        keySource: ocr.source,
      },
      credentialStore: store.kind(),
    };
  }

  /** 工具本地处理时用到的配置（不需要后端令牌），例如图片 OCR。 */
  async function localConfig() {
    await ready;
    const config = readConfig();
    const ocr = await ocrKeyFor(config.ocrApiUrl);
    return { serverUrl: config.serverUrl, apiToken: '', ocrApiUrl: config.ocrApiUrl, ocrApiKey: ocr.boundKey };
  }

  /** 取当前账户的后端调用配置；没有账户、已标记失效或令牌不可用时抛 AuthRequiredError。 */
  async function requireBackend() {
    await ready;
    const config = readConfig();
    const account = config.accounts.find((item) => item.id === config.activeAccountId);
    if (!account) throw new AuthRequiredError('no-account');
    const payload = await readGrant(account.userId);
    const token = payload?.token ?? null;
    if (account.status === 'expired' || isExpired(account)) {
      if (account.status !== 'expired') await markStatus(account.id, 'expired', token);
      throw new AuthRequiredError('expired', account);
    }
    // 已确认失效的授权不再拿去请求后端，重新授权才恢复。
    if (account.status === 'revoked') throw new AuthRequiredError('revoked', account);
    // 令牌丢了，或者是另一个服务器签发的：都不能再用。
    if (!payload || payload.serverUrl !== config.serverUrl) {
      await markStatus(account.id, 'revoked', token);
      throw new AuthRequiredError('revoked', account);
    }
    const ocr = await ocrKeyFor(config.ocrApiUrl);
    return {
      serverUrl: config.serverUrl,
      apiToken: payload.token,
      ocrApiUrl: config.ocrApiUrl,
      ocrApiKey: ocr.boundKey,
      accountId: account.id,
    };
  }

  /** 只检查账户，不请求后端：{ ok: true, cfg } 或 { ok: false, authRequired }。 */
  async function resolveBackend() {
    try {
      return { ok: true, cfg: await requireBackend() };
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        return { ok: false, authRequired: authRequiredOutput(error.reason, readConfig().serverUrl, error.account) };
      }
      throw error;
    }
  }

  /**
   * 用 resolveBackend 取到的 cfg 调后端。fn(cfg, backend)：
   * 子请求（例如合同创建后的原件归档）收到 401 时调 backend.reportUnauthorized()，账户照样会被标记。
   * 返回 { ok: true, value } 或 { ok: false, authRequired }（约定 C 的对象）。其他错误照常抛出。
   */
  async function runBackend(cfg, fn) {
    let reported = null;
    const backend = {
      async reportUnauthorized() {
        if (!reported) reported = await markUnauthorized(cfg);
        return reported;
      },
    };
    try {
      return { ok: true, value: await fn(cfg, backend) };
    } catch (error) {
      if (isUnauthorizedError(error)) return { ok: false, authRequired: reported || (await markUnauthorized(cfg)) };
      throw error;
    }
  }

  /** 用当前账户调用后端：resolveBackend + runBackend。 */
  async function withBackend(fn) {
    const resolved = await resolveBackend();
    if (!resolved.ok) return resolved;
    return runBackend(resolved.cfg, fn);
  }

  /** contract_config(get) 用的连接概况，不含任何机密。 */
  async function describeConnection() {
    await ready;
    const config = readConfig();
    const active = config.accounts.find((item) => item.id === config.activeAccountId) || null;
    const status = active ? effectiveStatus(active) : null;
    return {
      serverUrl: config.serverUrl,
      connected: Boolean(active && status === 'ok'),
      account: active ? { realName: active.realName, username: active.username, status } : null,
      accountCount: config.accounts.length,
    };
  }

  // ---------- 浏览器授权：后台轮询 ----------
  // 条目状态：pending（轮询中）→ committing（收到 APPROVED，正在保存）→ approved / denied / expired / error。
  // approved 结果第一次被 pollAuthorization 读走后删除条目，之后同一 requestId 按过期处理。

  const isActive = (entry) => entry.status === 'pending' || entry.status === 'committing';

  function stopPolling(entry) {
    if (entry.timer !== null) cancelSchedule(entry.timer);
    entry.timer = null;
    entry.controller?.abort();
    entry.controller = null;
    entry.pollSecret = null;
  }

  function settle(entry, result) {
    stopPolling(entry);
    entry.status = result.status;
    entry.result = result;
    entry.settledAt = now();
    if (authorizations.size > MAX_TRACKED_AUTHORIZATIONS) {
      const finished = [...authorizations.values()].filter((item) => !isActive(item));
      finished.sort((a, b) => a.settledAt - b.settledAt);
      for (const item of finished.slice(0, authorizations.size - MAX_TRACKED_AUTHORIZATIONS)) {
        item.committed = null;
        authorizations.delete(item.requestId);
      }
    }
  }

  // 连续失败时按 interval 指数退避（最长 30 秒），但不晚于请求过期时间，过期后由 pollOnce 判定终态。
  function retryDelay(entry) {
    const backoff = Math.min(entry.intervalMs * 2 ** Math.min(entry.failures, 6), MAX_POLL_BACKOFF_MS);
    return Math.max(0, Math.min(Math.max(backoff, entry.intervalMs), entry.expiresAt - now()));
  }

  function schedulePoll(entry, delayMs) {
    if (disposed || entry.status !== 'pending') return;
    entry.timer = schedule(() => {
      entry.timer = null;
      void pollOnce(entry);
    }, delayMs);
    entry.timer?.unref?.();
  }

  // 在队列里执行：保存新授权。凭据写入后配置写失败时，把旧凭据放回去，旧令牌也不会丢。
  async function storeApprovedAccount(serverUrl, data) {
    const token = cleanText(data?.token);
    const user = isPlainObject(data?.user) ? data.user : {};
    const userId = Number(user.userId);
    if (!token || !isHeaderSafeSecret(token) || !Number.isSafeInteger(userId) || userId <= 0) {
      throw new ApiError('履约系统返回的授权结果不完整。', { code: 'INVALID_RESPONSE' });
    }
    const config = readConfig();
    if (config.serverUrl !== serverUrl) throw new ApiError(SERVER_CHANGED_MESSAGE, { code: 'SERVER_CHANGED' });
    const expiresAt = typeof data.expiresAt === 'string' && !Number.isNaN(Date.parse(data.expiresAt)) ? data.expiresAt : '';
    const recordId = accountRecordId(userId);
    const previous = await readGrant(userId);
    await store.write(recordId, {
      kind: 'grant',
      payload: { version: 1, token, grantId: cleanGrantId(data.grantId), expiresAt, serverUrl, userId },
    });
    const account = {
      id: `u${userId}`,
      userId,
      username: cleanText(user.username),
      realName: cleanText(user.realName),
      deptName: cleanText(user.deptName),
      expiresAt,
      addedAt: new Date(now()).toISOString(),
      status: 'ok',
    };
    try {
      const index = config.accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) config.accounts[index] = account;
      else config.accounts.push(account);
      config.activeAccountId = account.id;
      writeConfig(config);
    } catch (error) {
      try {
        if (previous) await store.write(recordId, { kind: 'grant', payload: previous });
        else await store.remove(recordId);
      } catch {
        // 放不回去也只能这样：新令牌会被外层吊销。
      }
      throw error;
    }
    const replacedToken = previous && previous.token !== token ? previous : null;
    return { account, replacedToken };
  }

  // 在队列里执行：撤销一次已经保存的授权（用户在保存之后才点了取消）。只删仍是这份令牌的凭据。
  async function undoApproval(entry) {
    const committed = entry.committed;
    entry.committed = null;
    if (!committed) return;
    let ours = false;
    try {
      ours = (await readGrant(committed.userId))?.token === committed.token;
    } catch {
      ours = false;
    }
    if (ours) {
      await store.remove(accountRecordId(committed.userId));
      const config = readConfig();
      config.accounts = config.accounts.filter((item) => item.id !== committed.accountId);
      if (config.activeAccountId === committed.accountId) config.activeAccountId = config.accounts[0]?.id ?? null;
      writeConfig(config);
    }
    await revokeToken(entry.serverUrl, committed.token);
  }

  // 在队列里执行：复核请求仍有效后提交 APPROVED。
  async function commitApproval(entry, data) {
    const token = cleanText(data?.token);
    const abandon = (result) => {
      if (token) void revokeToken(entry.serverUrl, token);
      settle(entry, result);
    };
    if (entry.cancelRequested || disposed) {
      abandon({ status: 'cancelled' });
      authorizations.delete(entry.requestId);
      return;
    }
    if (now() >= entry.expiresAt) {
      abandon({ status: 'expired' });
      return;
    }
    if (entry.epoch !== epoch || readConfig().serverUrl !== entry.serverUrl) {
      abandon({ status: 'error', message: SERVER_CHANGED_MESSAGE });
      return;
    }
    let stored;
    try {
      stored = await storeApprovedAccount(entry.serverUrl, data);
    } catch (error) {
      const message = error?.code === 'SERVER_CHANGED' ? SERVER_CHANGED_MESSAGE : '保存授权结果失败，请重新连接账户。';
      abandon({ status: 'error', message });
      return;
    }
    entry.committed = { accountId: stored.account.id, userId: stored.account.userId, token };
    settle(entry, { status: 'approved', account: publicAccount(stored.account) });
    if (stored.replacedToken) void revokeToken(stored.replacedToken.serverUrl || entry.serverUrl, stored.replacedToken.token);
    if (entry.cancelRequested) {
      authorizations.delete(entry.requestId);
      await undoApproval(entry);
    }
  }

  async function pollOnce(entry) {
    if (disposed || entry.status !== 'pending') return;
    if (now() >= entry.expiresAt) {
      settle(entry, { status: 'expired' });
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    let data;
    try {
      data = await apiClient.pollPluginAuthorization(
        { serverUrl: entry.serverUrl },
        { requestId: entry.requestId, pollSecret: entry.pollSecret },
        requestOptions({ signal: controller.signal, timeoutMs: POLL_REQUEST_TIMEOUT_MS }),
      );
    } catch (error) {
      if (entry.controller === controller) entry.controller = null;
      if (entry.status !== 'pending') return;
      if (error?.businessCode === 404 || error?.status === 404) {
        settle(entry, { status: 'expired' });
        return;
      }
      // 5xx、限流、网络错误等都不是终态：后端可能已经批准、只是这次没取到结果（例如查部门时数据库出错，
      // 请求仍保持 APPROVED），过期前退避重试。界面这期间一直看到 pending，看不到底层错误。
      entry.failures += 1;
      schedulePoll(entry, retryDelay(entry));
      return;
    }
    if (entry.controller === controller) entry.controller = null;
    const status = String(data?.status || '').toUpperCase();

    if (entry.status !== 'pending') {
      // 轮询途中被取消或已过期，但后端已经签发了令牌：吊销掉，不留孤儿授权。
      if (status === 'APPROVED') void revokeToken(entry.serverUrl, cleanText(data?.token));
      return;
    }
    if (status === 'PENDING') {
      entry.failures = 0;
      schedulePoll(entry, entry.intervalMs);
      return;
    }
    if (status === 'APPROVED') {
      entry.status = 'committing';
      entry.pollSecret = null;
      entry.commitDone = serialize(() => commitApproval(entry, data)).catch(() => {
        if (entry.status === 'committing') settle(entry, { status: 'error', message: '保存授权结果失败，请重新连接账户。' });
      });
      await entry.commitDone;
      return;
    }
    if (status === 'DENIED') {
      settle(entry, { status: 'denied' });
      return;
    }
    if (status === 'EXPIRED') {
      settle(entry, { status: 'expired' });
      return;
    }
    if (status === 'CONSUMED') {
      settle(entry, { status: 'error', message: '这次授权的结果已被领取过，请重新连接账户。' });
      return;
    }
    // 无法识别的状态也不算终态：只有 DENIED、EXPIRED、CONSUMED、code 404 和本地过期才结束。
    entry.failures += 1;
    schedulePoll(entry, retryDelay(entry));
  }

  // 换服务器或卸载插件：停掉进行中的轮询；正在保存的授权由 commitApproval 按 epoch / disposed 自行作废。
  function cancelAllAuthorizations() {
    for (const entry of [...authorizations.values()]) {
      if (entry.status === 'committing') continue;
      stopPolling(entry);
      if (entry.status === 'pending') entry.status = 'cancelled';
      entry.committed = null;
      authorizations.delete(entry.requestId);
    }
  }

  // 同时进行的授权只保留 keep 个，超出时让最早的作废。
  function evictOldestPending(keep) {
    const pending = [...authorizations.values()].filter((item) => item.status === 'pending');
    pending.sort((a, b) => a.createdAt - b.createdAt);
    for (const item of pending.slice(0, Math.max(0, pending.length - Math.max(0, keep)))) {
      settle(item, { status: 'error', message: '同时进行的授权请求过多，较早的请求已取消，请使用最新的授权链接。' });
    }
  }

  // ---------- 约定 B 的 RPC 实现 ----------

  async function getState() {
    await ready;
    return buildState();
  }

  async function saveSettings(patch) {
    if (!isPlainObject(patch)) {
      throw new ApiError('设置参数格式无效。', { code: 'INVALID_REQUEST' });
    }
    if (Object.keys(patch).some((key) => !SETTINGS_PATCH_KEYS.has(key))) {
      throw new ApiError('设置里有不支持的字段：只能修改服务器地址、OCR 地址和 OCR Key。', { code: 'INVALID_REQUEST' });
    }
    if (patch.disconnectAccounts != null && typeof patch.disconnectAccounts !== 'boolean') {
      throw new ApiError('disconnectAccounts 必须是 true 或 false。', { code: 'INVALID_REQUEST' });
    }
    let nextServerUrl = null;
    if (patch.serverUrl != null) {
      if (typeof patch.serverUrl !== 'string') throw new ApiError('服务器地址必须是字符串。', { code: 'INVALID_REQUEST' });
      nextServerUrl = normalizeServerUrl(patch.serverUrl);
    }
    let nextOcrApiUrl = null;
    if (patch.ocrApiUrl != null) {
      if (typeof patch.ocrApiUrl !== 'string') throw new ApiError('OCR 地址必须是字符串。', { code: 'INVALID_REQUEST' });
      nextOcrApiUrl = patch.ocrApiUrl.trim() ? normalizeHttpUrl(patch.ocrApiUrl, 'OCR 地址') : DEFAULT_CONFIG.ocrApiUrl;
    }
    let nextOcrKey = null;
    if (patch.ocrApiKey != null) {
      if (typeof patch.ocrApiKey !== 'string') throw new ApiError('OCR Key 必须是字符串。', { code: 'INVALID_REQUEST' });
      nextOcrKey = patch.ocrApiKey.trim();
      if (nextOcrKey && !isHeaderSafeSecret(nextOcrKey)) {
        throw new ApiError('OCR Key 只能包含英文字母、数字和符号，不能有空格、换行等控制字符。', { code: 'INVALID_SECRET' });
      }
    }
    await ready;
    return serialize(async () => {
      const config = readConfig();
      const serverUrl = nextServerUrl ?? config.serverUrl;
      const ocrApiUrl = nextOcrApiUrl ?? config.ocrApiUrl;
      const serverChanged = serverUrl !== config.serverUrl;
      if (serverChanged && config.accounts.length > 0 && patch.disconnectAccounts !== true) {
        throw new ApiError('更换服务器地址前需要先断开全部账户', { code: 'ACCOUNTS_CONNECTED' });
      }

      if (serverChanged) {
        // 进行中的授权属于旧服务器，一并作废；旧账户在旧服务器上尽力吊销。
        epoch += 1;
        cancelAllAuthorizations();
        for (const account of [...config.accounts]) {
          await revokeAndForget(config.serverUrl, account.userId);
          config.accounts = config.accounts.filter((item) => item.id !== account.id);
        }
        config.activeAccountId = null;
      }

      // OCR Key 只发给保存它时的 OCR 地址 origin：换了 origin 又没给新 Key，就把旧 Key 删掉。
      const ocrOrigin = originOf(ocrApiUrl);
      if (nextOcrKey !== null) {
        if (nextOcrKey) await writeOcrKey(nextOcrKey, ocrOrigin);
        else await store.remove(OCR_KEY_RECORD_ID);
      } else if (ocrApiUrl !== config.ocrApiUrl) {
        const record = await readOcrKeyRecord();
        if (record && record.origin !== ocrOrigin) await store.remove(OCR_KEY_RECORD_ID);
      }

      config.serverUrl = serverUrl;
      config.ocrApiUrl = ocrApiUrl;
      writeConfig(config);
      return buildState();
    });
  }

  /**
   * 不带令牌探测一个服务器地址：用一个不存在的授权请求去轮询 A5，不会在服务器上留下任何状态。
   * 新版履约系统回信封 code 404「授权请求不存在」；还没升级的旧版不认这个接口，回 401/403；
   * 地址不是履约系统的 /api/v1（例如漏了 /api/v1）时回 HTML 或别的 HTTP 错误。
   */
  async function probeServer(serverUrl, signal) {
    try {
      await apiClient.pollPluginAuthorization(
        { serverUrl },
        { requestId: PROBE_REQUEST_ID, pollSecret: PROBE_POLL_SECRET },
        requestOptions({ signal, timeoutMs: POLL_REQUEST_TIMEOUT_MS }),
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.businessCode === 404) return { ok: true };
      if (error instanceof ApiError && (error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN')) {
        return { ok: false, message: `能连上服务器，但${NOT_UPGRADED_MESSAGE}。` };
      }
      if (error instanceof ApiError && (error.code === 'HTTP_ERROR' || error.code === 'INVALID_JSON')) {
        return { ok: false, message: '这个地址不是履约系统的接口地址，请确认地址以 /api/v1 结尾，例如 http://服务器地址:7003/api/v1。' };
      }
      return { ok: false, message: `连接失败：${safeErrorMessage(error)}` };
    }
  }

  /**
   * 设置页的「测试连接」。serverUrl 是输入框里的地址（可以还没保存）：
   * - 和已保存的地址不同：账户属于原来的服务器，只探测新地址能不能连上、是否支持插件授权；
   * - 和已保存的相同或没传：用当前账户调 /auth/me；还没有账户时只探测服务器。
   */
  async function testConnection(serverUrl, signal) {
    await ready;
    let target = null;
    if (serverUrl != null && serverUrl !== '') {
      if (typeof serverUrl !== 'string') return { ok: false, message: '服务器地址必须是字符串。' };
      try {
        target = normalizeServerUrl(serverUrl);
      } catch (error) {
        return { ok: false, message: safeErrorMessage(error, '服务器地址格式无效。') };
      }
    }
    const config = readConfig();
    if (target !== null && target !== config.serverUrl) {
      const probe = await probeServer(target, signal);
      if (!probe.ok) return probe;
      return {
        ok: true,
        message:
          config.accounts.length > 0
            ? '可以连接这个履约系统。保存设置后原来的账户会断开，再点「连接账户」重新授权。'
            : '可以连接这个履约系统。保存设置后点「连接账户」完成授权。',
      };
    }

    let result;
    try {
      result = await withBackend((cfg) => apiClient.getMe(cfg, requestOptions({ signal })));
    } catch (error) {
      return { ok: false, message: `连接失败：${safeErrorMessage(error)}` };
    }
    if (!result.ok) {
      // 设置页里调用，不用约定 C 那句「点下方卡片」。
      const { reason } = result.authRequired;
      if (reason === 'no-account') {
        const probe = await probeServer(config.serverUrl, signal);
        if (!probe.ok) return probe;
        return { ok: true, message: '可以连接这个履约系统，还没有连接账户：请点「连接账户」完成浏览器授权。' };
      }
      let message = '当前账户的授权已失效（可能已被吊销），请重新连接账户。';
      if (reason === 'expired') message = '当前账户的授权已过期，请重新连接账户。';
      return { ok: false, message };
    }
    const me = isPlainObject(result.value) ? result.value : {};
    const account = {
      userId: Number(me.userId ?? me.id) || null,
      username: cleanText(me.username),
      realName: cleanText(me.realName),
      deptName: cleanText(me.deptName),
    };
    // 顺手更新当前账户的公开信息（姓名、部门可能在履约系统里改过）。
    await serialize(async () => {
      const config = readConfig();
      const active = config.accounts.find((item) => item.id === config.activeAccountId);
      if (!active || active.userId !== account.userId) return;
      if (active.realName === account.realName && active.deptName === account.deptName && active.username === account.username) return;
      Object.assign(active, { username: account.username, realName: account.realName, deptName: account.deptName });
      writeConfig(config);
    });
    return { ok: true, message: `连接成功，当前账户：${account.realName || account.username || '未知'}`, account };
  }

  async function startAuthorization(signal) {
    await ready;
    if (disposed) throw new ApiError('插件正在关闭，请稍后重试。', { code: 'DISPOSED' });
    // 发 A1 之前先占名额：在途的 A1 也算进同时进行的授权数。
    if (startsInFlight >= MAX_ACTIVE_AUTHORIZATIONS) {
      throw new ApiError('正在发起授权，请稍候再试。', { code: 'AUTH_BUSY' });
    }
    evictOldestPending(MAX_ACTIVE_AUTHORIZATIONS - startsInFlight - 1);
    const startEpoch = epoch;
    const { serverUrl } = readConfig();
    startsInFlight += 1;
    let data;
    try {
      data = await apiClient.startPluginAuthorization(
        { serverUrl },
        { clientName: CLIENT_NAME, deviceName },
        requestOptions({ signal }),
      );
    } catch (error) {
      // A1 是 permitAll：401/403/404 只会是还没升级、没有这个接口的后端。
      const codes = [401, 403, 404];
      if (error instanceof ApiError && (codes.includes(error.status) || codes.includes(error.businessCode))) {
        throw new ApiError(NOT_UPGRADED_MESSAGE, { status: error.status, code: 'NOT_SUPPORTED' });
      }
      throw error;
    } finally {
      startsInFlight -= 1;
    }
    // 响应回来时插件已卸载或服务器已更换：这次授权作废。
    if (disposed || epoch !== startEpoch || readConfig().serverUrl !== serverUrl) {
      throw new ApiError(SERVER_CHANGED_MESSAGE, { code: 'SERVER_CHANGED' });
    }
    const requestId = cleanText(data?.requestId);
    const pollSecret = cleanText(data?.pollSecret);
    const userCode = cleanText(data?.userCode);
    if (!requestId || !pollSecret || !userCode) {
      throw new ApiError('履约系统返回的授权请求不完整，请确认履约系统已升级到支持浏览器授权的版本。', {
        code: 'INVALID_RESPONSE',
      });
    }
    const intervalSeconds = clampNumber(data.interval, 1, 30, DEFAULT_POLL_INTERVAL_SECONDS);
    const ttlSeconds = clampNumber(data.expiresIn, 10, 3600, DEFAULT_AUTHORIZATION_TTL_SECONDS);
    const expiresAt = now() + ttlSeconds * 1000;
    const verifyUrl = resolveVerifyUrl(serverUrl, { ...data, requestId });

    evictOldestPending(MAX_ACTIVE_AUTHORIZATIONS - startsInFlight - 1);
    const previous = authorizations.get(requestId);
    if (previous) {
      stopPolling(previous);
      authorizations.delete(requestId);
    }

    const entry = {
      requestId,
      pollSecret,
      serverUrl,
      epoch: startEpoch,
      userCode,
      verifyUrl,
      intervalMs: intervalSeconds * 1000,
      expiresAt,
      createdAt: now(),
      status: 'pending',
      result: null,
      failures: 0,
      timer: null,
      controller: null,
      settledAt: 0,
      cancelRequested: false,
      committed: null,
      commitDone: null,
    };
    authorizations.set(requestId, entry);
    schedulePoll(entry, entry.intervalMs);
    return { requestId, userCode, verifyUrl, expiresAt: new Date(expiresAt).toISOString(), interval: intervalSeconds };
  }

  async function pollAuthorization(requestId) {
    const entry = typeof requestId === 'string' ? authorizations.get(requestId) : undefined;
    // 宿主重启、请求早已清理、或 approved 结果已经领取过：按过期处理。
    if (!entry) return { status: 'expired' };
    if (entry.status === 'committing') return { status: 'pending' };
    if (entry.status === 'pending') {
      if (now() < entry.expiresAt) return { status: 'pending' };
      settle(entry, { status: 'expired' });
    }
    const result = entry.result || { status: entry.status };
    if (result.status === 'approved') {
      // 首次领取即消费：之后不能再拿这个请求取消或重复领取。
      authorizations.delete(requestId);
      entry.committed = null;
      const state = await buildState();
      const account = state.accounts.find((item) => item.id === result.account.id);
      if (!account) return { status: 'error', message: '授权已完成，但这个账户随后已被断开，请重新连接。' };
      return { status: 'approved', account, state };
    }
    if (result.status === 'error') return { status: 'error', message: result.message };
    if (result.status === 'cancelled') return { status: 'expired' };
    return { status: result.status };
  }

  async function cancelAuthorization(requestId) {
    const entry = typeof requestId === 'string' ? authorizations.get(requestId) : undefined;
    if (!entry) return { ok: true };
    if (entry.status === 'committing') {
      // 正在保存：保存前看到取消就作废并吊销；已经保存则撤销这次授权。
      entry.cancelRequested = true;
      await entry.commitDone;
      return { ok: true };
    }
    stopPolling(entry);
    authorizations.delete(requestId);
    if (entry.status === 'approved' && entry.committed) {
      // 已保存但界面还没领取结果：撤销这次授权并吊销新令牌。
      try {
        await serialize(() => undoApproval(entry));
      } catch {
        warn(ctx, '@local/contract-sure: 撤销已保存的授权失败。');
      }
      return { ok: true };
    }
    if (entry.status === 'pending') entry.status = 'cancelled';
    return { ok: true };
  }

  async function setActiveAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId) {
      throw new ApiError('请提供要切换的账户。', { code: 'INVALID_REQUEST' });
    }
    await ready;
    return serialize(async () => {
      const config = readConfig();
      if (!config.accounts.some((item) => item.id === accountId)) {
        throw new ApiError('账户不存在，可能已被断开。', { code: 'ACCOUNT_NOT_FOUND' });
      }
      config.activeAccountId = accountId;
      writeConfig(config);
      return buildState();
    });
  }

  /** 断开账户：尽力吊销后删除本地凭据。返回 State 外加 revoked（服务端是否确认吊销）。 */
  async function disconnectAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId) {
      throw new ApiError('请提供要断开的账户。', { code: 'INVALID_REQUEST' });
    }
    await ready;
    return serialize(async () => {
      const config = readConfig();
      const account = config.accounts.find((item) => item.id === accountId);
      let revoked = false;
      if (account) {
        revoked = await revokeAndForget(config.serverUrl, account.userId);
        config.accounts = config.accounts.filter((item) => item.id !== accountId);
        if (config.activeAccountId === accountId) config.activeAccountId = config.accounts[0]?.id ?? null;
        writeConfig(config);
      }
      return { ...(await buildState()), revoked };
    });
  }

  function dispose() {
    disposed = true;
    epoch += 1;
    cancelAllAuthorizations();
  }

  return {
    ready,
    getState,
    saveSettings,
    testConnection,
    startAuthorization,
    pollAuthorization,
    cancelAuthorization,
    setActiveAccount,
    disconnectAccount,
    resolveBackend,
    runBackend,
    withBackend,
    localConfig,
    describeConnection,
    dispose,
  };
}
