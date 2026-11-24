import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
// Exercise the actual loader factory with an in-memory hooks renderer. Browser
// pointer interactions live in test/client/browser.mjs and need no app server.
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
const tables = [{ id: 'a', name: 'table_a', annotation: ann, fields: [{ name: 'id', enabled: true, annotation: ann }] }, { id: 'b', name: 'table_b', annotation: ann, fields: [{ name: 'ref', enabled: true, annotation: ann }, { name: 'old', enabled: false, annotation: ann }] }];
function all(node, predicate) { if (!node || typeof node !== 'object') return []; return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => all(child, predicate))]; }
const button = (tree, name) => all(tree, node => node.type === 'button' && (node.props['aria-label'] === name || node.children.includes(name)))[0];

test('canvas point connection, compound pairs, cardinality and node removal use actual state transitions', () => {
  const harness = load(), props = { tables, busy: false, onClose() {}, onSave() {} };
  let tree = harness.render('RelationCanvas', props);
  button(tree, '+ table_a · 中文名').props.onClick(); tree = harness.render('RelationCanvas', props);
  button(tree, '+ table_b · 中文名').props.onClick(); tree = harness.render('RelationCanvas', props);
  assert.equal(harness.state[0].content.rootTableId, 'a');
  all(tree, node => node.props['aria-label'] === '主表')[0].props.onChange({ target: { value: 'b' } });
  tree = harness.render('RelationCanvas', props);
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

test('legacy draft opens and saves without forcing a root table, and selecting a root preserves it in requests', async () => {
  const harness = load(), canvas = { id: 'legacy', name: '旧画布', description: '', content: { nodes: [{ tableId: 'a', label: 'A' }], edges: [] }, layout: {} }, requests = [];
  const props = { canvas, tables, onSave: async payload => { requests.push(payload); return payload; } };
  let tree = harness.render('RelationCanvas', props);
  assert.equal(all(tree, node => node.props['aria-label'] === '主表')[0].props.value, '');
  assert.equal(harness.state[0].content.rootTableId, undefined);
  await button(tree, '保存').props.onClick();
  assert.equal(requests[0].content.rootTableId, undefined);
  tree = harness.render('RelationCanvas', props);
  all(tree, node => node.props['aria-label'] === '主表')[0].props.onChange({ target: { value: 'a' } });
  tree = harness.render('RelationCanvas', props);
  await button(tree, '保存').props.onClick();
  assert.equal(requests[1].content.rootTableId, 'a');
});

test('canvas request projection excludes server confirmation and validation metadata', () => {
  const { exports } = load();
  const payload = exports.canvasPayload({ id: 'c', name: 'C', description: '', content: { nodes: [], edges: [] }, layout: {}, confirmed: true, valid: false, invalid: ['x'] });
  assert.deepEqual(Object.keys(payload), ['id', 'name', 'description', 'content', 'layout']);
  assert.equal(exports.relationTables({ content: { nodes: [{ tableId: 'a' }, { tableId: 'missing', label: '保留名称' }] } }, tables), 'table_a、保留名称');
});
