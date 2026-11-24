import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, saveConfig, resolveConfigPath } from './config-store.js';
import { ApiError, MAX_DOWNLOAD_BYTES, defaultApiClient } from './api-client.js';

export const REMOTE_SERVICE_NAME = 'contractSure';

export const PREVIEW_ERRORS = Object.freeze({
  INVALID_REQUEST: '请求参数无效',
  ACCESS_DENIED: '无会话访问权限',
  UNAUTHORIZED: '认证失败或令牌已过期，请先在「设置 → 履约无忧配置」重新配置。',
  DOWNLOAD_FAILED: '原件下载失败，请重试',
  TOO_LARGE: '原件文件超过 50MB 预览上限',
  TIMEOUT: '原件下载超时，请重试',
  CANCELLED: '已取消原件加载',
  CACHE_ERROR: '原件缓存无法读取',
});

export class ContractSureRemoteError extends Error {
  constructor(code, message) {
    super(message || PREVIEW_ERRORS[code] || '操作失败');
    this.name = 'ContractSureRemoteError';
    this.code = code || 'INTERNAL_ERROR';
  }
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function safeOriginalFilename(name) {
  const cleaned = String(name || 'document')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_')
    .replace(/[. ]+$/u, '');
  const extension = extname(cleaned).slice(0, 32);
  let stem = cleaned.slice(0, cleaned.length - extname(cleaned).length).slice(0, 140) || 'document';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) {
    stem = `_${stem}`;
  }
  return stem + extension;
}

function defaultCachePath(...segments) {
  return join(tmpdir(), 'dsh-cache', ...segments);
}

async function assertSessionAccess(accessCtx, sessionId) {
  const remoteAccess =
    typeof accessCtx?.get === 'function' ? accessCtx.get('remoteAccess') : accessCtx?.remoteAccess;
  if (!remoteAccess?.allows) return;
  const allowed = await remoteAccess.allows({ kind: 'session', id: sessionId });
  if (!allowed) {
    throw new ContractSureRemoteError('ACCESS_DENIED', PREVIEW_ERRORS.ACCESS_DENIED);
  }
}

function wrapError(error) {
  if (error instanceof ContractSureRemoteError) return error;
  if (error instanceof ApiError) {
    return new ContractSureRemoteError(String(error.code || 'API_ERROR'), error.message);
  }
  return new ContractSureRemoteError('INTERNAL_ERROR', error?.message || '请求执行失败');
}

/**
 * Pure Node remote handlers for DSH client UI (settings panel, draft confirmation card, original document preview).
 */
export function createContractSureRemoteHandlers(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const cachePath = typeof deps.cachePath === 'function' ? deps.cachePath : defaultCachePath;
  const configOptions = { ctx, configPath: deps.configPath };
  const maxBytes = deps.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const fetchImpl = deps.fetchImpl;
  const confirmDraftFn = deps.confirmDraft;
  const pendingDownloads = new Map();

  return {
    async getConfig() {
      const cfg = loadConfig(configOptions);
      return {
        ...cfg,
        ocrApiKeyEnvSet: Boolean((process.env.DEEPSEEK_API_KEY || '').trim()),
        configPath: resolveConfigPath(configOptions),
      };
    },

    async saveConfig(patch) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new ContractSureRemoteError('INVALID_REQUEST', '配置参数格式无效。');
      }
      const saved = saveConfig(patch, configOptions);
      return {
        ok: true,
        config: saved,
        configPath: resolveConfigPath(configOptions),
      };
    },

    async testConnection(patch, signal) {
      const current = loadConfig(configOptions);
      const merged =
        patch && typeof patch === 'object' && !Array.isArray(patch)
          ? {
              serverUrl: patch.serverUrl?.trim() || current.serverUrl,
              apiToken: patch.apiToken !== undefined ? String(patch.apiToken).trim() : current.apiToken,
              ocrApiUrl: patch.ocrApiUrl?.trim() || current.ocrApiUrl,
              ocrApiKey: patch.ocrApiKey !== undefined ? String(patch.ocrApiKey).trim() : current.ocrApiKey,
            }
          : current;
      try {
        const user = await apiClient.getMe(merged, { signal, ...(fetchImpl ? { fetchImpl } : {}) });
        return {
          ok: true,
          connected: true,
          serverUrl: merged.serverUrl,
          user,
        };
      } catch (error) {
        const wrapped = wrapError(error);
        return {
          ok: false,
          connected: false,
          serverUrl: merged.serverUrl,
          code: wrapped.code,
          error: wrapped.message,
        };
      }
    },

    async loginToken(serverUrl, username, password, ttlDays = 90, signal) {
      if (!username || !password) {
        throw new ContractSureRemoteError('INVALID_REQUEST', '请输入用户名和密码。');
      }
      const current = loadConfig(configOptions);
      const targetUrl = typeof serverUrl === 'string' && serverUrl.trim() ? serverUrl.trim() : current.serverUrl;
      const days = Number.isFinite(Number(ttlDays)) ? Math.min(365, Math.max(1, Math.round(Number(ttlDays)))) : 90;
      try {
        const result = await apiClient.exchangePluginToken(
          { serverUrl: targetUrl, username: String(username).trim(), password: String(password), ttlDays: days },
          { signal, ...(fetchImpl ? { fetchImpl } : {}) },
        );
        if (!result?.token) {
          throw new ContractSureRemoteError('AUTH_FAILED', '后端未返回长期访问令牌。');
        }
        const saved = saveConfig({ serverUrl: targetUrl, apiToken: result.token }, configOptions);
        return {
          ok: true,
          token: result.token,
          userId: result.userId ?? null,
          username: result.username ?? String(username).trim(),
          realName: result.realName ?? '',
          expiresInDays: result.expiresInDays ?? days,
          serverUrl: saved.serverUrl,
        };
      } catch (error) {
        throw wrapError(error);
      }
    },

    async confirmDraft(sessionId, draftId, editedDraft, signal, accessCtx = ctx) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new ContractSureRemoteError('INVALID_REQUEST', '缺少有效的会话标识（sessionId）。');
      }
      if (!draftId && (!editedDraft || typeof editedDraft !== 'object')) {
        throw new ContractSureRemoteError('INVALID_REQUEST', '请提供草稿标识（draftId）或合同数据。');
      }
      await assertSessionAccess(accessCtx, sessionId);
      if (typeof confirmDraftFn !== 'function') {
        throw new ContractSureRemoteError('NOT_CONFIGURED', '草稿确认服务未初始化。');
      }
      try {
        return await confirmDraftFn({
          sessionId,
          draftId,
          draft: editedDraft,
          signal,
        });
      } catch (error) {
        throw wrapError(error);
      }
    },

    async cacheOriginalDocument(sessionId, docId, fileName, signal, accessCtx = ctx) {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new ContractSureRemoteError('INVALID_REQUEST', PREVIEW_ERRORS.INVALID_REQUEST);
      }
      const numericDocId = Number(docId);
      if (!Number.isInteger(numericDocId) || numericDocId <= 0) {
        throw new ContractSureRemoteError('INVALID_REQUEST', '文档 ID 无效。');
      }
      if (signal?.aborted) {
        throw new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED);
      }
      await assertSessionAccess(accessCtx, sessionId);
      if (signal?.aborted) {
        throw new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED);
      }

      const displayName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : `document-${numericDocId}.pdf`;
      const safeName = safeOriginalFilename(displayName);
      const absolutePath = cachePath('contract-sure', hash(sessionId), String(numericDocId), safeName);
      const result = { sessionId, absolutePath, documentName: displayName };

      try {
        const cached = await lstat(absolutePath);
        if (signal?.aborted) throw new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED);
        if (!cached.isFile()) throw new ContractSureRemoteError('CACHE_ERROR', PREVIEW_ERRORS.CACHE_ERROR);
        if (cached.size > 0 && cached.size <= maxBytes) return result;
      } catch (error) {
        if (error instanceof ContractSureRemoteError) throw error;
        if (error?.code !== 'ENOENT') {
          throw new ContractSureRemoteError('CACHE_ERROR', PREVIEW_ERRORS.CACHE_ERROR);
        }
      }

      if (signal?.aborted) {
        throw new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED);
      }

      const cfg = loadConfig(configOptions);
      let entry = pendingDownloads.get(absolutePath);
      if (!entry) {
        const controller = new AbortController();
        entry = { controller, consumers: new Set() };
        pendingDownloads.set(absolutePath, entry);
        entry.promise = Promise.resolve()
          .then(() =>
            apiClient.downloadDocumentToCache(cfg, numericDocId, absolutePath, controller.signal, {
              maxBytes,
              ...(fetchImpl ? { fetchImpl } : {}),
            }),
          )
          .finally(() => {
            if (pendingDownloads.get(absolutePath) === entry) {
              pendingDownloads.delete(absolutePath);
            }
          });
      }

      return new Promise((resolve, reject) => {
        const consumer = {};
        entry.consumers.add(consumer);
        const release = () => {
          signal?.removeEventListener('abort', cancel);
          entry.consumers.delete(consumer);
        };
        const cancel = () => {
          release();
          if (!entry.consumers.size) {
            if (pendingDownloads.get(absolutePath) === entry) pendingDownloads.delete(absolutePath);
            entry.controller.abort();
          }
          reject(new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED));
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        entry.promise.then(
          () => {
            release();
            resolve(result);
          },
          (error) => {
            release();
            reject(wrapError(error));
          },
        );
      });
    },
  };
}

/**
 * Registers the TypertRemoteService ("contractSure") when @deepseek-ai/dsh-typert-protocol is available.
 */
export function registerContractSureRemote(ctx, deps = {}) {
  const { TypertRemoteService, Remote, RemoteError, dshCachePath } = deps;
  const handlers = createContractSureRemoteHandlers(ctx, {
    ...deps,
    cachePath: deps.cachePath || dshCachePath || defaultCachePath,
  });

  if (!TypertRemoteService || !Remote || !RemoteError || typeof ctx?.plugin !== 'function') {
    return { serviceClass: null, handlers };
  }

  const toRemoteError = (error) => {
    const safe = wrapError(error);
    return new RemoteError(safe.code, safe.message, {});
  };

  const initializers = [];
  class ContractSureService extends TypertRemoteService {
    static inject = ['remoteAccess'];

    constructor(serviceCtx) {
      super(serviceCtx, REMOTE_SERVICE_NAME);
      for (const init of initializers) init.call(this);
    }

    async getConfig() {
      try {
        return await handlers.getConfig();
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async saveConfig(patch) {
      try {
        return await handlers.saveConfig(patch);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async testConnection(patch, signal) {
      try {
        return await handlers.testConnection(patch, signal);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async loginToken(serverUrl, username, password, ttlDays, signal) {
      try {
        return await handlers.loginToken(serverUrl, username, password, ttlDays, signal);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async confirmDraft(sessionId, draftId, editedDraft, signal) {
      try {
        return await handlers.confirmDraft(sessionId, draftId, editedDraft, signal, this.ctx);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async cacheOriginalDocument(sessionId, docId, fileName, signal) {
      try {
        return await handlers.cacheOriginalDocument(sessionId, docId, fileName, signal, this.ctx);
      } catch (error) {
        throw toRemoteError(error);
      }
    }
  }

  const decorate = (methodName, meta) => {
    const context = {
      kind: 'method',
      name: methodName,
      static: false,
      private: false,
      addInitializer(init) {
        initializers.push(init);
      },
    };
    if (meta && Object.keys(meta).length > 0) {
      Remote(meta)(ContractSureService.prototype[methodName], context);
    } else {
      Remote(ContractSureService.prototype[methodName], context);
    }
  };

  decorate('getConfig');
  decorate('saveConfig');
  decorate('testConnection');
  decorate('loginToken');
  decorate('confirmDraft', { resources: { session: (sessionId) => sessionId } });
  decorate('cacheOriginalDocument', { resources: { session: (sessionId) => sessionId } });

  ctx.plugin(ContractSureService);
  return { serviceClass: ContractSureService, handlers };
}
