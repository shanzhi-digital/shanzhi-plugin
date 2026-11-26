// @local/salesforge DSH web client bundle (zero JSX/TS, zero third-party deps)
// Registers:
//   1. settings.section (id="salesforge-settings", label="销售管理配置", order=31)
//      - the same account panel the plugin page's "管理" opens
//   2. conversation.chat.turnTail (id="salesforge-cards", order=26)
//      - "需要连接账户" card for any tool result of kind salesforge-auth-required
//      - "工作日报草稿" card (salesforge-report-draft) and the "确认删除 / 确认移交" card
//        (salesforge-action-pending): nothing is deleted or transferred until the user confirms there
//   3. Plugin page contributions, rendered only for this bundle's own page:
//      - plugins.detail.actions: "管理" (account panel) and "试用" (new session with a prompt)
//      - plugins.detail.badge: connection status beside the title
//      - plugins.bundle.config (keyed by this package): "试试这样问" panel under the README
// Accounts are connected through browser authorization (salesforge/startAuthorization +
// pollAuthorization); the UI never sees or shows a token.
// Class names use the "sfu-" / "sfx-" prefixes so they never collide with @local/contract-sure's
// "csu-" / "csx-" styles.

window.__ModuleLoader__.load({
  id: "@local/salesforge",
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

    var KEY = "salesforge";
    var PACKAGE_NAME = "@local/salesforge";
    var AUTH_REQUIRED_KIND = "salesforge-auth-required";
    var REPORT_DRAFT_KIND = "salesforge-report-draft";
    var REPORT_SUBMITTED_RECORD_TYPE = "plugin:salesforge/report-submitted";
    var ACTION_PENDING_KIND = "salesforge-action-pending";
    var ACTION_RECORD_TYPE = "plugin:salesforge/action-done";
    var REPORT_TEXT_MAX = 2000;
    function isRecordType(type) { return type === REPORT_SUBMITTED_RECORD_TYPE || type === ACTION_RECORD_TYPE; }

    var TRY_PROMPT = "帮我盘一下本季度的销售情况：目标完成了多少、还差多少，接下来该重点跟进哪些项目";
    var EXAMPLE_PROMPTS = [
      "看看我本季度的销售目标完成了多少、还差多少，再列出预计本季度签约但还没签下来的项目，按金额从大到小排，有时间风险或赢单风险的单独标出来",
      "找出我负责的、超过 30 天没跟进的客户和渠道，按未跟进天数从多到少排成一张表，挑最久的五家看看上次拜访都聊了什么",
      "汇总我这周的日报和下周的周计划：这周拜访了哪些客户和渠道、各谈到了哪一步，下周打算跟进谁，整理成几条要点给我",
    ];

    // The examples panel's look. ExamplesSection and EXAMPLES_CSS are shared with @local/contract-sure
    // (there under the csx- prefix); only this object, EXAMPLE_PROMPTS and the dark glass-card tint differ
    // (EXAMPLES_CSS warms it to plum so the cards don't read blue-grey on this artwork). Pairs are [light, dark].
    // ICON_SVG is icon.svg verbatim (a test keeps them equal). The card shows it as a data-URI <img>, so
    // its <mask id="k"> never meets the other plugin's icon in the page's id space.
    var ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><mask id="k"><rect width="48" height="48" fill="#fff"/><circle cx="34" cy="34" r="13"/></mask><g mask="url(#k)"><rect x="4" y="26" width="10" height="18" rx="4" fill="#C4B5FD"/><rect x="15" y="16" width="10" height="28" rx="4" fill="#A78BFA"/><rect x="26" y="4" width="10" height="40" rx="4" fill="#FB7185"/></g><circle cx="34" cy="34" r="10.5" fill="#FB923C"/><path d="M31 29h8v8l-2.87-2.87-5.4 5.4-2.26-2.26 5.4-5.4z" fill="#fff"/></svg>\n';
    var EXAMPLES_LOOK = {
      name: "销售管理",
      icon: "data:image/svg+xml," + encodeURIComponent(ICON_SVG),
      // Files in lib/assets, served by the host's package-asset route (package.json "./assets/*").
      backgrounds: ["examples-bg-light-b47dc0af474e.webp", "examples-bg-dark-bfc559146a35.webp"],
      brand: ["#C2410C", "#FDBA74"],
      onBrand: ["#ffffff", "#2a1405"],
      glow: ["rgba(167,139,250,.28)", "rgba(251,146,60,.2)"],
      // Shown under the image while it loads, and instead of it when it cannot load.
      fallback: [
        "radial-gradient(55% 110% at 0% 100%,#fecdb1,rgba(254,205,177,0) 70%),radial-gradient(50% 100% at 100% 60%,#eed5fa,rgba(238,213,250,0) 70%),radial-gradient(40% 80% at 100% 0%,#e5f0e7,rgba(229,240,231,0) 70%),#fcecee",
        "radial-gradient(55% 100% at 100% 0%,#6a312e,rgba(106,49,46,0) 70%),radial-gradient(55% 100% at 0% 100%,#662d28,rgba(102,45,40,0) 70%),radial-gradient(45% 90% at 100% 60%,#2c1844,rgba(44,24,68,0) 70%),#1a1124",
      ],
    };
    var AUTH_CARD_TITLES = {
      "no-account": "还没有连接销售管理系统账户",
      expired: "销售管理系统授权已过期",
      revoked: "销售管理系统授权已失效",
    };
    var CREDENTIAL_NOTES = {
      "dsh-credentials": "令牌保存在小智办公凭据存储中，界面不会显示令牌。",
      file: "令牌保存在本机插件配置文件中（仅本人可读），界面不会显示令牌。",
    };

    // Account panel, plugin page contributions, dialogs and the auth card. The values mirror the
    // host primitives (Button sm/md, Tag tones, Modal) through the same --dsw-* theme tokens, so
    // light and dark themes follow the host app without a stylesheet of their own.
    var UI_CSS = [
      ".sfu{--sfu-text:var(--dsw-alias-label-primary,#1f1f1f);--sfu-muted:var(--dsw-alias-label-secondary,#5c5c5c);--sfu-subtle:var(--dsw-alias-label-tertiary,#8a8a8a);--sfu-line:var(--dsw-alias-border-l2,rgba(0,0,0,.08));--sfu-line-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.16));--sfu-surface:var(--dsw-alias-bg-layer-2,#f7f7f7);--sfu-raised:var(--dsw-alias-bg-layer-3,#fff);--sfu-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--sfu-ok:var(--dsw-alias-state-success-primary,#1a7f37);--sfu-warn:var(--dsw-alias-state-warn-primary,#b45309);--sfu-err:var(--dsw-alias-state-error-primary,#d1242f);--sfu-info:var(--dsw-alias-state-business-primary,#2563eb);--sfu-r-sm:var(--dsw-radius-sm,6px);--sfu-r-md:var(--dsw-radius-md,8px);--sfu-r-lg:var(--dsw-radius-lg,12px);--sfu-hair:var(--dsh-hairline-width,.5px)}",
      ".sfu,.sfu *{box-sizing:border-box}",
      ".sfu-actions{display:inline-flex;align-items:center;gap:8px}",
      ".sfu-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:0;border-radius:var(--sfu-r-md);background:transparent;color:var(--sfu-text);font:inherit;font-size:14px;line-height:22px;font-weight:400;cursor:pointer;white-space:nowrap;text-decoration:none}",
      ".sfu-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--sfu-r-sm)}",
      ".sfu-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".sfu-btn:focus-visible,.sfu-icon-btn:focus-visible,.sfu-menu-item:focus-visible,.sfu-disclosure:focus-visible,.sfu-text-btn:focus-visible,.sfu-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--sfu-info));outline-offset:1px}",
      ".sfu-btn-primary{background:var(--dsw-alias-button-primary-fill,#1f1f1f);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".sfu-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#3a3a3a)}",
      ".sfu-btn-outline{box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong)}",
      ".sfu-btn-outline:hover:not(:disabled),.sfu-btn-ghost:hover:not(:disabled){background:var(--sfu-hover)}",
      ".sfu-btn-danger{color:var(--sfu-err)}",
      ".sfu-btn-danger.sfu-btn-primary{background:var(--sfu-err);color:#fff}",
      ".sfu-btn-danger.sfu-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--sfu-err) 86%,#000)}",
      ".sfu-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--sfu-r-sm);background:transparent;color:var(--sfu-muted);cursor:pointer}",
      ".sfu-icon-btn:hover:not(:disabled){background:var(--sfu-hover);color:var(--sfu-text)}",
      ".sfu-icon-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".sfu-tag{display:inline-flex;align-items:center;gap:4px;flex:none;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}",
      ".sfu-tag-ok{background:color-mix(in srgb,var(--sfu-ok) 10%,transparent);color:var(--sfu-ok)}",
      ".sfu-tag-warn{background:color-mix(in srgb,var(--sfu-warn) 12%,transparent);color:var(--sfu-warn)}",
      ".sfu-tag-err{background:color-mix(in srgb,var(--sfu-err) 10%,transparent);color:var(--sfu-err)}",
      ".sfu-tag-neutral{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));color:var(--sfu-muted)}",
      ".sfu-tag-dot:before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}",
      "dialog.sfu-modal{width:min(560px,calc(100vw - 32px));max-width:none;max-height:min(760px,calc(100vh - 48px));margin:auto;padding:0;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--sfu-surface);color:var(--sfu-text);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.2));font-size:13px;line-height:20px;overflow:hidden}",
      "dialog.sfu-modal[open]{display:flex;flex-direction:column}",
      "dialog.sfu-modal.sfu-modal-sm{width:min(400px,calc(100vw - 32px))}",
      "dialog.sfu-modal::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}",
      ".sfu-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:20px 14px 12px 24px}",
      ".sfu-modal-title{margin:0;font-size:16px;line-height:24px;font-weight:500}",
      ".sfu-modal-body{flex:1;min-height:0;overflow:auto;padding:0 24px 20px}",
      ".sfu-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;padding:0 24px 24px}",
      ".sfu-confirm-text{margin:0;font-size:14px;line-height:22px}",
      ".sfu-stack{display:flex;flex-direction:column;gap:12px}",
      ".sfu-section{display:flex;flex-direction:column;gap:10px}",
      ".sfu-section+.sfu-section{margin-top:20px}",
      ".sfu-section-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}",
      ".sfu-section-title{margin:0;font-size:14px;line-height:20px;font-weight:500}",
      ".sfu-section-hint{font-size:12px;line-height:18px;color:var(--sfu-muted)}",
      ".sfu-list{margin:0;padding:0;list-style:none;border-radius:var(--sfu-r-lg);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong)}",
      ".sfu-account{position:relative;display:flex;align-items:center;gap:12px;padding:12px 8px 12px 14px}",
      ".sfu-account+.sfu-account{border-top:var(--sfu-hair) solid var(--sfu-line)}",
      ".sfu-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--sfu-info) 14%,transparent);color:var(--sfu-info);font-size:14px;font-weight:600}",
      ".sfu-avatar-off{background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.05));color:var(--sfu-subtle)}",
      ".sfu-account-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
      ".sfu-account-name{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:14px;line-height:20px;font-weight:500}",
      ".sfu-account-meta{overflow:hidden;font-size:12px;line-height:18px;color:var(--sfu-muted);text-overflow:ellipsis;white-space:nowrap}",
      ".sfu-account-side{display:flex;align-items:center;gap:4px;flex:none}",
      ".sfu-menu{position:absolute;top:calc(100% - 8px);right:8px;z-index:5;display:flex;flex-direction:column;min-width:148px;padding:4px;border-radius:var(--sfu-r-md);background:var(--sfu-raised);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16))}",
      ".sfu-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:32px;padding:6px 8px;border:0;border-radius:var(--sfu-r-sm);background:transparent;color:var(--sfu-text);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}",
      ".sfu-menu-item:hover:not(:disabled){background:var(--sfu-hover)}",
      ".sfu-menu-item:disabled{opacity:.4;cursor:not-allowed}",
      ".sfu-menu-danger{color:var(--sfu-err)}",
      ".sfu-empty{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:16px;border-radius:var(--sfu-r-lg);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-muted)}",
      ".sfu-empty p{margin:0}",
      ".sfu-note{margin:0;padding:8px 12px;border-radius:var(--sfu-r-md);font-size:12px;line-height:18px}",
      ".sfu-note-ok{background:color-mix(in srgb,var(--sfu-ok) 10%,transparent);color:var(--sfu-ok)}",
      ".sfu-note-err{background:color-mix(in srgb,var(--sfu-err) 10%,transparent);color:var(--sfu-err)}",
      ".sfu-note-warn{background:color-mix(in srgb,var(--sfu-warn) 12%,transparent);color:var(--sfu-warn)}",
      ".sfu-muted{color:var(--sfu-muted)}",
      ".sfu-inline{display:inline-flex;align-items:center;gap:6px}",
      ".sfu-disclosure{display:flex;align-items:center;justify-content:space-between;width:100%;padding:0;border:0;background:transparent;color:var(--sfu-text);font:inherit;font-size:14px;line-height:20px;font-weight:500;text-align:left;cursor:pointer}",
      ".sfu-disclosure svg{color:var(--sfu-muted);transition:transform .15s ease}",
      ".sfu-disclosure[aria-expanded=true] svg{transform:rotate(180deg)}",
      ".sfu-form{display:flex;flex-direction:column;gap:14px;padding:14px 16px;border-radius:var(--sfu-r-lg);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong)}",
      ".sfu-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".sfu-label{font-size:12px;line-height:18px;color:var(--sfu-muted)}",
      ".sfu-input{width:100%;height:32px;padding:0 10px;border:0;border-radius:var(--sfu-r-md);background:var(--sfu-surface);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-text);font:inherit;font-size:13px}",
      ".sfu-input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--sfu-info));outline-offset:-1px}",
      ".sfu-input:disabled{opacity:.6}",
      ".sfu-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}",
      ".sfu-row-end{justify-content:flex-end}",
      ".sfu-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}",
      ".sfu-foot-note{display:flex;align-items:flex-start;gap:6px;margin:16px 0 0;font-size:12px;line-height:18px;color:var(--sfu-subtle)}",
      ".sfu-foot-note svg{flex:none;margin-top:1px}",
      ".sfu-auth{display:flex;flex-direction:column;align-items:center;gap:12px;padding:4px 0;text-align:center}",
      ".sfu-auth-text{max-width:400px;margin:0;font-size:14px;line-height:22px}",
      ".sfu-auth-sub{margin:0;font-size:12px;line-height:18px;color:var(--sfu-muted)}",
      ".sfu-code{padding:10px 20px;border-radius:var(--sfu-r-lg);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:30px;line-height:40px;font-weight:600;letter-spacing:.14em;user-select:all}",
      ".sfu-result-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%}",
      ".sfu-result-ok{background:color-mix(in srgb,var(--sfu-ok) 12%,transparent);color:var(--sfu-ok)}",
      ".sfu-result-warn{background:color-mix(in srgb,var(--sfu-warn) 12%,transparent);color:var(--sfu-warn)}",
      ".sfu-result-err{background:color-mix(in srgb,var(--sfu-err) 10%,transparent);color:var(--sfu-err)}",
      ".sfu-spinner{display:inline-block;flex:none;width:12px;height:12px;border:2px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:sfu-spin .8s linear infinite}",
      "@keyframes sfu-spin{to{transform:rotate(360deg)}}",
      "@media (prefers-reduced-motion:reduce){.sfu-spinner{animation:none}.sfu-disclosure svg{transition:none}}",
      ".sfu-link{color:var(--sfu-info);font-size:12px;line-height:18px;text-decoration:none}",
      ".sfu-link:hover{text-decoration:underline}",
      ".sfu-text-btn{padding:0;border:0;background:transparent;color:var(--sfu-info);font:inherit;font-size:12px;line-height:18px;cursor:pointer}",
      ".sfu-text-btn:hover{text-decoration:underline}",
      ".sfu-prompt-box{width:100%;min-height:64px;padding:10px 12px;border:0;border-radius:var(--sfu-r-md);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-text);font:inherit;font-size:13px;line-height:20px;resize:none}",
      ".sfu-card{display:flex;align-items:flex-start;gap:12px;margin:16px 0 8px;padding:14px 16px;border-radius:var(--sfu-r-lg);background:var(--sfu-surface);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-text);font-size:13px;line-height:20px}",
      ".sfu-card-icon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--sfu-warn) 12%,transparent);color:var(--sfu-warn)}",
      ".sfu-card-icon-ok{background:color-mix(in srgb,var(--sfu-ok) 12%,transparent);color:var(--sfu-ok)}",
      ".sfu-card-main{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}",
      ".sfu-card-title{margin:0;font-size:14px;line-height:20px;font-weight:500}",
      ".sfu-card-text{margin:0;color:var(--sfu-muted)}",
      ".sfu-card-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:8px}",
      ".sfu-report{display:flex;flex-direction:column;gap:12px;margin:16px 0 8px;padding:14px 16px;border-radius:var(--sfu-r-lg);background:var(--sfu-surface);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-text);font-size:13px;line-height:20px}",
      ".sfu-report-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".sfu-report-pill{flex:none;padding:0 8px;border-radius:999px;background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line-strong);color:var(--sfu-muted);font-size:12px;line-height:20px}",
      ".sfu-report-pill-ok{background:color-mix(in srgb,var(--sfu-ok) 12%,transparent);box-shadow:none;color:var(--sfu-ok)}",
      ".sfu-report-note{margin:0;font-size:12px;line-height:18px;color:var(--sfu-muted)}",
      ".sfu-report-notes{margin:0;padding:8px 10px 8px 26px;border-radius:var(--sfu-r-md);background:color-mix(in srgb,var(--sfu-warn) 10%,transparent);color:var(--sfu-warn);font-size:12px;line-height:18px}",
      ".sfu-report-error{padding:8px 10px;border-radius:var(--sfu-r-md);background:color-mix(in srgb,var(--sfu-err) 10%,transparent);color:var(--sfu-err);font-size:12px;line-height:18px}",
      ".sfu-report-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}",
      ".sfu-report-text{height:auto;min-height:64px;padding:8px 10px;line-height:20px;resize:vertical}",
      ".sfu-report-pill-warn{background:color-mix(in srgb,var(--sfu-warn) 12%,transparent);box-shadow:none;color:var(--sfu-warn)}",
      ".sfu-report-pill-err{background:color-mix(in srgb,var(--sfu-err) 12%,transparent);box-shadow:none;color:var(--sfu-err)}",
      ".sfu-action-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;border-radius:var(--sfu-r-md);background:var(--sfu-raised);box-shadow:inset 0 0 0 var(--sfu-hair) var(--sfu-line)}",
      ".sfu-action-item{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 12px;border-top:var(--sfu-hair) solid var(--sfu-line)}",
      ".sfu-action-item:first-child{border-top:0}",
      ".sfu-action-label{min-width:0;overflow-wrap:anywhere}",
      ".sfu-action-state{flex:none;font-size:12px;color:var(--sfu-muted)}",
      ".sfu-action-state-ok{color:var(--sfu-ok)}",
      ".sfu-action-state-err{color:var(--sfu-err)}",
      ".sfu-settings{max-width:640px;padding:4px 0 12px;color:var(--sfu-text);font-size:13px;line-height:20px}",
      ".sfu-settings-hint{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin:0 0 16px;font-size:12px;line-height:18px;color:var(--sfu-muted)}",
    ].join("\n");

    // "试试这样问" panel: a rounded panel over the plugin's background artwork, glass cards that open a new
    // session with the question, a soft light that follows the pointer and a slow drift of the artwork.
    // Plugin colors and images arrive as --sfx-*-l / --sfx-*-d custom properties (examplesStyle), and
    // body[data-ds-dark-theme] (set by the host app) picks the dark half. Only the active theme's image loads.
    var EXAMPLES_CSS = [
      ".sfx{--sfx-brand:var(--sfx-brand-l);--sfx-on-brand:var(--sfx-on-brand-l);--sfx-glow:var(--sfx-glow-l);--sfx-glow-core:rgba(255,255,255,.75);--sfx-fallback:var(--sfx-fallback-l);--sfx-img:var(--sfx-img-l,none);--sfx-ring:rgba(16,42,67,.07);--sfx-card-bg:rgba(255,255,255,.62);--sfx-card-bg-hover:rgba(255,255,255,.82);--sfx-card-line:rgba(255,255,255,.9);--sfx-card-ring:rgba(16,42,67,.07);--sfx-card-shadow:0 1px 2px rgba(16,42,67,.05),0 8px 24px -14px rgba(16,42,67,.28);--sfx-card-shadow-hover:0 2px 6px rgba(16,42,67,.06),0 18px 36px -16px rgba(16,42,67,.36);--sfx-go-bg:rgba(16,42,67,.06);display:flex;flex-direction:column;gap:12px;color:var(--sfu-text)}",
      "body[data-ds-dark-theme] .sfx{--sfx-brand:var(--sfx-brand-d);--sfx-on-brand:var(--sfx-on-brand-d);--sfx-glow:var(--sfx-glow-d);--sfx-glow-core:rgba(255,255,255,.06);--sfx-fallback:var(--sfx-fallback-d);--sfx-img:var(--sfx-img-d,none);--sfx-ring:rgba(255,255,255,.07);--sfx-card-bg:rgba(20,12,28,.46);--sfx-card-bg-hover:rgba(30,18,40,.6);--sfx-card-line:rgba(255,255,255,.08);--sfx-card-ring:rgba(0,0,0,.3);--sfx-card-shadow:0 1px 2px rgba(0,0,0,.3),0 10px 28px -14px rgba(0,0,0,.7);--sfx-card-shadow-hover:0 2px 6px rgba(0,0,0,.35),0 20px 40px -16px rgba(0,0,0,.8);--sfx-go-bg:rgba(255,255,255,.08)}",
      ".sfx-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}",
      ".sfx-title{margin:0;font-size:14px;line-height:20px;font-weight:500}",
      ".sfx-hint{font-size:12px;line-height:18px;color:var(--sfu-muted)}",
      ".sfx-panel{position:relative;isolation:isolate;overflow:hidden;padding:clamp(20px,5vw,44px) clamp(14px,4.5vw,40px);border-radius:20px;background:var(--sfx-fallback)}",
      ".sfx-panel::after{content:'';position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--sfx-ring);pointer-events:none}",
      ".sfx-bg{position:absolute;inset:0;z-index:-2;overflow:hidden;background:var(--sfx-fallback);pointer-events:none}",
      ".sfx-bg-img{position:absolute;inset:-5%;background-image:var(--sfx-img);background-position:center;background-size:cover;animation:sfx-drift 56s ease-in-out infinite alternate;will-change:transform}",
      "@keyframes sfx-drift{from{transform:translate3d(-1.6%,-1.2%,0) scale(1.02)}to{transform:translate3d(1.6%,1.2%,0) scale(1.07)}}",
      ".sfx-glow{position:absolute;inset:0;z-index:-1;background:radial-gradient(260px circle at var(--sfx-x,50%) var(--sfx-y,50%),var(--sfx-glow-core),transparent 70%),radial-gradient(480px circle at var(--sfx-x,50%) var(--sfx-y,50%),var(--sfx-glow),transparent 72%);opacity:0;transition:opacity .6s ease;pointer-events:none}",
      ".sfx-panel[data-glow] .sfx-glow{opacity:1}",
      ".sfx-list{display:flex;flex-direction:column;gap:10px;max-width:760px;margin:0 auto}",
      ".sfx-card{display:flex;align-items:center;gap:16px;width:100%;min-height:70px;padding:14px 14px 14px 18px;border:1px solid var(--sfx-card-line);border-radius:16px;background:var(--sfx-card-bg);background-clip:padding-box;box-shadow:0 0 0 .5px var(--sfx-card-ring),var(--sfx-card-shadow);-webkit-backdrop-filter:blur(18px) saturate(1.6);backdrop-filter:blur(18px) saturate(1.6);color:var(--sfu-text);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer;transition:translate .32s cubic-bezier(.2,.8,.2,1),scale .2s cubic-bezier(.2,.8,.2,1),background-color .24s ease,box-shadow .32s ease;animation:sfx-rise .64s cubic-bezier(.2,.8,.2,1) backwards;animation-delay:calc(var(--sfx-i,0) * 80ms + 80ms)}",
      "@keyframes sfx-rise{from{opacity:0;transform:translateY(12px)}}",
      ".sfx-card:hover:not(:disabled){translate:0 -2px;background-color:var(--sfx-card-bg-hover);box-shadow:0 0 0 .5px var(--sfx-card-ring),var(--sfx-card-shadow-hover)}",
      ".sfx-card:active:not(:disabled){translate:0 -1px;scale:.985;transition-duration:.12s}",
      ".sfx-card:focus-visible{outline:2px solid var(--sfx-brand);outline-offset:2px}",
      ".sfx-card:disabled{cursor:progress}",
      ".sfx-text{display:-webkit-box;flex:1;min-width:0;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3}",
      ".sfx-mention{display:inline-flex;align-items:center;gap:5px;height:22px;margin-right:6px;vertical-align:bottom;color:var(--sfx-brand);font-weight:600}",
      ".sfx-mention img{flex:none;width:16px;height:16px}",
      ".sfx-go{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;background:var(--sfx-go-bg);color:var(--sfu-muted);transition:background-color .24s ease,color .24s ease}",
      ".sfx-go svg{transition:translate .32s cubic-bezier(.2,.8,.2,1)}",
      ".sfx-card:hover:not(:disabled) .sfx-go,.sfx-card:focus-visible .sfx-go{background:var(--sfx-brand);color:var(--sfx-on-brand)}",
      ".sfx-card:hover:not(:disabled) .sfx-go svg{translate:2px 0}",
      "@media (max-width:560px){.sfx-card{gap:12px;padding:12px 12px 12px 14px;font-size:13px;line-height:20px}.sfx-mention{height:20px}}",
      // Reduced motion: no drift, no pointer light, no entrance or lift; colors still change on hover.
      "@media (prefers-reduced-motion:reduce){.sfx-bg-img{inset:0;animation:none}.sfx-glow{display:none}.sfx-card{animation:none;transition:background-color .24s ease,box-shadow .24s ease}.sfx-card:hover:not(:disabled),.sfx-card:active:not(:disabled){translate:none;scale:none}.sfx-go svg,.sfx-card:hover:not(:disabled) .sfx-go svg{transition:none;translate:none}}",
    ].join("\n");

    // ---- Session event projection (mirrors event-projection.js) ----
    // Per turn: did any tool answer "connect an account first", and which daily-report drafts were staged (and submitted)?
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

    // The tool-result payloads this plugin draws a card for: the auth prompt, the daily-report draft
    // and a pending delete or transfer.
    function isCardKind(kind) { return kind === AUTH_REQUIRED_KIND || kind === REPORT_DRAFT_KIND || kind === ACTION_PENDING_KIND; }
    function extractPayload(value) {
      if (typeof value === "string") {
        // Every tool result is checked, so skip parsing text that cannot carry this plugin's payload.
        if (value.indexOf(AUTH_REQUIRED_KIND) === -1 && value.indexOf(REPORT_DRAFT_KIND) === -1 && value.indexOf(ACTION_PENDING_KIND) === -1) return null;
        try {
          return extractPayload(JSON.parse(value));
        } catch (_) {
          return null;
        }
      }
      if (!value || typeof value !== "object" || isFailedValue(value)) return null;
      if (isCardKind(value.kind)) return value;
      var keys = ["structuredContent", "value", "result", "message"];
      for (var i = 0; i < keys.length; i++) {
        if (value[keys[i]] != null) {
          var found = extractPayload(value[keys[i]]);
          if (found) return found;
        }
      }
      if (Array.isArray(value.content)) {
        for (var j = 0; j < value.content.length; j++) {
          var block = value.content[j];
          if (block && block.type === "text" && typeof block.text === "string") {
            var foundText = extractPayload(block.text);
            if (foundText) return foundText;
          }
        }
      }
      return null;
    }

    function projectionValueOf(state) {
      return {
        turn: state.turn,
        authRequired: state.authRequired,
        reportDrafts: state.reportDrafts,
        submittedByDraftId: state.submittedByDraftId,
        pendingActions: state.pendingActions,
        actionStatusById: state.actionStatusById,
      };
    }

    function refreshProjection(state) {
      var authRequired = null;
      var reportDrafts = [];
      var pendingActions = [];
      state.calls.forEach(function (call, callId) {
        var result = state.results.get(callId);
        if (!result || result.failed || !result.payload) return;
        var p = result.payload;
        if (p.kind === REPORT_DRAFT_KIND) {
          if (typeof p.draftId === "string" && p.draft && typeof p.draft === "object") {
            reportDrafts.push({
              seq: result.seq,
              callId: callId,
              draftId: p.draftId,
              draft: p.draft,
              contacts: Array.isArray(p.contacts) ? p.contacts : [],
              notes: Array.isArray(p.notes) ? p.notes.filter(function (n) { return typeof n === "string" && n; }) : [],
            });
          }
          return;
        }
        if (p.kind === ACTION_PENDING_KIND) {
          if (typeof p.actionId === "string" && Array.isArray(p.items) && p.items.length) {
            pendingActions.push({
              seq: result.seq,
              callId: callId,
              actionId: p.actionId,
              action: p.action === "transfer" ? "transfer" : "delete",
              title: typeof p.title === "string" ? p.title : "",
              typeLabel: typeof p.typeLabel === "string" ? p.typeLabel : "",
              items: p.items.filter(function (it) { return it && typeof it === "object"; }),
              toUser: p.toUser && typeof p.toUser === "object" ? p.toUser : null,
              includeProjects: p.includeProjects === true,
              skipped: Array.isArray(p.skipped) ? p.skipped.filter(function (it) { return it && typeof it === "object"; }) : [],
            });
          }
          return;
        }
        // One auth card per turn: the latest.
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
      });
      reportDrafts.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      pendingActions.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      var submittedByDraftId = {};
      var actionStatusById = {};
      state.records.forEach(function (rec) {
        if (rec.type === ACTION_RECORD_TYPE) {
          if (rec.data && typeof rec.data.actionId === "string" && typeof rec.data.status === "string") {
            actionStatusById[rec.data.actionId] = {
              status: rec.data.status,
              results: Array.isArray(rec.data.results) ? rec.data.results : [],
              transferredCount: rec.data.transferredCount == null ? null : rec.data.transferredCount,
              projectCount: rec.data.projectCount == null ? null : rec.data.projectCount,
            };
          }
          return;
        }
        if (rec.data && typeof rec.data.draftId === "string") {
          var report = rec.data.report;
          submittedByDraftId[rec.data.draftId] = {
            reportId: rec.data.reportId == null ? null : rec.data.reportId,
            report: report && typeof report === "object" && !Array.isArray(report) ? report : null,
          };
        }
      });
      var next = Object.assign({}, state, {
        authRequired: authRequired,
        reportDrafts: reportDrafts,
        submittedByDraftId: submittedByDraftId,
        pendingActions: pendingActions,
        actionStatusById: actionStatusById,
      });
      next.value = projectionValueOf(next);
      return next;
    }

    function initialProjection(turn) {
      var st = {
        turn: turn,
        calls: new Map(),
        results: new Map(),
        records: [],
        invalidated: new Set(),
        replacedRanges: [],
        authRequired: null,
        reportDrafts: [],
        submittedByDraftId: {},
        pendingActions: [],
        actionStatusById: {},
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
          if (withinRanges(call.callSeq, [range]) || (res && withinRanges(res.seq, [range]))) invalidated.add(id);
        });
        var nextCalls = new Map();
        state.calls.forEach(function (v, k) { if (!invalidated.has(k)) nextCalls.set(k, v); });
        var nextResults = new Map();
        state.results.forEach(function (v, k) { if (!invalidated.has(k)) nextResults.set(k, v); });
        return refreshProjection(Object.assign({}, state, {
          calls: nextCalls,
          results: nextResults,
          records: state.records.filter(function (rec) { return !withinRanges(rec.seq, [range]); }),
          invalidated: invalidated,
          replacedRanges: state.replacedRanges.concat([range]),
        }));
      }

      if (isRecordType(event.type)) {
        if (withinRanges(event.seq, state.replacedRanges)) return state;
        for (var r = 0; r < state.records.length; r++) {
          if (state.records[r].seq === event.seq) return state;
        }
        return refreshProjection(Object.assign({}, state, {
          records: state.records.concat([{ seq: event.seq, type: event.type, data: event.data }]),
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
      var payload = failedFlag ? null : extractPayload(event.data);
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
      return connection.rpc.call("/api", "salesforge/" + method, { args: args || {} }, signal);
    }

    function extractRpcError(res, fallback) {
      if (res && res.error) {
        if (typeof res.error === "string") return res.error;
        if (typeof res.error.message === "string" && res.error.message) return res.error.message;
      }
      if (res && typeof res.message === "string" && res.message) return res.message;
      return fallback || "操作失败，请重试。";
    }

    // Resolve one salesforge/* call to its value; a failed result rejects with the host's message.
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

    // ---- Account state (RPC `State`), shared by every surface of the plugin ----
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
      next: ["M4.5 10h11", "M11 5.5l4.5 4.5-4.5 4.5"],
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
      return h("p", { className: "sfu-note sfu-note-" + note.tone, role: note.tone === "err" ? "alert" : "status" }, note.text);
    }

    function resultBlock(tone, iconName, text, sub) {
      return h("div", { className: "sfu-auth", role: "status" },
        h("span", { className: "sfu-result-icon sfu-result-" + tone }, icon(iconName, 22)),
        h("p", { className: "sfu-auth-text" }, text),
        sub ? h("p", { className: "sfu-auth-sub" }, sub) : null,
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
        idRef.current = "sfu-dialog-" + dialogSeq;
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
        className: "sfu sfu-modal" + (props.size === "sm" ? " sfu-modal-sm" : ""),
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
        h("div", { className: "sfu-modal-head" },
          h("h2", { id: idRef.current + "-title", className: "sfu-modal-title" }, props.title),
          h("button", { type: "button", className: "sfu-icon-btn", "aria-label": "关闭", onClick: requestClose }, icon("close")),
        ),
        h("div", { className: "sfu-modal-body" }, props.body),
        props.footer ? h("div", { className: "sfu-modal-foot" }, props.footer) : null,
      );
    }

    function ConfirmDialog(props) {
      var busy = !!props.busy;
      return h(Modal, {
        size: "sm",
        title: props.title,
        onClose: busy ? noop : props.onCancel,
        dismissOnBackdrop: !busy,
        body: h("div", { className: "sfu-stack" },
          h("p", { className: "sfu-confirm-text" }, props.message),
          props.error ? h("p", { className: "sfu-note sfu-note-err", role: "alert" }, props.error) : null,
        ),
        footer: [
          h("button", { key: "cancel", type: "button", className: "sfu-btn sfu-btn-outline", disabled: busy, onClick: props.onCancel }, "取消"),
          h("button", {
            key: "confirm",
            type: "button",
            className: "sfu-btn sfu-btn-primary" + (props.danger ? " sfu-btn-danger" : ""),
            disabled: busy,
            onClick: props.onConfirm,
          }, busy ? "处理中…" : props.confirmLabel),
        ],
      });
    }

    // ---- Browser authorization (startAuthorization → pollAuthorization / cancelAuthorization) ----
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
            throw new Error("销售管理系统没有返回授权请求，请重试。");
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
      var cancelButton = h("button", { key: "cancel", type: "button", className: "sfu-btn sfu-btn-outline", onClick: cancel }, "取消");
      var closeButton = h("button", { key: "close", type: "button", className: "sfu-btn sfu-btn-outline", onClick: finish }, "关闭");
      var retryButton = h("button", { key: "retry", type: "button", className: "sfu-btn sfu-btn-primary", onClick: begin }, "重试");
      var body;
      var footer;

      if (phase === "starting") {
        body = h("div", { className: "sfu-auth", role: "status" },
          props.intro ? h("p", { className: "sfu-auth-text" }, props.intro) : null,
          h("p", { className: "sfu-auth-sub sfu-inline" }, h("span", { className: "sfu-spinner" }), "正在向销售管理系统申请授权…"),
        );
        footer = [cancelButton];
      } else if (phase === "waiting" && request) {
        var verifyUrl = request.verifyUrl;
        var until = formatClock(request.expiresAt);
        var host = hostOf(verifyUrl);
        body = h("div", { className: "sfu-auth", "aria-live": "polite" },
          props.intro ? h("p", { className: "sfu-auth-sub" }, props.intro) : null,
          h("p", { className: "sfu-auth-text" }, "已在浏览器打开销售管理系统授权页，请确认校验码一致后点「授权」"),
          h("div", { className: "sfu-code", "aria-label": "校验码 " + String(request.userCode || "") }, String(request.userCode || "")),
          h("p", { className: "sfu-auth-sub sfu-inline" },
            h("span", { className: "sfu-spinner" }),
            "等待你在浏览器里授权" + (until ? "，校验码 " + until + " 前有效" : ""),
          ),
          isHttpUrl(verifyUrl)
            ? h("a", { className: "sfu-link", href: verifyUrl, target: "_blank", rel: "noopener noreferrer" }, "没有自动打开？点这里打开授权页")
            : null,
          host ? h("p", { className: "sfu-auth-sub" }, "授权页地址：" + host) : null,
        );
        footer = [cancelButton];
      } else if (phase === "approved") {
        body = resultBlock("ok", "check", account ? "已连接：" + fullName(account) : "已连接", props.approvedHint || null);
        footer = [h("button", { key: "done", type: "button", className: "sfu-btn sfu-btn-primary", onClick: finish }, "完成")];
      } else if (phase === "denied") {
        body = resultBlock("err", "cross", "你在销售管理系统里拒绝了这次授权", "如果是误点了拒绝，可以重新发起授权。");
        footer = [closeButton, retryButton];
      } else if (phase === "expired") {
        body = resultBlock("warn", "clock", "授权请求已过期", "校验码有效期内没有完成授权，请重新发起。");
        footer = [closeButton, retryButton];
      } else {
        body = resultBlock("err", "alert", message || "授权没有完成，请重试。");
        footer = [closeButton, retryButton];
      }

      return h(Modal, {
        title: props.title || "连接销售管理系统账户",
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
        body: h("div", { className: "sfu-stack" },
          h("p", { className: "sfu-confirm-text" }, "当前页面不支持直接开始新会话，请手动新建会话后输入："),
          h("textarea", { ref: areaRef, className: "sfu-prompt-box", readOnly: true, rows: 3, value: props.prompt, "aria-label": "试用提示词" }),
          copied === "ok" ? noteBlock({ tone: "ok", text: "已复制。" }) : null,
          copied === "manual" ? noteBlock({ tone: "warn", text: "没能自动复制，文字已选中，按 ⌘C 或 Ctrl+C 复制。" }) : null,
        ),
        footer: [
          h("button", { key: "close", type: "button", className: "sfu-btn sfu-btn-outline", onClick: props.onClose }, "关闭"),
          h("button", { key: "copy", type: "button", className: "sfu-btn sfu-btn-primary", onClick: copy }, "复制"),
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
          intro: "试用前需要先连接销售管理系统账户，连接后会直接打开新会话。",
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
          className: "sfu-icon-btn",
          "aria-label": "更多操作：" + props.label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: props.busy,
          onClick: function () { setOpen(!open); },
        }, props.busy ? h("span", { className: "sfu-spinner" }) : icon("more")),
        open ? h("div", { className: "sfu-menu", role: "menu" },
          h("button", { type: "button", role: "menuitem", className: "sfu-menu-item", disabled: props.isActive, onClick: pick(props.onSetActive) }, "设为当前"),
          h("button", { type: "button", role: "menuitem", className: "sfu-menu-item", onClick: pick(props.onReauthorize) }, "重新授权"),
          h("button", { type: "button", role: "menuitem", className: "sfu-menu-item sfu-menu-danger", onClick: pick(props.onDisconnect) }, "断开连接"),
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
      return h("li", { className: "sfu-account", "data-account-id": String(account.id) },
        h("span", { className: "sfu-avatar" + (status === "ok" ? "" : " sfu-avatar-off"), "aria-hidden": "true" }, name.charAt(0)),
        h("div", { className: "sfu-account-main" },
          h("div", { className: "sfu-account-name" },
            h("span", null, name),
            props.isActive ? h("span", { className: "sfu-tag sfu-tag-neutral" }, "当前使用") : null,
            status === "expired" ? h("span", { className: "sfu-tag sfu-tag-warn" }, "已过期") : null,
            status === "revoked" ? h("span", { className: "sfu-tag sfu-tag-err" }, "已失效") : null,
          ),
          meta ? h("div", { className: "sfu-account-meta", title: meta }, meta) : null,
        ),
        h("div", { className: "sfu-account-side" },
          status === "ok" ? null : h("button", {
            type: "button",
            className: "sfu-btn sfu-btn-outline sfu-btn-sm",
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
      var accounts = Array.isArray(state.accounts) ? state.accounts : [];
      var [serverUrl, setServerUrl] = useState(state.serverUrl || "");
      var [busy, setBusy] = useState(""); // "" | save | test
      var [result, setResult] = useState(null);
      var [serverConfirm, setServerConfirm] = useState(null); // { patch, busy }

      useEffect(function () { setServerUrl(state.serverUrl || ""); }, [state.serverUrl]);

      var patch = {};
      var nextServer = String(serverUrl || "").trim();
      if (nextServer && nextServer !== state.serverUrl) patch.serverUrl = nextServer;
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
        if (!isHttpUrl(patch.serverUrl)) {
          setResult({ tone: "err", text: "服务器地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        if (accounts.length > 0) {
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

      // 测试输入框里的地址（可以还没保存）；输入框为空时测已保存的地址。
      function handleTest() {
        if (busy) return;
        if (nextServer && !isHttpUrl(nextServer)) {
          setResult({ tone: "err", text: "服务器地址需要以 http:// 或 https:// 开头。" });
          return;
        }
        setBusy("test");
        setResult(null);
        callRpc(connection(), "testConnection", { serverUrl: nextServer || state.serverUrl || "" }).then(function (res) {
          setBusy("");
          if (res && res.ok) {
            var who = res.account ? fullName(res.account) : "";
            setResult({ tone: "ok", text: who ? "连接正常，当前账户：" + who : res.message || "连接正常。" });
          } else {
            setResult({ tone: "err", text: (res && res.message) || "连接失败，请检查服务器地址和账户。" });
          }
        }, function (err) {
          setBusy("");
          setResult({ tone: "err", text: errorText(err, "连接测试失败。") });
        });
      }

      return h("div", { className: "sfu-form" },
        h("div", { className: "sfu-field" },
          h("span", { className: "sfu-label" }, "服务器地址"),
          h("input", {
            className: "sfu-input",
            type: "text",
            spellCheck: false,
            "aria-label": "服务器地址",
            placeholder: "http://销售管理系统地址/api/v1",
            value: serverUrl,
            disabled: !!busy,
            onChange: function (e) { setServerUrl(e.target.value); setResult(null); },
          }),
          accounts.length > 0 && patch.serverUrl != null
            ? h("span", { className: "sfu-label" }, "更换服务器地址会断开全部账户。")
            : h("span", { className: "sfu-label" }, "一般以 /api/v1 结尾。"),
        ),
        noteBlock(result),
        h("div", { className: "sfu-row sfu-row-end" },
          h("button", { type: "button", className: "sfu-btn sfu-btn-outline sfu-btn-sm", disabled: !!busy, onClick: handleTest }, busy === "test" ? "测试中…" : "测试连接"),
          h("button", { type: "button", className: "sfu-btn sfu-btn-primary sfu-btn-sm", disabled: !!busy || !dirty, onClick: handleSave }, busy === "save" ? "保存中…" : "保存设置"),
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
          // revoked === false：本地凭据已删，但销售管理系统没确认吊销（网络不通、服务器出错等），提示用户去系统里手动吊销。
          setNotice(next && next.revoked === false
            ? { tone: "warn", text: "已在本机断开 " + fullName(current.account) + "，但销售管理系统没有确认吊销。请登录销售管理系统，在右上角菜单的「插件授权」里手动吊销这台设备。" }
            : { tone: "ok", text: "已断开 " + fullName(current.account) + "。" });
        }, function (err) {
          setConfirm({ account: current.account, busy: false, error: errorText(err, "断开失败，请重试。") });
        });
      }

      var accounts = state && Array.isArray(state.accounts) ? state.accounts : [];
      var activeId = state ? state.activeAccountId : null;
      var listBody;
      if (!state && snap.status === "error") {
        listBody = h("div", { className: "sfu-stack" },
          h("p", { className: "sfu-note sfu-note-err", role: "alert" }, "读取账户失败：" + (snap.error || "未知错误")),
          h("div", null, h("button", {
            type: "button",
            className: "sfu-btn sfu-btn-outline sfu-btn-sm",
            onClick: function () { if (store) store.refresh().catch(noop); },
          }, "重试")),
        );
      } else if (!state) {
        listBody = h("p", { className: "sfu-muted sfu-inline", role: "status" }, h("span", { className: "sfu-spinner" }), "正在读取账户…");
      } else if (!accounts.length) {
        listBody = h("div", { className: "sfu-empty" },
          h("p", null, "还没有连接销售管理系统账户。连接后，销售管理会用你的账号查询客户、项目、日报和销售目标。"),
          h("button", { type: "button", className: "sfu-btn sfu-btn-primary sfu-btn-sm", onClick: function () { setAuth({}); } }, icon("plus", 13), "连接账户"),
        );
      } else {
        listBody = h("div", { className: "sfu-stack" },
          h("ul", { className: "sfu-list", "aria-label": "已连接的账户" },
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
            className: "sfu-btn sfu-btn-outline sfu-btn-sm",
            onClick: function () { setAuth({}); },
          }, icon("plus", 13), "连接另一个账户")),
        );
      }

      var credentialNote = state ? CREDENTIAL_NOTES[state.credentialStore] : "";

      return h("div", { className: "sfu sfu-panel" },
        h("style", null, UI_CSS),
        notice ? h("div", { style: { marginBottom: "12px" } }, noteBlock(notice)) : null,
        h("section", { className: "sfu-section" },
          h("div", { className: "sfu-section-head" },
            h("h3", { className: "sfu-section-title" }, "已连接的账户"),
            accounts.length ? h("span", { className: "sfu-section-hint" }, accounts.length + " 个") : null,
          ),
          listBody,
        ),
        h("section", { className: "sfu-section" },
          h("button", {
            type: "button",
            className: "sfu-disclosure",
            "aria-expanded": settingsOpen,
            onClick: function () { setSettingsOpen(!settingsOpen); },
          }, h("span", null, "服务器设置"), icon("chevron")),
          settingsOpen
            ? (state ? h(SettingsForm, { store: store, services: services, state: state }) : h("p", { className: "sfu-muted" }, "读取到账户信息后才能修改设置。"))
            : null,
        ),
        credentialNote ? h("p", { className: "sfu-foot-note" }, icon("lock", 14), h("span", null, credentialNote)) : null,
        auth ? h(AuthorizeDialog, {
          store: store,
          services: services,
          title: auth.account ? "重新授权" : "连接销售管理系统账户",
          intro: auth.account ? "请在打开的销售管理系统页面里用 " + fullName(auth.account) + " 登录并授权。" : null,
          onClose: function () { setAuth(null); },
          onApproved: function (account) {
            if (account) setNotice({ tone: "ok", text: "已连接：" + fullName(account) + "。" });
          },
        }) : null,
        confirm ? h(ConfirmDialog, {
          title: "断开 " + fullName(confirm.account) + "？",
          message: "断开后会在销售管理系统里吊销这台设备的授权，之后需要重新连接才能使用。",
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
        title: "管理 · 销售管理",
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
      return h("span", { className: "sfu sfu-actions" },
        h("style", null, UI_CSS),
        h("button", {
          type: "button",
          className: "sfu-btn sfu-btn-outline sfu-btn-sm",
          onClick: function () { setManageOpen(true); },
        }, icon("user", 13), "管理"),
        h("button", {
          type: "button",
          className: "sfu-btn sfu-btn-primary sfu-btn-sm",
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
        tag = h("span", { className: "sfu-tag sfu-tag-ok sfu-tag-dot", title: fullName(active) }, "已连接 · " + displayName(active));
      } else if (active) {
        tag = h("span", { className: "sfu-tag sfu-tag-warn", title: fullName(active) }, "授权已失效");
      } else {
        tag = h("span", { className: "sfu-tag sfu-tag-neutral" }, "未连接");
      }
      return h("span", { className: "sfu", style: { display: "inline-flex" } }, h("style", null, UI_CSS), tag);
    }

    // ---- "试试这样问" panel ----
    // The package-asset URL of a file in lib/assets, or null on a host without require.asset (the panel then
    // shows its CSS gradient alone).
    function packageAssetUrl(file) {
      if (typeof require.asset !== "function") return null;
      try {
        var url = require.asset("plugins/" + PACKAGE_NAME + "/assets/" + file);
        return typeof url === "string" && url ? url : null;
      } catch (_) {
        return null;
      }
    }

    function cssUrl(url) {
      return url ? "url(" + JSON.stringify(url) + ")" : "none";
    }

    var EXAMPLES_BACKGROUNDS = EXAMPLES_LOOK.backgrounds.map(packageAssetUrl);

    // Inline custom properties carrying the plugin's look; EXAMPLES_CSS picks the light or dark half.
    function examplesStyle(look, images) {
      return {
        "--sfx-brand-l": look.brand[0], "--sfx-brand-d": look.brand[1],
        "--sfx-on-brand-l": look.onBrand[0], "--sfx-on-brand-d": look.onBrand[1],
        "--sfx-glow-l": look.glow[0], "--sfx-glow-d": look.glow[1],
        "--sfx-fallback-l": look.fallback[0], "--sfx-fallback-d": look.fallback[1],
        "--sfx-img-l": cssUrl(images[0]), "--sfx-img-d": cssUrl(images[1]),
      };
    }

    function prefersReducedMotion(win) {
      try {
        return !!(win && typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
      } catch (_) {
        return false;
      }
    }

    // A soft light that follows a mouse or pen over the panel. Pointer moves only record the position; one
    // animation frame writes it to --sfx-x/--sfx-y, so nothing re-renders. Returns the detach function.
    function attachPointerGlow(el, win) {
      if (!el || typeof el.addEventListener !== "function" || !win || prefersReducedMotion(win)) return noop;
      var raf = typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null;
      var cancel = typeof win.cancelAnimationFrame === "function" ? win.cancelAnimationFrame.bind(win) : noop;
      if (!raf) return noop;
      var frame = 0;
      var clientX = 0;
      var clientY = 0;
      function paint() {
        frame = 0;
        var box = el.getBoundingClientRect();
        el.style.setProperty("--sfx-x", Math.round(clientX - box.left) + "px");
        el.style.setProperty("--sfx-y", Math.round(clientY - box.top) + "px");
      }
      function move(event) {
        if (event.pointerType === "touch") return;
        clientX = event.clientX;
        clientY = event.clientY;
        if (!frame) frame = raf(paint);
      }
      function enter(event) {
        if (event.pointerType === "touch") return;
        move(event);
        el.setAttribute("data-glow", "");
      }
      function leave() {
        el.removeAttribute("data-glow");
      }
      el.addEventListener("pointerenter", enter);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      return function () {
        el.removeEventListener("pointerenter", enter);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerleave", leave);
        if (frame) cancel(frame);
        frame = 0;
      };
    }

    function ExamplesSection(props) {
      var look = EXAMPLES_LOOK;
      var launcher = usePromptLauncher(props.store, props.services);
      var panelRef = useRef(null);
      useEffect(function () {
        return attachPointerGlow(panelRef.current, typeof window === "undefined" ? null : window);
      }, []);
      return h("section", { className: "sfu sfx", "aria-label": "试试这样问", style: examplesStyle(look, EXAMPLES_BACKGROUNDS) },
        h("style", null, UI_CSS),
        h("style", null, EXAMPLES_CSS),
        h("div", { className: "sfx-head" },
          h("h4", { className: "sfx-title" }, "试试这样问"),
          h("span", { className: "sfx-hint" }, "点一下会打开新对话并填好问题，按回车发送"),
        ),
        h("div", { ref: panelRef, className: "sfx-panel" },
          h("div", { className: "sfx-bg", "aria-hidden": "true" }, h("div", { className: "sfx-bg-img" })),
          h("div", { className: "sfx-glow", "aria-hidden": "true" }),
          h("div", { className: "sfx-list" },
            EXAMPLE_PROMPTS.map(function (prompt, index) {
              return h("button", {
                key: prompt,
                type: "button",
                className: "sfx-card",
                style: { "--sfx-i": index },
                disabled: launcher.checking,
                onClick: function () { launcher.launch(prompt); },
              },
                h("span", { className: "sfx-text" },
                  h("span", { className: "sfx-mention" }, h("img", { src: look.icon, alt: "", width: 16, height: 16 }), look.name),
                  prompt,
                ),
                h("span", { className: "sfx-go", "aria-hidden": "true" }, icon("next", 16)),
              );
            }),
          ),
        ),
        launcher.dialogs,
      );
    }

    // ---- 1. Settings Section ("销售管理配置"): the same account panel as "管理" ----
    function SettingsSection(props) {
      var services = props.services;
      return h("div", { className: "sfu sfu-settings" },
        h("style", null, UI_CSS),
        h("p", { className: "sfu-settings-hint" },
          h("span", null, "也可以在插件页的「管理」里管理账户"),
          canOpenPluginPage(services)
            ? h("button", { type: "button", className: "sfu-text-btn", onClick: function () { openPluginPage(services); } }, "打开插件页")
            : null,
        ),
        h(AccountPanel, { store: props.store, services: services, settingsOpen: true }),
      );
    }

    // ---- Auth card: any tool answered "connect an account first" (kind salesforge-auth-required) ----
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
        ? h("button", { type: "button", className: "sfu-text-btn", onClick: function () { openPluginPage(services); } }, "管理账户")
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
        iconNode = h("span", { className: "sfu-card-icon sfu-card-icon-ok" }, icon("check"));
        main = h("div", { className: "sfu-card-main" },
          h("p", { className: "sfu-card-title" }, "已连接：" + (displayName(connected) || "销售管理系统账户") + "，回复「继续」即可"),
          manageLink ? h("div", { className: "sfu-card-actions" }, manageLink) : null,
        );
      } else if (active && active.status === "ok") {
        iconNode = h("span", { className: "sfu-card-icon sfu-card-icon-ok" }, icon("check"));
        main = h("div", { className: "sfu-card-main" },
          h("p", { className: "sfu-card-title" }, AUTH_CARD_TITLES[reason]),
          h("p", { className: "sfu-card-text" }, "现在已连接：" + fullName(active) + "，回复「继续」即可。"),
          h("div", { className: "sfu-card-actions" },
            h("button", { type: "button", className: "sfu-text-btn", onClick: function () { setOpen(true); } }, "连接其他账户"),
            manageLink,
          ),
        );
      } else {
        iconNode = h("span", { className: "sfu-card-icon" }, icon("lock"));
        main = h("div", { className: "sfu-card-main" },
          h("p", { className: "sfu-card-title" }, AUTH_CARD_TITLES[reason]),
          h("p", { className: "sfu-card-text" }, info.message || "需要先连接销售管理系统账户：点「连接账户」，在浏览器里完成授权后，回复「继续」。"),
          h("div", { className: "sfu-card-actions" },
            h("button", {
              type: "button",
              className: "sfu-btn sfu-btn-primary sfu-btn-sm",
              disabled: !services,
              onClick: function () { setOpen(true); },
            }, "连接账户"),
            manageLink,
          ),
        );
      }

      return h("section", { className: "sfu sfu-card", "aria-label": "连接销售管理系统账户", "data-auth-reason": reason },
        h("style", null, UI_CSS),
        iconNode,
        main,
        dialog,
      );
    }

    // ---- Daily report draft card ("工作日报草稿") ----
    function ReportDraftCard(props) {
      var item = props.item || {};
      var draft = item.draft || {};
      var contacts = Array.isArray(item.contacts) ? item.contacts : [];
      var notes = Array.isArray(item.notes) ? item.notes : [];
      var services = props.services;
      function connection() { return serviceOf(services, "connection"); }
      var [form, setForm] = useState(function () {
        // Reopened after submitting: show what was actually submitted, not the first draft.
        var src = props.submitted && props.submitted.report ? Object.assign({}, draft, props.submitted.report) : draft;
        return {
          reportDate: src.reportDate || "",
          contactId: src.contactId != null ? String(src.contactId) : "",
          workPlan: src.workPlan || "",
          workSummary: src.workSummary || "",
        };
      });
      var [submitting, setSubmitting] = useState(false);
      var [error, setError] = useState("");
      var [submitted, setSubmitted] = useState(props.submitted || null);

      useEffect(function () {
        if (props.submitted && !submitted) setSubmitted(props.submitted);
      }, [props.submitted]);

      var readOnly = !!submitted || submitting;
      var idBase = "sfu-report-" + String(item.draftId || "");
      var targetLabel = (draft.targetTypeLabel || (Number(draft.targetType) === 2 ? "渠道" : "客户")) + " · " + (draft.targetName || "");

      function update(field, value) {
        setForm(function (prev) {
          var next = Object.assign({}, prev);
          next[field] = value;
          return next;
        });
      }

      function handleSubmit() {
        if (readOnly) return;
        var date = String(form.reportDate || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          setError("拜访日期请按 YYYY-MM-DD 填写，例如 2026-11-24。");
          return;
        }
        if (!contacts.length) {
          setError("这个" + (Number(draft.targetType) === 2 ? "渠道" : "客户") + "还没有联系人，请先在销售管理系统网页里添加联系人。");
          return;
        }
        if (!form.contactId) {
          setError("请选择拜访人。");
          return;
        }
        var plan = String(form.workPlan || "").trim();
        var summary = String(form.workSummary || "").trim();
        if (!plan || !summary) {
          setError("工作计划和工作总结都要填写。");
          return;
        }
        setSubmitting(true);
        setError("");
        var edited = { reportDate: date, contactId: Number(form.contactId), workPlan: plan, workSummary: summary };
        callRpc(connection(), "submitReportDraft", { draftId: item.draftId, edited: edited }).then(function (value) {
          setSubmitting(false);
          setSubmitted({ reportId: value && value.reportId != null ? value.reportId : null });
        }, function (err) {
          setSubmitting(false);
          setError(errorText(err, "提交失败，请重试。"));
        });
      }

      function field(label, id, control) {
        return h("div", { className: "sfu-field" }, h("label", { className: "sfu-label", htmlFor: id }, label), control);
      }

      return h("section", { className: "sfu sfu-report", "data-report-draft": item.draftId, "aria-label": "工作日报草稿" },
        h("style", null, UI_CSS),
        h("div", { className: "sfu-report-head" },
          h("h3", { className: "sfu-card-title" }, "工作日报草稿"),
          submitted
            ? h("span", { className: "sfu-report-pill sfu-report-pill-ok" }, submitted.reportId != null ? "已提交 · 日报 #" + submitted.reportId : "已提交")
            : h("span", { className: "sfu-report-pill" }, "未提交"),
        ),
        submitted
          ? h("p", { className: "sfu-report-note", role: "status" }, "已以你的名义写入销售管理系统，可以在网页的工作报告里查看。")
          : h("p", { className: "sfu-report-note" }, "核对或修改下面的内容，点「提交日报」后才会写入销售管理系统。"),
        !submitted && notes.length
          ? h("ul", { className: "sfu-report-notes" }, notes.map(function (n, i) { return h("li", { key: String(i) }, n); }))
          : null,
        error ? h("div", { className: "sfu-report-error", role: "alert" }, error) : null,
        h("div", { className: "sfu-report-grid" },
          field("拜访日期", idBase + "-date", h("input", {
            id: idBase + "-date",
            className: "sfu-input",
            type: "text",
            placeholder: "YYYY-MM-DD",
            value: form.reportDate,
            disabled: readOnly,
            onChange: function (e) { update("reportDate", e.target.value); },
          })),
          field("拜访对象", idBase + "-target", h("input", {
            id: idBase + "-target",
            className: "sfu-input",
            type: "text",
            value: targetLabel,
            readOnly: true,
            disabled: true,
          })),
          field("拜访人", idBase + "-contact", contacts.length
            ? h("select", {
              id: idBase + "-contact",
              className: "sfu-input",
              value: form.contactId,
              disabled: readOnly,
              onChange: function (e) { update("contactId", e.target.value); },
            },
            h("option", { value: "" }, "请选择拜访人"),
            contacts.map(function (c) {
              return h("option", { key: String(c.contactId), value: String(c.contactId) }, c.contactName + (c.position ? " - " + c.position : ""));
            }))
            : h("input", { id: idBase + "-contact", className: "sfu-input", type: "text", value: "还没有联系人，请先在网页里添加", readOnly: true, disabled: true })),
        ),
        field("工作总结", idBase + "-summary", h("textarea", {
          id: idBase + "-summary",
          className: "sfu-input sfu-report-text",
          rows: 3,
          maxLength: REPORT_TEXT_MAX,
          value: form.workSummary,
          disabled: readOnly,
          onChange: function (e) { update("workSummary", e.target.value); },
        })),
        field("工作计划", idBase + "-plan", h("textarea", {
          id: idBase + "-plan",
          className: "sfu-input sfu-report-text",
          rows: 3,
          maxLength: REPORT_TEXT_MAX,
          value: form.workPlan,
          disabled: readOnly,
          onChange: function (e) { update("workPlan", e.target.value); },
        })),
        submitted ? null : h("div", { className: "sfu-row sfu-row-end" },
          h("button", {
            type: "button",
            className: "sfu-btn sfu-btn-sm sfu-btn-primary",
            disabled: submitting,
            onClick: handleSubmit,
          }, submitting ? [h("span", { key: "s", className: "sfu-spinner", "aria-hidden": "true" }), "正在提交"] : "提交日报"),
        ),
      );
    }

    // ---- Confirmation card for a delete or transfer ("确认删除" / "确认移交") ----
    // The tool only staged the action; it runs when the user presses the confirm button here.
    function PendingActionCard(props) {
      var item = props.item || {};
      var items = Array.isArray(item.items) ? item.items : [];
      var skipped = Array.isArray(item.skipped) ? item.skipped : [];
      var isTransfer = item.action === "transfer";
      var verb = isTransfer ? "移交" : "删除";
      var services = props.services;
      function connection() { return serviceOf(services, "connection"); }
      var [outcome, setOutcome] = useState(props.outcome || null);
      var [busy, setBusy] = useState("");
      var [error, setError] = useState("");

      useEffect(function () {
        if (props.outcome && !outcome) setOutcome(props.outcome);
      }, [props.outcome]);

      var status = outcome ? outcome.status : "pending";
      var settled = status === "done" || status === "partial" || status === "cancelled";
      var resultById = {};
      (outcome && Array.isArray(outcome.results) ? outcome.results : []).forEach(function (r) {
        if (r && r.id != null) resultById[String(r.id)] = r;
      });

      function confirm() {
        if (busy || settled) return;
        setBusy("confirm");
        setError("");
        callRpc(connection(), "confirmAction", { actionId: item.actionId }).then(function (value) {
          setBusy("");
          var next = value && typeof value === "object" ? value : { status: "done", results: [] };
          setOutcome(next);
          if (next.status === "failed") setError("没有" + verb + "成功，请看每一条的原因。");
        }, function (err) {
          setBusy("");
          setError(errorText(err, verb + "失败，请重试。"));
        });
      }

      function cancel() {
        if (busy || settled) return;
        setBusy("cancel");
        setError("");
        callRpc(connection(), "cancelAction", { actionId: item.actionId }).then(function () {
          setBusy("");
          setOutcome({ status: "cancelled", results: [] });
        }, function (err) {
          setBusy("");
          setError(errorText(err, "取消失败，请重试。"));
        });
      }

      var pill;
      if (status === "done") pill = h("span", { className: "sfu-report-pill sfu-report-pill-ok" }, "已" + verb);
      else if (status === "partial") pill = h("span", { className: "sfu-report-pill sfu-report-pill-warn" }, "部分完成");
      else if (status === "cancelled") pill = h("span", { className: "sfu-report-pill" }, "已取消");
      else if (status === "failed") pill = h("span", { className: "sfu-report-pill sfu-report-pill-err" }, "未" + verb);
      else pill = h("span", { className: "sfu-report-pill" }, "待确认");

      var note;
      if (status === "done" && isTransfer) {
        note = "已移交给" + ((item.toUser && item.toUser.realName) || "接收人") +
          (outcome && outcome.projectCount ? "，一并移交了 " + outcome.projectCount + " 个项目" : "") + "。";
      } else if (status === "done") {
        note = "已从销售管理系统里删除。";
      } else if (status === "partial") {
        note = "有几条没有" + verb + "成功，原因写在每一条后面。";
      } else if (status === "cancelled") {
        note = "已取消，没有" + verb + "任何数据。";
      } else if (isTransfer) {
        note = "下面的" + (item.typeLabel || "数据") + "将移交给「" + ((item.toUser && item.toUser.realName) || "") + "」" +
          (item.includeProjects ? "，并一并移交原负责人在其下跟进中的项目" : "") + "。移交后你可能看不到它们。点「确认移交」后才会执行。";
      } else {
        note = "下面的" + (item.typeLabel || "数据") + "将以你的名义删除，删除后不能在系统里恢复。点「确认删除」后才会执行。";
      }

      function stateOf(entry) {
        var r = resultById[String(entry.id)];
        if (!r) return null;
        return r.ok
          ? h("span", { className: "sfu-action-state sfu-action-state-ok" }, "已" + verb)
          : h("span", { className: "sfu-action-state sfu-action-state-err" }, r.error || (verb + "失败"));
      }

      return h("section", { className: "sfu sfu-report", "data-pending-action": item.actionId, "aria-label": isTransfer ? "确认移交" : "确认删除" },
        h("style", null, UI_CSS),
        h("div", { className: "sfu-report-head" },
          h("h3", { className: "sfu-card-title" }, item.title || (isTransfer ? "确认移交" : "确认删除")),
          pill,
        ),
        h("p", { className: "sfu-report-note", role: settled ? "status" : null }, note),
        error ? h("div", { className: "sfu-report-error", role: "alert" }, error) : null,
        h("ul", { className: "sfu-action-list" }, items.map(function (entry) {
          return h("li", { key: String(entry.id), className: "sfu-action-item" },
            h("span", { className: "sfu-action-label" }, entry.label || String(entry.id)),
            stateOf(entry),
          );
        })),
        !settled && skipped.length
          ? h("ul", { className: "sfu-report-notes" }, skipped.map(function (entry, i) {
            return h("li", { key: "skip-" + i }, "ID " + entry.id + "：" + (entry.reason || "没有放进这张卡片"));
          }))
          : null,
        settled ? null : h("div", { className: "sfu-row sfu-row-end" },
          h("button", {
            type: "button",
            className: "sfu-btn sfu-btn-sm sfu-btn-ghost",
            disabled: !!busy,
            onClick: cancel,
          }, busy === "cancel" ? "正在取消" : "取消"),
          h("button", {
            type: "button",
            className: "sfu-btn sfu-btn-sm sfu-btn-primary sfu-btn-danger",
            disabled: !!busy,
            onClick: confirm,
          }, busy === "confirm"
            ? [h("span", { key: "s", className: "sfu-spinner", "aria-hidden": "true" }), "正在" + verb]
            : (status === "failed" ? "重试" : "确认" + verb)),
        ),
      );
    }

    function TurnTail(props) {
      var turn = props.turn;
      var data = turn && turn.data && typeof turn.data.get === "function" ? turn.data.get(KEY) : null;
      if (!data) return null;
      var authRequired = data.authRequired || null;
      var drafts = Array.isArray(data.reportDrafts) ? data.reportDrafts : [];
      var submittedMap = data.submittedByDraftId || {};
      var actions = Array.isArray(data.pendingActions) ? data.pendingActions : [];
      var actionStatus = data.actionStatusById || {};
      if (!authRequired && !drafts.length && !actions.length) return null;
      var cards = drafts.map(function (item) {
        return h(ReportDraftCard, {
          key: "report-" + item.draftId,
          item: item,
          submitted: submittedMap[item.draftId] || null,
          services: props.services,
        });
      });
      actions.forEach(function (item) {
        cards.push(h(PendingActionCard, {
          key: "action-" + item.actionId,
          item: item,
          outcome: actionStatus[item.actionId] || null,
          services: props.services,
        }));
      });
      if (authRequired) {
        cards.push(h(AuthRequiredCard, {
          key: "auth-" + String(authRequired.callId || ""),
          info: authRequired,
          store: props.store,
          services: props.services,
        }));
      }
      return cards.length === 1 ? cards[0] : h("div", { className: "sfu-tail" }, cards);
    }

    // ---- Cordis Client Plugin Entrypoint ----
    exports.inject = ["slots", "connection", "uiConversation"];
    exports.SettingsSection = SettingsSection;
    exports.TurnTail = TurnTail;
    exports.AccountPanel = AccountPanel;
    exports.AuthorizeDialog = AuthorizeDialog;
    exports.AuthRequiredCard = AuthRequiredCard;
    exports.ReportDraftCard = ReportDraftCard;
    exports.PendingActionCard = PendingActionCard;
    exports.DetailActions = DetailActions;
    exports.DetailBadge = DetailBadge;
    exports.ExamplesSection = ExamplesSection;
    exports.createAccountStore = createAccountStore;
    exports.eventDefinition = eventDefinition;
    exports.TRY_PROMPT = TRY_PROMPT;
    exports.EXAMPLE_PROMPTS = EXAMPLE_PROMPTS;
    exports.EXAMPLES_LOOK = EXAMPLES_LOOK;
    exports.attachPointerGlow = attachPointerGlow;

    exports.apply = function (ctx) {
      // Only ctx.get: Cordis Context proxies throw `cannot get property "<name>" without inject`
      // on direct property reads of services that were not injected.
      var getSvc = function (svcName, targetCtx) {
        var c = targetCtx || ctx;
        if (!c || typeof c.get !== "function") return undefined;
        return c.get(svcName);
      };

      var slots = getSvc("slots");
      if (!slots) return;

      var uiConversation = getSvc("uiConversation");
      var connection = getSvc("connection");
      // uiWorkspace and pluginNavigation are read when a button is clicked, never injected.
      var services = createServices(getSvc, connection);
      var store = createAccountStore(services.connection);

      // 1. settings.section ("销售管理配置")
      slots.inject("settings.section", function () {
        var BoundSettings = function (props) {
          return h(SettingsSection, Object.assign({}, props, { store: store, services: services }));
        };
        return slots.register({
          name: "settings.section",
          id: "salesforge-settings",
          order: 31,
          label: "销售管理配置",
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
      registerDetail("plugins.detail.actions", "salesforge-actions", DetailActions);
      registerDetail("plugins.detail.badge", "salesforge-status", DetailBadge);

      // "试试这样问" goes in this bundle's own cell, right under the README: the host gives that cell no heading
      // or frame and renders it only on this bundle's page. plugins.detail.section would put the panel at the
      // very bottom, after components, versions and source.
      slots.inject("plugins.bundle.config", function () {
        var Examples = function (props) {
          return props && props.view === "page" ? h(ExamplesSection, { store: store, services: services }) : null;
        };
        return slots.register({ name: "plugins.bundle.config", key: PACKAGE_NAME }, Examples);
      });

      // 3. conversation.chat.turnTail ("salesforge-cards") once uiConversation is present
      var registeredTurnTail = false;
      var registerTurnTail = function (convSvc) {
        if (registeredTurnTail || !convSvc || !convSvc.events || typeof convSvc.events.register !== "function") return;
        registeredTurnTail = true;
        convSvc.events.register(eventDefinition);
        slots.inject("conversation.chat.turnTail", function () {
          var ConnectedTurnTail = function (props) {
            return h(TurnTail, Object.assign({}, props, { store: store, services: services }));
          };
          return slots.register({
            name: "conversation.chat.turnTail",
            id: "salesforge-cards",
            order: 26,
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
