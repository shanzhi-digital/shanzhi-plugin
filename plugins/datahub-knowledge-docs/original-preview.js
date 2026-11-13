import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { projectEvents } from './event-projection.js';
import { collectDocuments, getDocumentOpenState } from './results.js';

export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
export const ORIGINAL_TIMEOUT_MS = 60_000;
export const PREVIEW_ERRORS = Object.freeze({
  INVALID_REQUEST: '原文请求参数无效',
  ACCESS_DENIED: '无会话访问权限',
  SOURCE_UNAVAILABLE: '原文不可用',
  LINK_EXPIRED: '链接已过期，请重新检索',
  DOWNLOAD_FAILED: '下载失败，请重试',
  TOO_LARGE: '文件超过预览上限',
  TIMEOUT: '原文下载超时，请重试',
  CANCELLED: '已取消原文加载',
  CACHE_ERROR: '缓存无法读取',
});

export class OriginalPreviewError extends Error {
  constructor(code) { super(PREVIEW_ERRORS[code]); this.name = 'OriginalPreviewError'; this.code = code; }
}
const fail = code => new OriginalPreviewError(code);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkAbort = signal => { if (signal?.aborted) throw fail('CANCELLED'); };

/** Reuse the existing reducer, retaining later replacements that invalidate historical sources. */
export function projectOriginalTurn(events, turn) {
  let currentTurn;
  let started = false;
  const selected = [];
  for (const event of events) {
    if (event.type === 'turn/start') {
      currentTurn = event.data?.turn;
      if (currentTurn === turn && !started) { selected.push(event); started = true; }
      continue;
    }
    if (!started) continue;
    if (event.surfaceOp?.op === 'replace') {
      selected.push({ ...event, data: { ...event.data, turn } });
    } else if ((event.data?.turn ?? currentTurn) === turn) {
      selected.push(event);
    }
  }
  return projectEvents(selected);
}

export function safeOriginalFilename(name) {
  const cleaned = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '');
  const extension = extname(cleaned).slice(0, 32);
  let stem = cleaned.slice(0, cleaned.length - extname(cleaned).length).slice(0, 140) || 'document';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`;
  return stem + extension;
}

export function resolveOriginalUrl(document, state = getDocumentOpenState(document)) {
  if (!state.available) throw fail(state.expiresAt <= Date.now() ? 'LINK_EXPIRED' : 'SOURCE_UNAVAILABLE');
  try {
    const origin = new URL(document.sourceOrigin);
    const url = new URL(state.url);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        url.origin !== origin.origin || url.username || url.password) throw new Error('origin');
    if (url.pathname === '/source-document-preview') {
      const ticket = new URLSearchParams(url.hash.slice(1)).get('ticket');
      if (!ticket) throw new Error('ticket');
      const direct = new URL('/api/ai/rag/kb/source_document_direct', origin.origin);
      direct.searchParams.set('ticket', ticket);
      return direct.href;
    }
    url.hash = '';
    return url.href;
  } catch { throw fail('SOURCE_UNAVAILABLE'); }
}

function sourceFor(records, callId, documentRef, now) {
  const merged = collectDocuments(records).find(document => document.documentRef === documentRef);
  if (!merged?.sourceCallIds.includes(callId)) throw fail('SOURCE_UNAVAILABLE');
  const state = getDocumentOpenState(merged, now);
  if (!state.available) throw fail(state.expiresAt <= now ? 'LINK_EXPIRED' : 'SOURCE_UNAVAILABLE');
  const sources = records.filter(record => record.status === 'success').sort((a, b) => b.resultSeq - a.resultSeq);
  for (const record of sources) {
    const document = record.payload.documents.find(item => item.documentRef === documentRef);
    if (!document) continue;
    const available = getDocumentOpenState(document, now);
    if (!available.available) continue;
    // The origin must belong to this exact source, never to another merged link.
    try {
      const url = resolveOriginalUrl(document, available);
      return { document, record, url };
    } catch (error) {
      if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
    }
  }
  throw fail('SOURCE_UNAVAILABLE');
}

async function sessionEvents(ctx, sessionId, signal) {
  checkAbort(signal);
  if (!await ctx.remoteAccess.allows({ kind: 'session', id: sessionId })) throw fail('ACCESS_DENIED');
  checkAbort(signal);
  const live = ctx.sessions.get(sessionId);
  if (live) return live.snapshotEvents();
  let handle;
  try {
    handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
    const { events } = await handle.read(0, Number.MAX_SAFE_INTEGER, { signal });
    return events;
  } catch (error) {
    checkAbort(signal);
    if (error instanceof OriginalPreviewError) throw error;
    throw fail('SOURCE_UNAVAILABLE');
  } finally { if (handle) await handle.close(); }
}

function validateFile(prefix, type, filename) {
  const text = prefix.toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/iu.test(text) ||
      /(?:text\/html|application\/(?:json|problem\+json|xhtml\+xml))/iu.test(type)) throw fail('DOWNLOAD_FAILED');
  const extension = extname(filename).toLowerCase();
  if (extension === '.pdf' && prefix.subarray(0, 5).toString() !== '%PDF-') throw fail('DOWNLOAD_FAILED');
  if (extension === '.docx' && (prefix.length < 4 || prefix.readUInt32LE(0) !== 0x04034b50)) throw fail('DOWNLOAD_FAILED');
}

async function downloadOriginal(url, path, filename, { fetchImpl, maxBytes, timeoutMs }, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref?.();
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  let body;
  try {
    checkAbort(signal);
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.body) throw fail('DOWNLOAD_FAILED');
    body = response.body;
    const length = response.headers.get('content-length');
    if (length != null && Number(length) > maxBytes) throw fail('TOO_LARGE');
    const type = response.headers.get('content-type') ?? '';
    try { await mkdir(dirname(path), { recursive: true }); file = await open(temporary, 'wx'); }
    catch { throw fail('CACHE_ERROR'); }
    let total = 0;
    let prefix = Buffer.alloc(0);
    for await (const chunk of body) {
      if (controller.signal.aborted) throw fail(timedOut ? 'TIMEOUT' : 'CANCELLED');
      total += chunk.byteLength;
      if (total > maxBytes) throw fail('TOO_LARGE');
      const bytes = Buffer.from(chunk);
      if (prefix.length < 512) prefix = Buffer.concat([prefix, bytes.subarray(0, 512 - prefix.length)]);
      try { await file.writeFile(bytes); } catch { throw fail('CACHE_ERROR'); }
    }
    if (controller.signal.aborted) throw fail(timedOut ? 'TIMEOUT' : 'CANCELLED');
    if (!total) throw fail('DOWNLOAD_FAILED');
    validateFile(prefix, type, filename);
    try { await file.close(); file = null; await rename(temporary, path); }
    catch { throw fail('CACHE_ERROR'); }
  } catch (error) {
    if (timedOut) throw fail('TIMEOUT');
    if (signal.aborted) throw fail('CANCELLED');
    throw error instanceof OriginalPreviewError ? error : fail('DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
    try { await body?.cancel(); } catch { /* A consumed or cancelled body is already released. */ }
    try { await file?.close(); } finally { await rm(temporary, { force: true }); }
  }
}

/** Pure Node implementation; host APIs are injected only when registering the service. */
export function createOriginalPreviewHandler(ctx, { cachePath, fetchImpl = globalThis.fetch,
  maxBytes = MAX_ORIGINAL_BYTES, timeoutMs = ORIGINAL_TIMEOUT_MS, now = Date.now } = {}) {
  const pending = new Map();
  return async function cacheOriginal(sessionId, turn, callId, documentRef, signal, accessContext = ctx) {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(turn) || turn < 0 ||
        typeof callId !== 'string' || !callId || typeof documentRef !== 'string' || !documentRef) throw fail('INVALID_REQUEST');
    checkAbort(signal);
    const events = await sessionEvents(accessContext, sessionId, signal);
    checkAbort(signal);
    const { records } = projectOriginalTurn(events, turn);
    const { document, record, url } = sourceFor(records, callId, documentRef, now());
    const filename = safeOriginalFilename(document.documentName);
    const version = [documentRef, record.retrievalId, record.callId, record.callSeq, record.resultSeq];
    const absolutePath = cachePath('datahub-knowledge-docs', hash(sessionId), hash(version), filename);
    const result = { sessionId, absolutePath, documentName: document.documentName };
    try {
      const cached = await lstat(absolutePath);
      checkAbort(signal);
      if (!cached.isFile()) throw fail('CACHE_ERROR');
      if (cached.size > 0 && cached.size <= maxBytes) return result;
    } catch (error) {
      if (error instanceof OriginalPreviewError) throw error;
      if (error.code !== 'ENOENT') throw fail('CACHE_ERROR');
    }
    checkAbort(signal);
    let entry = pending.get(absolutePath);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, consumers: new Set() };
      pending.set(absolutePath, entry);
      entry.promise = Promise.resolve().then(() => downloadOriginal(url, absolutePath, filename,
        { fetchImpl, maxBytes, timeoutMs }, controller.signal)).finally(() => {
        if (pending.get(absolutePath) === entry) pending.delete(absolutePath);
      });
    }
    return new Promise((resolve, reject) => {
      const consumer = {};
      entry.consumers.add(consumer);
      const release = () => {
        signal?.removeEventListener('abort', cancel);
        entry.consumers.delete(consumer);
      };
      const cancel = () => {
        release();
        if (!entry.consumers.size) {
          if (pending.get(absolutePath) === entry) pending.delete(absolutePath);
          entry.controller.abort();
        }
        reject(fail('CANCELLED'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      entry.promise.then(() => { release(); resolve(result); }, error => { release(); reject(error); });
    });
  };
}

export function registerOriginalPreview(ctx, { TypertRemoteService, Remote, RemoteError, dshCachePath }) {
  const cache = createOriginalPreviewHandler(ctx, { cachePath: dshCachePath });
  const initializers = [];
  class KnowledgeDocs extends TypertRemoteService {
    static inject = ['remoteAccess', 'sessions', 'sessionPersistence'];
    constructor(ctx) { super(ctx, 'knowledgeDocs'); for (const init of initializers) init.call(this); }
    async cacheOriginal(sessionId, turn, callId, documentRef, signal) {
      try { return await cache(sessionId, turn, callId, documentRef, signal, this.ctx); }
      catch (error) {
        const safe = error instanceof OriginalPreviewError ? error : fail('DOWNLOAD_FAILED');
        throw new RemoteError(safe.code, safe.message, {});
      }
    }
  }
  Remote({ resources: { session: sessionId => sessionId } })(KnowledgeDocs.prototype.cacheOriginal, {
    kind: 'method', name: 'cacheOriginal', static: false, private: false,
    addInitializer(init) { initializers.push(init); },
  });
  ctx.plugin(KnowledgeDocs);
  return KnowledgeDocs;
}
