import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatasourceSessionBridge, injectKeys } from '../host-bridge.js';

const cwd = resolve('fixture-workspace');
const sessionId = 'session-host-actual';
const secretMessage = 'synthetic-private-host-error';
const message = { sessionId, requestId: 'request-stable-1', text: '分析当前问题\n保留原始输入' };

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
      async prompt(request) {
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
