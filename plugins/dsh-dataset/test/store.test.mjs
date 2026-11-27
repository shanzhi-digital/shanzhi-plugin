import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createQuestionStore } from '../store.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE dsh_management_profiles(profile_id TEXT PRIMARY KEY);
    CREATE TABLE dsh_questions(profile_id TEXT, question_id TEXT, question_text TEXT, answer TEXT, version INTEGER, created_at INTEGER, updated_at INTEGER, origin TEXT, source_question_id TEXT, PRIMARY KEY(profile_id,question_id));
    CREATE TABLE dsh_question_links(profile_id TEXT,question_id TEXT,source_id TEXT,table_id TEXT,fields TEXT,reason TEXT,question_version INTEGER,structure_hash TEXT,analyzed_at INTEGER, PRIMARY KEY(profile_id,question_id,source_id,table_id));
    CREATE TABLE dsh_sources(profile_id TEXT,source_id TEXT,metadata TEXT,enabled INTEGER,connection_version INTEGER);
    CREATE TABLE dsh_source_tables(profile_id TEXT,source_id TEXT,table_id TEXT,table_name TEXT,source_comment TEXT,schema_name TEXT,table_kind TEXT,enabled INTEGER,fields TEXT,structure_hash TEXT);
    INSERT INTO dsh_sources VALUES ('p','s','{"name":"业务库"}',1,1);
    INSERT INTO dsh_source_tables VALUES ('p','s','t','sales','销售流水','main','table',1,'[{"name":"amount"}]','hash');`);
  const connection = {
    async execute(input, params = []) {
      const sql = input.replace(/ FOR UPDATE/g, '').replace('INSERT INTO dsh_management_profiles (profile_id) VALUES (?) ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id)', 'INSERT OR IGNORE INTO dsh_management_profiles (profile_id) VALUES (?)');
      const statement = sqlite.prepare(sql);
      return [/^SELECT/i.test(sql) ? statement.all(...params) : statement.run(...params)];
    },
    async query() { return [[{ now_ms: Date.now() }]]; },
  };
  const db = { profileId: 'p', pool: connection, async transaction(work) { sqlite.exec('BEGIN'); try { const result = await work(connection); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  return { sqlite, store: createQuestionStore(db) };
}
const link = () => [{ tableId: 't', fields: ['amount'], structureHash: 'hash' }];

test('CRUD preserves provenance, checks versions and normalized duplicates, and clears changed-text answers/links', async t => {
  const { sqlite, store } = fixture(); t.after(() => sqlite.close());
  const original = await store.save({ text: ' 销售 总额 ', answer: '原答案', origin: 'generated', sourceQuestionId: 'forged' });
  assert.equal(original.origin, 'original'); assert.equal(original.sourceQuestionId, null);
  await assert.rejects(store.save({ text: '销售   总额' }), /已存在/);
  const result = await store.commit({ sourceId: 's', references: [original], updates: [{ ...original, answer: '100', links: link() }], candidates: [{ text: '每月销售', answer: '20', links: link() }] });
  const generated = result.candidates[0];
  assert.equal(generated.origin, 'generated'); assert.equal(generated.sourceQuestionId, original.id);
  assert.equal(result.updates[0].links[0].valid, true);
  assert.equal(result.updates[0].links[0].sourceName, '业务库');
  assert.equal(result.updates[0].links[0].tableName, 'sales');
  assert.equal(result.updates[0].links[0].sourceComment, '销售流水');
  sqlite.exec('UPDATE dsh_source_tables SET source_comment = NULL');
  assert.equal((await store.list()).find(item => item.id === original.id).links[0].sourceComment, '');
  const edited = await store.save({ ...generated, text: '每周销售' });
  assert.equal(edited.answer, ''); assert.deepEqual(edited.links, []); assert.equal(edited.origin, 'generated');
  const answered = await store.save({ ...result.updates[0], text: '季度销售', answer: '用户新填的答案' });
  assert.equal(answered.answer, '用户新填的答案'); assert.deepEqual(answered.links, []);
  await assert.rejects(store.remove({ id: edited.id, version: 1 }), /已更新/);
  await store.remove(edited); assert.equal((await store.list()).length, 1);
});

test('commit is atomic across stale references, duplicate candidates and forged or changed links', async t => {
  const { sqlite, store } = fixture(); t.after(() => sqlite.close());
  const original = await store.save({ text: '销售' });
  const base = { sourceId: 's', connectionVersion: 1, references: [original], updates: [{ ...original, answer: '100', links: link() }], candidates: [{ text: '月销售', answer: '10', links: link() }] };
  sqlite.exec('UPDATE dsh_sources SET connection_version=2');
  await assert.rejects(store.commit(base), /连接已变化/);
  assert.equal((await store.list())[0].version, 1);
  sqlite.exec('UPDATE dsh_sources SET connection_version=1');
  await assert.rejects(store.commit({ ...base, references: [{ ...original, version: 99 }] }), /已更新/);
  await assert.rejects(store.commit({ ...base, candidates: [{ text: '销售', answer: '10', links: link() }] }), /已存在/);
  assert.equal((await store.list())[0].version, 1);
  await assert.rejects(store.commit({ ...base, candidates: [{ text: '月销售', answer: '10', links: [{ ...link()[0], fields: ['secret'] }] }] }), /关联已变化/);
  await assert.rejects(store.commit({ ...base, candidates: [{ text: '月销售', answer: '10', links: [{ ...link()[0], structureHash: 'fake' }] }] }), /关联已变化/);
  assert.equal((await store.list())[0].answer, '');
  const { candidates } = await store.commit(base);
  const child = await store.commit({ sourceId: 's', references: [candidates[0]], candidates: [{ text: '周销售', answer: '5', links: link() }] });
  assert.equal(child.candidates[0].sourceQuestionId, candidates[0].id);
  sqlite.exec("UPDATE dsh_source_tables SET structure_hash='changed'");
  assert.equal((await store.list()).find(item => item.id === candidates[0].id).links[0].valid, false);
  await assert.rejects(store.commit({ sourceId: 's', references: [child.candidates[0]], candidates: [{ text: '日销售', answer: '1', links: link() }] }), /关联已变化/);
});

test('multi-reference generated questions have no false parent and all references are checked', async t => {
  const { sqlite, store } = fixture(); t.after(() => sqlite.close());
  const a = await store.save({ text: 'a' }), b = await store.save({ text: 'b' });
  const result = await store.commit({ sourceId: 's', references: [a, b], candidates: [{ text: 'c', answer: '1', links: link() }] });
  assert.equal(result.candidates[0].sourceQuestionId, null);
  await store.save({ ...b, answer: 'updated' });
  await assert.rejects(store.commit({ sourceId: 's', references: [a, b], updates: [{ ...a, answer: '2', links: link() }] }), /已更新/);
  assert.equal((await store.list()).find(item => item.id === a.id).answer, '');
});

test('original questions precede other origins, newest creation first with stable ID ties', async t => {
  const { sqlite, store } = fixture(); t.after(() => sqlite.close());
  const insert = sqlite.prepare('INSERT INTO dsh_questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, origin, created] of [
    ['ai-old', 'generated', 3000], ['original-old', 'original', 1000],
    ['ai-new', 'generated', 5000], ['original-b', 'original', 2000],
    ['unknown', 'unknown', 4000], ['original-a', 'original', 2000],
  ]) insert.run('p', id, id, '', 1, created, created, origin, null);
  const expected = ['original-a', 'original-b', 'original-old', 'ai-new', 'unknown', 'ai-old'];
  assert.deepEqual((await store.list()).map(item => item.id), expected);
  const older = (await store.list()).find(item => item.id === 'original-old');
  const edited = await store.save({ ...older, answer: '手动答案' });
  assert.equal(edited.createdAt, older.createdAt);
  assert.deepEqual((await store.list()).map(item => item.id), expected);
  await store.commit({ sourceId: 's', references: [edited], updates: [{ ...edited, answer: '查询后答案', links: link() }] });
  assert.deepEqual((await store.list()).map(item => item.id), expected);
  const newest = await store.save({ text: '最新原问题' });
  assert.deepEqual((await store.list()).map(item => item.id), [newest.id, ...expected]);
});
