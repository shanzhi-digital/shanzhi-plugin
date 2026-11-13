import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHostBridge } from './host-bridge.js';
import { KEY, SQL_TOOL, readTrustContext } from './trust.js';

const sql = (overrides = {}) => ({ queryKind: 'SEMANTIC_SQL', datasourceId: 'ds-1',
  columns: [{ name: 'amount' }], data: [[889900]], semanticCommit: 'commit-7',
  usedMeasures: [{ datasourceId: 'ds-1', model: 'sales', member: 'amount', queryMember: 'sales.amount',
    title: '销售额', trusted: true, trustHash: 'hash-a', source: 'semantic-model', semanticCommit: 'commit-7' }],
  ...overrides });
const exec = (overrides = {}) => ({ name: SQL_TOOL, callId: 'actual-sql-call', ...overrides });
const result = (overrides = {}) => ({ isError: false, value: { structuredContent: sql() },
  content: [{ type: 'text', text: 'original model-facing content' }], ...overrides });
function setup() {
  let listener;
  const dispose = () => {};
  const created = [];
  const registration = registerHostBridge({ on(event, callback) {
    assert.equal(event, 'tools/post-execute'); listener = callback; return dispose;
  } }, input => {
    created.push(input);
    return Object.freeze({ ...input, role: 'user', id: `notice-${created.length}` });
  });
  return { invoke: (...args) => listener(...args), created, registration, dispose };
}

test('registers the public hook and returns its disposer', () => {
  const host = setup();
  assert.equal(host.registration, host.dispose);
});

test('preserves downstream decision, contexts, and original tool value/content', async () => {
  const host = setup();
  const input = result({ additionalContexts: [{ id: 'tool-owned' }] });
  const snapshot = structuredClone(input);
  const downstreamContext = { id: 'downstream-context' };
  const replacementContent = [{ type: 'text', text: 'downstream content' }];
  const decision = Object.freeze({ kind: 'accept', content: replacementContent,
    additionalContexts: Object.freeze([downstreamContext]), custom: 'preserved' });
  let downstreamCalls = 0;
  const actual = await host.invoke(exec(), input, async () => { downstreamCalls++; return decision; });
  assert.equal(downstreamCalls, 1);
  assert.equal(actual.kind, 'accept');
  assert.equal(actual.custom, 'preserved');
  assert.equal(actual.content, replacementContent);
  assert.equal('value' in actual, false);
  assert.equal(actual.additionalContexts[0], downstreamContext);
  assert.equal(actual.additionalContexts.length, 2);
  assert.deepEqual(input, snapshot);
  assert.equal(input.additionalContexts.length, 1);
  assert.equal(decision.additionalContexts.length, 1);
  const message = actual.additionalContexts[1];
  assert.equal(message.source.kind, KEY);
  assert.equal(message.source.form, 'notice');
  const metadata = readTrustContext(message);
  assert.equal(metadata.callId, 'actual-sql-call');
  assert.equal(metadata.usedMeasures[0].trusted, true);
  assert.equal(JSON.stringify(message).includes('889900'), false);
});

test('waits for downstream, and block keeps its feedback and context exactly', async () => {
  const host = setup();
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }],
    additionalContexts: [{ id: 'block-context' }] };
  const actual = await host.invoke(exec(), result(), async () => {
    assert.equal(host.created.length, 0);
    await Promise.resolve();
    return blocked;
  });
  assert.equal(actual, blocked);
  assert.equal(host.created.length, 0);
});

test('failed SQL, MCP errors, and unrelated tool names get no summary', async () => {
  const host = setup();
  const accepted = { kind: 'accept', additionalContexts: [{ id: 'preserved' }] };
  for (const [execution, output] of [[exec(), result({ isError: true })],
    [exec(), result({ error: { message: 'failure' } })],
    [exec(), result({ value: { isError: true, structuredContent: sql() } })],
    [exec(), result({ value: { structuredContent: sql({ success: false }) } })],
    [exec({ name: `${SQL_TOOL}_other` }), result()], [exec({ callId: '' }), result()]]) {
    assert.equal(await host.invoke(execution, output, async () => accepted), accepted);
  }
  assert.equal(host.created.length, 0);
});

test('spilling only model-facing content leaves full MCP value available for metadata', async () => {
  const host = setup();
  const input = result({ content: [{ type: 'text', text: 'Result spilled to session://tool/1' }] });
  const actual = await host.invoke(exec(), input, async () => ({ kind: 'accept' }));
  assert.equal(actual.additionalContexts.length, 1);
  assert.equal(readTrustContext(actual.additionalContexts[0]).semanticCommit, 'commit-7');
  assert.equal('content' in actual, false);
  assert.equal('value' in actual, false);
  assert.equal(input.content[0].text, 'Result spilled to session://tool/1');
});

test('text MCP JSON and successful empty metadata produce compact notices', async () => {
  const host = setup();
  const actual = await host.invoke(exec(), result({ value: {
    content: [{ type: 'text', text: JSON.stringify(sql({ usedMeasures: [] })) }],
  } }), async () => ({ kind: 'accept' }));
  const metadata = readTrustContext(actual.additionalContexts[0]);
  assert.equal(metadata.unstructuredData, true);
  assert.deepEqual(metadata.usedMeasures, []);
});

test('downstream accepted replacement value supplies the final metadata without changing it', async () => {
  const host = setup();
  const replacement = { structuredContent: sql({ semanticCommit: 'replacement-commit' }) };
  const decision = { kind: 'accept', value: replacement };
  const actual = await host.invoke(exec(), result(), async () => decision);
  assert.equal(actual.value, replacement);
  assert.equal(readTrustContext(actual.additionalContexts[0]).semanticCommit, 'replacement-commit');
});

test('nested execution keeps the SQL call identity for explicit deferContext forwarding', async () => {
  const host = setup();
  const actual = await host.invoke(exec({ callId: 'nested-sql', rootCallId: 'chart-root',
    parent: { callId: 'chart-root' } }), result(), async () => ({ kind: 'accept' }));
  assert.equal(readTrustContext(actual.additionalContexts[0]).callId, 'nested-sql');
});
