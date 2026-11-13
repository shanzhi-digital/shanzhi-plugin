import { KEY, SQL_TOOL, readSqlTrust, readTrustContext, aggregateTrust } from './trust.js';

const COLLECTOR = `${KEY}/events`;
const relevant = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result', 'agent/inbox/spliced', 'user/message']);
const validTurn = value => Number.isSafeInteger(value) && value >= 0;
const turnOf = match => match.location?.turn?.turn;
const within = (seq, range) => typeof seq === 'number' && seq >= range.startSeq && seq <= range.endSeq;
const callIdOf = event => event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? event.data?.callId;

function initial() {
  return { calls: new Map(), results: new Map(), summaries: new Map(), invalidated: new Set(), ranges: [], positions: new Map() };
}

function rawSummary(value, callId) {
  if (typeof value === 'string') {
    try { return rawSummary(JSON.parse(value), callId); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || value.isError || value.success === false ||
      (value.error != null && value.error !== false)) return null;
  const summary = readSqlTrust(value, callId);
  if (summary) return summary;
  for (const key of ['message', 'result']) {
    if (value[key] != null) {
      const nested = rawSummary(value[key], callId);
      if (nested) return nested;
    }
  }
  return null;
}

function updateState(state, match) {
  const { event } = match;
  const turn = turnOf(match);
  const operation = event.surfaceOp;
  if (operation?.op === 'replace') {
    const range = {
      startSeq: state.positions.get(operation.startSeq) ?? operation.startSeq,
      endSeq: state.positions.get(operation.endSeq) ?? operation.endSeq,
    };
    if (typeof range.startSeq !== 'number' || typeof range.endSeq !== 'number' || range.startSeq > range.endSeq) return state;
    const invalidated = new Set(state.invalidated);
    for (const map of [state.calls, state.results, state.summaries]) {
      for (const [callId, entry] of map) if (within(entry.position, range)) invalidated.add(callId);
    }
    for (const [callId, entry] of state.summaries) {
      if (invalidated.has(entry.parentCallId)) invalidated.add(callId);
    }
    const keep = map => new Map([...map].filter(([callId]) => !invalidated.has(callId)));
    const positions = new Map([...state.positions].filter(([, position]) => !within(position, range)));
    positions.set(event.seq, range.startSeq);
    return { ...state, calls: keep(state.calls), results: keep(state.results), summaries: keep(state.summaries),
      invalidated, ranges: [...state.ranges, range], positions };
  }
  if (!validTurn(turn)) return state;
  if (state.ranges.some(range => within(event.seq, range))) return state;
  if (event.type === 'tool/call') {
    const { callId, name } = event.data;
    if (![SQL_TOOL, 'datahub_chart'].includes(name) || typeof callId !== 'string' || !callId || state.invalidated.has(callId) || state.calls.has(callId)) return state;
    return { ...state, calls: new Map([...state.calls, [callId, { turn, position: event.seq, name }]]) };
  }
  if (event.type === 'tool/result') {
    if (event.surfaceOp !== 'append') return state;
    const callId = callIdOf(event);
    const call = state.calls.get(callId);
    if (!call || call.turn !== turn || state.invalidated.has(callId) || state.results.has(callId) || event.seq <= call.position) return state;
    const summary = call.name === SQL_TOOL ? rawSummary(event.data, callId) : null;
    return { ...state, results: new Map([...state.results, [callId, { turn, position: event.seq, summary }]]) };
  }
  const messages = event.type === 'agent/inbox/spliced' ? event.data?.inserted :
    event.type === 'user/message' ? [event.data?.message ?? { ...event.data, role: 'user' }] : [];
  let summaries = state.summaries;
  for (const message of Array.isArray(messages) ? messages : []) {
    const summary = readTrustContext(message);
    const parentCallId = message?.source?.parentCallId;
    if (!summary || state.invalidated.has(summary.callId) || state.invalidated.has(parentCallId) || summaries.has(summary.callId)) continue;
    if (summaries === state.summaries) summaries = new Map(summaries);
    summaries.set(summary.callId, { turn, position: event.seq, parentCallId, summary });
  }
  return summaries === state.summaries ? state : { ...state, summaries };
}

function valueOf(state, turn) {
  if (!state) return null;
  const summaries = new Map();
  for (const [callId, entry] of state.results) if (entry.turn === turn && entry.summary) summaries.set(callId, entry.summary);
  // A durable lossless summary takes precedence over the projected/raw tool response.
  for (const [callId, entry] of state.summaries) {
    if (entry.turn === turn) summaries.set(callId, entry.summary);
    else summaries.delete(callId);
  }
  return aggregateTrust([...summaries.values()]);
}

/** Match.location is assigned by the host even when the event has no payload turn. */
export const collectorDefinition = {
  kind: COLLECTOR,
  match(event) {
    return relevant.has(event.type) || event.surfaceOp?.op === 'replace' ? { id: 'session', role: 'start' } : null;
  },
  start(_context, match) { return updateState(initial(), match); },
  update(context, match) { return updateState(context.state, match); },
};

/** One completed-turn Context owns one Location data entry, with dependency-tracked replay. */
export const definition = {
  kind: KEY,
  match(event) {
    return event.type === 'turn/end' && validTurn(event.data?.turn) ? { id: String(event.data.turn), role: 'start' } : null;
  },
  start(_context, match, reader) {
    const turn = match.event.data.turn;
    const state = reader.previous(COLLECTOR)?.state;
    return { turn, value: match.event.data.reason?.kind === 'completed' ? valueOf(state, turn) : null };
  },
  update(context) { return context.state; },
  buildLocationData(context, scope, previous) {
    if (scope !== 'turn' || !context.state) return null;
    const { turn, value } = context.state;
    if (previous?.turn === turn && previous.value === value) return previous;
    return { kind: 'turn', turn, key: KEY, value };
  },
};

export function registerTrustProjection(ctx) {
  const disposeCollector = ctx.uiConversation.events.register(collectorDefinition);
  const disposeProjection = ctx.uiConversation.events.register(definition);
  return () => { disposeProjection(); disposeCollector(); };
}

/** Replay helper using the host's turn-boundary rules; returns every ended turn. */
export function projectEvents(events) {
  let state = initial();
  let currentTurn;
  const ended = new Map();
  for (const event of events) {
    if (event.type === 'turn/start' || event.type === 'step/start') currentTurn = event.data?.turn;
    if (validTurn(event.data?.turn)) currentTurn = event.data.turn;
    const turn = event.data?.turn === null ? undefined : event.data?.turn ?? currentTurn;
    state = updateState(state, { event, location: validTurn(turn) ? { kind: 'turn', turn: { turn } } : { kind: 'session' } });
    if (event.type === 'turn/end') {
      ended.set(event.data.turn, event.data.reason?.kind === 'completed');
      if (currentTurn === event.data.turn) currentTurn = undefined;
    }
  }
  return new Map([...ended].map(([turn, completed]) => [turn, completed ? valueOf(state, turn) : null]));
}
