import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

// Optional, explicit browser check: set ANNOTATION_BROWSER_TOOLS to a temporary
// directory containing react@18, react-dom@18 and playwright-core. No app server.
export async function runBrowserCheck({ tools = process.env.ANNOTATION_BROWSER_TOOLS, executablePath = process.env.ANNOTATION_BROWSER_EXECUTABLE } = {}) {
  if (!tools) throw new Error('Set ANNOTATION_BROWSER_TOOLS to the temporary browser dependency directory.');
  const require = createRequire(join(resolve(tools), 'package.json'));
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: executablePath || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  const annotation = (text, confirmed = false) => ({ text, status: text ? confirmed ? 'confirmed' : 'pending' : 'missing' });
  const tables = [
    { id: 'orders', name: 'orders', schema: 'demo', annotation: annotation('订单', true), fields: [{ name: 'unused', enabled: true, annotation: annotation('未关联', true) }, { name: 'id', enabled: true, annotation: annotation('编号', true) }, { name: 'customer_id', enabled: true, annotation: annotation('客户编号', true) }] },
    { id: 'customers', name: 'customers', schema: 'demo', annotation: annotation('客户'), fields: [{ name: 'id', enabled: true, annotation: annotation('编号') }, { name: 'tenant_id', enabled: true, annotation: annotation('租户') }] },
    { id: 'empty', name: 'empty', schema: 'demo', annotation: annotation(''), fields: [] },
  ];
  let revision = 1, saved = false, aiRuns = 0, failNextCanvasSave = false, holdNextCanvasSave = false;
  let releaseCanvasSave;
  const invalidCanvas = { id: 'broken', name: '待修复', description: '', content: { nodes: [{ tableId: 'gone', label: '已删除表' }, { tableId: 'orders', label: 'orders' }], edges: [{ id: 'old-edge', fromTableId: 'gone', toTableId: 'orders', pairs: [{ fromField: 'gone_id', toField: 'id' }], cardinality: 'N:1' }] }, layout: { gone: { x: 50, y: 50 }, orders: { x: 400, y: 50 } }, confirmed: false, valid: false, invalid: [{ kind: 'table', tableId: 'gone', reason: 'missing' }], validationErrors: [], status: 'partial' };
  let canvases = [invalidCanvas];
  const catalog = () => ({ source: { id: 'source', name: '测试数据源' }, revision: `r${revision}`, tables });
  await page.route('http://annotation.test/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;height:100vh"><div id="root" style="height:100vh"></div></body></html>' });
    const action = url.pathname.split('/').at(-1), input = route.request().postDataJSON();
    calls.push({ action, input });
    let body;
    if (action === 'sources') body = { items: [{ id: 'source', name: '测试数据源', enabledTableCount: 3, requiredCount: 7, annotatedCount: 3, status: 'partial' }] };
    else if (action === 'catalog') body = catalog();
    else if (action === 'ai-tasks') {
      if (!input) body = { task: null };
      else {
        aiRuns++;
        const generated = aiRuns === 1 ? ['订单分析', '客户经营'].map((name, index) => ({ id: `ai-canvas-${index}`, name, description: `主题 ${index + 1}`, content: { rootTableId: index ? 'customers' : 'orders', nodes: [{ tableId: 'orders', label: 'orders' }, { tableId: 'customers', label: 'customers' }], edges: [{ id: `ai-edge-${index}`, fromTableId: index ? 'customers' : 'orders', toTableId: index ? 'orders' : 'customers', pairs: [{ fromField: index ? 'id' : 'customer_id', toField: index ? 'customer_id' : 'id' }], cardinality: index ? '1:N' : 'N:1' }] }, layout: { orders: { x: 50, y: 50 }, customers: { x: 400, y: 50 } }, confirmed: false, valid: true, invalid: [], validationErrors: [], status: 'partial' })) : [];
        if (generated.length) { canvases.push(...generated); saved = false; revision++; }
        body = { task: { taskId: `relation-task-${aiRuns}`, sourceId: 'source', kind: 'relation', status: 'succeeded', result: { revision: `r${revision}`, count: generated.length, canvasCount: generated.length, canvasIds: generated.map(canvas => canvas.id) } } };
      }
    }
    else if (action === 'relations') body = { revision: `r${revision}`, items: canvases };
    else if (['relation-save', 'relation-confirm'].includes(action)) {
      if (action === 'relation-save' && failNextCanvasSave) { failNextCanvasSave = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存失败测试' }) }); }
      if (action === 'relation-save' && holdNextCanvasSave) { holdNextCanvasSave = false; await new Promise(resolve => { releaseCanvasSave = resolve; }); }
      const previous = canvases.find(item => item.id === (input.canvas?.id || input.canvasId));
      const canvas = input.canvas || previous;
      const confirmed = action === 'relation-confirm';
      const next = { ...canvas, id: canvas.id || 'new-canvas', confirmed, valid: true, invalid: [], validationErrors: [], status: 'partial', tables: canvas.content.nodes.map(node => { const table = tables.find(item => item.id === node.tableId); return { tableId: node.tableId, tableName: table?.name || node.label, annotation: table?.annotation }; }) };
      canvases = [...canvases.filter(item => item.id !== next.id), next];
      saved = false; body = { revision: `r${++revision}`, canvas: next };
    } else if (action === 'relation-remove') { canvases = canvases.filter(item => item.id !== input.canvasId); saved = false; body = { revision: `r${++revision}`, ok: true }; }
    else if (action === 'results') body = { saved, revision: `r${revision}`, tables: tables.map((table, index) => ({ tableId: table.id, tableName: table.name, annotation: table.annotation, fields: table.fields, annotatedCount: index ? 0 : 1 + table.fields.length, requiredCount: 1 + table.fields.length, status: ['complete', 'partial', 'unannotated'][index] })), relations: canvases.filter(item => item.confirmed && item.valid), summary: { tableCount: 3, completeTableCount: 1, relationCount: canvases.filter(item => item.confirmed).length, completeRelationCount: 0 } };
    else if (action === 'results-save') { saved = true; body = { saved, revision: `r${++revision}`, ok: true }; }
    else throw new Error(`Unexpected API ${action}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto('http://annotation.test/');
    await page.addScriptTag({ path: join(resolve(tools), 'node_modules/react/umd/react.development.js') });
    await page.addScriptTag({ path: join(resolve(tools), 'node_modules/react-dom/umd/react-dom.development.js') });
    await page.evaluate(() => { window.__ModuleLoader__ = { load(module) { const plugin = module.factory(name => { if (name === 'react') return window.React; throw new Error(name); }); plugin.apply({ slots: { inject(name, callback) { callback(); }, register(config, component) { if (config.key === 'data-annotation') window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(component)); } } }); } }; });
    await page.addScriptTag({ content: await readFile(new URL('../../client.js', import.meta.url), 'utf8') });
    await page.addStyleTag({ content: ':root{--dsw-alias-bg-module-platform:rgb(237, 239, 241);--dsw-alias-state-business-primary:rgb(44, 118, 222)}' });
    await page.getByRole('button', { name: '标注', exact: true }).click();
    await page.getByRole('button', { name: '3. 表关系标注', exact: true }).click();
    await page.getByRole('button', { name: '新建标注', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '表关系画布' });
    await dialog.getByRole('textbox', { name: '画布名称' }).fill('订单客户');
    await dialog.locator('.da-canvas-table-choice').filter({ has: page.getByRole('button', { name: '添加表 orders', exact: true }) }).getByText('orders', { exact: true }).click();
    assert.equal(await dialog.getByRole('article', { name: '表节点 orders', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: '添加表 orders', exact: true }).click();
    await dialog.getByRole('button', { name: '添加表 customers', exact: true }).click();
    assert.equal(await dialog.locator('[data-relation-field]').count(), 0);
    await dialog.getByRole('button', { name: '展开字段 orders', exact: true }).click();
    await dialog.getByRole('button', { name: '展开字段 customers', exact: true }).click();
    assert.equal(await dialog.getByRole('combobox', { name: '主表', exact: true }).inputValue(), 'orders');
    await dialog.getByRole('combobox', { name: '主表', exact: true }).selectOption('customers');
    const nodeHead = dialog.locator('.da-canvas-node-head').first(), box = await nodeHead.boundingBox();
    await page.mouse.move(box.x + 30, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 60, { steps: 5 }); await page.mouse.up();
    // First edge via field drag.
    const from = await dialog.getByRole('button', { name: '连接字段 orders.customer_id', exact: true }).boundingBox();
    const to = await dialog.getByRole('button', { name: '连接字段 customers.id', exact: true }).boundingBox();
    await page.mouse.move(from.x + 30, from.y + 15); await page.mouse.down(); await page.mouse.move(to.x + 30, to.y + 15, { steps: 6 }); await page.mouse.up();
    await dialog.getByRole('button', { name: '添加字段对', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '添加字段对', exact: true }).click();
    await dialog.getByRole('combobox', { name: '源字段 2', exact: true }).selectOption('id');
    await dialog.getByRole('combobox', { name: '目标字段 2', exact: true }).selectOption('tenant_id');
    await dialog.getByRole('combobox', { name: '关系基数', exact: true }).selectOption('1:N');
    await dialog.getByRole('button', { name: '收起字段 orders', exact: true }).click();
    await dialog.getByRole('button', { name: '收起字段 customers', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: '连接字段 orders.unused', exact: true }).count(), 0);
    assert.equal(await dialog.locator('[data-relation-field]').count(), 4);
    const collapsedPaths = await dialog.locator('.da-canvas-edge').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
    await dialog.getByRole('button', { name: '展开字段 orders', exact: true }).click();
    await dialog.getByRole('button', { name: '连接字段 orders.unused', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '收起字段 orders', exact: true }).click();
    assert.deepEqual(await dialog.locator('.da-canvas-edge').evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), collapsedPaths);
    failNextCanvasSave = true;
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '保存失败测试' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '保存', exact: true }).isEnabled(), true);
    holdNextCanvasSave = true;
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '保存中…', exact: true }).isDisabled(), true);
    assert.equal(typeof releaseCanvasSave, 'function'); releaseCanvasSave();
    await dialog.locator('.da-toast[role="status"]').filter({ hasText: '已保存' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    await dialog.locator('.da-toast').waitFor({ state: 'detached', timeout: 3500 });
    const savedCall = calls.findLast(call => call.action === 'relation-save');
    assert.equal(savedCall.input.canvas.content.rootTableId, 'customers');
    assert.equal(savedCall.input.canvas.content.edges[0].pairs.length, 2);
    assert.equal(savedCall.input.canvas.content.edges[0].cardinality, '1:N');
    assert.ok(savedCall.input.canvas.layout.orders.x > 50);
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '已确认' }).waitFor();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '已标注 (1)', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索关系标注' }).fill('customer_id');
    await page.getByRole('button', { name: '打开编辑', exact: true }).click();
    // Every edge deletion route works on the selection; typing never deletes it.
    assert.equal(await dialog.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '展开字段 orders', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '收起字段 orders', exact: true }).click();
    await page.screenshot({ path: join(resolve(tools), 'relation-canvas-collapsed.png'), fullPage: true });
    const addSecondEdge = async () => {
      await dialog.getByRole('button', { name: '连接字段 orders.id', exact: true }).press('Enter');
      await dialog.getByRole('button', { name: '连接字段 customers.tenant_id', exact: true }).press('Enter');
      assert.equal(await dialog.locator('.da-canvas-edge').count(), 3);
    };
    const selectedLine = () => dialog.locator('g[data-edge-id]').last();
    await addSecondEdge();
    await selectedLine().locator('text').click();
    assert.equal(await selectedLine().getAttribute('tabindex'), '0');
    assert.equal(await selectedLine().evaluate(node => document.activeElement === node), true);
    for (const input of [dialog.getByRole('textbox', { name: '画布名称' }), dialog.getByRole('textbox', { name: '业务说明' }), dialog.getByRole('searchbox', { name: '搜索可添加表' })]) {
      const value = await input.inputValue(); await input.fill(`${value}x`); await input.press('Backspace'); await input.press('Delete');
      assert.equal(await dialog.locator('.da-canvas-edge').count(), 3);
    }
    await dialog.getByRole('combobox', { name: '主表', exact: true }).press('Delete');
    assert.equal(await dialog.locator('.da-canvas-edge').count(), 3);
    await dialog.getByRole('button', { name: '删除选中关系', exact: true }).click();
    assert.equal(await dialog.locator('.da-canvas-edge').count(), 2);
    await addSecondEdge();
    await selectedLine().locator('text').click({ button: 'right' });
    await dialog.getByRole('menu').getByRole('menuitem', { name: '删除关系', exact: true }).click();
    assert.equal(await dialog.locator('.da-canvas-edge').count(), 2);
    assert.equal(await dialog.getByRole('menu').count(), 0);
    for (const key of ['Delete', 'Backspace']) {
      await addSecondEdge(); await selectedLine().locator('text').click(); await page.keyboard.press(key);
      assert.equal(await dialog.locator('.da-canvas-edge').count(), 2);
    }
    await addSecondEdge(); await dialog.getByRole('button', { name: '删除关系', exact: true }).click();
    assert.equal(await dialog.locator('.da-canvas-edge').count(), 2);
    // Point/keyboard route creates a second edge and unsaved close preserves changes if dismissed.
    await addSecondEdge();
    const prompt = page.waitForEvent('dialog'); const closeAttempt = dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const unsavedPrompt = await prompt; assert.match(unsavedPrompt.message(), /未保存/); await unsavedPrompt.dismiss(); await closeAttempt;
    assert.equal(await dialog.count(), 1);
    page.once('dialog', message => message.accept()); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '4. 标注确认', exact: true }).click();
    const single = page.getByRole('region', { name: '单表确认' }), relations = page.getByRole('region', { name: '关系确认' });
    await single.getByRole('button', { name: 'orders', exact: true }).waitFor();
    await single.getByRole('heading', { name: /^数据表列表/ }).waitFor();
    await relations.getByRole('heading', { name: /^表关系列表/ }).waitFor();
    await relations.getByRole('columnheader', { name: '关系名称', exact: true }).waitFor();
    assert.match(await relations.locator('.da-result-relation').innerText(), /orders\s+1:N\s+→\s+customers/);
    assert.equal(await single.locator('progress').count(), 0);
    const tracks = single.locator('span.da-progress[role="progressbar"]');
    assert.equal(await tracks.count(), 3);
    assert.equal(await tracks.first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(237, 239, 241)');
    assert.equal(await tracks.first().getAttribute('aria-valuenow'), '4');
    assert.equal(await tracks.first().getAttribute('aria-valuemax'), '4');
    assert.equal(await single.locator('tbody tr').count(), 3);
    assert.equal(await relations.locator('tbody tr').count(), 1);
    assert.equal(await relations.getByText('待修复', { exact: true }).count(), 0);
    for (const status of ['complete', 'partial', 'unannotated']) assert.equal(await single.locator(`.da-status.${status}`).count(), 1);
    await page.screenshot({ path: join(resolve(tools), 'annotation-confirmation.png'), fullPage: true });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor(); assert.equal(saved, true);
    assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    await relations.getByRole('button', { name: '订单客户', exact: true }).click();
    await dialog.waitFor(); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '3. 表关系标注', exact: true }).click();
    await page.getByRole('button', { name: '4. 标注确认', exact: true }).click();
    await single.getByRole('button', { name: 'orders', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    assert.equal(calls.filter(call => call.action === 'results-save').length, 1);
    await single.getByRole('button', { name: 'orders', exact: true }).click();
    assert.match(await page.getByRole('button', { name: '2. 字段标注', exact: true }).getAttribute('class'), /active/);
    await page.getByRole('button', { name: '3. 表关系标注', exact: true }).click();
    await page.getByRole('button', { name: '打开编辑', exact: true }).click();
    await dialog.getByRole('combobox', { name: '替换不可用表 gone', exact: true }).selectOption('customers');
    await dialog.getByRole('button', { name: 'customers N:1 orders', exact: true }).click();
    await dialog.getByRole('combobox', { name: '源字段 1', exact: true }).selectOption('id');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(calls.findLast(call => call.action === 'relation-save').input.canvas.content.nodes[0].tableId, 'customers');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    page.once('dialog', message => message.accept()); await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '草稿 (0)', exact: true }).waitFor();
    assert.equal(canvases.length, 1);
    const originalCanvas = JSON.stringify(canvases[0]);
    await page.getByRole('searchbox', { name: '搜索关系标注' }).fill('筛选不匹配');
    await page.getByRole('button', { name: 'AI 辅助标注', exact: true }).click();
    await page.getByText('已生成 2 个业务画布，共 2 条关联', { exact: true }).waitFor();
    const aiRequest = calls.findLast(call => call.action === 'ai-tasks' && call.input);
    assert.equal(aiRequest.input.kind, 'relation');
    assert.deepEqual(aiRequest.input.items.map(item => item.tableId), ['orders', 'customers', 'empty']);
    assert.equal(canvases.length, 3);
    assert.equal(JSON.stringify(canvases.find(canvas => canvas.id === 'new-canvas')), originalCanvas);
    assert.deepEqual(canvases.slice(1).map(canvas => canvas.content.nodes.map(node => node.tableId)), [['orders', 'customers'], ['orders', 'customers']]);
    await page.getByRole('searchbox', { name: '搜索关系标注' }).fill('');
    await page.getByText('主表：orders', { exact: true }).waitFor();
    await page.getByText('主表：customers', { exact: true }).waitFor();
    await page.getByRole('button', { name: '草稿 (2)', exact: true }).waitFor();
    await page.getByRole('button', { name: '4. 标注确认', exact: true }).click();
    await relations.getByRole('button', { name: '订单客户', exact: true }).waitFor();
    assert.equal(await relations.locator('tbody tr').count(), 1);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor(); assert.equal(saved, true);
    assert.equal(await page.getByRole('button', { name: '已保存', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '3. 表关系标注', exact: true }).click();
    await page.getByRole('button', { name: 'AI 辅助标注', exact: true }).click();
    await page.getByText('未生成新业务画布', { exact: true }).waitFor();
    assert.equal(canvases.length, 3);
    assert.equal(saved, true);
    assert.deepEqual(errors, []);
    return { assertions: 'four steps; independent table add; zero-edge collapse; composite fields and anchors; view-only expansion; drag node/fields; root default/select; save failure/retry/pending/toast; saved initial state; toolbar/context/Delete/Backspace/sidebar deletion; input deletion protection; draft/confirm; discard prompt; invalid repair; confirmed result names/directions; themed gray progress tracks; global saved state across steps; multiple business canvases; AI zero result', calls: calls.length, pageErrors: errors };
  } finally { await browser.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await runBrowserCheck(), null, 2));
