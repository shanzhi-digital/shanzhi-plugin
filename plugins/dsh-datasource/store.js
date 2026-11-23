import {
  assertActiveBinding, assertSourceRevision, assertUniqueName, assertUniqueQuestion, assertVersions, buildLinks,
  conflict, emptyState, newQuestions, nextBinding, nextQuestion, nextSource, nextSourceEnabled, projectQuestionAnalysis, projectState,
  pruneQuestionAnalyses, snapshotVersions, updateQuestionAnalysisContext,
} from './flow-store.js';

/** Isolated in-memory store for tests. Production uses MysqlFlowStore. */
export class DatasourceStore {
  #sources = new Map();
  #states = new Map();
  #questions = new Map();
  #links = [];
  #bindings = new Map();
  #tail = Promise.resolve();
  #now;

  constructor({ now = Date.now } = {}) { this.#now = now; }
  async initialize() { }

  #write(work) {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }

  async listSources() {
    return [...this.#sources.values()].map(source => ({ ...source,
      tableCount: this.#states.get(source.id)?.catalog?.tables.length ?? null }));
  }

  async getSource(id) { return structuredClone(this.#sources.get(id)); }

  #retireSourceBindings(id) {
    for (const [sessionId, binding] of this.#bindings) {
      if (binding.sourceId === id && !binding.retired) this.#bindings.set(sessionId, { sourceId: id, retired: true });
    }
  }

  async saveSource(record, revision, { credentialChanged = false } = {}) {
    return this.#write(() => {
      const current = this.#sources.get(record.id);
      assertSourceRevision(current, revision);
      const { source, targetChanged, connectionChanged } = nextSource(record, current, this.#now(), credentialChanged);
      assertUniqueName([...this.#sources.values()], source);
      this.#sources.set(source.id, source);
      if (targetChanged) {
        this.#states.delete(source.id);
        this.#links = this.#links.filter(link => link.sourceId !== source.id);
      }
      if (connectionChanged) this.#retireSourceBindings(source.id);
      return { ...source };
    });
  }

  async setSourceEnabled(id, enabled, revision) {
    return this.#write(() => {
      const source = nextSourceEnabled(this.#sources.get(id), enabled, revision, this.#now());
      this.#sources.set(id, source);
      if (!source.enabled) this.#retireSourceBindings(id);
      return { ...source };
    });
  }

  async removeSource(id, revision) {
    return this.#write(() => {
      const source = this.#sources.get(id);
      if (!source) conflict('未找到该数据源。', 404);
      assertSourceRevision(source, revision);
      this.#sources.delete(id);
      this.#states.delete(id);
      this.#links = this.#links.filter(link => link.sourceId !== id);
      this.#retireSourceBindings(id);
      return { ...source };
    });
  }

  #readState(source) {
    return pruneQuestionAnalyses(structuredClone({ ...(this.#states.get(source.id) ?? emptyState(source)), connectionVersion: source.connectionVersion }), [...this.#questions.values()]);
  }

  async get(id) {
    const source = this.#sources.get(id);
    return source && structuredClone(this.#readState(source));
  }

  async change(id, callback) {
    return this.#write(async () => {
      const source = this.#sources.get(id);
      if (!source) conflict('未找到该数据源。', 404);
      const before = this.#readState(source);
      const now = this.#now();
      let links = this.#links;
      let questions = this.#questions;
      const analysisUpdates = [];
      const saveQuestions = async input => {
        const created = newQuestions(input, [...questions.values()], now);
        questions = new Map(questions);
        for (const question of created) questions.set(question.id, question);
        return structuredClone(created.map(question => ({ ...question, links: [] })));
      };
      const assertQuestionVersions = async snapshots => {
        const versions = snapshotVersions(snapshots);
        const matches = [...versions.keys()].map(key => questions.get(key)).filter(Boolean);
        assertVersions(matches, versions);
        return versions;
      };
      const replaceQuestionLinks = async (snapshots, proposed, context) => {
        const versions = await assertQuestionVersions(snapshots);
        const replacements = buildLinks(before, source, versions, proposed, context, now);
        analysisUpdates.push({ versions, links: replacements, context });
        links = [...links.filter(link => link.sourceId !== id || !versions.has(link.questionId)), ...replacements];
      };
      const assertSessionBinding = async sessionId => assertActiveBinding(this.#bindings.get(sessionId), id);
      const callbackState = structuredClone(before);
      const { state, result } = await callback(callbackState, { ...source }, now,
        { assertQuestionVersions, replaceQuestionLinks, assertSessionBinding, saveQuestions });
      if (state !== undefined || analysisUpdates.length) {
        const persisted = projectState(state ?? structuredClone(before), source);
        for (const update of analysisUpdates) updateQuestionAnalysisContext(persisted, update.versions, update.links, update.context);
        pruneQuestionAnalyses(persisted, [...questions.values()]);
        if (persisted.domainContext !== before.domainContext) persisted.revision = Math.max(persisted.revision, before.revision + 1);
        const tables = new Map((persisted.catalog?.tables ?? []).map(table => [table.id, table.structureHash]));
        const affectedQuestions = new Set(links.filter(link => link.sourceId === id
          && (!tables.has(link.tableId) || tables.get(link.tableId) !== link.structureHash)).map(link => link.questionId));
        links = links.map(link => link.sourceId === id && affectedQuestions.has(link.questionId) ? { ...link, questionVersion: 0 } : link)
          .filter(link => link.sourceId !== id || (tables.has(link.tableId) && tables.get(link.tableId) === link.structureHash));
        this.#states.set(id, structuredClone(persisted));
        Object.assign(callbackState, persisted);
        if (state !== undefined && state !== callbackState) Object.assign(state, persisted);
      }
      this.#links = structuredClone(links);
      this.#questions = questions;
      return result;
    });
  }

  replaceQuestionLinks(id, snapshots, links, context) {
    return this.change(id, async (_state, _source, _now, work) => {
      await work.replaceQuestionLinks(snapshots, links, context);
      return {};
    });
  }

  #questionWithLinks(question, sourceId) {
    const links = this.#links.filter(link => link.questionId === question.id && (sourceId === undefined || sourceId === link.sourceId))
      .map(({ questionId, ...link }) => link);
    const result = { ...question, links };
    const source = this.#sources.get(sourceId);
    return structuredClone(sourceId === undefined ? result : projectQuestionAnalysis(result, source && this.#readState(source)));
  }

  async listQuestions(sourceId) { return [...this.#questions.values()].map(question => this.#questionWithLinks(question, sourceId)); }

  async saveQuestion(input) {
    return this.#write(() => {
      const question = nextQuestion(input, this.#questions.get(input.id), this.#now());
      assertUniqueQuestion([...this.#questions.values()], question);
      this.#questions.set(question.id, question);
      return this.#questionWithLinks(question);
    });
  }

  async saveQuestions(input) {
    return this.#write(() => {
      const created = newQuestions(input, [...this.#questions.values()], this.#now());
      for (const question of created) this.#questions.set(question.id, question);
      return created.map(question => this.#questionWithLinks(question));
    });
  }

  async removeQuestion(id, version) {
    return this.#write(() => {
      const question = this.#questions.get(id);
      if (!question) conflict('该问题已删除，请刷新后重试。', 404);
      if (question.version !== version) conflict('问题已更新，请刷新后重试。');
      this.#questions.delete(id);
      this.#links = this.#links.filter(link => link.questionId !== id);
    });
  }

  async findBinding(sessionId) { return structuredClone(this.#bindings.get(sessionId)); }

  async bindSession(sessionId, binding) {
    return this.#write(() => {
      const next = nextBinding(sessionId, binding, this.#bindings.get(sessionId), this.#sources.get(binding?.sourceId));
      this.#bindings.set(sessionId, next);
      return !next.retired;
    });
  }

  async retireSession(sessionId) {
    return this.#write(() => {
      const binding = this.#bindings.get(sessionId);
      if (binding && !binding.retired) this.#bindings.set(sessionId, { ...binding, retired: true });
    });
  }
}
