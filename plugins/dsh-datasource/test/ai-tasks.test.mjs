import test from 'node:test';
import assert from 'node:assert/strict';
import { AiTasks } from '../ai-tasks.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const create = (execute, extra = {}) => new AiTasks({ execute, identify: input => ({ sourceId: input.sourceId, kind: input.kind }), ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('start returns without awaiting execution; input and observation are detached', async () => {
  const done = deferred(); let captured;
  const tasks = create((input, signal, report) => { captured = input; report({ sessionId: 'session' }); return done.promise; });
  const input = { sourceId: 's', kind: 'table', items: ['one'] };
  const view = tasks.start(input);
  input.items.push('two'); view.status = 'failed';
  assert.equal(tasks.get(view.taskId).status, 'running');
  await tick();
  assert.deepEqual(captured.items, ['one']);
  assert.equal(tasks.get(view.taskId).sessionId, 'session');
  assert.throws(() => tasks.start(input), error => error.status === 409 && error.taskId === view.taskId);
  done.resolve({ revision: 'opaque' }); await tick();
  assert.equal(tasks.get(view.taskId).status, 'succeeded');
  assert.deepEqual(tasks.latest('s').result, { revision: 'opaque' });
  await tasks.close();
});

test('explicit cancellation waits for executor; committed execution still succeeds', async () => {
  const done = deferred(); let signal;
  const tasks = create((_input, executionSignal) => { signal = executionSignal; return done.promise; });
  const task = tasks.start({ sourceId: 's', kind: 'table' }); await tick();
  assert.equal(tasks.cancel(task.taskId).status, 'cancelling');
  assert.equal(signal.aborted, true);
  done.resolve({ revision: 'committed' }); await tick();
  assert.equal(tasks.get(task.taskId).status, 'succeeded');
  assert.equal(tasks.cancel(task.taskId).status, 'succeeded');
});

test('cancelled and failed tasks expose safe errors and do not block other sources', async () => {
  const tasks = create((_input, signal) => new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(new Error('private'));
    signal.addEventListener('abort', () => reject(new Error('private')), { once: true });
  }));
  const a = tasks.start({ sourceId: 'a', kind: 'table' });
  const b = tasks.start({ sourceId: 'b', kind: 'field' });
  tasks.cancel(a.taskId); await tick();
  assert.equal(tasks.get(a.taskId).status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(tasks.get(a.taskId)), /private/);
  await tasks.close(); assert.equal(tasks.get(b.taskId).status, 'cancelled');
  assert.throws(() => tasks.start({ sourceId: 'c', kind: 'table' }), error => error.status === 503);
  const failed = create(() => { throw Object.assign(new Error('private'), { publicMessage: '目录已更新。' }); });
  const task = failed.start({ sourceId: 's', kind: 'table' }); await tick();
  assert.equal(failed.get(task.taskId).status, 'failed');
  assert.deepEqual(failed.get(task.taskId).error, { message: '目录已更新。' });
});

test('terminal records expire and are bounded; active tasks are retained', async () => {
  let now = 0;
  const tasks = create(() => ({ revision: 1 }), { now: () => now, retentionMs: 100, maxCompleted: 1 });
  const a = tasks.start({ sourceId: 'a', kind: 'table' }); await tick(); now++;
  const b = tasks.start({ sourceId: 'b', kind: 'table' }); await tick();
  assert.throws(() => tasks.get(a.taskId), error => error.status === 404);
  assert.equal(tasks.latest('a'), null);
  assert.equal(tasks.get(b.taskId).status, 'succeeded');
  now = 102; assert.equal(tasks.latest('b'), null);
});
