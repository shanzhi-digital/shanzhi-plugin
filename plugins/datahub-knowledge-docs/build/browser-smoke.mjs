// Offline browser verification. No server or live knowledge request.
// node build/browser-smoke.mjs --tools-dir <node_modules> --out-dir <artifacts>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
if (!options.get('--tools-dir') || !options.get('--out-dir')) throw new Error('Pass --tools-dir and --out-dir');
const tools = resolve(options.get('--tools-dir'));
const output = resolve(options.get('--out-dir'));
const { chromium } = await import(pathToFileURL(join(tools, 'playwright-core/index.mjs')).href);
const esbuild = await import(pathToFileURL(join(tools, 'esbuild/lib/main.js')).href);
const runtime = await esbuild.build({
  stdin: { contents: "import React from 'react';import {createRoot} from 'react-dom/client';window.React=React;window.createRoot=createRoot;", resolveDir: tools },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
  nodePaths: [tools], define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none'
});
const client = readFileSync(join(here, '../client.js'), 'utf8');
const expires = new Date(Date.now() + 3600000).toISOString();
const origin = 'https://knowledge.example.invalid';
const targetName = '03_政策文件_老年人能力评估与结果互认工作要点.md';
const doc = (id, extra = {}) => ({
  documentRef: `kb:9007199254740993123:doc:${id}`, knowledgeBaseId: '9007199254740993123', knowledgeBaseName: '养老制度', docId: String(id),
  documentName: `相关文档${id}.md`, contentType: 'text/markdown', sourceAvailable: true, openStatus: 'available',
  openPath: `/source-document-preview#ticket=FIXTURE-${id}&name=example.md`, openUrlExpiresAt: expires,
  sourceOrigin: origin, linkProtocol: 'path', ...extra
});
const documents = Array.from({ length: 10 }, (_, i) => doc(String(i + 1), i === 0 ? { documentName: targetName } : i > 5 ? {
  knowledgeBaseId: '9007199254740993222', knowledgeBaseName: '会议纪要', documentRef: `kb:9007199254740993222:doc:${i + 1}`
} : {}));
const payload = (purpose, id, docs, evidence = []) => ({ schemaVersion: 2, purpose, retrievalId: id, query: purpose === 'documents' ? targetName : '政策问题', documents: docs, evidence });
const evidence = (d, id, text = '评估结果在业务办理中共享复用。') => ({ evidenceId: id, documentRef: d.documentRef, chunkId: `chunk-${id}`, text });
const start = (text = '请解释政策') => [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text }] } }
];
function retrieval(value, id, seq, truncated = false) {
  return [
    { type: 'tool/call', seq, data: { turn: 1, callId: id, name: 'mcp__datahub-knowledge__retrieve_knowledge', arguments: { query: value.query, purpose: value.purpose } } },
    { type: 'plugin:datahub-knowledge-docs/result', seq: seq + 1, ignorable: true, data: { version: 1, turn: 1, callId: id, callSeq: seq, status: 'success', payload: value } },
    { type: 'tool/result', seq: seq + 2, surfaceOp: 'append', data: { turn: 1, message: { toolCallId: id, source: { callId: id }, content: [{ type: 'text', text: truncated ? '{"schemaVersion":2,"text":"long\n\n[...]\n\nend"}\n(Full formatted result stored at fixture.txt)' : JSON.stringify(value) }] } } }
  ];
}
function selection(purpose, refs, sources, seq = 20) {
  const callId = `selection-${seq}`;
  const value = { kind: 'knowledge-documents-selection', purpose, documentRefs: refs, sourceCallIds: sources };
  return [
    { type: 'tool/call', seq, data: { turn: 1, callId, name: 'knowledge_documents_present', arguments: { purpose, documentRefs: refs } } },
    { type: 'tool/result', seq: seq + 1, surfaceOp: 'append', data: { turn: 1, message: { toolCallId: callId, source: { callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } }
  ];
}
const knowledgePayload = payload('knowledge', 'r-long', documents, documents.map((d, i) => evidence(d, `ev-${i}`, i === 0 ? '<img src=x onerror="window.__injected=true">\n合成证据正文。'.repeat(1200) : undefined)));
const fixtures = {
  target: [...start(`帮我找一下这个文档：${targetName}`), ...retrieval(payload('documents', 'r-docs', documents), 'docs', 2),
    ...retrieval(payload('knowledge', 'r-aux', [documents[0]], [evidence(documents[0], 'aux')]), 'aux', 5), ...selection('documents', [documents[0].documentRef], ['docs', 'aux'])],
  fallback: [...start(`帮我找一下这个文档：${targetName}`), ...retrieval(payload('documents', 'r-docs', documents), 'docs', 2),
    ...retrieval(payload('knowledge', 'r-aux', [documents[0]], [evidence(documents[0], 'aux')]), 'aux', 5)],
  knowledge: [...start(), ...retrieval(knowledgePayload, 'long', 2, true), ...selection('knowledge', documents.map(d => d.documentRef), ['long'])],
  related: [...start('找养老服务相关文件'), ...retrieval(payload('documents', 'r-related', documents), 'related', 2), ...selection('documents', documents.slice(0, 6).map(d => d.documentRef), ['related'])],
  unconfirmed: [...start('找养老服务相关文件'), ...retrieval({ ...payload('documents', 'r-related', documents), query: '养老服务相关文件' }, 'related', 2)],
  empty: [...start('找文件'), ...retrieval(payload('documents', 'r-empty', []), 'empty', 2), ...selection('documents', [], ['empty'])],
  states: [...start(), ...retrieval(payload('knowledge', 'states', [doc('exp', { openUrlExpiresAt: new Date(Date.now() - 60000).toISOString() }), doc('none', { openStatus: 'source_unavailable', openPath: null }), doc('base', { sourceOrigin: null }), doc('bad', { openPath: '//other.invalid/preview' })]), 'states', 2)],
  legacy: [...start(), ...retrieval(payload('knowledge', 'legacy', []), 'legacy', 2, true)].filter(e => !e.ignorable),
  invalid: [...start(), ...retrieval(payload('knowledge', 'invalid', []), 'invalid', 2)].filter(e => !e.ignorable),
  failed: [...start(), ...retrieval(payload('knowledge', 'failed', []), 'failed', 2)].filter(e => !e.ignorable)
};
fixtures.invalid.at(-1).data.message.content[0].text = '{"schemaVersion":2,"documents":';
fixtures.failed.at(-1).data.message.isError = true;
const harness = `
window.__opens=[];window.open=(...args)=>{window.__opens.push(args);return null;};
window.__definitions=[];window.__ModuleLoader__={load(def){const plugin=def.factory(name=>{if(name==='react')return window.React;throw new Error(name);});plugin.apply({uiConversation:{events:{register(definition){window.__definitions.push(definition);}}},slots:{inject(key,callback){callback();},register(options,Component){window.__TurnTail=Component;}}});}};
window.renderEvents=events=>{const contexts=new Map(),latest=new Map();const reader={previous:kind=>latest.get(kind)};for(const event of events)for(const d of window.__definitions){const m=d.match(event);if(!m)continue;const match={...m,event};const key=d.kind+':'+m.id;let c=contexts.get(key);if(!c){if(m.role!=='start')continue;c={kind:d.kind,id:m.id,state:undefined};c.state=d.start(c,match,reader);contexts.set(key,c);}else c.state=d.update(c,match);latest.set(d.kind,c);}const d=window.__definitions.find(d=>d.kind==='datahub-knowledge-docs');const c=latest.get(d.kind);const loc=c?d.buildLocationData(c,'turn'):{value:{records:[],selections:[],userText:'',documentMode:false}};window.__projected=loc.value;window.__root??=window.createRoot(document.getElementById('root'));window.__root.render(window.React.createElement(window.__TurnTail,{turn:{data:new Map([[d.kind,loc.value]])},seq:9}));};
`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>问知文档插件0.2.0 · 离线验证</title><style>body{margin:0;background:#faf9f6;color:#302d28;font:14px/1.8 'Microsoft YaHei',sans-serif}main{max-width:960px;margin:48px auto;padding:0 24px}.answer{padding-bottom:12px;border-bottom:1px solid #e8e5df}.answer h2{font-size:20px}.label{font-size:11px;color:#918a80}body.dark{background:#20211f;color:#e6e4de;--dsw-alias-label-primary:#e6e4de;--dsw-alias-label-secondary:#a9a69d;--dsw-alias-border-l1:#42433e;--dsw-alias-bg-layer-1:#292a26}@media(max-width:520px){main{margin:24px auto;padding:0 16px}}</style><main><div class="label">问知文档插件0.2.0 · 合成测试数据</div><article class="answer"><h2>文档查询结果</h2><p>已找到你要的文档。</p></article><div id="root"></div></main><script src="runtime.js"></script><script src="harness.js"></script><script src="client-under-test.js"></script><script src="fixtures.js"></script><script>renderEvents(__fixtures.target);</script></html>`;
mkdirSync(output, { recursive: true });
for (const [name, content] of Object.entries({ 'runtime.js': runtime.outputFiles[0].text, 'harness.js': harness, 'client-under-test.js': client, 'fixtures.js': `window.__fixtures=${JSON.stringify(fixtures)};`, 'fixture.html': html })) writeFileSync(join(output, name), content);
const executablePath = [options.get('--browser'), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', chromium.executablePath()].find(p => p && existsSync(p));
assert.ok(executablePath, 'No installed browser');
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const checks = [], errors = [];
page.on('pageerror', e => errors.push(e.message));
async function check(name, work) { await work(); checks.push({ name, passed: true }); }
async function render(name) { await page.evaluate(name => window.renderEvents(window.__fixtures[name]), name); await page.waitForTimeout(70); }
try {
  await page.goto(pathToFileURL(join(output, 'fixture.html')).href);
  await page.getByRole('heading', { name: '找到的文档', exact: true }).waitFor();
  await check('指定文件10候选加辅助检索，仅显示目标一份且无检索来源', async () => {
    assert.equal(await page.locator('.kd-row').count(), 1);
    assert.equal(await page.locator('.kd-name').innerText(), targetName);
    assert.equal(await page.getByRole('heading', { name: '检索来源', exact: true }).count(), 0);
    assert.equal(await page.locator('details').count(), 0);
  });
  await check('openPath以MCP站点解析且保留完整票据fragment', async () => {
    await page.locator('.kd-open').click();
    assert.deepEqual(await page.evaluate(() => window.__opens[0]), [new URL(documents[0].openPath, origin).href, '_blank', 'noopener,noreferrer']);
  });
  await page.screenshot({ path: join(output, 'documents-target.png'), fullPage: true });
  await check('历史完整找文件数据精确筛选，无最终工具也不列出无关候选', async () => { await render('fallback'); assert.equal(await page.locator('.kd-row').count(), 1); });
  await check('超过阈值的完整结果覆盖截短预览，无格式错误', async () => {
    await render('knowledge'); await page.getByRole('heading', { name: '检索来源', exact: true }).waitFor();
    assert.equal(await page.locator('.kd-row').count(), 5);
    assert.equal(await page.locator('.kd-status').count(), 0);
    await page.locator('summary').first().click();
    assert.ok((await page.locator('.kd-fragment p').first().textContent()).length > 50000);
    assert.equal(await page.locator('.kd-fragment img').count(), 0);
  });
  await check('10份文档默认5份，展开全部，收起恢复，证据折叠独立', async () => {
    const more = page.getByRole('button', { name: '展开其余 5 份文档 ↓', exact: true });
    assert.equal(await more.getAttribute('aria-expanded'), 'false'); await more.click();
    assert.equal(await page.locator('.kd-row').count(), 10); assert.equal(await page.locator('.kd-group').count(), 2);
    await page.getByRole('button', { name: '收起文档列表 ↑', exact: true }).click(); assert.equal(await page.locator('.kd-row').count(), 5);
  });
  await page.screenshot({ path: join(output, 'knowledge-collapsed.png'), fullPage: true });
  await check('6份相关文件可以展开第6份，无来源区和片段', async () => {
    await render('related'); assert.equal(await page.locator('.kd-row').count(), 5);
    await page.getByRole('button', { name: '展开其余 1 份文档 ↓', exact: true }).click(); assert.equal(await page.locator('.kd-row').count(), 6);
    assert.equal(await page.locator('details').count(), 0);
  });
  await check('泛查未确认不冒充文件清单，空结果保持明确', async () => {
    await render('unconfirmed'); assert.equal(await page.locator('.kd-row').count(), 0); assert.match(await page.locator('.kd-docs').innerText(), /候选尚未确认/);
    await render('empty'); assert.equal(await page.locator('.kd-row').count(), 0); assert.match(await page.locator('.kd-docs').innerText(), /未找到/);
  });
  await check('过期、无源文件、缺少MCP地址和跨站路径均不可打开', async () => { await render('states'); assert.equal(await page.locator('.kd-open:disabled').count(), 4); });
  await check('历史截短、真正格式损坏和失败可区分', async () => {
    for (const [name, pattern] of [['legacy', /截短/], ['invalid', /损坏|格式/], ['failed', /失败/]]) { await render(name); assert.match(await page.locator('.kd-docs').innerText(), pattern); }
  });
  await check('事件重新回放恢复选中文档，不重复追加', async () => { await render('target'); await render('target'); assert.equal(await page.locator('.kd-row').count(), 1); });
  await check('窄屏键盘展开、长文件名与深色主题', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await render('related');
    const more = page.locator('.kd-more'); await more.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('.kd-row').count(), 6); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(output, 'documents-mobile.png'), fullPage: true });
    await page.evaluate(() => document.body.classList.add('dark')); await page.screenshot({ path: join(output, 'documents-dark.png'), fullPage: true });
  });
  assert.deepEqual(errors, []);
  const report = { status: 'passed', browserPath: executablePath, clientSha256: createHash('sha256').update(client).digest('hex'), checks, errors };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
