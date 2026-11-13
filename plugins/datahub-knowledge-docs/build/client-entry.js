import React from 'react';
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path';
import { buildPresentation, getDocumentOpenState } from '../results.js';
import { KEY, definition, userTextDefinition } from '../event-projection.js';

const h = React.createElement;
const css = `
.kd-docs{--kd-muted:var(--dsw-alias-label-secondary,#85817a);--kd-border:var(--dsw-alias-border-l1,#e8e5df);color:var(--dsw-alias-label-primary,#302d28);margin:24px 0 12px;font-size:13px;line-height:1.65}
.kd-docs *{box-sizing:border-box}.kd-docs section+section{margin-top:24px}
.kd-header{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:5px 18px;margin-bottom:13px}.kd-title{font-size:14px;font-weight:650;margin:0}.kd-note{color:var(--kd-muted);font-size:12px;margin:0}
.kd-group+.kd-group{margin-top:18px}.kd-base{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;font-size:12px;color:var(--kd-muted)}.kd-base strong{font-weight:550;color:inherit}
.kd-list{list-style:none;padding:0;margin:0;display:grid;gap:8px}.kd-row{border:1px solid var(--kd-border);border-radius:7px;overflow:hidden;background:transparent}
.kd-document{display:flex;align-items:center;gap:10px;padding:9px 12px;min-width:0}.kd-icon{flex:none;color:var(--kd-muted);width:15px;height:18px}.kd-name{flex:1;min-width:0;overflow-wrap:anywhere;font-size:13px;font-weight:500}
.kd-open{font:inherit;font-size:12px;border:0;border-radius:3px;background:transparent;color:var(--kd-muted);padding:3px 0 3px 10px;cursor:pointer;white-space:nowrap;flex:none}.kd-open:hover:not(:disabled){color:var(--dsw-alias-label-primary,#302d28);text-decoration:underline;text-underline-offset:3px}.kd-open:disabled{cursor:default;white-space:normal;max-width:180px;text-align:right;opacity:.8}.kd-docs button:focus-visible,.kd-docs summary:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.kd-evidence{border-top:1px solid var(--kd-border);font-size:12px}.kd-evidence summary{cursor:pointer;color:var(--kd-muted);padding:7px 12px;list-style-position:inside}.kd-evidence[open] summary{border-bottom:1px solid var(--kd-border)}.kd-evidence ol{list-style:none;padding:0 12px;margin:0;max-height:360px;overflow:auto}.kd-fragment{margin:0;padding:12px 0}.kd-fragment+.kd-fragment{border-top:1px solid var(--kd-border)}.kd-fragment-label{display:block;color:var(--kd-muted);font-size:11px;margin-bottom:5px}.kd-fragment p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8}.kd-status{font-size:12px;color:var(--kd-muted);padding:10px 12px;border:1px solid var(--kd-border);border-radius:7px;margin:8px 0}
.kd-error{color:var(--dsw-alias-label-secondary,#85817a);font-size:12px;margin:0;padding:0 12px 9px;overflow-wrap:anywhere}
.kd-more{display:block;margin:12px auto 0;padding:6px 12px;border:0;border-radius:5px;background:transparent;color:var(--kd-muted);font:inherit;font-size:12px;cursor:pointer}.kd-more:hover{background:var(--dsw-alias-bg-layer-1,#f0eee9);color:var(--dsw-alias-label-primary,#302d28)}
@media(max-width:520px){.kd-document{align-items:flex-start;flex-wrap:wrap;padding:10px}.kd-name{flex-basis:calc(100% - 26px)}.kd-open{margin-left:25px;padding:0;text-align:left!important;max-width:none!important}.kd-header{display:block}.kd-note{margin-top:5px}}
`;

function FileIcon() {
  return h('svg', { className: 'kd-icon', viewBox: '0 0 18 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true },
    h('path', { d: 'M10 2H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z' }),
    h('path', { d: 'M10 2v5h5M6 11h6M6 14h6M6 17h4' }));
}

function DocumentRow({ document, purpose, turn, sessionId, connection, sidebarRight }) {
  const [, refresh] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const pending = React.useRef(null);
  const identity = JSON.stringify([sessionId, turn, document.documentRef, document.sourceCallIds]);
  const currentIdentity = React.useRef(identity);
  currentIdentity.current = identity;
  const openState = getDocumentOpenState(document);
  React.useEffect(() => {
    if (!openState.available || !Number.isFinite(openState.expiresAt)) return;
    const delay = Math.min(2147483647, Math.max(1, openState.expiresAt - Date.now()));
    const timer = setTimeout(() => refresh(value => value + 1), delay);
    return () => clearTimeout(timer);
  }, [document, openState.available, openState.expiresAt]);
  React.useEffect(() => {
    setLoading(false);
    setError('');
    const unsubscribe = sidebarRight.mounted.subscribe(() => {
      if (sidebarRight.mounted.getSnapshot() !== sessionId && pending.current) {
        pending.current.abort();
        pending.current = null;
        setLoading(false);
      }
    });
    return () => {
      unsubscribe();
      pending.current?.abort();
      pending.current = null;
    };
  }, [identity, sidebarRight]);
  const open = async () => {
    if (pending.current) return;
    const current = getDocumentOpenState(document);
    if (!current.available) { refresh(value => value + 1); return; }
    const clickedSession = sidebarRight.mounted.getSnapshot();
    const callId = document.sourceCallIds?.find(id => typeof id === 'string' && id.length);
    if (!clickedSession || clickedSession !== sessionId || turn == null || !callId) {
      setError('原文不可用，请重新检索。');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError('');
    const active = () => !controller.signal.aborted && pending.current === controller &&
      currentIdentity.current === identity && sidebarRight.mounted.getSnapshot() === clickedSession;
    try {
      const response = await connection.rpc.call('/api', 'knowledgeDocs/cacheOriginal', {
        args: { sessionId: clickedSession, turn, callId, documentRef: document.documentRef }
      }, controller.signal);
      if (!active()) return;
      if (!response?.ok) {
        setError(originalError(response?.error?.code));
        return;
      }
      const value = response.value;
      if (value?.sessionId !== clickedSession || typeof value.absolutePath !== 'string' || !value.absolutePath) {
        setError('原文加载失败，请重试。');
        return;
      }
      const address = fileAddressFor(clickedSession, undefined, value.absolutePath);
      if (active()) sidebarRight.openResource(address, { destination: 'sidebar' });
    } catch {
      if (active()) setError('原文加载失败，请重试。');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  };
  const evidence = purpose === 'knowledge' ? document.evidence || [] : [];
  const label = loading ? '加载中…' : openState.label;
  return h('li', { className: 'kd-row', 'data-document-ref': document.documentRef },
    h('div', { className: 'kd-document' }, h(FileIcon),
      h('span', { className: 'kd-name' }, document.documentName),
      h('button', { type: 'button', className: 'kd-open', disabled: loading || !openState.available, onClick: open, 'aria-label': `${label}：${document.documentName}` }, label)),
    error ? h('p', { className: 'kd-error', role: 'alert' }, error) : null,
    evidence.length ? h('details', { className: 'kd-evidence' },
      h('summary', null, `检索片段 ${evidence.length} 条`),
      h('ol', null, ...evidence.map((item, index) => h('li', { key: index, className: 'kd-fragment' },
        h('span', { className: 'kd-fragment-label' }, `片段 ${index + 1}`), h('p', null, item.text))))) : null);
}

function originalError(code) {
  return ({
    LINK_EXPIRED: '链接已过期，请重新检索。',
    SOURCE_UNAVAILABLE: '原文不可用，请重新检索。',
    TOO_LARGE: '文件超过预览上限。',
    ACCESS_DENIED: '无会话访问权限。',
    'remote-access/denied': '无会话访问权限。',
    CACHE_ERROR: '原文缓存无法读取，请重试。',
    DOWNLOAD_FAILED: '原文下载失败，请重试。',
    TIMEOUT: '原文下载超时，请重试。'
  })[code] || '原文加载失败，请重试。';
}

function Panel({ panel, turn, sessionId, connection, sidebarRight }) {
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();
  const finding = panel.purpose === 'documents';
  const title = finding ? '找到的文档' : '检索来源';
  const total = panel.groups.reduce((count, group) => count + group.documents.length, 0);
  let remaining = expanded ? total : 5;
  const groups = panel.groups.map(group => {
    const documents = group.documents.slice(0, remaining);
    remaining -= documents.length;
    return { ...group, documents };
  }).filter(group => group.documents.length);
  return h('section', { 'aria-label': title },
    h('div', { className: 'kd-header' }, h('h3', { className: 'kd-title' }, title),
      h('p', { className: 'kd-note' }, finding ? '点击“查看原文”打开文件。' : '以下文档来自本次检索。')),
    h('div', { id: listId }, groups.length ? groups.map(group => h('div', { className: 'kd-group', key: group.knowledgeBaseId },
      h('p', { className: 'kd-base' }, h('span', null, '知识库'), h('strong', null, group.knowledgeBaseName || '未命名知识库')),
      h('ul', { className: 'kd-list' }, ...group.documents.map(document => h(DocumentRow, { key: document.documentRef, document, purpose: panel.purpose, turn, sessionId, connection, sidebarRight }))))) :
      h('p', { className: 'kd-status', role: 'status' }, panel.notice || (finding ? '未找到相关文档。' : '本次检索没有找到相关来源。'))),
    total > 5 ? h('button', { type: 'button', className: 'kd-more', 'aria-expanded': expanded, 'aria-controls': listId,
      onClick: () => setExpanded(value => !value) }, expanded ? '收起文档列表 ↑' : `展开其余 ${total - 5} 份文档 ↓`) : null);
}

export function TurnTail({ turn, connection, sidebarRight }) {
  const subscribe = React.useCallback(listener => sidebarRight.mounted.subscribe(listener), [sidebarRight]);
  const getSnapshot = React.useCallback(() => sidebarRight.mounted.getSnapshot(), [sidebarRight]);
  const sessionId = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const data = turn.data.get(KEY);
  const state = Array.isArray(data) ? { records: data } : data || { records: [] };
  const selection = state.selections?.at(-1)?.value;
  const { panels, notices } = buildPresentation(state.records, {
    userText: state.userText || '', documentMode: state.documentMode, selection
  });
  if (!panels.length && !notices.length) return null;
  const panelKey = panel => `${panel.purpose}:${panel.groups.flatMap(group => group.documents.map(document => document.documentRef)).join('|')}`;
  const noticeText = notice => ({
    error: '问知检索失败，请重试。',
    unsupported: '当前问知接口未提供文档展示数据。',
    invalid: '问知结果数据损坏，无法展示文档。',
    truncated: '历史检索结果已被截短，请重新检索以展示完整来源。'
  }[notice.status] || notice.message);
  return h('div', { className: 'kd-docs' }, h('style', null, css),
    ...panels.map(panel => h(Panel, { key: panelKey(panel), panel, turn: turn.turn ?? state.turn, sessionId, connection, sidebarRight })),
    ...notices.filter(notice => !panels.some(panel => panel.notice === notice.message)).map((notice, index) =>
      h('p', { key: index, className: 'kd-status', role: 'status' }, noticeText(notice))));
}

export const inject = ['slots', 'uiConversation', 'connection', 'sidebarRight'];
export function apply(ctx) {
  ctx.uiConversation.events.register(userTextDefinition);
  ctx.uiConversation.events.register(definition);
  const ConnectedTurnTail = props => h(TurnTail, { ...props, connection: ctx.connection, sidebarRight: ctx.sidebarRight });
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: KEY, order: 20 }, ConnectedTurnTail));
}
