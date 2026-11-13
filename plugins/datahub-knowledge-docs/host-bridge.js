import { createHash } from 'node:crypto';
import { RETRIEVE_TOOL, RECORD_TYPE, readKnowledgeResult, collectDocuments, validateSelection } from './results.js';
import { projectEvents } from './event-projection.js';

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';
const PAGE_SIZE = 20;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const within = (seq, range) => typeof seq === 'number' && seq >= range.startSeq && seq <= range.endSeq;

/** Read only the connection fields needed to resolve site-relative original paths. */
export function readKnowledgeOrigin(ctx) {
  const loader = ctx.get('loader');
  if (!loader?.entries) return undefined;
  const matches = [];
  for (const entry of loader.entries()) {
    if (entry.options?.name !== MCP_CLIENT || entry.disabled || entry.fiber?.state !== 2) continue;
    const config = entry.fiber.effectiveConfig;
    if (config?.serverName !== 'datahub-knowledge' || config.transport !== 'streamable-http') continue;
    matches.push(config.url);
  }
  if (matches.length !== 1 || typeof matches[0] !== 'string') return undefined;
  try {
    const url = new URL(matches[0]);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch { return undefined; }
}

function normalizePayload(payload, sourceOrigin) {
  const pick = (input, keys) => Object.fromEntries(keys.filter(key => own(input, key)).map(key => [key, input[key]]));
  return {
    schemaVersion: 2,
    purpose: payload.purpose,
    query: typeof payload.query === 'string' ? payload.query : '',
    retrievalId: payload.retrievalId,
    documents: payload.documents.map(document => ({
      ...pick(document, ['documentRef', 'knowledgeBaseId', 'knowledgeBaseName', 'docId', 'documentName',
        'contentType', 'sourceAvailable', 'openStatus', 'openPath', 'openUrlExpiresAt']),
      linkProtocol: 'path',
      ...(sourceOrigin ? { sourceOrigin } : {}),
    })),
    evidence: payload.evidence.map(evidence => pick(evidence, ['evidenceId', 'documentRef', 'chunkId', 'text'])),
  };
}

function findCall(events, callId) {
  const ranges = events.filter(event => event.surfaceOp?.op === 'replace').map(event => event.surfaceOp);
  return events.find(event => event.type === 'tool/call' && event.data?.callId === callId &&
    event.data.name === RETRIEVE_TOOL && event.data.turn != null &&
    (event.surfaceOp == null || event.surfaceOp === 'append') &&
    !ranges.some(range => within(event.seq, range)));
}

/** The hook deliberately completes synchronously before host result processing continues. */
export function registerHostBridge(ctx, appendFn) {
  const written = new WeakMap();
  return ctx.on('tools/result', (exec, result) => {
    if (exec.name !== RETRIEVE_TOOL || !exec.agent?.id || typeof exec.callId !== 'string') return;
    const session = ctx.sessions.get(exec.agent.id);
    if (!session) return;
    const events = session.snapshotEvents();
    const call = findCall(events, exec.callId);
    if (!call) return;
    const key = JSON.stringify([call.data.turn, exec.callId, call.seq]);
    const seen = written.get(session);
    if (seen?.has(key) || events.some(event => event.type === RECORD_TYPE &&
      event.data?.turn === call.data.turn && event.data.callId === exec.callId && event.data.callSeq === call.seq)) return;
    // The value is the full MCP result even when the model-facing content was spilled.
    const parsed = result.error != null && result.error !== false
      ? readKnowledgeResult({ error: result.error })
      : result.isError
        ? readKnowledgeResult({ isError: true, content: result.value?.content })
        : readKnowledgeResult(result.value);
    const data = { version: 1, turn: call.data.turn, callId: exec.callId, callSeq: call.seq, status: parsed.status };
    if (parsed.status === 'success') data.payload = normalizePayload(parsed.payload, readKnowledgeOrigin(ctx));
    else data.message = parsed.message;
    appendFn(session, RECORD_TYPE, data);
    if (seen) seen.add(key);
    else written.set(session, new Set([key]));
  });
}

function currentTurn(events) {
  return events.findLast(event => event.type === 'turn/start')?.data?.turn;
}

function candidateFingerprint(turn, records) {
  return createHash('sha256').update(JSON.stringify([turn, records.map(record => [record.callId, record.callSeq,
    record.resultSeq, record.status, record.payload?.retrievalId,
    record.payload?.documents.map(document => document.documentRef),
    record.payload?.evidence.map(evidence => evidence.evidenceId)])])).digest('hex');
}

function indexPage(turn, records, cursor) {
  const fingerprint = candidateFingerprint(turn, records);
  const documents = collectDocuments(records);
  let offset = 0;
  if (cursor !== undefined) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (value.version !== 1 || value.turn !== turn || value.fingerprint !== fingerprint ||
        !Number.isInteger(value.offset) || value.offset <= 0 || value.offset % PAGE_SIZE !== 0 || value.offset >= documents.length) throw new Error();
      offset = value.offset;
    } catch { throw new Error('候选游标已失效，请省略 cursor 重新读取当前回合候选。'); }
  }
  const nextOffset = offset + PAGE_SIZE;
  const page = documents.slice(offset, nextOffset).map(document => ({
    documentRef: document.documentRef, documentName: document.documentName,
    knowledgeBaseId: document.knowledgeBaseId, knowledgeBaseName: document.knowledgeBaseName,
    evidence: document.evidence.slice(0, 2).map(evidence => ({ evidenceId: evidence.evidenceId,
      text: Array.from(evidence.text).slice(0, 80).join('') })),
  }));
  return { kind: 'knowledge-documents-candidates', total: documents.length, documents: page,
    ...(nextOffset < documents.length ? { cursor: Buffer.from(JSON.stringify({ version: 1, turn,
      fingerprint, offset: nextOffset })).toString('base64url') } : {}) };
}

/** Final choices are resolved against committed, current-turn tool results only. */
export function presentKnowledgeDocuments(args, events) {
  if (!['documents', 'knowledge'].includes(args.purpose)) throw new Error('purpose 必须为 documents 或 knowledge。');
  const { records, userText } = projectEvents(events);
  if (!own(args, 'documentRefs')) {
    if (own(args, 'evidenceIds')) throw new Error('读取候选索引时不能提交 evidenceIds。');
    return indexPage(currentTurn(events), records, args.cursor);
  }
  if (own(args, 'cursor')) throw new Error('cursor 仅用于读取候选索引，不能与最终选择一起提交。');
  if (args.purpose === 'documents' && own(args, 'evidenceIds')) throw new Error('evidenceIds 仅用于 knowledge 来源选择。');
  return validateSelection(records, args, userText);
}
