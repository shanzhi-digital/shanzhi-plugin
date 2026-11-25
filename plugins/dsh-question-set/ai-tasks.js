import { randomUUID } from 'node:crypto';

const active = task => task.status === 'running' || task.status === 'cancelling';
const failure = (message, status = 400, extra = {}) => Object.assign(new Error(message), { publicMessage: message, status, ...extra });

/** Process-owned execution; HTTP callers only observe detached snapshots. */
export class AiTasks {
  constructor({ execute, identify, validate = () => {}, now = Date.now, retentionMs = 3600000, maxCompleted = 200 }) {
    this.execute = execute;
    this.identify = identify;
    this.validate = validate;
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxCompleted = maxCompleted;
    this.tasks = new Map();
    this.sources = new Map();
    this.closed = false;
  }

  _prune() {
    const completed = [...this.tasks.values()].filter(task => !active(task)).sort((a, b) => b.finished - a.finished);
    for (const [index, task] of completed.entries()) {
      if (this.now() - task.finished < this.retentionMs && index < this.maxCompleted) continue;
      this.tasks.delete(task.taskId);
      if (this.sources.get(task.sourceId) === task.taskId) this.sources.delete(task.sourceId);
    }
  }

  _view(task) {
    const { taskId, sourceId, kind, status, startedAt, finishedAt, sessionId, result, error, progress } = task;
    return structuredClone({ taskId, sourceId, kind, status, startedAt, finishedAt, sessionId, result, error, progress });
  }

  start(input) {
    if (this.closed) throw failure('AI 任务服务已关闭。', 503);
    this._prune();
    this.validate(input);
    const { sourceId, kind } = this.identify(input);
    if (typeof sourceId !== 'string' || !sourceId.trim() || typeof kind !== 'string' || !kind) throw failure('AI 任务参数无效。');
    const previous = this.tasks.get(this.sources.get(sourceId));
    if (previous && active(previous)) throw failure('该数据源已有 AI 任务。', 409, { taskId: previous.taskId });
    const task = {
      taskId: randomUUID(), sourceId, kind, status: 'running', startedAt: new Date(this.now()).toISOString(), finishedAt: null,
      sessionId: null, result: null, error: null, progress: { phase: 'reading', completed: 0, total: null, success: 0, failed: 0 }, controller: new AbortController(),
    };
    const snapshot = structuredClone(input);
    this.tasks.set(task.taskId, task);
    this.sources.set(sourceId, task.taskId);
    const report = update => {
      if (!active(task)) return;
      if (typeof update?.sessionId === 'string') task.sessionId = update.sessionId;
      if (update && Object.hasOwn(update, 'result')) task.result = structuredClone(update.result);
      if (update?.progress) task.progress = structuredClone(update.progress);
    };
    task.done = Promise.resolve().then(() => this.execute(snapshot, task.controller.signal, report, task.taskId)).then(result => {
      // A fulfilled executor has committed, even if cancellation raced that commit.
      task.result = result === undefined ? null : structuredClone(result);
      task.status = 'succeeded';
    }).catch(cause => {
      task.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
      task.error = { message: typeof cause?.publicMessage === 'string' ? cause.publicMessage : task.status === 'cancelled' ? 'AI 任务已取消。' : 'AI 任务执行失败，请重试。' };
      if (typeof cause?.sessionId === 'string') task.sessionId = cause.sessionId;
    }).finally(() => {
      task.finished = this.now();
      task.finishedAt = new Date(task.finished).toISOString();
      this._prune();
    });
    return this._view(task);
  }

  get(taskId) {
    this._prune();
    const task = this.tasks.get(taskId);
    if (!task) throw failure('AI 任务不存在或已过期，请刷新业务数据。', 404);
    return this._view(task);
  }

  latest(sourceId) {
    this._prune();
    const task = this.tasks.get(this.sources.get(sourceId));
    return task ? this._view(task) : null;
  }

  cancel(taskId) {
    this.get(taskId);
    const task = this.tasks.get(taskId);
    if (task.status === 'running') {
      task.status = 'cancelling';
      task.controller.abort();
    }
    return this._view(task);
  }

  async close() {
    this.closed = true;
    const running = [...this.tasks.values()].filter(active);
    for (const task of running) this.cancel(task.taskId);
    await Promise.all(running.map(task => task.done));
  }
}
