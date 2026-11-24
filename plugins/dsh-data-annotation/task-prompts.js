export function annotationPrompt(kind, selectedTotal) {
  if (kind === 'relation') return `请读取当前数据源全部 ${selectedTotal} 张启用表，自行分析并按有意义的业务查询主题生成画布。只使用 data_annotation_task：先用read从cursor 0开始读取所有nextCursor，读完全部结构后一次submit提交canvases:[{name,description,rootTableId,relations:[{fromTableId,toTableId,pairs:[{fromField,toField}],cardinality}]}]。每张画布表达一个可独立用于查询的业务主题，name使用清晰中文业务名称，description简要说明查询用途、核心主表代表的业务粒度及引入关联表的原因，rootTableId明确唯一核心主表。只加入主题必要的关联表，所有表须通过关系从核心主表可达；不要仅按连通分量把全部相连表合成一张，也不要按表对机械拆组。主题数量由业务含义决定，不凑组数；允许0到多组，依据不足时提交canvases:[]。不同主题可复用相同表或关系，例如同一主表的基础主题与含明细的扩展主题；read的canvases包含已有画布名称、说明、核心主表及完整关系语义，避免重复提交相同核心主表与完整关系组合，已有单条关系不妨碍新的主题组合。每条关系只填写fromTableId、toTableId、非空pairs及cardinality（1:1、1:N或N:1），复合键使用多组非重复字段配对。只引用read中的真实启用表字段，不允许自关联，不设置ID、布局或人工确认。根据名称、类型、primaryKey、notNull、原备注和中文标注推断；缺失结构值为null，不代表已发现真实外键或得到采样证明。相同tableId的字段可能分片，fieldOffset和moreFields表示分片位置，必须读完。仅提供结构推断的查询主题建议，后续由人工确认；不要调用SQL、采样或其他插件工具，不修改源库。`;
  const table = kind === 'table';
  const shape = table
    ? '表标注每条只填写 tableId 和 text，不要包含 fieldName；read 返回的 fields 仅供理解表用途，不需要逐字段提交'
    : '字段标注每条填写 tableId、fieldName 和 text';
  const brevity = table
    ? '表标注只填写简短的中文业务名称，使用名词或名词短语，例如“养老机构收费标准”“学生学籍”“企业采购订单”；优先从原备注提取准确的业务名称，结合字段结构消除歧义，去掉分类或使用场景标签；尽量不超过 15 字，不要生成“记录……”“维护……”等用途说明，不要罗列字段或实现细节'
    : '字段标注用一句话自然说明字段含义，避免模板化措辞；尽量不超过 20 字，不要重复表名或字段类型';
  return `请为本次选中的${table ? '表' : '字段'}生成中文标注。本次共选中 ${selectedTotal} ${table ? '张表' : '个字段'}，提交条数必须正好为 ${selectedTotal} 条，每个选中对象一条。只使用 data_annotation_task：先用 read 分页读取全部结构，再用 submit 一次提交全部标注。${shape}。${brevity}。表的字段结构可能分布在多个分页，相同 tableId 属于同一张表，fieldOffset 和 moreFields 表示字段分片。只能依据名称、类型和现有结构说明，不要编造业务含义或数据；依据不足时使用中性描述。不要调用 SQL 或其他插件工具。`;
}
