// Desktop browser smoke test of the already-built client.js. No server or SQL query.
// node build/browser-smoke.mjs --esbuild-dir <esbuild> --react-dir <react>
//   --react-dom-dir <react-dom> --playwright-dir <playwright-core> --out-dir <artifacts>
// Instead of the three module directories, --react-script <React UMD> and
// --react-dom-script <ReactDOM UMD> can load existing browser distributions.
// Optional: --browser <Chrome/Edge executable> --client <built client.js>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Expected --option value; got ${name}`);
  options.set(name.slice(2), value);
}
for (const name of ['playwright-dir', 'out-dir']) {
  if (!options.has(name)) throw new Error(`Missing --${name}; see usage at the top of this script.`);
}
const moduleDir = (name) => resolve(options.get(name));
const output = moduleDir('out-dir');
const clientPath = resolve(options.get('client') || join(here, '..', 'client.js'));
const client = readFileSync(clientPath, 'utf8');
const scriptRuntime = options.has('react-script') && options.has('react-dom-script');
if (!scriptRuntime) for (const name of ['esbuild-dir', 'react-dir', 'react-dom-dir']) {
  if (!options.has(name)) throw new Error(`Missing --${name}, or supply --react-script and --react-dom-script.`);
}
const { chromium } = await import(pathToFileURL(join(moduleDir('playwright-dir'), 'index.mjs')).href);
const browsers = [options.get('browser'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  chromium.executablePath(),
].filter(Boolean);
const browserPath = browsers.find(existsSync);
assert.ok(browserPath, 'No installed Chrome/Edge found; pass --browser explicitly.');
mkdirSync(output, { recursive: true });
let runtimeCode;
if (scriptRuntime) {
  runtimeCode = `${readFileSync(resolve(options.get('react-script')), 'utf8')}\n${readFileSync(resolve(options.get('react-dom-script')), 'utf8')}\nwindow.__createRoot=window.ReactDOM.createRoot;\n`;
} else {
  const esbuild = await import(pathToFileURL(join(moduleDir('esbuild-dir'), 'lib', 'main.js')).href);
  const runtime = await esbuild.build({
    stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; window.React=React; window.__createRoot=createRoot;", resolveDir: here },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    alias: { react: moduleDir('react-dir'), 'react-dom': moduleDir('react-dom-dir') },
    nodePaths: [...new Set([dirname(moduleDir('react-dir')), dirname(moduleDir('react-dom-dir'))])],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', legalComments: 'none',
  });
  runtimeCode = runtime.outputFiles[0].text;
}
writeFileSync(join(output, 'runtime.js'), runtimeCode);
writeFileSync(join(output, 'client-under-test.js'), client);

// All numbers and query strings below are synthetic UI fixtures, never business data.
const followUps = ['志愿服务类别有哪些报名活动？', '可以按月份查看这些报名人数吗？', '文体活动的签到人数是多少？'];
const sql = `SELECT category, enroll_total\nFROM fixture_summary\nWHERE note = '<img src=x onerror="window.__sqlExecuted=true">';\n-- <script>window.__sqlExecuted=true</script>`;
const common = {
  title: '浏览器验收夹具 · 各活动类别报名人数',
  columns: [{ name: 'category', title: '活动类别', type: 'string' }, { name: 'enroll_total', title: '报名人数', type: 'number' }],
  data: [{ category: '志愿服务', enroll_total: '691' }, { category: '文体活动', enroll_total: 1006 }, { category: '学术活动', enroll_total: 420 }],
  rowCount: 3, offset: 0, limit: 3, truncated: false, dimension: 'category', measures: ['enroll_total'], chartType: 'bar', reason: '', followUps,
  source: { toolName: 'mcp__postgres__query', callId: 'fixture-query-1', resultSeq: 10, sql },
};
function fixture(name, value, tool = 'query_result_chart') {
  const callId = `fixture-${name}`;
  return { name, value, events: [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId, name: tool, arguments: '{}' } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } } },
  ] };
}
const fixtures = {
  generic: fixture('generic', common),
  compatibility: fixture('compatibility', { ...common, title: '浏览器验收夹具 · DataHub 兼容工具', datasourceId: 'fixture-datahub', chartType: 'line' }, 'datahub_chart'),
  empty: fixture('empty', { ...common, title: '浏览器验收夹具 · 空查询结果', data: [], rowCount: 0, limit: 0, dimension: null, measures: [], reason: '查询没有返回数据。' }),
  negative: fixture('negative', { ...common, title: '浏览器验收夹具 · 负数饼图回退', chartType: 'pie', defaultView: 'table', dimension: 'category', measures: ['enroll_total'], reason: '结果含负数或全部为零，无法呈现有效占比，已保留原始表格。', rowCount: 2, data: [{ category: '正数', enroll_total: 10 }, { category: '负数', enroll_total: -5 }] }),
  zero: fixture('zero', { ...common, title: '浏览器验收夹具 · 全零饼图回退', chartType: 'pie', defaultView: 'table', dimension: 'category', measures: ['enroll_total'], reason: '结果含负数或全部为零，无法呈现有效占比，已保留原始表格。', rowCount: 2, data: [{ category: '零值甲', enroll_total: 0 }, { category: '零值乙', enroll_total: 0 }] }),
};
writeFileSync(join(output, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
const harness = `
window.__calls={queries:[],network:[],insertions:[],sends:[],captures:0,registrations:[]};
window.fetch=(...args)=>{window.__calls.network.push(String(args[0]));return Promise.reject(new Error('Fixture blocks network'));};
const originalOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url,...rest){window.__calls.network.push(String(url));return originalOpen.call(this,method,url,...rest);};
window.__ModuleLoader__={load(definition){
 const plugin=definition.factory((name)=>{if(name==='react')return window.React;throw new Error('Unexpected external '+name);});
 window.__plugin=plugin;
 const ctx={
  uiConversation:{events:{register(definition){window.__eventDefinition=definition;}}},
  tools:{execute(...args){window.__calls.queries.push(args);throw new Error('UI must not query');}},
  slots:{inject(_name,callback){return callback();},register(options,Component){window.__calls.registrations.push(options);window.__TurnTail=Component;}},
 };
 plugin.apply(ctx);
}};
window.__mountFixture=(fixture)=>{
 if(window.__root)window.__root.unmount();
 const definition=window.__eventDefinition;let state;
 for(const event of fixture.events){const matched=definition.match(event);if(!matched)continue;const match={...matched,event};state=match.role==='start'?definition.start({state},match):definition.update({state},match);}
 const location=definition.buildLocationData({state},'turn');
 if(!location||location.value.length!==1)throw new Error('Fixture projection did not reconstruct exactly one card: '+fixture.name);
 window.__fixture=fixture;window.__location=location;
 const inputActions={
  captureInsertion(){window.__calls.captures++;return {revision:1,fixture:true};},
  insertText(text,span){window.__calls.insertions.push({text,span});document.getElementById('composer').value=text;},
  send(...args){window.__calls.sends.push(args);},submit(...args){window.__calls.sends.push(args);},sendMessage(...args){window.__calls.sends.push(args);},
 };
 document.getElementById('composer').value='';
 window.__root=window.__createRoot(document.getElementById('root'));
 window.__root.render(window.React.createElement(window.__TurnTail,{seq:100,turn:{data:new Map([[location.key,location.value]])},inputActions}));
};
`;
writeFileSync(join(output, 'harness.js'), harness);
writeFileSync(join(output, 'fixture-data.js'), `window.__fixtures=${JSON.stringify(fixtures)};\nwindow.__mountFixture(window.__fixtures.generic);\n`);
const shell = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DataHub chart desktop browser fixture</title><style>
:root{--dsw-alias-label-secondary:#667085;--dsw-alias-label-primary:#1d2939;--dsw-alias-border-l1:#d0d5dd;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#eaecf0;}*{box-sizing:border-box}body{margin:0;background:#f4f6f9;color:#1d2939;font:14px/1.5 Arial,'Microsoft YaHei',sans-serif}main{max-width:1160px;margin:28px auto;padding:0 24px}h1{font-size:20px;margin:0}p.fixture-note{color:#667085;margin:6px 0 16px}label{display:block;font-weight:600;margin:14px 0 6px}textarea{display:block;width:100%;min-height:85px;border:1px solid #d0d5dd;border-radius:8px;padding:12px;font:inherit;background:#fff}summary{user-select:none}
</style></head><body><main><h1>桌面浏览器验收 · 查询结果图表</h1><p class="fixture-note">以下为合成验收数据，仅验证本地构建产物；无数据库连接和查询。</p><div id="root"></div><label for="composer">模拟会话输入框（跟问点选仅填入）</label><textarea id="composer" placeholder="点选跟问后在此检查文本"></textarea></main></body></html>`;
writeFileSync(join(output, 'fixture.html'), shell.replace('</body>', '<script src="runtime.js"></script><script src="harness.js"></script><script src="client-under-test.js"></script><script src="fixture-data.js"></script></body>'));
const report = { status: 'running', clientPath, clientSha256: createHash('sha256').update(client).digest('hex'), browserPath, viewport: { width: 1440, height: 1000 }, startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [] };
let browser;
try {
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  const requests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await context.route('**/*', (route) => route.abort());
  await page.setContent(shell);
  for (const filename of ['runtime.js', 'harness.js', 'client-under-test.js', 'fixture-data.js']) await page.addScriptTag({ path: join(output, filename) });
  const section = page.locator('#root section');
  const capture = async (name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: join(output, filename), fullPage: true });
    report.screenshots.push(filename);
  };
  const check = (name, details = {}) => { report.checks.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };
  const mount = async (name) => {
    await page.evaluate((name) => window.__mountFixture(window.__fixtures[name]), name);
    await section.getByText(fixtures[name].value.title, { exact: true }).waitFor();
  };
  const canvas = async (name) => {
    await section.locator('canvas').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#root canvas');
      if (!canvas || !canvas.width || !canvas.height) return false;
      const image = canvas.toDataURL();
      const previous = window.__canvasFrame;
      if (!previous || previous.image !== image) { window.__canvasFrame = { image, since: Date.now() }; return false; }
      return Date.now() - previous.since > 250;
    }, null, { polling: 100, timeout: 10000 });
    const stats = await section.locator('canvas').first().evaluate((canvas) => {
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let painted = 0; const colors = new Set();
      for (let index = 0; index < image.data.length; index += 16) {
        if (image.data[index + 3] > 0) { painted++; colors.add(`${image.data[index]},${image.data[index + 1]},${image.data[index + 2]}`); }
      }
      const bounds = canvas.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, paintedSamples: painted, colorCount: colors.size, image: canvas.toDataURL() };
    });
    assert.ok(stats.width >= 500 && stats.height >= 250, `${name}: canvas is too small`);
    assert.ok(stats.paintedSamples > 100 && stats.colorCount > 5, `${name}: canvas appears blank`);
    const hash = createHash('sha256').update(stats.image).digest('hex');
    delete stats.image;
    check(name, { ...stats, canvasSha256: hash });
    return hash;
  };
  const view = async (name, expectedCanvas) => {
    await section.getByRole('button', { name, exact: true }).click();
    assert.equal(await section.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
    if (expectedCanvas) return canvas(`switch to ${name}`);
    assert.equal(await section.locator('canvas').count(), 0);
    assert.equal(await section.locator('table').count(), 1);
    check(`switch to ${name}`);
  };
  await section.getByText(common.title, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__calls.registrations[0].name), 'conversation.chat.turnTail');
  assert.equal(await page.evaluate(() => window.__location.value.length), 1);
  check('query_result_chart projects into a real React turn-tail card');
  const barHash = await canvas('initial bar renders painted canvas');
  await capture('01-generic-bar');
  const lineHash = await view('折线图', true);
  await capture('02-generic-line');
  const pieHash = await view('饼图', true);
  await capture('03-generic-pie');
  assert.equal(new Set([barHash, lineHash, pieHash]).size, 3, 'Bar/line/pie must produce different canvas pixels.');
  check('bar line and pie have different rendered pixels');
  await view('表格', false);
  assert.deepEqual(await section.locator('thead th').allTextContents(), ['活动类别', '报名人数']);
  assert.equal(await section.locator('tbody tr').count(), 3);
  assert.deepEqual(await section.locator('tbody tr').first().locator('td').allTextContents(), ['志愿服务', '691']);
  check('table preserves fixture columns and original numeric-string cells');
  const details = section.locator('details');
  assert.equal(await details.evaluate((node) => node.open), false);
  await details.locator('summary').click();
  assert.equal(await details.evaluate((node) => node.open), true);
  assert.equal(await details.locator('pre').textContent(), sql);
  assert.equal(await details.locator('pre img, pre script').count(), 0);
  assert.notEqual(await page.evaluate(() => window.__sqlExecuted), true);
  check('SQL starts collapsed and expands as literal text without HTML execution');
  assert.equal(await section.getByRole('button').count(), 7);
  for (const text of followUps) {
    await section.getByRole('button', { name: text, exact: true }).click();
    assert.equal(await page.locator('#composer').inputValue(), text);
  }
  const followUpCalls = await page.evaluate(() => window.__calls);
  assert.equal(followUpCalls.captures, 3);
  assert.equal(followUpCalls.insertions.length, 3);
  assert.ok(followUpCalls.insertions.every((call) => call.span?.fixture === true));
  assert.equal(followUpCalls.sends.length, 0);
  check('all three follow-ups capture insertion and fill composer without sending');
  await capture('04-table-sql-follow-up');
  await view('柱状图', true);
  await mount('compatibility');
  await canvas('legacy datahub_chart projects and renders initial line');
  assert.ok((await section.textContent()).includes('数据源：fixture-datahub'));
  await capture('05-datahub-compatibility');
  await mount('empty');
  assert.equal(await section.locator('canvas').count(), 0);
  assert.equal(await section.locator('tbody tr').count(), 0);
  assert.ok((await section.textContent()).includes('查询没有返回数据。'));
  for (const label of ['柱状图', '折线图', '饼图']) await view(label, false);
  check('empty result stays an honest empty table across all chart choices');
  await capture('06-empty-table');
  await mount('negative');
  assert.equal(await section.getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await section.getByRole('button', { name: '饼图', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await section.locator('canvas').count(), 0);
  assert.equal(await section.locator('tbody tr').count(), 2);
  assert.ok((await section.textContent()).includes('负数或全部为零'));
  assert.ok((await section.locator('tbody').textContent()).includes('-5'));
  assert.equal(await page.evaluate(() => window.__fixture.value.dimension), 'category');
  assert.deepEqual(await page.evaluate(() => window.__fixture.value.measures), ['enroll_total']);
  check('negative pie honors defaultView table while retaining dimension measure and negative value');
  await capture('07-negative-pie-table');
  await view('柱状图', true);
  await capture('09-negative-switched-bar');
  await view('饼图', false);
  assert.ok((await section.locator('tbody').textContent()).includes('-5'));
  check('negative default-table result switches to a rendered bar and back to pie table');
  await capture('10-negative-switched-pie-table');
  await mount('zero');
  assert.equal(await section.getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await section.locator('canvas').count(), 0);
  assert.ok((await section.textContent()).includes('负数或全部为零'));
  check('all-zero pie honors defaultView table');
  await capture('08-zero-pie-table');
  await view('柱状图', true);
  await view('饼图', false);
  check('all-zero default-table result switches to a rendered bar and back to pie table');
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.queries, []);
  assert.deepEqual(calls.network, []);
  assert.deepEqual(calls.sends, []);
  assert.deepEqual(requests, []);
  assert.deepEqual(pageErrors, []);
  check('all UI interactions perform zero queries zero network requests and zero sends');
  report.status = 'passed';
  report.invocationCounts = { queries: calls.queries.length, networkRequests: requests.length, sends: calls.sends.length, followUpInsertions: calls.insertions.length };
  report.browserVersion = browser.version();
} catch (error) {
  report.status = 'failed';
  report.errors.push({ message: error.message, stack: error.stack });
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`BROWSER SMOKE ${report.status.toUpperCase()}: ${join(output, 'report.json')}`);
}
