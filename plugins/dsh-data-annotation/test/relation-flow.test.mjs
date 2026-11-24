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
      return { revision: input.relations.length ? 'r2' : 'r1', canvas: input.relations.length ? { id: 'new-canvas' } : null, count: input.relations.length };
    },
  };
  const bridge = { create: async () => ({ sessionId: 'session' }), observe: async input => { end = input.onEnd; return () => {}; }, send: async input => { bridge.text = input.text; sent(); }, cancel: async () => { bridge.cancelled = true; }, close: async () => {} };
  const flow = new AnnotationFlow({ service, bridge, timeoutMs: 5000 });
  const input = { sourceId: 's', revision: 'r1', kind: 'relation', items: catalog.tables.map(table => ({ tableId: table.id })) };
  const execution = { agent: { session: { id: 'session' } } };
  return { catalog, service, bridge, flow, input, execution, ready, get saved() { return saved; }, end: cause => end(cause) };
}
const relation = () => ({ fromTableId: 't0', toTableId: 't1', pairs: [{ fromField: 'f0', toField: 'f0' }], cardinality: '1:N', name: '业务关系' });
async function readAll(f) {
  const pages = [];
  let cursor = 0;
  do { const page = await f.flow.task({ action: 'read', cursor }, f.execution); pages.push(page); cursor = page.nextCursor; } while (cursor !== null);
  return pages;
}

test('关系任务覆盖全部启用表及大表分页，未读完拒绝提交，零建议成功且无画布', async () => {
  const f = fixture({ fieldCount: 202 });
  const running = f.flow.run(f.input); await f.ready;
  assert.match(f.bridge.text, /不代表已发现真实外键/);
  assert.match(f.bridge.text, /relations:\[\]/);
  await assert.rejects(f.flow.task({ action: 'submit', relations: [] }, f.execution), /读取全部/);
  await f.flow.task({ action: 'read', cursor: 5 }, f.execution);
  await assert.rejects(f.flow.task({ action: 'submit', relations: [] }, f.execution), /读取全部/);
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
  await f.flow.task({ action: 'submit', relations: [] }, f.execution);
  assert.deepEqual(await running, { revision: 'r1', count: 0, canvasId: null });
  assert.deepEqual(f.saved.relations, []);
  await f.flow.close();
});

test('关系任务每页不超过20表，且完整保留现有关系摘要', async () => {
  const existing = [{ id: 'old', name: '已有画布', confirmed: true, valid: true, content: { edges: [relation()] } }];
  const f = fixture({ tableCount: 21, existing });
  const running = f.flow.run(f.input); await f.ready;
  const pages = await readAll(f);
  assert.deepEqual(pages.map(page => page.items.length), [20, 1]);
  assert.deepEqual(pages[0].relations, [{ id: 'old', name: '已有画布', confirmed: true, valid: true, edges: [relation()] }]);
  await f.flow.task({ action: 'submit', relations: [relation(), { ...relation(), cardinality: '1:1', pairs: [{ fromField: 'f0', toField: 'f0' }] }] }, f.execution);
  assert.deepEqual(await running, { revision: 'r2', count: 2, canvasId: 'new-canvas' });
  assert.equal(f.saved.sessionId, 'session');
  assert.equal(f.saved.revision, 'r1');
  await f.flow.close();
});

test('关系任务核对全表范围，拒绝单表、部分表、重复表和非法字段', async () => {
  const f = fixture({ tableCount: 3 });
  for (const items of [f.input.items.slice(0, 1), f.input.items.slice(0, 2), [f.input.items[0], f.input.items[0]]]) await assert.rejects(f.flow.run({ ...f.input, items }));
  const running = f.flow.run(f.input); await f.ready; await readAll(f);
  const invalid = [
    { ...relation(), fromTableId: 'unknown' },
    { ...relation(), toTableId: 't0' },
    { ...relation(), cardinality: 'N:N' },
    { ...relation(), pairs: [] },
    { ...relation(), pairs: [{ fromField: 'disabled', toField: 'f0' }] },
    { ...relation(), pairs: [{ fromField: 'imaginary', toField: 'f0' }] },
    { ...relation(), pairs: [...relation().pairs, ...relation().pairs] },
    { ...relation(), confirmed: true },
    { ...relation(), id: 'injected' },
    { ...relation(), layout: {} },
  ];
  for (const item of invalid) await assert.rejects(f.flow.task({ action: 'submit', relations: [item] }, f.execution));
  await assert.rejects(f.flow.task({ action: 'submit', annotations: [], relations: [] }, f.execution));
  await assert.rejects(f.flow.task({ action: 'submit', relations: [{ ...relation(), description: 'x'.repeat(1048576) }] }, f.execution), error => error.status === 413);
  assert.equal(f.saved, undefined);
  await f.flow.task({ action: 'submit', relations: [relation()] }, f.execution); await running;
  await f.flow.close();
});

test('关系保存取消竞态等待事务提交，成功结果采用存储实际去重数量', async () => {
  const f = fixture(), controller = new AbortController();
  let release, started;
  const saving = new Promise(resolve => { started = resolve; });
  f.service.aiRelationSave = async input => { started(); await new Promise(resolve => { release = resolve; }); await f.service.assertSession(input.sessionId, input.sourceId); return { revision: 'r1', count: 0, canvas: null }; };
  const running = f.flow.run(f.input, controller.signal); await f.ready; await readAll(f);
  const submitting = f.flow.task({ action: 'submit', relations: [relation()] }, f.execution);
  await saving; controller.abort(); await f.service.assertSession('session', 's'); release(); await submitting;
  assert.deepEqual(await running, { revision: 'r1', count: 0, canvasId: null });
  assert.equal(f.bridge.cancelled, undefined);
  await f.flow.close();
});

test('关系保存版本与会话保护沿用原流程，失败不会产生成功结果', async () => {
  const f = fixture();
  const running = f.flow.run(f.input); await f.ready; await readAll(f);
  await assert.rejects(f.flow.task({ action: 'read' }, { agent: { session: { id: 'other' } } }), /仅接受/);
  f.catalog.revision = 'r2';
  await assert.rejects(f.flow.task({ action: 'submit', relations: [relation()] }, f.execution), /版本失效/);
  assert.equal(f.saved, undefined);
  f.end(); await assert.rejects(running, /未提交/); await f.flow.close();
});
