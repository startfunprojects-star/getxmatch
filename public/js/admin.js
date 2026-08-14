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
  async function req(method, url, body, isForm) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body != null) {
      if (isForm) { opts.body = body; }
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_e) {}
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  const api = {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b),
    put: (u, b) => req('PUT', u, b),
    del: (u) => req('DELETE', u),
    postForm: (u, fd) => req('POST', u, fd, true),
    putForm: (u, fd) => req('PUT', u, fd, true),
  };
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function fmtDate(ms) {
    try { return new Date(ms).toLocaleString(); } catch (_e) { return ''; }
  }

  /* ==================================================================
     Reusable On-page SEO fieldset (shared by quizzes, polls, blogs)
  ================================================================== */
  const SEO_TEXT_KEYS = [
    'metaTitle', 'metaDescription', 'slug', 'focusKeyword', 'metaKeywords',
    'canonicalUrl', 'ogTitle', 'ogDescription', 'ogImage', 'ogType',
    'twitterCard', 'twitterTitle', 'twitterDescription', 'twitterImage',
  ];
  const seoId = (k) => 'seo_' + k;

  // Build the collapsible SEO panel. `seo` is the saved object (or empty).
  function seoFieldsHtml(seo) {
    seo = seo || {};
    const v = (k) => esc(seo[k] || '');
    const twCard = seo.twitterCard || 'summary_large_image';
    return `
      <details class="seo-block">
        <summary>On-page SEO <span class="count">— search snippet, social cards & indexing</span></summary>

        <label>Meta title <span class="seo-count" data-for="${seoId('metaTitle')}"></span></label>
        <input id="${seoId('metaTitle')}" maxlength="70" value="${v('metaTitle')}" placeholder="≤ 60 chars — shown as the clickable title in Google" />

        <label>Meta description <span class="seo-count" data-for="${seoId('metaDescription')}"></span></label>
        <textarea id="${seoId('metaDescription')}" maxlength="320" placeholder="≤ 160 chars — the grey summary under the title in search results">${v('metaDescription')}</textarea>

        <div class="seo-grid">
          <div>
            <label>URL slug</label>
            <div class="seo-row">
              <input id="${seoId('slug')}" value="${v('slug')}" placeholder="my-page-title" />
              <button type="button" class="ghost small" data-seo-slug>From title</button>
            </div>
          </div>
          <div>
            <label>Focus keyword</label>
            <input id="${seoId('focusKeyword')}" value="${v('focusKeyword')}" placeholder="primary keyword" />
          </div>
        </div>

        <label>Meta keywords (comma-separated)</label>
        <input id="${seoId('metaKeywords')}" value="${v('metaKeywords')}" placeholder="dating, compatibility, quiz" />

        <label>Canonical URL</label>
        <input id="${seoId('canonicalUrl')}" value="${v('canonicalUrl')}" placeholder="https://getxmatch.com/…" />

        <div class="seo-row seo-robots">
          <label class="seo-check"><input type="checkbox" id="${seoId('noindex')}"${seo.noindex ? ' checked' : ''}/> noindex (hide from search engines)</label>
          <label class="seo-check"><input type="checkbox" id="${seoId('nofollow')}"${seo.nofollow ? ' checked' : ''}/> nofollow (don't pass link equity)</label>
        </div>

        <h4 class="seo-h">Open Graph — Facebook, WhatsApp, LinkedIn</h4>
        <label>OG title</label>
        <input id="${seoId('ogTitle')}" value="${v('ogTitle')}" placeholder="Defaults to meta title" />
        <label>OG description</label>
        <textarea id="${seoId('ogDescription')}" placeholder="Defaults to meta description">${v('ogDescription')}</textarea>
        <div class="seo-grid">
          <div>
            <label>OG image URL</label>
            <input id="${seoId('ogImage')}" value="${v('ogImage')}" placeholder="https://…/share.jpg (1200×630)" />
          </div>
          <div>
            <label>OG type</label>
            <input id="${seoId('ogType')}" value="${v('ogType') || 'article'}" placeholder="article / website" />
          </div>
        </div>

        <h4 class="seo-h">Twitter / X Card</h4>
        <div class="seo-grid">
          <div>
            <label>Card type</label>
            <select id="${seoId('twitterCard')}">
              <option value="summary_large_image"${twCard === 'summary_large_image' ? ' selected' : ''}>summary_large_image</option>
              <option value="summary"${twCard === 'summary' ? ' selected' : ''}>summary</option>
            </select>
          </div>
          <div>
            <label>Twitter image URL</label>
            <input id="${seoId('twitterImage')}" value="${v('twitterImage')}" placeholder="Defaults to OG image" />
          </div>
        </div>
        <label>Twitter title</label>
        <input id="${seoId('twitterTitle')}" value="${v('twitterTitle')}" placeholder="Defaults to meta title" />
        <label>Twitter description</label>
        <textarea id="${seoId('twitterDescription')}" placeholder="Defaults to meta description">${v('twitterDescription')}</textarea>
      </details>
    `;
  }

  // Read the SEO panel back into a plain object for the API payload.
  function collectSeo(host) {
    const o = {};
    SEO_TEXT_KEYS.forEach((k) => {
      const node = host.querySelector('#' + seoId(k));
      o[k] = node ? node.value.trim() : '';
    });
    const ni = host.querySelector('#' + seoId('noindex'));
    const nf = host.querySelector('#' + seoId('nofollow'));
    o.noindex = !!(ni && ni.checked);
    o.nofollow = !!(nf && nf.checked);
    return o;
  }

  // Wire live character counters + the "slug from title" button. `getTitle`
  // returns the current title/question text for slug generation.
  function wireSeo(host, getTitle) {
    const slugify = (s) => String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const slugBtn = host.querySelector('[data-seo-slug]');
    if (slugBtn) slugBtn.addEventListener('click', () => {
      const slugEl = host.querySelector('#' + seoId('slug'));
      if (slugEl) slugEl.value = slugify(getTitle ? getTitle() : '');
    });
    host.querySelectorAll('.seo-count').forEach((span) => {
      const input = host.querySelector('#' + span.dataset.for);
      if (!input) return;
      const rec = input.id === seoId('metaTitle') ? 60 : 160;
      const update = () => {
        const n = input.value.length;
        span.textContent = `${n} chars` + (n > rec ? ` (over ${rec})` : '');
        span.classList.toggle('over', n > rec);
      };
      input.addEventListener('input', update);
      update();
    });
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

  /* ---- dashboard (tabbed) ---- */
  const TABS = [
    ['users', 'Users'],
    ['quizzes', 'Quizzes'],
    ['polls', 'Polls'],
    ['blogs', 'Blogs'],
    ['roleplays', 'Roleplays'],
    ['events', 'Recent Events'],
    ['fake', 'Fake Activity'],
    ['leaderboard', 'Leaderboard'],
  ];

  async function renderDashboard() {
    stopPolling();
    root.innerHTML = '';
    const wrap = el(`
      <div class="admin-wrap">
        <div class="admin-top">
          <h1 class="brand">get<span class="x">x</span>match <span style="font-size:14px;color:var(--muted)">admin</span></h1>
          <div class="admin-actions">
            <button class="ghost small" id="logout">Log out</button>
          </div>
        </div>
        <div class="admin-tabs" id="adminTabs">
          ${TABS.map(([id, label], i) => `<button data-tab="${id}"${i === 0 ? ' class="active"' : ''}>${esc(label)}</button>`).join('')}
        </div>
        <div id="tabContent"></div>
      </div>
    `);
    root.appendChild(wrap);

    wrap.querySelector('#logout').addEventListener('click', async () => {
      stopPolling();
      await api.post('/api/admin/logout', {});
      renderLogin(true);
    });

    wrap.querySelectorAll('#adminTabs button').forEach((b) => {
      b.addEventListener('click', () => {
        wrap.querySelectorAll('#adminTabs button').forEach((x) => x.classList.toggle('active', x === b));
        selectTab(b.dataset.tab);
      });
    });

    selectTab('users');
  }

  function selectTab(tab) {
    stopPolling();
    if (tab === 'users') return renderUsersTab();
    if (tab === 'quizzes') return renderQuizzesTab();
    if (tab === 'polls') return renderPollsTab();
    if (tab === 'blogs') return renderBlogsTab();
    if (tab === 'roleplays') return renderRoleplaysTab();
    if (tab === 'events') return renderEventsTab();
    if (tab === 'fake') return renderFakeActivityTab();
    if (tab === 'leaderboard') return renderLeaderboardTab();
  }

  function tabHost() { return document.getElementById('tabContent'); }

  /* ---- Users tab ---- */
  async function renderUsersTab() {
    const host = tabHost();
    host.innerHTML = `
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
        <h2>Users <span class="count" id="userCount"></span></h2>
        <div class="table-scroll">
          <table class="users">
            <thead><tr><th>Status</th><th>User</th><th>Email</th><th>Profile</th><th>Joined</th><th></th></tr></thead>
            <tbody id="userRows"><tr><td colspan="6" class="count">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;
    const createForm = host.querySelector('#createForm');
    const createMsg = host.querySelector('#createMsg');
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      createMsg.className = 'msg';
      const fd = new FormData(createForm);
      try {
        await api.post('/api/admin/users', {
          username: fd.get('username'), displayName: fd.get('displayName'), password: fd.get('password'),
        });
        createMsg.textContent = `User "${fd.get('username')}" created.`;
        createMsg.className = 'msg ok';
        createForm.reset();
        loadUsers();
      } catch (err) { createMsg.textContent = err.message; createMsg.className = 'msg error'; }
    });

    await loadUsers();
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

    if (!users.length) { rowsEl.innerHTML = `<tr><td colspan="6" class="count">No users yet.</td></tr>`; return; }
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

  /* ==================================================================
     Quizzes tab
  ================================================================== */
  async function renderQuizzesTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card" id="quizEditor"></div><div class="admin-card"><h2>Existing quizzes</h2><div id="quizList" class="count">Loading…</div></div>';
    renderQuizEditor(null);
    await loadQuizList();
  }

  function optionRowHtml(value) {
    return `
      <div class="qb-option-row">
        <input type="text" class="qb-opt" value="${esc(value || '')}" placeholder="Option text" />
        <button type="button" class="danger small qb-rm-opt">✕</button>
      </div>`;
  }

  function questionBlock(qIdx, q) {
    q = q || { prompt: '', options: ['', ''] };
    const block = el(`
      <div class="qb-question" data-q="${qIdx}">
        <label>Question ${qIdx + 1}</label>
        <input type="text" class="qb-prompt" value="${esc(q.prompt)}" placeholder="Question prompt" />
        <div class="qb-options"></div>
        <div class="admin-item-actions">
          <button type="button" class="ghost small qb-add-opt">+ Add option</button>
          <button type="button" class="danger small qb-rm-q">Remove question</button>
        </div>
      </div>
    `);
    const optsBox = block.querySelector('.qb-options');
    const removeOpt = (row) => {
      if (optsBox.children.length <= 2) return alert('At least two options are required.');
      row.remove();
    };
    const addOptRow = (value) => {
      const row = el(optionRowHtml(value));
      row.querySelector('.qb-rm-opt').addEventListener('click', () => removeOpt(row));
      optsBox.appendChild(row);
    };
    (q.options && q.options.length ? q.options : ['', '']).forEach((opt) => addOptRow(opt));
    block.querySelector('.qb-add-opt').addEventListener('click', () => addOptRow(''));
    block.querySelector('.qb-rm-q').addEventListener('click', () => block.remove());
    return block;
  }

  function renderQuizEditor(quiz) {
    const host = document.getElementById('quizEditor');
    host.innerHTML = `
      <h2>${quiz ? 'Edit quiz' : 'Create quiz'}</h2>
      <label>Title</label><input id="quizTitle" value="${esc(quiz ? quiz.title : '')}" />
      <label>Description</label><input id="quizDesc" value="${esc(quiz ? quiz.description : '')}" />
      <label>Questions</label>
      <p class="count">Compatibility quiz — there are no right or wrong answers. Two people answer the same questions and get a match score based on how many they pick in common.</p>
      <div id="quizQuestions"></div>
      ${seoFieldsHtml(quiz && quiz.seo)}
      <div class="admin-item-actions">
        <button type="button" class="ghost small" id="addQuestion">+ Add question</button>
        <button type="button" class="primary" id="saveQuiz">${quiz ? 'Save changes' : 'Create quiz'}</button>
        ${quiz ? '<button type="button" class="ghost" id="cancelEdit">Cancel</button>' : ''}
      </div>
      <div class="msg" id="quizMsg"></div>
    `;
    const qBox = host.querySelector('#quizQuestions');
    const questions = quiz && quiz.questions && quiz.questions.length ? quiz.questions : [null];
    questions.forEach((q, i) => qBox.appendChild(questionBlock(i, q)));
    wireSeo(host, () => host.querySelector('#quizTitle').value);

    host.querySelector('#addQuestion').addEventListener('click', () => {
      qBox.appendChild(questionBlock(qBox.children.length, null));
    });
    if (host.querySelector('#cancelEdit')) host.querySelector('#cancelEdit').addEventListener('click', () => renderQuizEditor(null));

    host.querySelector('#saveQuiz').addEventListener('click', async () => {
      const msg = host.querySelector('#quizMsg');
      msg.className = 'msg';
      const title = host.querySelector('#quizTitle').value.trim();
      const description = host.querySelector('#quizDesc').value.trim();
      const questionsOut = [];
      qBox.querySelectorAll('.qb-question').forEach((block) => {
        const prompt = block.querySelector('.qb-prompt').value.trim();
        const options = Array.from(block.querySelectorAll('.qb-opt')).map((i) => i.value.trim()).filter(Boolean);
        questionsOut.push({ prompt, options });
      });
      try {
        const payload = { title, description, questions: questionsOut, seo: collectSeo(host) };
        if (quiz) await api.put('/api/admin/quizzes/' + quiz.id, payload);
        else await api.post('/api/admin/quizzes', payload);
        msg.className = 'msg ok'; msg.textContent = 'Saved.';
        renderQuizEditor(null);
        loadQuizList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  async function loadQuizList() {
    const box = document.getElementById('quizList');
    if (!box) return;
    let quizzes;
    try { quizzes = (await api.get('/api/admin/quizzes')).quizzes; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!quizzes.length) { box.innerHTML = '<div class="count">No quizzes yet.</div>'; return; }
    box.innerHTML = '';
    quizzes.forEach((q) => {
      const item = el(`
        <div class="admin-item">
          <h3>${esc(q.title)}</h3>
          <div class="count">${q.questions.length} questions · ${q.attempts} attempts</div>
          <div class="admin-item-actions">
            <button class="ghost small" data-edit>Edit</button>
            <button class="danger small" data-del>Delete</button>
          </div>
        </div>
      `);
      item.querySelector('[data-edit]').addEventListener('click', () => { renderQuizEditor(q); window.scrollTo(0, 0); });
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this quiz and all its attempts?')) return;
        try { await api.del('/api/admin/quizzes/' + q.id); loadQuizList(); } catch (e) { alert(e.message); }
      });
      box.appendChild(item);
    });
  }

  /* ==================================================================
     Polls tab
  ================================================================== */
  async function renderPollsTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card" id="pollEditor"></div><div class="admin-card"><h2>Existing polls</h2><div id="pollList" class="count">Loading…</div></div>';
    renderPollEditor(null);
    await loadPollList();
  }

  function renderPollEditor(poll) {
    const host = document.getElementById('pollEditor');
    const opts = poll && poll.options.length ? poll.options : ['', ''];
    host.innerHTML = `
      <h2>${poll ? 'Edit poll' : 'Create poll'}</h2>
      <label>Question</label><input id="pollQ" value="${esc(poll ? poll.question : '')}" />
      <label>Options</label>
      <div id="pollOpts"></div>
      ${seoFieldsHtml(poll && poll.seo)}
      <div class="admin-item-actions">
        <button type="button" class="ghost small" id="addOpt">+ Add option</button>
        ${poll ? `<label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="pollClosed" style="width:auto"${poll.closed ? ' checked' : ''}/> Closed</label>` : ''}
        <button type="button" class="primary" id="savePoll">${poll ? 'Save changes' : 'Create poll'}</button>
        ${poll ? '<button type="button" class="ghost" id="cancelPoll">Cancel</button>' : ''}
      </div>
      <div class="msg" id="pollMsg"></div>
    `;
    const optsBox = host.querySelector('#pollOpts');
    const addOptRow = (v) => {
      const row = el(`<div class="qb-option-row"><input type="text" class="poll-opt-in" value="${esc(v || '')}" placeholder="Option text" /><button type="button" class="danger small">✕</button></div>`);
      row.querySelector('button').addEventListener('click', () => { if (optsBox.children.length <= 2) return alert('At least two options are required.'); row.remove(); });
      optsBox.appendChild(row);
    };
    opts.forEach(addOptRow);
    host.querySelector('#addOpt').addEventListener('click', () => addOptRow(''));
    wireSeo(host, () => host.querySelector('#pollQ').value);
    if (host.querySelector('#cancelPoll')) host.querySelector('#cancelPoll').addEventListener('click', () => renderPollEditor(null));

    host.querySelector('#savePoll').addEventListener('click', async () => {
      const msg = host.querySelector('#pollMsg');
      msg.className = 'msg';
      const question = host.querySelector('#pollQ').value.trim();
      const options = Array.from(host.querySelectorAll('.poll-opt-in')).map((i) => i.value.trim()).filter(Boolean);
      const closedEl = host.querySelector('#pollClosed');
      try {
        const payload = { question, options, seo: collectSeo(host) };
        if (poll) { payload.closed = !!(closedEl && closedEl.checked); await api.put('/api/admin/polls/' + poll.id, payload); }
        else await api.post('/api/admin/polls', payload);
        msg.className = 'msg ok'; msg.textContent = 'Saved.';
        renderPollEditor(null);
        loadPollList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  async function loadPollList() {
    const box = document.getElementById('pollList');
    if (!box) return;
    let polls;
    try { polls = (await api.get('/api/admin/polls')).polls; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!polls.length) { box.innerHTML = '<div class="count">No polls yet.</div>'; return; }
    box.innerHTML = '';
    polls.forEach((p) => {
      const item = el(`
        <div class="admin-item">
          <h3>${esc(p.question)}</h3>
          <div class="count">${p.options.length} options · ${p.votes} votes${p.closed ? ' · CLOSED' : ''}</div>
          <div class="admin-item-actions">
            <button class="ghost small" data-edit>Edit</button>
            <button class="danger small" data-del>Delete</button>
          </div>
        </div>
      `);
      item.querySelector('[data-edit]').addEventListener('click', () => { renderPollEditor(p); window.scrollTo(0, 0); });
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this poll and all its votes?')) return;
        try { await api.del('/api/admin/polls/' + p.id); loadPollList(); } catch (e) { alert(e.message); }
      });
      box.appendChild(item);
    });
  }

  /* ==================================================================
     Blogs tab
  ================================================================== */
  async function renderBlogsTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card" id="blogEditor"></div><div class="admin-card"><h2>Existing posts</h2><div id="blogList" class="count">Loading…</div></div>';
    renderBlogEditor(null);
    await loadBlogList();
  }

  function renderBlogEditor(blog) {
    const host = document.getElementById('blogEditor');
    host.innerHTML = `
      <h2>${blog ? 'Edit blog post' : 'Create blog post'}</h2>
      <label>Title</label><input id="blogTitle" value="${esc(blog ? blog.title : '')}" />
      <label>Author</label><input id="blogAuthor" value="${esc(blog ? blog.author : 'getxmatch')}" />
      <label>Excerpt (optional)</label><input id="blogExcerpt" value="${esc(blog ? blog.excerpt : '')}" />
      <label>Body</label><textarea id="blogBody" style="min-height:160px">${esc(blog ? blog.body : '')}</textarea>
      <label>Cover image (optional)</label><input type="file" id="blogCover" accept="image/*" />
      ${seoFieldsHtml(blog && blog.seo)}
      <div class="admin-item-actions">
        <button type="button" class="primary" id="saveBlog">${blog ? 'Save changes' : 'Publish'}</button>
        ${blog ? '<button type="button" class="ghost" id="cancelBlog">Cancel</button>' : ''}
      </div>
      <div class="msg" id="blogMsg"></div>
    `;
    if (host.querySelector('#cancelBlog')) host.querySelector('#cancelBlog').addEventListener('click', () => renderBlogEditor(null));
    wireSeo(host, () => host.querySelector('#blogTitle').value);
    host.querySelector('#saveBlog').addEventListener('click', async () => {
      const msg = host.querySelector('#blogMsg');
      msg.className = 'msg';
      const fd = new FormData();
      fd.append('title', host.querySelector('#blogTitle').value.trim());
      fd.append('author', host.querySelector('#blogAuthor').value.trim());
      fd.append('excerpt', host.querySelector('#blogExcerpt').value.trim());
      fd.append('body', host.querySelector('#blogBody').value.trim());
      fd.append('seo', JSON.stringify(collectSeo(host)));
      const coverEl = host.querySelector('#blogCover');
      if (coverEl.files[0]) fd.append('cover', coverEl.files[0]);
      try {
        if (blog) await api.putForm('/api/admin/blogs/' + blog.id, fd);
        else await api.postForm('/api/admin/blogs', fd);
        msg.className = 'msg ok'; msg.textContent = 'Saved.';
        renderBlogEditor(null);
        loadBlogList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  async function loadBlogList() {
    const box = document.getElementById('blogList');
    if (!box) return;
    let blogs;
    try { blogs = (await api.get('/api/admin/blogs')).blogs; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!blogs.length) { box.innerHTML = '<div class="count">No blog posts yet.</div>'; return; }
    box.innerHTML = '';
    blogs.forEach((b) => {
      const item = el(`
        <div class="admin-item">
          <h3>${esc(b.title)}</h3>
          <div class="count">By ${esc(b.author)} · ${esc(fmtDate(b.createdAt))}</div>
          <div class="admin-item-actions">
            <button class="ghost small" data-edit>Edit</button>
            <button class="danger small" data-del>Delete</button>
          </div>
        </div>
      `);
      item.querySelector('[data-edit]').addEventListener('click', () => { renderBlogEditor(b); window.scrollTo(0, 0); });
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this blog post?')) return;
        try { await api.del('/api/admin/blogs/' + b.id); loadBlogList(); } catch (e) { alert(e.message); }
      });
      box.appendChild(item);
    });
  }

  /* ==================================================================
     Roleplays tab
  ================================================================== */
  async function renderRoleplaysTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card" id="rpEditor"></div><div class="admin-card"><h2>Existing roleplays</h2><div id="rpList" class="count">Loading…</div></div>';
    renderRoleplayEditor(null);
    await loadRoleplayList();
  }

  // One editable stage: narration + optional image (with keep/replace/clear).
  function roleplayStageBlock(stage, idx) {
    stage = stage || { narration: '', image: null, imageRaw: null };
    const block = el(`
      <div class="qb-question rp-stage">
        <label>Stage <span class="rp-stage-num">${idx + 1}</span></label>
        <textarea class="rp-narration" placeholder="Narration / story for this stage…" style="min-height:90px">${esc(stage.narration || '')}</textarea>
        <div class="rp-stage-img">
          ${stage.image ? `<img class="rp-thumb" src="${esc(stage.image)}" alt="stage image" />` : ''}
          <label style="margin:8px 0 4px">Image / GIF (optional)</label>
          <input type="file" class="rp-image" accept="image/*" />
          ${stage.imageRaw ? `<label class="rp-keep-row" style="display:flex;align-items:center;gap:6px;margin:6px 0"><input type="checkbox" class="rp-clear-img" style="width:auto" /> Remove current image</label>` : ''}
        </div>
        <div class="admin-item-actions">
          <button type="button" class="danger small rp-rm-stage">Remove stage</button>
        </div>
      </div>
    `);
    block.dataset.existingImage = stage.imageRaw || '';
    block.querySelector('.rp-rm-stage').addEventListener('click', () => { block.remove(); renumberStages(); });
    return block;
  }

  function renumberStages() {
    document.querySelectorAll('#rpStages .rp-stage').forEach((b, i) => {
      const n = b.querySelector('.rp-stage-num');
      if (n) n.textContent = i + 1;
    });
  }

  function renderRoleplayEditor(rp) {
    const host = document.getElementById('rpEditor');
    host.innerHTML = `
      <h2>${rp ? 'Edit roleplay' : 'Create roleplay'}</h2>
      <label>Title</label><input id="rpTitle" value="${esc(rp ? rp.title : '')}" />
      <label>Description</label><input id="rpDesc" value="${esc(rp ? rp.description : '')}" />
      <label>Messages required from EACH user per stage</label>
      <input id="rpRequired" type="number" min="1" max="100" value="${rp ? rp.requiredMessages : 10}" style="max-width:120px" />
      <label>Cover image (optional)</label>
      ${rp && rp.cover ? `<div><img class="rp-thumb" src="${esc(rp.cover)}" alt="cover" /></div>` : ''}
      <input type="file" id="rpCover" accept="image/*" />
      <h3 style="margin-top:18px">Stages <span class="count">(total: <span id="rpStageCount">0</span>)</span></h3>
      <div id="rpStages"></div>
      <div class="admin-item-actions">
        <button type="button" class="ghost small" id="rpAddStage">+ Add stage</button>
        <button type="button" class="primary" id="rpSave">${rp ? 'Save changes' : 'Create roleplay'}</button>
        ${rp ? '<button type="button" class="ghost" id="rpCancel">Cancel</button>' : ''}
      </div>
      <div class="msg" id="rpMsg"></div>
    `;
    const stagesBox = host.querySelector('#rpStages');
    const countEl = host.querySelector('#rpStageCount');
    const updateCount = () => { countEl.textContent = stagesBox.querySelectorAll('.rp-stage').length; };
    const stages = rp && rp.stages && rp.stages.length ? rp.stages : [null];
    stages.forEach((s, i) => stagesBox.appendChild(roleplayStageBlock(s, i)));
    updateCount();

    host.querySelector('#rpAddStage').addEventListener('click', () => {
      stagesBox.appendChild(roleplayStageBlock(null, stagesBox.querySelectorAll('.rp-stage').length));
      updateCount();
    });
    stagesBox.addEventListener('click', (e) => { if (e.target.classList.contains('rp-rm-stage')) setTimeout(updateCount, 0); });

    if (host.querySelector('#rpCancel')) host.querySelector('#rpCancel').addEventListener('click', () => renderRoleplayEditor(null));

    host.querySelector('#rpSave').addEventListener('click', async () => {
      const msg = host.querySelector('#rpMsg');
      msg.className = 'msg';
      const fd = new FormData();
      fd.append('title', host.querySelector('#rpTitle').value.trim());
      fd.append('description', host.querySelector('#rpDesc').value.trim());
      fd.append('requiredMessages', host.querySelector('#rpRequired').value || '10');

      const coverEl = host.querySelector('#rpCover');
      if (coverEl.files[0]) fd.append('cover', coverEl.files[0]);
      else if (rp && rp.cover) fd.append('keepCover', 'true');

      const stageEls = Array.from(stagesBox.querySelectorAll('.rp-stage'));
      if (!stageEls.length) { msg.className = 'msg error'; msg.textContent = 'Add at least one stage.'; return; }
      const stagesOut = stageEls.map((blk, i) => {
        const narration = blk.querySelector('.rp-narration').value.trim();
        const fileIn = blk.querySelector('.rp-image');
        const cleared = blk.querySelector('.rp-clear-img');
        const existing = blk.dataset.existingImage || '';
        if (fileIn.files[0]) fd.append('stage_image_' + i, fileIn.files[0]);
        const keepExisting = existing && !fileIn.files[0] && !(cleared && cleared.checked);
        return { narration, existingImage: keepExisting ? existing : null };
      });
      fd.append('stages', JSON.stringify(stagesOut));

      try {
        if (rp) await api.putForm('/api/admin/roleplays/' + rp.id, fd);
        else await api.postForm('/api/admin/roleplays', fd);
        msg.className = 'msg ok'; msg.textContent = 'Saved.';
        renderRoleplayEditor(null);
        loadRoleplayList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  async function loadRoleplayList() {
    const box = document.getElementById('rpList');
    if (!box) return;
    let roleplays;
    try { roleplays = (await api.get('/api/admin/roleplays')).roleplays; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!roleplays.length) { box.innerHTML = '<div class="count">No roleplays yet.</div>'; return; }
    box.innerHTML = '';
    roleplays.forEach((rp) => {
      const item = el(`
        <div class="admin-item">
          <h3>${esc(rp.title)}</h3>
          <div class="count">${rp.stages.length} stage${rp.stages.length === 1 ? '' : 's'} · ${rp.requiredMessages} messages each per stage</div>
          <div class="admin-item-actions">
            <button class="ghost small" data-edit>Edit</button>
            <button class="danger small" data-del>Delete</button>
          </div>
        </div>
      `);
      item.querySelector('[data-edit]').addEventListener('click', () => { renderRoleplayEditor(rp); window.scrollTo(0, 0); });
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this roleplay? Any in-progress sessions will end.')) return;
        try { await api.del('/api/admin/roleplays/' + rp.id); loadRoleplayList(); } catch (e) { alert(e.message); }
      });
      box.appendChild(item);
    });
  }

  /* ==================================================================
     Recent Events tab (admin-curated announcements)
  ================================================================== */
  async function renderEventsTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card" id="eventEditor"></div><div class="admin-card"><h2>Curated events</h2><p class="count">These appear on the Recent Events feed alongside automatic activity (friendships, chats, discussions, quiz attempts).</p><div id="eventList" class="count">Loading…</div></div>';
    renderEventEditor(null);
    await loadEventList();
  }

  function renderEventEditor(ev) {
    const host = document.getElementById('eventEditor');
    host.innerHTML = `
      <h2>${ev ? 'Edit event' : 'Create event / announcement'}</h2>
      <label>Title</label><input id="evTitle" value="${esc(ev ? ev.title : '')}" />
      <label>Body</label><textarea id="evBody">${esc(ev ? ev.body : '')}</textarea>
      <div class="admin-item-actions">
        <button type="button" class="primary" id="saveEvent">${ev ? 'Save changes' : 'Publish'}</button>
        ${ev ? '<button type="button" class="ghost" id="cancelEvent">Cancel</button>' : ''}
      </div>
      <div class="msg" id="evMsg"></div>
    `;
    if (host.querySelector('#cancelEvent')) host.querySelector('#cancelEvent').addEventListener('click', () => renderEventEditor(null));
    host.querySelector('#saveEvent').addEventListener('click', async () => {
      const msg = host.querySelector('#evMsg');
      msg.className = 'msg';
      const payload = { title: host.querySelector('#evTitle').value.trim(), body: host.querySelector('#evBody').value.trim() };
      try {
        if (ev) await api.put('/api/admin/events/' + ev.id, payload);
        else await api.post('/api/admin/events', payload);
        msg.className = 'msg ok'; msg.textContent = 'Saved.';
        renderEventEditor(null);
        loadEventList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  async function loadEventList() {
    const box = document.getElementById('eventList');
    if (!box) return;
    let events;
    try { events = (await api.get('/api/admin/events')).events; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!events.length) { box.innerHTML = '<div class="count">No curated events yet.</div>'; return; }
    box.innerHTML = '';
    events.forEach((ev) => {
      const item = el(`
        <div class="admin-item">
          <h3>${esc(ev.title)}</h3>
          <div class="count">${esc(fmtDate(ev.createdAt))}</div>
          <div class="admin-item-actions">
            <button class="ghost small" data-edit>Edit</button>
            <button class="danger small" data-del>Delete</button>
          </div>
        </div>
      `);
      item.querySelector('[data-edit]').addEventListener('click', () => { renderEventEditor(ev); window.scrollTo(0, 0); });
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm('Delete this event?')) return;
        try { await api.del('/api/admin/events/' + ev.id); loadEventList(); } catch (e) { alert(e.message); }
      });
      box.appendChild(item);
    });
  }

  /* ==================================================================
     Fake Activity tab
  ================================================================== */
  async function renderFakeActivityTab() {
    const host = tabHost();
    host.innerHTML = `
      <div class="admin-card">
        <h2>Fake activity</h2>
        <p class="count">Each row is <b>Person A · activity · Person B</b>. Names and activities are recombined at random and mixed into the members' recent-activity feed (names are never clickable). Example: <i>Priya · flirting with · Sam</i>.</p>
        <div class="fake-row-head">
          <span>Person A</span><span>Activity</span><span>Person B</span><span></span>
        </div>
        <div class="fake-add">
          <input id="faA" placeholder="e.g. Priya" />
          <input id="faAct" placeholder="e.g. flirting with" />
          <input id="faB" placeholder="e.g. Sam" />
          <button type="button" class="primary small" id="faAdd">Add</button>
        </div>
        <div class="msg" id="faMsg"></div>
      </div>
      <div class="admin-card">
        <h2>Activity pool</h2>
        <div id="faList" class="count">Loading…</div>
      </div>
    `;
    const msg = host.querySelector('#faMsg');
    const add = async () => {
      msg.className = 'msg';
      const personA = host.querySelector('#faA').value.trim();
      const activity = host.querySelector('#faAct').value.trim();
      const personB = host.querySelector('#faB').value.trim();
      if (!personA || !activity || !personB) { msg.className = 'msg error'; msg.textContent = 'All three fields are required.'; return; }
      try {
        await api.post('/api/admin/fake-activities', { personA, activity, personB });
        host.querySelector('#faA').value = '';
        host.querySelector('#faAct').value = '';
        host.querySelector('#faB').value = '';
        host.querySelector('#faA').focus();
        loadFakeList();
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    };
    host.querySelector('#faAdd').addEventListener('click', add);
    host.querySelectorAll('#faA, #faAct, #faB').forEach((i) =>
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); }));
    await loadFakeList();
  }

  async function loadFakeList() {
    const box = document.getElementById('faList');
    if (!box) return;
    let activities;
    try { activities = (await api.get('/api/admin/fake-activities')).activities; }
    catch (e) { if (e.status === 401) return renderLogin(true); box.textContent = e.message; return; }
    if (!activities.length) { box.innerHTML = '<div class="count">No fake activity yet. Add a few rows above.</div>'; return; }
    box.innerHTML = '';
    const table = el('<div class="fake-table"></div>');
    activities.forEach((a) => {
      const row = el(`
        <div class="fake-row">
          <span class="fake-name">${esc(a.personA)}</span>
          <span class="fake-act">${esc(a.activity)}</span>
          <span class="fake-name">${esc(a.personB)}</span>
          <button class="danger small" data-del title="Delete">✕</button>
        </div>
      `);
      row.querySelector('[data-del]').addEventListener('click', async () => {
        try { await api.del('/api/admin/fake-activities/' + a.id); loadFakeList(); } catch (e) { alert(e.message); }
      });
      table.appendChild(row);
    });
    box.appendChild(table);
  }

  /* ==================================================================
     Leaderboard tab (read-only oversight)
  ================================================================== */
  async function renderLeaderboardTab() {
    const host = tabHost();
    host.innerHTML = '<div class="admin-card"><h2>Leaderboard</h2><p class="count">Auto-ranked by ratings, friends and quiz activity.</p><div class="table-scroll"><table class="users"><thead><tr><th>Rank</th><th>User</th><th>Rating</th><th>Friends</th><th>Quizzes</th><th>Score</th></tr></thead><tbody id="lbRows"><tr><td colspan="6" class="count">Loading…</td></tr></tbody></table></div></div>';
    const rowsEl = host.querySelector('#lbRows');
    let rows;
    try { rows = (await api.get('/api/admin/leaderboard')).leaderboard; }
    catch (e) { if (e.status === 401) return renderLogin(true); rowsEl.innerHTML = `<tr><td colspan="6" class="count">${esc(e.message)}</td></tr>`; return; }
    if (!rows.length) { rowsEl.innerHTML = '<tr><td colspan="6" class="count">No ranked users yet.</td></tr>'; return; }
    rowsEl.innerHTML = '';
    rows.forEach((r) => {
      rowsEl.appendChild(el(`
        <tr>
          <td><strong>#${r.rank}</strong></td>
          <td><strong>${esc(r.displayName)}</strong><div class="pill">@${esc(r.username)}</div></td>
          <td>${r.ratingAvg || '—'} (${r.ratingCount})</td>
          <td>${r.friends}</td>
          <td>${r.quizzes}</td>
          <td><strong>${r.score}</strong></td>
        </tr>
      `));
    });
  }

  boot();
})();
