window.__ModuleLoader__.load({id:"@local/datahub-onboarding",factory(require){const module={exports:{}};const exports=module.exports;
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
  DataHubSettingsSection: () => DataHubSettingsSection,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_entry_exports);
var import_react = __toESM(require("react"), 1);

// constants.js
var CLIENT_LOCALE = "datahub.onboarding";
var LEGACY_ENTRY_IDS = Object.freeze(["mcp-datahub-ask-data", "mcp-datahub-knowledge"]);
var SERVICES = Object.freeze([
  Object.freeze({ name: "datahub-ask-data", path: "/api/mcp/ask-data", toolCallTimeoutMs: 18e4 }),
  Object.freeze({ name: "datahub-knowledge", path: "/api/mcp/knowledge", toolCallTimeoutMs: 12e4 })
]);
var SERVICE_NAMES = Object.freeze(SERVICES.map((service) => service.name));

// locales.js
var zh = {
  nav: "DataHub \u6570\u636E\u670D\u52A1",
  title: "DataHub \u6570\u636E\u670D\u52A1",
  description: "\u9A8C\u8BC1\u7A7A\u95F4 API Key\uFF0C\u5E76\u63A5\u5165 DataHub \u95EE\u6570\u4E0E\u95EE\u77E5\u670D\u52A1\u3002",
  origin: "\u670D\u52A1\u5668\u5730\u5740",
  originMissing: "\u5C1A\u672A\u914D\u7F6E\u670D\u52A1\u5668\u5730\u5740",
  apiKey: "DataHub \u7A7A\u95F4 API Key",
  apiKeyPlaceholder: "\u8F93\u5165 API Key",
  keySaved: "API Key \u5DF2\u4FDD\u5B58\uFF0C\u4E0D\u4F1A\u56DE\u663E",
  keyNotSaved: "\u5C1A\u672A\u4FDD\u5B58 API Key",
  keySavedDisconnected: "API Key \u5DF2\u4FDD\u5B58\uFF0C\u5F53\u524D\u672A\u8FDE\u63A5",
  validateConnect: "\u9A8C\u8BC1\u5E76\u8FDE\u63A5",
  validating: "\u6B63\u5728\u9A8C\u8BC1\u2026",
  cancel: "\u53D6\u6D88",
  retry: "\u91CD\u65B0\u68C0\u6D4B",
  disconnect: "\u65AD\u5F00\u8FDE\u63A5",
  clearKey: "\u6E05\u9664 Key",
  confirmClear: "\u786E\u5B9A\u6E05\u9664\u5DF2\u4FDD\u5B58\u7684 DataHub API Key \u5417\uFF1F\u6B64\u64CD\u4F5C\u4E5F\u4F1A\u65AD\u5F00\u4E24\u4E2A\u670D\u52A1\u3002",
  services: "\u670D\u52A1\u72B6\u6001",
  askData: "\u95EE\u6570\uFF08datahub-ask-data\uFF09",
  knowledge: "\u95EE\u77E5\uFF08datahub-knowledge\uFF09",
  security: "API Key \u4EC5\u4FDD\u5B58\u5230 DSH \u51ED\u636E\u5B58\u50A8\uFF1B\u63D2\u4EF6\u914D\u7F6E\u53EA\u4FDD\u5B58\u975E\u654F\u611F\u7684\u7ED1\u5B9A\u5730\u5740\u3002",
  environmentRequired: "\u8BF7\u5148\u5728\u5584\u6CBB\u8D26\u53F7\u767B\u5F55\u4E2D\u914D\u7F6E\u670D\u52A1\u5668\u5730\u5740\uFF0C\u518D\u8FD4\u56DE\u6B64\u9875\u3002",
  legacyNotice: "\u68C0\u6D4B\u5230\u65E7\u5B89\u88C5\u811A\u672C\u521B\u5EFA\u7684 MCP \u914D\u7F6E\u3002\u672C\u63D2\u4EF6\u4EC5\u663E\u793A\u72B6\u6001\uFF0C\u4E0D\u6CE8\u518C\u540C\u540D\u670D\u52A1\uFF0C\u4E5F\u4E0D\u4FEE\u6539\u6216\u8FC1\u79FB\u65E7\u914D\u7F6E\u3002",
  environmentChanged: "\u670D\u52A1\u5668\u5730\u5740\u5DF2\u53D8\u5316\uFF0C\u65E7\u8FDE\u63A5\u5DF2\u505C\u7528\u3002\u8BF7\u8F93\u5165 API Key \u91CD\u65B0\u9A8C\u8BC1\uFF0C\u65E7 Key \u4E0D\u4F1A\u81EA\u52A8\u53D1\u5F80\u65B0\u5730\u5740\u3002",
  connectedNotice: "\u4E24\u4E2A DataHub \u670D\u52A1\u5DF2\u63A5\u5165\u3002",
  unconfiguredNotice: "\u8F93\u5165\u7A7A\u95F4 API Key\uFF0C\u70B9\u51FB\u201C\u9A8C\u8BC1\u5E76\u8FDE\u63A5\u201D\u3002\u4E24\u4E2A\u7AEF\u70B9\u5747\u9A8C\u8BC1\u6210\u529F\u540E\u624D\u4F1A\u66FF\u6362\u6B63\u5F0F Key\u3002",
  legacyManaged: "\u7531\u73B0\u6709\u914D\u7F6E\u7BA1\u7406",
  rpcFailed: "\u65E0\u6CD5\u8FDE\u63A5 DSH \u8BBE\u7F6E\u670D\u52A1\uFF0C\u8BF7\u91CD\u8BD5\u3002",
  errorTitle: "\u64CD\u4F5C\u672A\u5B8C\u6210",
  warningTitle: "\u9700\u8981\u6CE8\u610F",
  "stage.connect": "\u8FDE\u63A5\u4E0E\u534F\u8BAE\u63E1\u624B",
  "stage.list": "\u5DE5\u5177\u53D1\u73B0",
  "stage.cleanup": "\u63A2\u6D4B\u6E05\u7406",
  "probe.failed": "\u9A8C\u8BC1\u5931\u8D25",
  "probe.validating": "\u9A8C\u8BC1\u4E2D",
  "probe.succeeded": "\u9A8C\u8BC1\u901A\u8FC7",
  "state.connected": "\u5DF2\u8FDE\u63A5",
  "state.connecting": "\u8FDE\u63A5\u4E2D",
  "state.reconnecting": "\u6B63\u5728\u91CD\u8FDE",
  "state.failed": "\u8FDE\u63A5\u5931\u8D25",
  "state.waiting-credentials": "\u7B49\u5F85\u51ED\u636E",
  "state.closed": "\u5DF2\u5173\u95ED",
  "state.disabled": "\u5DF2\u505C\u7528",
  "state.disconnected": "\u672A\u8FDE\u63A5",
  "state.configured": "\u7531\u73B0\u6709\u914D\u7F6E\u7BA1\u7406",
  "state.unknown": "\u72B6\u6001\u672A\u77E5",
  "error.ENVIRONMENT_REQUIRED": "\u5C1A\u672A\u914D\u7F6E\u670D\u52A1\u5668\u5730\u5740\u3002",
  "error.INVALID_ORIGIN": "\u8D26\u53F7\u63D2\u4EF6\u63D0\u4F9B\u7684\u670D\u52A1\u5668\u5730\u5740\u65E0\u6548\u3002",
  "error.LEGACY_MANAGED": "\u5F53\u524D\u7531\u65E7\u914D\u7F6E\u7BA1\u7406\uFF0C\u672C\u9875\u4E3A\u53EA\u8BFB\u72B6\u6001\u3002",
  "error.INVALID_API_KEY": "\u8BF7\u8F93\u5165\u6709\u6548\u7684 API Key\u3002",
  "error.KEY_REQUIRED": "\u6CA1\u6709\u53EF\u7528\u4E8E\u91CD\u65B0\u68C0\u6D4B\u7684\u5DF2\u4FDD\u5B58 Key\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165\u3002",
  "error.ENVIRONMENT_CHANGED": "\u670D\u52A1\u5668\u5730\u5740\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8F93\u5165 API Key \u9A8C\u8BC1\u3002",
  "error.PROBE_FAILED": "\u4E00\u4E2A\u6216\u4E24\u4E2A MCP \u7AEF\u70B9\u9A8C\u8BC1\u5931\u8D25\uFF0C\u65E7\u6B63\u5F0F Key \u548C\u65E7\u8FDE\u63A5\u4FDD\u6301\u4E0D\u53D8\u3002",
  "error.REGISTRATION_FAILED": "MCP \u6CE8\u518C\u5931\u8D25\uFF0C\u53EF\u80FD\u5B58\u5728\u540C\u540D\u670D\u52A1\u51B2\u7A81\u3002",
  "error.SETTINGS_UNAVAILABLE": "DSH \u8BBE\u7F6E\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u7ED1\u5B9A\u5730\u5740\u3002",
  "error.CREDENTIAL_ERROR": "\u51ED\u636E\u5B58\u50A8\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
  "error.ROLLBACK_FAILED": "\u8FDE\u63A5\u5931\u8D25\u4E14\u56DE\u6EDA\u672A\u5B8C\u5168\u6210\u529F\uFF0C\u8BF7\u68C0\u67E5\u51ED\u636E\u4E0E\u7ED1\u5B9A\u5730\u5740\u540E\u91CD\u8BD5\u3002",
  "error.STAGING_CLEANUP_FAILED": "\u6682\u5B58\u51ED\u636E\u6E05\u7406\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u6216\u6E05\u9664 Key\u3002",
  "error.RPC_FAILED": "\u8BBE\u7F6E\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002",
  "error.generic": "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u3002"
};
var en = {
  nav: "DataHub Services",
  title: "DataHub Services",
  description: "Validate a workspace API key and connect DataHub query and knowledge services.",
  origin: "Server origin",
  originMissing: "No server origin configured",
  apiKey: "DataHub workspace API Key",
  apiKeyPlaceholder: "Enter an API Key",
  keySaved: "API Key saved; its value is never displayed",
  keyNotSaved: "No API Key saved",
  keySavedDisconnected: "API Key saved, but currently disconnected",
  validateConnect: "Validate and connect",
  validating: "Validating\u2026",
  cancel: "Cancel",
  retry: "Test again",
  disconnect: "Disconnect",
  clearKey: "Clear Key",
  confirmClear: "Clear the saved DataHub API Key? This also disconnects both services.",
  services: "Service status",
  askData: "Ask Data (datahub-ask-data)",
  knowledge: "Knowledge (datahub-knowledge)",
  security: "The API Key is stored only in the DSH credential store. Plugin configuration contains only the non-secret bound origin.",
  environmentRequired: "Configure the server origin in Xiaozhi account sign-in, then return to this page.",
  legacyNotice: "Legacy installer-managed MCP entries were detected. This plugin is read-only and will not register duplicates, modify, or migrate them.",
  environmentChanged: "The server origin changed. The old connection was withdrawn. Revalidate with an API Key; the old Key is never sent automatically to the new origin.",
  connectedNotice: "Both DataHub services are connected.",
  unconfiguredNotice: "Enter a workspace API Key and select \u201CValidate and connect\u201D. The saved Key is replaced only after both endpoints pass validation.",
  legacyManaged: "Managed by existing configuration",
  rpcFailed: "The DSH settings service is unavailable. Try again.",
  errorTitle: "Operation incomplete",
  warningTitle: "Attention required",
  "stage.connect": "Connection and MCP handshake",
  "stage.list": "Tool discovery",
  "stage.cleanup": "Probe cleanup",
  "probe.failed": "Validation failed",
  "probe.validating": "Validating",
  "probe.succeeded": "Validated",
  "state.connected": "Connected",
  "state.connecting": "Connecting",
  "state.reconnecting": "Reconnecting",
  "state.failed": "Connection failed",
  "state.waiting-credentials": "Waiting for credentials",
  "state.closed": "Closed",
  "state.disabled": "Disabled",
  "state.disconnected": "Disconnected",
  "state.configured": "Managed by existing configuration",
  "state.unknown": "Unknown status",
  "error.ENVIRONMENT_REQUIRED": "No server origin is configured.",
  "error.INVALID_ORIGIN": "The account plugin supplied an invalid server origin.",
  "error.LEGACY_MANAGED": "Legacy configuration owns these services; this page is read-only.",
  "error.INVALID_API_KEY": "Enter a valid API Key.",
  "error.KEY_REQUIRED": "No saved Key is available for retesting. Enter one again.",
  "error.ENVIRONMENT_CHANGED": "The server origin changed. Enter an API Key to validate again.",
  "error.PROBE_FAILED": "One or both MCP endpoints failed validation. The previous saved Key and connection remain unchanged.",
  "error.REGISTRATION_FAILED": "MCP registration failed. A same-name service may already exist.",
  "error.SETTINGS_UNAVAILABLE": "DSH settings storage is unavailable, so the bound origin cannot be saved.",
  "error.CREDENTIAL_ERROR": "The credential store operation failed. Try again.",
  "error.ROLLBACK_FAILED": "The connection failed and rollback was incomplete. Check the credential and bound origin before retrying.",
  "error.STAGING_CLEANUP_FAILED": "The staging credential could not be cleared. Retry or clear the Key.",
  "error.RPC_FAILED": "The settings service request failed. Try again.",
  "error.generic": "The operation failed. Try again."
};

// transport.js
async function callOnboardingRpc(connection, method, payload, signal) {
  const response = await connection.rpc.call(
    "/api",
    `datahubOnboarding/${method}`,
    { args: payload ?? {} },
    signal
  );
  if (!response?.ok) throw new Error("RPC_FAILED");
  return response.value;
}

// build/client-entry.js
var h = import_react.default.createElement;
var css = `
.dho{max-width:760px;padding:16px 4px;color:var(--dsw-alias-label-primary,#302d28);font-size:14px;line-height:1.65}
.dho *{box-sizing:border-box}.dho h2{font-size:20px;margin:0 0 6px}.dho-desc{margin:0 0 20px;color:var(--dsw-alias-label-secondary,#79746c)}
.dho-field{margin:0 0 16px}.dho-label{display:block;font-weight:600;margin-bottom:6px}.dho-input{width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#cbc7bf);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit}
.dho-input[readonly]{color:var(--dsw-alias-label-secondary,#79746c);background:var(--dsw-alias-bg-layer-2,#f5f4f1);overflow:hidden;text-overflow:ellipsis}
.dho-keyline{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.dho-saved{font-size:12px;color:var(--dsw-alias-label-secondary,#79746c)}
.dho-actions{display:flex;flex-wrap:wrap;gap:9px;margin:14px 0 18px}.dho-button{padding:7px 15px;border:1px solid var(--dsw-alias-border-l3,#b9b4aa);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f4f1);color:inherit;font:inherit;cursor:pointer}
.dho-button.primary{background:var(--dsw-alias-brand-primary,#315efb);border-color:transparent;color:#fff}.dho-button.danger{color:var(--dsw-alias-label-error,#a33232)}
.dho-button:disabled{opacity:.5;cursor:not-allowed}.dho-button:focus-visible,.dho-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#315efb);outline-offset:2px}
.dho-notice{padding:10px 12px;margin:0 0 14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f4f1);color:var(--dsw-alias-label-secondary,#66615a);white-space:pre-wrap;overflow-wrap:anywhere}
.dho-notice.error{background:var(--dsw-alias-bg-danger,rgba(180,45,45,.1));color:var(--dsw-alias-label-error,#923b3b)}
.dho-services{margin-top:22px}.dho-services h3{font-size:15px;margin:0 0 9px}.dho-row{display:flex;justify-content:space-between;gap:16px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1,#e4e0d9);border-radius:6px;margin-bottom:8px}
.dho-row span:last-child{text-align:right;color:var(--dsw-alias-label-secondary,#79746c)}.dho-security{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b867e);margin-top:18px}
@media(max-width:520px){.dho-row{display:block}.dho-row span{display:block;text-align:left!important}.dho-row span+span{margin-top:4px}.dho-keyline{display:block}.dho-saved{display:block;margin-bottom:6px}}
`;
function serviceLabel(name, t) {
  return name === "datahub-ask-data" ? t("askData") : t("knowledge");
}
function safeTranslation(t, key, fallback) {
  const value = t(key);
  return value === key ? t(fallback) : value;
}
function serviceState(service, t) {
  if (service.managedBy === "legacy") return t("legacyManaged");
  const runtime = safeTranslation(t, `state.${service.state}`, "state.unknown");
  if (["failed", "validating", "succeeded"].includes(service.probe)) {
    return `${t(`probe.${service.probe}`)} \xB7 ${runtime}`;
  }
  return runtime;
}
function DataHubSettingsSection({ connection, t }) {
  const [state, setState] = import_react.default.useState(void 0);
  const [apiKey, setApiKey] = import_react.default.useState("");
  const [pending, setPending] = import_react.default.useState(false);
  const [localError, setLocalError] = import_react.default.useState(void 0);
  const action = import_react.default.useRef(null);
  const previousOrigin = import_react.default.useRef(void 0);
  import_react.default.useEffect(() => {
    let active = true;
    let loading = false;
    let request;
    const load = async () => {
      if (loading) return;
      loading = true;
      request = new AbortController();
      try {
        const value = await callOnboardingRpc(connection, "state", {}, request.signal);
        if (active) {
          setState(value);
          setLocalError(void 0);
        }
      } catch {
        if (active && !request.signal.aborted) setLocalError("RPC_FAILED");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5e3);
    return () => {
      active = false;
      clearInterval(timer);
      request?.abort();
    };
  }, [connection]);
  import_react.default.useEffect(() => {
    if (previousOrigin.current !== void 0 && previousOrigin.current !== state?.origin) setApiKey("");
    previousOrigin.current = state?.origin;
  }, [state?.origin]);
  import_react.default.useEffect(() => () => {
    action.current?.abort();
  }, []);
  const perform = async (method, payload) => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setPending(true);
    setLocalError(void 0);
    try {
      const value = await callOnboardingRpc(connection, method, payload, controller.signal);
      setState(value);
      if (method === "connect" && value?.phase === "connected") setApiKey("");
      if (method === "clearKey") setApiKey("");
    } catch {
      if (!controller.signal.aborted) setLocalError("RPC_FAILED");
    } finally {
      if (action.current === controller) action.current = null;
      setPending(false);
    }
  };
  const cancel = () => {
    action.current?.abort();
    void callOnboardingRpc(connection, "cancel", {}).then((value) => setState(value)).catch(() => {
    });
  };
  const busy = pending || state?.busy === true;
  const legacy = state?.legacyManaged === true;
  const disabled = busy || legacy;
  const errorCode = localError ?? state?.error?.code;
  let notice;
  if (!state) notice = t("validating");
  else if (legacy) notice = t("legacyNotice");
  else if (state.phase === "environment-required") notice = t("environmentRequired");
  else if (state.phase === "environment-changed") notice = t("environmentChanged");
  else if (state.phase === "connected") notice = t("connectedNotice");
  else if (!errorCode) notice = t("unconfiguredNotice");
  const failure = state?.error?.details?.failures?.[0];
  const failureService = state?.error?.details?.service ?? failure?.service;
  const failureStage = state?.error?.details?.stage ?? failure?.stage;
  return h(
    "div",
    { className: "dho" },
    h("style", null, css),
    h("h2", null, t("title")),
    h("p", { className: "dho-desc" }, t("description")),
    notice ? h("p", { className: "dho-notice", role: "status" }, notice) : null,
    errorCode ? h(
      "div",
      { className: "dho-notice error", role: "alert" },
      h("strong", null, t("errorTitle")),
      "\uFF1A",
      safeTranslation(t, `error.${errorCode}`, "error.generic"),
      failureService ? h("div", null, serviceLabel(failureService, t), failureStage ? ` \xB7 ${t(`stage.${failureStage}`)}` : "") : null
    ) : null,
    state?.warning ? h(
      "p",
      { className: "dho-notice error", role: "alert" },
      h("strong", null, t("warningTitle")),
      "\uFF1A",
      safeTranslation(t, `error.${state.warning}`, "error.generic")
    ) : null,
    h(
      "form",
      { onSubmit: (event) => {
        event.preventDefault();
        if (!disabled && apiKey.trim() && state?.origin) void perform("connect", { apiKey, origin: state.origin });
      } },
      h(
        "div",
        { className: "dho-field" },
        h("label", { className: "dho-label", htmlFor: "dho-origin" }, t("origin")),
        h("input", { id: "dho-origin", className: "dho-input", value: state?.origin ?? "", placeholder: t("originMissing"), readOnly: true, "aria-readonly": true })
      ),
      h(
        "div",
        { className: "dho-field" },
        h(
          "div",
          { className: "dho-keyline" },
          h("label", { className: "dho-label", htmlFor: "dho-api-key" }, t("apiKey")),
          h("span", { className: "dho-saved" }, state?.configured ? state.phase === "connected" ? t("keySaved") : t("keySavedDisconnected") : t("keyNotSaved"))
        ),
        h("input", {
          id: "dho-api-key",
          className: "dho-input",
          type: "password",
          value: apiKey,
          placeholder: t("apiKeyPlaceholder"),
          autoComplete: "new-password",
          spellCheck: false,
          disabled,
          required: true,
          onChange: (event) => setApiKey(event.target.value)
        })
      ),
      h(
        "div",
        { className: "dho-actions" },
        h("button", { className: "dho-button primary", type: "submit", disabled: disabled || !apiKey.trim() || !state?.origin }, busy && state?.phase === "validating" ? t("validating") : t("validateConnect")),
        busy && !legacy ? h("button", { className: "dho-button", type: "button", onClick: cancel }, t("cancel")) : null,
        state?.canRetry && !disabled ? h("button", { className: "dho-button", type: "button", onClick: () => void perform("retry", { origin: state.origin }) }, t("retry")) : null,
        state?.services?.some((service) => service.registered) && !legacy ? h("button", { className: "dho-button", type: "button", disabled: busy, onClick: () => void perform("disconnect") }, t("disconnect")) : null,
        state?.configured && !legacy ? h("button", { className: "dho-button danger", type: "button", disabled: busy, onClick: () => {
          if (window.confirm(t("confirmClear"))) void perform("clearKey");
        } }, t("clearKey")) : null
      )
    ),
    h(
      "section",
      { className: "dho-services", "aria-label": t("services") },
      h("h3", null, t("services")),
      ...(state?.services ?? []).map((service) => h(
        "div",
        { className: "dho-row", key: service.name },
        h("span", null, serviceLabel(service.name, t)),
        h("span", null, serviceState(service, t))
      ))
    ),
    h("p", { className: "dho-security" }, t("security"))
  );
}
var inject = ["slots", "locale", "connection"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(CLIENT_LOCALE, { zh, en }), "datahub-onboarding: locales");
  const t = ctx.locale.bind(CLIENT_LOCALE);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "datahub-onboarding",
    order: 25,
    label: () => t("nav"),
    locale: CLIENT_LOCALE,
    inject: () => ({ connection: ctx.connection })
  }, DataHubSettingsSection));
}

return module.exports;}});
