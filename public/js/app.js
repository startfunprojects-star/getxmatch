/* getxmatch SPA */
(function () {
  'use strict';

  const root = document.getElementById('app');
  const state = {
    me: null,
    socket: null,
    tab: 'people',       // 'people' | 'chats'
    peer: null,          // active chat peer
    openChats: [],       // ordered list of open chat tabs (peer objects)
    unread: {},          // peerId -> true when a background tab has new messages
    activities: null,    // cached list of chat activity verbs (column 2)
    chatActivity: null,  // { mine, theirs } for the open conversation
    peopleCache: [],
    chatPeers: {},       // id -> peer summary for people we've chatted with
    typingTimer: null,
    gifts: null,         // naughty-gift catalog, loaded lazily
    giftsById: {},       // id -> gift for rendering
  };

  // Fetch (and cache) the naughty-gift catalog.
  async function loadGifts() {
    if (state.gifts) return state.gifts;
    try {
      const { gifts } = await api.get('/api/social/gifts');
      state.gifts = gifts || [];
      state.giftsById = {};
      state.gifts.forEach((g) => { state.giftsById[g.id] = g; });
    } catch (_e) {
      state.gifts = [];
    }
    return state.gifts;
  }

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function avatarUrl(url) {
    return url || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%231f2430'/%3E%3Ctext x='50%25' y='54%25' font-size='34' text-anchor='middle' fill='%239aa2b1'%3E%F0%9F%91%A4%3C/text%3E%3C/svg%3E";
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /* ---------- profile field option lists (mirror src/profileFields.js) ---------- */
  const OPT = {
    gender: ['Male', 'Female', 'Non-binary', 'Other', 'Prefer not to say'],
    sexuality: ['Straight', 'Gay', 'Lesbian', 'Bisexual'],
    yesNo: ['Yes', 'No', 'Occasionally', 'Prefer not to say'],
    diet: ['Vegetarian', 'Non-vegetarian', 'Vegan', 'Eggetarian'],
    bedRole: ['Dominating', 'Submissive', 'Mix', 'Go with the flow'],
    relationshipStatus: ['Single', 'In a relationship', 'Married', "It's complicated", 'Prefer not to say'],
    interests: ['Movies', 'Photography', 'Reading', 'Politics', 'Music', 'Travel', 'Sports',
      'Gaming', 'Cooking', 'Fitness', 'Art', 'Technology', 'Fashion', 'Nature', 'Dancing'],
  };
  const MAX_GALLERY = 25;
  const COUNTRIES = ['Afghanistan', 'Albania', 'Algeria', 'Argentina', 'Australia', 'Austria',
    'Bangladesh', 'Belgium', 'Brazil', 'Bulgaria', 'Canada', 'Chile', 'China', 'Colombia',
    'Croatia', 'Czechia', 'Denmark', 'Egypt', 'Finland', 'France', 'Germany', 'Ghana', 'Greece',
    'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
    'Japan', 'Jordan', 'Kenya', 'Malaysia', 'Mexico', 'Nepal', 'Netherlands', 'New Zealand',
    'Nigeria', 'Norway', 'Pakistan', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar',
    'Romania', 'Russia', 'Saudi Arabia', 'Singapore', 'South Africa', 'South Korea', 'Spain',
    'Sri Lanka', 'Sweden', 'Switzerland', 'Thailand', 'Turkey', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'Vietnam', 'Other'];

  // Build a <select> with a placeholder first option. `current` is preselected.
  function selectHtml(id, options, current, placeholder) {
    // placeholder === false → no empty first option (field always has a value).
    const head = placeholder === false ? [] : ['<option value="">' + esc(placeholder || 'Select…') + '</option>'];
    const opts = head.concat(options.map((o) => {
      const label = o.value != null ? o.label : o;
      const value = o.value != null ? o.value : o;
      return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
    }));
    return `<select id="${id}">${opts.join('')}</select>`;
  }
  function starsHtml(n, interactive) {
    let out = '';
    for (let i = 1; i <= 5; i++) {
      const filled = i <= Math.round(n);
      out += `<span class="star${filled ? ' on' : ''}"${interactive ? ` data-v="${i}"` : ''}>★</span>`;
    }
    return out;
  }

  /* ======================================================================
     BOOT
  ====================================================================== */
  // Deep-link intent from a shared quiz result page (/?chat=<username>&signup=1).
  let pendingChatUser = null;

  async function openChatByUsername(username) {
    if (!username) return;
    try {
      const { profile } = await api.get('/api/profile/' + encodeURIComponent(username));
      openChat({ id: profile.id, username: profile.username, displayName: profile.displayName, avatar: profile.avatar });
    } catch (_e) { /* user may not exist / be blocked */ }
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const wantSignup = params.get('signup') === '1';
    pendingChatUser = params.get('chat');
    if (location.search) history.replaceState(null, '', location.pathname); // tidy the URL
    try {
      const { user, hasProfile } = await api.get('/api/auth/me');
      state.me = user;
      if (!hasProfile) return renderProfileEditor(true);
      return enterApp();
    } catch (e) {
      return renderAuth(wantSignup ? 'signup' : 'login');
    }
  }

  /* ======================================================================
     AUTH
  ====================================================================== */
  function renderAuth(mode) {
    mode = mode || 'login';
    root.innerHTML = '';
    const card = el(`
      <div class="auth-wrap"><div class="auth-card">
        <h1 class="brand">get<span class="x">x</span>match</h1>
        <p class="auth-sub">${mode === 'login' ? 'Welcome back.' : 'Create your account. 18+ only.'}</p>
        <form id="authForm">
          ${mode === 'signup' ? `
            <label>Username</label>
            <input name="username" autocomplete="username" placeholder="3-20 letters, numbers, _" required />
            <label>Email</label>
            <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
            <label>Password</label>
            <input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required />
            <div class="checkbox-row">
              <input type="checkbox" name="ageConfirmed" id="age" />
              <label for="age" style="margin:0">I confirm I am 18 years of age or older and agree to the terms.</label>
            </div>
          ` : `
            <label>Username or Email</label>
            <input name="identifier" autocomplete="username" required />
            <label>Password</label>
            <input name="password" type="password" autocomplete="current-password" required />
          `}
          <div class="msg" id="authMsg"></div>
          <button class="primary" type="submit" style="width:100%;margin-top:18px">
            ${mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>
        <div class="auth-toggle">
          ${mode === 'login'
            ? `New here? <a href="#" id="toggleAuth">Create an account</a>`
            : `Already have an account? <a href="#" id="toggleAuth">Log in</a>`}
        </div>
      </div></div>
    `);
    root.appendChild(card);

    const form = card.querySelector('#authForm');
    const msg = card.querySelector('#authMsg');
    card.querySelector('#toggleAuth').addEventListener('click', (e) => {
      e.preventDefault();
      renderAuth(mode === 'login' ? 'signup' : 'login');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg';
      const fd = new FormData(form);
      try {
        if (mode === 'signup') {
          // Step 1: request an email OTP. Account is created only after verify.
          await api.post('/api/auth/signup/start', {
            username: fd.get('username'),
            email: fd.get('email'),
            password: fd.get('password'),
            ageConfirmed: fd.get('ageConfirmed') === 'on',
          });
          return renderOtp(String(fd.get('email')).toLowerCase());
        }
        const out = await api.post('/api/auth/login', {
          identifier: fd.get('identifier'),
          password: fd.get('password'),
        });
        state.me = out.user;
        if (!out.hasProfile) return renderProfileEditor(true);
        return enterApp();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'msg error';
      }
    });
  }

  /* Step 2 of signup: enter the 6-digit code emailed to the user. */
  function renderOtp(email) {
    root.innerHTML = '';
    const card = el(`
      <div class="auth-wrap"><div class="auth-card">
        <h1 class="brand">get<span class="x">x</span>match</h1>
        <p class="auth-sub">Enter the 6-digit code we emailed to <strong>${esc(email)}</strong>.</p>
        <form id="otpForm">
          <label>Verification code</label>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
                 placeholder="123456" required
                 style="letter-spacing:8px;text-align:center;font-size:22px" />
          <div class="msg" id="otpMsg"></div>
          <button class="primary" type="submit" style="width:100%;margin-top:18px">Verify &amp; create account</button>
        </form>
        <div class="auth-toggle">
          Didn't get it? <a href="#" id="backToSignup">Start over</a>
        </div>
      </div></div>
    `);
    root.appendChild(card);

    const form = card.querySelector('#otpForm');
    const msg = card.querySelector('#otpMsg');

    card.querySelector('#backToSignup').addEventListener('click', (e) => {
      e.preventDefault();
      renderAuth('signup');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className = 'msg';
      const code = new FormData(form).get('code');
      try {
        const out = await api.post('/api/auth/signup/verify', { email, code });
        state.me = out.user;
        if (!out.hasProfile) return renderProfileEditor(true);
        return enterApp();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'msg error';
      }
    });
  }

  /* ======================================================================
     PROFILE EDITOR (create after signup / edit later)
  ====================================================================== */
  async function renderProfileEditor(firstTime) {
    let existing = null;
    if (!firstTime) {
      try { existing = (await api.get('/api/profile/me')).profile; } catch (_e) {}
    }
    const e = existing || {};
    const selectedInterests = new Set(e.interests || []);
    root.innerHTML = '';
    const wrap = el(`
      <div class="auth-wrap"><div class="auth-card editor" style="max-width:640px">
        <h1 style="font-size:24px;margin-bottom:2px">${firstTime ? 'Set up your profile' : 'Edit profile'}</h1>
        <p class="auth-sub">Fields marked <span class="req">*</span> are required. Everything else is optional.</p>
        <div class="avatar-picker">
          <img class="avatar lg" id="avPreview" src="${avatarUrl(e.avatar)}" alt="avatar" />
          <div>
            <button class="ghost small" id="pickAvatar" type="button">Choose display picture</button>
            <div class="hint">JPG, PNG, WEBP or GIF</div>
          </div>
        </div>
        <input type="file" id="avatarInput" accept="image/*" class="hidden" />

        <label>Display name <span class="req">*</span></label>
        <input id="displayName" maxlength="50" value="${esc(e.displayName || '')}" placeholder="Your name" />

        <div class="field-grid">
          <div>
            <label>Gender <span class="req">*</span></label>
            ${selectHtml('gender', OPT.gender, e.gender, 'Select gender')}
          </div>
          <div>
            <label>Date of birth <span class="req">*</span></label>
            <input type="date" id="dateOfBirth" value="${esc(e.dateOfBirth || '')}" max="9999-12-31" />
          </div>
          <div>
            <label>Country <span class="req">*</span></label>
            ${selectHtml('country', COUNTRIES, e.country, 'Select country')}
          </div>
          <div>
            <label>Sexuality</label>
            ${selectHtml('sexuality', OPT.sexuality, e.sexuality, 'Select…')}
          </div>
          <div>
            <label>Do you smoke?</label>
            ${selectHtml('smokes', OPT.yesNo, e.smokes, 'Select…')}
          </div>
          <div>
            <label>Do you consume alcohol?</label>
            ${selectHtml('drinks', OPT.yesNo, e.drinks, 'Select…')}
          </div>
          <div>
            <label>Veg or non-veg?</label>
            ${selectHtml('diet', OPT.diet, e.diet, 'Select…')}
          </div>
          <div>
            <label>Relationship status</label>
            ${selectHtml('relationshipStatus', OPT.relationshipStatus, e.relationshipStatus, 'Select…')}
          </div>
        </div>

        <label>With (partner's @username) — optional</label>
        <input id="partner" maxlength="20" value="${esc(e.partner ? e.partner.username : '')}" placeholder="e.g. their username" />

        <label>About me</label>
        <textarea id="about" maxlength="500" placeholder="Tell people a bit about you">${esc(e.about || '')}</textarea>

        <label>Tell viewers what kind of person you are</label>
        <textarea id="persona" maxlength="500" placeholder="Your personality, vibe, what you're looking for…">${esc(e.persona || '')}</textarea>

        <label>Interests</label>
        <div class="chip-picker" id="interestPicker">
          ${OPT.interests.map((i) =>
            `<label class="chip${selectedInterests.has(i) ? ' on' : ''}"><input type="checkbox" value="${esc(i)}"${selectedInterests.has(i) ? ' checked' : ''}/>${esc(i)}</label>`
          ).join('')}
        </div>

        <details class="adult-section">
          <summary>Intimacy (optional, 18+)</summary>
          <label>What you like in bed</label>
          <textarea id="likesInBed" maxlength="500" placeholder="Optional">${esc(e.likesInBed || '')}</textarea>
          <label>Are you…</label>
          ${selectHtml('bedRole', OPT.bedRole, e.bedRole, 'Select…')}
        </details>

        <div class="msg" id="pMsg"></div>
        <div class="row-actions">
          <button class="primary" id="saveProfile" type="button">${firstTime ? 'Create profile' : 'Save'}</button>
          ${firstTime ? '' : '<button class="ghost" id="backBtn" type="button">Cancel</button>'}
        </div>
      </div></div>
    `);
    root.appendChild(wrap);

    let avatarFile = null;
    const avInput = wrap.querySelector('#avatarInput');
    wrap.querySelector('#pickAvatar').addEventListener('click', () => avInput.click());
    avInput.addEventListener('change', () => {
      avatarFile = avInput.files[0] || null;
      if (avatarFile) wrap.querySelector('#avPreview').src = URL.createObjectURL(avatarFile);
    });

    // Toggle chip highlight with its checkbox.
    wrap.querySelectorAll('#interestPicker .chip').forEach((chip) => {
      const cb = chip.querySelector('input');
      cb.addEventListener('change', () => chip.classList.toggle('on', cb.checked));
    });

    const back = wrap.querySelector('#backBtn');
    if (back) back.addEventListener('click', () => enterApp());

    wrap.querySelector('#saveProfile').addEventListener('click', async () => {
      const msg = wrap.querySelector('#pMsg');
      msg.className = 'msg';
      const val = (id) => wrap.querySelector('#' + id).value;
      const interests = Array.from(wrap.querySelectorAll('#interestPicker input:checked')).map((c) => c.value);

      const fd = new FormData();
      fd.append('displayName', val('displayName'));
      fd.append('gender', val('gender'));
      fd.append('dateOfBirth', val('dateOfBirth'));
      fd.append('country', val('country'));
      fd.append('sexuality', val('sexuality'));
      fd.append('smokes', val('smokes'));
      fd.append('drinks', val('drinks'));
      fd.append('diet', val('diet'));
      fd.append('relationshipStatus', val('relationshipStatus'));
      fd.append('partner', val('partner'));
      fd.append('about', val('about'));
      fd.append('persona', val('persona'));
      fd.append('likesInBed', val('likesInBed'));
      fd.append('bedRole', val('bedRole'));
      fd.append('interests', JSON.stringify(interests));
      if (avatarFile) fd.append('avatar', avatarFile);

      try {
        await api.putForm('/api/profile', fd);
        enterApp();
      } catch (err) {
        msg.textContent = err.message;
        msg.className = 'msg error';
      }
    });
  }

  /* ======================================================================
     APP SHELL
  ====================================================================== */
  function enterApp() {
    root.innerHTML = '';
    const shell = el(`
      <div class="shell" id="shell">
        <aside class="sidebar">
          <div class="topbar">
            <div class="me" id="myProfile" title="View my profile & gallery" style="cursor:pointer">
              <img class="avatar sm" id="myAvatar" src="${avatarUrl(null)}" />
              <span class="me-name">@${esc(state.me.username)}</span>
            </div>
            <div>
              <button class="ghost small" id="myProfileBtn" title="My profile & gallery">Profile</button>
              <button class="ghost small" id="logoutBtn" title="Log out">Exit</button>
            </div>
          </div>
          <div class="nav">
            <button data-tab="people" class="active">People</button>
            <button data-tab="chats">Chats</button>
          </div>
          <div class="explore-nav" id="exploreNav">
            <button data-view="requests">🔔 Requests <span class="req-badge hidden" id="reqBadge">0</span></button>
            <button data-view="quizzes">🧠 Quizzes</button>
            <button data-view="polls">📊 Polls</button>
            <button data-view="blogs">📝 Blogs</button>
            <button data-view="leaderboard">🏆 Leaderboard</button>
            <button data-view="events">✨ Recent Activity</button>
          </div>
          <div class="search"><input id="searchInput" placeholder="Search people…" /></div>
          <div class="list" id="list"></div>
        </aside>
        <section class="main" id="main">
          <div class="empty-main">
            <div>
              <div style="font-size:40px">💬</div>
              <p>Search for someone to start chatting.</p>
              <p class="hint">Open chats appear as tabs — you can talk to several people at once. Shared files are delivered live and never stored.</p>
            </div>
          </div>
        </section>
      </div>
    `);
    root.appendChild(shell);

    // Load my avatar into the topbar.
    api.get('/api/profile/me').then(({ profile }) => {
      if (profile && profile.avatar) shell.querySelector('#myAvatar').src = profile.avatar;
    }).catch(() => {});

    shell.querySelector('#logoutBtn').addEventListener('click', async () => {
      await api.post('/api/auth/logout');
      if (state.socket) state.socket.disconnect();
      renderAuth();
    });
    const openMine = () => showProfile(state.me.username);
    shell.querySelector('#myProfileBtn').addEventListener('click', openMine);
    shell.querySelector('#myProfile').addEventListener('click', openMine);

    shell.querySelectorAll('.nav button').forEach((b) => {
      b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        shell.querySelectorAll('.nav button').forEach((x) => x.classList.toggle('active', x === b));
        shell.querySelectorAll('#exploreNav button').forEach((x) => x.classList.remove('active'));
        document.getElementById('shell').classList.remove('viewing-main');
        state.peer = null;
        renderList();
      });
    });

    shell.querySelectorAll('#exploreNav button').forEach((b) => {
      b.addEventListener('click', () => {
        shell.querySelectorAll('#exploreNav button').forEach((x) => x.classList.toggle('active', x === b));
        openExplore(b.dataset.view);
      });
    });

    let searchDebounce;
    shell.querySelector('#searchInput').addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderList, 200);
    });

    connectSocket();
    renderList();
    refreshRequestBadge();
    loadGifts(); // preload so live gifts render with the right emoji/name

    // Honor a "chat with X" deep link from a shared quiz result page.
    if (pendingChatUser) {
      const u = pendingChatUser;
      pendingChatUser = null;
      openChatByUsername(u);
    }
  }

  // Update the sidebar "Requests" badge with the number of incoming requests.
  async function refreshRequestBadge() {
    const badge = document.getElementById('reqBadge');
    if (!badge) return;
    try {
      const { incoming } = await api.get('/api/social/friends');
      const n = (incoming || []).length;
      badge.textContent = n;
      badge.classList.toggle('hidden', n === 0);
    } catch (_e) { /* ignore */ }
  }

  /* ---------- sidebar list ---------- */
  async function renderList() {
    const listEl = document.getElementById('list');
    if (!listEl) return;
    const q = (document.getElementById('searchInput').value || '').trim();

    // People tab with no search term → show the recent-activity feed instead of
    // a raw user list. Searching still surfaces real, clickable users to chat.
    if (state.tab === 'people' && !q) {
      return renderActivityInto(listEl, { compact: true });
    }

    let items = [];
    if (state.tab === 'people') {
      try {
        const { users } = await api.get('/api/users?q=' + encodeURIComponent(q));
        state.peopleCache = users;
        items = users;
      } catch (_e) { items = []; }
    } else {
      items = Object.values(state.chatPeers).filter((p) =>
        !q || (p.displayName || '').toLowerCase().includes(q.toLowerCase()) ||
        p.username.toLowerCase().includes(q.toLowerCase()));
    }

    listEl.innerHTML = '';
    if (!items.length) {
      listEl.appendChild(el(`<div style="padding:20px;color:var(--muted)">${state.tab === 'people' ? 'No people found yet.' : 'No conversations yet.'}</div>`));
      return;
    }
    items.forEach((u) => {
      const row = el(`
        <div class="list-item" data-id="${u.id}">
          <img class="avatar" src="${avatarUrl(u.avatar)}" />
          <div style="min-width:0">
            <div class="name">${esc(u.displayName || u.username)}</div>
            <div class="handle">@${esc(u.username)}</div>
          </div>
        </div>
      `);
      if (state.peer && state.peer.id === u.id) row.classList.add('active');
      row.addEventListener('click', () => openChat(u));
      listEl.appendChild(row);
    });
  }

  /* ======================================================================
     CHAT
  ====================================================================== */
  function emptyMainHtml() {
    return `
      <div class="empty-main">
        <div>
          <div style="font-size:40px">💬</div>
          <p>Search for someone to start chatting.</p>
          <p class="hint">Open chats appear as tabs above — you can talk to several people at once.</p>
        </div>
      </div>`;
  }

  // Render the row of open-chat tabs at the top of the chat pane.
  function renderChatTabs() {
    const bar = document.getElementById('chatTabs');
    if (!bar) return;
    bar.innerHTML = '';
    state.openChats.forEach((p) => {
      const active = state.peer && state.peer.id === p.id;
      const tab = el(`
        <div class="chat-tab${active ? ' active' : ''}${state.unread[p.id] ? ' unread' : ''}" data-id="${p.id}">
          <img class="avatar xs" src="${avatarUrl(p.avatar)}" />
          <span class="chat-tab-name">${esc(p.displayName || p.username)}</span>
          <button class="chat-tab-close" title="Close">✕</button>
        </div>
      `);
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('chat-tab-close')) return;
        if (!active) openChat(p);
      });
      tab.querySelector('.chat-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatTab(p.id);
      });
      bar.appendChild(tab);
    });
  }

  function closeChatTab(id) {
    const idx = state.openChats.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const wasActive = state.peer && state.peer.id === id;
    state.openChats.splice(idx, 1);
    delete state.unread[id];
    if (!wasActive) { renderChatTabs(); return; }
    const next = state.openChats[idx] || state.openChats[idx - 1];
    if (next) return openChat(next);
    state.peer = null;
    document.getElementById('shell').classList.remove('viewing-main');
    document.getElementById('main').innerHTML = emptyMainHtml();
  }

  /* ---- chat activity ("what are you doing") status bar ---- */
  async function loadActivities() {
    if (state.activities) return state.activities;
    try { state.activities = (await api.get('/api/social/activities')).activities || []; }
    catch (_e) { state.activities = []; }
    return state.activities;
  }

  function renderActivityStatus(peerName) {
    const status = document.getElementById('activityStatus');
    if (!status) return;
    const ca = state.chatActivity || {};
    const parts = [];
    if (ca.mine) parts.push(`<span class="act-me">You're ${esc(ca.mine)} ${esc(peerName)}</span>`);
    if (ca.theirs) parts.push(`<span class="act-them">${esc(peerName)}'s ${esc(ca.theirs)} you</span>`);
    status.innerHTML = parts.length
      ? parts.join('<span class="act-sep">·</span>')
      : '<span class="hint">Set what you’re doing — it shows on Recent Activity.</span>';
  }

  async function setupActivityBar(view, peer) {
    const bar = view.querySelector('#activityBar');
    const select = view.querySelector('#activitySelect');
    const activities = await loadActivities();
    if (!activities.length) { bar.classList.add('hidden'); return; } // no verbs configured
    if (!state.peer || state.peer.id !== peer.id || !document.body.contains(select)) return;

    select.innerHTML = '<option value="">— nothing —</option>' +
      activities.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
    bar.classList.remove('hidden');

    state.chatActivity = { mine: null, theirs: null };
    try {
      const st = await api.get('/api/social/chat-activity/' + peer.id);
      if (state.peer && state.peer.id === peer.id) state.chatActivity = { mine: st.mine, theirs: st.theirs };
    } catch (_e) { /* ignore */ }
    select.value = state.chatActivity.mine || '';
    renderActivityStatus(peer.displayName || peer.username);

    select.addEventListener('change', () => {
      if (!state.socket) return;
      const activity = select.value;
      state.socket.emit('chat:activity', { to: peer.id, activity }, (res) => {
        if (res && res.error) return notify(res.error);
        state.chatActivity = Object.assign({}, state.chatActivity, { mine: activity || null });
        renderActivityStatus(peer.displayName || peer.username);
      });
    });
  }

  async function openChat(peer) {
    state.peer = peer;
    state.replyTo = null; // clear any half-composed reply from a previous chat
    closeReactionPalette();
    state.chatPeers[peer.id] = peer;
    delete state.unread[peer.id];
    // Register (or refresh) this conversation as an open tab.
    const existing = state.openChats.findIndex((p) => p.id === peer.id);
    if (existing === -1) state.openChats.push(peer);
    else state.openChats[existing] = peer;
    document.querySelectorAll('.list-item').forEach((r) =>
      r.classList.toggle('active', Number(r.dataset.id) === peer.id));
    document.getElementById('shell').classList.add('viewing-main');

    const main = document.getElementById('main');
    main.innerHTML = '';
    const view = el(`
      <div class="chat-wrap">
        <div class="chat-tabs" id="chatTabs"></div>
        <div class="chat-head">
          <button class="icon-btn small" id="backToList" title="Back">←</button>
          <img class="avatar sm" id="peerAvatar" src="${avatarUrl(peer.avatar)}" style="cursor:pointer" />
          <div style="min-width:0">
            <div class="name" id="peerName" style="cursor:pointer">${esc(peer.displayName || peer.username)}</div>
            <div class="status">@${esc(peer.username)}</div>
          </div>
        </div>
        <div class="chat-activity-bar hidden" id="activityBar">
          <div class="activity-status" id="activityStatus"></div>
          <label class="activity-pick">
            <span>You're…</span>
            <select id="activitySelect"><option value="">— nothing —</option></select>
          </label>
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="typing hidden" id="typing">typing…</div>
        <div class="roleplay-bar hidden" id="roleplayBar"></div>
        <div class="gift-picker hidden" id="giftPicker"></div>
        <div class="rp-picker hidden" id="rpPicker"></div>
        <div class="reply-banner hidden" id="replyBanner"></div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="attachBtn" title="Share a file (delivered live, never stored)">📎</button>
          <button class="icon-btn" id="giftBtn" title="Send a naughty gift">🎁</button>
          <button class="icon-btn" id="rpBtn" title="Start a roleplay story">🎭</button>
          <input type="text" id="msgInput" placeholder="Type a message…" autocomplete="off" />
          <button class="primary" id="sendBtn">Send</button>
        </div>
      </div>
    `);
    main.appendChild(view);
    renderChatTabs();

    view.querySelector('#backToList').addEventListener('click', () => {
      document.getElementById('shell').classList.remove('viewing-main');
      closeReactionPalette();
      state.peer = null;
    });
    const openPeerProfile = () => showProfile(peer.username);
    view.querySelector('#peerAvatar').addEventListener('click', openPeerProfile);
    view.querySelector('#peerName').addEventListener('click', openPeerProfile);

    setupActivityBar(view, peer);

    const input = view.querySelector('#msgInput');
    const send = () => sendMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    input.addEventListener('input', () => {
      if (state.socket) state.socket.emit('chat:typing', { to: peer.id });
    });

    const fileInput = view.querySelector('#fileInput');
    view.querySelector('#attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) sendFile(fileInput.files[0]);
      fileInput.value = '';
    });


    // Naughty gift picker.
    const giftPicker = view.querySelector('#giftPicker');
    const giftBtn = view.querySelector('#giftBtn');
    giftBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!giftPicker.classList.contains('hidden')) {
        giftPicker.classList.add('hidden');
        return;
      }
      await buildGiftPicker(giftPicker);
      giftPicker.classList.remove('hidden');
    });
    // Dismiss the picker when clicking elsewhere.
    document.addEventListener('click', function onDocClick(ev) {
      if (!document.body.contains(giftPicker)) {
        document.removeEventListener('click', onDocClick);
        return;
      }
      if (!giftPicker.contains(ev.target) && ev.target !== giftBtn) {
        giftPicker.classList.add('hidden');
      }
    });

    // Roleplay picker.
    const rpPicker = view.querySelector('#rpPicker');
    const rpBtn = view.querySelector('#rpBtn');
    rpBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!rpPicker.classList.contains('hidden')) { rpPicker.classList.add('hidden'); return; }
      giftPicker.classList.add('hidden');
      await buildRoleplayPicker(rpPicker);
      rpPicker.classList.remove('hidden');
    });
    document.addEventListener('click', function onRpDocClick(ev) {
      if (!document.body.contains(rpPicker)) { document.removeEventListener('click', onRpDocClick); return; }
      if (!rpPicker.contains(ev.target) && ev.target !== rpBtn) rpPicker.classList.add('hidden');
    });

    // Load persisted history (text + gifts + roleplay narration).
    try {
      const { messages } = await api.get(`/api/users/${peer.id}/messages`);
      messages.forEach((m) => appendMessage(m));
    } catch (_e) {}
    scrollBody();

    // Restore any active roleplay progress banner for this conversation.
    try {
      const { session } = await api.get(`/api/roleplay/session/${peer.id}`);
      updateRoleplayBar(session);
    } catch (_e) { updateRoleplayBar(null); }
  }

  function chatBody() { return document.getElementById('chatBody'); }
  function scrollBody() { const b = chatBody(); if (b) b.scrollTop = b.scrollHeight; }

  /* ---------- rich message bodies: clickable links + inline media ---------- */
  const URL_RE = /(https?:\/\/[^\s<]+)/gi;

  function youtubeId(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host === 'youtu.be') return (u.pathname.slice(1).split('/')[0]) || null;
      if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const mm = u.pathname.match(/^\/(embed|shorts|v)\/([^/?#]+)/);
        if (mm) return mm[2];
      }
    } catch (_e) { /* not a url */ }
    return null;
  }
  const isImageUrl = (url) => /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(url);
  const isVideoUrl = (url) => /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url);

  // Append `text` to `container`, turning URLs into links and embedding any
  // image / video / YouTube links as playable media below the text.
  function appendRichText(container, text) {
    const str = String(text == null ? '' : text);
    const textWrap = document.createElement('span');
    textWrap.className = 'msg-text';
    const media = document.createElement('div');
    media.className = 'msg-media';
    let hasMedia = false;
    let last = 0;
    let m;
    const re = new RegExp(URL_RE.source, 'gi');
    while ((m = re.exec(str)) !== null) {
      const url = m[0];
      if (m.index > last) textWrap.appendChild(document.createTextNode(str.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'msg-link'; a.textContent = url;
      textWrap.appendChild(a);
      last = m.index + url.length;

      const yt = youtubeId(url);
      if (yt) {
        const f = document.createElement('iframe');
        f.className = 'msg-embed';
        f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(yt);
        f.setAttribute('allow', 'accelerometer; encrypted-media; picture-in-picture');
        f.setAttribute('allowfullscreen', '');
        f.loading = 'lazy';
        media.appendChild(f); hasMedia = true;
      } else if (isImageUrl(url)) {
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        const img = document.createElement('img');
        img.className = 'msg-img'; img.loading = 'lazy'; img.src = url;
        img.addEventListener('error', () => link.remove());
        link.appendChild(img); media.appendChild(link); hasMedia = true;
      } else if (isVideoUrl(url)) {
        const v = document.createElement('video');
        v.className = 'msg-video'; v.controls = true; v.preload = 'metadata'; v.src = url;
        media.appendChild(v); hasMedia = true;
      }
    }
    if (last < str.length) textWrap.appendChild(document.createTextNode(str.slice(last)));
    container.appendChild(textWrap);
    if (hasMedia) container.appendChild(media);
  }

  // m: { body, mine, at, id?, reply? }
  function appendTextBubble(m) {
    const b = chatBody();
    if (!b) return;
    const bubble = el(`<div class="bubble ${m.mine ? 'me' : 'them'}"></div>`);
    if (m.id) bubble.dataset.id = m.id;
    if (m.reply) bubble.appendChild(renderQuote(m.reply));
    appendRichText(bubble, m.body);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    attachBubbleActions(bubble, m);
    b.appendChild(bubble);
    scrollBody();
  }

  function appendFileBubble(meta, mine, objectUrl) {
    const b = chatBody();
    if (!b) return;
    const isImg = /^image\//.test(meta.mime);
    const bubble = el(`<div class="bubble ${mine ? 'me' : 'them'}"></div>`);
    if (isImg) {
      const img = document.createElement('img');
      img.className = 'shared';
      img.src = objectUrl;
      bubble.appendChild(img);
    }
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = meta.name;
    link.className = 'file';
    link.appendChild(document.createTextNode('📄 ' + meta.name + ' (' + fmtSize(meta.size) + ')'));
    bubble.appendChild(link);
    bubble.appendChild(el(`<span class="ephemeral-note">Shared live · not stored</span>`));
    bubble.appendChild(el(`<span class="time">${fmtTime(meta.at || Date.now())}</span>`));
    b.appendChild(bubble);
    scrollBody();
  }

  // Route a message object (from history or live) to the right bubble.
  function appendMessage(m) {
    if (m.kind === 'gift') appendGiftBubble(m);
    else if (m.kind === 'narration') appendNarrationBubble(m.body, m.at);
    else if (m.kind === 'voice') return; // legacy voice notes (feature removed)
    else appendTextBubble(m);
  }

  // Roleplay narration card. `raw` is the JSON payload stored in the message.
  function appendNarrationBubble(raw, at) {
    const b = chatBody();
    if (!b) return;
    let p = {};
    try { p = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (_e) { p = {}; }
    const label = p.final
      ? '🎬 The End'
      : `🎭 ${esc(p.title || 'Roleplay')} · Stage ${(p.stage || 0) + 1}/${p.total || 1}`;
    const card = el(`
      <div class="narration">
        <div class="narration-head">${label}</div>
        ${p.image ? `<img class="narration-img" src="${esc(p.image)}" loading="lazy" />` : ''}
        <div class="narration-text"></div>
        <div class="time">${fmtTime(at)}</div>
      </div>
    `);
    card.querySelector('.narration-text').textContent = p.final
      ? 'Your story is complete. Start another anytime with 🎭.'
      : (p.narration || '');
    const img = card.querySelector('.narration-img');
    if (img) img.addEventListener('click', () => openLightbox(p.image));
    b.appendChild(card);
    scrollBody();
  }

  // Populate the roleplay picker with the catalog.
  async function buildRoleplayPicker(picker) {
    picker.innerHTML = '<div class="gift-picker-title">Loading roleplays…</div>';
    let roleplays = [];
    try { roleplays = (await api.get('/api/roleplay')).roleplays || []; } catch (_e) { roleplays = []; }
    picker.innerHTML = '';
    picker.appendChild(el('<div class="gift-picker-title">Start a roleplay story</div>'));
    if (!roleplays.length) {
      picker.appendChild(el('<div class="hint" style="padding:6px 2px">No roleplays available yet. The admin can add them from the dashboard.</div>'));
      return;
    }
    const list = el('<div class="rp-list"></div>');
    roleplays.forEach((rp) => {
      const item = el(`
        <button class="rp-item" title="${esc(rp.description || rp.title)}">
          ${rp.cover ? `<img class="rp-cover" src="${esc(rp.cover)}" />` : '<span class="rp-cover rp-cover-ph">🎭</span>'}
          <span class="rp-item-body">
            <span class="rp-item-title">${esc(rp.title)}</span>
            <span class="rp-item-meta">${rp.stageCount} stage${rp.stageCount === 1 ? '' : 's'} · ${rp.requiredMessages} msgs each</span>
          </span>
        </button>
      `);
      item.addEventListener('click', () => { startRoleplay(rp.id); picker.classList.add('hidden'); });
      list.appendChild(item);
    });
    picker.appendChild(list);
  }

  function startRoleplay(roleplayId) {
    if (!state.peer || !state.socket) return;
    state.socket.emit('roleplay:start', { to: state.peer.id, roleplayId }, (res) => {
      if (res && res.error) return notify(res.error);
      // The first narration + progress arrive over the socket.
    });
  }

  function stopRoleplay() {
    if (!state.peer || !state.socket) return;
    if (!confirm('End this roleplay?')) return;
    state.socket.emit('roleplay:stop', { to: state.peer.id }, (res) => {
      if (res && res.error) return notify(res.error);
      updateRoleplayBar(null);
    });
  }

  // Render/refresh the roleplay progress banner for the open chat.
  function updateRoleplayBar(p) {
    const bar = document.getElementById('roleplayBar');
    if (!bar) return;
    if (!p || p.status !== 'active') { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    const meDone = p.myCount >= p.required;
    const peerDone = p.peerCount >= p.required;
    bar.innerHTML = `
      <div class="rp-bar-main">
        <span class="rp-bar-title">🎭 ${esc(p.title)}</span>
        <span class="rp-bar-stage">Stage ${(p.stage || 0) + 1}/${p.total}</span>
      </div>
      <div class="rp-bar-progress">
        <span class="${meDone ? 'done' : ''}">You ${Math.min(p.myCount, p.required)}/${p.required}${meDone ? ' ✓' : ''}</span>
        <span class="${peerDone ? 'done' : ''}">Partner ${Math.min(p.peerCount, p.required)}/${p.required}${peerDone ? ' ✓' : ''}</span>
      </div>
      <button class="ghost small" id="rpEnd">End</button>
    `;
    bar.classList.remove('hidden');
    const end = bar.querySelector('#rpEnd');
    if (end) end.addEventListener('click', stopRoleplay);
  }

  // m: { body: giftId, mine, at, id?, reply? }
  function appendGiftBubble(m) {
    const b = chatBody();
    if (!b) return;
    const gift = state.giftsById[m.body] || { emoji: '🎁', name: 'Gift' };
    const bubble = el(`
      <div class="bubble gift ${m.mine ? 'me' : 'them'}">
        <span class="gift-emoji">${esc(gift.emoji)}</span>
        <span class="gift-name">${m.mine ? 'You sent' : 'Sent you'} a ${esc(gift.name)}</span>
      </div>
    `);
    if (m.id) bubble.dataset.id = m.id;
    if (m.reply) bubble.insertBefore(renderQuote(m.reply), bubble.firstChild);
    // Click the emoji to replay its pop animation.
    const emoji = bubble.querySelector('.gift-emoji');
    emoji.addEventListener('click', () => replayPop(emoji));
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    attachBubbleActions(bubble, m);
    b.appendChild(bubble);
    scrollBody();
  }

  // Restart the CSS pop animation on demand (send/receive fires it once; this
  // re-triggers it on click via a forced reflow).
  function replayPop(emoji) {
    emoji.style.animation = 'none';
    void emoji.offsetWidth;
    emoji.style.animation = '';
  }

  /* ---------- reply / quote ---------- */

  function peerLabel() {
    return (state.peer && (state.peer.displayName || state.peer.username)) || 'Them';
  }

  // A short text snapshot of a message, for quoting.
  function previewTextOf(m) {
    if (m.kind === 'gift') {
      const g = state.giftsById[m.body];
      return g ? `${g.emoji} ${g.name}` : 'a gift';
    }
    return String(m.body == null ? '' : m.body).slice(0, 140);
  }

  // Render the quoted block placed at the top of a reply bubble.
  // reply: { id, mine? | from?, text }
  function renderQuote(reply) {
    const mine = reply.mine != null ? reply.mine : (reply.from === state.me.id);
    const q = el('<div class="reply-quote"><span class="rq-who"></span><span class="rq-text"></span></div>');
    q.querySelector('.rq-who').textContent = mine ? 'You' : peerLabel();
    q.querySelector('.rq-text').textContent = reply.text || '';
    if (reply.id) q.addEventListener('click', () => scrollToMessage(reply.id));
    return q;
  }

  function scrollToMessage(id) {
    const b = chatBody();
    if (!b) return;
    const target = b.querySelector(`.bubble[data-id="${id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // Hover actions (reply ↩ + react 🙂) and the reactions row. Only persisted
  // messages (with an id) can be replied to or reacted to.
  function attachBubbleActions(bubble, m) {
    if (!m || !m.id) return;
    const actions = el('<div class="bubble-actions"></div>');
    const reply = el('<button class="act-btn" title="Reply">↩</button>');
    reply.addEventListener('click', (e) => { e.stopPropagation(); startReply(m); });
    const react = el('<button class="act-btn" title="React">🙂</button>');
    react.addEventListener('click', (e) => { e.stopPropagation(); openReactionPalette(react, m.id); });
    actions.appendChild(reply);
    actions.appendChild(react);
    bubble.appendChild(actions);

    bubble._reactions = Array.isArray(m.reactions) ? m.reactions.slice() : [];
    const rc = el('<div class="reactions hidden"></div>');
    bubble.appendChild(rc);
    bubble._reactionsEl = rc;
    renderReactions(bubble);
  }

  /* ---------- emoji reactions ---------- */

  var REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👍', '😍', '🙏'];

  function sendReaction(messageId, emoji) {
    if (!state.peer || !state.socket || !messageId) return;
    state.socket.emit('chat:react', { to: state.peer.id, messageId, emoji }, (res) => {
      if (res && res.error) notify(res.error);
      // The authoritative update arrives via the 'chat:reaction' broadcast.
    });
  }

  function openReactionPalette(anchorBtn, messageId) {
    closeReactionPalette();
    const pal = el('<div class="react-palette"></div>');
    REACTION_EMOJIS.forEach((emoji) => {
      const b = el(`<button class="rp-emoji">${emoji}</button>`);
      b.addEventListener('click', (e) => { e.stopPropagation(); sendReaction(messageId, emoji); closeReactionPalette(); });
      pal.appendChild(b);
    });
    document.body.appendChild(pal);
    const r = anchorBtn.getBoundingClientRect();
    pal.style.top = Math.max(8, r.top - 46) + 'px';
    pal.style.left = Math.max(8, Math.min(window.innerWidth - pal.offsetWidth - 8, r.left - 70)) + 'px';
    state._reactPalette = pal;
    setTimeout(() => document.addEventListener('click', closeReactionPaletteOnce), 0);
  }

  function closeReactionPaletteOnce(ev) {
    if (state._reactPalette && !state._reactPalette.contains(ev.target)) closeReactionPalette();
  }

  function closeReactionPalette() {
    if (state._reactPalette) {
      state._reactPalette.remove();
      state._reactPalette = null;
      document.removeEventListener('click', closeReactionPaletteOnce);
    }
  }

  // Re-render the reaction chips under a bubble from its ._reactions list.
  function renderReactions(bubble) {
    const rc = bubble._reactionsEl;
    if (!rc) return;
    rc.innerHTML = '';
    const list = bubble._reactions || [];
    if (!list.length) { rc.classList.add('hidden'); return; }
    rc.classList.remove('hidden');
    const counts = {};
    const mine = {};
    list.forEach((r) => {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      if (r.userId === state.me.id) mine[r.emoji] = true;
    });
    Object.keys(counts).forEach((emoji) => {
      const chip = el(`<button class="reaction-chip${mine[emoji] ? ' mine' : ''}"><span>${emoji}</span><span class="rc-count">${counts[emoji]}</span></button>`);
      chip.addEventListener('click', (e) => { e.stopPropagation(); sendReaction(Number(bubble.dataset.id), emoji); });
      rc.appendChild(chip);
    });
  }

  // Apply a live reaction change (emoji === null means the user cleared it).
  function updateReaction(messageId, userId, emoji) {
    const b = chatBody();
    if (!b) return;
    const bubble = b.querySelector(`.bubble[data-id="${messageId}"]`);
    if (!bubble || !bubble._reactions) return;
    bubble._reactions = bubble._reactions.filter((r) => r.userId !== userId);
    if (emoji) bubble._reactions.push({ userId, emoji });
    renderReactions(bubble);
  }

  function startReply(m) {
    state.replyTo = { id: m.id, mine: m.mine, text: previewTextOf(m) };
    renderReplyBanner();
    const input = document.getElementById('msgInput');
    if (input) input.focus();
  }

  function cancelReply() {
    state.replyTo = null;
    renderReplyBanner();
  }

  function renderReplyBanner() {
    const banner = document.getElementById('replyBanner');
    if (!banner) return;
    if (!state.replyTo) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      return;
    }
    banner.innerHTML = '';
    const body = el('<div class="rb-body"><span class="rb-who"></span> <span class="rb-text"></span></div>');
    body.querySelector('.rb-who').textContent = 'Replying to ' + (state.replyTo.mine ? 'yourself' : peerLabel());
    body.querySelector('.rb-text').textContent = state.replyTo.text;
    const x = el('<button class="rb-cancel" title="Cancel reply">×</button>');
    x.addEventListener('click', cancelReply);
    banner.appendChild(body);
    banner.appendChild(x);
    banner.classList.remove('hidden');
  }

  // Populate the gift picker grid (lazy-loads the catalog once).
  async function buildGiftPicker(picker) {
    const gifts = await loadGifts();
    picker.innerHTML = '';
    if (!gifts.length) {
      picker.appendChild(el('<div class="hint" style="padding:10px">No gifts available.</div>'));
      return;
    }
    picker.appendChild(el('<div class="gift-picker-title">Send a naughty gift</div>'));
    const grid = el('<div class="gift-grid"></div>');
    gifts.forEach((g) => {
      const cell = el(`<button class="gift-cell" title="${esc(g.name)}"><span class="gift-emoji">${esc(g.emoji)}</span><span class="gift-cell-name">${esc(g.name)}</span></button>`);
      cell.addEventListener('click', () => {
        sendGift(g.id);
        picker.classList.add('hidden');
      });
      grid.appendChild(cell);
    });
    picker.appendChild(grid);
  }

  function sendGift(giftId) {
    if (!state.peer || !state.socket) return;
    state.socket.emit('chat:gift', { to: state.peer.id, gift: giftId }, (res) => {
      if (res && res.error) return notify(res.error);
      const m = (res && res.message) || {};
      appendGiftBubble({ body: giftId, mine: true, at: m.at || Date.now(), id: m.id });
    });
  }

  function sendMessage(input) {
    const body = input.value.trim();
    if (!body || !state.peer || !state.socket) return;
    input.value = '';
    // Capture and clear the reply target before the round-trip.
    const replyTo = state.replyTo ? state.replyTo.id : null;
    const replySnapshot = state.replyTo
      ? { id: state.replyTo.id, mine: state.replyTo.mine, text: state.replyTo.text }
      : null;
    cancelReply();
    state.socket.emit('chat:message', { to: state.peer.id, body, replyTo }, (res) => {
      if (res && res.error) return notify(res.error);
      // Echo is handled here for the sending tab.
      const m = (res && res.message) || {};
      appendTextBubble({ body, mine: true, at: m.at || Date.now(), id: m.id, reply: m.reply || replySnapshot });
    });
  }

  async function sendFile(file) {
    if (!state.peer || !state.socket) return;
    const buf = await file.arrayBuffer();
    const meta = { to: state.peer.id, name: file.name, mime: file.type || 'application/octet-stream' };
    state.socket.emit('chat:file', { ...meta, data: buf }, (res) => {
      if (res && res.error) return notify(res.error);
      const url = URL.createObjectURL(new Blob([buf], { type: meta.mime }));
      appendFileBubble({ name: file.name, mime: meta.mime, size: file.size, at: Date.now() }, true, url);
    });
  }

  function notify(text) {
    const b = chatBody();
    if (!b) return alert(text);
    b.appendChild(el(`<div class="typing" style="align-self:center;color:var(--danger)">${esc(text)}</div>`));
    scrollBody();
  }

  /* ---------- socket ---------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ withCredentials: true });
    state.socket = s;

    s.on('chat:message', (m) => {
      // Track the peer so it shows under "Chats".
      if (!state.chatPeers[m.from] && m.from !== state.me.id) rememberPeer(m.from);
      if (!state.chatPeers[m.to] && m.to !== state.me.id) rememberPeer(m.to);
      const peerId = state.peer && state.peer.id;
      const relevant = peerId && (m.from === peerId || m.to === peerId);
      if (relevant) appendMessage(m);
      else {
        // Message for a non-active conversation: flag its tab if it's open.
        const otherId = m.from === state.me.id ? m.to : m.from;
        if (state.openChats.some((p) => p.id === otherId)) {
          state.unread[otherId] = true;
          renderChatTabs();
        }
      }
      if (state.tab === 'chats') renderList();
    });

    s.on('chat:file', (meta) => {
      const peerId = state.peer && state.peer.id;
      const url = URL.createObjectURL(new Blob([meta.data], { type: meta.mime }));
      if (peerId && meta.from === peerId) {
        appendFileBubble(meta, false, url);
      } else {
        rememberPeer(meta.from);
        notifyIncomingFile(meta);
      }
    });

    s.on('chat:typing', (p) => {
      const peerId = state.peer && state.peer.id;
      if (peerId && p.from === peerId) showTyping();
    });

    // Live "what are you doing" status changes for the open conversation.
    s.on('chat:activity', (e) => {
      const peerId = state.peer && state.peer.id;
      if (!peerId) return;
      const peerName = state.peer.displayName || state.peer.username;
      if (e.from === peerId && e.to === state.me.id) {
        state.chatActivity = Object.assign({}, state.chatActivity, { theirs: e.activity || null });
        renderActivityStatus(peerName);
      } else if (e.from === state.me.id && e.to === peerId) {
        state.chatActivity = Object.assign({}, state.chatActivity, { mine: e.activity || null });
        const sel = document.getElementById('activitySelect');
        if (sel) sel.value = e.activity || '';
        renderActivityStatus(peerName);
      }
    });

    s.on('chat:reaction', (e) => {
      if (e && e.messageId != null) updateReaction(e.messageId, e.userId, e.emoji);
    });

    s.on('roleplay:progress', (p) => {
      const peerId = state.peer && state.peer.id;
      // Only update the banner when the progress is for the open conversation.
      if (peerId && p && p.peerId === peerId) updateRoleplayBar(p);
    });

    s.on('connect_error', () => { /* auth or network issue; UI still works for browsing */ });
  }

  function notifyIncomingFile(meta) {
    // Light-touch: user is chatting elsewhere. Surface a hint in the list tab.
    if (state.tab !== 'chats') renderList();
  }

  async function rememberPeer(id) {
    if (state.chatPeers[id]) return;
    const found = state.peopleCache.find((u) => u.id === id);
    if (found) { state.chatPeers[id] = found; return; }
    // Fall back to a minimal record; refine on next people load.
    state.chatPeers[id] = { id, username: 'user' + id, displayName: 'User ' + id, avatar: null };
  }

  let typingTimer;
  function showTyping() {
    const t = document.getElementById('typing');
    if (!t) return;
    t.classList.remove('hidden');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => t.classList.add('hidden'), 1500);
  }

  /* ======================================================================
     PROFILE VIEW (someone else's profile in the main pane)
  ====================================================================== */
  // A labelled detail tile with an icon, only rendered when there's a value.
  function detail(label, value, icon) {
    if (!value) return '';
    return `<div class="detail"><span class="di">${icon || ''}</span><div class="dtext"><span class="dl">${esc(label)}</span><span class="dv">${esc(value)}</span></div></div>`;
  }
  function genderIcon(g) {
    return g === 'Female' ? '♀' : g === 'Male' ? '♂' : '⚧';
  }

  // Full-screen image lightbox for gallery photos.
  function openLightbox(url) {
    const box = el(`<div class="lightbox"><img src="${url}" /><button class="lb-close" title="Close">✕</button></div>`);
    const close = () => box.remove();
    box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('lb-close')) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
    document.body.appendChild(box);
  }

  async function showProfile(username) {
    document.getElementById('shell').classList.add('viewing-main');
    const main = document.getElementById('main');
    main.innerHTML = '<div class="empty-main">Loading profile…</div>';
    let profile;
    try {
      profile = (await api.get('/api/profile/' + encodeURIComponent(username))).profile;
    } catch (e) {
      main.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`;
      return;
    }
    const isMe = profile.isMe;
    const meta = [
      profile.age != null ? profile.age + ' yrs' : null,
      profile.gender,
      profile.country,
    ].filter(Boolean).join(' · ');

    // Relationship line, with optional link to the partner's profile.
    let relLine = '';
    if (profile.relationshipStatus) {
      relLine = esc(profile.relationshipStatus);
      if (profile.partner) {
        relLine += ` with <a href="#" class="partner-link" data-u="${esc(profile.partner.username)}">${esc(profile.partner.displayName)}</a>`;
      }
    }

    const badges = [];
    if (profile.age != null) badges.push(`🎂 ${profile.age}`);
    if (profile.gender) badges.push(`${genderIcon(profile.gender)} ${esc(profile.gender)}`);
    if (profile.country) badges.push(`📍 ${esc(profile.country)}`);
    const badgesHtml = badges.map((b) => `<span class="badge">${b}</span>`).join('');

    const detailsHtml = [
      detail('Sexuality', profile.sexuality, '🌈'),
      detail('Smokes', profile.smokes, '🚬'),
      detail('Drinks', profile.drinks, '🍷'),
      detail('Diet', profile.diet, '🥗'),
      detail('In bed', profile.bedRole, '🔥'),
    ].join('');

    const score = profile.rating.average ? profile.rating.average.toFixed(1) : '—';
    const card = (icon, title, inner) =>
      `<section class="card"><h3 class="card-title">${icon} ${title}</h3>${inner}</section>`;

    const view = el(`
      <div class="profile-view pro">
        <button class="ghost small pv-back" id="pvBack">← Back</button>

        <div class="pro-hero card">
          <div class="pro-cover"></div>
          <div class="pro-hero-body">
            <div class="pro-avatar-wrap">
              <img class="pro-avatar" src="${avatarUrl(profile.avatar)}" alt="${esc(profile.displayName)}" />
            </div>
            <div class="pro-id">
              <h2 class="pro-name">${esc(profile.displayName)}</h2>
              <div class="handle">@${esc(profile.username)}</div>
              ${badgesHtml ? `<div class="pro-badges">${badgesHtml}</div>` : ''}
              ${relLine ? `<div class="rel-line">💞 ${relLine}</div>` : ''}
            </div>
            <div class="pro-rating" title="${profile.rating.count} rating${profile.rating.count === 1 ? '' : 's'}">
              <div class="pro-score">${score}</div>
              <div class="stars" id="pvStars">${starsHtml(profile.rating.average, !isMe)}</div>
              <div class="pro-rcount">${profile.rating.count} rating${profile.rating.count === 1 ? '' : 's'}</div>
              ${!isMe && profile.rating.mine ? '<button class="ghost small" id="unrate">Clear rating</button>' : ''}
            </div>
          </div>
          <div class="pro-actions pv-actions">
            ${!isMe ? '<button class="primary" id="pvChat">💬 Message</button>' : ''}
            ${!isMe ? `<span id="pvFriend"></span>` : ''}
            ${!isMe ? `<span id="pvBlock"></span>` : ''}
            ${isMe ? '<button class="ghost" id="pvEdit">✎ Edit profile</button>' : ''}
          </div>
        </div>

        <div class="pro-grid">
          <div class="pro-col-main">
            ${profile.about ? card('📝', 'About me', `<p class="rich">${esc(profile.about)}</p>`) : ''}
            ${profile.persona ? card('✨', 'What kind of person they are', `<p class="rich">${esc(profile.persona)}</p>`) : ''}
            ${profile.likesInBed ? card('🔥', 'In the bedroom', `<p class="rich">${esc(profile.likesInBed)}</p>`) : ''}
            <section class="card">
              <h3 class="card-title">📷 Gallery <span class="hint" id="galCount"></span></h3>
              <div class="gallery" id="pvGallery"></div>
            </section>
            <section class="card">
              <h3 class="card-title">💬 Comments</h3>
              <div id="pvCommentForm"></div>
              <div class="comments" id="pvComments"></div>
            </section>
          </div>
          <div class="pro-col-side">
            ${detailsHtml ? `<section class="card"><h3 class="card-title">🧬 Details</h3><div class="detail-grid">${detailsHtml}</div></section>` : ''}
            ${profile.interests.length ? card('❤️', 'Interests', `<div class="chip-row">${profile.interests.map((i) => `<span class="chip static">${esc(i)}</span>`).join('')}</div>`) : ''}
            <section class="card">
              <h3 class="card-title">👥 Friends <span class="hint">(${profile.friends.count})</span></h3>
              <div id="pvFriends"></div>
            </section>
          </div>
        </div>
      </div>
    `);
    main.innerHTML = '';
    main.appendChild(view);

    /* ----- rating interaction ----- */
    if (!isMe) {
      const starsEl = view.querySelector('#pvStars');
      const paint = (n) => starsEl.querySelectorAll('.star').forEach((s) =>
        s.classList.toggle('on', Number(s.dataset.v) <= n));
      paint(profile.rating.mine || Math.round(profile.rating.average));
      starsEl.querySelectorAll('.star').forEach((s) => {
        s.addEventListener('mouseenter', () => paint(Number(s.dataset.v)));
        s.addEventListener('click', async () => {
          try {
            const { rating } = await api.post('/api/social/rate/' + encodeURIComponent(profile.username), { stars: Number(s.dataset.v) });
            profile.rating = rating;
            showProfile(username); // refresh to reflect new average
          } catch (e) { alert(e.message); }
        });
      });
      starsEl.addEventListener('mouseleave', () => paint(profile.rating.mine || Math.round(profile.rating.average)));
      const unrate = view.querySelector('#unrate');
      if (unrate) unrate.addEventListener('click', async () => {
        try { await api.del('/api/social/rate/' + encodeURIComponent(profile.username)); showProfile(username); }
        catch (e) { alert(e.message); }
      });
    }

    /* ----- friend & block buttons ----- */
    const anyBlock = !isMe && profile.blocked && (profile.blocked.iBlocked || profile.blocked.blockedMe);
    const friendSlot = view.querySelector('#pvFriend');
    // No friend actions while a block is in place either way.
    if (friendSlot && !anyBlock) renderFriendButton(friendSlot, profile, () => showProfile(username));
    const blockSlot = view.querySelector('#pvBlock');
    if (blockSlot) renderBlockButton(blockSlot, profile, () => showProfile(username));

    /* ----- gallery ----- */
    const gal = view.querySelector('#pvGallery');
    const galCount = view.querySelector('#galCount');
    const updateCount = () => {
      const n = gal.querySelectorAll('.cell').length;
      galCount.textContent = isMe ? `(${n}/${MAX_GALLERY})` : `(${n})`;
    };
    const makeCell = (ph) => {
      const cell = el(`<div class="cell"><img src="${ph.url}" loading="lazy" /><span class="cell-zoom">⤢</span></div>`);
      cell.querySelector('img').addEventListener('click', () => openLightbox(ph.url));
      cell.querySelector('.cell-zoom').addEventListener('click', () => openLightbox(ph.url));
      if (isMe) {
        const del = el('<button class="del" title="Delete photo">✕</button>');
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm('Delete this photo?')) return;
          try { await api.del('/api/profile/gallery/' + ph.id); cell.remove(); updateCount(); refreshAddBtn(); }
          catch (e) { alert(e.message); }
        });
        cell.appendChild(del);
      }
      return cell;
    };
    if (!profile.gallery.length) gal.appendChild(el('<div class="hint">No photos yet.</div>'));
    else profile.gallery.forEach((ph) => gal.appendChild(makeCell(ph)));
    updateCount();

    let addBtn = null;
    function refreshAddBtn() {
      if (!addBtn) return;
      const full = gal.querySelectorAll('.cell').length >= MAX_GALLERY;
      addBtn.disabled = full;
      addBtn.textContent = full ? 'Gallery full (25)' : '＋ Add photo';
    }
    if (isMe) {
      addBtn = el('<button class="ghost small" id="pvAdd" style="margin-top:12px">＋ Add photo</button>');
      const fileIn = el('<input type="file" accept="image/*" class="hidden" />');
      addBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', async () => {
        if (!fileIn.files[0]) return;
        const fd = new FormData();
        fd.append('photo', fileIn.files[0]);
        try {
          const { photo } = await api.postForm('/api/profile/gallery', fd);
          const hint = gal.querySelector('.hint');
          if (hint) hint.remove();
          gal.prepend(makeCell(photo));
          updateCount();
          refreshAddBtn();
        } catch (e) { alert(e.message); }
        fileIn.value = '';
      });
      view.appendChild(fileIn);
      gal.after(addBtn);
      refreshAddBtn();
    }

    /* ----- friends list ----- */
    const friendsBox = view.querySelector('#pvFriends');
    if (!profile.friends.list.length) {
      friendsBox.appendChild(el('<div class="hint">No friends yet.</div>'));
    } else {
      const row = el('<div class="friend-row"></div>');
      profile.friends.list.forEach((f) => {
        const chip = el(`<div class="friend-chip" title="@${esc(f.username)}"><img class="avatar sm" src="${avatarUrl(f.avatar)}" /><span>${esc(f.displayName)}</span></div>`);
        chip.addEventListener('click', () => showProfile(f.username));
        row.appendChild(chip);
      });
      friendsBox.appendChild(row);
    }

    /* ----- comments ----- */
    const commentsBox = view.querySelector('#pvComments');
    const renderComment = (c) => {
      const item = el(`
        <div class="comment">
          <img class="avatar sm" src="${avatarUrl(c.author.avatar)}" />
          <div class="c-body">
            <div class="c-head"><b class="c-author" data-u="${esc(c.author.username)}">${esc(c.author.displayName)}</b> <span class="hint">${fmtDate(c.at)}</span></div>
            <div class="c-text"></div>
          </div>
        </div>
      `);
      item.querySelector('.c-text').textContent = c.body;
      item.querySelector('.c-author').addEventListener('click', () => showProfile(c.author.username));
      if (c.canDelete) {
        const del = el('<button class="ghost small">Delete</button>');
        del.addEventListener('click', async () => {
          try { await api.del('/api/social/comment/' + c.id); item.remove(); } catch (e) { alert(e.message); }
        });
        item.querySelector('.c-head').appendChild(del);
      }
      return item;
    };
    if (!profile.comments.length) commentsBox.appendChild(el('<div class="hint">No comments yet.</div>'));
    else profile.comments.forEach((c) => commentsBox.appendChild(renderComment(c)));

    if (!isMe) {
      const form = el(`
        <div class="comment-form">
          <input id="cInput" maxlength="500" placeholder="Leave a comment…" />
          <button class="primary small" id="cSend">Post</button>
        </div>
      `);
      view.querySelector('#pvCommentForm').appendChild(form);
      const input = form.querySelector('#cInput');
      const send = async () => {
        const body = input.value.trim();
        if (!body) return;
        try {
          const { comment } = await api.post('/api/social/comment/' + encodeURIComponent(profile.username), { body });
          input.value = '';
          const hint = commentsBox.querySelector('.hint');
          if (hint) hint.remove();
          commentsBox.prepend(renderComment(comment));
        } catch (e) { alert(e.message); }
      };
      form.querySelector('#cSend').addEventListener('click', send);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    }

    /* ----- misc wiring ----- */
    view.querySelectorAll('.partner-link').forEach((a) =>
      a.addEventListener('click', (ev) => { ev.preventDefault(); showProfile(a.dataset.u); }));

    view.querySelector('#pvBack').addEventListener('click', () => {
      if (state.peer) openChat(state.peer);
      else { document.getElementById('shell').classList.remove('viewing-main'); main.innerHTML = ''; }
    });
    const editBtn = view.querySelector('#pvEdit');
    if (editBtn) editBtn.addEventListener('click', () => renderProfileEditor(false));
    const chatBtn = view.querySelector('#pvChat');
    if (chatBtn) {
      if (anyBlock) {
        chatBtn.remove(); // can't message across a block
      } else {
        chatBtn.addEventListener('click', () => openChat({
          id: profile.id, username: profile.username, displayName: profile.displayName, avatar: profile.avatar,
        }));
      }
    }
  }

  // Render the contextual block/unblock control into `slot`.
  function renderBlockButton(slot, profile, refresh) {
    slot.innerHTML = '';
    const u = encodeURIComponent(profile.username);
    const act = async (fn, confirmMsg) => {
      if (confirmMsg && !confirm(confirmMsg)) return;
      try { await fn(); refreshRequestBadge(); refresh(); } catch (e) { alert(e.message); }
    };
    const b = profile.blocked || {};
    if (b.iBlocked) {
      slot.appendChild(el('<span class="pill danger-pill">🚫 Blocked</span>'));
      const btn = el('<button class="ghost small">Unblock</button>');
      btn.addEventListener('click', () => act(() => api.del('/api/social/block/' + u)));
      slot.appendChild(btn);
    } else if (b.blockedMe) {
      // They've blocked you — no actions are possible.
      slot.appendChild(el('<span class="pill">Unavailable</span>'));
    } else {
      const btn = el('<button class="ghost small">🚫 Block</button>');
      btn.addEventListener('click', () => act(
        () => api.post('/api/social/block/' + u),
        'Block @' + profile.username + '? This removes any friendship and stops all messages and gifts between you.'
      ));
      slot.appendChild(btn);
    }
  }

  // Render the contextual friend action button into `slot` based on state.
  function renderFriendButton(slot, profile, refresh) {
    slot.innerHTML = '';
    const u = encodeURIComponent(profile.username);
    const act = async (fn) => { try { await fn(); refreshRequestBadge(); refresh(); } catch (e) { alert(e.message); } };
    const btn = (label, cls, handler) => {
      const b = el(`<button class="${cls} small">${esc(label)}</button>`);
      b.addEventListener('click', () => act(handler));
      return b;
    };
    switch (profile.friends.state) {
      case 'friends':
        slot.appendChild(el('<span class="pill">✓ Friends</span>'));
        slot.appendChild(btn('Unfriend', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      case 'outgoing':
        slot.appendChild(el('<span class="pill">Request sent</span>'));
        slot.appendChild(btn('Cancel', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      case 'incoming':
        slot.appendChild(btn('Accept request', 'primary', () => api.post('/api/social/friend/' + u + '/accept')));
        slot.appendChild(btn('Decline', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      default:
        slot.appendChild(btn('Add friend', 'ghost', () => api.post('/api/social/friend/' + u)));
    }
  }

  /* ======================================================================
     EXPLORE SECTIONS (Quizzes / Polls / Blogs / Leaderboard / Events)
  ====================================================================== */

  // Prepare the main pane for a full-width section and return its element.
  function openMainView() {
    document.getElementById('shell').classList.add('viewing-main');
    state.peer = null;
    const main = document.getElementById('main');
    main.innerHTML = '';
    return main;
  }

  function sectionShell(title, subtitle) {
    return el(`
      <div class="section-view">
        <div class="section-head">
          <h1 class="section-h1">${esc(title)}</h1>
          ${subtitle ? `<p class="hint">${esc(subtitle)}</p>` : ''}
        </div>
        <div class="section-body" id="sectionBody"><div class="empty-main">Loading…</div></div>
      </div>
    `);
  }

  // A compact friend-action control for use in lists (leaderboard/events/requests).
  // `fstate` is one of self|friends|incoming|outgoing|none. Returns null for self.
  function friendButtonEl(username, fstate, refresh) {
    const u = encodeURIComponent(username);
    const act = async (fn) => { try { await fn(); refreshRequestBadge(); refresh(); } catch (e) { alert(e.message); } };
    const btn = (label, cls, handler) => {
      const b = el(`<button class="${cls} small">${esc(label)}</button>`);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); act(handler); });
      return b;
    };
    switch (fstate) {
      case 'self': return null;
      case 'friends': return el('<span class="pill friend-pill">✓ Friends</span>');
      case 'outgoing': return btn('Cancel request', 'ghost', () => api.del('/api/social/friend/' + u));
      case 'incoming': return btn('Accept request', 'primary', () => api.post('/api/social/friend/' + u + '/accept'));
      default: return btn('＋ Add friend', 'primary', () => api.post('/api/social/friend/' + u));
    }
  }

  function openExplore(view) {
    if (view === 'requests') return renderRequests();
    if (view === 'quizzes') return renderQuizzes();
    if (view === 'polls') return renderPolls();
    if (view === 'blogs') return renderBlogs();
    if (view === 'leaderboard') return renderLeaderboard();
    if (view === 'events') return renderEvents();
  }

  /* ---------- Friend requests ---------- */
  async function renderRequests() {
    const main = openMainView();
    main.appendChild(sectionShell('Friend Requests', 'People who want to connect with you. View their profile, then accept or decline.'));
    const body = main.querySelector('#sectionBody');
    let data;
    try { data = await api.get('/api/social/friends'); }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }

    const incoming = data.incoming || [];
    const outgoing = data.outgoing || [];
    refreshRequestBadge();

    body.innerHTML = '';

    // ---- Incoming (received) ----
    const inWrap = el(`<div class="card"><h3 class="card-title">📥 Received <span class="hint">(${incoming.length})</span></h3><div class="req-list" id="reqIn"></div></div>`);
    const inBox = inWrap.querySelector('#reqIn');
    if (!incoming.length) {
      inBox.appendChild(el('<div class="hint">No pending friend requests right now.</div>'));
    } else {
      incoming.forEach((u) => {
        const row = el(`
          <div class="req-row">
            <img class="avatar sm" src="${avatarUrl(u.avatar)}" />
            <div class="req-id">
              <div class="name">${esc(u.displayName || u.username)}</div>
              <div class="handle">@${esc(u.username)}</div>
            </div>
            <div class="req-actions">
              <button class="ghost small req-view">View profile</button>
              <button class="primary small req-accept">Accept</button>
              <button class="ghost small req-decline">Decline</button>
            </div>
          </div>
        `);
        const u2 = encodeURIComponent(u.username);
        row.querySelector('.req-id').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.avatar').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.req-view').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.req-accept').addEventListener('click', async () => {
          try { await api.post('/api/social/friend/' + u2 + '/accept'); renderRequests(); }
          catch (e) { alert(e.message); }
        });
        row.querySelector('.req-decline').addEventListener('click', async () => {
          try { await api.del('/api/social/friend/' + u2); renderRequests(); }
          catch (e) { alert(e.message); }
        });
        inBox.appendChild(row);
      });
    }
    body.appendChild(inWrap);

    // ---- Outgoing (sent) ----
    const outWrap = el(`<div class="card"><h3 class="card-title">📤 Sent <span class="hint">(${outgoing.length})</span></h3><div class="req-list" id="reqOut"></div></div>`);
    const outBox = outWrap.querySelector('#reqOut');
    if (!outgoing.length) {
      outBox.appendChild(el('<div class="hint">You haven\'t sent any pending requests.</div>'));
    } else {
      outgoing.forEach((u) => {
        const row = el(`
          <div class="req-row">
            <img class="avatar sm" src="${avatarUrl(u.avatar)}" />
            <div class="req-id">
              <div class="name">${esc(u.displayName || u.username)}</div>
              <div class="handle">@${esc(u.username)}</div>
            </div>
            <div class="req-actions">
              <button class="ghost small req-view">View profile</button>
              <span class="pill">Pending…</span>
              <button class="ghost small req-cancel">Cancel</button>
            </div>
          </div>
        `);
        const u2 = encodeURIComponent(u.username);
        row.querySelector('.req-id').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.avatar').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.req-view').addEventListener('click', () => showProfile(u.username));
        row.querySelector('.req-cancel').addEventListener('click', async () => {
          try { await api.del('/api/social/friend/' + u2); renderRequests(); }
          catch (e) { alert(e.message); }
        });
        outBox.appendChild(row);
      });
    }
    body.appendChild(outWrap);
  }

  /* ---------- Quizzes (compatibility matching) ---------- */
  async function renderQuizzes() {
    const main = openMainView();
    main.appendChild(sectionShell('Compatibility Quizzes', 'Answer a quiz, then share your link — see how well you match.'));
    const body = main.querySelector('#sectionBody');
    let quizzes;
    try { quizzes = (await api.get('/api/content/quizzes')).quizzes; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!quizzes.length) { body.innerHTML = '<div class="empty-main">No quizzes yet. Check back soon!</div>'; return; }
    body.innerHTML = '';
    const grid = el('<div class="card-grid"></div>');
    quizzes.forEach((q) => {
      const card = el(`
        <div class="tile">
          <h3>${esc(q.title)}</h3>
          <p class="rich">${esc(q.description || '')}</p>
          <div class="tile-meta">
            <span class="pill">${q.questionCount} question${q.questionCount === 1 ? '' : 's'}</span>
            <span class="pill">${q.matches} match${q.matches === 1 ? '' : 'es'}</span>
          </div>
          <button class="primary small" data-take="${q.id}">Start & share →</button>
        </div>
      `);
      card.querySelector('[data-take]').addEventListener('click', () => openQuiz(q.id));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  async function openQuiz(id) {
    const main = openMainView();
    main.appendChild(sectionShell('Quiz', ''));
    const body = main.querySelector('#sectionBody');
    let quiz;
    try { quiz = (await api.get('/api/content/quizzes/' + id)).quiz; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    main.querySelector('.section-h1').textContent = quiz.title;
    const sub = main.querySelector('.section-head');
    if (quiz.description) sub.appendChild(el(`<p class="hint">${esc(quiz.description)}</p>`));

    body.innerHTML = '';
    const form = el('<div class="quiz-form card"></div>');
    form.appendChild(el('<p class="hint">Pick the answer that fits you for each question. When you finish you\'ll get a private link to send to someone — your match score is revealed once they answer too.</p>'));
    quiz.questions.forEach((qq, qi) => {
      const block = el(`<div class="quiz-q"><div class="quiz-prompt">${qi + 1}. ${esc(qq.prompt)}</div></div>`);
      qq.options.forEach((opt, oi) => {
        const optEl = el(`<label class="quiz-opt"><input type="radio" name="q${qi}" value="${oi}" /> <span>${esc(opt)}</span></label>`);
        block.appendChild(optEl);
      });
      form.appendChild(block);
    });
    const actions = el('<div class="row-actions"></div>');
    const submit = el('<button class="primary">Get my share link</button>');
    const back = el('<button class="ghost">Back to quizzes</button>');
    back.addEventListener('click', renderQuizzes);
    actions.appendChild(submit); actions.appendChild(back);
    form.appendChild(actions);
    const result = el('<div class="msg" id="quizResult"></div>');
    form.appendChild(result);
    const share = el('<div class="share-box" hidden></div>');
    form.appendChild(share);
    body.appendChild(form);

    submit.addEventListener('click', async () => {
      const answers = quiz.questions.map((_q, qi) => {
        const sel = form.querySelector(`input[name="q${qi}"]:checked`);
        return sel ? Number(sel.value) : -1;
      });
      if (answers.some((a) => a < 0)) {
        result.className = 'msg error';
        result.textContent = 'Please answer every question first.';
        return;
      }
      submit.disabled = true;
      try {
        const out = await api.post('/api/content/quizzes/' + id + '/match', { answers });
        result.className = 'msg ok';
        result.textContent = 'Your answers are locked in. Share this link — it stays active for 1 hour.';
        renderShareBox(share, out.token);
        form.querySelectorAll('input[type=radio]').forEach((r) => { r.disabled = true; });
      } catch (e) {
        submit.disabled = false;
        result.className = 'msg error';
        result.textContent = e.message;
      }
    });
  }

  // Render the shareable link + copy / WhatsApp / Telegram buttons.
  function renderShareBox(host, token) {
    const link = location.origin + '/m/' + token;
    const text = 'Take this compatibility quiz with me — let\'s see how well we match! ' + link;
    host.hidden = false;
    host.innerHTML = `
      <label class="share-label">Your private link</label>
      <div class="share-row">
        <a class="share-input share-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a>
        <button type="button" class="primary small" data-copy>Copy</button>
      </div>
      <div class="share-actions">
        <a class="chip-btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">WhatsApp</a>
        <a class="chip-btn tg" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Take this compatibility quiz with me!')}">Telegram</a>
        <a class="chip-btn" target="_blank" rel="noopener" href="${esc(link)}">Open link</a>
      </div>
      <p class="hint">Once your friend answers, reopen this link to see your compatibility score.</p>
    `;
    const copyBtn = host.querySelector('[data-copy]');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch (_e) {
        const ta = document.createElement('textarea');
        ta.value = link; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_e2) { /* ignore */ }
        ta.remove();
      }
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
  }

  /* ---------- Polls ---------- */
  async function renderPolls() {
    const main = openMainView();
    main.appendChild(sectionShell('Polls', 'Cast your vote and see what the community thinks.'));
    const body = main.querySelector('#sectionBody');
    let polls;
    try { polls = (await api.get('/api/content/polls')).polls; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!polls.length) { body.innerHTML = '<div class="empty-main">No polls yet.</div>'; return; }
    body.innerHTML = '';
    polls.forEach((p) => body.appendChild(pollCard(p)));
  }

  function pollCard(p) {
    const card = el(`<div class="tile poll-card"><h3>${esc(p.question)}</h3>${p.closed ? '<span class="pill">Closed</span>' : ''}<div class="poll-opts"></div></div>`);
    const optsBox = card.querySelector('.poll-opts');
    const render = (poll) => {
      optsBox.innerHTML = '';
      poll.options.forEach((opt, oi) => {
        const count = poll.counts[oi] || 0;
        const pct = poll.total ? Math.round((count / poll.total) * 100) : 0;
        const mine = poll.myVote === oi;
        const row = el(`
          <div class="poll-opt${mine ? ' mine' : ''}" data-i="${oi}">
            <div class="poll-bar" style="width:${pct}%"></div>
            <span class="poll-label">${esc(opt)}${mine ? ' ✓' : ''}</span>
            <span class="poll-pct">${pct}% · ${count}</span>
          </div>
        `);
        if (!poll.closed) {
          row.style.cursor = 'pointer';
          row.addEventListener('click', async () => {
            try { const out = await api.post('/api/content/polls/' + poll.id + '/vote', { option: oi }); render(out.poll); }
            catch (e) { alert(e.message); }
          });
        }
        optsBox.appendChild(row);
      });
      optsBox.appendChild(el(`<div class="hint" style="margin-top:8px">${poll.total} vote${poll.total === 1 ? '' : 's'}</div>`));
    };
    render(p);
    return card;
  }

  /* ---------- Blogs ---------- */
  async function renderBlogs() {
    const main = openMainView();
    main.appendChild(sectionShell('Blogs', 'Stories, tips and news from getxmatch.'));
    const body = main.querySelector('#sectionBody');
    let blogs;
    try { blogs = (await api.get('/api/content/blogs')).blogs; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!blogs.length) { body.innerHTML = '<div class="empty-main">No blog posts yet.</div>'; return; }
    body.innerHTML = '';
    const grid = el('<div class="card-grid"></div>');
    blogs.forEach((b) => {
      const card = el(`
        <div class="tile blog-card">
          ${b.cover ? `<img class="blog-cover" src="${esc(b.cover)}" loading="lazy" />` : ''}
          <h3>${esc(b.title)}</h3>
          <div class="hint">By ${esc(b.author)} · ${fmtDate(b.createdAt)}</div>
          <p class="rich">${esc(b.excerpt || '')}</p>
          <button class="ghost small" data-read="${b.id}">Read more →</button>
        </div>
      `);
      card.querySelector('[data-read]').addEventListener('click', () => openBlog(b.id));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  async function openBlog(id) {
    const main = openMainView();
    main.appendChild(sectionShell('Blog', ''));
    const body = main.querySelector('#sectionBody');
    let blog;
    try { blog = (await api.get('/api/content/blogs/' + id)).blog; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    main.querySelector('.section-h1').textContent = blog.title;
    body.innerHTML = '';
    const article = el(`
      <article class="card blog-full">
        ${blog.cover ? `<img class="blog-cover-full" src="${esc(blog.cover)}" />` : ''}
        <div class="hint">By ${esc(blog.author)} · ${fmtDate(blog.createdAt)}</div>
        <div class="blog-body rich"></div>
        <div class="row-actions"><button class="ghost" id="blogBack">← Back to blogs</button></div>
      </article>
    `);
    article.querySelector('.blog-body').textContent = blog.body;
    article.querySelector('#blogBack').addEventListener('click', renderBlogs);
    body.appendChild(article);
  }

  /* ---------- Leaderboard ---------- */
  async function renderLeaderboard() {
    const main = openMainView();
    main.appendChild(sectionShell('Leaderboard', 'Top members by ratings, friends and activity. Send a friend request to anyone.'));
    const body = main.querySelector('#sectionBody');
    let rows;
    try { rows = (await api.get('/api/leaderboard')).leaderboard; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!rows.length) { body.innerHTML = '<div class="empty-main">No ranked members yet.</div>'; return; }
    body.innerHTML = '';
    const list = el('<div class="lb-list card"></div>');
    rows.forEach((r) => {
      const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`;
      const row = el(`
        <div class="lb-row${r.isMe ? ' me' : ''}">
          <div class="lb-rank">${medal}</div>
          <img class="avatar sm" src="${avatarUrl(r.avatar)}" />
          <div class="lb-id">
            <div class="name">${esc(r.displayName)}${r.isMe ? ' <span class="pill">you</span>' : ''}</div>
            <div class="handle">@${esc(r.username)}${r.country ? ' · ' + esc(r.country) : ''}</div>
          </div>
          <div class="lb-stats">
            <span title="Average rating">⭐ ${r.ratingAvg || '—'}</span>
            <span title="Friends">👥 ${r.friends}</span>
            <span title="Quizzes">🧠 ${r.quizzes}</span>
            <span class="lb-score" title="Score">${r.score}</span>
          </div>
          <div class="lb-action"></div>
        </div>
      `);
      row.querySelector('.lb-id').addEventListener('click', () => showProfile(r.username));
      row.querySelector('.avatar').addEventListener('click', () => showProfile(r.username));
      const fb = friendButtonEl(r.username, r.friendState, renderLeaderboard);
      if (fb) row.querySelector('.lb-action').appendChild(fb);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  /* ---------- Recent Activity ---------- */

  // Build one feed row. `live` items (streamed fake activity) show "just now".
  function feedItemEl(ev, live) {
    const item = el(`
      <div class="feed-item${live ? ' feed-new' : ''}">
        <div class="feed-icon">${ev.icon || '•'}</div>
        <div class="feed-main">
          ${ev.type === 'admin' && ev.title ? '<div class="feed-title"></div>' : ''}
          <div class="feed-text"></div>
          <div class="feed-time hint">${live ? 'just now' : `${fmtDate(ev.at)} · ${fmtTime(ev.at)}`}</div>
        </div>
      </div>
    `);
    if (ev.type === 'admin' && ev.title) item.querySelector('.feed-title').textContent = ev.title;
    item.querySelector('.feed-text').textContent = ev.text;
    return item;
  }

  // Shared recent-activity renderer. Deliberately non-interactive: names are
  // plain text (no profile links, no friend buttons), so members can't act on
  // each other from the feed. Real activity and admin "fake" activity are shown
  // the same way. Used both in the sidebar (compact) and on the activity page.
  async function renderActivityInto(container, opts) {
    opts = opts || {};
    container.innerHTML = '<div class="hint" style="padding:16px">Loading activity…</div>';
    let events;
    try { events = (await api.get('/api/events')).events; }
    catch (e) { container.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!events.length) { container.innerHTML = '<div class="empty-main">Nothing happening yet.</div>'; return; }
    const feed = el(`<div class="${opts.compact ? 'activity-side' : 'feed card'}"></div>`);
    events.forEach((ev) => feed.appendChild(feedItemEl(ev, false)));
    container.innerHTML = '';
    container.appendChild(feed);
    registerActivityFeed(feed);
  }

  /* ---- live fake-activity ticker: streams new combinations every 2–15s ---- */
  const activityFeeds = []; // { feed } for each mounted feed element
  let fakeTicker = null;

  function fakeIcon(activity) {
    const a = String(activity).toLowerCase();
    if (/(chat|messag|talk)/.test(a)) return '💬';
    if (/(flirt|crush|love|kiss)/.test(a)) return '😍';
    if (/(match|paired|connect)/.test(a)) return '💘';
    if (/(rat|star|review)/.test(a)) return '⭐';
    if (/(gift|sent)/.test(a)) return '🎁';
    if (/(view|check|look|profile)/.test(a)) return '👀';
    if (/(friend|follow)/.test(a)) return '🤝';
    return '✨';
  }

  async function loadFakePool() {
    if (state.fakePool) return state.fakePool;
    try { state.fakePool = await api.get('/api/events/fake-pool'); }
    catch (_e) { state.fakePool = { enabled: false, females: [], males: [], activities: [] }; }
    return state.fakePool;
  }

  function registerActivityFeed(feed) {
    activityFeeds.push(feed);
    ensureFakeTicker();
  }

  function ensureFakeTicker() {
    if (fakeTicker) return;
    const schedule = () => { fakeTicker = setTimeout(tick, 2000 + Math.random() * 13000); }; // 2–15s
    const tick = async () => {
      // Drop feeds that are no longer on the page.
      for (let i = activityFeeds.length - 1; i >= 0; i--) {
        if (!document.body.contains(activityFeeds[i])) activityFeeds.splice(i, 1);
      }
      if (!activityFeeds.length) { fakeTicker = null; return; } // stops; restarts on next render
      const pool = await loadFakePool();
      if (pool.enabled && pool.females.length && pool.males.length) {
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
        // Activity is optional; fall back to a neutral connector when none set.
        const verbs = pool.activities.length ? pool.activities : ['and'];
        const act = pick(verbs);
        const f = pick(pool.females);
        const m = pick(pool.males);
        // Randomly order the pair: female→male or male→female.
        const text = Math.random() < 0.5 ? `${f} ${act} ${m}` : `${m} ${act} ${f}`;
        const ev = { type: 'fake', icon: fakeIcon(act), at: Date.now(), text };
        activityFeeds.forEach((feed) => {
          feed.insertBefore(feedItemEl(ev, true), feed.firstChild);
          while (feed.children.length > 60) feed.removeChild(feed.lastChild);
        });
      }
      schedule();
    };
    schedule();
  }

  async function renderEvents() {
    const main = openMainView();
    main.appendChild(sectionShell('Recent Activity', 'What members are up to right now.'));
    await renderActivityInto(main.querySelector('#sectionBody'), { compact: false });
  }

  boot();
})();
