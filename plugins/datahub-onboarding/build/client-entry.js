import React from 'react';
import { CLIENT_LOCALE } from '../constants.js';
import { en, zh } from '../locales.js';
import { callOnboardingRpc as rpc } from '../transport.js';

const h = React.createElement;
const css = `
.dho{max-width:760px;padding:16px 4px;color:var(--dsw-alias-label-primary,#302d28);font-size:14px;line-height:1.65}
.dho *{box-sizing:border-box}.dho h2{font-size:20px;margin:0 0 6px}.dho-desc{margin:0 0 20px;color:var(--dsw-alias-label-secondary,#79746c)}
.dho-field{margin:0 0 16px}.dho-label{display:block;font-weight:600;margin-bottom:6px}.dho-input{width:100%;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2,#cbc7bf);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit}
.dho-input[readonly]{color:var(--dsw-alias-label-secondary,#79746c);background:var(--dsw-alias-bg-layer-2,#f5f4f1);overflow:hidden;text-overflow:ellipsis}
.dho-keyline{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.dho-saved{font-size:12px;color:var(--dsw-alias-label-secondary,#79746c)}
.dho-actions{display:flex;flex-wrap:wrap;gap:9px;margin:14px 0 18px}.dho-button{padding:7px 15px;border:1px solid var(--dsw-alias-border-l3,#b9b4aa);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f4f1);color:inherit;font:inherit;cursor:pointer}
.dho-button.primary{background:var(--dsw-alias-brand-primary,#315efb);border-color:transparent;color:#fff}.dho-button.danger{color:var(--dsw-alias-label-error,#a33232)}
.dho-button:disabled{opacity:.5;cursor:not-allowed}.dho-button:focus-visible,.dho-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#315efb);outline-offset:2px}
.dho-notice{padding:10px 12px;margin:0 0 14px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f5f4f1);color:var(--dsw-alias-label-secondary,#66615a);white-space:pre-wrap;overflow-wrap:anywhere}
.dho-notice.error{background:var(--dsw-alias-bg-danger,rgba(180,45,45,.1));color:var(--dsw-alias-label-error,#923b3b)}
.dho-services{margin-top:22px}.dho-services h3{font-size:15px;margin:0 0 9px}.dho-row{display:flex;justify-content:space-between;gap:16px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1,#e4e0d9);border-radius:6px;margin-bottom:8px}
.dho-row span:last-child{text-align:right;color:var(--dsw-alias-label-secondary,#79746c)}.dho-security{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b867e);margin-top:18px}
@media(max-width:520px){.dho-row{display:block}.dho-row span{display:block;text-align:left!important}.dho-row span+span{margin-top:4px}.dho-keyline{display:block}.dho-saved{display:block;margin-bottom:6px}}
`;

function serviceLabel(name, t) {
  return name === 'datahub-ask-data' ? t('askData') : t('knowledge');
}

function safeTranslation(t, key, fallback) {
  const value = t(key);
  return value === key ? t(fallback) : value;
}

function serviceState(service, t) {
  if (service.managedBy === 'legacy') return t('legacyManaged');
  const runtime = safeTranslation(t, `state.${service.state}`, 'state.unknown');
  if (['failed', 'validating', 'succeeded'].includes(service.probe)) {
    return `${t(`probe.${service.probe}`)} · ${runtime}`;
  }
  return runtime;
}

export function DataHubSettingsSection({ connection, t }) {
  const [state, setState] = React.useState(undefined);
  const [apiKey, setApiKey] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [localError, setLocalError] = React.useState(undefined);
  const action = React.useRef(null);
  const previousOrigin = React.useRef(undefined);

  React.useEffect(() => {
    let active = true;
    let loading = false;
    let request;
    const load = async () => {
      if (loading) return;
      loading = true;
      request = new AbortController();
      try {
        const value = await rpc(connection, 'state', {}, request.signal);
        if (active) { setState(value); setLocalError(undefined); }
      } catch {
        if (active && !request.signal.aborted) setLocalError('RPC_FAILED');
      } finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => { active = false; clearInterval(timer); request?.abort(); };
  }, [connection]);

  React.useEffect(() => {
    if (previousOrigin.current !== undefined && previousOrigin.current !== state?.origin) setApiKey('');
    previousOrigin.current = state?.origin;
  }, [state?.origin]);

  React.useEffect(() => () => { action.current?.abort(); }, []);

  const perform = async (method, payload) => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setPending(true);
    setLocalError(undefined);
    try {
      const value = await rpc(connection, method, payload, controller.signal);
      setState(value);
      if (method === 'connect' && value?.phase === 'connected') setApiKey('');
      if (method === 'clearKey') setApiKey('');
    } catch {
      if (!controller.signal.aborted) setLocalError('RPC_FAILED');
    } finally {
      if (action.current === controller) action.current = null;
      setPending(false);
    }
  };

  const cancel = () => {
    action.current?.abort();
    void rpc(connection, 'cancel', {}).then(value => setState(value)).catch(() => {});
  };

  const busy = pending || state?.busy === true;
  const legacy = state?.legacyManaged === true;
  const disabled = busy || legacy;
  const errorCode = localError ?? state?.error?.code;
  let notice;
  if (!state) notice = t('validating');
  else if (legacy) notice = t('legacyNotice');
  else if (state.phase === 'environment-required') notice = t('environmentRequired');
  else if (state.phase === 'environment-changed') notice = t('environmentChanged');
  else if (state.phase === 'connected') notice = t('connectedNotice');
  else if (!errorCode) notice = t('unconfiguredNotice');
  const failure = state?.error?.details?.failures?.[0];
  const failureService = state?.error?.details?.service ?? failure?.service;
  const failureStage = state?.error?.details?.stage ?? failure?.stage;

  return h('div', { className: 'dho' },
    h('style', null, css),
    h('h2', null, t('title')),
    h('p', { className: 'dho-desc' }, t('description')),
    notice ? h('p', { className: 'dho-notice', role: 'status' }, notice) : null,
    errorCode ? h('div', { className: 'dho-notice error', role: 'alert' },
      h('strong', null, t('errorTitle')), '：', safeTranslation(t, `error.${errorCode}`, 'error.generic'),
      failureService ? h('div', null, serviceLabel(failureService, t), failureStage ? ` · ${t(`stage.${failureStage}`)}` : '') : null) : null,
    state?.warning ? h('p', { className: 'dho-notice error', role: 'alert' },
      h('strong', null, t('warningTitle')), '：', safeTranslation(t, `error.${state.warning}`, 'error.generic')) : null,
    h('form', { onSubmit: event => { event.preventDefault(); if (!disabled && apiKey.trim() && state?.origin) void perform('connect', { apiKey, origin: state.origin }); } },
      h('div', { className: 'dho-field' },
        h('label', { className: 'dho-label', htmlFor: 'dho-origin' }, t('origin')),
        h('input', { id: 'dho-origin', className: 'dho-input', value: state?.origin ?? '', placeholder: t('originMissing'), readOnly: true, 'aria-readonly': true })),
      h('div', { className: 'dho-field' },
        h('div', { className: 'dho-keyline' },
          h('label', { className: 'dho-label', htmlFor: 'dho-api-key' }, t('apiKey')),
          h('span', { className: 'dho-saved' }, state?.configured ? state.phase === 'connected' ? t('keySaved') : t('keySavedDisconnected') : t('keyNotSaved'))),
        h('input', {
          id: 'dho-api-key', className: 'dho-input', type: 'password', value: apiKey,
          placeholder: t('apiKeyPlaceholder'), autoComplete: 'new-password', spellCheck: false,
          disabled, required: true, onChange: event => setApiKey(event.target.value),
        })),
      h('div', { className: 'dho-actions' },
        h('button', { className: 'dho-button primary', type: 'submit', disabled: disabled || !apiKey.trim() || !state?.origin }, busy && state?.phase === 'validating' ? t('validating') : t('validateConnect')),
        busy && !legacy ? h('button', { className: 'dho-button', type: 'button', onClick: cancel }, t('cancel')) : null,
        state?.canRetry && !disabled ? h('button', { className: 'dho-button', type: 'button', onClick: () => void perform('retry', { origin: state.origin }) }, t('retry')) : null,
        state?.services?.some(service => service.registered) && !legacy ? h('button', { className: 'dho-button', type: 'button', disabled: busy, onClick: () => void perform('disconnect') }, t('disconnect')) : null,
        state?.configured && !legacy ? h('button', { className: 'dho-button danger', type: 'button', disabled: busy, onClick: () => { if (window.confirm(t('confirmClear'))) void perform('clearKey'); } }, t('clearKey')) : null)),
    h('section', { className: 'dho-services', 'aria-label': t('services') },
      h('h3', null, t('services')),
      ...(state?.services ?? []).map(service => h('div', { className: 'dho-row', key: service.name },
        h('span', null, serviceLabel(service.name, t)), h('span', null, serviceState(service, t))))),
    h('p', { className: 'dho-security' }, t('security')));
}

export const inject = ['slots', 'locale', 'connection'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(CLIENT_LOCALE, { zh, en }), 'datahub-onboarding: locales');
  const t = ctx.locale.bind(CLIENT_LOCALE);
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'datahub-onboarding',
    order: 25,
    label: () => t('nav'),
    locale: CLIENT_LOCALE,
    inject: () => ({ connection: ctx.connection }),
  }, DataHubSettingsSection));
}
