import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { API_PREFIX, createSecrets, registerRoutes, applyWithServices } from '../index.js';
import { DatasourceRuntime } from '../runtime.js';
import { DatasourceStore } from '../store.js';

// Contract fake for native CredentialRecords. This validates JSON grant shapes,
// not the Host's YAML persistence, file permissions or authenticated-owner middleware.
function assertJsonPayload(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  assert.ok(value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), 'grant payload must be JSON');
  assert.equal(seen.has(value), false, 'grant payload must not be cyclic'); seen.add(value);
  for (const nested of Object.values(value)) assertJsonPayload(nested, seen);
  seen.delete(value);
}
function assertNativeRecord(record) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record), 'record must be a mapping');
  assert.ok(['api-key', 'grant'].includes(record.kind), 'record kind must be api-key or grant');
  const allowed = record.kind === 'grant' ? ['kind', 'payload'] : ['kind', 'key', 'env'];
  assert.ok(Object.keys(record).every(field => allowed.includes(field)), 'record has an unknown field');
  if (record.kind === 'grant') { assert.ok(Object.hasOwn(record, 'payload')); assertJsonPayload(record.payload); }
  else {
    assert.ok(record.key === undefined || (typeof record.key === 'string' && record.key.length > 0));
    if (record.env !== undefined) {
      assert.ok(record.env && typeof record.env === 'object' && !Array.isArray(record.env));
      for (const [name, value] of Object.entries(record.env)) { assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/); assert.ok(typeof value === 'string' && value.length > 0); }
    }
  }
}
class CredentialRecords {
  records = new Map(); calls = [];
  constructor(records = []) { for (const [key, record] of records) { this.check(key); assertNativeRecord(record); this.records.set(key, structuredClone(record)); } }
  check(key) { assert.match(key, /^sql\/[a-z][a-z0-9-]*$/); }
  async persist(file) { await writeFile(file, JSON.stringify([...this.records]), 'utf8'); }
  static async reload(file) { return new CredentialRecords(JSON.parse(await readFile(file, 'utf8'))); }
  async readRecord(key) { this.check(key); this.calls.push(['readRecord', key]); return structuredClone(this.records.get(key)); }
  async modifyRecord(key, modify) { this.check(key); this.calls.push(['modifyRecord', key]); const previous = structuredClone(this.records.get(key)), next = await modify(previous); if (next === undefined) return previous; assertNativeRecord(next); this.records.set(key, structuredClone(next)); return structuredClone(next); }
  async deleteRecord(key) { this.check(key); this.calls.push(['deleteRecord', key]); return this.records.delete(key); }
}
function register(services) {
  const routes = new Map();
  registerRoutes({ connection: { fetch: { register(definition) { assert.equal(routes.has(definition.path), false); routes.set(definition.path, definition); } } } }, () => services);
  return routes;
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-host-'));
  const file = join(directory, 'fixture.sqlite'), db = new DatabaseSync(file);
  db.exec("CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO samples VALUES (1, 'host fixture')"); db.close();
  const credentials = new CredentialRecords(), store = new DatasourceStore();
  const runtime = new DatasourceRuntime({ store, secrets: createSecrets(credentials) }); await runtime.initialize();
  const flow = { get: id => store.get(id), sourceChanged: async () => {}, action: async () => ({ revision: 1 }), sampleTable: async () => ({ samples: [] }) };
  const routes = register({ runtime, store, flow });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, file, credentials, store, runtime, flow, routes };
}
async function call(routes, operation, options = {}) {
  const route = routes.get(API_PREFIX + '/' + operation); assert.ok(route, 'registered ' + operation);
  const method = route.methods[0], init = { method, headers: options.headers ?? (method === 'POST' ? { 'Content-Type': 'application/json' } : {}), signal: options.signal };
  if (method === 'POST') init.body = Object.hasOwn(options, 'body') ? options.body : JSON.stringify(options.data ?? {});
  return route.fetch(new Request('http://localhost' + route.path, init));
}
async function json(response, status = 200) {
  assert.ok(response instanceof Response); assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json\b/i); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json(); assert.ok(value && typeof value === 'object'); return value;
}
const network = { name: '服务器凭据', engine: 'mysql', host: 'localhost', port: 3306, user: 'readonly_fixture', database: 'fixture' };
const operations = ['save', 'test', 'remove', 'source-status', 'questions-list', 'questions-save', 'questions-remove', 'flow-state', 'flow-action', 'flow-samples'];

test('native credential contract rejects legacy custom kinds and malformed records', async () => {
  const credentials = new CredentialRecords(), key = 'sql/fixture-password';
  const legacy = { kind: 'database-password', payload: { password: 'legacy' } };
  await assert.rejects(credentials.modifyRecord(key, () => legacy), /record kind/);
  assert.throws(() => new CredentialRecords([[key, legacy]]), /record kind/);
  for (const record of [{}, [], null, { kind: 'oauth' }, { kind: 'grant' }, { kind: 'grant', payload: undefined }, { kind: 'grant', payload: { password: Infinity } }, { kind: 'grant', payload: new Date() }, { kind: 'grant', payload: {}, extra: true }, { kind: 'api-key', payload: {} }, { kind: 'api-key', key: '' }, { kind: 'api-key', env: { INVALID: '' } }]) await assert.rejects(credentials.modifyRecord(key, () => record));
  assert.equal(credentials.records.size, 0);
  for (const payload of [null, false, 123, 'fixture', ['fixture'], { nested: true }]) assert.deepEqual(await credentials.modifyRecord(key, () => ({ kind: 'grant', payload })), { kind: 'grant', payload });
  const apiKey = { kind: 'api-key', key: 'fixture-key', env: { FIXTURE_KEY: 'fixture-env' } }; assert.deepEqual(await credentials.modifyRecord(key, () => apiKey), apiKey);
});

test('createSecrets performs scoped native password CRUD and supports native grant reload', async t => {
  const { credentials, directory } = await setup(t), secrets = createSecrets(credentials);
  const key = 'DSH-Datasource:2B7995A5-7EAE-4729-BA8C-39ED7AD72ED8:Password', id = 'sql/dsh-datasource-2b7995a5-7eae-4729-ba8c-39ed7ad72ed8-password';
  assert.equal(await secrets.get(key), undefined); await secrets.set(key, '  fixture-password  ');
  assert.deepEqual(credentials.records.get(id), { kind: 'grant', payload: { password: '  fixture-password  ' } });
  const file = join(directory, 'credential.fixture.json'); await credentials.persist(file);
  const reloaded = createSecrets(await CredentialRecords.reload(file)); assert.equal(await reloaded.get(key), '  fixture-password  ');
  await secrets.set(key, 'replacement'); assert.equal(await secrets.get(key), 'replacement'); assert.equal(credentials.records.size, 1);
  await secrets.delete(key); assert.equal(await secrets.get(key), undefined); assert.equal(credentials.records.size, 0);
});

test('createSecrets accepts only string grant passwords and validates ids before native calls', async () => {
  const credentials = new CredentialRecords(), secrets = createSecrets(credentials), key = 'dsh-datasource:fixture:password', id = 'sql/dsh-datasource-fixture-password';
  for (const record of [undefined, null, {}, { kind: 'grant' }, { kind: 'grant', payload: null }, { kind: 'grant', payload: {} }, { kind: 'grant', payload: { password: 123 } }, { kind: 'grant', payload: { password: false } }, { kind: 'grant', payload: 'scalar' }, { kind: 'api-key', key: 'key' }, { payload: { password: 'untyped' } }, { kind: 'database-password', payload: { password: 'legacy' } }]) { credentials.records.set(id, record); assert.equal(await secrets.get(key), undefined); }
  credentials.records.set(id, { kind: 'grant', payload: { password: '' } }); assert.equal(await secrets.get(key), ''); credentials.calls = [];
  for (const invalid of ['', '1starts-with-number', 'bad/record', '../outside', 'bad_key', 'not valid', '中文', 'bad?key']) { await assert.rejects(secrets.get(invalid), /无效.*凭据标识/); await assert.rejects(secrets.set(invalid, 'password'), /无效.*凭据标识/); await assert.rejects(secrets.delete(invalid), /无效.*凭据标识/); }
  assert.deepEqual(credentials.calls, []);
});

test('routes register every exact endpoint once with buffered bodies and declared methods', async t => {
  const { routes } = await setup(t); assert.equal(API_PREFIX, '/api/datasources');
  assert.deepEqual([...routes.keys()].sort(), ['list', ...operations].map(name => API_PREFIX + '/' + name).sort());
  for (const [path, route] of routes) { assert.equal(route.requestBody, 'buffered'); assert.deepEqual(route.methods, [path.endsWith('/list') ? 'GET' : 'POST']); assert.equal(typeof route.fetch, 'function'); }
});

test('source Request CRUD uses revisions and native secrets without returning private data', async t => {
  const { routes, credentials, runtime } = await setup(t);
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
  const saved = (await json(await call(routes, 'save', { data: { ...network, password: 'synthetic-host-password' } }))).item;
  assert.equal(saved.enabled, true); assert.equal(saved.hasPassword, true);
  const native = [...credentials.records.values()][0]; assert.deepEqual(native, { kind: 'grant', payload: { password: 'synthetic-host-password' } });
  const renamed = (await json(await call(routes, 'save', { data: { id: saved.id, revision: saved.revision, name: '保留密码', password: '' } }))).item;
  assert.equal(renamed.hasPassword, true); assert.equal(renamed.connectionVersion, saved.connectionVersion);
  await json(await call(routes, 'save', { data: { id: saved.id, revision: saved.revision, name: 'stale' } }), 409);
  await json(await call(routes, 'remove', { data: { id: saved.id, revision: saved.revision } }), 409);
  const listed = await json(await call(routes, 'list')); assert.deepEqual(listed.items, [{ ...renamed, tableCount: null }]);
  assert.doesNotMatch(JSON.stringify({ saved, renamed, listed }), /synthetic-host-password|credentialRef|"password"|"payload"/);
  const cleared = (await json(await call(routes, 'save', { data: { id: saved.id, revision: renamed.revision, clearPassword: true } }))).item;
  assert.equal(cleared.hasPassword, false); assert.equal(credentials.records.size, 0);
  await json(await call(routes, 'remove', { data: { id: saved.id, revision: cleared.revision } })); assert.deepEqual(await runtime.list(), []);
});

test('SQLite draft probes and CRUD use memory storage and leave business file unchanged', async t => {
  const { routes, runtime, file, store } = await setup(t), before = await readFile(file);
  assert.equal((await json(await call(routes, 'test', { data: { name: 'draft', engine: 'sqlite', file } }))).ok, true);
  assert.deepEqual(await runtime.list(), []);
  const saved = (await json(await call(routes, 'save', { data: { name: '本地数据库', engine: 'sqlite', file } }))).item;
  const tables = await runtime.scan(saved.id, saved.connectionVersion);
  await store.change(saved.id, state => ({ state: { ...state, catalog: { tables: tables.map(table => ({ ...table, enabled: true })) } } }));
  assert.deepEqual((await runtime.getTools().find(tool => tool.name === 'sql_query').execute({ sql: 'SELECT label FROM samples' })).rows, [['host fixture']]);
  assert.deepEqual(await readFile(file), before);
});

test('source-status batch reports successful entries and individual revision failures', async t => {
  const { routes, file, runtime } = await setup(t);
  const first = await runtime.save({ name: 'first', engine: 'sqlite', file }), second = await runtime.save({ name: 'second', engine: 'sqlite', file });
  const result = await json(await call(routes, 'source-status', { data: { items: [{ id: first.id, enabled: false, revision: first.revision }, { id: second.id, enabled: false, revision: second.revision - 1 }] } }));
  assert.equal(result.results.length, 2); assert.equal(result.results[0].ok, true); assert.equal(result.results[0].item.enabled, false); assert.equal(result.results[1].ok, false);
  assert.equal((await runtime.source(second.id)).enabled, true);
  for (const items of [null, {}, 'all']) await json(await call(routes, 'source-status', { data: { items } }), 400);
});

test('question routes support CRUD with source-filtered links and reject stale versions', async t => {
  const { routes, runtime, file } = await setup(t), source = await runtime.save({ name: 'questions', engine: 'sqlite', file });
  const created = (await json(await call(routes, 'questions-save', { data: { sourceId: source.id, text: '有多少条记录？' } }))).item;
  assert.ok(created.id); assert.equal(created.version, 1);
  assert.deepEqual((await json(await call(routes, 'questions-list', { data: { id: source.id } }))).items, [{ ...created, analysisStatus: 'missing' }]);
  const edited = (await json(await call(routes, 'questions-save', { data: { ...created, text: '记录总量是多少？' } }))).item;
  assert.equal(edited.id, created.id); assert.equal(edited.version, created.version + 1);
  await json(await call(routes, 'questions-save', { data: { ...created, text: 'stale' } }), 409);
  await json(await call(routes, 'questions-remove', { data: { id: created.id, version: created.version } }), 409);
  await json(await call(routes, 'questions-remove', { data: { id: edited.id, version: edited.version } }));
  assert.deepEqual((await json(await call(routes, 'questions-list', { data: { id: source.id } }))).items, []);
});

test('flow route wrappers forward Request signal for non-AI operations', async t => {
  const { routes, flow } = await setup(t), controller = new AbortController();
  let seen;
  flow.action = async (input, signal) => { seen = signal; assert.equal(input.action, 'scan'); return { revision: 4 }; };
  assert.deepEqual(await json(await call(routes, 'flow-action', { data: { action: 'scan' }, signal: controller.signal })), { state: { revision: 4 } });
  assert.equal(seen.aborted, false); controller.abort(); assert.equal(seen.aborted, true);
  flow.sampleTable = async (_input, signal) => { assert.ok(signal instanceof AbortSignal); return { samples: [[1]] }; };
  assert.deepEqual(await json(await call(routes, 'flow-samples', { data: {} })), { samples: [[1]] });
  flow.action = async () => { throw Object.assign(new Error('private raw failure'), { publicMessage: '推荐失败。', status: 409, sessionId: 'session-failed' }); };
  assert.deepEqual(await json(await call(routes, 'flow-action', { data: {} }), 409), { error: '推荐失败。', sessionId: 'session-failed' });
});

test('every POST route enforces JSON media type, object bodies and request size before mutation', async t => {
  const { routes, runtime } = await setup(t);
  for (const operation of operations) {
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'application/jsonp' }]) assert.match((await json(await call(routes, operation, { headers, body: '{}' }), 415)).error, /JSON/);
    for (const body of ['', '{', 'null', '[]', '123', 'false', '"string"']) {
      const result = await json(await call(routes, operation, { body }), 400); assert.match(result.error, /格式无效/); assert.doesNotMatch(JSON.stringify(result), /stack|SyntaxError|JSON\.parse|file:\/\//);
    }
    const limit = operation.startsWith('flow-') ? 1048576 : 32768;
    assert.match((await json(await call(routes, operation, { body: JSON.stringify({ text: 'x'.repeat(limit + 1) }) }), 413)).error, /过长/);
  }
  assert.deepEqual(await runtime.list(), []);
});

test('case-insensitive JSON with charset works and safe validation errors hide raw internals', async t => {
  const { routes, file, runtime, credentials } = await setup(t);
  const saved = await json(await call(routes, 'save', { headers: { 'Content-Type': 'Application/JSON; charset=UTF-8' }, data: { name: 'charset', engine: 'sqlite', file } })); assert.ok(saved.item.id);
  for (const data of [{ name: '', engine: 'sqlite', file }, { name: 'invalid', engine: 'oracle' }, { ...network, port: 70000 }, { ...network, host: 'mysql://user:validation-secret@host/db' }]) { const result = await json(await call(routes, 'save', { data }), 400); assert.doesNotMatch(JSON.stringify(result), /stack|validation-secret|mysql:\/\//); }
  for (const id of [undefined, null, 123, '']) assert.equal((await json(await call(routes, 'remove', { data: { id } }), 400)).error, '请选择要删除的数据源。');
  runtime.list = async () => { throw new Error('mysql://user:driver-secret@host/db\nstack'); };
  assert.deepEqual(await json(await call(routes, 'list'), 400), { error: '操作失败，请检查连接信息后重试。' });
  credentials.modifyRecord = async () => { throw new Error('postgres://user:credential-secret@host/db'); };
  const error = await json(await call(routes, 'save', { data: { ...network, password: 'new-secret' } }), 400); assert.doesNotMatch(JSON.stringify(error), /credential-secret|new-secret|postgres:\/\//);
});

test('an already aborted Request returns cancellation JSON', async t => {
  const { routes } = await setup(t), controller = new AbortController(); controller.abort();
  assert.match((await json(await call(routes, 'list', { signal: controller.signal }), 408)).error, /取消/);
});

function hostFixture(credentials = new CredentialRecords()) {
  const routes = new Map(), tools = new Map(); let dispose;
  const ctx = { credentials,
    provide(name, value) { this[name] = value; },
    sessionController: { create() {}, prompt() {}, resolveAgent() {}, cancel() {}, async *observeEvent() { yield { type: 'ready' }; } },
    sessions: { flush() {}, get() {} }, agents: { get() {} },
    connection: { fetch: { register(route) { assert.equal(routes.has(route.path), false); routes.set(route.path, route); } } },
    tools: { register(tool) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); } },
    on(event, handler) { assert.equal(event, 'dispose'); dispose = handler; },
  };
  return { ctx, routes, tools, credentials, close: () => dispose() };
}
function serviceFixture() {
  let closed = false;
  const runtime = { list: async () => [{ id: 'fixture-source' }], getTools: () => ['sql_list', 'sql_query', 'sql_schema'].map(name => ({ name, execute: async () => ({ executed: name }) })) };
  const flow = { scopedSql: (_name, args, execution, execute) => execute(args, execution), executor: { getTool: () => ({ execute: async () => ({ persisted: true }) }) } };
  return { runtime, flow, store: new DatasourceStore(), close: async () => { closed = true; }, get closed() { return closed; } };
}

test('task routes validate requests, expose conflict ids and detach execution from HTTP signals', async t => {
  const f = hostFixture(), service = serviceFixture();
  const entered = Promise.withResolvers();
  let executionSignal;
  service.flow.ai = async (_input, signal, report) => {
    executionSignal = signal;
    report({ sessionId: 'diagnostic-session' });
    entered.resolve();
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('cancelled'));
      else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  };
  await applyWithServices(f.ctx, {}, { initialServices: service });
  t.after(() => f.close());
  assert.ok(f.ctx.datasourceHttp);
  assert.equal(f.ctx.datasourceHttp.enabled, false);
  assert.equal(f.ctx.datasourceHttp.routes.has(API_PREFIX + '/management-save'), false);
  const route = f.routes.get(API_PREFIX + '/ai-tasks');
  const query = value => route.fetch(new Request('http://localhost' + route.path + value));
  const post = (input, signal) => route.fetch(new Request('http://localhost' + route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal }));
  const input = { id: 'fixture-source', action: 'detect-domains', revision: 0 };
  for (const invalid of [{ ...input, cwd: '/private' }, { ...input, action: 'scan' }, { ...input, revision: '0' }]) await json(await post(invalid), invalid.revision === '0' ? 409 : 400);
  for (const value of ['', '?sourceId=', '?taskId=x&sourceId=y', '?taskId=x&taskId=y', '?other=x']) await json(await query(value), 400);
  assert.deepEqual(await json(await query('?sourceId=none')), { task: null });
  await json(await query('?taskId=missing'), 404);
  const controller = new AbortController();
  const accepted = await json(await post(input, controller.signal), 202);
  await entered.promise;
  controller.abort();
  assert.equal(executionSignal.aborted, false);
  const snapshot = (await json(await query('?taskId=' + accepted.task.taskId))).task;
  assert.equal(snapshot.sessionId, 'diagnostic-session');
  assert.equal(snapshot.status, 'running');
  assert.equal((await json(await post(input), 409)).taskId, accepted.task.taskId);
  assert.equal((await json(await query('?sourceId=fixture-source'))).task.taskId, accepted.task.taskId);
  await json(await call(f.routes, 'flow-action', { data: input }), 400);
  assert.equal((await json(await call(f.routes, 'ai-tasks/cancel', { data: { taskId: accepted.task.taskId } }))).task.status, 'cancelling');
  await f.close();
  assert.equal((await json(await query('?taskId=' + accepted.task.taskId))).task.status, 'cancelled');
});
test('listener startup failure closes created datasource services', async t => {
  const occupied = createServer();
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const f = hostFixture(), service = serviceFixture();
  await assert.rejects(applyWithServices(f.ctx, { internalApi: { enabled: true, port: occupied.address().port } }, { initialServices: service }), { code: 'EADDRINUSE' });
  assert.equal(service.closed, true);
  assert.equal(f.ctx.datasourceHttp.server, null);
  assert.equal(f.ctx.datasourceHttp.routes.size, 0);
});

test('disposal cancels and settles tasks before closing flow services', async () => {
  const f = hostFixture(), service = serviceFixture(), entered = Promise.withResolvers(), order = [];
  service.flow.ai = async (_input, signal) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(service.closed, false);
    assert.equal(f.ctx.datasourceHttp.accepting, false);
    order.push('task');
    throw new Error('cancelled');
  };
  const originalClose = service.close;
  service.close = async () => { order.push('services'); await originalClose(); };
  await applyWithServices(f.ctx, {}, { initialServices: service });
  const route = f.routes.get(API_PREFIX + '/ai-tasks');
  await json(await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'source', action: 'detect-domains', revision: 0 }) })), 202);
  await entered.promise;
  await f.close();
  assert.deepEqual(order, ['task', 'services']);
});

const managementInput = { host: 'management.invalid', port: 3306, user: 'fixture_manager', database: 'fixture_management', password: 'synthetic-management-password' };

test('unconfigured Host binds all routes and tools, then activates after private bootstrap', async t => {
  const f = hostFixture(), service = serviceFixture(); let opened = 0;
  await applyWithServices(f.ctx, {}, { createServices: async options => { opened++; assert.equal(options.managementConfig.password, managementInput.password); assert.match(options.profileId, /^[a-f0-9]{64}$/); return service; } });
  t.after(() => f.close());
  assert.equal(f.routes.size, 15); assert.deepEqual([...f.tools.keys()].sort(), ['datasource_task', 'sql_list', 'sql_query', 'sql_schema']);
  assert.deepEqual(await json(await call(f.routes, 'management-status')), { configured: false, ready: false, message: '请先在数据源页面配置 MySQL 管理库。' });
  assert.match((await json(await call(f.routes, 'list'), 503)).error, /管理库/);
  for (const tool of f.tools.values()) await assert.rejects(tool.execute({}), /管理库/);
  const status = await json(await call(f.routes, 'management-save', { data: managementInput })); assert.equal(status.ready, true); assert.equal(status.configured, true); assert.equal(status.settings.hasPassword, true);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-management-password|"password"|payload/);
  const [[key, stored]] = [...f.credentials.records]; assert.match(key, /^sql\/management-[a-f0-9]{64}$/); assert.deepEqual(stored, { kind: 'grant', payload: managementInput });
  assert.equal((await json(await call(f.routes, 'list'))).items[0].id, 'fixture-source');
  assert.deepEqual(await f.tools.get('sql_query').execute({}), { executed: 'sql_query' }); assert.deepEqual(await f.tools.get('datasource_task').execute({}), { persisted: true });
  await json(await call(f.routes, 'management-save', { data: { ...managementInput, password: '' } }));
  await json(await call(f.routes, 'management-save', { data: { ...managementInput, database: 'another_management' } }), 409);
  await json(await call(f.routes, 'management-save', { data: { ...managementInput, password: 'changed-password' } }), 409);
  assert.equal(opened, 1); assert.equal(f.routes.size, 15); assert.equal(f.tools.size, 4);
});

test('stored bootstrap restarts services without exposing management passwords', async t => {
  const first = hostFixture(); await applyWithServices(first.ctx, {}, { createServices: async () => serviceFixture() }); await json(await call(first.routes, 'management-save', { data: managementInput })); await first.close();
  const f = hostFixture(first.credentials), service = serviceFixture();
  await applyWithServices(f.ctx, {}, { createServices: async options => { assert.equal(options.managementConfig.password, managementInput.password); return service; } }); t.after(() => f.close());
  const status = await json(await call(f.routes, 'management-status')); assert.equal(status.ready, true); assert.doesNotMatch(JSON.stringify(status), /synthetic-management-password|"password"/);
  await f.close(); assert.equal(service.closed, true); await assert.rejects(f.tools.get('sql_query').execute({}), /关闭/);
});

test('bootstrap and credential failures remain recoverable and close unpublished services', async t => {
  const f = hostFixture(), service = serviceFixture(); let failOpen = true;
  await applyWithServices(f.ctx, {}, { createServices: async () => { if (failOpen) throw new Error('mysql://fixture:driver-secret@management.invalid/db'); return service; } }); t.after(() => f.close());
  const failed = await json(await call(f.routes, 'management-save', { data: managementInput }), 503); assert.doesNotMatch(JSON.stringify(failed), /driver-secret|mysql:\/\//); assert.equal(f.credentials.records.size, 0); assert.equal((await json(await call(f.routes, 'management-status'))).ready, false);
  failOpen = false; f.credentials.modifyRecord = async () => { throw new Error('credential-secret'); };
  const failedSave = await json(await call(f.routes, 'management-save', { data: managementInput }), 503); assert.doesNotMatch(JSON.stringify(failedSave), /credential-secret/); assert.equal(service.closed, true); assert.equal((await json(await call(f.routes, 'management-status'))).ready, false);
});
