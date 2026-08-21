/* getxmatch SPA */
(function () {
  'use strict';

  const root = document.getElementById('app');
  const state = {
    me: null,
    socket: null,
    tab: 'people',       // 'people' | 'chats'
    peer: null,          // active 1-on-1 chat peer
    group: null,         // active group chat ({ gid, name, members, … }) or null
    openChats: [],       // ordered list of open chat tabs (peers + group entries)
    unread: {},          // peerId -> true when a background tab has new messages
    activities: null,    // cached list of chat activity verbs (column 2)
    chatActivity: null,  // { mine, theirs } for the open conversation
    peopleCache: [],
    chatPeers: {},       // id -> peer summary for people we've chatted with
    typingTimer: null,
    gifts: null,         // naughty-gift catalog, loaded lazily
    giftsById: {},       // id -> gift for rendering
    liveByPeer: {},      // otherUserId -> broadcast view when a chat of mine is live
    watching: null,      // token of a broadcast being watched inline, or null
    disappearing: 0,     // disappearing-messages TTL (seconds) for the open chat; 0 = off
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

  /* ================= Advertisements =================
     Ads are fetched once and rendered into named placement slots. Image ads are
     click-tracked via a redirect; script ads run inside a sandboxed same-origin
     iframe so ad-network code can't touch the page, cookies or user data. */
  const AD_PLACEMENTS = 'content_header,content_footer,content_sidebar_left,content_sidebar_right,content_inline,highway_header,highway_footer,highway_inline,chat_inline,live_inline';
  const adState = { slots: null, promise: null, counters: {} };

  async function loadAds() {
    if (adState.slots) return adState.slots;
    if (!adState.promise) {
      adState.promise = api.get('/api/ads/slots?placements=' + AD_PLACEMENTS)
        .then((r) => { adState.slots = r.slots || {}; return adState.slots; })
        .catch(() => { adState.slots = {}; return adState.slots; });
    }
    return adState.promise;
  }
  function adsFor(placement) { return (adState.slots && adState.slots[placement]) || []; }
  function pickAd(placement, index) {
    const list = adsFor(placement);
    if (!list.length) return null;
    return Number.isInteger(index) ? list[index % list.length] : list[Math.floor(Math.random() * list.length)];
  }
  // Build a DOM node for one ad, or null.
  function adEl(ad) {
    if (!ad) return null;
    const slot = el('<aside class="ad-slot" aria-label="Advertisement"><span class="ad-label">Advertisement</span></aside>');
    slot.classList.add('ad-' + ad.placement);
    if (ad.type === 'image' && ad.image) {
      const a = el('<a class="ad-image" target="_blank" rel="nofollow sponsored noopener"></a>');
      a.href = ad.clickUrl;
      const img = el('<img alt="Advertisement" loading="lazy" />');
      img.src = ad.image;
      a.appendChild(img);
      slot.appendChild(a);
    } else if (ad.type === 'script' && ad.frameUrl) {
      const f = document.createElement('iframe');
      f.className = 'ad-frame'; f.src = ad.frameUrl; f.title = 'Advertisement';
      f.loading = 'lazy'; f.scrolling = 'no';
      f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms');
      f.style.cssText = (ad.width ? 'width:' + ad.width + 'px;' : 'width:100%;') + 'height:' + (ad.height || 250) + 'px;border:0;display:block;margin:0 auto;';
      slot.appendChild(f);
    } else { return null; }
    return slot;
  }
  function slotEl(placement, index) { return adEl(pickAd(placement, index)); }

  // Decorate a content section (quizzes/polls/blogs) with header/footer/inline
  // ads and left/right sidebar rails (wide screens only). Safe no-op when no
  // ads are configured for a slot.
  async function decorateSectionWithAds(main) {
    try { await loadAds(); } catch (_e) { return; }
    const view = main.querySelector('.section-view');
    const body = main.querySelector('#sectionBody');
    if (!view || !body) return;

    const header = slotEl('content_header');
    if (header) body.insertBefore(header, body.firstChild);
    const footer = slotEl('content_footer');
    if (footer) body.appendChild(footer);

    // Inline ads between items (after every 4th), for both the card grid
    // (quizzes/blogs) and the plain body list (polls).
    const grid = body.querySelector('.card-grid') || body;
    const inGrid = grid.classList && grid.classList.contains('card-grid');
    const items = Array.from(grid.children).filter((c) => !c.classList.contains('ad-slot'));
    let inserted = 0;
    items.forEach((item, i) => {
      if ((i + 1) % 4 === 0 && i < items.length - 1) {
        const ad = slotEl('content_inline', inserted++);
        if (ad) { if (inGrid) ad.classList.add('ad-inline-row'); grid.insertBefore(ad, item.nextSibling); }
      }
    });

    // Sidebar rails — wrap the head+body into a centre column, add rails around.
    const left = slotEl('content_sidebar_left');
    const right = slotEl('content_sidebar_right');
    if (left || right) {
      const head = view.querySelector('.section-head');
      const col = document.createElement('div');
      col.className = 'section-col';
      view.insertBefore(col, head || body);
      if (head) col.appendChild(head);
      col.appendChild(body);
      if (left) { const r = el('<div class="section-rail"></div>'); r.appendChild(left); view.insertBefore(r, col); }
      if (right) { const r = el('<div class="section-rail"></div>'); r.appendChild(right); view.appendChild(r); }
      view.classList.add('has-ad-rails');
    }
  }

  // Insert an ad into a running list (chat / activity) after every `every`
  // items. `counterKey` scopes the running count; container is the list element.
  function maybeInsertStreamAd(container, placement, counterKey, every) {
    if (!container) return;
    adState.counters[counterKey] = (adState.counters[counterKey] || 0) + 1;
    if (adState.counters[counterKey] % every !== 0) return;
    if (!adState.slots) { loadAds().then(() => insertStreamAd(container, placement, counterKey, every)); return; }
    insertStreamAd(container, placement, counterKey, every);
  }
  function insertStreamAd(container, placement, counterKey, every) {
    const idx = Math.floor((adState.counters[counterKey] || every) / every) - 1;
    const ad = slotEl(placement, idx);
    if (ad) { ad.classList.add('ad-stream'); container.appendChild(ad); }
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

  // Relationship-request kinds (mirror src/relationships.js). Order matches spec.
  const REL_TYPES = {
    friend:     { label: 'Friends',    emoji: '🤝', requestLabel: 'Send Friend Request' },
    girlfriend: { label: 'Girlfriend', emoji: '💖', requestLabel: 'Be My Girlfriend' },
    boyfriend:  { label: 'Boyfriend',  emoji: '💙', requestLabel: 'Be My Boyfriend' },
    wife:       { label: 'Wife',       emoji: '💍', requestLabel: 'Be My Wife' },
    husband:    { label: 'Husband',    emoji: '💍', requestLabel: 'Be My Husband' },
    crush:      { label: 'Crush',      emoji: '💘', requestLabel: 'Crush' },
    colleague:  { label: 'Colleagues', emoji: '💼', requestLabel: 'Colleagues' },
  };
  const REL_ORDER = ['friend', 'girlfriend', 'boyfriend', 'wife', 'husband', 'crush', 'colleague'];
  function relLabel(type) { const t = REL_TYPES[type] || REL_TYPES.friend; return `${t.emoji} ${t.label}`; }

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
      <div class="auth-split">
        <aside class="auth-activity">
          <nav class="auth-nav" aria-label="Explore">
            <a href="/highway">Highway</a>
            <a href="/quizzes">Quizzes</a>
            <a href="/polls">Polls</a>
            <a href="/blog">Blog</a>
            <a href="/how-it-works">How it works</a>
          </nav>
          <div class="auth-activity-head">✨ Live activity on get<span class="x">x</span>match</div>
          <div class="auth-activity-feed" id="authFeed"></div>
        </aside>
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
      </div>
    `);
    root.appendChild(card);
    renderAuthActivity(card.querySelector('#authFeed'));

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

  // Left column of the sign-in page: a public, text-only activity feed (the
  // shared server stream + announcements). Never shows uploaded images/GIFs or
  // real members. The sign-in page has no socket, so it polls the public feed
  // to stay live — the stream itself is generated on the server, so every
  // visitor sees the same rows updating continuously.
  async function renderAuthActivity(container) {
    if (!container) return;
    container.innerHTML = '<div class="hint" style="padding:16px">Loading activity…</div>';
    let events = [];
    try { events = (await api.get('/api/events/public')).events || []; } catch (_e) { /* ignore */ }
    events = events.filter((e) => !e.image); // no image posts here
    if (!container.isConnected) return;
    if (!events.length) {
      container.innerHTML = '<div class="hint" style="padding:16px">Join to see what members are up to.</div>';
      return;
    }
    try { await loadAds(); } catch (_e) { /* ads are optional */ }
    const feed = el('<div class="feed"></div>');
    events.forEach((ev, i) => {
      feed.appendChild(feedItemEl(ev, false));
      // Advertisement after every 15 activity items.
      if ((i + 1) % 15 === 0 && i < events.length - 1) {
        const ad = slotEl('live_inline', Math.floor(i / 15));
        if (ad) { ad.classList.add('ad-stream'); feed.appendChild(ad); }
      }
    });
    container.innerHTML = '';
    container.appendChild(feed);
    const sinceAt = Math.max(0, ...events.map((e) => e.at || 0));
    startAuthActivityPoll(feed, sinceAt); // live via polling (no socket here)
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
            <button data-tab="chats">Chats<span class="ndot"></span></button>
          </div>
          <div class="explore-nav" id="exploreNav">
            <button data-view="highway">🌊 Highway</button>
            <button data-view="requests">🔔 Requests <span class="req-badge hidden" id="reqBadge">0</span></button>
            <button data-view="quizzes">🧠 Quizzes</button>
            <button data-view="polls">📊 Polls</button>
            <button data-view="blogs">📝 Blogs</button>
            <button data-view="leaderboard">🏆 Leaderboard<span class="ndot"></span></button>
            <button data-view="live">🔴 Live<span class="ndot"></span></button>
            <button data-view="events">✨ Recent Activity</button>
          </div>
          <div class="search"><input id="searchInput" placeholder="Search people…" /></div>
          <div class="list" id="list"></div>
        </aside>
        <section class="main" id="main"></section>
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
        if (b.dataset.tab === 'chats') markNav('chats', false); // seen — stop blinking
        renderList();
      });
    });

    shell.querySelectorAll('#exploreNav button').forEach((b) => {
      b.addEventListener('click', () => {
        shell.querySelectorAll('#exploreNav button').forEach((x) => x.classList.toggle('active', x === b));
        markNav(b.dataset.view, false); // opening a section clears its indicator
        openExplore(b.dataset.view);
      });
    });

    let searchDebounce;
    shell.querySelector('#searchInput').addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderList, 200);
    });

    connectSocket();
    syncMyBroadcasts(); // restore live banner for any broadcast I'm already in
    renderList();
    renderMainHome(); // chat box shows the recent-activity feed by default
    refreshRequestBadge();
    loadGifts(); // preload so live gifts render with the right emoji/name

    // Honor a "chat with X" deep link from a shared quiz result page.
    if (pendingChatUser) {
      const u = pendingChatUser;
      pendingChatUser = null;
      openChatByUsername(u);
    }
  }

  // Update the sidebar "Requests" badge with the number of incoming requests
  // (pending friend requests + group invites). When that count grows — and the
  // Requests view isn't already open — blink the button to draw attention.
  let lastReqCount = null;
  async function refreshRequestBadge() {
    const badge = document.getElementById('reqBadge');
    if (!badge) return;
    try {
      const [{ incoming }, groups] = await Promise.all([
        api.get('/api/social/friends'),
        api.get('/api/groups').catch(() => ({ invites: [] })),
      ]);
      const n = (incoming || []).length + ((groups && groups.invites) || []).length;
      badge.textContent = n;
      badge.classList.toggle('hidden', n === 0);
      if (lastReqCount !== null && n > lastReqCount && !isExploreActive('requests')) {
        markNav('requests', true);
      }
      lastReqCount = n;
    } catch (_e) { /* ignore */ }
  }

  // Toggle the live "new activity" indicator (pulsing glow + dot) on a sidebar
  // nav button. kind: 'chats' | 'requests' | 'leaderboard'. Cleared when the
  // user opens that section.
  function markNav(kind, on) {
    const sel = kind === 'chats'
      ? '.nav button[data-tab="chats"]'
      : `#exploreNav button[data-view="${kind}"]`;
    const btn = document.querySelector(sel);
    if (btn) btn.classList.toggle('has-notif', !!on);
  }
  // Whether the given explore view is the one currently on screen.
  function isExploreActive(view) {
    const btn = document.querySelector(`#exploreNav button[data-view="${view}"]`);
    return !!(btn && btn.classList.contains('active'));
  }

  /* ---------- sidebar list ---------- */
  async function renderList() {
    const listEl = document.getElementById('list');
    if (!listEl) return;
    const q = (document.getElementById('searchInput').value || '').trim();

    // People tab with no search term → show my friends / relationships list.
    // Searching still surfaces real, clickable users to chat.
    if (state.tab === 'people' && !q) {
      return renderFriendsList(listEl);
    }

    let items = [];
    let groups = [];
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
      try { groups = (await api.get('/api/groups')).groups || []; } catch (_e) { groups = []; }
      if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
    }

    listEl.innerHTML = '';
    if (!items.length && !groups.length) {
      listEl.appendChild(el(`<div style="padding:20px;color:var(--muted)">${state.tab === 'people' ? 'No people found yet.' : 'No conversations yet.'}</div>`));
      return;
    }
    // Group chats first (Chats tab only).
    groups.forEach((g) => {
      const joined = (g.members || []).filter((m) => m.status === 'joined');
      const row = el(`
        <div class="list-item" data-id="g${g.id}">
          <div class="list-gicon">👥</div>
          <div style="min-width:0">
            <div class="name">${esc(g.name)}</div>
            <div class="handle">${joined.length}/${g.max} members</div>
          </div>
        </div>
      `);
      if (state.group && state.group.gid === g.id) row.classList.add('active');
      row.addEventListener('click', () => openGroup(g.id));
      listEl.appendChild(row);
    });
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

  // Sidebar default (People tab, no search): my accepted friends / relationships.
  // Each opens a chat when clicked. Search still finds anyone to message.
  async function renderFriendsList(listEl) {
    let friends = [];
    try { friends = (await api.get('/api/social/friends')).friends || []; }
    catch (_e) { /* fall through to empty state */ }
    if (!document.body.contains(listEl)) return; // navigated away while loading

    listEl.innerHTML = '';
    if (!friends.length) {
      listEl.appendChild(el(
        `<div style="padding:20px;color:var(--muted)">No friends yet.<br><span class="hint">Search above to find people, open a chat, and send a friend request.</span></div>`
      ));
      return;
    }
    friends.forEach((u) => {
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
  // Render the row of open-chat tabs at the top of the chat pane. The first tab
  // is always "✨ Activity" (the recent-activity home), then one tab per open
  // conversation — so chats open as new tabs beside the activity feed.
  function renderChatTabs() {
    const bar = document.getElementById('chatTabs');
    if (!bar) return;
    bar.innerHTML = '';

    const homeTab = el(`
      <div class="chat-tab home-tab${state.peer ? '' : ' active'}">
        <span class="chat-tab-name">✨ Activity</span>
      </div>`);
    homeTab.addEventListener('click', () => { if (state.peer) renderMainHome(true); });
    bar.appendChild(homeTab);

    state.openChats.forEach((p) => {
      const active = tabIsActive(p);
      const label = p.isGroup ? p.name : (p.displayName || p.username);
      const icon = p.isGroup
        ? '<span class="chat-tab-gicon">👥</span>'
        : `<img class="avatar xs" src="${avatarUrl(p.avatar)}" />`;
      const tab = el(`
        <div class="chat-tab${active ? ' active' : ''}${state.unread[p.id] ? ' unread' : ''}" data-id="${esc(String(p.id))}">
          ${icon}
          <span class="chat-tab-name">${esc(label)}</span>
          <button class="chat-tab-close" title="Close">✕</button>
        </div>
      `);
      tab.addEventListener('click', (e) => {
        if (e.target.classList.contains('chat-tab-close')) return;
        if (!active) openTab(p);
      });
      tab.querySelector('.chat-tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closeChatTab(p.id);
      });
      bar.appendChild(tab);
    });
  }

  // Is this open-chat entry the one currently shown?
  function tabIsActive(p) {
    if (p.isGroup) return !!(state.group && ('g' + state.group.gid) === p.id);
    return !!(state.peer && state.peer.id === p.id);
  }

  // Open an entry from the tab bar (a peer or a group).
  function openTab(p) {
    if (p.isGroup) return openGroup(p.gid);
    return openChat(p);
  }

  /* ======================================================================
     GROUP CHATS (2–4 members, invite + accept)
  ====================================================================== */

  // Minimal centered modal. `bodyHtml` fills the card; returns { card, close }.
  function openModal(title, bodyHtml) {
    const overlay = el(`
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn small modal-x" title="Close">✕</button></div>
          <div class="modal-body">${bodyHtml}</div>
        </div>
      </div>`);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.modal-x').addEventListener('click', close);
    document.body.appendChild(overlay);
    return { card: overlay.querySelector('.modal-card'), close };
  }

  // Register a group as an open tab and remember its current shape.
  function registerGroupTab(group) {
    const id = 'g' + group.gid;
    const entry = { isGroup: true, id, gid: group.gid, name: group.name };
    const i = state.openChats.findIndex((p) => p.id === id);
    if (i === -1) state.openChats.push(entry); else state.openChats[i] = entry;
  }

  // "👥 Group" from a 1-on-1 chat: pick connections to start a group with. The
  // current peer is included by default. Up to 3 others (4 total incl. me).
  async function openGroupCreator(peer) {
    let friends = [];
    try { friends = (await api.get('/api/social/friends')).friends || []; } catch (_e) {}
    const rows = friends.map((f) => {
      const pre = peer && f.id === peer.id;
      return `<label class="pick-row"><input type="checkbox" value="${esc(f.username)}"${pre ? ' checked' : ''}/> <img class="avatar sm" src="${avatarUrl(f.avatar)}"/> <span>${esc(f.displayName || f.username)}</span></label>`;
    }).join('');
    const { card, close } = openModal('New group chat', `
      <p class="hint">Pick up to 3 people to add (4 in the group, including you). They'll get an invite and join once they accept.</p>
      <div class="pick-list">${rows || '<div class="hint">You have no connections yet. Add friends first.</div>'}</div>
      <div class="msg" id="gcMsg"></div>
      <div class="row-actions"><button class="primary" id="gcCreate">Create group</button></div>
    `);
    const msg = card.querySelector('#gcMsg');
    card.querySelector('#gcCreate').addEventListener('click', async () => {
      const invite = Array.from(card.querySelectorAll('.pick-list input:checked')).map((c) => c.value);
      msg.className = 'msg';
      if (!invite.length) { msg.className = 'msg error'; msg.textContent = 'Pick at least one person.'; return; }
      if (invite.length > 3) { msg.className = 'msg error'; msg.textContent = 'A group can have at most 4 people (pick up to 3).'; return; }
      try {
        const { group } = await api.post('/api/groups', { invite });
        close();
        openGroup(group.id);
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  // Add more people to an existing group (up to the cap).
  async function openGroupAdder(group) {
    let friends = [];
    try { friends = (await api.get('/api/social/friends')).friends || []; } catch (_e) {}
    const inGroup = new Set((group.members || []).map((m) => m.id));
    const candidates = friends.filter((f) => !inGroup.has(f.id));
    const rows = candidates.map((f) =>
      `<label class="pick-row"><input type="radio" name="addpick" value="${esc(f.username)}"/> <img class="avatar sm" src="${avatarUrl(f.avatar)}"/> <span>${esc(f.displayName || f.username)}</span></label>`
    ).join('');
    const full = (group.members || []).length >= (group.max || 4);
    const { card, close } = openModal('Add to group', `
      ${full ? '<p class="msg error" style="display:block">This group is full (max 4).</p>' : ''}
      <div class="pick-list">${rows || '<div class="hint">No more connections to add.</div>'}</div>
      <div class="msg" id="gaMsg"></div>
      <div class="row-actions"><button class="primary" id="gaAdd"${full ? ' disabled' : ''}>Send invite</button></div>
    `);
    const msg = card.querySelector('#gaMsg');
    card.querySelector('#gaAdd').addEventListener('click', async () => {
      const picked = card.querySelector('.pick-list input:checked');
      msg.className = 'msg';
      if (!picked) { msg.className = 'msg error'; msg.textContent = 'Pick someone to add.'; return; }
      try {
        await api.post('/api/groups/' + group.gid + '/invite', { username: picked.value });
        close();
        openGroup(group.gid); // refresh the header/members
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
    });
  }

  // Open (and render) a group chat.
  async function openGroup(gid) {
    let group, messages = [];
    try { group = (await api.get('/api/groups/' + gid)).group; }
    catch (e) { return notify(e.message); }
    try { messages = (await api.get('/api/groups/' + gid + '/messages')).messages || []; } catch (_e) {}

    stopWatching(); // leaving any inline broadcast we were watching
    state.peer = null;
    state.group = { gid, name: group.name, members: group.members, max: group.max };
    closeReactionPalette();
    registerGroupTab({ gid, name: group.name });
    document.querySelectorAll('.list-item').forEach((r) => r.classList.remove('active'));
    document.getElementById('shell').classList.add('viewing-main');

    const joined = group.members.filter((m) => m.status === 'joined');
    const pending = group.members.filter((m) => m.status === 'invited');
    const main = document.getElementById('main');
    main.innerHTML = '';
    const view = el(`
      <div class="chat-wrap">
        <div class="chat-tabs" id="chatTabs"></div>
        <div class="chat-head">
          <button class="icon-btn small" id="backToList" title="Back">←</button>
          <div class="group-avatars">${joined.map((m) => `<img class="avatar sm" src="${avatarUrl(m.avatar)}" title="${esc(m.displayName)}"/>`).join('')}</div>
          <div style="min-width:0;flex:1">
            <div class="name">${esc(group.name)}</div>
            <div class="status">${joined.length}/${group.max} member${joined.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} invited` : ''}</div>
          </div>
          <button class="ghost small" id="groupAddBtn" title="Add someone">＋ Add</button>
          <button class="ghost small" id="groupLeaveBtn" title="Leave this group">Leave</button>
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="composer">
          <input type="text" id="msgInput" placeholder="Message the group…" autocomplete="off" />
          <button class="primary" id="sendBtn">Send</button>
        </div>
      </div>
    `);
    main.appendChild(view);
    renderChatTabs();

    view.querySelector('#backToList').addEventListener('click', () => {
      document.getElementById('shell').classList.remove('viewing-main');
      state.group = null;
    });
    view.querySelector('#groupAddBtn').addEventListener('click', () => openGroupAdder(state.group));
    view.querySelector('#groupLeaveBtn').addEventListener('click', async () => {
      if (!confirm('Leave this group chat?')) return;
      try { await api.post('/api/groups/' + gid + '/leave', {}); } catch (e) { return notify(e.message); }
      closeChatTab('g' + gid);
    });

    const input = view.querySelector('#msgInput');
    const send = () => sendGroupMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    messages.forEach(appendGroupMessage);
    scrollBody();
  }

  function sendGroupMessage(input) {
    const body = input.value.trim();
    if (!body || !state.socket || !state.group) return;
    const gid = state.group.gid;
    input.value = '';
    state.socket.emit('group:message', { groupId: gid, body }, (res) => {
      if (res && res.error) { notify(res.error); input.value = body; }
    });
  }

  // Render a group message bubble. Others' messages show the sender's name.
  function appendGroupMessage(m) {
    const b = chatBody();
    if (!b) return;
    const bubble = el(`<div class="bubble ${m.mine ? 'me' : 'them'}"></div>`);
    if (!m.mine) bubble.appendChild(el(`<div class="bubble-author">${esc(m.fromName)}</div>`));
    appendRichText(bubble, m.body);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    b.appendChild(bubble);
    scrollBody();
  }

  function closeChatTab(id) {
    const idx = state.openChats.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const wasActive = tabIsActive(state.openChats[idx]);
    state.openChats.splice(idx, 1);
    delete state.unread[id];
    if (!wasActive) { renderChatTabs(); return; }
    const next = state.openChats[idx] || state.openChats[idx - 1];
    if (next) return openTab(next);
    renderMainHome(); // no chats left → back to the recent-activity home
  }

  // Render the "home" of the chat box: the tab bar (Activity + any open chats)
  // above a full recent-activity feed. This is what every user sees by default
  // and whenever no conversation is selected. `focusMain` shows the main pane on
  // mobile (used when returning here from a chat or the sidebar).
  function renderMainHome(focusMain) {
    const main = document.getElementById('main');
    if (!main) return;
    stopWatching(); // leaving any inline broadcast we were watching
    state.peer = null;
    closeReactionPalette();
    if (focusMain) document.getElementById('shell').classList.add('viewing-main');
    document.querySelectorAll('.list-item').forEach((r) => r.classList.remove('active'));
    main.innerHTML = `
      <div class="chat-wrap">
        <div class="chat-tabs" id="chatTabs"></div>
        <div class="home-activity">
          <div class="activity-share">
            <button class="ghost small" id="activityShareBtn" type="button">🖼️ Share an image / GIF</button>
            <input type="file" id="activityImgInput" accept="image/*" class="hidden" />
            <span class="hint" id="activityShareMsg"></span>
          </div>
          <div id="homeFeed"></div>
        </div>
      </div>`;
    renderChatTabs();
    wireActivityShare();
    renderActivityInto(document.getElementById('homeFeed'), { compact: false });
  }

  // Max size for an image/GIF shared onto Recent Activity (matches the server).
  const ACTIVITY_IMG_MAX_BYTES = 5 * 1024 * 1024;

  // Validate + upload an image/GIF to the Recent Activity feed. `onStatus(text,
  // isError)` reports progress. On success the server broadcasts an activity:new
  // event that inserts the thumbnail live, so callers don't insert it themselves.
  // Returns true on success. Shared by the activity home and the chat status bar.
  async function shareActivityImage(file, onStatus) {
    onStatus = onStatus || function () {};
    if (!file) return false;
    if (!/^image\//.test(file.type)) { onStatus('Please choose an image or GIF.', true); return false; }
    if (file.size > ACTIVITY_IMG_MAX_BYTES) { onStatus('Image must be 5 MB or smaller.', true); return false; }
    onStatus('Uploading…', false);
    const fd = new FormData();
    fd.append('image', file);
    try {
      await api.postForm('/api/events/activity-image', fd);
      onStatus('Shared!', false);
      return true;
    } catch (e) {
      onStatus(e.message, true);
      return false;
    }
  }

  // Wire the "Share an image / GIF" control on the activity home.
  function wireActivityShare() {
    const btn = document.getElementById('activityShareBtn');
    const input = document.getElementById('activityImgInput');
    const msg = document.getElementById('activityShareMsg');
    if (!btn || !input) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      btn.disabled = true;
      await shareActivityImage(file, (text, isError) => {
        msg.className = isError ? 'hint error' : 'hint';
        msg.textContent = text;
        if (!isError && text === 'Shared!') setTimeout(() => { if (msg) msg.textContent = ''; }, 2500);
      });
      input.value = '';
      btn.disabled = false;
    });
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

  const CUSTOM_ACT = '__custom__'; // sentinel option value: "write your own"

  // Reflect the user's own current activity into the picker: a predefined verb
  // selects its option; anything else is shown in the custom text box. Reads the
  // live DOM so it works from both the picker and the cross-tab sync handler.
  function reflectMineActivity(activity) {
    const select = document.getElementById('activitySelect');
    const custom = document.getElementById('activityCustom');
    if (!select || !custom) return;
    const list = state.activities || [];
    if (activity && !list.includes(activity)) {
      select.value = CUSTOM_ACT;
      custom.value = activity;
      custom.classList.remove('hidden');
    } else {
      select.value = activity || '';
      custom.value = '';
      custom.classList.add('hidden');
    }
  }

  async function setupActivityBar(view, peer) {
    const bar = view.querySelector('#activityBar');
    const select = view.querySelector('#activitySelect');
    const custom = view.querySelector('#activityCustom');
    const activities = await loadActivities();
    if (!state.peer || state.peer.id !== peer.id || !document.body.contains(select)) return;

    // Predefined verbs (if any) plus an always-available "write your own" entry.
    select.innerHTML = '<option value="">— nothing —</option>' +
      activities.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('') +
      `<option value="${CUSTOM_ACT}">✍️ Custom…</option>`;
    bar.classList.remove('hidden');

    // Share an image / GIF (to Recent Activity) straight from the chat status bar.
    const imgBtn = view.querySelector('#activityImgBtn');
    const imgFile = view.querySelector('#activityImgFile');
    if (imgBtn && imgFile) {
      imgBtn.addEventListener('click', () => imgFile.click());
      imgFile.addEventListener('change', async () => {
        const file = imgFile.files[0];
        if (!file) return;
        imgBtn.disabled = true;
        const ok = await shareActivityImage(file, (text, isError) => {
          if (isError || text === 'Shared!') notify(isError ? text : 'Shared to Recent Activity.');
        });
        imgFile.value = '';
        imgBtn.disabled = false;
        void ok;
      });
    }

    state.chatActivity = { mine: null, theirs: null };
    try {
      const st = await api.get('/api/social/chat-activity/' + peer.id);
      if (state.peer && state.peer.id === peer.id) state.chatActivity = { mine: st.mine, theirs: st.theirs };
    } catch (_e) { /* ignore */ }

    const peerName = peer.displayName || peer.username;
    const send = (activity) => {
      if (!state.socket) return;
      state.socket.emit('chat:activity', { to: peer.id, activity }, (res) => {
        if (res && res.error) return notify(res.error);
        const mine = (res && res.activity) || null;
        state.chatActivity = Object.assign({}, state.chatActivity, { mine });
        reflectMineActivity(mine);
        renderActivityStatus(peerName);
      });
    };

    reflectMineActivity(state.chatActivity.mine || '');
    renderActivityStatus(peerName);

    select.addEventListener('change', () => {
      if (select.value === CUSTOM_ACT) {
        custom.classList.remove('hidden');
        custom.focus();
        return; // wait for the user to type + commit
      }
      custom.classList.add('hidden');
      custom.value = '';
      send(select.value); // a predefined verb, or "" to clear
    });

    // Commit on Enter or blur. An abandoned (empty) box restores the current
    // state rather than clearing — use "— nothing —" to clear on purpose.
    let suppressBlur = false;
    const commitCustom = () => {
      if (suppressBlur) { suppressBlur = false; return; }
      const v = custom.value.trim();
      if (!v) return reflectMineActivity(state.chatActivity.mine || '');
      send(v);
    };
    custom.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); custom.blur(); } // blur commits
      else if (e.key === 'Escape') { suppressBlur = true; reflectMineActivity(state.chatActivity.mine || ''); custom.blur(); }
    });
    custom.addEventListener('blur', commitCustom);
  }

  async function openChat(peer) {
    stopWatching(); // leaving any inline broadcast we were watching
    state.peer = peer;
    state.group = null; // leaving any group view
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
          <div style="min-width:0;flex:1">
            <div class="name" id="peerName" style="cursor:pointer">${esc(peer.displayName || peer.username)}</div>
            <div class="status">@${esc(peer.username)}</div>
          </div>
          <button class="ghost small" id="disappearBtn" title="Disappearing messages">⏳ Vanish</button>
          <button class="ghost small" id="broadcastBtn" title="Broadcast this chat live — anyone can watch and comment">🔴 Broadcast</button>
          <button class="ghost small" id="makeGroupBtn" title="Start a group chat with this person and others">👥 Group</button>
        </div>
        <div class="disappear-banner hidden" id="disappearBanner"></div>
        <div class="live-banner hidden" id="liveBanner"></div>
        <div class="chat-activity-bar hidden" id="activityBar">
          <div class="activity-status" id="activityStatus"></div>
          <button class="icon-btn small" id="activityImgBtn" type="button" title="Share an image / GIF to Recent Activity (max 5 MB)">🖼️</button>
          <input type="file" id="activityImgFile" accept="image/*" class="hidden" />
          <label class="activity-pick">
            <span>You're…</span>
            <select id="activitySelect"><option value="">— nothing —</option></select>
            <input id="activityCustom" class="hidden" type="text" maxlength="40" placeholder="type your own…" />
          </label>
        </div>
        <div class="chat-stage">
          <div class="chat-body" id="chatBody"></div>
          <div class="fly-layer" id="chatFlyLayer"></div>
        </div>
        <div class="typing hidden" id="typing">typing…</div>
        <div class="roleplay-bar hidden" id="roleplayBar"></div>
        <div class="gift-picker hidden" id="giftPicker"></div>
        <div class="rp-picker hidden" id="rpPicker"></div>
        <div class="reply-banner hidden" id="replyBanner"></div>
        <div class="voice-recorder hidden" id="voiceRecorder"></div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="attachBtn" title="Share a file (delivered live, never stored)">📎</button>
          <button class="icon-btn" id="giftBtn" title="Send a naughty gift">🎁</button>
          <button class="icon-btn" id="rpBtn" title="Start a roleplay story">🎭</button>
          <button class="icon-btn" id="voiceBtn" title="Record a voice note">🎤</button>
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
    view.querySelector('#makeGroupBtn').addEventListener('click', () => openGroupCreator(peer));
    view.querySelector('#broadcastBtn').addEventListener('click', () => toggleBroadcast(peer));
    view.querySelector('#disappearBtn').addEventListener('click', () => promptDisappearing(peer));
    view.querySelector('#voiceBtn').addEventListener('click', () => toggleVoiceRecorder(peer));

    // Best-effort protection: block copy / context-menu / drag inside the chat
    // so messages, images, files and voice notes can't be trivially saved.
    hardenChat(view.querySelector('.chat-wrap') || view);

    // If this conversation is already being broadcast, show its live banner.
    reflectBroadcast(peer.id);

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
    adState.counters.chat = 0; // restart the every-20-messages ad cadence per chat
    state.disappearing = 0;
    try {
      const { messages, disappearing } = await api.get(`/api/users/${peer.id}/messages`);
      state.disappearing = disappearing || 0;
      messages.forEach((m) => appendMessage(m));
    } catch (_e) {}
    updateDisappearBanner();
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
    if (m.expiresAt) scheduleExpiry(bubble, m.expiresAt);
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
      img.draggable = false;
      img.addEventListener('contextmenu', (e) => e.preventDefault());
      bubble.appendChild(img);
    }
    // No download link: files are view-only. A non-anchor label keeps the name
    // and size without a browser "Save as…" affordance.
    bubble.appendChild(el(`<span class="file">📄 ${esc(meta.name)} (${fmtSize(meta.size)})</span>`));
    bubble.appendChild(el(`<span class="ephemeral-note">Shared live · view-only · not stored</span>`));
    bubble.appendChild(el(`<span class="time">${fmtTime(meta.at || Date.now())}</span>`));
    b.appendChild(bubble);
    // Files aren't persisted, so honour disappearing purely on the client: drop
    // the bubble after the conversation's TTL (both sides run the same timer).
    if (state.disappearing > 0) scheduleExpiry(bubble, Date.now() + state.disappearing * 1000);
    scrollBody();
  }

  // Route a message object (from history or live) to the right bubble.
  function appendMessage(m) {
    if (m.kind === 'gift') appendGiftBubble(m);
    else if (m.kind === 'narration') appendNarrationBubble(m.body, m.at);
    else if (m.kind === 'voice') appendVoiceBubble(m);
    else appendTextBubble(m);
    // Advertisement after every 20 exchanged messages (text + gifts + voice).
    if (m.kind !== 'narration') {
      maybeInsertStreamAd(chatBody(), 'chat_inline', 'chat', 20);
    }
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
    if (m.expiresAt) scheduleExpiry(bubble, m.expiresAt);
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
      appendGiftBubble({ body: giftId, mine: true, at: m.at || Date.now(), id: m.id, expiresAt: m.expiresAt });
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
      appendTextBubble({ body, mine: true, at: m.at || Date.now(), id: m.id, reply: m.reply || replySnapshot, expiresAt: m.expiresAt });
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

  /* ---------- disappearing messages ---------- */

  // Human-friendly rendering of a seconds TTL (e.g. 90 -> "1m 30s").
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  // Presets offered in the disappearing-messages dialog (label + seconds).
  var DISAPPEAR_PRESETS = [
    { label: 'Off', seconds: 0 },
    { label: '5s', seconds: 5 },
    { label: '10s', seconds: 10 },
    { label: '30s', seconds: 30 },
    { label: '1 min', seconds: 60 },
    { label: '5 min', seconds: 300 },
    { label: '1 hour', seconds: 3600 },
  ];

  // Commit a chosen TTL for this conversation.
  function setDisappearing(peer, seconds) {
    if (!state.socket || !peer) return;
    state.socket.emit('chat:disappearing', { to: peer.id, seconds }, (res) => {
      if (res && res.error) return notify(res.error);
      applyDisappearing(res && typeof res.seconds === 'number' ? res.seconds : seconds);
    });
  }

  // Open a centered modal to pick the self-destruct timer. Replaces the old
  // browser prompt() with preset chips + a custom seconds field and a preview.
  function promptDisappearing(peer) {
    if (!state.socket || !peer) return;
    closeDisappearModal();
    const current = state.disappearing || 0;

    const overlay = el('<div class="modal-overlay" id="disappearModal"></div>');
    const card = el(`
      <div class="modal-card disappear-modal" role="dialog" aria-modal="true" aria-label="Disappearing messages">
        <button class="modal-x" title="Close">×</button>
        <div class="dm-icon">⏳</div>
        <h3 class="dm-title">Disappearing messages</h3>
        <p class="dm-sub">New messages, files and voice notes vanish for <strong>both of you</strong> after the time you choose.</p>
        <div class="dm-presets"></div>
        <div class="dm-custom">
          <label for="dmCustom">Custom (seconds)</label>
          <input id="dmCustom" type="number" min="0" max="86400" step="1" placeholder="e.g. 45" />
        </div>
        <div class="dm-preview" id="dmPreview"></div>
        <div class="dm-actions">
          <button class="ghost" id="dmCancel">Cancel</button>
          <button class="primary" id="dmApply">Apply</button>
        </div>
      </div>
    `);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Live selection state (starts at the current value).
    let chosen = current;
    const presetsWrap = card.querySelector('.dm-presets');
    const customInput = card.querySelector('#dmCustom');
    const preview = card.querySelector('#dmPreview');

    const renderPreview = () => {
      preview.innerHTML = chosen > 0
        ? `🔥 Messages will self-destruct <strong>${esc(fmtDuration(chosen))}</strong> after they're sent.`
        : '♾️ Messages will stay until deleted (disappearing off).';
      Array.from(presetsWrap.children).forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.sec) === chosen);
      });
    };

    DISAPPEAR_PRESETS.forEach((p) => {
      const btn = el(`<button class="dm-chip" data-sec="${p.seconds}">${esc(p.label)}</button>`);
      btn.addEventListener('click', () => { chosen = p.seconds; customInput.value = p.seconds ? String(p.seconds) : ''; renderPreview(); });
      presetsWrap.appendChild(btn);
    });
    customInput.addEventListener('input', () => {
      const v = Math.max(0, Math.min(86400, Math.floor(Number(customInput.value) || 0)));
      chosen = v;
      renderPreview();
    });
    if (current > 0) customInput.value = String(current);
    renderPreview();

    const close = () => closeDisappearModal();
    card.querySelector('.modal-x').addEventListener('click', close);
    card.querySelector('#dmCancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', disappearEscHandler);
    card.querySelector('#dmApply').addEventListener('click', () => {
      // Enforce the server's 5s floor client-side for a clear message.
      let s = chosen;
      if (s > 0 && s < 5) s = 5;
      setDisappearing(peer, s);
      close();
    });
    setTimeout(() => customInput.focus(), 30);
  }

  function disappearEscHandler(e) { if (e.key === 'Escape') closeDisappearModal(); }

  function closeDisappearModal() {
    const m = document.getElementById('disappearModal');
    if (m) m.remove();
    document.removeEventListener('keydown', disappearEscHandler);
  }

  // Set the current TTL and refresh the banner/button (called locally and from
  // the socket broadcast so both participants stay in sync).
  function applyDisappearing(seconds) {
    state.disappearing = Math.max(0, Math.floor(Number(seconds) || 0));
    updateDisappearBanner();
  }

  function updateDisappearBanner() {
    const banner = document.getElementById('disappearBanner');
    const btn = document.getElementById('disappearBtn');
    const on = (state.disappearing || 0) > 0;
    if (btn) btn.classList.toggle('active', on);
    if (!banner) return;
    if (!on) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
    banner.innerHTML =
      `<span class="db-dot"></span><span>Disappearing messages are ON — new messages vanish after ` +
      `<strong>${esc(fmtDuration(state.disappearing))}</strong>.</span>` +
      `<button class="db-off" id="disappearOff">Turn off</button>`;
    banner.classList.remove('hidden');
    const off = banner.querySelector('#disappearOff');
    if (off && state.peer) {
      off.addEventListener('click', () => {
        state.socket.emit('chat:disappearing', { to: state.peer.id, seconds: 0 }, (res) => {
          if (res && res.error) return notify(res.error);
          applyDisappearing(0);
        });
      });
    }
  }

  // Schedule the local removal of a disappearing bubble and show a live
  // countdown pill on it. Server-side sweeping is authoritative; this keeps the
  // sender's/receiver's view tidy in real time.
  function scheduleExpiry(node, expiresAt) {
    if (!node || !expiresAt) return;
    const pill = el('<span class="expire-pill" title="Disappearing message">⏳ <span class="ep-t"></span></span>');
    node.appendChild(pill);
    node.classList.add('disappearing');
    const tEl = pill.querySelector('.ep-t');
    const tick = () => {
      const left = expiresAt - Date.now();
      if (left <= 0) {
        node.classList.add('vanish');
        setTimeout(() => node.remove(), 420);
        clearInterval(timer);
        return;
      }
      tEl.textContent = fmtDuration(left / 1000);
    };
    tick();
    const timer = setInterval(tick, 1000);
    node._expiryTimer = timer;
  }

  // Remove a bubble (by persisted id) with the vanish animation — driven by the
  // server's 'chat:expire' sweep.
  function expireMessages(ids) {
    const b = chatBody();
    if (!b || !Array.isArray(ids)) return;
    ids.forEach((id) => {
      const node = b.querySelector(`.bubble[data-id="${id}"], .voice-msg[data-id="${id}"]`);
      if (!node) return;
      if (node._expiryTimer) clearInterval(node._expiryTimer);
      node.classList.add('vanish');
      setTimeout(() => node.remove(), 420);
    });
  }

  /* ---------- sophisticated voice notes (raw PCM → WAV) ----------
     We capture raw PCM via Web Audio and encode a 16-bit mono WAV rather than
     leaning on MediaRecorder's opus/webm output, which some browsers decode
     back as noise. WAV is unambiguous and plays cleanly everywhere. 16 kHz mono
     is ideal for speech and keeps files small. */

  var voiceRec = null;
  const VOICE_SAMPLE_RATE = 16000;

  function toggleVoiceRecorder(peer) {
    const box = document.getElementById('voiceRecorder');
    if (!box) return;
    if (voiceRec) { cancelVoiceRecorder(); return; }
    startVoiceRecorder(peer, box);
  }

  async function startVoiceRecorder(peer, box) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC) {
      return notify('Voice notes are not supported by this browser.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_e) {
      return notify('Microphone permission is required for voice notes.');
    }

    const audioCtx = new AC();
    try { await audioCtx.resume(); } catch (_e) {}
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    // Capture raw PCM through a ScriptProcessor. A zero-gain sink keeps it
    // pumping without routing the mic to the speakers (which would feed back).
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;

    const rec = {
      stream, audioCtx, source, analyser, processor, mute,
      chunks: [], length: 0, startedAt: Date.now(), peer, raf: null,
    };
    voiceRec = rec;

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      rec.chunks.push(new Float32Array(input)); // copy — the buffer is reused
      rec.length += input.length;
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(audioCtx.destination);

    box.innerHTML =
      '<span class="vr-dot"></span>' +
      '<span class="vr-time" id="vrTime">0:00</span>' +
      '<canvas class="vr-wave" id="vrWave" width="220" height="34"></canvas>' +
      '<button class="vr-btn vr-cancel" id="vrCancel" title="Cancel">✕</button>' +
      '<button class="vr-btn vr-send" id="vrSend" title="Send voice note">Send ➤</button>';
    box.classList.remove('hidden');
    box.querySelector('#vrCancel').addEventListener('click', cancelVoiceRecorder);
    box.querySelector('#vrSend').addEventListener('click', finishVoiceRecorder);

    const timeEl = box.querySelector('#vrTime');
    const canvas = box.querySelector('#vrWave');
    const ctx = canvas.getContext('2d');
    const wf = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      rec.raf = requestAnimationFrame(draw);
      const secs = (Date.now() - rec.startedAt) / 1000;
      timeEl.textContent = Math.floor(secs / 60) + ':' + String(Math.floor(secs % 60)).padStart(2, '0');
      if (secs >= 120) { finishVoiceRecorder(); return; } // auto-stop at 2 min
      analyser.getByteTimeDomainData(wf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#ff4d7d').trim();
      ctx.strokeStyle = accent || '#ff4d7d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = canvas.width / wf.length;
      for (let i = 0; i < wf.length; i++) {
        const v = (wf[i] - 128) / 128;
        const y = canvas.height / 2 + v * (canvas.height / 2 - 2);
        const x = i * step;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw();
  }

  // Detach the audio graph and release the mic. Captured samples live in plain
  // arrays, so it's safe to close the context afterwards.
  function stopVoiceCapture(rec) {
    if (rec.raf) cancelAnimationFrame(rec.raf);
    try { rec.processor.onaudioprocess = null; } catch (_e) {}
    try { rec.processor.disconnect(); } catch (_e) {}
    try { rec.mute.disconnect(); } catch (_e) {}
    try { rec.source.disconnect(); } catch (_e) {}
    try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_e) {}
    try { rec.audioCtx.close(); } catch (_e) {}
  }

  function hideRecorderBox() {
    const box = document.getElementById('voiceRecorder');
    if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  }

  // Discard the recording.
  function cancelVoiceRecorder() {
    const rec = voiceRec;
    voiceRec = null;
    if (rec) stopVoiceCapture(rec);
    hideRecorderBox();
  }

  // Stop, encode a WAV and send it.
  function finishVoiceRecorder() {
    const rec = voiceRec;
    if (!rec) return;
    voiceRec = null;
    const srcRate = rec.audioCtx.sampleRate;
    stopVoiceCapture(rec);
    hideRecorderBox();

    const merged = mergeSamples(rec.chunks, rec.length);
    const samples = downsampleTo(merged, srcRate, VOICE_SAMPLE_RATE);
    const durSec = samples.length / VOICE_SAMPLE_RATE;
    if (durSec < 0.4 || !samples.length) return notify('That voice note was too short.');
    const dataUrl = encodeWavDataUrl(samples, VOICE_SAMPLE_RATE);
    sendVoice(dataUrl, durSec, rec.peer);
  }

  function mergeSamples(chunks, total) {
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  // Average-decimate to the target rate (mono). Good enough for speech.
  function downsampleTo(samples, srcRate, dstRate) {
    if (!srcRate || dstRate >= srcRate) return samples;
    const ratio = srcRate / dstRate;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio)) || start + 1;
      let sum = 0, n = 0;
      for (let j = start; j < end; j++) { sum += samples[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
    return out;
  }

  // 16-bit PCM mono WAV as a base64 data URL.
  function encodeWavDataUrl(samples, sampleRate) {
    const n = samples.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const wr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    wr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    wr(8, 'WAVE');
    wr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);            // block align
    view.setUint16(34, 16, true);           // bits/sample
    wr(36, 'data');
    view.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return 'data:audio/wav;base64,' + base64FromBytes(new Uint8Array(buffer));
  }

  function base64FromBytes(bytes) {
    let binary = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(binary);
  }

  function sendVoice(dataUrl, durSec, peer) {
    if (!state.socket || !peer) return;
    const replyTo = state.replyTo ? state.replyTo.id : null;
    cancelReply();
    state.socket.emit('chat:voice', { to: peer.id, audio: dataUrl, dur: durSec, replyTo }, (res) => {
      if (res && res.error) return notify(res.error);
      const m = (res && res.message) || {};
      appendVoiceBubble({ body: dataUrl, mine: true, at: m.at || Date.now(), id: m.id, dur: durSec, expiresAt: m.expiresAt });
    });
  }

  // A voice-note bubble with its own play/pause control and a real waveform
  // decoded from the audio. No native <audio> controls means no download UI.
  function appendVoiceBubble(m) {
    const b = chatBody();
    if (!b) return;
    const node = el(`
      <div class="voice-msg ${m.mine ? 'me' : 'them'}">
        <button class="vm-play" title="Play voice note">▶</button>
        <div class="vm-wave"></div>
        <span class="vm-dur">0:00</span>
        <span class="time">${fmtTime(m.at)}</span>
      </div>
    `);
    if (m.id) node.dataset.id = m.id;
    if (m.reply) node.insertBefore(renderQuote(m.reply), node.firstChild);

    const playBtn = node.querySelector('.vm-play');
    const wave = node.querySelector('.vm-wave');
    const durEl = node.querySelector('.vm-dur');

    // Render a set of placeholder bars first; replace with real peaks once the
    // audio decodes.
    const BARS = 40;
    for (let i = 0; i < BARS; i++) {
      const bar = document.createElement('span');
      bar.className = 'vm-bar';
      bar.style.height = (18 + (i % 5) * 6) + '%';
      wave.appendChild(bar);
    }
    const bars = Array.from(wave.children);

    const audio = new Audio();
    audio.preload = 'none';
    audio.src = m.body;
    audio.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    let duration = m.dur || 0;
    if (duration) durEl.textContent = fmtClock(duration);

    // Decode for an accurate waveform + duration (best-effort).
    decodeWaveform(m.body, BARS).then((info) => {
      if (!info) return;
      if (info.peaks) info.peaks.forEach((p, i) => { if (bars[i]) bars[i].style.height = Math.max(8, p * 100) + '%'; });
      if (info.duration) { duration = info.duration; durEl.textContent = fmtClock(duration); }
    });

    const paint = () => {
      const d = duration || audio.duration || 0;
      const frac = d ? Math.min(1, audio.currentTime / d) : 0;
      const filled = Math.round(frac * bars.length);
      bars.forEach((bar, i) => bar.classList.toggle('played', i < filled));
      if (d) durEl.textContent = fmtClock(Math.max(0, d - audio.currentTime));
    };
    let raf = null;
    const loop = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(loop); };

    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        // Pause any other playing voice note first.
        document.querySelectorAll('.voice-msg.playing').forEach((o) => {
          if (o !== node && o._audio) { o._audio.pause(); }
        });
        audio.play().then(() => { node.classList.add('playing'); playBtn.textContent = '❚❚'; loop(); }).catch(() => {});
      } else {
        audio.pause();
      }
    });
    audio.addEventListener('pause', () => { node.classList.remove('playing'); playBtn.textContent = '▶'; if (raf) cancelAnimationFrame(raf); });
    audio.addEventListener('ended', () => {
      node.classList.remove('playing'); playBtn.textContent = '▶';
      bars.forEach((bar) => bar.classList.remove('played'));
      durEl.textContent = fmtClock(duration || audio.duration || 0);
    });
    node._audio = audio;

    b.appendChild(node);
    if (m.expiresAt) scheduleExpiry(node, m.expiresAt);
    scrollBody();
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }

  // Decode an audio data URL into `bars` normalized peak heights (0..1) plus
  // duration. Returns null on failure so the caller keeps placeholder bars.
  async function decodeWaveform(dataUrl, bars) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      // Decode the base64 payload directly — fetch() of a data: URL is blocked
      // by our connect-src CSP, so build the ArrayBuffer by hand.
      const comma = dataUrl.indexOf(',');
      const bin = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(bytes.buffer);
      const ch = audioBuf.getChannelData(0);
      const block = Math.floor(ch.length / bars) || 1;
      const peaks = [];
      let max = 0.0001;
      for (let i = 0; i < bars; i++) {
        let sum = 0;
        for (let j = 0; j < block; j++) {
          const v = ch[i * block + j] || 0;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / block);
        peaks.push(rms);
        if (rms > max) max = rms;
      }
      const norm = peaks.map((p) => p / max);
      const duration = audioBuf.duration;
      try { ctx.close(); } catch (_e) {}
      return { peaks: norm, duration };
    } catch (_e) {
      return null;
    }
  }

  /* ---------- anti-save / anti-screenshot (best-effort) ---------- */

  // Block copy, drag and the right-click "Save as…" menu inside a chat. This is
  // a deterrent only — it cannot stop a determined user or the OS, but it stops
  // casual saving of messages, images, files and voice notes.
  function hardenChat(root) {
    if (!root || root._hardened) return;
    root._hardened = true;
    root.classList.add('no-save');
    root.addEventListener('contextmenu', (e) => { e.preventDefault(); }, false);
    root.addEventListener('dragstart', (e) => { e.preventDefault(); }, false);
    root.addEventListener('copy', (e) => { e.preventDefault(); }, false);
  }

  // Global, best-effort screenshot deterrents. There is NO web API that can
  // actually block an OS screenshot, so this only: (1) blurs chat content when
  // the tab is hidden or the window loses focus (foils many capture tools and
  // screen-share previews), and (2) flashes a warning + clears the clipboard on
  // PrintScreen. Set up once.
  var screenshotGuardReady = false;
  function setupScreenshotGuard() {
    if (screenshotGuardReady) return;
    screenshotGuardReady = true;

    const shield = () => document.body.classList.add('privacy-shield');
    const unshield = () => document.body.classList.remove('privacy-shield');

    document.addEventListener('visibilitychange', () => { if (document.hidden) shield(); else unshield(); });
    window.addEventListener('blur', shield);
    window.addEventListener('focus', unshield);

    const warn = () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          const p = navigator.clipboard.writeText('');
          if (p && p.catch) p.catch(() => {});
        }
      } catch (_e) {}
      let t = document.getElementById('ssToast');
      if (!t) {
        t = el('<div id="ssToast" class="ss-toast">🔒 Screenshots are discouraged in private chats.</div>');
        document.body.appendChild(t);
      }
      t.classList.add('show');
      clearTimeout(t._h);
      t._h = setTimeout(() => t.classList.remove('show'), 2200);
    };
    window.addEventListener('keyup', (e) => { if (e.key === 'PrintScreen') warn(); });
    window.addEventListener('keydown', (e) => {
      // Best-effort: some capture shortcuts still reach the page (macOS
      // Cmd+Shift+3/4/5). Windows' Win+Shift+S is captured by the OS first, so
      // it usually never fires here — hence "deterrent, not a guarantee".
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && ['3', '4', '5'].includes(e.key)) warn();
    });
  }

  /* ---------- broadcast ("live chat") ---------- */

  // On (re)connect, learn about any broadcast I'm already a participant of —
  // e.g. after a reload, or when my peer started one before this socket
  // connected. The live event only fires at start, so we backfill here.
  async function syncMyBroadcasts() {
    try {
      const { broadcasts } = await api.get('/api/broadcast');
      (broadcasts || []).forEach((v) => {
        if (v.ownerId === state.me.id || v.peerId === state.me.id) {
          const otherId = v.ownerId === state.me.id ? v.peerId : v.ownerId;
          state.liveByPeer[otherId] = v;
        }
      });
      if (state.peer) reflectBroadcast(state.peer.id);
    } catch (_e) { /* ignore */ }
  }

  // Start or stop broadcasting the open conversation with `peer`.
  function toggleBroadcast(peer) {
    if (!state.socket) return;
    const existing = state.liveByPeer[peer.id];
    if (existing) {
      state.socket.emit('broadcast:stop', { token: existing.token }, (res) => {
        if (res && res.error) notify(res.error);
      });
      return;
    }
    const title = prompt(
      'Broadcast this chat live?\n\nAnyone — including logged-out visitors — will be able to WATCH this conversation from now on and post flying comments. They can never join or send private messages.\n\nGive it a title (optional):',
      ''
    );
    if (title === null) return; // cancelled
    state.socket.emit('broadcast:start', { peerId: peer.id, title: (title || '').trim() }, (res) => {
      if (res && res.error) notify(res.error);
      // The broadcast:live event updates the UI.
    });
  }

  // Reflect the current broadcast state for a conversation into its chat head
  // button and live banner.
  function reflectBroadcast(peerId) {
    const banner = document.getElementById('liveBanner');
    const btn = document.getElementById('broadcastBtn');
    if (!banner) return;
    const b = state.liveByPeer[peerId];
    if (!b) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      if (btn) { btn.classList.remove('on'); btn.textContent = '🔴 Broadcast'; }
      return;
    }
    if (btn) { btn.classList.add('on'); btn.textContent = '⏹ Stop live'; }
    const link = location.origin + '/live/' + encodeURIComponent(b.token);
    banner.classList.remove('hidden');
    banner.innerHTML = '';
    const bar = el(`
      <div class="live-banner-inner">
        <span class="live-dot"></span>
        <span class="live-banner-label">LIVE</span>
        <span class="live-banner-count" id="liveBannerCount">👁️ ${b.viewers || 0} watching</span>
        <button class="ghost small" id="liveCopyBtn" title="Copy the public watch link">🔗 Copy link</button>
        <button class="ghost small" id="liveStopBtn">Stop</button>
      </div>
    `);
    banner.appendChild(bar);
    bar.querySelector('#liveStopBtn').addEventListener('click', () => {
      state.socket.emit('broadcast:stop', { token: b.token }, (res) => { if (res && res.error) notify(res.error); });
    });
    bar.querySelector('#liveCopyBtn').addEventListener('click', async () => {
      const cb = bar.querySelector('#liveCopyBtn');
      try { await navigator.clipboard.writeText(link); const t = cb.textContent; cb.textContent = 'Copied!'; setTimeout(() => { cb.textContent = t; }, 1500); }
      catch (_e) { prompt('Copy this link to share:', link); }
    });
  }

  // Create a short-lived flying comment inside a `.fly-layer` (id given). It
  // drifts across and is removed within 10 seconds.
  const _flownIds = {};
  function flyComment(layerId, c) {
    const layer = document.getElementById(layerId);
    if (!layer || !c) return;
    if (c.id) { // one comment flies once, even if delivered on two channels
      if (_flownIds[c.id]) return;
      _flownIds[c.id] = 1;
      setTimeout(() => { delete _flownIds[c.id]; }, 12000);
    }
    const node = el('<div class="fly-comment"><b></b><span></span></div>');
    node.querySelector('b').textContent = (c.name || 'Guest') + ': ';
    node.querySelector('span').textContent = c.text || '';
    node.style.top = (6 + Math.random() * 78) + '%';
    layer.appendChild(node);
    const kill = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    node.addEventListener('animationend', kill);
    setTimeout(kill, 10000);
  }

  // The Live directory (registered users): every active broadcast, watchable
  // inline.
  async function renderLive() {
    const main = openMainView();
    main.appendChild(sectionShell('🔴 Live chats',
      'Conversations being broadcast right now. Watch any of them unfold live and drop a flying comment — participants only see how many are watching, never who.'));
    const body = main.querySelector('#sectionBody');
    let data;
    try { data = await api.get('/api/broadcast'); }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    const list = data.broadcasts || [];
    body.innerHTML = '';
    if (!list.length) {
      body.appendChild(el('<div class="empty-main">📭 No one is broadcasting right now. Open any chat and hit 🔴 Broadcast to go live.</div>'));
      return;
    }
    const grid = el('<div class="live-grid"></div>');
    list.forEach((b) => {
      const card = el(`
        <div class="live-card as-btn" tabindex="0">
          <div class="live-card-badge">● LIVE</div>
          <div class="live-card-title">${esc(b.title || 'A live chat')}</div>
          <div class="live-card-people"><span>${esc(b.ownerName)}</span><span class="live-card-amp">⇄</span><span>${esc(b.peerName)}</span></div>
          <div class="live-card-meta"><span>👁️ ${b.viewers} watching</span></div>
        </div>
      `);
      card.addEventListener('click', () => renderLiveWatch(b.token));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderLiveWatch(b.token); });
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  // Watch a single broadcast inline, reusing the app's socket.
  function renderLiveWatch(token) {
    const main = openMainView(); // leaves any previously-watched broadcast
    state.watching = token;
    const view = el(`
      <div class="watch inapp">
        <div class="watch-head">
          <button class="icon-btn small" id="watchBack" title="All live chats">←</button>
          <div class="watch-id">
            <div class="watch-title" id="watchTitle">Live chat</div>
            <div class="watch-people" id="watchPeople"></div>
          </div>
          <div class="watch-live"><span class="live-dot"></span>LIVE</div>
          <div class="watch-viewers" id="watchViewers">👁️ 0</div>
        </div>
        <div class="watch-stage">
          <div class="watch-body" id="watchBody"><div class="loading">Connecting…</div></div>
          <div class="fly-layer" id="watchFlyLayer"></div>
        </div>
        <div class="watch-note">👀 You're watching — you can't join the chat, but your comment flies across everyone's screen for a moment.</div>
        <div class="watch-composer">
          <input type="text" id="watchComment" class="watch-comment" maxlength="200" placeholder="Send a flying comment…" autocomplete="off" />
          <button class="primary" id="watchSend">Send</button>
          <button class="ghost" id="watchShare" title="Share this live chat">Share</button>
        </div>
      </div>
    `);
    main.appendChild(view);

    view.querySelector('#watchBack').addEventListener('click', () => { stopWatching(); renderLive(); });
    const input = view.querySelector('#watchComment');
    const send = () => {
      const text = (input.value || '').trim();
      if (!text) return;
      state.socket.emit('broadcast:comment', { token, text }, (res) => { if (res && res.error) flashWatchError(res.error); });
      input.value = ''; input.focus();
    };
    view.querySelector('#watchSend').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    view.querySelector('#watchShare').addEventListener('click', () => {
      const url = location.origin + '/live/' + encodeURIComponent(token);
      navigator.clipboard.writeText(url).then(() => notifyToast('Link copied to share')).catch(() => prompt('Copy this link:', url));
    });

    state.socket.emit('broadcast:watch', { token }, (res) => {
      const body = document.getElementById('watchBody');
      if (!body || state.watching !== token) return;
      if (!res || res.error) { body.innerHTML = `<div class="empty-main">${esc((res && res.error) || 'This broadcast has ended.')}</div>`; return; }
      state.watchInfo = res.info;
      document.getElementById('watchTitle').textContent = res.info.title || 'Live chat';
      document.getElementById('watchPeople').textContent = res.info.ownerName + ' ⇄ ' + res.info.peerName;
      document.getElementById('watchViewers').textContent = '👁️ ' + res.info.viewers;
      body.innerHTML = '';
      const msgs = res.messages || [];
      if (!msgs.length) body.appendChild(el('<div class="watch-hint">Waiting for the next message…</div>'));
      else msgs.forEach(appendWatchMessage);
    });
  }

  function appendWatchMessage(m) {
    const body = document.getElementById('watchBody');
    if (!body) return;
    const hint = body.querySelector('.watch-hint');
    if (hint) hint.remove();
    const side = state.watchInfo && m.from === state.watchInfo.ownerId ? 'owner' : 'peer';
    const row = el(`
      <div class="watch-msg ${side}">
        <div class="watch-msg-name">${esc(m.fromName)}</div>
        <div class="watch-bubble${m.kind && m.kind !== 'text' ? ' special' : ''}"></div>
        <div class="watch-msg-time">${fmtTime(m.at)}</div>
      </div>
    `);
    row.querySelector('.watch-bubble').textContent = m.text;
    body.appendChild(row);
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  function flashWatchError(msg) {
    const input = document.getElementById('watchComment');
    if (!input) return;
    const prev = input.placeholder;
    input.placeholder = msg;
    setTimeout(() => { if (input) input.placeholder = prev; }, 1800);
  }

  // Toast-ish helper that never depends on an open chat body.
  function notifyToast(text) {
    const t = el(`<div class="toast">${esc(text)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
  }

  function showWatchEnded() {
    const body = document.getElementById('watchBody');
    if (body) body.innerHTML = '<div class="empty-main">📴 This broadcast has ended.</div>';
  }

  // Stop watching the current broadcast (if any) and tell the server.
  function stopWatching() {
    if (!state.watching) return;
    const token = state.watching;
    state.watching = null;
    state.watchInfo = null;
    if (state.socket) state.socket.emit('broadcast:unwatch', { token });
  }

  /* ---------- socket ---------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    setupScreenshotGuard();
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
      // Blink the "Chats" nav button for an incoming message the user isn't
      // actively reading (someone else's, and not the open conversation/tab).
      if (!relevant && m.from !== state.me.id && state.tab !== 'chats') markNav('chats', true);
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

    // Group chat message for one of my groups.
    s.on('group:message', (m) => {
      if (state.group && state.group.gid === m.groupId) appendGroupMessage(m);
      else if (!m.mine) {
        const tabId = 'g' + m.groupId;
        if (state.openChats.some((p) => p.id === tabId)) { state.unread[tabId] = true; renderChatTabs(); }
        else notify(`${m.fromName} messaged a group`);
        // Blink the "Chats" nav button for an unread group message elsewhere.
        if (state.tab !== 'chats') markNav('chats', true);
      }
    });

    // A group I'm in changed (created / invited / joined / left).
    s.on('group:changed', ({ groupId }) => {
      if (state.group && state.group.gid === groupId) openGroup(groupId); // refresh header/members
      if (state.tab === 'chats') renderList();
      refreshRequestBadge(); // blinks "Requests" if a new invite raised the count
    });

    // Someone sent me a relationship request — light up "Requests" live.
    s.on('notify:request', () => {
      refreshRequestBadge(); // recomputes count and blinks the button if it grew
      if (isExploreActive('requests')) renderRequests(); // already open: refresh list
    });

    // The leaderboard ranking shifted (new rating / accepted friendship).
    s.on('leaderboard:changed', () => {
      if (isExploreActive('leaderboard')) renderLeaderboard(); // open: refresh in place
      else markNav('leaderboard', true);
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
        reflectMineActivity(e.activity || '');
        renderActivityStatus(peerName);
      }
    });

    // A user (anywhere) set a chat activity or shared an image — stream it onto
    // open feeds live (with a thumbnail when an image is included).
    s.on('activity:new', (e) => {
      if (!e || (!e.text && !e.image)) return;
      pushLiveActivity({
        type: e.image ? 'activity-image' : 'chat-activity',
        icon: e.icon || fakeIcon(e.activity || ''),
        at: e.at || Date.now(),
        text: e.text,
        image: e.image || null,
      });
    });

    // A new Highway post from anyone — prepend it to an open Highway feed.
    s.on('highway:new', (p) => { if (p && p.id) pushHighwayPost(p); });

    s.on('chat:reaction', (e) => {
      if (e && e.messageId != null) updateReaction(e.messageId, e.userId, e.emoji);
    });

    // Disappearing-messages setting changed for a conversation of mine.
    s.on('chat:disappearing', (e) => {
      const peerId = state.peer && state.peer.id;
      if (!peerId || !e) return;
      const involved = (e.from === peerId && e.to === state.me.id) || (e.from === state.me.id && e.to === peerId);
      if (involved) applyDisappearing(e.seconds || 0);
    });

    // The server swept expired messages — drop those bubbles.
    s.on('chat:expire', (e) => { if (e && e.ids) expireMessages(e.ids); });

    s.on('roleplay:progress', (p) => {
      const peerId = state.peer && state.peer.id;
      // Only update the banner when the progress is for the open conversation.
      if (peerId && p && p.peerId === peerId) updateRoleplayBar(p);
    });

    // ----- broadcast ("live chat") events -----

    // A conversation I'm part of went live (I'm owner or peer).
    s.on('broadcast:live', (view) => {
      if (!view) return;
      const otherId = view.ownerId === state.me.id ? view.peerId : view.ownerId;
      state.liveByPeer[otherId] = view;
      if (state.peer && state.peer.id === otherId) reflectBroadcast(otherId);
    });

    // A broadcast ended (mine, or one I'm watching).
    s.on('broadcast:ended', (e) => {
      const token = e && e.token;
      Object.keys(state.liveByPeer).forEach((k) => {
        if (state.liveByPeer[k] && state.liveByPeer[k].token === token) delete state.liveByPeer[k];
      });
      if (state.peer) reflectBroadcast(state.peer.id);
      if (state.watching === token) showWatchEnded();
      if (isExploreActive('live')) renderLive();
    });

    // Live viewer count changed.
    s.on('broadcast:viewers', (e) => {
      if (!e) return;
      Object.values(state.liveByPeer).forEach((v) => { if (v.token === e.token) v.viewers = e.count; });
      const b = state.peer && state.liveByPeer[state.peer.id];
      if (b && b.token === e.token) {
        const c = document.getElementById('liveBannerCount');
        if (c) c.textContent = `👁️ ${e.count} watching`;
      }
      if (state.watching === e.token) {
        const wv = document.getElementById('watchViewers');
        if (wv) wv.textContent = '👁️ ' + e.count;
      }
    });

    // A flying comment on a broadcast — for a participant (over their chat) or
    // for the broadcast being watched inline.
    s.on('broadcast:comment', (c) => {
      if (!c) return;
      const b = state.peer && state.liveByPeer[state.peer.id];
      if (b && c.token === b.token) flyComment('chatFlyLayer', c);
      if (state.watching && c.token === state.watching) flyComment('watchFlyLayer', c);
    });

    // A mirrored chat message for the broadcast being watched inline.
    s.on('broadcast:message', (m) => {
      if (state.watching) appendWatchMessage(m);
    });

    // The set of active broadcasts changed — refresh an open Live list, else
    // blink the nav button so people notice a new live chat.
    s.on('broadcast:listChanged', () => {
      if (isExploreActive('live')) renderLive();
      else markNav('live', true);
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

  // A "Relationship request" dropdown. Picking one of the 7 options sends that
  // typed request for `username`, then calls `refresh`.
  function relationshipRequestEl(username, refresh) {
    const u = encodeURIComponent(username);
    const sel = el(`
      <select class="rel-request small" title="Send a relationship request">
        <option value="">＋ Relationship request…</option>
        ${REL_ORDER.map((k) => `<option value="${k}">${esc(REL_TYPES[k].requestLabel)}</option>`).join('')}
      </select>
    `);
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', async (e) => {
      e.stopPropagation();
      const type = sel.value;
      if (!type) return;
      sel.disabled = true;
      try {
        await api.post('/api/social/friend/' + u, { type });
        refreshRequestBadge();
        refresh();
      } catch (err) { alert(err.message); sel.value = ''; sel.disabled = false; }
    });
    return sel;
  }

  // Render the contextual relationship action(s) into `slot` based on state.
  function renderFriendButton(slot, profile, refresh) {
    slot.innerHTML = '';
    const u = encodeURIComponent(profile.username);
    const rel = profile.friends.relType || 'friend';
    const act = async (fn) => { try { await fn(); refreshRequestBadge(); refresh(); } catch (e) { alert(e.message); } };
    const btn = (label, cls, handler) => {
      const b = el(`<button class="${cls} small">${esc(label)}</button>`);
      b.addEventListener('click', () => act(handler));
      return b;
    };
    switch (profile.friends.state) {
      case 'friends':
        slot.appendChild(el(`<span class="pill">${esc(relLabel(rel))}</span>`));
        slot.appendChild(btn('Remove', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      case 'outgoing':
        slot.appendChild(el(`<span class="pill">Sent · ${esc(relLabel(rel))}</span>`));
        slot.appendChild(btn('Cancel', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      case 'incoming':
        slot.appendChild(el(`<span class="pill">Wants · ${esc(relLabel(rel))}</span>`));
        slot.appendChild(btn('Accept', 'primary', () => api.post('/api/social/friend/' + u + '/accept')));
        slot.appendChild(btn('Decline', 'ghost', () => api.del('/api/social/friend/' + u)));
        break;
      default:
        slot.appendChild(relationshipRequestEl(profile.username, refresh));
    }
  }

  /* ======================================================================
     EXPLORE SECTIONS (Quizzes / Polls / Blogs / Leaderboard / Events)
  ====================================================================== */

  // Prepare the main pane for a full-width section and return its element.
  function openMainView() {
    stopWatching(); // leaving any inline broadcast we were watching
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
      case 'friends': return el('<span class="pill friend-pill">✓ Connected</span>');
      case 'outgoing': return btn('Cancel request', 'ghost', () => api.del('/api/social/friend/' + u));
      case 'incoming': return btn('Accept request', 'primary', () => api.post('/api/social/friend/' + u + '/accept'));
      default: return relationshipRequestEl(username, refresh);
    }
  }

  function openExplore(view) {
    if (view === 'highway') return renderHighway();
    if (view === 'requests') return renderRequests();
    if (view === 'quizzes') return renderQuizzes();
    if (view === 'polls') return renderPolls();
    if (view === 'blogs') return renderBlogs();
    if (view === 'leaderboard') return renderLeaderboard();
    if (view === 'live') return renderLive();
    if (view === 'events') return renderMainHome(true); // activity lives in the chat box now
  }

  /* ======================================================================
     HIGHWAY — a shared pool of posts (text / images / links). Any registered
     user can post; only the newest 100 are kept. Live-updated over the socket.
  ====================================================================== */
  let highwayFeed = null; // the mounted feed element, for live socket updates

  async function renderHighway() {
    const main = openMainView();
    main.appendChild(sectionShell('🌊 Highway',
      'The community pool — share text, images, links, or videos. Anyone can post.'));
    const body = main.querySelector('#sectionBody');
    body.innerHTML = '';

    // Composer
    const composer = el(`
      <div class="card highway-composer">
        <textarea id="hwText" maxlength="2000" placeholder="Share something with everyone — a thought, a link, a YouTube / Instagram / Facebook URL…"></textarea>
        <div class="hw-compose-actions">
          <label class="hw-attach" title="Attach an image">📷 <span id="hwFileName">Add image</span>
            <input type="file" id="hwImage" accept="image/*" hidden />
          </label>
          <span class="spacer"></span>
          <button class="primary" id="hwPost">Post to Highway</button>
        </div>
        <div class="msg" id="hwMsg"></div>
      </div>
    `);
    body.appendChild(composer);

    const feed = el('<div class="highway-feed" id="hwFeed"><div class="hint" style="padding:16px">Loading…</div></div>');
    body.appendChild(feed);
    highwayFeed = feed;

    const fileInput = composer.querySelector('#hwImage');
    const fileName = composer.querySelector('#hwFileName');
    fileInput.addEventListener('change', () => {
      fileName.textContent = fileInput.files[0] ? fileInput.files[0].name.slice(0, 22) : 'Add image';
    });
    const postBtn = composer.querySelector('#hwPost');
    postBtn.addEventListener('click', async () => {
      const msg = composer.querySelector('#hwMsg'); msg.className = 'msg';
      const text = composer.querySelector('#hwText').value.trim();
      if (!text && !fileInput.files[0]) { msg.className = 'msg error'; msg.textContent = 'Write something or add an image.'; return; }
      const fd = new FormData();
      fd.append('body', text);
      if (fileInput.files[0]) fd.append('image', fileInput.files[0]);
      postBtn.disabled = true;
      try {
        const { post } = await api.postForm('/api/highway', fd);
        composer.querySelector('#hwText').value = '';
        fileInput.value = ''; fileName.textContent = 'Add image';
        prependHighwayPost(feed, post);
        trimHighwayFeed(feed);
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
      finally { postBtn.disabled = false; }
    });

    try {
      const { posts } = await api.get('/api/highway');
      await loadAds().catch(() => {});
      feed.innerHTML = '';
      const header = slotEl('highway_header');
      if (header) feed.appendChild(header);
      if (!posts.length) feed.appendChild(el('<div class="empty-main">No posts yet — be the first to hit the Highway!</div>'));
      else {
        // Ads appear between posts at random, but are mandatory after every 15.
        let adIdx = 0, lastWasAd = false;
        posts.forEach((p, i) => {
          feed.appendChild(highwayPostEl(p));
          const isLast = i === posts.length - 1;
          const mandatory = (i + 1) % 15 === 0;
          const random = !lastWasAd && Math.random() < 0.15;
          if (!isLast && (mandatory || random)) {
            const ad = slotEl('highway_inline', adIdx++);
            if (ad) { ad.classList.add('ad-stream'); feed.appendChild(ad); lastWasAd = true; } else lastWasAd = false;
          } else { lastWasAd = false; }
        });
      }
    } catch (e) { feed.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; }
  }

  // Build one Highway post card.
  function highwayPostEl(p) {
    const card = el(`
      <div class="card highway-post${p.pinned ? ' hw-pinned' : ''}" data-id="${p.id}">
        <div class="hw-head">
          <img class="avatar sm hw-avatar" src="${avatarUrl(p.author.avatar)}" alt="" />
          <div class="hw-who">
            <div class="hw-name"></div>
            <div class="hw-time hint">${p.pinned ? '📌 Pinned · ' : ''}${fmtDate(p.createdAt)} · ${fmtTime(p.createdAt)}</div>
          </div>
          <div class="hw-action"></div>
        </div>
        <div class="hw-body"></div>
      </div>
    `);
    const nameEl = card.querySelector('.hw-name');
    nameEl.textContent = p.author.displayName + ' ';
    nameEl.appendChild(el(`<span class="hw-handle">@${esc(p.author.username)}</span>`));
    const goProfile = () => showProfile(p.author.username);
    nameEl.style.cursor = 'pointer';
    nameEl.addEventListener('click', goProfile);
    card.querySelector('.hw-avatar').addEventListener('click', goProfile);

    const bodyEl = card.querySelector('.hw-body');
    if (p.body) appendRichText(bodyEl, p.body); else bodyEl.remove();
    if (p.image) {
      const img = el('<img class="hw-image" loading="lazy" alt="shared image" />');
      img.src = p.image;
      img.addEventListener('click', () => openLightbox(p.image));
      card.appendChild(img);
    }

    const actionSlot = card.querySelector('.hw-action');
    if (p.mine) {
      const del = el('<button class="ghost small" title="Delete this post">Delete</button>');
      del.addEventListener('click', async () => {
        if (!confirm('Delete this post?')) return;
        try { await api.del('/api/highway/' + p.id); card.remove(); } catch (e) { alert(e.message); }
      });
      actionSlot.appendChild(del);
    } else {
      // A relationship-request control, re-rendered to reflect the new state.
      const fb = friendButtonEl(p.author.username, p.friendState || 'none', () => {
        const fresh = friendButtonEl(p.author.username, 'outgoing', () => {});
        actionSlot.innerHTML = '';
        if (fresh) actionSlot.appendChild(fresh);
      });
      if (fb) actionSlot.appendChild(fb);
    }
    return card;
  }

  function prependHighwayPost(feed, post) {
    if (!feed) return;
    const dup = feed.querySelector(`.highway-post[data-id="${post.id}"]`);
    if (dup) dup.remove();
    const empty = feed.querySelector('.empty-main');
    if (empty) empty.remove();
    // New (unpinned) posts go above the rest but below any pinned posts.
    const anchor = post.pinned ? feed.firstChild : feed.querySelector('.highway-post:not(.hw-pinned)');
    feed.insertBefore(highwayPostEl(post), anchor || null);
  }

  function trimHighwayFeed(feed) {
    if (!feed) return;
    let posts = feed.querySelectorAll('.highway-post');
    while (posts.length > 100) {
      feed.removeChild(posts[posts.length - 1]);
      posts = feed.querySelectorAll('.highway-post');
    }
  }

  // Live socket push: a new post from anyone. Fill in viewer-specific fields.
  function pushHighwayPost(payload) {
    if (!highwayFeed || !document.body.contains(highwayFeed)) { highwayFeed = null; return; }
    const mine = !!(state.me && payload.author && payload.author.id === state.me.id);
    prependHighwayPost(highwayFeed, {
      id: payload.id, body: payload.body, image: payload.image, createdAt: payload.createdAt,
      author: payload.author, mine, friendState: mine ? 'self' : 'none',
    });
    trimHighwayFeed(highwayFeed);
  }

  /* ---------- Friend requests ---------- */
  async function renderRequests() {
    const main = openMainView();
    main.appendChild(sectionShell('Relationship Requests', 'People who want to connect with you — friend, crush, and more. View their profile, then accept or decline.'));
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
              <div class="handle">@${esc(u.username)} · wants ${esc(relLabel(u.relType))}</div>
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
              <span class="pill">${esc(relLabel(u.relType))} · pending</span>
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

    // ---- Group chat invites ----
    let invites = [];
    try { invites = (await api.get('/api/groups')).invites || []; } catch (_e) {}
    const gWrap = el(`<div class="card"><h3 class="card-title">👥 Group chat invites <span class="hint">(${invites.length})</span></h3><div class="req-list" id="reqGroups"></div></div>`);
    const gBox = gWrap.querySelector('#reqGroups');
    if (!invites.length) {
      gBox.appendChild(el('<div class="hint">No group chat invites right now.</div>'));
    } else {
      invites.forEach((g) => {
        const joined = (g.members || []).filter((m) => m.status === 'joined');
        const row = el(`
          <div class="req-row">
            <div class="group-avatars">${joined.slice(0, 4).map((m) => `<img class="avatar sm" src="${avatarUrl(m.avatar)}"/>`).join('')}</div>
            <div class="req-id">
              <div class="name">${esc(g.name)}</div>
              <div class="handle">${joined.length}/${g.max} members · invited by ${esc((joined.find((m) => m.id === g.createdBy) || {}).displayName || 'a member')}</div>
            </div>
            <div class="req-actions">
              <button class="primary small g-accept">Accept &amp; join</button>
              <button class="ghost small g-decline">Decline</button>
            </div>
          </div>
        `);
        row.querySelector('.g-accept').addEventListener('click', async () => {
          try { await api.post('/api/groups/' + g.id + '/accept', {}); refreshRequestBadge(); openGroup(g.id); }
          catch (e) { alert(e.message); }
        });
        row.querySelector('.g-decline').addEventListener('click', async () => {
          try { await api.post('/api/groups/' + g.id + '/leave', {}); renderRequests(); }
          catch (e) { alert(e.message); }
        });
        gBox.appendChild(row);
      });
    }
    body.appendChild(gWrap);
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
    decorateSectionWithAds(main);
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
    decorateSectionWithAds(main);
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
    decorateSectionWithAds(main);
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
          ${ev.image ? '<div class="feed-thumb-wrap"></div>' : ''}
          <div class="feed-time hint">${live ? 'just now' : `${fmtDate(ev.at)} · ${fmtTime(ev.at)}`}</div>
        </div>
      </div>
    `);
    if (ev.type === 'admin' && ev.title) item.querySelector('.feed-title').textContent = ev.title;
    item.querySelector('.feed-text').textContent = ev.text;
    if (ev.image) {
      const img = el('<img class="feed-thumb" alt="shared image" loading="lazy" />');
      img.src = ev.image;
      img.addEventListener('click', () => window.open(ev.image, '_blank', 'noopener'));
      item.querySelector('.feed-thumb-wrap').appendChild(img);
    }
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
    try { await loadAds(); } catch (_e) { /* ads are optional */ }
    const feed = el(`<div class="${opts.compact ? 'activity-side' : 'feed card'}"></div>`);
    events.forEach((ev, i) => {
      feed.appendChild(feedItemEl(ev, false));
      // Advertisement after every 15 activity items.
      if ((i + 1) % 15 === 0 && i < events.length - 1) {
        const ad = slotEl('live_inline', Math.floor(i / 15));
        if (ad) { ad.classList.add('ad-stream'); feed.appendChild(ad); }
      }
    });
    container.innerHTML = '';
    container.appendChild(feed);
    registerActivityFeed(feed);
  }

  /* ---- live activity feed (driven by the server) ----
     The "recent activity" stream is generated continuously on the SERVER, so
     every user sees the same feed even with nobody online. Logged-in clients
     receive each new row over the socket ('activity:new' → pushLiveActivity);
     the sign-in page has no socket, so it polls instead (startAuthActivityPoll).
  */
  const activityFeeds = []; // mounted feed elements that live socket updates flow into

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

  // Track a mounted feed so live socket broadcasts insert into it. Prunes any
  // feeds that have since left the page.
  function registerActivityFeed(feed) {
    for (let i = activityFeeds.length - 1; i >= 0; i--) {
      if (!document.body.contains(activityFeeds[i])) activityFeeds.splice(i, 1);
    }
    activityFeeds.push(feed);
  }

  // Insert a freshly-happened event at the top of every mounted feed, marked
  // "just now". Driven by socket broadcasts (server stream, chat activity, …).
  function pushLiveActivity(ev) {
    for (let i = activityFeeds.length - 1; i >= 0; i--) {
      if (!document.body.contains(activityFeeds[i])) activityFeeds.splice(i, 1);
    }
    activityFeeds.forEach((feed) => {
      feed.insertBefore(feedItemEl(ev, true), feed.firstChild);
      while (feed.children.length > 60) feed.removeChild(feed.lastChild);
    });
  }

  // Sign-in page only: poll the public feed and prepend new server-stream rows
  // (there is no socket before login). Stops once the feed leaves the page.
  function startAuthActivityPoll(feed, sinceAt) {
    let lastAt = sinceAt || 0;
    const poll = async () => {
      if (!document.body.contains(feed)) return; // navigated away → stop
      try {
        const fresh = ((await api.get('/api/events/public')).events || [])
          .filter((e) => !e.image && (e.at || 0) > lastAt)
          .sort((a, b) => a.at - b.at); // oldest first so the newest ends on top
        fresh.forEach((ev) => {
          feed.insertBefore(feedItemEl(ev, true), feed.firstChild);
          lastAt = Math.max(lastAt, ev.at || 0);
          while (feed.children.length > 60) feed.removeChild(feed.lastChild);
        });
      } catch (_e) { /* ignore transient errors */ }
      setTimeout(poll, 6000);
    };
    setTimeout(poll, 6000);
  }

  boot();
})();
