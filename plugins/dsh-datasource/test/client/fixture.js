/* Isolated browser fixture. All datasource, schema, question and session values here are synthetic. */
(() => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const sources = [
    { id: 'fixture-mysql', name: '测试业务库', engine: 'mysql', description: '仅用于客户端测试', host: '127.0.0.1', port: 3306, user: 'fixture_user', database: 'fixture_business', hasPassword: true },
    { id: 'fixture-sqlite', name: '测试本地库', engine: 'sqlite', file: 'D:/fixture/local.sqlite', hasPassword: false },
  ];
  const initial = (id) => ({ id, revision: 0, defaultCwd: 'D:/fixture/host-workspace', questions: Array.from({ length: 12 }, (_, index) => ({ id: `q${index + 1}`, text: `测试问题 ${index + 1}：统计第 ${index + 1} 类业务记录。`, kind: index < 2 ? 'original' : 'expanded', selected: true })), tables: [], relations: [], runs: [], confirmations: { tables: false, relations: false }, rangeCurrent: false });
  const fixture = window.__fixture = { items: window.__fixtureEmpty ? [] : clone(sources), states: Object.fromEntries(sources.map((item) => [item.id, initial(item.id)])), calls: [], sessions: [], registered: [], aborted: 0, stateReads: 0, failNextAction: null, delayNextState: false, noWorkspace: false };
  let questionCounter = 12, runCounter = 0;
  const fields = [
    { id: 'table-orders', name: 'orders', description: '测试订单表', selected: true, fields: [{ name: 'id', type: 'INTEGER', description: '订单标识', selected: true }, { name: 'customer_id', type: 'INTEGER', description: '客户标识', selected: true }, { name: 'note', type: 'TEXT', description: '备注', selected: true }] },
    { id: 'table-customers', name: 'customers', description: '测试客户表', selected: true, fields: [{ name: 'id', type: 'INTEGER', description: '客户标识', selected: true }, { name: 'region', type: 'TEXT', description: '地区', selected: true }] },
  ];
  const rangeRun = (state) => [...state.runs].reverse().find((run) => run.kind === 'range');
  const populate = (state, run) => {
    state.rangeCurrent = true;
    if (!state.tables.length) state.tables = clone(fields);
    if (!state.relations.length) state.relations = [{ id: 'relation-orders-customer', leftTable: 'table-orders', leftField: 'customer_id', rightTable: 'table-customers', rightField: 'id', type: 'many-to-one', description: '测试分析建议', selected: false, needsSourceReview: false, sourceQuestions: [], proposals: [{ runId: run.id, sourceQuestions: run.questionSnapshot.map(({ id, text }) => ({ questionId: id, textAtSnapshot: text })) }] }];
  };
  fixture.completeQuestions = (id = 'fixture-mysql') => {
    const state = fixture.states[id], run = [...state.runs].reverse().find((candidate) => candidate.kind === 'questions');
    run.status = 'succeeded'; run.batches.forEach((batch) => { batch.status = 'succeeded'; });
    for (const question of run.questionSnapshot) state.questions.push({ id: `q${++questionCounter}`, text: question.text, kind: 'original', selected: false });
    state.revision++;
  };
  fixture.finishRange = (failed = false, id = 'fixture-mysql') => {
    const state = fixture.states[id], run = rangeRun(state);
    run.status = failed ? 'partial' : 'succeeded';
    run.batches.forEach((batch, index) => { batch.status = failed && index === 1 ? 'failed' : 'succeeded'; batch.error = failed && index === 1 ? 'fixture 模型错误，可重试。' : null; batch.sessionId ||= `fixture-session-${run.id}-${index}`; });
    populate(state, run); state.revision++;
  };
  fixture.bump = (id = 'fixture-mysql') => { fixture.states[id].revision++; };
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
  window.fetch = async (url, options = {}) => {
    const operation = String(url).split('/').at(-1), payload = options.body ? JSON.parse(options.body) : undefined;
    fixture.calls.push({ operation, payload: clone(payload || {}), method: options.method, credentials: options.credentials, cache: options.cache });
    if (options.signal?.aborted) throw abortError();
    if (operation === 'list') return response({ items: fixture.items });
    if (operation === 'test') return response({ ok: true, message: 'fixture 连接测试成功。' });
    if (operation === 'save') {
      const previous = fixture.items.find((item) => item.id === payload.id), item = { ...previous, ...payload, id: payload.id || `fixture-created-${fixture.items.length}`, hasPassword: payload.clearPassword ? false : !!payload.password || !!previous?.hasPassword };
      delete item.password; delete item.clearPassword;
      fixture.items = previous ? fixture.items.map((candidate) => candidate.id === item.id ? item : candidate) : [...fixture.items, item];
      fixture.states[item.id] ||= initial(item.id); return response({ item });
    }
    if (operation === 'remove') { fixture.items = fixture.items.filter((item) => item.id !== payload.id); delete fixture.states[payload.id]; return response({ ok: true }); }
    const state = fixture.states[payload.id];
    if (!state) return response({ error: 'fixture 数据源不存在。' }, 404);
    if (operation === 'flow-state') {
      fixture.stateReads++;
      if (fixture.delayNextState) {
        fixture.delayNextState = false;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 1200);
          options.signal?.addEventListener('abort', () => { clearTimeout(timeout); fixture.aborted++; reject(abortError()); }, { once: true });
        });
      }
      return response({ state });
    }
    if (operation !== 'flow-action') throw new Error(`Unexpected fixture request: ${operation}`);
    if (fixture.failNextAction === payload.action) { fixture.failNextAction = null; state.revision++; return response({ error: 'fixture revision 已变化。' }, 409); }
    if (payload.revision !== state.revision) return response({ error: 'fixture revision 冲突。' }, 409);
    if (payload.action === 'organize') {
      const snapshot = payload.text.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text, index) => ({ id: `input-${index}`, text }));
      const id = `run-${++runCounter}`;
      state.runs.push({ id, kind: 'questions', status: 'running', cwd: payload.cwd || state.defaultCwd, createdAt: new Date().toISOString(), questionSnapshot: snapshot, batches: [{ id: `${id}-batch-0`, index: 1, status: 'running', attempts: 1, sessionId: `fixture-session-${id}-0`, questions: snapshot }] });
    } else if (payload.action === 'save-questions') {
      state.questions = payload.questions.map((question) => ({ ...question, id: question.id || `q${++questionCounter}` }));
      state.rangeCurrent = false; state.confirmations = { tables: false, relations: false };
      state.relations.forEach((relation) => { if (relation.selected) relation.needsSourceReview = true; });
    } else if (payload.action === 'analyze') {
      const snapshot = state.questions.filter((question) => question.selected).map(({ id, text }) => ({ id, text })), id = `run-${++runCounter}`, batches = [];
      for (let index = 0; index < snapshot.length; index += payload.batchSize) batches.push({ id: `${id}-batch-${batches.length}`, index: batches.length + 1, status: index ? 'queued' : 'running', attempts: index ? 0 : 1, sessionId: index ? null : `fixture-session-${id}-0`, questions: snapshot.slice(index, index + payload.batchSize) });
      state.runs.push({ id, kind: 'range', status: 'running', cwd: payload.cwd || state.defaultCwd, createdAt: new Date().toISOString(), questionSnapshot: snapshot, batches }); state.rangeCurrent = false; state.confirmations = { tables: false, relations: false };
    } else if (payload.action === 'retry') {
      const run = state.runs.find((candidate) => candidate.id === payload.runId), batch = run.batches.find((candidate) => candidate.id === payload.batchId);
      batch.status = 'queued'; batch.attempts++; batch.error = null; run.status = 'running';
    } else if (payload.action === 'cancel') {
      const run = state.runs.find((candidate) => candidate.id === payload.runId); run.status = 'canceled'; run.batches.forEach((batch) => { if (['queued', 'dispatching', 'running'].includes(batch.status)) batch.status = 'canceled'; });
      if (run.kind === 'range') state.rangeCurrent = false;
    } else if (payload.action === 'save-tables') { state.tables = clone(payload.tables); state.confirmations = { tables: false, relations: false }; }
    else if (payload.action === 'save-relations') {
      state.relations = payload.relations.map((relation) => { const previous = state.relations.find((candidate) => candidate.id === relation.id); return { ...relation, sourceQuestions: previous.sourceQuestions, proposals: previous.proposals, needsSourceReview: relation.selected && (!previous.selected || previous.leftTable !== relation.leftTable || previous.leftField !== relation.leftField || previous.rightTable !== relation.rightTable || previous.rightField !== relation.rightField || previous.type !== relation.type || previous.needsSourceReview) }; }); state.confirmations = { tables: false, relations: false };
    } else if (payload.action === 'review-relation') {
      const relation = state.relations.find((candidate) => candidate.id === payload.relationId); relation.needsSourceReview = false; relation.sourceQuestions = rangeRun(state).questionSnapshot.map(({ id, text }) => ({ questionId: id, textAtSnapshot: text }));
    } else if (payload.action === 'confirm-tables' || payload.action === 'confirm-relations') {
      if (!state.rangeCurrent || payload.action === 'confirm-relations' && state.relations.some((relation) => relation.selected && relation.needsSourceReview)) return response({ error: 'fixture 需要有效范围和关系来源复核。' }, 409);
      if (payload.action === 'confirm-tables') state.confirmations.tables = true;
      else { if (!state.confirmations.tables) return response({ error: 'fixture 请先确认表范围。' }, 400); state.confirmations.relations = true; }
    } else throw new Error(`Unexpected flow action: ${payload.action}`);
    state.revision++; return response({ state });
  };
  let root, Page;
  fixture.render = () => { root ||= ReactDOM.createRoot(document.getElementById('root')); root.render(React.createElement(Page)); };
  fixture.unmount = () => root?.unmount();
  window.__ModuleLoader__ = { load(definition) {
    fixture.loaderId = definition.id;
    const plugin = definition.factory((name) => { if (name !== 'react') throw new Error(`Unexpected client dependency: ${name}`); return React; });
    fixture.plugin = { name: plugin.name, inject: plugin.inject };
    plugin.apply({ slots: { inject(name, callback) { callback(); }, register(slot, component) { fixture.registered.push(slot); if (slot.name === 'main') Page = component; } }, get(name) { if (name === 'uiWorkspace' && !fixture.noWorkspace) return { openSession(id) { fixture.sessions.push(id); } }; } });
    fixture.render();
  } };
})();
