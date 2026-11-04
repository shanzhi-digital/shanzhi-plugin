import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatasourceStore } from './store.js';
import { createAdapter } from './vendor/adapters.js';
import { assertReadQuery, buildSqlTools } from './vendor/tools.js';

const TOOL_NAMES = ['sql_list', 'sql_query', 'sql_schema'];
const EMPTY_MESSAGE = '尚未配置数据源，请先在数据源页面添加数据库连接。';
const CONNECTION_ERROR = '连接失败，请检查连接配置、凭据和数据库服务。';
const CONFIG = Object.freeze({ readOnly: true, writeApproval: true, maxRows: 1000, queryTimeoutMs: 60000, execTimeoutMs: 60000 });

class PublicError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatasourceError';
    this.publicMessage = message;
  }
}
function fail(message) { throw new PublicError(message); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value, label, { optional = false, max = 256 } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail(label + '格式无效。');
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(label + '不能为空或超出长度限制。');
  return result;
}
function normalize(input, previous) {
  const merged = { ...previous, ...input };
  const id = previous?.id ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('数据源 ID 无效。');
  const name = text(merged.name, '连接名称', { max: 128 });
  const description = text(merged.description, '描述', { optional: true, max: 1000 });
  const engine = merged.engine;
  if (!['sqlite', 'mysql', 'postgres'].includes(engine)) fail('数据库类型必须是 MySQL、PostgreSQL 或 SQLite。');
  const result = { id, name, description, engine, host: '', port: null, user: '', database: '', file: '' };
  if (engine === 'sqlite') {
    const file = text(merged.file, 'SQLite 文件路径', { max: 4096 });
    if (file === ':memory:' || /^file:/i.test(file) || /:\/\//.test(file)) fail('请选择实际的 SQLite 数据库文件，不支持内存库或连接 URI。');
    result.file = resolve(file);
  } else {
    result.host = text(merged.host ?? 'localhost', '主机地址');
    if (/[\s/@\\?#]/.test(result.host) || result.host.includes('://')) fail('主机地址应填写主机名或 IP，不接受连接字符串。');
    const suppliedPort = merged.port === undefined || merged.port === null || merged.port === '' ? (engine === 'mysql' ? 3306 : 5432) : merged.port;
    const port = typeof suppliedPort === 'string' && /^\d+$/.test(suppliedPort) ? Number(suppliedPort) : suppliedPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('端口必须是 1 到 65535 的整数。');
    result.port = port;
    result.user = text(merged.user, '数据库账号');
    result.database = text(merged.database, '数据库名称');
  }
  return result;
}
function publicRecord(connection, password) {
  return { ...connection, hasPassword: connection.engine !== 'sqlite' && typeof password === 'string' && password !== '' };
}
function publicMessage(error, fallback) { return error instanceof PublicError ? error.message : fallback; }
function executionSignal(execution) { return execution?.signal instanceof AbortSignal ? execution.signal : undefined; }

/** Host-independent backend. The Host owns the security of the supplied secret store. */
export class DatasourceRuntime {
  #store;
  #secrets;
  #initialization;
  #tail = Promise.resolve();
  #current;
  #generations = new Set();
  #tests = new Set();
  #closed = false;
  #closePromise;
  #tools;

  constructor({ filePath, secrets }) {
    if (!secrets || !['get', 'set', 'delete'].every((method) => typeof secrets[method] === 'function')) {
      throw new Error('需要提供安全密码存储服务。');
    }
    this.#store = new DatasourceStore(filePath);
    this.#secrets = secrets;
    const templates = buildSqlTools({ ...CONFIG, connections: [] }).tools;
    this.#tools = TOOL_NAMES.map((name) => {
      const original = templates.find((tool) => tool.name === name);
      const tool = { ...original, timeoutMs: CONFIG.queryTimeoutMs, execute: (args, execution) => this.#execute(name, args, execution) };
      if (name === 'sql_query') tool.description = '执行单条只读 SQL 查询（SELECT / PRAGMA / EXPLAIN / SHOW / DESCRIBE / WITH）。复用按数据库引擎区分的词法校验，拒绝写入、多语句、SELECT INTO、行锁和修改 PRAGMA。MySQL/PostgreSQL 使用只读事务。connection 为连接名，缺省使用首个连接。返回真实 columns/rows，最多 1000 行，超出时 truncated=true。此插件不提供写入工具。';
      if (name === 'sql_list') {
        tool.description = '列出已配置的数据源并逐一测试连通性；没有连接时提示先在数据源页面添加。返回连接名、数据库类型、目标和连接状态，不返回密码。';
        tool.output = { ...original.output, render: (args, value) => value?.connections?.length === 0 ? [{ type: 'text', text: value.message ?? EMPTY_MESSAGE }] : original.output.render(args, value) };
      }
      return tool;
    });
  }

  initialize() {
    if (!this.#initialization) {
      this.#initialization = (async () => {
        try {
          await this.#store.initialize();
          const names = new Set();
          const ids = new Set();
          for (const item of this.#store.list()) {
            if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)) throw new Error();
            const canonical = normalize(item, item);
            if (names.has(canonical.name.toLowerCase()) || ids.has(canonical.id)) throw new Error();
            names.add(canonical.name.toLowerCase());
            ids.add(canonical.id);
          }
        } catch {
          fail('无法读取有效的数据源配置，请检查配置文件；原文件未修改。');
        }
      })();
    }
    return this.#initialization;
  }

  #serial(work) {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #ready() {
    await this.initialize();
    if (this.#closed) fail('数据源服务已关闭。');
  }
  #key(id) { return 'dsh-datasource:' + id + ':password'; }
  async #getPassword(id) {
    try {
      const value = await this.#secrets.get(this.#key(id));
      if (value !== undefined && value !== null && typeof value !== 'string') throw new Error();
      return value || undefined;
    } catch { fail('无法读取数据库密码，请检查安全凭据服务。'); }
  }
  async #putPassword(id, password) {
    try {
      if (password === undefined) await this.#secrets.delete(this.#key(id));
      else await this.#secrets.set(this.#key(id), password);
    } catch { fail('无法更新数据库密码，请检查安全凭据服务。'); }
  }
  #lookup(records, id) {
    const found = records.find((item) => item.id === id);
    if (!found) fail('未找到对应的数据源，请刷新数据源列表。');
    return found;
  }
  async #passwordFor(input, connection, existingPassword) {
    if (connection.engine === 'sqlite' || input.clearPassword === true) return undefined;
    if (input.password !== undefined && typeof input.password !== 'string') fail('密码格式无效。');
    // Do not trim passwords; spaces can be part of a legitimate credential.
    return typeof input.password === 'string' && input.password !== '' ? input.password : existingPassword;
  }

  async list() {
    await this.#ready();
    return this.#serial(async () => {
      await this.#ready();
      const result = [];
      for (const item of this.#store.list()) result.push(publicRecord(item, await this.#getPassword(item.id)));
      return result;
    });
  }

  async save(value) {
    await this.#ready();
    return this.#serial(async () => {
      await this.#ready();
      const input = record(value);
      const records = this.#store.list();
      const previous = input.id ? this.#lookup(records, input.id) : undefined;
      const connection = normalize(input, previous);
      if (records.some((item) => item.id !== connection.id && item.name.toLowerCase() === connection.name.toLowerCase())) fail('连接名称已存在，请使用其他名称。');
      const oldPassword = previous ? await this.#getPassword(previous.id) : undefined;
      const password = await this.#passwordFor(input, connection, oldPassword);
      const changedPassword = password !== oldPassword;
      if (changedPassword) await this.#putPassword(connection.id, password);
      const next = previous ? records.map((item) => item.id === previous.id ? connection : item) : [...records, connection];
      try {
        await this.#store.replace(next);
      } catch {
        if (changedPassword) {
          try { await this.#putPassword(connection.id, oldPassword); }
          catch { fail('保存配置失败且密码恢复未完成，请检查安全凭据服务并重新保存连接。'); }
        }
        fail('无法保存数据源配置，原连接配置保持不变。');
      }
      this.#invalidate();
      return publicRecord(connection, password);
    });
  }

  async remove(id) {
    await this.#ready();
    return this.#serial(async () => {
      await this.#ready();
      const records = this.#store.list();
      const connection = this.#lookup(records, id);
      const password = await this.#getPassword(id);
      if (password !== undefined) await this.#putPassword(id, undefined);
      try { await this.#store.replace(records.filter((item) => item.id !== id)); }
      catch {
        if (password !== undefined) {
          try { await this.#putPassword(id, password); }
          catch { fail('删除配置失败且密码恢复未完成，请检查安全凭据服务。'); }
        }
        fail('无法删除数据源配置，原连接配置保持不变。');
      }
      this.#invalidate();
      return { id: connection.id, removed: true };
    });
  }

  async test(inputOrId) {
    try {
      await this.#ready();
      const { operation } = await this.#serial(async () => {
        await this.#ready();
        const records = this.#store.list();
        const input = typeof inputOrId === 'string' ? { id: inputOrId } : record(inputOrId);
        const previous = input.id ? this.#lookup(records, input.id) : undefined;
        const connection = normalize(input, previous);
        const storedPassword = previous ? await this.#getPassword(previous.id) : undefined;
        const password = await this.#passwordFor(input, connection, storedPassword);
        const operation = this.#testConnection({ ...connection, password });
        this.#tests.add(operation);
        void operation.finally(() => this.#tests.delete(operation));
        return { operation };
      });
      return await operation;
    } catch (error) {
      return { ok: false, message: publicMessage(error, CONNECTION_ERROR) };
    }
  }
  async #testConnection(connection) {
    let adapter;
    try {
      adapter = createAdapter(connection, { readOnly: true });
      await adapter.ping(AbortSignal.timeout(CONFIG.queryTimeoutMs));
      return { ok: true, message: '连接成功。' };
    } catch { return { ok: false, message: CONNECTION_ERROR }; }
    finally {
      if (adapter) await adapter.close().catch(() => {});
      delete connection.password;
    }
  }

  getTools() { return this.#tools; }

  async #acquire() {
    return this.#serial(async () => {
      await this.#ready();
      if (!this.#current) {
        const connections = [];
        for (const item of this.#store.list()) connections.push({ ...item, password: await this.#getPassword(item.id) });
        const config = { ...CONFIG, connections };
        let resolveDone;
        const done = new Promise((resolvePromise) => { resolveDone = resolvePromise; });
        const generation = { config, built: buildSqlTools(config), users: 0, retired: false, disposing: false, done, resolveDone };
        this.#current = generation;
        this.#generations.add(generation);
      }
      this.#current.users += 1;
      return this.#current;
    });
  }
  #invalidate() {
    const previous = this.#current;
    this.#current = undefined;
    if (previous) {
      previous.retired = true;
      this.#disposeWhenIdle(previous);
    }
  }
  #disposeWhenIdle(generation) {
    if (!generation.retired || generation.users !== 0 || generation.disposing) return;
    generation.disposing = true;
    void Promise.allSettled([...generation.built.adapters.values()].map((adapter) => Promise.resolve().then(() => adapter.close()))).then(() => {
      generation.built.adapters.clear();
      for (const connection of generation.config.connections) delete connection.password;
      this.#generations.delete(generation);
      generation.resolveDone();
    });
  }

  async #execute(name, rawArgs, execution) {
    let generation;
    let signal;
    try {
      await this.#ready();
      generation = await this.#acquire();
      const args = record(rawArgs);
      const connections = generation.config.connections;
      if (connections.length === 0) {
        if (name === 'sql_list') return { connections: [], message: EMPTY_MESSAGE };
        fail(EMPTY_MESSAGE);
      }
      const requested = typeof args.connection === 'string' && args.connection.trim() ? args.connection.trim().toLowerCase() : undefined;
      const target = requested ? connections.find((item) => item.name.toLowerCase() === requested) : connections[0];
      if (name !== 'sql_list' && !target) fail('未找到对应的数据库连接，请使用 sql_list 查看可用连接。');
      if (name === 'sql_query') {
        if (typeof args.sql !== 'string' || !args.sql.trim()) fail('请提供非空的只读 SQL 语句。');
        try { assertReadQuery(args.sql, target.engine); }
        catch { fail('只允许执行单条只读 SQL 查询；不支持写入、多条语句、行锁或修改 PRAGMA。'); }
      }
      const incoming = executionSignal(execution);
      signal = incoming ? AbortSignal.any([incoming, AbortSignal.timeout(CONFIG.queryTimeoutMs)]) : AbortSignal.timeout(CONFIG.queryTimeoutMs);
      signal.throwIfAborted();
      const tool = generation.built.tools.find((item) => item.name === name);
      return await tool.execute(args, { signal });
    } catch (error) {
      if (signal?.aborted) fail('数据库操作已取消或超过 60 秒，请检查连接后重试。');
      fail(publicMessage(error, name === 'sql_query' ? '查询失败，请检查数据库连接、SQL 语句和只读权限。' : CONNECTION_ERROR));
    } finally {
      if (generation) {
        generation.users -= 1;
        this.#disposeWhenIdle(generation);
      }
    }
  }

  close() {
    if (!this.#closePromise) {
      this.#closePromise = this.#serial(async () => {
        this.#closed = true;
        this.#invalidate();
        return { pending: [...this.#generations].map((generation) => generation.done).concat([...this.#tests]) };
      }).then(({ pending }) => Promise.allSettled(pending)).then(() => undefined);
    }
    return this.#closePromise;
  }
}
