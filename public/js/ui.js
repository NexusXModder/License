(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'value') el.value = value;
      else if (key === 'checked') el.checked = Boolean(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }

    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  class UiError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = 'UiError';
      this.code = code;
      this.status = status;
    }
  }

  function toast(message, type = 'success') {
    const color = type === 'error'
      ? 'border-rose-500/40 text-rose-300'
      : 'border-emerald-500/40 text-emerald-300';

    const item = h(
      'div',
      { class: `glass ${color} px-4 py-3 rounded-xl text-sm shadow-2xl max-w-sm`, role: 'status' },
      message
    );
    $('#toastRoot').append(item);
    setTimeout(() => item.remove(), type === 'error' ? 6000 : 3500);
  }

  function showError(err) {
    if (err?.code !== 'signed_out') toast(err?.message || 'Something went wrong', 'error');
  }

  let activeClose = null;

  function openModal({ title, body, actions = [], dismissible = true, wide = false, onClose } = {}) {
    if (activeClose) activeClose();

    const root = $('#modalRoot');
    let closed = false;

    function onKey(event) {
      if (event.key === 'Escape' && dismissible) close();
    }

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      if (activeClose === close) activeClose = null;
      clear(root);
      root.classList.add('hidden');
      onClose?.();
    }

    const panel = h(
      'div',
      {
        class: `glass w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto`,
        role: 'dialog',
        'aria-modal': 'true',
      },
      h(
        'div',
        { class: 'flex items-start justify-between gap-4 mb-4' },
        h('h3', { class: 'text-lg font-bold text-white' }, title),
        dismissible
          ? h('button', {
              type: 'button',
              class: 'text-slate-400 hover:text-white text-2xl',
              'aria-label': 'Close',
              onclick: close,
            }, '×')
          : null
      ),
      body,
      actions.length ? h('div', { class: 'flex flex-wrap justify-end gap-2 mt-6' }, actions.filter(Boolean)) : null
    );

    const overlay = h(
      'div',
      { class: 'fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-40' },
      panel
    );
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && dismissible) close();
    });

    clear(root);
    root.append(overlay);
    root.classList.remove('hidden');
    document.addEventListener('keydown', onKey);
    activeClose = close;
    return close;
  }

  function confirmAction({ title, message, confirmLabel = 'Confirm', danger = true, withReason = false }) {
    return new Promise((resolve) => {
      let result = null;
      let close;

      const reason = withReason
        ? h('textarea', {
            class: 'nx-input mt-3',
            rows: '2',
            maxlength: '300',
            placeholder: 'Reason (optional)',
          })
        : null;

      const cancel = h('button', {
        type: 'button',
        class: 'nx-btn-ghost px-4 py-2',
        onclick: () => close(),
      }, 'Cancel');

      const confirm = h('button', {
        type: 'button',
        class: danger ? 'nx-btn-danger px-4 py-2' : 'nx-btn',
        onclick: () => {
          result = { reason: reason ? reason.value.trim() : '' };
          close();
        },
      }, confirmLabel);

      close = openModal({
        title,
        body: h('div', {},
          h('p', { class: 'text-sm text-slate-300' }, message),
          reason
        ),
        actions: [cancel, confirm],
        onClose: () => resolve(result),
      });
    });
  }

  async function withBusy(button, busyText, fn) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
      return await fn();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function copyText(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast(label);
      return true;
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
      return false;
    }
  }

  const fmtDate = (v) => v
    ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
  const fmtDateTime = (v) => v ? new Date(v).toLocaleString() : '—';
  const maskKey = (hint) => `NX-•••••-•••••-•••••-•••••-•${hint || '????'}`;

  const badgeColors = {
    active: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    expired: 'bg-rose-500/10 border-rose-500/20 text-rose-400',
    suspended: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    revoked: 'bg-slate-500/10 border-slate-500/30 text-slate-400',
    disabled: 'bg-slate-500/10 border-slate-500/30 text-slate-400',
    removed: 'bg-slate-500/10 border-slate-500/30 text-slate-500',
  };

  const badge = (status) =>
    h('span', { class: `nx-badge ${badgeColors[status] || badgeColors.revoked}` }, status);

  function setTableMessage(tbody, cols, text) {
    clear(tbody);
    tbody.append(h('tr', {},
      h('td', {
        colspan: String(cols),
        class: 'p-6 text-center text-slate-500 font-mono text-xs',
      }, text)
    ));
  }

  function renderPager(container, state, reload) {
    clear(container);
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));

    container.append(
      h('span', { class: 'text-xs font-mono text-slate-500' }, `Page ${state.page} of ${pages}`),
      h('div', { class: 'flex gap-2' },
        h('button', {
          type: 'button',
          class: 'nx-btn-ghost',
          disabled: state.page <= 1,
          onclick: () => { state.page -= 1; reload(); },
        }, '← Prev'),
        h('button', {
          type: 'button',
          class: 'nx-btn-ghost',
          disabled: state.page >= pages,
          onclick: () => { state.page += 1; reload(); },
        }, 'Next →')
      )
    );
  }

  function qs(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== '' && value != null) search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function field(label, input, hint) {
    return h('div', {},
      h('label', { class: 'nx-label' }, label),
      input,
      hint ? h('p', { class: 'text-[11px] text-slate-500 mt-1' }, hint) : null
    );
  }

  window.NX = window.NX || {};
  window.NX.ui = {
    $, $$, h, clear, UiError, toast, showError, openModal, confirmAction,
    withBusy, copyText, fmtDate, fmtDateTime, maskKey, badge,
    setTableMessage, renderPager, qs, debounce, field,
  };
})();