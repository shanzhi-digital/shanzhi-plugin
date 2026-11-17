import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../index.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-workflow-integration-'));
  const database = join(directory, 'fixture.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE visits (id INTEGER PRIMARY KEY, person_id INTEGER, minutes INTEGER); INSERT INTO people VALUES (1, \'integration\');');
  db.close();
  const records = new Map(), sessions = new Map(), agents = new Map(), tools = new Map(), routes = new Map(), prompts = [];
  let dispose, nextSession = 0;
  const ctx = {
    credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, modify) => { records.set(key, await modify(records.get(key))); },
      deleteRecord: async key => records.delete(key),
    },
    tools: { register: definition => { assert.equal(tools.has(definition.name), false); tools.set(definition.name, definition); } },
    connection: { fetch: { register: definition => routes.set(definition.path, definition) } },
    sessions: { get: id => sessions.get(id), flush: async session => sessions.has(session.id) },
    agents: { get: id => agents.get(id) },
    sessionController: {
      async create({ cwd }) { const sessionId = 'actual-session-' + ++nextSession; const session = { id: sessionId }; sessions.set(sessionId, session); agents.set(sessionId, { session, status: 'running', cwd }); return { sessionId }; },
      async prompt(input) { prompts.push(structuredClone(input)); return { accepted: true }; },
      async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: 'missing' }; },
      async cancel({ sessionId }) { if (agents.has(sessionId)) agents.get(sessionId).status = 'idle'; return { accepted: true }; },
    },
    on(event, callback) { assert.equal(event, 'dispose'); dispose = callback; },
  };
  const workflowPath = join(directory, 'workflow.json');
  await apply(ctx, { storagePath: join(directory, 'connections.json'), workflowPath, workingDirectory: directory });
  t.after(async () => { await dispose(); await rm(directory, { force: true, recursive: true }); });
  async function request(operation, body) {
    const route = routes.get('/api/datasources/' + operation);
    assert.ok(route, 'registered ' + operation);
    const response = await route.fetch(new Request('http://localhost/api/datasources/' + operation, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    const data = await response.json();
    return { status: response.status, ...data };
  }
  const saved = await request('save', { name: 'isolated fixture', engine: 'sqlite', file: database });
  assert.equal(saved.status, 200);
  const id = saved.item.id;
  const state = async () => (await request('flow-state', { id })).state;
  const action = async (action, input = {}) => request('flow-action', { id, revision: (await state()).revision, action, ...input });
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) { const value = await state(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail('workflow did not reach expected state');
  }
  const exec = batch => ({ agent: agents.get(batch.sessionId), signal: new AbortController().signal });
  const task = (batch, run, operation, result) => tools.get('datasource_task').execute({ runId: run.id, batchId: batch.id, operation, ...(result === undefined ? {} : { result }) }, exec(batch));
  return { directory, workflowPath, ctx, tools, routes, prompts, request, state, action, waitFor, exec, task, id };
}

test('actual plugin apply registers all workflow routes and only three database tools plus one metadata task tool', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()].sort(), ['datasource_task', 'sql_list', 'sql_query', 'sql_schema']);
  assert.deepEqual([...f.routes.keys()].sort(), ['flow-action', 'flow-state', 'list', 'remove', 'save', 'test'].map(name => '/api/datasources/' + name).sort());
  const s = await f.state();
  assert.equal(s.defaultCwd, f.directory);
  assert.equal(s.revision, 0);
  assert.deepEqual(s.questions, []);
  assert.equal((await f.request('flow-action', { id: f.id, action: 'organize', text: 'question' })).status, 409);
});

test('real SQLite workflow goes from persisted question receipt to range, edited relationship review and separate confirmations', async t => {
  const f = await fixture(t);
  assert.equal((await f.action('organize', { text: 'How many visits per person?\nHow many visits per person?' })).status, 200);
  let s = await f.waitFor(s => s.runs[0]?.batches[0]?.status === 'running');
  let run = s.runs[0], batch = run.batches[0];
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, 'queue');
  assert.equal(f.prompts[0].sessionId, batch.sessionId);
  const beforePrompt = JSON.parse(await readFile(f.workflowPath, 'utf8'));
  assert.equal(beforePrompt.bindings[batch.sessionId].batchId, batch.id);
  const scope = await f.task(batch, run, 'read');
  assert.equal(scope.questions.length, 1);
  assert.equal(scope.cwd, f.directory);
  const qResult = { questions: [{ text: 'How many visits per person?' }, { text: 'What is the total visit duration?' }] };
  const receipt = await f.task(batch, run, 'submit', qResult);
  assert.equal(receipt.persisted, true);
  assert.equal((await f.task(batch, run, 'submit', qResult)).receiptId, receipt.receiptId);
  s = await f.state();
  assert.equal(s.runs[0].status, 'succeeded');
  assert.deepEqual(s.questions.map(q => [q.kind, q.selected]), [['original', true], ['expanded', false]]);
  await f.action('analyze', { batchSize: 1 });
  s = await f.waitFor(s => s.runs[1]?.batches[0]?.status === 'running');
  run = s.runs[1]; batch = run.batches[0];
  const schema = await f.tools.get('sql_schema').execute({}, f.exec(batch));
  assert.ok(schema.tables.includes('people'));
  await assert.rejects(() => f.tools.get('sql_query').execute({ connection: 'other', sql: 'SELECT 1' }, f.exec(batch)), /绑定/);
  await assert.rejects(() => f.tools.get('sql_query').execute({ sql: 'DELETE FROM people' }, f.exec(batch)));
  const ids = batch.questions.map(q => q.id);
  const proposal = {
    tables: [
      { name: 'people', fields: [{ name: 'id' }, { name: 'name' }], sourceQuestionIds: ids },
      { name: 'visits', fields: [{ name: 'person_id' }, { name: 'id' }, { name: 'minutes' }], sourceQuestionIds: ids },
    ],
    relations: [{ leftTable: 'visits', leftField: 'person_id', rightTable: 'people', rightField: 'id', type: 'many-to-one', description: 'Visits by person', sourceQuestionIds: ids }],
  };
  const fake = structuredClone(proposal); fake.tables[0].fields[0].name = 'invented_column';
  await assert.rejects(() => f.task(batch, run, 'submit', fake), /字段/);
  assert.equal((await f.state()).runs[1].status, 'running');
  const rangeReceipt = await f.task(batch, run, 'submit', proposal);
  assert.equal(rangeReceipt.persisted, true);
  s = await f.state();
  assert.equal(s.rangeCurrent, true);
  assert.equal(s.confirmations.tables, false);
  assert.equal(s.confirmations.relations, false);
  const rel = s.relations[0];
  assert.equal(rel.selected, false);
  assert.ok(s.tables.some(table => table.id === rel.leftTable));
  await f.action('save-relations', { relations: [{ ...rel, selected: true, leftField: 'id', description: 'User reviewed endpoint' }] });
  s = await f.state();
  assert.equal(s.relations[0].needsSourceReview, true);
  assert.equal((await f.action('confirm-relations')).status, 400);
  assert.equal((await f.action('confirm-tables')).status, 200);
  assert.equal((await f.action('review-relation', { relationId: rel.id })).status, 200);
  s = await f.state();
  assert.equal(s.relations[0].leftField, 'id');
  assert.equal(s.relations[0].description, 'User reviewed endpoint');
  assert.equal(s.relations[0].needsSourceReview, false);
  assert.equal((await f.action('confirm-relations')).status, 200);
  s = await f.state();
  assert.deepEqual(s.confirmations, { tables: true, relations: true });
  const oldSource = s.relations[0].sourceQuestions[0].textAtSnapshot;
  await f.action('save-questions', { questions: s.questions.map(q => q.selected ? { ...q, text: q.text + ' for 2026' } : q) });
  s = await f.state();
  assert.equal(s.rangeCurrent, false);
  assert.deepEqual(s.confirmations, { tables: false, relations: false });
  assert.equal(s.relations[0].sourceQuestions[0].textAtSnapshot, oldSource);
  assert.equal(s.relations[0].leftField, 'id');
  assert.equal(s.relations[0].needsSourceReview, true);
  assert.equal((await f.action('review-relation', { relationId: rel.id })).status, 400);
  const stored = await readFile(f.workflowPath, 'utf8');
  assert.equal(stored.includes('payload.password'), false);
});

test('flow HTTP CAS conflicts are 409 and do not overwrite the persisted question draft', async t => {
  const f = await fixture(t);
  const version = (await f.state()).revision;
  const first = await f.request('flow-action', { id: f.id, revision: version, action: 'save-questions', questions: [{ text: 'Saved question', selected: true }] });
  assert.equal(first.status, 200);
  const conflict = await f.request('flow-action', { id: f.id, revision: version, action: 'save-questions', questions: [{ text: 'Stale question', selected: true }] });
  assert.equal(conflict.status, 409);
  assert.equal((await f.state()).questions[0].text, 'Saved question');
  assert.equal((await f.request('flow-state', { id: null })).status, 400);
});

test('cancel API persists stopped state before rejecting a result from the real bound session', async t => {
  const f = await fixture(t);
  await f.action('organize', { text: 'A cancellable question' });
  const s = await f.waitFor(s => s.runs[0]?.batches[0]?.status === 'running');
  const run = s.runs[0], batch = run.batches[0];
  assert.equal((await f.action('cancel', { runId: run.id })).status, 200);
  await assert.rejects(() => f.task(batch, run, 'submit', { questions: [] }), /取消|失效/);
  assert.equal((await f.state()).questions.length, 0);
  assert.equal(JSON.parse(await readFile(f.workflowPath, 'utf8')).sources[f.id].runs[0].status, 'canceled');
});
