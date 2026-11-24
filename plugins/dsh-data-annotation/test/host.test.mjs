import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { registerRoutes } from '../routes.js';
import { AnnotationFlow } from '../flow.js';
import { AiTasks } from 'dsh-sql/ai-tasks';
import { createDatasourceService } from 'dsh-sql/service.js';

function host(service, tasks) {
  const dsh = new Map(), internal = new Map();
  const registration = map => route => { map.set(route.path, route); return () => map.delete(route.path); };
  const unregister = registerRoutes({ connection: { fetch: { register: registration(dsh) } }, datasourceHttp: { register: registration(internal) } }, service, tasks);
  async function call(path, body, transport = dsh, signal) {
    const route = transport.get('/api/data-annotation/' + path.split('?')[0]);
    return route.fetch(new Request('http://local/api/data-annotation/' + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal }));
  }
  return { dsh, internal, call, unregister };
}

function taskFixture(execute) {
  const flow = new AnnotationFlow({ service: {}, bridge: {} });
  return new AiTasks({ execute, identify: input => ({ sourceId: input.sourceId, kind: input.kind }), validate: input => flow.validate(input) });
}
const taskInput = { sourceId: 's', revision: 'sha-revision', kind: 'table', items: [{ tableId: 't' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function pageFixture(initialTask) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  const catalog = { source: { id: 's', name: '业务库' }, revision: 'sha-revision', tables: [{ id: 't', name: 'orders', annotation: { status: 'missing', text: '' }, fields: [] }] };
  let currentTask = initialTask, page, tree, cursor, dirty = true, timerId = 0, pendingPoll;
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; dirty = true; }];
    },
    useRef(value) { const index = cursor++; return hooks[index] ||= { current: value }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        const state = { deps, cleanup: previous?.cleanup }; hooks[index] = state;
        effects.push(() => { state.cleanup?.(); state.cleanup = effect(); });
      }
    },
  };
  const context = {
    AbortController, Date, setInterval: () => 1, clearInterval() {},
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    window: { __ModuleLoader__: { load(module) { module.factory(() => React).apply({ slots: { inject: (_name, callback) => callback(), register(options, component) { if (options.key === 'data-annotation') page = component; } } }); } } },
    fetch: async (path, init) => {
      requests.push({ path, init });
      if (path.endsWith('/sources')) return Response.json({ items: [{ id: 's', name: '业务库', enabledTableCount: 1 }] });
      if (path.endsWith('/catalog')) return Response.json(catalog);
      if (path.endsWith('/ai-tasks')) { currentTask = runningTask; throw new TypeError('Failed to fetch'); }
      if (path.includes('?sourceId=')) return Response.json({ task: currentTask });
      if (path.includes('?taskId=')) { if (pendingPoll) return pendingPoll(init.signal); return Response.json({ task: currentTask }); }
      if (path.endsWith('/cancel')) { currentTask = { ...currentTask, status: 'cancelling' }; return Response.json({ task: currentTask }); }
      throw new Error('意外页面请求: ' + path);
    },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context);
  async function flush() {
    for (let count = 0; count < 12; count++) {
      if (dirty) { dirty = false; cursor = 0; tree = page(); for (const effect of effects.splice(0)) effect(); }
      await tick();
      if (!dirty) break;
    }
  }
  function walk(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(child => walk(child))]; }
  const nodes = () => walk(tree);
  function button(text) { const node = nodes().find(node => node.type === 'button' && node.children.includes(text)); assert.ok(node, '未找到按钮: ' + text); return node; }
  const dispose = () => { for (const hook of hooks) hook?.cleanup?.(); };
  await flush();
  return { requests, timers, flush, dispose, button, nodes, setTask: value => { currentTask = value; }, holdPoll: handler => { pendingPoll = handler; }, async poll() { const [id, callback] = timers.entries().next().value; timers.delete(id); callback(); await flush(); } };
}
const runningTask = { taskId: 'task', sourceId: 's', kind: 'table', status: 'running', startedAt: new Date(Date.now() - 65000).toISOString(), finishedAt: null, error: null };

test('页面重进恢复任务，串行轮询并在卸载时只停止观察', async () => {
  const p = await pageFixture(runningTask);
  p.button('标注').props.onClick(); await p.flush();
  assert.ok(p.requests.some(request => request.path.endsWith('ai-tasks?sourceId=s')));
  const status = p.nodes().find(node => node.props.role === 'status');
  assert.match(status.children.join(''), /AI 标注中 · 6\d 秒/);
  let completePoll, pollingSignal;
  p.holdPoll(signal => { pollingSignal = signal; return new Promise(resolve => { completePoll = resolve; }); });
  await p.poll();
  assert.equal(p.timers.size, 0, '前一次查询结束前不能安排下一次查询');
  p.dispose(); assert.equal(pollingSignal.aborted, true);
  completePoll(Response.json({ task: runningTask })); await tick();
  assert.equal(p.requests.some(request => request.path.endsWith('/cancel')), false);
  assert.equal(p.timers.size, 0);
});

test('任务受理响应丢失后按source恢复观察，不自动重复发起', async () => {
  const p = await pageFixture(null);
  p.button('标注').props.onClick(); await p.flush();
  const checkbox = p.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '选择 orders');
  checkbox.props.onChange({ target: { checked: true } }); await p.flush();
  p.button('AI 辅助').props.onClick(); await p.flush();
  assert.equal(p.requests.filter(request => request.path.endsWith('/ai-tasks')).length, 1);
  assert.equal(p.requests.filter(request => request.path.includes('?sourceId=s')).length, 2);
  assert.ok(p.button('取消标注'));
  p.dispose();
});

test('页面显式取消任务，任务成功后重新读取catalog', async () => {
  const p = await pageFixture(runningTask);
  p.button('标注').props.onClick(); await p.flush();
  p.button('取消标注').props.onClick(); await p.flush();
  assert.deepEqual(JSON.parse(p.requests.find(request => request.path.endsWith('/cancel')).init.body), { taskId: 'task' });
  assert.equal(p.button('取消标注').props.disabled, true);
  p.setTask({ ...runningTask, status: 'succeeded', result: { revision: 'sha-new', count: 1 } });
  await p.poll();
  assert.equal(p.requests.filter(request => request.path.endsWith('/catalog')).length, 2);
  assert.equal(p.button('刷新').props.disabled, false);
  p.dispose();
});

test('标注业务路由在两种传输复用同一处理器，保留版本和请求体限制', async () => {
  const catalog = { source: { id: 's', name: '业务库' }, revision: 'sha-revision', tables: [] };
  let saved;
  const annotations = {
    list: async () => ({ items: [{ id: 's', name: '业务库', status: 'unannotated' }] }),
    catalog: async id => { assert.equal(id, 's'); return catalog; },
    action: async input => { saved = input; return catalog; },
  };
  const h = host(createDatasourceService(() => ({ annotations })), {});
  for (const [path, route] of h.dsh) { assert.equal(h.internal.get(path), route); assert.equal(route.maxBodyBytes, 1048576); }
  assert.equal(h.dsh.has('/api/data-annotation/ai'), false);
  assert.equal((await (await h.call('sources')).json()).items[0].id, 's');
  assert.deepEqual(await (await h.call('catalog', { sourceId: 's' }, h.internal)).json(), catalog);
  const input = { sourceId: 's', revision: 'sha-revision', operation: 'edit', kind: 'table', items: [{ tableId: 't', text: '订单' }] };
  assert.equal((await h.call('action', input)).status, 200); assert.deepEqual(saved, input);
  const route = h.dsh.get('/api/data-annotation/action');
  assert.equal((await route.fetch(new Request('http://local' + route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }))).status, 400);
  assert.equal((await route.fetch(new Request('http://local' + route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1048576) }) }))).status, 413);
  h.unregister(); assert.equal(h.dsh.size, 0); assert.equal(h.internal.size, 0);
});

test('任务由内部入口受理、DSH观察，断开创建请求不取消，冲突附任务ID', async () => {
  let finish, taskSignal;
  const tasks = taskFixture(async (input, signal, report) => { assert.equal(input.revision, 'sha-revision'); taskSignal = signal; report({ sessionId: 'session' }); return new Promise(resolve => { finish = resolve; }); });
  const h = host({}, tasks), controller = new AbortController();
  const response = await h.call('ai-tasks', taskInput, h.internal, controller.signal);
  assert.equal(response.status, 202);
  const { task } = await response.json();
  controller.abort(); await tick();
  assert.equal(taskSignal.aborted, false);
  const latest = await (await h.call('ai-tasks?sourceId=s')).json();
  assert.equal(latest.task.taskId, task.taskId); assert.equal(latest.task.sessionId, 'session');
  const conflict = await h.call('ai-tasks', taskInput);
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).taskId, task.taskId);
  finish({ revision: 'sha-new', count: 1 }); await tick();
  const done = await (await h.call(`ai-tasks?taskId=${task.taskId}`)).json();
  assert.equal(done.task.status, 'succeeded'); assert.deepEqual(done.task.result, { revision: 'sha-new', count: 1 });
  await tasks.close(); h.unregister();
});

test('任务查询形状、显式取消与异步业务失败', async () => {
  const tasks = taskFixture(async (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const h = host({}, tasks);
  for (const query of ['', '?taskId=x&sourceId=s', '?sourceId=', '?taskId=']) assert.equal((await h.call('ai-tasks' + query)).status, 400);
  assert.deepEqual(await (await h.call('ai-tasks?sourceId=none')).json(), { task: null });
  assert.equal((await h.call('ai-tasks?taskId=none')).status, 404);
  assert.equal((await h.call('ai-tasks', { ...taskInput, revision: 1 })).status, 400);
  const { task } = await (await h.call('ai-tasks', taskInput)).json(); await tick();
  assert.equal((await (await h.call('ai-tasks/cancel', { taskId: task.taskId })).json()).task.status, 'cancelling'); await tick();
  assert.equal((await (await h.call(`ai-tasks?taskId=${task.taskId}`)).json()).task.status, 'cancelled');
  await tasks.close(); h.unregister();
  const failing = taskFixture(async () => { throw Object.assign(new Error('数据库内部错误'), { publicMessage: '目录已更新，请刷新。' }); });
  const other = host({}, failing);
  const response = await other.call('ai-tasks', taskInput); assert.equal(response.status, 202); await tick();
  const failed = await (await other.call('ai-tasks?sourceId=s')).json();
  assert.equal(failed.task.status, 'failed'); assert.deepEqual(failed.task.error, { message: '目录已更新，请刷新。' });
  await failing.close(); other.unregister();
});

test('共享服务持久绑定隔离及不可用提示', async () => {
  const bindings = new Map();
  const service = createDatasourceService(() => ({ store: {
    bindSession: async (id, value) => { bindings.set(id, value); return true; },
    findBinding: async id => bindings.get(id),
    retireSession: async id => { bindings.get(id).retired = true; },
  } }));
  await service.bindSession('task', 's'); await service.assertSession('task', 's');
  await assert.rejects(service.assertSession('task', 'other'), /失效/);
  await service.retireSession('task'); await assert.rejects(service.assertSession('task', 's'), /失效/);
  assert.throws(() => service.list(), /升级/);
});

test('页面初次加载经宿主 /api 入口读取已注册的标注接口', async () => {
  const sources = { items: [{ id: 's', name: '业务库', enabledTableCount: 1 }] };
  const h = host({ list: async () => sources }, {});
  const effects = [], requests = [];
  let page, received, stateIndex = 0;
  const React = {
    createElement: () => null,
    useRef: current => ({ current }),
    useState: initial => { const index = stateIndex++; return [typeof initial === 'function' ? initial() : initial, value => { if (index === 0) received = value; }]; },
    useEffect: effect => effects.push(effect),
  };
  const context = {
    AbortController,
    window: { __ModuleLoader__: { load(module) {
      const plugin = module.factory(name => { assert.equal(name, 'react'); return React; });
      plugin.apply({ slots: { inject: (_name, callback) => callback(), register: (options, component) => { if (options.key === 'data-annotation') page = component; } } });
    } } },
    fetch: async (path, init) => {
      requests.push(path);
      assert.ok(path.startsWith('/api/'), '宿主仅向 connection 分发 /api 请求');
      const route = h.dsh.get(path); assert.ok(route, '前端请求必须命中已注册的后端路径');
      return route.fetch(new Request('http://local' + path, init));
    },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context);
  page(); const dispose = effects[0](); await tick();
  assert.deepEqual(requests, ['/api/data-annotation/sources']); assert.deepEqual(received, sources.items); dispose(); h.unregister();
});
