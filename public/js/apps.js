/* Nexus dashboard: client application management. */
(() => {
  'use strict';

  const NX = window.NX;
  const { $, h, clear, toast, showError, openModal, confirmAction, withBusy, copyText, fmtDateTime, badge, setTableMessage, field } = NX.ui;

  let ctx = null;
  const num = (sel) => Number($(sel).value);

  function init(context) {
    ctx = context;
    $('#appForm').addEventListener('submit', onCreate);
    $('#appSearch').addEventListener('input', () => render());
  }

  async function onCreate(e) {
    e.preventDefault();
    const body = {
      name: $('#appName').value.trim(),
      defaultDurationDays: num('#appDefDays'),
      defaultMaxDevices: num('#appDefDevices'),
      maxDevicesCap: num('#appCap'),
      maxDurationDays: num('#appMaxDays'),
      allowLifetime: $('#appLifetime').checked,
    };
    const desc = $('#appDesc').value.trim();
    if (desc) body.description = desc;

    await withBusy($('#appSubmit'), 'Creating…', async () => {
      try {
        const data = await ctx.api('POST', '/apps', body);
        toast(`Application "${data.app.name}" created`);
        $('#appForm').reset();
        await ctx.loadApps();
        ctx.refreshStats();
      } catch (err) {
        showError(err);
      }
    });
  }

  function render() {
    if (!ctx) return;
    const tbody = $('#appTableBody');
    const term = $('#appSearch').value.trim().toLowerCase();
    const items = ctx.state.apps.filter((a) => !term || a.name.toLowerCase().includes(term) || a.clientId.includes(term));
    if (!items.length) {
      setTableMessage(tbody, 6, term ? 'No applications match your search.' : 'No applications yet.');
      return;
    }
    clear(tbody);
    for (const a of items) {
      tbody.append(h('tr', { class: 'hover:bg-slate-900/40 transition-all align-top' },
        h('td', { class: 'p-4' },
          h('div', { class: 'font-semibold text-white' }, a.name),
          a.description ? h('div', { class: 'text-xs text-slate-500 mt-1' }, a.description) : null),
        h('td', { class: 'p-4' },
          h('div', { class: 'flex items-center gap-2' },
            h('span', { class: 'font-mono text-xs text-indigo-400 break-all' }, a.clientId),
            h('button', { type: 'button', class: 'nx-btn-ghost', onclick: () => copyText(a.clientId, 'Client ID copied') }, 'Copy'))),
        h('td', { class: 'p-4 text-xs font-mono text-slate-400 whitespace-nowrap' },
          h('div', {}, `default ${a.defaultDurationDays}d · ${a.defaultMaxDevices} dev`),
          h('div', {}, `max ${a.maxDurationDays}d · cap ${a.maxDevicesCap} dev`),
          a.allowLifetime ? h('div', { class: 'text-emerald-400' }, 'lifetime allowed') : null),
        h('td', { class: 'p-4 text-xs font-mono' }, a.hasSecret
          ? h('span', { class: 'text-emerald-400' }, 'Required')
          : h('span', { class: 'text-slate-500' }, 'None')),
        h('td', { class: 'p-4' }, badge(a.status)),
        h('td', { class: 'p-4 text-right' },
          h('div', { class: 'flex flex-wrap justify-end gap-2' },
            h('button', { type: 'button', class: 'nx-btn-ghost', onclick: () => viewLicenses(a) }, 'Licenses'),
            h('button', { type: 'button', class: 'nx-btn-ghost', onclick: () => editApp(a) }, 'Edit'),
            h('button', { type: 'button', class: 'nx-btn-ghost', onclick: () => manageSecret(a) }, 'Secret'),
            a.status === 'active'
              ? h('button', { type: 'button', class: 'nx-btn-danger', onclick: () => toggleApp(a) }, 'Disable')
              : h('button', { type: 'button', class: 'nx-btn-success', onclick: () => toggleApp(a) }, 'Enable')))));
    }
  }

  function viewLicenses(a) {
    ctx.state.lic.appId = a.id;
    ctx.state.lic.page = 1;
    $('#licAppFilter').value = a.id;
    ctx.switchTab('licenses');
    NX.licenses.refresh();
  }

  function editApp(a) {
    const inputs = {
      name: h('input', { class: 'nx-input', maxlength: '80', value: a.name }),
      description: h('input', { class: 'nx-input', maxlength: '500', value: a.description || '' }),
      defaultDurationDays: h('input', { class: 'nx-input', type: 'number', min: '1', max: '3650', value: String(a.defaultDurationDays) }),
      defaultMaxDevices: h('input', { class: 'nx-input', type: 'number', min: '1', max: '100', value: String(a.defaultMaxDevices) }),
      maxDevicesCap: h('input', { class: 'nx-input', type: 'number', min: '1', max: '100', value: String(a.maxDevicesCap) }),
      maxDurationDays: h('input', { class: 'nx-input', type: 'number', min: '1', max: '36500', value: String(a.maxDurationDays) }),
    };
    const lifetime = h('input', { type: 'checkbox', class: 'accent-indigo-500', checked: a.allowLifetime });

    const save = h('button', { type: 'button', class: 'nx-btn' }, 'Save changes');
    save.addEventListener('click', () => withBusy(save, 'Saving…', async () => {
      const body = {};
      if (inputs.name.value.trim() !== a.name) body.name = inputs.name.value.trim();
      if (inputs.description.value.trim() !== (a.description || '')) body.description = inputs.description.value.trim() || null;
      for (const key of ['defaultDurationDays', 'defaultMaxDevices', 'maxDevicesCap', 'maxDurationDays']) {
        const v = Number(inputs[key].value);
        if (v !== a[key]) body[key] = v;
      }
      if (lifetime.checked !== a.allowLifetime) body.allowLifetime = lifetime.checked;
      if (!Object.keys(body).length) return close();
      try {
        await ctx.api('PATCH', `/apps/${encodeURIComponent(a.id)}`, body);
        toast('Application updated');
        close();
        return ctx.loadApps();
      } catch (err) {
        return showError(err);
      }
    }));

    const close = openModal({
      title: `Edit application`,
      body: h('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-4' },
        field('Name', inputs.name),
        field('Description', inputs.description),
        field('Default duration (days)', inputs.defaultDurationDays),
        field('Default max devices', inputs.defaultMaxDevices),
        field('Device cap per license', inputs.maxDevicesCap),
        field('Max duration (days)', inputs.maxDurationDays),
        h('label', { class: 'flex items-center gap-2 text-xs text-slate-300' }, lifetime, 'Allow lifetime licenses')),
      actions: [h('button', { type: 'button', class: 'nx-btn-ghost px-4 py-2', onclick: () => close() }, 'Cancel'), save],
    });
  }

  async function toggleApp(a) {
    const disabling = a.status === 'active';
    const ok = await confirmAction({
      title: disabling ? 'Disable application?' : 'Enable application?',
      message: disabling
        ? `All licenses of "${a.name}" will stop activating and verifying until you enable it again.`
        : `Licenses of "${a.name}" will work again.`,
      confirmLabel: disabling ? 'Disable' : 'Enable',
      danger: disabling,
    });
    if (!ok) return;
    try {
      await ctx.api('POST', `/apps/${encodeURIComponent(a.id)}/${disabling ? 'disable' : 'enable'}`, {});
      toast(disabling ? 'Application disabled' : 'Application enabled');
      await ctx.loadApps();
    } catch (err) {
      showError(err);
    }
  }

  function manageSecret(a) {
    const gen = h('button', { type: 'button', class: 'nx-btn' }, a.hasSecret ? 'Rotate secret' : 'Generate secret');
    const remove = a.hasSecret ? h('button', { type: 'button', class: 'nx-btn-danger px-4 py-2' }, 'Remove secret') : null;

    gen.addEventListener('click', async () => {
      if (a.hasSecret) {
        const ok = await confirmAction({
          title: 'Rotate app secret?',
          message: 'The current secret stops working immediately. Update your website backend right after.',
          confirmLabel: 'Rotate now',
        });
        if (!ok) return;
      }
      try {
        const data = await ctx.api('POST', `/apps/${encodeURIComponent(a.id)}/secret`, {});
        await ctx.loadApps();
        showSecretOnce(data.appSecret, data.app);
      } catch (err) {
        showError(err);
      }
    });

    if (remove) {
      remove.addEventListener('click', async () => {
        const ok = await confirmAction({
          title: 'Remove app secret?',
          message: 'Anyone with a valid license key will be able to call this application\u2019s API directly.',
          confirmLabel: 'Remove secret',
        });
        if (!ok) return;
        try {
          await ctx.api('DELETE', `/apps/${encodeURIComponent(a.id)}/secret`);
          toast('App secret removed');
          await ctx.loadApps();
        } catch (err) {
          showError(err);
        }
      });
    }

    openModal({
      title: `App secret · ${a.name}`,
      body: h('div', { class: 'space-y-3 text-sm text-slate-300' },
        h('p', {}, 'An app secret makes sure only your own website backend can call the license API for this application.'),
        h('p', { class: 'text-xs text-slate-400' }, 'When set, every activate / verify / deactivate request must send the header X-Nexus-App-Secret. Never put it in browser JavaScript.'),
        h('p', { class: 'text-xs' }, 'Status: ', a.hasSecret
          ? h('span', { class: 'text-emerald-400 font-mono' }, `required (last rotated ${fmtDateTime(a.secretRotatedAt)})`)
          : h('span', { class: 'text-slate-500 font-mono' }, 'not set'))),
      actions: [remove, gen],
    });
  }

  function showSecretOnce(secret, app) {
    const done = h('button', { type: 'button', class: 'nx-btn', onclick: () => close() }, 'Done');
    const close = openModal({
      title: 'App secret generated',
      dismissible: false,
      body: h('div', { class: 'space-y-4' },
        h('p', { class: 'text-sm text-slate-300' }, `Application: ${app.name}`),
        h('div', { class: 'font-mono text-indigo-300 text-sm break-all bg-slate-950 border border-indigo-500/30 rounded-xl p-4 select-all' }, secret),
        h('div', { class: 'rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300' },
          '⚠ Shown only once. Store it as an environment variable on your website\u2019s server (never in frontend code or Git).')),
      actions: [h('button', { type: 'button', class: 'nx-btn-ghost px-4 py-2', onclick: () => copyText(secret, 'Secret copied') }, 'Copy secret'), done],
    });
  }

  window.NX.apps = { init, render };
})();