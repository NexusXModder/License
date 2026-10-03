/* Nexus dashboard: license generation, list, details, status changes, devices. */
(() => {
  'use strict';

  const NX = window.NX;
  const {
    $, h, clear, toast, showError, openModal, confirmAction, withBusy, copyText,
    fmtDate, fmtDateTime, maskKey, badge, setTableMessage, renderPager, qs, debounce, field,
  } = NX.ui;

  let ctx = null;
  const appById = (id) => ctx.state.apps.find((a) => a.id === id);

  function init(context) {
    ctx = context;
    const s = ctx.state.lic;
    $('#genApp').addEventListener('change', syncGeneratorDefaults);
    $('#genLifetime').addEventListener('change', () => {
      $('#genDuration').disabled = $('#genLifetime').checked;
    });
    $('#generatorForm').addEventListener('submit', onGenerate);
    $('#licSearch').addEventListener('input', debounce((e) => {
      s.search = e.target.value.trim();
      s.page = 1;
      refresh();
    }, 400));
    $('#licStatus').addEventListener('change', (e) => {
      s.status = e.target.value;
      s.page = 1;
      refresh();
    });
    $('#licAppFilter').addEventListener('change', (e) => {
      s.appId = e.target.value;
      s.page = 1;
      refresh();
    });
    $('#licRefresh').addEventListener('click', () => {
      refresh();
      ctx.refreshStats();
    });
  }

  // ------------------------------------------------------------- Generator
  function onAppsChanged() {
    const genSel = $('#genApp');
    const filterSel = $('#licAppFilter');
    const prevGen = genSel.value;
    const prevFilter = ctx.state.lic.appId;
    clear(genSel);
    clear(filterSel);

    const active = ctx.state.apps.filter((a) => a.status === 'active');
    if (!active.length) genSel.append(h('option', { value: '' }, 'No active applications'));
    for (const a of active) genSel.append(h('option', { value: a.id }, a.name));

    filterSel.append(h('option', { value: '' }, 'All applications'));
    for (const a of ctx.state.apps) {
      filterSel.append(h('option', { value: a.id }, a.status === 'active' ? a.name : `${a.name} (disabled)`));
    }

    if (active.some((a) => a.id === prevGen)) genSel.value = prevGen;
    filterSel.value = ctx.state.apps.some((a) => a.id === prevFilter) ? prevFilter : '';
    if (genSel.value !== prevGen) syncGeneratorDefaults();
  }

  function syncGeneratorDefaults() {
    const app = appById($('#genApp').value);
    const wrap = $('#genLifetimeWrap');
    const allow = Boolean(app && app.allowLifetime);
    wrap.classList.toggle('hidden', !allow);
    wrap.classList.toggle('flex', allow);
    if (!allow) $('#genLifetime').checked = false;
    $('#genDuration').disabled = $('#genLifetime').checked;
    if (!app) return;
    $('#genDuration').value = String(app.defaultDurationDays);
    $('#genDuration').max = String(app.maxDurationDays);
    $('#genDevices').value = String(app.defaultMaxDevices);
    $('#genDevices').max = String(app.maxDevicesCap);
  }

  async function onGenerate(e) {
    e.preventDefault();
    const appId = $('#genApp').value;
    if (!appId) return toast('Create or enable an application first (Applications tab).', 'error');
    const label = $('#genLabel').value.trim();
    if (!label) return toast('Enter a customer name or label.', 'error');

    const body = { appId, label, maxDevices: Number($('#genDevices').value) };
    if ($('#genLifetime').checked) body.lifetime = true;
    else body.durationDays = Number($('#genDuration').value);

    await withBusy($('#genSubmit'), 'Generating…', async () => {
      try {
        const data = await ctx.api('POST', '/licenses', body);
        $('#genLabel').value = '';
        showNewKey(data.licenseKey, data.license);
        refresh();
        ctx.refreshStats();
      } catch (err) {
        showError(err);
      }
    });
  }

  function showNewKey(key, license) {
    const ack = h('input', { type: 'checkbox', class: 'accent-indigo-500' });
    const doneBtn = h('button', { type: 'button', class: 'nx-btn', disabled: true, onclick: () => close() }, 'Done');
    ack.addEventListener('change', () => {
      doneBtn.disabled = !ack.checked;
    });
    const copyBtn = h('button', {
      type: 'button',
      class: 'nx-btn-ghost px-4 py-2',
      onclick: async () => {
        if (await copyText(key, 'License key copied')) {
          copyBtn.textContent = 'Copied ✓';
          ack.checked = true;
          doneBtn.disabled = false;
        }
      },
    }, 'Copy key');

    const close = openModal({
      title: 'License key generated',
      dismissible: false,
      body: h('div', { class: 'space-y-4' },
        h('p', { class: 'text-sm text-slate-300' }, 'For ',
          h('span', { class: 'font-semibold text-white' }, license.label),
          license.app ? ` · ${license.app.name}` : ''),
        h('div', { class: 'font-mono text-indigo-300 text-base md:text-lg tracking-wider break-all bg-slate-950 border border-indigo-500/30 rounded-xl p-4 select-all' }, key),
        h('div', { class: 'rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300' },
          '⚠ This key is shown only once. Nexus stores only a one-way hash, so it cannot be recovered later. Copy it now and deliver it to your customer securely.'),
        h('label', { class: 'flex items-center gap-2 text-xs text-slate-300' }, ack, 'I have copied and saved this key')),
      actions: [copyBtn, doneBtn],
    });
  }

  // ------------------------------------------------------------- List
  async function refresh() {
    const s = ctx.state.lic;
    const tbody = $('#licTableBody');
    setTableMessage(tbody, 7, 'Loading licenses…');
    try {
      const data = await ctx.api('GET', `/licenses${qs({
        page: s.page, pageSize: s.pageSize, search: s.search, status: s.status, appId: s.appId,
      })}`);
      s.total = data.total;
      render(data.items);
    } catch (err) {
      setTableMessage(tbody, 7, 'Failed to load licenses.');
      showError(err);
    }
  }

  function render(items) {
    const s = ctx.state.lic;
    const tbody = $('#licTableBody');
    $('#licCount').textContent = `Total: ${s.total}`;
    clear(tbody);
    if (!items.length) {
      setTableMessage(tbody, 7, s.search || s.status || s.appId ? 'No licenses match your filters.' : 'No licenses generated yet.');
    }
    for (const l of items) {
      tbody.append(h('tr', { class: 'hover:bg-slate-900/40 transition-all' },
        h('td', { class: 'p-4 font-semibold text-white' }, l.label),
        h('td', { class: 'p-4 font-mono text-indigo-400 tracking-wider text-xs whitespace-nowrap' }, maskKey(l.keyHint)),
        h('td', { class: 'p-4 text-xs text-slate-300' }, l.app ? l.app.name : '—'),
        h('td', { class: 'p-4 font-mono text-xs text-slate-300 whitespace-nowrap' }, `${l.devicesUsed ?? 0} / ${l.maxDevices}`),
        h('td', { class: 'p-4 font-mono text-xs text-slate-400 whitespace-nowrap' }, l.expiresAt ? fmtDate(l.expiresAt) : 'Lifetime'),
        h('td', { class: 'p-4' }, badge(l.effectiveStatus)),
        h('td', { class: 'p-4 text-right' },
          h('button', { type: 'button', class: 'nx-btn-ghost', onclick: () => openLicense(l.id) }, 'Manage'))));
    }
    renderPager($('#licPager'), s, refresh);
  }

  // ------------------------------------------------------------- Details
  async function openLicense(id) {
    let data;
    try {
      data = await ctx.api('GET', `/licenses/${encodeURIComponent(id)}`);
    } catch (err) {
      return showError(err);
    }
    const { license: l, devices } = data;

    const info = (k, v) => h('div', {},
      h('div', { class: 'text-[11px] uppercase tracking-wider text-slate-500 font-mono' }, k),
      h('div', { class: 'text-sm text-slate-200 mt-0.5 break-words' }, v));

    const grid = h('div', { class: 'grid grid-cols-2 md:grid-cols-3 gap-4' },
      info('Label', l.label),
      info('Status', badge(l.effectiveStatus)),
      info('Application', l.app ? l.app.name : '—'),
      info('Key', h('span', { class: 'font-mono text-indigo-400 text-xs' }, maskKey(l.keyHint))),
      info('Devices', `${l.devicesUsed ?? 0} / ${l.maxDevices}`),
      info('Expires', l.expiresAt ? fmtDateTime(l.expiresAt) : 'Lifetime'),
      info('Created', fmtDateTime(l.createdAt)),
      info('Last activated', fmtDateTime(l.lastActivatedAt)),
      info('Last verified', fmtDateTime(l.lastVerifiedAt)),
      l.statusReason ? info('Status reason', l.statusReason) : null);

    const activeCount = devices.filter((d) => d.status === 'active').length;
    const rows = devices.length
      ? devices.map((d) => h('tr', { class: 'border-t border-slate-800/60' },
        h('td', { class: 'p-3 text-xs text-slate-200' }, d.label || 'Unnamed device'),
        h('td', { class: 'p-3' }, badge(d.status)),
        h('td', { class: 'p-3 font-mono text-xs text-slate-400 whitespace-nowrap' }, fmtDateTime(d.createdAt)),
        h('td', { class: 'p-3 font-mono text-xs text-slate-400 whitespace-nowrap' }, fmtDateTime(d.lastSeenAt)),
        h('td', { class: 'p-3 text-right' }, d.status === 'active'
          ? h('button', { type: 'button', class: 'nx-btn-danger', onclick: () => removeDevice(l, d) }, 'Remove')
          : h('span', { class: 'text-xs text-slate-500' }, d.removedReason || ''))))
      : [h('tr', {}, h('td', { colspan: '5', class: 'p-4 text-center text-xs text-slate-500 font-mono' }, 'No devices registered yet.'))];

    const body = h('div', { class: 'space-y-6' },
      grid,
      h('div', {},
        h('div', { class: 'flex items-center justify-between mb-2' },
          h('h4', { class: 'text-xs font-semibold uppercase tracking-wider text-slate-300 font-mono' }, 'Devices'),
          activeCount ? h('button', { type: 'button', class: 'nx-btn-danger', onclick: () => resetDevices(l, activeCount) }, 'Reset all devices') : null),
        h('div', { class: 'nx-table-wrap' },
          h('table', { class: 'nx-table' },
            h('thead', { class: 'nx-thead' }, h('tr', {},
              h('th', { class: 'p-3' }, 'Device'), h('th', { class: 'p-3' }, 'Status'),
              h('th', { class: 'p-3' }, 'Registered'), h('th', { class: 'p-3' }, 'Last seen'), h('th', { class: 'p-3' }))),
            h('tbody', {}, rows)))));

    const actions = [];
    if (l.status === 'active') actions.push(h('button', { type: 'button', class: 'nx-btn-warn px-4 py-2', onclick: () => changeStatus(l, 'suspend') }, 'Suspend'));
    if (l.status === 'suspended') actions.push(h('button', { type: 'button', class: 'nx-btn-success px-4 py-2', onclick: () => changeStatus(l, 'reactivate') }, 'Reactivate'));
    if (l.status !== 'revoked') {
      actions.push(h('button', { type: 'button', class: 'nx-btn-ghost px-4 py-2', onclick: () => editLicense(l) }, 'Edit'));
      actions.push(h('button', { type: 'button', class: 'nx-btn-danger px-4 py-2', onclick: () => changeStatus(l, 'revoke') }, 'Revoke'));
    }

    openModal({ title: 'License details', body, actions, wide: true });
  }

  const STATUS_TEXT = {
    suspend: { title: 'Suspend license?', msg: 'will stop working on all devices until you reactivate it.', btn: 'Suspend', done: 'suspended', danger: true },
    reactivate: { title: 'Reactivate license?', msg: 'will work again on its registered devices.', btn: 'Reactivate', done: 'reactivated', danger: false },
    revoke: { title: 'Revoke license permanently?', msg: 'will be permanently disabled. This cannot be undone.', btn: 'Revoke permanently', done: 'revoked', danger: true },
  };

  async function changeStatus(l, action) {
    const t = STATUS_TEXT[action];
    const result = await confirmAction({
      title: t.title,
      message: `"${l.label}" ${t.msg}`,
      confirmLabel: t.btn,
      danger: t.danger,
      withReason: action !== 'reactivate',
    });
    if (!result) return openLicense(l.id);
    try {
      await ctx.api('POST', `/licenses/${encodeURIComponent(l.id)}/${action}`, result.reason ? { reason: result.reason } : {});
      toast(`License ${t.done}`);
      refresh();
      ctx.refreshStats();
    } catch (err) {
      showError(err);
    }
    return openLicense(l.id);
  }

  function editLicense(l) {
    const app = appById(l.appId);
    const allowLifetime = Boolean(app && app.allowLifetime);
    const origDate = l.expiresAt ? l.expiresAt.slice(0, 10) : '';

    const label = h('input', { class: 'nx-input', maxlength: '120', value: l.label });
    const devices = h('input', { class: 'nx-input', type: 'number', min: '1', max: String(app ? app.maxDevicesCap : 100), value: String(l.maxDevices) });
    const expiry = h('input', { class: 'nx-input', type: 'date', value: origDate });
    const lifetime = h('input', { type: 'checkbox', class: 'accent-indigo-500', checked: !l.expiresAt });
    expiry.disabled = allowLifetime && lifetime.checked;
    lifetime.addEventListener('change', () => {
      expiry.disabled = lifetime.checked;
    });

    const save = h('button', { type: 'button', class: 'nx-btn' }, 'Save changes');
    save.addEventListener('click', () => withBusy(save, 'Saving…', async () => {
      const body = {};
      if (label.value.trim() !== l.label) body.label = label.value.trim();
      if (Number(devices.value) !== l.maxDevices) body.maxDevices = Number(devices.value);
      if (allowLifetime && lifetime.checked) {
        if (l.expiresAt) body.expiresAt = null;
      } else if (expiry.value && expiry.value !== origDate) {
        body.expiresAt = new Date(`${expiry.value}T23:59:59`).toISOString();
      }
      if (!Object.keys(body).length) return openLicense(l.id);
      try {
        await ctx.api('PATCH', `/licenses/${encodeURIComponent(l.id)}`, body);
        toast('License updated');
        refresh();
        return openLicense(l.id);
      } catch (err) {
        return showError(err);
      }
    }));

    openModal({
      title: 'Edit license',
      body: h('div', { class: 'space-y-4' },
        field('Customer / label', label),
        field(`Max devices (app limit ${app ? app.maxDevicesCap : '—'})`, devices, 'Lowering this does not remove devices that are already registered.'),
        field('Expiry date', expiry),
        allowLifetime ? h('label', { class: 'flex items-center gap-2 text-xs text-slate-300' }, lifetime, 'Lifetime (never expires)') : null),
      actions: [
        h('button', { type: 'button', class: 'nx-btn-ghost px-4 py-2', onclick: () => openLicense(l.id) }, 'Cancel'),
        save,
      ],
    });
  }

  async function removeDevice(l, d) {
    const ok = await confirmAction({
      title: 'Remove device?',
      message: `"${d.label || 'Unnamed device'}" will lose access immediately and its slot will be freed.`,
      confirmLabel: 'Remove device',
    });
    if (ok) {
      try {
        await ctx.api('DELETE', `/licenses/${encodeURIComponent(l.id)}/devices/${encodeURIComponent(d.id)}`);
        toast('Device removed');
        refresh();
        ctx.refreshStats();
      } catch (err) {
        showError(err);
      }
    }
    return openLicense(l.id);
  }

  async function resetDevices(l, count) {
    const ok = await confirmAction({
      title: 'Reset all devices?',
      message: `All ${count} active device(s) for "${l.label}" will be signed out and must activate again.`,
      confirmLabel: 'Reset devices',
    });
    if (ok) {
      try {
        const data = await ctx.api('POST', `/licenses/${encodeURIComponent(l.id)}/devices/reset`, {});
        toast(`${data.removed} device(s) removed`);
        refresh();
        ctx.refreshStats();
      } catch (err) {
        showError(err);
      }
    }
    return openLicense(l.id);
  }

  window.NX.licenses = { init, refresh, onAppsChanged, open: openLicense };
})();