// 改数据的 7 个工具：查看详情、新建和修改直接写入；删除和移交只暂存，点了确认卡片才执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSalesforge } from './index.js';
import { ACTION_DONE_KIND, ACTION_PENDING_KIND, ACTION_RECORD_TYPE } from './write-tools.js';
import { ACTION_PENDING_KIND as PROJECTED_PENDING_KIND, ACTION_RECORD_TYPE as PROJECTED_RECORD_TYPE, projectEvents } from './event-projection.js';
import { assertLossless } from './assert-lossless.js';

const workDir = mkdtempSync(join(tmpdir(), 'salesforge-writes-'));
const configPath = join(workDir, 'dsh-config.json');
// 固定「今天」：2026-11-26（周四），所在周的周一是 2026-11-23。
const FIXED_NOW = Date.parse('2026-11-26T12:00:00Z');

// ---------- 模拟销售后端：带内存数据，写接口按后端的行为改数据 ----------

let db;
function resetDb() {
  db = {
    customers: {
      1001: { id: 1001, customerName: '华光科技', industry: '企业', address: '成都市', addressDetail: '天府大道 1 号', salesId: 7, salesName: '王经理', createTime: '2026-03-01T09:00:00' },
      1002: { id: 1002, customerName: '蓝海学院', industry: '教育', address: null, addressDetail: null, salesId: 7, salesName: '王经理' },
    },
    channels: { 9: { id: 9, companyName: '华光渠道', address: null, addressDetail: null, salesId: 23, salesName: '李四' } },
    contacts: {
      customers: {
        1001: [
          { id: 31, customerId: 1001, customerDeptId: 51, contactName: '刘老师', position: '信息中心主任', phone: '13800000031' },
          { id: 32, customerId: 1001, customerDeptId: null, contactName: '陈工', position: null, phone: '13800000032' },
        ],
        1002: [{ id: 35, customerId: 1002, contactName: '赵处', position: '处长', phone: '13800000035' }],
      },
      channels: { 9: [{ id: 41, channelId: 9, channelDeptId: null, contactName: '周总', position: '总经理', phone: '13800000041' }] },
    },
    depts: { customers: { 1001: [{ id: 51, customerId: 1001, deptName: '信息中心' }], 1002: [] }, channels: { 9: [] } },
    projects: {
      3: { id: 3, projectName: '数据平台', customerId: 1001, customerName: '华光科技', customerContactId: 31, customerContactPosition: '信息中心主任', channelId: null, channelName: null, channelContactId: null, product: '数据平台', projectStatus: '方案论证', projectRisk: null, expectedSignDate: '2026-12-20', expectedAmount: 150, remark: null, salesId: 7, salesName: '王经理' },
    },
    reviews: { 3: [{ id: 81, projectId: 3, content: '客户关注部署周期', reviewTime: '2026-11-20T10:00:00' }] },
    analysis: { 3: { id: 5, projectId: 3, demand: '数据治理', techApproval: '', decisionChain: '信息中心→分管副校长', partner: '', competitor: '某友商' } },
    reports: {
      596: { id: 596, reportDate: '2026-11-20', targetType: 1, targetId: 1001, targetName: '华光科技', contactId: 31, contactName: '刘老师', workPlan: '下周报价', workSummary: '演示了数据平台', reporterId: 7, realName: '王经理' },
      597: { id: 597, reportDate: '2026-11-21', targetType: 2, targetId: 9, targetName: '华光渠道', contactId: 41, contactName: '周总', workPlan: '约技术交流', workSummary: '沟通合作', reporterId: 23, realName: '李四' },
    },
    weekly: { id: 12, weekStartDate: '2026-11-23', workSummary: '推进数据平台', supplement: '无', aiResponse: '{"summary":"x"}' },
    targets: [{ id: 4, targetType: 1, targetId: 23, targetName: '李四', year: 2026, q1Amount: 50, q2Amount: 50, q3Amount: null, q4Amount: null }],
    products: [
      { id: 1, productName: '数据平台', status: 1 },
      { id: 2, productName: '智慧校园', status: 1 },
    ],
    nextId: 2000,
  };
}
resetDb();

const SCOPE_USERS = [
  { id: 7, username: 'wangjl', realName: '王经理', deptId: 3 },
  { id: 23, username: 'lisi', realName: '李四', deptId: 4 },
  { id: 24, username: 'lisi2', realName: '李四光', deptId: 4 },
];
// 和后端 PluginTokenPolicy 一致：插件令牌能写的目录。
const WRITE_PREFIXES = ['/customers', '/channels', '/projects', '/work-reports', '/sales-targets'];
const requests = [];
let canManageTargets = true;
const validTokens = new Set();
let issued = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const body = bodyText ? JSON.parse(bodyText) : undefined;
  const path = url.pathname.replace(/^\/api\/v1/u, '');
  const query = Object.fromEntries(url.searchParams);
  requests.push({ method: req.method, path, query, body });
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  const ok = (data = null) => send(200, { code: 200, message: 'success', data });
  const fail = (code, message) => send(200, { code, message, data: null });

  if (req.method === 'POST' && path === '/auth/plugin-authorize/start') {
    return ok({ requestId: 'req-w-0123456789abcdefghijklmn', userCode: 'WXYZ-2345', pollSecret: 'poll-w-0123456789abcdefghijklmnopqrstuvwxyz0123', verifyPath: '/plugin-authorize?req=x', verifyUrl: null, interval: 2, expiresIn: 600 });
  }
  if (req.method === 'POST' && path === '/auth/plugin-authorize/poll') {
    const token = `plugin-jwt-w${++issued}`;
    validTokens.add(token);
    return ok({ status: 'APPROVED', grantId: 9, expiresAt: '2099-01-01T00:00:00+08:00', token, user: { userId: 7, username: 'wangjl', realName: '王经理', deptName: '销售一部' } });
  }
  if (!validTokens.has((req.headers.authorization || '').replace(/^Bearer /u, ''))) return send(401, { code: 401, message: '登录已过期', data: null });
  if (req.method !== 'GET' && !WRITE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return send(403, { code: 403, message: '无操作权限', data: null });
  }

  let m;
  // ----- 客户和渠道 -----
  if ((m = path.match(/^\/(customers|channels)$/u)) && req.method === 'POST') {
    const kind = m[1];
    const nameKey = kind === 'customers' ? 'customerName' : 'companyName';
    if (Object.values(db[kind]).some((r) => r[nameKey] === body[nameKey])) return fail(400, `${kind === 'customers' ? '客户' : '渠道'}名称已存在，请勿重复创建`);
    const id = ++db.nextId;
    db[kind][id] = { id, ...body, salesId: 7, salesName: '王经理' };
    db.contacts[kind][id] = [];
    db.depts[kind][id] = [];
    return ok(id);
  }
  if ((m = path.match(/^\/(customers|channels)\/(\d+)$/u))) {
    const [, kind, id] = m;
    const record = db[kind][id];
    if (!record) return fail(403, '数据不存在或不在你的数据范围内');
    if (req.method === 'GET') return ok(record);
    if (req.method === 'PUT') {
      // 和后端一样：名称、地址（客户还有行业）每次都整体写入，没传就写成空。
      const keys = kind === 'customers' ? ['customerName', 'address', 'addressDetail', 'industry'] : ['companyName', 'address', 'addressDetail'];
      for (const key of keys) record[key] = body[key] ?? null;
      return ok();
    }
    if (req.method === 'DELETE') {
      delete db[kind][id];
      return ok();
    }
  }
  if ((m = path.match(/^\/(customers|channels)\/(\d+)\/(contacts|depts)$/u))) {
    const [, kind, id, sub] = m;
    if (!db[kind][id]) return fail(403, '数据不存在或不在你的数据范围内');
    if (req.method === 'GET') return ok(db[sub][kind][id]);
    const owner = kind === 'customers' ? 'customerId' : 'channelId';
    db[sub][kind][id].push({ ...body, id: ++db.nextId, [owner]: Number(id) });
    return ok();
  }
  if ((m = path.match(/^\/(customers|channels)\/(contacts|depts)\/(\d+)$/u))) {
    const [, kind, sub, id] = m;
    for (const list of Object.values(db[sub][kind])) {
      const index = list.findIndex((r) => r.id === Number(id));
      if (index < 0) continue;
      if (req.method === 'DELETE') list.splice(index, 1);
      else for (const [key, value] of Object.entries(body)) if (value !== null && value !== undefined) list[index][key] = value;
      return ok();
    }
    return fail(403, '联系人不存在或不在你的数据范围内');
  }
  if ((m = path.match(/^\/(customers|channels|projects)\/transfer$/u))) return ok({ transferredCount: body.ids.length, projectCount: m[1] === 'projects' ? 0 : 2 });

  // ----- 项目 -----
  if (path === '/products') return ok({ records: db.products, total: db.products.length, pageNum: 1, pageSize: 200, pages: 1 });
  if (path === '/projects' && req.method === 'GET') {
    const records = Object.values(db.projects).filter((p) => !query.projectName || p.projectName.includes(query.projectName));
    return ok({ records, total: records.length, pageNum: 1, pageSize: 10, pages: 1 });
  }
  if (path === '/projects' && req.method === 'POST') {
    const id = ++db.nextId;
    db.projects[id] = { id, ...body, salesId: 7, salesName: '王经理' };
    return ok();
  }
  if ((m = path.match(/^\/projects\/(\d+)$/u))) {
    const p = db.projects[m[1]];
    if (!p) return fail(403, '项目不存在或不在你的数据范围内');
    if (req.method === 'GET') return ok(p);
    if (req.method === 'PUT') {
      // updateById：只写非空字段。
      for (const [key, value] of Object.entries(body)) if (value !== null && value !== undefined) p[key] = value;
      return ok();
    }
    if (req.method === 'DELETE') {
      delete db.projects[m[1]];
      return ok();
    }
  }
  if ((m = path.match(/^\/projects\/(\d+)\/reviews$/u))) {
    if (req.method === 'GET') return ok(db.reviews[m[1]] || []);
    (db.reviews[m[1]] ||= []).push({ id: ++db.nextId, projectId: Number(m[1]), content: body.content, reviewTime: '2026-11-26T12:00:00' });
    return ok();
  }
  if ((m = path.match(/^\/projects\/reviews\/(\d+)$/u))) {
    const review = Object.values(db.reviews).flat().find((r) => r.id === Number(m[1]));
    review.content = body.content;
    return ok();
  }
  if ((m = path.match(/^\/projects\/(\d+)\/analysis$/u))) {
    if (req.method === 'GET') return ok(db.analysis[m[1]] || null);
    db.analysis[m[1]] = { ...body };
    return ok();
  }

  // ----- 工作报告 -----
  if ((m = path.match(/^\/work-reports\/(\d+)$/u))) {
    const r = db.reports[m[1]];
    if (!r) return fail(403, '报告不存在或不在你的数据范围内');
    if (req.method === 'GET') return ok(r);
    if (r.reporterId !== 7) return fail(403, '只有报告人本人或管理员可以修改、删除这份工作报告');
    if (req.method === 'PUT') {
      Object.assign(r, body);
      const kind = r.targetType === 1 ? 'customers' : 'channels';
      r.targetName = db[kind][r.targetId]?.[kind === 'customers' ? 'customerName' : 'companyName'] ?? '';
      r.contactName = (db.contacts[kind][r.targetId] || []).find((c) => c.id === r.contactId)?.contactName ?? '';
      return ok();
    }
    delete db.reports[m[1]];
    return ok();
  }
  if (path === '/work-reports/weekly-plans' && req.method === 'PUT') return ok({ weekStartDate: body.weekStartDate, planItems: body.planItems });
  if (path === '/work-reports/weekly-reports') {
    if (req.method === 'GET') return ok(db.weekly);
    Object.assign(db.weekly, body);
    return ok(db.weekly);
  }
  if ((m = path.match(/^\/work-reports\/weekly-reports\/(\d+)$/u)) && req.method === 'DELETE') return ok();

  // ----- 销售目标 -----
  if (path === '/sales-targets') {
    if (!canManageTargets) return fail(403, '暂无权限');
    if (req.method === 'GET') return ok({ records: db.targets, total: db.targets.length, pageNum: 1, pageSize: 500, pages: 1 });
    const existing = db.targets.find((t) => t.targetType === body.targetType && t.targetId === body.targetId && t.year === body.year);
    if (existing) Object.assign(existing, body);
    else db.targets.push({ id: ++db.nextId, ...body });
    return ok();
  }
  if ((m = path.match(/^\/sales-targets\/(\d+)$/u)) && req.method === 'DELETE') {
    db.targets = db.targets.filter((t) => t.id !== Number(m[1]));
    return ok();
  }

  if (path === '/users/scope') return ok(SCOPE_USERS);
  return send(404, { code: 404, message: `Not found: ${req.method} ${path}`, data: null });
});

let baseUrl;
let tools;
let plugin;
const appended = [];
const fakeSessions = new Map();
const toolsWithLosslessOutput = new Set();
const WRITE_TOOLS = ['sales_delete', 'sales_get_record', 'sales_save_customer', 'sales_save_project', 'sales_save_target', 'sales_save_work_report', 'sales_transfer'];

function memoryCredentials() {
  const records = new Map();
  return {
    async readRecord(key) { return records.has(key) ? structuredClone(records.get(key)) : undefined; },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key));
      if (next !== undefined) records.set(key, structuredClone(next));
      return next ?? records.get(key);
    },
    async deleteRecord(key) { records.delete(key); },
  };
}

async function run(name, args = {}, exec = {}) {
  const output = await tools.get(name).execute(args, exec);
  assertLossless(output, `${name} 的输出`);
  toolsWithLosslessOutput.add(name);
  return output;
}

async function rejectsArg(name, args, pattern) {
  await assert.rejects(
    () => tools.get(name).execute(args, {}),
    (error) => error.code === 'INVALID_ARGUMENT' && pattern.test(error.message),
    `${name} ${JSON.stringify(args)}`,
  );
}

const writesSince = (index) => requests.slice(index).filter((r) => r.method !== 'GET');
const lastWrite = () => requests.filter((r) => r.method !== 'GET').at(-1);
const mark = () => requests.length;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  tools = new Map();
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); } },
    credentials: memoryCredentials(),
    sessions: { get: (id) => fakeSessions.get(id) },
    get(svc) { return this[svc]; },
    effect() {},
  };
  plugin = setupSalesforge(ctx, {
    configPath,
    appendPluginRecord: (session, type, data) => appended.push({ session, type, data }),
    hostname: () => 'test-host',
    now: () => FIXED_NOW,
    schedule: (fn) => setTimeout(fn, 2),
    cancelSchedule: (handle) => clearTimeout(handle),
  });
  const remote = plugin.remoteHandlers;
  await remote.saveSettings({ serverUrl: baseUrl });
  const started = await remote.startAuthorization(undefined);
  for (let i = 0; i < 200; i++) {
    const result = await remote.pollAuthorization(started.requestId);
    if (result.status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal((await remote.getState()).activeAccountId, 'u7');
});

test.after(async () => {
  plugin?.dispose();
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

test('sales_get_record shows details, contacts, depts, reviews and analysis, but never phone numbers', async () => {
  const customer = await run('sales_get_record', { type: 'customer', id: 1001 });
  assert.equal(customer.name, '华光科技');
  assert.equal(customer.industry, '企业');
  assert.deepEqual(customer.contacts, [
    { contactId: 31, contactName: '刘老师', position: '信息中心主任', deptId: 51, deptName: '信息中心' },
    { contactId: 32, contactName: '陈工', position: '', deptId: null, deptName: '' },
  ]);
  assert.deepEqual(customer.depts, [{ deptId: 51, deptName: '信息中心' }]);
  assert.doesNotMatch(JSON.stringify(customer), /1380000/u);

  const channel = await run('sales_get_record', { type: 'channel', id: 9 });
  assert.equal(channel.name, '华光渠道');
  assert.equal('industry' in channel, false);

  const project = await run('sales_get_record', { type: 'project', id: 3 });
  assert.equal(project.customerContactName, '刘老师');
  assert.equal(project.expectedAmount, 150);
  assert.deepEqual(project.reviews, [{ reviewId: 81, content: '客户关注部署周期', reviewTime: '2026-11-20 10:00' }]);
  assert.equal(project.analysis.competitor, '某友商');

  const report = await run('sales_get_record', { type: 'work_report', id: 596 });
  assert.deepEqual(
    { targetType: report.targetType, targetName: report.targetName, contactName: report.contactName, workSummary: report.workSummary },
    { targetType: 'customer', targetName: '华光科技', contactName: '刘老师', workSummary: '演示了数据平台' },
  );
  await rejectsArg('sales_get_record', { type: 'user', id: 7 }, /type 只能是/u);
});

test('sales_save_customer creates and updates customers, contacts and depts, sending the full record where the backend needs it', async () => {
  const before = mark();
  const created = await run('sales_save_customer', { action: 'create', targetType: 'customer', name: '  西南大学 ', industry: '教育' });
  assert.match(created.message, /已新建客户「西南大学」（ID \d+）/u);
  assert.deepEqual(writesSince(before)[0], { method: 'POST', path: '/customers', query: {}, body: { customerName: '西南大学', address: null, addressDetail: null, industry: '教育' } });
  // 重名时转告销售系统的原因。
  await assert.rejects(
    () => run('sales_save_customer', { action: 'create', targetType: 'customer', name: '西南大学' }),
    (error) => error.message === '销售管理系统没有接受这次操作：客户名称已存在，请勿重复创建。',
  );

  // 只改行业：名称、地址照原样带上，不会被后端写空。
  const updated = await run('sales_save_customer', { action: 'update', targetType: 'customer', targetId: 1001, industry: '政府' });
  assert.deepEqual(requests.at(-1).body, { customerName: '华光科技', address: '成都市', addressDetail: '天府大道 1 号', industry: '政府' });
  assert.deepEqual(updated.changes, [{ field: '行业', before: '企业', after: '政府' }]);
  assert.equal(db.customers[1001].address, '成都市');
  await rejectsArg('sales_save_customer', { action: 'update', targetType: 'channel', targetId: 9, industry: '政府' }, /渠道没有行业字段/u);
  await rejectsArg('sales_save_customer', { action: 'update', targetType: 'customer' }, /要给 targetId/u);

  const contact = await run('sales_save_customer', { action: 'add_contact', targetType: 'customer', targetId: 1001, contactName: '王主任', position: '副主任', phone: '13900000001', deptId: 51 });
  assert.equal(typeof contact.contactId, 'number');
  assert.deepEqual(requests.filter((r) => r.method === 'POST').at(-1).body, { contactName: '王主任', position: '副主任', phone: '13900000001', customerDeptId: 51 });
  await assert.rejects(
    () => run('sales_save_customer', { action: 'add_contact', targetType: 'customer', targetId: 1001, contactName: '某人', deptId: 99 }),
    (error) => /部门 99 不是客户「华光科技」的部门。可选：信息中心（deptId 51）/u.test(error.message),
  );

  // 改联系人：只改给出的字段；电话改了只说改了，不把号码放进输出。
  const changed = await run('sales_save_customer', { action: 'update_contact', targetType: 'customer', targetId: 1001, contactId: 32, position: '工程师', phone: '13700000000' });
  assert.deepEqual(requests.at(-1).body, { id: 32, contactName: '陈工', position: '工程师', phone: '13700000000', customerDeptId: null });
  assert.deepEqual(changed.changes, [
    { field: '职位', before: '', after: '工程师' },
    { field: '电话', before: '（原电话）', after: '（新电话）' },
  ]);
  assert.doesNotMatch(JSON.stringify(changed), /1370000|1380000/u);
  const moved = await run('sales_save_customer', { action: 'update_contact', targetType: 'customer', targetId: 1001, contactId: 32, deptId: 51 });
  assert.deepEqual(moved.changes, [{ field: '所属部门', before: '', after: '信息中心' }]);
  await assert.rejects(
    () => run('sales_save_customer', { action: 'update_contact', targetType: 'customer', targetId: 1001, contactId: 41, position: 'x' }),
    (error) => /联系人 41 不是客户「华光科技」的联系人/u.test(error.message),
  );

  const dept = await run('sales_save_customer', { action: 'add_dept', targetType: 'channel', targetId: 9, deptName: '商务部' });
  assert.equal(dept.deptName, '商务部');
  assert.equal(typeof dept.deptId, 'number');
});

test('sales_save_project creates with checked products and contacts, updates only given fields, and keeps reviews and analysis', async () => {
  await rejectsArg('sales_save_project', { action: 'create', projectName: '新项目', customerId: 1001 }, /客户联系人/u);
  await assert.rejects(
    () => run('sales_save_project', { action: 'create', projectName: '新项目', customerId: 1001, customerContactName: '刘老师', product: '数据平台、大模型', expectedAmount: 80, expectedSignDate: '2027-03-31' }),
    (error) => /产品「大模型」不在销售管理系统的产品列表里。可选产品：数据平台、智慧校园/u.test(error.message),
  );
  const created = await run('sales_save_project', { action: 'create', projectName: '智慧校园二期', customerId: 1001, customerContactName: '刘老师', product: '数据平台、智慧校园', expectedAmount: 80, expectedSignDate: '2027-03-31' });
  assert.deepEqual(requests.filter((r) => r.method === 'POST' && r.path === '/projects').at(-1).body, {
    projectName: '智慧校园二期',
    product: '数据平台,智慧校园',
    expectedSignDate: '2027-03-31',
    expectedAmount: 80,
    customerId: 1001,
    customerContactId: 31,
    customerContactPosition: '信息中心主任',
    projectStatus: '发现问题',
  });
  assert.equal(typeof created.projectId, 'number');
  assert.match(created.message, /已新建项目「智慧校园二期」（ID \d+）/u);

  const updated = await run('sales_save_project', { action: 'update', projectId: 3, projectStatus: '商务招标', expectedAmount: 120 });
  assert.deepEqual(requests.at(-1).body, { id: 3, projectStatus: '商务招标', expectedAmount: 120 });
  assert.deepEqual(updated.changes, [
    { field: '项目阶段', before: '方案论证', after: '商务招标' },
    { field: '预计金额（万元）', before: 150, after: 120 },
  ]);
  await rejectsArg('sales_save_project', { action: 'update', projectId: 3, customerId: 1002 }, /换了客户，要同时给新客户的联系人/u);
  const switched = await run('sales_save_project', { action: 'update', projectId: 3, customerId: 1002, customerContactId: 35 });
  assert.deepEqual(lastWrite().body, { id: 3, customerId: 1002, customerContactId: 35, customerContactPosition: '处长' });
  assert.deepEqual(switched.changes, [
    { field: '客户', before: '客户「华光科技」', after: '客户「蓝海学院」' },
    { field: '客户联系人', before: '刘老师', after: '赵处' },
  ]);
  await run('sales_save_project', { action: 'update', projectId: 3, projectRisk: '' });
  assert.deepEqual(requests.at(-1).body, { id: 3, projectRisk: '' });

  await run('sales_save_project', { action: 'add_review', projectId: 3, content: '已约下周技术交流' });
  assert.deepEqual(requests.at(-1).body, { content: '已约下周技术交流' });
  await assert.rejects(() => run('sales_save_project', { action: 'update_review', projectId: 3, reviewId: 999, content: 'x' }), /梳理记录 999 不属于项目「数据平台」/u);
  const review = await run('sales_save_project', { action: 'update_review', projectId: 3, reviewId: 81, content: '客户关注部署周期和费用' });
  assert.deepEqual(review.changes, [{ field: '梳理内容', before: '客户关注部署周期', after: '客户关注部署周期和费用' }]);

  const analysis = await run('sales_save_project', { action: 'save_analysis', projectId: 3, partner: '华光渠道' });
  assert.deepEqual(requests.at(-1).body, { projectId: 3, demand: '数据治理', techApproval: '', decisionChain: '信息中心→分管副校长', partner: '华光渠道', competitor: '某友商' });
  assert.deepEqual(analysis.changes, [{ field: '合作伙伴', before: '', after: '华光渠道' }]);
});

test('sales_save_work_report updates a daily report with the full record, and saves weekly plans and reports', async () => {
  const updated = await run('sales_save_work_report', { action: 'update_daily', reportId: 596, contactName: '陈工', workSummary: '演示了数据平台，客户认可方案' });
  assert.deepEqual(requests.at(-1), {
    method: 'PUT',
    path: '/work-reports/596',
    query: {},
    body: { id: 596, reportDate: '2026-11-20', targetType: 1, targetId: 1001, contactId: 32, workPlan: '下周报价', workSummary: '演示了数据平台，客户认可方案' },
  });
  // 改动说明写姓名和名称，不写 ID。
  assert.deepEqual(updated.changes, [
    { field: '拜访人', before: '刘老师', after: '陈工' },
    { field: '工作总结', before: '演示了数据平台', after: '演示了数据平台，客户认可方案' },
  ]);
  assert.equal(updated.contactName, '陈工');

  // 换拜访对象：新对象只有一位联系人时自动选上；有多位时要给拜访人。
  const moved = await run('sales_save_work_report', { action: 'update_daily', reportId: 596, targetType: 'customer', targetId: 1002 });
  assert.equal(lastWrite().body.contactId, 35);
  assert.deepEqual(moved.changes, [
    { field: '拜访对象', before: '客户「华光科技」', after: '客户「蓝海学院」' },
    { field: '拜访人', before: '陈工', after: '赵处' },
  ]);
  await rejectsArg('sales_save_work_report', { action: 'update_daily', reportId: 596, targetType: 'customer' }, /targetType 和 targetId 要一起给/u);
  await rejectsArg('sales_save_work_report', { action: 'update_daily', reportId: 596, workPlan: '  ' }, /工作计划（workPlan）不能为空/u);
  await assert.rejects(
    () => run('sales_save_work_report', { action: 'update_daily', reportId: 597, workSummary: '改别人的' }),
    (error) => error.code === 'FORBIDDEN' && /只有报告人本人或管理员/u.test(error.message),
  );

  const plan = await run('sales_save_work_report', { action: 'save_weekly_plan', weekStartDate: '2026-12-03', planItems: [' 拜访华光科技 ', '', '准备投标'] });
  assert.deepEqual(requests.at(-1).body, { weekStartDate: '2026-11-30', planItems: ['拜访华光科技', '准备投标'] });
  assert.equal(plan.planItems.length, 2);

  const weekly = await run('sales_save_work_report', { action: 'save_weekly_report', workSummary: '推进数据平台，约了技术交流' });
  assert.deepEqual(requests.at(-1).body, { weekStartDate: '2026-11-23', workSummary: '推进数据平台，约了技术交流', supplement: '无', aiResponse: '{"summary":"x"}' });
  assert.deepEqual(weekly.changes, [{ field: '工作总结', before: '推进数据平台', after: '推进数据平台，约了技术交流' }]);
});

test('sales_save_target merges the given quarters into the existing target and explains a missing permission', async () => {
  const saved = await run('sales_save_target', { targetType: 'person', userName: '李四', q3Amount: 60 });
  assert.deepEqual(requests.at(-1).body, { targetType: 1, targetId: 23, year: 2026, q1Amount: 50, q2Amount: 50, q3Amount: 60, q4Amount: 0 });
  assert.equal(saved.annualTarget, 160);
  assert.match(saved.message, /已设置李四 2026 年的销售目标，全年 160 万元/u);
  // 有两位叫「李四」开头的人时按精确姓名匹配；匹配不上返回候选。
  const unresolved = await run('sales_save_target', { targetType: 'person', userName: '李', q1Amount: 1 });
  assert.equal(unresolved.kind, 'salesforge-person-unresolved');
  await run('sales_save_target', { targetType: 'dept', deptId: 4, year: 2027, q1Amount: 100, q2Amount: 100, q3Amount: 100, q4Amount: 100 });
  assert.deepEqual(requests.at(-1).body, { targetType: 2, targetId: 4, year: 2027, q1Amount: 100, q2Amount: 100, q3Amount: 100, q4Amount: 100 });
  await rejectsArg('sales_save_target', { targetType: 'dept', q1Amount: 1 }, /部门目标要给 deptId/u);
  canManageTargets = false;
  try {
    await assert.rejects(() => run('sales_save_target', { targetType: 'dept', deptId: 4, q1Amount: 1 }), /只有能管理销售目标的账户/u);
  } finally {
    canManageTargets = true;
  }
});

test('sales_delete only stages a confirmation card; confirmAction deletes item by item and records the result', async () => {
  const session = { id: 's-del', snapshotEvents: () => [{ type: 'tool/call', data: { turn: 8, callId: 'call-d1', name: 'sales_delete' } }] };
  fakeSessions.set('s-del', session);
  const before = mark();
  const pending = await run('sales_delete', { type: 'work_report', ids: [596, 597, 598] }, { agent: { id: 's-del' }, callId: 'call-d1' });
  assert.deepEqual(writesSince(before), [], '发起删除不写入');
  assert.equal(pending.kind, ACTION_PENDING_KIND);
  assert.equal(PROJECTED_PENDING_KIND, ACTION_PENDING_KIND);
  assert.match(pending.actionId, /^act_[0-9a-f]{16}$/u);
  assert.equal(pending.title, '删除 2 条日报');
  assert.deepEqual(pending.items.map((item) => item.id), [596, 597]);
  assert.equal(pending.items[0].label, '2026-11-20 蓝海学院 · 赵处（王经理）：演示了数据平台，客户认可方案');
  assert.deepEqual(pending.skipped, [{ id: 598, reason: '不存在或不在你的数据范围内' }]);
  assert.match(pending.hint, /还没有删除/u);

  const result = await plugin.remoteHandlers.confirmAction(pending.actionId, undefined);
  assert.equal(result.kind, ACTION_DONE_KIND);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results[0], { id: 596, ok: true });
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].error, /只有报告人本人或管理员/u);
  assert.deepEqual(writesSince(before).map((r) => `${r.method} ${r.path}`), ['DELETE /work-reports/596', 'DELETE /work-reports/597']);
  assert.equal(db.reports[596], undefined);
  assert.deepEqual(appended.at(-1), {
    session,
    type: ACTION_RECORD_TYPE,
    data: { version: 1, turn: 8, actionId: pending.actionId, status: 'partial', results: result.results },
  });
  assert.equal(PROJECTED_RECORD_TYPE, ACTION_RECORD_TYPE);

  // 再点一次不会重复删除。
  const again = await plugin.remoteHandlers.confirmAction(pending.actionId, undefined);
  assert.equal(again.alreadyDone, true);
  assert.equal(writesSince(before).length, 2);
  await assert.rejects(() => plugin.remoteHandlers.cancelAction(pending.actionId), (error) => error.code === 'ACTION_DONE');
  await assert.rejects(() => plugin.remoteHandlers.confirmAction('act_missing', undefined), (error) => error.code === 'ACTION_NOT_FOUND' && /重新发起/u.test(error.message));

  // 会话投影：工具结果出确认卡片，执行记录标出结果。
  const projected = projectEvents([
    { type: 'turn/start', seq: 1, data: { turn: 8 } },
    { type: 'tool/call', seq: 2, data: { turn: 8, callId: 'call-d1', name: 'sales_delete' } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 8, callId: 'call-d1', content: [{ type: 'text', text: JSON.stringify(pending) }] } },
    { type: ACTION_RECORD_TYPE, seq: 4, data: appended.at(-1).data },
  ]);
  assert.equal(projected.pendingActions[0].actionId, pending.actionId);
  assert.equal(projected.actionStatusById[pending.actionId].status, 'partial');
});

test('sales_delete checks contacts and depts against their customer, and nothing is staged when no id is valid', async () => {
  await rejectsArg('sales_delete', { type: 'customer_contact', ids: [31] }, /要给 parentId/u);
  await rejectsArg('sales_delete', { type: 'work_report', ids: [] }, /ids 要给 1 到 20 个正整数 ID/u);
  const contact = await run('sales_delete', { type: 'customer_contact', ids: [31, 41], parentId: 1001 });
  assert.deepEqual(contact.items, [{ id: 31, label: '刘老师（信息中心主任） · 客户「华光科技」' }]);
  assert.deepEqual(contact.skipped, [{ id: 41, reason: '不是客户「华光科技」的联系人' }]);

  const nothing = await run('sales_delete', { type: 'project', ids: [404] });
  assert.equal(nothing.kind, 'salesforge-nothing-to-delete');
  assert.equal(plugin.pendingActions.has(nothing.actionId), false);

  // 取消后不能再确认。
  const customer = await run('sales_delete', { type: 'customer', ids: [1002] });
  assert.match(customer.items[0].label, /客户「蓝海学院」 · 负责人 王经理/u);
  assert.deepEqual(await plugin.remoteHandlers.cancelAction(customer.actionId), { actionId: customer.actionId, status: 'cancelled' });
  await assert.rejects(() => plugin.remoteHandlers.confirmAction(customer.actionId, undefined), (error) => error.code === 'ACTION_CANCELLED');
  assert.ok(db.customers[1002], '取消的删除没有执行');

  const target = await run('sales_delete', { type: 'sales_target', ids: [4] });
  assert.match(target.items[0].label, /李四 · 2026 年 · 全年 160 万元/u);
  const done = await plugin.remoteHandlers.confirmAction(target.actionId, undefined);
  assert.equal(done.status, 'done');
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).path, '/sales-targets/4');
});

test('sales_transfer resolves the receiver, stages a card and transfers on confirm', async () => {
  const before = mark();
  const pending = await run('sales_transfer', { type: 'customer', ids: [1001], toUserName: '李四' });
  assert.deepEqual(writesSince(before), []);
  assert.equal(pending.action, 'transfer');
  assert.deepEqual(pending.toUser, { userId: 23, realName: '李四' });
  assert.equal(pending.includeProjects, true);
  assert.equal(pending.title, '把 1 个客户移交给李四');
  const result = await plugin.remoteHandlers.confirmAction(pending.actionId, undefined);
  assert.deepEqual(requests.at(-1), { method: 'POST', path: '/customers/transfer', query: {}, body: { ids: [1001], targetUserId: 23, includeProjects: true } });
  assert.equal(result.status, 'done');
  assert.equal(result.projectCount, 2);

  const project = await run('sales_transfer', { type: 'project', ids: [3], toUserId: 23, includeProjects: true });
  assert.equal(project.includeProjects, false, '移交项目时没有「一并移交项目」');
  await rejectsArg('sales_transfer', { type: 'project', ids: [3] }, /请给出接收人/u);
});

test('confirming with another account fails and keeps the action pending', async () => {
  const pending = await run('sales_delete', { type: 'project', ids: [3] });
  const entry = plugin.pendingActions.get(pending.actionId);
  entry.accountId = 'u999';
  await assert.rejects(() => plugin.remoteHandlers.confirmAction(pending.actionId, undefined), (error) => error.code === 'ACCOUNT_SWITCHED');
  assert.equal(entry.status, 'pending');
  assert.ok(db.projects[3]);
});

test('every write tool produced lossless output; writes stay inside the plugin token boundary', () => {
  assert.deepEqual([...toolsWithLosslessOutput].sort(), WRITE_TOOLS);
  for (const r of requests) {
    if (r.method === 'GET' || r.path.startsWith('/auth/')) continue;
    assert.ok(WRITE_PREFIXES.some((prefix) => r.path === prefix || r.path.startsWith(`${prefix}/`)), `${r.method} ${r.path}`);
    assert.doesNotMatch(r.path, /\/generate$/u);
  }
});
