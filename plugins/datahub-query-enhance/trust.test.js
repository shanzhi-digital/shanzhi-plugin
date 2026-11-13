import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, SQL_TOOL, readSqlTrust, aggregateTrust, readTrustContext } from './trust.js';

const measure = (overrides = {}) => ({ datasourceId: 7, model: 'sales', member: 'amount',
  queryMember: 'sales.amount', title: '销售额', trusted: true, trustHash: 'hash-a',
  source: 'semantic-model', semanticCommit: 'commit-1', ...overrides });
const payload = (overrides = {}) => ({ queryKind: 'SEMANTIC_SQL', datasourceId: 7,
  columns: ['amount'], data: [[12345]], semanticCommit: 'commit-1',
  usedMeasures: [measure()], ...overrides });
const summary = (measures, callId = 'call-1') => readSqlTrust({ structuredContent: payload({ usedMeasures: measures }) }, callId);
const notice = value => ({ role: 'user', source: { kind: KEY, form: 'notice' },
  content: [{ type: 'text', text: JSON.stringify(value) }] });

test('exports exact plugin and SQL identities', () => {
  assert.equal(KEY, 'datahub-query-enhance');
  assert.equal(SQL_TOOL, 'mcp__datahub-ask-data__execute_semantic_sql');
});

test('extracts actual root metadata from structured MCP and text JSON identically', () => {
  const result = payload();
  const expected = { version: 1, kind: 'datahub-query-trust', callId: 'real-call', datasourceId: 7,
    semanticCommit: 'commit-1', usedMeasures: [measure()], unstructuredData: false };
  assert.deepEqual(readSqlTrust({ structuredContent: result }, 'real-call'), expected);
  assert.deepEqual(readSqlTrust({ content: [{ type: 'text', text: 'prefix' },
    { type: 'text', text: JSON.stringify(result) }] }, 'real-call'), expected);
  assert.deepEqual(readSqlTrust(result, 'real-call'), expected);
});

test('summary never copies rows, columns, annotation, or unrelated measure fields', () => {
  const value = payload({ usedMeasures: [measure({ sql: 'private SQL', data: [[999]] })],
    annotation: { trusted: false } });
  const actual = readSqlTrust({ structuredContent: value }, 'call-1');
  assert.deepEqual(actual.usedMeasures, [measure()]);
  assert.equal('data' in actual, false);
  assert.equal('columns' in actual, false);
  assert.equal('annotation' in actual, false);
  assert.equal(JSON.stringify(actual).includes('12345'), false);
});

test('mixed trust is PARTIAL, all true TRUSTED, all false NOT_TRUSTED', () => {
  assert.equal(aggregateTrust([summary([measure()])]).level, 'TRUSTED');
  const mixed = aggregateTrust([summary([measure(), measure({ member: 'count', trusted: false })])]);
  assert.equal(mixed.level, 'PARTIAL');
  assert.equal(mixed.trustedCount, 1);
  assert.equal(mixed.untrustedCount, 1);
  assert.equal(aggregateTrust([summary([measure({ trusted: false })])]).level, 'NOT_TRUSTED');
  assert.equal(aggregateTrust([]), null);
});

test('empty or missing usedMeasures indicates unstructured NOT_TRUSTED even with annotations', () => {
  for (const usedMeasures of [undefined, [], null, 'invalid']) {
    const actual = readSqlTrust(payload({ usedMeasures, annotation: { trusted: true },
      usedMembers: [measure()] }), 'call-1');
    assert.equal(actual.unstructuredData, true);
    assert.deepEqual(actual.usedMeasures, []);
    assert.equal(aggregateTrust([actual]).level, 'NOT_TRUSTED');
  }
  assert.equal(aggregateTrust([summary([]), summary([measure()], 'call-2')]).level, 'PARTIAL');
});

test('only the boolean true counts as trusted; malformed measures retain unknown coverage', () => {
  for (const trusted of ['true', 1, null, undefined, false]) {
    const actual = summary([measure({ trusted })]);
    assert.equal(actual.usedMeasures[0].trusted, false);
    assert.equal(aggregateTrust([actual]).level, 'NOT_TRUSTED');
  }
  const actual = summary([null, measure()]);
  assert.equal(actual.unstructuredData, true);
  assert.equal(aggregateTrust([actual]).level, 'PARTIAL');
});

test('measure identity includes hash, datasource, model and member', () => {
  const definitions = [measure(), measure({ trustHash: 'hash-b' }), measure({ datasourceId: 8 }),
    measure({ model: 'orders' }), measure({ member: 'count' })];
  const actual = aggregateTrust([summary(definitions), summary(definitions, 'call-2')]);
  assert.equal(actual.usedMeasures.length, 5);
  assert.equal(actual.trustedCount, 5);
});

test('same-call repeats do not inflate counts and conflicting trust is conservative', () => {
  const first = summary([measure()]);
  assert.equal(aggregateTrust([first, structuredClone(first)]).trustedCount, 1);
  for (const items of [[first, summary([measure({ trusted: false })])],
    [summary([measure({ trusted: false })]), first]]) {
    const actual = aggregateTrust(items);
    assert.equal(actual.usedMeasures.length, 1);
    assert.equal(actual.trustedCount, 0);
    assert.equal(actual.untrustedCount, 1);
  }
});

test('error and non-SQL values do not create summaries', () => {
  for (const value of [null, {}, { structuredContent: { queryKind: 'OTHER', columns: [], data: [] } },
    { isError: true, structuredContent: payload() }, { error: 'failed', structuredContent: payload() },
    { structuredContent: payload({ success: false }) }, { structuredContent: payload({ error: 'bad' }) },
    { structuredContent: payload({ data: null }) }, { content: [{ type: 'text', text: '{' }] }]) {
    assert.equal(readSqlTrust(value, 'call-1'), null);
  }
  assert.equal(readSqlTrust(payload(), ''), null);
});

test('only a correctly sourced user notice with a valid JSON summary is accepted', () => {
  const actual = summary([measure()]);
  assert.deepEqual(readTrustContext(notice(actual)), actual);
  for (const message of [null, { ...notice(actual), role: 'assistant' },
    { ...notice(actual), source: { kind: 'user', form: 'notice' } },
    { ...notice(actual), source: { kind: KEY, form: 'snapshot' } },
    notice({ ...actual, version: 2 }), notice({ ...actual, callId: '' }),
    notice({ ...actual, usedMeasures: [measure({ trusted: 'true' })] }),
    { ...notice(actual), content: [{ type: 'text', text: 'invalid' }] }]) {
    assert.equal(readTrustContext(message), null);
  }
});

test('context parsing strips business payload and refuses empty-array trust claims', () => {
  const input = { ...summary([]), unstructuredData: false, data: [['private']] };
  const actual = readTrustContext(notice(input));
  assert.equal('data' in actual, false);
  assert.equal(actual.unstructuredData, true);
});
