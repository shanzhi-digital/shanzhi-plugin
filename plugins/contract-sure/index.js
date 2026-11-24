import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, maskConfig, registerSettingsSync } from './config-store.js';
import { ApiError, defaultApiClient } from './api-client.js';
import { readDocument } from './doc-reader.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, CONTRACT_SURE_PROMPT } from './prompts.js';
import {
  DRAFT_RECORD_TYPE,
  DRAFT_CONFIRMED_RECORD_TYPE,
  DETAIL_RECORD_TYPE,
} from './event-projection.js';
import { registerContractSureRemote } from './preview-service.js';

// Optional DSH host packages loaded dynamically so standalone Node tests run with zero npm dependencies.
let hostAppendPluginRecord = null;
let hostTypert = null;
let hostDshCachePath = null;

try {
  const sessionMod = await import('@deepseek-ai/dsh-session');
  hostAppendPluginRecord = sessionMod.appendPluginRecord || null;
} catch {
  // Running outside DSH host (e.g. unit tests or standalone CLI).
}

try {
  const typertMod = await import('@deepseek-ai/dsh-typert-protocol');
  if (typertMod.TypertRemoteService && typertMod.Remote && typertMod.RemoteError) {
    hostTypert = {
      TypertRemoteService: typertMod.TypertRemoteService,
      Remote: typertMod.Remote,
      RemoteError: typertMod.RemoteError,
    };
  }
} catch {
  // Running outside DSH host.
}

try {
  const pathsMod = await import('@deepseek-ai/dsh-home-paths');
  hostDshCachePath = pathsMod.dshCachePath || null;
} catch {
  // Running outside DSH host.
}

export const name = '@local/contract-sure';
export const description = '履约无忧智能合同履约助手（合同识别入库、三流核对、看板分析与原件预览）';
export const inject = ['tools'];

const MAX_STAGED_DRAFTS = 200;
const MAX_READ_TEXT_CHARS = 120_000;

const CONTRACT_TYPE_LABELS = Object.freeze({
  1: '销售合同',
  2: '采购合同',
});

const CONTRACT_STATUS_LABELS = Object.freeze({
  0: '草稿',
  1: '履约中',
  2: '已完成',
  3: '已终止',
});

const DOC_TYPE_LABELS = Object.freeze({
  1: '合同原件',
  2: '发票',
  3: '收付款凭证',
  4: '验收材料',
});

const TXN_TYPE_LABELS = Object.freeze({
  0: '自动识别收付款',
  1: '发票',
  2: '收款流水',
  3: '付款流水',
});

const MATCH_STATUS_LABELS = Object.freeze({
  0: '未匹配',
  1: '自动匹配',
  2: '人工确认',
  3: '人工调整',
});

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeTriggerRule(rule) {
  if (rule === null || rule === undefined || rule === '') return null;
  if (typeof rule === 'string') {
    const trimmed = rule.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : trimmed;
    } catch {
      return trimmed;
    }
  }
  if (typeof rule === 'object') return rule;
  return null;
}

export function normalizeContractDraft(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const nodes = Array.isArray(src.nodes)
    ? src.nodes.map((node, index) => {
        const item = node && typeof node === 'object' ? node : {};
        const triggerRule = normalizeTriggerRule(item.triggerRule);
        return {
          ...(item.id != null ? { id: item.id } : {}),
          nodeOrder: Number.isInteger(item.nodeOrder) ? item.nodeOrder : index + 1,
          nodeName: typeof item.nodeName === 'string' ? item.nodeName.trim() : `第${index + 1}期款`,
          nodeAmount: toFiniteNumber(item.nodeAmount),
          ...(item.nodeRatio != null ? { nodeRatio: toFiniteNumber(item.nodeRatio) } : {}),
          plannedDate: typeof item.plannedDate === 'string' && item.plannedDate.trim() ? item.plannedDate.trim() : null,
          paymentCondition: typeof item.paymentCondition === 'string' ? item.paymentCondition.trim() : '',
          ...(triggerRule != null ? { triggerRule } : {}),
          ...(item.stopDetection != null ? { stopDetection: item.stopDetection } : {}),
          ...(item.status != null ? { status: item.status } : {}),
        };
      })
    : [];

  return {
    contractNo: typeof src.contractNo === 'string' ? src.contractNo.trim() : '',
    contractName: typeof src.contractName === 'string' ? src.contractName.trim() : '',
    contractType: src.contractType != null ? Number(src.contractType) : 1,
    totalAmount: toFiniteNumber(src.totalAmount),
    ...(src.taxRate != null ? { taxRate: toFiniteNumber(src.taxRate) } : {}),
    signDate: typeof src.signDate === 'string' && src.signDate.trim() ? src.signDate.trim() : null,
    ...(src.startDate ? { startDate: String(src.startDate).trim() } : {}),
    ...(src.endDate ? { endDate: String(src.endDate).trim() } : {}),
    partyAName: typeof src.partyAName === 'string' ? src.partyAName.trim() : '',
    partyBName: typeof src.partyBName === 'string' ? src.partyBName.trim() : '',
    ...(src.businessOwnerId != null ? { businessOwnerId: Number(src.businessOwnerId) } : {}),
    ...(src.deliveryOwnerId != null ? { deliveryOwnerId: Number(src.deliveryOwnerId) } : {}),
    ...(src.deptId != null ? { deptId: Number(src.deptId) } : {}),
    ...(src.status != null ? { status: Number(src.status) } : {}),
    nodes,
  };
}

function getHostService(ctx, svcName) {
  if (!ctx) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(svcName);
  return ctx[svcName];
}

function resolveSessionContext(ctx, sessionId, callId) {
  const sessions = getHostService(ctx, 'sessions');
  if (!sessions || !sessionId) return { session: null, turn: null, callSeq: null };
  const session = sessions.get?.(sessionId) || null;
  if (!session || typeof session.snapshotEvents !== 'function') {
    return { session, turn: null, callSeq: null };
  }
  const events = session.snapshotEvents();
  const callEvent = callId
    ? events.findLast?.((ev) => ev.type === 'tool/call' && ev.data?.callId === callId)
    : null;
  const turn =
    callEvent?.data?.turn ??
    events.findLast?.((ev) => ev.type === 'turn/start')?.data?.turn ??
    null;
  return { session, turn, callSeq: callEvent?.seq ?? null };
}

function emitPluginRecord(appendFn, session, type, data) {
  if (!appendFn || !session) return;
  try {
    appendFn(session, type, data);
  } catch {
    // Non-fatal: tool result JSON still allows fallback projection on client.
  }
}

function formatContractListRows(records = []) {
  const columns = [
    '合同ID',
    '合同编号',
    '合同名称',
    '合同类型',
    '甲方户名',
    '乙方户名',
    '合同总额（元）',
    '已开票金额（元）',
    '已收付金额（元）',
    '逾期金额（元）',
    '签订日期',
    '履约状态',
    '商务负责人',
    '交付负责人',
  ];
  const rows = (Array.isArray(records) ? records : []).map((item) => ({
    合同ID: item.id ?? null,
    合同编号: item.contractNo ?? '',
    合同名称: item.contractName ?? '',
    合同类型: CONTRACT_TYPE_LABELS[item.contractType] ?? String(item.contractType ?? ''),
    甲方户名: item.partyAName ?? '',
    乙方户名: item.partyBName ?? '',
    '合同总额（元）': toFiniteNumber(item.totalAmount) ?? 0,
    '已开票金额（元）': toFiniteNumber(item.invoicedAmount) ?? 0,
    '已收付金额（元）': toFiniteNumber(item.paidAmount) ?? 0,
    '逾期金额（元）': toFiniteNumber(item.overdueAmount) ?? 0,
    签订日期: item.signDate ?? '',
    履约状态: CONTRACT_STATUS_LABELS[item.status] ?? String(item.status ?? ''),
    商务负责人: item.businessOwnerName ?? '',
    交付负责人: item.deliveryOwnerName ?? '',
  }));
  return { columns, rows };
}

function formatDashboardTrendRows(trends = {}) {
  const columns = ['月份', '签约金额（元）', '收入金额（元）', '支出金额（元）', '逾期应收应付（元）'];
  const pickMonth = (map, month) => {
    if (!map || typeof map !== 'object') return 0;
    const raw = map[String(month)] ?? map[month] ?? 0;
    return toFiniteNumber(raw) ?? 0;
  };
  const rows = [];
  for (let month = 1; month <= 12; month++) {
    rows.push({
      月份: `${month}月`,
      '签约金额（元）': pickMonth(trends.signTrend, month),
      '收入金额（元）': pickMonth(trends.incomeTrend, month),
      '支出金额（元）': pickMonth(trends.expenseTrend, month),
      '逾期应收应付（元）': pickMonth(trends.receivableTrend, month),
    });
  }
  return { columns, rows };
}

function formatUnmatchedRows(list = []) {
  const columns = ['流水ID', '流水类型', '交易日期', '金额（元）', '对方户名', '合同编号', '摘要', '匹配状态'];
  const rows = (Array.isArray(list) ? list : []).map((txn) => ({
    流水ID: txn.id ?? null,
    流水类型: TXN_TYPE_LABELS[txn.txnType] ?? String(txn.txnType ?? ''),
    交易日期: txn.txnDate ?? '',
    '金额（元）': toFiniteNumber(txn.amount) ?? 0,
    对方户名: txn.counterparty ?? '',
    合同编号: txn.contractNo ?? '',
    摘要: txn.description ?? '',
    匹配状态: MATCH_STATUS_LABELS[txn.matchStatus] ?? String(txn.matchStatus ?? ''),
  }));
  return { columns, rows };
}

function formatDocumentSummary(doc) {
  return {
    id: doc.id,
    docId: doc.id,
    contractId: doc.contractId ?? null,
    nodeId: doc.nodeId ?? null,
    docType: doc.docType ?? 1,
    docTypeLabel: DOC_TYPE_LABELS[doc.docType] || '附件',
    fileName: doc.fileName || `document-${doc.id}`,
    fileSize: doc.fileSize ?? null,
    uploadTime: doc.uploadTime ?? null,
  };
}

/**
 * Core plugin setup, injectable for deterministic unit testing without DSH host dependencies.
 */
export function setupContractSure(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const appendPluginRecord = deps.appendPluginRecord ?? hostAppendPluginRecord;
  const configPath = deps.configPath;
  const fetchImpl = deps.fetchImpl;
  const callOpts = (signal) => ({ signal, ...(fetchImpl ? { fetchImpl } : {}) });
  const getCfg = () => loadConfig({ ctx, configPath });
  const stagedDrafts = new Map();
  const disposers = [];

  function storeDraft(entry) {
    if (stagedDrafts.size >= MAX_STAGED_DRAFTS) {
      const oldestKey = stagedDrafts.keys().next().value;
      if (oldestKey !== undefined) stagedDrafts.delete(oldestKey);
    }
    stagedDrafts.set(entry.draftId, entry);
  }

  async function confirmContractDraft({ draftId, draft, sourceFilePath, sessionId, callId, signal }) {
    const staged = draftId ? stagedDrafts.get(draftId) : null;
    if (draftId && !staged && !draft) {
      throw new ApiError(`未找到暂存草稿（${draftId}），请重新调用 contract_stage_draft 生成核对草稿。`, {
        code: 'DRAFT_NOT_FOUND',
      });
    }
    if (staged?.status === 'confirmed') {
      return {
        kind: 'contract-sure-confirmed',
        draftId,
        contractId: staged.contractId,
        alreadyConfirmed: true,
        uploadedDoc: staged.uploadedDoc || null,
        uploadWarning: staged.uploadWarning || null,
        message: `该草稿已入库（合同 ID: #${staged.contractId}），无需重复创建。`,
      };
    }

    const mergedRaw = {
      ...(staged?.draft || {}),
      ...(draft && typeof draft === 'object' ? draft : {}),
    };
    const finalDraft = normalizeContractDraft(mergedRaw);
    if (!finalDraft.contractNo) {
      throw new ApiError('合同编号（contractNo）不能为空。', { code: 'INVALID_ARGUMENT' });
    }
    if (!finalDraft.contractName) {
      throw new ApiError('合同名称（contractName）不能为空。', { code: 'INVALID_ARGUMENT' });
    }
    if (![1, 2].includes(finalDraft.contractType)) {
      throw new ApiError('合同类型（contractType）必须为 1（销售合同）或 2（采购合同）。', {
        code: 'INVALID_ARGUMENT',
      });
    }

    const cfg = getCfg();
    const createdId = await apiClient.createContract(cfg, finalDraft, callOpts(signal));
    const contractId = typeof createdId === 'object' && createdId !== null ? createdId.id ?? createdId.contractId : createdId;

    const finalSourcePath =
      typeof sourceFilePath === 'string' && sourceFilePath.trim()
        ? sourceFilePath.trim()
        : staged?.sourceFilePath || null;

    let uploadedDoc = null;
    let uploadWarning = null;
    if (finalSourcePath) {
      try {
        const uploaded = await apiClient.uploadContractFile(cfg, contractId, finalSourcePath, 1, callOpts(signal));
        uploadedDoc = uploaded ? formatDocumentSummary(uploaded) : { fileName: finalSourcePath, docType: 1 };
      } catch (error) {
        uploadWarning = `合同已成功创建（ID: #${contractId}），但自动归档原件失败：${error.message}`;
      }
    }

    if (staged) {
      staged.status = 'confirmed';
      staged.contractId = contractId;
      staged.draft = finalDraft;
      staged.uploadedDoc = uploadedDoc;
      staged.uploadWarning = uploadWarning;
      staged.confirmedAt = new Date().toISOString();
    }

    const targetSessionId = sessionId || staged?.sessionId;
    const { session, turn, callSeq } = resolveSessionContext(ctx, targetSessionId, callId);
    if (draftId) {
      emitPluginRecord(appendPluginRecord, session, DRAFT_CONFIRMED_RECORD_TYPE, {
        version: 1,
        turn: turn ?? staged?.turn ?? null,
        callId: callId || null,
        callSeq,
        draftId,
        contractId,
        uploadedDoc,
        uploadWarning,
      });
    }

    return {
      kind: 'contract-sure-confirmed',
      draftId: draftId || null,
      contractId,
      alreadyConfirmed: false,
      uploadedDoc,
      uploadWarning,
      message: uploadedDoc
        ? `合同已成功创建（ID: #${contractId}），并已自动归档原件《${uploadedDoc.fileName}》。`
        : uploadWarning || `合同已成功创建（ID: #${contractId}）。`,
    };
  }

  // 1. Settings synchronization
  disposers.push(registerSettingsSync(ctx, { configPath }));

  // 2. System prompt registration
  const registerPrompt = (sp) => {
    if (!sp?.section) return;
    try {
      const dispose = sp.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        text: CONTRACT_SURE_PROMPT,
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(`@local/contract-sure: systemPrompt registration failed: ${error.message}`);
    }
  };
  const immediateSp = getHostService(ctx, 'systemPrompt');
  if (immediateSp?.section) {
    registerPrompt(immediateSp);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (c) => registerPrompt(getHostService(c, 'systemPrompt')));
  }

  // 3. Register 7 host tools
  const tools = getHostService(ctx, 'tools');

  // Tool 1: contract_config
  tools.register({
    name: 'contract_config',
    description:
      '查看、修改或测试履约无忧后端与 DeepSeek OCR 配置，支持通过用户名密码一键换取 90 天长期插件访问令牌（CLI 与桌面端均可用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'test', 'login'],
          description: '操作类型：get 查看当前脱敏配置，set 更新配置，test 测试后端连通性，login 用账号密码换取长期令牌并保存。',
        },
        serverUrl: { type: 'string', description: '后端 API 基础地址，例如 http://localhost:8081/api/v1' },
        apiToken: { type: 'string', description: '履约无忧长期访问令牌（Bearer Token）' },
        ocrApiUrl: { type: 'string', description: 'DeepSeek OCR 接口地址，默认 https://api.deepseek.com/v1/tools/ocr' },
        ocrApiKey: { type: 'string', description: 'DeepSeek API Key（用于扫描件/图片 OCR 识别）' },
        username: { type: 'string', description: 'login 模式必填：履约无忧登录用户名' },
        password: { type: 'string', description: 'login 模式必填：履约无忧登录密码' },
        ttlDays: { type: 'integer', minimum: 1, maximum: 365, description: 'login 模式可选：长期令牌有效期天数，默认 90' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args = {}, exec = {}) {
      const action = args.action || 'get';
      if (action === 'get') {
        return { action: 'get', config: maskConfig(getCfg(), { configPath }) };
      }
      if (action === 'set') {
        const patch = {};
        for (const key of ['serverUrl', 'apiToken', 'ocrApiUrl', 'ocrApiKey']) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        const saved = saveConfig(patch, { ctx, configPath });
        return {
          action: 'set',
          ok: true,
          message: '履约无忧配置已保存并同步。',
          config: maskConfig(saved, { configPath }),
        };
      }
      if (action === 'login') {
        if (!args.username || !args.password) {
          throw new ApiError('登录换取令牌需要提供 username 和 password。', { code: 'INVALID_ARGUMENT' });
        }
        const current = getCfg();
        const targetUrl = args.serverUrl?.trim() || current.serverUrl;
        const ttlDays = args.ttlDays ?? 90;
        const res = await apiClient.exchangePluginToken(
          { serverUrl: targetUrl, username: args.username, password: args.password, ttlDays },
          callOpts(exec.signal),
        );
        if (!res?.token) {
          throw new ApiError('后端未返回有效的插件令牌。', { code: 'AUTH_FAILED' });
        }
        const saved = saveConfig({ serverUrl: targetUrl, apiToken: res.token }, { ctx, configPath });
        return {
          action: 'login',
          ok: true,
          userId: res.userId ?? null,
          username: res.username ?? args.username,
          realName: res.realName ?? '',
          expiresInDays: res.expiresInDays ?? ttlDays,
          message: `已成功换取 ${res.expiresInDays ?? ttlDays} 天长期令牌并保存到本地配置。`,
          config: maskConfig(saved, { configPath }),
        };
      }
      if (action === 'test') {
        const current = getCfg();
        const testCfg = {
          ...current,
          ...(args.serverUrl ? { serverUrl: args.serverUrl } : {}),
          ...(args.apiToken ? { apiToken: args.apiToken } : {}),
        };
        try {
          const user = await apiClient.getMe(testCfg, callOpts(exec.signal));
          return {
            action: 'test',
            connected: true,
            serverUrl: testCfg.serverUrl,
            user,
            message: `连接成功，当前登录用户：${user?.realName || user?.username || '未知'}`,
          };
        } catch (error) {
          return {
            action: 'test',
            connected: false,
            serverUrl: testCfg.serverUrl,
            error: error.message,
          };
        }
      }
      throw new ApiError(`不支持的 action：${action}`, { code: 'INVALID_ARGUMENT' });
    },
  });

  // Tool 2: contract_read_document
  tools.register({
    name: 'contract_read_document',
    description:
      '读取本地合同 PDF、发票/收款单/验收单图片或文本文件为纯文本/Markdown。电子 PDF 优先调用后端零成本提取文本层，扫描件与图片自动回退 DeepSeek OCR 识别。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filePath: {
          type: 'string',
          description: '本地文件路径，支持 .pdf、.jpg、.jpeg、.png、.webp、.txt、.md',
        },
      },
      required: ['filePath'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec = {}) {
      const cfg = getCfg();
      const res = await readDocument(args.filePath, cfg, {
        apiClient,
        signal: exec.signal,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      const truncated = res.text.length > MAX_READ_TEXT_CHARS;
      return {
        ...res,
        truncated,
        text: truncated ? `${res.text.slice(0, MAX_READ_TEXT_CHARS)}\n\n[文本已截断，原文共 ${res.text.length} 字]` : res.text,
      };
    },
  });

  // Tool 3: contract_stage_draft
  tools.register({
    name: 'contract_stage_draft',
    description:
      '校验提取的合同草稿并生成交互式「合同识别核对卡」。调用后端 POST /contracts/validate 核对编号重复与节点总额一致性，暂存草稿供用户确认。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contractNo: { type: 'string', description: '合同编号' },
        contractName: { type: 'string', description: '合同名称' },
        contractType: { type: 'integer', enum: [1, 2], description: '合同类型：1=销售合同，2=采购合同' },
        totalAmount: { type: 'number', description: '合同总金额（人民币元，纯数字）' },
        taxRate: { type: 'number', description: '可选税率（百分比数字，如 6 或 13）' },
        signDate: { type: ['string', 'null'], description: '签订日期 YYYY-MM-DD，未知填 null' },
        startDate: { type: ['string', 'null'], description: '合同开始日期 YYYY-MM-DD' },
        endDate: { type: ['string', 'null'], description: '合同结束日期 YYYY-MM-DD' },
        partyAName: { type: 'string', description: '甲方户名' },
        partyBName: { type: 'string', description: '乙方户名' },
        sourceFilePath: { type: 'string', description: '可选：合同原件本地路径，确认入库时将自动归档上传' },
        nodes: {
          type: 'array',
          description: '付款/回款节点列表',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              nodeOrder: { type: 'integer' },
              nodeName: { type: 'string' },
              nodeAmount: { type: 'number' },
              nodeRatio: { type: 'number' },
              plannedDate: { type: ['string', 'null'] },
              paymentCondition: { type: 'string' },
              triggerRule: { type: ['object', 'string', 'null'] },
            },
            required: ['nodeName'],
          },
        },
      },
      required: ['contractNo', 'contractName', 'contractType', 'totalAmount'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec = {}) {
      const cfg = getCfg();
      const draft = normalizeContractDraft(args);
      const sourceFilePath = typeof args.sourceFilePath === 'string' && args.sourceFilePath.trim()
        ? args.sourceFilePath.trim()
        : null;

      const validation = await apiClient.validateContractDraft(cfg, draft, callOpts(exec.signal));
      const draftId = `draft_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const sessionId = exec.agent?.id || null;
      const { session, turn, callSeq } = resolveSessionContext(ctx, sessionId, exec.callId);

      storeDraft({
        draftId,
        sessionId,
        turn,
        draft,
        sourceFilePath,
        validation,
        status: 'staged',
        createdAt: new Date().toISOString(),
      });

      emitPluginRecord(appendPluginRecord, session, DRAFT_RECORD_TYPE, {
        version: 1,
        turn,
        callId: exec.callId || null,
        callSeq,
        draftId,
        draft,
        sourceFilePath,
        validation,
        status: 'staged',
      });

      return {
        kind: 'contract-sure-draft',
        draftId,
        status: 'staged',
        draft,
        sourceFilePath,
        validation,
        hint: '合同草稿已校验并生成核对卡，请提示用户在核对卡中确认信息后点击「确认创建并归档原件」，或在用户明确确认后调用 contract_confirm_save。',
      };
    },
  });

  // Tool 4: contract_confirm_save
  tools.register({
    name: 'contract_confirm_save',
    description:
      '确认并保存已暂存的合同草稿（或直接保存已校验草稿）到履约无忧系统，若附带 sourceFilePath 则自动归档上传合同原件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draftId: { type: 'string', description: 'contract_stage_draft 返回的 draftId' },
        draft: { type: 'object', additionalProperties: true, description: '可选：覆盖修改后的合同草稿字段或直接提交的合同对象' },
        sourceFilePath: { type: 'string', description: '可选：合同原件本地路径，不传则沿用暂存草稿中的路径' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args = {}, exec = {}) {
      return confirmContractDraft({
        draftId: args.draftId,
        draft: args.draft,
        sourceFilePath: args.sourceFilePath,
        sessionId: exec.agent?.id || null,
        callId: exec.callId || null,
        signal: exec.signal,
      });
    },
  });

  // Tool 5: contract_query
  tools.register({
    name: 'contract_query',
    description:
      '查询履约无忧合同列表（mode="list"，返回适配 query_result_chart 的中文行列数据）或单份合同详情及关联文档原件（mode="detail"，自动呈现原件预览列表）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['list', 'detail'], description: 'list 查询分页合同列表；detail 查询单份合同详情与附件原件' },
        contractId: { type: 'integer', description: 'mode="detail" 必填：合同 ID' },
        keyword: { type: 'string', description: 'mode="list" 可选：关键词（合同编号、名称或负责人）' },
        contractType: { type: 'integer', enum: [1, 2], description: 'mode="list" 可选：1=销售合同，2=采购合同' },
        status: { type: 'integer', enum: [0, 1, 2, 3], description: 'mode="list" 可选：0=草稿，1=履约中，2=已完成，3=已终止' },
        startDate: { type: 'string', description: 'mode="list" 可选：起始签订日期 YYYY-MM-DD' },
        endDate: { type: 'string', description: 'mode="list" 可选：截止签订日期 YYYY-MM-DD' },
        pageNum: { type: 'integer', minimum: 1, description: '页码，默认 1' },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 20' },
      },
      required: ['mode'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec = {}) {
      const cfg = getCfg();
      if (args.mode === 'list') {
        const page = await apiClient.listContracts(
          cfg,
          {
            keyword: args.keyword,
            contractType: args.contractType,
            status: args.status,
            startDate: args.startDate,
            endDate: args.endDate,
            pageNum: args.pageNum ?? 1,
            pageSize: args.pageSize ?? 20,
          },
          callOpts(exec.signal),
        );
        const records = Array.isArray(page?.records) ? page.records : Array.isArray(page) ? page : [];
        const total = Number.isFinite(page?.total) ? page.total : records.length;
        const { columns, rows } = formatContractListRows(records);
        return {
          mode: 'list',
          total,
          rowCount: total,
          pageNum: page?.current ?? args.pageNum ?? 1,
          pageSize: page?.size ?? args.pageSize ?? 20,
          truncated: total > rows.length,
          columns,
          rows,
        };
      }

      if (args.mode === 'detail') {
        if (!Number.isInteger(args.contractId) || args.contractId <= 0) {
          throw new ApiError('mode="detail" 必须提供有效的正整数 contractId。', { code: 'INVALID_ARGUMENT' });
        }
        const detail = await apiClient.getContractDetail(cfg, args.contractId, callOpts(exec.signal));
        const documents = Array.isArray(detail?.documents) ? detail.documents.map(formatDocumentSummary) : [];
        const nodes = Array.isArray(detail?.nodes) ? detail.nodes : [];
        const sessionId = exec.agent?.id || null;
        const { session, turn, callSeq } = resolveSessionContext(ctx, sessionId, exec.callId);

        emitPluginRecord(appendPluginRecord, session, DETAIL_RECORD_TYPE, {
          version: 1,
          turn,
          callId: exec.callId || null,
          callSeq,
          contractId: detail?.id ?? args.contractId,
          contractNo: detail?.contractNo || '',
          contractName: detail?.contractName || '',
          documents,
        });

        return {
          kind: 'contract-sure-detail',
          mode: 'detail',
          contract: {
            ...detail,
            contractTypeLabel: CONTRACT_TYPE_LABELS[detail?.contractType] || '',
            statusLabel: CONTRACT_STATUS_LABELS[detail?.status] || '',
            nodes: undefined,
            documents: undefined,
          },
          nodes,
          documents,
        };
      }

      throw new ApiError(`不支持的查询模式：${args.mode}`, { code: 'INVALID_ARGUMENT' });
    },
  });

  // Tool 6: contract_dashboard
  tools.register({
    name: 'contract_dashboard',
    description:
      '查询履约看板核心汇总指标与 12 个月趋势数据，返回可直接交由 query_result_chart 展示的月度趋势表格行（columns + rows）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contractType: { type: 'integer', enum: [1, 2], description: '可选：1=销售合同，2=采购合同；省略则统计全部' },
        year: { type: 'integer', minimum: 2000, maximum: 2100, description: '可选：统计年份，默认当年' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args = {}, exec = {}) {
      const cfg = getCfg();
      const year = args.year ?? new Date().getFullYear();
      const [stats, trends] = await Promise.all([
        apiClient.getDashboardStats(cfg, args.contractType, callOpts(exec.signal)),
        apiClient.getDashboardTrends(cfg, args.contractType, year, callOpts(exec.signal)),
      ]);
      const { columns, rows } = formatDashboardTrendRows(trends || {});
      return {
        contractType: args.contractType ?? null,
        contractTypeLabel: args.contractType ? CONTRACT_TYPE_LABELS[args.contractType] : '全部合同',
        year,
        summary: stats || {},
        columns,
        rows,
        rowCount: rows.length,
      };
    },
  });

  // Tool 7: contract_manage_flow
  tools.register({
    name: 'contract_manage_flow',
    description:
      '执行履约三流确定性业务操作：import_excel（导入发票/银行流水 Excel 并自动匹配）、list_unmatched（查询未匹配流水）、manual_match（人工关联流水到合同/节点）、upload_node_evidence（上传节点发票/收付款单/验收材料）、set_node_manual_date（人工指定节点应付款日期）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['import_excel', 'list_unmatched', 'manual_match', 'upload_node_evidence', 'set_node_manual_date'],
          description: '业务动作类型',
        },
        filePath: { type: 'string', description: 'import_excel / upload_node_evidence 必填：本地文件路径' },
        txnType: {
          type: 'integer',
          enum: [0, 1, 2, 3],
          description: 'import_excel 必填（list_unmatched 可选筛选）：1=发票，0=自动判断收付款流水，2=收款流水，3=付款流水',
        },
        transactionId: { type: 'integer', description: 'manual_match 必填：流水 ID' },
        contractId: { type: 'integer', description: 'manual_match / upload_node_evidence / set_node_manual_date 必填：合同 ID' },
        nodeId: { type: 'integer', description: '节点 ID（upload_node_evidence / set_node_manual_date 必填，manual_match 可选）' },
        docType: { type: 'integer', enum: [2, 3, 4], description: 'upload_node_evidence 必填：2=发票，3=收付款凭证，4=验收材料' },
        amount: { type: 'number', description: 'upload_node_evidence 可选：票据/收付款金额（元）' },
        eventDate: { type: 'string', description: 'upload_node_evidence 可选：事件日期 YYYY-MM-DD（开票日/收付款日/验收日）' },
        date: { type: 'string', description: 'set_node_manual_date 必填：人工指定的应付款日期 YYYY-MM-DD' },
        remark: { type: 'string', description: 'set_node_manual_date 可选：调整备注说明' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
    async execute(args, exec = {}) {
      const cfg = getCfg();
      const opts = callOpts(exec.signal);

      if (args.action === 'import_excel') {
        if (!args.filePath) {
          throw new ApiError('import_excel 必须提供本地 Excel 文件路径（filePath）。', { code: 'INVALID_ARGUMENT' });
        }
        const txnType = args.txnType ?? 0;
        const result = await apiClient.uploadTransactionExcel(cfg, args.filePath, txnType, opts);
        return {
          action: 'import_excel',
          txnType,
          txnTypeLabel: TXN_TYPE_LABELS[txnType] ?? String(txnType),
          batchId: result?.batchId ?? null,
          parsedCount: result?.parsedCount ?? 0,
          matchedCount: Array.isArray(result?.matchResults) ? result.matchResults.length : 0,
          matchResults: result?.matchResults ?? [],
          status: result?.status ?? 'success',
        };
      }

      if (args.action === 'list_unmatched') {
        const [txns, summary] = await Promise.all([
          args.txnType != null
            ? apiClient.getTransactionPool(cfg, { matchStatus: 0, txnType: args.txnType }, opts)
            : apiClient.getUnmatchedTransactions(cfg, opts),
          apiClient.getTransactionSummary(cfg, opts).catch(() => null),
        ]);
        const list = Array.isArray(txns) ? txns : [];
        const { columns, rows } = formatUnmatchedRows(list);
        return {
          action: 'list_unmatched',
          count: list.length,
          rowCount: list.length,
          summary,
          columns,
          rows,
        };
      }

      if (args.action === 'manual_match') {
        if (!Number.isInteger(args.transactionId) || !Number.isInteger(args.contractId)) {
          throw new ApiError('manual_match 必须提供 transactionId 和 contractId。', { code: 'INVALID_ARGUMENT' });
        }
        await apiClient.manualMatchTransaction(cfg, args.transactionId, args.contractId, args.nodeId, opts);
        return {
          action: 'manual_match',
          ok: true,
          transactionId: args.transactionId,
          contractId: args.contractId,
          nodeId: args.nodeId ?? null,
          message: `已将流水 #${args.transactionId} 关联至合同 #${args.contractId}${args.nodeId ? `（节点 #${args.nodeId}）` : ''}并重算节点状态。`,
        };
      }

      if (args.action === 'upload_node_evidence') {
        if (!Number.isInteger(args.contractId) || !Number.isInteger(args.nodeId) || !args.filePath || !args.docType) {
          throw new ApiError('upload_node_evidence 必须提供 contractId、nodeId、filePath 和 docType（2/3/4）。', {
            code: 'INVALID_ARGUMENT',
          });
        }
        const doc = await apiClient.uploadNodeDocument(
          cfg,
          args.contractId,
          args.nodeId,
          args.filePath,
          { docType: args.docType, amount: args.amount, eventDate: args.eventDate },
          opts,
        );
        return {
          action: 'upload_node_evidence',
          ok: true,
          document: doc ? formatDocumentSummary(doc) : null,
          message: `已上传节点 #${args.nodeId} 的${DOC_TYPE_LABELS[args.docType] || '证明材料'}并触发履约日期重算。`,
        };
      }

      if (args.action === 'set_node_manual_date') {
        if (!Number.isInteger(args.nodeId) || !Number.isInteger(args.contractId) || !args.date) {
          throw new ApiError('set_node_manual_date 必须提供 nodeId、contractId 和 date（YYYY-MM-DD）。', {
            code: 'INVALID_ARGUMENT',
          });
        }
        await apiClient.manualSetNodeDate(
          cfg,
          args.nodeId,
          { contractId: args.contractId, date: args.date, remark: args.remark },
          opts,
        );
        return {
          action: 'set_node_manual_date',
          ok: true,
          contractId: args.contractId,
          nodeId: args.nodeId,
          date: args.date,
          remark: args.remark ?? '',
          message: `已将节点 #${args.nodeId} 的应付款日期人工调整为 ${args.date}。`,
        };
      }

      throw new ApiError(`不支持的业务动作：${args.action}`, { code: 'INVALID_ARGUMENT' });
    },
  });

  // 4. Register TypertRemoteService ("contractSure") when host protocol is available
  const remote = registerContractSureRemote(ctx, {
    ...(hostTypert || {}),
    ...(deps.typert || {}),
    dshCachePath: deps.cachePath || hostDshCachePath,
    apiClient,
    configPath,
    fetchImpl,
    confirmDraft: confirmContractDraft,
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // Ignore cleanup errors.
          }
        }
      };
    }, '@local/contract-sure: cleanup');
  }

  return {
    stagedDrafts,
    remoteHandlers: remote.handlers,
    confirmContractDraft,
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Ignore.
        }
      }
    },
  };
}

export function apply(ctx) {
  return setupContractSure(ctx);
}
