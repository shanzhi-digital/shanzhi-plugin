import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAccountManager, AUTH_REQUIRED_KIND, CLIENT_NAME, NOT_UPGRADED_MESSAGE, isLoopbackHost } from './accounts.js';
import { ApiError, getMe } from './api-client.js';
import { isLosslessJson, assertLossless } from './assert-lossless.js';

const SERVER = 'http://lvyue.test:8081/api/v1';
const workRoot = mkdtempSync(join(tmpdir(), 'contract-sure-accounts-'));
test.after(() => rmSync(workRoot, { recursive: true, force: true }));

let dirCounter = 0;
function freshConfigPath() {
  return join(workRoot, `case-${++dirCounter}`, 'dsh-config.json');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, label) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await sleep(2);
  }
  throw new Error(`等待超时：${label}`);
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// 宿主 ctx.credentials 的测试替身：按宿主规则校验 key 与 grant payload。
// hooks 用来模拟读写失败、写入被吞掉、写入卡住等情况。
function memoryCredentials() {
  const records = new Map();
  const keyPattern = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u;
  const hooks = { failRead: false, failWrite: false, dropWrites: false, beforeModify: null };
  const writes = [];
  return {
    records,
    hooks,
    writes,
    async readRecord(key) {
      assert.match(key, keyPattern);
      if (hooks.failRead) throw new Error(`EIO: credentials.yaml unreadable (${key})`);
      return records.has(key) ? structuredClone(records.get(key)) : undefined;
    },
    async describeRecord(key) {
      return records.has(key) ? { configured: true, kind: records.get(key).kind, writable: true } : { configured: false, writable: true };
    },
    async modifyRecord(key, mutate) {
      assert.match(key, keyPattern);
      if (hooks.beforeModify) await hooks.beforeModify(key);
      if (hooks.failWrite) throw new Error('EACCES: credentials.yaml is read-only');
      const next = await mutate(records.get(key));
      if (next === undefined) return records.get(key);
      writes.push(key);
      if (next.kind === 'grant') assert.ok(isLosslessJson(next.payload), 'grant payload 必须是无损 JSON');
      if (next.kind === 'api-key') assert.ok(typeof next.key === 'string' && next.key.length > 0);
      if (!hooks.dropWrites) records.set(key, structuredClone(next));
      return next;
    },
    async deleteRecord(key) {
      if (hooks.failWrite) throw new Error('EACCES: credentials.yaml is read-only');
      records.delete(key);
    },
  };
}

// ctx 里没有 settings：插件不再读写宿主 settings，访问到就算失败。
function makeCtx({ credentials, logs } = {}) {
  return {
    logger: { warn: (message) => logs?.push(String(message)) },
    get(name) {
      if (name === 'credentials') return credentials;
      if (name === 'settings') throw new Error('插件不应再访问宿主 settings');
      return undefined;
    },
  };
}

// 履约后端（约定 A）的 fetch 替身。
function createBackend() {
  const calls = [];
  const state = {
    pollQueue: [],
    validTokens: new Set(),
    revokeFails: false,
    // A1 返回的 verifyUrl / verifyPath 模板，{req} 换成 requestId；verifyUrl 为 null 表示后端不知道前端地址。
    verifyUrl: null,
    verifyPath: null,
    // A1 的替代响应：{ httpStatus, body }；startGate 不为空时 A1 等它 resolve 后才返回。
    startResponse: null,
    startGate: null,
    // 某个路径直接抛出的底层异常（模拟网络错误、无效请求头）；times 为次数，不填表示一直抛。
    throwOn: null,
    // 数据库故障：带插件令牌的请求一律 HTTP 503「服务暂时不可用」。
    unavailable: false,
    nextRequest: 1,
    nextToken: 1,
  };
  const json = (status, payload) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v1/u, '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const auth = init.headers?.Authorization || '';
    calls.push({ origin: parsed.origin, path, method: init.method, body, auth, redirect: init.redirect });
    if (state.throwOn?.path === path && (state.throwOn.times === undefined || state.throwOn.times-- > 0)) {
      throw state.throwOn.error;
    }

    if (path === '/auth/plugin-authorize/start') {
      if (state.startGate) await state.startGate;
      if (state.startResponse) return json(state.startResponse.httpStatus, state.startResponse.body ?? { code: 500 });
      const requestId = `req${state.nextRequest++}-abcdefghijklmnopqrstuv`;
      const fill = (template) => (template ? template.replaceAll('{req}', requestId) : template);
      return json(200, {
        code: 200,
        message: 'success',
        data: {
          requestId,
          userCode: 'ABCD-2345',
          pollSecret: `poll-secret-${requestId}-0123456789abcdefghijklmnopqrstuv`,
          verifyPath: fill(state.verifyPath) ?? `/plugin-authorize?req=${requestId}`,
          verifyUrl: fill(state.verifyUrl) ?? null,
          interval: 2,
          expiresIn: 600,
        },
      });
    }
    if (path === '/auth/plugin-authorize/poll') {
      const next = state.pollQueue.shift() || { status: 'PENDING' };
      // 模拟后端把请求内容回显在错误正文里。
      if (next.httpStatus) return json(next.httpStatus, { code: next.httpStatus, message: `bad request ${JSON.stringify(body)}` });
      if (next.code) return json(200, { code: next.code, message: next.message, data: null });
      if (next.status === 'APPROVED') {
        const token = `plugin-jwt-${state.nextToken++}`;
        state.validTokens.add(token);
        return json(200, { code: 200, message: 'success', data: { ...next, token } });
      }
      return json(200, { code: 200, message: 'success', data: next });
    }
    if (path === '/auth/plugin-token/revoke') {
      if (state.revokeFails) throw new TypeError('fetch failed');
      state.validTokens.delete(auth.replace(/^Bearer /u, ''));
      return json(200, { code: 200, message: 'success', data: null });
    }
    if (state.unavailable) return json(503, { code: 503, message: '服务暂时不可用', data: null });
    if (!state.validTokens.has(auth.replace(/^Bearer /u, ''))) {
      return json(401, { code: 401, message: '登录已过期，请重新登录', data: null });
    }
    if (path === '/auth/me') {
      return json(200, { code: 200, data: { id: 1, username: 'zhangsan', realName: '张三', deptName: '销售二部' } });
    }
    return json(404, { code: 404, message: 'not found', data: null });
  }
  return { fetchImpl, calls, state };
}

function approved(userId, extra = {}) {
  return {
    status: 'APPROVED',
    grantId: 100 + userId,
    expiresAt: '2099-02-22T10:00:00+08:00',
    user: { userId, username: `user${userId}`, realName: `用户${userId}`, deptName: '销售一部' },
    ...extra,
  };
}

function createManager({ ctx, backend, configPath = freshConfigPath(), now, delays } = {}) {
  const manager = createAccountManager(ctx, {
    configPath,
    fetchImpl: backend.fetchImpl,
    hostname: () => 'test-mac',
    // 记下要求的间隔，但实际只等 1ms，测试跑得快。
    schedule: (fn, ms) => {
      delays?.push(ms);
      return setTimeout(fn, 1);
    },
    cancelSchedule: (handle) => clearTimeout(handle),
    ...(now ? { now } : {}),
  });
  return { manager, configPath };
}

async function waitForResult(manager, requestId) {
  for (let i = 0; i < 500; i++) {
    const result = await manager.pollAuthorization(requestId);
    if (result.status !== 'pending') return result;
    await sleep(2);
  }
  throw new Error('授权结果一直是 pending');
}

async function connect(manager, backend, userId) {
  backend.state.pollQueue.push(approved(userId));
  const started = await manager.startAuthorization();
  return waitForResult(manager, started.requestId);
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
}

test('browser authorization: start → pending → approved stores the token only in the credential store', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager, configPath } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  backend.state.pollQueue.push({ status: 'PENDING' }, approved(1, { user: { userId: 1, username: 'zhangsan', realName: '张三', deptName: '销售二部' } }));

  const started = await manager.startAuthorization();
  assertLossless(started, 'startAuthorization 结果');
  assert.deepEqual(Object.keys(started).sort(), ['expiresAt', 'interval', 'requestId', 'userCode', 'verifyUrl']);
  assert.equal(started.userCode, 'ABCD-2345');
  assert.equal(started.interval, 2);
  // 后端 verifyUrl 为 null 时，用 serverUrl 的 origin 拼 verifyPath。
  assert.equal(started.verifyUrl, `http://lvyue.test:8081/plugin-authorize?req=${started.requestId}`);
  assert.ok(Date.parse(started.expiresAt) > Date.now());
  const startCall = backend.calls.find((call) => call.path === '/auth/plugin-authorize/start');
  assert.deepEqual(startCall.body, { clientName: CLIENT_NAME, deviceName: 'test-mac' });
  assert.equal(startCall.auth, '');

  assert.deepEqual(await manager.pollAuthorization(started.requestId), { status: 'pending' });
  const result = await waitForResult(manager, started.requestId);
  assert.equal(result.status, 'approved');
  assert.deepEqual(result.account, {
    id: 'u1',
    userId: 1,
    username: 'zhangsan',
    realName: '张三',
    deptName: '销售二部',
    expiresAt: '2099-02-22T10:00:00+08:00',
    addedAt: result.account.addedAt,
    status: 'ok',
  });
  assert.equal(result.state.activeAccountId, 'u1');
  assert.equal(result.state.accounts.length, 1);
  assert.equal(result.state.credentialStore, 'dsh-credentials');
  assertLossless(result, 'pollAuthorization 结果');

  // A5 轮询只带 requestId + pollSecret，不带令牌。
  const pollCalls = backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll');
  assert.ok(pollCalls.length >= 2);
  assert.ok(pollCalls.every((call) => call.body.requestId === started.requestId && call.body.pollSecret && !call.auth));
  const pollSecret = pollCalls[0].body.pollSecret;

  const record = credentials.records.get('contract-sure/account-1');
  assert.equal(record.kind, 'grant');
  assert.equal(record.payload.token, 'plugin-jwt-1');
  assert.equal(record.payload.grantId, 101);
  assert.equal(record.payload.expiresAt, '2099-02-22T10:00:00+08:00');
  assert.equal(record.payload.serverUrl, SERVER);

  // 令牌、pollSecret 不出现在 State、配置文件里。
  const stateText = JSON.stringify(await manager.getState());
  const fileText = readFileSync(configPath, 'utf8');
  for (const text of [stateText, JSON.stringify(result), fileText]) {
    assert.ok(!text.includes('plugin-jwt-1'));
    assert.ok(!text.includes(pollSecret));
  }
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  // 已连接后用该账户调用后端。
  const tested = await manager.testConnection();
  assert.deepEqual(tested, {
    ok: true,
    message: '连接成功，当前账户：张三',
    account: { userId: 1, username: 'zhangsan', realName: '张三', deptName: '销售二部' },
  });
  assert.equal(backend.calls.findLast((call) => call.path === '/auth/me').auth, 'Bearer plugin-jwt-1');
  // 第 3 条：发给履约后端的请求一律不跟随重定向。
  assert.ok(backend.calls.every((call) => call.redirect === 'error'));
  manager.dispose();
});

test('re-authorizing the same user replaces the account and revokes the old grant; accounts can be switched', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });

  assert.equal((await connect(manager, backend, 1)).status, 'approved');
  const again = await connect(manager, backend, 1);
  assert.equal(again.status, 'approved');
  assert.equal(again.state.accounts.length, 1);
  assert.equal(credentials.records.get('contract-sure/account-1').payload.token, 'plugin-jwt-2');
  // 旧令牌尽力吊销（异步进行）。
  await waitUntil(() => !backend.state.validTokens.has('plugin-jwt-1'), '旧令牌吊销');
  assert.ok(
    backend.calls.some((call) => call.path === '/auth/plugin-token/revoke' && call.auth === 'Bearer plugin-jwt-1'),
  );

  const second = await connect(manager, backend, 2);
  assert.equal(second.state.activeAccountId, 'u2');
  assert.deepEqual(second.state.accounts.map((item) => item.id), ['u1', 'u2']);

  const switched = await manager.setActiveAccount('u1');
  assert.equal(switched.activeAccountId, 'u1');
  await assert.rejects(() => manager.setActiveAccount('u404'), /账户不存在/u);
  manager.dispose();
});

test('disconnectAccount revokes then deletes the credential and reports whether the server confirmed the revoke', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);
  await connect(manager, backend, 2);

  const afterFirst = await manager.disconnectAccount('u2');
  assert.ok(backend.calls.some((call) => call.path === '/auth/plugin-token/revoke' && call.auth === 'Bearer plugin-jwt-2'));
  assert.equal(credentials.records.has('contract-sure/account-2'), false);
  assert.deepEqual(afterFirst.accounts.map((item) => item.id), ['u1']);
  // 断开当前账户后，自动切到剩下的账户。
  assert.equal(afterFirst.activeAccountId, 'u1');
  // 第 10 条：服务端确认吊销。
  assert.equal(afterFirst.revoked, true);
  assertLossless(afterFirst, 'disconnectAccount 结果');

  // 吊销失败也删本地，但 revoked 为 false，界面可以提示「服务端没有确认吊销」。
  backend.state.revokeFails = true;
  const afterSecond = await manager.disconnectAccount('u1');
  assert.equal(credentials.records.has('contract-sure/account-1'), false);
  assert.deepEqual(afterSecond.accounts, []);
  assert.equal(afterSecond.activeAccountId, null);
  assert.equal(afterSecond.revoked, false);
  // State 自身字段不变，只多一个 revoked。
  assert.deepEqual(Object.keys(afterSecond).sort(), ['accounts', 'activeAccountId', 'credentialStore', 'ocr', 'revoked', 'serverUrl']);
  manager.dispose();
});

test('disconnectAccount stops when the credential cannot be read, so the grant can still be revoked later', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);

  credentials.hooks.failRead = true;
  await assert.rejects(
    () => manager.disconnectAccount('u1'),
    (error) => error.code === 'CREDENTIAL_READ_FAILED' && !/EIO|credentials\.yaml/u.test(error.message),
  );
  credentials.hooks.failRead = false;
  // 账户和凭据都还在，没有被当成「没有凭据」删掉。
  assert.deepEqual((await manager.getState()).accounts.map((item) => item.id), ['u1']);
  assert.equal(credentials.records.get('contract-sure/account-1').payload.token, 'plugin-jwt-1');
  assert.equal(backend.calls.some((call) => call.path === '/auth/plugin-token/revoke'), false);

  const retried = await manager.disconnectAccount('u1');
  assert.equal(retried.revoked, true);
  assert.deepEqual(retried.accounts, []);
  manager.dispose();
});

test('saveSettings: changing serverUrl needs disconnectAccounts; OCR key goes to the credential store and is masked', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager, configPath } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);

  await assert.rejects(
    () => manager.saveSettings({ serverUrl: 'http://other.test/api/v1' }),
    (error) => error.message === '更换服务器地址前需要先断开全部账户',
  );
  // 同一地址（只差结尾斜杠）不算更换。
  await manager.saveSettings({ serverUrl: `${SERVER}/` });
  await assert.rejects(() => manager.saveSettings({ serverUrl: 'ftp://bad' }), /HTTP\/HTTPS/u);

  const key = 'sk-deepseek-ocr-1234567890';
  await withEnv('DEEPSEEK_API_KEY', undefined, async () => {
    const withKey = await manager.saveSettings({ ocrApiKey: key, ocrApiUrl: 'https://ocr.example.com/v1/tools/ocr' });
    assert.deepEqual(withKey.ocr, {
      apiUrl: 'https://ocr.example.com/v1/tools/ocr',
      keyConfigured: true,
      keyMasked: 'sk-d...7890',
      keySource: 'credentials',
    });
    assert.deepEqual(credentials.records.get('contract-sure/ocr-api-key'), {
      kind: 'grant',
      payload: { version: 1, type: 'ocr-api-key', key, origin: 'https://ocr.example.com' },
    });
    assert.ok(!JSON.stringify(withKey).includes(key));
    assert.ok(!readFileSync(configPath, 'utf8').includes(key));

    const moved = await manager.saveSettings({ serverUrl: 'http://other.test/api/v1', disconnectAccounts: true });
    assert.equal(moved.serverUrl, 'http://other.test/api/v1');
    assert.deepEqual(moved.accounts, []);
    assert.equal(moved.activeAccountId, null);
    assert.equal(credentials.records.has('contract-sure/account-1'), false);
    // 吊销发往签发令牌的旧服务器。
    const revoke = backend.calls.find((call) => call.path === '/auth/plugin-token/revoke');
    assert.equal(revoke.origin, 'http://lvyue.test:8081');

    const cleared = await manager.saveSettings({ ocrApiKey: '' });
    assert.deepEqual(cleared.ocr, { apiUrl: 'https://ocr.example.com/v1/tools/ocr', keyConfigured: false, keyMasked: '', keySource: 'none' });
    assert.equal(credentials.records.has('contract-sure/ocr-api-key'), false);
  });
  manager.dispose();
});

test('OCR key is bound to the OCR origin; DEEPSEEK_API_KEY only counts for the official api.deepseek.com', async () => {
  const credentials = memoryCredentials();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend: createBackend() });
  await withEnv('DEEPSEEK_API_KEY', undefined, async () => {
    const official = await manager.saveSettings({ ocrApiKey: 'sk-official-1234567890' });
    assert.equal(official.ocr.keySource, 'credentials');
    assert.equal(official.ocr.apiUrl, 'https://api.deepseek.com/v1/tools/ocr');

    // 同一 origin 换路径：Key 保留。
    const samePath = await manager.saveSettings({ ocrApiUrl: 'https://api.deepseek.com/v2/ocr' });
    assert.equal(samePath.ocr.keySource, 'credentials');
    assert.equal((await manager.localConfig()).ocrApiKey, 'sk-official-1234567890');

    // 换 origin 又没给新 Key：旧 Key 被删掉，不会发给新地址。
    const moved = await manager.saveSettings({ ocrApiUrl: 'https://ocr.example.com/v1/ocr' });
    assert.deepEqual(moved.ocr, { apiUrl: 'https://ocr.example.com/v1/ocr', keyConfigured: false, keyMasked: '', keySource: 'none' });
    assert.equal(credentials.records.has('contract-sure/ocr-api-key'), false);
    assert.equal((await manager.localConfig()).ocrApiKey, '');

    // 换 origin 同时给新 Key：新 Key 绑定新 origin。
    const custom = await manager.saveSettings({ ocrApiUrl: 'https://ocr2.example.com/ocr', ocrApiKey: 'sk-custom-abcdefgh12' });
    assert.equal(custom.ocr.keySource, 'credentials');
    assert.equal(credentials.records.get('contract-sure/ocr-api-key').payload.origin, 'https://ocr2.example.com');
    assert.equal((await manager.localConfig()).ocrApiKey, 'sk-custom-abcdefgh12');

    // 绑定的 origin 和当前地址对不上（例如配置文件被改过）：不使用。
    credentials.records.set('contract-sure/ocr-api-key', {
      kind: 'grant',
      payload: { version: 1, type: 'ocr-api-key', key: 'sk-other-origin-123', origin: 'https://evil.example.com' },
    });
    assert.equal((await manager.getState()).ocr.keySource, 'none');
    assert.equal((await manager.localConfig()).ocrApiKey, '');
    await manager.saveSettings({ ocrApiKey: '' });
  });

  await withEnv('DEEPSEEK_API_KEY', 'sk-env-key-1234567890', async () => {
    // 自定义地址：环境变量不算。
    const custom = await manager.getState();
    assert.deepEqual(custom.ocr, { apiUrl: 'https://ocr2.example.com/ocr', keyConfigured: false, keyMasked: '', keySource: 'none' });
    // 官方地址：环境变量可用，State 标明来源，但不回显掩码。
    const official = await manager.saveSettings({ ocrApiUrl: '' });
    assert.deepEqual(official.ocr, {
      apiUrl: 'https://api.deepseek.com/v1/tools/ocr',
      keyConfigured: true,
      keyMasked: '',
      keySource: 'env',
    });
    assert.ok(!JSON.stringify(official).includes('sk-env-key'));
  });
  manager.dispose();
});

test('saveSettings accepts only the four patch fields, rejects URLs with credentials and secrets with control characters', async () => {
  const credentials = memoryCredentials();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend: createBackend() });
  await manager.saveSettings({ serverUrl: SERVER });
  const before = await manager.getState();

  const invalid = (patch, code) =>
    assert.rejects(
      () => manager.saveSettings(patch),
      (error) => error.code === code && !/hunter2|pa55word|secret-in/u.test(error.message),
    );
  await invalid({ serverUrl: SERVER, extra: 1 }, 'INVALID_REQUEST');
  await invalid({ apiToken: 'secret-in-token' }, 'INVALID_REQUEST');
  await invalid({ accounts: [] }, 'INVALID_REQUEST');
  await invalid({ disconnectAccounts: 'yes' }, 'INVALID_REQUEST');
  await invalid({ serverUrl: 'http://admin:hunter2@lvyue.test/api/v1' }, 'INVALID_URL');
  await invalid({ serverUrl: 'http://admin@lvyue.test/api/v1' }, 'INVALID_URL');
  await invalid({ ocrApiUrl: 'https://key:pa55word@ocr.example.com/ocr' }, 'INVALID_URL');
  // 格式错误的地址也不回显原文。
  await invalid({ serverUrl: 'not a url secret-in-url' }, 'INVALID_URL');
  await invalid({ ocrApiKey: 'sk-abc\nsecret-in-key' }, 'INVALID_SECRET');
  await invalid({ ocrApiKey: 'sk-abc secret-in-key' }, 'INVALID_SECRET');
  await invalid({ ocrApiKey: 'sk-abc\u0000' }, 'INVALID_SECRET');

  // 什么都没改。
  assert.deepEqual(await manager.getState(), before);
  assert.equal(credentials.records.has('contract-sure/ocr-api-key'), false);
  manager.dispose();
});

test('authorization outcomes: denied, expired, cancelled, unknown request, and capped pending requests', async () => {
  const backend = createBackend();
  let clock = Date.now();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend, now: () => clock });
  await manager.saveSettings({ serverUrl: SERVER });

  backend.state.pollQueue.push({ status: 'DENIED' });
  const denied = await manager.startAuthorization();
  assert.deepEqual(await waitForResult(manager, denied.requestId), { status: 'denied' });

  backend.state.pollQueue.push({ code: 404, message: '授权请求不存在或已过期' });
  const missing = await manager.startAuthorization();
  assert.deepEqual(await waitForResult(manager, missing.requestId), { status: 'expired' });

  backend.state.pollQueue.push({ status: 'CONSUMED' });
  const consumed = await manager.startAuthorization();
  const consumedResult = await waitForResult(manager, consumed.requestId);
  assert.equal(consumedResult.status, 'error');
  assert.match(consumedResult.message, /重新连接/u);

  const timedOut = await manager.startAuthorization();
  clock += 601_000;
  assert.deepEqual(await manager.pollAuthorization(timedOut.requestId), { status: 'expired' });
  clock -= 601_000;

  const cancelled = await manager.startAuthorization();
  assert.deepEqual(await manager.cancelAuthorization(cancelled.requestId), { ok: true });
  const pollsBefore = backend.calls.filter((call) => call.body?.requestId === cancelled.requestId).length;
  await sleep(20);
  assert.equal(backend.calls.filter((call) => call.body?.requestId === cancelled.requestId).length, pollsBefore);
  assert.deepEqual(await manager.pollAuthorization(cancelled.requestId), { status: 'expired' });
  assert.deepEqual(await manager.pollAuthorization('no-such-request'), { status: 'expired' });

  // 同时最多 3 个进行中的请求，再发起时取消最早的那个。
  const started = [];
  for (let i = 0; i < 4; i++) started.push(await manager.startAuthorization());
  const oldest = await manager.pollAuthorization(started[0].requestId);
  assert.equal(oldest.status, 'error');
  for (const item of started.slice(1)) assert.equal((await manager.pollAuthorization(item.requestId)).status, 'pending');
  manager.dispose();
});

test('approved result is consumed on first read; cancelling after it was saved revokes the new token and removes the account', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });

  backend.state.pollQueue.push(approved(1));
  const first = await manager.startAuthorization();
  assert.equal((await waitForResult(manager, first.requestId)).status, 'approved');
  // 第二次读：终态，不再拼旧账户；取消也不影响已领取的结果。
  assert.deepEqual(await manager.pollAuthorization(first.requestId), { status: 'expired' });
  assert.deepEqual(await manager.cancelAuthorization(first.requestId), { ok: true });
  assert.deepEqual((await manager.getState()).accounts.map((item) => item.id), ['u1']);

  // 已经保存、界面还没领取时用户点了取消：撤销这次授权。
  backend.state.pollQueue.push(approved(2));
  const second = await manager.startAuthorization();
  await waitUntil(async () => (await manager.getState()).accounts.some((item) => item.id === 'u2'), '保存 u2');
  assert.deepEqual(await manager.cancelAuthorization(second.requestId), { ok: true });
  const state = await manager.getState();
  assert.deepEqual(state.accounts.map((item) => item.id), ['u1']);
  assert.equal(state.activeAccountId, 'u1');
  assert.equal(credentials.records.has('contract-sure/account-2'), false);
  assert.equal(backend.state.validTokens.has('plugin-jwt-2'), false);
  assert.deepEqual(await manager.pollAuthorization(second.requestId), { status: 'expired' });
  manager.dispose();
});

test('cancel while the approval is being saved: the saved account is undone and the new token revoked', { timeout: 10_000 }, async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });

  const blocked = deferred();
  const release = deferred();
  credentials.hooks.beforeModify = async (key) => {
    if (key !== 'contract-sure/account-1') return;
    credentials.hooks.beforeModify = null;
    blocked.resolve();
    await release.promise;
  };
  backend.state.pollQueue.push(approved(1));
  const started = await manager.startAuthorization();
  await blocked.promise;
  // 正在保存时仍然报 pending，不会被判成过期。
  assert.deepEqual(await manager.pollAuthorization(started.requestId), { status: 'pending' });
  const cancelling = manager.cancelAuthorization(started.requestId);
  release.resolve();
  assert.deepEqual(await cancelling, { ok: true });

  assert.deepEqual((await manager.getState()).accounts, []);
  assert.equal(credentials.records.has('contract-sure/account-1'), false);
  assert.equal(backend.state.validTokens.has('plugin-jwt-1'), false);
  assert.ok(backend.calls.some((call) => call.path === '/auth/plugin-token/revoke' && call.auth === 'Bearer plugin-jwt-1'));
  assert.deepEqual(await manager.pollAuthorization(started.requestId), { status: 'expired' });
  manager.dispose();
});

test('an APPROVED result waiting behind other work is re-checked: cancelled or locally expired requests are not saved', { timeout: 10_000 }, async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  let clock = Date.now();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend, now: () => clock });
  await manager.saveSettings({ serverUrl: SERVER });

  // 用一次卡住的 OCR Key 保存把写队列堵住，让 APPROVED 的提交排在后面。
  const blockQueue = () => {
    const blocked = deferred();
    const release = deferred();
    credentials.hooks.beforeModify = async (key) => {
      if (key !== 'contract-sure/ocr-api-key') return;
      credentials.hooks.beforeModify = null;
      blocked.resolve();
      await release.promise;
    };
    const saving = manager.saveSettings({ ocrApiKey: 'sk-block-123456789' });
    return { blocked: blocked.promise, release: release.resolve, saving };
  };

  // 1. 提交前已取消：不保存，吊销新令牌。
  let queue = blockQueue();
  await queue.blocked;
  backend.state.pollQueue.push(approved(1));
  const cancelled = await manager.startAuthorization();
  await waitUntil(() => backend.state.validTokens.has('plugin-jwt-1'), '后端签发令牌');
  await sleep(5);
  const cancelling = manager.cancelAuthorization(cancelled.requestId);
  queue.release();
  await queue.saving;
  assert.deepEqual(await cancelling, { ok: true });
  await waitUntil(() => !backend.state.validTokens.has('plugin-jwt-1'), '吊销被取消的令牌');
  assert.deepEqual((await manager.getState()).accounts, []);
  assert.equal(credentials.records.has('contract-sure/account-1'), false);
  // 提交前就发现已取消：根本没有写过这条凭据。
  assert.equal(credentials.writes.includes('contract-sure/account-1'), false);

  // 2. 提交前本地已过期：不保存，吊销新令牌，结果是 expired。
  queue = blockQueue();
  await queue.blocked;
  backend.state.pollQueue.push(approved(2));
  const late = await manager.startAuthorization();
  await waitUntil(() => backend.state.validTokens.has('plugin-jwt-2'), '后端签发令牌');
  await sleep(5);
  clock += 601_000;
  queue.release();
  await queue.saving;
  assert.deepEqual(await waitForResult(manager, late.requestId), { status: 'expired' });
  await waitUntil(() => !backend.state.validTokens.has('plugin-jwt-2'), '吊销过期的令牌');
  assert.deepEqual((await manager.getState()).accounts, []);
  assert.equal(credentials.writes.includes('contract-sure/account-2'), false);
  manager.dispose();
});

test('startAuthorization reserves a slot before calling A1 and drops responses that come back after a server change or dispose', { timeout: 10_000 }, async () => {
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  const startCalls = () => backend.calls.filter((call) => call.path === '/auth/plugin-authorize/start').length;

  // 三个 A1 还在路上：第四个直接拒绝，不再发请求。
  let gate = deferred();
  backend.state.startGate = gate.promise;
  const inFlight = [manager.startAuthorization(), manager.startAuthorization(), manager.startAuthorization()];
  await waitUntil(() => startCalls() === 3, '三个 A1 发出');
  await assert.rejects(() => manager.startAuthorization(), (error) => error.code === 'AUTH_BUSY');
  assert.equal(startCalls(), 3);
  backend.state.startGate = null;
  gate.resolve();
  const results = await Promise.all(inFlight);
  for (const item of results) assert.equal((await manager.pollAuthorization(item.requestId)).status, 'pending');

  // A1 在路上时换了服务器：回来的请求作废。
  gate = deferred();
  backend.state.startGate = gate.promise;
  const beforeSwitch = manager.startAuthorization();
  await waitUntil(() => startCalls() === 4, '第四个 A1 发出');
  await manager.saveSettings({ serverUrl: 'http://other.test/api/v1' });
  backend.state.startGate = null;
  gate.resolve();
  await assert.rejects(() => beforeSwitch, (error) => error.code === 'SERVER_CHANGED' && /服务器地址已经变更/u.test(error.message));
  // 换服务器时，旧服务器上进行中的授权也一并作废。
  for (const item of results) assert.equal((await manager.pollAuthorization(item.requestId)).status, 'expired');

  // A1 在路上时插件卸载：同样作废。
  gate = deferred();
  backend.state.startGate = gate.promise;
  const beforeDispose = manager.startAuthorization();
  await waitUntil(() => startCalls() === 5, '第五个 A1 发出');
  manager.dispose();
  gate.resolve();
  await assert.rejects(() => beforeDispose, (error) => error.code === 'SERVER_CHANGED');
  await assert.rejects(() => manager.startAuthorization(), (error) => error.code === 'DISPOSED');
});

test('startAuthorization on a backend without the plugin endpoints says the system needs upgrading', async () => {
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  for (const response of [
    { httpStatus: 404, body: { status: 404, error: 'Not Found', path: '/api/v1/auth/plugin-authorize/start' } },
    { httpStatus: 403, body: { code: 403, message: '无操作权限' } },
    { httpStatus: 401, body: { code: 401, message: '认证失败' } },
    { httpStatus: 200, body: { code: 401, message: '认证失败，无法访问系统资源' } },
    { httpStatus: 200, body: { code: 404, message: '请求地址不存在' } },
  ]) {
    backend.state.startResponse = response;
    await assert.rejects(
      () => manager.startAuthorization(),
      (error) => error.code === 'NOT_SUPPORTED' && error.message === NOT_UPGRADED_MESSAGE,
      JSON.stringify(response),
    );
  }
  // 限流不是「没升级」。
  backend.state.startResponse = { httpStatus: 200, body: { code: 429, message: '请求过于频繁' } };
  await assert.rejects(() => manager.startAuthorization(), (error) => error.code === 'RATE_LIMITED');
  manager.dispose();
});

test('withBackend returns contract C when there is no account, the grant expired, or the backend answers 401', async () => {
  const backend = createBackend();
  let clock = Date.now();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend, now: () => clock });
  await manager.saveSettings({ serverUrl: SERVER });

  const noAccount = await manager.withBackend(async () => 'unused');
  assert.deepEqual(noAccount, {
    ok: false,
    authRequired: {
      kind: AUTH_REQUIRED_KIND,
      reason: 'no-account',
      serverUrl: SERVER,
      message: '需要先连接履约系统账户：请点下方卡片的「连接账户」，在浏览器里完成授权后，回复「继续」。',
    },
  });

  await connect(manager, backend, 1);
  const ok = await manager.withBackend(async (cfg) => cfg.apiToken.length > 0);
  assert.deepEqual(ok, { ok: true, value: true });

  clock = Date.parse('2099-03-01T00:00:00Z');
  const expired = await manager.withBackend(async () => 'unused');
  assert.equal(expired.authRequired.reason, 'expired');
  assert.match(expired.authRequired.message, /用户1/u);
  assert.equal((await manager.getState()).accounts[0].status, 'expired');
  clock = Date.now();
  // 已标成过期的账户：时钟回来也不再请求后端，重新授权才恢复。
  let called = false;
  const stillExpired = await manager.withBackend(async () => {
    called = true;
  });
  assert.equal(stillExpired.authRequired.reason, 'expired');
  assert.equal(called, false);

  await connect(manager, backend, 1);
  backend.state.validTokens.clear();
  const revoked = await manager.withBackend((cfg) => getMe(cfg, { fetchImpl: backend.fetchImpl }));
  assert.equal(revoked.ok, false);
  assert.equal(revoked.authRequired.reason, 'revoked');
  assert.equal((await manager.getState()).accounts[0].status, 'revoked');

  // 第 6 条：已标成 revoked 的账户直接返回约定 C，不再拿旧令牌请求后端。
  const meCalls = backend.calls.filter((call) => call.path === '/auth/me').length;
  const shortCircuit = await manager.withBackend((cfg) => getMe(cfg, { fetchImpl: backend.fetchImpl }));
  assert.equal(shortCircuit.authRequired.reason, 'revoked');
  const tested = await manager.testConnection();
  assert.equal(tested.ok, false);
  assert.match(tested.message, /失效/u);
  assert.equal(backend.calls.filter((call) => call.path === '/auth/me').length, meCalls);
  manager.dispose();
});

test('account status follows the grant: a late 401 for a replaced token does not mark the new grant', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);
  const old = await manager.resolveBackend();
  assert.equal(old.cfg.apiToken, 'plugin-jwt-1');

  await connect(manager, backend, 1);
  assert.equal(credentials.records.get('contract-sure/account-1').payload.token, 'plugin-jwt-2');
  const late = await manager.runBackend(old.cfg, async () => {
    throw new ApiError('late', { status: 401, code: 'UNAUTHORIZED' });
  });
  assert.equal(late.ok, false);
  assert.equal(late.authRequired.reason, 'revoked');
  // 新授权不受影响。
  assert.equal((await manager.getState()).accounts[0].status, 'ok');
  assert.deepEqual(await manager.withBackend(async (cfg) => cfg.apiToken), { ok: true, value: 'plugin-jwt-2' });

  // 子请求的 401（主请求成功）也会标记账户，并且不会被随后的成功改回 ok。
  const sub = await manager.withBackend(async (cfg, backendCtx) => {
    await backendCtx.reportUnauthorized();
    return 'contract-created';
  });
  assert.deepEqual(sub, { ok: true, value: 'contract-created' });
  assert.equal((await manager.getState()).accounts[0].status, 'revoked');
  manager.dispose();
});

test('error messages never echo secrets, request bodies or low-level exception text', async () => {
  const logs = [];
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials(), logs }), backend });
  await manager.saveSettings({ serverUrl: SERVER });

  // A5 失败、后端把请求正文（含 pollSecret）回显在错误里：界面只看到 pending，看不到任何底层内容。
  backend.state.pollQueue.push({ httpStatus: 500 }, { httpStatus: 500 });
  const started = await manager.startAuthorization();
  await waitUntil(() => backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll').length >= 2, '两次失败的轮询');
  assert.deepEqual(await manager.pollAuthorization(started.requestId), { status: 'pending' });
  await manager.cancelAuthorization(started.requestId);

  // 底层异常（例如无效请求头时 Node 带出的 header 值）不回显。
  backend.state.throwOn = { path: '/auth/plugin-authorize/start', error: new TypeError('Invalid header value: "Bearer leaked-secret-123"') };
  await assert.rejects(
    () => manager.startAuthorization(),
    (error) => error.code === 'NETWORK_ERROR' && !/leaked-secret/u.test(error.message),
  );
  backend.state.throwOn = null;

  await connect(manager, backend, 1);
  backend.state.throwOn = { path: '/auth/me', error: new TypeError('Invalid header value: "Bearer plugin-jwt-1"') };
  const tested = await manager.testConnection();
  assert.equal(tested.ok, false);
  assert.match(tested.message, /^连接失败：/u);
  assert.doesNotMatch(tested.message, /plugin-jwt|Invalid header/u);
  backend.state.throwOn = null;

  assert.ok(logs.every((line) => !/poll-secret|plugin-jwt|leaked-secret/u.test(line)));
  manager.dispose();
});

test('legacy plaintext apiToken is dropped and ocrApiKey migrates out of the config file (host settings are not touched)', async () => {
  const credentials = memoryCredentials();
  const configPath = freshConfigPath();
  const legacy = {
    serverUrl: SERVER,
    apiToken: 'legacy-plugin-token-without-jti',
    ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr',
    ocrApiKey: 'sk-legacy-ocr-key-abcdef',
  };
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(legacy), { mode: 0o600 });
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend: createBackend(), configPath });

  const state = await manager.getState();
  assert.equal(state.serverUrl, SERVER);
  assert.deepEqual(state.accounts, []);
  assert.equal(state.ocr.keySource, 'credentials');
  assert.deepEqual(credentials.records.get('contract-sure/ocr-api-key'), {
    kind: 'grant',
    payload: { version: 1, type: 'ocr-api-key', key: 'sk-legacy-ocr-key-abcdef', origin: 'https://api.deepseek.com' },
  });

  const fileText = readFileSync(configPath, 'utf8');
  assert.ok(!fileText.includes('apiToken') && !fileText.includes('legacy-plugin-token'));
  assert.ok(!fileText.includes('ocrApiKey') && !fileText.includes('sk-legacy'));
  manager.dispose();
});

test('OCR key migration only deletes the old value after the new credential is written and read back', async () => {
  const credentials = memoryCredentials();
  const logs = [];
  const configPath = freshConfigPath();
  mkdirSync(join(configPath, '..'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({ serverUrl: SERVER, apiToken: 'legacy-token', ocrApiKey: 'sk-legacy-ocr-key-abcdef' }),
    { mode: 0o600 },
  );
  const fileHasKey = () => readFileSync(configPath, 'utf8').includes('sk-legacy-ocr-key-abcdef');

  await withEnv('DEEPSEEK_API_KEY', undefined, async () => {
    // 1. 写凭据失败：旧 Key 留在配置文件里；旧令牌照样删掉。
    credentials.hooks.failWrite = true;
    const first = createManager({ ctx: makeCtx({ credentials, logs }), backend: createBackend(), configPath }).manager;
    assert.equal((await first.getState()).ocr.keySource, 'none');
    assert.ok(fileHasKey());
    assert.ok(!readFileSync(configPath, 'utf8').includes('legacy-token'));
    // 普通保存不会覆盖掉这份待迁移的旧 Key。
    await first.saveSettings({ ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr', serverUrl: SERVER });
    assert.ok(fileHasKey());
    first.dispose();

    // 2. 写入被吞掉、回读对不上：仍然保留。
    credentials.hooks.failWrite = false;
    credentials.hooks.dropWrites = true;
    const second = createManager({ ctx: makeCtx({ credentials, logs }), backend: createBackend(), configPath }).manager;
    await second.getState();
    assert.ok(fileHasKey());
    second.dispose();

    // 3. 写入并回读成功：这时才从配置文件删掉。
    credentials.hooks.dropWrites = false;
    const third = createManager({ ctx: makeCtx({ credentials, logs }), backend: createBackend(), configPath }).manager;
    assert.equal((await third.getState()).ocr.keySource, 'credentials');
    assert.ok(!fileHasKey());
    assert.equal(credentials.records.get('contract-sure/ocr-api-key').payload.key, 'sk-legacy-ocr-key-abcdef');
    third.dispose();
  });
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((line) => !line.includes('sk-legacy') && !/EACCES/u.test(line)));
});

test('without ctx.get("credentials") the store falls back to a 0600 file next to the config', async () => {
  const backend = createBackend();
  const { manager, configPath } = createManager({ ctx: makeCtx({}), backend });
  await manager.saveSettings({ serverUrl: SERVER, ocrApiKey: 'sk-file-mode-key-123456' });
  const result = await connect(manager, backend, 3);
  assert.equal(result.status, 'approved');
  assert.equal(result.state.credentialStore, 'file');

  const credentialsPath = join(configPath, '..', 'credentials.json');
  assert.ok(existsSync(credentialsPath));
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  assert.equal(stored.records['contract-sure/account-3'].payload.token, 'plugin-jwt-1');
  assert.equal(stored.records['contract-sure/ocr-api-key'].payload.key, 'sk-file-mode-key-123456');
  assert.ok(!readFileSync(configPath, 'utf8').includes('plugin-jwt-1'));

  const call = await manager.withBackend(async (cfg) => cfg.apiToken);
  assert.deepEqual(call, { ok: true, value: 'plugin-jwt-1' });

  // 文件损坏：读取失败，不当作空库，也不往里写。
  const good = readFileSync(credentialsPath, 'utf8');
  writeFileSync(credentialsPath, '{ broken json', { mode: 0o600 });
  await assert.rejects(() => manager.withBackend(async () => 'unused'), (error) => error.code === 'CREDENTIAL_READ_FAILED');
  await assert.rejects(() => manager.saveSettings({ ocrApiKey: 'sk-another-key-12345' }), (error) => error.code === 'CREDENTIAL_READ_FAILED');
  assert.equal(readFileSync(credentialsPath, 'utf8'), '{ broken json');
  writeFileSync(credentialsPath, good, { mode: 0o600 });

  await manager.disconnectAccount('u3');
  assert.equal(JSON.parse(readFileSync(credentialsPath, 'utf8')).records['contract-sure/account-3'], undefined);
  manager.dispose();
});

test('verifyUrl: a backend verifyUrl pointing at this machine is ignored unless the server itself is local; fallback stays same-origin', async () => {
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  const verifyUrlFor = async (template, verifyPath = null) => {
    backend.state.verifyUrl = template;
    backend.state.verifyPath = verifyPath;
    const started = await manager.startAuthorization();
    await manager.cancelAuthorization(started.requestId);
    return { url: started.verifyUrl, req: started.requestId };
  };
  const fallback = (req) => `http://lvyue.test:8081/plugin-authorize?req=${req}`;

  // 后端 SSO_FRONTEND_URL 没配置时的默认值 localhost:3001 及其各种写法：不能用，改用 serverUrl 的 origin + verifyPath。
  for (const template of [
    'http://localhost:3001/plugin-authorize?req={req}',
    'http://localhost.:3001/plugin-authorize?req={req}',
    'http://LOCALHOST:3001/plugin-authorize?req={req}',
    'http://127.0.0.1:3001/plugin-authorize?req={req}',
    'http://127.1:3001/plugin-authorize?req={req}',
    'http://0.0.0.0:3001/plugin-authorize?req={req}',
    'http://[::1]:3001/plugin-authorize?req={req}',
    'http://[::ffff:127.0.0.1]:3001/plugin-authorize?req={req}',
    'http://[0:0:0:0:0:ffff:7f00:1]:3001/plugin-authorize?req={req}',
    'http://app.localhost/plugin-authorize?req={req}',
    'https://user:pass@lvyue.example.com/plugin-authorize?req={req}',
    'javascript:alert(1)',
  ]) {
    const { url, req } = await verifyUrlFor(template);
    assert.equal(url, fallback(req), template);
  }

  // verifyPath 解析后换了主机（//host、反斜杠）：不用，退回默认路径，仍是服务器的 origin。
  for (const verifyPath of ['//evil.example/plugin-authorize?req={req}', '/\\evil.example/plugin-authorize?req={req}', '/\\\\evil.example/x']) {
    const { url, req } = await verifyUrlFor(null, verifyPath);
    assert.equal(url, fallback(req), verifyPath);
  }
  const custom = await verifyUrlFor(null, '/sso/plugin-authorize?req={req}');
  assert.equal(custom.url, `http://lvyue.test:8081/sso/plugin-authorize?req=${custom.req}`);

  // 配置了正式前端地址：直接用。
  const configured = await verifyUrlFor('https://lvyue.example.com/plugin-authorize?req={req}');
  assert.equal(configured.url, `https://lvyue.example.com/plugin-authorize?req=${configured.req}`);

  // 履约服务器本身就在本机（本地开发）：本机的前端地址照用。
  await manager.saveSettings({ serverUrl: 'http://localhost:8081/api/v1' });
  const local = await verifyUrlFor('http://localhost:3001/plugin-authorize?req={req}');
  assert.equal(local.url, `http://localhost:3001/plugin-authorize?req=${local.req}`);
  const localFallback = await verifyUrlFor(null);
  assert.equal(localFallback.url, `http://localhost:8081/plugin-authorize?req=${localFallback.req}`);
  manager.dispose();
});

test('isLoopbackHost covers trailing dots and IPv4-mapped IPv6 loopback', () => {
  for (const host of ['localhost', 'localhost.', 'a.localhost', 'a.localhost.', '127.0.0.1', '127.255.0.9', '0.0.0.0', '[::1]', '::', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:0:0]', '[::7f00:1]']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['lvyue.example.com', 'localhost.example.com', '10.0.0.1', '128.0.0.1', '[::ffff:a00:1]', '[2001:db8::1]']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('L1 envelope codes: HTTP status first; HTTP 200 + code 403 is "无操作权限"; poll code 404 and EXPIRED both mean expired', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);

  const respond = (status, body) => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => manager.withBackend((cfg) => getMe(cfg, { fetchImpl: respond(200, { code: 403, message: '无操作权限', data: null }) })),
    (error) => error.code === 'FORBIDDEN' && /无操作权限/u.test(error.message),
  );
  // 第 12 条：HTTP 403 而信封里写 401，按 HTTP 403 处理，不会把账户标成失效。
  await assert.rejects(
    () => manager.withBackend((cfg) => getMe(cfg, { fetchImpl: respond(403, { code: 401, message: 'token invalid', data: null }) })),
    (error) => error.code === 'FORBIDDEN' && error.status === 403,
  );
  assert.equal((await manager.getState()).accounts[0].status, 'ok');

  backend.state.pollQueue.push({ status: 'EXPIRED' });
  const expired = await manager.startAuthorization();
  assert.deepEqual(await waitForResult(manager, expired.requestId), { status: 'expired' });
  backend.state.pollQueue.push({ code: 404, message: '授权请求不存在或已过期' });
  const gone = await manager.startAuthorization();
  assert.deepEqual(await waitForResult(manager, gone.requestId), { status: 'expired' });

  // HTTP 200 + 信封 401：授权失效。
  const unauthorized = await manager.withBackend((cfg) =>
    getMe(cfg, { fetchImpl: respond(200, { code: 401, message: '登录已过期', data: null }) }),
  );
  assert.equal(unauthorized.authRequired.reason, 'revoked');
  manager.dispose();
});

test('re-authorization whose config write fails puts the previous credential back and keeps the old token usable', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager, configPath } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);

  backend.state.pollQueue.push(approved(1));
  const started = await manager.startAuthorization();
  chmodSync(dirname(configPath), 0o500);
  let result;
  try {
    result = await waitForResult(manager, started.requestId);
  } finally {
    chmodSync(dirname(configPath), 0o700);
  }
  assert.equal(result.status, 'error');
  // 旧凭据放回去了，旧令牌没被吊销；新令牌被吊销。
  assert.equal(credentials.records.get('contract-sure/account-1').payload.token, 'plugin-jwt-1');
  assert.ok(backend.state.validTokens.has('plugin-jwt-1'));
  await waitUntil(() => !backend.state.validTokens.has('plugin-jwt-2'), '吊销新令牌');
  assert.deepEqual(await manager.withBackend(async (cfg) => cfg.apiToken), { ok: true, value: 'plugin-jwt-1' });
  manager.dispose();
});

test('polling keeps retrying through HTTP 5xx and network errors until approval, with backoff and only "pending" shown', async () => {
  const backend = createBackend();
  const delays = [];
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend, delays });
  await manager.saveSettings({ serverUrl: SERVER });

  // L1：轮询途中查部门时数据库出错 → HTTP 500 + code 500，请求仍是 APPROVED，重试就能拿到令牌。
  backend.state.pollQueue.push(
    { status: 'PENDING' },
    { httpStatus: 500 },
    { httpStatus: 500 },
    { httpStatus: 503 },
    { httpStatus: 500 },
    { httpStatus: 500 },
    { httpStatus: 500 },
    { httpStatus: 500 },
    { httpStatus: 500 },
    { status: 'WEIRD' },
    { status: 'PENDING' },
  );
  const started = await manager.startAuthorization();
  const seen = [];
  for (let i = 0; i < 1000; i++) {
    const result = await manager.pollAuthorization(started.requestId);
    seen.push(result);
    if (backend.state.pollQueue.length === 0) break;
    await sleep(1);
  }
  // 失败期间界面只看到 pending，没有 message。
  assert.ok(seen.every((result) => JSON.stringify(result) === '{"status":"pending"}'));

  // 然后是网络错误，再然后批准：照样连上。
  backend.state.throwOn = { path: '/auth/plugin-authorize/poll', error: new TypeError('fetch failed: ECONNRESET'), times: 3 };
  backend.state.pollQueue.push(approved(1));
  const result = await waitForResult(manager, started.requestId);
  assert.equal(result.status, 'approved');
  assert.equal(result.account.id, 'u1');

  // 间隔：起步 2 秒；连续失败（含无法识别的状态）时指数退避、最长 30 秒；收到 PENDING 后回到 2 秒。
  assert.deepEqual(delays, [
    2000, // 发起后第一次
    2000, // PENDING
    4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, // 8 次 5xx
    30000, // WEIRD
    2000, // PENDING
    4000, 8000, 16000, // 3 次网络错误，然后 APPROVED
  ]);
  manager.dispose();
});

test('a failing poll still ends as expired once the request expires locally; code 404 ends it immediately', async () => {
  const backend = createBackend();
  let clock = Date.now();
  const { manager } = createManager({ ctx: makeCtx({ credentials: memoryCredentials() }), backend, now: () => clock });
  await manager.saveSettings({ serverUrl: SERVER });

  backend.state.throwOn = { path: '/auth/plugin-authorize/poll', error: new TypeError('fetch failed') };
  const started = await manager.startAuthorization();
  await waitUntil(() => backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll').length >= 3, '失败的轮询');
  assert.deepEqual(await manager.pollAuthorization(started.requestId), { status: 'pending' });
  clock += 601_000;
  assert.deepEqual(await waitForResult(manager, started.requestId), { status: 'expired' });
  clock -= 601_000;
  // 过期后不再轮询。
  const polls = backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll').length;
  await sleep(20);
  assert.equal(backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll').length, polls);
  backend.state.throwOn = null;

  backend.state.pollQueue.push({ httpStatus: 500 }, { code: 404, message: '授权请求不存在或已过期' });
  const gone = await manager.startAuthorization();
  assert.deepEqual(await waitForResult(manager, gone.requestId), { status: 'expired' });
  manager.dispose();
});

test('HTTP 503 (database outage) for a plugin token is an ordinary error: the account is not marked revoked or expired', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  await connect(manager, backend, 1);

  backend.state.unavailable = true;
  await assert.rejects(
    () => manager.withBackend((cfg) => getMe(cfg, { fetchImpl: backend.fetchImpl })),
    (error) => error.code === 'SERVER_ERROR' && error.status === 503 && /暂时不可用/u.test(error.message),
  );
  const tested = await manager.testConnection();
  assert.equal(tested.ok, false);
  assert.match(tested.message, /^连接失败：履约系统暂时不可用（HTTP 503）/u);
  // HTTP 200 + 信封 503 也一样。
  await assert.rejects(
    () =>
      manager.withBackend((cfg) =>
        getMe(cfg, {
          fetchImpl: async () => new Response(JSON.stringify({ code: 503, message: '服务暂时不可用', data: null }), { status: 200 }),
        }),
      ),
    (error) => error.code === 'SERVER_ERROR' && error.businessCode === 503,
  );
  const state = await manager.getState();
  assert.equal(state.accounts[0].status, 'ok');
  assert.equal((await manager.describeConnection()).connected, true);

  // 数据库恢复后直接能用，不需要重新授权。
  backend.state.unavailable = false;
  assert.equal((await manager.testConnection()).ok, true);
  manager.dispose();
});

test('testConnection tests the address typed in the form, even before it is saved', async () => {
  const credentials = memoryCredentials();
  const backend = createBackend();
  const { manager, configPath } = createManager({ ctx: makeCtx({ credentials }), backend });
  await manager.saveSettings({ serverUrl: SERVER });
  const probes = () => backend.calls.filter((call) => call.path === '/auth/plugin-authorize/poll');
  const NOT_FOUND = { code: 404, message: '授权请求不存在或已过期' };

  // 还没有账户：测已保存的地址时只探测服务器，能连上就算通过。
  backend.state.pollQueue.push(NOT_FOUND);
  let tested = await manager.testConnection(SERVER);
  assert.deepEqual(tested, { ok: true, message: '可以连接这个履约系统，还没有连接账户：请点「连接账户」完成浏览器授权。' });

  await connect(manager, backend, 1);
  const configBefore = readFileSync(configPath, 'utf8');

  // 输入了还没保存的新地址：探测新地址，不带令牌，不改已保存的设置。
  backend.state.pollQueue.push(NOT_FOUND);
  tested = await manager.testConnection('http://new-lvyue.test:7003/api/v1/');
  assert.deepEqual(tested, { ok: true, message: '可以连接这个履约系统。保存设置后原来的账户会断开，再点「连接账户」重新授权。' });
  const probe = probes().at(-1);
  assert.equal(probe.origin, 'http://new-lvyue.test:7003');
  assert.equal(probe.auth, '');
  assert.equal(probe.redirect, 'error');
  assert.equal(readFileSync(configPath, 'utf8'), configBefore);

  // 旧版履约系统不认 A5，回 403。
  backend.state.pollQueue.push({ httpStatus: 403 });
  tested = await manager.testConnection('http://old-lvyue.test/api/v1');
  assert.equal(tested.ok, false);
  assert.equal(tested.message, `能连上服务器，但${NOT_UPGRADED_MESSAGE}。`);

  // 地址不是履约系统的 /api/v1（例如漏了 /api/v1，前端 nginx 回 405）。
  backend.state.pollQueue.push({ httpStatus: 405 });
  tested = await manager.testConnection('http://new-lvyue.test:7003');
  assert.equal(tested.ok, false);
  assert.match(tested.message, /不是履约系统的接口地址.*\/api\/v1/u);

  // 网络不通：只给固定文案。
  backend.state.throwOn = { path: '/auth/plugin-authorize/poll', error: new TypeError('fetch failed: ECONNREFUSED 10.0.0.9'), times: 1 };
  tested = await manager.testConnection('http://unreachable.test/api/v1');
  assert.equal(tested.ok, false);
  assert.match(tested.message, /^连接失败：无法连接履约系统/u);
  assert.doesNotMatch(tested.message, /ECONNREFUSED|10\.0\.0\.9/u);

  // 地址格式不对：不发请求。
  const before = backend.calls.length;
  tested = await manager.testConnection('ftp://lvyue.test/api/v1');
  assert.deepEqual(tested, { ok: false, message: '服务器地址仅支持 HTTP/HTTPS 协议。' });
  assert.equal(backend.calls.length, before);

  // 和已保存的地址相同（多了结尾斜杠也算相同）：用当前账户测。
  tested = await manager.testConnection(`${SERVER}/`);
  assert.equal(tested.ok, true);
  assert.equal(tested.account.userId, 1);
  assert.equal(backend.calls.at(-1).path, '/auth/me');
  manager.dispose();
});
