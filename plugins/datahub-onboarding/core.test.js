import test from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingController } from './core.js';
import { FORMAL_CREDENTIAL_REF, SERVICES, STAGING_CREDENTIAL_REF } from './constants.js';
import { probeConfig } from './endpoints.js';

const ORIGIN = 'https://one.example.com';
const NEW_ORIGIN = 'https://two.example.com';
const success = () => ({ ok: true, closeConfirmed: true, toolNames: [], truncated: false, durationMs: 1 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(options = {}) {
  let accountOrigin = options.origin === null ? undefined : options.origin ?? ORIGIN;
  const operations = [];
  const values = new Map();
  if (options.formalKey !== undefined) values.set(FORMAL_CREDENTIAL_REF, options.formalKey);
  const credentials = {
    async describe(ref) { operations.push(['describe', ref]); return { configured: values.has(ref), writable: true }; },
    async resolve(ref) { operations.push(['resolve', ref]); return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined; },
    async set(ref, value) { operations.push(['set', ref, value]); values.set(ref, value); },
    async unset(ref) { operations.push(['unset', ref]); values.delete(ref); },
  };
  const live = new Map();
  const registrations = [];
  const disposals = [];
  const mcpManager = {
    register(name, entry) {
      operations.push(['register', name]);
      if (options.registrationFailure?.(name)) throw new Error(`conflict ${name}`);
      registrations.push({ name, entry });
      live.set(name, entry);
      return () => { disposals.push(name); live.delete(name); };
    },
    list() {
      return [...live.keys()].map(name => ({
        name,
        configured: true,
        status: { state: 'connected', toolCount: 2, connectedAt: 1, lastError: `${options.formalKey ?? ''}:private` },
      }));
    },
  };
  const probes = [];
  const pendingProbe = options.pendingProbe;
  const probe = options.probe ?? (async (origin, service, ref, signal) => {
    const config = probeConfig(origin, service, ref);
    probes.push({ origin, service: service.name, ref, signal, config });
    if (pendingProbe && probes.length === 1) return pendingProbe.promise;
    if (options.probeResults) return options.probeResults[probes.length - 1] ?? success();
    return success();
  });
  let environmentCallback;
  const saved = [];
  const saveBoundOrigin = async value => {
    operations.push(['bound', value]);
    saved.push(value);
    if (options.saveFailure) throw new Error('private settings failure');
  };
  const controller = new OnboardingController({
    origin: accountOrigin,
    readOrigin: options.readOrigin ?? (() => accountOrigin),
    boundOrigin: options.boundOrigin,
    credentials,
    mcpManager,
    probe,
    saveBoundOrigin,
    hasLegacy: () => options.legacy === true,
    onEnvironment: callback => { environmentCallback = callback; return () => {}; },
    logger: { warn() {} },
  });
  return { controller, values, operations, registrations, disposals, probes, saved,
    changeEnvironment: value => { accountOrigin = value; environmentCallback(value); } };
}

test('空 origin 为 environment-required，不探测、不注册、不写凭据', async () => {
  const f = fixture({ origin: null });
  await f.controller.readyPromise;
  assert.equal(f.controller.refreshState().phase, 'environment-required');
  const state = await f.controller.connect({ apiKey: 'new-secret', origin: undefined });
  assert.equal(state.error.code, 'ENVIRONMENT_REQUIRED');
  assert.equal(f.probes.length, 0);
  assert.equal(f.registrations.length, 0);
  assert.equal(f.values.size, 0);
});

test('账号服务晚于插件就绪时，状态刷新会取得地址并恢复连接', async () => {
  let currentOrigin;
  const f = fixture({
    origin: null,
    formalKey: 'old-secret',
    boundOrigin: ORIGIN,
    readOrigin: () => currentOrigin,
  });
  await f.controller.readyPromise;
  assert.equal(f.controller.refreshState().phase, 'environment-required');
  currentOrigin = ORIGIN;
  const refreshed = f.controller.refreshState();
  assert.equal(refreshed.origin, ORIGIN);
  await f.controller.tail;
  const restored = f.controller.refreshState();
  assert.equal(restored.phase, 'connected');
  assert.deepEqual(f.registrations.map(item => item.name), SERVICES.map(service => service.name));
});

test('账号地址晚到后，首次连接会先同步环境再提交', async () => {
  let currentOrigin;
  const f = fixture({ origin: null, readOrigin: () => currentOrigin });
  await f.controller.readyPromise;
  currentOrigin = ORIGIN;
  const state = await f.controller.connect({ apiKey: 'new-secret' });
  assert.equal(state.phase, 'connected');
  assert.equal(f.controller.origin, ORIGIN);
  assert.equal(f.registrations[0].entry.url, `${ORIGIN}${SERVICES[0].path}`);
});

test('legacy-managed 只读，不注册同名、不探测、不迁移', async () => {
  const f = fixture({ legacy: true, formalKey: 'old-secret', boundOrigin: ORIGIN });
  await f.controller.readyPromise;
  const initial = f.controller.refreshState();
  assert.equal(initial.phase, 'legacy-managed');
  assert.equal(initial.legacyManaged, true);
  assert.ok(initial.services.every(service => service.managedBy === 'legacy' && !service.registered));
  const state = await f.controller.connect({ apiKey: 'new-secret', origin: ORIGIN });
  assert.equal(state.phase, 'legacy-managed');
  assert.equal(f.probes.length, 0);
  assert.equal(f.registrations.length, 0);
  assert.equal(f.operations.some(operation => operation[0] === 'set' || operation[0] === 'bound'), false);
});

test('重启时 boundOrigin 相同且正式 Key 存在才恢复注册', async () => {
  const restored = fixture({ formalKey: 'old-secret', boundOrigin: ORIGIN });
  await restored.controller.readyPromise;
  assert.equal(restored.controller.refreshState().phase, 'connected');
  assert.deepEqual(restored.registrations.map(item => item.name), SERVICES.map(service => service.name));
  assert.equal(restored.registrations[0].entry.headers['X-API-Key'], '${credential:XIAOZHI_DATAHUB_API_KEY}');

  const changed = fixture({ formalKey: 'old-secret', boundOrigin: NEW_ORIGIN });
  await changed.controller.readyPromise;
  assert.equal(changed.controller.refreshState().phase, 'environment-changed');
  assert.equal(changed.registrations.length, 0);

  const missing = fixture({ boundOrigin: ORIGIN });
  await missing.controller.readyPromise;
  assert.equal(missing.registrations.length, 0);
  assert.equal(missing.controller.refreshState().configured, false);
});

test('暂存 Key 第二端点失败时保留旧正式 Key、boundOrigin 与旧连接，finally 清暂存', async () => {
  const failure = { ok: false, stage: 'list', message: 'new-secret must not escape', closeConfirmed: true };
  const f = fixture({ formalKey: 'old-secret', boundOrigin: ORIGIN, probeResults: [success(), failure] });
  await f.controller.readyPromise;
  const beforeEntries = f.registrations.map(item => item.entry);
  const state = await f.controller.connect({ apiKey: 'new-secret', origin: ORIGIN });
  assert.equal(state.error.code, 'PROBE_FAILED');
  assert.deepEqual(state.error.details.failures, [{ service: 'datahub-knowledge', stage: 'list' }]);
  assert.equal(f.values.get(FORMAL_CREDENTIAL_REF), 'old-secret');
  assert.equal(f.values.has(STAGING_CREDENTIAL_REF), false);
  assert.equal(f.controller.boundOrigin, ORIGIN);
  assert.equal(f.disposals.length, 0);
  assert.deepEqual(f.registrations.map(item => item.entry), beforeEntries);
  assert.ok(state.services.every(service => service.registered && service.state === 'connected'));
  assert.ok(f.probes.every(probe => probe.ref === STAGING_CREDENTIAL_REF));
  assert.doesNotMatch(JSON.stringify(state), /old-secret|new-secret|private/);
});

test('环境变化同步释放本插件注册并中止探测，旧 Key 不发往新 origin', async () => {
  const pending = deferred();
  const f = fixture({ formalKey: 'old-secret', boundOrigin: ORIGIN, pendingProbe: pending });
  await f.controller.readyPromise;
  const connecting = f.controller.connect({ apiKey: 'new-secret', origin: ORIGIN });
  while (f.probes.length === 0) await new Promise(resolve => setImmediate(resolve));
  f.changeEnvironment(NEW_ORIGIN);
  assert.equal(f.disposals.length, 2);
  assert.equal(f.controller.registrations.size, 0);
  assert.equal(f.probes[0].signal.aborted, true);
  pending.resolve(success());
  const state = await connecting;
  assert.equal(state.phase, 'environment-changed');
  assert.equal(state.origin, NEW_ORIGIN);
  assert.equal(state.boundOrigin, ORIGIN);
  assert.equal(f.values.get(FORMAL_CREDENTIAL_REF), 'old-secret');
  assert.equal(f.values.has(STAGING_CREDENTIAL_REF), false);
  assert.equal(f.probes.length, 1);
  assert.ok(f.probes.every(probe => probe.origin === ORIGIN));
  assert.equal(f.registrations.length, 2, '仅有环境变化前的两次启动注册');
});

test('成功验证使用暂存引用，提交后按正式引用注册两个固定参数', async () => {
  const f = fixture();
  await f.controller.readyPromise;
  const state = await f.controller.connect({ apiKey: 'new-secret', origin: ORIGIN });
  assert.equal(state.phase, 'connected');
  assert.equal(state.configured, true);
  assert.equal(state.boundOrigin, ORIGIN);
  assert.equal(f.values.get(FORMAL_CREDENTIAL_REF), 'new-secret');
  assert.equal(f.values.has(STAGING_CREDENTIAL_REF), false);
  assert.deepEqual(f.probes.map(probe => probe.ref), [STAGING_CREDENTIAL_REF, STAGING_CREDENTIAL_REF]);
  assert.deepEqual(f.probes.map(probe => probe.config.url), [
    `${ORIGIN}/api/mcp/ask-data`, `${ORIGIN}/api/mcp/knowledge`,
  ]);
  assert.deepEqual(f.registrations.map(item => item.entry.toolCallTimeoutMs), [180_000, 120_000]);
  for (const item of f.registrations) {
    assert.equal(item.entry.headers['X-API-Key'], '${credential:XIAOZHI_DATAHUB_API_KEY}');
    assert.equal(Object.hasOwn(item.entry, 'serverName'), false);
  }
  const setFormal = f.operations.findIndex(operation => operation[0] === 'set' && operation[1] === FORMAL_CREDENTIAL_REF);
  const secondProbe = f.operations.findIndex(operation => operation[0] === 'resolve');
  const savedBound = f.operations.findIndex(operation => operation[0] === 'bound');
  assert.ok(setFormal > secondProbe && savedBound > setFormal);
  assert.deepEqual(f.saved, [ORIGIN]);
  assert.equal(JSON.stringify(state).includes('new-secret'), false);
  assert.equal(Object.hasOwn(state, 'apiKey'), false);
});

test('所有连接和换 Key 操作串行，成功换 Key 保留现有注册', async () => {
  const pending = deferred();
  const f = fixture({ pendingProbe: pending });
  await f.controller.readyPromise;
  const first = f.controller.connect({ apiKey: 'first-secret', origin: ORIGIN });
  while (f.probes.length === 0) await new Promise(resolve => setImmediate(resolve));
  const second = f.controller.connect({ apiKey: 'second-secret', origin: ORIGIN });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.probes.length, 1);
  pending.resolve(success());
  await first;
  await second;
  assert.equal(f.probes.length, 4);
  assert.equal(f.registrations.length, 2, '同 origin 换 Key 不重建原注册');
  assert.equal(f.values.get(FORMAL_CREDENTIAL_REF), 'second-secret');
  assert.equal(f.controller.refreshState().phase, 'connected');
});

test('注册失败回滚正式 Key 与 boundOrigin，状态不包含秘密或原生诊断', async () => {
  const f = fixture({ formalKey: 'old-secret', registrationFailure: name => name === 'datahub-knowledge' });
  await f.controller.readyPromise;
  const state = await f.controller.connect({ apiKey: 'new-secret', origin: ORIGIN });
  assert.equal(state.error.code, 'REGISTRATION_FAILED');
  assert.equal(f.values.get(FORMAL_CREDENTIAL_REF), 'old-secret');
  assert.equal(f.values.has(STAGING_CREDENTIAL_REF), false);
  assert.equal(f.controller.boundOrigin, undefined);
  assert.deepEqual(f.saved, [ORIGIN, undefined]);
  assert.equal(f.controller.registrations.size, 0);
  assert.doesNotMatch(JSON.stringify(state), /old-secret|new-secret|conflict|private/);
});

test('重新检测只允许相同绑定 origin；断开后释放注册，清除 Key 后 configured=false', async () => {
  const f = fixture({ formalKey: 'old-secret', boundOrigin: ORIGIN });
  await f.controller.readyPromise;
  f.changeEnvironment(NEW_ORIGIN);
  const retry = await f.controller.retry({ origin: NEW_ORIGIN });
  assert.equal(retry.phase, 'environment-changed');
  assert.equal(f.probes.length, 0);
  f.changeEnvironment(ORIGIN);
  const retried = await f.controller.retry({ origin: ORIGIN });
  assert.equal(retried.phase, 'connected');
  assert.ok(f.probes.every(probe => probe.ref === FORMAL_CREDENTIAL_REF));
  const disconnected = await f.controller.disconnect();
  assert.equal(disconnected.services.every(service => !service.registered), true);
  assert.equal(disconnected.configured, true);
  assert.equal(disconnected.boundOrigin, undefined);
  const cleared = await f.controller.clearKey();
  assert.equal(cleared.configured, false);
  assert.equal(f.values.has(FORMAL_CREDENTIAL_REF), false);
  assert.equal(f.values.has(STAGING_CREDENTIAL_REF), false);
});
