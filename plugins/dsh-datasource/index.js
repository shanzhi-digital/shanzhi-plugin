import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatasourceRuntime } from './runtime.js';
import { DatasourceFlow } from './flow.js';
import { DatasourceSessionBridge, injectKeys } from './host-bridge.js';
import { createAnnotationStore } from './annotation-store.js';
import { createDatasourceService } from './service.js';

export const name = 'sql';
export const inject = ['tools', 'connection', 'credentials', ...injectKeys];
export const API_PREFIX = '/api/datasources';
const SETUP_MESSAGE = '请先在数据源页面配置 MySQL 管理库。';
const MANAGEMENT_ERROR = '管理库连接或结构校验失败，请先在独立管理库执行初始化 SQL，再检查配置和凭据。';

function publicError(message, status = 400) {
  return Object.assign(new Error(message), { publicMessage: message, status });
}

export function createSecrets(credentials) {
  const recordKey = (key) => {
    const id = String(key).replaceAll(':', '-').toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('无效的连接凭据标识。');
    return `sql/${id}`;
  };
  return {
    async get(key) {
      const record = await credentials.readRecord(recordKey(key));
      return record?.kind === 'grant' && typeof record.payload?.password === 'string' ? record.payload.password : undefined;
    },
    async set(key, password) {
      await credentials.modifyRecord(recordKey(key), async () => ({ kind: 'grant', payload: { password } }));
    },
    async delete(key) { await credentials.deleteRecord(recordKey(key)); },
  };
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function registerRoutes(ctx, runtimeOrGetter, flow, management) {
  const current = typeof runtimeOrGetter === 'function' ? runtimeOrGetter : () => ({ runtime: runtimeOrGetter, flow });
  const definitions = [
    ...(management ? [
      ['management-status', 'GET', () => management.status()],
      ['management-save', 'POST', (input) => management.save(input)],
    ] : []),
    ['list', 'GET', async () => ({ items: await current().runtime.list() })],
    ['save', 'POST', async (input) => {
      const { runtime, flow } = current();
      const item = await runtime.save(input);
      if (input.id) await flow?.sourceChanged(item.id, item);
      return { item };
    }],
    ['test', 'POST', async (input) => await current().runtime.test(input)],
    ['remove', 'POST', async (input) => {
      if (typeof input.id !== 'string' || !input.id) throw publicError('请选择要删除的数据源。');
      const { runtime, flow } = current();
      await runtime.remove(input.id, input.revision);
      await flow?.sourceChanged(input.id, null);
      return { ok: true };
    }],
    ['source-status', 'POST', async (input) => {
      if (!Array.isArray(input.items) || input.items.length > 1000) throw publicError('请选择有效的数据源。');
      const { runtime, flow } = current();
      const results = [];
      for (const entry of input.items) {
        try {
          const item = await runtime.setEnabled(entry.id, entry.enabled, entry.revision);
          await flow?.sourceChanged(item.id, item);
          results.push({ id: item.id, ok: true, item });
        } catch (error) { results.push({ id: entry?.id, ok: false, error: error?.publicMessage || '更新数据源状态失败。' }); }
      }
      return { results };
    }],
    ...(flow || typeof runtimeOrGetter === 'function' ? [
      ['questions-list', 'POST', async (input) => ({ items: await current().store.listQuestions(input.id) })],
      ['questions-save', 'POST', async (input) => ({ item: await current().store.saveQuestion(input) })],
      ['questions-remove', 'POST', async (input) => { await current().store.removeQuestion(input.id, input.version); return { ok: true }; }],
      ['flow-state', 'POST', async (input) => ({ state: await current().flow.get(input.id) })],
      ['flow-action', 'POST', async (input, signal) => {
        const { sessionId, ...state } = await current().flow.action(input, signal);
        return { state, ...(sessionId ? { sessionId } : {}) };
      }],
      ['flow-samples', 'POST', (input, signal) => current().flow.sampleTable(input, signal)],
    ] : []),
  ];
  for (const [operation, method, handler] of definitions) {
    // Exact-fetch routes are protected by the Host's authenticated-owner boundary.
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${operation}`,
      methods: [method],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          let input = {};
          if (method === 'POST') {
            if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json({ error: '请使用 JSON 提交连接信息。' }, 415);
            const body = await request.text();
            if (Buffer.byteLength(body, 'utf8') > (operation.startsWith('flow-') ? 1048576 : 32768)) return json({ error: '提交信息过长。' }, 413);
            try { input = JSON.parse(body); } catch { return json({ error: '连接信息格式无效。' }, 400); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: '连接信息格式无效。' }, 400);
          }
          if (request.signal.aborted) return json({ error: '请求已取消。' }, 408);
          return json(await handler(input, request.signal));
        } catch (error) {
          const status = [400, 404, 409, 413, 503].includes(error?.status) ? error.status : 400;
          return json({ error: error?.publicMessage || '操作失败，请检查连接信息后重试。', ...(typeof error?.sessionId === 'string' ? { sessionId: error.sessionId } : {}) }, status);
        }
      },
    });
  }
}

function managementConfig(input, previous) {
  const result = {};
  for (const [key, label] of [['host', '主机地址'], ['user', '数据库账号'], ['database', '数据库名称']]) {
    const value = input[key] ?? previous?.[key];
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw publicError(`管理库${label}格式无效。`);
    result[key] = value.trim();
  }
  if (/[\s/@\\?#]/.test(result.host) || result.host.includes('://')) throw publicError('管理库主机地址应填写主机名或 IP。');
  const rawPort = input.port ?? previous?.port ?? 3306;
  result.port = typeof rawPort === 'string' && /^\d+$/.test(rawPort) ? Number(rawPort) : rawPort;
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw publicError('管理库端口必须是 1 到 65535 的整数。');
  if (input.password !== undefined && typeof input.password !== 'string') throw publicError('管理库密码格式无效。');
  result.password = input.clearPassword === true ? '' : input.password || previous?.password || '';
  return result;
}

async function createProductionServices(options) {
  const [{ openManagementDb }, { MysqlFlowStore }] = await Promise.all([
    import('./management-db.js'), import('./flow-store.js'),
  ]);
  const db = await openManagementDb({ ...options.managementConfig, profileId: options.profileId });
  let runtime, flow;
  try {
    const store = new MysqlFlowStore(db);
    runtime = new DatasourceRuntime({ store, secrets: options.secrets, managementConfig: options.managementConfig });
    await runtime.initialize();
    flow = new DatasourceFlow({ store, runtime, bridge: options.bridge, defaultCwd: options.defaultCwd });
    await flow.initialize();
    return { runtime, flow, store, annotations: createAnnotationStore({ db, store }), async close() { try { await flow.close(); } finally { try { await runtime.close(); } finally { await db.close(); } } } };
  } catch (error) {
    await flow?.close().catch(() => {});
    await runtime?.close().catch(() => {});
    await db.close().catch(() => {});
    throw error;
  }
}

export async function apply(ctx, config = {}) {
  return applyWithServices(ctx, config);
}

// Explicit injection for contract tests; production always uses MySQL management storage.
export async function applyWithServices(ctx, config = {}, { createServices = createProductionServices, initialServices } = {}) {
  const profileDir = resolve(process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop'));
  const profileId = createHash('sha256').update(process.platform === 'win32' ? profileDir.toLowerCase() : profileDir).digest('hex');
  const recordKey = `sql/management-${profileId}`;
  const secrets = createSecrets(ctx.credentials);
  let savedConfig, services = initialServices, startupMessage, closed = false;
  let tail = Promise.resolve();
  const closeServices = async (value) => {
    if (!value) return;
    if (value.close) return value.close();
    try { await value.flow.close(); } finally { await value.runtime.close(); }
  };
  const initialize = (settings) => createServices({
    managementConfig: settings, profileId, profileDir, secrets,
    bridge: new DatasourceSessionBridge(ctx), defaultCwd: config.workingDirectory || process.cwd(),
  });
  try {
    const stored = await ctx.credentials.readRecord(recordKey);
    if (stored !== undefined && stored !== null) {
      if (stored.kind !== 'grant' || !stored.payload || typeof stored.payload !== 'object') throw new Error('invalid bootstrap');
      savedConfig = managementConfig(stored.payload);
      if (!services) services = await initialize(savedConfig);
    }
  } catch { startupMessage = MANAGEMENT_ERROR; }
  const current = () => {
    if (closed) throw publicError('数据源服务已关闭。', 503);
    if (!services) throw publicError(startupMessage || SETUP_MESSAGE, 503);
    return services;
  };
  const status = () => ({
    configured: Boolean(savedConfig || initialServices), ready: Boolean(services) && !closed,
    message: startupMessage || (services ? '管理库已就绪。' : SETUP_MESSAGE),
    ...(savedConfig ? { settings: { host: savedConfig.host, port: savedConfig.port, user: savedConfig.user, database: savedConfig.database, hasPassword: Boolean(savedConfig.password) } } : {}),
  });
  const management = {
    status,
    save(input) {
      const operation = tail.then(async () => {
        if (closed) throw publicError('数据源服务已关闭。', 503);
        const next = managementConfig(input, savedConfig);
        if (savedConfig && ['host', 'port', 'database'].some(key => next[key] !== savedConfig[key])) throw publicError('管理库目标已固定，不能切换主机、端口或数据库。请使用新的 DSH profile 配置其他管理库。', 409);
        if (services) {
          if (savedConfig && ['user', 'password'].every(key => next[key] === savedConfig[key])) return status();
          throw publicError('管理库正在使用，不能在线更改账号或密码，请先重启插件。', 409);
        }
        let opened;
        try {
          opened = await initialize(next);
          await ctx.credentials.modifyRecord(recordKey, async () => ({ kind: 'grant', payload: next }));
        } catch {
          await closeServices(opened).catch(() => {});
          startupMessage = MANAGEMENT_ERROR;
          throw publicError(MANAGEMENT_ERROR, 503);
        }
        savedConfig = next;
        services = opened;
        startupMessage = undefined;
        return status();
      });
      tail = operation.catch(() => {});
      return operation;
    },
  };
  ctx.provide('datasourceCatalog', createDatasourceService(current));
  const templateRuntime = new DatasourceRuntime({ store: {}, secrets });
  for (const definition of templateRuntime.getTools()) {
    ctx.tools.register({ ...definition, execute: async (args, execution) => {
      const { runtime, flow } = current();
      const tool = runtime.getTools().find(item => item.name === definition.name);
      return flow.scopedSql(definition.name, args, execution, tool.execute);
    } });
  }
  const taskDefinition = DatasourceFlow.prototype.getTool.call({ task() {} });
  ctx.tools.register({ ...taskDefinition, execute: async (args, execution) => current().flow.getTool().execute(args, execution) });
  registerRoutes(ctx, current, undefined, management);
  ctx.on('dispose', async () => {
    closed = true;
    await tail;
    const previous = services;
    services = undefined;
    await closeServices(previous);
  });
}
