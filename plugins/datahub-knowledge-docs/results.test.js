import test from 'node:test';
import assert from 'node:assert/strict';
import { RETRIEVE_TOOL, readKnowledgeResult, buildPanels, buildPresentation, collectDocuments, validateSelection, getDocumentOpenState } from './results.js';

const now = Date.parse('2026-01-01T00:00:00Z');
const document = (overrides = {}) => ({ documentRef: 'kb:9007199254740993123:doc:9007199254740993999',
  knowledgeBaseId: '9007199254740993123', knowledgeBaseName: '制度库', docId: '9007199254740993999',
  documentName: '同名文档.pdf', contentType: 'application/pdf', sourceAvailable: true,
  openStatus: 'available', openUrl: 'https://example.com/preview#ticket=a%2Bb&name=%E4%B8%AD',
  openUrlExpiresAt: '2026-01-01T01:00:00Z', ...overrides });
const evidence = (overrides = {}) => ({ evidenceId: 'ev-r1-1', documentRef: document().documentRef, chunkId: '9007199254740993998', text: '原始证据\n第二行', ...overrides });
const payload = (overrides = {}) => ({ schemaVersion: 2, purpose: 'knowledge', query: '制度', retrievalId: 'r1',
  knowledgeBaseIds: [document().knowledgeBaseId], documents: [document()], evidence: [evidence()], ...overrides });
const record = (value, callSeq = 1) => ({ status: 'success', callSeq, payload: value });
const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

test('精确工具名、已解包 JSON、MCP 文本和完整 RPC 均可读取，长字符串 ID 保持原样', () => {
  assert.equal(RETRIEVE_TOOL, 'mcp__datahub-knowledge__retrieve_knowledge');
  for (const input of [payload(), JSON.stringify(payload()), mcp(payload()), { jsonrpc: '2.0', id: 1, result: mcp(payload()) },
    { message: mcp(payload()) }]) {
    const parsed = readKnowledgeResult(input);
    assert.equal(parsed.status, 'success');
    assert.equal(parsed.payload.documents[0].docId, '9007199254740993999');
  }
});

test('优先 structuredContent，仅解析对应业务文本，损坏的结构化数据不回退', () => {
  const structured = payload({ retrievalId: 'structured' });
  assert.equal(readKnowledgeResult({ ...mcp(payload()), structuredContent: structured }).payload, structured);
  assert.equal(readKnowledgeResult({ ...mcp(payload()), structuredContent: null }).status, 'invalid');
  assert.equal(readKnowledgeResult({ content: [{ type: 'text', text: '说明' }, ...mcp(payload()).content] }).status, 'success');
  assert.equal(readKnowledgeResult({ content: [...mcp(payload()).content, ...mcp(payload()).content] }).status, 'invalid');
});

test('宿主、JSON-RPC 和 MCP 错误先于成功数据处理', () => {
  for (const input of [{ error: 'host failed', message: mcp(payload()) },
    { jsonrpc: '2.0', error: { code: -1, message: 'RPC failed' }, result: mcp(payload()) },
    { isError: true, structuredContent: payload(), content: [{ type: 'text', text: 'MCP failed' }] },
    { result: { isError: true, content: [{ type: 'text', text: 'nested failed' }] } }]) {
    assert.equal(readKnowledgeResult(input).status, 'error');
    assert.match(readKnowledgeResult(input).message, /failed/);
  }
});

test('合法空结果、损坏格式和旧版本严格区分，不从普通文字猜文档', () => {
  assert.equal(readKnowledgeResult(payload({ documents: [], evidence: [] })).status, 'success');
  assert.equal(readKnowledgeResult(payload({ schemaVersion: 1 })).status, 'unsupported');
  assert.equal(readKnowledgeResult({ segments: [] }).status, 'unsupported');
  assert.equal(readKnowledgeResult('找到同名文档.pdf，https://example.com').status, 'unsupported');
  for (const input of ['{"schemaVersion":2,', null, payload({ documents: {} }), payload({ purpose: 'other' }),
    payload({ retrievalId: 42 }), payload({ documents: [document({ docId: 42 })] }),
    payload({ evidence: [evidence({ documentRef: 'kb:other:doc:other' })] }),
    payload({ purpose: 'documents' }), payload({ evidence: [evidence({ text: null })] })]) {
    assert.equal(readKnowledgeResult(input).status, 'invalid');
  }
  assert.equal(readKnowledgeResult(payload({ documents: [document({ contentType: 'unknown/new-media' })] })).status, 'success');
  const opaque = payload({ documents: [document({ documentRef: 'opaque ref', openUrlExpiresAt: 'bad-date' })],
    evidence: [evidence({ documentRef: 'opaque ref' })] });
  assert.equal(readKnowledgeResult(opaque).status, 'success');
  assert.equal(getDocumentOpenState(opaque.documents[0], now).available, false);
});

test('按调用、KB和服务端顺序合并；同名不同 ref 保留，documentLimit 不跨调用截断', () => {
  const other = document({ knowledgeBaseId: 'b2', knowledgeBaseName: '第二库', docId: 'd2', documentRef: 'kb:b2:doc:d2' });
  const sameName = document({ docId: 'different', documentRef: `kb:${document().knowledgeBaseId}:doc:different` });
  const first = payload({ documents: [other, document()], evidence: [], documentLimit: 1 });
  const next = payload({ retrievalId: 'r2', documents: [sameName, other], evidence: [], documentLimit: 1 });
  const panels = buildPanels([record(next, 10), record(first, 2), { status: 'error', message: 'failure' }]);
  assert.deepEqual(panels[0].groups.map(group => group.knowledgeBaseId), ['b2', document().knowledgeBaseId]);
  assert.deepEqual(panels[0].groups[1].documents.map(item => item.docId), [document().docId, 'different']);
  assert.equal(panels[0].groups[0].documents[0].links.length, 2);
});

test('同文档跨检索优先 chunkId，否则按正文去重并保留所有证据关联；不修改输入', () => {
  const first = payload({ evidence: [evidence(), evidence({ evidenceId: 'e-text', chunkId: undefined, text: '无块正文' })] });
  const next = payload({ retrievalId: 'r2', evidence: [evidence({ evidenceId: 'e2', text: '同块更新正文' }),
    evidence({ evidenceId: 'e3', chunkId: undefined, text: '无块正文' }),
    evidence({ evidenceId: 'e4', chunkId: 'different-chunk', text: '原始证据\n第二行' })] });
  const before = JSON.stringify([first, next]);
  const records = [record(first), record(next, 2)];
  const merged = buildPanels(records)[0].groups[0].documents[0];
  assert.equal(merged.evidence.length, 3);
  assert.deepEqual(merged.evidence[0].occurrences, [{ retrievalId: 'r1', evidenceId: 'ev-r1-1' }, { retrievalId: 'r2', evidenceId: 'e2' }]);
  assert.deepEqual(merged.evidence[1].occurrences, [{ retrievalId: 'r1', evidenceId: 'e-text' }, { retrievalId: 'r2', evidenceId: 'e3' }]);
  assert.equal(JSON.stringify([first, next]), before);
  buildPanels([record(first), record(first, 2)]).forEach(panel => assert.equal(panel.groups[0].documents[0].evidence[0].occurrences.length, 1));
});

test('无 chunkId 与相同正文证据合并，两个不同 chunkId 的相同正文仍独立', () => {
  const noChunk = payload({ retrievalId: 'r0', evidence: [evidence({ chunkId: undefined })] });
  const withChunk = payload();
  const otherChunk = payload({ retrievalId: 'r2', evidence: [evidence({ evidenceId: 'e2', chunkId: 'other' })] });
  for (const values of [[noChunk, withChunk, otherChunk], [withChunk, noChunk, otherChunk]]) {
    const merged = buildPanels(values.map((value, index) => record(value, index + 1)))[0].groups[0].documents[0];
    assert.equal(merged.evidence.length, 2);
    assert.equal(merged.evidence[0].occurrences.length, 2);
  }
});

test('并发完成的链接按 resultSeq 选择，文档仍保持 callSeq 顺序', () => {
  const olderCall = { ...record(payload({ documents: [document({ openUrl: 'https://example.com/late' })] }), 1), resultSeq: 20 };
  const newerCall = { ...record(payload({ documents: [document({ openUrl: 'https://example.com/early' })] }), 2), resultSeq: 10 };
  const merged = buildPanels([olderCall, newerCall])[0].groups[0].documents[0];
  assert.deepEqual(merged.links.map(link => link.resultSeq), [10, 20]);
  assert.equal(getDocumentOpenState(merged, now).url, 'https://example.com/late');
});

test('documents 请求收敛单一区域，未确认候选不默认全显，空选择仍保留区域', () => {
  const records = [record(payload()), record(payload({ purpose: 'documents', evidence: [] }), 2)];
  assert.deepEqual(buildPanels(records), [{ purpose: 'documents', groups: [], notice: '文件候选尚未确认，请重试。' }]);
  const panels = buildPanels(records, { selection: { purpose: 'documents', documentRefs: [document().documentRef] } });
  assert.deepEqual(panels.map(panel => panel.purpose), ['documents']);
  assert.equal(panels[0].groups[0].documents[0].evidence.length, 0);
  assert.deepEqual(buildPanels(records, { selection: { purpose: 'documents', documentRefs: [] } }), [{ purpose: 'documents', groups: [] }]);
  assert.deepEqual(buildPanels([{ status: 'invalid', message: 'bad' }]), []);
});

test('选择最近取得的有效 HTTP(S) 链接，完整保留 fragment；点击时重新判断过期', () => {
  const old = document({ openUrl: 'https://example.com/old#ticket=full' });
  const latest = document({ openUrl: 'https://example.com/latest#ticket=a%2Bb&name=%E4%B8%AD', openUrlExpiresAt: '2026-01-01T02:00:00Z' });
  const merged = { links: [old, latest, document({ openStatus: 'source_unavailable' })] };
  assert.deepEqual(getDocumentOpenState(merged, now), { available: true, label: '查看原文', url: latest.openUrl, expiresAt: now + 7200000 });
  assert.equal(getDocumentOpenState(merged, now + 7200000).label, '原文不可用');
  assert.equal(getDocumentOpenState({ links: [latest, old] }, now).url, old.openUrl);
  assert.equal(getDocumentOpenState(old, now + 3600000).label, '链接已过期，请重新检索');
  assert.equal(getDocumentOpenState({ links: [latest, document({ openUrlExpiresAt: '2025-01-01T00:00:00Z' })] }, now).url, latest.openUrl);
});

test('不可用、未配置、缺失 URL/有效期及不安全 URL 均不产生可点击地址', () => {
  for (const changes of [{ openUrl: 'javascript:alert(1)' }, { openUrl: 'data:text/html,hello' }, { openUrl: '/relative' },
    { openUrl: null }, { openUrlExpiresAt: null }, { openUrlExpiresAt: 'invalid' },
    { openUrlExpiresAt: '2026-02-30T00:00:00Z' }, { openStatus: 'other' }]) {
    assert.equal(getDocumentOpenState(document(changes), now).available, false);
    assert.equal(getDocumentOpenState(document(changes), now).url, undefined);
  }
  assert.equal(getDocumentOpenState(document({ openStatus: 'source_unavailable' }), now).label, '原文不可用');
  assert.equal(getDocumentOpenState(document({ openStatus: 'not_configured' }), now).label, '原文链接未配置');
});

test('识别真实DSH spill标记但不把普通路径或损坏JSON当截短', () => {
  const text = '{"schemaVersion":2,\n[...]\nFull formatted result stored at D:/private/result.json';
  assert.equal(readKnowledgeResult(text).status, 'truncated');
  assert.equal(readKnowledgeResult({ content: [{ type: 'text', text }] }).status, 'truncated');
  assert.equal(readKnowledgeResult('{"schemaVersion":2, D:/private/result.json').status, 'invalid');
  assert.equal(readKnowledgeResult('Full formatted result stored at D:/private/result.json').status, 'unsupported');
});

test('明确文件名在documents与辅助knowledge全集精确筛选，同名跨库保留并强制约束选择', () => {
  const target = '03_政策文件_老年人能力评估与结果互认工作要点.md';
  const candidates = Array.from({ length: 10 }, (_, index) => document({ documentRef: `candidate-${index}`, docId: `${index}`, documentName: `其他文件${index}.md` }));
  const first = record(payload({ purpose: 'documents', documents: candidates, evidence: [] }));
  const targets = [document({ documentRef: 'target-a', documentName: target }), document({ documentRef: 'target-b', knowledgeBaseId: 'other', documentName: target })];
  const last = record(payload({ documents: targets, evidence: [] }), 2);
  const records = [first, last];
  for (const options of [{ userText: `帮我找“${target}”` }, { userText: `帮我找 ${target}`, selection: { purpose: 'documents', documentRefs: ['candidate-0'] } },
    { userText: `帮我找 ${target.replace(/\.md$/, '')}` }]) {
    const panels = buildPanels(records, options);
    assert.equal(panels.length, 1);
    assert.equal(panels[0].purpose, 'documents');
    assert.deepEqual(panels[0].groups.flatMap(group => group.documents.map(item => item.documentRef)), ['target-a', 'target-b']);
  }
  assert.equal(collectDocuments(records).length, 12);
  assert.equal(buildPanels(records, { userText: '找不存在.md' })[0].notice, '未找到指定文件。');
  assert.equal(buildPanels(records, { userText: '找政策相关文件' })[0].groups.length, 0);
  const spacedName = '2026-10-19 销售周会：项目进展与商机跟进.md';
  const spaced = [record(payload({ purpose: 'documents', documents: [document({ documentName: spacedName })], evidence: [] }))];
  for (const userText of [`请找《${spacedName}》`, `帮我找 ${spacedName}`, '帮我找 2026-10-19销售周会:项目进展与商机跟进.md']) {
    assert.equal(buildPanels(spaced, { userText })[0].groups[0].documents.length, 1);
  }
  assert.equal(buildPanels(spaced, { userText: '请找《2026-10-20 销售周会：项目进展与商机跟进.md》' })[0].groups.length, 0);
});

test('选择只接受真实文档和证据；空选择、证据筛选和来源调用校验', () => {
  const records = [{ ...record(payload()), callId: 'c1' }];
  assert.throws(() => validateSelection(records, { purpose: 'knowledge', documentRefs: ['unknown'] }), /不存在/);
  assert.throws(() => validateSelection(records, { purpose: 'knowledge', documentRefs: [document().documentRef], evidenceIds: ['unknown'] }), /证据/);
  assert.throws(() => validateSelection(records, { purpose: 'knowledge', documentRefs: [document().documentRef], sourceCallIds: ['replaced'] }), /来源/);
  const value = validateSelection(records, { purpose: 'knowledge', documentRefs: [document().documentRef], evidenceIds: [] });
  assert.deepEqual(value.sourceCallIds, ['c1']);
  assert.equal(buildPanels(records, { selection: value })[0].groups[0].documents[0].evidence.length, 0);
  assert.deepEqual(buildPanels(records, { selection: { purpose: 'knowledge', documentRefs: [] } }), [{ purpose: 'knowledge', groups: [] }]);
  const updated = [...records, { ...record(payload({ retrievalId: 'r2', evidence: [evidence({ evidenceId: 'updated', text: '更新证据正文' })] }), 2), callId: 'c2' }];
  const panel = buildPanels(updated, { selection: { purpose: 'knowledge', documentRefs: [document().documentRef], evidenceIds: ['updated'] } });
  assert.equal(panel[0].groups[0].documents[0].evidence[0].text, '更新证据正文');
  assert.deepEqual(panel[0].groups[0].documents[0].evidence[0].occurrences, [{ retrievalId: 'r2', evidenceId: 'updated' }]);
});

test('最终可用交付隐藏中间失败，无可用文档才保留准确错误状态', () => {
  const failure = { status: 'truncated', message: '历史检索结果已被截短，请重新检索以展示完整来源', purpose: 'documents' };
  const records = [failure, record(payload())];
  assert.deepEqual(buildPresentation(records, { userText: '找同名文档.pdf' }).notices, []);
  assert.equal(buildPresentation([failure]).panels[0].purpose, 'documents');
  assert.deepEqual(buildPresentation([failure]).notices, [{ status: 'truncated', message: failure.message }]);
  assert.deepEqual(buildPresentation(records, { selection: { purpose: 'documents', documentRefs: [] } }).notices, []);
});

test('openPath绑定来源origin且保留票据，新协议禁止openUrl回退，历史URL兼容', () => {
  const pathDocument = document({ linkProtocol: 'path', sourceOrigin: 'https://knowledge.example:8443', openPath: '/preview/a.pdf?ticket=a%2Bb#page=2' });
  assert.equal(getDocumentOpenState(pathDocument, now).url, 'https://knowledge.example:8443/preview/a.pdf?ticket=a%2Bb#page=2');
  for (const openPath of ['//other.example/file', 'https://other.example/file', 'javascript:alert(1)', '/\\evil.example/file', '/path\nnext', null]) {
    assert.equal(getDocumentOpenState({ ...pathDocument, openPath }, now).available, false);
  }
  assert.equal(getDocumentOpenState({ ...pathDocument, sourceOrigin: undefined }, now).label, '无法确定原文服务地址');
  assert.equal(getDocumentOpenState({ ...pathDocument, sourceOrigin: 'file:///private' }, now).available, false);
  assert.equal(getDocumentOpenState({ ...pathDocument, openUrlExpiresAt: '2025-01-01T00:00:00Z' }, now).label, '链接已过期，请重新检索');
  assert.equal(getDocumentOpenState(document(), now).url, document().openUrl);
});
