import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatasourceStore } from './store.js';
import { createAdapter, sampleCatalogTable, scanSourceCatalog, detectTableFreshness } from './vendor/adapters.js';
import { buildSqlTools } from './vendor/tools.js';
import { authorizeQuery } from './sql-policy.js';
import { sourceTarget } from './flow-store.js';

const TOOL_NAMES = ['sql_list', 'sql_query', 'sql_schema'];
const QUERY_MS = 60000;
function fail(message, status = 400) { throw Object.assign(new Error(message), { publicMessage: message, status }); }
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function text(value, label, { optional = false, max = 256 } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label}格式无效。`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(`${label}不能为空或超出长度限制。`);
  return result;
}
function normalize(input, previous) {
  const merged = { ...previous, ...input }, id = previous?.id ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('数据源 ID 无效。');
  const result = { id, name: text(merged.name, '数据源名称', { max: 128 }), description: text(merged.description, '描述', { optional: true, max: 1000 }), engine: merged.engine, host: '', port: null, user: '', database: '', file: '' };
  if (!['sqlite', 'mysql', 'postgres'].includes(result.engine)) fail('数据库类型必须是 MySQL、PostgreSQL 或 SQLite。');
  if (result.engine === 'sqlite') {
    const file = text(merged.file, 'SQLite 文件路径', { max: 4096 });
    if (file === ':memory:' || /^file:/i.test(file) || /:\/\//.test(file)) fail('请选择实际的 SQLite 数据库文件，不支持内存库或连接 URI。');
    result.file = resolve(file);
  } else {
    result.host = text(merged.host ?? 'localhost', '主机地址');
    if (/[\s/@\\?#]/.test(result.host) || result.host.includes('://')) fail('主机地址应填写主机名或 IP。');
    result.port = Number(merged.port || (result.engine === 'mysql' ? 3306 : 5432));
    if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) fail('端口必须是 1 到 65535 的整数。');
    result.user = text(merged.user, '数据库账号'); result.database = text(merged.database, '数据库名称');
  }
  return result;
}
function safeSource(source, password) {
  const { credentialRef, password: ignored, ...value } = source;
  return { ...value, hasPassword: source.engine !== 'sqlite' && typeof password === 'string' && password !== '' };
}
const canonicalHost = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase()) ? 'loopback' : String(host).toLowerCase().replace(/\.$/, '');
export function sameDatabase(a, b) {
  return !!a && !!b && (a.engine ?? 'mysql') === (b.engine ?? 'mysql') && canonicalHost(a.host) === canonicalHost(b.host) && Number(a.port || 3306) === Number(b.port || 3306) && String(a.database).toLowerCase() === String(b.database).toLowerCase();
}
const targetIdentity = sourceTarget;

/** Business connections are always read-only; the management connection never enters this runtime. */
export class DatasourceRuntime {
  #store; #secrets; #management; #factory; #tools; #initialization; #closed = false;
  #tail = Promise.resolve(); #active = new Map();
  constructor({ store, secrets, managementConfig, adapterFactory = createAdapter } = {}) {
    if (!secrets || !['get', 'set', 'delete'].every(key => typeof secrets[key] === 'function')) throw new Error('需要提供安全密码存储服务。');
    this.#store = store ?? new DatasourceStore(); this.#secrets = secrets; this.#management = managementConfig; this.#factory = adapterFactory;
    const templates = buildSqlTools({ readOnly: true, writeApproval: true, connections: [], maxRows: 1000, queryTimeoutMs: QUERY_MS, execTimeoutMs: QUERY_MS }).tools;
    this.#tools = TOOL_NAMES.map(name => ({ ...templates.find(tool => tool.name === name), timeoutMs: QUERY_MS, execute: (args, execution) => this.#execute(name, record(args), execution) }));
    this.#tools.find(t => t.name === 'sql_list').description = '列出当前已启用的数据源并测试连接，不返回凭据。';
    this.#tools.find(t => t.name === 'sql_schema').description = '查看当前数据源已启用表的原始字段信息。connection 为连接名，table 可选。';
    this.#tools.find(t => t.name === 'sql_query').description = '查询已启用源内已启用的普通表。仅支持经解析验证的 SELECT/WITH、JOIN、子查询及常见内置聚合，禁止写入、跨库、未知函数和其他副作用。最多1000行。查看结构请使用 sql_schema。';
  }
  initialize() {
    return this.#initialization ??= (async () => {
      await this.#store.initialize?.();
      for (const source of await this.#store.listSources()) this.#assertBusiness(normalize(source, source));
    })();
  }
  async #ready() { await this.initialize(); if (this.#closed) fail('数据源服务已关闭。', 503); }
  #serial(work) { const result = this.#tail.then(work); this.#tail = result.catch(() => {}); return result; }
  #assertBusiness(source) { if (sameDatabase(source, this.#management)) fail('业务数据源不能指向插件管理库。'); }
  #key(id) { return 'dsh-datasource:' + id + ':password'; }
  async #password(source) { try { return await this.#secrets.get(this.#key(source.credentialRef ?? source.id)); } catch { fail('无法读取数据库凭据。'); } }
  async #put(id, password) { try { if (password === undefined) await this.#secrets.delete(this.#key(id)); else await this.#secrets.set(this.#key(id), password); } catch { fail('无法更新数据库凭据，请检查安全凭据服务。'); } }
  async #lookup(id) {
    const source = this.#store.getSource ? await this.#store.getSource(id) : (await this.#store.listSources()).find(s => s.id === id);
    if (!source) fail('未找到该数据源。', 404);
    this.#assertBusiness(source); return source;
  }
  async list() { await this.#ready(); const result = []; for (const source of await this.#store.listSources()) result.push(safeSource(source, await this.#password(source))); return result; }
  async source(id) { await this.#ready(); const source = await this.#lookup(id); return safeSource(source, await this.#password(source)); }
  async save(value) {
    await this.#ready();
    return this.#serial(async () => {
      const input = record(value), previous = input.id ? await this.#lookup(input.id) : undefined;
      if (previous && input.revision !== previous.revision) fail('数据源已更新，请刷新后重试。', 409);
      const connection = normalize(input, previous); this.#assertBusiness(connection);
      const oldPassword = previous ? await this.#password(previous) : undefined;
      if (input.password !== undefined && typeof input.password !== 'string') fail('密码格式无效。');
      const password = connection.engine === 'sqlite' || input.clearPassword === true ? undefined : input.password || oldPassword;
      const credentialId = previous?.credentialRef ?? connection.id, credentialChanged = password !== oldPassword;
      if (credentialChanged) await this.#put(credentialId, password);
      let saved;
      try { saved = await this.#store.saveSource({ ...connection, credentialRef: credentialId }, previous?.revision, { credentialChanged }); }
      catch (error) { if (credentialChanged) await this.#put(credentialId, oldPassword); if (error?.publicMessage) throw error; fail('保存数据源失败，原配置保留。'); }
      if (previous && saved.connectionVersion !== previous.connectionVersion) this.cancelSource(saved.id);
      return safeSource(saved, password);
    });
  }
  async remove(id, revision) {
    await this.#ready();
    return this.#serial(async () => {
      const source = await this.#lookup(id);
      if (revision !== source.revision) fail('数据源已更新，请刷新后重试。', 409);
      await this.#store.removeSource(id, revision); this.cancelSource(id);
      await this.#put(source.credentialRef ?? id, undefined);
      return { id, removed: true };
    });
  }
  async setEnabled(id, enabled, revision) {
    await this.#ready(); if (typeof enabled !== 'boolean') fail('启停状态无效。');
    return this.#serial(async () => {
      const source = await this.#store.setSourceEnabled(id, enabled, revision);
      if (!enabled) this.cancelSource(id);
      return safeSource(source, await this.#password(source));
    });
  }
  cancelSource(id) { for (const operation of this.#active.values()) if (operation.sourceId === id) operation.controller.abort(); }
  async test(inputOrId) {
    try {
      await this.#ready(); const input = typeof inputOrId === 'string' ? { id: inputOrId } : record(inputOrId);
      const previous = input.id ? await this.#lookup(input.id) : undefined;
      if (previous && !previous.enabled) fail('数据源已停用，请先启用。');
      const connection = normalize(input, previous); this.#assertBusiness(connection);
      const password = connection.engine === 'sqlite' || input.clearPassword ? undefined : input.password || (previous ? await this.#password(previous) : undefined);
      await this.#using({ ...connection, password }, undefined, (adapter, signal) => adapter.ping(AbortSignal.any([signal, AbortSignal.timeout(QUERY_MS)])));
      return { ok: true, message: '连接成功。' };
    } catch (error) { return { ok: false, message: error.publicMessage || '连接失败，请检查连接配置、凭据和数据库服务。' }; }
  }
  async #using(connection, signal, work) {
    const controller = new AbortController(), operationId = randomUUID();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let adapter, finish;
    const done = new Promise(resolveDone => { finish = resolveDone; });
    if (this.#closed) fail('数据源服务已关闭。', 503);
    this.#active.set(operationId, { sourceId: connection.id, controller, done });
    try { readSignal.throwIfAborted(); adapter = this.#factory(connection, { readOnly: true }); return await work(adapter, readSignal); }
    finally { try { if (adapter) await adapter.close().catch(() => {}); } finally { delete connection.password; this.#active.delete(operationId); finish(); } }
  }
  async #readSource(id, version, signal, work) {
    await this.#ready(); const source = await this.#lookup(id);
    if (!source.enabled) fail('数据源已停用，请先启用。');
    if (version !== undefined && source.connectionVersion !== version) fail('数据源连接已更新，请刷新后重试。', 409);
    return this.#using({ ...source, password: await this.#password(source) }, signal, async (adapter, readSignal) => {
      const result = await work(adapter, readSignal, source);
      readSignal.throwIfAborted();
      const current = await this.#lookup(id);
      if (!current.enabled || current.connectionVersion !== source.connectionVersion) fail('数据源状态已改变，请刷新后重试。', 409);
      return result;
    });
  }
  scan(id, version, { signal, onProgress } = {}) {
    return this.#readSource(id, version, signal, async (adapter, readSignal, source) => {
      const timeoutSignal = AbortSignal.any([readSignal, AbortSignal.timeout(QUERY_MS)]);
      await adapter.ping(timeoutSignal);
      const tables = await scanSourceCatalog(adapter, { signal: timeoutSignal, onProgress });
      return tables.map(table => ({ ...table, id: createHash('sha256').update(JSON.stringify([...targetIdentity(source), table.schema, table.name])).digest('hex') }));
    });
  }
  sampleTables(id, version, tables, signal) {
    return this.#readSource(id, version, signal, async (adapter, readSignal) => {
      const result = new Map();
      for (const table of tables) result.set(table.id, await sampleCatalogTable(adapter, table, { signal: AbortSignal.any([readSignal, AbortSignal.timeout(QUERY_MS)]) }));
      return result;
    });
  }
  detectFreshness(id, version, tables, signal) {
    return this.#readSource(id, version, signal, async (adapter, readSignal) => {
      const result = new Map(); let cursor = 0;
      const worker = async () => { while (cursor < tables.length) { const table = tables[cursor++]; readSignal.throwIfAborted(); result.set(table.id, await detectTableFreshness(adapter, table, { signal: readSignal })); } };
      await Promise.all([worker(), worker()]); return result;
    });
  }
  getTools() { return this.#tools; }
  async #execute(name, args, execution) {
    try {
      await this.#ready(); execution?.signal?.throwIfAborted();
      const sources = (await this.#store.listSources()).filter(s => s.enabled);
      if (name === 'sql_list') {
        const connections = [];
        for (const source of sources) { const status = await this.test(source.id); connections.push({ name: source.name, engine: source.engine, database: source.database, host: source.host, connected: status.ok, status: status.ok ? 'ok' : 'error', error: status.ok ? undefined : status.message }); }
        return { connections, ...(connections.length ? {} : { message: '尚无已启用数据源，请在数据源页面启用连接。' }) };
      }
      const source = args.connection === undefined ? sources[0] : sources.find(s => s.name === args.connection);
      if (!source) fail('未找到已启用的数据源，请使用 sql_list 查看连接。');
      const state = await this.#store.get(source.id), tables = state?.catalog?.tables || [];
      const available = tables.filter(table => table.enabled && table.tableKind === 'table');
      if (name === 'sql_schema') {
        const chosen = args.table ? available.filter(t => t.name === args.table || `${t.schema}.${t.name}` === args.table || t.id === args.table) : available;
        if (args.table && chosen.length !== 1) fail('表未启用、不存在或表名不唯一，请使用包含 schema 的名称。');
        return { connection: source.name, engine: source.engine, tables: chosen.map(t => ({ name: t.name, schema: t.schema, comment: t.sourceComment, columns: t.fields, fields: t.fields })) };
      }
      authorizeQuery(args.sql, { engine: source.engine, database: source.database, tables });
      return await this.#readSource(source.id, source.connectionVersion, execution?.signal, async (adapter, signal) => {
        // Recheck the current table policy immediately before opening the query.
        const current = await this.#store.get(source.id);
        const references = [];
        const sql = authorizeQuery(args.sql, { engine: source.engine, database: source.database, tables: current?.catalog?.tables || [], references });
        const result = await adapter.queryVerified(sql, 1001, AbortSignal.any([signal, AbortSignal.timeout(QUERY_MS)]), { tables: references });
        const latest = await this.#store.get(source.id);
        authorizeQuery(args.sql, { engine: source.engine, database: source.database, tables: latest?.catalog?.tables || [] });
        return { connection: source.name, ...result, rows: result.rows.slice(0, 1000), truncated: result.rows.length > 1000, rowCount: Math.min(result.rows.length, 1000) };
      });
    } catch (error) { if (error?.publicMessage) throw error; if (execution?.signal?.aborted) fail('数据库操作已取消。'); fail(name === 'sql_query' ? (error?.message && /^(?:SQL|sql_query )/.test(error.message) ? error.message : '查询被拒绝或执行失败，请检查启用范围、只读 SQL 和连接。') : '数据库操作失败，请检查连接。'); }
  }
  async close() { this.#closed = true; for (const operation of this.#active.values()) operation.controller.abort(); await this.#tail; await Promise.allSettled([...this.#active.values()].map(operation => operation.done)); }
}
