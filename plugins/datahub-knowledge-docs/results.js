export const RETRIEVE_TOOL = 'mcp__datahub-knowledge__retrieve_knowledge';
export const PRESENT_TOOL = 'knowledge_documents_present';
export const RECORD_TYPE = 'plugin:datahub-knowledge-docs/result';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && value.trim().length > 0;
const invalid = () => ({ status: 'invalid', message: '问知结果数据格式不可用' });
const unsupported = () => ({ status: 'unsupported', message: '当前问知接口未提供文档展示数据' });

function errorMessage(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value?.message === 'string' && value.message.trim()) return value.message;
  return '问知检索失败';
}

function expiry(value) {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return NaN;
  const [, year, month, day] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return Date.parse(value);
}

function validate(payload) {
  if (!object(payload)) return invalid();
  if (payload.schemaVersion !== 2) return unsupported();
  if (!['knowledge', 'documents'].includes(payload.purpose) || !identity(payload.retrievalId) ||
    !Array.isArray(payload.documents) || !Array.isArray(payload.evidence)) return invalid();
  const documents = new Map();
  for (const document of payload.documents) {
    if (!object(document) || !['documentRef', 'knowledgeBaseId', 'docId'].every(key => identity(document[key])) ||
      typeof document.documentName !== 'string' || typeof document.knowledgeBaseName !== 'string' ||
      documents.has(document.documentRef)) return invalid();
    documents.set(document.documentRef, document);
  }
  if (payload.purpose === 'documents' && payload.evidence.length) return invalid();
  const evidenceIds = new Set();
  for (const evidence of payload.evidence) {
    if (!object(evidence) || !identity(evidence.evidenceId) || !identity(evidence.documentRef) ||
      typeof evidence.text !== 'string' || !evidence.text.trim() || !documents.has(evidence.documentRef) ||
      evidenceIds.has(evidence.evidenceId) || (evidence.chunkId != null && typeof evidence.chunkId !== 'string')) return invalid();
    evidenceIds.add(evidence.evidenceId);
  }
  return { status: 'success', payload };
}

/** Accepts the business payload, MCP/JSON-RPC envelopes, or persisted DSH message text. */
export function readKnowledgeResult(input) {
  if (typeof input === 'string') {
    try { return readKnowledgeResult(JSON.parse(input)); }
    catch {
      if (/\[\.\.\.\][\s\S]*Full formatted result stored at/.test(input)) {
        return { status: 'truncated', message: '历史检索结果已被截短，请重新检索以展示完整来源' };
      }
      return /^[\s]*[\[{]/.test(input) ? invalid() : unsupported();
    }
  }
  if (!object(input)) return invalid();
  // Errors take precedence over either structured or text content at every envelope layer.
  if (input.error != null && input.error !== false) return { status: 'error', message: errorMessage(input.error) };
  if (input.isError) {
    const text = input.content?.find?.(block => block?.type === 'text' && typeof block.text === 'string')?.text;
    return { status: 'error', message: errorMessage(text ?? input.message) };
  }
  if (Object.hasOwn(input, 'structuredContent')) return validate(input.structuredContent);
  if (Object.hasOwn(input, 'result')) return readKnowledgeResult(input.result);
  if (Object.hasOwn(input, 'message') && object(input.message)) return readKnowledgeResult(input.message);
  if (Object.hasOwn(input, 'schemaVersion')) return validate(input);
  if (Array.isArray(input.content)) {
    const texts = input.content.filter(block => block?.type === 'text' && typeof block.text === 'string');
    // MCP content may contain explanatory blocks; use its single business JSON block.
    const parsed = [];
    for (const block of texts) {
      try { parsed.push(JSON.parse(block.text)); } catch { /* classified below if no business JSON exists */ }
    }
    const candidates = parsed.filter(value => object(value) &&
      (Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'structuredContent') ||
       Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error') || Object.hasOwn(value, 'isError')));
    if (candidates.length === 1) return readKnowledgeResult(candidates[0]);
    if (candidates.length > 1) return invalid();
    if (texts.length === 1) return readKnowledgeResult(texts[0].text);
    return texts.some(block => /^\s*[\[{]/.test(block.text)) ? invalid() : unsupported();
  }
  return unsupported();
}

/** Merge the real candidate set before any final presentation filtering. */
export function collectDocuments(records) {
  const documents = new Map();
  const ordered = records.map((record, index) => ({ record, index })).sort((a, b) =>
    (a.record.callSeq ?? a.index) - (b.record.callSeq ?? b.index));
  for (const { record, index } of ordered) {
    if (record.status !== 'success') continue;
    const payload = record.payload;
    for (const source of payload.documents) {
      let document = documents.get(source.documentRef);
      if (!document) {
        document = { ...source, evidence: [], links: [], sourceCallIds: [] };
        documents.set(source.documentRef, document);
      }
      if (record.callId && !document.sourceCallIds.includes(record.callId)) document.sourceCallIds.push(record.callId);
      document.links.push({ ...source, resultSeq: record.resultSeq ?? index });
      document.links.sort((a, b) => a.resultSeq - b.resultSeq);
    }
    for (const source of payload.evidence) {
      const document = documents.get(source.documentRef);
      const hasChunk = identity(source.chunkId);
      const existing = (hasChunk && document.evidence.find(item => item.chunkId === source.chunkId)) ||
        document.evidence.find(item => item.text === source.text && (!hasChunk || !identity(item.chunkId)));
      const occurrence = { retrievalId: payload.retrievalId, evidenceId: source.evidenceId };
      if (existing) {
        if (hasChunk && !identity(existing.chunkId)) existing.chunkId = source.chunkId;
        if (!existing.occurrences.some(item => item.retrievalId === occurrence.retrievalId && item.evidenceId === occurrence.evidenceId)) {
          existing.occurrences.push(occurrence);
        }
      } else document.evidence.push({ ...source, occurrences: [occurrence] });
    }
  }
  return [...documents.values()];
}

const normalizeName = value => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase();
const extension = /\.(?:md|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|html?)$/iu;
const stripRequest = value => value.replace(/^(?:(?:请|帮我|帮忙|麻烦|问知|找一下|查找|找到|找|查询|搜索|检索|查看|一下|给我|打开|下载|文档|文件|名为|叫做|叫|这个|这份|这篇|的)[：:,，\s]*)+/u, '');

/** Explicit file names are matched as names, never by overlapping topic words. */
function exactFiles(documents, userText) {
  const text = typeof userText === 'string' ? userText.normalize('NFKC') : '';
  const quoted = [...text.matchAll(/["“‘`《]([^"”’`》]+)["”’`》]/gu)].map(match => match[1]);
  const quotedFiles = quoted.filter(value => extension.test(value.trim()));
  const wholeRequest = stripRequest(text.trim()).replace(/[。!！?？]+$/u, '').trim();
  const requested = (quotedFiles.length ? quotedFiles : extension.test(wholeRequest) ? [wholeRequest] :
    [...text.matchAll(/[^\s"'“”‘’`《》<>，。！？；：、,;!?()（）]+\.(?:md|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|html?)(?=$|[\s"'“”‘’`《》<>，。！？；：、,;!?()（）])/giu)].map(match => stripRequest(match[0])))
    .map(value => normalizeName(value.trim()));
  if (requested.length) return { explicit: true, documents: documents.filter(item => requested.includes(normalizeName(item.documentName))) };
  const fragments = [wholeRequest, ...quoted].map(normalizeName);
  const matches = documents.filter(item => {
    const name = normalizeName(item.documentName);
    const stem = name.replace(extension, '');
    return fragments.includes(name) || (stem !== name && fragments.includes(stem));
  });
  return { explicit: matches.length > 0, documents: matches };
}

export function validateSelection(records, args, userText = '') {
  if (!object(args) || !['documents', 'knowledge'].includes(args.purpose) ||
      !Array.isArray(args.documentRefs) || args.documentRefs.some(ref => !identity(ref))) throw new Error('展示选择格式不可用');
  const documents = collectDocuments(records);
  const refs = new Set(documents.map(document => document.documentRef));
  if (args.documentRefs.some(ref => !refs.has(ref))) throw new Error('展示选择包含不存在或已失效的文档');
  let documentRefs = [...new Set(args.documentRefs)];
  if (args.purpose === 'documents') {
    const exact = exactFiles(documents, userText);
    if (exact.explicit && documentRefs.length) {
      if (!exact.documents.length) throw new Error('未找到指定文件');
      documentRefs = exact.documents.map(document => document.documentRef);
    }
  }
  const selected = documents.filter(document => documentRefs.includes(document.documentRef));
  const evidenceIds = new Set(selected.flatMap(document => document.evidence.flatMap(item => item.occurrences.map(occurrence => occurrence.evidenceId))));
  if (args.evidenceIds !== undefined && (!Array.isArray(args.evidenceIds) ||
      args.evidenceIds.some(id => !identity(id) || !evidenceIds.has(id)))) throw new Error('展示选择包含不存在或已失效的证据');
  const sourceCallIds = [...new Set(selected.flatMap(document => document.sourceCallIds))];
  if (args.sourceCallIds !== undefined && (!Array.isArray(args.sourceCallIds) ||
      args.sourceCallIds.some(id => !records.some(record => record.callId === id && record.status === 'success')))) {
    throw new Error('展示选择的来源调用已失效');
  }
  return { kind: 'knowledge-documents-selection', purpose: args.purpose, documentRefs,
    ...(args.evidenceIds !== undefined ? { evidenceIds: [...new Set(args.evidenceIds)] } : {}),
    sourceCallIds: [...new Set([...sourceCallIds, ...(args.sourceCallIds ?? [])])] };
}

/** Final delivery always has one purpose and one panel, including an explicit empty selection. */
export function buildPanels(records, options = {}) {
  const documents = collectDocuments(records);
  const selection = options.selection?.value ?? options.selection;
  const documentMode = options.documentMode || records.some(record => record.purpose === 'documents' || record.payload?.purpose === 'documents');
  let purpose = selection?.purpose ?? (documentMode ? 'documents' : 'knowledge');
  let selected = documents;
  let notice;
  let evidenceIds;
  if (selection) {
    try {
      const value = validateSelection(records, selection, options.userText);
      purpose = value.purpose;
      selected = documents.filter(document => value.documentRefs.includes(document.documentRef));
      evidenceIds = value.evidenceIds;
    } catch {
      selected = [];
      notice = purpose === 'documents' ? '文件候选尚未确认，请重试。' : '来源选择已失效，请重新检索。';
    }
  } else if (documentMode) {
    const exact = exactFiles(documents, options.userText);
    selected = exact.documents;
    if (!selected.length) notice = exact.explicit ? '未找到指定文件。' : '文件候选尚未确认，请重试。';
  } else if (!records.some(record => record.status === 'success')) return [];
  const selectedEvidence = evidenceIds === undefined ? null : new Map(collectDocuments(records.map(record =>
    record.status !== 'success' ? record : { ...record, payload: { ...record.payload,
      evidence: record.payload.evidence.filter(item => evidenceIds.includes(item.evidenceId)) } }))
    .map(document => [document.documentRef, document.evidence]));
  const groups = new Map();
  for (const source of selected) {
    if (!groups.has(source.knowledgeBaseId)) groups.set(source.knowledgeBaseId, {
      knowledgeBaseId: source.knowledgeBaseId, knowledgeBaseName: source.knowledgeBaseName, documents: [],
    });
    const evidence = purpose === 'documents' ? [] : selectedEvidence?.get(source.documentRef) ?? source.evidence;
    groups.get(source.knowledgeBaseId).documents.push({ ...source, evidence });
  }
  return [{ purpose, groups: [...groups.values()], ...(notice ? { notice } : {}) }];
}

export function buildPresentation(records, options = {}) {
  const panels = buildPanels(records, options);
  const selection = options.selection?.value ?? options.selection;
  if (selection) {
    try { validateSelection(records, selection, options.userText); return { panels, notices: [] }; }
    catch { /* Only a valid final selection suppresses intermediate failures. */ }
  }
  if (panels.some(panel => panel.groups.some(group => group.documents.length))) return { panels, notices: [] };
  const notices = records.filter(record => record.status !== 'success').map(record => ({ status: record.status, message: record.message }));
  if (!notices.length) {
    for (const panel of panels) if (panel.notice) notices.push({ status: 'unconfirmed', message: panel.notice });
  }
  return { panels, notices };
}

function openState(document, now) {
  if (document?.openStatus === 'source_unavailable') return { available: false, label: '原文不可用' };
  if (document?.openStatus === 'not_configured') return { available: false, label: '原文链接未配置' };
  if (document?.openStatus !== 'available') return { available: false, label: '原文不可用' };
  const expiresAt = expiry(document.openUrlExpiresAt);
  // This service issues expiring preview tickets; absent/invalid expiry cannot establish availability.
  if (!Number.isFinite(expiresAt)) return { available: false, label: '原文不可用' };
  if (expiresAt <= now) return { available: false, label: '链接已过期，请重新检索', expiresAt };
  try {
    let url;
    if (document.linkProtocol === 'path' || document.openPath != null) {
      let origin;
      try {
        origin = new URL(document.sourceOrigin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('invalid origin');
      } catch { return { available: false, label: '无法确定原文服务地址' }; }
      if (typeof document.openPath !== 'string' || !document.openPath.startsWith('/') ||
          document.openPath.startsWith('//') || /[\\\u0000-\u0020]/u.test(document.openPath)) throw new Error('invalid path');
      url = new URL(document.openPath, origin.origin);
      if (url.origin !== origin.origin) throw new Error('cross-origin path');
    } else {
      if (typeof document.openUrl !== 'string') throw new Error('missing URL');
      url = new URL(document.openUrl);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported URL');
    return { available: true, label: '查看原文', url: url.href, expiresAt };
  } catch { return { available: false, label: '原文不可用' }; }
}

export function getDocumentOpenState(document, now = Date.now()) {
  const links = Array.isArray(document?.links) && document.links.length ? document.links : [document];
  let latest;
  for (let index = links.length - 1; index >= 0; index--) {
    const state = openState(links[index], now);
    if (!latest) latest = state;
    if (state.available) return state;
  }
  return latest;
}
