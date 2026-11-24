import test from 'node:test';
import assert from 'node:assert/strict';
import { toToolOutput } from './tool-output.js';
import { isLosslessJson, assertLossless } from './assert-lossless.js';

test('assertLossless follows host rules: the old detail shape with undefined keys is rejected', () => {
  // 图 1 的根因：详情返回里写了 nodes: undefined, documents: undefined。
  assert.equal(isLosslessJson({ contract: { id: 78, nodes: undefined, documents: undefined } }), false);
  assert.equal(isLosslessJson({ n: Number.NaN }), false);
  assert.equal(isLosslessJson({ n: -0 }), false);
  assert.equal(isLosslessJson([1, , 3]), false);
  assert.equal(isLosslessJson({ d: new Date() }), false);
  assert.equal(isLosslessJson({ b: 1n }), false);
  assert.equal(isLosslessJson({ [Symbol('s')]: 1 }), false);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(isLosslessJson(cyclic), false);
  assert.equal(isLosslessJson(Object.assign(Object.create(null), { a: [1, 'x', null, true] })), true);
});

test('toToolOutput turns every rejected value into lossless JSON', () => {
  class Money {
    constructor(value) {
      this.value = value;
    }
  }
  const cyclic = { name: 'loop' };
  cyclic.self = cyclic;
  const input = {
    keep: 'ok',
    dropped: undefined,
    fn: () => 1,
    nan: Number.NaN,
    inf: Number.POSITIVE_INFINITY,
    negZero: -0,
    date: new Date('2026-11-24T01:02:03.000Z'),
    badDate: new Date('invalid'),
    big: 12345678901234567890n,
    money: new Money(10),
    map: new Map([['a', 1]]),
    list: [1, undefined, Number.NaN, , { inner: undefined, v: 2 }],
    nested: { deeper: { value: undefined, zero: -0 } },
    cyclic,
    [Symbol('hidden')]: 'x',
  };
  const out = toToolOutput(input);
  assertLossless(out, 'toToolOutput 结果');
  assert.deepEqual(out, {
    keep: 'ok',
    nan: null,
    inf: null,
    negZero: 0,
    date: '2026-11-24T01:02:03.000Z',
    badDate: null,
    big: '12345678901234567890',
    money: { value: 10 },
    map: {},
    list: [1, null, null, null, { v: 2 }],
    nested: { deeper: { zero: 0 } },
    cyclic: { name: 'loop', self: null },
  });
  // 不改动原对象。
  assert.equal(input.dropped, undefined);
  assert.ok('dropped' in input);

  const proto = toToolOutput(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assertLossless(proto, '__proto__ 键');

  assert.equal(toToolOutput(undefined), null);
  assert.equal(toToolOutput('text'), 'text');
});
