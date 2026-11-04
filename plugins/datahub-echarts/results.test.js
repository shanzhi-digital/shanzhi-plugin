import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTable, chartFromEvents } from './results.js';
import { buildResultChart } from './core.js';
import { apply } from './index.js';

const rows = [{ region: '东区', enroll: 12 }, { region: '西区', enroll: 7 }];
const args = { sourceCallId: 'q1', title: '各区报名人数', followUps: ['东区有哪些活动？', '西区有哪些活动？', '可以按月份展示这些数据吗？'] };
function events(value = rows, overrides = {}) {
  return [{ type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '问表：各区报名人数' }] } },
    { type: 'tool/call', seq: 3, data: { callId: 'q1', name: 'mcp__postgres__query', arguments: JSON.stringify({ sql: 'select region, enroll from registrations' }) } },
    { type: 'tool/result', seq: 4, surfaceOp: 'append', data: { message: { source: { callId: 'q1' }, content: [{ type: 'text', text: JSON.stringify(value) }], ...overrides } } }];
}

test('normalizes SQL MCP, API JSON and matrices without changing raw cells', () => {
  for (const value of [rows, { rows }, { data: rows }, { columns: ['region', 'enroll'], rows: [['东区', 12], ['西区', 7]] },
    { fields: [{ name: 'region', dataTypeID: 25 }, { name: 'enroll', dataTypeID: 23 }], rows }]) {
    const normalized = normalizeTable(value);
    assert.deepEqual(normalized.data, rows);
    assert.equal(normalized.columns[1].type, 'number');
  }
  const numbers = normalizeTable([{ id: '0012', label: 'A', amount: '9007199254740992' }]);
  assert.equal(numbers.columns[0].type, 'string');
  assert.equal(numbers.data[0].amount, '9007199254740992');
});

test('source is bound to completed current-turn call, preserving SQL and making no query', () => {
  const result = chartFromEvents(args, events());
  assert.deepEqual(result.data, rows);
  assert.deepEqual(result.measures, ['enroll']);
  assert.equal(result.dimension, 'region');
  assert.equal(result.source.toolName, 'mcp__postgres__query');
  assert.equal(result.source.callId, 'q1');
  assert.match(result.source.sql, /^select/);
  assert.deepEqual(result.followUps, args.followUps);
  assert.throws(() => chartFromEvents({ ...args, sourceCallId: 'other-session' }, events()), /sourceCallId/);
  assert.throws(() => chartFromEvents(args, [...events(), { type: 'turn/end' }]), /本轮/);
  assert.throws(() => chartFromEvents(args, [...events(), { type: 'turn/start' }]), /本轮/);
  assert.throws(() => chartFromEvents(args, events().slice(0, -1)), /尚未/);
  assert.throws(() => chartFromEvents(args, events(rows, { isError: true })), /失败/);
});

test('nested API results use explicit safe JSON pointer', () => {
  const nested = { result: { columns: ['region', 'enroll'], data: [['东区', 12]] } };
  assert.deepEqual(chartFromEvents({ ...args, resultPath: '/result' }, events(nested)).data, [rows[0]]);
  assert.throws(() => chartFromEvents(args, events(nested)), /不是行列/);
  assert.throws(() => chartFromEvents({ ...args, resultPath: '/constructor' }, events(nested)), /路径/);
  assert.throws(() => chartFromEvents({ ...args, resultPath: '/missing' }, events(nested)), /路径/);
  assert.throws(() => chartFromEvents({ ...args, resultPath: '/result' }, events({ error: 'denied', result: { rows } })), /失败/);
});

test('rejects duplicate, replaced, ambiguous or failed tool results', () => {
  const duplicate = events(); duplicate.push({ ...duplicate.at(-1), seq: 5 });
  assert.throws(() => chartFromEvents(args, duplicate), /不唯一/);
  const replaced = events(); replaced.at(-1).surfaceOp = 'replace';
  assert.throws(() => chartFromEvents(args, replaced), /尚未/);
  const ambiguous = events(); ambiguous.at(-1).data.message.content.push({ type: 'text', text: JSON.stringify([{ region: '北区', enroll: 1 }]) });
  assert.throws(() => chartFromEvents(args, ambiguous), /唯一/);
  for (const error of [{ isError: true, rows }, { success: false, rows }, { status: 'error', rows }, { error: 'denied', rows }]) {
    assert.throws(() => chartFromEvents(args, events(error)), /失败/);
  }
  const wrapper = events(); wrapper.at(-1).data.message.structuredContent = { rows };
  assert.throws(() => chartFromEvents(args, wrapper), /唯一/);
  wrapper.at(-1).data.message.structuredContent = rows;
  assert.deepEqual(chartFromEvents(args, wrapper).data, rows);
});

test('preserves empty/text/scalar results as tables and total metadata', () => {
  const empty = chartFromEvents(args, events({ columns: ['region', 'enroll'], rows: [] }));
  assert.equal(empty.data.length, 0); assert.match(empty.reason, /没有返回/);
  for (const value of [[{ name: 'A' }], [{ count: 4 }]]) {
    const chart = chartFromEvents(args, events(value)); assert.deepEqual(chart.measures, []); assert.ok(chart.reason);
  }
  const paged = chartFromEvents(args, events({ rows, total: 200, offset: 100, limit: 2 }));
  assert.equal(paged.rowCount, 200); assert.equal(paged.offset, 100); assert.equal(paged.truncated, true);
});

test('rejects malformed, oversized and nested tables', () => {
  for (const value of [{ rows: [[1, 2]] }, { columns: ['a', 'a'], rows: [[1, 2]] }, { columns: ['a'], rows: [[1, 2]] },
    { rows: [{ a: { nested: 1 } }] }, { rows: Array.from({ length: 1001 }, () => ({ a: 1 })) }, { columns: [], rows: [] }]) {
    assert.throws(() => normalizeTable(value));
  }
});

test('does not use numeric or identifier columns as category; pie negatives/all zeros fall back', () => {
  const identifiers = normalizeTable([{ id: '001', enroll: 2 }]);
  assert.equal(buildResultChart({}, identifiers).dimension, null);
  const camelCase = normalizeTable([{ userId: 'a2ff-91b3', region: '东区', enroll: 12 }]);
  assert.equal(buildResultChart({}, camelCase).dimension, 'region');
  assert.throws(() => chartFromEvents({ ...args, dimension: 'userId' }, events(camelCase.data)), /dimension/);
  assert.equal(buildResultChart({}, normalizeTable([{ grid: '东区', paid: 12 }])).dimension, 'grid');
  const typed = { columns: [{ name: 'code', type: 'number' }, { name: 'amount', type: 'number' }], data: [{ code: 1, amount: 2 }] };
  assert.equal(buildResultChart({ dimension: 'code', measures: ['amount'] }, typed).dimension, null);
  for (const amount of [-1, 0]) {
    const chart = buildResultChart({ chartType: 'pie' }, normalizeTable([{ region: 'A', amount }]));
    assert.equal(chart.defaultView, 'table'); assert.match(chart.reason, /负数或全部为零/);
    assert.deepEqual(chart.measures, ['amount']); assert.equal(chart.dimension, 'region');
  }
});

test('model-visible OpenAI call ID resolves to the unique internal combined ID', () => {
  const combined = events();
  combined[2].data.callId = 'call_123|fc_456';
  combined[3].data.message.source.callId = 'call_123|fc_456';
  assert.equal(chartFromEvents({ ...args, sourceCallId: 'call_123' }, combined).source.callId, 'call_123|fc_456');
});

test('automatic source selection is unique; ambiguity returns real candidate IDs', () => {
  const auto = { ...args }; delete auto.sourceCallId;
  assert.equal(chartFromEvents(auto, events()).source.callId, 'q1');
  const second = events().slice(2).map(event => ({ ...event, seq: event.seq + 4,
    data: event.type === 'tool/call' ? { ...event.data, callId: 'q2' } : { message: { ...event.data.message, source: { callId: 'q2' } } } }));
  assert.throws(() => chartFromEvents(auto, [...events(), ...second]), /q1.*q2/);
  assert.throws(() => chartFromEvents(auto, events().slice(0, 2)), /没有唯一/);
});

test('explicit bad selections, multiple row arrays and duplicate follow-ups fail closed', () => {
  for (const selection of [{ dimension: 'missing' }, { dimension: 'enroll' }, { measures: ['missing'] },
    { measures: ['enroll', 'missing'] }, { measures: ['region'] }, { followUps: Array(3).fill('可以再详细说明吗？') }]) {
    assert.throws(() => chartFromEvents({ ...args, ...selection }, events()));
  }
  const ambiguous = { data: rows, rows: [{ region: '北区', enroll: 99 }] };
  assert.throws(() => chartFromEvents(args, events(ambiguous)), /多个行数组/);
  assert.deepEqual(chartFromEvents({ ...args, resultPath: '/rows' }, events(ambiguous)).data, ambiguous.rows);
});

test('replaced tool or user surface cannot be used to render stale data', () => {
  const replaced = events();
  replaced.push({ type: 'tool/result', seq: 5, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
    data: { message: { source: { callId: 'q1' }, isError: true, content: [] } } });
  assert.throws(() => chartFromEvents(args, replaced), /尚未/);
  const userReplaced = events();
  userReplaced.push({ type: 'user/message', seq: 6, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    data: { content: [{ type: 'text', text: '不要图表' }] } });
  assert.throws(() => chartFromEvents(args, userReplaced), /本轮/);
});

test('generic DataHub adapter preserves semantic SQL and datasource binding', () => {
  const value = { queryKind: 'SEMANTIC_SQL', datasourceId: 'A', semanticSql: 'SELECT region, enroll FROM public_view',
    columns: [{ name: 'region', type: 'String' }, { name: 'enroll', type: 'Int64' }], data: rows };
  const semanticEvents = events(value);
  semanticEvents[2].data.name = 'mcp__datahub-ask-data__execute_semantic_sql';
  semanticEvents[2].data.arguments = JSON.stringify({ datasourceId: 'A', sql: value.semanticSql });
  assert.deepEqual(chartFromEvents(args, semanticEvents).data, rows);
  for (const mismatch of [{ datasourceId: 'B' }, { semanticSql: 'SELECT wrong' }, { queryKind: 'RAW_SQL' }]) {
    semanticEvents[3].data.message.content[0].text = JSON.stringify({ ...value, ...mismatch });
    assert.throws(() => chartFromEvents(args, semanticEvents));
  }
});

test('generic tool executes using session events with zero tools.execute calls', async () => {
  const registered = new Map(); let queryCount = 0;
  const ctx = { systemPrompt: { section() {} }, tools: { register(tool) { registered.set(tool.name, tool); }, execute() { queryCount++; throw new Error('must not query'); } },
    sessions: { get(id) { assert.equal(id, 'session'); return { snapshotEvents: () => events() }; } } };
  apply(ctx);
  assert.ok(registered.has('datahub_chart'));
  const result = await registered.get('query_result_chart').execute(args, { agent: { id: 'session' } });
  assert.deepEqual(result.data, rows); assert.equal(queryCount, 0);
});
