import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError, MAX_DOWNLOAD_BYTES, defaultApiClient, safeErrorMessage } from './api-client.js';

export const REMOTE_SERVICE_NAME = 'contractSure';

export const PREVIEW_ERRORS = Object.freeze({
  INVALID_REQUEST: '请求参数无效',
  ACCESS_DENIED: '无会话访问权限',
  UNAUTHORIZED: '履约系统账户的授权已失效或过期，请在「设置 → 履约无忧配置」重新连接账户。',
  DOWNLOAD_FAILED: '原件下载失败，请重试',
  TOO_LARGE: '原件文件超过 50MB 预览上限',
  TIMEOUT: '原件下载超时，请重试',
  CANCELLED: '已取消原件加载',
  CACHE_ERROR: '原件缓存无法读取',
  INTERNAL_ERROR: '操作失败，请稍后重试',
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

// 会话资源的访问校验。拿不到宿主 remoteAccess 服务时一律拒绝（服务类已声明 inject remoteAccess）。
async function assertSessionAccess(accessCtx, sessionId) {
  const remoteAccess = typeof accessCtx?.get === 'function' ? accessCtx.get('remoteAccess') : undefined;
  if (typeof remoteAccess?.allows !== 'function') {
    throw new ContractSureRemoteError('ACCESS_DENIED', PREVIEW_ERRORS.ACCESS_DENIED);
  }
  const allowed = await remoteAccess.allows({ kind: 'session', id: sessionId });
  if (!allowed) {
    throw new ContractSureRemoteError('ACCESS_DENIED', PREVIEW_ERRORS.ACCESS_DENIED);
  }
}

// RPC 报错：固定错误码 + 安全文案。ApiError 的文案是插件自己写的固定文案；其他异常一律不回显 message。
function wrapError(error) {
  if (error instanceof ContractSureRemoteError) return error;
  if (error instanceof ApiError) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code) ? error.code : 'API_ERROR';
    return new ContractSureRemoteError(code, safeErrorMessage(error, PREVIEW_ERRORS.INTERNAL_ERROR));
  }
  return new ContractSureRemoteError('INTERNAL_ERROR', PREVIEW_ERRORS.INTERNAL_ERROR);
}

/**
 * Pure Node remote handlers for DSH client UI (settings panel, draft confirmation card, original document preview).
 */
export function createContractSureRemoteHandlers(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const accounts = deps.accounts;
  const cachePath = typeof deps.cachePath === 'function' ? deps.cachePath : defaultCachePath;
  const maxBytes = deps.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const fetchImpl = deps.fetchImpl;
  const confirmDraftFn = deps.confirmDraft;
  const pendingDownloads = new Map();

  if (!accounts) {
    throw new TypeError('createContractSureRemoteHandlers 需要 deps.accounts（账户管理器）。');
  }

  // 约定 C 的授权提示在 RPC 里转成 UNAUTHORIZED 错误，界面照旧按错误处理。
  const backendValue = (result) => {
    if (!result.ok) throw new ContractSureRemoteError('UNAUTHORIZED', result.authRequired.message);
    return result.value;
  };
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      throw wrapError(error);
    }
  };

  return {
    // 接口约定 B：账户与设置。这些方法不触及会话资源，由宿主网关按 global 资源做访问控制。
    getState() {
      return guard(() => accounts.getState());
    },

    saveSettings(patch) {
      return guard(() => accounts.saveSettings(patch));
    },

    testConnection(serverUrl, signal) {
      return guard(() => accounts.testConnection(serverUrl, signal));
    },

    startAuthorization(signal) {
      return guard(() => accounts.startAuthorization(signal));
    },

    pollAuthorization(requestId) {
      return guard(() => accounts.pollAuthorization(requestId));
    },

    cancelAuthorization(requestId) {
      return guard(() => accounts.cancelAuthorization(requestId));
    },

    setActiveAccount(accountId) {
      return guard(() => accounts.setActiveAccount(accountId));
    },

    disconnectAccount(accountId) {
      return guard(() => accounts.disconnectAccount(accountId));
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
        const result = await accounts.withBackend((cfg, backend) =>
          confirmDraftFn({ sessionId, draftId, draft: editedDraft, signal, cfg, backend }),
        );
        return backendValue(result);
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

      // 先确认当前履约账户，再看缓存：缓存按「服务器 + 账户 + 会话」分开，切换或断开账户后不会拿到别的账户下载的原件。
      let resolved;
      try {
        resolved = await accounts.resolveBackend();
      } catch (error) {
        throw wrapError(error);
      }
      const cfg = backendValue(resolved.ok ? { ok: true, value: resolved.cfg } : resolved);
      if (signal?.aborted) {
        throw new ContractSureRemoteError('CANCELLED', PREVIEW_ERRORS.CANCELLED);
      }

      const displayName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : `document-${numericDocId}.pdf`;
      const safeName = safeOriginalFilename(displayName);
      const cacheScope = hash([cfg.serverUrl, cfg.accountId, sessionId]);
      const absolutePath = cachePath('contract-sure', cacheScope, String(numericDocId), safeName);
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

      let entry = pendingDownloads.get(absolutePath);
      if (!entry) {
        const controller = new AbortController();
        entry = { controller, consumers: new Set() };
        pendingDownloads.set(absolutePath, entry);
        entry.promise = accounts
          .runBackend(cfg, () =>
            apiClient.downloadDocumentToCache(cfg, numericDocId, absolutePath, controller.signal, {
              maxBytes,
              ...(fetchImpl ? { fetchImpl } : {}),
            }),
          )
          .then(backendValue)
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

    // RPC 方法形参名即 args 键名；不用默认值、解构、剩余参数，最后一个形参叫 signal。
    async getState(signal) {
      try {
        return await handlers.getState();
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async saveSettings(patch, signal) {
      try {
        return await handlers.saveSettings(patch);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async testConnection(serverUrl, signal) {
      try {
        return await handlers.testConnection(serverUrl, signal);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async startAuthorization(signal) {
      try {
        return await handlers.startAuthorization(signal);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async pollAuthorization(requestId, signal) {
      try {
        return await handlers.pollAuthorization(requestId);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async cancelAuthorization(requestId, signal) {
      try {
        return await handlers.cancelAuthorization(requestId);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async setActiveAccount(accountId, signal) {
      try {
        return await handlers.setActiveAccount(accountId);
      } catch (error) {
        throw toRemoteError(error);
      }
    }

    async disconnectAccount(accountId, signal) {
      try {
        return await handlers.disconnectAccount(accountId);
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

  decorate('getState');
  decorate('saveSettings');
  decorate('testConnection');
  decorate('startAuthorization');
  decorate('pollAuthorization');
  decorate('cancelAuthorization');
  decorate('setActiveAccount');
  decorate('disconnectAccount');
  decorate('confirmDraft', { resources: { session: (sessionId) => sessionId } });
  decorate('cacheOriginalDocument', { resources: { session: (sessionId) => sessionId } });

  ctx.plugin(ContractSureService);
  return { serviceClass: ContractSureService, handlers };
}
