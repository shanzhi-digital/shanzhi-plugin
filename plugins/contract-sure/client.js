// @local/contract-sure DSH web client bundle (zero JSX/TS, zero third-party deps)
// Registers:
//   1. settings.section (id="contract-sure-settings", label="履约无忧配置", order=30)
//      - the same account panel the plugin page's "管理" opens
//   2. conversation.chat.turnTail (id="contract-sure-cards", order=25)
//      - "需要连接账户" card for any tool result of kind contract-sure-auth-required
//      - Interactive "合同识别核对卡" (editable fields + validation banner + one-click confirm)
//      - "合同与票据原件" document list with built-in sidebarRight reader preview
//   3. Plugin page contributions, rendered only for this bundle's own page:
//      - plugins.detail.actions: "管理" (account panel) and "试用" (new session with a prompt)
//      - plugins.detail.badge: connection status beside the title
//      - plugins.detail.section: "试试这样问" example prompts
// Accounts are connected through browser authorization (contractSure/startAuthorization +
// pollAuthorization); the UI never sees or shows a token.

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
    var PACKAGE_NAME = "@local/contract-sure";
    var DRAFT_RECORD_TYPE = "plugin:contract-sure/draft";
    var DRAFT_CONFIRMED_RECORD_TYPE = "plugin:contract-sure/draft-confirmed";
    var DETAIL_RECORD_TYPE = "plugin:contract-sure/detail";
    var AUTH_REQUIRED_KIND = "contract-sure-auth-required";
    var STAGE_DRAFT_TOOL = "contract_stage_draft";
    var CONFIRM_SAVE_TOOL = "contract_confirm_save";
    var QUERY_TOOL = "contract_query";
    var FILE_ADDRESS_PREFIX = "dsh-resource://file/";

    var TRY_PROMPT = "帮我看看我负责的合同里，本月有哪些待回款的节点";
    var EXAMPLE_PROMPTS = [
      "本月有哪些待回款的节点？",
      "查一下合同号 HT-2026-001 的履约进度",
      "哪些流水还没匹配到合同？",
      "我负责的合同里，哪些付款节点下个月到期？",
    ];
    var AUTH_CARD_TITLES = {
      "no-account": "还没有连接履约系统账户",
      expired: "履约系统授权已过期",
      revoked: "履约系统授权已失效",
    };
    var CREDENTIAL_NOTES = {
      "dsh-credentials": "令牌保存在 DeepSeek Harness 凭据存储中，界面不会显示令牌。",
      file: "令牌保存在本机插件配置文件中（仅本人可读），界面不会显示令牌。",
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

    // Account panel, plugin page contributions, dialogs and the auth card. The values mirror the
    // host primitives (Button sm/md, Tag tones, Modal) through the same --dsw-* theme tokens, so
    // light and dark themes follow DeepSeek Harness without a stylesheet of their own.
    var UI_CSS = [
      ".csu{--csu-text:var(--dsw-alias-label-primary,#1f1f1f);--csu-muted:var(--dsw-alias-label-secondary,#5c5c5c);--csu-subtle:var(--dsw-alias-label-tertiary,#8a8a8a);--csu-line:var(--dsw-alias-border-l2,rgba(0,0,0,.08));--csu-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.16));--csu-surface:var(--dsw-alias-bg-layer-2,#f7f7f7);--csu-raised:var(--dsw-alias-bg-layer-3,#fff);--csu-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--csu-ok:var(--dsw-alias-state-success-primary,#1a7f37);--csu-warn:var(--dsw-alias-state-warn-primary,#b45309);--csu-err:var(--dsw-alias-state-error-primary,#d1242f);--csu-info:var(--dsw-alias-state-business-primary,#2563eb);--csu-r-sm:var(--dsw-radius-sm,6px);--csu-r-md:var(--dsw-radius-md,8px);--csu-r-lg:var(--dsw-radius-lg,12px);--csu-hair:var(--dsh-hairline-width,.5px)}",
      ".csu,.csu *{box-sizing:border-box}",
      ".csu-actions{display:inline-flex;align-items:center;gap:8px}",
      ".csu-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--csu-r-md);background:transparent;color:var(--csu-text);font:inherit;font-size:14px;line-height:22px;font-weight:400;cursor:pointer;white-space:nowrap;text-decoration:none}",
      ".csu-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--csu-r-sm)}",
      ".csu-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".csu-btn:focus-visible,.csu-icon-btn:focus-visible,.csu-menu-item:focus-visible,.csu-example:focus-visible,.csu-disclosure:focus-visible,.csu-text-btn:focus-visible,.csu-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--csu-info));outline-offset:1px}",
      ".csu-btn-primary{background:var(--dsw-alias-button-primary-fill,#1f1f1f);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".csu-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3a3a)}",
      ".csu-btn-outline{box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong)}",
      ".csu-btn-outline:hover:not(:disabled),.csu-btn-ghost:hover:not(:disabled){background:var(--csu-hover)}",
      ".csu-btn-danger{color:var(--csu-err)}",
      ".csu-btn-danger.csu-btn-primary{background:var(--csu-err);color:#fff}",
      ".csu-btn-danger.csu-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--csu-err) 86%,#000)}",
      ".csu-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--csu-r-sm);background:transparent;color:var(--csu-muted);cursor:pointer}",
      ".csu-icon-btn:hover:not(:disabled){background:var(--csu-hover);color:var(--csu-text)}",
      ".csu-icon-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".csu-tag{display:inline-flex;align-items:center;gap:4px;flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}",
      ".csu-tag-ok{background:color-mix(in srgb,var(--csu-ok) 10%,transparent);color:var(--csu-ok)}",
      ".csu-tag-warn{background:color-mix(in srgb,var(--csu-warn) 12%,transparent);color:var(--csu-warn)}",
      ".csu-tag-err{background:color-mix(in srgb,var(--csu-err) 10%,transparent);color:var(--csu-err)}",
      ".csu-tag-neutral{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));color:var(--csu-muted)}",
      ".csu-tag-dot:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}",
      "dialog.csu-modal{width:min(560px,calc(100vw - 32px));max-width:none;max-height:min(760px,calc(100vh - 48px));margin:auto;padding:0;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--csu-surface);color:var(--csu-text);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.2));font-size:13px;line-height:20px;overflow:hidden}",
      "dialog.csu-modal[open]{display:flex;flex-direction:column}",
      "dialog.csu-modal.csu-modal-sm{width:min(400px,calc(100vw - 32px))}",
      "dialog.csu-modal::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}",
      ".csu-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:20px 14px 12px 24px}",
      ".csu-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500}",
      ".csu-modal-body{flex:1;min-height:0;overflow:auto;padding:0 24px 20px}",
      ".csu-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:0 24px 24px}",
      ".csu-confirm-text{margin:0;font-size:14px;line-height:22px}",
      ".csu-stack{display:flex;flex-direction:column;gap:12px}",
      ".csu-section{display:flex;flex-direction:column;gap:10px}",
      ".csu-section+.csu-section{margin-top:20px}",
      ".csu-section-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}",
      ".csu-section-title{margin:0;font-size:14px;line-height:20px;font-weight:500}",
      ".csu-section-hint{font-size:12px;line-height:18px;color:var(--csu-muted)}",
      ".csu-list{margin:0;padding:0;list-style:none;border-radius:var(--csu-r-lg);background:var(--csu-raised);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong)}",
      ".csu-account{position:relative;display:flex;align-items:center;gap:12px;padding:12px 8px 12px 14px}",
      ".csu-account+.csu-account{border-top:var(--csu-hair) solid var(--csu-line)}",
      ".csu-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--csu-info) 14%,transparent);color:var(--csu-info);font-size:14px;font-weight:600}",
      ".csu-avatar-off{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));color:var(--csu-subtle)}",
      ".csu-account-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
      ".csu-account-name{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;line-height:20px;font-weight:500}",
      ".csu-account-meta{overflow:hidden;font-size:12px;line-height:18px;color:var(--csu-muted);text-overflow:ellipsis;white-space:nowrap}",
      ".csu-account-side{display:flex;align-items:center;gap:4px;flex:none}",
      ".csu-menu{position:absolute;top:calc(100% - 8px);right:8px;z-index:5;display:flex;flex-direction:column;min-width:148px;padding:4px;border-radius:var(--csu-r-md);background:var(--csu-raised);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16))}",
      ".csu-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:var(--csu-r-sm);background:transparent;color:var(--csu-text);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
      ".csu-menu-item:hover:not(:disabled){background:var(--csu-hover)}",
      ".csu-menu-item:disabled{opacity:.4;cursor:not-allowed}",
      ".csu-menu-danger{color:var(--csu-err)}",
      ".csu-empty{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:16px;border-radius:var(--csu-r-lg);background:var(--csu-raised);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);color:var(--csu-muted)}",
      ".csu-empty p{margin:0}",
      ".csu-note{margin:0;padding:8px 12px;border-radius:var(--csu-r-md);font-size:12px;line-height:18px}",
      ".csu-note-ok{background:color-mix(in srgb,var(--csu-ok) 10%,transparent);color:var(--csu-ok)}",
      ".csu-note-err{background:color-mix(in srgb,var(--csu-err) 10%,transparent);color:var(--csu-err)}",
      ".csu-note-warn{background:color-mix(in srgb,var(--csu-warn) 12%,transparent);color:var(--csu-warn)}",
      ".csu-muted{color:var(--csu-muted)}",
      ".csu-inline{display:inline-flex;align-items:center;gap:6px}",
      ".csu-disclosure{display:flex;align-items:center;justify-content:space-between;width:100%;padding:0;border:0;background:transparent;color:var(--csu-text);font:inherit;font-size:14px;line-height:20px;font-weight:500;text-align:left;cursor:pointer}",
      ".csu-disclosure svg{color:var(--csu-muted);transition:transform .15s ease}",
      ".csu-disclosure[aria-expanded=true] svg{transform:rotate(180deg)}",
      ".csu-form{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:var(--csu-r-lg);background:var(--csu-raised);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong)}",
      ".csu-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".csu-label{font-size:12px;line-height:18px;color:var(--csu-muted)}",
      ".csu-input{width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--csu-r-md);background:var(--csu-surface);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);color:var(--csu-text);font:inherit;font-size:13px}",
      ".csu-input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--csu-info));outline-offset:-1px}",
      ".csu-input:disabled{opacity:.6}",
      ".csu-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}",
      ".csu-row-end{justify-content:flex-end}",
      ".csu-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".csu-foot-note{display:flex;align-items:flex-start;gap:6px;margin:16px 0 0;font-size:12px;line-height:18px;color:var(--csu-subtle)}",
      ".csu-foot-note svg{flex:none;margin-top:1px}",
      ".csu-auth{display:flex;flex-direction:column;align-items:center;gap:12px;padding:4px 0;text-align:center}",
      ".csu-auth-text{max-width:400px;margin:0;font-size:14px;line-height:22px}",
      ".csu-auth-sub{margin:0;font-size:12px;line-height:18px;color:var(--csu-muted)}",
      ".csu-code{padding:10px 20px;border-radius:var(--csu-r-lg);background:var(--csu-raised);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:30px;line-height:40px;font-weight:600;letter-spacing:.14em;user-select:all}",
      ".csu-result-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%}",
      ".csu-result-ok{background:color-mix(in srgb,var(--csu-ok) 12%,transparent);color:var(--csu-ok)}",
      ".csu-result-warn{background:color-mix(in srgb,var(--csu-warn) 12%,transparent);color:var(--csu-warn)}",
      ".csu-result-err{background:color-mix(in srgb,var(--csu-err) 10%,transparent);color:var(--csu-err)}",
      ".csu-spinner{display:inline-block;flex:none;width:12px;height:12px;border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:csu-spin .8s linear infinite}",
      "@keyframes csu-spin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.csu-spinner{animation:none}.csu-disclosure svg{transition:none}}",
      ".csu-link{color:var(--csu-info);font-size:12px;line-height:18px;text-decoration:none}",
      ".csu-link:hover{text-decoration:underline}",
      ".csu-text-btn{padding:0;border:0;background:transparent;color:var(--csu-info);font:inherit;font-size:12px;line-height:18px;cursor:pointer}",
      ".csu-text-btn:hover{text-decoration:underline}",
      ".csu-prompt-box{width:100%;min-height:64px;padding:10px 12px;border:0;border-radius:var(--csu-r-md);background:var(--csu-raised);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);color:var(--csu-text);font:inherit;font-size:13px;line-height:20px;resize:none}",
      ".csu-examples{display:flex;flex-direction:column;gap:12px;color:var(--csu-text)}",
      ".csu-example-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
      "@media (max-width:640px){.csu-example-grid{grid-template-columns:1fr}}",
      ".csu-example{display:flex;align-items:center;gap:10px;min-height:52px;padding:10px 12px;border:0;border-radius:var(--csu-r-lg);background:transparent;box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);color:var(--csu-text);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
      ".csu-example:hover:not(:disabled){background:var(--csu-hover)}",
      ".csu-example:disabled{opacity:.6;cursor:progress}",
      ".csu-example-icon{flex:none;color:var(--csu-subtle)}",
      ".csu-example-text{flex:1;min-width:0}",
      ".csu-example-go{flex:none;color:var(--csu-subtle);opacity:0;transition:opacity .15s ease}",
      ".csu-example:hover .csu-example-go,.csu-example:focus-visible .csu-example-go{opacity:1}",
      ".csu-card{display:flex;align-items:flex-start;gap:12px;margin:16px 0 8px;padding:14px 16px;border-radius:var(--csu-r-lg);background:var(--csu-surface);box-shadow:inset 0 0 0 var(--csu-hair) var(--csu-line-strong);color:var(--csu-text);font-size:13px;line-height:20px}",
      ".csu-card-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--csu-warn) 12%,transparent);color:var(--csu-warn)}",
      ".csu-card-icon-ok{background:color-mix(in srgb,var(--csu-ok) 12%,transparent);color:var(--csu-ok)}",
      ".csu-card-main{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}",
      ".csu-card-title{margin:0;font-size:14px;line-height:20px;font-weight:500}",
      ".csu-card-text{margin:0;color:var(--csu-muted)}",
      ".csu-card-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:8px}",
      ".csu-settings{max-width:640px;padding:4px 0 12px;color:var(--csu-text);font-size:13px;line-height:20px}",
      ".csu-settings-hint{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:0 0 16px;font-size:12px;line-height:18px;color:var(--csu-muted)}",
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
        // Every tool result is checked for the auth-required kind, so skip parsing text that
        // cannot carry one of this plugin's payloads.
        if (value.indexOf("contract-sure-") === -1) return null;
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
        authRequired: state.authRequired,
      };
    }

    function refreshProjection(state) {
      var draftMap = new Map();
      var confirmedByDraftId = {};
      var detailMap = new Map();
      var authRequired = null;

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
        if (p.kind === AUTH_REQUIRED_KIND) {
          // Any of the plugin's tools can answer "connect an account first"; one card per turn, the latest.
          if (!authRequired || (result.seq || 0) >= (authRequired.seq || 0)) {
            authRequired = {
              seq: result.seq,
              callId: callId,
              toolName: call.name,
              reason: typeof p.reason === "string" ? p.reason : "no-account",
              message: typeof p.message === "string" ? p.message : "",
              serverUrl: typeof p.serverUrl === "string" ? p.serverUrl : "",
            };
          }
        } else if (call.name === STAGE_DRAFT_TOOL && p.kind === "contract-sure-draft" && p.draftId) {
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
        authRequired: authRequired,
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
        authRequired: null,
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
        // Calls of every tool are tracked: any of them may return the auth-required kind.
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
        : extractPayloadByKind(event.data, ["contract-sure-draft", "contract-sure-confirmed", "contract-sure-detail", AUTH_REQUIRED_KIND]);
      var resultsCopy = new Map(state.results);
      resultsCopy.set(resCallId, { seq: event.seq, failed: failedFlag, payload: payload });
      return refreshProjection(Object.assign({}, state, { results: resultsCopy }));
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

    // Resolve one contractSure/* call to its value; a failed result rejects with the host's message.
    function callRpc(connection, method, args, signal) {
      return Promise.resolve()
        .then(function () { return rpcCall(connection, method, args, signal); })
        .then(function (res) {
          if (res && res.ok === true) return res.value;
          throw new Error(extractRpcError(res, "请求失败，请重试。"));
        });
    }

    function errorText(err, fallback) {
      if (err && typeof err.message === "string" && err.message) return err.message;
      return fallback || "操作失败，请重试。";
    }

    function noop() {}

    // ---- Account state (contract B `State`), shared by every surface of the plugin ----
    function isAccountState(value) {
      return !!value && typeof value === "object" && Array.isArray(value.accounts);
    }

    function activeAccountOf(state) {
      if (!isAccountState(state) || !state.activeAccountId) return null;
      for (var i = 0; i < state.accounts.length; i++) {
        if (state.accounts[i] && state.accounts[i].id === state.activeAccountId) return state.accounts[i];
      }
      return null;
    }

    function hasUsableAccount(state) {
      var active = activeAccountOf(state);
      return !!active && active.status === "ok";
    }

    function displayName(account) {
      if (!account) return "";
      return String(account.realName || account.username || "");
    }

    // "张三（zhangsan）", or whichever of the two is known.
    function fullName(account) {
      if (!account) return "";
      var real = account.realName ? String(account.realName) : "";
      var user = account.username ? String(account.username) : "";
      if (real && user && real !== user) return real + "（" + user + "）";
      return real || user;
    }

    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function formatDay(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    }

    function formatClock(iso) {
      if (!iso) return "";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    }

    var EMPTY_SNAPSHOT = { status: "idle", state: null, error: "" };

    // One store per plugin instance: the badge, the page buttons, the account panel, the settings page
    // and the auth card all read it, and every RPC that returns a fresh State writes it back.
    function createAccountStore(getConnection) {
      var snapshot = EMPTY_SNAPSHOT;
      var listeners = [];
      var inflight = null;
      var fetchedAt = 0;

      function publish(patch) {
        snapshot = Object.assign({}, snapshot, patch);
        listeners.slice().forEach(function (fn) {
          try { fn(); } catch (_) {}
        });
      }

      function refresh() {
        if (inflight) return inflight;
        if (!snapshot.state) publish({ status: "loading", error: "" });
        inflight = callRpc(getConnection(), "getState", {})
          .then(function (value) {
            if (!isAccountState(value)) throw new Error("插件返回的账户信息格式不对。");
            return value;
          })
          .then(function (value) {
            inflight = null;
            fetchedAt = Date.now();
            publish({ status: "ready", state: value, error: "" });
            return value;
          }, function (err) {
            inflight = null;
            publish({ status: "error", error: errorText(err, "读取账户失败。") });
            throw err;
          });
        return inflight;
      }

      return {
        getSnapshot: function () {
          return snapshot;
        },
        subscribe: function (fn) {
          listeners.push(fn);
          return function () {
            var idx = listeners.indexOf(fn);
            if (idx !== -1) listeners.splice(idx, 1);
          };
        },
        refresh: refresh,
        // Refresh unless a ready snapshot is younger than maxAgeMs.
        ensure: function (maxAgeMs) {
          if (inflight) return;
          var limit = typeof maxAgeMs === "number" ? maxAgeMs : 15000;
          if (snapshot.status !== "ready" || Date.now() - fetchedAt > limit) refresh().catch(noop);
        },
        apply: function (state) {
          if (!isAccountState(state)) return false;
          fetchedAt = Date.now();
          publish({ status: "ready", state: state, error: "" });
          return true;
        },
      };
    }

    // Subscribe to the store; maxAgeMs === false skips the mount-time refresh.
    function useAccountSnapshot(store, maxAgeMs) {
      var [snap, setSnap] = useState(function () {
        return store ? store.getSnapshot() : EMPTY_SNAPSHOT;
      });
      useEffect(function () {
        if (!store) return undefined;
        setSnap(store.getSnapshot());
        var unsubscribe = store.subscribe(function () {
          setSnap(store.getSnapshot());
        });
        if (maxAgeMs !== false) store.ensure(maxAgeMs);
        return unsubscribe;
      }, [store]);
      return snap;
    }

    // ---- Host services, read when used (never injected: their absence must not block the plugin) ----
    function createServices(getSvc, fallbackConnection) {
      return {
        connection: function () { return getSvc("connection") || fallbackConnection; },
        workspace: function () { return getSvc("uiWorkspace"); },
        navigation: function () { return getSvc("pluginNavigation"); },
      };
    }

    function serviceOf(services, name) {
      if (!services || typeof services[name] !== "function") return undefined;
      try {
        return services[name]();
      } catch (_) {
        return undefined;
      }
    }

    // Open a new (or reusable blank) session with the prompt in its input, unsent.
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

    function canOpenPluginPage(services) {
      var nav = serviceOf(services, "navigation");
      return !!nav && typeof nav.openBundle === "function";
    }

    function openPluginPage(services) {
      var nav = serviceOf(services, "navigation");
      if (!nav || typeof nav.openBundle !== "function") return;
      try { nav.openBundle(PACKAGE_NAME); } catch (_) {}
    }

    function isHttpUrl(url) {
      return typeof url === "string" && /^https?:\/\//i.test(url);
    }

    // The desktop app hands http(s) window.open to the system browser; the dialog always keeps a link too,
    // because the web version may block a window opened after an await.
    function openExternal(url) {
      if (!isHttpUrl(url) || typeof window === "undefined" || !window || typeof window.open !== "function") return;
      try { window.open(url, "_blank", "noopener"); } catch (_) {}
    }

    function hostOf(url) {
      if (!isHttpUrl(url)) return "";
      try {
        return new URL(url).host;
      } catch (_) {
        return "";
      }
    }

    function ownsSubject(subject) {
      return !!subject && subject.kind === "bundle" && !!subject.pkg && subject.pkg.name === PACKAGE_NAME;
    }

    // ---- Small building blocks ----
    var ICON_PATHS = {
      close: ["M5.5 5.5l9 9", "M14.5 5.5l-9 9"],
      plus: ["M10 4.5v11", "M4.5 10h11"],
      chevron: ["M5.5 8l4.5 4.5L14.5 8"],
      user: ["M10 10.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2z", "M4.2 16.2c1.1-2.5 3.2-3.8 5.8-3.8s4.7 1.3 5.8 3.8"],
      spark: ["M10 3.2l1.5 4.2 4.3 1.6-4.3 1.6L10 14.8l-1.5-4.2-4.3-1.6 4.3-1.6z"],
      chat: ["M4 6.2a2.7 2.7 0 0 1 2.7-2.7h6.6A2.7 2.7 0 0 1 16 6.2v4.6a2.7 2.7 0 0 1-2.7 2.7H9.2L6 16.2v-2.7a2.7 2.7 0 0 1-2-2.6z"],
      arrow: ["M7 13l6-6", "M8.2 7H13v4.8"],
      check: ["M5 10.4l3.2 3.1L15 6.7"],
      alert: ["M10 3.6l7 12.4H3z", "M10 8.4v3.4", "M10 14.1v.1"],
      lock: ["M6.4 9V7.2a3.6 3.6 0 0 1 7.2 0V9", "M5 9h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z"],
      more: ["M5 10h.01", "M10 10h.01", "M15 10h.01"],
      cross: ["M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M7.7 7.7l4.6 4.6", "M12.3 7.7l-4.6 4.6"],
      clock: ["M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z", "M10 6.5V10l2.4 1.5"],
    };

    function icon(name, size) {
      var s = size || 16;
      var paths = ICON_PATHS[name] || [];
      return h("svg", {
        width: s,
        height: s,
        viewBox: "0 0 20 20",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: name === "more" ? 2.4 : 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
      }, paths.map(function (d, i) {
        return h("path", { key: i, d: d });
      }));
    }

    function noteBlock(note) {
      if (!note) return null;
      return h("p", { className: "csu-note csu-note-" + note.tone, role: note.tone === "err" ? "alert" : "status" }, note.text);
    }

    function resultBlock(tone, iconName, text, sub) {
      return h("div", { className: "csu-auth", role: "status" },
        h("span", { className: "csu-result-icon csu-result-" + tone }, icon(iconName, 22)),
        h("p", { className: "csu-auth-text" }, text),
        sub ? h("p", { className: "csu-auth-sub" }, sub) : null,
      );
    }

    var dialogSeq = 0;

    // A native modal <dialog>: showModal() puts it in the top layer, so no ancestor transform, overflow
    // or z-index of the plugin page or the conversation can clip it, and no portal is needed.
    function Modal(props) {
      var ref = useRef(null);
      var pressedBackdrop = useRef(false);
      var idRef = useRef("");
      if (!idRef.current) {
        dialogSeq += 1;
        idRef.current = "csu-dialog-" + dialogSeq;
      }
      useEffect(function () {
        var el = ref.current;
        if (el && typeof el.showModal === "function" && !el.open) {
          try {
            el.showModal();
          } catch (_) {
            try { el.setAttribute("open", ""); } catch (__) {}
          }
        }
        return function () {
          if (el && el.open && typeof el.close === "function") {
            try { el.close(); } catch (_) {}
          }
        };
      }, []);

      function requestClose() {
        if (props.onClose) props.onClose();
      }

      return h("dialog", {
        ref: ref,
        className: "csu csu-modal" + (props.size === "sm" ? " csu-modal-sm" : ""),
        "aria-labelledby": idRef.current + "-title",
        onCancel: function (event) {
          event.preventDefault();
          requestClose();
        },
        // Keys and clicks stay inside the dialog instead of reaching the page's own shortcuts and handlers.
        onKeyDown: function (event) {
          event.stopPropagation();
        },
        onMouseDown: function (event) {
          pressedBackdrop.current = event.target === event.currentTarget;
        },
        onClick: function (event) {
          event.stopPropagation();
          if (props.dismissOnBackdrop && pressedBackdrop.current && event.target === event.currentTarget) requestClose();
          pressedBackdrop.current = false;
        },
      },
        h("style", null, UI_CSS),
        h("div", { className: "csu-modal-head" },
          h("h2", { id: idRef.current + "-title", className: "csu-modal-title" }, props.title),
          h("button", { type: "button", className: "csu-icon-btn", "aria-label": "关闭", onClick: requestClose }, icon("close")),
        ),
        h("div", { className: "csu-modal-body" }, props.body),
        props.footer ? h("div", { className: "csu-modal-foot" }, props.footer) : null,
      );
    }

    function ConfirmDialog(props) {
      var busy = !!props.busy;
      return h(Modal, {
        size: "sm",
        title: props.title,
        onClose: busy ? noop : props.onCancel,
        dismissOnBackdrop: !busy,
        body: h("div", { className: "csu-stack" },
          h("p", { className: "csu-confirm-text" }, props.message),
          props.error ? h("p", { className: "csu-note csu-note-err", role: "alert" }, props.error) : null,
        ),
        footer: [
          h("button", { key: "cancel", type: "button", className: "csu-btn csu-btn-outline", disabled: busy, onClick: props.onCancel }, "取消"),
          h("button", {
            key: "confirm",
            type: "button",
            className: "csu-btn csu-btn-primary" + (props.danger ? " csu-btn-danger" : ""),
            disabled: busy,
            onClick: props.onConfirm,
          }, busy ? "处理中…" : props.confirmLabel),
        ],
      });
    }

    // ---- Browser authorization (contract B: startAuthorization → pollAuthorization / cancelAuthorization) ----
    function pollDelay(interval) {
      var seconds = Number(interval);
      if (!Number.isFinite(seconds) || seconds <= 0) seconds = 2;
      return Math.min(Math.max(seconds, 1), 30) * 1000;
    }

    // Shared by the account panel, the "试用" button, the examples and the auth card.
    // Closing while waiting cancels the request; unmounting (leaving the page) only stops polling here,
    // so an approval the user still gives in the browser is kept by the host.
    function AuthorizeDialog(props) {
      var store = props.store;
      var services = props.services;
      var [phase, setPhase] = useState("starting");
      var [request, setRequest] = useState(null);
      var [account, setAccount] = useState(null);
      var [message, setMessage] = useState("");
      var runRef = useRef(null);
      var latest = useRef(props);
      latest.current = props;

      function connection() {
        return serviceOf(services, "connection");
      }

      function stop() {
        var run = runRef.current;
        runRef.current = null;
        if (!run) return null;
        run.stopped = true;
        if (run.timer != null) clearTimeout(run.timer);
        run.timer = null;
        return run;
      }

      function schedule(run, req) {
        run.timer = setTimeout(function () {
          run.timer = null;
          poll(run, req);
        }, pollDelay(req.interval));
      }

      function poll(run, req) {
        if (run.stopped) return;
        callRpc(connection(), "pollAuthorization", { requestId: req.requestId }).then(function (res) {
          if (run.stopped) return;
          run.failures = 0;
          var status = res && res.status;
          if (status === "approved") {
            stop();
            if (store && !store.apply(res.state)) store.refresh().catch(noop);
            setAccount(res.account || null);
            setPhase("approved");
            if (latest.current.onApproved) latest.current.onApproved(res.account || null);
          } else if (status === "denied" || status === "expired") {
            stop();
            setPhase(status);
          } else if (status === "error") {
            stop();
            setMessage((res && res.message) || "授权没有完成，请重试。");
            setPhase("error");
          } else {
            schedule(run, req);
          }
        }).catch(function (err) {
          if (run.stopped) return;
          run.failures = (run.failures || 0) + 1;
          if (run.failures < 3) {
            schedule(run, req);
            return;
          }
          stop();
          setMessage(errorText(err, "查询授权结果失败，请重试。"));
          setPhase("error");
        });
      }

      function begin() {
        stop();
        var run = { stopped: false, cancelled: false, timer: null, requestId: null, failures: 0 };
        runRef.current = run;
        setPhase("starting");
        setRequest(null);
        setAccount(null);
        setMessage("");
        callRpc(connection(), "startAuthorization", {}).then(function (req) {
          if (!req || typeof req.requestId !== "string" || !req.requestId) {
            throw new Error("履约系统没有返回授权请求，请重试。");
          }
          if (run.stopped) {
            if (run.cancelled) callRpc(connection(), "cancelAuthorization", { requestId: req.requestId }).catch(noop);
            return;
          }
          run.requestId = req.requestId;
          setRequest(req);
          setPhase("waiting");
          openExternal(req.verifyUrl);
          schedule(run, req);
        }).catch(function (err) {
          if (run.stopped) return;
          stop();
          setMessage(errorText(err, "无法发起授权，请重试。"));
          setPhase("error");
        });
      }

      useEffect(function () {
        begin();
        return function () {
          stop();
        };
      }, []);

      function finish() {
        if (latest.current.onClose) latest.current.onClose();
      }

      function cancel() {
        var run = stop();
        var requestId = (run && run.requestId) || null;
        if (run) run.cancelled = true;
        if (requestId) callRpc(connection(), "cancelAuthorization", { requestId: requestId }).catch(noop);
        finish();
      }

      var waiting = phase === "starting" || phase === "waiting";
      var cancelButton = h("button", { key: "cancel", type: "button", className: "csu-btn csu-btn-outline", onClick: cancel }, "取消");
      var closeButton = h("button", { key: "close", type: "button", className: "csu-btn csu-btn-outline", onClick: finish }, "关闭");
      var retryButton = h("button", { key: "retry", type: "button", className: "csu-btn csu-btn-primary", onClick: begin }, "重试");
      var body;
      var footer;

      if (phase === "starting") {
        body = h("div", { className: "csu-auth", role: "status" },
          props.intro ? h("p", { className: "csu-auth-text" }, props.intro) : null,
          h("p", { className: "csu-auth-sub csu-inline" }, h("span", { className: "csu-spinner" }), "正在向履约系统申请授权…"),
        );
        footer = [cancelButton];
      } else if (phase === "waiting" && request) {
        var verifyUrl = request.verifyUrl;
        var until = formatClock(request.expiresAt);
        var host = hostOf(verifyUrl);
        body = h("div", { className: "csu-auth", "aria-live": "polite" },
          props.intro ? h("p", { className: "csu-auth-sub" }, props.intro) : null,
          h("p", { className: "csu-auth-text" }, "已在浏览器打开履约系统授权页，请确认校验码一致后点「授权」"),
          h("div", { className: "csu-code", "aria-label": "校验码 " + String(request.userCode || "") }, String(request.userCode || "")),
          h("p", { className: "csu-auth-sub csu-inline" },
            h("span", { className: "csu-spinner" }),
            "等待你在浏览器里授权" + (until ? "，校验码 " + until + " 前有效" : ""),
          ),
          isHttpUrl(verifyUrl)
            ? h("a", { className: "csu-link", href: verifyUrl, target: "_blank", rel: "noopener noreferrer" }, "没有自动打开？点这里打开授权页")
            : null,
          host ? h("p", { className: "csu-auth-sub" }, "授权页地址：" + host) : null,
        );
        footer = [cancelButton];
      } else if (phase === "approved") {
        body = resultBlock("ok", "check", account ? "已连接：" + fullName(account) : "已连接", props.approvedHint || null);
        footer = [h("button", { key: "done", type: "button", className: "csu-btn csu-btn-primary", onClick: finish }, "完成")];
      } else if (phase === "denied") {
        body = resultBlock("err", "cross", "你在履约系统里拒绝了这次授权", "如果是误点了拒绝，可以重新发起授权。");
        footer = [closeButton, retryButton];
      } else if (phase === "expired") {
        body = resultBlock("warn", "clock", "授权请求已过期", "校验码有效期内没有完成授权，请重新发起。");
        footer = [closeButton, retryButton];
      } else {
        body = resultBlock("err", "alert", message || "授权没有完成，请重试。");
        footer = [closeButton, retryButton];
      }

      return h(Modal, {
        title: props.title || "连接履约系统账户",
        onClose: waiting ? cancel : finish,
        body: body,
        footer: footer,
      });
    }

    function PromptFallbackDialog(props) {
      var [copied, setCopied] = useState("");
      var areaRef = useRef(null);

      function selectText() {
        var el = areaRef.current;
        if (el && typeof el.select === "function") {
          try { el.focus(); el.select(); } catch (_) {}
        }
      }

      function copy() {
        var clip = typeof navigator !== "undefined" && navigator ? navigator.clipboard : null;
        var manual = function () {
          selectText();
          setCopied("manual");
        };
        if (clip && typeof clip.writeText === "function") {
          clip.writeText(props.prompt).then(function () { setCopied("ok"); }, manual);
        } else {
          manual();
        }
      }

      return h(Modal, {
        size: "sm",
        title: "开始试用",
        dismissOnBackdrop: true,
        onClose: props.onClose,
        body: h("div", { className: "csu-stack" },
          h("p", { className: "csu-confirm-text" }, "当前页面不支持直接开始新会话，请手动新建会话后输入："),
          h("textarea", { ref: areaRef, className: "csu-prompt-box", readOnly: true, rows: 3, value: props.prompt, "aria-label": "试用提示词" }),
          copied === "ok" ? noteBlock({ tone: "ok", text: "已复制。" }) : null,
          copied === "manual" ? noteBlock({ tone: "warn", text: "没能自动复制，文字已选中，按 ⌘C 或 Ctrl+C 复制。" }) : null,
        ),
        footer: [
          h("button", { key: "close", type: "button", className: "csu-btn csu-btn-outline", onClick: props.onClose }, "关闭"),
          h("button", { key: "copy", type: "button", className: "csu-btn csu-btn-primary", onClick: copy }, "复制"),
        ],
      });
    }

    // "试用" and the example cards: open a session right away when an account works, otherwise
    // authorize first and open the session once the account is connected.
    function usePromptLauncher(store, services) {
      var [authPrompt, setAuthPrompt] = useState(null);
      var [fallbackPrompt, setFallbackPrompt] = useState(null);
      var [checking, setChecking] = useState(false);

      function openSession(prompt) {
        if (!startSessionWithPrompt(services, prompt)) setFallbackPrompt(prompt);
      }

      function decide(state, prompt) {
        if (hasUsableAccount(state)) openSession(prompt);
        else setAuthPrompt(prompt);
      }

      function launch(prompt) {
        if (checking) return;
        var snap = store ? store.getSnapshot() : EMPTY_SNAPSHOT;
        if (snap.status === "ready" && snap.state) {
          decide(snap.state, prompt);
          return;
        }
        if (!store) {
          setAuthPrompt(prompt);
          return;
        }
        setChecking(true);
        store.refresh().then(function (state) {
          setChecking(false);
          decide(state, prompt);
        }, function () {
          setChecking(false);
          setAuthPrompt(prompt);
        });
      }

      var dialogs = [
        authPrompt != null ? h(AuthorizeDialog, {
          key: "authorize",
          store: store,
          services: services,
          intro: "试用前需要先连接履约系统账户，连接后会直接打开新会话。",
          onClose: function () { setAuthPrompt(null); },
          onApproved: function () {
            var prompt = authPrompt;
            setAuthPrompt(null);
            openSession(prompt);
          },
        }) : null,
        fallbackPrompt != null ? h(PromptFallbackDialog, {
          key: "fallback",
          prompt: fallbackPrompt,
          onClose: function () { setFallbackPrompt(null); },
        }) : null,
      ];

      return { launch: launch, checking: checking, dialogs: dialogs };
    }

    // ---- Account panel ("管理"), also the body of the settings page ----
    function AccountMenu(props) {
      var [open, setOpen] = useState(false);
      var wrapRef = useRef(null);

      useEffect(function () {
        if (!open || typeof document === "undefined" || !document || typeof document.addEventListener !== "function") return undefined;
        function onPointer(event) {
          var wrap = wrapRef.current;
          if (wrap && typeof wrap.contains === "function" && wrap.contains(event.target)) return;
          setOpen(false);
        }
        function onKey(event) {
          if (event.key !== "Escape") return;
          // Close only the menu, not the dialog around it.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
        document.addEventListener("pointerdown", onPointer, true);
        document.addEventListener("keydown", onKey, true);
        return function () {
          document.removeEventListener("pointerdown", onPointer, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [open]);

      function pick(action) {
        return function () {
          setOpen(false);
          action();
        };
      }

      return h("span", { ref: wrapRef },
        h("button", {
          type: "button",
          className: "csu-icon-btn",
          "aria-label": "更多操作：" + props.label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: props.busy,
          onClick: function () { setOpen(!open); },
        }, props.busy ? h("span", { className: "csu-spinner" }) : icon("more")),
        open ? h("div", { className: "csu-menu", role: "menu" },
          h("button", { type: "button", role: "menuitem", className: "csu-menu-item", disabled: props.isActive, onClick: pick(props.onSetActive) }, "设为当前"),
          h("button", { type: "button", role: "menuitem", className: "csu-menu-item", onClick: pick(props.onReauthorize) }, "重新授权"),
          h("button", { type: "button", role: "menuitem", className: "csu-menu-item csu-menu-danger", onClick: pick(props.onDisconnect) }, "断开连接"),
        ) : null,
      );
    }

    function AccountRow(props) {
      var account = props.account;
      var status = account.status;
      var name = displayName(account) || "未命名账户";
      var meta = [account.username, account.deptName].filter(Boolean).join(" · ");
      var day = formatDay(account.expiresAt);
      if (day) meta = meta ? meta + " · " + day + " 到期" : day + " 到期";
      return h("li", { className: "csu-account", "data-account-id": String(account.id) },
        h("span", { className: "csu-avatar" + (status === "ok" ? "" : " csu-avatar-off"), "aria-hidden": "true" }, name.charAt(0)),
        h("div", { className: "csu-account-main" },
          h("div", { className: "csu-account-name" },
            h("span", null, name),
            props.isActive ? h("span", { className: "csu-tag csu-tag-neutral" }, "当前使用") : null,
            status === "expired" ? h("span", { className: "csu-tag csu-tag-warn" }, "已过期") : null,
            status === "revoked" ? h("span", { className: "csu-tag csu-tag-err" }, "已失效") : null,
          ),
          meta ? h("div", { className: "csu-account-meta", title: meta }, meta) : null,
        ),
        h("div", { className: "csu-account-side" },
          status === "ok" ? null : h("button", {
            type: "button",
            className: "csu-btn csu-btn-outline csu-btn-sm",
            disabled: props.busy,
            onClick: props.onReauthorize,
          }, "重新授权"),
          h(AccountMenu, {
            label: fullName(account) || name,
            isActive: props.isActive,
            busy: props.busy,
            onSetActive: props.onSetActive,
            onReauthorize: props.onReauthorize,
            onDisconnect: props.onDisconnect,
          }),
        ),
      );
    }

    function SettingsForm(props) {
      var store = props.store;
      var services = props.services;
      var state = props.state;
      var ocr = state.ocr || {};
      var accounts = Array.isArray(state.accounts) ? state.accounts : [];
      var [serverUrl, setServerUrl] = useState(state.serverUrl || "");
      var [ocrApiUrl, setOcrApiUrl] = useState(ocr.apiUrl || "");
      var [keyMode, setKeyMode] = useState("keep"); // keep | replace | clear
      var [newKey, setNewKey] = useState("");
      var [busy, setBusy] = useState(""); // "" | save | test
      var [result, setResult] = useState(null);
      var [serverConfirm, setServerConfirm] = useState(null); // { patch, busy }

      useEffect(function () { setServerUrl(state.serverUrl || ""); }, [state.serverUrl]);
      useEffect(function () { setOcrApiUrl(ocr.apiUrl || ""); }, [ocr.apiUrl]);

      var patch = {};
      var nextServer = String(serverUrl || "").trim();
      if (nextServer && nextServer !== state.serverUrl) patch.serverUrl = nextServer;
      var nextOcrUrl = String(ocrApiUrl || "").trim();
      if (nextOcrUrl !== (ocr.apiUrl || "")) patch.ocrApiUrl = nextOcrUrl;
      if (keyMode === "replace" && String(newKey || "").trim()) patch.ocrApiKey = String(newKey).trim();
      if (keyMode === "clear") patch.ocrApiKey = "";
      var dirty = Object.keys(patch).length > 0;

      function connection() {
        return serviceOf(services, "connection");
      }

      function save(finalPatch) {
        setBusy("save");
        setResult(null);
        return callRpc(connection(), "saveSettings", { patch: finalPatch }).then(function (next) {
          setBusy("");
          if (store) store.apply(next);
          setKeyMode("keep");
          setNewKey("");
          setResult({
            tone: "ok",
            text: finalPatch.disconnectAccounts ? "设置已保存，原来的账户都已断开，请重新连接。" : "设置已保存。",
          });
        }, function (err) {
          setBusy("");
          setResult({ tone: "err", text: errorText(err, "保存失败，请重试。") });
        });
      }

      function handleSave() {
        if (busy || !dirty) return;
        if (patch.serverUrl != null && !isHttpUrl(patch.serverUrl)) {
          setResult({ tone: "err", text: "服务器地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        if (patch.ocrApiUrl && !isHttpUrl(patch.ocrApiUrl)) {
          setResult({ tone: "err", text: "OCR 地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        if (patch.serverUrl != null && accounts.length > 0) {
          setServerConfirm({ patch: patch, busy: false });
          return;
        }
        save(patch);
      }

      function confirmServerChange() {
        var pending = serverConfirm;
        if (!pending || pending.busy) return;
        setServerConfirm({ patch: pending.patch, busy: true });
        save(Object.assign({}, pending.patch, { disconnectAccounts: true })).then(function () {
          setServerConfirm(null);
        });
      }

      function handleTest() {
        if (busy) return;
        setBusy("test");
        setResult(null);
        callRpc(connection(), "testConnection", {}).then(function (res) {
          setBusy("");
          var suffix = dirty ? "（测试用的是已保存的设置）" : "";
          if (res && res.ok) {
            var who = res.account ? fullName(res.account) : "";
            setResult({ tone: "ok", text: (who ? "连接正常，当前账户：" + who : res.message || "连接正常。") + suffix });
          } else {
            setResult({ tone: "err", text: ((res && res.message) || "连接失败，请检查服务器地址和账户。") + suffix });
          }
        }, function (err) {
          setBusy("");
          setResult({ tone: "err", text: errorText(err, "连接测试失败。") });
        });
      }

      var keyControl;
      if (keyMode === "replace") {
        keyControl = h("div", { className: "csu-row" },
          h("input", {
            className: "csu-input",
            type: "password",
            autoComplete: "off",
            placeholder: "粘贴新的 OCR Key",
            "aria-label": "新的 OCR Key",
            value: newKey,
            disabled: !!busy,
            style: { flex: "1 1 220px", width: "auto" },
            onChange: function (e) { setNewKey(e.target.value); },
          }),
          h("button", { type: "button", className: "csu-btn csu-btn-ghost csu-btn-sm", onClick: function () { setKeyMode("keep"); setNewKey(""); } }, "取消"),
        );
      } else if (keyMode === "clear") {
        keyControl = h("div", { className: "csu-row" },
          h("span", { className: "csu-muted" }, "保存后会清除 OCR Key"),
          h("button", { type: "button", className: "csu-btn csu-btn-ghost csu-btn-sm", onClick: function () { setKeyMode("keep"); } }, "撤销"),
        );
      } else {
        // Key 来自环境变量时，插件清不掉它；在这里设置的 Key 会优先于环境变量。
        var fromEnv = ocr.keySource === "env";
        keyControl = h("div", { className: "csu-row" },
          ocr.keyConfigured
            ? h("span", { className: "csu-tag csu-tag-ok" }, "已设置")
            : h("span", { className: "csu-tag csu-tag-neutral" }, "未设置"),
          fromEnv ? h("span", { className: "csu-muted" }, "来自环境变量 DEEPSEEK_API_KEY") : null,
          ocr.keyConfigured && ocr.keyMasked ? h("span", { className: "csu-mono csu-muted" }, String(ocr.keyMasked)) : null,
          h("button", { type: "button", className: "csu-btn csu-btn-outline csu-btn-sm", disabled: !!busy, onClick: function () { setKeyMode("replace"); } },
            fromEnv ? "改用其他 Key" : ocr.keyConfigured ? "替换" : "设置"),
          ocr.keyConfigured && !fromEnv
            ? h("button", { type: "button", className: "csu-btn csu-btn-ghost csu-btn-danger csu-btn-sm", disabled: !!busy, onClick: function () { setKeyMode("clear"); } }, "清除")
            : null,
        );
      }

      return h("div", { className: "csu-form" },
        h("div", { className: "csu-field" },
          h("span", { className: "csu-label" }, "服务器地址"),
          h("input", {
            className: "csu-input",
            type: "text",
            spellCheck: false,
            "aria-label": "服务器地址",
            placeholder: "http://履约系统地址/api/v1",
            value: serverUrl,
            disabled: !!busy,
            onChange: function (e) { setServerUrl(e.target.value); },
          }),
          accounts.length > 0 && patch.serverUrl != null
            ? h("span", { className: "csu-label" }, "更换服务器地址会断开全部账户。")
            : null,
        ),
        h("div", { className: "csu-field" },
          h("span", { className: "csu-label" }, "OCR 地址（识别扫描件和图片）"),
          h("input", {
            className: "csu-input",
            type: "text",
            spellCheck: false,
            "aria-label": "OCR 地址",
            value: ocrApiUrl,
            disabled: !!busy,
            onChange: function (e) { setOcrApiUrl(e.target.value); },
          }),
        ),
        h("div", { className: "csu-field" },
          h("span", { className: "csu-label" }, "OCR Key"),
          keyControl,
        ),
        noteBlock(result),
        h("div", { className: "csu-row csu-row-end" },
          h("button", { type: "button", className: "csu-btn csu-btn-outline csu-btn-sm", disabled: !!busy, onClick: handleTest }, busy === "test" ? "测试中…" : "测试连接"),
          h("button", { type: "button", className: "csu-btn csu-btn-primary csu-btn-sm", disabled: !!busy || !dirty, onClick: handleSave }, busy === "save" ? "保存中…" : "保存设置"),
        ),
        serverConfirm ? h(ConfirmDialog, {
          title: "更换服务器地址？",
          message: "更换服务器地址会断开全部账户，保存后需要重新连接。",
          confirmLabel: "断开并保存",
          danger: true,
          busy: serverConfirm.busy,
          onCancel: function () { setServerConfirm(null); },
          onConfirm: confirmServerChange,
        }) : null,
      );
    }

    function AccountPanel(props) {
      var store = props.store;
      var services = props.services;
      var snap = useAccountSnapshot(store, false);
      var state = snap.state;
      var [auth, setAuth] = useState(null); // { account? } while the authorize dialog is open
      var [confirm, setConfirm] = useState(null); // { account, busy, error }
      var [busyId, setBusyId] = useState("");
      var [notice, setNotice] = useState(null);
      var [settingsOpen, setSettingsOpen] = useState(!!props.settingsOpen);

      useEffect(function () {
        if (store) store.refresh().catch(noop);
      }, [store]);

      function connection() {
        return serviceOf(services, "connection");
      }

      function setActive(account) {
        setBusyId(account.id);
        setNotice(null);
        callRpc(connection(), "setActiveAccount", { accountId: account.id }).then(function (next) {
          setBusyId("");
          if (store) store.apply(next);
          setNotice({ tone: "ok", text: "已切换到 " + fullName(account) + "。" });
        }, function (err) {
          setBusyId("");
          setNotice({ tone: "err", text: errorText(err, "切换账户失败，请重试。") });
        });
      }

      function disconnect() {
        var current = confirm;
        if (!current || current.busy) return;
        setConfirm({ account: current.account, busy: true, error: "" });
        callRpc(connection(), "disconnectAccount", { accountId: current.account.id }).then(function (next) {
          if (store) store.apply(next);
          setConfirm(null);
          // revoked === false：本地凭据已删，但履约系统没确认吊销（网络不通、服务器出错等），提示用户去系统里手动吊销。
          setNotice(next && next.revoked === false
            ? { tone: "warn", text: "已在本机断开 " + fullName(current.account) + "，但履约系统没有确认吊销。请登录履约系统，在右上角菜单的「插件授权」里手动吊销这台设备。" }
            : { tone: "ok", text: "已断开 " + fullName(current.account) + "。" });
        }, function (err) {
          setConfirm({ account: current.account, busy: false, error: errorText(err, "断开失败，请重试。") });
        });
      }

      var accounts = state && Array.isArray(state.accounts) ? state.accounts : [];
      var activeId = state ? state.activeAccountId : null;
      var listBody;
      if (!state && snap.status === "error") {
        listBody = h("div", { className: "csu-stack" },
          h("p", { className: "csu-note csu-note-err", role: "alert" }, "读取账户失败：" + (snap.error || "未知错误")),
          h("div", null, h("button", {
            type: "button",
            className: "csu-btn csu-btn-outline csu-btn-sm",
            onClick: function () { if (store) store.refresh().catch(noop); },
          }, "重试")),
        );
      } else if (!state) {
        listBody = h("p", { className: "csu-muted csu-inline", role: "status" }, h("span", { className: "csu-spinner" }), "正在读取账户…");
      } else if (!accounts.length) {
        listBody = h("div", { className: "csu-empty" },
          h("p", null, "还没有连接履约系统账户。连接后，履约无忧会用你的账号查询合同、回款节点和流水。"),
          h("button", { type: "button", className: "csu-btn csu-btn-primary csu-btn-sm", onClick: function () { setAuth({}); } }, icon("plus", 13), "连接账户"),
        );
      } else {
        listBody = h("div", { className: "csu-stack" },
          h("ul", { className: "csu-list", "aria-label": "已连接的账户" },
            accounts.map(function (account) {
              return h(AccountRow, {
                key: account.id,
                account: account,
                isActive: account.id === activeId,
                busy: busyId === account.id,
                onSetActive: function () { setActive(account); },
                onReauthorize: function () { setAuth({ account: account }); },
                onDisconnect: function () { setConfirm({ account: account, busy: false, error: "" }); },
              });
            }),
          ),
          h("div", null, h("button", {
            type: "button",
            className: "csu-btn csu-btn-outline csu-btn-sm",
            onClick: function () { setAuth({}); },
          }, icon("plus", 13), "连接另一个账户")),
        );
      }

      var credentialNote = state ? CREDENTIAL_NOTES[state.credentialStore] : "";

      return h("div", { className: "csu csu-panel" },
        h("style", null, UI_CSS),
        notice ? h("div", { style: { marginBottom: "12px" } }, noteBlock(notice)) : null,
        h("section", { className: "csu-section" },
          h("div", { className: "csu-section-head" },
            h("h3", { className: "csu-section-title" }, "已连接的账户"),
            accounts.length ? h("span", { className: "csu-section-hint" }, accounts.length + " 个") : null,
          ),
          listBody,
        ),
        h("section", { className: "csu-section" },
          h("button", {
            type: "button",
            className: "csu-disclosure",
            "aria-expanded": settingsOpen,
            onClick: function () { setSettingsOpen(!settingsOpen); },
          }, h("span", null, "服务器与识别设置"), icon("chevron")),
          settingsOpen
            ? (state ? h(SettingsForm, { store: store, services: services, state: state }) : h("p", { className: "csu-muted" }, "读取到账户信息后才能修改设置。"))
            : null,
        ),
        credentialNote ? h("p", { className: "csu-foot-note" }, icon("lock", 14), h("span", null, credentialNote)) : null,
        auth ? h(AuthorizeDialog, {
          store: store,
          services: services,
          title: auth.account ? "重新授权" : "连接履约系统账户",
          intro: auth.account ? "请在打开的履约系统页面里用 " + fullName(auth.account) + " 登录并授权。" : null,
          onClose: function () { setAuth(null); },
          onApproved: function (account) {
            if (account) setNotice({ tone: "ok", text: "已连接：" + fullName(account) + "。" });
          },
        }) : null,
        confirm ? h(ConfirmDialog, {
          title: "断开 " + fullName(confirm.account) + "？",
          message: "断开后会在履约系统里吊销这台设备的授权，之后需要重新连接才能使用。",
          confirmLabel: "断开连接",
          danger: true,
          busy: confirm.busy,
          error: confirm.error,
          onCancel: function () { setConfirm(null); },
          onConfirm: disconnect,
        }) : null,
      );
    }

    function ManageDialog(props) {
      return h(Modal, {
        title: "管理 · 履约无忧",
        dismissOnBackdrop: true,
        onClose: props.onClose,
        body: h(AccountPanel, { store: props.store, services: props.services }),
      });
    }

    // ---- Plugin page contributions (rendered only for this bundle's own page) ----
    function DetailActions(props) {
      var store = props.store;
      var services = props.services;
      useAccountSnapshot(store, 15000);
      var [manageOpen, setManageOpen] = useState(false);
      var launcher = usePromptLauncher(store, services);
      return h("span", { className: "csu csu-actions" },
        h("style", null, UI_CSS),
        h("button", {
          type: "button",
          className: "csu-btn csu-btn-outline csu-btn-sm",
          onClick: function () { setManageOpen(true); },
        }, icon("user", 13), "管理"),
        h("button", {
          type: "button",
          className: "csu-btn csu-btn-primary csu-btn-sm",
          disabled: launcher.checking,
          onClick: function () { launcher.launch(TRY_PROMPT); },
        }, icon("spark", 13), "试用"),
        manageOpen ? h(ManageDialog, { store: store, services: services, onClose: function () { setManageOpen(false); } }) : null,
        launcher.dialogs,
      );
    }

    function DetailBadge(props) {
      var snap = useAccountSnapshot(props.store, 15000);
      var state = snap.state;
      if (!state) return null;
      var active = activeAccountOf(state);
      var tag;
      if (active && active.status === "ok") {
        tag = h("span", { className: "csu-tag csu-tag-ok csu-tag-dot", title: fullName(active) }, "已连接 · " + displayName(active));
      } else if (active) {
        tag = h("span", { className: "csu-tag csu-tag-warn", title: fullName(active) }, "授权已失效");
      } else {
        tag = h("span", { className: "csu-tag csu-tag-neutral" }, "未连接");
      }
      return h("span", { className: "csu", style: { display: "inline-flex" } }, h("style", null, UI_CSS), tag);
    }

    function ExamplesSection(props) {
      var store = props.store;
      var services = props.services;
      var launcher = usePromptLauncher(store, services);
      return h("section", { className: "csu csu-examples", "aria-label": "试试这样问" },
        h("style", null, UI_CSS),
        h("div", { className: "csu-section-head" },
          h("h4", { className: "csu-section-title" }, "试试这样问"),
          h("span", { className: "csu-section-hint" }, "点一下会打开新会话并填好问题，可以改完再发送"),
        ),
        h("div", { className: "csu-example-grid" },
          EXAMPLE_PROMPTS.map(function (prompt) {
            return h("button", {
              key: prompt,
              type: "button",
              className: "csu-example",
              disabled: launcher.checking,
              onClick: function () { launcher.launch(prompt); },
            },
              h("span", { className: "csu-example-icon" }, icon("chat")),
              h("span", { className: "csu-example-text" }, prompt),
              h("span", { className: "csu-example-go" }, icon("arrow")),
            );
          }),
        ),
        launcher.dialogs,
      );
    }

    // ---- 1. Settings Section ("履约无忧配置"): the same account panel as "管理" ----
    function SettingsSection(props) {
      var services = props.services;
      return h("div", { className: "csu csu-settings" },
        h("style", null, UI_CSS),
        h("p", { className: "csu-settings-hint" },
          h("span", null, "也可以在插件页的「管理」里管理账户"),
          canOpenPluginPage(services)
            ? h("button", { type: "button", className: "csu-text-btn", onClick: function () { openPluginPage(services); } }, "打开插件页")
            : null,
        ),
        h(AccountPanel, { store: props.store, services: services, settingsOpen: true }),
      );
    }

    // ---- Auth card: any tool answered contract C's "connect an account first" ----
    function AuthRequiredCard(props) {
      var info = props.info || {};
      var store = props.store;
      var services = props.services;
      var snap = useAccountSnapshot(store, false);
      var [checked, setChecked] = useState(false);
      var [open, setOpen] = useState(false);
      var [connected, setConnected] = useState(null);

      // The tool may have just marked the account expired or revoked: read the current state once.
      useEffect(function () {
        if (!store) return;
        store.refresh().then(function () { setChecked(true); }, function () { setChecked(true); });
      }, [store]);

      var reason = AUTH_CARD_TITLES[info.reason] ? info.reason : "no-account";
      var active = checked ? activeAccountOf(snap.state) : null;
      var manageLink = canOpenPluginPage(services)
        ? h("button", { type: "button", className: "csu-text-btn", onClick: function () { openPluginPage(services); } }, "管理账户")
        : null;
      var dialog = open ? h(AuthorizeDialog, {
        store: store,
        services: services,
        approvedHint: "回到对话回复「继续」即可。",
        onClose: function () { setOpen(false); },
        onApproved: function (account) { setConnected(account || {}); },
      }) : null;

      var iconNode;
      var main;
      if (connected) {
        iconNode = h("span", { className: "csu-card-icon csu-card-icon-ok" }, icon("check"));
        main = h("div", { className: "csu-card-main" },
          h("p", { className: "csu-card-title" }, "已连接：" + (displayName(connected) || "履约系统账户") + "，回复「继续」即可"),
          manageLink ? h("div", { className: "csu-card-actions" }, manageLink) : null,
        );
      } else if (active && active.status === "ok") {
        iconNode = h("span", { className: "csu-card-icon csu-card-icon-ok" }, icon("check"));
        main = h("div", { className: "csu-card-main" },
          h("p", { className: "csu-card-title" }, AUTH_CARD_TITLES[reason]),
          h("p", { className: "csu-card-text" }, "现在已连接：" + fullName(active) + "，回复「继续」即可。"),
          h("div", { className: "csu-card-actions" },
            h("button", { type: "button", className: "csu-text-btn", onClick: function () { setOpen(true); } }, "连接其他账户"),
            manageLink,
          ),
        );
      } else {
        iconNode = h("span", { className: "csu-card-icon" }, icon("lock"));
        main = h("div", { className: "csu-card-main" },
          h("p", { className: "csu-card-title" }, AUTH_CARD_TITLES[reason]),
          h("p", { className: "csu-card-text" }, info.message || "需要先连接履约系统账户：点「连接账户」，在浏览器里完成授权后，回复「继续」。"),
          h("div", { className: "csu-card-actions" },
            h("button", {
              type: "button",
              className: "csu-btn csu-btn-primary csu-btn-sm",
              disabled: !services,
              onClick: function () { setOpen(true); },
            }, "连接账户"),
            manageLink,
          ),
        );
      }

      return h("section", { className: "csu csu-card", "aria-label": "连接履约系统账户", "data-auth-reason": reason },
        h("style", null, UI_CSS),
        iconNode,
        main,
        dialog,
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
      var authRequired = data.authRequired || null;
      if (!drafts.length && !details.length && !authRequired) return null;

      var effectiveSessionId = mountedSession || props.sessionId || (turn && turn.sessionId) || "";

      return h("div", { className: "cs-wrap" },
        h("style", null, CSS),
        authRequired ? h(AuthRequiredCard, {
          key: "auth-" + String(authRequired.callId || ""),
          info: authRequired,
          store: props.store,
          services: props.services,
        }) : null,
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
    exports.AccountPanel = AccountPanel;
    exports.AuthorizeDialog = AuthorizeDialog;
    exports.AuthRequiredCard = AuthRequiredCard;
    exports.DetailActions = DetailActions;
    exports.DetailBadge = DetailBadge;
    exports.ExamplesSection = ExamplesSection;
    exports.createAccountStore = createAccountStore;
    exports.formatTriggerRule = formatTriggerRule;
    exports.eventDefinition = eventDefinition;
    exports.TRY_PROMPT = TRY_PROMPT;
    exports.EXAMPLE_PROMPTS = EXAMPLE_PROMPTS;

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
      // uiWorkspace and pluginNavigation are read when a button is clicked, never injected.
      var services = createServices(getSvc, connection);
      var store = createAccountStore(services.connection);

      // 1. Register settings.section ("履约无忧配置")
      slots.inject("settings.section", function () {
        var BoundSettings = function (props) {
          return h(SettingsSection, Object.assign({}, props, { store: store, services: services }));
        };
        return slots.register({
          name: "settings.section",
          id: "contract-sure-settings",
          order: 30,
          label: "履约无忧配置",
        }, BoundSettings);
      });

      // 2. Plugin page: head actions, title badge and examples, each only on this bundle's own page.
      // The entry itself holds no hooks, so switching between plugin pages never changes a hook count.
      var registerDetail = function (slotName, id, Component) {
        slots.inject(slotName, function () {
          var Entry = function (props) {
            return ownsSubject(props && props.subject) ? h(Component, { store: store, services: services }) : null;
          };
          return slots.register({ name: slotName, id: id }, Entry);
        });
      };
      registerDetail("plugins.detail.actions", "contract-sure-actions", DetailActions);
      registerDetail("plugins.detail.badge", "contract-sure-status", DetailBadge);
      registerDetail("plugins.detail.section", "contract-sure-examples", ExamplesSection);

      // 3. Register conversation.chat.turnTail ("contract-sure-cards") when uiConversation is present or becomes ready
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
              store: store,
              services: services,
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
