window.__ModuleLoader__.load({id:"@local/datahub-query-enhance",factory(require){const module={exports:{}};const exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/datahub-query-enhance/build/client-entry.js
var client_entry_exports = {};
__export(client_entry_exports, {
  TrustBadge: () => TrustBadge,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_entry_exports);
var import_react = __toESM(require("react"), 1);

// plugins/datahub-query-enhance/trust.js
var KEY = "datahub-query-enhance";
var SQL_TOOL = "mcp__datahub-ask-data__execute_semantic_sql";
var record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var identifier = (value) => typeof value === "string" || typeof value === "number" && Number.isFinite(value);
var failed = (value) => record(value) && (Boolean(value.isError) || value.error != null && value.error !== false || value.success === false);
var measureFields = ["datasourceId", "model", "member", "queryMember", "title", "trustHash", "source", "semanticCommit"];
function compactMeasure(value) {
  const measure = {};
  for (const key of measureFields) {
    if (key === "datasourceId" ? identifier(value[key]) : typeof value[key] === "string") measure[key] = value[key];
  }
  measure.trusted = value.trusted === true;
  return measure;
}
function sqlPayload(value) {
  if (!record(value) || failed(value)) return null;
  if (value.queryKind === "SEMANTIC_SQL") return value;
  if (record(value.structuredContent)) return value.structuredContent;
  for (const block of Array.isArray(value.content) ? value.content : []) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (record(parsed) && parsed.queryKind === "SEMANTIC_SQL") return parsed;
    } catch {
    }
  }
  return null;
}
function readSqlTrust(value, callId) {
  if (typeof callId !== "string" || callId.length === 0) return null;
  const payload = sqlPayload(value);
  if (!payload || failed(payload) || payload.queryKind !== "SEMANTIC_SQL" || !Array.isArray(payload.columns) || !Array.isArray(payload.data)) return null;
  const measures = Array.isArray(payload.usedMeasures) ? payload.usedMeasures : [];
  return {
    version: 1,
    kind: "datahub-query-trust",
    callId,
    datasourceId: identifier(payload.datasourceId) ? payload.datasourceId : null,
    semanticCommit: typeof payload.semanticCommit === "string" ? payload.semanticCommit : null,
    usedMeasures: measures.filter(record).map(compactMeasure),
    unstructuredData: measures.length === 0 || measures.some((measure) => !record(measure))
  };
}
function validSummary(value) {
  return record(value) && value.version === 1 && value.kind === "datahub-query-trust" && typeof value.callId === "string" && value.callId.length > 0 && (value.datasourceId === null || identifier(value.datasourceId)) && (value.semanticCommit === null || typeof value.semanticCommit === "string") && typeof value.unstructuredData === "boolean" && Array.isArray(value.usedMeasures) && value.usedMeasures.every((measure) => record(measure) && typeof measure.trusted === "boolean" && measureFields.every((key) => measure[key] === void 0 || (key === "datasourceId" ? identifier(measure[key]) : typeof measure[key] === "string")));
}
function readTrustContext(message) {
  if (message?.role !== "user" || message.source?.kind !== KEY || message.source.form !== "notice" || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== "text") return null;
  try {
    const summary = JSON.parse(message.content[0].text);
    if (!validSummary(summary)) return null;
    return {
      version: 1,
      kind: summary.kind,
      callId: summary.callId,
      datasourceId: summary.datasourceId,
      semanticCommit: summary.semanticCommit,
      usedMeasures: summary.usedMeasures.map(compactMeasure),
      unstructuredData: summary.unstructuredData || summary.usedMeasures.length === 0
    };
  } catch {
    return null;
  }
}
function aggregateTrust(summaries) {
  const valid = summaries.filter(validSummary);
  if (valid.length === 0) return null;
  const measures = /* @__PURE__ */ new Map();
  let unstructuredData = false;
  for (const summary of valid) {
    unstructuredData || (unstructuredData = summary.unstructuredData || summary.usedMeasures.length === 0);
    for (const measure of summary.usedMeasures) {
      const key = JSON.stringify([measure.datasourceId, measure.model, measure.member, measure.trustHash]);
      const previous = measures.get(key);
      if (previous) previous.trusted && (previous.trusted = measure.trusted);
      else measures.set(key, compactMeasure(measure));
    }
  }
  const usedMeasures = [...measures.values()];
  const trustedCount = usedMeasures.filter((measure) => measure.trusted).length;
  const untrustedCount = usedMeasures.length - trustedCount;
  return {
    level: trustedCount === 0 ? "NOT_TRUSTED" : untrustedCount > 0 || unstructuredData ? "PARTIAL" : "TRUSTED",
    usedMeasures,
    trustedCount,
    untrustedCount,
    unstructuredData
  };
}

// plugins/datahub-query-enhance/event-projection.js
var COLLECTOR = `${KEY}/events`;
var relevant = /* @__PURE__ */ new Set(["turn/start", "turn/end", "tool/call", "tool/result", "agent/inbox/spliced", "user/message"]);
var validTurn = (value) => Number.isSafeInteger(value) && value >= 0;
var turnOf = (match) => match.location?.turn?.turn;
var within = (seq, range) => typeof seq === "number" && seq >= range.startSeq && seq <= range.endSeq;
var callIdOf = (event) => event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? event.data?.callId;
function initial() {
  return { calls: /* @__PURE__ */ new Map(), results: /* @__PURE__ */ new Map(), summaries: /* @__PURE__ */ new Map(), invalidated: /* @__PURE__ */ new Set(), ranges: [], positions: /* @__PURE__ */ new Map() };
}
function rawSummary(value, callId) {
  if (typeof value === "string") {
    try {
      return rawSummary(JSON.parse(value), callId);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || value.isError || value.success === false || value.error != null && value.error !== false) return null;
  const summary = readSqlTrust(value, callId);
  if (summary) return summary;
  for (const key of ["message", "result"]) {
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
  if (operation?.op === "replace") {
    const range = {
      startSeq: state.positions.get(operation.startSeq) ?? operation.startSeq,
      endSeq: state.positions.get(operation.endSeq) ?? operation.endSeq
    };
    if (typeof range.startSeq !== "number" || typeof range.endSeq !== "number" || range.startSeq > range.endSeq) return state;
    const invalidated = new Set(state.invalidated);
    for (const map of [state.calls, state.results, state.summaries]) {
      for (const [callId, entry] of map) if (within(entry.position, range)) invalidated.add(callId);
    }
    for (const [callId, entry] of state.summaries) {
      if (invalidated.has(entry.parentCallId)) invalidated.add(callId);
    }
    const keep = (map) => new Map([...map].filter(([callId]) => !invalidated.has(callId)));
    const positions = new Map([...state.positions].filter(([, position]) => !within(position, range)));
    positions.set(event.seq, range.startSeq);
    return {
      ...state,
      calls: keep(state.calls),
      results: keep(state.results),
      summaries: keep(state.summaries),
      invalidated,
      ranges: [...state.ranges, range],
      positions
    };
  }
  if (!validTurn(turn)) return state;
  if (state.ranges.some((range) => within(event.seq, range))) return state;
  if (event.type === "tool/call") {
    const { callId, name } = event.data;
    if (![SQL_TOOL, "datahub_chart"].includes(name) || typeof callId !== "string" || !callId || state.invalidated.has(callId) || state.calls.has(callId)) return state;
    return { ...state, calls: new Map([...state.calls, [callId, { turn, position: event.seq, name }]]) };
  }
  if (event.type === "tool/result") {
    if (event.surfaceOp !== "append") return state;
    const callId = callIdOf(event);
    const call = state.calls.get(callId);
    if (!call || call.turn !== turn || state.invalidated.has(callId) || state.results.has(callId) || event.seq <= call.position) return state;
    const summary = call.name === SQL_TOOL ? rawSummary(event.data, callId) : null;
    return { ...state, results: new Map([...state.results, [callId, { turn, position: event.seq, summary }]]) };
  }
  const messages = event.type === "agent/inbox/spliced" ? event.data?.inserted : event.type === "user/message" ? [event.data?.message ?? { ...event.data, role: "user" }] : [];
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
  const summaries = /* @__PURE__ */ new Map();
  for (const [callId, entry] of state.results) if (entry.turn === turn && entry.summary) summaries.set(callId, entry.summary);
  for (const [callId, entry] of state.summaries) {
    if (entry.turn === turn) summaries.set(callId, entry.summary);
    else summaries.delete(callId);
  }
  return aggregateTrust([...summaries.values()]);
}
var collectorDefinition = {
  kind: COLLECTOR,
  match(event) {
    return relevant.has(event.type) || event.surfaceOp?.op === "replace" ? { id: "session", role: "start" } : null;
  },
  start(_context, match) {
    return updateState(initial(), match);
  },
  update(context, match) {
    return updateState(context.state, match);
  }
};
var definition = {
  kind: KEY,
  match(event) {
    return event.type === "turn/end" && validTurn(event.data?.turn) ? { id: String(event.data.turn), role: "start" } : null;
  },
  start(_context, match, reader) {
    const turn = match.event.data.turn;
    const state = reader.previous(COLLECTOR)?.state;
    return { turn, value: match.event.data.reason?.kind === "completed" ? valueOf(state, turn) : null };
  },
  update(context) {
    return context.state;
  },
  buildLocationData(context, scope, previous) {
    if (scope !== "turn" || !context.state) return null;
    const { turn, value } = context.state;
    if (previous?.turn === turn && previous.value === value) return previous;
    return { kind: "turn", turn, key: KEY, value };
  }
};
function registerTrustProjection(ctx) {
  const disposeCollector = ctx.uiConversation.events.register(collectorDefinition);
  const disposeProjection = ctx.uiConversation.events.register(definition);
  return () => {
    disposeProjection();
    disposeCollector();
  };
}

// plugins/datahub-query-enhance/build/client-entry.js
var h = import_react.default.createElement;
var DISPLAY = {
  TRUSTED: { label: "\u53EF\u4FE1\u6307\u6807", explanation: "\u53EF\u4FE1\u6307\u6807\u662F\u6307\u7EDF\u8BA1\u53E3\u5F84\u3001\u6570\u636E\u6765\u6E90\u5DF2\u7ECF\u4EBA\u5DE5\u786E\u8BA4\u7684\u6307\u6807", color: "var(--dsw-alias-label-success, #267763)" },
  PARTIAL: { label: "\u90E8\u5206\u53EF\u4FE1", explanation: "\u90E8\u5206\u6307\u6807\u5DF2\u4EBA\u5DE5\u786E\u8BA4", color: "var(--dsw-alias-label-secondary, #79746c)" },
  NOT_TRUSTED: { label: "\u6570\u636E\u7531AI\u63D0\u53D6\uFF0C\u6CE8\u610F\u8FA8\u522B", color: "var(--dsw-alias-label-secondary, #8c6c55)" }
};
var css = `
.dqe-trust{margin:16px 0 8px;font:inherit;font-size:12px;line-height:1.7;text-align:left}
.dqe-trust-line{display:flex;align-items:center;gap:6px}
.dqe-trust-help{display:inline-flex;align-items:center;justify-content:center;flex:none;width:17px;height:17px;padding:0;border:1px solid currentColor;border-radius:50%;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;cursor:pointer;opacity:.8}
.dqe-trust-help:hover{opacity:1}.dqe-trust-help:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.dqe-trust-explanation{width:fit-content;max-width:100%;margin:7px 0 0;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e3df);border-radius:5px;color:var(--dsw-alias-label-secondary,#79746c);background:var(--dsw-alias-bg-layer-1,transparent);overflow-wrap:anywhere}
`;
function TrustBadge({ trust }) {
  const [open, setOpen] = import_react.default.useState(false);
  const explanationId = import_react.default.useId();
  import_react.default.useEffect(() => {
    setOpen(false);
  }, [trust?.level]);
  const display = DISPLAY[trust?.level];
  if (!display) return null;
  return h(
    "aside",
    { className: "dqe-trust", "aria-label": "\u6307\u6807\u53EF\u4FE1\u72B6\u6001", style: { color: display.color } },
    h("style", null, css),
    h(
      "div",
      { className: "dqe-trust-line" },
      h("span", null, display.label),
      display.explanation ? h("button", {
        className: "dqe-trust-help",
        type: "button",
        "aria-label": `${display.label}\u8BF4\u660E`,
        "aria-expanded": open,
        "aria-controls": explanationId,
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.key === "Escape") {
            setOpen(false);
            event.stopPropagation();
          }
        }
      }, "?") : null
    ),
    open && display.explanation ? h("p", { id: explanationId, className: "dqe-trust-explanation" }, display.explanation) : null
  );
}
function TurnTail({ turn }) {
  return h(TrustBadge, { trust: turn.data.get(KEY) });
}
var inject = ["slots", "uiConversation"];
function apply(ctx) {
  registerTrustProjection(ctx);
  ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({ name: "conversation.chat.turnTail", id: KEY, order: 90 }, TurnTail));
}

return module.exports;}});
