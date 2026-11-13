window.__ModuleLoader__.load({id:"@local/datahub-knowledge-docs",factory(require){const module={exports:{}};const exports=module.exports;
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

// build/client-entry.js
var client_entry_exports = {};
__export(client_entry_exports, {
  TurnTail: () => TurnTail,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_entry_exports);
var import_react = __toESM(require("react"), 1);

// ../../.narrafork/verification/datahub-knowledge-docs-v0.3.0/build-input/workspace-path.js
var FILE_ADDRESS_PREFIX = "dsh-resource://file/";
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}
function encodePath(path) {
  return path.split("/").map(encodeSegment).join("/");
}
function sessionFileAddress(sessionId, path) {
  const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}
function isWindowsStylePath(value) {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}
function isAbsoluteWorkspacePath(path) {
  return path.startsWith("/") || isWindowsStylePath(path);
}
function fileAddressFor(sessionId, cwd, path) {
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}

// results.js
var RETRIEVE_TOOL = "mcp__datahub-knowledge__retrieve_knowledge";
var PRESENT_TOOL = "knowledge_documents_present";
var RECORD_TYPE = "plugin:datahub-knowledge-docs/result";
var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var identity = (value) => typeof value === "string" && value.trim().length > 0;
var invalid = () => ({ status: "invalid", message: "\u95EE\u77E5\u7ED3\u679C\u6570\u636E\u683C\u5F0F\u4E0D\u53EF\u7528" });
var unsupported = () => ({ status: "unsupported", message: "\u5F53\u524D\u95EE\u77E5\u63A5\u53E3\u672A\u63D0\u4F9B\u6587\u6863\u5C55\u793A\u6570\u636E" });
function errorMessage(value) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value?.message === "string" && value.message.trim()) return value.message;
  return "\u95EE\u77E5\u68C0\u7D22\u5931\u8D25";
}
function expiry(value) {
  if (typeof value !== "string") return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return NaN;
  const [, year, month, day] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return NaN;
  return Date.parse(value);
}
function validate(payload) {
  if (!object(payload)) return invalid();
  if (payload.schemaVersion !== 2) return unsupported();
  if (!["knowledge", "documents"].includes(payload.purpose) || !identity(payload.retrievalId) || !Array.isArray(payload.documents) || !Array.isArray(payload.evidence)) return invalid();
  const documents = /* @__PURE__ */ new Map();
  for (const document of payload.documents) {
    if (!object(document) || !["documentRef", "knowledgeBaseId", "docId"].every((key) => identity(document[key])) || typeof document.documentName !== "string" || typeof document.knowledgeBaseName !== "string" || documents.has(document.documentRef)) return invalid();
    documents.set(document.documentRef, document);
  }
  if (payload.purpose === "documents" && payload.evidence.length) return invalid();
  const evidenceIds = /* @__PURE__ */ new Set();
  for (const evidence of payload.evidence) {
    if (!object(evidence) || !identity(evidence.evidenceId) || !identity(evidence.documentRef) || typeof evidence.text !== "string" || !evidence.text.trim() || !documents.has(evidence.documentRef) || evidenceIds.has(evidence.evidenceId) || evidence.chunkId != null && typeof evidence.chunkId !== "string") return invalid();
    evidenceIds.add(evidence.evidenceId);
  }
  return { status: "success", payload };
}
function readKnowledgeResult(input) {
  if (typeof input === "string") {
    try {
      return readKnowledgeResult(JSON.parse(input));
    } catch {
      if (/\[\.\.\.\][\s\S]*Full formatted result stored at/.test(input)) {
        return { status: "truncated", message: "\u5386\u53F2\u68C0\u7D22\u7ED3\u679C\u5DF2\u88AB\u622A\u77ED\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u4EE5\u5C55\u793A\u5B8C\u6574\u6765\u6E90" };
      }
      return /^[\s]*[\[{]/.test(input) ? invalid() : unsupported();
    }
  }
  if (!object(input)) return invalid();
  if (input.error != null && input.error !== false) return { status: "error", message: errorMessage(input.error) };
  if (input.isError) {
    const text = input.content?.find?.((block) => block?.type === "text" && typeof block.text === "string")?.text;
    return { status: "error", message: errorMessage(text ?? input.message) };
  }
  if (Object.hasOwn(input, "structuredContent")) return validate(input.structuredContent);
  if (Object.hasOwn(input, "result")) return readKnowledgeResult(input.result);
  if (Object.hasOwn(input, "message") && object(input.message)) return readKnowledgeResult(input.message);
  if (Object.hasOwn(input, "schemaVersion")) return validate(input);
  if (Array.isArray(input.content)) {
    const texts = input.content.filter((block) => block?.type === "text" && typeof block.text === "string");
    const parsed = [];
    for (const block of texts) {
      try {
        parsed.push(JSON.parse(block.text));
      } catch {
      }
    }
    const candidates = parsed.filter((value) => object(value) && (Object.hasOwn(value, "schemaVersion") || Object.hasOwn(value, "structuredContent") || Object.hasOwn(value, "result") || Object.hasOwn(value, "error") || Object.hasOwn(value, "isError")));
    if (candidates.length === 1) return readKnowledgeResult(candidates[0]);
    if (candidates.length > 1) return invalid();
    if (texts.length === 1) return readKnowledgeResult(texts[0].text);
    return texts.some((block) => /^\s*[\[{]/.test(block.text)) ? invalid() : unsupported();
  }
  return unsupported();
}
function collectDocuments(records) {
  const documents = /* @__PURE__ */ new Map();
  const ordered = records.map((record, index) => ({ record, index })).sort((a, b) => (a.record.callSeq ?? a.index) - (b.record.callSeq ?? b.index));
  for (const { record, index } of ordered) {
    if (record.status !== "success") continue;
    const payload = record.payload;
    for (const source of payload.documents) {
      let document = documents.get(source.documentRef);
      if (!document) {
        document = { ...source, evidence: [], links: [], sourceCallIds: [] };
        documents.set(source.documentRef, document);
      }
      if (record.callId && !document.sourceCallIds.includes(record.callId)) document.sourceCallIds.push(record.callId);
      document.links.push({ ...source, resultSeq: record.resultSeq ?? index });
      document.links.sort((a, b) => a.resultSeq - b.resultSeq);
    }
    for (const source of payload.evidence) {
      const document = documents.get(source.documentRef);
      const hasChunk = identity(source.chunkId);
      const existing = hasChunk && document.evidence.find((item) => item.chunkId === source.chunkId) || document.evidence.find((item) => item.text === source.text && (!hasChunk || !identity(item.chunkId)));
      const occurrence = { retrievalId: payload.retrievalId, evidenceId: source.evidenceId };
      if (existing) {
        if (hasChunk && !identity(existing.chunkId)) existing.chunkId = source.chunkId;
        if (!existing.occurrences.some((item) => item.retrievalId === occurrence.retrievalId && item.evidenceId === occurrence.evidenceId)) {
          existing.occurrences.push(occurrence);
        }
      } else document.evidence.push({ ...source, occurrences: [occurrence] });
    }
  }
  return [...documents.values()];
}
var normalizeName = (value) => value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
var extension = /\.(?:md|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|html?)$/iu;
var stripRequest = (value) => value.replace(/^(?:(?:请|帮我|帮忙|麻烦|问知|找一下|查找|找到|找|查询|搜索|检索|查看|一下|给我|打开|下载|文档|文件|名为|叫做|叫|这个|这份|这篇|的)[：:,，\s]*)+/u, "");
function exactFiles(documents, userText) {
  const text = typeof userText === "string" ? userText.normalize("NFKC") : "";
  const quoted = [...text.matchAll(/["“‘`《]([^"”’`》]+)["”’`》]/gu)].map((match) => match[1]);
  const quotedFiles = quoted.filter((value) => extension.test(value.trim()));
  const wholeRequest = stripRequest(text.trim()).replace(/[。!！?？]+$/u, "").trim();
  const requested = (quotedFiles.length ? quotedFiles : extension.test(wholeRequest) ? [wholeRequest] : [...text.matchAll(/[^\s"'“”‘’`《》<>，。！？；：、,;!?()（）]+\.(?:md|pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|html?)(?=$|[\s"'“”‘’`《》<>，。！？；：、,;!?()（）])/giu)].map((match) => stripRequest(match[0]))).map((value) => normalizeName(value.trim()));
  if (requested.length) return { explicit: true, documents: documents.filter((item) => requested.includes(normalizeName(item.documentName))) };
  const fragments = [wholeRequest, ...quoted].map(normalizeName);
  const matches = documents.filter((item) => {
    const name = normalizeName(item.documentName);
    const stem = name.replace(extension, "");
    return fragments.includes(name) || stem !== name && fragments.includes(stem);
  });
  return { explicit: matches.length > 0, documents: matches };
}
function validateSelection(records, args, userText = "") {
  if (!object(args) || !["documents", "knowledge"].includes(args.purpose) || !Array.isArray(args.documentRefs) || args.documentRefs.some((ref) => !identity(ref))) throw new Error("\u5C55\u793A\u9009\u62E9\u683C\u5F0F\u4E0D\u53EF\u7528");
  const documents = collectDocuments(records);
  const refs = new Set(documents.map((document) => document.documentRef));
  if (args.documentRefs.some((ref) => !refs.has(ref))) throw new Error("\u5C55\u793A\u9009\u62E9\u5305\u542B\u4E0D\u5B58\u5728\u6216\u5DF2\u5931\u6548\u7684\u6587\u6863");
  let documentRefs = [...new Set(args.documentRefs)];
  if (args.purpose === "documents") {
    const exact = exactFiles(documents, userText);
    if (exact.explicit && documentRefs.length) {
      if (!exact.documents.length) throw new Error("\u672A\u627E\u5230\u6307\u5B9A\u6587\u4EF6");
      documentRefs = exact.documents.map((document) => document.documentRef);
    }
  }
  const selected = documents.filter((document) => documentRefs.includes(document.documentRef));
  const evidenceIds = new Set(selected.flatMap((document) => document.evidence.flatMap((item) => item.occurrences.map((occurrence) => occurrence.evidenceId))));
  if (args.evidenceIds !== void 0 && (!Array.isArray(args.evidenceIds) || args.evidenceIds.some((id) => !identity(id) || !evidenceIds.has(id)))) throw new Error("\u5C55\u793A\u9009\u62E9\u5305\u542B\u4E0D\u5B58\u5728\u6216\u5DF2\u5931\u6548\u7684\u8BC1\u636E");
  const sourceCallIds = [...new Set(selected.flatMap((document) => document.sourceCallIds))];
  if (args.sourceCallIds !== void 0 && (!Array.isArray(args.sourceCallIds) || args.sourceCallIds.some((id) => !records.some((record) => record.callId === id && record.status === "success")))) {
    throw new Error("\u5C55\u793A\u9009\u62E9\u7684\u6765\u6E90\u8C03\u7528\u5DF2\u5931\u6548");
  }
  return {
    kind: "knowledge-documents-selection",
    purpose: args.purpose,
    documentRefs,
    ...args.evidenceIds !== void 0 ? { evidenceIds: [...new Set(args.evidenceIds)] } : {},
    sourceCallIds: [.../* @__PURE__ */ new Set([...sourceCallIds, ...args.sourceCallIds ?? []])]
  };
}
function buildPanels(records, options = {}) {
  const documents = collectDocuments(records);
  const selection = options.selection?.value ?? options.selection;
  const documentMode = options.documentMode || records.some((record) => record.purpose === "documents" || record.payload?.purpose === "documents");
  let purpose = selection?.purpose ?? (documentMode ? "documents" : "knowledge");
  let selected = documents;
  let notice;
  let evidenceIds;
  if (selection) {
    try {
      const value = validateSelection(records, selection, options.userText);
      purpose = value.purpose;
      selected = documents.filter((document) => value.documentRefs.includes(document.documentRef));
      evidenceIds = value.evidenceIds;
    } catch {
      selected = [];
      notice = purpose === "documents" ? "\u6587\u4EF6\u5019\u9009\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u3002" : "\u6765\u6E90\u9009\u62E9\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u3002";
    }
  } else if (documentMode) {
    const exact = exactFiles(documents, options.userText);
    selected = exact.documents;
    if (!selected.length) notice = exact.explicit ? "\u672A\u627E\u5230\u6307\u5B9A\u6587\u4EF6\u3002" : "\u6587\u4EF6\u5019\u9009\u5C1A\u672A\u786E\u8BA4\uFF0C\u8BF7\u91CD\u8BD5\u3002";
  } else if (!records.some((record) => record.status === "success")) return [];
  const selectedEvidence = evidenceIds === void 0 ? null : new Map(collectDocuments(records.map((record) => record.status !== "success" ? record : { ...record, payload: {
    ...record.payload,
    evidence: record.payload.evidence.filter((item) => evidenceIds.includes(item.evidenceId))
  } })).map((document) => [document.documentRef, document.evidence]));
  const groups = /* @__PURE__ */ new Map();
  for (const source of selected) {
    if (!groups.has(source.knowledgeBaseId)) groups.set(source.knowledgeBaseId, {
      knowledgeBaseId: source.knowledgeBaseId,
      knowledgeBaseName: source.knowledgeBaseName,
      documents: []
    });
    const evidence = purpose === "documents" ? [] : selectedEvidence?.get(source.documentRef) ?? source.evidence;
    groups.get(source.knowledgeBaseId).documents.push({ ...source, evidence });
  }
  return [{ purpose, groups: [...groups.values()], ...notice ? { notice } : {} }];
}
function buildPresentation(records, options = {}) {
  const panels = buildPanels(records, options);
  const selection = options.selection?.value ?? options.selection;
  if (selection) {
    try {
      validateSelection(records, selection, options.userText);
      return { panels, notices: [] };
    } catch {
    }
  }
  if (panels.some((panel) => panel.groups.some((group) => group.documents.length))) return { panels, notices: [] };
  const notices = records.filter((record) => record.status !== "success").map((record) => ({ status: record.status, message: record.message }));
  if (!notices.length) {
    for (const panel of panels) if (panel.notice) notices.push({ status: "unconfirmed", message: panel.notice });
  }
  return { panels, notices };
}
function openState(document, now) {
  if (document?.openStatus === "source_unavailable") return { available: false, label: "\u539F\u6587\u4E0D\u53EF\u7528" };
  if (document?.openStatus === "not_configured") return { available: false, label: "\u539F\u6587\u94FE\u63A5\u672A\u914D\u7F6E" };
  if (document?.openStatus !== "available") return { available: false, label: "\u539F\u6587\u4E0D\u53EF\u7528" };
  const expiresAt = expiry(document.openUrlExpiresAt);
  if (!Number.isFinite(expiresAt)) return { available: false, label: "\u539F\u6587\u4E0D\u53EF\u7528" };
  if (expiresAt <= now) return { available: false, label: "\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22", expiresAt };
  try {
    let url;
    if (document.linkProtocol === "path" || document.openPath != null) {
      let origin;
      try {
        origin = new URL(document.sourceOrigin);
        if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("invalid origin");
      } catch {
        return { available: false, label: "\u65E0\u6CD5\u786E\u5B9A\u539F\u6587\u670D\u52A1\u5730\u5740" };
      }
      if (typeof document.openPath !== "string" || !document.openPath.startsWith("/") || document.openPath.startsWith("//") || /[\\\u0000-\u0020]/u.test(document.openPath)) throw new Error("invalid path");
      url = new URL(document.openPath, origin.origin);
      if (url.origin !== origin.origin) throw new Error("cross-origin path");
    } else {
      if (typeof document.openUrl !== "string") throw new Error("missing URL");
      url = new URL(document.openUrl);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported URL");
    return { available: true, label: "\u67E5\u770B\u539F\u6587", url: url.href, expiresAt };
  } catch {
    return { available: false, label: "\u539F\u6587\u4E0D\u53EF\u7528" };
  }
}
function getDocumentOpenState(document, now = Date.now()) {
  const links = Array.isArray(document?.links) && document.links.length ? document.links : [document];
  let latest;
  for (let index = links.length - 1; index >= 0; index--) {
    const state = openState(links[index], now);
    if (!latest) latest = state;
    if (state.available) return state;
  }
  return latest;
}

// event-projection.js
var KEY = "datahub-knowledge-docs";
var within = (seq, ranges) => typeof seq === "number" && ranges.some((range) => seq >= range.startSeq && seq <= range.endSeq);
var callIdentity = (event) => event.data?.message?.source?.callId ?? event.data?.message?.toolCallId ?? event.data?.callId;
var argumentsOf = (event) => {
  const args = event.data?.arguments ?? event.data?.args ?? {};
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
};
var failed = (value) => Boolean(value && typeof value === "object" && (value.error != null && value.error !== false || value.isError || failed(value.message) || failed(value.result)));
function selectionOf(value) {
  if (typeof value === "string") {
    try {
      return selectionOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || failed(value)) return null;
  if (value.kind === "knowledge-documents-selection") return value;
  for (const key of ["selection", "structuredContent", "result", "message"]) {
    if (value[key] != null) {
      const selection = selectionOf(value[key]);
      if (selection) return selection;
    }
  }
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const selection = block.type === "text" ? selectionOf(block.text) : null;
    if (selection) return selection;
  }
  return null;
}
function valueOf(state) {
  return { turn: state.turn, records: state.records, selections: state.selections, userText: state.userText, documentMode: state.documentMode };
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
    if (parsed.status === "success") record.retrievalId = parsed.payload.retrievalId;
    records.push(record);
  }
  records.sort((a, b) => a.callSeq - b.callSeq);
  const selections = [];
  const results = new Map(state.results);
  for (const [callId, result] of state.results) {
    const call = state.calls.get(callId);
    if (call?.name !== PRESENT_TOOL || !result.selection) continue;
    try {
      const value = validateSelection(records, result.validatedSelection ?? result.selection, state.userText);
      if (!result.validatedSelection) results.set(callId, { ...result, validatedSelection: value });
      selections.push({ seq: result.seq, callId, value });
    } catch {
    }
  }
  selections.sort((a, b) => a.seq - b.seq);
  const documentMode = [...state.calls.values()].some((call) => call.name === RETRIEVE_TOOL && call.purpose === "documents") || records.some((record) => record.payload?.purpose === "documents");
  const next = { ...state, records, results, selections, documentMode };
  return { ...next, value: valueOf(next) };
}
function initial(turn) {
  const state = {
    turn,
    calls: /* @__PURE__ */ new Map(),
    results: /* @__PURE__ */ new Map(),
    full: /* @__PURE__ */ new Map(),
    invalidated: /* @__PURE__ */ new Set(),
    replacedRanges: [],
    userMessages: /* @__PURE__ */ new Map(),
    records: [],
    selections: [],
    userText: "",
    documentMode: false
  };
  return { ...state, value: valueOf(state) };
}
function updateState(state, event) {
  if (!state || event.data?.turn != null && event.data.turn !== state.turn) return state;
  if (event.surfaceOp?.op === "replace") {
    const { startSeq, endSeq } = event.surfaceOp;
    if (typeof startSeq !== "number" || typeof endSeq !== "number" || startSeq > endSeq) return state;
    const range = { startSeq, endSeq };
    const invalidated = new Set(state.invalidated);
    for (const [callId2, call2] of state.calls) {
      if (within(call2.callSeq, [range]) || within(state.results.get(callId2)?.seq, [range]) || within(state.full.get(callId2)?.seq, [range])) invalidated.add(callId2);
    }
    const keep = (map) => new Map([...map].filter(([callId2]) => !invalidated.has(callId2)));
    const userMessages = new Map([...state.userMessages].filter(([seq]) => !within(seq, [range])));
    return refresh({
      ...state,
      calls: keep(state.calls),
      results: keep(state.results),
      full: keep(state.full),
      invalidated,
      replacedRanges: [...state.replacedRanges, range],
      userMessages,
      userText: [...userMessages.values()].join("\n")
    });
  }
  if (event.type === "user/message") {
    if (within(event.seq, state.replacedRanges) || state.userMessages.has(event.seq)) return state;
    const content = event.data?.content ?? event.data?.message?.content;
    const text = (Array.isArray(content) ? content : []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    if (!text) return state;
    const userMessages = new Map([...state.userMessages, [event.seq, text]]);
    return refresh({ ...state, userMessages, userText: [...userMessages.values()].join("\n") });
  }
  if (event.type === "tool/call") {
    const { callId: callId2, name } = event.data;
    if (![RETRIEVE_TOOL, PRESENT_TOOL].includes(name) || typeof callId2 !== "string" || !callId2 || state.calls.has(callId2) || state.invalidated.has(callId2) || within(event.seq, state.replacedRanges)) return state;
    const args = argumentsOf(event);
    return refresh({ ...state, calls: new Map([...state.calls, [callId2, { callSeq: event.seq, name, purpose: args?.purpose }]]) });
  }
  if (event.type === RECORD_TYPE) {
    const data = event.data;
    if (data?.version !== 1 || data.turn !== state.turn || typeof data.callId !== "string" || typeof data.callSeq !== "number" || state.invalidated.has(data.callId) || state.full.has(data.callId) || within(data.callSeq, state.replacedRanges) || within(event.seq, state.replacedRanges)) return state;
    const call2 = state.calls.get(data.callId);
    if (call2 && (call2.name !== RETRIEVE_TOOL || call2.callSeq !== data.callSeq)) return state;
    const parsed2 = data.status === "success" ? readKnowledgeResult(data.payload) : ["error", "unsupported", "invalid", "truncated"].includes(data.status) ? { status: data.status, message: data.message } : null;
    if (!parsed2) return state;
    return refresh({ ...state, full: new Map([...state.full, [data.callId, { seq: event.seq, callSeq: data.callSeq, parsed: parsed2 }]]) });
  }
  if (event.type !== "tool/result" || event.surfaceOp !== "append") return state;
  const callId = callIdentity(event);
  const call = state.calls.get(callId);
  if (!call || state.results.has(callId) || state.invalidated.has(callId)) return state;
  if (within(event.seq, state.replacedRanges) || within(call.callSeq, state.replacedRanges)) {
    return refresh({
      ...state,
      calls: new Map([...state.calls].filter(([id]) => id !== callId)),
      invalidated: /* @__PURE__ */ new Set([...state.invalidated, callId])
    });
  }
  if (typeof event.seq === "number" && event.seq <= call.callSeq) return state;
  const parsed = readKnowledgeResult(event.data);
  const result = {
    seq: event.seq,
    failed: failed(event.data) || parsed.status === "error",
    parsed,
    selection: call.name === PRESENT_TOOL ? selectionOf(event.data) : null,
    messageId: event.data.messageId ?? event.data.message?.messageId ?? event.data.message?.id
  };
  return refresh({ ...state, results: new Map([...state.results, [callId, result]]) });
}
var userTextDefinition = {
  kind: `${KEY}/user-text`,
  match(event) {
    if (!["turn/start", "user/message"].includes(event.type)) return null;
    return { id: String(event.seq), role: "start" };
  },
  start(_context, match, reader) {
    if (match.event.type === "turn/start") return { turn: match.event.data?.turn, text: "" };
    const previous = reader?.previous(userTextDefinition.kind)?.state;
    const content = match.event.data?.content ?? match.event.data?.message?.content;
    const text = (Array.isArray(content) ? content : []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    return { turn: match.event.data?.turn ?? previous?.turn, text: [previous?.text, text].filter(Boolean).join("\n") };
  },
  update(context) {
    return context.state;
  }
};
var definition = {
  kind: KEY,
  match(event) {
    if (event.data?.turn == null) return null;
    if (event.type === "tool/call" && [RETRIEVE_TOOL, PRESENT_TOOL].includes(event.data.name)) {
      return { id: String(event.data.turn), role: "start" };
    }
    if (["tool/result", RECORD_TYPE].includes(event.type) || event.surfaceOp?.op === "replace") {
      return { id: String(event.data.turn), role: "start" };
    }
    return null;
  },
  start(_context, match, reader) {
    const state = initial(match.event.data.turn);
    const user = reader?.previous(userTextDefinition.kind)?.state;
    const text = user?.turn === state.turn ? user.text : "";
    return updateState({ ...state, userText: text }, match.event);
  },
  update(context, match) {
    return updateState(context.state, match.event);
  },
  buildLocationData(context, scope, previous) {
    const state = context.state;
    if (scope !== "turn" || !state) return null;
    if (previous?.kind === "turn" && previous.turn === state.turn && previous.value === state.value) return previous;
    return { kind: "turn", turn: state.turn, key: KEY, value: state.value };
  }
};

// build/client-entry.js
var h = import_react.default.createElement;
var css = `
.kd-docs{--kd-muted:var(--dsw-alias-label-secondary,#85817a);--kd-border:var(--dsw-alias-border-l1,#e8e5df);color:var(--dsw-alias-label-primary,#302d28);margin:24px 0 12px;font-size:13px;line-height:1.65}
.kd-docs *{box-sizing:border-box}.kd-docs section+section{margin-top:24px}
.kd-header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:5px 18px;margin-bottom:13px}.kd-title{font-size:14px;font-weight:650;margin:0}.kd-note{color:var(--kd-muted);font-size:12px;margin:0}
.kd-group+.kd-group{margin-top:18px}.kd-base{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;font-size:12px;color:var(--kd-muted)}.kd-base strong{font-weight:550;color:inherit}
.kd-list{list-style:none;padding:0;margin:0;display:grid;gap:8px}.kd-row{border:1px solid var(--kd-border);border-radius:7px;overflow:hidden;background:transparent}
.kd-document{display:flex;align-items:center;gap:10px;padding:9px 12px;min-width:0}.kd-icon{flex:none;color:var(--kd-muted);width:15px;height:18px}.kd-name{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px;font-weight:500}
.kd-open{font:inherit;font-size:12px;border:0;border-radius:3px;background:transparent;color:var(--kd-muted);padding:3px 0 3px 10px;cursor:pointer;white-space:nowrap;flex:none}.kd-open:hover:not(:disabled){color:var(--dsw-alias-label-primary,#302d28);text-decoration:underline;text-underline-offset:3px}.kd-open:disabled{cursor:default;white-space:normal;max-width:180px;text-align:right;opacity:.8}.kd-docs button:focus-visible,.kd-docs summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.kd-evidence{border-top:1px solid var(--kd-border);font-size:12px}.kd-evidence summary{cursor:pointer;color:var(--kd-muted);padding:7px 12px;list-style-position:inside}.kd-evidence[open] summary{border-bottom:1px solid var(--kd-border)}.kd-evidence ol{list-style:none;padding:0 12px;margin:0;max-height:360px;overflow:auto}.kd-fragment{margin:0;padding:12px 0}.kd-fragment+.kd-fragment{border-top:1px solid var(--kd-border)}.kd-fragment-label{display:block;color:var(--kd-muted);font-size:11px;margin-bottom:5px}.kd-fragment p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8}.kd-status{font-size:12px;color:var(--kd-muted);padding:10px 12px;border:1px solid var(--kd-border);border-radius:7px;margin:8px 0}
.kd-error{color:var(--dsw-alias-label-secondary,#85817a);font-size:12px;margin:0;padding:0 12px 9px;overflow-wrap:anywhere}
.kd-more{display:block;margin:12px auto 0;padding:6px 12px;border:0;border-radius:5px;background:transparent;color:var(--kd-muted);font:inherit;font-size:12px;cursor:pointer}.kd-more:hover{background:var(--dsw-alias-bg-layer-1,#f0eee9);color:var(--dsw-alias-label-primary,#302d28)}
@media(max-width:520px){.kd-document{align-items:flex-start;flex-wrap:wrap;padding:10px}.kd-name{flex-basis:calc(100% - 26px)}.kd-open{margin-left:25px;padding:0;text-align:left!important;max-width:none!important}.kd-header{display:block}.kd-note{margin-top:5px}}
`;
function FileIcon() {
  return h(
    "svg",
    { className: "kd-icon", viewBox: "0 0 18 22", fill: "none", stroke: "currentColor", strokeWidth: 1.2, "aria-hidden": true },
    h("path", { d: "M10 2H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" }),
    h("path", { d: "M10 2v5h5M6 11h6M6 14h6M6 17h4" })
  );
}
function DocumentRow({ document, purpose, turn, sessionId, connection, sidebarRight }) {
  const [, refresh2] = import_react.default.useState(0);
  const [loading, setLoading] = import_react.default.useState(false);
  const [error, setError] = import_react.default.useState("");
  const pending = import_react.default.useRef(null);
  const identity2 = JSON.stringify([sessionId, turn, document.documentRef, document.sourceCallIds]);
  const currentIdentity = import_react.default.useRef(identity2);
  currentIdentity.current = identity2;
  const openState2 = getDocumentOpenState(document);
  import_react.default.useEffect(() => {
    if (!openState2.available || !Number.isFinite(openState2.expiresAt)) return;
    const delay = Math.min(2147483647, Math.max(1, openState2.expiresAt - Date.now()));
    const timer = setTimeout(() => refresh2((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [document, openState2.available, openState2.expiresAt]);
  import_react.default.useEffect(() => {
    setLoading(false);
    setError("");
    const unsubscribe = sidebarRight.mounted.subscribe(() => {
      if (sidebarRight.mounted.getSnapshot() !== sessionId && pending.current) {
        pending.current.abort();
        pending.current = null;
        setLoading(false);
      }
    });
    return () => {
      unsubscribe();
      pending.current?.abort();
      pending.current = null;
    };
  }, [identity2, sidebarRight]);
  const open = async () => {
    if (pending.current) return;
    const current = getDocumentOpenState(document);
    if (!current.available) {
      refresh2((value) => value + 1);
      return;
    }
    const clickedSession = sidebarRight.mounted.getSnapshot();
    const callId = document.sourceCallIds?.find((id) => typeof id === "string" && id.length);
    if (!clickedSession || clickedSession !== sessionId || turn == null || !callId) {
      setError("\u539F\u6587\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u3002");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    const active = () => !controller.signal.aborted && pending.current === controller && currentIdentity.current === identity2 && sidebarRight.mounted.getSnapshot() === clickedSession;
    try {
      const response = await connection.rpc.call("/api", "knowledgeDocs/cacheOriginal", {
        args: { sessionId: clickedSession, turn, callId, documentRef: document.documentRef }
      }, controller.signal);
      if (!active()) return;
      if (!response?.ok) {
        setError(originalError(response?.error?.code));
        return;
      }
      const value = response.value;
      if (value?.sessionId !== clickedSession || typeof value.absolutePath !== "string" || !value.absolutePath) {
        setError("\u539F\u6587\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        return;
      }
      const address = fileAddressFor(clickedSession, void 0, value.absolutePath);
      if (active()) sidebarRight.openResource(address, { destination: "sidebar" });
    } catch {
      if (active()) setError("\u539F\u6587\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  };
  const evidence = purpose === "knowledge" ? document.evidence || [] : [];
  const label = loading ? "\u52A0\u8F7D\u4E2D\u2026" : openState2.label;
  return h(
    "li",
    { className: "kd-row", "data-document-ref": document.documentRef },
    h(
      "div",
      { className: "kd-document" },
      h(FileIcon),
      h("span", { className: "kd-name" }, document.documentName),
      h("button", { type: "button", className: "kd-open", disabled: loading || !openState2.available, onClick: open, "aria-label": `${label}\uFF1A${document.documentName}` }, label)
    ),
    error ? h("p", { className: "kd-error", role: "alert" }, error) : null,
    evidence.length ? h(
      "details",
      { className: "kd-evidence" },
      h("summary", null, `\u68C0\u7D22\u7247\u6BB5 ${evidence.length} \u6761`),
      h("ol", null, ...evidence.map((item, index) => h(
        "li",
        { key: index, className: "kd-fragment" },
        h("span", { className: "kd-fragment-label" }, `\u7247\u6BB5 ${index + 1}`),
        h("p", null, item.text)
      )))
    ) : null
  );
}
function originalError(code) {
  return {
    LINK_EXPIRED: "\u94FE\u63A5\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u3002",
    SOURCE_UNAVAILABLE: "\u539F\u6587\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u3002",
    TOO_LARGE: "\u6587\u4EF6\u8D85\u8FC7\u9884\u89C8\u4E0A\u9650\u3002",
    ACCESS_DENIED: "\u65E0\u4F1A\u8BDD\u8BBF\u95EE\u6743\u9650\u3002",
    "remote-access/denied": "\u65E0\u4F1A\u8BDD\u8BBF\u95EE\u6743\u9650\u3002",
    CACHE_ERROR: "\u539F\u6587\u7F13\u5B58\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    DOWNLOAD_FAILED: "\u539F\u6587\u4E0B\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    TIMEOUT: "\u539F\u6587\u4E0B\u8F7D\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5\u3002"
  }[code] || "\u539F\u6587\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002";
}
function Panel({ panel, turn, sessionId, connection, sidebarRight }) {
  const [expanded, setExpanded] = import_react.default.useState(false);
  const listId = import_react.default.useId();
  const finding = panel.purpose === "documents";
  const title = finding ? "\u627E\u5230\u7684\u6587\u6863" : "\u68C0\u7D22\u6765\u6E90";
  const total = panel.groups.reduce((count, group) => count + group.documents.length, 0);
  let remaining = expanded ? total : 5;
  const groups = panel.groups.map((group) => {
    const documents = group.documents.slice(0, remaining);
    remaining -= documents.length;
    return { ...group, documents };
  }).filter((group) => group.documents.length);
  return h(
    "section",
    { "aria-label": title },
    h(
      "div",
      { className: "kd-header" },
      h("h3", { className: "kd-title" }, title),
      h("p", { className: "kd-note" }, finding ? "\u70B9\u51FB\u201C\u67E5\u770B\u539F\u6587\u201D\u6253\u5F00\u6587\u4EF6\u3002" : "\u4EE5\u4E0B\u6587\u6863\u6765\u81EA\u672C\u6B21\u68C0\u7D22\u3002")
    ),
    h("div", { id: listId }, groups.length ? groups.map((group) => h(
      "div",
      { className: "kd-group", key: group.knowledgeBaseId },
      h("p", { className: "kd-base" }, h("span", null, "\u77E5\u8BC6\u5E93"), h("strong", null, group.knowledgeBaseName || "\u672A\u547D\u540D\u77E5\u8BC6\u5E93")),
      h("ul", { className: "kd-list" }, ...group.documents.map((document) => h(DocumentRow, { key: document.documentRef, document, purpose: panel.purpose, turn, sessionId, connection, sidebarRight })))
    )) : h("p", { className: "kd-status", role: "status" }, panel.notice || (finding ? "\u672A\u627E\u5230\u76F8\u5173\u6587\u6863\u3002" : "\u672C\u6B21\u68C0\u7D22\u6CA1\u6709\u627E\u5230\u76F8\u5173\u6765\u6E90\u3002"))),
    total > 5 ? h("button", {
      type: "button",
      className: "kd-more",
      "aria-expanded": expanded,
      "aria-controls": listId,
      onClick: () => setExpanded((value) => !value)
    }, expanded ? "\u6536\u8D77\u6587\u6863\u5217\u8868 \u2191" : `\u5C55\u5F00\u5176\u4F59 ${total - 5} \u4EFD\u6587\u6863 \u2193`) : null
  );
}
function TurnTail({ turn, connection, sidebarRight }) {
  const subscribe = import_react.default.useCallback((listener) => sidebarRight.mounted.subscribe(listener), [sidebarRight]);
  const getSnapshot = import_react.default.useCallback(() => sidebarRight.mounted.getSnapshot(), [sidebarRight]);
  const sessionId = import_react.default.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const data = turn.data.get(KEY);
  const state = Array.isArray(data) ? { records: data } : data || { records: [] };
  const selection = state.selections?.at(-1)?.value;
  const { panels, notices } = buildPresentation(state.records, {
    userText: state.userText || "",
    documentMode: state.documentMode,
    selection
  });
  if (!panels.length && !notices.length) return null;
  const panelKey = (panel) => `${panel.purpose}:${panel.groups.flatMap((group) => group.documents.map((document) => document.documentRef)).join("|")}`;
  const noticeText = (notice) => ({
    error: "\u95EE\u77E5\u68C0\u7D22\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
    unsupported: "\u5F53\u524D\u95EE\u77E5\u63A5\u53E3\u672A\u63D0\u4F9B\u6587\u6863\u5C55\u793A\u6570\u636E\u3002",
    invalid: "\u95EE\u77E5\u7ED3\u679C\u6570\u636E\u635F\u574F\uFF0C\u65E0\u6CD5\u5C55\u793A\u6587\u6863\u3002",
    truncated: "\u5386\u53F2\u68C0\u7D22\u7ED3\u679C\u5DF2\u88AB\u622A\u77ED\uFF0C\u8BF7\u91CD\u65B0\u68C0\u7D22\u4EE5\u5C55\u793A\u5B8C\u6574\u6765\u6E90\u3002"
  })[notice.status] || notice.message;
  return h(
    "div",
    { className: "kd-docs" },
    h("style", null, css),
    ...panels.map((panel) => h(Panel, { key: panelKey(panel), panel, turn: turn.turn ?? state.turn, sessionId, connection, sidebarRight })),
    ...notices.filter((notice) => !panels.some((panel) => panel.notice === notice.message)).map((notice, index) => h("p", { key: index, className: "kd-status", role: "status" }, noticeText(notice)))
  );
}
var inject = ["slots", "uiConversation", "connection", "sidebarRight"];
function apply(ctx) {
  ctx.uiConversation.events.register(userTextDefinition);
  ctx.uiConversation.events.register(definition);
  const ConnectedTurnTail = (props) => h(TurnTail, { ...props, connection: ctx.connection, sidebarRight: ctx.sidebarRight });
  ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({ name: "conversation.chat.turnTail", id: KEY, order: 20 }, ConnectedTurnTail));
}

return module.exports;}});
