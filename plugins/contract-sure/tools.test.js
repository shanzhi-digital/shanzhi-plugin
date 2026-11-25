import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupContractSure } from './index.js';
import { createContractSureRemoteHandlers } from './preview-service.js';
import { ApiError } from './api-client.js';
import { projectEvents, DRAFT_RECORD_TYPE, DRAFT_CONFIRMED_RECORD_TYPE, DETAIL_RECORD_TYPE } from './event-projection.js';
import { normalizeTable } from '../datahub-echarts/results.js';
import { assertLossless, isLosslessJson } from './assert-lossless.js';

const workDir = mkdtempSync(join(tmpdir(), 'contract-sure-tools-'));
const configPath = join(workDir, 'dsh-config.json');
const cacheRoot = join(workDir, 'cache');

// Create local fixture files
const samplePdfPath = join(workDir, 'HT-2026-008.pdf');
writeFileSync(samplePdfPath, Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'));
const sampleExcelPath = join(workDir, 'bank-2026.xlsx');
writeFileSync(sampleExcelPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
const sampleInvoicePath = join(workDir, 'invoice-01.png');
writeFileSync(sampleInvoicePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const requests = [];
let nextContractId = 101;
// 后端签发过、尚未吊销的插件令牌。
const validTokens = new Set();
let issuedTokenCount = 0;
let pollResponses = [];
const DEFAULT_UNMATCHED_ROWS = [
  {
    id: 902,
    txnType: 3,
    txnDate: '2026-04-12',
    amount: 45000,
    counterparty: '浙江云算供应商',
    contractNo: null,
    description: '服务器采购尾款',
    matchStatus: 0,
  },
];
let unmatchedRows = DEFAULT_UNMATCHED_ROWS;
// 只让某个子请求返回 401（主请求照常成功），用来测试子请求的授权失效。
let failSummaryWith401 = false;
let failUploadWith401 = false;
// 数据库故障时 L1 对插件令牌返回 HTTP 503。
let serviceUnavailable = false;
// 模拟旧版后端：创建合同只返回合同 ID，不认 detail=true。
let legacyCreateResponse = false;

// 新匹配规则下「星河数据」草稿的预匹配：一笔拆单、一份顺带调整的合同、一个疑似同一家。
const XINGHE = '北京星河数据有限公司';
function xingheMatchPreview() {
  return {
    available: true,
    engine: 'PARTY_FIFO',
    reason: null,
    counterparty: { name: XINGHE, side: 'A', guessed: false },
    money: {
      count: 2,
      total: 50000,
      items: [
        { transactionId: 2, date: '2026-04-15', counterparty: XINGHE, referenceNo: 'R002', transactionAmount: 80000, allocatedAmount: 40000, split: true, matchMethod: 'PARTY_FIFO' },
        { transactionId: 4, date: '2026-05-01', counterparty: XINGHE, referenceNo: 'R004', transactionAmount: 30000, allocatedAmount: 10000, split: true, matchMethod: 'PARTY_FIFO' },
      ],
    },
    invoice: {
      count: 1,
      total: 50000,
      items: [{ transactionId: 7, date: '2026-06-15', counterparty: XINGHE, referenceNo: 'INV002', transactionAmount: 50000, allocatedAmount: 50000, split: false, matchMethod: 'PARTY_FIFO' }],
    },
    overAllocated: false,
    adjustedContracts: [
      { contractId: 3, contractNo: 'sz-2026-0001', contractName: '星河数据平台二期', moneyBefore: 60000, moneyAfter: 60000, invoiceBefore: 50000, invoiceAfter: 0 },
    ],
    suspects: [
      { transactionPartyName: '星河数据', transactionPartyKey: '星河数据', contractPartyName: XINGHE, contractPartyKey: XINGHE, transactionCount: 1, transactionTotal: 30000 },
    ],
    note: '预匹配结果以入库结果为准',
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rawBody = await readRequestBody(req);
  const auth = req.headers.authorization || '';
  requests.push({
    method: req.method,
    pathname: url.pathname,
    search: url.search,
    auth,
    contentType: req.headers['content-type'] || '',
    bodyText: rawBody.toString('utf8'),
  });

  const sendJson = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  // 约定 A：A1 发起授权、A5 轮询、A8 吊销。
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/plugin-authorize/start') {
    const requestId = `req-${requests.length}-abcdefghijklmnopqrstuvwx`;
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        requestId,
        userCode: 'ABCD-2345',
        pollSecret: `poll-${requestId}-0123456789abcdefghijklmnopqrstuvwxyz`,
        verifyPath: `/plugin-authorize?req=${requestId}`,
        verifyUrl: null,
        interval: 2,
        expiresIn: 600,
      },
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/plugin-authorize/poll') {
    const next = pollResponses.shift() || { status: 'PENDING' };
    if (next.status !== 'APPROVED') return sendJson(200, { code: 200, message: 'success', data: next });
    const token = `plugin-jwt-${++issuedTokenCount}`;
    validTokens.add(token);
    return sendJson(200, { code: 200, message: 'success', data: { ...next, token } });
  }

  const bearer = auth.replace(/^Bearer /u, '');
  if (serviceUnavailable) return sendJson(503, { code: 503, message: '服务暂时不可用', data: null });
  if (!validTokens.has(bearer)) {
    return sendJson(401, { code: 401, message: '登录已过期，请重新登录', data: null });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/auth/plugin-token/revoke') {
    validTokens.delete(bearer);
    return sendJson(200, { code: 200, message: 'success', data: null });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: { id: 7, username: 'admin', realName: '张主管', deptName: '综合管理部', deptId: 1, postType: 1, roleKeys: ['ROLE_ADMIN'] },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/contracts/documents/extract-text') {
    const fullText = '--- 第 1 页 ---\n合同编号：HT-2026-008\n项目名称：智慧政务履约平台建设合同\n甲方：杭州市大数据局\n乙方：善治数字科技有限公司\n合同总额：500000元';
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        fileName: 'HT-2026-008.pdf',
        pageCount: 1,
        totalChars: fullText.length,
        isScanned: false,
        scannedPageNumbers: [],
        pages: [{ page: 1, charCount: fullText.length, text: fullText }],
        fullText,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/contracts/validate') {
    const draft = JSON.parse(rawBody.toString('utf8'));
    const nodesSum = (draft.nodes || []).reduce((acc, n) => acc + Number(n.nodeAmount || 0), 0);
    const diff = Number(draft.totalAmount || 0) - nodesSum;
    const warnings = [];
    if (Math.abs(diff) > 0.01) warnings.push(`节点金额合计（${nodesSum}）与合同总额（${draft.totalAmount}）不一致`);
    const autoNumbered = !draft.contractNo;
    const year = typeof draft.signDate === 'string' ? draft.signDate.slice(0, 4) : '2026';
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        valid: warnings.length === 0,
        contractNoExists: false,
        autoNumbered,
        previewContractNo: autoNumbered ? `sz-${year}-0007` : null,
        previewContractNoHint: autoNumbered ? '预计编号，入库时确定' : null,
        totalAmount: draft.totalAmount,
        nodesAmountSum: nodesSum,
        amountMatched: Math.abs(diff) <= 0.01,
        amountDiff: diff,
        warnings,
        ...(String(draft.partyAName || '').includes('星河') ? { matchPreview: xingheMatchPreview() } : {}),
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/contracts') {
    const id = nextContractId++;
    if (legacyCreateResponse || url.searchParams.get('detail') !== 'true') {
      return sendJson(200, { code: 200, message: 'success', data: id });
    }
    const draft = JSON.parse(rawBody.toString('utf8'));
    const xinghe = String(draft.partyAName || '').includes('星河');
    const preview = xingheMatchPreview();
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        id,
        contractNo: draft.contractNo || `sz-2026-${String(id).padStart(4, '0')}`,
        externalContractNo: draft.externalContractNo || null,
        autoNumbered: !draft.contractNo,
        match: {
          engine: xinghe ? 'PARTY_FIFO' : 'LEGACY',
          moneyCount: xinghe ? 2 : 0,
          moneyTotal: xinghe ? 50000 : 0,
          invoiceCount: xinghe ? 1 : 0,
          invoiceTotal: xinghe ? 50000 : 0,
          overAllocated: false,
          adjustedContracts: xinghe ? preview.adjustedContracts : [],
          suspects: [],
          error: null,
        },
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/party-aliases') {
    const body = JSON.parse(rawBody.toString('utf8'));
    if (!body.aliasName || !body.canonicalName) {
      return sendJson(200, { code: 400, message: '户名不能为空', data: null });
    }
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        engine: 'PARTY_FIFO',
        parties: [XINGHE],
        adjustedContracts: [
          { contractId: 3, contractNo: 'sz-2026-0001', contractName: '星河数据平台二期', moneyBefore: 60000, moneyAfter: 90000, invoiceBefore: 0, invoiceAfter: 0 },
        ],
        allocations: [],
        overAllocatedContractIds: [],
      },
    });
  }

  if (req.method === 'POST' && /^\/api\/v1\/contracts\/\d+\/upload$/.test(url.pathname)) {
    if (failUploadWith401) return sendJson(401, { code: 401, message: '登录已过期，请重新登录', data: null });
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: { id: 501, contractId: 101, docType: 1, fileName: 'HT-2026-008.pdf', fileSize: 29 },
    });
  }

  if (req.method === 'POST' && /^\/api\/v1\/contracts\/\d+\/nodes\/\d+\/upload$/.test(url.pathname)) {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: { id: 601, contractId: 101, nodeId: 11, docType: 2, fileName: 'invoice-01.png', fileSize: 8 },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        records: [
          {
            id: 101,
            contractNo: 'HT-2026-008',
            contractName: '智慧政务履约平台建设合同',
            contractType: 1,
            partyAName: '杭州市大数据局',
            partyBName: '善治数字科技有限公司',
            totalAmount: 500000,
            invoicedAmount: 200000,
            paidAmount: 150000,
            overdueAmount: 50000,
            signDate: '2026-03-10',
            status: 1,
            businessOwnerName: '李销售',
            deliveryOwnerName: '王实施',
          },
        ],
        total: 1,
        current: 1,
        size: 20,
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/101') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        id: 101,
        contractNo: 'HT-2026-008',
        contractName: '智慧政务履约平台建设合同',
        contractType: 1,
        partyAName: '杭州市大数据局',
        partyBName: '善治数字科技有限公司',
        totalAmount: 500000,
        status: 1,
        signDate: '2026-03-10',
        nodes: [{ id: 11, nodeOrder: 1, nodeName: '首付款', nodeAmount: 200000, status: 1 }],
        documents: [
          { id: 501, contractId: 101, docType: 1, fileName: 'HT-2026-008.pdf', fileSize: 20480 },
          { id: 502, contractId: 101, nodeId: 11, docType: 2, fileName: 'bad-html.pdf', fileSize: 100 },
        ],
      },
    });
  }

  // 详情字段大量为 null、没有 nodes/documents 的合同。
  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/78') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        id: 78,
        contractNo: 'HT-2025-078',
        contractName: '历史合同（字段不全）',
        contractType: null,
        partyAName: null,
        partyBName: null,
        totalAmount: null,
        taxRate: null,
        signDate: null,
        status: null,
        businessOwnerName: null,
        nodes: null,
        documents: null,
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/dashboard/stats') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        totalAmount: 1200000,
        contractCount: 4,
        activeCount: 3,
        completedCount: 1,
        overdueCount: 1,
        receivedAmount: 650000,
        invoiceAmount: 800000,
        overdueAmount: 50000,
        overdueRate: 4.2,
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/dashboard/trends') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        signTrend: { '1': 100000, '3': 500000 },
        incomeTrend: { '2': 80000, '4': 150000 },
        expenseTrend: { '2': 56000, '4': 105000 },
        receivableTrend: { '4': 50000 },
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/transactions/upload') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        status: 'success',
        txnType: 0,
        parsedCount: 12,
        batchId: 33,
        matchResults: [{ transactionId: 901, contractId: 101, confidence: 0.98 }],
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/transactions/unmatched') {
    return sendJson(200, { code: 200, message: 'success', data: unmatchedRows });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/transactions/summary') {
    if (failSummaryWith401) return sendJson(401, { code: 401, message: '登录已过期，请重新登录', data: null });
    return sendJson(200, { code: 200, message: 'success', data: { totalCount: 12, unmatchedCount: 1 } });
  }

  if (req.method === 'POST' && /^\/api\/v1\/transactions\/\d+\/match$/.test(url.pathname)) {
    return sendJson(200, { code: 200, message: 'success', data: null });
  }

  if (req.method === 'POST' && /^\/api\/v1\/contracts\/nodes\/\d+\/manual-date$/.test(url.pathname)) {
    return sendJson(200, { code: 200, message: 'success', data: null });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/documents/501/download') {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(Buffer.from('%PDF-1.4\n% authentic contract document bytes'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/contracts/documents/502/download') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>Login Page</body></html>');
    return;
  }

  sendJson(404, { code: 404, message: `Not found: ${url.pathname}`, data: null });
});

let baseUrl;
let registeredTools;
let promptSections;
let appendedRecords;
let settingsTouched = false;
let hostCredentials;
let pluginInstance;
let remoteAccessAllowed = true;
let clockOffsetMs = 0;
const toolsWithLosslessOutput = new Set();

// 宿主 ctx.credentials 的内存替身（readRecord / modifyRecord / deleteRecord）。
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

async function waitForAuthorization(remote, requestId) {
  for (let i = 0; i < 500; i++) {
    const result = await remote.pollAuthorization(requestId);
    if (result.status !== 'pending') return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('授权结果一直是 pending');
}

const ADMIN_APPROVAL = {
  status: 'APPROVED',
  grantId: 501,
  expiresAt: '2099-02-22T10:00:00+08:00',
  user: { userId: 7, username: 'admin', realName: '张主管', deptName: '综合管理部' },
};

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  registeredTools = new Map();
  promptSections = [];
  appendedRecords = [];
  hostCredentials = memoryCredentials();

  const sessionEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, surfaceOp: 'append', data: { turn: 1, callId: 'call-stage-1', name: 'contract_stage_draft' } },
    { type: 'tool/call', seq: 5, surfaceOp: 'append', data: { turn: 1, callId: 'call-confirm-1', name: 'contract_confirm_save' } },
    { type: 'tool/call', seq: 8, surfaceOp: 'append', data: { turn: 1, callId: 'call-detail-1', name: 'contract_query' } },
  ];
  const mockSession = { snapshotEvents: () => [...sessionEvents, ...appendedRecords] };

  // 旧版本的明文配置：插件启动时应丢弃 apiToken、迁走 ocrApiKey。
  writeFileSync(
    configPath,
    JSON.stringify({ serverUrl: baseUrl, apiToken: 'legacy-token-without-jti', ocrApiKey: 'sk-legacy-ocr-0000' }),
    { mode: 0o600 },
  );

  const ctx = {
    tools: { register(def) { registeredTools.set(def.name, def); } },
    systemPrompt: { section(sec) { promptSections.push(sec); return () => {}; } },
    sessions: { get: (id) => (id === 'sess-1' ? mockSession : undefined) },
    remoteAccess: { allows: async () => remoteAccessAllowed },
    credentials: hostCredentials,
    // 插件不再读写宿主 settings：碰到就记下来，测试里断言没有碰过。
    get settings() {
      settingsTouched = true;
      return undefined;
    },
    get(svc) { return this[svc]; },
    effect() {},
  };

  pluginInstance = setupContractSure(ctx, {
    configPath,
    cachePath: (...segs) => join(cacheRoot, ...segs),
    appendPluginRecord: (_session, type, data) => {
      appendedRecords.push({ type, seq: 10 + appendedRecords.length, data });
    },
    hostname: () => 'test-host',
    now: () => Date.now() + clockOffsetMs,
    schedule: (fn) => setTimeout(fn, 2),
    cancelSchedule: (handle) => clearTimeout(handle),
  });
});

test.after(async () => {
  pluginInstance?.dispose();
  await new Promise((resolve) => server.close(resolve));
  rmSync(workDir, { recursive: true, force: true });
});

test('registers all 7 tools and systemPrompt section plugin:contract-sure (order 940)', () => {
  assert.deepEqual(
    [...registeredTools.keys()].sort(),
    [
      'contract_config',
      'contract_confirm_save',
      'contract_dashboard',
      'contract_manage_flow',
      'contract_query',
      'contract_read_document',
      'contract_stage_draft',
    ],
  );
  assert.equal(promptSections.length, 1);
  assert.equal(promptSections[0].name, 'plugin:contract-sure');
  assert.equal(promptSections[0].order, 940);
  const prompt = promptSections[0].text;
  assert.match(prompt, /contract_stage_draft/);
  assert.match(prompt, /import_excel/);
  assert.match(prompt, /query_result_chart/);
  assert.match(prompt, /contract-sure-auth-required/);
  assert.match(prompt, /甲方\/乙方名称/);
  assert.match(prompt, /不要自己用 curl/);
  // 不再有任何引导用户提供账号密码或用工具登录的说法。
  assert.doesNotMatch(prompt, /登录配置|提供.{0,6}密码|password/u);

  // contract_config 不再接受密码、令牌或任何修改配置的参数。
  const configTool = registeredTools.get('contract_config');
  assert.deepEqual(Object.keys(configTool.parameters.properties), ['action']);
  assert.deepEqual(configTool.parameters.properties.action.enum, ['get']);
  for (const def of registeredTools.values()) {
    assert.doesNotMatch(JSON.stringify(def.parameters), /password|apiToken|ocrApiKey/u);
  }
});

test('legacy plaintext secrets are scrubbed from the config file on startup; host settings are never touched', async () => {
  const state = await pluginInstance.remoteHandlers.getState();
  assert.equal(state.serverUrl, baseUrl);
  assert.equal(state.credentialStore, 'dsh-credentials');
  assert.equal(state.ocr.keyConfigured, true);
  assert.equal(state.ocr.keySource, 'credentials');
  assert.deepEqual(hostCredentials.records.get('contract-sure/ocr-api-key'), {
    kind: 'grant',
    payload: { version: 1, type: 'ocr-api-key', key: 'sk-legacy-ocr-0000', origin: 'https://api.deepseek.com' },
  });
  const fileText = readFileSync(configPath, 'utf8');
  assert.doesNotMatch(fileText, /apiToken|ocrApiKey|legacy-token|sk-legacy/u);
  // 第 1 条：宿主 settings 同步已删除。
  assert.equal(settingsTouched, false);
});

test('without an account every backend tool returns contract C instead of failing', async () => {
  const expected = {
    kind: 'contract-sure-auth-required',
    reason: 'no-account',
    serverUrl: baseUrl,
    message: '需要先连接履约系统账户：请点下方卡片的「连接账户」，在浏览器里完成授权后，回复「继续」。',
  };
  const before = requests.length;
  assert.deepEqual(await runTool('contract_query', { mode: 'list' }), expected);
  assert.deepEqual(await runTool('contract_query', { mode: 'detail', contractId: 78 }), expected);
  assert.deepEqual(await runTool('contract_dashboard', { year: 2026 }), expected);
  assert.deepEqual(await runTool('contract_manage_flow', { action: 'list_unmatched' }), expected);
  assert.deepEqual(await runTool('contract_read_document', { filePath: samplePdfPath }), expected);
  assert.deepEqual(
    await runTool('contract_stage_draft', { contractNo: 'X-1', contractName: '测试', contractType: 1, totalAmount: 1 }),
    expected,
  );
  assert.deepEqual(await runTool('contract_confirm_save', { draft: { contractNo: 'X-1', contractName: '测试' } }), expected);
  // 一个请求都没有发到后端。
  assert.equal(requests.length, before);

  const config = await runTool('contract_config', { action: 'get' });
  assert.deepEqual(config, {
    action: 'get',
    serverUrl: baseUrl,
    connected: false,
    account: null,
    accountCount: 0,
    message: '尚未连接履约系统账户，请在「设置 → 履约无忧配置」点「连接账户」完成浏览器授权。',
  });
  await assert.rejects(() => registeredTools.get('contract_config').execute({ action: 'set' }), /只支持查看连接状态/u);
});

test('browser authorization through the contractSure RPC handlers connects the account', async () => {
  const remote = pluginInstance.remoteHandlers;
  pollResponses = [{ status: 'PENDING' }, ADMIN_APPROVAL];
  const started = await remote.startAuthorization();
  assert.equal(started.userCode, 'ABCD-2345');
  assert.equal(started.verifyUrl, `${new URL(baseUrl).origin}/plugin-authorize?req=${started.requestId}`);
  const startReq = requests.findLast((r) => r.pathname === '/api/v1/auth/plugin-authorize/start');
  assert.deepEqual(JSON.parse(startReq.bodyText), { clientName: '小智办公 · 履约无忧', deviceName: 'test-host' });
  assert.equal(startReq.auth, '');

  const result = await waitForAuthorization(remote, started.requestId);
  assert.equal(result.status, 'approved');
  assert.equal(result.account.id, 'u7');
  assert.equal(result.state.activeAccountId, 'u7');
  assert.equal(result.state.accounts.length, 1);
  assert.equal(hostCredentials.records.get('contract-sure/account-7').payload.token, 'plugin-jwt-1');

  const state = await remote.getState();
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('plugin-jwt-1'));
  assert.ok(!serialized.includes('poll-'));
  assert.ok(!serialized.includes('sk-legacy-ocr-0000'));
  assert.ok(!readFileSync(configPath, 'utf8').includes('plugin-jwt-1'));

  const tested = await remote.testConnection();
  assert.equal(tested.ok, true);
  assert.deepEqual(tested.account, { userId: 7, username: 'admin', realName: '张主管', deptName: '综合管理部' });

  const config = await runTool('contract_config', {});
  assert.equal(config.connected, true);
  assert.deepEqual(config.account, { realName: '张主管', username: 'admin', status: 'ok' });
  assert.equal(config.accountCount, 1);
  assert.ok(!JSON.stringify(config).includes('plugin-jwt-1'));
});

test('contract_read_document extracts electronic PDF via backend text-layer endpoint', async () => {
  const res = await runTool('contract_read_document', { filePath: samplePdfPath });
  assert.equal(res.source, 'pdf-text-layer');
  assert.equal(res.isScanned, false);
  assert.match(res.text, /HT-2026-008/);
  const extractReq = requests.findLast((r) => r.pathname === '/api/v1/contracts/documents/extract-text');
  assert.equal(extractReq.auth, 'Bearer plugin-jwt-1');
});

test('contract_stage_draft validates draft, emits plugin record, and contract_confirm_save creates + archives original', async () => {
  const staged = await runTool(
    'contract_stage_draft',
    {
      contractNo: 'HT-2026-008',
      contractName: '智慧政务履约平台建设合同',
      contractType: 1,
      totalAmount: 500000,
      signDate: '2026-03-10',
      signDateNote: '签订日期有值时这条说明会被丢掉',
      partyAName: '杭州市大数据局',
      partyBName: '善治数字科技有限公司',
      sourceFilePath: samplePdfPath,
      nodes: [
        {
          nodeOrder: 1,
          nodeName: '首付款',
          nodeAmount: 200000,
          paymentCondition: '合同签订后10个工作日内支付40%',
          triggerRule: {
            triggerType: 'EVENT_OFFSET',
            triggerEvent: 'CONTRACT_SIGNED',
            offsetDays: 10,
            offsetType: 'WORKDAY',
            logic: 'SINGLE',
          },
        },
        {
          nodeOrder: 2,
          nodeName: '验收款',
          nodeAmount: 300000,
          paymentCondition: '终验通过且收到发票后15个工作日内',
          triggerRule: {
            triggerType: 'EVENT_OFFSET',
            logic: 'MAX',
            conditions: [
              { event: 'ACCEPTANCE_PASSED', offsetDays: 15, offsetType: 'WORKDAY' },
              { event: 'INVOICE_RECEIVED', offsetDays: 15, offsetType: 'WORKDAY' },
            ],
          },
        },
      ],
    },
    { agent: { id: 'sess-1' }, callId: 'call-stage-1' },
  );

  assert.equal(staged.kind, 'contract-sure-draft');
  assert.equal(staged.validation.valid, true);
  assert.equal(staged.validation.amountMatched, true);
  assert.equal(staged.signDateNote, null);
  assert.equal('signDateNote' in staged.draft, false);
  assert.doesNotMatch(staged.hint, /签订日期为空/);
  assert.ok(appendedRecords.some((r) => r.type === DRAFT_RECORD_TYPE && r.data.draftId === staged.draftId));

  // Confirm save creates contract and uploads original PDF
  const confirmed = await runTool(
    'contract_confirm_save',
    { draftId: staged.draftId },
    { agent: { id: 'sess-1' }, callId: 'call-confirm-1' },
  );
  assert.equal(confirmed.contractId, 101);
  assert.equal(confirmed.alreadyConfirmed, false);
  assert.equal(confirmed.uploadedDoc.fileName, 'HT-2026-008.pdf');
  assert.ok(appendedRecords.some((r) => r.type === DRAFT_CONFIRMED_RECORD_TYPE && r.data.contractId === 101));

  // Duplicate confirm is idempotent
  const duplicate = await runTool('contract_confirm_save', { draftId: staged.draftId }, { agent: { id: 'sess-1' } });
  assert.equal(duplicate.alreadyConfirmed, true);
  assert.equal(duplicate.contractId, 101);
});

test('contract_query (list & detail) and contract_dashboard return echarts-compatible rows and emit detail docs', async () => {
  const listRes = await runTool('contract_query', { mode: 'list', contractType: 1, pageNum: 1, pageSize: 20 });
  assert.equal(listRes.mode, 'list');
  assert.equal(listRes.rows.length, 1);
  assert.equal(listRes.rows[0]['合同编号'], 'HT-2026-008');
  // Cross-check compatibility directly against @local/datahub-echarts normalizeTable!
  const listTable = normalizeTable(listRes);
  assert.equal(listTable.data.length, 1);
  assert.ok(listTable.columns.some((c) => c.name === '合同总额（元）' && c.type === 'number'));

  const detailRes = await runTool(
    'contract_query',
    { mode: 'detail', contractId: 101 },
    { agent: { id: 'sess-1' }, callId: 'call-detail-1' },
  );
  assert.equal(detailRes.kind, 'contract-sure-detail');
  assert.equal(detailRes.documents.length, 2);
  assert.equal(detailRes.nodes.length, 1);
  // 合同对象里不再带 nodes / documents 键（图 1 的根因）。
  assert.equal('nodes' in detailRes.contract, false);
  assert.equal('documents' in detailRes.contract, false);
  assert.equal(detailRes.contract.statusLabel, '履约中');
  assert.ok(appendedRecords.some((r) => r.type === DETAIL_RECORD_TYPE && r.data.contractId === 101));

  const dashRes = await runTool('contract_dashboard', { contractType: 1, year: 2026 });
  assert.equal(dashRes.summary.totalAmount, 1200000);
  assert.equal(dashRes.rows.length, 12);
  assert.deepEqual(dashRes.columns, ['月份', '签约金额（元）', '收入金额（元）', '支出金额（元）', '逾期应收应付（元）']);
  assert.equal(dashRes.rows[2]['签约金额（元）'], 500000);
  const dashTable = normalizeTable(dashRes);
  assert.equal(dashTable.data.length, 12);

  // Verify event projection picks up draft, confirmation, and detail records cleanly
  const projected = projectEvents([{ type: 'turn/start', seq: 1, data: { turn: 1 } }, ...appendedRecords]);
  assert.equal(projected.drafts.length, 1);
  assert.equal(projected.confirmedByDraftId[projected.drafts[0].draftId].contractId, 101);
  assert.equal(projected.details.length, 1);
  assert.equal(projected.details[0].documents.length, 2);
});

test('合同编号可以留空：核对时给出预计编号和预匹配，入库后返回最终编号、匹配结果和顺带调整的合同', async () => {
  const staged = await runTool(
    'contract_stage_draft',
    {
      externalContractNo: ' XH-2026-042 ',
      contractName: '星河数据运维（4月）',
      contractType: 1,
      totalAmount: 50000,
      signDate: '2026-04-20',
      partyAName: XINGHE,
      partyBName: '善治数字科技（成都）有限公司',
    },
    { agent: { id: 'sess-1' }, callId: 'call-stage-auto' },
  );
  assert.equal(staged.draft.contractNo, '');
  assert.equal(staged.draft.externalContractNo, 'XH-2026-042');
  const validateReq = requests.findLast((r) => r.pathname === '/api/v1/contracts/validate');
  assert.equal(JSON.parse(validateReq.bodyText).externalContractNo, 'XH-2026-042');
  assert.match(staged.hint, /系统编号：预计 sz-2026-0007（入库时确定）。/u);
  assert.match(staged.hint, /预匹配（以入库结果为准）：收付款 2 笔 ¥50,000、发票 1 张 ¥50,000；入库后会顺带调整 1 份合同（sz-2026-0001）。/u);
  assert.match(staged.hint, /流水户名「星河数据」可能就是「北京星河数据有限公司」/u);

  const confirmed = await runTool(
    'contract_confirm_save',
    { draftId: staged.draftId },
    { agent: { id: 'sess-1' }, callId: 'call-confirm-auto' },
  );
  const createReq = requests.findLast((r) => r.pathname === '/api/v1/contracts' && r.method === 'POST');
  assert.equal(createReq.search, '?detail=true');
  assert.equal(JSON.parse(createReq.bodyText).contractNo, '');
  const expectedNo = `sz-2026-${String(confirmed.contractId).padStart(4, '0')}`;
  assert.equal(confirmed.contractNo, expectedNo);
  assert.equal(confirmed.externalContractNo, 'XH-2026-042');
  assert.equal(confirmed.autoNumbered, true);
  assert.equal(confirmed.match.moneyCount, 2);
  assert.deepEqual(confirmed.match.adjustedContracts.map((c) => c.contractNo), ['sz-2026-0001']);
  assert.equal(confirmed.matchText, '匹配收付款 2 笔 ¥50,000、发票 1 张 ¥50,000；顺带调整了 1 份合同（sz-2026-0001）');
  assert.equal(
    confirmed.message,
    `合同已成功创建（编号 ${expectedNo}，ID: #${confirmed.contractId}）。匹配收付款 2 笔 ¥50,000、发票 1 张 ¥50,000；顺带调整了 1 份合同（sz-2026-0001）。`,
  );
  const record = appendedRecords.findLast((r) => r.type === DRAFT_CONFIRMED_RECORD_TYPE);
  assert.equal(record.data.contractNo, expectedNo);
  assert.equal(record.data.matchText, confirmed.matchText);
  assertLossless(record.data, '入库记录');

  const again = await runTool('contract_confirm_save', { draftId: staged.draftId }, { agent: { id: 'sess-1' } });
  assert.equal(again.alreadyConfirmed, true);
  assert.equal(again.contractNo, expectedNo);
  assert.match(again.message, new RegExp(`编号 ${expectedNo}`, 'u'));
});

test('旧版后端创建合同只返回 ID 时照常入库，编号取草稿里填的', async () => {
  legacyCreateResponse = true;
  try {
    const staged = await runTool(
      'contract_stage_draft',
      { contractNo: 'HT-OLD-1', contractName: '旧后端合同', contractType: 2, totalAmount: 1000 },
      { agent: { id: 'sess-1' } },
    );
    const confirmed = await runTool('contract_confirm_save', { draftId: staged.draftId }, { agent: { id: 'sess-1' } });
    assert.equal(confirmed.contractNo, 'HT-OLD-1');
    assert.equal(confirmed.match, null);
    assert.equal(confirmed.matchText, '');
    assert.equal(confirmed.message, `合同已成功创建（编号 HT-OLD-1，ID: #${confirmed.contractId}）。`);
  } finally {
    legacyCreateResponse = false;
  }
});

test('核对卡改字段后重新校验、确认疑似同一家，都走会话内的 RPC；对话里也能确认户名', async () => {
  const handlers = pluginInstance.remoteHandlers;
  const staged = await runTool(
    'contract_stage_draft',
    { contractName: '星河数据运维', contractType: 1, totalAmount: 50000, signDate: '2026-04-20', partyAName: XINGHE, partyBName: '善治数字科技（成都）有限公司' },
    { agent: { id: 'sess-1' } },
  );

  const preview = await handlers.previewDraft('sess-1', staged.draftId, { ...staged.draft, signDate: '2025-12-30' });
  assertLossless(preview, 'previewDraft 的结果');
  assert.equal(preview.draftId, staged.draftId);
  assert.equal(preview.validation.previewContractNo, 'sz-2025-0007');
  assert.equal(JSON.parse(requests.findLast((r) => r.pathname === '/api/v1/contracts/validate').bodyText).signDate, '2025-12-30');
  // 草稿属于暂存它的会话。
  await assert.rejects(
    () => handlers.previewDraft('sess-2', staged.draftId, staged.draft),
    (err) => err.code === 'DRAFT_NOT_FOUND',
  );
  await assert.rejects(() => handlers.previewDraft('sess-1', staged.draftId, null), (err) => err.code === 'INVALID_REQUEST');

  const alias = await handlers.confirmPartyAlias('sess-1', ' 星河数据 ', XINGHE);
  assertLossless(alias, 'confirmPartyAlias 的结果');
  assert.deepEqual(JSON.parse(requests.findLast((r) => r.pathname === '/api/v1/party-aliases').bodyText), {
    aliasName: '星河数据',
    canonicalName: XINGHE,
  });
  assert.equal(alias.message, '已确认「星河数据」就是「北京星河数据有限公司」，以后按同一家匹配，顺带调整了 1 份合同（sz-2026-0001）。');
  await assert.rejects(() => handlers.confirmPartyAlias('sess-1', ' ', XINGHE), (err) => err.code === 'INVALID_REQUEST');

  const viaTool = await runTool('contract_manage_flow', { action: 'confirm_party_alias', aliasName: '星河数据', canonicalName: XINGHE });
  assert.equal(viaTool.action, 'confirm_party_alias');
  assert.equal(viaTool.ok, true);
  assert.equal(viaTool.adjustedContracts[0].moneyAfter, 90000);
  await assert.rejects(
    () => runTool('contract_manage_flow', { action: 'confirm_party_alias', aliasName: '星河数据' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
});

test('contract_stage_draft carries signDateNote to the card when the signing date is blank', async () => {
  const note = '乙方：2026 年【 】月 8 日，月份可能是手写数字没识别出来；甲方未填';
  const staged = await runTool(
    'contract_stage_draft',
    {
      contractNo: 'HT-2026-009',
      contractName: '签字页日期不全的合同',
      contractType: 1,
      totalAmount: 1000,
      signDate: null,
      signDateNote: `  ${note}  `,
      nodes: [{ nodeOrder: 1, nodeName: '全款', nodeAmount: 1000, paymentCondition: '验收后支付' }],
    },
    { agent: { id: 'sess-1' }, callId: 'call-stage-note' },
  );
  assert.equal(staged.draft.signDate, null);
  assert.equal('signDateNote' in staged.draft, false);
  assert.equal(staged.signDateNote, note);
  assert.match(staged.hint, /签订日期为空/);
  const record = appendedRecords.find((r) => r.type === DRAFT_RECORD_TYPE && r.data.draftId === staged.draftId);
  assert.equal(record.data.signDateNote, note);
});

test('contract_query detail with null fields (the 图1 case, contractId 78) is lossless', async () => {
  const detail = await runTool('contract_query', { mode: 'detail', contractId: 78 });
  assert.equal(detail.kind, 'contract-sure-detail');
  assert.deepEqual(detail.nodes, []);
  assert.deepEqual(detail.documents, []);
  assert.equal(detail.contract.id, 78);
  assert.equal(detail.contract.partyAName, null);
  assert.equal(detail.contract.totalAmount, null);
  assert.equal(detail.contract.contractTypeLabel, '');
  assert.deepEqual(Object.keys(detail.contract).filter((k) => k === 'nodes' || k === 'documents'), []);
});

test('contract_manage_flow executes all 5 deterministic actions cleanly', async () => {
  const imp = await runTool('contract_manage_flow', { action: 'import_excel', filePath: sampleExcelPath, txnType: 0 });
  assert.equal(imp.batchId, 33);
  assert.equal(imp.parsedCount, 12);
  assert.equal(imp.matchedCount, 1);

  const unmatched = await runTool('contract_manage_flow', { action: 'list_unmatched' });
  assert.equal(unmatched.count, 1);
  assert.equal(unmatched.total, 1);
  assert.equal(unmatched.hasMore, false);
  assert.equal(unmatched.nextOffset, null);
  assert.equal(unmatched.rows[0]['流水类型'], '付款流水');
  assert.equal(unmatched.rows[0]['合同编号'], '');
  assert.equal(normalizeTable(unmatched).data.length, 1);

  const match = await runTool('contract_manage_flow', { action: 'manual_match', transactionId: 902, contractId: 101, nodeId: 11 });
  assert.equal(match.ok, true);
  const matchReq = requests.findLast((r) => r.pathname === '/api/v1/transactions/902/match');
  assert.equal(matchReq.search, '?contractId=101&nodeId=11');

  const evidence = await runTool('contract_manage_flow', {
    action: 'upload_node_evidence',
    contractId: 101,
    nodeId: 11,
    filePath: sampleInvoicePath,
    docType: 2,
    amount: 200000,
    eventDate: '2026-04-01',
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.document.docType, 2);
  const uploadReq = requests.findLast((r) => r.pathname === '/api/v1/contracts/101/nodes/11/upload');
  assert.match(uploadReq.bodyText, /200000/);
  assert.match(uploadReq.bodyText, /2026-04-01/);

  const manualDate = await runTool('contract_manage_flow', {
    action: 'set_node_manual_date',
    contractId: 101,
    nodeId: 11,
    date: '2026-05-15',
    remark: '补充协议延期',
  });
  assert.equal(manualDate.ok, true);
  const dateReq = requests.findLast((r) => r.pathname === '/api/v1/contracts/nodes/11/manual-date');
  assert.deepEqual(JSON.parse(dateReq.bodyText), { contractId: 101, date: '2026-05-15', remark: '补充协议延期' });
});

test('list_unmatched pages with limit/offset and reports total, hasMore and nextOffset', async () => {
  unmatchedRows = Array.from({ length: 120 }, (_, i) => ({
    id: 1000 + i,
    txnType: i % 2 ? 2 : 3,
    txnDate: '2026-05-01',
    amount: 100 + i,
    counterparty: `对方单位${i}`,
    contractNo: null,
    description: `流水${i}`,
    matchStatus: 0,
  }));
  try {
    const first = await runTool('contract_manage_flow', { action: 'list_unmatched' });
    assert.equal(first.total, 120);
    assert.equal(first.rows.length, 50);
    assert.equal(first.limit, 50);
    assert.equal(first.offset, 0);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 50);
    assert.equal(first.rows[0]['流水ID'], 1000);
    assert.equal(normalizeTable(first).truncated, true);

    const last = await runTool('contract_manage_flow', { action: 'list_unmatched', offset: 100, limit: 50 });
    assert.equal(last.rows.length, 20);
    assert.equal(last.rows[0]['流水ID'], 1100);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextOffset, null);

    const capped = await runTool('contract_manage_flow', { action: 'list_unmatched', limit: 500 });
    assert.equal(capped.limit, 200);
    assert.equal(capped.rows.length, 120);
    assert.equal(capped.hasMore, false);

    const beyond = await runTool('contract_manage_flow', { action: 'list_unmatched', offset: 500 });
    assert.equal(beyond.rows.length, 0);
    assert.equal(beyond.hasMore, false);
  } finally {
    unmatchedRows = DEFAULT_UNMATCHED_ROWS;
  }
});

test('local files: only whitelisted regular files up to 20MB are uploaded or read', async () => {
  const uploadPath = '/api/v1/contracts/101/nodes/11/upload';
  const uploadsBefore = requests.filter((r) => r.pathname === uploadPath).length;
  const evidence = (filePath) =>
    registeredTools.get('contract_manage_flow').execute({
      action: 'upload_node_evidence',
      contractId: 101,
      nodeId: 11,
      filePath,
      docType: 2,
    });

  const yamlPath = join(workDir, 'credentials.yaml');
  writeFileSync(yamlPath, 'records:\n  token: secret\n');
  await assert.rejects(() => evidence(yamlPath), (err) => err.code === 'UNSUPPORTED_FORMAT');

  const txtPath = join(workDir, 'notes.txt');
  writeFileSync(txtPath, 'hello');
  await assert.rejects(() => evidence(txtPath), (err) => err.code === 'UNSUPPORTED_FORMAT');

  // 伪装成 PDF 的符号链接，指向白名单外的文件。
  const disguised = join(workDir, 'disguised.pdf');
  symlinkSync(yamlPath, disguised);
  await assert.rejects(() => evidence(disguised), (err) => err.code === 'UNSUPPORTED_FORMAT');

  const bigPath = join(workDir, 'big.pdf');
  writeFileSync(bigPath, '%PDF-1.4\n');
  truncateSync(bigPath, 20 * 1024 * 1024 + 1);
  await assert.rejects(() => evidence(bigPath), (err) => err.code === 'TOO_LARGE' && /20MB/u.test(err.message));

  const dirPath = join(workDir, 'folder.pdf');
  mkdirSync(dirPath);
  await assert.rejects(() => evidence(dirPath), (err) => err.code === 'INVALID_FILE');

  await assert.rejects(() => evidence(join(workDir, 'missing.pdf')), (err) => err.code === 'FILE_NOT_FOUND');

  // import_excel 只收 Excel。
  await assert.rejects(
    () => registeredTools.get('contract_manage_flow').execute({ action: 'import_excel', filePath: samplePdfPath, txnType: 0 }),
    (err) => err.code === 'UNSUPPORTED_FORMAT',
  );

  // 读取：目录、超限、白名单外都拒绝。
  const read = (filePath) => registeredTools.get('contract_read_document').execute({ filePath });
  await assert.rejects(() => read(dirPath), (err) => err.code === 'INVALID_FILE');
  await assert.rejects(() => read(bigPath), (err) => err.code === 'TOO_LARGE');
  await assert.rejects(() => read(yamlPath), (err) => err.code === 'UNSUPPORTED_FORMAT');

  assert.equal(requests.filter((r) => r.pathname === uploadPath).length, uploadsBefore);
});

test('remote preview handlers cache valid PDF, reject spoofed HTML, and enforce remoteAccess', async () => {
  const remote = pluginInstance.remoteHandlers;

  const cached = await remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf');
  assert.equal(cached.sessionId, 'sess-1');
  assert.equal(cached.documentName, 'HT-2026-008.pdf');
  assert.ok(existsSync(cached.absolutePath));
  assert.equal(readFileSync(cached.absolutePath).subarray(0, 5).toString('ascii'), '%PDF-');

  // Second call hits local cache without another HTTP request
  const beforeCount = requests.filter((r) => r.pathname === '/api/v1/contracts/documents/501/download').length;
  const cachedAgain = await remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf');
  const afterCount = requests.filter((r) => r.pathname === '/api/v1/contracts/documents/501/download').length;
  assert.equal(cachedAgain.absolutePath, cached.absolutePath);
  assert.equal(afterCount, beforeCount);

  // Spoofed HTML response rejected by magic-byte / content-type check
  await assert.rejects(
    () => remote.cacheOriginalDocument('sess-1', 502, 'bad-html.pdf'),
    (err) => err.code === 'DOWNLOAD_FAILED',
  );

  // Remote access denial
  remoteAccessAllowed = false;
  try {
    await assert.rejects(
      () => remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf'),
      (err) => err.code === 'ACCESS_DENIED',
    );
    await assert.rejects(
      () => remote.confirmDraft('sess-1', 'draft_x', null),
      (err) => err.code === 'ACCESS_DENIED',
    );
  } finally {
    remoteAccessAllowed = true;
  }

  // 拿不到 remoteAccess 服务时一律拒绝（不再放行）。
  const noAccessCtx = { get: () => undefined };
  await assert.rejects(
    () => remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf', undefined, noAccessCtx),
    (err) => err.code === 'ACCESS_DENIED',
  );
  await assert.rejects(
    () => remote.confirmDraft('sess-1', 'draft_x', null, undefined, noAccessCtx),
    (err) => err.code === 'ACCESS_DENIED',
  );
});

async function reauthorizeAdmin(remote) {
  pollResponses = [ADMIN_APPROVAL];
  const started = await remote.startAuthorization();
  const result = await waitForAuthorization(remote, started.requestId);
  assert.equal(result.status, 'approved');
  return result;
}

test('switching accounts isolates the preview cache and staged drafts', async () => {
  const remote = pluginInstance.remoteHandlers;
  const downloads = () => requests.filter((r) => r.pathname === '/api/v1/contracts/documents/501/download').length;
  const underAdmin = await remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf');

  // 用 u7 暂存一份草稿（原件是 .txt：顺带提示不能归档）。
  const txtSource = join(workDir, 'contract-text-only.txt');
  writeFileSync(txtSource, '合同编号：HT-2026-777');
  const staged = await runTool(
    'contract_stage_draft',
    { contractNo: 'HT-2026-777', contractName: '切换账户测试合同', contractType: 1, totalAmount: 1000, sourceFilePath: txtSource },
    { agent: { id: 'sess-1' }, callId: 'call-stage-switch' },
  );
  assert.match(staged.hint, /\.txt 格式.*不会归档/u);

  // 连接第二个账户 u8，成为当前账户。
  pollResponses = [{ ...ADMIN_APPROVAL, grantId: 502, user: { userId: 8, username: 'auditor', realName: '李审计', deptName: '审计部' } }];
  const started = await remote.startAuthorization();
  const connected = await waitForAuthorization(remote, started.requestId);
  assert.equal(connected.state.activeAccountId, 'u8');

  // 原件缓存按账户分开：u8 拿不到 u7 的缓存，要用自己的令牌重新下载。
  const before = downloads();
  const underAuditor = await remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf');
  assert.notEqual(underAuditor.absolutePath, underAdmin.absolutePath);
  assert.equal(downloads(), before + 1);
  assert.equal(requests.findLast((r) => r.pathname === '/api/v1/contracts/documents/501/download').auth, `Bearer plugin-jwt-${issuedTokenCount}`);

  // u7 暂存的草稿不能用 u8 入库，也不沿用旧原件。
  const createsBefore = requests.filter((r) => r.method === 'POST' && r.pathname === '/api/v1/contracts').length;
  await assert.rejects(
    () => registeredTools.get('contract_confirm_save').execute({ draftId: staged.draftId }, { agent: { id: 'sess-1' } }),
    (err) => err.code === 'ACCOUNT_SWITCHED' && /账户已切换，请重新核对/u.test(err.message),
  );
  await assert.rejects(
    () => remote.confirmDraft('sess-1', staged.draftId, null),
    (err) => err.code === 'ACCOUNT_SWITCHED' && /账户已切换，请重新核对/u.test(err.message),
  );
  // 草稿也只属于暂存它的会话。
  await assert.rejects(
    () => registeredTools.get('contract_confirm_save').execute({ draftId: staged.draftId }, { agent: { id: 'sess-2' } }),
    (err) => err.code === 'DRAFT_NOT_FOUND',
  );
  assert.equal(requests.filter((r) => r.method === 'POST' && r.pathname === '/api/v1/contracts').length, createsBefore);

  // 切回 u7、断开 u8，后面的用例照旧用 u7。
  await remote.setActiveAccount('u7');
  const disconnected = await remote.disconnectAccount('u8');
  assert.equal(disconnected.revoked, true);
  assert.deepEqual(disconnected.accounts.map((a) => a.id), ['u7']);
  assert.equal((await remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf')).absolutePath, underAdmin.absolutePath);
});

test('a 401 from a sub-request marks the account: summary → contract C; original upload after creation → contract ID + re-authorize then upload', async () => {
  const remote = pluginInstance.remoteHandlers;

  // 汇总接口 401（流水列表本身成功）：整个调用返回授权提示，账户标成失效。
  failSummaryWith401 = true;
  try {
    const listed = await runTool('contract_manage_flow', { action: 'list_unmatched' });
    assert.equal(listed.kind, 'contract-sure-auth-required');
    assert.equal(listed.reason, 'revoked');
  } finally {
    failSummaryWith401 = false;
  }
  assert.equal((await remote.getState()).accounts[0].status, 'revoked');
  // 已失效：不再拿旧令牌请求后端。
  const before = requests.length;
  assert.equal((await runTool('contract_dashboard', { year: 2026 })).reason, 'revoked');
  assert.equal(requests.length, before);
  await reauthorizeAdmin(remote);

  // 合同已创建、归档原件时 401：返回合同 ID，提示重新授权后补传，账户标成失效。
  const staged = await runTool(
    'contract_stage_draft',
    { contractNo: 'HT-2026-401', contractName: '归档失败测试合同', contractType: 1, totalAmount: 1000, sourceFilePath: samplePdfPath },
    { agent: { id: 'sess-1' }, callId: 'call-stage-401' },
  );
  failUploadWith401 = true;
  let confirmed;
  try {
    confirmed = await runTool('contract_confirm_save', { draftId: staged.draftId }, { agent: { id: 'sess-1' } });
  } finally {
    failUploadWith401 = false;
  }
  assert.equal(confirmed.kind, 'contract-sure-confirmed');
  assert.ok(Number.isInteger(confirmed.contractId));
  assert.equal(confirmed.uploadedDoc, null);
  assert.match(confirmed.uploadWarning, new RegExp(`#${confirmed.contractId}.*重新授权后补传`, 'u'));
  assert.equal(confirmed.message, confirmed.uploadWarning);
  assert.equal((await remote.getState()).accounts[0].status, 'revoked');
  await reauthorizeAdmin(remote);
});

test('HTTP 503 from the backend is an ordinary tool error, not contract C, and the account stays connected', async () => {
  serviceUnavailable = true;
  try {
    await assert.rejects(
      () => registeredTools.get('contract_query').execute({ mode: 'list' }, {}),
      (err) => err.code === 'SERVER_ERROR' && /暂时不可用（HTTP 503）/u.test(err.message),
    );
    await assert.rejects(
      () => pluginInstance.remoteHandlers.cacheOriginalDocument('sess-1', 501, 'fresh-503.pdf'),
      (err) => err.code === 'DOWNLOAD_FAILED',
    );
  } finally {
    serviceUnavailable = false;
  }
  assert.equal((await pluginInstance.remoteHandlers.getState()).accounts[0].status, 'ok');
  assert.equal((await runTool('contract_query', { mode: 'list' })).mode, 'list');
});

test('backend 401 returns contract C, marks the account revoked, and re-authorizing the same user recovers', async () => {
  const remote = pluginInstance.remoteHandlers;
  validTokens.clear(); // 后端吊销了令牌

  const res = await runTool('contract_query', { mode: 'list' });
  assert.equal(res.kind, 'contract-sure-auth-required');
  assert.equal(res.reason, 'revoked');
  assert.equal(res.serverUrl, baseUrl);
  assert.match(res.message, /张主管/u);
  assert.equal((await remote.getState()).accounts[0].status, 'revoked');
  assert.equal((await runTool('contract_config', {})).connected, false);

  // 预览走 RPC：账户已失效时返回 UNAUTHORIZED，即使这份原件之前已经缓存过，也不再直接给出缓存。
  const downloadsBefore = requests.filter((r) => r.pathname === '/api/v1/contracts/documents/501/download').length;
  await assert.rejects(
    () => remote.cacheOriginalDocument('sess-1', 501, 'HT-2026-008.pdf'),
    (err) => err.code === 'UNAUTHORIZED',
  );
  assert.equal(requests.filter((r) => r.pathname === '/api/v1/contracts/documents/501/download').length, downloadsBefore);

  pollResponses = [ADMIN_APPROVAL];
  const started = await remote.startAuthorization();
  const result = await waitForAuthorization(remote, started.requestId);
  assert.equal(result.status, 'approved');
  assert.equal(result.state.accounts.length, 1);
  assert.equal(result.state.accounts[0].status, 'ok');
  assert.equal((await runTool('contract_query', { mode: 'list' })).mode, 'list');

  // 令牌到期：不打后端，直接返回 expired。
  clockOffsetMs = 200 * 365 * 24 * 3600 * 1000;
  try {
    const before = requests.length;
    const expired = await runTool('contract_dashboard', { year: 2026 });
    assert.equal(expired.kind, 'contract-sure-auth-required');
    assert.equal(expired.reason, 'expired');
    assert.equal(requests.length, before);
  } finally {
    clockOffsetMs = 0;
  }
});

test('every one of the 7 tools produced lossless output', () => {
  assert.deepEqual([...toolsWithLosslessOutput].sort(), [...registeredTools.keys()].sort());
  assert.equal(isLosslessJson({ broken: undefined }), false);
});

test('event-projection handles surfaceOp replace invalidation and TypertRemoteService registration works with mock protocol', async () => {
  const projected = projectEvents([
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    {
      type: DRAFT_RECORD_TYPE,
      seq: 3,
      data: { turn: 2, callSeq: 2, draftId: 'draft_replaced', draft: { contractNo: 'OLD' }, validation: { valid: true } },
    },
    { type: 'system/message', seq: 4, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, data: { turn: 2 } },
    {
      type: DRAFT_RECORD_TYPE,
      seq: 6,
      data: { turn: 2, callSeq: 5, draftId: 'draft_kept', draft: { contractNo: 'NEW' }, validation: { valid: true } },
    },
  ]);
  assert.equal(projected.drafts.length, 1);
  assert.equal(projected.drafts[0].draftId, 'draft_kept');

  // Verify TypertRemoteService class decoration & registration
  const pluginsRegistered = [];
  const decoratedMethods = [];
  class MockTypertRemoteService {
    constructor(ctx, serviceName) {
      this.ctx = ctx;
      this.serviceName = serviceName;
    }
  }
  // Match real @deepseek-ai/dsh-typert-protocol Remote overloads (rejects empty options `{}`)
  const MockRemote = (methodExportOrOptions, context) => {
    if (typeof methodExportOrOptions === 'string') {
      return (_fn, ctx) => {
        decoratedMethods.push({ name: ctx.name, meta: { name: methodExportOrOptions } });
        ctx.addInitializer(() => {});
      };
    }
    if (typeof methodExportOrOptions === 'object' && methodExportOrOptions !== null) {
      const keys = Reflect.ownKeys(methodExportOrOptions);
      if (keys.length === 0) {
        throw new TypeError('typert-protocol: Remote options require name, mode: "stream", or resources');
      }
      return (_fn, ctx) => {
        decoratedMethods.push({ name: ctx.name, meta: methodExportOrOptions });
        ctx.addInitializer(() => {});
      };
    }
    if (context === undefined) {
      throw new TypeError('typert-protocol: Remote decorator context is missing');
    }
    decoratedMethods.push({ name: context.name, meta: null, fn: methodExportOrOptions });
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
  const second = setupContractSure(mockCtx, {
    configPath,
    typert: { TypertRemoteService: MockTypertRemoteService, Remote: MockRemote, RemoteError: MockRemoteError },
  });
  try {
    assert.equal(pluginsRegistered.length, 1);
    // 约定 B 的形参名就是 RPC args 的键名，最后一个形参叫 signal。
    const params = (fn) => fn.toString().match(/^async\s+\w+\(([^)]*)\)/u)[1].split(',').map((p) => p.trim()).filter(Boolean);
    assert.deepEqual(
      decoratedMethods.map((m) => m.name).sort(),
      [
        'cacheOriginalDocument',
        'cancelAuthorization',
        'confirmDraft',
        'confirmPartyAlias',
        'disconnectAccount',
        'getState',
        'pollAuthorization',
        'previewDraft',
        'saveSettings',
        'setActiveAccount',
        'startAuthorization',
        'testConnection',
      ],
    );
    // 带 resources 的方法同样按形参名取 args：会话标识在第一个，最后一个形参叫 signal。
    const withResources = decoratedMethods.filter((m) => m.meta && m.meta.resources).map((m) => m.name).sort();
    assert.deepEqual(withResources, ['cacheOriginalDocument', 'confirmDraft', 'confirmPartyAlias', 'previewDraft']);
    const proto = pluginsRegistered[0].prototype;
    assert.deepEqual(params(proto.previewDraft), ['sessionId', 'draftId', 'editedDraft', 'signal']);
    assert.deepEqual(params(proto.confirmPartyAlias), ['sessionId', 'aliasName', 'canonicalName', 'signal']);
    const plain = Object.fromEntries(decoratedMethods.filter((m) => m.fn).map((m) => [m.name, params(m.fn)]));
    assert.deepEqual(plain, {
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
    assert.equal(instance.serviceName, 'contractSure');
    const state = await instance.getState();
    assert.equal(state.serverUrl, baseUrl);
    // 这个 ctx 没有凭据服务：退回文件存储。
    assert.equal(state.credentialStore, 'file');
    assert.ok(!JSON.stringify(state).includes('plugin-jwt'));
    await assert.rejects(
      () => instance.saveSettings({ serverUrl: 'http://other.test/api/v1' }),
      (err) => err.message === '更换服务器地址前需要先断开全部账户',
    );
  } finally {
    second.dispose();
  }
});

test('RPC errors carry a fixed code and a safe message, never the underlying exception text', async () => {
  const failing = (error) => async () => {
    throw error;
  };
  const handlers = createContractSureRemoteHandlers(
    { get: () => undefined },
    {
      accounts: {
        getState: failing(new Error('EACCES /Users/x/.dsh/.credentials.yaml token=plugin-jwt-secret')),
        saveSettings: failing(new ApiError('服务器地址不能包含用户名或密码。', { code: 'INVALID_URL' })),
        testConnection: failing(Object.assign(new ApiError('x', { code: 409 }), { message: '固定文案' })),
      },
    },
  );
  await assert.rejects(
    () => handlers.getState(),
    (err) => err.code === 'INTERNAL_ERROR' && err.message === '操作失败，请稍后重试' && !/EACCES|plugin-jwt/u.test(err.message),
  );
  await assert.rejects(() => handlers.saveSettings({}), (err) => err.code === 'INVALID_URL' && err.message === '服务器地址不能包含用户名或密码。');
  // 非字符串错误码统一成 API_ERROR。
  await assert.rejects(() => handlers.testConnection(), (err) => err.code === 'API_ERROR');
});
