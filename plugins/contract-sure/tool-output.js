// 把工具返回值整理成 DSH 宿主接受的「无损 JSON」。
// 宿主规则见 @deepseek-ai/dsh-util-values 的 walkJsonValue：拒绝 undefined、NaN/Infinity、-0、
// 非普通原型对象、symbol 或不可枚举键、稀疏数组和循环引用，任何一处不合格整个工具调用就失败。

function cleanValue(value, ancestors) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) return null;
      return Object.is(value, -0) ? 0 : value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      // undefined、函数、symbol：对象里删掉该键，数组里变成 null（由调用方决定）。
      return undefined;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // 循环引用无法表示为 JSON，用 null 截断。
  if (ancestors.has(value)) return null;

  if (Array.isArray(value)) {
    ancestors.add(value);
    // Array.from 会把空洞读成 undefined，避免产出稀疏数组。
    const out = Array.from(value, (item) => {
      const cleaned = cleanValue(item, ancestors);
      return cleaned === undefined ? null : cleaned;
    });
    ancestors.delete(value);
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Map、Buffer、类实例等：按 JSON.stringify 的结果取值。
    let json;
    try {
      json = JSON.stringify(value);
    } catch {
      return null;
    }
    if (json === undefined) return undefined;
    return cleanValue(JSON.parse(json), ancestors);
  }

  ancestors.add(value);
  const entries = [];
  for (const key of Object.keys(value)) {
    const cleaned = cleanValue(value[key], ancestors);
    if (cleaned !== undefined) entries.push([key, cleaned]);
  }
  ancestors.delete(value);
  // fromEntries 用的是普通数据属性，键名为 "__proto__" 时也不会改动原型。
  return Object.fromEntries(entries);
}

/**
 * 返回一份可安全交给宿主的工具输出副本：
 * 删除值为 undefined 的属性，数组中的 undefined 变 null，NaN/Infinity 变 null，-0 变 0，
 * Date 变 ISO 字符串，BigInt 变字符串，其他非普通对象按 JSON 往返取值。
 */
export function toToolOutput(value) {
  const cleaned = cleanValue(value, new Set());
  return cleaned === undefined ? null : cleaned;
}
