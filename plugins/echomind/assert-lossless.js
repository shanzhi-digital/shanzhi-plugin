import assert from 'node:assert/strict';

/**
 * Mirrors DSH host walkJsonValue strict checks for unit tests.
 */
export function assertLossless(value, path = '$', seen = new WeakSet()) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path}: non-finite number ${value}`);
    assert.ok(!Object.is(value, -0), `${path}: negative zero`);
    return;
  }
  assert.notEqual(type, 'undefined', `${path}: undefined is forbidden`);
  assert.equal(type, 'object', `${path}: unsupported type ${type}`);
  assert.ok(!seen.has(value), `${path}: circular reference`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        assert.ok(Object.prototype.hasOwnProperty.call(value, i), `${path}[${i}]: sparse array hole`);
        assertLossless(value[i], `${path}[${i}]`, seen);
      }
      return;
    }
    const proto = Object.getPrototypeOf(value);
    assert.ok(proto === Object.prototype || proto === null, `${path}: non-plain object prototype`);
    for (const [k, v] of Object.entries(value)) {
      assert.notEqual(v, undefined, `${path}.${k}: undefined object property`);
      assertLossless(v, `${path}.${k}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}
