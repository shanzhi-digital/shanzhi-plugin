// Smoke test: evaluate client.js with a stub module loader + React, then run apply()
// against a fake slots registry to prove the module both parses and self-registers.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(resolve(here, '..', 'client.js'), 'utf8');

let loaded;
globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition; } } };
const React = {
  createElement: (...args) => ({ type: 'element', args }),
  Fragment: 'fragment',
  useRef: () => ({ current: null }),
  useId: () => 'smoke-result',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};
const requireStub = (id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected external: ${id}`);
};

new Function('window', 'module', 'exports', 'require', code)(globalThis.window, undefined, undefined, requireStub);
if (!loaded) throw new Error('module loader was not called');
console.log('bundle id:', loaded.id);

const module = loaded.factory(requireStub);
console.log('exports:', Object.keys(module).join(','));
console.log('inject:', (module.inject || []).join(','));

let registeredSlot;
const registeredEvents = [];
const ctx = {
  uiConversation: { events: { register: (definition) => registeredEvents.push(definition) } },
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => { registeredSlot = { ...options, component }; },
  },
};
module.apply(ctx);
console.log('events registered:', registeredEvents.length, registeredEvents[0]?.kind);
console.log('slot:', registeredSlot?.name, registeredSlot?.id, registeredSlot?.order);
if (!registeredSlot || registeredSlot.id !== 'datahub-echarts') throw new Error('slot not registered');
console.log('SMOKE OK');

// Render one turn tail: the card body (segmented control + chart/table switch) must not throw.
const sample = {
  title: '按活动类型统计学生志愿服务情况',
  datasourceId: '3000017',
  columns: [
    { name: 'activity_type', title: '活动类别', type: 'String' },
    { name: 'enroll_total', title: '已报名人数合计', type: 'Int64' },
  ],
  data: [
    { activity_type: '志愿服务', enroll_total: '691' },
    { activity_type: '文体活动', enroll_total: '1006' },
  ],
  rowCount: 2,
  truncated: false,
  dimension: 'activity_type',
  measures: ['enroll_total'],
  chartType: 'bar',
  reason: '',
  followUps: ['各活动类型的报名人数排名？', '换成签到人数呢？', '按月看报名趋势'],
};
const TurnTail = registeredSlot.component ?? registeredSlot;

// A click on a follow-up must reach InputActions.insertText, not send anything itself.
let inserted = null;
let captured = false;
const inputActions = {
  captureInsertion: () => { captured = true; return { revision: 1 }; },
  insertText: (text) => { inserted = text; },
};
const tree = TurnTail({ seq: 10, turn: { data: { get: () => [{ seq: 5, value: sample }] } }, inputActions });
if (!tree) throw new Error('turn tail rendered nothing');
console.log('TURN TAIL RENDER OK');

const buttons = [];
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== 'object' || node.type !== 'element') return;
  const [type, props, ...children] = node.args;
  if (typeof type === 'function') return walk(type(props)); // render function components like React would
  if (type === 'button' && props && props.onClick) buttons.push(props);
  children.forEach(walk);
};
walk(tree);
const followUpButtons = buttons.filter((props) => sample.followUps.includes(props.title));
if (followUpButtons.length !== 3) throw new Error(`expected 3 follow-up buttons, got ${followUpButtons.length}`);
if (buttons.length !== 4) throw new Error(`expected export button + 3 outside follow-ups, got ${buttons.length}`);
followUpButtons[0].onClick();
if (!captured) throw new Error('captureInsertion was not used');
if (inserted !== sample.followUps[0]) throw new Error(`unexpected insertion: ${inserted}`);
console.log('FOLLOW-UP CLICK OK:', inserted);
