import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectEvents } from './event-projection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(__dirname, 'client.js'), 'utf8');
const PACKAGE_NAME = '@local/salesforge';

// Minimal synchronous React stub for pure-Node rendering & interaction verification
function createReactStub() {
  let stateSlots = [];
  let slotCursor = 0;
  let pendingEffects = [];

  function resetRender() {
    slotCursor = 0;
    pendingEffects = [];
  }

  function renderComponent(Component, props, existingState) {
    stateSlots = existingState || [];
    resetRender();
    const tree = Component(props || {});
    return {
      tree,
      states: stateSlots,
      runEffects() {
        for (const fn of pendingEffects) fn();
      },
    };
  }

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(initial) {
      const idx = slotCursor++;
      if (!(idx in stateSlots)) {
        stateSlots[idx] = typeof initial === 'function' ? initial() : initial;
      }
      const setState = (next) => {
        stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
      };
      return [stateSlots[idx], setState];
    },
    useEffect(fn) {
      pendingEffects.push(fn);
    },
    useCallback(fn) {
      return fn;
    },
    useRef(initial) {
      const idx = slotCursor++;
      if (!(idx in stateSlots)) stateSlots[idx] = { current: initial };
      return stateSlots[idx];
    },
  };

  return { React, renderComponent };
}

// A small hook-aware renderer: nested function components keep their own state, effects honour
// their deps and run cleanups on re-run and unmount, and setState re-renders on settle().
function createRenderer() {
  const instances = new Map();
  let current = null;
  let cursor = 0;
  let seen = new Set();
  let effects = [];
  let dirty = false;
  let root = null;
  let tree = null;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const inst = current;
      const i = cursor++;
      if (!(i in inst.hooks)) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) {
            slot.value = value;
            dirty = true;
          }
        };
        inst.hooks[i] = slot;
      }
      return [inst.hooks[i].value, inst.hooks[i].set];
    },
    useEffect(fn, deps) {
      const inst = current;
      const i = cursor++;
      const slot = inst.hooks[i] || (inst.hooks[i] = { effect: true, deps: undefined, cleanup: null, ran: false });
      const changed = !slot.ran || !deps || !slot.deps || deps.length !== slot.deps.length
        || deps.some((d, k) => !Object.is(d, slot.deps[k]));
      if (!changed) return;
      slot.ran = true;
      slot.deps = deps;
      effects.push(() => {
        if (typeof slot.cleanup === 'function') slot.cleanup();
        const cleanup = fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null;
      });
    },
    useRef(initial) {
      const inst = current;
      const i = cursor++;
      if (!(i in inst.hooks)) inst.hooks[i] = { current: initial };
      return inst.hooks[i];
    },
    useCallback(fn) {
      return fn;
    },
  };

  const keyOf = (node, index) =>
    node && typeof node === 'object' && !Array.isArray(node) && node.props && node.props.key != null ? `k${node.props.key}` : `i${index}`;

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((child, i) => renderNode(child, `${path}[${keyOf(child, i)}]`));
    if (typeof node.type === 'function') {
      const id = `${path}<${node.type.name || 'anonymous'}>`;
      let inst = instances.get(id);
      if (!inst || inst.type !== node.type) {
        inst = { type: node.type, hooks: [] };
        instances.set(id, inst);
      }
      seen.add(id);
      const saved = [current, cursor];
      current = inst;
      cursor = 0;
      let out;
      try {
        out = node.type(node.props);
      } finally {
        [current, cursor] = saved;
      }
      return { type: node.type, props: node.props, children: [renderNode(out, id)] };
    }
    return {
      type: node.type,
      props: node.props,
      children: node.children.map((child, i) => renderNode(child, `${path}/${node.type}.${keyOf(child, i)}`)),
    };
  }

  function cleanupInstance(inst) {
    for (const slot of inst.hooks) {
      if (slot && slot.effect && typeof slot.cleanup === 'function') {
        const cleanup = slot.cleanup;
        slot.cleanup = null;
        cleanup();
      }
    }
  }

  function render() {
    dirty = false;
    seen = new Set();
    effects = [];
    tree = root ? renderNode(root, 'root') : null;
    for (const [id, inst] of [...instances]) {
      if (!seen.has(id)) {
        instances.delete(id);
        cleanupInstance(inst);
      }
    }
    const run = effects;
    effects = [];
    for (const fn of run) fn();
  }

  return {
    React,
    h: React.createElement,
    mount(element) {
      root = element;
      render();
    },
    get tree() {
      return tree;
    },
    unmount() {
      root = null;
      render();
    },
    async settle() {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setImmediate(r));
        if (dirty) render();
        else if (i >= 2) return;
      }
    },
  };
}

function createFakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      pending.set(seq, { fn, ms });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    delays() {
      return [...pending.values()].map((t) => t.ms);
    },
    runAll() {
      const list = [...pending.values()];
      pending.clear();
      for (const t of list) t.fn();
    },
  };
}

function collectNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectNodes(child, predicate, out);
  }
  return out;
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (typeof node === 'object') return textContent(node.children);
  return '';
}

// Objects built inside the vm realm have another Object.prototype; compare their JSON shape.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// Only what reaches the DOM: host element props (minus handlers) and text, never component props.
function renderedDom(node) {
  if (node == null || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map(renderedDom);
  if (typeof node.type === 'function') return renderedDom(node.children);
  const props = {};
  for (const [key, value] of Object.entries(node.props || {})) {
    if (typeof value !== 'function' && key !== 'ref') props[key] = value;
  }
  return { tag: node.type, props, children: renderedDom(node.children) };
}

function findButton(tree, label) {
  return collectNodes(tree, (n) => n.type === 'button' && textContent(n).includes(label))[0];
}

function lastDialog(tree) {
  const dialogs = collectNodes(tree, (n) => n.type === 'dialog');
  return dialogs[dialogs.length - 1];
}

function click(node) {
  assert.ok(node, 'expected an element to click');
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: null, currentTarget: undefined });
}

function loadClientModule(reactStub, options = {}) {
  let loadedDescriptor = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(desc) {
          loadedDescriptor = desc;
        },
      },
      open: options.windowOpen || (() => null),
    },
    console,
    URL,
    Promise,
    Map,
    Set,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Symbol,
    encodeURIComponent,
    parseInt,
    setTimeout: options.timers ? options.timers.setTimeout : setTimeout,
    clearTimeout: options.timers ? options.timers.clearTimeout : clearTimeout,
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  assert.ok(loadedDescriptor, 'window.__ModuleLoader__.load should be invoked');
  assert.equal(loadedDescriptor.id, '@local/salesforge');
  const require = (id) => {
    if (id === 'react') return reactStub;
    throw new Error(`Unexpected require: ${id}`);
  };
  if (options.asset) require.asset = options.asset;
  const exportsObj = loadedDescriptor.factory(require);
  return exportsObj;
}

// salesforge/* RPC double: handlers return values, thrown errors become { ok: false }.
// Every call must go to the "/api" endpoint with the "salesforge/" prefix and args wrapped in { args }.
function createRpc(handlers) {
  const calls = [];
  const connection = {
    rpc: {
      async call(endpoint, method, payload) {
        assert.equal(endpoint, '/api');
        assert.match(method, /^salesforge\/[a-zA-Z]+$/u);
        assert.ok(payload && typeof payload.args === 'object' && payload.args !== null, `${method} sends { args }`);
        const name = method.replace(/^salesforge\//, '');
        calls.push({ endpoint, method: name, args: payload && payload.args });
        const handler = handlers[name];
        if (!handler) return { ok: false, error: { code: 'not-found', message: `no handler for ${name}` } };
        try {
          return { ok: true, value: await handler(payload.args) };
        } catch (err) {
          return { ok: false, error: { code: 'internal', message: err.message } };
        }
      },
    },
  };
  return {
    connection,
    calls,
    count: (name) => calls.filter((c) => c.method === name).length,
    argsOf: (name) => calls.filter((c) => c.method === name).map((c) => c.args),
  };
}

function servicesFor(connection, extra = {}) {
  return {
    connection: () => connection,
    workspace: () => extra.workspace,
    navigation: () => extra.navigation,
  };
}

const ZHANG = {
  id: 'u7', userId: 7, username: 'zhangsan', realName: '张三', deptName: '销售二部',
  expiresAt: '2027-02-22T12:00:00Z', addedAt: '2026-11-24T02:00:00Z', status: 'ok',
};
const LI = {
  id: 'u9', userId: 9, username: 'lisi', realName: '李四', deptName: '销售部',
  expiresAt: '2026-10-01T12:00:00Z', addedAt: '2026-07-01T02:00:00Z', status: 'expired',
};
const WANG = {
  id: 'u11', userId: 11, username: 'wangwu', realName: '王五', deptName: '',
  expiresAt: '2027-05-01T12:00:00Z', addedAt: '2026-11-01T02:00:00Z', status: 'revoked',
};

function stateWith(accounts, activeAccountId, extra = {}) {
  return {
    serverUrl: 'http://sales.test/api/v1',
    activeAccountId,
    accounts,
    credentialStore: 'dsh-credentials',
    ...extra,
  };
}

function authorizationRpc(extra = {}) {
  let polls = 0;
  const handlers = {
    getState: () => stateWith([], null),
    startAuthorization: () => ({
      requestId: 'req-1',
      userCode: 'WXYZ-1234',
      verifyUrl: 'http://sales.test/plugin-authorize?req=req-1',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      interval: 2,
    }),
    pollAuthorization: () => {
      polls += 1;
      return polls < 2
        ? { status: 'pending' }
        : { status: 'approved', account: ZHANG, state: stateWith([ZHANG], 'u7') };
    },
    cancelAuthorization: () => ({ ok: true }),
    ...extra,
  };
  return createRpc(handlers);
}

function createStrictCtx(services) {
  const registeredSlots = [];
  const registeredEvents = [];
  const rawCtx = {
    slots: {
      inject(slotName, fn) {
        const res = fn();
        registeredSlots.push({ slotName, ...res });
      },
      register(meta, component) {
        return { meta, component };
      },
    },
    uiConversation: {
      events: {
        register(def) {
          registeredEvents.push(def);
        },
      },
    },
    ...services,
    get(name) {
      return Object.prototype.hasOwnProperty.call(rawCtx, name) ? rawCtx[name] : undefined;
    },
  };
  // Strict Cordis-like Proxy context: throws on direct property reads of un-injected services.
  const ctx = new Proxy(rawCtx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
  return { ctx, registeredSlots, registeredEvents };
}

const ownBundle = { kind: 'bundle', pkg: { name: PACKAGE_NAME, version: '0.1.0', installed: true, enabled: true, rows: [] } };

test('client.js registers settings, turnTail and plugin page slots safely even without optional services', () => {
  const { React } = createReactStub();
  const mod = loadClientModule(React);
  const { ctx, registeredSlots, registeredEvents } = createStrictCtx({});

  mod.apply(ctx);
  assert.deepEqual(
    registeredSlots.map((s) => s.slotName).sort(),
    ['conversation.chat.turnTail', 'plugins.bundle.config', 'plugins.detail.actions', 'plugins.detail.badge', 'settings.section'],
  );

  const settingsSlot = registeredSlots.find((s) => s.slotName === 'settings.section');
  assert.equal(settingsSlot.meta.id, 'salesforge-settings');
  assert.equal(settingsSlot.meta.label, '销售管理配置');
  assert.equal(settingsSlot.meta.order, 31);

  const tailSlot = registeredSlots.find((s) => s.slotName === 'conversation.chat.turnTail');
  assert.equal(tailSlot.meta.id, 'salesforge-cards');
  assert.equal(tailSlot.meta.order, 26);

  assert.equal(registeredEvents.length, 1);
  assert.equal(registeredEvents[0].kind, 'salesforge');

  const expected = {
    'plugins.detail.actions': mod.DetailActions,
    'plugins.detail.badge': mod.DetailBadge,
  };
  const others = [
    { kind: 'bundle', pkg: { name: '@local/datahub-echarts', installed: true, enabled: true, rows: [] } },
    { kind: 'bundle', pkg: { name: '@local/contract-sure', installed: true, enabled: true, rows: [] } },
    { kind: 'row', pkg: ownBundle.pkg, row: { rowId: 'salesforge', moduleName: PACKAGE_NAME, enabled: true } },
    { kind: 'item', id: 'salesforge' },
    undefined,
  ];
  for (const [slotName, Component] of Object.entries(expected)) {
    const entry = registeredSlots.find((s) => s.slotName === slotName);
    assert.equal(entry.meta.name, slotName);
    for (const subject of others) {
      assert.equal(entry.component({ subject, t: (k) => k }), null, `${slotName} must ignore ${JSON.stringify(subject)}`);
    }
    const element = entry.component({ subject: ownBundle, t: (k) => k });
    assert.equal(element.type, Component, `${slotName} renders for ${PACKAGE_NAME}`);
    assert.ok(element.props.store && element.props.services);
  }

  // The examples panel sits in this bundle's own keyed cell (under the README), page view only.
  const examples = registeredSlots.find((s) => s.slotName === 'plugins.bundle.config');
  assert.equal(examples.meta.name, 'plugins.bundle.config');
  assert.equal(examples.meta.key, PACKAGE_NAME);
  const page = examples.component({ view: 'page' });
  assert.equal(page.type, mod.ExamplesSection);
  assert.ok(page.props.store && page.props.services);
  assert.equal(examples.component({ view: 'summary' }), null);
  assert.equal(examples.component(undefined), null);
});

test('status badge shows connected, invalid and not-connected states from the shared account store', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const cases = [
    { state: stateWith([ZHANG, LI], 'u7'), text: '已连接 · 张三' },
    { state: stateWith([ZHANG, LI], 'u9'), text: '授权已失效' },
    { state: stateWith([WANG], 'u11'), text: '授权已失效' },
    { state: stateWith([], null), text: '未连接' },
  ];
  for (const { state, text } of cases) {
    const rpc = createRpc({ getState: () => state });
    const store = mod.createAccountStore(() => rpc.connection);
    renderer.mount(renderer.h(mod.DetailBadge, { store, services: servicesFor(rpc.connection) }));
    assert.equal(textContent(renderer.tree), '', 'nothing before the state is read');
    await renderer.settle();
    assert.equal(textContent(collectNodes(renderer.tree, (n) => n.type === 'span' && /sfu-tag/.test(n.props.className))), text);
    renderer.unmount();
  }
});

test('account panel lists accounts with status and expiry, and never renders token fields', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  // A host that leaked a token into State must still not get it on screen.
  const leaky = { ...ZHANG, accessToken: 'secret-token-123', token: 'secret-token-456' };
  const rpc = createRpc({ getState: () => stateWith([leaky, LI, WANG], 'u7', { apiToken: 'secret-token-789' }) });
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.AccountPanel, { store, services: servicesFor(rpc.connection), settingsOpen: true }));
  await renderer.settle();

  const text = textContent(renderer.tree);
  assert.match(text, /已连接的账户/);
  assert.match(text, /张三/);
  assert.match(text, /zhangsan · 销售二部 · 2027-02-22 到期/);
  assert.match(text, /当前使用/);
  assert.match(text, /李四.*已过期/);
  assert.match(text, /王五.*已失效/);
  assert.match(text, /连接另一个账户/);
  assert.match(text, /服务器设置/);
  assert.doesNotMatch(text, /识别|OCR|Key/u);
  assert.match(text, /令牌保存在小智办公凭据存储中，界面不会显示令牌。/);

  const serialized = JSON.stringify(renderedDom(renderer.tree));
  assert.doesNotMatch(serialized, /secret-token/);
  const inputs = collectNodes(renderer.tree, (n) => n.type === 'input');
  assert.ok(inputs.every((i) => !/token/i.test(String(i.props['aria-label'] || '') + String(i.props.placeholder || ''))));
  assert.equal(rpc.count('getState'), 1);

  // Row order matches the State; only rows that need it offer an inline re-authorization.
  const rows = collectNodes(renderer.tree, (n) => n.type === 'li');
  assert.deepEqual(rows.map((r) => r.props['data-account-id']), ['u7', 'u9', 'u11']);
  assert.equal(findButton(rows[0], '重新授权'), undefined);
  assert.ok(findButton(rows[1], '重新授权'));

  // file credential store wording
  renderer.unmount();
  const rpc2 = createRpc({ getState: () => stateWith([], null, { credentialStore: 'file' }) });
  renderer.mount(renderer.h(mod.AccountPanel, { store: mod.createAccountStore(() => rpc2.connection), services: servicesFor(rpc2.connection) }));
  await renderer.settle();
  const emptyText = textContent(renderer.tree);
  assert.match(emptyText, /还没有连接销售管理系统账户。连接后，销售管理会用你的账号查询客户、项目、日报和销售目标。/);
  assert.ok(findButton(renderer.tree, '连接账户'));
  assert.equal(findButton(renderer.tree, '连接另一个账户'), undefined);
  assert.match(emptyText, /令牌保存在本机插件配置文件中（仅本人可读），界面不会显示令牌。/);
});

test('disconnecting an account asks for confirmation first, then revokes and refreshes the list', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({
    getState: () => stateWith([ZHANG, LI], 'u7'),
    disconnectAccount: ({ accountId }) => stateWith([LI], null, { removed: accountId, revoked: true }),
    setActiveAccount: ({ accountId }) => stateWith([ZHANG, LI], accountId),
  });
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.AccountPanel, { store, services: servicesFor(rpc.connection) }));
  await renderer.settle();

  // Switch the current account through the row menu.
  click(collectNodes(renderer.tree, (n) => n.type === 'button' && n.props['aria-label'] === '更多操作：李四（lisi）')[0]);
  await renderer.settle();
  assert.equal(collectNodes(renderer.tree, (n) => n.props && n.props.role === 'menu').length, 1, 'one row menu open');
  click(findButton(renderer.tree, '设为当前'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('setActiveAccount')), [{ accountId: 'u9' }]);
  assert.equal(store.getSnapshot().state.activeAccountId, 'u9');
  assert.match(textContent(renderer.tree), /已切换到 李四（lisi）/);

  click(collectNodes(renderer.tree, (n) => n.type === 'button' && n.props['aria-label'] === '更多操作：张三（zhangsan）')[0]);
  await renderer.settle();
  click(findButton(renderer.tree, '断开连接'));
  await renderer.settle();

  const confirmDialog = lastDialog(renderer.tree);
  assert.ok(confirmDialog, 'confirmation dialog opens');
  assert.match(textContent(confirmDialog), /断开 张三（zhangsan）？/);
  assert.match(textContent(confirmDialog), /断开后会在销售管理系统里吊销这台设备的授权/);
  assert.equal(rpc.count('disconnectAccount'), 0, 'nothing is revoked before confirming');

  click(findButton(confirmDialog, '断开连接'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('disconnectAccount')), [{ accountId: 'u7' }]);
  assert.equal(lastDialog(renderer.tree), undefined, 'confirmation closes');
  assert.deepEqual(plain(store.getSnapshot().state.accounts.map((a) => a.id)), ['u9']);
  assert.match(textContent(renderer.tree), /已断开 张三（zhangsan）/);
  assert.deepEqual(collectNodes(renderer.tree, (n) => n.type === 'li').map((r) => r.props['data-account-id']), ['u9']);

  // Cancelling keeps the account.
  click(collectNodes(renderer.tree, (n) => n.type === 'button' && n.props['aria-label'] === '更多操作：李四（lisi）')[0]);
  await renderer.settle();
  click(findButton(renderer.tree, '断开连接'));
  await renderer.settle();
  click(findButton(lastDialog(renderer.tree), '取消'));
  await renderer.settle();
  assert.equal(rpc.count('disconnectAccount'), 1);
});

test('disconnecting warns when the server did not confirm the revocation', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({
    getState: () => stateWith([ZHANG], 'u7'),
    disconnectAccount: () => stateWith([], null, { revoked: false }),
  });
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.AccountPanel, { store, services: servicesFor(rpc.connection) }));
  await renderer.settle();

  click(collectNodes(renderer.tree, (n) => n.type === 'button' && n.props['aria-label'] === '更多操作：张三（zhangsan）')[0]);
  await renderer.settle();
  click(findButton(renderer.tree, '断开连接'));
  await renderer.settle();
  click(findButton(lastDialog(renderer.tree), '断开连接'));
  await renderer.settle();

  assert.equal(store.getSnapshot().state.accounts.length, 0);
  const warn = collectNodes(renderer.tree, (n) => n.type === 'p' && String(n.props.className).includes('sfu-note-warn'));
  assert.equal(warn.length, 1);
  assert.match(textContent(warn[0]), /已在本机断开 张三（zhangsan），但销售管理系统没有确认吊销/);
  assert.match(textContent(warn[0]), /「插件授权」里手动吊销/);
});

test('authorization dialog opens the browser, polls pending → approved and updates the account store', async () => {
  const renderer = createRenderer();
  const timers = createFakeTimers();
  const opened = [];
  const mod = loadClientModule(renderer.React, { timers, windowOpen: (...args) => opened.push(args) });
  const rpc = authorizationRpc();
  const store = mod.createAccountStore(() => rpc.connection);
  const approved = [];
  let closed = 0;
  renderer.mount(renderer.h(mod.AuthorizeDialog, {
    store,
    services: servicesFor(rpc.connection),
    onClose: () => { closed += 1; },
    onApproved: (account) => approved.push(account),
  }));
  await renderer.settle();

  assert.deepEqual(opened, [['http://sales.test/plugin-authorize?req=req-1', '_blank', 'noopener']]);
  let text = textContent(renderer.tree);
  assert.match(text, /WXYZ-1234/);
  assert.match(text, /已在浏览器打开销售管理系统授权页，请确认校验码一致后点「授权」/);
  const link = collectNodes(renderer.tree, (n) => n.type === 'a')[0];
  assert.equal(link.props.href, 'http://sales.test/plugin-authorize?req=req-1');
  assert.equal(link.props.target, '_blank');
  assert.match(textContent(link), /没有自动打开？点这里打开授权页/);
  assert.deepEqual(timers.delays(), [2000], 'polls with the returned interval');

  timers.runAll();
  await renderer.settle();
  assert.equal(rpc.count('pollAuthorization'), 1);
  assert.deepEqual(plain(rpc.argsOf('pollAuthorization')[0]), { requestId: 'req-1' });
  assert.deepEqual(timers.delays(), [2000], 'still pending: polls again');
  assert.match(textContent(renderer.tree), /WXYZ-1234/);

  timers.runAll();
  await renderer.settle();
  text = textContent(renderer.tree);
  assert.match(text, /已连接：张三（zhangsan）/);
  assert.deepEqual(timers.delays(), [], 'polling stops once approved');
  assert.equal(approved.length, 1);
  assert.equal(approved[0].username, 'zhangsan');
  assert.equal(store.getSnapshot().state.activeAccountId, 'u7');
  assert.equal(rpc.count('cancelAuthorization'), 0);
  click(findButton(renderer.tree, '完成'));
  assert.equal(closed, 1);
});

test('authorization dialog stops polling on unmount, cancels on 取消, and offers retry after denial or expiry', async () => {
  const renderer = createRenderer();
  const timers = createFakeTimers();
  const mod = loadClientModule(renderer.React, { timers });

  // Unmount while waiting: polling stops, the host request is left to finish in the browser.
  const rpc = authorizationRpc();
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.AuthorizeDialog, { store, services: servicesFor(rpc.connection), onClose() {} }));
  await renderer.settle();
  assert.deepEqual(timers.delays(), [2000]);
  renderer.unmount();
  assert.deepEqual(timers.delays(), [], 'no poll is left scheduled');
  await renderer.settle();
  assert.equal(rpc.count('pollAuthorization'), 0);
  assert.equal(rpc.count('cancelAuthorization'), 0);

  // 取消 calls cancelAuthorization with the request and closes.
  let closed = 0;
  renderer.mount(renderer.h(mod.AuthorizeDialog, { store, services: servicesFor(rpc.connection), onClose: () => { closed += 1; } }));
  await renderer.settle();
  click(findButton(renderer.tree, '取消'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('cancelAuthorization')), [{ requestId: 'req-1' }]);
  assert.equal(closed, 1);
  assert.deepEqual(timers.delays(), []);
  renderer.unmount();

  // Denied, expired and error results each offer 重试, which starts a new request.
  for (const [result, pattern] of [
    [{ status: 'denied' }, /你在销售管理系统里拒绝了这次授权/],
    [{ status: 'expired' }, /授权请求已过期/],
    [{ status: 'error', message: '销售管理系统暂时不可用' }, /销售管理系统暂时不可用/],
  ]) {
    const rpc2 = authorizationRpc({ pollAuthorization: () => result });
    renderer.mount(renderer.h(mod.AuthorizeDialog, { store, services: servicesFor(rpc2.connection), onClose() {} }));
    await renderer.settle();
    timers.runAll();
    await renderer.settle();
    assert.match(textContent(renderer.tree), pattern);
    assert.deepEqual(timers.delays(), []);
    click(findButton(renderer.tree, '重试'));
    await renderer.settle();
    assert.equal(rpc2.count('startAuthorization'), 2);
    assert.match(textContent(renderer.tree), /WXYZ-1234/);
    renderer.unmount();
    timers.runAll();
  }
});

test('试用 opens a session with the default prompt when an account works, and authorizes first when not', async () => {
  const renderer = createRenderer();
  const timers = createFakeTimers();
  const mod = loadClientModule(renderer.React, { timers });

  const sessions = [];
  const workspace = { startSession: (id, options) => { sessions.push({ id, options }); return Promise.resolve(); } };

  // With a usable account, through the real slot registration.
  const rpc = createRpc({ getState: () => stateWith([ZHANG], 'u7') });
  const { ctx, registeredSlots } = createStrictCtx({ connection: rpc.connection, uiWorkspace: workspace });
  mod.apply(ctx);
  const actions = registeredSlots.find((s) => s.slotName === 'plugins.detail.actions').component;
  renderer.mount(renderer.h(actions, { subject: ownBundle }));
  await renderer.settle();
  assert.ok(findButton(renderer.tree, '管理'));
  click(findButton(renderer.tree, '试用'));
  await renderer.settle();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, undefined);
  const TRY = '帮我盘一下本季度的销售情况：目标完成了多少、还差多少，接下来该重点跟进哪些项目';
  assert.deepEqual(plain(sessions[0].options), { prompt: TRY, whenDraftExists: 'append' });
  assert.equal(mod.TRY_PROMPT, TRY);
  assert.deepEqual(plain(mod.EXAMPLE_PROMPTS), [
    '看看我本季度的销售目标完成了多少、还差多少，再列出预计本季度签约但还没签下来的项目，按金额从大到小排，有时间风险或赢单风险的单独标出来',
    '找出我负责的、超过 30 天没跟进的客户和渠道，按未跟进天数从多到少排成一张表，挑最久的五家看看上次拜访都聊了什么',
    '汇总我这周的日报和下周的周计划：这周拜访了哪些客户和渠道、各谈到了哪一步，下周打算跟进谁，整理成几条要点给我',
  ]);
  assert.equal(rpc.count('startAuthorization'), 0);

  // An example card uses its own text.
  const section = registeredSlots.find((s) => s.slotName === 'plugins.bundle.config').component;
  renderer.mount(renderer.h(section, { view: 'page' }));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /试试这样问/);
  const exampleSection = collectNodes(renderer.tree, (n) => n.type === 'section' && n.props['aria-label'] === '试试这样问');
  assert.equal(exampleSection.length, 1);
  assert.equal(collectNodes(renderer.tree, (n) => n.type === 'button' && /\bsfx-card\b/.test(n.props.className)).length, 3);
  click(findButton(renderer.tree, mod.EXAMPLE_PROMPTS[1]));
  await renderer.settle();
  assert.equal(sessions[1].options.prompt, mod.EXAMPLE_PROMPTS[1]);
  renderer.unmount();

  // Without an account: authorize first, then open the session.
  sessions.length = 0;
  const rpc2 = authorizationRpc();
  const store2 = mod.createAccountStore(() => rpc2.connection);
  renderer.mount(renderer.h(mod.DetailActions, { store: store2, services: servicesFor(rpc2.connection, { workspace }) }));
  await renderer.settle();
  click(findButton(renderer.tree, '试用'));
  await renderer.settle();
  assert.equal(rpc2.count('startAuthorization'), 1);
  assert.equal(sessions.length, 0, 'no session before the account is connected');
  assert.match(textContent(renderer.tree), /试用前需要先连接销售管理系统账户/);
  timers.runAll();
  await renderer.settle();
  timers.runAll();
  await renderer.settle();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].options.prompt, mod.TRY_PROMPT);
  assert.equal(lastDialog(renderer.tree), undefined, 'the authorization dialog closes');
  renderer.unmount();

  // Without uiWorkspace: show the prompt to copy instead.
  const rpc3 = createRpc({ getState: () => stateWith([ZHANG], 'u7') });
  renderer.mount(renderer.h(mod.DetailActions, { store: mod.createAccountStore(() => rpc3.connection), services: servicesFor(rpc3.connection) }));
  await renderer.settle();
  click(findButton(renderer.tree, '试用'));
  await renderer.settle();
  const fallback = lastDialog(renderer.tree);
  assert.match(textContent(fallback), /当前页面不支持直接开始新会话，请手动新建会话后输入：/);
  assert.equal(collectNodes(fallback, (n) => n.type === 'textarea')[0].props.value, mod.TRY_PROMPT);
  assert.ok(findButton(fallback, '复制'));
});

function styleText(tree) {
  return collectNodes(tree, (n) => n.type === 'style').map(textContent).join('\n');
}

test('examples panel: each glass card asks its own question, backgrounds come from the package asset route', async () => {
  const renderer = createRenderer();
  const asked = [];
  const mod = loadClientModule(renderer.React, { asset: (ref) => { asked.push(ref); return `/served/${ref}`; } });
  const sessions = [];
  const workspace = { startSession: (id, options) => { sessions.push({ id, options }); return Promise.resolve(); } };
  const rpc = createRpc({ getState: () => stateWith([ZHANG], 'u7') });
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.ExamplesSection, { store, services: servicesFor(rpc.connection, { workspace }) }));
  await renderer.settle();

  assert.deepEqual(asked, [
    `plugins/${PACKAGE_NAME}/assets/${mod.EXAMPLES_LOOK.backgrounds[0]}`,
    `plugins/${PACKAGE_NAME}/assets/${mod.EXAMPLES_LOOK.backgrounds[1]}`,
  ]);
  const section = collectNodes(renderer.tree, (n) => n.type === 'section')[0];
  assert.equal(section.props.style['--sfx-img-l'], `url("/served/plugins/${PACKAGE_NAME}/assets/${mod.EXAMPLES_LOOK.backgrounds[0]}")`);
  assert.equal(section.props.style['--sfx-img-d'], `url("/served/plugins/${PACKAGE_NAME}/assets/${mod.EXAMPLES_LOOK.backgrounds[1]}")`);
  assert.equal(section.props.style['--sfx-brand-l'], '#C2410C');
  assert.equal(section.props.style['--sfx-brand-d'], '#FDBA74');
  assert.match(textContent(renderer.tree), /点一下会打开新对话并填好问题，按回车发送/);

  const cards = collectNodes(renderer.tree, (n) => n.type === 'button' && /sfx-card/.test(n.props.className));
  assert.equal(cards.length, 3);
  assert.equal(mod.EXAMPLE_PROMPTS.length, 3);
  cards.forEach((card, i) => {
    assert.equal(textContent(card), `销售管理${mod.EXAMPLE_PROMPTS[i]}`);
    const img = collectNodes(card, (n) => n.type === 'img')[0];
    assert.equal(img.props.src, mod.EXAMPLES_LOOK.icon);
    assert.equal(img.props.alt, '');
  });
  for (let i = 0; i < cards.length; i++) {
    click(collectNodes(renderer.tree, (n) => n.type === 'button' && /sfx-card/.test(n.props.className))[i]);
    await renderer.settle();
  }
  assert.deepEqual(sessions.map((s) => plain(s.options)), plain(mod.EXAMPLE_PROMPTS).map((prompt) => ({ prompt, whenDraftExists: 'append' })));
  assert.equal(rpc.count('startAuthorization'), 0);
  renderer.unmount();
});

test('examples panel falls back to its CSS gradient without require.asset or when it throws', async () => {
  for (const options of [{}, { asset: () => { throw new Error('no route'); } }, { asset: () => '' }]) {
    const renderer = createRenderer();
    const mod = loadClientModule(renderer.React, options);
    const rpc = createRpc({ getState: () => stateWith([], null) });
    renderer.mount(renderer.h(mod.ExamplesSection, { store: mod.createAccountStore(() => rpc.connection), services: servicesFor(rpc.connection) }));
    await renderer.settle();
    const style = collectNodes(renderer.tree, (n) => n.type === 'section')[0].props.style;
    assert.equal(style['--sfx-img-l'], 'none');
    assert.equal(style['--sfx-img-d'], 'none');
    assert.match(style['--sfx-fallback-l'], /^radial-gradient\(.+#fcecee$/);
    assert.match(style['--sfx-fallback-d'], /^radial-gradient\(.+#1a1124$/);
    const css = styleText(renderer.tree);
    assert.match(css, /\.sfx-panel\{[^}]*background:var\(--sfx-fallback\)/);
    assert.match(css, /\.sfx-bg-img\{[^}]*background-image:var\(--sfx-img\)/);
    assert.match(css, /body\[data-ds-dark-theme\] \.sfx\{[^}]*--sfx-img:var\(--sfx-img-d,none\)/);
    // Dark glass cards are tinted plum to sit on this plugin's warm purple artwork.
    assert.match(css, /body\[data-ds-dark-theme\] \.sfx\{[^}]*--sfx-card-bg:rgba\(20,12,28,\.46\);--sfx-card-bg-hover:rgba\(30,18,40,\.6\)/);
    assert.equal(collectNodes(renderer.tree, (n) => n.type === 'button' && /sfx-card/.test(n.props.className)).length, 3);
    renderer.unmount();
  }
});

test('examples panel motion: reduced-motion CSS switch, and the pointer light batches moves into one frame', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({ getState: () => stateWith([ZHANG], 'u7') });
  renderer.mount(renderer.h(mod.ExamplesSection, { store: mod.createAccountStore(() => rpc.connection), services: servicesFor(rpc.connection) }));
  await renderer.settle();
  const css = styleText(renderer.tree);
  const reduced = css.match(/@media \(prefers-reduced-motion:reduce\)\{(\.sfx-.*)\}$/m);
  assert.ok(reduced, 'a prefers-reduced-motion block exists');
  assert.match(reduced[1], /\.sfx-bg-img\{inset:0;animation:none\}/);
  assert.match(reduced[1], /\.sfx-glow\{display:none\}/);
  assert.match(reduced[1], /\.sfx-card\{animation:none;/);
  assert.match(reduced[1], /translate:none;scale:none/);
  assert.match(css, /\.sfx-card:focus-visible\{outline:2px solid var\(--sfx-brand\)/);
  renderer.unmount();

  function fakePanel() {
    const listeners = {};
    const props = {};
    const attrs = new Set();
    return {
      listeners, props, attrs,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      removeEventListener: (type, fn) => { if (listeners[type] === fn) delete listeners[type]; },
      getBoundingClientRect: () => ({ left: 100, top: 50 }),
      style: { setProperty: (k, v) => { props[k] = v; } },
      setAttribute: (k) => attrs.add(k),
      removeAttribute: (k) => attrs.delete(k),
    };
  }
  function fakeWindow(reduce) {
    const frames = [];
    return {
      frames,
      matchMedia: (q) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }),
      requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
      cancelAnimationFrame: () => {},
    };
  }

  // Reduced motion: no listeners at all.
  const still = fakePanel();
  const detachStill = mod.attachPointerGlow(still, fakeWindow(true));
  assert.deepEqual(Object.keys(still.listeners), []);
  detachStill();

  // Several moves before a frame paint once, at the last position, relative to the panel.
  const panel = fakePanel();
  const win = fakeWindow(false);
  const detach = mod.attachPointerGlow(panel, win);
  panel.listeners.pointerenter({ pointerType: 'mouse', clientX: 110, clientY: 60 });
  panel.listeners.pointermove({ pointerType: 'mouse', clientX: 150, clientY: 80 });
  panel.listeners.pointermove({ pointerType: 'mouse', clientX: 300, clientY: 170 });
  assert.equal(win.frames.length, 1);
  assert.ok(panel.attrs.has('data-glow'));
  assert.deepEqual(panel.props, {});
  win.frames[0]();
  assert.deepEqual(panel.props, { '--sfx-x': '200px', '--sfx-y': '120px' });
  panel.listeners.pointermove({ pointerType: 'touch', clientX: 0, clientY: 0 });
  assert.equal(win.frames.length, 1, 'touch does not move the light');
  panel.listeners.pointerleave({ pointerType: 'mouse' });
  assert.ok(!panel.attrs.has('data-glow'));
  detach();
  assert.deepEqual(Object.keys(panel.listeners), []);

  // No element or no window: nothing to attach.
  assert.equal(typeof mod.attachPointerGlow(null, win), 'function');
  assert.equal(typeof mod.attachPointerGlow(fakePanel(), null), 'function');
});

test('the card icon is icon.svg itself, a small flat SVG, and the backgrounds ship under content-hashed names', () => {
  const { React } = createReactStub();
  const mod = loadClientModule(React);
  const svg = readFileSync(join(__dirname, 'icon.svg'), 'utf8');
  assert.equal(decodeURIComponent(mod.EXAMPLES_LOOK.icon.replace(/^data:image\/svg\+xml,/, '')), svg);
  assert.ok(Buffer.byteLength(svg) <= 4096, 'icon.svg stays under 4 KB');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48">/);
  assert.doesNotMatch(svg, /<script|<image|<filter|href=|stroke|<text|url\((?!#)/i);

  const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./icon'], './icon.svg');
  assert.equal(pkg.exports['./assets/*'], './lib/assets/*');
  assert.ok(pkg.files.includes('icon.svg') && pkg.files.includes('lib/assets'));
  const names = [...mod.EXAMPLES_LOOK.backgrounds];
  assert.deepEqual(names.map((n) => n.replace(/-[0-9a-f]{12}\.webp$/, '')), ['examples-bg-light', 'examples-bg-dark']);
  for (const name of names) {
    const bytes = readFileSync(join(__dirname, 'lib', 'assets', name));
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP');
    assert.equal(name.slice(-17, -5), createHash('sha1').update(bytes).digest('hex').slice(0, 12), `${name} is named by its content`);
  }
});

test('auth-required tool results project into one card per turn, titled by reason, that connects in place', async () => {
  const renderer = createRenderer();
  const timers = createFakeTimers();
  const mod = loadClientModule(renderer.React, { timers });

  const payload = {
    kind: 'salesforge-auth-required',
    reason: 'expired',
    serverUrl: 'http://sales.test/api/v1',
    message: '销售管理系统授权已过期（账户：张三），请点下方卡片的「连接账户」重新授权后，回复「继续」。',
  };
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'tool/call', seq: 5, data: { turn: 3, callId: 'c1', name: 'sales_dashboard' } },
    { type: 'tool/result', seq: 6, surfaceOp: 'append', data: { turn: 3, callId: 'c1', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } },
    { type: 'tool/call', seq: 7, data: { turn: 3, callId: 'c2', name: 'read_file' } },
    { type: 'tool/result', seq: 8, surfaceOp: 'append', data: { turn: 3, callId: 'c2', result: { content: [{ type: 'text', text: 'plain output' }] } } },
  ];

  // Browser projection and its Node mirror agree.
  const def = mod.eventDefinition;
  assert.deepEqual(plain(def.match(events[1])), { id: '3', role: 'start' });
  let state = def.start({}, { event: events[1] });
  for (const event of events.slice(2)) state = def.update({ state }, { event });
  const location = def.buildLocationData({ state }, 'turn', null);
  const expected = {
    seq: 6, callId: 'c1', toolName: 'sales_dashboard', reason: 'expired',
    message: payload.message, serverUrl: 'http://sales.test/api/v1',
  };
  assert.deepEqual(plain(location.value.authRequired), expected);
  assert.deepEqual(projectEvents(events).authRequired, expected);
  assert.equal(projectEvents(events.slice(0, 1)).authRequired, null);

  // TurnTail renders the card from the projection.
  const rpc = authorizationRpc();
  const store = mod.createAccountStore(() => rpc.connection);
  const opened = [];
  const services = servicesFor(rpc.connection, { navigation: { openBundle: (name) => opened.push(name) } });
  const turn = { turn: 3, data: new Map([[location.key, location.value]]) };
  renderer.mount(renderer.h(mod.TurnTail, { turn, store, services }));
  await renderer.settle();
  let text = textContent(renderer.tree);
  assert.match(text, /销售管理系统授权已过期/);
  assert.match(text, /请点下方卡片的「连接账户」/);

  // Connect from the card.
  click(findButton(renderer.tree, '连接账户'));
  await renderer.settle();
  timers.runAll();
  await renderer.settle();
  timers.runAll();
  await renderer.settle();
  click(findButton(lastDialog(renderer.tree), '完成'));
  await renderer.settle();
  text = textContent(renderer.tree);
  assert.match(text, /已连接：张三，回复「继续」即可/);
  click(findButton(renderer.tree, '管理账户'));
  assert.deepEqual(opened, ['@local/salesforge']);
  renderer.unmount();

  // Titles per reason.
  for (const [reason, title] of [
    ['no-account', '还没有连接销售管理系统账户'],
    ['expired', '销售管理系统授权已过期'],
    ['revoked', '销售管理系统授权已失效'],
  ]) {
    const rpc2 = createRpc({ getState: () => stateWith([], null) });
    renderer.mount(renderer.h(mod.AuthRequiredCard, {
      info: { reason, message: '请先连接。' },
      store: mod.createAccountStore(() => rpc2.connection),
      services: servicesFor(rpc2.connection),
    }));
    await renderer.settle();
    const cardText = textContent(renderer.tree);
    assert.match(cardText, new RegExp(title));
    assert.match(cardText, /请先连接。/);
    assert.ok(findButton(renderer.tree, '连接账户'));
    assert.equal(findButton(renderer.tree, '管理账户'), undefined, 'no plugin page link without pluginNavigation');
    renderer.unmount();
  }
});

function reportDraftEvents(payload, extra = []) {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'tool/call', seq: 5, data: { turn: 3, callId: 'r1', name: 'sales_draft_work_report' } },
    { type: 'tool/result', seq: 6, surfaceOp: 'append', data: { turn: 3, callId: 'r1', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } },
    ...extra,
  ];
}

function runDefinition(def, events) {
  let state = def.start({}, { event: events[1] });
  for (const event of events.slice(2)) state = def.update({ state }, { event });
  return def.buildLocationData({ state }, 'turn', null);
}

const REPORT_PAYLOAD = {
  kind: 'salesforge-report-draft',
  draftId: 'report_0123456789abcdef',
  status: 'staged',
  draft: { reportDate: '2026-11-26', targetType: 1, targetName: '华光科技', targetId: 1001, contactId: null, workPlan: '下周提交报价', workSummary: '演示了数据平台', targetTypeLabel: '客户' },
  contacts: [
    { contactId: 31, contactName: '刘老师', position: '信息中心主任' },
    { contactId: 32, contactName: '陈工', position: '' },
  ],
  notes: ['「华光科技」的联系人里没有「王老师」，请用户在卡片上选择拜访人。'],
  hint: '日报草稿已显示在卡片上，还没有提交。',
};

const findAll = (tree, type) => collectNodes(tree, (n) => n.type === type);
const change = (node, value) => node.props.onChange({ target: { value } });

test('report drafts project into an editable card that writes only when 提交日报 is clicked, matching the Node projection', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const def = mod.eventDefinition;
  const events = reportDraftEvents(REPORT_PAYLOAD);

  // Browser projection and its Node mirror agree.
  assert.deepEqual(plain(def.match(events[2])), { id: '3', role: 'start' });
  const location = runDefinition(def, events);
  assert.deepEqual(plain(location.value.reportDrafts), projectEvents(events).reportDrafts);
  assert.equal(location.value.reportDrafts.length, 1);
  assert.equal(location.value.authRequired, null);

  let submits = 0;
  const rpc = createRpc({
    submitReportDraft: (args) => {
      submits += 1;
      if (submits === 1) throw new Error('当前连接的销售管理系统账户和生成草稿时不同，请让助手重新生成草稿。');
      return { kind: 'salesforge-report-submitted', draftId: args.draftId, reportId: 9001, alreadySubmitted: false };
    },
  });
  const turn = { turn: 3, data: new Map([[location.key, location.value]]) };
  renderer.mount(renderer.h(mod.TurnTail, { turn, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  let text = textContent(renderer.tree);
  assert.match(text, /工作日报草稿/);
  assert.match(text, /未提交/);
  assert.match(text, /点「提交日报」后才会写入/);
  // 卡片自带样式表，和授权卡片一样不依赖别的界面先注入。
  assert.ok(findAll(renderer.tree, 'style').some((n) => textContent(n).includes('.sfu-report{')));
  assert.match(text, /没有「王老师」/);
  assert.equal(findAll(renderer.tree, 'input').find((n) => n.props.value === '客户 · 华光科技').props.disabled, true, '拜访对象不能改');
  const options = findAll(renderer.tree, 'option').map((n) => textContent(n));
  assert.deepEqual(options, ['请选择拜访人', '刘老师 - 信息中心主任', '陈工']);
  assert.equal(rpc.count('submitReportDraft'), 0, '显示卡片不提交');

  // 没选拜访人、日期格式不对：卡片上直接提示，不发请求。
  click(findButton(renderer.tree, '提交日报'));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /请选择拜访人。/);
  change(findAll(renderer.tree, 'select')[0], '32');
  change(findAll(renderer.tree, 'input')[0], '2026/11/26');
  await renderer.settle();
  click(findButton(renderer.tree, '提交日报'));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /YYYY-MM-DD/);
  assert.equal(rpc.count('submitReportDraft'), 0);

  // 宿主拒绝时显示原因，按钮还在，可以重试。
  change(findAll(renderer.tree, 'input')[0], '2026-11-25');
  change(findAll(renderer.tree, 'textarea')[0], '  演示了数据平台，约了下周报价 ');
  await renderer.settle();
  click(findButton(renderer.tree, '提交日报'));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /账户和生成草稿时不同/);
  assert.ok(findButton(renderer.tree, '提交日报'));

  click(findButton(renderer.tree, '提交日报'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('submitReportDraft')[1]), {
    draftId: 'report_0123456789abcdef',
    edited: { reportDate: '2026-11-25', contactId: 32, workPlan: '下周提交报价', workSummary: '演示了数据平台，约了下周报价' },
  });
  text = textContent(renderer.tree);
  assert.match(text, /已提交 · 日报 #9001/);
  assert.match(text, /已以你的名义写入销售管理系统/);
  assert.equal(findButton(renderer.tree, '提交日报'), undefined);
  assert.ok(findAll(renderer.tree, 'textarea').every((n) => n.props.disabled), '提交后不能再改');
  renderer.unmount();
});

test('a submitted record keeps the card submitted after reload; drafts without contacts cannot be submitted', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const def = mod.eventDefinition;

  const submittedReport = { reportDate: '2026-11-25', contactId: 32, workPlan: '下周提交报价', workSummary: '演示了数据平台，约了下周报价' };
  const record = { type: 'plugin:salesforge/report-submitted', seq: 9, data: { version: 1, turn: 3, draftId: 'report_0123456789abcdef', reportId: 9001, report: submittedReport } };
  const events = reportDraftEvents(REPORT_PAYLOAD, [record]);
  assert.deepEqual(plain(def.match(record)), { id: '3', role: 'start' });
  const location = runDefinition(def, events);
  assert.deepEqual(plain(location.value.submittedByDraftId), { report_0123456789abcdef: { reportId: 9001, report: submittedReport } });
  assert.deepEqual(plain(location.value.submittedByDraftId), projectEvents(events).submittedByDraftId);
  // replace 掉的记录不算。
  const replaced = [...events, { type: 'system/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 }, data: { turn: 3 } }];
  assert.deepEqual(plain(runDefinition(def, replaced).value.submittedByDraftId), {});
  assert.deepEqual(projectEvents(replaced).submittedByDraftId, {});

  const rpc = createRpc({});
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 3, data: new Map([[location.key, location.value]]) }, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  let text = textContent(renderer.tree);
  assert.match(text, /已提交 · 日报 #9001/);
  assert.doesNotMatch(text, /没有「王老师」/, '已提交的卡片不再显示提示');
  assert.equal(findButton(renderer.tree, '提交日报'), undefined);
  // 显示实际提交的内容，而不是最初的草稿。
  assert.equal(findAll(renderer.tree, 'select')[0].props.value, '32');
  assert.equal(findAll(renderer.tree, 'input')[0].props.value, '2026-11-25');
  assert.equal(findAll(renderer.tree, 'textarea')[0].props.value, '演示了数据平台，约了下周报价');
  renderer.unmount();

  // 客户还没有联系人：拜访人一栏提示先去网页添加，点提交只提示不发请求。
  const empty = { ...REPORT_PAYLOAD, draftId: 'report_fedcba9876543210', contacts: [], notes: [] };
  const emptyLocation = runDefinition(def, reportDraftEvents(empty));
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 3, data: new Map([[emptyLocation.key, emptyLocation.value]]) }, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  assert.equal(findAll(renderer.tree, 'select').length, 0);
  assert.ok(findAll(renderer.tree, 'input').some((n) => n.props.value === '还没有联系人，请先在网页里添加'));
  click(findButton(renderer.tree, '提交日报'));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /这个客户还没有联系人，请先在销售管理系统网页里添加联系人。/);
  assert.equal(rpc.count('submitReportDraft'), 0);
  renderer.unmount();

  // 同一回合既有草稿又要授权：两张卡片都显示。
  const auth = { kind: 'salesforge-auth-required', reason: 'expired', serverUrl: 'http://sales.test/api/v1', message: '授权已过期，请重新连接。' };
  const both = reportDraftEvents(REPORT_PAYLOAD, [
    { type: 'tool/call', seq: 7, data: { turn: 3, callId: 'c2', name: 'sales_targets' } },
    { type: 'tool/result', seq: 8, surfaceOp: 'append', data: { turn: 3, callId: 'c2', result: { content: [{ type: 'text', text: JSON.stringify(auth) }] } } },
  ]);
  const bothLocation = runDefinition(def, both);
  const store = mod.createAccountStore(() => createRpc({ getState: () => stateWith([], null) }).connection);
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 3, data: new Map([[bothLocation.key, bothLocation.value]]) }, store, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  text = textContent(renderer.tree);
  assert.match(text, /工作日报草稿/);
  assert.match(text, /授权已过期，请重新连接。/);
  renderer.unmount();
});

const DELETE_PAYLOAD = {
  kind: 'salesforge-action-pending',
  actionId: 'act_0123456789abcdef',
  action: 'delete',
  type: 'work_report',
  typeLabel: '日报',
  title: '删除 2 条日报',
  items: [
    { id: 596, label: '2026-11-20 华光科技 · 刘老师（张三）：演示了数据平台' },
    { id: 597, label: '2026-11-21 华光渠道 · 周总（张三）：沟通合作' },
  ],
  skipped: [{ id: 598, reason: '不存在或不在你的数据范围内' }],
  status: 'pending',
  hint: '已在对话里显示「确认删除」卡片，还没有删除。',
};

function actionEvents(payload, extra = []) {
  return [
    { type: 'turn/start', seq: 1, data: { turn: 4 } },
    { type: 'tool/call', seq: 5, data: { turn: 4, callId: 'd1', name: 'sales_delete' } },
    { type: 'tool/result', seq: 6, surfaceOp: 'append', data: { turn: 4, callId: 'd1', result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } },
    ...extra,
  ];
}

test('a pending delete projects into a confirmation card that deletes only when 确认删除 is clicked, matching the Node projection', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const def = mod.eventDefinition;
  const events = actionEvents(DELETE_PAYLOAD);
  const location = runDefinition(def, events);
  assert.deepEqual(plain(location.value.pendingActions), projectEvents(events).pendingActions);
  assert.equal(location.value.pendingActions.length, 1);
  assert.equal(location.value.pendingActions[0].actionId, 'act_0123456789abcdef');

  let confirms = 0;
  const rpc = createRpc({
    confirmAction: (args) => {
      confirms += 1;
      if (confirms === 1) throw new Error('销售管理系统账户未连接或授权已失效，请先在「设置 → 销售管理配置」重新连接，再点确认。');
      return {
        kind: 'salesforge-action-done',
        actionId: args.actionId,
        action: 'delete',
        status: 'partial',
        results: [{ id: 596, ok: true }, { id: 597, ok: false, error: '没有权限做这项操作：只有报告人本人或管理员可以修改、删除这份工作报告。' }],
      };
    },
  });
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 4, data: new Map([[location.key, location.value]]) }, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  let text = textContent(renderer.tree);
  assert.match(text, /删除 2 条日报/);
  assert.match(text, /待确认/);
  assert.match(text, /删除后不能在系统里恢复。点「确认删除」后才会执行/);
  assert.match(text, /2026-11-20 华光科技 · 刘老师/);
  assert.match(text, /ID 598：不存在或不在你的数据范围内/);
  assert.ok(findAll(renderer.tree, 'style').some((n) => textContent(n).includes('.sfu-action-list{')));
  assert.equal(rpc.count('confirmAction'), 0, '显示卡片不删除');

  // 宿主拒绝时显示原因，按钮还在。
  click(findButton(renderer.tree, '确认删除'));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /授权已失效/);
  assert.ok(findButton(renderer.tree, '确认删除'));

  click(findButton(renderer.tree, '确认删除'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('confirmAction')[1]), { actionId: 'act_0123456789abcdef' });
  text = textContent(renderer.tree);
  assert.match(text, /部分完成/);
  assert.match(text, /已删除/);
  assert.match(text, /只有报告人本人或管理员/);
  assert.equal(findButton(renderer.tree, '确认删除'), undefined);
  assert.equal(findButton(renderer.tree, '取消'), undefined);
  renderer.unmount();
});

test('the action record keeps the card settled after reload; 取消 cancels a pending transfer', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const def = mod.eventDefinition;
  const record = { type: 'plugin:salesforge/action-done', seq: 9, data: { version: 1, turn: 4, actionId: 'act_0123456789abcdef', status: 'done', results: [{ id: 596, ok: true }, { id: 597, ok: true }] } };
  const events = actionEvents(DELETE_PAYLOAD, [record]);
  assert.deepEqual(plain(def.match(record)), { id: '4', role: 'start' });
  const location = runDefinition(def, events);
  assert.deepEqual(plain(location.value.actionStatusById), projectEvents(events).actionStatusById);
  assert.equal(location.value.actionStatusById.act_0123456789abcdef.status, 'done');
  const replaced = [...events, { type: 'system/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 9, endSeq: 9 }, data: { turn: 4 } }];
  assert.deepEqual(plain(runDefinition(def, replaced).value.actionStatusById), {});

  const rpc = createRpc({ cancelAction: (args) => ({ actionId: args.actionId, status: 'cancelled' }) });
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 4, data: new Map([[location.key, location.value]]) }, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  let text = textContent(renderer.tree);
  assert.match(text, /已删除/);
  assert.match(text, /已从销售管理系统里删除/);
  assert.doesNotMatch(text, /ID 598/, '已执行的卡片不再显示跳过的条目');
  assert.equal(findButton(renderer.tree, '确认删除'), undefined);
  renderer.unmount();

  const transfer = {
    ...DELETE_PAYLOAD,
    actionId: 'act_fedcba9876543210',
    action: 'transfer',
    type: 'customer',
    typeLabel: '客户',
    title: '把 1 个客户移交给李四',
    items: [{ id: 1001, label: '客户「华光科技」 · 负责人 张三' }],
    toUser: { userId: 23, realName: '李四' },
    includeProjects: true,
    skipped: [],
  };
  const transferLocation = runDefinition(def, actionEvents(transfer));
  renderer.mount(renderer.h(mod.TurnTail, { turn: { turn: 4, data: new Map([[transferLocation.key, transferLocation.value]]) }, services: servicesFor(rpc.connection) }));
  await renderer.settle();
  text = textContent(renderer.tree);
  assert.match(text, /把 1 个客户移交给李四/);
  assert.match(text, /将移交给「李四」，并一并移交原负责人在其下跟进中的项目/);
  assert.ok(findButton(renderer.tree, '确认移交'));
  click(findButton(renderer.tree, '取消'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('cancelAction')[0]), { actionId: 'act_fedcba9876543210' });
  assert.match(textContent(renderer.tree), /已取消，没有移交任何数据/);
  assert.equal(findButton(renderer.tree, '确认移交'), undefined);
  assert.equal(rpc.count('confirmAction'), 0);
  renderer.unmount();
});

test('settings page reuses the account panel; changing the server asks first and disconnects accounts', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({
    getState: () => stateWith([ZHANG], 'u7'),
    saveSettings: ({ patch }) => stateWith(patch.disconnectAccounts ? [] : [ZHANG], patch.disconnectAccounts ? null : 'u7', {
      serverUrl: patch.serverUrl || 'http://sales.test/api/v1',
    }),
    testConnection: ({ serverUrl }) => (serverUrl === 'http://sales.test/api/v1'
      ? { ok: true, message: '连接正常', account: { userId: 7, username: 'zhangsan', realName: '张三', deptName: '销售二部' } }
      : { ok: true, message: '可以连接这个销售管理系统。保存设置后原来的账户会断开，再点「连接账户」重新授权。' }),
  });
  const store = mod.createAccountStore(() => rpc.connection);
  const services = servicesFor(rpc.connection, { navigation: { openBundle() {} } });
  renderer.mount(renderer.h(mod.SettingsSection, { store, services }));
  await renderer.settle();

  let text = textContent(renderer.tree);
  assert.match(text, /也可以在插件页的「管理」里管理账户/);
  assert.match(text, /已连接的账户/);
  assert.doesNotMatch(text, /密码|apiToken|长期访问令牌/);
  assert.equal(collectNodes(renderer.tree, (n) => n.type === 'input' && n.props.type === 'password').length, 0);

  click(findButton(renderer.tree, '测试连接'));
  await renderer.settle();
  assert.equal(rpc.count('testConnection'), 1);
  assert.deepEqual(plain(rpc.argsOf('testConnection')[0]), { serverUrl: 'http://sales.test/api/v1' });
  assert.match(textContent(renderer.tree), /连接正常，当前账户：张三（zhangsan）/);

  const serverInput = collectNodes(renderer.tree, (n) => n.type === 'input' && n.props['aria-label'] === '服务器地址')[0];
  serverInput.props.onChange({ target: { value: 'http://new-sales.test/api/v1' } });
  await renderer.settle();
  assert.doesNotMatch(textContent(renderer.tree), /连接正常，当前账户/, 'editing the address clears the old test result');

  // Testing before saving uses the address in the input, not the saved one.
  click(findButton(renderer.tree, '测试连接'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('testConnection')[1]), { serverUrl: 'http://new-sales.test/api/v1' });
  text = textContent(renderer.tree);
  assert.match(text, /可以连接这个销售管理系统。保存设置后原来的账户会断开/);
  assert.doesNotMatch(text, /测试用的是已保存的设置/);
  assert.equal(rpc.count('saveSettings'), 0, 'testing does not save');

  // A malformed address is rejected before calling the host.
  serverInput.props.onChange({ target: { value: 'sales.test/api/v1' } });
  await renderer.settle();
  click(findButton(renderer.tree, '测试连接'));
  await renderer.settle();
  assert.equal(rpc.count('testConnection'), 2);
  assert.match(textContent(renderer.tree), /服务器地址需要以 http:\/\/ 或 https:\/\/ 开头/);

  collectNodes(renderer.tree, (n) => n.type === 'input' && n.props['aria-label'] === '服务器地址')[0]
    .props.onChange({ target: { value: 'http://new-sales.test/api/v1' } });
  await renderer.settle();
  click(findButton(renderer.tree, '保存设置'));
  await renderer.settle();
  const confirmDialog = lastDialog(renderer.tree);
  assert.match(textContent(confirmDialog), /更换服务器地址会断开全部账户/);
  assert.equal(rpc.count('saveSettings'), 0);
  click(findButton(confirmDialog, '断开并保存'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('saveSettings')), [{ patch: { serverUrl: 'http://new-sales.test/api/v1', disconnectAccounts: true } }]);
  assert.equal(store.getSnapshot().state.accounts.length, 0);
  text = textContent(renderer.tree);
  assert.match(text, /原来的账户都已断开/);
  assert.match(text, /还没有连接销售管理系统账户/);

  // With no accounts, changing the server again saves right away without asking.
  collectNodes(renderer.tree, (n) => n.type === 'input' && n.props['aria-label'] === '服务器地址')[0]
    .props.onChange({ target: { value: 'http://third-sales.test/api/v1' } });
  await renderer.settle();
  click(findButton(renderer.tree, '保存设置'));
  await renderer.settle();
  assert.equal(lastDialog(renderer.tree), undefined);
  assert.deepEqual(plain(rpc.argsOf('saveSettings')[1]), { patch: { serverUrl: 'http://third-sales.test/api/v1' } });
  // The settings form only has the server address: no password, token or OCR fields.
  const inputs = collectNodes(renderer.tree, (n) => n.type === 'input' || n.type === 'textarea');
  assert.deepEqual(inputs.map((i) => i.props['aria-label']), ['服务器地址']);
});

test('every RPC the client calls exists on the host service, with the same argument names', async () => {
  // 宿主端 SalesforgeService 的形参（去掉最后的 signal）就是 RPC args 的键名。
  const remoteSource = readFileSync(join(__dirname, 'remote-service.js'), 'utf8');
  const classBody = remoteSource.slice(remoteSource.indexOf('class SalesforgeService'), remoteSource.indexOf('// 没有 name / mode'));
  const hostMethods = Object.fromEntries(
    [...classBody.matchAll(/^ {4}async (\w+)\(([^)]*)\)/gmu)].map(([, name, params]) => [
      name,
      params.split(',').map((p) => p.trim()).filter((p) => p && p !== 'signal'),
    ]),
  );
  assert.equal(Object.keys(hostMethods).length, 11);

  const clientCalls = [...clientSource.matchAll(/callRpc\([^,]+, "(\w+)", \{([^}]*)\}/gu)].map(([, name, body]) => ({
    name,
    keys: [...body.matchAll(/(\w+):/gu)].map((m) => m[1]),
  }));
  assert.ok(clientCalls.length >= 9);
  for (const { name, keys } of clientCalls) {
    assert.ok(hostMethods[name], `host has ${name}`);
    assert.deepEqual(keys, hostMethods[name], `${name} args`);
  }
  // 插件页、设置页、授权卡片、日报卡片和确认卡片用到的方法都覆盖到了（getState 走 store，单独调用）。
  assert.deepEqual(
    [...new Set(clientCalls.map((c) => c.name))].sort(),
    ['cancelAction', 'cancelAuthorization', 'confirmAction', 'disconnectAccount', 'getState', 'pollAuthorization', 'saveSettings', 'setActiveAccount', 'startAuthorization', 'submitReportDraft', 'testConnection'],
  );
});

test('the auth card only reacts to this plugin\'s own auth-required kind, matching the Node projection', () => {
  const { React } = createReactStub();
  const mod = loadClientModule(React);
  const def = mod.eventDefinition;
  const run = (events) => {
    let state = def.start({}, { event: events[1] });
    for (const event of events.slice(2)) state = def.update({ state }, { event });
    return def.buildLocationData({ state }, 'turn', null).value.authRequired;
  };
  const resultEvents = (payload, extra = {}) => [
    { type: 'turn/start', seq: 1, data: { turn: 9 } },
    { type: 'tool/call', seq: 2, data: { turn: 9, callId: 'c1', name: 'contract_query' } },
    { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 9, callId: 'c1', ...extra, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
  ];
  // 履约无忧的授权提示：两个插件同时装着时，销售管理不显示卡片。
  const other = resultEvents({ kind: 'contract-sure-auth-required', reason: 'no-account', message: 'x' });
  assert.equal(run(other), null);
  assert.equal(projectEvents(other).authRequired, null);
  // 工具调用失败时也不显示。
  const failed = resultEvents({ kind: 'salesforge-auth-required', reason: 'revoked', message: 'x' }, { isError: true });
  assert.equal(run(failed), null);
  assert.equal(projectEvents(failed).authRequired, null);
  const own = resultEvents({ kind: 'salesforge-auth-required', reason: 'revoked', message: '授权已失效', serverUrl: 'http://sales.test/api/v1' });
  assert.deepEqual(plain(run(own)), projectEvents(own).authRequired);
  assert.equal(projectEvents(own).authRequired.toolName, 'contract_query');
  // 事件定义的 kind 是 salesforge，和履约无忧的投影分开存放。
  assert.equal(def.kind, 'salesforge');
});
