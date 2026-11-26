import sqlParser from 'node-sql-parser';

const parser = new sqlParser.Parser();
const dialects = new Map([['mysql', 'MySQL'], ['postgres', 'Postgresql'], ['sqlite', 'SQLite']]);
const fold = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const word = (value) => value !== undefined && /[\p{L}\p{N}_$]/u.test(value);

/** Keep SQL and a parallel view with comments and quoted tokens blanked out. */
export function scanSql(input, engine, replaceToken = (token) => token.text) {
    let sql = '';
    let clean = '';
    let index = 0;
    while (index < input.length) {
        const start = index;
        const char = input[index];
        const next = input[index + 1];
        const mysql = engine === 'mysql';
        const postgres = engine === 'postgres';
        const lineComment = (char === '#' && mysql) || (char === '-' && next === '-' &&
            (!mysql || /[\x00-\x20\x7f]/.test(input[index + 2] ?? '')));
        if (lineComment) {
            while (index < input.length && input[index] !== '\n' && (!postgres || input[index] !== '\r')) index += 1;
        } else if (char === '/' && next === '*') {
            if (mysql && /^(?:!|m!)/i.test(input.slice(index + 2, index + 4))) {
                throw new Error('sql_query 不接受 MySQL/MariaDB 可执行注释。');
            }
            index += 2;
            let depth = 1;
            while (index < input.length && depth > 0) {
                if (input.startsWith('*/', index)) {
                    depth -= 1;
                    index += 2;
                } else if (postgres && input.startsWith('/*', index)) {
                    depth += 1;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            if (depth > 0) throw new Error('SQL 块注释未闭合。');
        } else if (mysql && char === '-' && next === '-') {
            // The parser accepts -- without whitespace in MySQL, which treats it as two minus tokens.
            sql += '- ';
            clean += '- ';
            index += 1;
            continue;
        } else {
            const dollar = postgres && char === '$' && !word(input[index - 1])
                ? /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(input.slice(index))?.[0] : undefined;
            const delimited = char === "'" || char === '"' || (char === '`' && !postgres) ||
                (char === '[' && engine === 'sqlite');
            if (dollar) {
                const end = input.indexOf(dollar, index + dollar.length);
                if (end === -1) throw new Error('SQL 美元引号字符串未闭合。');
                index = end + dollar.length;
                sql += replaceToken({ text: input.slice(start, index), kind: 'literal', quote: dollar,
                    value: input.slice(start + dollar.length, end), previous: input[start - 1] });
            } else if (delimited) {
                const endQuote = char === '[' ? ']' : char;
                const pgEscape = postgres && char === "'" && /[eE]/.test(input[start - 1] ?? '') && !word(input[start - 2]);
                const escapes = pgEscape || (mysql && (char === "'" || char === '"'));
                let value = '';
                let closed = false;
                index += 1;
                while (index < input.length) {
                    const part = input[index++];
                    if (part === endQuote) {
                        if (char !== '[' && input[index] === endQuote) {
                            value += part;
                            index += 1;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    value += part;
                    if (escapes && part === '\\') value += input[index++] ?? '';
                }
                if (!closed) throw new Error('SQL 字符串或标识符引号未闭合。');
                const kind = char === "'" || (mysql && char === '"') ? 'literal' : 'identifier';
                sql += replaceToken({ text: input.slice(start, index), kind, quote: char,
                    value, previous: input[start - 1] });
            } else {
                sql += char;
                clean += char;
                index += 1;
                continue;
            }
            clean += ' ';
            continue;
        }
        sql += ' ';
        clean += ' ';
    }
    return { sql, clean };
}

const unsupported = () => { throw new Error('sql_query 不支持此 SQL 语法，只接受可校验的只读 SELECT。'); };
const ensure = (condition) => { if (!condition) unsupported(); };

function shape(node, keys) {
    ensure(node && typeof node === 'object' && !Array.isArray(node));
    const allowed = keys.split(' ');
    ensure(Object.keys(node).every((key) => node[key] == null || allowed.includes(key)));
}

function list(nodes, render, delimiter = ', ') {
    ensure(Array.isArray(nodes));
    return nodes.map(render).join(delimiter);
}

const scalarFunctions = {
    mysql: 'abs ceil ceiling floor round power sqrt mod coalesce ifnull nullif greatest least concat concat_ws lower upper length char_length replace reverse trim ltrim rtrim left right substr substring date year month day hour minute second date_format datediff now',
    postgres: 'abs ceil ceiling floor round power sqrt mod coalesce nullif greatest least concat concat_ws lower upper length char_length replace reverse trim ltrim rtrim btrim left right substr substring date_part date_trunc now',
    sqlite: 'abs ceil ceiling floor round power pow sqrt mod coalesce ifnull nullif lower upper length replace trim ltrim rtrim substr substring date time datetime strftime julianday unixepoch typeof instr min max string_agg',
};
const aggregates = {
    mysql: 'count sum avg min max group_concat stddev_pop stddev_samp var_pop var_samp',
    postgres: 'count sum avg min max string_agg stddev_pop stddev_samp var_pop var_samp',
    sqlite: 'count sum avg min max total group_concat string_agg',
};
const pgSyntaxFunctions = new Set(['coalesce', 'nullif', 'greatest', 'least', 'trim', 'substring']);
const dateKeywords = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP']);
const binaryOperators = new Set(['+', '-', '*', '/', '%', '=', '!=', '<>', '>', '>=', '<', '<=', 'AND', 'OR',
    'IS', 'IS NOT', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', '||', '&', '|', '^', '<<', '>>', '->', '->>', '#>', '#>>']);
const joins = new Set(['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN',
    'FULL OUTER JOIN', 'CROSS JOIN', 'NATURAL JOIN', 'NATURAL LEFT JOIN', 'NATURAL RIGHT JOIN', 'NATURAL INNER JOIN']);
const pgCastTypes = new Map(Object.entries({
    BOOL: 'bool', BOOLEAN: 'bool', SMALLINT: 'int2', INT: 'int4', INTEGER: 'int4', BIGINT: 'int8', DECIMAL: 'numeric',
    NUMERIC: 'numeric', REAL: 'float4', 'DOUBLE PRECISION': 'float8', CHAR: 'bpchar', VARCHAR: 'varchar',
    'CHARACTER VARYING': 'varchar', TEXT: 'text', DATE: 'date', TIMESTAMP: 'timestamp', TIME: 'time',
    'TIMESTAMP WITHOUT TIME ZONE': 'timestamp', 'TIMESTAMP WITH TIME ZONE': 'timestamptz',
    'TIME WITHOUT TIME ZONE': 'time', 'TIME WITH TIME ZONE': 'timetz', JSON: 'json', JSONB: 'jsonb',
}));
const castTypes = {
    mysql: new Set(['SIGNED', 'SIGNED INTEGER', 'UNSIGNED', 'UNSIGNED INTEGER', 'DECIMAL', 'CHAR', 'NCHAR', 'BINARY', 'DATE', 'DATETIME', 'TIME', 'JSON', 'FLOAT', 'DOUBLE', 'REAL']),
    sqlite: new Set(['INTEGER', 'INT', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'BIGINT', 'CHAR', 'VARCHAR', 'BOOLEAN', 'DATE', 'DATETIME']),
};

/** Parse and serialize only the AST subset whose database behavior is known. */
export function authorizeQuery(sql, { engine, database, tables, references }) {
    const dialect = dialects.get(engine);
    ensure(dialect && typeof sql === 'string' && !sql.includes('\0') && Array.isArray(tables));
    const postgres = engine === 'postgres';
    const mysql = engine === 'mysql';
    const quote = mysql ? '`' : '"';
    const quoteId = (value) => {
        ensure(typeof value === 'string' && value.length > 0 && !value.includes('\0'));
        if (postgres) ensure(Buffer.byteLength(value, 'utf8') <= 63);
        return quote + value.replaceAll(quote, quote.repeat(2)) + quote;
    };
    // The parser drops the quoted/unquoted distinction for relation names and treats doubled
    // identifier quotes as two identifiers. Placeholders keep spelling and token boundaries intact.
    let prefix = 'dshpolicytoken';
    while (fold(sql).includes(prefix)) prefix += 'x';
    const tokens = new Map();
    const scanned = scanSql(sql, engine, (token) => {
        ensure(!word(token.previous) && token.previous !== '&');
        if (token.kind === 'literal') {
            // Backslash escaping in MySQL/PostgreSQL can change with connection settings.
            ensure(token.quote !== '"' && (!mysql && !postgres || !token.value.includes('\\')));
        }
        const key = prefix + tokens.size;
        tokens.set(key, token);
        return token.kind === 'identifier' ? `${quote}${key}${quote}` : `'${key}'`;
    });
    if (engine === 'sqlite') ensure(!scanned.clean.includes('#'));
    if (postgres) ensure(!/#(?!>)/.test(scanned.clean));
    let input = scanned.sql.trim();
    if (/^(?:show|describe|desc|pragma)\b/i.test(input) || /^explain\s+(?:query\s+plan\s+)?pragma\b/i.test(input)) {
        throw new Error('sql_query 只接受 SELECT；请使用 sql_schema 查看目录和表结构。');
    }
    const explain = '';
    if (/^explain\b/i.test(input)) throw new Error('sql_query 不接受 EXPLAIN 作为问题答案，请执行 SELECT 查询。');
    ensure(/^(?:select|with)\b/i.test(input));
    const noTrailingTerminator = scanned.clean.trim().replace(/;$/, '');
    ensure(!noTrailingTerminator.includes(';'));
    let ast;
    try {
        ast = parser.astify(input, { database: dialect });
    } catch {
        throw new Error('sql_query 无法解析此 SQL，请检查当前数据库方言和只读查询语法。');
    }
    if (Array.isArray(ast)) {
        ensure(ast.length === 1);
        [ast] = ast;
    }

    function identifier(value) {
        if (typeof value === 'object') {
            shape(value, 'type value');
            ensure(['default', 'double_quote_string', 'backticks_quote_string'].includes(value.type));
            value = value.value;
        }
        ensure(typeof value === 'string');
        const original = tokens.get(value);
        if (original) {
            ensure(original.kind === 'identifier');
            return original.value;
        }
        ensure(/^[\p{L}_][\p{L}\p{N}_$]*$/u.test(value));
        return postgres ? fold(value) : value;
    }

    const sqlIdentifier = (value) => quoteId(identifier(value));
    const cteKey = (value) => postgres ? value : fold(value);
    const schemaMatches = (left, right) => engine === 'sqlite' ? fold(left) === fold(right) : left === right;
    const defaultSchema = mysql ? database : postgres ? 'public' : 'main';

    function relation(node, scope) {
        const name = identifier(node.table);
        const local = scope.get(cteKey(name));
        if (node.db == null && local !== undefined) return quoteId(local);
        const schema = node.db == null ? defaultSchema : identifier(node.db);
        ensure(typeof schema === 'string' && schema.length > 0);
        if ((!postgres && !schemaMatches(schema, defaultSchema ?? '')) ||
            (postgres && (schema.startsWith('pg_') || schema === 'information_schema')) ||
            (engine === 'sqlite' && fold(name).startsWith('sqlite_'))) {
            throw new Error('sql_query 不接受当前数据源范围以外的关系。');
        }
        const matches = tables.filter((table) => typeof table.name === 'string' &&
            schemaMatches(table.name, name) && schemaMatches(table.schema || defaultSchema, schema));
        const target = matches[0];
        if (matches.length !== 1 || target.enabled !== true || target.tableKind !== 'table') {
            throw new Error('sql_query 只允许读取目录中已启用的普通表，请用 sql_schema 查看可用表。');
        }
        if (Array.isArray(references) && !references.some(table => table.id === target.id)) references.push({ ...target, schema: target.schema || defaultSchema });
        // ONLY prevents implicit reads of unapproved PostgreSQL inheritance children.
        return (postgres ? 'ONLY ' : '') + quoteId(target.schema || defaultSchema) + '.' + quoteId(target.name);
    }

    function projection(node, scope) {
        shape(node, 'type expr as');
        ensure(node.type == null || node.type === 'expr');
        return expression(node.expr, scope) + (node.as == null ? '' : ' AS ' + sqlIdentifier(node.as));
    }

    function order(nodes, scope) {
        return list(nodes, (node) => {
            shape(node, 'expr type nulls');
            ensure(node.type == null || ['ASC', 'DESC'].includes(node.type));
            ensure(node.nulls == null || (postgres && ['NULLS FIRST', 'NULLS LAST'].includes(node.nulls)));
            return [expression(node.expr, scope), node.type, node.nulls].filter(Boolean).join(' ');
        });
    }

    function subquery(node, scope) {
        shape(node, 'tableList columnList ast parentheses');
        return '(' + select(node.ast, scope) + ')';
    }

    function from(nodes, scope) {
        return list(nodes, (node, index) => {
            shape(node, 'db table as expr join on using');
            ensure(!(node.table != null && node.expr != null) && !(node.on != null && node.using != null));
            // The parser reports these join keywords as aliases in two dialects.
            const inferredJoin = !mysql && ['cross', 'natural'].includes(fold(node.as ?? '')) &&
                nodes[index + 1]?.join === 'INNER JOIN';
            let rendered = node.expr == null ? relation(node, scope) : subquery(node.expr, scope);
            if (node.as != null && !inferredJoin) rendered += ' AS ' + sqlIdentifier(node.as);
            if (node.join != null) {
                ensure(index > 0 && joins.has(node.join));
                const previousAlias = fold(nodes[index - 1].as ?? '');
                const join = !mysql && node.join === 'INNER JOIN' && ['cross', 'natural'].includes(previousAlias)
                    ? previousAlias.toUpperCase() + ' JOIN' : node.join;
                // PostgreSQL requires a qualifier for INNER JOIN. SQLite/MySQL accept it as a cross join.
                ensure(!postgres || join !== 'INNER JOIN' || node.on != null || node.using != null);
                ensure(join !== 'NATURAL JOIN' || (node.on == null && node.using == null));
                rendered = ' ' + join + ' ' + rendered;
            } else if (index > 0) {
                rendered = ', ' + rendered;
            }
            if (node.on != null) rendered += ' ON ' + expression(node.on, scope);
            if (node.using != null) rendered += ' USING (' + list(node.using, sqlIdentifier) + ')';
            return rendered;
        }, '');
    }

    function limit(node) {
        shape(node, 'seperator value');
        const values = [];
        list(node.value, (item) => {
            shape(item, 'type value');
            ensure(['number', 'bigint'].includes(item.type) && /^\d+$/.test(String(item.value)));
            values.push(item.value);
        });
        if (node.seperator === '' && values.length === 0 && postgres) return '';
        if (node.seperator === '' && values.length === 1) return ' LIMIT ' + values[0];
        if (node.seperator === 'offset' && values.length === 2) return ' LIMIT ' + values[0] + ' OFFSET ' + values[1];
        if (node.seperator === 'offset' && values.length === 1 && postgres) return ' OFFSET ' + values[0];
        if (node.seperator === ',' && values.length === 2 && !postgres) return ' LIMIT ' + values[1] + ' OFFSET ' + values[0];
        return unsupported();
    }

    function select(node, outer) {
        shape(node, 'type with distinct columns into from where groupby having orderby limit _next set_op parentheses');
        ensure(node.type === 'select');
        if (node.into != null) shape(node.into, '');
        const scope = new Map(outer);
        let header = '';
        if (node.with != null) {
            ensure(Array.isArray(node.with) && node.with.length > 0);
            const recursive = node.with[0].recursive === true;
            const names = new Map();
            for (const entry of node.with) {
                shape(entry, 'name stmt columns recursive');
                const name = identifier(entry.name);
                const key = cteKey(name);
                ensure(!names.has(key));
                names.set(key, name);
            }
            // SQLite can resolve forward references and self-references without RECURSIVE.
            if (engine === 'sqlite' || (postgres && recursive)) {
                for (const [key, name] of names) scope.set(key, name);
            }
            header = 'WITH ' + (recursive ? 'RECURSIVE ' : '') + list(node.with, (entry) => {
                const name = identifier(entry.name);
                const key = cteKey(name);
                if (mysql && recursive) scope.set(key, name);
                const body = entry.stmt?.ast ? subquery(entry.stmt, scope) : '(' + select(entry.stmt, scope) + ')';
                scope.set(key, name);
                const columns = entry.columns == null ? '' : '(' + list(entry.columns, (column) => {
                    ensure(column.type === 'column_ref' && column.table == null && column.column !== '*');
                    return expression(column, scope);
                }) + ')';
                return quoteId(name) + columns + ' AS ' + body;
            }) + ' ';
        }
        let distinct = node.distinct;
        if (distinct != null && typeof distinct === 'object') {
            shape(distinct, 'type columns');
            if (distinct.type === 'DISTINCT ON' && postgres) {
                distinct = 'DISTINCT ON (' + list(distinct.columns, (item) => projection(item, scope)) + ')';
            } else {
                ensure(distinct.columns == null && [null, 'DISTINCT'].includes(distinct.type));
                distinct = distinct.type;
            }
        } else {
            ensure(distinct == null || distinct === 'DISTINCT');
        }
        let result = header + 'SELECT ' + (distinct ? distinct + ' ' : '') + list(node.columns, (item) => projection(item, scope));
        if (node.from != null) result += ' FROM ' + from(node.from, scope);
        if (node.where != null) result += ' WHERE ' + expression(node.where, scope);
        if (node.groupby != null) {
            shape(node.groupby, 'columns modifiers');
            ensure(node.groupby.modifiers == null || node.groupby.modifiers.every((modifier) => modifier == null));
            result += ' GROUP BY ' + list(node.groupby.columns, (column) => expression(column, scope));
        }
        if (node.having != null) result += ' HAVING ' + expression(node.having, scope);
        if (node.orderby != null) result += ' ORDER BY ' + order(node.orderby, scope);
        if (node.limit != null) result += limit(node.limit);
        if (node._next != null) {
            ensure(['union', 'union all', 'union distinct'].includes(node.set_op));
            result += ' ' + node.set_op.toUpperCase() + ' ' + select(node._next, scope);
        }
        return node.parentheses === true ? '(' + result + ')' : result;
    }

    const scalar = new Set(scalarFunctions[engine].split(' '));
    const aggregate = new Set(aggregates[engine].split(' '));
    function call(node, scope) {
        shape(node, 'type name args parentheses');
        shape(node.name, 'name schema');
        ensure(Array.isArray(node.name.name) && node.name.name.length === 1);
        const token = node.name.name[0];
        shape(token, 'type value');
        ensure(['default', 'origin'].includes(token.type) && typeof token.value === 'string');
        const name = fold(token.value);
        const args = node.args;
        if (node.name.schema != null) ensure(postgres && identifier(node.name.schema) === 'pg_catalog');
        if (token.type === 'origin' && dateKeywords.has(token.value.toUpperCase()) && args == null) {
            ensure(node.name.schema == null);
            return token.value.toUpperCase();
        }
        shape(args, 'type value');
        ensure(args.type === 'expr_list' && Array.isArray(args.value));
        if (mysql && dateKeywords.has(token.value.toUpperCase()) && args.value.length === 0) {
            ensure(node.name.schema == null);
            return token.value.toUpperCase();
        }
        if (name === 'exists') {
            ensure(node.name.schema == null && args.value.length === 1 && args.value[0]?.ast);
            return 'EXISTS ' + subquery(args.value[0], scope);
        }
        if (name === 'not') {
            ensure(node.name.schema == null && args.value.length === 1);
            return '(NOT ' + expression(args.value[0], scope) + ')';
        }
        // Some dialect grammars represent multi-argument aggregates as ordinary calls.
        if (!scalar.has(name) && !aggregate.has(name)) throw new Error('sql_query 只允许使用白名单内置函数。');
        const builtin = postgres && !pgSyntaxFunctions.has(name) ? 'pg_catalog.' : '';
        if (node.name.schema != null) ensure(builtin !== '');
        return builtin + name + '(' + list(args.value, (argument) => expression(argument, scope)) + ')';
    }

    function aggregateCall(node, scope) {
        shape(node, 'type name args parentheses');
        const name = fold(node.name);
        ensure(aggregate.has(name));
        shape(node.args, 'expr distinct orderby separator');
        ensure(node.args.distinct == null || node.args.distinct === 'DISTINCT');
        const value = node.args.expr;
        let argumentsSql = value?.type === 'expr_list' ? expression(value, scope, true) : expression(value, scope);
        if (node.args.orderby != null && mysql) argumentsSql += ' ORDER BY ' + order(node.args.orderby, scope);
        if (node.args.separator != null) {
            const separator = node.args.separator;
            if (mysql && name === 'group_concat') {
                shape(separator, 'keyword value');
                ensure(separator.keyword.toUpperCase() === 'SEPARATOR' && separator.value?.type === 'single_quote_string');
                argumentsSql += ' SEPARATOR ' + expression(separator.value, scope);
            } else {
                shape(separator, 'symbol delimiter');
                ensure(postgres && name === 'string_agg' && separator.symbol === ',');
                argumentsSql += ', ' + expression(separator.delimiter, scope);
            }
        }
        if (node.args.orderby != null && !mysql) argumentsSql += ' ORDER BY ' + order(node.args.orderby, scope);
        return (postgres ? 'pg_catalog.' : '') + name + '(' + (node.args.distinct ? 'DISTINCT ' : '') + argumentsSql + ')';
    }

    function cast(node, scope) {
        shape(node, 'type keyword symbol expr target parentheses');
        ensure(node.keyword === 'cast' && ['as', '::'].includes(node.symbol) && node.target?.length === 1);
        const target = node.target[0];
        shape(target, 'dataType length scale parentheses suffix');
        ensure(target.suffix == null || (Array.isArray(target.suffix) && target.suffix.length === 0));
        ensure(postgres ? pgCastTypes.has(target.dataType) : castTypes[engine].has(target.dataType));
        let type = postgres ? 'pg_catalog.' + pgCastTypes.get(target.dataType) : target.dataType;
        if (target.length != null) {
            ensure(Number.isSafeInteger(target.length) && target.length >= 0);
            if (target.scale != null) ensure(Number.isSafeInteger(target.scale) && target.scale >= 0);
            type += '(' + [target.length, target.scale].filter((value) => value != null).join(', ') + ')';
        } else {
            ensure(target.scale == null);
        }
        return 'CAST(' + expression(node.expr, scope) + ' AS ' + type + ')';
    }

    function binary(node, scope) {
        shape(node, 'type operator left right parentheses');
        const operator = node.operator;
        const left = expression(node.left, scope);
        if (operator === 'BETWEEN' || operator === 'NOT BETWEEN') {
            shape(node.right, 'type value');
            ensure(node.right.type === 'expr_list' && node.right.value.length === 2);
            const [min, max] = node.right.value;
            return '(' + left + ' ' + operator + ' ' + expression(min, scope) + ' AND ' + expression(max, scope) + ')';
        }
        if (operator === 'IN' || operator === 'NOT IN') {
            shape(node.right, 'type value');
            ensure(node.right.type === 'expr_list' && node.right.value.length > 0);
            const [value] = node.right.value;
            const choices = value?.ast && node.right.value.length === 1
                ? subquery(value, scope) : '(' + list(node.right.value, (item) => expression(item, scope)) + ')';
            return '(' + left + ' ' + operator + ' ' + choices + ')';
        }
        ensure(binaryOperators.has(operator));
        return '(' + left + ' ' + operator + ' ' + expression(node.right, scope) + ')';
    }

    function expression(node, scope, unwrapped = false) {
        ensure(node && typeof node === 'object');
        if (node.ast) return subquery(node, scope);
        switch (node.type) {
            case 'column_ref': {
                shape(node, 'type db schema table column parentheses');
                let column = node.column;
                if (typeof column === 'object') {
                    shape(column, 'expr');
                    column = column.expr;
                }
                return [node.db ?? node.schema, node.table, column].filter((part) => part != null)
                    .map((part) => part === '*' ? '*' : sqlIdentifier(part)).join('.');
            }
            case 'number':
            case 'bigint':
                shape(node, 'type value parentheses');
                ensure(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(String(node.value)));
                return String(node.value);
            case 'backticks_quote_string':
            case 'double_quote_string':
                shape(node, 'type value parentheses');
                ensure(tokens.get(node.value)?.kind === 'identifier');
                return sqlIdentifier(node);
            case 'single_quote_string':
            case 'string': {
                shape(node, 'type value parentheses');
                const literal = tokens.get(node.value);
                ensure(literal?.kind === 'literal');
                return "'" + literal.value.replaceAll("'", "''") + "'";
            }
            case 'null':
                shape(node, 'type value parentheses');
                ensure(node.value === null);
                return 'NULL';
            case 'bool':
                shape(node, 'type value parentheses');
                ensure(typeof node.value === 'boolean');
                return node.value ? 'TRUE' : 'FALSE';
            case 'star':
                shape(node, 'type value');
                ensure(node.value === '*');
                return '*';
            case 'binary_expr':
                return binary(node, scope);
            case 'unary_expr':
                shape(node, 'type operator expr parentheses');
                ensure(['+', '-', '~', 'NOT', 'NOT EXISTS'].includes(node.operator));
                if (node.operator === 'NOT EXISTS') ensure(node.expr?.ast);
                return '(' + node.operator + ' ' + expression(node.expr, scope) + ')';
            case 'expr_list': {
                shape(node, 'type value parentheses');
                const values = list(node.value, (item) => expression(item, scope));
                return unwrapped ? values : '(' + values + ')';
            }
            case 'case':
                shape(node, 'type expr args parentheses');
                return 'CASE' + (node.expr == null ? '' : ' ' + expression(node.expr, scope)) + ' ' + list(node.args, (item) => {
                    shape(item, 'type cond result');
                    if (item.type === 'when') return 'WHEN ' + expression(item.cond, scope) + ' THEN ' + expression(item.result, scope);
                    ensure(item.type === 'else' && item.cond == null);
                    return 'ELSE ' + expression(item.result, scope);
                }, ' ') + ' END';
            case 'function':
                return call(node, scope);
            case 'aggr_func':
                return aggregateCall(node, scope);
            case 'cast':
                return cast(node, scope);
            case 'extract':
                shape(node, 'type args parentheses');
                shape(node.args, 'field source');
                ensure(/^(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND|QUARTER|WEEK|DOW|DOY|EPOCH)$/i.test(node.args.field));
                return 'EXTRACT(' + node.args.field + ' FROM ' + expression(node.args.source, scope) + ')';
            default:
                return unsupported();
        }
    }

    return explain + select(ast, new Map());
}
