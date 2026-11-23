import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdapter, sampleCatalogTable, scanSourceCatalog } from '../vendor/adapters.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-scan-test-'));
  const file = join(directory, 'source.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "odd""; name" ("a"" id" INTEGER, "second key" INTEGER, payload TEXT, dynamic TEXT,
      PRIMARY KEY ("a"" id", "second key"));
    CREATE TABLE empty_table (value TEXT);
    CREATE TABLE sqliteX (id INTEGER);
    CREATE TABLE generated (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) VIRTUAL);`);
  const insert = db.prepare('INSERT INTO "odd""; name" VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 15; i++) insert.run(i, i + 1, i === 0 ? '中'.repeat(5000) : 'short', i === 0 ? Buffer.alloc(10000) : 'value');
  db.exec('INSERT INTO generated(value) VALUES (3)');
  db.close();
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  return adapter;
}

test('SQLite scans real names, composite keys and generated columns before requesting bounded samples', async (t) => {
  const adapter = await fixture(t);
  const queries = [];
  const query = adapter.query.bind(adapter);
  adapter.query = async (sql, ...args) => { queries.push(sql); return query(sql, ...args); };
  const progress = [];
  const catalog = await scanSourceCatalog(adapter, { onProgress: value => progress.push(value) });
  assert.deepEqual(catalog.map(item => item.name), ['empty_table', 'generated', 'odd"; name', 'sqliteX']);
  assert.deepEqual(queries, []);
  const entry = catalog.find(item => item.name === 'odd"; name');
  assert.deepEqual(Object.keys(entry).sort(), ['fields', 'id', 'name', 'schema', 'sourceComment', 'tableKind']);
  assert.equal(entry.schema, 'main');
  assert.equal(entry.sourceComment, '');
  assert.deepEqual(entry.fields.map(field => field.primaryKey), [true, true, false, false]);
  assert.ok(entry.fields.every(field => field.sourceComment === ''));
  assert.deepEqual(entry.fields.map(field => field.name), ['a" id', 'second key', 'payload', 'dynamic']);
  const sample = await sampleCatalogTable(adapter, entry);
  assert.equal(sample.sampleStatus, 'ok');
  assert.equal(sample.samples.length, 10);
  assert.deepEqual(sample.samples[0], [0, 1, '中'.repeat(2048), null]);
  assert.equal(sample.sampleTruncated, true);
  assert.equal(queries.length, 1);
  assert.deepEqual(await sampleCatalogTable(adapter, catalog[0]), { samples: [], sampleStatus: 'empty', sampleTruncated: false });
  assert.deepEqual((await sampleCatalogTable(adapter, catalog[1])).samples, [[3, 6]]);
  assert.equal(queries.length, 3);
  assert.ok(queries.every(sql => sql.endsWith(' LIMIT 10')));
  assert.deepEqual(progress, Array.from({ length: 5 }, (_, completed) => ({ completed, total: 4 })));
  const repeated = await scanSourceCatalog(adapter);
  assert.deepEqual(repeated.map(item => item.id), catalog.map(item => item.id));
  await assert.rejects(adapter.exec('CREATE TABLE forbidden(id INTEGER)'), /readOnly=true/);
});

test('SQLite holds the catalog snapshot through a concurrent view replacement, then rejects the stale catalog', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-query-test-'));
  const file = join(directory, 'source.sqlite');
  const writer = new DatabaseSync(file);
  t.after(async () => { writer.close(); await rm(directory, { recursive: true, force: true }); });
  writer.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE enabled (value TEXT);
    CREATE TABLE disabled (value TEXT);
    INSERT INTO enabled VALUES ('public');
    INSERT INTO disabled VALUES ('private');`);
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  try {
    const tables = (await scanSourceCatalog(adapter)).filter(table => table.name === 'enabled');
    assert.equal(tables.length, 1);
    const sql = 'SELECT value FROM "main"."enabled"';
    const prepare = adapter.db.prepare.bind(adapter.db);
    let businessQueries = 0;
    adapter.db.prepare = query => {
      if (query === sql) {
        businessQueries++;
        writer.exec('ALTER TABLE enabled RENAME TO moved; CREATE VIEW enabled AS SELECT value FROM disabled;');
      }
      return prepare(query);
    };
    assert.deepEqual(await adapter.queryVerified(sql, 1, undefined, { tables }), { columns: ['value'], rows: [['public']] });
    await assert.rejects(adapter.queryVerified(sql, 1, undefined, { tables }), /刷新数据源目录/);
    assert.equal(businessQueries, 1);
    assert.deepEqual(await adapter.queryVerified('SELECT 1', 1, undefined, { tables: [] }), { columns: ['1'], rows: [[1]] });
  } finally {
    await adapter.close();
  }
});

test('sampling sanitizes read failures and scans sanitize structure failures', async (t) => {
  const adapter = await fixture(t);
  adapter.query = async () => { throw new Error('password=secret driver detail'); };
  const catalog = await scanSourceCatalog(adapter);
  const sample = await sampleCatalogTable(adapter, catalog[0]);
  assert.deepEqual(sample, { samples: [], sampleStatus: 'failed', sampleTruncated: false });
  const prepare = adapter.db.prepare.bind(adapter.db);
  adapter.db.prepare = (sql) => {
    if (sql.startsWith('PRAGMA main.table_xinfo')) throw new Error('password=secret');
    return prepare(sql);
  };
  await assert.rejects(scanSourceCatalog(adapter), { message: '读取数据源目录失败。' });
});

test('scanning and sampling propagate cancellation', async (t) => {
  const adapter = await fixture(t);
  const catalog = await scanSourceCatalog(adapter);
  const scanController = new AbortController();
  await assert.rejects(scanSourceCatalog(adapter, {
    signal: scanController.signal,
    onProgress: ({ completed }) => { if (completed === 1) scanController.abort(); },
  }), { name: 'AbortError' });
  await assert.rejects(scanSourceCatalog(adapter, { signal: scanController.signal }), { name: 'AbortError' });
  const sampleController = new AbortController();
  adapter.query = async () => { sampleController.abort(); sampleController.signal.throwIfAborted(); };
  await assert.rejects(sampleCatalogTable(adapter, catalog[0], { signal: sampleController.signal }), { name: 'AbortError' });
});

for (const engine of ['mysql', 'postgres']) {
  test(`${engine} scans ordered metadata and samples only the selected table`, async () => {
    const adapter = createAdapter({ engine }, { readOnly: true });
    await adapter.close(); // The pool was never connected; replace only database I/O below.
    const statements = [];
    const name = 'odd`"; table';
    const schema = 'biz`" schema';
    const tables = [{ name, schema, sourceComment: 'table comment', tableKind: 'table' }];
    if (engine === 'mysql') {
      tables.push(...Array.from({ length: 42 }, (_, index) => ({
        name: `table_${String(index).padStart(2, '0')}`, schema, sourceComment: null, tableKind: 'table',
      })));
      adapter.queryRows = async (query) => {
        statements.push(query);
        assert.match(query, /TABLE_SCHEMA = DATABASE\(\)/);
        if (query.includes('information_schema.TABLES')) {
          assert.match(query, /TABLE_TYPE = 'BASE TABLE'/);
          return [tables];
        }
        assert.match(query, /information_schema\.COLUMNS/);
        assert.match(query, /ORDER BY TABLE_NAME, ORDINAL_POSITION/);
        return [[
          { schema, tableName: name, name: 'key`"', type: 'int', columnKey: 'PRI', nullable: 'NO', sourceComment: 'key comment' },
          { schema, tableName: name, name: 'body', type: 'longtext', columnKey: '', nullable: 'YES', sourceComment: '' },
          { schema, tableName: name, name: 'binary', type: 'blob', columnKey: '', nullable: 'YES', sourceComment: null },
          ...tables.slice(1).map(table => ({
            schema, tableName: table.name, name: `${table.name}_key`, type: 'int', columnKey: '', nullable: 'YES', sourceComment: null,
          })),
        ]];
      };
    } else {
      tables.push({ ...tables[0], schema: 'second_schema' });
      adapter.queryWithSignal = async (query, values) => {
        statements.push(query);
        if (values === undefined) {
          assert.match(query, /has_schema_privilege/);
          assert.match(query, /has_table_privilege/);
          assert.match(query, /n\.nspname !~ '\^pg_'/);
          return { rows: tables };
        }
        const expectedTable = statements.length === 3 ? tables[1] : tables[0];
        assert.deepEqual(values, [expectedTable.schema, expectedTable.name]);
        assert.match(query, /a\.attnum = ANY\(k\.conkey\)/);
        const rows = [
          { name: 'key`"', type: 'integer', sampleType: 'int4', sampleBuiltin: true, primaryKey: true, notNull: true, sourceComment: 'key comment' },
          { name: 'body', type: 'text', sampleType: 'text', sampleBuiltin: true, primaryKey: false, notNull: false, sourceComment: '' },
          { name: 'binary', type: 'public.large_domain', sampleType: 'bytea', sampleBuiltin: true, primaryKey: false, notNull: false, sourceComment: '' },
        ];
        return { rows: statements.length === 4 ? rows.reverse() : rows };
      };
    }
    const sampleQueries = [];
    adapter.query = async (sql, limit) => {
      sampleQueries.push(sql);
      assert.equal(limit, undefined);
      assert.match(sql, / LIMIT 10$/);
      if (engine === 'mysql') {
        assert.match(sql, /^SELECT `key``"`, LEFT\(CAST\(`body` AS CHAR\), 2048\), NULL,/);
        assert.match(sql, /FROM `biz``" schema`\.`odd``"; table`/);
      } else {
        assert.match(sql, /^SELECT "key`""", LEFT\(CAST\("body" AS text\), 2048\), NULL,/);
        assert.match(sql, /FROM ONLY "biz`"" schema"\."odd`""; table"/);
      }
      return { rows: [[1, 'body', null, true]] };
    };
    const progress = [];
    const catalog = await scanSourceCatalog(adapter, { onProgress: value => progress.push(value) });
    assert.equal(statements.length, engine === 'mysql' ? 2 : 3);
    assert.deepEqual(sampleQueries, []);
    assert.deepEqual(catalog.map(({ name, schema }) => [schema, name]), tables.map(({ name, schema }) => [schema, name]));
    assert.deepEqual(progress, Array.from({ length: catalog.length + 1 }, (_, completed) => ({ completed, total: catalog.length })));
    const entry = catalog[0];
    assert.deepEqual(Object.keys(entry).sort(), ['fields', 'id', 'name', 'schema', 'sourceComment', 'tableKind']);
    assert.equal(entry.sourceComment, 'table comment');
    assert.deepEqual(entry.fields.map(field => field.name), ['key`"', 'body', 'binary']);
    assert.equal(entry.fields[0].sourceComment, 'key comment');
    assert.equal(entry.fields[0].primaryKey, true);
    assert.equal(entry.fields[0].notNull, true);
    assert.equal('sampleType' in entry.fields[2], false);
    if (engine === 'mysql') {
      assert.equal(catalog.length, 43);
      for (const table of catalog.slice(1)) {
        assert.equal(table.sourceComment, '');
        assert.deepEqual(table.fields, [{
          name: `${table.name}_key`, type: 'int', primaryKey: false, notNull: false, sourceComment: '',
        }]);
      }
    } else {
      assert.notEqual(entry.id, catalog[1].id);
      assert.equal(entry.fields[2].type, 'public.large_domain');
    }
    const sample = await sampleCatalogTable(adapter, entry);
    assert.deepEqual(sample, { samples: [[1, 'body', null]], sampleStatus: 'ok', sampleTruncated: true });
    assert.equal(sampleQueries.length, 1);
    assert.equal(statements.length, engine === 'mysql' ? 2 : 4);
  });
}

for (const engine of ['mysql', 'postgres']) {
  test(`${engine} catalog marks external objects and skips field/sample reads`, async () => {
    const adapter = createAdapter({ engine }, { readOnly: true });
    await adapter.close();
    const kinds = engine === 'postgres' ? ['foreign', 'partitioned', 'policy_table'] : ['external'];
    const statements = [];
    const tables = kinds.map((tableKind, index) => ({ name: `external_${index}`, schema: 'biz', tableKind }));
    adapter.queryRows = async sql => { statements.push(sql); assert.match(sql, /CASE WHEN ENGINE IN/); return [tables]; };
    adapter.queryWithSignal = async sql => { statements.push(sql); assert.match(sql, /CASE WHEN c\.relrowsecurity THEN 'policy_table'/); return { rows: tables }; };
    adapter.query = async () => { throw new Error('External data query must never run'); };
    const catalog = await scanSourceCatalog(adapter);
    assert.deepEqual(catalog.map(entry => entry.tableKind), kinds);
    assert.ok(catalog.every(entry => entry.fields.length === 0));
    for (const entry of catalog) assert.equal((await sampleCatalogTable(adapter, entry)).sampleStatus, 'failed');
    assert.equal(statements.length, 1);
  });

  test(`${engine} verifies catalog relations on the read-only query connection`, async () => {
    const adapter = createAdapter({ engine }, { readOnly: true });
    await adapter.close();
    const mysql = engine === 'mysql';
    const tables = [{ schema: 'biz`" schema', name: 'odd`"; table', tableKind: 'table' }];
    const probe = mysql ? 'SELECT 1 FROM `biz``" schema`.`odd``"; table` LIMIT 0'
      : 'SELECT 1 FROM ONLY "biz`"" schema"."odd`""; table" LIMIT 0';
    const sql = 'SELECT value FROM ' + (mysql ? '`biz``" schema`.`odd``"; table`' : 'ONLY "biz`"" schema"."odd`""; table"');
    const setup = mysql ? ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'START TRANSACTION READ ONLY']
      : ['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', 'SET LOCAL search_path = pg_catalog'];
    const statements = [];
    let available;
    let onProbe;
    function catalog(sql, values) {
      assert.deepEqual(values, [tables[0].schema, tables[0].name]);
      if (mysql) {
        assert.match(sql, /FROM information_schema\.TABLES/);
        assert.match(sql, /TABLE_SCHEMA = DATABASE\(\) AND BINARY TABLE_SCHEMA = \? AND BINARY TABLE_NAME = \?/);
        assert.match(sql, /TABLE_TYPE = 'BASE TABLE' AND ENGINE IN \('InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE'\)/);
      } else {
        assert.match(sql, /FROM pg_catalog\.pg_class/);
        assert.match(sql, /n\.nspname::text = \$1 AND c\.relname::text = \$2/);
        assert.match(sql, /c\.relkind = 'r' AND NOT c\.relrowsecurity/);
      }
      statements.push('catalog');
      const rows = available.shift() ? [{ ordinary: 1 }] : [];
      return mysql ? [rows] : { rows };
    }
    const connection = {
      async execute(query, values) { assert.ok(mysql); return catalog(query, values); },
      async query(query, values) {
        if (values) return catalog(query, values);
        statements.push(query);
        if (query === probe) onProbe?.();
        if (typeof query === 'object') {
          return mysql ? [[[7]], [{ name: 'value' }]] : { rows: [[7]], fields: [{ name: 'value' }] };
        }
      },
      release(discard) { statements.push(discard ? 'discard' : 'release'); },
      destroy() { statements.push('discard'); },
    };
    adapter.pool = mysql ? { async getConnection() { return connection; } } : { async connect() { return connection; } };
    const business = mysql ? { sql, rowsAsArray: true } : { text: sql, rowMode: 'array', queryMode: 'extended' };
    available = [true, true];
    assert.deepEqual(await adapter.queryVerified(sql, undefined, undefined, { tables }), { columns: ['value'], rows: [[7]] });
    assert.deepEqual(statements.splice(0), [...setup, 'catalog', probe, 'catalog', business, 'ROLLBACK', 'release']);
    available = [false];
    await assert.rejects(adapter.queryVerified(sql, undefined, undefined, { tables }), /刷新数据源目录/);
    assert.deepEqual(statements.splice(0), [...setup, 'catalog', 'ROLLBACK', 'release']);
    available = [true, false];
    await assert.rejects(adapter.queryVerified(sql, undefined, undefined, { tables }), /刷新数据源目录/);
    assert.deepEqual(statements.splice(0), [...setup, 'catalog', probe, 'catalog', 'ROLLBACK', 'release']);
    const controller = new AbortController();
    onProbe = () => controller.abort();
    available = [true];
    await assert.rejects(adapter.queryVerified(sql, undefined, controller.signal, { tables }), { name: 'AbortError' });
    assert.deepEqual(statements, [...setup, 'catalog', probe, 'discard']);
  });

  test(`${engine} query fails closed when read-only setup fails`, async () => {
    const adapter = createAdapter({ engine }, { readOnly: true });
    await adapter.close();
    const statements = [];
    const connection = {
      async query(sql) { statements.push(sql); if (sql !== 'ROLLBACK') throw new Error('setup failed'); },
      release() {}, destroy() {},
    };
    adapter.pool = engine === 'mysql' ? { async getConnection() { return connection; } } : { async connect() { return connection; } };
    await assert.rejects(adapter.query('SELECT should_not_execute'), /setup failed/);
    assert.deepEqual(statements, [engine === 'mysql' ? 'START TRANSACTION READ ONLY' : 'BEGIN READ ONLY', 'ROLLBACK']);
  });
}

test('PostgreSQL fixes the transaction search path before every business query', async () => {
  const adapter = createAdapter({ engine: 'postgres' }, { readOnly: true });
  await adapter.close();
  const statements = [];
  adapter.pool = { async connect() { return {
    async query(sql) {
      statements.push(sql);
      return typeof sql === 'string' ? undefined : { fields: [{ name: 'value' }], rows: [[1]] };
    }, release() {},
  }; } };
  assert.deepEqual(await adapter.query('SELECT 1'), { columns: ['value'], rows: [[1]] });
  assert.deepEqual(statements, ['BEGIN READ ONLY', 'SET LOCAL search_path = pg_catalog',
    { text: 'SELECT 1', rowMode: 'array', queryMode: 'extended' }, 'ROLLBACK']);
});

test('SQLite virtual and shadow tables are marked and never sampled', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-virtual-test-'));
  const file = join(directory, 'source.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE VIRTUAL TABLE search USING fts5(body)');
  db.close();
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const prepare = adapter.db.prepare.bind(adapter.db);
  adapter.db.prepare = sql => { assert.doesNotMatch(sql, /table_xinfo/); return prepare(sql); };
  adapter.query = async () => { throw new Error('Virtual data query must never run'); };
  const catalog = await scanSourceCatalog(adapter);
  assert.equal(catalog.find(entry => entry.name === 'search').tableKind, 'virtual');
  assert.ok(catalog.some(entry => entry.tableKind === 'shadow'));
  assert.ok(catalog.every(entry => entry.fields.length === 0));
  for (const entry of catalog) assert.equal((await sampleCatalogTable(adapter, entry)).sampleStatus, 'failed');
});

test('PostgreSQL sampling never calls custom type casts or output functions', async () => {
  const adapter = createAdapter({ engine: 'postgres' }, { readOnly: true });
  await adapter.close();
  adapter.queryWithSignal = async () => ({ rows: [
    { name: 'payload', type: 'custom_type', sampleType: 'text', sampleBuiltin: false },
    { name: 'plain', type: 'text', sampleType: 'text', sampleBuiltin: true },
  ] });
  adapter.query = async sql => {
    assert.match(sql, /^SELECT NULL, LEFT\(CAST\("plain" AS text\), 2048\), \(\(TRUE\)/);
    assert.doesNotMatch(sql, /"payload"/);
    return { rows: [[null, 'value', true]] };
  };
  const result = await sampleCatalogTable(adapter, { schema: 'biz', name: 'data', tableKind: 'table', fields: [
    { name: 'payload', type: 'custom_type' }, { name: 'plain', type: 'text' },
  ] });
  assert.deepEqual(result, { samples: [[null, 'value']], sampleStatus: 'ok', sampleTruncated: true });
});

test('SQLite readOnly exec rejects before preparing SQL even for an in-memory adapter', async () => {
  const adapter = createAdapter({ engine: 'sqlite', file: ':memory:' }, { readOnly: true });
  adapter.db.prepare = () => { throw new Error('Must reject before SQL preparation'); };
  await assert.rejects(adapter.exec('CREATE TABLE forbidden(id INTEGER)'), /readOnly=true/);
  await adapter.close();
});
