import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createAnnotationStore } from '../annotation-store.js';
import { MysqlFlowStore } from '../flow-store.js';
import { createDatasourceService } from '../service.js';
import { InternalHttp } from '../internal-http.js';
import { registerRoutes } from '../../dsh-data-annotation/routes.js';

async function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  const ddl = await readFile(new URL('../migrations/001-management.sql', import.meta.url), 'utf8');
  for (const sql of ddl.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean)) sqlite.exec(sql.replace(/\) ENGINE=InnoDB.*$/, ')').replace(/^  KEY \(profile_id, source_id\),\r?\n/m, '').replace(/\bINSERT IGNORE\b/, 'INSERT OR IGNORE'));
  const calls = [];
  const connection = {
    fail: null,
    async query(sql) { if (sql.startsWith('SELECT UNIX_TIMESTAMP')) return [[{ now_ms: 1700000000123 }]]; return this.execute(sql, []); },
    async execute(sql, values) {
      calls.push({ sql, values });
      assert.equal(values.length, (sql.match(/\?/g) ?? []).length);
      if (this.fail?.(sql)) throw new Error('fixture failure');
      sql = sql.replace(/ (FOR UPDATE|LOCK IN SHARE MODE)$/, '').replace('ON DUPLICATE KEY UPDATE', 'ON CONFLICT DO UPDATE SET').replace(/= VALUES\((\w+)\)/g, '= excluded.$1');
      const statement = sqlite.prepare(sql);
      const converted = values.map(value => typeof value === 'boolean' ? Number(value) : value);
      return [sql.startsWith('SELECT') ? statement.all(...converted) : statement.run(...converted)];
    },
  };
  const db = { profileId: 'p', pool: connection, async transaction(fn) {
    sqlite.exec('BEGIN');
    try { const value = await fn(connection); sqlite.exec('COMMIT'); return value; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const store = new MysqlFlowStore(db), annotations = createAnnotationStore({ db, store });
  for (const id of ['s', 'other']) {
    await store.saveSource({ id, name: id, engine: 'mysql', host: 'localhost', user: 'reader', database: 'data' });
    await store.change(id, state => ({ state: { ...state, revision: 1, catalog: { id: `catalog-${id}`, scannedAt: 'now', tables: ['a', 'b', 'c'].map(id => ({ id, name: id, schema: 'data', tableKind: 'table', sourceComment: '', enabled: true, structureHash: id, fields: [{ name: 'id', type: 'bigint', primaryKey: true }, { name: 'tenant', type: 'int' }] })) } } }));
  }
  return { sqlite, calls, connection, db, store, annotations };
}
const canvas = () => ({ name: '客户订单', description: '', content: { nodes: [{ tableId: 'a', label: '客户' }, { tableId: 'b', label: '订单' }], edges: [{ id: 'e', fromTableId: 'a', toTableId: 'b', pairs: [{ fromField: 'id', toField: 'id' }, { fromField: 'tenant', toField: 'tenant' }], cardinality: '1:N' }] }, layout: { a: { x: 10, y: 10 } } });
const revision = async annotations => (await annotations.catalog('s')).revision;
const saveResults = async annotations => annotations.resultsSave({ sourceId: 's', revision: await revision(annotations) });

test('关系草稿、原子确认、布局、无变化提交、全局保存与旧revision拒绝', async t => {
  const { annotations, sqlite, calls } = await fixture(t);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
  let current = await annotations.relationSave({ sourceId: 's', revision: await revision(annotations), canvas: canvas() });
  assert.equal(current.canvas.confirmed, false);
  assert.equal((await annotations.results('s')).relations.length, 0);
  current = await annotations.relationConfirm({ sourceId: 's', revision: current.revision, canvasId: current.canvas.id });
  assert.equal(current.canvas.confirmed, true);
  const saved = await saveResults(annotations), result = await annotations.readSavedResults('s');
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].status, 'unannotated');
  assert.equal(result.tables.length, 3);
  current = await annotations.relationSave({ sourceId: 's', revision: saved.revision, canvas: { ...current.canvas, layout: { a: { x: 900, y: 100 } } } });
  assert.equal(current.canvas.confirmed, true);
  assert.notEqual(current.revision, saved.revision);
  assert.equal((await annotations.readSavedResults('s')).fingerprint, result.fingerprint);
  assert.equal((await annotations.relationSave({ sourceId: 's', revision: current.revision, canvas: current.canvas })).revision, current.revision);
  await assert.rejects(annotations.relationSave({ sourceId: 's', revision: saved.revision, canvas: current.canvas }), error => error.status === 409);
  const original = current.canvas;
  current = await annotations.relationSave({ sourceId: 's', revision: current.revision, canvas: { ...original, description: '修改' } });
  assert.equal(current.canvas.confirmed, false);
  current = await annotations.relationConfirm({ sourceId: 's', revision: current.revision, canvas: original });
  assert.equal(current.canvas.confirmed, true);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
  await saveResults(annotations); await saveResults(annotations);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM dsh_annotation_results WHERE source_id = ?').get('s').count, 1);
  assert.ok(calls.some(call => call.sql.includes('dsh_sources') && call.sql.endsWith('FOR UPDATE')));
});

test('停用和恢复字段不自动恢复关系确认；中文标注不撤销关系且更改改回仍需保存', async t => {
  const { annotations } = await fixture(t);
  let current = await annotations.relationConfirm({ sourceId: 's', revision: await revision(annotations), canvas: canvas() });
  await saveResults(annotations);
  let catalog = await annotations.action({ sourceId: 's', revision: await revision(annotations), operation: 'edit', kind: 'table', items: [{ tableId: 'a', text: '客户' }] });
  assert.equal((await annotations.relations('s')).items[0].confirmed, true);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
  catalog = await annotations.action({ sourceId: 's', revision: catalog.revision, operation: 'enable', kind: 'field', items: [{ tableId: 'a', fieldName: 'id', enabled: false }] });
  let relation = (await annotations.relations('s')).items[0];
  assert.equal(relation.confirmed, false);
  assert.equal(relation.invalid[0].fieldName, 'id');
  await assert.rejects(annotations.relationConfirm({ sourceId: 's', revision: catalog.revision, canvasId: current.canvas.id }), /停用|引用/);
  await annotations.action({ sourceId: 's', revision: await revision(annotations), operation: 'enable', kind: 'field', items: [{ tableId: 'a', fieldName: 'id', enabled: true }] });
  relation = (await annotations.relations('s')).items[0];
  assert.equal(relation.valid, true); assert.equal(relation.confirmed, false);
});

test('目录扫描只变化时间保留认可，删除引用持久保留草稿、恢复不确认，停用源清空认可', async t => {
  const { annotations, store } = await fixture(t);
  const current = await annotations.relationConfirm({ sourceId: 's', revision: await revision(annotations), canvas: canvas() });
  await saveResults(annotations);
  const original = await store.get('s');
  await store.change('s', state => { state.catalog.scannedAt = 'later'; state.revision++; return { state }; });
  await annotations.readSavedResults('s');
  await store.change('s', state => { state.catalog.tables = state.catalog.tables.filter(table => table.id !== 'b'); state.revision++; return { state }; });
  let relation = (await annotations.relations('s')).items[0];
  assert.equal(relation.id, current.canvas.id); assert.equal(relation.confirmed, false);
  assert.ok(relation.invalid.some(value => value.tableId === 'b'));
  await store.change('s', state => ({ state: { ...original, revision: state.revision + 1 } }));
  relation = (await annotations.relations('s')).items[0]; assert.equal(relation.valid, true); assert.equal(relation.confirmed, false);
  await saveResults(annotations);
  let source = await store.getSource('s'); await store.setSourceEnabled('s', false, source.revision);
  source = await store.getSource('s'); await store.setSourceEnabled('s', true, source.revision);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
});

test('AI主题各自保存，跨画布共享边，完整主题反向去重，会话和revision受保护', async t => {
  const { annotations, store, sqlite, connection } = await fixture(t);
  const confirmed = await annotations.relationConfirm({ sourceId: 's', revision: await revision(annotations), canvas: canvas() });
  await store.bindSession('session', { sourceId: 's', retired: false });
  const relation = { fromTableId: 'b', toTableId: 'a', cardinality: 'N:1', pairs: [{ fromField: 'tenant', toField: 'tenant' }, { fromField: 'id', toField: 'id' }] };
  const group = { name: '客户订单主题', description: '从客户查看订单', rootTableId: 'a', relations: [relation, canvas().content.edges[0]] };
  const otherGroup = { name: '订单明细主题', description: '', rootTableId: 'b', relations: [relation, { ...relation, toTableId: 'c' }] };
  let result = await annotations.aiRelationSave({ sourceId: 's', revision: await revision(annotations), sessionId: 'session', canvases: [group, otherGroup] });
  assert.equal(result.count, 3); assert.equal(result.canvasCount, 2); assert.equal(result.canvasIds.length, 2);
  assert.ok(result.canvases.every(canvas => !canvas.confirmed));
  assert.equal(result.canvases.find(canvas => canvas.name === group.name).content.rootTableId, 'a');
  assert.equal(result.canvases.find(canvas => canvas.name === group.name).content.edges.length, 1);
  assert.equal((await annotations.relations('s')).items.find(canvas => canvas.id === confirmed.canvas.id).confirmed, true);
  const before = result.revision;
  result = await annotations.aiRelationSave({ sourceId: 's', revision: before, sessionId: 'session', canvases: [{ ...otherGroup, name: '另一个名称', relations: otherGroup.relations.toReversed() }, { ...group, relations: [canvas().content.edges[0]] }] });
  assert.deepEqual(result, { revision: before, count: 0, canvasCount: 0, canvasIds: [], canvases: [] });
  result = await annotations.aiRelationSave({ sourceId: 's', revision: before, sessionId: 'session', canvases: [{ ...group, relations: [...group.relations, { ...relation, fromTableId: 'a', toTableId: 'c' }] }] });
  assert.equal(result.count, 2); assert.equal(result.canvasCount, 1);
  await assert.rejects(annotations.aiRelationSave({ sourceId: 's', revision: before, sessionId: 'session', canvases: [] }), error => error.status === 409);
  await assert.rejects(annotations.aiRelationSave({ sourceId: 's', revision: result.revision, sessionId: 'missing', canvases: [] }), error => error.status === 409);
  await store.retireSession('session');
  await assert.rejects(annotations.aiRelationSave({ sourceId: 's', revision: result.revision, sessionId: 'session', canvases: [] }), error => error.status === 409);
  assert.equal((await annotations.relations('other')).items.length, 0);
  const other = createAnnotationStore({ db: { profileId: 'other-profile', transaction: async fn => fn(connection) } });
  await assert.rejects(other.relations('s'), error => error.status === 404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM dsh_relation_canvases').get().count, 4);
});

test('AI主题全部先校验再写入，后组非法或第二组落库失败均原子回滚，空批次无写入', async t => {
  const { annotations, store, connection, calls, sqlite } = await fixture(t);
  await store.bindSession('session', { sourceId: 's', retired: false });
  await saveResults(annotations);
  const initial = await annotations.readSavedResults('s'), current = initial.revision;
  const group = { name: '客户订单', rootTableId: 'a', relations: canvas().content.edges };
  const request = canvases => ({ sourceId: 's', revision: current, sessionId: 'session', canvases });
  const beforeWrites = () => calls.filter(call => call.sql.startsWith('INSERT INTO dsh_relation_canvases')).length;
  const count = beforeWrites();
  await assert.rejects(annotations.aiRelationSave(request([group, { ...group, rootTableId: 'missing' }])), /主表/);
  await assert.rejects(annotations.aiRelationSave(request([group, { ...group, rootTableId: 'c' }])), /主表/);
  await assert.rejects(annotations.aiRelationSave(request([group, { ...group, relations: [{ ...group.relations[0], pairs: [{ fromField: 'missing', toField: 'id' }] }] }])), /字段/);
  await assert.rejects(annotations.aiRelationSave(request([group, { ...group, relations: [] }])), /至少/);
  assert.equal(beforeWrites(), count, '后组非法时第一组也不能开始写入');
  let insertCount = 0;
  connection.fail = sql => sql.startsWith('INSERT INTO dsh_relation_canvases') && ++insertCount === 2;
  await assert.rejects(annotations.aiRelationSave(request([group, { ...group, rootTableId: 'b' }])), /fixture failure/);
  connection.fail = null;
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM dsh_relation_canvases').get().count, 0);
  assert.equal(await revision(annotations), current);
  assert.equal((await annotations.readSavedResults('s')).fingerprint, initial.fingerprint);
  assert.deepEqual(await annotations.aiRelationSave(request([])), { revision: current, count: 0, canvasCount: 0, canvasIds: [], canvases: [] });
});

test('主表语义修改撤销人工确认及全局认可，历史无主表画布保持确认', async t => {
  const { annotations } = await fixture(t);
  const legacy = await annotations.relationConfirm({ sourceId: 's', revision: await revision(annotations), canvas: canvas() });
  await saveResults(annotations);
  assert.equal((await annotations.relations('s')).items[0].confirmed, true);
  const changed = await annotations.relationSave({ sourceId: 's', revision: await revision(annotations), canvas: { ...legacy.canvas, content: { ...legacy.canvas.content, rootTableId: 'a' } } });
  assert.equal(changed.canvas.confirmed, false);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
  const confirmed = await annotations.relationConfirm({ sourceId: 's', revision: changed.revision, canvasId: changed.canvas.id });
  assert.equal(confirmed.canvas.content.rootTableId, 'a'); assert.equal(confirmed.canvas.confirmed, true);
});

test('启用表结果进度按人工确认计数，允许部分成果保存，连接换目标清理画布并失效', async t => {
  const { annotations, store } = await fixture(t);
  let result = await annotations.results('s');
  assert.deepEqual(result.tables[0].annotatedCount, 0);
  assert.equal(result.tables[0].requiredCount, 3);
  let catalog = await annotations.action({ sourceId: 's', revision: result.revision, operation: 'edit', kind: 'table', items: [{ tableId: 'a', text: '客户' }] });
  result = await annotations.results('s');
  assert.equal(result.tables[0].status, 'partial'); assert.equal(result.tables[0].annotatedCount, 0);
  catalog = await annotations.action({ sourceId: 's', revision: catalog.revision, operation: 'confirm', kind: 'table', items: [{ tableId: 'a' }] });
  catalog = await annotations.action({ sourceId: 's', revision: catalog.revision, operation: 'enable', kind: 'field', items: [{ tableId: 'a', fieldName: 'id', enabled: false }, { tableId: 'a', fieldName: 'tenant', enabled: false }] });
  result = await annotations.results('s');
  assert.equal(result.tables[0].status, 'complete'); assert.equal(result.tables[0].requiredCount, 1);
  await saveResults(annotations);
  const source = await store.getSource('s');
  await store.saveSource({ ...source, description: '说明变化' }, source.revision);
  await annotations.readSavedResults('s');
  let current = await annotations.relationSave({ sourceId: 's', revision: await revision(annotations), canvas: { name: '待完成', content: { nodes: [], edges: [] } } });
  await saveResults(annotations);
  const before = await store.getSource('s');
  await store.saveSource({ ...before, database: 'different' }, before.revision);
  assert.equal((await annotations.relations('s')).items.length, 0);
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
});

test('DSH和临时内部HTTP共用真实存储与处理器，交叉保存确认和读取认可成果', async t => {
  const { annotations, store } = await fixture(t);
  const service = createDatasourceService(() => ({ annotations, store }));
  const http = new InternalHttp({ enabled: true, port: 0 }), dshRoutes = new Map();
  const dispose = registerRoutes({ connection: { fetch: { register(route) { dshRoutes.set(route.path, route); return () => dshRoutes.delete(route.path); } } }, datasourceHttp: http }, service, {});
  const dsh = (path, input) => dshRoutes.get(`/api/data-annotation/${path}`).fetch(new Request(`http://dsh.local/api/data-annotation/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
  try {
    await http.listen();
    const post = (path, input) => fetch(`http://127.0.0.1:${http.port}/api/data-annotation/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    let response = await dsh('relation-save', { sourceId: 's', revision: await revision(annotations), canvas: canvas() });
    assert.equal(response.status, 200);
    let current = await response.json();
    response = await dsh('relation-confirm', { sourceId: 's', revision: current.revision, canvasId: current.canvas.id });
    assert.equal(response.status, 200); current = await response.json();
    const httpResults = await post('results', { sourceId: 's' });
    assert.equal(httpResults.status, 200);
    const results = await httpResults.json();
    assert.equal(results.relations[0].id, current.canvas.id); assert.equal(results.revision, current.revision);
    response = await post('results-save', { sourceId: 's', revision: results.revision });
    assert.equal(response.status, 200);
    response = await dsh('saved-results', { sourceId: 's' });
    assert.equal(response.status, 200);
    const dshSaved = await response.json(), httpSaved = await (await post('saved-results', { sourceId: 's' })).json();
    assert.deepEqual(httpSaved, dshSaved);
    assert.equal(dshSaved.relations.length, 1);
    await dsh('relation-remove', { sourceId: 's', revision: dshSaved.revision, canvasId: current.canvas.id });
    response = await post('saved-results', { sourceId: 's' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /请先在标注确认中保存/);
  } finally { dispose(); await http.close(); }
});

test('保存失败回滚与删除后全局失效；空草稿可存但不能确认，跨源和虚构字段拒绝', async t => {
  const { annotations, connection, sqlite } = await fixture(t);
  const oldRevision = await revision(annotations);
  connection.fail = sql => sql.startsWith('UPDATE dsh_sources');
  await assert.rejects(annotations.relationSave({ sourceId: 's', revision: oldRevision, canvas: canvas() }), /fixture failure/);
  connection.fail = null;
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM dsh_relation_canvases').get().count, 0);
  assert.equal(await revision(annotations), oldRevision);
  const invalid = canvas(); invalid.content.edges[0].pairs[0].fromField = 'missing';
  await assert.rejects(annotations.relationSave({ sourceId: 's', revision: oldRevision, canvas: invalid }), /不存在/);
  const empty = await annotations.relationSave({ sourceId: 's', revision: oldRevision, canvas: { name: '空草稿', content: { nodes: [], edges: [] } } });
  await assert.rejects(annotations.relationConfirm({ sourceId: 's', revision: empty.revision, canvasId: empty.canvas.id }), /至少/);
  await saveResults(annotations);
  await annotations.relationRemove({ sourceId: 's', revision: await revision(annotations), canvasId: empty.canvas.id });
  await assert.rejects(annotations.readSavedResults('s'), error => error.status === 409);
});
