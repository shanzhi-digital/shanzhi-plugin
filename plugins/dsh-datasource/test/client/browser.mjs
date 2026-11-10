import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// No server is started. Playwright serves these isolated files through request routing.
// React is pinned; its UMD files are cached outside the repository, never shipped in the plugin.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright');
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.env.DSH_CLIENT_TEST_OUTPUT || path.join(os.tmpdir(), 'dsh-datasource-client-test'));
await mkdir(output, { recursive: true });
const vendorFile = async (name, override) => {
  if (override) return readFile(override, 'utf8');
  const filename = path.join(output, `${name}-18.3.1.development.js`);
  try { const cached = await readFile(filename, 'utf8'); if (cached.length > 1000) return cached; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = `https://registry.npmjs.org/${name}/-/${name}-18.3.1.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Cannot load pinned fixture dependency ${url}: ${response.status}`);
  const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const expected = `package/umd/${name}.development.js`;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const entry = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    if (entry === expected) { const text = archive.subarray(offset + 512, offset + 512 + size).toString(); await writeFile(filename, text, 'utf8'); return text; }
    if (!Number.isFinite(size)) throw new Error(`Invalid fixture dependency archive: ${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Pinned React fixture module missing from archive: ${expected}`);
};
const clientPath = path.resolve(process.env.DSH_CLIENT_UNDER_TEST || path.join(directory, '../../client.js'));
const [react, reactDom, html, fixture, client, themeText] = await Promise.all([
  vendorFile('react', process.env.DSH_REACT_UMD), vendorFile('react-dom', process.env.DSH_REACTDOM_UMD),
  readFile(path.join(directory, 'fixture.html'), 'utf8'), readFile(path.join(directory, 'fixture.js'), 'utf8'), readFile(clientPath, 'utf8'),
  readFile(path.join(directory, 'host-theme.json'), 'utf8'),
]);
const hostTheme = JSON.parse(themeText);
// Models the public Host DOM contract only. This is not an authenticated Host session.
const hostThemeScript = `(${((tokens) => {
  const style = document.createElement('style'); style.id = 'fixture-host-theme';
  const declarations = (index) => Object.entries(tokens).map(([name, values]) => `${name}:${values[index]}`).join(';');
  style.textContent = `body{${declarations(0)}}body[data-ds-dark-theme]{${declarations(1)}}:focus-visible{outline-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-width:var(--dsw-focus-ring-width)}html[data-input-modality=pointer] body :focus-visible:not(:read-write){--dsw-focus-ring-color:transparent;outline-color:transparent}`;
  document.head.append(style);
  let overrides = [];
  window.__fixtureTheme = {
    set(scheme) {
      if (!['light', 'dark'].includes(scheme)) throw new Error(`Unsupported fixture theme: ${scheme}`);
      document.documentElement.style.colorScheme = scheme;
      document.documentElement.dataset.dsThemeSource = scheme;
      document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark');
    },
    override(values = {}) {
      for (const name of overrides) document.body.style.removeProperty(name);
      overrides = Object.keys(values);
      for (const [name, value] of Object.entries(values)) document.body.style.setProperty(name, value);
    },
  };
  document.addEventListener('keydown', (event) => { if (event.key === 'Tab') document.documentElement.dataset.inputModality = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { document.documentElement.dataset.inputModality = 'pointer'; }, true);
  window.__fixtureTheme.set(window.__fixtureInitialTheme || 'light');
}).toString()})(${JSON.stringify(hostTheme.tokens)});`;
const browser = await chromium.launch({ headless: true, ...(process.env.DSH_CHROME ? { executablePath: process.env.DSH_CHROME } : {}), args: ['--no-first-run', '--no-default-browser-check'] });
const results = [];
const check = (result, label) => { result.checks.push(label); console.log(`PASS ${result.viewport}: ${label}`); };
const wait = (page, callback, argument) => page.waitForFunction(callback, argument, { timeout: 12000 });
const calls = (page, action) => page.evaluate((name) => window.__fixture.calls.filter((call) => call.operation === 'flow-action' && call.payload.action === name).map((call) => call.payload), action);
const tab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
const settlePoll = async (page, callback) => { await page.evaluate(callback); const count = await page.evaluate(() => window.__fixture.stateReads); await wait(page, (before) => window.__fixture.stateReads > before, count); };
const screenshot = async (page, result, name) => { await page.locator('.dsh-ds').evaluate((element) => { element.scrollTop = 0; }); const filename = `${result.viewport}-${name}.png`; await page.screenshot({ path: path.join(output, filename), fullPage: true }); result.screenshots.push(filename); };
async function setup(viewport, options = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: options.theme || 'light' });
  const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('http://fixture.dsh.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const files = { '/': ['text/html', html], '/host-theme.js': ['text/javascript', hostThemeScript], '/vendor.js': ['text/javascript', `${react}\n;${reactDom}`], '/fixture.js': ['text/javascript', fixture], '/client.js': ['text/javascript', client] };
    const entry = files[pathname]; return route.fulfill({ status: entry ? 200 : 204, contentType: entry?.[0] || 'text/plain', body: entry?.[1] || '' });
  });
  await page.addInitScript(({ empty, theme }) => { window.__fixtureEmpty = !!empty; window.__fixtureInitialTheme = theme || 'light'; }, options);
  await page.goto('http://fixture.dsh.test/');
  await page.getByTestId('datasource-page').waitFor();
  return { context, page, errors };
}
async function verifyEmpty(viewport, result) {
  const { context, page, errors } = await setup(viewport, { empty: true });
  try {
    assert.equal(await page.getByTestId('datasource-empty').textContent(), '没有数据源连接');
    assert.equal(await page.locator('.ds-source-row').count(), 0);
    await page.getByRole('button', { name: '+ 创建数据源连接', exact: true }).click();
    assert.equal(await page.getByLabel('数据源类型', { exact: true }).inputValue(), 'mysql');
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []); check(result, '真实空状态、默认MySQL、Escape关闭弹框');
  } catch (error) { result.status = 'failed'; result.error = error.stack; result.errors = errors; await screenshot(page, result, 'empty-failure').catch(() => {}); throw error; }
  finally { await context.close(); }
}
function verifyCssContract() {
  const result = { viewport: 'theme-css-contract', kind: 'theme-contract', checks: [], screenshots: [] }; results.push(result);
  const css = client.match(/const css = `([\s\S]*?)`;/)?.[1];
  assert.ok(css, 'Production CSS template must be present');
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b/i, 'Production CSS must consume Host tokens instead of fixed HEX colors');
  const allowed = new Set([...Object.keys(hostTheme.tokens), ...hostTheme.optionalTokens]);
  const referenced = [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))];
  assert.deepEqual(referenced.filter((name) => !allowed.has(name)), [], 'CSS references must be verified public Host tokens');
  assert.deepEqual(hostTheme.valueOrder, ['light', 'dark']);
  assert.equal(hostTheme.fixtureOnly, true); assert.equal(hostTheme.authenticatedHostPageObserved, false);
  result.referencedTokens = referenced; result.status = 'passed';
  check(result, '生产CSS无固定HEX，全部变量均在已取证官方token白名单（含可选focus-ring-color）内');
}
const syntheticCustomOverrides = {
  '--dsw-alias-bg-base': '#14112b', '--dsw-alias-bg-layer-1': '#211c3b',
  '--dsw-alias-bg-layer-2': '#2e284a', '--dsw-alias-bg-layer-3': '#3d365a',
  '--dsw-alias-bg-module-platform': '#302947', '--dsw-specific-input-major': '#1c1735',
  '--dsw-alias-label-primary': '#fff5e9', '--dsw-alias-label-secondary': '#d5c8ec',
  '--dsw-alias-label-tertiary': '#b4a6cf', '--dsw-alias-button-primary-fill': '#f7d78b',
  '--dsw-alias-button-primary-hover': '#ffe9ad', '--dsw-alias-label-primary-foreground': '#22162a',
  '--dsw-alias-brand-primary': '#f7d78b', '--dsw-alias-brand-text': '#f7d78b',
  '--dsw-alias-state-business-primary': '#bba4ff', '--dsw-focus-ring-color': '#ffcf80',
};
const token = (selector, property, name) => ({ selector, property, token: name });
const surfaceTokens = (stage) => [
  token('.dsh-ds', 'backgroundColor', '--dsw-alias-bg-base'), token('.dsh-ds', 'color', '--dsw-alias-label-primary'),
  ...(stage === 'list' ? [
    token('.ds-table-wrap', 'backgroundColor', '--dsw-alias-bg-layer-1'),
    token('.dsh-ds th', 'backgroundColor', '--dsw-alias-bg-module-platform'),
    token('.ds-source-name .ds-link', 'color', '--dsw-alias-label-primary'),
  ] : stage === 'dialog' ? [
    token('.ds-modal', 'backgroundColor', '--dsw-alias-bg-layer-2'), token('.ds-modal', 'color', '--dsw-alias-label-primary'),
    token('.ds-modal input:not([type=checkbox])', 'backgroundColor', '--dsw-specific-input-major'),
    token('.ds-modal select', 'backgroundColor', '--dsw-specific-input-major'),
    token('.ds-modal select option', 'backgroundColor', '--dsw-specific-input-major'),
    token('.ds-modal select option', 'color', '--dsw-alias-label-primary'),
  ] : [
    token('.ds-card', 'backgroundColor', '--dsw-alias-bg-layer-1'),
    token('.ds-composer textarea', 'backgroundColor', '--dsw-specific-input-major'),
    token('.ds-composer textarea', 'color', '--dsw-alias-label-primary'),
    token('.ds-batch-size', 'backgroundColor', '--dsw-specific-input-major'),
    token('.dsh-ds input[type=checkbox]', 'accentColor', '--dsw-alias-brand-primary'),
    token('.dsh-ds th', 'backgroundColor', '--dsw-alias-bg-module-platform'),
  ]),
];
const primaryTokens = (selector = '.ds-button.primary:not(:disabled)', hover = false) => [
  token(selector, 'backgroundColor', hover ? '--dsw-alias-button-primary-hover' : '--dsw-alias-button-primary-fill'),
  token(selector, 'color', '--dsw-alias-label-primary-foreground'),
];
async function auditTheme(page, result, label, specs, readable, scheme) {
  const audit = await page.evaluate(({ specs, readable }) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (value) => { context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value); };
    const over = (front, back) => { const alpha = front[3] + back[3] * (1 - front[3]); return [...front.slice(0, 3).map((value, index) => alpha ? (value * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0), alpha]; };
    const background = (element) => { const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.unshift(node); return ancestors.reduce((value, node) => over(rgba(getComputedStyle(node).backgroundColor), value), [255, 255, 255, 1]); };
    const luminance = (color) => color.slice(0, 3).map((value) => { const normalized = value / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; }).reduce((value, channel, index) => value + channel * [.2126, .7152, .0722][index], 0);
    const reference = document.createElement('span'); reference.style.position = 'fixed'; reference.style.visibility = 'hidden'; document.body.append(reference);
    const samples = specs.map(({ selector, property, token }) => {
      const element = document.querySelector(selector); if (!element) throw new Error(`Missing theme surface: ${selector}`);
      reference.style.color = token.startsWith('var(') ? token : `var(${token})`;
      const value = getComputedStyle(element)[property];
      return { selector, property, token, actual: rgba(value), expected: rgba(getComputedStyle(reference).color), cssValue: value };
    });
    const contrasts = readable.flatMap((selector) => {
      const elements = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length && !element.closest(':disabled'));
      if (!elements.length) throw new Error(`No visible ordinary text/control to check: ${selector}`);
      return elements.map((element) => { const back = background(element), front = over(rgba(getComputedStyle(element).color), back); const first = luminance(front), second = luminance(back); return { selector, text: (element.value || element.textContent || '').trim().slice(0, 80), foreground: front, background: back, ratio: (Math.max(first, second) + .05) / (Math.min(first, second) + .05) }; });
    });
    reference.remove();
    return { samples, contrasts, darkAttribute: document.body.hasAttribute('data-ds-dark-theme'), colorSchemes: [...document.querySelectorAll('.dsh-ds,.dsh-ds input,.dsh-ds select,.dsh-ds textarea')].map((element) => getComputedStyle(element).colorScheme) };
  }, { specs, readable });
  result.themeAudits ||= []; result.themeAudits.push({ label, ...audit });
  for (const sample of audit.samples) assert.deepEqual(sample.actual, sample.expected, `${label}: ${sample.selector}.${sample.property} must inherit ${sample.token}; got ${sample.cssValue}`);
  for (const sample of audit.contrasts) assert.ok(sample.ratio >= 4.5, `${label}: ${sample.selector} ordinary text contrast ${sample.ratio.toFixed(3)} is below 4.5:1`);
  assert.equal(audit.darkAttribute, scheme === 'dark', `${label}: public body dark selector`);
  assert.ok(audit.colorSchemes.every((value) => value === scheme), `${label}: native controls must inherit ${scheme} color-scheme`);
}
async function auditStatusProse(page, result, scheme, label) {
  const classes = ['ds-notice', 'ds-notice success', 'ds-notice error', 'ds-warning', 'ds-error-text'];
  await page.evaluate((classes) => {
    const probes = document.createElement('div'); probes.id = 'fixture-status-probes'; probes.dataset.fixtureOnly = 'style-coverage';
    for (const className of classes) { const prose = document.createElement('p'); prose.className = className; prose.textContent = '这是一段用于验证状态说明的完整长文字，需在亮色、暗色和自定义主题中清楚可读，状态颜色通过边框和背景呈现。'; probes.append(prose); }
    document.querySelector('.dsh-ds').append(probes);
  }, classes);
  try {
    const selectors = classes.map((_, index) => `#fixture-status-probes>p:nth-child(${index + 1})`);
    await auditTheme(page, result, `${label}-status-prose`, selectors.map((selector) => token(selector, 'color', '--dsw-alias-label-primary')), selectors, scheme);
  } finally { await page.locator('#fixture-status-probes').evaluate((element) => element.remove()); }
}
async function rememberDraft(locator) {
  await locator.focus();
  await locator.evaluate((element) => { element.setSelectionRange(2, 5); window.__themeDraft = { element, root: document.querySelector('.dsh-ds'), value: element.value, start: element.selectionStart, end: element.selectionEnd }; });
}
async function assertDraft(page, label) {
  const actual = await page.evaluate(() => { const draft = window.__themeDraft; return { sameNode: draft.element.isConnected && draft.element === document.activeElement, sameRoot: draft.root === document.querySelector('.dsh-ds'), value: draft.element.value, expected: draft.value, start: draft.element.selectionStart, end: draft.element.selectionEnd, expectedStart: draft.start, expectedEnd: draft.end }; });
  assert.ok(actual.sameNode && actual.sameRoot, `${label}: switching must preserve the mounted root, editor node, and focus`);
  assert.equal(actual.value, actual.expected, `${label}: draft contents`); assert.equal(actual.start, actual.expectedStart, `${label}: selection start`); assert.equal(actual.end, actual.expectedEnd, `${label}: selection end`);
}
async function verifyThemeModes(viewport) {
  for (const initialTheme of ['light', 'dark']) {
    const result = { viewport: `${viewport.width}x${viewport.height}-theme-${initialTheme}`, kind: 'theme', checks: [], screenshots: [], errors: [] }; results.push(result);
    const { context, page, errors } = await setup(viewport, { theme: initialTheme });
    try {
      const primary = page.getByRole('button', { name: '+ 创建数据源连接', exact: true });
      await page.mouse.move(1, 1);
      await auditTheme(page, result, 'initial-list', [...surfaceTokens('list'), ...primaryTokens()], ['.dsh-ds h1', '.ds-source-name .ds-link', '.ds-button.primary:not(:disabled)'], initialTheme);
      await screenshot(page, result, 'list');
      await primary.hover();
      await auditTheme(page, result, 'primary-hover', primaryTokens(undefined, true), ['.ds-button.primary:not(:disabled)'], initialTheme);
      await page.getByTestId('source-row-fixture-mysql').hover();
      await auditTheme(page, result, 'row-hover', [token('.ds-source-row:hover', 'backgroundColor', '--dsw-alias-interactive-bg-hover')], ['.ds-source-row:hover .ds-source-name .ds-link'], initialTheme);
      await page.mouse.move(1, 1); await page.keyboard.press('Tab'); await primary.focus();
      assert.ok(await primary.evaluate((element) => element.matches(':focus-visible')));
      assert.ok(await primary.evaluate((element) => { const style = getComputedStyle(element); return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2; }));
      await auditTheme(page, result, 'keyboard-focus', [token('.ds-button.primary:focus-visible', 'outlineColor', 'var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))')], ['.ds-button.primary:not(:disabled)'], initialTheme);
      check(result, `初始${initialTheme}列表/表头/主按钮与hover/focus按官方变量，普通正文及主按钮对比度≥4.5`);
      if (initialTheme === 'light') {
        await page.evaluate((values) => { window.__fixtureTheme.set('dark'); window.__fixtureTheme.override(values); }, syntheticCustomOverrides);
        await auditTheme(page, result, 'custom-list', [...surfaceTokens('list'), ...primaryTokens(), token('.ds-button.primary:focus-visible', 'outlineColor', '--dsw-focus-ring-color')], ['.dsh-ds h1', '.ds-source-name .ds-link', '.ds-button.primary:not(:disabled)'], 'dark');
        await primary.hover(); await auditTheme(page, result, 'custom-primary-hover', primaryTokens(undefined, true), ['.ds-button.primary:not(:disabled)'], 'dark');
        await page.mouse.move(1, 1); await page.evaluate(() => { window.__fixtureTheme.override(); window.__fixtureTheme.set('light'); });
      }
      await page.getByRole('button', { name: '编辑连接 测试业务库', exact: true }).click();
      const name = page.getByLabel('数据源名称', { exact: true }); await name.fill('主题切换期间保留的连接草稿');
      await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByText('fixture 连接测试成功。', { exact: true }).waitFor();
      await page.mouse.move(1, 1); await rememberDraft(name);
      await auditTheme(page, result, 'initial-dialog', [...surfaceTokens('dialog'), token('.ds-modal input:focus', 'borderTopColor', '--dsw-alias-state-business-primary'), token('.ds-notice.success', 'color', '--dsw-alias-label-primary'), ...primaryTokens('.ds-modal .ds-button.primary')], ['.ds-modal h2', '.ds-modal input:not([type=checkbox])', '.ds-modal select', '.ds-notice.success', '.ds-modal .ds-button.primary'], initialTheme);
      await screenshot(page, result, 'dialog');
      if (initialTheme === 'light') {
        for (const scheme of ['light', 'dark', 'light']) {
          await page.evaluate((scheme) => window.__fixtureTheme.set(scheme), scheme);
          await auditTheme(page, result, `runtime-dialog-${scheme}`, surfaceTokens('dialog'), ['.ds-modal input:not([type=checkbox])', '.ds-modal .ds-button.primary'], scheme); await assertDraft(page, `dialog-${scheme}`);
        }
        await page.evaluate((values) => { window.__fixtureTheme.set('dark'); window.__fixtureTheme.override(values); }, syntheticCustomOverrides);
        await auditTheme(page, result, 'custom-dialog', [...surfaceTokens('dialog'), ...primaryTokens('.ds-modal .ds-button.primary')], ['.ds-modal h2', '.ds-modal input:not([type=checkbox])', '.ds-notice.success', '.ds-modal .ds-button.primary'], 'dark'); await assertDraft(page, 'custom-dialog');
        await page.evaluate(() => { window.__fixtureTheme.override(); window.__fixtureTheme.set('light'); }); await assertDraft(page, 'restored-dialog');
      }
      await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      check(result, `初始${initialTheme}弹框/原生input、select/option与成功说明，动态切换保留连接草稿`);
      await page.getByRole('button', { name: '测试业务库', exact: true }).click(); await page.getByRole('heading', { name: '输入几个问题', exact: true }).waitFor();
      const editor = page.getByLabel('原问题，每行一个', { exact: true }); await editor.fill('主题切换时保留这一行未提交的问题。\n还有第二行输入草稿。'); await rememberDraft(editor);
      await auditTheme(page, result, 'initial-questions', [...surfaceTokens('questions'), ...primaryTokens()], ['.ds-card h2', '.ds-question-text', '.ds-composer textarea', '.ds-button.primary:not(:disabled)'], initialTheme);
      await auditStatusProse(page, result, initialTheme, 'initial'); await screenshot(page, result, 'questions');
      if (initialTheme === 'light') {
        for (const scheme of ['light', 'dark', 'light']) {
          await page.evaluate((scheme) => window.__fixtureTheme.set(scheme), scheme);
          await auditTheme(page, result, `runtime-questions-${scheme}`, [...surfaceTokens('questions'), ...primaryTokens()], ['.ds-card h2', '.ds-question-text', '.ds-composer textarea', '.ds-button.primary:not(:disabled)'], scheme);
          await auditStatusProse(page, result, scheme, 'runtime'); await assertDraft(page, `questions-${scheme}`);
        }
        await page.evaluate((values) => { window.__fixtureTheme.set('dark'); window.__fixtureTheme.override(values); }, syntheticCustomOverrides);
        await auditTheme(page, result, 'custom-questions', [...surfaceTokens('questions'), ...primaryTokens()], ['.ds-card h2', '.ds-question-text', '.ds-composer textarea', '.ds-button.primary:not(:disabled)'], 'dark');
        await auditStatusProse(page, result, 'dark', 'custom'); await assertDraft(page, 'custom-questions'); await screenshot(page, result, 'custom-questions');
        await page.evaluate(() => { window.__fixtureTheme.override(); window.__fixtureTheme.set('light'); }); await assertDraft(page, 'restored-questions');
        await auditTheme(page, result, 'restored-questions', surfaceTokens('questions'), ['.ds-composer textarea', '.ds-question-text'], 'light');
        assert.equal((await calls(page, 'organize')).length, 0, 'Theme changes must not submit the draft');
        check(result, '运行时light→dark→light与body自定义token/清除覆写，无重挂载，保留两类草稿、焦点与选区');
      }
      assert.deepEqual(errors, []); result.status = 'passed';
      check(result, `初始${initialTheme}卡片/问题表格/textarea/checkbox与各类状态长文字使用label-primary且对比度≥4.5`);
    } catch (error) { result.status = 'failed'; result.error = error.stack; result.errors = errors; await screenshot(page, result, 'failure').catch(() => {}); throw error; }
    finally { await context.close(); }
  }
}
async function verifyDesktop(viewport) {
  const result = { viewport: `${viewport.width}x${viewport.height}`, checks: [], screenshots: [], errors: [] }; results.push(result);
  await verifyEmpty(viewport, result);
  const { context, page, errors } = await setup(viewport);
  try {
    const registration = await page.evaluate(() => ({ id: window.__fixture.loaderId, ...window.__fixture.plugin, slots: window.__fixture.registered }));
    assert.equal(registration.id, 'dsh-sql'); assert.equal(registration.name, 'sql');
    assert.deepEqual(registration.inject, ['slots', 'layout']);
    assert.ok(registration.slots.some((slot) => slot.name === 'main' && slot.key === 'datasources'));
    assert.ok(registration.slots.some((slot) => slot.name === 'sidebar.panellist' && slot.id === 'datasources' && slot.order === 5));
    await page.getByTestId('source-row-fixture-mysql').waitFor();
    await screenshot(page, result, 'list');
    await page.getByRole('button', { name: '编辑连接 测试业务库', exact: true }).click();
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
    await page.getByLabel('数据源名称', { exact: true }).fill('测试业务库（已编辑）');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.getByText('fixture 连接测试成功。', { exact: true }).waitFor();
    await screenshot(page, result, 'connection');
    await page.getByRole('button', { name: '保存连接', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    let saved = await page.evaluate(() => window.__fixture.calls.filter((call) => call.operation === 'save').at(-1).payload);
    assert.equal(saved.password, ''); assert.equal(saved.clearPassword, false); assert.equal(saved.port, 3306); assert.equal(saved.user, 'fixture_user');
    await page.getByRole('button', { name: '编辑连接 测试业务库（已编辑）', exact: true }).click();
    await page.getByLabel('清除已保存的密码', { exact: true }).check();
    await page.getByRole('button', { name: '保存连接', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    saved = await page.evaluate(() => window.__fixture.calls.filter((call) => call.operation === 'save').at(-1).payload); assert.equal(saved.clearPassword, true);
    assert.equal(await page.getByTestId('datasource-detail').count(), 0);
    await page.getByRole('button', { name: '+ 创建数据源连接', exact: true }).click();
    assert.equal(await page.getByLabel('数据源类型', { exact: true }).inputValue(), 'mysql');
    await page.getByLabel('数据源类型', { exact: true }).selectOption('postgres'); assert.equal(await page.getByLabel('端口', { exact: true }).inputValue(), '5432');
    await page.getByLabel('数据源类型', { exact: true }).selectOption('sqlite');
    await page.getByLabel('数据源名称', { exact: true }).fill('新增测试库'); await page.getByLabel('数据库文件路径', { exact: true }).fill('D:/fixture/new.sqlite');
    await page.getByRole('button', { name: '保存连接', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    saved = await page.evaluate(() => window.__fixture.calls.filter((call) => call.operation === 'save').at(-1).payload); assert.equal(saved.engine, 'sqlite'); assert.equal(saved.host, undefined); assert.equal(saved.password, undefined);
    await page.getByRole('button', { name: '删除连接 新增测试库', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click(); assert.ok(await page.getByRole('button', { name: '新增测试库', exact: true }).isVisible());
    await page.getByRole('button', { name: '删除连接 新增测试库', exact: true }).click(); await page.getByRole('button', { name: '删除连接', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' }); assert.equal(await page.getByRole('button', { name: '新增测试库', exact: true }).count(), 0);
    check(result, '连接测试、密码留空保留/明确清除、引擎切换、创建与删除；操作不误入详情');

    const originalHash = await page.evaluate(() => location.hash);
    await page.getByTestId('source-row-fixture-mysql').locator('td').nth(1).click();
    await page.getByRole('heading', { name: '输入几个问题', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: /^问题/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: '‹ 返回数据源列表', exact: true }).click();
    await page.getByRole('button', { name: '测试业务库（已编辑）', exact: true }).click();
    await page.getByRole('heading', { name: '输入几个问题', exact: true }).waitFor(); assert.equal(await page.evaluate(() => location.hash), originalHash);
    await page.getByLabel('原问题，每行一个', { exact: true }).fill('新增原问题一\n新增原问题二');
    await page.getByLabel('执行工作区', { exact: true }).fill('relative-workspace');
    await page.getByRole('button', { name: '整理问题', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '执行工作区请填写绝对路径。' }).waitFor();
    assert.equal((await calls(page, 'organize')).length, 0);
    await page.getByLabel('执行工作区', { exact: true }).fill('D:/fixture/selected-workspace');
    await page.getByLabel('原问题，每行一个', { exact: true }).fill('新增原问题一\n新增原问题二');
    await page.getByRole('button', { name: '整理问题', exact: true }).click();
    await page.getByRole('heading', { name: '任务进度', exact: true }).waitFor();
    const organized = (await calls(page, 'organize')).at(-1); assert.equal(organized.text, '新增原问题一\n新增原问题二'); assert.equal(organized.cwd, 'D:/fixture/selected-workspace');
    await page.getByRole('button', { name: '查看第1批会话', exact: true }).click(); assert.equal((await page.evaluate(() => window.__fixture.sessions)).length, 1);
    await page.evaluate(() => { window.__fixture.noWorkspace = true; }); await page.getByRole('button', { name: '查看第1批会话', exact: true }).click();
    await page.getByText(/会话 ID：fixture-session/).first().waitFor();
    await settlePoll(page, () => window.__fixture.completeQuestions());
    await page.getByText('新增原问题一', { exact: true }).first().waitFor();
    assert.equal((await calls(page, 'analyze')).length, 0);
    check(result, '整行和名称点击进入问题页、返回、无hash导航、多行整理、任务回填与会话入口');

    await page.getByRole('button', { name: '编辑问题1', exact: true }).click();
    const editor = page.getByLabel('问题正文', { exact: true }); await editor.fill('编辑后的完整问题，轮询期间保留。');
    await settlePoll(page, () => window.__fixture.bump()); assert.equal(await editor.inputValue(), '编辑后的完整问题，轮询期间保留。');
    assert.ok(await editor.evaluate((element) => document.activeElement === element));
    await page.evaluate(() => { window.__fixture.failNextAction = 'save-questions'; });
    await page.getByRole('button', { name: '保存清单', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '未保存的修改仍保留' }).waitFor();
    assert.equal(await editor.inputValue(), '编辑后的完整问题，轮询期间保留。');
    await page.getByRole('button', { name: '保存清单', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '手动添加问题', exact: true }).click(); await editor.fill('手动添加并选择的问题。');
    await page.getByRole('button', { name: '完成编辑', exact: true }).click(); await page.getByRole('checkbox', { name: '选择问题：手动添加并选择的问题。', exact: true }).check();
    await page.getByRole('button', { name: '保存清单', exact: true }).click();
    await wait(page, () => window.__fixture.states['fixture-mysql'].questions.length === 15);
    await page.getByLabel('每批问题数', { exact: true }).selectOption('5');
    await page.getByRole('button', { name: '预览分析批次', exact: true }).click();
    const preview = page.getByTestId('analysis-preview'); await preview.waitFor();
    assert.equal(await preview.locator('li').count(), 13); assert.equal(await preview.locator('.ds-preview-batch').count(), 3);
    const firstSelection = page.getByRole('checkbox', { name: /^选择问题：/ }).first();
    await firstSelection.uncheck(); assert.equal(await preview.count(), 0);
    await firstSelection.check(); await page.getByRole('button', { name: '保存清单', exact: true }).click();
    await page.getByRole('button', { name: '预览分析批次', exact: true }).click(); await preview.waitFor();
    const expected = await page.evaluate(() => window.__fixture.states['fixture-mysql'].questions.filter((question) => question.selected).map((question) => question.text));
    assert.deepEqual(await preview.locator('li').allTextContents(), expected); assert.equal((await calls(page, 'analyze')).length, 0);
    await screenshot(page, result, 'questions');
    check(result, '问题编辑/手动添加/选择保存，轮询保留焦点和草稿，409回读重试，13条完整快照3批且预览不执行，选项变化废弃预览');

    await page.getByRole('button', { name: '开始分析（共 3 批）', exact: true }).click();
    await wait(page, () => window.__fixture.states['fixture-mysql'].runs.some((run) => run.kind === 'range'));
    const analyzed = (await calls(page, 'analyze')).at(-1); assert.equal(analyzed.batchSize, 5); assert.equal(analyzed.cwd, 'D:/fixture/selected-workspace');
    await page.getByRole('button', { name: '取消分析范围任务', exact: true }).waitFor();
    await screenshot(page, result, 'tasks');
    await settlePoll(page, () => window.__fixture.finishRange(true));
    await page.getByRole('button', { name: '重试第2批', exact: true }).waitFor();
    await page.getByRole('button', { name: '重试第2批', exact: true }).click();
    assert.equal((await calls(page, 'retry')).length, 1);
    await settlePoll(page, () => window.__fixture.finishRange(false));
    await tab(page, '数据表'); await page.getByRole('heading', { name: '数据表范围', exact: true }).waitFor();
    await page.locator('.ds-table-card').filter({ hasText: 'orders' }).locator('summary').click();
    const note = page.getByRole('checkbox', { name: '选择字段 orders.note', exact: true }); await note.uncheck();
    await settlePoll(page, () => window.__fixture.bump()); assert.equal(await note.isChecked(), false);
    await page.getByRole('button', { name: '保存表与字段', exact: true }).click();
    await wait(page, () => !window.__fixture.states['fixture-mysql'].tables[0].fields.find((field) => field.name === 'note').selected);
    const tablePayload = (await calls(page, 'save-tables')).at(-1); assert.equal(tablePayload.tables[0].fields[2].name, 'note'); assert.equal(tablePayload.tables[0].fields[2].type, 'TEXT');
    await screenshot(page, result, 'tables');
    check(result, '真实队列/进度回填、失败批次重试、表和字段选择保存且轮询保留草稿');

    await tab(page, '关联关系');
    await page.getByRole('checkbox', { name: '选择关系1', exact: true }).check();
    await page.getByLabel('左侧字段 relation-orders-customer', { exact: true }).selectOption('id');
    await page.getByLabel('关系类型 relation-orders-customer', { exact: true }).selectOption('many-to-many');
    const description = page.getByLabel('关系说明 relation-orders-customer', { exact: true }); await description.fill('用户核对后的关系说明。');
    await settlePoll(page, () => window.__fixture.bump()); assert.equal(await description.inputValue(), '用户核对后的关系说明。');
    await page.getByRole('button', { name: '保存关系修改', exact: true }).click();
    await page.getByText('来源待复核', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认关联关系', exact: true }).isDisabled(), true);
    const relationPayload = (await calls(page, 'save-relations')).at(-1).relations[0]; assert.equal(relationPayload.leftTable, 'table-orders'); assert.equal(relationPayload.rightTable, 'table-customers'); assert.equal(relationPayload.type, 'many-to-many');
    await tab(page, '数据表'); assert.equal(await page.getByRole('button', { name: '确认表范围', exact: true }).isDisabled(), false);
    await page.getByRole('button', { name: '确认表范围', exact: true }).click();
    await page.getByText('本轮表范围已确认', { exact: true }).waitFor();
    await tab(page, '关联关系');
    await page.getByRole('button', { name: '确认本轮问题依据', exact: true }).click();
    await page.getByText('已复核本轮问题依据，表和字段修改已保留。', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('左侧字段 relation-orders-customer', { exact: true }).inputValue(), 'id');
    assert.equal(await page.getByLabel('关系类型 relation-orders-customer', { exact: true }).inputValue(), 'many-to-many'); assert.equal(await description.inputValue(), '用户核对后的关系说明。');
    await page.getByRole('button', { name: '确认关联关系', exact: true }).click(); await page.getByText('本轮关联关系已确认', { exact: true }).waitFor();
    await screenshot(page, result, 'relations');
    check(result, '关系按表ID/字段/基数编辑，勾选触发待复核并阻止确认，复核保留编辑，两阶段确认完成');

    await tab(page, '问题'); await page.getByLabel('执行工作区', { exact: true }).fill('');
    await page.getByRole('button', { name: '预览分析批次', exact: true }).click(); await page.getByRole('button', { name: '开始分析（共 3 批）', exact: true }).click();
    const defaultRun = (await calls(page, 'analyze')).at(-1); assert.equal(Object.hasOwn(defaultRun, 'cwd'), false);
    await page.getByRole('button', { name: '取消分析范围任务', exact: true }).click();
    await wait(page, () => [...window.__fixture.states['fixture-mysql'].runs].reverse().find((run) => run.kind === 'range').status === 'canceled');
    await settlePoll(page, () => { const run = [...window.__fixture.states['fixture-mysql'].runs].reverse().find((item) => item.kind === 'range'); run.batches[1].status = 'queued'; window.__fixture.bump(); });
    assert.equal(await page.getByRole('button', { name: '预览分析批次', exact: true }).isEnabled(), true);
    check(result, '正在执行的分析可取消，取消状态来自服务端，终态遗留排队批次不锁住新分析');
    await page.getByRole('button', { name: '‹ 返回数据源列表', exact: true }).click();
    await page.evaluate(() => { window.__fixture.delayNextState = true; });
    await page.getByRole('button', { name: '测试业务库（已编辑）', exact: true }).click();
    await page.getByTestId('datasource-detail').waitFor();
    await page.getByRole('button', { name: '‹ 返回数据源列表', exact: true }).click();
    await page.getByRole('button', { name: '测试本地库', exact: true }).click();
    await page.getByRole('heading', { name: '输入几个问题', exact: true }).waitFor();
    assert.equal(await page.getByTestId('datasource-detail').getAttribute('data-source-id'), 'fixture-sqlite');
    assert.ok(await page.evaluate(() => window.__fixture.aborted > 0));
    const overflow = await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth, page: document.querySelector('.dsh-ds').scrollWidth > document.querySelector('.dsh-ds').clientWidth + 1 }));
    assert.deepEqual(overflow, { document: false, page: false });
    const sensitiveNetwork = await page.evaluate(() => window.__fixture.calls.every((call) => call.credentials === 'same-origin' && call.cache === 'no-store'));
    assert.equal(sensitiveNetwork, true); assert.equal(await page.evaluate(() => location.hash), originalHash);
    assert.deepEqual(errors, []); check(result, '切换来源中止旧请求且无串页、无横向溢出、无浏览器错误、认证和缓存策略保留');
    result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; result.errors = errors; await screenshot(page, result, 'failure').catch(() => {}); throw error; }
  finally { await context.close(); }
}
async function verifySandbox() {
  const result = { viewport: '1366x768-sandbox', checks: [], screenshots: [] }; results.push(result);
  const { context, page, errors } = await setup({ width: 1366, height: 768 });
  try {
    const inline = (text) => `<script>${text.replace(/<\/script/gi, '<\\/script')}</script>`;
    const content = html.replace('<script src="/host-theme.js"></script>', () => inline(hostThemeScript)).replace('<script src="/vendor.js"></script>', () => inline(`${react}\n;${reactDom}`)).replace('<script src="/fixture.js"></script>', () => inline(fixture)).replace('<script src="/client.js"></script>', () => inline(client));
    await page.evaluate((source) => {
      const frame = document.createElement('iframe'); frame.id = 'sandbox-client'; frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'; frame.src = URL.createObjectURL(new Blob([source], { type: 'text/html' }));
      document.body.replaceChildren(frame);
    }, content);
    const frame = page.frameLocator('#sandbox-client'); await frame.getByTestId('source-row-fixture-mysql').waitFor();
    const host = await page.locator('#sandbox-client').elementHandle(), child = await host.contentFrame();
    const originalUrl = child.url(); assert.ok(originalUrl.startsWith('blob:')); assert.equal(await child.evaluate(() => window.origin), 'null');
    await frame.getByTestId('source-row-fixture-mysql').click(); await frame.getByRole('heading', { name: '输入几个问题', exact: true }).waitFor();
    await frame.getByRole('tab', { name: /^数据表/ }).click(); await frame.getByRole('heading', { name: '数据表范围', exact: true }).waitFor();
    await frame.getByRole('tab', { name: /^关联关系/ }).click(); await frame.getByRole('heading', { name: '关联关系', exact: true }).waitFor();
    await frame.getByRole('button', { name: '‹ 返回数据源列表', exact: true }).click();
    const row = frame.getByTestId('source-row-fixture-mysql'); await row.focus(); await row.press('Enter'); await frame.getByTestId('datasource-detail').waitFor();
    await frame.getByRole('button', { name: '‹ 返回数据源列表', exact: true }).click(); await row.focus(); await row.press('Space'); await frame.getByTestId('datasource-detail').waitFor();
    assert.equal(child.url(), originalUrl); assert.deepEqual(errors, []);
    const filename = '1366x768-sandbox-navigation.png'; await page.screenshot({ path: path.join(output, filename) }); result.screenshots.push(filename);
    check(result, '无同源权限的blob沙箱可点击整行、切换页签、返回，并支持Enter和Space，URL不变且无导航异常'); result.status = 'passed';
  } catch (error) { result.status = 'failed'; result.error = error.stack; result.errors = errors; await page.screenshot({ path: path.join(output, 'sandbox-failure.png') }).catch(() => {}); throw error; }
  finally { await context.close(); }
}
try {
  verifyCssContract();
  const viewports = [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }];
  for (const viewport of viewports) await verifyDesktop(viewport);
  await verifySandbox();
  for (const viewport of viewports) await verifyThemeModes(viewport);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { await browser.close(); await writeFile(path.join(output, 'browser-report.json'), `${JSON.stringify({ reactVersion: '18.3.1', clientPath, clientSha256: createHash('sha256').update(client).digest('hex'), fixtureOnly: true, authenticatedHostPageObserved: false, guiServerStarted: false, themeFixture: { path: path.join(directory, 'host-theme.json'), sha256: createHash('sha256').update(themeText).digest('hex'), package: hostTheme.package, sources: hostTheme.sources }, interactionChecksPassed: results.filter((result) => !result.kind).reduce((total, result) => total + result.checks.length, 0), checksPassed: results.reduce((total, result) => total + result.checks.length, 0), results }, null, 2)}\n`, 'utf8'); console.log(`Browser evidence: ${output}`); }
