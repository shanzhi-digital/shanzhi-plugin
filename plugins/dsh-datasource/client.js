window.__ModuleLoader__.load({
  id: 'dsh-sql',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const engines = [
      { id: 'mysql', name: 'MySQL', mark: 'My', color: '#187ba4', subtitle: '默认端口 3306' },
      { id: 'postgres', name: 'PostgreSQL', mark: 'Pg', color: '#396e9c', subtitle: '默认端口 5432' },
      { id: 'sqlite', name: 'SQLite', mark: 'Sq', color: '#728296', subtitle: '本地数据库文件' },
    ];
    const engineOf = (id) => engines.find((item) => item.id === id) || engines[0];
    const blank = (engine = 'mysql') => ({ name: '', description: '', engine, host: '127.0.0.1', port: engine === 'postgres' ? 5432 : 3306, user: '', database: '', file: '', password: '', clearPassword: false });
    const css = `
.dsh-ds{box-sizing:border-box;height:100%;overflow:auto;padding:28px clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary,#222);font-size:14px;line-height:1.5}
.dsh-ds *{box-sizing:border-box}.dsh-ds .ds-wrap{max-width:1040px;margin:auto}.dsh-ds .ds-header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}.dsh-ds h1{font-size:20px;font-weight:500;line-height:28px;margin:0}.dsh-ds .ds-intro{color:var(--dsw-alias-label-secondary,#737373);font-size:13px;margin:5px 0 0}.dsh-ds .ds-workspace{display:grid;grid-template-columns:190px minmax(0,1fr);gap:28px;align-items:start}.dsh-ds .ds-sidebar{min-width:0}.dsh-ds .ds-section-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);font-weight:500;margin:0 0 12px}.dsh-ds .ds-types{display:flex;flex-direction:column;gap:8px}.dsh-ds button,.dsh-ds input,.dsh-ds textarea{font:inherit}.dsh-ds button{cursor:pointer}.dsh-ds button:disabled{cursor:default;opacity:.5}.dsh-ds .ds-type{display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;text-align:left;border-radius:10px;border:1px solid transparent;background:transparent;color:inherit}.dsh-ds .ds-type:hover,.dsh-ds .ds-saved:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}.dsh-ds .ds-type.is-active{border-color:#b5c9ff;background:color-mix(in srgb,#4679e8 8%,transparent)}.dsh-ds .ds-logo{width:36px;height:36px;display:flex;align-items:center;justify-content:center;flex:none;border-radius:9px;font-size:13px;font-weight:600;background:color-mix(in srgb,currentColor 9%,transparent)}.dsh-ds .ds-type-name{display:block;font-weight:500;font-size:14px}.dsh-ds .ds-type-hint{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,#777);margin-top:2px}.dsh-ds .ds-connections{margin-top:30px;padding-top:22px;border-top:1px solid var(--dsw-alias-border-1,#e9e9e9)}.dsh-ds .ds-saved{border:0;border-radius:8px;background:transparent;color:inherit;display:block;width:100%;padding:10px 12px;text-align:left;margin:3px 0}.dsh-ds .ds-saved.is-active{background:var(--dsw-alias-interactive-bg-hover,#f3f5f8)}.dsh-ds .ds-saved-name{display:block;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh-ds .ds-saved-engine{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);margin-top:2px}.dsh-ds .ds-muted{color:var(--dsw-alias-label-tertiary,#888);font-size:12px}.dsh-ds .ds-card{border:1px solid var(--dsw-alias-border-1,#e5e7eb);border-radius:14px;padding:26px 28px;min-width:0}.dsh-ds .ds-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid var(--dsw-alias-border-1,#ececec)}.dsh-ds h2{font-weight:500;font-size:16px;margin:0}.dsh-ds .ds-badge{font-size:11px;color:var(--dsw-alias-label-secondary,#777);border:1px solid var(--dsw-alias-border-1,#e5e7eb);padding:2px 8px;border-radius:20px;white-space:nowrap}.dsh-ds fieldset{border:0;min-width:0;margin:0;padding:0}.dsh-ds .ds-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:20px;row-gap:19px}.dsh-ds .ds-field{display:flex;flex-direction:column;gap:7px;min-width:0}.dsh-ds .ds-field.wide{grid-column:1 / -1}.dsh-ds label{font-size:13px;font-weight:500}.dsh-ds .ds-required{color:#c05a53;margin-left:3px}.dsh-ds input:not([type=checkbox]),.dsh-ds textarea{width:100%;background:var(--dsw-alias-input-bg,transparent);color:inherit;border:1px solid var(--dsw-alias-border-1,#dedfe2);border-radius:8px;padding:9px 11px;outline:none;font-size:13px;line-height:20px}.dsh-ds input:focus,.dsh-ds textarea:focus{border-color:#7298ed;box-shadow:0 0 0 2px #7298ed20}.dsh-ds textarea{resize:vertical;min-height:70px}.dsh-ds input::placeholder,.dsh-ds textarea::placeholder{color:var(--dsw-alias-label-tertiary,#a0a0a0)}.dsh-ds .ds-help{font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary,#888);line-height:18px;margin:0}.dsh-ds .ds-check{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:400;margin-top:2px}.dsh-ds .ds-check input{accent-color:#4679e8}.dsh-ds .ds-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:26px}.dsh-ds .ds-button{border:1px solid var(--dsw-alias-border-1,#dcdfe4);border-radius:8px;padding:8px 15px;line-height:20px;font-size:13px;color:inherit;background:transparent;white-space:nowrap}.dsh-ds .ds-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}.dsh-ds .ds-button.primary{color:white;background:#4679e8;border-color:#4679e8}.dsh-ds .ds-button.primary:hover{background:#3569d6}.dsh-ds .ds-button.danger{color:#c14d48;border-color:transparent;margin-left:auto}.dsh-ds .ds-notice{font-size:12px;line-height:20px;border-radius:8px;padding:10px 12px;margin-top:18px;white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,#4679e8 7%,transparent);color:var(--dsw-alias-label-secondary,#666)}.dsh-ds .ds-notice.success{background:color-mix(in srgb,#2c9670 9%,transparent);color:#278363}.dsh-ds .ds-notice.error{background:color-mix(in srgb,#d85b53 8%,transparent);color:#c14d48}.dsh-ds .ds-delete{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:16px;font-size:12px;color:#bc5049}.dsh-ds .ds-footer{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:18px;color:var(--dsw-alias-label-tertiary,#888);font-size:11px}.dsh-ds code{font-size:10px;border:1px solid var(--dsw-alias-border-1,#ececec);padding:1px 5px;border-radius:4px}
`;
    async function api(operation, input, signal) {
      const response = await fetch(`/api/datasources/${operation}`, {
        method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
      });
      let value;
      try { value = await response.json(); } catch { throw new Error('无法读取数据源服务的响应，请刷新页面后重试。'); }
      if (!response.ok) throw new Error(value.error || '操作失败，请稍后重试。');
      return value;
    }
    function DatabaseIcon() {
      return h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, 'aria-hidden': true },
        h('ellipse', { cx: 12, cy: 5.2, rx: 7.4, ry: 3 }),
        h('path', { d: 'M4.6 5.2v13.6c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3V5.2M4.6 12c0 1.65 3.31 3 7.4 3s7.4-1.35 7.4-3' }));
    }
    function DatasourcePage() {
      const [items, setItems] = React.useState([]);
      const [form, setForm] = React.useState(() => blank());
      const [busy, setBusy] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [notice, setNotice] = React.useState(null);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const formRef = React.useRef(null);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        api('list', undefined, controller.signal).then((result) => { if (alive.current) setItems(result.items || []); })
          .catch((error) => { if (error.name !== 'AbortError' && alive.current) setNotice({ type: 'error', text: error.message }); })
          .finally(() => { if (alive.current) setLoading(false); });
        return () => { alive.current = false; controller.abort(); };
      }, []);
      const change = (key, value) => { setForm((current) => ({ ...current, [key]: value })); setNotice(null); setConfirmDelete(false); };
      const select = (item) => {
        if (busy) return;
        setForm(item ? { ...blank(item.engine), ...item, password: '', clearPassword: false } : blank());
        setNotice(null); setConfirmDelete(false);
      };
      const newType = (engine) => { if (!busy) { setForm(blank(engine)); setNotice(null); setConfirmDelete(false); } };
      const execute = async (action) => {
        if (busy || (action !== 'remove' && !formRef.current?.reportValidity())) return;
        setBusy(action); setNotice(null); setConfirmDelete(false);
        try {
          const input = action === 'remove' ? { id: form.id } : { ...form, ...(form.engine === 'sqlite' ? {} : { port: Number(form.port) }) };
          const result = await api(action, input);
          if (!alive.current) return;
          if (action === 'test') {
            setNotice({ type: result.ok ? 'success' : 'error', text: result.message || (result.ok ? '连接成功。' : '连接失败，请检查配置。') });
          } else {
            const next = await api('list');
            if (!alive.current) return;
            setItems(next.items || []);
            if (action === 'save') {
              setForm({ ...blank(result.item.engine), ...result.item, password: '', clearPassword: false });
              setNotice({ type: 'success', text: '数据源已保存，可在对话中使用。' });
            } else {
              setForm(blank());
              setNotice({ type: 'success', text: '数据源已删除。' });
            }
          }
        } catch (error) { if (alive.current) setNotice({ type: 'error', text: error.message }); }
        finally { if (alive.current) setBusy(''); }
      };
      const field = (key, label, options = {}) => {
        const id = `ds-${key}`;
        return h('div', { className: `ds-field${options.wide ? ' wide' : ''}`, key },
          h('label', { htmlFor: id }, label, options.required && h('span', { className: 'ds-required', 'aria-hidden': true }, '*')),
          h(options.multiline ? 'textarea' : 'input', {
            id, name: key, value: form[key] ?? '', type: options.type || 'text', required: options.required,
            placeholder: options.placeholder, min: options.min, max: options.max, maxLength: options.maxLength || (key === 'password' ? 4096 : 1024),
            autoComplete: key === 'password' ? 'new-password' : 'off', spellCheck: false,
            onChange: (event) => change(key, event.target.value),
          }), options.help && h('p', { className: 'ds-help' }, options.help));
      };
      const activeEngine = engineOf(form.engine);
      return h('div', { className: 'dsh-ds', 'data-testid': 'datasource-page' }, h('style', null, css), h('div', { className: 'ds-wrap' },
        h('header', { className: 'ds-header' }, h('div', null, h('h1', null, '数据源'), h('p', { className: 'ds-intro' }, '管理数据库连接，在对话中查看表结构和查询数据。')),
          h('button', { className: 'ds-button', type: 'button', disabled: !!busy, onClick: () => select(null) }, '+ 新建数据源')),
        h('div', { className: 'ds-workspace' },
          h('aside', { className: 'ds-sidebar', 'aria-label': '数据源类型与已保存连接' },
            h('h2', { className: 'ds-section-label' }, '选择数据源类型'),
            h('div', { className: 'ds-types' }, engines.map((engine) => h('button', { key: engine.id, type: 'button', className: `ds-type${form.engine === engine.id ? ' is-active' : ''}`, 'aria-pressed': form.engine === engine.id, disabled: !!busy, onClick: () => newType(engine.id) },
              h('span', { className: 'ds-logo', style: { color: engine.color }, 'aria-hidden': true }, engine.mark), h('span', null, h('span', { className: 'ds-type-name' }, engine.name), h('span', { className: 'ds-type-hint' }, engine.subtitle))))),
            h('section', { className: 'ds-connections' }, h('h2', { className: 'ds-section-label' }, `已保存的数据源 · ${items.length}`),
              loading ? h('p', { className: 'ds-muted' }, '正在加载…') : items.length === 0 ? h('p', { className: 'ds-muted' }, '还没有数据源，填写右侧信息即可添加。') : items.map((item) => h('button', { className: `ds-saved${form.id === item.id ? ' is-active' : ''}`, type: 'button', key: item.id, disabled: !!busy, onClick: () => select(item), title: item.name, 'aria-pressed': form.id === item.id }, h('span', { className: 'ds-saved-name' }, item.name), h('span', { className: 'ds-saved-engine' }, engineOf(item.engine).name))))),
          h('main', null, h('form', { className: 'ds-card', ref: formRef, onSubmit: (event) => { event.preventDefault(); void execute('save'); } },
            h('div', { className: 'ds-card-head' }, h('h2', null, `${form.id ? '编辑' : '新建'} ${activeEngine.name} 连接`), h('span', { className: 'ds-badge' }, '只读查询')),
            h('fieldset', { disabled: !!busy || loading }, h('div', { className: 'ds-fields' },
              field('name', '数据源名称', { required: true, wide: true, maxLength: 80, placeholder: '例如：业务数据库' }),
              field('description', '描述', { wide: true, placeholder: '选填，说明这个数据源的用途', maxLength: 500 }),
              ...(form.engine === 'sqlite' ? [field('file', '数据库文件路径', { required: true, wide: true, placeholder: 'D:\\data\\app.db', help: '填写本机已有 SQLite 文件的绝对路径。' })] : [
                field('host', '主机地址 / IP', { required: true, placeholder: '127.0.0.1' }),
                field('port', '端口', { required: true, type: 'number', min: 1, max: 65535 }),
                field('database', '数据库名称', { required: true, placeholder: form.engine === 'postgres' ? 'postgres' : '数据库名称' }),
                field('user', '用户名', { required: true, placeholder: form.engine === 'postgres' ? 'postgres' : '用户名' }),
                field('password', '密码', { type: 'password', wide: true, placeholder: form.hasPassword ? '已保存密码，留空保持不变' : '输入数据库密码', help: form.hasPassword ? '留空保留已保存的密码，填写新密码可替换。' : '密码保存在 DSH 凭据存储中。' }),
                form.hasPassword && h('label', { key: 'clearPassword', className: 'ds-check', style: { gridColumn: '1 / -1' } }, h('input', { type: 'checkbox', checked: !!form.clearPassword, onChange: (event) => change('clearPassword', event.target.checked) }), '清除已保存的密码'),
              ])),
              h('div', { className: 'ds-actions' }, h('button', { className: 'ds-button', type: 'button', onClick: () => void execute('test') }, busy === 'test' ? '正在测试…' : '测试连接'), h('button', { className: 'ds-button primary', type: 'submit' }, busy === 'save' ? '正在保存…' : '保存数据源'), form.id && h('button', { className: 'ds-button danger', type: 'button', onClick: () => setConfirmDelete(true) }, busy === 'remove' ? '正在删除…' : '删除'))),
            confirmDelete && h('div', { className: 'ds-delete', role: 'alert' }, h('span', null, `删除「${form.name}」的连接配置？`), h('button', { className: 'ds-button', type: 'button', disabled: !!busy, onClick: () => void execute('remove') }, '确认删除'), h('button', { className: 'ds-button', type: 'button', onClick: () => setConfirmDelete(false) }, '取消')),
            notice && h('div', { className: `ds-notice ${notice.type}`, role: notice.type === 'error' ? 'alert' : 'status', 'aria-live': 'polite' }, notice.text)),
            h('div', { className: 'ds-footer' }, h('span', null, '可在对话中使用'), ...['sql_list', 'sql_query', 'sql_schema'].map((tool) => h('code', { key: tool }, tool)))))));
    }
    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'datasources' }, DatasourcePage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'datasources', order: 5, label: '数据源' }, DatabaseIcon));
    }
    return { name: 'sql', inject: ['slots', 'layout'], apply };
  },
});
