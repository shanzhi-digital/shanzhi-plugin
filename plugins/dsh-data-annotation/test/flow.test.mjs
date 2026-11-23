import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotationFlow } from '../flow.js';

function fixture() {
  const catalog = { source: { id: 's' }, revision: 'sha-one', tables: [{ id: 't', name: 'orders', annotation: { status: 'missing', text: '表说明' }, fields: [{ name: 'id', type: 'int', enabled: true, annotation: { status: 'missing' } }, { name: 'hidden', enabled: false, annotation: { status: 'missing' } }] }] };
  let binding, onEnd;
  const service = {
    catalog: async () => structuredClone(catalog),
    bindSession: async (id, source) => { binding = { id, source }; return true; },
    retireSession: async () => { binding = null; },
    assertSession: async (id, source) => { if (binding?.id !== id || binding?.source !== source) throw new Error('会话失效'); },
    aiSave: async input => { await service.assertSession(input.sessionId, input.sourceId); if (input.revision !== catalog.revision) throw new Error('版本失效'); return { ...structuredClone(catalog), saved: input.items }; },
  };
  let ready;
  const sent = new Promise(resolve => { ready = resolve; });
  const bridge = { create: async () => ({ sessionId: 'session' }), observe: async input => { onEnd = input.onEnd; return async () => {}; }, send: async input => { bridge.sentText = input.text; ready(); }, cancel: async () => { bridge.cancelled = true; }, close: async () => {} };
  const flow = new AnnotationFlow({ service, bridge, timeoutMs: 1000 });
  const input = { sourceId: 's', revision: 'sha-one', kind: 'field', items: [{ tableId: 't', fieldName: 'id' }] };
  const execution = { agent: { id: 'different-agent', session: { id: 'session' } } };
  return { catalog, service, bridge, flow, input, execution, sent, end: cause => onEnd(cause) };
}

test('读取选择范围并保存完整标注，提交期间结束事件不抢先失败', async () => {
  const f = fixture();
  const run = f.flow.run(f.input);
  await f.sent;
  assert.match(f.bridge.sentText, /共选中 1 个字段/);
  assert.match(f.bridge.sentText, /正好为 1 条/);
  assert.match(f.bridge.sentText, /不超过 20 字/);
  assert.match(f.bridge.sentText, /自然说明/);
  const tool = f.flow.getTool();
  const page = await tool.execute({ action: 'read' }, f.execution);
  assert.deepEqual(page, JSON.parse(JSON.stringify(page)), '字段读取结果必须能无损往返 JSON');
  assert.deepEqual(page.items[0].field, { name: 'id', type: 'int', sourceComment: '' });
  assert.deepEqual(page.items.map(item => item.field.name), ['id']);
  assert.equal(page.items[0].table.annotation, '表说明');
  const save = f.service.aiSave;
  f.service.aiSave = async input => { f.end(); return save(input); };
  assert.deepEqual(await tool.execute({ action: 'submit', annotations: [{ tableId: 't', fieldName: 'id', text: '标识' }] }, f.execution), { ok: true });
  assert.equal((await run).saved[0].text, '标识');
  await f.flow.close();
});

test('拒绝遗漏、虚构对象和会话越权', async () => {
  const f = fixture();
  const run = f.flow.run(f.input);
  await f.sent;
  const tool = f.flow.getTool();
  await assert.rejects(tool.execute({ action: 'submit', annotations: [] }, f.execution));
  await assert.rejects(tool.execute({ action: 'submit', annotations: [{ tableId: 't', fieldName: 'id', text: 'a' }, { tableId: 't', fieldName: 'id', text: 'b' }] }, f.execution), /实际收到 2 条/);
  await assert.rejects(tool.execute({ action: 'submit', annotations: [{ tableId: 't', text: 'a' }] }, f.execution), /缺少 fieldName/);
  await assert.rejects(tool.execute({ action: 'submit', annotations: [{ tableId: 't', fieldName: 'hidden', text: 'x' }] }, f.execution));
  await assert.rejects(tool.execute({ action: 'read' }, { agent: { id: 'session', session: { id: 'other' } } }));
  await assert.rejects(tool.execute({ action: 'read' }, { agent: { id: 'session' } }));
  f.end();
  await assert.rejects(run, /未提交/);
  assert.equal(f.bridge.cancelled, true);
  await f.flow.close();
});

test('取消使会话失效，关闭会取消运行中的任务', async () => {
  const f = fixture();
  const controller = new AbortController();
  const run = f.flow.run(f.input, controller.signal);
  await f.sent;
  controller.abort();
  await assert.rejects(run, /取消/);
  await assert.rejects(f.flow.getTool().execute({ action: 'read' }, f.execution));
  await f.flow.close();
  const other = fixture();
  const running = other.flow.run(other.input);
  await other.sent;
  const closing = other.flow.close();
  await assert.rejects(running, /取消/);
  await closing;
});

test('保存时版本失效拒绝，结束时未提交拒绝', async () => {
  const f = fixture();
  const run = f.flow.run(f.input);
  await f.sent;
  f.catalog.revision = 'sha-two';
  await assert.rejects(f.flow.getTool().execute({ action: 'submit', annotations: [{ tableId: 't', fieldName: 'id', text: '标识' }] }, f.execution), /版本失效/);
  f.end();
  await assert.rejects(run, /未提交/);
  await f.flow.close();
});

test('表结构按百字段分片且不暴露停用字段', async () => {
  const f = fixture();
  f.catalog.tables[0].fields.push(...Array.from({ length: 201 }, (_, i) => ({ name: `field${i}`, type: 'text', enabled: true })));
  const run = f.flow.run({ ...f.input, kind: 'table', items: [{ tableId: 't' }] });
  await f.sent;
  assert.match(f.bridge.sentText, /共选中 1 张表/);
  assert.match(f.bridge.sentText, /不要包含 fieldName/);
  assert.match(f.bridge.sentText, /不超过 40 字/);
  assert.match(f.bridge.sentText, /自然描述/);
  const tool = f.flow.getTool();
  const pages = [];
  let cursor = 0;
  do {
    const page = await tool.execute({ action: 'read', cursor }, f.execution);
    assert.deepEqual(page, JSON.parse(JSON.stringify(page)), '每页表读取结果必须能无损往返 JSON');
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(pages.map(page => page.items[0].fields.length), [100, 100, 2]);
  assert.deepEqual(pages.map(page => page.items[0].fieldOffset), [0, 100, 200]);
  assert.ok(pages.every(page => page.items[0].fields.every(field => field.name !== 'hidden')));
  await assert.rejects(tool.execute({ action: 'submit', annotations: [{ tableId: 't', fieldName: 'id', text: '表说明' }] }, f.execution), /不应包含 fieldName/);
  await tool.execute({ action: 'submit', annotations: [{ tableId: 't', text: '表说明' }] }, f.execution);
  await run;
  await f.flow.close();
});

test('初始校验拒绝停用、重复及已确认对象', async () => {
  const f = fixture();
  await assert.rejects(f.flow.run({ ...f.input, items: [{ tableId: 't', fieldName: 'hidden' }] }));
  await assert.rejects(f.flow.run({ ...f.input, items: [...f.input.items, ...f.input.items] }));
  f.catalog.tables[0].fields[0].annotation.status = 'confirmed';
  await assert.rejects(f.flow.run(f.input));
  await f.flow.close();
});
