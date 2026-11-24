import { resolve } from 'node:path';
import { DatasourceSessionBridge, injectKeys } from 'dsh-sql/host-bridge';
import { AiTasks } from 'dsh-sql/ai-tasks';
import { AnnotationFlow } from './flow.js';
import { registerRoutes } from './routes.js';

export { registerRoutes } from './routes.js';
export const name = 'data-annotation';
export const inject = ['connection', 'tools', 'datasourceCatalog', 'datasourceHttp', ...injectKeys];

export function apply(ctx, config = {}) {
  const service = ctx.datasourceCatalog;
  if (service?.version !== 1) throw new Error('请启用支持数据标注的配套数据源插件。');
  const flow = new AnnotationFlow({ service, bridge: new DatasourceSessionBridge(ctx), defaultCwd: resolve(config.workingDirectory || process.cwd()) });
  const tasks = new AiTasks({
    validate: input => flow.validate(input),
    identify: input => ({ sourceId: input.sourceId, kind: input.kind }),
    execute: (input, signal, report) => flow.run(input, signal, report),
  });
  ctx.tools.register(flow.getTool());
  const unregister = registerRoutes(ctx, service, tasks);
  ctx.on('dispose', async () => {
    unregister();
    await tasks.close();
    await flow.close();
  });
}
