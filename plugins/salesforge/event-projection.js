// 会话事件投影（与 client.js 里浏览器端的投影保持一致，单测用它核对）。
// 关心两件事：本回合有没有工具返回「需要连接账户」（kind = salesforge-auth-required），有就在回合末尾显示授权卡片；
// 有没有生成日报草稿（kind = salesforge-report-draft），有就显示草稿卡片，并按会话里的「已提交」记录标出已提交的草稿；
// 有没有发起删除或移交（kind = salesforge-action-pending），有就显示确认卡片，并按会话里的执行记录标出结果。
export const KEY = 'salesforge';
export const AUTH_REQUIRED_KIND = 'salesforge-auth-required';
export const REPORT_DRAFT_KIND = 'salesforge-report-draft';
export const REPORT_SUBMITTED_RECORD_TYPE = 'plugin:salesforge/report-submitted';
export const ACTION_PENDING_KIND = 'salesforge-action-pending';
export const ACTION_RECORD_TYPE = 'plugin:salesforge/action-done';
const RECORD_TYPES = [REPORT_SUBMITTED_RECORD_TYPE, ACTION_RECORD_TYPE];

const within = (seq, ranges) =>
  typeof seq === 'number' && ranges.some((range) => seq >= range.startSeq && seq <= range.endSeq);

const callIdentity = (event) =>
  event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? event.data?.callId;

const failed = (value) =>
  Boolean(
    value &&
      typeof value === 'object' &&
      ((value.error != null && value.error !== false) || value.isError || failed(value.message) || failed(value.result)),
  );

const CARD_KINDS = [AUTH_REQUIRED_KIND, REPORT_DRAFT_KIND, ACTION_PENDING_KIND];

function extractPayload(value) {
  if (typeof value === 'string') {
    // 每个工具结果都要检查，先排除不可能带本插件卡片内容的文本，省掉解析。
    if (!CARD_KINDS.some((kind) => value.includes(kind))) return null;
    try {
      return extractPayload(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || failed(value)) return null;
  if (CARD_KINDS.includes(value.kind)) return value;
  for (const key of ['structuredContent', 'value', 'result', 'message']) {
    if (value[key] != null) {
      const found = extractPayload(value[key]);
      if (found) return found;
    }
  }
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const found = extractPayload(block.text);
        if (found) return found;
      }
    }
  }
  return null;
}

const valueOf = (state) => ({
  turn: state.turn,
  authRequired: state.authRequired,
  reportDrafts: state.reportDrafts,
  submittedByDraftId: state.submittedByDraftId,
  pendingActions: state.pendingActions,
  actionStatusById: state.actionStatusById,
});

function refresh(state) {
  let authRequired = null;
  const reportDrafts = [];
  const pendingActions = [];
  for (const [callId, call] of state.calls) {
    const result = state.results.get(callId);
    if (!result || result.failed || !result.payload) continue;
    const payload = result.payload;
    if (payload.kind === REPORT_DRAFT_KIND) {
      if (typeof payload.draftId === 'string' && payload.draft && typeof payload.draft === 'object') {
        reportDrafts.push({
          seq: result.seq,
          callId,
          draftId: payload.draftId,
          draft: payload.draft,
          contacts: Array.isArray(payload.contacts) ? payload.contacts : [],
          notes: Array.isArray(payload.notes) ? payload.notes.filter((note) => typeof note === 'string' && note) : [],
        });
      }
      continue;
    }
    if (payload.kind === ACTION_PENDING_KIND) {
      if (typeof payload.actionId === 'string' && Array.isArray(payload.items) && payload.items.length) {
        pendingActions.push({
          seq: result.seq,
          callId,
          actionId: payload.actionId,
          action: payload.action === 'transfer' ? 'transfer' : 'delete',
          title: typeof payload.title === 'string' ? payload.title : '',
          typeLabel: typeof payload.typeLabel === 'string' ? payload.typeLabel : '',
          items: payload.items.filter((item) => item && typeof item === 'object'),
          toUser: payload.toUser && typeof payload.toUser === 'object' ? payload.toUser : null,
          includeProjects: payload.includeProjects === true,
          skipped: Array.isArray(payload.skipped) ? payload.skipped.filter((item) => item && typeof item === 'object') : [],
        });
      }
      continue;
    }
    // 一个回合只显示一张授权卡片，取最后一次。
    if (!authRequired || (result.seq ?? 0) >= (authRequired.seq ?? 0)) {
      authRequired = {
        seq: result.seq,
        callId,
        toolName: call.name,
        reason: typeof payload.reason === 'string' ? payload.reason : 'no-account',
        message: typeof payload.message === 'string' ? payload.message : '',
        serverUrl: typeof payload.serverUrl === 'string' ? payload.serverUrl : '',
      };
    }
  }
  reportDrafts.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  pendingActions.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const submittedByDraftId = {};
  const actionStatusById = {};
  for (const record of state.records) {
    if (record.type === ACTION_RECORD_TYPE) {
      if (typeof record.data?.actionId === 'string' && typeof record.data.status === 'string') {
        actionStatusById[record.data.actionId] = {
          status: record.data.status,
          results: Array.isArray(record.data.results) ? record.data.results : [],
          transferredCount: record.data.transferredCount ?? null,
          projectCount: record.data.projectCount ?? null,
        };
      }
      continue;
    }
    if (typeof record.data?.draftId === 'string') {
      const report = record.data.report;
      submittedByDraftId[record.data.draftId] = {
        reportId: record.data.reportId ?? null,
        report: report && typeof report === 'object' && !Array.isArray(report) ? report : null,
      };
    }
  }
  const next = { ...state, authRequired, reportDrafts, submittedByDraftId, pendingActions, actionStatusById };
  return { ...next, value: valueOf(next) };
}

function initial(turn) {
  const state = {
    turn,
    calls: new Map(),
    results: new Map(),
    records: [],
    invalidated: new Set(),
    replacedRanges: [],
    authRequired: null,
    reportDrafts: [],
    submittedByDraftId: {},
    pendingActions: [],
    actionStatusById: {},
  };
  return { ...state, value: valueOf(state) };
}

function updateState(state, event) {
  if (!state || (event.data?.turn != null && event.data.turn !== state.turn)) return state;

  if (event.surfaceOp?.op === 'replace') {
    const { startSeq, endSeq } = event.surfaceOp;
    if (typeof startSeq !== 'number' || typeof endSeq !== 'number' || startSeq > endSeq) return state;
    const range = { startSeq, endSeq };
    const invalidated = new Set(state.invalidated);
    for (const [callId, call] of state.calls) {
      if (within(call.callSeq, [range]) || within(state.results.get(callId)?.seq, [range])) invalidated.add(callId);
    }
    const keep = (map) => new Map([...map].filter(([id]) => !invalidated.has(id)));
    return refresh({
      ...state,
      calls: keep(state.calls),
      results: keep(state.results),
      records: state.records.filter((record) => !within(record.seq, [range])),
      invalidated,
      replacedRanges: [...state.replacedRanges, range],
    });
  }

  if (RECORD_TYPES.includes(event.type)) {
    if (within(event.seq, state.replacedRanges) || state.records.some((record) => record.seq === event.seq)) return state;
    return refresh({ ...state, records: [...state.records, { seq: event.seq, type: event.type, data: event.data }] });
  }

  if (event.type === 'tool/call') {
    // 所有工具的调用都记下：任何一个都可能返回授权提示。
    const { callId, name } = event.data || {};
    if (
      typeof name !== 'string' ||
      !name ||
      typeof callId !== 'string' ||
      !callId ||
      state.calls.has(callId) ||
      state.invalidated.has(callId) ||
      within(event.seq, state.replacedRanges)
    ) {
      return state;
    }
    return refresh({ ...state, calls: new Map([...state.calls, [callId, { callSeq: event.seq, name }]]) });
  }

  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state;
  const callId = callIdentity(event);
  const call = state.calls.get(callId);
  if (!call || state.results.has(callId) || state.invalidated.has(callId)) return state;
  if (within(event.seq, state.replacedRanges) || within(call.callSeq, state.replacedRanges)) return state;
  if (typeof event.seq === 'number' && event.seq <= call.callSeq) return state;

  const isFailed = failed(event.data);
  const payload = isFailed ? null : extractPayload(event.data);
  return refresh({
    ...state,
    results: new Map([...state.results, [callId, { seq: event.seq, failed: isFailed, payload }]]),
  });
}

export const definition = {
  kind: KEY,
  match(event) {
    if (event.data?.turn == null) return null;
    if (event.type === 'tool/call' && typeof event.data.name === 'string' && event.data.name) {
      return { id: String(event.data.turn), role: 'start' };
    }
    if (event.type === 'tool/result' || RECORD_TYPES.includes(event.type) || event.surfaceOp?.op === 'replace') {
      return { id: String(event.data.turn), role: 'start' };
    }
    return null;
  },
  start(_context, match) {
    return updateState(initial(match.event.data.turn), match.event);
  },
  update(context, match) {
    return updateState(context.state, match.event);
  },
  buildLocationData(context, scope, previous) {
    const state = context.state;
    if (scope !== 'turn' || !state) return null;
    if (previous?.kind === 'turn' && previous.turn === state.turn && previous.value === state.value) return previous;
    return { kind: 'turn', turn: state.turn, key: KEY, value: state.value };
  },
};

export function projectEvents(events) {
  let state;
  for (const event of events) {
    if (event.type === 'turn/start') state = initial(event.data?.turn);
    else if (state) state = updateState(state, event);
  }
  return state?.value ?? { turn: null, authRequired: null, reportDrafts: [], submittedByDraftId: {}, pendingActions: [], actionStatusById: {} };
}
