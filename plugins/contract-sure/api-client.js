import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

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

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'API_ERROR', details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeServerUrl(serverUrl) {
  if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
    throw new ApiError('尚未配置履约无忧后端地址（serverUrl）。', { code: 'CONFIG_MISSING' });
  }
  const cleaned = serverUrl.trim().replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new ApiError(`后端接口地址格式无效：${serverUrl}`, { code: 'INVALID_URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(`后端接口地址仅支持 HTTP/HTTPS 协议：${serverUrl}`, { code: 'INVALID_URL' });
  }
  return cleaned;
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
    return { _rawText: raw };
  }
}

function assertEnvelope(response, body) {
  const status = response.status;
  if (status === 401 || body?.code === 401) {
    throw new ApiError(
      body?.message && body.message !== 'Unauthorized'
        ? `认证失败：${body.message}。请在「设置 → 履约无忧配置」重新配置令牌。`
        : '认证失败或令牌已过期，请在「设置 → 履约无忧配置」重新配置或换取长期令牌。',
      { status: 401, code: 'UNAUTHORIZED' },
    );
  }
  if (status === 403 || body?.code === 403) {
    throw new ApiError(
      `无操作权限：${body?.message || '请联系管理员检查账号角色或数据权限。'}`,
      { status: 403, code: 'FORBIDDEN' },
    );
  }
  if (!response.ok) {
    const msg = body?.message || body?.error || `履约无忧后端返回错误（HTTP ${status}）`;
    throw new ApiError(msg, { status, code: body?.code ?? `HTTP_${status}` });
  }
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'code')) {
    if (body.code !== 200) {
      throw new ApiError(body.message || `后端业务处理失败（code=${body.code}）`, {
        status,
        code: body.code,
      });
    }
    return body.data;
  }
  if (body && typeof body === 'object' && '_rawText' in body) {
    throw new ApiError('后端返回了非 JSON 响应，请检查 serverUrl 是否正确指向 /api/v1。', {
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
      throw new ApiError(
        '尚未配置履约无忧访问令牌（apiToken），请在「设置 → 履约无忧配置」填写或调用 contract_config 登录换取长期令牌。',
        { status: 401, code: 'TOKEN_MISSING' },
      );
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
    const response = await fetchImpl(url, {
      method,
      headers,
      body: fetchBody,
      signal: timed.signal,
    });
    const parsed = await parseJsonSafe(response);
    return assertEnvelope(response, parsed);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timed.isTimedOut()) {
      throw new ApiError(`请求履约无忧后端超时（>${Math.round(timeoutMs / 1000)}秒），请检查网络或服务状态。`, {
        code: 'TIMEOUT',
      });
    }
    if (signal?.aborted) {
      throw new ApiError('请求已取消。', { code: 'CANCELLED' });
    }
    throw new ApiError(`无法连接履约无忧后端（${url}）：${error?.message || '网络错误'}`, {
      code: 'NETWORK_ERROR',
    });
  } finally {
    timed.cleanup();
  }
}

async function buildFileFormData(filePath, fields = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new ApiError('文件路径不能为空。', { code: 'INVALID_ARGUMENT' });
  }
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    throw new ApiError(`本地文件不存在或无法读取：${filePath}`, { code: 'FILE_NOT_FOUND' });
  }
  if (!fileInfo.isFile()) {
    throw new ApiError(`目标路径不是普通文件：${filePath}`, { code: 'INVALID_FILE' });
  }
  const bytes = await readFile(filePath);
  const form = new FormData();
  const blob = new Blob([bytes], { type: mimeTypeForFile(filePath) });
  form.append('file', blob, basename(filePath));
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    form.append(key, String(value));
  }
  return form;
}

export async function exchangePluginToken({ serverUrl, username, password, ttlDays = 90, apiToken = '' }, opts = {}) {
  const payload = { ttlDays };
  if (username) payload.username = username;
  if (password) payload.password = password;
  return requestJson(
    { serverUrl, apiToken },
    '/auth/plugin-token',
    { method: 'POST', body: payload, requireAuth: false, ...opts },
  );
}

export async function getMe(cfg, opts = {}) {
  return requestJson(cfg, '/auth/me', { method: 'GET', ...opts });
}

export async function extractPdfText(cfg, filePath, opts = {}) {
  const form = await buildFileFormData(filePath);
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
  const form = await buildFileFormData(filePath, { txnType });
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
    throw new ApiError('尚未配置履约无忧访问令牌，无法下载原件。', { status: 401, code: 'UNAUTHORIZED' });
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
      throw new ApiError('认证失败或令牌已过期，无法下载原件。', { status: 401, code: 'UNAUTHORIZED' });
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
    throw new ApiError(`原件下载失败：${error?.message || '未知错误'}`, { code: 'DOWNLOAD_FAILED' });
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
  exchangePluginToken,
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
