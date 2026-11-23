import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openManagementDb } from '../management-db.js';
import { createAnnotationStore, syncAnnotations } from '../annotation-store.js';
import { MysqlFlowStore, nextQuestion, newQuestions, sourceTarget, readAnalysisContext, writeAnalysisContext, questionAnalysisStatus } from '../flow-store.js';
import { DatasourceStore } from '../store.js';

const finalTables = ['dsh_management_profiles', 'dsh_management_migrations', 'dsh_sources', 'dsh_source_catalogs',
  'dsh_source_tables', 'dsh_questions', 'dsh_question_links', 'dsh_flow_bindings', 'dsh_table_annotations', 'dsh_field_annotations'];
const retiredTables = ['dsh_flow_states', 'dsh_flow_entities', 'dsh_legacy_imports', 'dsh_flow_runs', 'dsh_flow_batches', 'dsh_flow_receipts'];
const sqlFile = async name => (await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const statements = sql => sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
const config = { host: 'fixture', user: 'fixture-user', database: 'custom_management', profileId: 'test' };
const now = 1700000000123;
const mutation = /^(?:CREATE|ALTER|DROP|INSERT|REPLACE|UPDATE|DELETE|TRUNCATE)\b/i;
const source = id => ({ id, name: id, engine: 'mysql', host: 'localhost', port: 3306, user: 'reader', database: 'data', credentialRef: id });
const table = (id, structureHash = 'shape-1') => ({ id, name: `table_${id}`, schema: 'data', tableKind: 'table',
  sourceComment: '原始注释', fields: [{ name: 'id', type: 'bigint', primaryKey: true, notNull: true, sourceComment: '编号' }],
  enabled: false, domain: '', category: '', reason: '', structureHash, freshness: null });
const catalog = (id, tables) => ({ id, scannedAt: new Date(now).toISOString(), tables });
const applyCatalog = (store, id, next) => store.change(id, state => ({ state: { ...state, catalog: next, revision: state.revision + 1 } }));
const context = catalogId => ({ catalogId, connectionVersion: 1 });
const link = (questionId, tableId) => ({ questionId, tableId, fields: ['id'], reason: '字段依据' });
const sqliteFile = fileURLToPath(new URL('../flow-store.js', import.meta.url));
const sameFileOtherCase = fileURLToPath(new URL('../FLOW-STORE.JS', import.meta.url));
const caseInsensitiveWindows = process.platform === 'win32' && existsSync(sameFileOtherCase);

/** Translate the MySQL syntax used by the store for an in-memory relational fixture. */
async function managementFixture(t, initialized = true) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  const ddl = statements(await sqlFile('migrations/001-management.sql'));
  const apply = () => {
    for (const sql of ddl) sqlite.exec(sql.replace(/\) ENGINE=InnoDB.*$/, ')')
      .replace(/^  KEY \(profile_id, source_id\),\n/m, '').replace(/\bINSERT IGNORE\b/, 'INSERT OR IGNORE'));
  };
  if (initialized) apply();
  const pool = {
    sqlite, apply, calls: [], executions: [], objects: [], ended: false, released: 0, fail: null,
    async query(sql) {
      assert.equal(arguments.length, 1, '携带值的管理库 SQL 必须使用 execute');
      return this.run(sql, []);
    },
    async execute(sql, values) {
      assert.equal(values.length, (sql.match(/\?/g) ?? []).length);
      assert.ok(values.every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
      this.executions.push({ sql, values });
      return this.run(sql, values);
    },
    run(sql, values) {
      sql = sql.trim();
      this.calls.push(sql);
      if (this.fail?.(sql)) throw new Error('fixture failure');
      if (sql.includes('FROM information_schema.TABLES')) {
        assert.match(sql, /TABLE_SCHEMA = DATABASE\(\)/);
        for (const kind of ['TRIGGERS', 'ROUTINES', 'EVENTS', 'KEY_COLUMN_USAGE']) assert.ok(sql.includes(`information_schema.${kind}`));
        const rows = sqlite.prepare("SELECT name, UPPER(type) AS type FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger')").all();
        return [[...rows.map(row => row.type === 'TABLE' ? { name: row.name, type: 'BASE TABLE', engine: 'InnoDB' } : row), ...this.objects]];
      }
      if (sql.includes('FROM information_schema.COLUMNS')) {
        const tables = sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        return [tables.flatMap(({ name }) => sqlite.prepare('SELECT name FROM pragma_table_xinfo(?)').all(name).map(row => ({ name, column_name: row.name, generation_expression: '' })))];
      }
      if (sql.startsWith('SELECT UNIX_TIMESTAMP')) return [[{ now_ms: String(now) }]];
      if (sql.startsWith('SET TRANSACTION ISOLATION LEVEL')) return [[]];
      if (sql.startsWith('START TRANSACTION')) { sqlite.exec('BEGIN'); return [[]]; }
      sql = sql.replace(/ (FOR UPDATE|LOCK IN SHARE MODE)$/, '').replace(/\bIF\(/g, 'IIF(')
        .replace('ON DUPLICATE KEY UPDATE', 'ON CONFLICT DO UPDATE SET')
        .replace(/= VALUES\((\w+)\)/g, '= excluded.$1');
      values = values.map(value => typeof value === 'boolean' ? Number(value) : value);
      const statement = sqlite.prepare(sql);
      return [sql.startsWith('SELECT') ? statement.all(...values) : statement.run(...values)];
    },
    async getConnection() { return this; },
    async beginTransaction() { sqlite.exec('BEGIN'); },
    async commit() { sqlite.exec('COMMIT'); },
    async rollback() { sqlite.exec('ROLLBACK'); },
    release() { this.released++; },
    async end() { this.ended = true; },
  };
  return pool;
}

async function mysqlStore(t) {
  const pool = await managementFixture(t);
  const db = await openManagementDb(config, { pool });
  return { pool, db, store: new MysqlFlowStore(db) };
}

test('未能解析的 SQLite 文件目标保留原路径', () => {
  const file = `${sqliteFile}.missing`;
  const otherCase = `${sqliteFile}.MISSING`;
  assert.equal(sourceTarget({ engine: 'sqlite', file }).at(-1), file);
  assert.equal(sourceTarget({ engine: 'sqlite', file: otherCase }).at(-1), otherCase);
});

test('无来源的旧对象编辑后保持 unknown 且不能泛化', () => {
  const legacy = { id: 'legacy', text: '旧问题', answer: '', version: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  for (const text of [legacy.text, '修改后的旧问题']) {
    const edited = nextQuestion({ ...legacy, text, origin: 'original', sourceQuestionId: '伪造来源' }, legacy, now);
    assert.equal(edited.origin, 'unknown');
    assert.equal(edited.sourceQuestionId, null);
    assert.equal(edited.version, text === legacy.text ? 1 : 2);
    assert.throws(() => newQuestions({ questions: [{ id: edited.id, version: edited.version }], items: [{ text: '旧问题候选' }] }, [edited], now), /仅原问题/);
  }
});

test('分析上下文兼容旧业务域哈希且关联优先于显式空', () => {
  for (const domainCatalogId of ['', 'legacy-hash']) {
    assert.deepEqual(readAnalysisContext(domainCatalogId), { version: 1, domainCatalogId, emptyQuestionAnalyses: {} });
  }
  const analysis = { version: 1, domainCatalogId: 'domain-id', emptyQuestionAnalyses: { q: { questionVersion: 2, connectionVersion: 1, catalogId: 'a' } } };
  assert.deepEqual(readAnalysisContext(writeAnalysisContext(analysis)), analysis);
  const state = { id: 'a', connectionVersion: 1, catalog: catalog('a', [table('t')]), domainContext: writeAnalysisContext(analysis) };
  const question = { id: 'q', version: 2, links: [] };
  assert.equal(questionAnalysisStatus(question, state), 'empty');
  assert.equal(questionAnalysisStatus({ ...question, version: 3 }, state), 'stale');
  assert.equal(questionAnalysisStatus(question, { ...state, connectionVersion: 2 }), 'stale');
  assert.equal(questionAnalysisStatus(question, { ...state, catalog: catalog('b', []) }), 'stale');
  const linked = { ...question, links: [{ sourceId: 'a', tableId: 't', questionVersion: 1, structureHash: 'shape-1' }] };
  assert.equal(questionAnalysisStatus(linked, state), 'stale');
  assert.equal(questionAnalysisStatus({ ...linked, links: [{ ...linked.links[0], questionVersion: 2 }] }, state), 'linked');
  assert.equal(questionAnalysisStatus({ ...question, links: [{ ...linked.links[0], sourceId: 'b' }] }, state), 'empty');
});

for (const [name, setup] of [['管理库', async t => (await mysqlStore(t)).store], ['内存', async () => new DatasourceStore({ now: () => now })]]) {
  test(`${name}显式空结果原子保存且业务域上下文和回调状态合并`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    await applyCatalog(store, 'a', catalog('a', [table('t')]));
    const empty = await store.saveQuestion({ text: '无匹配表的问题' });
    const linked = await store.saveQuestion({ text: '有关联的问题' });
    const stale = await store.saveQuestion({ text: '修改过的候选' });
    const complete = { ...context('a'), analysisComplete: true, staleQuestionIds: [stale.id] };
    const before = await store.get('a');
    await assert.rejects(store.change('a', async (state, _source, _now, tx) => {
      await tx.replaceQuestionLinks([empty, linked, stale], [link(linked.id, 't')], complete);
      state.domains = [{ name: '回滚域' }];
      throw new Error('回滚空结果');
    }), /回滚空结果/);
    assert.deepEqual(await store.get('a'), before);
    assert.ok((await store.listQuestions('a')).every(question => question.analysisStatus === 'missing'));
    const returned = await store.change('a', async (state, _source, _now, tx) => {
      await tx.replaceQuestionLinks([empty, linked, stale], [link(linked.id, 't')], complete);
      state.domainContext = writeAnalysisContext({ ...readAnalysisContext(state.domainContext), domainCatalogId: 'business-domain' });
      state.domains = [{ name: '业务域' }];
      return { state, result: { state } };
    });
    const saved = await store.get('a'), analysis = readAnalysisContext(saved.domainContext);
    assert.deepEqual(returned.state, saved);
    assert.equal(saved.revision, before.revision + 1);
    assert.equal(analysis.domainCatalogId, 'business-domain');
    assert.deepEqual(analysis.emptyQuestionAnalyses, { [empty.id]: { questionVersion: 1, connectionVersion: 1, catalogId: 'a' } });
    assert.equal(saved.catalog.domainContext, saved.domainContext);
    const statuses = Object.fromEntries((await store.listQuestions('a')).map(question => [question.id, question.analysisStatus]));
    assert.deepEqual(statuses, { [empty.id]: 'empty', [linked.id]: 'linked', [stale.id]: 'missing' });
    const completedEmpty = { ...context('a'), analysisComplete: true };
    await store.replaceQuestionLinks('a', [empty], [link(empty.id, 't')], completedEmpty);
    assert.equal(readAnalysisContext((await store.get('a')).domainContext).emptyQuestionAnalyses[empty.id], undefined);
    await store.replaceQuestionLinks('a', [empty], [], context('a'));
    assert.equal((await store.listQuestions('a')).find(question => question.id === empty.id).analysisStatus, 'missing');
    const resultOnly = await store.change('a', async (state, _source, _now, tx) => {
      await tx.replaceQuestionLinks([empty], [], completedEmpty);
      return { result: { state } };
    });
    assert.deepEqual(resultOnly.state, await store.get('a'));
    assert.equal((await store.listQuestions('a')).find(question => question.id === empty.id).analysisStatus, 'empty');
  });

  test(`${name}空结果按问题版本目录连接与数据源隔离并过滤删除问题`, async t => {
    const store = await setup(t);
    for (const id of ['a', 'b']) {
      await store.saveSource(source(id));
      await applyCatalog(store, id, catalog(id, []));
    }
    let question = await store.saveQuestion({ text: '空目录问题' });
    const complete = id => ({ ...context(id), analysisComplete: true });
    await store.replaceQuestionLinks('a', [question], [], complete('a'));
    assert.equal((await store.listQuestions('a'))[0].analysisStatus, 'empty');
    assert.equal((await store.listQuestions('b'))[0].analysisStatus, 'missing');
    question = await store.saveQuestion({ ...question, answer: '更新问题版本' });
    assert.equal((await store.listQuestions('a'))[0].analysisStatus, 'stale');
    assert.equal(readAnalysisContext((await store.get('a')).domainContext).emptyQuestionAnalyses[question.id].questionVersion, 1);
    await store.replaceQuestionLinks('a', [question], [], complete('a'));
    await applyCatalog(store, 'a', catalog('a2', []));
    assert.equal((await store.listQuestions('a'))[0].analysisStatus, 'stale');
    await store.replaceQuestionLinks('a', [question], [], complete('a2'));
    const record = await store.getSource('a');
    await store.saveSource(record, record.revision, { credentialChanged: true });
    assert.equal((await store.listQuestions('a'))[0].analysisStatus, 'stale');
    await store.replaceQuestionLinks('a', [question], [], { ...complete('a2'), connectionVersion: 2 });
    await store.removeQuestion(question.id, question.version);
    assert.deepEqual(readAnalysisContext((await store.get('a')).domainContext).emptyQuestionAnalyses, {});
    await store.change('a', state => ({ state: { ...state, revision: state.revision + 1 } }));
    assert.deepEqual(readAnalysisContext((await store.get('a')).domainContext).emptyQuestionAnalyses, {});
  });
  test(`${name}保存源版本、目录表数和安全元数据`, async t => {
    const store = await setup(t);
    const original = await store.saveSource({ ...source('a'), password: 'fixture-secret', enabled: false });
    assert.equal(original.enabled, true);
    assert.equal(original.createdAt, new Date(now).toISOString());
    assert.equal(original.revision, 1);
    assert.equal(original.connectionVersion, 1);
    assert.equal((await store.listSources())[0].tableCount, null);
    assert.equal((await store.get('a')).catalog, null);
    assert.equal((await store.getSource('a')).credentialRef, 'a');
    assert.equal(Object.hasOwn(await store.getSource('a'), 'password'), false);
    await assert.rejects(store.saveSource({ ...source('duplicate'), name: 'A' }), /名称已存在/);
    await assert.rejects(store.saveSource(original), /已更新/);
    await applyCatalog(store, 'a', catalog('empty', []));
    assert.equal((await store.listSources())[0].tableCount, 0);
    await applyCatalog(store, 'a', catalog('full', [table('t')]));
    assert.equal((await store.listSources())[0].tableCount, 1);
    const renamed = await store.saveSource({ ...original, name: 'new', description: '改描述' }, original.revision);
    assert.equal(renamed.connectionVersion, 1);
    assert.equal((await store.get('a')).catalog.id, 'full');
    const updated = await store.saveSource(renamed, renamed.revision, { credentialChanged: true });
    assert.equal(updated.connectionVersion, 2);
    assert.equal((await store.get('a')).catalog.id, 'full');
    const disabled = await store.setSourceEnabled('a', false, updated.revision);
    assert.equal(disabled.connectionVersion, 2);
    assert.equal(disabled.enabled, false);
    await assert.rejects(store.removeSource('a', original.revision), /已更新/);
    const moved = await store.saveSource({ ...disabled, database: 'different' }, disabled.revision);
    assert.equal(moved.connectionVersion, 3);
    assert.equal(moved.enabled, false);
    assert.equal((await store.get('a')).catalog, null);
    await store.removeSource('a', moved.revision);
    assert.equal(await store.get('a'), undefined);
  });

  test(`${name}使用同一 Windows SQLite 文件的大小写别名时保留目录和关联`, { skip: !caseInsensitiveWindows }, async t => {
    const store = await setup(t);
    const initial = await store.saveSource({ id: 'sqlite', name: 'SQLite', engine: 'sqlite', file: sqliteFile });
    await applyCatalog(store, initial.id, catalog('existing', [table('t')]));
    const question = await store.saveQuestion({ text: '关联问题' });
    await store.replaceQuestionLinks(initial.id, [question], [link(question.id, 't')], context('existing'));
    const before = await store.get(initial.id);
    const questions = await store.listQuestions(initial.id);

    const saved = await store.saveSource({ ...initial, file: sameFileOtherCase }, initial.revision);
    assert.equal(saved.file, sameFileOtherCase);
    assert.equal(saved.connectionVersion, initial.connectionVersion + 1);
    assert.deepEqual(sourceTarget(saved), sourceTarget(initial));
    assert.deepEqual(await store.get(initial.id), { ...before, connectionVersion: saved.connectionVersion });
    assert.deepEqual(await store.listQuestions(initial.id), questions);

    const moved = await store.saveSource({ ...saved, file: fileURLToPath(import.meta.url) }, saved.revision);
    assert.equal((await store.get(moved.id)).catalog, null);
    assert.deepEqual((await store.listQuestions(moved.id))[0].links, []);
  });

  test(`${name}跨源问题关联保留、过期、替换和清理`, async t => {
    const store = await setup(t);
    for (const id of ['a', 'b']) {
      await store.saveSource(source(id));
      await applyCatalog(store, id, catalog(id, [table('t'), table('u')]));
    }
    const q = await store.saveQuestion({ text: '  收入   REPORT ', answer: '参考答案' });
    const other = await store.saveQuestion({ text: '产品问题' });
    await assert.rejects(store.saveQuestion({ text: '收入 report' }), /已存在/);
    await store.replaceQuestionLinks('a', [q, other], [link(q.id, 't'), link(q.id, 'u'), link(other.id, 't')], context('a'));
    await store.replaceQuestionLinks('b', [q], [link(q.id, 'u')], context('b'));
    assert.deepEqual((await store.listQuestions('b')).find(item => item.id === q.id).links, [{
      sourceId: 'b', tableId: 'u', fields: ['id'], reason: '字段依据', questionVersion: 1, structureHash: 'shape-1',
      analyzedAt: new Date(now).toISOString(),
    }]);
    await assert.rejects(store.replaceQuestionLinks('b', [q], [{ ...link(q.id, 'u'), fields: ['unknown'] }], context('b')), /关联无效/);
    const edited = await store.saveQuestion({ ...q, answer: '新答案' });
    assert.equal(edited.version, 2);
    assert.ok(edited.links.every(item => item.questionVersion === 1));
    await assert.rejects(store.replaceQuestionLinks('b', [q], [], context('b')), /已更新/);
    await applyCatalog(store, 'a', catalog('a2', [table('t', 'shape-2'), table('u')]));
    let items = await store.listQuestions('a');
    assert.deepEqual(items.find(item => item.id === q.id).links.map(item => item.tableId), ['u']);
    assert.deepEqual(items.find(item => item.id === other.id).links, []);
    await assert.rejects(store.replaceQuestionLinks('a', [edited], [], context('a')), /目录已变化/);
    await store.replaceQuestionLinks('a', [edited], [], context('a2'));
    assert.deepEqual((await store.listQuestions('a')).find(item => item.id === q.id).links, []);
    await store.removeSource('b', 1);
    assert.deepEqual((await store.listQuestions()).find(item => item.id === q.id).links, []);
    await store.replaceQuestionLinks('a', [edited], [link(q.id, 'u')], context('a2'));
    await store.saveSource({ ...source('a'), database: 'changed' }, 1);
    assert.deepEqual((await store.listQuestions()).find(item => item.id === q.id).links, []);
    await store.removeQuestion(q.id, edited.version);
    assert.deepEqual((await store.listQuestions()).map(item => item.id), [other.id]);
  });

  test(`${name}泛化问题批量保存检查版本与重复且事务失败不留下部分问题`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    await applyCatalog(store, 'a', catalog('a', [table('t')]));
    const original = await store.saveQuestion({ text: '按区统计床位', answer: '原答案' });
    await store.replaceQuestionLinks('a', [original], [link(original.id, 't')], context('a'));
    const before = await store.listQuestions();
    const input = items => ({ questions: [{ id: original.id, version: original.version }], items });
    await assert.rejects(store.saveQuestions(input([{ text: '新增甲' }, { text: '新增甲' }])), /已存在/);
    await assert.rejects(store.saveQuestions(input([{ text: '新增甲' }, { text: original.text }])), /已存在/);
    await assert.rejects(store.saveQuestions(input([{ text: '新增甲' }, { text: '长'.repeat(2001) }])), /长度/);
    await assert.rejects(store.change('a', async (_state, _source, _now, work) => {
      const staged = await work.saveQuestions(input([{ text: '回滚候选' }]));
      await work.assertQuestionVersions(staged);
      throw new Error('拒绝提交');
    }), /拒绝提交/);
    assert.deepEqual(await store.listQuestions(), before);
    const created = await store.saveQuestions(input([{ text: '按区统计护理床位', answer: '不得复制' }, { text: '按机构统计床位' }]));
    assert.equal(created.length, 2);
    assert.equal(new Set(created.map(item => item.id)).size, 2);
    assert.ok(created.every(item => item.id !== original.id && item.version === 1 && item.answer === '' && item.links.length === 0));
    assert.deepEqual((await store.listQuestions()).find(item => item.id === original.id), before[0]);
    const edited = await store.saveQuestion({ ...original, text: '已编辑的原问题' });
    await assert.rejects(store.saveQuestions(input([{ text: '旧版候选' }])), /已更新/);
    await store.removeQuestion(original.id, edited.version);
    await assert.rejects(store.saveQuestions(input([{ text: '已删除原问题候选' }])), /已删除/);
    assert.equal((await store.listQuestions()).length, 2);
  });

  test(`${name}多参考保存校验全部原问题且来源由服务端确定`, async t => {
    const store = await setup(t);
    const first = await store.saveQuestion({ text: '按区统计床位', answer: '第一份答案' });
    const second = await store.saveQuestion({ text: '按机构统计护理床位', answer: '第二份答案' });
    const references = [first, second].map(({ id, version }) => ({ id, version }));
    const input = { questions: references, items: [{ text: '多参考生成问题', origin: 'original', sourceQuestionId: first.id,
      answer: '伪造答案', links: [link(first.id, 't')] }], origin: 'original', sourceQuestionId: first.id };
    const before = await store.listQuestions();
    for (const questions of [undefined, null, {}, [], [null], [{}], [{ id: '', version: 1 }]]) {
      await assert.rejects(store.saveQuestions({ ...input, questions }), error => error.status === 400);
    }
    await assert.rejects(store.saveQuestions({ ...input, questions: [references[0], references[0]] }), /重复/);
    await assert.rejects(store.saveQuestions({ ...input, questions: [references[0], { id: 'missing', version: 1 }] }), /已删除/);
    await assert.rejects(store.saveQuestions({ ...input, questions: [references[0], { ...references[1], version: 0 }] }), /已更新/);
    await assert.rejects(store.saveQuestions({ ...input, items: [] }), /1 至 20/);
    assert.deepEqual(await store.listQuestions(), before);

    const [generated] = await store.saveQuestions(input);
    assert.equal(generated.origin, 'generated');
    assert.equal(generated.sourceQuestionId, null);
    assert.equal(generated.answer, '');
    assert.deepEqual(generated.links, []);
    const after = await store.listQuestions();
    assert.deepEqual(after.filter(question => references.some(reference => reference.id === question.id)), before);
    await assert.rejects(store.saveQuestions({ questions: [references[0], { id: generated.id, version: generated.version,
      origin: 'original' }], items: [{ text: '伪造来源再次泛化' }] }), /仅原问题/);
    const edited = await store.saveQuestion({ ...generated, text: '编辑多参考候选', origin: 'original', sourceQuestionId: first.id });
    assert.equal(edited.origin, 'generated');
    assert.equal(edited.sourceQuestionId, null);
    assert.deepEqual(await store.saveQuestion({ ...edited, origin: 'original', sourceQuestionId: first.id }), edited);

    const editedSecond = await store.saveQuestion({ ...second, answer: '第二参考已更新' });
    const beforeStaleSave = await store.listQuestions();
    await assert.rejects(store.saveQuestions({ ...input, items: [{ text: '第二参考旧版候选' }] }), /已更新/);
    assert.deepEqual(await store.listQuestions(), beforeStaleSave);
    await store.removeQuestion(second.id, editedSecond.version);
    const beforeDeletedSave = await store.listQuestions();
    await assert.rejects(store.saveQuestions({ ...input, items: [{ text: '第二参考已删除候选' }] }), /已删除/);
    assert.deepEqual(await store.listQuestions(), beforeDeletedSave);
    assert.deepEqual(beforeDeletedSave.find(question => question.id === generated.id), edited);
  });

  test(`${name}事务内原子保存候选问题和关联，编辑候选由内部上下文标记过期`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    await applyCatalog(store, 'a', catalog('a', [table('t'), table('u')]));
    const original = await store.saveQuestion({ text: '原问题' });
    const created = await store.change('a', async (_state, _source, _now, work) => {
      const questions = await work.saveQuestions({ questions: [{ id: original.id, version: original.version }],
        items: [{ text: '未修改候选' }, { text: '编辑后的候选' }] });
      await work.replaceQuestionLinks(questions, questions.flatMap(question => [
        { ...link(question.id, 't'), questionVersion: 999 }, link(question.id, 'u'),
      ]), { ...context('a'), staleQuestionIds: [questions[1].id] });
      return { result: questions };
    });
    const saved = await store.listQuestions('a');
    assert.equal(saved.length, 3);
    for (const [index, question] of created.entries()) {
      const persisted = saved.find(item => item.id === question.id);
      assert.equal(persisted.origin, 'generated');
      assert.equal(persisted.sourceQuestionId, original.id);
      assert.equal(persisted.links.length, 2);
      assert.ok(persisted.links.every(item => item.questionVersion === (index === 1 ? 0 : question.version)));
    }
    for (const staleQuestionIds of [null, 'invalid', ['missing']]) {
      await assert.rejects(store.replaceQuestionLinks('a', [created[0]], [link(created[0].id, 't')],
        { ...context('a'), staleQuestionIds }), /关联无效/);
    }
    assert.deepEqual(await store.listQuestions('a'), saved);
  });

  test(`${name}多参考候选问题和关联在后续失败时一并回滚`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    await applyCatalog(store, 'a', catalog('a', [table('t')]));
    const original = await store.saveQuestion({ text: '原问题' });
    const second = await store.saveQuestion({ text: '第二参考问题' });
    const references = [original, second].map(({ id, version }) => ({ id, version }));
    await store.replaceQuestionLinks('a', [original], [link(original.id, 't')], context('a'));
    const before = await store.listQuestions();
    for (const invalidLink of [false, true]) {
      await assert.rejects(store.change('a', async (_state, _source, _now, work) => {
        const created = await work.saveQuestions({ questions: references,
          items: [{ text: '待回滚候选甲' }, { text: '待回滚候选乙' }] });
        assert.ok(created.every(question => question.origin === 'generated' && question.sourceQuestionId === null));
        await work.replaceQuestionLinks(created, created.map(question => link(question.id, invalidLink ? 'missing' : 't')), context('a'));
        throw new Error('关联后提交失败');
      }), invalidLink ? /关联无效/ : /关联后提交失败/);
      assert.deepEqual(await store.listQuestions(), before);
    }
  });

  for (const change of ['结构变化', '删除表']) {
    test(`${name}${change}令多表问题的同源剩余关联失效，保留其他问题和来源`, async t => {
      const store = await setup(t);
      for (const id of ['a', 'b']) {
        await store.saveSource(source(id));
        await applyCatalog(store, id, catalog(id, [table('t'), table('u')]));
      }
      const affected = await store.saveQuestion({ text: '多表问题' });
      const unaffected = await store.saveQuestion({ text: '其他问题' });
      await store.replaceQuestionLinks('a', [affected, unaffected], [link(affected.id, 't'), link(affected.id, 'u'),
        link(unaffected.id, 'u')], context('a'));
      await store.replaceQuestionLinks('b', [affected], [link(affected.id, 't'), link(affected.id, 'u')], context('b'));
      const otherSource = await store.listQuestions('b');
      const otherQuestion = (await store.listQuestions('a')).find(question => question.id === unaffected.id);
      const tables = change === '结构变化' ? [table('t', 'shape-2'), table('u')] : [table('u')];
      await applyCatalog(store, 'a', catalog('a2', tables));
      const saved = (await store.listQuestions('a')).find(question => question.id === affected.id);
      assert.equal(saved.version, affected.version);
      assert.equal(saved.links.length, 1);
      assert.equal(saved.links[0].tableId, 'u');
      assert.equal(saved.links[0].questionVersion, 0);
      assert.deepEqual((await store.listQuestions('a')).find(question => question.id === unaffected.id), otherQuestion);
      assert.deepEqual(await store.listQuestions('b'), otherSource);
      // Repeating an unchanged scan must not make the remaining stale association reusable.
      await applyCatalog(store, 'a', catalog('a3', tables));
      assert.deepEqual((await store.listQuestions('a')).find(question => question.id === affected.id), saved);
    });
  }

  test(`${name}来源由服务端确定且编辑与删除父问题保留来源历史`, async t => {
    const store = await setup(t);
    const original = await store.saveQuestion({ text: '手工原问题', origin: 'generated', sourceQuestionId: '伪造来源' });
    assert.equal(original.origin, 'original');
    assert.equal(original.sourceQuestionId, null);
    const items = Array.from({ length: 20 }, (_, index) => ({ text: `候选问题 ${index}`, origin: 'original', sourceQuestionId: '伪造来源',
      links: [{ tableId: '未选择的表', fields: ['id'], reason: '草稿依据' }] }));
    const input = { questions: [{ id: original.id, version: original.version }], items };
    await assert.rejects(store.saveQuestions({ ...input, items: [...items, { text: '超限候选' }] }), /1 至 20/);
    const created = await store.saveQuestions(input);
    assert.equal(created.length, 20);
    assert.ok(created.every(question => question.origin === 'generated' && question.sourceQuestionId === original.id && question.links.length === 0));
    await assert.rejects(store.saveQuestions({ questions: [{ id: created[0].id, version: created[0].version }], items: [{ text: '再次泛化' }] }), /仅原问题/);
    const edited = await store.saveQuestion({ ...created[0], text: '修改后的泛化问题', origin: 'original', sourceQuestionId: null });
    assert.equal(edited.origin, 'generated');
    assert.equal(edited.sourceQuestionId, original.id);
    const unchanged = await store.saveQuestion({ ...edited, origin: 'original', sourceQuestionId: '其他来源' });
    assert.deepEqual(unchanged, edited);
    const editedOriginal = await store.saveQuestion({ ...original, answer: '新增答案', origin: 'generated', sourceQuestionId: created[0].id });
    assert.equal(editedOriginal.origin, 'original');
    assert.equal(editedOriginal.sourceQuestionId, null);
    await store.removeQuestion(original.id, editedOriginal.version);
    const persisted = (await store.listQuestions()).find(question => question.id === edited.id);
    assert.equal(persisted.origin, 'generated');
    assert.equal(persisted.sourceQuestionId, original.id);
  });

  test(`${name}目录保存只投影必要数据并回滚失败的关联事务`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    const q = await store.saveQuestion({ text: '问题' });
    const first = { ...table('t'), samples: [['fixture-private']], fields: [{ ...table('t').fields[0], examples: ['fixture-private'] }] };
    const domains = [{ name: '销售', description: '销售业务' }];
    await store.change('a', state => ({ state: { ...state, catalog: catalog('a', [first]), revision: 1, domains, domainContext: 'a' } }));
    const before = await store.get('a');
    assert.deepEqual(before.catalog.tables, [table('t')]);
    assert.deepEqual(before.catalog.domains, domains);
    assert.equal(before.catalog.domainContext, 'a');
    await assert.rejects(store.change('a', async (state, record, timestamp, work) => {
      assert.equal(record.enabled, true);
      assert.equal(timestamp, now);
      await work.replaceQuestionLinks([q], [link(q.id, 't')], context('a'));
      state.catalog.tables[0].enabled = true;
      throw new Error('拒绝提交');
    }), /拒绝提交/);
    assert.deepEqual(await store.get('a'), before);
    assert.deepEqual((await store.listQuestions())[0].links, []);
  });

  test(`${name}退役会话跨启停和删除继续失效`, async t => {
    const store = await setup(t);
    await store.saveSource(source('a'));
    assert.equal(await store.bindSession('s1', { sourceId: 'a', retired: false, connectionVersion: 1, operationId: 'private' }), true);
    assert.deepEqual(await store.findBinding('s1'), { sourceId: 'a', retired: false });
    await store.change('a', async (_state, _source, _now, work) => { await work.assertSessionBinding('s1'); return {}; });
    await store.setSourceEnabled('a', false, 1);
    assert.equal(await store.bindSession('late', { sourceId: 'a', retired: false, connectionVersion: 1 }), false);
    await store.setSourceEnabled('a', true, 2);
    await assert.rejects(store.bindSession('s1', { sourceId: 'a', retired: false }), /已退役/);
    await assert.rejects(store.change('a', async (_state, _source, _now, work) => { await work.assertSessionBinding('s1'); return {}; }), /会话已失效/);
    assert.equal(await store.bindSession('s2', { sourceId: 'a', retired: false, connectionVersion: 1 }), true);
    await store.removeSource('a', 3);
    assert.deepEqual(await store.findBinding('s2'), { sourceId: 'a', retired: true });
    assert.equal(await store.bindSession('missing', { sourceId: 'a', retired: false }), false);
    await store.retireSession('unknown');
  });
}

test('管理库重建复用空结果且 profile 和 source 完全隔离', async t => {
  const { db, pool, store } = await mysqlStore(t);
  await store.saveSource(source('a'));
  await applyCatalog(store, 'a', catalog('empty', []));
  const question = await store.saveQuestion({ text: '没有匹配表' });
  const complete = { ...context('empty'), analysisComplete: true };
  await store.replaceQuestionLinks('a', [question], [], complete);
  const saved = await store.get('a');
  const rebuilt = new MysqlFlowStore(db);
  assert.deepEqual(await rebuilt.get('a'), saved);
  assert.equal((await rebuilt.listQuestions('a'))[0].analysisStatus, 'empty');
  const otherDb = await openManagementDb({ ...config, profileId: 'other-profile' }, { pool });
  const other = new MysqlFlowStore(otherDb);
  await other.saveSource(source('a'));
  await applyCatalog(other, 'a', catalog('empty', []));
  // 同 ID 不同 profile 的版本记录不能命中原 profile 的上下文。
  pool.sqlite.prepare('INSERT INTO dsh_questions (profile_id, question_id, question_text, answer, version, created_at, updated_at, origin, source_question_id) SELECT ?, question_id, question_text, answer, version, created_at, updated_at, origin, source_question_id FROM dsh_questions WHERE profile_id = ?').run('other-profile', config.profileId);
  assert.equal((await other.listQuestions('a'))[0].analysisStatus, 'missing');
  await other.replaceQuestionLinks('a', [question], [], complete);
  await other.removeQuestion(question.id, question.version);
  assert.equal((await rebuilt.listQuestions('a'))[0].analysisStatus, 'empty');
  assert.deepEqual(readAnalysisContext((await other.get('a')).domainContext).emptyQuestionAnalyses, {});
  const stored = pool.sqlite.prepare('SELECT domain_context FROM dsh_source_catalogs WHERE profile_id = ? AND source_id = ?').get(config.profileId, 'a');
  assert.equal(readAnalysisContext(stored.domain_context).emptyQuestionAnalyses[question.id].catalogId, 'empty');
});

test('管理库上下文落库失败时回滚关联替换', async t => {
  const { pool, store } = await mysqlStore(t);
  await store.saveSource(source('a'));
  await applyCatalog(store, 'a', catalog('a', [table('t')]));
  const question = await store.saveQuestion({ text: '原有关联' });
  await store.replaceQuestionLinks('a', [question], [link(question.id, 't')], context('a'));
  const before = await store.listQuestions('a');
  pool.fail = sql => sql.startsWith('INSERT INTO dsh_source_catalogs');
  await assert.rejects(store.replaceQuestionLinks('a', [question], [], { ...context('a'), analysisComplete: true }), /fixture failure/);
  pool.fail = null;
  assert.deepEqual(await store.listQuestions('a'), before);
  assert.deepEqual(readAnalysisContext((await store.get('a')).domainContext).emptyQuestionAnalyses, {});
});

test('管理库以 execute 绑定多行文本、引号和反斜杠', async t => {
  const { pool, store } = await mysqlStore(t);
  const id = "source-'\\?";
  const text = "如何查询 '订单'？";
  const answer = "第一行\r\n第二行\n路径 C:\\data\\sales，名称 '订单'，标记 ?";
  await store.saveSource(source(id));
  await applyCatalog(store, id, catalog('existing', [table('a'), table('b'), table('c')]));
  const first = await store.saveQuestion({ text, answer });
  const second = await store.saveQuestion({ text: '第二个问题' });
  const reason = "字段依据 '编号'\n保留反斜杠 \\ 和 ?";
  await store.replaceQuestionLinks(id, [first, second], [link(first.id, 'a'),
    { ...link(first.id, 'b'), reason }, link(second.id, 'c')], context('existing'));

  const questionWrite = pool.executions.find(({ sql }) => sql.startsWith('INSERT INTO dsh_questions'));
  assert.match(questionWrite.sql, /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?\)/);
  assert.deepEqual(questionWrite.values.slice(0, 5), [config.profileId, first.id, text, answer, 1]);
  assert.equal(questionWrite.sql.includes(answer), false);
  const linkWrite = pool.executions.find(({ sql }) => sql.startsWith('INSERT INTO dsh_question_links'));
  assert.equal(linkWrite.values.length, 27);
  assert.ok(linkWrite.values.includes(reason));
  assert.equal(linkWrite.sql.includes(reason), false);
  const versionsRead = pool.executions.find(({ sql }) => sql.startsWith('SELECT question_id, version'));
  assert.match(versionsRead.sql, /question_id IN \(\?, \?\)/);
  assert.deepEqual(versionsRead.values, [config.profileId, first.id, second.id]);

  const saved = (await store.listQuestions(id)).find(question => question.id === first.id);
  assert.equal(saved.text, text);
  assert.equal(saved.answer, answer);
  assert.equal(saved.links.find(item => item.tableId === 'b').reason, reason);
  await applyCatalog(store, id, catalog('reduced', [table('b')]));
  const tableDelete = pool.executions.find(({ sql }) => sql.startsWith('DELETE FROM dsh_source_tables'));
  assert.match(tableDelete.sql, /table_id IN \(\?, \?\)/);
  assert.deepEqual(tableDelete.values, [config.profileId, id, 'a', 'c']);
  const affectedRead = pool.executions.find(({ sql }) => sql.startsWith('SELECT DISTINCT question_id FROM dsh_question_links'));
  const invalidation = pool.executions.find(({ sql }) => sql.startsWith('UPDATE dsh_question_links SET question_version = 0'));
  assert.deepEqual(affectedRead.values, [config.profileId, id, 'a', 'c']);
  assert.deepEqual(invalidation.values.slice(0, 2), [config.profileId, id]);
  assert.deepEqual(new Set(invalidation.values.slice(2)), new Set([first.id, second.id]));
  assert.ok(pool.executions.indexOf(affectedRead) < pool.executions.indexOf(invalidation));
  assert.ok(pool.executions.indexOf(invalidation) < pool.executions.indexOf(tableDelete));
  assert.equal((await store.listQuestions(id)).find(question => question.id === first.id).links[0].questionVersion, 0);
  await assert.rejects(store.replaceQuestionLinks(id, [{ version: 1 }], [], context('reduced')), /所选问题已更新/);
  await assert.rejects(store.removeQuestion(undefined, 1), /问题已删除/);
});

test('空库、旧 schema、未知版本和不专用对象在 DML 前被拒绝', async t => {
  for (const [variant, expected] of [
    ['empty', /初始化 v6/], ['old', /重建/], ['future', /高于/], ['missing-column', /重建/], ['multiple-versions', /重建/],
    ['table', /非插件管理对象/], ['view', /非插件管理对象/], ['trigger', /非插件管理对象/],
    ['PROCEDURE', /非插件管理对象/], ['EVENT', /非插件管理对象/], ['CROSS_SCHEMA_FOREIGN_KEY', /非插件管理对象/],
  ]) {
    const pool = await managementFixture(t, variant !== 'empty');
    if (variant === 'old') pool.sqlite.exec('UPDATE dsh_management_migrations SET version = 3');
    if (variant === 'future') pool.sqlite.exec('UPDATE dsh_management_migrations SET version = 7');
    if (variant === 'multiple-versions') pool.sqlite.exec('INSERT INTO dsh_management_migrations (version) VALUES (4)');
    if (variant === 'missing-column') pool.sqlite.exec('ALTER TABLE dsh_questions DROP COLUMN answer');
    if (variant === 'table') pool.sqlite.exec('CREATE TABLE business_orders (id INTEGER)');
    if (variant === 'view') pool.sqlite.exec('CREATE VIEW business_orders AS SELECT 1 AS id');
    if (variant === 'trigger') pool.sqlite.exec('CREATE TRIGGER business_trigger AFTER INSERT ON dsh_questions BEGIN SELECT 1; END');
    if (['PROCEDURE', 'EVENT', 'CROSS_SCHEMA_FOREIGN_KEY'].includes(variant)) pool.objects.push({ name: 'business_object', type: variant });
    await assert.rejects(openManagementDb(config, { pool }), expected);
    assert.ok(pool.ended);
    assert.equal(pool.released, 1);
    assert.ok(!pool.calls.some(sql => mutation.test(sql)), variant);
  }
});

test('完整 v4 库仅提示无损增量升级，异常旧结构保留重建保护', async t => {
  for (const damaged of [false, true]) {
    const pool = await managementFixture(t);
    pool.sqlite.exec('DROP TABLE dsh_field_annotations; DROP TABLE dsh_table_annotations; ALTER TABLE dsh_questions DROP COLUMN origin; ALTER TABLE dsh_questions DROP COLUMN source_question_id; UPDATE dsh_management_migrations SET version = 4');
    if (damaged) pool.sqlite.exec('ALTER TABLE dsh_questions DROP COLUMN answer');
    const columns = pool.sqlite.prepare('PRAGMA table_info(dsh_questions)').all().map(row => row.name);
    const error = await openManagementDb(config, { pool }).catch(error => error);
    if (damaged) assert.match(error.message, /重建/);
    else {
      assert.match(error.message, /002-question-origin\.sql.*003-data-annotation\.sql.*增量升级至 v6/);
      assert.doesNotMatch(error.message, /reset-management|清理|重建/);
    }
    assert.deepEqual(pool.sqlite.prepare('PRAGMA table_info(dsh_questions)').all().map(row => row.name), columns);
    assert.ok(!pool.calls.some(sql => mutation.test(sql)));
  }
});

test('v4 到 v5 增量 SQL 检查版本并保留数据与单条版本记录', async t => {
  const sql = await sqlFile('migrations/002-question-origin.sql');
  assert.match(sql, /COUNT\(\*\) FROM dsh_management_migrations\) <> 1/);
  assert.match(sql, /COUNT\(\*\) FROM dsh_management_migrations WHERE version = 4\) <> 1/);
  assert.match(sql, /SIGNAL SQLSTATE '45000'/);
  assert.match(sql, /ADD COLUMN origin VARCHAR\(16\) NOT NULL DEFAULT 'unknown'/);
  assert.match(sql, /ADD COLUMN source_question_id VARCHAR\(128\) NULL/);
  assert.match(sql, /UPDATE dsh_management_migrations SET version = 5, applied_at = CURRENT_TIMESTAMP WHERE version = 4/);
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP TABLE|DROP DATABASE)\b|reset-management|INSERT INTO dsh_management_migrations/i);
  assert.match(sql, /CREATE ROUTINE \/ ALTER ROUTINE/);
  // Execute the guarded procedure's supported branch against the relational fixture.
  const pool = await managementFixture(t);
  pool.sqlite.exec('ALTER TABLE dsh_questions DROP COLUMN origin; ALTER TABLE dsh_questions DROP COLUMN source_question_id; UPDATE dsh_management_migrations SET version = 4');
  pool.sqlite.exec("INSERT INTO dsh_management_profiles VALUES ('test'); INSERT INTO dsh_questions (profile_id, question_id, question_text, answer, version, created_at, updated_at) VALUES ('test', 'historical', '历史问题', '', 1, 1, 1)");
  const alteration = sql.match(/ALTER TABLE dsh_questions[\s\S]*?;/)[0];
  for (const column of alteration.replace(/^ALTER TABLE dsh_questions\s*/, '').replace(/;$/, '').split(/,\s*(?=ADD COLUMN)/)) {
    pool.sqlite.exec(`ALTER TABLE dsh_questions ${column}`);
  }
  pool.sqlite.exec(sql.match(/UPDATE dsh_management_migrations SET[\s\S]*?;/)[0]);
  pool.sqlite.exec('UPDATE dsh_management_migrations SET version = 6');
  const db = await openManagementDb(config, { pool });
  const store = new MysqlFlowStore(db);
  const [legacy] = await store.listQuestions();
  assert.equal(legacy.text, '历史问题');
  assert.equal(legacy.origin, 'unknown');
  assert.equal(legacy.sourceQuestionId, null);
  const edited = await store.saveQuestion({ ...legacy, answer: '编辑旧记录', origin: 'original' });
  assert.equal(edited.origin, 'unknown');
  await assert.rejects(store.saveQuestions({ questions: [{ id: legacy.id, version: edited.version }], items: [{ text: '未知来源不能泛化' }] }), /仅原问题/);
  assert.deepEqual(pool.sqlite.prepare('SELECT version FROM dsh_management_migrations').all().map(row => row.version), [6]);
});

test('v5 管理库提示无损升级，迁移保留已有数据', async t => {
  const pool = await managementFixture(t);
  pool.sqlite.exec("DROP TABLE dsh_field_annotations; DROP TABLE dsh_table_annotations; UPDATE dsh_management_migrations SET version = 5; INSERT INTO dsh_management_profiles VALUES ('existing')");
  await assert.rejects(openManagementDb(config, { pool }), /003-data-annotation\.sql.*升级至 v6/);
  const sql = await sqlFile('migrations/003-data-annotation.sql');
  assert.match(sql, /COUNT\(\*\) FROM dsh_management_migrations WHERE version = 5/);
  for (const ddl of sql.match(/CREATE TABLE dsh_(?:table|field)_annotations[\s\S]*?ENGINE=InnoDB[^;]*;/g)) {
    pool.sqlite.exec(ddl.replace(/\) ENGINE=InnoDB[^;]*;/, ')'));
  }
  pool.sqlite.exec(sql.match(/UPDATE dsh_management_migrations SET[^;]*;/)[0]);
  await openManagementDb(config, { pool });
  assert.equal(pool.sqlite.prepare('SELECT profile_id FROM dsh_management_profiles').get().profile_id, 'existing');
});

test('标注的编辑确认、版本冲突、AI保护及字段清理', async t => {
  const { db, store, pool } = await mysqlStore(t);
  await store.saveSource(source('a'));
  const enabled = { ...table('t'), enabled: true };
  await applyCatalog(store, 'a', catalog('a', [enabled]));
  const annotations = createAnnotationStore({ db, store });
  let page = await annotations.catalog('a');
  assert.equal(page.summary.status, 'unannotated');
  assert.equal(page.summary.requiredCount, 2);
  assert.equal(page.summary.annotatedCount, 0);
  const act = (operation, kind, items) => annotations.action({ sourceId: 'a', revision: page.revision, operation, kind, items });
  const oldRevision = page.revision;
  page = await act('edit', 'table', [{ tableId: 't', text: '订单' }]);
  await assert.rejects(annotations.action({ sourceId: 'a', revision: oldRevision, operation: 'confirm', kind: 'table', items: [{ tableId: 't' }] }), /变化/);
  await assert.rejects(act('confirm', 'field', [{ tableId: 't', fieldName: 'id' }, { tableId: 't', fieldName: 'missing' }]), /空标注/);
  assert.equal((await annotations.catalog('a')).revision, page.revision);
  page = await act('confirm', 'table', [{ tableId: 't' }]);
  page = await act('edit', 'table', [{ tableId: 't', text: '订单' }]);
  assert.equal(page.tables[0].annotation.status, 'confirmed');
  page = await act('edit', 'field', [{ tableId: 't', fieldName: 'id', text: '编号' }]);
  assert.equal(page.summary.annotatedCount, 2);
  assert.equal(page.summary.status, 'partial');
  pool.sqlite.exec("INSERT INTO dsh_flow_bindings VALUES ('test', 'session', 'a', 0)");
  page = await annotations.aiSave({ sourceId: 'a', revision: page.revision, sessionId: 'session', kind: 'field', items: [{ tableId: 't', fieldName: 'id', text: 'AI编号' }] });
  page = await act('confirm', 'field', [{ tableId: 't', fieldName: 'id' }]);
  assert.equal(page.summary.status, 'complete');
  assert.equal(page.summary.annotatedCount, page.summary.requiredCount);
  await applyCatalog(store, 'a', catalog('rescan', [{ ...enabled, sourceComment: '新表备注', fields: [{ ...enabled.fields[0], sourceComment: '新字段备注' }] }]));
  page = await annotations.catalog('a');
  assert.equal(page.tables[0].annotation.status, 'pending');
  assert.equal(page.tables[0].fields[0].annotation.status, 'pending');
  page = await act('confirm', 'table', [{ tableId: 't' }]);
  page = await act('confirm', 'field', [{ tableId: 't', fieldName: 'id' }]);
  await assert.rejects(annotations.aiSave({ sourceId: 'a', revision: page.revision, sessionId: 'session', kind: 'field', items: [{ tableId: 't', fieldName: 'id', text: '覆盖' }] }), /已确认/);
  const timestamp = page.tables[0].fields[0].annotation.updatedAt;
  page = await act('enable', 'field', [{ tableId: 't', fieldName: 'id', enabled: false }]);
  assert.equal(page.tables[0].fields[0].annotation.updatedAt, timestamp);
  await assert.rejects(annotations.aiSave({ sourceId: 'a', revision: page.revision, sessionId: 'session', kind: 'field', items: [{ tableId: 't', fieldName: 'id', text: '覆盖' }] }), /禁用/);
  await db.transaction(connection => syncAnnotations(connection, db.profileId, { id: 'a', catalog: { tables: [enabled] } }, { id: 'a', catalog: { tables: [{ ...enabled, fields: [] }] } }));
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS n FROM dsh_field_annotations').get().n, 0);
});

test('合法 schema 启动只读，后续出现额外对象会阻止写入', async t => {
  const { pool, db, store } = await mysqlStore(t);
  await store.initialize();
  assert.ok(!pool.calls.some(sql => mutation.test(sql)));
  await store.saveSource(source('only'));
  await applyCatalog(store, 'only', catalog('data', [table('table')]));
  const previous = await store.get('only'), offset = pool.calls.length;
  const reopened = await openManagementDb(config, { pool });
  assert.deepEqual(await new MysqlFlowStore(reopened).get('only'), previous);
  assert.ok(!pool.calls.slice(offset).some(sql => mutation.test(sql)));
  pool.sqlite.exec('CREATE TABLE business_orders (id INTEGER)');
  await assert.rejects(store.saveSource(source('second')), /非插件管理对象/);
  assert.ok(!pool.calls.slice(offset).some(sql => mutation.test(sql)));
  assert.equal((await store.listSources()).length, 1);
  await db.close();
  assert.equal(pool.ended, true);
});

test('初始化及重建 SQL 限定十张 v6 表和明确的历史插件表', async t => {
  const init = await sqlFile('migrations/001-management.sql');
  const reset = await sqlFile('scripts/reset-management.sql');
  const create = statements(init), drop = statements(reset);
  assert.equal(create.length, 11);
  assert.deepEqual(create.slice(0, -1).map(sql => sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]).sort(), [...finalTables].sort());
  assert.match(create.at(-1), /^INSERT IGNORE INTO dsh_management_migrations \(version\) VALUES \(6\)$/);
  assert.deepEqual(drop.map(sql => sql.match(/^DROP TABLE IF EXISTS (\w+)$/)?.[1]).sort(), [...finalTables, ...retiredTables].sort());
  const pool = await managementFixture(t);
  pool.sqlite.exec('CREATE TABLE dsh_unrelated (id INTEGER); CREATE TABLE business_orders (id INTEGER)');
  pool.apply();
  assert.equal(pool.sqlite.prepare('SELECT COUNT(*) AS count FROM dsh_management_migrations').get().count, 1);
  for (const sql of drop) pool.sqlite.exec(sql);
  assert.deepEqual(pool.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['business_orders', 'dsh_unrelated']);
  assert.doesNotMatch([...create, ...drop].join('\n'), /DROP DATABASE|CREATE DATABASE|FOREIGN_KEY_CHECKS|\bUSE\s+\w+/i);
});

test('源与问题按 profile 隔离，多表更新失败时回滚', async t => {
  const { pool, db, store } = await mysqlStore(t);
  const other = new MysqlFlowStore({ ...db, profileId: 'another' });
  await store.saveSource(source('only')); await other.saveSource(source('only'));
  await store.saveQuestion({ text: '问题' }); await other.saveQuestion({ text: '问题' });
  const before = await store.get('only');
  pool.fail = sql => sql.startsWith('INSERT INTO dsh_source_tables');
  await assert.rejects(applyCatalog(store, 'only', catalog('data', [table('a')])), /fixture failure/);
  pool.fail = null;
  assert.deepEqual(await store.get('only'), before);
  await applyCatalog(store, 'only', catalog('data', [table('a')]));
  assert.equal((await other.get('only')).catalog, null);
  assert.notEqual((await store.listQuestions())[0].id, (await other.listQuestions())[0].id);
});
