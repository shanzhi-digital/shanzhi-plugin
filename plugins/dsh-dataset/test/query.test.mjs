import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueryService } from '../query.js';
import { readSourcePassword } from '../credentials.js';
import { mysqlPoolConfig, postgresPoolConfig } from '../vendor/adapters.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'question-query-')), file = join(directory, 'business.sqlite');
  const business = new DatabaseSync(file);
  business.exec('CREATE TABLE sales(amount INTEGER); INSERT INTO sales VALUES(12),(8); CREATE TABLE hidden(secret TEXT);');
  business.close();
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE dsh_sources(profile_id TEXT,source_id TEXT,metadata TEXT,enabled INTEGER,connection_version INTEGER,created_at INTEGER);
    CREATE TABLE dsh_source_tables(profile_id TEXT,source_id TEXT,table_id TEXT,table_name TEXT,schema_name TEXT,table_kind TEXT,enabled INTEGER,fields TEXT,structure_hash TEXT,position INTEGER);`);
  sqlite.prepare('INSERT INTO dsh_sources VALUES(?,?,?,?,?,?)').run('p', 's', JSON.stringify({ id: 's', name: '业务源', engine: 'sqlite', file, password: 'DO_NOT_EXPOSE', host: 'private-host', credentialRef: 'private' }), 1, 1, 1);
  sqlite.exec(`INSERT INTO dsh_source_tables VALUES('p','s','t','sales','main','table',1,'[{"name":"amount","type":"INTEGER"}]','hash',0);
    INSERT INTO dsh_source_tables VALUES('p','s','h','hidden','main','table',0,'[{"name":"secret"}]','secret-hash',1);
    ALTER TABLE dsh_source_tables ADD COLUMN source_comment TEXT;
    UPDATE dsh_source_tables SET source_comment='销售流水' WHERE table_id='t';`);
  const connection = { async execute(sql, params = []) { return [sqlite.prepare(sql).all(...params)]; } };
  const db = { profileId: 'p', pool: connection, transaction: work => work(connection) };
  const credentials = { readRecord() { throw new Error('SQLite must not request a password'); } };
  const service = createQueryService({ db, credentials });
  t.after(async () => { await service.close(); sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  return { sqlite, file, service };
}

test('SQLite executes actual SELECT and aggregate/CTE queries and reports only parser-referenced tables', async t => {
  const { service } = fixture(t);
  assert.deepEqual(await service.sources(), [{ id: 's', name: '业务源', engine: 'sqlite', enabled: true }]);
  const schema = await service.schema('s');
  assert.equal(schema.tables.length, 1); assert.equal(schema.tables[0].tableId, 't'); assert.equal(schema.tables[0].sourceComment, '销售流水');
  const result = await service.query('s', 'WITH x AS (SELECT amount FROM sales) SELECT SUM(amount) AS total FROM x');
  assert.deepEqual(result.columns, ['total']); assert.deepEqual(result.rows, [[20]]);
  assert.equal(result.rowCount, 1); assert.equal(result.truncated, false);
  assert.equal(result.connectionVersion, 1); assert.equal(schema.connectionVersion, 1);
  assert.deepEqual(result.tables, schema.tables);
  const literal = await service.query('s', "SELECT 'hidden' AS label FROM sales LIMIT 1");
  assert.equal(literal.tables.length, 1); assert.equal(literal.tables[0].tableId, 't');
});

test('rejects missing/disabled sources, disabled tables, no-table SQL, EXPLAIN, writes and multi-statements', async t => {
  const { sqlite, service } = fixture(t);
  for (const sql of ['SELECT 1', 'WITH x AS (SELECT 1 AS n) SELECT n FROM x', 'EXPLAIN SELECT * FROM sales', '/*x*/ EXPLAIN QUERY PLAN SELECT * FROM sales', 'SELECT * FROM hidden', 'SELECT * FROM sqlite_master', 'DELETE FROM sales', 'SELECT * FROM sales; DELETE FROM sales']) await assert.rejects(service.query('s', sql));
  await assert.rejects(service.query('missing', 'SELECT * FROM sales'), /未找到/);
  sqlite.exec('UPDATE dsh_sources SET enabled=0');
  await assert.rejects(service.query('s', 'SELECT * FROM sales'), /已停用/);
  assert.equal((await service.sources())[0].enabled, false);
});

test('caps actual results at 1000, handles cancellation and prevents writes to a replaced view', async t => {
  const { file, service } = fixture(t);
  const business = new DatabaseSync(file);
  business.exec('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) INSERT INTO sales SELECT x FROM n');
  const result = await service.query('s', 'SELECT * FROM sales');
  assert.equal(result.rows.length, 1000); assert.equal(result.rowCount, 1000); assert.equal(result.truncated, true);
  await assert.rejects(service.query('s', 'SELECT * FROM sales', AbortSignal.abort()), /取消/);
  business.exec('DROP TABLE sales; CREATE VIEW sales AS SELECT secret AS amount FROM hidden');
  business.close();
  await assert.rejects(service.query('s', 'SELECT * FROM sales'), /表已变化|被拒绝/);
  await service.close(); await assert.rejects(service.schema('s'), /已关闭/);
});

test('driver pool settings own password values after the temporary source config is cleared', () => {
  const connection = { engine: 'mysql', host: 'localhost', database: 'business', user: 'reader', password: 'secret' };
  const mysql = mysqlPoolConfig(connection), postgres = postgresPoolConfig(connection, true);
  delete connection.password;
  assert.equal(mysql.password, 'secret'); assert.equal(postgres.password, 'secret');
  assert.equal(mysql.multipleStatements, false);
});

test('reads original credential record keys without exposing or writing records', async () => {
  const keys = [];
  const credentials = { async readRecord(key) { keys.push(key); return { kind: 'grant', payload: { password: 'secret' } }; } };
  assert.equal(await readSourcePassword(credentials, { engine: 'mysql', id: 'ignored', credentialRef: 'ABC-123' }), 'secret');
  assert.deepEqual(keys, ['sql/dsh-datasource-abc-123-password']);
  assert.equal(await readSourcePassword(credentials, { engine: 'sqlite' }), undefined);
});
