import { randomUUID } from 'node:crypto';
import { digest, normalizeCanvas, normalizeEdge, relationKey, canvasSemantics, inspectCanvas, tableCompletion, relationCompletion, resultsFingerprint } from './relation-model.js';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = value => value == null ? null : new Date(Number(value)).toISOString();
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; error.statusCode = status; error.publicMessage = message; throw error; };
const tableSignature = table => digest([table.schema_name, table.table_name, table.table_kind, table.source_comment]);
const fieldSignature = field => digest(Object.keys(field).sort().map(key => [key, field[key]]));
const annotation = (row, signature) => ({ text: row?.text ?? '', status: !row?.text?.trim() ? 'missing' : row.confirmed && row.signature === signature ? 'confirmed' : 'pending', updatedAt: iso(row?.updated_at) });

async function load(connection, profileId, sourceId) {
  if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 128) fail('数据源 ID 无效。');
  const scope = [profileId, sourceId];
  const [[source]] = await connection.execute('SELECT * FROM dsh_sources WHERE profile_id = ? AND source_id = ? FOR UPDATE', scope);
  if (!source || !source.enabled) fail('未找到启用的数据源。', 404);
  const [[catalog]] = await connection.execute('SELECT * FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?', scope);
  const [tables] = await connection.execute('SELECT * FROM dsh_source_tables WHERE profile_id = ? AND source_id = ? ORDER BY position', scope);
  const [tableRows] = await connection.execute('SELECT * FROM dsh_table_annotations WHERE profile_id = ? AND source_id = ? ORDER BY table_id', scope);
  const [fieldRows] = await connection.execute('SELECT * FROM dsh_field_annotations WHERE profile_id = ? AND source_id = ? ORDER BY table_id, field_name', scope);
  const [canvasRows] = await connection.execute('SELECT * FROM dsh_relation_canvases WHERE profile_id = ? AND source_id = ? ORDER BY canvas_id', scope);
  const [[saved]] = await connection.execute('SELECT * FROM dsh_annotation_results WHERE profile_id = ? AND source_id = ?', scope);
  const tableMap = new Map(tableRows.map(row => [row.table_id, row]));
  const fieldMap = new Map(fieldRows.map(row => [JSON.stringify([row.table_id, row.field_name]), row]));
  const allTables = tables.map(table => ({
    id: table.table_id, name: table.table_name, schema: table.schema_name, tableKind: table.table_kind, enabled: Boolean(table.enabled), sourceComment: table.source_comment,
    annotation: annotation(tableMap.get(table.table_id), tableSignature(table)),
    fields: json(table.fields).map(field => {
      const row = fieldMap.get(JSON.stringify([table.table_id, field.name]));
      return { name: field.name, type: field.type, primaryKey: field.primaryKey ?? null, notNull: field.notNull ?? null, sourceComment: field.sourceComment ?? '', enabled: row ? Boolean(row.enabled) : true,
        annotation: annotation(row, fieldSignature(field)) };
    }),
  }));
  const projected = allTables.filter(table => table.enabled);
  const canvases = [];
  for (const row of canvasRows) {
    const canvas = { id: row.canvas_id, name: row.name, description: row.description, content: json(row.content), layout: json(row.layout), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
    const inspection = inspectCanvas(canvas, allTables);
    const confirmed = Boolean(row.confirmed && inspection.valid && row.signature === inspection.signature);
    if (row.confirmed && !confirmed) {
      await connection.execute('UPDATE dsh_relation_canvases SET confirmed = FALSE, signature = NULL WHERE profile_id = ? AND source_id = ? AND canvas_id = ?', [...scope, row.canvas_id]);
      row.confirmed = 0; row.signature = null;
      await invalidateResults(connection, profileId, sourceId);
      if (saved) { saved.saved_fingerprint = null; saved.saved_at = null; }
    }
    canvases.push({ ...canvas, ...inspection, confirmed, status: relationCompletion(canvas, projected) });
  }
  const required = projected.flatMap(table => [table.annotation, ...table.fields.filter(field => field.enabled).map(field => field.annotation)]);
  const annotatedCount = required.filter(item => item.text.trim()).length;
  const status = !projected.length || !annotatedCount ? 'unannotated'
    : required.every(item => item.status === 'confirmed') ? 'complete' : 'partial';
  const updatedAt = required.map(item => item.updatedAt).filter(Boolean).sort().at(-1) ?? null;
  const summary = { enabledTableCount: projected.length, annotatedCount, requiredCount: required.length, status, updatedAt };
  const revision = digest([source.revision, source.connection_version, source.enabled, catalog, tables, tableRows, fieldRows, canvasRows, saved ?? null]);
  return { source, tables, allTables, canvases, canvasRows, saved, tableMap, fieldMap, result: { source: { id: sourceId, name: json(source.metadata).name }, revision, tables: projected, summary } };
}

/** Must share the source row transaction with the semantic mutation. */
export async function invalidateResults(connection, profileId, sourceId) {
  await connection.execute('UPDATE dsh_annotation_results SET saved_fingerprint = NULL, saved_at = NULL WHERE profile_id = ? AND source_id = ? AND saved_fingerprint IS NOT NULL', [profileId, sourceId]);
}

const catalogSemantics = state => (state.catalog?.tables ?? []).filter(table => table.enabled).map(table => ({
  id: table.id, schema: table.schema, name: table.name, tableKind: table.tableKind, sourceComment: table.sourceComment,
  fields: [...table.fields].sort((a, b) => a.name.localeCompare(b.name)),
})).sort((a, b) => a.id.localeCompare(b.id));

/** Remove field annotations when a scan removes fields; call while holding the source row lock. */
export async function syncAnnotations(connection, profileId, before, after) {
  const next = new Map((after.catalog?.tables ?? []).map(table => [table.id, table]));
  if (digest(catalogSemantics(before)) !== digest(catalogSemantics(after))) await invalidateResults(connection, profileId, after.id);
  const [canvasRows] = await connection.execute('SELECT * FROM dsh_relation_canvases WHERE profile_id = ? AND source_id = ? ORDER BY canvas_id', [profileId, after.id]);
  const [fieldRows] = await connection.execute('SELECT * FROM dsh_field_annotations WHERE profile_id = ? AND source_id = ? ORDER BY table_id, field_name', [profileId, after.id]);
  const enabled = new Map(fieldRows.map(row => [JSON.stringify([row.table_id, row.field_name]), Boolean(row.enabled)]));
  const dependencies = [...next.values()].map(table => ({ ...table, fields: table.fields.map(field => ({ ...field, enabled: enabled.get(JSON.stringify([table.id, field.name])) ?? true })) }));
  for (const row of canvasRows) {
    if (!row.confirmed) continue;
    const inspected = inspectCanvas({ name: row.name, description: row.description, content: json(row.content) }, dependencies);
    if (!inspected.valid || inspected.signature !== row.signature) {
      await connection.execute('UPDATE dsh_relation_canvases SET confirmed = FALSE, signature = NULL WHERE profile_id = ? AND source_id = ? AND canvas_id = ?', [profileId, after.id, row.canvas_id]);
      await invalidateResults(connection, profileId, after.id);
    }
  }
  for (const table of before.catalog?.tables ?? []) {
    const current = next.get(table.id);
    if (!current) continue; // Table deletion cascades after this hook.
    const tableShape = value => [value.schema, value.name, value.tableKind, value.sourceComment];
    if (digest(tableShape(table)) !== digest(tableShape(current))) {
      await connection.execute('UPDATE dsh_table_annotations SET confirmed = FALSE, revision = revision + 1 WHERE profile_id = ? AND source_id = ? AND table_id = ? AND confirmed = TRUE', [profileId, after.id, table.id]);
    }
    const fields = new Map(current.fields.map(field => [field.name, field]));
    for (const field of table.fields) {
      const replacement = fields.get(field.name);
      if (!replacement) await connection.execute('DELETE FROM dsh_field_annotations WHERE profile_id = ? AND source_id = ? AND table_id = ? AND field_name = ?', [profileId, after.id, table.id, field.name]);
      else if (fieldSignature(field) !== fieldSignature(replacement)) await connection.execute('UPDATE dsh_field_annotations SET confirmed = FALSE, revision = revision + 1 WHERE profile_id = ? AND source_id = ? AND table_id = ? AND field_name = ? AND confirmed = TRUE', [profileId, after.id, table.id, field.name]);
    }
  }
}

export function createAnnotationStore({ db, store }) {
  if (!db?.transaction || !db.profileId) throw new Error('标注存储需要管理库。');
  const profileId = db.profileId;
  async function catalog(sourceId) { return db.transaction(async connection => (await load(connection, profileId, sourceId)).result); }
  async function list() {
    return db.transaction(async connection => {
      const [sources] = await connection.execute('SELECT source_id FROM dsh_sources WHERE profile_id = ? AND enabled = TRUE ORDER BY created_at, source_id', [profileId]);
      const items = [];
      for (const source of sources) {
        const { result } = await load(connection, profileId, source.source_id);
        items.push({ ...result.source, ...result.summary });
      }
      return { items };
    });
  }
  async function apply(input, ai = false) {
    const { sourceId, revision, operation, kind, items } = input ?? {};
    if (typeof sourceId !== 'string' || typeof revision !== 'string' || !['table', 'field'].includes(kind) || !Array.isArray(items) || !items.length || !['edit', 'confirm', 'enable'].includes(operation) || (operation === 'enable' && kind !== 'field') || (ai && operation !== 'edit')) fail('标注操作参数无效。');
    if (ai && (typeof input.sessionId !== 'string' || !input.sessionId)) fail('AI 会话无效。');
    return db.transaction(async connection => {
      const state = await load(connection, profileId, sourceId);
      if (ai) {
        const [[binding]] = await connection.execute('SELECT source_id, retired FROM dsh_flow_bindings WHERE profile_id = ? AND session_id = ? LOCK IN SHARE MODE', [profileId, input.sessionId]);
        if (!binding || binding.source_id !== sourceId || binding.retired) fail('会话已失效，请重新执行。', 409);
      }
      if (revision !== state.result.revision) fail('目录或标注已变化，请刷新后重试。', 409);
      const seen = new Set(), changes = [];
      for (const item of items) {
        const table = state.tables.find(row => row.enabled && row.table_id === item?.tableId);
        if (!table) fail('标注目标表不存在或未启用。');
        if (kind === 'field' && (typeof item.fieldName !== 'string' || [...item.fieldName].length > 255)) fail('标注字段名无效。');
        const field = kind === 'field' ? json(table.fields).find(row => row.name === item.fieldName) : null;
        if (kind === 'field' && !field) fail('标注目标字段不存在。');
        const key = JSON.stringify([item.tableId, kind === 'field' ? item.fieldName : null]);
        if (seen.has(key)) fail('标注目标重复。');
        seen.add(key);
        const old = kind === 'table' ? state.tableMap.get(item.tableId) : state.fieldMap.get(JSON.stringify([item.tableId, item.fieldName]));
        const signature = field ? fieldSignature(field) : tableSignature(table);
        const current = annotation(old, signature);
        if (ai && ((old && !old.enabled && field) || current.status === 'confirmed')) fail('AI 不能覆盖已确认标注或禁用字段。', 409);
        if (operation === 'edit' && typeof item.text !== 'string') fail('标注内容必须为文本。');
        if (operation === 'confirm' && !current.text.trim()) fail('空标注不能确认。');
        if (operation === 'enable' && typeof item.enabled !== 'boolean') fail('字段启用状态无效。');
        const changed = operation === 'edit' ? item.text !== current.text : operation === 'confirm' ? current.status !== 'confirmed' : item.enabled !== (old ? Boolean(old.enabled) : true);
        if (!changed) continue;
        changes.push({ item, old, signature, text: operation === 'edit' ? item.text : current.text,
          confirmed: operation === 'confirm' ? true : operation === 'edit' ? false : Boolean(old?.confirmed),
          enabled: operation === 'enable' ? item.enabled : old ? Boolean(old.enabled) : true,
          updatedAt: operation === 'enable' ? old?.updated_at ?? null : Date.now(),
          storedSignature: operation === 'enable' ? old?.signature ?? signature : signature });
      }
      for (const change of changes) {
        const { item, old, text, confirmed, enabled, updatedAt, storedSignature } = change;
        const common = [profileId, sourceId, item.tableId];
        if (kind === 'table') {
          await connection.execute('INSERT INTO dsh_table_annotations (profile_id, source_id, table_id, text, confirmed, signature, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text), confirmed = VALUES(confirmed), signature = VALUES(signature), updated_at = VALUES(updated_at), revision = VALUES(revision)', [...common, text, confirmed, storedSignature, updatedAt, Number(old?.revision ?? 0) + 1]);
        } else {
          await connection.execute('INSERT INTO dsh_field_annotations (profile_id, source_id, table_id, field_name, text, confirmed, signature, updated_at, revision, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text), confirmed = VALUES(confirmed), signature = VALUES(signature), updated_at = VALUES(updated_at), revision = VALUES(revision), enabled = VALUES(enabled)', [...common, item.fieldName, text, confirmed, storedSignature, updatedAt, Number(old?.revision ?? 0) + 1, enabled]);
        }
      }
      if (changes.length) await invalidateResults(connection, profileId, sourceId);
      return (await load(connection, profileId, sourceId)).result;
    });
  }

  const assertRevision = (state, revision) => { if (typeof revision !== 'string' || revision !== state.result.revision) fail('目录或标注已变化，请刷新后重试。', 409); };
  async function assertSession(connection, input) {
    if (typeof input.sessionId !== 'string' || !input.sessionId) fail('AI 会话无效。');
    const [[binding]] = await connection.execute('SELECT source_id, retired FROM dsh_flow_bindings WHERE profile_id = ? AND session_id = ? LOCK IN SHARE MODE', [profileId, input.sessionId]);
    if (!binding || binding.source_id !== input.sourceId || binding.retired) fail('会话已失效，请重新执行。', 409);
  }
  const publicCanvas = canvas => { const { signature, ...value } = canvas; return value; };
  const relationProjection = state => ({ revision: state.result.revision, items: state.canvases.map(publicCanvas) });
  function resultProjection(state) {
    const tables = state.result.tables.map(table => ({ tableId: table.id, tableName: table.name, schema: table.schema,
      annotation: table.annotation, fields: table.fields, ...tableCompletion(table) }));
    const map = new Map(tables.map(table => [table.tableId, table]));
    const relations = state.canvases.filter(canvas => canvas.confirmed && canvas.valid).map(canvas => ({ ...publicCanvas(canvas),
      tables: canvas.content.nodes.map(node => { const table = map.get(node.tableId); return { tableId: node.tableId, tableName: table.tableName, annotation: table.annotation }; }) }));
    return { revision: state.result.revision, tables, relations, summary: { tableCount: tables.length,
      completeTableCount: tables.filter(table => table.status === 'complete').length, relationCount: relations.length,
      completeRelationCount: relations.filter(canvas => canvas.status === 'complete').length } };
  }
  const fingerprint = state => resultsFingerprint({ ...state.source, metadata: json(state.source.metadata) }, state.allTables, state.canvases);
  async function bump(connection, sourceId) {
    await connection.execute('UPDATE dsh_sources SET revision = revision + 1 WHERE profile_id = ? AND source_id = ?', [profileId, sourceId]);
  }
  async function writeCanvas(connection, sourceId, canvas, old, confirmed, signature, semanticChanged) {
    const now = Math.max(Date.now(), Number(old?.updated_at ?? 0) + 1);
    await connection.execute('INSERT INTO dsh_relation_canvases (profile_id, source_id, canvas_id, name, description, content, layout, confirmed, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), content = VALUES(content), layout = VALUES(layout), confirmed = VALUES(confirmed), signature = VALUES(signature), updated_at = VALUES(updated_at)',
      [profileId, sourceId, canvas.id, canvas.name, canvas.description, JSON.stringify(canvas.content), JSON.stringify(canvas.layout), confirmed, signature, Number(old?.created_at ?? now), now]);
    if (semanticChanged) await invalidateResults(connection, profileId, sourceId);
    await bump(connection, sourceId);
  }
  async function saveRelation(input, confirm = false) {
    if (typeof input?.sourceId !== 'string') fail('数据源无效。');
    return db.transaction(async connection => {
      const state = await load(connection, profileId, input.sourceId);
      assertRevision(state, input.revision);
      const oldCanvas = state.canvases.find(canvas => canvas.id === (input.canvas?.id ?? input.canvasId));
      const old = state.canvasRows.find(row => row.canvas_id === oldCanvas?.id);
      if ((input.canvas?.id || input.canvasId) && !old) fail('关系画布已删除，请刷新后重试。', 404);
      if (!input.canvas && !(confirm && oldCanvas)) fail('关系画布无效。');
      const canvas = normalizeCanvas(input.canvas ?? oldCanvas);
      const inspected = inspectCanvas(canvas, state.allTables);
      const priorInvalid = new Set((oldCanvas?.invalid ?? []).map(value => JSON.stringify(value)));
      if (inspected.invalid.some(value => !priorInvalid.has(JSON.stringify(value)))) fail('关系引用了不存在、停用或不属于当前数据源的表或字段。');
      if (confirm && !inspected.valid) fail([...inspected.validationErrors, ...inspected.invalid.map(value => value.reason)].join(' '));
      const semanticChanged = !oldCanvas || digest(canvasSemantics(canvas)) !== digest(canvasSemantics(oldCanvas));
      const confirmed = confirm || (!semanticChanged && Boolean(oldCanvas?.confirmed));
      const changed = !oldCanvas || semanticChanged || confirmed !== oldCanvas.confirmed || digest(canvas.layout) !== digest(oldCanvas.layout)
        || digest(canvas.content) !== digest(oldCanvas.content);
      if (changed) await writeCanvas(connection, input.sourceId, canvas, old, confirmed, confirmed ? inspected.signature : null, semanticChanged || confirmed !== oldCanvas?.confirmed);
      const after = await load(connection, profileId, input.sourceId);
      return { revision: after.result.revision, canvas: publicCanvas(after.canvases.find(value => value.id === canvas.id)) };
    });
  }
  async function relationRemove(input) {
    return db.transaction(async connection => {
      const state = await load(connection, profileId, input?.sourceId);
      assertRevision(state, input?.revision);
      if (!state.canvases.some(canvas => canvas.id === input.canvasId)) fail('关系画布已删除，请刷新后重试。', 404);
      await connection.execute('DELETE FROM dsh_relation_canvases WHERE profile_id = ? AND source_id = ? AND canvas_id = ?', [profileId, input.sourceId, input.canvasId]);
      await invalidateResults(connection, profileId, input.sourceId);
      await bump(connection, input.sourceId);
      return { ok: true, revision: (await load(connection, profileId, input.sourceId)).result.revision };
    });
  }
  async function resultsSave(input) {
    return db.transaction(async connection => {
      const state = await load(connection, profileId, input?.sourceId);
      assertRevision(state, input?.revision);
      const now = Math.max(Date.now(), Number(state.saved?.saved_at ?? 0) + 1);
      await connection.execute('INSERT INTO dsh_annotation_results (profile_id, source_id, saved_fingerprint, saved_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE saved_fingerprint = VALUES(saved_fingerprint), saved_at = VALUES(saved_at)', [profileId, input.sourceId, fingerprint(state), now]);
      return { ok: true, revision: (await load(connection, profileId, input.sourceId)).result.revision };
    });
  }
  async function readSavedResults(sourceId) {
    return db.transaction(async connection => {
      const state = await load(connection, profileId, sourceId);
      const current = fingerprint(state);
      if (!state.saved?.saved_fingerprint || state.saved.saved_fingerprint !== current) fail('请先在标注确认中保存当前成果', 409);
      return { ...resultProjection(state), fingerprint: current };
    });
  }
  async function aiRelationSave(input) {
    return db.transaction(async connection => {
      const state = await load(connection, profileId, input?.sourceId);
      await assertSession(connection, input);
      assertRevision(state, input?.revision);
      if (!Array.isArray(input.relations)) fail('AI 关系建议无效。');
      if (state.result.tables.length < 2) fail('关系分析至少需要两张启用表。');
      const seen = new Set(state.canvases.flatMap(canvas => canvas.content.edges.map(relationKey)));
      const edges = [], descriptions = [], names = [];
      for (const value of input.relations) {
        const edge = normalizeEdge({ ...value, id: randomUUID() });
        const nodes = [edge.fromTableId, edge.toTableId].map(tableId => ({ tableId, label: '' }));
        const inspected = inspectCanvas({ name: '', description: '', content: { nodes, edges: [edge] } }, state.allTables);
        if (!inspected.valid) fail('AI 关系引用了不存在或停用的表或字段。');
        const key = relationKey(edge);
        if (seen.has(key)) continue;
        seen.add(key); edges.push(edge);
        if (typeof value.name === 'string' && value.name.trim()) names.push(value.name.trim());
        if (typeof value.description === 'string' && value.description.trim()) descriptions.push(value.description.trim());
      }
      if (!edges.length) return { revision: state.result.revision, canvas: null, count: 0 };
      const ids = [...new Set(edges.flatMap(edge => [edge.fromTableId, edge.toTableId]))];
      const nodes = ids.map(tableId => ({ tableId, label: state.allTables.find(table => table.id === tableId).name }));
      const canvas = normalizeCanvas({ name: names[0] ?? `${state.result.source.name}表关系`, description: [...new Set(descriptions)].join('\n'), content: { nodes, edges },
        layout: Object.fromEntries(ids.map((tableId, index) => [tableId, { x: 40 + index % 3 * 300, y: 40 + Math.floor(index / 3) * 280 }])) });
      await writeCanvas(connection, input.sourceId, canvas, null, false, null, true);
      const after = await load(connection, profileId, input.sourceId);
      return { revision: after.result.revision, canvas: publicCanvas(after.canvases.find(value => value.id === canvas.id)), count: edges.length };
    });
  }
  return { list, catalog, action: input => apply(input), aiSave: input => apply({ ...input, operation: 'edit' }, true),
    relations: sourceId => db.transaction(async connection => relationProjection(await load(connection, profileId, sourceId))),
    relationSave: input => saveRelation(input), relationConfirm: input => saveRelation(input, true), relationRemove,
    results: sourceId => db.transaction(async connection => resultProjection(await load(connection, profileId, sourceId))), resultsSave, readSavedResults, aiRelationSave };
}
