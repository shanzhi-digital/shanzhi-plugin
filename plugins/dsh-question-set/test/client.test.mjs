import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const question = (index) => ({ id: `q${index}`, version: 1, text: `问题 ${index}`, answer: index === 1 ? '原答案' : '', origin: index === 2 ? 'generated' : 'original', links: index === 1 ? [{ tableName: 'orders', schema: 'sales', sourceName: '业务库' }] : [] });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const task = (status = 'running', result = null, id = 'task-1') => ({ taskId: id, sourceId: 's1', status, startedAt: '2026-05-01T00:00:00Z', finishedAt: status === 'running' || status === 'cancelling' ? null : '2026-05-01T00:00:03Z', sessionId: 'session-1', result, error: null });
const result = () => ({ updates: [{ id: 'q1', text: '问题 1', answer: '补答结果', links: [{ tableName: 'orders', schema: 'sales', sourceName: '业务库' }] }], candidates: [
  { id: 'c1', text: '新增问题 A', answer: '查询结果 A', links: [{ tableName: 'customers', schema: 'crm', sourceName: '客户库', sourceComment: '客户基础信息' }] },
  { id: 'c2', text: '新增问题 B', answer: '', links: [], error: 'SQL 查询失败' },
] });

async function mountClient(options = {}) {
  let current, dirty = false, tree, nextTimer = 0, rootElement, mounted = true;
  const instances = new Map(), timers = new Map(), effects = [], registrations = [], calls = [];
  const fixture = { items: Array.from({ length: 13 }, (_, index) => question(index + 1)), task: options.task || null, start: null, poll: null, failRemove: null, ...options.fixture };
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
  const host = { showModal() {}, close() {}, focus() {} };
  const render = (element, path, used) => {
    if (!element || typeof element !== 'object') return element;
    if (typeof element.type === 'function') {
      const key = `${path}:${element.type.name}:${element.props.key || ''}`;
      let instance = instances.get(key);
      if (!instance) { instance = { hooks: [] }; instances.set(key, instance); }
      used.add(key); instance.cursor = 0; current = instance;
      return render(element.type(element.props), `${key}/result`, used);
    }
    if (element.props.ref && typeof element.props.ref === 'object') element.props.ref.current = host;
    const ref = {};
    if (typeof element.props.ref === 'function') element.props.ref(ref);
    return { ...element, props: { ...element.props, indeterminate: ref.indeterminate, children: element.props.children.map((child, index) => render(child, `${path}/${child?.props?.key || index}`, used)) } };
  };
  const commit = () => {
    const used = new Set(); tree = render(rootElement, 'root', used);
    for (const [key, instance] of instances) if (!used.has(key)) { instance.hooks.forEach((hook) => hook?.cleanup?.()); instances.delete(key); }
    effects.splice(0).forEach((effect) => effect());
  };
  const fetch = async (url, request) => {
    assert.ok(url.startsWith('/api/question-set/'));
    assert.equal(request.credentials, 'same-origin');
    const payload = request.body ? JSON.parse(request.body) : undefined;
    const operation = url.slice('/api/question-set/'.length);
    calls.push({ operation, payload, request });
    let value, status = 200;
    if (operation === 'questions') value = { items: structuredClone(fixture.items) };
    else if (operation === 'sources') value = { items: [{ id: 's1', name: '业务库' }, { id: 's2', name: '客户库' }] };
    else if (operation.startsWith('ai-tasks?')) {
      if (fixture.poll) await fixture.poll.promise;
      value = { task: structuredClone(fixture.task) };
    } else if (operation === 'ai-tasks') {
      if (fixture.start) await fixture.start.promise;
      fixture.task = payload.retryFailed ? task('running', { updates: result().updates, candidates: [result().candidates[0]] }, 'task-2') : { ...task(), sourceId: payload.sourceId };
      if (fixture.startResponseLost) { fixture.startResponseLost = false; throw new TypeError('Network response lost'); }
      value = { task: structuredClone(fixture.task) };
    } else if (operation === 'ai-tasks/cancel') {
      if (fixture.cancel) await fixture.cancel.promise;
      fixture.task = { ...fixture.task, status: 'cancelling' }; value = { task: structuredClone(fixture.task) };
    } else if (operation === 'results-discard') {
      fixture.task = null; value = { ok: true };
    } else if (operation === 'results-save') {
      fixture.items = [...fixture.items.map((item) => payload.updateIds.includes(item.id) ? { ...item, answer: '补答结果', version: item.version + 1 } : item), ...payload.candidateIds.map((id) => ({ id, version: 1, text: '保存的泛化问题', answer: '查询结果 A', origin: 'generated', links: [] }))];
      fixture.task = null; value = { items: structuredClone(fixture.items) };
    } else if (operation === 'save') {
      const existing = fixture.items.find((item) => item.id === payload.id);
      const item = { ...existing, ...payload, id: existing?.id || 'manual', version: (existing?.version || 0) + 1, origin: existing?.origin || 'original', links: existing?.links || [] };
      fixture.items = [...fixture.items.filter((entry) => entry.id !== item.id), item]; value = { item };
    } else if (operation === 'remove') {
      if (fixture.failRemove === payload.id) { status = 409; value = { error: '问题已被修改' }; }
      else { fixture.items = fixture.items.filter((item) => item.id !== payload.id); value = { ok: true }; }
    } else throw new Error(`Unexpected ${operation}`);
    return { ok: status === 200, status, json: async () => value };
  };
  let loaded;
  const context = vm.createContext({ console, AbortController, encodeURIComponent, fetch, Date, Set, Map, document: { activeElement: host } });
  context.window = context;
  context.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  context.clearTimeout = (id) => timers.delete(id);
  context.setInterval = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay, interval: true }); return id; };
  context.clearInterval = (id) => timers.delete(id);
  context.__ModuleLoader__ = { load(value) { loaded = value; } };
  vm.runInContext(source, context);
  const plugin = loaded.factory((name) => { assert.equal(name, 'react'); return React; });
  const sessions = [];
  plugin.apply({ slots: { inject(name, callback) { callback(); }, register(meta, component) { registrations.push({ meta, component }); } }, get: () => ({ openSession(id) { sessions.push(id); } }) });
  rootElement = React.createElement(registrations.find(({ meta }) => meta.name === 'main').component); dirty = true;
  const flush = async () => { for (let index = 0; index < 100; index++) { if (mounted && dirty) { dirty = false; commit(); } await Promise.resolve(); } };
  const nodes = () => {
    const all = [];
    const visit = (node) => { if (!node || typeof node !== 'object') return; all.push(node); node.props.children.forEach(visit); };
    visit(tree); return all;
  };
  const text = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.props?.children?.map(text).join('') || '';
  const control = (label) => nodes().find((node) => node.props['aria-label'] === label);
  const namedButton = (label, aria = false) => nodes().filter((node) => node.type === 'button' && (aria ? node.props['aria-label'] === label : text(node) === label)).at(-1);
  const click = async (label, aria = false) => { const node = namedButton(label, aria); assert.ok(node && !node.props.disabled, `Enabled ${label}`); node.props.onClick?.(); await flush(); };
  const change = async (label, value) => { const node = control(label); assert.ok(node && !node.props.disabled, `Enabled control ${label}`); node.props.onChange({ target: { value, checked: value } }); await flush(); };
  const advance = async () => {
    const scheduled = [...timers];
    for (const [id, timer] of scheduled) { assert.equal(timer.delay, 1000); if (!timer.interval) timers.delete(id); timer.callback(); }
    await flush();
  };
  const unmount = () => { mounted = false; for (const instance of instances.values()) instance.hooks.forEach((hook) => hook?.cleanup?.()); instances.clear(); tree = null; };
  const remount = async () => { unmount(); mounted = true; dirty = true; await flush(); };
  const submit = async () => { nodes().find((node) => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flush(); };
  await flush();
  return { loaded, plugin, registrations, fixture, calls, timers, nodes, text, control, namedButton, click, change, flush, advance, unmount, remount, submit, sessions };
}
const calls = (ui, operation) => ui.calls.filter((call) => call.operation === operation);
const table = (ui, id) => ui.nodes().find((node) => node.props['data-testid'] === id);

test('registers an isolated question-set page and loads only the new API', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  assert.equal(ui.loaded.id, 'dsh-question-set'); assert.equal(ui.plugin.name, 'question-set');
  assert.deepEqual(ui.registrations.map(({ meta }) => JSON.parse(JSON.stringify(meta))), [
    { name: 'main', key: 'question-set' }, { name: 'sidebar.panellist', id: 'question-set', order: 5.5, label: '问题集' },
  ]);
  assert.equal(calls(ui, 'questions')[0].request.method, 'GET'); assert.equal(calls(ui, 'sources').length, 1);
  assert.equal(ui.control('选择问题 问题 1').props.checked, false);
  assert.equal(ui.namedButton('泛化问题').props.disabled, true);
  assert.match(ui.text(table(ui, 'questions-table')), /问题.*答案.*最近评测准确率.*通过状态.*操作/);
  assert.doesNotMatch(ui.text(table(ui, 'questions-table')), /关联表|orders|业务库/);
  assert.equal(ui.namedButton('批量评测').props.disabled, true);
  assert.ok(ui.nodes().filter(node => node.type === 'button' && /^评测 /.test(node.props['aria-label'] || '')).every(node => node.props.disabled));
  assert.ok(ui.namedButton('新增问题').props.className.includes('primary'));
  assert.equal(ui.nodes().some((node) => node.type === 'dialog'), false);
});

test('editing a table without a comment displays only its table name', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('编辑 问题 1', true);
  assert.equal(ui.text(ui.control('关联表')), '关联表orders');
});

test('selection persists across pages and filtered select-all preserves other choices', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.change('选择问题 问题 1', true); await ui.click('下一页'); await ui.change('选择问题 问题 13', true);
  await ui.change('搜索问题或答案', '问题 2'); await ui.change('全选当前筛选问题', true);
  await ui.change('搜索问题或答案', ''); assert.equal(ui.control('选择问题 问题 1').props.checked, true);
  assert.equal(ui.control('全选当前筛选问题').props.indeterminate, true);
  await ui.click('下一页'); assert.equal(ui.control('选择问题 问题 13').props.checked, true);
  await ui.click('泛化问题');
  assert.deepEqual(calls(ui, 'ai-tasks')[0].payload, { sourceId: 's1', questions: [{ id: 'q1', version: 1 }, { id: 'q2', version: 1 }, { id: 'q13', version: 1 }] });
  assert.equal(ui.nodes().some((node) => node.type === 'dialog'), false);
});

test('CRUD sends versions and batch deletion retains only failures for retry', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.click('新增问题'); await ui.change('问题', '手动问题'); await ui.change('答案（选填）', '手动答案'); await ui.submit();
  assert.deepEqual(calls(ui, 'save')[0].payload, { text: '手动问题', answer: '手动答案' });
  await ui.change('搜索问题或答案', '手动答案'); await ui.click('编辑 手动问题', true); await ui.change('问题', '修改问题');
  assert.equal(ui.control('答案（选填）').props.value, '');
  await ui.change('答案（选填）', '修改后的答案'); await ui.submit();
  assert.deepEqual(calls(ui, 'save')[1].payload, { id: 'manual', version: 1, text: '修改问题', answer: '修改后的答案' });
  await ui.change('搜索问题或答案', ''); await ui.change('选择问题 问题 1', true); await ui.change('选择问题 问题 2', true);
  await ui.click('批量删除'); assert.equal(calls(ui, 'remove').length, 0); assert.match(ui.text(table(ui, 'delete-dialog')), /确认删除以下 2 个问题/);
  ui.fixture.failRemove = 'q2'; await ui.click('删除');
  assert.deepEqual(calls(ui, 'remove').map(({ payload }) => payload), [{ id: 'q1', version: 1 }, { id: 'q2', version: 1 }]);
  assert.match(ui.text(table(ui, 'delete-dialog')), /问题已被修改.*确认删除以下 1 个问题/);
  ui.fixture.failRemove = null; await ui.click('删除');
  assert.deepEqual(calls(ui, 'remove').at(-1).payload, { id: 'q2', version: 1 });
  assert.equal(table(ui, 'delete-dialog'), undefined);
});

test('any question origin can start generalization and partial results stay inline until query completion', async (t) => {
  const ui = await mountClient(); t.after(ui.unmount);
  await ui.change('泛化数据源', 's2');
  await ui.change('选择问题 问题 2', true); await ui.click('泛化问题');
  assert.equal(calls(ui, 'ai-tasks')[0].payload.sourceId, 's2');
  ui.fixture.task = { ...task('running', result()), sourceId: 's2' }; await ui.advance();
  assert.ok(table(ui, 'updates-results')); assert.ok(table(ui, 'candidates-results'));
  assert.match(ui.text(table(ui, 'candidates-results')), /新增问题 A查询结果 Acustomers客户基础信息/);
  assert.doesNotMatch(ui.text(table(ui, 'candidates-results')), /crm\.|客户库/);
  assert.match(ui.text(table(ui, 'candidates-results')), /SQL 查询失败/);
  assert.equal(ui.control('选择新增泛化问题 新增问题 B').props.disabled, true);
  assert.equal(ui.namedButton('保存所选结果'), undefined);
  assert.equal(ui.nodes().filter((node) => node.type === 'textarea').length, 0);
  ui.fixture.task = { ...task('succeeded', result()), sourceId: 's2' }; await ui.advance();
  await ui.change('选择已选问题补答 问题 1', false); await ui.click('保存所选结果');
  assert.deepEqual(calls(ui, 'results-save')[0].payload, { taskId: 'task-1', candidateIds: ['c1'], updateIds: [] });
  assert.equal(table(ui, 'task-results'), undefined);
  await ui.change('搜索问题或答案', '保存的泛化问题');
  assert.match(ui.text(table(ui, 'questions-table')), /保存的泛化问题/);
});

test('failed-result retry uses task identity and saving consumes the replacement task only', async (t) => {
  const ui = await mountClient({ task: task('succeeded', result()) }); t.after(ui.unmount);
  await ui.click('重新处理失败');
  assert.deepEqual(calls(ui, 'ai-tasks')[0].payload, { taskId: 'task-1', retryFailed: true });
  assert.match(ui.text(table(ui, 'updates-results')), /补答结果/);
  ui.fixture.task = task('succeeded', { updates: result().updates, candidates: result().candidates.map((item) => ({ ...item, answer: '重试答案', error: undefined })) }, 'task-2');
  await ui.advance(); await ui.change('选择新增泛化问题 新增问题 A', false); await ui.click('保存所选结果');
  assert.deepEqual(calls(ui, 'results-save')[0].payload, { taskId: 'task-2', candidateIds: ['c2'], updateIds: ['q1'] });
  assert.equal(ui.namedButton('重新处理失败'), undefined);
});

test('reentry restores by source, cancel waits for a terminal snapshot and discard removes preview', async (t) => {
  const ui = await mountClient({ task: task('running', result()) }); t.after(ui.unmount);
  assert.ok(calls(ui, 'ai-tasks?sourceId=s1').length);
  await ui.click('查看会话'); assert.deepEqual(ui.sessions, ['session-1']);
  await ui.click('取消操作');
  assert.deepEqual(calls(ui, 'ai-tasks/cancel')[0].payload, { taskId: 'task-1' });
  assert.equal(ui.namedButton('正在取消…').props.disabled, true);
  assert.equal(ui.namedButton('丢弃结果'), undefined);
  ui.fixture.task = task('cancelled', result()); await ui.advance(); await ui.click('丢弃结果');
  assert.deepEqual(calls(ui, 'results-discard')[0].payload, { taskId: 'task-1' });
  assert.equal(table(ui, 'task-results'), undefined);
});

test('polling is serial and unmount aborts the in-flight request without cancelling the task', async () => {
  const ui = await mountClient({ task: task() });
  const gate = deferred(); ui.fixture.poll = gate;
  await ui.advance();
  const pending = calls(ui, 'ai-tasks?taskId=task-1'); assert.equal(pending.length, 1);
  await ui.advance(); assert.equal(calls(ui, 'ai-tasks?taskId=task-1').length, 1);
  ui.unmount();
  assert.equal(pending[0].request.signal.aborted, true); assert.equal(calls(ui, 'ai-tasks/cancel').length, 0);
  assert.equal(ui.timers.size, 0);
  gate.resolve(); await ui.flush(); assert.equal(ui.timers.size, 0);
});

test('stale table links and unknown origins retain their explicit status', async (t) => {
  const item = question(1); item.origin = 'unknown'; item.links[0].valid = false; item.links[0].sourceComment = '订单明细';
  const ui = await mountClient({ fixture: { items: [item] } }); t.after(ui.unmount);
  assert.match(ui.text(table(ui, 'questions-table')), /来源待确认/);
  assert.doesNotMatch(ui.text(table(ui, 'questions-table')), /orders|关联待重新查询/);
  await ui.click('编辑 问题 1', true);
  const related = ui.control('关联表');
  assert.match(ui.text(related), /关联表orders订单明细关联待重新查询/);
  assert.doesNotMatch(ui.text(related), /sales\.|业务库/);
});

test('lost start response restores by source without repeating the task POST', async (t) => {
  const ui = await mountClient({ fixture: { startResponseLost: true } }); t.after(ui.unmount);
  await ui.change('选择问题 问题 1', true); await ui.click('泛化问题');
  assert.equal(calls(ui, 'ai-tasks').length, 1);
  assert.equal(calls(ui, 'ai-tasks?sourceId=s1').length, 2);
  assert.ok(table(ui, 'task-results'));
  assert.equal(ui.namedButton('取消操作').props.disabled, false);
});

test('consumed task snapshots do not restore candidates and source selection survives reentry', async (t) => {
  const ui = await mountClient({ task: { ...task('succeeded', result()), resultState: 'saved' } }); t.after(ui.unmount);
  assert.equal(table(ui, 'task-results'), undefined);
  await ui.change('泛化数据源', 's2');
  ui.fixture.task = { ...task('succeeded', result()), sourceId: 's2', resultState: 'discarded' };
  await ui.remount();
  assert.equal(ui.control('泛化数据源').props.value, 's2');
  assert.ok(calls(ui, 'ai-tasks?sourceId=s2').length);
  assert.equal(table(ui, 'candidates-results'), undefined);
});

test('unmount during cancel aborts its observation and keeps all polling cleared', async () => {
  const ui = await mountClient({ task: task() }); const gate = deferred(); ui.fixture.cancel = gate;
  await ui.click('取消操作');
  assert.equal(ui.namedButton('取消操作').props.disabled, true);
  ui.unmount(); assert.equal(calls(ui, 'ai-tasks/cancel')[0].request.signal.aborted, true);
  gate.resolve(); await ui.flush(); assert.equal(ui.timers.size, 0);
});

test('unmount while starting aborts observation and does not schedule task polling', async () => {
  const ui = await mountClient(); const gate = deferred(); ui.fixture.start = gate;
  await ui.change('选择问题 问题 1', true); await ui.click('泛化问题');
  ui.unmount(); assert.equal(calls(ui, 'ai-tasks')[0].request.signal.aborted, true);
  gate.resolve(); await ui.flush(); assert.equal(ui.timers.size, 0); assert.equal(calls(ui, 'ai-tasks/cancel').length, 0);
});
