import { RETRIEVE_TOOL, PRESENT_TOOL, RECORD_TYPE, readKnowledgeResult, validateSelection } from './results.js';

export const KEY = 'datahub-knowledge-docs';

const within = (seq, ranges) => typeof seq === 'number' && ranges.some(range => seq >= range.startSeq && seq <= range.endSeq);
const callIdentity = event => event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? event.data?.callId;
const argumentsOf = event => {
  const args = event.data?.arguments ?? event.data?.args ?? {};
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args); } catch { return {}; }
};
const failed = value => Boolean(value && typeof value === 'object' &&
  ((value.error != null && value.error !== false) || value.isError || failed(value.message) || failed(value.result)));

function selectionOf(value) {
  if (typeof value === 'string') {
    try { return selectionOf(JSON.parse(value)); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || failed(value)) return null;
  if (value.kind === 'knowledge-documents-selection') return value;
  for (const key of ['selection', 'structuredContent', 'result', 'message']) {
    if (value[key] != null) {
      const selection = selectionOf(value[key]);
      if (selection) return selection;
    }
  }
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const selection = block.type === 'text' ? selectionOf(block.text) : null;
    if (selection) return selection;
  }
  return null;
}

function valueOf(state) {
  return { records: state.records, selections: state.selections, userText: state.userText, documentMode: state.documentMode };
}

function refresh(state) {
  const records = [];
  for (const [callId, call] of state.calls) {
    const result = state.results.get(callId);
    if (!result || call.name !== RETRIEVE_TOOL) continue;
    const full = state.full.get(callId);
    const parsed = !result.failed && full && full.callSeq === call.callSeq ? full.parsed : result.parsed;
    const record = { callId, callSeq: call.callSeq, resultSeq: result.seq, purpose: call.purpose, ...parsed };
    if (result.messageId != null) record.messageId = result.messageId;
    if (parsed.status === 'success') record.retrievalId = parsed.payload.retrievalId;
    records.push(record);
  }
  records.sort((a, b) => a.callSeq - b.callSeq);
  const selections = [];
  const results = new Map(state.results);
  for (const [callId, result] of state.results) {
    const call = state.calls.get(callId);
    if (call?.name !== PRESENT_TOOL || !result.selection) continue;
    // Validate the originally recorded source ids before recomputing the selected candidate set.
    try {
      const value = validateSelection(records, result.validatedSelection ?? result.selection, state.userText);
      if (!result.validatedSelection) results.set(callId, { ...result, validatedSelection: value });
      selections.push({ seq: result.seq, callId, value });
    } catch { /* Replaced or otherwise unavailable sources cannot become a final delivery. */ }
  }
  selections.sort((a, b) => a.seq - b.seq);
  const documentMode = [...state.calls.values()].some(call => call.name === RETRIEVE_TOOL && call.purpose === 'documents') ||
    records.some(record => record.payload?.purpose === 'documents');
  const next = { ...state, records, results, selections, documentMode };
  return { ...next, value: valueOf(next) };
}

function initial(turn) {
  const state = { turn, calls: new Map(), results: new Map(), full: new Map(), invalidated: new Set(),
    replacedRanges: [], userMessages: new Map(), records: [], selections: [], userText: '', documentMode: false };
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
      if (within(call.callSeq, [range]) || within(state.results.get(callId)?.seq, [range]) ||
          within(state.full.get(callId)?.seq, [range])) invalidated.add(callId);
    }
    const keep = map => new Map([...map].filter(([callId]) => !invalidated.has(callId)));
    const userMessages = new Map([...state.userMessages].filter(([seq]) => !within(seq, [range])));
    return refresh({ ...state, calls: keep(state.calls), results: keep(state.results), full: keep(state.full), invalidated,
      replacedRanges: [...state.replacedRanges, range], userMessages, userText: [...userMessages.values()].join('\n') });
  }
  if (event.type === 'user/message') {
    if (within(event.seq, state.replacedRanges) || state.userMessages.has(event.seq)) return state;
    const content = event.data?.content ?? event.data?.message?.content;
    const text = (Array.isArray(content) ? content : []).filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
    if (!text) return state;
    const userMessages = new Map([...state.userMessages, [event.seq, text]]);
    return refresh({ ...state, userMessages, userText: [...userMessages.values()].join('\n') });
  }
  if (event.type === 'tool/call') {
    const { callId, name } = event.data;
    if (![RETRIEVE_TOOL, PRESENT_TOOL].includes(name) || typeof callId !== 'string' || !callId ||
        state.calls.has(callId) || state.invalidated.has(callId) || within(event.seq, state.replacedRanges)) return state;
    const args = argumentsOf(event);
    return refresh({ ...state, calls: new Map([...state.calls, [callId, { callSeq: event.seq, name, purpose: args?.purpose }]]) });
  }
  if (event.type === RECORD_TYPE) {
    const data = event.data;
    if (data?.version !== 1 || data.turn !== state.turn || typeof data.callId !== 'string' ||
        typeof data.callSeq !== 'number' || state.invalidated.has(data.callId) || state.full.has(data.callId) ||
        within(data.callSeq, state.replacedRanges) || within(event.seq, state.replacedRanges)) return state;
    const call = state.calls.get(data.callId);
    if (call && (call.name !== RETRIEVE_TOOL || call.callSeq !== data.callSeq)) return state;
    const parsed = data.status === 'success' ? readKnowledgeResult(data.payload) :
      ['error', 'unsupported', 'invalid', 'truncated'].includes(data.status) ? { status: data.status, message: data.message } : null;
    if (!parsed) return state;
    return refresh({ ...state, full: new Map([...state.full, [data.callId, { seq: event.seq, callSeq: data.callSeq, parsed }]]) });
  }
  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state;
  const callId = callIdentity(event);
  const call = state.calls.get(callId);
  if (!call || state.results.has(callId) || state.invalidated.has(callId)) return state;
  if (within(event.seq, state.replacedRanges) || within(call.callSeq, state.replacedRanges)) {
    return refresh({ ...state, calls: new Map([...state.calls].filter(([id]) => id !== callId)),
      invalidated: new Set([...state.invalidated, callId]) });
  }
  if (typeof event.seq === 'number' && event.seq <= call.callSeq) return state;
  const parsed = readKnowledgeResult(event.data);
  const result = { seq: event.seq, failed: failed(event.data) || parsed.status === 'error', parsed,
    selection: call.name === PRESENT_TOOL ? selectionOf(event.data) : null,
    messageId: event.data.messageId ?? event.data.message?.messageId ?? event.data.message?.id };
  return refresh({ ...state, results: new Map([...state.results, [callId, result]]) });
}

/** User messages have no turn field; a predecessor definition binds their text without global mutable state. */
export const userTextDefinition = {
  kind: `${KEY}/user-text`,
  match(event) {
    if (!['turn/start', 'user/message'].includes(event.type)) return null;
    return { id: String(event.seq), role: 'start' };
  },
  start(_context, match, reader) {
    if (match.event.type === 'turn/start') return { turn: match.event.data?.turn, text: '' };
    const previous = reader?.previous(userTextDefinition.kind)?.state;
    const content = match.event.data?.content ?? match.event.data?.message?.content;
    const text = (Array.isArray(content) ? content : []).filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n');
    return { turn: match.event.data?.turn ?? previous?.turn, text: [previous?.text, text].filter(Boolean).join('\n') };
  },
  update(context) { return context.state; },
};

/** Same reducer powers client per-turn projections and the host's current-turn selection tool. */
export const definition = {
  kind: KEY,
  match(event) {
    if (event.data?.turn == null) return null;
    if (event.type === 'tool/call' && [RETRIEVE_TOOL, PRESENT_TOOL].includes(event.data.name)) {
      return { id: String(event.data.turn), role: 'start' };
    }
    if (['tool/result', RECORD_TYPE].includes(event.type) || event.surfaceOp?.op === 'replace') {
      return { id: String(event.data.turn), role: 'start' };
    }
    return null;
  },
  start(_context, match, reader) {
    const state = initial(match.event.data.turn);
    const user = reader?.previous(userTextDefinition.kind)?.state;
    const text = user?.turn === state.turn ? user.text : '';
    return updateState({ ...state, userText: text }, match.event);
  },
  update(context, match) { return updateState(context.state, match.event); },
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
  return state?.value ?? { records: [], selections: [], userText: '', documentMode: false };
}
