export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { publicMessage: message, status });
}

export function text(value, label, max = 2000, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(`${label}格式无效或超出长度限制。`);
  }
  return value.trim();
}

export function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${label}格式无效。`);
  return value;
}

function rows(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}格式无效或数量过多。`);
  return value;
}

export function selectedIds(value, known, label) {
  const ids = rows(value, label, known.size);
  const seen = new Set(ids);
  if (seen.size !== ids.length || ids.some(id => !known.has(id))) fail(`${label}包含未知或重复项。`);
  return seen;
}

export const categories = ['BUSINESS', 'SYSTEM', 'UNKNOWN'];
const fixedDomains = { SYSTEM: '系统支撑', UNKNOWN: '其他' };
const reservedDomains = new Set(Object.values(fixedDomains));

export function selectionBasis(input, questions, domainList) {
  const questionIds = selectedIds(input.questionIds ?? [], new Set(questions.map(item => item.id)), '所选问题');
  const names = selectedIds(input.domains ?? [], new Set(domainList.map(item => item.name)), '所选业务域');
  if (questionIds.size === 0 && names.size === 0) fail('请至少选择一个问题或业务域。');
  return {
    questions: questions.filter(item => questionIds.has(item.id)),
    domains: domainList.filter(item => names.has(item.name)),
  };
}

export function domainResult(result, tables) {
  object(result, ['domains', 'classifications'], '业务域结果');
  const names = new Set();
  const domains = rows(result.domains, '业务域', tables.size).map(item => {
    object(item, ['name', 'description'], '业务域');
    const name = text(item.name, '业务域名称', 64);
    const key = name.normalize('NFKC').toLowerCase();
    if (reservedDomains.has(key) || names.has(key)) fail('业务域包含固定分类或重复名称。');
    names.add(key);
    return { name, description: text(item.description, '业务域说明', 500) };
  });
  const knownDomains = new Set(domains.map(item => item.name));
  const classifications = new Map();
  const entries = rows(result.classifications, '表分类', tables.size);
  if (entries.length !== tables.size) fail('请提交全部目录表的分类。');
  for (const item of entries) {
    object(item, ['tableId', 'category', 'domain', 'reason'], '表分类');
    const { tableId, category } = item;
    if (!tables.has(tableId) || classifications.has(tableId) || !categories.includes(category)) fail('表分类包含未知或重复表，或分类值无效。');
    const domain = text(item.domain, '业务域', 64, true);
    if (category === 'BUSINESS' ? !knownDomains.has(domain) : domain && domain !== fixedDomains[category]) fail('表分类引用了不适用的业务域。');
    classifications.set(tableId, { category, domain: category === 'BUSINESS' ? domain : '', reason: text(item.reason, '分类依据', 2000) });
  }
  return { domains, classifications };
}

export function questionAnalyses(value, tables, questions, label = '逐题分析') {
  const known = new Set(questions.map(question => question.id));
  const seen = new Set();
  const analyses = rows(value, label, questions.length).map(item => {
    object(item, ['questionId', 'links'], label);
    const { questionId } = item;
    if (!known.has(questionId) || seen.has(questionId)) fail(`${label}包含未知或重复问题。`);
    seen.add(questionId);
    const linkedTables = new Set();
    const links = rows(item.links, '问题关联', tables.size).map(link => {
      object(link, ['tableId', 'fields', 'reason'], '问题关联');
      const table = tables.get(link.tableId);
      if (!table || linkedTables.has(link.tableId)) fail('问题关联包含未知表或重复关联。');
      linkedTables.add(link.tableId);
      const fields = selectedIds(link.fields, new Set(table.fields.map(field => field.name)), '问题关联字段');
      return { tableId: link.tableId, fields: [...fields], reason: text(link.reason, '关联依据', 2000) };
    });
    return { questionId, links };
  });
  if (seen.size !== known.size) fail(`${label}必须恰好覆盖全部待分析问题，空结果请显式提交 links: []。`);
  return analyses;
}

export function suggestionResult(result, tables, questions) {
  object(result, ['recommendations', 'analyses'], '选表结果');
  const recommended = new Set();
  const recommendations = rows(result.recommendations, '推荐表', tables.size).map(item => {
    object(item, ['tableId', 'reason'], '推荐表');
    const { tableId } = item;
    if (!tables.has(tableId) || recommended.has(tableId)) fail('推荐包含未知或重复表。');
    recommended.add(tableId);
    return { tableId, reason: text(item.reason, '推荐理由', 2000) };
  });
  const analyses = questionAnalyses(result.analyses, tables, questions);
  return { recommendations, analyses };
}

export function questionCandidates(result, tables, questions, originalAnalysisQuestions) {
  object(result, ['candidates', 'reason', 'originalAnalyses'], '泛化结果');
  const candidates = rows(result.candidates, '候选问题', 20);
  if (candidates.length < 1) fail('请生成 1 至 20 个候选问题。');
  const reason = result.reason === undefined ? undefined : text(result.reason, '不足原因', 2000, true);
  if (candidates.length < 15 && !reason) fail('候选不足 15 个时，请说明不足原因。');
  const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const seen = new Set(questions.map(item => normalize(item.text)));
  const verified = candidates.map((item, index) => {
    object(item, ['text', 'answer', 'links'], '候选问题');
    if (item.answer !== '') fail('候选问题答案必须为空。');
    const value = text(item.text, '候选问题', 2000);
    const key = normalize(value);
    if (seen.has(key)) fail('候选问题与已有问题或其他候选重复。');
    seen.add(key);
    const proposed = rows(item.links, '候选依据', tables.size);
    if (!proposed.length) fail('每个候选问题至少需要一个有效依据。');
    proposed.forEach(link => object(link, ['tableId', 'fields', 'reason'], '候选依据'));
    const [{ links }] = questionAnalyses([{ questionId: index, links: proposed }], tables, [{ id: index }]);
    if (links.some(link => !link.fields.length)) fail('候选依据至少需要一个真实字段。');
    return { text: value, answer: '', links };
  });
  const originalAnalyses = questionAnalyses(result.originalAnalyses, tables, originalAnalysisQuestions, '原题分析');
  return { candidates: verified, originalAnalyses, ...(reason === undefined ? {} : { reason }) };
}

export function selectionDraft(id, state, recommendations, domains = []) {
  const recommended = new Set(recommendations.map(item => item.tableId));
  const selectedDomains = new Set(domains.map(item => item.name));
  const tables = state.catalog.tables;
  const domainMatches = tables.filter(table => table.category === 'BUSINESS' && selectedDomains.has(table.domain))
    .map(table => ({ tableId: table.id, domain: table.domain }));
  const matched = new Set(domainMatches.map(item => item.tableId));
  return {
    id,
    catalogId: state.catalog.id,
    tableIds: tables.map(table => table.id),
    selectedTableIds: tables.filter(table => table.enabled || matched.has(table.id) || recommended.has(table.id)).map(table => table.id),
    domainMatches,
    recommendations,
  };
}

export function updateEnabled(tables, candidates, selected) {
  let changed = false;
  for (const table of tables) {
    if (!candidates.has(table.id)) continue;
    const enabled = selected.has(table.id);
    if (table.enabled !== enabled) {
      table.enabled = enabled;
      changed = true;
    }
  }
  return changed;
}
