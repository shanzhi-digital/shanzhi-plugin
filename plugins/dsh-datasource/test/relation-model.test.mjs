import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvas, inspectCanvas, relationKey, canvasSemantics, digest, tableCompletion, relationCompletion, resultsFingerprint } from '../relation-model.js';

const annotation = (text = '', status = 'missing') => ({ text, status });
const tables = () => ['a', 'b', 'c'].map(id => ({ id, schema: 'data', name: id, tableKind: 'table', enabled: true, annotation: annotation(), fields: [
  { name: 'id', type: 'bigint', primaryKey: true, notNull: true, enabled: true, annotation: annotation() },
  { name: 'tenant', type: 'int', enabled: true, annotation: annotation() },
] }));
const edge = () => ({ id: 'e', fromTableId: 'a', toTableId: 'b', cardinality: '1:N', pairs: [{ fromField: 'id', toField: 'id' }, { fromField: 'tenant', toField: 'tenant' }] });
const canvas = () => normalizeCanvas({ id: 'canvas', name: '订单与客户', content: { nodes: [{ tableId: 'a', label: 'a' }, { tableId: 'b', label: 'b' }], edges: [edge()] }, layout: { a: { x: 1, y: 2 } } });

test('复合关系规范化反向基数和字段顺序；重复配对及自关联拒绝', () => {
  const value = edge();
  assert.equal(relationKey(value), relationKey({ ...value, fromTableId: 'b', toTableId: 'a', cardinality: 'N:1', pairs: value.pairs.toReversed().map(pair => ({ fromField: pair.toField, toField: pair.fromField })) }));
  assert.throws(() => normalizeCanvas({ ...canvas(), content: { nodes: canvas().content.nodes, edges: [{ ...edge(), pairs: [edge().pairs[0], edge().pairs[0]] }] } }), /重复/);
  assert.throws(() => normalizeCanvas({ ...canvas(), content: { nodes: canvas().content.nodes, edges: [{ ...edge(), toTableId: 'a' }] } }), /自关联/);
  assert.throws(() => normalizeCanvas({ ...canvas(), content: { nodes: canvas().content.nodes, edges: [edge(), { ...edge(), id: 'e2' }] } }), /重复/);
});

test('依赖签名只包含引用身份结构与启停，布局和中文标注不撤销确认', () => {
  const value = canvas(), structure = tables(), before = inspectCanvas(value, structure);
  assert.equal(before.valid, true);
  structure[0].annotation = annotation('客户', 'confirmed');
  structure[0].fields[0].annotation = annotation('编号', 'confirmed');
  assert.equal(inspectCanvas({ ...value, layout: { a: { x: 200, y: 300 } } }, structure).signature, before.signature);
  structure[0].fields[0].type = 'varchar';
  assert.notEqual(inspectCanvas(value, structure).signature, before.signature);
  structure[0].fields[0].enabled = false;
  assert.equal(inspectCanvas(value, structure).valid, false);
  assert.equal(inspectCanvas(value, structure).invalid[0].fieldName, 'id');
  structure.splice(1, 1);
  assert.ok(inspectCanvas(value, structure).invalid.some(value => value.kind === 'table' && value.tableId === 'b'));
});

test('草稿可为空但确认拒绝空图及孤节点', () => {
  const empty = normalizeCanvas({ name: '未完成', content: { nodes: [], edges: [] } });
  assert.equal(inspectCanvas(empty, tables()).valid, false);
  const value = canvas();
  value.content.nodes.push({ tableId: 'c', label: 'c' });
  assert.ok(inspectCanvas(value, tables()).validationErrors.some(value => value.includes('所有表节点')));
});

test('表与关系完成度区分红黄绿，分子仅有效确认', () => {
  const structure = tables();
  assert.deepEqual(tableCompletion(structure[0]), { annotatedCount: 0, requiredCount: 3, status: 'unannotated' });
  structure[0].annotation = annotation('客户', 'pending');
  assert.equal(tableCompletion(structure[0]).status, 'partial');
  assert.equal(tableCompletion(structure[0]).annotatedCount, 0);
  structure[0].annotation.status = 'confirmed';
  structure[0].fields.forEach(field => { field.annotation = annotation(field.name, 'confirmed'); });
  assert.equal(tableCompletion(structure[0]).status, 'complete');
  assert.equal(relationCompletion(canvas(), structure), 'partial');
  structure[1].annotation = annotation('订单', 'confirmed');
  structure[1].fields.forEach(field => { field.enabled = false; });
  assert.equal(relationCompletion(canvas(), structure), 'complete');
});

test('成果指纹忽略排序、布局、时间，包含草稿语义和字段启停', () => {
  const structure = tables(), value = { ...canvas(), confirmed: false }, source = { id: 's', name: '数据源', enabled: true, engine: 'mysql' };
  const before = resultsFingerprint(source, structure, [value]);
  const moved = { ...value, layout: { a: { x: 99, y: 100 } }, updatedAt: 'later' };
  assert.equal(resultsFingerprint(source, structure.toReversed().map(table => ({ ...table, fields: table.fields.toReversed(), freshness: { scannedAt: 'later' } })), [moved]), before);
  assert.equal(digest(canvasSemantics(value)), digest(canvasSemantics(moved)));
  assert.notEqual(resultsFingerprint(source, structure, [{ ...value, description: '新说明' }]), before);
  structure[0].fields[0].enabled = false;
  assert.notEqual(resultsFingerprint(source, structure, [value]), before);
});
