import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatasourceRuntime } from './runtime.js';
import { DatasourceFlow, validateAiInput } from './flow.js';
import { DatasourceAiExecutor } from './ai-executor.js';
import { AiTasks } from './ai-tasks.js';
import { InternalHttp } from './internal-http.js';
import { registerRoutes } from './routes.js';
import { DatasourceSessionBridge, injectKeys } from './host-bridge.js';
import { createAnnotationStore } from './annotation-store.js';
import { createDatasourceService } from './service.js';

export { API_PREFIX, registerRoutes } from './routes.js';
export const name = 'sql';
export const inject = ['tools', 'connection', 'credentials', ...injectKeys];
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
  const internalHttp = new InternalHttp(config.internalApi);
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
  const tasks = new AiTasks({
    validate: validateAiInput,
    identify: input => ({ sourceId: input.id.trim(), kind: input.action }),
    execute: async (input, signal, report) => {
      const state = await current().flow.ai(input, signal, report);
      return { revision: state.revision, ...(input.action === 'suggest' && state.draft ? { draftId: state.draft.id } : {}), ...(input.action === 'generalize-question' && state.questionDraft ? { questionDraftId: state.questionDraft.id } : {}) };
    },
  });
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
  let unregister = () => {};
  const close = async () => {
    if (closed) return;
    closed = true;
    internalHttp.stopAccepting();
    await tasks.close();
    await tail;
    const previous = services;
    services = undefined;
    try { await closeServices(previous); }
    finally { unregister(); await internalHttp.close(); }
  };
  try {
    ctx.provide('datasourceCatalog', createDatasourceService(current));
    ctx.provide('datasourceHttp', internalHttp);
    const templateRuntime = new DatasourceRuntime({ store: {}, secrets });
    for (const definition of templateRuntime.getTools()) {
      ctx.tools.register({ ...definition, execute: async (args, execution) => {
        const { runtime, flow } = current();
        const tool = runtime.getTools().find(item => item.name === definition.name);
        return flow.scopedSql(definition.name, args, execution, tool.execute);
      } });
    }
    const taskDefinition = DatasourceAiExecutor.prototype.getTool.call({ task() {} });
    ctx.tools.register({ ...taskDefinition, execute: async (args, execution) => current().flow.executor.getTool().execute(args, execution) });
    unregister = registerRoutes(ctx, current, undefined, management, tasks, internalHttp);
    await internalHttp.listen();
    ctx.on('dispose', close);
  } catch (cause) {
    await close();
    throw cause;
  }
}
