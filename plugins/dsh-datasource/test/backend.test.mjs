import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DatasourceRuntime } from '../runtime.js';
import { DatasourceStore } from '../store.js';
import { createAdapter, mysqlPoolConfig, postgresPoolConfig } from '../vendor/adapters.js';
import { assertReadQuery } from '../vendor/tools.js';

class MemorySecrets {
  values = new Map();
  async get(key) { return this.values.get(key); }
  async set(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}
const network = (name = '服务器') => ({ name, engine: 'mysql', host: 'localhost', port: 3306, user: 'readonly_user', database: 'fixture' });
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-backend-'));
  const file = join(directory, 'fixture.sqlite');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT NOT NULL, updated_at DATETIME); INSERT INTO samples VALUES (1, 'first', '2026-01-01 00:00:00'), (2, 'other', '2026-01-02 00:00:00'); CREATE TABLE hidden (id INTEGER); INSERT INTO hidden VALUES (1); CREATE VIEW sample_view AS SELECT * FROM samples");
  db.close();
  const store = new DatasourceStore(), secrets = new MemorySecrets();
  const runtime = new DatasourceRuntime({ store, secrets, ...options });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize();
  const tools = Object.fromEntries(runtime.getTools().map(tool => [tool.name, tool]));
  return { directory, file, store, secrets, runtime, tools };
}
async function enableTables(store, id, tables, names = ['samples']) {
  await store.change(id, state => ({ state: { ...state, catalog: { ...state?.catalog, tables: tables.map(table => ({ ...table, enabled: names.includes(table.name) })) } } }));
}
async function configured(t, options) {
  const f = await setup(t, options);
  const source = await f.runtime.save({ name: '本地数据', engine: 'sqlite', file: f.file });
  const tables = await f.runtime.scan(source.id, source.connectionVersion);
  await enableTables(f.store, source.id, tables);
  return { ...f, source, tables };
}

test('memory store CRUD uses revisions, preserves stable ids and separates connection versions', async t => {
  const { runtime, store, file } = await setup(t);
  const created = await runtime.save({ name: ' 本地测试 ', description: '真实 SQLite 数据源', engine: 'sqlite', file });
  assert.equal(created.name, '本地测试'); assert.equal(created.enabled, true);
  assert.equal(created.revision, 1); assert.equal(created.connectionVersion, 1);
  const renamed = await runtime.save({ id: created.id, revision: created.revision, name: '已编辑', description: '修改描述' });
  assert.equal(renamed.id, created.id); assert.equal(renamed.revision, 2); assert.equal(renamed.connectionVersion, 1);
  await assert.rejects(runtime.save({ id: created.id, revision: created.revision, name: 'stale' }), { status: 409 });
  await assert.rejects(runtime.save({ id: created.id, name: 'missing revision' }), { status: 409 });
  assert.deepEqual(await runtime.source(created.id), renamed);
  assert.deepEqual(await runtime.list(), [{ ...renamed, tableCount: null }]);
  assert.equal((await store.listSources()).length, 1);
  await assert.rejects(runtime.remove(created.id, created.revision), { status: 409 });
  assert.deepEqual(await runtime.remove(created.id, renamed.revision), { id: created.id, removed: true });
  assert.deepEqual(await runtime.list(), []);
});

test('password CRUD stays in secrets and only target or credential changes invalidate connectionVersion', async t => {
  const { runtime, secrets, store, file } = await setup(t);
  const password = '  synthetic-fixture-password  ';
  const created = await runtime.save({ ...network(), password, token: 'ignored-token', dsn: 'ignored-dsn' });
  assert.equal(created.hasPassword, true); assert.deepEqual([...secrets.values.values()], [password]);
  assert.doesNotMatch(JSON.stringify({ created, listed: await runtime.list(), stored: await store.listSources() }), /synthetic-fixture-password|ignored-token|ignored-dsn|"password"/);
  assert.equal('credentialRef' in created, false);
  const renamed = await runtime.save({ id: created.id, revision: created.revision, name: '保留密码', password: '' });
  assert.equal(renamed.connectionVersion, created.connectionVersion); assert.equal(renamed.hasPassword, true);
  await assert.rejects(runtime.save({ id: created.id, revision: created.revision, password: 'stale-secret' }), { status: 409 });
  assert.deepEqual([...secrets.values.values()], [password]);
  const changed = await runtime.save({ id: created.id, revision: renamed.revision, password: 'replacement-password' });
  assert.equal(changed.connectionVersion, renamed.connectionVersion + 1);
  const cleared = await runtime.save({ id: created.id, revision: changed.revision, clearPassword: true });
  assert.equal(cleared.hasPassword, false); assert.equal(secrets.values.size, 0);
  const protectedSource = await runtime.save({ id: created.id, revision: cleared.revision, password });
  const sqlite = await runtime.save({ id: created.id, revision: protectedSource.revision, engine: 'sqlite', file });
  assert.equal(sqlite.hasPassword, false); assert.equal(sqlite.host, ''); assert.equal(secrets.values.size, 0);
  await runtime.remove(sqlite.id, sqlite.revision); assert.equal(secrets.values.size, 0);
  const removable = await runtime.save({ ...network('待删除凭据'), password });
  assert.equal(secrets.values.size, 1);
  await runtime.remove(removable.id, removable.revision); assert.equal(secrets.values.size, 0);
});

test('failed store commits roll back credentials and preserve source metadata', async t => {
  const { runtime, secrets, store } = await setup(t);
  const created = await runtime.save({ ...network(), password: 'original-password' });
  const save = store.saveSource.bind(store);
  store.saveSource = async () => { throw new Error('synthetic-store-detail'); };
  await assert.rejects(runtime.save({ id: created.id, revision: created.revision, name: 'not committed', password: 'new-password' }));
  assert.deepEqual(await runtime.source(created.id), created);
  assert.deepEqual([...secrets.values.values()], ['original-password']);
  await assert.rejects(runtime.save({ ...network('new source'), password: 'uncommitted-password' }));
  assert.equal((await runtime.list()).length, 1);
  assert.deepEqual([...secrets.values.values()], ['original-password']);
  store.saveSource = save;
});

test('secret failures never expose passwords or DSNs to runtime callers', async t => {
  const { runtime, secrets } = await setup(t);
  const created = await runtime.save({ ...network(), password: 'saved-password' });
  secrets.set = async () => { throw new Error('postgres://user:leaky-secret@host/db'); };
  await assert.rejects(runtime.save({ id: created.id, revision: created.revision, password: 'new-password' }), error => {
    assert.ok(error.publicMessage); assert.doesNotMatch(String(error), /leaky-secret|postgres:\/\//); return true;
  });
  secrets.get = async () => { throw new Error('mysql://user:read-secret@host/db'); };
  await assert.rejects(runtime.list(), error => { assert.ok(error.publicMessage); assert.doesNotMatch(String(error), /read-secret|mysql:\/\//); return true; });
  assert.doesNotMatch(JSON.stringify(await runtime.test(created.id)), /read-secret|mysql:\/\//);
});

test('blank-password draft probes reuse saved secrets and driver errors stay private', async t => {
  const seen = [];
  const { runtime, tools, secrets } = await setup(t, { adapterFactory: (connection, options) => {
    seen.push({ password: connection.password, readOnly: options.readOnly });
    throw new Error('mysql://readonly_user:synthetic-driver-secret@example.invalid/fixture');
  } });
  const created = await runtime.save({ ...network(), password: 'synthetic-driver-secret' });
  const tested = await runtime.test({ id: created.id, password: '' });
  assert.equal(tested.ok, false); assert.doesNotMatch(JSON.stringify(tested), /synthetic-driver-secret|mysql:\/\//);
  const listed = await tools.sql_list.execute({}); assert.equal(listed.connections[0].connected, false);
  assert.doesNotMatch(JSON.stringify(listed), /synthetic-driver-secret|mysql:\/\//);
  await assert.rejects(tools.sql_query.execute({ sql: 'SELECT 1' }), error => { assert.ok(error.publicMessage); assert.doesNotMatch(String(error), /synthetic-driver-secret|mysql:\/\//); return true; });
  assert.ok(seen.length >= 2); assert.ok(seen.every(item => item.password === 'synthetic-driver-secret' && item.readOnly));
  assert.equal(secrets.values.size, 1);
});

test('validation rejects duplicates, unsupported engines, DSNs and memory connections', async t => {
  const { runtime, file } = await setup(t);
  await runtime.save({ name: 'Demo', engine: 'sqlite', file });
  await assert.rejects(runtime.save({ name: ' demo ', engine: 'sqlite', file }), /名称/);
  for (const engine of ['oracle', 'SQLite', null, {}, 'postgresql']) await assert.rejects(runtime.save({ name: 'invalid', engine, file }), /数据库类型/);
  await assert.rejects(runtime.save({ name: 'missing', engine: 'sqlite' }), /文件路径/);
  await assert.rejects(runtime.save({ name: 'memory', engine: 'sqlite', file: ':memory:' }), /实际.*文件/);
  await assert.rejects(runtime.save({ ...network(), host: 'mysql://user:secret@example.invalid/db' }), error => { assert.match(error.publicMessage, /主机地址/); assert.doesNotMatch(String(error), /secret|mysql:\/\//); return true; });
  await assert.rejects(runtime.save({ ...network(), port: 65536 }), /端口/);
});

test('management database aliases are isolated from saved and draft business targets', async t => {
  let opened = 0;
  const { runtime } = await setup(t, { managementConfig: { engine: 'mysql', host: 'localhost', port: 3306, database: 'management' }, adapterFactory: () => { opened++; throw new Error('must not connect'); } });
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    const input = { ...network(host), host, database: 'MANAGEMENT' };
    await assert.rejects(runtime.save(input), /管理库/);
    assert.equal((await runtime.test(input)).ok, false);
  }
  assert.equal(opened, 0); assert.deepEqual(await runtime.list(), []);
  const safe = await runtime.save({ ...network(), database: 'business' }); assert.ok(safe.id);
});

test('stable SQL tools expose only enabled sources and ordinary enabled tables', async t => {
  const { runtime, tools, source, tables, store } = await configured(t);
  assert.deepEqual(runtime.getTools().map(tool => tool.name), ['sql_list', 'sql_query', 'sql_schema']);
  assert.equal(runtime.getTools(), runtime.getTools()); assert.ok(runtime.getTools().every(tool => tool.timeoutMs === 60000));
  assert.equal((await tools.sql_list.execute({})).connections[0].name, source.name);
  const schema = await tools.sql_schema.execute({}); assert.deepEqual(schema.tables.map(table => table.name), ['samples']);
  assert.equal(schema.tables[0].fields[0].name, 'id');
  assert.deepEqual((await tools.sql_query.execute({ sql: 'SELECT label FROM samples ORDER BY id' })).rows, [['first'], ['other']]);
  for (const sql of ['SELECT * FROM hidden', 'SELECT * FROM sample_view', 'SELECT * FROM sqlite_master', 'SELECT * FROM temp.samples', "SELECT readfile('x')", 'SELECT * FROM samples; DELETE FROM samples', 'WITH t AS (SELECT * FROM hidden) SELECT * FROM t', 'SELECT * FROM samples JOIN hidden ON 1=1']) await assert.rejects(tools.sql_query.execute({ sql }), sql);
  const enabledView = { id: 'view-fixture', schema: 'main', name: 'sample_view', tableKind: 'view', enabled: true, fields: tables.find(table => table.name === 'samples').fields };
  await store.change(source.id, state => ({ state: { ...state, catalog: { ...state.catalog, tables: [...state.catalog.tables, enabledView] } } }));
  assert.deepEqual((await tools.sql_schema.execute({})).tables.map(table => table.name), ['samples']);
  await assert.rejects(tools.sql_query.execute({ sql: 'SELECT * FROM sample_view' }));
  await assert.rejects(tools.sql_schema.execute({ table: 'hidden' }));
  await enableTables(store, source.id, tables, []);
  await assert.rejects(tools.sql_query.execute({ sql: 'SELECT * FROM samples' }));
  await enableTables(store, source.id, tables);
  const disabled = await runtime.setEnabled(source.id, false, source.revision);
  assert.equal(disabled.connectionVersion, source.connectionVersion); assert.ok(disabled.revision > source.revision);
  assert.deepEqual((await tools.sql_list.execute({})).connections, []);
  await assert.rejects(tools.sql_schema.execute({})); await assert.rejects(tools.sql_query.execute({ sql: 'SELECT * FROM samples' }));
  await assert.rejects(runtime.scan(source.id, source.connectionVersion)); assert.equal((await runtime.test(source.id)).ok, false);
  await assert.rejects(runtime.setEnabled(source.id, true, source.revision), { status: 409 });
  await runtime.setEnabled(source.id, true, disabled.revision);
  assert.deepEqual((await tools.sql_query.execute({ sql: 'SELECT label FROM samples WHERE id=1' })).rows, [['first']]);
});

test('scan reads catalog only; explicit samples and freshness use fixed reads and leave SQLite bytes unchanged', async t => {
  const reads = [], flags = [];
  const { runtime, file } = await setup(t, { adapterFactory: (source, options) => {
    flags.push(options.readOnly); const adapter = createAdapter(source, options), query = adapter.query.bind(adapter);
    adapter.query = (...args) => { reads.push(args[0]); return query(...args); }; return adapter;
  } });
  const source = await runtime.save({ name: 'scan', engine: 'sqlite', file });
  const before = await readFile(file), progress = [];
  const tables = await runtime.scan(source.id, source.connectionVersion, { onProgress: value => progress.push(value) });
  assert.ok(tables.some(table => table.name === 'samples' && table.fields.length === 3));
  assert.ok(tables.every(table => !Object.hasOwn(table, 'samples'))); assert.equal(progress.at(-1).completed, tables.length);
  assert.equal(reads.some(sql => /\bMAX\s*\(|\bLIMIT\s+10\b/i.test(sql)), false);
  const samples = tables.filter(table => table.name === 'samples'); reads.length = 0;
  const sampleResult = await runtime.sampleTables(source.id, source.connectionVersion, samples);
  assert.ok(sampleResult instanceof Map); assert.equal(sampleResult.get(samples[0].id).samples.length, 2); assert.ok(reads.some(sql => /LIMIT 10/i.test(sql)));
  reads.length = 0; const freshness = await runtime.detectFreshness(source.id, source.connectionVersion, samples);
  assert.ok(freshness instanceof Map); assert.equal(freshness.get(samples[0].id).status, 'OK'); assert.ok(reads.some(sql => /MAX\s*\(/i.test(sql)));
  assert.ok(flags.every(Boolean)); assert.equal(digest(await readFile(file)), digest(before)); assert.deepEqual(await readFile(file), before);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.scan(source.id, source.connectionVersion, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(runtime.sampleTables(source.id, source.connectionVersion, samples, controller.signal), { name: 'AbortError' });
});

test('runtime and SQLite driver reject mutation paths without changing the fixture', async t => {
  const { tools, file } = await configured(t), before = await readFile(file);
  for (const sql of ['DELETE FROM samples', "INSERT INTO samples VALUES (3, 'bad', null)", 'CREATE TABLE forbidden(id INTEGER)', 'SELECT 1; DELETE FROM samples', 'WITH changed AS (DELETE FROM samples RETURNING *) SELECT * FROM changed', 'EXPLAIN DELETE FROM samples', 'SELECT * INTO new_table FROM samples', 'SELECT * FROM samples FOR UPDATE', 'PRAGMA writable_schema(1)', 'PRAGMA user_version=999', "ATTACH DATABASE ':memory:' AS unsafe", "SELECT load_extension('nonexistent')"]) await assert.rejects(tools.sql_query.execute({ sql }), sql);
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  try { await assert.rejects(adapter.exec('DELETE FROM samples'), /readonly/i); await assert.rejects(adapter.query('DELETE FROM samples'), /readonly/i); } finally { await adapter.close(); }
  assert.deepEqual((await tools.sql_query.execute({ sql: 'SELECT count(*) AS total FROM samples' })).rows, [[2]]);
  assert.equal(digest(await readFile(file)), digest(before)); assert.deepEqual(await readFile(file), before);
});

test('draft probes are temporary, read-only and do not save configuration', async t => {
  let opened = 0, closed = 0;
  const { runtime, file } = await setup(t, { adapterFactory: (source, options) => { assert.equal(options.readOnly, true); opened++; const adapter = createAdapter(source, options), close = adapter.close.bind(adapter); adapter.close = async () => { closed++; await close(); }; return adapter; } });
  assert.equal((await runtime.test({ name: 'draft', engine: 'sqlite', file })).ok, true);
  assert.equal(opened, 1); assert.equal(closed, 1); assert.deepEqual(await runtime.list(), []);
});

test('query returns at most 1000 rows and runtime close rejects new work', async t => {
  const { runtime, tools, file } = await configured(t);
  const result = await tools.sql_query.execute({ sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200) SELECT x FROM n' });
  assert.equal(result.rows.length, 1000); assert.deepEqual(result.columns, ['x']); assert.deepEqual(result.rows[999], [1000]); assert.equal(result.truncated, true);
  await runtime.close(); await assert.rejects(tools.sql_query.execute({ sql: 'SELECT 1' }), /已关闭/);
  await assert.rejects(runtime.save({ name: 'late', engine: 'sqlite', file }), /已关闭/);
});

test('close cancels in-flight queries and waits until the adapter is released', async t => {
  let hold = false, readSignal, started, release, adapterClosed = false;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime, tools } = await configured(t, { adapterFactory: (source, options) => {
    const adapter = createAdapter(source, options), query = adapter.queryVerified.bind(adapter), close = adapter.close.bind(adapter);
    adapter.queryVerified = async (...args) => { if (hold) { readSignal = args[2]; started(); await gate; readSignal.throwIfAborted(); } return query(...args); };
    adapter.close = async () => { await close(); if (hold) adapterClosed = true; };
    return adapter;
  } });
  hold = true;
  const pending = tools.sql_query.execute({ sql: 'SELECT label FROM samples' });
  // Attach the rejection observer before shutdown cancels this operation.
  const rejected = assert.rejects(pending);
  await entered;
  let closed = false; const closing = runtime.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readSignal.aborted, true);
    assert.equal(closed, false, 'close must wait for the in-flight adapter cleanup');
    assert.equal(adapterClosed, false);
  } finally { release(); await rejected; await closing; }
  assert.equal(adapterClosed, true);
});

test('a table disabled during a query prevents delivery of its result', async t => {
  let hold = false, started, release;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime, tools, source, tables, store } = await configured(t, { adapterFactory: (connection, options) => {
    const adapter = createAdapter(connection, options), query = adapter.queryVerified.bind(adapter);
    adapter.queryVerified = async (...args) => { if (hold) { started(); await gate; } return query(...args); };
    return adapter;
  } });
  hold = true;
  const pending = tools.sql_query.execute({ sql: 'SELECT label FROM samples' });
  const rejected = assert.rejects(pending, /已启用/);
  await entered;
  try { await enableTables(store, source.id, tables, []); }
  finally { release(); }
  await rejected;
  await runtime.close();
});
test('vendor SQL guards and pool settings keep independent read-only protection', () => {
  assert.equal(assertReadQuery("SELECT 'DELETE; UPDATE' AS harmless", 'sqlite'), "SELECT 'DELETE; UPDATE' AS harmless");
  for (const [sql, engine] of [['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'postgres'], ['SELECT 1 FOR SHARE', 'mysql'], ['PRAGMA foreign_keys(0)', 'sqlite'], ["SELECT 'a\\'; DELETE FROM t; --'", 'sqlite']]) assert.throws(() => assertReadQuery(sql, engine));
  assert.equal(mysqlPoolConfig(network()).multipleStatements, false); assert.equal(mysqlPoolConfig(network()).connectTimeout, 60000);
  assert.match(postgresPoolConfig({ engine: 'postgres' }, true).options, /read_only=on/); assert.equal(postgresPoolConfig({ engine: 'postgres' }, true).connectionTimeoutMillis, 60000);
});
