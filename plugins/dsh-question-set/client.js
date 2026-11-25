window.__ModuleLoader__.load({
  id: 'dsh-question-set',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const pageSize = 10;
    let lastSourceId = '';
    const active = (task) => task?.status === 'running' || task?.status === 'cancelling';
    const savable = (item) => !item.error && typeof item.answer === 'string' && !!item.answer.trim();
    const errorText = (error) => typeof error === 'string' ? error : error?.message || '操作失败，请重试。';
    const matches = (search, ...values) => values.some((value) => String(value ?? '').toLowerCase().includes(search.trim().toLowerCase()));
    const withChecked = (current, ids, checked) => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    };
    const css = `
.dsh-qs{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.dsh-qs,.dsh-qs *{box-sizing:border-box}.dsh-qs .qs-wrap{width:100%;min-width:0}.dsh-qs .qs-content{padding:22px 24px 32px;background:var(--dsw-alias-bg-module-platform);min-height:calc(100% - 78px)}
.dsh-qs h1,.dsh-qs h2,.dsh-qs h3,.dsh-qs p{margin:0}.dsh-qs h1{font-size:22px;font-weight:600}.dsh-qs h2{font-size:17px;font-weight:600}.dsh-qs .qs-related-title{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.dsh-qs button,.dsh-qs input,.dsh-qs select,.dsh-qs textarea{font:inherit;color-scheme:inherit}.dsh-qs button{cursor:pointer}.dsh-qs button:disabled{cursor:default;opacity:.5}
.dsh-qs :is(button,input,select,textarea):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-qs input:not([type=checkbox]),.dsh-qs select,.dsh-qs textarea{width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:7px 10px;background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}
.dsh-qs select option{background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}.dsh-qs textarea{resize:vertical}
.dsh-qs input[type=checkbox]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.dsh-qs .qs-header,.dsh-qs .qs-row,.dsh-qs .qs-actions,.dsh-qs .qs-filters,.dsh-qs .qs-pagination{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-qs .qs-header,.dsh-qs .qs-row,.dsh-qs .qs-toolbar,.dsh-qs .qs-pagination{justify-content:space-between}.dsh-qs .qs-header{padding:22px 24px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.dsh-qs .qs-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.dsh-qs .qs-filters{gap:10px}.dsh-qs .qs-filters input{width:min(260px,100%)}.dsh-qs .qs-filters select{width:auto;max-width:260px}.dsh-qs .qs-selection{margin-bottom:10px;min-height:30px}
.dsh-qs .qs-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-qs .qs-button{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l4);border-radius:7px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);white-space:nowrap;line-height:1.5}
.dsh-qs .qs-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-qs .qs-button.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.dsh-qs .qs-button.danger{color:var(--dsw-alias-state-error-primary)}
.dsh-qs .qs-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-qs table{border-collapse:collapse;width:100%;min-width:780px;text-align:left;font-size:13px;table-layout:fixed;color:var(--dsw-alias-label-primary)}
.dsh-qs th{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);white-space:nowrap}.dsh-qs th,.dsh-qs td{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:middle;overflow-wrap:anywhere}.dsh-qs tbody tr:last-child td{border-bottom:0}.dsh-qs tbody tr:nth-child(even){background:var(--dsw-alias-bg-base)}.dsh-qs th:first-child{width:44px}.dsh-qs th:last-child{width:160px}.dsh-qs .qs-main-table th:nth-child(4){width:140px}.dsh-qs .qs-main-table th:nth-child(5){width:100px}.dsh-qs .qs-results th:last-child{width:28%}.dsh-qs .qs-assessment{color:var(--dsw-alias-label-secondary)}.dsh-qs .qs-row-actions .qs-evaluate{border:0;background:transparent;padding:3px 0}
.dsh-qs .qs-empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-secondary)}.dsh-qs .qs-text{white-space:pre-wrap;overflow-wrap:anywhere}.dsh-qs .qs-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;padding:1px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);margin:4px 5px 0 0}
.dsh-qs .qs-pagination{margin-top:10px}.dsh-qs .qs-notice{padding:9px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:7px;background:var(--dsw-alias-interactive-bg-hover-danger);margin:8px 0 12px;overflow-wrap:anywhere}.dsh-qs .qs-error{color:var(--dsw-alias-state-error-primary)}
.dsh-qs .qs-answer-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}.dsh-qs .qs-status{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;margin:0 0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.dsh-qs .qs-status-main{display:grid;gap:6px;flex:1;min-width:200px}.dsh-qs .qs-status progress{width:min(360px,100%);height:6px;accent-color:var(--dsw-alias-brand-primary)}.dsh-qs .qs-status .qs-notice{margin:0}.dsh-qs .qs-links{display:grid;gap:7px}.dsh-qs .qs-links strong{font-weight:500}.dsh-qs .qs-row-actions{display:flex;gap:6px}.dsh-qs .qs-row-actions button{padding:3px 8px;font-size:12px}
.dsh-qs .qs-modal{width:min(620px,calc(100% - 24px));max-height:calc(100dvh - 24px);border:1px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0;box-shadow:0 20px 80px rgb(0 0 0 / .24)}.dsh-qs .qs-modal.qs-result-dialog{width:min(1040px,calc(100% - 24px))}.dsh-qs .qs-protocol{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:10px;color:var(--dsw-alias-label-secondary)}.dsh-qs .qs-protocol summary{cursor:pointer}.dsh-qs .qs-protocol p{margin-top:8px}.dsh-qs .qs-modal::backdrop{background:rgb(0 0 0 / .43)}.dsh-qs .qs-modal[open]{display:flex;flex-direction:column}.dsh-qs .qs-modal>form,.dsh-qs .qs-modal>div{display:flex;flex-direction:column;min-height:0}.dsh-qs .qs-modal-head,.dsh-qs .qs-modal-body,.dsh-qs .qs-modal-footer{padding:16px 20px}.dsh-qs .qs-modal-head{border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh-qs .qs-modal-body{overflow:auto}.dsh-qs .qs-modal-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end}.dsh-qs .qs-field{display:block;margin-bottom:14px}.dsh-qs .qs-field>span{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}.dsh-qs .qs-delete-list{padding-left:22px;max-height:240px;overflow:auto}
@media(max-width:650px){.dsh-qs .qs-header{padding:16px}.dsh-qs .qs-content{padding:16px 12px 24px}.dsh-qs .qs-toolbar>div{width:100%}.dsh-qs th,.dsh-qs td{padding:8px 10px}.dsh-qs .qs-modal-head,.dsh-qs .qs-modal-body,.dsh-qs .qs-modal-footer{padding:12px}}
    `;
    async function api(operation, input, signal) {
      const options = input === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) };
      const response = await fetch(`/api/question-set/${operation}`, { ...options, credentials: 'same-origin', cache: 'no-store', signal });
      let value;
      try { value = await response.json(); } catch { throw new Error('无法读取问题集服务的响应，请重试。'); }
      if (!response.ok) throw Object.assign(new Error(errorText(value?.error)), { status: response.status });
      return value;
    }
    const button = (label, onClick, props = {}) => h('button', { type: 'button', className: 'qs-button', onClick, ...props }, label);
    const check = (label, checked, onChange, props = {}) => h('input', { type: 'checkbox', 'aria-label': label, checked, onChange: (event) => onChange(event.target.checked), ...props });
    const cell = (value, props) => h('td', props, value);
    const notice = (error) => error && h('div', { className: 'qs-notice', role: 'alert' }, errorText(error));
    const origin = (question) => ({ original: '原问题', generated: '泛化问题' }[question.origin] || '来源待确认');
    function SelectAll({ label, rows, chosen, onChange, disabled }) {
      const count = rows.filter(({ id }) => chosen.has(id)).length;
      return check(label, !!rows.length && count === rows.length, onChange, { disabled: disabled || !rows.length,
        ref: (input) => { if (input) input.indeterminate = count > 0 && count < rows.length; } });
    }
    function DataTable({ labels, rows, testId, results }) {
      return h('div', { className: 'qs-table-wrap' }, h('table', { 'data-testid': testId, className: results ? 'qs-results' : 'qs-main-table' },
        h('thead', null, h('tr', null, labels.map((label, index) => h('th', { key: index, scope: 'col' }, label)))),
        h('tbody', null, rows.length ? rows : h('tr', null, cell('暂无问题', { colSpan: labels.length, className: 'qs-empty' })))));
    }
    function TableLinks({ links = [] }) {
      return links.length ? h('div', { className: 'qs-links' }, links.map((entry, index) => h('div', { key: `${entry.sourceId || ''}:${entry.schema || ''}:${entry.tableName}:${index}` },
        h('strong', null, entry.tableName || '—'),
        entry.sourceComment && h('div', { className: 'qs-muted' }, entry.sourceComment),
        entry.valid === false && h('span', { className: 'qs-tag' }, '关联待重新查询')))) : h('span', { className: 'qs-muted' }, '—');
    }
    function Dialog({ title, onClose, busy, children, footer, formProps, testId, wide }) {
      const ref = useRef(null);
      useEffect(() => {
        const previous = document.activeElement, dialog = ref.current;
        dialog.showModal();
        return () => { dialog.close(); previous?.focus?.(); };
      }, []);
      return h('dialog', { ref, className: `qs-modal${wide ? ' qs-result-dialog' : ''}`, 'aria-label': title, 'data-testid': testId,
        onCancel: (event) => { event.preventDefault(); if (!busy) onClose(); } },
      h('header', { className: 'qs-modal-head' }, h('h2', null, title)),
      h(formProps ? 'form' : 'div', formProps, h('div', { className: 'qs-modal-body' }, children), h('footer', { className: 'qs-modal-footer qs-actions' }, footer)));
    }
    function QuestionDialog({ question, onClose, onSaved }) {
      const [text, setText] = useState(question?.text || ''), [answer, setAnswer] = useState(question?.answer || '');
      const [busy, setBusy] = useState(false), [error, setError] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const save = async (event) => {
        event.preventDefault();
        if (request.current) return;
        if (!text.trim()) { setError('请填写问题。'); return; }
        const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
        try {
          await api('save', { ...(question ? { id: question.id, version: question.version } : {}), text: text.trim(), answer: answer.trim() }, controller.signal);
          if (!controller.signal.aborted) await onSaved(controller.signal);
        } catch (cause) { if (!controller.signal.aborted) setError(cause); }
        finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      const field = (label, value, change, props = {}) => h('label', { className: 'qs-field' }, h('span', null, label),
        h('textarea', { 'aria-label': label, value, onChange: (event) => change(event.target.value), disabled: busy, rows: 4, ...props }));
      const changeText = value => { setText(value); if (question && value !== question.text) setAnswer(''); };
      return h(Dialog, { title: question ? '编辑问题' : '新增问题', onClose, busy, testId: 'question-dialog', formProps: { onSubmit: (event) => void save(event) },
        footer: h(React.Fragment, null, button('取消', onClose, { disabled: busy }), h('button', { type: 'submit', className: 'qs-button primary', disabled: busy }, busy ? '正在保存…' : '保存')) },
      notice(error), field('问题', text, changeText, { required: true, autoFocus: true }), field('答案（选填）', answer, setAnswer), question && h('section', { 'aria-label': '关联表' }, h('h3', { className: 'qs-related-title' }, '关联表'), h(TableLinks, { links: question.links })));
    }
    function DeleteDialog({ items, onClose, onRemoved }) {
      const [pending, setPending] = useState(items), [busy, setBusy] = useState(false), [error, setError] = useState(null);
      const request = useRef(null);
      useEffect(() => () => request.current?.abort(), []);
      const remove = async () => {
        if (request.current) return;
        const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
        let remaining = pending;
        try {
          for (const item of pending) {
            await api('remove', { id: item.id, version: item.version }, controller.signal);
            if (controller.signal.aborted) return;
            remaining = remaining.filter(({ id }) => id !== item.id); setPending(remaining); onRemoved(item.id);
          }
          if (!controller.signal.aborted) onClose();
        } catch (cause) { if (!controller.signal.aborted) setError(cause); }
        finally { request.current = null; if (!controller.signal.aborted) setBusy(false); }
      };
      return h(Dialog, { title: '删除问题', onClose, busy, testId: 'delete-dialog', footer: h(React.Fragment, null,
        button('取消', onClose, { disabled: busy }), button(busy ? '正在删除…' : '删除', () => void remove(), { className: 'qs-button danger', disabled: busy })) },
      notice(error), h('p', null, `确认删除以下 ${pending.length} 个问题？`), h('ul', { className: 'qs-delete-list' }, pending.map((item) => h('li', { key: item.id }, item.text))));
    }
    function PromptDialog({ onClose }) {
      const [settings, setSettings] = useState(null), [draft, setDraft] = useState('');
      const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(null);
      const request = useRef(null);
      useEffect(() => {
        const controller = new AbortController(); request.current = controller;
        api('prompt-settings', undefined, controller.signal).then((value) => {
          if (!controller.signal.aborted) { setSettings(value); setDraft(value.prompt); }
        }).catch((cause) => { if (!controller.signal.aborted) setError(cause); })
          .finally(() => { if (!controller.signal.aborted) { request.current = null; setLoading(false); } });
        return () => request.current?.abort();
      }, []);
      const save = async (event) => {
        event.preventDefault();
        if (request.current) return;
        if (!draft.trim()) { setError('请填写泛化提示词。'); return; }
        const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
        try { await api('prompt-settings', { prompt: draft }, controller.signal); if (!controller.signal.aborted) onClose(); }
        catch (cause) { if (!controller.signal.aborted) setError(cause); }
        finally { if (!controller.signal.aborted) { request.current = null; setBusy(false); } }
      };
      return h(Dialog, { title: '泛化提示词', onClose, busy, testId: 'prompt-dialog', formProps: { onSubmit: (event) => void save(event) },
        footer: h(React.Fragment, null, button('恢复默认', () => setDraft(settings.defaultPrompt), { disabled: !settings || busy }),
          button('取消', onClose, { disabled: busy }), h('button', { type: 'submit', className: 'qs-button primary', disabled: loading || !settings || busy }, busy ? '正在保存…' : '保存')) },
      notice(error), loading ? h('p', { role: 'status' }, '正在加载…') : settings && h(React.Fragment, null,
        h('label', { className: 'qs-field' }, h('span', null, '提示词'), h('textarea', { 'aria-label': '提示词', value: draft, rows: 12, maxLength: 20000, disabled: busy, onChange: (event) => setDraft(event.target.value) })),
        h('details', { className: 'qs-protocol' }, h('summary', null, '工具调用说明'), h('p', null, settings.protocol))));
    }
    function TaskStatus({ task, onCancel, onOpenSession, busy, onView, onSave, onRetry, onDiscard, resultCount, successCount, hasFailures }) {
      const [now, setNow] = useState(Date.now);
      useEffect(() => {
        if (!active(task)) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, [task.taskId, task.status]);
      const labels = { running: '正在处理', cancelling: '正在取消', succeeded: '查询完成', failed: '任务失败', cancelled: '已取消' };
      const phases = { reading: '正在读取结构', planning: '正在生成候选问题', answering: '正在查询答案', done: '查询完成' };
      const progress = task.progress;
      const elapsed = Math.max(0, Math.floor(((active(task) ? now : Date.parse(task.finishedAt)) - Date.parse(task.startedAt)) / 1000));
      const measured = ['answering', 'done'].includes(progress?.phase) && progress.total > 0;
      const completed = Math.min(progress?.completed || 0, progress?.total || 0);
      const terminal = !active(task);
      const summary = terminal && progress ? ` · 成功 ${progress.success} · 失败 ${progress.failed}` : '';
      return h('section', { className: 'qs-status', 'data-testid': 'task-status' },
        h('div', { className: 'qs-status-main' }, h('span', { role: 'status' }, `${task.status === 'running' ? phases[progress?.phase] || labels.running : labels[task.status] || task.status}${measured ? ` · ${completed}/${progress.total}` : ''}${summary}${Number.isFinite(elapsed) ? ` · ${elapsed} 秒` : ''}`),
          measured && h('progress', { value: completed, max: progress.total, 'aria-label': '任务进度' }), notice(task.error)),
        h('div', { className: 'qs-actions' },
          terminal && resultCount > 0 && button('查看结果', onView, { disabled: busy }),
          terminal && task.status === 'succeeded' && button('保存结果', onSave, { disabled: busy || !successCount, className: 'qs-button primary' }),
          terminal && task.status === 'succeeded' && hasFailures && button('重试失败', onRetry, { disabled: busy }),
          terminal && button('丢弃', onDiscard, { disabled: busy }),
          active(task) && button(task.status === 'cancelling' ? '正在取消…' : '取消操作', onCancel, { disabled: busy || task.status === 'cancelling' }),
          task.sessionId && onOpenSession && button('查看对话', () => onOpenSession(task.sessionId))));
    }
    function ResultDialog({ items, chosen, onChoose, onClose, onSave, disabled, canSave, error }) {
      const valid = items.filter(savable);
      return h(Dialog, { title: '泛化结果', onClose, busy: disabled, wide: true, testId: 'result-dialog',
        footer: h(React.Fragment, null, button('关闭', onClose, { disabled }), button('保存所选结果', onSave, { className: 'qs-button primary', disabled: disabled || !canSave || !valid.some(({ key }) => chosen.has(key)) })) },
      notice(error), h(DataTable, { results: true, testId: 'combined-results', labels: [
        h(SelectAll, { label: '全选结果', rows: valid.map((item) => ({ id: item.key })), chosen, disabled, onChange: (value) => onChoose(valid.map(({ key }) => key), value) }), '问题', '答案', '关联表'],
      rows: items.map((item) => h('tr', { key: item.key },
        cell(check(`选择结果 ${item.text}`, chosen.has(item.key), (value) => onChoose([item.key], value), { disabled: disabled || !savable(item) })),
        cell(h('div', null, h('div', { className: 'qs-text' }, item.text), h('span', { className: 'qs-tag' }, item.kind === 'updates' ? '补答' : '泛化'))),
        cell(h('div', { className: `qs-text${item.error ? ' qs-error' : ''}` }, item.error ? errorText(item.error) : item.answer || '—')),
        cell(h(TableLinks, { links: item.links })))) }));
    }
    function QuestionSetPage({ openSession }) {
      const [items, setItems] = useState([]), [sources, setSources] = useState([]), [sourceId, setSourceId] = useState('');
      const [search, setSearch] = useState(''), [page, setPage] = useState(1), [chosen, setChosen] = useState(() => new Set());
      const [loading, setLoading] = useState(true), [restoring, setRestoring] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(null);
      const [editing, setEditing] = useState(null), [deleting, setDeleting] = useState(null), [task, setTask] = useState(null), [monitor, setMonitor] = useState(0);
      const [dialog, setDialog] = useState(null);
      const [updateIds, setUpdateIds] = useState(() => new Set()), [candidateIds, setCandidateIds] = useState(() => new Set());
      const alive = useRef(true), action = useRef(null), taskRef = useRef(null), revision = useRef(0), seen = useRef({ taskId: null, updates: new Set(), candidates: new Set() });
      const acceptTask = (value) => {
        const next = value?.resultState && value.resultState !== 'ready' ? null : value;
        taskRef.current = next; setTask(next);
        const fresh = next?.taskId !== seen.current.taskId;
        if (fresh) seen.current = { taskId: next?.taskId, updates: new Set(), candidates: new Set() };
        for (const [kind, setter] of [['updates', setUpdateIds], ['candidates', setCandidateIds]]) {
          const valid = (next?.result?.[kind] || []).filter(savable), known = seen.current[kind];
          const additions = valid.filter(({ id }) => !known.has(id)).map(({ id }) => id);
          valid.forEach(({ id }) => known.add(id));
          setter((current) => withChecked(fresh ? new Set() : current, additions, true));
        }
      };
      const refreshQuestions = async (signal) => {
        const value = await api('questions', undefined, signal);
        if (!signal.aborted && alive.current) {
          setItems(value.items); const ids = new Set(value.items.map(({ id }) => id));
          setChosen((current) => new Set([...current].filter((id) => ids.has(id))));
        }
      };
      useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        Promise.all([api('questions', undefined, controller.signal), api('sources', undefined, controller.signal)]).then(([questions, result]) => {
          if (controller.signal.aborted) return;
          setItems(questions.items); setSources(result.items);
          setSourceId(result.items.some(({ id }) => id === lastSourceId) ? lastSourceId : result.items[0]?.id || '');
        }).catch((cause) => { if (!controller.signal.aborted) setError(cause); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => { alive.current = false; controller.abort(); action.current?.abort(); };
      }, []);
      useEffect(() => {
        if (!sourceId) return;
        lastSourceId = sourceId;
        const controller = new AbortController(); let timer;
        setRestoring(true);
        const poll = async () => {
          if (controller.signal.aborted) return;
          if (action.current) { timer = window.setTimeout(poll, 1000); return; }
          const currentRevision = revision.current;
          const current = taskRef.current;
          const query = current?.sourceId === sourceId ? `taskId=${encodeURIComponent(current.taskId)}` : `sourceId=${encodeURIComponent(sourceId)}`;
          try {
            const value = await api(`ai-tasks?${query}`, undefined, controller.signal);
            if (controller.signal.aborted) return;
            if (currentRevision !== revision.current) { timer = window.setTimeout(poll, 1000); return; }
            acceptTask(value.task); setRestoring(false);
            if (active(value.task)) timer = window.setTimeout(poll, 1000);
          } catch (cause) {
            if (!controller.signal.aborted) { setRestoring(false); setError(cause); }
          }
        };
        void poll();
        return () => { controller.abort(); window.clearTimeout(timer); };
      }, [sourceId, monitor]);
      const perform = async (name, operation, input, onSuccess) => {
        if (action.current) return;
        const controller = new AbortController(); action.current = controller; revision.current++; setBusy(name); setError(null);
        try {
          const value = await api(operation, input, controller.signal);
          if (!controller.signal.aborted && alive.current) await onSuccess(value, controller.signal);
        } catch (cause) {
          if (!controller.signal.aborted && alive.current) {
            setError(cause);
            if ((name === 'start' || name === 'retry') && !cause.status) {
              taskRef.current = null;
              setMonitor((current) => current + 1);
            }
          }
        } finally { action.current = null; if (!controller.signal.aborted && alive.current) setBusy(''); }
      };
      const selected = items.filter(({ id }) => chosen.has(id));
      const filtered = items.filter((item) => matches(search, item.text, item.answer));
      const lastPage = Math.max(1, Math.ceil(filtered.length / pageSize)), currentPage = Math.min(page, lastPage);
      const locked = !!busy || loading || restoring || active(task);
      const hasResults = !!task?.result;
      const updates = task?.result?.updates || [], candidates = task?.result?.candidates || [];
      const results = [...updates.map((item) => ({ ...item, kind: 'updates', key: `updates:${item.id}` })), ...candidates.map((item) => ({ ...item, kind: 'candidates', key: `candidates:${item.id}` }))];
      const resultChosen = new Set([...updateIds].map((id) => `updates:${id}`).concat([...candidateIds].map((id) => `candidates:${id}`)));
      const chooseResults = (keys, value) => {
        setUpdateIds((current) => withChecked(current, keys.filter((key) => key.startsWith('updates:')).map((key) => key.slice(8)), value));
        setCandidateIds((current) => withChecked(current, keys.filter((key) => key.startsWith('candidates:')).map((key) => key.slice(11)), value));
      };
      const hasFailures = results.some((item) => item.error);
      const validUpdates = updates.filter((item) => savable(item) && updateIds.has(item.id)).map(({ id }) => id);
      const validCandidates = candidates.filter((item) => savable(item) && candidateIds.has(item.id)).map(({ id }) => id);
      const start = () => {
        if (locked || !sourceId || !selected.length || hasResults) return;
        void perform('start', 'ai-tasks', { sourceId, questions: selected.map(({ id, version }) => ({ id, version })) }, (value) => {
          acceptTask(value.task); setMonitor((current) => current + 1);
        });
      };
      const retry = () => void perform('retry', 'ai-tasks', { taskId: task.taskId, retryFailed: true }, (value) => { acceptTask(value.task); setMonitor((current) => current + 1); });
      const saveResults = (all = false) => void perform('results-save', 'results-save', { taskId: task.taskId,
        candidateIds: all ? candidates.filter(savable).map(({ id }) => id) : validCandidates,
        updateIds: all ? updates.filter(savable).map(({ id }) => id) : validUpdates }, (value) => {
        setDialog(null); setItems(value.items); acceptTask(null); const ids = new Set(value.items.map(({ id }) => id)); setChosen((current) => new Set([...current].filter((id) => ids.has(id))));
      });
      const discard = () => void perform('discard', 'results-discard', { taskId: task.taskId }, () => { setDialog(null); acceptTask(null); });
      const rows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((item) => h('tr', { key: item.id },
        cell(check(`选择问题 ${item.text}`, chosen.has(item.id), (value) => setChosen((current) => withChecked(current, [item.id], value)), { disabled: locked })),
        cell(h('div', null, h('div', { className: 'qs-text' }, item.text), h('span', { className: 'qs-tag' }, origin(item)))),
        cell(h('div', { className: 'qs-text qs-answer-preview' }, item.answer || '—')),
        cell(h('span', { className: 'qs-assessment' }, '—')), cell(h('span', { className: 'qs-assessment' }, '—')),
        cell(h('div', { className: 'qs-row-actions' }, button('评测', undefined, { disabled: true, className: 'qs-button qs-evaluate', 'aria-label': `评测 ${item.text}`, title: '暂未开放' }), button('编辑', () => setEditing({ question: item }), { disabled: locked, 'aria-label': `编辑 ${item.text}` }),
          button('删除', () => setDeleting([item]), { disabled: locked, 'aria-label': `删除 ${item.text}`, className: 'qs-button danger' })))));
      return h('div', { className: 'dsh-qs', 'data-testid': 'question-set-page' }, h('style', null, css),
        h('header', { className: 'qs-header' }, h('h1', null, '问题集')),
        h('div', { className: 'qs-content' }, h('div', { className: 'qs-wrap' },
        notice(error), task && h(TaskStatus, { task, busy: !!busy, onOpenSession: openSession,
          resultCount: results.length, successCount: results.filter(savable).length, hasFailures,
          onView: () => setDialog('results'), onSave: () => saveResults(true), onRetry: retry, onDiscard: discard,
          onCancel: () => void perform('cancel', 'ai-tasks/cancel', { taskId: task.taskId }, (value) => { acceptTask(value.task); setMonitor((current) => current + 1); }) }),
        h('div', { className: 'qs-toolbar' },
          h('div', { className: 'qs-filters' },
            h('input', { type: 'search', 'aria-label': '搜索问题或答案', placeholder: '搜索问题或答案', value: search, onChange: (event) => { setSearch(event.target.value); setPage(1); } }),
            h('select', { 'aria-label': '泛化数据源', value: sourceId, disabled: locked || hasResults, onChange: (event) => { acceptTask(null); setSourceId(event.target.value); setError(null); } },
              !sources.length && h('option', { value: '' }, '暂无数据源'), sources.map((source) => h('option', { key: source.id, value: source.id }, source.name)))),
          h('div', { className: 'qs-actions' },
            button(busy === 'start' ? '正在启动…' : '泛化问题', start, { disabled: locked || !sourceId || !selected.length || hasResults }),
            button('泛化提示词', () => setDialog('prompt')),
            button('批量评测', undefined, { disabled: true, title: '暂未开放' }),
            button('新增问题', () => setEditing({ question: null }), { disabled: locked, className: 'qs-button primary' }))),
        h('div', { className: 'qs-row qs-selection' }, h('span', { className: 'qs-muted' }, `已选 ${selected.length} / ${items.length} 个问题`),
          h('div', { className: 'qs-actions' },
            button('清除所有勾选', () => setChosen(new Set()), { disabled: locked || !selected.length }),
            button('批量删除', () => setDeleting(selected), { disabled: locked || !selected.length, className: 'qs-button danger' }))),
        loading ? h('p', { role: 'status' }, '正在加载…') : h(DataTable, { testId: 'questions-table', labels: [
          h(SelectAll, { label: '全选当前筛选问题', rows: filtered, chosen, disabled: locked, onChange: (value) => setChosen((current) => withChecked(current, filtered.map(({ id }) => id), value)) }),
          '问题', '答案', '最近评测准确率', '通过状态', '操作'], rows }),
        h('nav', { className: 'qs-pagination', 'aria-label': '问题分页' }, h('span', { className: 'qs-muted' }, `${filtered.length} 条 · 第 ${currentPage} / ${lastPage} 页`),
          h('div', { className: 'qs-actions' }, button('上一页', () => setPage(currentPage - 1), { disabled: currentPage === 1 }), button('下一页', () => setPage(currentPage + 1), { disabled: currentPage === lastPage }))),
        dialog === 'prompt' && h(PromptDialog, { onClose: () => setDialog(null) }),
        dialog === 'results' && task && h(ResultDialog, { items: results, chosen: resultChosen, onChoose: chooseResults, onClose: () => setDialog(null),
          onSave: () => saveResults(), disabled: !!busy, canSave: task.status === 'succeeded', error }),
        editing && h(QuestionDialog, { question: editing.question, onClose: () => setEditing(null), onSaved: async (signal) => { await refreshQuestions(signal); if (!signal.aborted) setEditing(null); } }),
        deleting && h(DeleteDialog, { items: deleting, onClose: () => setDeleting(null), onRemoved: (id) => { setItems((current) => current.filter((item) => item.id !== id)); setChosen((current) => withChecked(current, [id], false)); } }))));
    }
    function apply(ctx) {
      const openSession = (id) => ctx.get?.('uiWorkspace')?.openSession?.(id);
      const Page = () => h(QuestionSetPage, { openSession });
      const QuestionIcon = () => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, 'aria-hidden': true },
        h('path', { d: 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5' }));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'question-set' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'question-set', order: 5.5, label: '问题集' }, QuestionIcon));
    }
    return { name: 'question-set', inject: ['slots', 'layout'], apply };
  },
});
