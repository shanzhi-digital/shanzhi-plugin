import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

// Opt-in browser verification with request routing and a synthetic API fixture.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright');
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.env.DSH_CLIENT_TEST_OUTPUT || path.join(os.tmpdir(), 'dsh-datasource-client-test'));
const clientPath = path.resolve(process.env.DSH_CLIENT_UNDER_TEST || path.join(directory, '../../client.js'));
await mkdir(output, { recursive: true });
const vendorFile = async (name, override) => {
  if (override) return readFile(override, 'utf8');
  const filename = path.join(output, `${name}-18.3.1.development.js`);
  try { const cached = await readFile(filename, 'utf8'); if (cached.length > 1000) return cached; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(`https://registry.npmjs.org/${name}/-/${name}-18.3.1.tgz`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Cannot load pinned fixture dependency ${name}: ${response.status}`);
  const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
  for (let offset = 0; offset + 512 <= archive.length;) {
    const entry = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
    if (!Number.isFinite(size)) throw new Error(`Invalid fixture archive: ${name}`);
    if (entry === `package/umd/${name}.development.js`) { const text = archive.subarray(offset + 512, offset + 512 + size).toString(); await writeFile(filename, text, 'utf8'); return text; }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Pinned React fixture module missing: ${name}`);
};
const [react, reactDom, html, fixture, client, theme] = await Promise.all([
  vendorFile('react', process.env.DSH_REACT_UMD), vendorFile('react-dom', process.env.DSH_REACTDOM_UMD),
  readFile(path.join(directory, 'fixture.html'), 'utf8'), readFile(path.join(directory, 'fixture.js'), 'utf8'),
  readFile(clientPath, 'utf8'), readFile(path.join(directory, 'host-theme.json'), 'utf8'),
]);
const themeScript = `(${((tokens) => {
  const style = document.createElement('style');
  const declarations = (index) => Object.entries(tokens).map(([name, values]) => `${name}:${values[index]}`).join(';');
  style.textContent = `body{${declarations(0)}}body[data-ds-dark-theme]{${declarations(1)}}`;
  document.head.append(style);
  window.__fixtureTheme = { set(scheme) { document.documentElement.style.colorScheme = scheme; document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark'); } };
}).toString()})(${JSON.stringify(JSON.parse(theme).tokens)});`;
const browser = await chromium.launch({ headless: true, ...(process.env.DSH_CHROME ? { executablePath: process.env.DSH_CHROME } : {}), args: ['--no-first-run', '--no-default-browser-check'] });
const results = [];
const calls = (page, action) => page.evaluate((name) => window.__fixture.calls.filter((call) => call.payload.action === name || call.operation === name).map((call) => call.payload), action);
const btn = (parent, name) => parent.getByRole('button', { name, exact: true });
const checkbox = (parent, name) => parent.getByRole('checkbox', { name, exact: true });
async function setup(viewport, options = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN' });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('http://fixture.dsh.test/**', (route) => {
    const files = { '/': ['text/html', html], '/host-theme.js': ['text/javascript', themeScript], '/vendor.js': ['text/javascript', `${react}\n;${reactDom}`], '/fixture.js': ['text/javascript', fixture], '/client.js': ['text/javascript', client] };
    const file = files[new URL(route.request().url()).pathname];
    return route.fulfill({ status: file ? 200 : 204, contentType: file?.[0] || 'text/plain', body: file?.[1] || '' });
  });
  await page.addInitScript(({ empty, unconfigured }) => { window.__fixtureEmpty = !!empty; window.__fixtureUnconfigured = !!unconfigured; }, options);
  await page.goto('http://fixture.dsh.test/');
  await page.getByTestId('source-table').waitFor();
  return { context, page, errors };
}

async function verify(viewport) {
  const { context, page, errors } = await setup(viewport);
  const screenshots = [];
  const screenshot = async (label) => {
    const file = path.join(output, `v4-${viewport.width}x${viewport.height}-${label}.png`);
    await page.screenshot({ path: file });
    screenshots.push(file);
  };
  const sourceTable = page.getByTestId('source-table');
  const catalog = page.getByTestId('catalog-table');
  try {
    await page.getByTestId('source-connection-status-fixture-mysql').getByText('正常', { exact: true }).waitFor();
    assert.equal(await sourceTable.locator('tbody tr').count(), 10);
    await screenshot('sources');
    await btn(page, '下一页').click();
    assert.equal(await sourceTable.locator('tbody tr').count(), 3);
    await page.getByLabel('筛选连接状态').selectOption('disabled');
    await page.getByLabel('搜索数据源名称').fill('测试');
    assert.equal(await sourceTable.locator('tbody tr').count(), 1);
    await checkbox(sourceTable, '选择数据源 测试本地库').check();
    await btn(page, '批量启用').click();
    await sourceTable.getByText('没有匹配的数据源').waitFor();
    await page.getByLabel('筛选连接状态').selectOption('');
    await page.getByLabel('搜索数据源名称').fill('');
    await btn(page, '测试业务库').click();
    await catalog.waitFor();
    assert.equal((await calls(page, 'ensure-scan'))[0].open, true);
    assert.equal(await catalog.locator('tbody tr').count(), 10);
    await page.getByLabel('搜索表名或原始注释').fill('历史归档');
    await checkbox(catalog, '全选当前筛选数据表').check();
    await btn(page, '下一页').click();
    assert.equal(await checkbox(catalog, '选择数据表 archive_11').isChecked(), true);
    assert.equal((await calls(page, 'set-tables')).length, 0);
    await btn(page, '清除所有勾选').click();
    await page.getByLabel('搜索表名或原始注释').fill('');
    await btn(catalog, 'orders').click();
    const field = page.getByTestId('field-detail-dialog');
    assert.equal((await calls(page, 'flow-samples')).length, 0);
    await field.getByText('订单备注', { exact: true }).waitFor();
    await btn(field, '加载样例').click();
    await field.getByText('真实样例订单', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await btn(catalog, 'orders').evaluate((node) => node === document.activeElement), true);
    await page.getByRole('switch', { name: '启用 orders', exact: true }).click();
    await btn(page, '时效检测').click();
    await page.getByLabel('筛选时效').selectOption('30');
    await catalog.getByText('updated_at', { exact: true }).waitFor();
    assert.equal(await catalog.locator('tbody tr').count(), 1);
    await page.getByLabel('筛选时效').selectOption('');
    await page.evaluate(() => window.__fixture.added.push('new_orders'));
    await btn(page, '刷新目录').click();
    await page.getByText('发现 1 张新表', { exact: false }).waitFor();
    await btn(catalog, 'new_orders').waitFor();
    assert.equal(await catalog.locator('tbody tr').count(), 1);
    await btn(page, '返回全部表').click();
    await screenshot('catalog');

    await btn(page, 'AI 辅助选表').click();
    const basis = page.getByTestId('ai-selection-dialog');
    const columns = basis.locator('.ds-basis');
    const tracks = await columns.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
    assert.equal(tracks, viewport.width < 650 ? 1 : 2);
    await btn(basis, '查看问题').click();
    const questionList = page.getByTestId('questions-dialog');
    await btn(questionList, '下一页').click();
    await checkbox(questionList, '参考问题 测试问题 11').uncheck();
    await btn(questionList, '新增问题').click();
    const question = page.getByTestId('question-dialog');
    const questionInput = question.getByLabel('问题', { exact: true });
    await questionInput.fill('新增业务问题');
    await question.getByLabel('答案（选填）', { exact: true }).fill('业务口径');
    const lightBg = await question.evaluate((node) => getComputedStyle(node).backgroundColor);
    await page.evaluate(() => window.__fixtureTheme.set('dark'));
    assert.notEqual(await question.evaluate((node) => getComputedStyle(node).backgroundColor), lightBg);
    assert.equal(await questionInput.inputValue(), '新增业务问题');
    await btn(question, '保存').click();
    await question.waitFor({ state: 'hidden' });
    await questionList.getByLabel('搜索问题或答案', { exact: true }).fill('业务口径');
    await questionList.getByText('新增业务问题', { exact: true }).waitFor();
    assert.equal((await calls(page, 'suggest')).length, 0);
    await questionList.getByLabel('搜索问题或答案', { exact: true }).fill('测试问题 01');
    await btn(questionList, '泛化问题').click();
    const originalQuestions = page.getByTestId('original-questions-dialog');
    assert.equal(await btn(originalQuestions, '开始泛化').isDisabled(), true);
    await checkbox(originalQuestions, '泛化参考 测试问题 01').check();
    await btn(originalQuestions, '开始泛化').click();
    const questionDraft = page.getByTestId('question-draft-dialog');
    assert.equal((await calls(page, 'questions-save')).length, 1);
    assert.deepEqual(await page.evaluate(() => ({ ...window.__fixture.aiResults.find(({ action }) => action === 'generalize-question').reply })),
      { ok: true, originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false });
    assert.equal(await page.evaluate(() => window.__fixture.questions[0].links[0].tableId), 'table-orders');
    await basis.getByText('可复用关联 1 个，已分析无关联 0 个，待分析 11 个', { exact: true }).waitFor();
    await checkbox(questionDraft, '全选泛化候选').uncheck();
    await checkbox(questionDraft, '选择泛化候选 1').check();
    await questionDraft.getByLabel('泛化候选 1', { exact: true }).fill('编辑后的泛化问题');
    await btn(questionDraft, '保存所选').click();
    await questionDraft.waitFor({ state: 'hidden' });
    await questionList.getByLabel('搜索问题或答案', { exact: true }).fill('编辑后的泛化问题');
    assert.equal(await checkbox(questionList, '参考问题 编辑后的泛化问题').isChecked(), true);
    await btn(questionList, '完成').click();
    await btn(basis, '识别业务域').click();
    assert.equal(await checkbox(basis, '全选业务域').isChecked(), false);
    await checkbox(basis, '全选业务域').check();
    assert.equal(await checkbox(basis, '参考业务域 客户业务').isChecked(), true);
    await checkbox(basis, '参考业务域 客户业务').uncheck();
    assert.equal(await checkbox(basis, '全选业务域').evaluate((node) => node.indeterminate), true);
    await screenshot('basis-dark');
    await btn(basis, 'AI 选表').click();
    const recommendation = page.getByTestId('recommendation-dialog');
    assert.equal(await checkbox(recommendation, '确认启用 orders').isChecked(), true);
    assert.equal(await checkbox(recommendation, '确认启用 customers').isChecked(), true);
    assert.equal(await recommendation.getByRole('navigation', { name: '分页' }).count(), 0);
    assert.equal(await recommendation.locator('tbody tr').count(), 24);
    await recommendation.getByText('匹配业务域：订单业务', { exact: true }).waitFor();
    await recommendation.getByLabel('搜索推荐范围').fill('历史归档');
    await checkbox(recommendation, '全选当前筛选推荐表').check();
    assert.equal(await checkbox(recommendation, '确认启用 archive_20').isChecked(), true);
    await checkbox(recommendation, '全选当前筛选推荐表').uncheck();
    await recommendation.getByLabel('搜索推荐范围').fill('');
    assert.equal(await checkbox(recommendation, '确认启用 customers').isChecked(), true);
    const scroll = await recommendation.locator('.ds-table-wrap').evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    assert.ok(scroll.scroll > scroll.client);
    const [suggestion] = await calls(page, 'suggest');
    assert.equal(suggestion.questionIds.includes('q11'), false);
    assert.deepEqual(suggestion.domains, ['订单业务']);
    await btn(recommendation, '取消').click();
    await recommendation.waitFor({ state: 'hidden' });
    assert.equal((await calls(page, 'confirm-selection')).length, 0);
    assert.equal(await page.getByRole('switch', { name: '启用 orders', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('switch', { name: '启用 customers', exact: true }).getAttribute('aria-checked'), 'false');
    await btn(page, 'AI 辅助选表').click();
    await btn(basis, 'AI 选表').click();
    await checkbox(recommendation, '确认启用 orders').uncheck();
    await screenshot('recommendations-dark');
    await btn(recommendation, '确认启用状态').click();
    await recommendation.waitFor({ state: 'hidden' });
    assert.deepEqual((await calls(page, 'confirm-selection'))[0].selectedTableIds, ['table-customers']);
    assert.deepEqual(errors, []);
    results.push({ viewport, screenshots });
  } finally { await context.close(); }
}

async function verifyManagement() {
  const { context, page, errors } = await setup({ width: 1120, height: 780 }, { empty: true, unconfigured: true });
  try {
    assert.equal((await calls(page, 'list')).length, 0);
    await btn(page, '新建数据源').click();
    const management = page.getByTestId('management-modal');
    await management.getByLabel('管理库密码', { exact: true }).fill('fixture-management-password');
    await btn(management, '保存管理库设置').click();
    const connection = page.getByTestId('connection-modal');
    await connection.getByLabel('数据源名称', { exact: true }).fill('新增测试库');
    await connection.getByLabel('数据源类型', { exact: true }).selectOption('sqlite');
    await connection.getByLabel('数据库文件路径', { exact: true }).fill('D:/fixture/readonly.sqlite');
    await btn(connection, '测试连接').click();
    await connection.getByText('连接成功。', { exact: true }).waitFor();
    await btn(connection, '保存').click();
    await btn(page, '新增测试库').waitFor();
    await page.getByTestId('source-row-fixture-created-1').getByRole('cell', { name: '23', exact: true }).waitFor();
    assert.equal((await calls(page, 'list')).length, 1);
    await btn(page, '更多 新增测试库').click();
    await btn(page, '删除 新增测试库').click();
    await btn(page.getByRole('dialog', { name: '删除数据源' }), '删除').click();
    await page.getByText('还没有数据源', { exact: true }).waitFor();
    assert.equal((await calls(page, 'remove'))[0].revision, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

try {
  await verify({ width: 1366, height: 768 });
  await verify({ width: 475, height: 820 });
  await verifyManagement();
  const report = { client: clientPath, sha256: createHash('sha256').update(client).digest('hex'), results, management: 'passed' };
  await writeFile(path.join(output, 'v4-browser-report.json'), JSON.stringify(report, null, 2));
  console.log(`Browser fixture passed in ${results.length} viewports. Report: ${path.join(output, 'v4-browser-report.json')}`);
} finally { await browser.close(); }
