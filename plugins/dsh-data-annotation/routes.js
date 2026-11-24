const PREFIX = '/api/data-annotation';
const MAX_BODY_BYTES = 1048576;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };

export function createRoutes(service, tasks) {
  const definitions = [
    ['sources', 'GET', () => service.list()],
    ['catalog', 'POST', input => service.catalog(input.sourceId)],
    ['action', 'POST', input => service.action(input)],
    ['ai-tasks', 'POST', input => ({ task: tasks.start(input) }), 202],
    ['ai-tasks', 'GET', (_input, request) => {
      const params = new URL(request.url).searchParams;
      const taskId = params.get('taskId'), sourceId = params.get('sourceId');
      if (params.has('taskId') === params.has('sourceId') || (params.has('taskId') && !taskId?.trim()) || (params.has('sourceId') && !sourceId?.trim())) invalid('请选择 taskId 或 sourceId 查询任务。');
      const task = taskId ? tasks.get(taskId) : tasks.latest(sourceId);
      if (taskId && !task) throw Object.assign(new Error('标注任务不存在或已清理。'), { status: 404 });
      return { task };
    }],
    ['ai-tasks/cancel', 'POST', input => {
      if (typeof input.taskId !== 'string' || !input.taskId.trim()) invalid('缺少标注任务 ID。');
      const task = tasks.cancel(input.taskId);
      if (!task) throw Object.assign(new Error('标注任务不存在或已清理。'), { status: 404 });
      return { task };
    }],
  ];
  // GET and POST share an exact pathname in both transports.
  const routes = new Map();
  for (const [path, method, handler, successStatus = 200] of definitions) {
    const fullPath = `${PREFIX}/${path}`;
    let route = routes.get(fullPath);
    if (!route) {
      const handlers = new Map();
      route = {
        path: fullPath, methods: [], requestBody: 'buffered', maxBodyBytes: MAX_BODY_BYTES,
        async fetch(request) {
          const headers = { 'Cache-Control': 'no-store' };
          try {
            const entry = handlers.get(request.method);
            if (!entry) return Response.json({ error: '请求方法不支持。' }, { status: 405, headers: { ...headers, Allow: route.methods.join(', ') } });
            let input = {};
            if (request.method === 'POST') {
              if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') invalid('请使用 JSON 提交标注操作。');
              const body = await request.text();
              if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw Object.assign(new Error('标注内容过长。'), { status: 413 });
              try { input = JSON.parse(body); } catch { invalid('标注操作格式无效。'); }
              if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('标注操作格式无效。');
            }
            request.signal?.throwIfAborted();
            return Response.json(await entry.handler(input, request), { status: entry.status, headers });
          } catch (error) {
            const status = [400, 404, 409, 413, 503].includes(error?.status) ? error.status : 400;
            return Response.json({ error: error?.publicMessage || (error?.status ? error.message : '标注操作失败，请刷新后重试。'), ...(typeof error?.taskId === 'string' ? { taskId: error.taskId } : {}) }, { status, headers });
          }
        },
        handlers,
      };
      routes.set(fullPath, route);
    }
    route.methods.push(method);
    route.handlers.set(method, { handler, status: successStatus });
  }
  return [...routes.values()].map(({ handlers, ...route }) => route);
}

export function registerRoutes(ctx, service, tasks) {
  const disposers = [];
  for (const route of createRoutes(service, tasks)) {
    disposers.push(ctx.connection.fetch.register(route));
    disposers.push(ctx.datasourceHttp.register(route));
  }
  return () => { for (const dispose of disposers.reverse()) dispose?.(); };
}
