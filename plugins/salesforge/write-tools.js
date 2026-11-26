// 改数据的工具：查看一条记录的详情、新建和修改客户/渠道/联系人/项目/日报/周报/销售目标，
// 以及删除和移交。新建、修改直接执行；删除和移交只在对话里显示确认卡片，用户点了「确认删除」「确认移交」才执行。
import { randomUUID } from 'node:crypto';
import { ApiError, safeErrorMessage } from './api-client.js';
import { dateText, invalid, isRealDate, optAmount, optBool, optDate, optEnum, optInt, optText, rejectUnknown, text, toNumber } from './args.js';

export const ACTION_PENDING_KIND = 'salesforge-action-pending';
export const ACTION_DONE_KIND = 'salesforge-action-done';
export const ACTION_RECORD_TYPE = 'plugin:salesforge/action-done';

// 待确认的删除和移交只放在内存里：小智办公重启后失效，要让助手重新发起。
const MAX_PENDING_ACTIONS = 50;
const MAX_ACTION_IDS = 20;
const MAX_LONG_TEXT = 2000;
const MAX_FIELD_TEXT = 200;
const MAX_PLAN_ITEMS = 30;
const ID_MAX = Number.MAX_SAFE_INTEGER;

const PROJECT_STATUSES = ['发现问题', '技术预研', '方案论证', '立项审批', '启动采购', '制定标准', '商务招标', '项目签约', '项目丢单'];
const PROJECT_RISKS = ['必签项目', '时间风险', '赢单风险'];

const ORGS = Object.freeze({
  customer: { kind: 'customers', label: '客户', nameKey: 'customerName', deptKey: 'customerDeptId', code: 1 },
  channel: { kind: 'channels', label: '渠道', nameKey: 'companyName', deptKey: 'channelDeptId', code: 2 },
});
const ORG_BY_CODE = { 1: 'customer', 2: 'channel' };

// ---------- 参数 ----------

/** 可选的文字字段：没给是 undefined；给了空字符串表示清空（返回 ''）。 */
function optField(args, key, max = MAX_FIELD_TEXT) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${key} 必须是字符串。`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${key} 太长了，最多 ${max} 个字。`);
  return trimmed;
}

function needId(args, key, why) {
  const value = optInt(args, key, 1, ID_MAX);
  if (value === undefined) throw invalid(`${why}要给 ${key}。`);
  return value;
}

function needText(value, key, label) {
  if (!value) throw invalid(`${label}（${key}）不能为空。`);
  return value;
}

function optIds(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > MAX_ACTION_IDS || !list.every((id) => Number.isInteger(id) && id >= 1 && id <= ID_MAX)) {
    throw invalid(`${key} 要给 1 到 ${MAX_ACTION_IDS} 个正整数 ID。`);
  }
  return [...new Set(list)];
}

/** 只用于说明：「谁 · 改了什么」的前后对照。 */
function changesOf(before, after, labels) {
  const changes = [];
  for (const [key, label] of Object.entries(labels)) {
    const from = before[key] ?? '';
    const to = after[key] ?? '';
    if (String(from) !== String(to)) changes.push({ field: label, before: from, after: to });
  }
  return changes;
}

/** 改动说明里的客户或渠道：有名称写「客户「华光科技」」，没有就写「客户 12」。 */
const orgLabel = (org, name, id) => {
  const label = ORGS[org]?.label ?? '';
  return text(name) ? `${label}「${text(name)}」` : `${label} ${id ?? ''}`.trim();
};

const firstLine = (value, max = 40) => {
  const line = text(value).replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

function contactRows(list, depts = []) {
  const deptName = new Map(depts.map((dept) => [dept.deptId, dept.deptName]));
  return (Array.isArray(list) ? list : [])
    .map((contact) => {
      const deptId = toNumber(contact?.customerDeptId ?? contact?.channelDeptId);
      return {
        contactId: toNumber(contact?.id),
        contactName: text(contact?.contactName),
        position: text(contact?.position),
        deptId,
        deptName: deptId != null ? deptName.get(deptId) || '' : '',
      };
    })
    .filter((contact) => Number.isSafeInteger(contact.contactId));
}

function deptRows(list) {
  return (Array.isArray(list) ? list : [])
    .map((dept) => ({ deptId: toNumber(dept?.id), deptName: text(dept?.deptName) }))
    .filter((dept) => Number.isSafeInteger(dept.deptId));
}

/** 按 ID 或姓名在联系人里找一位；找不到或有重名时报错，并列出能选的联系人。 */
function pickContact(contacts, contactId, contactName, ownerLabel) {
  const options = contacts.map((c) => `${c.contactName}（contactId ${c.contactId}${c.position ? `，${c.position}` : ''}）`).join('、');
  if (contactId !== undefined) {
    const found = contacts.find((c) => c.contactId === contactId);
    if (found) return found;
    throw invalid(`联系人 ${contactId} 不是${ownerLabel}的联系人。${options ? `可选：${options}。` : `${ownerLabel}还没有联系人。`}`);
  }
  const matched = contacts.filter((c) => c.contactName === contactName);
  if (matched.length === 1) return matched[0];
  throw invalid(
    matched.length
      ? `${ownerLabel}有 ${matched.length} 位联系人叫「${contactName}」，请改用 contactId：${options}。`
      : `${ownerLabel}的联系人里没有「${contactName}」。${options ? `可选：${options}。` : `${ownerLabel}还没有联系人，可以先用 sales_save_customer(action="add_contact") 添加。`}`,
  );
}

function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function localDay(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------- 注册 ----------

/**
 * deps：registerTool、apiClient、accounts、viaBackend、callOpts、resolvePerson、sessionTurnOf、appendPluginRecord、now。
 * 返回卡片 RPC 要用的 confirmAction / cancelAction，以及暂存表（单测用）。
 */
export function registerWriteTools(deps) {
  const { registerTool, apiClient, accounts, viaBackend, callOpts, resolvePerson, sessionTurnOf, now } = deps;
  const appendPluginRecord = deps.appendPluginRecord;
  const pendingActions = new Map();

  async function loadOrg(cfg, org, id, signal) {
    const isCustomer = org === 'customer';
    const [record, contacts, depts] = await Promise.all([
      isCustomer ? apiClient.getCustomer(cfg, id, callOpts(signal)) : apiClient.getChannel(cfg, id, callOpts(signal)),
      isCustomer ? apiClient.listCustomerContacts(cfg, id, callOpts(signal)) : apiClient.listChannelContacts(cfg, id, callOpts(signal)),
      apiClient.listOrgDepts(cfg, ORGS[org].kind, id, callOpts(signal)),
    ]);
    const deptList = deptRows(depts);
    return {
      raw: record || {},
      name: text(record?.[ORGS[org].nameKey]) || `${ORGS[org].label} ${id}`,
      contacts: contactRows(contacts, deptList),
      rawContacts: Array.isArray(contacts) ? contacts : [],
      depts: deptList,
    };
  }

  async function loadContacts(cfg, org, id, signal) {
    const list = org === 'customer'
      ? await apiClient.listCustomerContacts(cfg, id, callOpts(signal))
      : await apiClient.listChannelContacts(cfg, id, callOpts(signal));
    return contactRows(list);
  }

  // 下面两个只用于写入完成后说明改了什么：查不到就退回写 ID，不报错。
  async function orgNameOf(cfg, org, id, signal) {
    const record = await (org === 'customer' ? apiClient.getCustomer(cfg, id, callOpts(signal)) : apiClient.getChannel(cfg, id, callOpts(signal))).catch(() => null);
    return text(record?.[ORGS[org].nameKey]);
  }

  async function contactNameOf(cfg, org, orgId, contactId, signal) {
    if (!orgId || !contactId) return '';
    const list = await loadContacts(cfg, org, orgId, signal).catch(() => []);
    return list.find((c) => c.contactId === contactId)?.contactName || `联系人 ${contactId}`;
  }

  /** 项目的有效产品名（启用状态）。product 参数可以用顿号、逗号分隔多个。 */
  async function normalizeProducts(cfg, value, signal) {
    const names = value.split(/[,，、;；\s]+/u).map((name) => name.trim()).filter(Boolean);
    if (!names.length) throw invalid('product 至少要有一个产品名。');
    const page = await apiClient.listProducts(cfg, { status: 1, pageNum: 1, pageSize: 200 }, callOpts(signal));
    const known = (Array.isArray(page?.records) ? page.records : Array.isArray(page) ? page : []).map((p) => text(p?.productName)).filter(Boolean);
    const unknown = names.filter((name) => !known.includes(name));
    if (known.length && unknown.length) {
      throw invalid(`产品「${unknown.join('、')}」不在销售管理系统的产品列表里。可选产品：${known.join('、')}。`);
    }
    return [...new Set(names)].join(',');
  }

  // ---------- 工具：sales_get_record ----------
  registerTool({
    name: 'sales_get_record',
    description:
      '查看一条记录的详情，修改或删除前先用它拿到 ID 和现有内容。type="customer" / "channel"：客户或渠道的名称、行业、地址、负责销售，以及联系人（contactId、姓名、职位、所属部门）和部门（deptId）；type="project"：项目的全部字段、项目梳理记录（reviewId）和项目分析；type="work_report"：一条日报的全部内容。不返回联系人电话。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['customer', 'channel', 'project', 'work_report'], description: '记录类型' },
        id: { type: 'integer', minimum: 1, description: '客户ID、渠道ID、项目ID或日报ID' },
      },
      required: ['type', 'id'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['type', 'id'], 'sales_get_record');
      const type = optEnum(args, 'type', ['customer', 'channel', 'project', 'work_report']);
      if (!type) throw invalid('请给出 type。');
      const id = needId(args, 'id', '查看详情');
      const signal = exec.signal;
      return viaBackend(async (cfg) => {
        if (type === 'customer' || type === 'channel') {
          const org = await loadOrg(cfg, type, id, signal);
          const r = org.raw;
          return {
            type,
            id,
            name: org.name,
            ...(type === 'customer' ? { industry: text(r.industry) } : {}),
            address: text(r.address),
            addressDetail: text(r.addressDetail),
            salesId: toNumber(r.salesId),
            salesName: text(r.salesName),
            createTime: dateText(r.createTime, false),
            contacts: org.contacts,
            depts: org.depts,
          };
        }
        if (type === 'project') {
          const [p, reviews, analysis] = await Promise.all([
            apiClient.getProject(cfg, id, callOpts(signal)),
            apiClient.listProjectReviews(cfg, id, callOpts(signal)),
            apiClient.getProjectAnalysis(cfg, id, callOpts(signal)),
          ]);
          const project = p || {};
          const customerId = toNumber(project.customerId);
          const channelId = toNumber(project.channelId);
          const [customerContacts, channelContacts] = await Promise.all([
            customerId ? loadContacts(cfg, 'customer', customerId, signal).catch(() => []) : [],
            channelId ? loadContacts(cfg, 'channel', channelId, signal).catch(() => []) : [],
          ]);
          const contactName = (list, contactId) => list.find((c) => c.contactId === toNumber(contactId))?.contactName || '';
          return {
            type,
            id,
            projectName: text(project.projectName),
            customerId,
            customerName: text(project.customerName),
            customerContactId: toNumber(project.customerContactId),
            customerContactName: contactName(customerContacts, project.customerContactId),
            channelId,
            channelName: text(project.channelName),
            channelContactId: toNumber(project.channelContactId),
            channelContactName: contactName(channelContacts, project.channelContactId),
            product: text(project.product),
            projectStatus: text(project.projectStatus),
            projectRisk: text(project.projectRisk),
            expectedSignDate: dateText(project.expectedSignDate, false),
            expectedAmount: toNumber(project.expectedAmount),
            amountUnit: '万元',
            remark: text(project.remark),
            salesId: toNumber(project.salesId),
            salesName: text(project.salesName),
            reviews: (Array.isArray(reviews) ? reviews : []).map((review) => ({
              reviewId: toNumber(review?.id),
              content: text(review?.content),
              reviewTime: dateText(review?.reviewTime, true),
            })),
            analysis: analysis
              ? {
                  demand: text(analysis.demand),
                  techApproval: text(analysis.techApproval),
                  decisionChain: text(analysis.decisionChain),
                  partner: text(analysis.partner),
                  competitor: text(analysis.competitor),
                }
              : null,
          };
        }
        const report = (await apiClient.getWorkReport(cfg, id, callOpts(signal))) || {};
        const targetType = ORG_BY_CODE[toNumber(report.targetType)] || null;
        return {
          type,
          id,
          reportDate: dateText(report.reportDate, false),
          reporterId: toNumber(report.reporterId),
          reporterName: text(report.realName),
          targetType,
          targetTypeLabel: targetType ? ORGS[targetType].label : '',
          targetId: toNumber(report.targetId),
          targetName: text(report.targetName),
          contactId: toNumber(report.contactId),
          contactName: text(report.contactName),
          workSummary: text(report.workSummary),
          workPlan: text(report.workPlan),
        };
      });
    },
  });

  // ---------- 工具：sales_save_customer ----------
  const ORG_KEYS = ['action', 'targetType', 'targetId', 'name', 'industry', 'address', 'addressDetail', 'contactId', 'contactName', 'position', 'phone', 'deptId', 'deptName'];
  registerTool({
    name: 'sales_save_customer',
    description:
      '新建或修改客户、渠道和它们的联系人、部门，以用户本人的名义直接写入销售管理系统（删除请用 sales_delete，移交负责人请用 sales_transfer）。action="create" 新建客户或渠道（name 必填，客户可填 industry）；"update" 修改名称、行业、地址，只改给出的字段；"add_contact" 给客户或渠道添加联系人（contactName 必填，可填 position、phone、deptId）；"update_contact" 修改联系人，只改给出的字段；"add_dept" 添加部门（deptName）。联系人和部门的 ID 用 sales_get_record 查。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'add_contact', 'update_contact', 'add_dept'], description: '要做的操作' },
        targetType: { type: 'string', enum: ['customer', 'channel'], description: 'customer 客户，channel 渠道' },
        targetId: { type: 'integer', minimum: 1, description: '客户ID或渠道ID：create 以外都要给' },
        name: { type: 'string', description: 'create / update：客户名称或渠道名称' },
        industry: { type: 'string', description: 'create / update，只对客户：行业，例如 政府、教育、企业、金融、医疗' },
        address: { type: 'string', description: 'create / update：所在地区或地址' },
        addressDetail: { type: 'string', description: 'create / update：详细地址' },
        contactId: { type: 'integer', minimum: 1, description: 'update_contact：要修改的联系人ID' },
        contactName: { type: 'string', description: 'add_contact / update_contact：联系人姓名' },
        position: { type: 'string', description: 'add_contact / update_contact：职位，给空字符串表示清空' },
        phone: { type: 'string', description: 'add_contact / update_contact：电话，给空字符串表示清空' },
        deptId: { type: 'integer', minimum: 1, description: 'add_contact / update_contact：联系人所属部门ID（这个客户或渠道下的部门）' },
        deptName: { type: 'string', description: 'add_dept：部门名称' },
      },
      required: ['action', 'targetType'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ORG_KEYS, 'sales_save_customer');
      const action = optEnum(args, 'action', ['create', 'update', 'add_contact', 'update_contact', 'add_dept']);
      const org = optEnum(args, 'targetType', ['customer', 'channel']);
      if (!action || !org) throw invalid('请给出 action 和 targetType。');
      const meta = ORGS[org];
      const fields = {
        name: optField(args, 'name'),
        industry: optField(args, 'industry'),
        address: optField(args, 'address'),
        addressDetail: optField(args, 'addressDetail'),
      };
      if (org === 'channel' && fields.industry !== undefined) throw invalid('渠道没有行业字段，industry 只能用于客户。');
      const signal = exec.signal;

      if (action === 'create') {
        const name = needText(fields.name, 'name', `${meta.label}名称`);
        return viaBackend(async (cfg) => {
          const body = { [meta.nameKey]: name, address: fields.address || null, addressDetail: fields.addressDetail || null };
          if (org === 'customer') body.industry = fields.industry || null;
          const id = toNumber(await apiClient.createOrg(cfg, meta.kind, body, callOpts(signal)));
          return {
            action,
            targetType: org,
            id,
            name,
            message: `已新建${meta.label}「${name}」${id != null ? `（ID ${id}）` : ''}，负责销售是你本人。`,
          };
        });
      }

      const targetId = needId(args, 'targetId', `${action} `);
      return viaBackend(async (cfg) => {
        const current = await loadOrg(cfg, org, targetId, signal);
        const owner = `${meta.label}「${current.name}」`;

        if (action === 'update') {
          if (Object.values(fields).every((value) => value === undefined)) throw invalid('update 至少要给 name、industry、address、addressDetail 之一。');
          if (fields.name === '') throw invalid(`${meta.label}名称不能为空。`);
          const before = {
            name: current.name,
            industry: text(current.raw.industry),
            address: text(current.raw.address),
            addressDetail: text(current.raw.addressDetail),
          };
          const after = {
            name: fields.name ?? before.name,
            industry: fields.industry ?? before.industry,
            address: fields.address ?? before.address,
            addressDetail: fields.addressDetail ?? before.addressDetail,
          };
          // 后端会把没传的名称、地址、行业写成空，所以带上全部字段。
          const body = { [meta.nameKey]: after.name, address: after.address, addressDetail: after.addressDetail };
          if (org === 'customer') body.industry = after.industry;
          await apiClient.updateOrg(cfg, meta.kind, targetId, body, callOpts(signal));
          const changes = changesOf(before, after, { name: '名称', industry: '行业', address: '地址', addressDetail: '详细地址' });
          return { action, targetType: org, id: targetId, changes, message: changes.length ? `已修改${owner}。` : `${owner}的内容没有变化。` };
        }

        if (action === 'add_dept') {
          const deptName = needText(optField(args, 'deptName'), 'deptName', '部门名称');
          if (current.depts.some((dept) => dept.deptName === deptName)) throw invalid(`${owner}已经有部门「${deptName}」。`);
          await apiClient.addOrgDept(cfg, meta.kind, targetId, { deptName }, callOpts(signal));
          const depts = deptRows(await apiClient.listOrgDepts(cfg, meta.kind, targetId, callOpts(signal)));
          const added = depts.filter((dept) => dept.deptName === deptName).sort((a, b) => b.deptId - a.deptId)[0];
          return { action, targetType: org, targetId, deptId: added?.deptId ?? null, deptName, message: `已给${owner}添加部门「${deptName}」。` };
        }

        const deptId = optInt(args, 'deptId', 1, ID_MAX);
        if (deptId !== undefined && !current.depts.some((dept) => dept.deptId === deptId)) {
          const options = current.depts.map((dept) => `${dept.deptName}（deptId ${dept.deptId}）`).join('、');
          throw invalid(`部门 ${deptId} 不是${owner}的部门。${options ? `可选：${options}。` : `${owner}还没有部门，可以先用 add_dept 添加。`}`);
        }
        const contactName = optField(args, 'contactName');
        const position = optField(args, 'position');
        const phone = optField(args, 'phone', 50);

        if (action === 'add_contact') {
          const name = needText(contactName, 'contactName', '联系人姓名');
          const body = { contactName: name, position: position || null, phone: phone || null, [meta.deptKey]: deptId ?? null };
          await apiClient.addOrgContact(cfg, meta.kind, targetId, body, callOpts(signal));
          const after = await loadContacts(cfg, org, targetId, signal);
          const added = after.filter((c) => c.contactName === name).sort((a, b) => b.contactId - a.contactId)[0];
          return { action, targetType: org, targetId, contactId: added?.contactId ?? null, contactName: name, message: `已给${owner}添加联系人「${name}」。` };
        }

        // update_contact
        const contactId = needId(args, 'contactId', 'update_contact ');
        const existing = current.rawContacts.find((c) => toNumber(c?.id) === contactId);
        if (!existing) throw invalid(`联系人 ${contactId} 不是${owner}的联系人，请先用 sales_get_record 查看联系人列表。`);
        if (contactName === '') throw invalid('联系人姓名不能为空。');
        if ([contactName, position, phone, deptId].every((value) => value === undefined)) {
          throw invalid('update_contact 至少要给 contactName、position、phone、deptId 之一。');
        }
        const before = {
          contactName: text(existing.contactName),
          position: text(existing.position),
          phone: text(existing.phone),
          deptId: toNumber(existing[meta.deptKey]) ?? '',
        };
        const after = {
          contactName: contactName ?? before.contactName,
          position: position ?? before.position,
          phone: phone ?? before.phone,
          deptId: deptId ?? before.deptId,
        };
        const body = {
          id: contactId,
          contactName: after.contactName,
          position: after.position,
          phone: after.phone,
          [meta.deptKey]: after.deptId === '' ? null : after.deptId,
        };
        await apiClient.updateOrgContact(cfg, meta.kind, contactId, body, callOpts(signal));
        // 电话不放进工具输出，只说改没改。
        const changes = changesOf(before, after, { contactName: '姓名', position: '职位' });
        if (String(before.deptId) !== String(after.deptId)) {
          const deptLabel = (id) => (id === '' ? '' : current.depts.find((d) => d.deptId === id)?.deptName || `部门 ${id}`);
          changes.push({ field: '所属部门', before: deptLabel(before.deptId), after: deptLabel(after.deptId) });
        }
        if (before.phone !== after.phone) changes.push({ field: '电话', before: before.phone ? '（原电话）' : '', after: after.phone ? '（新电话）' : '' });
        return { action, targetType: org, targetId, contactId, changes, message: `已修改${owner}的联系人「${after.contactName}」。` };
      });
    },
  });

  // ---------- 工具：sales_save_project ----------
  const PROJECT_FIELDS = ['projectName', 'customerId', 'customerContactId', 'customerContactName', 'channelId', 'channelContactId', 'channelContactName', 'product', 'projectStatus', 'projectRisk', 'expectedSignDate', 'expectedAmount', 'remark'];
  const ANALYSIS_FIELDS = { demand: '需求', techApproval: '技术认可', decisionChain: '决策链', partner: '合作伙伴', competitor: '竞争对手' };
  registerTool({
    name: 'sales_save_project',
    description:
      '新建或修改项目（商机），以用户本人的名义直接写入销售管理系统（删除请用 sales_delete，移交请用 sales_transfer）。action="create" 新建项目：projectName、customerId、客户联系人（customerContactId 或 customerContactName）、product、expectedAmount（万元）、expectedSignDate 必填；"update" 修改项目，只改给出的字段（改阶段、风险、金额、预计签约日期、备注、渠道等）；"add_review" 添加一条项目梳理记录（content）；"update_review" 修改梳理记录（reviewId、content）；"save_analysis" 保存项目分析（需求、技术认可、决策链、合作伙伴、竞争对手，只改给出的项）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'add_review', 'update_review', 'save_analysis'], description: '要做的操作' },
        projectId: { type: 'integer', minimum: 1, description: 'create 以外都要给：项目ID' },
        projectName: { type: 'string', description: '项目名称' },
        customerId: { type: 'integer', minimum: 1, description: '客户ID（用 sales_search 查）' },
        customerContactId: { type: 'integer', minimum: 1, description: '客户联系人ID' },
        customerContactName: { type: 'string', description: '客户联系人姓名，和 customerContactId 二选一' },
        channelId: { type: 'integer', minimum: 1, description: '可选：合作渠道ID' },
        channelContactId: { type: 'integer', minimum: 1, description: '可选：渠道联系人ID' },
        channelContactName: { type: 'string', description: '可选：渠道联系人姓名，和 channelContactId 二选一' },
        product: { type: 'string', description: '产品名，多个用顿号分隔，必须是系统产品列表里的名字' },
        projectStatus: { type: 'string', enum: PROJECT_STATUSES, description: '项目阶段；新建时默认「发现问题」' },
        projectRisk: { type: 'string', enum: [...PROJECT_RISKS, ''], description: '项目风险；给空字符串表示清除风险' },
        expectedSignDate: { type: 'string', description: '预计签约日期 YYYY-MM-DD' },
        expectedAmount: { type: 'number', minimum: 0, description: '预计金额，单位万元' },
        remark: { type: 'string', description: '备注，给空字符串表示清空' },
        reviewId: { type: 'integer', minimum: 1, description: 'update_review：梳理记录ID（用 sales_get_record 查）' },
        content: { type: 'string', description: `add_review / update_review：梳理内容，最多 ${MAX_LONG_TEXT} 字` },
        demand: { type: 'string', description: 'save_analysis：需求' },
        techApproval: { type: 'string', description: 'save_analysis：技术认可' },
        decisionChain: { type: 'string', description: 'save_analysis：决策链' },
        partner: { type: 'string', description: 'save_analysis：合作伙伴' },
        competitor: { type: 'string', description: 'save_analysis：竞争对手' },
      },
      required: ['action'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['action', 'projectId', ...PROJECT_FIELDS, 'reviewId', 'content', ...Object.keys(ANALYSIS_FIELDS)], 'sales_save_project');
      const action = optEnum(args, 'action', ['create', 'update', 'add_review', 'update_review', 'save_analysis']);
      if (!action) throw invalid('请给出 action。');
      const signal = exec.signal;
      const input = {
        projectName: optField(args, 'projectName'),
        customerId: optInt(args, 'customerId', 1, ID_MAX),
        customerContactId: optInt(args, 'customerContactId', 1, ID_MAX),
        customerContactName: optText(args, 'customerContactName'),
        channelId: optInt(args, 'channelId', 1, ID_MAX),
        channelContactId: optInt(args, 'channelContactId', 1, ID_MAX),
        channelContactName: optText(args, 'channelContactName'),
        product: optField(args, 'product'),
        projectStatus: optEnum(args, 'projectStatus', PROJECT_STATUSES),
        projectRisk: optEnum(args, 'projectRisk', [...PROJECT_RISKS, '']),
        expectedSignDate: optDate(args, 'expectedSignDate'),
        expectedAmount: optAmount(args, 'expectedAmount'),
        remark: optField(args, 'remark', MAX_LONG_TEXT),
      };

      if (action === 'create') {
        needText(input.projectName, 'projectName', '项目名称');
        if (input.customerId === undefined) throw invalid('新建项目要给 customerId（用 sales_search 查客户ID）。');
        if (input.customerContactId === undefined && input.customerContactName === undefined) {
          throw invalid('新建项目要给客户联系人：customerContactId 或 customerContactName。');
        }
        needText(input.product, 'product', '产品');
        if (input.expectedAmount === undefined) throw invalid('新建项目要给 expectedAmount（预计金额，万元）。');
        if (input.expectedSignDate === undefined) throw invalid('新建项目要给 expectedSignDate（预计签约日期 YYYY-MM-DD）。');
      }

      return viaBackend(async (cfg) => {
        if (action === 'create' || action === 'update') {
          const projectId = action === 'update' ? needId(args, 'projectId', '修改项目') : null;
          const before = action === 'update' ? (await apiClient.getProject(cfg, projectId, callOpts(signal))) || {} : {};
          if (action === 'update' && PROJECT_FIELDS.every((key) => input[key] === undefined)) {
            throw invalid('update 至少要给一个要修改的字段。');
          }
          if (input.projectName === '') throw invalid('项目名称不能为空。');
          if (input.product === '') throw invalid('产品不能为空。');
          const body = {};
          if (input.projectName !== undefined) body.projectName = input.projectName;
          if (input.product !== undefined) body.product = await normalizeProducts(cfg, input.product, signal);
          if (input.projectStatus !== undefined) body.projectStatus = input.projectStatus;
          if (input.projectRisk !== undefined) body.projectRisk = input.projectRisk;
          if (input.expectedSignDate !== undefined) body.expectedSignDate = input.expectedSignDate;
          if (input.expectedAmount !== undefined) body.expectedAmount = input.expectedAmount;
          if (input.remark !== undefined) body.remark = input.remark;

          // 客户和客户联系人：换了客户就要重新选联系人；联系人职位跟着联系人回填（和网页一致）。
          const customerId = input.customerId ?? toNumber(before.customerId);
          const customerChanged = input.customerId !== undefined && input.customerId !== toNumber(before.customerId);
          if (customerChanged) body.customerId = input.customerId;
          let customerContact = null;
          let channelContact = null;
          if (input.customerContactId !== undefined || input.customerContactName !== undefined) {
            const contact = pickContact(await loadContacts(cfg, 'customer', customerId, signal), input.customerContactId, input.customerContactName, `客户 ${customerId} `);
            body.customerContactId = contact.contactId;
            body.customerContactPosition = contact.position;
            customerContact = contact;
          } else if (customerChanged) {
            throw invalid('换了客户，要同时给新客户的联系人：customerContactId 或 customerContactName。');
          }
          const channelId = input.channelId ?? toNumber(before.channelId);
          if (input.channelId !== undefined) body.channelId = input.channelId;
          if (input.channelContactId !== undefined || input.channelContactName !== undefined) {
            if (!channelId) throw invalid('要先给 channelId 才能选渠道联系人。');
            const contact = pickContact(await loadContacts(cfg, 'channel', channelId, signal), input.channelContactId, input.channelContactName, `渠道 ${channelId} `);
            body.channelContactId = contact.contactId;
            body.channelContactPosition = contact.position;
            channelContact = contact;
          }

          if (action === 'create') {
            if (body.projectStatus === undefined) body.projectStatus = '发现问题';
            await apiClient.createProject(cfg, body, callOpts(signal));
            // 新建接口不返回 ID：按名称找刚建的项目。
            const page = await apiClient.listProjects(cfg, { projectName: body.projectName, includeArchived: true, pageNum: 1, pageSize: 10 }, callOpts(signal)).catch(() => null);
            const records = Array.isArray(page?.records) ? page.records : [];
            const created = records.filter((r) => text(r?.projectName) === body.projectName).sort((a, b) => (toNumber(b?.id) ?? 0) - (toNumber(a?.id) ?? 0))[0];
            return {
              action,
              projectId: toNumber(created?.id),
              projectName: body.projectName,
              message: `已新建项目「${body.projectName}」${created ? `（ID ${toNumber(created.id)}）` : ''}，负责销售是你本人，阶段「${body.projectStatus}」。`,
            };
          }
          await apiClient.updateProject(cfg, projectId, { id: projectId, ...body }, callOpts(signal));
          const labels = {
            projectName: '项目名称', product: '产品', projectStatus: '项目阶段', projectRisk: '项目风险', expectedSignDate: '预计签约日期', expectedAmount: '预计金额（万元）', remark: '备注',
          };
          const old = { ...before, expectedSignDate: dateText(before.expectedSignDate, false) };
          const changes = changesOf(
            Object.fromEntries(Object.keys(labels).map((key) => [key, old[key] ?? ''])),
            Object.fromEntries(Object.keys(labels).map((key) => [key, body[key] !== undefined ? body[key] : old[key] ?? ''])),
            labels,
          );
          if (customerChanged) {
            changes.push({ field: '客户', before: orgLabel('customer', before.customerName, toNumber(before.customerId)), after: orgLabel('customer', await orgNameOf(cfg, 'customer', customerId, signal), customerId) });
          }
          if (customerContact && customerContact.contactId !== toNumber(before.customerContactId)) {
            changes.push({ field: '客户联系人', before: await contactNameOf(cfg, 'customer', toNumber(before.customerId), toNumber(before.customerContactId), signal), after: customerContact.contactName });
          }
          if (body.channelId !== undefined && body.channelId !== toNumber(before.channelId)) {
            changes.push({ field: '渠道', before: before.channelId ? orgLabel('channel', before.channelName, toNumber(before.channelId)) : '', after: orgLabel('channel', await orgNameOf(cfg, 'channel', body.channelId, signal), body.channelId) });
          }
          if (channelContact && channelContact.contactId !== toNumber(before.channelContactId)) {
            changes.push({ field: '渠道联系人', before: await contactNameOf(cfg, 'channel', toNumber(before.channelId), toNumber(before.channelContactId), signal), after: channelContact.contactName });
          }
          return { action, projectId, changes, message: `已修改项目「${text(before.projectName) || projectId}」。` };
        }

        const projectId = needId(args, 'projectId', `${action} `);
        const project = (await apiClient.getProject(cfg, projectId, callOpts(signal))) || {};
        const projectLabel = `项目「${text(project.projectName) || projectId}」`;

        if (action === 'add_review' || action === 'update_review') {
          const content = needText(optField(args, 'content', MAX_LONG_TEXT), 'content', '梳理内容');
          if (action === 'add_review') {
            await apiClient.addProjectReview(cfg, projectId, { content }, callOpts(signal));
            return { action, projectId, message: `已给${projectLabel}添加一条梳理记录。` };
          }
          const reviewId = needId(args, 'reviewId', '修改梳理记录');
          const reviews = await apiClient.listProjectReviews(cfg, projectId, callOpts(signal));
          const review = (Array.isArray(reviews) ? reviews : []).find((r) => toNumber(r?.id) === reviewId);
          if (!review) throw invalid(`梳理记录 ${reviewId} 不属于${projectLabel}，请先用 sales_get_record 查看梳理记录。`);
          await apiClient.updateProjectReview(cfg, reviewId, { id: reviewId, content }, callOpts(signal));
          return { action, projectId, reviewId, changes: changesOf({ content: text(review.content) }, { content }, { content: '梳理内容' }), message: `已修改${projectLabel}的梳理记录。` };
        }

        // save_analysis
        const patch = {};
        for (const key of Object.keys(ANALYSIS_FIELDS)) {
          const value = optField(args, key, MAX_LONG_TEXT);
          if (value !== undefined) patch[key] = value;
        }
        if (!Object.keys(patch).length) throw invalid(`save_analysis 至少要给 ${Object.keys(ANALYSIS_FIELDS).join('、')} 之一。`);
        const current = (await apiClient.getProjectAnalysis(cfg, projectId, callOpts(signal))) || {};
        const before = Object.fromEntries(Object.keys(ANALYSIS_FIELDS).map((key) => [key, text(current[key])]));
        const after = { ...before, ...patch };
        await apiClient.saveProjectAnalysis(cfg, projectId, { projectId, ...after }, callOpts(signal));
        return { action, projectId, changes: changesOf(before, after, ANALYSIS_FIELDS), message: `已保存${projectLabel}的项目分析。` };
      });
    },
  });

  // ---------- 工具：sales_save_work_report ----------
  registerTool({
    name: 'sales_save_work_report',
    description:
      '修改日报、保存周计划和周报，以用户本人的名义直接写入销售管理系统（新建日报请用 sales_draft_work_report，删除请用 sales_delete）。action="update_daily" 修改一条日报，只改给出的字段（日期、拜访对象、拜访人、工作总结、工作计划），只能改自己的日报；"save_weekly_plan" 保存自己某一周的周计划，planItems 是这一周完整的计划条目，会整份替换；"save_weekly_report" 保存自己某一周的周报（workSummary 工作总结、supplement 补充说明，只改给出的项）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['update_daily', 'save_weekly_plan', 'save_weekly_report'], description: '要做的操作' },
        reportId: { type: 'integer', minimum: 1, description: 'update_daily：日报ID（sales_query_work_reports 的「日报ID」列）' },
        reportDate: { type: 'string', description: 'update_daily：拜访日期 YYYY-MM-DD' },
        targetType: { type: 'string', enum: ['customer', 'channel'], description: 'update_daily：换拜访对象时的类型，和 targetId 一起给' },
        targetId: { type: 'integer', minimum: 1, description: 'update_daily：换拜访对象时的客户ID或渠道ID' },
        contactId: { type: 'integer', minimum: 1, description: 'update_daily：拜访人（联系人）ID' },
        contactName: { type: 'string', description: 'update_daily：拜访人姓名，和 contactId 二选一' },
        workSummary: { type: 'string', description: `update_daily / save_weekly_report：工作总结，照用户原话写、只改错别字，最多 ${MAX_LONG_TEXT} 字` },
        workPlan: { type: 'string', description: `update_daily：工作计划，照用户原话写、只改错别字，最多 ${MAX_LONG_TEXT} 字` },
        weekStartDate: { type: 'string', description: 'save_weekly_plan / save_weekly_report：这一周里的任意一天 YYYY-MM-DD，默认本周' },
        planItems: { type: 'array', items: { type: 'string' }, description: `save_weekly_plan：这一周完整的计划条目，最多 ${MAX_PLAN_ITEMS} 条` },
        supplement: { type: 'string', description: 'save_weekly_report：补充说明，给空字符串表示清空' },
      },
      required: ['action'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['action', 'reportId', 'reportDate', 'targetType', 'targetId', 'contactId', 'contactName', 'workSummary', 'workPlan', 'weekStartDate', 'planItems', 'supplement'], 'sales_save_work_report');
      const action = optEnum(args, 'action', ['update_daily', 'save_weekly_plan', 'save_weekly_report']);
      if (!action) throw invalid('请给出 action。');
      const signal = exec.signal;
      const weekStartDate = mondayOf(optDate(args, 'weekStartDate') ?? localDay(now()));

      if (action === 'save_weekly_plan') {
        const items = args.planItems;
        if (!Array.isArray(items) || items.length > MAX_PLAN_ITEMS || !items.every((item) => typeof item === 'string')) {
          throw invalid(`planItems 要给字符串数组，最多 ${MAX_PLAN_ITEMS} 条。`);
        }
        const planItems = items.map((item) => item.trim()).filter(Boolean);
        if (planItems.some((item) => item.length > MAX_FIELD_TEXT)) throw invalid(`每条计划最多 ${MAX_FIELD_TEXT} 个字。`);
        return viaBackend(async (cfg) => {
          const saved = (await apiClient.saveWeeklyPlan(cfg, { weekStartDate, planItems }, callOpts(signal))) || {};
          const kept = Array.isArray(saved.planItems) ? saved.planItems.map(text) : planItems;
          return { action, weekStartDate, planItems: kept, message: `已保存 ${weekStartDate} 这一周的周计划，共 ${kept.length} 条。` };
        });
      }

      if (action === 'save_weekly_report') {
        const workSummary = optField(args, 'workSummary', MAX_LONG_TEXT);
        const supplement = optField(args, 'supplement', MAX_LONG_TEXT);
        if (workSummary === undefined && supplement === undefined) throw invalid('save_weekly_report 至少要给 workSummary 或 supplement。');
        return viaBackend(async (cfg) => {
          const current = (await apiClient.getWeeklyReport(cfg, { weekStartDate }, callOpts(signal))) || {};
          const before = { workSummary: text(current.workSummary), supplement: text(current.supplement) };
          const after = { workSummary: workSummary ?? before.workSummary, supplement: supplement ?? before.supplement };
          await apiClient.saveWeeklyReport(cfg, { weekStartDate, ...after, aiResponse: text(current.aiResponse) || null }, callOpts(signal));
          return {
            action,
            weekStartDate,
            changes: changesOf(before, after, { workSummary: '工作总结', supplement: '补充说明' }),
            message: `已保存 ${weekStartDate} 这一周的周报。`,
          };
        });
      }

      // update_daily
      const reportId = needId(args, 'reportId', '修改日报');
      const reportDate = optDate(args, 'reportDate');
      const targetType = optEnum(args, 'targetType', ['customer', 'channel']);
      const targetId = optInt(args, 'targetId', 1, ID_MAX);
      if ((targetType === undefined) !== (targetId === undefined)) throw invalid('换拜访对象时 targetType 和 targetId 要一起给。');
      const contactId = optInt(args, 'contactId', 1, ID_MAX);
      const contactName = optText(args, 'contactName');
      const texts = {};
      for (const [key, label] of [['workSummary', '工作总结'], ['workPlan', '工作计划']]) {
        const value = optField(args, key, MAX_LONG_TEXT);
        if (value === '') throw invalid(`${label}（${key}）不能为空。`);
        if (value !== undefined) texts[key] = value;
      }
      if ([reportDate, targetId, contactId, contactName, texts.workSummary, texts.workPlan].every((value) => value === undefined)) {
        throw invalid('update_daily 至少要给一个要修改的字段。');
      }
      return viaBackend(async (cfg) => {
        const report = (await apiClient.getWorkReport(cfg, reportId, callOpts(signal))) || {};
        const before = {
          reportDate: dateText(report.reportDate, false),
          targetType: toNumber(report.targetType),
          targetId: toNumber(report.targetId),
          contactId: toNumber(report.contactId),
          workSummary: text(report.workSummary),
          workPlan: text(report.workPlan),
        };
        const after = { ...before, ...texts };
        if (reportDate !== undefined) after.reportDate = reportDate;
        const targetChanged = targetType !== undefined && (ORGS[targetType].code !== before.targetType || targetId !== before.targetId);
        if (targetChanged) {
          after.targetType = ORGS[targetType].code;
          after.targetId = targetId;
        }
        let contactLabel = text(report.contactName);
        if (contactId !== undefined || contactName !== undefined || targetChanged) {
          const org = ORG_BY_CODE[after.targetType];
          if (!org) throw invalid('这条日报的拜访对象类型不对，请到销售管理系统网页里修改。');
          const contacts = await loadContacts(cfg, org, after.targetId, signal);
          const owner = `${ORGS[org].label} ${after.targetId} `;
          let contact;
          if (contactId !== undefined || contactName !== undefined) contact = pickContact(contacts, contactId, contactName, owner);
          else if (contacts.length === 1) contact = contacts[0];
          else {
            const options = contacts.map((c) => `${c.contactName}（contactId ${c.contactId}）`).join('、');
            throw invalid(`换了拜访对象，要同时给拜访人（contactId 或 contactName）。${options ? `可选：${options}。` : `${owner}还没有联系人，可以先用 sales_save_customer(action="add_contact") 添加。`}`);
          }
          after.contactId = contact.contactId;
          contactLabel = contact.contactName;
        }
        if (!isRealDate(after.reportDate)) throw invalid('这条日报没有有效的拜访日期，请给 reportDate。');
        await apiClient.updateWorkReport(cfg, reportId, {
          id: reportId,
          reportDate: after.reportDate,
          targetType: after.targetType,
          targetId: after.targetId,
          contactId: after.contactId,
          workPlan: after.workPlan,
          workSummary: after.workSummary,
        }, callOpts(signal));
        const changes = changesOf(before, after, { reportDate: '拜访日期' });
        if (targetChanged) {
          const toOrg = ORG_BY_CODE[after.targetType];
          changes.push({
            field: '拜访对象',
            before: orgLabel(ORG_BY_CODE[before.targetType], report.targetName, before.targetId),
            after: orgLabel(toOrg, await orgNameOf(cfg, toOrg, after.targetId, signal), after.targetId),
          });
        }
        if (after.contactId !== before.contactId) {
          changes.push({ field: '拜访人', before: text(report.contactName) || (before.contactId ? `联系人 ${before.contactId}` : ''), after: contactLabel });
        }
        changes.push(...changesOf(before, after, { workSummary: '工作总结', workPlan: '工作计划' }));
        return { action, reportId, contactName: contactLabel, changes, message: changes.length ? `已修改日报 ${reportId}。` : `日报 ${reportId} 的内容没有变化。` };
      });
    },
  });

  // ---------- 工具：sales_save_target ----------
  registerTool({
    name: 'sales_save_target',
    description:
      '设置某个人或某个部门某一年的销售目标（四个季度，单位万元），直接写入销售管理系统。只有能管理目标的账户（总公司或售前）可以设置，范围是自己能管理的人员和部门。只给出要改的季度时，其他季度保持原值；还没有目标的季度按 0 处理。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        targetType: { type: 'string', enum: ['person', 'dept'], description: 'person 个人目标，dept 部门目标' },
        userId: { type: 'integer', minimum: 1, description: 'person：人员ID（用 sales_search(target="people") 查）' },
        userName: { type: 'string', description: 'person：人员姓名，和 userId 二选一' },
        deptId: { type: 'integer', minimum: 1, description: 'dept：部门ID' },
        year: { type: 'integer', minimum: 2000, maximum: 2100, description: '年份，默认今年' },
        q1Amount: { type: 'number', minimum: 0, description: '第一季度目标（万元）' },
        q2Amount: { type: 'number', minimum: 0, description: '第二季度目标（万元）' },
        q3Amount: { type: 'number', minimum: 0, description: '第三季度目标（万元）' },
        q4Amount: { type: 'number', minimum: 0, description: '第四季度目标（万元）' },
      },
      required: ['targetType'],
    },
    async execute(args, exec) {
      const QUARTERS = ['q1Amount', 'q2Amount', 'q3Amount', 'q4Amount'];
      rejectUnknown(args, ['targetType', 'userId', 'userName', 'deptId', 'year', ...QUARTERS], 'sales_save_target');
      const kind = optEnum(args, 'targetType', ['person', 'dept']);
      if (!kind) throw invalid('请给出 targetType（person 或 dept）。');
      const year = optInt(args, 'year', 2000, 2100) ?? new Date(now()).getFullYear();
      const amounts = Object.fromEntries(QUARTERS.map((key) => [key, optAmount(args, key)]));
      if (QUARTERS.every((key) => amounts[key] === undefined)) throw invalid('至少要给一个季度的目标金额（q1Amount～q4Amount，万元）。');
      const userId = optInt(args, 'userId', 1, ID_MAX);
      const userName = optText(args, 'userName');
      const deptId = optInt(args, 'deptId', 1, ID_MAX);
      if (kind === 'person' && deptId !== undefined) throw invalid('个人目标不用给 deptId。');
      if (kind === 'dept' && (userId !== undefined || userName !== undefined)) throw invalid('部门目标不用给 userId / userName。');
      if (kind === 'dept' && deptId === undefined) throw invalid('部门目标要给 deptId。');
      if (kind === 'person' && userId === undefined && userName === undefined) throw invalid('个人目标要给 userId 或 userName。');
      const signal = exec.signal;
      return viaBackend(async (cfg) => {
        let targetId = deptId;
        let targetName = '';
        if (kind === 'person') {
          const resolved = await resolvePerson(cfg, userId, userName, 'userId', 'userName', signal);
          if (resolved.unresolved) return resolved.unresolved;
          targetId = resolved.person.userId;
          targetName = resolved.person.realName;
        }
        const code = kind === 'person' ? 1 : 2;
        const page = await apiClient.listSalesTargets(cfg, { targetType: code, year, pageNum: 1, pageSize: 500 }, callOpts(signal)).catch((error) => {
          if (error instanceof ApiError && error.code === 'FORBIDDEN') {
            throw new ApiError('只有能管理销售目标的账户（总公司或售前）才能设置目标。', { code: 'FORBIDDEN' });
          }
          throw error;
        });
        const records = Array.isArray(page?.records) ? page.records : [];
        const existing = records.find((r) => toNumber(r?.targetType) === code && toNumber(r?.targetId) === targetId && toNumber(r?.year) === year) || {};
        if (!targetName) targetName = text(existing.targetName) || `部门 ${targetId}`;
        const before = Object.fromEntries(QUARTERS.map((key) => [key, toNumber(existing[key]) ?? 0]));
        const after = Object.fromEntries(QUARTERS.map((key) => [key, amounts[key] ?? before[key]]));
        await apiClient.saveSalesTarget(cfg, { targetType: code, targetId, year, ...after }, callOpts(signal));
        const annual = QUARTERS.reduce((sum, key) => sum + after[key], 0);
        return {
          targetType: kind,
          targetId,
          targetName,
          year,
          unit: '万元',
          ...after,
          annualTarget: Math.round(annual * 10000) / 10000,
          changes: changesOf(before, after, { q1Amount: '第一季度', q2Amount: '第二季度', q3Amount: '第三季度', q4Amount: '第四季度' }),
          message: `已设置${targetName} ${year} 年的销售目标，全年 ${Math.round(annual * 10000) / 10000} 万元。`,
        };
      });
    },
  });

  // ---------- 删除和移交：先暂存，用户在卡片上确认后才执行 ----------

  function stageAction(entry) {
    if (pendingActions.size >= MAX_PENDING_ACTIONS) {
      const oldest = pendingActions.keys().next().value;
      if (oldest !== undefined) pendingActions.delete(oldest);
    }
    pendingActions.set(entry.actionId, entry);
  }

  const notVisible = (error) => error instanceof ApiError && ['FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST', 'BUSINESS_ERROR'].includes(error.code);

  /** 每种可删除的数据：怎么说明这一条（顺便确认它存在、在数据范围内），怎么删。 */
  const DELETE_TYPES = {
    customer: { label: '客户', parent: null },
    channel: { label: '渠道', parent: null },
    customer_contact: { label: '客户联系人', parent: 'customer' },
    channel_contact: { label: '渠道联系人', parent: 'channel' },
    customer_dept: { label: '客户部门', parent: 'customer' },
    channel_dept: { label: '渠道部门', parent: 'channel' },
    project: { label: '项目', parent: null },
    work_report: { label: '日报', parent: null },
    weekly_report: { label: '周报', parent: null },
    sales_target: { label: '销售目标', parent: null },
  };

  async function describeForDelete(cfg, type, ids, parentId, signal) {
    const items = [];
    const skipped = [];
    const skip = (id, error) => skipped.push({ id, reason: notVisible(error) ? '不存在或不在你的数据范围内' : safeErrorMessage(error, '查不到这条数据') });
    if (type === 'customer' || type === 'channel') {
      for (const id of ids) {
        try {
          const record = type === 'customer' ? await apiClient.getCustomer(cfg, id, callOpts(signal)) : await apiClient.getChannel(cfg, id, callOpts(signal));
          const name = text(record?.[ORGS[type].nameKey]);
          if (!record || !name) throw new ApiError('', { code: 'NOT_FOUND' });
          items.push({ id, label: `${ORGS[type].label}「${name}」${record.salesName ? ` · 负责人 ${text(record.salesName)}` : ''}` });
        } catch (error) {
          skip(id, error);
        }
      }
      return { items, skipped };
    }
    if (DELETE_TYPES[type].parent) {
      const org = DELETE_TYPES[type].parent;
      const loaded = await loadOrg(cfg, org, parentId, signal);
      const isContact = type.endsWith('_contact');
      for (const id of ids) {
        if (isContact) {
          const contact = loaded.contacts.find((c) => c.contactId === id);
          if (contact) items.push({ id, label: `${contact.contactName}${contact.position ? `（${contact.position}）` : ''} · ${ORGS[org].label}「${loaded.name}」` });
          else skipped.push({ id, reason: `不是${ORGS[org].label}「${loaded.name}」的联系人` });
        } else {
          const dept = loaded.depts.find((d) => d.deptId === id);
          if (dept) items.push({ id, label: `${dept.deptName} · ${ORGS[org].label}「${loaded.name}」` });
          else skipped.push({ id, reason: `不是${ORGS[org].label}「${loaded.name}」的部门` });
        }
      }
      return { items, skipped };
    }
    if (type === 'project') {
      for (const id of ids) {
        try {
          const p = await apiClient.getProject(cfg, id, callOpts(signal));
          if (!p || !text(p.projectName)) throw new ApiError('', { code: 'NOT_FOUND' });
          const amount = toNumber(p.expectedAmount);
          const parts = [text(p.customerName), amount != null ? `${amount} 万元` : '', text(p.projectStatus)].filter(Boolean);
          items.push({ id, label: `项目「${text(p.projectName)}」${parts.length ? ` · ${parts.join(' · ')}` : ''}` });
        } catch (error) {
          skip(id, error);
        }
      }
      return { items, skipped };
    }
    if (type === 'work_report') {
      for (const id of ids) {
        try {
          const r = await apiClient.getWorkReport(cfg, id, callOpts(signal));
          if (!r || toNumber(r.id) !== id) throw new ApiError('', { code: 'NOT_FOUND' });
          const who = [text(r.targetName), text(r.contactName)].filter(Boolean).join(' · ');
          items.push({ id, label: `${dateText(r.reportDate, false)} ${who}${r.realName ? `（${text(r.realName)}）` : ''}：${firstLine(r.workSummary)}` });
        } catch (error) {
          skip(id, error);
        }
      }
      return { items, skipped };
    }
    if (type === 'sales_target') {
      const page = await apiClient.listSalesTargets(cfg, { pageNum: 1, pageSize: 500 }, callOpts(signal)).catch(() => null);
      const records = Array.isArray(page?.records) ? page.records : [];
      for (const id of ids) {
        const t = records.find((r) => toNumber(r?.id) === id);
        if (!t) {
          skipped.push({ id, reason: '不存在或不在你能管理的范围内' });
          continue;
        }
        const annual = ['q1Amount', 'q2Amount', 'q3Amount', 'q4Amount'].reduce((sum, key) => sum + (toNumber(t[key]) ?? 0), 0);
        items.push({ id, label: `${text(t.targetName) || `目标 ${id}`} · ${toNumber(t.year)} 年 · 全年 ${Math.round(annual * 10000) / 10000} 万元` });
      }
      return { items, skipped };
    }
    // weekly_report：没有按 ID 查询的接口，后端删除时会校验是不是本人的周报。
    return { items: ids.map((id) => ({ id, label: `周报 ${id}` })), skipped };
  }

  function removeOne(cfg, entry, id, signal) {
    const opts = callOpts(signal);
    switch (entry.type) {
      case 'customer':
      case 'channel':
        return apiClient.deleteOrg(cfg, ORGS[entry.type].kind, id, opts);
      case 'customer_contact':
      case 'channel_contact':
        return apiClient.deleteOrgContact(cfg, ORGS[DELETE_TYPES[entry.type].parent].kind, id, opts);
      case 'customer_dept':
      case 'channel_dept':
        return apiClient.deleteOrgDept(cfg, ORGS[DELETE_TYPES[entry.type].parent].kind, id, opts);
      case 'project':
        return apiClient.deleteProject(cfg, id, opts);
      case 'work_report':
        return apiClient.deleteWorkReport(cfg, id, opts);
      case 'weekly_report':
        return apiClient.deleteWeeklyReport(cfg, id, opts);
      case 'sales_target':
        return apiClient.deleteSalesTarget(cfg, id, opts);
      default:
        throw new ApiError('内部错误：未知的数据类型。', { code: 'INVALID_ARGUMENT' });
    }
  }

  function pendingPayload(entry, skipped) {
    const isDelete = entry.action === 'delete';
    return {
      kind: ACTION_PENDING_KIND,
      actionId: entry.actionId,
      action: entry.action,
      type: entry.type,
      typeLabel: entry.typeLabel,
      title: entry.title,
      items: entry.items,
      ...(entry.toUser ? { toUser: entry.toUser, includeProjects: entry.includeProjects } : {}),
      skipped,
      status: 'pending',
      hint: isDelete
        ? '已在对话里显示「确认删除」卡片，还没有删除。请用户核对后在卡片上点「确认删除」；不要说已经删除，也不要用别的工具或办法去删。'
        : '已在对话里显示「确认移交」卡片，还没有移交。请用户核对后在卡片上点「确认移交」；不要说已经移交。',
    };
  }

  registerTool({
    name: 'sales_delete',
    description:
      '删除销售管理系统里的数据。这个工具不会马上删除：它在对话里显示「确认删除」卡片，列出要删的每一条，用户点「确认删除」后才以用户本人的名义删除，删除后不能在系统里恢复。type 可以是 customer、channel、customer_contact、channel_contact、customer_dept、channel_dept、project、work_report、weekly_report、sales_target；一次最多 20 条。删联系人和部门时要给 parentId（所属客户或渠道的ID）。ID 先用查询工具或 sales_get_record 拿到，不确定是哪一条时先问用户。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: Object.keys(DELETE_TYPES), description: '要删除的数据类型' },
        ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: MAX_ACTION_IDS, description: '要删除的 ID 列表' },
        parentId: { type: 'integer', minimum: 1, description: '删联系人、部门时：所属客户ID或渠道ID' },
      },
      required: ['type', 'ids'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['type', 'ids', 'parentId'], 'sales_delete');
      const type = optEnum(args, 'type', Object.keys(DELETE_TYPES));
      if (!type) throw invalid('请给出 type。');
      const ids = optIds(args, 'ids');
      if (!ids) throw invalid('请给出要删除的 ids。');
      const parentId = optInt(args, 'parentId', 1, ID_MAX);
      if (DELETE_TYPES[type].parent && parentId === undefined) {
        throw invalid(`删除${DELETE_TYPES[type].label}要给 parentId（所属${ORGS[DELETE_TYPES[type].parent].label}的ID）。`);
      }
      return viaBackend(async (cfg) => {
        const { items, skipped } = await describeForDelete(cfg, type, ids, parentId, exec.signal);
        if (!items.length) {
          return { kind: 'salesforge-nothing-to-delete', type, skipped, message: '要删除的数据都找不到或不在你的数据范围内，没有显示确认卡片。' };
        }
        const { session, turn } = sessionTurnOf(exec.agent?.id || null, exec.callId);
        const entry = {
          actionId: `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          action: 'delete',
          type,
          typeLabel: DELETE_TYPES[type].label,
          title: `删除 ${items.length} 条${DELETE_TYPES[type].label}`,
          items,
          serverUrl: cfg.serverUrl,
          accountId: cfg.accountId,
          session,
          turn,
          status: 'pending',
        };
        stageAction(entry);
        return pendingPayload(entry, skipped);
      });
    },
  });

  const TRANSFER_TYPES = { customer: '客户', channel: '渠道', project: '项目' };
  registerTool({
    name: 'sales_transfer',
    description:
      '把客户、渠道或项目移交给另一位负责销售。这个工具不会马上移交：它在对话里显示「确认移交」卡片，用户点「确认移交」后才执行；移交后原负责人可能看不到这些数据。移交客户或渠道时，includeProjects 默认 true：一并移交原负责人在它们下面跟进中的项目。一次最多 20 条。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: Object.keys(TRANSFER_TYPES), description: '要移交的数据类型' },
        ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: MAX_ACTION_IDS, description: '要移交的客户、渠道或项目ID' },
        toUserId: { type: 'integer', minimum: 1, description: '接收人ID（用 sales_search(target="people") 查）' },
        toUserName: { type: 'string', description: '接收人姓名，和 toUserId 二选一' },
        includeProjects: { type: 'boolean', description: '移交客户或渠道时，是否一并移交其下跟进中的项目，默认 true' },
      },
      required: ['type', 'ids'],
    },
    async execute(args, exec) {
      rejectUnknown(args, ['type', 'ids', 'toUserId', 'toUserName', 'includeProjects'], 'sales_transfer');
      const type = optEnum(args, 'type', Object.keys(TRANSFER_TYPES));
      if (!type) throw invalid('请给出 type。');
      const ids = optIds(args, 'ids');
      if (!ids) throw invalid('请给出要移交的 ids。');
      const toUserId = optInt(args, 'toUserId', 1, ID_MAX);
      const toUserName = optText(args, 'toUserName');
      if (toUserId === undefined && toUserName === undefined) throw invalid('请给出接收人：toUserId 或 toUserName。');
      const includeProjects = type === 'project' ? false : optBool(args, 'includeProjects') ?? true;
      return viaBackend(async (cfg) => {
        const resolved = await resolvePerson(cfg, toUserId, toUserName, 'toUserId', 'toUserName', exec.signal);
        if (resolved.unresolved) return resolved.unresolved;
        const { items, skipped } = await describeForDelete(cfg, type, ids, undefined, exec.signal);
        if (!items.length) {
          return { kind: 'salesforge-nothing-to-transfer', type, skipped, message: '要移交的数据都找不到或不在你的数据范围内，没有显示确认卡片。' };
        }
        const { session, turn } = sessionTurnOf(exec.agent?.id || null, exec.callId);
        const toUser = { userId: resolved.person.userId, realName: resolved.person.realName || resolved.person.username };
        const entry = {
          actionId: `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          action: 'transfer',
          type,
          typeLabel: TRANSFER_TYPES[type],
          title: `把 ${items.length} 个${TRANSFER_TYPES[type]}移交给${toUser.realName}`,
          items,
          toUser,
          includeProjects,
          serverUrl: cfg.serverUrl,
          accountId: cfg.accountId,
          session,
          turn,
          status: 'pending',
        };
        stageAction(entry);
        return pendingPayload(entry, skipped);
      });
    },
  });

  function record(entry, data) {
    if (!appendPluginRecord || !entry.session) return;
    try {
      appendPluginRecord(entry.session, ACTION_RECORD_TYPE, { version: 1, turn: entry.turn, actionId: entry.actionId, ...data });
    } catch {
      // 记不进会话不影响结果：只是重新打开对话时卡片不显示结果。
    }
  }

  /** 卡片上的「确认删除」「确认移交」：只认这里暂存过的操作，用暂存时的服务器和账户执行。 */
  async function confirmAction({ actionId, signal }) {
    const entry = typeof actionId === 'string' ? pendingActions.get(actionId) : undefined;
    if (!entry) throw new ApiError('这次操作已失效（小智办公可能重启过），请让助手重新发起。', { code: 'ACTION_NOT_FOUND' });
    if (entry.status === 'done') return { ...entry.outcome, alreadyDone: true };
    if (entry.status === 'cancelled') throw new ApiError('这次操作已经取消了。', { code: 'ACTION_CANCELLED' });
    if (entry.status === 'running') throw new ApiError('正在执行，请稍候。', { code: 'ACTION_RUNNING' });
    entry.status = 'running';
    let result;
    try {
      result = await accounts.withBackend(async (cfg) => {
        if (cfg.serverUrl !== entry.serverUrl || cfg.accountId !== entry.accountId) {
          throw new ApiError('当前连接的销售管理系统账户和发起操作时不同，请让助手重新发起。', { code: 'ACCOUNT_SWITCHED' });
        }
        if (entry.action === 'transfer') {
          const kind = { customer: 'customers', channel: 'channels', project: 'projects' }[entry.type];
          const res = (await apiClient.transferOwner(cfg, kind, { ids: entry.items.map((item) => item.id), targetUserId: entry.toUser.userId, includeProjects: entry.includeProjects }, callOpts(signal))) || {};
          return {
            results: entry.items.map((item) => ({ id: item.id, ok: true })),
            transferredCount: toNumber(res.transferredCount) ?? entry.items.length,
            projectCount: toNumber(res.projectCount) ?? 0,
          };
        }
        const results = [];
        for (const item of entry.items) {
          try {
            await removeOne(cfg, entry, item.id, signal);
            results.push({ id: item.id, ok: true });
          } catch (error) {
            results.push({ id: item.id, ok: false, error: safeErrorMessage(error, '删除失败') });
          }
        }
        return { results };
      });
    } catch (error) {
      entry.status = 'pending';
      throw error;
    }
    if (!result.ok) {
      entry.status = 'pending';
      throw new ApiError('销售管理系统账户未连接或授权已失效，请先在「设置 → 销售管理配置」重新连接，再点确认。', { code: 'AUTH_REQUIRED' });
    }
    const value = result.value;
    const okCount = value.results.filter((r) => r.ok).length;
    entry.status = 'done';
    entry.outcome = {
      kind: ACTION_DONE_KIND,
      actionId: entry.actionId,
      action: entry.action,
      status: okCount === entry.items.length ? 'done' : okCount ? 'partial' : 'failed',
      results: value.results,
      ...(entry.action === 'transfer' ? { transferredCount: value.transferredCount, projectCount: value.projectCount } : {}),
    };
    // 全部失败时允许再点一次（例如权限问题处理好之后）。
    if (okCount === 0 && entry.action === 'delete') entry.status = 'pending';
    else record(entry, { status: entry.outcome.status, results: value.results, ...(entry.action === 'transfer' ? { transferredCount: value.transferredCount, projectCount: value.projectCount } : {}) });
    return entry.outcome;
  }

  function cancelAction({ actionId }) {
    const entry = typeof actionId === 'string' ? pendingActions.get(actionId) : undefined;
    if (!entry) return { actionId, status: 'cancelled' };
    if (entry.status === 'done') throw new ApiError('这次操作已经执行了，不能取消。', { code: 'ACTION_DONE' });
    if (entry.status === 'running') throw new ApiError('正在执行，不能取消。', { code: 'ACTION_RUNNING' });
    entry.status = 'cancelled';
    record(entry, { status: 'cancelled' });
    return { actionId, status: 'cancelled' };
  }

  return { pendingActions, confirmAction, cancelAction };
}
