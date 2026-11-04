import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatasourceRuntime } from './runtime.js';

export const name = 'sql';
export const inject = ['tools', 'connection', 'credentials'];
export const API_PREFIX = '/api/datasources';

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

export function registerRoutes(ctx, runtime) {
  const definitions = [
    ['list', 'GET', async () => ({ items: await runtime.list() })],
    ['save', 'POST', async (input) => ({ item: await runtime.save(input) })],
    ['test', 'POST', async (input) => await runtime.test(input)],
    ['remove', 'POST', async (input) => {
      if (typeof input.id !== 'string' || !input.id) throw Object.assign(new Error('请选择要删除的数据源。'), { publicMessage: '请选择要删除的数据源。' });
      await runtime.remove(input.id);
      return { ok: true };
    }],
  ];
  for (const [operation, method, handler] of definitions) {
    // DSH exact-fetch routes admit only the authenticated owner, and reject cross-site requests.
    ctx.connection.fetch.register({
      path: `${API_PREFIX}/${operation}`,
      methods: [method],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          let input = {};
          if (method === 'POST') {
            if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
              return json({ error: '请使用 JSON 提交连接信息。' }, 415);
            }
            const body = await request.text();
            if (body.length > 32768) return json({ error: '连接信息过长。' }, 413);
            try { input = JSON.parse(body); } catch { return json({ error: '连接信息格式无效。' }, 400); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: '连接信息格式无效。' }, 400);
          }
          if (request.signal.aborted) return json({ error: '请求已取消。' }, 408);
          return json(await handler(input));
        } catch (error) {
          // Runtime emits only validated UI errors; never return a stack, a connection config, or a driver error.
          return json({ error: error?.publicMessage || '操作失败，请检查连接信息后重试。' }, 400);
        }
      },
    });
  }
}

export async function apply(ctx, config = {}) {
  const profileDir = process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'desktop');
  const runtime = new DatasourceRuntime({
    filePath: config.storagePath || join(profileDir, 'datasources', 'connections.json'),
    secrets: createSecrets(ctx.credentials),
  });
  await runtime.initialize();
  for (const definition of runtime.getTools()) ctx.tools.register(definition);
  registerRoutes(ctx, runtime);
  ctx.on('dispose', () => runtime.close());
}
