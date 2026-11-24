// @local/contract-sure DSH web client bundle (zero JSX/TS, zero third-party deps)
// Registers:
//   1. settings.section (id="contract-sure-settings", label="履约无忧配置", order=30)
//   2. conversation.chat.turnTail (id="contract-sure-cards", order=25)
//      - Interactive "合同识别核对卡" (editable fields + validation banner + one-click confirm)
//      - "合同与票据原件" document list with built-in sidebarRight reader preview

window.__ModuleLoader__.load({
  id: "@local/contract-sure",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var React = react && react.default ? react.default : react;
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var useRef = React.useRef;

    var KEY = "contract-sure";
    var NS = "contract-sure";
    var DRAFT_RECORD_TYPE = "plugin:contract-sure/draft";
    var DRAFT_CONFIRMED_RECORD_TYPE = "plugin:contract-sure/draft-confirmed";
    var DETAIL_RECORD_TYPE = "plugin:contract-sure/detail";
    var STAGE_DRAFT_TOOL = "contract_stage_draft";
    var CONFIRM_SAVE_TOOL = "contract_confirm_save";
    var QUERY_TOOL = "contract_query";
    var FILE_ADDRESS_PREFIX = "dsh-resource://file/";

    var DEFAULT_SETTINGS = {
      serverUrl: "http://localhost:8081/api/v1",
      apiToken: "",
      ocrApiUrl: "https://api.deepseek.com/v1/tools/ocr",
      ocrApiKey: "",
    };

    var EVENT_LABELS = {
      INVOICE_RECEIVED: "收到/开具发票",
      ACCEPTANCE_PASSED: "验收通过",
      CONTRACT_SIGNED: "合同签订",
      DELIVERY_COMPLETED: "交付完成",
      PAYMENT_RECEIVED: "收付款完成",
    };

    var DOC_TYPE_LABELS = {
      1: "合同原件",
      2: "发票",
      3: "收付款凭证",
      4: "验收材料",
    };

    var CSS = [
      ".cs-wrap{--cs-border:var(--dsw-alias-border-l2,#e2dfd8);--cs-border-strong:var(--dsw-alias-border-l4,#cfcac0);--cs-bg:var(--dsw-alias-bg-layer-2,#faf9f7);--cs-bg-input:var(--dsw-alias-bg-layer-3,#ffffff);--cs-text:var(--dsw-alias-label-primary,#262420);--cs-muted:var(--dsw-alias-label-secondary,#6e6a63);--cs-subtle:var(--dsw-alias-label-tertiary,#959087);--cs-brand:var(--dsw-alias-brand-primary,#2b6cb0);color:var(--cs-text);font-size:13px;line-height:1.55;margin:16px 0 8px}",
      ".cs-wrap *{box-sizing:border-box}",
      ".cs-card{border:1px solid var(--cs-border);border-radius:10px;background:var(--cs-bg);padding:14px 16px;margin-bottom:12px}",
      ".cs-card-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--cs-border)}",
      ".cs-card-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:650;margin:0}",
      ".cs-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}",
      ".cs-pill-ok{background:var(--dsw-alias-bg-success,rgba(34,139,34,.12));color:var(--dsw-alias-label-success,#1f7a38)}",
      ".cs-pill-warn{background:var(--dsw-alias-bg-warning,rgba(217,119,6,.14));color:var(--dsw-alias-label-warning,#b45309)}",
      ".cs-pill-type{background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--cs-muted)}",
      ".cs-banner{padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:12px;line-height:1.55}",
      ".cs-banner-warn{background:var(--dsw-alias-bg-warning,rgba(217,119,6,.12));color:var(--dsw-alias-label-warning,#92400e);border:1px solid rgba(217,119,6,.25)}",
      ".cs-banner-ok{background:var(--dsw-alias-bg-success,rgba(34,139,34,.12));color:var(--dsw-alias-label-success,#1f7a38);border:1px solid rgba(34,139,34,.25)}",
      ".cs-banner-err{background:var(--dsw-alias-bg-danger,rgba(200,40,40,.12));color:var(--dsw-alias-label-error,#b91c1c);border:1px solid rgba(200,40,40,.25)}",
      ".cs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px;margin-bottom:12px}",
      "@media(max-width:600px){.cs-grid{grid-template-columns:1fr}}",
      ".cs-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".cs-field label{font-size:11px;color:var(--cs-muted);font-weight:500}",
      ".cs-input,.cs-select{width:100%;height:32px;padding:0 10px;font-size:13px;border:1px solid var(--cs-border-strong);border-radius:6px;background:var(--cs-bg-input);color:var(--cs-text)}",
      ".cs-input:disabled,.cs-select:disabled{opacity:.7;cursor:not-allowed}",
      ".cs-table-wrap{overflow-x:auto;border:1px solid var(--cs-border);border-radius:8px;margin-bottom:10px;background:var(--cs-bg-input)}",
      ".cs-table{width:100%;border-collapse:collapse;font-size:12px}",
      ".cs-table th,.cs-table td{padding:7px 9px;border-bottom:1px solid var(--cs-border);text-align:left;vertical-align:top}",
      ".cs-table tr:last-child td{border-bottom:0}",
      ".cs-table th{font-weight:600;color:var(--cs-muted);background:var(--cs-bg);white-space:nowrap}",
      ".cs-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".cs-rule-tag{display:inline-block;padding:2px 6px;border-radius:4px;font-size:11px;background:var(--dsw-alias-bg-layer-1,rgba(43,108,176,.1));color:var(--cs-brand)}",
      ".cs-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:10px}",
      ".cs-meta{font-size:12px;color:var(--cs-muted)}",
      ".cs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;border:1px solid var(--cs-border-strong);cursor:pointer;background:var(--cs-bg-input);color:var(--cs-text)}",
      ".cs-btn-primary{background:var(--cs-brand);border-color:var(--cs-brand);color:#fff}",
      ".cs-btn:disabled{opacity:.6;cursor:not-allowed}",
      ".cs-doc-list{list-style:none;padding:0;margin:0;display:grid;gap:8px}",
      ".cs-doc-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--cs-border);border-radius:7px;background:var(--cs-bg-input)}",
      ".cs-doc-name{flex:1;min-width:0;overflow-wrap:anywhere;font-weight:500}",
      ".cs-doc-size{font-size:11px;color:var(--cs-subtle);white-space:nowrap}",
      ".cs-doc-open{font:inherit;font-size:12px;padding:3px 10px;border-radius:5px;border:1px solid var(--cs-border-strong);background:transparent;color:var(--cs-brand);cursor:pointer;white-space:nowrap}",
      ".cs-doc-open:disabled{opacity:.6;cursor:default}",
    ].join("\n");

    // ---- File address helpers (matching DSH sidebarRight protocol) ----
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }
    function encodePath(p) {
      return String(p || "").split("/").map(encodeSegment).join("/");
    }
    function fileAddressFor(sessionId, absolutePath) {
      var normalized = String(absolutePath || "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      return FILE_ADDRESS_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(normalized);
    }

    function basenameOf(p) {
      if (typeof p !== "string") return "";
      var parts = p.split(/[\\/]/);
      return parts[parts.length - 1] || p;
    }

    function formatAmount(value) {
      var num = Number(value);
      if (!Number.isFinite(num)) return "-";
      return num.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatFileSize(bytes) {
      var n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function formatSingleCondition(event, offsetDays, offsetType) {
      var evLabel = EVENT_LABELS[event] || event || "指定事件";
      var days = Number(offsetDays);
      var unit = offsetType === "WORKDAY" ? "个工作日" : "个自然日";
      if (Number.isFinite(days) && days > 0) {
        return evLabel + "后 +" + days + unit;
      }
      return evLabel + "当日";
    }

    function formatTriggerRule(rule) {
      if (!rule) return "未设置";
      var obj = rule;
      if (typeof rule === "string") {
        try {
          obj = JSON.parse(rule);
        } catch (_) {
          return rule;
        }
      }
      if (!obj || typeof obj !== "object") return "未设置";
      if (obj.triggerType === "FIXED_DATE") return "固定日期";
      if (obj.triggerType === "MANUAL") return "人工指定日期";
      if (Array.isArray(obj.conditions) && obj.conditions.length > 0 && (obj.logic === "MAX" || obj.logic === "AND" || obj.logic === "MIN" || obj.logic === "OR")) {
        var isMax = obj.logic === "MAX" || obj.logic === "AND";
        var parts = obj.conditions.map(function (c) {
          return formatSingleCondition(c.event, c.offsetDays, c.offsetType);
        });
        return (isMax ? "取较晚：" : "取较早：") + parts.join(isMax ? " 且 " : " 或 ");
      }
      if (obj.triggerEvent) {
        return formatSingleCondition(obj.triggerEvent, obj.offsetDays, obj.offsetType);
      }
      return obj.triggerType || "自定义规则";
    }

    // ---- Session Event Projection (mirrors event-projection.js) ----
    function withinRanges(seq, ranges) {
      if (typeof seq !== "number") return false;
      for (var i = 0; i < ranges.length; i++) {
        if (seq >= ranges[i].startSeq && seq <= ranges[i].endSeq) return true;
      }
      return false;
    }

    function callIdentity(event) {
      var d = event && event.data;
      if (!d) return undefined;
      if (d.message && d.message.source && d.message.source.callId) return d.message.source.callId;
      if (d.message && d.message.toolCallId) return d.message.toolCallId;
      return d.callId;
    }

    function isFailedValue(value) {
      if (!value || typeof value !== "object") return false;
      if (value.error != null && value.error !== false) return true;
      if (value.isError) return true;
      if (value.message && isFailedValue(value.message)) return true;
      if (value.result && isFailedValue(value.result)) return true;
      return false;
    }

    function extractPayloadByKind(value, kinds) {
      if (typeof value === "string") {
        try {
          return extractPayloadByKind(JSON.parse(value), kinds);
        } catch (_) {
          return null;
        }
      }
      if (!value || typeof value !== "object" || isFailedValue(value)) return null;
      if (typeof value.kind === "string" && kinds.indexOf(value.kind) !== -1) return value;
      var keys = ["structuredContent", "value", "result", "message"];
      for (var i = 0; i < keys.length; i++) {
        if (value[keys[i]] != null) {
          var found = extractPayloadByKind(value[keys[i]], kinds);
          if (found) return found;
        }
      }
      if (Array.isArray(value.content)) {
        for (var j = 0; j < value.content.length; j++) {
          var block = value.content[j];
          if (block && block.type === "text" && typeof block.text === "string") {
            var foundText = extractPayloadByKind(block.text, kinds);
            if (foundText) return foundText;
          }
        }
      }
      return null;
    }

    function projectionValueOf(state) {
      return {
        turn: state.turn,
        drafts: state.drafts,
        confirmedByDraftId: state.confirmedByDraftId,
        details: state.details,
      };
    }

    function refreshProjection(state) {
      var draftMap = new Map();
      var confirmedByDraftId = {};
      var detailMap = new Map();

      for (var i = 0; i < state.pluginRecords.length; i++) {
        var rec = state.pluginRecords[i];
        if (rec.type === DRAFT_RECORD_TYPE && rec.data && rec.data.draftId) {
          draftMap.set(rec.data.draftId, {
            seq: rec.seq,
            draftId: rec.data.draftId,
            draft: rec.data.draft,
            sourceFilePath: rec.data.sourceFilePath || null,
            validation: rec.data.validation || null,
            status: rec.data.status || "staged",
          });
        } else if (rec.type === DRAFT_CONFIRMED_RECORD_TYPE && rec.data && rec.data.draftId) {
          confirmedByDraftId[rec.data.draftId] = {
            contractId: rec.data.contractId,
            uploadedDoc: rec.data.uploadedDoc || null,
            uploadWarning: rec.data.uploadWarning || null,
          };
        } else if (rec.type === DETAIL_RECORD_TYPE && rec.data && rec.data.contractId != null) {
          detailMap.set(String(rec.data.contractId), {
            seq: rec.seq,
            contractId: rec.data.contractId,
            contractNo: rec.data.contractNo || "",
            contractName: rec.data.contractName || "",
            documents: Array.isArray(rec.data.documents) ? rec.data.documents : [],
          });
        }
      }

      state.calls.forEach(function (call, callId) {
        var result = state.results.get(callId);
        if (!result || result.failed || !result.payload) return;
        var p = result.payload;
        if (call.name === STAGE_DRAFT_TOOL && p.kind === "contract-sure-draft" && p.draftId) {
          if (!draftMap.has(p.draftId)) {
            draftMap.set(p.draftId, {
              seq: result.seq,
              draftId: p.draftId,
              draft: p.draft,
              sourceFilePath: p.sourceFilePath || null,
              validation: p.validation || null,
              status: p.status || "staged",
            });
          }
        } else if (call.name === CONFIRM_SAVE_TOOL && p.kind === "contract-sure-confirmed" && p.draftId) {
          confirmedByDraftId[p.draftId] = {
            contractId: p.contractId,
            uploadedDoc: p.uploadedDoc || null,
            uploadWarning: p.uploadWarning || null,
          };
        } else if (call.name === QUERY_TOOL && p.kind === "contract-sure-detail" && p.contract && p.contract.id != null) {
          var cid = String(p.contract.id);
          if (!detailMap.has(cid)) {
            detailMap.set(cid, {
              seq: result.seq,
              contractId: p.contract.id,
              contractNo: p.contract.contractNo || "",
              contractName: p.contract.contractName || "",
              documents: Array.isArray(p.documents) ? p.documents : [],
            });
          }
        }
      });

      var drafts = Array.from(draftMap.values()).sort(function (a, b) {
        return (a.seq || 0) - (b.seq || 0);
      });
      var details = Array.from(detailMap.values()).sort(function (a, b) {
        return (a.seq || 0) - (b.seq || 0);
      });
      var next = Object.assign({}, state, {
        drafts: drafts,
        confirmedByDraftId: confirmedByDraftId,
        details: details,
      });
      next.value = projectionValueOf(next);
      return next;
    }

    function initialProjection(turn) {
      var st = {
        turn: turn,
        calls: new Map(),
        results: new Map(),
        pluginRecords: [],
        invalidated: new Set(),
        replacedRanges: [],
        drafts: [],
        confirmedByDraftId: {},
        details: [],
      };
      st.value = projectionValueOf(st);
      return st;
    }

    function updateProjection(state, event) {
      if (!state || (event.data && event.data.turn != null && event.data.turn !== state.turn)) return state;
      if (event.surfaceOp && event.surfaceOp.op === "replace") {
        var startSeq = event.surfaceOp.startSeq;
        var endSeq = event.surfaceOp.endSeq;
        if (typeof startSeq !== "number" || typeof endSeq !== "number" || startSeq > endSeq) return state;
        var range = { startSeq: startSeq, endSeq: endSeq };
        var invalidated = new Set(state.invalidated);
        state.calls.forEach(function (call, id) {
          var res = state.results.get(id);
          if (withinRanges(call.callSeq, [range]) || (res && withinRanges(res.seq, [range]))) {
            invalidated.add(id);
          }
        });
        var nextCalls = new Map();
        state.calls.forEach(function (v, k) { if (!invalidated.has(k)) nextCalls.set(k, v); });
        var nextResults = new Map();
        state.results.forEach(function (v, k) { if (!invalidated.has(k)) nextResults.set(k, v); });
        var nextRecords = state.pluginRecords.filter(function (rec) {
          return !withinRanges(rec.seq, [range]) && !withinRanges(rec.data && rec.data.callSeq, [range]);
        });
        return refreshProjection(Object.assign({}, state, {
          calls: nextCalls,
          results: nextResults,
          pluginRecords: nextRecords,
          invalidated: invalidated,
          replacedRanges: state.replacedRanges.concat([range]),
        }));
      }

      if (event.type === DRAFT_RECORD_TYPE || event.type === DRAFT_CONFIRMED_RECORD_TYPE || event.type === DETAIL_RECORD_TYPE) {
        if (withinRanges(event.seq, state.replacedRanges) || withinRanges(event.data && event.data.callSeq, state.replacedRanges)) {
          return state;
        }
        for (var r = 0; r < state.pluginRecords.length; r++) {
          if (state.pluginRecords[r].seq === event.seq && state.pluginRecords[r].type === event.type) return state;
        }
        return refreshProjection(Object.assign({}, state, {
          pluginRecords: state.pluginRecords.concat([{ type: event.type, seq: event.seq, data: event.data }]),
        }));
      }

      if (event.type === "tool/call") {
        var callData = event.data || {};
        var name = callData.name;
        var cid = callData.callId;
        if (
          (name !== STAGE_DRAFT_TOOL && name !== CONFIRM_SAVE_TOOL && name !== QUERY_TOOL) ||
          typeof cid !== "string" || !cid ||
          state.calls.has(cid) || state.invalidated.has(cid) ||
          withinRanges(event.seq, state.replacedRanges)
        ) {
          return state;
        }
        var callsCopy = new Map(state.calls);
        callsCopy.set(cid, { callSeq: event.seq, name: name });
        return refreshProjection(Object.assign({}, state, { calls: callsCopy }));
      }

      if (event.type !== "tool/result" || event.surfaceOp !== "append") return state;
      var resCallId = callIdentity(event);
      var callItem = state.calls.get(resCallId);
      if (!callItem || state.results.has(resCallId) || state.invalidated.has(resCallId)) return state;
      if (withinRanges(event.seq, state.replacedRanges) || withinRanges(callItem.callSeq, state.replacedRanges)) return state;
      if (typeof event.seq === "number" && event.seq <= callItem.callSeq) return state;

      var failedFlag = isFailedValue(event.data);
      var payload = failedFlag
        ? null
        : extractPayloadByKind(event.data, ["contract-sure-draft", "contract-sure-confirmed", "contract-sure-detail"]);
      var resultsCopy = new Map(state.results);
      resultsCopy.set(resCallId, { seq: event.seq, failed: failedFlag, payload: payload });
      return refreshProjection(Object.assign({}, state, { results: resultsCopy }));
    }

    var eventDefinition = {
      kind: KEY,
      match: function (event) {
        if (!event || !event.data || event.data.turn == null) return null;
        if (
          event.type === "tool/call" &&
          (event.data.name === STAGE_DRAFT_TOOL || event.data.name === CONFIRM_SAVE_TOOL || event.data.name === QUERY_TOOL)
        ) {
          return { id: String(event.data.turn), role: "start" };
        }
        if (
          event.type === "tool/result" ||
          event.type === DRAFT_RECORD_TYPE ||
          event.type === DRAFT_CONFIRMED_RECORD_TYPE ||
          event.type === DETAIL_RECORD_TYPE ||
          (event.surfaceOp && event.surfaceOp.op === "replace")
        ) {
          return { id: String(event.data.turn), role: "start" };
        }
        return null;
      },
      start: function (_context, match) {
        return updateProjection(initialProjection(match.event.data.turn), match.event);
      },
      update: function (context, match) {
        return updateProjection(context.state, match.event);
      },
      buildLocationData: function (context, scope, previous) {
        var state = context.state;
        if (scope !== "turn" || !state) return null;
        if (previous && previous.kind === "turn" && previous.turn === state.turn && previous.value === state.value) {
          return previous;
        }
        return { kind: "turn", turn: state.turn, key: KEY, value: state.value };
      },
    };

    // ---- RPC helper ----
    function rpcCall(connection, method, args, signal) {
      if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
        return Promise.resolve({ ok: false, error: { code: "NO_CONNECTION", message: "当前未连接宿主 RPC 服务。" } });
      }
      return connection.rpc.call("/api", "contractSure/" + method, { args: args || {} }, signal);
    }

    function extractRpcError(res, fallback) {
      if (res && res.error) {
        if (typeof res.error === "string") return res.error;
        if (typeof res.error.message === "string" && res.error.message) return res.error.message;
      }
      if (res && typeof res.message === "string" && res.message) return res.message;
      return fallback || "操作失败，请重试。";
    }

    // ---- 1. Settings Section Component ("履约无忧配置") ----
    function SettingsSection(props) {
      var connection = props.connection;
      var settingsScope = props.settingsScope;
      var scopeRef = useRef(null);

      var [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.serverUrl);
      var [apiToken, setApiToken] = useState("");
      var [ocrApiUrl, setOcrApiUrl] = useState(DEFAULT_SETTINGS.ocrApiUrl);
      var [ocrApiKey, setOcrApiKey] = useState("");
      var [showSecrets, setShowSecrets] = useState(false);

      var [username, setUsername] = useState("");
      var [password, setPassword] = useState("");
      var [ttlDays, setTtlDays] = useState("90");

      var [busy, setBusy] = useState(false);
      var [status, setStatus] = useState(null); // { kind: 'ok'|'err'|'warn', text: string }
      var [metaInfo, setMetaInfo] = useState({ ocrApiKeyEnvSet: false, configPath: "~/.contract-sure/dsh-config.json" });

      useEffect(function () {
        var cancelled = false;
        var unsubscribe = null;

        if (settingsScope && typeof settingsScope.bind === "function") {
          try {
            var bound = settingsScope.bind({ namespace: NS });
            scopeRef.current = bound;
            var applySnap = function () {
              var snap = bound.getSnapshot && bound.getSnapshot();
              if (snap && snap.value && typeof snap.value === "object") {
                if (snap.value.serverUrl) setServerUrl(String(snap.value.serverUrl));
                if (snap.value.apiToken != null) setApiToken(String(snap.value.apiToken));
                if (snap.value.ocrApiUrl) setOcrApiUrl(String(snap.value.ocrApiUrl));
                if (snap.value.ocrApiKey != null) setOcrApiKey(String(snap.value.ocrApiKey));
              }
            };
            applySnap();
            if (typeof bound.subscribe === "function") {
              unsubscribe = bound.subscribe(applySnap);
            }
          } catch (_) {
            // Host settingsScope optional.
          }
        }

        if (connection && connection.rpc) {
          rpcCall(connection, "getConfig", {}).then(function (res) {
            if (cancelled || !res || !res.ok || !res.value) return;
            var v = res.value;
            if (v.serverUrl) setServerUrl(v.serverUrl);
            if (v.apiToken != null) setApiToken(v.apiToken);
            if (v.ocrApiUrl) setOcrApiUrl(v.ocrApiUrl);
            if (v.ocrApiKey != null) setOcrApiKey(v.ocrApiKey);
            setMetaInfo({
              ocrApiKeyEnvSet: !!v.ocrApiKeyEnvSet,
              configPath: v.configPath || "~/.contract-sure/dsh-config.json",
            });
          }).catch(function () {});
        }

        return function () {
          cancelled = true;
          if (typeof unsubscribe === "function") {
            try { unsubscribe(); } catch (_) {}
          }
        };
      }, [connection, settingsScope]);

      function syncScopeMutation(patch) {
        var bound = scopeRef.current;
        if (!bound || typeof bound.mutate !== "function") return Promise.resolve();
        var snap = bound.getSnapshot && bound.getSnapshot();
        if (snap && snap.writable === false) return Promise.resolve();
        var ops = Object.keys(patch).map(function (k) {
          return { op: "set", path: [k], value: patch[k] };
        });
        return bound.mutate(ops).catch(function () {});
      }

      function handleSave() {
        if (busy) return;
        var patch = {
          serverUrl: String(serverUrl || "").trim() || DEFAULT_SETTINGS.serverUrl,
          apiToken: String(apiToken || "").trim(),
          ocrApiUrl: String(ocrApiUrl || "").trim() || DEFAULT_SETTINGS.ocrApiUrl,
          ocrApiKey: String(ocrApiKey || "").trim(),
        };
        setBusy(true);
        setStatus(null);
        Promise.all([
          connection && connection.rpc ? rpcCall(connection, "saveConfig", { patch: patch }) : Promise.resolve({ ok: true }),
          syncScopeMutation(patch),
        ]).then(function (results) {
          setBusy(false);
          var rpcRes = results[0];
          if (rpcRes && rpcRes.ok === false) {
            setStatus({ kind: "err", text: "保存失败：" + extractRpcError(rpcRes) });
          } else {
            setStatus({ kind: "ok", text: "✅ 配置已保存并同步到本地配置文件。" });
          }
        }).catch(function (err) {
          setBusy(false);
          setStatus({ kind: "err", text: "保存失败：" + (err && err.message ? err.message : "未知错误") });
        });
      }

      function handleTest() {
        if (busy) return;
        var patch = {
          serverUrl: String(serverUrl || "").trim() || DEFAULT_SETTINGS.serverUrl,
          apiToken: String(apiToken || "").trim(),
          ocrApiUrl: String(ocrApiUrl || "").trim() || DEFAULT_SETTINGS.ocrApiUrl,
          ocrApiKey: String(ocrApiKey || "").trim(),
        };
        setBusy(true);
        setStatus(null);
        rpcCall(connection, "testConnection", { patch: patch }).then(function (res) {
          setBusy(false);
          if (!res || !res.ok) {
            setStatus({ kind: "err", text: "连接测试失败：" + extractRpcError(res) });
            return;
          }
          var val = res.value || {};
          if (val.connected) {
            var userLabel = (val.user && (val.user.realName || val.user.username)) || "已认证用户";
            setStatus({ kind: "ok", text: "✅ 连接成功！当前用户：" + userLabel + "（" + (val.serverUrl || patch.serverUrl) + "）" });
          } else {
            setStatus({ kind: "err", text: "连接失败：" + (val.error || "请检查后端地址与访问令牌。") });
          }
        }).catch(function (err) {
          setBusy(false);
          setStatus({ kind: "err", text: "连接测试异常：" + (err && err.message ? err.message : "未知错误") });
        });
      }

      function handleLoginToken() {
        if (busy) return;
        if (!String(username || "").trim() || !String(password || "")) {
          setStatus({ kind: "warn", text: "请先输入履约无忧登录用户名和密码。" });
          return;
        }
        var targetUrl = String(serverUrl || "").trim() || DEFAULT_SETTINGS.serverUrl;
        var days = parseInt(ttlDays, 10);
        if (!Number.isFinite(days) || days < 1 || days > 365) days = 90;
        setBusy(true);
        setStatus(null);
        rpcCall(connection, "loginToken", {
          serverUrl: targetUrl,
          username: String(username).trim(),
          password: String(password),
          ttlDays: days,
        }).then(function (res) {
          setBusy(false);
          if (!res || !res.ok || !res.value || !res.value.token) {
            setStatus({ kind: "err", text: "换取令牌失败：" + extractRpcError(res) });
            return;
          }
          var v = res.value;
          setApiToken(v.token);
          setPassword("");
          syncScopeMutation({ serverUrl: v.serverUrl || targetUrl, apiToken: v.token });
          setStatus({
            kind: "ok",
            text: "✅ 已成功换取 " + (v.expiresInDays || days) + " 天长期令牌（用户：" + (v.realName || v.username) + "），并自动保存。",
          });
        }).catch(function (err) {
          setBusy(false);
          setStatus({ kind: "err", text: "换取令牌失败：" + (err && err.message ? err.message : "未知错误") });
        });
      }

      var secretInputType = showSecrets ? "text" : "password";

      return h("div", { className: "cs-wrap", style: { padding: "12px 4px", maxWidth: "740px" } },
        h("style", null, CSS),
        status && h("div", {
          className: "cs-banner " + (status.kind === "ok" ? "cs-banner-ok" : status.kind === "warn" ? "cs-banner-warn" : "cs-banner-err"),
          role: "status",
        }, status.text),

        h("fieldset", {
          style: { border: "1px solid var(--cs-border)", borderRadius: "10px", padding: "12px 14px", margin: "0 0 14px" },
        },
          h("legend", { style: { fontSize: "13px", fontWeight: 600, padding: "0 8px" } }, "后端服务与鉴权"),
          h("div", { className: "cs-field", style: { marginBottom: "10px" } },
            h("label", null, "后端接口地址 (serverUrl)"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: serverUrl,
              placeholder: DEFAULT_SETTINGS.serverUrl,
              disabled: busy,
              onChange: function (e) { setServerUrl(e.target.value); },
            }),
          ),
          h("div", { className: "cs-field", style: { marginBottom: "8px" } },
            h("label", null, "长期访问令牌 (apiToken)"),
            h("input", {
              className: "cs-input",
              type: secretInputType,
              value: apiToken,
              placeholder: "粘贴 Bearer Token，或使用下方一键换取",
              disabled: busy,
              onChange: function (e) { setApiToken(e.target.value); },
            }),
          ),
          h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--cs-muted)", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: showSecrets,
              onChange: function (e) { setShowSecrets(!!e.target.checked); },
            }),
            h("span", null, "显示令牌与 API Key 明文"),
          ),
        ),

        h("fieldset", {
          style: { border: "1px solid var(--cs-border)", borderRadius: "10px", padding: "12px 14px", margin: "0 0 14px" },
        },
          h("legend", { style: { fontSize: "13px", fontWeight: 600, padding: "0 8px" } }, "账号密码一键换取长期令牌"),
          h("div", { className: "cs-grid" },
            h("div", { className: "cs-field" },
              h("label", null, "用户名"),
              h("input", {
                className: "cs-input",
                type: "text",
                value: username,
                placeholder: "履约无忧登录账号",
                disabled: busy,
                onChange: function (e) { setUsername(e.target.value); },
              }),
            ),
            h("div", { className: "cs-field" },
              h("label", null, "密码"),
              h("input", {
                className: "cs-input",
                type: "password",
                value: password,
                placeholder: "仅用于换取长期令牌，不落盘",
                disabled: busy,
                onChange: function (e) { setPassword(e.target.value); },
              }),
            ),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--cs-muted)" } },
              h("span", null, "有效期（天）"),
              h("input", {
                className: "cs-input",
                type: "number",
                min: 1,
                max: 365,
                value: ttlDays,
                disabled: busy,
                style: { width: "84px" },
                onChange: function (e) { setTtlDays(e.target.value); },
              }),
            ),
            h("button", {
              type: "button",
              className: "cs-btn",
              disabled: busy,
              onClick: handleLoginToken,
            }, "🔑 获取长期令牌"),
          ),
        ),

        h("fieldset", {
          style: { border: "1px solid var(--cs-border)", borderRadius: "10px", padding: "12px 14px", margin: "0 0 14px" },
        },
          h("legend", { style: { fontSize: "13px", fontWeight: 600, padding: "0 8px" } }, "DeepSeek OCR 识别（扫描件与图片回退）"),
          h("div", { className: "cs-field", style: { marginBottom: "10px" } },
            h("label", null, "DeepSeek OCR 接口地址 (ocrApiUrl)"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: ocrApiUrl,
              placeholder: DEFAULT_SETTINGS.ocrApiUrl,
              disabled: busy,
              onChange: function (e) { setOcrApiUrl(e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "DeepSeek OCR API Key (ocrApiKey)"),
            h("input", {
              className: "cs-input",
              type: secretInputType,
              value: ocrApiKey,
              placeholder: metaInfo.ocrApiKeyEnvSet ? "已检测到环境变量 DEEPSEEK_API_KEY（填写此处将优先覆盖）" : "填写 sk-... 用于扫描件 PDF 与票据图片识别",
              disabled: busy,
              onChange: function (e) { setOcrApiKey(e.target.value); },
            }),
          ),
        ),

        h("div", { className: "cs-footer" },
          h("div", { style: { display: "flex", gap: "10px", flexWrap: "wrap" } },
            h("button", {
              type: "button",
              className: "cs-btn",
              disabled: busy,
              onClick: handleTest,
            }, "🔌 测试连接"),
            h("button", {
              type: "button",
              className: "cs-btn cs-btn-primary",
              disabled: busy,
              onClick: handleSave,
            }, busy ? "处理中..." : "💾 保存配置"),
          ),
          h("span", { className: "cs-meta" }, "本地同步文件: " + metaInfo.configPath),
        ),
      );
    }

    // ---- 2. Draft Verification Card ("合同识别核对卡") ----
    function DraftVerificationCard(props) {
      var item = props.item;
      var confirmedInitial = props.confirmed || null;
      var sessionId = props.sessionId;
      var connection = props.connection;
      var draft = item.draft || {};
      var validation = item.validation || {};

      var [form, setForm] = useState(function () {
        return {
          contractNo: draft.contractNo || "",
          contractName: draft.contractName || "",
          contractType: draft.contractType || 1,
          partyAName: draft.partyAName || "",
          partyBName: draft.partyBName || "",
          totalAmount: draft.totalAmount != null ? String(draft.totalAmount) : "",
          signDate: draft.signDate || "",
        };
      });
      var [submitting, setSubmitting] = useState(false);
      var [error, setError] = useState("");
      var [confirmed, setConfirmed] = useState(confirmedInitial);

      useEffect(function () {
        if (confirmedInitial && !confirmed) {
          setConfirmed(confirmedInitial);
        }
      }, [confirmedInitial]);

      var nodes = Array.isArray(draft.nodes) ? draft.nodes : [];
      var nodesSum = nodes.reduce(function (acc, n) {
        var amt = Number(n && n.nodeAmount);
        return acc + (Number.isFinite(amt) ? amt : 0);
      }, 0);
      var parsedTotal = Number(form.totalAmount);
      var amountDiff = Number.isFinite(parsedTotal) ? Math.round((parsedTotal - nodesSum) * 100) / 100 : null;
      var warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
      var hasWarnings = warnings.length > 0 || validation.contractNoExists === true || (amountDiff != null && Math.abs(amountDiff) > 0.01);
      var readOnly = !!confirmed || submitting;

      function updateField(field, val) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next[field] = val;
          return next;
        });
      }

      function handleConfirm() {
        if (submitting || confirmed) return;
        if (!sessionId) {
          setError("当前会话标识不可用，请在对话中回复“确认创建”完成入库。");
          return;
        }
        var totalNum = Number(form.totalAmount);
        if (!String(form.contractNo || "").trim() || !String(form.contractName || "").trim()) {
          setError("合同编号与合同名称不能为空。");
          return;
        }
        if (!Number.isFinite(totalNum) || totalNum < 0) {
          setError("请输入有效的合同总金额（纯数字，单位：元）。");
          return;
        }
        var editedDraft = Object.assign({}, draft, {
          contractNo: String(form.contractNo).trim(),
          contractName: String(form.contractName).trim(),
          contractType: Number(form.contractType) || 1,
          partyAName: String(form.partyAName || "").trim(),
          partyBName: String(form.partyBName || "").trim(),
          totalAmount: totalNum,
          signDate: String(form.signDate || "").trim() || null,
          nodes: nodes,
        });
        setSubmitting(true);
        setError("");
        rpcCall(connection, "confirmDraft", {
          sessionId: sessionId,
          draftId: item.draftId,
          editedDraft: editedDraft,
        }).then(function (res) {
          setSubmitting(false);
          if (!res || !res.ok || !res.value) {
            setError(extractRpcError(res, "创建合同失败，请检查配置或重试。"));
            return;
          }
          setConfirmed({
            contractId: res.value.contractId,
            uploadedDoc: res.value.uploadedDoc || null,
            uploadWarning: res.value.uploadWarning || null,
          });
        }).catch(function (err) {
          setSubmitting(false);
          setError(err && err.message ? err.message : "创建合同请求失败，请重试。");
        });
      }

      var typeLabel = Number(form.contractType) === 2 ? "采购合同" : "销售合同";

      return h("section", { className: "cs-card", "data-draft-id": item.draftId, "aria-label": "合同识别核对卡" },
        h("div", { className: "cs-card-head" },
          h("h3", { className: "cs-card-title" },
            h("span", null, "合同识别核对卡"),
            h("span", { className: "cs-pill cs-pill-type" }, typeLabel),
          ),
          confirmed
            ? h("span", { className: "cs-pill cs-pill-ok" }, "✅ 已入库 (ID: #" + confirmed.contractId + ")")
            : hasWarnings
              ? h("span", { className: "cs-pill cs-pill-warn" }, "⚠ 存在校验提示，请核对")
              : h("span", { className: "cs-pill cs-pill-ok" }, "✓ 总额校验一致"),
        ),

        !confirmed && hasWarnings && h("div", { className: "cs-banner cs-banner-warn", role: "alert" },
          h("div", { style: { fontWeight: 600, marginBottom: "4px" } }, "校验提示："),
          warnings.map(function (w, idx) {
            return h("div", { key: idx }, "• " + w);
          }),
          validation.contractNoExists && warnings.length === 0 && h("div", null, "• 合同编号在系统中已存在，请确认是否重复录入。"),
          amountDiff != null && Math.abs(amountDiff) > 0.01 && h("div", null,
            "• 合同总额（" + formatAmount(parsedTotal) + " 元）与节点合计（" + formatAmount(nodesSum) + " 元）相差 " + formatAmount(Math.abs(amountDiff)) + " 元。"
          ),
        ),

        confirmed && h("div", { className: "cs-banner cs-banner-ok", role: "status" },
          "已入库 (ID: #" + confirmed.contractId + ")" +
          (confirmed.uploadedDoc && confirmed.uploadedDoc.fileName ? " · 已自动归档原件《" + confirmed.uploadedDoc.fileName + "》" : "") +
          (confirmed.uploadWarning ? " · " + confirmed.uploadWarning : ""),
        ),

        error && h("div", { className: "cs-banner cs-banner-err", role: "alert" }, error),

        h("div", { className: "cs-grid" },
          h("div", { className: "cs-field" },
            h("label", null, "合同编号"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: form.contractNo,
              disabled: readOnly,
              onChange: function (e) { updateField("contractNo", e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "合同名称"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: form.contractName,
              disabled: readOnly,
              onChange: function (e) { updateField("contractName", e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "甲方户名"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: form.partyAName,
              disabled: readOnly,
              onChange: function (e) { updateField("partyAName", e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "乙方户名"),
            h("input", {
              className: "cs-input",
              type: "text",
              value: form.partyBName,
              disabled: readOnly,
              onChange: function (e) { updateField("partyBName", e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "合同总额（元）"),
            h("input", {
              className: "cs-input",
              type: "number",
              step: "0.01",
              value: form.totalAmount,
              disabled: readOnly,
              onChange: function (e) { updateField("totalAmount", e.target.value); },
            }),
          ),
          h("div", { className: "cs-field" },
            h("label", null, "签订日期"),
            h("input", {
              className: "cs-input",
              type: "text",
              placeholder: "YYYY-MM-DD",
              value: form.signDate,
              disabled: readOnly,
              onChange: function (e) { updateField("signDate", e.target.value); },
            }),
          ),
        ),

        nodes.length > 0 && h("div", { className: "cs-table-wrap" },
          h("table", { className: "cs-table" },
            h("thead", null,
              h("tr", null,
                h("th", null, "#"),
                h("th", null, "节点名称"),
                h("th", { className: "cs-num" }, "节点金额（元）"),
                h("th", null, "预计日期"),
                h("th", null, "付款条件"),
                h("th", null, "触发规则"),
              ),
            ),
            h("tbody", null,
              nodes.map(function (node, idx) {
                return h("tr", { key: idx },
                  h("td", null, String(node.nodeOrder != null ? node.nodeOrder : idx + 1)),
                  h("td", null, node.nodeName || "-"),
                  h("td", { className: "cs-num" }, formatAmount(node.nodeAmount)),
                  h("td", null, node.plannedDate || "条件触发"),
                  h("td", null, node.paymentCondition || "-"),
                  h("td", null, h("span", { className: "cs-rule-tag" }, formatTriggerRule(node.triggerRule))),
                );
              }),
            ),
          ),
        ),

        h("div", { className: "cs-footer" },
          h("span", { className: "cs-meta" },
            "共 " + nodes.length + " 个节点 · 节点合计 " + formatAmount(nodesSum) + " 元" +
            (item.sourceFilePath ? " · 原件：" + basenameOf(item.sourceFilePath) : ""),
          ),
          !confirmed && h("button", {
            type: "button",
            className: "cs-btn cs-btn-primary",
            disabled: submitting,
            onClick: handleConfirm,
          }, submitting ? "正在入库..." : (item.sourceFilePath ? "✅ 确认创建并归档原件" : "✅ 确认创建合同")),
        ),
      );
    }

    // ---- 3. Detail Documents Preview Card ("合同与票据原件") ----
    function DocumentRow(props) {
      var doc = props.doc;
      var sessionId = props.sessionId;
      var connection = props.connection;
      var sidebarRight = props.sidebarRight;
      var [loading, setLoading] = useState(false);
      var [error, setError] = useState("");
      var docId = doc.docId != null ? doc.docId : doc.id;

      function handleOpen() {
        if (loading) return;
        if (!sidebarRight || typeof sidebarRight.openResource !== "function") {
          setError("当前宿主未挂载右侧预览阅读器（sidebarRight）。");
          return;
        }
        var activeSession = (sidebarRight.mounted && typeof sidebarRight.mounted.getSnapshot === "function")
          ? sidebarRight.mounted.getSnapshot()
          : sessionId;
        if (!activeSession) {
          setError("无法确定当前会话，请刷新后重试。");
          return;
        }
        setLoading(true);
        setError("");
        rpcCall(connection, "cacheOriginalDocument", {
          sessionId: activeSession,
          docId: docId,
          fileName: doc.fileName,
        }).then(function (res) {
          setLoading(false);
          if (!res || !res.ok || !res.value || !res.value.absolutePath) {
            setError(extractRpcError(res, "原件加载失败，请重试。"));
            return;
          }
          var address = fileAddressFor(activeSession, res.value.absolutePath);
          sidebarRight.openResource(address, { destination: "sidebar" });
        }).catch(function (err) {
          setLoading(false);
          setError(err && err.message ? err.message : "原件加载失败，请重试。");
        });
      }

      var typeLabel = doc.docTypeLabel || DOC_TYPE_LABELS[doc.docType] || "附件";
      var sizeText = formatFileSize(doc.fileSize);

      return h("li", { "data-doc-id": String(docId || "") },
        h("div", { className: "cs-doc-row" },
          h("span", { className: "cs-pill cs-pill-type" }, typeLabel),
          h("span", { className: "cs-doc-name" }, doc.fileName || ("document-" + docId)),
          sizeText ? h("span", { className: "cs-doc-size" }, sizeText) : null,
          h("button", {
            type: "button",
            className: "cs-doc-open",
            disabled: loading,
            onClick: handleOpen,
          }, loading ? "加载中…" : "查看原件"),
        ),
        error ? h("div", { className: "cs-banner cs-banner-err", style: { marginTop: "6px", marginBottom: 0 } }, error) : null,
      );
    }

    function DetailDocumentsCard(props) {
      var detail = props.detail;
      var docs = Array.isArray(detail.documents) ? detail.documents : [];
      if (!docs.length) return null;

      return h("section", { className: "cs-card", "data-contract-id": String(detail.contractId), "aria-label": "合同与票据原件" },
        h("div", { className: "cs-card-head" },
          h("h3", { className: "cs-card-title" },
            h("span", null, "合同与票据原件"),
            detail.contractNo ? h("span", { className: "cs-pill cs-pill-type" }, detail.contractNo) : null,
          ),
          h("span", { className: "cs-meta" }, (detail.contractName ? detail.contractName + " · " : "") + "共 " + docs.length + " 份"),
        ),
        h("ul", { className: "cs-doc-list" },
          docs.map(function (doc, idx) {
            return h(DocumentRow, {
              key: doc.docId != null ? doc.docId : idx,
              doc: doc,
              sessionId: props.sessionId,
              connection: props.connection,
              sidebarRight: props.sidebarRight,
            });
          }),
        ),
      );
    }

    // ---- TurnTail Container ----
    function TurnTail(props) {
      var turn = props.turn;
      var connection = props.connection;
      var sidebarRight = props.sidebarRight;

      var [mountedSession, setMountedSession] = useState(function () {
        if (sidebarRight && sidebarRight.mounted && typeof sidebarRight.mounted.getSnapshot === "function") {
          return sidebarRight.mounted.getSnapshot();
        }
        return props.sessionId || (turn && turn.sessionId) || "";
      });

      useEffect(function () {
        if (!sidebarRight || !sidebarRight.mounted || typeof sidebarRight.mounted.subscribe !== "function") return;
        setMountedSession(sidebarRight.mounted.getSnapshot());
        return sidebarRight.mounted.subscribe(function () {
          setMountedSession(sidebarRight.mounted.getSnapshot());
        });
      }, [sidebarRight]);

      var data = turn && turn.data && typeof turn.data.get === "function" ? turn.data.get(KEY) : null;
      if (!data) return null;
      var drafts = Array.isArray(data.drafts) ? data.drafts : [];
      var confirmedByDraftId = data.confirmedByDraftId || {};
      var details = Array.isArray(data.details) ? data.details.filter(function (d) { return d.documents && d.documents.length > 0; }) : [];
      if (!drafts.length && !details.length) return null;

      var effectiveSessionId = mountedSession || props.sessionId || (turn && turn.sessionId) || "";

      return h("div", { className: "cs-wrap" },
        h("style", null, CSS),
        drafts.map(function (item) {
          return h(DraftVerificationCard, {
            key: item.draftId,
            item: item,
            confirmed: confirmedByDraftId[item.draftId] || null,
            sessionId: effectiveSessionId,
            connection: connection,
          });
        }),
        details.map(function (detail) {
          return h(DetailDocumentsCard, {
            key: String(detail.contractId),
            detail: detail,
            sessionId: effectiveSessionId,
            connection: connection,
            sidebarRight: sidebarRight,
          });
        }),
      );
    }

    // ---- Cordis Client Plugin Entrypoint ----
    exports.inject = ["slots", "connection", "uiConversation", "sidebarRight"];
    exports.SettingsSection = SettingsSection;
    exports.TurnTail = TurnTail;
    exports.DraftVerificationCard = DraftVerificationCard;
    exports.DetailDocumentsCard = DetailDocumentsCard;
    exports.formatTriggerRule = formatTriggerRule;
    exports.eventDefinition = eventDefinition;

    exports.apply = function (ctx) {
      // Never fall back to `ctx[svcName]` when `typeof ctx.get === "function"`:
      // Cordis Context proxies throw `cannot get property "<name>" without inject` on direct property reads.
      var getSvc = function (svcName, targetCtx) {
        var c = targetCtx || ctx;
        if (!c) return undefined;
        if (typeof c.get === "function") return c.get(svcName);
        return c[svcName];
      };

      var slots = getSvc("slots");
      if (!slots) return;

      var uiConversation = getSvc("uiConversation");
      var connection = getSvc("connection");
      var sidebarRight = getSvc("sidebarRight");
      var settingsScope = getSvc("settingsScope");

      // 1. Register settings.section ("履约无忧配置")
      slots.inject("settings.section", function () {
        var BoundSettings = function (props) {
          return h(SettingsSection, Object.assign({}, props, {
            connection: getSvc("connection") || connection,
            settingsScope: getSvc("settingsScope") || settingsScope,
          }));
        };
        return slots.register({
          name: "settings.section",
          id: "contract-sure-settings",
          order: 30,
          label: "履约无忧配置",
        }, BoundSettings);
      });

      // 2. Register conversation.chat.turnTail ("contract-sure-cards") when uiConversation is present or becomes ready
      var registeredTurnTail = false;
      var registerTurnTail = function (convSvc, ctxRef) {
        if (registeredTurnTail || !convSvc || !convSvc.events || typeof convSvc.events.register !== "function") return;
        registeredTurnTail = true;
        convSvc.events.register(eventDefinition);
        slots.inject("conversation.chat.turnTail", function () {
          var ConnectedTurnTail = function (props) {
            var activeConn = getSvc("connection", ctxRef) || getSvc("connection") || connection;
            var activeSidebar = getSvc("sidebarRight", ctxRef) || getSvc("sidebarRight") || sidebarRight;
            return h(TurnTail, Object.assign({}, props, {
              connection: activeConn,
              sidebarRight: activeSidebar,
            }));
          };
          return slots.register({
            name: "conversation.chat.turnTail",
            id: "contract-sure-cards",
            order: 25,
          }, ConnectedTurnTail);
        });
      };

      if (uiConversation && uiConversation.events && typeof uiConversation.events.register === "function") {
        registerTurnTail(uiConversation, ctx);
      } else if (ctx && typeof ctx.inject === "function") {
        ctx.inject(["uiConversation"], function (subCtx) {
          var conv = getSvc("uiConversation", subCtx);
          registerTurnTail(conv, subCtx);
        });
      }
    };

    return module.exports;
  },
});
