import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('构建后的客户端可由 ModuleLoader 加载并注册 settings.section 与中英文 locale', () => {
  let exported;
  const window = {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, '@local/datahub-onboarding');
        exported = definition.factory(id => {
          assert.equal(id, 'react');
          return { createElement: () => null };
        });
      },
    },
  };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window });
  assert.equal(typeof exported.apply, 'function');
  assert.deepEqual(Array.from(exported.inject), ['slots', 'locale', 'connection']);
  let dictionaries;
  let section;
  const ctx = {
    connection: {},
    effect(register) { register(); return () => {}; },
    locale: {
      register(namespace, values) { assert.equal(namespace, 'datahub.onboarding'); dictionaries = values; return () => {}; },
      bind(namespace) { assert.equal(namespace, 'datahub.onboarding'); return key => dictionaries.zh[key] ?? key; },
    },
    slots: {
      inject(name, register) { assert.equal(name, 'settings.section'); register(); },
      register(options, component) { section = { options, component }; return () => {}; },
    },
  };
  exported.apply(ctx);
  assert.equal(section.options.id, 'datahub-onboarding');
  assert.equal(section.options.label(), 'DataHub 数据服务');
  assert.equal(section.options.locale, 'datahub.onboarding');
  assert.equal(typeof section.component, 'function');
  assert.equal(dictionaries.zh.validateConnect, '验证并连接');
  assert.equal(dictionaries.en.validateConnect, 'Validate and connect');
});
