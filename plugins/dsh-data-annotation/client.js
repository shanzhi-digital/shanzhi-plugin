window.__ModuleLoader__.load({
  id: 'dsh-data-annotation',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;
    const size = 20;
    const statusNames = { missing: '未标注', pending: '人工未确认', confirmed: '人工已确认', unannotated: '未标注', partial: '部分标注', complete: '完全标注' };
    const css = `
.da{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}
.da,.da *{box-sizing:border-box}.da h1,.da h2,.da p{margin:0}.da h1{font-size:20px}.da h2{font-size:16px}.da button,.da input,.da select,.da textarea{font:inherit;color:inherit}.da button{cursor:pointer}.da button:disabled{opacity:.45;cursor:default}.da input:not([type=checkbox]),.da select,.da textarea{border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-specific-input-major);padding:7px 9px;min-width:0}.da input[type=checkbox]{accent-color:var(--dsw-alias-brand-primary)}.da textarea{width:100%;resize:vertical}.da select option{background:var(--dsw-specific-input-major)}
.da-header,.da-footer{flex:none;padding:16px 24px;border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.da-header{border-bottom:1px solid var(--dsw-alias-border-l2)}.da-footer{border-top:1px solid var(--dsw-alias-border-l2)}.da-body{flex:1;min-height:0;overflow:auto;padding:16px 24px}.da-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.da-between{justify-content:space-between}.da-toolbar{margin-bottom:12px}.da-toolbar input[type=search]{width:220px}.da-btn{border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-layer-1);padding:6px 10px;white-space:nowrap}.da-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.da-tabs{display:flex;gap:18px;margin-top:14px}.da-tab{border:0;border-bottom:2px solid transparent;background:none;padding:5px 0}.da-tab.active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.da-grid{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;height:100%;min-height:0}.da-side,.da-main{min-height:0;overflow:auto}.da-side{border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.da-side button{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:transparent;padding:10px 12px}.da-side button.active{background:var(--dsw-alias-state-business-tertiary)}.da-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}.da-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.da table{width:100%;table-layout:fixed;border-collapse:collapse;text-align:left;font-size:13px}.da th,.da td{border-bottom:1px solid var(--dsw-alias-border-l2);padding:9px 10px;vertical-align:middle}.da th{background:var(--dsw-alias-bg-module-platform);font-weight:500;white-space:nowrap}.da tbody tr:last-child td{border-bottom:0}.da-clip{max-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.da-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.da-sub{margin-left:6px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}.da-btn-sm{padding:3px 8px;font-size:12px;border-radius:5px}.da-status{white-space:nowrap}.da-status:before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;background:var(--dsw-alias-label-secondary)}.da-status.missing,.da-status.unannotated{color:var(--dsw-alias-state-error-primary)}.da-status.pending,.da-status.partial{color:#b77908}.da-status.confirmed,.da-status.complete{color:var(--dsw-alias-state-success-primary)}.da-status:before{background:currentColor}.da-progress{display:inline-block;width:96px;height:6px;border-radius:3px;background:var(--dsw-alias-bg-module-platform);overflow:hidden;vertical-align:middle}.da-progress>i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary)}.da-pct{font-size:12px;color:var(--dsw-alias-label-secondary)}.da-empty{text-align:center;padding:36px;color:var(--dsw-alias-label-secondary)}.da-error{color:var(--dsw-alias-state-error-primary);margin-bottom:10px}.da-loading{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin:0 0 10px}.da-loading>span[role=status]{flex:1}.da-spinner{width:18px;height:18px;flex:none;border:2px solid var(--dsw-alias-border-l4);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:da-spin .8s linear infinite}@keyframes da-spin{to{transform:rotate(360deg)}}.da-modal-bg{position:fixed;inset:0;background:rgb(0 0 0 / .4);display:flex;align-items:center;justify-content:center;z-index:20}.da-modal{width:min(680px,calc(100vw - 24px));max-height:calc(100dvh - 24px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-radius:10px;box-shadow:0 16px 50px rgb(0 0 0 / .2)}.da-modal-head,.da-modal-foot{padding:16px;flex:none}.da-modal-head{border-bottom:1px solid var(--dsw-alias-border-l2)}.da-modal-foot{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end}.da-modal-body{padding:16px;overflow:auto}.da-edit-item+ .da-edit-item{margin-top:16px}.da-edit-item label{display:block;margin-bottom:5px;overflow-wrap:anywhere}@media(max-width:700px){.da-header,.da-footer,.da-body{padding:12px}.da-grid{grid-template-columns:1fr;grid-template-rows:minmax(100px,30%) minmax(0,1fr)}}
    `;
    async function api(path, input, signal) {
      const response = await fetch(`/api/data-annotation/${path}`, { ...(input === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), credentials: 'same-origin', cache: 'no-store', signal });
      let value;
      try { value = await response.json(); } catch { throw new Error('无法读取服务响应。'); }
      if (!response.ok) throw Object.assign(new Error(typeof value?.error === 'string' ? value.error : '操作失败，请重试。'), { status: response.status, taskId: value?.taskId });
      return value;
    }
    const btn = (label, onClick, props = {}) => h('button', { type: 'button', className: 'da-btn', onClick, ...props }, label);
    const select = (label, value, set, options) => h('select', { 'aria-label': label, value, onChange: e => set(e.target.value) }, options.map(([key, text]) => h('option', { value: key, key }, text)));
    const searchBox = (value, set) => h('input', { type: 'search', placeholder: '搜索名称、备注、标注', 'aria-label': '搜索', value, onChange: e => set(e.target.value) });
    const matches = (query, ...values) => values.some(value => String(value ?? '').toLowerCase().includes(query.trim().toLowerCase()));
    const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN') : '—';
    const badge = status => h('span', { className: `da-status ${status}` }, statusNames[status] || status);
    const progress = source => {
      if (source.status === 'unannotated' || !source.requiredCount) return h('span', { className: 'da-pct' }, '—');
      const percent = Math.round((source.annotatedCount ?? 0) / source.requiredCount * 100);
      return h(React.Fragment, null, h('span', { className: 'da-progress', title: `已标注 ${source.annotatedCount ?? 0} / ${source.requiredCount} 项` }, h('i', { style: { width: `${percent}%` } })), h('span', { className: 'da-pct' }, `${percent}%`));
    };
    const fieldKey = (tableId, name) => JSON.stringify([tableId, name]);
    const itemKey = (kind, table, field) => kind === 'table' ? table.id : fieldKey(table.id, field.name);
    const target = row => ({ tableId: row.table.id, ...(row.field ? { fieldName: row.field.name } : {}) });
    const label = row => row.field ? `${row.table.name} · ${row.field.name}` : row.table.name;
    const annotation = row => (row.field || row.table).annotation;
    const eligible = row => !row.field || row.field.enabled;

    function Page() {
      const [sources, setSources] = useState([]), [catalog, setCatalog] = useState(null), [requestBusy, setRequestBusy] = useState(false), [error, setError] = useState('');
      const [step, setStep] = useState('table'), [tableId, setTableId] = useState(null), [search, setSearch] = useState(''), [tableSearch, setTableSearch] = useState(''), [status, setStatus] = useState(''), [enabled, setEnabled] = useState(''), [onlySelected, setOnlySelected] = useState(false), [page, setPage] = useState(1);
      const [selectedTables, setSelectedTables] = useState(() => new Set()), [selectedFields, setSelectedFields] = useState(() => new Set()), [editing, setEditing] = useState(null), [elapsed, setElapsed] = useState(0), [task, setTask] = useState(null), [restoring, setRestoring] = useState(false), [requestPath, setRequestPath] = useState('');
      const request = useRef(null), alive = useRef(true);
      const sourceId = catalog?.source.id;
      const aiBusy = task && ['running', 'cancelling'].includes(task.status);
      const loading = requestBusy || restoring || aiBusy;
      const cancel = () => { request.current?.abort(); request.current = null; setRequestBusy(false); };
      const message = err => err instanceof TypeError || err?.message === 'Failed to fetch' ? '无法连接标注服务，请稍后重试。' : err.message;
      async function run(path, input, onSuccess) {
        request.current?.abort();
        const controller = new AbortController(); request.current = controller;
        setRequestBusy(true); setRequestPath(path); setError('');
        try { const result = await api(path, input, controller.signal); if (!controller.signal.aborted && alive.current) onSuccess(result); }
        catch (err) {
          if (!controller.signal.aborted && alive.current) {
            setError(message(err));
            if (path === 'ai-tasks') {
              try { const result = await api(`ai-tasks?sourceId=${encodeURIComponent(input.sourceId)}`, undefined, controller.signal); if (!controller.signal.aborted && alive.current) setTask(result.task); }
              catch { /* The user can re-enter the source to resume observation. */ }
            }
          }
        }
        finally { if (request.current === controller && alive.current) { request.current = null; setRequestBusy(false); } }
      }
      useEffect(() => { alive.current = true; run('sources', undefined, result => setSources(result.items)); return () => { alive.current = false; request.current?.abort(); }; }, []);
      useEffect(() => {
        if (!sourceId) return;
        const controller = new AbortController();
        setRestoring(true);
        api(`ai-tasks?sourceId=${encodeURIComponent(sourceId)}`, undefined, controller.signal)
          .then(result => { if (!controller.signal.aborted) setTask(result.task); })
          .catch(err => { if (!controller.signal.aborted) setError(message(err)); })
          .finally(() => { if (!controller.signal.aborted) setRestoring(false); });
        return () => controller.abort();
      }, [sourceId]);
      useEffect(() => {
        if (!sourceId || !task || task.sourceId !== sourceId) return;
        const controller = new AbortController();
        let timer;
        async function observe() {
          try {
            const result = await api(`ai-tasks?taskId=${encodeURIComponent(task.taskId)}`, undefined, controller.signal);
            if (controller.signal.aborted) return;
            setTask(result.task);
            if (['running', 'cancelling'].includes(result.task.status)) timer = setTimeout(observe, 1000);
          } catch (err) {
            if (!controller.signal.aborted) {
              setError(message(err));
              if (err.status === 404) {
                try { const result = await api('catalog', { sourceId }, controller.signal); if (!controller.signal.aborted) { setCatalog(result); setTask(null); } }
                catch (cause) { if (!controller.signal.aborted) { setTask(null); setError(message(cause)); } }
              } else timer = setTimeout(observe, 1000);
            }
          }
        }
        if (aiBusy) timer = setTimeout(observe, 1000);
        else {
          if (task.status === 'failed') setError(task.error?.message || 'AI 标注失败，请重试。');
          if (task.status === 'cancelled') setError('AI 标注已取消。');
          api('catalog', { sourceId }, controller.signal).then(result => { if (!controller.signal.aborted) setCatalog(result); }).catch(err => { if (!controller.signal.aborted) setError(message(err)); });
        }
        return () => { controller.abort(); clearTimeout(timer); };
      }, [sourceId, task?.taskId, task?.status]);
      useEffect(() => {
        if (!aiBusy) return;
        const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(task.startedAt)) / 1000)));
        update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
      }, [aiBusy, task?.startedAt]);
      function openSource(source) { setTask(null); setRestoring(true); run('catalog', { sourceId: source.id }, result => { setCatalog(result); setStep('table'); setTableId(result.tables[0]?.id ?? null); setSelectedTables(new Set()); setSelectedFields(new Set()); setSearch(''); setTableSearch(''); setStatus(''); setEnabled(''); setOnlySelected(false); setPage(1); }).finally(() => setRestoring(false)); }
      function refresh() { if (catalog) run('catalog', { sourceId }, setCatalog); }
      function cancelVisible() { if (aiBusy) run('ai-tasks/cancel', { taskId: task.taskId }, result => setTask(result.task)); else cancel(); }
      function back() { cancel(); setTask(null); setRestoring(false); setEditing(null); setCatalog(null); setError(''); setSearch(''); setStatus(''); setPage(1); run('sources', undefined, result => setSources(result.items)); }
      function changeStep(value) { setStep(value); setSearch(''); setStatus(''); setEnabled(''); setOnlySelected(false); setPage(1); }
      const selection = step === 'table' ? selectedTables : selectedFields;
      const setSelection = step === 'table' ? setSelectedTables : setSelectedFields;
      const tables = catalog?.tables || [];
      const currentTable = tables.find(table => table.id === tableId) || tables[0];
      const allRows = step === 'table' ? tables.map(table => ({ table })) : tables.flatMap(table => table.fields.map(field => ({ table, field })));
      const selectedRows = allRows.filter(row => selection.has(itemKey(step, row.table, row.field)));
      let rows = step === 'table' ? allRows : allRows.filter(row => row.table.id === currentTable?.id);
      rows = rows.filter(row => { const item = row.field || row.table, ann = item.annotation; return matches(search, item.name, item.sourceComment, ann.text, row.table.schema) && (!status || ann.status === status) && (!row.field || !enabled || (enabled === 'enabled') === row.field.enabled) && (!onlySelected || selection.has(itemKey(step, row.table, row.field))); });
      const activePage = Math.min(page, Math.max(1, Math.ceil(rows.length / size))), pageRows = rows.slice((activePage - 1) * size, activePage * size);
      const filteredKeys = rows.map(row => itemKey(step, row.table, row.field));
      const allChecked = filteredKeys.length > 0 && filteredKeys.every(key => selection.has(key));
      function toggle(keys, checked) { setSelection(previous => { const next = new Set(previous); keys.forEach(key => checked ? next.add(key) : next.delete(key)); return next; }); }
      function act(operation, list, extra) { if (!catalog || !list.length) return; run('action', { sourceId: catalog.source.id, revision: catalog.revision, operation, kind: step, items: list.map(row => ({ ...target(row), ...(extra ? extra(row) : {}) })) }, result => { setCatalog(result); setEditing(null); }); }
      function ai(list) { if (!list.length) return; run('ai-tasks', { sourceId: catalog.source.id, revision: catalog.revision, kind: step, items: list.map(target) }, result => setTask(result.task)); }
      function edit(list) { if (list.length) setEditing(list.map(row => ({ row, text: annotation(row).text || '' }))); }
      const actionable = selectedRows.filter(row => eligible(row) && annotation(row).status !== 'confirmed');
      const confirmable = selectedRows.filter(row => annotation(row).status === 'pending');
      const loadingView = loading && h('div', { className: 'da-loading' }, h('span', { className: 'da-spinner', 'aria-hidden': true }), h('span', { role: 'status' }, aiBusy ? `${task.status === 'cancelling' ? '正在取消 AI 标注' : 'AI 标注中'} · ${elapsed} 秒` : '加载中'), aiBusy ? btn('取消标注', cancelVisible, { disabled: task.status === 'cancelling' || requestBusy }) : requestBusy && !['action', 'ai-tasks', 'ai-tasks/cancel'].includes(requestPath) && btn('取消操作', cancelVisible));
      const errorView = error && h('div', { className: 'da-error', role: 'alert' }, error);
      const pagination = h('div', { className: 'da-row da-between' }, h('span', { className: 'da-muted' }, `共 ${rows.length} 项 · 第 ${activePage} / ${Math.max(1, Math.ceil(rows.length / size))} 页`), h('div', { className: 'da-row' }, btn('上一页', () => setPage(activePage - 1), { disabled: activePage <= 1 }), btn('下一页', () => setPage(activePage + 1), { disabled: activePage * size >= rows.length })));
      const rowTable = h('div', { className: 'da-table-wrap' }, h('table', null,
        h('colgroup', null, ...(step === 'table' ? ['40px', '18%', '22%', '40%', '104px', '120px'] : ['40px', '16%', '56px', '18%', '40%', '104px', '120px']).map((width, index) => h('col', { key: index, style: { width } }))),
        h('thead', null, h('tr', null, h('th', null, h('input', { type: 'checkbox', 'aria-label': '全选当前筛选结果', checked: allChecked, onChange: e => toggle(filteredKeys, e.target.checked), disabled: !filteredKeys.length })), ...[step === 'table' ? '表名' : '字段', ...(step === 'field' ? ['启用'] : []), '原备注', '中文标注', '状态', '操作'].map(title => h('th', { key: title }, title)))),
        h('tbody', null, pageRows.map(row => { const item = row.field || row.table, ann = item.annotation, key = itemKey(step, row.table, row.field); return h('tr', { key },
          h('td', null, h('input', { type: 'checkbox', 'aria-label': `选择 ${label(row)}`, checked: selection.has(key), onChange: e => toggle([key], e.target.checked) })),
          step === 'table'
            ? h('td', { className: 'da-clip', title: item.schema ? `${item.schema}.${item.name}` : item.name }, item.name)
            : h('td', { className: 'da-clip', title: `${row.table.name}.${item.name}` }, item.name, item.type && h('span', { className: 'da-sub' }, item.type)),
          step === 'field' && h('td', null, h('input', { type: 'checkbox', 'aria-label': `启用 ${label(row)}`, checked: item.enabled, disabled: loading, onChange: e => act('enable', [row], () => ({ enabled: e.target.checked })) })),
          h('td', { className: 'da-clip', title: item.sourceComment || '' }, item.sourceComment || '—'),
          h('td', { className: 'da-clip', title: ann.text || '' }, ann.text || '—'),
          h('td', null, h('span', { title: ann.updatedAt ? `最近标注：${date(ann.updatedAt)}` : '' }, badge(ann.status))),
          h('td', null, h('div', { className: 'da-row' }, ann.status === 'pending' && btn('确认', () => act('confirm', [row]), { className: 'da-btn da-btn-sm', disabled: loading }), btn('编辑', () => edit([row]), { className: 'da-btn da-btn-sm', disabled: loading })))); })),
        !rows.length && h('tbody', null, h('tr', null, h('td', { colSpan: step === 'table' ? 6 : 7, className: 'da-empty' }, '暂无数据')))));
      const overviewRows = sources.filter(source => matches(search, source.name) && (!status || source.status === status));
      return h('div', { className: 'da' }, h('style', null, css),
        h('header', { className: 'da-header' }, h('div', { className: 'da-row da-between' }, h('div', { className: 'da-row' }, catalog && btn('返回', back), h('h1', null, catalog ? catalog.source.name : '数据标注')), h('div', { className: 'da-row' }, catalog && btn('刷新', refresh, { disabled: loading }), btn('导入', null, { disabled: true, title: '暂未开放' }), btn('导出', null, { disabled: true, title: '暂未开放' }))), catalog && h('nav', { className: 'da-tabs', 'aria-label': '标注步骤' }, ['table', 'field'].map((value, index) => h('button', { type: 'button', key: value, className: `da-tab ${step === value ? 'active' : ''}`, onClick: () => changeStep(value), disabled: loading }, `${index + 1}. ${value === 'table' ? '表标注' : '字段标注'}`)))),
        h('main', { className: 'da-body' }, errorView, loadingView,
          !catalog ? h(React.Fragment, null, h('div', { className: 'da-row da-toolbar' }, searchBox(search, setSearch), select('状态', status, setStatus, [['', '全部状态'], ['unannotated', '未标注'], ['partial', '部分标注'], ['complete', '完全标注']])), h('div', { className: 'da-table-wrap' }, h('table', null, h('colgroup', null, ...['26%', '12%', '30%', '16%', '120px'].map((width, index) => h('col', { key: index, style: { width } }))), h('thead', null, h('tr', null, ['数据源', '启用表数', '标注状态', '最近标注时间', '操作'].map(text => h('th', { key: text }, text)))), h('tbody', null, overviewRows.map(source => h('tr', { key: source.id }, h('td', { className: 'da-clip', title: source.name }, source.name), h('td', null, source.enabledTableCount), h('td', null, h('div', { className: 'da-row' }, badge(source.status), progress(source))), h('td', null, date(source.updatedAt)), h('td', null, btn('标注', () => openSource(source), { className: 'da-btn da-btn-sm', disabled: loading }))))), !overviewRows.length && h('tbody', null, h('tr', null, h('td', { colSpan: 5, className: 'da-empty' }, loading ? '加载中' : '暂无数据源')))))) :
          h('div', { className: step === 'field' ? 'da-grid' : undefined }, step === 'field' && h('aside', { className: 'da-side', 'aria-label': '表列表' }, h('input', { type: 'search', value: tableSearch, placeholder: '搜索表', 'aria-label': '搜索表', onChange: e => setTableSearch(e.target.value) }), tables.filter(table => matches(tableSearch, table.name, table.schema, table.sourceComment, table.annotation.text)).map(table => h('button', { key: table.id, type: 'button', className: currentTable?.id === table.id ? 'active' : '', onClick: () => { setTableId(table.id); setPage(1); } }, h('div', null, table.name), h('div', { className: 'da-muted da-ellipsis', title: table.annotation.text || table.sourceComment || '' }, table.annotation.text || table.sourceComment || '—'), h('div', { className: 'da-muted' }, `${table.fields.filter(field => field.enabled && field.annotation.status === 'confirmed').length} / ${table.fields.filter(field => field.enabled).length} 已确认`)))),
            h('section', { className: 'da-main' }, h('div', { className: 'da-row da-toolbar' }, searchBox(search, value => { setSearch(value); setPage(1); }), select('标注状态', status, value => { setStatus(value); setPage(1); }, [['', '全部状态'], ['missing', '未标注'], ['pending', '人工未确认'], ['confirmed', '人工已确认']]), step === 'field' && select('启用状态', enabled, value => { setEnabled(value); setPage(1); }, [['', '全部启用状态'], ['enabled', '已启用'], ['disabled', '已停用']]), h('label', { className: 'da-row' }, h('input', { type: 'checkbox', checked: onlySelected, onChange: e => { setOnlySelected(e.target.checked); setPage(1); } }), '仅看已选')), h('div', { className: 'da-row da-toolbar' }, h('span', { className: 'da-muted' }, `已选 ${selection.size} 项`), btn('清除全选', () => setSelection(new Set()), { disabled: !selection.size }), btn('批量确认', () => act('confirm', confirmable), { disabled: loading || !confirmable.length }), btn('批量编辑', () => edit(selectedRows), { disabled: loading || !selectedRows.length }), btn('AI 辅助', () => ai(actionable), { disabled: loading || !actionable.length }), step === 'field' && btn('批量启用', () => act('enable', selectedRows, () => ({ enabled: true })), { disabled: loading || !selectedRows.length }), step === 'field' && btn('批量停用', () => act('enable', selectedRows, () => ({ enabled: false })), { disabled: loading || !selectedRows.length })), rowTable))),
        catalog && h('footer', { className: 'da-footer' }, pagination),
        editing && h('div', { className: 'da-modal-bg', onClick: e => { if (e.target === e.currentTarget && !loading) setEditing(null); } }, h('div', { className: 'da-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '编辑标注', onKeyDown: e => { if (e.key === 'Escape' && !loading) setEditing(null); } }, h('div', { className: 'da-modal-head' }, h('h2', null, '编辑标注')), h('div', { className: 'da-modal-body' }, errorView, editing.map((entry, index) => h('div', { className: 'da-edit-item', key: itemKey(step, entry.row.table, entry.row.field) }, h('label', { htmlFor: `da-edit-${index}` }, label(entry.row)), h('textarea', { id: `da-edit-${index}`, rows: 2, value: entry.text, onChange: e => { const text = e.target.value; setEditing(previous => previous.map((item, i) => i === index ? { ...item, text } : item)); } })))), h('div', { className: 'da-modal-foot da-row' }, error && btn('刷新目录', () => { setEditing(null); refresh(); }, { disabled: loading }), btn('取消', () => setEditing(null), { disabled: loading }), btn('保存', () => { const texts = new Map(editing.map(entry => [itemKey(step, entry.row.table, entry.row.field), entry.text])); act('edit', editing.map(entry => entry.row), row => ({ text: texts.get(itemKey(step, row.table, row.field)) })); }, { className: 'da-btn primary', disabled: loading })))));
    }
    function apply(ctx) {
      const Icon = () => h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('path', { d: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5' }));
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'data-annotation' }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'data-annotation', order: 6, label: '数据标注' }, Icon));
    }
    return { name: 'data-annotation', inject: ['slots', 'layout'], apply };
  },
});
