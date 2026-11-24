import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvas, inspectCanvas, relationKey, canvasSemantics, canvasThemeKey, digest, tableCompletion, relationCompletion, resultsFingerprint } from '../relation-model.js';

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

test('主表必须属于节点，确认时所有节点须无向可达，旧画布签名保持兼容', () => {
  const legacy = canvas(), structure = tables();
  const dependencies = legacy.content.nodes.map(node => {
    const table = structure.find(table => table.id === node.tableId);
    return [node.tableId, [table.schema, table.name, table.tableKind, table.enabled]];
  });
  for (const relation of legacy.content.edges) for (const pair of relation.pairs) for (const [tableId, fieldName] of [[relation.fromTableId, pair.fromField], [relation.toTableId, pair.toField]]) {
    const field = structure.find(table => table.id === tableId).fields.find(field => field.name === fieldName);
    dependencies.push([tableId, fieldName, [field.type, field.primaryKey ?? null, field.notNull ?? null, field.enabled]]);
  }
  dependencies.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const originalSemantics = { name: legacy.name, description: legacy.description, nodes: ['a', 'b'], edges: legacy.content.edges.map(relationKey).sort() };
  assert.equal(inspectCanvas(legacy, structure).signature, digest([originalSemantics, dependencies]));
  assert.equal(Object.hasOwn(normalizeCanvas(legacy).content, 'rootTableId'), false);
  assert.equal(Object.hasOwn(normalizeCanvas({ ...legacy, content: { ...legacy.content, rootTableId: null } }).content, 'rootTableId'), false);
  assert.throws(() => normalizeCanvas({ ...legacy, content: { ...legacy.content, rootTableId: 'missing' } }), /主表/);
  const rooted = normalizeCanvas({ ...legacy, content: { ...legacy.content, rootTableId: 'b' } });
  assert.equal(inspectCanvas(rooted, structure).valid, true, '反向基数也可从主表沿无向关系到达');
  assert.notEqual(inspectCanvas(rooted, structure).signature, inspectCanvas(legacy, structure).signature);
  const detached = { ...rooted, content: { ...rooted.content, nodes: [...rooted.content.nodes, { tableId: 'c', label: '' }, { tableId: 'd', label: '' }], edges: [...rooted.content.edges, { ...edge(), id: 'detached', fromTableId: 'c', toTableId: 'd' }] } };
  assert.ok(inspectCanvas(detached, [...structure, { ...structure[0], id: 'd' }]).validationErrors.some(value => value.includes('主表沿关系到达')));
  assert.equal(inspectCanvas({ ...detached, content: { nodes: detached.content.nodes, edges: detached.content.edges } }, [...structure, { ...structure[0], id: 'd' }]).valid, true, '历史无主表画布仍沿用既有确认规则');
  assert.notEqual(resultsFingerprint({ id: 's', enabled: true }, structure, [rooted]), resultsFingerprint({ id: 's', enabled: true }, structure, [legacy]));
});

test('主题判重使用主表和完整规范化边集，忽略名称并允许部分重叠', () => {
  const value = canvas(); value.content.rootTableId = 'a';
  const reversed = { ...value, name: '新名称', content: { ...value.content, edges: [{ ...edge(), fromTableId: 'b', toTableId: 'a', cardinality: 'N:1', pairs: edge().pairs.toReversed().map(pair => ({ fromField: pair.toField, toField: pair.fromField })) }] } };
  assert.equal(canvasThemeKey(value), canvasThemeKey(reversed));
  assert.notEqual(canvasThemeKey(value), canvasThemeKey({ ...value, content: { ...value.content, rootTableId: 'b' } }));
  assert.notEqual(canvasThemeKey(value), canvasThemeKey({ ...value, content: { ...value.content, edges: [...value.content.edges, { ...edge(), toTableId: 'c' }] } }));
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
