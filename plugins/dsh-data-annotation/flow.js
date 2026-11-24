import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { annotationPrompt } from './task-prompts.js';

const fail = message => { throw Object.assign(new Error(message), { publicMessage: message, status: 409 }); };
const key = (kind, item) => JSON.stringify(kind === 'field' ? [item.tableId, item.fieldName] : [item.tableId]);
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
    if (!input || !validText(input.sourceId) || !validText(input.revision) || !['table', 'field', 'relation'].includes(input.kind) || !Array.isArray(input.items) || !input.items.length) throw Object.assign(new Error('标注任务参数无效。'), { status: 400 });
    for (const item of input.items) {
      if (!item || !validText(item.tableId) || (input.kind === 'field' && !validText(item.fieldName)) || (input.kind !== 'field' && item.fieldName !== undefined)) throw Object.assign(new Error('标注对象无效。'), { status: 400 });
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
        if (!item || !validText(item.tableId) || (op.kind === 'field' && !validText(item.fieldName)) || (op.kind !== 'field' && item.fieldName !== undefined)) fail('标注对象无效。');
        const table = tables.get(item.tableId);
        const target = op.kind === 'field' ? table?.fields.find(field => field.name === item.fieldName) : table;
        const id = key(op.kind, item);
        if (!target || table.enabled === false || (op.kind === 'field' && !target.enabled) || requested.has(id)) fail('标注对象不存在、已停用或重复。');
        requested.add(id);
        if (op.kind !== 'relation' && target.annotation?.status === 'confirmed') continue;
        op.selected.set(id, { table, target, item: op.kind === 'field' ? { tableId: table.id, fieldName: target.name } : { tableId: table.id } });
      }
      if (!op.selected.size) fail('没有可标注的对象。');
      if (op.kind === 'relation') {
        if (op.selected.size < 2 || op.selected.size !== tables.size) fail('关系分析必须包含当前数据源全部启用表，且至少两张表。');
        const existing = await this.service.relations(op.sourceId);
        this._active(op);
        if (existing.revision !== op.revision) fail('数据已更新，请重新加载。');
        op.canvases = existing.items.map(canvas => ({ id: canvas.id, name: canvas.name, description: canvas.description, rootTableId: canvas.content.rootTableId ?? null, confirmed: Boolean(canvas.confirmed), valid: Boolean(canvas.valid), content: canvas.content }));
        op.readPages = new Set();
      }
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
      if (op.kind !== 'field') {
        pages = [];
        for (const { table, item } of selected) {
          const fields = table.fields.filter(field => field.enabled).map(field => ({ name: field.name, type: field.type ?? '', sourceComment: field.sourceComment ?? '', ...(op.kind === 'relation' ? { primaryKey: field.primaryKey ?? null, notNull: field.notNull ?? null, annotation: field.annotation?.text ?? '' } : {}) }));
          for (let offset = 0; offset < fields.length || offset === 0; offset += 100) {
            const chunk = fields.slice(offset, offset + 100);
            let page = pages.at(-1);
            if (!page || page.length >= 20 || page.reduce((count, row) => count + row.fields.length, 0) + chunk.length > 100) pages.push(page = []);
            page.push({ ...item, table: { id: table.id, name: table.name, schema: table.schema ?? '', sourceComment: table.sourceComment ?? '', ...(op.kind === 'relation' ? { annotation: table.annotation?.text ?? '' } : {}) }, fields: chunk, fieldOffset: offset, moreFields: offset + chunk.length < fields.length });
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
      if (op.kind === 'relation') {
        op.pageCount = pages.length;
        op.readPages.add(cursor);
      }
      return { kind: op.kind, items: pages[cursor], cursor, nextCursor: cursor + 1 < pages.length ? cursor + 1 : null, ...(op.kind === 'relation' ? { canvases: op.canvases } : {}) };
    }
    if (op.kind === 'relation') return this._submitRelations(op, input);
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

  async _submitRelations(op, input) {
    if (!op.pageCount || op.readPages.size !== op.pageCount) fail('请先分页读取全部关系结构。');
    if (!Array.isArray(input.canvases) || input.annotations !== undefined || input.relations !== undefined) fail('请使用 canvases 数组提交业务主题画布。');
    if (Buffer.byteLength(JSON.stringify(input)) > 1048576) throw Object.assign(new Error('关系建议内容过长。'), { publicMessage: '关系建议内容过长。', status: 413 });
    const canvases = input.canvases.map(canvas => {
      if (!canvas || Object.keys(canvas).some(key => !['name', 'description', 'rootTableId', 'relations'].includes(key)) || !validText(canvas.name) || !validText(canvas.description) || !validText(canvas.rootTableId) || !op.selected.has(key('relation', { tableId: canvas.rootTableId })) || !Array.isArray(canvas.relations) || !canvas.relations.length) fail('业务主题画布必须包含名称、说明、有效核心主表和关系。');
      const neighbors = new Map();
      const relations = canvas.relations.map(relation => {
        if (!relation || Object.keys(relation).some(key => !['fromTableId', 'toTableId', 'pairs', 'cardinality'].includes(key)) || !validText(relation.fromTableId) || !validText(relation.toTableId) || relation.fromTableId === relation.toTableId || !['1:1', '1:N', 'N:1'].includes(relation.cardinality) || !Array.isArray(relation.pairs) || !relation.pairs.length) fail('关系建议格式无效。');
        const from = op.selected.get(key('relation', { tableId: relation.fromTableId }))?.table;
        const to = op.selected.get(key('relation', { tableId: relation.toTableId }))?.table;
        if (!from || !to) fail('关系包含未知或停用表。');
        const seen = new Set();
        const pairs = relation.pairs.map(pair => {
          if (!pair || Object.keys(pair).some(key => !['fromField', 'toField'].includes(key)) || !validText(pair.fromField) || !validText(pair.toField)) fail('关系字段配对无效。');
          if (!from.fields.some(field => field.name === pair.fromField && field.enabled) || !to.fields.some(field => field.name === pair.toField && field.enabled)) fail('关系包含未知或停用字段。');
          const id = JSON.stringify([pair.fromField, pair.toField]);
          if (seen.has(id)) fail('关系字段配对重复。');
          seen.add(id);
          return { fromField: pair.fromField, toField: pair.toField };
        });
        if (!neighbors.has(from.id)) neighbors.set(from.id, new Set());
        if (!neighbors.has(to.id)) neighbors.set(to.id, new Set());
        neighbors.get(from.id).add(to.id);
        neighbors.get(to.id).add(from.id);
        return { fromTableId: from.id, toTableId: to.id, pairs, cardinality: relation.cardinality };
      });
      const reachable = new Set(), pending = [canvas.rootTableId];
      while (pending.length) {
        const tableId = pending.pop();
        if (reachable.has(tableId)) continue;
        reachable.add(tableId);
        for (const next of neighbors.get(tableId) ?? []) if (!reachable.has(next)) pending.push(next);
      }
      if (!neighbors.has(canvas.rootTableId) || reachable.size !== neighbors.size) fail('业务主题中的所有表必须通过关系从核心主表可达。');
      return { name: canvas.name.trim(), description: canvas.description.trim(), rootTableId: canvas.rootTableId, relations };
    });
    op.submitting = true;
    try {
      const result = await this.service.aiRelationSave({ sourceId: op.sourceId, revision: op.revision, sessionId: op.sessionId, canvases });
      op.committed = true;
      op.resolve({ revision: result.revision, count: result.count, canvasCount: result.canvasCount, canvasIds: result.canvasIds });
      return { ok: true };
    } finally {
      op.submitting = false;
      if (!op.committed && op.pendingError) op.reject(op.pendingError);
    }
  }

  getTool() {
    return {
      name: 'data_annotation_task',
      description: '分页读取全部结构后提交。表/字段标注通过 annotations 每对象一条；关系通过 canvases 提交0到多个业务查询主题，每组有名称、粒度说明、一个核心主表和必要关系，允许不同主题复用关系。',
      parameters: { type: 'object', required: ['action'], additionalProperties: false, properties: {
        action: { type: 'string', enum: ['read', 'submit'] }, cursor: { type: 'integer', minimum: 0 },
        annotations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tableId', 'text'], properties: { tableId: { type: 'string' }, fieldName: { type: 'string' }, text: { type: 'string' } } } },
        canvases: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'description', 'rootTableId', 'relations'], properties: {
          name: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, rootTableId: { type: 'string' },
          relations: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['fromTableId', 'toTableId', 'pairs', 'cardinality'], properties: {
            fromTableId: { type: 'string' }, toTableId: { type: 'string' }, cardinality: { type: 'string', enum: ['1:1', '1:N', 'N:1'] },
            pairs: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['fromField', 'toField'], properties: { fromField: { type: 'string' }, toField: { type: 'string' } } } },
          } } },
        } } },
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
