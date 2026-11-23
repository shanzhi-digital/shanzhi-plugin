/** Parameter and output templates for the three SQL tools owned by DatasourceRuntime. */
import { scanSql } from '../sql-policy.js';

function parameters(properties, required = []) {
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

const connectionParameter = { type: 'string', description: '连接名（缺省为第一个已启用数据源）。' };
const strings = { type: 'array', items: { type: 'string' } };
const columnsSchema = {
    type: 'array',
    items: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' }, notNull: { type: 'boolean' }, primaryKey: { type: 'boolean' } },
        additionalProperties: true,
    },
};

function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}

/** Lexical guard retained for callers that need a statement check without a catalog. */
export function assertReadQuery(sql, engine) {
    const trimmed = sql.trim();
    const { clean } = scanSql(trimmed, engine);
    const statement = clean.trim().replace(/;$/, '').trimEnd();
    if (statement.includes(';')) throw new Error('sql_query 一次只允许一条语句。');
    if (/^(?:show|describe|desc|pragma)\b/i.test(statement) || /^explain\s+(?:query\s+plan\s+)?pragma\b/i.test(statement)) {
        throw new Error('sql_query 只接受 SELECT；请使用 sql_schema 查看目录和表结构。');
    }
    if (!/^(?:(?:explain\s+(?:query\s+plan\s+)?)?(?:select|with))\b/i.test(statement)) {
        throw new Error('sql_query 只接受只读 SELECT 或 WITH 查询。');
    }
    if (/\binto\b|\bfor\s+(?:update|no\s+key\s+update|share|key\s+share)\b|\block\s+in\s+share\s+mode\b/i.test(statement)) {
        throw new Error('sql_query 不接受 SELECT INTO 或锁定查询。');
    }
    const write = /\b(insert|update|delete|replace|merge|drop|alter|create|truncate|call|execute|copy|grant|revoke|attach|detach|vacuum|reindex|refresh|set|reset|begin|commit|rollback|savepoint|release|analyze|load_extension)\b/i.exec(statement);
    if (write) throw new Error('sql_query 检测到写操作关键字 ' + write[0].toUpperCase() + '。');
    return trimmed.replace(/;\s*$/, '').trim();
}

export function summarizeWriteScript(sql) {
    const trimmed = sql.trim();
    const { clean } = scanSql(trimmed);
    const statements = clean.split(';').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const effective = statements.length === 0 ? ['(空语句)'] : statements;
    const tally = new Map();
    for (const statement of effective) {
        const keyword = /^[a-z]+/i.exec(statement)?.[0]?.toUpperCase() ?? '?';
        tally.set(keyword, (tally.get(keyword) ?? 0) + 1);
    }
    const lines = ['共 ' + effective.length + ' 条语句：'];
    effective.slice(0, 100).forEach((statement, index) => {
        lines.push('  ' + (index + 1) + '. ' + (statement.length > 120 ? statement.slice(0, 120) + '…' : statement));
    });
    if (effective.length > 100) lines.push('  …另有 ' + (effective.length - 100) + ' 条语句');
    lines.push('语句类型：' + [...tally.entries()].map(([keyword, count]) => keyword + '×' + count).join('，'));
    if (trimmed.length <= 800) lines.push('', '完整 SQL：' + trimmed);
    else lines.push('', '完整 SQL 共 ' + trimmed.length + ' 个字符，见本次工具调用参数。');
    return lines.join('\n');
}

export function toCsv(columns, rows) {
    const escape = (cell) => {
        if (cell === null || cell === undefined) return '';
        const text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
        return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    return [columns.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n');
}

export function buildSqlTools() {
    const sqlList = {
        name: 'sql_list',
        description: '列出当前已启用的数据源并测试连接。',
        parameters: parameters({}),
        output: {
            schema: {
                type: 'object',
                properties: {
                    connections: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { name: { type: 'string' }, engine: { type: 'string' }, host: { type: 'string' }, database: { type: 'string' }, file: { type: 'string' }, connected: { type: 'boolean' }, error: { type: 'string' } },
                            additionalProperties: true,
                        },
                    },
                },
                additionalProperties: true,
            },
            render: (_args, value) => {
                const rec = asRecord(value);
                const connections = Array.isArray(rec.connections) ? rec.connections : [];
                const lines = ['共 ' + connections.length + ' 个数据库连接：'];
                for (const item of connections) {
                    const c = asRecord(item);
                    const target = c.file || [c.host, c.database].filter(Boolean).join('/');
                    const label = target ? c.engine + ' @ ' + target : c.engine;
                    const status = c.connected === true ? ' 正常' : ' 异常 ' + String(c.error ?? '');
                    lines.push('- ' + c.name + '（' + label + '）' + status);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
    };
    const sqlQuery = {
        name: 'sql_query',
        description: '执行受校验的只读 SELECT 查询。查看结构请使用 sql_schema。',
        parameters: parameters({
            sql: { type: 'string', description: '单条只读 SQL 查询。' },
            connection: connectionParameter,
            format: { type: 'string', description: '输出格式为 table（默认）、csv 或 json。' },
        }, ['sql']),
        output: {
            schema: {
                type: 'object',
                properties: {
                    connection: { type: 'string' }, columns: strings, rows: { type: 'array', items: { type: 'array', items: {} } },
                    rowCount: { type: 'integer' }, truncated: { type: 'boolean' }, maxRows: { type: 'integer' },
                    format: { type: 'string' }, formatted: { type: 'string' },
                },
                additionalProperties: true,
            },
            render: (_args, value) => {
                const rec = asRecord(value);
                if (typeof rec.formatted === 'string' && rec.formatted !== '') {
                    const preview = rec.formatted.length > 4000 ? rec.formatted.slice(0, 4000) + '\n…（预览已截断）' : rec.formatted;
                    return [{ type: 'text', text: '查询返回 ' + rec.rowCount + ' 行（' + String(rec.format) + ' 格式）：\n' + preview }];
                }
                const rows = Array.isArray(rec.rows) ? rec.rows : [];
                const lines = ['查询返回 ' + rec.rowCount + ' 行' + (rec.truncated === true ? '（截断到 ' + rec.maxRows + ' 行）' : '') + '，列：' + (Array.isArray(rec.columns) ? rec.columns.join(', ') : '')];
                for (const row of rows.slice(0, 20)) {
                    lines.push('- ' + (Array.isArray(row) ? row.map((cell) => String(cell)).join(' | ') : String(row)));
                }
                if (rows.length > 20) lines.push('…仅展示前 20 行');
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
    };
    const sqlSchema = {
        name: 'sql_schema',
        description: '列出当前数据源已启用的表，或查看指定表的原始字段。',
        parameters: parameters({
            table: { type: 'string', description: '表名（缺省列出所有已启用表）。' },
            connection: connectionParameter,
        }),
        output: {
            schema: {
                type: 'object',
                properties: {
                    connection: { type: 'string' },
                    tables: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { name: { type: 'string' }, schema: { type: 'string' }, comment: { type: 'string' }, columns: columnsSchema },
                            additionalProperties: true,
                        },
                    },
                },
                additionalProperties: true,
            },
            render: (args, value) => {
                const rec = asRecord(value);
                const tables = Array.isArray(rec.tables) ? rec.tables : [];
                const label = (table) => [table.schema, table.name].filter(Boolean).join('.');
                if (asRecord(args).table && tables.length === 1) {
                    const table = asRecord(tables[0]);
                    const lines = ['表 ' + label(table) + ' 的列：'];
                    if (Array.isArray(table.columns)) {
                        for (const item of table.columns) {
                            const c = asRecord(item);
                            lines.push('- ' + c.name + ' ' + c.type + (c.primaryKey === true ? '（主键）' : '') + (c.notNull === true ? '（非空）' : ''));
                        }
                    }
                    return [{ type: 'text', text: lines.join('\n') }];
                }
                return [{ type: 'text', text: '共 ' + tables.length + ' 张表：' + tables.map((table) => label(asRecord(table))).join(', ') }];
            },
        },
    };
    return { tools: [sqlList, sqlQuery, sqlSchema] };
}
