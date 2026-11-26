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
  // Mirror the installed host's flow spacing, turn-tail layout and slot wrappers.
  await page.setContent(`<html lang="zh-CN"><meta charset="utf-8"><style>
    body{margin:32px;font-family:Microsoft YaHei,sans-serif;color:#302d28}
    main{max-width:760px;margin:auto}p{margin:0}
    [data-slot="conversation.chat.flow"]{display:flex;flex-direction:column}
    [data-slot="conversation.chat.flow"]>div+div{margin-top:var(--dsh-chat-flow-gap,4px)}
    [data-chat-group-part="response"]+[data-chat-flow-kind]{--dsh-chat-flow-gap:12px}
    [data-slot="conversation.chat.turnTail"],#root{display:contents}
    [data-turn-tail]{display:flex;flex-direction:column;gap:16px}
    #results{margin:16px 0}
    #actions{margin:4px 0 0 -6px;color:#999;font-size:12px}
    #suggestions{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:12px;font-size:12px}
    #suggestions span{padding:5px 12px;border:1px solid #eee;border-radius:16px}
  </style><main><p>浏览器烟测：以下结果均为合成夹具。</p>
    <div data-slot="conversation.chat.flow">
      <div data-chat-group-part="response"><p>查询结果与数据洞察正文。</p></div>
      <div data-chat-flow-kind="turn-tail"><div data-slot="conversation.chat.node"><div data-turn-tail="1">
        <div id="root" data-slot="conversation.chat.turnTail"></div><p id="actions">复制 · 反馈</p>
      </div></div></div>
      <div data-chat-flow-kind="turn-tail" id="other-tail"><div data-turn-tail="2">其他回合</div></div>
    </div></main></html>`);
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
    await page.evaluate(({ key, trust }) => {
      const h = window.React.createElement;
      window.root.render(h(window.React.Fragment, null,
        h('div', { id: 'results', style: { margin: '16px 0' } }, h('section', null, '查询结果表格'),
          h('div', { id: 'suggestions', 'aria-label': '后续问题' }, h('p', null, '进一步分析'),
            h('span', null, '各区县的基础改造项数与可选改造项数分别是多少？'),
            h('span', null, '把各区县的改造费用、补助金额与达标率放在一起对比看看'))),
        h(window.Tail, { seq: 100, turn: { data: new Map([[key, trust]]) } })));
    }, { key: KEY, trust: fixtures[name] });
  }
  await render('trusted');
  await page.getByText('可信指标', { exact: true }).waitFor();
  const help = page.getByRole('button', { name: '可信指标说明', exact: true });
  const layout = await page.evaluate(() => {
    const stylesheet = document.querySelector('.dqe-trust style').sheet;
    stylesheet.disabled = true;
    const previousGap = document.querySelector('.dqe-trust').getBoundingClientRect().top - document.querySelector('#suggestions').getBoundingClientRect().bottom;
    stylesheet.disabled = false;
    const badge = document.querySelector('.dqe-trust').getBoundingClientRect();
    const above = document.querySelector('#suggestions').getBoundingClientRect();
    const icon = document.querySelector('.dqe-trust-help svg')?.getBoundingClientRect();
    return { gap: badge.top - above.bottom, previousGap, icon: icon ? { width: icon.width, height: icon.height } : null,
      otherTailGap: getComputedStyle(document.querySelector('#other-tail')).marginTop };
  });
  assert.equal(layout.previousGap, 32, 'Host flex gap and result panel margin reproduce the reported spacing');
  assert.equal(layout.gap, 12, 'Trust status sits 12px below the follow-up list');
  assert.deepEqual(layout.icon, { width: 14, height: 14 });
  assert.equal(layout.otherTailGap, '4px', 'Unrelated turn tails retain host spacing');
  assert.equal(await help.evaluate(button => getComputedStyle(button).borderTopWidth), '0px');
  await page.screenshot({ path: join(output, 'trusted-compact.png') });
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  await help.click();
  await page.getByText('可信指标是指统计口径、数据来源已经人工确认的指标', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'trusted.png') });
  await help.press('Escape');
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await help.evaluate(button => button.matches(':focus-visible') && getComputedStyle(button).outlineStyle !== 'none'), true);
  await help.press('Enter');
  assert.equal(await help.getAttribute('aria-expanded'), 'true');
  await help.click();
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
  assert.ok(Math.abs(badge.x - actions.x - 6) < 1 && badge.y < actions.y, 'Badge is aligned with content above the host action row');
  await page.screenshot({ path: join(output, 'untrusted.png') });
  await page.setViewportSize({ width: 390, height: 600 });
  await render('trusted');
  await page.getByRole('button', { name: '可信指标说明', exact: true }).click();
  await page.getByText('可信指标是指统计口径、数据来源已经人工确认的指标', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: join(output, 'trusted-narrow.png') });
  await render('expression');
  await page.getByText('数据由AI提取，注意辨别', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await render('canceled');
  await page.locator('.dqe-trust').waitFor({ state: 'detached' });
  await render('empty');
  assert.equal(await page.locator('.dqe-trust').count(), 0);
  assert.equal(await page.locator('#results').evaluate(element => getComputedStyle(element).marginBottom), '16px', 'Result margin is unchanged when no trust badge is rendered');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed: true, scenarios: Object.keys(fixtures), layout, browser: browser.version() }, null, 2));
  console.log(`Browser smoke passed: ${Object.keys(fixtures).join(', ')}`);
} finally { await browser.close(); }
