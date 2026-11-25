import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSalesforge, PERSON_UNRESOLVED_KIND } from './index.js';
import { createSalesforgeRemoteHandlers } from './remote-service.js';
import { ApiError } from './api-client.js';
import { projectEvents, AUTH_REQUIRED_KIND } from './event-projection.js';
import { normalizeTable } from '../datahub-echarts/results.js';
import { assertLossless, isLosslessJson } from './assert-lossless.js';

const workDir = mkdtempSync(join(tmpdir(), 'salesforge-tools-'));
const configPath = join(workDir, 'dsh-config.json');

// 固定「今天」：2026-11-26（周四），所在周的周一是 2026-11-23。取 UTC 正午，各时区都是同一天。
const FIXED_NOW = Date.parse('2026-11-26T12:00:00Z');
let clockOffsetMs = 0;

// ---------- 模拟销售后端（约定 S + 只读查询接口） ----------

const requests = [];
const validTokens = new Set();
let issuedTokenCount = 0;
let pollResponses = [];
// 某个路径固定返回的响应：{ [pathname]: { httpStatus, body } }，用来模拟 403/404/503 和业务错误。
let forced = {};
// 打开后 /projects 返回 620 条，用来测「最多扫描 500 条」。
let bigProjects = false;

// L1 过滤器对插件令牌拒绝的 GET 路径（前缀及其子路径，HTTP 403），/users/scope 和 /depts/tree 例外。
const FILTER_BLOCKED_PREFIXES = ['ai', 'dify', 'wechat', 'openclaw-wechat', 'openclaw', 'auth/plugin-authorize', 'auth/plugin-grants', 'auth/sso', 'users', 'roles', 'depts', 'configs', 'demo-environments', 'feedback', 'enterprise', 'address'];
const FILTER_ALLOWED = new Set(['/users/scope', '/depts/tree']);
const blockedForPluginToken = (path) =>
  !FILTER_ALLOWED.has(path) && FILTER_BLOCKED_PREFIXES.some((prefix) => path === `/${prefix}` || path.startsWith(`/${prefix}/`));

const pad = (n) => String(n).padStart(2, '0');
const CUSTOMERS = Array.from({ length: 230 }, (_, i) => ({
  id: 1000 + i,
  customerName: `客户${i + 1}`,
  industry: i % 2 ? '政府' : '教育',
  province: '四川省',
  city: '成都市',
  district: i % 3 ? '高新区' : null,
  salesId: 21,
  salesName: '张三',
  daysSinceLastFollow: (i * 7) % 90,
  createTime: `2026-${pad(1 + (i % 11))}-15T09:30:00`,
}));
const CHANNELS = [
  { id: 9, companyName: '华光渠道', province: '四川省', city: null, district: null, salesName: '李四', daysSinceLastFollow: 45, createTime: '2026-03-02T08:00:00' },
  { id: 10, companyName: '蓉城集成', province: '四川省', city: '成都市', district: '武侯区', salesName: '张三', daysSinceLastFollow: null, createTime: [2026, 5, 6, 10, 0] },
];
const project = (id, risk, signDate, amount, extra = {}) => ({
  id,
  projectName: `项目${id}`,
  customerId: 1001,
  customerName: '客户2',
  channelId: null,
  channelName: null,
  salesId: 21,
  salesName: '张三',
  product: '数据平台',
  projectStatus: '商务招标',
  projectRisk: risk,
  expectedSignDate: signDate,
  expectedAmount: amount,
  daysSinceLastFollow: id * 5,
  createTime: `2026-0${id}-01T10:00:00`,
  remark: null,
  ...extra,
});
const PROJECTS = [
  project(1, '必签项目', '2026-11-28', 300),
  project(2, '赢单风险', '2026-11-10', 80.5),
  project(3, '时间风险', '2026-12-20', 150),
  project(4, '赢单风险', '2026-11-30', 220.25, { channelId: 9, channelName: '华光渠道' }),
  project(5, null, null, null),
  project(6, '必签项目', '2026-11-01', 45),
];
const BIG_PROJECTS = Array.from({ length: 620 }, (_, i) => project(100 + i, '必签项目', '2026-11-15', 1));
const SCOPE_USERS = [
  { id: 7, username: 'wangjl', realName: '王经理', deptId: 3 },
  { id: 21, username: 'zhangsan', realName: '张三', deptId: 4 },
  { id: 22, username: 'zsf', realName: '张三丰', deptId: 4 },
  { id: 23, username: 'lisi', realName: '李四', deptId: 4 },
];

function paginate(all, query) {
  const pageNum = Number(query.pageNum || 1);
  const pageSize = Number(query.pageSize || 10);
  const records = all.slice((pageNum - 1) * pageSize, pageNum * pageSize);
  return { records, total: all.length, pageNum, pageSize, pages: Math.ceil(all.length / pageSize) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const auth = req.headers.authorization || '';
  const query = Object.fromEntries(url.searchParams);
  const path = url.pathname.replace(/^\/api\/v1/u, '');
  requests.push({ method: req.method, path, query, auth, bodyText: Buffer.concat(chunks).toString('utf8') });

  const sendJson = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  const ok = (data) => sendJson(200, { code: 200, message: 'success', data, timestamp: 1 });

  // 约定 S：S1 发起授权、S5 轮询、S8 吊销。
  if (req.method === 'POST' && path === '/auth/plugin-authorize/start') {
    const requestId = `req-${requests.length}-abcdefghijklmnopqrstuvwx`;
    return ok({
      requestId,
      userCode: 'WXYZ-2345',
      pollSecret: `poll-${requestId}-0123456789abcdefghijklmnopqrstuvwxyz`,
      verifyPath: `/plugin-authorize?req=${requestId}`,
      verifyUrl: null,
      interval: 2,
      expiresIn: 600,
    });
  }
  if (req.method === 'POST' && path === '/auth/plugin-authorize/poll') {
    const next = pollResponses.shift() || { status: 'PENDING' };
    if (next.status !== 'APPROVED') return ok(next);
    const token = `plugin-jwt-${++issuedTokenCount}`;
    validTokens.add(token);
    return ok({ ...next, token });
  }

  // 插件令牌只认 Authorization 头：放在 ?token= 里一律 401。
  if (url.searchParams.has('token')) return sendJson(401, { code: 401, message: '登录已过期，请重新登录', data: null });
  const bearer = auth.replace(/^Bearer /u, '');
  if (!validTokens.has(bearer)) return sendJson(401, { code: 401, message: '登录已过期，请重新登录', data: null });
  if (req.method === 'POST' && path === '/auth/plugin-token/revoke') {
    validTokens.delete(bearer);
    return ok(null);
  }
  // 插件令牌只读：除了 S8，其他 POST/PUT/DELETE 一律 HTTP 403。
  if (req.method !== 'GET') return sendJson(403, { code: 403, message: '无操作权限', data: null });
  if (blockedForPluginToken(path)) return sendJson(403, { code: 403, message: '无操作权限', data: null });
  if (forced[path]) return sendJson(forced[path].httpStatus, forced[path].body);

  switch (path) {
    case '/auth/info':
      return ok({
        userId: 7,
        username: 'wangjl',
        realName: '王经理',
        phone: '13900000000',
        deptId: 3,
        deptName: '销售一部',
        roleName: '销售经理',
        postType: 2,
        permissions: ['customer:view', 'project:view'],
      });
    case '/users/scope':
      return ok(SCOPE_USERS);
    case '/search/all':
      return ok([
        { type: 1, id: 1001, name: '华光科技', industry: '企业' },
        { type: 2, id: 9, name: '华光渠道', industry: null },
      ]);
    case '/customers':
      return ok(paginate(CUSTOMERS, query));
    case '/channels':
      return ok(paginate(CHANNELS, query));
    case '/projects':
      return ok(paginate(bigProjects ? BIG_PROJECTS : PROJECTS, query));
    case '/projects/summary':
      return ok({ projectCount: 6, totalAmount: 795.75, mustSignAmount: 345, riskAmount: 450.75 });
    case '/projects/dashboard/home':
      return ok({
        monthSalesAmount: 120.5,
        monthOrderCount: 3,
        monthNewCustomerCount: 4,
        monthNewChannelCount: 1,
        monthTargetAmount: 1000,
        monthCompletionRate: 12.05,
        dailyTrend: [
          { date: '2026-11-01', amount: 20, count: 1 },
          { date: '2026-11-02', amount: 0, count: 0 },
        ],
      });
    case '/projects/dashboard/sales':
      return ok({
        annualTarget: 1200,
        quarterTarget: 300,
        completedAmount: 180,
        completionRate: 60,
        ...(query.scopeType === 'team'
          ? {
              teamTargets: [
                { deptName: '销售一部', annualTarget: 800, completedAmount: 500, completionRate: 62.5 },
                { deptName: '销售二部', annualTarget: 400, completedAmount: null, completionRate: null },
              ],
            }
          : {}),
      });
    case '/projects/dashboard/opportunity':
      return ok({ totalAmount: 795.75, mustSignAmount: 345, timeRiskAmount: 150, winRiskAmount: 300.75 });
    case '/projects/dashboard/market':
      return ok({ newProjectCount: 6, newProjectAmount: 795.75 });
    case '/work-reports':
      return ok(
        paginate(
          [
            {
              id: 501,
              reportDate: '2026-11-24',
              reporterId: 21,
              realName: '张三',
              targetType: 1,
              targetId: 1001,
              targetName: '客户2',
              contactName: '刘老师',
              workPlan: '演示平台',
              workSummary: '客户认可方案',
            },
            { id: 502, reportDate: '2026-11-25', reporterId: 21, realName: '张三', targetType: 2, targetId: 9, targetName: '华光渠道', contactName: null, workPlan: null, workSummary: '沟通合作' },
          ],
          query,
        ),
      );
    case '/work-reports/weekly-reports/list':
      return ok(
        paginate(
          [
            {
              reporterId: 21,
              reporterName: '张三',
              weekStartDate: '2026-11-23',
              weekEndDate: '2026-11-29',
              planItems: ['拜访客户2', '准备投标'],
              workSummary: '推进项目1',
              supplement: null,
              status: 'SUBMITTED',
              updateTime: '2026-11-26T18:20:00',
            },
          ],
          query,
        ),
      );
    case '/work-reports/weekly-plans':
      return ok({ reporterId: 7, reporterName: '王经理', weekStartDate: '2026-11-23', weekEndDate: '2026-11-29', planItems: ['周一例会', '拜访客户'] });
    case '/sales-targets/personal-completion':
      return ok({ annualTarget: 1200, q1Amount: 300, q2Amount: 300, q3Amount: 300, q4Amount: null });
    case '/sales-targets/team-completion':
      return ok([{ deptName: '销售一部', annualTarget: 800, completedAmount: 500, completionRate: 62.5 }]);
    default:
      return sendJson(404, { code: 404, message: `Not found: ${path}`, data: null });
  }
});

let baseUrl;
let registeredTools;
let promptSections;
let hostCredentials;
let pluginInstance;
const toolsWithLosslessOutput = new Set();

function memoryCredentials() {
  const records = new Map();
  return {
    records,
    async readRecord(key) {
      return records.has(key) ? structuredClone(records.get(key)) : undefined;
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next === undefined) return records.get(key);
      records.set(key, structuredClone(next));
      return next;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
  };
}

// 调用工具，并断言输出能通过宿主的无损 JSON 校验。
async function runTool(name, args = {}, exec = {}) {
  const output = await registeredTools.get(name).execute(args, exec);
  assertLossless(output, `${name} 的输出`);
  toolsWithLosslessOutput.add(name);
  return output;
}

// 工具参数不合格时抛 INVALID_ARGUMENT，文案要说清楚哪个参数。
async function rejectsArg(name, args, pattern) {
  await assert.rejects(
    () => registeredTools.get(name).execute(args, {}),
    (error) => error.code === 'INVALID_ARGUMENT' && pattern.test(error.message),
    `${name} ${JSON.stringify(args)}`,
  );
}

const requestsTo = (path) => requests.filter((r) => r.path === path);
const lastRequest = (path) => requestsTo(path).at(-1);

async function waitForAuthorization(remote, requestId) {
  for (let i = 0; i < 500; i++) {
    const result = await remote.pollAuthorization(requestId);
    if (result.status !== 'pending') return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('授权结果一直是 pending');
}

const MANAGER_APPROVAL = {
  status: 'APPROVED',
  grantId: 501,
  expiresAt: '2099-02-22T10:00:00+08:00',
  user: { userId: 7, username: 'wangjl', realName: '王经理', deptName: '销售一部' },
};

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  registeredTools = new Map();
  promptSections = [];
  hostCredentials = memoryCredentials();

  const ctx = {
    tools: { register(def) { registeredTools.set(def.name, def); } },
    systemPrompt: { section(sec) { promptSections.push(sec); return () => {}; } },
    credentials: hostCredentials,
    get(svc) { return this[svc]; },
    effect() {},
  };
  pluginInstance = setupSalesforge(ctx, {
    configPath,
    hostname: () => 'test-host',
    now: () => FIXED_NOW + clockOffsetMs,
    schedule: (fn) => setTimeout(fn, 2),
    cancelSchedule: (handle) => clearTimeout(handle),
  });
  await pluginInstance.remoteHandlers.saveSettings({ serverUrl: baseUrl });
});

test.after(async () => {
  pluginInstance?.dispose();
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

test('registers all 8 tools and systemPrompt section plugin:salesforge (order 941)', () => {
  assert.deepEqual(
    [...registeredTools.keys()].sort(),
    [
      'sales_config',
      'sales_dashboard',
      'sales_query_channels',
      'sales_query_customers',
      'sales_query_projects',
      'sales_query_work_reports',
      'sales_search',
      'sales_targets',
    ],
  );
  assert.equal(promptSections.length, 1);
  assert.equal(promptSections[0].name, 'plugin:salesforge');
  assert.equal(promptSections[0].order, 941);
  const prompt = promptSections[0].text;
  for (const pattern of [/万元/u, /includeArchived/u, /salesforge-person-unresolved/u, /salesforge-auth-required/u, /query_result_chart/u, /不要自己用 curl/u, /设置 → 销售管理配置/u]) {
    assert.match(prompt, pattern);
  }
  for (const toolName of registeredTools.keys()) assert.match(prompt, new RegExp(toolName, 'u'));
  // 不引导用户提供账号密码。
  assert.doesNotMatch(prompt, /提供.{0,6}密码|password/u);

  const configTool = registeredTools.get('sales_config');
  assert.deepEqual(Object.keys(configTool.parameters.properties), ['action']);
  assert.deepEqual(configTool.parameters.properties.action.enum, ['get', 'profile']);
  for (const def of registeredTools.values()) {
    assert.equal(def.parameters.additionalProperties, false, def.name);
    assert.doesNotMatch(JSON.stringify(def.parameters), /password|apiToken|token/iu, def.name);
    assert.equal(typeof def.description, 'string');
    assert.deepEqual(def.output.schema, { type: 'object', additionalProperties: true });
  }
  // 看板只看自己或自己的团队：不接受 salesId。
  assert.deepEqual(Object.keys(registeredTools.get('sales_dashboard').parameters.properties), ['view', 'period', 'scopeType']);
});

test('without an account every backend tool returns the auth-required output and nothing is sent', async () => {
  const expected = {
    kind: AUTH_REQUIRED_KIND,
    reason: 'no-account',
    serverUrl: baseUrl,
    message: '需要先连接销售管理系统账户：请点下方卡片的「连接账户」，在浏览器里完成授权后，回复「继续」。',
  };
  const before = requests.length;
  const calls = [
    ['sales_config', { action: 'profile' }],
    ['sales_search', { keyword: '华光' }],
    ['sales_search', { target: 'people' }],
    ['sales_query_customers', {}],
    ['sales_query_channels', { minDaysSinceFollow: 30 }],
    ['sales_query_projects', {}],
    ['sales_query_projects', { mode: 'summary' }],
    ['sales_dashboard', { view: 'sales' }],
    ['sales_query_work_reports', { reporterName: '张三' }],
    ['sales_targets', {}],
  ];
  for (const [name, args] of calls) assert.deepEqual(await runTool(name, args), expected, name);
  assert.equal(requests.length, before);

  assert.deepEqual(await runTool('sales_config', {}), {
    action: 'get',
    serverUrl: baseUrl,
    connected: false,
    account: null,
    accountCount: 0,
    message: '尚未连接销售管理系统账户，请在「设置 → 销售管理配置」点「连接账户」完成浏览器授权。',
  });
  await rejectsArg('sales_config', { action: 'set' }, /action 只能是 get、profile 之一/u);
  await rejectsArg('sales_config', { serverUrl: 'http://x' }, /不认识参数 serverUrl/u);
});

test('browser authorization through the salesforge RPC handlers connects the account', async () => {
  const remote = pluginInstance.remoteHandlers;
  pollResponses = [{ status: 'PENDING' }, MANAGER_APPROVAL];
  const started = await remote.startAuthorization();
  assert.equal(started.userCode, 'WXYZ-2345');
  assert.equal(started.verifyUrl, `${new URL(baseUrl).origin}/plugin-authorize?req=${started.requestId}`);
  const startReq = lastRequest('/auth/plugin-authorize/start');
  assert.deepEqual(JSON.parse(startReq.bodyText), { clientName: 'DeepSeek Harness · 销售管理', deviceName: 'test-host' });
  assert.equal(startReq.auth, '');

  const result = await waitForAuthorization(remote, started.requestId);
  assert.equal(result.status, 'approved');
  assert.equal(result.account.id, 'u7');
  assert.equal(result.state.activeAccountId, 'u7');
  assert.equal(hostCredentials.records.get('salesforge/account-7').payload.token, 'plugin-jwt-1');
  assert.ok(requestsTo('/auth/plugin-authorize/poll').every((r) => r.auth === ''));

  const state = await remote.getState();
  assert.deepEqual(Object.keys(state).sort(), ['accounts', 'activeAccountId', 'credentialStore', 'serverUrl']);
  assert.equal(state.credentialStore, 'dsh-credentials');
  for (const text of [JSON.stringify(state), readFileSync(configPath, 'utf8')]) {
    assert.ok(!text.includes('plugin-jwt-1'));
    assert.ok(!text.includes('poll-'));
  }

  const tested = await remote.testConnection(null, undefined);
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.account, { userId: 7, username: 'wangjl', realName: '王经理', deptName: '销售一部' });
  assert.equal(lastRequest('/auth/info').auth, 'Bearer plugin-jwt-1');

  const config = await runTool('sales_config', {});
  assert.equal(config.connected, true);
  assert.deepEqual(config.account, { realName: '王经理', username: 'wangjl', status: 'ok' });
  assert.equal(config.message, '已连接销售管理系统账户：王经理（wangjl）。');
});

test('sales_config profile shows role and permissions but never the phone number or token', async () => {
  const profile = await runTool('sales_config', { action: 'profile' });
  assert.deepEqual(profile, {
    action: 'profile',
    userId: 7,
    username: 'wangjl',
    realName: '王经理',
    deptId: 3,
    deptName: '销售一部',
    roleName: '销售经理',
    postType: 2,
    postTypeLabel: '销售',
    dataScope: '销售：能看自己负责的数据，加上下级部门的数据。',
    permissions: ['customer:view', 'project:view'],
  });
  assert.doesNotMatch(JSON.stringify(profile), /13900000000|plugin-jwt/u);
  assert.deepEqual(lastRequest('/auth/info').query, {});
});

test('sales_search finds customers and channels by keyword, and lists the people in scope', async () => {
  const found = await runTool('sales_search', { keyword: ' 华光 ' });
  assert.deepEqual(lastRequest('/search/all').query, { keyword: '华光' });
  assert.deepEqual(found.columns, ['类型', 'ID', '名称', '行业']);
  assert.deepEqual(found.rows, [
    { 类型: '客户', ID: 1001, 名称: '华光科技', 行业: '企业' },
    { 类型: '渠道', ID: 9, 名称: '华光渠道', 行业: '' },
  ]);
  assert.equal(normalizeTable(found).data.length, 2);
  await rejectsArg('sales_search', {}, /需要 keyword/u);
  await rejectsArg('sales_search', { keyword: 'x'.repeat(101) }, /keyword 太长了/u);
  await rejectsArg('sales_search', { target: 'projects', keyword: 'x' }, /target 只能是/u);

  const people = await runTool('sales_search', { target: 'people', keyword: '张' });
  assert.deepEqual(people.rows, [
    { 人员ID: 21, 姓名: '张三', 用户名: 'zhangsan', 部门ID: 4 },
    { 人员ID: 22, 姓名: '张三丰', 用户名: 'zsf', 部门ID: 4 },
  ]);
  assert.equal(people.total, 2);
  assert.equal(people.truncated, false);
  const everyone = await runTool('sales_search', { target: 'people' });
  assert.equal(everyone.total, SCOPE_USERS.length);
});

test('sales_query_customers passes filters as query params and returns one page', async () => {
  const page = await runTool('sales_query_customers', {
    customerName: '客户',
    industry: '政府',
    createdFrom: '2026-01-01',
    createdTo: '2026-11-30',
    pageNum: 2,
    pageSize: 50,
  });
  assert.deepEqual(lastRequest('/customers').query, {
    customerName: '客户',
    industry: '政府',
    startDate: '2026-01-01',
    endDate: '2026-11-30',
    pageNum: '2',
    pageSize: '50',
  });
  assert.deepEqual(page.query, { customerName: '客户', industry: '政府', startDate: '2026-01-01', endDate: '2026-11-30' });
  assert.equal(page.total, 230);
  assert.equal(page.pageNum, 2);
  assert.equal(page.pages, 5);
  assert.equal(page.hasMore, true);
  assert.equal(page.rowCount, 50);
  assert.deepEqual(page.columns, ['客户ID', '客户名称', '行业', '所在地区', '负责销售', '距上次跟进天数', '新增时间']);
  assert.deepEqual(page.rows[0], {
    客户ID: 1050,
    客户名称: '客户51',
    行业: '教育',
    所在地区: '四川省 成都市 高新区',
    负责销售: '张三',
    距上次跟进天数: (50 * 7) % 90,
    新增时间: '2026-07-15',
  });
  // 区（district）为空时地区不留空格。
  assert.equal(page.rows[1].所在地区, '四川省 成都市');
  assert.equal(normalizeTable(page).data.length, 50);

  // 默认第一页、每页 20 条。
  await runTool('sales_query_customers', {});
  assert.deepEqual(lastRequest('/customers').query, { pageNum: '1', pageSize: '20' });

  await rejectsArg('sales_query_customers', { keyword: '客户' }, /sales_query_customers 不认识参数 keyword。可用参数：customerName/u);
  await rejectsArg('sales_query_customers', { createdFrom: '2026-02-30' }, /createdFrom 必须是 YYYY-MM-DD/u);
  await rejectsArg('sales_query_customers', { createdFrom: '2026-11-02', createdTo: '2026-11-01' }, /createdFrom 不能晚于 createdTo/u);
  await rejectsArg('sales_query_customers', { pageSize: 101 }, /pageSize 必须是 1 到 100 之间的整数/u);
  await rejectsArg('sales_query_customers', { salesId: 0 }, /salesId 必须是/u);
  await rejectsArg('sales_query_customers', { customerName: 12 }, /customerName 必须是字符串/u);
  await rejectsArg('sales_query_customers', { sortBy: 'amount' }, /sortBy 只能是 createTime、daysSinceLastFollow 之一/u);
});

test('sales_query_customers with minDaysSinceFollow scans up to 500 records and filters and sorts locally', async () => {
  const before = requestsTo('/customers').length;
  const result = await runTool('sales_query_customers', { minDaysSinceFollow: 30, pageSize: 10 });
  const scans = requestsTo('/customers').slice(before);
  assert.deepEqual(scans.map((r) => [r.query.pageNum, r.query.pageSize]), [['1', '100'], ['2', '100'], ['3', '100']]);
  const expected = CUSTOMERS.filter((c) => c.daysSinceLastFollow >= 30);
  assert.deepEqual(result.localFilter, { minDaysSinceFollow: 30, sortBy: 'daysSinceLastFollow', scanned: 230, scanTruncated: false, matched: expected.length });
  assert.equal(result.total, 230);
  assert.equal(result.rowCount, 10);
  assert.equal(result.truncated, true);
  const days = result.rows.map((row) => row.距上次跟进天数);
  assert.ok(days.every((d) => d >= 30));
  assert.deepEqual(days, [...days].sort((a, b) => b - a));
  assert.equal(days[0], Math.max(...expected.map((c) => c.daysSinceLastFollow)));
  assert.equal(result.note, undefined);

  // sortBy=createTime：保持后端的新增时间顺序，只做筛选。
  const keepOrder = await runTool('sales_query_customers', { minDaysSinceFollow: 30, sortBy: 'createTime', pageSize: 3 });
  assert.equal(keepOrder.localFilter.sortBy, 'createTime');
  assert.deepEqual(keepOrder.rows.map((row) => row.客户ID), expected.slice(0, 3).map((c) => c.id));

  await rejectsArg('sales_query_customers', { minDaysSinceFollow: 30, pageNum: 2 }, /请去掉 pageNum/u);
  await rejectsArg('sales_query_customers', { minDaysSinceFollow: -1 }, /minDaysSinceFollow 必须是/u);
});

test('person filters are checked against /users/scope before any list request', async () => {
  // 精确匹配姓名：只有一位「张三」（「张三丰」不算）。
  await runTool('sales_query_customers', { salesName: '张三' });
  assert.deepEqual(lastRequest('/customers').query, { salesId: '21', pageNum: '1', pageSize: '20' });
  const byUsername = await runTool('sales_query_customers', { salesName: 'LISI' });
  assert.equal(byUsername.query.salesId, 23);
  assert.equal(byUsername.query.salesName, '李四');
  assert.equal((await runTool('sales_query_customers', { salesId: 22 })).query.salesName, '张三丰');

  const listCalls = () => requestsTo('/customers').length + requestsTo('/projects').length + requestsTo('/work-reports').length;
  const before = listCalls();
  const ambiguous = await runTool('sales_query_customers', { salesName: '张' });
  assert.equal(ambiguous.kind, PERSON_UNRESOLVED_KIND);
  assert.equal(ambiguous.field, 'salesName');
  assert.equal(ambiguous.query, '张');
  assert.deepEqual(ambiguous.candidates.map((c) => c.userId), [21, 22]);
  assert.match(ambiguous.message, /2 位.*salesId/u);

  const nobody = await runTool('sales_query_projects', { salesName: '赵六' });
  assert.equal(nobody.kind, PERSON_UNRESOLVED_KIND);
  assert.deepEqual(nobody.candidates, []);
  assert.match(nobody.message, /没有找到「赵六」/u);

  // 不在可见范围内的人员 ID：不查询（日报列表带 reporterId 时后端不再按数据范围过滤）。
  const outOfScope = await runTool('sales_query_work_reports', { reporterId: 999 });
  assert.equal(outOfScope.kind, PERSON_UNRESOLVED_KIND);
  assert.equal(outOfScope.field, 'reporterId');
  assert.match(outOfScope.message, /不在你能查看的范围内/u);
  assert.equal(listCalls(), before);
});

test('sales_query_channels maps companyName and shows channels', async () => {
  const result = await runTool('sales_query_channels', { companyName: '华光', salesName: '李四' });
  assert.deepEqual(lastRequest('/channels').query, { companyName: '华光', salesId: '23', pageNum: '1', pageSize: '20' });
  assert.deepEqual(result.columns, ['渠道ID', '渠道名称', '所在地区', '负责销售', '距上次跟进天数', '新增时间']);
  assert.deepEqual(result.rows, [
    { 渠道ID: 9, 渠道名称: '华光渠道', 所在地区: '四川省', 负责销售: '李四', 距上次跟进天数: 45, 新增时间: '2026-03-02' },
    { 渠道ID: 10, 渠道名称: '蓉城集成', 所在地区: '四川省 成都市 武侯区', 负责销售: '张三', 距上次跟进天数: null, 新增时间: '2026-05-06' },
  ]);
  await rejectsArg('sales_query_channels', { industry: '政府' }, /不认识参数 industry/u);
});

test('sales_query_projects lists and sums projects; signed or lost projects need includeArchived', async () => {
  const list = await runTool('sales_query_projects', { projectRisk: '赢单风险', quarter: 4, minAmount: 50, maxAmount: 500, customerId: 1001, pageSize: 5 });
  assert.deepEqual(lastRequest('/projects').query, {
    projectRisk: '赢单风险',
    quarter: '4',
    minAmount: '50',
    maxAmount: '500',
    customerId: '1001',
    pageNum: '1',
    pageSize: '5',
  });
  assert.equal(list.mode, 'list');
  assert.equal(list.unit, '万元');
  assert.equal(list.total, 6);
  assert.equal(list.hasMore, true);
  assert.deepEqual(list.columns, ['项目ID', '项目名称', '客户', '渠道', '负责销售', '产品', '项目阶段', '项目风险', '预计签约日期', '预计金额（万元）', '距上次跟进天数', '新增时间', '备注']);
  assert.deepEqual(list.rows[3], {
    项目ID: 4,
    项目名称: '项目4',
    客户: '客户2',
    渠道: '华光渠道',
    负责销售: '张三',
    产品: '数据平台',
    项目阶段: '商务招标',
    项目风险: '赢单风险',
    预计签约日期: '2026-11-30',
    '预计金额（万元）': 220.25,
    距上次跟进天数: 20,
    新增时间: '2026-04-01',
    备注: '',
  });
  // 空字段（风险、日期、金额）是空串或 null，不是 undefined。
  assert.deepEqual([list.rows[4].项目风险, list.rows[4].预计签约日期, list.rows[4]['预计金额（万元）']], ['', '', null]);
  assert.equal(normalizeTable(list).data.length, 5);

  // 查已签约：自动带上 includeArchived=true；显式 false 时照传。
  await runTool('sales_query_projects', { projectStatus: '项目签约' });
  assert.equal(lastRequest('/projects').query.includeArchived, 'true');
  await runTool('sales_query_projects', { projectStatus: '项目丢单', includeArchived: false });
  assert.equal(lastRequest('/projects').query.includeArchived, 'false');
  await runTool('sales_query_projects', { projectStatus: '商务招标' });
  assert.equal(lastRequest('/projects').query.includeArchived, undefined);

  const summary = await runTool('sales_query_projects', { mode: 'summary', salesName: '张三', includeArchived: true, createdFrom: '2026-01-01' });
  assert.deepEqual(lastRequest('/projects/summary').query, { salesId: '21', includeArchived: 'true', startDate: '2026-01-01' });
  assert.deepEqual(summary, {
    mode: 'summary',
    query: { includeArchived: true, startDate: '2026-01-01', salesId: 21, salesName: '张三' },
    unit: '万元',
    summary: { 项目数: 6, '预计总金额（万元）': 795.75, '必签项目金额（万元）': 345, '有风险项目金额（万元）': 450.75 },
  });

  await rejectsArg('sales_query_projects', { mode: 'summary', pageNum: 2 }, /pageNum 只能在 mode="list" 时使用/u);
  await rejectsArg('sales_query_projects', { mode: 'summary', customerId: 1 }, /customerId 只能在 mode="list" 时使用/u);
  await rejectsArg('sales_query_projects', { projectStatus: '已签约' }, /projectStatus 只能是 发现问题、/u);
  await rejectsArg('sales_query_projects', { projectRisk: '高风险' }, /projectRisk 只能是 必签项目、时间风险、赢单风险 之一/u);
  await rejectsArg('sales_query_projects', { minAmount: 500, maxAmount: 50 }, /minAmount 不能大于 maxAmount/u);
  await rejectsArg('sales_query_projects', { minAmount: -1 }, /单位：万元/u);
  await rejectsArg('sales_query_projects', { quarter: 5 }, /quarter 必须是 1 到 4/u);
  await rejectsArg('sales_query_projects', { includeArchived: 'yes' }, /includeArchived 必须是 true 或 false/u);
});

test('sales_query_projects filters by expected sign date and sorts by amount locally, with a matched subtotal', async () => {
  const before = requestsTo('/projects').length;
  const result = await runTool('sales_query_projects', { expectedSignFrom: '2026-11-01', expectedSignTo: '2026-11-30', sortBy: 'expectedAmount' });
  const scans = requestsTo('/projects').slice(before);
  assert.deepEqual(scans.map((r) => r.query), [{ pageNum: '1', pageSize: '100' }]);
  assert.deepEqual(result.rows.map((row) => row.项目ID), [1, 4, 2, 6]);
  assert.deepEqual(result.localFilter, {
    expectedSignFrom: '2026-11-01',
    expectedSignTo: '2026-11-30',
    sortBy: 'expectedAmount',
    sortOrder: 'desc',
    scanned: 6,
    scanTruncated: false,
    matched: 4,
  });
  assert.deepEqual(result.matchedSummary, {
    项目数: 4,
    '预计总金额（万元）': 645.75,
    '按风险分（万元）': { 必签项目: 345, 时间风险: 0, 赢单风险: 300.75 },
  });

  // 升序：没有金额的排在最后。
  const asc = await runTool('sales_query_projects', { sortBy: 'expectedAmount', sortOrder: 'asc' });
  assert.deepEqual(asc.rows.map((row) => row.项目ID), [6, 2, 3, 4, 1, 5]);
  // 只给跟进天数：默认按跟进天数从多到少。
  const stale = await runTool('sales_query_projects', { minDaysSinceFollow: 20 });
  assert.deepEqual(stale.rows.map((row) => row.项目ID), [6, 5, 4]);
  assert.equal(stale.localFilter.sortBy, 'daysSinceLastFollow');

  // 超过 500 条：只扫前 500 条，并提示缩小范围。
  bigProjects = true;
  try {
    const start = requestsTo('/projects').length;
    const big = await runTool('sales_query_projects', { sortBy: 'expectedSignDate' });
    assert.deepEqual(requestsTo('/projects').slice(start).map((r) => r.query.pageNum), ['1', '2', '3', '4', '5']);
    assert.equal(big.localFilter.scanned, 500);
    assert.equal(big.localFilter.scanTruncated, true);
    assert.equal(big.total, 620);
    assert.equal(big.rowCount, 20);
    assert.match(big.note, /共 620 条，只扫描了前 500 条/u);
  } finally {
    bigProjects = false;
  }
  await rejectsArg('sales_query_projects', { sortBy: 'expectedAmount', pageNum: 2 }, /请去掉 pageNum/u);
  await rejectsArg('sales_query_projects', { expectedSignFrom: '2026-12-01', expectedSignTo: '2026-11-01' }, /expectedSignFrom 不能晚于 expectedSignTo/u);
});

test('sales_dashboard reads the four dashboards; the sales view never sends a salesId', async () => {
  const home = await runTool('sales_dashboard', { view: 'home' });
  assert.deepEqual(lastRequest('/projects/dashboard/home').query, {});
  assert.deepEqual(home.summary, {
    '本月签约金额（万元）': 120.5,
    本月签约项目数: 3,
    本月新增客户数: 4,
    本月新增渠道数: 1,
    '年度目标（万元）': 1000,
    '本月签约占年度目标（%）': 12.05,
  });
  assert.deepEqual(home.rows, [
    { 日期: '2026-11-01', '签约金额（万元）': 20, 签约项目数: 1 },
    { 日期: '2026-11-02', '签约金额（万元）': 0, 签约项目数: 0 },
  ]);
  await rejectsArg('sales_dashboard', { view: 'home', period: 'year' }, /period 不适用于 view="home"/u);

  const year = await runTool('sales_dashboard', { view: 'sales' });
  assert.deepEqual(lastRequest('/projects/dashboard/sales').query, { period: 'year', scopeType: 'personal' });
  assert.deepEqual(year.summary, {
    '年度目标（万元）': 1200,
    '本季度目标（万元）': 300,
    '本年目标（万元）': 1200,
    '本年已完成（万元）': 180,
    '完成率（%）': 60,
    '还差（万元）': 1020,
  });
  assert.equal(year.rows, undefined);
  const quarter = await runTool('sales_dashboard', { view: 'sales', period: 'quarter' });
  assert.equal(quarter.summary['本季度目标（万元）'], 300);
  assert.equal(quarter.summary['还差（万元）'], 120);
  // 本月目标 = 年度目标 / 12；超额完成时还差 0。
  const month = await runTool('sales_dashboard', { view: 'sales', period: 'month' });
  assert.equal(month.summary['本月目标（万元）'], 100);
  assert.equal(month.summary['还差（万元）'], 0);

  const team = await runTool('sales_dashboard', { view: 'sales', scopeType: 'team' });
  assert.deepEqual(lastRequest('/projects/dashboard/sales').query, { period: 'year', scopeType: 'team' });
  assert.equal(team.scopeLabel, '团队');
  assert.deepEqual(team.rows, [
    { 部门: '销售一部', '年度目标（万元）': 800, '已完成（万元）': 500, '完成率（%）': 62.5 },
    { 部门: '销售二部', '年度目标（万元）': 400, '已完成（万元）': 0, '完成率（%）': 0 },
  ]);
  assert.equal(normalizeTable(team).data.length, 2);
  assert.ok(requestsTo('/projects/dashboard/sales').every((r) => !('salesId' in r.query)));
  await rejectsArg('sales_dashboard', { view: 'sales', salesId: 21 }, /sales_dashboard 不认识参数 salesId/u);

  const opportunity = await runTool('sales_dashboard', { view: 'opportunity' });
  assert.deepEqual(lastRequest('/projects/dashboard/opportunity').query, { period: 'quarter' });
  assert.equal(opportunity.summary['商机总金额（万元）'], 795.75);
  const market = await runTool('sales_dashboard', { view: 'market', period: 'month' });
  assert.deepEqual(lastRequest('/projects/dashboard/market').query, { period: 'month' });
  assert.deepEqual(market.summary, { 新增项目数: 6, '新增项目金额（万元）': 795.75 });

  await rejectsArg('sales_dashboard', {}, /需要 view/u);
  await rejectsArg('sales_dashboard', { view: 'market', scopeType: 'team' }, /scopeType 只能在 view="sales" 时使用/u);
  await rejectsArg('sales_dashboard', { view: 'sales', period: 'week' }, /period 只能是 year、quarter、month 之一/u);
});

test('sales_query_work_reports reads daily reports, weekly reports and weekly plans', async () => {
  const daily = await runTool('sales_query_work_reports', { targetType: 'customer', targetId: 1001, startDate: '2026-11-01', endDate: '2026-11-30', reporterName: '张三' });
  assert.deepEqual(lastRequest('/work-reports').query, {
    targetType: '1',
    targetId: '1001',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    reporterId: '21',
    pageNum: '1',
    pageSize: '20',
  });
  assert.deepEqual(daily.query, { targetType: 'customer', targetId: 1001, startDate: '2026-11-01', endDate: '2026-11-30', reporterId: 21, reporterName: '张三' });
  assert.deepEqual(daily.columns, ['日报ID', '日期', '汇报人', '对象类型', '对象ID', '对象名称', '联系人', '工作计划', '工作总结']);
  assert.deepEqual(daily.rows[1], { 日报ID: 502, 日期: '2026-11-25', 汇报人: '张三', 对象类型: '渠道', 对象ID: 9, 对象名称: '华光渠道', 联系人: '', 工作计划: '', 工作总结: '沟通合作' });
  await runTool('sales_query_work_reports', { targetType: 'channel' });
  assert.deepEqual(lastRequest('/work-reports').query, { targetType: '2', pageNum: '1', pageSize: '20' });

  await rejectsArg('sales_query_work_reports', { targetId: 1001 }, /targetId 要和 targetType/u);
  await rejectsArg('sales_query_work_reports', { pageSize: 51 }, /pageSize 必须是 1 到 50 之间的整数/u);
  await rejectsArg('sales_query_work_reports', { weekStartDate: '2026-11-23' }, /weekStartDate 只能在 mode 为 weekly_reports 或 weekly_plan 时使用/u);

  // 周报：这一周任意一天都换成周一；不填就是本周。
  const weekly = await runTool('sales_query_work_reports', { mode: 'weekly_reports', weekStartDate: '2026-11-26' });
  assert.deepEqual(lastRequest('/work-reports/weekly-reports/list').query, { weekStartDate: '2026-11-23', pageNum: '1', pageSize: '20' });
  assert.deepEqual(weekly.rows, [
    {
      汇报人: '张三',
      周开始: '2026-11-23',
      周结束: '2026-11-29',
      本周计划: '拜访客户2；准备投标',
      工作总结: '推进项目1',
      补充说明: '',
      状态: 'SUBMITTED',
      更新时间: '2026-11-26 18:20',
    },
  ]);
  await runTool('sales_query_work_reports', { mode: 'weekly_reports' });
  assert.equal(lastRequest('/work-reports/weekly-reports/list').query.weekStartDate, '2026-11-23');
  await runTool('sales_query_work_reports', { mode: 'weekly_reports', weekStartDate: '2026-11-22' });
  assert.equal(lastRequest('/work-reports/weekly-reports/list').query.weekStartDate, '2026-11-16');

  const plan = await runTool('sales_query_work_reports', { mode: 'weekly_plan', reporterId: 7 });
  assert.deepEqual(lastRequest('/work-reports/weekly-plans').query, { weekStartDate: '2026-11-23', reporterId: '7' });
  assert.deepEqual(plan, {
    mode: 'weekly_plan',
    query: { weekStartDate: '2026-11-23', reporterId: 7, reporterName: '王经理' },
    reporterId: 7,
    reporterName: '王经理',
    weekStartDate: '2026-11-23',
    weekEndDate: '2026-11-29',
    planItems: ['周一例会', '拜访客户'],
  });
  await rejectsArg('sales_query_work_reports', { mode: 'weekly_plan', pageSize: 10 }, /pageSize 不适用于 mode="weekly_plan"/u);
  await rejectsArg('sales_query_work_reports', { mode: 'weekly_reports', startDate: '2026-11-01' }, /startDate 只能在 mode="daily" 时使用/u);
  await rejectsArg('sales_query_work_reports', { mode: 'weekly_reports', weekStartDate: '11/23' }, /weekStartDate 必须是 YYYY-MM-DD/u);
});

test('sales_targets reads personal quarterly targets and team completion', async () => {
  const personal = await runTool('sales_targets', {});
  assert.deepEqual(lastRequest('/sales-targets/personal-completion').query, { year: '2026' });
  assert.deepEqual(personal, {
    scope: 'personal',
    year: 2026,
    unit: '万元',
    annualTarget: 1200,
    columns: ['季度', '目标（万元）'],
    rows: [
      { 季度: '第1季度', '目标（万元）': 300 },
      { 季度: '第2季度', '目标（万元）': 300 },
      { 季度: '第3季度', '目标（万元）': 300 },
      { 季度: '第4季度', '目标（万元）': 0 },
    ],
  });
  const team = await runTool('sales_targets', { scope: 'team', year: 2025 });
  assert.deepEqual(lastRequest('/sales-targets/team-completion').query, { year: '2025' });
  assert.deepEqual(team.rows, [{ 部门: '销售一部', '年度目标（万元）': 800, '已完成（万元）': 500, '完成率（%）': 62.5 }]);
  await rejectsArg('sales_targets', { year: 1999 }, /year 必须是 2000 到 2100 之间的整数/u);
  await rejectsArg('sales_targets', { scope: 'company' }, /scope 只能是 personal、team 之一/u);
});

test('HTTP 403/404/503 and business errors become fixed messages; the account stays connected', async () => {
  const cases = [
    ['/projects/dashboard/sales', { httpStatus: 403, body: { code: 403, message: '无操作权限 secret' } }, 'FORBIDDEN', /^没有查看权限/u],
    ['/projects/dashboard/sales', { httpStatus: 200, body: { code: 403, message: '暂无权限 secret' } }, 'FORBIDDEN', /^没有查看权限/u],
    ['/projects/dashboard/sales', { httpStatus: 404, body: { status: 404, path: '/secret' } }, 'HTTP_ERROR', /HTTP 404.*\/api\/v1/u],
    ['/projects/dashboard/sales', { httpStatus: 503, body: { code: 503, message: '数据库 secret' } }, 'SERVER_ERROR', /暂时不可用（HTTP 503）/u],
    ['/projects/dashboard/sales', { httpStatus: 200, body: { code: 500, message: 'NullPointerException secret' } }, 'SERVER_ERROR', /业务代码 500/u],
    ['/projects/dashboard/sales', { httpStatus: 200, body: { code: 400, message: '季度格式错误 secret' } }, 'BAD_REQUEST', /查询条件不符合/u],
  ];
  try {
    for (const [path, response, code, pattern] of cases) {
      forced = { [path]: response };
      await assert.rejects(
        () => registeredTools.get('sales_dashboard').execute({ view: 'sales' }, {}),
        (error) => error.code === code && pattern.test(error.message) && !/secret|NullPointer/u.test(error.message),
        JSON.stringify(response),
      );
    }
  } finally {
    forced = {};
  }
  assert.equal((await pluginInstance.remoteHandlers.getState()).accounts[0].status, 'ok');
  assert.equal((await runTool('sales_config', {})).connected, true);
});

test('a backend 401 returns the auth-required output and marks the account; re-authorizing recovers; expiry needs no request', async () => {
  const remote = pluginInstance.remoteHandlers;
  validTokens.clear();
  const revoked = await runTool('sales_query_customers', {});
  assert.equal(revoked.kind, AUTH_REQUIRED_KIND);
  assert.equal(revoked.reason, 'revoked');
  assert.equal(revoked.serverUrl, baseUrl);
  assert.match(revoked.message, /王经理/u);
  assert.equal((await remote.getState()).accounts[0].status, 'revoked');
  assert.equal((await runTool('sales_config', {})).connected, false);
  // 已标成失效后不再请求后端，按人员查询（要先查 /users/scope）也一样。
  const before = requests.length;
  assert.equal((await runTool('sales_query_projects', { salesName: '张三' })).reason, 'revoked');
  assert.equal(requests.length, before);

  pollResponses = [MANAGER_APPROVAL];
  const started = await remote.startAuthorization();
  const result = await waitForAuthorization(remote, started.requestId);
  assert.equal(result.status, 'approved');
  assert.equal(result.state.accounts[0].status, 'ok');
  assert.equal((await runTool('sales_targets', {})).scope, 'personal');
  assert.equal(lastRequest('/sales-targets/personal-completion').auth, 'Bearer plugin-jwt-2');

  clockOffsetMs = 200 * 365 * 24 * 3600 * 1000;
  try {
    const start = requests.length;
    const expired = await runTool('sales_dashboard', { view: 'home' });
    assert.equal(expired.kind, AUTH_REQUIRED_KIND);
    assert.equal(expired.reason, 'expired');
    assert.equal(requests.length, start);
  } finally {
    clockOffsetMs = 0;
  }
  // 时钟回来后已标成过期的账户仍要重新授权。
  pollResponses = [MANAGER_APPROVAL];
  const again = await remote.startAuthorization();
  assert.equal((await waitForAuthorization(remote, again.requestId)).status, 'approved');
});

test('every one of the 8 tools produced lossless output', () => {
  assert.deepEqual([...toolsWithLosslessOutput].sort(), [...registeredTools.keys()].sort());
  assert.equal(isLosslessJson({ broken: undefined }), false);
});

test('the plugin only reads: no writes, no paths the backend filter rejects for plugin tokens, tokens only in the Authorization header', () => {
  // 过滤器规则本身（和 L1 一致）。
  assert.equal(blockedForPluginToken('/users/scope'), false);
  assert.equal(blockedForPluginToken('/depts/tree'), false);
  assert.equal(blockedForPluginToken('/users/7'), true);
  assert.equal(blockedForPluginToken('/openclaw/x'), true);
  assert.equal(blockedForPluginToken('/auth/info'), false);
  const authPosts = new Set(['/auth/plugin-authorize/start', '/auth/plugin-authorize/poll', '/auth/plugin-token/revoke']);
  for (const r of requests) {
    assert.ok(r.method === 'GET' || (r.method === 'POST' && authPosts.has(r.path)), `${r.method} ${r.path}`);
    if (r.method === 'GET') assert.equal(blockedForPluginToken(r.path), false, `GET ${r.path} 会被后端过滤器拒绝`);
    assert.doesNotMatch(r.path, /\/generate$/u);
    assert.ok(!('token' in r.query), r.path);
    assert.ok(!Object.values(r.query).some((value) => /plugin-jwt|poll-/u.test(value)), r.path);
  }
});

test('event projection shows the auth card for the last auth-required result in the turn', () => {
  const authResult = JSON.stringify({ kind: AUTH_REQUIRED_KIND, reason: 'expired', serverUrl: baseUrl, message: '授权已过期' });
  const projected = projectEvents([
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'tool/call', seq: 2, surfaceOp: 'append', data: { turn: 3, callId: 'c1', name: 'sales_query_projects' } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 3, callId: 'c1', content: [{ type: 'text', text: authResult }] } },
    { type: 'tool/call', seq: 4, surfaceOp: 'append', data: { turn: 3, callId: 'c2', name: 'sales_targets' } },
    { type: 'tool/result', seq: 5, surfaceOp: 'append', data: { turn: 3, callId: 'c2', result: { rows: [] } } },
  ]);
  assert.deepEqual(projected.authRequired, { seq: 3, callId: 'c1', toolName: 'sales_query_projects', reason: 'expired', message: '授权已过期', serverUrl: baseUrl });
  assert.equal(projected.turn, 3);

  // 失败的工具结果、被 replace 掉的调用都不算。
  const none = projectEvents([
    { type: 'turn/start', seq: 1, data: { turn: 4 } },
    { type: 'tool/call', seq: 2, surfaceOp: 'append', data: { turn: 4, callId: 'c1', name: 'sales_config' } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 4, callId: 'c1', isError: true, content: [{ type: 'text', text: authResult }] } },
    { type: 'tool/call', seq: 4, surfaceOp: 'append', data: { turn: 4, callId: 'c2', name: 'sales_config' } },
    { type: 'tool/result', seq: 5, surfaceOp: 'append', data: { turn: 4, callId: 'c2', structuredContent: JSON.parse(authResult) } },
    { type: 'system/message', seq: 6, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 5 }, data: { turn: 4 } },
  ]);
  assert.equal(none.authRequired, null);
  assert.deepEqual(projectEvents([]), { turn: null, authRequired: null });
});

test('TypertRemoteService "salesforge" is registered with the binary Remote form and RPC argument names', async () => {
  const pluginsRegistered = [];
  const decoratedMethods = [];
  class MockTypertRemoteService {
    constructor(ctx, serviceName) {
      this.ctx = ctx;
      this.serviceName = serviceName;
    }
  }
  // 和真实 @deepseek-ai/dsh-typert-protocol 的 Remote 重载一致（空选项 {} 会被拒绝）。
  const MockRemote = (methodExportOrOptions, context) => {
    if (typeof methodExportOrOptions === 'object' && methodExportOrOptions !== null) {
      if (Reflect.ownKeys(methodExportOrOptions).length === 0) {
        throw new TypeError('typert-protocol: Remote options require name, mode: "stream", or resources');
      }
      return (_fn, ctx) => {
        decoratedMethods.push({ name: ctx.name, meta: methodExportOrOptions });
        ctx.addInitializer(() => {});
      };
    }
    if (context === undefined) throw new TypeError('typert-protocol: Remote decorator context is missing');
    decoratedMethods.push({ name: context.name, fn: methodExportOrOptions });
    context.addInitializer(() => {});
  };
  class MockRemoteError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const mockCtx = {
    tools: { register() {} },
    plugin(cls) { pluginsRegistered.push(cls); },
    get(k) { return this[k]; },
    effect() {},
  };
  const second = setupSalesforge(mockCtx, {
    configPath,
    typert: { TypertRemoteService: MockTypertRemoteService, Remote: MockRemote, RemoteError: MockRemoteError },
  });
  try {
    assert.equal(pluginsRegistered.length, 1);
    // 形参名就是 RPC args 的键名，最后一个形参叫 signal。
    const params = (fn) => fn.toString().match(/^async\s+\w+\(([^)]*)\)/u)[1].split(',').map((p) => p.trim()).filter(Boolean);
    assert.ok(decoratedMethods.every((m) => m.fn));
    assert.deepEqual(Object.fromEntries(decoratedMethods.map((m) => [m.name, params(m.fn)])), {
      getState: ['signal'],
      saveSettings: ['patch', 'signal'],
      testConnection: ['serverUrl', 'signal'],
      startAuthorization: ['signal'],
      pollAuthorization: ['requestId', 'signal'],
      cancelAuthorization: ['requestId', 'signal'],
      setActiveAccount: ['accountId', 'signal'],
      disconnectAccount: ['accountId', 'signal'],
    });
    const instance = new pluginsRegistered[0](mockCtx);
    assert.equal(instance.serviceName, 'salesforge');
    const state = await instance.getState(undefined);
    assert.equal(state.serverUrl, baseUrl);
    // 这个 ctx 没有凭据服务：退回文件存储。
    assert.equal(state.credentialStore, 'file');
    assert.ok(!JSON.stringify(state).includes('plugin-jwt'));
    await assert.rejects(
      () => instance.saveSettings({ serverUrl: 'http://other.test/api/v1' }, undefined),
      (err) => err instanceof MockRemoteError && err.code === 'ACCOUNTS_CONNECTED' && err.message === '更换服务器地址前需要先断开全部账户',
    );
    await assert.rejects(() => instance.setActiveAccount('u404', undefined), (err) => err.code === 'ACCOUNT_NOT_FOUND');
  } finally {
    second.dispose();
  }
});

test('RPC errors carry a fixed code and a safe message, never the underlying exception text', async () => {
  const failing = (error) => async () => {
    throw error;
  };
  const handlers = createSalesforgeRemoteHandlers({
    accounts: {
      getState: failing(new Error('EACCES /Users/x/.dsh/.credentials.yaml token=plugin-jwt-secret')),
      saveSettings: failing(new ApiError('服务器地址不能包含用户名或密码。', { code: 'INVALID_URL' })),
      testConnection: failing(Object.assign(new ApiError('x', { code: 409 }), { message: '固定文案' })),
    },
  });
  await assert.rejects(
    () => handlers.getState(),
    (err) => err.code === 'INTERNAL_ERROR' && err.message === '操作失败，请稍后重试' && !/EACCES|plugin-jwt/u.test(err.message),
  );
  await assert.rejects(() => handlers.saveSettings({}), (err) => err.code === 'INVALID_URL' && err.message === '服务器地址不能包含用户名或密码。');
  // 非字符串错误码统一成 API_ERROR。
  await assert.rejects(() => handlers.testConnection(), (err) => err.code === 'API_ERROR');
  assert.throws(() => createSalesforgeRemoteHandlers({}), TypeError);
});
