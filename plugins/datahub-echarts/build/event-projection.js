export const KEY = 'datahub-echarts';
const TOOLS = new Set(['datahub_chart', 'query_result_chart']);

/** Reconstructed from committed events, including after refresh/fork/replay. */
export const definition = {
  kind: KEY,
  match(event) {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' };
    if (event.type === 'tool/call' || event.type === 'tool/result' || event.surfaceOp?.op === 'replace') return { id: String(event.data.turn), role: 'update' };
    return null;
  },
  start(_context, match) { return { turn: match.event.data.turn, calls: new Set(), completed: new Set(), replacedRanges: [], charts: [] }; },
  update(context, match) {
    const event = match.event;
    let state = context.state;
    if (event.surfaceOp?.op === 'replace') {
      const { startSeq, endSeq } = event.surfaceOp;
      const charts = state.charts.filter(chart => ![chart.seq, chart.value.source?.resultSeq].some(seq =>
        typeof seq === 'number' && seq >= startSeq && seq <= endSeq));
      // Retain invalidated sources even when their chart result has not arrived yet.
      state = { ...state, replacedRanges: [...(state.replacedRanges ?? []), { startSeq, endSeq }], charts };
    }
    if (event.type === 'tool/call') {
      if (!TOOLS.has(event.data.name)) return state;
      return { ...state, calls: new Set([...state.calls, String(event.data.callId)]) };
    }
    const callId = String(event.data.message?.source?.callId ?? event.data.message?.toolCallId);
    if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data.message?.isError || event.data.error ||
      !state.calls.has(callId) || state.completed.has(callId)) return state;
    const texts = (event.data.message?.content || []).filter(block => block.type === 'text');
    if (texts.length !== 1) return state;
    let value;
    try { value = JSON.parse(texts[0].text); } catch { return state; }
    if (!value || !Array.isArray(value.data) || !Array.isArray(value.columns) || !Array.isArray(value.measures)) return state;
    if ((state.replacedRanges ?? []).some(({ startSeq, endSeq }) =>
      [event.seq, value.source?.resultSeq].some(seq => typeof seq === 'number' && seq >= startSeq && seq <= endSeq))) return state;
    return { ...state, completed: new Set([...state.completed, callId]), charts: [...state.charts, { seq: event.seq, value }] };
  },
  buildLocationData(context, scope, previous) {
    const state = context.state;
    if (scope !== 'turn' || !state) return null;
    if (previous?.kind === 'turn' && previous.value === state.charts) return previous;
    return { kind: 'turn', turn: state.turn, key: KEY, value: state.charts };
  }
};
