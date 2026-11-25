import { ApiError, safeErrorMessage } from './api-client.js';

// 宿主 RPC 服务「salesforge」：设置页、插件页和对话授权卡片通过
// connection.rpc.call("/api", "salesforge/<方法>", { args }, signal) 调用这里的方法。
export const REMOTE_SERVICE_NAME = 'salesforge';

const INTERNAL_ERROR_MESSAGE = '操作失败，请稍后重试';

export class SalesforgeRemoteError extends Error {
  constructor(code, message) {
    super(message || INTERNAL_ERROR_MESSAGE);
    this.name = 'SalesforgeRemoteError';
    this.code = code || 'INTERNAL_ERROR';
  }
}

// RPC 报错：固定错误码 + 安全文案。ApiError 的文案是插件自己写的固定文案；其他异常一律不回显 message。
function wrapError(error) {
  if (error instanceof SalesforgeRemoteError) return error;
  if (error instanceof ApiError) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code) ? error.code : 'API_ERROR';
    return new SalesforgeRemoteError(code, safeErrorMessage(error, INTERNAL_ERROR_MESSAGE));
  }
  return new SalesforgeRemoteError('INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
}

/** 不依赖宿主的 RPC 处理函数，单测直接调用。 */
export function createSalesforgeRemoteHandlers(deps = {}) {
  const accounts = deps.accounts;
  if (!accounts) {
    throw new TypeError('createSalesforgeRemoteHandlers 需要 deps.accounts（账户管理器）。');
  }
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      throw wrapError(error);
    }
  };

  // 这些方法不触及会话资源，由宿主网关按 global 资源做访问控制。
  return {
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
  };
}

/**
 * 宿主提供 @deepseek-ai/dsh-typert-protocol 时注册 TypertRemoteService（"salesforge"）。
 */
export function registerSalesforgeRemote(ctx, deps = {}) {
  const { TypertRemoteService, Remote, RemoteError } = deps;
  const handlers = createSalesforgeRemoteHandlers(deps);

  if (!TypertRemoteService || !Remote || !RemoteError || typeof ctx?.plugin !== 'function') {
    return { serviceClass: null, handlers };
  }

  const toRemoteError = (error) => {
    const safe = wrapError(error);
    return new RemoteError(safe.code, safe.message, {});
  };

  const initializers = [];
  class SalesforgeService extends TypertRemoteService {
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
  }

  // 没有 name / mode / resources 选项的方法直接用二元调用 Remote(method, context)，不能传 Remote({})。
  for (const methodName of [
    'getState',
    'saveSettings',
    'testConnection',
    'startAuthorization',
    'pollAuthorization',
    'cancelAuthorization',
    'setActiveAccount',
    'disconnectAccount',
  ]) {
    Remote(SalesforgeService.prototype[methodName], {
      kind: 'method',
      name: methodName,
      static: false,
      private: false,
      addInitializer(init) {
        initializers.push(init);
      },
    });
  }

  ctx.plugin(SalesforgeService);
  return { serviceClass: SalesforgeService, handlers };
}
