import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Drive the shipped React component and the same HTTP fixture as Chromium.
async function mountClient() {
  let current, dirty = false, tree, nextTimer = 0;
  const instances = new Map(), timers = new Map(), effects = [];
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) {
      const instance = current, index = instance.cursor++;
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.hooks[index], (value) => { instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value; dirty = true; }];
    },
    useRef(initial) { const instance = current, index = instance.cursor++; return instance.hooks[index] ||= { current: initial }; },
    useEffect(callback, deps) {
      const instance = current, index = instance.cursor++, old = instance.hooks[index];
      if (!old || deps.some((value, offset) => value !== old.deps[offset])) {
        instance.hooks[index] = { deps };
        effects.push(() => { old?.cleanup?.(); instance.hooks[index].cleanup = callback(); });
      }
    },
  };
  let rootElement;
  const host = { focus() {}, showModal() {}, close() {}, reportValidity() { return true; } };
  function render(element, path, used) {
    if (typeof element !== 'object' || !element) return element;
    if (typeof element.type === 'function') {
      const key = `${path}:${element.type.name}:${element.props.key || ''}`;
      let instance = instances.get(key);
      if (!instance) { instance = { hooks: [] }; instances.set(key, instance); }
      used.add(key); instance.cursor = 0; current = instance;
      return render(element.type(element.props), `${key}/result`, used);
    }
    if (typeof element.props.ref === 'object' && element.props.ref) element.props.ref.current = host;
    const refState = {};
    if (typeof element.props.ref === 'function') element.props.ref(refState);
    return { ...element, props: { ...element.props, indeterminate: refState.indeterminate, children: element.props.children.map((child, index) => render(child, `${path}/${child?.props?.key || index}`, used)) } };
  }
  function commit() {
    const used = new Set(); tree = render(rootElement, 'root', used);
    for (const [key, instance] of instances) if (!used.has(key)) { for (const hook of instance.hooks) hook?.cleanup?.(); instances.delete(key); }
    for (const effect of effects.splice(0)) effect();
  }
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const context = vm.createContext({ console, React, Response, AbortController, DOMException, crypto, Date: Clock, Math, document: { activeElement: host, getElementById() { return host; } } });
  context.window = context;
  context.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  context.clearTimeout = (id) => timers.delete(id);
  context.setInterval = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: true }); return id; };
  context.clearInterval = (id) => timers.delete(id);
  context.ReactDOM = { createRoot() { return { render(element) { rootElement = element; dirty = true; }, unmount() { for (const instance of instances.values()) for (const hook of instance.hooks) hook?.cleanup?.(); instances.clear(); tree = null; } }; } };
  vm.runInContext(await readFile(new URL('./client/fixture.js', import.meta.url), 'utf8'), context);
  vm.runInContext(await readFile(new URL('../client.js', import.meta.url), 'utf8'), context);
  // Sequential bulk deletion awaits each HTTP response before rendering its final state.
  const flush = async () => { for (let index = 0; index < 200; index++) { if (dirty) { dirty = false; commit(); } await Promise.resolve(); } };
  const nodes = () => {
    const result = [];
    const visit = (node) => { if (!node || typeof node !== 'object') return; result.push(node); node.props.children.forEach(visit); };
    visit(tree); return result;
  };
  const text = (node) => typeof node === 'string' ? node : node?.props?.children?.map(text).join('') || '';
  const click = async (label, aria = false) => {
    const node = nodes().filter((node) => node.type === 'button' && (aria ? node.props['aria-label'] === label : text(node) === label)).at(-1);
    assert.ok(node && !node.props.disabled, `Enabled button ${label}`);
    node.props.onClick?.(); await flush();
  };
  const change = async (label, value) => {
    const node = nodes().filter((node) => node.props['aria-label'] === label).at(-1);
    assert.ok(node, `Control ${label}`);
    node.props.onChange({ target: { value, checked: value } }); await flush();
  };
  const calls = (name) => context.__fixture.calls.filter((call) => call.payload.action === name || call.operation === name);
  const submit = async () => { nodes().filter((node) => node.type === 'form').at(-1).props.onSubmit({ preventDefault() {} }); await flush(); };
  await flush();
  return { fixture: context.__fixture, flush, nodes, text, click, change, calls, timers, submit,
    advance: async (milliseconds) => { clock += milliseconds; for (const timer of timers.values()) if (timer.interval) timer.callback(); await flush(); },
    unmount: () => context.__fixture.unmount() };
}

const stateOf = (ui) => ui.fixture.states['fixture-mysql'];
const tableEnabled = (ui, id) => stateOf(ui).catalog.tables.find((table) => table.id === id).enabled;
const rows = (ui) => ui.nodes().filter((node) => node.type === 'tbody')[0].props.children;
const checked = (ui, label) => ui.nodes().filter((node) => node.props['aria-label'] === label).at(-1).props.checked;
const control = (ui, label) => ui.nodes().filter((node) => node.props['aria-label'] === label).at(-1);
const buttonNamed = (ui, label) => ui.nodes().filter((node) => node.type === 'button' && ui.text(node) === label).at(-1);
const dialogNamed = (ui, id) => ui.nodes().find((node) => node.props['data-testid'] === id);
const questionRows = (ui) => ui.nodes().filter((node) => node.type === 'tbody').at(-1).props.children;
const openQuestions = async (ui) => { await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('查看问题'); };
const startGeneralization = async (ui, text) => {
  await ui.click('泛化问题'); await ui.change(`泛化参考 ${text}`, true); await ui.click('开始泛化');
};

test('source filters, pagination and partial batch status reflect independent connection results', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  assert.equal(rows(ui).length, 10);
  assert.equal(ui.calls('list')[0].method, 'GET');
  assert.deepEqual(Array.from(ui.calls('test'), ({ payload }) => payload.id), ['fixture-mysql', 'fixture-pg']);
  await ui.click('下一页'); assert.equal(rows(ui).length, 3);
  await ui.change('筛选连接状态', 'failed'); assert.match(ui.text(rows(ui)[0]), /测试报表库.*异常/);
  await ui.change('筛选连接状态', 'disabled'); await ui.change('搜索数据源名称', '测试');
  assert.match(ui.text(rows(ui)[0]), /测试本地库.*已停用/);
  await ui.change('选择数据源 测试本地库', true);
  await ui.change('搜索数据源名称', '备用源 1'); await ui.change('全选当前筛选数据源', true);
  ui.fixture.failSourceId = 'fixture-sqlite';
  await ui.click('批量启用');
  assert.deepEqual(Array.from(ui.calls('source-status')[0].payload.items, ({ id }) => id), ['fixture-sqlite', 'extra-0', 'extra-9']);
  await ui.change('搜索数据源名称', '测试'); assert.equal(checked(ui, '选择数据源 测试本地库'), true);
});

test('catalog filtering, cross-page selection, conflict retry, sample demand and newly discovered rows', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库');
  assert.equal(ui.calls('ensure-scan')[0].payload.open, true);
  assert.equal(rows(ui).length, 10);
  await ui.change('搜索表名或原始注释', '历史归档');
  await ui.change('全选当前筛选数据表', true);
  await ui.click('下一页'); assert.equal(checked(ui, '选择数据表 archive_11'), true);
  assert.equal(ui.calls('set-tables').length, 0);
  ui.fixture.failNextAction = 'set-tables';
  await ui.click('批量启用'); assert.equal(ui.fixture.stateReads, 2);
  assert.equal(checked(ui, '选择数据表 archive_11'), true);
  await ui.click('批量启用'); assert.equal(ui.calls('set-tables')[1].payload.tableIds.length, 20);
  assert.equal(tableEnabled(ui, 'table-orders'), false);
  await ui.click('清除所有勾选');
  await ui.change('搜索表名或原始注释', '订单');
  assert.equal(ui.calls('flow-samples').length, 0);
  await ui.click('orders'); assert.equal(ui.calls('flow-samples').length, 0);
  await ui.click('加载样例'); assert.equal(ui.calls('flow-samples')[0].payload.snapshotId, stateOf(ui).catalog.id);
  await ui.click('关闭');
  await ui.click('时效检测'); await ui.change('搜索表名或原始注释', '');
  await ui.change('筛选时效', '120');
  assert.equal(rows(ui).length, 1); assert.match(ui.text(rows(ui)[0]), /orders.*updated_at/);
  await ui.change('筛选时效', ''); await ui.change('筛选空表', 'yes'); assert.match(ui.text(rows(ui)[0]), /customers/);
  ui.fixture.added.push('new_orders');
  await ui.click('刷新目录');
  assert.equal(rows(ui).length, 1); assert.match(ui.text(rows(ui)[0]), /new_orders.*新增/);
  assert.equal(tableEnabled(ui, 'fixture-added-new_orders'), false);
  await ui.click('返回全部表'); assert.equal(rows(ui).length, 10);
});

test('question editing and AI suggestions keep independent versions and apply status only on confirm', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库'); await ui.click('启用 orders', true);
  await ui.click('AI 辅助选表'); await ui.click('查看问题');
  await ui.click('下一页'); await ui.change('参考问题 测试问题 11', false);
  await ui.click('新增问题'); await ui.change('问题', '自定义问题'); await ui.change('答案（选填）', '自定义答案'); await ui.submit();
  assert.equal(ui.calls('questions-save')[0].payload.answer, '自定义答案'); assert.equal(ui.calls('suggest').length, 0);
  await ui.change('搜索问题或答案', '自定义答案');
  await ui.click('查看或编辑 自定义问题', true); await ui.change('问题', '编辑后的问题'); await ui.submit();
  assert.equal(ui.calls('questions-save')[1].payload.version, 1);
  await ui.click('删除 编辑后的问题', true); await ui.click('删除');
  assert.equal(ui.calls('questions-remove')[0].payload.version, 2);
  await ui.click('完成'); await ui.click('识别业务域'); await ui.change('参考业务域 订单业务', true);
  await ui.click('AI 选表');
  assert.equal(ui.calls('suggest')[0].payload.questionIds.includes('q11'), false);
  assert.deepEqual(Array.from(ui.calls('suggest')[0].payload.domains), ['订单业务']);
  assert.equal(checked(ui, '确认启用 orders'), true); assert.equal(checked(ui, '确认启用 customers'), true);
  await ui.click('取消');
  assert.equal(ui.calls('confirm-selection').length, 0); assert.ok(ui.calls('cancel')[0].payload.draftId);
  assert.equal(tableEnabled(ui, 'table-orders'), true); assert.equal(tableEnabled(ui, 'table-customers'), false);
  await ui.click('AI 辅助选表'); await ui.click('AI 选表'); await ui.change('确认启用 orders', false); await ui.click('确认启用状态');
  assert.equal(tableEnabled(ui, 'table-orders'), false); assert.equal(tableEnabled(ui, 'table-customers'), true);
});

test('recommendations scroll without pagination and filtered select-all preserves outside choices', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库'); await ui.click('启用 customers', true); await ui.click('AI 辅助选表'); await ui.click('识别业务域');
  await ui.change('参考业务域 订单业务', true); await ui.click('AI 选表');
  const dialog = ui.nodes().find((node) => node.props['data-testid'] === 'recommendation-dialog');
  assert.match(dialog.props.className, /ds-modal-scroll/);
  assert.equal(ui.nodes().filter((node) => node.type === 'tbody').at(-1).props.children.length, 23);
  assert.equal(ui.text(dialog).includes('下一页'), false);
  assert.match(ui.text(dialog), /匹配业务域：订单业务/);
  assert.equal(ui.text(dialog).includes('匹配客户统计'), false);
  const customerRow = ui.nodes().filter((node) => node.type === 'tbody').at(-1).props.children.find((row) => ui.text(row).startsWith('customers'));
  const statusTags = customerRow.props.children.at(-1).props.children[0].props.children.filter((node) => node?.props?.className === 'ds-tag');
  assert.deepEqual(statusTags.map(ui.text), ['已启用', 'AI 推荐']);
  assert.equal(checked(ui, '确认启用 orders'), true);
  await ui.change('搜索推荐范围', '历史归档'); await ui.change('全选当前筛选推荐表', true);
  assert.equal(checked(ui, '确认启用 archive_20'), true);
  await ui.change('确认启用 archive_01', false);
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '全选当前筛选推荐表').props.indeterminate, true);
  await ui.change('全选当前筛选推荐表', false); await ui.change('搜索推荐范围', '');
  assert.equal(checked(ui, '确认启用 customers'), true); assert.equal(checked(ui, '确认启用 orders'), true);
  assert.match(ui.text(ui.nodes().find((node) => node.props['data-testid'] === 'recommendation-dialog')), /已选 2 \/ 23 张表/);
  await ui.click('确认启用状态');
  assert.deepEqual(Array.from(ui.calls('confirm-selection')[0].payload.selectedTableIds), ['table-orders', 'table-customers']);
});

test('business-domain select-all starts empty and supports partial selection', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('识别业务域');
  assert.equal(checked(ui, '全选业务域'), false);
  assert.equal(checked(ui, '参考业务域 订单业务'), false);
  await ui.change('参考业务域 订单业务', true);
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '全选业务域').props.indeterminate, true);
  await ui.change('全选业务域', true); assert.equal(checked(ui, '参考业务域 客户业务'), true);
  assert.ok(ui.nodes().some((node) => ui.text(node) === '已选 2 / 2 个业务域'));
  await ui.change('全选业务域', false); assert.equal(checked(ui, '参考业务域 订单业务'), false);
  await ui.change('参考业务域 客户业务', true); await ui.click('AI 选表');
  assert.deepEqual(Array.from(ui.calls('suggest')[0].payload.domains), ['客户业务']);
});

test('generalization previews without saving, keeps failed edits and confirms selected empty-answer questions', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.questions[0].answer = '原问题答案不能复制';
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('查看问题');
  await startGeneralization(ui, '测试问题 01');
  assert.equal(ui.fixture.questions.length, 12); assert.equal(ui.calls('questions-save').length, 0);
  assert.deepEqual(Array.from(ui.calls('generalize-question')[0].payload.questions, ({ id, version }) => ({ id, version })), [{ id: 'q1', version: 1 }]);
  assert.equal(stateOf(ui).questionDraft.candidates.length, 3);
  const initialDraft = ui.nodes().find((node) => node.props['data-testid'] === 'question-draft-dialog');
  assert.match(ui.text(initialDraft), /当前表结构只支持这些有区别的问题。/);
  assert.match(ui.text(initialDraft), /未采样，仅依据表结构。/);
  await ui.change('泛化候选 1', '编辑后的泛化问题'); await ui.change('全选泛化候选', false);
  await ui.change('选择泛化候选 1', true);
  ui.fixture.failNextAction = 'confirm-question-draft'; await ui.click('保存所选');
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '泛化候选 1').props.value, '编辑后的泛化问题');
  assert.equal(ui.fixture.questions.length, 12);
  assert.ok(ui.nodes().find((node) => node.props['data-testid'] === 'question-draft-dialog').props.children);
  await ui.click('保存所选'); assert.equal(ui.fixture.questions.length, 13);
  assert.deepEqual(Array.from(ui.calls('confirm-question-draft').at(-1).payload.candidates, ({ id, text }) => ({ id, text })), [{ id: 'candidate-1', text: '编辑后的泛化问题' }]);
  assert.equal(ui.fixture.questions.at(-1).answer, '');
  await ui.change('搜索问题或答案', '编辑后的泛化问题');
  assert.equal(checked(ui, '参考问题 编辑后的泛化问题'), true);
  await ui.change('搜索问题或答案', ''); await startGeneralization(ui, '测试问题 01');
  const draftId = stateOf(ui).questionDraft.id;
  await ui.change('泛化候选 1', '取消的修改'); await ui.click('取消');
  assert.equal(ui.fixture.questions.length, 13); assert.equal(stateOf(ui).questionDraft, null);
  assert.equal(ui.calls('cancel').at(-1).payload.questionDraftId, draftId);
  await startGeneralization(ui, '测试问题 01');
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '泛化候选 1').props.value, '测试问题 01 泛化 1');
  await ui.click('取消'); await ui.click('完成'); await ui.click('AI 选表');
  assert.ok(ui.calls('suggest')[0].payload.questionIds.includes('q13'));
});

test('question origins control generalization and editing preserves origin and source question', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  Object.assign(ui.fixture.questions[1], { origin: 'generated', sourceQuestionId: 'q1' });
  ui.fixture.questions[2].origin = 'unknown';
  delete ui.fixture.questions[3].origin;
  await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  const previews = ui.nodes().filter((node) => node.type === 'label' && node.props.className?.includes('ds-question-option'));
  assert.equal(previews.length, 12);
  await ui.click('查看问题');
  const questionRows = ui.nodes().filter((node) => node.type === 'tbody').at(-1).props.children;
  assert.match(ui.text(questionRows[0]), /原问题/);
  assert.match(ui.text(questionRows[1]), /泛化问题/);
  assert.match(ui.text(questionRows[2]), /来源待确认/);
  assert.match(ui.text(questionRows[3]), /来源待确认/);
  const generalizeButtons = () => ui.nodes().filter((node) => node.type === 'button' && node.props['aria-label']?.startsWith('泛化问题 '));
  assert.equal(generalizeButtons().length, 0);
  await ui.click('泛化问题');
  assert.equal(ui.nodes().filter((node) => node.props['aria-label']?.startsWith('泛化参考 ')).length, 9);
  assert.equal(control(ui, '泛化参考 测试问题 02'), undefined);
  await ui.click('取消');
  await ui.click('查看或编辑 测试问题 02', true); await ui.change('问题', '编辑后的泛化问题'); await ui.submit();
  assert.equal(ui.fixture.questions[1].origin, 'generated');
  assert.equal(ui.fixture.questions[1].sourceQuestionId, 'q1');
  const saved = ui.calls('questions-save')[0].payload;
  assert.equal(Object.hasOwn(saved, 'origin'), false);
  assert.equal(Object.hasOwn(saved, 'sourceQuestionId'), false);
  assert.equal(generalizeButtons().some((node) => node.props['aria-label'] === '泛化问题 编辑后的泛化问题'), false);
});

test('question linked tables show names, comments, fields and separate stale analysis state', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.questions[0].links = [
    { sourceId: 'fixture-mysql', tableId: 'table-orders', structureHash: 'table-orders', fields: ['id', 'note'], reason: '依据订单明细分析', questionVersion: 1 },
    { sourceId: 'fixture-mysql', tableId: 'table-customers', structureHash: 'table-customers', fields: ['id'], reason: '依据客户标识关联', questionVersion: 0 },
    { sourceId: 'fixture-mysql', tableId: 'table-log', structureHash: 'old-log-structure', fields: ['event'], reason: '旧表结构关联', questionVersion: 1 },
    { sourceId: 'fixture-mysql', tableId: 'removed-table', structureHash: 'removed-table', fields: ['id'], reason: '已移除表关联', questionVersion: 1 },
    { sourceId: 'fixture-pg', tableId: 'other-source', fields: ['id'], reason: '其他数据源不能出现', questionVersion: 1 },
  ];
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('查看问题'); await ui.click('查看或编辑 测试问题 01', true);
  const dialog = ui.nodes().find((node) => node.props['data-testid'] === 'question-dialog');
  assert.match(ui.text(dialog), /关联数据表/);
  const links = ui.nodes().filter((node) => node.props.className === 'ds-table-link');
  assert.equal(links.length, 4);
  assert.match(ui.text(links[0]), /orders测试订单表/);
  assert.equal(ui.text(links[0]).includes('待重新分析'), false);
  assert.match(ui.text(links[0]), /字段id（订单标识）、note（订单备注）依据依据订单明细分析/);
  assert.match(ui.text(links[1]), /customers测试客户表待重新分析/);
  assert.match(ui.text(links[2]), /audit_log系统日志待重新分析/);
  assert.match(ui.text(links[3]), /removed-table待重新分析/);
  assert.equal(ui.nodes().filter((node) => node.type === 'details').length, 4);
  assert.equal(ui.nodes().filter((node) => node.props.className === 'ds-tag' && ui.text(node) === '待重新分析').length, 3);
  assert.equal(ui.text(dialog).includes('其他数据源不能出现'), false);
});

test('twenty generalization candidates retain details and edits across selection and save only id and text', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.candidateCount = 20;
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('查看问题'); await startGeneralization(ui, '测试问题 01');
  const dialog = () => ui.nodes().find((node) => node.props['data-testid'] === 'question-draft-dialog');
  assert.match(dialog().props.className, /ds-modal-scroll/);
  assert.equal(ui.nodes().filter((node) => node.type === 'textarea').length, 20);
  assert.match(ui.text(dialog()), /未采样，仅依据表结构。/);
  assert.equal(ui.nodes().filter((node) => node.type === 'details').length, 21);
  assert.match(ui.text(dialog()), /orders测试订单表关联详情字段id（订单标识）、note（订单备注）依据依据订单标识和订单备注分析订单。/);
  assert.equal(ui.text(dialog()).includes('待重新分析'), false);
  await ui.change('泛化候选 1', '  测试问题 01 泛化 1  ');
  assert.equal(ui.text(dialog()).includes('内容已修改，关联待重新分析'), false);
  await ui.change('泛化候选 20', '  最后一条编辑后的问题  ');
  const editedCandidate = ui.nodes().filter((node) => node.props.className === 'ds-draft-candidate').at(-1);
  assert.match(ui.text(editedCandidate), /内容已修改，关联待重新分析/);
  assert.equal(ui.nodes().filter((node) => node.type === 'p' && ui.text(node) === '内容已修改，关联待重新分析').length, 1);
  await ui.change('选择泛化候选 20', false);
  assert.equal(checked(ui, '全选泛化候选'), false);
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '全选泛化候选').props.indeterminate, true);
  assert.equal(ui.nodes().filter((node) => node.type === 'details').length, 21);
  await ui.change('全选泛化候选', true);
  assert.equal(checked(ui, '选择泛化候选 20'), true);
  assert.equal(ui.nodes().find((node) => node.props['aria-label'] === '泛化候选 20').props.value, '  最后一条编辑后的问题  ');
  await ui.click('保存所选');
  const payload = ui.calls('confirm-question-draft')[0].payload;
  assert.equal(payload.candidates.length, 20);
  assert.deepEqual(Object.keys(payload.candidates[19]).sort(), ['id', 'text']);
  assert.equal(payload.candidates[19].text, '最后一条编辑后的问题');
  assert.equal(ui.fixture.questions.length, 32);
  assert.equal(ui.fixture.questions.at(-1).origin, 'generated');
  assert.equal(ui.fixture.questions.at(-1).sourceQuestionId, 'q1');
  const savedLinks = ui.fixture.questions.at(-1).links;
  assert.equal(savedLinks.length, 1);
  assert.equal(savedLinks[0].sourceId, 'fixture-mysql');
  assert.equal(savedLinks[0].tableId, 'table-orders');
  assert.equal(savedLinks[0].structureHash, 'table-orders');
  assert.equal(savedLinks[0].questionVersion, 0);
  assert.deepEqual(Array.from(savedLinks[0].fields), ['id', 'note']);
  assert.equal(savedLinks[0].reason, '依据订单标识和订单备注分析订单。');
  assert.ok(Number.isFinite(Date.parse(savedLinks[0].analyzedAt)));
  assert.equal(ui.fixture.questions[12].links[0].questionVersion, 1);
  assert.equal(checked(ui, '参考问题 测试问题 01'), true);
  assert.equal(dialog(), undefined);
  await ui.change('搜索问题或答案', '测试问题 01 泛化 1');
  await ui.click('查看或编辑 测试问题 01 泛化 1', true);
  const savedDialog = () => dialogNamed(ui, 'question-dialog');
  assert.match(ui.text(savedDialog()), /关联数据表orders测试订单表关联详情/);
  assert.equal(ui.text(savedDialog()).includes('待重新分析'), false);
  assert.equal(ui.text(savedDialog()).includes('暂无关联'), false);
  await ui.click('取消');
  await ui.change('搜索问题或答案', '最后一条编辑后的问题');
  await ui.click('查看或编辑 最后一条编辑后的问题', true);
  assert.match(ui.text(savedDialog()), /关联数据表orders测试订单表待重新分析关联详情/);
});

test('loading elapsed time uses the clock and clears intervals on finish, cancel and unmount', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库'); ui.fixture.holdActions.add('detect-freshness'); await ui.click('时效检测');
  assert.equal([...ui.timers.values()].filter(({ interval }) => interval).length, 1);
  await ui.advance(3200); assert.ok(ui.nodes().some((node) => ui.text(node) === '正在检测时效 · 已用 3 秒'));
  [...ui.fixture.pending.values()][0].finish(); await ui.flush();
  assert.equal([...ui.timers.values()].filter(({ interval }) => interval).length, 0);
  await ui.click('时效检测'); await ui.click('取消操作');
  assert.equal([...ui.timers.values()].filter(({ interval }) => interval).length, 0);
  await ui.click('时效检测'); ui.unmount(); await ui.flush();
  assert.equal(ui.timers.size, 0); assert.equal(ui.fixture.pending.size, 0);
});

test('question select-all spans matching pages, retains choices outside search and updates basis counts', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.questions.slice(0, 11).forEach((question) => { question.answer = '匹配组'; });
  await openQuestions(ui);
  await ui.change('全选当前搜索问题', false);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
  await ui.click('下一页'); await ui.change('参考问题 测试问题 12', true);
  await ui.change('搜索问题或答案', '匹配组'); await ui.change('全选当前搜索问题', true);
  await ui.click('下一页');
  assert.equal(checked(ui, '参考问题 测试问题 11'), true);
  await ui.change('参考问题 测试问题 11', false);
  assert.equal(control(ui, '全选当前搜索问题').props.indeterminate, true);
  await ui.change('全选当前搜索问题', false);
  await ui.change('搜索问题或答案', '测试问题 12');
  assert.equal(checked(ui, '参考问题 测试问题 12'), true);
  await ui.click('完成');
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /已选 1 \/ 12 个问题/);
  assert.equal(control(ui, '全选问题').props.indeterminate, true);
  await ui.change('全选问题', true); await ui.click('查看问题');
  await ui.click('下一页');
  assert.equal(checked(ui, '参考问题 测试问题 11'), true);
  assert.equal(checked(ui, '参考问题 测试问题 12'), true);
  await ui.click('完成'); await ui.click('AI 选表');
  assert.deepEqual(Array.from(ui.calls('suggest')[0].payload.questionIds), Array.from(ui.fixture.questions, ({ id }) => id));
});

test('basis select-all includes undisplayed questions and both question and domain totals stay in sync', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.click('识别业务域');
  const basis = () => dialogNamed(ui, 'ai-selection-dialog');
  assert.equal(ui.nodes().filter((node) => node.type === 'label' && node.props.className?.includes('ds-question-option')).length, 12);
  await ui.change('全选问题', false);
  assert.match(ui.text(basis()), /已选 0 \/ 12 个问题/);
  assert.equal(checked(ui, '参考问题 测试问题 01'), false);
  await ui.change('参考问题 测试问题 01', true);
  assert.match(ui.text(basis()), /已选 1 \/ 12 个问题/);
  assert.equal(control(ui, '全选问题').props.indeterminate, true);
  await ui.change('全选问题', true);
  await ui.change('全选业务域', true);
  assert.match(ui.text(basis()), /已选 12 \/ 12 个问题/);
  assert.match(ui.text(basis()), /已选 2 \/ 2 个业务域/);
  await ui.change('参考业务域 订单业务', false);
  assert.equal(control(ui, '全选业务域').props.indeterminate, true);
  assert.match(ui.text(basis()), /已选 1 \/ 2 个业务域/);
  await ui.change('全选业务域', false);
  assert.equal(checked(ui, '参考业务域 客户业务'), false);
  assert.match(ui.text(basis()), /已选 0 \/ 2 个业务域/);
  await ui.change('全选业务域', true); await ui.click('AI 选表');
  assert.equal(ui.calls('suggest')[0].payload.questionIds.length, 12);
  assert.deepEqual(Array.from(ui.calls('suggest')[0].payload.domains), ['订单业务', '客户业务']);
});

test('question batch deletion confirms all selected questions outside search, retains failures and retries only failures', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await openQuestions(ui);
  await ui.change('搜索问题或答案', '测试问题 01');
  await ui.click('删除已选（12）');
  const deletion = () => dialogNamed(ui, 'delete-dialog');
  assert.match(ui.text(deletion()), /12 个问题/);
  const entries = control(ui, '待删除清单').props.children;
  assert.equal(entries.length, 12);
  assert.match(ui.text(deletion()), /测试问题 12/);
  await ui.click('取消');
  assert.equal(ui.calls('questions-remove').length, 0);
  assert.equal(ui.fixture.questions.length, 12);
  assert.ok(buttonNamed(ui, '删除已选（12）'));
  ui.fixture.failQuestionRemoveIds.add('q11');
  await ui.click('删除已选（12）'); await ui.click('删除');
  assert.equal(ui.calls('questions-remove').length, 12);
  assert.deepEqual(Array.from(ui.fixture.questions, ({ id }) => id), ['q11']);
  assert.ok(buttonNamed(ui, '重试删除'));
  await ui.click('取消');
  await ui.change('搜索问题或答案', '');
  assert.equal(checked(ui, '参考问题 测试问题 11'), true);
  assert.ok(buttonNamed(ui, '删除已选（1）'));
  await ui.click('删除已选（1）');
  ui.fixture.failQuestionRemoveIds.clear();
  await ui.click('删除');
  assert.equal(ui.calls('questions-remove').length, 13);
  assert.equal(ui.calls('questions-remove').at(-1).payload.id, 'q11');
  assert.equal(ui.fixture.questions.length, 0);
  assert.equal(deletion(), undefined);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
});

test('question deletion retries only the failed request within the same confirmation', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await openQuestions(ui); await ui.change('全选当前搜索问题', false);
  await ui.change('参考问题 测试问题 01', true); await ui.change('参考问题 测试问题 02', true);
  ui.fixture.failQuestionRemoveIds.add('q2');
  await ui.click('删除已选（2）'); await ui.click('删除');
  assert.deepEqual(Array.from(ui.calls('questions-remove'), ({ payload }) => payload.id), ['q1', 'q2']);
  ui.fixture.failQuestionRemoveIds.clear(); await ui.click('重试删除');
  assert.deepEqual(Array.from(ui.calls('questions-remove'), ({ payload }) => payload.id), ['q1', 'q2', 'q2']);
  assert.equal(dialogNamed(ui, 'delete-dialog'), undefined);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
  assert.equal(checked(ui, '全选当前搜索问题'), false);
});

test('deleting the final question page falls back to a populated valid page', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await openQuestions(ui); await ui.change('全选当前搜索问题', false); await ui.click('下一页');
  await ui.change('参考问题 测试问题 11', true); await ui.change('参考问题 测试问题 12', true);
  await ui.click('删除已选（2）'); await ui.click('删除');
  assert.equal(questionRows(ui).length, 10);
  assert.match(ui.text(questionRows(ui)[0]), /测试问题 01/);
  assert.equal(buttonNamed(ui, '上一页').props.disabled, true);
  assert.equal(buttonNamed(ui, '下一页').props.disabled, true);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
});

test('source batch deletion includes search-hidden selections and retains only failures for retry', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
  await ui.change('选择数据源 测试业务库', true);
  await ui.change('搜索数据源名称', '备用源'); await ui.change('全选当前筛选数据源', true);
  await ui.change('搜索数据源名称', '测试业务库'); await ui.click('删除已选（11）');
  const deletion = () => dialogNamed(ui, 'delete-dialog');
  assert.match(ui.text(deletion()), /11 个数据源/);
  assert.equal(control(ui, '待删除清单').props.children.length, 11);
  assert.match(ui.text(deletion()), /备用源 10/);
  await ui.click('取消');
  assert.equal(ui.calls('remove').length, 0);
  assert.equal(ui.fixture.items.length, 13);
  ui.fixture.failRemoveIds.add('extra-9');
  await ui.click('删除已选（11）'); await ui.click('删除');
  assert.equal(ui.calls('remove').length, 11);
  assert.deepEqual(Array.from(ui.fixture.items, ({ id }) => id), ['fixture-sqlite', 'fixture-pg', 'extra-9']);
  assert.ok(buttonNamed(ui, '删除已选（1）'));
  assert.match(ui.text(deletion()), /模拟数据源删除失败/);
  ui.fixture.failRemoveIds.clear(); await ui.click('重试删除');
  assert.equal(ui.calls('remove').length, 12);
  assert.equal(ui.calls('remove').at(-1).payload.id, 'extra-9');
  assert.equal(deletion(), undefined);
  await ui.change('搜索数据源名称', '');
  assert.equal(rows(ui).length, 2);
  assert.equal(buttonNamed(ui, '删除已选（0）').props.disabled, true);
  assert.equal(checked(ui, '全选当前筛选数据源'), false);
});

test('source revision conflicts keep the source selected and retry uses the captured revision', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.change('选择数据源 测试业务库', true); await ui.click('删除已选（1）');
  ui.fixture.items.find(({ id }) => id === 'fixture-mysql').revision++;
  await ui.click('删除');
  assert.match(ui.text(dialogNamed(ui, 'delete-dialog')), /数据源已更新/);
  assert.equal(ui.calls('remove')[0].payload.revision, 1);
  assert.equal(ui.fixture.items.length, 13);
  await ui.click('重试删除');
  assert.equal(ui.calls('remove')[1].payload.revision, 1);
  await ui.click('取消');
  assert.equal(checked(ui, '选择数据源 测试业务库'), true);
  assert.ok(buttonNamed(ui, '删除已选（1）'));
});

test('question version conflicts retain the question, its selection and the failed confirmation', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await openQuestions(ui); await ui.change('全选当前搜索问题', false);
  await ui.change('参考问题 测试问题 01', true); await ui.click('删除已选（1）');
  ui.fixture.questions[0].version++;
  await ui.click('删除');
  assert.match(ui.text(dialogNamed(ui, 'delete-dialog')), /问题已更新/);
  assert.equal(ui.calls('questions-remove')[0].payload.version, 1);
  assert.equal(ui.fixture.questions.length, 12);
  await ui.click('取消');
  assert.equal(checked(ui, '参考问题 测试问题 01'), true);
  assert.ok(buttonNamed(ui, '删除已选（1）'));
});

test('selection dialogs keep actions in separate footers and editing submits inside its form', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  const verifyFooter = (id, action, sizeClass) => {
    const dialog = dialogNamed(ui, id);
    assert.ok(dialog, `Dialog ${id}`);
    if (sizeClass) assert.ok(dialog.props.className.split(' ').includes(sizeClass));
    assert.ok(dialog.props.children.some((node) => node?.type === 'header'));
    const layout = dialog.props.children.find((node) => node?.props?.children?.some((child) => child?.type === 'footer'));
    assert.ok(layout, `Separate footer in ${id}`);
    const footer = layout.props.children.find((node) => node?.type === 'footer');
    const content = layout.props.children.filter((node) => node && node !== footer);
    assert.ok(content.length > 0);
    assert.ok(ui.text(footer).includes(action));
    assert.equal(content.some((node) => ui.text(node).includes(action)), false);
    return layout;
  };
  await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  verifyFooter('ai-selection-dialog', 'AI 选表', 'ds-modal-basis');
  await ui.click('查看问题');
  verifyFooter('questions-dialog', '完成', 'ds-modal-wide');
  await ui.click('查看或编辑 测试问题 01', true);
  const form = verifyFooter('question-dialog', '保存');
  assert.equal(form.type, 'form');
  await ui.change('问题', '页脚提交后的问题'); await ui.submit();
  assert.equal(ui.calls('questions-save')[0].payload.text, '页脚提交后的问题');
  assert.equal(dialogNamed(ui, 'question-dialog'), undefined);
  await ui.click('泛化问题');
  verifyFooter('original-questions-dialog', '开始泛化', 'ds-modal-originals');
  await ui.change('泛化参考 页脚提交后的问题', true); await ui.click('开始泛化');
  verifyFooter('question-draft-dialog', '保存所选', 'ds-modal-wide');
  await ui.click('取消'); await ui.click('完成'); await ui.click('AI 选表');
  verifyFooter('recommendation-dialog', '确认启用状态', 'ds-modal-wide');
});

test('basis lists every question with independent scroll regions and question actions stay aligned', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  for (let index = 13; index <= 25; index++) ui.fixture.questions.push({ id: `extra-q${index}`, text: `完整问题 ${index}`, answer: '', origin: 'original', version: 1, links: [] });
  await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  const basis = dialogNamed(ui, 'ai-selection-dialog');
  assert.match(ui.text(basis), /已选 25 \/ 25 个问题/);
  assert.equal(ui.nodes().filter((node) => node.props.className === 'ds-stack ds-basis-list').length, 2);
  assert.equal(ui.nodes().filter((node) => node.type === 'label' && node.props.className === 'ds-question-option').length, 25);
  await ui.change('参考问题 完整问题 25', false);
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /已选 24 \/ 25 个问题/);
  const css = ui.text(ui.nodes().find((node) => node.type === 'style'));
  assert.match(css, /ds-modal-basis\{height:min\(640px/);
  assert.match(css, /ds-modal-basis \.ds-modal-body\{[^}]*overflow:hidden/);
  assert.match(css, /ds-basis-list\{[^}]*overflow:auto/);
  assert.match(css, /ds-modal-basis \.ds-basis\{grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /ds-question-actions\{[^}]*justify-content:flex-end/);
  assert.match(css, /ds-questions-table th:last-child\{width:116px/);
  await ui.click('查看问题');
  assert.equal(buttonNamed(ui, '泛化问题').props.className, 'ds-button');
  assert.equal(buttonNamed(ui, '新增问题').props.className, 'ds-button primary');
  const actions = ui.nodes().filter((node) => node.props.className === 'ds-question-actions');
  assert.equal(actions.length, 10);
  assert.ok(actions.every((node) => node.props.children.length === 2 && ui.text(node) === '编辑删除'));
});

test('generalization has original-only independent selection, search select-all, reopen, failure and multi-reference provenance', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.questions[1].answer = '第二参考独立答案';
  ui.fixture.questions[2].origin = 'generated'; ui.fixture.questions[3].origin = 'unknown'; delete ui.fixture.questions[4].origin;
  await openQuestions(ui); await ui.change('全选当前搜索问题', false);
  await ui.click('泛化问题');
  assert.equal(buttonNamed(ui, '开始泛化').props.disabled, true);
  assert.match(dialogNamed(ui, 'original-questions-dialog').props.className, /ds-modal-originals.*ds-modal-scroll/);
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 0 \/ 9 个原问题/);
  assert.equal(control(ui, '泛化参考 测试问题 03'), undefined);
  assert.equal(control(ui, '泛化参考 测试问题 04'), undefined);
  assert.equal(control(ui, '泛化参考 测试问题 05'), undefined);
  await ui.change('泛化参考 测试问题 01', true); await ui.click('取消'); await ui.click('泛化问题');
  assert.equal(checked(ui, '泛化参考 测试问题 01'), true);
  await ui.change('搜索原问题或答案', '第二参考独立答案'); await ui.change('全选当前搜索原问题', true);
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 2 \/ 9 个原问题/);
  await ui.change('全选当前搜索原问题', false);
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 1 \/ 9 个原问题/);
  await ui.change('全选当前搜索原问题', true);
  ui.fixture.failNextAction = 'generalize-question'; await ui.click('开始泛化');
  assert.equal(dialogNamed(ui, 'original-questions-dialog'), undefined);
  assert.equal(dialogNamed(ui, 'question-draft-dialog'), undefined);
  assert.ok(dialogNamed(ui, 'questions-dialog'));
  await ui.click('泛化问题');
  assert.equal(checked(ui, '泛化参考 测试问题 01'), true); assert.equal(checked(ui, '泛化参考 测试问题 02'), true);
  assert.equal(checked(ui, '参考问题 测试问题 01'), false); assert.equal(checked(ui, '参考问题 测试问题 02'), false);
  await ui.click('开始泛化');
  assert.deepEqual(Array.from(ui.calls('generalize-question').at(-1).payload.questions, ({ id, version }) => ({ id, version })), [{ id: 'q1', version: 1 }, { id: 'q2', version: 1 }]);
  assert.deepEqual(Object.keys(stateOf(ui).questionDraft).sort(), ['candidates', 'id', 'questions', 'reason', 'sampleNote']);
  const references = ui.nodes().find((node) => node.props.className === 'ds-link-details ds-reference-summary');
  assert.equal(references.type, 'details'); assert.match(ui.text(references), /参考 2 个原问题.*测试问题 01.*测试问题 02.*第二参考独立答案/);
  await ui.click('保存所选');
  assert.ok(ui.fixture.questions.slice(12).every(({ sourceQuestionId, origin, answer }) => sourceQuestionId === null && origin === 'generated' && answer === ''));
  assert.equal(checked(ui, '参考问题 测试问题 01'), false);
  await ui.click('删除 测试问题 02', true); await ui.click('删除'); await ui.click('泛化问题');
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 1 \/ 8 个原问题/);
  assert.equal(control(ui, '泛化参考 测试问题 02'), undefined);
});

test('generalization selection spans more than twenty originals and cancel keeps references for retry', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  for (let index = 13; index <= 24; index++) ui.fixture.questions.push({ id: `extra-q${index}`, text: `额外原问题 ${index}`, answer: '搜索组', origin: 'original', version: 1, links: [] });
  await openQuestions(ui); await ui.click('泛化问题'); await ui.change('全选当前搜索原问题', true);
  assert.equal(ui.nodes().filter((node) => node.props['aria-label']?.startsWith('泛化参考 ')).length, 24);
  assert.equal(checked(ui, '泛化参考 额外原问题 24'), true);
  await ui.change('搜索原问题或答案', '搜索组'); await ui.change('全选当前搜索原问题', false);
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 12 \/ 24 个原问题/);
  ui.fixture.holdActions.add('generalize-question'); await ui.click('开始泛化');
  assert.equal(ui.calls('generalize-question')[0].payload.questions.length, 12);
  assert.equal(dialogNamed(ui, 'original-questions-dialog'), undefined);
  assert.match(ui.text(dialogNamed(ui, 'questions-dialog')), /正在泛化问题/);
  await ui.click('取消操作');
  assert.equal(ui.calls('cancel').at(-1).payload.operationId, ui.calls('generalize-question')[0].payload.operationId);
  assert.equal(ui.fixture.pending.size, 0);
  await ui.click('泛化问题');
  assert.match(ui.text(dialogNamed(ui, 'original-questions-dialog')), /已选 12 \/ 24 个原问题/);
});

test('reuse hints follow source version and all table structures and loading describes the submitted basis', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  const link = (extra = {}) => ({ sourceId: 'fixture-mysql', tableId: 'table-orders', structureHash: 'table-orders', questionVersion: 1, fields: ['id'], reason: '已有依据', ...extra });
  ui.fixture.questions[0].links = [link()];
  ui.fixture.questions[1].links = [link({ questionVersion: 0 })];
  ui.fixture.questions[2].links = [link({ structureHash: 'old' })];
  ui.fixture.questions[3].links = [link({ tableId: 'removed-table' })];
  ui.fixture.questions[4].links = [link({ sourceId: 'fixture-pg' })];
  ui.fixture.questions[5].links = [link(), link({ tableId: 'table-customers', structureHash: 'old' })];
  await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /可复用关联 1 个，已分析无关联 0 个，待分析 11 个/);
  await ui.change('全选问题', false); await ui.change('参考问题 测试问题 01', true);
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /可复用关联 1 个，已分析无关联 0 个，待分析 0 个/);
  ui.fixture.holdActions.add('suggest'); await ui.click('AI 选表');
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /正在合并已分析结果/);
  await ui.click('取消操作'); await ui.change('参考问题 测试问题 02', true); await ui.click('AI 选表');
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /正在复用 1 个问题关联，分析 1 个问题/);
  await ui.click('取消操作');
});

test('question analysis states distinguish missing, empty and stale without links and refresh after editing', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('测试业务库');
  const state = stateOf(ui);
  for (const [questionId, questionVersion] of [['q2', 1], ['q3', 0]]) ui.fixture.analysisRecords.push({ questionId,
    sourceId: 'fixture-mysql', questionVersion, connectionVersion: state.connectionVersion, catalogId: state.catalog.id });
  await ui.click('AI 辅助选表');
  const basis = () => ui.text(dialogNamed(ui, 'ai-selection-dialog'));
  assert.match(basis(), /可复用关联 0 个，已分析无关联 1 个，待分析 11 个/);
  await ui.click('查看问题');
  for (const [text, expected] of [['测试问题 01', '尚未分析关联'], ['测试问题 02', '已分析未找到关联表'], ['测试问题 03', '关联待重新分析']]) {
    await ui.click(`查看或编辑 ${text}`, true);
    assert.match(ui.text(dialogNamed(ui, 'question-dialog')), new RegExp(expected));
    await ui.click('取消');
  }
  await ui.click('查看或编辑 测试问题 02', true);
  await ui.change('答案（选填）', '变更答案');
  const reads = ui.calls('questions-list').length;
  await ui.submit();
  assert.equal(ui.calls('questions-list').length, reads + 1);
  await ui.click('查看或编辑 测试问题 02', true);
  assert.match(ui.text(dialogNamed(ui, 'question-dialog')), /关联待重新分析/);
  await ui.click('取消'); await ui.click('完成');
  assert.match(basis(), /可复用关联 0 个，已分析无关联 0 个，待分析 12 个/);
  await ui.click('取消'); await ui.click('返回数据源'); await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  assert.match(basis(), /可复用关联 0 个，已分析无关联 0 个，待分析 12 个/);
});

test('generalization persists original linked and empty analyses immediately and candidate cancellation retains source counts', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.originalAnalysisLinks.q2 = [];
  await openQuestions(ui);
  await ui.click('泛化问题');
  await ui.change('泛化参考 测试问题 01', true); await ui.change('泛化参考 测试问题 02', true); await ui.click('开始泛化');
  const basis = () => ui.text(dialogNamed(ui, 'ai-selection-dialog'));
  assert.match(basis(), /可复用关联 1 个，已分析无关联 1 个，待分析 10 个/);
  const result = ui.fixture.aiResults.find(({ action }) => action === 'generalize-question');
  assert.deepEqual(Array.from(result.read.originalAnalysisQuestions, ({ id }) => id), ['q1', 'q2']);
  assert.deepEqual(Array.from(result.result.originalAnalyses, ({ questionId, links }) => [questionId, links.length]), [['q1', 1], ['q2', 0]]);
  assert.deepEqual({ ...result.reply }, { ok: true, originalAnalysesPersisted: true, draftReady: true, candidatesPersisted: false });
  assert.equal(ui.fixture.questions[0].links[0].tableId, 'table-orders');
  assert.equal(ui.fixture.questions[1].links.length, 0);
  assert.equal(ui.fixture.questions.length, 12);
  await ui.click('取消');
  assert.equal(stateOf(ui).questionDraft, null);
  assert.match(basis(), /可复用关联 1 个，已分析无关联 1 个，待分析 10 个/);
  await ui.click('查看或编辑 测试问题 01', true);
  assert.match(ui.text(dialogNamed(ui, 'question-dialog')), /orders测试订单表/); await ui.click('取消');
  await ui.click('查看或编辑 测试问题 02', true);
  assert.match(ui.text(dialogNamed(ui, 'question-dialog')), /已分析未找到关联表/); await ui.click('取消');
  await ui.click('完成'); await ui.click('取消'); await ui.click('返回数据源');
  await ui.click('测试业务库'); await ui.click('AI 辅助选表');
  assert.match(basis(), /可复用关联 1 个，已分析无关联 1 个，待分析 10 个/);
  await ui.change('全选问题', false); await ui.change('参考问题 测试问题 02', true);
  const aiCalls = ui.fixture.aiResults.length;
  await ui.click('AI 选表');
  assert.equal(ui.fixture.aiResults.length, aiCalls);
  assert.equal(stateOf(ui).draft.recommendations.length, 0);
  assert.equal(ui.calls('questions-save').length, 0);
});

test('suggestion analyses preserve explicit empty results and omit reusable questions from AI input', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  ui.fixture.suggestionLinks.q1 = [];
  await ui.click('测试业务库'); await ui.click('AI 辅助选表'); await ui.change('全选问题', false);
  await ui.change('参考问题 测试问题 01', true); await ui.change('参考问题 测试问题 02', true); await ui.click('AI 选表');
  const result = ui.fixture.aiResults.find(({ action }) => action === 'suggest');
  assert.deepEqual(Array.from(result.result.analyses, ({ questionId, links }) => [questionId, links.length]), [['q1', 0], ['q2', 1]]);
  assert.equal(Object.hasOwn(result.result, 'links'), false);
  await ui.click('取消'); await ui.click('AI 辅助选表');
  assert.match(ui.text(dialogNamed(ui, 'ai-selection-dialog')), /可复用关联 1 个，已分析无关联 1 个，待分析 10 个/);
  await ui.change('全选问题', false); await ui.change('参考问题 测试问题 01', true); await ui.change('参考问题 测试问题 02', true);
  const aiCalls = ui.fixture.aiResults.length;
  await ui.click('AI 选表'); assert.equal(ui.fixture.aiResults.length, aiCalls);
});

test('detail refresh owns its timer and cancels an in-flight operation by id', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  assert.equal(ui.timers.size, 0);
  await ui.click('测试业务库');
  const [timer] = ui.timers.values();
  assert.ok(timer.delay > 1_799_000 && timer.delay <= 1_800_000);
  timer.callback(); await ui.flush();
  assert.equal(ui.calls('ensure-scan').at(-1).payload.open, false);
  ui.fixture.holdActions.add('detect-freshness'); await ui.click('时效检测'); await ui.click('取消操作');
  assert.equal(ui.calls('cancel')[0].payload.operationId, ui.calls('detect-freshness')[0].payload.operationId);
  assert.equal(ui.fixture.pending.size, 0);
  await ui.click('返回数据源'); assert.equal(ui.timers.size, 0);
});
