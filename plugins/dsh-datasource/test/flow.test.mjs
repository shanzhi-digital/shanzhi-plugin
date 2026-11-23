import test from 'node:test';
import assert from 'node:assert/strict';
import { DatasourceFlow } from '../flow.js';
import { DatasourceStore } from '../store.js';

const id = 'source-a';
const clone = value => structuredClone(value);
const execution = (sessionId, signal) => ({ agent: { session: { id: sessionId } }, signal });
const conflict = { status: 409 };
const latch = () => Promise.withResolvers();
const table = (name, tableKind = 'table') => ({
  id: name, name, schema: 'main', tableKind, sourceComment: `${name} 原始注释`, fields: [{ name: 'id', type: 'INTEGER' }],
});

async function fixture(t, options = {}) {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => clock;
  const store = new DatasourceStore({ now });
  await store.saveSource({ id, name: '业务库', engine: 'sqlite', file: 'test-business.sqlite' });
  const question = await store.saveQuestion({ text: '订单数多少？', answer: '按唯一订单编号。' });
  let raw = [table('orders'), table('customers'), table('logs', 'virtual')];
  const observers = new Map();
  const calls = [];
  const runtime = {
    source: sourceId => store.getSource(sourceId),
    async scan(sourceId, version, { signal }) {
      calls.push(['scan', sourceId, version]);
      await runtime.scanHook?.(signal);
      signal.throwIfAborted();
      return clone(raw);
    },
    async sampleTables(sourceId, version, tables, signal) {
      calls.push(['sample', sourceId, version, tables.map(item => item.id)]);
      await runtime.sampleHook?.(signal);
      signal?.throwIfAborted();
      return new Map(tables.map(item => [item.id, { samples: [[1]], sampleStatus: 'ok', sampleTruncated: false }]));
    },
    async detectFreshness(sourceId, version, tables, signal) {
      calls.push(['freshness', sourceId, version, tables.map(item => item.id)]);
      await runtime.freshnessHook?.(signal);
      signal.throwIfAborted();
      return new Map(tables.map(item => [item.id, { status: item.tableKind === 'table' ? 'EMPTY' : 'FAILED', empty: item.tableKind === 'table' ? true : null }]));
    },
  };
  let sessionNumber = 0;
  const bridge = {
    async create() {
      const sessionId = 'session-' + ++sessionNumber;
      await bridge.createHook?.(sessionId);
      return { sessionId };
    },
    async observe({ sessionId, onEnd }) {
      assert.deepEqual(await store.findBinding(sessionId), { sourceId: id, retired: false });
      observers.set(sessionId, onEnd);
      return async () => observers.delete(sessionId);
    },
    async send(input) {
      assert.ok(observers.has(input.sessionId));
      calls.push(['send', input.sessionId]);
      return bridge.sendHook?.(input);
    },
    async cancel(sessionId) { calls.push(['cancel', sessionId]); },
    async close() { assert.equal(observers.size, 0); },
  };
  const makeFlow = () => new DatasourceFlow({ store, runtime, bridge, now, timeoutMs: 1000, ...options });
  const flow = makeFlow();
  t.after(() => flow.close());
  const state = () => flow.get(id);
  const action = async (name, input = {}, signal) => flow.action({ id, action: name, revision: (await state()).revision, ...input }, signal);
  const task = (sessionId, operation, input = {}, signal) => flow.task({ operation, ...input }, execution(sessionId, signal));
  let operationNumber = 0;
  const start = async (name = 'suggest', input = { questionIds: [question.id] }, signal) => {
    const sent = latch();
    bridge.sendHook = ({ sessionId, text, signal: sendSignal }) => sent.resolve({ sessionId, text, sendSignal });
    const operationId = 'operation-' + ++operationNumber;
    const originalAnalyses = name === 'generalize-question' ? (await state()).questions.filter(item => input.questions.some(reference => reference.id === item.id) && ['missing', 'stale'].includes(item.analysisStatus)).map(item => ({ questionId: item.id, links: [] })) : undefined;
    const pending = action(name, { operationId, ...input }, signal);
    const { sessionId, text, sendSignal } = await Promise.race([sent.promise, pending.then(() => assert.fail('应等待提交'))]);
    const tool = (operation, values, toolSignal) => task(sessionId, operation, values, toolSignal);
    return { sessionId, text, sendSignal, operationId, pending, originalAnalyses, tool, readAll: () => readAll(tool), submit: (result, toolSignal) => tool('submit', { result }, toolSignal) };
  };
  const readAll = async tool => {
    const pages = [];
    let cursor = 0;
    do {
      const page = await tool('read', { cursor });
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return pages;
  };
  const recommendation = {
    recommendations: [{ tableId: 'orders', reason: '记录订单编号' }],
    analyses: [{ questionId: question.id, links: [{ tableId: 'orders', fields: ['id'], reason: '按唯一订单编号计数' }] }],
  };
  const classification = {
    domains: [{ name: '销售', description: '订单和客户' }],
    classifications: [
      { tableId: 'orders', category: 'BUSINESS', domain: '销售', reason: '订单业务' },
      { tableId: 'customers', category: 'BUSINESS', domain: '销售', reason: '客户资料' },
      { tableId: 'logs', category: 'SYSTEM', domain: '', reason: '运行日志' },
    ],
  };
  const suggest = async () => {
    const sent = latch();
    bridge.sendHook = ({ sessionId }) => sent.resolve(sessionId);
    const pending = action('suggest', { questionIds: [question.id] });
    const result = await Promise.race([pending.then(value => ({ value })), sent.promise.then(sessionId => ({ sessionId }))]);
    if (result.value) return result.value;
    const tool = (operation, input) => task(result.sessionId, operation, input);
    await readAll(tool);
    await tool('submit', { result: recommendation });
    return pending;
  };
  return { store, flow, makeFlow, bridge, runtime, state, action, task, readAll, start, suggest, observers, calls, question, recommendation, classification,
    advance: ms => { clock += ms; }, setTables: tables => { raw = tables; } };
}

const candidate = value => ({ text: value, answer: '', links: [{ tableId: 'orders', fields: ['id'], reason: '统计订单规模' }] });
const candidates = { reason: '当前目录只有订单和客户编号，能可靠支持的问题有限。', candidates: [
  candidate('每月订单数是多少？'),
  candidate('各客户的订单数是多少？'),
  candidate('订单数量如何变化？'),
] };

const generalize = async f => {
  if (!(await f.state()).catalog) await f.action('scan');
  return f.start('generalize-question', { questions: [{ id: f.question.id, version: f.question.version }] });
};

async function questionDraft(f) {
  const run = await generalize(f);
  await run.readAll();
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
  return (await run.pending).questionDraft;
}

test('33 张表分两次 read，未读完不接受提交', async t => {
  const f = await fixture(t);
  const tables = Array.from({ length: 33 }, (_, index) => table('table-' + index));
  f.setTables(tables);
  await f.action('scan');
  const run = await f.start();
  const first = await run.tool('read');
  assert.equal(first.tables.length, 20);
  assert.equal(first.nextCursor, 1);
  await assert.rejects(run.submit({ recommendations: [], analyses: [{ questionId: f.question.id, links: [] }] }), /读完全部目录/);
  const second = await run.tool('read', { cursor: first.nextCursor });
  assert.equal(second.tables.length, 13);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.tables, ...second.tables].map(item => item.id), tables.map(item => item.id));
  await run.submit({ recommendations: [], analyses: [{ questionId: f.question.id, links: [] }] });
  await run.pending;
});

test('泛化读取全目录及原始问题习惯，保存原题空成果并生成带依据候选草稿', async t => {
  const f = await fixture(t);
  const other = await f.store.saveQuestion({ text: '客户规模多少？' });
  const before = await f.store.listQuestions(id);
  const run = await generalize(f);
  assert.match(run.text, /15 至 20/);
  assert.match(run.text, /不得复制或生成答案/);
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses }), /读完全部目录/);
  const page = await run.tool('read');
  assert.equal(page.kind, 'generalize-question');
  assert.deepEqual(page.questions, [{ id: f.question.id, text: f.question.text, answer: f.question.answer, origin: 'original', sourceQuestionId: null }]);
  assert.deepEqual(page.originalAnalysisQuestions, [{ id: f.question.id, text: f.question.text, answer: f.question.answer }]);
  assert.deepEqual(page.habitQuestions, [{ id: other.id, text: other.text, answer: other.answer }]);
  assert.equal(page.existingQuestions.length, 2);
  assert.equal(page.tables.length, 3);
  assert.equal(page.nextCursor, null);
  await assert.rejects(run.tool('read', { cursor: 1 }), /游标/);
  await assert.rejects(run.submit({ recommendations: [], analyses: [{ questionId: f.question.id, links: [] }] }), /泛化结果/);
  await assert.rejects(run.submit({ candidates: candidates.candidates.slice(0, 2) }), /不足 15/);
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses, candidates: Array.from({ length: 21 }, (_, i) => candidate('候选' + i)) }), /数量过多/);
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses, candidates: candidates.candidates.map(item => ({ ...item, answer: f.question.answer })) }), /答案必须为空/);
  const submitted = await Promise.all([run.submit({ ...candidates, originalAnalyses: run.originalAnalyses }), run.submit({ ...candidates, originalAnalyses: run.originalAnalyses })]);
  assert.ok(submitted.every(item => item.draftReady === true && item.originalAnalysesPersisted === true && item.candidatesPersisted === false && !Object.hasOwn(item, 'persisted')));
  assert.equal(submitted.filter(item => item.duplicate).length, 1);
  const state = await run.pending;
  assert.ok(state.catalog);
  assert.deepEqual(state.questionDraft.questions, [{ id: f.question.id, version: f.question.version }]);
  assert.equal(state.questionDraft.reason, candidates.reason);
  assert.equal(state.questionDraft.sampleNote, '未读取业务样例，本次仅依据表结构生成。');
  assert.deepEqual(state.questionDraft.sampleResults, []);
  assert.deepEqual(state.questionDraft.candidates.map(({ id: candidateId, ...item }) => { assert.equal(typeof candidateId, 'string'); return item; }), candidates.candidates);
  assert.equal(new Set(state.questionDraft.candidates.map(item => item.id)).size, 3);
  assert.deepEqual(await f.store.listQuestions(id), before.map(question => ({ ...question, analysisStatus: question.id === f.question.id ? 'empty' : 'missing' })));
  assert.ok(f.calls.every(([kind]) => kind !== 'sample'));
});

test('泛化拒绝无目录及 generated、unknown、缺失来源问题', async t => {
  const f = await fixture(t);
  await assert.rejects(f.action('generalize-question', { questions: [{ id: f.question.id, version: f.question.version }] }), /刷新数据源目录/);
  await f.action('scan');
  const list = f.store.listQuestions.bind(f.store);
  for (const origin of ['generated', 'unknown', undefined]) {
    f.store.listQuestions = async (...args) => (await list(...args)).map(item => ({ ...item, origin }));
    await assert.rejects(f.action('generalize-question', { questions: [{ id: f.question.id, version: f.question.version }] }), /只有原始问题/);
  }
  f.store.listQuestions = list;
  assert.ok(f.calls.every(([kind]) => kind !== 'send'));
});

test('泛化读完所有目录后才可采样提交，校验真实表字段与重复问题并保留成功采样状态', async t => {
  const f = await fixture(t);
  f.setTables([table('orders'), ...Array.from({ length: 32 }, (_, index) => table('topic-' + index))]);
  const other = await f.store.saveQuestion({ text: '已有客户问题' });
  const run = await generalize(f);
  const first = await run.tool('read');
  assert.equal(first.tables.length, 20);
  await assert.rejects(run.tool('sample', { tableIds: ['orders'] }), /读完全部目录/);
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses }), /读完全部目录/);
  const second = await run.tool('read', { cursor: 1 });
  assert.equal(second.tables.length, 13);
    assert.deepEqual(second.questions, []);
    assert.deepEqual(second.originalAnalysisQuestions, []);
    assert.deepEqual(second.habitQuestions, []);
  assert.deepEqual(second.existingQuestions, []);
  const invalid = async item => run.submit({ reason: candidates.reason, candidates: [item] });
  await assert.rejects(invalid({ ...candidate('新问题'), links: [] }), /至少需要一个有效依据/);
  await assert.rejects(invalid({ ...candidate('新问题'), links: [{ tableId: 'unknown', fields: ['id'], reason: '统计规模' }] }), /未知表/);
  await assert.rejects(invalid({ ...candidate('新问题'), links: [{ tableId: 'orders', fields: ['invented'], reason: '统计规模' }] }), /未知/);
  await assert.rejects(invalid({ ...candidate('新问题'), links: [{ tableId: 'orders', fields: [], reason: '统计规模' }] }), /真实字段/);
  await assert.rejects(invalid(candidate(other.text)), /重复/);
  await assert.rejects(invalid(candidate(f.question.text)), /重复/);
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses, candidates: [candidate('ＮＥＷ'), candidate('new')] }), /重复/);
  await run.tool('sample', { tableIds: ['orders'] });
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
  const state = await run.pending;
  assert.match(state.questionDraft.sampleNote, /已读取业务样例/);
  assert.deepEqual(state.questionDraft.sampleResults, [{ tableId: 'orders', sampleStatus: 'ok', sampleTruncated: false }]);
});

test('泛化可确认20条有依据候选，15条起无需不足说明，前端不能覆盖依据且不复制父关联', async t => {
  const f = await fixture(t);
  await f.action('scan');
  await f.suggest();
  const run = await generalize(f);
  await run.readAll();
  const values = Array.from({ length: 20 }, (_, index) => candidate('独立问题' + index));
  await run.submit({ originalAnalyses: run.originalAnalyses, candidates: values });
  const draft = (await run.pending).questionDraft;
  const schema = f.flow.getTool().parameters.properties.result.properties;
  assert.equal(schema.candidates.maxItems, 20);
  assert.equal(schema.candidates.items.properties.links.minItems, 1);
  assert.deepEqual(schema.analyses.items.required, ['questionId', 'links']);
  assert.deepEqual(schema.originalAnalyses.items.required, ['questionId', 'links']);
  assert.equal(Object.hasOwn(schema, 'links'), false);
  const edited = draft.candidates.map(({ id, text }) => ({ id, text }));
  await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ ...edited[0], links: [{ tableId: 'invented' }] }] }), /格式无效/);
  const result = await f.action('confirm-question-draft', { draftId: draft.id, candidates: edited });
  assert.equal(result.questions.length, 21);
  assert.ok(result.questions.filter(item => item.id !== f.question.id).every(item => item.origin === 'generated' && item.sourceQuestionId === f.question.id && item.links.length === 1 && item.links[0].questionVersion === item.version));
  assert.equal(result.questions.find(item => item.id === f.question.id).links.length, 1);
});

test('泛化采样失败如实保留状态，允许依据表结构形成少量候选', async t => {
  const f = await fixture(t);
  const run = await generalize(f);
  await run.readAll();
  f.runtime.sampleHook = () => { throw new Error('样例读取失败'); };
  await assert.rejects(run.tool('sample', { tableIds: ['orders'] }), /样例读取失败/);
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses, candidates: [candidates.candidates[0]] });
  const state = await run.pending;
  assert.match(state.questionDraft.sampleNote, /读取失败/);
  assert.deepEqual(state.questionDraft.sampleResults, [{ tableId: 'orders', sampleStatus: 'failed' }]);
});

test('泛化候选确认仅接受已有唯一候选，可编辑文本并选择 1 至 20 个，确认后返回新增问题', async t => {
  const f = await fixture(t);
  const draft = await questionDraft(f);
  const first = draft.candidates[0];
  const confirm = entries => f.action('confirm-question-draft', { draftId: draft.id, candidates: entries });
  await assert.rejects(confirm([]), /1 至 20/);
  await assert.rejects(confirm([{ id: 'unknown', text: '新问题' }]), /未知/);
  await assert.rejects(confirm([{ id: first.id, text: first.text }, { id: first.id, text: '另一问题' }]), /重复/);
  await assert.rejects(confirm([{ id: first.id, text: ' ' }]), /格式无效/);
  await assert.rejects(confirm([{ id: first.id, text: first.text, answer: '不可保存答案' }]), /格式无效/);
  assert.equal((await f.store.listQuestions()).length, 1);
  const confirmed = await confirm([{ id: first.id, text: '用户修订后的每月订单数量？' }]);
  assert.equal(confirmed.questionDraft, null);
  assert.equal(confirmed.questions.length, 2);
  assert.equal(confirmed.questions.find(item => item.id !== f.question.id).text, '用户修订后的每月订单数量？');
  assert.equal(confirmed.questions.find(item => item.id !== f.question.id).answer, '');
  const linked = confirmed.questions.find(item => item.id !== f.question.id);
  assert.equal(linked.links[0].questionVersion, 0);
  assert.equal(linked.links[0].tableId, 'orders');
  assert.deepEqual((await f.store.listQuestions(id)).find(item => item.id === linked.id).links, linked.links);
  const reopened = f.makeFlow();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(id)).questions.find(item => item.id === linked.id).links, linked.links);
  await assert.rejects(confirm([{ id: first.id, text: first.text }]), conflict);
});

test('可确认五个泛化候选，批次重复文本失败后保留草稿供修正', async t => {
  const f = await fixture(t);
  const run = await generalize(f);
  await run.readAll();
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses, candidates: [...candidates.candidates, candidate('各渠道的订单数是多少？'), candidate('每天有多少订单？')] });
  const draft = (await run.pending).questionDraft;
  const values = draft.candidates.map(({ id: candidateId, text }) => ({ id: candidateId, text }));
  const duplicate = values.map(item => ({ ...item }));
  duplicate[4].text = duplicate[0].text;
  await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: duplicate }), conflict);
  assert.equal((await f.state()).questions.length, 1);
  assert.equal((await f.state()).questionDraft.id, draft.id);
  const result = await f.action('confirm-question-draft', { draftId: draft.id, candidates: values });
  assert.equal(result.questions.length, 6);
  assert.ok(result.questions.filter(item => item.id !== f.question.id).every(item => item.answer === ''));
  assert.equal(result.questionDraft, null);
});

test('同一问题草稿并发确认只接受一次，即使第二次使用不同编辑文本', async t => {
  const f = await fixture(t);
  const draft = await questionDraft(f), first = draft.candidates[0];
  const original = f.store.change.bind(f.store), entered = latch(), release = latch();
  f.store.change = (sourceId, callback) => original(sourceId, async (...params) => {
    entered.resolve();
    await release.promise;
    return callback(...params);
  });
  const pending = f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: first.id, text: '第一次确认的订单问题' }] });
  await entered.promise;
  await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: first.id, text: '第二次确认的不同问题' }] }), /正在确认/);
  release.resolve();
  const result = await pending;
  f.store.change = original;
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions.find(item => item.id !== f.question.id).text, '第一次确认的订单问题');
});

test('问题编辑、源状态版本变化和确认取消均拒绝泛化草稿，失败不写入候选', async t => {
  const f = await fixture(t);
  let draft = await questionDraft(f);
  await f.store.saveQuestion({ ...f.question, answer: '更新的答案' });
  assert.equal((await f.state()).questionDraft, null);
  await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: '不应保存的问题' }] }), conflict);
  f.question.version++;
  draft = await questionDraft(f);
  f.setTables([table('orders'), table('customers'), table('logs', 'virtual'), table('new-table')]);
  await f.action('scan');
  await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: '目录变化后不应保存' }] }), conflict);
  draft = await questionDraft(f);
  const original = f.store.change.bind(f.store), entered = latch(), release = latch();
  f.store.change = (sourceId, callback) => original(sourceId, (state, source, now, tx) => callback(state, source, now, {
    ...tx,
    async saveQuestions(input) {
      const result = await tx.saveQuestions(input);
      entered.resolve();
      await release.promise;
      return result;
    },
  }));
  const controller = new AbortController();
  const pending = assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: '取消后不应保存' }] }, controller.signal), /取消/);
  await entered.promise;
  controller.abort();
  release.resolve();
  await pending;
  f.store.change = original;
  assert.equal((await f.store.listQuestions()).length, 1);
  const source = await f.runtime.source(id);
  const disabled = await f.store.setSourceEnabled(id, false, source.revision);
  await f.flow.sourceChanged(id, disabled);
  assert.equal(f.flow.questionDrafts.size, 0);
  assert.equal((await f.state()).questionDraft, null);
});

test('泛化生成保留选表草稿，取消问题草稿不影响选表草稿，运行取消使用原信号', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const selected = await f.suggest();
  const draft = await questionDraft(f);
  const generated = await f.state();
  assert.deepEqual(generated.draft, selected.draft);
  assert.deepEqual(generated.questions, selected.questions);
  const canceled = await f.flow.action({ id, action: 'cancel', questionDraftId: draft.id });
  assert.equal(canceled.questionDraft, null);
  assert.deepEqual(canceled.draft, selected.draft);
  const controller = new AbortController();
  const run = await f.start('generalize-question', { questions: [{ id: f.question.id, version: f.question.version }] }, controller.signal);
  controller.abort();
  assert.equal(run.sendSignal.aborted, true);
  await assert.rejects(run.pending, /取消/);
  assert.equal((await f.state()).questionDraft, null);
  assert.equal((await f.store.listQuestions()).length, 1);
});

test('泛化读取的原问题版本在生成草稿前再次校验，超时清理会话，关闭清理草稿', async t => {
  const f = await fixture(t, { timeoutMs: 100 });
  const stale = await generalize(f);
  await stale.readAll();
  await f.store.saveQuestion({ ...f.question, answer: '已修改的统计口径。' });
  await assert.rejects(stale.submit({ ...candidates, originalAnalyses: stale.originalAnalyses }), /问题已更新/);
  await f.flow.action({ id, action: 'cancel', operationId: stale.operationId });
  await assert.rejects(stale.pending, /取消/);
  f.question.version++;
  const timeout = await generalize(f);
  await assert.rejects(timeout.pending, /超时/);
  assert.equal(f.observers.size, 0);
  const draft = await questionDraft(f);
  assert.ok(draft);
  await f.flow.close();
  assert.equal(f.flow.questionDrafts.size, 0);
  assert.equal((await f.store.listQuestions()).length, 1);
});

test('目录保持内容 ID，自动刷新更新时钟，失败保留最后一次目录', async t => {
  const f = await fixture(t);
  assert.equal((await f.state()).catalog, null);
  const first = await f.action('ensure-scan', { open: true });
  assert.deepEqual(first.addedTableIds, ['orders', 'customers', 'logs']);
  assert.ok(first.catalog.tables.every(item => !item.enabled && item.freshness === null));
  f.advance(29_999);
  await f.action('ensure-scan', { open: true });
  f.advance(1);
  await f.action('ensure-scan', { open: false });
  assert.equal(f.calls.length, 1);
  const second = await f.action('ensure-scan', { open: true });
  assert.equal(second.catalog.id, first.catalog.id);
  assert.equal(second.revision, first.revision);
  assert.notEqual(second.catalog.scannedAt, first.catalog.scannedAt);
  assert.deepEqual(second.addedTableIds, []);
  f.advance(30 * 60_000);
  f.runtime.scanHook = async () => { throw new Error('模拟扫描失败'); };
  await assert.rejects(f.action('ensure-scan', { open: false }), /模拟扫描失败/);
  assert.deepEqual((await f.state()).catalog, second.catalog);
  assert.ok(f.calls.every(([kind]) => kind === 'scan'));
});

test('重扫保留表启停，失效变化表的时效和关联，并报告目录差异', async t => {
  const f = await fixture(t);
  await f.action('scan');
  await f.action('set-tables', { tableIds: ['orders', 'customers'], enabled: true });
  const detected = await f.action('detect-freshness');
  assert.deepEqual(f.calls.at(-1)[3], ['orders', 'customers', 'logs']);
  assert.equal(detected.catalog.tables[0].freshness.status, 'EMPTY');
  const suggested = await f.suggest();
  assert.equal(suggested.questions[0].links.length, 1);
  const changed = table('orders');
  changed.fields.push({ name: 'amount', type: 'NUMERIC' });
  f.setTables([changed, table('customers'), table('shipments')]);
  const updated = await f.action('scan');
  assert.notEqual(updated.catalog.id, detected.catalog.id);
  assert.deepEqual(updated.catalog.tables.map(item => [item.id, item.enabled, item.freshness?.status ?? null]), [
    ['orders', true, null], ['customers', true, 'EMPTY'], ['shipments', false, null],
  ]);
  assert.deepEqual(updated.addedTableIds, ['shipments']);
  assert.deepEqual(updated.changedTableIds, ['orders']);
  assert.deepEqual(updated.removedTableIds, ['logs']);
  assert.deepEqual(updated.questions[0].links, []);
  assert.equal(updated.draft, null);
});

test('业务域覆盖完整目录，不采样且保留表启停', async t => {
  const f = await fixture(t);
  await f.action('scan');
  await f.action('set-tables', { tableIds: ['customers'], enabled: true });
  const run = await f.start('detect-domains', {});
  assert.match(run.text, /先从全库推断.*然后/);
  await assert.rejects(run.submit(f.classification), /读完全部目录/);
  await assert.rejects(run.tool('read', { cursor: '1' }), /游标/);
  await assert.rejects(run.tool('sample', { tableIds: ['orders'] }), /只.*辅助选表/);
  const last = await run.tool('read', { cursor: 0 });
  assert.equal(last.tables.length, 3);
  assert.equal(last.nextCursor, null);
  await assert.rejects(run.submit({ ...f.classification, classifications: [] }), /全部/);
  const unknown = clone(f.classification);
  unknown.classifications[0].domain = '不存在';
  await assert.rejects(run.submit(unknown), /业务域/);
  assert.equal((await f.state()).domains.length, 0);
  await run.submit(f.classification);
  const value = await run.pending;
  assert.deepEqual(value.domains, f.classification.domains);
  assert.deepEqual(value.catalog.domains, value.domains);
  assert.deepEqual(value.catalog.tables.map(item => [item.enabled, item.category, item.domain]), [
    [false, 'BUSINESS', '销售'], [true, 'BUSINESS', '销售'], [false, 'SYSTEM', ''],
  ]);
  assert.ok(f.calls.every(([kind]) => kind !== 'sample'));
  const sends = f.calls.filter(([kind]) => kind === 'send').length;
  f.bridge.create = () => assert.fail('仅业务域不应创建会话');
  const domainDraft = (await f.action('suggest', { domains: ['销售'] })).draft;
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, sends);
  assert.deepEqual(domainDraft.selectedTableIds, ['orders', 'customers']);
  assert.deepEqual(domainDraft.domainMatches, [{ tableId: 'orders', domain: '销售' }, { tableId: 'customers', domain: '销售' }]);
});

test('选表默认勾选取此前启用、所选业务域和 AI 推荐的并集', async t => {
  const f = await fixture(t);
  await f.action('scan');
  await f.action('set-tables', { tableIds: ['customers'], enabled: true });
  const detect = await f.start('detect-domains', {});
  await detect.readAll();
  const classified = clone(f.classification);
  classified.classifications[1] = { tableId: 'customers', category: 'UNKNOWN', domain: '', reason: '未确定业务归属' };
  await detect.submit(classified);
  await detect.pending;
  const run = await f.start('suggest', { questionIds: [f.question.id], domains: ['销售'] });
  await run.readAll();
  await run.submit({ recommendations: [{ tableId: 'logs', reason: '所选业务需要核对日志' }], analyses: [{ questionId: f.question.id, links: [] }] });
  const state = await run.pending;
  assert.deepEqual(state.draft.selectedTableIds, ['orders', 'customers', 'logs']);
  assert.deepEqual(state.draft.domainMatches, [{ tableId: 'orders', domain: '销售' }]);
  assert.deepEqual(state.catalog.tables.filter(item => item.enabled).map(item => item.id), ['customers']);
});

test('推荐读取选中问题，样例仅限本次普通表，并以已启用表与推荐的并集确认', async t => {
  const f = await fixture(t);
  await f.action('scan');
  await f.action('set-tables', { tableIds: ['customers'], enabled: true });
  await assert.rejects(f.action('suggest', { questionIds: [] }), /至少选择/);
  const run = await f.start();
  const pages = await run.readAll();
  assert.deepEqual(pages[0].questions, [{ id: f.question.id, text: f.question.text, answer: f.question.answer }]);
  assert.equal(pages[0].source.name, '业务库');
  assert.deepEqual(pages.flatMap(page => page.tables.map(item => item.id)), ['orders', 'customers', 'logs']);
  await assert.rejects(run.tool('sample', { tableIds: ['unknown'] }), /未知/);
  await assert.rejects(run.tool('sample', { tableIds: ['logs'] }), /普通表/);
  await assert.rejects(run.tool('read', { tableIds: ['orders'] }), /输入/);
  const sampled = await run.tool('sample', { tableIds: ['orders'] });
  assert.deepEqual(sampled.tables[0].samples, [[1]]);
  const wrong = clone(f.recommendation);
  wrong.analyses[0].links[0].fields = ['unknown'];
  await assert.rejects(run.submit(wrong), /字段/);
  await assert.rejects(run.submit({ ...f.recommendation, recommendations: [f.recommendation.recommendations[0], f.recommendation.recommendations[0]] }), /重复表/);
  const results = await Promise.all([run.submit(f.recommendation), run.submit(f.recommendation)]);
  assert.equal(results.filter(item => item.duplicate).length, 1);
  const suggested = await run.pending;
  assert.equal(suggested.sessionId, run.sessionId);
  assert.deepEqual(suggested.draft.tableIds, ['orders', 'customers', 'logs']);
  assert.deepEqual(suggested.draft.selectedTableIds, ['orders', 'customers']);
  assert.deepEqual(suggested.catalog.tables.filter(item => item.enabled).map(item => item.id), ['customers']);
  assert.equal(suggested.questions[0].links[0].tableId, 'orders');
  const confirmed = await f.action('confirm-selection', { draftId: suggested.draft.id, selectedTableIds: ['orders'] });
  assert.equal(confirmed.draft, null);
  assert.deepEqual(confirmed.catalog.tables.filter(item => item.enabled).map(item => item.id), ['orders']);
  assert.equal(confirmed.questions[0].links.length, 1);
});

test('取消草稿保留问题关联和启停，问题编辑与表状态变更使确认冲突', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const { draft } = await f.suggest();
  const canceled = await f.flow.action({ id, action: 'cancel', draftId: draft.id });
  assert.equal(canceled.draft, null);
  assert.equal(canceled.questions[0].links.length, 1);
  assert.ok(canceled.catalog.tables.every(item => !item.enabled));
  const pending = await f.suggest();
  await f.action('set-tables', { tableIds: ['customers'], enabled: true });
  await assert.rejects(f.action('confirm-selection', { draftId: pending.draft.id, selectedTableIds: ['orders'] }), conflict);
  const updated = await f.suggest();
  await f.store.saveQuestion({ ...f.question, answer: '已更改。' });
  await assert.rejects(f.action('confirm-selection', { draftId: updated.draft.id, selectedTableIds: ['orders'] }), conflict);
  assert.deepEqual((await f.state()).catalog.tables.filter(item => item.enabled).map(item => item.id), ['customers']);
});

test('只有当前绑定会话可读写工具，普通 SQL 永远拒绝该绑定', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const run = await f.start();
  const delegated = (args, exec) => ({ args, exec });
  const unbound = execution('unbound');
  assert.deepEqual(await f.flow.scopedSql('sql_list', {}, unbound, delegated), { args: {}, exec: unbound });
  for (const name of ['sql_list', 'sql_schema', 'sql_query']) await assert.rejects(f.flow.scopedSql(name, {}, execution(run.sessionId), delegated), /只可使用 datasource_task/);
  await assert.rejects(f.task('unbound', 'read'), /接入会话/);
  await assert.rejects(f.action('detect-domains'), conflict);
  await f.flow.action({ id, action: 'cancel', operationId: 'stale-operation' });
  await run.readAll();
  assert.equal(run.sendSignal.aborted, false);
  await f.flow.action({ id, action: 'cancel', operationId: run.operationId });
  assert.equal(run.sendSignal.aborted, true);
  await assert.rejects(run.pending, /取消/);
  await assert.rejects(run.submit(f.recommendation), /接入会话/);
  assert.deepEqual(await f.store.findBinding(run.sessionId), { sourceId: id, retired: true });
  const restarted = f.makeFlow();
  t.after(() => restarted.close());
  await assert.rejects(restarted.task({ operation: 'read' }, execution(run.sessionId)), /接入会话/);
  await assert.rejects(restarted.scopedSql('sql_query', {}, execution(run.sessionId), delegated), /只可使用 datasource_task/);
});

test('原生会话在发送返回前提交时正常完成，其他结束和超时会释放监听', async t => {
  const f = await fixture(t, { timeoutMs: 100 });
  await f.action('scan');
  f.bridge.sendHook = async ({ sessionId }) => {
    await f.readAll((op, input) => f.task(sessionId, op, input));
    await f.task(sessionId, 'submit', { result: f.recommendation });
  };
  const early = await f.action('suggest', { questionIds: [f.question.id] });
  assert.ok(early.draft);
  await f.store.saveQuestion({ ...f.question, answer: '更新问题，后续检查重新分析的会话生命周期。' });
  const ended = await f.start();
  f.observers.get(ended.sessionId)();
  await assert.rejects(ended.pending, /未提交/);
  const failed = await f.start();
  await failed.tool('fail');
  await assert.rejects(failed.pending, /未能形成/);
  const timeout = await f.start();
  await assert.rejects(timeout.pending, /超时/);
  assert.equal(f.observers.size, 0);
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 4);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 3);
});

test('提交在事务中再次校验信号与问题版本，失败可重试且不会半保存', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const run = await f.start();
  await run.readAll();
  const original = f.store.change.bind(f.store);
  const entered = latch(), release = latch();
  f.store.change = (sourceId, callback) => original(sourceId, async (...params) => {
    entered.resolve();
    await release.promise;
    return callback(...params);
  });
  const controller = new AbortController();
  const submitted = assert.rejects(run.submit(f.recommendation, controller.signal), /取消/);
  await entered.promise;
  controller.abort();
  release.resolve();
  await submitted;
  f.store.change = original;
  assert.deepEqual((await f.state()).questions[0].links, []);
  await f.store.saveQuestion({ ...f.question, answer: '不同答案。' });
  await assert.rejects(run.submit(f.recommendation), /问题已更新/);
  await f.flow.action({ id, action: 'cancel', operationId: run.operationId });
  await assert.rejects(run.pending, /取消/);
  const fresh = await f.suggest();
  assert.equal(fresh.questions[0].links[0].questionVersion, f.question.version + 1);
});

test('取消与已经完成的持久化竞争时确认成功，并保留草稿', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const run = await f.start();
  await run.readAll();
  const original = f.store.change.bind(f.store);
  const persisted = latch(), release = latch();
  f.store.change = async (sourceId, callback) => {
    const result = await original(sourceId, callback);
    persisted.resolve();
    await release.promise;
    return result;
  };
  const submitting = run.submit(f.recommendation);
  await persisted.promise;
  const canceling = f.flow.action({ id, action: 'cancel', operationId: run.operationId });
  release.resolve();
  assert.equal((await submitting).persisted, true);
  assert.ok((await run.pending).draft);
  await canceling;
  assert.ok((await f.state()).draft);
  assert.ok(f.calls.every(([kind]) => kind !== 'cancel'));
});

test('停用取消运行并拒绝晚到提交，目录仍可读且表启停可保存', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const run = await f.start();
  await run.readAll();
  const before = await f.runtime.source(id);
  const disabled = await f.store.setSourceEnabled(id, false, before.revision);
  await f.flow.sourceChanged(id, disabled);
  await assert.rejects(run.pending, /取消/);
  await assert.rejects(run.submit(f.recommendation), /接入会话/);
  assert.equal((await f.state()).enabled, false);
  await assert.rejects(f.action('scan'), /停用/);
  const saved = await f.action('set-tables', { tableIds: ['orders'], enabled: true });
  assert.equal(saved.catalog.tables[0].enabled, true);
  assert.deepEqual(saved.questions[0].links, []);
});

test('缓存问题全部有效时不创建会话，关联跨业务域并按确认启停', async t => {
  const f = await fixture(t);
  const draft = await questionDraft(f);
  const result = await f.action('confirm-question-draft', {
    draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: ` ${draft.candidates[0].text} ` }],
  });
  const question = result.questions.find(item => item.id !== f.question.id);
  assert.equal(question.links[0].questionVersion, question.version);
  const detect = await f.start('detect-domains', {});
  await detect.readAll();
  const classification = clone(f.classification);
  classification.domains.push({ name: '客户', description: '客户资料' });
  classification.classifications[1].domain = '客户';
  await detect.submit(classification);
  await detect.pending;
  f.bridge.create = () => assert.fail('完整缓存不应创建会话');
  const cached = await f.action('suggest', { questionIds: [question.id], domains: ['客户'] });
  assert.equal(cached.sessionId, undefined);
  assert.deepEqual(cached.draft.recommendations, [{ tableId: 'orders', reason: '统计订单规模' }]);
  assert.deepEqual(cached.draft.selectedTableIds, ['orders', 'customers']);
  const confirmed = await f.action('confirm-selection', { draftId: cached.draft.id, selectedTableIds: ['orders'] });
  assert.equal(confirmed.catalog.tables.find(item => item.id === 'orders').enabled, true);
});

test('缓存选表事务异常直接返回，取消及源停用仍阻止草稿与确认', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const first = await f.suggest();
  await f.flow.action({ id, action: 'cancel', draftId: first.draft.id });
  f.bridge.create = () => assert.fail('完整缓存不应创建会话');
  const original = f.store.change.bind(f.store);
  f.store.change = () => { throw new Error('缓存校验失败'); };
  await assert.rejects(f.action('suggest', { questionIds: [f.question.id] }), /缓存校验失败/);
  assert.equal((await f.state()).draft, null);
  f.store.change = original;
  const controller = new AbortController();
  const entered = latch(), release = latch();
  f.store.change = (sourceId, callback) => original(sourceId, async (...args) => {
    entered.resolve();
    await release.promise;
    return callback(...args);
  });
  const pending = assert.rejects(f.action('suggest', { questionIds: [f.question.id] }, controller.signal), /取消/);
  await entered.promise;
  controller.abort();
  release.resolve();
  await pending;
  f.store.change = original;
  assert.equal((await f.state()).draft, null);
  const cached = await f.action('suggest', { questionIds: [f.question.id] });
  const source = await f.store.getSource(id);
  const disabled = await f.store.setSourceEnabled(id, false, source.revision);
  await f.flow.sourceChanged(id, disabled);
  await assert.rejects(f.action('confirm-selection', { draftId: cached.draft.id, selectedTableIds: ['orders'] }), conflict);
  await assert.rejects(f.action('suggest', { questionIds: [f.question.id] }), /停用/);
});

test('混合选表只发送缺失问题，合并缓存依据且不覆盖原关联，确认校验全部问题', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const cachedState = await f.suggest();
  const cachedLinks = clone(cachedState.questions[0].links);
  const missing = await f.store.saveQuestion({ text: '客户有多少？' });
  const run = await f.start('suggest', { questionIds: [f.question.id, missing.id] });
  const [page] = await run.readAll();
  assert.deepEqual(page.questions.map(item => item.id), [missing.id]);
  await run.submit({ recommendations: [{ tableId: 'customers', reason: '客户规模' }], analyses: [{ questionId: missing.id, links: [{ tableId: 'customers', fields: ['id'], reason: '客户编号' }] }] });
  const result = await run.pending;
  assert.deepEqual(result.draft.selectedTableIds, ['orders', 'customers']);
  assert.deepEqual(result.draft.recommendations.map(item => item.tableId), ['orders', 'customers']);
  assert.deepEqual(result.questions.find(item => item.id === f.question.id).links, cachedLinks);
  await f.store.saveQuestion({ ...f.question, text: '修改缓存问题的文本' });
  await assert.rejects(f.action('confirm-selection', { draftId: result.draft.id, selectedTableIds: result.draft.selectedTableIds }), conflict);
});

test('编辑候选、问题版本及任一表结构变化均使整个问题重新分析', async t => {
  for (const mode of ['candidate', 'version', 'structure', 'removed', 'partial']) {
    const f = await fixture(t);
    let question = f.question;
    if (mode === 'candidate') {
      const draft = await questionDraft(f);
      const confirmed = await f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: '编辑后的新问题' }] });
      question = confirmed.questions.find(item => item.id !== f.question.id);
      assert.equal(question.links[0].questionVersion, 0);
    } else {
      await f.action('scan');
      const state = await f.state();
      await f.store.replaceQuestionLinks(id, [{ id: question.id, version: question.version }], ['orders', 'customers'].map(tableId => ({ questionId: question.id, tableId, fields: ['id'], reason: `${tableId} 依据` })), { catalogId: state.catalog.id, connectionVersion: state.connectionVersion });
      if (mode === 'version') await f.store.saveQuestion({ ...question, answer: '修改分析口径' });
      else if (mode === 'partial') {
        const list = f.store.listQuestions.bind(f.store);
        f.store.listQuestions = async sourceId => (await list(sourceId)).map(item => ({ ...item, links: item.links.map((link, index) => index === 0 ? { ...link, structureHash: 'obsolete' } : link) }));
      } else {
        const changed = table('orders');
        changed.fields.push({ name: 'amount', type: 'NUMERIC' });
        f.setTables(mode === 'removed' ? [table('customers'), table('logs', 'virtual')] : [changed, table('customers'), table('logs', 'virtual')]);
        await f.action('scan');
      }
    }
    const run = await f.start('suggest', { questionIds: [question.id] });
    const [page] = await run.readAll();
    assert.deepEqual(page.questions.map(item => item.id), [question.id], mode);
    await run.submit({ recommendations: [{ tableId: 'customers', reason: '新依据' }], analyses: [{ questionId: question.id, links: [{ tableId: 'customers', fields: ['id'], reason: '重新分析客户编号' }] }] });
    const result = await run.pending;
    const current = result.questions.find(item => item.id === question.id);
    assert.deepEqual(current.links.map(item => item.tableId), ['customers'], mode);
    assert.equal(current.links[0].questionVersion, current.version, mode);
  }
});

test('泛化关联保存失败回滚新增问题并保留草稿，修复后可重试', async t => {
  const f = await fixture(t);
  const draft = await questionDraft(f);
  const before = await f.store.listQuestions(id);
  const original = f.store.change.bind(f.store);
  f.store.change = (sourceId, callback) => original(sourceId, (state, source, now, tx) => callback(state, source, now, {
    ...tx,
    async replaceQuestionLinks(...args) {
      await tx.replaceQuestionLinks(...args);
      throw new Error('关联写入失败');
    },
  }));
  const input = { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: draft.candidates[0].text }] };
  await assert.rejects(f.action('confirm-question-draft', input), /关联写入失败/);
  assert.deepEqual(await f.store.listQuestions(id), before);
  assert.equal((await f.state()).questionDraft.id, draft.id);
  f.store.change = original;
  const confirmed = await f.action('confirm-question-draft', input);
  assert.equal(confirmed.questions.length, 2);
  assert.equal(confirmed.questions.find(item => item.id !== f.question.id).links.length, 1);
});

test('停用期间才取得的会话 ID 会被绑定并退役，旧状态无法访问普通 SQL', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const creating = latch(), release = latch();
  f.bridge.createHook = async sessionId => { creating.resolve(sessionId); await release.promise; };
  const pending = assert.rejects(f.action('suggest', { questionIds: [f.question.id] }), /取消|失效/);
  const sessionId = await creating.promise;
  const before = await f.runtime.source(id);
  const disabled = await f.store.setSourceEnabled(id, false, before.revision);
  await f.flow.sourceChanged(id, disabled);
  release.resolve();
  await pending;
  assert.deepEqual(await f.store.findBinding(sessionId), { sourceId: id, retired: true });
  await assert.rejects(f.flow.scopedSql('sql_query', {}, execution(sessionId), () => assert.fail('不得执行旧会话请求')), /只可使用 datasource_task/);
  assert.ok(f.calls.every(([kind]) => kind !== 'send'));
});

test('多原问题共同参考，习惯排除全部已选项，整批保存不指定唯一来源', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const second = await f.store.saveQuestion({ text: '按客户统计服务情况', answer: '按客户编号分组' });
  const habit = await f.store.saveQuestion({ text: '比较各月变化趋势' });
  const references = [f.question, second].map(({ id, version }) => ({ id, version }));
  const run = await f.start('generalize-question', { questions: references });
  assert.match(run.text, /不按参考原问题数量倍增/);
  const page = await run.tool('read');
  assert.deepEqual(page.questions.map(({ id }) => id), references.map(({ id }) => id));
  assert.deepEqual(page.habitQuestions.map(({ id }) => id), [habit.id]);
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
  const draft = (await run.pending).questionDraft;
  assert.deepEqual(draft.questions, references);
  const state = await f.action('confirm-question-draft', { draftId: draft.id, candidates: draft.candidates.map(({ id, text }) => ({ id, text })) });
  const created = state.questions.filter(question => question.origin === 'generated');
  assert.equal(created.length, candidates.candidates.length);
  assert.ok(created.every(question => question.sourceQuestionId === null && question.links.length === 1 && question.links[0].questionVersion === question.version));
});

for (const phase of ['generation', 'confirmation']) for (const mutation of ['update', 'delete']) {
  test(`多参考的第二项${mutation}阻止${phase}并且不保存候选`, async t => {
    const f = await fixture(t);
    await f.action('scan');
    const second = await f.store.saveQuestion({ text: '第二个参考原问题' });
    const run = await f.start('generalize-question', { questions: [f.question, second].map(({ id, version }) => ({ id, version })) });
    await run.readAll();
    let draft;
    if (phase === 'confirmation') { await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses }); draft = (await run.pending).questionDraft; }
    if (mutation === 'update') await f.store.saveQuestion({ ...second, answer: '第二个参考已更新' });
    else await f.store.removeQuestion(second.id, second.version);
    if (phase === 'generation') {
      const pending = assert.rejects(run.pending, /取消/);
      await assert.rejects(run.submit({ ...candidates, originalAnalyses: run.originalAnalyses }), /更新|删除|失效/);
      await f.action('cancel', { operationId: run.operationId });
      await pending;
    } else {
      assert.equal((await f.state()).questionDraft, null);
      await assert.rejects(f.action('confirm-question-draft', { draftId: draft.id, candidates: draft.candidates.map(({ id, text }) => ({ id, text })) }), /更新|删除|失效/);
    }
    assert.equal((await f.store.listQuestions(id)).filter(question => question.origin === 'generated').length, 0);
  });
}

test('多原问题泛化拒绝空参考、重复参考和第二项非原问题', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const reference = { id: f.question.id, version: f.question.version };
  await assert.rejects(f.action('generalize-question', { questions: [] }), /至少选择/);
  await assert.rejects(f.action('generalize-question', { questions: [reference, reference] }), /重复/);
  const second = await f.store.saveQuestion({ text: '非原问题' });
  const list = f.store.listQuestions.bind(f.store);
  f.store.listQuestions = async (...args) => (await list(...args)).map(question => question.id === second.id ? { ...question, origin: 'generated' } : question);
  await assert.rejects(f.action('generalize-question', { questions: [reference, { id: second.id, version: second.version }] }), /只有原始问题/);
});

test('普通选表要求每个待分析问题显式完成，拒绝遗漏、重复、未知问题及旧协议', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const second = await f.store.saveQuestion({ text: '客户信息如何统计？' });
  const run = await f.start('suggest', { questionIds: [f.question.id, second.id] });
  await run.readAll();
  const empty = questionId => ({ questionId, links: [] });
  for (const analyses of [undefined, [], [empty(f.question.id)], [empty(f.question.id), empty(f.question.id)], [empty(f.question.id), empty('unknown')]]) {
    await assert.rejects(run.submit({ recommendations: [], analyses }), /逐题分析/);
  }
  await assert.rejects(run.submit({ recommendations: [], links: [] }), /选表结果/);
  assert.ok((await f.state()).questions.every(question => question.analysisStatus === 'missing'));
  await run.submit({ recommendations: [], analyses: [empty(f.question.id), empty(second.id)] });
  const result = await run.pending;
  assert.ok(result.questions.every(question => question.analysisStatus === 'empty'));
  assert.deepEqual(result.draft.recommendations, []);
});

test('泛化只补所选缺失和失效原题，恰好覆盖且保留已有有效成果，取消候选保留原题', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const linked = (await f.suggest()).questions[0];
  const stale = await f.store.saveQuestion({ text: '旧客户口径？' });
  const missing = await f.store.saveQuestion({ text: '没有可靠业务关系？', answer: '请保留这份答案。' });
  const unselected = await f.store.saveQuestion({ text: '未选择的问题？' });
  const state = await f.state();
  await f.store.replaceQuestionLinks(id, [{ id: stale.id, version: stale.version }], [{ questionId: stale.id, tableId: 'customers', fields: ['id'], reason: '旧客户依据' }], { catalogId: state.catalog.id, connectionVersion: state.connectionVersion });
  const updated = await f.store.saveQuestion({ ...stale, answer: '更新后的口径' });
  const references = [linked, updated, missing].map(({ id, version }) => ({ id, version }));
  const run = await f.start('generalize-question', { questions: references });
  const [page] = await run.readAll();
  assert.deepEqual(page.originalAnalysisQuestions, [updated, missing].map(({ id, text, answer }) => ({ id, text, answer })));
  const analyses = [{ questionId: updated.id, links: [{ tableId: 'customers', fields: ['id'], reason: '新客户口径' }] }, { questionId: missing.id, links: [] }];
  for (const originalAnalyses of [undefined, [], [analyses[0]], [analyses[0], analyses[0]], [{ questionId: linked.id, links: [] }, analyses[1]]]) {
    await assert.rejects(run.submit({ ...candidates, originalAnalyses }), /原题分析/);
  }
  await assert.rejects(run.submit({ ...candidates, originalAnalyses: [{ questionId: updated.id, links: [{ tableId: 'invented', fields: ['id'], reason: '无效' }] }, analyses[1]] }), /未知表/);
  const response = await run.submit({ ...candidates, originalAnalyses: analyses });
  assert.deepEqual(response, { ok: true, originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false });
  const result = await run.pending;
  assert.deepEqual(result.questions.find(question => question.id === linked.id).links, linked.links);
  assert.equal(result.questions.find(question => question.id === updated.id).analysisStatus, 'linked');
  assert.equal(result.questions.find(question => question.id === missing.id).analysisStatus, 'empty');
  assert.equal(result.questions.find(question => question.id === missing.id).answer, missing.answer);
  assert.equal(result.questions.find(question => question.id === unselected.id).analysisStatus, 'missing');
  const canceled = await f.action('cancel', { questionDraftId: result.questionDraft.id });
  assert.equal(canceled.questionDraft, null);
  assert.equal(canceled.questions.length, 4);
  assert.equal(canceled.questions.find(question => question.id === missing.id).analysisStatus, 'empty');
  assert.equal(canceled.questions.find(question => question.id === updated.id).links[0].reason, '新客户口径');
  const cached = await f.action('suggest', { questionIds: [missing.id] });
  assert.deepEqual(cached.draft.recommendations, []);
});

test('泛化原题成果写入失败原子回滚，不产生候选草稿，修复后重试成功', async t => {
  const f = await fixture(t);
  const run = await generalize(f);
  await run.readAll();
  const before = await f.state();
  const original = f.store.change.bind(f.store);
  f.store.change = (sourceId, callback) => original(sourceId, (state, source, now, tx) => callback(state, source, now, {
    ...tx,
    async replaceQuestionLinks(...args) { await tx.replaceQuestionLinks(...args); throw new Error('原题成果写入失败'); },
  }));
  const result = { ...candidates, originalAnalyses: run.originalAnalyses };
  await assert.rejects(run.submit(result), /原题成果写入失败/);
  assert.equal((await f.state()).revision, before.revision);
  assert.equal((await f.state()).questions[0].analysisStatus, 'missing');
  assert.equal((await f.state()).questionDraft, null);
  f.store.change = original;
  await run.submit(result);
  assert.equal((await run.pending).questions[0].analysisStatus, 'empty');
});

test('有效空分析在重建 flow 后免 AI 复用，识别业务域保留空成果', async t => {
  const f = await fixture(t);
  const run = await generalize(f);
  await run.readAll();
  await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
  await run.pending;
  const reopened = f.makeFlow();
  t.after(() => reopened.close());
  const before = await reopened.get(id);
  assert.equal(before.questions[0].analysisStatus, 'empty');
  const sends = f.calls.filter(([kind]) => kind === 'send').length;
  const cached = await reopened.action({ id, action: 'suggest', revision: before.revision, questionIds: [f.question.id] });
  assert.deepEqual(cached.draft.recommendations, []);
  assert.deepEqual(cached.draft.selectedTableIds, []);
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, sends);
  const detect = await f.start('detect-domains', {});
  await detect.readAll();
  await detect.submit(f.classification);
  assert.equal((await detect.pending).questions[0].analysisStatus, 'empty');
  const again = await f.action('suggest', { questionIds: [f.question.id] });
  assert.deepEqual(again.draft.recommendations, []);
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, sends + 1);
});

test('原题空成果在问题、目录或连接变化后重新进入分析', async t => {
  for (const mutation of ['question', 'catalog', 'connection']) {
    const f = await fixture(t);
    const run = await generalize(f);
    await run.readAll();
    await run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
    await run.pending;
    if (mutation === 'question') await f.store.saveQuestion({ ...f.question, answer: '新的统计口径' });
    else if (mutation === 'catalog') {
      f.setTables([table('orders'), table('customers'), table('logs', 'virtual'), table('new-table')]);
      await f.action('scan');
    } else {
      const source = await f.store.getSource(id);
      await f.store.saveSource(source, source.revision, { credentialChanged: true });
      await f.action('scan');
    }
    assert.notEqual((await f.state()).questions[0].analysisStatus, 'empty', mutation);
    const fresh = await f.start();
    const [page] = await fresh.readAll();
    assert.deepEqual(page.questions.map(question => question.id), [f.question.id], mutation);
    await fresh.submit({ recommendations: [], analyses: [{ questionId: f.question.id, links: [] }] });
    assert.equal((await fresh.pending).questions[0].analysisStatus, 'empty', mutation);
  }
});

test('泛化原题事务提交后遇到取消仍成功生成草稿，不虚报失败', async t => {
  const f = await fixture(t);
  const run = await generalize(f);
  await run.readAll();
  const original = f.store.change.bind(f.store), persisted = latch(), release = latch();
  f.store.change = async (sourceId, callback) => {
    const result = await original(sourceId, callback);
    persisted.resolve();
    await release.promise;
    return result;
  };
  const submitting = run.submit({ ...candidates, originalAnalyses: run.originalAnalyses });
  await persisted.promise;
  const canceling = f.action('cancel', { operationId: run.operationId });
  release.resolve();
  assert.equal((await submitting).originalAnalysesPersisted, true);
  const state = await run.pending;
  await canceling;
  assert.equal(state.questions[0].analysisStatus, 'empty');
  assert.ok(state.questionDraft);
  assert.ok((await f.state()).questionDraft);
  assert.ok(f.calls.every(([kind]) => kind !== 'cancel'));
});
