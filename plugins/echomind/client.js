// @local/echomind DSH web client bundle (zero JSX/TS, zero third-party deps)
// Registers:
//   1. settings.section (id="echomind-settings", label="EchoMind 会议配置", order=32)
//      - multi-account Feishu browser PKCE authorization (mirrors @local/contract-sure & @local/salesforge)
//      - runtime permissions, native binaries & offline speech models setup
//      - voiceprints & admin company management
//   2. Plugin page contributions (only for @local/echomind):
//      - plugins.detail.actions ("管理" + "试用")
//      - plugins.detail.badge (connection / live recording status)
//      - plugins.bundle.config ("试试这样问" panel under README)
//   3. Global recording surfaces:
//      - shell.overlay (id="echomind-recorder-bar"): floating live dual-track recorder & progress pill (renders null when idle)
//      - sidebar.footer.action (id="echomind-recorder-trigger"): quick recording launcher & recent meetings drawer
//   4. conversation.chat.turnTail (id="echomind-cards", order=27):
//      - echomind-auth-required: in-place Feishu connect card
//      - echomind-recording-card: live recording / transcription progress card
//      - echomind-minutes-card: grounded minutes summary, DataHub knowledge toggle, open full inspector & audio player
//      - echomind-todo-draft: interactive todo confirmation card; Feishu tasks are created only after clicking confirm here
// Class prefixes: "emu-" / "emx-" (isolated from "csu-"/"csx-" and "sfu-"/"sfx-").

window.__ModuleLoader__.load({
  id: "@local/echomind",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var React = react && react.default ? react.default : react;
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var KEY = "echomind";
    var PACKAGE_NAME = "@local/echomind";
    var AUTH_REQUIRED_KIND = "echomind-auth-required";
    var RECORDING_CARD_KIND = "echomind-recording-card";
    var MINUTES_CARD_KIND = "echomind-minutes-card";
    var TODO_DRAFT_KIND = "echomind-todo-draft";
    var RECORDING_EVENT_RECORD_TYPE = "plugin:echomind/recording-event";
    var MINUTES_PRESENTED_RECORD_TYPE = "plugin:echomind/minutes-presented";
    var TODO_DRAFT_RECORD_TYPE = "plugin:echomind/todo-draft";
    var TODO_PUSHED_RECORD_TYPE = "plugin:echomind/todos-pushed";

    function isRecordType(type) {
      return (
        type === RECORDING_EVENT_RECORD_TYPE ||
        type === MINUTES_PRESENTED_RECORD_TYPE ||
        type === TODO_DRAFT_RECORD_TYPE ||
        type === TODO_PUSHED_RECORD_TYPE
      );
    }

    var TRY_PROMPT = "检查一下我的 EchoMind 录音环境和飞书登录状态，顺便列出最近的会议纪要";
    var EXAMPLE_PROMPTS = [
      "准备开腾讯会议了，帮我检查一下麦克风和系统录音权限，确认没问题就开始双轨录音",
      "把最近一场会议的纪要和待办草稿列出来，帮我核对负责人和截止时间后生成飞书推送确认卡",
      "检索我历史会议里提到「上线」或「回款」的原话出处，标明发言人、时间点和对应会议",
    ];

    // Verbatim copy of icon.svg (verified by client.test.js)
    var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">\n  <rect x="3" y="3" width="42" height="42" rx="12" fill="#FBF5EE" stroke="#1F1F1F" stroke-width="2.2"/>\n  <path d="M13 24v0M18 17v14M24 12v24M30 17v14M35 24v0" stroke="#1F1F1F" stroke-width="3.2" stroke-linecap="round"/>\n  <circle cx="35.5" cy="12.5" r="4.5" fill="#D97757"/>\n</svg>\n';

    var EXAMPLES_LOOK = {
      name: "EchoMind 会议纪要",
      icon: "data:image/svg+xml," + encodeURIComponent(ICON_SVG),
      brand: ["#C25B3A", "#F2A58A"],
      onBrand: ["#ffffff", "#26120B"],
      glow: ["rgba(217,119,87,.24)", "rgba(242,165,138,.2)"],
      fallback: [
        "radial-gradient(55% 110% at 0% 100%,#f9d8c5,rgba(249,216,197,0) 70%),radial-gradient(50% 100% at 100% 45%,#f4e4d2,rgba(244,228,210,0) 70%),#fbf6f0",
        "radial-gradient(55% 110% at 100% 0%,#542d20,rgba(84,45,32,0) 70%),radial-gradient(50% 100% at 0% 100%,#3e261d,rgba(62,38,29,0) 70%),#1b1512",
      ],
    };

    var AUTH_CARD_TITLES = {
      "no-account": "还没有连接 EchoMind 飞书账户",
      expired: "EchoMind 飞书登录已过期",
      revoked: "EchoMind 飞书登录已失效",
    };

    var CREDENTIAL_NOTES = {
      "dsh-credentials": "会话令牌保存在小智办公凭据存储中（0600），界面不会显示令牌。",
      file: "会话令牌保存在本机插件配置文件中（仅本人可读），界面不会显示令牌。",
    };

    var SOURCE_LABELS = {
      tencent: "腾讯会议",
      feishu: "飞书会议",
      zoom: "Zoom",
      offline: "线下会议",
      other: "会议",
    };

    var PERMISSION_LABELS = {
      granted: "已允许",
      denied: "已拒绝",
      undetermined: "未授权",
      restricted: "受限",
      unknown: "未知",
    };

    function formatShortDate(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return (d.getMonth() + 1) + "月" + d.getDate() + "日";
    }

    function shortOpenId(openId) {
      var s = String(openId || "");
      if (s.length <= 16) return s;
      return s.slice(0, 10) + "…" + s.slice(-4);
    }

    function voiceprintMeta(vp) {
      var enrolled = !!(vp.enrolled || (vp.seconds && vp.seconds > 0) || (vp.samples && vp.samples > 0));
      var parts = [];
      if (vp.department) parts.push(vp.department);
      if (vp.title) parts.push(vp.title);
      var deptText = parts.join(" · ");
      if (vp.status === "agreed" && enrolled) {
        var detail = [];
        if (deptText) detail.push(deptText);
        if (vp.samples) detail.push(vp.samples + " 段声音");
        if (vp.seconds) detail.push("约 " + Math.round(vp.seconds) + " 秒");
        return { tone: "ok", label: "已建立声纹", detail: detail.join(" · ") || "已录入声纹", canAsk: false, deleteLabel: "删除声纹" };
      }
      if (vp.status === "agreed") {
        return {
          tone: "clay",
          label: "已同意",
          detail: [deptText, "下次会议命名时自动记住声音"].filter(Boolean).join(" · "),
          canAsk: false,
          deleteLabel: "撤销",
        };
      }
      if (vp.status === "asked") {
        var askedDate = formatShortDate(vp.askedAt);
        return {
          tone: "warn",
          label: "等待同意",
          detail: [deptText, (askedDate ? askedDate + " " : "") + "已发送飞书同意卡片"].filter(Boolean).join(" · "),
          canAsk: true,
          askLabel: "再次提醒",
          deleteLabel: "撤回",
        };
      }
      var ansDate = formatShortDate(vp.answeredAt);
      return {
        tone: "neutral",
        label: "未同意",
        detail: [deptText, (ansDate ? ansDate + " " : "") + "本人未同意保存声纹"].filter(Boolean).join(" · "),
        canAsk: true,
        askLabel: "再问一次",
        deleteLabel: "删除记录",
      };
    }

    var UI_CSS = [
      ".emu{--emu-text:var(--dsw-alias-label-primary,#1f1f1f);--emu-muted:var(--dsw-alias-label-secondary,#5c5c5c);--emu-subtle:var(--dsw-alias-label-tertiary,#8a8a8a);--emu-line:var(--dsw-alias-border-l2,rgba(0,0,0,.08));--emu-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.16));--emu-surface:var(--dsw-alias-bg-layer-2,#f7f7f7);--emu-raised:var(--dsw-alias-bg-layer-3,#fff);--emu-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--emu-clay:#d97757;--emu-ok:var(--dsw-alias-state-success-primary,#1a7f37);--emu-warn:var(--dsw-alias-state-warn-primary,#b45309);--emu-err:var(--dsw-alias-state-error-primary,#d1242f);--emu-info:var(--dsw-alias-state-business-primary,#2563eb);--emu-r-sm:var(--dsw-radius-sm,6px);--emu-r-md:var(--dsw-radius-md,8px);--emu-r-lg:var(--dsw-radius-lg,12px);--emu-hair:var(--dsh-hairline-width,.5px)}",
      ".emu,.emu *{box-sizing:border-box}",
      ".emu-actions{display:inline-flex;align-items:center;gap:8px;flex:none}",
      ".emu-row-actions{display:inline-flex;align-items:center;gap:6px;flex:none;white-space:nowrap}",
      ".emu-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:34px;padding:0 13px;border:0;border-radius:var(--emu-r-md);background:transparent;color:var(--emu-text);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap;text-decoration:none}",
      ".emu-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--emu-r-sm)}",
      ".emu-btn:disabled{opacity:.42;cursor:not-allowed}",
      ".emu-btn-primary{background:var(--dsw-alias-button-primary-fill,#1f1f1f);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".emu-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#383838)}",
      ".emu-btn-clay{background:var(--emu-clay);color:#fff}",
      ".emu-btn-clay:hover:not(:disabled){opacity:.9}",
      ".emu-btn-outline{box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong)}",
      ".emu-btn-outline:hover:not(:disabled),.emu-btn-ghost:hover:not(:disabled){background:var(--emu-hover)}",
      ".emu-btn-danger{color:var(--emu-err)}",
      ".emu-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--emu-r-sm);background:transparent;color:var(--emu-muted);cursor:pointer}",
      ".emu-icon-btn:hover:not(:disabled){background:var(--emu-hover);color:var(--emu-text)}",
      ".emu-tag{display:inline-flex;align-items:center;gap:4px;flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}",
      ".emu-tag-ok{background:color-mix(in srgb,var(--emu-ok) 12%,transparent);color:var(--emu-ok)}",
      ".emu-tag-warn{background:color-mix(in srgb,var(--emu-warn) 14%,transparent);color:var(--emu-warn)}",
      ".emu-tag-err{background:color-mix(in srgb,var(--emu-err) 12%,transparent);color:var(--emu-err)}",
      ".emu-tag-clay{background:color-mix(in srgb,var(--emu-clay) 14%,transparent);color:var(--emu-clay)}",
      ".emu-tag-neutral{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));color:var(--emu-muted)}",
      ".emu-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}",
      ".emu-dot-pulse{background:var(--emu-clay);animation:emu-pulse 1.2s ease-in-out infinite}",
      "@keyframes emu-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}",
      ".emu-stack{display:flex;flex-direction:column;gap:12px;width:100%;max-width:100%;min-width:0}",
      ".emu-section{display:flex;flex-direction:column;gap:10px;width:100%;max-width:100%;min-width:0}",
      ".emu-section+.emu-section{margin-top:18px}",
      ".emu-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}",
      ".emu-section-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--emu-text)}",
      ".emu-section-hint{font-size:12px;line-height:18px;color:var(--emu-muted)}",
      ".emu-card{display:flex;flex-direction:column;gap:10px;width:100%;max-width:100%;min-width:0;padding:14px 16px;border-radius:var(--emu-r-lg);background:var(--emu-raised);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong);color:var(--emu-text);font-size:13px;line-height:20px}",
      ".emu-list{margin:0;padding:0;list-style:none;width:100%;max-width:100%;min-width:0;border-radius:var(--emu-r-lg);background:var(--emu-raised);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong);overflow:hidden}",
      ".emu-row-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;min-width:0}",
      ".emu-row-item+.emu-row-item{border-top:var(--emu-hair) solid var(--emu-line)}",
      ".emu-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--emu-clay) 16%,transparent);color:var(--emu-clay);font-size:13px;font-weight:600}",
      ".emu-grow{flex:1;min-width:0}",
      ".emu-title-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13.5px;font-weight:500;min-width:0}",
      ".emu-sub{font-size:12px;color:var(--emu-muted);overflow:hidden;text-overflow:ellipsis;overflow-wrap:anywhere}",
      ".emu-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}",
      ".emu-row-end{justify-content:flex-end}",
      ".emu-note{margin:0;padding:8px 12px;border-radius:var(--emu-r-md);font-size:12px;line-height:18px}",
      ".emu-note-ok{background:color-mix(in srgb,var(--emu-ok) 10%,transparent);color:var(--emu-ok)}",
      ".emu-note-warn{background:color-mix(in srgb,var(--emu-warn) 12%,transparent);color:var(--emu-warn)}",
      ".emu-note-err{background:color-mix(in srgb,var(--emu-err) 10%,transparent);color:var(--emu-err)}",
      ".emu-field{display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".emu-label{font-size:12px;color:var(--emu-muted)}",
      ".emu-input{width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--emu-r-md);background:var(--emu-surface);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong);color:var(--emu-text);font:inherit;font-size:13px}",
      ".emu-input:focus{outline:2px solid var(--emu-clay);outline-offset:-1px}",
      ".emu-disclosure{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:2px 0;border:0;background:transparent;color:var(--emu-text);font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-align:left}",
      ".emu-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}",
      "dialog.emu-modal{width:min(580px,calc(100vw - 32px));max-width:none;max-height:min(800px,calc(100vh - 48px));margin:auto;padding:0;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--emu-surface);color:var(--emu-text);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.22));font-size:13px;line-height:20px;overflow:hidden}",
      "dialog.emu-modal.emu-modal-lg{width:min(860px,calc(100vw - 36px))}",
      "dialog.emu-modal[open]{display:flex;flex-direction:column}",
      "dialog.emu-modal::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42))}",
      ".emu-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:18px 16px 12px 22px;border-bottom:var(--emu-hair) solid var(--emu-line)}",
      ".emu-modal-title{margin:0;font-size:15.5px;font-weight:600}",
      ".emu-modal-body{flex:1;min-height:0;overflow:auto;padding:16px 22px 20px}",
      ".emu-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:12px 22px 18px;border-top:var(--emu-hair) solid var(--emu-line)}",
      ".emu-floating-rec{position:fixed;right:20px;bottom:20px;z-index:45;width:356px;max-width:calc(100vw - 24px);padding:12px 14px;border-radius:16px;background:var(--emu-raised);box-shadow:0 12px 36px rgba(0,0,0,.18),inset 0 0 0 1px var(--emu-line-strong);color:var(--emu-text)}",
      ".emu-meters{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}",
      ".emu-meter-bars{display:flex;height:8px;gap:2px;margin-top:4px}",
      ".emu-meter-bar{flex:1;border-radius:2px;background:var(--emu-line);transition:background .07s}",
      ".emu-meter-bar-on{background:var(--emu-text)}",
      ".emu-meter-bar-peak{background:var(--emu-clay)}",
      ".emu-progress-track{height:6px;border-radius:999px;background:var(--emu-line);overflow:hidden}",
      ".emu-progress-fill{height:100%;border-radius:999px;background:var(--emu-clay);transition:width .2s ease}",
      ".emu-tail{display:flex;flex-direction:column;gap:10px;margin-top:10px}",
      ".emu-todo-row{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--emu-r-md);background:var(--emu-surface);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line)}",
      ".emu-todo-grid{display:grid;grid-template-columns:1fr 140px 128px;gap:8px}",
      "@media (max-width:640px){.emu-todo-grid{grid-template-columns:1fr}}",
      ".emu-cite{display:inline-flex;align-items:center;padding:0 6px;margin-left:4px;border:0;border-radius:4px;background:color-mix(in srgb,var(--emu-clay) 14%,transparent);color:var(--emu-clay);font-size:11px;cursor:pointer}",
      ".emu-seg{display:flex;gap:10px;padding:8px 10px;border-radius:var(--emu-r-md);cursor:pointer}",
      ".emu-seg:hover{background:var(--emu-hover)}",
      ".emu-seg-active{background:color-mix(in srgb,var(--emu-clay) 12%,transparent);box-shadow:inset 2px 0 0 var(--emu-clay)}",
      ".emu-tabs{display:inline-flex;gap:4px;padding:3px;border-radius:var(--emu-r-md);background:var(--emu-surface)}",
      ".emu-tab{border:0;background:transparent;color:var(--emu-muted);padding:4px 12px;border-radius:var(--emu-r-sm);font:inherit;font-size:12.5px;cursor:pointer}",
      ".emu-tab-on{background:var(--emu-raised);color:var(--emu-text);font-weight:500;box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      ".emu-footer-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:var(--emu-r-md);background:transparent;color:var(--emu-text);font:inherit;font-size:12.5px;cursor:pointer}",
      ".emu-footer-btn:hover{background:var(--emu-hover)}",
      ".emx-wrap{position:relative;overflow:hidden;border-radius:16px;padding:22px 20px;margin-top:14px;color:var(--emu-text);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong)}",
      ".emx-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}",
      ".emx-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}",
      "@media (max-width:780px){.emx-grid{grid-template-columns:1fr}}",
      ".emx-card{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:10px;padding:14px;border:0;border-radius:12px;background:color-mix(in srgb,var(--emu-raised) 82%,transparent);backdrop-filter:blur(10px);box-shadow:inset 0 0 0 var(--emu-hair) var(--emu-line-strong);color:inherit;text-align:left;font:inherit;font-size:13px;line-height:19px;cursor:pointer;transition:transform .14s ease}",
      ".emx-card:hover{transform:translateY(-1px)}",
    ].join("\n");

    // ---- Shared utilities ----
    function noop() {}

    function rpcCall(connection, method, args, signal) {
      if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") {
        return Promise.resolve({ ok: false, error: { code: "NO_CONNECTION", message: "当前未连接宿主 RPC 服务。" } });
      }
      return connection.rpc.call("/api", "echomind/" + method, { args: args || {} }, signal);
    }

    function extractRpcError(res, fallback) {
      if (res && res.error) {
        if (typeof res.error === "string") return res.error;
        if (typeof res.error.message === "string" && res.error.message) return res.error.message;
      }
      if (res && typeof res.message === "string" && res.message) return res.message;
      return fallback || "操作失败，请稍后重试。";
    }

    function callRpc(connection, method, args, signal) {
      return Promise.resolve()
        .then(function () { return rpcCall(connection, method, args, signal); })
        .then(function (res) {
          if (res && res.ok === true) return res.value;
          throw new Error(extractRpcError(res, "请求失败，请稍后重试。"));
        });
    }

    function errorText(err, fallback) {
      if (err && typeof err.message === "string" && err.message) return err.message;
      return fallback || "操作失败，请稍后重试。";
    }

    function formatClockMs(ms) {
      var s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      var hVal = Math.floor(s / 3600);
      var mVal = Math.floor((s % 3600) / 60);
      var sVal = s % 60;
      var pad = function (n) { return n < 10 ? "0" + n : String(n); };
      return hVal > 0 ? hVal + ":" + pad(mVal) + ":" + pad(sVal) : pad(mVal) + ":" + pad(sVal);
    }

    function formatBytes(bytes) {
      var n = Number(bytes) || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
      if (n >= 1e6) return Math.max(1, Math.round(n / 1e6)) + " MB";
      if (n >= 1e3) return Math.max(1, Math.round(n / 1e3)) + " KB";
      return n + " B";
    }

    function isHttpUrl(url) {
      return typeof url === "string" && /^https?:\/\//i.test(url);
    }

    function openExternal(url) {
      if (!isHttpUrl(url) || typeof window === "undefined" || !window || typeof window.open !== "function") return;
      try { window.open(url, "_blank", "noopener"); } catch (_) {}
    }

    function ownsSubject(subject) {
      return !!subject && subject.kind === "bundle" && !!subject.pkg && subject.pkg.name === PACKAGE_NAME;
    }

    function createServices(getSvc, fallbackConnection) {
      return {
        connection: function () { return getSvc("connection") || fallbackConnection; },
        workspace: function () { return getSvc("uiWorkspace"); },
        navigation: function () { return getSvc("pluginNavigation"); },
      };
    }

    function serviceOf(services, name) {
      if (!services || typeof services[name] !== "function") return undefined;
      try { return services[name](); } catch (_) { return undefined; }
    }

    function startSessionWithPrompt(services, prompt) {
      var workspace = serviceOf(services, "workspace");
      if (!workspace || typeof workspace.startSession !== "function") return false;
      try {
        var pending = workspace.startSession(undefined, { prompt: prompt, whenDraftExists: "append" });
        if (pending && typeof pending.then === "function") pending.then(noop, noop);
        return true;
      } catch (_) {
        return false;
      }
    }

    // ---- Shared Account Store & Live Runtime Store ----
    var EMPTY_ACCOUNT_SNAP = { status: "idle", state: null, error: "" };

    function createAccountStore(getConnection) {
      var snapshot = EMPTY_ACCOUNT_SNAP;
      var listeners = [];
      var inflight = null;
      var fetchedAt = 0;

      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch);
        listeners.slice().forEach(function (fn) { try { fn(); } catch (_) {} });
      }

      function refresh() {
        if (inflight) return inflight;
        if (!snapshot.state) publish({ status: "loading", error: "" });
        inflight = callRpc(getConnection(), "getState", {})
          .then(function (value) {
            fetchedAt = Date.now();
            publish({ status: "ready", state: value, error: "" });
            return value;
          })
          .catch(function (err) {
            publish({ status: snapshot.state ? "ready" : "error", error: errorText(err, "读取 EchoMind 配置失败。") });
            throw err;
          })
          .finally(function () { inflight = null; });
        return inflight;
      }

      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (fn) {
          listeners.push(fn);
          return function () {
            var idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
        ensure: function (maxAgeMs) {
          var age = maxAgeMs == null ? 10000 : maxAgeMs;
          if (!snapshot.state || Date.now() - fetchedAt > age) refresh().catch(noop);
        },
        refresh: refresh,
        applyState: function (state) {
          fetchedAt = Date.now();
          publish({ status: "ready", state: state, error: "" });
        },
      };
    }

    function useStoreSnapshot(store, maxAgeMs) {
      var [snap, setSnap] = useState(function () { return store ? store.getSnapshot() : EMPTY_ACCOUNT_SNAP; });
      useEffect(function () {
        if (!store) return undefined;
        setSnap(store.getSnapshot());
        var unsub = store.subscribe(function () { setSnap(store.getSnapshot()); });
        if (maxAgeMs !== false && typeof store.ensure === "function") store.ensure(maxAgeMs);
        return unsub;
      }, [store]);
      return snap;
    }

    // Live recording + pipeline snapshot store: polls at 220ms ONLY while recording/processing is active.
    function createLiveStore(getConnection) {
      var snap = { recording: null, jobs: [], modelDownload: null, binaryInstall: null };
      var listeners = [];
      var timer = null;
      var activeSubscribers = 0;

      function notify() {
        listeners.slice().forEach(function (fn) { try { fn(); } catch (_) {} });
      }

      function isBusy(next) {
        if (next.recording || next.modelDownload || next.binaryInstall) return true;
        return !!(next.jobs && next.jobs.some(function (j) { return j && j.step !== "models" && !j.error; }));
      }

      function scheduleNext(busy) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (activeSubscribers <= 0) return;
        // 录音或后台转写进行中采用 220ms 刷新双轨电平；完全空闲时降到 8000ms 低功耗探测。
        timer = setTimeout(pollOnce, busy ? 220 : 8000);
      }

      function pollOnce() {
        if (activeSubscribers <= 0) return;
        callRpc(getConnection(), "getLiveSnapshot", {})
          .then(function (val) {
            if (val && typeof val === "object") {
              snap = {
                recording: val.recording || null,
                jobs: Array.isArray(val.jobs) ? val.jobs : [],
                modelDownload: val.modelDownload || null,
                binaryInstall: val.binaryInstall || null,
              };
              notify();
            }
            scheduleNext(isBusy(snap));
          })
          .catch(function () {
            scheduleNext(false);
          });
      }

      return {
        getSnapshot: function () { return snap; },
        subscribe: function (fn) {
          listeners.push(fn);
          activeSubscribers += 1;
          if (activeSubscribers === 1) pollOnce();
          return function () {
            var idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
            activeSubscribers = Math.max(0, activeSubscribers - 1);
            if (activeSubscribers === 0 && timer) { clearTimeout(timer); timer = null; }
          };
        },
        poke: function () { pollOnce(); },
      };
    }

    function useLiveSnapshot(liveStore) {
      var [snap, setSnap] = useState(function () { return liveStore ? liveStore.getSnapshot() : { recording: null, jobs: [] }; });
      useEffect(function () {
        if (!liveStore) return undefined;
        setSnap(liveStore.getSnapshot());
        return liveStore.subscribe(function () { setSnap(liveStore.getSnapshot()); });
      }, [liveStore]);
      return snap;
    }

    // ---- Conversation Event Projection (for conversation.chat.turnTail) ----
    var KNOWN_CARD_KINDS = [AUTH_REQUIRED_KIND, RECORDING_CARD_KIND, MINUTES_CARD_KIND, TODO_DRAFT_KIND];

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

    function extractToolPayload(value) {
      if (typeof value === "string") {
        if (value.indexOf("echomind-") === -1) return null;
        try {
          return extractToolPayload(JSON.parse(value));
        } catch (_) {
          return null;
        }
      }
      if (!value || typeof value !== "object" || isFailedValue(value)) return null;
      if (typeof value.kind === "string" && KNOWN_CARD_KINDS.indexOf(value.kind) !== -1) return value;
      var keys = ["structuredContent", "value", "result", "message", "output"];
      for (var i = 0; i < keys.length; i++) {
        if (value[keys[i]] != null) {
          var found = extractToolPayload(value[keys[i]]);
          if (found) return found;
        }
      }
      if (Array.isArray(value.content)) {
        for (var j = 0; j < value.content.length; j++) {
          var part = value.content[j];
          if (part && part.type === "text" && typeof part.text === "string") {
            var foundText = extractToolPayload(part.text);
            if (foundText) return foundText;
          }
        }
      }
      if (typeof value.text === "string") {
        return extractToolPayload(value.text);
      }
      return null;
    }

    function initialProjection(turn) {
      return {
        turn: turn,
        calls: new Map(),
        results: new Map(),
        pluginRecords: [],
        invalidated: new Set(),
        replacedRanges: [],
        value: { turn: turn, authRequired: null, recordingCards: [], minutesCards: [], todoDrafts: [], pushedByDraft: {} },
      };
    }

    function rebuildProjectionValue(state) {
      var authRequired = null;
      var recordingCards = [];
      var minutesMap = new Map();
      var draftMap = new Map();
      var pushedByDraft = {};

      for (var r = 0; r < state.pluginRecords.length; r++) {
        var rec = state.pluginRecords[r];
        if (rec.type === TODO_PUSHED_RECORD_TYPE && rec.data && rec.data.draftId) {
          pushedByDraft[rec.data.draftId] = Object.assign({ status: "pushed" }, rec.data);
        } else if (rec.type === TODO_DRAFT_RECORD_TYPE && rec.data && rec.data.draftId && Array.isArray(rec.data.todos)) {
          draftMap.set(rec.data.draftId, Object.assign({ seq: rec.seq }, rec.data));
        }
      }

      state.calls.forEach(function (call, callId) {
        var res = state.results.get(callId);
        if (!res || res.failed || !res.payload || typeof res.payload !== "object") return;
        var p = res.payload;
        if (p.kind === AUTH_REQUIRED_KIND) {
          if (!authRequired || (res.seq || 0) >= (authRequired.seq || 0)) {
            authRequired = Object.assign({ seq: res.seq, callId: callId, toolName: call.name }, p);
          }
        } else if (p.kind === RECORDING_CARD_KIND) {
          recordingCards.push(Object.assign({ seq: res.seq, callId: callId }, p));
        } else if (p.kind === MINUTES_CARD_KIND && p.meetingId && !minutesMap.has(p.meetingId)) {
          minutesMap.set(p.meetingId, Object.assign({ seq: res.seq, callId: callId }, p));
        } else if (p.kind === TODO_DRAFT_KIND && p.draftId && !draftMap.has(p.draftId)) {
          draftMap.set(p.draftId, Object.assign({ seq: res.seq, callId: callId }, p));
        }
      });

      var bySeq = function (a, b) { return (a.seq || 0) - (b.seq || 0); };
      recordingCards.sort(bySeq);
      var minutesCards = Array.from(minutesMap.values()).sort(bySeq);
      var todoDrafts = Array.from(draftMap.values()).sort(bySeq);

      return Object.assign({}, state, {
        value: {
          turn: state.turn,
          authRequired: authRequired,
          recordingCards: recordingCards,
          minutesCards: minutesCards,
          todoDrafts: todoDrafts,
          pushedByDraft: pushedByDraft,
        },
      });
    }

    function updateProjection(state, event) {
      if (!state || !event || !event.data) return state;
      if (event.data.turn != null && event.data.turn !== state.turn) return state;

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
        return rebuildProjectionValue(Object.assign({}, state, {
          calls: nextCalls,
          results: nextResults,
          pluginRecords: nextRecords,
          invalidated: invalidated,
          replacedRanges: state.replacedRanges.concat([range]),
        }));
      }

      if (isRecordType(event.type)) {
        if (withinRanges(event.seq, state.replacedRanges) || withinRanges(event.data && event.data.callSeq, state.replacedRanges)) {
          return state;
        }
        for (var r = 0; r < state.pluginRecords.length; r++) {
          if (state.pluginRecords[r].seq === event.seq && state.pluginRecords[r].type === event.type) return state;
        }
        return rebuildProjectionValue(Object.assign({}, state, {
          pluginRecords: state.pluginRecords.concat([{ type: event.type, seq: event.seq, data: event.data }]),
        }));
      }

      if (event.type === "tool/call") {
        var callData = event.data || {};
        var name = callData.name;
        var cid = callData.callId;
        if (
          typeof name !== "string" || !name ||
          typeof cid !== "string" || !cid ||
          state.calls.has(cid) || state.invalidated.has(cid) ||
          withinRanges(event.seq, state.replacedRanges)
        ) {
          return state;
        }
        var calls = new Map(state.calls);
        calls.set(cid, { name: name, callSeq: event.seq });
        return rebuildProjectionValue(Object.assign({}, state, { calls: calls }));
      }

      if (event.type !== "tool/result" || (event.surfaceOp != null && event.surfaceOp !== "append")) return state;
      var resCallId = callIdentity(event);
      var callItem = resCallId ? state.calls.get(resCallId) : null;
      if (!callItem || state.results.has(resCallId) || state.invalidated.has(resCallId)) return state;
      if (withinRanges(event.seq, state.replacedRanges) || withinRanges(callItem.callSeq, state.replacedRanges)) return state;
      if (typeof event.seq === "number" && typeof callItem.callSeq === "number" && event.seq <= callItem.callSeq) return state;

      var failed = isFailedValue(event.data);
      var payload = failed ? null : extractToolPayload(event.data);
      var results = new Map(state.results);
      results.set(resCallId, { seq: event.seq, failed: failed, payload: payload });
      return rebuildProjectionValue(Object.assign({}, state, { results: results }));
    }

    var eventDefinition = {
      kind: KEY,
      match: function (event) {
        if (!event || !event.data || event.data.turn == null) return null;
        if (event.type === "tool/call" && typeof event.data.name === "string" && event.data.name) {
          return { id: String(event.data.turn), role: "start" };
        }
        if (
          event.type === "tool/result" ||
          isRecordType(event.type) ||
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
        var st = context.state;
        if (scope !== "turn" || !st) return null;
        if (previous && previous.kind === "turn" && previous.turn === st.turn && previous.value === st.value) {
          return previous;
        }
        return { kind: "turn", turn: st.turn, key: KEY, value: st.value };
      },
    };

    // ---- Modal Primitive ----
    var dialogCounter = 0;

    function Modal(props) {
      var ref = useRef(null);
      var idRef = useRef("");
      if (!idRef.current) { dialogCounter += 1; idRef.current = "emu-dlg-" + dialogCounter; }
      useEffect(function () {
        var el = ref.current;
        if (el && typeof el.showModal === "function" && !el.open) {
          try { el.showModal(); } catch (_) { try { el.setAttribute("open", ""); } catch (__) {} }
        }
        return function () {
          if (el && el.open && typeof el.close === "function") {
            try { el.close(); } catch (_) {}
          }
        };
      }, []);

      return h("dialog", {
        ref: ref,
        className: "emu emu-modal" + (props.large ? " emu-modal-lg" : ""),
        "aria-labelledby": idRef.current + "-title",
        onCancel: function (e) { e.preventDefault(); if (props.onClose) props.onClose(); },
        onKeyDown: function (e) { e.stopPropagation(); },
        onClick: function (e) {
          e.stopPropagation();
          if (props.dismissOnBackdrop && e.target === e.currentTarget && props.onClose) props.onClose();
        },
      },
        h("style", null, UI_CSS),
        h("div", { className: "emu-modal-head" },
          h("h2", { id: idRef.current + "-title", className: "emu-modal-title" }, props.title),
          h("button", { type: "button", className: "emu-icon-btn", "aria-label": "关闭", onClick: props.onClose }, "✕"),
        ),
        h("div", { className: "emu-modal-body" }, props.body),
        props.footer ? h("div", { className: "emu-modal-foot" }, props.footer) : null,
      );
    }

    // ---- Feishu Browser Authorization Dialog (mirrors contract-sure & salesforge UX) ----
    function AuthorizeDialog(props) {
      var conn = serviceOf(props.services, "connection");
      var initCode = (props.initialJoinCode || "").toUpperCase();
      var [joinCode, setJoinCode] = useState(initCode);
      var [phase, setPhase] = useState("input"); // input | starting | waiting | approved | error
      var [authData, setAuthData] = useState(null);
      var [error, setError] = useState("");
      var [approvedAccount, setApprovedAccount] = useState(null);
      var reqIdRef = useRef("");
      var timerRef = useRef(null);
      var closedRef = useRef(false);

      function clearPoll() {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      }

      useEffect(function () {
        return function () {
          closedRef.current = true;
          clearPoll();
          if (reqIdRef.current) {
            callRpc(conn, "cancelAuthorization", { requestId: reqIdRef.current }).catch(noop);
          }
        };
      }, []);

      function pollNext(requestId, intervalMs) {
        clearPoll();
        timerRef.current = setTimeout(function () {
          if (closedRef.current || reqIdRef.current !== requestId) return;
          callRpc(conn, "pollAuthorization", { requestId: requestId })
            .then(function (res) {
              if (closedRef.current || reqIdRef.current !== requestId) return;
              if (res.status === "approved") {
                reqIdRef.current = "";
                setApprovedAccount(res.account || null);
                setPhase("approved");
                if (props.store) props.store.refresh().catch(noop);
                if (props.onApproved) props.onApproved(res.account || null);
                return;
              }
              if (res.status === "pending") {
                pollNext(requestId, intervalMs);
                return;
              }
              reqIdRef.current = "";
              setPhase("error");
              setError(res.message || (res.status === "denied" ? "你取消了飞书授权。" : "本次授权已过期，请重试。"));
            })
            .catch(function (err) {
              if (closedRef.current) return;
              pollNext(requestId, Math.min(intervalMs * 2, 6000));
            });
        }, intervalMs || 1500);
      }

      function beginAuth() {
        setPhase("starting");
        setError("");
        callRpc(conn, "startAuthorization", { joinCode: joinCode.trim().toUpperCase() })
          .then(function (res) {
            if (closedRef.current) return;
            reqIdRef.current = res.requestId;
            setAuthData(res);
            setPhase("waiting");
            openExternal(res.verifyUrl);
            pollNext(res.requestId, res.pollIntervalMs || 1500);
          })
          .catch(function (err) {
            if (closedRef.current) return;
            setPhase("error");
            setError(errorText(err, "发起飞书授权失败，请检查服务器地址和公司加入码。"));
          });
      }

      function handleClose() {
        clearPoll();
        if (reqIdRef.current) {
          var id = reqIdRef.current;
          reqIdRef.current = "";
          callRpc(conn, "cancelAuthorization", { requestId: id }).catch(noop);
        }
        if (props.onClose) props.onClose();
      }

      var body;
      var footer;

      if (phase === "approved") {
        body = h("div", { className: "emu-stack" },
          h("p", { className: "emu-note emu-note-ok", role: "status" },
            "已成功连接飞书账户" + (approvedAccount && approvedAccount.name ? "「" + approvedAccount.name + "」" : "") +
            (approvedAccount && approvedAccount.companyName ? "（" + approvedAccount.companyName + "）" : "") + "。"),
        );
        footer = h("button", { type: "button", className: "emu-btn emu-btn-primary", onClick: handleClose }, "完成");
      } else if (phase === "waiting" && authData) {
        body = h("div", { className: "emu-stack" },
          h("p", { style: { margin: 0 } },
            "已打开浏览器前往飞书授权" + (authData.companyName ? "（" + authData.companyName + "）" : "") +
            "，请在浏览器中点击「允许」，完成后这里会自动更新。"),
          h("div", { className: "emu-row" },
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { openExternal(authData.verifyUrl); } }, "重新打开飞书授权页"),
            h("span", { className: "emu-sub" }, "正在等待浏览器授权回调…"),
          ),
        );
        footer = h("button", { type: "button", className: "emu-btn emu-btn-outline", onClick: handleClose }, "取消");
      } else {
        body = h("div", { className: "emu-stack" },
          error ? h("p", { className: "emu-note emu-note-err", role: "alert" }, error) : null,
          h("div", { className: "emu-field" },
            h("label", { className: "emu-label", htmlFor: "emu-joincode" }, "公司加入码（6 位，默认公司可留空）"),
            h("input", {
              id: "emu-joincode",
              className: "emu-input emu-mono",
              type: "text",
              maxLength: 16,
              placeholder: "例如 ABC123（留空则使用默认公司）",
              value: joinCode,
              disabled: phase === "starting",
              onChange: function (e) { setJoinCode(e.target.value); },
            }),
          ),
          h("p", { className: "emu-sub", style: { margin: 0 } }, "将打开系统浏览器完成飞书 OAuth 授权，会话令牌仅保存在小智办公凭据库，界面不接触明文密钥。"),
        );
        footer = h("div", { className: "emu-row emu-row-end" },
          h("button", { type: "button", className: "emu-btn emu-btn-outline", onClick: handleClose }, "取消"),
          h("button", { type: "button", className: "emu-btn emu-btn-primary", disabled: phase === "starting", onClick: beginAuth },
            phase === "starting" ? "正在发起…" : "前往飞书授权"),
        );
      }

      return h(Modal, { title: "连接 EchoMind 飞书账户", body: body, footer: footer, onClose: handleClose });
    }

    // ---- Dual-Track Audio Level Meter (18 steps, mirrors Recorder.tsx) ----
    function LevelMeter(props) {
      var db = typeof props.db === "number" ? props.db : -90;
      var level = Math.max(0, Math.min(1, (db + 60) / 54));
      var lit = Math.round(level * 18);
      var bars = [];
      for (var i = 0; i < 18; i++) {
        var cls = "emu-meter-bar";
        if (i < lit) cls += i >= 15 ? " emu-meter-bar-peak" : " emu-meter-bar-on";
        bars.push(h("span", { key: String(i), className: cls }));
      }
      return h("div", null,
        h("div", { className: "emu-row", style: { justifyContent: "space-between", fontSize: "11.5px", color: "var(--emu-muted)" } },
          h("span", null, props.label),
          h("span", { className: "emu-mono" }, db <= -89 ? "—" : Math.round(db) + " dB"),
        ),
        h("div", { className: "emu-meter-bars", role: "meter", "aria-label": props.label + "音量", "aria-valuenow": Math.round(db) }, bars),
      );
    }

    // ---- Full Meeting Detail & Synced Audio Playback Modal ----
    function MeetingDetailModal(props) {
      var conn = serviceOf(props.services, "connection");
      var meetingId = props.meetingId;
      var [detail, setDetail] = useState(null);
      var [directory, setDirectory] = useState([]);
      var [transcript, setTranscript] = useState(null);
      var [playback, setPlayback] = useState(null);
      var [fallbackAudioUrl, setFallbackAudioUrl] = useState("");
      var [tab, setTab] = useState(props.initialTab || "minutes"); // minutes | transcript
      var [activeSegId, setActiveSegId] = useState(props.initialSegmentId || "");
      var [searchKw, setSearchKw] = useState("");
      var [rate, setRate] = useState(1);
      var [loading, setLoading] = useState(true);
      var [error, setError] = useState("");
      var [notice, setNotice] = useState("");
      var [editingSpeaker, setEditingSpeaker] = useState(null);
      var [renamePersonId, setRenamePersonId] = useState("");
      var [renameLabel, setRenameLabel] = useState("");
      var [rememberVoice, setRememberVoice] = useState(false);
      var audioRef = useRef(null);

      function loadAll() {
        setLoading(true);
        setError("");
        Promise.all([
          callRpc(conn, "getMeetingDetail", { meetingId: meetingId }),
          callRpc(conn, "getTranscriptPage", { meetingId: meetingId, offset: 0, limit: 200, speakerId: "", keyword: "" }).catch(function () { return null; }),
          callRpc(conn, "listDirectory", { refresh: false }).catch(function () { return { people: [] }; }),
          callRpc(conn, "getPlaybackInfo", { meetingId: meetingId }).catch(function () { return null; }),
        ]).then(function (arr) {
          setDetail(arr[0]);
          setTranscript(arr[1]);
          setDirectory(Array.isArray(arr[2] && arr[2].people) ? arr[2].people : []);
          setPlayback(arr[3]);
          setLoading(false);
        }).catch(function (err) {
          setError(errorText(err, "加载会议详情失败。"));
          setLoading(false);
        });
      }

      useEffect(function () {
        loadAll();
        return function () {
          if (fallbackAudioUrl && typeof URL !== "undefined" && URL.revokeObjectURL) {
            try { URL.revokeObjectURL(fallbackAudioUrl); } catch (_) {}
          }
        };
      }, [meetingId]);

      function seekToMs(ms, segId) {
        if (segId) setActiveSegId(segId);
        var audio = audioRef.current;
        if (audio && playback && playback.url) {
          try {
            audio.currentTime = Math.max(0, (Number(ms) || 0) / 1000);
            audio.playbackRate = rate;
            var p = audio.play();
            if (p && typeof p.catch === "function") p.catch(noop);
            return;
          } catch (_) {}
        }
        // Fallback: fetch 30s WAV slice via RPC when HTTP Range playback is unavailable.
        callRpc(conn, "getAudioSlice", { meetingId: meetingId, startMs: ms || 0, durationMs: 30000 })
          .then(function (slice) {
            if (!slice || !slice.base64) return;
            var bin = atob(slice.base64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var blobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
            setFallbackAudioUrl(blobUrl);
            setTimeout(function () {
              if (audioRef.current) {
                audioRef.current.src = blobUrl;
                audioRef.current.play().catch(noop);
              }
            }, 30);
          })
          .catch(noop);
      }

      function jumpEvidence(segId) {
        setTab("transcript");
        setActiveSegId(segId);
        var segs = (transcript && transcript.segments) || [];
        for (var i = 0; i < segs.length; i++) {
          if (segs[i].id === segId) {
            seekToMs(segs[i].start, segId);
            break;
          }
        }
      }

      function saveSpeakerRename() {
        if (!editingSpeaker) return;
        var chosen = directory.find(function (p) { return p.id === renamePersonId; });
        var finalLabel = renameLabel.trim() || (chosen ? chosen.name : editingSpeaker.label);
        callRpc(conn, "renameSpeaker", {
          meetingId: meetingId,
          speakerId: editingSpeaker.id,
          personId: renamePersonId || null,
          label: finalLabel,
          rememberVoice: !!rememberVoice,
        }).then(function (res) {
          setEditingSpeaker(null);
          setNotice(res && res.voiceprint && res.voiceprint.status === "asked"
            ? "已更新说话人，并向对方发送了飞书声纹同意卡片。"
            : "已更新说话人名称。");
          loadAll();
        }).catch(function (err) {
          setError(errorText(err, "更新说话人失败。"));
        });
      }

      function handleSearchTranscript() {
        callRpc(conn, "getTranscriptPage", { meetingId: meetingId, offset: 0, limit: 200, speakerId: "", keyword: searchKw.trim() })
          .then(function (page) { setTranscript(page); })
          .catch(function (err) { setError(errorText(err, "搜索逐字稿失败。")); });
      }

      var meeting = detail && detail.meeting;
      var speakers = (meeting && meeting.speakers) || [];
      var speakerNameMap = {};
      speakers.forEach(function (sp) {
        var p = directory.find(function (d) { return d.id === sp.personId; });
        speakerNameMap[sp.id] = (p && p.name) || sp.label || sp.id;
      });

      var body = loading
        ? h("p", { className: "emu-sub" }, "正在加载会议详情与本地录音…")
        : !meeting
          ? h("p", { className: "emu-note emu-note-err" }, error || "找不到该会议。")
          : h("div", { className: "emu-stack" },
              error ? h("p", { className: "emu-note emu-note-err", role: "alert" }, error) : null,
              notice ? h("p", { className: "emu-note emu-note-ok", role: "status" }, notice) : null,
              // Audio player bar
              meeting.hasAudio
                ? h("div", { className: "emu-card" },
                    h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                      h("span", { style: { fontWeight: 500 } }, "双轨时间轴音频回放"),
                      h("div", { className: "emu-row" },
                        [1, 1.25, 1.5, 2].map(function (r) {
                          return h("button", {
                            key: String(r),
                            type: "button",
                            className: "emu-btn emu-btn-sm " + (rate === r ? "emu-btn-primary" : "emu-btn-outline"),
                            onClick: function () {
                              setRate(r);
                              if (audioRef.current) audioRef.current.playbackRate = r;
                            },
                          }, r + "x");
                        }),
                      ),
                    ),
                    h("audio", {
                      ref: audioRef,
                      controls: true,
                      preload: "metadata",
                      src: fallbackAudioUrl || (playback && playback.url) || undefined,
                      style: { width: "100%", height: "36px" },
                    }),
                  )
                : null,
              // Speakers & Voiceprint bar
              speakers.length > 0
                ? h("div", { className: "emu-card" },
                    h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                      h("span", { style: { fontWeight: 500 } }, "说话人（点击可命名并选择记住声纹）"),
                      h("div", { className: "emu-row" },
                        h("button", {
                          type: "button",
                          className: "emu-btn emu-btn-sm emu-btn-outline",
                          onClick: function () {
                            callRpc(conn, "regenerateMinutes", { meetingId: meetingId })
                              .then(function () { setNotice("已开始重新生成纪要，请稍候刷新查看。"); })
                              .catch(function (e) { setError(errorText(e)); });
                          },
                        }, "重新生成纪要"),
                      ),
                    ),
                    h("div", { className: "emu-row" },
                      speakers.map(function (sp) {
                        var conf = sp.source === "voiceprint" && sp.confidence ? " · 声纹 " + Math.round(sp.confidence * 100) + "%" : "";
                        return h("button", {
                          key: sp.id,
                          type: "button",
                          className: "emu-btn emu-btn-sm emu-btn-outline",
                          onClick: function () {
                            setEditingSpeaker(sp);
                            setRenamePersonId(sp.personId || "");
                            setRenameLabel(speakerNameMap[sp.id] || sp.label);
                            setRememberVoice(false);
                          },
                        }, (speakerNameMap[sp.id] || sp.label) + conf);
                      }),
                    ),
                    editingSpeaker
                      ? h("div", { className: "emu-todo-row" },
                          h("div", { className: "emu-row" },
                            h("strong", null, "命名 " + editingSpeaker.id),
                            directory.length > 0
                              ? h("select", {
                                  className: "emu-input",
                                  style: { width: "180px" },
                                  value: renamePersonId,
                                  onChange: function (e) {
                                    setRenamePersonId(e.target.value);
                                    var found = directory.find(function (p) { return p.id === e.target.value; });
                                    if (found) setRenameLabel(found.name);
                                  },
                                },
                                  h("option", { value: "" }, "不关联通讯录 / 自定义名称"),
                                  directory.map(function (p) {
                                    return h("option", { key: p.id, value: p.id }, p.name + (p.department ? " · " + p.department : ""));
                                  }),
                                )
                              : null,
                            h("input", {
                              className: "emu-input",
                              style: { width: "160px" },
                              placeholder: "说话人姓名",
                              value: renameLabel,
                              onChange: function (e) { setRenameLabel(e.target.value); },
                            }),
                          ),
                          h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                            renamePersonId
                              ? h("label", { className: "emu-row", style: { fontSize: "12px", cursor: "pointer" } },
                                  h("input", { type: "checkbox", checked: rememberVoice, onChange: function (e) { setRememberVoice(e.target.checked); } }),
                                  "记住声音（需对方在飞书卡片点击同意）",
                                )
                              : h("span", { className: "emu-sub" }, "选择通讯录同事后可勾选记住声音"),
                            h("div", { className: "emu-row" },
                              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { setEditingSpeaker(null); } }, "取消"),
                              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", onClick: saveSpeakerRename }, "保存"),
                            ),
                          ),
                        )
                      : null,
                  )
                : null,
              // Tabs: Minutes vs Transcript
              h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                h("div", { className: "emu-tabs" },
                  h("button", { type: "button", className: "emu-tab" + (tab === "minutes" ? " emu-tab-on" : ""), onClick: function () { setTab("minutes"); } }, "结构化纪要"),
                  h("button", { type: "button", className: "emu-tab" + (tab === "transcript" ? " emu-tab-on" : ""), onClick: function () { setTab("transcript"); } }, "本地逐字稿 (" + (meeting.segmentsCount || 0) + ")"),
                ),
                tab === "transcript"
                  ? h("div", { className: "emu-row" },
                      h("input", {
                        className: "emu-input",
                        style: { width: "200px" },
                        placeholder: "搜索原话关键词…",
                        value: searchKw,
                        onChange: function (e) { setSearchKw(e.target.value); },
                        onKeyDown: function (e) { if (e.key === "Enter") handleSearchTranscript(); },
                      }),
                      h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: handleSearchTranscript }, "搜索"),
                    )
                  : null,
              ),
              tab === "minutes"
                ? (meeting.minutes
                    ? h("div", { className: "emu-stack" },
                        h("div", { className: "emu-card" },
                          h("strong", null, "概要"),
                          h("p", { style: { margin: 0 } }, meeting.minutes.overview),
                        ),
                        (meeting.minutes.conclusions || []).length > 0
                          ? h("div", { className: "emu-card" },
                              h("strong", null, "结论与决定"),
                              h("ul", { style: { margin: 0, paddingLeft: "18px" } },
                                (meeting.minutes.conclusions || []).concat(meeting.minutes.decisions || []).map(function (pt, idx) {
                                  return h("li", { key: String(idx), style: { marginBottom: "6px" } },
                                    pt.text,
                                    (pt.evidence || []).map(function (ev) {
                                      return h("button", { key: ev, type: "button", className: "emu-cite", onClick: function () { jumpEvidence(ev); } }, ev);
                                    }),
                                  );
                                }),
                              ),
                            )
                          : null,
                      )
                    : h("p", { className: "emu-sub" }, "该会议尚未生成纪要。"))
                : h("div", { className: "emu-card", style: { maxHeight: "360px", overflow: "auto" } },
                    ((transcript && transcript.segments) || []).map(function (seg) {
                      var isAct = seg.id === activeSegId;
                      return h("div", {
                        key: seg.id,
                        className: "emu-seg" + (isAct ? " emu-seg-active" : ""),
                        onClick: function () { seekToMs(seg.start, seg.id); },
                      },
                        h("span", { className: "emu-mono emu-sub", style: { flex: "none", width: "48px" } }, formatClockMs(seg.start)),
                        h("span", { style: { flex: "none", fontWeight: 500, minWidth: "56px" } }, speakerNameMap[seg.speakerId] || seg.speakerId),
                        h("span", { className: "emu-grow" }, seg.text),
                      );
                    }),
                  ),
            );

      return h(Modal, {
        title: (meeting && meeting.title) || "会议详情与回放",
        large: true,
        body: body,
        dismissOnBackdrop: true,
        onClose: props.onClose,
      });
    }

    // ---- Account & Environment Settings Panel ----
    function AccountPanel(props) {
      var store = props.store;
      var services = props.services;
      var conn = serviceOf(services, "connection");
      var snap = useStoreSnapshot(store, 10000);
      var state = snap.state;
      var accounts = (state && state.accounts) || [];
      var activeId = state && state.activeAccountId;

      var [authOpen, setAuthOpen] = useState(false);
      var [runtime, setRuntime] = useState(null);
      var [voiceprints, setVoiceprints] = useState(null);
      var [vpColleagues, setVpColleagues] = useState([]);
      var [inviteOpenId, setInviteOpenId] = useState("");
      var [confirmDeleteVp, setConfirmDeleteVp] = useState(null);
      var [companies, setCompanies] = useState(null);
      var [showAdvanced, setShowAdvanced] = useState(false);
      var [showVoiceprints, setShowVoiceprints] = useState(false);
      var [showCompanies, setShowCompanies] = useState(false);
      var [serverUrl, setServerUrl] = useState("");
      var [binaryMirrorUrl, setBinaryMirrorUrl] = useState("");
      var [modelMirrorUrl, setModelMirrorUrl] = useState("");
      var [recordingsDir, setRecordingsDir] = useState("");
      var [busy, setBusy] = useState("");
      var [note, setNote] = useState(null);
      var [newAppId, setNewAppId] = useState("");
      var [newAppSecret, setNewAppSecret] = useState("");

      useEffect(function () {
        if (!state) return;
        setServerUrl(state.serverUrl || "");
        setBinaryMirrorUrl(state.binaryMirrorUrl || "");
        setModelMirrorUrl(state.modelMirrorUrl || "");
        setRecordingsDir(state.recordingsDir || "");
      }, [state && state.serverUrl, state && state.binaryMirrorUrl, state && state.modelMirrorUrl, state && state.recordingsDir]);

      function refreshRuntime() {
        callRpc(conn, "getRuntimeStatus", {}).then(function (r) { setRuntime(r); }).catch(noop);
      }

      useEffect(function () { refreshRuntime(); }, []);

      function handleSwitch(accountId) {
        setBusy("switch:" + accountId);
        callRpc(conn, "setActiveAccount", { accountId: accountId })
          .then(function (next) { store.applyState(next); setNote({ tone: "ok", text: "已切换当前飞书账户。" }); })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); })
          .finally(function () { setBusy(""); });
      }

      function handleDisconnect(accountId) {
        setBusy("disc:" + accountId);
        callRpc(conn, "disconnectAccount", { accountId: accountId })
          .then(function (next) { store.applyState(next); setNote({ tone: "ok", text: "已断开账户并吊销会话。" }); })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); })
          .finally(function () { setBusy(""); });
      }

      function handleTestConnection() {
        setBusy("test");
        setNote(null);
        callRpc(conn, "testConnection", { serverUrl: serverUrl.trim(), joinCode: (state && state.lastJoinCode) || "" })
          .then(function (res) { setNote({ tone: "ok", text: (res && res.message) || "服务器连接正常。" }); })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err, "连接服务器失败。") }); })
          .finally(function () { setBusy(""); });
      }

      function handleSaveSettings(disconnectAccounts) {
        setBusy("save");
        setNote(null);
        callRpc(conn, "saveSettings", {
          patch: {
            serverUrl: serverUrl.trim(),
            binaryMirrorUrl: binaryMirrorUrl.trim(),
            modelMirrorUrl: modelMirrorUrl.trim(),
            recordingsDir: recordingsDir.trim(),
            ...(disconnectAccounts ? { disconnectAccounts: true } : {}),
          },
        })
          .then(function (next) {
            store.applyState(next);
            setNote({ tone: "ok", text: "配置已保存。" });
            refreshRuntime();
          })
          .catch(function (err) {
            setNote({ tone: "err", text: errorText(err, "保存设置失败。") });
          })
          .finally(function () { setBusy(""); });
      }

      function handleInstallBinaries() {
        setBusy("install-bin");
        setNote(null);
        callRpc(conn, "installBinaries", {})
          .then(function () { setNote({ tone: "ok", text: "原生录音与转写组件已就绪。" }); refreshRuntime(); })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); })
          .finally(function () { setBusy(""); });
      }

      function handleDownloadModels() {
        setBusy("dl-models");
        setNote({ tone: "warn", text: "正在下载离线语音模型（约 200 MB），请保持网络畅通…" });
        if (props.liveStore) props.liveStore.poke();
        callRpc(conn, "downloadModels", {})
          .then(function () {
            setNote({ tone: "ok", text: "离线语音模型下载并校验完成，等待中的会议已自动开始转写。" });
            refreshRuntime();
            if (props.liveStore) props.liveStore.poke();
          })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); })
          .finally(function () {
            setBusy("");
            if (props.liveStore) props.liveStore.poke();
          });
      }

      function loadVoiceprints() {
        callRpc(conn, "listVoiceprints", {})
          .then(function (res) {
            setVoiceprints(Array.isArray(res && res.voiceprints) ? res.voiceprints : []);
            setVpColleagues(Array.isArray(res && res.colleagues) ? res.colleagues : []);
          })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); });
      }

      function handleAskVoiceprint(openId, displayName) {
        setBusy("vp-ask:" + openId);
        setNote(null);
        callRpc(conn, "askVoiceprintConsent", { openId: openId, meetingTitle: "" })
          .then(function () {
            setNote({ tone: "ok", text: "已向「" + (displayName || shortOpenId(openId)) + "」发送飞书声纹同意卡片。" });
            setInviteOpenId("");
            loadVoiceprints();
          })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err, "发送声纹同意卡片失败。") }); })
          .finally(function () { setBusy(""); });
      }

      function handleConfirmDeleteVoiceprint() {
        if (!confirmDeleteVp) return;
        var target = confirmDeleteVp;
        setBusy("vp-del:" + target.openId);
        setNote(null);
        callRpc(conn, "deleteVoiceprint", { openId: target.openId })
          .then(function () {
            setConfirmDeleteVp(null);
            setNote({ tone: "ok", text: "已删除「" + (target.name || shortOpenId(target.openId)) + "」的声纹记录。" });
            loadVoiceprints();
          })
          .catch(function (err) {
            setConfirmDeleteVp(null);
            setNote({ tone: "err", text: errorText(err, "删除声纹失败。") });
          })
          .finally(function () { setBusy(""); });
      }

      function loadCompanies() {
        callRpc(conn, "listCompanies", {})
          .then(function (res) { setCompanies(Array.isArray(res && res.companies) ? res.companies : []); })
          .catch(function (err) { setNote({ tone: "err", text: errorText(err) }); });
      }

      var activeAccount = state && state.activeAccount;
      var storageNote = CREDENTIAL_NOTES[(state && state.credentialStorageKind) || "dsh-credentials"];

      return h("div", { className: "emu emu-stack" },
        h("style", null, UI_CSS),
        note ? h("p", { className: "emu-note emu-note-" + note.tone, role: note.tone === "err" ? "alert" : "status" }, note.text) : null,

        // 1. Accounts section
        h("div", { className: "emu-section" },
          h("div", { className: "emu-section-head" },
            h("h3", { className: "emu-section-title" }, "飞书账户"),
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", onClick: function () { setAuthOpen(true); } }, "+ 连接飞书账户"),
          ),
          accounts.length === 0
            ? h("div", { className: "emu-card" },
                h("p", { className: "emu-sub", style: { margin: 0 } }, "尚未连接 EchoMind 飞书账户。连接后可使用 DeepSeek 纪要、日历参会人匹配、声纹识别与飞书任务推送。"),
              )
            : h("ul", { className: "emu-list" },
                accounts.map(function (acc) {
                  var isAct = acc.id === activeId;
                  var tone = acc.status === "ok" ? "ok" : "err";
                  var label = acc.status === "ok" ? "已连接" : (acc.status === "expired" ? "已过期" : "已失效");
                  return h("li", { key: acc.id, className: "emu-row-item" },
                    h("span", { className: "emu-avatar" }, (acc.name || "E").slice(0, 1)),
                    h("div", { className: "emu-grow" },
                      h("div", { className: "emu-title-line" },
                        h("span", null, acc.name || acc.openId),
                        isAct ? h("span", { className: "emu-tag emu-tag-clay" }, "当前使用") : null,
                        h("span", { className: "emu-tag emu-tag-" + tone }, label),
                        acc.admin ? h("span", { className: "emu-tag emu-tag-neutral" }, "管理员") : null,
                      ),
                      h("div", { className: "emu-sub" },
                        (acc.companyName ? acc.companyName + " · " : "") +
                        (acc.missingScopes && acc.missingScopes.length > 0 ? "缺少权限，请重新授权" : "已授权飞书日历与任务")),
                    ),
                    h("div", { className: "emu-row-actions" },
                      !isAct ? h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: !!busy, onClick: function () { handleSwitch(acc.id); } }, "设为当前") : null,
                      h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline emu-btn-danger", disabled: !!busy, onClick: function () { handleDisconnect(acc.id); } }, "断开"),
                    ),
                  );
                }),
              ),
          h("p", { className: "emu-sub", style: { margin: 0 } }, storageNote),
        ),

        // 2. Runtime binaries, models & OS permissions
        h("div", { className: "emu-section" },
          h("div", { className: "emu-section-head" },
            h("h3", { className: "emu-section-title" }, "本机录音与离线转写环境"),
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: refreshRuntime }, "刷新检查"),
          ),
          h("div", { className: "emu-card" },
            h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
              h("span", null, "原生组件（双轨采集 + 离线转写）"),
              runtime && runtime.binaries && runtime.binaries.ready
                ? h("span", { className: "emu-tag emu-tag-ok" }, "已就绪")
                : h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", disabled: busy === "install-bin", onClick: handleInstallBinaries },
                    busy === "install-bin" ? "正在安装…" : "安装缺失组件"),
            ),
            h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
              h("span", null, "离线语音模型（SenseVoice + VAD + CAM++，约 200 MB）"),
              runtime && runtime.models && runtime.models.ready
                ? h("span", { className: "emu-tag emu-tag-ok" }, "已就绪")
                : h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: busy === "dl-models" || !(runtime && runtime.binaries && runtime.binaries.transcribe.ready), onClick: handleDownloadModels },
                    busy === "dl-models" ? "下载中…" : "下载语音模型"),
            ),
            runtime && runtime.permissions
              ? h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                  h("span", null,
                    "系统权限：麦克风 " + (PERMISSION_LABELS[runtime.permissions.microphone] || runtime.permissions.microphone) +
                    " · 系统录音 " + (PERMISSION_LABELS[runtime.permissions.systemAudio] || runtime.permissions.systemAudio)),
                  h("div", { className: "emu-row-actions" },
                    h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { callRpc(conn, "openPrivacySettings", { kind: "mic" }).catch(noop); } }, "麦克风设置"),
                    h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { callRpc(conn, "openPrivacySettings", { kind: "systemAudio" }).catch(noop); } }, "系统录音设置"),
                  ),
                )
              : null,
            runtime
              ? h("div", { className: "emu-sub emu-mono" }, "工作区录音目录：" + runtime.recordingsDir + "（共 " + runtime.meetingsCount + " 场会议）")
              : null,
          ),
        ),

        // 3. Voiceprints collapsible section
        h("div", { className: "emu-section" },
          h("button", {
            type: "button",
            className: "emu-disclosure",
            "aria-expanded": showVoiceprints ? "true" : "false",
            onClick: function () {
              var next = !showVoiceprints;
              setShowVoiceprints(next);
              if (next && voiceprints === null) loadVoiceprints();
            },
          },
            h("span", { className: "emu-row", style: { gap: "8px" } },
              h("span", null, "人员与声纹"),
              voiceprints && voiceprints.length > 0
                ? h("span", { className: "emu-tag emu-tag-neutral" }, voiceprints.length + " 人")
                : null,
            ),
            h("span", { className: "emu-sub", style: { flex: "none" } }, showVoiceprints ? "收起" : "展开"),
          ),
          showVoiceprints
            ? h("div", { className: "emu-stack" },
                h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
                  h("span", { className: "emu-sub", style: { flex: 1 } }, "仅保存加密声音特征、不保存录音；需本人在飞书卡片同意才会录入，可随时删除。"),
                  h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: loadVoiceprints }, "刷新"),
                ),
                !voiceprints
                  ? h("div", { className: "emu-card" }, h("span", { className: "emu-sub" }, "正在加载公司声纹列表…"))
                  : voiceprints.length === 0
                    ? h("div", { className: "emu-card" }, h("span", { className: "emu-sub" }, "公司暂无已保存声纹。在会议详情中命名说话人并勾选「记住声音」，或在下方邀请同事即可发送飞书同意卡片。"))
                    : h("ul", { className: "emu-list" },
                        voiceprints.map(function (vp) {
                          var meta = voiceprintMeta(vp);
                          var personName = vp.name || shortOpenId(vp.openId);
                          var initial = (vp.name || "?").slice(0, 1);
                          return h("li", { key: vp.openId, className: "emu-row-item" },
                            h("span", { className: "emu-avatar", title: vp.openId }, initial),
                            h("div", { className: "emu-grow" },
                              h("div", { className: "emu-title-line" },
                                h("span", { title: vp.name ? vp.openId : undefined }, personName),
                                vp.isSelf ? h("span", { className: "emu-tag emu-tag-neutral" }, "我") : null,
                                h("span", { className: "emu-tag emu-tag-" + meta.tone }, meta.label),
                              ),
                              h("div", { className: "emu-sub" }, meta.detail || shortOpenId(vp.openId)),
                            ),
                            h("div", { className: "emu-row-actions" },
                              meta.canAsk
                                ? h("button", {
                                    type: "button",
                                    className: "emu-btn emu-btn-sm emu-btn-outline",
                                    disabled: !!busy,
                                    onClick: function () { handleAskVoiceprint(vp.openId, personName); },
                                  }, meta.askLabel)
                                : null,
                              h("button", {
                                type: "button",
                                className: "emu-btn emu-btn-sm emu-btn-outline emu-btn-danger",
                                disabled: !!busy,
                                onClick: function () { setConfirmDeleteVp({ openId: vp.openId, name: personName, label: meta.deleteLabel }); },
                              }, meta.deleteLabel),
                            ),
                          );
                        }),
                      ),
                (function () {
                  if (!voiceprints) return null;
                  var existingIds = {};
                  voiceprints.forEach(function (v) { existingIds[v.openId] = true; });
                  var invitable = vpColleagues.filter(function (c) { return !c.isSelf && !existingIds[c.id]; });
                  if (invitable.length === 0) return null;
                  var chosen = invitable.find(function (c) { return c.id === inviteOpenId; });
                  return h("div", { className: "emu-row" },
                    h("select", {
                      className: "emu-input",
                      style: { flex: 1, minWidth: "160px" },
                      value: inviteOpenId,
                      onChange: function (e) { setInviteOpenId(e.target.value); },
                    },
                      h("option", { value: "" }, "选择同事发送飞书声纹同意卡片…"),
                      invitable.map(function (c) {
                        return h("option", { key: c.id, value: c.id }, c.name + (c.department ? " · " + c.department : ""));
                      }),
                    ),
                    h("button", {
                      type: "button",
                      className: "emu-btn emu-btn-sm emu-btn-outline",
                      disabled: !inviteOpenId || !!busy,
                      onClick: function () { handleAskVoiceprint(inviteOpenId, chosen && chosen.name); },
                    }, "邀请建立声纹"),
                  );
                })(),
              )
            : null,
        ),

        // 4. Admin-only company management
        activeAccount && activeAccount.admin
          ? h("div", { className: "emu-section" },
              h("button", {
                type: "button",
                className: "emu-disclosure",
                "aria-expanded": showCompanies ? "true" : "false",
                onClick: function () {
                  var next = !showCompanies;
                  setShowCompanies(next);
                  if (next && companies === null) loadCompanies();
                },
              }, h("span", null, "公司管理（管理员）"), h("span", { className: "emu-sub", style: { flex: "none" } }, showCompanies ? "收起" : "展开")),
              showCompanies
                ? h("div", { className: "emu-stack" },
                    (companies || []).length > 0
                      ? h("ul", { className: "emu-list" },
                          (companies || []).map(function (c) {
                            return h("li", { key: c.id, className: "emu-row-item" },
                              h("div", { className: "emu-grow" },
                                h("div", { className: "emu-title-line" },
                                  h("span", null, c.name),
                                  c.disabled ? h("span", { className: "emu-tag emu-tag-neutral" }, "已停用") : h("span", { className: "emu-tag emu-tag-ok" }, "启用中"),
                                ),
                                h("div", { className: "emu-sub emu-mono" }, "加入码：" + c.joinCode),
                              ),
                              h("div", { className: "emu-row-actions" },
                                h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { callRpc(conn, "checkCompany", { companyId: c.id }).then(loadCompanies).catch(noop); } }, "核对"),
                                h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { callRpc(conn, "toggleCompany", { companyId: c.id, enabled: !!c.disabled }).then(loadCompanies).catch(noop); } }, c.disabled ? "启用" : "停用"),
                              ),
                            );
                          }),
                        )
                      : null,
                    h("div", { className: "emu-card" },
                      h("div", { className: "emu-row" },
                        h("input", { className: "emu-input", style: { flex: 1, minWidth: "140px" }, placeholder: "新公司飞书 App ID (cli_...)", value: newAppId, onChange: function (e) { setNewAppId(e.target.value); } }),
                        h("input", { className: "emu-input", style: { flex: 1, minWidth: "140px" }, type: "password", placeholder: "App Secret", value: newAppSecret, onChange: function (e) { setNewAppSecret(e.target.value); } }),
                        h("button", {
                          type: "button",
                          className: "emu-btn emu-btn-sm emu-btn-primary",
                          onClick: function () {
                            callRpc(conn, "addCompany", { appId: newAppId.trim(), appSecret: newAppSecret.trim() })
                              .then(function () { setNewAppId(""); setNewAppSecret(""); loadCompanies(); })
                              .catch(function (e) { setNote({ tone: "err", text: errorText(e) }); });
                          },
                        }, "添加公司"),
                      ),
                    ),
                  )
                : null,
            )
          : null,

        // 5. Advanced server & mirror settings
        h("div", { className: "emu-section" },
          h("button", {
            type: "button",
            className: "emu-disclosure",
            "aria-expanded": showAdvanced ? "true" : "false",
            onClick: function () { setShowAdvanced(!showAdvanced); },
          }, h("span", null, "服务器与镜像高级配置"), h("span", { className: "emu-sub" }, showAdvanced ? "收起" : "展开")),
          showAdvanced
            ? h("div", { className: "emu-card" },
                h("div", { className: "emu-field" },
                  h("label", { className: "emu-label", htmlFor: "emu-server-url" }, "EchoMind 服务端地址"),
                  h("input", { id: "emu-server-url", className: "emu-input", value: serverUrl, onChange: function (e) { setServerUrl(e.target.value); } }),
                ),
                h("div", { className: "emu-field" },
                  h("label", { className: "emu-label", htmlFor: "emu-bin-mirror" }, "原生二进制镜像地址（可选）"),
                  h("input", { id: "emu-bin-mirror", className: "emu-input", placeholder: "https://.../echomind-binaries", value: binaryMirrorUrl, onChange: function (e) { setBinaryMirrorUrl(e.target.value); } }),
                ),
                h("div", { className: "emu-field" },
                  h("label", { className: "emu-label", htmlFor: "emu-model-mirror" }, "语音模型镜像地址（可选，替换 GitHub Releases）"),
                  h("input", { id: "emu-model-mirror", className: "emu-input", placeholder: "https://.../sherpa-onnx", value: modelMirrorUrl, onChange: function (e) { setModelMirrorUrl(e.target.value); } }),
                ),
                h("div", { className: "emu-field" },
                  h("label", { className: "emu-label", htmlFor: "emu-rec-dir" }, "自定义录音目录（留空则使用 DSH 工作区默认路径）"),
                  h("input", { id: "emu-rec-dir", className: "emu-input", placeholder: "留空自动使用 DSH 工作区", value: recordingsDir, onChange: function (e) { setRecordingsDir(e.target.value); } }),
                ),
                h("div", { className: "emu-row emu-row-end" },
                  h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: !!busy, onClick: handleTestConnection }, busy === "test" ? "测试中…" : "测试连接"),
                  h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", disabled: !!busy, onClick: function () { handleSaveSettings(false); } }, busy === "save" ? "保存中…" : "保存配置"),
                ),
              )
            : null,
        ),

        authOpen
          ? h(AuthorizeDialog, {
              store: store,
              services: services,
              initialJoinCode: (state && state.lastJoinCode) || "",
              onClose: function () { setAuthOpen(false); },
            })
          : null,
        confirmDeleteVp
          ? h(Modal, {
              title: "确认" + (confirmDeleteVp.label || "删除声纹") + "？",
              body: h("p", { style: { margin: 0 } },
                "将删除「" + confirmDeleteVp.name + "」的声纹与同意记录，后续会议将不再自动识别其声音，如需恢复需重新同意。"),
              footer: h("div", { className: "emu-row emu-row-end" },
                h("button", { type: "button", className: "emu-btn emu-btn-outline", disabled: !!busy, onClick: function () { setConfirmDeleteVp(null); } }, "取消"),
                h("button", { type: "button", className: "emu-btn emu-btn-primary", style: { background: "var(--emu-err)" }, disabled: !!busy, onClick: handleConfirmDeleteVoiceprint },
                  busy ? "正在处理…" : "确认" + (confirmDeleteVp.label || "删除")),
              ),
              onClose: function () { setConfirmDeleteVp(null); },
            })
          : null,
      );
    }

    function SettingsSection(props) {
      return h("div", { className: "emu", style: { width: "100%", minWidth: 0 } },
        h(AccountPanel, { store: props.store, liveStore: props.liveStore, services: props.services }),
      );
    }

    // ---- Plugin Detail Page Contributions ----
    function DetailBadge(props) {
      var snap = useStoreSnapshot(props.store, 10000);
      var live = useLiveSnapshot(props.liveStore);
      if (live && live.recording) {
        return h("span", { className: "emu emu-tag emu-tag-clay" },
          h("style", null, UI_CSS),
          h("span", { className: "emu-dot emu-dot-pulse" }),
          "录音中 " + formatClockMs(live.recording.elapsedMs),
        );
      }
      var active = snap.state && snap.state.activeAccount;
      var ok = !!(active && active.status === "ok");
      return h("span", { className: "emu emu-tag " + (ok ? "emu-tag-ok" : "emu-tag-neutral") },
        h("style", null, UI_CSS),
        ok ? "已连接 · " + active.name : "未连接飞书",
      );
    }

    function DetailActions(props) {
      var [manageOpen, setManageOpen] = useState(false);
      return h("div", { className: "emu emu-actions" },
        h("style", null, UI_CSS),
        h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { setManageOpen(true); } }, "管理"),
        h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", onClick: function () { startSessionWithPrompt(props.services, TRY_PROMPT); } }, "试用"),
        manageOpen
          ? h(Modal, {
              title: "EchoMind 会议配置",
              body: h(AccountPanel, { store: props.store, services: props.services }),
              dismissOnBackdrop: true,
              onClose: function () { setManageOpen(false); },
            })
          : null,
      );
    }

    function ExamplesSection(props) {
      return h("div", { className: "emu emx-wrap", style: { background: EXAMPLES_LOOK.fallback[0] } },
        h("style", null, UI_CSS),
        h("div", { className: "emx-head" },
          h("img", { src: EXAMPLES_LOOK.icon, width: 28, height: 28, alt: "EchoMind", style: { borderRadius: "8px" } }),
          h("strong", { style: { fontSize: "14.5px" } }, "试试这样问 EchoMind"),
        ),
        h("div", { className: "emx-grid" },
          EXAMPLE_PROMPTS.map(function (prompt, idx) {
            return h("button", {
              key: String(idx),
              type: "button",
              className: "emx-card",
              onClick: function () { startSessionWithPrompt(props.services, prompt); },
            },
              h("span", null, prompt),
              h("span", { className: "emu-sub", style: { color: EXAMPLES_LOOK.brand[0], fontWeight: 500 } }, "立即试试 →"),
            );
          }),
        ),
      );
    }

    // ---- Global Floating Recorder Bar (shell.overlay, renders null when completely idle) ----
    function FloatingRecorderBar(props) {
      var conn = serviceOf(props.services, "connection");
      var live = useLiveSnapshot(props.liveStore);
      var [busy, setBusy] = useState(false);
      var [dlStarting, setDlStarting] = useState(false);
      var [dlError, setDlError] = useState("");
      var [detailMeetingId, setDetailMeetingId] = useState("");

      var rec = live && live.recording;
      var dl = live && live.modelDownload;
      var activeJob = live && live.jobs && live.jobs.length > 0 ? live.jobs[0] : null;
      if (!rec && !dl && !activeJob && !detailMeetingId) return null;

      function sendCmd(cmd) {
        if (busy) return;
        setBusy(true);
        callRpc(conn, "controlRecording", { command: cmd })
          .then(function () { if (props.liveStore) props.liveStore.poke(); })
          .catch(noop)
          .finally(function () { setBusy(false); });
      }

      function handleDownloadNow() {
        if (dlStarting) return;
        setDlStarting(true);
        setDlError("");
        if (props.liveStore) props.liveStore.poke();
        callRpc(conn, "downloadModels", {})
          .then(function () {
            if (props.liveStore) props.liveStore.poke();
          })
          .catch(function (err) {
            setDlError(errorText(err, "下载语音模型失败，请检查网络或在「EchoMind 会议配置 → 高级配置」设置镜像地址。"));
          })
          .finally(function () {
            setDlStarting(false);
            if (props.liveStore) props.liveStore.poke();
          });
      }

      function handleDismiss(meetingId) {
        setDlError("");
        callRpc(conn, "dismissJob", { meetingId: meetingId })
          .then(function () { if (props.liveStore) props.liveStore.poke(); })
          .catch(noop);
      }

      function handleRetry(meetingId) {
        setDlError("");
        callRpc(conn, "retryMeeting", { meetingId: meetingId })
          .then(function () { if (props.liveStore) props.liveStore.poke(); })
          .catch(function (err) { setDlError(errorText(err, "重试失败。")); });
      }

      var cardNode = null;
      if (rec) {
        cardNode = h("div", { className: "emu-floating-rec", role: "region", "aria-label": "EchoMind 正在录音" },
          h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
            h("div", { className: "emu-row", style: { gap: "6px" } },
              h("span", { className: "emu-dot " + (rec.paused ? "" : "emu-dot-pulse") }),
              h("strong", { style: { fontSize: "13px" } }, rec.paused ? "录音已暂停" : "正在记录"),
              h("span", { className: "emu-sub" }, "· " + (SOURCE_LABELS[rec.source] || "会议")),
            ),
            h("span", { className: "emu-mono", style: { fontSize: "16px", fontWeight: 600 } }, formatClockMs(rec.elapsedMs)),
          ),
          h("div", { className: "emu-meters" },
            h(LevelMeter, { label: "我", db: rec.micDb }),
            h(LevelMeter, { label: "远端", db: rec.systemDb }),
          ),
          h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
            h("div", { className: "emu-row", style: { gap: "6px" } },
              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: busy, onClick: function () { sendCmd("mark"); } }, "标记" + (rec.marks && rec.marks.length ? " (" + rec.marks.length + ")" : "")),
              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: busy, onClick: function () { sendCmd(rec.paused ? "resume" : "pause"); } }, rec.paused ? "继续" : "暂停"),
            ),
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-clay", disabled: busy || rec.stopping, onClick: function () { sendCmd("stop"); } }, rec.stopping ? "收尾中…" : "结束记录"),
          ),
        );
      } else if (dl || dlStarting) {
        var total = (dl && dl.total) || 198886319;
        var received = (dl && dl.received) || 0;
        var pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        cardNode = h("div", { className: "emu-floating-rec", role: "status" },
          h("div", { className: "emu-row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, "正在下载离线语音模型"),
            h("span", { className: "emu-mono emu-sub" }, pct + "%"),
          ),
          h("div", { className: "emu-progress-track" },
            h("div", { className: "emu-progress-fill", style: { width: pct + "%" } }),
          ),
          h("div", { className: "emu-sub", style: { marginTop: "6px" } },
            formatBytes(received) + " / " + formatBytes(total) + " · 下载完成后将自动开始转写"),
        );
      } else if (activeJob && activeJob.step === "models") {
        cardNode = h("div", { className: "emu-floating-rec", role: "status" },
          h("div", { className: "emu-row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, "需要下载本机语音模型（约 200 MB）"),
            h("button", { type: "button", className: "emu-icon-btn", "aria-label": "关闭", onClick: function () { handleDismiss(activeJob.meetingId); } }, "✕"),
          ),
          h("p", { className: "emu-sub", style: { margin: "0 0 8px" } }, "录音已保存在本地。离线模型只需下载一次，完成后会自动继续转写并生成纪要。"),
          dlError ? h("p", { className: "emu-note emu-note-err", style: { marginBottom: "8px" }, role: "alert" }, dlError) : null,
          h("div", { className: "emu-row emu-row-end" },
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { handleDismiss(activeJob.meetingId); } }, "稍后"),
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-clay", disabled: dlStarting, onClick: handleDownloadNow }, dlStarting ? "准备下载…" : "立即下载并转写"),
          ),
        );
      } else if (activeJob && activeJob.error) {
        cardNode = h("div", { className: "emu-floating-rec", role: "alert" },
          h("div", { className: "emu-row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, "会议处理未完成"),
            h("button", { type: "button", className: "emu-icon-btn", "aria-label": "关闭", onClick: function () { handleDismiss(activeJob.meetingId); } }, "✕"),
          ),
          h("p", { className: "emu-note emu-note-err", style: { marginBottom: "8px" } }, activeJob.error),
          h("div", { className: "emu-row emu-row-end" },
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { setDetailMeetingId(activeJob.meetingId); } }, "查看详情"),
            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", onClick: function () { handleRetry(activeJob.meetingId); } }, "重试"),
          ),
        );
      } else if (activeJob) {
        cardNode = h("div", { className: "emu-floating-rec", role: "status" },
          h("div", { className: "emu-row", style: { justifyContent: "space-between", marginBottom: "6px" } },
            h("strong", { style: { fontSize: "13px" } }, activeJob.label || "正在处理会议"),
            h("span", { className: "emu-mono emu-sub" }, Math.round((activeJob.overallProgress || 0) * 100) + "%"),
          ),
          h("div", { className: "emu-progress-track" },
            h("div", { className: "emu-progress-fill", style: { width: Math.round((activeJob.overallProgress || 0) * 100) + "%" } }),
          ),
        );
      }

      return h("div", { className: "emu" },
        h("style", null, UI_CSS),
        cardNode,
        detailMeetingId
          ? h(MeetingDetailModal, {
              meetingId: detailMeetingId,
              services: props.services,
              onClose: function () { setDetailMeetingId(""); },
            })
          : null,
      );
    }

    // ---- Sidebar Footer Quick Launcher (sidebar.footer.action) ----
    function SidebarRecorderTrigger(props) {
      var conn = serviceOf(props.services, "connection");
      var live = useLiveSnapshot(props.liveStore);
      var [open, setOpen] = useState(false);
      var [meetings, setMeetings] = useState([]);
      var [detected, setDetected] = useState([]);
      var [title, setTitle] = useState("");
      var [source, setSource] = useState("other");
      var [error, setError] = useState("");
      var [starting, setStarting] = useState(false);
      var [inspectId, setInspectId] = useState("");

      function openLauncher() {
        setOpen(true);
        setError("");
        callRpc(conn, "listMeetings", { query: { limit: 12 } })
          .then(function (r) { setMeetings((r && r.meetings) || []); })
          .catch(noop);
        callRpc(conn, "detectMeetings", {})
          .then(function (arr) {
            var list = Array.isArray(arr) ? arr : [];
            setDetected(list);
            if (list.length > 0 && list[0].app) setSource(list[0].app);
          })
          .catch(noop);
      }

      function handleStart() {
        setStarting(true);
        setError("");
        callRpc(conn, "startRecording", { options: { title: title.trim(), source: source } })
          .then(function () {
            if (props.liveStore) props.liveStore.poke();
            setOpen(false);
          })
          .catch(function (err) { setError(errorText(err, "开始录音失败。")); })
          .finally(function () { setStarting(false); });
      }

      var rec = live && live.recording;
      var jobCount = (live && live.jobs && live.jobs.length) || 0;

      return h("div", { className: "emu" },
        h("style", null, UI_CSS),
        h("button", { type: "button", className: "emu-footer-btn", onClick: openLauncher, title: "EchoMind 会议录音与纪要" },
          rec ? h("span", { className: "emu-dot emu-dot-pulse" }) : h("img", { src: EXAMPLES_LOOK.icon, width: 16, height: 16, alt: "" }),
          h("span", null, rec ? "录音 " + formatClockMs(rec.elapsedMs) : "会议记录"),
          jobCount > 0 ? h("span", { className: "emu-tag emu-tag-clay" }, String(jobCount)) : null,
        ),
        open
          ? h(Modal, {
              title: "EchoMind 会议记录",
              dismissOnBackdrop: true,
              onClose: function () { setOpen(false); },
              body: h("div", { className: "emu-stack" },
                error ? h("p", { className: "emu-note emu-note-err", role: "alert" }, error) : null,
                !rec
                  ? h("div", { className: "emu-card" },
                      detected.length > 0
                        ? h("p", { className: "emu-note emu-note-ok" }, "检测到正在运行：" + detected.map(function (d) { return d.name; }).join("、"))
                        : null,
                      h("div", { className: "emu-row" },
                        h("input", { className: "emu-input", style: { flex: 1 }, placeholder: "会议标题（可选，默认按日历或时间命名）", value: title, onChange: function (e) { setTitle(e.target.value); } }),
                        h("select", { className: "emu-input", style: { width: "120px" }, value: source, onChange: function (e) { setSource(e.target.value); } },
                          h("option", { value: "tencent" }, "腾讯会议"),
                          h("option", { value: "feishu" }, "飞书会议"),
                          h("option", { value: "zoom" }, "Zoom"),
                          h("option", { value: "offline" }, "线下会议"),
                          h("option", { value: "other" }, "其他"),
                        ),
                      ),
                      h("div", { className: "emu-row emu-row-end" },
                        h("button", { type: "button", className: "emu-btn emu-btn-clay", disabled: starting, onClick: handleStart }, starting ? "正在启动…" : "开始双轨记录"),
                      ),
                    )
                  : h("div", { className: "emu-card" },
                      h("p", { style: { margin: 0 } }, "正在录音中（" + formatClockMs(rec.elapsedMs) + "），请在右下角悬浮录音条控制暂停、标记或结束。"),
                    ),
                h("div", { className: "emu-section" },
                  h("h4", { className: "emu-section-title" }, "最近会议"),
                  meetings.length === 0
                    ? h("p", { className: "emu-sub", style: { margin: 0 } }, "暂无本地会议记录。")
                    : h("ul", { className: "emu-list" },
                        meetings.map(function (m) {
                          return h("li", { key: m.id, className: "emu-row-item" },
                            h("div", { className: "emu-grow" },
                              h("div", { className: "emu-title-line" }, m.title || m.id),
                              h("div", { className: "emu-sub" }, (SOURCE_LABELS[m.source] || "会议") + " · " + formatClockMs(m.durationMs) + " · " + m.status),
                            ),
                            h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { setOpen(false); setInspectId(m.id); } }, "查看与回放"),
                          );
                        }),
                      ),
                ),
              ),
            })
          : null,
        inspectId
          ? h(MeetingDetailModal, { meetingId: inspectId, services: props.services, onClose: function () { setInspectId(""); } })
          : null,
      );
    }

    // ---- Conversation TurnTail Cards ----
    function AuthRequiredCard(props) {
      var info = props.info || {};
      var [open, setOpen] = useState(false);
      var title = AUTH_CARD_TITLES[info.reason] || AUTH_CARD_TITLES["no-account"];
      return h("div", { className: "emu emu-card" },
        h("style", null, UI_CSS),
        h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
          h("strong", null, title),
          h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-primary", onClick: function () { setOpen(true); } }, "连接飞书账户"),
        ),
        h("p", { className: "emu-sub", style: { margin: 0 } }, info.message || "请在浏览器完成飞书授权后回复「继续」。"),
        open
          ? h(AuthorizeDialog, {
              store: props.store,
              services: props.services,
              onClose: function () { setOpen(false); },
            })
          : null,
      );
    }

    function RecordingProgressCard(props) {
      var item = props.item || {};
      var live = useLiveSnapshot(props.liveStore);
      var [openDetail, setOpenDetail] = useState(false);
      var job = (live && live.jobs || []).find(function (j) { return j.meetingId === item.meetingId; });

      return h("div", { className: "emu emu-card" },
        h("style", null, UI_CSS),
        h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
          h("strong", null, item.title || item.meetingId || "EchoMind 会议"),
          job
            ? h("span", { className: "emu-tag emu-tag-clay" }, job.label)
            : h("span", { className: "emu-tag emu-tag-neutral" }, item.action === "started" ? "录音进行中" : "已入队处理"),
        ),
        job
          ? h("div", { className: "emu-progress-track" },
              h("div", { className: "emu-progress-fill", style: { width: Math.round((job.overallProgress || 0) * 100) + "%" } }),
            )
          : null,
        h("p", { className: "emu-sub", style: { margin: 0 } }, item.message || ""),
        item.meetingId
          ? h("div", { className: "emu-row emu-row-end" },
              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", onClick: function () { setOpenDetail(true); } }, "打开会议详情与回放"),
            )
          : null,
        openDetail
          ? h(MeetingDetailModal, { meetingId: item.meetingId, services: props.services, onClose: function () { setOpenDetail(false); } })
          : null,
      );
    }

    function MeetingMinutesCard(props) {
      var item = props.item || {};
      var conn = serviceOf(props.services, "connection");
      var [detailOpen, setDetailOpen] = useState(false);
      var [detailTab, setDetailTab] = useState("minutes");
      var [detailSegId, setDetailSegId] = useState("");
      var [kbOn, setKbOn] = useState(!(item.knowledge && item.knowledge.off));
      var [kbNote, setKbNote] = useState("");

      function toggleKnowledge(nextOn) {
        setKbOn(nextOn);
        callRpc(conn, "setKnowledgeSync", { meetingId: item.meetingId, enabled: nextOn })
          .then(function (st) {
            setKbNote(nextOn ? "已提交同步至 DataHub 会议纪要知识库。" : "已请求从知识库撤下。");
          })
          .catch(function (err) { setKbNote(errorText(err)); });
      }

      var minutes = item.minutes;
      return h("div", { className: "emu emu-card" },
        h("style", null, UI_CSS),
        h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
          h("div", { className: "emu-title-line" },
            h("strong", null, item.title || item.meetingId),
            h("span", { className: "emu-tag emu-tag-neutral" }, item.sourceLabel || "会议"),
            h("span", { className: "emu-tag emu-tag-ok" }, item.statusLabel || "已生成"),
          ),
          h("button", {
            type: "button",
            className: "emu-btn emu-btn-sm emu-btn-outline",
            onClick: function () { setDetailTab("minutes"); setDetailSegId(""); setDetailOpen(true); },
          }, "逐字稿与音频回放"),
        ),
        minutes && minutes.overview ? h("p", { style: { margin: 0 } }, minutes.overview) : null,
        minutes && Array.isArray(minutes.decisions) && minutes.decisions.length > 0
          ? h("div", null,
              h("div", { className: "emu-label", style: { marginBottom: "4px" } }, "关键决定"),
              h("ul", { style: { margin: 0, paddingLeft: "18px" } },
                minutes.decisions.slice(0, 5).map(function (pt, i) {
                  return h("li", { key: String(i) },
                    pt.text,
                    (pt.evidence || []).slice(0, 2).map(function (ev) {
                      return h("button", {
                        key: ev,
                        type: "button",
                        className: "emu-cite",
                        onClick: function () { setDetailTab("transcript"); setDetailSegId(ev); setDetailOpen(true); },
                      }, ev);
                    }),
                  );
                }),
              ),
            )
          : null,
        h("div", { className: "emu-row", style: { justifyContent: "space-between", paddingTop: "6px", borderTop: "var(--emu-hair) solid var(--emu-line)" } },
          h("label", { className: "emu-row", style: { fontSize: "12px", cursor: "pointer" } },
            h("input", { type: "checkbox", checked: kbOn, onChange: function (e) { toggleKnowledge(e.target.checked); } }),
            "放进 DataHub「会议纪要」知识库",
          ),
          h("span", { className: "emu-sub" }, kbNote || (kbOn ? "仅同步纪要与确认待办，逐字稿不出本机" : "已关闭同步")),
        ),
        detailOpen
          ? h(MeetingDetailModal, {
              meetingId: item.meetingId,
              initialTab: detailTab,
              initialSegmentId: detailSegId,
              services: props.services,
              onClose: function () { setDetailOpen(false); },
            })
          : null,
      );
    }

    function TodoConfirmCard(props) {
      var item = props.item || {};
      var conn = serviceOf(props.services, "connection");
      var [rows, setRows] = useState(function () {
        return (Array.isArray(item.todos) ? item.todos : []).map(function (t) { return Object.assign({ selected: true }, t); });
      });
      var [directory, setDirectory] = useState([]);
      var [outcome, setOutcome] = useState(props.outcome || null);
      var [busy, setBusy] = useState(false);
      var [error, setError] = useState("");

      useEffect(function () {
        if (props.outcome && (!outcome || outcome.status !== "pushed")) {
          setOutcome(props.outcome);
        }
      }, [props.outcome]);

      useEffect(function () {
        callRpc(conn, "listDirectory", { refresh: false })
          .then(function (res) { setDirectory(Array.isArray(res && res.people) ? res.people : []); })
          .catch(noop);
      }, []);

      var pushedDone = outcome && outcome.status === "pushed";
      var cancelled = outcome && outcome.status === "cancelled";
      var locked = !!(pushedDone || cancelled || busy);

      function patchRow(idx, patch) {
        setRows(function (prev) {
          return prev.map(function (r, i) { return i === idx ? Object.assign({}, r, patch) : r; });
        });
      }

      function handleConfirm() {
        if (locked) return;
        setBusy(true);
        setError("");
        callRpc(conn, "confirmPushTodos", { draftId: item.draftId, editedTodos: rows })
          .then(function (res) {
            setOutcome(res);
            if (res && res.failed) {
              setError("推送到「" + res.failed.title + "」时出错：" + res.failed.message + "（已推送的条目已保存，可点确认从断点继续）");
            }
          })
          .catch(function (err) { setError(errorText(err, "推送飞书任务失败，请重试。")); })
          .finally(function () { setBusy(false); });
      }

      function handleCancel() {
        if (locked) return;
        setBusy(true);
        callRpc(conn, "cancelTodoDraft", { draftId: item.draftId })
          .then(function () { setOutcome({ status: "cancelled" }); })
          .catch(function (err) { setError(errorText(err)); })
          .finally(function () { setBusy(false); });
      }

      return h("div", { className: "emu emu-card" },
        h("style", null, UI_CSS),
        h("div", { className: "emu-row", style: { justifyContent: "space-between" } },
          h("strong", null, "确认并推送飞书待办 · " + (item.meetingTitle || item.meetingId)),
          pushedDone
            ? h("span", { className: "emu-tag emu-tag-ok" }, "已推送 " + ((outcome.pushed && outcome.pushed.length) || outcome.pushedCount || 0) + " 条")
            : cancelled
              ? h("span", { className: "emu-tag emu-tag-neutral" }, "已取消")
              : h("span", { className: "emu-tag emu-tag-warn" }, "等待确认"),
        ),
        error ? h("p", { className: "emu-note emu-note-err", role: "alert" }, error) : null,
        h("div", { className: "emu-stack" },
          rows.map(function (r, idx) {
            return h("div", { key: r.id || String(idx), className: "emu-todo-row" },
              h("div", { className: "emu-todo-grid" },
                h("div", { className: "emu-row" },
                  h("input", { type: "checkbox", checked: r.selected !== false, disabled: locked, onChange: function (e) { patchRow(idx, { selected: e.target.checked }); } }),
                  h("input", { className: "emu-input", style: { flex: 1 }, value: r.title || "", disabled: locked, onChange: function (e) { patchRow(idx, { title: e.target.value }); } }),
                ),
                directory.length > 0
                  ? h("select", {
                      className: "emu-input",
                      value: r.external ? "__external__" : (r.ownerPersonId || ""),
                      disabled: locked,
                      onChange: function (e) {
                        var v = e.target.value;
                        if (v === "__external__") patchRow(idx, { external: true, ownerPersonId: null });
                        else patchRow(idx, { external: false, ownerPersonId: v || null });
                      },
                    },
                      h("option", { value: "" }, "待定（指派给自己）"),
                      h("option", { value: "__external__" }, "外部跟进（归记录人）"),
                      directory.map(function (p) { return h("option", { key: p.id, value: p.id }, p.name); }),
                    )
                  : h("input", { className: "emu-input", value: r.ownerName || r.ownerMention || "待定", disabled: true }),
                h("input", { className: "emu-input", type: "text", placeholder: "YYYY-MM-DD", value: r.due || "", disabled: locked, onChange: function (e) { patchRow(idx, { due: e.target.value || null }); } }),
              ),
              h("input", {
                className: "emu-input",
                type: "text",
                placeholder: "补充说明（可选）",
                value: r.detail || "",
                disabled: locked,
                onChange: function (e) { patchRow(idx, { detail: e.target.value }); },
              }),
            );
          }),
        ),
        item.knowledge
          ? h("div", { className: "emu-sub" },
              item.knowledge.off
                ? "知识库同步：已关闭"
                : (item.knowledge.synced ? "知识库同步：纪要已同步至 DataHub「会议纪要」" : "知识库同步：待同步（推送确认后自动更新）"))
          : null,
        pushedDone || cancelled
          ? null
          : h("div", { className: "emu-row emu-row-end" },
              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-outline", disabled: busy, onClick: handleCancel }, "取消"),
              h("button", { type: "button", className: "emu-btn emu-btn-sm emu-btn-clay", disabled: busy, onClick: handleConfirm }, busy ? "正在推送…" : "确认并推送到飞书"),
            ),
      );
    }

    function TurnTail(props) {
      var turn = props && props.turn;
      var data = turn && turn.data && typeof turn.data.get === "function"
        ? turn.data.get(KEY)
        : (turn && turn.plugins ? turn.plugins[KEY] : null);
      if (!data) return null;
      var cards = [];
      (data.recordingCards || []).forEach(function (item) {
        cards.push(h(RecordingProgressCard, { key: "rec-" + item.callId, item: item, services: props.services, liveStore: props.liveStore }));
      });
      (data.minutesCards || []).forEach(function (item) {
        cards.push(h(MeetingMinutesCard, { key: "min-" + item.meetingId, item: item, services: props.services }));
      });
      (data.todoDrafts || []).forEach(function (item) {
        cards.push(h(TodoConfirmCard, {
          key: "todo-" + item.draftId,
          item: item,
          outcome: (data.pushedByDraft && data.pushedByDraft[item.draftId]) || null,
          services: props.services,
        }));
      });
      if (data.authRequired) {
        cards.push(h(AuthRequiredCard, {
          key: "auth-" + String(data.authRequired.callId || ""),
          info: data.authRequired,
          store: props.store,
          services: props.services,
        }));
      }
      if (cards.length === 0) return null;
      return cards.length === 1 ? cards[0] : h("div", { className: "emu emu-tail" }, cards);
    }

    // ---- Cordis Client Plugin Entrypoint ----
    exports.inject = ["slots", "connection", "uiConversation", "sidebarRight"];
    exports.SettingsSection = SettingsSection;
    exports.AccountPanel = AccountPanel;
    exports.AuthorizeDialog = AuthorizeDialog;
    exports.AuthRequiredCard = AuthRequiredCard;
    exports.RecordingProgressCard = RecordingProgressCard;
    exports.MeetingMinutesCard = MeetingMinutesCard;
    exports.TodoConfirmCard = TodoConfirmCard;
    exports.MeetingDetailModal = MeetingDetailModal;
    exports.FloatingRecorderBar = FloatingRecorderBar;
    exports.SidebarRecorderTrigger = SidebarRecorderTrigger;
    exports.DetailActions = DetailActions;
    exports.DetailBadge = DetailBadge;
    exports.ExamplesSection = ExamplesSection;
    exports.TurnTail = TurnTail;
    exports.createAccountStore = createAccountStore;
    exports.createLiveStore = createLiveStore;
    exports.eventDefinition = eventDefinition;
    exports.ICON_SVG = ICON_SVG;
    exports.TRY_PROMPT = TRY_PROMPT;
    exports.EXAMPLE_PROMPTS = EXAMPLE_PROMPTS;

    exports.apply = function (ctx) {
      // Strictly read optional services via ctx.get to avoid Cordis Proxy ReflectService throws.
      var getSvc = function (svcName, targetCtx) {
        var c = targetCtx || ctx;
        if (!c || typeof c.get !== "function") return undefined;
        return c.get(svcName);
      };

      var slots = getSvc("slots");
      if (!slots) return;

      var uiConversation = getSvc("uiConversation");
      var connection = getSvc("connection");
      var services = createServices(getSvc, connection);
      var store = createAccountStore(services.connection);
      var liveStore = createLiveStore(services.connection);

      // 1. settings.section ("EchoMind 会议配置")
      slots.inject("settings.section", function () {
        var BoundSettings = function (props) {
          return h(SettingsSection, Object.assign({}, props, { store: store, liveStore: liveStore, services: services }));
        };
        return slots.register({
          name: "settings.section",
          id: "echomind-settings",
          order: 32,
          label: "EchoMind 会议配置",
        }, BoundSettings);
      });

      // 2. Plugin detail page contributions (no hooks in outer Entry)
      var registerDetail = function (slotName, id, Component) {
        slots.inject(slotName, function () {
          var Entry = function (props) {
            return ownsSubject(props && props.subject)
              ? h(Component, { store: store, liveStore: liveStore, services: services })
              : null;
          };
          return slots.register({ name: slotName, id: id }, Entry);
        });
      };
      registerDetail("plugins.detail.actions", "echomind-actions", DetailActions);
      registerDetail("plugins.detail.badge", "echomind-status", DetailBadge);

      slots.inject("plugins.bundle.config", function () {
        var Examples = function (props) {
          return props && props.view === "page" ? h(ExamplesSection, { store: store, services: services }) : null;
        };
        return slots.register({ name: "plugins.bundle.config", key: PACKAGE_NAME }, Examples);
      });

      // 3. Global recording overlay (shell.overlay: list slot) & sidebar quick launcher (sidebar.footer.action: list slot)
      slots.inject("shell.overlay", function () {
        var OverlayEntry = function () {
          return h(FloatingRecorderBar, { services: services, liveStore: liveStore });
        };
        return slots.register({ name: "shell.overlay", id: "echomind-recorder-bar" }, OverlayEntry);
      });

      slots.inject("sidebar.footer.action", function () {
        var FooterEntry = function () {
          return h(SidebarRecorderTrigger, { services: services, liveStore: liveStore });
        };
        return slots.register({ name: "sidebar.footer.action", id: "echomind-recorder-trigger" }, FooterEntry);
      });

      // 4. conversation.chat.turnTail ("echomind-cards")
      var registeredTurnTail = false;
      var registerTurnTail = function (convSvc) {
        if (registeredTurnTail || !convSvc || !convSvc.events || typeof convSvc.events.register !== "function") return;
        registeredTurnTail = true;
        convSvc.events.register(eventDefinition);
        slots.inject("conversation.chat.turnTail", function () {
          var ConnectedTurnTail = function (props) {
            return h(TurnTail, Object.assign({}, props, { store: store, liveStore: liveStore, services: services }));
          };
          return slots.register({
            name: "conversation.chat.turnTail",
            id: "echomind-cards",
            order: 27,
          }, ConnectedTurnTail);
        });
      };

      if (uiConversation && uiConversation.events && typeof uiConversation.events.register === "function") {
        registerTurnTail(uiConversation);
      } else if (ctx && typeof ctx.inject === "function") {
        ctx.inject(["uiConversation"], function (subCtx) {
          registerTurnTail(getSvc("uiConversation", subCtx));
        });
      }
    };

    return module.exports;
  },
});
