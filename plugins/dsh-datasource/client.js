window.__ModuleLoader__.load({
  id: 'dsh-sql',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const engines = [['mysql', 'MySQL'], ['postgres', 'PostgreSQL'], ['sqlite', 'SQLite']];
    const pageSize = 10;
    const emptyFilters = { search: '', domain: '', days: '', empty: '' };
    const engineName = (engine) => engines.find(([id]) => id === engine)?.[1] || engine;
    const operationId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const blankConnection = () => ({ name: '', description: '', engine: 'mysql', host: '127.0.0.1', port: 3306, user: '', database: '', file: '', password: '', clearPassword: false });
    const connectionLabels = { running: '检测中', normal: '正常', failed: '异常', disabled: '已停用' };
    const operationLabels = { scan: '正在刷新目录', 'ensure-scan': '正在检查目录', 'detect-freshness': '正在检测时效', 'detect-domains': '正在识别业务域', suggest: '正在分析选表依据', 'generalize-question': '正在泛化问题' };
    const pendingRefresh = 30 * 60 * 1000;
    const css = `
.dsh-ds{height:100%;overflow:auto;padding:26px clamp(12px,3vw,44px) 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.dsh-ds,.dsh-ds *{box-sizing:border-box}
.dsh-ds .ds-wrap{max-width:1240px;margin:auto;min-width:0}
.dsh-ds h1,.dsh-ds h2,.dsh-ds h3,.dsh-ds p{margin:0}
.dsh-ds h1{font-size:22px;font-weight:600;overflow-wrap:anywhere}
.dsh-ds h2{font-size:17px;font-weight:600}
.dsh-ds h3{font-size:14px;font-weight:600}
.dsh-ds button,.dsh-ds input,.dsh-ds select,.dsh-ds textarea{font:inherit;color-scheme:inherit}
.dsh-ds button{cursor:pointer}
.dsh-ds button:disabled{cursor:default;opacity:.5}
.dsh-ds :is(button,summary,input,select,textarea):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-ds input:not([type=checkbox]),.dsh-ds select,.dsh-ds textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:7px 10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}
.dsh-ds select option{background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}
.dsh-ds textarea{resize:vertical}
.dsh-ds input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none;margin:0}
.dsh-ds .ds-header,.dsh-ds .ds-row,.dsh-ds .ds-actions,.dsh-ds .ds-filters,.dsh-ds .ds-pagination{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ds .ds-header,.dsh-ds .ds-row,.dsh-ds .ds-pagination{justify-content:space-between}
.dsh-ds .ds-header{gap:16px;margin:0 0 16px}
.dsh-ds .ds-filters{margin:12px 0}
.dsh-ds .ds-filters input{width:min(230px,100%)}
.dsh-ds .ds-filters select{width:auto;max-width:100%}
.dsh-ds .ds-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsh-ds .ds-button,.dsh-ds summary.ds-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap;line-height:1.5}
.dsh-ds .ds-button.compact{font-size:12px;padding:3px 8px;border-radius:5px}
.dsh-ds .ds-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ds .ds-button.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-ds .ds-button.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-ds .ds-button.danger,.dsh-ds .ds-link.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-ds .ds-link{border:0;background:transparent;padding:3px 0;color:var(--dsw-alias-state-business-primary);text-align:left;line-height:1.5;overflow-wrap:anywhere}
.dsh-ds .ds-link:hover:not(:disabled){text-decoration:underline}
.dsh-ds .ds-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.dsh-ds table{border-collapse:collapse;width:100%;text-align:left;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-ds th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);white-space:nowrap}
.dsh-ds th,.dsh-ds td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle;overflow-wrap:anywhere}
.dsh-ds tbody tr:last-child td{border-bottom:0}
.dsh-ds tr.ds-new{background:var(--dsw-alias-state-business-tertiary)}
.dsh-ds .ds-check-cell{width:38px}
.dsh-ds .ds-source-table{min-width:820px}
.dsh-ds .ds-catalog-table{min-width:620px}
.dsh-ds .ds-small-table{min-width:450px}
.dsh-ds .ds-ellipsis{max-width:260px}
.dsh-ds .ds-empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-notice{padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-state-business-tertiary);margin:8px 0 12px;overflow-wrap:anywhere}
.dsh-ds .ds-notice.error{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-ds .ds-toast{position:fixed;z-index:1;right:16px;bottom:16px;box-shadow:0 4px 20px rgb(0 0 0 / .15);background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;gap:16px;max-width:calc(100vw - 32px)}
.dsh-ds .ds-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 6px;font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-tag+.ds-tag{margin-left:5px}
.dsh-ds .ds-connection-status{display:inline-flex;gap:7px;align-items:center;white-space:nowrap}
.dsh-ds .ds-connection-status::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dsh-ds .ds-connection-status.normal::before{background:var(--dsw-alias-state-success-primary)}
.dsh-ds .ds-connection-status.failed::before{background:var(--dsw-alias-state-error-primary)}
.dsh-ds .ds-pagination{margin-top:10px}
.dsh-ds .ds-check{display:inline-flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.dsh-ds .ds-nowrap{white-space:nowrap}
.dsh-ds .ds-modal{width:min(620px,calc(100% - 24px));height:min(600px,calc(100dvh - 24px));max-height:calc(100dvh - 24px);overflow:hidden;border:1px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0;box-shadow:0 20px 80px rgb(0 0 0 / .24)}
.dsh-ds .ds-modal[open]{display:flex;flex-direction:column}
.dsh-ds .ds-modal-wide{width:min(890px,calc(100% - 24px));height:min(760px,calc(100dvh - 24px))}
.dsh-ds .ds-modal-basis{height:min(640px,calc(100dvh - 24px))}
.dsh-ds .ds-modal-delete{height:min(360px,calc(100dvh - 24px))}
.dsh-ds .ds-modal::backdrop{background:rgb(0 0 0 / .43)}
.dsh-ds .ds-modal-head,.dsh-ds .ds-modal-body,.dsh-ds .ds-modal-footer{padding:16px 20px}
.dsh-ds .ds-modal-head{flex:none;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-modal-layout{display:flex;flex:1;flex-direction:column;min-height:0;margin:0}
.dsh-ds .ds-modal-body{flex:1;min-height:0;overflow:auto}
.dsh-ds .ds-modal-footer{flex:none;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-ds .ds-modal-footer>.ds-modal-foot{margin-top:0}
.dsh-ds .ds-modal-footer>.ds-pagination{margin:0 0 12px}
.dsh-ds .ds-delete-list{padding-left:22px;overflow-wrap:anywhere}
.dsh-ds .ds-close{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:24px;line-height:1;padding:2px 5px}
.dsh-ds .ds-modal-foot{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}
.dsh-ds .ds-form,.dsh-ds .ds-basis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.dsh-ds .ds-basis>section{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px}
.dsh-ds .ds-modal-basis .ds-modal-body{display:flex;flex-direction:column;overflow:hidden}
.dsh-ds .ds-modal-basis .ds-basis{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}
.dsh-ds .ds-basis>section>.ds-row{flex:none}
.dsh-ds .ds-basis-list{flex:1;min-height:0;overflow:auto;align-content:start;padding-right:3px}
.dsh-ds .ds-reference-list{flex:1;min-height:0;overflow:auto;align-content:start}
.dsh-ds .ds-modal-originals{height:min(600px,calc(100dvh - 24px))}
.dsh-ds .ds-reference-summary{flex:none;margin-bottom:10px}
.dsh-ds .ds-stack{display:grid;gap:9px;margin-top:12px}
.dsh-ds .ds-question-option{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:9px 10px;cursor:pointer;overflow-wrap:anywhere}
.dsh-ds .ds-question-option input{margin-top:3px}
.dsh-ds .ds-question-text{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.dsh-ds .ds-question-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:nowrap}
.dsh-ds .ds-question-actions .ds-button{font-size:12px;padding:3px 8px;border-radius:5px}
.dsh-ds .ds-questions-table{min-width:690px;table-layout:fixed}
.dsh-ds .ds-questions-table th:first-child{width:52px}
.dsh-ds .ds-questions-table th:nth-child(2){width:38%}
.dsh-ds .ds-questions-table th:last-child{width:116px;text-align:right}
.dsh-ds .ds-recommendation-table{min-width:720px;table-layout:fixed}
.dsh-ds .ds-recommendation-table th:first-child{width:42px}
.dsh-ds .ds-recommendation-table th:nth-child(2){width:27%}
.dsh-ds .ds-recommendation-table th:nth-child(3){width:22%}
.dsh-ds .ds-recommendation-table th:nth-child(4){width:14%}
.dsh-ds .ds-table-links{display:grid;gap:9px;margin-top:9px}
.dsh-ds .ds-table-link,.dsh-ds .ds-draft-candidate{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:10px}
.dsh-ds .ds-table-link-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.dsh-ds .ds-table-name{font-weight:500;overflow-wrap:anywhere}
.dsh-ds .ds-link-details{margin-top:7px;font-size:12px}
.dsh-ds .ds-link-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-link-details dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 10px;margin:7px 0 0}
.dsh-ds .ds-link-details dt{color:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-link-details dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-ds .ds-draft-list{min-height:0;overflow:auto;padding-right:3px}
.dsh-ds .ds-draft-editor{display:flex;align-items:flex-start;gap:9px}
.dsh-ds .ds-draft-editor input{margin-top:9px}
.dsh-ds .ds-draft-editor textarea{flex:1}
.dsh-ds .ds-draft-candidate .ds-table-links{margin-left:25px}
.dsh-ds .ds-field>span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.dsh-ds .ds-wide{grid-column:1/-1}
.dsh-ds .ds-text{white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-ds .ds-space{margin:12px 0}
.dsh-ds .ds-switch{appearance:none;width:32px;height:18px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l4);border-radius:12px;vertical-align:middle;padding:2px}
.dsh-ds .ds-switch::after{content:'';display:block;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dsh-ds .ds-switch[aria-checked=true]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.dsh-ds .ds-switch[aria-checked=true]::after{margin-left:auto;background:var(--dsw-alias-label-primary-foreground)}
.dsh-ds .ds-loading{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin:12px 0}
.dsh-ds .ds-loading>span[role=status]{flex:1}
.dsh-ds .ds-spinner{width:18px;height:18px;flex:none;border:2px solid var(--dsw-alias-border-l4);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:ds-spin .8s linear infinite}
@keyframes ds-spin{to{transform:rotate(360deg)}}
.dsh-ds .ds-modal-scroll{overflow:hidden}
.dsh-ds .ds-modal-scroll[open]{display:flex;flex-direction:column}
.dsh-ds .ds-modal-scroll .ds-modal-head{flex:none}
.dsh-ds .ds-modal-scroll .ds-modal-body{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.dsh-ds .ds-modal-scroll .ds-table-wrap{min-height:0;overflow:auto}
.dsh-ds .ds-modal-scroll th{position:sticky;top:0;z-index:1}
.dsh-ds .ds-modal-scroll .ds-modal-foot,.dsh-ds .ds-modal-scroll .ds-modal-body>.ds-row{flex:none}
@media(max-width:650px){.dsh-ds .ds-basis,.dsh-ds .ds-form{grid-template-columns:1fr}.dsh-ds .ds-modal-basis .ds-basis{grid-template-rows:repeat(2,minmax(0,1fr))}.dsh-ds .ds-modal-head,.dsh-ds .ds-modal-body{padding:12px}.dsh-ds th,.dsh-ds td{padding:8px 10px}}
    `;

    async function api(operation, input, signal) {
      const options = input === undefined ? { method: 'GET' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      };
      const response = await fetch(`/api/datasources/${operation}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
      let value;
      try { value = await response.json(); } catch { throw new Error('无法读取数据源服务的响应，请重试。'); }
      if (!response.ok) {
        const error = new Error(typeof value?.error === 'string' ? value.error : '操作失败，请重试。');
        error.status = response.status;
        error.sessionId = value?.sessionId;
        throw error;
      }
      return value;
    }

    const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'ds-button', onClick, ...props }, label);
    const link = (label, onClick, props = {}) => button(label, onClick, props);
    const noticeView = (notice) => notice && h('div', { className: `ds-notice ${notice.type || ''}`, role: notice.type === 'error' ? 'alert' : 'status' }, notice.text);
    const errorNotice = (error) => ({ type: 'error', text: error.message });
    const tag = (text) => h('span', { className: 'ds-tag' }, text);
    const searchInput = (label, value, onChange) => h('input', { type: 'search', 'aria-label': label, placeholder: label, value, onChange: (event) => onChange(event.target.value) });
    const selectInput = (label, value, onChange, options, props = {}) => h('select', { 'aria-label': label, value, onChange: (event) => onChange(event.target.value), ...props }, options.map(([id, name]) => h('option', { key: id, value: id }, name)));
    const check = (label, checked, onChange, props = {}) => h('input', { type: 'checkbox', 'aria-label': label, checked, onChange: (event) => onChange(event.target.checked), ...props });
    const cell = (children, props) => h('td', props, children);
    const matches = (search, ...values) => values.some((value) => String(value ?? '').toLowerCase().includes(search.trim().toLowerCase()));
    const withChecked = (current, ids, checked) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    };
    const shownPage = (page, rows) => Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
    const pageRows = (rows, page) => rows.slice((page - 1) * pageSize, page * pageSize);

    function Pagination({ page, count, onPage }) {
      const last = Math.max(1, Math.ceil(count / pageSize));
      return h('nav', { className: 'ds-pagination', 'aria-label': '分页' },
        h('span', { className: 'ds-muted' }, `${count} 条 · 第 ${page} / ${last} 页`),
        h('div', { className: 'ds-actions' }, button('上一页', () => onPage(page - 1), { disabled: page === 1 }),
          button('下一页', () => onPage(page + 1), { disabled: page === last })));
    }

    function SelectAll({ label, rows, chosen, onChange, disabled }) {
      const count = rows.filter((row) => chosen.has(row.id)).length;
      return check(label, rows.length > 0 && count === rows.length, onChange, {
        disabled: disabled || rows.length === 0, ref: (input) => { if (input) input.indeterminate = count > 0 && count < rows.length; },
      });
    }

    function DataTable({ labels, rows, className, testId, empty = '没有匹配结果' }) {
      return h('div', { className: 'ds-table-wrap' }, h('table', { className, 'data-testid': testId },
        h('thead', null, h('tr', null, labels.map((label, index) => h('th', { key: index, scope: 'col', className: typeof label === 'string' ? undefined : 'ds-check-cell' }, label)))),
        h('tbody', null, rows.length ? rows : h('tr', null, cell(empty, { colSpan: labels.length, className: 'ds-empty' })))));
    }

    function LoadingBar({ action, startedAt, onCancel, label }) {
      const [now, setNow] = useState(Date.now);
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 250);
        return () => window.clearInterval(timer);
      }, [startedAt]);
      return h('div', { className: 'ds-loading' }, h('span', { className: 'ds-spinner', 'aria-hidden': true }),
        h('span', { role: 'status' }, `${label || operationLabels[action] || '正在处理'} · 已用 ${Math.max(0, Math.floor((now - startedAt) / 1000))} 秒`),
        onCancel && button('取消操作', onCancel));
    }

    function Dialog({ title, testId, onClose, children, footer, formProps, wide, size, busy, internalScroll }) {
      const ref = useRef(null);
      useEffect(() => {
        const dialog = ref.current;
        const previous = document.activeElement;
        dialog.showModal();
        return () => { dialog.close(); previous?.focus?.(); };
      }, []);
      return h('dialog', {
        ref, className: `ds-modal${wide ? ' ds-modal-wide' : ''}${size ? ` ds-modal-${size}` : ''}${internalScroll ? ' ds-modal-scroll' : ''}`, 'aria-label': title, 'data-testid': testId,
        onCancel: (event) => { event.preventDefault(); if (!busy) onClose(); },
      }, h('header', { className: 'ds-modal-head ds-row' }, h('h2', null, title),
        button('×', onClose, { className: 'ds-close', 'aria-label': `关闭${title}`, disabled: busy })),
      h(formProps ? 'form' : 'div', { ...formProps, className: 'ds-modal-layout' },
        h('div', { className: 'ds-modal-body' }, children),
        footer && h('footer', { className: 'ds-modal-footer' }, footer)));
    }

    function Field({ label, name, draft, change, wide, multiline, ...props }) {
      return h('label', { className: wide ? 'ds-field ds-wide' : 'ds-field' }, h('span', null, label),
        h(multiline ? 'textarea' : 'input', { ...props, 'aria-label': label, value: draft[name] ?? '', onChange: (event) => change(name, event.target.value) }));
    }

    function ConnectionDialog({ item, onClose, onSaved }) {
      const [draft, setDraft] = useState(() => ({ ...blankConnection(), ...item, password: '', clearPassword: false }));
      const [busy, setBusy] = useState(''), [notice, setNotice] = useState(null);
      const form = useRef(null), request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const change = (key, value) => {
        setDraft((current) => {
          if (key === 'engine') return { ...current, engine: value, port: value === 'postgres' ? 5432 : 3306, password: '', clearPassword: false };
          if (key === 'clearPassword' && value) return { ...current, clearPassword: true, password: '' };
          return { ...current, [key]: value, ...(key === 'password' && value ? { clearPassword: false } : {}) };
        });
        setNotice(null);
      };
      const execute = async (action) => {
        if (request.current || !form.current?.reportValidity()) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(action);
        setNotice(null);
        const { name, description, engine, host, port, user, database, file, password, clearPassword } = draft;
        const target = engine === 'sqlite' ? { file } : { host, port: Number(port), user, database, password, clearPassword };
        const metadata = item ? { id: item.id, ...(action === 'save' ? { revision: item.revision } : {}) } : {};
        try {
          const result = await api(action, { ...metadata, name, description, engine, ...target }, controller.signal);
          if (controller.signal.aborted) return;
          if (action === 'save') onSaved(result.item);
          else setNotice({ type: result.ok ? 'success' : 'error', text: result.message || (result.ok ? '连接成功。' : '连接失败。') });
        } catch (error) {
          if (!controller.signal.aborted) setNotice(errorNotice(error));
        } finally {
          request.current = null;
          if (!controller.signal.aborted) setBusy('');
        }
      };
      const field = (name, label, props = {}) => h(Field, { key: name, name, label, draft, change, ...props });
      return h(Dialog, { title: item ? '编辑数据源' : '新建数据源', testId: 'connection-modal', onClose, busy: !!busy,
        formProps: { ref: form, onSubmit: (event) => { event.preventDefault(); void execute('save'); } },
        footer: h('div', { className: 'ds-modal-foot' }, button(busy === 'test' ? '正在测试…' : '测试连接', () => void execute('test'), { disabled: !!busy }),
          button('取消', onClose, { disabled: !!busy }), h('button', { type: 'submit', className: 'ds-button primary', disabled: !!busy }, busy === 'save' ? '正在保存…' : '保存')) },
        noticeView(notice), h('div', { className: 'ds-form' },
            h('label', { className: 'ds-field ds-wide' }, h('span', null, '数据源类型'), selectInput('数据源类型', draft.engine, (value) => change('engine', value), engines, { disabled: !!busy })),
            field('name', '数据源名称', { required: true, wide: true, autoFocus: true, maxLength: 80, disabled: !!busy }),
            field('description', '描述', { wide: true, maxLength: 500, disabled: !!busy }),
            ...(draft.engine === 'sqlite' ? [field('file', '数据库文件路径', { required: true, wide: true, disabled: !!busy })] : [
              field('host', '主机地址 / IP', { required: true, disabled: !!busy }),
              field('port', '端口', { required: true, type: 'number', min: 1, max: 65535, disabled: !!busy }),
              field('database', '数据库名称', { required: true, disabled: !!busy }),
              field('user', '用户名', { required: true, disabled: !!busy }),
              field('password', '密码', { type: 'password', wide: true, autoComplete: 'new-password', placeholder: item?.hasPassword ? '留空保留已保存的密码' : '', disabled: !!busy }),
              item?.hasPassword && h('label', { key: 'clear', className: 'ds-check ds-wide' }, check('清除已保存的密码', draft.clearPassword, (value) => change('clearPassword', value), { disabled: !!busy }), '清除已保存的密码'),
            ])));
    }

    function DeleteDialog({ title, kind, items, onClose, onRemove }) {
      const [pending, setPending] = useState(items);
      const [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const remove = async () => {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setNotice(null);
        const remaining = [], errors = [];
        try {
          for (let index = 0; index < pending.length; index++) {
            const item = pending[index];
            if (controller.signal.aborted) { remaining.push(...pending.slice(index)); break; }
            try {
              await onRemove(item, controller.signal);
              if (controller.signal.aborted) { remaining.push(...pending.slice(index)); break; }
            } catch (error) {
              remaining.push(item);
              errors.push(`${item.name || item.text}：${error.message}`);
              if (controller.signal.aborted) { remaining.push(...pending.slice(index + 1)); break; }
            }
          }
          if (controller.signal.aborted) return;
          setPending(remaining);
          if (!remaining.length) onClose();
          else setNotice({ type: 'error', text: `还有 ${remaining.length} 个${kind}未删除。${errors.join('；')}` });
        } finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      return h(Dialog, { title, testId: 'delete-dialog', size: 'delete', onClose, busy,
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: busy }),
          button(busy ? '正在删除…' : notice ? '重试删除' : '删除', () => void remove(), { className: 'ds-button danger', disabled: busy })) },
        noticeView(notice), h('p', null, `确定删除以下 ${pending.length} 个${kind}${kind === '数据源' ? '及其目录和关联结果' : '及其关联'}？`),
        h('ul', { className: 'ds-delete-list', 'aria-label': '待删除清单' }, pending.map((item) => h('li', { key: item.id }, item.name || item.text))));
    }

    function ManagementSettings({ status, onReady, onClose }) {
      const [draft, setDraft] = useState(() => ({ host: '127.0.0.1', port: 3306, database: '', user: '', ...status.settings, password: '' }));
      const [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const save = async (event) => {
        event.preventDefault();
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setNotice(null);
        try {
          const result = await api('management-save', { ...draft, port: Number(draft.port) }, controller.signal);
          if (controller.signal.aborted) return;
          setDraft((previous) => ({ ...previous, password: '' }));
          if (!result.ready) setNotice({ type: 'error', text: result.message || '管理库尚未就绪。' });
          onReady(result);
        } catch (error) {
          if (!controller.signal.aborted) setNotice(errorNotice(error));
        } finally {
          request.current = null;
          if (!controller.signal.aborted) setBusy(false);
        }
      };
      return h(Dialog, { title: '配置管理库', testId: 'management-modal', onClose, busy,
        formProps: { onSubmit: (event) => void save(event) },
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: busy }),
          h('button', { type: 'submit', className: 'ds-button primary', disabled: busy }, busy ? '正在配置…' : '保存管理库设置')) },
        noticeView(notice), status.message && h('p', { className: 'ds-muted ds-space' }, status.message),
        h('div', { className: 'ds-form' },
          [['host', '管理库主机'], ['port', '管理库端口'], ['database', '管理库名称'], ['user', '管理库用户名'], ['password', '管理库密码']].map(([name, label]) =>
            h(Field, { key: name, name, label, draft, required: name !== 'password', disabled: busy,
              type: name === 'password' ? 'password' : name === 'port' ? 'number' : 'text',
              ...(name === 'port' ? { min: 1, max: 65535 } : {}),
              placeholder: name === 'password' && status.configured ? '留空保留密码' : '',
              change: (key, value) => setDraft((previous) => ({ ...previous, [key]: value })),
            }))));
    }

    function SourceList({ items, statuses, loading, onOpen, onCreate, onEdit, onDelete, onStatus, statusBusy }) {
      const [search, setSearch] = useState(''), [engine, setEngine] = useState(''), [status, setStatus] = useState('');
      const [page, setPage] = useState(1), [chosen, setChosen] = useState(() => new Set());
      const [more, setMore] = useState(null);
      useEffect(() => { setChosen((current) => new Set(items.filter(({ id }) => current.has(id)).map(({ id }) => id))); }, [items]);
      const statusOf = (item) => item.enabled ? statuses[item.id]?.type || 'running' : 'disabled';
      const filtered = items.filter((item) => matches(search, item.name) && (!engine || item.engine === engine) && (!status || statusOf(item) === status));
      const currentPage = shownPage(page, filtered);
      const selected = items.filter((item) => chosen.has(item.id));
      const filter = (set) => (value) => { set(value); setPage(1); setMore(null); };
      const choose = (ids, checked) => setChosen((current) => withChecked(current, ids, checked));
      const count = (type) => items.filter((item) => statusOf(item) === type).length;
      const rows = pageRows(filtered, currentPage).map((item) => h('tr', { key: item.id, 'data-testid': `source-row-${item.id}` },
        cell(check(`选择数据源 ${item.name}`, chosen.has(item.id), (value) => choose([item.id], value))),
        cell(link(item.name, () => onOpen(item))), cell(engineName(item.engine)),
        cell(item.description || '—', { className: 'ds-ellipsis' }),
        cell(h('span', { className: `ds-connection-status ${statusOf(item)}`, title: item.enabled ? statuses[item.id]?.message : undefined,
          'data-testid': `source-connection-status-${item.id}` }, connectionLabels[statusOf(item)])),
        cell(item.tableCount ?? '—'), cell(formatDate(item.createdAt)),
        cell(h('div', { className: 'ds-actions' }, link(item.enabled ? '停用' : '启用', () => void onStatus([item], !item.enabled), { disabled: statusBusy, 'aria-label': `${item.enabled ? '停用' : '启用'} ${item.name}` }),
          link('编辑', () => onEdit(item), { 'aria-label': `编辑 ${item.name}` }),
          link('更多', () => setMore(more === item.id ? null : item.id), { 'aria-label': `更多 ${item.name}`, 'aria-expanded': more === item.id }),
          more === item.id && link('删除', () => onDelete(item), { className: 'ds-button danger', 'aria-label': `删除 ${item.name}` })))));
      return h(React.Fragment, null,
        h('header', { className: 'ds-header' }, h('div', null, h('h1', null, '数据源'),
          h('p', { className: 'ds-muted', role: 'status' }, `共 ${items.length} 个 · 正常 ${count('normal')} · 异常 ${count('failed')} · 已停用 ${count('disabled')}`)),
          button('新建数据源', onCreate, { className: 'ds-button primary', disabled: loading, 'data-testid': 'create-datasource' })),
        items.length > 0 && h('div', { className: 'ds-row' },
          h('div', { className: 'ds-filters' }, searchInput('搜索数据源名称', search, filter(setSearch)),
            selectInput('筛选数据源类型', engine, filter(setEngine), [['', '全部类型'], ...engines]),
            selectInput('筛选连接状态', status, filter(setStatus), [['', '全部连接状态'], ['normal', '正常'], ['failed', '异常'], ['disabled', '已停用']])),
          h('div', { className: 'ds-actions' }, selected.length > 0 && h('span', { className: 'ds-muted' }, `已选 ${selected.length} 个`),
            button('批量启用', () => void onStatus(selected, true).then((succeeded) => choose(succeeded, false)), { disabled: statusBusy || !selected.length }),
            button(`删除已选（${selected.length}）`, () => onDelete(selected), { className: 'ds-button danger', disabled: statusBusy || !selected.length }))),
        loading ? h('p', { className: 'ds-empty', role: 'status' }, '正在加载…') :
          h(DataTable, { testId: 'source-table', className: 'ds-source-table', empty: items.length ? '没有匹配的数据源' : '还没有数据源', rows,
            labels: [h(SelectAll, { rows: filtered, chosen, label: '全选当前筛选数据源', onChange: (value) => choose(filtered.map(({ id }) => id), value) }),
              '名称', '类型', '描述', '连接状态', '表数量', '创建时间', '操作'] }),
        filtered.length > 0 && h(Pagination, { page: currentPage, count: filtered.length, onPage: setPage }));
    }

    function DatasourcePage({ openSession }) {
      const [items, setItems] = useState([]), [statuses, setStatuses] = useState({});
      const [loading, setLoading] = useState(true), [notice, setNotice] = useState(null);
      const [selectedId, setSelectedId] = useState(null), [connection, setConnection] = useState(null), [deleting, setDeleting] = useState(null);
      const [management, setManagement] = useState(null), [managementOpen, setManagementOpen] = useState(false);
      const [statusBusy, setStatusBusy] = useState(false);
      const lifetime = useRef(null), tests = useRef(new Map()), statusRequest = useRef(false), sourceScans = useRef(new Map());
      const opening = useRef(null);
      const testConnection = async (item) => {
        const { id } = item;
        tests.current.get(id)?.abort();
        if (!item.enabled) return;
        const controller = new AbortController();
        tests.current.set(id, controller);
        const report = (type, message) => {
          if (!controller.signal.aborted) setStatuses((current) => ({ ...current, [id]: { type, message } }));
        };
        report('running');
        try {
          const result = await api('test', { id }, controller.signal);
          report(result.ok ? 'normal' : 'failed', result.message);
          return result.ok && !controller.signal.aborted;
        } catch (error) { report('failed', error.message); return false; }
        finally { if (tests.current.get(id) === controller) tests.current.delete(id); }
      };
      const loadItems = async (signal) => {
        const { items: sources } = await api('list', undefined, signal);
        if (signal.aborted) return;
        setItems(sources);
        for (const item of sources) void testConnection(item);
      };
      useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        const { signal } = controller;
        void (async () => {
          try {
            const status = await api('management-status', undefined, signal);
            if (signal.aborted) return;
            setManagement(status);
            if (status.ready) await loadItems(signal);
          } catch (error) { if (!signal.aborted) setNotice(errorNotice(error)); }
          finally { if (!signal.aborted) setLoading(false); }
        })();
        return () => {
          controller.abort();
          for (const test of tests.current.values()) test.abort();
          for (const scan of sourceScans.current.values()) scan.controller.abort();
        };
      }, []);
      const setSource = (item) => setItems((current) => current.some(({ id }) => id === item.id)
        ? current.map((candidate) => candidate.id === item.id ? item : candidate) : [...current, item]);
      const setTableCount = (id, version, tableCount) => setItems((current) => current.map((item) =>
        item.id === id && item.connectionVersion === version && item.tableCount !== tableCount ? { ...item, tableCount } : item));
      const selected = items.find((item) => item.id === selectedId);
      const saveSource = (item) => {
        const previous = items.find(({ id }) => id === item.id);
        const { id, connectionVersion } = item;
        setConnection(null);
        setSource(item);
        setNotice(null);
        const needsScan = item.enabled && (!previous || previous.connectionVersion !== connectionVersion);
        sourceScans.current.get(id)?.controller.abort();
        const controller = new AbortController();
        const scan = { controller, request: null };
        sourceScans.current.set(id, scan);
        void (async () => {
          try {
            const ok = await testConnection(item);
            if (!ok || !needsScan || controller.signal.aborted || opening.current === id) return;
            const { task } = await api(`ai-tasks?sourceId=${encodeURIComponent(id)}`, undefined, controller.signal);
            if (task && ['running', 'cancelling'].includes(task.status)) return;
            scan.request = api('flow-action', { id, action: 'ensure-scan', open: true, operationId: operationId() }, controller.signal);
            const { state } = await scan.request;
            if (!controller.signal.aborted) setTableCount(id, connectionVersion, state.catalog?.tables.length ?? null);
          } catch (error) {
            if (!controller.signal.aborted) setNotice({ type: 'error', text: `已保存「${item.name}」，目录读取失败。${error.message}` });
          } finally { if (sourceScans.current.get(id) === scan) sourceScans.current.delete(id); }
        })();
      };
      const changeSourceStatus = async (targets, enabled) => {
        const changes = targets.filter((item) => item.enabled !== enabled);
        const succeeded = targets.filter((item) => item.enabled === enabled).map(({ id }) => id);
        if (!changes.length || statusRequest.current) return succeeded;
        const { signal } = lifetime.current;
        statusRequest.current = true;
        setStatusBusy(true);
        setNotice(null);
        try {
          const { results } = await api('source-status', { items: changes.map(({ id, revision }) => ({ id, revision, enabled })) }, signal);
          if (signal.aborted) return succeeded;
          const errors = [];
          for (const result of results) {
            if (result.ok) {
              succeeded.push(result.id);
              setSource(result.item);
              if (!result.item.enabled) sourceScans.current.get(result.id)?.controller.abort();
              void testConnection(result.item);
            } else {
              const name = changes.find(({ id }) => id === result.id)?.name || result.id;
              const message = typeof result.error === 'string' ? result.error : result.error?.message;
              errors.push(`${name}：${message || '操作失败'}`);
            }
          }
          if (errors.length) setNotice({ type: 'error', text: errors.join('；') });
        } catch (error) { if (!signal.aborted) setNotice(errorNotice(error)); }
        finally { statusRequest.current = false; if (!signal.aborted) setStatusBusy(false); }
        return succeeded;
      };
      const removeSource = async ({ id, revision }, signal) => {
        await api('remove', { id, revision }, signal);
        if (signal.aborted) return;
        tests.current.get(id)?.abort();
        sourceScans.current.get(id)?.controller.abort();
        setItems((current) => current.filter((item) => item.id !== id));
      };
      const openSource = (item) => {
        opening.current = item.id;
        setNotice(null);
        setSelectedId(item.id);
      };
      const createSource = () => {
        setNotice(null);
        if (management?.ready) setConnection({ item: null });
        else setManagementOpen(true);
      };
      const managementReady = async (status) => {
        setManagement(status);
        if (!status.ready) return;
        setManagementOpen(false);
        setConnection({ item: null });
        const { signal } = lifetime.current;
        try { await loadItems(signal); } catch (error) { if (!signal.aborted) setNotice(errorNotice(error)); }
      };
      return h('div', { className: 'dsh-ds', 'data-testid': 'datasource-page' }, h('style', null, css),
        h('div', { className: 'ds-wrap' }, noticeView(notice),
          selected ? h(FlowDetail, { key: `${selected.id}:${selected.connectionVersion}`, item: selected, openSession,
            onBack: () => { opening.current = null; setSelectedId(null); setNotice(null); }, onCatalog: setTableCount,
            initialScan: sourceScans.current.get(selected.id)?.request })
            : h(SourceList, { items, statuses, loading, onCreate: createSource, statusBusy, onStatus: changeSourceStatus,
              onOpen: openSource, onEdit: (item) => setConnection({ item }), onDelete: (items) => setDeleting(Array.isArray(items) ? items : [items]) }),
          managementOpen && h(ManagementSettings, { status: management || {}, onClose: () => setManagementOpen(false), onReady: managementReady }),
          connection && h(ConnectionDialog, { item: connection.item, onClose: () => setConnection(null), onSaved: saveSource }),
          deleting && h(DeleteDialog, { title: '删除数据源', kind: '数据源', items: deleting, onClose: () => setDeleting(null), onRemove: removeSource })));
    }

    function apply(ctx) {
      const openSession = (id) => {
        const workspace = ctx.get?.('uiWorkspace');
        if (typeof workspace?.openSession !== 'function') return false;
        workspace.openSession(id);
        return true;
      };
      const Page = () => h(DatasourcePage, { openSession });
      const DatabaseIcon = () => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, 'aria-hidden': true },
        h('ellipse', { cx: 12, cy: 5.2, rx: 7.4, ry: 3 }), h('path', { d: 'M4.6 5.2v13.6c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3V5.2M4.6 12c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3' }));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'datasources' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'datasources', order: 5, label: '数据源' }, DatabaseIcon));
    }

    const dateFormatter = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
    function formatDate(value, withTime = false) {
      const date = new Date(value);
      return value && Number.isFinite(date.getTime()) ? (withTime ? timeFormatter : dateFormatter).format(date) : '—';
    }

    const freshnessLabels = { UNDETECTED: '未检测', EMPTY: '空表', NO_TIME_COLUMN: '无时间字段', NO_TIME_VALUE: '无时间值', ERROR: '检测失败' };
    function Freshness({ data }) {
      if (!data) return h('span', { className: 'ds-muted' }, '未检测');
      const time = data.lastDataAt;
      const text = time ? (data.dateOnly || !data.hasTimezone ? time.replace('T', ' ') : formatDate(time, true)) : freshnessLabels[data.status] || '—';
      const detail = [data.timeColumn && `字段 ${data.timeColumn}`, data.scannedAt && `检测于 ${formatDate(data.scannedAt, true)}`, data.error].filter(Boolean).join(' · ');
      return h('div', { title: detail }, h('span', null, text), data.timeColumn && h('div', { className: 'ds-muted' }, data.timeColumn));
    }

    function recentEnough(data, days, now = new Date()) {
      if (!days) return true;
      if (data?.status !== 'OK' || !data.lastDataAt) return false;
      const value = data.lastDataAt;
      const lower = new Date(now);
      lower.setDate(lower.getDate() - Number(days));
      if (data.dateOnly) {
        const localDate = (date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
        return value >= localDate(lower) && value <= localDate(now);
      }
      const time = Date.parse(value);
      return time >= lower.getTime() && time <= now.getTime();
    }

    const domainOf = (table) => table.domain || (table.category === 'SYSTEM' ? '系统支撑' : table.category === 'UNKNOWN' ? '其他' : '未归域');
    function tableNames(tables) {
      const counts = new Map();
      for (const table of tables) counts.set(table.name, (counts.get(table.name) || 0) + 1);
      return new Map(tables.map((table) => [table.id, counts.get(table.name) > 1 && table.schema ? `${table.schema}.${table.name}` : table.name]));
    }

    function TableDialog({ table, name, sourceId, snapshotId, canSample, onClose }) {
      const [samples, setSamples] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const readSamples = async () => {
        if (request.current) return;
        const controller = new AbortController();
        request.current = controller;
        setSamples({ loading: true });
        try {
          const result = await api('flow-samples', { id: sourceId, tableId: table.id, snapshotId }, controller.signal);
          if (!controller.signal.aborted) setSamples(result);
        } catch (error) { if (!controller.signal.aborted) setSamples({ sampleStatus: 'failed', error: error.message }); }
        finally { request.current = null; }
      };
      const fields = table.fields || [];
      const formatValue = (value) => typeof value === 'string' ? value : JSON.stringify(value);
      const rows = fields.map((field) => {
        const index = samples?.fieldNames?.indexOf(field.name) ?? -1;
        const examples = index < 0 ? [] : samples.samples.map((row) => row[index]).filter((value) => value !== undefined).slice(0, 5);
        return h('tr', { key: field.name }, cell(field.name), cell(field.type || '—'), cell(field.primaryKey ? '是' : '否'),
          cell(field.notNull ? '是' : '否'), cell(field.sourceComment || '—'), samples?.fieldNames && cell(examples.map(formatValue).join('；') || '—'));
      });
      return h(Dialog, { title: name, testId: 'field-detail-dialog', onClose, wide: true,
        footer: h('div', { className: 'ds-modal-foot' }, canSample && (!samples?.fieldNames || samples.sampleStatus === 'failed') &&
          button(samples?.loading ? '正在读取…' : '加载样例', () => void readSamples(), { disabled: samples?.loading }), button('关闭', onClose)) },
        table.sourceComment && h('p', { className: 'ds-space ds-text' }, table.sourceComment),
        h(DataTable, { className: 'ds-small-table', labels: ['字段', '类型', '主键', '非空', '原始注释', ...(samples?.fieldNames ? ['样例'] : [])], rows, empty: '没有字段' }),
        samples?.sampleStatus === 'failed' && noticeView({ type: 'error', text: samples.error || '加载样例失败。' }),
        samples?.sampleStatus && samples.sampleStatus !== 'failed' && !samples.samples?.length && h('p', { className: 'ds-muted ds-space' }, '暂无样例'));
    }

    function CatalogTable({ tables, names, filters, onFilter, newIds, showNew, onShowAll, chosen, onChoose, onClear, disabled, onStatus, onInspect }) {
      const [page, setPage] = useState(1);
      const [onlySelected, setOnlySelected] = useState(false);
      const selection = tables.filter(({ id }) => chosen.has(id));
      const domains = [...new Set(tables.map(domainOf))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const filtered = tables.filter((table) => {
        const { id, sourceComment, freshness } = table;
        return (!showNew || newIds.has(id)) && (!onlySelected || chosen.has(id)) &&
          matches(filters.search, names.get(id), sourceComment) && (!filters.domain || domainOf(table) === filters.domain) &&
          (!filters.empty || filters.empty === (freshness?.empty == null ? 'unknown' : freshness.empty ? 'yes' : 'no')) && recentEnough(freshness, filters.days);
      });
      const currentPage = shownPage(page, filtered);
      const first = useRef(null);
      useEffect(() => {
        if (showNew) {
          setOnlySelected(false);
          setPage(1);
          first.current?.scrollIntoView?.({ block: 'nearest' });
        }
      }, [newIds, showNew]);
      const changeFilter = (key) => (value) => { setPage(1); onFilter(key, value); };
      const rows = pageRows(filtered, currentPage).map((table, index) => {
        const { id, enabled, freshness, sourceComment } = table;
        const name = names.get(id);
        return h('tr', { key: id, ref: index === 0 ? first : undefined, className: newIds.has(id) ? 'ds-new' : undefined },
          cell(check(`选择数据表 ${name}`, chosen.has(id), (value) => onChoose([id], value))),
          cell(h('div', { className: 'ds-actions' }, link(name, () => onInspect(id)), newIds.has(id) && tag('新增'))),
          cell(sourceComment || '—', { className: 'ds-ellipsis' }),
          cell(freshness?.empty == null ? '未知' : freshness.empty ? '是' : '否'), cell(h(Freshness, { data: freshness })),
          cell(button('', () => void onStatus([id], !enabled), { className: 'ds-switch', role: 'switch', 'aria-checked': enabled, 'aria-label': `启用 ${name}`, disabled })));
      });
      return h(React.Fragment, null,
        h('div', { className: 'ds-filters' }, searchInput('搜索表名或原始注释', filters.search, changeFilter('search')),
          selectInput('筛选时效', filters.days, changeFilter('days'), [['', '全部时效'], ['30', '近30天'], ['60', '近60天'], ['120', '近120天']]),
          selectInput('筛选业务域', filters.domain, changeFilter('domain'), [['', '全部业务域'], ...domains.map((domain) => [domain, domain])]),
          selectInput('筛选空表', filters.empty, changeFilter('empty'), [['', '全部表'], ['yes', '空表'], ['no', '非空表'], ['unknown', '未知']]),
          showNew && link('返回全部表', () => { setPage(1); onShowAll(); })),
        h('div', { className: 'ds-row ds-space' }, h('div', { className: 'ds-actions' },
          h('span', { className: 'ds-muted', role: 'status' }, `已选 ${selection.length} 张表`),
          link('清除所有勾选', () => { setPage(1); onClear(); }, { disabled: !selection.length }),
          h('label', { className: 'ds-check' }, check('仅看已选', onlySelected, (value) => { setPage(1); setOnlySelected(value); }), '仅看已选')),
          h('div', { className: 'ds-actions' }, ...[[true, '批量启用'], [false, '批量停用']].map(([enabled, label]) =>
            button(label, () => void onStatus(selection.map(({ id }) => id), enabled), { key: label, disabled: disabled || !selection.length })))),
        h(DataTable, { className: 'ds-catalog-table', testId: 'catalog-table', rows, labels: [
          h(SelectAll, { label: '全选当前筛选数据表', rows: filtered, chosen, onChange: (value) => onChoose(filtered.map(({ id }) => id), value) }),
          '表英文名', '原始注释', '是否空表', '最近数据时间', '启用'] }),
        h(Pagination, { page: currentPage, count: filtered.length, onPage: setPage }));
    }

    function FlowDetail({ item, onBack, onCatalog, openSession, initialScan }) {
      const [flow, setFlow] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null), [sessionId, setSessionId] = useState(null), [toast, setToast] = useState(0);
      const [chosen, setChosen] = useState(() => new Set()), [filters, setFilters] = useState(emptyFilters);
      const [newIds, setNewIds] = useState(() => new Set()), [showNew, setShowNew] = useState(false), [inspect, setInspect] = useState(null);
      const [aiOpen, setAiOpen] = useState(false), [resultOpen, setResultOpen] = useState(false), [questionResultOpen, setQuestionResultOpen] = useState(false);
      const [refreshAt, setRefreshAt] = useState(null), [startedAt, setStartedAt] = useState(0);
      const lifetime = useRef(null), state = useRef(null), active = useRef(null), latestTaskId = useRef(null);
      const enabled = flow?.enabled ?? item.enabled;
      const catalog = flow?.catalog;
      const tables = catalog?.tables || [];
      const names = tableNames(tables);
      const inspected = tables.find(({ id }) => id === inspect);
      const hasRecommendation = resultOpen && !!flow?.draft;
      const hasModal = aiOpen || hasRecommendation || questionResultOpen || !!inspected;
      const applyState = (value) => {
        const previous = state.current;
        state.current = value;
        setFlow(value);
        if (!value.draft) setResultOpen(false);
        if (!value.questionDraft) setQuestionResultOpen(false);
        onCatalog(item.id, item.connectionVersion, value.catalog?.tables.length ?? null);
        if (value.removedTableIds?.length) setChosen((current) => withChecked(current, value.removedTableIds, false));
        if (previous?.catalog && value.addedTableIds?.length) {
          setNewIds(new Set(value.addedTableIds));
          setFilters(emptyFilters);
          setShowNew(true);
          setToast(value.addedTableIds.length);
        }
      };
      const read = async (signal) => {
        const { state: value } = await api('flow-state', { id: item.id }, signal);
        if (!signal.aborted) applyState(value);
      };
      const taskRunning = (task) => task && ['running', 'cancelling'].includes(task.status);
      const taskQuery = (key, value, signal) => api(`ai-tasks?${key}=${encodeURIComponent(value)}`, undefined, signal);
      const observeTask = async (operation, initial) => {
        const { signal } = operation.controller;
        let task = initial;
        while (!signal.aborted) {
          operation.taskId = task.taskId;
          latestTaskId.current = task.taskId;
          operation.action = task.kind;
          setBusy(task.kind);
          setStartedAt(Date.parse(task.startedAt) || Date.now());
          if (task.sessionId) setSessionId(task.sessionId);
          if (operation.cancelRequested && taskRunning(task)) {
            operation.cancelRequested = false;
            try { await api('ai-tasks/cancel', { taskId: task.taskId }, signal); }
            catch (error) { if (!signal.aborted) setNotice(errorNotice(error)); }
            if (signal.aborted) return false;
          }
          if (!taskRunning(task)) {
            await read(signal);
            if (signal.aborted) return false;
            if (task.status === 'failed') setNotice(errorNotice(new Error(task.error?.message || 'AI 任务失败，请重试。')));
            if (task.status === 'cancelled') setNotice({ type: 'info', text: '操作已取消。' });
            return task.status === 'succeeded';
          }
          await new Promise((resolve) => {
            const stop = () => { window.clearTimeout(timer); resolve(); };
            const timer = window.setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1000);
            signal.addEventListener('abort', stop, { once: true });
          });
          if (signal.aborted) return false;
          ({ task } = await taskQuery('taskId', task.taskId, signal));
        }
        return false;
      };
      const run = async (action, values = {}) => {
        const signal = lifetime.current.signal;
        if (active.current || signal.aborted) return false;
        const controller = new AbortController();
        const isAi = ['detect-domains', 'suggest', 'generalize-question'].includes(action);
        const operation = { id: operationId(), controller, isAi, cancellable: !!operationLabels[action], canceling: false };
        active.current = operation;
        setStartedAt(Date.now());
        setBusy(action);
        setNotice(null);
        if (isAi) setRefreshAt(null);
        const inputRevision = state.current?.revision;
        try {
          const input = { id: item.id, action, revision: inputRevision, ...values };
          if (isAi) {
            let task, accepted = true;
            try { ({ task } = await api('ai-tasks', input, controller.signal)); }
            catch (error) {
              if (signal.aborted || controller.signal.aborted) return false;
              // A lost acceptance response must be recovered by observation, never by resubmitting.
              if (error.status && error.status !== 409) throw error;
              accepted = error.status !== 409;
              ({ task } = await taskQuery('sourceId', item.id, controller.signal));
              if (!task || (!taskRunning(task) && task.taskId === latestTaskId.current)) throw error;
            }
            const succeeded = await observeTask(operation, task);
            return accepted && succeeded && task.kind === action;
          }
          const result = await api('flow-action', { ...input, operationId: operation.id }, controller.signal);
          if (signal.aborted || controller.signal.aborted) return false;
          applyState(result.state);
          if (action !== 'cancel') setSessionId(result.sessionId || null);
          return true;
        } catch (error) {
          if (signal.aborted || controller.signal.aborted || operation.canceling) return false;
          setNotice(errorNotice(error));
          if (error.sessionId) setSessionId(error.sessionId);
          if (error.status === 409) {
            try { await read(signal); } catch { /* Keep the conflict visible. */ }
          }
          return false;
        } finally {
          if (active.current === operation) active.current = null;
          if (!signal.aborted) setBusy('');
        }
      };
      const cancel = async () => {
        const operation = active.current;
        if (!operation || operation.canceling || !operation.cancellable) return;
        operation.canceling = true;
        try {
          if (operation.isAi) {
            if (!operation.taskId) { operation.cancelRequested = true; return; }
            await api('ai-tasks/cancel', { taskId: operation.taskId }, operation.controller.signal);
            // Keep observing: cancellation can race with a successful business commit.
          } else {
            const { state: value } = await api('flow-action', { id: item.id, action: 'cancel', operationId: operation.id }, operation.controller.signal);
            if (!lifetime.current.signal.aborted && active.current === operation) {
              applyState(value);
              operation.controller.abort();
            }
          }
        } catch (error) { if (!lifetime.current.signal.aborted) setNotice(errorNotice(error)); }
        finally { operation.canceling = false; }
      };
      const refresh = async (automatic = false, open = false) => {
        setRefreshAt(null);
        if (await run(automatic ? 'ensure-scan' : 'scan', automatic ? { open } : {})) setRefreshAt(Date.now() + pendingRefresh);
      };
      const load = async () => {
        const { signal } = lifetime.current;
        setLoading(true);
        setNotice(null);
        let recovered = false;
        try {
          if (initialScan) await initialScan.catch(() => {});
          const { task } = await taskQuery('sourceId', item.id, signal);
          if (signal.aborted) return;
          recovered = !!task;
          latestTaskId.current = task?.taskId || null;
          if (task?.sessionId) setSessionId(task.sessionId);
          await read(signal);
          if (signal.aborted) return;
          if (taskRunning(task)) {
            const operation = { controller: new AbortController(), isAi: true, cancellable: true, canceling: false };
            active.current = operation;
            setLoading(false);
            try { await observeTask(operation, task); }
            finally { if (active.current === operation) active.current = null; if (!signal.aborted) setBusy(''); }
          } else if (task?.status === 'failed') setNotice(errorNotice(new Error(task.error?.message || 'AI 任务失败，请重试。')));
        } catch (error) { if (!signal.aborted) setNotice(errorNotice(error)); }
        finally { if (!signal.aborted) setLoading(false); }
        if (!recovered && !signal.aborted && (state.current?.enabled ?? item.enabled) && state.current) await refresh(true, true);
      };
      useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        void load();
        return () => { controller.abort(); active.current?.controller.abort(); };
      }, []);
      useEffect(() => {
        if (!enabled || loading || busy || hasModal || !refreshAt) return undefined;
        const timer = window.setTimeout(() => void refresh(true), Math.max(0, refreshAt - Date.now()));
        return () => window.clearTimeout(timer);
      }, [enabled, loading, busy, hasModal, refreshAt]);
      useEffect(() => {
        if (!toast) return undefined;
        const timer = window.setTimeout(() => setToast(0), 4500);
        return () => window.clearTimeout(timer);
      }, [toast, newIds]);
      const setTables = (tableIds, nextEnabled) => run('set-tables', { tableIds, enabled: nextEnabled });
      const onSession = () => {
        try { if (openSession(sessionId)) return; } catch { /* The session identifier remains available. */ }
        setNotice({ type: 'info', text: `会话 ID ${sessionId}` });
      };
      const discardDraft = async () => {
        if (!state.current?.draft || await run('cancel', { draftId: state.current.draft.id })) setResultOpen(false);
      };
      const submitBasis = async (values) => {
        if (await run('suggest', values)) { setAiOpen(false); setResultOpen(true); }
      };
      const locked = !!busy;
      return h(React.Fragment, null,
        h('div', { className: 'ds-space' }, link('返回数据源', onBack)),
        h('header', { className: 'ds-header' }, h('div', null, h('h1', null, item.name),
          h('p', { className: 'ds-muted' }, [engineName(item.engine), catalog ? `${tables.length} 张表` : '尚未扫描', !enabled && '已停用'].filter(Boolean).join(' · '))),
        h('div', { className: 'ds-actions' }, sessionId && link('查看分析会话', onSession),
          button('刷新目录', () => void refresh(), { disabled: !enabled || !flow || locked }),
          button('时效检测', () => void run('detect-freshness'), { disabled: !enabled || !tables.length || locked }),
          flow?.questionDraft && button('查看泛化结果', () => setQuestionResultOpen(true), { disabled: locked }),
          flow?.draft ? button('查看推荐结果', () => setResultOpen(true), { disabled: locked, className: 'ds-button primary' }) :
            button('AI 辅助选表', () => setAiOpen(true), { disabled: !enabled || !tables.length || locked, className: 'ds-button primary' }))),
        noticeView(!aiOpen && !resultOpen ? notice : null),
        operationLabels[busy] && !aiOpen && h(LoadingBar, { action: busy, startedAt, onCancel: () => void cancel() }),
        loading ? h('p', { role: 'status' }, '正在加载目录…') :
          !flow ? button('重新加载', () => void load()) :
            catalog && h(React.Fragment, null,
              h('p', { className: 'ds-muted' }, `最近刷新 ${formatDate(catalog.scannedAt, true)}`),
              h(CatalogTable, { tables, names, filters, onFilter: (key, value) => setFilters((current) => ({ ...current, [key]: value })), newIds, showNew,
                onShowAll: () => { setShowNew(false); setToast(0); }, chosen, onChoose: (ids, checked) => setChosen((current) => withChecked(current, ids, checked)),
                onClear: () => setChosen(new Set()), disabled: locked, onStatus: setTables, onInspect: setInspect })),
        toast > 0 && h('div', { className: 'ds-notice ds-toast', role: 'status' }, `发现 ${toast} 张新表`, link('关闭提示', () => setToast(0))),
        inspected && h(TableDialog, { key: `${catalog.id}:${inspect}`, table: inspected, name: names.get(inspect), sourceId: item.id,
          snapshotId: catalog.id, canSample: enabled && inspected.tableKind === 'table', onClose: () => setInspect(null) }),
        aiOpen && h(BasisDialog, { sourceId: item.id, initialQuestions: flow.questions || [], domains: catalog.domains || [], names, tables, enabled,
          busy, startedAt, notice, onAction: run,
          onGeneralize: async (selected) => await run('generalize-question', { questions: selected.map(({ id, version }) => ({ id, version })) })
            ? { draft: state.current.questionDraft, questions: state.current.questions } : null,
          onQuestionsChanged: (questions) => applyState({ ...state.current, questions }),
          onConfirmQuestions: async (values) => await run('confirm-question-draft', values) ? state.current.questions : null,
          onClose: () => { setAiOpen(false); setNotice(null); }, onCancel: () => void cancel(),
          onDetect: () => run('detect-domains'), onSuggest: submitBasis }),
        questionResultOpen && flow?.questionDraft && h(QuestionDraftDialog, { key: flow.questionDraft.id, draft: flow.questionDraft,
          questions: flow.questions || [], tables, names, busy, notice,
          onClose: async () => { if (await run('cancel', { questionDraftId: flow.questionDraft.id })) setQuestionResultOpen(false); },
          onConfirm: async (candidates) => { if (await run('confirm-question-draft', { draftId: flow.questionDraft.id, candidates })) setQuestionResultOpen(false); } }),
        resultOpen && flow?.draft && h(RecommendationDialog, { key: flow.draft.id, draft: flow.draft, tables, names, busy: locked, notice,
          onClose: discardDraft, onConfirm: async (selectedTableIds) => {
            if (await run('confirm-selection', { draftId: flow.draft.id, selectedTableIds })) setResultOpen(false);
          } }));
    }

    const questionOrigin = (question) => ({ original: '原问题', generated: '泛化问题' }[question.origin] || '来源待确认');

    function TableLinks({ links, tables, names, questionVersion }) {
      const byId = new Map(tables.map((table) => [table.id, table]));
      return h('div', { className: 'ds-table-links' }, links.map((entry) => {
        const table = byId.get(entry.tableId);
        const fieldNames = entry.fields?.map((name) => {
          const comment = table?.fields?.find((field) => field.name === name)?.sourceComment;
          return comment ? `${name}（${comment}）` : name;
        }).join('、');
        return h('div', { key: entry.tableId, className: 'ds-table-link' },
          h('div', { className: 'ds-table-link-head' }, h('span', { className: 'ds-table-name' }, names.get(entry.tableId) || table?.name || entry.tableId),
            table?.sourceComment && h('span', { className: 'ds-muted' }, table.sourceComment),
            questionVersion !== undefined && (!table || entry.structureHash !== table.structureHash || entry.questionVersion !== questionVersion) && tag('待重新分析')),
          h('details', { className: 'ds-link-details' }, h('summary', null, '关联详情'),
            h('dl', null, h('dt', null, '字段'), h('dd', null, fieldNames || '—'),
              h('dt', null, '依据'), h('dd', null, entry.reason || '—'))));
      }));
    }

    function QuestionDialog({ question, names, tables, sourceId, onClose, onSaved }) {
      const [draft, setDraft] = useState(() => ({ text: question?.text || '', answer: question?.answer || '' }));
      const [busy, setBusy] = useState(false), [notice, setNotice] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const save = async (event) => {
        event.preventDefault();
        if (request.current) return;
        const text = draft.text.trim();
        if (!text) { setNotice({ type: 'error', text: '请填写问题。' }); return; }
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setNotice(null);
        const current = question ? { id: question.id, version: question.version } : {};
        try {
          const { item } = await api('questions-save', { ...current, text, answer: draft.answer.trim() }, controller.signal);
          if (!controller.signal.aborted) await onSaved(item, controller.signal);
        } catch (error) { if (!controller.signal.aborted) setNotice(errorNotice(error)); }
        finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      const change = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
      const links = question?.links?.filter((entry) => entry.sourceId === sourceId) || [];
      return h(Dialog, { title: question ? '编辑问题' : '新增问题', testId: 'question-dialog', busy, onClose,
        formProps: { onSubmit: (event) => void save(event) },
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: busy }),
          h('button', { type: 'submit', className: 'ds-button primary', disabled: busy }, busy ? '正在保存…' : '保存')) },
        noticeView(notice), h('div', { className: 'ds-stack' },
          h(Field, { name: 'text', label: '问题', draft, change, multiline: true, rows: 3, required: true, disabled: busy, autoFocus: true }),
          h(Field, { name: 'answer', label: '答案（选填）', draft, change, multiline: true, rows: 3, disabled: busy }),
          question && h('section', null, h('h3', null, '关联数据表'), links.length
            ? h(TableLinks, { links, tables, names, questionVersion: question.version })
            : h('p', { className: 'ds-muted' }, question.analysisStatus === 'empty' ? '已分析未找到关联表'
              : question.analysisStatus === 'stale' ? '关联待重新分析' : '尚未分析关联'))));
    }

    function QuestionsDialog({ questions, chosen, onChoose, onChooseMany, onEdit, onRemove, onGeneralize, onClose, notice, busy, startedAt, onCancel }) {
      const [search, setSearch] = useState(''), [page, setPage] = useState(1);
      const filtered = questions.filter(({ text, answer }) => matches(search, text, answer));
      const currentPage = shownPage(page, filtered);
      const selected = questions.filter(({ id }) => chosen.has(id));
      const rows = pageRows(filtered, currentPage).map((question) => h('tr', { key: question.id },
        cell(check(`参考问题 ${question.text}`, chosen.has(question.id), (value) => onChoose(question.id, value), { disabled: !!busy })),
        cell(h('div', { className: 'ds-question-text' }, h('span', { className: 'ds-text' }, question.text), tag(questionOrigin(question)))),
        cell(h('div', { className: 'ds-text ds-ellipsis' }, question.answer || '—')),
        cell(h('div', { className: 'ds-question-actions' }, button('编辑', () => onEdit(question), { disabled: !!busy, 'aria-label': `查看或编辑 ${question.text}` }),
          button('删除', () => onRemove(question), { disabled: !!busy, className: 'ds-button danger', 'aria-label': `删除 ${question.text}` })))));
      return h(Dialog, { title: '问题列表', testId: 'questions-dialog', onClose, wide: true, busy: !!busy,
        footer: h(React.Fragment, null, h(Pagination, { page: currentPage, count: filtered.length, onPage: setPage }),
          h('div', { className: 'ds-modal-foot' }, button('完成', onClose, { disabled: !!busy }))) },
        noticeView(notice), operationLabels[busy] && h(LoadingBar, { action: busy, startedAt, onCancel }),
        h('div', { className: 'ds-row ds-space' }, h('div', { className: 'ds-filters' }, searchInput('搜索问题或答案', search, (value) => { setSearch(value); setPage(1); })),
          h('div', { className: 'ds-actions' }, button('泛化问题', onGeneralize, { disabled: !!busy || !questions.some(({ origin }) => origin === 'original') }),
            button('新增问题', () => onEdit(null), { disabled: !!busy, className: 'ds-button primary' }))),
        h('div', { className: 'ds-row ds-space' },
          h('span', { className: 'ds-muted', role: 'status' }, `已选 ${selected.length} / ${questions.length} 个问题`),
          h('div', { className: 'ds-actions' },
            button(`删除已选（${selected.length}）`, () => onRemove(selected), { className: 'ds-button danger compact', disabled: !!busy || !selected.length }),
            h('label', { className: 'ds-check' }, h(SelectAll, { label: '全选当前搜索问题', rows: filtered, chosen, disabled: !!busy,
              onChange: (value) => onChooseMany(filtered.map(({ id }) => id), value) }), '全选'))),
        h(DataTable, { className: 'ds-questions-table', labels: ['参考', '问题', '答案', '操作'], rows, empty: '没有匹配的问题' }));
    }

    function OriginalQuestionsDialog({ questions, chosen, onChoose, onClose, onStart, busy }) {
      const [search, setSearch] = useState('');
      const originals = questions.filter(({ origin }) => origin === 'original');
      const filtered = originals.filter(({ text, answer }) => matches(search, text, answer));
      const selected = originals.filter(({ id }) => chosen.has(id));
      return h(Dialog, { title: '选择原问题', testId: 'original-questions-dialog', size: 'originals', internalScroll: true, busy: !!busy, onClose,
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: !!busy }),
          button('开始泛化', () => void onStart(selected), { className: 'ds-button primary', disabled: !!busy || !selected.length })) },
        h('div', { className: 'ds-row ds-space' }, h('div', { className: 'ds-filters', style: { flex: 1, margin: 0 } }, searchInput('搜索原问题或答案', search, setSearch)),
          h('label', { className: 'ds-check' }, h(SelectAll, { label: '全选当前搜索原问题', rows: filtered, chosen, disabled: !!busy,
            onChange: (value) => onChoose(filtered.map(({ id }) => id), value) }), '全选')),
        h('p', { className: 'ds-muted', role: 'status' }, `已选 ${selected.length} / ${originals.length} 个原问题`),
        h('div', { className: 'ds-stack ds-reference-list' }, filtered.map((question) => h('label', { key: question.id, className: 'ds-question-option' },
          check(`泛化参考 ${question.text}`, chosen.has(question.id), (value) => onChoose([question.id], value), { disabled: !!busy }),
          h('span', { className: 'ds-text' }, question.text))),
        !filtered.length && h('p', { className: 'ds-empty' }, '没有匹配的原问题')));
    }

    function QuestionDraftDialog({ draft, questions, tables, names, busy, notice, onClose, onConfirm }) {
      const [candidates, setCandidates] = useState(() => draft.candidates.map((candidate) => ({ ...candidate })));
      const [chosen, setChosen] = useState(() => new Set(draft.candidates.map(({ id }) => id)));
      const [error, setError] = useState(null);
      const selected = candidates.filter(({ id }) => chosen.has(id));
      const confirm = () => {
        if (!selected.length || selected.length > 20 || selected.some(({ text }) => !text.trim())) {
          setError({ type: 'error', text: '请选择 1～20 个问题，并填写所选问题内容。' });
          return;
        }
        setError(null);
        void onConfirm(selected.map(({ id, text }) => ({ id, text: text.trim() })));
      };
      return h(Dialog, { title: '泛化问题候选', testId: 'question-draft-dialog', wide: true, internalScroll: true, busy: !!busy, onClose,
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: !!busy }),
          button('保存所选', confirm, { className: 'ds-button primary', disabled: !!busy || !selected.length })) },
        noticeView(error || notice),
        h('details', { className: 'ds-link-details ds-reference-summary' }, h('summary', null, `参考 ${draft.questions.length} 个原问题`),
          h('div', { className: 'ds-stack' }, draft.questions.map(({ id, version }) => {
            const question = questions.find((entry) => entry.id === id && entry.version === version);
            return h('div', { key: id }, h('p', { className: 'ds-text' }, question?.text || id), question?.answer && h('p', { className: 'ds-muted ds-text' }, question.answer));
          }))),
        draft.reason && h('p', { className: 'ds-muted ds-space' }, draft.reason),
        draft.sampleNote && h('p', { className: 'ds-muted ds-space' }, draft.sampleNote),
        busy && h('p', { role: 'status' }, busy === 'cancel' ? '正在取消…' : '正在保存所选问题…'),
        h('div', { className: 'ds-row' }, h('label', { className: 'ds-check' },
          h(SelectAll, { label: '全选泛化候选', rows: candidates, chosen, disabled: !!busy,
            onChange: (value) => setChosen((current) => withChecked(current, candidates.map(({ id }) => id), value)) }), '全选'),
          h('span', { className: 'ds-muted' }, `已选 ${selected.length} / ${candidates.length} 个问题`)),
        h('div', { className: 'ds-stack ds-draft-list' }, candidates.map((candidate, index) => h('div', { key: candidate.id, className: 'ds-draft-candidate' },
          h('div', { className: 'ds-draft-editor' },
            check(`选择泛化候选 ${index + 1}`, chosen.has(candidate.id), (value) => setChosen((current) => withChecked(current, [candidate.id], value)), { disabled: !!busy }),
            h('textarea', { 'aria-label': `泛化候选 ${index + 1}`, value: candidate.text, rows: 2, disabled: !!busy,
              onChange: (event) => setCandidates((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, text: event.target.value } : entry)) })),
          candidate.text.trim() !== draft.candidates.find(({ id }) => id === candidate.id).text.trim() && h('p', { className: 'ds-muted' }, '内容已修改，关联待重新分析'),
          h(TableLinks, { links: candidate.links || [], tables, names })))));
    }

    function BasisDialog({ sourceId, initialQuestions, domains, names, tables, enabled, busy, startedAt, notice, onClose, onCancel, onDetect, onSuggest, onAction, onGeneralize, onConfirmQuestions, onQuestionsChanged }) {
      const [questions, setQuestions] = useState(initialQuestions);
      const [chosen, setChosen] = useState(() => new Set(initialQuestions.map(({ id }) => id)));
      const [chosenDomains, setChosenDomains] = useState(() => new Set());
      const [more, setMore] = useState(false), [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null);
      const [error, setError] = useState(null), [questionDraft, setQuestionDraft] = useState(null);
      const [originalsOpen, setOriginalsOpen] = useState(false), [generalizeChosen, setGeneralizeChosen] = useState(() => new Set());
      const [suggestLabel, setSuggestLabel] = useState('');
      useEffect(() => {
        const controller = new AbortController();
        api('questions-list', { id: sourceId }, controller.signal).then(({ items }) => {
          if (!controller.signal.aborted) setQuestions(items);
        }).catch((failure) => { if (!controller.signal.aborted) setError(errorNotice(failure)); });
        return () => controller.abort();
      }, [sourceId]);
      const chooseMany = (ids, checked) => setChosen((current) => withChecked(current, ids, checked));
      const choose = (id, checked) => chooseMany([id], checked);
      const selectedQuestions = questions.filter(({ id }) => chosen.has(id));
      const questionIds = selectedQuestions.map(({ id }) => id);
      const reusableCount = selectedQuestions.filter(({ analysisStatus }) => analysisStatus === 'linked').length;
      const emptyCount = selectedQuestions.filter(({ analysisStatus }) => analysisStatus === 'empty').length;
      const analysisCount = selectedQuestions.length - reusableCount - emptyCount;
      const selectedDomains = domains.filter(({ name }) => chosenDomains.has(name)).map(({ name }) => name);
      const submit = () => {
        if (!questionIds.length && !selectedDomains.length) {
          setError({ type: 'error', text: '请至少选择一个问题或业务域。' });
          return;
        }
        setError(null);
        setSuggestLabel(analysisCount ? `正在复用 ${reusableCount} 个问题关联，分析 ${analysisCount} 个问题` : '正在合并已分析结果');
        void onSuggest({ questionIds, domains: selectedDomains });
      };
      const startEdit = (question) => { setError(null); setEditing({ question }); };
      const saveQuestion = async (question, signal) => {
        const { items } = await api('questions-list', { id: sourceId }, signal);
        if (signal.aborted) return;
        setQuestions(items);
        onQuestionsChanged(items);
        if (!editing.question) choose(question.id, true);
        setEditing(null);
      };
      const removeQuestion = async ({ id, version }, signal) => {
        await api('questions-remove', { id, version }, signal);
        if (signal.aborted) return;
        setQuestions((current) => current.filter((question) => question.id !== id));
        choose(id, false);
        setGeneralizeChosen((current) => withChecked(current, [id], false));
      };
      const generalize = async (selected) => {
        setError(null);
        setOriginalsOpen(false);
        const result = await onGeneralize(selected);
        if (result) {
          setQuestions(result.questions);
          setQuestionDraft(result.draft);
        }
      };
      const cancelQuestionDraft = async () => {
        if (await onAction('cancel', { questionDraftId: questionDraft.id })) setQuestionDraft(null);
      };
      const confirmQuestionDraft = async (candidates) => {
        const updated = await onConfirmQuestions({ draftId: questionDraft.id, candidates });
        if (!updated) return;
        const previousIds = new Set(questions.map(({ id }) => id));
        setChosen((current) => withChecked(current, updated.filter(({ id }) => !previousIds.has(id)).map(({ id }) => id), true));
        setQuestions(updated);
        setQuestionDraft(null);
      };
      return h(React.Fragment, null,
        h(Dialog, { title: 'AI 选表依据', testId: 'ai-selection-dialog', wide: true, size: 'basis', busy: !!busy, onClose,
          footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: !!busy }),
            button('AI 选表', submit, { className: 'ds-button primary', disabled: !enabled || !!busy })) },
          noticeView(error || notice), operationLabels[busy] && h(LoadingBar, { action: busy, startedAt, onCancel, label: busy === 'suggest' ? suggestLabel : undefined }),
          h('div', { className: 'ds-basis' },
            h('section', null, h('div', { className: 'ds-row' }, h('h3', null, '数据集辅助'), link('查看问题', () => { setMore(true); setError(null); }, { disabled: !!busy })),
              h('div', { className: 'ds-row ds-space' }, h('span', { className: 'ds-muted' }, `已选 ${questionIds.length} / ${questions.length} 个问题`),
                h('label', { className: 'ds-check' }, h(SelectAll, { label: '全选问题', rows: questions, chosen, disabled: !!busy,
                  onChange: (value) => chooseMany(questions.map(({ id }) => id), value) }), '全选')),
              h('p', { className: 'ds-muted' }, `可复用关联 ${reusableCount} 个，已分析无关联 ${emptyCount} 个，待分析 ${analysisCount} 个`),
              h('div', { className: 'ds-stack ds-basis-list' }, questions.map((question) => h('label', { key: question.id, className: 'ds-question-option' },
                check(`参考问题 ${question.text}`, chosen.has(question.id), (value) => choose(question.id, value), { disabled: !!busy }),
                h('span', { className: 'ds-text' }, question.text))),
                !questions.length && link('新增问题', () => startEdit(null), { disabled: !!busy }))),
            h('section', null, h('div', { className: 'ds-row' }, h('h3', null, '业务域辅助'),
              link(domains.length ? '重新识别' : '识别业务域', () => { setError(null); void onDetect(); }, { disabled: !enabled || !!busy })),
              h('div', { className: 'ds-row ds-space' }, h('span', { className: 'ds-muted' }, `已选 ${selectedDomains.length} / ${domains.length} 个业务域`),
                h('label', { className: 'ds-check' }, h(SelectAll, { label: '全选业务域', rows: domains.map(({ name }) => ({ id: name })), chosen: chosenDomains, disabled: !!busy,
                  onChange: (value) => setChosenDomains((current) => withChecked(current, domains.map(({ name }) => name), value)) }), '全选')),
              h('div', { className: 'ds-stack ds-basis-list' }, domains.map(({ name, description }) => h('label', { key: name, className: 'ds-check', title: description },
                check(`参考业务域 ${name}`, chosenDomains.has(name), (value) => setChosenDomains((current) => withChecked(current, [name], value)), { disabled: !!busy }), name)))))),
        more && h(QuestionsDialog, { questions, chosen, onChoose: choose, onChooseMany: chooseMany, onClose: () => { setMore(false); setError(null); },
          onEdit: startEdit, onRemove: (items) => setDeleting(Array.isArray(items) ? items : [items]), onGeneralize: () => { setOriginalsOpen(true); setError(null); }, notice: error || notice, busy, startedAt, onCancel }),
        originalsOpen && h(OriginalQuestionsDialog, { questions, chosen: generalizeChosen, onChoose: (ids, value) => setGeneralizeChosen((current) => withChecked(current, ids, value)),
          onClose: () => setOriginalsOpen(false), onStart: generalize, busy }),
        questionDraft && h(QuestionDraftDialog, { key: questionDraft.id, draft: questionDraft, questions, tables, names, busy, notice,
          onClose: () => void cancelQuestionDraft(), onConfirm: confirmQuestionDraft }),
        editing && h(QuestionDialog, { question: editing.question, names, tables, sourceId, onClose: () => setEditing(null), onSaved: saveQuestion }),
        deleting && h(DeleteDialog, { title: '删除问题', kind: '问题', items: deleting, onClose: () => setDeleting(null), onRemove: removeQuestion }));
    }

    function RecommendationDialog({ draft, tables, names, busy, notice, onClose, onConfirm }) {
      const [search, setSearch] = useState('');
      const permitted = new Set(draft.tableIds);
      const candidates = tables.filter(({ id }) => permitted.has(id));
      const recommended = new Set(draft.recommendations.map(({ tableId }) => tableId));
      const domainMatches = new Map();
      for (const { tableId, domain } of draft.domainMatches || []) domainMatches.set(tableId, [...(domainMatches.get(tableId) || []), domain]);
      const [selected, setSelected] = useState(() => new Set(draft.selectedTableIds));
      const filtered = candidates.filter((table) => matches(search, names.get(table.id), table.sourceComment, domainOf(table)));
      const rows = filtered.map((table) => {
        const { id, enabled, sourceComment } = table;
        const name = names.get(id);
        return h('tr', { key: id }, cell(check(`确认启用 ${name}`, selected.has(id), (value) => setSelected((current) => withChecked(current, [id], value)), { disabled: busy })),
          cell(name), cell(sourceComment || '—'), cell(domainOf(table)), cell(h(React.Fragment, null,
            enabled && tag('已启用'), recommended.has(id) && tag('AI 推荐'),
            (domainMatches.get(id) || []).map((domain) => h('span', { key: domain, className: 'ds-tag' }, `匹配业务域：${domain}`)))));
      });
      const selectedTableIds = candidates.filter(({ id }) => selected.has(id)).map(({ id }) => id);
      return h(Dialog, { title: '确认推荐结果', testId: 'recommendation-dialog', wide: true, internalScroll: true, busy, onClose,
        footer: h('div', { className: 'ds-modal-foot' }, button('取消', onClose, { disabled: busy }),
          button('确认启用状态', () => void onConfirm(selectedTableIds), { className: 'ds-button primary', disabled: busy })) },
        noticeView(notice), h('div', { className: 'ds-row ds-space' }, h('div', { className: 'ds-filters' },
          searchInput('搜索推荐范围', search, setSearch)),
          h('span', { className: 'ds-muted', role: 'status' }, `已选 ${selectedTableIds.length} / ${candidates.length} 张表`)),
        h(DataTable, { className: 'ds-recommendation-table', testId: 'recommendation-table', labels: [
          h(SelectAll, { label: '全选当前筛选推荐表', rows: filtered, chosen: selected, disabled: busy,
            onChange: (value) => setSelected((current) => withChecked(current, filtered.map(({ id }) => id), value)) }), '表英文名', '原始注释', '业务域', '推荐'], rows }));
    }
    return { name: 'sql', inject: ['slots', 'layout'], apply };
  },
});
