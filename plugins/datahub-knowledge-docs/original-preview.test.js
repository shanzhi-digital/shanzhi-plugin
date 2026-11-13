import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createOriginalPreviewHandler, projectOriginalTurn, resolveOriginalUrl, safeOriginalFilename,
  registerOriginalPreview, MAX_ORIGINAL_BYTES, ORIGINAL_TIMEOUT_MS } from './original-preview.js';
import { RETRIEVE_TOOL, RECORD_TYPE } from './results.js';

const pdf = Buffer.from('%PDF-1.7\nsynthetic original\n%%EOF');
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('synthetic docx bytes')]);
const markdown = Buffer.from('# 完整原文\n\n- 条目\n\n|名称|值|\n|---|---|\n|测试|通过|\n\n```js\nconsole.log(1)\n```\n');
const document = (origin, changes = {}) => ({ documentRef: 'kb/doc', knowledgeBaseId: 'kb', knowledgeBaseName: '知识库',
  docId: 'doc', documentName: '制度.md', openStatus: 'available', linkProtocol: 'path', sourceOrigin: origin,
  openPath: '/md?ticket=synthetic', openUrlExpiresAt: '2099-01-01T00:00:00Z', ...changes });
const eventsFor = (documents, { turn = 1, callId = 'c1', seq = 1, retrievalId = 'r1' } = {}) => [
  { type: 'turn/start', seq, data: { turn } },
  { type: 'tool/call', seq: seq + 1, data: { turn, callId, name: RETRIEVE_TOOL, arguments: { purpose: 'documents' } } },
  { type: 'tool/result', seq: seq + 2, surfaceOp: 'append', data: { turn, message: { source: { callId },
    structuredContent: { schemaVersion: 2, purpose: 'documents', retrievalId, documents, evidence: [] } } } },
];
const liveContext = events => ({ remoteAccess: { async allows() { return true; } }, sessions: { get() {
  return { snapshotEvents: () => events }; } } });
const code = expected => error => error.code === expected && !error.message.includes('ticket=');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-preview-'));
  const counts = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    if (url.pathname === '/redirect') { response.writeHead(302, { location: 'http://outside.invalid/secret' }); response.end(); return; }
    if (url.pathname === '/error') { response.writeHead(403); response.end('expired'); return; }
    if (url.pathname === '/html') { response.setHeader('content-type', 'application/pdf'); response.end('<!doctype html><html>failure</html>'); return; }
    if (url.pathname === '/json') { response.setHeader('content-type', 'application/json'); response.end('{"error":"expired"}'); return; }
    if (url.pathname === '/no-type') { response.end(pdf); return; }
    if (url.pathname === '/other-type') { response.setHeader('content-type', 'application/x-source-document'); response.end(docx); return; }
    if (url.pathname === '/short-docx') { response.end('PK'); return; }
    if (url.pathname === '/wrong-type') { response.setHeader('content-type', 'text/html'); response.end(pdf); return; }
    if (url.pathname === '/large-header') { response.setHeader('content-length', '999999999'); response.end(); return; }
    if (url.pathname === '/large-stream') { response.write(Buffer.alloc(128)); response.end(Buffer.alloc(128)); return; }
    if (url.pathname === '/slow') {
      response.setHeader('content-type', 'text/markdown');
      response.write('#');
      const timer = setTimeout(() => response.end(' delayed original'), 100);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/hang') {
      response.setHeader('content-type', 'text/markdown'); response.write('#'); return;
    }
    if (url.pathname === '/api/ai/rag/kb/source_document_direct') {
      assert.equal(url.searchParams.get('ticket'), 'synthetic+a/b=%');
      response.setHeader('content-type', 'application/pdf'); response.end(pdf); return;
    }
    if (url.pathname === '/docx') {
      response.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      response.end(docx); return;
    }
    response.setHeader('content-type', 'text/markdown; charset=utf-8'); response.end(markdown);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, counts, origin: `http://127.0.0.1:${server.address().port}`,
    cachePath: (...parts) => join(root, ...parts) };
}
async function cacheFiles(root) {
  return (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
}

test('下载完整MD/PDF/DOCX字节，PDF fragment票据正确转direct，结果不带票据', async t => {
  const f = await fixture(t);
  const documents = [document(f.origin), document(f.origin, { documentRef: 'kb/pdf', docId: 'pdf', documentName: '原文.pdf',
    openPath: '/source-document-preview#ticket=synthetic%2Ba%2Fb%3D%25&name=original.pdf' }),
  document(f.origin, { documentRef: 'kb/docx', docId: 'docx', documentName: '原文.docx', openPath: '/docx?ticket=synthetic' })];
  const cache = createOriginalPreviewHandler(liveContext(eventsFor(documents)), f);
  for (const [index, bytes] of [markdown, pdf, docx].entries()) {
    const result = await cache('s1', 1, 'c1', documents[index].documentRef);
    assert.deepEqual(Object.keys(result).sort(), ['absolutePath', 'documentName', 'sessionId']);
    assert.equal(result.sessionId, 's1');
    assert.equal(result.documentName, documents[index].documentName);
    assert.deepEqual(await readFile(result.absolutePath), bytes);
    assert.ok(result.absolutePath.endsWith(documents[index].documentName));
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
  assert.equal(f.counts.get('/source-document-preview'), undefined);
  assert.equal(MAX_ORIGINAL_BYTES, 32 * 1024 * 1024);
  assert.equal(ORIGINAL_TIMEOUT_MS, 60_000);
});

test('同一有效检索版本复用缓存，文件删除后重新下载，新检索版本另存', async t => {
  const f = await fixture(t);
  const docs = [document(f.origin)];
  let events = eventsFor(docs);
  const ctx = liveContext(events);
  ctx.sessions.get = () => ({ snapshotEvents: () => events });
  const cache = createOriginalPreviewHandler(ctx, f);
  const first = await cache('s1', 1, 'c1', 'kb/doc');
  assert.deepEqual(await cache('s1', 1, 'c1', 'kb/doc'), first);
  assert.equal(f.counts.get('/md'), 1);
  await unlink(first.absolutePath);
  assert.deepEqual(await cache('s1', 1, 'c1', 'kb/doc'), first);
  assert.equal(f.counts.get('/md'), 2);
  events = eventsFor(docs, { retrievalId: 'r2' });
  const next = await cache('s1', 1, 'c1', 'kb/doc');
  assert.notEqual(next.absolutePath, first.absolutePath);
  docs[0].openUrlExpiresAt = '2000-01-01T00:00:00Z';
  await assert.rejects(cache('s1', 1, 'c1', 'kb/doc'), code('LINK_EXPIRED'));
  assert.equal(f.counts.get('/md'), 3);
});

test('同名跨库文档与不同会话缓存独立，安全命名保留扩展且无票据', async t => {
  const f = await fixture(t);
  const docs = [document(f.origin, { documentName: '../../CON?.md' }),
    document(f.origin, { documentRef: 'other/doc', knowledgeBaseId: 'other', documentName: '../../CON?.md' })];
  const cache = createOriginalPreviewHandler(liveContext(eventsFor(docs)), f);
  const first = await cache('session-with-secret', 1, 'c1', docs[0].documentRef);
  const second = await cache('session-with-secret', 1, 'c1', docs[1].documentRef);
  const third = await cache('s2', 1, 'c1', docs[0].documentRef);
  assert.equal(new Set([first.absolutePath, second.absolutePath, third.absolutePath]).size, 3);
  assert.equal(basename(first.absolutePath), '.._.._CON_.md');
  assert.ok(!first.absolutePath.includes('session-with-secret'));
  for (const name of ['CON.md', 'nul.docx', 'COM1.pdf', 'LPT9.markdown']) assert.ok(safeOriginalFilename(name).startsWith('_'));
  assert.equal(safeOriginalFilename('a\\b:<c>?.pdf '), 'a_b__c__.pdf');
  assert.ok(safeOriginalFilename('x'.repeat(500) + '.docx').endsWith('.docx'));
});

test('历史turn保留真实来源；后续turn或无turn替换均失效', async t => {
  const f = await fixture(t);
  const old = eventsFor([document(f.origin)]);
  const later = eventsFor([document(f.origin, { documentRef: 'kb/later', docId: 'later' })], { turn: 2, callId: 'c2', seq: 10 });
  let events = [...old, ...later];
  const ctx = liveContext(events);
  ctx.sessions.get = () => ({ snapshotEvents: () => events });
  const cache = createOriginalPreviewHandler(ctx, f);
  assert.deepEqual(projectOriginalTurn(events, 1).records.map(record => record.callId), ['c1']);
  await cache('s', 1, 'c1', 'kb/doc');
  await assert.rejects(cache('s', 1, 'c2', 'kb/doc'), code('SOURCE_UNAVAILABLE'));
  await assert.rejects(cache('s', 2, 'c1', 'kb/doc'), code('SOURCE_UNAVAILABLE'));
  for (const data of [{ turn: 2 }, {}]) {
    events = [...old, ...later, { type: 'system/message', seq: 20, data, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } }];
    await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('SOURCE_UNAVAILABLE'));
  }
  assert.equal(f.counts.get('/md'), 1);
});

test('持久完整结果替代截短正文且后续覆盖完整记录会失效', async t => {
  const f = await fixture(t);
  const events = eventsFor([document(f.origin)]);
  const payload = events[2].data.message.structuredContent;
  events[2].data.message = { source: { callId: 'c1' }, content: [{ type: 'text', text: '[...] Full formatted result stored at x' }] };
  events.push({ type: RECORD_TYPE, seq: 4, data: { version: 1, turn: 1, callId: 'c1', callSeq: 2, status: 'success', payload } });
  const cache = createOriginalPreviewHandler(liveContext(events), f);
  await cache('s', 1, 'c1', 'kb/doc');
  events.push({ type: 'turn/start', seq: 9, data: { turn: 2 } },
    { type: 'system/message', seq: 10, data: { turn: 2 }, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } });
  await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('SOURCE_UNAVAILABLE'));
});

test('cold session先异步授权再读事件且成功/异常都关闭句柄', async t => {
  const f = await fixture(t);
  const order = [];
  let failRead = false;
  const ctx = { remoteAccess: { async allows(resource) {
    assert.deepEqual(resource, { kind: 'session', id: 'cold' }); await Promise.resolve(); order.push('allowed'); return true;
  } }, sessions: { get() { order.push('live'); return null; } }, sessionPersistence: { async open(id, mode, options) {
    order.push('open'); assert.equal(id, 'cold'); assert.equal(mode, 'read'); assert.ok('signal' in options);
    return { async read(start, count, opts) {
      order.push('read'); assert.equal(start, 0); assert.equal(count, Number.MAX_SAFE_INTEGER); assert.ok('signal' in opts);
      if (failRead) throw new Error('sensitive URL'); return { events: eventsFor([document(f.origin)]) };
    }, async close() { order.push('close'); } };
  } } };
  const cache = createOriginalPreviewHandler(ctx, f);
  await cache('cold', 1, 'c1', 'kb/doc');
  assert.deepEqual(order, ['allowed', 'live', 'open', 'read', 'close']);
  order.length = 0; failRead = true;
  await assert.rejects(cache('cold', 1, 'c1', 'kb/doc'), code('SOURCE_UNAVAILABLE'));
  assert.deepEqual(order, ['allowed', 'live', 'open', 'read', 'close']);
});

test('拒绝无权限、伪造来源和无效请求，不读取会话或下载', async t => {
  const f = await fixture(t);
  let reads = 0;
  const ctx = { remoteAccess: { async allows() { return false; } }, sessions: { get() { reads++; } } };
  const cache = createOriginalPreviewHandler(ctx, f);
  await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('ACCESS_DENIED'));
  assert.equal(reads, 0);
  for (const args of [['', 1, 'c1', 'kb/doc'], ['s', 1.5, 'c1', 'kb/doc'], ['s', 1, '', 'kb/doc']]) {
    await assert.rejects(cache(...args), code('INVALID_REQUEST'));
  }
  assert.equal(f.counts.size, 0);
});

test('按结果完成次序取最近有效同源链接并绑定其真实文件名与检索版本', async t => {
  const f = await fixture(t);
  const first = eventsFor([document(f.origin, { documentName: 'old.pdf', openPath: '/error' })]);
  const second = eventsFor([document(f.origin, { documentName: 'new.md' })], { callId: 'c2', seq: 4, retrievalId: 'r2' });
  const events = [first[0], first[1], second[1], second[2], { ...first[2], seq: 8 }];
  let cache = createOriginalPreviewHandler(liveContext(events), f);
  await assert.rejects(cache('s', 1, 'c2', 'kb/doc'), code('DOWNLOAD_FAILED'));
  first[2].data.message.structuredContent.documents[0].openUrlExpiresAt = '2000-01-01T00:00:00Z';
  cache = createOriginalPreviewHandler(liveContext(events), f);
  const value = await cache('s', 1, 'c1', 'kb/doc');
  assert.ok(value.absolutePath.endsWith('new.md'));
  assert.equal(value.documentName, 'new.md');
});

test('非法跨源路径、凭据或缺PDF票据拒绝；direct非PDF保留原路径参数', () => {
  const origin = 'https://knowledge.example';
  for (const changes of [{ openPath: '//outside.invalid/a' }, { openPath: '/\\outside.invalid/a' },
    { openPath: '/source-document-preview#name=a.pdf' }, { sourceOrigin: 'file:///tmp' },
    { openPath: undefined, linkProtocol: 'url', openUrl: 'https://outside.invalid/a' },
    { sourceOrigin: 'https://user:password@knowledge.example' }]) {
    assert.throws(() => resolveOriginalUrl(document(origin, changes)), code('SOURCE_UNAVAILABLE'));
  }
  assert.equal(resolveOriginalUrl(document(origin, { openPath: '/direct/original.md?ticket=fake%2Ba' })),
    `${origin}/direct/original.md?ticket=fake%2Ba`);
});

test('真实文件头允许缺失或非标准Content-Type，截短DOCX拒绝', async t => {
  const f = await fixture(t);
  for (const [path, name, bytes] of [['/no-type', 'original.pdf', pdf], ['/other-type', 'original.docx', docx]]) {
    const cache = createOriginalPreviewHandler(liveContext(eventsFor([document(f.origin,
      { documentName: name, openPath: path })])), f);
    assert.deepEqual(await readFile((await cache('s', 1, 'c1', 'kb/doc')).absolutePath), bytes);
  }
  const cache = createOriginalPreviewHandler(liveContext(eventsFor([document(f.origin,
    { documentName: 'short.docx', openPath: '/short-docx' })])), f);
  await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('DOWNLOAD_FAILED'));
  assert.ok((await cacheFiles(f.root)).every(name => !name.endsWith('.tmp')));
});

test('HTTP失败、跳转、错误HTML/JSON及错误PDF类型不缓存并清临时文件', async t => {
  const f = await fixture(t);
  for (const path of ['/error', '/redirect', '/html', '/json', '/wrong-type']) {
    const cache = createOriginalPreviewHandler(liveContext(eventsFor([document(f.origin,
      { documentName: 'original.pdf', openPath: path })])), f);
    await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('DOWNLOAD_FAILED'));
    assert.deepEqual(await cacheFiles(f.root), []);
  }
});

test('Content-Length和流式超限都拒绝并清理', async t => {
  const f = await fixture(t);
  for (const path of ['/large-header', '/large-stream']) {
    const cache = createOriginalPreviewHandler(liveContext(eventsFor([document(f.origin, { openPath: path })])), { ...f, maxBytes: 100 });
    await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('TOO_LARGE'));
    assert.deepEqual(await cacheFiles(f.root), []);
  }
});

test('超时取消流并清理；失败后可重试', async t => {
  const f = await fixture(t);
  const docs = [document(f.origin, { openPath: '/hang' })];
  const cache = createOriginalPreviewHandler(liveContext(eventsFor(docs)), { ...f, timeoutMs: 25 });
  await assert.rejects(cache('s', 1, 'c1', 'kb/doc'), code('TIMEOUT'));
  assert.deepEqual(await cacheFiles(f.root), []);
  docs[0].openPath = '/md';
  assert.deepEqual(await readFile((await cache('s', 1, 'c1', 'kb/doc')).absolutePath), markdown);
});

test('并发共享一次下载，取消一个请求不会终止其他请求', async t => {
  const f = await fixture(t);
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  const cache = createOriginalPreviewHandler(liveContext(eventsFor([document(f.origin, { openPath: '/slow' })])), {
    ...f, async fetchImpl(...args) { const response = await fetch(...args); started(); return response; },
  });
  const controller = new AbortController();
  const first = cache('s', 1, 'c1', 'kb/doc', controller.signal);
  const second = cache('s', 1, 'c1', 'kb/doc');
  const failure = assert.rejects(first, code('CANCELLED'));
  await downloading;
  controller.abort();
  await failure;
  const result = await second;
  assert.deepEqual(await readFile(result.absolutePath), Buffer.from('# delayed original'));
  assert.equal(f.counts.get('/slow'), 1);
  assert.ok((await cacheFiles(f.root)).every(name => !name.endsWith('.tmp')));
});

test('全部消费者取消会结束下载、清理，并允许新请求', async t => {
  const f = await fixture(t);
  const docs = [document(f.origin, { openPath: '/hang' })];
  let started;
  const downloading = new Promise(resolve => { started = resolve; });
  let settled;
  const settledDownload = new Promise(resolve => { settled = resolve; });
  const fetchImpl = async (...args) => {
    const response = await fetch(...args); started();
    const reader = response.body.getReader();
    return new Response(new ReadableStream({ async pull(controller) {
      try { const value = await reader.read(); if (value.done) controller.close(); else controller.enqueue(value.value); }
      catch (error) { controller.error(error); settled(); }
    }, async cancel() { await reader.cancel().catch(() => {}); settled(); } }), { headers: response.headers });
  };
  const cache = createOriginalPreviewHandler(liveContext(eventsFor(docs)), { ...f, fetchImpl });
  const controller = new AbortController();
  const request = cache('s', 1, 'c1', 'kb/doc', controller.signal);
  const rejected = assert.rejects(request, code('CANCELLED'));
  await downloading;
  controller.abort();
  await rejected;
  await settledDownload;
  docs[0].openPath = '/md';
  await cache('s', 1, 'c1', 'kb/doc');
  // Give the aborted download's final filesystem cleanup a deterministic event-loop turn.
  await new Promise(resolve => setImmediate(resolve));
  assert.ok((await cacheFiles(f.root)).every(name => !name.endsWith('.tmp')));
});

test('官方stage3方法注册运行实例initializer并保留资源参数与安全错误', async () => {
  let Registered;
  const bound = [];
  class Base { constructor(ctx, name) { this.ctx = ctx; assert.equal(name, 'knowledgeDocs'); } }
  class RemoteError extends Error {
    constructor(code, message, details) { super(message); this.code = code; this.details = details; }
  }
  let rootChecks = 0;
  let sessionReads = 0;
  const ctx = { plugin(Service) { Registered = Service; },
    remoteAccess: { async allows() { rootChecks++; return true; } },
    sessions: { get() { sessionReads++; throw new Error('must not read session before invocation access'); } },
  };
  const invocationCtx = { remoteAccess: { allows: async () => false }, sessions: ctx.sessions };
  registerOriginalPreview(ctx, { TypertRemoteService: Base, RemoteError, dshCachePath: join,
    Remote(options) { assert.equal(options.resources.session('s'), 's'); return (method, context) => {
      assert.equal(context.kind, 'method'); assert.equal(context.name, 'cacheOriginal');
      context.addInitializer(function () { bound.push([this, method]); });
    }; } });
  assert.deepEqual(Registered.inject, ['remoteAccess', 'sessions', 'sessionPersistence']);
  const service = new Registered(ctx);
  assert.equal(bound[0][0], service);
  assert.equal(bound[0][1], service.cacheOriginal);
  // The gateway supplies a per-invocation service context, distinct from the registration context.
  service.ctx = invocationCtx;
  await assert.rejects(service.cacheOriginal('s', 1, 'c1', 'kb/doc'), error =>
    error instanceof RemoteError && error.code === 'ACCESS_DENIED' && error.message === '无会话访问权限' &&
    JSON.stringify(error.details) === '{}');
  assert.equal(rootChecks, 0);
  assert.equal(sessionReads, 0);
});
