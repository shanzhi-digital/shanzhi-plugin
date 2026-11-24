import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupContractSure } from './index.js';
import { projectEvents, DRAFT_RECORD_TYPE, DRAFT_CONFIRMED_RECORD_TYPE, DETAIL_RECORD_TYPE } from './event-projection.js';
import { normalizeTable } from '../datahub-echarts/results.js';

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
const VALID_TOKEN = 'plugin-jwt-token-90d';

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

  if (req.method === 'POST' && url.pathname === '/api/v1/auth/plugin-token') {
    const body = JSON.parse(rawBody.toString('utf8'));
    if (body.username === 'admin' && body.password === 'secret123') {
      return sendJson(200, {
        code: 200,
        message: 'success',
        data: {
          token: VALID_TOKEN,
          userId: 7,
          username: 'admin',
          realName: '张主管',
          expiresInDays: body.ttlDays || 90,
        },
      });
    }
    return sendJson(200, { code: 401, message: '用户名或密码错误', data: null });
  }

  // All other endpoints require valid Bearer token
  if (auth !== `Bearer ${VALID_TOKEN}`) {
    return sendJson(401, { code: 401, message: '未登录或令牌已过期', data: null });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: { id: 7, username: 'admin', realName: '张主管', deptId: 1, postType: 1, roleKeys: ['ROLE_ADMIN'] },
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
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: {
        valid: warnings.length === 0,
        contractNoExists: false,
        totalAmount: draft.totalAmount,
        nodesAmountSum: nodesSum,
        amountMatched: Math.abs(diff) <= 0.01,
        amountDiff: diff,
        warnings,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/contracts') {
    const id = nextContractId++;
    return sendJson(200, { code: 200, message: 'success', data: id });
  }

  if (req.method === 'POST' && /^\/api\/v1\/contracts\/\d+\/upload$/.test(url.pathname)) {
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
    return sendJson(200, {
      code: 200,
      message: 'success',
      data: [
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
      ],
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/transactions/summary') {
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
let hostSettingsData;
let pluginInstance;
let remoteAccessAllowed = true;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  registeredTools = new Map();
  promptSections = [];
  appendedRecords = [];
  hostSettingsData = {};

  const sessionEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, surfaceOp: 'append', data: { turn: 1, callId: 'call-stage-1', name: 'contract_stage_draft' } },
    { type: 'tool/call', seq: 5, surfaceOp: 'append', data: { turn: 1, callId: 'call-confirm-1', name: 'contract_confirm_save' } },
    { type: 'tool/call', seq: 8, surfaceOp: 'append', data: { turn: 1, callId: 'call-detail-1', name: 'contract_query' } },
  ];
  const mockSession = { snapshotEvents: () => [...sessionEvents, ...appendedRecords] };

  const ctx = {
    tools: { register(def) { registeredTools.set(def.name, def); } },
    systemPrompt: { section(sec) { promptSections.push(sec); return () => {}; } },
    sessions: { get: (id) => (id === 'sess-1' ? mockSession : undefined) },
    remoteAccess: { allows: async () => remoteAccessAllowed },
    settings: {
      register(def) { hostSettingsData[def.namespace] = { ...def.defaults }; return () => {}; },
      set(ns, val) { hostSettingsData[ns] = { ...val }; },
      get(ns) { return hostSettingsData[ns]; },
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
  assert.match(promptSections[0].text, /contract_stage_draft/);
  assert.match(promptSections[0].text, /import_excel/);
  assert.match(promptSections[0].text, /query_result_chart/);
});

test('contract_config supports login, get (masked), set, test, and syncs local file + host settings', async () => {
  const tool = registeredTools.get('contract_config');

  const loginRes = await tool.execute({
    action: 'login',
    serverUrl: baseUrl,
    username: 'admin',
    password: 'secret123',
    ttlDays: 90,
  });
  assert.equal(loginRes.ok, true);
  assert.equal(loginRes.realName, '张主管');
  assert.equal(loginRes.expiresInDays, 90);
  assert.equal(loginRes.config.apiTokenConfigured, true);
  assert.ok(!JSON.stringify(loginRes).includes(VALID_TOKEN));

  // Verify persisted locally & synced to host settings
  const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(persisted.apiToken, VALID_TOKEN);
  assert.equal(hostSettingsData['contract-sure'].apiToken, VALID_TOKEN);

  const testRes = await tool.execute({ action: 'test' });
  assert.equal(testRes.connected, true);
  assert.equal(testRes.user.username, 'admin');

  const getRes = await tool.execute({ action: 'get' });
  assert.equal(getRes.config.serverUrl, baseUrl);
  assert.equal(getRes.config.apiTokenConfigured, true);
});

test('contract_read_document extracts electronic PDF via backend text-layer endpoint', async () => {
  const tool = registeredTools.get('contract_read_document');
  const res = await tool.execute({ filePath: samplePdfPath });
  assert.equal(res.source, 'pdf-text-layer');
  assert.equal(res.isScanned, false);
  assert.match(res.text, /HT-2026-008/);
});

test('contract_stage_draft validates draft, emits plugin record, and contract_confirm_save creates + archives original', async () => {
  const stageTool = registeredTools.get('contract_stage_draft');
  const confirmTool = registeredTools.get('contract_confirm_save');

  const staged = await stageTool.execute(
    {
      contractNo: 'HT-2026-008',
      contractName: '智慧政务履约平台建设合同',
      contractType: 1,
      totalAmount: 500000,
      signDate: '2026-03-10',
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
  assert.ok(appendedRecords.some((r) => r.type === DRAFT_RECORD_TYPE && r.data.draftId === staged.draftId));

  // Confirm save creates contract and uploads original PDF
  const confirmed = await confirmTool.execute(
    { draftId: staged.draftId },
    { agent: { id: 'sess-1' }, callId: 'call-confirm-1' },
  );
  assert.equal(confirmed.contractId, 101);
  assert.equal(confirmed.alreadyConfirmed, false);
  assert.equal(confirmed.uploadedDoc.fileName, 'HT-2026-008.pdf');
  assert.ok(appendedRecords.some((r) => r.type === DRAFT_CONFIRMED_RECORD_TYPE && r.data.contractId === 101));

  // Duplicate confirm is idempotent
  const duplicate = await confirmTool.execute({ draftId: staged.draftId }, { agent: { id: 'sess-1' } });
  assert.equal(duplicate.alreadyConfirmed, true);
  assert.equal(duplicate.contractId, 101);
});

test('contract_query (list & detail) and contract_dashboard return echarts-compatible rows and emit detail docs', async () => {
  const queryTool = registeredTools.get('contract_query');
  const dashTool = registeredTools.get('contract_dashboard');

  const listRes = await queryTool.execute({ mode: 'list', contractType: 1, pageNum: 1, pageSize: 20 });
  assert.equal(listRes.mode, 'list');
  assert.equal(listRes.rows.length, 1);
  assert.equal(listRes.rows[0]['合同编号'], 'HT-2026-008');
  // Cross-check compatibility directly against @local/datahub-echarts normalizeTable!
  const listTable = normalizeTable(listRes);
  assert.equal(listTable.data.length, 1);
  assert.ok(listTable.columns.some((c) => c.name === '合同总额（元）' && c.type === 'number'));

  const detailRes = await queryTool.execute(
    { mode: 'detail', contractId: 101 },
    { agent: { id: 'sess-1' }, callId: 'call-detail-1' },
  );
  assert.equal(detailRes.kind, 'contract-sure-detail');
  assert.equal(detailRes.documents.length, 2);
  assert.ok(appendedRecords.some((r) => r.type === DETAIL_RECORD_TYPE && r.data.contractId === 101));

  const dashRes = await dashTool.execute({ contractType: 1, year: 2026 });
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

test('contract_manage_flow executes all 5 deterministic actions cleanly', async () => {
  const flowTool = registeredTools.get('contract_manage_flow');

  const imp = await flowTool.execute({ action: 'import_excel', filePath: sampleExcelPath, txnType: 0 });
  assert.equal(imp.batchId, 33);
  assert.equal(imp.parsedCount, 12);
  assert.equal(imp.matchedCount, 1);

  const unmatched = await flowTool.execute({ action: 'list_unmatched' });
  assert.equal(unmatched.count, 1);
  assert.equal(unmatched.rows[0]['流水类型'], '付款流水');
  assert.equal(normalizeTable(unmatched).data.length, 1);

  const match = await flowTool.execute({ action: 'manual_match', transactionId: 902, contractId: 101, nodeId: 11 });
  assert.equal(match.ok, true);
  const matchReq = requests.findLast((r) => r.pathname === '/api/v1/transactions/902/match');
  assert.equal(matchReq.search, '?contractId=101&nodeId=11');

  const evidence = await flowTool.execute({
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

  const manualDate = await flowTool.execute({
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
  } finally {
    remoteAccessAllowed = true;
  }
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
    decoratedMethods.push({ name: context.name, meta: null });
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
  setupContractSure(mockCtx, {
    configPath,
    typert: { TypertRemoteService: MockTypertRemoteService, Remote: MockRemote, RemoteError: MockRemoteError },
  });
  assert.equal(pluginsRegistered.length, 1);
  assert.deepEqual(
    decoratedMethods.map((m) => m.name).sort(),
    ['cacheOriginalDocument', 'confirmDraft', 'getConfig', 'loginToken', 'saveConfig', 'testConnection'],
  );
  const instance = new pluginsRegistered[0](mockCtx);
  assert.equal(instance.serviceName, 'contractSure');
  const cfg = await instance.getConfig();
  assert.equal(cfg.serverUrl, baseUrl);
});

