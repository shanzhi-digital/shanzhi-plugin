import { isAbsolute } from 'node:path';

// Host services, not Client ctx.sessions / RemoteResult wrappers.
export const injectKeys = Object.freeze(['sessionController', 'sessions', 'agents']);

class SessionBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatasourceSessionError';
    this.code = code;
    this.publicMessage = message;
  }
}

function failure(code, message) { return new SessionBridgeError(code, message); }
function identity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('SESSION_INVALID_INPUT', label + '无效。');
  }
  return value;
}
function sanitize(error, code, message) {
  // Never promote an arbitrary Host error's message/publicMessage/cause to UI.
  return error instanceof SessionBridgeError ? error : failure(code, message);
}

/**
 * Installed rc.5 Host session bridge. The caller persists run/batch/sessionId
 * before send(); this class does not own authorization or business completion.
 * Prompt admission, durable session flush, and structured tool commit are
 * separate milestones. An uncertain send must not be automatically replayed.
 */
export class DatasourceSessionBridge {
  #ctx;
  #closed = false;

  constructor(ctx) {
    if (!ctx || !['create', 'prompt', 'resolveAgent', 'cancel'].every((name) => typeof ctx.sessionController?.[name] === 'function') ||
        typeof ctx.sessions?.flush !== 'function' || typeof ctx.sessions?.get !== 'function' || typeof ctx.agents?.get !== 'function') {
      throw failure('SESSION_SERVICE_UNAVAILABLE', '后台会话服务尚未就绪。');
    }
    this.#ctx = ctx;
  }

  #open() {
    if (this.#closed) throw failure('SESSION_BRIDGE_CLOSED', '后台会话服务已关闭。');
  }

  async create({ cwd } = {}) {
    this.#open();
    if (typeof cwd !== 'string' || !cwd.trim() || /[\u0000-\u001f\u007f]/.test(cwd) || !isAbsolute(cwd)) {
      throw failure('SESSION_INVALID_INPUT', '请指定后台会话的绝对工作目录。');
    }
    try {
      // Do not call low-level sessions.create: it does not start an Agent or
      // attach persistence. Do not selectModel: that also saves a global default.
      const created = await this.#ctx.sessionController.create({ cwd });
      const sessionId = identity(created?.sessionId, '后台会话标识');
      // Return the actual Host identity immediately for durable caller binding.
      // Optional title is deliberately not renamed here: rename could fail after
      // creation and hide a live identity before the caller has persisted it.
      return { sessionId };
    } catch (error) {
      throw sanitize(error, 'SESSION_CREATE_FAILED', '无法创建后台会话，请稍后重试。');
    }
  }

  async send({ sessionId, requestId, text } = {}) {
    this.#open();
    identity(sessionId, '后台会话标识');
    identity(requestId, '后台消息标识');
    if (typeof text !== 'string' || !text.trim() || text.includes('\u0000')) {
      throw failure('SESSION_INVALID_INPUT', '后台消息内容不能为空或包含无效字符。');
    }
    try {
      const admitted = await this.#ctx.sessionController.prompt({
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }],
      });
      if (admitted?.accepted !== true) {
        throw failure('SESSION_ADMISSION_FAILED', '后台会话未受理消息。');
      }
      // The Host prompt API returns admission only; its implementation does not
      // itself await the session persistence barrier. resolveAgent returns a
      // discriminated {agent}|{error}, not the raw Agent.
      const found = await this.#ctx.sessionController.resolveAgent(sessionId);
      if (!found || 'error' in found || found.agent?.session?.id !== sessionId) {
        throw failure('SESSION_UNAVAILABLE', '后台会话暂不可用，消息是否持久化尚未确认。');
      }
      const flushed = await this.#ctx.sessions.flush(found.agent.session);
      if (flushed !== true) {
        throw failure('SESSION_PERSISTENCE_UNAVAILABLE', '后台会话未获得持久化确认，请查看任务状态。');
      }
      return { accepted: true };
    } catch (error) {
      throw sanitize(error, 'SESSION_SEND_FAILED', '后台消息发送或持久化确认失败，请查看任务状态。');
    }
  }

  /**
   * Observes live services without activating a cold session or reading chats.
   * Native AgentStatus is only running|idle. Neither means business success.
   * missing means no live Agent/Session is attached; durable history may exist.
   * An unavailable/unknown status is left to the caller's timeout policy.
   */
  async status(sessionId) {
    this.#open();
    identity(sessionId, '后台会话标识');
    try {
      const agent = this.#ctx.agents.get(sessionId);
      if (agent !== undefined) {
        return agent.status === 'running' || agent.status === 'idle' ? agent.status : 'unknown';
      }
      return this.#ctx.sessions.get(sessionId) === undefined ? 'missing' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async cancel(sessionId) {
    this.#open();
    identity(sessionId, '后台会话标识');
    try {
      // Installed controller cancels the current turn with keepInbox:true.
      // Caller must first mark its run cancelled and reject late tool commits.
      const result = await this.#ctx.sessionController.cancel({ sessionId });
      if (result?.accepted !== true) throw failure('SESSION_CANCEL_FAILED', '后台会话未确认取消请求。');
      return { accepted: true };
    } catch (error) {
      throw sanitize(error, 'SESSION_CANCEL_FAILED', '无法取消后台会话，请查看任务状态。');
    }
  }

  async close() {
    // No listeners, polling timers, Agents or user sessions are owned here.
    // An already admitted message can still run after this bridge is closed.
    this.#closed = true;
  }
}
