import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { InternalHttp } from '../internal-http.js';
import { AiTasks } from '../ai-tasks.js';

const call = (port, path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('disabled transport registers routes without listening', async () => {
  const server = new InternalHttp();
  const unregister = server.register({ path: '/api/a', methods: ['GET'], fetch: () => Response.json({ ok: true }) });
  await server.listen(); assert.equal(server.server, null); unregister(); assert.equal(server.routes.size, 0);
  await server.close();
});

test('two plugin namespaces share handlers, tasks and query state over real HTTP', async t => {
  const server = new InternalHttp({ enabled: true, port: 0 });
  const tasks = new AiTasks({ identify: input => ({ sourceId: input.sourceId, kind: 'table' }), execute: async () => ({ revision: 'saved' }) });
  const handler = async request => request.method === 'POST'
    ? Response.json({ task: tasks.start(await request.json()) }, { status: 202 })
    : Response.json({ task: tasks.get(new URL(request.url).searchParams.get('taskId')) });
  server.register({ path: '/api/datasources/ai-tasks', methods: ['GET', 'POST'], maxBodyBytes: 128, fetch: handler });
  const unregister = server.register({ path: '/api/data-annotation/catalog', methods: ['POST'], maxBodyBytes: 128,
    fetch: async request => Response.json({ sourceId: (await request.json()).sourceId, revision: 'saved' }) });
  await server.listen(); t.after(async () => { await tasks.close(); await server.close(); });
  const response = await call(server.port, '/api/datasources/ai-tasks', post({ sourceId: 's' }));
  assert.equal(response.status, 202); const { task } = await response.json();
  await new Promise(resolve => setImmediate(resolve));
  const fromHttp = await (await call(server.port, `/api/datasources/ai-tasks?taskId=${task.taskId}`)).json();
  assert.deepEqual(fromHttp.task, tasks.get(task.taskId));
  assert.equal(fromHttp.task.status, 'succeeded');
  assert.deepEqual(await (await call(server.port, '/api/data-annotation/catalog', post({ sourceId: 's' }))).json(), { sourceId: 's', revision: 'saved' });
  unregister(); assert.equal((await call(server.port, '/api/data-annotation/catalog', post({ sourceId: 's' }))).status, 404);
});

test('exact methods, host/origin and body limits are enforced on loopback', async t => {
  const server = new InternalHttp({ enabled: true, port: 0 });
  server.register({ path: '/api/a', methods: ['POST'], maxBodyBytes: 16, fetch: () => Response.json({ ok: true }) });
  await server.listen(); t.after(() => server.close());
  assert.equal((await call(server.port, '/missing')).status, 404);
  assert.equal((await call(server.port, '/api/a')).status, 405);
  assert.equal((await call(server.port, '/api/a', { ...post({}), headers: { Origin: 'https://outside.test' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.port, path: '/api/a', method: 'POST', headers: { Host: 'outside.test' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await call(server.port, '/api/a', post({ long: 'x'.repeat(30) }))).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.port, path: '/api/a', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.write('x'.repeat(8)); request.end('x'.repeat(20));
  });
  assert.equal(chunked, 413);
  server.stopAccepting(); assert.equal((await call(server.port, '/api/a', post({}))).status, 503);
});

test('port conflicts fail and closing releases the listener', async () => {
  const server = new InternalHttp({ enabled: true, port: 0 }); await server.listen(); const port = server.port;
  const conflict = new InternalHttp({ enabled: true, port });
  await assert.rejects(conflict.listen(), error => error.code === 'EADDRINUSE');
  await server.close();
  const replacement = new InternalHttp({ enabled: true, port }); await replacement.listen(); await replacement.close();
});
