import { randomUUID } from 'node:crypto';
import { isExplicitTableRequest, extractSqlResult, buildChart, currentTurnText, cleanFollowUps } from './core.js';
import { chartFromEvents } from './results.js';

export const inject = ['tools', 'sessions', 'systemPrompt'];
const SQL_TOOL = 'mcp__datahub-ask-data__execute_semantic_sql';
const text = (value) => [{type:'text', text: JSON.stringify(value)}];

export function apply(ctx) {
  ctx.systemPrompt.section({name:'datahub-echarts', order: 950,
    text:[
      '当用户本轮明确要求问表、表格或图表时，优先用 query_result_chart 呈现本轮已完成查询工具的真实行列结果，唯一表格来源时可省略 sourceCallId，多个来源时按候选调用 ID 选择；不要复制或编造数据行，不要为了出图重复查询。支持 DataHub、其他数据库 MCP、API 或已解析成 JSON 行列的 CSV 工具结果。',
      'query_result_chart 不执行 SQL；SQL 只作为来源说明，图表使用来源工具返回的真实行列值。嵌套结果用 resultPath（JSON Pointer，例如 /result）选择唯一表格；来源须在当前会话当前回合内成功完成。',
      '需要查询 DataHub 时先按数据源技能核实公开视图、字段和统计口径；已有结果用 query_result_chart，尚未查询时也可用兼容入口 datahub_chart 执行最终语义 SQL 并渲染。',
      '交付时的呈现规则：',
      '- 指标按用户原话挑选：用户说“报名人数”就选标题含报名人数的数值列，说“志愿时长”就选时长列；用户比较多个指标时才传多个 measures。不要因为列顺序靠前就默认第一列。',
      '- 类别维度选文字列（如活动类别、区县、月份），不要用编号、学号、身份证这类标识列作图。',
      '- 图型：占比、构成、比例、分布用 pie；按月/按日等时间趋势用 line；其余类别对比用 bar。',
      '- dimension、measures、chartType 都可省略，插件会按用户原话与真实列自动识别；但用户点名了指标或图型时，显式传入以免误判。',
      '- 纯文本明细、只有一个数值、或结果为空时不必强作图，省略这些字段并交付真实表格。',
      '- 每次交付都给出 3 条 followUps 跟问建议：站在用户视角的完整问句（不是短语），要基于这次的真实结果来问，例如追问排名首位/末位的明细、换成另一个维度或指标、补一个时间范围；三条之间不要重复、不要与刚才的问法雷同。'
    ].join('\n')});
  ctx.tools.register({
    name: 'query_result_chart',
    description: '把当前回合已成功完成的任意查询工具真实结果渲染为 ECharts 图表卡片（附表格和跟问）。只读取当前会话日志中的结果，不执行 SQL，不接收模型自填数据。仅在用户明确要求问表、表格或图表时使用。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sourceCallId: { type: 'string', description: '当前回合已完成查询工具的真实调用 ID。只有一个可识别表格来源时可省略；有多个时按错误返回的候选 ID 指定。' },
      resultPath: { type: 'string', description: '可选 JSON Pointer，在工具返回 JSON 中选择表格对象或对象数组，如 /result；默认使用根结果。' },
      title: { type: 'string', description: '用业务语言概括结果的标题。' },
      dimension: { type: 'string', description: '类别或时间列名；选择文字或时间列，不能选择编号等标识列。' },
      measures: { type: 'array', items: { type: 'string' }, description: '用户点名的数值指标列名；只在比较多个指标时传多列。' },
      chartType: { type: 'string', enum: ['bar', 'line', 'pie'], description: '类别对比 bar，时间趋势 line，占比构成 pie；省略时按用户原话识别。' },
      followUps: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: '基于真实结果的 3 条不同完整跟问句。' }
    }, required: ['title', 'followUps'] },
    output: { schema: { type: 'object', additionalProperties: true }, render(_args, value) { return text(value); } },
    async execute(args, exec) {
      if (!exec.agent?.id) throw new Error('未找到当前会话。');
      const session = ctx.sessions.get(exec.agent.id);
      if (!session) throw new Error('未找到当前会话。');
      return chartFromEvents(args, session.snapshotEvents());
    }
  });
  ctx.tools.register({
    name:'datahub_chart',
    description:[
      '执行最终交付的 DataHub 语义 SQL，并把真实结果渲染为图表卡片（附数据表）；仅在用户本轮明确要求问表、表格或图表时使用。',
      '遇到“按某类统计/对比”这类一维类别加数值的结果，应选好指标并出图，不要只交表格。'
    ].join(''),
    parameters:{type:'object',additionalProperties:false,properties:{
      datasourceId:{type:'string',description:'已授权数据源 ID。'},
      sql:{type:'string',description:'面向公开 View 的最终语义 SQL。'},
      title:{type:'string',description:'结果标题，用业务语言概括这张图表在讲什么。'},
      dimension:{type:'string',description:'类别或时间轴列名，选文字/时间列；省略时自动取第一个非数值列。'},
      measures:{type:'array',items:{type:'string'},description:'要画的数值列名，按用户点名的指标选；省略时优先匹配用户原话中的列名。饼图只用第一个指标。'},
      chartType:{type:'string',enum:['bar','line','pie'],description:'可选；占比构成用 pie，时间趋势用 line，类别对比用 bar。省略时按用户原话推断。'},
      followUps:{type:'array',items:{type:'string'},maxItems:3,description:'3 条跟问建议，显示在图表下方供用户点选；须是完整问句并基于本次真实结果，不要重复。'},
      limit:{type:'integer',minimum:1,maximum:1000,description:'查询行数上限，默认 100。'},
      offset:{type:'integer',minimum:0,description:'查询偏移量，默认 0。'}
    },required:['datasourceId','sql','title']},
    output:{schema:{type:'object',additionalProperties:true},render(_args,value){return text(value);}},
    async execute(args,exec) {
      if (!exec.agent || !exec.agent.id) throw new Error('未找到当前会话。');
      const session = ctx.sessions.get(exec.agent.id);
      const events = session?.snapshotEvents() ?? [];
      if (!session || !isExplicitTableRequest(events)) throw new Error('仅支持用户本轮明确要求问表或图表。');
      if (cleanFollowUps(args.followUps).length !== 3) throw new Error('请提供 3 条不同且完整的跟问建议。');
      if (!ctx.tools.get(SQL_TOOL,exec.agent)) throw new Error('当前会话未授权 DataHub 语义 SQL 工具。');
      const query = {datasourceId:args.datasourceId,sql:args.sql,limit:args.limit ?? 100,offset:args.offset ?? 0};
      const outcome = await ctx.tools.execute({name:SQL_TOOL,arguments:query,agent:exec.agent,signal:exec.signal,
        callId:`datahub-chart-${randomUUID()}`,rootCallId:exec.rootCallId,parent:exec.token});
      const result = extractSqlResult(outcome);
      return buildChart(args,result,currentTurnText(events));
    }
  });
}
