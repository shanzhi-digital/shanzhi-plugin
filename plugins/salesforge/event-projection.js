// 会话事件投影（与 client.js 里浏览器端的投影保持一致，单测用它核对）。
// 只关心一件事：本回合有没有工具返回「需要连接账户」（kind = salesforge-auth-required），有就在回合末尾显示授权卡片。
export const KEY = 'salesforge';
export const AUTH_REQUIRED_KIND = 'salesforge-auth-required';

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

function extractAuthRequired(value) {
  if (typeof value === 'string') {
    // 每个工具结果都要检查，先排除不可能带本插件授权提示的文本，省掉解析。
    if (!value.includes(AUTH_REQUIRED_KIND)) return null;
    try {
      return extractAuthRequired(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || failed(value)) return null;
  if (value.kind === AUTH_REQUIRED_KIND) return value;
  for (const key of ['structuredContent', 'value', 'result', 'message']) {
    if (value[key] != null) {
      const found = extractAuthRequired(value[key]);
      if (found) return found;
    }
  }
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const found = extractAuthRequired(block.text);
        if (found) return found;
      }
    }
  }
  return null;
}

const valueOf = (state) => ({ turn: state.turn, authRequired: state.authRequired });

function refresh(state) {
  let authRequired = null;
  for (const [callId, call] of state.calls) {
    const result = state.results.get(callId);
    if (!result || result.failed || !result.payload) continue;
    const payload = result.payload;
    // 一个回合只显示一张卡片，取最后一次。
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
  const next = { ...state, authRequired };
  return { ...next, value: valueOf(next) };
}

function initial(turn) {
  const state = { turn, calls: new Map(), results: new Map(), invalidated: new Set(), replacedRanges: [], authRequired: null };
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
      invalidated,
      replacedRanges: [...state.replacedRanges, range],
    });
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
  const payload = isFailed ? null : extractAuthRequired(event.data);
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
    if (event.type === 'tool/result' || event.surfaceOp?.op === 'replace') {
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
  return state?.value ?? { turn: null, authRequired: null };
}
