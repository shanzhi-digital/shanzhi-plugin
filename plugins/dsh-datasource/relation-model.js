import { createHash, randomUUID } from 'node:crypto';

const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400, publicMessage: message }); };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const compare = (a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; };
const id = (value, label) => { if (typeof value !== 'string' || !value || [...value].length > 128) fail(`${label}无效。`); return value; };
const text = (value, label, max) => { if (typeof value !== 'string' || [...value].length > max) fail(`${label}无效。`); return value; };
const reverseCardinality = value => ({ '1:1': '1:1', '1:N': 'N:1', 'N:1': '1:N' })[value];

/** Equivalent reverse directions share a key, including composite field pairs. */
export function relationKey(edge) {
  let { fromTableId, toTableId, cardinality } = edge;
  let pairs = edge.pairs.map(pair => [pair.fromField, pair.toField]);
  if (fromTableId > toTableId) {
    [fromTableId, toTableId] = [toTableId, fromTableId];
    pairs = pairs.map(([from, to]) => [to, from]);
    cardinality = reverseCardinality(cardinality);
  }
  return JSON.stringify([fromTableId, toTableId, pairs.sort(compare), cardinality]);
}

export function normalizeEdge(value, { generateId = true } = {}) {
  if (!value || typeof value !== 'object') fail('关系内容无效。');
  const fromTableId = id(value.fromTableId, '来源表 ID'), toTableId = id(value.toTableId, '目标表 ID');
  if (fromTableId === toTableId) fail('暂不支持表的自关联。');
  if (!['1:1', '1:N', 'N:1'].includes(value.cardinality)) fail('关系基数无效。');
  if (!Array.isArray(value.pairs) || !value.pairs.length) fail('关系至少需要一组字段配对。');
  const seen = new Set();
  const pairs = value.pairs.map(pair => {
    const fromField = text(pair?.fromField, '来源字段', 255), toField = text(pair?.toField, '目标字段', 255);
    if (!fromField || !toField) fail('关系字段不能为空。');
    const key = JSON.stringify([fromField, toField]);
    if (seen.has(key)) fail('关系字段配对重复。');
    seen.add(key);
    return { fromField, toField };
  }).sort(compare);
  return { id: value.id === undefined && generateId ? randomUUID() : id(value.id, '关系 ID'), fromTableId, toTableId, pairs, cardinality: value.cardinality };
}

export function normalizeCanvas(value) {
  if (!value || typeof value !== 'object') fail('关系画布无效。');
  const name = text(value.name, '画布名称', 255).trim();
  if (!name) fail('画布名称不能为空。');
  const description = text(value.description ?? '', '画布说明', 10000);
  if (!value.content || !Array.isArray(value.content.nodes) || !Array.isArray(value.content.edges)) fail('画布节点或关系无效。');
  const tables = new Set(), edges = new Set(), keys = new Set();
  const nodes = value.content.nodes.map(node => {
    const tableId = id(node?.tableId, '表 ID');
    if (tables.has(tableId)) fail('画布包含重复表。');
    tables.add(tableId);
    return { tableId, label: text(node.label ?? '', '表名称', 512) };
  }).sort((a, b) => compare(a.tableId, b.tableId));
  const relations = value.content.edges.map(value => {
    const edge = normalizeEdge(value), key = relationKey(edge);
    if (!tables.has(edge.fromTableId) || !tables.has(edge.toTableId)) fail('关系端点必须属于画布节点。');
    if (edges.has(edge.id) || keys.has(key)) fail('画布包含重复关系。');
    edges.add(edge.id); keys.add(key);
    return edge;
  }).sort((a, b) => compare(a.id, b.id));
  const layout = {};
  if (value.layout !== undefined && (!value.layout || typeof value.layout !== 'object' || Array.isArray(value.layout))) fail('节点位置无效。');
  for (const [tableId, point] of Object.entries(value.layout ?? {})) {
    if (!tables.has(tableId)) continue;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) fail('节点位置无效。');
    Object.defineProperty(layout, tableId, { value: { x: point.x, y: point.y }, enumerable: true, writable: true, configurable: true });
  }
  const root = value.content.rootTableId == null ? {} : { rootTableId: id(value.content.rootTableId, '主表 ID') };
  if (root.rootTableId !== undefined && !tables.has(root.rootTableId)) fail('主表必须属于画布节点。');
  return { id: value.id === undefined ? randomUUID() : id(value.id, '画布 ID'), name, description, content: { ...root, nodes, edges: relations }, layout };
}

export function canvasSemantics(canvas) {
  return { name: canvas.name, description: canvas.description,
    ...(canvas.content.rootTableId === undefined ? {} : { rootTableId: canvas.content.rootTableId }),
    nodes: canvas.content.nodes.map(node => node.tableId).sort(),
    edges: canvas.content.edges.map(relationKey).sort() };
}

/** Theme identity ignores naming, node positions and edge direction/order. */
export function canvasThemeKey(canvas) {
  return JSON.stringify([canvas.content.rootTableId ?? null, [...new Set(canvas.content.edges.map(relationKey))].sort()]);
}

/** Catalog tables include disabled rows so retained invalid references stay visible. */
export function inspectCanvas(canvas, tables) {
  const tableMap = new Map(tables.map(table => [table.id, table]));
  const invalid = [], validationErrors = [], participating = new Set();
  const dependencies = [];
  for (const node of canvas.content.nodes) {
    const table = tableMap.get(node.tableId);
    if (!table || !table.enabled) invalid.push({ kind: 'table', tableId: node.tableId, reason: !table ? '表已删除或不属于当前数据源' : '表已停用' });
    dependencies.push([node.tableId, table ? [table.schema, table.name, table.tableKind ?? 'table', table.enabled] : null]);
  }
  for (const edge of canvas.content.edges) {
    participating.add(edge.fromTableId); participating.add(edge.toTableId);
    for (const pair of edge.pairs) for (const [tableId, fieldName] of [[edge.fromTableId, pair.fromField], [edge.toTableId, pair.toField]]) {
      const field = tableMap.get(tableId)?.fields.find(field => field.name === fieldName);
      if (!field || field.enabled === false) invalid.push({ kind: 'field', tableId, fieldName, reason: !field ? '字段已删除' : '字段已停用' });
      dependencies.push([tableId, fieldName, field ? [field.type, field.primaryKey ?? null, field.notNull ?? null, field.enabled !== false] : null]);
    }
  }
  if (canvas.content.nodes.length < 2) validationErrors.push('确认至少需要两个有效表节点。');
  if (!canvas.content.edges.length) validationErrors.push('确认至少需要一条关系。');
  if (canvas.content.nodes.some(node => !participating.has(node.tableId))) validationErrors.push('所有表节点都必须参与关系。');
  if (canvas.content.rootTableId !== undefined) {
    const root = canvas.content.rootTableId, nodes = new Set(canvas.content.nodes.map(node => node.tableId));
    if (!nodes.has(root)) validationErrors.push('主表必须属于画布节点。');
    else {
      const adjacency = new Map([...nodes].map(tableId => [tableId, []]));
      for (const edge of canvas.content.edges) {
        adjacency.get(edge.fromTableId)?.push(edge.toTableId);
        adjacency.get(edge.toTableId)?.push(edge.fromTableId);
      }
      const visited = new Set([root]), queue = [root];
      for (let index = 0; index < queue.length; index++) for (const neighbor of adjacency.get(queue[index]) ?? []) {
        if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
      }
      if ([...nodes].some(tableId => !visited.has(tableId))) validationErrors.push('所有表节点都必须能从主表沿关系到达。');
    }
  }
  const unique = [...new Map(invalid.map(item => [JSON.stringify(item), item])).values()];
  return { invalid: unique, validationErrors, valid: !unique.length && !validationErrors.length,
    signature: digest([canvasSemantics(canvas), dependencies.sort(compare)]) };
}

export function tableCompletion(table) {
  const required = [table.annotation, ...table.fields.filter(field => field.enabled).map(field => field.annotation)];
  const annotatedCount = required.filter(value => value.status === 'confirmed' && value.text.trim()).length;
  return { annotatedCount, requiredCount: required.length,
    status: required.every(value => !value.text.trim()) ? 'unannotated' : annotatedCount === required.length ? 'complete' : 'partial' };
}

export function relationCompletion(canvas, tables) {
  const map = new Map(tables.map(table => [table.id, tableCompletion(table).status]));
  const statuses = canvas.content.nodes.map(node => map.get(node.tableId) ?? 'unannotated');
  return statuses.every(value => value === 'unannotated') ? 'unannotated' : statuses.every(value => value === 'complete') ? 'complete' : 'partial';
}

/** Row ordering, layouts, scan metadata and update clocks are intentionally absent. */
export function resultsFingerprint(source, tables, canvases) {
  const metadata = source.metadata ?? source;
  return digest({ source: [source.id ?? source.source_id, source.enabled, metadata.name, metadata.engine, metadata.host, metadata.port, metadata.user, metadata.database, metadata.file],
    tables: tables.filter(table => table.enabled !== false).map(table => ({ id: table.id, schema: table.schema, name: table.name, tableKind: table.tableKind,
      sourceComment: table.sourceComment, annotation: [table.annotation.text, table.annotation.status],
      fields: table.fields.map(field => ({ name: field.name, type: field.type, primaryKey: field.primaryKey ?? null, notNull: field.notNull ?? null,
        sourceComment: field.sourceComment, enabled: field.enabled, annotation: [field.annotation.text, field.annotation.status] })).sort((a, b) => compare(a.name, b.name)) })).sort((a, b) => compare(a.id, b.id)),
    canvases: canvases.map(canvas => ({ id: canvas.id, ...canvasSemantics(canvas), confirmed: canvas.confirmed })).sort((a, b) => compare(a.id, b.id)) });
}
