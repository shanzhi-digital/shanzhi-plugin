export const KEY = 'contract-sure';
export const DRAFT_RECORD_TYPE = 'plugin:contract-sure/draft';
export const DRAFT_CONFIRMED_RECORD_TYPE = 'plugin:contract-sure/draft-confirmed';
export const DETAIL_RECORD_TYPE = 'plugin:contract-sure/detail';
export const AUTH_REQUIRED_KIND = 'contract-sure-auth-required';

export const STAGE_DRAFT_TOOL = 'contract_stage_draft';
export const CONFIRM_SAVE_TOOL = 'contract_confirm_save';
export const QUERY_TOOL = 'contract_query';

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

function extractPayloadByKind(value, kinds) {
  if (typeof value === 'string') {
    // Every tool result is checked for the auth-required kind, so skip parsing text that
    // cannot carry one of this plugin's payloads.
    if (!value.includes('contract-sure-')) return null;
    try {
      return extractPayloadByKind(JSON.parse(value), kinds);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || failed(value)) return null;
  if (typeof value.kind === 'string' && kinds.includes(value.kind)) return value;
  for (const key of ['structuredContent', 'value', 'result', 'message']) {
    if (value[key] != null) {
      const found = extractPayloadByKind(value[key], kinds);
      if (found) return found;
    }
  }
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const found = extractPayloadByKind(block.text, kinds);
        if (found) return found;
      }
    }
  }
  return null;
}

function valueOf(state) {
  return {
    turn: state.turn,
    drafts: state.drafts,
    confirmedByDraftId: state.confirmedByDraftId,
    details: state.details,
    authRequired: state.authRequired,
  };
}

function refresh(state) {
  const draftMap = new Map();
  const confirmedByDraftId = {};
  const detailMap = new Map();
  let authRequired = null;

  for (const record of state.pluginRecords) {
    if (record.type === DRAFT_RECORD_TYPE && record.data?.draftId) {
      draftMap.set(record.data.draftId, {
        seq: record.seq,
        draftId: record.data.draftId,
        draft: record.data.draft,
        sourceFilePath: record.data.sourceFilePath || null,
        validation: record.data.validation || null,
        status: record.data.status || 'staged',
      });
    } else if (record.type === DRAFT_CONFIRMED_RECORD_TYPE && record.data?.draftId) {
      confirmedByDraftId[record.data.draftId] = {
        contractId: record.data.contractId,
        uploadedDoc: record.data.uploadedDoc || null,
        uploadWarning: record.data.uploadWarning || null,
      };
    } else if (record.type === DETAIL_RECORD_TYPE && record.data?.contractId != null) {
      detailMap.set(String(record.data.contractId), {
        seq: record.seq,
        contractId: record.data.contractId,
        contractNo: record.data.contractNo || '',
        contractName: record.data.contractName || '',
        documents: Array.isArray(record.data.documents) ? record.data.documents : [],
      });
    }
  }

  for (const [callId, call] of state.calls) {
    const result = state.results.get(callId);
    if (!result || result.failed || !result.payload) continue;
    const payload = result.payload;
    if (payload.kind === AUTH_REQUIRED_KIND) {
      // Any of the plugin's tools can answer "connect an account first"; one card per turn, the latest.
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
    } else if (call.name === STAGE_DRAFT_TOOL && payload.kind === 'contract-sure-draft' && payload.draftId) {
      if (!draftMap.has(payload.draftId)) {
        draftMap.set(payload.draftId, {
          seq: result.seq,
          draftId: payload.draftId,
          draft: payload.draft,
          sourceFilePath: payload.sourceFilePath || null,
          validation: payload.validation || null,
          status: payload.status || 'staged',
        });
      }
    } else if (call.name === CONFIRM_SAVE_TOOL && payload.kind === 'contract-sure-confirmed' && payload.draftId) {
      confirmedByDraftId[payload.draftId] = {
        contractId: payload.contractId,
        uploadedDoc: payload.uploadedDoc || null,
        uploadWarning: payload.uploadWarning || null,
      };
    } else if (call.name === QUERY_TOOL && payload.kind === 'contract-sure-detail' && payload.contract?.id != null) {
      const cid = String(payload.contract.id);
      if (!detailMap.has(cid)) {
        detailMap.set(cid, {
          seq: result.seq,
          contractId: payload.contract.id,
          contractNo: payload.contract.contractNo || '',
          contractName: payload.contract.contractName || '',
          documents: Array.isArray(payload.documents) ? payload.documents : [],
        });
      }
    }
  }

  const drafts = [...draftMap.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const details = [...detailMap.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const next = { ...state, drafts, confirmedByDraftId, details, authRequired };
  return { ...next, value: valueOf(next) };
}

function initial(turn) {
  const state = {
    turn,
    calls: new Map(),
    results: new Map(),
    pluginRecords: [],
    invalidated: new Set(),
    replacedRanges: [],
    drafts: [],
    confirmedByDraftId: {},
    details: [],
    authRequired: null,
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
      if (within(call.callSeq, [range]) || within(state.results.get(callId)?.seq, [range])) {
        invalidated.add(callId);
      }
    }
    const keep = (map) => new Map([...map].filter(([id]) => !invalidated.has(id)));
    const pluginRecords = state.pluginRecords.filter(
      (rec) => !within(rec.seq, [range]) && !within(rec.data?.callSeq, [range]),
    );
    return refresh({
      ...state,
      calls: keep(state.calls),
      results: keep(state.results),
      pluginRecords,
      invalidated,
      replacedRanges: [...state.replacedRanges, range],
    });
  }

  if ([DRAFT_RECORD_TYPE, DRAFT_CONFIRMED_RECORD_TYPE, DETAIL_RECORD_TYPE].includes(event.type)) {
    if (within(event.seq, state.replacedRanges) || within(event.data?.callSeq, state.replacedRanges)) return state;
    if (state.pluginRecords.some((rec) => rec.seq === event.seq && rec.type === event.type)) return state;
    return refresh({
      ...state,
      pluginRecords: [...state.pluginRecords, { type: event.type, seq: event.seq, data: event.data }],
    });
  }

  if (event.type === 'tool/call') {
    // Calls of every tool are tracked: any of them may return the auth-required kind.
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
    return refresh({
      ...state,
      calls: new Map([...state.calls, [callId, { callSeq: event.seq, name }]]),
    });
  }

  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state;
  const callId = callIdentity(event);
  const call = state.calls.get(callId);
  if (!call || state.results.has(callId) || state.invalidated.has(callId)) return state;
  if (within(event.seq, state.replacedRanges) || within(call.callSeq, state.replacedRanges)) return state;
  if (typeof event.seq === 'number' && event.seq <= call.callSeq) return state;

  const isFailed = failed(event.data);
  const payload = isFailed
    ? null
    : extractPayloadByKind(event.data, ['contract-sure-draft', 'contract-sure-confirmed', 'contract-sure-detail', AUTH_REQUIRED_KIND]);

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
    if (
      ['tool/result', DRAFT_RECORD_TYPE, DRAFT_CONFIRMED_RECORD_TYPE, DETAIL_RECORD_TYPE].includes(event.type) ||
      event.surfaceOp?.op === 'replace'
    ) {
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
    if (previous?.kind === 'turn' && previous.turn === state.turn && previous.value === state.value) {
      return previous;
    }
    return { kind: 'turn', turn: state.turn, key: KEY, value: state.value };
  },
};

export function projectEvents(events) {
  let state;
  for (const event of events) {
    if (event.type === 'turn/start') state = initial(event.data?.turn);
    else if (state) state = updateState(state, event);
  }
  return state?.value ?? { turn: null, drafts: [], confirmedByDraftId: {}, details: [], authRequired: null };
}
