import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAdapter, detectTableFreshness, scanSourceCatalog } from '../vendor/adapters.js';
import { freshnessCandidates, matchesFreshness, normalizeTemporalValue, temporalInfo, undetectedFreshness } from '../freshness.js';

const now = new Date(2026, 5, 15, 12, 30, 0).getTime();
const scannedAt = new Date(now).toISOString();
const table = (fields = [{ name: 'updated_at', type: 'timestamp' }]) => ({
  id: 'catalog-id', schema: 'biz"` schema', name: 'odd"`; table', tableKind: 'table', fields,
});
function mockAdapter(engine, values) {
  const queries = [];
  return { engine, queries, async query(sql, limit, signal) {
    assert.equal(limit, undefined);
    assert.ok(signal instanceof AbortSignal);
    signal.throwIfAborted();
    queries.push(sql);
    const rows = values.shift();
    if (rows instanceof Error) throw rows;
    assert.ok(rows, `Unexpected query ${sql}`);
    return { rows };
  } };
}

test('temporal candidates exclude time-only and unknown types, rank stably and stop at five', () => {
  const fields = [
    ['other', 'date'], ['created', 'datetime(6)'], ['updated', 'timestamp(3)'], ['modified', 'timestamp with time zone'],
    ['time_value', 'timestamp without time zone'], ['added', 'date'], ['more_updated', 'date'],
    ['clock', 'time'], ['clock_zone', 'time with time zone'], ['guess', ''], ['guess2', 'text'], ['custom', 'public.date'],
  ].map(([name, type]) => ({ name, type }));
  assert.deepEqual(freshnessCandidates(fields).map(field => field.name), ['updated', 'modified', 'more_updated', 'created', 'added']);
  assert.equal(temporalInfo('time(6)'), null);
  assert.equal(temporalInfo('timetz'), null);
  assert.equal(temporalInfo('timestamped'), null);
  assert.equal(temporalInfo('timestamptz').hasTimezone, true);
  assert.equal(undetectedFreshness().status, 'UNDETECTED');
});

test('existence checks distinguish empty and nonempty without COUNT or samples', async () => {
  const empty = mockAdapter('sqlite', [[]]);
  const result = await detectTableFreshness(empty, table(), { now });
  assert.equal(result.status, 'EMPTY');
  assert.equal(result.empty, true);
  assert.equal(result.scannedAt, scannedAt);
  assert.equal(result.lastDataAt, null);
  assert.equal(empty.queries.length, 1);
  assert.match(empty.queries[0], /^SELECT 1 FROM "biz""` schema"\."odd""`; table" LIMIT 1$/);
  const nonempty = mockAdapter('sqlite', [[[1]]]);
  const unknown = await detectTableFreshness(nonempty, table([{ name: 'date_text', type: '' }]), { now });
  assert.equal(unknown.status, 'NO_TIME_COLUMN');
  assert.equal(unknown.empty, false);
  assert.ok([...empty.queries, ...nonempty.queries].every(sql => !/COUNT|SELECT \*/i.test(sql)));
});

test('MAX falls back only for NULL and returns the actual selected date column', async () => {
  const adapter = mockAdapter('sqlite', [[[1]], [[null]], [['2026-06-01']]]);
  const result = await detectTableFreshness(adapter, table([
    { name: 'created_at', type: 'date' }, { name: 'updated";_at', type: 'datetime' },
  ]), { now: () => now });
  assert.equal(result.status, 'OK');
  assert.equal(result.timeColumn, 'created_at');
  assert.equal(result.lastDataAt, '2026-06-01');
  assert.equal(result.temporalKind, 'date');
  assert.equal(result.dateOnly, true);
  assert.equal(result.hasTimezone, false);
  assert.match(adapter.queries[1], /MAX\("updated"";_at"\)/);
  const allNull = mockAdapter('sqlite', [[[1]], ...Array.from({ length: 5 }, () => [[null]])]);
  const unknown = await detectTableFreshness(allNull, table(Array.from({ length: 8 }, (_, i) => ({ name: `updated_${i}`, type: 'date' }))), { now });
  assert.equal(unknown.status, 'NO_TIME_VALUE');
  assert.equal(unknown.empty, false);
  assert.equal(unknown.timeColumn, null);
  assert.equal(allNull.queries.length, 6);
});

for (const engine of ['mysql', 'postgres']) {
  test(`${engine} fixed detection quotes names and keeps server temporal text`, async () => {
    const adapter = mockAdapter(engine, [[[1]], [['2026-06-01 13:14:15.123456']]]);
    const result = await detectTableFreshness(adapter, table([{ name: 'update"`time', type: 'timestamp without time zone' }]), { now });
    assert.equal(result.status, 'OK');
    assert.equal(result.lastDataAt, '2026-06-01T13:14:15.123456');
    assert.equal(result.hasTimezone, false);
    if (engine === 'postgres') {
      assert.match(adapter.queries[0], /FROM ONLY "biz""` schema"\."odd""`; table"/);
      assert.match(adapter.queries[1], /CAST\(MAX\("update""`time"\) AS text\)/);
    } else {
      assert.match(adapter.queries[0], /FROM `biz"`` schema`\.`odd"``; table`/);
      assert.match(adapter.queries[1], /CAST\(MAX\(`update"``time`\) AS CHAR\)/);
    }
  });
}

test('MySQL TIMESTAMP uses its database epoch while DATETIME remains a wall clock', async () => {
  const instant = new Date('2026-06-01T04:00:00Z');
  const adapter = mockAdapter('mysql', [[[1]], [['2026-06-01 12:00:00', instant.getTime() / 1000]]]);
  const result = await detectTableFreshness(adapter, table([{ name: 'updated_at', type: 'timestamp(6)' }]), { now });
  assert.equal(result.lastDataAt, instant.toISOString());
  assert.equal(result.hasTimezone, true);
  assert.match(adapter.queries[1], /UNIX_TIMESTAMP\(MAX\(`updated_at`\)\)/);
});

test('errors are sanitized, preserve known nonempty state and propagate cancellation', async () => {
  const failed = await detectTableFreshness(mockAdapter('sqlite', [new Error('password=secret')]), table(), { now });
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.empty, null);
  assert.doesNotMatch(failed.error, /secret/);
  const maxFailed = await detectTableFreshness(mockAdapter('sqlite', [[[1]], new Error('secret')]), table(), { now });
  assert.equal(maxFailed.empty, false);
  assert.equal(maxFailed.timeColumn, 'updated_at');
  const invalid = await detectTableFreshness(mockAdapter('sqlite', [[[1]], [['not a date']]]), table(), { now });
  assert.equal(invalid.status, 'ERROR');
  const controller = new AbortController();
  const adapter = { engine: 'sqlite', async query() { controller.abort(); controller.signal.throwIfAborted(); } };
  await assert.rejects(detectTableFreshness(adapter, table(), { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(detectTableFreshness(adapter, table(), { signal: controller.signal }), { name: 'AbortError' });
});

test('nonordinary objects and old catalogs are rejected without database queries', async () => {
  for (const tableKind of ['foreign', 'virtual', 'shadow', 'partitioned', 'policy_table', 'external', undefined]) {
    const adapter = mockAdapter('sqlite', []);
    const result = await detectTableFreshness(adapter, { ...table(), tableKind }, { now });
    assert.equal(result.status, 'ERROR');
    assert.equal(result.empty, null);
    assert.deepEqual(adapter.queries, []);
  }
});

test('temporal normalization preserves date, timezone and naive wall-clock semantics', () => {
  assert.deepEqual(normalizeTemporalValue('2026-06-01', 'date'), { lastDataAt: '2026-06-01', temporalKind: 'date', dateOnly: true, hasTimezone: false });
  assert.equal(normalizeTemporalValue('2026-06-01 12:00:00+08', 'timestamp with time zone').lastDataAt, '2026-06-01T12:00:00+08:00');
  assert.equal(normalizeTemporalValue('2026-06-01T12:00:00Z', 'timestamptz').hasTimezone, true);
  assert.equal(normalizeTemporalValue('2026-06-01 12:00:00', 'datetime').hasTimezone, false);
  for (const value of ['2026-02-30', '2026-13-01', 'text']) assert.throws(() => normalizeTemporalValue(value, 'date'));
  assert.throws(() => normalizeTemporalValue('2026-06-01 12:00:00', 'timestamptz'));
});

for (const days of [30, 60, 120]) {
  test(`freshness ${days}-day filter includes exact boundary and excludes future/unknown`, () => {
    const boundary = new Date(now);
    boundary.setDate(boundary.getDate() - days);
    const localTimestamp = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}T${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
    const fresh = value => ({ status: 'OK', ...normalizeTemporalValue(value, 'datetime') });
    assert.equal(matchesFreshness(fresh(localTimestamp(boundary)), days, now), true);
    assert.equal(matchesFreshness(fresh(localTimestamp(new Date(boundary.getTime() - 1000))), days, now), false);
    assert.equal(matchesFreshness(fresh(localTimestamp(new Date(now + 1000))), days, now), false);
    assert.equal(matchesFreshness({ status: 'OK', ...normalizeTemporalValue(localTimestamp(boundary).slice(0, 10), 'date') }, days, now), true);
    assert.equal(matchesFreshness({ status: 'OK', ...normalizeTemporalValue(new Date(now).toISOString(), 'timestamptz') }, days, now), true);
    assert.equal(matchesFreshness({ status: 'OK', ...normalizeTemporalValue(new Date(now + 1).toISOString(), 'timestamptz') }, days, now), false);
    for (const status of ['UNDETECTED', 'EMPTY', 'NO_TIME_COLUMN', 'NO_TIME_VALUE', 'ERROR']) assert.equal(matchesFreshness({ status }, days, now), false);
    assert.equal(matchesFreshness(null, days, now), false);
  });
}

test('isolated SQLite fixture detects actual empty, dates and nulls without modifying source', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-freshness-'));
  const file = join(directory, 'source.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE empty_table(updated_at DATETIME);
    CREATE TABLE dated(updated_at DATETIME, created_at DATE);
    INSERT INTO dated VALUES(NULL, '2026-06-01');
    CREATE TABLE unknown(value);
    INSERT INTO unknown VALUES('2026-06-01');
    CREATE TABLE null_dates(updated_at TIMESTAMP);
    INSERT INTO null_dates VALUES(NULL);`);
  db.close();
  const adapter = createAdapter({ engine: 'sqlite', file }, { readOnly: true });
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); });
  const catalog = await scanSourceCatalog(adapter);
  const results = Object.fromEntries(await Promise.all(catalog.map(async entry => [entry.name, await detectTableFreshness(adapter, entry, { now })])));
  assert.equal(results.empty_table.status, 'EMPTY');
  assert.equal(results.dated.status, 'OK');
  assert.equal(results.dated.timeColumn, 'created_at');
  assert.equal(results.unknown.status, 'NO_TIME_COLUMN');
  assert.equal(results.null_dates.status, 'NO_TIME_VALUE');
  const reopen = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(reopen.prepare('SELECT created_at FROM dated LIMIT 1').get().created_at, '2026-06-01');
  reopen.close();
});
