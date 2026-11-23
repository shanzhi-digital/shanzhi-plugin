import mysql from 'mysql2/promise';

const schemaVersion = 6;
const schemaColumns = new Map(Object.entries({
  dsh_management_profiles: 'profile_id',
  dsh_management_migrations: 'version applied_at',
  dsh_sources: 'profile_id source_id metadata connection_version revision enabled created_at updated_at',
  dsh_source_catalogs: 'profile_id source_id catalog_id scanned_at revision domains domain_context',
  dsh_source_tables: 'profile_id source_id table_id position schema_name table_name table_kind source_comment fields enabled domain_name category reason structure_hash freshness',
  dsh_questions: 'profile_id question_id question_text answer version created_at updated_at origin source_question_id',
  dsh_question_links: 'profile_id question_id source_id table_id fields reason question_version structure_hash analyzed_at',
  dsh_flow_bindings: 'profile_id session_id source_id retired',
  dsh_table_annotations: 'profile_id source_id table_id text confirmed signature updated_at revision',
  dsh_field_annotations: 'profile_id source_id table_id field_name text confirmed signature updated_at revision enabled',
}).map(([name, columns]) => [name, new Set(columns.split(' '))]));
const retiredTables = new Set(['dsh_flow_states', 'dsh_flow_entities', 'dsh_legacy_imports', 'dsh_flow_runs', 'dsh_flow_batches', 'dsh_flow_receipts']);
const initializeMessage = '请在专用空管理库中手工执行 migrations/001-management.sql 初始化 v6 结构。';
const upgradeMessage = '管理库为 v4，请停止旧插件，依次手工执行 migrations/002-question-origin.sql 和 migrations/003-data-annotation.sql 增量升级至 v6，保留现有数据。';
const upgradeV5Message = '管理库为 v5，请停止旧插件，手工执行 migrations/003-data-annotation.sql 增量升级至 v6，保留现有数据。';
const rebuildMessage = '管理库结构与当前插件不兼容，请停止旧插件，手工执行 scripts/reset-management.sql 清理旧管理表后，再执行 migrations/001-management.sql 重建。';
const dedicatedMessage = '所选数据库含非插件管理对象，请配置仅用于本插件的独立管理库。';

async function checkObjects(connection, version) {
  const [objects] = await connection.query(`
    SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
    UNION ALL
    SELECT TRIGGER_NAME, 'TRIGGER', NULL FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
    UNION ALL
    SELECT ROUTINE_NAME, ROUTINE_TYPE, NULL FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()
    UNION ALL
    SELECT EVENT_NAME, 'EVENT', NULL FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()
    UNION ALL
    SELECT CONSTRAINT_NAME, 'CROSS_SCHEMA_FOREIGN_KEY', NULL FROM information_schema.KEY_COLUMN_USAGE
      WHERE (TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA <> DATABASE())
         OR (REFERENCED_TABLE_SCHEMA = DATABASE() AND TABLE_SCHEMA <> DATABASE())
  `);
  if (objects.some(({ name, type }) => type !== 'BASE TABLE' || (!schemaColumns.has(name) && !retiredTables.has(name)))) {
    throw new Error(dedicatedMessage);
  }
  if (!objects.length) throw new Error(initializeMessage);
  if (version === undefined) return;
  const expected = new Set(schemaColumns.keys());
  if (version === 4 || version === 5) {
    expected.delete('dsh_table_annotations');
    expected.delete('dsh_field_annotations');
  }
  if (objects.length !== expected.size || objects.some(({ name, engine }) => !expected.has(name) || engine !== 'InnoDB')) {
    throw new Error(rebuildMessage);
  }
}

async function checkSchema(connection, version) {
  const [columns] = await connection.query(`SELECT TABLE_NAME AS name, COLUMN_NAME AS column_name,
    GENERATION_EXPRESSION AS generation_expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
  const remaining = new Map([...schemaColumns].map(([name, names]) => [name, new Set(names)]));
  if (version === 4 || version === 5) {
    remaining.delete('dsh_table_annotations');
    remaining.delete('dsh_field_annotations');
  }
  if (version === 4) {
    remaining.get('dsh_questions').delete('origin');
    remaining.get('dsh_questions').delete('source_question_id');
  }
  for (const row of columns) {
    if (row.generation_expression || !remaining.get(row.name)?.delete(row.column_name)) throw new Error(rebuildMessage);
  }
  if ([...remaining.values()].some(names => names.size)) throw new Error(rebuildMessage);
}

async function checkVersion(connection, { allowUpgrade = false } = {}) {
  const [versions] = await connection.query('SELECT version FROM dsh_management_migrations');
  if (versions.some(row => Number(row.version) > schemaVersion)) throw new Error('管理库版本高于当前插件支持版本。');
  if (versions.length === 1 && [4, 5].includes(Number(versions[0].version))) {
    const version = Number(versions[0].version);
    if (allowUpgrade) return version;
    throw new Error(version === 4 ? upgradeMessage : upgradeV5Message);
  }
  if (versions.length !== 1 || Number(versions[0].version) !== schemaVersion) throw new Error(rebuildMessage);
  return schemaVersion;
}

/** Open an already initialized, dedicated management database. */
export async function openManagementDb(config, { pool: suppliedPool } = {}) {
  for (const key of ['host', 'user', 'database', 'profileId']) {
    if (typeof config?.[key] !== 'string' || !config[key].trim()) throw new Error(`管理库配置缺少 ${key}。`);
  }
  if (config.profileId.length > 128) throw new Error('管理库 profileId 不能超过 128 个字符。');
  const pool = suppliedPool || mysql.createPool({
    host: config.host, port: config.port || 3306, user: config.user,
    password: config.password, database: config.database,
    charset: 'utf8mb4', connectionLimit: 5, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: false,
  });
  try {
    const connection = await pool.getConnection();
    try {
      await checkObjects(connection);
      const version = await checkVersion(connection, { allowUpgrade: true });
      await checkObjects(connection, version);
      await checkSchema(connection, version);
      if (version === 4) throw new Error(upgradeMessage);
      if (version === 5) throw new Error(upgradeV5Message);
    } finally { connection.release(); }
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return {
    pool,
    profileId: config.profileId,
    async transaction(work, { readOnly = false } = {}) {
      const connection = await pool.getConnection();
      try {
        if (readOnly) {
          await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        } else {
          // Reads after row locks must see updates committed while waiting for those locks.
          await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await connection.beginTransaction();
          await checkObjects(connection, schemaVersion);
          await checkVersion(connection);
        }
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally { connection.release(); }
    },
    close() { return pool.end(); },
  };
}
