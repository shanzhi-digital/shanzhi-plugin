export const KEY = 'datahub-query-enhance';
export const SQL_TOOL = 'mcp__datahub-ask-data__execute_semantic_sql';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const failed = value => record(value) && (Boolean(value.isError) ||
  (value.error != null && value.error !== false) || value.success === false);
const measureFields = ['datasourceId', 'model', 'member', 'queryMember', 'title', 'trustHash', 'source', 'semanticCommit'];

function compactMeasure(value) {
  const measure = {};
  for (const key of measureFields) {
    if (key === 'datasourceId' ? identifier(value[key]) : typeof value[key] === 'string') measure[key] = value[key];
  }
  measure.trusted = value.trusted === true;
  return measure;
}

function sqlPayload(value) {
  if (!record(value) || failed(value)) return null;
  if (value.queryKind === 'SEMANTIC_SQL') return value;
  if (record(value.structuredContent)) return value.structuredContent;
  for (const block of Array.isArray(value.content) ? value.content : []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    try {
      const parsed = JSON.parse(block.text);
      if (record(parsed) && parsed.queryKind === 'SEMANTIC_SQL') return parsed;
    } catch { /* Non-JSON MCP text does not carry SQL metadata. */ }
  }
  return null;
}

/** Extract metadata from the lossless MCP value, never from projected tool content. */
export function readSqlTrust(value, callId) {
  if (typeof callId !== 'string' || callId.length === 0) return null;
  const payload = sqlPayload(value);
  if (!payload || failed(payload) || payload.queryKind !== 'SEMANTIC_SQL' ||
    !Array.isArray(payload.columns) || !Array.isArray(payload.data)) return null;
  const measures = Array.isArray(payload.usedMeasures) ? payload.usedMeasures : [];
  return {
    version: 1,
    kind: 'datahub-query-trust',
    callId,
    datasourceId: identifier(payload.datasourceId) ? payload.datasourceId : null,
    semanticCommit: typeof payload.semanticCommit === 'string' ? payload.semanticCommit : null,
    usedMeasures: measures.filter(record).map(compactMeasure),
    unstructuredData: measures.length === 0 || measures.some(measure => !record(measure)),
  };
}

function validSummary(value) {
  return record(value) && value.version === 1 && value.kind === 'datahub-query-trust' &&
    typeof value.callId === 'string' && value.callId.length > 0 &&
    (value.datasourceId === null || identifier(value.datasourceId)) &&
    (value.semanticCommit === null || typeof value.semanticCommit === 'string') &&
    typeof value.unstructuredData === 'boolean' && Array.isArray(value.usedMeasures) &&
    value.usedMeasures.every(measure => record(measure) && typeof measure.trusted === 'boolean' &&
      measureFields.every(key => measure[key] === undefined ||
        (key === 'datasourceId' ? identifier(measure[key]) : typeof measure[key] === 'string')));
}

/** Read only the plugin's own structured notice; ordinary user/tool text is not evidence. */
export function readTrustContext(message) {
  if (message?.role !== 'user' || message.source?.kind !== KEY || message.source.form !== 'notice' ||
    !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text') return null;
  try {
    const summary = JSON.parse(message.content[0].text);
    if (!validSummary(summary)) return null;
    return {
      version: 1, kind: summary.kind, callId: summary.callId,
      datasourceId: summary.datasourceId, semanticCommit: summary.semanticCommit,
      usedMeasures: summary.usedMeasures.map(compactMeasure),
      unstructuredData: summary.unstructuredData || summary.usedMeasures.length === 0,
    };
  } catch { return null; }
}

/** Distinct trust hashes represent distinct definitions; conflicts are always untrusted. */
export function aggregateTrust(summaries) {
  const valid = summaries.filter(validSummary);
  if (valid.length === 0) return null;
  const measures = new Map();
  let unstructuredData = false;
  for (const summary of valid) {
    unstructuredData ||= summary.unstructuredData || summary.usedMeasures.length === 0;
    for (const measure of summary.usedMeasures) {
      const key = JSON.stringify([measure.datasourceId, measure.model, measure.member, measure.trustHash]);
      const previous = measures.get(key);
      if (previous) previous.trusted &&= measure.trusted;
      else measures.set(key, compactMeasure(measure));
    }
  }
  const usedMeasures = [...measures.values()];
  const trustedCount = usedMeasures.filter(measure => measure.trusted).length;
  const untrustedCount = usedMeasures.length - trustedCount;
  return {
    level: trustedCount === 0 ? 'NOT_TRUSTED' : untrustedCount > 0 || unstructuredData ? 'PARTIAL' : 'TRUSTED',
    usedMeasures, trustedCount, untrustedCount, unstructuredData,
  };
}
