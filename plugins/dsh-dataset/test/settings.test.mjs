import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../settings.js';
import { DEFAULT_PROMPT, TOOL_PROTOCOL, questionPrompt } from '../task-prompts.js';
import { createRoutes } from '../routes.js';
import { apply } from '../index.js';
import { QuestionFlow } from '../flow.js';
import { AiTasks } from '../ai-tasks.js';

async function profile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'question-set-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const request = (path, value) => new Request(`http://localhost/api/question-set/${path}`, value === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});

test('提示词默认值、持久保存、重新创建服务和恢复默认共用Profile文件', async t => {
  const profileDir = await profile(t), settings = createSettings({ profileDir });
  assert.deepEqual(await settings.get(), { prompt: DEFAULT_PROMPT, defaultPrompt: DEFAULT_PROMPT, protocol: TOOL_PROTOCOL });
  const prompt = '  优先关注床位变化。\n逐项回答。  ';
  assert.equal((await settings.save({ prompt })).prompt, prompt);
  assert.deepEqual(JSON.parse(await readFile(join(profileDir, 'question-set', 'settings.json'), 'utf8')), { prompt });
  assert.deepEqual(await readdir(join(profileDir, 'question-set')), ['settings.json']);
  const restarted = createSettings({ profileDir });
  assert.equal((await restarted.get()).prompt, prompt);
  await restarted.save({ prompt: (await restarted.get()).defaultPrompt });
  assert.equal((await settings.get()).prompt, DEFAULT_PROMPT);
  await settings.save({ prompt: '字'.repeat(20000) });
  assert.equal((await restarted.get()).prompt.length, 20000);
});

test('设置拒绝非法格式、空白和超长提示词且保留已保存配置', async t => {
  const settings = createSettings({ profileDir: await profile(t) });
  await settings.save({ prompt: '已保存的要求' });
  for (const input of [undefined, null, [], '文本', {}, { prompt: null }, { prompt: 123 }, { prompt: '' }, { prompt: ' \n ' }, { prompt: '字'.repeat(20001) }, { prompt: '文本', sourceId: 'source' }]) {
    await assert.rejects(settings.save(input), error => error.status === 400 && /20000/.test(error.publicMessage));
  }
  assert.equal((await settings.get()).prompt, '已保存的要求');
});

test('损坏配置及文件读写错误如实返回，不回退默认值', async t => {
  const profileDir = await profile(t), settings = createSettings({ profileDir });
  await mkdir(join(profileDir, 'question-set'));
  const filename = join(profileDir, 'question-set', 'settings.json');
  for (const contents of ['{broken', JSON.stringify({ prompt: '' }), JSON.stringify({ prompt: '文本', extra: true })]) {
    await writeFile(filename, contents);
    await assert.rejects(settings.get(), error => error.status === 500 && /读取/.test(error.publicMessage));
  }
  await rm(filename);
  await mkdir(filename);
  await assert.rejects(settings.get(), error => error.status === 500 && /读取/.test(error.publicMessage));
  await assert.rejects(settings.save({ prompt: '有效提示词' }), error => error.status === 500 && /保存/.test(error.publicMessage));
  assert.deepEqual(await readdir(join(profileDir, 'question-set')), ['settings.json']);
});

test('配置API在管理库不可用时仍能读取、保存、恢复默认和报告配置错误', async t => {
  const profileDir = await profile(t), routes = [], handlers = {};
  let databaseReads = 0;
  const ctx = {
    credentials: { async readRecord() { databaseReads++; throw new Error('管理库不可用'); } },
    connection: { fetch: { register(route) { routes.push(route); } } },
    tools: { register() {} }, on(event, handler) { handlers[event] = handler; },
  };
  await apply(ctx, { profileDir });
  t.after(() => handlers.dispose());
  const endpoint = routes.find(route => route.path === '/api/question-set/prompt-settings');
  assert.equal((await (await endpoint.fetch(request('prompt-settings'))).json()).prompt, DEFAULT_PROMPT);
  const saved = await endpoint.fetch(request('prompt-settings', { prompt: '只关注业务结论' }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).prompt, '只关注业务结论');
  const restored = await endpoint.fetch(request('prompt-settings', { prompt: DEFAULT_PROMPT }));
  assert.equal((await restored.json()).prompt, DEFAULT_PROMPT);
  for (const value of [null, [], { prompt: '' }, { prompt: '字'.repeat(20001) }, { prompt: '文本', seed: {} }]) {
    assert.equal((await endpoint.fetch(request('prompt-settings', value))).status, 400);
  }
  assert.equal(databaseReads, 0);
  const questions = routes.find(route => route.path.endsWith('/questions'));
  assert.equal((await questions.fetch(request('questions'))).status, 503);
  assert.equal(databaseReads, 1);
  assert.equal((await endpoint.fetch(request('prompt-settings', { prompt: '管理库失败后仍可保存' }))).status, 200);
  await writeFile(join(profileDir, 'question-set', 'settings.json'), '{broken');
  const broken = await endpoint.fetch(request('prompt-settings'));
  assert.equal(broken.status, 500);
  assert.match((await broken.json()).error, /读取泛化提示词配置/);
  assert.equal(databaseReads, 1);
});

test('createRoutes构造不调用空mock，旧调用方普通任务使用默认提示词', async () => {
  assert.ok(createRoutes({ store: {}, query: {}, flow: {}, tasks: {} }).length);
  let snapshot;
  const routes = createRoutes({ store: {}, query: {}, flow: { prune() {} }, tasks: {
    tasks: new Map(), _prune() {}, start(input) { snapshot = input; return { taskId: 'task' }; },
  } });
  const endpoint = routes.find(route => route.path.endsWith('/ai-tasks'));
  assert.equal((await endpoint.fetch(request('ai-tasks', { sourceId: 'source', questions: [{ id: 'q1', version: 1 }] }))).status, 202);
  assert.equal(snapshot.prompt, DEFAULT_PROMPT);
});

test('普通任务读取服务端配置形成快照，重试沿用原输入且新任务获取最新配置', async t => {
  const settings = createSettings({ profileDir: await profile(t) });
  const original = '原任务业务要求：仅关注床位', changed = '新任务业务要求：关注趋势';
  await settings.save({ prompt: original });
  const table = { tableId: 't1', name: 'beds', fields: [{ name: 'count', type: 'INTEGER' }] };
  const questions = [{ id: 'q1', version: 1, text: '床位总数？', answer: '', origin: 'original', links: [] }];
  let flow, stage = 0, reads = 0;
  const messages = [], snapshots = [];
  const bridge = {
    async create() { return { sessionId: `session-${stage++}` }; },
    async observe() { return async () => {}; },
    async send({ sessionId, text }) {
      messages.push(text);
      const call = input => flow.task(input, { agent: { session: { id: sessionId } } });
      const initial = await call({ operation: 'read' });
      const retry = initial.items.length > 0;
      const items = retry ? initial.items : (await call({ operation: 'plan', candidates: [], reason: '仅补答已选问题。' })).items;
      for (const item of items) {
        if (!retry) await call({ operation: 'fail-item', itemId: item.id, error: '本次查询失败' });
        else {
          const result = await call({ operation: 'query', itemId: item.id, sql: 'SELECT sum(count) FROM beds' });
          await call({ operation: 'answer', itemId: item.id, answer: '床位合计12张。', queryIds: [result.queryId] });
        }
      }
      await call({ operation: 'finish' });
    },
    async cancel() {},
  };
  const store = { async list() { return structuredClone(questions); } };
  const query = {
    async schema() { return { sourceId: 'source', name: '数据源', engine: 'sqlite', tables: [table], connectionVersion: 'v1' }; },
    async query() { return { columns: ['total'], rows: [[12]], rowCount: 1, truncated: false, tables: [table], connectionVersion: 'v1' }; },
  };
  flow = new QuestionFlow({ store, query, bridge, cwd: process.cwd(), timeoutMs: 2000 });
  const tasks = new AiTasks({ validate: input => flow.validate(input), identify: input => ({ sourceId: input.sourceId, kind: 'generalize' }), execute(input, ...args) { snapshots.push(structuredClone(input)); return flow.run(input, ...args); } });
  t.after(() => tasks.close());
  const routes = createRoutes({ store, query, flow, tasks, settings: { async get() { reads++; return settings.get(); } } });
  const endpoint = routes.find(route => route.path.endsWith('/ai-tasks'));
  const input = { sourceId: 'source', questions: [{ id: 'q1', version: 1 }] };
  for (const extra of [{ seed: {} }, { prompt: '客户端覆盖' }]) assert.equal((await endpoint.fetch(request('ai-tasks', { ...input, ...extra }))).status, 400);
  const firstResponse = await endpoint.fetch(request('ai-tasks', input));
  assert.equal(firstResponse.status, 202);
  const first = (await firstResponse.json()).task;
  await tasks.tasks.get(first.taskId).done;
  assert.equal(tasks.get(first.taskId).status, 'succeeded');
  assert.equal(snapshots[0].prompt, original);
  assert.equal(flow.retry(first.taskId).prompt, original);
  await settings.save({ prompt: changed });
  const retryResponse = await endpoint.fetch(request('ai-tasks', { taskId: first.taskId, retryFailed: true }));
  assert.equal(retryResponse.status, 202);
  const retried = (await retryResponse.json()).task;
  await tasks.tasks.get(retried.taskId).done;
  assert.equal(tasks.get(retried.taskId).status, 'succeeded');
  assert.equal(snapshots[1].prompt, original);
  assert.equal(reads, 1, '重试不读取已变更的配置');
  assert.ok(messages[1].includes(original));
  assert.ok(!messages[1].includes(changed));
  const latestResponse = await endpoint.fetch(request('ai-tasks', input));
  assert.equal(latestResponse.status, 202);
  const latest = (await latestResponse.json()).task;
  await tasks.tasks.get(latest.taskId).done;
  assert.equal(snapshots[2].prompt, changed);
  assert.equal(reads, 2);
  assert.ok(messages[2].includes(changed));
});

test('可编辑业务提示词与固定工具协议组合，首次和重试都保留真实查询协议', () => {
  assert.match(DEFAULT_PROMPT, /15～20/);
  assert.match(DEFAULT_PROMPT, /1～3/);
  assert.match(DEFAULT_PROMPT, /紧凑分行逐项完整回答/);
  assert.match(DEFAULT_PROMPT, /不使用Markdown表格/);
  assert.match(DEFAULT_PROMPT, /不展示SQL、技术性表名和字段名/);
  for (const retry of [false, true]) {
    const prompt = questionPrompt({ retry, prompt: '自定义业务要求' });
    assert.ok(prompt.includes(TOOL_PROTOCOL));
    assert.ok(prompt.endsWith('自定义业务要求'));
    assert.ok(!prompt.includes(DEFAULT_PROMPT));
    assert.match(prompt, /queryIds 必须属于该条问题/);
  }
  assert.ok(questionPrompt().includes(DEFAULT_PROMPT));
});

test('独立答题提示词与泛化配置隔离，配置读取失败也不影响查询任务', async () => {
  let snapshot, reads = 0;
  const routes = createRoutes({ store: {}, query: {}, flow: { prune() {} }, tasks: {
    tasks: new Map(), _prune() {}, start(input) { snapshot = input; return { taskId: 'answer-task', kind: input.kind }; },
  }, settings: { async get() { reads++; throw new Error('泛化配置损坏'); } } });
  const endpoint = routes.find(route => route.path.endsWith('/ai-tasks'));
  const response = await endpoint.fetch(request('ai-tasks', { kind: 'answer', sourceId: 'source', questions: [{ id: 'q1', version: 1 }] }));
  assert.equal(response.status, 202);
  assert.equal(reads, 0);
  assert.equal(snapshot.kind, 'answer');
  for (const retry of [false, true]) {
    const message = questionPrompt({ ...snapshot, retry });
    assert.match(message, /无论是否已有答案都重新执行真实查询/);
    assert.match(message, /queryIds 必须属于该条问题/);
    assert.match(message, /1～3/);
    assert.doesNotMatch(message, /15～20|已存在的答案不改写/);
  }
});
