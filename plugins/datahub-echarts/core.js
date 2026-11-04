export function isExplicitTableRequest(events) {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return false;
    if (events[i].type === 'turn/start') { start = i; break; }
  }
  if (start < 0) return false;
  const messages = events.slice(start + 1).filter((event) => event.type === 'user/message');
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = (Array.isArray(messages[i].data?.content) ? messages[i].data.content : [])
      .filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
    if (/(?:不要|不需要|不必|别|无需).{0,8}(?:问表|查表|表格|图表|柱状图|折线图|饼图)/u.test(text)) return false;
    if (/(?:开发|实现|调试|安装|设计|修复|介绍|如何|怎么).{0,15}(?:问表|图表).{0,8}(?:插件|功能|工具)/u.test(text)) continue;
    if (/问表|查表|做个表|(?:用|以|生成|制作|列出|展示|显示|给我|来个|画|绘制).{0,12}(?:表格|图表|柱状图|折线图|饼图)|(?:表格|图表|柱状图|折线图|饼图).{0,8}(?:展示|显示|呈现|输出)/u.test(text)) return true;
  }
  return false;
}

export function extractSqlResult(outcome) {
  if (!outcome || outcome.isError) throw new Error('语义 SQL 查询失败，未生成图表。');
  let value = outcome.value?.structuredContent ?? outcome.value;
  // MCP implementations may return either a direct JSON result or text content.
  if (!(value && Array.isArray(value.columns) && Array.isArray(value.data))) {
    const blocks = [...(Array.isArray(outcome.content) ? outcome.content : []), ...(Array.isArray(value?.content) ? value.content : [])];
    if (blocks.length) {
      const parsed = [...new Set(blocks.filter((b) => b.type === 'text').map((b) => b.text))].map((text) => {
        try { return JSON.parse(text); } catch { return null; }
      }).filter((x) => x && Array.isArray(x.columns) && Array.isArray(x.data));
      if (parsed.length === 1) value = parsed[0];
    }
  }
  if (!value || !Array.isArray(value.columns) || !Array.isArray(value.data) || value.queryKind !== 'SEMANTIC_SQL') {
    throw new Error('查询结果无法确认来源或结构，未生成图表。');
  }
  return value;
}

export function finiteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) return null;
  if (typeof value === 'string' && Math.abs(number) === Number.MAX_SAFE_INTEGER) {
    // A decimal just beyond the safe boundary can round back to MAX_SAFE_INTEGER.
    const parts = value.trim().match(/^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (parts) {
      const digits = parts[1] + (parts[2] || '');
      const decimalPoint = parts[1].length + Number(parts[3] || 0);
      if (/[1-9]/.test(digits.slice(Math.max(0, decimalPoint)))) return null;
    }
  }
  return number;
}

const NUMERIC_TYPE = /(?:number|int|decimal|float|double|numeric|real)/i;
const ID_LIKE = /(?:^id$|_id$|_no$|Id$|ID$)/;
const ID_TITLE = /编号|学号|身份证|证件|工号/u;
/** Trailing words that decorate a measure title without changing what it counts. */
const MEASURE_DECORATION = /(?:合计|总计|总数|数量|总|值)$/u;

export function numericMeasure(column) {
  return NUMERIC_TYPE.test(column?.type || '') && !ID_LIKE.test(column?.name || '') &&
    !ID_TITLE.test(`${column?.title || ''}${column?.name || ''}`);
}

export function categoryDimension(column) {
  return !NUMERIC_TYPE.test(column?.type || '') && !ID_LIKE.test(column?.name || '') &&
    !ID_TITLE.test(`${column?.title || ''}${column?.name || ''}`);
}

/** The user text of the turn in progress, used to read which metric and chart were asked for. */
export function currentTurnText(events) {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') return '';
    if (events[i].type === 'turn/start') { start = i; break; }
  }
  if (start < 0) return '';
  return events.slice(start + 1).filter((event) => event.type === 'user/message')
    .flatMap((event) => Array.isArray(event.data?.content) ? event.data.content : [])
    .filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
}

/** Strip decoration so "已报名人数合计" can answer a question that says "报名人数". */
function measureStem(column) {
  let stem = `${column?.title || ''}`.trim();
  while (MEASURE_DECORATION.test(stem)) stem = stem.replace(MEASURE_DECORATION, '');
  return stem.replace(/^(?:已|共|累计|总计|总)/u, '').trim();
}

function namesMeasure(column, question) {
  const stems = [measureStem(column), column?.name || ''].filter((stem) => stem.length >= 2);
  return stems.some((stem) => question.includes(stem));
}

/** Chart type the question itself asks for; an explicit argument still wins. */
export function inferChartType(question) {
  if (/饼图|占比|构成|比例|分布|份额/u.test(question)) return 'pie';
  if (/趋势|走势|变化|月度|每月|逐月|逐日|按天|时间线/u.test(question)) return 'line';
  return 'bar';
}

/** Measures the question names, ordered as the question does; empty when it names none. */
function measuresFromQuestion(columns, question) {
  return columns.filter(numericMeasure)
    .filter((column) => namesMeasure(column, question))
    .sort((left, right) => question.indexOf(measureStem(left)) - question.indexOf(measureStem(right)))
    .map((column) => column.name);
}

export function buildChart(args, result, question = '') {
  if (String(result.datasourceId) !== String(args.datasourceId) || result.semanticSql !== args.sql) {
    throw new Error('返回数据源或 SQL 与请求不一致，未生成图表。');
  }
  return buildResultChart(args, result, question);
}

/** Renderer shared by DataHub and tabular results from other query tools. */
export function buildResultChart(args, result, question = '') {
  const columns = result.columns;
  const byName = new Map(columns.map((column) => [column.name, column]));
  const names = new Set(columns.map((column) => column.name));
  const hasValue = result.data.length > 0;

  const requestedMeasures = (Array.isArray(args.measures) ? args.measures : []).filter((name) => {
    const column = byName.get(name);
    return column && name !== args.dimension && numericMeasure(column);
  });
  const requestedDimension = typeof args.dimension === 'string' && names.has(args.dimension) &&
    categoryDimension(byName.get(args.dimension)) && !requestedMeasures.includes(args.dimension);

  // Precedence: what the caller declared, then what the question names, then the first numeric column.
  const numericColumns = columns.filter(numericMeasure).map((column) => column.name);
  const named = measuresFromQuestion(columns, question).filter((name) => name !== args.dimension);
  const measures = requestedMeasures.length > 0 ? requestedMeasures
    : named.length > 0 ? named : numericColumns.slice(0, 1);
  const nonNumeric = columns.filter(categoryDimension).map((column) => column.name);
  const dimension = requestedDimension ? args.dimension : nonNumeric[0] ?? null;

  const chartType = args.chartType === 'line' || args.chartType === 'pie' || args.chartType === 'bar'
    ? args.chartType : inferChartType(question);
  // A pie shows the share of one measure; more than one measure would misrepresent the whole.
  const plottedMeasures = chartType === 'pie' ? measures.slice(0, 1) : measures;
  const invalidPie = chartType === 'pie' && plottedMeasures.length > 0 &&
    (result.data.some(row => (finiteNumber(row[plottedMeasures[0]]) ?? 0) < 0) ||
      !result.data.some(row => (finiteNumber(row[plottedMeasures[0]]) ?? 0) > 0));
  const canChart = hasValue && dimension !== null && plottedMeasures.length > 0 && !invalidPie &&
    result.data.some((row) => plottedMeasures.some((name) => finiteNumber(row[name]) !== null));

  const reason = !hasValue ? '查询没有返回数据。' : canChart ? '' :
    invalidPie ? '结果含负数或全部为零，无法呈现有效占比，已保留原始表格。' :
    dimension === null ? '结果只有数值列，没有可作类别的维度，已保留原始表格。'
      : plottedMeasures.length === 0 ? '结果没有可绘制的数值指标，已保留原始表格。'
        : '结果中的数值为空或超出安全精度，已保留原始表格。';

  const followUps = cleanFollowUps(args.followUps);
  // A rejected share can still be a valid bar/line chart when the user switches views.
  const switchable = canChart || (hasValue && invalidPie && dimension !== null &&
    result.data.some(row => plottedMeasures.some(name => finiteNumber(row[name]) !== null)));

  return {title: args.title, datasourceId: result.datasourceId, columns, data: result.data,
    rowCount: result.rowCount ?? result.data.length, truncated: result.truncated === true, offset: result.offset ?? 0, limit: result.limit ?? result.data.length,
    dimension: switchable ? dimension : null, measures: switchable ? plottedMeasures : [], chartType,
    defaultView: canChart ? chartType : 'table', reason, followUps};
}

/** At most three short, non-duplicate follow-up questions the user can pick up next. */
export function cleanFollowUps(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const text = entry.replace(/\s+/gu, ' ').trim();
    if (text.length < 4 || text.length > 80) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === 3) break;
  }
  return out;
}
