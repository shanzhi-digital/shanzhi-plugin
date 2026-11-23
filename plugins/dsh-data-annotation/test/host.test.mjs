import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { registerRoutes } from '../index.js';
import { createDatasourceService } from 'dsh-sql/service.js';

test('标注路由通过共享服务读取和保存，保留版本并传递 AI 取消信号', async () => {
  const routes = new Map();
  const catalog = { source: { id: 's', name: '业务库' }, revision: 'sha-revision', tables: [] };
  let saved;
  const annotations = {
    list: async () => ({ items: [{ id: 's', name: '业务库', status: 'unannotated' }] }),
    catalog: async id => { assert.equal(id, 's'); return catalog; },
    action: async input => { saved = input; return catalog; },
  };
  const service = createDatasourceService(() => ({ annotations }));
  registerRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); } } } }, service, { async run(input, signal) { assert.equal(input.sourceId, 's'); assert.equal(signal.aborted, false); return catalog; } });
  async function call(path, body) {
    const route = routes.get('/api/data-annotation/' + path);
    return route.fetch(new Request('http://local' + route.path, { method: route.methods[0], ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }));
  }
  assert.equal((await (await call('sources')).json()).items[0].id, 's');
  assert.deepEqual(await (await call('catalog', { sourceId: 's' })).json(), catalog);
  const input = { sourceId: 's', revision: 'sha-revision', operation: 'edit', kind: 'table', items: [{ tableId: 't', text: '订单' }] };
  assert.equal((await call('action', input)).status, 200); assert.deepEqual(saved, input);
  assert.equal((await call('ai', { sourceId: 's' })).status, 200);
  const invalid = await routes.get('/api/data-annotation/action').fetch(new Request('http://local/api/data-annotation/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }));
  assert.equal(invalid.status, 400);
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
  const routes = new Map();
  const sources = { items: [{ id: 's', name: '业务库', enabledTableCount: 1 }] };
  registerRoutes({ connection: { fetch: { register(route) { routes.set(route.path, route); } } } }, { list: async () => sources }, {});
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
      const route = routes.get(path);
      assert.ok(route, '前端请求必须命中已注册的后端路径');
      return route.fetch(new Request('http://local' + path, init));
    },
  };
  vm.runInNewContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context);
  page();
  const dispose = effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/data-annotation/sources']);
  assert.deepEqual(received, sources.items);
  dispose();
});
