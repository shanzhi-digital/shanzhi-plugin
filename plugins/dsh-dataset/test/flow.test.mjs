import test from 'node:test';
import assert from 'node:assert/strict';
import { QuestionFlow } from '../flow.js';
import { AiTasks } from '../ai-tasks.js';
import { createRoutes } from '../routes.js';
import { apply, inject } from '../index.js';

const table = { tableId: 't1', name: 'beds', schema: 'main', fields: [{ name: 'count', type: 'INTEGER' }], structureHash: 'hash' };
const rows = [
  { id: 'q1', version: 1, text: '床位总数是多少？', answer: '', origin: 'generated', links: [] },
  { id: 'q2', version: 2, text: '床位平均数是多少？', answer: '已有答案', origin: 'original', links: [] },
];
const refs = rows.map(({ id, version }) => ({ id, version }));
function fixture(script) {
  let flow, commits = [], calls = [], reports = [], prompts = [], operation, end;
  const bridge = {
    async create() { return { sessionId: 's1' }; },
    async observe({ onEnd }) { end = onEnd; return async () => {}; },
    async send({ text }) { prompts.push(text); try { await script({ call: (value) => flow.task(value, { agent: { session: { id: 's1' } } }), end }); } catch (error) { end(error); } return { accepted: true }; },
    async cancel() { calls.push('cancel'); }, async close() {},
  };
  const store = { async list() { return structuredClone(rows); }, async commit(input) { commits.push(structuredClone(input)); } };
  const query = { async schema() { return { sourceId: 'source', name: 'source', engine: 'sqlite', tables: [table] }; }, async query(sourceId, sql) { calls.push({ sourceId, sql }); if (sql === 'broken') throw new Error('SQL失败'); return { columns: ['total'], rows: [[12]], rowCount: 1, truncated: false, tables: [table] }; } };
  flow = new QuestionFlow({ store, query, bridge, cwd: process.cwd(), timeoutMs: 2000 });
  const run = (input = { sourceId: 'source', questions: refs }, signal = new AbortController().signal, taskId = 'task1') => flow.run(input, signal, update => { operation = update; reports.push(structuredClone(update)); }, taskId);
  return { flow, run, commits, calls, reports, prompts, store, query, latest: () => operation };
}
async function plan(call) {
  await call({ operation: 'read' });
  return (await call({ operation: 'plan', candidates: [{ text: '床位最大值是多少？' }], reason: '当前仅有床位指标，生成一个可查询候选。' })).items;
}
async function answer(call, item) {
  const result = await call({ operation: 'query', itemId: item.id, sql: 'SELECT sum(count) FROM beds' });
  await call({ operation: 'answer', itemId: item.id, answer: '床位合计12张。', queryIds: [result.queryId] });
}

test('任务按真实阶段报告进度，答案或失败才计入已处理，重试沿用提示词快照', async () => {
  let iteration = 0;
  const fx = fixture(async ({ call }) => {
    if (iteration++ === 0) {
      const items = await plan(call);
      await answer(call, items[0]);
      await call({ operation: 'fail-item', itemId: items[1].id, error: '缺少维度' });
    } else {
      const { items } = await call({ operation: 'read' });
      for (const item of items) await answer(call, item);
    }
    await call({ operation: 'finish' });
  });
  await fx.run({ sourceId: 'source', questions: refs, prompt: '只围绕养老床位提问，每条答案只写结论。' });
  const progress = fx.reports.filter(report => report.progress).map(report => report.progress);
  assert.equal(progress[0].phase, 'reading');
  assert.equal(progress[0].total, null);
  assert.ok(progress.some(value => value.phase === 'planning' && value.total === null));
  assert.ok(progress.some(value => value.phase === 'answering' && value.total === 2 && value.completed === 0));
  assert.ok(progress.some(value => value.completed === 1 && value.success === 1 && value.failed === 0));
  assert.deepEqual(progress.at(-1), { phase: 'done', completed: 2, total: 2, success: 1, failed: 1 });
  const retry = fx.flow.retry('task1');
  assert.equal(retry.prompt, '只围绕养老床位提问，每条答案只写结论。');
  await fx.run(retry, new AbortController().signal, 'task2');
  assert.ok(fx.prompts.every(prompt => prompt.includes(retry.prompt)));
  assert.equal(fx.reports.at(-1).progress.failed, 0);
});

test('用户可降低泛化数量且无需为正常数量提供不足原因', async () => {
  const fx = fixture(async ({ call }) => {
    await call({ operation: 'read' });
    const { items } = await call({ operation: 'plan', candidates: [{ text: '床位最小值是多少？' }] });
    for (const item of items) await answer(call, item);
    await call({ operation: 'finish' });
  });
  const result = await fx.run({ sourceId: 'source', questions: refs, prompt: '只生成1个问题。' });
  assert.equal(result.candidates.length, 1);
});

test('任务快照返回进度副本，观察和离页不会改变后台状态', async () => {
  let done;
  const wait = new Promise(resolve => { done = resolve; });
  const tasks = new AiTasks({ identify: () => ({ sourceId: 's', kind: 'generalize' }), execute: async (_input, _signal, report) => {
    report({ progress: { phase: 'answering', completed: 1, total: 2, success: 1, failed: 0 } });
    await wait;
    return {};
  } });
  const started = tasks.start({});
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = tasks.get(started.taskId);
  snapshot.progress.completed = 99;
  assert.equal(tasks.latest('s').progress.completed, 1);
  assert.equal(tasks.get(started.taskId).status, 'running');
  done();
  await tasks.tasks.get(started.taskId).done;
  await tasks.close();
});

test('任意来源问题泛化、补答并以真实查询结果形成三项结果，已有答案不改写', async () => {
  const fx = fixture(async ({ call }) => {
    const items = await plan(call);
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'q1');
    for (const item of items) await answer(call, item);
    await call({ operation: 'finish' });
  });
  const result = await fx.run();
  assert.equal(fx.calls.length, 2);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].answer, '床位合计12张。');
  assert.equal(result.candidates[0].links[0].tableId, 't1');
  assert.equal(result.candidates[0].links[0].tableName, 'beds');
  assert.equal(fx.commits.length, 0, '完成任务不直接写共享库');
  await fx.flow.save({ taskId: 'task1', candidateIds: [result.candidates[0].id], updateIds: ['q1'] });
  assert.equal(fx.commits.length, 1);
  assert.deepEqual(fx.commits[0].references, refs);
  assert.equal(fx.commits[0].sourceId, 'source');
  await assert.rejects(fx.flow.save({ taskId: 'task1', updateIds: ['q1'] }), /已保存/);
});

test('拒绝没有查询证据、伪造查询ID以及引用其它问题的查询结果', async () => {
  const fx = fixture(async ({ call }) => {
    const items = await plan(call);
    await assert.rejects(call({ operation: 'answer', itemId: items[0].id, answer: '12', queryIds: [] }), /成功查询/);
    await assert.rejects(call({ operation: 'answer', itemId: items[0].id, answer: '12', queryIds: ['fake'] }), /不属于/);
    const result = await call({ operation: 'query', itemId: items[0].id, sql: 'SELECT count FROM beds' });
    await assert.rejects(call({ operation: 'answer', itemId: items[1].id, answer: '12', queryIds: [result.queryId] }), /不属于/);
    for (const item of items) await call({ operation: 'fail-item', itemId: item.id, error: '缺少统计口径' });
    await call({ operation: 'finish' });
  });
  const result = await fx.run();
  assert.ok(result.updates[0].error);
  await assert.rejects(fx.flow.save({ taskId: 'task1', updateIds: ['q1'] }), /成功查询/);
});

test('失败条目可重试，成功候选保留且候选不重新泛化', async () => {
  let stage = 0;
  const fx = fixture(async ({ call }) => {
    if (stage++ === 0) {
      const items = await plan(call);
      await call({ operation: 'fail-item', itemId: items[0].id, error: '查询失败' });
      await answer(call, items[1]);
    } else {
      const { items } = await call({ operation: 'read' });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, 'q1');
      await assert.rejects(call({ operation: 'plan', candidates: [] }), /不可重复/);
      await answer(call, items[0]);
    }
    await call({ operation: 'finish' });
  });
  const first = await fx.run();
  const retry = fx.flow.retry('task1');
  fx.flow.retire('task1');
  const second = await fx.run(retry, new AbortController().signal, 'task2');
  assert.equal(second.candidates[0].id, first.candidates[0].id);
  assert.equal(second.candidates[0].answer, first.candidates[0].answer);
  assert.equal(second.updates[0].answer, '床位合计12张。');
  await assert.rejects(fx.flow.save({ taskId: 'task1', candidateIds: [first.candidates[0].id] }), /失效/);
});

test('成功空结果可回答无记录，查询异常不会生成成功查询证据', async () => {
  const fx = fixture(async ({ call }) => {
    const items = await plan(call);
    await assert.rejects(call({ operation: 'query', itemId: items[0].id, sql: 'broken' }), /SQL失败/);
    await call({ operation: 'fail-item', itemId: items[0].id, error: '数据库查询失败' });
    const result = await call({ operation: 'query', itemId: items[1].id, sql: 'SELECT count FROM beds' });
    await call({ operation: 'answer', itemId: items[1].id, answer: '未查到符合条件的数据。', queryIds: [result.queryId] });
    await call({ operation: 'finish' });
  });
  fx.query.query = async (_id, sql) => { if (sql === 'broken') throw new Error('SQL失败'); return { columns: ['count'], rows: [], rowCount: 0, truncated: false, tables: [table] }; };
  const result = await fx.run();
  assert.equal(result.candidates[0].answer, '未查到符合条件的数据。');
  assert.ok(result.updates[0].error);
});

test('问题版本冲突在创建会话前拒绝，取消任务不产生可保存草稿', async () => {
  const fx = fixture(async () => {});
  await assert.rejects(fx.run({ sourceId: 'source', questions: [{ id: 'q1', version: 99 }] }), /已更新/);
  const controller = new AbortController();
  const running = fx.run(undefined, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(running, /取消/);
  assert.equal(fx.flow.drafts.size, 0);
  assert.ok(fx.calls.includes('cancel'));
});

test('插件不依赖旧服务即可注册独立接口及工具，未配置管理库返回明确错误', async () => {
  const routes = [], tools = [], handlers = {};
  const ctx = {
    credentials: { async readRecord() { return undefined; } },
    connection: { fetch: { register(route) { routes.push(route); } } },
    tools: { register(tool) { tools.push(tool); } },
    on(event, handler) { handlers[event] = handler; },
  };
  assert.equal(inject.includes('datasourceCatalog'), false);
  await apply(ctx);
  assert.equal(tools[0].name, 'question_set_task');
  assert.ok(routes.every(route => route.path.startsWith('/api/question-set/')));
  const response = await routes.find(route => route.path.endsWith('/questions')).fetch(new Request('http://localhost/api/question-set/questions'));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /管理库/);
  await handlers.dispose();
  const closed = await routes.find(route => route.path.endsWith('/questions')).fetch(new Request('http://localhost/api/question-set/questions'));
  assert.equal(closed.status, 503);
  assert.match((await closed.json()).error, /已关闭/);
});

test('失败或取消任务可丢弃，重新加载不会恢复旧结果', async () => {
  const fx = fixture(async () => {});
  const tasks = new AiTasks({ validate: input => fx.flow.validate(input), identify: input => ({ sourceId: input.sourceId, kind: 'generalize' }), execute: async () => { throw new Error('失败'); } });
  const task = tasks.start({ sourceId: 'source', questions: refs });
  await tasks.tasks.get(task.taskId).done;
  const routes = createRoutes({ store: fx.store, query: fx.query, flow: fx.flow, tasks });
  const discard = routes.find(route => route.path.endsWith('/results-discard'));
  assert.equal((await discard.fetch(new Request('http://localhost/api/question-set/results-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.taskId }) }))).status, 200);
  const get = routes.find(route => route.path.endsWith('/ai-tasks'));
  const response = await get.fetch(new Request(`http://localhost/api/question-set/ai-tasks?sourceId=source`));
  assert.equal((await response.json()).task.resultState, 'discarded');
  await tasks.close();
});

test('任务路由直接接收任意来源问题并隔离内部重试种子', async () => {
  const fx = fixture(async ({ call }) => { for (const item of await plan(call)) await answer(call, item); await call({ operation: 'finish' }); });
  const tasks = new AiTasks({ validate: input => fx.flow.validate(input), identify: input => ({ sourceId: input.sourceId, kind: 'generalize' }), execute: (...args) => fx.flow.run(...args) });
  const routes = createRoutes({ store: fx.store, query: fx.query, flow: fx.flow, tasks });
  const endpoint = routes.find(route => route.path === '/api/question-set/ai-tasks');
  const request = value => new Request('http://localhost/api/question-set/ai-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const invalid = await endpoint.fetch(request({ sourceId: 'source', questions: refs, seed: {} }));
  assert.equal(invalid.status, 400);
  const response = await endpoint.fetch(request({ sourceId: 'source', questions: refs }));
  assert.equal(response.status, 202);
  const { task } = await response.json();
  await tasks.tasks.get(task.taskId).done;
  assert.equal(tasks.get(task.taskId).status, 'succeeded');
  await tasks.close();
});

test('独立查询重新回答全部所选问题，不生成候选且保存前保留原数据', async () => {
  const fx = fixture(async ({ call }) => {
    const { items } = await call({ operation: 'read' });
    assert.deepEqual(items.map(item => item.id), ['q1', 'q2']);
    assert.ok(items.every(item => item.answer === ''));
    await assert.rejects(call({ operation: 'plan', candidates: [{ text: '不应新增的问题' }] }), /不能生成候选/);
    await assert.rejects(call({ operation: 'answer', itemId: 'q2', answer: '旧答案', queryIds: [] }), /成功查询/);
    for (const item of items) await answer(call, item);
    await call({ operation: 'finish' });
  });
  const result = await fx.run({ kind: 'answer', sourceId: 'source', questions: refs });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.updates.length, 2);
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.commits.length, 0);
  assert.equal((await fx.store.list())[1].answer, '已有答案');
  assert.ok(fx.reports.every(report => report.progress?.phase !== 'planning'));
  assert.match(fx.prompts[0], /不调用 plan/);
  assert.doesNotMatch(fx.prompts[0], /15～20|已存在的答案不改写/);
  await fx.flow.save({ taskId: 'task1', updateIds: ['q2'] });
  assert.deepEqual(fx.commits[0].updates.map(item => item.id), ['q2']);
  assert.equal(fx.commits[0].updates[0].links[0].tableId, 't1');
  assert.deepEqual(fx.commits[0].candidates, []);
});

test('独立查询失败保留旧答案，重试保留类型及成功项，仅重查失败项', async () => {
  let stage = 0;
  const fx = fixture(async ({ call }) => {
    const { items } = await call({ operation: 'read' });
    if (stage++ === 0) {
      await answer(call, items[0]);
      await assert.rejects(call({ operation: 'query', itemId: 'q2', sql: 'broken' }), /SQL失败/);
      await call({ operation: 'fail-item', itemId: 'q2', error: '数据库查询失败' });
    } else {
      assert.deepEqual(items.map(item => item.id), ['q2']);
      await answer(call, items[0]);
    }
    await call({ operation: 'finish' });
  });
  const first = await fx.run({ kind: 'answer', sourceId: 'source', questions: refs });
  assert.equal((await fx.store.list())[1].answer, '已有答案');
  await assert.rejects(fx.flow.save({ taskId: 'task1', updateIds: ['q2'] }), /成功查询/);
  const retry = fx.flow.retry('task1');
  assert.equal(retry.kind, 'answer');
  const second = await fx.run(retry, new AbortController().signal, 'task2');
  assert.deepEqual(second.updates[0], first.updates[0]);
  assert.equal(second.updates[1].answer, '床位合计12张。');
  assert.deepEqual(second.candidates, []);
  assert.match(fx.prompts[1], /本次是失败项重试/);
  assert.doesNotMatch(fx.prompts[1], /15～20/);
});

test('查询任务路由校验类型，快照及恢复返回 answer 类型并保持同源互斥', async t => {
  const fx = fixture(async ({ call }) => {
    for (const item of (await call({ operation: 'read' })).items) await answer(call, item);
    await call({ operation: 'finish' });
  });
  const tasks = new AiTasks({ validate: input => fx.flow.validate(input), identify: input => ({ sourceId: input.sourceId, kind: input.kind ?? 'generalize' }), execute: (...args) => fx.flow.run(...args) });
  t.after(() => tasks.close());
  const endpoint = createRoutes({ store: fx.store, query: fx.query, flow: fx.flow, tasks }).find(route => route.path.endsWith('/ai-tasks'));
  const request = value => new Request('http://localhost/api/question-set/ai-tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  for (const kind of ['invalid', '', 1]) assert.equal((await endpoint.fetch(request({ sourceId: 'source', questions: refs, kind }))).status, 400);
  const response = await endpoint.fetch(request({ sourceId: 'source', questions: refs, kind: 'answer' }));
  assert.equal(response.status, 202);
  const { task } = await response.json();
  assert.equal(task.kind, 'answer');
  const conflict = await endpoint.fetch(request({ sourceId: 'source', questions: refs }));
  assert.equal(conflict.status, 409);
  await tasks.tasks.get(task.taskId).done;
  const restored = await (await endpoint.fetch(new Request('http://localhost/api/question-set/ai-tasks?sourceId=source'))).json();
  assert.equal(restored.task.kind, 'answer');
  assert.equal(restored.task.status, 'succeeded');
  assert.deepEqual(restored.task.result.candidates, []);
});
