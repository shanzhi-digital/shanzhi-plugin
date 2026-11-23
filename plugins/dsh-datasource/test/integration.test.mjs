import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyWithServices, createSecrets } from '../index.js';
import { DatasourceRuntime } from '../runtime.js';
import { DatasourceStore } from '../store.js';
import { DatasourceFlow } from '../flow.js';
import { DatasourceSessionBridge } from '../host-bridge.js';

const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-workflow-'));
  const database = join(directory, 'fixture.sqlite'), db = new DatabaseSync(database);
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, updated_at DATETIME); CREATE TABLE visits (id INTEGER PRIMARY KEY, person_id INTEGER, minutes INTEGER); INSERT INTO people VALUES (1, 'integration', '2026-01-01 00:00:00')"); db.close();
  const records = new Map(), sessions = new Map(), agents = new Map(), tools = new Map(), routes = new Map(), streams = new Map();
  const prompts = [], sampleRequests = [], cancellations = []; let dispose, nextSession = 0, nextOperation = 0, onPrompt;
  const ctx = {
    provide(name, value) { this[name] = value; },
    credentials: { readRecord: async key => records.get(key), modifyRecord: async (key, modify) => { records.set(key, await modify(records.get(key))); }, deleteRecord: async key => records.delete(key) },
    tools: { register: definition => { assert.equal(tools.has(definition.name), false); tools.set(definition.name, definition); } },
    connection: { fetch: { register: definition => { assert.equal(routes.has(definition.path), false); routes.set(definition.path, definition); } } },
    sessions: { get: id => sessions.get(id), flush: async session => sessions.has(session.id) }, agents: { get: id => agents.get(id) },
    sessionController: {
      async create({ cwd }) { const sessionId = 'actual-session-' + ++nextSession, session = { id: sessionId }; sessions.set(sessionId, session); agents.set(sessionId, { session, status: 'running', cwd }); return { sessionId }; },
      async *observeEvent(request, signal) {
        const sessionId = request.address.sessionId; assert.deepEqual(request, { address: { kind: 'session', sessionId } });
        const stream = { wake: null }; streams.set(sessionId, stream); const abort = () => stream.wake?.(); signal.addEventListener('abort', abort, { once: true });
        try { yield { type: 'ready' }; while (!signal.aborted) await new Promise(resolve => { stream.wake = resolve; if (signal.aborted) resolve(); }); }
        finally { signal.removeEventListener('abort', abort); streams.delete(sessionId); }
      },
      async prompt(input, signal) { signal.throwIfAborted(); assert.ok(streams.has(input.sessionId), 'native observer ready before prompt'); prompts.push(clone(input)); await onPrompt?.(input); return { accepted: true }; },
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: 'missing' }; },
      async cancel({ sessionId }) { cancellations.push(sessionId); return { accepted: true }; },
    },
    on(event, callback) { assert.equal(event, 'dispose'); dispose = callback; },
  };
  const store = new DatasourceStore(), runtime = new DatasourceRuntime({ store, secrets: createSecrets(ctx.credentials) });
  const flow = new DatasourceFlow({ store, runtime, bridge: new DatasourceSessionBridge(ctx), defaultCwd: directory, timeoutMs: 10000 });
  await runtime.initialize(); await flow.initialize();
  await applyWithServices(ctx, { workingDirectory: directory }, { initialServices: { runtime, flow, store } });
  t.after(async () => { await dispose(); await rm(directory, { force: true, recursive: true }); });
  async function request(operation, body, signal) {
    const route = routes.get('/api/datasources/' + operation); assert.ok(route, 'registered ' + operation);
    const method = route.methods[0], response = await route.fetch(new Request('http://localhost' + route.path, {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}), ...(signal ? { signal } : {}),
    }));
    return { status: response.status, ...await response.json() };
  }
  const saved = await request('save', { name: 'isolated fixture', engine: 'sqlite', file: database }); assert.equal(saved.status, 200); const id = saved.item.id;
  const state = async () => (await request('flow-state', { id })).state;
  const action = async (name, input = {}, signal) => request('flow-action', { id, revision: (await state()).revision, action: name, operationId: 'operation-' + ++nextOperation, ...input }, signal);
  const exec = sessionId => ({ agent: agents.get(sessionId), signal: new AbortController().signal });
  const task = (sessionId, operation, input = {}) => tools.get('datasource_task').execute({ operation, ...input }, exec(sessionId));
  async function readAll(sessionId) {
    const tables = []; let cursor;
    do { const page = await task(sessionId, 'read', cursor === undefined ? {} : { cursor }); tables.push(...page.tables); cursor = page.nextCursor; } while (cursor !== undefined && cursor !== null);
    return tables;
  }
  async function start(name, input = {}) {
    const entered = latch(); onPrompt = prompt => { entered.resolve(prompt.sessionId); };
    const pending = action(name, input);
    const sessionId = await Promise.race([entered.promise, pending.then(response => assert.fail('AI action returned before prompt: ' + JSON.stringify(response)))]);
    return { sessionId, pending };
  }
  const sampleTables = runtime.sampleTables.bind(runtime);
  runtime.sampleTables = (sourceId, version, tables, signal) => { sampleRequests.push(tables.map(table => table.name)); return sampleTables(sourceId, version, tables, signal); };
  return { database, directory, runtime, store, flow, tools, routes, prompts, sampleRequests, cancellations, request, state, action, start, task, readAll, exec, id };
}

test('plugin exposes exact current APIs and refresh saves disabled tables without business sampling or MAX', async t => {
  const f = await fixture(t), before = await readFile(f.database);
  assert.deepEqual([...f.tools.keys()].sort(), ['datasource_task', 'sql_list', 'sql_query', 'sql_schema']);
  assert.deepEqual([...f.routes.keys()].sort(), ['flow-action', 'flow-samples', 'flow-state', 'list', 'management-save', 'management-status', 'questions-list', 'questions-save', 'questions-remove', 'source-status', 'remove', 'save', 'test'].map(name => '/api/datasources/' + name).sort());
  const initial = await f.state(); assert.equal(initial.defaultCwd, f.directory); assert.equal(initial.enabled, true); assert.equal(initial.revision, 0);
  let detections = 0; const detect = f.runtime.detectFreshness.bind(f.runtime); f.runtime.detectFreshness = (...args) => { detections++; return detect(...args); };
  const scanned = await f.action('scan'); assert.equal(scanned.status, 200, scanned.error);
  assert.equal(scanned.state.catalog.tables.length, 2); assert.ok(scanned.state.catalog.tables.every(table => table.enabled === false && !Object.hasOwn(table, 'samples')));
  assert.deepEqual(f.sampleRequests, []); assert.equal(detections, 0); assert.equal(f.prompts.length, 0);
  await assert.rejects(f.tools.get('sql_query').execute({ sql: 'SELECT name FROM people' }));
  const people = scanned.state.catalog.tables.find(table => table.name === 'people');
  assert.equal((await f.request('flow-samples', { id: f.id, tableId: people.id, snapshotId: 'stale' })).status, 409);
  const samples = await f.request('flow-samples', { id: f.id, tableId: people.id, snapshotId: scanned.state.catalog.id });
  assert.equal(samples.status, 200, samples.error); assert.deepEqual(samples.samples, [[1, 'integration', '2026-01-01 00:00:00']]);
  const enabled = await f.action('set-tables', { tableIds: [people.id], enabled: true }); assert.equal(enabled.status, 200, enabled.error);
  assert.deepEqual((await f.tools.get('sql_query').execute({ sql: 'SELECT name FROM people' })).rows, [['integration']]);
  await assert.rejects(f.tools.get('sql_query').execute({ sql: 'SELECT * FROM visits' }));
  await assert.rejects(f.tools.get('sql_query').execute({ sql: 'DELETE FROM people' }));
  assert.equal(sha(await readFile(f.database)), sha(before)); assert.deepEqual(await readFile(f.database), before);
});

test('native session recommendation submits a draft and confirm-selection atomically updates SQL scope', async t => {
  const f = await fixture(t), before = await readFile(f.database); await f.action('scan');
  const question = await f.request('questions-save', { text: '有多少人？' }); assert.equal(question.status, 200, question.error);
  const binding = await f.start('suggest', { questionIds: [question.item.id] });
  const tables = await f.readAll(binding.sessionId), people = tables.find(table => table.name === 'people');
  assert.equal(tables.length, 2); assert.equal(f.prompts.length, 1);
  const sampled = await f.task(binding.sessionId, 'sample', { tableIds: [people.id] }); assert.ok(sampled);
  const submitted = await f.task(binding.sessionId, 'submit', { result: { recommendations: [{ tableId: people.id, reason: '人员表可计数' }], analyses: [{ questionId: question.item.id, links: [{ tableId: people.id, fields: ['id'], reason: '人员主键可计数' }] }] } }); assert.ok(submitted);
  const response = await binding.pending; assert.equal(response.status, 200, response.error); assert.equal(response.sessionId, binding.sessionId); assert.ok(response.state.draft?.id);
  assert.ok((await f.state()).catalog.tables.every(table => table.enabled === false));
  await assert.rejects(f.tools.get('sql_query').execute({ sql: 'SELECT count(*) FROM people' }));
  const confirmed = await f.action('confirm-selection', { draftId: response.state.draft.id, selectedTableIds: [people.id] }); assert.equal(confirmed.status, 200, confirmed.error);
  assert.equal(confirmed.state.catalog.tables.find(table => table.id === people.id).enabled, true);
  assert.deepEqual((await f.tools.get('sql_query').execute({ sql: 'SELECT count(*) AS total FROM people' })).rows, [[1]]);
  assert.deepEqual((await f.tools.get('sql_schema').execute({})).tables.map(table => table.name), ['people']);
  const linked = await f.request('questions-list', { id: f.id }); assert.equal(linked.items[0].links[0].tableId, people.id);
  await assert.rejects(f.task(binding.sessionId, 'submit', { result: { recommendations: [], analyses: [] } }));
  assert.equal(sha(await readFile(f.database)), sha(before)); assert.deepEqual(await readFile(f.database), before);
});

test('API generalizes from the catalog and saves only edited confirmed candidates', async t => {
  const f = await fixture(t), before = await readFile(f.database);
  await f.action('scan');
  const saved = await f.request('questions-save', { text: '有多少人？', answer: '按人员唯一编号统计。' });
  assert.equal(saved.status, 200, saved.error);
  const question = saved.item;
  const binding = await f.start('generalize-question', { questions: [{ id: question.id, version: question.version }] });
  const page = await f.task(binding.sessionId, 'read');
  assert.deepEqual(page.questions, [{ id: question.id, text: question.text, answer: question.answer, origin: 'original', sourceQuestionId: null }]);
  assert.equal(page.tables.length, 2);
  const people = page.tables.find(table => table.name === 'people');
  const links = [{ tableId: people.id, fields: ['id'], reason: '统计人员规模' }];
  const submitted = await f.task(binding.sessionId, 'submit', { result: { originalAnalyses: [{ questionId: question.id, links }], reason: '当前表结构可支持的独立问题有限。', candidates: [
    { text: '每月新增多少人？', answer: '', links }, { text: '有姓名的人员有多少？', answer: '', links }, { text: '人员编号是否重复？', answer: '', links },
  ] } });
  assert.equal(submitted.draftReady, true);
  assert.equal(submitted.originalAnalysesPersisted, true);
  assert.equal(submitted.candidatesPersisted, false);
  const generated = await binding.pending;
  assert.equal(generated.status, 200, generated.error);
  assert.ok(generated.state.catalog);
  assert.equal(generated.state.questionDraft.sampleNote, '未读取业务样例，本次仅依据表结构生成。');
  assert.deepEqual(generated.state.questionDraft.candidates[0].links, links);
  assert.equal(generated.state.questions.length, 1);
  const draft = generated.state.questionDraft;
  assert.deepEqual(draft.questions, [{ id: question.id, version: question.version }]);
  const unknown = await f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: 'unknown', text: '不应新增' }] });
  assert.equal(unknown.status, 400);
  const confirmed = await f.action('confirm-question-draft', { draftId: draft.id, candidates: draft.candidates.slice(0, 2).map((item, index) => ({ id: item.id, text: index === 0 ? '每周新增多少人？' : item.text })) });
  assert.equal(confirmed.status, 200, confirmed.error);
  assert.equal(confirmed.state.questionDraft, null);
  assert.equal(confirmed.state.questions.length, 3);
  const created = confirmed.state.questions.filter(item => item.id !== question.id);
  assert.deepEqual(created.map(item => [item.text, item.answer]).sort(), [['有姓名的人员有多少？', ''], ['每周新增多少人？', '']].sort());
  assert.ok(created.every(item => item.origin === 'generated' && item.sourceQuestionId === question.id && item.links.length === 1));
  assert.equal(created.find(item => item.text === '每周新增多少人？').links[0].questionVersion, 0);
  const unchanged = created.find(item => item.text === '有姓名的人员有多少？');
  assert.equal(unchanged.links[0].questionVersion, unchanged.version);
  const reopened = await f.request('questions-list', { id: f.id });
  assert.deepEqual(reopened.items.filter(item => item.id !== question.id).map(item => item.links), created.map(item => item.links));
  const reused = await f.action('suggest', { questionIds: [unchanged.id] });
  assert.equal(reused.status, 200, reused.error);
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(reused.state.draft.selectedTableIds, [people.id]);
  assert.deepEqual(f.sampleRequests, []);
  assert.deepEqual(await readFile(f.database), before);
});

test('API rejects stale question draft confirmation and cancel removes only its draft', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const saved = await f.request('questions-save', { text: '有多少次到访？' });
  const question = saved.item;
  const generate = async () => {
    const binding = await f.start('generalize-question', { questions: [{ id: question.id, version: question.version }] });
    const page = await f.task(binding.sessionId, 'read');
    const visits = page.tables.find(table => table.name === 'visits');
    await f.task(binding.sessionId, 'submit', { result: { originalAnalyses: page.originalAnalysisQuestions.map(({ id }) => ({ questionId: id, links: [] })), reason: '到访表可支持的独立问题有限。', candidates: ['每天到访几次？', '每人到访几次？', '每月到访几次？'].map(text => ({ text, answer: '', links: [{ tableId: visits.id, fields: ['id'], reason: '统计到访次数' }] })) } });
    return (await binding.pending).state.questionDraft;
  };
  let draft = await generate();
  const canceled = await f.action('cancel', { questionDraftId: draft.id });
  assert.equal(canceled.status, 200, canceled.error);
  assert.equal(canceled.state.questionDraft, null);
  assert.equal(canceled.state.questions.length, 1);
  draft = await generate();
  const updated = await f.request('questions-save', { ...question, answer: '使用到访编号。' });
  assert.equal(updated.status, 200, updated.error);
  const confirmed = await f.action('confirm-question-draft', { draftId: draft.id, candidates: [{ id: draft.candidates[0].id, text: '版本过期不应保存' }] });
  assert.equal(confirmed.status, 409);
  assert.equal((await f.state()).questions.length, 1);
  assert.equal((await f.state()).questionDraft, null);
});

test('native session domain detection sends with the Host signal contract and saves classifications', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const binding = await f.start('detect-domains');
  const tables = await f.readAll(binding.sessionId);
  const result = {
    domains: [{ name: '人员服务', description: '人员与到访记录' }],
    classifications: tables.map(table => ({ tableId: table.id, category: 'BUSINESS', domain: '人员服务', reason: '人员服务相关数据' })),
  };
  await f.task(binding.sessionId, 'submit', { result });
  const response = await binding.pending;
  assert.equal(response.status, 200, response.error);
  assert.deepEqual(response.state.domains, result.domains);
  assert.equal(f.prompts.length, 1);
  assert.ok(response.state.catalog.tables.every(table => table.enabled === false && table.domain === '人员服务'));
});

test('API uses multiple originals for one batch and retains table links without a unique parent', async t => {
  const f = await fixture(t), before = await readFile(f.database);
  await f.action('scan');
  const originals = [];
  for (const text of ['按人员统计规模', '按到访统计次数']) originals.push((await f.request('questions-save', { text })).item);
  const references = originals.map(({ id, version }) => ({ id, version }));
  const binding = await f.start('generalize-question', { questions: references });
  const page = await f.task(binding.sessionId, 'read');
  assert.deepEqual(page.questions.map(({ id }) => id), originals.map(({ id }) => id));
  assert.deepEqual(page.habitQuestions, []);
  const people = page.tables.find(table => table.name === 'people');
  const links = [{ tableId: people.id, fields: ['id'], reason: '人员编号支持统计' }];
  await f.task(binding.sessionId, 'submit', { result: { originalAnalyses: originals.map((original, index) => ({ questionId: original.id, links: index === 0 ? links : [] })), candidates: [{ text: '各月人员规模如何变化', answer: '', links }], reason: '测试目录只支持该候选。' } });
  const generated = await binding.pending;
  const draft = generated.state.questionDraft;
  assert.deepEqual(draft.questions, references);
  const confirmed = await f.action('confirm-question-draft', { draftId: draft.id, candidates: draft.candidates.map(({ id, text }) => ({ id, text })) });
  assert.equal(confirmed.status, 200, confirmed.error);
  const question = confirmed.state.questions.find(item => item.origin === 'generated');
  assert.equal(question.sourceQuestionId, null);
  assert.equal(question.links.length, 1);
  const reused = await f.action('suggest', { questionIds: [question.id, ...originals.map(({ id }) => id)] });
  assert.equal(reused.status, 200, reused.error);
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(await readFile(f.database), before);
});

test('generalization explicit empty original analysis survives candidate cancel and later selection', async t => {
  const f = await fixture(t);
  await f.action('scan');
  const original = (await f.request('questions-save', { text: '当前目录不支持的原题' })).item;
  const binding = await f.start('generalize-question', { questions: [{ id: original.id, version: original.version }] });
  const page = await f.task(binding.sessionId, 'read');
  assert.deepEqual(page.originalAnalysisQuestions.map(({ id }) => id), [original.id]);
  const people = page.tables.find(table => table.name === 'people');
  await assert.rejects(f.task(binding.sessionId, 'submit', { result: {
    originalAnalyses: [], reason: '仅有一个可支持的候选', candidates: [{ text: '人员编号总数', answer: '', links: [{ tableId: people.id, fields: ['id'], reason: '人员编号计数' }] }],
  } }));
  assert.equal((await f.state()).questions[0].analysisStatus, 'missing');
  const submitted = await f.task(binding.sessionId, 'submit', { result: {
    originalAnalyses: [{ questionId: original.id, links: [] }], reason: '仅有一个可支持的候选', candidates: [{ text: '人员编号总数', answer: '', links: [{ tableId: people.id, fields: ['id'], reason: '人员编号计数' }] }],
  } });
  assert.equal(submitted.originalAnalysesPersisted, true);
  const response = await binding.pending;
  assert.equal(response.state.questions[0].analysisStatus, 'empty');
  const canceled = await f.action('cancel', { questionDraftId: response.state.questionDraft.id });
  assert.equal(canceled.state.questions.length, 1);
  assert.equal(canceled.state.questions[0].analysisStatus, 'empty');
  const listed = await f.request('questions-list', { id: f.id });
  assert.equal(listed.items[0].analysisStatus, 'empty');
  const reused = await f.action('suggest', { questionIds: [original.id] });
  assert.equal(reused.status, 200, reused.error);
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(reused.state.draft.selectedTableIds, []);
});
