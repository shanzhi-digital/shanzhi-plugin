import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { domainResult, fail, object, questionCandidates, selectedIds, selectionBasis, selectionDraft, suggestionResult, text, updateEnabled } from './selection-flow.js';
import { DatasourceAiExecutor, PAGE_SIZE, SAMPLE_SIZE } from './ai-executor.js';
import { questionAnalysisStatus, readAnalysisContext, writeAnalysisContext } from './flow-store.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (message, status = 409) => Object.assign(new Error(message), { publicMessage: message, status });
const tableMap = state => new Map((state.catalog?.tables ?? []).map(table => [table.id, table]));
const scanChanges = () => ({ addedTableIds: [], removedTableIds: [], changedTableIds: [] });

function structureHash(table) {
  const fields = table.fields.map(field => [field.name, field.type, field.primaryKey, field.notNull, field.sourceComment ?? '']);
  return hash([table.schema, table.name, table.tableKind, table.sourceComment ?? '', fields]);
}

function mergeCatalog(state, scannedTables, now) {
  const previous = tableMap(state);
  const changes = scanChanges();
  const tables = scannedTables.map(raw => {
    const table = { ...raw, tableKind: raw.tableKind ?? 'table', sourceComment: raw.sourceComment ?? '' };
    const structure = structureHash(table);
    const before = previous.get(table.id);
    const same = before?.structureHash === structure;
    previous.delete(table.id);
    if (!before) changes.addedTableIds.push(table.id);
    else if (!same) changes.changedTableIds.push(table.id);
    return {
      ...table,
      structureHash: structure,
      enabled: before?.enabled ?? false,
      domain: same ? before.domain : '',
      category: same ? before.category : '',
      reason: same ? before.reason : '',
      freshness: same ? before.freshness : null,
    };
  });
  changes.removedTableIds = [...previous.keys()];
  const id = hash(tables.map(table => `${table.id}:${table.structureHash}`).sort());
  if (state.catalog?.id !== id) state.revision++;
  state.catalog = { id, scannedAt: new Date(now).toISOString(), tables, domains: state.domains, domainContext: state.domainContext };
  return changes;
}

function checkRevision(revision, current) {
  if (revision !== current) fail('数据已更新，请重新加载后重试。', 409);
}

function requireEnabled(source) {
  if (!source.enabled) fail('数据源已停用，请先启用。', 409);
}

function requireCatalog(state) {
  if (!state.catalog) fail('请先刷新数据源目录。');
  return state.catalog;
}

function checkSignal(signal) {
  if (signal?.aborted) fail('本次调用已取消。', 409);
}

function checkSnapshot(state, source, operation) {
  requireEnabled(source);
  if (source.connectionVersion !== operation.source.connectionVersion || state.connectionVersion !== operation.state.connectionVersion || state.catalog?.id !== operation.state.catalog?.id) {
    fail('数据源目录或连接已更新，请重新执行。', 409);
  }
}

export function validateAiInput(input) {
  object(input, ['id', 'action', 'revision', 'questionIds', 'domains', 'questions'], 'AI 任务');
  text(input.id, '数据源 ID', 128);
  if (!['detect-domains', 'suggest', 'generalize-question'].includes(input.action)) fail('不支持此 AI 操作。');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('请先读取页面最新状态。', 409);
  for (const key of ['questionIds', 'domains', 'questions']) {
    if (input[key] !== undefined && !Array.isArray(input[key])) fail('AI 任务参数格式无效。');
  }
}

/** Business snapshots, transactions and drafts for datasource operations. */
export class DatasourceFlow {
  constructor({ store, runtime, bridge, defaultCwd = process.cwd(), timeoutMs = 15 * 60 * 1000, now = Date.now }) {
    this.store = store;
    this.runtime = runtime;
    this.defaultCwd = resolve(defaultCwd);
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.operations = new Map();
    this.executor = new DatasourceAiExecutor({ bridge, callbacks: {
      bindSession: (...args) => this.store.bindSession(...args),
      assertOperation: operation => this._assertOperation(operation),
      assertSession: (operation, signal) => this._assertSession(operation, signal),
      sample: (operation, ids, signal) => this._sample(operation, ids, signal),
      verify: (operation, result) => operation.kind === 'generalize-question'
        ? questionCandidates(result, operation.tables, operation.allQuestions, operation.originalAnalysisQuestions)
        : operation.kind === 'detect-domains' ? domainResult(result, operation.tables) : suggestionResult(result, operation.tables, operation.questions),
      commit: (operation, verified, signal, payloadHash) => operation.kind === 'generalize-question'
        ? this._saveQuestionDraft(operation, verified, signal, payloadHash)
        : this._saveAiResult(operation, verified, operation.kind === 'detect-domains', signal, payloadHash),
    } });
    this.drafts = new Map();
    this.questionDrafts = new Map();
    this.closed = false;
  }

  async initialize() { this._assertOpen(); }

  _assertOpen() {
    if (this.closed) fail('数据源服务已关闭。', 503);
  }

  async _snapshot(id) {
    const state = await this.store.get(id);
    if (!state) fail('未找到该数据源。', 404);
    const source = await this.runtime.source(id);
    if (!source) fail('未找到该数据源。', 404);
    if (state.connectionVersion !== source.connectionVersion) fail('数据源连接已更新，请重新加载。', 409);
    return { state, source };
  }

  async _view({ state, source, extra }) {
    const questions = (await this.store.listQuestions(state.id)).map(question => ({ ...question, analysisStatus: questionAnalysisStatus(question, state) }));
    const draft = this.drafts.get(state.id);
    const current = draft && source.enabled && draft.sourceRevision === source.revision && draft.revision === state.revision && draft.connectionVersion === state.connectionVersion && draft.value.catalogId === state.catalog?.id;
    const versions = current ? new Map(questions.map(item => [item.id, item.version])) : null;
    const available = current && draft.questions.every(item => versions.get(item.id) === item.version);
    const questionDraft = this.questionDrafts.get(state.id);
    const questionAvailable = questionDraft && source.enabled && questionDraft.sourceRevision === source.revision && questionDraft.revision === state.revision && questionDraft.connectionVersion === state.connectionVersion && questionDraft.catalogId === state.catalog?.id && questionDraft.value.questions.every(reference => questions.some(item => item.id === reference.id && item.version === reference.version && item.origin === 'original'));
    return structuredClone({ ...state, ...extra, enabled: source.enabled, defaultCwd: this.defaultCwd, questions, draft: available ? draft.value : null, questionDraft: questionAvailable ? questionDraft.value : null });
  }

  async get(id) {
    this._assertOpen();
    return this._view(await this._snapshot(text(id, '数据源 ID', 128)));
  }

  async sourceChanged(id, source) {
    const operation = this.operations.get(id);
    const draft = this.drafts.get(id);
    const questionDraft = this.questionDrafts.get(id);
    if (!operation && !draft && !questionDraft) return;
    if (source === undefined) {
      try { source = await this.runtime.source(id); }
      catch (cause) { if (cause.status !== 404) throw cause; }
    }
    if (operation && (!source?.enabled || (operation.source && operation.source.connectionVersion !== source.connectionVersion))) operation.abort();
    if (draft && this.drafts.get(id) === draft && (!source?.enabled || draft.connectionVersion !== source.connectionVersion)) this.drafts.delete(id);
    if (questionDraft && this.questionDrafts.get(id) === questionDraft && (!source?.enabled || questionDraft.connectionVersion !== source.connectionVersion)) this.questionDrafts.delete(id);
  }

  _assertOperation(operation) {
    if (operation.failure) throw operation.failure;
    if (this.closed || this.operations.get(operation.id) !== operation || operation.controller.signal.aborted) fail('本次操作已取消、结束或失效。', 409);
  }

  async _assertSession(operation, signal) {
    checkSignal(signal);
    this._assertOperation(operation);
    const { state, source } = await this._snapshot(operation.id);
    checkSnapshot(state, source, operation);
    checkRevision(operation.state.revision, state.revision);
    const binding = await this.store.findBinding(operation.sessionId);
    if (binding?.sourceId !== operation.id || binding.retired) fail('此接入会话已结束或失效。', 409);
    this._assertOperation(operation);
    checkSignal(signal);
  }

  async _change(id, work) {
    this._assertOpen();
    return this.store.change(id, async (state, source, now, tx) => {
      this._assertOpen();
      const { revision, catalog } = state;
      const extra = await work(state, source, now, tx);
      const saveState = state.revision !== revision || state.catalog !== catalog;
      return { state: saveState ? state : undefined, result: { state, source, extra } };
    });
  }

  async _perform(input, signal, work) {
    const id = input.id;
    if (this.operations.has(id)) fail('当前数据源正在执行操作。', 409);
    const operation = {
      id,
      kind: input.action,
      operationId: text(input.operationId ?? randomUUID(), '操作标识', 128),
      controller: new AbortController(),
      pages: new Set(),
      report: input.report,
    };
    operation.abort = () => { if (!operation.committed) operation.controller.abort(); };
    let release;
    operation.finished = new Promise(done => { release = done; });
    this.operations.set(id, operation);
    signal?.addEventListener('abort', operation.abort, { once: true });
    if (signal?.aborted) operation.abort();
    const timer = setTimeout(operation.abort, this.timeoutMs);
    try {
      Object.assign(operation, await this._snapshot(id));
      this._assertOperation(operation);
      requireEnabled(operation.source);
      if (input.action !== 'ensure-scan') checkRevision(input.revision, operation.state.revision);
      const result = await work(operation);
      if (!operation.committed) this._assertOperation(operation);
      const view = await this._view(result);
      return operation.sessionId ? { ...view, sessionId: operation.sessionId } : view;
    } catch (cause) {
      const failure = operation.controller.signal.aborted && !operation.committed ? error('操作已取消或超时。') : cause;
      if (operation.sessionId) failure.sessionId = operation.sessionId;
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', operation.abort);
      try {
        await this.executor.finish(operation);
      } finally {
        if (operation.sessionId) {
          await this.store.retireSession(operation.sessionId).catch(() => {});
        }
        if (this.operations.get(id) === operation) this.operations.delete(id);
        release();
      }
    }
  }

  async _scan(input, signal) {
    if (input.action === 'ensure-scan' && typeof input.open !== 'boolean') fail('打开详情标记必须为布尔值。');
    return this._perform(input, signal, async operation => {
      if (input.action === 'ensure-scan' && this.now() - Date.parse(operation.state.catalog?.scannedAt) < (input.open ? 30_000 : 30 * 60_000)) {
        return { state: operation.state, source: operation.source, extra: scanChanges() };
      }
      const tables = await this.runtime.scan(operation.id, operation.state.connectionVersion, { signal: operation.controller.signal });
      this._assertOperation(operation);
      const result = await this._change(operation.id, (state, source, now) => {
        this._assertOperation(operation);
        checkSnapshot(state, source, operation);
        return mergeCatalog(state, tables, now);
      });
      operation.committed = true;
      return result;
    });
  }

  async _detectFreshness(input, signal) {
    return this._perform(input, signal, async operation => {
      const { tables } = requireCatalog(operation.state);
      if (!tables.length) return operation;
      const results = await this.runtime.detectFreshness(operation.id, operation.state.connectionVersion, tables, operation.controller.signal);
      this._assertOperation(operation);
      const result = await this._change(operation.id, (state, source) => {
        this._assertOperation(operation);
        checkSnapshot(state, source, operation);
        for (const table of state.catalog.tables) table.freshness = results.get(table.id);
        state.revision++;
      });
      operation.committed = true;
      return result;
    });
  }

  async _ai(input, signal) {
    return this._perform(input, signal, async operation => {
      operation.tables = tableMap({ catalog: requireCatalog(operation.state) });
      if (!operation.tables.size) fail('当前目录没有可分析的表。');
      if (input.action === 'generalize-question') {
        if (!Array.isArray(input.questions) || !input.questions.length) fail('请至少选择一个原问题。');
        operation.allQuestions = await this.store.listQuestions(operation.id);
        const originals = new Map(operation.allQuestions.map(question => [question.id, question]));
        const seen = new Set();
        operation.questions = input.questions.map(reference => {
          object(reference, ['id', 'version'], '参考原问题');
          const id = text(reference.id, '问题 ID', 128);
          if (seen.has(id)) fail('参考原问题包含重复项。');
          seen.add(id);
          if (!Number.isSafeInteger(reference.version) || reference.version < 1) fail('请先读取问题最新版本。', 409);
          const question = originals.get(id);
          if (!question || question.version !== reference.version) fail('问题已更新或删除，请刷新后重试。', 409);
          if (question.origin !== 'original') fail('只有原始问题可以泛化。');
          return question;
        });
        operation.originalAnalysisQuestions = operation.questions.filter(question => ['missing', 'stale'].includes(questionAnalysisStatus(question, operation.state)));
        operation.sampleResults = new Map();
        operation.versions = operation.questions.map(({ id, version }) => ({ id, version }));
      } else if (input.action === 'suggest') {
        const questions = await this.store.listQuestions(operation.id);
        Object.assign(operation, selectionBasis(input, questions, operation.state.domains));
        operation.versions = operation.questions.map(({ id, version }) => ({ id, version }));
        operation.cachedRecommendations = [];
        operation.questions = operation.questions.filter(question => {
          const links = (question.links ?? []).filter(link => link.sourceId === operation.id);
          const status = questionAnalysisStatus(question, operation.state);
          if (status === 'linked') operation.cachedRecommendations.push(...links.map(({ tableId, reason }) => ({ tableId, reason })));
          return status !== 'linked' && status !== 'empty';
        });
        if (!operation.questions.length) return this._saveSelectionDraft(operation, signal);
      }
      this._assertOperation(operation);
      return this.executor.run(operation, this.defaultCwd);
    });
  }

  async ai(input, signal, report) {
    this._assertOpen();
    validateAiInput(input);
    checkSignal(signal);
    return this._ai({ ...input, id: input.id.trim(), report }, signal);
  }

  async action(input, signal) {
    this._assertOpen();
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('操作格式无效。');
    const id = text(input.id, '数据源 ID', 128);
    input = { ...input, id };
    if (input.action === 'cancel') {
      const operationId = input.operationId === undefined ? undefined : text(input.operationId, '操作标识', 128);
      const draftId = input.draftId === undefined ? undefined : text(input.draftId, '草稿标识', 128);
      const questionDraftId = input.questionDraftId === undefined ? undefined : text(input.questionDraftId, '问题草稿标识', 128);
      if (!operationId && !draftId && !questionDraftId) fail('请指定要取消的操作或草稿。');
      const operation = this.operations.get(id);
      if (operation && operation.operationId === operationId) operation.abort();
      if (draftId && this.drafts.get(id)?.value.id === draftId) this.drafts.delete(id);
      if (questionDraftId && this.questionDrafts.get(id)?.value.id === questionDraftId) this.questionDrafts.delete(id);
      return this.get(id);
    }
    checkSignal(signal);
    if (input.action !== 'ensure-scan' && (!Number.isSafeInteger(input.revision) || input.revision < 0)) fail('请先读取页面最新状态。', 409);
    switch (input.action) {
      case 'scan': case 'ensure-scan': return this._scan(input, signal);
      case 'detect-freshness': return this._detectFreshness(input, signal);
      case 'confirm-question-draft': return this._confirmQuestionDraft(input, signal);
      case 'set-tables': return this._setTables(input, signal);
      case 'confirm-selection': return this._confirmSelection(input, signal);
      default: fail('不支持此操作。');
    }
  }

  async _setTables(input, signal) {
    if (typeof input.enabled !== 'boolean') fail('表启停状态必须为布尔值。');
    return this._view(await this._change(input.id, (state) => {
      checkSignal(signal);
      checkRevision(input.revision, state.revision);
      const tables = requireCatalog(state).tables;
      const candidates = selectedIds(input.tableIds, new Set(tables.map(table => table.id)), '所选表');
      if (!candidates.size) fail('请至少选择一张表。');
      if (updateEnabled(tables, candidates, input.enabled ? candidates : new Set())) state.revision++;
    }));
  }

  async _confirmSelection(input, signal) {
    const draftId = text(input.draftId, '草稿标识', 128);
    const draft = this.drafts.get(input.id);
    if (!draft || draft.value.id !== draftId) fail('选表草稿已结束或失效，请重新推荐。', 409);
    const candidates = new Set(draft.value.tableIds);
    const selected = selectedIds(input.selectedTableIds, candidates, '最终选表');
    const result = await this._change(input.id, async (state, source, now, tx) => {
      requireEnabled(source);
      checkRevision(input.revision, state.revision);
      checkRevision(draft.revision, state.revision);
      if (source.revision !== draft.sourceRevision || state.connectionVersion !== draft.connectionVersion || state.catalog?.id !== draft.value.catalogId) fail('数据源或目录已更新，请重新推荐。', 409);
      await tx.assertQuestionVersions(draft.questions);
      checkSignal(signal);
      if (this.drafts.get(input.id) !== draft) fail('选表草稿已结束或失效，请重新推荐。', 409);
      if (updateEnabled(state.catalog.tables, candidates, selected)) state.revision++;
    });
    if (this.drafts.get(input.id) === draft) this.drafts.delete(input.id);
    return this._view(result);
  }

  async _confirmQuestionDraft(input, signal) {
    const draftId = text(input.draftId, '问题草稿标识', 128);
    const draft = this.questionDrafts.get(input.id);
    if (!draft || draft.value.id !== draftId) fail('问题草稿已结束或失效，请重新泛化。', 409);
    if (draft.confirming) fail('问题草稿正在确认，请稍候。', 409);
    if (!Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > 20) fail('请确认 1 至 20 个候选问题。');
    const known = new Map(draft.value.candidates.map(item => [item.id, item]));
    selectedIds(input.candidates.map(item => item?.id), new Set(known.keys()), '候选问题');
    const confirmed = input.candidates.map(item => {
      object(item, ['id', 'text'], '候选问题');
      return { candidate: known.get(item.id), text: text(item.text, '候选问题', 2000) };
    });
    const items = confirmed.map(({ text }) => ({ text }));
    draft.confirming = true;
    try {
      const result = await this._change(input.id, async (state, source, now, tx) => {
        requireEnabled(source);
        checkRevision(input.revision, state.revision);
        checkRevision(draft.revision, state.revision);
        if (source.revision !== draft.sourceRevision || state.connectionVersion !== draft.connectionVersion || state.catalog?.id !== draft.catalogId) fail('数据源或目录已更新，请重新泛化。', 409);
        checkSignal(signal);
        if (this.questionDrafts.get(input.id) !== draft) fail('问题草稿已结束或失效，请重新泛化。', 409);
        const created = await tx.saveQuestions({ questions: draft.value.questions, items });
        checkSignal(signal);
        if (this.questionDrafts.get(input.id) !== draft) fail('问题草稿已结束或失效，请重新泛化。', 409);
        const links = created.flatMap((question, index) => confirmed[index].candidate.links.map(link => ({ ...link, questionId: question.id })));
        const staleQuestionIds = created.filter((question, index) => question.text.trim() !== confirmed[index].candidate.text.trim()).map(question => question.id);
        await tx.replaceQuestionLinks(created.map(({ id, version }) => ({ id, version })), links, {
          catalogId: state.catalog.id, connectionVersion: state.connectionVersion, staleQuestionIds,
        });
        checkSignal(signal);
        if (this.questionDrafts.get(input.id) !== draft) fail('问题草稿已结束或失效，请重新泛化。', 409);
      });
      if (this.questionDrafts.get(input.id) === draft) this.questionDrafts.delete(input.id);
      return this._view(result);
    } finally {
      draft.confirming = false;
    }
  }

  async scopedSql(_name, args, execution, execute) {
    checkSignal(execution?.signal);
    this._assertOpen();
    const sessionId = execution?.agent?.session?.id;
    if (sessionId && (this.executor.hasSession(sessionId) || await this.store.findBinding(sessionId))) fail('数据源接入会话只可使用 datasource_task。', 409);
    checkSignal(execution?.signal);
    return execute(args, execution);
  }

  async sampleTable(input, signal) {
    this._assertOpen();
    checkSignal(signal);
    const id = text(input?.id, '数据源 ID', 128);
    const tableId = text(input?.tableId, '表 ID', 128);
    const snapshotId = text(input?.snapshotId, '目录标识', 128);
    const snapshot = await this._snapshot(id);
    requireEnabled(snapshot.source);
    if (snapshot.state.catalog?.id !== snapshotId) fail('目录已更新，请重新打开详情。', 409);
    const table = tableMap(snapshot.state).get(tableId);
    if (!table) fail('数据表不存在。', 404);
    if (table.tableKind !== 'table') fail('仅支持读取普通表的样例。');
    checkSignal(signal);
    const samples = await this.runtime.sampleTables(id, snapshot.state.connectionVersion, [table], signal);
    const { state, source } = await this._snapshot(id);
    checkSnapshot(state, source, snapshot);
    checkSignal(signal);
    return { ...samples.get(tableId), fieldNames: table.fields.map(field => field.name) };
  }

  async _sample(operation, tableIds, signal) {
    if (!['suggest', 'generalize-question'].includes(operation.kind)) fail('只有辅助选表或问题泛化可请求业务样例。');
    if (operation.kind === 'generalize-question' && operation.pages.size !== Math.ceil(operation.tables.size / PAGE_SIZE)) fail('请先读完全部目录页，再按需采样。');
    const ids = selectedIds(tableIds, operation.tables, '样例表');
    if (ids.size < 1 || ids.size > SAMPLE_SIZE) fail(`请指定 1 至 ${SAMPLE_SIZE} 张候选表。`);
    const tables = [...ids].map(id => operation.tables.get(id));
    if (tables.some(table => table.tableKind !== 'table')) fail('仅支持读取普通表的样例。');
    const operationSignal = operation.controller.signal;
    const readSignal = signal ? AbortSignal.any([signal, operationSignal]) : operationSignal;
    let results;
    try {
      results = await this.runtime.sampleTables(operation.id, operation.state.connectionVersion, tables, readSignal);
    } catch (cause) {
      if (operation.sampleResults) for (const table of tables) operation.sampleResults.set(table.id, { tableId: table.id, sampleStatus: 'failed' });
      throw cause;
    }
    await this._assertSession(operation, signal);
    if (operation.committed) fail('本次结果已保存。', 409);
    const sampled = tables.map(table => ({ tableId: table.id, ...results.get(table.id), fieldNames: table.fields.map(field => field.name) }));
    if (operation.sampleResults) for (const item of sampled) operation.sampleResults.set(item.tableId, { tableId: item.tableId, sampleStatus: item.sampleStatus, sampleTruncated: item.sampleTruncated });
    return { tables: sampled };
  }

  async _saveQuestionDraft(operation, verified, signal, payloadHash) {
    const result = await this._change(operation.id, async (state, source, now, tx) => {
      this._assertOperation(operation);
      checkSignal(signal);
      checkSnapshot(state, source, operation);
      checkRevision(operation.state.revision, state.revision);
      await tx.assertSessionBinding(operation.sessionId);
      await tx.assertQuestionVersions(operation.versions);
      if (operation.originalAnalysisQuestions.length) {
        const links = verified.originalAnalyses.flatMap(({ questionId, links }) => links.map(link => ({ ...link, questionId })));
        await tx.replaceQuestionLinks(operation.originalAnalysisQuestions.map(({ id, version }) => ({ id, version })), links, {
          catalogId: state.catalog.id, connectionVersion: state.connectionVersion, analysisComplete: true,
        });
      }
      this._assertOperation(operation);
      checkSignal(signal);
    });
    const { state, source } = result;
    const questions = operation.versions.map(reference => ({ ...reference }));
    const sampleResults = [...operation.sampleResults.values()];
    const sampleNote = !sampleResults.length ? '未读取业务样例，本次仅依据表结构生成。'
      : sampleResults.some(item => item.sampleStatus === 'failed') ? '部分业务样例读取失败，请结合采样状态查看候选依据。'
      : sampleResults.some(item => item.sampleStatus === 'ok') ? '已读取业务样例，候选依据结合表结构与样例生成。'
      : '业务样例为空，本次仅依据表结构生成。';
    this.questionDrafts.set(operation.id, {
      value: { id: randomUUID(), questions, ...(verified.reason === undefined ? {} : { reason: verified.reason }), candidates: verified.candidates.map(item => ({ id: randomUUID(), ...item })), sampleNote, sampleResults },
      revision: state.revision,
      sourceRevision: source.revision,
      connectionVersion: state.connectionVersion,
      catalogId: state.catalog?.id,
    });
    operation.committed = true;
    operation.payloadHash = payloadHash;
    operation.resolve(result);
  }

  _setSelectionDraft(operation, { state, source }, recommendations) {
    const combined = new Map();
    for (const item of [...(operation.cachedRecommendations ?? []), ...recommendations]) {
      const before = combined.get(item.tableId);
      combined.set(item.tableId, before && before.reason !== item.reason ? { ...item, reason: `${before.reason}；${item.reason}` } : item);
    }
    this.drafts.set(operation.id, {
      value: selectionDraft(randomUUID(), state, [...combined.values()], operation.domains),
      revision: state.revision,
      sourceRevision: source.revision,
      connectionVersion: state.connectionVersion,
      questions: operation.versions,
    });
  }

  async _saveSelectionDraft(operation, signal) {
    const result = await this._change(operation.id, async (state, source, now, tx) => {
      this._assertOperation(operation);
      checkSignal(signal);
      checkSnapshot(state, source, operation);
      checkRevision(operation.state.revision, state.revision);
      await tx.assertQuestionVersions(operation.versions);
      this._assertOperation(operation);
      checkSignal(signal);
    });
    this._setSelectionDraft(operation, result, []);
    operation.committed = true;
    return result;
  }

  async _saveAiResult(operation, verified, detecting, signal, payloadHash) {
    const result = await this._change(operation.id, async (state, source, now, tx) => {
      this._assertOperation(operation);
      checkSignal(signal);
      checkSnapshot(state, source, operation);
      checkRevision(operation.state.revision, state.revision);
      await tx.assertSessionBinding(operation.sessionId);
      this._assertOperation(operation);
      checkSignal(signal);
      if (detecting) {
        state.domains = state.catalog.domains = verified.domains;
        state.domainContext = state.catalog.domainContext = writeAnalysisContext({ ...readAnalysisContext(state.domainContext), domainCatalogId: state.catalog.id });
        for (const table of state.catalog.tables) Object.assign(table, verified.classifications.get(table.id));
        state.revision++;
      } else {
        await tx.assertQuestionVersions(operation.versions);
        const links = verified.analyses.flatMap(({ questionId, links }) => links.map(link => ({ ...link, questionId })));
        await tx.replaceQuestionLinks(operation.questions.map(({ id, version }) => ({ id, version })), links, { catalogId: state.catalog.id, connectionVersion: state.connectionVersion, analysisComplete: true });
        this._assertOperation(operation);
        checkSignal(signal);
      }
    });
    if (!detecting) this._setSelectionDraft(operation, result, verified.recommendations);
    operation.committed = true;
    operation.payloadHash = payloadHash;
    operation.resolve(result);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const operations = [...this.operations.values()];
    for (const operation of operations) operation.abort();
    await Promise.allSettled(operations.map(operation => operation.finished));
    this.drafts.clear();
    this.questionDrafts.clear();
    await this.executor.close();
  }
}
