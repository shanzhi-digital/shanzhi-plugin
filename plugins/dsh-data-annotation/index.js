import { resolve } from 'node:path';
import { DatasourceSessionBridge, injectKeys } from 'dsh-sql/host-bridge';
import { AnnotationFlow } from './flow.js';

export const name = 'data-annotation';
export const inject = ['connection', 'tools', 'datasourceCatalog', ...injectKeys];
const PREFIX = '/api/data-annotation';

export function registerRoutes(ctx, service, flow) {
  const routes = [
    ['sources', 'GET', () => service.list()],
    ['catalog', 'POST', input => service.catalog(input.sourceId)],
    ['action', 'POST', input => service.action(input)],
    ['ai', 'POST', (input, signal) => flow.run(input, signal)],
  ];
  for (const [path, method, handler] of routes) ctx.connection.fetch.register({
    path: `${PREFIX}/${path}`, methods: [method], requestBody: 'buffered',
    async fetch(request) {
      try {
        let input = {};
        if (method === 'POST') {
          if (request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'application/json') throw Object.assign(new Error('请使用 JSON 提交标注操作。'), { status: 400 });
          const body = await request.text();
          if (Buffer.byteLength(body) > 1048576) throw Object.assign(new Error('标注内容过长。'), { status: 413 });
          try { input = JSON.parse(body); } catch { throw Object.assign(new Error('标注操作格式无效。'), { status: 400 }); }
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('标注操作格式无效。'), { status: 400 });
        }
        request.signal?.throwIfAborted();
        return Response.json(await handler(input, request.signal), { headers: { 'Cache-Control': 'no-store' } });
      } catch (error) {
        const status = [400, 404, 409, 413, 503].includes(error?.status) ? error.status : 400;
        return Response.json({ error: error?.publicMessage || (error?.status ? error.message : '标注操作失败，请刷新后重试。') }, { status, headers: { 'Cache-Control': 'no-store' } });
      }
    },
  });
}

export function apply(ctx, config = {}) {
  const service = ctx.datasourceCatalog;
  if (service?.version !== 1) throw new Error('请启用支持数据标注的配套数据源插件。');
  const flow = new AnnotationFlow({ service, bridge: new DatasourceSessionBridge(ctx), defaultCwd: resolve(config.workingDirectory || process.cwd()) });
  ctx.tools.register(flow.getTool());
  registerRoutes(ctx, service, flow);
  ctx.on('dispose', () => flow.close());
}
