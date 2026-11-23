import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = value => value == null ? null : new Date(Number(value)).toISOString();
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; error.statusCode = status; error.publicMessage = message; throw error; };
const tableSignature = table => digest([table.schema_name, table.table_name, table.table_kind, table.source_comment]);
const fieldSignature = field => digest(Object.keys(field).sort().map(key => [key, field[key]]));
const annotation = (row, signature) => ({ text: row?.text ?? '', status: !row?.text?.trim() ? 'missing' : row.confirmed && row.signature === signature ? 'confirmed' : 'pending', updatedAt: iso(row?.updated_at) });

async function load(connection, profileId, sourceId) {
  const scope = [profileId, sourceId];
  const [[source]] = await connection.execute('SELECT * FROM dsh_sources WHERE profile_id = ? AND source_id = ? FOR UPDATE', scope);
  if (!source || !source.enabled) fail('未找到启用的数据源。', 404);
  const [[catalog]] = await connection.execute('SELECT * FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?', scope);
  const [tables] = await connection.execute('SELECT * FROM dsh_source_tables WHERE profile_id = ? AND source_id = ? ORDER BY position', scope);
  const [tableRows] = await connection.execute('SELECT * FROM dsh_table_annotations WHERE profile_id = ? AND source_id = ? ORDER BY table_id', scope);
  const [fieldRows] = await connection.execute('SELECT * FROM dsh_field_annotations WHERE profile_id = ? AND source_id = ? ORDER BY table_id, field_name', scope);
  const tableMap = new Map(tableRows.map(row => [row.table_id, row]));
  const fieldMap = new Map(fieldRows.map(row => [JSON.stringify([row.table_id, row.field_name]), row]));
  const projected = tables.filter(table => table.enabled).map(table => ({
    id: table.table_id, name: table.table_name, schema: table.schema_name, sourceComment: table.source_comment,
    annotation: annotation(tableMap.get(table.table_id), tableSignature(table)),
    fields: json(table.fields).map(field => {
      const row = fieldMap.get(JSON.stringify([table.table_id, field.name]));
      return { name: field.name, type: field.type, sourceComment: field.sourceComment ?? '', enabled: row ? Boolean(row.enabled) : true,
        annotation: annotation(row, fieldSignature(field)) };
    }),
  }));
  const required = projected.flatMap(table => [table.annotation, ...table.fields.filter(field => field.enabled).map(field => field.annotation)]);
  const status = !projected.length || !required.some(item => item.text.trim()) ? 'unannotated'
    : required.every(item => item.status === 'confirmed') ? 'complete' : 'partial';
  const updatedAt = required.map(item => item.updatedAt).filter(Boolean).sort().at(-1) ?? null;
  const summary = { enabledTableCount: projected.length, status, updatedAt };
  const revision = digest([source.revision, source.connection_version, source.enabled, catalog, tables, tableRows, fieldRows]);
  return { source, tables, tableMap, fieldMap, result: { source: { id: sourceId, name: json(source.metadata).name }, revision, tables: projected, summary } };
}

/** Remove field annotations when a scan removes fields; call while holding the source row lock. */
export async function syncAnnotations(connection, profileId, before, after) {
  const next = new Map((after.catalog?.tables ?? []).map(table => [table.id, table]));
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
      return (await load(connection, profileId, sourceId)).result;
    });
  }
  return { list, catalog, action: input => apply(input), aiSave: input => apply({ ...input, operation: 'edit' }, true) };
}
