import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { annotationPrompt } from './task-prompts.js';

const fail = message => { throw Object.assign(new Error(message), { publicMessage: message, status: 409 }); };
const key = (kind, item) => JSON.stringify(kind === 'table' ? [item.tableId] : [item.tableId, item.fieldName]);
const validText = value => typeof value === 'string' && value.trim().length > 0;

export class AnnotationFlow {
  constructor({ service, bridge, defaultCwd = process.cwd(), timeoutMs = 15 * 60 * 1000 }) {
    this.service = service;
    this.bridge = bridge;
    this.defaultCwd = resolve(defaultCwd);
    this.timeoutMs = timeoutMs;
    this.operations = new Map();
    this.sessions = new Map();
    this.closed = false;
  }

  validate(input) {
    if (!input || !validText(input.sourceId) || !validText(input.revision) || !['table', 'field'].includes(input.kind) || !Array.isArray(input.items) || !input.items.length) throw Object.assign(new Error('标注任务参数无效。'), { status: 400 });
    for (const item of input.items) {
      if (!item || !validText(item.tableId) || (input.kind === 'field' && !validText(item.fieldName)) || (input.kind === 'table' && item.fieldName !== undefined)) throw Object.assign(new Error('标注对象无效。'), { status: 400 });
    }
  }

  async run(input, signal, report = () => {}) {
    if (this.closed) fail('标注服务已关闭。');
    this.validate(input);
    if (this.operations.has(input.sourceId)) fail('该数据源已有标注任务。');
    const op = { sourceId: input.sourceId, revision: input.revision, kind: input.kind, controller: new AbortController() };
    let finished;
    op.finished = new Promise(resolveDone => { finished = resolveDone; });
    this.operations.set(op.sourceId, op);
    const abort = () => {
      if (op.committed) return;
      op.controller.abort();
      if (op.sessionId && !op.submitting) void Promise.resolve(this.service.retireSession(op.sessionId)).catch(() => {});
      op.reject?.(Object.assign(new Error('标注任务已取消或超时。'), { publicMessage: '标注任务已取消或超时。' }));
    };
    op.abort = abort;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const catalog = await this.service.catalog(op.sourceId);
      this._active(op);
      if (catalog.revision !== op.revision) fail('数据已更新，请重新加载。');
      const tables = new Map(catalog.tables.map(table => [table.id, table]));
      op.selected = new Map();
      const requested = new Set();
      for (const item of input.items) {
        if (!item || !validText(item.tableId) || (op.kind === 'field' && !validText(item.fieldName)) || (op.kind === 'table' && item.fieldName !== undefined)) fail('标注对象无效。');
        const table = tables.get(item.tableId);
        const target = op.kind === 'table' ? table : table?.fields.find(field => field.name === item.fieldName);
        const id = key(op.kind, item);
        if (!target || (op.kind === 'field' && !target.enabled) || requested.has(id)) fail('标注对象不存在、已停用或重复。');
        requested.add(id);
        if (target.annotation?.status === 'confirmed') continue;
        op.selected.set(id, { table, target, item: op.kind === 'table' ? { tableId: table.id } : { tableId: table.id, fieldName: target.name } });
      }
      if (!op.selected.size) fail('没有可标注的对象。');
      let resolveDone, rejectDone;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      done.catch(() => {});
      op.reject = cause => {
        if (op.committed) return;
        if (op.submitting) { op.pendingError ??= cause; return; }
        op.failure ??= cause;
        rejectDone(op.failure);
      };
      op.resolve = resolveDone;
      const { sessionId } = await this.bridge.create({ cwd: this.defaultCwd });
      op.sessionId = sessionId;
      report({ sessionId });
      const bound = await this.service.bindSession(sessionId, op.sourceId);
      if (bound === false) fail('标注会话绑定失败。');
      this._active(op);
      this.sessions.set(sessionId, op);
      op.cleanup = await this.bridge.observe({ sessionId, signal: op.controller.signal, onEnd: cause => op.reject(cause || Object.assign(new Error('会话已结束，未提交有效结果。'), { publicMessage: '会话已结束，未提交有效结果。' })) });
      await this._assertSession(op);
      // Sending is observed independently: only the business commit completes a task.
      // Do not resend if acknowledgement fails or remains pending.
      void Promise.resolve().then(() => this.bridge.send({ sessionId, requestId: randomUUID(), text: annotationPrompt(op.kind, op.selected.size), signal: op.controller.signal })).catch(op.reject);
      return await done;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (op.sessionId) {
        this.sessions.delete(op.sessionId);
        await Promise.resolve(op.cleanup?.()).catch(() => {});
        if (!op.committed) await Promise.resolve(this.bridge.cancel(op.sessionId)).catch(() => {});
        await Promise.resolve(this.service.retireSession(op.sessionId)).catch(() => {});
      }
      if (this.operations.get(op.sourceId) === op) this.operations.delete(op.sourceId);
      finished();
    }
  }

  _active(op, signal) {
    if (this.closed || op.controller.signal.aborted || signal?.aborted || op.failure || this.operations.get(op.sourceId) !== op) fail('标注任务已取消或失效。');
  }

  async _assertSession(op, signal) {
    this._active(op, signal);
    await this.service.assertSession(op.sessionId, op.sourceId);
    this._active(op, signal);
  }

  async task(input, execution) {
    const op = this.sessions.get(execution?.agent?.session?.id);
    if (!op) fail('此工具仅接受当前标注会话。');
    if (!input || !['read', 'submit'].includes(input.action)) fail('工具操作无效。');
    await this._assertSession(op, execution?.signal);
    if (op.committed || op.submitting) fail('标注结果已提交或正在保存。');
    if (input.action === 'read') {
      const cursor = input.cursor ?? 0;
      const selected = [...op.selected.values()];
      let pages;
      if (op.kind === 'table') {
        pages = [];
        for (const { table, item } of selected) {
          const fields = table.fields.filter(field => field.enabled).map(field => ({ name: field.name, type: field.type ?? '', sourceComment: field.sourceComment ?? '' }));
          for (let offset = 0; offset < fields.length || offset === 0; offset += 100) {
            const chunk = fields.slice(offset, offset + 100);
            let page = pages.at(-1);
            if (!page || page.length >= 20 || page.reduce((count, row) => count + row.fields.length, 0) + chunk.length > 100) pages.push(page = []);
            page.push({ ...item, table: { id: table.id, name: table.name, schema: table.schema ?? '', sourceComment: table.sourceComment ?? '' }, fields: chunk, fieldOffset: offset, moreFields: offset + chunk.length < fields.length });
          }
        }
      } else {
        pages = [];
        for (let offset = 0; offset < selected.length; offset += 100) {
          pages.push(selected.slice(offset, offset + 100).map(({ table, target, item }) => ({
            ...item,
            table: { id: table.id, name: table.name, schema: table.schema ?? '', sourceComment: table.sourceComment ?? '', annotation: table.annotation?.text ?? '' },
            field: { name: target.name, type: target.type ?? '', sourceComment: target.sourceComment ?? '' },
          })));
        }
      }
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= pages.length) fail('分页游标无效。');
      return { kind: op.kind, items: pages[cursor], cursor, nextCursor: cursor + 1 < pages.length ? cursor + 1 : null };
    }
    if (!Array.isArray(input.annotations)) fail('缺少 annotations 标注数组。');
    if (input.annotations.length !== op.selected.size) {
      const expected = op.kind === 'table' ? '表标注（每张表一条，仅含 tableId 和 text）' : '字段标注（每个字段一条，含 tableId、fieldName 和 text）';
      fail(`应提交 ${op.selected.size} 条${expected}，实际收到 ${input.annotations.length} 条。`);
    }
    const seen = new Set();
    const annotations = input.annotations.map(item => {
      if (!item || !validText(item.tableId) || !validText(item.text)) fail('标注条目无效：tableId 和 text 必须为非空字符串。');
      if (op.kind === 'field' && !validText(item.fieldName)) fail(`字段标注缺少 fieldName（tableId: ${item.tableId}）。`);
      if (op.kind === 'table' && item.fieldName !== undefined) fail(`表标注只接受 tableId 和 text，不应包含 fieldName（tableId: ${item.tableId}）。`);
      const id = key(op.kind, item);
      if (!op.selected.has(id) || seen.has(id)) fail('标注结果包含未知或重复对象。');
      seen.add(id);
      return { ...op.selected.get(id).item, text: item.text.trim() };
    });
    op.submitting = true;
    try {
      const result = await this.service.aiSave({ sourceId: op.sourceId, revision: op.revision, kind: op.kind, items: annotations, sessionId: op.sessionId });
      op.committed = true;
      op.resolve({ revision: result.revision, count: annotations.length });
      return { ok: true };
    } finally {
      op.submitting = false;
      if (!op.committed && op.pendingError) op.reject(op.pendingError);
    }
  }

  getTool() {
    return {
      name: 'data_annotation_task',
      description: '分页读取本次选中的标注对象并完整提交：每个选中对象一条；表标注只填 tableId 和 text，字段标注填 tableId、fieldName 和 text。',
      parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
        action: { type: 'string', enum: ['read', 'submit'] }, cursor: { type: 'integer', minimum: 0 },
        annotations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tableId', 'text'], properties: { tableId: { type: 'string' }, fieldName: { type: 'string' }, text: { type: 'string' } } } },
      } },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 60_000,
      execute: (input, execution) => this.task(input, execution),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const operations = [...this.operations.values()];
    for (const operation of operations) operation.abort();
    await Promise.allSettled(operations.map(operation => operation.finished));
    await this.bridge.close();
  }
}
