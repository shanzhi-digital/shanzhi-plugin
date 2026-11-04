import { buildResultChart, isExplicitTableRequest, currentTurnText, numericMeasure, categoryDimension, cleanFollowUps, extractSqlResult } from './core.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const TABLE_KEYS = ['data', 'rows'];

function assertSuccess(value) {
  if (object(value) && (value.isError === true || value.error || value.success === false || value.status === 'error')) {
    throw new Error('来源工具返回失败，未生成图表。');
  }
}

/** JSON pointer is an explicit selector, never code or a prototype traversal. */
function select(value, pointer) {
  if (pointer === undefined || pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('resultPath 必须是 JSON Pointer，例如 /result/rows。');
  let current = value;
  for (const token of pointer.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !current || !own(current, key)) {
      throw new Error('resultPath 不存在或不是可读取的数据路径。');
    }
    current = current[key];
    assertSuccess(current);
  }
  return current;
}

function inferType(values) {
  const present = values.filter(value => value !== null && value !== undefined && value !== '');
  if (present.length && present.every(value => (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()) && !/^0\d+/.test(value.trim())))) return 'number';
  return 'string';
}

/** Accept common tabular JSON formats; preserve raw cells and reject ambiguous/nested data. */
export function normalizeTable(value) {
  assertSuccess(value);
  const rowArrays = TABLE_KEYS.map(key => value?.[key]).filter(Array.isArray);
  if (rowArrays.length > 1) throw new Error('结果包含多个行数组，请用 resultPath 选择唯一表格或对象数组。');
  const rawRows = Array.isArray(value) ? value : rowArrays[0];
  const rawColumns = Array.isArray(value?.columns) ? value.columns : Array.isArray(value?.fields) ? value.fields : null;
  if (!rawRows) throw new Error('结果不是行列数据；支持对象数组或 columns/fields 与 data/rows。');
  if (rawRows.length > 1000) throw new Error('结果超过 1000 行，请先在来源工具中分页或汇总。');
  let columns = rawColumns?.map(column => {
    if (typeof column === 'string') return { name: column, title: column };
    if (!object(column) || typeof (column.name ?? column.field) !== 'string') throw new Error('查询列缺少 name。');
    return { name: column.name ?? column.field, title: column.title ?? column.label ?? column.name ?? column.field,
      type: typeof column.type === 'string' ? column.type : undefined };
  });
  if (!columns) {
    if (!rawRows.length) throw new Error('空结果缺少列定义，请保留 columns/fields。');
    if (!rawRows.every(object)) throw new Error('二维数组必须提供 columns/fields。');
    columns = [...new Set(rawRows.flatMap(row => Object.keys(row)))].map(name => ({ name, title: name }));
  }
  if (!columns.length || columns.length > 100 || columns.some(column => !column.name || typeof column.title !== 'string') ||
    new Set(columns.map(column => column.name)).size !== columns.length) throw new Error('列名为空、重复或列数超过 100。');
  const data = rawRows.map(row => {
    if (!object(row) && !Array.isArray(row)) throw new Error('结果中存在非数据行。');
    if (Array.isArray(row) && row.length !== columns.length) throw new Error('行列数量不一致。');
    const entries = columns.map((column, i) => {
      const cell = Array.isArray(row) ? row[i] : own(row, column.name) ? row[column.name] : null;
      if (!scalar(cell) || (typeof cell === 'number' && !Number.isFinite(cell))) throw new Error('单元格必须是文字、数值、布尔或 null。');
      return [column.name, cell];
    });
    return Object.fromEntries(entries);
  });
  columns = columns.map(column => ({ ...column, type: column.type || inferType(data.map(row => row[column.name])) }));
  const count = value?.rowCount ?? value?.total ?? data.length;
  return { columns, data, rowCount: Number.isSafeInteger(count) && count >= data.length ? count : data.length,
    truncated: value?.truncated === true || count > data.length,
    offset: Number.isSafeInteger(value?.offset) && value.offset >= 0 ? value.offset : 0,
    limit: Number.isSafeInteger(value?.limit) && value.limit > 0 ? value.limit : data.length,
    ...(value?.datasourceId !== undefined ? { datasourceId: value.datasourceId } : {}) };
}

function candidates(message) {
  const roots = [];
  for (const value of [message.structuredContent, message.value?.structuredContent, message.value]) {
    if (value !== undefined) roots.push(value);
  }
  for (const block of message.content ?? []) {
    if (block.type !== 'text') continue;
    try { roots.push(JSON.parse(block.text)); } catch { /* Plain prose is not table data. */ }
  }
  // Some MCP transports repeat the same structured JSON as a text block.
  return [...new Map(roots.map(value => [JSON.stringify(value), value])).values()];
}

/** Source must be a completed call committed in this session's active turn. */
export function chartFromEvents(args, events) {
  const replacements = events.filter(event => event.surfaceOp?.op === 'replace');
  const surfaceTypes = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
  events = events.filter(event => !surfaceTypes.has(event.type) || !replacements.some(replacement =>
    replacement.seq > event.seq && event.seq >= replacement.surfaceOp.startSeq && event.seq <= replacement.surfaceOp.endSeq));
  if (!isExplicitTableRequest(events)) throw new Error('仅支持用户本轮明确要求问表或图表。');
  const start = events.findLastIndex(event => event.type === 'turn/start');
  const active = events.slice(start + 1);
  if (!args.sourceCallId) {
    const eligible = active.filter(event => event.type === 'tool/call' && !['query_result_chart', 'datahub_chart'].includes(event.data?.name))
      .filter(call => {
        const results = active.filter(event => event.type === 'tool/result' && event.seq > call.seq && event.surfaceOp === 'append' &&
          (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === call.data.callId);
        if (results.length !== 1 || results[0].data.error || results[0].data.message?.isError) return false;
        return candidates(results[0].data.message).some(root => {
          try { assertSuccess(root); normalizeTable(select(root, args.resultPath)); return true; } catch { return false; }
        });
      });
    if (eligible.length !== 1) throw new Error(eligible.length
      ? `本轮有多个表格来源，请指定 sourceCallId：${eligible.map(call => `${call.data.name}: ${call.data.callId}`).join('；')}`
      : '本轮没有唯一可识别的已完成表格结果，请先查询或指定 sourceCallId 与 resultPath。');
    args = { ...args, sourceCallId: eligible[0].data.callId };
  }
  const calls = active.filter(event => event.type === 'tool/call' &&
    (event.data?.callId === args.sourceCallId || event.data?.callId?.split('|')[0] === args.sourceCallId));
  if (calls.length !== 1 || ['query_result_chart', 'datahub_chart'].includes(calls[0].data.name)) {
    throw new Error('sourceCallId 必须引用当前回合的一个真实查询工具调用。');
  }
  const call = calls[0];
  args = { ...args, sourceCallId: call.data.callId };
  const results = active.filter(event => event.type === 'tool/result' && event.seq > call.seq && event.surfaceOp === 'append' &&
    (event.data?.message?.source?.callId ?? event.data?.message?.toolCallId) === args.sourceCallId);
  if (results.length !== 1) throw new Error('来源工具尚未成功完成或结果不唯一。');
  const result = results[0];
  const message = result.data.message;
  if (message.isError || result.data.error) throw new Error('来源工具执行失败，未生成图表。');
  const roots = candidates(message);
  const tables = [];
  for (const root of roots) {
    // Never salvage rows from an error envelope.
    assertSuccess(root);
    const selected = select(root, args.resultPath);
    try { tables.push({ root, raw: selected, table: normalizeTable(selected) }); } catch (error) {
      if (roots.length === 1) throw error;
    }
  }
  if (tables.length !== 1) throw new Error('未找到唯一的表格结果，请用 resultPath 指定实际数据路径。');
  const table = tables[0].table;
  const byName = new Map(table.columns.map(column => [column.name, column]));
  if (args.dimension !== undefined && (!byName.has(args.dimension) || !categoryDimension(byName.get(args.dimension)))) {
    throw new Error('dimension 必须是存在的文字或时间列，不能是编号等标识列。');
  }
  if (args.measures !== undefined && (!Array.isArray(args.measures) || !args.measures.length ||
    args.measures.some(name => !byName.has(name) || !numericMeasure(byName.get(name)) || name === args.dimension))) {
    throw new Error('measures 必须是存在的数值指标列名，不能是标识列或维度。');
  }
  if (cleanFollowUps(args.followUps).length !== 3) throw new Error('请提供 3 条不同且完整的跟问建议。');
  const chart = buildResultChart(args, table, currentTurnText(events));
  let input;
  try { input = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments; } catch { input = {}; }
  if (call.data.name === 'mcp__datahub-ask-data__execute_semantic_sql') {
    const semantic = extractSqlResult({ value: tables[0].root });
    if (typeof input?.sql !== 'string' || String(semantic.datasourceId) !== String(input?.datasourceId) || semantic.semanticSql !== input.sql) {
      throw new Error('返回数据源或 SQL 与 DataHub 查询请求不一致，未生成图表。');
    }
  }
  const sql = input?.sql ?? input?.query ?? tables[0].raw?.semanticSql ?? tables[0].raw?.sql;
  const source = { toolName: call.data.name, callId: args.sourceCallId, resultSeq: result.seq,
    ...(typeof sql === 'string' ? { sql } : {}) };
  return { ...chart, source };
}
