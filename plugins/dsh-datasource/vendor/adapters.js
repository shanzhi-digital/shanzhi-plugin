/**
 * 数据库适配器层：sqlite（node:sqlite 内置）/ mysql（mysql2）/ postgres（pg）三实现。
 * 统一接口：listTables / describeTable / query / exec / ping / close。
 *
 * @module dsh-sql/adapters
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { assertIdentifier } from './config.js';
import { freshnessCandidates, normalizeTemporalValue, undetectedFreshness } from '../freshness.js';
function abortReason(signal) {
    if (signal.reason !== undefined)
        return signal.reason;
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}
function toValue(value) {
    if (typeof value === 'bigint') {
        if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
            return Number(value);
        }
        return value.toString();
    }
    if (value instanceof Date)
        return value.toISOString();
    if (value instanceof Uint8Array)
        return Array.from(value);
    if (value instanceof Map)
        return Object.fromEntries(value);
    return value;
}
function rowsToColumns(rows) {
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    const values = rows.map((row) => columns.map((column) => toValue(row[column])));
    return { columns, rows: values };
}
function quoteSqliteIdentifier(name) {
    return '"' + name.replace(/"/g, '""') + '"';
}
const mysqlOrdinaryEngine = "ENGINE IN ('InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE')";
function catalogChanged() {
    return new Error('sql_query 引用的表已变化，请刷新数据源目录后重试。');
}
function assertCatalogTables(tables) {
    if (!Array.isArray(tables) || tables.some(table => table?.tableKind !== 'table' ||
        typeof table.schema !== 'string' || !table.schema || typeof table.name !== 'string' || !table.name))
        throw catalogChanged();
}
async function verifyCatalogTables(engine, tables, signal, isOrdinary, probe) {
    for (const table of tables) {
        signal?.throwIfAborted();
        if (!await isOrdinary(table))
            throw catalogChanged();
        signal?.throwIfAborted();
        try {
            // The zero-row read holds a relation lock until the surrounding rollback.
            await probe(`SELECT 1 FROM ${qualifiedCatalogRelation(engine, table)} LIMIT 0`);
        }
        catch {
            signal?.throwIfAborted();
            throw catalogChanged();
        }
        signal?.throwIfAborted();
        if (!await isOrdinary(table))
            throw catalogChanged();
    }
    signal?.throwIfAborted();
}
function streamMysqlQuery(corePool, sql, limit, discard) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let columns = [];
        const rows = [];
        const stream = corePool.query({ sql, rowsAsArray: true }).stream({ highWaterMark: 64 });
        const finish = () => {
            if (settled)
                return;
            settled = true;
            resolve({ columns, rows });
        };
        stream.on('fields', (fields) => {
            columns = fields.map((field) => field.name);
        });
        // Consume the Readable, otherwise mysql2 pauses forever at highWaterMark.
        stream.on('data', (row) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = Object.keys(row);
            rows.push(Array.isArray(row) ? row.map(toValue) : columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                finish();
                stream.destroy();
                // mysql2 resumes its connection when only the Readable is destroyed.
                discard();
            }
        });
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
}
/** pg's `rows` option is a page size; row events avoid its full result accumulator. */
function streamPostgresQuery(client, sql, limit, discard) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let columns = [];
        const rows = [];
        // The extended protocol rejects multiple commands in a single Parse message.
        const queryConfig = { text: sql, rowMode: 'array', queryMode: 'extended' };
        const query = new pg.Query(queryConfig);
        query.on('row', (row, result) => {
            if (settled)
                return;
            if (columns.length === 0)
                columns = result?.fields.map((field) => field.name) ?? Object.keys(row);
            rows.push(Array.isArray(row) ? row.map(toValue) : columns.map((name) => toValue(row[name])));
            if (rows.length >= limit) {
                // Closing this dedicated connection stops server work and prevents reuse.
                settled = true;
                discard();
                resolve({ columns, rows });
            }
        });
        query.on('end', (result) => {
            if (settled)
                return;
            settled = true;
            if (columns.length === 0)
                columns = result.fields.map((field) => field.name);
            resolve({ columns, rows });
        });
        // Keep this listener after reaching the cap: destroying the client can emit
        // the driver's asynchronous connection-closed error on this active query.
        query.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        });
        client.query(query);
    });
}
/** MySQL 连接池配置（导出以便测试断言，不含连接）。 */
export function mysqlPoolConfig(connection) {
    return {
        host: connection.host ?? 'localhost',
        port: connection.port ?? 3306,
        user: connection.user ?? '',
        password: connection.password ?? '',
        database: connection.database ?? '',
        connectionLimit: 5,
        connectTimeout: 60000,
        enableKeepAlive: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        // 显式关掉多语句：即使词法校验被绕过，服务器也不会把第二句当命令执行。
        multipleStatements: false,
    };
}
/**
 * PostgreSQL 连接池配置。启动参数仅作为默认值；用户查询还必须使用
 * 独立只读事务，不能依赖可被 set_config 修改的会话默认设置。
 */
export function postgresPoolConfig(connection, readOnly = false) {
    const config = {
        host: connection.host ?? 'localhost',
        port: connection.port ?? 5432,
        user: connection.user ?? '',
        password: connection.password ?? '',
        database: connection.database ?? '',
        max: 5,
        connectionTimeoutMillis: 60000,
    };
    if (readOnly)
        config.options = '-c default_transaction_read_only=on';
    return config;
}
/** SQLite 适配器（node:sqlite，零依赖）。 */
class SqliteAdapter {
    engine = 'sqlite';
    readOnly;
    db;
    constructor(file, readOnly = false) {
        this.readOnly = readOnly;
        const memory = file === ':memory:';
        // 内存库没有落盘风险，也不支持只读打开；文件库在 readOnly 下由 SQLite
        // 自己拒绝任何写入（PRAGMA 写、DDL、DML 都会报 attempt to write a readonly database）。
        const options = readOnly && !memory ? { readOnly: true } : {};
        try {
            this.db = new DatabaseSync(memory ? ':memory:' : file, options);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error('无法打开 SQLite 文件 ' + file + '（readOnly=' + readOnly + '）：' + detail);
        }
        this.db.exec('PRAGMA busy_timeout = 5000');
    }
    async listTables(signal) {
        signal?.throwIfAborted();
        const result = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        signal?.throwIfAborted();
        return result.map((row) => String(row.name));
    }
    async describeTable(table, signal) {
        signal?.throwIfAborted();
        const name = assertIdentifier(table, '表名');
        const rows = this.db.prepare('PRAGMA table_info(' + quoteSqliteIdentifier(name) + ')').all();
        signal?.throwIfAborted();
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type ?? ''),
            notNull: Number(row.notnull) === 1,
            primaryKey: Number(row.pk) === 1,
        }));
    }
    async query(sql, limit, signal) {
        return this.#read(sql, limit, signal);
    }
    async queryVerified(sql, limit, signal, { tables } = {}) {
        signal?.throwIfAborted();
        assertCatalogTables(tables);
        if (tables.length === 0)
            return this.#read(sql, limit, signal);
        this.db.exec('BEGIN');
        try {
            // Reading the schema pins the same main database snapshot used by #read.
            const ordinary = new Set(this.db.prepare('PRAGMA main.table_list').all()
                .filter(row => row.type === 'table' && !row.name.startsWith('sqlite_')).map(row => row.name));
            if (tables.some(table => table.schema !== 'main' || !ordinary.has(table.name)))
                throw catalogChanged();
            return this.#read(sql, limit, signal);
        }
        finally {
            this.db.exec('ROLLBACK');
        }
    }
    #read(sql, limit, signal) {
        signal?.throwIfAborted();
        const statement = this.db.prepare(sql);
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        const columns = statement.columns().map((column) => column.name);
        if (limit === undefined || limit <= 0) {
            const rows = statement.all().map(row => row.map(toValue));
            signal?.throwIfAborted();
            return { columns, rows };
        }
        const rows = [];
        for (const raw of statement.iterate()) {
            rows.push(raw.map(toValue));
            signal?.throwIfAborted();
            if (rows.length >= limit)
                break;
        }
        return { columns, rows };
    }
    async exec(sql, signal) {
        if (this.readOnly)
            throw new Error('当前配置 readOnly=true，禁止写入数据库。');
        signal?.throwIfAborted();
        const single = sql.replace(/;\s*$/, '').trim();
        if (single.includes(';')) {
            this.db.exec(sql);
            signal?.throwIfAborted();
            return 0;
        }
        const result = this.db.prepare(single).run();
        signal?.throwIfAborted();
        return Number(result.changes);
    }
    async ping(signal) {
        signal?.throwIfAborted();
        this.db.prepare('SELECT 1').get();
        signal?.throwIfAborted();
    }
    async close() {
        this.db.close();
    }
}
/** MySQL 适配器（mysql2 连接池）。 */
class MysqlAdapter {
    readOnly;
    engine = 'mysql';
    pool;
    constructor(connection, readOnly = false) {
        this.readOnly = readOnly;
        this.pool = mysql.createPool(mysqlPoolConfig(connection));
    }
    async withSignalConnection(signal, work) {
        signal?.throwIfAborted();
        const connection = await this.pool.getConnection();
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            connection.destroy();
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(connection, discard, () => destroyed), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                connection.release();
        }
    }
    async withReadOnlyConnection(signal, work, verifyCatalog = false) {
        return await this.withSignalConnection(signal, async (connection, discard, isDiscarded) => {
            try {
                if (verifyCatalog)
                    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                // Await setup and fail closed; never silently ignore an unsupported mode.
                await connection.query('START TRANSACTION READ ONLY');
                return await work(connection, discard);
            }
            finally {
                if (!isDiscarded()) {
                    try {
                        await connection.query('ROLLBACK');
                    }
                    catch (error) {
                        discard();
                        throw error;
                    }
                }
            }
        });
    }
    async queryRows(sql, signal) {
        if (signal === undefined)
            return typeof sql === 'string' ? await this.pool.query(sql) : await this.pool.query(sql);
        return await this.withSignalConnection(signal, async (connection) => typeof sql === 'string' ? await connection.query(sql) : await connection.query(sql));
    }
    async listTables(signal) {
        const [rows] = await this.queryRows('SHOW TABLES', signal);
        return rows.map((row) => String(Object.values(row)[0] ?? ''));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const [rows] = await this.queryRows('DESCRIBE `' + name + '`', signal);
        return rows.map((row) => ({
            name: String(row.Field),
            type: String(row.Type ?? ''),
            notNull: String(row.Null ?? '').toUpperCase() === 'NO',
            primaryKey: String(row.Key ?? '').toUpperCase() === 'PRI',
        }));
    }
    async query(sql, limit, signal) {
        return await this.#query(sql, limit, signal);
    }
    async queryVerified(sql, limit, signal, { tables } = {}) {
        signal?.throwIfAborted();
        assertCatalogTables(tables);
        return await this.#query(sql, limit, signal, tables);
    }
    async #query(sql, limit, signal, tables = []) {
        return await this.withReadOnlyConnection(signal, async (connection, discard) => {
            if (tables.length) {
                await verifyCatalogTables(this.engine, tables, signal, async ({ schema, name }) => {
                    const [rows] = await connection.execute(`SELECT 1 FROM information_schema.TABLES
                        WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_SCHEMA = ? AND BINARY TABLE_NAME = ?
                            AND TABLE_TYPE = 'BASE TABLE' AND ${mysqlOrdinaryEngine}`, [schema, name]);
                    return rows.length === 1;
                }, query => connection.query(query));
            }
            if (limit === undefined || limit <= 0) {
                const [rows, fields] = await connection.query({ sql, rowsAsArray: true });
                if (fields?.length)
                    return { columns: fields.map(field => field.name), rows: rows.map(row => Array.isArray(row) ? row.map(toValue) : fields.map(field => toValue(row[field.name]))) };
                return rowsToColumns(rows);
            }
            const coreConnection = connection.connection;
            return await streamMysqlQuery(coreConnection, sql, limit, discard);
        }, tables.length > 0);
    }
    async exec(sql, signal) {
        if (this.readOnly)
            throw new Error('当前配置 readOnly=true，禁止写入数据库。');
        const [result] = await this.queryRows(sql, signal);
        return Number(result?.affectedRows ?? 0);
    }
    async ping(signal) {
        await this.queryRows('SELECT 1', signal);
    }
    async close() {
        await this.pool.end();
    }
}
/** PostgreSQL 适配器（pg 连接池）。 */
class PostgresAdapter {
    readOnly;
    engine = 'postgres';
    pool;
    constructor(connection, readOnly = false) {
        this.readOnly = readOnly;
        this.pool = new pg.Pool(postgresPoolConfig(connection, readOnly));
    }
    async withSignalClient(signal, work) {
        signal?.throwIfAborted();
        const client = await this.pool.connect();
        let destroyed = false;
        let rejectAbort = () => { };
        const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
        const discard = () => {
            if (destroyed)
                return;
            destroyed = true;
            client.release(true);
        };
        const onAbort = () => {
            discard();
            rejectAbort(abortReason(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            signal?.throwIfAborted();
            return await Promise.race([work(client, discard, () => destroyed), aborted]);
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
            if (!destroyed)
                client.release();
        }
    }
    async withReadOnlyClient(signal, work, verifyCatalog = false) {
        return await this.withSignalClient(signal, async (client, discard, isDiscarded) => {
            try {
                // The catalog recheck must see changes committed before the relation lock.
                await client.query(verifyCatalog ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' : 'BEGIN READ ONLY');
                await client.query('SET LOCAL search_path = pg_catalog');
                return await work(client, discard);
            }
            finally {
                // Rollback also reverts set_config(..., false). A capped/cancelled query
                // destroys its connection instead, causing server-side rollback.
                if (!isDiscarded()) {
                    try {
                        await client.query('ROLLBACK');
                    }
                    catch (error) {
                        discard();
                        throw error;
                    }
                }
            }
        });
    }
    async queryWithSignal(query, values, signal) {
        const run = async (client) => {
            return values === undefined ? await client.query(query) : await client.query(query, values);
        };
        if (signal === undefined)
            return await run(this.pool);
        return await this.withSignalClient(signal, run);
    }
    async listTables(signal) {
        const result = await this.queryWithSignal("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name", undefined, signal);
        return result.rows.map((row) => String(row.table_name));
    }
    async describeTable(table, signal) {
        const name = assertIdentifier(table, '表名');
        const result = await this.queryWithSignal(`SELECT c.column_name, c.data_type, c.is_nullable,
              EXISTS (
                SELECT 1
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = c.table_schema
                  AND tc.table_name = c.table_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.column_name = c.column_name
              ) AS is_primary
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = $1
        ORDER BY c.ordinal_position`, [name], signal);
        return result.rows.map((row) => ({
            name: String(row.column_name),
            type: String(row.data_type ?? ''),
            notNull: String(row.is_nullable) === 'NO',
            primaryKey: row.is_primary === true,
        }));
    }
    async query(sql, limit, signal) {
        return await this.#query(sql, limit, signal);
    }
    async queryVerified(sql, limit, signal, { tables } = {}) {
        signal?.throwIfAborted();
        assertCatalogTables(tables);
        return await this.#query(sql, limit, signal, tables);
    }
    async #query(sql, limit, signal, tables = []) {
        return await this.withReadOnlyClient(signal, async (client, discard) => {
            if (tables.length) {
                await verifyCatalogTables(this.engine, tables, signal, async ({ schema, name }) => {
                    const { rows } = await client.query(`SELECT 1 FROM pg_catalog.pg_class c
                        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname::text = $1 AND c.relname::text = $2
                            AND c.relkind = 'r' AND NOT c.relrowsecurity`, [schema, name]);
                    return rows.length === 1;
                }, query => client.query(query));
            }
            if (limit === undefined || limit <= 0) {
                const queryConfig = { text: sql, rowMode: 'array', queryMode: 'extended' };
                const result = await client.query(queryConfig);
                return { columns: result.fields.map((field) => field.name), rows: result.rows.map((row) => row.map(toValue)) };
            }
            return await streamPostgresQuery(client, sql, limit, discard);
        }, tables.length > 0);
    }
    async exec(sql, signal) {
        if (this.readOnly)
            throw new Error('当前配置 readOnly=true，禁止写入数据库。');
        const result = await this.queryWithSignal(sql, undefined, signal);
        return Number(result.rowCount ?? 0);
    }
    async ping(signal) {
        await this.queryWithSignal('SELECT 1', undefined, signal);
    }
    async close() {
        await this.pool.end();
    }
}
/** Catalog names come from the database, so quote them without sql_schema's input restriction. */
function catalogIdentifier(engine, name) {
    return engine === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : quoteSqliteIdentifier(name);
}
function qualifiedCatalogRelation(engine, { schema, name }) {
    const qualified = catalogIdentifier(engine, schema) + '.' + catalogIdentifier(engine, name);
    return (engine === 'postgres' ? 'ONLY ' : '') + qualified;
}

async function catalogTables(adapter, signal) {
    signal?.throwIfAborted();
    if (adapter.engine === 'sqlite') {
        const rows = adapter.db.prepare('PRAGMA main.table_list').all();
        return rows.filter(row => ['table', 'virtual', 'shadow'].includes(row.type) && !row.name.startsWith('sqlite_'))
            .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
            .map(row => ({ name: row.name, schema: 'main', sourceComment: '', tableKind: row.type }));
    }
    if (adapter.engine === 'mysql') {
        const [rows] = await adapter.queryRows(`SELECT TABLE_NAME AS name, TABLE_SCHEMA AS \`schema\`, TABLE_COMMENT AS sourceComment,
            CASE WHEN ${mysqlOrdinaryEngine} THEN 'table'
                ELSE 'external' END AS tableKind
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME`, signal);
        return rows.map(row => ({ name: row.name, schema: row.schema, sourceComment: row.sourceComment ?? '', tableKind: row.tableKind }));
    }
    const { rows } = await adapter.queryWithSignal(`SELECT c.relname AS name, n.nspname AS schema,
            CASE WHEN c.relrowsecurity THEN 'policy_table' WHEN c.relkind = 'r' THEN 'table'
                WHEN c.relkind = 'p' THEN 'partitioned' ELSE 'foreign' END AS "tableKind",
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS "sourceComment"
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f') AND n.nspname <> 'information_schema'
            AND n.nspname !~ '^pg_' AND has_schema_privilege(n.oid, 'USAGE')
            AND (has_table_privilege(c.oid, 'SELECT') OR has_any_column_privilege(c.oid, 'SELECT'))
        ORDER BY n.nspname, c.relname`, undefined, signal);
    return rows;
}

async function mysqlCatalogFields(adapter, signal) {
    signal?.throwIfAborted();
    const [rows] = await adapter.queryRows(`SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS tableName,
        COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS columnKey,
        IS_NULLABLE AS nullable, COLUMN_COMMENT AS sourceComment
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION`, signal);
    const fieldsByTable = new Map();
    for (const row of rows) {
        const key = JSON.stringify([row.schema, row.tableName]);
        if (!fieldsByTable.has(key))
            fieldsByTable.set(key, []);
        fieldsByTable.get(key).push({
            name: row.name, type: row.type, primaryKey: row.columnKey === 'PRI',
            notNull: row.nullable === 'NO', sourceComment: row.sourceComment ?? '',
        });
    }
    return fieldsByTable;
}

async function catalogFields(adapter, table, signal) {
    signal?.throwIfAborted();
    if (adapter.engine === 'sqlite') {
        const rows = adapter.db.prepare('PRAGMA main.table_xinfo(' + quoteSqliteIdentifier(table.name) + ')').all();
        return rows.filter(row => Number(row.hidden) !== 1).map(row => ({
            name: String(row.name), type: String(row.type ?? ''), primaryKey: Number(row.pk) > 0,
            notNull: Number(row.notnull) === 1, sourceComment: '',
        }));
    }
    const { rows } = await adapter.queryWithSignal(`SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
                WHERE k.conrelid = c.oid AND k.contype = 'p' AND a.attnum = ANY(k.conkey)) AS "primaryKey",
            a.attnotnull AS "notNull", COALESCE(col_description(c.oid, a.attnum), '') AS "sourceComment",
            COALESCE(bt.typname, t.typname) AS "sampleType",
            EXISTS (SELECT 1 FROM pg_catalog.pg_namespace tn
                WHERE tn.oid = COALESCE(bt.typnamespace, t.typnamespace) AND tn.nspname = 'pg_catalog') AS "sampleBuiltin"
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
            LEFT JOIN pg_catalog.pg_type bt ON bt.oid = NULLIF(t.typbasetype, 0)
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [table.schema, table.name], signal);
    return rows;
}

// Bound values in SQL before drivers allocate them; SQLite values may differ from declared types.
function catalogProjection(engine, field) {
    const name = catalogIdentifier(engine, field.name);
    if (engine === 'sqlite') {
        return {
            value: `CASE WHEN typeof(${name}) = 'blob' THEN NULL WHEN typeof(${name}) = 'text' THEN substr(${name}, 1, 2048) ELSE ${name} END`,
            truncated: `(typeof(${name}) = 'blob' OR (typeof(${name}) = 'text' AND length(${name}) > 2048))`,
        };
    }
    const type = String(field.sampleType ?? field.type).toLowerCase();
    if (engine === 'postgres' && field.sampleBuiltin !== true)
        return { value: 'NULL', truncated: 'TRUE' };
    if (/bytea|blob|binary|^(?:var)?bit(?:\b|\()/.test(type)
        || (engine === 'mysql' && /^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/.test(type)))
        return { value: 'NULL', truncated: `${name} IS NOT NULL` };
    const scalar = engine === 'mysql'
        ? /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|date|datetime|timestamp|time|year)\b/.test(type)
        : /^(?:int2|int4|int8|float4|float8|bool|date|time|timetz|timestamp|timestamptz)$/.test(type);
    if (scalar)
        return { value: name, truncated: 'FALSE' };
    const text = `CAST(${name} AS ${engine === 'mysql' ? 'CHAR' : 'text'})`;
    return { value: `LEFT(${text}, 2048)`, truncated: `CHAR_LENGTH(${text}) > 2048` };
}

/** Scan source metadata for trusted catalog identifiers. */
export async function scanSourceCatalog(adapter, { signal, onProgress } = {}) {
    let tables;
    try {
        tables = await catalogTables(adapter, signal);
        signal?.throwIfAborted();
    }
    catch {
        signal?.throwIfAborted();
        throw new Error('读取数据源目录失败。');
    }
    await onProgress?.({ completed: 0, total: tables.length });
    const catalog = [];
    let mysqlFieldsByTable;
    for (const table of tables) {
        const key = JSON.stringify([table.schema, table.name]);
        let fields;
        try {
            if (table.tableKind !== 'table') {
                // Do not introspect virtual/foreign objects through extension callbacks.
                fields = [];
            }
            else if (adapter.engine === 'mysql') {
                mysqlFieldsByTable ??= await mysqlCatalogFields(adapter, signal);
                fields = mysqlFieldsByTable.get(key);
            }
            else {
                fields = await catalogFields(adapter, table, signal);
            }
            if (table.tableKind === 'table' && !fields?.length)
                throw new Error('No visible fields');
            signal?.throwIfAborted();
        }
        catch {
            signal?.throwIfAborted();
            throw new Error('读取数据源目录失败。');
        }
        catalog.push({
            id: createHash('sha256').update(key).digest('hex'),
            name: table.name, schema: table.schema, sourceComment: table.sourceComment ?? '', tableKind: table.tableKind,
            fields: fields.map(({ name, type, primaryKey, notNull, sourceComment }) => ({
                name, type, primaryKey, notNull, sourceComment: sourceComment ?? '',
            })),
        });
        await onProgress?.({ completed: catalog.length, total: tables.length });
    }
    signal?.throwIfAborted();
    return catalog;
}

/** Only ordinary catalog tables support fixed business reads. PG ONLY avoids foreign descendants. */
function catalogRelation(adapter, table) {
    if (table.tableKind !== 'table' || !table.schema || !table.name || !Array.isArray(table.fields))
        throw new Error('Only ordinary catalog tables are supported');
    return qualifiedCatalogRelation(adapter.engine, table);
}

/** Read a bounded sample for a table from a trusted catalog snapshot. */
export async function sampleCatalogTable(adapter, table, { signal } = {}) {
    try {
        signal?.throwIfAborted();
        const relation = catalogRelation(adapter, table);
        let fields = table.fields;
        if (adapter.engine === 'postgres') {
            // PostgreSQL domains use their base type for sampling. Preserve snapshot field order.
            const currentFields = await catalogFields(adapter, table, signal);
            signal?.throwIfAborted();
            const fieldsByName = new Map(currentFields.map(field => [field.name, field]));
            fields = fields.map(field => fieldsByName.get(field.name));
            if (fields.some(field => field === undefined))
                throw new Error('Missing catalog fields');
        }
        const projections = fields.map(field => catalogProjection(adapter.engine, field));
        const sql = `SELECT ${projections.map(item => item.value).join(', ')}, (${projections.map(item => `(${item.truncated})`).join(' OR ')}) FROM ${relation} LIMIT 10`;
        const { rows } = await adapter.query(sql, undefined, signal);
        signal?.throwIfAborted();
        return {
            samples: rows.map(row => row.slice(0, fields.length)),
            sampleStatus: rows.length ? 'ok' : 'empty',
            sampleTruncated: rows.some(row => Boolean(row[fields.length])),
        };
    }
    catch {
        signal?.throwIfAborted();
        return { samples: [], sampleStatus: 'failed', sampleTruncated: false };
    }
}

/** Fixed existence/MAX queries; callers must pass a table from the current catalog. */
export async function detectTableFreshness(adapter, table, { signal, now = Date.now } = {}) {
    signal?.throwIfAborted();
    const result = { ...undetectedFreshness(), scannedAt: new Date(typeof now === 'function' ? now() : now).toISOString() };
    const read = async (sql) => {
        const timeout = AbortSignal.timeout(60000);
        const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const value = await adapter.query(sql, undefined, readSignal);
        readSignal.throwIfAborted();
        return value;
    };
    try {
        const relation = catalogRelation(adapter, table);
        const existence = await read(`SELECT 1 FROM ${relation} LIMIT 1`);
        result.empty = existence.rows.length === 0;
        if (result.empty) return { ...result, status: 'EMPTY' };
        const candidates = freshnessCandidates(table.fields);
        if (!candidates.length) return { ...result, status: 'NO_TIME_COLUMN' };
        for (const field of candidates) {
            signal?.throwIfAborted();
            result.timeColumn = field.name;
            const column = catalogIdentifier(adapter.engine, field.name);
            // Ask server drivers for text so DATE and naive TIMESTAMP never become JS UTC Dates.
            const aggregate = `MAX(${column})`;
            const expression = adapter.engine === 'sqlite' ? aggregate : `CAST(${aggregate} AS ${adapter.engine === 'mysql' ? 'CHAR' : 'text'})`;
            const instant = adapter.engine === 'mysql' && /^timestamp(?:\(\d+\))?$/i.test(field.type);
            const { rows } = await read(`SELECT ${expression}${instant ? `, UNIX_TIMESTAMP(${aggregate})` : ''} FROM ${relation}`);
            let value = rows[0]?.[0];
            if (value === null || value === undefined) continue;
            // MySQL TIMESTAMP is an instant displayed in the connection's timezone.
            if (instant) {
                const seconds = rows[0]?.[1];
                if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)))
                    throw new Error('Missing timestamp epoch');
                value = new Date(Number(seconds) * 1000).toISOString();
            }
            return { ...result, ...normalizeTemporalValue(value, field.type), status: 'OK' };
        }
        return { ...result, status: 'NO_TIME_VALUE', timeColumn: null };
    }
    catch {
        signal?.throwIfAborted();
        return { ...result, status: 'ERROR', error: '无法读取表数据时间，请检查连接、表类型和读取权限。' };
    }
}

/** 按连接配置创建适配器；readOnly 会下沉到引擎自身的只读约束。 */
export function createAdapter(connection, options = {}) {
    const readOnly = options.readOnly === true;
    if (connection.engine === 'sqlite')
        return new SqliteAdapter(connection.file ?? ':memory:', readOnly);
    if (connection.engine === 'mysql')
        return new MysqlAdapter(connection, readOnly);
    return new PostgresAdapter(connection, readOnly);
}
