import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { KEY, SQL_TOOL, readSqlTrust } from './trust.js';
import { collectorDefinition, definition, projectEvents, registerTrustProjection } from './event-projection.js';

const measure = (trusted = true, member = 'amount') => ({ datasourceId: 'ds', model: 'orders', member, trustHash: member, trusted });
const payload = (usedMeasures = [measure()]) => ({ queryKind: 'SEMANTIC_SQL', datasourceId: 'ds', semanticCommit: 'commit', columns: [], data: [], usedMeasures });
const start = (turn = 1, seq = 1) => ({ type: 'turn/start', seq, data: { turn } });
const end = (turn = 1, seq = 9, kind = 'completed') => ({ type: 'turn/end', seq, data: { turn, reason: { kind } } });
const call = (callId = 'c1', seq = 2, turn = 1, name = SQL_TOOL) => ({ type: 'tool/call', seq, data: { turn, callId, name } });
const result = (callId = 'c1', seq = 3, turn = 1, value = payload()) => ({ type: 'tool/result', seq, surfaceOp: 'append',
  data: { turn, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
const notice = (callId = 'c1', usedMeasures = [measure()]) => ({ role: 'user', id: `summary-${callId}`,
  source: { kind: KEY, form: 'notice' }, content: [{ type: 'text', text: JSON.stringify(readSqlTrust(payload(usedMeasures), callId)) }] });
const inbox = (message = notice(), seq = 4) => ({ type: 'agent/inbox/spliced', seq, data: { inserted: [message] } });
const user = (message = notice(), seq = 5) => { const { role, ...data } = message; return { type: 'user/message', seq, data }; };
const replace = (startSeq, endSeq, seq = 8, turn = 1) => ({ type: 'system/message', seq,
  surfaceOp: { op: 'replace', startSeq, endSeq }, data: { turn } });
const one = events => projectEvents([start(), ...events, end()]).get(1);
const located = (event, turn = 1) => ({ event, location: { kind: 'step', turn: { turn }, step: { step: 1 } } });

// Follow the host's exact Definition call signatures and dependency replay semantics.
function assemble(events) {
  let collector;
  const endings = [];
  let currentTurn;
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'step/start') currentTurn = event.data.turn;
    if (Number.isSafeInteger(event.data?.turn)) currentTurn = event.data.turn;
    const turn = event.data?.turn === null ? undefined : event.data?.turn ?? currentTurn;
    const match = located(event, turn);
    if (collectorDefinition.match(event)) collector = collector === undefined ? collectorDefinition.start({}, match) :
      collectorDefinition.update({ state: collector }, match);
    if (definition.match(event)) endings.push(match);
    if (event.type === 'turn/end' && event.data.turn === currentTurn) currentTurn = undefined;
  }
  return new Map(endings.map(match => {
    const state = definition.start({}, match, { previous: kind => {
      assert.equal(kind, collectorDefinition.kind);
      return { state: collector };
    } });
    return [state.turn, definition.buildLocationData({ state }, 'turn').value];
  }));
}

test('通过两个公开 Definition 注册；每个结束回合只发布自己的 turn 数据', () => {
  const registered = [];
  const disposed = [];
  const dispose = registerTrustProjection({ uiConversation: { events: { register(value) {
    registered.push(value); return () => disposed.push(value.kind);
  } } } });
  assert.deepEqual(registered, [collectorDefinition, definition]);
  assert.equal(definition.kind, KEY);
  assert.equal(definition.match(start()), null);
  assert.equal(definition.match({ type: 'turn/end', data: {} }), null);
  assert.deepEqual(definition.match(end(2)), { id: '2', role: 'start' });
  assert.equal(collectorDefinition.match({ type: 'assistant/message', data: {} }), null);
  assert.deepEqual(collectorDefinition.match(inbox()), { id: 'session', role: 'start' });
  const collector = collectorDefinition.start({}, located(inbox(), 2));
  const state = definition.start({}, located(end(2), 2), { previous: () => ({ state: collector }) });
  const published = definition.buildLocationData({ state }, 'turn');
  assert.equal(published.turn, 2);
  assert.equal(published.key, KEY);
  assert.equal(published.value.level, 'TRUSTED');
  assert.equal(definition.buildLocationData({ state }, 'step'), null);
  assert.equal(definition.buildLocationData({ state }, 'turn', published), published);
  dispose();
  assert.deepEqual(disposed, [KEY, collectorDefinition.kind]);
});

test('旧历史原始 SQL JSON 成功回放；并发调用按 callId 配对聚合', () => {
  assert.equal(one([call(), result()]).level, 'TRUSTED');
  const mixed = one([call(), call('c2', 3), result('c2', 4, 1, payload([measure(false, 'count')])), result('c1', 5)]);
  assert.equal(mixed.level, 'PARTIAL');
  assert.equal(mixed.trustedCount, 1);
  assert.equal(mixed.untrustedCount, 1);
  assert.equal(one([call(), result('c1', 3, 1, payload([measure(false)]))]).level, 'NOT_TRUSTED');
});

test('只有 completed 结束可见，未结束及错误、中断、超限结束均隐藏', () => {
  const events = [start(), call(), result()];
  assert.equal(projectEvents(events).size, 0);
  for (const reason of ['error', 'aborted', 'interrupted', 'max-tokens']) {
    assert.equal(projectEvents([...events, end(1, 9, reason)]).get(1), null);
    assert.equal(assemble([...events, end(1, 9, reason)]).get(1), null);
  }
  assert.equal(projectEvents([...events, { type: 'turn/end', seq: 9, data: { turn: 1 } }]).get(1), null);
});

test('metadata列举、其他工具、失败或损坏响应、无调用结果均不显示', () => {
  assert.equal(one([]), null);
  assert.equal(one([call('c1', 2, 1, 'mcp__datahub-ask-data__list_datasources'), result()]), null);
  assert.equal(one([call(), result('c1', 3, 1, { queryKind: 'METADATA', columns: [], data: [], usedMeasures: [measure()] })]), null);
  assert.equal(one([result()]), null);
  assert.equal(one([call(), result('c1', 3, 1, { isError: true, content: [{ type: 'text', text: JSON.stringify(payload()) }] })]), null);
  const broken = result();
  broken.data.message.content[0].text = '{"queryKind":"SEMANTIC_SQL",... Full result stored at X';
  assert.equal(one([call(), broken]), null);
  const failed = result();
  failed.data.error = '工具失败';
  assert.equal(one([call(), failed]), null);
});

test('无 measure 查询计为 NOT_TRUSTED；可信查询混合空 measure 为 PARTIAL', () => {
  const empty = one([call(), result('c1', 3, 1, payload([]))]);
  assert.equal(empty.level, 'NOT_TRUSTED');
  assert.equal(empty.unstructuredData, true);
  assert.equal(one([call(), result(), call('c2', 4), result('c2', 5, 1, payload([]))]).level, 'PARTIAL');
});

test('无 turn inbox 依赖真实 Match.location；截短工具结果由无损摘要恢复', () => {
  const truncated = result();
  truncated.data.message.content[0].text = '结果已写入文件';
  const events = [start(), call(), truncated, inbox(), end()];
  assert.equal(projectEvents(events).get(1).level, 'TRUSTED');
  assert.deepEqual(assemble(events), projectEvents(events));
  const direct = [start(), user(), end()];
  assert.equal(assemble(direct).get(1).level, 'TRUSTED');
  const noLocation = collectorDefinition.start({}, { event: inbox(), location: { kind: 'session' } });
  assert.equal(noLocation.summaries.size, 0);
});

test('摘要与raw同call去重优先摘要；inbox后延迟user/message不计到下一回合', () => {
  const events = [start(), call(), result('c1', 3, 1, payload([measure(false)])), inbox(), user(), end(),
    start(2, 10), user(notice(), 11), end(2, 12)];
  for (const values of [projectEvents(events), assemble(events)]) {
    assert.equal(values.get(1).level, 'TRUSTED');
    assert.equal(values.get(1).usedMeasures.length, 1);
    assert.equal(values.get(2), null);
  }
});

test('回合隔离，其他回合不借用前回合结果；toolCallId和structuredContent可回放', () => {
  const structured = result('c2', 13, 2);
  delete structured.data.message.source;
  structured.data.message.toolCallId = 'c2';
  structured.data.message.content = [];
  structured.data.message.structuredContent = payload([measure(false)]);
  const events = [start(), call(), result(), end(), start(2, 10), call('c2', 11, 2), structured, end(2, 15), start(3, 20), end(3, 22)];
  assert.equal(assemble(events).get(1).level, 'TRUSTED');
  assert.equal(assemble(events).get(2).level, 'NOT_TRUSTED');
  assert.equal(assemble(events).get(3), null);
  assert.deepEqual(assemble(events), projectEvents(events));
  assert.equal(one([call(), result('c1', 3, 2)]), null);
});

test('replacement覆盖原call/result/摘要使整call失效，晚到摘要和结果不能复活', () => {
  for (const seq of [2, 3, 4]) {
    const events = [start(), call(), result(), inbox(), replace(seq, seq, 6), inbox(notice(), 7), result('c1', 8), end()];
    assert.equal(projectEvents(events).get(1), null);
    assert.equal(assemble(events).get(1), null);
  }
  const replacedResult = result();
  replacedResult.surfaceOp = { op: 'replace', startSeq: 100, endSeq: 100 };
  assert.equal(one([call(), replacedResult]), null);
});

test('跨回合replacement更新原已结束回合，保留其他call和本回合数据', () => {
  const events = [start(), call(), result(), inbox(), end(), start(2, 10), call('c2', 11, 2),
    result('c2', 12, 2, payload([measure(false, 'count')])), replace(2, 3, 13, 2), end(2, 15)];
  for (const values of [projectEvents(events), assemble(events)]) {
    assert.equal(values.get(1), null);
    assert.equal(values.get(2).level, 'NOT_TRUSTED');
  }
});

test('替换端点再次被替换按原位置解释，不能恢复已撤销摘要', () => {
  const events = [start(), call(), result(), inbox(), replace(7, 7, 5), replace(3, 5, 6), end()];
  assert.equal(projectEvents(events).get(1), null);
  assert.equal(assemble(events).get(1), null);
});

function loadHostAssembler(archive) {
  const fd = openSync(archive, 'r');
  let source;
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const bytes = Buffer.alloc(header.readUInt32LE(12));
    readSync(fd, bytes, 0, bytes.length, 16);
    let entry = JSON.parse(bytes.toString());
    for (const name of 'dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'.split('/')) entry = entry.files[name];
    const content = Buffer.alloc(entry.size);
    readSync(fd, content, 0, content.length, 8 + header.readUInt32LE(4) + Number(entry.offset));
    source = content.toString();
  } finally { closeSync(fd); }
  const contractStart = source.indexOf('//#region lib/types/client/contract/conversation.js');
  const contractEnd = source.indexOf('//#endregion', contractStart);
  const locationStart = source.indexOf('//#region lib/types/client/conversation/location-index.js');
  const assemblerEnd = source.indexOf('//#region lib/types/client/conversation/definition-registry.js');
  assert.ok(contractStart >= 0 && locationStart >= 0 && assemblerEnd > locationStart);
  return runInNewContext(`${source.slice(contractStart, contractEnd)}\n${source.slice(locationStart, assemblerEnd)}\nConversationNodeAssembler;`, {
    _deepseek_ai_dsh_client_store: { notifySubscribers: listeners => { for (const listener of listeners) listener(); } },
  });
}

const archive = process.env.DSH_APP_ASAR ?? 'D:/soft/deepseek/resources/app.asar';
test('嵌套SQL摘要随datahub_chart父调用/结果替换失效，父结果不作为独立查询', {
  skip: !existsSync(archive) && '本机未安装宿主；设置 DSH_APP_ASAR 运行宿主集成测试',
}, () => {
  const Assembler = loadHostAssembler(archive);
  const nested = notice('nested-sql');
  nested.source.parentCallId = 'chart';
  const first = [start(), call('chart', 2, 1, 'datahub_chart'), result('chart', 3, 1), inbox(nested, 4),
    call('independent', 5), result('independent', 6, 1, payload([measure(false, 'count')])), end()];
  assert.equal(one([call('chart', 2, 1, 'datahub_chart'), result('chart', 3, 1)]), null);
  for (const target of [2, 3]) {
    const engine = new Assembler({ entries: () => [collectorDefinition, definition], fallbackEntry: () => undefined }, { entries: () => [] });
    const read = () => engine.locationIndex.snapshot().turns.get(1).data.get(KEY);
    engine.replaceWindow(first.map(event => ({ type: 'durable', event })), false);
    engine.flush();
    assert.equal(read().level, 'PARTIAL');
    assert.equal(read().usedMeasures.length, 2);
    const next = [start(2, 10), replace(target, target, 11, 2), inbox(nested, 12), end(2, 15)];
    for (const event of next) { engine.append({ type: 'durable', event }); engine.flush(); }
    assert.equal(read().level, 'NOT_TRUSTED');
    assert.equal(read().usedMeasures.length, 1);
    assert.equal(read().usedMeasures[0].member, 'count');
    assert.equal(engine.locationIndex.snapshot().turns.get(2).data.get(KEY), null);
    const replayed = projectEvents([...first, ...next]);
    assert.equal(replayed.get(1).level, 'NOT_TRUSTED');
    assert.equal(replayed.get(1).usedMeasures.length, 1);
    assert.equal(replayed.get(2), null);
  }
});

test('真实宿主 assembler：追加、全量重放、prepend与依赖更新均准确发布已结束回合', {
  skip: !existsSync(archive) && '本机未安装宿主；设置 DSH_APP_ASAR 运行宿主集成测试',
}, () => {
  const Assembler = loadHostAssembler(archive);
  const create = () => new Assembler({ entries: () => [collectorDefinition, definition], fallbackEntry: () => undefined }, { entries: () => [] });
  const read = (engine, turn) => engine.locationIndex.snapshot().turns.get(turn)?.data.get(KEY);
  const entries = events => events.map(event => ({ type: 'durable', event }));
  const first = [start(), call(), result(), inbox(), end()];
  const next = [start(2, 10), user(notice(), 11), call('c2', 12, 2), result('c2', 13, 2, payload([measure(false, 'count')])), end(2, 14)];
  const engine = create();
  engine.replaceWindow([], false);
  for (const entry of entries(first)) { engine.append(entry); engine.flush(); }
  assert.equal(read(engine, 1).level, 'TRUSTED');
  for (const entry of entries(next)) { engine.append(entry); engine.flush(); }
  assert.equal(read(engine, 1).level, 'TRUSTED');
  assert.equal(read(engine, 2).level, 'NOT_TRUSTED');
  assert.equal(read(engine, 2).usedMeasures.length, 1);
  const replacement = replace(2, 3, 15, 2);
  engine.append(entries([replacement])[0]);
  engine.flush();
  assert.equal(read(engine, 1), null);
  assert.equal(read(engine, 2).level, 'NOT_TRUSTED');
  const full = create();
  full.replaceWindow(entries([...first, ...next, replacement]), false);
  full.flush();
  assert.equal(read(full, 1), null);
  assert.equal(read(full, 2).level, 'NOT_TRUSTED');
  const paged = create();
  paged.replaceWindow(entries([...next, replacement]), true);
  paged.flush();
  paged.prepend(entries(first), false);
  paged.flush();
  assert.equal(read(paged, 1), null);
  assert.equal(read(paged, 2).level, 'NOT_TRUSTED');
});
