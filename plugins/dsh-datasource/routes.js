export const API_PREFIX = '/api/datasources';
const publicError = (message, status = 400) => Object.assign(new Error(message), { publicMessage: message, status });
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export function createRoutes(runtimeOrGetter, flow, management, tasks) {
  const current = typeof runtimeOrGetter === 'function' ? runtimeOrGetter : () => ({ runtime: runtimeOrGetter, flow });
  const definitions = [
    ...(management ? [
      ['management-status', ['GET'], () => management.status(), true],
      ['management-save', ['POST'], input => management.save(input), true],
    ] : []),
    ['list', ['GET'], async () => ({ items: await current().runtime.list() })],
    ['save', ['POST'], async input => {
      const { runtime, flow } = current();
      const item = await runtime.save(input);
      if (input.id) await flow?.sourceChanged(item.id, item);
      return { item };
    }],
    ['test', ['POST'], input => current().runtime.test(input)],
    ['remove', ['POST'], async input => {
      if (typeof input.id !== 'string' || !input.id) throw publicError('请选择要删除的数据源。');
      const { runtime, flow } = current();
      await runtime.remove(input.id, input.revision);
      await flow?.sourceChanged(input.id, null);
      return { ok: true };
    }],
    ['source-status', ['POST'], async input => {
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
      ['questions-list', ['POST'], async input => ({ items: await current().store.listQuestions(input.id) })],
      ['questions-save', ['POST'], async input => ({ item: await current().store.saveQuestion(input) })],
      ['questions-remove', ['POST'], async input => { await current().store.removeQuestion(input.id, input.version); return { ok: true }; }],
      ['flow-state', ['POST'], async input => ({ state: await current().flow.get(input.id) })],
      ['flow-action', ['POST'], async (input, signal) => {
        if (['detect-domains', 'suggest', 'generalize-question'].includes(input.action)) throw publicError('AI 操作请使用 ai-tasks 接口。');
        return { state: await current().flow.action(input, signal) };
      }],
      ['flow-samples', ['POST'], (input, signal) => current().flow.sampleTable(input, signal)],
    ] : []),
    ...(tasks ? [
      ['ai-tasks', ['GET', 'POST'], (input, _signal, request) => {
        if (request.method === 'POST') return { task: tasks.start(input) };
        const query = new URL(request.url).searchParams;
        if (query.size !== 1 || query.has('taskId') === query.has('sourceId')) throw publicError('请指定 taskId 或 sourceId 中的一个。');
        const key = query.has('taskId') ? 'taskId' : 'sourceId';
        const value = query.get(key);
        if (!value?.trim() || value.length > 128) throw publicError('任务查询参数格式无效。');
        return { task: key === 'taskId' ? tasks.get(value) : tasks.latest(value) };
      }],
      ['ai-tasks/cancel', ['POST'], input => {
        if (typeof input.taskId !== 'string' || !input.taskId.trim() || input.taskId.length > 128 || Object.keys(input).some(key => key !== 'taskId')) throw publicError('请指定有效的任务标识。');
        return { task: tasks.cancel(input.taskId) };
      }],
    ] : []),
  ];
  return definitions.map(([operation, methods, handler, managementOnly = false]) => {
    const maxBodyBytes = operation.startsWith('flow-') || operation === 'ai-tasks' ? 1048576 : 32768;
    return { managementOnly, route: {
      path: `${API_PREFIX}/${operation}`, methods, requestBody: 'buffered', maxBodyBytes,
      async fetch(request) {
        try {
          if (!methods.includes(request.method)) return json({ error: '请求方法不受支持。' }, 405);
          let input = {};
          if (request.method === 'POST') {
            if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return json({ error: '请使用 JSON 提交连接信息。' }, 415);
            const body = await request.text();
            if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) return json({ error: '提交信息过长。' }, 413);
            try { input = JSON.parse(body); } catch { return json({ error: '连接信息格式无效。' }, 400); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: '连接信息格式无效。' }, 400);
          }
          if (request.signal.aborted) return json({ error: '请求已取消。' }, 408);
          return json(await handler(input, request.signal, request), operation === 'ai-tasks' && request.method === 'POST' ? 202 : 200);
        } catch (error) {
          const status = [400, 404, 409, 413, 503].includes(error?.status) ? error.status : 400;
          return json({ error: error?.publicMessage || '操作失败，请检查连接信息后重试。', ...(typeof error?.sessionId === 'string' ? { sessionId: error.sessionId } : {}), ...(typeof error?.taskId === 'string' ? { taskId: error.taskId } : {}) }, status);
        }
      },
    } };
  });
}

export function registerRoutes(ctx, runtimeOrGetter, flow, management, tasks, internalHttp = ctx.datasourceHttp) {
  const unregister = [];
  for (const { route, managementOnly } of createRoutes(runtimeOrGetter, flow, management, tasks)) {
    ctx.connection.fetch.register(route);
    if (!managementOnly && internalHttp) unregister.push(internalHttp.register(route));
  }
  return () => { for (const remove of unregister) remove(); };
}
