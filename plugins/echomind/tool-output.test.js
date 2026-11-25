import test from 'node:test';
import assert from 'node:assert/strict';
import { toToolOutput } from './tool-output.js';
import { assertLossless } from './assert-lossless.js';

test('toToolOutput strips undefined keys, normalizes -0/NaN/Infinity, handles sparse arrays and circular refs', () => {
  const sparse = new Array(3);
  sparse[1] = -0;
  const cyclic = { name: 'meeting', bad: undefined, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, sparse };
  cyclic.self = cyclic;

  const out = toToolOutput(cyclic);
  assertLossless(out);
  assert.equal('bad' in out, false);
  assert.equal(out.nan, null);
  assert.equal(out.inf, null);
  assert.equal(out.self, null);
  assert.deepEqual(out.sparse, [null, 0, null]);
  assert.ok(!Object.is(out.sparse[1], -0));
});

test('toToolOutput converts Date and BigInt into JSON-safe lossless values', () => {
  const out = toToolOutput({
    at: new Date('2026-11-25T08:00:00.000Z'),
    badDate: new Date('invalid'),
    big: 12345678901234567890n,
  });
  assertLossless(out);
  assert.equal(out.at, '2026-11-25T08:00:00.000Z');
  assert.equal(out.badDate, null);
  assert.equal(out.big, '12345678901234567890');
});
