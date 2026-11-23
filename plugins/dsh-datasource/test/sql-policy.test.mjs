import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { authorizeQuery } from '../sql-policy.js';
import { assertReadQuery, buildSqlTools } from '../vendor/tools.js';

const schemas = { mysql: 'business', postgres: 'public', sqlite: 'main' };
function context(engine, extra = []) {
  const schema = schemas[engine];
  return { engine, database: 'business', tables: [
    { name: 'orders', schema, enabled: true, tableKind: 'table' },
    { name: 'customers', schema, enabled: true, tableKind: 'table' },
    { name: 'private_data', schema, enabled: false, tableKind: 'table' },
    { name: 'virtual_data', schema, enabled: true, tableKind: 'virtual' },
    { name: 'legacy_data', schema, enabled: true },
    ...extra,
  ] };
}

for (const engine of Object.keys(schemas)) {
  test(`${engine} authorizes CTE, JOIN, grouped expressions, subqueries and UNION recursively`, () => {
    const sql = `WITH recent AS (SELECT id, customer_id FROM orders WHERE id > 0),
      selected AS (SELECT id FROM recent)
      SELECT r.customer_id, COUNT(DISTINCT r.id) AS total, COALESCE(MAX(c.id), 0) AS biggest
      FROM recent r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.id IN (SELECT id FROM selected)
      GROUP BY r.customer_id HAVING COUNT(*) > 1
      UNION ALL SELECT id, 0, 0 FROM (SELECT id FROM customers) c
      ORDER BY 2 DESC LIMIT 5 OFFSET 1`;
    const result = authorizeQuery(sql, context(engine));
    assert.match(result, /WITH .recent. AS \(SELECT/);
    assert.match(result, new RegExp(`FROM (?:ONLY )?.${schemas[engine]}.\\..orders.`));
    assert.match(result, /LEFT JOIN (?:ONLY )?.\w+.\..customers./);
    assert.match(result, /IN \(SELECT .id. FROM .selected.\)/);
    assert.match(result, /UNION ALL SELECT .* ORDER BY 2 DESC LIMIT 5 OFFSET 1$/);
    assert.doesNotMatch(result, /\.(?:[`\"]recent[`\"]|[`\"]selected[`\"])/);
    assert.match(authorizeQuery('SELECT 1 FROM orders CROSS JOIN customers', context(engine)), / CROSS JOIN /);
    assert.match(authorizeQuery('EXPLAIN SELECT 1 FROM orders', context(engine)), /^EXPLAIN SELECT /);
  });

  test(`${engine} rejects disallowed relations in nested statements and unsupported syntax`, () => {
    const reject = [
      'SELECT * FROM unknown_table',
      'SELECT * FROM legacy_data',
      'SELECT * FROM virtual_data',
      'SELECT * FROM private_data',
      'SELECT * FROM orders UNION ALL SELECT * FROM private_data',
      'SELECT * FROM orders JOIN private_data ON 1 = 1',
      'SELECT * FROM orders WHERE EXISTS (SELECT 1 FROM private_data)',
      'SELECT (SELECT id FROM private_data) FROM orders',
      'SELECT * FROM (SELECT * FROM private_data) AS derived',
      'WITH x AS (SELECT * FROM private_data) SELECT 1',
      'WITH private_data AS (SELECT 1) SELECT * FROM foreign_schema.private_data',
      'SELECT * FROM unknown_schema.orders',
      'SELECT 1; SELECT 2',
      'SELECT 1;;;',
      'SELECT id FROM orders FOR UPDATE',
      'SELECT id INTO copy_of_orders FROM orders',
      'SELECT id FROM orders LOCK IN SHARE MODE',
      "SELECT id FROM orders INTO OUTFILE '/tmp/readonly-test'",
      'SELECT id FROM orders WHERE id = unknown_function(0)',
      'SELECT unknown_namespace.lower(0)',
      'SELECT * FROM unknown_function(0)',
      'SELECT CAST(id AS custom_type) FROM orders',
      'SELECT @var := id FROM orders',
      'EXPLAIN ANALYZE SELECT id FROM orders',
      'EXPLAIN SELECT * FROM private_data',
      'EXPLAIN PRAGMA page_count',
      'EXPLAIN QUERY PLAN PRAGMA table_info(orders)',
      'WITH x AS (DELETE FROM orders RETURNING id) SELECT * FROM x',
      'SELECT * FROM orders /* missing end',
      "SELECT 'missing end",
    ];
    for (const sql of reject) assert.throws(() => authorizeQuery(sql, context(engine)), /sql_query|SQL/, sql);
    for (const sql of ['SHOW TABLES', 'DESCRIBE orders', 'PRAGMA table_info(orders)']) {
      assert.throws(() => authorizeQuery(sql, context(engine)), /sql_schema/, sql);
    }
  });

  test(`${engine} resolves scoped CTEs without authorizing a similarly named actual table`, () => {
    const opts = context(engine);
    const local = authorizeQuery('WITH private_data AS (SELECT 1 AS id) SELECT id FROM private_data', opts);
    assert.match(local, /FROM .private_data.$/);
    assert.throws(() => authorizeQuery(`WITH private_data AS (SELECT 1) SELECT * FROM ${schemas[engine]}.private_data`, opts));
    assert.throws(() => authorizeQuery('SELECT * FROM (WITH private_data AS (SELECT 1) SELECT * FROM private_data) a JOIN private_data b ON TRUE', opts));
    const forward = 'WITH x AS (SELECT * FROM private_data), private_data AS (SELECT 1) SELECT * FROM x';
    if (engine === 'sqlite') assert.match(authorizeQuery(forward, opts), /FROM .private_data./);
    else assert.throws(() => authorizeQuery(forward, opts), /目录/);
  });
}

test('PostgreSQL folds unquoted identifiers, keeps quoted spelling and qualifies catalog references', () => {
  const opts = context('postgres', [
    { name: 'MixedCase', schema: 'public', enabled: true, tableKind: 'table' },
    { name: 'mixedcase', schema: 'public', enabled: false, tableKind: 'table' },
    { name: 'a"b', schema: 'Analytics', enabled: true, tableKind: 'table' },
    { name: 'orders', schema: 'analytics', enabled: true, tableKind: 'table' },
    { name: 'pg_class', schema: 'pg_catalog', enabled: true, tableKind: 'table' },
  ]);
  assert.equal(authorizeQuery('SELECT Pg_Catalog.LOWER(o.Label) AS "Value" FROM "MixedCase" AS O', opts),
    'SELECT pg_catalog.lower("o"."label") AS "Value" FROM ONLY "public"."MixedCase" AS "o"');
  assert.equal(authorizeQuery('SELECT * FROM "Analytics"."a""b"', opts), 'SELECT * FROM ONLY "Analytics"."a""b"');
  assert.equal(authorizeQuery('SELECT * FROM ANALYTICS.ORDERS', opts), 'SELECT * FROM ONLY "analytics"."orders"');
  assert.equal(authorizeQuery('SELECT CAST(1 AS DECIMAL(12, 2))', opts), 'SELECT CAST(1 AS pg_catalog.numeric(12, 2))');
  for (const sql of ['SELECT * FROM MixedCase', 'SELECT * FROM db.public.orders', 'SELECT * FROM pg_catalog.pg_class',
    'SELECT * FROM "public"."mixedcase"', 'SELECT CAST(id AS regclass) FROM orders', 'SELECT lower(CAST(id AS custom_type)) FROM orders']) {
    assert.throws(() => authorizeQuery(sql, opts), undefined, sql);
  }
  const recursive = authorizeQuery('WITH RECURSIVE Numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM Numbers WHERE n < 4) SELECT n FROM Numbers', opts);
  assert.match(recursive, /WITH RECURSIVE "numbers"\("n"\).*FROM "numbers"/);
});

test('SQLite executes canonical CTE, bracket identifiers, strings and EXPLAIN in memory', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE orders (id INTEGER, "unit price" INTEGER); INSERT INTO orders VALUES (1, 42);');
    db.exec('CREATE TABLE private_data (id INTEGER); INSERT INTO private_data VALUES (500);');
    const opts = context('sqlite');
    const sql = authorizeQuery(`WITH alias AS (SELECT * FROM later), later AS (
      SELECT id, [unit price] FROM MAIN.Orders UNION ALL SELECT 2, 0)
      SELECT id, [unit price], 'it''s -- ; /* */' AS note FROM alias ORDER BY id`, opts);
    assert.deepEqual(db.prepare(sql).all().map((row) => Object.values(row)), [[1, 42, "it's -- ; /* */"], [2, 0, "it's -- ; /* */"]]);
    assert.ok(db.prepare(authorizeQuery('EXPLAIN QUERY PLAN SELECT * FROM orders', opts)).all().length > 0);
    assert.equal(db.prepare(authorizeQuery("SELECT group_concat(id, ',') AS ids FROM orders", opts)).get().ids, '1');
    assert.throws(() => authorizeQuery('SELECT * FROM temp.orders', opts));
  } finally {
    db.close();
  }
});

test('guards comments and statement separators according to engine', () => {
  const mysql = context('mysql');
  assert.equal(authorizeQuery('SELECT 1--2', mysql), 'SELECT (1 - -2)');
  assert.equal(authorizeQuery('SELECT/**/1 # ignored ;\n;', mysql), 'SELECT 1');
  assert.equal(authorizeQuery("SELECT '/*! not executable */; # --';", mysql), "SELECT '/*! not executable */; # --'");
  assert.equal(authorizeQuery('SELECT /* nested /* block */ comment */ 1--2', context('postgres')), 'SELECT 1');
  assert.equal(authorizeQuery('SELECT $tag$it\'s -- ;$tag$', context('postgres')), "SELECT 'it''s -- ;'");
  for (const sql of ['SELECT 1 /*! + 1 */', 'SELECT 1 /*M! + 1 */', 'SELECT 1 /*m! + 1 */', 'SELECT 1--no_space; SELECT 2']) {
    assert.throws(() => authorizeQuery(sql, mysql), undefined, sql);
    assert.throws(() => assertReadQuery(sql, 'mysql'), undefined, sql);
  }
  for (const engine of ['postgres', 'sqlite']) {
    assert.throws(() => authorizeQuery('SELECT 1 # invalid comment', context(engine)));
    assert.throws(() => authorizeQuery('SELECT 1 # ignored ; SELECT 2', context(engine)));
    assert.throws(() => assertReadQuery('SELECT 1 # ignored ; SELECT 2', engine));
  }
  assert.equal(assertReadQuery('SELECT/**/1', 'mysql'), 'SELECT/**/1');
  assert.equal(assertReadQuery("SELECT 'UPDATE; DELETE' AS text", 'sqlite'), "SELECT 'UPDATE; DELETE' AS text");
  for (const sql of ['EXPLAIN/**/QUERY PLAN/**/PRAGMA page_count', 'SELECT/**/1 /* open', "SELECT 'open", 'SELECT "open']) {
    assert.throws(() => assertReadQuery(sql, 'sqlite'), undefined, sql);
  }
});

test('read-only tool renderers consume runtime connection and table results', () => {
  const tools = buildSqlTools().tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['sql_list', 'sql_query', 'sql_schema']);
  const [list, , schema] = tools;
  const connections = [{ name: 'Business', engine: 'sqlite', connected: true }];
  assert.match(list.output.render({}, { connections })[0].text, /Business（sqlite） 正常/);
  const tables = [{ name: 'orders', schema: 'main', columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }] }];
  assert.match(schema.output.render({}, { tables })[0].text, /main\.orders/);
  assert.match(schema.output.render({ table: 'orders' }, { tables })[0].text, /id INTEGER（主键）/);
});
