import { randomUUID } from 'node:crypto';
import { canPresentResults, extractSqlResult, buildChart, currentTurnText, cleanFollowUps } from './core.js';
import { chartFromEvents } from './results.js';

export const inject = ['tools', 'sessions', 'systemPrompt'];
const SQL_TOOL = 'mcp__datahub-ask-data__execute_semantic_sql';
const text = (value) => [{type:'text', text: JSON.stringify(value)}];

export function apply(ctx) {
  ctx.systemPrompt.section({name:'datahub-echarts', order: 950,
    text:[
      '每次问数取得用于回答用户的最终业务行列结果后，都应调用 query_result_chart 展示真实结果，默认生成表格，无需用户额外要求问表、表格或图表。列数据源、读取模型和字段等准备操作不生成卡片；用户明确只要文字、不用表格时尊重其要求。唯一表格来源可省略 sourceCallId，多个来源选择本次最终业务查询调用 ID；不要复制或编造数据行，不要为展示重复查询。支持 DataHub、其他数据库 MCP、API 或已解析成 JSON 行列的 CSV 工具结果。',
      'query_result_chart 不执行 SQL；SQL 只作为来源说明，图表使用来源工具返回的真实行列值。嵌套结果用 resultPath（JSON Pointer，例如 /result）选择唯一表格；来源须在当前会话当前回合内成功完成。',
      '需要查询 DataHub 时先按数据源技能核实公开视图、字段和统计口径；已有结果用 query_result_chart，尚未查询时也可用兼容入口 datahub_chart 执行最终语义 SQL 并渲染。',
      '交付时的呈现规则：',
      '- 指标按用户原话挑选：用户说“报名人数”就选标题含报名人数的数值列，说“志愿时长”就选时长列；用户比较多个指标时才传多个 measures。不要因为列顺序靠前就默认第一列。',
      '- 类别维度选文字列（如活动类别、区县、月份），不要用编号、学号、身份证这类标识列作图。',
      '- 普通问数默认表格，省略 chartType，即使提到占比、趋势、排名也不自动出图。用户明确要求画图或图表时才传 chartType：占比 pie，时间趋势 line，其余类别对比 bar；明确要求表格或不要图表时保持表格。',
      '- dimension、measures 可省略，插件按用户原话与真实列自动识别，保留手动切换图表的能力；用户点名了指标时可显式传入。',
      '- 纯文本明细、只有一个数值、或结果为空时不必强作图，省略这些字段并交付真实表格。',
      '- 插件成功承载结果数据后，正文仅补充结论、统计口径和建议，不再重复输出完整 Markdown 表格，也不要在正文另列跟问建议；插件展示失败时才允许用普通表格兜底。',
      '- 同次交付包含多份结果时，每份使用简短的中文业务标题；中间结果可省略 followUps，最后一份结果提供覆盖整体的 3 条 followUps。单份结果也应提供 3 条 followUps。',
      '- followUps 站在用户视角写成完整问句（不是短语），基于真实结果提出下一步问题，例如追问排名首位/末位的明细、换成另一个维度或指标、补一个时间范围；三条之间不要重复、不要与刚才的问法雷同。'
    ].join('\n')});
  ctx.tools.register({
    name: 'query_result_chart',
    description: '问数取得最终业务行列结果后调用，默认生成表格卡片并提供图表切换和跟问，无需用户明确要求表格。只读取当前会话当前回合已成功完成的查询结果，不执行 SQL，不接收模型自填数据；不用于列数据源、读模型和字段等准备操作。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      sourceCallId: { type: 'string', description: '当前回合已完成查询工具的真实调用 ID。只有一个可识别表格来源时可省略；有多个时按错误返回的候选 ID 指定。' },
      resultPath: { type: 'string', description: '可选 JSON Pointer，在工具返回 JSON 中选择表格对象或对象数组，如 /result；默认使用根结果。' },
      title: { type: 'string', description: '用业务语言概括结果的标题。' },
      dimension: { type: 'string', description: '类别或时间列名；选择文字或时间列，不能选择编号等标识列。' },
      measures: { type: 'array', items: { type: 'string' }, description: '用户点名的数值指标列名；只在比较多个指标时传多列。' },
      chartType: { type: 'string', enum: ['bar', 'line', 'pie'], description: '普通问数省略以默认显示表格；仅用户明确要求绘图时传入，类别对比 bar，时间趋势 line，占比 pie。' },
      followUps: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: '可选；传入时须为基于真实结果的 3 条不同完整跟问句。多份结果仅最后一份提供覆盖整体的跟问。' }
    }, required: ['title'] },
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
      '执行尚未执行的最终 DataHub 语义 SQL，并将真实业务结果默认为表格卡片。',
      '已有成功查询结果时必须使用 query_result_chart 复用，不要走此入口重复查询；明确要求绘图时才指定 chartType。'
    ].join(''),
    parameters:{type:'object',additionalProperties:false,properties:{
      datasourceId:{type:'string',description:'已授权数据源 ID。'},
      sql:{type:'string',description:'面向公开 View 的最终语义 SQL。'},
      title:{type:'string',description:'结果标题，用业务语言概括这张图表在讲什么。'},
      dimension:{type:'string',description:'类别或时间轴列名，选文字/时间列；省略时自动取第一个非数值列。'},
      measures:{type:'array',items:{type:'string'},description:'要画的数值列名，按用户点名的指标选；省略时优先匹配用户原话中的列名。饼图只用第一个指标。'},
      chartType:{type:'string',enum:['bar','line','pie'],description:'普通问数省略以默认显示表格；仅用户明确要求绘图时传入 bar、line 或 pie。'},
      followUps:{type:'array',items:{type:'string'},minItems:3,maxItems:3,description:'可选；传入时须为基于真实结果的 3 条不同完整跟问句，显示在图表下方。多份结果仅最后一份提供覆盖整体的跟问。'},
      limit:{type:'integer',minimum:1,maximum:1000,description:'查询行数上限，默认 100。'},
      offset:{type:'integer',minimum:0,description:'查询偏移量，默认 0。'}
    },required:['datasourceId','sql','title']},
    output:{schema:{type:'object',additionalProperties:true},render(_args,value){return text(value);}},
    async execute(args,exec) {
      if (!exec.agent || !exec.agent.id) throw new Error('未找到当前会话。');
      const session = ctx.sessions.get(exec.agent.id);
      const events = session?.snapshotEvents() ?? [];
      if (!session || !canPresentResults(events)) throw new Error('仅支持当前未结束回合，且用户未要求仅文字回答。');
      if (Object.prototype.hasOwnProperty.call(args, 'followUps') && cleanFollowUps(args.followUps).length !== 3) throw new Error('请提供 3 条不同且完整的跟问建议。');
      if (!ctx.tools.get(SQL_TOOL,exec.agent)) throw new Error('当前会话未授权 DataHub 语义 SQL 工具。');
      const query = {datasourceId:args.datasourceId,sql:args.sql,limit:args.limit ?? 100,offset:args.offset ?? 0};
      const outcome = await ctx.tools.execute({
        calls:[{type:'tool-call',id:`datahub-chart-${randomUUID()}`,name:SQL_TOOL,arguments:JSON.stringify(query)}],
        agent:exec.agent,signal:exec.signal,toolSet:exec.toolSet
      });
      for (const context of outcome.additionalContexts) {
        exec.deferContext(context.source?.kind === 'datahub-query-enhance' && exec.callId
          ? {...context,source:{...context.source,parentCallId:exec.callId}}
          : context);
      }
      const result = extractSqlResult(outcome.results[0]?.result);
      return buildChart(args,result,currentTurnText(events));
    }
  });
}
