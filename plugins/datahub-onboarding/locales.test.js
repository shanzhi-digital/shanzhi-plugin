import test from 'node:test';
import assert from 'node:assert/strict';
import { en, zh } from './locales.js';

test('中英文设置页文案键完整一致', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], 'string');
    assert.ok(zh[key].length > 0);
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].length > 0);
  }
  assert.equal(zh.validateConnect, '验证并连接');
  assert.match(zh.security, /凭据存储/);
});
