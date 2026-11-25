import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectEvents } from './event-projection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(__dirname, 'client.js'), 'utf8');
const PACKAGE_NAME = '@local/contract-sure';

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
  assert.equal(loadedDescriptor.id, '@local/contract-sure');
  const exportsObj = loadedDescriptor.factory((id) => {
    if (id === 'react') return reactStub;
    throw new Error(`Unexpected require: ${id}`);
  });
  return exportsObj;
}

// contractSure/* RPC double: handlers return values (contract B), thrown errors become { ok: false }.
function createRpc(handlers) {
  const calls = [];
  const connection = {
    rpc: {
      async call(endpoint, method, payload) {
        const name = method.replace(/^contractSure\//, '');
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
  id: 'u7', userId: 7, username: 'zhangsan', realName: '张三', deptName: '财务部',
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
    serverUrl: 'http://lvyue.test/api/v1',
    activeAccountId,
    accounts,
    ocr: { apiUrl: 'https://api.deepseek.com/v1/tools/ocr', keyConfigured: true, keyMasked: 'sk-****9f2c' },
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
      verifyUrl: 'http://lvyue.test/device?code=WXYZ-1234',
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
    ['conversation.chat.turnTail', 'plugins.detail.actions', 'plugins.detail.badge', 'plugins.detail.section', 'settings.section'],
  );

  const settingsSlot = registeredSlots.find((s) => s.slotName === 'settings.section');
  assert.equal(settingsSlot.meta.id, 'contract-sure-settings');
  assert.equal(settingsSlot.meta.label, '履约无忧配置');
  assert.equal(settingsSlot.meta.order, 30);

  const tailSlot = registeredSlots.find((s) => s.slotName === 'conversation.chat.turnTail');
  assert.equal(tailSlot.meta.id, 'contract-sure-cards');
  assert.equal(tailSlot.meta.order, 25);

  assert.equal(registeredEvents.length, 1);
  assert.equal(registeredEvents[0].kind, 'contract-sure');

  const expected = {
    'plugins.detail.actions': mod.DetailActions,
    'plugins.detail.badge': mod.DetailBadge,
    'plugins.detail.section': mod.ExamplesSection,
  };
  const others = [
    { kind: 'bundle', pkg: { name: '@local/datahub-echarts', installed: true, enabled: true, rows: [] } },
    { kind: 'row', pkg: ownBundle.pkg, row: { rowId: 'contract-sure', moduleName: PACKAGE_NAME, enabled: true } },
    { kind: 'item', id: 'contract-sure' },
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
    assert.equal(textContent(collectNodes(renderer.tree, (n) => n.type === 'span' && /csu-tag/.test(n.props.className))), text);
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
  assert.match(text, /zhangsan · 财务部 · 2027-02-22 到期/);
  assert.match(text, /当前使用/);
  assert.match(text, /李四.*已过期/);
  assert.match(text, /王五.*已失效/);
  assert.match(text, /连接另一个账户/);
  assert.match(text, /服务器与识别设置/);
  assert.match(text, /sk-\*\*\*\*9f2c/);
  assert.match(text, /令牌保存在 DeepSeek Harness 凭据存储中，界面不会显示令牌。/);

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
  assert.match(emptyText, /还没有连接履约系统账户/);
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
  assert.match(textContent(confirmDialog), /断开后会在履约系统里吊销这台设备的授权/);
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
  const warn = collectNodes(renderer.tree, (n) => n.type === 'p' && String(n.props.className).includes('csu-note-warn'));
  assert.equal(warn.length, 1);
  assert.match(textContent(warn[0]), /已在本机断开 张三（zhangsan），但履约系统没有确认吊销/);
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

  assert.deepEqual(opened, [['http://lvyue.test/device?code=WXYZ-1234', '_blank', 'noopener']]);
  let text = textContent(renderer.tree);
  assert.match(text, /WXYZ-1234/);
  assert.match(text, /已在浏览器打开履约系统授权页，请确认校验码一致后点「授权」/);
  const link = collectNodes(renderer.tree, (n) => n.type === 'a')[0];
  assert.equal(link.props.href, 'http://lvyue.test/device?code=WXYZ-1234');
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
    [{ status: 'denied' }, /你在履约系统里拒绝了这次授权/],
    [{ status: 'expired' }, /授权请求已过期/],
    [{ status: 'error', message: '履约系统暂时不可用' }, /履约系统暂时不可用/],
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
  assert.deepEqual(plain(sessions[0].options), { prompt: '帮我看看我负责的合同里，本月有哪些待回款的节点', whenDraftExists: 'append' });
  assert.equal(mod.TRY_PROMPT, '帮我看看我负责的合同里，本月有哪些待回款的节点');
  assert.equal(rpc.count('startAuthorization'), 0);

  // An example card uses its own text.
  const section = registeredSlots.find((s) => s.slotName === 'plugins.detail.section').component;
  renderer.mount(renderer.h(section, { subject: ownBundle }));
  await renderer.settle();
  assert.match(textContent(renderer.tree), /试试这样问/);
  assert.equal(collectNodes(renderer.tree, (n) => n.type === 'button' && /csu-example/.test(n.props.className)).length, 4);
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
  assert.match(textContent(renderer.tree), /试用前需要先连接履约系统账户/);
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

test('auth-required tool results project into one card per turn, titled by reason, that connects in place', async () => {
  const renderer = createRenderer();
  const timers = createFakeTimers();
  const mod = loadClientModule(renderer.React, { timers });

  const payload = {
    kind: 'contract-sure-auth-required',
    reason: 'expired',
    serverUrl: 'http://lvyue.test/api/v1',
    message: '需要先连接履约系统账户：请点下方卡片的「连接账户」，在浏览器里完成授权后，回复「继续」。',
  };
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'tool/call', seq: 5, data: { turn: 3, callId: 'c1', name: 'contract_dashboard' } },
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
    seq: 6, callId: 'c1', toolName: 'contract_dashboard', reason: 'expired',
    message: payload.message, serverUrl: 'http://lvyue.test/api/v1',
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
  assert.match(text, /履约系统授权已过期/);
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
  assert.deepEqual(opened, ['@local/contract-sure']);
  renderer.unmount();

  // Titles per reason.
  for (const [reason, title] of [
    ['no-account', '还没有连接履约系统账户'],
    ['expired', '履约系统授权已过期'],
    ['revoked', '履约系统授权已失效'],
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

test('settings page reuses the account panel; changing the server asks first and disconnects accounts', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({
    getState: () => stateWith([ZHANG], 'u7'),
    saveSettings: ({ patch }) => stateWith(patch.disconnectAccounts ? [] : [ZHANG], patch.disconnectAccounts ? null : 'u7', {
      serverUrl: patch.serverUrl || 'http://lvyue.test/api/v1',
      ocr: { apiUrl: 'https://api.deepseek.com/v1/tools/ocr', keyConfigured: patch.ocrApiKey !== '', keyMasked: patch.ocrApiKey === '' ? '' : 'sk-****9f2c' },
    }),
    testConnection: ({ serverUrl }) => (serverUrl === 'http://lvyue.test/api/v1'
      ? { ok: true, message: '连接正常', account: { userId: 7, username: 'zhangsan', realName: '张三', deptName: '财务部' } }
      : { ok: true, message: '可以连接这个履约系统。保存设置后原来的账户会断开，再点「连接账户」重新授权。' }),
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
  assert.deepEqual(plain(rpc.argsOf('testConnection')[0]), { serverUrl: 'http://lvyue.test/api/v1' });
  assert.match(textContent(renderer.tree), /连接正常，当前账户：张三（zhangsan）/);

  const serverInput = collectNodes(renderer.tree, (n) => n.type === 'input' && n.props['aria-label'] === '服务器地址')[0];
  serverInput.props.onChange({ target: { value: 'http://new-lvyue.test/api/v1' } });
  await renderer.settle();
  assert.doesNotMatch(textContent(renderer.tree), /连接正常，当前账户/, 'editing the address clears the old test result');

  // Testing before saving uses the address in the input, not the saved one.
  click(findButton(renderer.tree, '测试连接'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('testConnection')[1]), { serverUrl: 'http://new-lvyue.test/api/v1' });
  text = textContent(renderer.tree);
  assert.match(text, /可以连接这个履约系统。保存设置后原来的账户会断开/);
  assert.doesNotMatch(text, /测试用的是已保存的设置/);
  assert.equal(rpc.count('saveSettings'), 0, 'testing does not save');

  // A malformed address is rejected before calling the host.
  serverInput.props.onChange({ target: { value: 'lvyue.test/api/v1' } });
  await renderer.settle();
  click(findButton(renderer.tree, '测试连接'));
  await renderer.settle();
  assert.equal(rpc.count('testConnection'), 2);
  assert.match(textContent(renderer.tree), /服务器地址需要以 http:\/\/ 或 https:\/\/ 开头/);

  collectNodes(renderer.tree, (n) => n.type === 'input' && n.props['aria-label'] === '服务器地址')[0]
    .props.onChange({ target: { value: 'http://new-lvyue.test/api/v1' } });
  await renderer.settle();
  click(findButton(renderer.tree, '保存设置'));
  await renderer.settle();
  const confirmDialog = lastDialog(renderer.tree);
  assert.match(textContent(confirmDialog), /更换服务器地址会断开全部账户/);
  assert.equal(rpc.count('saveSettings'), 0);
  click(findButton(confirmDialog, '断开并保存'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('saveSettings')), [{ patch: { serverUrl: 'http://new-lvyue.test/api/v1', disconnectAccounts: true } }]);
  assert.equal(store.getSnapshot().state.accounts.length, 0);
  text = textContent(renderer.tree);
  assert.match(text, /原来的账户都已断开/);
  assert.match(text, /还没有连接履约系统账户/);

  // Clearing the OCR key sends an empty string; with no accounts there is nothing to confirm.
  click(findButton(renderer.tree, '清除'));
  await renderer.settle();
  click(findButton(renderer.tree, '保存设置'));
  await renderer.settle();
  assert.deepEqual(plain(rpc.argsOf('saveSettings')[1]), { patch: { ocrApiKey: '' } });
  assert.match(textContent(renderer.tree), /未设置/);
});

test('an OCR key from the environment shows its source and cannot be cleared from the plugin', async () => {
  const renderer = createRenderer();
  const mod = loadClientModule(renderer.React);
  const rpc = createRpc({
    getState: () => stateWith([], null, {
      ocr: { apiUrl: 'https://api.deepseek.com/v1/tools/ocr', keyConfigured: true, keyMasked: '', keySource: 'env' },
    }),
  });
  const store = mod.createAccountStore(() => rpc.connection);
  renderer.mount(renderer.h(mod.SettingsSection, { store, services: servicesFor(rpc.connection) }));
  await renderer.settle();

  assert.match(textContent(renderer.tree), /来自环境变量 DEEPSEEK_API_KEY/);
  assert.equal(findButton(renderer.tree, '清除'), undefined);
  assert.ok(findButton(renderer.tree, '改用其他 Key'));
});

test('TurnTail renders DraftVerificationCard with warnings, formatted triggerRule, confirm RPC, and DetailDocumentsCard preview', async () => {
  const { React, renderComponent } = createReactStub();
  const mod = loadClientModule(React);

  assert.equal(
    mod.formatTriggerRule({ triggerType: 'EVENT_OFFSET', triggerEvent: 'INVOICE_RECEIVED', offsetDays: 15, offsetType: 'WORKDAY', logic: 'SINGLE' }),
    '收到/开具发票后 +15个工作日',
  );
  assert.equal(
    mod.formatTriggerRule({
      triggerType: 'EVENT_OFFSET',
      logic: 'MAX',
      conditions: [
        { event: 'ACCEPTANCE_PASSED', offsetDays: 15, offsetType: 'WORKDAY' },
        { event: 'INVOICE_RECEIVED', offsetDays: 10, offsetType: 'CALENDAR' },
      ],
    }),
    '取较晚：验收通过后 +15个工作日 且 收到/开具发票后 +10个自然日',
  );

  const rpcCalls = [];
  const openedResources = [];
  const connection = {
    rpc: {
      async call(_ep, method, payload) {
        rpcCalls.push({ method, payload });
        if (method === 'contractSure/confirmDraft') {
          return { ok: true, value: { contractId: 88, uploadedDoc: { fileName: 'HT-01.pdf' } } };
        }
        if (method === 'contractSure/cacheOriginalDocument') {
          return { ok: true, value: { sessionId: 'sess-ui', absolutePath: '/tmp/cache/HT-01.pdf', documentName: 'HT-01.pdf' } };
        }
        return { ok: false };
      },
    },
  };
  const sidebarRight = {
    mounted: {
      getSnapshot: () => 'sess-ui',
      subscribe: () => () => {},
    },
    openResource(address, opts) {
      openedResources.push({ address, opts });
    },
  };

  // Run eventDefinition reducer on a turn with draft + detail
  const def = mod.eventDefinition;
  let state = def.start(
    {},
    {
      event: {
        type: 'plugin:contract-sure/draft',
        seq: 10,
        data: {
          turn: 1,
          draftId: 'draft_abc',
          sourceFilePath: '/docs/HT-01.pdf',
          validation: { valid: false, amountMatched: false, amountDiff: 500, warnings: ['节点金额合计与合同总额不一致'] },
          draft: {
            contractNo: 'HT-2026-001',
            contractName: '测试合同',
            contractType: 1,
            partyAName: '甲方有限公司',
            partyBName: '乙方有限公司',
            totalAmount: 100500,
            signDate: '2026-04-01',
            nodes: [
              {
                nodeOrder: 1,
                nodeName: '验收款',
                nodeAmount: 100000,
                paymentCondition: '验收后15个工作日',
                triggerRule: { triggerType: 'EVENT_OFFSET', triggerEvent: 'ACCEPTANCE_PASSED', offsetDays: 15, offsetType: 'WORKDAY', logic: 'SINGLE' },
              },
            ],
          },
        },
      },
    },
  );
  state = def.update(
    { state },
    {
      event: {
        type: 'plugin:contract-sure/detail',
        seq: 11,
        data: {
          turn: 1,
          contractId: 88,
          contractNo: 'HT-2026-001',
          contractName: '测试合同',
          documents: [{ docId: 501, docType: 1, docTypeLabel: '合同原件', fileName: 'HT-01.pdf', fileSize: 12345 }],
        },
      },
    },
  );

  const location = def.buildLocationData({ state }, 'turn', null);
  const turn = { turn: 1, data: new Map([[location.key, location.value]]) };

  // Render TurnTail wrapper
  const tailRendered = renderComponent(mod.TurnTail, { turn, connection, sidebarRight });
  const cards = collectNodes(tailRendered.tree, (n) => n.type === mod.DraftVerificationCard || n.type === mod.DetailDocumentsCard);
  assert.equal(cards.length, 2);

  // Render DraftVerificationCard and click confirm button
  const draftCard = renderComponent(mod.DraftVerificationCard, cards[0].props);
  const draftText = textContent(draftCard.tree);
  assert.match(draftText, /合同识别核对卡/);
  assert.match(draftText, /节点金额合计与合同总额不一致/);
  assert.match(draftText, /验收通过后 \+15个工作日/);

  const confirmBtn = collectNodes(draftCard.tree, (n) => n.type === 'button').find((b) =>
    textContent(b).includes('确认创建并归档原件'),
  );
  assert.ok(confirmBtn);
  confirmBtn.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.equal(rpcCalls[0].method, 'contractSure/confirmDraft');
  assert.equal(rpcCalls[0].payload.args.draftId, 'draft_abc');

  // Re-render draft card after RPC resolves -> should show "已入库 (ID: #88)"
  const draftAfter = renderComponent(mod.DraftVerificationCard, cards[0].props, draftCard.states);
  assert.match(textContent(draftAfter.tree), /已入库 \(ID: #88\)/);

  // Render DetailDocumentsCard & DocumentRow -> click "查看原件"
  const docCard = renderComponent(mod.DetailDocumentsCard, cards[1].props);
  assert.match(textContent(docCard.tree), /合同与票据原件/);
  const rowNode = collectNodes(docCard.tree, (n) => typeof n.type === 'function')[0];
  const rowRendered = renderComponent(rowNode.type, rowNode.props);
  const openBtn = collectNodes(rowRendered.tree, (n) => n.type === 'button').find((b) => textContent(b).includes('查看原件'));
  assert.ok(openBtn);
  openBtn.props.onClick();
  await new Promise((r) => setImmediate(r));

  assert.ok(rpcCalls.some((c) => c.method === 'contractSure/cacheOriginalDocument'));
  assert.equal(openedResources.length, 1);
  assert.equal(openedResources[0].address, 'dsh-resource://file/session/sess-ui//tmp/cache/HT-01.pdf');
  assert.equal(openedResources[0].opts.destination, 'sidebar');
});

test('DocumentRow degrades gracefully without sidebarRight', async () => {
  const { React, renderComponent } = createReactStub();
  const mod = loadClientModule(React);
  const connection = { rpc: { async call() { return { ok: true, value: {} }; } } };

  // DetailDocumentsCard without sidebarRight should display helpful error instead of crashing
  const docCard = renderComponent(mod.DetailDocumentsCard, {
    detail: { contractId: 9, contractNo: 'HT-9', contractName: '测试', documents: [{ docId: 1, fileName: 'a.pdf', docType: 1 }] },
    sessionId: 'sess-x',
    connection,
    sidebarRight: null,
  });
  const rowNode = collectNodes(docCard.tree, (n) => typeof n.type === 'function')[0];
  const row1 = renderComponent(rowNode.type, rowNode.props);
  collectNodes(row1.tree, (n) => n.type === 'button')[0].props.onClick();
  const row2 = renderComponent(rowNode.type, rowNode.props, row1.states);
  assert.match(textContent(row2.tree), /未挂载右侧预览阅读器/);
});
