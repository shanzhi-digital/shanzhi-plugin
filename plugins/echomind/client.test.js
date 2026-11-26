import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { RPC_METHOD_NAMES } from './remote-service.js';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8');
const remoteSource = readFileSync(join(ROOT, 'remote-service.js'), 'utf8');
const iconSource = readFileSync(join(ROOT, 'icon.svg'), 'utf8');

function loadClientModule() {
  let loaded = null;
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
    useEffect() {},
    useRef(init) { return { current: init }; },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(def) {
          loaded = def.factory((mod) => {
            if (mod === 'react') return fakeReact;
            throw new Error(`Unexpected require: ${mod}`);
          });
        },
      },
    },
    URL,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  assert.ok(loaded, 'client.js did not call window.__ModuleLoader__.load');
  return loaded;
}

test('client.js icon matches icon.svg verbatim and exports required Cordis client bindings', () => {
  const mod = loadClientModule();
  assert.equal(mod.ICON_SVG, iconSource);
  assert.deepEqual([...mod.inject], ['slots', 'connection', 'uiConversation', 'sidebarRight']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(typeof mod.eventDefinition.match, 'function');
});

test('seam test 1: every callRpc(conn, method, { ... }) in client.js strictly matches remote-service.js method params', () => {
  const sigMap = new Map();
  for (const m of remoteSource.matchAll(/async\s+([A-Za-z0-9_]+)\(([^)]*)\)\s*\{/gu)) {
    const methodName = m[1];
    if (!RPC_METHOD_NAMES.includes(methodName)) continue;
    const params = m[2]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'signal');
    sigMap.set(methodName, params);
  }
  assert.equal(sigMap.size, RPC_METHOD_NAMES.length, 'Every RPC_METHOD_NAMES entry must have an async method in EchoMindService');

  const callMatches = [...clientSource.matchAll(/callRpc\([^,]+,\s*"([A-Za-z0-9_]+)"\s*,\s*\{([\s\S]*?)\}\s*(?:,|\))/gu)];
  assert.ok(callMatches.length >= 20, `Expected >=20 callRpc invocations in client.js, saw ${callMatches.length}`);

  for (const [, methodName, rawObj] of callMatches) {
    assert.ok(sigMap.has(methodName), `client.js calls unknown RPC method echomind/${methodName}`);
    const allowed = new Set(sigMap.get(methodName));
    // Extract top-level keys of the args literal (strip nested braces first)
    let depth = 0;
    let topLevel = '';
    for (const ch of rawObj) {
      if (ch === '{' || ch === '[') { depth += 1; continue; }
      if (ch === '}' || ch === ']') { depth -= 1; continue; }
      if (depth === 0) topLevel += ch;
    }
    const keys = [];
    for (const part of topLevel.split(',')) {
      const keyMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/u.exec(part);
      if (keyMatch) keys.push(keyMatch[1]);
    }
    for (const k of keys) {
      assert.ok(allowed.has(k), `client.js passes unknown arg "${k}" to echomind/${methodName} (allowed: ${[...allowed].join(', ')})`);
    }
  }
});

test('seam test 2: apply(ctx) works under strict Cordis Proxy and registers all 7 slots without touching uninjected props', () => {
  const mod = loadClientModule();
  const registered = [];
  const registeredEvents = [];

  const services = {
    slots: {
      inject(_name, fn) { return fn(); },
      register(meta, component) { registered.push({ meta, component }); return () => {}; },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: { accounts: [] } }) } },
    uiConversation: { events: { register(def) { registeredEvents.push(def); } } },
    sidebarRight: {},
  };

  // Strict Cordis ReflectService Proxy: direct property read of unknown key throws!
  const strictCtx = new Proxy(
    {
      get(name) { return services[name]; },
      inject() {},
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );

  mod.apply(strictCtx);

  const slotNames = registered.map((r) => r.meta.name).sort();
  assert.deepEqual(slotNames, [
    'conversation.chat.turnTail',
    'plugins.bundle.config',
    'plugins.detail.actions',
    'plugins.detail.badge',
    'settings.section',
    'shell.overlay',
    'sidebar.footer.action',
  ]);
  assert.equal(registeredEvents.length, 1);

  // Verify plugin detail Entry components return null for foreign bundles without running Hooks
  const actionsEntry = registered.find((r) => r.meta.name === 'plugins.detail.actions').component;
  assert.equal(actionsEntry({ subject: { kind: 'bundle', pkg: { name: '@local/other' } } }), null);
  assert.ok(actionsEntry({ subject: { kind: 'bundle', pkg: { name: '@local/echomind' } } }));
});

test('eventDefinition projects real DSH tool/result events into TurnTail via turn.data.get("echomind")', () => {
  const mod = loadClientModule();
  const evDef = mod.eventDefinition;

  // Simulate exact DSH 0.2.2-rc.5 event shape: callId nested under message.source.callId,
  // JSON payload nested inside message.content[].text, surfaceOp: "append".
  const callEv = { type: 'tool/call', seq: 10, data: { turn: 3, callId: 'c1', name: 'echomind_stage_todo_push' } };
  assert.ok(evDef.match(callEv));
  let state = evDef.start({}, { event: callEv });

  const todoPayload = {
    kind: 'echomind-todo-draft',
    draftId: 'd1',
    meetingId: 'm1',
    meetingTitle: '开发任务安排',
    todos: [{ id: 't1', title: '完成接口联调', detail: '', ownerPersonId: 'ou_1', due: '2026-11-25' }],
    knowledge: { off: false, synced: true },
  };
  const resEv = {
    type: 'tool/result',
    seq: 11,
    surfaceOp: 'append',
    data: {
      turn: 3,
      message: {
        source: { callId: 'c1' },
        content: [{ type: 'text', text: JSON.stringify(todoPayload) }],
      },
    },
  };
  state = evDef.update({ state }, { event: resEv });
  assert.equal(state.value.todoDrafts.length, 1);
  assert.equal(state.value.todoDrafts[0].draftId, 'd1');

  const loc = evDef.buildLocationData({ state }, 'turn', null);
  assert.equal(loc.kind, 'turn');
  assert.equal(loc.key, 'echomind');
  assert.equal(loc.turn, 3);

  // Verify TurnTail reads turn.data.get("echomind") (DSH host contract) and renders non-null card!
  const turnData = new Map([[loc.key, loc.value]]);
  const rendered = mod.TurnTail({
    turn: { data: turnData },
    services: { connection: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }) },
    store: { getSnapshot: () => ({ status: 'idle', state: null, error: '' }), subscribe: () => () => {} },
    liveStore: { getSnapshot: () => ({ recording: null, jobs: [] }), subscribe: () => () => {} },
  });
  assert.ok(rendered, 'TurnTail must render card when turn.data.get("echomind") has todoDrafts');

  // Persisted pushed record marks draft as pushed
  const pushedEv = {
    type: 'plugin:echomind/todos-pushed',
    seq: 12,
    data: { turn: 3, callSeq: 10, draftId: 'd1', meetingId: 'm1', status: 'pushed', pushedCount: 1 },
  };
  state = evDef.update({ state }, { event: pushedEv });
  assert.equal(state.value.pushedByDraft.d1.pushedCount, 1);

  // surfaceOp replace invalidates replaced seq range cleanly
  const replaceEv = {
    type: 'turn/replace',
    seq: 13,
    surfaceOp: { op: 'replace', startSeq: 10, endSeq: 12 },
    data: { turn: 3 },
  };
  const replaced = evDef.update({ state }, { event: replaceEv });
  assert.equal(replaced.value.todoDrafts.length, 0);
  assert.equal(replaced.value.pushedByDraft.d1, undefined);
});
