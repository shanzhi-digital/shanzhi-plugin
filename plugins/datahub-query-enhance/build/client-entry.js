import React from 'react';
import { KEY } from '../trust.js';
import { registerTrustProjection } from '../event-projection.js';

const h = React.createElement;
const DISPLAY = {
  TRUSTED: { label: '可信指标', explanation: '可信指标是指统计口径、数据来源已经人工确认的指标', color: 'var(--dsw-alias-label-success, #267763)' },
  PARTIAL: { label: '部分可信', explanation: '部分指标已人工确认', color: 'var(--dsw-alias-label-secondary, #79746c)' },
  NOT_TRUSTED: { label: '数据由AI提取，注意辨别', color: 'var(--dsw-alias-label-secondary, #8c6c55)' },
};
const css = `
.dqe-trust{margin:16px 0 8px;font:inherit;font-size:12px;line-height:1.7;text-align:left}
.dqe-trust-line{display:flex;align-items:center;gap:6px}
.dqe-trust-help{display:inline-flex;align-items:center;justify-content:center;flex:none;width:17px;height:17px;padding:0;border:1px solid currentColor;border-radius:50%;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;cursor:pointer;opacity:.8}
.dqe-trust-help:hover{opacity:1}.dqe-trust-help:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.dqe-trust-explanation{width:fit-content;max-width:100%;margin:7px 0 0;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e3df);border-radius:5px;color:var(--dsw-alias-label-secondary,#79746c);background:var(--dsw-alias-bg-layer-1,transparent);overflow-wrap:anywhere}
`;

export function TrustBadge({ trust }) {
  const [open, setOpen] = React.useState(false);
  const explanationId = React.useId();
  React.useEffect(() => { setOpen(false); }, [trust?.level]);
  const display = DISPLAY[trust?.level];
  if (!display) return null;
  return h('aside', { className: 'dqe-trust', 'aria-label': '指标可信状态', style: { color: display.color } },
    h('style', null, css),
    h('div', { className: 'dqe-trust-line' },
      h('span', null, display.label),
      display.explanation ? h('button', {
        className: 'dqe-trust-help', type: 'button', 'aria-label': `${display.label}说明`,
        'aria-expanded': open, 'aria-controls': explanationId, onClick: () => setOpen(value => !value),
        onKeyDown: event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation(); } },
      }, '?') : null),
    open && display.explanation ? h('p', { id: explanationId, className: 'dqe-trust-explanation' }, display.explanation) : null);
}

function TurnTail({ turn }) {
  return h(TrustBadge, { trust: turn.data.get(KEY) });
}

export const inject = ['slots', 'uiConversation'];
export function apply(ctx) {
  registerTrustProjection(ctx);
  ctx.slots.inject('conversation.chat.turnTail', () =>
    ctx.slots.register({ name: 'conversation.chat.turnTail', id: KEY, order: 90 }, TurnTail));
}
