import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationFlow } from '../flow.js';

function fixture({ fieldCount = 1, tableCount = 2, existing = [] } = {}) {
  const catalog = { revision: 'r1', tables: Array.from({ length: tableCount }, (_, i) => ({
    id: `t${i}`, name: `table_${i}`, annotation: { text: `业务表${i}`, status: 'confirmed' },
    fields: [...Array.from({ length: fieldCount }, (_, j) => ({ name: `f${j}`, type: 'int', enabled: true, ...(j === 0 ? { primaryKey: true, notNull: true } : {}), annotation: { text: `字段${j}` } })), { name: 'disabled', enabled: false }],
  })) };
  let binding, end, sent, saved;
  const ready = new Promise(resolve => { sent = resolve; });
  const service = {
    catalog: async () => structuredClone(catalog),
    relations: async () => ({ revision: catalog.revision, items: structuredClone(existing) }),
    bindSession: async (id, source) => { binding = { id, source }; return true; },
    assertSession: async (id, source) => { if (binding?.id !== id || binding?.source !== source) throw new Error('会话失效'); },
    retireSession: async () => { binding = null; },
    aiRelationSave: async input => {
      await service.assertSession(input.sessionId, input.sourceId);
      if (input.revision !== catalog.revision) throw new Error('版本失效');
      saved = structuredClone(input);
      return { revision: input.canvases.length ? 'r2' : 'r1', count: input.canvases.reduce((n, canvas) => n + canvas.relations.length, 0), canvasCount: input.canvases.length, canvasIds: input.canvases.map((_, i) => `new-canvas-${i}`), canvases: input.canvases };
    },
  };
  const bridge = { create: async () => ({ sessionId: 'session' }), observe: async input => { end = input.onEnd; return () => {}; }, send: async input => { bridge.text = input.text; sent(); }, cancel: async () => { bridge.cancelled = true; }, close: async () => {} };
  const flow = new AnnotationFlow({ service, bridge, timeoutMs: 5000 });
  const input = { sourceId: 's', revision: 'r1', kind: 'relation', items: catalog.tables.map(table => ({ tableId: table.id })) };
  const execution = { agent: { session: { id: 'session' } } };
  return { catalog, service, bridge, flow, input, execution, ready, get saved() { return saved; }, end: cause => end(cause) };
}
const relation = () => ({ fromTableId: 't0', toTableId: 't1', pairs: [{ fromField: 'f0', toField: 'f0' }], cardinality: '1:N' });
const theme = overrides => ({ name: '订单基础查询', description: '以订单为粒度，关联业务主体查看订单信息。', rootTableId: 't0', relations: [relation()], ...overrides });
const emptyResult = { revision: 'r1', count: 0, canvasCount: 0, canvasIds: [] };
async function readAll(f) {
  const pages = [];
  let cursor = 0;
  do { const page = await f.flow.task({ action: 'read', cursor }, f.execution); pages.push(page); cursor = page.nextCursor; } while (cursor !== null);
  return pages;
}

test('关系任务覆盖全部启用表及大表分页，未读完拒绝提交，零主题成功且无画布', async () => {
  const f = fixture({ fieldCount: 202 });
  const running = f.flow.run(f.input); await f.ready;
  assert.match(f.bridge.text, /不代表已发现真实外键/);
  assert.match(f.bridge.text, /canvases:\[\]/);
  assert.match(f.bridge.text, /业务查询主题/);
  assert.match(f.bridge.text, /业务粒度/);
  assert.match(f.bridge.text, /不要仅按连通分量/);
  assert.match(f.bridge.text, /不同主题可复用/);
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [] }, f.execution), /读取全部/);
  await f.flow.task({ action: 'read', cursor: 5 }, f.execution);
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [] }, f.execution), /读取全部/);
  const pages = await readAll(f);
  assert.equal(pages.length, 6);
  for (const page of pages) {
    assert.deepEqual(page, JSON.parse(JSON.stringify(page)));
    assert.ok(page.items.length <= 20);
    assert.ok(page.items.reduce((n, item) => n + item.fields.length, 0) <= 100);
    assert.ok(page.items.every(item => item.fields.every(field => field.name !== 'disabled')));
  }
  assert.equal(pages[0].items[0].table.annotation, '业务表0');
  assert.equal(pages[0].items[0].fields[0].primaryKey, true);
  assert.equal(pages[0].items[0].fields[1].primaryKey, null);
  assert.equal(pages[0].items[0].fields[1].notNull, null);
  await f.flow.task({ action: 'submit', canvases: [] }, f.execution);
  assert.deepEqual(await running, emptyResult);
  assert.deepEqual(f.saved.canvases, []);
  await f.flow.close();
});

test('已有主题包含主表与完整语义，多主题允许复用边并只增加必要关联表', async () => {
  const existing = [{ id: 'old', name: '已有画布', description: '业务粒度说明', confirmed: true, valid: true, content: { rootTableId: 't0', nodes: [{ tableId: 't0' }, { tableId: 't1' }], edges: [{ id: 'edge', ...relation() }] } }];
  const f = fixture({ tableCount: 21, existing });
  const running = f.flow.run(f.input); await f.ready;
  const pages = await readAll(f);
  assert.deepEqual(pages.map(page => page.items.length), [20, 1]);
  assert.deepEqual(pages[0].canvases, [{ ...existing[0], rootTableId: 't0' }]);
  const extension = { fromTableId: 't2', toTableId: 't0', pairs: [{ fromField: 'f0', toField: 'f0' }], cardinality: 'N:1' };
  const canvases = [theme(), theme({ name: '订单明细查询', description: '以订单明细为粒度，关联订单及主体。', rootTableId: 't2', relations: [relation(), extension] })];
  await f.flow.task({ action: 'submit', canvases }, f.execution);
  assert.deepEqual(await running, { revision: 'r2', count: 3, canvasCount: 2, canvasIds: ['new-canvas-0', 'new-canvas-1'] });
  assert.deepEqual(f.saved.canvases, canvases);
  assert.equal(f.saved.sessionId, 'session');
  assert.equal(f.saved.revision, 'r1');
  assert.equal(f.saved.relations, undefined);
  assert.deepEqual(existing[0].content.edges, [{ id: 'edge', ...relation() }]);
  await f.flow.close();
});

test('关系任务核对全表范围，拒绝旧协议、虚构字段、组内非法结构及AI设置状态', async () => {
  const f = fixture({ tableCount: 3 });
  for (const items of [f.input.items.slice(0, 1), f.input.items.slice(0, 2), [f.input.items[0], f.input.items[0]]]) await assert.rejects(f.flow.run({ ...f.input, items }));
  const running = f.flow.run(f.input); await f.ready; await readAll(f);
  const invalid = [
    { ...relation(), fromTableId: 'unknown' }, { ...relation(), toTableId: 't0' },
    { ...relation(), cardinality: 'N:N' }, { ...relation(), pairs: [] },
    { ...relation(), pairs: [{ fromField: 'disabled', toField: 'f0' }] },
    { ...relation(), pairs: [{ fromField: 'imaginary', toField: 'f0' }] },
    { ...relation(), pairs: [...relation().pairs, ...relation().pairs] },
    { ...relation(), confirmed: true }, { ...relation(), id: 'injected' }, { ...relation(), name: '边名称' },
  ];
  for (const item of invalid) await assert.rejects(f.flow.task({ action: 'submit', canvases: [theme({ relations: [item] })] }, f.execution));
  for (const override of [{ rootTableId: 'unknown' }, { rootTableId: 't2' }, { relations: [] }, { name: '' }, { description: ' ' }, { confirmed: true }, { id: 'injected' }, { layout: {} }]) await assert.rejects(f.flow.task({ action: 'submit', canvases: [theme(override)] }, f.execution));
  await assert.rejects(f.flow.task({ action: 'submit', relations: [] }, f.execution), /canvases/);
  await assert.rejects(f.flow.task({ action: 'submit', annotations: [], canvases: [] }, f.execution));
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [], relations: [] }, f.execution));
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [theme({ description: 'x'.repeat(1048576) })] }, f.execution), error => error.status === 413);
  assert.equal(f.saved, undefined);
  const schema = f.flow.getTool().parameters;
  assert.equal(schema.properties.relations, undefined);
  assert.deepEqual(schema.properties.canvases.items.required, ['name', 'description', 'rootTableId', 'relations']);
  await f.flow.task({ action: 'submit', canvases: [theme()] }, f.execution); await running;
  await f.flow.close();
});

test('整批主题校验通过才保存，拒绝与核心主表断开的关联组合', async () => {
  const f = fixture({ tableCount: 4 });
  const running = f.flow.run(f.input); await f.ready; await readAll(f);
  const disconnected = theme({ relations: [relation(), { ...relation(), fromTableId: 't2', toTableId: 't3' }] });
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [theme(), disconnected] }, f.execution), /核心主表可达/);
  assert.equal(f.saved, undefined, '后一组非法时不能保存前面的有效组');
  await f.flow.task({ action: 'submit', canvases: [] }, f.execution); await running; await f.flow.close();
});

test('关系保存取消竞态等待事务提交，成功结果采用存储实际去重数量', async () => {
  const f = fixture(), controller = new AbortController();
  let release, started;
  const saving = new Promise(resolve => { started = resolve; });
  f.service.aiRelationSave = async input => { started(); await new Promise(resolve => { release = resolve; }); await f.service.assertSession(input.sessionId, input.sourceId); return { ...emptyResult, canvases: [] }; };
  const running = f.flow.run(f.input, controller.signal); await f.ready; await readAll(f);
  const submitting = f.flow.task({ action: 'submit', canvases: [theme()] }, f.execution);
  await saving; controller.abort(); await f.service.assertSession('session', 's'); release(); await submitting;
  assert.deepEqual(await running, emptyResult);
  assert.equal(f.bridge.cancelled, undefined);
  await f.flow.close();
});

test('关系保存版本与会话保护沿用原流程，失败不会产生成功结果', async () => {
  const f = fixture();
  const running = f.flow.run(f.input); await f.ready; await readAll(f);
  await assert.rejects(f.flow.task({ action: 'read' }, { agent: { session: { id: 'other' } } }), /仅接受/);
  f.catalog.revision = 'r2';
  await assert.rejects(f.flow.task({ action: 'submit', canvases: [theme()] }, f.execution), /版本失效/);
  assert.equal(f.saved, undefined);
  f.end(); await assert.rejects(running, /未提交/); await f.flow.close();
});
