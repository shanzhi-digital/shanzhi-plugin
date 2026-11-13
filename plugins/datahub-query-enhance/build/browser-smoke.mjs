// Built-client browser smoke. No server or business query.
// node build/browser-smoke.mjs --tools-dir <node_modules> --out-dir <artifacts> [--browser <Chrome/Edge>]
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY, SQL_TOOL } from '../trust.js';
import { projectEvents } from '../event-projection.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
if (!args.get('tools-dir') || !args.get('out-dir')) throw new Error('Pass --tools-dir and --out-dir');
const tools = resolve(args.get('tools-dir'));
const output = resolve(args.get('out-dir'));
const esbuild = await import(pathToFileURL(join(tools, 'esbuild/lib/main.js')).href);
const { chromium } = await import(pathToFileURL(join(tools, 'playwright-core/index.mjs')).href);
const browserPath = [args.get('browser'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  chromium.executablePath(),
].find(path => path && existsSync(path));
assert.ok(browserPath, 'No installed Chromium browser');
mkdirSync(output, { recursive: true });
const runtime = await esbuild.build({
  stdin: { contents: "import React from 'react';import{createRoot}from'react-dom/client';window.React=React;window.createRoot=createRoot;", resolveDir: tools },
  bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020',
  alias: { react: join(tools, 'react'), 'react-dom': join(tools, 'react-dom') },
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none', logLevel: 'warning',
});
const sql = usedMeasures => ({ queryKind: 'SEMANTIC_SQL', datasourceId: 'fixture', semanticCommit: 'fixture-commit',
  columns: [{ name: '数量', type: 'Int64' }], data: [{ 数量: '10' }], usedMeasures });
const measure = (member, trusted) => ({ datasourceId: 'fixture', model: 'fixture', member, title: member, trusted, trustHash: `fixture-${member}` });
function events(usedMeasures, reason = 'completed') {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'fixture-sql', name: SQL_TOOL } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 1, message: { source: { callId: 'fixture-sql' }, content: [{ type: 'text', text: JSON.stringify(sql(usedMeasures)) }] } } },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: reason } } },
  ];
}
const fixtures = {
  trusted: projectEvents(events([measure('count', true)])).get(1),
  partial: projectEvents(events([measure('count', true), measure('total', false)])).get(1),
  untrusted: projectEvents(events([measure('count', false)])).get(1),
  expression: projectEvents(events([])).get(1),
  canceled: projectEvents(events([measure('count', true)], 'aborted')).get(1),
  empty: null,
};
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<html lang="zh-CN"><meta charset="utf-8"><body style="margin:64px;font-family:Microsoft YaHei,sans-serif;color:#302d28"><main style="max-width:760px"><p>浏览器烟测：以下结果均为合成夹具。</p><p>查询结果与数据洞察正文。</p><div id="root"></div><p id="actions" style="color:#999;font-size:12px">复制 · 反馈</p></main></body></html>');
  await page.addScriptTag({ content: runtime.outputFiles[0].text });
  await page.evaluate(() => {
    window.definitions = [];
    window.__ModuleLoader__ = { load(definition) {
      const plugin = definition.factory(name => { if (name === 'react') return window.React; throw Error(name); });
      plugin.apply({ uiConversation: { events: { register: def => window.definitions.push(def) } },
        slots: { inject: (_name, callback) => callback(), register: (options, component) => { window.slot = options; window.Tail = component; } } });
    } };
    window.root = window.createRoot(document.getElementById('root'));
  });
  await page.addScriptTag({ content: readFileSync(join(here, '../client.js'), 'utf8') });
  assert.equal(await page.evaluate(() => window.definitions.length), 2);
  assert.equal(await page.evaluate(() => window.slot.name), 'conversation.chat.turnTail');
  async function render(name) {
    await page.evaluate(({ key, trust }) => window.root.render(window.React.createElement(window.Tail, { seq: 100, turn: { data: new Map([[key, trust]]) } })), { key: KEY, trust: fixtures[name] });
  }
  await render('trusted');
  await page.getByText('可信指标', { exact: true }).waitFor();
  const help = page.getByRole('button', { name: '可信指标说明', exact: true });
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  await help.click();
  await page.getByText('可信指标是指统计口径、数据来源已经人工确认的指标', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'trusted.png') });
  await help.press('Escape');
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  await render('partial');
  await page.getByText('部分可信', { exact: true }).waitFor();
  await page.getByRole('button', { name: '部分可信说明', exact: true }).click();
  await page.getByText('部分指标已人工确认', { exact: true }).waitFor();
  await render('untrusted');
  await page.getByText('数据由AI提取，注意辨别', { exact: true }).waitFor();
  assert.equal(await page.locator('.dqe-trust button').count(), 0);
  const badge = await page.locator('.dqe-trust').boundingBox();
  const actions = await page.locator('#actions').boundingBox();
  assert.ok(Math.abs(badge.x - actions.x) < 1 && badge.y < actions.y, 'Badge is left-aligned above actions');
  await page.screenshot({ path: join(output, 'untrusted.png') });
  await page.setViewportSize({ width: 390, height: 600 });
  await render('expression');
  await page.getByText('数据由AI提取，注意辨别', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await render('canceled');
  await page.locator('.dqe-trust').waitFor({ state: 'detached' });
  await render('empty');
  assert.equal(await page.locator('.dqe-trust').count(), 0);
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true, scenarios: Object.keys(fixtures), browser: browser.version() }, null, 2));
  console.log(`Browser smoke passed: ${Object.keys(fixtures).join(', ')}`);
} finally { await browser.close(); }
