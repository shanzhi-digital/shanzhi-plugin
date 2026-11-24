import { createServer } from 'node:http';

const json = (res, status, error) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
};

/** Optional loopback transport for the very same Fetch route definitions. */
export class InternalHttp {
  constructor({ enabled = false, port = 17861 } = {}) {
    if (typeof enabled !== 'boolean' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('内部接口启用标记或端口无效。');
    this.enabled = enabled;
    this.port = port;
    this.routes = new Map();
    this.server = null;
    this.accepting = false;
    this.controllers = new Set();
  }

  register(route) {
    if (this.routes.has(route.path)) throw new Error(`内部接口路径重复：${route.path}`);
    this.routes.set(route.path, route);
    return () => { if (this.routes.get(route.path) === route) this.routes.delete(route.path); };
  }

  async listen() {
    if (!this.enabled || this.server) return;
    const server = createServer((req, res) => { void this._handle(req, res); });
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      this.port = server.address().port;
      this.accepting = true;
    } catch (cause) { this.server = null; throw cause; }
  }

  async _handle(req, res) {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    this.controllers.add(controller);
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      if (!this.accepting) return json(res, 503, '内部接口已关闭。');
      const host = req.headers.host;
      if (req.headers.origin !== undefined || ![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(host)) return json(res, 403, '内部接口仅接受本机后端请求。');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) return json(res, 400, '请求地址无效。');
      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const route = this.routes.get(url.pathname);
      if (!route) return json(res, 404, '接口不存在。');
      if (!route.methods.includes(req.method)) { res.setHeader('Allow', route.methods.join(', ')); return json(res, 405, '请求方法不支持。'); }
      const maxBodyBytes = route.maxBodyBytes ?? 1048576;
      if (Number(req.headers['content-length']) > maxBodyBytes) return json(res, 413, '提交信息过长。');
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > maxBodyBytes) { json(res, 413, '提交信息过长。'); return; }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(url, { method: req.method, headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(req.method) && length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await route.fetch(request);
      if (res.destroyed) return;
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(body);
    } catch {
      if (!res.destroyed && !res.headersSent) json(res, 500, '内部接口处理失败。');
      else if (!res.destroyed) res.end();
    } finally {
      this.controllers.delete(controller);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  }

  stopAccepting() { this.accepting = false; }

  async close() {
    this.stopAccepting();
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const controller of this.controllers) controller.abort();
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}
