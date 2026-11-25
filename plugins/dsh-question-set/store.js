import { randomUUID } from 'node:crypto';

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = value => new Date(Number(value)).toISOString();
const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { publicMessage: message, status }); };
const id = value => { if (typeof value !== 'string' || !value || value.length > 128) fail('问题 ID 无效。', 400); return value; };
function body(input) {
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 2000) fail('问题不能为空或超出长度限制。', 400);
  const answer = input.answer ?? '';
  if (typeof answer !== 'string' || answer.length > 10000) fail('答案格式无效或超出长度限制。', 400);
  return { text: input.text.trim(), answer: answer.trim() };
}
const readQuestion = row => ({ id: row.question_id, text: row.question_text, answer: row.answer, version: Number(row.version), origin: row.origin ?? 'unknown', sourceQuestionId: row.source_question_id ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
function unique(questions, question) {
  if (questions.some(item => item.id !== question.id && normalized(item.text) === normalized(question.text))) fail('该问题已存在。');
}
function currentQuestion(questions, reference) {
  id(reference?.id);
  const question = questions.find(item => item.id === reference.id);
  if (!question) fail('该问题已删除，请刷新后重试。', 404);
  if (reference.version !== question.version) fail('问题已更新，请刷新后重试。');
  return question;
}

/** Independent access to the existing schema-v7 question tables. Never creates tables. */
export function createQuestionStore(db) {
  const scope = db.profileId;
  async function lock(connection) {
    await connection.execute('INSERT INTO dsh_management_profiles (profile_id) VALUES (?) ON DUPLICATE KEY UPDATE profile_id = VALUES(profile_id)', [scope]);
  }
  async function questions(connection, locked = false) {
    const [rows] = await connection.execute(`SELECT * FROM dsh_questions WHERE profile_id = ?${locked ? ' FOR UPDATE' : ''}`, [scope]);
    return rows.map(readQuestion);
  }
  async function clock(connection) {
    const [[row]] = await connection.query('SELECT UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS now_ms');
    return Number(row.now_ms);
  }
  async function write(connection, question, exists) {
    const values = [question.text, question.answer, question.version, Date.parse(question.createdAt), Date.parse(question.updatedAt), question.origin, question.sourceQuestionId];
    if (exists) await connection.execute('UPDATE dsh_questions SET question_text = ?, answer = ?, version = ?, created_at = ?, updated_at = ?, origin = ?, source_question_id = ? WHERE profile_id = ? AND question_id = ?', [...values, scope, question.id]);
    else await connection.execute('INSERT INTO dsh_questions (question_text, answer, version, created_at, updated_at, origin, source_question_id, profile_id, question_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [...values, scope, question.id]);
  }
  async function list(connection) {
    const items = await questions(connection);
    const [links] = await connection.execute('SELECT * FROM dsh_question_links WHERE profile_id = ? ORDER BY source_id, table_id', [scope]);
    const [sources] = await connection.execute('SELECT * FROM dsh_sources WHERE profile_id = ?', [scope]);
    const [tables] = await connection.execute('SELECT * FROM dsh_source_tables WHERE profile_id = ?', [scope]);
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(question => ({ ...question, links: links.filter(link => link.question_id === question.id).map(link => {
      const source = sources.find(row => row.source_id === link.source_id), table = tables.find(row => row.source_id === link.source_id && row.table_id === link.table_id);
      const fields = json(link.fields), names = new Set((table ? json(table.fields) : []).map(field => field.name));
      return { sourceId: link.source_id, tableId: link.table_id, fields, reason: link.reason, questionVersion: Number(link.question_version), structureHash: link.structure_hash, analyzedAt: iso(link.analyzed_at), sourceName: source ? json(source.metadata).name : '', tableName: table?.table_name ?? '', schema: table?.schema_name ?? '', valid: Boolean(source?.enabled && table?.enabled && table.table_kind === 'table' && link.structure_hash === table.structure_hash && Number(link.question_version) === question.version && Array.isArray(fields) && fields.every(field => names.has(field))) };
    }) }));
  }
  async function replaceLinks(connection, question, input, sourceId, now, catalog) {
    if (!Array.isArray(input) || !input.length) fail('已查询的答案必须关联至少一张表。', 400);
    const seen = new Set();
    const links = input.map(link => {
      const table = catalog.find(table => table.table_id === link?.tableId);
      if (!table || !table.enabled || table.table_kind !== 'table' || seen.has(table.table_id) || (link.sourceId !== undefined && link.sourceId !== sourceId) || link.structureHash !== table.structure_hash || !Array.isArray(link.fields) || new Set(link.fields).size !== link.fields.length || link.fields.some(field => !json(table.fields).some(item => item.name === field)) || (link.reason !== undefined && typeof link.reason !== 'string')) fail('表结构或问题关联已变化，请重新查询。');
      seen.add(table.table_id);
      return { tableId: table.table_id, fields: link.fields, structureHash: table.structure_hash, reason: link.reason ?? '' };
    });
    // An answer is based on one fixed source; replace all prior answer provenance.
    await connection.execute('DELETE FROM dsh_question_links WHERE profile_id = ? AND question_id = ?', [scope, question.id]);
    for (const link of links) await connection.execute('INSERT INTO dsh_question_links (profile_id, question_id, source_id, table_id, fields, reason, question_version, structure_hash, analyzed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [scope, question.id, sourceId, link.tableId, JSON.stringify(link.fields), link.reason, question.version, link.structureHash, now]);
  }
  return {
    list() { return db.transaction(connection => list(connection), { readOnly: true }); },
    save(input) {
      return db.transaction(async connection => {
        await lock(connection);
        const all = await questions(connection, true), current = input?.id === undefined ? undefined : currentQuestion(all, input);
        const value = body(input), now = await clock(connection);
        const textChanged = current && value.text !== current.text;
        if (textChanged && value.answer === current.answer) value.answer = '';
        const changed = !current || current.text !== value.text || current.answer !== value.answer;
        const question = changed ? { id: current?.id ?? randomUUID(), ...value, origin: current?.origin ?? (current ? 'unknown' : 'original'), sourceQuestionId: current?.sourceQuestionId ?? null, version: (current?.version ?? 0) + 1, createdAt: current?.createdAt ?? iso(now), updatedAt: iso(now) } : current;
        unique(all, question);
        if (changed) await write(connection, question, Boolean(current));
        if (textChanged) await connection.execute('DELETE FROM dsh_question_links WHERE profile_id = ? AND question_id = ?', [scope, question.id]);
        return (await list(connection)).find(item => item.id === question.id);
      });
    },
    remove(input) {
      return db.transaction(async connection => {
        await lock(connection);
        currentQuestion(await questions(connection, true), input);
        await connection.execute('DELETE FROM dsh_question_links WHERE profile_id = ? AND question_id = ?', [scope, input.id]);
        await connection.execute('DELETE FROM dsh_questions WHERE profile_id = ? AND question_id = ?', [scope, input.id]);
        return { id: input.id, removed: true };
      });
    },
    commit({ references, updates = [], candidates = [], sourceId, connectionVersion } = {}) {
      return db.transaction(async connection => {
        if (!Array.isArray(references) || !references.length || !Array.isArray(updates) || !Array.isArray(candidates) || candidates.length > 20 || (!updates.length && !candidates.length)) fail('请选择参考问题和要保存的结果。', 400);
        await lock(connection);
        const [[source]] = await connection.execute('SELECT * FROM dsh_sources WHERE profile_id = ? AND source_id = ? FOR UPDATE', [scope, sourceId ?? null]);
        if (!source?.enabled) fail('数据源已停用或删除。');
        if (connectionVersion !== undefined && connectionVersion !== Number(source.connection_version)) fail('数据源连接已变化，请重新查询。');
        const [catalog] = await connection.execute('SELECT * FROM dsh_source_tables WHERE profile_id = ? AND source_id = ?', [scope, sourceId]);
        const all = await questions(connection, true), seen = new Set();
        for (const reference of references) {
          if (seen.has(reference?.id)) fail('所选问题重复。', 400);
          currentQuestion(all, reference); seen.add(reference.id);
        }
        const now = await clock(connection), modified = [], created = [], updateIds = new Set();
        for (const input of updates) {
          const current = currentQuestion(all, input);
          if (!seen.has(current.id) || updateIds.has(current.id)) fail('更新问题必须属于参考问题且不能重复。', 400);
          updateIds.add(current.id);
          const question = { ...current, ...body(input), version: current.version + 1, updatedAt: iso(now) };
          unique(all, question);
          all.splice(all.indexOf(current), 1, question);
          await write(connection, question, true);
          await replaceLinks(connection, question, input.links, sourceId, now, catalog);
          modified.push(question.id);
        }
        for (const input of candidates) {
          const question = { id: randomUUID(), ...body(input), origin: 'generated', sourceQuestionId: references.length === 1 ? references[0].id : null, version: 1, createdAt: iso(now), updatedAt: iso(now) };
          unique(all, question); all.push(question);
          await write(connection, question, false);
          await replaceLinks(connection, question, input.links, sourceId, now, catalog);
          created.push(question.id);
        }
        // Source/table writers use the same source row lock, so validation and links commit together.
        const result = await list(connection);
        return { updates: modified.map(id => result.find(item => item.id === id)), candidates: created.map(id => result.find(item => item.id === id)) };
      });
    },
  };
}
