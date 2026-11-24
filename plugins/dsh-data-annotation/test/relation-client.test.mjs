import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
// Exercise the actual loader factory with an in-memory hooks renderer. Browser
// focus, timers and pointer interactions live in test/client/browser.mjs.
function load() {
  const state = [], effects = [];
  let cursor = 0, exports;
  const react = { Fragment: 'fragment', createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; }, useState(initial) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }]; }, useRef(value) { const index = cursor++; state[index] ??= { current: value }; return state[index]; }, useEffect(callback) { effects.push(callback); } };
  const instrumented = source.replace("return { name: 'data-annotation', inject: ['slots', 'layout'], apply };", "return { RelationCanvas, RelationStep, ConfirmationStep, canvasPayload, canvasText, relationTables, name: 'data-annotation', inject: ['slots', 'layout'], apply };");
  const context = { window: { __ModuleLoader__: { load(module) { exports = module.factory(name => { assert.equal(name, 'react'); return react; }); } }, confirm: () => true }, console, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, globalThis: { crypto: { randomUUID: () => 'uuid-edge' } } };
  vm.runInNewContext(instrumented, context);
  return { exports, state, render(component, props) { cursor = 0; return exports[component](props); } };
}
const ann = { text: '中文名', status: 'confirmed' };
const tables = [{ id: 'a', name: 'table_a', annotation: ann, fields: [{ name: 'id', enabled: true, annotation: ann }, { name: 'tenant_id', enabled: true, annotation: ann }, { name: 'unused', enabled: true, annotation: ann }] }, { id: 'b', name: 'table_b', annotation: ann, fields: [{ name: 'ref', enabled: true, annotation: ann }, { name: 'tenant_id', enabled: true, annotation: ann }, { name: 'old', enabled: false, annotation: ann }] }];
function all(node, predicate) { if (!node || typeof node !== 'object') return []; return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))]; }
const button = (tree, name) => all(tree, node => node.type === 'button' && (node.props['aria-label'] === name || node.children.includes(name)))[0];
const connectionButtons = tree => all(tree, node => node.type === 'button' && node.props['aria-label']?.startsWith('连接字段 '));
const canvasWithPairs = () => ({ id: 'existing', name: '关系', description: '', content: { nodes: [{ tableId: 'a', label: 'A' }, { tableId: 'b', label: 'B' }], edges: [{ id: 'e', fromTableId: 'a', toTableId: 'b', pairs: [{ fromField: 'id', toField: 'ref' }, { fromField: 'tenant_id', toField: 'tenant_id' }], cardinality: 'N:1' }] }, layout: { a: { x: 50, y: 50 }, b: { x: 400, y: 50 } } });

test('table choices add only through their independent button and zero-edge nodes start collapsed', () => {
  const harness = load(), props = { tables, busy: false, onClose() {}, onSave() {} };
  let tree = harness.render('RelationCanvas', props);
  const choices = all(tree, node => node.props.className?.split(' ').includes('da-canvas-table-choice'));
  assert.equal(choices.length, 2);
  assert.ok(choices.every(node => node.type !== 'button' && !node.props.onClick));
  button(tree, '添加表 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(harness.state[0].content.nodes.length, 1);
  assert.equal(connectionButtons(tree).length, 0);
  button(tree, '展开字段 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(connectionButtons(tree).length, 3);
  button(tree, '收起字段 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(connectionButtons(tree).length, 0);
});

test('canvas point connection, compound pairs, cardinality and node removal use actual state transitions', () => {
  const harness = load(), props = { tables, busy: false, onClose() {}, onSave() {} };
  let tree = harness.render('RelationCanvas', props);
  button(tree, '添加表 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  button(tree, '添加表 table_b').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(harness.state[0].content.rootTableId, 'a');
  all(tree, node => node.props['aria-label'] === '主表')[0].props.onChange({ target: { value: 'b' } });
  tree = harness.render('RelationCanvas', props);
  button(tree, '展开字段 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  button(tree, '展开字段 table_b').props.onClick(); tree = harness.render('RelationCanvas', props);
  button(tree, '连接字段 table_a.id').props.onClick(); tree = harness.render('RelationCanvas', props);
  button(tree, '连接字段 table_b.ref').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(harness.state[0].content.edges.length, 1);
  assert.equal(harness.state[0].content.edges[0].pairs[0].fromField, 'id');
  button(tree, '添加字段对').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(harness.state[0].content.edges[0].pairs.length, 2);
  all(tree, node => node.props['aria-label'] === '关系基数')[0].props.onChange({ target: { value: '1:N' } });
  assert.equal(harness.state[0].content.edges[0].cardinality, '1:N');
  tree = harness.render('RelationCanvas', props); button(tree, '移除表 table_b').props.onClick();
  assert.equal(harness.state[0].content.edges.length, 0);
  assert.equal(harness.state[0].content.nodes.length, 1);
  assert.equal(harness.state[0].content.rootTableId, undefined);
});

test('collapsed nodes preserve every composite field and anchor while expansion stays view-only', () => {
  const harness = load(), canvas = canvasWithPairs(), props = { canvas, tables };
  let tree = harness.render('RelationCanvas', props);
  const initial = JSON.stringify(harness.state[0]);
  const paths = tree => all(tree, node => node.type === 'path' && node.props.className?.split(' ').includes('da-canvas-edge')).map(node => node.props.d);
  const before = paths(tree);
  assert.equal(connectionButtons(tree).length, 4);
  assert.equal(button(tree, '连接字段 table_a.unused'), undefined);
  assert.equal(button(tree, '已保存').props.disabled, true);
  button(tree, '展开字段 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.ok(button(tree, '连接字段 table_a.unused'));
  assert.equal(JSON.stringify(harness.state[0]), initial);
  assert.equal(button(tree, '已保存').props.disabled, true);
  button(tree, '收起字段 table_a').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.deepEqual(paths(tree), before);
  assert.equal(before.length, 2);
  assert.equal(connectionButtons(tree).length, 4);
  assert.equal(JSON.stringify(harness.state[0]), initial);
});

test('unavailable references remain visible and permit replacing the unavailable table', () => {
  const harness = load(), canvas = { name: 'broken', description: '', content: { rootTableId: 'gone', nodes: [{ tableId: 'gone', label: '原表' }, { tableId: 'a', label: 'A' }], edges: [{ id: 'e', fromTableId: 'gone', toTableId: 'a', pairs: [{ fromField: 'missing', toField: 'id' }], cardinality: 'N:1' }] }, layout: { gone: { x: 40, y: 50 }, a: { x: 400, y: 50 } } };
  let tree = harness.render('RelationCanvas', { canvas, tables });
  assert.equal(button(tree, '连接字段 原表.missing').props.disabled, true);
  const replacement = all(tree, node => node.props['aria-label'] === '替换不可用表 gone')[0];
  replacement.props.onChange({ target: { value: 'b' } });
  assert.equal(harness.state[0].content.nodes[0].tableId, 'b');
  assert.equal(harness.state[0].content.edges[0].fromTableId, 'b');
  assert.equal(harness.state[0].layout.b.x, 40);
  assert.equal(harness.state[0].content.rootTableId, 'b');
  tree = harness.render('RelationCanvas', { canvas, tables });
  assert.equal(button(tree, '连接字段 table_b.missing').props.disabled, true);
});

test('legacy draft preserves an absent root, starts saved, and root changes restore the save action', async () => {
  const harness = load(), canvas = { id: 'legacy', name: '旧画布', description: '', content: { nodes: [{ tableId: 'a', label: 'A' }], edges: [] }, layout: {} }, requests = [];
  const props = { canvas, tables, onSave: async payload => { requests.push(payload); return payload; } };
  let tree = harness.render('RelationCanvas', props);
  assert.equal(all(tree, node => node.props['aria-label'] === '主表')[0].props.value, '');
  assert.equal(harness.state[0].content.rootTableId, undefined);
  assert.equal(button(tree, '已保存').props.disabled, true);
  await button(tree, '确认').props.onClick();
  assert.equal(requests[0].content.rootTableId, undefined);
  tree = harness.render('RelationCanvas', props);
  all(tree, node => node.props['aria-label'] === '主表')[0].props.onChange({ target: { value: 'a' } });
  tree = harness.render('RelationCanvas', props);
  assert.equal(button(tree, '保存').props.disabled, false);
  await button(tree, '保存').props.onClick();
  assert.equal(requests[1].content.rootTableId, 'a');
  tree = harness.render('RelationCanvas', props);
  assert.equal(button(tree, '已保存').props.disabled, true);
});

test('canvas save exposes pending state and failure keeps changes available for retry', async () => {
  const harness = load();
  let rejectSave, resolveSave, attempts = 0;
  const props = { canvas: canvasWithPairs(), tables, onSave: payload => { attempts++; return new Promise((resolve, reject) => { rejectSave = reject; resolveSave = () => resolve(payload); }); } };
  let tree = harness.render('RelationCanvas', props);
  all(tree, node => node.props['aria-label'] === '画布名称')[0].props.onChange({ target: { value: '已修改' } });
  tree = harness.render('RelationCanvas', props);
  const failed = button(tree, '保存').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(button(tree, '保存中…').props.disabled, true);
  rejectSave(new Error('保存失败测试')); await failed; tree = harness.render('RelationCanvas', props);
  assert.equal(button(tree, '保存').props.disabled, false);
  assert.ok(all(tree, node => node.props.role === 'alert' && node.children.includes('保存失败测试')).length);
  const retried = button(tree, '保存').props.onClick(); resolveSave(); await retried;
  tree = harness.render('RelationCanvas', props);
  assert.equal(button(tree, '已保存').props.disabled, true);
  assert.equal(attempts, 2);
  assert.equal(harness.state[0].name, '已修改');
});

test('canvas request projection excludes server confirmation and validation metadata', () => {
  const { exports } = load();
  const payload = exports.canvasPayload({ id: 'c', name: 'C', description: '', content: { nodes: [], edges: [] }, layout: {}, confirmed: true, valid: false, invalid: ['x'] });
  assert.deepEqual(Object.keys(payload), ['id', 'name', 'description', 'content', 'layout']);
  assert.equal(exports.relationTables({ content: { nodes: [{ tableId: 'a' }, { tableId: 'missing', label: '保留名称' }] } }, tables), 'table_a、保留名称');
});
