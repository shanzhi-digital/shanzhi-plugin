import { createAdapter } from './vendor/adapters.js';
import { authorizeQuery } from './sql-policy.js';
import { readSourcePassword } from './credentials.js';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { publicMessage: message, status }); };
const host = value => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(value).toLowerCase()) ? 'loopback' : String(value).toLowerCase().replace(/\.$/, '');
const identity = source => JSON.stringify([source.engine, source.host, source.port, source.user, source.database, source.file, source.credentialRef, source.connectionVersion]);
const publicTable = table => ({ tableId: table.id, name: table.name, schema: table.schema, sourceComment: table.sourceComment, fields: table.fields, structureHash: table.structureHash });

export function createQueryService({ db, credentials }) {
  let closed = false;
  const active = new Set();
  const ready = () => { if (closed) fail('查询服务已关闭。', 503); };
  async function source(connection, sourceId) {
    const [[row]] = await connection.execute('SELECT * FROM dsh_sources WHERE profile_id = ? AND source_id = ?', [db.profileId, sourceId]);
    if (!row) fail('未找到该数据源。', 404);
    const value = { ...json(row.metadata), id: row.source_id, enabled: Boolean(row.enabled), connectionVersion: Number(row.connection_version) };
    if (!value.enabled) fail('数据源已停用。', 409);
    const management = db.managementConfig;
    if (management && value.engine === 'mysql' && host(value.host) === host(management.host) && Number(value.port || 3306) === Number(management.port || 3306) && String(value.database).toLowerCase() === String(management.database).toLowerCase()) fail('业务数据源不能指向插件管理库。');
    return value;
  }
  async function tables(connection, sourceId) {
    const [rows] = await connection.execute('SELECT * FROM dsh_source_tables WHERE profile_id = ? AND source_id = ? ORDER BY position, table_id', [db.profileId, sourceId]);
    return rows.map(row => ({ id: row.table_id, name: row.table_name, schema: row.schema_name, sourceComment: row.source_comment ?? '', tableKind: row.table_kind, enabled: Boolean(row.enabled), fields: json(row.fields), structureHash: row.structure_hash }));
  }
  async function snapshot(sourceId) {
    return db.transaction(async connection => ({ source: await source(connection, sourceId), tables: await tables(connection, sourceId) }), { readOnly: true });
  }
  return {
    async sources() {
      ready();
      const [rows] = await db.pool.execute('SELECT * FROM dsh_sources WHERE profile_id = ? ORDER BY created_at, source_id', [db.profileId]);
      return rows.map(row => { const item = json(row.metadata); return { id: row.source_id, name: item.name, engine: item.engine, enabled: Boolean(row.enabled) }; });
    },
    async schema(sourceId) {
      ready(); const value = await snapshot(sourceId);
      return { sourceId, name: value.source.name, engine: value.source.engine, connectionVersion: value.source.connectionVersion, tables: value.tables.filter(table => table.enabled && table.tableKind === 'table').map(publicTable) };
    },
    async query(sourceId, input, signal) {
      ready();
      if (typeof input !== 'string' || input.length > 100000) fail('SQL 格式无效或超出长度限制。');
      const controller = new AbortController();
      let finish;
      const operation = { controller, done: new Promise(resolve => { finish = resolve; }) };
      active.add(operation);
      const readSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
      let adapter;
      try {
        readSignal.throwIfAborted();
        const before = await snapshot(sourceId), references = [];
        const sql = authorizeQuery(input, { engine: before.source.engine, database: before.source.database, tables: before.tables, references });
        if (!references.length) fail('查询必须引用至少一张已启用的表。');
        const connection = { ...before.source, password: await readSourcePassword(credentials, before.source) };
        try { adapter = createAdapter(connection, { readOnly: true }); } finally { delete connection.password; }
        const result = await adapter.queryVerified(sql, 1001, readSignal, { tables: references });
        readSignal.throwIfAborted();
        const after = await snapshot(sourceId), latest = [];
        authorizeQuery(input, { engine: after.source.engine, database: after.source.database, tables: after.tables, references: latest });
        if (identity(before.source) !== identity(after.source) || latest.length !== references.length || references.some(table => !latest.some(current => current.id === table.id && current.structureHash === table.structureHash && JSON.stringify(current.fields) === JSON.stringify(table.fields)))) fail('数据源或目录已变化，请重新查询。', 409);
        return { columns: result.columns, rows: result.rows.slice(0, 1000), rowCount: Math.min(result.rows.length, 1000), truncated: result.rows.length > 1000, connectionVersion: before.source.connectionVersion, tables: references.map(publicTable) };
      } catch (error) {
        if (error.publicMessage) throw error;
        if (readSignal.aborted) fail('查询已取消或超时。');
        fail(/^(?:SQL|sql_query )/.test(error.message ?? '') ? error.message : '查询被拒绝或执行失败，请检查启用范围、只读 SQL 和连接。');
      } finally {
        try { await adapter?.close(); } finally { active.delete(operation); finish(); }
      }
    },
    async close() {
      closed = true;
      for (const operation of active) operation.controller.abort();
      await Promise.allSettled([...active].map(operation => operation.done));
    },
  };
}
