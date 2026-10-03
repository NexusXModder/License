/* Nexus dashboard: global system maintenance control. */
(() => {
  'use strict';

  const NX = window.NX;
  const { $, toast, showError, withBusy } = NX.ui;
  let ctx = null;

  function render(data) {
    $('#maintenanceEnabled').checked = Boolean(data.enabled);
    $('#maintenanceMessage').value = data.message || '';

    const status = $('#maintenanceStatus');
    if (data.enabled) {
      status.textContent = '● MAINTENANCE ON';
      status.className = 'text-xs font-mono px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300';
    } else {
      status.textContent = '● SYSTEM ONLINE';
      status.className = 'text-xs font-mono px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    }
  }

  async function refresh() {
    if (!ctx) return;
    try {
      render(await ctx.api('GET', '/maintenance'));
    } catch (err) {
      showError(err);
      $('#maintenanceStatus').textContent = 'Unable to load';
    }
  }

  async function save(event) {
    event.preventDefault();
    const enabled = $('#maintenanceEnabled').checked;
    const message = $('#maintenanceMessage').value.trim();

    if (!message) {
      toast('Maintenance message cannot be empty');
      $('#maintenanceMessage').focus();
      return;
    }

    await withBusy($('#maintenanceSave'), 'Saving…', async () => {
      try {
        const data = await ctx.api('PATCH', '/maintenance', { enabled, message });
        render(data);
        toast(enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled');
      } catch (err) {
        showError(err);
      }
    });
  }

  function init(context) {
    ctx = context;
    $('#maintenanceForm').addEventListener('submit', save);
    $('#maintenanceRefresh').addEventListener('click', refresh);
  }

  window.NX.maintenance = { init, refresh };
})();
