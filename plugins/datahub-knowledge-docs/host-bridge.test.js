import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHostBridge, readKnowledgeOrigin, presentKnowledgeDocuments } from './host-bridge.js';
import { RETRIEVE_TOOL, RECORD_TYPE } from './results.js';

const document = (index = 1) => ({ documentRef: `doc-${index}`, knowledgeBaseId: 'kb-1', knowledgeBaseName: '制度库',
  docId: String(index), documentName: `制度${index}.md`, contentType: 'text/markdown', sourceAvailable: true,
  openStatus: 'available', openPath: '/preview?ticket=fake#name=test', openUrlExpiresAt: '2099-01-01T00:00:00Z' });
const evidence = (index = 1, part = 1) => ({ evidenceId: `ev-${index}-${part}`, documentRef: `doc-${index}`,
  chunkId: `chunk-${index}-${part}`, text: '证据内容'.repeat(100) });
const payload = (overrides = {}) => ({ schemaVersion: 2, purpose: 'knowledge', query: '制度要求', retrievalId: 'r1',
  documents: [document()], evidence: [evidence()], ...overrides });
const start = (turn = 1, seq = 1) => ({ type: 'turn/start', seq, data: { turn } });
const call = (callId = 'c1', seq = 2, turn = 1, name = RETRIEVE_TOOL) => ({ type: 'tool/call', seq,
  surfaceOp: 'append', data: { callId, turn, name } });
const result = (value = payload(), callId = 'c1', seq = 3, turn = 1) => ({ type: 'tool/result', seq, surfaceOp: 'append',
  data: { turn, message: { source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } });
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const entry = (config = {}, overrides = {}) => ({ options: { name: '@deepseek-ai/dsh-mcp-client' },
  fiber: { state: 2, effectiveConfig: { serverName: 'datahub-knowledge', transport: 'streamable-http',
    url: 'https://user:secret@knowledge.example/mcp?credential=secret#private', ...config } }, ...overrides });
const context = (entries = [entry()]) => ({ get(name) { assert.equal(name, 'loader'); return { entries: () => entries.values() }; } });

function bridgeFixture(events = [start(), call()], entries = [entry()]) {
  const session = { snapshotEvents: () => events };
  const appended = [];
  let callback;
  const ctx = { ...context(entries), sessions: { get: id => id === 'session' ? session : undefined },
    on(name, fn) { assert.equal(name, 'tools/result'); callback = fn; return () => {}; } };
  const append = (target, type, data) => {
    assert.equal(target, session);
    const seq = 50 + appended.length;
    appended.push({ type, seq, data, ignorable: true });
    return seq;
  };
  registerHostBridge(ctx, append);
  return { events, appended, session, callback, exec: Object.freeze({ name: RETRIEVE_TOOL, callId: 'c1', agent: { id: 'session' } }) };
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

test('同步捕获 spill 后完整 value，保留必要字段且不修改冻结结果', () => {
  const fixture = bridgeFixture();
  const original = payload({ segments: [{ duplicate: true }], rerank: [{ duplicate: true }],
    documents: [{ ...document(), openUrl: 'https://untrusted.example', secret: 'discard' }],
    evidence: [{ ...evidence(), text: '超长结果'.repeat(70000), score: 0.8 }] });
  const value = deepFreeze({ content: [{ type: 'text', text: '{"schemaVersion":2,' }],
    value: { structuredContent: original, ...mcp(payload({ retrievalId: 'ignored' })) }, isError: false });
  const returned = fixture.callback(fixture.exec, value);
  assert.equal(returned, undefined);
  assert.equal(fixture.appended.length, 1);
  const saved = fixture.appended[0];
  assert.equal(saved.type, RECORD_TYPE);
  assert.equal(saved.data.version, 1);
  assert.equal(saved.data.turn, 1);
  assert.equal(saved.data.callId, 'c1');
  assert.equal(saved.data.callSeq, 2);
  assert.equal(saved.data.status, 'success');
  assert.equal(saved.data.payload.evidence[0].text.length, original.evidence[0].text.length);
  assert.deepEqual(Object.keys(saved.data.payload), ['schemaVersion', 'purpose', 'query', 'retrievalId', 'documents', 'evidence']);
  assert.equal(saved.data.payload.documents[0].sourceOrigin, 'https://knowledge.example');
  assert.equal(saved.data.payload.documents[0].linkProtocol, 'path');
  assert.equal(saved.data.payload.documents[0].openPath, document().openPath);
  for (const key of ['openUrl', 'secret']) assert.equal(Object.hasOwn(saved.data.payload.documents[0], key), false);
  assert.equal(Object.hasOwn(saved.data.payload.evidence[0], 'score'), false);
  assert.doesNotMatch(JSON.stringify(saved), /credential|user:secret|private|untrusted/);
});

test('没有 structuredContent 时读取完整 MCP 文本；宿主失败优先于成功数据', () => {
  for (const failure of [undefined, { isError: true }, { error: 'host failed' }]) {
    const fixture = bridgeFixture();
    fixture.callback(fixture.exec, { value: mcp(payload()), content: [{ type: 'text', text: 'spilled' }], ...failure });
    assert.equal(fixture.appended[0].data.status, failure ? 'error' : 'success');
  }
  const malformed = bridgeFixture();
  malformed.callback(malformed.exec, { value: { ...mcp(payload()), structuredContent: null } });
  assert.equal(malformed.appended[0].data.status, 'invalid');
});

test('仅精确工具且有未替换普通 tool/call 时持久化，同步重复通知和回放去重', () => {
  const fixture = bridgeFixture();
  for (const exec of [{ ...fixture.exec, name: 'retrieve_knowledge' }, { ...fixture.exec, callId: 'missing' },
    { ...fixture.exec, agent: { id: 'absent' } }, { ...fixture.exec, agent: undefined }]) fixture.callback(exec, { value: mcp(payload()) });
  assert.equal(fixture.appended.length, 0);
  fixture.callback(fixture.exec, { value: mcp(payload()) });
  fixture.callback(fixture.exec, { value: mcp(payload()) });
  assert.equal(fixture.appended.length, 1);
  const restored = bridgeFixture([start(), call(), ...fixture.appended]);
  restored.callback(restored.exec, { value: mcp(payload()) });
  assert.equal(restored.appended.length, 0);
  const replaced = bridgeFixture([start(), call(), { type: 'system/message', seq: 4,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, data: { turn: 1 } }]);
  replaced.callback(replaced.exec, { value: mcp(payload()) });
  assert.equal(replaced.appended.length, 0);
});

test('MCP 仅唯一已激活的目标HTTP连接生效，不读取认证配置', () => {
  const selected = entry();
  Object.defineProperties(selected.fiber.effectiveConfig, {
    headers: { get() { throw new Error('不应读取 headers'); } }, env: { get() { throw new Error('不应读取 env'); } },
  });
  const unrelated = { options: { name: 'other-plugin' }, get fiber() { throw new Error('不应读取无关插件'); } };
  assert.equal(readKnowledgeOrigin(context([unrelated, selected])), 'https://knowledge.example');
  for (const entries of [[], [entry(), entry()], [entry({}, { disabled: true })], [entry({}, { fiber: { state: 1 } })],
    [entry({ serverName: 'other' })], [entry({ transport: 'stdio' })], [entry({ url: 'file:///private' })],
    [entry({ url: 'invalid' })]]) assert.equal(readKnowledgeOrigin(context(entries)), undefined);
  const noOrigin = bridgeFixture([start(), call()], []);
  noOrigin.callback(noOrigin.exec, { value: mcp(payload()) });
  assert.equal(Object.hasOwn(noOrigin.appended[0].data.payload.documents[0], 'sourceOrigin'), false);
});

test('候选索引每页20份，每文档最多2条80字证据，无正文和链接副本', () => {
  const many = payload({ documents: Array.from({ length: 25 }, (_, i) => document(i + 1)),
    evidence: Array.from({ length: 25 }, (_, i) => [1, 2, 3].map(part => evidence(i + 1, part))).flat() });
  const events = [start(), call(), result(many)];
  const first = presentKnowledgeDocuments({ purpose: 'knowledge' }, events);
  assert.equal(first.kind, 'knowledge-documents-candidates');
  assert.equal(first.total, 25);
  assert.equal(first.documents.length, 20);
  assert.equal(first.documents[0].evidence.length, 2);
  assert.equal(Array.from(first.documents[0].evidence[0].text).length, 80);
  assert.equal(Object.hasOwn(first.documents[0], 'openPath'), false);
  assert.equal(Object.hasOwn(first, 'sourceCallIds'), false);
  const next = presentKnowledgeDocuments({ purpose: 'documents', cursor: first.cursor }, events);
  assert.equal(next.documents.length, 5);
  assert.equal(next.documents[0].documentRef, 'doc-21');
  assert.equal(Object.hasOwn(next, 'cursor'), false);
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'knowledge', cursor: 'broken' }, events), /游标/);
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'knowledge', cursor: first.cursor },
    [start(2, 10), call('c2', 11, 2), result(many, 'c2', 12, 2)]), /游标/);
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'knowledge', cursor: first.cursor },
    [...events, call('c2', 4), result(payload({ retrievalId: 'r2' }), 'c2', 5)]), /游标/);
});

test('找指定文件提交时复用确定性核验，收敛精确命中并保留跨库同名', () => {
  const exactName = '03_老年人能力评估工作要点.md';
  const exact = { ...document(), documentName: exactName };
  const acrossBase = { ...document(2), documentName: exactName, knowledgeBaseId: 'kb-2', knowledgeBaseName: '第二库' };
  const candidates = payload({ purpose: 'documents', documents: [exact, acrossBase, document(3)], evidence: [] });
  const user = { type: 'user/message', seq: 1.5, data: { turn: 1, content: [{ type: 'text', text: `帮我找到“${exactName}”` }] } };
  const events = [start(), user, call(), result(candidates)];
  const selection = presentKnowledgeDocuments({ purpose: 'documents', documentRefs: ['doc-1', 'doc-3'] }, events);
  assert.deepEqual(selection.documentRefs, ['doc-1', 'doc-2']);
  const missingUser = { ...user, data: { ...user.data, content: [{ type: 'text', text: '找到“没有的文件.pdf”' }] } };
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'documents', documentRefs: ['doc-1'] },
    [start(), missingUser, call(), result(candidates)]), /未找到指定文件/);
});

test('最终提交真实refs/证据并拒绝不存在、跨回合、已替换来源及混用cursor', () => {
  const events = [start(), call(), result()];
  const selection = presentKnowledgeDocuments({ purpose: 'knowledge', documentRefs: ['doc-1'], evidenceIds: ['ev-1-1'] }, events);
  assert.deepEqual(selection, { kind: 'knowledge-documents-selection', purpose: 'knowledge', documentRefs: ['doc-1'],
    evidenceIds: ['ev-1-1'], sourceCallIds: ['c1'] });
  assert.equal(presentKnowledgeDocuments({ purpose: 'documents', documentRefs: [] }, events).documentRefs.length, 0);
  for (const args of [{ purpose: 'knowledge', documentRefs: ['missing'] },
    { purpose: 'knowledge', documentRefs: ['doc-1'], evidenceIds: ['missing'] },
    { purpose: 'documents', documentRefs: ['doc-1'], cursor: 'ignored' },
    { purpose: 'documents', documentRefs: ['doc-1'], evidenceIds: ['ev-1-1'] },
    { purpose: 'knowledge', evidenceIds: ['ev-1-1'] }, { purpose: 'other' }]) {
    assert.throws(() => presentKnowledgeDocuments(args, events));
  }
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'knowledge', documentRefs: ['doc-1'] },
    [...events, start(2, 10)]));
  assert.throws(() => presentKnowledgeDocuments({ purpose: 'knowledge', documentRefs: ['doc-1'] },
    [...events, { type: 'system/message', seq: 5, data: { turn: 1 }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } }]));
});
