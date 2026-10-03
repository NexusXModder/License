(() => {
  'use strict';

  const panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;z-index:99999;top:8px;left:8px;right:8px;max-height:40vh;overflow:auto;background:#111;color:#fff;padding:12px;border:2px solid #f90;border-radius:8px;font:13px monospace;white-space:pre-wrap';
  panel.textContent = 'Nexus diagnostic starting…';
  document.documentElement.appendChild(panel);

  const messages = [];
  const report = (message) => {
    messages.push(String(message));
    panel.textContent = messages.slice(-8).join('\n');
  };

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window) {
      report(`Asset load error: ${target.src || target.href || target.tagName}`);
    } else {
      report(`JavaScript error: ${event.message || 'unknown'} (${event.filename || ''}:${event.lineno || ''})`);
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    report(`Async error: ${event.reason?.message || String(event.reason)}`);
  });

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const nx = window.NX || {};
      report(`Loaded globals — UI: ${!!nx.ui}, licenses: ${!!nx.licenses}, apps: ${!!nx.apps}, Supabase: ${!!window.supabase}`);
    }, 1500);
  });
})();