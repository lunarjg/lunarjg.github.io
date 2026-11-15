// Small UI helpers: toast, iOS-style action sheets and dialogs, formatting.

import { icon, hydrateIcons } from './icons.js';
import { t, locale } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);

// Touch or mouse, or keyboard: the focus ring is for keyboards. (Chromium counts Enter on a phone's
// on-screen keyboard as a key press, so a dialog closed with it would ring the row that opened it.)
if (typeof document !== 'undefined') {
  const mode = (m) => { if (document.documentElement.dataset.input !== m) document.documentElement.dataset.input = m; };
  document.addEventListener('pointerdown', () => mode('pointer'), true);
  document.addEventListener('keydown', (e) => { if (/^(Tab|Arrow|Page|Home$|End$)/.test(e.key)) mode('key'); }, true);
}
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** 'smooth', or 'auto' when the phone asks for less motion. */
export const scrollBehavior = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, { action, onAction, duration = 2600 } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').onclick = () => { hide(); onAction && onAction(); };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  const hide = () => el.classList.remove('show');
  toastTimer = setTimeout(hide, action ? Math.max(duration, 6000) : duration);
}

export function mountOverlay(html, cls) {
  const root = $('#overlay');
  const wrap = document.createElement('div');
  wrap.className = 'ov ' + cls;
  wrap.innerHTML = `<div class="ov-backdrop"></div>${html}`;
  root.appendChild(wrap);
  hydrateIcons(wrap);
  // Modal for assistive tech and keyboards: the page behind can't be reached until it closes.
  const panel = wrap.children[1];
  if (panel) { panel.setAttribute('aria-modal', 'true'); panel.setAttribute('tabindex', '-1'); }
  const app = document.getElementById('app');
  if (app) app.inert = true;
  const before = document.activeElement;
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector('input, button:not([disabled]), [href]');
      (first && first.tagName !== 'INPUT' ? first : panel).focus({ preventScroll: true });
    }
  });
  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => {
      wrap.remove();
      if (app && !root.querySelector('.ov')) app.inert = false;
      if (before && before.focus && document.contains(before)) before.focus({ preventScroll: true });
    }, 250);
  };
  return { wrap, close };
}

/**
 * Bottom action sheet (phone) / popover-ish card (wide screens).
 * items: [{label, icon, danger, disabled, onClick}] ; returns a close fn.
 */
export function actionSheet({ title, subtitle, items, onCancel }) {
  const html = `
    <div class="asheet" role="dialog">
      ${title ? `<div class="asheet-head"><b>${esc(title)}</b>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</div>` : ''}
      <div class="asheet-group">
        ${items.map((it, i) => `
          <button class="asheet-item ${it.danger ? 'danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>
            <span>${esc(it.label)}</span>${it.icon ? icon(it.icon) : ''}
          </button>`).join('')}
      </div>
      <button class="asheet-cancel">${esc(t('cancel'))}</button>
    </div>`;
  const { wrap, close } = mountOverlay(html, 'ov-sheet');
  const cancel = () => { close(); if (onCancel) onCancel(); }; // also Back / Escape (they press Cancel)
  wrap.querySelector('.ov-backdrop').onclick = cancel;
  wrap.querySelector('.asheet-cancel').onclick = cancel;
  wrap.querySelectorAll('.asheet-item').forEach((b) => {
    b.onclick = () => { close(); const it = items[+b.dataset.i]; it.onClick && it.onClick(); };
  });
  return close;
}

let dialogSeq = 0;
/** iOS alert-style dialog. Resolves to the input value (prompt), true (confirm) or null. */
export function dialog({ title, message, input, placeholder, url = false, numeric = false, okText = t('ok'), cancelText = t('cancel'), danger = false }) {
  return new Promise((resolve) => {
    const html = `
      <div class="alert" role="alertdialog" ${title ? `aria-labelledby="dlg${++dialogSeq}t"` : ''} ${message ? `aria-describedby="dlg${dialogSeq}d"` : ''}>
        <div class="alert-body">
          ${title ? `<b id="dlg${dialogSeq}t">${esc(title)}</b>` : ''}
          ${message ? `<p id="dlg${dialogSeq}d">${esc(message)}</p>` : ''}
          ${input !== undefined ? `<input class="alert-input" value="${esc(input)}" placeholder="${esc(placeholder || '')}"${numeric ? ' inputmode="numeric" enterkeyhint="go" autocomplete="off"' : ''}${url ? ' type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"' : ''} />` : ''}
        </div>
        <div class="alert-btns">
          ${cancelText ? `<button data-r="cancel">${esc(cancelText)}</button>` : ''}
          <button data-r="ok" class="${danger ? 'danger' : 'strong'}">${esc(okText)}</button>
        </div>
      </div>`;
    const { wrap, close } = mountOverlay(html, 'ov-alert');
    const inp = wrap.querySelector('input');
    const done = (ok) => {
      close();
      resolve(ok ? (inp ? inp.value : true) : null);
    };
    wrap.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => done(b.dataset.r === 'ok'); });
    if (inp) {
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); };
    }
  });
}

/**
 * A dialog with several labelled inputs (e.g. a server address, user name and password).
 * fields: [{name, label, type: 'text'|'url'|'password', placeholder, value}]. Resolves to
 * {name: value} or null.
 */
export function formDialog({ title, message, fields, okText = t('ok'), cancelText = t('cancel') }) {
  return new Promise((resolve) => {
    const n = ++dialogSeq;
    const html = `
      <div class="alert form" role="dialog" aria-labelledby="dlg${n}t" ${message ? `aria-describedby="dlg${n}d"` : ''}>
        <div class="alert-body">
          <b id="dlg${n}t">${esc(title)}</b>
          ${message ? `<p id="dlg${n}d">${esc(message)}</p>` : ''}
          ${fields.map((f, i) => `
            <label class="alert-field"><span>${esc(f.label)}</span>
              <input class="alert-input" data-f="${esc(f.name)}" id="dlg${n}f${i}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}"
                type="${f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'}" autocapitalize="off" autocorrect="off" spellcheck="false"
                ${f.type === 'url' ? 'inputmode="url"' : ''} autocomplete="${f.autocomplete || 'off'}" enterkeyhint="${i < fields.length - 1 ? 'next' : 'done'}" />
            </label>`).join('')}
        </div>
        <div class="alert-btns">
          <button data-r="cancel">${esc(cancelText)}</button>
          <button data-r="ok" class="strong">${esc(okText)}</button>
        </div>
      </div>`;
    const { wrap, close } = mountOverlay(html, 'ov-alert');
    const inputs = [...wrap.querySelectorAll('input[data-f]')];
    const done = (ok) => {
      const out = {};
      for (const inp of inputs) out[inp.dataset.f] = inp.value;
      for (const inp of inputs) inp.value = ''; // a password doesn't stay in the page
      close();
      resolve(ok ? out : null);
    };
    wrap.querySelectorAll('[data-r]').forEach((b) => { b.onclick = () => done(b.dataset.r === 'ok'); });
    inputs.forEach((inp, i) => {
      inp.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        if (i < inputs.length - 1) inputs[i + 1].focus(); else done(true);
      };
    });
    setTimeout(() => { const first = inputs.find((x) => !x.value) || inputs[0]; if (first) first.focus(); }, 50);
  });
}

/** Full-height modal page (used for folder picker / setup guide). Returns {el, close}. */
export function modalPage({ title, body, onClose, rightButton }) {
  const html = `
    <div class="mpage" role="dialog">
      <header class="mpage-head">
        <button class="textbtn" data-mp="close">${esc(t('close'))}</button>
        <b>${esc(title)}</b>
        ${rightButton ? `<button class="textbtn strong" data-mp="right">${esc(rightButton.label)}</button>` : '<span></span>'}
      </header>
      <div class="mpage-body">${body}</div>
    </div>`;
  const { wrap, close } = mountOverlay(html, 'ov-page');
  const doClose = () => { close(); onClose && onClose(); };
  wrap.querySelector('[data-mp=close]').onclick = doClose;
  if (rightButton) wrap.querySelector('[data-mp=right]').onclick = () => rightButton.onClick(doClose);
  return { el: wrap.querySelector('.mpage-body'), wrap, close: doClose };
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${t('today')} ${d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}`;
  }
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('yesterday');
  return d.toLocaleDateString(locale(), { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function fmtAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return t('justNow');
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.max(1, Math.round(s / 60)), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

export function fmtSize(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Deterministic pastel cover color for notebooks that have no cover yet. */
export function coverColor(name) {
  // Muted, bookbinding-like cloth colors (fit the paper & ink palette).
  const palette = ['#5f8f84', '#c9825a', '#7d6fa8', '#b85f5f', '#4f7ea6', '#b39449', '#3f6f6a', '#9b6a8c', '#6f8f4f', '#b3743e'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return palette[h % palette.length];
}
