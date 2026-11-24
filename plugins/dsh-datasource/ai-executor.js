import { createHash, randomUUID } from 'node:crypto';
import { categories, fail, object } from './selection-flow.js';
import { auxiliaryPrompt } from './task-prompts.js';

export const PAGE_SIZE = 20;
export const SAMPLE_SIZE = 2;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = message => Object.assign(new Error(message), { publicMessage: message, status: 409 });
const checkSignal = signal => { if (signal?.aborted) fail('本次调用已取消。', 409); };

/** DSH sessions and tool protocol. Business snapshots and commits stay in flow. */
export class DatasourceAiExecutor {
  constructor({ bridge, callbacks }) {
    this.bridge = bridge;
    this.callbacks = callbacks;
    this.sessions = new Map();
  }

  hasSession(sessionId) { return this.sessions.has(sessionId); }

  async run(operation, cwd) {
    let rejectDone;
    const done = new Promise((resolveDone, reject) => { operation.resolve = resolveDone; rejectDone = reject; });
    done.catch(() => {});
    operation.reject = cause => {
      if (operation.committed) return;
      if (operation.submitting) {
        operation.pendingError ??= cause;
        return;
      }
      operation.failure ??= cause;
      rejectDone(operation.failure);
    };
    const signal = operation.controller.signal;
    const aborted = () => operation.reject(error('操作已取消或超时。'));
    signal.addEventListener('abort', aborted, { once: true });
    try {
      const { sessionId } = await this.bridge.create({ cwd });
      operation.sessionId = sessionId;
      this.sessions.set(sessionId, operation);
      operation.report?.({ sessionId });
      const bound = await this.callbacks.bindSession(sessionId, { sourceId: operation.id, connectionVersion: operation.source.connectionVersion, retired: signal.aborted });
      if (bound === false) fail('数据源状态已更新，本次会话已失效。', 409);
      this.callbacks.assertOperation(operation);
      operation.cleanup = await this.bridge.observe({ sessionId, signal, onEnd: cause => operation.reject(cause || error('会话已结束，未提交有效结果。')) });
      await this.callbacks.assertSession(operation);
      // Sending may remain pending after the business transaction commits. Its
      // rejection is consumed, while the committed result owns task completion.
      Promise.resolve().then(() => this.bridge.send({ sessionId, requestId: randomUUID(), text: auxiliaryPrompt(operation), signal })).catch(operation.reject);
      return await done;
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  }

  async finish(operation) {
    if (operation.sessionId) this.sessions.delete(operation.sessionId);
    await operation.cleanup?.().catch(() => {});
    if (operation.sessionId && !operation.committed) await this.bridge.cancel(operation.sessionId).catch(() => {});
  }

  async task(input, execution) {
    const task = input?.operation;
    const keys = { read: ['cursor'], sample: ['tableIds'], submit: ['result'], fail: [] };
    if (typeof task !== 'string' || !Object.hasOwn(keys, task)) fail('operation 必须是 read、sample、submit 或 fail。');
    object(input, ['operation', ...keys[task]], '工具输入');
    const signal = execution?.signal;
    checkSignal(signal);
    const operation = this.sessions.get(execution?.agent?.session?.id);
    if (!operation) fail('此工具仅接受当前接入会话的调用。', 409);
    if (task === 'submit') return this._submit(operation, input.result, signal);
    if (operation.committed) fail('本次结果已保存。', 409);
    await this.callbacks.assertSession(operation, signal);
    switch (task) {
      case 'read': return this._read(operation, input.cursor);
      case 'sample': return this.callbacks.sample(operation, input.tableIds, signal);
      case 'fail':
        operation.reject(error('未能形成有效结果，请查看会话后重试。'));
        return { ok: false };
    }
  }

  _read(operation, cursor = 0) {
    const tables = [...operation.tables.values()];
    const pageCount = Math.ceil(tables.length / PAGE_SIZE);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= pageCount) fail('分页游标无效。');
    operation.pages.add(cursor);
    const { id, name, engine } = operation.source;
    return structuredClone({
      source: { id, name, engine },
      kind: operation.kind,
      snapshotId: operation.state.catalog.id,
      questions: cursor === 0 ? (operation.questions ?? []).map(({ id, text, answer, origin = 'unknown', sourceQuestionId = null }) => ({ id, text, answer, ...(operation.kind === 'generalize-question' ? { origin, sourceQuestionId } : {}) })) : [],
      ...(operation.kind === 'generalize-question' ? {
        originalAnalysisQuestions: cursor === 0 ? operation.originalAnalysisQuestions.map(({ id, text, answer }) => ({ id, text, answer })) : [],
        habitQuestions: cursor === 0 ? operation.allQuestions.filter(item => item.origin === 'original' && !operation.questions.some(reference => reference.id === item.id)).map(({ id, text, answer }) => ({ id, text, answer })) : [],
        existingQuestions: cursor === 0 ? operation.allQuestions.map(({ id, text }) => ({ id, text })) : [],
      } : {}),
      domains: cursor === 0 ? operation.domains ?? [] : [],
      tables: tables.slice(cursor * PAGE_SIZE, (cursor + 1) * PAGE_SIZE),
      cursor,
      nextCursor: cursor + 1 < pageCount ? cursor + 1 : null,
    });
  }

  async _submit(operation, result, signal) {
    this.callbacks.assertOperation(operation);
    const detecting = operation.kind === 'detect-domains';
    const generalizing = operation.kind === 'generalize-question';
    const verified = this.callbacks.verify(operation, result);
    const payloadHash = hash(detecting ? [verified.domains, [...verified.classifications]] : verified);
    if (!operation.committed) await this.callbacks.assertSession(operation, signal);
    if (operation.committed || operation.submitPromise) {
      await operation.submitPromise;
      if (operation.committed && operation.payloadHash === payloadHash) return { ok: true, ...(generalizing ? { originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false } : { persisted: true }), duplicate: true };
      fail('本次结果已保存，不能覆盖。', 409);
    }
    if (operation.pages.size !== Math.ceil(operation.tables.size / PAGE_SIZE)) fail('请先读完全部目录页。');
    operation.submitting = true;
    operation.submitPromise = this.callbacks.commit(operation, verified, signal, payloadHash);
    try {
      await operation.submitPromise;
      return { ok: true, ...(generalizing ? { originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false } : { persisted: true }) };
    } finally {
      operation.submitting = false;
      if (!operation.committed) {
        operation.submitPromise = null;
        if (operation.pendingError) operation.reject(operation.pendingError);
      }
    }
  }

  getTool() {
    const string = { type: 'string' };
    const strings = { type: 'array', items: string };
    const rows = properties => ({ type: 'array', items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } });
    const analysisRows = rows({ questionId: string, links: rows({ tableId: string, fields: strings, reason: string }) });
    return {
      name: 'datasource_task',
      description: '读取当前数据源接入会话的全部目录、问题及泛化参考，辅助选表或问题泛化时可按需读取普通表的限量样例，并提交结构化结果。read 按 nextCursor 读完后 submit，无法完成用 fail。',
      parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
        operation: { type: 'string', enum: ['read', 'sample', 'submit', 'fail'] },
        cursor: { type: 'integer', minimum: 0 },
        tableIds: { ...strings, minItems: 1, maxItems: SAMPLE_SIZE },
        result: { type: 'object', additionalProperties: false, properties: {
          candidates: { ...rows({ text: string, answer: { type: 'string', enum: [''] }, links: { ...rows({ tableId: string, fields: { ...strings, minItems: 1 }, reason: string }), minItems: 1 } }), minItems: 1, maxItems: 20 },
          reason: string,
          domains: rows({ name: string, description: string }),
          classifications: rows({ tableId: string, category: { ...string, enum: categories }, domain: string, reason: string }),
          recommendations: rows({ tableId: string, reason: string }),
          analyses: analysisRows,
          originalAnalyses: analysisRows,
        } },
      } },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 60_000,
      execute: (input, execution) => this.task(input, execution),
    };
  }

  close() { return this.bridge.close(); }
}
