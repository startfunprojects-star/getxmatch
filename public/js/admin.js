/* getxmatch admin dashboard — a tiny self-contained SPA served at /admin. */
(function () {
  'use strict';

  const root = document.getElementById('admin');
  let pollTimer = null;

  /* ---- helpers ---- */
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  async function req(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  const api = {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    del: (u) => req('DELETE', u),
  };
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString(); } catch (_e) { return ''; }
  }

  /* ---- boot: decide which screen ---- */
  async function boot() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    if (path.indexOf('/admin/reset') === 0) {
      return renderReset(params.get('token') || '');
    }
    let me;
    try { me = await api.get('/api/admin/me'); } catch (_e) { me = { authenticated: false, hasPassword: false }; }
    if (me.authenticated) return renderDashboard();
    return renderLogin(me.hasPassword);
  }

  /* ---- login ---- */
  function renderLogin(hasPassword) {
    stopPolling();
    root.innerHTML = '';
    const card = el(`
      <div class="auth-wrap"><div class="auth-card">
        <h1 class="brand">get<span class="x">x</span>match <span style="font-size:14px;color:var(--muted)">admin</span></h1>
        <p class="auth-sub">${hasPassword ? 'Sign in to the admin dashboard.' : 'No admin password is set yet. Send yourself a link to create one.'}</p>
        ${hasPassword ? `
          <form id="loginForm">
            <label>Admin password</label>
            <input name="password" type="password" autocomplete="current-password" required />
            <div class="msg" id="m"></div>
            <button class="primary" type="submit" style="width:100%;margin-top:18px">Log in</button>
          </form>
          <div class="auth-toggle"><a href="#" id="forgot">Set / reset password by email</a></div>
        ` : `
          <div class="msg" id="m"></div>
          <button class="primary" id="sendLink" style="width:100%">Email me a set-password link</button>
        `}
      </div></div>
    `);
    root.appendChild(card);
    const m = card.querySelector('#m');

    const form = card.querySelector('#loginForm');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        m.className = 'msg';
        try {
          await api.post('/api/admin/login', { password: new FormData(form).get('password') });
          renderDashboard();
        } catch (err) { m.textContent = err.message; m.className = 'msg error'; }
      });
      card.querySelector('#forgot').addEventListener('click', (e) => { e.preventDefault(); requestReset(m); });
    }
    const sendBtn = card.querySelector('#sendLink');
    if (sendBtn) sendBtn.addEventListener('click', () => requestReset(m, sendBtn));
  }

  async function requestReset(m, btn) {
    m.className = 'msg';
    if (btn) btn.disabled = true;
    try {
      await api.post('/api/admin/request-reset', {});
      m.textContent = 'A one-time link has been sent — you know where. 🙂';
      m.className = 'msg ok';
    } catch (err) { m.textContent = err.message; m.className = 'msg error'; }
    finally { if (btn) btn.disabled = false; }
  }

  /* ---- set/reset password (from emailed link) ---- */
  async function renderReset(token) {
    stopPolling();
    root.innerHTML = '';
    let valid = false;
    try { valid = (await api.get('/api/admin/reset/valid?token=' + encodeURIComponent(token))).valid; } catch (_e) {}

    const card = el(`
      <div class="auth-wrap"><div class="auth-card">
        <h1 class="brand">get<span class="x">x</span>match <span style="font-size:14px;color:var(--muted)">admin</span></h1>
        ${valid ? `
          <p class="auth-sub">Set a new admin password.</p>
          <form id="resetForm">
            <label>New password</label>
            <input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required />
            <label>Confirm password</label>
            <input name="confirm" type="password" autocomplete="new-password" required />
            <div class="msg" id="m"></div>
            <button class="primary" type="submit" style="width:100%;margin-top:18px">Set password</button>
          </form>
        ` : `
          <p class="auth-sub">This link is invalid or has expired.</p>
          <div class="msg error" style="display:block">Request a fresh link from the admin login page.</div>
          <div class="auth-toggle"><a href="/admin">Go to admin login</a></div>
        `}
      </div></div>
    `);
    root.appendChild(card);
    const form = card.querySelector('#resetForm');
    if (!form) return;
    const m = card.querySelector('#m');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      m.className = 'msg';
      const fd = new FormData(form);
      if (fd.get('password') !== fd.get('confirm')) {
        m.textContent = 'Passwords do not match.'; m.className = 'msg error'; return;
      }
      try {
        await api.post('/api/admin/reset', { token, password: fd.get('password') });
        m.textContent = 'Password set. Redirecting to login…'; m.className = 'msg ok';
        setTimeout(() => { location.href = '/admin'; }, 1200);
      } catch (err) { m.textContent = err.message; m.className = 'msg error'; }
    });
  }

  /* ---- dashboard ---- */
  async function renderDashboard() {
    root.innerHTML = '';
    const wrap = el(`
      <div class="admin-wrap">
        <div class="admin-top">
          <h1>Users <span class="count" id="userCount"></span></h1>
          <div class="admin-actions">
            <button class="ghost small" id="refresh">Refresh</button>
            <button class="ghost small" id="logout">Log out</button>
          </div>
        </div>

        <div class="admin-card">
          <h2>Create user (no email)</h2>
          <form id="createForm" class="form-grid">
            <div><label>Username</label><input name="username" placeholder="3-20 letters/numbers/_" required /></div>
            <div><label>Display name (optional)</label><input name="displayName" placeholder="Shown to others" /></div>
            <div><label>Password</label><input name="password" type="password" placeholder="At least 8 characters" required /></div>
            <div><button class="primary" type="submit">Create user</button></div>
          </form>
          <div class="msg" id="createMsg"></div>
        </div>

        <div class="admin-card">
          <div class="table-scroll">
            <table class="users">
              <thead>
                <tr><th>Status</th><th>User</th><th>Email</th><th>Profile</th><th>Joined</th><th></th></tr>
              </thead>
              <tbody id="userRows"><tr><td colspan="6" class="count">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    `);
    root.appendChild(wrap);

    wrap.querySelector('#logout').addEventListener('click', async () => {
      await api.post('/api/admin/logout', {});
      renderLogin(true);
    });
    wrap.querySelector('#refresh').addEventListener('click', loadUsers);

    const createForm = wrap.querySelector('#createForm');
    const createMsg = wrap.querySelector('#createMsg');
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      createMsg.className = 'msg';
      const fd = new FormData(createForm);
      try {
        await api.post('/api/admin/users', {
          username: fd.get('username'),
          displayName: fd.get('displayName'),
          password: fd.get('password'),
        });
        createMsg.textContent = `User "${fd.get('username')}" created.`;
        createMsg.className = 'msg ok';
        createForm.reset();
        loadUsers();
      } catch (err) { createMsg.textContent = err.message; createMsg.className = 'msg error'; }
    });

    await loadUsers();
    stopPolling();
    // Live-ish green dots: refresh the list periodically.
    pollTimer = setInterval(loadUsers, 5000);
  }

  async function loadUsers() {
    const rowsEl = document.getElementById('userRows');
    if (!rowsEl) return; // navigated away
    let data;
    try { data = await api.get('/api/admin/users'); }
    catch (err) {
      if (err.status === 401) { stopPolling(); return renderLogin(true); }
      rowsEl.innerHTML = `<tr><td colspan="6" class="count">${esc(err.message)}</td></tr>`;
      return;
    }
    const users = data.users || [];
    const online = users.filter((u) => u.online).length;
    const countEl = document.getElementById('userCount');
    if (countEl) countEl.textContent = `· ${users.length} total, ${online} online`;

    if (!users.length) {
      rowsEl.innerHTML = `<tr><td colspan="6" class="count">No users yet.</td></tr>`;
      return;
    }
    rowsEl.innerHTML = '';
    users.forEach((u) => {
      const tr = el(`
        <tr>
          <td><span class="dot ${u.online ? 'online' : ''}"></span>${u.online ? 'Online' : 'Offline'}</td>
          <td><strong>${esc(u.displayName || u.username)}</strong><div class="pill">@${esc(u.username)}</div></td>
          <td>${u.email ? esc(u.email) : '<span class="pill">— no email —</span>'}</td>
          <td>${u.hasProfile ? 'Yes' : '<span class="pill">No</span>'}</td>
          <td class="pill">${esc(fmtDate(u.createdAt))}</td>
          <td><button class="danger small" data-del="${u.id}">Delete</button></td>
        </tr>
      `);
      tr.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm(`Delete user @${u.username}? This removes their profile, photos and messages.`)) return;
        try { await api.del('/api/admin/users/' + u.id); loadUsers(); }
        catch (err) { alert(err.message); }
      });
      rowsEl.appendChild(tr);
    });
  }

  boot();
})();
