export function annotationPrompt(kind, selectedTotal) {
  const table = kind === 'table';
  const shape = table
    ? '表标注每条只填写 tableId 和 text，不要包含 fieldName；read 返回的 fields 仅供理解表用途，不需要逐字段提交'
    : '字段标注每条填写 tableId、fieldName 和 text';
  const brevity = table
    ? '表标注只填写简短的中文业务名称，使用名词或名词短语，例如“养老机构收费标准”“学生学籍”“企业采购订单”；优先从原备注提取准确的业务名称，结合字段结构消除歧义，去掉分类或使用场景标签；尽量不超过 15 字，不要生成“记录……”“维护……”等用途说明，不要罗列字段或实现细节'
    : '字段标注用一句话自然说明字段含义，避免模板化措辞；尽量不超过 20 字，不要重复表名或字段类型';
  return `请为本次选中的${table ? '表' : '字段'}生成中文标注。本次共选中 ${selectedTotal} ${table ? '张表' : '个字段'}，提交条数必须正好为 ${selectedTotal} 条，每个选中对象一条。只使用 data_annotation_task：先用 read 分页读取全部结构，再用 submit 一次提交全部标注。${shape}。${brevity}。表的字段结构可能分布在多个分页，相同 tableId 属于同一张表，fieldOffset 和 moreFields 表示字段分片。只能依据名称、类型和现有结构说明，不要编造业务含义或数据；依据不足时使用中性描述。不要调用 SQL 或其他插件工具。`;
}
