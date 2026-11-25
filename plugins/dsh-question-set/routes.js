const fail = (message, status = 400) => { throw Object.assign(new Error(message), { publicMessage: message, status }); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export function createRoutes({ store, query, flow, tasks }) {
  const cleanDrafts = () => { tasks._prune(); flow.prune(tasks.tasks.keys()); };
  const view = task => task ? { ...task, resultState: flow.drafts.get(task.taskId)?.state ?? 'ready' } : null;
  const definitions = [
    ['questions', ['GET'], () => store.list().then(items => ({ items }))],
    ['sources', ['GET'], () => query.sources().then(items => ({ items }))],
    ['save', ['POST'], input => store.save(input).then(item => ({ item }))],
    ['remove', ['POST'], async input => { await store.remove(input); return { ok: true }; }],
    ['ai-tasks', ['GET', 'POST'], (input, request) => {
      cleanDrafts();
      if (request.method === 'GET') {
        const params = new URL(request.url).searchParams;
        if (params.size !== 1 || params.has('taskId') === params.has('sourceId')) fail('请指定 taskId 或 sourceId。');
        const key = params.has('taskId') ? 'taskId' : 'sourceId';
        const value = params.get(key);
        if (!value || value.length > 128) fail('任务标识无效。');
        return { task: view(key === 'taskId' ? tasks.get(value) : tasks.latest(value)) };
      }
      let values;
      if (input.retryFailed === true) {
        if (Object.keys(input).some(key => !['taskId', 'retryFailed'].includes(key))) fail('重试参数无效。');
        const task = tasks.get(input.taskId);
        if (task.status !== 'succeeded') fail('请等待任务处理结束。', 409);
        values = flow.retry(input.taskId);
      } else {
        if (Object.keys(input).some(key => !['sourceId', 'questions'].includes(key))) fail('泛化参数无效。');
        values = input;
      }
      const task = tasks.start(values);
      if (values.previousTaskId) flow.retire(values.previousTaskId);
      return { task };
    }],
    ['ai-tasks/cancel', ['POST'], input => ({ task: tasks.cancel(input.taskId) })],
    ['results-save', ['POST'], input => { cleanDrafts(); if (tasks.get(input.taskId).status !== 'succeeded') fail('请等待任务结束。', 409); return flow.save(input); }],
    ['results-discard', ['POST'], input => { cleanDrafts(); if (['running', 'cancelling'].includes(tasks.get(input.taskId).status)) fail('请等待任务结束。', 409); return flow.discard(input.taskId); }],
  ];
  return definitions.map(([path, methods, handler]) => ({
    path: `/api/question-set/${path}`, methods, requestBody: 'buffered', maxBodyBytes: 1048576,
    async fetch(request) {
      try {
        if (!methods.includes(request.method)) return json({ error: '请求方法不支持。' }, 405);
        let input = {};
        if (request.method === 'POST') {
          if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: '请使用JSON提交。' }, 415);
          const body = await request.text();
          if (Buffer.byteLength(body) > 1048576) return json({ error: '提交内容过长。' }, 413);
          try { input = JSON.parse(body); } catch { fail('JSON格式无效。'); }
          if (!input || typeof input !== 'object' || Array.isArray(input)) fail('请求格式无效。');
        }
        request.signal.throwIfAborted();
        return json(await handler(input, request), path === 'ai-tasks' && request.method === 'POST' ? 202 : 200);
      } catch (error) {
        return json({ error: error.publicMessage || '操作失败，请检查问题集配置或重试。', ...(typeof error.taskId === 'string' ? { taskId: error.taskId } : {}) }, [400, 404, 409, 413, 503].includes(error.status) ? error.status : 400);
      }
    },
  }));
}

export function registerRoutes(ctx, services) {
  for (const route of createRoutes(services)) ctx.connection.fetch.register(route);
}
