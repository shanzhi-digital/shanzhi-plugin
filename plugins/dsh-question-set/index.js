import { resolve } from 'node:path';
import { openSharedDb } from './credentials.js';
import { createQuestionStore } from './store.js';
import { createQueryService } from './query.js';
import { DatasourceSessionBridge, injectKeys } from './host-bridge.js';
import { AiTasks } from './ai-tasks.js';
import { QuestionFlow } from './flow.js';
import { createRoutes } from './routes.js';
import { createSettings } from './settings.js';

export const name = 'question-set';
export const inject = ['connection', 'tools', 'credentials', ...injectKeys];

export async function apply(ctx, config = {}) {
  const settings = createSettings({ profileDir: config.profileDir });
  // Database setup failures stay visible on this plugin's page; no dependency on the old plugin's activation.
  let services, initializing, closed = false;
  const initialize = () => {
    if (closed) throw Object.assign(new Error('问题集服务已关闭。'), { publicMessage: '问题集服务已关闭。' });
    return initializing ??= (async () => {
    const db = await openSharedDb(ctx);
    try {
      const store = createQuestionStore(db);
      const query = createQueryService({ db, credentials: ctx.credentials });
      const bridge = new DatasourceSessionBridge(ctx);
      const flow = new QuestionFlow({ store, query, bridge, cwd: resolve(config.workingDirectory || process.cwd()) });
      const tasks = new AiTasks({
        validate: input => flow.validate(input),
        identify: input => ({ sourceId: input.sourceId, kind: 'generalize' }),
        execute: (input, signal, report, taskId) => flow.run(input, signal, report, taskId),
      });
      services = { db, store, query, bridge, flow, tasks, settings };
      return services;
    } catch (error) { await db.close(); throw error; }
  })().catch(error => { initializing = null; throw error; });
  };
  // Routes need synchronous task admission. Initialize their services before invoking the matching handler.
  const routePaths = createRoutes({ store: {}, query: {}, flow: {}, tasks: {}, settings });
  for (const definition of routePaths) {
    if (definition.path === '/api/question-set/prompt-settings') {
      ctx.connection.fetch.register(definition);
      continue;
    }
    ctx.connection.fetch.register({ ...definition, async fetch(request) {
      try {
        const value = await initialize();
        return await createRoutes(value).find(route => route.path === definition.path).fetch(request);
      } catch (error) {
        return Response.json({ error: error.publicMessage || '问题集无法连接共享管理库，请先完成已有管理库配置。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
    } });
  }
  const tool = QuestionFlow.prototype.getTool.call({ task: async (input, execution) => (await initialize()).flow.task(input, execution) });
  ctx.tools.register(tool);
  ctx.on('dispose', async () => {
    closed = true;
    if (initializing) await initializing.catch(() => {});
    if (!services) return;
    await services.tasks.close();
    await services.flow.close();
    await services.query.close();
    await services.db.close();
  });
}
