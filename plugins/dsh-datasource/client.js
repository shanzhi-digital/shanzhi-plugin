window.__ModuleLoader__.load({
  id: 'dsh-sql',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const engines = [{ id: 'mysql', name: 'MySQL', mark: 'My' }, { id: 'postgres', name: 'PostgreSQL', mark: 'Pg' }, { id: 'sqlite', name: 'SQLite', mark: 'Sq' }];
    const engineOf = (id) => engines.find((item) => item.id === id) || engines[0];
    const blank = (engine = 'mysql') => ({ name: '', description: '', engine, host: '127.0.0.1', port: engine === 'postgres' ? 5432 : 3306, user: '', database: '', file: '', password: '', clearPassword: false });
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const statusNames = { queued: '排队中', dispatching: '正在创建会话', running: '执行中', succeeded: '已完成', partial: '部分完成', failed: '失败', canceled: '已取消', stale: '问题已变化' };
    const relationTypes = { 'one-to-one': '一对一', 'one-to-many': '一对多', 'many-to-one': '多对一', 'many-to-many': '多对多' };
    const selectedQuestions = (questions) => questions.filter((question) => question.selected).map(({ id, text }) => ({ id, text }));
    const isPending = (run) => !['succeeded', 'canceled', 'stale'].includes(run.status) && (['queued', 'running'].includes(run.status) || run.batches.some((batch) => ['queued', 'dispatching', 'running'].includes(batch.status)));
    // Inherit the active Host palette, including theme-pack overrides on body.
    const css = `
.dsh-ds{height:100%;overflow:auto;box-sizing:border-box;padding:30px clamp(22px,3.5vw,48px) 48px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);color-scheme:inherit;font:14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}
.dsh-ds *{box-sizing:border-box}
.dsh-ds .ds-wrap{max-width:1220px;margin:0 auto;min-width:0}
.dsh-ds h1,.dsh-ds h2,.dsh-ds h3,.dsh-ds p{margin:0}
.dsh-ds h1{font-size:22px;font-weight:600}
.dsh-ds h2{font-size:16px;font-weight:600}
.dsh-ds h3{font-size:14px}
.dsh-ds button,.dsh-ds input,.dsh-ds select,.dsh-ds textarea{font:inherit;color-scheme:inherit}
.dsh-ds button{cursor:pointer}
.dsh-ds button:disabled{cursor:default;opacity:.48}
.dsh-ds button:focus-visible,.dsh-ds summary:focus-visible,.dsh-ds tr:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
.dsh-ds input:not([type=checkbox]),.dsh-ds select,.dsh-ds textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:9px 11px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);outline:none}
.dsh-ds input::placeholder,.dsh-ds textarea::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.dsh-ds select option{background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}
.dsh-ds input:focus,.dsh-ds textarea:focus,.dsh-ds select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}
.dsh-ds textarea{resize:vertical;line-height:1.6}
.dsh-ds input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none;margin:0}
.dsh-ds input[type=checkbox]:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
.dsh-ds .ds-header,.dsh-ds .ds-section-head,.dsh-ds .ds-toolbar,.dsh-ds .ds-actions,.dsh-ds .ds-inline{display:flex;align-items:center;gap:12px}
.dsh-ds .ds-header{justify-content:space-between;margin-bottom:25px;align-items:flex-start}
.dsh-ds .ds-section-head{justify-content:space-between;margin-bottom:16px;flex-wrap:wrap}
.dsh-ds .ds-toolbar{justify-content:space-between;flex-wrap:wrap;margin:16px 0}
.dsh-ds .ds-actions{flex-wrap:wrap}
.dsh-ds .ds-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ds .ds-intro{color:var(--dsw-alias-label-secondary);margin-top:6px;font-size:13px}
.dsh-ds .ds-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:8px 15px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap;line-height:1.4}
.dsh-ds .ds-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-button.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ds .ds-button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
.dsh-ds .ds-button.small{padding:5px 10px;font-size:12px}
.dsh-ds .ds-button.danger,.dsh-ds .ds-link.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-ds .ds-button.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
.dsh-ds .ds-link{border:0;background:transparent;padding:3px 0;color:var(--dsw-alias-state-business-primary);text-align:left;line-height:1.5}
.dsh-ds .ds-link:hover:not(:disabled){text-decoration:underline}
.dsh-ds .ds-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:22px 24px;margin-bottom:20px;min-width:0}
.dsh-ds .ds-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsh-ds table{border-collapse:collapse;width:100%;text-align:left;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-ds th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.dsh-ds th,.dsh-ds td{padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle}
.dsh-ds tbody tr:last-child>td{border-bottom:0}
.dsh-ds .ds-source-row{cursor:pointer}
.dsh-ds .ds-source-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-source-name{display:flex;align-items:center;gap:12px;font-weight:500}
.dsh-ds .ds-source-name .ds-link{color:var(--dsw-alias-label-primary);font-weight:500;font-size:14px}
.dsh-ds .ds-logo{width:34px;height:34px;display:flex;align-items:center;justify-content:center;flex:none;border-radius:8px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:12px;font-weight:600}
.dsh-ds .ds-cell-actions{width:155px;white-space:nowrap}
.dsh-ds .ds-cell-actions .ds-link+.ds-link{margin-left:18px}
.dsh-ds .ds-empty{padding:64px 24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:14px}
.dsh-ds .ds-notice{padding:11px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);border-radius:8px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);margin-bottom:17px;font-size:13px;overflow-wrap:anywhere}
.dsh-ds .ds-notice.error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-ds .ds-notice.success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:var(--dsw-alias-state-success-tertiary)}
.dsh-ds .ds-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:2px 7px;font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);vertical-align:middle}
.dsh-ds .ds-tag.running,.dsh-ds .ds-tag.queued,.dsh-ds .ds-tag.dispatching{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-business-tertiary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.dsh-ds .ds-tag.succeeded{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-success-tertiary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.dsh-ds .ds-tag.failed,.dsh-ds .ds-tag.partial,.dsh-ds .ds-tag.stale{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-warn-tertiary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dsh-ds .ds-back{margin:0 0 18px}
.dsh-ds .ds-heading-meta{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:7px;overflow-wrap:anywhere}
.dsh-ds .ds-step+.ds-step{border-left:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-tabs{display:flex;gap:28px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:22px}
.dsh-ds .ds-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 0 13px;font-size:14px;border-bottom:2px solid transparent;display:flex;align-items:center;gap:8px}
.dsh-ds .ds-tab.is-active{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-text)}
.dsh-ds .ds-count{font-size:11px;line-height:19px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-composer textarea{margin:13px 0 12px;min-height:112px}
.dsh-ds .ds-check{display:inline-flex;align-items:center;gap:8px;font-size:12px}
.dsh-ds .ds-question-text{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}
.dsh-ds .ds-question-text textarea{min-height:65px;display:block;margin-bottom:6px}
.dsh-ds .ds-question-kind{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-ds .ds-question-kind.expanded{color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-question-selected{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-selection-cell{width:45px;padding-right:6px}
.dsh-ds .ds-number-cell{width:40px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ds .ds-question-actions{white-space:nowrap;width:100px}
.dsh-ds .ds-question-actions .ds-link+.ds-link{margin-left:12px}
.dsh-ds .ds-filter{display:flex;gap:5px;flex-wrap:wrap}
.dsh-ds .ds-filter button{border:0;background:transparent;padding:5px 10px;border-radius:5px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ds .ds-filter button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-filter button.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-brand-text)}
.dsh-ds .ds-search{max-width:260px}
.dsh-ds .ds-summary{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-warning{color:var(--dsw-alias-label-primary);font-size:12px;border-left:3px solid var(--dsw-alias-state-warn-primary);padding-left:8px}
.dsh-ds .ds-error-text{color:var(--dsw-alias-label-primary);border-left:3px solid var(--dsw-alias-state-error-primary);padding-left:8px;font-size:12px;margin-top:5px;overflow-wrap:anywhere}
.dsh-ds .ds-session-id{font:11px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-table-card{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;margin-bottom:12px;overflow:hidden}
.dsh-ds .ds-table-card.is-selected{border-color:var(--dsw-alias-border-l4)}
.dsh-ds .ds-table-title{display:flex;align-items:center;gap:11px;padding:16px 18px;background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-table-meta{flex:1;min-width:0}
.dsh-ds .ds-table-title strong{font-size:13px;overflow-wrap:anywhere}
.dsh-ds .ds-table-title p{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:3px}
.dsh-ds .ds-fields-details summary{padding:10px 18px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-fields-details td,.dsh-ds .ds-fields-details th{padding:9px 18px;font-size:12px}
.dsh-ds .ds-relation{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:17px 18px;margin-bottom:12px;min-width:0}
.dsh-ds .ds-relation.is-selected{border-color:var(--dsw-alias-border-l4)}
.dsh-ds .ds-relation-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:13px}
.dsh-ds .ds-relation-endpoints{display:grid;grid-template-columns:minmax(0,1fr) 30px minmax(0,1fr);gap:10px;align-items:start}
.dsh-ds .ds-relation-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:9px;min-width:0}
.dsh-ds .ds-small-label{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.dsh-ds .ds-relation-side select{font-size:12px;padding:7px}
.dsh-ds .ds-arrow{font-size:20px;color:var(--dsw-alias-label-secondary);text-align:center;margin-top:21px}
.dsh-ds .ds-relation-extra{display:grid;grid-template-columns:160px minmax(0,1fr);gap:12px;margin-top:13px}
.dsh-ds .ds-relation-extra input,.dsh-ds .ds-relation-extra select{font-size:12px;padding:7px 9px}
.dsh-ds .ds-relation-sources{border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px;margin-top:14px;font-size:12px;overflow-wrap:anywhere}
.dsh-ds .ds-relation-sources ul{padding-left:20px;color:var(--dsw-alias-label-secondary);margin:5px 0 10px}
.dsh-ds .ds-relation-review{padding:10px 12px;background:var(--dsw-alias-state-warn-tertiary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);border-radius:7px;margin-top:10px}
.dsh-ds .ds-confirm-bar{display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap;padding-top:18px;margin-top:18px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-modal{width:min(620px,calc(100vw - 64px));max-height:calc(100vh - 70px);overflow:auto;border:1px solid var(--dsw-alias-border-l4);border-radius:13px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0;box-shadow:0 20px 80px rgb(0 0 0 / .24)}
/* Native dialog backdrops do not inherit body custom properties. */
.dsh-ds .ds-modal::backdrop{background:rgb(0 0 0 / .45);backdrop-filter:blur(2px)}
.dsh-ds .ds-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:22px 25px 17px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-modal-head h2{font-size:17px}
.dsh-ds .ds-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:24px;line-height:1;padding:1px 3px}
.dsh-ds .ds-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-modal-body{padding:22px 25px}
.dsh-ds .ds-form-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.dsh-ds .ds-field{display:block;min-width:0}
.dsh-ds .ds-field.wide{grid-column:1/-1}
.dsh-ds .ds-field>span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:7px}
.dsh-ds .ds-field small{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6;margin-top:5px}
.dsh-ds .ds-modal fieldset{padding:0;margin:0;border:0;min-width:0}
.dsh-ds .ds-modal-foot{border-top:1px solid var(--dsw-alias-border-l2);padding:16px 25px;display:flex;justify-content:space-between;gap:15px;align-items:center}
.dsh-ds .ds-delete-body{font-size:13px;line-height:1.8;overflow-wrap:anywhere}
.dsh-ds .ds-space-top{margin-top:14px}
.dsh-ds .ds-source-table{table-layout:fixed}
.dsh-ds .ds-source-table th:first-child{width:260px}
.dsh-ds .ds-source-table th:nth-child(2){width:150px}
.dsh-ds .ds-source-table .ds-cell-actions{width:auto;text-align:right}
.dsh-ds .ds-source-table .ds-source-name{min-width:0}
.dsh-ds .ds-source-table .ds-source-name .ds-link{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ds .ds-subtabs{display:flex;gap:4px;width:fit-content;padding:4px;margin-bottom:26px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}
.dsh-ds .ds-subtab{border:1px solid transparent;border-radius:6px;padding:7px 18px;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-subtab.is-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-ds .ds-subtab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-question-filters{display:flex;gap:10px;max-width:520px;flex:1}
.dsh-ds .ds-question-filters select{width:150px;flex:none}
.dsh-ds .ds-question-tools{margin-bottom:18px;flex-wrap:wrap}
.dsh-ds .ds-question-table th,.dsh-ds .ds-question-table td{padding-top:16px;padding-bottom:16px}
.dsh-ds .ds-question-actions{text-align:right;white-space:nowrap}
.dsh-ds .ds-question-actions .ds-link+.ds-link{margin-left:16px}
.dsh-ds .ds-task-status{padding:14px 18px;margin-bottom:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:13px}
.dsh-ds .ds-task-summary{display:flex;justify-content:space-between;gap:18px;align-items:center;flex-wrap:wrap}
.dsh-ds .ds-task-summary .ds-actions{flex-wrap:wrap}
.dsh-ds .ds-session-select{width:auto;max-width:220px;padding:5px 9px}
.dsh-ds .ds-task-error{margin-top:10px}
.dsh-ds .ds-task-error summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-task-error .ds-error-text{max-height:140px;overflow:auto;margin-top:8px}
.dsh-ds .ds-compose-settings{margin-top:18px;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-compose-settings summary{cursor:pointer;font-size:13px}
.dsh-ds .ds-compose-settings label{display:block;max-width:580px;margin-top:12px;font-size:13px}
.dsh-ds .ds-compose-settings input{display:block;margin-top:6px}
@media(max-width:1450px){.dsh-ds{padding:24px 22px 40px}.dsh-ds .ds-card{padding:20px}.dsh-ds th,.dsh-ds td{padding:12px 14px}.dsh-ds .ds-relation-side{gap:7px}}
    `;
    async function api(operation, input, signal) {
      const response = await fetch(`/api/datasources/${operation}`, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal, ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
      let value;
      try { value = await response.json(); } catch { throw new Error('无法读取数据源服务的响应，请稍后重试。'); }
      if (!response.ok) { const error = new Error(typeof value?.error === 'string' ? value.error : '操作失败，请稍后重试。'); error.status = response.status; throw error; }
      return value;
    }
    const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'ds-button', onClick, ...props }, label);
    const tag = (status) => h('span', { className: `ds-tag ${status}` }, statusNames[status] || status);
    const noticeView = (notice) => notice && h('div', { className: `ds-notice ${notice.type || ''}`, role: notice.type === 'error' ? 'alert' : 'status' }, notice.text);
    function DatabaseIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, 'aria-hidden': true }, h('ellipse', { cx: 12, cy: 5.2, rx: 7.4, ry: 3 }), h('path', { d: 'M4.6 5.2v13.6c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3V5.2M4.6 12c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3' }));
    }
    function ConnectionDialog({ item, onClose, onSaved }) {
      const [draft, setDraft] = React.useState(() => item ? { ...blank(item.engine), ...item, password: '', clearPassword: false } : blank());
      const [busy, setBusy] = React.useState(''), [notice, setNotice] = React.useState(null);
      const dialog = React.useRef(null), form = React.useRef(null), lifetime = React.useRef(null), writing = React.useRef(false);
      React.useEffect(() => { const controller = new AbortController(); lifetime.current = controller; dialog.current?.showModal(); return () => { controller.abort(); lifetime.current = null; dialog.current?.close(); }; }, []);
      const change = (key, value) => { setDraft((current) => key === 'engine' ? { ...current, engine: value, port: value === 'postgres' ? 5432 : 3306, password: '', clearPassword: false } : { ...current, [key]: value, ...(key === 'password' && value ? { clearPassword: false } : {}), ...(key === 'clearPassword' && value ? { password: '' } : {}) }); setNotice(null); };
      const execute = async (action) => {
        if (writing.current || !form.current?.reportValidity()) return;
        writing.current = true; setBusy(action); setNotice(null);
        const signal = lifetime.current.signal;
        const payload = { ...(draft.id ? { id: draft.id } : {}), name: draft.name, description: draft.description || '', engine: draft.engine, ...(draft.engine === 'sqlite' ? { file: draft.file } : { host: draft.host, port: Number(draft.port), user: draft.user, database: draft.database, password: draft.password, clearPassword: !!draft.clearPassword }) };
        try { const result = await api(action, payload, signal); if (signal.aborted) return; if (action === 'save') { setDraft((value) => ({ ...value, password: '' })); onSaved(result.item); } else setNotice({ type: result.ok ? 'success' : 'error', text: result.message || (result.ok ? '连接成功。' : '连接失败，请检查配置。') }); }
        catch (error) { if (!signal.aborted) setNotice({ type: 'error', text: error.message }); }
        finally { writing.current = false; if (!signal.aborted) setBusy(''); }
      };
      const field = (key, label, options = {}) => { const { wide, help, ...input } = options; return h('label', { className: `ds-field${wide ? ' wide' : ''}`, key }, h('span', null, label), h('input', { 'aria-label': label, value: draft[key] ?? '', onChange: (event) => change(key, event.target.value), autoComplete: key === 'password' ? 'new-password' : 'off', ...input }), help && h('small', null, help)); };
      return h('dialog', { ref: dialog, className: 'ds-modal', 'aria-labelledby': 'ds-connection-title', 'data-testid': 'connection-modal', onCancel: (event) => { event.preventDefault(); if (!writing.current) onClose(); } },
        h('form', { ref: form, onSubmit: (event) => { event.preventDefault(); void execute('save'); } },
          h('div', { className: 'ds-modal-head' }, h('h2', { id: 'ds-connection-title' }, item ? '编辑数据源连接' : '创建数据源连接'), button('×', onClose, { className: 'ds-close', disabled: !!busy, 'aria-label': '关闭连接弹框' })),
          h('div', { className: 'ds-modal-body' }, noticeView(notice), h('fieldset', { disabled: !!busy }, h('div', { className: 'ds-form-fields' },
            h('label', { className: 'ds-field wide' }, h('span', null, '数据源类型'), h('select', { 'aria-label': '数据源类型', value: draft.engine, onChange: (event) => change('engine', event.target.value) }, engines.map((engine) => h('option', { key: engine.id, value: engine.id }, engine.name)))),
            field('name', '数据源名称', { required: true, wide: true, maxLength: 80, placeholder: '给这个连接起个名字', autoFocus: true }), field('description', '描述', { wide: true, maxLength: 500, placeholder: '选填' }),
            ...(draft.engine === 'sqlite' ? [field('file', '数据库文件路径', { required: true, wide: true, placeholder: '本机已有 SQLite 文件的绝对路径' })] : [field('host', '主机地址 / IP', { required: true }), field('port', '端口', { required: true, type: 'number', min: 1, max: 65535 }), field('database', '数据库名称', { required: true }), field('user', '用户名', { required: true }), field('password', '密码', { type: 'password', wide: true, placeholder: draft.hasPassword ? '留空保留已保存的密码' : '输入数据库密码', help: draft.hasPassword ? '留空保留；填写新密码可替换。' : '密码保存在 DSH 凭据存储中。' }), draft.hasPassword && h('label', { key: 'clearPassword', className: 'ds-check', style: { gridColumn: '1 / -1' } }, h('input', { type: 'checkbox', checked: !!draft.clearPassword, onChange: (event) => change('clearPassword', event.target.checked) }), '清除已保存的密码') ])))),
          h('div', { className: 'ds-modal-foot' }, button(busy === 'test' ? '正在测试…' : '测试连接', () => void execute('test'), { disabled: !!busy }), h('div', { className: 'ds-actions' }, button('取消', onClose, { disabled: !!busy }), h('button', { className: 'ds-button primary', type: 'submit', disabled: !!busy }, busy === 'save' ? '正在保存…' : '保存连接')))));
    }
    function DeleteDialog({ item, onClose, onRemoved }) {
      const dialog = React.useRef(null), lifetime = React.useRef(null), writing = React.useRef(false);
      const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(null);
      React.useEffect(() => { const controller = new AbortController(); lifetime.current = controller; dialog.current?.showModal(); return () => { controller.abort(); dialog.current?.close(); }; }, []);
      const remove = async () => { if (writing.current) return; writing.current = true; setBusy(true); setNotice(null); const signal = lifetime.current.signal; try { await api('remove', { id: item.id }, signal); if (!signal.aborted) onRemoved(item.id); } catch (error) { if (!signal.aborted) setNotice({ type: 'error', text: error.message }); } finally { writing.current = false; if (!signal.aborted) setBusy(false); } };
      return h('dialog', { ref: dialog, className: 'ds-modal', 'aria-labelledby': 'ds-delete-title', onCancel: (event) => { event.preventDefault(); if (!writing.current) onClose(); } }, h('div', { className: 'ds-modal-head' }, h('h2', { id: 'ds-delete-title' }, '删除数据源连接'), button('×', onClose, { className: 'ds-close', disabled: busy, 'aria-label': '关闭删除弹框' })), h('div', { className: 'ds-modal-body ds-delete-body' }, noticeView(notice), h('p', null, `确定删除「${item.name}」的连接配置吗？`), h('p', { className: 'ds-muted ds-space-top' }, '正在执行的任务将由后台终止。')), h('div', { className: 'ds-modal-foot' }, h('span'), h('div', { className: 'ds-actions' }, button('取消', onClose, { disabled: busy }), button(busy ? '正在删除…' : '删除连接', () => void remove(), { className: 'ds-button danger', disabled: busy }))));
    }
    function RunStatus({ runs, busy, act, openSession, onTables, onRelations }) {
      const run = runs[runs.length - 1];
      if (!run) return null;
      const analysis = run.kind === 'range', pending = isPending(run);
      const failed = run.batches.find((batch) => batch.status === 'failed');
      const canRetry = !!failed && ['failed', 'partial'].includes(run.status) && !run.batches.some((batch) => ['running', 'dispatching'].includes(batch.status));
      const sessions = [...new Set(run.batches.map((batch) => batch.sessionId).filter(Boolean))];
      const messages = analysis
        ? { queued: '正在分析问题，完成后将自动显示数据表。', running: '正在分析问题，完成后将自动显示数据表。', succeeded: '分析已完成，可以查看数据表与关联关系。', partial: '分析尚未完成，已完成的内容会保留。', failed: '分析未完成，请重试或在会话中查看原因。', canceled: '分析已取消。', stale: '问题已修改，请按当前清单重新确认分析。' }
        : { queued: '正在整理问题，完成后将自动更新列表。', running: '正在整理问题，完成后将自动更新列表。', succeeded: '问题列表已更新，请选择需要分析的问题。', partial: '问题整理尚未完成。', failed: '问题整理未完成，请重试或在会话中查看原因。', canceled: '问题整理已取消。', stale: '问题整理已失效。' };
      return h('aside', { className: 'ds-task-status', 'aria-label': '后台分析状态', 'data-run-id': run.id },
        h('div', { className: 'ds-task-summary' }, h('p', { role: 'status' }, messages[run.status] || statusNames[run.status]),
          h('div', { className: 'ds-actions' },
            analysis && run.status === 'succeeded' && button('查看数据表', onTables, { className: 'ds-link' }),
            analysis && run.status === 'succeeded' && button('查看关联关系', onRelations, { className: 'ds-link' }),
            canRetry && button(analysis ? '重试分析' : '重试整理', () => void act('retry', { runId: run.id, batchId: failed.id }), { className: 'ds-button small', disabled: !!busy }),
            pending && button('取消任务', () => void act('cancel', { runId: run.id }), { className: 'ds-link', disabled: !!busy }),
            sessions.length === 1 && button('查看会话', () => openSession(sessions[0]), { className: 'ds-link' }),
            sessions.length > 1 && h('select', { className: 'ds-session-select', value: '', 'aria-label': '查看后台会话', onChange: (event) => { if (event.target.value) openSession(event.target.value); } }, h('option', { value: '' }, '查看后台会话'), sessions.map((id, index) => h('option', { value: id, key: id }, '会话 ' + (index + 1)))))),
        failed?.error && h('details', { className: 'ds-task-error' }, h('summary', null, '查看错误信息'), h('p', { className: 'ds-error-text' }, failed.error)));
    }
    function FlowDetail({ item, onBack, onEdit, openSession: openWorkspaceSession }) {
      const [tab, setTab] = React.useState('questions'), [flow, setFlow] = React.useState(null), [loading, setLoading] = React.useState(true);
      const [notice, setNotice] = React.useState(null), [busy, setBusy] = React.useState(''), [input, setInput] = React.useState(''), [cwd, setCwd] = React.useState('');
      const [questions, setQuestions] = React.useState([]), [tables, setTables] = React.useState([]), [relations, setRelations] = React.useState([]);
      const [dirty, setDirty] = React.useState({ questions: false, tables: false, relations: false });
      const [editingQuestion, setEditingQuestion] = React.useState(null), [questionFilter, setQuestionFilter] = React.useState('all'), [search, setSearch] = React.useState('');
      const [questionPage, setQuestionPage] = React.useState('list');
      const confirming = React.useRef(false), watchedRange = React.useRef(null);
      const stateRef = React.useRef(null), dirtyRef = React.useRef({ questions: false, tables: false, relations: false });
      const alive = React.useRef(false), writing = React.useRef(false), controllers = React.useRef(new Set()), draftSequence = React.useRef(0), analysisRef = React.useRef(null), focusAnalysis = React.useRef(false);
      const markDirty = (kind, value = true) => { dirtyRef.current = { ...dirtyRef.current, [kind]: value }; setDirty({ ...dirtyRef.current }); };
      const applyState = (value) => {
        if (!alive.current) return;
        if (!value || value.id !== item.id || !Number.isInteger(value.revision)) throw new Error('数据源流程响应不完整，请重试。');
        if (stateRef.current && value.revision < stateRef.current.revision) return;
        const next = { ...value, questions: value.questions || [], tables: value.tables || [], relations: value.relations || [], runs: value.runs || [], confirmations: value.confirmations || { tables: false, relations: false } };
        if (!stateRef.current) watchedRange.current = [...next.runs].reverse().find((run) => run.kind === 'range' && isPending(run))?.id || null;
        stateRef.current = next; setFlow(next);
        if (!dirtyRef.current.questions) setQuestions(copy(next.questions));
        if (!dirtyRef.current.tables) setTables(copy(next.tables));
        if (!dirtyRef.current.relations) setRelations(copy(next.relations));
      };
      const readState = async () => { const controller = new AbortController(); controllers.current.add(controller); try { const result = await api('flow-state', { id: item.id }, controller.signal); if (alive.current && !controller.signal.aborted) applyState(result.state); } finally { controllers.current.delete(controller); } };
      React.useEffect(() => {
        alive.current = true; let stopped = false, timer;
        const poll = async () => { try { await readState(); } catch (error) { if (!stopped && error.name !== 'AbortError') setNotice({ type: 'error', text: error.message }); } finally { if (!stopped) { setLoading(false); timer = window.setTimeout(poll, 2000); } } };
        void poll();
        return () => { stopped = true; alive.current = false; window.clearTimeout(timer); for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
      }, [item.id]);
      React.useEffect(() => { if (tab === 'questions' && questionPage === 'list' && focusAnalysis.current) { focusAnalysis.current = false; analysisRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); analysisRef.current?.focus({ preventScroll: true }); } }, [tab, questionPage]);
      React.useEffect(() => {
        const run = flow?.runs.find((candidate) => candidate.id === watchedRange.current);
        if (!run || isPending(run)) return;
        const latestRange = [...flow.runs].reverse().find((candidate) => candidate.kind === 'range');
        if (run.kind === 'range' && run.id === latestRange?.id && run.status === 'succeeded' && flow.rangeCurrent && !dirtyRef.current.tables && !dirtyRef.current.relations) setTab('tables');
        watchedRange.current = null;
      }, [flow]);
      const act = async (action, payload = {}) => {
        if (!alive.current || writing.current || !stateRef.current) return false;
        writing.current = true; setBusy(action); setNotice(null);
        const controller = new AbortController(); controllers.current.add(controller);
        try {
          if (['organize', 'analyze'].includes(action) && cwd.trim() && !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(cwd.trim())) throw new Error('执行工作区请填写绝对路径。');
          const result = await api('flow-action', { id: item.id, revision: stateRef.current.revision, action, ...payload, ...(['organize', 'analyze'].includes(action) && cwd.trim() ? { cwd: cwd.trim() } : {}) }, controller.signal);
          if (!alive.current || controller.signal.aborted) return false;
          const kind = { 'save-questions': 'questions', 'save-tables': 'tables', 'save-relations': 'relations' }[action];
          if (kind) markDirty(kind, false);
          applyState(result.state);
          if (action === 'organize') { setInput(''); setQuestionPage('list'); setNotice({ type: 'success', text: '问题已提交，整理完成后会自动更新列表。' }); }
          else if (action.startsWith('save-')) setNotice({ type: 'success', text: '修改已保存。' });
          else if (action.startsWith('confirm-')) setNotice({ type: 'success', text: action === 'confirm-tables' ? '已确认本轮表范围，请继续确认关联关系。' : '本轮表范围与关联关系已分别确认。' });
          else if (action === 'review-relation') setNotice({ type: 'success', text: '已复核本轮问题依据，表和字段修改已保留。' });
          else if (action === 'analyze') { watchedRange.current = [...result.state.runs].reverse().find((run) => run.kind === 'range')?.id || null; setNotice({ type: 'success', text: '已开始分析，完成后将自动显示数据表；详细过程可在会话中查看。' }); }
          else if (action === 'cancel') setNotice({ type: 'success', text: '已提交取消任务。' });
          else if (action === 'retry') { const run = result.state.runs.find((candidate) => candidate.id === payload.runId); watchedRange.current = run?.kind === 'range' ? run.id : null; setNotice({ type: 'success', text: run?.kind === 'range' ? '已重试失败的分析，已完成的结果会保留。' : '已重试问题整理。' }); }
          return true;
        } catch (error) {
          if (alive.current && !controller.signal.aborted) { setNotice({ type: 'error', text: error.status === 409 ? `${error.message} 已回读最新状态，未保存的修改仍保留，请核对后重试。` : error.message }); try { await readState(); } catch { /* Keep the write error and local drafts. */ } }
          return false;
        } finally { controllers.current.delete(controller); writing.current = false; if (alive.current && !controller.signal.aborted) setBusy(''); }
      };
      const openSession = (id) => { try { if (openWorkspaceSession(id)) return; } catch { /* Keep the session id available when navigation is unavailable. */ } setNotice({ type: 'info', text: `当前界面无法直接打开该会话，请在会话列表中查看。会话 ID：${id}` }); };
      const updateQuestion = (id, changes) => { markDirty('questions'); setQuestions((current) => current.map((question) => question.id === id ? { ...question, ...changes } : question)); };
      const updateTable = (id, changes) => { markDirty('tables'); setTables((current) => current.map((table) => table.id === id ? { ...table, ...changes } : table)); };
      const updateRelation = (id, changes) => { markDirty('relations'); setRelations((current) => current.map((relation) => relation.id === id ? { ...relation, ...changes } : relation)); };
      const questionTaskPending = !!flow?.runs.some((run) => run.kind === 'questions' && isPending(run));
      const rangeTaskPending = !!flow?.runs.some((run) => run.kind === 'range' && isPending(run));
      const questionLocked = !!busy || questionTaskPending || rangeTaskPending;
      const selectedCount = selectedQuestions(questions).length;
      const selectedTables = tables.filter((table) => table.selected), selectedRelations = relations.filter((relation) => relation.selected);
      const needsReview = selectedRelations.some((relation) => relation.needsSourceReview);
      const showAnalysis = () => { setTab('questions'); setQuestionPage('list'); focusAnalysis.current = true; if (tab === 'questions' && questionPage === 'list') { focusAnalysis.current = false; analysisRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); analysisRef.current?.focus({ preventScroll: true }); } };
      const saveQuestions = async () => {
        if (questions.some((question) => !question.text.trim())) { setNotice({ type: 'error', text: '问题正文不能为空，请填写或删除空白问题。' }); return false; }
        const ok = await act('save-questions', { questions: questions.map((question) => ({ ...(question.id.startsWith('draft-') ? {} : { id: question.id }), text: question.text.trim(), kind: question.kind, selected: !!question.selected })) });
        if (ok) setEditingQuestion(null);
        return ok;
      };
      const startAnalysis = async () => {
        if (confirming.current || writing.current || questionTaskPending || rangeTaskPending || !selectedCount) return;
        confirming.current = true;
        try {
          if (dirtyRef.current.questions && !await saveQuestions()) return;
          if (!alive.current || dirtyRef.current.questions) return;
          await act('analyze', { batchSize: 5 });
        } finally { confirming.current = false; }
      };
      const addManualQuestions = () => {
        const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!lines.length || questionLocked) return;
        markDirty('questions');
        setQuestions((current) => [...current, ...lines.map((text) => ({ id: 'draft-' + (++draftSequence.current), text, kind: 'original', selected: true }))]);
        setInput(''); setQuestionPage('list');
      };
      const runList = flow && h(RunStatus, { runs: flow.runs, busy, act, openSession, onTables: () => setTab('tables'), onRelations: () => setTab('relations') });
      let body = null;
      if (flow && tab === 'questions') {
        const visible = questions.filter((question) => (questionFilter === 'all' || questionFilter === 'selected' && question.selected || question.kind === questionFilter) && question.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
        const questionRows = visible.map((question) => h('tr', { key: question.id, className: question.selected ? 'ds-question-selected' : '' },
          h('td', { className: 'ds-selection-cell' }, h('input', { type: 'checkbox', checked: !!question.selected, disabled: questionLocked, onChange: (event) => updateQuestion(question.id, { selected: event.target.checked }), 'aria-label': '选择问题：' + (question.text || '新问题') })), h('td', { className: 'ds-number-cell' }, questions.indexOf(question) + 1),
          h('td', { className: 'ds-question-text' }, editingQuestion === question.id ? h(React.Fragment, null, h('textarea', { value: question.text, rows: 3, disabled: questionLocked, autoFocus: true, 'aria-label': '问题正文', onChange: (event) => updateQuestion(question.id, { text: event.target.value }) }), button('完成编辑', () => setEditingQuestion(null), { className: 'ds-link', disabled: questionLocked })) : question.text || h('span', { className: 'ds-muted' }, '请填写问题')),
          h('td', null, h('span', { className: 'ds-question-kind ' + question.kind }, question.kind === 'expanded' ? '扩展问题' : '原问题')),
          h('td', { className: 'ds-question-actions' }, button('编辑', () => setEditingQuestion(question.id), { className: 'ds-link', disabled: questionLocked, 'aria-label': '编辑问题' + (questions.indexOf(question) + 1) }), button('删除', () => { markDirty('questions'); setQuestions((current) => current.filter((candidate) => candidate.id !== question.id)); if (editingQuestion === question.id) setEditingQuestion(null); }, { className: 'ds-link danger', disabled: questionLocked, 'aria-label': '删除问题' + (questions.indexOf(question) + 1) }))));
        const listPage = h(React.Fragment, null,
          h('div', { className: 'ds-section-head' }, h('div', null, h('h2', null, '已添加的问题'), h('p', { className: 'ds-intro' }, '选择需要分析的问题，可直接修改或删除。')), h('span', { className: 'ds-muted' }, '已选 ' + selectedCount + ' / ' + questions.length)),
          questions.length > 0 && h('div', { className: 'ds-toolbar ds-question-tools' }, h('div', { className: 'ds-question-filters' }, h('input', { value: search, placeholder: '搜索问题', 'aria-label': '搜索问题', onChange: (event) => setSearch(event.target.value) }), h('select', { value: questionFilter, 'aria-label': '筛选问题', onChange: (event) => setQuestionFilter(event.target.value) }, [['all', '全部问题'], ['selected', '已选问题'], ['original', '原问题'], ['expanded', '扩展问题']].map(([value, label]) => h('option', { value, key: value }, label)))), h('div', { className: 'ds-actions' }, button('全选问题', () => { markDirty('questions'); setQuestions((current) => current.map((question) => ({ ...question, selected: true }))); }, { className: 'ds-link', disabled: questionLocked }), button('取消全选', () => { markDirty('questions'); setQuestions((current) => current.map((question) => ({ ...question, selected: false }))); }, { className: 'ds-link', disabled: questionLocked }))),
          questions.length > 0 ? h('div', { className: 'ds-table-wrap ds-question-table-wrap' }, h('table', { className: 'ds-question-table' }, h('thead', null, h('tr', null, h('th', { className: 'ds-selection-cell' }, '选择'), h('th', { className: 'ds-number-cell' }, '序号'), h('th', null, '问题'), h('th', null, '来源'), h('th', { className: 'ds-question-actions' }, '操作'))), h('tbody', null, questionRows.length ? questionRows : h('tr', null, h('td', { colSpan: 5, className: 'ds-empty' }, '没有匹配的问题'))))) : h('div', { className: 'ds-empty' }, h('p', null, '还没有问题，请先填写需要分析的内容。'), button('填写问题', () => setQuestionPage('compose'), { className: 'ds-button', style: { marginTop: 16 } })),
          h('div', { className: 'ds-confirm-bar' }, h('p', { className: 'ds-muted' }, dirty.questions ? '有未保存的修改，确认分析时会一并保存。' : '确认后按所选问题分析，完成后查看结果。'), h('div', { className: 'ds-actions' }, button('保存问题清单', () => void saveQuestions(), { disabled: questionLocked || !dirty.questions }), button('确认并分析', () => void startAnalysis(), { ref: analysisRef, className: 'ds-button primary', disabled: questionLocked || !selectedCount }))));
        const composePage = h(React.Fragment, null,
          h('div', { className: 'ds-section-head' }, h('div', null, h('h2', null, '填写需要分析的问题'), h('p', { className: 'ds-intro' }, '每行一个问题，整理后会添加到问题列表。'))),
          h('textarea', { value: input, rows: 8, disabled: questionLocked, placeholder: '输入您希望这个数据源回答的问题，每行一个。', 'aria-label': '原问题，每行一个', onChange: (event) => setInput(event.target.value) }),
          h('details', { className: 'ds-compose-settings' }, h('summary', null, '执行设置（可选）'), h('label', null, '执行工作区', h('input', { value: cwd, disabled: questionLocked, placeholder: '留空使用当前工作区，或填写绝对路径', 'aria-label': '执行工作区（可选）', onChange: (event) => setCwd(event.target.value) }))),
          h('div', { className: 'ds-confirm-bar' }, h('p', { className: 'ds-muted' }, '添加后请在列表中选择、修改并确认。'), h('div', { className: 'ds-actions' }, button('手动添加问题', addManualQuestions, { disabled: questionLocked || !input.trim() }), button('整理问题', () => void act('organize', { text: input }), { className: 'ds-button primary', disabled: questionLocked || !input.trim() || dirty.questions }))));
        body = h('section', { className: 'ds-card ds-question-page' },
          h('nav', { className: 'ds-subtabs', role: 'tablist', 'aria-label': '问题视图', onKeyDown: (event) => { const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']; if (!keys.includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'list' : event.key === 'End' ? 'compose' : questionPage === 'list' ? 'compose' : 'list'; setQuestionPage(next); document.getElementById('ds-question-tab-' + next)?.focus(); } }, [['list', '问题列表'], ['compose', '填写问题']].map(([key, label]) => button(label, () => setQuestionPage(key), { key, id: 'ds-question-tab-' + key, role: 'tab', tabIndex: questionPage === key ? 0 : -1, 'aria-selected': questionPage === key, 'aria-controls': 'ds-question-panel-' + key, className: 'ds-subtab' + (questionPage === key ? ' is-active' : '') }))),
          h('div', { role: 'tabpanel', id: 'ds-question-panel-' + questionPage, 'aria-labelledby': 'ds-question-tab-' + questionPage }, questionPage === 'list' ? listPage : composePage));
      }
      if (flow && tab === 'tables') {
        body = h('section', { className: 'ds-card' }, h('div', { className: 'ds-section-head' }, h('div', null, h('h2', null, '数据表范围'), h('p', { className: 'ds-intro' }, `已选择 ${selectedTables.length} / ${tables.length} 张表，勾选需要保留的字段。`)), h('div', { className: 'ds-actions' }, button('前往分析问题', showAnalysis, { className: 'ds-button small' }), button('保存表与字段', () => void act('save-tables', { tables }), { className: 'ds-button small', disabled: !!busy || !dirty.tables || rangeTaskPending }))), !flow.rangeCurrent && h('p', { className: 'ds-warning', style: { marginBottom: 14 } }, '当前问题尚无有效的分析结果，请先按最新问题完成分析。'),
          tables.length ? tables.map((table) => h('article', { key: table.id, className: `ds-table-card${table.selected ? ' is-selected' : ''}` }, h('div', { className: 'ds-table-title' }, h('input', { type: 'checkbox', checked: !!table.selected, disabled: !!busy || rangeTaskPending, onChange: (event) => updateTable(table.id, { selected: event.target.checked }), 'aria-label': `选择数据表 ${table.name}` }), h('div', { className: 'ds-table-meta' }, h('strong', null, table.name), table.description && h('p', null, table.description)), h('span', { className: 'ds-tag' }, `${table.fields.filter((field) => field.selected).length} / ${table.fields.length} 字段`)),
            h('details', { className: 'ds-fields-details' }, h('summary', null, `查看字段（${table.fields.length}）`), h('div', { className: 'ds-table-wrap', style: { border: 0, borderRadius: 0 } }, h('table', null, h('thead', null, h('tr', null, h('th', { className: 'ds-selection-cell' }, h('input', { type: 'checkbox', checked: table.fields.length > 0 && table.fields.every((field) => field.selected), disabled: !!busy || rangeTaskPending || !table.selected || !table.fields.length, 'aria-label': `选择 ${table.name} 的全部字段`, onChange: (event) => updateTable(table.id, { fields: table.fields.map((field) => ({ ...field, selected: event.target.checked })) }) })), h('th', null, '字段'), h('th', null, '类型'), h('th', null, '说明'))), h('tbody', null, table.fields.map((field) => h('tr', { key: field.name }, h('td', null, h('input', { type: 'checkbox', checked: !!field.selected, disabled: !!busy || rangeTaskPending || !table.selected, 'aria-label': `选择字段 ${table.name}.${field.name}`, onChange: (event) => updateTable(table.id, { fields: table.fields.map((candidate) => candidate.name === field.name ? { ...candidate, selected: event.target.checked } : candidate) }) })), h('td', null, field.name), h('td', { className: 'ds-muted' }, field.type), h('td', { className: 'ds-muted' }, field.description || '—'))))))))) : h('div', { className: 'ds-empty' }, '分析完成后将在这里显示实际数据表和字段。'),
          h('div', { className: 'ds-confirm-bar' }, h('div', null, flow.confirmations.tables && !dirty.tables ? h('span', { className: 'ds-tag succeeded' }, '本轮表范围已确认') : h('p', { className: 'ds-muted' }, '保存选择后，确认本轮表范围。'), dirty.tables && h('p', { className: 'ds-warning' }, '表或字段有未保存的修改。'), needsReview && h('p', { className: 'ds-warning' }, '已选择的关系存在来源待复核项，请前往关联关系页核对。')), button('确认表范围', () => void act('confirm-tables'), { className: 'ds-button primary', disabled: !!busy || rangeTaskPending || dirty.tables || dirty.questions || dirty.relations || !flow.rangeCurrent || !selectedTables.length || flow.confirmations.tables })));
      }
      if (flow && tab === 'relations') {
        const canonicalTables = flow.tables, currentRange = [...flow.runs].reverse().find((run) => run.kind === 'range');
        const side = (relation, sideName, label) => {
          const tableKey = `${sideName}Table`, fieldKey = `${sideName}Field`, table = canonicalTables.find((candidate) => candidate.id === relation[tableKey]), available = canonicalTables.filter((candidate) => candidate.selected), fields = table?.fields || [];
          return h('div', { className: 'ds-relation-side' }, h('label', null, h('span', { className: 'ds-small-label' }, `${label}侧表`), h('select', { value: relation[tableKey] || '', disabled: !!busy || !relation.selected || rangeTaskPending, 'aria-label': `${label}侧表 ${relation.id}`, onChange: (event) => { const next = canonicalTables.find((candidate) => candidate.id === event.target.value); updateRelation(relation.id, { [tableKey]: event.target.value, [fieldKey]: next?.fields.find((field) => field.selected)?.name || next?.fields[0]?.name || '' }); } }, (!table || !table.selected) && h('option', { value: relation[tableKey] || '' }, table ? `${table.name}（不在范围）` : '请选择表'), available.map((candidate) => h('option', { key: candidate.id, value: candidate.id }, candidate.name)))), h('label', null, h('span', { className: 'ds-small-label' }, `${label}侧字段`), h('select', { value: relation[fieldKey] || '', disabled: !!busy || !relation.selected || rangeTaskPending || !table, 'aria-label': `${label}侧字段 ${relation.id}`, onChange: (event) => updateRelation(relation.id, { [fieldKey]: event.target.value }) }, !fields.some((field) => field.name === relation[fieldKey]) && h('option', { value: relation[fieldKey] || '' }, relation[fieldKey] || '请选择字段'), fields.map((field) => h('option', { key: field.name, value: field.name }, `${field.name}${field.selected ? '' : '（未选）'}`)))));
        };
        body = h('section', { className: 'ds-card' }, h('div', { className: 'ds-section-head' }, h('div', null, h('h2', null, '关联关系'), h('p', { className: 'ds-intro' }, `已选择 ${selectedRelations.length} / ${relations.length} 条关系，核对两侧表、字段与问题来源。`)), button('保存关系修改', () => void act('save-relations', { relations }), { className: 'ds-button small', disabled: !!busy || !dirty.relations || rangeTaskPending })), !flow.rangeCurrent && h('p', { className: 'ds-warning', style: { marginBottom: 14 } }, '当前问题尚无有效的分析结果，来源复核和确认需等待本轮分析完成。'),
          relations.length ? relations.map((relation, index) => h('article', { className: `ds-relation${relation.selected ? ' is-selected' : ''}`, key: relation.id },
            h('div', { className: 'ds-relation-head' }, h('label', { className: 'ds-check' }, h('input', { type: 'checkbox', checked: !!relation.selected, disabled: !!busy || rangeTaskPending, onChange: (event) => updateRelation(relation.id, { selected: event.target.checked }), 'aria-label': `选择关系${index + 1}` }), `关系 ${index + 1}`), relation.needsSourceReview && relation.selected ? h('span', { className: 'ds-tag stale' }, '来源待复核') : h('span', { className: 'ds-tag' }, relation.selected ? '已选择' : '未选择')),
            h('div', { className: 'ds-relation-endpoints' }, side(relation, 'left', '左'), h('span', { className: 'ds-arrow', 'aria-hidden': true }, '→'), side(relation, 'right', '右')),
            h('div', { className: 'ds-relation-extra' }, h('label', null, h('span', { className: 'ds-small-label' }, '关系类型'), h('select', { value: relation.type || 'many-to-one', disabled: !!busy || !relation.selected || rangeTaskPending, 'aria-label': `关系类型 ${relation.id}`, onChange: (event) => updateRelation(relation.id, { type: event.target.value }) }, Object.entries(relationTypes).map(([value, label]) => h('option', { key: value, value }, label)))), h('label', null, h('span', { className: 'ds-small-label' }, '关系说明'), h('input', { value: relation.description || '', disabled: !!busy || !relation.selected || rangeTaskPending, 'aria-label': `关系说明 ${relation.id}`, onChange: (event) => updateRelation(relation.id, { description: event.target.value }) }))),
            h('div', { className: 'ds-relation-sources' }, relation.proposals?.length > 0 && h('details', { style: { marginBottom: 12 } }, h('summary', null, '候选分析依据（任务原始快照）'), ...relation.proposals.map((proposal, proposalIndex) => h('section', { key: `${proposal.runId}-${proposalIndex}`, style: { padding: '8px 0' } }, h('small', null, `分析任务 ${proposal.runId}`), h('ul', null, ...(proposal.sourceQuestions || []).map((question, questionIndex) => h('li', { key: `${question.questionId}-${questionIndex}` }, question.textAtSnapshot)))))), h('span', { className: 'ds-muted' }, '已确认的来源问题快照'), relation.sourceQuestions?.length ? h('ul', null, relation.sourceQuestions.map((question, sourceIndex) => h('li', { key: `${question.questionId}-${sourceIndex}` }, question.textAtSnapshot))) : h('p', { className: 'ds-muted' }, '尚未记录来源问题。'),
              relation.needsSourceReview && relation.selected && h('div', { className: 'ds-relation-review' }, h('p', null, '来源问题已变化，请结合本轮问题和当前表、字段重新核对。'), currentRange?.questionSnapshot?.length > 0 && h('details', { style: { marginTop: 7 } }, h('summary', null, '查看本轮完整问题快照'), h('ul', null, currentRange.questionSnapshot.map((question) => h('li', { key: question.id }, question.text)))), h('div', { className: 'ds-toolbar', style: { marginBottom: 0 } }, h('span', { className: 'ds-muted' }, '复核会保留已保存的表和字段修改。'), button('确认本轮问题依据', () => void act('review-relation', { relationId: relation.id }), { className: 'ds-button small', disabled: !!busy || rangeTaskPending || dirty.relations || dirty.tables || dirty.questions || !flow.rangeCurrent })))))) : h('div', { className: 'ds-empty' }, '分析完成后将在这里显示候选关联关系。'),
          h('div', { className: 'ds-confirm-bar' }, h('div', null, flow.confirmations.relations && !dirty.relations ? h('span', { className: 'ds-tag succeeded' }, '本轮关联关系已确认') : h('p', { className: 'ds-muted' }, '先确认表范围，再确认已选择的关联关系。'), dirty.relations && h('p', { className: 'ds-warning' }, '关系有未保存的修改，请先保存。'), needsReview && h('p', { className: 'ds-warning' }, '请逐条复核已选择关系的问题依据。')), button('确认关联关系', () => void act('confirm-relations'), { className: 'ds-button primary', disabled: !!busy || rangeTaskPending || dirty.questions || dirty.tables || dirty.relations || !flow.rangeCurrent || !flow.confirmations.tables || needsReview || flow.confirmations.relations })));
      }
      return h('div', { 'data-testid': 'datasource-detail', 'data-source-id': item.id }, button('‹ 返回数据源列表', onBack, { className: 'ds-link ds-back' }), h('header', { className: 'ds-header' }, h('div', null, h('h1', null, item.name), h('div', { className: 'ds-heading-meta' }, h('span', null, engineOf(item.engine).name), h('span', { 'aria-hidden': true }, '·'), h('span', null, item.engine === 'sqlite' ? item.file : item.database))), button('编辑连接', onEdit)),
        h('nav', { className: 'ds-tabs', role: 'tablist', 'aria-label': '数据源详情' }, [['questions', '问题', questions.length], ['tables', '数据表', tables.length], ['relations', '关联关系', relations.length]].map(([key, label, count]) => button(h(React.Fragment, null, label, h('span', { className: 'ds-count' }, count)), () => setTab(key), { key, id: `ds-tab-${key}`, role: 'tab', 'aria-selected': tab === key, 'aria-controls': `ds-panel-${key}`, className: `ds-tab${tab === key ? ' is-active' : ''}` }))), noticeView(notice), runList, loading && h('div', { className: 'ds-card ds-empty', role: 'status' }, '正在加载…'), !loading && !flow && h('div', { className: 'ds-card ds-empty' }, '暂时无法加载，将自动重试。'), h('div', { role: 'tabpanel', id: `ds-panel-${tab}`, 'aria-labelledby': `ds-tab-${tab}`, 'aria-busy': !!busy }, body));
    }
    function DatasourcePage({ openSession }) {
      const [items, setItems] = React.useState([]), [loading, setLoading] = React.useState(true), [notice, setNotice] = React.useState(null);
      const [selectedId, setSelectedId] = React.useState(null), [connection, setConnection] = React.useState(null), [deleting, setDeleting] = React.useState(null);
      const alive = React.useRef(false), controllers = React.useRef(new Set());
      const refresh = async () => { const controller = new AbortController(); controllers.current.add(controller); try { const result = await api('list', undefined, controller.signal); if (alive.current && !controller.signal.aborted) setItems(result.items || []); } catch (error) { if (alive.current && !controller.signal.aborted) setNotice({ type: 'error', text: error.message }); } finally { controllers.current.delete(controller); if (alive.current && !controller.signal.aborted) setLoading(false); } };
      React.useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }; }, []);
      const selected = items.find((item) => item.id === selectedId);
      const select = (item) => { setNotice(null); setSelectedId(item.id); };
      const saved = (item) => { if (item) setItems((current) => current.some((candidate) => candidate.id === item.id) ? current.map((candidate) => candidate.id === item.id ? item : candidate) : [...current, item]); setConnection(null); setNotice({ type: 'success', text: '数据源连接已保存。' }); void refresh(); };
      const removed = (id) => { setItems((current) => current.filter((item) => item.id !== id)); if (selectedId === id) setSelectedId(null); setDeleting(null); setNotice({ type: 'success', text: '数据源连接已删除。' }); };
      const list = h(React.Fragment, null, h('header', { className: 'ds-header' }, h('div', null, h('h1', null, '数据源'), h('p', { className: 'ds-intro' }, '管理连接，查看问题与分析结果。')), button('+ 创建数据源连接', () => setConnection({ item: null }), { className: 'ds-button primary', disabled: loading })), noticeView(notice),
        h('section', { className: 'ds-table-wrap', 'aria-label': '已保存的数据源' }, loading ? h('div', { className: 'ds-empty', role: 'status' }, '正在加载…') : !items.length ? h('div', { className: 'ds-empty', 'data-testid': 'datasource-empty' }, '没有数据源连接') : h('table', { className: 'ds-source-table' }, h('thead', null, h('tr', null, h('th', null, '数据源名称'), h('th', null, '数据源类型'), h('th', { className: 'ds-cell-actions' }, '操作'))), h('tbody', null, items.map((item) => h('tr', { key: item.id, className: 'ds-source-row', tabIndex: 0, 'data-testid': `source-row-${item.id}`, onClick: () => select(item), onKeyDown: (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item); } } }, h('td', null, h('div', { className: 'ds-source-name' }, h('span', { className: 'ds-logo', 'aria-hidden': true }, engineOf(item.engine).mark), button(item.name, (event) => { event.stopPropagation(); select(item); }, { className: 'ds-link' }))), h('td', null, h('span', { className: 'ds-tag' }, engineOf(item.engine).name)), h('td', { className: 'ds-cell-actions' }, button('编辑连接', (event) => { event.stopPropagation(); setConnection({ item }); }, { className: 'ds-link', 'aria-label': `编辑连接 ${item.name}` }), button('删除', (event) => { event.stopPropagation(); setDeleting(item); }, { className: 'ds-link danger', 'aria-label': `删除连接 ${item.name}` }))))))));
      return h('div', { className: 'dsh-ds', 'data-testid': 'datasource-page' }, h('style', null, css), h('div', { className: 'ds-wrap' }, selected ? h(React.Fragment, null, noticeView(notice), h(FlowDetail, { key: selected.id, item: selected, onBack: () => { setSelectedId(null); setNotice(null); }, onEdit: () => setConnection({ item: selected }), openSession })) : list, connection && h(ConnectionDialog, { key: connection.item?.id || 'new', item: connection.item, onClose: () => setConnection(null), onSaved: saved }), deleting && h(DeleteDialog, { item: deleting, onClose: () => setDeleting(null), onRemoved: removed })));
    }
    function apply(ctx) {
      // The supported optional lookup keeps this page usable without a Workspace provider.
      const openSession = (id) => { const workspace = ctx.get?.('uiWorkspace'); if (typeof workspace?.openSession !== 'function') return false; workspace.openSession(id); return true; };
      const Page = () => h(DatasourcePage, { openSession });
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'datasources' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'datasources', order: 5, label: '数据源' }, DatabaseIcon));
    }
    return { name: 'sql', inject: ['slots', 'layout'], apply };
  },
});
