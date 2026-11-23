import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatasourceSessionBridge, injectKeys } from '../host-bridge.js';

const cwd = resolve('fixture-workspace');
const sessionId = 'session-host-actual';
const secretMessage = 'synthetic-private-host-error';
const message = { sessionId, requestId: 'request-stable-1', text: '分析当前问题\n保留原始输入', signal: new AbortController().signal };

function fixture() {
  const calls = [];
  const session = { id: sessionId, header: { cwd } };
  const agent = { id: sessionId, session, status: 'idle' };
  const liveAgents = new Map([[sessionId, agent]]);
  const liveSessions = new Map([[sessionId, session]]);
  const requestIds = new Set();
  const ctx = {
    sessionController: {
      async create(request) { calls.push(['create', request]); return { sessionId, agentPreset: 'creator' }; },
      async selectModel() { throw new Error('selectModel must not be called'); },
      async rename() { throw new Error('rename must not run before durable identity binding'); },
      async prompt(request, signal) {
        assert.equal(signal, message.signal);
        signal.throwIfAborted();
        calls.push(['prompt', request]);
        requestIds.add(request.requestId);
        return { accepted: true };
      },
      async resolveAgent(id) { calls.push(['resolveAgent', id]); return { agent: liveAgents.get(id) }; },
      cancel(request) { calls.push(['cancel', request]); return { accepted: true }; },
    },
    sessions: {
      get(id) { return liveSessions.get(id); },
      async flush(value) { calls.push(['flush', value]); return true; },
      create() { throw new Error('low-level session creation must not be called'); },
    },
    agents: { get(id) { return liveAgents.get(id); } },
  };
  return { ctx, calls, session, agent, liveAgents, liveSessions, requestIds, bridge: new DatasourceSessionBridge(ctx) };
}
function observationFixture({ delayReady = false } = {}) {
  const host = fixture();
  const frames = [];
  let wake;
  let releaseReady;
  let subscribed;
  let disposed;
  const installed = new Promise((resolve) => { subscribed = resolve; });
  const released = new Promise((resolve) => { disposed = resolve; });
  const gate = delayReady ? new Promise((resolve) => { releaseReady = resolve; }) : Promise.resolve();
  let subscriptionSignal;
  host.ctx.sessionController.observeEvent = async function* (request, signal) {
    host.calls.push(['observeEvent', request]);
    subscriptionSignal = signal;
    const abort = () => wake?.();
    signal.addEventListener('abort', abort, { once: true });
    subscribed();
    try {
      signal.throwIfAborted();
      await Promise.race([gate, new Promise((resolve) => { wake = resolve; })]);
      wake = undefined;
      signal.throwIfAborted();
      yield { type: 'ready' };
      host.calls.push(['ready']);
      while (!signal.aborted) {
        if (!frames.length) await new Promise((resolve) => { wake = resolve; });
        wake = undefined;
        signal.throwIfAborted();
        while (frames.length) {
          const frame = frames.shift();
          if (frame instanceof Error) throw frame;
          if (frame === null) return;
          yield frame;
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      host.calls.push(['disposed']);
      disposed();
    }
  };
  return {
    ...host, installed, released,
    ready() { releaseReady?.(); },
    push(frame) { frames.push(frame); wake?.(); },
    get subscriptionSignal() { return subscriptionSignal; },
  };
}

function hasPublicCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.name, 'DatasourceSessionError');
    assert.equal(error.message, error.publicMessage);
    assert.match(error.publicMessage, /[\u4e00-\u9fff]/);
    assert.equal(String(error).includes(secretMessage), false);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('exports only real required Host service dependencies', () => {
  assert.deepEqual(injectKeys, ['sessionController', 'sessions', 'agents']);
  assert.equal(Object.isFrozen(injectKeys), true);
});

test('requires the installed Host service shape', () => {
  assert.throws(() => new DatasourceSessionBridge({}), hasPublicCode('SESSION_SERVICE_UNAVAILABLE'));
});

test('create returns actual identity and leaves prompt/model/title to later stages', async () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(await bridge.create({ cwd, title: '分析标题' }), { sessionId });
  assert.deepEqual(calls, [['create', { cwd }]]);
});

test('create requires an explicit absolute cwd with no default cwd guessing', async () => {
  const { bridge, calls } = fixture();
  for (const input of [{}, { cwd: '' }, { cwd: 'relative-workspace' }, { cwd: cwd + '\u0000' }]) {
    await assert.rejects(bridge.create(input), hasPublicCode('SESSION_INVALID_INPUT'));
  }
  assert.deepEqual(calls, []);
});

test('create sanitizes Host failures without leaking Host data', async () => {
  const { bridge, ctx } = fixture();
  ctx.sessionController.create = async () => { throw Object.assign(new Error(secretMessage), { publicMessage: secretMessage }); };
  await assert.rejects(bridge.create({ cwd }), hasPublicCode('SESSION_CREATE_FAILED'));
});

test('create does not confuse RemoteResult with direct Host return', async () => {
  const { bridge, ctx } = fixture();
  ctx.sessionController.create = async () => ({ ok: true, value: { sessionId } });
  await assert.rejects(bridge.create({ cwd }), hasPublicCode('SESSION_INVALID_INPUT'));
});

test('send forwards stable requestId in queue mode and waits for the actual Session flush', async () => {
  const { bridge, calls, session } = fixture();
  assert.deepEqual(await bridge.send(message), { accepted: true });
  assert.deepEqual(calls, [
    ['prompt', { sessionId, requestId: message.requestId, mode: 'queue', content: [{ type: 'text', text: message.text }] }],
    ['resolveAgent', sessionId],
    ['flush', session],
  ]);
});

test('send forwards an aborted signal and Host rejects before admitting or flushing', async () => {
  const { bridge, ctx, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  let seen;
  ctx.sessionController.prompt = async (request, signal) => {
    seen = signal;
    signal.throwIfAborted();
    assert.fail('aborted prompt must not be admitted');
  };
  await assert.rejects(bridge.send({ ...message, signal: controller.signal }), hasPublicCode('SESSION_SEND_FAILED'));
  assert.equal(seen, controller.signal);
  assert.deepEqual(calls, []);
});

test('send leaves requestId deduplication to the Host and never substitutes its own ID', async () => {
  const { bridge, calls, requestIds } = fixture();
  await bridge.send(message);
  await bridge.send(message);
  assert.equal(requestIds.size, 1);
  assert.deepEqual(calls.filter(([kind]) => kind === 'prompt').map(([, request]) => request.requestId), [message.requestId, message.requestId]);
});

test('admission alone does not resolve send before persistence finishes', async () => {
  const { bridge, ctx } = fixture();
  let finishFlush;
  let enteredFlush;
  const entered = new Promise((done) => { enteredFlush = done; });
  ctx.sessions.flush = () => { enteredFlush(); return new Promise((done) => { finishFlush = done; }); };
  let settled = false;
  const sent = bridge.send(message).then((result) => { settled = true; return result; });
  await entered;
  assert.equal(settled, false);
  finishFlush(true);
  assert.deepEqual(await sent, { accepted: true });
});

test('send validates identity and text before calling Host', async () => {
  const { bridge, calls } = fixture();
  for (const input of [{ ...message, requestId: '' }, { ...message, sessionId: '\u0000' }, { ...message, text: ' ' }, { ...message, text: 'x\u0000y' }]) {
    await assert.rejects(bridge.send(input), hasPublicCode('SESSION_INVALID_INPUT'));
  }
  assert.deepEqual(calls, []);
});

test('send rejected admission is not flushed or automatically retried', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessionController.prompt = async (input) => { calls.push(['prompt', input]); return { accepted: false }; };
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_ADMISSION_FAILED'));
  assert.deepEqual(calls.map(([kind]) => kind), ['prompt']);
});

test('send sanitizes prompt errors and never automatically retries', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessionController.prompt = async (input) => { calls.push(['prompt', input]); throw new Error(secretMessage); };
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_SEND_FAILED'));
  assert.deepEqual(calls.map(([kind]) => kind), ['prompt']);
});

test('send rejects a failed resolve without exposing error or performing a flush', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessionController.resolveAgent = async () => ({ error: new Error(secretMessage) });
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_UNAVAILABLE'));
  assert.equal(calls.some(([kind]) => kind === 'flush'), false);
});

test('send rejects mismatched returned Session identity before flush', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessionController.resolveAgent = async () => ({ agent: { session: { id: 'other-user-session' } } });
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_UNAVAILABLE'));
  assert.equal(calls.some(([kind]) => kind === 'flush'), false);
});

test('send requires flush true; missing durability listener is not success', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessions.flush = async () => false;
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_PERSISTENCE_UNAVAILABLE'));
  assert.equal(calls.filter(([kind]) => kind === 'prompt').length, 1);
});

test('send sanitizes failed flush and does not replay admitted prompt', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessions.flush = async () => { throw new Error(secretMessage); };
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_SEND_FAILED'));
  assert.equal(calls.filter(([kind]) => kind === 'prompt').length, 1);
});

test('observe waits for installed subscription readiness before sending and captures fast turn completion', async () => {
  const host = observationFixture({ delayReady: true });
  const endings = [];
  let subscribed = false;
  const observation = host.bridge.observe({ sessionId, onEnd: (error) => endings.push(error) }).then((cleanup) => {
    subscribed = true;
    return cleanup;
  });
  await host.installed;
  assert.equal(subscribed, false);
  assert.deepEqual(host.calls, [['observeEvent', { address: { kind: 'session', sessionId } }]]);
  host.ready();
  const cleanup = await observation;
  host.ctx.sessionController.prompt = async (request) => {
    host.calls.push(['prompt', request]);
    host.push({ type: 'event', event: { type: 'turn/start', data: { turn: 1 } } });
    host.push({ type: 'event', event: { type: 'tool/result', data: { value: 'saved' } } });
    host.push({ type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
    return { accepted: true };
  };
  assert.deepEqual(await host.bridge.send(message), { accepted: true });
  await host.released;
  assert.deepEqual(endings, [undefined]);
  assert.ok(host.calls.findIndex(([kind]) => kind === 'ready') < host.calls.findIndex(([kind]) => kind === 'prompt'));
  assert.equal(host.calls.some(([kind]) => kind === 'flush'), true);
  await cleanup();
  await cleanup();
  assert.equal(host.calls.some(([kind]) => kind === 'cancel'), false);
});

test('successful submit cleanup does not interrupt the still-pending tool persistence barrier', async () => {
  const host = observationFixture();
  const cleanup = await host.bridge.observe({ sessionId, onEnd() { assert.fail('submit cleanup is not a turn end'); } });
  let resolveFlush;
  let enteredFlush;
  const flushing = new Promise((resolve) => { enteredFlush = resolve; });
  host.ctx.sessions.flush = () => {
    enteredFlush();
    return new Promise((resolve) => { resolveFlush = resolve; });
  };
  let sent = false;
  const sending = host.bridge.send(message).then((result) => { sent = true; return result; });
  await flushing;
  await cleanup();
  assert.equal(sent, false);
  assert.equal(host.calls.some(([kind]) => kind === 'cancel'), false);
  resolveFlush(true);
  assert.deepEqual(await sending, { accepted: true });
});

test('a turn emitted immediately after ready is observed before any later await', async () => {
  const { bridge, ctx } = fixture();
  let ended;
  const completion = new Promise((resolve) => { ended = resolve; });
  ctx.sessionController.observeEvent = async function* () {
    yield { type: 'ready' };
    yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } };
  };
  const cleanup = await bridge.observe({ sessionId, onEnd: ended });
  await completion;
  await cleanup();
});

test('native turn end without submit only notifies flow and never reports business success', async () => {
  const host = observationFixture();
  const endings = [];
  const cleanup = await host.bridge.observe({ sessionId, onEnd: (...args) => endings.push(args) });
  host.push({ type: 'event', event: { type: 'step/end', data: { turn: 1, step: 1 } } });
  host.push({ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } });
  await host.released;
  assert.deepEqual(endings, [[]]);
  await cleanup();
  assert.equal(host.calls.some(([kind]) => kind === 'cancel'), false);
});

test('native turn failure is sanitized and releases the subscription', async () => {
  const host = observationFixture();
  const endings = [];
  const cleanup = await host.bridge.observe({ sessionId, onEnd: (error) => endings.push(error) });
  host.push({ type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: secretMessage } } } } });
  await host.released;
  assert.equal(endings.length, 1);
  hasPublicCode('SESSION_TURN_FAILED')(endings[0]);
  await cleanup();
});

test('observe rejects missing event support and setup errors without a polling fallback', async () => {
  const { bridge, ctx, calls } = fixture();
  await assert.rejects(bridge.observe({ sessionId, onEnd() {} }), hasPublicCode('SESSION_OBSERVE_UNAVAILABLE'));
  ctx.sessionController.observeEvent = async function* () { throw new Error(secretMessage); };
  await assert.rejects(bridge.observe({ sessionId, onEnd() {} }), hasPublicCode('SESSION_OBSERVE_FAILED'));
  ctx.sessionController.observeEvent = async function* () { yield { type: 'event', event: { type: 'turn/end' } }; };
  await assert.rejects(bridge.observe({ sessionId, onEnd() {} }), hasPublicCode('SESSION_OBSERVE_FAILED'));
  assert.deepEqual(calls, []);
});

test('stream errors or unexpected closure after ready fail explicitly through onEnd', async () => {
  for (const frame of [new Error(secretMessage), null, { type: 'invalid' }]) {
    const host = observationFixture();
    const endings = [];
    let notified;
    const ended = new Promise((resolve) => { notified = resolve; });
    const cleanup = await host.bridge.observe({ sessionId, onEnd: (error) => { endings.push(error); notified(); } });
    host.push(frame);
    await ended;
    await host.released;
    assert.equal(endings.length, 1);
    hasPublicCode('SESSION_OBSERVE_FAILED')(endings[0]);
    await cleanup();
  }
});

test('abort after ready and normal cleanup release listeners without cancelling the session', async () => {
  for (const bySignal of [true, false]) {
    const host = observationFixture();
    const controller = new AbortController();
    const endings = [];
    const cleanup = await host.bridge.observe({ sessionId, signal: controller.signal, onEnd: (error) => endings.push(error) });
    if (bySignal) controller.abort();
    else await cleanup();
    await host.released;
    await cleanup();
    assert.equal(host.subscriptionSignal.aborted, true);
    assert.deepEqual(endings, []);
    assert.equal(host.calls.some(([kind]) => kind === 'cancel'), false);
  }
});

test('abort before readiness rejects observation and disposes the stream', async () => {
  const host = observationFixture({ delayReady: true });
  const controller = new AbortController();
  const observation = host.bridge.observe({ sessionId, signal: controller.signal, onEnd() { assert.fail('abort belongs to flow'); } });
  await host.installed;
  controller.abort();
  await assert.rejects(observation, hasPublicCode('SESSION_OBSERVE_CANCELLED'));
  await host.released;
  assert.equal(host.subscriptionSignal.aborted, true);
});

test('close releases active subscriptions and rejects later observe calls', async () => {
  const host = observationFixture();
  const cleanup = await host.bridge.observe({ sessionId, onEnd() { assert.fail('close must not notify completion'); } });
  await host.bridge.close();
  await host.released;
  await cleanup();
  await assert.rejects(host.bridge.observe({ sessionId, onEnd() {} }), hasPublicCode('SESSION_BRIDGE_CLOSED'));
  assert.equal(host.calls.some(([kind]) => kind === 'cancel'), false);
});

test('status exposes only native running/idle and does not invent failure or completion', async () => {
  const { bridge, agent, calls } = fixture();
  assert.equal(await bridge.status(sessionId), 'idle');
  agent.status = 'running';
  assert.equal(await bridge.status(sessionId), 'running');
  agent.status = 'failed';
  assert.equal(await bridge.status(sessionId), 'unknown');
  assert.deepEqual(calls, []);
});

test('status missing is live absence, while an attached Agent-less Session is unknown', async () => {
  const { bridge, liveAgents, liveSessions, calls } = fixture();
  liveAgents.clear();
  assert.equal(await bridge.status(sessionId), 'unknown');
  liveSessions.clear();
  assert.equal(await bridge.status(sessionId), 'missing');
  assert.deepEqual(calls, []);
});

test('status failed lookup remains unknown without activating or reading a cold session', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.agents.get = () => { throw new Error(secretMessage); };
  assert.equal(await bridge.status(sessionId), 'unknown');
  assert.deepEqual(calls, []);
});

test('cancel invokes only real controller cancellation and confirms admission', async () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(await bridge.cancel(sessionId), { accepted: true });
  assert.deepEqual(calls, [['cancel', { sessionId }]]);
});

test('cancel sanitizes a missing Agent error and does not cold-resume', async () => {
  const { bridge, ctx, calls } = fixture();
  ctx.sessionController.cancel = (request) => { calls.push(['cancel', request]); throw new Error(secretMessage); };
  await assert.rejects(bridge.cancel(sessionId), hasPublicCode('SESSION_CANCEL_FAILED'));
  assert.deepEqual(calls, [['cancel', { sessionId }]]);
});

test('close is idempotent and never cancels user sessions', async () => {
  const { bridge, calls } = fixture();
  await bridge.close();
  await bridge.close();
  assert.deepEqual(calls, []);
  await assert.rejects(bridge.create({ cwd }), hasPublicCode('SESSION_BRIDGE_CLOSED'));
  await assert.rejects(bridge.send(message), hasPublicCode('SESSION_BRIDGE_CLOSED'));
  await assert.rejects(bridge.cancel(sessionId), hasPublicCode('SESSION_BRIDGE_CLOSED'));
  assert.deepEqual(calls, []);
});
