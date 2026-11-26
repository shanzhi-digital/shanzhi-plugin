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
[data-slot="conversation.chat.turnTail"] > :has([aria-label="后续问题"]):has(+ .dqe-trust){margin-bottom:0!important}
[data-slot="conversation.chat.turnTail"] > :has([aria-label="后续问题"]) + .dqe-trust{margin-top:-4px}
.dqe-trust{margin:0;font:inherit;font-size:12px;line-height:20px;text-align:left}
.dqe-trust-line{display:flex;align-items:center;gap:4px}
.dqe-trust-help{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;min-width:0;min-height:0;margin:0;padding:3px;border:0;border-radius:50%;background:transparent;box-shadow:none;color:inherit;font:inherit;line-height:1;cursor:pointer;opacity:.7}
.dqe-trust-help svg{display:block;flex:none;width:14px;height:14px}
.dqe-trust-help:hover{opacity:1}.dqe-trust-help:focus-visible{outline:2px solid currentColor;outline-offset:2px}
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
      }, h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('path', { d: 'M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5' }),
        h('circle', { cx: 12, cy: 16.5, r: .8, fill: 'currentColor', stroke: 'none' }))) : null),
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
