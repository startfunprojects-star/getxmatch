/* getxmatch SPA */
(function () {
  'use strict';

  const root = document.getElementById('app');
  const state = {
    me: null,
    socket: null,
    tab: 'people',       // 'people' | 'chats'
    peer: null,          // active chat peer
    peopleCache: [],
    chatPeers: {},       // id -> peer summary for people we've chatted with
    typingTimer: null,
  };

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
  async function boot() {
    try {
      const { user, hasProfile } = await api.get('/api/auth/me');
      state.me = user;
      if (!hasProfile) return renderProfileEditor(true);
      return enterApp();
    } catch (e) {
      return renderAuth();
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
          <div class="search"><input id="searchInput" placeholder="Search people…" /></div>
          <div class="list" id="list"></div>
        </aside>
        <section class="main" id="main">
          <div class="empty-main">
            <div>
              <div style="font-size:40px">💬</div>
              <p>Pick someone from <b>People</b> to start chatting.</p>
              <p class="hint">Shared files are delivered live and never stored on the server.</p>
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
        renderList();
      });
    });

    let searchDebounce;
    shell.querySelector('#searchInput').addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderList, 200);
    });

    connectSocket();
    renderList();
  }

  /* ---------- sidebar list ---------- */
  async function renderList() {
    const listEl = document.getElementById('list');
    if (!listEl) return;
    const q = (document.getElementById('searchInput').value || '').trim();

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
  async function openChat(peer) {
    state.peer = peer;
    state.chatPeers[peer.id] = peer;
    document.querySelectorAll('.list-item').forEach((r) =>
      r.classList.toggle('active', Number(r.dataset.id) === peer.id));
    document.getElementById('shell').classList.add('viewing-main');

    const main = document.getElementById('main');
    main.innerHTML = '';
    const view = el(`
      <div class="chat-wrap">
        <div class="chat-head">
          <button class="icon-btn small" id="backToList" title="Back">←</button>
          <img class="avatar sm" id="peerAvatar" src="${avatarUrl(peer.avatar)}" style="cursor:pointer" />
          <div style="min-width:0">
            <div class="name" id="peerName" style="cursor:pointer">${esc(peer.displayName || peer.username)}</div>
            <div class="status">@${esc(peer.username)}</div>
          </div>
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="typing hidden" id="typing">typing…</div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="attachBtn" title="Share a file (delivered live, never stored)">📎</button>
          <input type="text" id="msgInput" placeholder="Type a message…" autocomplete="off" />
          <button class="primary" id="sendBtn">Send</button>
        </div>
      </div>
    `);
    main.appendChild(view);

    view.querySelector('#backToList').addEventListener('click', () => {
      document.getElementById('shell').classList.remove('viewing-main');
      state.peer = null;
    });
    const openPeerProfile = () => showProfile(peer.username);
    view.querySelector('#peerAvatar').addEventListener('click', openPeerProfile);
    view.querySelector('#peerName').addEventListener('click', openPeerProfile);

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

    // Load persisted text history.
    try {
      const { messages } = await api.get(`/api/users/${peer.id}/messages`);
      messages.forEach((m) => appendTextBubble(m.body, m.mine, m.at));
    } catch (_e) {}
    scrollBody();
  }

  function chatBody() { return document.getElementById('chatBody'); }
  function scrollBody() { const b = chatBody(); if (b) b.scrollTop = b.scrollHeight; }

  function appendTextBubble(body, mine, at) {
    const b = chatBody();
    if (!b) return;
    const bubble = el(`<div class="bubble ${mine ? 'me' : 'them'}"></div>`);
    bubble.appendChild(document.createTextNode(body));
    bubble.appendChild(el(`<span class="time">${fmtTime(at)}</span>`));
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

  function sendMessage(input) {
    const body = input.value.trim();
    if (!body || !state.peer || !state.socket) return;
    input.value = '';
    state.socket.emit('chat:message', { to: state.peer.id, body }, (res) => {
      if (res && res.error) return notify(res.error);
      // Echo is handled here for the sending tab.
      appendTextBubble(body, true, (res && res.message && res.message.at) || Date.now());
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
      if (relevant) appendTextBubble(m.body, m.mine, m.at);
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

    /* ----- friend button ----- */
    const friendSlot = view.querySelector('#pvFriend');
    if (friendSlot) renderFriendButton(friendSlot, profile, () => showProfile(username));

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
    if (chatBtn) chatBtn.addEventListener('click', () => openChat({
      id: profile.id, username: profile.username, displayName: profile.displayName, avatar: profile.avatar,
    }));
  }

  // Render the contextual friend action button into `slot` based on state.
  function renderFriendButton(slot, profile, refresh) {
    slot.innerHTML = '';
    const u = encodeURIComponent(profile.username);
    const act = async (fn) => { try { await fn(); refresh(); } catch (e) { alert(e.message); } };
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

  boot();
})();
