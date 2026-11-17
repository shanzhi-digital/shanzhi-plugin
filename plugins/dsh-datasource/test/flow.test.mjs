import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatasourceFlow } from '../flow.js';

const clone = (value) => structuredClone(value);
function latch() {
  let resolveValue;
  const promise = new Promise((done) => { resolveValue = done; });
  return { promise, resolve: resolveValue };
}
function publicFailure(pattern) {
  return (error) => { assert.match(error.publicMessage || '', pattern); return true; };
}
function execution(sessionId, signal = new AbortController().signal) {
  return { agent: { session: { id: sessionId } }, signal };
}

async function fixture(t, options = {}) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'dsh-flow-test-'));
  const filePath = join(directory, 'workflow.json');
  const calls = [];
  const configs = [
    { id: 'source-a', name: 'source-a-name', engine: 'sqlite', file: join(directory, 'a.sqlite') },
    { id: 'source-b', name: 'source-b-name', engine: 'sqlite', file: join(directory, 'b.sqlite') },
  ];
  const catalog = {
    orders: [{ name: 'id', type: 'INTEGER' }, { name: 'customer_id', type: 'INTEGER' }, { name: 'total', type: 'NUMERIC' }],
    customers: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }],
  };
  const runtime = {
    schemaHook: null,
    async list() { return clone(configs); },
    async test(input) { calls.push(['test', clone(input)]); return { ok: true }; },
    getTools() {
      return [{ name: 'sql_schema', execute: async (args, exec) => {
        calls.push(['schema', clone(args)]);
        await runtime.schemaHook?.(args, exec);
        exec?.signal?.throwIfAborted();
        assert.equal(args.connection, 'source-a-name');
        return args.table ? { table: args.table, columns: clone(catalog[args.table] || []) } : { tables: Object.keys(catalog) };
      } }];
    },
  };
  let counter = 0;
  const bridge = {
    sendHook: null,
    async create(input) { const sessionId = `isolated-session-${++counter}`; calls.push(['create', clone(input), sessionId]); return { sessionId }; },
    async send(input) {
      calls.push(['send', clone(input)]);
      // The real model may invoke tools before send returns. Identity must
      // already be durable on disk when prompt admission is triggered.
      const persisted = JSON.parse(await readFile(filePath, 'utf8'));
      assert.equal(persisted.bindings[input.sessionId].runId, input.runId);
      assert.equal(persisted.bindings[input.sessionId].batchId, input.batchId);
      if (bridge.sendHook) return bridge.sendHook(input);
      return { accepted: true };
    },
    async status(sessionId) { calls.push(['status', sessionId]); return 'running'; },
    async cancel(sessionId) { calls.push(['cancel', sessionId]); return { accepted: true }; },
    async close() { calls.push(['close']); },
  };
  const flows = [];
  function makeFlow() {
    const flow = new DatasourceFlow({ filePath, runtime, bridge, defaultCwd: directory, pollMs: 0, ...options });
    flow._kick = () => {};
    flows.push(flow);
    return flow;
  }
  const flow = makeFlow();
  t.after(async () => {
    for (const item of flows) await item.close();
    // Verify the absolute delete target is exactly our mkdtemp fixture, never
    // a profile, project directory or arbitrary computed parent.
    assert.equal(dirname(resolve(directory)), tempRoot);
    assert.ok(basename(directory).startsWith('dsh-flow-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  async function action(actionName, extra = {}, id = 'source-a') {
    const state = await flow.get(id);
    return flow.action({ id, revision: state.revision, action: actionName, ...extra });
  }
  async function batch(id = 'source-a') {
    const state = await flow.get(id);
    const run = state.runs.at(-1);
    const activeBatch = run.batches.find(item => ['dispatching', 'running'].includes(item.status));
    return { state, run, batch: activeBatch, sessionId: activeBatch?.sessionId };
  }
  async function startQuestions(text = '原始问题一', id = 'source-a') {
    await action('organize', { text }, id); await flow.pump(); return batch(id);
  }
  async function seedQuestions(texts = ['问题一']) {
    await action('save-questions', { questions: texts.map(text => ({ text, selected: true })) });
  }
  async function startRange(texts = ['问题一'], batchSize = 5) {
    await seedQuestions(texts); await action('analyze', { batchSize }); await flow.pump(); return batch();
  }
  function task(binding, operation, result, exec = execution(binding.sessionId)) {
    return flow.task({ operation, runId: binding.run.id, batchId: binding.batch.id, ...(result === undefined ? {} : { result }) }, exec);
  }
  function rangeResult(binding, { relations = false } = {}) {
    const sourceQuestionIds = binding.batch.questions.map(q => q.id);
    const tables = [{ name: 'orders', description: '订单用途', fields: ['id', 'customer_id', 'total'].map(name => ({ name, description: name + '用途' })), sourceQuestionIds }];
    if (relations) tables.push({ name: 'customers', description: '客户用途', fields: ['id', 'name'].map(name => ({ name, description: name + '用途' })), sourceQuestionIds });
    return { tables, relations: relations ? [{ leftTable: 'orders', leftField: 'customer_id', rightTable: 'customers', rightField: 'id', type: 'many-to-one', description: '客户关联', sourceQuestionIds }] : [] };
  }
  return { flow, makeFlow, filePath, directory, runtime, bridge, configs, catalog, calls, action, batch, startQuestions, seedQuestions, startRange, task, rangeResult };
}

test('CAS serializes simultaneous edits and never overwrites the first accepted edit', async (t) => {
  const { flow } = await fixture(t);
  const { revision } = await flow.get('source-a');
  const results = await Promise.allSettled(['甲', '乙'].map(text => flow.action({ id: 'source-a', revision, action: 'save-questions', questions: [{ text, selected: true }] })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const state = await flow.get('source-a');
  assert.equal(state.questions[0].text, '甲');
  assert.equal(state.revision, revision + 1);
});

test('originals precede normalized deduplicated expansions; expansions are not preselected', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions('Ａ sales？\nA sales?\n原始问题二');
  await f.task(binding, 'submit', { questions: [{ text: 'a sales?' }, { text: '扩展问题' }, { text: ' 扩展问题 ' }] });
  const state = await f.flow.get('source-a');
  assert.equal(state.questions.length, 3);
  assert.deepEqual(state.questions.map(q => [q.kind, q.selected]), [['original', true], ['original', true], ['expanded', false]]);
  assert.equal(state.runs.at(-1).status, 'succeeded');
  assert.equal((await f.flow.get('source-b')).questions.length, 0);
});

test('bindings use real execution identity; another session cannot read or submit', async (t) => {
  const f = await fixture(t);
  const first = await f.startQuestions('源甲问题');
  const second = await f.startQuestions('源乙问题', 'source-b');
  const read = await f.task(first, 'read');
  assert.equal(read.source.id, 'source-a');
  assert.equal(read.cwd, f.directory);
  await assert.rejects(f.task(first, 'read', undefined, execution(second.sessionId)), publicFailure(/绑定会话/));
  await assert.rejects(f.task(first, 'submit', { questions: [] }, execution('unbound-session')), publicFailure(/绑定会话/));
  await assert.rejects(f.flow.task({ operation: 'read', runId: first.run.id, batchId: first.batch.id, sessionId: first.sessionId }, { signal: new AbortController().signal }), publicFailure(/绑定会话/));
});

test('scoped SQL denies another source, forces the bound connection, and lists only that source', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  const exec = execution(binding.sessionId);
  const passed = [];
  const execute = async (args) => { passed.push(args); return { safe: true }; };
  await assert.rejects(f.flow.scopedSql('sql_schema', { connection: 'source-b-name' }, exec, execute), publicFailure(/绑定的数据源/));
  assert.deepEqual(await f.flow.scopedSql('sql_schema', {}, exec, execute), { safe: true });
  assert.deepEqual(passed, [{ connection: 'source-a-name' }]);
  const listed = await f.flow.scopedSql('sql_list', {}, exec, execute);
  assert.equal(listed.connections.length, 1);
  assert.equal(listed.connections[0].name, 'source-a-name');
  assert.deepEqual(f.calls.find(([kind]) => kind === 'test')[1], { id: 'source-a' });
  await f.flow.scopedSql('sql_schema', { connection: 'source-b-name' }, execution('normal-user-session'), execute);
  assert.equal(passed.at(-1).connection, 'source-b-name');
});

test('cancel persists first and rejects results that arrive after real schema verification began', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  const entered = latch(); const release = latch();
  f.runtime.schemaHook = async (args) => { if (!args.table) { entered.resolve(); await release.promise; } };
  const submitting = f.task(binding, 'submit', f.rangeResult(binding));
  const rejection = assert.rejects(submitting, publicFailure(/任务已更新|取消|过期/));
  await entered.promise;
  await f.action('cancel', { runId: binding.run.id });
  const persisted = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(persisted.sources['source-a'].runs.at(-1).status, 'canceled');
  release.resolve(); await rejection;
  assert.equal((await f.flow.get('source-a')).tables.length, 0);
  assert.ok(f.calls.some(([kind, value]) => kind === 'cancel' && value === binding.sessionId));
});

test('an aborted execution cannot commit questions while its business run is still active', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  const controller = new AbortController(); controller.abort(new Error('synthetic-private-cancel-reason'));
  await assert.rejects(f.task(binding, 'submit', { questions: [{ text: '晚到扩展' }] }, execution(binding.sessionId, controller.signal)));
  assert.equal((await f.flow.get('source-a')).questions.length, 0);
});

test('batches are serial; failure pauses; retry replaces only failed attempt and preserves success', async (t) => {
  const f = await fixture(t);
  const first = await f.startRange(['问题一', '问题二', '问题三'], 1);
  await f.flow.pump();
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1);
  await f.task(first, 'submit', f.rangeResult(first));
  await f.flow.pump();
  const second = await f.batch();
  assert.equal(second.batch.index, 2);
  await f.task(second, 'fail');
  await f.flow.pump();
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 2);
  assert.equal((await f.flow.get('source-a')).runs.at(-1).status, 'partial');
  await f.action('retry', { runId: second.run.id, batchId: second.batch.id });
  await f.flow.pump();
  const retried = await f.batch();
  assert.equal(retried.batch.id, second.batch.id);
  assert.notEqual(retried.sessionId, second.sessionId);
  assert.equal(retried.batch.attempts, 2);
  await assert.rejects(f.task(second, 'submit', f.rangeResult(second)), publicFailure(/替换|过期/));
  await f.task(retried, 'submit', f.rangeResult(retried));
  await f.flow.pump();
  const third = await f.batch();
  assert.equal(third.batch.index, 3);
  await f.task(third, 'submit', f.rangeResult(third));
  const state = await f.flow.get('source-a');
  assert.equal(state.runs.at(-1).status, 'succeeded');
  assert.deepEqual(state.runs.at(-1).batches.map(b => b.attempts), [1, 2, 1]);
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 4);
});

test('restart marks dispatched work without receipt as failed and does not silently replay it', async (t) => {
  const f = await fixture(t);
  await f.startQuestions();
  await f.flow.close();
  const recovered = f.makeFlow();
  await recovered.initialize();
  const state = await recovered.get('source-a');
  assert.equal(state.runs.at(-1).status, 'failed');
  assert.equal(state.runs.at(-1).batches[0].status, 'failed');
  assert.match(state.runs.at(-1).batches[0].error, /重新加载|回执/);
  await recovered.pump();
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1);
});

test('range commit verifies actual schema and rejects invented table, field or foreign question', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  const original = f.rangeResult(binding);
  const fakeTable = clone(original); fakeTable.tables[0].name = 'fabricated_table';
  await assert.rejects(f.task(binding, 'submit', fakeTable), publicFailure(/不存在|重复/));
  const fakeField = clone(original); fakeField.tables[0].fields = [{ name: 'fabricated_field' }];
  await assert.rejects(f.task(binding, 'submit', fakeField), publicFailure(/不存在|字段/));
  const foreignQuestion = clone(original); foreignQuestion.tables[0].sourceQuestionIds = ['not-this-batch'];
  await assert.rejects(f.task(binding, 'submit', foreignQuestion), publicFailure(/不属于本批次/));
  assert.equal((await f.flow.get('source-a')).tables.length, 0);
  await f.task(binding, 'submit', original);
  assert.ok(f.calls.filter(([kind]) => kind === 'schema').every(([, args]) => args.connection === 'source-a-name'));
  assert.equal((await f.flow.get('source-a')).tables[0].fields[0].type, 'INTEGER');
});

test('table and field edits remain intact after reanalysis proposals', async (t) => {
  const f = await fixture(t);
  const first = await f.startRange();
  await f.task(first, 'submit', f.rangeResult(first));
  const edited = (await f.flow.get('source-a')).tables;
  edited[0].description = '用户表说明';
  edited[0].fields[0].description = '用户字段说明'; edited[0].fields[0].selected = false;
  await f.action('save-tables', { tables: edited });
  await f.action('analyze'); await f.flow.pump();
  const second = await f.batch();
  const proposal = f.rangeResult(second); proposal.tables[0].description = '模型新说明';
  await f.task(second, 'submit', proposal);
  const state = await f.flow.get('source-a');
  assert.equal(state.tables[0].description, '用户表说明');
  assert.equal(state.tables[0].fields[0].description, '用户字段说明');
  assert.equal(state.tables[0].fields[0].selected, false);
  assert.ok(state.tables[0].roundIds.includes(second.run.id));
});

test('editing selected question snapshot invalidates analysis and rejects its late result', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  const questions = (await f.flow.get('source-a')).questions;
  questions[0].text = '修改后的问题';
  await f.action('save-questions', { questions });
  await assert.rejects(f.task(binding, 'submit', f.rangeResult(binding)), publicFailure(/失效|取消|失败/));
  const state = await f.flow.get('source-a');
  assert.equal(state.runs.at(-1).status, 'stale');
  assert.equal(state.rangeCurrent, false);
  await assert.rejects(f.action('confirm-tables'), publicFailure(/当前已选问题/));
});

test('relation review is explicit; edited endpoints survive reanalysis and review', async (t) => {
  const f = await fixture(t);
  const first = await f.startRange();
  await f.task(first, 'submit', f.rangeResult(first, { relations: true }));
  let state = await f.flow.get('source-a');
  assert.equal(state.relations[0].selected, false);
  const relationId = state.relations[0].id;
  const relations = clone(state.relations); relations[0].selected = true;
  // A client cannot smuggle server provenance through an edit payload.
  relations[0].verifiedRound = first.run.id; relations[0].sourceQuestions = [{ questionId: 'forged' }];
  await f.action('save-relations', { relations });
  await f.action('confirm-tables');
  await assert.rejects(f.action('confirm-relations'), publicFailure(/来源|核对/));
  await f.action('review-relation', { relationId });
  await f.action('confirm-relations');
  assert.equal((await f.flow.get('source-a')).confirmations.relations, true);
  state = await f.flow.get('source-a');
  const edited = clone(state.relations); edited[0].leftField = 'id'; edited[0].description = '用户端点及说明';
  await f.action('save-relations', { relations: edited });
  await f.action('analyze'); await f.flow.pump();
  const second = await f.batch();
  await f.task(second, 'submit', f.rangeResult(second, { relations: true }));
  state = await f.flow.get('source-a');
  assert.equal(state.relations[0].leftField, 'id');
  assert.equal(state.relations[0].description, '用户端点及说明');
  assert.equal(state.relations[0].selected, true);
  assert.equal(state.relations[0].needsSourceReview, true);
  await f.action('confirm-tables');
  await assert.rejects(f.action('confirm-relations'), publicFailure(/来源|核对/));
  await f.action('review-relation', { relationId });
  await f.action('confirm-relations');
  state = await f.flow.get('source-a');
  assert.equal(state.relations[0].leftField, 'id');
  assert.equal(state.relations[0].verifiedRound, second.run.id);
  assert.equal(state.confirmations.relations, true);
});

test('identical receipts are idempotent under concurrent and repeated submit', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  const payload = { questions: [{ text: '可去重扩展' }] };
  let mergeCount = 0;
  const collect = f.flow._collectQuestions.bind(f.flow);
  f.flow._collectQuestions = (...args) => { mergeCount++; return collect(...args); };
  const submissionRevision = (await f.flow.get('source-a')).revision;
  const receipts = await Promise.all([f.task(binding, 'submit', payload), f.task(binding, 'submit', payload)]);
  assert.equal((await f.flow.get('source-a')).revision, submissionRevision + 1);
  const persisted = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(persisted.sources['source-a'].revision, submissionRevision + 1);
  assert.equal(mergeCount, 1);
  assert.equal(receipts[0].receiptId, receipts[1].receiptId);
  assert.equal(receipts.some(result => result.duplicate === true), true);
  const before = await f.flow.get('source-a');
  const repeated = await f.task(binding, 'submit', payload);
  assert.equal(repeated.receiptId, receipts[0].receiptId);
  const after = await f.flow.get('source-a');
  assert.equal(after.revision, before.revision);
  assert.equal(after.questions.length, 2);
  await assert.rejects(f.task(binding, 'submit', { questions: [{ text: '不同回填' }] }), publicFailure(/不能用不同结果覆盖/));
});

test('replaying a completed receipt after selected question snapshot invalidation is rejected', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  const payload = f.rangeResult(binding);
  const receipt = await f.task(binding, 'submit', payload);
  assert.equal(receipt.persisted, true);
  const completed = await f.flow.get('source-a');
  assert.equal(completed.runs.at(-1).status, 'succeeded');
  const questions = clone(completed.questions); questions[0].text = '完成后修改的已选问题';
  await f.action('save-questions', { questions });
  const invalidated = await f.flow.get('source-a');
  assert.equal(invalidated.runs.at(-1).status, 'stale');
  await assert.rejects(f.task(binding, 'submit', payload), publicFailure(/取消|失效|过期/));
  const after = await f.flow.get('source-a');
  assert.equal(after.revision, invalidated.revision);
  assert.equal(after.runs.at(-1).batches[0].receipt.id, receipt.receiptId);
});

test('sourceChanged invalidates on credential-only changes even when public config is identical', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  await f.task(binding, 'submit', f.rangeResult(binding));
  await f.action('confirm-tables');
  assert.equal((await f.flow.get('source-a')).confirmations.tables, true);
  // Passwords are not returned by runtime.list; the write hook must still
  // explicitly signal any credentials change to invalidate the old results.
  const publicBefore = await f.runtime.list();
  await f.flow.sourceChanged('source-a');
  assert.deepEqual(await f.runtime.list(), publicBefore);
  const state = await f.flow.get('source-a');
  assert.equal(state.runs.at(-1).status, 'stale');
  assert.equal(state.rangeCurrent, false);
  assert.equal(state.confirmations.tables, false);
  await assert.rejects(f.action('confirm-tables'), publicFailure(/当前已选问题/));
});

test('sourceChanged also rejects pending old tasks without reading another source', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  await f.flow.sourceChanged('source-a');
  await assert.rejects(f.task(binding, 'submit', { questions: [] }), publicFailure(/取消|失败|失效/));
  assert.equal((await f.flow.get('source-b')).runs.length, 0);
});

test('send or flush confirmation failure becomes visible failure without automatic replay', async (t) => {
  const f = await fixture(t);
  f.bridge.sendHook = async () => { throw new Error('synthetic-private-flush-error'); };
  await f.startQuestions();
  const state = await f.flow.get('source-a');
  assert.equal(state.runs.at(-1).status, 'failed');
  assert.equal(state.runs.at(-1).batches[0].status, 'failed');
  assert.match(state.runs.at(-1).batches[0].error, /持久化确认失败/);
  assert.equal(JSON.stringify(state).includes('synthetic-private-flush-error'), false);
  await f.flow.pump();
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1);
});

test('a previously selected field missing from a fresh schema cannot be confirmed', async (t) => {
  const f = await fixture(t);
  const first = await f.startRange();
  await f.task(first, 'submit', f.rangeResult(first));
  const tables = (await f.flow.get('source-a')).tables;
  tables[0].description = '保留人工编辑的表';
  await f.action('save-tables', { tables });
  f.catalog.orders = f.catalog.orders.filter(field => field.name !== 'total');
  await f.action('analyze'); await f.flow.pump();
  const second = await f.batch();
  const result = f.rangeResult(second); result.tables[0].fields = result.tables[0].fields.filter(field => field.name !== 'total');
  await f.task(second, 'submit', result);
  await assert.rejects(f.action('confirm-tables'), publicFailure(/字段|结构|不存在/));
});

test('abort while a submit waits for the serialization lock is rechecked before any merge', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  const entered = latch(); const release = latch(); const queued = latch();
  const blocker = f.flow._serial(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const originalChange = f.flow._change.bind(f.flow);
  f.flow._change = (...args) => { queued.resolve(); return originalChange(...args); };
  const controller = new AbortController();
  const submitting = f.task(binding, 'submit', { questions: [{ text: '不能落盘的扩展' }] }, execution(binding.sessionId, controller.signal));
  const rejection = assert.rejects(submitting);
  await queued.promise;
  controller.abort(); release.resolve();
  await blocker; await rejection;
  assert.equal((await f.flow.get('source-a')).questions.length, 0);
});

test('credential-only sourceChanged during schema verification rejects the pending commit', async (t) => {
  const f = await fixture(t);
  const binding = await f.startRange();
  const entered = latch(); const release = latch();
  f.runtime.schemaHook = async (args) => { if (!args.table) { entered.resolve(); await release.promise; } };
  const submitting = f.task(binding, 'submit', f.rangeResult(binding));
  const rejection = assert.rejects(submitting, publicFailure(/更新|取消|失效|过期/));
  await entered.promise;
  await f.flow.sourceChanged('source-a');
  release.resolve(); await rejection;
  const state = await f.flow.get('source-a');
  assert.equal(state.tables.length, 0);
  assert.equal(state.runs.at(-1).status, 'stale');
});

test('credential save followed by invalidation persistence failure immediately revokes old tasks and recovers on get', async (t) => {
  const f = await fixture(t);
  const binding = await f.startQuestions();
  const publicConfigBefore = await f.runtime.list();
  let credentialWasSaved = false;
  f.runtime.save = async ({ id }) => { credentialWasSaved = id === 'source-a'; return { id }; };
  await f.runtime.save({ id: 'source-a' });
  assert.equal(credentialWasSaved, true);
  assert.deepEqual(await f.runtime.list(), publicConfigBefore);
  const persist = f.flow._persist.bind(f.flow);
  let persistAttempts = 0;
  f.flow._persist = async (root) => {
    persistAttempts++;
    if (persistAttempts === 1) throw Object.assign(new Error('模拟工作流记录保存失败。'), { publicMessage: '模拟工作流记录保存失败。' });
    return persist(root);
  };
  await assert.rejects(f.flow.sourceChanged('source-a'), publicFailure(/保存失败/));
  // The old on-disk/public config has no password fingerprint. It must not
  // authorize this old binding merely because invalidation could not persist.
  assert.equal(f.flow.root.sources['source-a'].runs.at(-1).status, 'running');
  await assert.rejects(f.task(binding, 'submit', { questions: [{ text: '失效后晚到扩展' }] }), publicFailure(/数据源.*修改|失效|配置/));
  await assert.rejects(f.flow.action({ id: 'source-a', revision: binding.state.revision, action: 'save-questions', questions: [] }), publicFailure(/数据源.*修改|失效|配置/));
  assert.equal(persistAttempts, 1);
  const recovered = await f.flow.get('source-a');
  assert.equal(persistAttempts, 2);
  assert.equal(recovered.runs.at(-1).status, 'stale');
  assert.equal(recovered.runs.at(-1).batches[0].status, 'canceled');
  assert.equal(recovered.questions.length, 0);
  const persisted = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(persisted.sources['source-a'].runs.at(-1).status, 'stale');
  await assert.rejects(f.task(binding, 'submit', { questions: [] }), publicFailure(/取消|失效|失败/));
});

test('unknown live status still converges to a timeout failure', async (t) => {
  const f = await fixture(t, { timeoutMs: 0 });
  f.bridge.status = async () => 'unknown';
  await f.startQuestions();
  await f.flow.pump();
  const state = await f.flow.get('source-a');
  assert.equal(state.runs.at(-1).status, 'failed');
  assert.match(state.runs.at(-1).batches[0].error, /超时/);
});
