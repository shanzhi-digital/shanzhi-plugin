// 工具参数校验和结果整理的公共函数。报错文案写给模型看，说清楚哪个参数、怎么改。
import { ApiError } from './api-client.js';

export const MAX_TEXT_LENGTH = 100;

export function invalid(message) {
  return new ApiError(message, { code: 'INVALID_ARGUMENT' });
}

export function rejectUnknown(args, allowed, toolName) {
  const unknown = Object.keys(args).filter((key) => args[key] !== undefined && !allowed.includes(key));
  if (unknown.length) {
    throw invalid(`${toolName} 不认识参数 ${unknown.join('、')}。可用参数：${allowed.join('、')}。`);
  }
}

export function rejectPresent(args, keys, reason) {
  const present = keys.filter((key) => args[key] !== undefined && args[key] !== null);
  if (present.length) throw invalid(`${present.join('、')} ${reason}`);
}

export function optText(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${key} 必须是字符串。`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_TEXT_LENGTH) throw invalid(`${key} 太长了，最多 ${MAX_TEXT_LENGTH} 个字。`);
  return trimmed;
}

export function optInt(args, key, min, max) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${key} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

export function optAmount(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw invalid(`${key} 必须是不小于 0 的数字（单位：万元）。`);
  }
  return value;
}

export function optEnum(args, key, values) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!values.includes(value)) throw invalid(`${key} 只能是 ${values.join('、')} 之一。`);
  return value;
}

export function optBool(args, key) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${key} 必须是 true 或 false。`);
  return value;
}

export function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function optDate(args, key) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isRealDate(value.trim())) throw invalid(`${key} 必须是 YYYY-MM-DD 格式的日期，例如 2026-11-24。`);
  return value.trim();
}

export function checkRange(from, to, fromKey, toKey, relation = '晚于') {
  if (from !== undefined && to !== undefined && from > to) throw invalid(`${fromKey} 不能${relation} ${toKey}。`);
}


export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function text(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

// 后端的 LocalDate / LocalDateTime 一般是 ISO 字符串；万一是 [年, 月, 日, …] 数组也能读。
export function dateText(value, withTime) {
  if (Array.isArray(value) && value.length >= 3) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${value[0]}-${pad(value[1])}-${pad(value[2])}`;
    return withTime && value.length >= 5 ? `${day} ${pad(value[3])}:${pad(value[4])}` : day;
  }
  if (typeof value !== 'string' || !value) return '';
  const normalized = value.replace('T', ' ');
  return withTime ? normalized.slice(0, 16) : normalized.slice(0, 10);
}
