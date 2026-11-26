import { resolve } from 'node:path';
import { openSharedDb } from './credentials.js';
import { createQuestionStore } from './store.js';
import { createQueryService } from './query.js';
import { DatasourceSessionBridge, injectKeys } from './host-bridge.js';
import { AiTasks } from './ai-tasks.js';
import { QuestionFlow } from './flow.js';
import { createRoutes } from './routes.js';
import { createSettings } from './settings.js';
import { InternalHttp } from './internal-http.js';

export const name = 'question-set';
export const inject = ['connection', 'tools', 'credentials', ...injectKeys];

async function createProductionServices(ctx, config) {
  const db = await openSharedDb(ctx);
  let query, bridge;
  try {
    const store = createQuestionStore(db);
    query = createQueryService({ db, credentials: ctx.credentials });
    bridge = new DatasourceSessionBridge(ctx);
    const flow = new QuestionFlow({ store, query, bridge, cwd: resolve(config.workingDirectory || process.cwd()) });
    const tasks = new AiTasks({
      validate: input => flow.validate(input),
      identify: input => ({ sourceId: input.sourceId, kind: input.kind ?? 'generalize' }),
      execute: (input, signal, report, taskId) => flow.run(input, signal, report, taskId),
    });
    return { db, store, query, flow, tasks };
  } catch (error) {
    try { await bridge?.close(); } finally { try { await query?.close(); } finally { await db.close(); } }
    throw error;
  }
}

export async function apply(ctx, config = {}) {
  return applyWithServices(ctx, config);
}

// Contract tests inject services; production owns one shared set for both transports.
export async function applyWithServices(ctx, config = {}, {
  createServices = createProductionServices,
  createTransport = options => new InternalHttp(options),
  settings = createSettings({ profileDir: config.profileDir }),
} = {}) {
  const http = createTransport(config.internalApi);
  let services, initializing, routes, closed = false;
  const disposers = [];
  const unavailable = () => Response.json({ error: '问题集服务已关闭。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const initialize = () => {
    if (closed) throw Object.assign(new Error('问题集服务已关闭。'), { publicMessage: '问题集服务已关闭。' });
    return initializing ??= Promise.resolve().then(() => createServices(ctx, config)).then(value => {
      services = value;
      routes = new Map(createRoutes({ ...value, settings }).map(route => [route.path, route]));
      return value;
    }).catch(error => { initializing = null; throw error; });
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    http.stopAccepting();
    try {
      if (initializing) await initializing.catch(() => {});
      if (services) {
        try { await services.tasks.close(); }
        finally {
          try { await services.flow.close(); }
          finally { try { await services.query.close(); } finally { await services.db.close(); } }
        }
      }
    } finally {
      try { for (const dispose of disposers.reverse()) dispose?.(); }
      finally { await http.close(); }
    }
  };
  try {
    const definitions = createRoutes({ store: {}, query: {}, flow: {}, tasks: {}, settings });
    for (const definition of definitions) {
      const route = { ...definition, async fetch(request) {
        if (closed) return unavailable();
        if (definition.path === '/api/question-set/prompt-settings') return definition.fetch(request);
        try {
          await initialize();
          if (closed) return unavailable();
          return await routes.get(definition.path).fetch(request);
        } catch (error) {
          return Response.json({ error: error.publicMessage || '问题集无法连接共享管理库，请先完成已有管理库配置。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
      } };
      disposers.push(ctx.connection.fetch.register(route));
      disposers.push(http.register(route));
    }
    const tool = QuestionFlow.prototype.getTool.call({ task: async (input, execution) => (await initialize()).flow.task(input, execution) });
    disposers.push(ctx.tools.register(tool));
    await http.listen();
    ctx.on('dispose', close);
  } catch (error) {
    await close();
    throw error;
  }
}
