import test from 'node:test';
import assert from 'node:assert/strict';
import { definition, KEY, projectEvents, userTextDefinition } from './event-projection.js';
import { RETRIEVE_TOOL, PRESENT_TOOL, RECORD_TYPE } from './results.js';

const payload = (overrides = {}) => ({ schemaVersion: 2, purpose: 'knowledge', retrievalId: 'r1', documents: [], evidence: [], ...overrides });
const start = (turn = 1) => ({ type: 'turn/start', seq: 1, data: { turn } });
const call = (callId = 'c1', seq = 2, turn = 1, name = RETRIEVE_TOOL) => ({ type: 'tool/call', seq, data: { turn, callId, name } });
const result = (callId = 'c1', seq = 3, turn = 1, value = payload()) => ({ type: 'tool/result', seq, surfaceOp: 'append',
  data: { turn, message: { source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
const replace = (startSeq, endSeq, seq = 10, turn = 1) => ({ type: 'system/message', seq,
  surfaceOp: { op: 'replace', startSeq, endSeq }, data: { turn } });
const begin = (turn = 1) => definition.start({}, { event: start(turn) });
const update = (state, event) => definition.update({ state }, { event });
const replay = events => events.reduce(update, begin());

test('注册精确事件并按 turn 发布，不产生跨消息 scope 数据', () => {
  assert.equal(KEY, 'datahub-knowledge-docs');
  assert.equal(definition.kind, KEY);
  assert.equal(definition.match(start(2)), null);
  assert.deepEqual(definition.match(call()), { id: '1', role: 'start' });
  for (const event of [result(), replace(2, 3)]) assert.deepEqual(definition.match(event), { id: '1', role: 'start' });
  assert.equal(definition.match({ type: 'assistant/message', data: { turn: 1 } }), null);
  assert.equal(definition.match({ type: 'tool/call', data: {} }), null);
  const state = replay([call(), result()]);
  const published = definition.buildLocationData({ state }, 'turn');
  assert.equal(published.value, state.value);
  assert.equal(published.turn, 1);
  assert.equal(published.value.turn, 1);
  assert.equal(definition.buildLocationData({ state }, 'message'), null);
  assert.equal(definition.buildLocationData({ state }, 'turn', published), published);
  const callsOnly = update(state, call('c2', 4));
  assert.equal(definition.buildLocationData({ state: callsOnly }, 'turn').value.records.length, 1);
});

test('并发按 callId 精确配对，结果晚于正文也纳入；按调用顺序输出', () => {
  const events = [call('c1', 2), call('c2', 3), result('c2', 5, 1, payload({ retrievalId: 'r2' })), result('c1', 20)];
  events[2].data.message.messageId = 'real-message-id';
  const state = replay(events);
  assert.deepEqual(state.records.map(record => record.callId), ['c1', 'c2']);
  assert.equal(state.records[0].callSeq, 2);
  assert.equal(state.records[0].resultSeq, 20);
  assert.equal(state.records[0].retrievalId, 'r1');
  assert.equal(Object.hasOwn(state.records[0], 'messageId'), false);
  assert.equal(state.records[1].messageId, 'real-message-id');
  assert.equal(definition.buildLocationData({ state }, 'turn').value.records.length, 2);
});

test('两回合独立，其他工具、缺失调用和其他回合结果不记录', () => {
  const turn1 = replay([call(), result()]);
  const turn2 = update(update(begin(2), call('c1', 10, 2)), result('c1', 11, 2, payload({ retrievalId: 'r2' })));
  assert.equal(turn1.records[0].retrievalId, 'r1');
  assert.equal(turn2.records[0].retrievalId, 'r2');
  assert.equal(turn1.value.turn, 1);
  assert.equal(turn2.value.turn, 2);
  assert.equal(update(turn1, result('c1', 12, 2)), turn1);
  assert.equal(replay([result('missing')]).records.length, 0);
  for (const name of ['retrieve_knowledge', 'mcp__other__retrieve_knowledge', 'mcp__datahub-knowledge__other']) {
    assert.equal(replay([call('other', 2, 1, name), result('other')]).records.length, 0);
  }
});

test('支持 toolCallId 关联和 runtime structuredContent', () => {
  const event = result();
  delete event.data.message.source;
  event.data.message.toolCallId = 'c1';
  event.data.message.structuredContent = payload({ retrievalId: 'structured' });
  assert.equal(replay([call(), event]).records[0].retrievalId, 'structured');
});

test('同一调用重复结果和重复回放均只记录一次', () => {
  const events = [call(), result()];
  const state = replay(events);
  assert.equal(update(state, result()), state);
  const again = events.reduce(update, state);
  assert.equal(again, state);
  assert.equal(again.records.length, 1);
  assert.deepEqual(replay(events).records, state.records);
});

test('replace 覆盖调用或结果都移除记录；保留其他调用并阻止晚到结果复活', () => {
  for (const target of [2, 4]) {
    let state = replay([call('c1', 2), call('c2', 3), result('c1', 4), result('c2', 5)]);
    state = update(state, replace(target, target));
    assert.deepEqual(state.records.map(record => record.callId), ['c2']);
    assert.equal(update(state, result('c1', 12)), state);
    assert.equal(update(state, call('c1', 2)), state);
  }
  let pending = replay([call()]);
  pending = update(pending, replace(2, 2));
  assert.equal(update(pending, result('c1', 12)).records.length, 0);
});

test('replace 先于晚到 call/result 时检查区间，不能复活；replacement 自身不视为 append', () => {
  const state = replay([replace(2, 4), call('c1', 2), result('c1', 3)]);
  assert.equal(state.records.length, 0);
  let pending = replay([call()]);
  pending = update(pending, replace(3, 3));
  pending = update(pending, result());
  assert.equal(pending.records.length, 0);
  assert.equal(update(pending, result('c1', 12)), pending);
  const replacementResult = result();
  replacementResult.surfaceOp = { op: 'replace', startSeq: 8, endSeq: 8 };
  assert.equal(replay([call(), replacementResult]).records.length, 0);
  const notAppend = result();
  notAppend.surfaceOp = 'replace';
  assert.equal(replay([call(), notAppend]).records.length, 0);
});

test('成功空结果、宿主/MCP/RPC失败、invalid和unsupported都保留明确状态', () => {
  const cases = [
    [result(), 'success'],
    [{ ...result(), data: { ...result().data, error: 'host failure' } }, 'error'],
    [{ ...result(), data: { turn: 1, message: { ...result().data.message, isError: true } } }, 'error'],
    [result('c1', 3, 1, { jsonrpc: '2.0', error: { message: 'RPC failed' } }), 'error'],
    [result('c1', 3, 1, payload({ documents: null })), 'invalid'],
    [result('c1', 3, 1, payload({ schemaVersion: 1 })), 'unsupported'],
  ];
  for (const [event, expected] of cases) {
    const records = replay([call(), event]).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, expected);
    if (expected !== 'success') assert.equal(typeof records[0].message, 'string');
  }
  const broken = result();
  broken.data.message.content[0].text = '{"schemaVersion":2,';
  assert.equal(replay([call(), broken]).records[0].status, 'invalid');
});

const doc = (ref = 'd1') => ({ documentRef: ref, docId: ref, knowledgeBaseId: 'kb', knowledgeBaseName: '库', documentName: `${ref}.md` });
const full = (overrides = {}, seq = 4) => ({ type: RECORD_TYPE, seq, data: { version: 1, turn: 1, callId: 'c1', callSeq: 2,
  status: 'success', payload: payload({ documents: [doc()] }), ...overrides } });
const spilled = () => {
  const event = result();
  event.data.message.content[0].text = '{"schemaVersion":2,\n[...]\nFull formatted result stored at D:/private/result.json';
  return event;
};
const select = (refs = ['d1'], seq = 6, extra = {}) => result('present', seq, 1,
  { kind: 'knowledge-documents-selection', purpose: 'documents', documentRefs: refs, ...extra });

test('完整记录前后到达均只在普通成功结果提交后信任，覆盖截短且不重复', () => {
  const before = replay([call(), full({}, 2.5)]);
  assert.equal(before.records.length, 0);
  for (const events of [[call(), full({}, 2.5), spilled()], [call(), spilled(), full()]]) {
    const state = replay(events);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].status, 'success');
    assert.equal(state.records[0].payload.documents[0].documentRef, 'd1');
    assert.equal(update(state, full()), state);
  }
  const failedResult = spilled();
  failedResult.data.error = '真实失败';
  assert.equal(replay([call(), full(), failedResult]).records[0].status, 'error');
  assert.equal(replay([call(), full({ callSeq: 200 }), spilled()]).records[0].status, 'truncated');
  assert.equal(replay([call(), full({ turn: 2 }), spilled()]).records[0].status, 'truncated');
  assert.equal(replay([call(), full(), result('c1', 5, 1, { isError: true, content: [{ type: 'text', text: 'MCP失败' }] })]).records[0].status, 'error');
});

test('replace让完整记录、已选来源和晚到记录永久失效；同ref其他调用不复活旧选择', () => {
  const events = [call(), result('c1', 3, 1, payload({ documents: [doc()] })), call('present', 5, 1, PRESENT_TOOL), select()];
  let state = replay(events);
  assert.equal(state.selections.length, 1);
  assert.deepEqual(state.selections[0].value.sourceCallIds, ['c1']);
  state = update(state, replace(3, 3, 7));
  assert.equal(state.records.length, 0);
  assert.equal(state.selections.length, 0);
  state = update(state, full({}, 8));
  assert.equal(state.records.length, 0);
  state = update(state, call('c2', 9));
  state = update(state, result('c2', 10, 1, payload({ documents: [doc()] })));
  assert.equal(state.selections.length, 0);
  assert.equal(replay([...events, replace(6, 6)]).selections.length, 0);
  const replacedFirst = replay([replace(2, 3), full({}, 11), call(), spilled()]);
  assert.equal(replacedFirst.records.length, 0);
});

test('最后有效选择与空选择保留，未知refs/证据/跨回合来源拒绝，索引结果不视为选择', () => {
  const events = [call(), result('c1', 3, 1, payload({ documents: [doc()] })), call('present', 5, 1, PRESENT_TOOL), select()];
  assert.equal(replay(events).selections.length, 1);
  for (const extra of [{ sourceCallIds: ['old-turn'] }, { evidenceIds: ['unknown'] }]) {
    assert.equal(replay([...events.slice(0, -1), select(['d1'], 6, extra)]).selections.length, 0);
  }
  assert.equal(replay([...events.slice(0, -1), select(['unknown'])]).selections.length, 0);
  assert.deepEqual(replay([...events.slice(0, -1), select([])]).selections[0].value.documentRefs, []);
  const index = result('present', 6, 1, { kind: 'knowledge-documents-candidates', documents: [doc()] });
  assert.equal(replay([...events.slice(0, -1), index]).selections.length, 0);
  const later = [...events, call('present2', 7, 1, PRESENT_TOOL), { ...select([], 8), data: { ...select([], 8).data, message: { ...select([], 8).data.message, source: { callId: 'present2' } } } }];
  assert.equal(replay(later).selections.at(-1).value.documentRefs.length, 0);
});

test('真实无turn用户消息和arguments字符串被读取，projectEvents只返回最后回合', () => {
  const user = (text, seq) => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }], role: 'user', id: `m-${seq}` } });
  const request = call();
  request.data.arguments = JSON.stringify({ purpose: 'documents' });
  const events = [start(), user('请找d1.md', 1.5), request, spilled()];
  const projected = projectEvents(events);
  assert.equal(projected.userText, '请找d1.md');
  assert.equal(projected.documentMode, true);
  assert.equal(projected.records[0].purpose, 'documents');
  assert.deepEqual(projectEvents([...events, start(2)]), { turn: 2, records: [], selections: [], userText: '', documentMode: false });
  assert.equal(projectEvents([...events, start(2), user('新问题', 20)]).userText, '新问题');
});

// Mirrors the installed SDK's definition.match/start/update/reader.previous ordering.
function projectDefinitions(events) {
  const contexts = new Map();
  const definitions = [userTextDefinition, definition];
  const reader = beforeSeq => ({ previous(kind) {
    const previous = [...contexts.values()].filter(context => context.kind === kind && context.startSeq < beforeSeq)
      .sort((a, b) => a.startSeq - b.startSeq).at(-1);
    return previous ? { kind, id: previous.id, startSeq: previous.startSeq, state: previous.state, matches: previous.matches } : undefined;
  } });
  for (const event of events) for (const entry of definitions) {
    const matched = entry.match(event);
    if (!matched) continue;
    const key = `${entry.kind}:${matched.id}`;
    let context = contexts.get(key);
    const match = { event, role: matched.role };
    if (!context) {
      context = { kind: entry.kind, id: matched.id, startSeq: event.seq, matches: [match] };
      contexts.set(key, context);
      if (matched.role === 'start') context.state = entry.start(context, match, reader(event.seq));
    } else {
      context.matches.push(match);
      if (context.state !== undefined) context.state = entry.update(context, match);
    }
  }
  return [...contexts.values()].filter(context => context.kind === KEY);
}

test('SDK同款投影reader读取真实正文，重复start-as-update不清空同轮记录，回合分离', () => {
  const user = { type: 'user/message', seq: 1.5, data: { content: [{ type: 'text', text: '请找d1.md' }] } };
  const events = [start(), user, call(), result('c1', 3, 1, payload({ documents: [doc()] })),
    call('c2', 4), result('c2', 5), { ...start(2), seq: 9 }, { ...user, seq: 10, data: { content: [{ type: 'text', text: '第二轮' }] } },
    call('other', 11, 2), result('other', 12, 2)];
  const contexts = projectDefinitions(events);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].state.userText, '请找d1.md');
  assert.equal(contexts[0].state.records.length, 2);
  assert.equal(contexts[1].state.userText, '第二轮');
  assert.equal(contexts[1].state.records.length, 1);
  assert.deepEqual(contexts[0].state.value, projectEvents(events.slice(0, 6)));
});
