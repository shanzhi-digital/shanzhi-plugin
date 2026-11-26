import { randomUUID } from 'node:crypto';
import { questionPrompt, DEFAULT_PROMPT, ANSWER_PROMPT } from './task-prompts.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { publicMessage: message, status }); };
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}不能为空或超出长度限制。`);
  return value.trim();
};
const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const checked = signal => signal?.throwIfAborted();
const visible = operation => structuredClone({ updates: operation.updates, candidates: operation.candidates, reason: operation.reason || '', connectionVersion: operation.catalog.connectionVersion });
const pending = item => !item.answer && !item.error;
const PAGE_SIZE = 20;

export class QuestionFlow {
  constructor({ store, query, bridge, cwd, timeoutMs = 30 * 60 * 1000 }) {
    Object.assign(this, { store, query, bridge, cwd, timeoutMs });
    this.sessions = new Map();
    this.drafts = new Map();
    this.closed = false;
  }

  validate(input) {
    text(input?.sourceId, 128, '数据源');
    if (!['generalize', 'answer'].includes(input.kind ?? 'generalize')) fail('问题集任务类型无效。');
    if (!Array.isArray(input.questions) || !input.questions.length) fail('请至少选择一个问题。');
    const seen = new Set();
    for (const item of input.questions) {
      text(item?.id, 128, '问题 ID');
      if (!Number.isSafeInteger(item.version) || item.version < 1 || seen.has(item.id)) fail('问题版本或选择无效。');
      seen.add(item.id);
    }
  }

  async run(input, parentSignal, report, taskId) {
    if (this.closed) fail('问题集服务已关闭。', 503);
    this.validate(input);
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.timeoutMs)]);
    checked(signal);
    const all = await this.store.list();
    const references = input.questions.map(ref => {
      const item = all.find(question => question.id === ref.id);
      if (!item || item.version !== ref.version) fail('所选问题已更新或删除，请刷新后重试。', 409);
      return item;
    });
    const catalog = await this.query.schema(input.sourceId);
    if (!catalog.tables.length) fail('该数据源没有已启用的数据表，请先在数据源中启用需要的表。');
    if (input.seed && input.seed.connectionVersion !== catalog.connectionVersion) fail('数据源连接已变化，请重新发起任务。', 409);
    const kind = input.kind ?? 'generalize';
    const operation = {
      taskId, kind, sourceId: input.sourceId, references: input.questions, all, catalog, signal, report, prompt: input.prompt ?? (kind === 'answer' ? ANSWER_PROMPT : DEFAULT_PROMPT), phase: 'reading',
      updates: input.seed ? structuredClone(input.seed.updates) : references.filter(item => kind === 'answer' || !item.answer.trim()).map(item => ({ id: item.id, version: item.version, text: item.text, answer: '', links: [] })),
      candidates: input.seed ? structuredClone(input.seed.candidates) : [],
      planned: kind === 'answer' || Boolean(input.seed), previousTaskId: input.previousTaskId, reason: input.seed?.reason || '', pages: new Set(), queries: new Map(), busy: false, finished: false,
    };
    if (input.seed) {
      for (const item of [...operation.updates, ...operation.candidates]) if (item.error) { item.error = null; item.answer = ''; item.links = []; }
    }
    let resolveDone, rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    done.catch(() => {});
    operation.resolve = resolveDone;
    operation.reject = rejectDone;
    const abort = () => rejectDone(Object.assign(new Error('问题集任务已取消或超时。'), { publicMessage: '问题集任务已取消或超时。' }));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const { sessionId } = await this.bridge.create({ cwd: this.cwd });
      operation.sessionId = sessionId;
      this.sessions.set(sessionId, operation);
      checked(signal);
      operation.report({ sessionId });
      this._publish(operation);
      operation.cleanup = await this.bridge.observe({ sessionId, signal, onEnd: cause => {
        if (!operation.finished) rejectDone(cause || Object.assign(new Error('会话结束但未完成问题处理。'), { publicMessage: '会话结束但未完成问题处理，请重试。' }));
      } });
      checked(signal);
      Promise.resolve().then(() => this.bridge.send({ sessionId, requestId: randomUUID(), text: questionPrompt({ kind, retry: Boolean(input.seed), prompt: operation.prompt }), signal })).catch(rejectDone);
      return await done;
    } finally {
      signal.removeEventListener('abort', abort);
      if (operation.sessionId) this.sessions.delete(operation.sessionId);
      await operation.cleanup?.().catch(() => {});
      if (!operation.finished && operation.sessionId) await this.bridge.cancel(operation.sessionId).catch(() => {});
    }
  }

  retry(taskId) {
    const draft = this.drafts.get(taskId);
    if (!draft || draft.state !== 'ready') fail('候选结果已保存、丢弃或失效。', 409);
    if (![...draft.result.updates, ...draft.result.candidates].some(item => item.error)) fail('没有需要重试的失败项。');
    return { kind: draft.kind, sourceId: draft.sourceId, questions: structuredClone(draft.references), seed: structuredClone(draft.result), previousTaskId: taskId, prompt: draft.prompt };
  }

  prune(taskIds) {
    const kept = new Set(taskIds);
    for (const id of this.drafts.keys()) if (!kept.has(id)) this.drafts.delete(id);
  }

  retire(taskId) {
    const draft = this.drafts.get(taskId);
    if (draft?.state === 'ready') draft.state = 'superseded';
  }

  async save({ taskId, candidateIds = [], updateIds = [] }) {
    const draft = this.drafts.get(taskId);
    if (!draft || draft.state !== 'ready') fail('结果已保存、丢弃或失效。', 409);
    const select = (items, ids) => {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) fail('保存选择无效。');
      return ids.map(id => {
        const item = items.find(item => item.id === id);
        if (!item || !item.answer || item.error || !item.links.length) fail('只能保存成功查询并生成答案的条目。');
        return item;
      });
    };
    const updates = select(draft.result.updates, updateIds), candidates = select(draft.result.candidates, candidateIds);
    if (!updates.length && !candidates.length) fail('请至少选择一个有效结果。');
    draft.state = 'saving';
    try {
      await this.store.commit({ references: draft.references, updates, candidates, sourceId: draft.sourceId, connectionVersion: draft.result.connectionVersion });
      draft.state = 'saved';
    } catch (error) { draft.state = 'ready'; throw error; }
    return { items: await this.store.list() };
  }

  discard(taskId) {
    const draft = this.drafts.get(taskId);
    if (!draft) { this.drafts.set(taskId, { state: 'discarded' }); return { ok: true }; }
    if (draft.state !== 'ready') fail('结果已保存、丢弃或失效。', 409);
    draft.state = 'discarded';
    return { ok: true };
  }

  _item(operation, id) {
    const item = [...operation.updates, ...operation.candidates].find(item => item.id === id);
    if (!item) fail('问题条目不属于本任务。');
    return item;
  }

  _publish(operation) {
    const items = [...operation.updates, ...operation.candidates];
    const success = items.filter(item => !!item.answer && !item.error).length;
    const failed = items.filter(item => !!item.error).length;
    operation.report({ result: visible(operation), progress: {
      phase: operation.phase,
      completed: success + failed,
      total: operation.planned ? items.length : null,
      success,
      failed,
    } });
  }

  async task(input, execution) {
    const operation = this.sessions.get(execution?.agent?.session?.id);
    if (!operation || operation.finished) fail('工具仅用于正在运行的问题集会话。', 409);
    checked(operation.signal); checked(execution?.signal);
    if (operation.busy) fail('请等待当前问题集工具完成后再调用。', 409);
    operation.busy = true;
    try {
      const kind = input?.operation;
      if (kind === 'read') {
        const cursor = input.cursor ?? 0, pageCount = Math.ceil(operation.catalog.tables.length / PAGE_SIZE);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= pageCount) fail('目录游标无效。');
        operation.pages.add(cursor);
        if (operation.pages.size === pageCount) operation.phase = operation.planned ? 'answering' : 'planning';
        this._publish(operation);
        return structuredClone({ source: { id: operation.sourceId, name: operation.catalog.name, engine: operation.catalog.engine },
          questions: cursor === 0 ? operation.all.filter(item => operation.references.some(ref => ref.id === item.id)).map(({ id, text, answer, origin }) => ({ id, text, answer, origin })) : [],
          existingQuestions: cursor === 0 ? operation.all.map(({ text }) => text) : [],
          items: cursor === 0 && operation.planned ? [...operation.updates, ...operation.candidates].filter(pending) : [],
          tables: operation.catalog.tables.slice(cursor * PAGE_SIZE, (cursor + 1) * PAGE_SIZE), nextCursor: cursor + 1 < pageCount ? cursor + 1 : null });
      }
      if (operation.pages.size !== Math.ceil(operation.catalog.tables.length / PAGE_SIZE)) fail('请先读完全部目录页。');
      if (kind === 'plan') {
        if (operation.kind === 'answer') fail('查询答案任务不能生成候选问题。');
        if (operation.planned) fail('本次候选已确定，不可重复生成。');
        if (!Array.isArray(input.candidates) || input.candidates.length > 20) fail('候选数量应为0至20条。');
        const seen = new Set(operation.all.map(item => normalize(item.text)));
        const candidates = input.candidates.map(item => {
          const value = text(item?.text, 2000, '候选问题'), key = normalize(value);
          if (seen.has(key)) fail('候选问题与已有问题或其他候选重复。');
          seen.add(key);
          return { id: randomUUID(), text: value, answer: '', links: [] };
        });
        const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 2000) : '';
        if (!candidates.length && !reason) fail('未生成候选时请说明原因。');
        operation.candidates = candidates;
        operation.reason = reason;
        operation.planned = true;
        operation.phase = 'answering';
        this._publish(operation);
        return { items: structuredClone([...operation.updates, ...operation.candidates]) };
      }
      if (!operation.planned) fail('请先提交候选问题计划。');
      if (kind === 'query') {
        const item = this._item(operation, input.itemId);
        if (!pending(item)) fail('该条目已完成。');
        const sql = text(input.sql, 50000, 'SQL');
        const signal = execution?.signal ? AbortSignal.any([operation.signal, execution.signal]) : operation.signal;
        const result = await this.query.query(operation.sourceId, sql, signal);
        checked(signal);
        if (result.connectionVersion !== operation.catalog.connectionVersion) fail('数据源连接已变化，请重新发起任务。', 409);
        const queryId = randomUUID();
        operation.queries.set(queryId, { itemId: item.id, sql, result });
        return { queryId, ...result };
      }
      if (kind === 'answer') {
        const item = this._item(operation, input.itemId);
        if (!pending(item)) fail('该条目已完成。');
        const answer = text(input.answer, 10000, '答案');
        if (!Array.isArray(input.queryIds) || !input.queryIds.length || new Set(input.queryIds).size !== input.queryIds.length) fail('答案必须引用本条问题的成功查询。');
        const queries = input.queryIds.map(id => {
          const query = operation.queries.get(id);
          if (!query || query.itemId !== item.id) fail('查询依据不属于本条问题。');
          return query;
        });
        const tables = new Map();
        for (const query of queries) for (const table of query.result.tables) tables.set(table.tableId, table);
        if (!tables.size) fail('答案必须关联实际查询的数据表。');
        item.answer = answer;
        item.links = [...tables.values()].map(table => ({ ...table, sourceId: operation.sourceId, tableName: table.name, sourceName: operation.catalog.name, fields: table.fields.map(field => typeof field === 'string' ? field : field.name), reason: '真实只读查询生成答案' }));
        item.queries = queries.map(({ sql, result }) => ({ sql, rowCount: result.rowCount, truncated: result.truncated }));
        this._publish(operation);
        return { ok: true };
      }
      if (kind === 'fail-item') {
        const item = this._item(operation, input.itemId);
        if (!pending(item)) fail('该条目已完成。');
        item.error = text(input.error, 1000, '失败原因');
        this._publish(operation);
        return { ok: true };
      }
      if (kind === 'finish') {
        if ([...operation.updates, ...operation.candidates].some(pending)) fail('尚有问题未查询回答或说明失败原因。');
        checked(operation.signal);
        const result = visible(operation);
        this.drafts.set(operation.taskId, { state: 'ready', kind: operation.kind, sourceId: operation.sourceId, references: operation.references, result, prompt: operation.prompt });
        if (operation.previousTaskId) this.retire(operation.previousTaskId);
        operation.finished = true;
        operation.phase = 'done';
        this._publish(operation);
        operation.resolve(result);
        return { ok: true, draftReady: true, saved: false };
      }
      fail('不支持的问题集操作。');
    } finally { operation.busy = false; }
  }

  getTool() {
    const string = { type: 'string' };
    return {
      name: 'question_set_task',
      description: '仅用于问题集后台任务：read读取真实结构及待查询问题，泛化任务用plan建立候选；查询答案任务直接query，不调用plan。query按问题执行真实只读SQL，answer引用查询结果，fail-item记录失败，finish结束处理待用户保存。',
      parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
        operation: { type: 'string', enum: ['read', 'plan', 'query', 'answer', 'fail-item', 'finish'] }, cursor: { type: 'integer', minimum: 0 },
        candidates: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: string } } },
        reason: string, itemId: string, sql: string, answer: string, error: string, queryIds: { type: 'array', items: string },
      } },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      timeoutMs: 65000, execute: (input, execution) => this.task(input, execution),
    };
  }

  async close() { this.closed = true; this.drafts.clear(); await this.bridge.close(); }
}
