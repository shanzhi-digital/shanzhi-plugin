import test from 'node:test';
import assert from 'node:assert/strict';
import { callOnboardingRpc } from './transport.js';

test('RPC helper 将公开 payload 包装为 {args}，保留端点与 AbortSignal 并返回 value', async () => {
  const calls = [];
  const expected = { phase: 'connected', configured: true };
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: expected }; } } };
  const controller = new AbortController();
  const payload = { apiKey: 'test-only-key', origin: 'https://datahub.example.com' };
  const value = await callOnboardingRpc(connection, 'connect', payload, controller.signal);
  assert.equal(value, expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    '/api',
    'datahubOnboarding/connect',
    { args: payload },
    controller.signal,
  ]);
  assert.equal(calls[0][2].args, payload, '不额外嵌套 request，也不改变公开 args 对象');
});

test('RPC helper 对省略 payload 的无参方法发送 {args:{}}', async () => {
  const calls = [];
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: undefined }; } } };
  assert.equal(await callOnboardingRpc(connection, 'disconnect'), undefined);
  assert.deepEqual(calls[0].slice(0, 3), ['/api', 'datahubOnboarding/disconnect', { args: {} }]);
});

test('RPC helper 对失败响应拒绝且不转发私有错误详情', async () => {
  const connection = { rpc: { call: async () => ({ ok: false, error: { message: 'private-server-detail' } }) } };
  await assert.rejects(
    () => callOnboardingRpc(connection, 'retry', { origin: 'https://datahub.example.com' }),
    error => error instanceof Error && error.message === 'RPC_FAILED' && !error.message.includes('private-server-detail'),
  );
});
