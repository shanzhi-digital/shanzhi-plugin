// 测试辅助：按 DSH 宿主 @deepseek-ai/dsh-util-values 的 walkJsonValue 规则判断「无损 JSON」。
// 拒绝 undefined、函数、symbol、BigInt、NaN/Infinity、-0、非普通原型的对象或数组、
// symbol 键或不可枚举键、稀疏数组（或数组上的额外属性）、循环引用。
import assert from 'node:assert/strict';

export function isLosslessJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      if (Reflect.ownKeys(value).length !== value.length + 1) return false;
      for (let index = 0; index < value.length; index++) {
        if (!isLosslessJson(value[index], ancestors)) return false;
      }
      return true;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) {
      return false;
    }
    return keys.every((key) => isLosslessJson(value[key], ancestors));
  } finally {
    ancestors.delete(value);
  }
}

export function assertLossless(value, label = 'value') {
  assert.ok(isLosslessJson(value), `${label} 不是无损 JSON：${JSON.stringify(value)?.slice(0, 300)}`);
}
