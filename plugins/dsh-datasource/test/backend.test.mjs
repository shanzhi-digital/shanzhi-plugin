import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { DatasourceRuntime } from '../runtime.js';
import { createAdapter, mysqlPoolConfig, postgresPoolConfig } from '../vendor/adapters.js';
import { assertReadQuery } from '../vendor/tools.js';
import { resolveConfig } from '../vendor/config.js';

class MemorySecrets {
  values = new Map();
  calls = [];
  async get(key) { this.calls.push(['get', key]); return this.values.get(key); }
  async set(key, value) { this.calls.push(['set', key]); this.values.set(key, value); }
  async delete(key) { this.calls.push(['delete', key]); this.values.delete(key); }
}
function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
function fixture(file, label = 'first') {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT NOT NULL, score INTEGER)');
  const statement = db.prepare('INSERT INTO samples(label, score) VALUES (?, ?)');
  statement.run(label, 7);
  statement.run('other', 11);
  db.close();
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-test-'));
  const file = join(directory, 'fixture.sqlite');
  fixture(file);
  const filePath = join(directory, 'metadata.json');
  const secrets = new MemorySecrets();
  const runtime = new DatasourceRuntime({ filePath, secrets });
  const runtimes = [runtime];
  t.after(async () => {
    await Promise.allSettled(runtimes.map((item) => item.close()));
    // Only remove the uniquely created temporary fixture directory.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.initialize();
  const tools = Object.fromEntries(runtime.getTools().map((tool) => [tool.name, tool]));
  return { directory, file, filePath, secrets, runtime, runtimes, tools };
}
const network = (name = '服务器') => ({ name, engine: 'mysql', host: 'localhost', port: 3306, user: 'readonly_user', database: 'fixture' });

test('empty store exposes exactly three stable tools and never invents a database', async (t) => {
  const { runtime, tools, directory } = await setup(t);
  assert.deepEqual(runtime.getTools().map((item) => item.name), ['sql_list', 'sql_query', 'sql_schema']);
  assert.equal(runtime.getTools(), runtime.getTools());
  assert.equal(runtime.getTools().every((tool) => tool.timeoutMs === 60000), true);
  assert.deepEqual(await runtime.list(), []);
  const result = await tools.sql_list.execute({});
  assert.deepEqual(result.connections, []);
  assert.match(result.message, /尚未配置.*添加/);
  assert.match(tools.sql_list.output.render({}, result)[0].text, /尚未配置/);
  await assert.rejects(tools.sql_query.execute({ sql: 'SELECT 1' }), /尚未配置/);
  await assert.rejects(tools.sql_schema.execute({}), /尚未配置/);
  assert.equal((await readdir(directory)).includes('metadata.json'), false);
  assert.deepEqual(resolveConfig({}).connections, []);
  assert.equal(resolveConfig({ readOnly: false }).readOnly, true);
});

test('CRUD persists public fields, stable ids and Chinese descriptions across reload', async (t) => {
  const { runtime, file, filePath, secrets, runtimes } = await setup(t);
  const created = await runtime.save({ name: ' 本地测试 ', description: '真实 SQLite 数据源', engine: 'sqlite', file });
  assert.ok(created.id);
  assert.equal(created.name, '本地测试');
  assert.equal(created.description, '真实 SQLite 数据源');
  assert.equal(created.hasPassword, false);
  assert.equal(created.file, file);
  const updated = await runtime.save({ id: created.id, name: '已编辑', description: '修改描述' });
  assert.equal(updated.id, created.id);
  assert.equal((await runtime.list())[0].name, '已编辑');
  const reloaded = new DatasourceRuntime({ filePath, secrets });
  runtimes.push(reloaded);
  await reloaded.initialize();
  assert.deepEqual(await reloaded.list(), [updated]);
  assert.deepEqual(await runtime.remove(created.id), { id: created.id, removed: true });
  assert.deepEqual(await runtime.list(), []);
  await assert.rejects(runtime.remove(created.id), /未找到/);
  const saved = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(saved, { version: 1, connections: [] });
});

test('validation rejects duplicate names, unsupported engines, DSNs and memory fallbacks', async (t) => {
  const { runtime, file } = await setup(t);
  await runtime.save({ name: 'Demo', engine: 'sqlite', file });
  await assert.rejects(runtime.save({ name: ' demo ', engine: 'sqlite', file }), /名称已存在/);
  for (const engine of ['oracle', 'SQLite', null, {}, 'postgresql']) {
    await assert.rejects(runtime.save({ name: 'invalid', engine, file }), /数据库类型/);
  }
  await assert.rejects(runtime.save({ name: 'missing file', engine: 'sqlite' }), /文件路径/);
  await assert.rejects(runtime.save({ name: 'memory', engine: 'sqlite', file: ':memory:' }), /实际.*文件/);
  await assert.rejects(runtime.save({ ...network(), host: 'mysql://user:fixture-secret@example.invalid/db' }), (error) => {
    assert.match(error.publicMessage, /主机地址/);
    assert.doesNotMatch(String(error), /fixture-secret|mysql:\/\//);
    return true;
  });
  await assert.rejects(runtime.save({ ...network(), port: 65536 }), /端口/);
  await assert.rejects(runtime.save({ id: 'missing', name: 'cannot create with arbitrary id' }), /未找到/);
  assert.equal((await runtime.list()).length, 1);
});

test('passwords only use the supplied secret store; blank edits preserve and explicit clear removes', async (t) => {
  const { runtime, filePath, secrets } = await setup(t);
  const syntheticPassword = '  synthetic-fixture-password  ';
  const created = await runtime.save({ ...network(), password: syntheticPassword, token: 'ignored-fixture-token', dsn: 'ignored-fixture-dsn' });
  const key = 'dsh-datasource:' + created.id + ':password';
  assert.equal(secrets.values.get(key), syntheticPassword);
  assert.equal(created.hasPassword, true);
  let metadata = await readFile(filePath, 'utf8');
  assert.doesNotMatch(metadata, /synthetic-fixture-password|ignored-fixture|"password"|dsh-datasource:/);
  assert.doesNotMatch(JSON.stringify(created), /synthetic-fixture-password|"password"/);
  const renamed = await runtime.save({ id: created.id, name: '改名不改密', password: '' });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.hasPassword, true);
  assert.equal(secrets.values.get(key), syntheticPassword);
  assert.doesNotMatch(JSON.stringify(await runtime.list()), /synthetic-fixture-password|"password"/);
  const cleared = await runtime.save({ id: created.id, clearPassword: true, password: '' });
  assert.equal(cleared.hasPassword, false);
  assert.equal(secrets.values.has(key), false);
  await runtime.save({ id: created.id, password: 'replacement-fixture-password' });
  await runtime.remove(created.id);
  assert.equal(secrets.values.has(key), false);
  metadata = await readFile(filePath, 'utf8');
  assert.doesNotMatch(metadata, /password|replacement/);
});

test('changing a password-protected server connection to SQLite removes the old credential', async (t) => {
  const { runtime, file, secrets } = await setup(t);
  const connection = await runtime.save({ ...network(), password: 'synthetic-password' });
  const sqlite = await runtime.save({ id: connection.id, engine: 'sqlite', file });
  assert.equal(sqlite.id, connection.id);
  assert.equal(sqlite.hasPassword, false);
  assert.equal(sqlite.host, '');
  assert.equal(secrets.values.size, 0);
});

test('real SQLite results retain columns/rows and schema, CSV and JSON outputs', async (t) => {
  const { runtime, tools, file } = await setup(t);
  await runtime.save({ name: '本地数据', engine: 'sqlite', file });
  const list = await tools.sql_list.execute({});
  assert.equal(list.connections[0].ok, true);
  assert.equal(list.connections[0].name, '本地数据');
  assert.deepEqual((await tools.sql_schema.execute({ connection: '本地数据' })).tables, ['samples']);
  const schema = await tools.sql_schema.execute({ table: 'samples' });
  assert.equal(schema.columns[0].name, 'id');
  assert.equal(schema.columns[0].primaryKey, true);
  const query = await tools.sql_query.execute({ sql: 'SELECT label, score FROM samples ORDER BY id' });
  assert.deepEqual(query.columns, ['label', 'score']);
  assert.deepEqual(query.rows, [['first', 7], ['other', 11]]);
  assert.equal(query.rowCount, 2);
  assert.equal(query.maxRows, 1000);
  assert.equal(query.truncated, false);
  const csv = await tools.sql_query.execute({ sql: 'SELECT label, score FROM samples ORDER BY id', format: 'csv' });
  assert.equal(csv.formatted, 'label,score\nfirst,7\nother,11');
  const json = await tools.sql_query.execute({ sql: 'SELECT score FROM samples ORDER BY id', format: 'json' });
  assert.deepEqual(JSON.parse(json.formatted), [{ score: 7 }, { score: 11 }]);
});

test('tools see new, renamed, edited and removed connections without being registered again', async (t) => {
  const { runtime, tools, file, directory } = await setup(t);
  const queryTool = tools.sql_query;
  const first = await runtime.save({ name: 'first', engine: 'sqlite', file });
  assert.deepEqual((await queryTool.execute({ connection: 'FIRST', sql: 'SELECT label FROM samples WHERE id=1' })).rows, [['first']]);
  const secondFile = join(directory, 'second.sqlite');
  fixture(secondFile, 'second');
  const edited = await runtime.save({ id: first.id, name: 'renamed', file: secondFile });
  assert.equal(edited.id, first.id);
  await assert.rejects(queryTool.execute({ connection: 'first', sql: 'SELECT 1' }), /未找到/);
  assert.deepEqual((await queryTool.execute({ connection: 'renamed', sql: 'SELECT label FROM samples WHERE id=1' })).rows, [['second']]);
  await runtime.remove(first.id);
  await assert.rejects(queryTool.execute({ sql: 'SELECT 1' }), /尚未配置/);
  assert.equal(runtime.getTools().find((tool) => tool.name === 'sql_query'), queryTool);
});

test('SQL write paths and multiple statements are rejected and the real file stays unchanged', async (t) => {
  const { runtime, tools, file } = await setup(t);
  await runtime.save({ name: 'real', engine: 'sqlite', file, readOnly: false });
  const rejected = [
    'DELETE FROM samples',
    "INSERT INTO samples(label) VALUES ('bad')",
    'CREATE TABLE forbidden(id INTEGER)',
    'SELECT 1; DELETE FROM samples',
    'WITH changed AS (DELETE FROM samples RETURNING *) SELECT * FROM changed',
    'EXPLAIN DELETE FROM samples',
    'SELECT * INTO new_table FROM samples',
    'SELECT * FROM samples FOR UPDATE',
    'PRAGMA writable_schema(1)',
    'PRAGMA user_version=999',
    "ATTACH DATABASE ':memory:' AS unsafe",
    'SELECT load_extension(\'nonexistent\')',
  ];
  for (const sql of rejected) await assert.rejects(tools.sql_query.execute({ sql }), /只读/);
  assert.deepEqual((await tools.sql_query.execute({ sql: 'SELECT count(*) AS count FROM samples' })).rows, [[2]]);
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  await assert.rejects(adapter.exec('DELETE FROM samples'), /readonly/i);
  await assert.rejects(adapter.query('DELETE FROM samples'), /readonly/i);
  await adapter.close();
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS count FROM samples').get().count, 2);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='forbidden'").get().count, 0);
  db.close();
});

test('query truncates to 1000 actual rows with the original result shape', async (t) => {
  const { runtime, tools, file } = await setup(t);
  await runtime.save({ name: 'limited', engine: 'sqlite', file });
  const result = await tools.sql_query.execute({ sql: 'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1200) SELECT x FROM n' });
  assert.equal(result.rows.length, 1000);
  assert.deepEqual(result.columns, ['x']);
  assert.deepEqual(result.rows[0], [1]);
  assert.deepEqual(result.rows[999], [1000]);
  assert.equal(result.truncated, true);
  assert.equal(result.maxRows, 1000);
});

test('test uses a temporary read-only adapter, closes it, and does not save draft configuration', async (t) => {
  const { runtime, file, filePath } = await setup(t);
  const probe = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.close;
  let closed = 0;
  prototype.close = async function () { closed += 1; return original.call(this); };
  try {
    assert.equal((await runtime.test({ name: 'draft', engine: 'sqlite', file })).ok, true);
    assert.equal(closed, 1);
    assert.deepEqual(await runtime.list(), []);
    await assert.rejects(readFile(filePath), { code: 'ENOENT' });
    const saved = await runtime.save({ name: 'saved', engine: 'sqlite', file });
    assert.equal((await runtime.test(saved.id)).ok, true);
    assert.equal((await runtime.test({ id: saved.id, password: '' })).ok, true);
    assert.equal(closed, 3);
  } finally { prototype.close = original; }
});

test('blank-password draft tests reuse the saved secret and driver errors never expose credentials or DSNs', async (t) => {
  const { runtime, secrets } = await setup(t);
  const secret = 'synthetic-driver-secret';
  const connection = await runtime.save({ ...network(), password: secret });
  const original = mysql.createPool;
  const seen = [];
  mysql.createPool = (options) => {
    seen.push(options.password);
    throw new Error('mysql://readonly_user:' + secret + '@example.invalid/fixture');
  };
  try {
    const result = await runtime.test({ id: connection.id, password: '' });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-driver-secret|mysql:\/\//);
    assert.deepEqual(seen, [secret]);
    const list = await runtime.getTools().find((tool) => tool.name === 'sql_list').execute({});
    assert.equal(list.connections[0].ok, false);
    assert.doesNotMatch(JSON.stringify(list), /synthetic-driver-secret|mysql:\/\//);
    const query = runtime.getTools().find((tool) => tool.name === 'sql_query');
    await assert.rejects(query.execute({ sql: 'SELECT 1' }), (error) => {
      assert.doesNotMatch(String(error), /synthetic-driver-secret|mysql:\/\//);
      assert.ok(error.publicMessage);
      return true;
    });
    assert.equal(secrets.values.size, 1);
  } finally { mysql.createPool = original; }
});

test('secret service errors are sanitized and failed secret updates leave metadata unchanged', async (t) => {
  const { runtime, secrets, filePath } = await setup(t);
  const connection = await runtime.save({ ...network(), password: 'initial-fixture-secret' });
  const before = await readFile(filePath, 'utf8');
  const originalSet = secrets.set;
  secrets.set = async () => { throw new Error('postgres://user:leaky-fixture-secret@host/db'); };
  await assert.rejects(runtime.save({ id: connection.id, name: 'must not persist', password: 'new-fixture-secret' }), (error) => {
    assert.match(error.publicMessage, /安全凭据/);
    assert.doesNotMatch(String(error), /leaky-fixture-secret|postgres:\/\//);
    return true;
  });
  assert.equal(await readFile(filePath, 'utf8'), before);
  secrets.set = originalSet;
  secrets.get = async () => { throw new Error('mysql://user:another-secret@host/db'); };
  await assert.rejects(runtime.list(), (error) => {
    assert.match(error.publicMessage, /安全凭据/);
    assert.doesNotMatch(String(error), /another-secret|mysql:\/\//);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(await runtime.test(connection.id)), /another-secret|mysql:\/\//);
});

test('a failed atomic metadata commit rolls back a newly written secret', async (t) => {
  const { runtime, secrets, filePath } = await setup(t);
  await mkdir(filePath);
  await assert.rejects(runtime.save({ ...network(), password: 'rollback-fixture-secret' }), /无法保存/);
  assert.equal(secrets.values.size, 0);
  assert.deepEqual(await runtime.list(), []);
});

test('serialized concurrent saves do not lose connections or leave temporary files', async (t) => {
  const { runtime, file, directory, filePath } = await setup(t);
  const entries = await Promise.all(Array.from({ length: 16 }, (_, index) => runtime.save({ name: '连接' + index, engine: 'sqlite', file })));
  assert.equal(new Set(entries.map((item) => item.id)).size, 16);
  assert.equal((await runtime.list()).length, 16);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).connections.length, 16);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
  const results = await Promise.allSettled([
    runtime.save({ name: 'same', engine: 'sqlite', file }),
    runtime.save({ name: 'SAME', engine: 'sqlite', file }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await runtime.list()).length, 17);
});

test('in-flight adapters survive edits/deletion and retire only after their query completes', async (t) => {
  const { runtime, tools, file, directory } = await setup(t);
  const connection = await runtime.save({ name: 'live', engine: 'sqlite', file });
  const second = join(directory, 'edited.sqlite');
  fixture(second, 'edited');
  const probe = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalQuery = prototype.query;
  const originalClose = prototype.close;
  const started = deferred();
  const release = deferred();
  let firstAdapter;
  const closes = [];
  prototype.query = async function (...args) {
    if (!firstAdapter) {
      firstAdapter = this;
      started.resolve();
      await release.promise;
    }
    return originalQuery.apply(this, args);
  };
  prototype.close = async function () { closes.push(this); return originalClose.call(this); };
  let pending;
  try {
    pending = tools.sql_query.execute({ sql: 'SELECT label FROM samples WHERE id=1' });
    await started.promise;
    await runtime.save({ id: connection.id, file: second });
    assert.equal(closes.includes(firstAdapter), false);
    assert.deepEqual((await tools.sql_query.execute({ sql: 'SELECT label FROM samples WHERE id=1' })).rows, [['edited']]);
    await runtime.remove(connection.id);
    assert.equal(closes.includes(firstAdapter), false);
    assert.deepEqual((await tools.sql_list.execute({})).connections, []);
    let finishedClosing = false;
    const closing = runtime.close().then(() => { finishedClosing = true; });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(finishedClosing, false);
    assert.equal(closes.includes(firstAdapter), false);
    release.resolve();
    assert.deepEqual((await pending).rows, [['first']]);
    await closing;
    assert.equal(closes.filter((adapter) => adapter === firstAdapter).length, 1);
    assert.equal(closes.length, 2);
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await runtime.close();
    prototype.query = originalQuery;
    prototype.close = originalClose;
  }
});

test('close waits for in-flight work, is idempotent and rejects later operations safely', async (t) => {
  const { runtime, tools, file } = await setup(t);
  await runtime.save({ name: 'close', engine: 'sqlite', file });
  await tools.sql_query.execute({ sql: 'SELECT 1' });
  const firstClose = runtime.close();
  assert.equal(runtime.close(), firstClose);
  await firstClose;
  await assert.rejects(tools.sql_query.execute({ sql: 'SELECT 1' }), /已关闭/);
  await assert.rejects(runtime.save({ name: 'late', engine: 'sqlite', file }), /已关闭/);
});

test('invalid metadata fails closed without rewriting the original file', async (t) => {
  const { directory, secrets, runtimes } = await setup(t);
  const path = join(directory, 'invalid.json');
  const content = '{invalid-json';
  await writeFile(path, content);
  const runtime = new DatasourceRuntime({ filePath: path, secrets });
  runtimes.push(runtime);
  await assert.rejects(runtime.initialize(), /配置/);
  assert.equal(await readFile(path, 'utf8'), content);
});

test('vendor retains engine-aware SQL guards and restrictive pool settings', () => {
  assert.equal(assertReadQuery("SELECT 'DELETE; UPDATE' AS harmless", 'sqlite'), "SELECT 'DELETE; UPDATE' AS harmless");
  assert.throws(() => assertReadQuery('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'postgres'));
  assert.throws(() => assertReadQuery('SELECT 1 FOR SHARE', 'mysql'));
  assert.throws(() => assertReadQuery('PRAGMA foreign_keys(0)', 'sqlite'));
  assert.throws(() => assertReadQuery("SELECT 'a\\'; DELETE FROM t; --'", 'sqlite'));
  assert.equal(mysqlPoolConfig(network()).multipleStatements, false);
  assert.equal(mysqlPoolConfig(network()).connectTimeout, 60000);
  assert.match(postgresPoolConfig({ engine: 'postgres' }, true).options, /read_only=on/);
  assert.equal(postgresPoolConfig({ engine: 'postgres' }, true).connectionTimeoutMillis, 60000);
});
