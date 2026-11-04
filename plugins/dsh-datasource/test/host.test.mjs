import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { API_PREFIX, createSecrets, registerRoutes } from '../index.js';
import { DatasourceRuntime } from '../runtime.js';

// Contract fake for the Host's native CredentialRecords methods. It models record
// keys/documents, not the Host's encryption, owner authentication or authorization.
class CredentialRecords {
  records = new Map();
  calls = [];

  #check(key) {
    assert.match(key, /^sql\/[a-z][a-z0-9-]*$/);
  }
  async readRecord(key) {
    this.#check(key);
    this.calls.push(['readRecord', key]);
    return this.records.has(key) ? structuredClone(this.records.get(key)) : undefined;
  }
  async modifyRecord(key, modify) {
    this.#check(key);
    this.calls.push(['modifyRecord', key]);
    const previous = this.records.has(key) ? structuredClone(this.records.get(key)) : undefined;
    const next = await modify(previous);
    assert.equal(typeof next.kind, 'string');
    assert.equal(typeof next.payload, 'object');
    this.records.set(key, structuredClone(next));
    return structuredClone(next);
  }
  async deleteRecord(key) {
    this.#check(key);
    this.calls.push(['deleteRecord', key]);
    return this.records.delete(key);
  }
}

function register(runtime) {
  const routes = new Map();
  const ctx = { connection: { fetch: { register(definition) {
    assert.equal(routes.has(definition.path), false, 'routes must not overwrite each other');
    routes.set(definition.path, definition);
  } } } };
  registerRoutes(ctx, runtime);
  return routes;
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-datasource-host-test-'));
  const file = join(directory, 'fixture.sqlite');
  const filePath = join(directory, 'metadata.json');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO samples VALUES (1, \'host fixture\')');
  db.close();
  const credentials = new CredentialRecords();
  const runtime = new DatasourceRuntime({ filePath, secrets: createSecrets(credentials) });
  await runtime.initialize();
  const routes = register(runtime);
  t.after(async () => {
    await runtime.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    // Remove only this test's uniquely generated temporary directory.
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file, filePath, credentials, runtime, routes };
}

async function call(routes, operation, options = {}) {
  const route = routes.get(API_PREFIX + '/' + operation);
  assert.ok(route);
  const method = route.methods[0];
  const headers = options.headers ?? (method === 'POST' ? { 'Content-Type': 'application/json' } : {});
  const init = { method, headers, signal: options.signal };
  if (method === 'POST') init.body = Object.hasOwn(options, 'body') ? options.body : JSON.stringify(options.data ?? {});
  // Direct standard Request -> registered fetch invocation. There is no real
  // Host routing middleware, session cookie, owner check or network listener.
  return await route.fetch(new Request('http://localhost' + route.path, init));
}

async function json(response, status = 200) {
  assert.ok(response instanceof Response);
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json\b/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = JSON.parse(await response.text());
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value;
}

const network = { name: '服务器凭据', description: '不连接实际服务器', engine: 'mysql', host: 'localhost', port: 3306, user: 'readonly_fixture', database: 'fixture' };

test('createSecrets maps keys to native scoped records and performs password CRUD', async () => {
  const credentials = new CredentialRecords();
  const secrets = createSecrets(credentials);
  const key = 'DSH-Datasource:2B7995A5-7EAE-4729-BA8C-39ED7AD72ED8:Password';
  const recordKey = 'sql/dsh-datasource-2b7995a5-7eae-4729-ba8c-39ed7ad72ed8-password';
  assert.equal(await secrets.get(key), undefined);
  await secrets.set(key, '  synthetic-record-password  ');
  assert.deepEqual(credentials.records.get(recordKey), { kind: 'database-password', payload: { password: '  synthetic-record-password  ' } });
  assert.equal(await secrets.get(key), '  synthetic-record-password  ');
  await secrets.set(key, 'replacement-fixture-password');
  assert.equal(await secrets.get(key), 'replacement-fixture-password');
  assert.equal(credentials.records.size, 1);
  await secrets.delete(key);
  assert.equal(await secrets.get(key), undefined);
  assert.equal(credentials.records.size, 0);
  assert.ok(credentials.calls.some(([method, id]) => method === 'deleteRecord' && id === recordKey));
});

test('createSecrets treats absent, incomplete and non-string password payloads as absent', async () => {
  const credentials = new CredentialRecords();
  const secrets = createSecrets(credentials);
  const key = 'dsh-datasource:fixture:password';
  const id = 'sql/dsh-datasource-fixture-password';
  for (const value of [undefined, null, {}, { kind: 'database-password' }, { payload: null }, { payload: {} }, { payload: { password: 123 } }, { payload: { password: false } }]) {
    if (value === undefined) credentials.records.delete(id);
    else credentials.records.set(id, value);
    assert.equal(await secrets.get(key), undefined);
  }
  credentials.records.set(id, { payload: { password: '' } });
  assert.equal(await secrets.get(key), '');
});

test('createSecrets rejects invalid record ids before touching CredentialRecords', async () => {
  const credentials = new CredentialRecords();
  const secrets = createSecrets(credentials);
  for (const key of ['', '1starts-with-number', 'bad/record', '../outside', 'bad_key', 'not valid', '中文', 'bad?key']) {
    await assert.rejects(secrets.get(key), /无效.*凭据标识/);
    await assert.rejects(secrets.set(key, 'synthetic-password'), /无效.*凭据标识/);
    await assert.rejects(secrets.delete(key), /无效.*凭据标识/);
  }
  assert.deepEqual(credentials.calls, []);
});

test('registerRoutes declares the four exact buffered endpoints and their allowed methods', async (t) => {
  const { routes } = await setup(t);
  assert.equal(API_PREFIX, '/api/datasources');
  assert.deepEqual([...routes.keys()], ['/api/datasources/list', '/api/datasources/save', '/api/datasources/test', '/api/datasources/remove']);
  for (const [path, route] of routes) {
    assert.equal(route.requestBody, 'buffered');
    assert.deepEqual(route.methods, [path.endsWith('/list') ? 'GET' : 'POST']);
    assert.equal(typeof route.fetch, 'function');
  }
});

test('all four Request routes integrate with a real SQLite runtime and persist CRUD metadata', async (t) => {
  const { routes, runtime, file, filePath } = await setup(t);
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
  const saved = await json(await call(routes, 'save', { data: { name: '本地数据库', description: 'Host 集成测试', engine: 'sqlite', file } }));
  assert.equal(saved.item.name, '本地数据库');
  assert.equal(saved.item.description, 'Host 集成测试');
  assert.equal(saved.item.hasPassword, false);
  assert.ok(saved.item.id);
  const listed = await json(await call(routes, 'list'));
  assert.deepEqual(listed.items, [saved.item]);
  const tested = await json(await call(routes, 'test', { data: { id: saved.item.id, password: '' } }));
  assert.equal(tested.ok, true);
  assert.match(tested.message, /成功/);
  const query = runtime.getTools().find((tool) => tool.name === 'sql_query');
  assert.deepEqual((await query.execute({ connection: '本地数据库', sql: 'SELECT label FROM samples' })).rows, [['host fixture']]);
  const edited = await json(await call(routes, 'save', { data: { id: saved.item.id, name: '本地数据库改名', description: '编辑后的描述', password: '' } }));
  assert.equal(edited.item.id, saved.item.id);
  assert.equal(edited.item.description, '编辑后的描述');
  const metadata = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(metadata.connections[0].id, saved.item.id);
  assert.equal(metadata.connections[0].name, '本地数据库改名');
  const removed = await json(await call(routes, 'remove', { data: { id: saved.item.id } }));
  assert.deepEqual(removed, { ok: true });
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).connections, []);
});

test('draft SQLite testing returns JSON without saving a connection', async (t) => {
  const { routes, file, filePath } = await setup(t);
  const result = await json(await call(routes, 'test', { data: { name: '未保存测试', engine: 'sqlite', file } }));
  assert.equal(result.ok, true);
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
});

test('route responses never expose saved passwords and native records follow save/edit/remove', async (t) => {
  const { routes, credentials, filePath } = await setup(t);
  const password = 'synthetic-host-password';
  const saved = await json(await call(routes, 'save', { data: { ...network, password } }));
  assert.equal(saved.item.hasPassword, true);
  const key = 'sql/dsh-datasource-' + saved.item.id + '-password';
  assert.equal(credentials.records.get(key).payload.password, password);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic-host-password|"password"|"payload"/);
  const edited = await json(await call(routes, 'save', { data: { id: saved.item.id, name: '保留密码', password: '' } }));
  assert.equal(edited.item.hasPassword, true);
  assert.equal(credentials.records.get(key).payload.password, password);
  const listed = await json(await call(routes, 'list'));
  assert.equal(listed.items[0].hasPassword, true);
  assert.doesNotMatch(JSON.stringify(listed), /synthetic-host-password|"password"|"payload"/);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /synthetic-host-password|"password"|sql\/dsh-datasource/);
  const cleared = await json(await call(routes, 'save', { data: { id: saved.item.id, clearPassword: true } }));
  assert.equal(cleared.item.hasPassword, false);
  assert.equal(credentials.records.has(key), false);
  await json(await call(routes, 'save', { data: { id: saved.item.id, password: 'replacement-fixture-password' } }));
  await json(await call(routes, 'remove', { data: { id: saved.item.id } }));
  assert.equal(credentials.records.size, 0);
});

test('POST routes reject missing and unsupported media types with 415 JSON', async (t) => {
  const { routes } = await setup(t);
  for (const operation of ['save', 'test', 'remove']) {
    for (const headers of [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'application/jsonp' }, { 'content-type': 'application/json+xml' }]) {
      const response = await json(await call(routes, operation, { headers, body: '{}' }), 415);
      assert.match(response.error, /JSON/);
    }
  }
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
});

test('JSON media type with case and charset parameters is accepted', async (t) => {
  const { routes, file } = await setup(t);
  const result = await json(await call(routes, 'save', { headers: { 'Content-Type': 'Application/JSON; charset=UTF-8' }, data: { name: '有 charset 的请求', engine: 'sqlite', file } }));
  assert.ok(result.item.id);
});

test('POST routes reject invalid JSON and non-object JSON values with 400 JSON', async (t) => {
  const { routes } = await setup(t);
  for (const operation of ['save', 'test', 'remove']) {
    for (const body of ['', '{', '{"unterminated":', 'null', '[]', '123', 'false', '"string"']) {
      const result = await json(await call(routes, operation, { body }), 400);
      assert.match(result.error, /格式无效/);
      assert.doesNotMatch(JSON.stringify(result), /stack|SyntaxError|JSON\.parse|file:\/\//);
    }
  }
});

test('oversized JSON request bodies receive 413 without mutating metadata', async (t) => {
  const { routes, filePath } = await setup(t);
  const body = JSON.stringify({ description: 'x'.repeat(32769) });
  for (const operation of ['save', 'test', 'remove']) {
    const result = await json(await call(routes, operation, { body }), 413);
    assert.match(result.error, /过长/);
  }
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
});

test('save returns safe public validation messages instead of generic failures', async (t) => {
  const { routes, file } = await setup(t);
  const inputs = [
    [{ name: '', engine: 'sqlite', file }, /连接名称/],
    [{ name: '非法类型', engine: 'oracle', file }, /数据库类型/],
    [{ ...network, port: 70000 }, /端口/],
    [{ name: '缺少文件', engine: 'sqlite' }, /文件路径/],
    [{ ...network, host: 'mysql://user:synthetic-validation-password@example.invalid/db' }, /主机地址/],
  ];
  for (const [data, expected] of inputs) {
    const result = await json(await call(routes, 'save', { data }), 400);
    assert.match(result.error, expected);
    assert.doesNotMatch(JSON.stringify(result), /stack|synthetic-validation-password|mysql:\/\/|file:\/\//);
  }
  await json(await call(routes, 'save', { data: { name: '重复名称', engine: 'sqlite', file } }));
  const duplicate = await json(await call(routes, 'save', { data: { name: ' 重复名称 ', engine: 'sqlite', file } }), 400);
  assert.match(duplicate.error, /名称已存在/);
});

test('test failures and missing remove ids return bounded JSON without raw internals', async (t) => {
  const { routes, directory } = await setup(t);
  const failed = await json(await call(routes, 'test', { data: { name: '失败测试', engine: 'sqlite', file: join(directory, 'missing.sqlite') } }));
  assert.equal(failed.ok, false);
  assert.match(failed.message, /连接失败/);
  assert.doesNotMatch(JSON.stringify(failed), /stack|SqliteAdapter|readOnly|missing\.sqlite|file:\/\//);
  for (const data of [{}, { id: null }, { id: 123 }, { id: '' }]) {
    const result = await json(await call(routes, 'remove', { data }), 400);
    assert.equal(result.error, '请选择要删除的数据源。');
    assert.doesNotMatch(JSON.stringify(result), /stack|TypeError|file:\/\//);
  }
  const unknown = await json(await call(routes, 'remove', { data: { id: 'unknown-id' } }), 400);
  assert.match(unknown.error, /未找到/);
});

test('unexpected runtime errors are hidden rather than returning a stack, driver message or DSN', async (t) => {
  const { runtime, routes } = await setup(t);
  runtime.list = async () => { throw new Error('mysql://user:synthetic-driver-password@example.invalid/db\nraw driver stack'); };
  const result = await json(await call(routes, 'list'), 400);
  assert.deepEqual(result, { error: '操作失败，请检查连接信息后重试。' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-driver-password|mysql:\/\/|stack|Error:/);
});

test('credential service failures become safe public JSON errors', async (t) => {
  const { routes, credentials } = await setup(t);
  credentials.modifyRecord = async () => { throw new Error('postgres://user:synthetic-credential-password@example.invalid/db'); };
  const result = await json(await call(routes, 'save', { data: { ...network, password: 'synthetic-new-password' } }), 400);
  assert.match(result.error, /安全凭据/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-credential-password|synthetic-new-password|postgres:\/\/|stack/);
  assert.deepEqual(await json(await call(routes, 'list')), { items: [] });
});

test('an already-aborted standard Request returns a JSON cancellation response', async (t) => {
  const { routes } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const result = await json(await call(routes, 'list', { signal: controller.signal }), 408);
  assert.match(result.error, /取消/);
});
