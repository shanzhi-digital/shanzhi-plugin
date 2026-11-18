import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAL_CREDENTIAL_REF, LEGACY_ENTRY_IDS, SERVICES, STAGING_CREDENTIAL_REF } from './constants.js';
import { legacyEntryIds, normalizeOrigin, probeConfig, readAccountOrigin, registrationEntry, writeBoundOrigin } from './endpoints.js';
import { asOnboardingError } from './errors.js';

test('从显式 origin 派生两个固定 MCP 地址、凭据模板与调用超时', () => {
  assert.equal(normalizeOrigin(' https://datahub.example.com/ '), 'https://datahub.example.com');
  const entries = SERVICES.map(service => registrationEntry('https://datahub.example.com', service));
  assert.deepEqual(entries.map(entry => entry.url), [
    'https://datahub.example.com/api/mcp/ask-data',
    'https://datahub.example.com/api/mcp/knowledge',
  ]);
  assert.deepEqual(entries.map(entry => entry.toolCallTimeoutMs), [180_000, 120_000]);
  for (const entry of entries) {
    assert.equal(entry.transport, 'streamable-http');
    assert.deepEqual(entry.headers, { 'X-API-Key': '${credential:XIAOZHI_DATAHUB_API_KEY}' });
    assert.equal(JSON.stringify(entry).includes('actual-secret'), false);
  }
  const probe = probeConfig('http://127.0.0.1:8080', SERVICES[0], STAGING_CREDENTIAL_REF);
  assert.equal(probe.serverName, 'datahub-ask-data');
  assert.equal(probe.expandTemplates, true);
  assert.equal(probe.headers['X-API-Key'], '${credential:XIAOZHI_DATAHUB_API_KEY_STAGING}');
});

test('空 origin 不产生地址，非 origin 输入被拒绝', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(normalizeOrigin(value), undefined);
  for (const value of ['file:///tmp/datahub', 'https://user:pass@example.com', 'https://example.com/api',
    'https://example.com?key=secret', 'https://example.com#private', 'not a url']) {
    assert.throws(() => normalizeOrigin(value), error => error.code === 'INVALID_ORIGIN');
    assert.throws(() => registrationEntry(value, SERVICES[0]), error => error.code === 'INVALID_ORIGIN');
  }
  assert.throws(() => registrationEntry(undefined, SERVICES[0]), error => error.code === 'ENVIRONMENT_REQUIRED');
});

test('环境读取只调用账号环境视图，不猜测旧 token、MCP URL 或 browserOrigin', () => {
  const account = {
    getXiaozhiEnvironment: () => ({ origin: 'https://explicit.example.com' }),
    get token() { throw new Error('不得读取 token'); },
    get browserOrigin() { throw new Error('不得读取 browserOrigin'); },
  };
  assert.equal(readAccountOrigin(account), 'https://explicit.example.com');
  assert.equal(readAccountOrigin({}), undefined);
  assert.equal(readAccountOrigin({ getXiaozhiEnvironment: () => ({}) }), undefined);
});

test('旧安装脚本仅按两个 configEditor 条目 id 精确识别', () => {
  const entries = [
    { options: { id: 'mcp-datahub-ask-data' } },
    { options: { id: 'mcp-datahub-knowledge' } },
    { options: { id: 'mcp-datahub-ask-data-copy' } },
    { options: { id: 'datahub-ask-data' } },
  ];
  assert.deepEqual(legacyEntryIds(entries), LEGACY_ENTRY_IDS);
  assert.deepEqual(legacyEntryIds([entries[2]]), []);
});

test('boundOrigin 通过 Settings.replace 保存和真正清除，而非稀疏 update no-op', async () => {
  const calls = [];
  const settings = { replace: async (...args) => calls.push(args), update: async () => { throw new Error('不应调用 update'); } };
  await writeBoundOrigin(settings, 'datahub-onboarding', 'https://one.example.com');
  await writeBoundOrigin(settings, 'datahub-onboarding', undefined);
  assert.deepEqual(calls, [
    ['datahub-onboarding', { boundOrigin: 'https://one.example.com' }],
    ['datahub-onboarding', {}],
  ]);
  await assert.rejects(() => writeBoundOrigin(undefined, 'datahub-onboarding', undefined), error => error.code === 'SETTINGS_UNAVAILABLE');
});

test('未知异常即使 code/message 形似秘密也只投影固定安全错误码', () => {
  const error = Object.assign(new Error('ACTUAL_SECRET_VALUE'), { code: 'ACTUAL_SECRET_VALUE' });
  const safe = asOnboardingError(error);
  assert.equal(safe.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(safe), /ACTUAL_SECRET_VALUE/);
});
