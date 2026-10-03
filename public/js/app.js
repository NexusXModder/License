(() => {
  'use strict';

  const NX = window.NX;
  if (!NX || !NX.ui) {
    document.addEventListener('DOMContentLoaded', () => {
      const msg = document.getElementById('authMessage');
      if (msg) {
        msg.textContent = 'Dashboard UI script did not load. Check public/js/ui.js.';
        msg.classList.remove('hidden');
      }
    });
    return;
  }

  const {
    $, $$, h, clear, UiError, toast, showError, withBusy,
    setTableMessage, renderPager, qs, fmtDateTime,
  } = NX.ui;

  const state = {
    admin: null,
    apps: [],
    view: 'licenses',
    lic: { page: 1, pageSize: 20, total: 0, search: '', status: '', appId: '' },
    audit: { page: 1, pageSize: 25, total: 0, type: '' },
  };

  let sb = null;

  function showAuth(mode = 'login', message = '', isError = true) {
    const subtitles = {
      login: 'Secure Authorization Required',
      forgot: 'Password Recovery',
      newPassword: 'Set a New Password',
    };

    $('#dashboardView').classList.add('hidden');
    $('#authView').classList.remove('hidden');
    $('#loginForm').classList.toggle('hidden', mode !== 'login');
    $('#forgotForm').classList.toggle('hidden', mode !== 'forgot');
    $('#newPasswordForm').classList.toggle('hidden', mode !== 'newPassword');
    $('#authSubtitle').textContent = subtitles[mode] || subtitles.login;

    const msg = $('#authMessage');
    msg.textContent = message;
    msg.className =
      `text-xs text-center mt-4 font-medium ${message ? '' : 'hidden'} ` +
      (isError ? 'text-rose-400' : 'text-emerald-400');
  }

  async function signOutAndShow(message) {
    state.admin = null;
    showAuth('login', message);
    if (sb) {
      try {
        await sb.auth.signOut({ scope: 'local' });
      } catch {
        // Local sign-out is best effort.
      }
    }
    throw new UiError(message, 'signed_out', 401);
  }

  async function api(method, route, body, retried = false) {
    const { data: sessionData, error: sessionError } = await sb.auth.getSession();
    const session = sessionData && sessionData.session;

    if (sessionError || !session) {
      return signOutAndShow('Session expired. Please sign in again.');
    }

    const headers = { Authorization: `Bearer ${session.access_token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(`/api/v1/admin${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new UiError('Network error. Check your connection.', 'network', 0);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new UiError('Server returned an unreadable response.', 'bad_response', response.status);
    }

    const error = payload && payload.error ? payload.error : {};

    if (response.status === 401) {
      if (!retried) {
        const { data: refreshed, error: refreshError } = await sb.auth.refreshSession();
        if (!refreshError && refreshed && refreshed.session) {
          return api(method, route, body, true);
        }
      }
      return signOutAndShow(error.message || 'Session expired. Please sign in again.');
    }

    if (response.status === 403 && error.code === 'forbidden') {
      return signOutAndShow(
        'Supabase sign-in succeeded, but this account is not in the admin allowlist.'
      );
    }

    if (!response.ok || !payload.ok) {
      const details = Array.isArray(error.details)
        ? `: ${error.details.map((item) => `${item.field} ${item.message}`).join('; ')}`
        : '';
      throw new UiError(
        `${error.message || `Request failed (${response.status})`}${details}`,
        error.code,
        response.status
      );
    }

    return payload.data;
  }

  async function enterDashboard(eventName) {
    try {
      state.admin = await api('POST', '/session', { event: eventName });
    } catch (err) {
      if (err.code !== 'signed_out') showAuth('login', err.message || 'Could not start admin session.');
      return;
    }

    $('#authView').classList.add('hidden');
    $('#dashboardView').classList.remove('hidden');
    $('#adminEmail').textContent = state.admin.email || 'Administrator';
    $('#adminRole').textContent = state.admin.role || 'admin';

    switchTab('licenses');

    try {
      await loadApps();
    } catch (err) {
      showError(err);
    }

    await refreshStats();
    await NX.licenses.refresh();
  }

  function wireAuth() {
    $('#loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();

      const email = $('#loginEmail').value.trim();
      const passwordInput = $('#loginPassword');

      await withBusy($('#loginSubmit'), 'Authenticating…', async () => {
        try {
          const { error } = await sb.auth.signInWithPassword({
            email,
            password: passwordInput.value,
          });

          // Clear the password after every attempt; never retain it in browser storage.
          passwordInput.value = '';

          if (error) {
            const status = error.status ? `HTTP ${error.status}` : 'Supabase Auth';
            const code = error.code ? ` · ${error.code}` : '';
            const message = String(error.message || 'Sign-in failed').slice(0, 180);
            showAuth('login', `${status}${code}: ${message}`);
            return;
          }

          await enterDashboard('login');
        } catch (err) {
          passwordInput.value = '';
          showAuth('login', `Login error: ${String(err.message || err).slice(0, 180)}`);
        }
      });
    });

    $('#showForgot').addEventListener('click', () => {
      $('#forgotEmail').value = $('#loginEmail').value.trim();
      showAuth('forgot');
    });

    $('#backToLogin').addEventListener('click', () => showAuth('login'));

    $('#forgotForm').addEventListener('submit', async (event) => {
      event.preventDefault();

      await withBusy($('#forgotSubmit'), 'Sending…', async () => {
        try {
          const email = $('#forgotEmail').value.trim();
          const { error } = await sb.auth.resetPasswordForEmail(email, {
            redirectTo: `${location.origin}/`,
          });

          if (error) {
            showAuth('forgot', String(error.message || 'Could not send reset link.').slice(0, 180));
            return;
          }

          showAuth(
            'login',
            'If this email belongs to an account, a reset link has been sent.',
            false
          );
        } catch (err) {
          showAuth('forgot', String(err.message || err).slice(0, 180));
        }
      });
    });

    $('#newPasswordForm').addEventListener('submit', async (event) => {
      event.preventDefault();

      const first = $('#newPassword');
      const second = $('#newPassword2');

      if (first.value.length < 10) {
        showAuth('newPassword', 'Password must be at least 10 characters.');
        return;
      }
      if (first.value !== second.value) {
        showAuth('newPassword', 'Passwords do not match.');
        return;
      }

      await withBusy($('#newPasswordSubmit'), 'Updating…', async () => {
        try {
          const { error } = await sb.auth.updateUser({ password: first.value });
          first.value = '';
          second.value = '';

          if (error) {
            showAuth('newPassword', String(error.message || 'Could not update password.').slice(0, 180));
            return;
          }

          history.replaceState(null, '', location.pathname);
          toast('Password updated');
          await enterDashboard('login');
        } catch (err) {
          first.value = '';
          second.value = '';
          showAuth('newPassword', String(err.message || err).slice(0, 180));
        }
      });
    });
  }

  async function loadApps() {
    const result = await api('GET', '/apps');
    state.apps = result.items || [];
    NX.licenses.onAppsChanged();
    NX.apps.render();
  }

  async function refreshStats() {
    try {
      const stats = await api('GET', '/stats');
      for (const [key, value] of Object.entries(stats)) {
        const element = document.querySelector(`[data-stat="${key}"]`);
        if (element) element.textContent = String(value);
      }
    } catch (err) {
      showError(err);
    }
  }

  function switchTab(view) {
    state.view = view;

    for (const button of $$('[data-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === view));
    }
    for (const panel of $$('[data-panel]')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== view);
    }

    if (view === 'apps') NX.apps.render();
    if (view === 'audit') refreshAudit();
    if (view === 'system') NX.maintenance.refresh();
  }

  function shortId(value) {
    return String(value).slice(0, 8);
  }

  function metaText(metadata) {
    return Object.entries(metadata || {})
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('  ') || '—';
  }

  async function refreshAudit() {
    const auditState = state.audit;
    const tbody = $('#auditTableBody');
    setTableMessage(tbody, 5, 'Loading events…');

    try {
      const result = await api(
        'GET',
        `/audit-events${qs({
          page: auditState.page,
          pageSize: auditState.pageSize,
          type: auditState.type,
        })}`
      );

      auditState.total = result.total;
      clear(tbody);

      if (!result.items.length) {
        setTableMessage(tbody, 5, 'No events found.');
      }

      for (const item of result.items) {
        const actor =
          item.actorId && state.admin && item.actorId === state.admin.userId
            ? 'you'
            : item.actorType;

        tbody.append(
          h('tr', { class: 'hover:bg-slate-900/40 align-top' },
            h('td', { class: 'p-3 font-mono text-xs text-slate-400 whitespace-nowrap' },
              fmtDateTime(item.createdAt)),
            h('td', { class: 'p-3 font-mono text-xs text-indigo-300 whitespace-nowrap' },
              item.type),
            h('td', { class: 'p-3 text-xs text-slate-300' },
              actor,
              item.actorId
                ? h('div', { class: 'font-mono text-[10px] text-slate-500' }, shortId(item.actorId))
                : null),
            h('td', { class: 'p-3 text-xs text-slate-300' },
              item.targetType || '—',
              item.targetId
                ? h('div', { class: 'font-mono text-[10px] text-slate-500' }, shortId(item.targetId))
                : null),
            h('td', { class: 'p-3 font-mono text-[11px] text-slate-400 break-all' },
              metaText(item.metadata))
          )
        );
      }

      renderPager($('#auditPager'), auditState, refreshAudit);
    } catch (err) {
      setTableMessage(tbody, 5, 'Failed to load the audit log.');
      showError(err);
    }
  }

  function wireDashboard() {
    for (const button of $$('[data-tab]')) {
      button.addEventListener('click', () => switchTab(button.dataset.tab));
    }

    $('#auditType').addEventListener('change', (event) => {
      state.audit.type = event.target.value;
      state.audit.page = 1;
      refreshAudit();
    });

    $('#auditRefresh').addEventListener('click', refreshAudit);

    $('#logoutBtn').addEventListener('click', async () => {
      try {
        await api('POST', '/session', { event: 'logout' });
      } catch {
        // Continue with local sign-out.
      }

      state.admin = null;
      showAuth('login', 'Session terminated.', false);

      try {
        await sb.auth.signOut({ scope: 'local' });
      } catch {
        // Local sign-out is best effort.
      }
    });
  }

  function recoveryError() {
    if (!location.hash.includes('error')) return '';
    const params = new URLSearchParams(location.hash.slice(1));
    return (params.get('error_description') || 'The recovery link is invalid or expired.')
      .replace(/\+/g, ' ')
      .slice(0, 180);
  }

  async function init() {
    wireAuth();
    wireDashboard();

    if (!NX.licenses || !NX.apps || !NX.maintenance) {
      showAuth('login', 'A dashboard script is missing. Check the JavaScript files.');
      return;
    }

    let response;
    try {
      response = await fetch('/api/v1/public-config', { cache: 'no-store' });
    } catch {
      showAuth('login', 'Cannot reach the license server. Check your connection.');
      return;
    }

    if (!response.ok) {
      showAuth('login', `Could not load public configuration (HTTP ${response.status}).`);
      return;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      showAuth('login', 'The server returned invalid public configuration.');
      return;
    }

    const config = payload && payload.data;
    if (!config || !config.supabaseUrl || !config.supabasePublishableKey) {
      showAuth('login', 'Supabase public configuration is missing.');
      return;
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showAuth('login', 'Supabase browser library failed to load.');
      return;
    }

    sb = window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }
    );

    sb.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setTimeout(() => showAuth('newPassword'), 0);
      }

      if (event === 'SIGNED_OUT' && !$('#dashboardView').classList.contains('hidden')) {
        setTimeout(() => {
          state.admin = null;
          showAuth('login', 'You have been signed out.');
        }, 0);
      }
    });

    NX.licenses.init({ state, api, loadApps, refreshStats, switchTab });
    NX.apps.init({ state, api, loadApps, refreshStats, switchTab });
    NX.maintenance.init({ api });

    const hashError = recoveryError();
    if (hashError) {
      history.replaceState(null, '', location.pathname);
      showAuth('login', hashError);
      return;
    }

    if (/type=recovery/.test(location.hash)) {
      showAuth('newPassword');
      return;
    }

    const { data, error } = await sb.auth.getSession();
    if (error) {
      showAuth('login', `Session error: ${String(error.message || error).slice(0, 180)}`);
      return;
    }

    if (data && data.session) {
      await enterDashboard('restore');
    } else {
      showAuth('login');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
      showAuth('login', `Dashboard error: ${String(err.message || err).slice(0, 180)}`);
    });
  });
})();