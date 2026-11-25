import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, defaultApiClient } from './api-client.js';
import { createAccountManager } from './accounts.js';
import { toToolOutput } from './tool-output.js';
import {
  checkRange,
  dateText,
  invalid,
  isRealDate,
  optAmount,
  optBool,
  optDate,
  optEnum,
  optInt,
  optText,
  rejectPresent,
  rejectUnknown,
  round,
  text,
  toNumber,
} from './args.js';
import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, SALESFORGE_PROMPT } from './prompts.js';
import { registerSalesforgeRemote } from './remote-service.js';
import { registerWriteTools } from './write-tools.js';

// 宿主包动态加载：独立跑 Node 单测时不需要任何 npm 依赖。
let hostTypert = null;
let hostAppendPluginRecord = null;
try {
  const sessionMod = await import('@deepseek-ai/dsh-session');
  hostAppendPluginRecord = sessionMod.appendPluginRecord || null;
} catch {
  // 不在 DSH 宿主里运行（例如单测）。
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
  // 不在 DSH 宿主里运行（例如单测）。
}

export const name = '@local/salesforge';
export const description = '销售管理（SalesForge）：查询和维护客户、渠道、项目商机、日报周报和销售目标，删除和移交前先让你确认';
export const inject = ['tools'];

export const PERSON_UNRESOLVED_KIND = 'salesforge-person-unresolved';
export const REPORT_DRAFT_KIND = 'salesforge-report-draft';
export const REPORT_SUBMITTED_KIND = 'salesforge-report-submitted';
export const REPORT_SUBMITTED_RECORD_TYPE = 'plugin:salesforge/report-submitted';
// 日报草稿只放在内存里：小智办公重启后草稿失效，要重新生成。
const MAX_STAGED_REPORTS = 50;
const REPORT_WRITE_ERRORS = Object.freeze({
  FORBIDDEN: '销售管理系统拒绝了这次提交：可能是你的账号没有新建日报的权限，或者服务器还没升级到允许插件提交日报的版本，请联系管理员。',
  BAD_REQUEST: '销售管理系统没有接受这条日报：请核对拜访日期、拜访对象和拜访人后重试。',
  NOT_FOUND: '拜访对象或拜访人在销售管理系统里已经不存在，请让助手重新生成草稿。',
});
const MAX_REPORT_TEXT_LENGTH = 2000;

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const REPORT_PAGE_SIZE_MAX = 50;
// 本地过滤或排序时，按每页 100 条往后翻，最多看 500 条。
const SCAN_PAGE_SIZE = 100;
const SCAN_MAX_RECORDS = 500;
const MAX_PERSON_CANDIDATES = 20;
const MAX_PEOPLE_ROWS = 200;

export const PROJECT_STATUSES = Object.freeze([
  '发现问题',
  '技术预研',
  '方案论证',
  '立项审批',
  '启动采购',
  '制定标准',
  '商务招标',
  '项目签约',
  '项目丢单',
]);
// 后端默认不列出这两个状态的项目（includeArchived=false）。
const ARCHIVED_STATUSES = new Set(['项目签约', '项目丢单']);
export const PROJECT_RISKS = Object.freeze(['必签项目', '时间风险', '赢单风险']);

const POST_TYPE_LABELS = Object.freeze({ 1: '售前', 2: '销售' });
const PERIOD_LABELS = Object.freeze({ year: '本年', quarter: '本季度', month: '本月' });
const DASHBOARD_LABELS = Object.freeze({
  home: '首页概览（本月，部门范围）',
  sales: '销售完成',
  opportunity: '商机储备',
  market: '市场拓展',
});
const TARGET_TYPE_CODES = Object.freeze({ customer: 1, channel: 2 });
const TARGET_TYPE_LABELS = Object.freeze({ 1: '客户', 2: '渠道' });

const textRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }];

function recordsOf(page) {
  if (Array.isArray(page)) return page;
  return Array.isArray(page?.records) ? page.records : [];
}

function pageInfo(page, pageNum, pageSize, rowCount) {
  const total = Number.isFinite(Number(page?.total)) ? Number(page.total) : rowCount;
  const size = Number(page?.pageSize) || pageSize;
  const current = Number(page?.pageNum) || pageNum;
  const pages = Number.isFinite(Number(page?.pages)) ? Number(page.pages) : Math.ceil(total / size);
  return { total, pageNum: current, pageSize: size, pages, hasMore: current < pages };
}

/** columns 是 [列名, 取值函数]，返回 { columns, rows }，rows 的键顺序和 columns 一致。 */
function table(records, columns) {
  return {
    columns: columns.map(([label]) => label),
    rows: records.map((record) => Object.fromEntries(columns.map(([label, pick]) => [label, pick(record ?? {})]))),
  };
}

const regionOf = (record) => [record.province, record.city, record.district].filter((part) => typeof part === 'string' && part).join(' ');
const daysOf = (record) => toNumber(record.daysSinceLastFollow);

const CUSTOMER_COLUMNS = [
  ['客户ID', (r) => toNumber(r.id)],
  ['客户名称', (r) => text(r.customerName)],
  ['行业', (r) => text(r.industry)],
  ['所在地区', regionOf],
  ['负责销售', (r) => text(r.salesName)],
  ['距上次跟进天数', daysOf],
  ['新增时间', (r) => dateText(r.createTime, false)],
];

const CHANNEL_COLUMNS = [
  ['渠道ID', (r) => toNumber(r.id)],
  ['渠道名称', (r) => text(r.companyName)],
  ['所在地区', regionOf],
  ['负责销售', (r) => text(r.salesName)],
  ['距上次跟进天数', daysOf],
  ['新增时间', (r) => dateText(r.createTime, false)],
];

const PROJECT_COLUMNS = [
  ['项目ID', (r) => toNumber(r.id)],
  ['项目名称', (r) => text(r.projectName)],
  ['客户', (r) => text(r.customerName)],
  ['渠道', (r) => text(r.channelName)],
  ['负责销售', (r) => text(r.salesName)],
  ['产品', (r) => text(r.product)],
  ['项目阶段', (r) => text(r.projectStatus)],
  ['项目风险', (r) => text(r.projectRisk)],
  ['预计签约日期', (r) => dateText(r.expectedSignDate, false)],
  ['预计金额（万元）', (r) => toNumber(r.expectedAmount)],
  ['距上次跟进天数', daysOf],
  ['新增时间', (r) => dateText(r.createTime, false)],
  ['备注', (r) => text(r.remark)],
];

const DAILY_REPORT_COLUMNS = [
  ['日报ID', (r) => toNumber(r.id)],
  ['日期', (r) => dateText(r.reportDate, false)],
  ['汇报人', (r) => text(r.realName)],
  ['对象类型', (r) => TARGET_TYPE_LABELS[r.targetType] ?? ''],
  ['对象ID', (r) => toNumber(r.targetId)],
  ['对象名称', (r) => text(r.targetName)],
  ['联系人', (r) => text(r.contactName)],
  ['工作计划', (r) => text(r.workPlan)],
  ['工作总结', (r) => text(r.workSummary)],
];

const planItemsOf = (record) => (Array.isArray(record.planItems) ? record.planItems.map(text).filter(Boolean) : []);

const WEEKLY_REPORT_COLUMNS = [
  ['周报ID', (r) => toNumber(r.id)],
  ['汇报人', (r) => text(r.reporterName)],
  ['周开始', (r) => dateText(r.weekStartDate, false)],
  ['周结束', (r) => dateText(r.weekEndDate, false)],
  ['本周计划', (r) => planItemsOf(r).join('；')],
  ['工作总结', (r) => text(r.workSummary)],
  ['补充说明', (r) => text(r.supplement)],
  ['状态', (r) => text(r.status)],
  ['更新时间', (r) => dateText(r.updateTime, true)],
];

function sortRecords(records, key, order) {
  const direction = order === 'asc' ? 1 : -1;
  const valueOf = (record) => {
    const raw = record?.[key];
    if (key === 'expectedAmount' || key === 'daysSinceLastFollow') return toNumber(raw);
    const day = dateText(raw, true);
    return day || null;
  };
  // 稳定排序；没有值的排在最后。
  return records
    .map((record, index) => ({ record, index, value: valueOf(record) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (a.value < b.value) return -direction;
      if (a.value > b.value) return direction;
      return a.index - b.index;
    })
    .map((item) => item.record);
}

// 某天所在周的周一（销售系统按周一归一周报、周计划）。
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const back = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

function localDay(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeWarn(ctx, message) {
  try {
    ctx?.logger?.warn?.(message);
  } catch {
    // 拿不到 logger 时静默。
  }
}

// ---------- 内置 skill：skills/<name>/SKILL.md，经宿主 skills 服务注册 ----------

export const SKILL_PROVIDER_NAME = '@local/salesforge';
export const BUNDLED_SKILL_NAMES = Object.freeze([
  'salesforge-query-data',
  'salesforge-project-analysis',
  'salesforge-target-tracking',
  'salesforge-customer-followup',
  'salesforge-weekly-review',
  'salesforge-edit-data',
]);
export const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url));
// 与宿主随包 skill 相同的优先级（@deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK）。
const BUNDLED_SKILL_RANK = 600;

/**
 * 解析 SKILL.md：frontmatter 只认单行的 `key: value`，必须有 name 和 description。
 * 返回 { name, description, content }，content 是去掉 frontmatter 后的正文。
 */
export function parseSkillFile(raw, path) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!block) throw new Error(`${path} 缺少 frontmatter`);
  const meta = {};
  for (const line of block[1].split(/\r?\n/u)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (pair) meta[pair[1]] = pair[2].trim().replace(/^(['"])(.*)\1$/u, '$2');
  }
  if (!meta.name) throw new Error(`${path} 缺少 name`);
  if (!meta.description) throw new Error(`${path} 缺少 description`);
  return { name: meta.name, description: meta.description, content: raw.slice(block[0].length).trim() };
}

/**
 * 内置 skill 的提供方。每次列目录和加载都重新读 SKILL.md；文件缺失或格式不对的 skill 不进目录，
 * 其他读取错误（例如文件被占用）让这次目录标为不完整，宿主下次会重试。
 */
export function createSkillProvider({ providerName = SKILL_PROVIDER_NAME, skillsDir = SKILLS_DIR, skillNames = BUNDLED_SKILL_NAMES, control, logger } = {}) {
  const warned = new Map();
  const warnOnce = (skillName, error) => {
    const message = String(error?.message ?? error);
    if (warned.get(skillName) === message) return;
    warned.set(skillName, message);
    try {
      logger?.warn?.(`${providerName}: skill "${skillName}" 不可用：${message}`);
    } catch {
      // 拿不到 logger 时静默。
    }
  };

  async function readSkill(skillName, signal) {
    const directory = join(skillsDir, skillName);
    const path = join(directory, 'SKILL.md');
    let raw;
    try {
      raw = await readFile(path, { encoding: 'utf8', signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      warnOnce(skillName, error);
      return { ok: false, error, persistent: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' };
    }
    try {
      const parsed = parseSkillFile(raw, path);
      if (parsed.name !== skillName) throw new Error(`${path} 的 name 是 "${parsed.name}"，应与目录名 "${skillName}" 一致`);
      warned.delete(skillName);
      return { ok: true, ...parsed, directory, path };
    } catch (error) {
      warnOnce(skillName, error);
      return { ok: false, error, persistent: true };
    }
  }

  return {
    name: providerName,
    async list(options = {}) {
      const reads = await Promise.all(skillNames.map((skillName) => readSkill(skillName, options.signal)));
      const candidates = reads
        .filter((read) => read.ok)
        .map((read) => ({
          name: read.name,
          description: read.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: providerName,
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          path: read.path,
          resourceBase: { kind: 'directory', path: read.directory.split(sep).join('/') },
          locator: read.path,
        }));
      return { candidates, complete: reads.every((read) => read.ok || read.persistent) };
    },
    async get(candidate, options = {}) {
      const read = await readSkill(candidate.name, options.signal);
      if (!read.ok) {
        if (!read.persistent) throw read.error;
        control?.invalidate?.();
        return undefined;
      }
      const { rank: _rank, locator: _locator, ...summary } = candidate;
      return { ...summary, content: read.content };
    },
  };
}

/**
 * 插件主体，依赖都可注入，单测不需要 DSH 宿主。
 * deps：apiClient、fetchImpl、configPath、now、hostname、schedule、cancelSchedule、credentialStore、typert。
 */
export function setupSalesforge(ctx, deps = {}) {
  const apiClient = deps.apiClient || defaultApiClient;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now || (() => Date.now());
  const callOpts = (signal) => ({ signal, ...(fetchImpl ? { fetchImpl } : {}) });
  // 只用 ctx.get 读取服务，不直接读 ctx 上的属性（Cordis 会对没 inject 的服务抛错）。
  const service = (c, svcName) => (c && typeof c.get === 'function' ? c.get(svcName) : undefined);
  const disposers = [];
  const accounts = createAccountManager(ctx, {
    configPath: deps.configPath,
    apiClient,
    fetchImpl,
    now: deps.now,
    hostname: deps.hostname,
    schedule: deps.schedule,
    cancelSchedule: deps.cancelSchedule,
    credentialStore: deps.credentialStore,
  });
  disposers.push(() => accounts.dispose());

  // 需要后端的操作：没有账户或令牌失效时返回授权提示（kind = salesforge-auth-required），而不是抛错。
  const viaBackend = async (fn) => {
    const result = await accounts.withBackend(fn);
    return result.ok ? result.value : result.authRequired;
  };

  const appendPluginRecord = deps.appendPluginRecord ?? hostAppendPluginRecord;
  const stagedReports = new Map();

  function stageReport(entry) {
    if (stagedReports.size >= MAX_STAGED_REPORTS) {
      const oldest = stagedReports.keys().next().value;
      if (oldest !== undefined) stagedReports.delete(oldest);
    }
    stagedReports.set(entry.draftId, entry);
  }

  /** 工具调用所在的会话和回合，用来把「已提交」记进会话，重新打开对话时卡片还是已提交。 */
  function sessionTurnOf(sessionId, callId) {
    const sessions = service(ctx, 'sessions');
    const session = sessionId && typeof sessions?.get === 'function' ? sessions.get(sessionId) || null : null;
    if (!session || typeof session.snapshotEvents !== 'function' || !callId) return { session, turn: null };
    const call = session.snapshotEvents().find((event) => event?.type === 'tool/call' && event.data?.callId === callId);
    return { session, turn: call?.data?.turn ?? null };
  }

  /** 提交日报时后端拒绝的原因：api-client 的通用文案是按「查询」写的，这里换成提交日报的说法。 */
  function reportWriteError(error) {
    const message = error instanceof ApiError ? REPORT_WRITE_ERRORS[error.code] : undefined;
    if (!message) return error;
    return new ApiError(message, { status: error.status, code: error.code, businessCode: error.businessCode });
  }

  /**
   * 提交日报草稿：只接受本插件暂存过的草稿，拜访对象不能改，拜访人只能从草稿里的联系人中选。
   * edited 可带 reportDate、contactId、workPlan、workSummary（用户在卡片上改过的内容）。
   */
  async function submitReportDraft({ draftId, edited, signal }) {
    const staged = typeof draftId === 'string' ? stagedReports.get(draftId) : undefined;
    if (!staged) {
      throw new ApiError('这份日报草稿已失效（小智办公可能重启过），请让助手重新生成草稿。', { code: 'DRAFT_NOT_FOUND' });
    }
    if (staged.status === 'submitted') {
      return { kind: REPORT_SUBMITTED_KIND, draftId, reportId: staged.reportId, alreadySubmitted: true, draft: staged.draft };
    }
    if (staged.status === 'submitting') {
      throw new ApiError('这份日报正在提交，请稍候。', { code: 'SUBMITTING' });
    }
    const patch = edited && typeof edited === 'object' && !Array.isArray(edited) ? edited : {};
    const final = { ...staged.draft };
    if (patch.reportDate !== undefined) {
      if (typeof patch.reportDate !== 'string' || !isRealDate(patch.reportDate.trim())) {
        throw new ApiError('拜访日期请按 YYYY-MM-DD 填写，例如 2026-11-24。', { code: 'INVALID_ARGUMENT' });
      }
      final.reportDate = patch.reportDate.trim();
    }
    if (patch.contactId !== undefined) final.contactId = toNumber(patch.contactId);
    for (const key of ['workPlan', 'workSummary']) {
      if (patch[key] !== undefined) final[key] = typeof patch[key] === 'string' ? patch[key].trim() : '';
    }
    if (!staged.contacts.some((contact) => contact.contactId === final.contactId)) {
      throw new ApiError(
        staged.contacts.length
          ? '请选择拜访人。'
          : `${TARGET_TYPE_LABELS[final.targetType]}「${final.targetName}」还没有联系人，请先在销售管理系统网页里添加联系人。`,
        { code: 'INVALID_ARGUMENT' },
      );
    }
    for (const [key, label] of [['workPlan', '工作计划'], ['workSummary', '工作总结']]) {
      if (!final[key]) throw new ApiError(`${label}不能为空。`, { code: 'INVALID_ARGUMENT' });
      if (final[key].length > MAX_REPORT_TEXT_LENGTH) {
        throw new ApiError(`${label}不能超过 ${MAX_REPORT_TEXT_LENGTH} 个字。`, { code: 'INVALID_ARGUMENT' });
      }
    }

    staged.status = 'submitting';
    let result;
    try {
      result = await accounts.withBackend(async (cfg) => {
        // 草稿是用哪个服务器、哪个账户生成的，就只能用它提交。
        if (cfg.serverUrl !== staged.serverUrl || cfg.accountId !== staged.accountId) {
          throw new ApiError('当前连接的销售管理系统账户和生成草稿时不同，请让助手重新生成草稿。', { code: 'ACCOUNT_SWITCHED' });
        }
        return apiClient.createWorkReport(
          cfg,
          {
            reportDate: final.reportDate,
            targetType: final.targetType,
            targetId: final.targetId,
            contactId: final.contactId,
            workPlan: final.workPlan,
            workSummary: final.workSummary,
          },
          callOpts(signal),
        ).catch((error) => {
          throw reportWriteError(error);
        });
      });
    } catch (error) {
      staged.status = 'staged';
      throw error;
    }
    if (!result.ok) {
      staged.status = 'staged';
      throw new ApiError('销售管理系统账户未连接或授权已失效，请先在「设置 → 销售管理配置」重新连接，再点提交。', { code: 'AUTH_REQUIRED' });
    }
    const reportId = toNumber(result.value);
    staged.status = 'submitted';
    staged.reportId = Number.isSafeInteger(reportId) ? reportId : null;
    staged.draft = final;
    if (appendPluginRecord && staged.session) {
      try {
        appendPluginRecord(staged.session, REPORT_SUBMITTED_RECORD_TYPE, {
          version: 1,
          turn: staged.turn,
          draftId,
          reportId: staged.reportId,
          // 实际提交的内容：重新打开对话时卡片显示这些，而不是最初的草稿。
          report: { reportDate: final.reportDate, contactId: final.contactId, workPlan: final.workPlan, workSummary: final.workSummary },
        });
      } catch {
        // 记不进会话不影响提交结果：只是重新打开对话时卡片不显示「已提交」。
      }
    }
    return { kind: REPORT_SUBMITTED_KIND, draftId, reportId: staged.reportId, alreadySubmitted: false, draft: final };
  }

  /**
   * 把人员参数（xxxId 或 xxxName）换成可见范围内的一个人。
   * 后端有些接口带人员参数时不再按数据范围过滤（日报列表的 reporterId 就是），所以先用 /users/scope 校验。
   * 返回 { person }（没给人员参数时 person 为 null），或 { unresolved }：找不到或有多位同名时的普通结果，带候选人员。
   */
  async function resolvePerson(cfg, id, personName, idKey, nameKey, signal) {
    if (id === undefined && personName === undefined) return { person: null };
    const users = await apiClient.listScopeUsers(cfg, callOpts(signal));
    const people = (Array.isArray(users) ? users : [])
      .map((user) => ({
        userId: toNumber(user?.id ?? user?.userId),
        realName: text(user?.realName),
        username: text(user?.username),
        deptId: toNumber(user?.deptId),
      }))
      .filter((person) => Number.isSafeInteger(person.userId));
    if (id !== undefined) {
      const found = people.find((person) => person.userId === id);
      if (found) return { person: found };
      return {
        unresolved: {
          kind: PERSON_UNRESOLVED_KIND,
          field: idKey,
          query: id,
          candidates: [],
          message: `人员 ${id} 不在你能查看的范围内（只能查自己和下级部门的人员），没有查询。可以用 sales_search(target="people") 查看能查的人员。`,
        },
      };
    }
    const lower = personName.toLowerCase();
    const exact = people.filter((person) => person.realName === personName || person.username.toLowerCase() === lower);
    const pool = exact.length
      ? exact
      : people.filter((person) => person.realName.includes(personName) || person.username.toLowerCase().includes(lower));
    if (pool.length === 1) return { person: pool[0] };
    return {
      unresolved: {
        kind: PERSON_UNRESOLVED_KIND,
        field: nameKey,
        query: personName,
        candidates: pool.slice(0, MAX_PERSON_CANDIDATES),
        message: pool.length
          ? `你能查看的人员里有 ${pool.length} 位和「${personName}」匹配，请确认是哪一位，再用 ${idKey} 指定后重新查询。`
          : `你能查看的人员里没有找到「${personName}」，请确认姓名；可以用 sales_search(target="people") 查看能查的人员。`,
      },
    };
  }

  /** 按每页 100 条翻页，最多取 500 条。返回 { records, total, scanned, scanTruncated }。 */
  async function scanPages(fetchPage) {
    const records = [];
    let total = 0;
    for (let pageNum = 1; records.length < SCAN_MAX_RECORDS; pageNum += 1) {
      const page = await fetchPage(pageNum, SCAN_PAGE_SIZE);
      const batch = recordsOf(page);
      total = Number.isFinite(Number(page?.total)) ? Number(page.total) : records.length + batch.length;
      records.push(...batch);
      if (batch.length < SCAN_PAGE_SIZE || records.length >= total) break;
    }
    const kept = records.slice(0, SCAN_MAX_RECORDS);
    return { records: kept, total, scanned: kept.length, scanTruncated: total > kept.length };
  }

  // ---------- 1. 系统提示词 ----------
  const registerPrompt = (sp) => {
    if (!sp?.section) return;
    try {
      const dispose = sp.section({ name: PROMPT_SECTION_NAME, order: PROMPT_SECTION_ORDER, text: SALESFORGE_PROMPT });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      safeWarn(ctx, '@local/salesforge: 系统提示词注册失败。');
    }
  };
  const immediatePrompt = service(ctx, 'systemPrompt');
  if (immediatePrompt?.section) {
    registerPrompt(immediatePrompt);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (c) => registerPrompt(service(c, 'systemPrompt')));
  }

  // ---------- 1b. 内置 skill：skills 服务是可选的（minimal 预设里没有），不写进硬依赖 inject ----------
  const registerSkills = (skills) => {
    if (typeof skills?.registerProvider !== 'function') return;
    try {
      const dispose = skills.registerProvider((control) => createSkillProvider({ control, logger: ctx?.logger }));
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch {
      safeWarn(ctx, '@local/salesforge: 内置 skill 注册失败。');
    }
  };
  const immediateSkills = service(ctx, 'skills');
  if (immediateSkills) {
    registerSkills(immediateSkills);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (c) => registerSkills(service(c, 'skills')));
  }

  // ---------- 2. 工具 ----------
  const tools = service(ctx, 'tools');
  // 所有工具的返回值都先整理成宿主接受的无损 JSON。
  const registerTool = (def) =>
    tools.register({
      ...def,
      output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
      async execute(args, exec) {
        const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        return toToolOutput(await def.execute(input, exec ?? {}));
      },
    });

  const pagingProps = (max) => ({
    pageNum: { type: 'integer', minimum: 1, description: '页码，默认 1' },
    pageSize: { type: 'integer', minimum: 1, maximum: max, description: `每页条数，默认 ${PAGE_SIZE_DEFAULT}，最大 ${max}` },
  });
  const salesPersonProps = {
    salesId: { type: 'integer', minimum: 1, description: '可选：按负责销售筛选，填人员 ID（可用 sales_search(target="people") 查）' },
    salesName: { type: 'string', description: '可选：按负责销售的姓名或用户名筛选；有多位同名时会返回候选，让你改用 salesId' },
  };

  // 工具 1：sales_config
  registerTool({
    name: 'sales_config',
    description:
      '查看销售管理插件的连接状态（action="get"，默认），或当前账户在销售管理系统里的身份（action="profile"：姓名、部门、角色、岗位类型和权限，用来判断能看哪些数据）。只读，不能修改配置；连接、切换、断开账户和修改服务器地址都请用户在「设置 → 销售管理配置」里操作。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'profile'], description: 'get 看连接状态（默认）；profile 看当前账户的身份和权限' },
      },
    },
    async execute(args, exec) {
      rejectUnknown(args, ['action'], 'sales_config');
      const action = optEnum(args, 'action', ['get', 'profile']) ?? 'get';
      if (action === 'profile') {
        return viaBackend(async (cfg) => {
          const info = (await apiClient.getAuthInfo(cfg, callOpts(exec.signal))) || {};
          const postType = toNumber(info.postType);
          // 手机号等联系方式不放进工具输出。
          return {
            action: 'profile',
            userId: toNumber(info.userId),
            username: text(info.username),
            realName: text(info.realName),
            deptId: toNumber(info.deptId),
            deptName: text(info.deptName),
            roleName: text(info.roleName),
            postType,
            postTypeLabel: POST_TYPE_LABELS[postType] ?? '无角色（按销售处理）',
            dataScope:
              postType === 1
                ? '售前：能看本部门及下级部门的全部客户、渠道、项目和日报。'
                : '销售：能看自己负责的数据，加上下级部门的数据。',
            permissions: Array.isArray(info.permissions) ? info.permissions.map(text).filter(Boolean) : [],
          };
        });
      }
      const conn = await accounts.describeConnection();
      const who = conn.account ? conn.account.realName || conn.account.username : '';
      let message = '尚未连接销售管理系统账户，请在「设置 → 销售管理配置」点「连接账户」完成浏览器授权。';
      if (conn.connected) {
        message = `已连接销售管理系统账户：${who}（${conn.account.username}）。`;
      } else if (conn.account) {
        message = `当前账户「${who}」的授权已${conn.account.status === 'expired' ? '过期' : '失效'}，请在「设置 → 销售管理配置」重新连接账户。`;
      }
      return { action: 'get', ...conn, message };
    },
  });

  // 工具 2：sales_search
  registerTool({
    name: 'sales_search',
    description:
      '按名称关键词同时搜索客户和渠道（target="customers_channels"，默认），返回类型、ID 和名称，用来拿到 customerId / channelId / targetId；或列出你能查看的人员（target="people"，可用 keyword 按姓名或用户名过滤），用来拿到 salesId / reporterId。只返回你有权查看的数据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', enum: ['customers_channels', 'people'], description: 'customers_channels 搜客户和渠道（默认）；people 列出能查看的人员' },
        keyword: { type: 'string', description: '关键词：客户或渠道名称的一部分；target="people" 时是姓名或用户名的一部分（可省略）' },
      },
    },
    async execute(args, exec) {
      rejectUnknown(args, ['target', 'keyword'], 'sales_search');
      const target = optEnum(args, 'target', ['customers_channels', 'people']) ?? 'customers_channels';
      const keyword = optText(args, 'keyword');
      if (target === 'customers_channels') {
        if (!keyword) throw invalid('搜索客户和渠道需要 keyword（名称的一部分）。');
        return viaBackend(async (cfg) => {
          const list = await apiClient.searchAll(cfg, { keyword }, callOpts(exec.signal));
          const items = Array.isArray(list) ? list : [];
          const { columns, rows } = table(items, [
            ['类型', (r) => TARGET_TYPE_LABELS[r.type] ?? ''],
            ['ID', (r) => toNumber(r.id)],
            ['名称', (r) => text(r.name)],
            ['行业', (r) => text(r.industry)],
          ]);
          return { target, keyword, total: rows.length, rowCount: rows.length, columns, rows };
        });
      }
      return viaBackend(async (cfg) => {
        const users = await apiClient.listScopeUsers(cfg, callOpts(exec.signal));
        const lower = keyword ? keyword.toLowerCase() : '';
        const matched = (Array.isArray(users) ? users : []).filter(
          (user) => !lower || text(user?.realName).includes(keyword) || text(user?.username).toLowerCase().includes(lower),
        );
        const { columns, rows } = table(matched.slice(0, MAX_PEOPLE_ROWS), [
          ['人员ID', (r) => toNumber(r.id ?? r.userId)],
          ['姓名', (r) => text(r.realName)],
          ['用户名', (r) => text(r.username)],
          ['部门ID', (r) => toNumber(r.deptId)],
        ]);
        return {
          target,
          keyword: keyword ?? '',
          total: matched.length,
          rowCount: rows.length,
          truncated: matched.length > rows.length,
          columns,
          rows,
        };
      });
    },
  });

  // 工具 3、4：客户和渠道列表（结构相同）
  const followProps = {
    createdFrom: { type: 'string', description: '可选：新增时间起 YYYY-MM-DD' },
    createdTo: { type: 'string', description: '可选：新增时间止 YYYY-MM-DD' },
    minDaysSinceFollow: {
      type: 'integer',
      minimum: 0,
      description: '可选：只看距上次跟进（最近一条日报）至少这么多天的，例如 30。会翻页扫描最多 500 条后在本地筛选',
    },
    sortBy: {
      type: 'string',
      enum: ['createTime', 'daysSinceLastFollow'],
      description: '可选：createTime 按新增时间倒序（默认）；daysSinceLastFollow 按未跟进天数从多到少（会翻页扫描最多 500 条）',
    },
  };

  function registerAccountList({ toolName, description: toolDescription, nameKey, nameDescription, extraKeys, columns, list }) {
    const allowed = [nameKey, ...extraKeys, 'salesId', 'salesName', 'createdFrom', 'createdTo', 'minDaysSinceFollow', 'sortBy', 'pageNum', 'pageSize'];
    const extraProps = extraKeys.includes('industry')
      ? { industry: { type: 'string', description: '可选：行业，精确匹配，例如 政府、教育、企业、金融、医疗' } }
      : {};
    registerTool({
      name: toolName,
      description: toolDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          [nameKey]: { type: 'string', description: nameDescription },
          ...extraProps,
          ...salesPersonProps,
          ...followProps,
          ...pagingProps(PAGE_SIZE_MAX),
        },
      },
      async execute(args, exec) {
        rejectUnknown(args, allowed, toolName);
        const filters = {
          [nameKey]: optText(args, nameKey),
          ...(extraKeys.includes('industry') ? { industry: optText(args, 'industry') } : {}),
          startDate: optDate(args, 'createdFrom'),
          endDate: optDate(args, 'createdTo'),
        };
        checkRange(filters.startDate, filters.endDate, 'createdFrom', 'createdTo');
        const salesId = optInt(args, 'salesId', 1, Number.MAX_SAFE_INTEGER);
        const salesName = optText(args, 'salesName');
        const minDays = optInt(args, 'minDaysSinceFollow', 0, 100_000);
        const sortBy = optEnum(args, 'sortBy', ['createTime', 'daysSinceLastFollow']);
        const pageNum = optInt(args, 'pageNum', 1, 100_000) ?? 1;
        const pageSize = optInt(args, 'pageSize', 1, PAGE_SIZE_MAX) ?? PAGE_SIZE_DEFAULT;
        const scan = minDays !== undefined || sortBy === 'daysSinceLastFollow';
        if (scan && args.pageNum !== undefined) throw invalid('用 minDaysSinceFollow 或 sortBy="daysSinceLastFollow" 时不分页，只返回前 pageSize 条，请去掉 pageNum。');

        return viaBackend(async (cfg) => {
          const resolved = await resolvePerson(cfg, salesId, salesName, 'salesId', 'salesName', exec.signal);
          if (resolved.unresolved) return resolved.unresolved;
          const query = { ...filters, salesId: resolved.person?.userId };
          const echo = { ...query, ...(resolved.person ? { salesName: resolved.person.realName } : {}) };
          if (!scan) {
            const page = await list(cfg, { ...query, pageNum, pageSize }, callOpts(exec.signal));
            const records = recordsOf(page);
            const { columns: cols, rows } = table(records, columns);
            return { query: echo, ...pageInfo(page, pageNum, pageSize, rows.length), rowCount: rows.length, columns: cols, rows };
          }
          const scanned = await scanPages((num, size) => list(cfg, { ...query, pageNum: num, pageSize: size }, callOpts(exec.signal)));
          let records = scanned.records;
          if (minDays !== undefined) records = records.filter((record) => (daysOf(record) ?? -1) >= minDays);
          // 没指定排序时按未跟进天数从多到少；指定了 createTime 就保持后端的新增时间倒序。
          const effectiveSort = sortBy ?? 'daysSinceLastFollow';
          if (effectiveSort === 'daysSinceLastFollow') records = sortRecords(records, 'daysSinceLastFollow', 'desc');
          const shown = records.slice(0, pageSize);
          const { columns: cols, rows } = table(shown, columns);
          return {
            query: echo,
            localFilter: {
              ...(minDays !== undefined ? { minDaysSinceFollow: minDays } : {}),
              sortBy: effectiveSort,
              scanned: scanned.scanned,
              scanTruncated: scanned.scanTruncated,
              matched: records.length,
            },
            total: scanned.total,
            rowCount: rows.length,
            truncated: records.length > rows.length,
            columns: cols,
            rows,
            ...(scanned.scanTruncated
              ? { note: `符合条件的记录共 ${scanned.total} 条，只扫描了前 ${scanned.scanned} 条；需要更准确时请加上名称、负责销售或新增时间等条件缩小范围。` }
              : {}),
          };
        });
      },
    });
  }

  registerAccountList({
    toolName: 'sales_query_customers',
    description:
      '查询客户列表（你有权查看的客户），返回客户ID、名称、行业、地区、负责销售、距上次跟进天数（最近一条日报到今天）和新增时间。找长时间没跟进的客户用 minDaysSinceFollow，例如 30。表格数据可交给 query_result_chart 展示。',
    nameKey: 'customerName',
    nameDescription: '可选：客户名称关键词，模糊匹配',
    extraKeys: ['industry'],
    columns: CUSTOMER_COLUMNS,
    list: (cfg, query, opts) => apiClient.listCustomers(cfg, query, opts),
  });

  registerAccountList({
    toolName: 'sales_query_channels',
    description:
      '查询渠道（合作伙伴公司）列表（你有权查看的渠道），返回渠道ID、公司名称、地区、负责销售、距上次跟进天数和新增时间。找长时间没跟进的渠道用 minDaysSinceFollow。',
    nameKey: 'companyName',
    nameDescription: '可选：渠道公司名称关键词，模糊匹配',
    extraKeys: [],
    columns: CHANNEL_COLUMNS,
    list: (cfg, query, opts) => apiClient.listChannels(cfg, query, opts),
  });

  // 工具 5：sales_query_projects
  const PROJECT_FILTER_KEYS = ['projectName', 'projectStatus', 'projectRisk', 'quarter', 'minAmount', 'maxAmount', 'salesId', 'salesName', 'includeArchived', 'createdFrom', 'createdTo'];
  const PROJECT_LIST_ONLY_KEYS = ['customerId', 'channelId', 'expectedSignFrom', 'expectedSignTo', 'minDaysSinceFollow', 'sortBy', 'sortOrder', 'pageNum', 'pageSize'];
  registerTool({
    name: 'sales_query_projects',
    description:
      '查询项目（商机）。mode="list"（默认）返回项目列表：项目阶段、风险、预计签约日期、预计金额（万元）、负责销售、客户、渠道、距上次跟进天数；mode="summary" 返回符合条件项目的总金额、必签金额、风险金额和项目数。注意：默认不含已签约和已丢单的项目，要看它们请设 includeArchived=true，或直接用 projectStatus="项目签约"/"项目丢单"。按预计签约日期区间筛选用 expectedSignFrom/expectedSignTo，按金额排序用 sortBy="expectedAmount"，这些会翻页扫描最多 500 条后在本地处理，并附带符合条件项目的金额小计。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['list', 'summary'], description: 'list 项目列表（默认）；summary 金额汇总' },
        projectName: { type: 'string', description: '可选：项目名称关键词，模糊匹配' },
        projectStatus: { type: 'string', enum: [...PROJECT_STATUSES], description: '可选：项目阶段，精确匹配' },
        projectRisk: { type: 'string', enum: [...PROJECT_RISKS], description: '可选：项目风险，精确匹配' },
        quarter: { type: 'integer', minimum: 1, maximum: 4, description: '可选：预计在今年第几季度签约（1-4，只算当年）' },
        minAmount: { type: 'number', minimum: 0, description: '可选：预计金额下限（万元）' },
        maxAmount: { type: 'number', minimum: 0, description: '可选：预计金额上限（万元）' },
        ...salesPersonProps,
        customerId: { type: 'integer', minimum: 1, description: 'mode="list" 可选：客户ID（用 sales_search 或 sales_query_customers 查）' },
        channelId: { type: 'integer', minimum: 1, description: 'mode="list" 可选：渠道ID' },
        includeArchived: { type: 'boolean', description: '可选：是否包含已签约、已丢单的项目，默认 false' },
        createdFrom: { type: 'string', description: '可选：项目新增时间起 YYYY-MM-DD' },
        createdTo: { type: 'string', description: '可选：项目新增时间止 YYYY-MM-DD' },
        expectedSignFrom: { type: 'string', description: 'mode="list" 可选：预计签约日期起 YYYY-MM-DD（本地筛选）' },
        expectedSignTo: { type: 'string', description: 'mode="list" 可选：预计签约日期止 YYYY-MM-DD（本地筛选）' },
        minDaysSinceFollow: { type: 'integer', minimum: 0, description: 'mode="list" 可选：只看距上次项目梳理至少这么多天的（本地筛选）' },
        sortBy: {
          type: 'string',
          enum: ['createTime', 'expectedAmount', 'expectedSignDate', 'daysSinceLastFollow'],
          description: 'mode="list" 可选：排序字段，默认 createTime（新增时间）',
        },
        sortOrder: { type: 'string', enum: ['desc', 'asc'], description: 'mode="list" 可选：desc 从大到小、从晚到早（默认）；asc 反过来' },
        ...pagingProps(PAGE_SIZE_MAX),
      },
    },
    async execute(args, exec) {
      rejectUnknown(args, ['mode', ...PROJECT_FILTER_KEYS, ...PROJECT_LIST_ONLY_KEYS], 'sales_query_projects');
      const mode = optEnum(args, 'mode', ['list', 'summary']) ?? 'list';
      if (mode === 'summary') rejectPresent(args, PROJECT_LIST_ONLY_KEYS, '只能在 mode="list" 时使用。');
      const projectStatus = optEnum(args, 'projectStatus', PROJECT_STATUSES);
      const filters = {
        projectName: optText(args, 'projectName'),
        projectStatus,
        projectRisk: optEnum(args, 'projectRisk', PROJECT_RISKS),
        quarter: optInt(args, 'quarter', 1, 4),
        minAmount: optAmount(args, 'minAmount'),
        maxAmount: optAmount(args, 'maxAmount'),
        // 查已签约或已丢单时，后端默认会把它们排除掉，所以自动带上 includeArchived。
        includeArchived: optBool(args, 'includeArchived') ?? (ARCHIVED_STATUSES.has(projectStatus) ? true : undefined),
        startDate: optDate(args, 'createdFrom'),
        endDate: optDate(args, 'createdTo'),
      };
      checkRange(filters.minAmount, filters.maxAmount, 'minAmount', 'maxAmount', '大于');
      checkRange(filters.startDate, filters.endDate, 'createdFrom', 'createdTo');
      const salesId = optInt(args, 'salesId', 1, Number.MAX_SAFE_INTEGER);
      const salesName = optText(args, 'salesName');
      const customerId = optInt(args, 'customerId', 1, Number.MAX_SAFE_INTEGER);
      const channelId = optInt(args, 'channelId', 1, Number.MAX_SAFE_INTEGER);
      const signFrom = optDate(args, 'expectedSignFrom');
      const signTo = optDate(args, 'expectedSignTo');
      checkRange(signFrom, signTo, 'expectedSignFrom', 'expectedSignTo');
      const minDays = optInt(args, 'minDaysSinceFollow', 0, 100_000);
      const sortBy = optEnum(args, 'sortBy', ['createTime', 'expectedAmount', 'expectedSignDate', 'daysSinceLastFollow']);
      const sortOrder = optEnum(args, 'sortOrder', ['desc', 'asc']);
      const pageNum = optInt(args, 'pageNum', 1, 100_000) ?? 1;
      const pageSize = optInt(args, 'pageSize', 1, PAGE_SIZE_MAX) ?? PAGE_SIZE_DEFAULT;
      // 后端只按新增时间倒序；其他排序、预计签约日期和跟进天数筛选都在本地做。
      const scan =
        signFrom !== undefined ||
        signTo !== undefined ||
        minDays !== undefined ||
        (sortBy !== undefined && sortBy !== 'createTime') ||
        sortOrder === 'asc';
      if (scan && args.pageNum !== undefined) throw invalid('用本地筛选或排序时不分页，只返回前 pageSize 条，请去掉 pageNum。');

      return viaBackend(async (cfg) => {
        const resolved = await resolvePerson(cfg, salesId, salesName, 'salesId', 'salesName', exec.signal);
        if (resolved.unresolved) return resolved.unresolved;
        const query = { ...filters, salesId: resolved.person?.userId };
        const echo = { ...query, ...(resolved.person ? { salesName: resolved.person.realName } : {}) };

        if (mode === 'summary') {
          const summary = (await apiClient.getProjectSummary(cfg, query, callOpts(exec.signal))) || {};
          return {
            mode,
            query: echo,
            unit: '万元',
            summary: {
              项目数: toNumber(summary.projectCount) ?? 0,
              '预计总金额（万元）': toNumber(summary.totalAmount) ?? 0,
              '必签项目金额（万元）': toNumber(summary.mustSignAmount) ?? 0,
              '有风险项目金额（万元）': toNumber(summary.riskAmount) ?? 0,
            },
          };
        }

        const listQuery = { ...query, customerId, channelId };
        const listEcho = { ...echo, customerId, channelId };
        if (!scan) {
          const page = await apiClient.listProjects(cfg, { ...listQuery, pageNum, pageSize }, callOpts(exec.signal));
          const { columns, rows } = table(recordsOf(page), PROJECT_COLUMNS);
          return { mode, query: listEcho, unit: '万元', ...pageInfo(page, pageNum, pageSize, rows.length), rowCount: rows.length, columns, rows };
        }

        const scanned = await scanPages((num, size) => apiClient.listProjects(cfg, { ...listQuery, pageNum: num, pageSize: size }, callOpts(exec.signal)));
        let records = scanned.records.filter((record) => {
          const signDay = dateText(record?.expectedSignDate, false);
          if (signFrom !== undefined && (!signDay || signDay < signFrom)) return false;
          if (signTo !== undefined && (!signDay || signDay > signTo)) return false;
          if (minDays !== undefined && (daysOf(record) ?? -1) < minDays) return false;
          return true;
        });
        const effectiveSort = sortBy ?? (minDays !== undefined ? 'daysSinceLastFollow' : 'createTime');
        records = sortRecords(records, effectiveSort, sortOrder ?? 'desc');
        const sumOf = (items) => round(items.reduce((acc, record) => acc + (toNumber(record?.expectedAmount) ?? 0), 0), 4);
        const byRisk = {};
        for (const risk of PROJECT_RISKS) byRisk[risk] = sumOf(records.filter((record) => record?.projectRisk === risk));
        const shown = records.slice(0, pageSize);
        const { columns, rows } = table(shown, PROJECT_COLUMNS);
        return {
          mode,
          query: listEcho,
          unit: '万元',
          localFilter: {
            ...(signFrom !== undefined ? { expectedSignFrom: signFrom } : {}),
            ...(signTo !== undefined ? { expectedSignTo: signTo } : {}),
            ...(minDays !== undefined ? { minDaysSinceFollow: minDays } : {}),
            sortBy: effectiveSort,
            sortOrder: sortOrder ?? 'desc',
            scanned: scanned.scanned,
            scanTruncated: scanned.scanTruncated,
            matched: records.length,
          },
          matchedSummary: { 项目数: records.length, '预计总金额（万元）': sumOf(records), '按风险分（万元）': byRisk },
          total: scanned.total,
          rowCount: rows.length,
          truncated: records.length > rows.length,
          columns,
          rows,
          ...(scanned.scanTruncated
            ? { note: `符合后端条件的项目共 ${scanned.total} 条，只扫描了前 ${scanned.scanned} 条（按新增时间从新到旧）；需要更准确时请加上项目阶段、风险、季度、负责销售等条件缩小范围。` }
            : {}),
        };
      });
    },
  });

  // 工具 6：sales_dashboard
  registerTool({
    name: 'sales_dashboard',
    description:
      '查看销售看板（金额单位都是万元）。view="home"：本月签约金额、签约数、新增客户和渠道数、本月完成率和每日签约趋势（部门范围）；view="sales"：销售目标完成情况，period 选 year/quarter/month，scopeType 选 personal（自己，默认）或 team（团队，含各部门目标和完成），返回目标、已完成、完成率和还差多少；view="opportunity"：商机储备金额（总额、时间风险、赢单风险、必签），按 period 统计；view="market"：新增项目数和金额，按 period 统计。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        view: { type: 'string', enum: ['home', 'sales', 'opportunity', 'market'], description: '看板类型' },
        period: { type: 'string', enum: ['year', 'quarter', 'month'], description: 'view 为 sales/opportunity/market 时可选：统计周期（本年、本季度、本月）。默认 sales、market 为 year，opportunity 为 quarter' },
        scopeType: { type: 'string', enum: ['personal', 'team'], description: 'view="sales" 时可选：personal 自己（默认）；team 团队' },
      },
      required: ['view'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['view', 'period', 'scopeType'], 'sales_dashboard');
      const view = optEnum(args, 'view', ['home', 'sales', 'opportunity', 'market']);
      if (!view) throw invalid('sales_dashboard 需要 view：home、sales、opportunity 或 market。');
      if (view === 'home') rejectPresent(args, ['period', 'scopeType'], '不适用于 view="home"（首页固定看本月）。');
      if (view !== 'sales') rejectPresent(args, ['scopeType'], '只能在 view="sales" 时使用。');
      const period = optEnum(args, 'period', ['year', 'quarter', 'month']) ?? (view === 'opportunity' ? 'quarter' : 'year');
      const scopeType = optEnum(args, 'scopeType', ['personal', 'team']) ?? 'personal';
      const base = { view, viewLabel: DASHBOARD_LABELS[view], unit: '万元' };

      return viaBackend(async (cfg) => {
        const opts = callOpts(exec.signal);
        if (view === 'home') {
          const data = (await apiClient.getHomeDashboard(cfg, opts)) || {};
          const trend = Array.isArray(data.dailyTrend) ? data.dailyTrend : [];
          const { columns, rows } = table(trend, [
            ['日期', (r) => dateText(r.date, false)],
            ['签约金额（万元）', (r) => toNumber(r.amount) ?? 0],
            ['签约项目数', (r) => toNumber(r.count) ?? 0],
          ]);
          return {
            ...base,
            summary: {
              '本月签约金额（万元）': toNumber(data.monthSalesAmount) ?? 0,
              本月签约项目数: toNumber(data.monthOrderCount) ?? 0,
              本月新增客户数: toNumber(data.monthNewCustomerCount) ?? 0,
              本月新增渠道数: toNumber(data.monthNewChannelCount) ?? 0,
              '年度目标（万元）': toNumber(data.monthTargetAmount) ?? 0,
              '本月签约占年度目标（%）': toNumber(data.monthCompletionRate) ?? 0,
            },
            columns,
            rows,
          };
        }
        if (view === 'sales') {
          // 不传 salesId：后端不校验它是否在数据范围内，只看自己或自己的团队。
          const data = (await apiClient.getSalesDashboard(cfg, { period, scopeType }, opts)) || {};
          const annual = toNumber(data.annualTarget) ?? 0;
          const quarterTarget = toNumber(data.quarterTarget) ?? 0;
          const completed = toNumber(data.completedAmount) ?? 0;
          const periodTarget = period === 'quarter' ? quarterTarget : period === 'month' ? round(annual / 12, 4) : annual;
          const teams = Array.isArray(data.teamTargets) ? data.teamTargets : [];
          const { columns, rows } = table(teams, [
            ['部门', (r) => text(r.deptName)],
            ['年度目标（万元）', (r) => toNumber(r.annualTarget) ?? 0],
            ['已完成（万元）', (r) => toNumber(r.completedAmount) ?? 0],
            ['完成率（%）', (r) => toNumber(r.completionRate) ?? 0],
          ]);
          return {
            ...base,
            period,
            periodLabel: PERIOD_LABELS[period],
            scopeType,
            scopeLabel: scopeType === 'team' ? '团队' : '个人',
            summary: {
              '年度目标（万元）': annual,
              '本季度目标（万元）': quarterTarget,
              [`${PERIOD_LABELS[period]}目标（万元）`]: periodTarget,
              [`${PERIOD_LABELS[period]}已完成（万元）`]: completed,
              '完成率（%）': toNumber(data.completionRate) ?? 0,
              '还差（万元）': round(Math.max(0, periodTarget - completed), 4),
            },
            note: '已完成金额按预计签约日期落在统计周期内、阶段为「项目签约」的项目计算；本月目标按年度目标除以 12。',
            ...(rows.length ? { columns, rows } : {}),
          };
        }
        if (view === 'opportunity') {
          const data = (await apiClient.getOpportunityDashboard(cfg, { period }, opts)) || {};
          return {
            ...base,
            period,
            periodLabel: PERIOD_LABELS[period],
            summary: {
              '商机总金额（万元）': toNumber(data.totalAmount) ?? 0,
              '必签项目金额（万元）': toNumber(data.mustSignAmount) ?? 0,
              '时间风险金额（万元）': toNumber(data.timeRiskAmount) ?? 0,
              '赢单风险金额（万元）': toNumber(data.winRiskAmount) ?? 0,
            },
            note: '统计预计签约日期在统计周期开始之后的商机，包含已签约和已丢单的项目。',
          };
        }
        const data = (await apiClient.getMarketDashboard(cfg, { period }, opts)) || {};
        return {
          ...base,
          period,
          periodLabel: PERIOD_LABELS[period],
          summary: {
            新增项目数: toNumber(data.newProjectCount) ?? 0,
            '新增项目金额（万元）': toNumber(data.newProjectAmount) ?? 0,
          },
          note: '按项目新增时间落在统计周期内统计。',
        };
      });
    },
  });

  // 工具 7：sales_query_work_reports
  const DAILY_KEYS = ['targetType', 'targetId', 'startDate', 'endDate', 'pageNum', 'pageSize'];
  const WEEK_KEYS = ['weekStartDate'];
  registerTool({
    name: 'sales_query_work_reports',
    description:
      '查询工作汇报。mode="daily"（默认）：日报列表，每条是一次对客户或渠道的拜访/跟进，含日期、汇报人、对象、联系人、工作计划和工作总结，可按对象（targetType + targetId）、日期区间、汇报人筛选；mode="weekly_reports"：某一周的周报（计划条目、工作总结、补充说明）；mode="weekly_plan"：某人某一周的周计划。weekStartDate 填这一周里的任意一天即可，默认本周。不填汇报人时，日报和周报返回你能查看的所有人的。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['daily', 'weekly_reports', 'weekly_plan'], description: 'daily 日报（默认）；weekly_reports 周报；weekly_plan 周计划' },
        targetType: { type: 'string', enum: ['customer', 'channel'], description: 'mode="daily" 可选：跟进对象类型' },
        targetId: { type: 'integer', minimum: 1, description: 'mode="daily" 可选：客户ID或渠道ID，需同时给 targetType' },
        startDate: { type: 'string', description: 'mode="daily" 可选：日报日期起 YYYY-MM-DD' },
        endDate: { type: 'string', description: 'mode="daily" 可选：日报日期止 YYYY-MM-DD' },
        reporterId: { type: 'integer', minimum: 1, description: '可选：汇报人ID（可用 sales_search(target="people") 查）；weekly_plan 不填就是自己' },
        reporterName: { type: 'string', description: '可选：汇报人姓名或用户名' },
        weekStartDate: { type: 'string', description: 'mode 为 weekly_reports / weekly_plan 时可选：这一周里的任意一天 YYYY-MM-DD，默认今天' },
        pageNum: { type: 'integer', minimum: 1, description: '页码，默认 1（weekly_plan 不分页）' },
        pageSize: { type: 'integer', minimum: 1, maximum: REPORT_PAGE_SIZE_MAX, description: `每页条数，默认 ${PAGE_SIZE_DEFAULT}，最大 ${REPORT_PAGE_SIZE_MAX}` },
      },
    },
    async execute(args, exec) {
      rejectUnknown(args, ['mode', 'reporterId', 'reporterName', ...DAILY_KEYS, ...WEEK_KEYS], 'sales_query_work_reports');
      const mode = optEnum(args, 'mode', ['daily', 'weekly_reports', 'weekly_plan']) ?? 'daily';
      const reporterId = optInt(args, 'reporterId', 1, Number.MAX_SAFE_INTEGER);
      const reporterName = optText(args, 'reporterName');
      const pageNum = optInt(args, 'pageNum', 1, 100_000) ?? 1;
      const pageSize = optInt(args, 'pageSize', 1, REPORT_PAGE_SIZE_MAX) ?? PAGE_SIZE_DEFAULT;

      if (mode === 'daily') {
        rejectPresent(args, WEEK_KEYS, '只能在 mode 为 weekly_reports 或 weekly_plan 时使用。');
        const targetType = optEnum(args, 'targetType', ['customer', 'channel']);
        const targetId = optInt(args, 'targetId', 1, Number.MAX_SAFE_INTEGER);
        if (targetId !== undefined && targetType === undefined) throw invalid('按对象查日报时，targetId 要和 targetType（customer 或 channel）一起给。');
        const startDate = optDate(args, 'startDate');
        const endDate = optDate(args, 'endDate');
        checkRange(startDate, endDate, 'startDate', 'endDate');
        return viaBackend(async (cfg) => {
          const resolved = await resolvePerson(cfg, reporterId, reporterName, 'reporterId', 'reporterName', exec.signal);
          if (resolved.unresolved) return resolved.unresolved;
          const query = {
            targetType: targetType ? TARGET_TYPE_CODES[targetType] : undefined,
            targetId,
            startDate,
            endDate,
            reporterId: resolved.person?.userId,
          };
          const page = await apiClient.listWorkReports(cfg, { ...query, pageNum, pageSize }, callOpts(exec.signal));
          const { columns, rows } = table(recordsOf(page), DAILY_REPORT_COLUMNS);
          return {
            mode,
            query: { ...query, ...(targetType ? { targetType } : {}), ...(resolved.person ? { reporterName: resolved.person.realName } : {}) },
            ...pageInfo(page, pageNum, pageSize, rows.length),
            rowCount: rows.length,
            columns,
            rows,
          };
        });
      }

      rejectPresent(args, ['targetType', 'targetId', 'startDate', 'endDate'], '只能在 mode="daily" 时使用。');
      if (mode === 'weekly_plan') rejectPresent(args, ['pageNum', 'pageSize'], '不适用于 mode="weekly_plan"（只返回一份周计划）。');
      const weekStartDate = mondayOf(optDate(args, 'weekStartDate') ?? localDay(now()));
      return viaBackend(async (cfg) => {
        const resolved = await resolvePerson(cfg, reporterId, reporterName, 'reporterId', 'reporterName', exec.signal);
        if (resolved.unresolved) return resolved.unresolved;
        const query = { weekStartDate, reporterId: resolved.person?.userId };
        const echo = { ...query, ...(resolved.person ? { reporterName: resolved.person.realName } : {}) };
        if (mode === 'weekly_plan') {
          const plan = (await apiClient.getWeeklyPlan(cfg, query, callOpts(exec.signal))) || {};
          const items = planItemsOf(plan);
          return {
            mode,
            query: echo,
            reporterId: toNumber(plan.reporterId),
            reporterName: text(plan.reporterName),
            weekStartDate: dateText(plan.weekStartDate, false) || weekStartDate,
            weekEndDate: dateText(plan.weekEndDate, false),
            planItems: items,
            ...(items.length ? {} : { note: '这一周还没有填写周计划。' }),
          };
        }
        const page = await apiClient.listWeeklyReports(cfg, { ...query, pageNum, pageSize }, callOpts(exec.signal));
        const { columns, rows } = table(recordsOf(page), WEEKLY_REPORT_COLUMNS);
        return { mode, query: echo, ...pageInfo(page, pageNum, pageSize, rows.length), rowCount: rows.length, columns, rows };
      });
    },
  });

  // 工具 8：sales_targets
  registerTool({
    name: 'sales_targets',
    description:
      '查看销售目标（金额单位万元）。scope="personal"（默认）：自己某年的年度目标和四个季度目标；scope="team"：你能查看的各部门某年的年度目标、已完成金额和完成率。想知道自己完成了多少、还差多少，用 sales_dashboard(view="sales")。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['personal', 'team'], description: 'personal 自己（默认）；team 各部门' },
        year: { type: 'integer', minimum: 2000, maximum: 2100, description: '可选：年份，默认今年' },
      },
    },
    async execute(args, exec) {
      rejectUnknown(args, ['scope', 'year'], 'sales_targets');
      const scope = optEnum(args, 'scope', ['personal', 'team']) ?? 'personal';
      const year = optInt(args, 'year', 2000, 2100) ?? new Date(now()).getFullYear();
      return viaBackend(async (cfg) => {
        if (scope === 'personal') {
          const data = (await apiClient.getPersonalTargets(cfg, { year }, callOpts(exec.signal))) || {};
          const quarters = [1, 2, 3, 4].map((q) => ({ quarter: q, amount: toNumber(data[`q${q}Amount`]) ?? 0 }));
          const { columns, rows } = table(quarters, [
            ['季度', (r) => `第${r.quarter}季度`],
            ['目标（万元）', (r) => r.amount],
          ]);
          const annual = toNumber(data.annualTarget) ?? 0;
          return {
            scope,
            year,
            unit: '万元',
            annualTarget: annual,
            columns,
            rows,
            ...(annual === 0 ? { note: `${year} 年还没有给你设置个人销售目标。` } : {}),
          };
        }
        const list = await apiClient.getTeamTargets(cfg, { year }, callOpts(exec.signal));
        const { columns, rows } = table(Array.isArray(list) ? list : [], [
          ['部门ID', (r) => toNumber(r.targetId)],
          ['部门', (r) => text(r.deptName)],
          ['年度目标（万元）', (r) => toNumber(r.annualTarget) ?? 0],
          ['已完成（万元）', (r) => toNumber(r.completedAmount) ?? 0],
          ['完成率（%）', (r) => toNumber(r.completionRate) ?? 0],
        ]);
        return { scope, year, unit: '万元', rowCount: rows.length, columns, rows };
      });
    },
  });

  // 工具 9：sales_draft_work_report（只生成草稿，用户在卡片上点「提交日报」才写入）
  registerTool({
    name: 'sales_draft_work_report',
    description:
      '为用户起草一条工作日报（对一个客户或渠道的一次拜访/跟进记录），在对话里显示「日报草稿」卡片。这个工具不会写入任何数据：用户在卡片上核对、修改后点「提交日报」，才以用户本人的名义新建日报。拜访对象先用 sales_search 拿到客户或渠道的 ID；拜访人用 contactId 或 contactName 指定，不确定就不填，让用户在卡片上选。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reportDate: { type: 'string', description: '拜访日期 YYYY-MM-DD，默认今天' },
        targetType: { type: 'string', enum: ['customer', 'channel'], description: '拜访对象类型：customer 客户，channel 渠道' },
        targetId: { type: 'integer', minimum: 1, description: '客户ID或渠道ID（用 sales_search 查）' },
        contactId: { type: 'integer', minimum: 1, description: '可选：拜访人（联系人）ID' },
        contactName: { type: 'string', description: '可选：拜访人姓名，和该客户或渠道的联系人精确匹配' },
        workPlan: { type: 'string', description: `工作计划：用户说的下一步打算，照原话写、只改错别字，最多 ${MAX_REPORT_TEXT_LENGTH} 字` },
        workSummary: { type: 'string', description: `工作总结：用户说的这次拜访做了什么，照原话写、只改错别字，不扩写，最多 ${MAX_REPORT_TEXT_LENGTH} 字` },
      },
      required: ['targetType', 'targetId', 'workPlan', 'workSummary'],
    },
    async execute(args, exec) {
      rejectUnknown(
        args,
        ['reportDate', 'targetType', 'targetId', 'contactId', 'contactName', 'workPlan', 'workSummary'],
        'sales_draft_work_report',
      );
      const reportDate = optDate(args, 'reportDate') ?? localDay(now());
      const targetKey = optEnum(args, 'targetType', ['customer', 'channel']);
      const targetId = optInt(args, 'targetId', 1, Number.MAX_SAFE_INTEGER);
      if (targetKey === undefined || targetId === undefined) throw invalid('请给出拜访对象：targetType（customer 或 channel）和 targetId。');
      const contactId = optInt(args, 'contactId', 1, Number.MAX_SAFE_INTEGER);
      const contactName = optText(args, 'contactName');
      const texts = {};
      for (const [key, label] of [['workPlan', '工作计划'], ['workSummary', '工作总结']]) {
        const value = typeof args[key] === 'string' ? args[key].trim() : '';
        if (!value) throw invalid(`${label}（${key}）不能为空。`);
        if (value.length > MAX_REPORT_TEXT_LENGTH) throw invalid(`${label}（${key}）不能超过 ${MAX_REPORT_TEXT_LENGTH} 个字。`);
        texts[key] = value;
      }
      const targetType = TARGET_TYPE_CODES[targetKey];

      return viaBackend(async (cfg) => {
        const isCustomer = targetType === 1;
        const [target, contactList] = await Promise.all([
          isCustomer ? apiClient.getCustomer(cfg, targetId, callOpts(exec.signal)) : apiClient.getChannel(cfg, targetId, callOpts(exec.signal)),
          isCustomer
            ? apiClient.listCustomerContacts(cfg, targetId, callOpts(exec.signal))
            : apiClient.listChannelContacts(cfg, targetId, callOpts(exec.signal)),
        ]);
        const targetName = text(isCustomer ? target?.customerName : target?.companyName) || `${TARGET_TYPE_LABELS[targetType]} ${targetId}`;
        const contacts = (Array.isArray(contactList) ? contactList : [])
          .map((contact) => ({ contactId: toNumber(contact?.id), contactName: text(contact?.contactName), position: text(contact?.position) }))
          .filter((contact) => Number.isSafeInteger(contact.contactId));

        let chosen = null;
        const notes = [];
        if (contactId !== undefined) {
          chosen = contacts.find((contact) => contact.contactId === contactId) || null;
          if (!chosen) notes.push(`联系人 ${contactId} 不是「${targetName}」的联系人，请用户在卡片上选择拜访人。`);
        } else if (contactName !== undefined) {
          const matched = contacts.filter((contact) => contact.contactName === contactName);
          if (matched.length === 1) chosen = matched[0];
          else notes.push(`「${targetName}」的联系人里${matched.length ? `有 ${matched.length} 位叫「${contactName}」` : `没有「${contactName}」`}，请用户在卡片上选择拜访人。`);
        } else if (contacts.length === 1) {
          chosen = contacts[0];
        }
        if (!contacts.length) notes.push(`「${targetName}」还没有联系人：要先在销售管理系统网页里添加联系人，才能提交这条日报。`);

        const draftId = `report_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const draft = { reportDate, targetType, targetName, targetId, contactId: chosen ? chosen.contactId : null, ...texts };
        const { session, turn } = sessionTurnOf(exec.agent?.id || null, exec.callId);
        stageReport({
          draftId,
          serverUrl: cfg.serverUrl,
          accountId: cfg.accountId,
          session,
          turn,
          draft,
          contacts,
          status: 'staged',
        });
        return {
          kind: REPORT_DRAFT_KIND,
          draftId,
          status: 'staged',
          draft: { ...draft, targetTypeLabel: TARGET_TYPE_LABELS[targetType] },
          contacts,
          notes,
          hint: '日报草稿已显示在卡片上，还没有提交。请用户核对后点卡片上的「提交日报」；不要说已经提交，也不要自己再调用任何工具去提交。',
        };
      });
    },
  });

  // 工具 10～16：查看详情、新建和修改、删除和移交（删除和移交要用户在卡片上确认）
  const writes = registerWriteTools({
    registerTool,
    apiClient,
    accounts,
    viaBackend,
    callOpts,
    resolvePerson,
    sessionTurnOf,
    appendPluginRecord,
    now,
  });

  // ---------- 3. 宿主 RPC（设置页、插件页、授权卡片、日报卡片和确认卡片用） ----------
  const remote = registerSalesforgeRemote(ctx, {
    ...(hostTypert || {}),
    ...(deps.typert || {}),
    accounts,
    submitReportDraft,
    confirmAction: writes.confirmAction,
    cancelAction: writes.cancelAction,
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 忽略清理时的错误。
        }
      }
    }, '@local/salesforge: cleanup');
  }

  return {
    accounts,
    remoteHandlers: remote.handlers,
    stagedReports,
    submitReportDraft,
    pendingActions: writes.pendingActions,
    confirmAction: writes.confirmAction,
    cancelAction: writes.cancelAction,
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 忽略。
        }
      }
    },
  };
}

export function apply(ctx) {
  return setupSalesforge(ctx);
}
