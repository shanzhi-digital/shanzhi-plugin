/* The browser fixture serves synthetic data entirely in memory. */
(() => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const instant = () => new Date().toISOString();
  const sources = [
    { id: 'fixture-mysql', name: '测试业务库', engine: 'mysql', description: '测试订单数据', host: '127.0.0.1', port: 3306, user: 'fixture_user', database: 'fixture_business', hasPassword: true, enabled: true },
    { id: 'fixture-sqlite', name: '测试本地库', engine: 'sqlite', file: 'D:/fixture/local.sqlite', enabled: false },
    { id: 'fixture-pg', name: '测试报表库', engine: 'postgres', enabled: true },
    ...Array.from({ length: 10 }, (_, index) => ({ id: `extra-${index}`, name: `备用源 ${index + 1}`, engine: 'sqlite', file: `D:/fixture/${index}.sqlite`, enabled: false })),
  ].map((item) => ({ revision: 1, connectionVersion: 1, tableCount: null, createdAt: instant(), ...item }));
  const questions = Array.from({ length: 12 }, (_, index) => ({ id: `q${index + 1}`, text: `测试问题 ${String(index + 1).padStart(2, '0')}`, answer: '', origin: 'original', sourceQuestionId: null, version: 1, links: [] }));
  const initial = (item) => ({ id: item.id, revision: 0, connectionVersion: item.connectionVersion, enabled: item.enabled, catalog: null, draft: null, questionDraft: null });
  const fixture = window.__fixture = {
    items: window.__fixtureEmpty ? [] : clone(sources), states: Object.fromEntries(sources.map((item) => [item.id, initial(item)])),
    questions, analysisRecords: [], originalAnalysisLinks: {}, suggestionLinks: {}, aiResults: [], candidateCount: 3, calls: [], sessions: [], registered: [], stateReads: 0, holdActions: new Set(), pending: new Map(), added: [],
    failNextAction: null, failSourceId: null, failRemoveIds: new Set(), failQuestionRemoveIds: new Set(), connectionFailures: { 'fixture-pg': '无法连接报表库。' },
    management: { configured: !window.__fixtureUnconfigured, ready: !window.__fixtureUnconfigured, settings: { host: '127.0.0.1', port: 3306, database: 'fixture_management', user: 'fixture_manager' } },
  };
  let questionCounter = 12, sourceCounter = 0, snapshotCounter = 0;
  const field = (name, type, sourceComment, primaryKey = false) => ({ name, type, sourceComment, primaryKey, notNull: primaryKey });
  const table = (id, name, sourceComment, fields) => ({ id, name, schema: 'main', tableKind: 'table', sourceComment, fields, structureHash: id, enabled: false, freshness: null });
  const basicTables = () => [
    table('table-orders', 'orders', '测试订单表', [field('id', 'INTEGER', '订单标识', true), field('note', 'TEXT', '订单备注')]),
    table('table-customers', 'customers', '测试客户表', [field('id', 'INTEGER', '客户标识', true)]),
    table('table-log', 'audit_log', '系统日志', [field('event', 'TEXT', '事件')]),
    ...Array.from({ length: 20 }, (_, index) => table(`table-extra-${index}`, `archive_${String(index + 1).padStart(2, '0')}`, `历史归档 ${index + 1}`, [field('id', 'INTEGER', '归档标识')])),
  ];
  const readSource = (id) => fixture.items.find((item) => item.id === id);
  const questionAnalysisStatus = (question, sourceId) => {
    const state = fixture.states[sourceId], catalog = state?.catalog;
    const links = question.links.filter((link) => link.sourceId === sourceId);
    if (links.length) return links.every((link) => link.questionVersion === question.version
      && catalog?.tables.some((table) => table.id === link.tableId && table.structureHash === link.structureHash)) ? 'linked' : 'stale';
    const record = fixture.analysisRecords.find((entry) => entry.questionId === question.id && entry.sourceId === sourceId);
    if (!record) return 'missing';
    return record.questionVersion === question.version && record.connectionVersion === state.connectionVersion
      && record.catalogId === catalog?.id ? 'empty' : 'stale';
  };
  const scopedQuestions = (id) => questions.map((item) => ({ ...item, links: item.links.filter((link) => !id || link.sourceId === id),
    ...(id ? { analysisStatus: questionAnalysisStatus(item, id) } : {}) }));
  const persistAnalysis = (question, sourceId, links) => {
    const state = fixture.states[sourceId];
    question.links = [...question.links.filter((link) => link.sourceId !== sourceId), ...links.map((link) => ({ ...clone(link), sourceId,
      structureHash: state.catalog.tables.find((table) => table.id === link.tableId).structureHash,
      questionVersion: question.version, analyzedAt: instant() }))];
    fixture.analysisRecords = fixture.analysisRecords.filter((entry) => entry.questionId !== question.id || entry.sourceId !== sourceId);
    fixture.analysisRecords.push({ questionId: question.id, sourceId, questionVersion: question.version,
      connectionVersion: state.connectionVersion, catalogId: state.catalog.id });
  };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const failure = (error, status) => response({ error }, status);
  const stateResponse = (state, extras = {}, sessionId) => response({ state: { ...state, questions: scopedQuestions(state.id), ...extras }, ...(sessionId ? { sessionId } : {}) });
  const abortError = () => new DOMException('Aborted', 'AbortError');
  const cancel = (payload, state) => {
    fixture.pending.get(payload.operationId)?.cancel();
    if (state.draft?.id === payload.draftId) state.draft = null;
    if (state.questionDraft?.id === payload.questionDraftId) state.questionDraft = null;
    return stateResponse(state);
  };
  const freshness = (status, empty, values = {}) => ({ status, empty, scannedAt: instant(), ...values });
  const execute = (payload, state) => {
    const { action, id } = payload;
    if (action === 'scan' || action === 'ensure-scan') {
      if (action === 'ensure-scan' && Date.now() - Date.parse(state.catalog?.scannedAt) < (payload.open ? 30_000 : 30 * 60_000)) return stateResponse(state);
      const existing = state.catalog?.tables || basicTables();
      const added = fixture.added.splice(0).map((name) => table(`fixture-added-${name}`, name, '新业务表', [field('id', 'INTEGER', '标识')]));
      state.catalog = { id: `snapshot-${++snapshotCounter}`, scannedAt: instant(), tables: [...existing, ...added], domains: state.catalog?.domains || [] };
      readSource(id).tableCount = state.catalog.tables.length;
      state.revision++;
      return stateResponse(state, { addedTableIds: added.map(({ id }) => id), removedTableIds: [], changedTableIds: [] });
    }
    if (action === 'set-tables' || action === 'confirm-selection') {
      if (action === 'confirm-selection' && state.draft?.id !== payload.draftId) return failure('推荐结果已失效。', 409);
      for (const item of state.catalog.tables) {
        if (action === 'set-tables' && payload.tableIds.includes(item.id)) item.enabled = payload.enabled;
        if (action === 'confirm-selection' && state.draft.tableIds.includes(item.id)) item.enabled = payload.selectedTableIds.includes(item.id);
      }
      state.draft = null;
    } else if (action === 'detect-freshness') {
      for (const item of state.catalog.tables) {
        if (item.id === 'table-orders') item.freshness = freshness('OK', false, { lastDataAt: new Date(Date.now() - 86_400_000).toISOString(), hasTimezone: true, timeColumn: 'updated_at' });
        else if (item.id === 'table-customers') item.freshness = freshness('EMPTY', true);
        else if (item.id === 'table-log') item.freshness = freshness('NO_TIME_COLUMN', false);
        else item.freshness = freshness('OK', false, { lastDataAt: '2100-01-01', dateOnly: true, hasTimezone: false });
      }
    } else if (action === 'detect-domains') {
      state.catalog.domains = [{ name: '订单业务', description: '业务订单记录' }, { name: '客户业务', description: '业务客户记录' }];
      state.catalog.tables[0].domain = '订单业务';
      state.catalog.tables[2].category = 'SYSTEM';
    } else if (action === 'generalize-question') {
      if (!Array.isArray(payload.questions) || !payload.questions.length) return failure('请选择原问题。', 400);
      const selected = payload.questions.map(({ id }) => questions.find((question) => question.id === id));
      if (selected.some((question, index) => !question || question.version !== payload.questions[index].version)) return failure('问题已更新。', 409);
      if (selected.some(({ origin }) => origin !== 'original')) return failure('仅原问题支持泛化。', 400);
      const originalAnalysisQuestions = selected.filter((question) => ['missing', 'stale'].includes(questionAnalysisStatus(question, id)));
      const originalAnalyses = originalAnalysisQuestions.map((question) => ({ questionId: question.id,
        links: fixture.originalAnalysisLinks[question.id] || [{ tableId: 'table-orders', fields: ['id', 'note'], reason: '依据订单标识和订单备注分析订单。' }] }));
      for (const analysis of originalAnalyses) persistAnalysis(questions.find((question) => question.id === analysis.questionId), id, analysis.links);
      fixture.aiResults.push({ action, read: { originalAnalysisQuestions: originalAnalysisQuestions.map(({ id, text, answer }) => ({ id, text, answer })) },
        result: { originalAnalyses: clone(originalAnalyses) }, reply: { ok: true, originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false } });
      state.questionDraft = { id: `question-draft-${state.revision}`, questions: clone(payload.questions),
        reason: fixture.candidateCount < 15 ? '当前表结构只支持这些有区别的问题。' : '', sampleNote: '未采样，仅依据表结构。',
        candidates: Array.from({ length: fixture.candidateCount }, (_, index) => ({ id: `candidate-${index + 1}`, text: `${selected[0].text} 泛化 ${index + 1}`, answer: '',
          links: [{ tableId: 'table-orders', fields: ['id', 'note'], reason: '依据订单标识和订单备注分析订单。' }] })) };
      fixture.aiResults.at(-1).result.candidates = clone(state.questionDraft.candidates);
    } else if (action === 'confirm-question-draft') {
      const draft = state.questionDraft;
      if (draft?.id !== payload.draftId) return failure('泛化候选已失效。', 409);
      if (draft.questions.some(({ id, version }) => questions.find((question) => question.id === id)?.version !== version)) return failure('问题已更新。', 409);
      if (!payload.candidates.length || payload.candidates.length > 20) return failure('请选择 1–20 个问题。', 400);
      for (const candidate of payload.candidates) {
        const original = draft.candidates.find(({ id }) => id === candidate.id);
        if (!original) return failure('泛化候选已失效。', 409);
        const text = candidate.text.trim();
        const links = original.links.map((link) => ({ ...link, sourceId: id,
          structureHash: state.catalog.tables.find(({ id }) => id === link.tableId)?.structureHash,
          questionVersion: text === original.text.trim() ? 1 : 0, analyzedAt: instant() }));
        questions.push({ id: `q${++questionCounter}`, text, answer: '', origin: 'generated', sourceQuestionId: draft.questions.length === 1 ? draft.questions[0].id : null, version: 1, links });
      }
      state.questionDraft = null;
    } else if (action === 'suggest') {
      const selected = questions.filter(({ id }) => payload.questionIds.includes(id));
      const pending = selected.filter((question) => ['missing', 'stale'].includes(questionAnalysisStatus(question, id)));
      const analyses = pending.map((question) => ({ questionId: question.id, links: fixture.suggestionLinks[question.id]
        || [{ tableId: 'table-customers', fields: ['id'], reason: '匹配客户统计' }] }));
      for (const analysis of analyses) persistAnalysis(questions.find((question) => question.id === analysis.questionId), id, analysis.links);
      const recommendations = [...new Map(selected.flatMap((question) => question.links.filter((link) => link.sourceId === id)
        .map(({ tableId, reason }) => [tableId, { tableId, reason }]))).values()];
      if (pending.length || (payload.domains || []).length) fixture.aiResults.push({ action,
        read: { questions: pending.map(({ id, text, answer }) => ({ id, text, answer })) }, result: { recommendations: clone(recommendations), analyses: clone(analyses) } });
      const domainMatches = state.catalog.tables.filter((table) => (payload.domains || []).includes(table.domain)).map((table) => ({ tableId: table.id, domain: table.domain }));
      state.draft = { id: `draft-${state.revision}`, catalogId: state.catalog.id, tableIds: state.catalog.tables.map(({ id }) => id),
        selectedTableIds: [...new Set([...state.catalog.tables.filter(({ enabled }) => enabled).map(({ id }) => id),
          ...domainMatches.map(({ tableId }) => tableId), ...recommendations.map(({ tableId }) => tableId)])], domainMatches, recommendations };
    } else throw new Error(`Unexpected fixture action: ${action}`);
    state.revision++;
    return stateResponse(state, {}, ['suggest', 'detect-domains'].includes(action) ? 'fixture-session' : undefined);
  };
  window.fetch = async (url, options = {}) => {
    const operation = String(url).split('/').at(-1), payload = options.body ? JSON.parse(options.body) : undefined;
    fixture.calls.push({ operation, payload: clone(payload || {}), method: options.method });
    if (options.signal?.aborted) throw abortError();
    if (operation === 'management-status') return response(fixture.management);
    if (operation === 'management-save') {
      const { password, ...settings } = payload;
      fixture.management = { configured: true, ready: true, settings };
      return response(fixture.management);
    }
    if (operation === 'list') return response({ items: fixture.items });
    if (operation === 'test') {
      const message = Object.keys(payload).length === 1 && fixture.connectionFailures[payload.id];
      return response(message ? { ok: false, message } : { ok: true, message: '连接成功。' });
    }
    if (operation === 'save') {
      const { password, clearPassword, ...metadata } = payload;
      const previous = readSource(payload.id);
      if (previous && previous.revision !== payload.revision) return failure('数据源已更新。', 409);
      const changed = previous && (['engine', 'database', 'host', 'port', 'user', 'file'].some((key) => previous[key] !== metadata[key]) || !!password || clearPassword);
      const item = { enabled: true, createdAt: instant(), ...previous, ...metadata, id: payload.id || `fixture-created-${++sourceCounter}`,
        revision: (previous?.revision || 0) + 1, connectionVersion: (previous?.connectionVersion || 1) + Number(!!changed),
        hasPassword: clearPassword ? false : !!password || !!previous?.hasPassword, tableCount: changed ? null : previous?.tableCount ?? null };
      fixture.items = previous ? fixture.items.map((candidate) => candidate.id === item.id ? item : candidate) : [...fixture.items, item];
      if (!previous || changed) fixture.states[item.id] = initial(item);
      return response({ item });
    }
    if (operation === 'remove') {
      if (fixture.failRemoveIds.has(payload.id)) return failure('模拟数据源删除失败。', 500);
      if (readSource(payload.id)?.revision !== payload.revision) return failure('数据源已更新。', 409);
      fixture.items = fixture.items.filter((item) => item.id !== payload.id);
      delete fixture.states[payload.id];
      return response({ ok: true });
    }
    if (operation === 'source-status') return response({ results: payload.items.map(({ id, enabled, revision }) => {
      const item = readSource(id);
      if (id === fixture.failSourceId || item?.revision !== revision) return { id, ok: false, error: '数据源已更新。' };
      item.enabled = enabled;
      item.revision++;
      fixture.states[id].enabled = enabled;
      return { id, ok: true, item };
    }) });
    if (operation === 'questions-list') return response({ items: scopedQuestions(payload.id) });
    if (operation === 'questions-save' || operation === 'questions-remove') {
      if (operation === 'questions-remove' && fixture.failQuestionRemoveIds.has(payload.id)) return failure('模拟问题删除失败。', 500);
      const index = questions.findIndex(({ id }) => id === payload.id);
      const previous = questions[index];
      if (payload.id && previous?.version !== payload.version) return failure('问题已更新。', 409);
      if (operation === 'questions-remove') { questions.splice(index, 1); return response({ ok: true }); }
      const item = { origin: 'original', sourceQuestionId: null, ...previous, id: previous?.id || `q${++questionCounter}`, text: payload.text, answer: payload.answer, version: (previous?.version || 0) + 1, links: previous?.links || [] };
      if (previous) questions[index] = item;
      else questions.push(item);
      return response({ item });
    }
    const state = fixture.states[payload?.id];
    if (!state) return failure('数据源不存在。', 404);
    if (operation === 'flow-state') { fixture.stateReads++; return stateResponse(state); }
    if (operation === 'flow-samples') {
      const target = state.catalog.tables.find((item) => item.id === payload.tableId);
      if (!state.enabled || state.catalog.id !== payload.snapshotId) return failure('样例已失效。', 409);
      return response({ sampleStatus: target.id === 'table-orders' ? 'ok' : 'empty', fieldNames: target.fields.map(({ name }) => name), samples: target.id === 'table-orders' ? [[101, '真实样例订单']] : [] });
    }
    if (operation !== 'flow-action') throw new Error(`Unexpected fixture operation: ${operation}`);
    if (payload.action === 'cancel') return cancel(payload, state);
    if (!payload.operationId) throw new Error('Missing operationId');
    if (fixture.failNextAction === payload.action) { fixture.failNextAction = null; state.revision++; return failure('目录已更新，请重试。', 409); }
    if (payload.action !== 'ensure-scan' && payload.revision !== state.revision) return failure('目录已更新。', 409);
    if (!state.enabled && !['set-tables', 'confirm-selection'].includes(payload.action)) return failure('请先启用数据源。', 409);
    if (!fixture.holdActions.has(payload.action)) return execute(payload, state);
    return new Promise((resolve, reject) => {
      const cleanup = () => { fixture.pending.delete(payload.operationId); options.signal?.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(abortError()); };
      options.signal?.addEventListener('abort', abort, { once: true });
      fixture.pending.set(payload.operationId, { finish() { cleanup(); resolve(execute(payload, state)); }, cancel() { cleanup(); resolve(failure('操作已取消。', 499)); } });
    });
  };
  let root, Page;
  fixture.render = () => { root ||= ReactDOM.createRoot(document.getElementById('root')); root.render(React.createElement(Page)); };
  fixture.unmount = () => root?.unmount();
  window.__ModuleLoader__ = { load(definition) {
    const plugin = definition.factory((name) => { if (name !== 'react') throw new Error(`Unexpected dependency: ${name}`); return React; });
    fixture.loaderId = definition.id;
    plugin.apply({ slots: { inject(name, callback) { callback(); }, register(slot, component) { fixture.registered.push(slot); if (slot.name === 'main') Page = component; } },
      get(name) { if (name === 'uiWorkspace') return { openSession(id) { fixture.sessions.push(id); } }; } });
    fixture.render();
  } };
})();
