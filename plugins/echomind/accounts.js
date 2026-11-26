import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import {
  ApiError,
  defaultApiClient,
  normalizeMirrorUrl,
  normalizeServerUrl,
  safeErrorMessage,
} from './api-client.js';
import {
  isHeaderSafeSecret,
  loadConfig,
  saveConfig,
} from './config-store.js';
import { createCredentialStore, credentialsFilePath } from './credential-store.js';

// EchoMind 多账户管理与浏览器飞书 PKCE 授权（对齐 @local/contract-sure 与 @local/salesforge 交互契约）。
// - 接口约定 B：getState / saveSettings / testConnection / startAuthorization / pollAuthorization /
//   cancelAuthorization / setActiveAccount / disconnectAccount，由 remote-service.js 暴露成 RPC。
// - 接口约定 C：未登录或后端返回 401 时，工具返回 kind 为 echomind-auth-required 的对象。
// - 令牌只保存在宿主凭据存储（~/.dsh/.credentials.yaml，0600）与宿主内存中，绝不回显给前端或模型。

export const AUTH_REQUIRED_KIND = 'echomind-auth-required';
export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
export const DEFAULT_CALLBACK_PORT = 43517;
export const CALLBACK_PATH = '/feishu/callback';
export const CLIENT_DEVICE_PREFIX = '小智办公';

const AUTH_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1500;
const MAX_TRACKED_AUTH = 10;
const SETTINGS_PATCH_KEYS = new Set([
  'serverUrl',
  'binaryMirrorUrl',
  'modelMirrorUrl',
  'recordingsDir',
  'lastJoinCode',
  'disconnectAccounts',
]);
const SERVER_CHANGED_MESSAGE = '服务器地址已经变更，这次授权作废，请重新连接账户。';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function accountHash(joinCode, openId) {
  const key = `${cleanText(joinCode).toUpperCase()}:${cleanText(openId)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

export function accountIdFor(joinCode, openId) {
  return `em_${accountHash(joinCode, openId)}`;
}

export function credentialRecordIdFor(accountId) {
  const hex = String(accountId || '').replace(/^em_/u, '').toLowerCase().replace(/[^a-z0-9]/gu, '');
  return `acct-${hex || 'default'}`;
}

export function authRequiredOutput(reason, serverUrl, account = null) {
  const who = account ? `「${account.name || account.openId}」` : '';
  let message = '需要先连接 EchoMind 飞书账户：请点下方卡片的「连接飞书账户」，在浏览器完成飞书授权后回复「继续」。';
  if (reason === 'expired') {
    message = `EchoMind 账户${who}的登录已过期：请点下方卡片的「连接飞书账户」，重新完成飞书授权后回复「继续」。`;
  } else if (reason === 'revoked') {
    message = `EchoMind 账户${who}的登录已失效：请点下方卡片的「连接飞书账户」，重新完成飞书授权后回复「继续」。`;
  }
  return { kind: AUTH_REQUIRED_KIND, reason, serverUrl, message };
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function callbackHtml(title, detail, ok) {
  const badgeColor = ok ? '#1a7f37' : '#d1242f';
  const badgeText = ok ? '授权已完成' : '未能完成授权';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)} · EchoMind</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8f5;color:#1f1f1f;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  .card{max-width:440px;margin:24px;padding:28px 32px;border-radius:16px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,.08);text-align:center}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:${badgeColor};background:color-mix(in srgb,${badgeColor} 12%,transparent)}
  h1{margin:14px 0 8px;font-size:20px;font-weight:600}
  p{margin:0;color:#5c5c5c;font-size:14px}
</style>
</head>
<body>
  <div class="card">
    <span class="badge">${badgeText}</span>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>`;
}

export function createAccountManager(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const configPath = deps.configPath;
  const configOptions = { configPath };
  const store =
    deps.credentialStore ||
    createCredentialStore(ctx, { filePath: deps.credentialsPath || credentialsFilePath(configPath) });
  const now = deps.now || (() => Date.now());
  const callbackHost = deps.callbackHost || '127.0.0.1';
  const callbackPort = deps.callbackPort ?? (Number(process.env.ECHOMIND_CALLBACK_PORT) || DEFAULT_CALLBACK_PORT);
  const deviceHost = String((deps.hostname || hostname)() || '').trim().slice(0, 64);
  const deviceLabel = deviceHost ? `${CLIENT_DEVICE_PREFIX} · ${deviceHost}` : CLIENT_DEVICE_PREFIX;
  const onAccountChange = typeof deps.onAccountChange === 'function' ? deps.onAccountChange : () => {};

  const authorizations = new Map();
  let activeLoopback = null;
  let disposed = false;
  let epoch = 0;

  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const readConfig = () => loadConfig(configOptions);
  const writeConfig = (cfg) => saveConfig(cfg, configOptions);

  const isExpired = (account) => Boolean(account.expiresAt) && Date.parse(account.expiresAt) <= now();
  const effectiveStatus = (account) => (account.status === 'ok' && isExpired(account) ? 'expired' : account.status);
  const publicAccount = (account) => ({
    id: account.id,
    openId: account.openId,
    name: account.name,
    enName: account.enName || '',
    email: account.email || '',
    companyName: account.companyName || '',
    joinCode: account.joinCode || '',
    admin: Boolean(account.admin),
    missingScopes: Array.isArray(account.missingScopes) ? [...account.missingScopes] : [],
    expiresAt: account.expiresAt || '',
    addedAt: account.addedAt || '',
    status: effectiveStatus(account),
  });

  async function readGrant(accountId) {
    const record = await store.read(credentialRecordIdFor(accountId));
    if (record?.kind !== 'grant' || !isPlainObject(record.payload)) return null;
    const token = cleanText(record.payload.token);
    if (!token || !isHeaderSafeSecret(token)) return null;
    return record.payload;
  }

  async function revokeRemote(serverUrl, token) {
    if (!serverUrl || !token) return false;
    try {
      await apiClient.logout({ serverUrl, token });
      return true;
    } catch (error) {
      return error instanceof ApiError && error.code === 'UNAUTHORIZED';
    }
  }

  function closeLoopback(entry) {
    if (!entry) return;
    if (entry.timeout) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    if (entry.server) {
      const srv = entry.server;
      entry.server = null;
      try {
        srv.close();
      } catch {
        // Ignore close race.
      }
      if (activeLoopback === entry) activeLoopback = null;
    }
  }

  function pruneAuthorizations() {
    while (authorizations.size > MAX_TRACKED_AUTH) {
      const oldestKey = authorizations.keys().next().value;
      if (!oldestKey) break;
      const oldest = authorizations.get(oldestKey);
      closeLoopback(oldest);
      authorizations.delete(oldestKey);
    }
  }

  function cancelAllAuthorizations() {
    for (const entry of authorizations.values()) {
      closeLoopback(entry);
      if (entry.status === 'pending') {
        entry.status = 'cancelled';
        entry.cancelRequested = true;
      }
    }
  }

  async function storeApprovedAccount({ serverUrl, data, joinCode }) {
    const token = cleanText(data?.token);
    const profile = isPlainObject(data?.profile) ? data.profile : {};
    const openId = cleanText(profile.open_id || profile.openId);
    if (!token || !isHeaderSafeSecret(token) || !openId) {
      throw new ApiError('EchoMind 服务端返回的飞书登录结果不完整。', { code: 'INVALID_RESPONSE' });
    }
    const config = readConfig();
    if (config.serverUrl !== serverUrl) {
      throw new ApiError(SERVER_CHANGED_MESSAGE, { code: 'SERVER_CHANGED' });
    }

    const company = isPlainObject(data?.company) ? data.company : {};
    const resolvedJoinCode = cleanText(company.joinCode || joinCode).toUpperCase();
    const companyName = cleanText(company.name);
    const expiresAt = typeof data.expiresAt === 'string' && !Number.isNaN(Date.parse(data.expiresAt)) ? data.expiresAt : '';
    const missingScopes = Array.isArray(data.missingScopes) ? data.missingScopes.filter((s) => typeof s === 'string') : [];

    // 额外查一次 /v1/me 以获取 admin 标记（失败不阻塞登录）。
    let admin = false;
    try {
      const me = await apiClient.getMe({ serverUrl, token });
      admin = Boolean(me?.admin);
    } catch {
      admin = false;
    }

    const id = accountIdFor(resolvedJoinCode, openId);
    const recordId = credentialRecordIdFor(id);
    const previous = await readGrant(id);

    await store.write(recordId, {
      kind: 'grant',
      payload: {
        version: 1,
        token,
        serverUrl,
        openId,
        joinCode: resolvedJoinCode,
        expiresAt,
      },
    });

    const account = {
      id,
      openId,
      name: cleanText(profile.name) || openId,
      enName: cleanText(profile.en_name || profile.enName),
      email: cleanText(profile.email),
      companyName,
      joinCode: resolvedJoinCode,
      admin,
      missingScopes,
      expiresAt,
      addedAt: new Date(now()).toISOString(),
      status: 'ok',
    };

    try {
      const idx = config.accounts.findIndex((item) => item.id === id);
      if (idx >= 0) config.accounts[idx] = account;
      else config.accounts.push(account);
      config.activeAccountId = id;
      if (resolvedJoinCode) config.lastJoinCode = resolvedJoinCode;
      writeConfig(config);
    } catch (error) {
      try {
        if (previous) await store.write(recordId, { kind: 'grant', payload: previous });
        else await store.remove(recordId);
      } catch {
        // Best-effort rollback.
      }
      throw error;
    }

    const replaced = previous && previous.token !== token ? previous : null;
    if (replaced) void revokeRemote(replaced.serverUrl || serverUrl, replaced.token);
    onAccountChange('connected', publicAccount(account));
    return { account, token };
  }

  function startLoopbackServer(entry) {
    return new Promise((resolveStart, rejectStart) => {
      const server = createServer((req, res) => {
        const sendHtml = (statusCode, title, detail, ok) => {
          res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(callbackHtml(title, detail, ok));
        };

        let parsed;
        try {
          parsed = new URL(req.url || '/', `http://${callbackHost}`);
        } catch {
          sendHtml(400, '回调地址无效', '请回到小智办公重新发起飞书授权。', false);
          return;
        }
        if (parsed.pathname !== CALLBACK_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        const state = parsed.searchParams.get('state') || '';
        const code = parsed.searchParams.get('code') || '';
        const errorParam = parsed.searchParams.get('error') || '';

        if (!constantTimeEqual(state, entry.state)) {
          sendHtml(400, '授权校验未通过', '状态校验不匹配，可能已过期或被取消，请回到小智办公重新连接。', false);
          return;
        }

        if (entry.status !== 'pending' || entry.cancelRequested || disposed) {
          sendHtml(410, '本次授权已取消或过期', '请回到小智办公重新发起连接。', false);
          closeLoopback(entry);
          return;
        }

        if (errorParam || !code) {
          entry.status = 'denied';
          entry.message = '你取消了飞书授权，如需连接请重新发起。';
          closeLoopback(entry);
          sendHtml(200, '已取消飞书授权', '你可以关闭此页面并返回小智办公。', false);
          return;
        }

        entry.status = 'committing';
        closeLoopback(entry);

        void serialize(async () => {
          if (entry.cancelRequested || disposed) {
            entry.status = 'cancelled';
            sendHtml(200, '本次授权已取消', '你可以关闭此页面并返回小智办公。', false);
            return;
          }
          if (entry.epoch !== epoch || readConfig().serverUrl !== entry.serverUrl) {
            entry.status = 'error';
            entry.message = SERVER_CHANGED_MESSAGE;
            sendHtml(409, '服务器地址已变更', SERVER_CHANGED_MESSAGE, false);
            return;
          }
          try {
            const data = await apiClient.exchangeFeishuCode(
              { serverUrl: entry.serverUrl },
              {
                code,
                codeVerifier: entry.codeVerifier,
                redirectUri: entry.redirectUri,
                device: deviceLabel,
                ...(entry.joinCode ? { company: entry.joinCode } : {}),
              },
            );
            const stored = await storeApprovedAccount({
              serverUrl: entry.serverUrl,
              data,
              joinCode: entry.joinCode,
            });
            if (entry.cancelRequested || disposed) {
              void revokeRemote(entry.serverUrl, stored.token);
              entry.status = 'cancelled';
              sendHtml(200, '本次授权已取消', '你可以关闭此页面并返回小智办公。', false);
              return;
            }
            entry.status = 'approved';
            entry.account = publicAccount(stored.account);
            entry.message = '';
            sendHtml(200, `已连接 ${stored.account.name}`, '飞书授权成功，现在可以关闭此页面并返回小智办公。', true);
          } catch (error) {
            entry.status = 'error';
            entry.message = safeErrorMessage(error, '换取飞书登录会话失败，请回到小智办公重试。');
            sendHtml(500, '连接失败', entry.message, false);
          }
        });
      });

      server.once('error', (error) => {
        if (error?.code === 'EADDRINUSE') {
          rejectStart(
            new ApiError(
              `本机飞书登录回调端口 ${callbackPort} 正被占用（可能独立版 EchoMind 或另一场登录正在进行），请稍后再试。`,
              { code: 'CALLBACK_PORT_BUSY' },
            ),
          );
          return;
        }
        rejectStart(new ApiError('无法启动本机飞书授权回调监听，请重试。', { code: 'CALLBACK_LISTEN_FAILED' }));
      });

      server.listen(callbackPort, callbackHost, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : callbackPort;
        entry.server = server;
        entry.redirectUri = `http://${callbackHost}:${actualPort}${CALLBACK_PATH}`;
        activeLoopback = entry;
        resolveStart(actualPort);
      });
    });
  }

  async function getState() {
    const config = readConfig();
    const accounts = config.accounts.map(publicAccount);
    const activeAccount = accounts.find((a) => a.id === config.activeAccountId) || null;
    return {
      serverUrl: config.serverUrl,
      binaryMirrorUrl: config.binaryMirrorUrl,
      modelMirrorUrl: config.modelMirrorUrl,
      recordingsDir: config.recordingsDir,
      lastJoinCode: config.lastJoinCode,
      credentialStorageKind: store.kind(),
      activeAccountId: activeAccount ? activeAccount.id : null,
      accounts,
      activeAccount,
    };
  }

  async function saveSettings(patch) {
    if (!isPlainObject(patch)) {
      throw new ApiError('设置参数格式无效。', { code: 'INVALID_REQUEST' });
    }
    for (const key of Object.keys(patch)) {
      if (!SETTINGS_PATCH_KEYS.has(key)) {
        throw new ApiError(`不支持的设置项：${key}`, { code: 'INVALID_REQUEST' });
      }
    }
    return serialize(async () => {
      const current = readConfig();
      const next = { ...current, accounts: [...current.accounts] };

      let serverChanged = false;
      if (patch.serverUrl !== undefined) {
        const normalized = normalizeServerUrl(patch.serverUrl);
        serverChanged = normalized !== current.serverUrl;
        next.serverUrl = normalized;
      }
      if (patch.binaryMirrorUrl !== undefined) {
        next.binaryMirrorUrl = normalizeMirrorUrl(patch.binaryMirrorUrl);
      }
      if (patch.modelMirrorUrl !== undefined) {
        next.modelMirrorUrl = normalizeMirrorUrl(patch.modelMirrorUrl);
      }
      if (patch.recordingsDir !== undefined) {
        next.recordingsDir = cleanText(patch.recordingsDir);
      }
      if (patch.lastJoinCode !== undefined) {
        next.lastJoinCode = cleanText(patch.lastJoinCode).toUpperCase();
      }

      if (serverChanged && current.accounts.length > 0) {
        if (!patch.disconnectAccounts) {
          throw new ApiError('切换服务器地址将断开当前已连接的账户，请确认后再保存。', { code: 'ACCOUNTS_EXIST' });
        }
        for (const account of current.accounts) {
          try {
            const grant = await readGrant(account.id);
            if (grant?.token) void revokeRemote(grant.serverUrl || current.serverUrl, grant.token);
            await store.remove(credentialRecordIdFor(account.id));
          } catch {
            // Continue cleaning remaining accounts.
          }
        }
        next.accounts = [];
        next.activeAccountId = null;
      }

      if (serverChanged) {
        epoch += 1;
        cancelAllAuthorizations();
      }
      writeConfig(next);
      onAccountChange('settings-saved', null);
      return getState();
    });
  }

  async function testConnection(serverUrl, joinCode, signal) {
    const targetUrl = normalizeServerUrl(serverUrl || readConfig().serverUrl);
    const code = cleanText(joinCode).toUpperCase();
    let health = null;
    try {
      health = await apiClient.health({ serverUrl: targetUrl }, { signal });
    } catch (error) {
      // 某些反代或旧服务端可能未暴露 /healthz，回退直接探测 /v1/auth/feishu/config。
      if (!(error instanceof ApiError) || (error.code !== 'NOT_FOUND' && error.status !== 404)) {
        throw error;
      }
    }
    const feishuConfig = await apiClient.getFeishuConfig({ serverUrl: targetUrl }, code || undefined, { signal });
    return {
      ok: true,
      serverUrl: targetUrl,
      company: feishuConfig?.company || null,
      health: health ? { ok: true } : null,
      message: feishuConfig?.company?.name
        ? `连接成功（公司：${feishuConfig.company.name}）`
        : '连接 EchoMind 服务端成功',
    };
  }

  async function startAuthorization(options = {}, signal) {
    const opts = isPlainObject(options) ? options : {};
    const config = readConfig();
    const serverUrl = config.serverUrl;
    const requestedJoinCode = cleanText(opts.joinCode || config.lastJoinCode).toUpperCase();

    const feishuConfig = await apiClient.getFeishuConfig(
      { serverUrl },
      requestedJoinCode || undefined,
      { signal },
    );
    const appId = cleanText(feishuConfig?.appId);
    const scopes = Array.isArray(feishuConfig?.scopes)
      ? feishuConfig.scopes.join(' ')
      : cleanText(feishuConfig?.scopes);
    const companyName = cleanText(feishuConfig?.company?.name);
    const resolvedJoinCode = cleanText(feishuConfig?.company?.joinCode || requestedJoinCode).toUpperCase();
    if (!appId) {
      throw new ApiError('EchoMind 服务端未返回有效的飞书应用配置。', { code: 'INVALID_RESPONSE' });
    }

    // 同一时刻只保留一条活跃回环监听，释放前一次监听端口。
    if (activeLoopback) {
      const prev = activeLoopback;
      closeLoopback(prev);
      if (prev.status === 'pending') prev.status = 'cancelled';
    }

    const requestId = randomUUID();
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');
    const expiresAtMs = now() + AUTH_TTL_MS;

    const entry = {
      requestId,
      serverUrl,
      joinCode: resolvedJoinCode,
      companyName,
      codeVerifier,
      state,
      redirectUri: '',
      status: 'pending',
      account: null,
      message: '',
      cancelRequested: false,
      epoch,
      expiresAtMs,
      server: null,
      timeout: null,
    };

    await startLoopbackServer(entry);
    entry.timeout = setTimeout(() => {
      if (entry.status === 'pending') {
        entry.status = 'expired';
        entry.message = '飞书授权已超时，请重新连接。';
        closeLoopback(entry);
      }
    }, AUTH_TTL_MS);
    entry.timeout.unref?.();

    const authorizeUrl = new URL(FEISHU_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('client_id', appId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', entry.redirectUri);
    if (scopes) authorizeUrl.searchParams.set('scope', scopes);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    authorizations.set(requestId, entry);
    pruneAuthorizations();

    return {
      requestId,
      verifyUrl: authorizeUrl.href,
      redirectUri: entry.redirectUri,
      companyName,
      joinCode: resolvedJoinCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
      pollIntervalMs: POLL_INTERVAL_MS,
    };
  }

  async function pollAuthorization(requestId) {
    const entry = authorizations.get(cleanText(requestId));
    if (!entry) {
      return { status: 'expired', message: '这次授权请求已过期或不存在，请重新发起连接。' };
    }
    if (entry.status === 'pending' && now() >= entry.expiresAtMs) {
      entry.status = 'expired';
      entry.message = '飞书授权已超时，请重新连接。';
      closeLoopback(entry);
    }
    if (entry.status === 'committing') {
      return { status: 'pending' };
    }
    if (entry.status === 'approved') {
      return { status: 'approved', account: entry.account };
    }
    return {
      status: entry.status,
      ...(entry.message ? { message: entry.message } : {}),
    };
  }

  async function cancelAuthorization(requestId) {
    const entry = authorizations.get(cleanText(requestId));
    if (!entry) return { ok: true };
    entry.cancelRequested = true;
    closeLoopback(entry);
    if (entry.status === 'pending') entry.status = 'cancelled';
    return { ok: true };
  }

  async function setActiveAccount(accountId) {
    return serialize(async () => {
      const config = readConfig();
      const target = config.accounts.find((item) => item.id === cleanText(accountId));
      if (!target) {
        throw new ApiError('找不到指定的 EchoMind 账户。', { code: 'NOT_FOUND' });
      }
      config.activeAccountId = target.id;
      writeConfig(config);
      onAccountChange('switched', publicAccount(target));
      return getState();
    });
  }

  async function disconnectAccount(accountId) {
    return serialize(async () => {
      const config = readConfig();
      const targetId = cleanText(accountId);
      const target = config.accounts.find((item) => item.id === targetId);
      if (!target) {
        throw new ApiError('找不到指定的 EchoMind 账户。', { code: 'NOT_FOUND' });
      }
      const grant = await readGrant(target.id);
      if (grant?.token) {
        await revokeRemote(grant.serverUrl || config.serverUrl, grant.token);
      }
      await store.remove(credentialRecordIdFor(target.id));
      config.accounts = config.accounts.filter((item) => item.id !== target.id);
      if (config.activeAccountId === target.id) {
        config.activeAccountId = config.accounts[0]?.id ?? null;
      }
      writeConfig(config);
      onAccountChange('disconnected', publicAccount(target));
      return getState();
    });
  }

  async function markAccountStatus(accountId, status) {
    return serialize(async () => {
      const config = readConfig();
      const target = config.accounts.find((item) => item.id === accountId);
      if (!target) return;
      target.status = status;
      writeConfig(config);
    });
  }

  async function getActiveBackend() {
    const config = readConfig();
    const account = config.accounts.find((item) => item.id === config.activeAccountId) || null;
    if (!account) {
      return { ok: false, authRequired: authRequiredOutput('no-account', config.serverUrl, null) };
    }
    const status = effectiveStatus(account);
    if (status === 'expired' || status === 'revoked') {
      return { ok: false, authRequired: authRequiredOutput(status, config.serverUrl, account) };
    }
    const grant = await readGrant(account.id);
    if (!grant?.token) {
      await markAccountStatus(account.id, 'revoked');
      return { ok: false, authRequired: authRequiredOutput('revoked', config.serverUrl, account) };
    }
    return {
      ok: true,
      cfg: { serverUrl: config.serverUrl, token: grant.token },
      account: publicAccount(account),
    };
  }

  /**
   * 统一包装需要 EchoMind 服务端会话的调用：
   * - 未登录或 401 时返回 { ok: false, authRequired }（约定 C）；
   * - 5xx/超时/网络故障按普通异常抛出，绝不误标账户失效。
   */
  async function runBackend(fn) {
    const active = await getActiveBackend();
    if (!active.ok) return active;
    try {
      const value = await fn(active.cfg, active.account);
      return { ok: true, value, account: active.account };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'UNAUTHORIZED') {
        await markAccountStatus(active.account.id, 'expired');
        return {
          ok: false,
          authRequired: authRequiredOutput('expired', active.cfg.serverUrl, active.account),
        };
      }
      throw error;
    }
  }

  async function refreshActiveProfile(signal) {
    return runBackend(async (cfg, account) => {
      const me = await apiClient.getMe(cfg, { signal });
      await serialize(async () => {
        const config = readConfig();
        const target = config.accounts.find((item) => item.id === account.id);
        if (!target) return;
        target.name = cleanText(me?.name) || target.name;
        target.admin = Boolean(me?.admin);
        target.missingScopes = Array.isArray(me?.missingScopes) ? me.missingScopes : [];
        if (me?.company?.name) target.companyName = cleanText(me.company.name);
        if (me?.company?.joinCode) target.joinCode = cleanText(me.company.joinCode).toUpperCase();
        target.status = 'ok';
        writeConfig(config);
      });
      return me;
    });
  }

  function dispose() {
    disposed = true;
    epoch += 1;
    cancelAllAuthorizations();
    authorizations.clear();
  }

  return {
    getState,
    saveSettings,
    testConnection,
    startAuthorization,
    pollAuthorization,
    cancelAuthorization,
    setActiveAccount,
    disconnectAccount,
    getActiveBackend,
    runBackend,
    refreshActiveProfile,
    dispose,
  };
}
