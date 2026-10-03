'use strict';

(() => {
  // ==================================================================
  // DOM helpers: safe rendering (textContent only, never innerHTML)
  // ==================================================================
  const $ = (selector) => document.querySelector(selector);

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'onClick') node.addEventListener('click', value);
      else if (/^on/i.test(key)) continue; // never allow inline handlers
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const show = (node) => node.classList.remove('hidden');
  const hide = (node) => node.classList.add('hidden');

  // Static class strings (kept literal so Tailwind includes them in the build)
  const INPUT =
    'w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-all disabled:opacity-50';
  const BTN = {
    ghost: 'bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 whitespace-nowrap',
    warn: 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 whitespace-nowrap',
    ok: 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 whitespace-nowrap',
    danger: 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-50 whitespace-nowrap',
    primary: 'bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-50 whitespace-nowrap',
  };
  const CONFIRM_BTN = {
    normal: 'flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-2.5 rounded-xl transition-all text-sm',
    danger: 'flex-1 bg-rose-600 hover:bg-rose-500 text-white font-semibold py-2.5 rounded-xl transition-all text-sm',
  };
  const BADGE_BASE = 'inline-flex px-2 py-0.5 border rounded text-xs font-mono capitalize';
  const BADGE = {
    active: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    expired: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    suspended: 'bg-sky-500/10 border-sky-500/20 text-sky-400',
    revoked: 'bg-rose-500/10 border-rose-500/20 text-rose-400',
    disabled: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
    removed: 'bg-slate-500/10 border-slate-500/20 text-slate-400',
  };
  const TAB_ACTIVE =
    'px-4 py-2.5 -mb-px border-b-2 border-indigo-500 text-indigo-400 text-xs font-semibold uppercase tracking-wider font-mono transition-all whitespace-nowrap';
  const TAB_IDLE =
    'px-4 py-2.5 -mb-px border-b-2 border-transparent text-slate-400 hover:text-slate-200 text-xs font-semibold uppercase tracking-wider font-mono transition-all whitespace-nowrap';
  const TOAST = {
    info: 'glass border-indigo-500/30 text-indigo-200 px-4 py-3 rounded-xl text-xs font-medium shadow-2xl',
    success: 'glass border-emerald-500/30 text-emerald-300 px-4 py-3 rounded-xl text-xs font-medium shadow-2xl',
    error: 'glass border-rose-500/30 text-rose-300 px-4 py-3 rounded-xl text-xs font-medium shadow-2xl',
  };

  // ==================================================================
  // State
  // ==================================================================
  const state = {
    sb: null,
    admin: null,
    apps: [],
    tab: 'licenses',
    licenses: { page: 1, pageSize: 20, total: 0 },
    audit: { page: 1, pageSize: 25, total: 0 },
    recovery: false,
    loggingOut: false,
    secretOpen: false,
  };

  // ==================================================================
  // Formatting
  // ==================================================================
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d