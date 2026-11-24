import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
// 上传或读取的本地文件：只允许这些扩展名，必须是普通文件，不超过 20MB。
export const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;
export const UPLOAD_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.xlsx', '.xls', '.png', '.jpg', '.jpeg']);
export const EXCEL_EXTENSIONS = Object.freeze(['.xlsx', '.xls']);
export const PDF_EXTENSIONS = Object.freeze(['.pdf']);
const READ_CHUNK_BYTES = 1024 * 1024;

const MIME_BY_EXT = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
});

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
    throw new ApiError('尚未配置履约系统服务器地址。', { code: 'CONFIG_MISSING' });
  }
  return normalizeHttpUrl(serverUrl, '服务器地址');
}

export function mimeTypeForFile(filePath) {
  const ext = extname(String(filePath || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
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

const UNAUTHORIZED_MESSAGE = '履约系统账户的授权已失效或过期，请在「设置 → 履约无忧配置」重新连接账户。';
const FORBIDDEN_MESSAGE = '无操作权限：当前账户没有这项操作的权限，请联系管理员检查账号角色或数据权限。';

// 信封里的业务错误码（HTTP 200 + code）对应的固定文案。
const BUSINESS_ERRORS = Object.freeze({
  400: ['BAD_REQUEST', '请求参数不符合履约系统的要求，请检查后重试。'],
  404: ['NOT_FOUND', '要操作的数据在履约系统里不存在（可能已被删除），请核对编号。'],
  409: ['CONFLICT', '与履约系统里已有的数据冲突（例如合同编号已存在），请核对后重试。'],
  410: ['GONE', '请求已过期，请重新发起。'],
  429: ['RATE_LIMITED', '请求太频繁，请稍后再试。'],
});

function businessError(rawCode, status) {
  const businessCode = Number.isSafeInteger(Number(rawCode)) ? Number(rawCode) : null;
  const known = businessCode !== null ? BUSINESS_ERRORS[businessCode] : null;
  if (known) return new ApiError(known[1], { status, code: known[0], businessCode });
  const shown = businessCode ?? '未知';
  if (businessCode !== null && businessCode >= 500) {
    return new ApiError(`履约系统处理失败（业务代码 ${shown}），请稍后重试或联系管理员。`, {
      status,
      code: 'SERVER_ERROR',
      businessCode,
    });
  }
  return new ApiError(`履约系统拒绝了这次操作（业务代码 ${shown}）。`, {
    status,
    code: 'BUSINESS_ERROR',
    ...(businessCode !== null ? { businessCode } : {}),
  });
}

// 先看 HTTP 状态；HTTP 成功时才看信封里的 code（L1 的业务 403/404/409 等都是 HTTP 200 + code）。
function assertEnvelope(response, body) {
  const status = response.status;
  if (status === 401) throw new ApiError(UNAUTHORIZED_MESSAGE, { status, code: 'UNAUTHORIZED' });
  if (status === 403) throw new ApiError(FORBIDDEN_MESSAGE, { status, code: 'FORBIDDEN' });
  if (!response.ok) {
    if (status === 429) throw new ApiError('请求太频繁，请稍后再试。', { status, code: 'RATE_LIMITED' });
    if (status >= 500) {
      throw new ApiError(`履约系统暂时不可用（HTTP ${status}），请稍后重试。`, { status, code: 'SERVER_ERROR' });
    }
    throw new ApiError(`履约系统返回错误（HTTP ${status}）。`, { status, code: 'HTTP_ERROR' });
  }
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'code')) {
    const code = Number(body.code);
    if (code === 200) return body.data;
    if (code === 401) throw new ApiError(UNAUTHORIZED_MESSAGE, { status, code: 'UNAUTHORIZED', businessCode: 401 });
    if (code === 403) throw new ApiError(FORBIDDEN_MESSAGE, { status, code: 'FORBIDDEN', businessCode: 403 });
    throw businessError(body.code, status);
  }
  if (body && typeof body === 'object' && '_rawText' in body) {
    throw new ApiError('履约系统返回了非 JSON 响应，请检查服务器地址是否指向 /api/v1。', {
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
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetchImpl = globalThis.fetch,
  } = options;

  const url = buildUrl(cfg?.serverUrl, path, query);
  const headers = { Accept: 'application/json' };
  const token = typeof cfg?.apiToken === 'string' ? cfg.apiToken.trim() : '';
  if (requireAuth) {
    if (!token) {
      throw new ApiError('尚未连接履约系统账户，请在「设置 → 履约无忧配置」点「连接账户」完成浏览器授权。', {
        code: 'TOKEN_MISSING',
      });
    }
    headers.Authorization = `Bearer ${token}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let fetchBody;
  if (body !== undefined) {
    if (body instanceof FormData) {
      fetchBody = body;
    } else {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }
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
    return assertEnvelope(response, parsed);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timed.isTimedOut()) {
      throw new ApiError(`请求履约系统超时（>${Math.round(timeoutMs / 1000)}秒），请检查网络或服务状态。`, {
        code: 'TIMEOUT',
      });
    }
    if (signal?.aborted) {
      throw new ApiError('请求已取消。', { code: 'CANCELLED' });
    }
    // 底层异常（含无效请求头时带出的 header 值）不回显。
    throw new ApiError('无法连接履约系统（或服务器返回了重定向），请检查服务器地址和网络。', {
      code: 'NETWORK_ERROR',
    });
  } finally {
    timed.cleanup();
  }
}

const sameFileKind = (a, b) => a === b || (['.jpg', '.jpeg'].includes(a) && ['.jpg', '.jpeg'].includes(b));

function tooLargeError(maxBytes, givenPath, size) {
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const sizeText = Number.isFinite(size) ? `（${(size / 1024 / 1024).toFixed(1)}MB）` : '';
  return new ApiError(`文件超过 ${limitMb}MB 上限${sizeText}：${givenPath}`, { code: 'TOO_LARGE' });
}

/**
 * 检查要上传或读取的本地文件：扩展名在白名单内、是普通文件、不超过大小上限。
 * 符号链接按指向的真实文件判断，且真实文件的类型必须和入口扩展名一致（不允许 .png 指向 .txt 这种跨类型链接）。
 * 返回真实路径和大小。
 */
export async function inspectLocalFile(filePath, { allowedExtensions = UPLOAD_EXTENSIONS, maxBytes = MAX_LOCAL_FILE_BYTES } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ApiError('文件路径不能为空。', { code: 'INVALID_ARGUMENT' });
  }
  const givenPath = filePath.trim();
  const allowedText = allowedExtensions.join('、');
  const ext = extname(givenPath).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new ApiError(`不支持该文件类型（${ext || '无扩展名'}），只允许 ${allowedText}。`, { code: 'UNSUPPORTED_FORMAT' });
  }
  let realPath;
  let info;
  try {
    realPath = await realpath(givenPath);
    info = await stat(realPath);
  } catch {
    throw new ApiError(`本地文件不存在或无法读取：${givenPath}`, { code: 'FILE_NOT_FOUND' });
  }
  if (!info.isFile()) {
    throw new ApiError(`目标路径不是普通文件：${givenPath}`, { code: 'INVALID_FILE' });
  }
  if (!sameFileKind(ext, extname(realPath).toLowerCase())) {
    throw new ApiError(`链接指向的文件类型和扩展名不一致，只允许 ${allowedText}。`, { code: 'UNSUPPORTED_FORMAT' });
  }
  if (info.size > maxBytes) throw tooLargeError(maxBytes, givenPath, info.size);
  return { path: realPath, fileName: basename(givenPath), ext, size: info.size };
}

/**
 * 从已打开的文件里最多读 maxBytes + 1 字节：读到第 maxBytes + 1 个字节就拒绝。
 * 文件在检查之后被追加变大时，实际读入的字节数仍受上限约束。
 */
export async function readFileBounded(filePath, maxBytes = MAX_LOCAL_FILE_BYTES, givenPath = filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    throw new ApiError(`本地文件不存在或无法读取：${givenPath}`, { code: 'FILE_NOT_FOUND' });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ApiError(`目标路径不是普通文件：${givenPath}`, { code: 'INVALID_FILE' });
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw tooLargeError(maxBytes, givenPath);
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(`读取本地文件失败：${givenPath}`, { code: 'FILE_READ_FAILED' });
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 检查并读入本地文件。返回 { path, fileName, ext, size, bytes }，后续上传、抽字、OCR 都用这一份字节。 */
export async function readLocalFile(filePath, { allowedExtensions = UPLOAD_EXTENSIONS, maxBytes = MAX_LOCAL_FILE_BYTES } = {}) {
  const file = await inspectLocalFile(filePath, { allowedExtensions, maxBytes });
  const bytes = await readFileBounded(file.path, maxBytes, filePath.trim());
  return { ...file, size: bytes.byteLength, bytes };
}

function isLoadedFile(file) {
  return Boolean(file) && typeof file === 'object' && Buffer.isBuffer(file.bytes) && typeof file.fileName === 'string';
}

// 接受本地路径，或 readLocalFile 已经读好的文件对象（复用同一份字节，不再按路径重读）。
async function loadFile(file, allowedExtensions) {
  if (!isLoadedFile(file)) return readLocalFile(file, { allowedExtensions });
  const ext = extname(file.fileName).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new ApiError(`不支持该文件类型（${ext || '无扩展名'}），只允许 ${allowedExtensions.join('、')}。`, {
      code: 'UNSUPPORTED_FORMAT',
    });
  }
  if (file.bytes.byteLength > MAX_LOCAL_FILE_BYTES) throw tooLargeError(MAX_LOCAL_FILE_BYTES, file.fileName);
  return file;
}

async function buildFileFormData(file, fields = {}, allowedExtensions = UPLOAD_EXTENSIONS) {
  const loaded = await loadFile(file, allowedExtensions);
  const form = new FormData();
  const blob = new Blob([loaded.bytes], { type: mimeTypeForFile(loaded.fileName) });
  form.append('file', blob, loaded.fileName);
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }
  return form;
}

// 浏览器授权（约定 A）：A1 发起、A5 轮询都不带令牌；A8 用插件令牌自身吊销。
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

export async function getMe(cfg, opts = {}) {
  return requestJson(cfg, '/auth/me', { method: 'GET', ...opts });
}

// file 可以是本地路径，也可以是 readLocalFile 读好的文件对象。
export async function extractPdfText(cfg, file, opts = {}) {
  const form = await buildFileFormData(file, {}, PDF_EXTENSIONS);
  return requestJson(cfg, '/contracts/documents/extract-text', {
    method: 'POST',
    body: form,
    timeoutMs: opts.timeoutMs ?? 60_000,
    ...opts,
  });
}

export async function validateContractDraft(cfg, draft, opts = {}) {
  return requestJson(cfg, '/contracts/validate', {
    method: 'POST',
    body: draft,
    ...opts,
  });
}

export async function createContract(cfg, draft, opts = {}) {
  return requestJson(cfg, '/contracts', {
    method: 'POST',
    body: draft,
    ...opts,
  });
}

export async function uploadContractFile(cfg, contractId, filePath, docType = 1, opts = {}) {
  const form = await buildFileFormData(filePath, { docType });
  return requestJson(cfg, `/contracts/${encodeURIComponent(String(contractId))}/upload`, {
    method: 'POST',
    body: form,
    timeoutMs: opts.timeoutMs ?? 60_000,
    ...opts,
  });
}

export async function uploadNodeDocument(cfg, contractId, nodeId, filePath, { docType, amount, eventDate } = {}, opts = {}) {
  const fields = { docType };
  if (amount !== undefined && amount !== null && amount !== '') fields.amount = amount;
  if (eventDate !== undefined && eventDate !== null && eventDate !== '') fields.eventDate = eventDate;
  const form = await buildFileFormData(filePath, fields);
  return requestJson(
    cfg,
    `/contracts/${encodeURIComponent(String(contractId))}/nodes/${encodeURIComponent(String(nodeId))}/upload`,
    {
      method: 'POST',
      body: form,
      timeoutMs: opts.timeoutMs ?? 60_000,
      ...opts,
    },
  );
}

export async function listContracts(cfg, params = {}, opts = {}) {
  return requestJson(cfg, '/contracts', {
    method: 'GET',
    query: {
      keyword: params.keyword,
      contractType: params.contractType,
      status: params.status,
      deptId: params.deptId,
      startDate: params.startDate,
      endDate: params.endDate,
      pageNum: params.pageNum ?? 1,
      pageSize: params.pageSize ?? 20,
    },
    ...opts,
  });
}

export async function getContractDetail(cfg, contractId, opts = {}) {
  return requestJson(cfg, `/contracts/${encodeURIComponent(String(contractId))}`, {
    method: 'GET',
    ...opts,
  });
}

export async function getDashboardStats(cfg, contractType, opts = {}) {
  return requestJson(cfg, '/contracts/dashboard/stats', {
    method: 'GET',
    query: contractType != null ? { contractType } : undefined,
    ...opts,
  });
}

export async function getDashboardTrends(cfg, contractType, year, opts = {}) {
  return requestJson(cfg, '/contracts/dashboard/trends', {
    method: 'GET',
    query: {
      ...(contractType != null ? { contractType } : {}),
      ...(year != null ? { year } : {}),
    },
    ...opts,
  });
}

export async function uploadTransactionExcel(cfg, filePath, txnType, opts = {}) {
  const form = await buildFileFormData(filePath, { txnType }, EXCEL_EXTENSIONS);
  return requestJson(cfg, '/transactions/upload', {
    method: 'POST',
    body: form,
    timeoutMs: opts.timeoutMs ?? 90_000,
    ...opts,
  });
}

export async function getUnmatchedTransactions(cfg, opts = {}) {
  return requestJson(cfg, '/transactions/unmatched', { method: 'GET', ...opts });
}

export async function getTransactionPool(cfg, params = {}, opts = {}) {
  return requestJson(cfg, '/transactions/pool', {
    method: 'GET',
    query: {
      txnType: params.txnType,
      matchedContractId: params.matchedContractId,
      matchStatus: params.matchStatus,
    },
    ...opts,
  });
}

export async function getTransactionSummary(cfg, opts = {}) {
  return requestJson(cfg, '/transactions/summary', { method: 'GET', ...opts });
}

export async function manualMatchTransaction(cfg, transactionId, contractId, nodeId, opts = {}) {
  return requestJson(cfg, `/transactions/${encodeURIComponent(String(transactionId))}/match`, {
    method: 'POST',
    query: {
      contractId,
      ...(nodeId != null ? { nodeId } : {}),
    },
    ...opts,
  });
}

export async function manualSetNodeDate(cfg, nodeId, { contractId, date, remark }, opts = {}) {
  return requestJson(cfg, `/contracts/nodes/${encodeURIComponent(String(nodeId))}/manual-date`, {
    method: 'POST',
    body: {
      contractId,
      date,
      remark: remark ?? '',
    },
    ...opts,
  });
}

export function validateDownloadedMagic(prefix, contentType, destPath) {
  const text = prefix.toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  if (
    /^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/iu.test(text) ||
    /(?:text\/html|application\/(?:json|problem\+json|xhtml\+xml))/iu.test(contentType || '')
  ) {
    throw new ApiError('下载内容不是有效的原件文件（服务端返回了 HTML 或 JSON 响应）。', {
      code: 'DOWNLOAD_FAILED',
    });
  }
  const ext = extname(destPath).toLowerCase();
  if (ext === '.pdf' && prefix.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new ApiError('PDF 原件文件头校验失败。', { code: 'DOWNLOAD_FAILED' });
  }
  if (
    ext === '.png' &&
    (prefix.length < 4 || prefix[0] !== 0x89 || prefix[1] !== 0x50 || prefix[2] !== 0x4e || prefix[3] !== 0x47)
  ) {
    throw new ApiError('PNG 原件文件头校验失败。', { code: 'DOWNLOAD_FAILED' });
  }
  if (
    (ext === '.jpg' || ext === '.jpeg') &&
    (prefix.length < 3 || prefix[0] !== 0xff || prefix[1] !== 0xd8 || prefix[2] !== 0xff)
  ) {
    throw new ApiError('JPEG 原件文件头校验失败。', { code: 'DOWNLOAD_FAILED' });
  }
  if (
    (ext === '.xlsx' || ext === '.docx') &&
    (prefix.length < 4 || prefix[0] !== 0x50 || prefix[1] !== 0x4b || prefix[2] !== 0x03 || prefix[3] !== 0x04)
  ) {
    throw new ApiError('Office 原件文件头校验失败。', { code: 'DOWNLOAD_FAILED' });
  }
}

export async function downloadDocumentToCache(cfg, docId, destPath, signal, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_DOWNLOAD_BYTES,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
  } = opts;

  const token = typeof cfg?.apiToken === 'string' ? cfg.apiToken.trim() : '';
  if (!token) {
    throw new ApiError('尚未连接履约系统账户，无法下载原件。', { status: 401, code: 'TOKEN_MISSING' });
  }
  const url = buildUrl(cfg?.serverUrl, `/contracts/documents/${encodeURIComponent(String(docId))}/download`);
  const timed = createTimedSignal(signal, timeoutMs);
  const temporary = `${destPath}.${randomUUID()}.tmp`;
  let fileHandle = null;
  let bodyStream = null;

  try {
    if (signal?.aborted) throw new ApiError('已取消原件加载。', { code: 'CANCELLED' });
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: timed.signal,
      redirect: 'error',
    });
    if (response.status === 401) {
      throw new ApiError('履约系统账户的授权已失效或过期，无法下载原件。', { status: 401, code: 'UNAUTHORIZED' });
    }
    if (response.status === 403) {
      throw new ApiError('无权限查看该合同原件。', { status: 403, code: 'ACCESS_DENIED' });
    }
    if (!response.ok || !response.body) {
      throw new ApiError(`原件下载失败（HTTP ${response.status}）。`, {
        status: response.status,
        code: 'DOWNLOAD_FAILED',
      });
    }
    bodyStream = response.body;
    const contentLength = response.headers.get('content-length');
    if (contentLength != null && Number(contentLength) > maxBytes) {
      throw new ApiError('原件文件超过 50MB 预览上限。', { code: 'TOO_LARGE' });
    }
    const contentType = response.headers.get('content-type') || '';

    try {
      await mkdir(dirname(destPath), { recursive: true });
      fileHandle = await open(temporary, 'wx');
    } catch {
      throw new ApiError('本地缓存目录不可写，无法保存原件。', { code: 'CACHE_ERROR' });
    }

    let total = 0;
    let prefix = Buffer.alloc(0);
    for await (const chunk of bodyStream) {
      if (timed.signal.aborted) {
        throw new ApiError(timed.isTimedOut() ? '原件下载超时，请重试。' : '已取消原件加载。', {
          code: timed.isTimedOut() ? 'TIMEOUT' : 'CANCELLED',
        });
      }
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        throw new ApiError('原件文件超过 50MB 预览上限。', { code: 'TOO_LARGE' });
      }
      if (prefix.length < 512) {
        prefix = Buffer.concat([prefix, bytes.subarray(0, 512 - prefix.length)]);
      }
      try {
        await fileHandle.writeFile(bytes);
      } catch {
        throw new ApiError('写入原件缓存失败。', { code: 'CACHE_ERROR' });
      }
    }

    if (total === 0) {
      throw new ApiError('下载的原件为空文件。', { code: 'DOWNLOAD_FAILED' });
    }
    validateDownloadedMagic(prefix, contentType, destPath);
    try {
      await fileHandle.close();
      fileHandle = null;
      await rename(temporary, destPath);
    } catch {
      throw new ApiError('提交原件缓存文件失败。', { code: 'CACHE_ERROR' });
    }
    return { path: destPath, size: total, contentType };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timed.isTimedOut()) throw new ApiError('原件下载超时，请重试。', { code: 'TIMEOUT' });
    if (signal?.aborted) throw new ApiError('已取消原件加载。', { code: 'CANCELLED' });
    throw new ApiError('原件下载失败，请重试。', { code: 'DOWNLOAD_FAILED' });
  } finally {
    timed.cleanup();
    try {
      await bodyStream?.cancel();
    } catch {
      // Already drained or cancelled.
    }
    try {
      await fileHandle?.close();
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export const defaultApiClient = Object.freeze({
  startPluginAuthorization,
  pollPluginAuthorization,
  revokePluginToken,
  getMe,
  extractPdfText,
  validateContractDraft,
  createContract,
  uploadContractFile,
  uploadNodeDocument,
  listContracts,
  getContractDetail,
  getDashboardStats,
  getDashboardTrends,
  uploadTransactionExcel,
  getUnmatchedTransactions,
  getTransactionPool,
  getTransactionSummary,
  manualMatchTransaction,
  manualSetNodeDate,
  downloadDocumentToCache,
});
