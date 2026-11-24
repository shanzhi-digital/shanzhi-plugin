import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { syncAnnotations, invalidateResults } from './annotation-store.js';

const sourceFields = ['id', 'name', 'description', 'engine', 'host', 'port', 'user', 'database', 'file', 'credentialRef'];
const sourceColumns = 'metadata, connection_version, revision, enabled, created_at, updated_at';
const tableColumns = ['table_id', 'position', 'schema_name', 'table_name', 'table_kind', 'source_comment', 'fields', 'enabled', 'domain_name', 'category', 'reason', 'structure_hash', 'freshness'];
const linkColumns = ['question_id', 'source_id', 'table_id', 'fields', 'reason', 'question_version', 'structure_hash', 'analyzed_at'];
const fieldKeys = ['name', 'type', 'primaryKey', 'notNull', 'sourceComment'];
const freshnessKeys = ['status', 'empty', 'timeColumn', 'lastDataAt', 'temporalKind', 'dateOnly', 'hasTimezone', 'scannedAt', 'error'];
const project = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const iso = value => new Date(Number(value)).toISOString();
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const normalizedQuestion = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const canonicalHost = host => {
  const value = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(value) ? 'loopback' : value;
};
function targetFile({ engine, file }) {
  if (process.platform !== 'win32' || engine !== 'sqlite' || typeof file !== 'string' || !file) return file;
  try { return realpathSync.native(file); }
  catch { return file; }
}
export const sourceTarget = source => [source.engine, canonicalHost(source.host), source.port, source.database, targetFile(source)];

export function conflict(message, status = 409) {
  throw Object.assign(new Error(message), { status, publicMessage: message });
}

function validateId(id, label) {
  if (typeof id !== 'string' || !id || id.length > 128) conflict(`${label}无效。`, 400);
}

export function assertSourceRevision(source, revision) {
  if (source?.revision !== revision) conflict('数据源已更新，请刷新后重试。');
}

export function nextSource(record, current, now, credentialChanged) {
  validateId(record?.id, '数据源 ID');
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 128) conflict('数据源名称无效。', 400);
  const metadata = project(record, sourceFields);
  const targetChanged = !!current && !isDeepStrictEqual(sourceTarget(current), sourceTarget(metadata));
  const connectionChanged = !!current && (targetChanged || credentialChanged || ['host', 'user', 'file', 'credentialRef'].some(key => current[key] !== metadata[key]));
  return {
    source: {
      ...metadata, enabled: current?.enabled ?? true, revision: (current?.revision ?? 0) + 1,
      connectionVersion: (current?.connectionVersion ?? 1) + Number(connectionChanged),
      createdAt: current?.createdAt ?? iso(now), updatedAt: iso(now),
    },
    targetChanged, connectionChanged,
  };
}

export function assertUniqueName(sources, source) {
  if (sources.some(item => item.id !== source.id && item.name.toLowerCase() === source.name.toLowerCase())) {
    conflict('数据源名称已存在，请使用其他名称。');
  }
}

export function nextSourceEnabled(current, enabled, revision, now) {
  if (!current) conflict('未找到该数据源。', 404);
  assertSourceRevision(current, revision);
  if (typeof enabled !== 'boolean') conflict('启停状态无效。', 400);
  return current.enabled === enabled ? current : { ...current, enabled, revision: current.revision + 1, updatedAt: iso(now) };
}

export function readAnalysisContext(value) {
  let context;
  try { context = typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) : value; }
  catch { context = null; }
  if (context?.version === 1 && typeof context === 'object') {
    return { version: 1, domainCatalogId: typeof context.domainCatalogId === 'string' ? context.domainCatalogId : '',
      emptyQuestionAnalyses: context.emptyQuestionAnalyses && typeof context.emptyQuestionAnalyses === 'object' && !Array.isArray(context.emptyQuestionAnalyses)
        ? { ...context.emptyQuestionAnalyses } : {} };
  }
  return { version: 1, domainCatalogId: typeof value === 'string' ? value : '', emptyQuestionAnalyses: {} };
}

export function writeAnalysisContext(context) {
  return JSON.stringify(readAnalysisContext(context));
}

export function questionAnalysisStatus(question, state) {
  const links = (question.links ?? []).filter(link => !state || link.sourceId === state.id);
  if (links.length) {
    const tables = new Map((state?.catalog?.tables ?? []).map(table => [table.id, table]));
    return links.every(link => link.questionVersion === question.version && tables.has(link.tableId) && tables.get(link.tableId).structureHash === link.structureHash) ? 'linked' : 'stale';
  }
  const empty = readAnalysisContext(state?.domainContext).emptyQuestionAnalyses[question.id];
  if (!empty) return 'missing';
  return state?.catalog && empty.questionVersion === question.version && empty.connectionVersion === state.connectionVersion
    && empty.catalogId === state.catalog.id ? 'empty' : 'stale';
}

export function projectQuestionAnalysis(question, state) {
  return { ...question, analysisStatus: questionAnalysisStatus(question, state) };
}

export function pruneQuestionAnalyses(state, questions) {
  const context = readAnalysisContext(state.domainContext), existing = new Set(questions.map(question => question.id));
  let changed = false;
  for (const id of Object.keys(context.emptyQuestionAnalyses)) {
    if (!existing.has(id)) {
      delete context.emptyQuestionAnalyses[id];
      changed = true;
    }
  }
  if (changed) {
    state.domainContext = writeAnalysisContext(context);
    if (state.catalog) state.catalog.domainContext = state.domainContext;
  }
  return state;
}

export function updateQuestionAnalysisContext(state, versions, links, context) {
  const analysis = readAnalysisContext(state.domainContext), linked = new Set(links.map(link => link.questionId));
  const stale = new Set(context.staleQuestionIds ?? []);
  for (const [id, version] of versions) {
    delete analysis.emptyQuestionAnalyses[id];
    if (context.analysisComplete === true && !linked.has(id) && !stale.has(id)
      && state.connectionVersion === context.connectionVersion && state.catalog?.id === context.catalogId) {
      analysis.emptyQuestionAnalyses[id] = { questionVersion: version, connectionVersion: context.connectionVersion, catalogId: context.catalogId };
    }
  }
  if (!isDeepStrictEqual(analysis, readAnalysisContext(state.domainContext))) {
    state.domainContext = writeAnalysisContext(analysis);
    if (state.catalog) state.catalog.domainContext = state.domainContext;
  }
}

export function emptyState({ id, connectionVersion }) {
  return { id, connectionVersion, revision: 0, catalog: null, domains: [], domainContext: '' };
}

export function projectState(state, source) {
  if (state.id !== source.id || state.connectionVersion !== source.connectionVersion || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    conflict('目录状态版本无效。', 400);
  }
  if (!state.catalog) return emptyState(source);
  const { id, scannedAt, tables } = state.catalog;
  const { domains, domainContext } = state;
  const seen = new Set();
  const catalog = { id, scannedAt, domains, domainContext, tables: tables.map(table => {
    if (seen.has(table.id)) conflict('目录包含重复表。', 400);
    seen.add(table.id);
    return {
      id: table.id, schema: table.schema, name: table.name, tableKind: table.tableKind ?? 'table',
      sourceComment: table.sourceComment ?? '', fields: table.fields.map(field => project(field, fieldKeys)),
      enabled: table.enabled === true, domain: table.domain ?? '', category: table.category ?? '', reason: table.reason ?? '',
      structureHash: table.structureHash, freshness: table.freshness ? project(table.freshness, freshnessKeys) : null,
    };
  }) };
  return { ...emptyState(source), revision: state.revision, catalog, domains, domainContext };
}

export function nextQuestion(input, current, now) {
  const { id, version } = input;
  if (id !== undefined) {
    validateId(id, '问题 ID');
    if (!current) conflict('该问题已删除，请刷新后重试。', 404);
    if (version !== current.version) conflict('问题已更新，请刷新后重试。');
  }
  const { text, answer = '' } = input;
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) conflict('问题不能为空或超出长度限制。', 400);
  if (typeof answer !== 'string' || answer.length > 10000) conflict('答案格式无效或超出长度限制。', 400);
  const body = text.trim(), response = answer.trim();
  const provenance = { origin: current ? (current.origin ?? 'unknown') : 'original', sourceQuestionId: current?.sourceQuestionId ?? null };
  if (current?.text === body && current.answer === response) {
    return current.origin === provenance.origin && current.sourceQuestionId === provenance.sourceQuestionId ? current : { ...current, ...provenance };
  }
  return { id: current?.id ?? randomUUID(), text: body, answer: response, ...provenance, version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? iso(now), updatedAt: iso(now) };
}

export function assertUniqueQuestion(questions, question) {
  const name = normalizedQuestion(question.text);
  if (questions.some(item => item.id !== question.id && normalizedQuestion(item.text) === name)) conflict('该问题已存在。');
}

export function newQuestions(input, questions, now) {
  if (!Array.isArray(input?.questions) || input.questions.length === 0) conflict('请选择参考问题。', 400);
  const seen = new Set();
  for (const reference of input.questions) {
    validateId(reference?.id, '参考问题 ID');
    if (seen.has(reference.id)) conflict('所选问题重复。', 400);
    seen.add(reference.id);
    const original = questions.find(question => question.id === reference.id);
    if (!original) conflict('该问题已删除，请刷新后重试。', 404);
    if (original.version !== reference.version) conflict('问题已更新，请刷新后重试。');
    if (original.origin !== 'original') conflict('仅原问题可以泛化，请选择原问题。', 400);
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) conflict('请选择 1 至 20 个候选问题。', 400);
  const sourceQuestionId = input.questions.length === 1 ? input.questions[0].id : null;
  const known = [...questions], created = [];
  for (const item of input.items) {
    const question = { ...nextQuestion({ text: item?.text, answer: '' }, undefined, now), origin: 'generated', sourceQuestionId };
    assertUniqueQuestion(known, question);
    known.push(question);
    created.push(question);
  }
  return created;
}

export function snapshotVersions(snapshots) {
  const versions = new Map(snapshots.map(({ id, version }) => [id, version]));
  if (versions.size !== snapshots.length) conflict('所选问题重复。', 400);
  return versions;
}

export function assertVersions(questions, versions) {
  if (questions.length !== versions.size || questions.some(item => versions.get(item.id) !== item.version)) {
    conflict('所选问题已更新，请重新选择。');
  }
}

export function buildLinks(state, source, versions, links, context, now) {
  if (!source.enabled) conflict('数据源已停用，请先启用。');
  if (!state.catalog || state.catalog.id !== context?.catalogId || state.connectionVersion !== context.connectionVersion) {
    conflict('数据源或目录已变化，请重新执行。');
  }
  const staleQuestionIds = context.staleQuestionIds === undefined ? [] : context.staleQuestionIds;
  if (!Array.isArray(staleQuestionIds) || staleQuestionIds.some(id => !versions.has(id))) conflict('问题关联无效。', 400);
  const staleQuestions = new Set(staleQuestionIds);
  const tables = new Map(state.catalog.tables.map(table => [table.id, { table, names: new Set(table.fields.map(field => field.name)) }]));
  const seen = new Set();
  return links.map(({ questionId, tableId, fields, reason }) => {
    const pair = JSON.stringify([questionId, tableId]);
    const record = tables.get(tableId);
    if (!versions.has(questionId) || !record || seen.has(pair) || !Array.isArray(fields) || new Set(fields).size !== fields.length
      || fields.some(field => !record.names.has(field)) || typeof reason !== 'string') conflict('问题关联无效。', 400);
    seen.add(pair);
    return { questionId, sourceId: state.id, tableId, fields, reason, questionVersion: staleQuestions.has(questionId) ? 0 : versions.get(questionId),
      structureHash: record.table.structureHash, analyzedAt: iso(now) };
  });
}

export function assertActiveBinding(binding, sourceId) {
  if (!binding || binding.sourceId !== sourceId || binding.retired) conflict('会话已失效，请重新执行。');
}

export function nextBinding(sessionId, binding, previous, source) {
  validateId(sessionId, '会话 ID');
  validateId(binding?.sourceId, '绑定数据源 ID');
  if (typeof binding.retired !== 'boolean') conflict('会话访问范围无效。', 400);
  const retired = binding.retired || !source?.enabled
    || (binding.connectionVersion !== undefined && binding.connectionVersion !== source.connectionVersion);
  if (previous && (previous.sourceId !== binding.sourceId || (previous.retired && !retired))) conflict('会话已绑定其他范围或已退役，拒绝覆盖。');
  return { sourceId: binding.sourceId, retired };
}

function readSource(row) {
  return { ...json(row.metadata), enabled: Boolean(row.enabled), connectionVersion: Number(row.connection_version),
    revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function readQuestion(row) {
  return { id: row.question_id, text: row.question_text, answer: row.answer, version: Number(row.version),
    origin: row.origin ?? 'unknown', sourceQuestionId: row.source_question_id ?? null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function readLink(row) {
  return { sourceId: row.source_id, tableId: row.table_id, fields: json(row.fields), reason: row.reason,
    questionVersion: Number(row.question_version), structureHash: row.structure_hash, analyzedAt: iso(row.analyzed_at) };
}

function readTable(row) {
  return { id: row.table_id, schema: row.schema_name, name: row.table_name, tableKind: row.table_kind,
    sourceComment: row.source_comment, fields: json(row.fields), enabled: Boolean(row.enabled),
    domain: row.domain_name, category: row.category, reason: row.reason, structureHash: row.structure_hash, freshness: json(row.freshness) };
}

const placeholders = count => Array(count).fill('?').join(', ');
const valueRows = (columnCount, rowCount) => Array(rowCount).fill(`(${placeholders(columnCount)})`).join(', ');
const upsert = (table, columns, changed, rowCount = 1) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${valueRows(columns.length, rowCount)} ON DUPLICATE KEY UPDATE ${changed.map(column => `${column} = VALUES(${column})`).join(', ')}`;
const sourceUpsert = upsert('dsh_sources', ['profile_id', 'source_id', ...sourceColumns.split(', ')], sourceColumns.split(', '));
const catalogColumns = ['catalog_id', 'scanned_at', 'revision', 'domains', 'domain_context'];
const catalogUpsert = upsert('dsh_source_catalogs', ['profile_id', 'source_id', ...catalogColumns], catalogColumns);
const tableUpsert = rowCount => upsert('dsh_source_tables', ['profile_id', 'source_id', ...tableColumns], tableColumns.slice(1), rowCount);
const questionColumns = ['question_text', 'answer', 'version', 'created_at', 'updated_at', 'origin', 'source_question_id'];
const questionUpsert = upsert('dsh_questions', ['profile_id', 'question_id', ...questionColumns], questionColumns);

async function databaseTime(connection) {
  const [[clock]] = await connection.query('SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS now_ms');
  return Number(clock.now_ms);
}

/** Source rows serialize catalog changes. Question rows also lock analysis against edits. */
export class MysqlFlowStore {
  constructor(db) { this.db = db; this.profileId = db.profileId; }
  async initialize() { }

  async #lockProfile(connection) {
    await connection.execute('INSERT INTO dsh_management_profiles (profile_id) VALUES (?) ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id)', [this.profileId]);
  }

  async #source(connection, id, lock = '') {
    const [[row]] = await connection.execute(`SELECT ${sourceColumns} FROM dsh_sources WHERE profile_id = ? AND source_id = ? ${lock}`.trim(), [this.profileId, id ?? null]);
    return row && readSource(row);
  }

  async listSources() {
    const [rows] = await this.db.pool.execute(`SELECT s.*, IF(c.catalog_id IS NULL, NULL, COALESCE(t.table_count, 0)) AS table_count
      FROM dsh_sources s LEFT JOIN dsh_source_catalogs c USING (profile_id, source_id)
      LEFT JOIN (SELECT source_id, COUNT(*) AS table_count FROM dsh_source_tables WHERE profile_id = ? GROUP BY source_id) t
        ON t.source_id = s.source_id
      WHERE s.profile_id = ? ORDER BY s.created_at, s.source_id`, [this.profileId, this.profileId]);
    return rows.map(row => ({ ...readSource(row), tableCount: row.table_count === null ? null : Number(row.table_count) }));
  }

  getSource(id) { return this.#source(this.db.pool, id); }

  async #writeSource(connection, source) {
    const row = [this.profileId, source.id, JSON.stringify(project(source, sourceFields)), source.connectionVersion,
      source.revision, source.enabled, Date.parse(source.createdAt), Date.parse(source.updatedAt)];
    await connection.execute(sourceUpsert, row);
  }

  async #retireSourceBindings(connection, id) {
    await connection.execute('UPDATE dsh_flow_bindings SET retired = TRUE WHERE profile_id = ? AND source_id = ? AND retired = FALSE', [this.profileId, id]);
  }

  async saveSource(record, expectedRevision, { credentialChanged = false } = {}) {
    return this.db.transaction(async connection => {
      await this.#lockProfile(connection);
      const current = await this.#source(connection, record.id, 'FOR UPDATE');
      assertSourceRevision(current, expectedRevision);
      const { source, targetChanged, connectionChanged } = nextSource(record, current, await databaseTime(connection), credentialChanged);
      const [rows] = await connection.execute('SELECT metadata FROM dsh_sources WHERE profile_id = ?', [this.profileId]);
      assertUniqueName(rows.map(row => json(row.metadata)), source);
      await this.#writeSource(connection, source);
      if (targetChanged) await connection.execute('DELETE FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?', [this.profileId, source.id]);
      if (current && (connectionChanged || current.name !== source.name)) await invalidateResults(connection, this.profileId, source.id);
      if (connectionChanged) await this.#retireSourceBindings(connection, source.id);
      return source;
    });
  }

  async setSourceEnabled(id, enabled, revision) {
    return this.db.transaction(async connection => {
      const current = await this.#source(connection, id, 'FOR UPDATE');
      const source = nextSourceEnabled(current, enabled, revision, await databaseTime(connection));
      if (source !== current) {
        await this.#writeSource(connection, source);
        await invalidateResults(connection, this.profileId, id);
        if (!enabled) await this.#retireSourceBindings(connection, id);
      }
      return source;
    });
  }

  async removeSource(id, expectedRevision) {
    return this.db.transaction(async connection => {
      const source = await this.#source(connection, id, 'FOR UPDATE');
      if (!source) conflict('未找到该数据源。', 404);
      assertSourceRevision(source, expectedRevision);
      await this.#retireSourceBindings(connection, id);
      await connection.execute('DELETE FROM dsh_sources WHERE profile_id = ? AND source_id = ?', [this.profileId, id]);
      return source;
    });
  }

  async #loadState(connection, source, prune = true) {
    const state = emptyState(source), params = [this.profileId, state.id];
    const [[catalog]] = await connection.execute('SELECT catalog_id, scanned_at, revision, domains, domain_context FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?', params);
    if (!catalog) return state;
    const [rows] = await connection.execute(`SELECT ${tableColumns.join(', ')} FROM dsh_source_tables WHERE profile_id = ? AND source_id = ? ORDER BY position`, params);
    const domains = json(catalog.domains), domainContext = catalog.domain_context;
    const loaded = { ...state, revision: Number(catalog.revision), domains, domainContext,
      catalog: { id: catalog.catalog_id, scannedAt: catalog.scanned_at, domains, domainContext, tables: rows.map(readTable) } };
    return prune ? this.#pruneState(connection, loaded) : loaded;
  }

  async #pruneState(connection, state) {
    if (!Object.keys(readAnalysisContext(state.domainContext).emptyQuestionAnalyses).length) return state;
    const [questions] = await connection.execute('SELECT question_id, version FROM dsh_questions WHERE profile_id = ?', [this.profileId]);
    return pruneQuestionAnalyses(state, questions.map(row => ({ id: row.question_id, version: Number(row.version) })));
  }

  async get(id) {
    return this.db.transaction(async connection => {
      const source = await this.#source(connection, id);
      return source && this.#loadState(connection, source);
    }, { readOnly: true });
  }

  async #saveState(connection, before, after) {
    if (isDeepStrictEqual(before, after)) return;
    await syncAnnotations(connection, this.profileId, before, after);
    const scope = [this.profileId, after.id];
    if (!after.catalog) {
      await connection.execute('DELETE FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?', scope);
      return;
    }
    const { catalog, revision, domains, domainContext } = after;
    const catalogRow = [...scope, catalog.id, catalog.scannedAt, revision, JSON.stringify(domains), domainContext];
    await connection.execute(catalogUpsert, catalogRow);
    const previous = new Map((before.catalog?.tables ?? []).map((table, index) => [table.id, { table, index }]));
    const current = new Map(catalog.tables.map(table => [table.id, table.structureHash]));
    const removed = [], invalidated = [];
    for (const [id, { table }] of previous) {
      if (!current.has(id)) removed.push(id);
      else if (current.get(id) !== table.structureHash) invalidated.push(id);
    }
    const affectedTables = [...removed, ...invalidated];
    if (affectedTables.length) {
      const [affectedQuestions] = await connection.execute(`SELECT DISTINCT question_id FROM dsh_question_links WHERE profile_id = ? AND source_id = ? AND table_id IN (${placeholders(affectedTables.length)})`, [...scope, ...affectedTables]);
      if (affectedQuestions.length) await connection.execute(`UPDATE dsh_question_links SET question_version = 0 WHERE profile_id = ? AND source_id = ? AND question_id IN (${placeholders(affectedQuestions.length)})`, [...scope, ...affectedQuestions.map(row => row.question_id)]);
    }
    if (removed.length) await connection.execute(`DELETE FROM dsh_source_tables WHERE profile_id = ? AND source_id = ? AND table_id IN (${placeholders(removed.length)})`, [...scope, ...removed]);
    if (invalidated.length) await connection.execute(`DELETE FROM dsh_question_links WHERE profile_id = ? AND source_id = ? AND table_id IN (${placeholders(invalidated.length)})`, [...scope, ...invalidated]);
    const changed = [];
    for (const [index, table] of catalog.tables.entries()) {
      const old = previous.get(table.id);
      if (old?.index === index && isDeepStrictEqual(table, old.table)) continue;
      changed.push([...scope, table.id, index, table.schema, table.name, table.tableKind, table.sourceComment, JSON.stringify(table.fields),
        table.enabled, table.domain, table.category, table.reason, table.structureHash, table.freshness && JSON.stringify(table.freshness)]);
    }
    for (let i = 0; i < changed.length; i += 100) {
      const rows = changed.slice(i, i + 100);
      await connection.execute(tableUpsert(rows.length), rows.flat());
    }
  }

  async #assertQuestionVersions(connection, snapshots) {
    const versions = snapshotVersions(snapshots);
    if (versions.size) {
      const ids = Array.from(versions.keys(), id => id ?? null);
      const [rows] = await connection.execute(`SELECT question_id, version FROM dsh_questions WHERE profile_id = ? AND question_id IN (${placeholders(ids.length)}) LOCK IN SHARE MODE`, [this.profileId, ...ids]);
      assertVersions(rows.map(row => ({ id: row.question_id, version: Number(row.version) })), versions);
    }
    return versions;
  }

  async change(id, callback) {
    return this.db.transaction(async connection => {
      const source = await this.#source(connection, id, 'FOR UPDATE');
      if (!source) conflict('未找到该数据源。', 404);
      const before = await this.#loadState(connection, source, false);
      const now = await databaseTime(connection);
      const analysisUpdates = [];
      const assertQuestionVersions = snapshots => this.#assertQuestionVersions(connection, snapshots);
      const assertSessionBinding = async sessionId => {
        assertActiveBinding(await this.#binding(connection, sessionId, 'LOCK IN SHARE MODE'), id);
      };
      const replaceQuestionLinks = async (snapshots, links, context) => {
        const versions = await assertQuestionVersions(snapshots);
        const replacements = buildLinks(before, source, versions, links, context, now);
        analysisUpdates.push({ versions, links: replacements, context });
        if (versions.size) await connection.execute(`DELETE FROM dsh_question_links WHERE profile_id = ? AND source_id = ? AND question_id IN (${placeholders(versions.size)})`, [this.profileId, id, ...versions.keys()]);
        for (let i = 0; i < replacements.length; i += 100) {
          const rows = replacements.slice(i, i + 100).map(link => [this.profileId, link.questionId, link.sourceId, link.tableId,
            JSON.stringify(link.fields), link.reason, link.questionVersion, link.structureHash, now]);
          await connection.execute(`INSERT INTO dsh_question_links (profile_id, ${linkColumns.join(', ')}) VALUES ${valueRows(linkColumns.length + 1, rows.length)}`, rows.flat());
        }
      };
      const saveQuestions = input => this.#saveQuestions(connection, input, now);
      const callbackState = await this.#pruneState(connection, structuredClone(before));
      const { state, result } = await callback(callbackState, { ...source }, now, { assertQuestionVersions, replaceQuestionLinks, assertSessionBinding, saveQuestions });
      if (state !== undefined || analysisUpdates.length) {
        const persisted = projectState(state ?? structuredClone(before), source);
        for (const update of analysisUpdates) updateQuestionAnalysisContext(persisted, update.versions, update.links, update.context);
        await this.#pruneState(connection, persisted);
        if (persisted.domainContext !== before.domainContext) persisted.revision = Math.max(persisted.revision, before.revision + 1);
        await this.#saveState(connection, before, persisted);
        Object.assign(callbackState, persisted);
        if (state !== undefined && state !== callbackState) Object.assign(state, persisted);
      }
      return result;
    });
  }

  replaceQuestionLinks(id, snapshots, links, context) {
    return this.change(id, async (_state, _source, _now, work) => {
      await work.replaceQuestionLinks(snapshots, links, context);
      return {};
    });
  }

  async listQuestions(sourceId) {
    const scope = sourceId === undefined ? [] : [sourceId];
    const [rows] = await this.db.pool.execute(`SELECT q.*, l.source_id, l.table_id, l.fields, l.reason, l.question_version, l.structure_hash, l.analyzed_at
      FROM dsh_questions q LEFT JOIN dsh_question_links l ON l.profile_id = q.profile_id AND l.question_id = q.question_id${scope.length ? ' AND l.source_id = ?' : ''}
      WHERE q.profile_id = ? ORDER BY q.created_at, q.question_id, l.source_id, l.table_id`, [...scope, this.profileId]);
    const questions = new Map();
    for (const row of rows) {
      if (!questions.has(row.question_id)) questions.set(row.question_id, { ...readQuestion(row), links: [] });
      if (row.table_id !== null) questions.get(row.question_id).links.push(readLink(row));
    }
    const items = [...questions.values()];
    if (sourceId === undefined) return items;
    const state = await this.get(sourceId);
    return items.map(question => projectQuestionAnalysis(question, state));
  }

  async saveQuestion(input) {
    return this.db.transaction(async connection => {
      await this.#lockProfile(connection);
      const [rows] = await connection.execute('SELECT * FROM dsh_questions WHERE profile_id = ?', [this.profileId]);
      const questions = rows.map(readQuestion);
      const current = questions.find(question => question.id === input.id);
      const question = nextQuestion(input, current, await databaseTime(connection));
      assertUniqueQuestion(questions, question);
      if (question !== current) {
        const row = [this.profileId, question.id, question.text, question.answer, question.version,
          Date.parse(question.createdAt), Date.parse(question.updatedAt), question.origin, question.sourceQuestionId];
        await connection.execute(questionUpsert, row);
      }
      const [links] = await connection.execute(`SELECT ${linkColumns.join(', ')} FROM dsh_question_links WHERE profile_id = ? AND question_id = ? ORDER BY source_id, table_id`, [this.profileId, question.id]);
      return { ...question, links: links.map(readLink) };
    });
  }

  async #saveQuestions(connection, input, now) {
    await this.#lockProfile(connection);
    const [rows] = await connection.execute('SELECT * FROM dsh_questions WHERE profile_id = ? FOR UPDATE', [this.profileId]);
    const created = newQuestions(input, rows.map(readQuestion), now);
    for (const question of created) {
      await connection.execute(questionUpsert, [this.profileId, question.id, question.text, question.answer, question.version,
        Date.parse(question.createdAt), Date.parse(question.updatedAt), question.origin, question.sourceQuestionId]);
    }
    return created.map(question => ({ ...question, links: [] }));
  }

  async saveQuestions(input) {
    return this.db.transaction(async connection => this.#saveQuestions(connection, input, await databaseTime(connection)));
  }

  async removeQuestion(id, version) {
    return this.db.transaction(async connection => {
      await this.#lockProfile(connection);
      const [[row]] = await connection.execute('SELECT version FROM dsh_questions WHERE profile_id = ? AND question_id = ? FOR UPDATE', [this.profileId, id ?? null]);
      if (!row) conflict('该问题已删除，请刷新后重试。', 404);
      if (version !== Number(row.version)) conflict('问题已更新，请刷新后重试。');
      await connection.execute('DELETE FROM dsh_questions WHERE profile_id = ? AND question_id = ?', [this.profileId, id]);
    });
  }

  async #binding(connection, sessionId, lock = '') {
    const [[row]] = await connection.execute(`SELECT source_id, retired FROM dsh_flow_bindings WHERE profile_id = ? AND session_id = ? ${lock}`.trim(), [this.profileId, sessionId ?? null]);
    return row && { sourceId: row.source_id, retired: Boolean(row.retired) };
  }

  async findBinding(sessionId) {
    if (typeof sessionId === 'string' && sessionId) return this.#binding(this.db.pool, sessionId);
  }

  async bindSession(sessionId, binding) {
    return this.db.transaction(async connection => {
      await this.#lockProfile(connection);
      const source = binding?.retired === false && typeof binding.sourceId === 'string'
        ? await this.#source(connection, binding.sourceId, 'FOR UPDATE') : undefined;
      const previous = await this.#binding(connection, sessionId, 'FOR UPDATE');
      const next = nextBinding(sessionId, binding, previous, source);
      if (!previous) await connection.execute('INSERT INTO dsh_flow_bindings (profile_id, session_id, source_id, retired) VALUES (?, ?, ?, ?)', [this.profileId, sessionId, next.sourceId, next.retired]);
      else if (next.retired && !previous.retired) await connection.execute('UPDATE dsh_flow_bindings SET retired = TRUE WHERE profile_id = ? AND session_id = ?', [this.profileId, sessionId]);
      return !next.retired;
    });
  }

  async retireSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    await this.db.transaction(connection => connection.execute('UPDATE dsh_flow_bindings SET retired = TRUE WHERE profile_id = ? AND session_id = ?', [this.profileId, sessionId]));
  }
}
