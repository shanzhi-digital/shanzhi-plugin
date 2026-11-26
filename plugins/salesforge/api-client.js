// 销售管理系统（SalesForge）REST 接口客户端。
// 后端返回 Result{code,message,data}：成功 code=200；业务错误是 HTTP 200 + 信封 code；分页是 PageResult{records,total,pageNum,pageSize,pages}。
// 插件令牌能读业务数据，也能增改删客户、渠道、项目、工作报告和销售目标（和用户在网页上的权限一样）；
// 浏览器授权的三个接口用 POST（其中两个不带令牌）。删除和移交由插件先让用户在卡片上确认，再调这里的接口。

export const DEFAULT_TIMEOUT_MS = 30_000;

// 错误信息只用这里写好的固定文案：不拼底层异常的 message、请求头，也不拼后端返回的原文。
// code 一律是字符串错误码；status 是 HTTP 状态（没有响应时为 0）；businessCode 是信封里的 code。
export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', businessCode, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (businessCode !== undefined) this.businessCode = businessCode;
    if (details !== undefined) this.details = details;
  }
}

/** 对外展示的错误文案：插件自己构造的 ApiError 原样用，其他异常一律不回显。 */
export function safeErrorMessage(error, fallback = '未知错误') {
  return error instanceof ApiError && typeof error.message === 'string' && error.message ? error.message : fallback;
}

/**
 * 校验 HTTP(S) 地址并去掉结尾斜杠。拒绝带用户名或密码的地址。报错不回显用户填的原文。
 */
export function normalizeHttpUrl(value, fieldLabel = '地址') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(`${fieldLabel}不能为空。`, { code: 'INVALID_URL' });
  }
  const cleaned = value.trim().replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(`${fieldLabel}格式无效，请填写完整的 http:// 或 https:// 地址。`, { code: 'INVALID_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(`${fieldLabel}仅支持 HTTP/HTTPS 协议。`, { code: 'INVALID_URL' });
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(`${fieldLabel}不能包含用户名或密码。`, { code: 'INVALID_URL' });
  }
  return cleaned;
}

export function normalizeServerUrl(serverUrl) {
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
    throw new ApiError('尚未配置销售管理系统的服务器地址。', { code: 'CONFIG_MISSING' });
  }
  return normalizeHttpUrl(serverUrl, '服务器地址');
}

function createTimedSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('TIMEOUT'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

function buildUrl(baseUrl, path, query) {
  const normalizedBase = normalizeServerUrl(baseUrl);
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${normalizedBase}${cleanPath}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.href;
}

async function parseJsonSafe(response) {
  const raw = await response.text();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _rawText: true };
  }
}

const UNAUTHORIZED_MESSAGE = '销售管理系统账户的授权已失效或过期，请在「设置 → 销售管理配置」重新连接账户。';
const FORBIDDEN_MESSAGE = '没有查看权限：当前账户不能查看这部分数据，请联系管理员检查账号角色或数据权限。';

// 信封里的业务错误码（HTTP 200 + code）对应的固定文案。
const BUSINESS_ERRORS = Object.freeze({
  400: ['BAD_REQUEST', '查询条件不符合销售管理系统的要求，请检查日期、季度等条件后重试。'],
  404: ['NOT_FOUND', '要查的数据在销售管理系统里不存在。'],
  409: ['CONFLICT', '与销售管理系统里已有的数据冲突，请核对后重试。'],
  410: ['GONE', '请求已过期，请重新发起。'],
  429: ['RATE_LIMITED', '请求太频繁，请稍后再试。'],
});

function businessError(rawCode, status) {
  const businessCode = Number.isSafeInteger(Number(rawCode)) ? Number(rawCode) : null;
  const known = businessCode !== null ? BUSINESS_ERRORS[businessCode] : null;
  if (known) return new ApiError(known[1], { status, code: known[0], businessCode });
  const shown = businessCode ?? '未知';
  if (businessCode !== null && businessCode >= 500) {
    return new ApiError(`销售管理系统处理失败（业务代码 ${shown}），请稍后重试或联系管理员。`, {
      status,
      code: 'SERVER_ERROR',
      businessCode,
    });
  }
  return new ApiError(`销售管理系统拒绝了这次查询（业务代码 ${shown}）。`, {
    status,
    code: 'BUSINESS_ERROR',
    ...(businessCode !== null ? { businessCode } : {}),
  });
}

// 写数据时销售系统拒绝的原因：业务校验的提示（例如「客户名称已存在」「拜访人不是所选拜访对象的联系人」）是写给用户看的，
// 原样转告；只取一行、最多 120 字。5xx 的提示不转告。
const WRITE_FORBIDDEN_MESSAGE = '销售管理系统拒绝了这次操作：可能是你的账号没有这项权限，或者服务器还没升级到允许插件修改数据的版本，请联系管理员。';

function serverHint(body) {
  const message = body && typeof body.message === 'string' ? body.message.replace(/\s+/gu, ' ').trim() : '';
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

function writeBusinessError(body, status) {
  const businessCode = Number.isSafeInteger(Number(body.code)) ? Number(body.code) : null;
  if (businessCode === null || businessCode >= 500) return businessError(body.code, status);
  const hint = serverHint(body);
  const code = BUSINESS_ERRORS[businessCode]?.[0] ?? (businessCode === 403 ? 'FORBIDDEN' : 'BUSINESS_ERROR');
  const message =
    businessCode === 403
      ? `没有权限做这项操作：${hint || '当前账户没有这项权限'}。`
      : `销售管理系统没有接受这次操作：${hint || '请核对内容后重试'}。`;
  return new ApiError(message.replace(/。。$/u, '。'), { status, code, businessCode });
}

// 先看 HTTP 状态；HTTP 成功时才看信封里的 code（销售系统的业务 400/403/500 都是 HTTP 200 + code）。
function assertEnvelope(response, body, writing = false) {
  const status = response.status;
  if (status === 401) throw new ApiError(UNAUTHORIZED_MESSAGE, { status, code: 'UNAUTHORIZED' });
  if (status === 403) throw new ApiError(writing ? WRITE_FORBIDDEN_MESSAGE : FORBIDDEN_MESSAGE, { status, code: 'FORBIDDEN' });
  if (!response.ok) {
    if (status === 404) {
      throw new ApiError('销售管理系统没有这个接口（HTTP 404）：请确认服务器地址以 /api/v1 结尾，或请管理员升级销售管理系统。', {
        status,
        code: 'HTTP_ERROR',
      });
    }
    if (status === 429) throw new ApiError('请求太频繁，请稍后再试。', { status, code: 'RATE_LIMITED' });
    if (status >= 500) {
      throw new ApiError(`销售管理系统暂时不可用（HTTP ${status}），请稍后重试。`, { status, code: 'SERVER_ERROR' });
    }
    throw new ApiError(`销售管理系统返回错误（HTTP ${status}）。`, { status, code: 'HTTP_ERROR' });
  }
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'code')) {
    const code = Number(body.code);
    if (code === 200) return body.data;
    if (code === 401) throw new ApiError(UNAUTHORIZED_MESSAGE, { status, code: 'UNAUTHORIZED', businessCode: 401 });
    if (writing) throw writeBusinessError(body, status);
    if (code === 403) throw new ApiError(FORBIDDEN_MESSAGE, { status, code: 'FORBIDDEN', businessCode: 403 });
    throw businessError(body.code, status);
  }
  if (body && typeof body === 'object' && '_rawText' in body) {
    throw new ApiError('销售管理系统返回了非 JSON 响应，请检查服务器地址是否指向 /api/v1。', {
      status,
      code: 'INVALID_JSON',
    });
  }
  return body;
}

export async function requestJson(cfg, path, options = {}) {
  const {
    method = 'GET',
    body,
    query,
    requireAuth = true,
    writing = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetchImpl = globalThis.fetch,
  } = options;

  const url = buildUrl(cfg?.serverUrl, path, query);
  const headers = { Accept: 'application/json' };
  const token = typeof cfg?.apiToken === 'string' ? cfg.apiToken.trim() : '';
  if (requireAuth) {
    if (!token) {
      throw new ApiError('尚未连接销售管理系统账户，请在「设置 → 销售管理配置」点「连接账户」完成浏览器授权。', {
        code: 'TOKEN_MISSING',
      });
    }
    headers.Authorization = `Bearer ${token}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let fetchBody;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const timed = createTimedSignal(signal, timeoutMs);
  try {
    // 不跟随重定向：否则请求正文（例如 pollSecret）可能被重发到别的地址。
    const response = await fetchImpl(url, {
      method,
      headers,
      body: fetchBody,
      signal: timed.signal,
      redirect: 'error',
    });
    const parsed = await parseJsonSafe(response);
    return assertEnvelope(response, parsed, writing);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timed.isTimedOut()) {
      throw new ApiError(`请求销售管理系统超时（>${Math.round(timeoutMs / 1000)}秒），请检查网络或服务状态。`, {
        code: 'TIMEOUT',
      });
    }
    if (signal?.aborted) {
      throw new ApiError('请求已取消。', { code: 'CANCELLED' });
    }
    // 底层异常（含无效请求头时带出的 header 值）不回显。
    throw new ApiError('无法连接销售管理系统（或服务器返回了重定向），请检查服务器地址和网络。', {
      code: 'NETWORK_ERROR',
    });
  } finally {
    timed.cleanup();
  }
}

const get = (cfg, path, query, opts = {}) => requestJson(cfg, path, { method: 'GET', query, ...opts });

// 浏览器授权（约定 S）：S1 发起、S5 轮询都不带令牌；S8 用插件令牌自身吊销。
export async function startPluginAuthorization(cfg, body, opts = {}) {
  return requestJson({ serverUrl: cfg?.serverUrl }, '/auth/plugin-authorize/start', {
    method: 'POST',
    body,
    requireAuth: false,
    ...opts,
  });
}

export async function pollPluginAuthorization(cfg, { requestId, pollSecret }, opts = {}) {
  return requestJson({ serverUrl: cfg?.serverUrl }, '/auth/plugin-authorize/poll', {
    method: 'POST',
    body: { requestId, pollSecret },
    requireAuth: false,
    ...opts,
  });
}

export async function revokePluginToken(cfg, opts = {}) {
  return requestJson(cfg, '/auth/plugin-token/revoke', { method: 'POST', ...opts });
}

// S9：当前用户（角色、部门、岗位类型、权限）。
export const getAuthInfo = (cfg, opts) => get(cfg, '/auth/info', undefined, opts);

// 以下都是只读的列表、汇总、看板、统计接口；查询参数名与销售系统 Controller 一致。
export const listCustomers = (cfg, query, opts) => get(cfg, '/customers', query, opts);
export const listChannels = (cfg, query, opts) => get(cfg, '/channels', query, opts);
export const listProjects = (cfg, query, opts) => get(cfg, '/projects', query, opts);
export const getProjectSummary = (cfg, query, opts) => get(cfg, '/projects/summary', query, opts);
export const getHomeDashboard = (cfg, opts) => get(cfg, '/projects/dashboard/home', undefined, opts);
export const getSalesDashboard = (cfg, query, opts) => get(cfg, '/projects/dashboard/sales', query, opts);
export const getOpportunityDashboard = (cfg, query, opts) => get(cfg, '/projects/dashboard/opportunity', query, opts);
export const getMarketDashboard = (cfg, query, opts) => get(cfg, '/projects/dashboard/market', query, opts);
export const listWorkReports = (cfg, query, opts) => get(cfg, '/work-reports', query, opts);
export const listWeeklyReports = (cfg, query, opts) => get(cfg, '/work-reports/weekly-reports/list', query, opts);
export const getWeeklyPlan = (cfg, query, opts) => get(cfg, '/work-reports/weekly-plans', query, opts);
export const getPersonalTargets = (cfg, query, opts) => get(cfg, '/sales-targets/personal-completion', query, opts);
export const getTeamTargets = (cfg, query, opts) => get(cfg, '/sales-targets/team-completion', query, opts);
export const searchAll = (cfg, query, opts) => get(cfg, '/search/all', query, opts);
export const listScopeUsers = (cfg, opts) => get(cfg, '/users/scope', undefined, opts);

// 详情和下属数据：id 是调用方校验过的正整数；kind 是 customers 或 channels。
const idPath = (id) => String(Math.trunc(Number(id)));
const ORG_KINDS = new Set(['customers', 'channels']);
const TRANSFER_KINDS = new Set(['customers', 'channels', 'projects']);
function orgPath(kind) {
  if (!ORG_KINDS.has(kind)) throw new ApiError('内部错误：未知的数据类型。', { code: 'INVALID_ARGUMENT' });
  return `/${kind}`;
}
export const getCustomer = (cfg, id, opts) => get(cfg, `/customers/${idPath(id)}`, undefined, opts);
export const getChannel = (cfg, id, opts) => get(cfg, `/channels/${idPath(id)}`, undefined, opts);
export const listCustomerContacts = (cfg, id, opts) => get(cfg, `/customers/${idPath(id)}/contacts`, undefined, opts);
export const listChannelContacts = (cfg, id, opts) => get(cfg, `/channels/${idPath(id)}/contacts`, undefined, opts);
export const listOrgDepts = (cfg, kind, id, opts) => get(cfg, `${orgPath(kind)}/${idPath(id)}/depts`, undefined, opts);
export const getProject = (cfg, id, opts) => get(cfg, `/projects/${idPath(id)}`, undefined, opts);
export const listProjectReviews = (cfg, id, opts) => get(cfg, `/projects/${idPath(id)}/reviews`, undefined, opts);
export const getProjectAnalysis = (cfg, id, opts) => get(cfg, `/projects/${idPath(id)}/analysis`, undefined, opts);
export const listProducts = (cfg, query, opts) => get(cfg, '/products', query, opts);
export const getWorkReport = (cfg, id, opts) => get(cfg, `/work-reports/${idPath(id)}`, undefined, opts);
export const getWeeklyReport = (cfg, query, opts) => get(cfg, '/work-reports/weekly-reports', query, opts);
export const listSalesTargets = (cfg, query, opts) => get(cfg, '/sales-targets', query, opts);

// 新建工作日报（一次拜访记录）。后端返回新日报的 id；报告人固定是令牌对应的用户。
export async function createWorkReport(cfg, report, opts = {}) {
  return requestJson(cfg, '/work-reports', { method: 'POST', body: report, ...opts });
}

// 其余写接口：报错时转告销售系统的业务提示（writing）。删除和移交只在用户点了确认卡片后调用。
const send = (cfg, method, path, body, opts = {}) => requestJson(cfg, path, { method, body, writing: true, ...opts });

export const createOrg = (cfg, kind, body, opts) => send(cfg, 'POST', orgPath(kind), body, opts);
export const updateOrg = (cfg, kind, id, body, opts) => send(cfg, 'PUT', `${orgPath(kind)}/${idPath(id)}`, body, opts);
export const deleteOrg = (cfg, kind, id, opts) => send(cfg, 'DELETE', `${orgPath(kind)}/${idPath(id)}`, undefined, opts);
export const addOrgContact = (cfg, kind, id, body, opts) => send(cfg, 'POST', `${orgPath(kind)}/${idPath(id)}/contacts`, body, opts);
export const updateOrgContact = (cfg, kind, contactId, body, opts) =>
  send(cfg, 'PUT', `${orgPath(kind)}/contacts/${idPath(contactId)}`, body, opts);
export const deleteOrgContact = (cfg, kind, contactId, opts) =>
  send(cfg, 'DELETE', `${orgPath(kind)}/contacts/${idPath(contactId)}`, undefined, opts);
export const addOrgDept = (cfg, kind, id, body, opts) => send(cfg, 'POST', `${orgPath(kind)}/${idPath(id)}/depts`, body, opts);
export const deleteOrgDept = (cfg, kind, deptId, opts) => send(cfg, 'DELETE', `${orgPath(kind)}/depts/${idPath(deptId)}`, undefined, opts);

export const createProject = (cfg, body, opts) => send(cfg, 'POST', '/projects', body, opts);
export const updateProject = (cfg, id, body, opts) => send(cfg, 'PUT', `/projects/${idPath(id)}`, body, opts);
export const deleteProject = (cfg, id, opts) => send(cfg, 'DELETE', `/projects/${idPath(id)}`, undefined, opts);
export const addProjectReview = (cfg, id, body, opts) => send(cfg, 'POST', `/projects/${idPath(id)}/reviews`, body, opts);
export const updateProjectReview = (cfg, reviewId, body, opts) => send(cfg, 'PUT', `/projects/reviews/${idPath(reviewId)}`, body, opts);
export const saveProjectAnalysis = (cfg, id, body, opts) => send(cfg, 'PUT', `/projects/${idPath(id)}/analysis`, body, opts);

export const updateWorkReport = (cfg, id, body, opts) => send(cfg, 'PUT', `/work-reports/${idPath(id)}`, body, opts);
export const deleteWorkReport = (cfg, id, opts) => send(cfg, 'DELETE', `/work-reports/${idPath(id)}`, undefined, opts);
export const saveWeeklyPlan = (cfg, body, opts) => send(cfg, 'PUT', '/work-reports/weekly-plans', body, opts);
export const saveWeeklyReport = (cfg, body, opts) => send(cfg, 'PUT', '/work-reports/weekly-reports', body, opts);
export const deleteWeeklyReport = (cfg, id, opts) => send(cfg, 'DELETE', `/work-reports/weekly-reports/${idPath(id)}`, undefined, opts);

export const saveSalesTarget = (cfg, body, opts) => send(cfg, 'POST', '/sales-targets', body, opts);
export const deleteSalesTarget = (cfg, id, opts) => send(cfg, 'DELETE', `/sales-targets/${idPath(id)}`, undefined, opts);

export function transferOwner(cfg, kind, body, opts) {
  if (!TRANSFER_KINDS.has(kind)) throw new ApiError('内部错误：未知的数据类型。', { code: 'INVALID_ARGUMENT' });
  return send(cfg, 'POST', `/${kind}/transfer`, body, opts);
}

export const defaultApiClient = Object.freeze({
  startPluginAuthorization,
  pollPluginAuthorization,
  revokePluginToken,
  getAuthInfo,
  listCustomers,
  listChannels,
  listProjects,
  getProjectSummary,
  getHomeDashboard,
  getSalesDashboard,
  getOpportunityDashboard,
  getMarketDashboard,
  listWorkReports,
  listWeeklyReports,
  getWeeklyPlan,
  getPersonalTargets,
  getTeamTargets,
  searchAll,
  listScopeUsers,
  getCustomer,
  getChannel,
  listCustomerContacts,
  listChannelContacts,
  listOrgDepts,
  getProject,
  listProjectReviews,
  getProjectAnalysis,
  listProducts,
  getWorkReport,
  getWeeklyReport,
  listSalesTargets,
  createWorkReport,
  createOrg,
  updateOrg,
  deleteOrg,
  addOrgContact,
  updateOrgContact,
  deleteOrgContact,
  addOrgDept,
  deleteOrgDept,
  createProject,
  updateProject,
  deleteProject,
  addProjectReview,
  updateProjectReview,
  saveProjectAnalysis,
  updateWorkReport,
  deleteWorkReport,
  saveWeeklyPlan,
  saveWeeklyReport,
  deleteWeeklyReport,
  saveSalesTarget,
  deleteSalesTarget,
  transferOwner,
});
