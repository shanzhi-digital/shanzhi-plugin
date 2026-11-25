// Lossless JSON normalization matching DSH host @deepseek-ai/dsh-util-values walkJsonValue contract.
// Rejects undefined object keys, NaN/Infinity, -0, sparse arrays, circular references, and non-plain objects.

const MAX_DEPTH = 40;

function sanitizeValue(value, depth, seen) {
  if (depth > MAX_DEPTH) return null;
  if (value === null || value === undefined) return null;

  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return undefined;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value.toJSON === 'function') {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      return sanitizeValue(value.toJSON(), depth + 1, seen);
    } finally {
      seen.delete(value);
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, i)) {
          out.push(null);
          continue;
        }
        const elem = sanitizeValue(value[i], depth + 1, seen);
        out.push(elem === undefined ? null : elem);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  if (type === 'object') {
    if (seen.has(value)) return null;
    seen.add(value);
    try {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
        const clean = sanitizeValue(v, depth + 1, seen);
        if (clean !== undefined) out[k] = clean;
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  return null;
}

export function toToolOutput(value) {
  const clean = sanitizeValue(value, 0, new WeakSet());
  return clean === undefined ? null : clean;
}
