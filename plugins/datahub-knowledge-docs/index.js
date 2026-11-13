import { appendPluginRecord } from '@deepseek-ai/dsh-session';
import { PRESENT_TOOL } from './results.js';
import { registerHostBridge, presentKnowledgeDocuments } from './host-bridge.js';

export const inject = ['tools', 'sessions', 'systemPrompt', 'loader'];

export function apply(ctx) {
  registerHostBridge(ctx, appendPluginRecord);
  ctx.systemPrompt.section({
    name: 'datahub-knowledge-docs',
    order: 951,
    text: [
      '查询知识库里的制度、文档和业务知识时，使用 DataHub 问知工具 mcp__datahub-knowledge__retrieve_knowledge。用户问知识传 purpose: "knowledge"，用户要找知识库文件传 purpose: "documents"。检索完成后必须调用 knowledge_documents_present 确认本次最终交付场景与真实文档。',
      'knowledge_documents_present 只读取当前回合已成功检索的真实候选，不执行检索，不接受文件名、链接或自填正文。省略 documentRefs 可按每页20份读取紧凑候选索引，使用返回的 cursor 继续；索引不是最终展示。传入 documentRefs 数组才提交最终选择，空数组表示没有确认匹配文件。',
      '找文档时只检索定位或核对必需的数据；已找到目标后不要为生成摘要继续调用 knowledge 检索。指定文件按完整文件名或精确主名核对，跨库同名命中都保留；相关文件只选择确认符合要求的真实 documentRef，不把全部召回候选当成最终文件。最后以 purpose: "documents" 提交，插件只显示“找到的文档”及原文入口，不显示“检索来源”或片段。',
      '找文档的最终正文只用一句话确认查找结果，例如“已找到你要的文档。”；未找到指定文件如实说明。不要复制文档清单，不写长摘要，不追加导出、推荐或后续邀约。documentLimit 是候选列表上限，不是总命中数。',
      '问知识时依据返回的 evidence[].text 正常回答，再以 purpose: "knowledge" 提交最终来源 documentRefs；可用真实 evidenceIds 限定展示证据，省略时展示选中文档的检索证据。插件在本回合末尾展示一个“检索来源”区。候选片段不能称为本回答实际引用数，不为展示重复检索。',
      '只使用工具返回的真实文档和证据，不从本地目录或自然语言猜测知识库原文地址。原文不可用、无法确定服务地址或已过期时如实说明；不编造地址，不携带额外 API Key，不自动重新检索。',
      '工具失败不能表述成没有找到文档。旧接口未返回 schemaVersion: 2 时说明当前接口尚未提供文档展示数据，不宣称卡片已经生成。'
    ].join('\n')
  });
  ctx.tools.register({
    name: PRESENT_TOOL,
    description: '问知检索完成后确认最终展示的真实文件或知识来源。不执行检索，不接收自填文档；省略 documentRefs 时只分页返回当前回合候选索引，传入数组时提交最终选择。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      purpose: { type: 'string', enum: ['documents', 'knowledge'], description: '找文件使用 documents；问知识的最终来源使用 knowledge。' },
      documentRefs: { type: 'array', items: { type: 'string' }, description: '当前回合成功检索返回的真实 documentRef；省略只读候选索引，空数组表示没有确认匹配文件。' },
      evidenceIds: { type: 'array', items: { type: 'string' }, description: 'knowledge 模式可选；必须来自选中文档的真实证据，省略则展示这些文档的检索证据。' },
      cursor: { type: 'string', description: '仅省略 documentRefs 读取候选时使用，原样传入上一页返回的 cursor。' },
    }, required: ['purpose'] },
    output: { schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; } },
    async execute(args, exec) {
      const session = exec.agent?.id && ctx.sessions.get(exec.agent.id);
      if (!session) throw new Error('未找到当前会话。');
      return presentKnowledgeDocuments(args, session.snapshotEvents());
    },
  });
}
