import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { InternalHttp } from '../internal-http.js';
import { AiTasks } from '../ai-tasks.js';
import { applyWithServices } from '../index.js';

const prefix = '/api/question-set/';
const call = (port, path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function createFixture(events = []) {
  let currentSettings = { prompt: '共享的泛化提示词', defaultPrompt: '默认提示词', protocol: '工具协议' };
  const executions = [];
  const flow = {
    drafts: new Map(),
    prune() {},
    async close() { events.push('flow.close'); },
    async run(input, signal, report, taskId) {
      const gate = deferred();
      const execution = { input, signal, report, taskId, complete: gate.resolve };
      executions.push(execution);
      report({ progress: { phase: 'generating', completed: 1, total: 3, success: 1, failed: 0 } });
      const abort = () => gate.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try { return await gate.promise; }
      finally { signal.removeEventListener('abort', abort); }
    },
  };
  const tasks = new AiTasks({
    identify: input => ({ sourceId: input.sourceId, kind: 'generalize' }),
    execute: (...args) => flow.run(...args),
  });
  const closeTasks = tasks.close.bind(tasks);
  tasks.close = async () => { events.push('tasks.close'); await closeTasks(); };
  const store = { async list() { return [{ id: 'question-1', question: '原问题' }]; } };
  const query = { async sources() { return [{ id: 'source-1' }]; }, async close() { events.push('query.close'); } };
  const db = { async close() { events.push('db.close'); } };
  const settings = {
    async get() { return structuredClone(currentSettings); },
    async save(input) { currentSettings = { ...currentSettings, prompt: input.prompt }; return this.get(); },
  };
  return { services: { store, query, flow, tasks, db }, settings, executions };
}

async function startPlugin(t, { config = { internalApi: { enabled: true, port: 0 } }, fixture = createFixture(), createServices, events = [] } = {}) {
  const routes = new Map();
  const tools = [];
  const removed = [];
  let transport, onDispose, disposal;
  const ctx = {
    connection: { fetch: { register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
      return () => { removed.push(route.path); routes.delete(route.path); };
    } } },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    on(event, handler) { assert.equal(event, 'dispose'); onDispose = handler; },
  };
  const dispose = () => disposal ??= Promise.resolve().then(() => onDispose?.());
  t.after(async () => { await dispose(); await transport?.close(); });
  await applyWithServices(ctx, config, {
    createServices: createServices ?? (async () => fixture.services),
    settings: fixture.settings,
    createTransport(options) {
      transport = new InternalHttp(options);
      const stopAccepting = transport.stopAccepting.bind(transport);
      const close = transport.close.bind(transport);
      transport.stopAccepting = () => { events.push('transport.stopAccepting'); stopAccepting(); };
      transport.close = async () => { events.push('transport.close'); await close(); };
      return transport;
    },
  });
  return {
    ...fixture, transport, routes, tools, removed, dispose,
    internal(path, options = {}) {
      const url = new URL(path, 'http://dsh.internal');
      const route = routes.get(url.pathname);
      assert.ok(route, `DSH route missing: ${url.pathname}`);
      return route.fetch(new Request(url, options));
    },
  };
}

function rawStatus(port, path, { method = 'POST', headers = {}, chunks = ['{}'] } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    for (const chunk of chunks.slice(0, -1)) request.write(chunk);
    request.end(chunks.at(-1));
  });
}

test('internal HTTP defaults to disabled port 17862 and shares every DSH route handler', async t => {
  const plugin = await startPlugin(t, { config: {} });
  assert.equal(plugin.transport.enabled, false);
  assert.equal(plugin.transport.port, 17862);
  assert.equal(plugin.transport.server, null);
  assert.equal(plugin.tools.length, 1);
  assert.equal(plugin.routes.size, 9);
  for (const [path, route] of plugin.routes) {
    assert.equal(plugin.transport.routes.get(path).fetch, route.fetch);
    assert.deepEqual(plugin.transport.routes.get(path).methods, route.methods);
  }
  assert.equal((await plugin.internal(`${prefix}questions`)).status, 200);
  await plugin.dispose();
  assert.equal(plugin.routes.size, 0);
  assert.equal(plugin.transport.routes.size, 0);
  assert.equal(new Set(plugin.removed).size, 9);
});

test('real HTTP enforces exact methods, host, origin and declared or streamed body limits', async t => {
  const plugin = await startPlugin(t);
  const port = plugin.transport.port;
  assert.equal((await call(port, '/missing')).status, 404);
  const unsupported = await call(port, `${prefix}questions`, post({}));
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
  assert.equal((await call(port, `${prefix}questions`, { method: 'HEAD' })).status, 405);
  assert.equal((await call(port, `${prefix}questions`, { headers: { Origin: 'https://outside.test' } })).status, 403);
  assert.equal((await call(port, `${prefix}questions`, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 403);
  assert.equal(await rawStatus(port, `${prefix}questions`, { method: 'GET', headers: { Host: 'outside.test' }, chunks: [] }), 403);
  assert.equal(await rawStatus(port, `${prefix}questions`, { method: 'GET', headers: { Host: `localhost:${port}` }, chunks: [] }), 200);
  assert.equal((await call(port, `${prefix}save`, post({ value: 'x'.repeat(1048576) }))).status, 413);
  assert.equal(await rawStatus(port, `${prefix}save`, {
    headers: { 'Content-Type': 'application/json' }, chunks: ['x'.repeat(524288), 'x'.repeat(524289)],
  }), 413);
  assert.equal((await call(port, `${prefix}save`, { method: 'POST', body: '{}' })).status, 415);
});

test('port conflicts reject and closing the plugin releases its listener', async t => {
  const plugin = await startPlugin(t);
  const port = plugin.transport.port;
  const conflict = new InternalHttp({ enabled: true, port });
  t.after(() => conflict.close());
  await assert.rejects(conflict.listen(), error => error.code === 'EADDRINUSE');
  await plugin.dispose();
  const replacement = new InternalHttp({ enabled: true, port });
  t.after(() => replacement.close());
  await replacement.listen();
  assert.equal(replacement.port, port);
});

test('HTTP and DSH use the same tasks, progress and prompt settings in both directions', async t => {
  const plugin = await startPlugin(t);
  const { transport, internal, services, executions } = plugin;
  const saved = await internal(`${prefix}prompt-settings`, post({ prompt: '从 DSH 更新的提示词' }));
  assert.equal(saved.status, 200);
  assert.deepEqual(await (await call(transport.port, `${prefix}prompt-settings`)).json(), await plugin.settings.get());
  const response = await call(transport.port, `${prefix}ai-tasks`, post({ sourceId: 'source-1', questions: ['问题一'] }));
  assert.equal(response.status, 202);
  const { task } = await response.json();
  assert.equal(executions[0].input.prompt, '从 DSH 更新的提示词');
  const observed = await (await internal(`${prefix}ai-tasks?taskId=${task.taskId}`)).json();
  assert.equal(observed.task.taskId, task.taskId);
  assert.deepEqual(observed.task.progress, { phase: 'generating', completed: 1, total: 3, success: 1, failed: 0 });
  assert.deepEqual(observed.task, { ...services.tasks.get(task.taskId), resultState: 'ready' });
  assert.deepEqual(await (await call(transport.port, `${prefix}ai-tasks?sourceId=source-1`)).json(), observed);
  const duplicate = await internal(`${prefix}ai-tasks`, post({ sourceId: 'source-1', questions: [] }));
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).taskId, task.taskId);
  executions[0].complete({ generated: 3 });
  await services.tasks.tasks.get(task.taskId).done;
  const finished = await (await internal(`${prefix}ai-tasks?taskId=${task.taskId}`)).json();
  assert.equal(finished.task.status, 'succeeded');
  assert.deepEqual(finished.task.result, { generated: 3 });
  await call(transport.port, `${prefix}prompt-settings`, post({ prompt: '从 HTTP 更新的提示词' }));
  assert.equal((await (await internal(`${prefix}prompt-settings`)).json()).prompt, '从 HTTP 更新的提示词');
  const second = await internal(`${prefix}ai-tasks`, post({ sourceId: 'source-2', questions: ['问题二'] }));
  assert.equal(second.status, 202);
  const secondTask = (await second.json()).task;
  assert.equal(executions[1].input.prompt, '从 HTTP 更新的提示词');
  const secondObserved = await (await call(transport.port, `${prefix}ai-tasks?taskId=${secondTask.taskId}`)).json();
  assert.equal(secondObserved.task.status, 'running');
  assert.deepEqual(secondObserved.task.progress, observed.task.progress);
});

test('disconnecting after acceptance leaves a background task running until explicit cancellation', async t => {
  const plugin = await startPlugin(t);
  const { transport, services, executions, internal } = plugin;
  const accepted = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ sourceId: 'source-disconnect', questions: ['保持执行'] });
    const request = http.request({ host: '127.0.0.1', port: transport.port, path: `${prefix}ai-tasks`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      response.destroy();
      request.destroy();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end(body);
  });
  assert.equal(accepted, 202);
  const { task } = await (await internal(`${prefix}ai-tasks?sourceId=source-disconnect`)).json();
  assert.equal(task.status, 'running');
  assert.equal(executions[0].signal.aborted, false);
  const cancelled = await call(transport.port, `${prefix}ai-tasks/cancel`, post({ taskId: task.taskId }));
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).task.status, 'cancelling');
  await services.tasks.tasks.get(task.taskId).done;
  assert.equal(executions[0].signal.aborted, true);
  assert.equal((await (await internal(`${prefix}ai-tasks?taskId=${task.taskId}`)).json()).task.status, 'cancelled');
});

test('dispose stops HTTP admission before closing services and releases both route registrations', async t => {
  const events = [];
  const fixture = createFixture(events);
  const plugin = await startPlugin(t, { fixture, events });
  await plugin.internal(`${prefix}questions`);
  const entered = deferred();
  const release = deferred();
  const closeTasks = fixture.services.tasks.close;
  fixture.services.tasks.close = async () => { entered.resolve(); await release.promise; await closeTasks(); };
  const disposing = plugin.dispose();
  await entered.promise;
  try {
    assert.equal(plugin.transport.accepting, false);
    assert.equal((await call(plugin.transport.port, `${prefix}questions`)).status, 503);
    assert.equal(events.includes('flow.close'), false);
  } finally { release.resolve(); }
  await disposing;
  assert.deepEqual(events.filter(event => event !== 'transport.stopAccepting'), ['tasks.close', 'flow.close', 'query.close', 'db.close', 'transport.close']);
  assert.equal(events[0], 'transport.stopAccepting');
  assert.equal(plugin.transport.server, null);
  assert.equal(plugin.transport.routes.size, 0);
  assert.equal(plugin.routes.size, 0);
  assert.equal(new Set(plugin.removed).size, 9);
});

test('initialization failure returns 503 in both entries while prompt settings stay available', async t => {
  let attempts = 0;
  const plugin = await startPlugin(t, { createServices: async () => { attempts++; throw new Error('fixture database unavailable'); } });
  assert.equal((await call(plugin.transport.port, `${prefix}prompt-settings`)).status, 200);
  assert.equal((await plugin.internal(`${prefix}prompt-settings`)).status, 200);
  assert.equal(attempts, 0);
  for (const invoke of [path => call(plugin.transport.port, path), path => plugin.internal(path)]) {
    const response = await invoke(`${prefix}questions`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal((await invoke(`${prefix}prompt-settings`)).status, 200);
  }
  assert.ok(attempts >= 1);
  const saved = await call(plugin.transport.port, `${prefix}prompt-settings`, post({ prompt: '数据库离线时仍可保存' }));
  assert.equal(saved.status, 200);
  assert.equal((await (await plugin.internal(`${prefix}prompt-settings`)).json()).prompt, '数据库离线时仍可保存');
});
