import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVER_URL, originOf } from './config-store.js';

// EchoMind 服务端零依赖客户端（基于 node:https / node:http）。
// - 对默认试点服务器（https://58.87.77.127:8443）严格固定内置根证书 certs/echomind-ca.pem，
//   等价于 EchoMind 桌面端 server.rs 的 tls_certs_only([ca])；
// - 对自定义 HTTPS 域名默认走系统根证书链（测试或私有部署可通过 options.caPem 注入自定义 CA）；
// - 对外错误信息统一为可控中文文案，不暴露 Authorization 请求头或底层栈文本。

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_CA_PATH = join(__dirname, 'certs', 'echomind-ca.pem');
export const DEFAULT_PILOT_ORIGIN = originOf(DEFAULT_SERVER_URL);

let cachedBundledCa = null;
export function bundledCaPem() {
  if (cachedBundledCa !== null) return cachedBundledCa;
  try {
    cachedBundledCa = readFileSync(BUNDLED_CA_PATH, 'utf8');
  } catch {
    cachedBundledCa = '';
  }
  return cachedBundledCa;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const LLM_TIMEOUT_MS = 660_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = 0, serverCode = '', retryable = false } = {}) {
    super(message || '请求 EchoMind 服务失败，请稍后重试。');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.serverCode = serverCode;
    this.retryable = retryable;
  }
}

export function safeErrorMessage(error, fallback = '操作失败，请稍后重试。') {
  if (error instanceof ApiError && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (error?.name === 'CredentialStoreError' && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return fallback;
}

export function normalizeServerUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('请填写 EchoMind 服务器地址。', { code: 'INVALID_URL' });
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ApiError('EchoMind 服务器地址格式不正确。', { code: 'INVALID_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError('EchoMind 服务器地址必须以 http:// 或 https:// 开头。', { code: 'INVALID_URL' });
  }
  if (parsed.username || parsed.password) {
    throw new ApiError('服务器地址中不能包含用户名或密码。', { code: 'INVALID_URL' });
  }
  const basePath = parsed.pathname.replace(/\/+$/u, '').replace(/\/v1$/iu, '');
  return `${parsed.origin}${basePath}`;
}

export function normalizeMirrorUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ApiError('镜像地址格式不正确。', { code: 'INVALID_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError('镜像地址必须是合法的 http:// 或 https:// 地址。', { code: 'INVALID_URL' });
  }
  return parsed.href.replace(/\/+$/u, '');
}

const pinnedAgentCache = new Map();

function httpsAgentFor(url, caPem) {
  const customCa = typeof caPem === 'string' && caPem.trim() ? caPem.trim() : '';
  const shouldPinPilot = !customCa && originOf(url.href) === DEFAULT_PILOT_ORIGIN;
  const effectiveCa = customCa || (shouldPinPilot ? bundledCaPem() : '');
  if (!effectiveCa) return undefined;
  let agent = pinnedAgentCache.get(effectiveCa);
  if (!agent) {
    // 固定 CA：只信任指定根证书，与 EchoMind 桌面端 server.rs 一致。
    agent = new HttpsAgent({ ca: effectiveCa, rejectUnauthorized: true, keepAlive: true });
    pinnedAgentCache.set(effectiveCa, agent);
  }
  return agent;
}

function sendNodeHttp(url, { method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal, caPem } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const payload = body === null || body === undefined
      ? null
      : (typeof body === 'string' || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));

    const reqHeaders = { ...headers };
    if (payload !== null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) rejectPromise(err);
      else resolvePromise(val);
    };

    const req = requestFn(
      parsed,
      {
        method,
        headers: reqHeaders,
        agent: isHttps ? httpsAgentFor(parsed, caPem) : undefined,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy();
            finish(new ApiError('EchoMind 服务端返回内容过大。', { code: 'RESPONSE_TOO_LARGE', status: res.statusCode || 0 }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          finish(null, {
            status: res.statusCode || 0,
            headers: res.headers || {},
            text: rawText,
          });
        });
        res.on('error', () => {
          finish(new ApiError('读取 EchoMind 服务端响应中断，请稍后重试。', { code: 'NETWORK_ERROR', retryable: true }));
        });
      },
    );

    const onAbort = () => {
      req.destroy();
      finish(new ApiError('请求已取消。', { code: 'CANCELLED' }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      req.destroy();
      finish(new ApiError('连接 EchoMind 服务端超时，请检查网络后重试。', { code: 'TIMEOUT', retryable: true }));
    }, timeoutMs);
    timer.unref?.();

    req.on('error', (err) => {
      const errCode = String(err?.code || '');
      if (errCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' || errCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || errCode === 'ERR_TLS_CERT_ALTNAME_INVALID' || errCode === 'CERT_HAS_EXPIRED') {
        finish(new ApiError('EchoMind 服务器证书校验未通过，请确认服务器地址与证书配置正确。', { code: 'TLS_ERROR' }));
        return;
      }
      finish(new ApiError('无法连接到 EchoMind 服务端，请检查网络或服务器地址。', { code: 'NETWORK_ERROR', retryable: true }));
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

function mapServerError(status, rawText) {
  let serverCode = '';
  let serverMessage = '';
  try {
    const parsed = JSON.parse(rawText);
    if (parsed?.error && typeof parsed.error === 'object') {
      serverCode = typeof parsed.error.code === 'string' ? parsed.error.code : '';
      serverMessage = typeof parsed.error.message === 'string' ? parsed.error.message.trim() : '';
    }
  } catch {
    // Non-JSON error page.
  }

  if (status === 401) {
    return new ApiError(serverMessage || '登录已过期，请重新用飞书登录。', {
      code: 'UNAUTHORIZED',
      status,
      serverCode: serverCode || 'unauthorized',
    });
  }
  if (status === 403) {
    return new ApiError(serverMessage || '当前账号无权执行该操作。', {
      code: 'FORBIDDEN',
      status,
      serverCode: serverCode || 'forbidden',
    });
  }
  if (status === 404) {
    return new ApiError(serverMessage || '请求的资源不存在。', {
      code: 'NOT_FOUND',
      status,
      serverCode: serverCode || 'not_found',
    });
  }
  if (status === 413) {
    return new ApiError(serverMessage || '提交内容超过服务端大小限制。', {
      code: 'TOO_LARGE',
      status,
      serverCode: serverCode || 'too_large',
    });
  }
  if (status === 429) {
    return new ApiError(serverMessage || '请求过于频繁，请稍后再试。', {
      code: 'RATE_LIMITED',
      status,
      serverCode: serverCode || 'rate_limited',
      retryable: true,
    });
  }
  if (status >= 500) {
    return new ApiError(serverMessage || 'EchoMind 服务端暂时不可用，请稍后重试。', {
      code: 'SERVER_ERROR',
      status,
      serverCode: serverCode || 'server_error',
      retryable: true,
    });
  }
  return new ApiError(serverMessage || `EchoMind 服务端拒绝了请求（HTTP ${status}）。`, {
    code: serverCode ? serverCode.toUpperCase() : 'BAD_REQUEST',
    status,
    serverCode,
  });
}

async function callJson({ serverUrl, token }, path, { method = 'GET', query, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, caPem, transport } = {}) {
  const base = normalizeServerUrl(serverUrl);
  const fullPath = path.startsWith('/healthz') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(`${base}${fullPath}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json; charset=utf-8';

  const exec = transport || sendNodeHttp;
  const res = await exec(url.href, { method, headers, body, timeoutMs, signal, caPem });
  if (res.status < 200 || res.status >= 300) {
    throw mapServerError(res.status, res.text);
  }
  if (!res.text || !res.text.trim()) return {};
  try {
    return JSON.parse(res.text);
  } catch {
    throw new ApiError('EchoMind 服务端返回了无法解析的数据。', { code: 'INVALID_RESPONSE', status: res.status });
  }
}

export function createApiClient(defaultOptions = {}) {
  const mergeOpts = (opts = {}) => ({ ...defaultOptions, ...opts });

  return {
    health(cfg, opts) {
      return callJson({ serverUrl: cfg.serverUrl }, '/healthz', mergeOpts({ timeoutMs: 10_000, ...opts }));
    },

    getFeishuConfig(cfg, joinCode, opts) {
      return callJson(
        { serverUrl: cfg.serverUrl },
        '/auth/feishu/config',
        mergeOpts({ query: joinCode ? { company: joinCode } : undefined, timeoutMs: 15_000, ...opts }),
      );
    },

    exchangeFeishuCode(cfg, payload, opts) {
      return callJson(
        { serverUrl: cfg.serverUrl },
        '/auth/feishu',
        mergeOpts({ method: 'POST', body: payload, timeoutMs: 20_000, ...opts }),
      );
    },

    logout(cfg, opts) {
      return callJson(cfg, '/auth/logout', mergeOpts({ method: 'POST', timeoutMs: 10_000, ...opts }));
    },

    getMe(cfg, opts) {
      return callJson(cfg, '/me', mergeOpts({ timeoutMs: 15_000, ...opts }));
    },

    getDirectory(cfg, { refresh = false } = {}, opts) {
      return callJson(
        cfg,
        '/directory',
        mergeOpts({ query: refresh ? { refresh: '1' } : undefined, timeoutMs: 30_000, ...opts }),
      );
    },

    getCalendarAttendees(cfg, { start, end }, opts) {
      return callJson(
        cfg,
        '/calendar/attendees',
        mergeOpts({ query: { start, end }, timeoutMs: 20_000, ...opts }),
      );
    },

    createFeishuTask(cfg, task, opts) {
      return callJson(cfg, '/feishu/tasks', mergeOpts({ method: 'POST', body: task, timeoutMs: 20_000, ...opts }));
    },

    listVoiceprints(cfg, opts) {
      return callJson(cfg, '/voiceprints', mergeOpts({ timeoutMs: 15_000, ...opts }));
    },

    matchVoiceprints(cfg, voices, opts) {
      return callJson(cfg, '/voiceprints/match', mergeOpts({ method: 'POST', body: { voices }, timeoutMs: 30_000, ...opts }));
    },

    askVoiceprintConsent(cfg, openId, meetingTitle, opts) {
      return callJson(
        cfg,
        `/voiceprints/${encodeURIComponent(openId)}/ask`,
        mergeOpts({ method: 'POST', body: meetingTitle ? { meeting: meetingTitle } : {}, timeoutMs: 20_000, ...opts }),
      );
    },

    addVoiceprintSample(cfg, openId, sample, opts) {
      return callJson(
        cfg,
        `/voiceprints/${encodeURIComponent(openId)}/samples`,
        mergeOpts({ method: 'POST', body: sample, timeoutMs: 20_000, ...opts }),
      );
    },

    deleteVoiceprint(cfg, openId, opts) {
      return callJson(
        cfg,
        `/voiceprints/${encodeURIComponent(openId)}`,
        mergeOpts({ method: 'DELETE', timeoutMs: 15_000, ...opts }),
      );
    },

    putMeetingMinutes(cfg, meetingId, upload, opts) {
      return callJson(
        cfg,
        `/meetings/${encodeURIComponent(meetingId)}/minutes`,
        mergeOpts({ method: 'PUT', body: upload, timeoutMs: 30_000, ...opts }),
      );
    },

    getMeetingMinutes(cfg, meetingId, opts) {
      return callJson(
        cfg,
        `/meetings/${encodeURIComponent(meetingId)}/minutes`,
        mergeOpts({ timeoutMs: 15_000, ...opts }),
      );
    },

    withdrawMeetingMinutes(cfg, meetingId, opts) {
      return callJson(
        cfg,
        `/meetings/${encodeURIComponent(meetingId)}/minutes`,
        mergeOpts({ method: 'DELETE', timeoutMs: 20_000, ...opts }),
      );
    },

    getLlmStatus(cfg, opts) {
      return callJson(cfg, '/llm/status', mergeOpts({ timeoutMs: 15_000, ...opts }));
    },

    /**
     * DeepSeek 代理：严格复刻 EchoMind server.rs 契约——上游 DeepSeek 4xx/5xx 响应
     * 原样透传为 { status, body } 交由 minutes-engine 自行做退避重试。
     */
    async proxyLlmChat(cfg, body, opts = {}) {
      const merged = mergeOpts({ timeoutMs: LLM_TIMEOUT_MS, ...opts });
      const base = normalizeServerUrl(cfg.serverUrl);
      const url = `${base}/v1/llm/chat`;
      const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
      };
      if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
      const exec = merged.transport || sendNodeHttp;
      const res = await exec(url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: merged.timeoutMs,
        signal: merged.signal,
        caPem: merged.caPem,
      });
      const upstream = String(res.headers?.['x-echomind-upstream'] || '').toLowerCase();
      if (upstream === 'deepseek') {
        return { status: res.status, body: res.text };
      }
      if (res.status < 200 || res.status >= 300) {
        throw mapServerError(res.status, res.text);
      }
      return { status: res.status, body: res.text };
    },

    // 公司管理（仅服务端 ECHOMIND_ADMINS 成员可调用）
    listCompanies(cfg, opts) {
      return callJson(cfg, '/admin/companies', mergeOpts({ timeoutMs: 15_000, ...opts }));
    },

    addCompany(cfg, { appId, appSecret }, opts) {
      return callJson(cfg, '/admin/companies', mergeOpts({ method: 'POST', body: { appId, appSecret }, timeoutMs: 25_000, ...opts }));
    },

    checkCompany(cfg, id, opts) {
      return callJson(cfg, `/admin/companies/${encodeURIComponent(id)}/check`, mergeOpts({ method: 'POST', timeoutMs: 20_000, ...opts }));
    },

    replaceCompanySecret(cfg, id, appSecret, opts) {
      return callJson(
        cfg,
        `/admin/companies/${encodeURIComponent(id)}/secret`,
        mergeOpts({ method: 'POST', body: { appSecret }, timeoutMs: 25_000, ...opts }),
      );
    },

    toggleCompany(cfg, id, enabled, opts) {
      const action = enabled ? 'enable' : 'disable';
      return callJson(cfg, `/admin/companies/${encodeURIComponent(id)}/${action}`, mergeOpts({ method: 'POST', timeoutMs: 15_000, ...opts }));
    },
  };
}

export const defaultApiClient = createApiClient();
