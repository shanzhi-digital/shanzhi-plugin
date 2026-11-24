import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(__dirname, 'client.js'), 'utf8');

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

function collectNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
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

function loadClientModule(reactStub) {
  let loadedDescriptor = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(desc) {
          loadedDescriptor = desc;
        },
      },
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
    setTimeout,
    clearTimeout,
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

test('client.js registers settings.section and conversation.chat.turnTail safely even without optional services', () => {
  const { React } = createReactStub();
  const mod = loadClientModule(React);

  const registeredSlots = [];
  const registeredEvents = [];

  // 1. Strict Cordis-like Proxy context (throws on direct property reads of un-injected services like settingsScope)
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
    get(name) {
      return Object.prototype.hasOwnProperty.call(rawCtx, name) ? rawCtx[name] : undefined;
    },
  };
  const minimalCtx = new Proxy(rawCtx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });

  mod.apply(minimalCtx);
  assert.equal(registeredSlots.length, 2);

  const settingsSlot = registeredSlots.find((s) => s.slotName === 'settings.section');
  assert.ok(settingsSlot);
  assert.equal(settingsSlot.meta.id, 'contract-sure-settings');
  assert.equal(settingsSlot.meta.label, '履约无忧配置');
  assert.equal(settingsSlot.meta.order, 30);

  const tailSlot = registeredSlots.find((s) => s.slotName === 'conversation.chat.turnTail');
  assert.ok(tailSlot);
  assert.equal(tailSlot.meta.id, 'contract-sure-cards');
  assert.equal(tailSlot.meta.order, 25);

  assert.equal(registeredEvents.length, 1);
  assert.equal(registeredEvents[0].kind, 'contract-sure');
});

test('SettingsSection renders config form, token login exchange, test connection and save RPC calls', async () => {
  const { React, renderComponent } = createReactStub();
  const mod = loadClientModule(React);

  const rpcCalls = [];
  const scopeOps = [];
  const connection = {
    rpc: {
      async call(endpoint, method, payload) {
        rpcCalls.push({ endpoint, method, payload });
        if (method === 'contractSure/getConfig') {
          return {
            ok: true,
            value: {
              serverUrl: 'http://localhost:8081/api/v1',
              apiToken: 'existing-tok',
              ocrApiUrl: 'https://api.deepseek.com/v1/tools/ocr',
              ocrApiKey: '',
              ocrApiKeyEnvSet: false,
            },
          };
        }
        if (method === 'contractSure/testConnection') {
          return { ok: true, value: { connected: true, user: { realName: '张主管', username: 'admin' } } };
        }
        if (method === 'contractSure/saveConfig') {
          return { ok: true, value: { ok: true } };
        }
        if (method === 'contractSure/loginToken') {
          return { ok: true, value: { token: 'new-90d-tok', username: 'admin', realName: '张主管', expiresInDays: 90 } };
        }
        return { ok: false, error: { message: 'unknown' } };
      },
    },
  };
  const settingsScope = {
    bind() {
      return {
        getSnapshot: () => ({ status: 'ready', writable: true, value: {} }),
        subscribe: () => () => {},
        mutate: async (ops) => {
          scopeOps.push(ops);
        },
      };
    },
  };

  const rendered = renderComponent(mod.SettingsSection, { connection, settingsScope });
  rendered.runEffects();
  await new Promise((r) => setImmediate(r));

  const fullText = textContent(rendered.tree);
  assert.match(fullText, /后端接口地址/);
  assert.match(fullText, /账号密码一键换取长期令牌/);
  assert.match(fullText, /DeepSeek OCR API Key/);

  const buttons = collectNodes(rendered.tree, (n) => n.type === 'button');
  const testBtn = buttons.find((b) => textContent(b).includes('测试连接'));
  const saveBtn = buttons.find((b) => textContent(b).includes('保存配置'));
  assert.ok(testBtn, 'test connection button should render');
  assert.ok(saveBtn, 'save config button should render');

  testBtn.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.ok(rpcCalls.some((c) => c.method === 'contractSure/testConnection'));

  // Re-render to reset busy state and click save
  const rendered2 = renderComponent(mod.SettingsSection, { connection, settingsScope }, rendered.states);
  const saveBtn2 = collectNodes(rendered2.tree, (n) => n.type === 'button').find((b) => textContent(b).includes('保存配置'));
  saveBtn2.props.onClick();
  await new Promise((r) => setImmediate(r));
  assert.ok(rpcCalls.some((c) => c.method === 'contractSure/saveConfig'));
  assert.ok(scopeOps.length >= 1, 'should mirror mutations to settingsScope');
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

test('SettingsSection login token exchange works and DocumentRow degrades gracefully without sidebarRight', async () => {
  const { React, renderComponent } = createReactStub();
  const mod = loadClientModule(React);

  const rpcCalls = [];
  const connection = {
    rpc: {
      async call(_ep, method, payload) {
        rpcCalls.push({ method, payload });
        if (method === 'contractSure/getConfig') return { ok: true, value: { serverUrl: 'http://127.0.0.1:8081/api/v1', apiToken: '' } };
        if (method === 'contractSure/loginToken') {
          return { ok: true, value: { token: 'tok-90d', username: 'alice', realName: '王经理', expiresInDays: 90, serverUrl: 'http://127.0.0.1:8081/api/v1' } };
        }
        return { ok: true, value: {} };
      },
    },
  };

  // Render SettingsSection without settingsScope
  const r1 = renderComponent(mod.SettingsSection, { connection, settingsScope: null });
  const inputs = collectNodes(r1.tree, (n) => n.type === 'input');
  const userInput = inputs.find((i) => i.props.placeholder === '履约无忧登录账号');
  const passInput = inputs.find((i) => i.props.placeholder === '仅用于换取长期令牌，不落盘');
  userInput.props.onChange({ target: { value: 'alice' } });
  passInput.props.onChange({ target: { value: 'pwd123' } });

  const r2 = renderComponent(mod.SettingsSection, { connection, settingsScope: null }, r1.states);
  const loginBtn = collectNodes(r2.tree, (n) => n.type === 'button').find((b) => textContent(b).includes('获取长期令牌'));
  assert.ok(loginBtn);
  loginBtn.props.onClick();
  await new Promise((r) => setImmediate(r));

  const loginCall = rpcCalls.find((c) => c.method === 'contractSure/loginToken');
  assert.ok(loginCall);
  assert.equal(loginCall.payload.args.username, 'alice');
  assert.equal(loginCall.payload.args.password, 'pwd123');
  const r3 = renderComponent(mod.SettingsSection, { connection, settingsScope: null }, r2.states);
  assert.match(textContent(r3.tree), /已成功换取 90 天长期令牌/);

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

