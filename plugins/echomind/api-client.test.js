import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ApiError, bundledCaPem, createApiClient, normalizeMirrorUrl, normalizeServerUrl } from './api-client.js';

test('bundledCA is present and URL normalizers enforce protocol and strip trailing /v1', () => {
  assert.ok(bundledCaPem().includes('BEGIN CERTIFICATE'));
  assert.equal(normalizeServerUrl('https://58.87.77.127:8443/v1/'), 'https://58.87.77.127:8443');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.throws(() => normalizeServerUrl('ftp://example.com'), ApiError);
  assert.throws(() => normalizeServerUrl('https://user:pass@example.com'), ApiError);
  assert.equal(normalizeMirrorUrl('https://mirror.example.com/bin/'), 'https://mirror.example.com/bin');
});

test('api-client calls EchoMind endpoints, maps 401/429/500 errors, and passes through upstream DeepSeek replies', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: bodyText });

    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/v1/auth/feishu/config')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ appId: 'cli_test', scopes: ['offline_access'], company: { name: '测试公司', joinCode: 'TEST01' } }));
      return;
    }
    if (req.url === '/v1/me' && req.headers.authorization !== 'Bearer good-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: '登录已过期，请重新用飞书登录。' } }));
      return;
    }
    if (req.url === '/v1/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ openId: 'ou_1', name: '张三', admin: true, missingScopes: [] }));
      return;
    }
    if (req.url === '/v1/llm/chat') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'X-EchoMind-Upstream': 'deepseek' });
      res.end(JSON.stringify({ error: { message: 'upstream rate limit' } }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal', message: '数据库暂时不可用' } }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = createApiClient();

  try {
    const h = await client.health({ serverUrl: baseUrl });
    assert.equal(h.ok, true);

    const cfg = await client.getFeishuConfig({ serverUrl: baseUrl }, 'TEST01');
    assert.equal(cfg.appId, 'cli_test');

    await assert.rejects(
      () => client.getMe({ serverUrl: baseUrl, token: 'expired' }),
      (err) => err instanceof ApiError && err.code === 'UNAUTHORIZED' && err.status === 401,
    );

    const me = await client.getMe({ serverUrl: baseUrl, token: 'good-token' });
    assert.equal(me.admin, true);

    // Upstream DeepSeek 429 must be passed through without throwing, so minutes-engine can retry.
    const llm = await client.proxyLlmChat({ serverUrl: baseUrl, token: 'good-token' }, { messages: [] });
    assert.equal(llm.status, 429);
    assert.ok(llm.body.includes('upstream rate limit'));
  } finally {
    server.close();
  }
});
