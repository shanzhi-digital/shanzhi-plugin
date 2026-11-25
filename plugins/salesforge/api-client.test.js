import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultApiClient, normalizeServerUrl, requestJson, safeErrorMessage } from './api-client.js';

const CFG = { serverUrl: 'http://sales.test/api/v1', apiToken: 'plugin-jwt-secret-1' };
const respond = (status, body, contentType = 'application/json') => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
  };
  return { fetchImpl, calls };
};

test('requestJson never follows redirects', async () => {
  const { fetchImpl, calls } = respond(200, { code: 200, data: { ok: true } });
  assert.deepEqual(await requestJson(CFG, '/auth/info', { fetchImpl }), { ok: true });
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer plugin-jwt-secret-1');

  // fetch 因重定向被拒时抛 TypeError：转成固定文案。
  const redirected = async () => {
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect to http://evil.example/steal?secret=1') });
  };
  await assert.rejects(
    () => requestJson(CFG, '/auth/info', { fetchImpl: redirected }),
    (error) => error.code === 'NETWORK_ERROR' && !/evil|secret|fetch failed/u.test(error.message),
  );
});

test('requests without a token are refused before anything is sent', async () => {
  const { fetchImpl, calls } = respond(200, { code: 200, data: {} });
  await assert.rejects(
    () => requestJson({ serverUrl: CFG.serverUrl }, '/customers', { fetchImpl }),
    (error) => error.code === 'TOKEN_MISSING' && /连接账户/u.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test('HTTP 401/403 are decided before the envelope; envelope 401/403 count only when HTTP succeeded', async () => {
  const cases = [
    [401, { code: 401, message: 'expired' }, 'UNAUTHORIZED'],
    [403, { code: 403, message: '暂无权限' }, 'FORBIDDEN'],
    // HTTP 403 但信封写 401：按 HTTP 403。
    [403, { code: 401, message: 'token invalid' }, 'FORBIDDEN'],
    // HTTP 401 但信封写 200：按 HTTP 401。
    [401, { code: 200, data: {} }, 'UNAUTHORIZED'],
    [200, { code: 401, message: '登录已过期' }, 'UNAUTHORIZED'],
    // 销售系统的 @PreAuthorize 拒绝是 HTTP 200 + code 403「暂无权限」。
    [200, { code: 403, message: '暂无权限' }, 'FORBIDDEN'],
  ];
  for (const [status, body, code] of cases) {
    const { fetchImpl } = respond(status, body);
    await assert.rejects(
      () => requestJson(CFG, '/customers', { fetchImpl }),
      (error) => error.code === code && error.status === status,
      `HTTP ${status} + ${JSON.stringify(body)}`,
    );
  }
  const { fetchImpl } = respond(401, {});
  await assert.rejects(() => requestJson(CFG, '/customers', { fetchImpl }), (error) => /设置 → 销售管理配置/u.test(error.message));
  const forbidden = respond(200, { code: 403, message: '暂无权限' });
  await assert.rejects(
    () => requestJson(CFG, '/customers', { fetchImpl: forbidden.fetchImpl }),
    (error) => error.message === '没有查看权限：当前账户不能查看这部分数据，请联系管理员检查账号角色或数据权限。',
  );
});

test('business and HTTP errors use fixed messages and string codes, never the backend text', async () => {
  const echo = 'Authorization: Bearer plugin-jwt-secret-1 pollSecret=abc';
  const cases = [
    [200, { code: 409, message: `客户名称 某某科技 已存在 ${echo}` }, 'CONFLICT', 409],
    [200, { code: 404, message: `授权请求不存在 ${echo}` }, 'NOT_FOUND', 404],
    [200, { code: 400, message: echo }, 'BAD_REQUEST', 400],
    [200, { code: 410, message: echo }, 'GONE', 410],
    [200, { code: 429, message: echo }, 'RATE_LIMITED', 429],
    [200, { code: 500, message: `NullPointerException ${echo}` }, 'SERVER_ERROR', 500],
    [200, { code: 418, message: echo }, 'BUSINESS_ERROR', 418],
    [200, { code: 'weird', message: echo }, 'BUSINESS_ERROR', undefined],
    [500, `<html>${echo}</html>`, 'SERVER_ERROR', undefined],
    [503, { code: 503, message: echo }, 'SERVER_ERROR', undefined],
    [404, { status: 404, path: echo }, 'HTTP_ERROR', undefined],
    [405, { message: echo }, 'HTTP_ERROR', undefined],
    [429, { message: echo }, 'RATE_LIMITED', undefined],
  ];
  for (const [status, body, code, businessCode] of cases) {
    const { fetchImpl } = respond(status, body, typeof body === 'string' ? 'text/html' : 'application/json');
    await assert.rejects(
      () => requestJson(CFG, '/customers', { fetchImpl }),
      (error) =>
        error.code === code &&
        error.businessCode === businessCode &&
        !/plugin-jwt|pollSecret|NullPointer|某某科技|<html>/u.test(error.message),
      `${status} ${JSON.stringify(body)}`,
    );
  }

  // HTTP 404 多半是地址没写到 /api/v1，或后端版本太旧。
  const notFound = respond(404, { status: 404 });
  await assert.rejects(
    () => requestJson(CFG, '/customers', { fetchImpl: notFound.fetchImpl }),
    (error) => error.status === 404 && /HTTP 404/u.test(error.message) && /\/api\/v1/u.test(error.message),
  );

  const { fetchImpl } = respond(200, 'not json at all secret', 'text/plain');
  await assert.rejects(() => requestJson(CFG, '/customers', { fetchImpl }), (error) => error.code === 'INVALID_JSON' && !/secret/u.test(error.message));

  // 底层异常里带出的请求头不回显；非 ApiError 的异常对外只给兜底文案。
  const thrower = async () => {
    throw new TypeError('Invalid header value: "Bearer plugin-jwt-secret-1"');
  };
  await assert.rejects(
    () => requestJson(CFG, '/customers', { fetchImpl: thrower }),
    (error) => error.code === 'NETWORK_ERROR' && !/plugin-jwt|Invalid header/u.test(error.message),
  );
  assert.equal(safeErrorMessage(new Error('raw secret text')), '未知错误');
});

test('timeouts and caller cancellation get their own codes', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  await assert.rejects(() => requestJson(CFG, '/customers', { fetchImpl: hang, timeoutMs: 20 }), (error) => error.code === 'TIMEOUT');
  const controller = new AbortController();
  const pending = requestJson(CFG, '/customers', { fetchImpl: hang, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'CANCELLED');
});

test('server URLs with a username or password are rejected without echoing the URL', () => {
  for (const url of ['http://admin:hunter2@sales.test/api/v1', 'https://admin@sales.test/api/v1', 'http://:hunter2@sales.test']) {
    assert.throws(() => normalizeServerUrl(url), (error) => error.code === 'INVALID_URL' && !/hunter2|admin/u.test(error.message));
  }
  assert.throws(() => normalizeServerUrl('not a url hunter2'), (error) => error.code === 'INVALID_URL' && !/hunter2/u.test(error.message));
  assert.throws(() => normalizeServerUrl('ftp://sales.test/api/v1'), (error) => error.code === 'INVALID_URL');
  assert.throws(() => normalizeServerUrl(''), (error) => error.code === 'CONFIG_MISSING');
  assert.equal(normalizeServerUrl(' https://sales.test/api/v1/ '), 'https://sales.test/api/v1');
});

test('read endpoints are GET with the expected paths; empty query values are dropped', async () => {
  const cases = [
    ['getAuthInfo', [], '/api/v1/auth/info', {}],
    ['listCustomers', [{ customerName: '华光', industry: '', salesId: 7, pageNum: 1, pageSize: 20 }], '/api/v1/customers', { customerName: '华光', salesId: '7', pageNum: '1', pageSize: '20' }],
    ['listChannels', [{ companyName: '渠道', startDate: '2026-01-01', endDate: null }], '/api/v1/channels', { companyName: '渠道', startDate: '2026-01-01' }],
    ['listProjects', [{ projectStatus: '商务招标', includeArchived: false, quarter: 4 }], '/api/v1/projects', { projectStatus: '商务招标', includeArchived: 'false', quarter: '4' }],
    ['getProjectSummary', [{ projectRisk: '必签项目' }], '/api/v1/projects/summary', { projectRisk: '必签项目' }],
    ['getHomeDashboard', [], '/api/v1/projects/dashboard/home', {}],
    ['getSalesDashboard', [{ period: 'quarter', scopeType: 'personal' }], '/api/v1/projects/dashboard/sales', { period: 'quarter', scopeType: 'personal' }],
    ['getOpportunityDashboard', [{ period: 'quarter' }], '/api/v1/projects/dashboard/opportunity', { period: 'quarter' }],
    ['getMarketDashboard', [{ period: 'year' }], '/api/v1/projects/dashboard/market', { period: 'year' }],
    ['listWorkReports', [{ targetType: 1, reporterId: 3 }], '/api/v1/work-reports', { targetType: '1', reporterId: '3' }],
    ['listWeeklyReports', [{ weekStartDate: '2026-11-23' }], '/api/v1/work-reports/weekly-reports/list', { weekStartDate: '2026-11-23' }],
    ['getWeeklyPlan', [{ weekStartDate: '2026-11-23' }], '/api/v1/work-reports/weekly-plans', { weekStartDate: '2026-11-23' }],
    ['getPersonalTargets', [{ year: 2026 }], '/api/v1/sales-targets/personal-completion', { year: '2026' }],
    ['getTeamTargets', [{ year: 2026 }], '/api/v1/sales-targets/team-completion', { year: '2026' }],
    ['searchAll', [{ keyword: '华光 科技' }], '/api/v1/search/all', { keyword: '华光 科技' }],
    ['listScopeUsers', [], '/api/v1/users/scope', {}],
  ];
  for (const [name, args, pathname, query] of cases) {
    const { fetchImpl, calls } = respond(200, { code: 200, data: { name } });
    assert.deepEqual(await defaultApiClient[name](CFG, ...args, { fetchImpl }), { name }, name);
    const url = new URL(calls[0].url);
    assert.equal(calls[0].init.method, 'GET', name);
    assert.equal(calls[0].init.body, undefined, name);
    assert.equal(url.pathname, pathname, name);
    assert.deepEqual(Object.fromEntries(url.searchParams), query, name);
  }
});

test('authorization endpoints are POST; only start goes out without a token', async () => {
  const start = respond(200, { code: 200, data: { requestId: 'r1' } });
  await defaultApiClient.startPluginAuthorization({ serverUrl: CFG.serverUrl }, { clientName: 'x' }, { fetchImpl: start.fetchImpl });
  assert.equal(new URL(start.calls[0].url).pathname, '/api/v1/auth/plugin-authorize/start');
  assert.equal(start.calls[0].init.method, 'POST');
  assert.equal(start.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(start.calls[0].init.body), { clientName: 'x' });

  const poll = respond(200, { code: 200, data: { status: 'pending' } });
  await defaultApiClient.pollPluginAuthorization({ serverUrl: CFG.serverUrl }, { requestId: 'r1', pollSecret: 'ps' }, { fetchImpl: poll.fetchImpl });
  assert.equal(new URL(poll.calls[0].url).pathname, '/api/v1/auth/plugin-authorize/poll');
  assert.equal(poll.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(poll.calls[0].init.body), { requestId: 'r1', pollSecret: 'ps' });
  // pollSecret 只在请求体里，不进 URL。
  assert.doesNotMatch(poll.calls[0].url, /ps|r1/u);

  const revoke = respond(200, { code: 200, data: null });
  await defaultApiClient.revokePluginToken(CFG, { fetchImpl: revoke.fetchImpl });
  assert.equal(new URL(revoke.calls[0].url).pathname, '/api/v1/auth/plugin-token/revoke');
  assert.equal(revoke.calls[0].init.method, 'POST');
  assert.equal(revoke.calls[0].init.headers.Authorization, 'Bearer plugin-jwt-secret-1');
});

test('createWorkReport posts the report as JSON with the plugin token; detail and contact reads use numeric id paths', async () => {
  const created = respond(200, { code: 200, data: 9001 });
  const report = { reportDate: '2026-11-26', targetType: 1, targetId: 1001, contactId: 31, workPlan: '下周报价', workSummary: '演示' };
  assert.equal(await defaultApiClient.createWorkReport(CFG, report, { fetchImpl: created.fetchImpl }), 9001);
  assert.equal(new URL(created.calls[0].url).pathname, '/api/v1/work-reports');
  assert.equal(created.calls[0].init.method, 'POST');
  assert.equal(created.calls[0].init.headers.Authorization, 'Bearer plugin-jwt-secret-1');
  assert.equal(created.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(created.calls[0].init.body), report);

  for (const [name, path] of [
    ['getCustomer', '/api/v1/customers/1001'],
    ['getChannel', '/api/v1/channels/1001'],
    ['listCustomerContacts', '/api/v1/customers/1001/contacts'],
    ['listChannelContacts', '/api/v1/channels/1001/contacts'],
  ]) {
    const read = respond(200, { code: 200, data: [] });
    await defaultApiClient[name](CFG, '1001.9', { fetchImpl: read.fetchImpl });
    assert.equal(new URL(read.calls[0].url).pathname, path, name);
    assert.equal(read.calls[0].init.method, 'GET', name);
  }
});

test('the default client writes only through the three authorization calls and createWorkReport', () => {
  const posts = ['startPluginAuthorization', 'pollPluginAuthorization', 'revokePluginToken', 'createWorkReport'];
  for (const name of Object.keys(defaultApiClient)) {
    assert.ok(posts.includes(name) || /^(get|list|search)/u.test(name), name);
  }
  assert.ok(Object.isFrozen(defaultApiClient));
});
