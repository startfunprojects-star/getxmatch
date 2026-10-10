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
    gifts: null,         // gift catalog, loaded lazily
    giftsById: {},       // id -> gift for rendering
    online: {},          // userId -> true when a friend/relation is currently online
    ignored: {},         // userId -> true for people I've ignored (hide their Highway posts)
  };

  /* ---------- online presence for friends/relations ----------
     Populated from friend/profile payloads and kept live by 'presence:update'
     socket events. A small green dot on a person's avatar reflects state.online.
     Every dot carries data-uid so setOnline() can flip it in place. */
  // We only know presence for friends/relations (the server broadcasts it just
  // to them), so only render a dot when we actually track this user — never a
  // misleading "offline" dot on a stranger.
  function tracksPresence(uid) {
    return Object.prototype.hasOwnProperty.call(state.online, uid);
  }
  function onlineDotHTML(uid) {
    if (!tracksPresence(uid)) return '';
    const on = !!state.online[uid];
    return `<span class="online-dot${on ? ' on' : ''}" data-uid="${uid}" title="${on ? 'Online now' : 'Offline'}"></span>`;
  }
  // Wrap an avatar so its presence dot sits in the corner.
  function avatarWithPresence(uid, avatar, cls) {
    return `<span class="av-wrap"><img class="avatar ${cls || ''}" src="${avatarUrl(avatar)}" />${onlineDotHTML(uid)}</span>`;
  }
  // Seed friend presence once so dots are correct even before visiting the
  // Friends tab (e.g. on the Chats list right after connecting).
  async function seedFriendPresence() {
    try {
      const { friends } = await api.get('/api/social/friends');
      seedOnline(friends);
      (friends || []).forEach((u) => setOnline(u.id, u.online));
    } catch (_e) { /* ignore */ }
  }
  // Record online flags coming from a friends/connections payload.
  function seedOnline(list) {
    (list || []).forEach((u) => { if (u && u.id != null && 'online' in u) state.online[u.id] = !!u.online; });
  }
  // Apply a live presence change everywhere that person's dot is shown.
  function setOnline(uid, on) {
    state.online[uid] = !!on;
    document.querySelectorAll(`.online-dot[data-uid="${uid}"]`).forEach((d) => {
      d.classList.toggle('on', !!on);
      d.title = on ? 'Online now' : 'Offline';
    });
  }

  // Fetch (and cache) the gift catalog.
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

  /* ---------- Image cropper ----------
     Opens a modal that lets the user drag/resize a selection box over the
     chosen image and keep only that part. Used before every profile-image
     upload (display picture, buffer, gallery). Resolves with a File containing
     the cropped JPEG, the original File if they keep the whole image, or null
     if cancelled. Animated GIFs bypass the cropper so animation is preserved. */
  function cropImage(file) {
    return new Promise((resolve) => {
      if (!file || /image\/gif/i.test(file.type)) return resolve(file || null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.onload = () => {
        const overlay = el(`
          <div class="cropper-overlay">
            <div class="cropper-modal">
              <div class="cropper-hint">Drag the box to choose the part of the image to keep.</div>
              <div class="cropper-stage">
                <img class="cropper-img" alt="" />
                <div class="crop-sel">
                  <span class="crop-h nw"></span><span class="crop-h ne"></span>
                  <span class="crop-h sw"></span><span class="crop-h se"></span>
                </div>
              </div>
              <div class="cropper-actions">
                <button class="ghost small" data-act="full" type="button">Use whole image</button>
                <button class="ghost small" data-act="cancel" type="button">Cancel</button>
                <button class="primary small" data-act="save" type="button">Save selection</button>
              </div>
            </div>
          </div>`);
        const stage = overlay.querySelector('.cropper-stage');
        const shownImg = overlay.querySelector('.cropper-img');
        const sel = overlay.querySelector('.crop-sel');
        shownImg.src = url;
        document.body.appendChild(overlay);

        // Size the stage to the image's on-screen size (capped by CSS), then
        // start with a centred selection covering ~70% of it.
        const layout = () => {
          const w = shownImg.clientWidth, h = shownImg.clientHeight;
          stage.style.width = w + 'px';
          stage.style.height = h + 'px';
          const sw = Math.round(w * 0.7), sh = Math.round(h * 0.7);
          box = { x: Math.round((w - sw) / 2), y: Math.round((h - sh) / 2), w: sw, h: sh };
          paint();
        };
        let box = { x: 0, y: 0, w: 0, h: 0 };
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const paint = () => {
          sel.style.left = box.x + 'px';
          sel.style.top = box.y + 'px';
          sel.style.width = box.w + 'px';
          sel.style.height = box.h + 'px';
        };

        // Pointer drag: move the whole box, or resize from a corner handle.
        let drag = null;
        const onDown = (e, mode) => {
          e.preventDefault();
          drag = { mode, sx: e.clientX, sy: e.clientY, box: { ...box } };
          sel.setPointerCapture && sel.setPointerCapture(e.pointerId);
        };
        const onMove = (e) => {
          if (!drag) return;
          const W = shownImg.clientWidth, H = shownImg.clientHeight;
          const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
          const b = drag.box;
          if (drag.mode === 'move') {
            box.x = clamp(b.x + dx, 0, W - b.w);
            box.y = clamp(b.y + dy, 0, H - b.h);
          } else {
            let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
            if (drag.mode.includes('w')) x1 = clamp(b.x + dx, 0, x2 - 20);
            if (drag.mode.includes('e')) x2 = clamp(b.x + b.w + dx, x1 + 20, W);
            if (drag.mode.includes('n')) y1 = clamp(b.y + dy, 0, y2 - 20);
            if (drag.mode.includes('s')) y2 = clamp(b.y + b.h + dy, y1 + 20, H);
            box = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
          }
          paint();
        };
        const onUp = () => { drag = null; };
        sel.addEventListener('pointerdown', (e) => {
          if (e.target.classList.contains('crop-h')) return; // handled below
          onDown(e, 'move');
        });
        sel.querySelectorAll('.crop-h').forEach((h) => {
          const mode = h.classList.contains('nw') ? 'nw' : h.classList.contains('ne') ? 'ne'
            : h.classList.contains('sw') ? 'sw' : 'se';
          h.addEventListener('pointerdown', (e) => { e.stopPropagation(); onDown(e, mode); });
        });
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);

        const cleanup = (result) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          overlay.remove();
          URL.revokeObjectURL(url);
          resolve(result);
        };
        overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => cleanup(null));
        overlay.querySelector('[data-act="full"]').addEventListener('click', () => cleanup(file));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        overlay.querySelector('[data-act="save"]').addEventListener('click', () => {
          const scaleX = img.naturalWidth / shownImg.clientWidth;
          const scaleY = img.naturalHeight / shownImg.clientHeight;
          const sx = Math.round(box.x * scaleX), sy = Math.round(box.y * scaleY);
          const sw = Math.max(1, Math.round(box.w * scaleX));
          const sh = Math.max(1, Math.round(box.h * scaleY));
          const canvas = document.createElement('canvas');
          canvas.width = sw; canvas.height = sh;
          canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
          canvas.toBlob((blob) => {
            if (!blob) return cleanup(file);
            const name = (file.name || 'image').replace(/\.[^.]+$/, '') + '-crop.jpg';
            cleanup(new File([blob], name, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.92);
        });

        // Wait a frame so clientWidth/Height reflect the rendered image.
        requestAnimationFrame(layout);
      };
      img.src = url;
    });
  }

  /* ================= Advertisements =================
     Ads are fetched once and rendered into named placement slots. Image ads are
     click-tracked via a redirect; script ads run inside a sandboxed same-origin
     iframe so ad-network code can't touch the page, cookies or user data. */
  const AD_PLACEMENTS = 'content_header,content_footer,content_sidebar_left,content_sidebar_right,content_inline,highway_header,highway_footer,highway_inline,chat_inline,live_inline,alerts_inline';
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
    yesNo: ['Yes', 'No', 'Occasionally', 'Prefer not to say'],
    education: ['School', 'Graduate', 'Masters', 'PhD', 'Post Doc'],
    educationStream: [
      'Arts (General)', 'Arts (English)', 'Arts (Hindi)', 'Arts (Other Languages)',
      'Arts (History)', 'Arts (Political Science)', 'Arts (Economics)',
      'Arts (Geography)', 'Arts (Psychology)', 'Arts (Sociology)', 'Arts (Philosophy)',
      'Arts (Fine Arts)', 'Arts (Music)', 'Arts (Performing Arts)',
      'Arts (Journalism & Mass Communication)', 'Commerce (General)',
      'Commerce (Accounting & Finance)', 'Commerce (Banking & Insurance)',
      'Commerce (Economics)', 'Commerce (Business Studies)',
      'Commerce (Chartered Accountancy)', 'Commerce (Company Secretary)',
      'Commerce (Marketing)', 'Science (Math)', 'Science (Biology)', 'Science (Physics)',
      'Science (Chemistry)', 'Science (Statistics)', 'Science (Computer Science)',
      'Science (Information Technology)', 'Science (Data Science)',
      'Science (Biotechnology)', 'Science (Microbiology)',
      'Science (Environmental Science)', 'Science (Agriculture)',
      'Science (Home Science)', 'Science (Forensic Science)', 'Science (Engineering)',
      'Science (Computer Science Engineering)',
      'Science (Artificial Intelligence & Machine Learning)',
      'Science (Electronics & Communication Engineering)',
      'Science (Electrical Engineering)', 'Science (Mechanical Engineering)',
      'Science (Civil Engineering)', 'Science (Chemical Engineering)',
      'Science (Aerospace Engineering)', 'Science (Biomedical Engineering)',
      'Medical (MBBS)', 'Medical (Dental)', 'Medical (Nursing)', 'Medical (Pharmacy)',
      'Medical (Physiotherapy)', 'Medical (AYUSH)', 'Medical (Allied Health Sciences)',
      'Medical (Veterinary)', 'Management (Business Administration)',
      'Management (Hotel Management)', 'Management (Tourism & Hospitality)',
      'Law (General)', 'Law (Corporate Law)', 'Law (Criminal Law)',
      'Design (Fashion Design)', 'Design (Interior Design)',
      'Design (Graphic & Communication Design)', 'Design (Product Design)',
      'Architecture (General)', 'Education (Teaching)', 'Vocational (ITI / Diploma)',
      'Vocational (Polytechnic)', 'Other (Other)',
    ],
    workStatus: ['Student', 'Working', 'Working Student'],
    // Mirrors INTEREST_GROUPS in src/profileFields.js.
    interestGroups: [
      { group: "Arts & culture", items: ['Art', 'Music', 'Movies', 'Photography', 'Dancing', 'Theatre', 'Poetry', 'Painting', 'Design', 'Architecture', 'Museums', 'Classical music'] },
      { group: "Reading & ideas", items: ['Reading', 'Writing', 'Literature', 'Philosophy', 'History', 'Languages', 'Journalism', 'Blogging', 'Debating', 'Mythology'] },
      { group: "Science & technology", items: ['Technology', 'Science', 'Mathematics', 'Physics', 'Astronomy', 'Biology', 'Chemistry', 'Programming', 'Artificial intelligence', 'Robotics', 'Electronics', 'Medicine'] },
      { group: "Society & work", items: ['Politics', 'Economics', 'Psychology', 'Sociology', 'Law', 'Education', 'Environment', 'Volunteering', 'Entrepreneurship', 'Finance', 'Public speaking', 'Social causes'] },
      { group: "Lifestyle", items: ['Travel', 'Cooking', 'Fashion', 'Fitness', 'Yoga', 'Meditation', 'Gardening', 'Pets', 'Food & dining', 'Coffee & tea', 'DIY & crafts', 'Spirituality'] },
      { group: "Sports & outdoors", items: ['Sports', 'Nature', 'Hiking', 'Cycling', 'Running', 'Swimming', 'Cricket', 'Football', 'Badminton', 'Chess', 'Camping', 'Wildlife'] },
      { group: "Entertainment", items: ['Gaming', 'Podcasts', 'Stand-up comedy', 'Anime', 'TV series', 'Board games', 'Puzzles', 'Quizzes'] },
    ],
  };
  const MAX_REEL_SECONDS = 60; // gallery photos and reels: no limit on how many
  const MAX_REEL_MB = 50;
  const MAX_BUFFER = 10;
  const MAX_GIFS = 100;

  // Labels for the GIF collection's visibility settings. Mirrors GIF_VISIBILITY
  // in src/profileFields.js.
  const GIF_VISIBILITY = [
    { value: 'public', label: '🌍 Everyone' },
    { value: 'friends', label: '👥 Connections only' },
    { value: 'private', label: '🔒 Only me' },
  ];

  // Emoji "likes" a user can leave on a gallery photo. Mirrors the server-side
  // allow-list in src/galleryReactions.js — keep the two in sync.
  const GALLERY_REACTIONS = [
    { emoji: '❤️', label: 'Love' },
    { emoji: '😄', label: 'Smile' },
    { emoji: '😮', label: 'Wow' },
    { emoji: '👏', label: 'Applause' },
    { emoji: '🔥', label: 'Awesome' },
  ];

  // Connection requests are friend requests only (mirror src/relationships.js).
  // Older connections stored with other kinds display as friends.
  const REL_TYPES = {
    friend: { label: 'Friends', emoji: '🤝', requestLabel: 'Send Friend Request' },
  };
  const REL_ORDER = ['friend'];
  function relLabel(type) { const t = REL_TYPES[type] || REL_TYPES.friend; return `${t.emoji} ${t.label}`; }

  // The four rating dimensions (each 1-5 stars). Mirrors RATING_DIMS in
  // src/profileData.js.
  const RATING_DIMS = [
    { key: 'knowledgeable', label: 'Knowledgeable', emoji: '📚' },
    { key: 'helpful', label: 'Helpful', emoji: '🤝' },
    { key: 'creative', label: 'Creative', emoji: '🎨' },
    { key: 'thoughtful', label: 'Thoughtful', emoji: '💭' },
  ];

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
  function selectHtml(id, options, current, placeholder, attrs) {
    // placeholder === false → no empty first option (field always has a value).
    const head = placeholder === false ? [] : ['<option value="">' + esc(placeholder || 'Select…') + '</option>'];
    const opts = head.concat(options.map((o) => {
      const label = o.value != null ? o.label : o;
      const value = o.value != null ? o.value : o;
      return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
    }));
    return `<select id="${id}"${attrs ? ' ' + attrs : ''}>${opts.join('')}</select>`;
  }
  function starsHtml(n, interactive) {
    let out = '';
    for (let i = 1; i <= 5; i++) {
      const filled = i <= Math.round(n);
      out += `<span class="star${filled ? ' on' : ''}"${interactive ? ` data-v="${i}"` : ''}>★</span>`;
    }
    return out;
  }

  // Render the four-dimension ratings card into #pvRatings. Each dimension has
  // its own average + a 1-5 star control (interactive when viewing someone else).
  // Re-renders itself and the hero overall score after each change.
  function renderRatingsCard(view, profile, isMe, username) {
    const box = view.querySelector('#pvRatings');
    if (!box) return;
    const heroScore = view.querySelector('.pro-score');
    const heroStars = view.querySelector('.pro-rating .stars');
    const heroCount = view.querySelector('.pro-rcount');

    const repaintHero = () => {
      const r = profile.rating;
      if (heroScore) heroScore.textContent = r.average ? r.average.toFixed(1) : '—';
      if (heroStars) heroStars.innerHTML = starsHtml(r.average, false);
      if (heroCount) heroCount.textContent = `${r.count} rating${r.count === 1 ? '' : 's'}`;
    };

    function render() {
      box.innerHTML = '';
      RATING_DIMS.forEach((dim) => {
        const d = (profile.rating.dimensions && profile.rating.dimensions[dim.key]) || { average: 0, count: 0 };
        const mineVal = profile.rating.mine ? profile.rating.mine[dim.key] : null;
        const row = el(`
          <div class="rate-dim">
            <div class="rate-dim-top">
              <span class="rate-dim-name">${dim.emoji} ${dim.label}</span>
              <span class="rate-dim-avg">${d.average ? d.average.toFixed(1) : '—'}<span class="hint"> (${d.count})</span></span>
            </div>
            <div class="stars rate-stars">${starsHtml(mineVal || d.average, !isMe)}</div>
          </div>
        `);
        if (!isMe) {
          const starsEl = row.querySelector('.rate-stars');
          const base = () => mineVal || Math.round(d.average);
          const paint = (n) => starsEl.querySelectorAll('.star').forEach((s) =>
            s.classList.toggle('on', Number(s.dataset.v) <= n));
          paint(base());
          starsEl.querySelectorAll('.star').forEach((s) => {
            s.addEventListener('mouseenter', () => paint(Number(s.dataset.v)));
            s.addEventListener('click', async () => {
              try {
                const { rating } = await api.post('/api/social/rate/' + encodeURIComponent(username), { dimension: dim.key, stars: Number(s.dataset.v) });
                profile.rating = rating;
                render();
                repaintHero();
              } catch (e) { alert(e.message); }
            });
          });
          starsEl.addEventListener('mouseleave', () => paint(base()));
        }
        box.appendChild(row);
      });

      if (!isMe && profile.rating.mine && RATING_DIMS.some((dm) => profile.rating.mine[dm.key])) {
        const clear = el('<button class="ghost small rate-clear">Clear my ratings</button>');
        clear.addEventListener('click', async () => {
          try {
            const { rating } = await api.del('/api/social/rate/' + encodeURIComponent(username));
            profile.rating = rating;
            render();
            repaintHero();
          } catch (e) { alert(e.message); }
        });
        box.appendChild(clear);
      }
    }
    render();
  }

  /* ======================================================================
     BOOT
  ====================================================================== */
  // Deep-link intent from a shared quiz result page (/?chat=<username>&signup=1).
  let pendingChatUser = null;
  // Deep-link intent from a shared profile link (/?view=<username>[&signup=1]).
  let pendingViewUser = null;

  async function openChatByUsername(username) {
    if (!username) return;
    try {
      const { profile } = await api.get('/api/profile/' + encodeURIComponent(username));
      openChat({ id: profile.id, username: profile.username, displayName: profile.displayName, avatar: profile.avatar });
    } catch (_e) { /* user may not exist / be blocked */ }
  }

  let pendingReferral = '';
  let referralsOn = false; // admin switch, read at boot
  async function boot() {
    const params = new URLSearchParams(location.search);
    const wantSignup = params.get('signup') === '1';
    pendingChatUser = params.get('chat');
    pendingViewUser = params.get('view');
    // A referral link (/?ref=CODE) opens sign-up with the code filled in.
    const ref = (params.get('ref') || '').trim().toUpperCase();
    if (ref) pendingReferral = ref;
    try { referralsOn = !!(await api.get('/api/auth/referrals')).enabled; } catch (_e) { referralsOn = false; }
    if (!referralsOn) pendingReferral = '';
    if (location.search) history.replaceState(null, '', location.pathname); // tidy the URL
    try {
      const { user, hasProfile } = await api.get('/api/auth/me');
      state.me = user;
      if (!hasProfile) return renderProfileEditor(true);
      return enterApp();
    } catch (e) {
      if (e.data && e.data.suspended) return showSuspendedScreen(e.data);
      return renderAuth(wantSignup || pendingReferral ? 'signup' : 'login');
    }
  }

  // Full-screen notice for a suspended account. Shown at boot for a suspended
  // session, or live if a suspension lands mid-session (report-abuse).
  let suspendedShown = false;
  function showSuspendedScreen(data) {
    if (suspendedShown) return;
    suspendedShown = true;
    try { if (state.socket) state.socket.disconnect(); } catch (_e) { /* ignore */ }
    const until = data && data.suspendedUntil ? new Date(data.suspendedUntil).toLocaleString() : null;
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="auth-split">
        <div class="auth-card" style="max-width:460px;margin:10vh auto;text-align:center">
          <div style="font-size:40px">⛔</div>
          <h2>Account suspended</h2>
          <p class="auth-sub">${esc((data && data.error) || 'Your account is temporarily suspended.')}</p>
          ${data && data.reason ? `<p class="hint">Reason: ${esc(data.reason)}</p>` : ''}
          ${until ? `<p class="hint">Access returns on <b>${esc(until)}</b>.</p>` : ''}
          <button class="ghost" id="suspLogout" style="margin-top:14px">Log out</button>
        </div>
      </div>
    `));
    const lo = document.getElementById('suspLogout');
    if (lo) lo.addEventListener('click', async () => {
      try { await api.post('/api/auth/logout', {}); } catch (_e) { /* ignore */ }
      location.reload();
    });
  }
  window.__onSuspended = showSuspendedScreen;

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
        <p class="auth-sub">${mode === 'login' ? 'Welcome back.' : 'Create your account.'}</p>
        <form id="authForm">
          ${mode === 'signup' ? `
            <label>Username</label>
            <input name="username" autocomplete="username" placeholder="3-20 letters, numbers, _" required />
            <label>Email</label>
            <input name="email" type="email" autocomplete="email" placeholder="Your email address" required />
            <label>Password</label>
            <input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required />
            <label>Minimum education</label>
            ${selectHtml('suEducation', OPT.education, '', 'Select your education', 'name="education" required')}
            <label>Education stream</label>
            ${selectHtml('suStream', OPT.educationStream, '', 'Select your stream', 'name="educationStream" required')}
            <label>Working status</label>
            ${selectHtml('suWork', OPT.workStatus, '', 'Select your working status', 'name="workStatus" required')}
            ${referralsOn ? `<label>Referral code <span class="hint">(optional)</span></label>
            <input name="referralCode" maxlength="16" autocomplete="off" placeholder="If someone referred you" value="${esc(pendingReferral)}" style="text-transform:uppercase" />` : ''}
            <div class="checkbox-row">
              <input type="checkbox" name="termsAccepted" id="terms" />
              <label for="terms" style="margin:0">I agree to the <a href="/terms" target="_blank" rel="noopener">terms</a>.</label>
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
            education: fd.get('education'),
            educationStream: fd.get('educationStream'),
            workStatus: fd.get('workStatus'),
            termsAccepted: fd.get('termsAccepted') === 'on',
            referralCode: String(fd.get('referralCode') || '').trim(),
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
    // The academic fields were chosen at signup; prefill them from the account.
    const me = state.me || {};
    const edu = {
      education: e.education || me.education || '',
      educationStream: e.educationStream || me.educationStream || '',
      workStatus: e.workStatus || me.workStatus || '',
    };
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
            <label>Minimum education <span class="req">*</span></label>
            ${selectHtml('education', OPT.education, edu.education, 'Select…')}
          </div>
          <div>
            <label>Education stream <span class="req">*</span></label>
            ${selectHtml('educationStream', OPT.educationStream, edu.educationStream, 'Select…')}
          </div>
          <div>
            <label>Working status <span class="req">*</span></label>
            ${selectHtml('workStatus', OPT.workStatus, edu.workStatus, 'Select…')}
          </div>
          <div>
            <label>State</label>
            <select id="state" disabled><option value="">Select country first</option></select>
          </div>
          <div>
            <label>City</label>
            <select id="citySelect" disabled><option value="">Select state first</option></select>
            <input id="cityCustom" class="hidden" maxlength="80" placeholder="Type your city" style="margin-top:6px" />
          </div>
        </div>

        <label>About me</label>
        <textarea id="about" maxlength="500" placeholder="Tell people a bit about you">${esc(e.about || '')}</textarea>

        <label>Areas of interest <span class="hint" id="interestCount"></span></label>
        <div id="interestPicker">
          ${OPT.interestGroups.map((g) => `
            <div class="interest-group">
              <div class="interest-group-title">${esc(g.group)}</div>
              <div class="chip-picker">
                ${g.items.map((i) =>
                  `<label class="chip${selectedInterests.has(i) ? ' on' : ''}"><input type="checkbox" value="${esc(i)}"${selectedInterests.has(i) ? ' checked' : ''}/>${esc(i)}</label>`
                ).join('')}
              </div>
            </div>`).join('')}
        </div>

        <div class="privacy-toggle">
          <label class="switch-row">
            <input type="checkbox" id="hidden"${e.hidden ? ' checked' : ''} />
            <span>Hide my profile from search</span>
          </label>
          <div class="hint">When on, other people can't find you by searching or browsing. Your existing friends and chats are unaffected.</div>
        </div>

        <!-- Stays pinned to the bottom of the screen while the long form scrolls. -->
        <div class="profile-save-bar">
          <div class="msg" id="pMsg"></div>
          <div class="row-actions">
            <button class="primary" id="saveProfile" type="button">${firstTime ? 'Create profile' : 'Save'}</button>
            ${firstTime ? '' : '<button class="ghost" id="backBtn" type="button">Cancel</button>'}
          </div>
        </div>
      </div></div>
    `);
    root.appendChild(wrap);

    let avatarFile = null;
    const avInput = wrap.querySelector('#avatarInput');
    wrap.querySelector('#pickAvatar').addEventListener('click', () => avInput.click());
    avInput.addEventListener('change', async () => {
      const picked = avInput.files[0] || null;
      avInput.value = '';
      if (!picked) return;
      const cropped = await cropImage(picked); // let the user keep just part of it
      if (!cropped) return; // cancelled
      avatarFile = cropped;
      wrap.querySelector('#avPreview').src = URL.createObjectURL(avatarFile);
    });

    // Toggle chip highlight with its checkbox. Any number may be picked.
    const interestBoxes = Array.from(wrap.querySelectorAll('#interestPicker input'));
    const syncInterests = () => {
      const n = interestBoxes.filter((c) => c.checked).length;
      wrap.querySelector('#interestCount').textContent = `${n} selected`;
    };
    interestBoxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        cb.closest('.chip').classList.toggle('on', cb.checked);
        syncInterests();
      });
    });
    syncInterests();

    // Cascading location: country → state → city. The city list ends with a
    // "not listed" option that reveals a free-text box.
    const CITY_OTHER = '__other__';
    const countrySel = wrap.querySelector('#country');
    const stateSel = wrap.querySelector('#state');
    const citySel = wrap.querySelector('#citySelect');
    const cityCustom = wrap.querySelector('#cityCustom');
    const fillSelect = (sel, items, placeholder, current) => {
      sel.innerHTML = `<option value="">${esc(placeholder)}</option>` +
        items.map((i) => `<option value="${esc(i)}"${i === current ? ' selected' : ''}>${esc(i)}</option>`).join('');
    };
    const showCustomCity = (on, value) => {
      cityCustom.classList.toggle('hidden', !on);
      if (value != null) cityCustom.value = value;
    };
    async function loadCities(current) {
      showCustomCity(false, '');
      const st = stateSel.value;
      if (!st) {
        fillSelect(citySel, [], 'Select state first');
        citySel.disabled = true;
        return;
      }
      let cities = [];
      try {
        cities = (await api.get('/api/geo/cities?country=' + encodeURIComponent(countrySel.value) +
          '&state=' + encodeURIComponent(st))).cities;
      } catch (_e) { /* fall back to typing the city */ }
      fillSelect(citySel, cities, 'Select city', current);
      citySel.insertAdjacentHTML('beforeend', `<option value="${CITY_OTHER}">My city is not listed (type it)</option>`);
      citySel.disabled = false;
      if (current && !cities.includes(current)) {
        citySel.value = CITY_OTHER;
        showCustomCity(true, current);
      }
    }
    async function loadStates(current, currentCity) {
      const c = countrySel.value;
      let states = [];
      if (c) {
        try { states = (await api.get('/api/geo/states?country=' + encodeURIComponent(c))).states; } catch (_e) {}
      }
      fillSelect(stateSel, states, !c ? 'Select country first' : states.length ? 'Select state' : 'No states listed', current);
      stateSel.disabled = !states.length;
      await loadCities(currentCity);
    }
    countrySel.addEventListener('change', () => loadStates(null, null));
    stateSel.addEventListener('change', () => loadCities(null));
    citySel.addEventListener('change', () => {
      const other = citySel.value === CITY_OTHER;
      showCustomCity(other, other ? undefined : '');
      if (other) cityCustom.focus();
    });
    loadStates(e.state || null, e.city || null);

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
      fd.append('state', stateSel.value);
      fd.append('city', citySel.value === CITY_OTHER ? cityCustom.value.trim() : citySel.value);
      fd.append('education', val('education'));
      fd.append('educationStream', val('educationStream'));
      fd.append('workStatus', val('workStatus'));
      fd.append('about', val('about'));
      fd.append('interests', JSON.stringify(interests));
      fd.append('hidden', wrap.querySelector('#hidden').checked ? '1' : '0');
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
            <button data-view="notifications">🔔 Notifications <span class="req-badge hidden" id="notifBadge">0</span></button>
            <button data-view="highway">🌊 Highway</button>
            <button data-view="requests">🤝 Requests <span class="req-badge hidden" id="reqBadge">0</span></button>
            <button data-view="quizzes">🧠 Quizzes</button>
            <button data-view="polls">📊 Polls</button>
            <button data-view="blogs">📝 Blogs</button>
            <button data-view="leaderboard">🏆 Leaderboard<span class="ndot"></span></button>
            <button data-view="events">✨ Recent Activity</button>
          </div>
          <div class="search"><input id="searchInput" placeholder="Search people…" /></div>
          <div class="list" id="list"></div>
        </aside>
        <div class="main-col">
          <div class="mobile-bar">
            <button class="ghost small" id="mobileBack" title="Back to the dashboard">← Dashboard</button>
            <span class="mobile-bar-title" id="mobileBarTitle"></span>
          </div>
          <section class="main" id="main"></section>
        </div>
      </div>
    `);
    root.appendChild(shell);
    setupMobileBack(shell);

    // Load my avatar into the topbar (and remember it for chat rows).
    api.get('/api/profile/me').then(({ profile }) => {
      if (profile && profile.avatar) {
        state.myAvatar = profile.avatar;
        shell.querySelector('#myAvatar').src = profile.avatar;
      }
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
    renderList();
    renderMainHome(); // chat box shows the recent-activity feed by default
    refreshRequestBadge();
    refreshNotifBadge();
    loadGifts(); // preload so live gifts render with the right emoji/name
    loadIgnored(); // so live Highway pushes from ignored users are filtered

    // Honor a "view X's profile" deep link from a shared profile link — the
    // recipient lands straight on that member's profile after signing up / in.
    if (pendingViewUser) {
      const u = pendingViewUser;
      pendingViewUser = null;
      showProfile(u);
    } else if (pendingChatUser) {
      // Honor a "chat with X" deep link from a shared quiz result page.
      const u = pendingChatUser;
      pendingChatUser = null;
      openChatByUsername(u);
    }
  }

  // Phones show either the sidebar (the dashboard) or the main pane, never both
  // (.viewing-main). The mobile bar above the main pane always offers a way
  // back to the dashboard, and the phone's own Back button does the same.
  function setupMobileBack(shell) {
    const phone = window.matchMedia('(max-width: 720px)');
    const title = shell.querySelector('#mobileBarTitle');
    const toDashboard = () => {
      shell.classList.remove('viewing-main');
      closeReactionPalette();
      resetAvatars();
      state.peer = null;
      state.group = null;
      shell.querySelectorAll('#exploreNav button').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.list-item').forEach((r) => r.classList.remove('active'));
    };
    const label = () => {
      const active = shell.querySelector('#exploreNav button.active');
      if (active) return active.textContent.replace(/\d+$/, '').trim();
      if (state.peer) return state.peer.displayName || '@' + state.peer.username;
      if (state.group) return '👥 Group chat';
      return 'getxmatch';
    };
    // Each switch to the main pane on a phone adds one history entry, so Back
    // returns to the dashboard instead of leaving the app.
    new MutationObserver(() => {
      if (!shell.classList.contains('viewing-main')) return;
      title.textContent = label();
      if (phone.matches && !(history.state && history.state.gxMain)) history.pushState({ gxMain: 1 }, '');
    }).observe(shell, { attributes: true, attributeFilter: ['class'] });
    // Section switches inside the main pane don't touch the class; refresh the
    // title on any sidebar click too.
    shell.querySelector('.sidebar').addEventListener('click', () => setTimeout(() => { title.textContent = label(); }, 0));
    window.addEventListener('popstate', () => {
      if (shell.isConnected && shell.classList.contains('viewing-main')) toDashboard();
    });
    shell.querySelector('#mobileBack').addEventListener('click', () => {
      if (history.state && history.state.gxMain) history.back(); // → popstate → toDashboard
      else toDashboard();
    });
  }

  // Update the sidebar "Requests" badge with the number of incoming requests
  // (pending friend requests + group invites). When that count grows — and the
  // Requests view isn't already open — blink the button to draw attention.
  let lastReqCount = null;
  // Unread count on the Notifications nav button.
  async function refreshNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    try {
      const { unread } = await api.get('/api/notifications/count');
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.classList.toggle('hidden', !unread || isExploreActive('notifications'));
      if (unread && !isExploreActive('notifications')) markNav('notifications', true);
    } catch (_e) { /* ignore */ }
  }

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
          ${avatarWithPresence(u.id, u.avatar, '')}
          <div style="min-width:0">
            <div class="name">${esc(u.displayName || u.username)}</div>
            <div class="handle">@${esc(u.username)}</div>
          </div>
        </div>
      `);
      if (state.peer && state.peer.id === u.id) row.classList.add('active');
      // Only friends can chat: searching for anyone else opens their profile.
      row.addEventListener('click', () => (state.tab === 'people' && !u.isFriend ? showProfile(u.username) : openChat(u)));
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
        `<div style="padding:20px;color:var(--muted)">No friends yet.<br><span class="hint">Search above to find people, follow them or send a friend request. Only friends can chat.</span></div>`
      ));
      return;
    }
    seedOnline(friends);
    friends.forEach((u) => {
      const row = el(`
        <div class="list-item" data-id="${u.id}">
          ${avatarWithPresence(u.id, u.avatar, '')}
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
      <label class="hint" for="gcName">Group name (optional)</label>
      <input type="text" id="gcName" maxlength="60" placeholder="e.g. Weekend plans" autocomplete="off" dir="auto" />
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
        const name = card.querySelector('#gcName').value.trim();
        const { group } = await api.post('/api/groups', { name, invite });
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
    try { const r = await api.get('/api/groups/' + gid + '/messages'); messages = r.messages || []; } catch (_e) {}

    state.peer = null;
    state.group = { gid, name: group.name, members: group.members, max: group.max };
    closeReactionPalette();
    registerGroupTab({ gid, name: group.name });
    document.querySelectorAll('.list-item').forEach((r) => r.classList.remove('active'));
    document.getElementById('shell').classList.add('viewing-main');

    const joined = group.members.filter((m) => m.status === 'joined');
    const pending = group.members.filter((m) => m.status === 'invited');
    const isOwner = !!(state.me && group.createdBy === state.me.id);
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
          <button class="ghost small" id="groupCallBtn" title="Start or join the group's video call">📹 Call</button>
          <button class="ghost small" id="groupAddBtn" title="Add someone">＋ Add</button>
          ${isOwner ? '<button class="ghost small" id="groupRenameBtn" title="Rename this group">✎ Rename</button>' : ''}
          ${isOwner
            ? '<button class="ghost small" id="groupDeleteBtn" title="Delete this group for everyone">Delete</button>'
            : '<button class="ghost small" id="groupLeaveBtn" title="Leave this group">Leave</button>'}
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="composer-preview hidden" id="composerPreview"></div>
        <div class="composer">
          <input type="text" id="msgInput" placeholder="Message the group…" autocomplete="off" dir="auto" />
          <button class="icon-btn" id="pollBtn" title="Create a poll">📊</button>
          <button class="primary" id="sendBtn">Send</button>
        </div>
      </div>
    `);
    main.appendChild(view);
    renderChatTabs();

    // Fresh profile-picture registry for this group; rotate every 20s. Seed each
    // joined member so their pictures start cycling even before they speak.
    resetAvatars();
    startAvatarRotation();
    ensureAvatars(state.me && state.me.id, state.myAvatar);
    joined.forEach((mem) => ensureAvatars(mem.id, mem.avatar));

    view.querySelector('#backToList').addEventListener('click', () => {
      document.getElementById('shell').classList.remove('viewing-main');
      state.group = null;
    });
    view.querySelector('#groupAddBtn').addEventListener('click', () => openGroupAdder(state.group));
    view.querySelector('#groupCallBtn').addEventListener('click', () =>
      startCall({ kind: 'group', groupId: gid, name: group.name }));
    reflectGroupCall(group.callCount || 0);
    const leaveBtn = view.querySelector('#groupLeaveBtn');
    if (leaveBtn) leaveBtn.addEventListener('click', async () => {
      if (!confirm('Leave this group chat?')) return;
      try { await api.post('/api/groups/' + gid + '/leave', {}); } catch (e) { return notify(e.message); }
      closeChatTab('g' + gid);
    });
    const renameBtn = view.querySelector('#groupRenameBtn');
    if (renameBtn) renameBtn.addEventListener('click', async () => {
      const name = prompt('Group name (leave empty to use members\' names):', group.name);
      if (name === null) return;
      try { await api.put('/api/groups/' + gid, { name: name.trim() }); } catch (e) { return notify(e.message); }
      openGroup(gid);
    });
    const deleteBtn = view.querySelector('#groupDeleteBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this group chat for everyone? All its messages will be removed.')) return;
      try { await api.del('/api/groups/' + gid); } catch (e) { return notify(e.message); }
      closeChatTab('g' + gid);
      if (state.tab === 'chats') renderList();
    });

    const input = view.querySelector('#msgInput');
    const send = () => sendGroupMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    input.addEventListener('input', () => updateComposerPreview(input.value));
    // Put the cursor in the composer right away so the user can type at once.
    setTimeout(() => input.focus(), 0);

    // Poll builder.
    view.querySelector('#pollBtn').addEventListener('click', () => openPollBuilder({ groupId: gid }));

    messages.forEach(appendGroupMessage);
    scrollBody();
  }

  // Show whether the open group has a call running ("Join call (2)").
  function reflectGroupCall(count) {
    const btn = document.getElementById('groupCallBtn');
    if (!btn) return;
    btn.classList.toggle('live', count > 0);
    btn.textContent = count > 0 ? `📹 Join call (${count})` : '📹 Call';
    btn.title = count > 0 ? 'A video call is in progress — join it' : "Start the group's video call";
  }

  function sendGroupMessage(input) {
    const body = input.value.trim();
    if (!body || !state.socket || !state.group) return;
    const gid = state.group.gid;
    input.value = '';
    clearComposerPreview();
    state.socket.emit('group:message', { groupId: gid, body }, (res) => {
      if (res && res.error) { notify(res.error); input.value = body; updateComposerPreview(body); }
    });
  }

  // Render a group message bubble. Others' messages show the sender's name.
  function appendGroupMessage(m) {
    const b = chatBody();
    if (!b) return;
    if (m.kind === 'poll') return appendPollBubble(m);
    const narration = narrationText(m.body);
    if (narration != null) {
      return appendNarrationLine(narration, m.at, { author: m.mine ? 'You' : m.fromName });
    }
    const side = m.mine ? 'me' : 'them';
    const bubble = el(`<div class="bubble ${side}"></div>`);
    if (!m.mine) bubble.appendChild(el(`<div class="bubble-author">${esc(m.fromName)}</div>`));
    appendRichText(bubble, m.body);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    mountBubble(bubble, m);
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
    state.peer = null;
    closeReactionPalette();
    resetAvatars(); // stop the in-chat picture rotation
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
          <div id="homeAlerts"></div>
          <div id="homeFeed"></div>
        </div>
      </div>`;
    renderChatTabs();
    wireActivityShare();
    renderAlertsInto(document.getElementById('homeAlerts'));
    renderActivityInto(document.getElementById('homeFeed'), { compact: false });
  }

  // Alerts: the latest news about the admin's keywords (from the websites the
  // admin chose) for the member's chosen country, above the activity feed. The
  // country picker here also sets which country's news the feed shows. An ad
  // from the "alerts_inline" placement sits after the first few alerts.
  async function renderAlertsInto(box, data) {
    if (!box) return;
    if (!data) {
      try { data = await api.get('/api/events/alerts'); } catch (_e) { return; }
    }
    try { await loadAds(); } catch (_e) { /* ads are optional */ }
    if (!document.body.contains(box)) return;
    const items = (data.alerts || []).filter((a) => /^https?:\/\//i.test(a.link));
    const keywords = data.keywords || [];
    const SHOW = 5;
    const panel = el(`
      <section class="alerts-panel card">
        <div class="alerts-head"><span>🔔 Alerts</span><span class="hint alerts-kw"></span></div>
        <label class="alerts-country hint">🌍 Alerts &amp; news for <select></select> <span class="alerts-busy"></span></label>
        <div class="alerts-list"></div>
      </section>`);
    panel.querySelector('.alerts-kw').textContent = keywords.join(' · ');

    // Country picker: '' follows the profile country.
    const sel = panel.querySelector('select');
    const opts = [{ value: '', label: data.chosen ? 'My profile country' : `My profile country (${data.country})` },
      { value: 'Worldwide', label: 'Worldwide' }].concat((data.countries || []).map((c) => ({ value: c, label: c })));
    opts.forEach((o) => sel.appendChild(Object.assign(document.createElement('option'), { value: o.value, textContent: o.label })));
    sel.value = data.chosen ? data.country : '';
    sel.addEventListener('change', async () => {
      const busy = panel.querySelector('.alerts-busy');
      sel.disabled = true;
      busy.textContent = 'Loading…';
      let next;
      try { next = await api.put('/api/events/news-country', { country: sel.value }); }
      catch (e) { sel.disabled = false; busy.textContent = e.message; return; }
      renderAlertsInto(box, next);
      const feed = document.getElementById('homeFeed');
      if (feed) renderActivityInto(feed, { compact: false });
    });

    const list = panel.querySelector('.alerts-list');
    if (keywords.length && !items.length) {
      list.appendChild(el(`<p class="hint alerts-empty"></p>`)).textContent =
        data.country === 'Worldwide' ? 'No alerts right now.' : `No alerts for ${data.country} right now.`;
    }
    const ad = slotEl('alerts_inline');
    if (ad) ad.classList.add('ad-stream');
    items.forEach((a, i) => {
      const row = el(`<div class="alert-item${i >= SHOW ? ' hidden' : ''}">
          <a class="alert-link" target="_blank" rel="noopener noreferrer nofollow"></a>
          <div class="hint alert-meta"></div>
        </div>`);
      const link = row.querySelector('a');
      link.href = a.link;
      link.textContent = a.title;
      const where = data.country === 'Worldwide' && a.country ? ` · ${a.country}` : '';
      row.querySelector('.alert-meta').textContent = `${a.source} · ${a.keyword}${where} · ${fmtDate(a.at)} ${fmtTime(a.at)}`;
      list.appendChild(row);
      if (ad && i === 2) list.appendChild(ad);
    });
    if (ad && !ad.parentNode) list.appendChild(ad);
    if (items.length > SHOW) {
      const more = el(`<button class="ghost small alerts-more" type="button">Show ${items.length - SHOW} more</button>`);
      more.addEventListener('click', () => {
        list.querySelectorAll('.alert-item.hidden').forEach((r) => r.classList.remove('hidden'));
        more.remove();
      });
      panel.appendChild(more);
    }

    // Job openings from the admin's job-board feeds, for the country the
    // member picks here (by default their alerts country), plus jobs anywhere.
    // Members apply on the job board itself.
    const jobItems = (data.jobs || []).filter((j) => /^https?:\/\//i.test(j.link));
    const jobCountries = data.jobCountries || [];
    if (jobItems.length || jobCountries.length) {
      const sec = el(`<div class="alerts-jobs">
          <label class="alerts-sub alerts-country">💼 Jobs in <select></select> <span class="alerts-busy hint"></span></label>
          <div class="alerts-list"></div>
        </div>`);
      const jsel = sec.querySelector('select');
      const jopts = [{ value: '', label: data.jobsChosen ? 'Same as alerts' : `Same as alerts (${data.jobsCountry})` },
        { value: 'Worldwide', label: 'All countries' }];
      const listed = jobCountries.slice();
      if (data.jobsChosen && data.jobsCountry !== 'Worldwide' && !listed.includes(data.jobsCountry)) listed.push(data.jobsCountry);
      listed.forEach((c) => jopts.push({ value: c, label: c }));
      jopts.forEach((o) => jsel.appendChild(Object.assign(document.createElement('option'), { value: o.value, textContent: o.label })));
      jsel.value = data.jobsChosen ? data.jobsCountry : '';
      jsel.addEventListener('change', async () => {
        const busy = sec.querySelector('.alerts-busy');
        jsel.disabled = true;
        busy.textContent = 'Loading…';
        try { renderAlertsInto(box, await api.put('/api/events/jobs-country', { country: jsel.value })); }
        catch (e) { jsel.disabled = false; busy.textContent = e.message; }
      });
      const jl = sec.querySelector('.alerts-list');
      if (!jobItems.length) {
        jl.appendChild(el('<p class="hint alerts-empty"></p>')).textContent =
          data.jobsCountry === 'Worldwide' ? 'No job openings right now.' : `No job openings for ${data.jobsCountry} right now.`;
      }
      jobItems.forEach((j, i) => {
        const row = el(`<div class="alert-item${i >= SHOW ? ' hidden' : ''}">
            <a class="alert-link" target="_blank" rel="noopener noreferrer nofollow"></a>
            <div class="hint alert-meta"></div>
          </div>`);
        const link = row.querySelector('a');
        link.href = j.link;
        link.textContent = j.title;
        const where = data.jobsCountry === 'Worldwide' && j.country ? ` · ${j.country}` : '';
        row.querySelector('.alert-meta').textContent = `${j.source}${where} · ${fmtDate(j.at)}`;
        jl.appendChild(row);
      });
      if (jobItems.length > SHOW) {
        const more = el(`<button class="ghost small alerts-more" type="button">Show ${jobItems.length - SHOW} more jobs</button>`);
        more.addEventListener('click', () => {
          jl.querySelectorAll('.alert-item.hidden').forEach((r) => r.classList.remove('hidden'));
          more.remove();
        });
        sec.appendChild(more);
      }
      panel.appendChild(sec);
    }
    box.innerHTML = '';
    box.appendChild(panel);
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

  // Reflect the user's own current activity into the picker. Reads the live DOM
  // so it works from both the picker and the cross-tab sync handler.
  function reflectMineActivity(activity) {
    const select = document.getElementById('activitySelect');
    if (!select) return;
    const list = state.activities || [];
    select.value = activity && list.includes(activity) ? activity : '';
  }

  async function setupActivityBar(view, peer) {
    const bar = view.querySelector('#activityBar');
    const select = view.querySelector('#activitySelect');
    const activities = await loadActivities();
    if (!state.peer || state.peer.id !== peer.id || !document.body.contains(select)) return;

    // Predefined verbs only (no free text — it shows on the public feed).
    select.innerHTML = '<option value="">— nothing —</option>' +
      activities.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
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

    select.addEventListener('change', () => send(select.value)); // a verb, or "" to clear
  }

  async function openChat(peer) {
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
          <button class="ghost small" id="callBtn" title="Start a video call">📹 Call</button>
          <button class="ghost small" id="screenShareBtn" title="Share a browser tab with this person">🖥️ Share screen</button>
          <button class="ghost small" id="makeGroupBtn" title="Start a group chat with this person and others">👥 Group</button>
        </div>
        <div class="chat-activity-bar hidden" id="activityBar">
          <div class="activity-status" id="activityStatus"></div>
          <button class="icon-btn small" id="activityImgBtn" type="button" title="Share an image / GIF to Recent Activity (max 5 MB)">🖼️</button>
          <input type="file" id="activityImgFile" accept="image/*" class="hidden" />
          <label class="activity-pick">
            <span>You're…</span>
            <select id="activitySelect"><option value="">— nothing —</option></select>
          </label>
        </div>
        <div class="chat-stage">
          <div class="chat-body" id="chatBody"></div>
        </div>
        <div class="typing hidden" id="typing">typing…</div>
        <div class="gift-picker hidden" id="giftPicker"></div>
        <div class="reply-banner hidden" id="replyBanner"></div>
        <div class="composer-preview hidden" id="composerPreview"></div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="attachBtn" title="Share a file (delivered live, never stored)">📎</button>
          <button class="icon-btn" id="giftBtn" title="Send a gift">🎁</button>
          <button class="icon-btn" id="pollBtn" title="Create a poll">📊</button>
          <button class="icon-btn" id="quizBtn" title="Take a quiz together">🧩</button>
          <input type="text" id="msgInput" placeholder="Type a message…" autocomplete="off" dir="auto" />
          <button class="primary" id="sendBtn">Send</button>
        </div>
      </div>
    `);
    main.appendChild(view);
    renderChatTabs();

    // Fresh profile-picture registry for this conversation; rotate every 20s.
    resetAvatars();
    startAvatarRotation();
    ensureAvatars(state.me && state.me.id, state.myAvatar);
    ensureAvatars(peer.id, peer.avatar);

    view.querySelector('#backToList').addEventListener('click', () => {
      document.getElementById('shell').classList.remove('viewing-main');
      closeReactionPalette();
      state.peer = null;
    });
    const openPeerProfile = () => showProfile(peer.username);
    view.querySelector('#peerAvatar').addEventListener('click', openPeerProfile);
    view.querySelector('#peerName').addEventListener('click', openPeerProfile);
    view.querySelector('#makeGroupBtn').addEventListener('click', () => openGroupCreator(peer));
    view.querySelector('#screenShareBtn').addEventListener('click', () => toggleScreenShare(peer));
    view.querySelector('#callBtn').addEventListener('click', () =>
      startCall({ kind: 'dm', to: peer.id, name: peer.displayName || peer.username }));
    reflectScreenShare(peer.id);


    setupActivityBar(view, peer);

    const input = view.querySelector('#msgInput');
    const send = () => sendMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    input.addEventListener('input', () => {
      if (state.socket) state.socket.emit('chat:typing', { to: peer.id });
      updateComposerPreview(input.value);
    });
    // Put the cursor in the composer right away so the user can type at once.
    setTimeout(() => input.focus(), 0);

    const fileInput = view.querySelector('#fileInput');
    view.querySelector('#attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) sendFile(fileInput.files[0]);
      fileInput.value = '';
    });


    // Gift picker.
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

    // Poll builder.
    view.querySelector('#pollBtn').addEventListener('click', () => openPollBuilder({ to: peer.id }));
    // Quiz picker — start a quiz to attempt together.
    view.querySelector('#quizBtn').addEventListener('click', () => openQuizPicker(peer.id));

    // Load persisted history (text + gifts).
    adState.counters.chat = 0; // restart the every-20-messages ad cadence per chat
    try {
      const { messages, canChat } = await api.get(`/api/users/${peer.id}/messages`);
      // Only friends can chat: swap the composer for a notice otherwise.
      if (canChat === false && state.peer && state.peer.id === peer.id) lockChatComposer(view, peer);

      // Shared files aren't stored on the server; they're kept in THIS browser's
      // IndexedDB so they survive a refresh (per user/device). Fall back to the
      // in-memory session cache if IndexedDB is unavailable.
      let files = await idbLoadFiles(peer.id);
      if (files == null) files = ((state.sharedFiles && state.sharedFiles[peer.id]) || []).slice();

      // Interleave persisted messages (text, gifts, links, …) with the shared
      // files by timestamp so history stays chronological. Previously every file
      // was appended AFTER all messages, which pushed shared media to the bottom
      // on reload no matter when it was actually sent. Guard against the user
      // having switched chats while the awaits above were in flight.
      if (state.peer && state.peer.id === peer.id) {
        const timeline = [];
        messages.forEach((m) => timeline.push({ at: m.at, seq: 0, render: () => appendMessage(m) }));
        files.forEach((e) => timeline.push({ at: e.at, seq: 1, render: () => appendFileBubble(e, e.mine, e.url) }));
        // Sort by time; on an exact tie keep text before a file, matching the
        // order they were first shown live. (Array.sort is stable.)
        timeline.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
        timeline.forEach((it) => it.render());
        markChatRead();
      }
    } catch (_e) {}
    scrollBody();
  }

  // Replace a conversation's composer (and its share / group / activity
  // controls) with a "friends only" notice and a way to their profile.
  function lockChatComposer(view, peer) {
    ['.composer', '#activityBar', '#callBtn', '#screenShareBtn', '#makeGroupBtn', '#giftPicker'].forEach((sel) => {
      const n = view.querySelector(sel);
      if (n) n.remove();
    });
    const note = el(`<div class="chat-locked">🔒 Only friends can chat. <button class="primary small">View profile</button></div>`);
    note.querySelector('button').addEventListener('click', () => showProfile(peer.username));
    view.appendChild(note);
  }

  function chatBody() { return document.getElementById('chatBody'); }

  // True when the view is already at (or very near) the newest message.
  function isNearBottom(b, px) {
    if (!b) return false;
    return b.scrollHeight - b.scrollTop - b.clientHeight <= (px == null ? 140 : px);
  }

  // Keep the newest message in view. Scrolling to scrollHeight once isn't
  // enough: avatars, shared images and link embeds finish loading *after* the
  // message is rendered and grow the content, which would otherwise leave the
  // last message below the fold. So we re-pin on the next frame and again as
  // each image loads — but only while the user is still parked at the bottom,
  // so scrolling up to read history is never yanked back down.
  function scrollBody() {
    const b = chatBody();
    if (!b) return;
    const jump = () => { b.scrollTop = b.scrollHeight; };
    jump();
    requestAnimationFrame(jump);
    if (!b._pinBound) {
      b._pinBound = true;
      // `load` doesn't bubble, so listen in the capture phase.
      b.addEventListener('load', (e) => {
        if (e.target && e.target.tagName === 'IMG' && isNearBottom(b)) b.scrollTop = b.scrollHeight;
      }, true);
    }
  }

  /* ---------- in-chat profile pictures (rotating buffer) ----------
     Each message row shows the sender's picture at the moment it was rendered,
     drawn from that user's "profile picture buffer". A timer re-rolls each
     user's *current* picture to a random one every 20s, but that only affects
     messages rendered afterwards — pictures already attached to earlier
     messages are left untouched (a message keeps the face it was sent with).
     Registry maps user id -> { list:[urls], idx }. */
  const chatAv = { map: new Map(), timer: null };

  function currentAv(uid) {
    const e = chatAv.map.get(uid);
    return e && e.list.length ? e.list[e.idx % e.list.length] : null;
  }

  // Fill in rows that were rendered before this user's buffer finished loading
  // (they carry data-pending). One-time only — this never repaints a row that
  // already has its picture, so history stays frozen once shown.
  function fillPendingAvatars(uid) {
    const url = currentAv(uid);
    if (!url) return;
    document
      .querySelectorAll(`.chat-av[data-uid="${uid}"][data-pending]`)
      .forEach((img) => { img.src = url; img.removeAttribute('data-pending'); });
  }

  // Load a user's buffer pictures once, then fill any rows still waiting.
  // `fallback` (their single display picture) is shown until the fetch resolves.
  // `loaded` stays false until then, so rows rendered in the meantime are marked
  // pending and get upgraded to a buffer picture exactly once.
  function ensureAvatars(uid, fallback) {
    if (uid == null) return;
    if (chatAv.map.has(uid)) return;
    chatAv.map.set(uid, { list: fallback ? [fallback] : [], idx: 0, loaded: false });
    api.get(`/api/users/${uid}/avatars`).then(({ avatars }) => {
      const e = chatAv.map.get(uid);
      if (!e) return;
      e.loaded = true;
      if (Array.isArray(avatars) && avatars.length) {
        e.list = avatars;
        e.idx = Math.floor(Math.random() * avatars.length);
      }
      fillPendingAvatars(uid);
    }).catch(() => {});
  }

  function startAvatarRotation() {
    if (chatAv.timer) return;
    // Advance each user's current picture only; already-rendered rows are left
    // as-is, so a picture change never rewrites past messages.
    chatAv.timer = setInterval(() => {
      chatAv.map.forEach((e) => {
        if (e.list.length > 1) e.idx = Math.floor(Math.random() * e.list.length);
      });
    }, 20000);
  }

  // Reset the registry when opening a conversation (or leaving chat) so a new
  // chat starts fresh and the old timer stops when nothing is open.
  function resetAvatars() {
    chatAv.map.clear();
    if (chatAv.timer) { clearInterval(chatAv.timer); chatAv.timer = null; }
  }

  // Wrap a finished bubble in a row with the sender's rotating profile picture,
  // append it to the chat body, and return the row. `m` is the message object
  // (m.mine, m.from, m.fromAvatar). All speech/gift/file bubbles go through here
  // so the chat visually "comes from" the picture on each side.
  function mountBubble(bubble, m) {
    const b = chatBody();
    if (!b) return null;
    const mine = !!(m && m.mine);
    const uid = mine
      ? (state.me && state.me.id)
      : (m && m.from != null ? m.from : (state.peer && state.peer.id));
    const fallback = mine
      ? state.myAvatar
      : (m && m.fromAvatar) || (state.peer && state.peer.avatar) || null;
    const row = el(`<div class="msg-row ${mine ? 'me' : 'them'}"></div>`);
    // Snapshot the current picture now. While the buffer is still loading, show
    // the fallback and mark the row pending so it's upgraded once (and only
    // once) to a buffer picture; after that the row's picture never changes.
    const entry = uid != null ? chatAv.map.get(uid) : null;
    const pending = !entry || !entry.loaded;
    const src = avatarUrl(currentAv(uid) || fallback);
    const img = el(`<img class="chat-av" data-uid="${uid == null ? '' : uid}"${pending ? ' data-pending' : ''} src="${esc(src)}" alt="" />`);
    if (uid && !mine) img.addEventListener('click', () => { if (state.peer) showProfile(state.peer.username); });
    row.appendChild(img);
    row.appendChild(bubble);
    b.appendChild(row);
    ensureAvatars(uid, fallback);
    // My stored 1:1 messages carry WhatsApp-style ticks after the time.
    if (mine && m.id && m.groupId == null) {
      const time = bubble.querySelector(':scope > .time');
      if (time) time.appendChild(tickEl(m.status));
    }
    return row;
  }

  /* ---------- read receipts (1:1) ----------
     ✓ sent · ✓✓ delivered · blue ✓✓ read. The server stamps delivery/read
     and pushes `chat:receipt`; the open, visible conversation reports itself
     read with `chat:read`. */
  const TICK_RANK = { sent: 0, delivered: 1, read: 2 };
  const TICK_LABEL = { sent: 'Sent', delivered: 'Delivered', read: 'Seen' };

  function tickEl(status) {
    const t = el('<span class="ticks"></span>');
    setTicks(t, status || 'sent');
    return t;
  }

  function setTicks(t, status) {
    // Ticks only ever move forward (a late "delivered" never undoes "read").
    if (t.dataset.status && TICK_RANK[t.dataset.status] >= TICK_RANK[status]) return;
    t.dataset.status = status;
    t.className = 'ticks ' + status;
    t.textContent = status === 'sent' ? '✓' : '✓✓';
    t.title = TICK_LABEL[status];
  }

  function applyReceipt(r) {
    if (!r || !state.peer || state.peer.id !== r.peerId || !Array.isArray(r.ids)) return;
    const b = chatBody();
    if (!b) return;
    r.ids.forEach((id) => {
      const t = b.querySelector(`.bubble[data-id="${Number(id)}"] .ticks`);
      if (t) setTicks(t, r.status);
    });
  }

  // Tell the server I've seen the open conversation (only while it's on screen).
  function markChatRead() {
    if (!state.socket || !state.peer || !chatBody()) return;
    if (document.visibilityState !== 'visible') return;
    state.socket.emit('chat:read', { peer: state.peer.id });
  }
  document.addEventListener('visibilitychange', markChatRead);
  window.addEventListener('focus', markChatRead);

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

  // True when a URL points at something we can render inline (a YouTube video,
  // an image file, or a direct video file).
  function isMediaUrl(url) {
    return !!youtubeId(url) || isImageUrl(url) || isVideoUrl(url);
  }

  // Build a playable/viewable DOM node for a media URL (YouTube embed, image, or
  // video), or null if the URL isn't media. `opts.onImgError` is called if an
  // image fails to load, so callers can fall back to a plain link.
  function createMediaNode(url, opts) {
    opts = opts || {};
    const yt = youtubeId(url);
    if (yt) {
      const f = document.createElement('iframe');
      f.className = 'msg-embed';
      f.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(yt);
      f.setAttribute('allow', 'accelerometer; encrypted-media; picture-in-picture');
      f.setAttribute('allowfullscreen', '');
      f.loading = 'lazy';
      return f;
    }
    if (isImageUrl(url)) {
      const link = document.createElement('a');
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      const img = document.createElement('img');
      img.className = 'msg-img'; img.loading = 'lazy'; img.src = url;
      if (opts.onImgError) img.addEventListener('error', opts.onImgError);
      link.appendChild(img);
      return link;
    }
    if (isVideoUrl(url)) {
      const v = document.createElement('video');
      v.className = 'msg-video'; v.controls = true; v.preload = 'metadata'; v.src = url;
      return v;
    }
    return null;
  }

  // Append `text` to `container`. Image / video / YouTube links are shown ONLY as
  // the inline thumbnail/player — the raw URL text is hidden. Any other URL stays
  // a normal clickable link. If an image link fails to load, its URL is restored
  // as a visible link so nothing is silently lost.
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
      last = m.index + url.length;

      if (isMediaUrl(url)) {
        let node;
        node = createMediaNode(url, {
          onImgError: () => {
            // Image didn't load — drop the broken thumbnail and show the URL as a
            // link instead, so the shared link is never lost.
            if (node && node.parentNode) node.remove();
            const a = document.createElement('a');
            a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
            a.className = 'msg-link'; a.textContent = url;
            textWrap.appendChild(document.createTextNode(' '));
            textWrap.appendChild(a);
          },
        });
        if (node) {
          media.appendChild(node); hasMedia = true;
          // URL text intentionally omitted — the media stands in for the link.
          continue;
        }
      }
      // Non-media URL: keep it visible as a clickable link.
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'msg-link'; a.textContent = url;
      textWrap.appendChild(a);
    }
    if (last < str.length) textWrap.appendChild(document.createTextNode(str.slice(last)));
    container.appendChild(textWrap);
    if (hasMedia) container.appendChild(media);
  }

  // ---- Composer live preview -------------------------------------------------
  // While the user is typing, any image / video / YouTube link they've entered is
  // previewed below the input as a thumbnail/player, shown ALONGSIDE the link
  // text (the URL stays in the input and is labelled in the preview). Cleared on
  // send. Both the 1:1 and group composers share one #composerPreview element.

  function extractMediaUrls(text) {
    const out = [];
    const re = new RegExp(URL_RE.source, 'gi');
    let m;
    while ((m = re.exec(String(text == null ? '' : text))) !== null) {
      if (isMediaUrl(m[0])) out.push(m[0]);
    }
    return out;
  }

  function updateComposerPreview(text) {
    const box = document.getElementById('composerPreview');
    if (!box) return;
    const urls = extractMediaUrls(text);
    const sig = urls.join('\n');
    // Rebuild only when the set of media links changes, so embeds don't reload on
    // every keystroke.
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    if (!urls.length) { box.classList.add('hidden'); return; }
    urls.forEach((url) => {
      const item = el('<div class="cp-item"></div>');
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.className = 'cp-link'; a.textContent = url;
      item.appendChild(a);
      const node = createMediaNode(url);
      if (node) item.appendChild(node);
      box.appendChild(item);
    });
    box.classList.remove('hidden');
  }

  function clearComposerPreview() {
    const box = document.getElementById('composerPreview');
    if (!box) return;
    box.dataset.sig = '';
    box.innerHTML = '';
    box.classList.add('hidden');
  }

  // Narration: a message whose body starts with "/" is narration/action text
  // ("*walks in and smiles*"), not speech. Returns the narration text (the part
  // after the leading "/"), or null if the message isn't narration. The "/" is
  // only a trigger as the FIRST character, so URLs like "/foo" mid-message
  // aren't affected — only when the whole message opens with "/". Narration is
  // rendered in a distinctly coloured box instead of a speech balloon (see the
  // .bubble.has-narration rules in the stylesheet).
  function narrationText(body) {
    const str = String(body == null ? '' : body);
    if (str[0] !== '/') return null;
    const rest = str.slice(1).trim();
    return rest ? rest : null;
  }

  // A narration/action line ("/…"): a standalone box centered in the chat,
  // not a side-attached speech bubble. `author` (optional) labels who narrated
  // in group chats.
  function appendNarrationLine(text, at, opts) {
    const b = chatBody();
    if (!b) return null;
    opts = opts || {};
    const line = el('<div class="narration-line"></div>');
    if (opts.id) line.dataset.id = opts.id;
    if (opts.author) line.appendChild(el(`<span class="nl-author">${esc(opts.author)}</span>`));
    line.appendChild(el('<span class="nl-text"></span>')).textContent = text;
    line.appendChild(el(`<span class="nl-time">${fmtTime(at)}</span>`));
    b.appendChild(line);
    scrollBody();
    return line;
  }

  // m: { body, mine, at, id?, reply? }
  function appendTextBubble(m) {
    const b = chatBody();
    if (!b) return;
    const narration = narrationText(m.body);
    if (narration != null) {
      return appendNarrationLine(narration, m.at, { id: m.id });
    }
    const side = m.mine ? 'me' : 'them';
    const bubble = el(`<div class="bubble ${side}"></div>`);
    if (m.id) bubble.dataset.id = m.id;
    if (m.reply) bubble.appendChild(renderQuote(m.reply));
    appendRichText(bubble, m.body);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    attachBubbleActions(bubble, m);
    const row = mountBubble(bubble, m);
    scrollBody();
    return row;
  }

  function appendFileBubble(meta, mine, objectUrl) {
    const b = chatBody();
    if (!b) return;
    const isImg = /^image\//.test(meta.mime);
    const bubble = el(`<div class="bubble ${mine ? 'me' : 'them'}"></div>`);
    if (meta.id) bubble.dataset.id = meta.id;
    if (meta.from != null) bubble.dataset.from = meta.from;
    if (isImg) {
      const img = document.createElement('img');
      img.className = 'shared';
      img.src = objectUrl;
      img.draggable = false;
      img.title = 'Tap to view full size';
      img.addEventListener('contextmenu', (e) => e.preventDefault());
      // Tap the thumbnail to see the picture at its original size.
      img.addEventListener('click', () => openLightbox(objectUrl));
      bubble.appendChild(img);
    }
    bubble.appendChild(el(`<span class="file">📄 ${esc(meta.name)} (${fmtSize(meta.size)})</span>`));
    // Either side can save the file. It lives only in this browser (relayed
    // live, never stored on the server), so this is the way to keep a copy.
    const dl = el('<a class="ghost small btn-link file-download">⬇ Download</a>');
    dl.href = objectUrl;
    dl.download = meta.name || 'file';
    bubble.appendChild(dl);
    bubble.appendChild(el(`<span class="ephemeral-note">Not stored on the server · download it to keep a copy</span>`));
    // Share an image/gif from this chat to the Highway (1-on-1 chats only).
    if (isImg && state.peer) {
      const share = el('<button class="ghost small hw-share-btn" type="button">🌊 Share to Highway</button>');
      share.addEventListener('click', () => shareChatImageToHighway(share, objectUrl, meta));
      bubble.appendChild(share);
    }
    bubble.appendChild(el(`<span class="time">${fmtTime(meta.at || Date.now())}</span>`));
    attachFileActions(bubble, meta, mine);
    mountBubble(bubble, { mine: mine, from: meta.from });
    scrollBody();
  }

  // Upload a chat image/gif (held only in this browser) to the Highway, linked
  // back to this conversation so its likes/comments surface here.
  async function shareChatImageToHighway(btn, objectUrl, meta) {
    if (!state.peer) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Sharing…';
    try {
      const blob = await (await fetch(objectUrl)).blob();
      const fd = new FormData();
      fd.append('image', blob, meta.name || 'image');
      fd.append('originPeer', String(state.peer.id));
      await api.postForm('/api/highway', fd);
      btn.textContent = '✓ Shared to Highway';
      notify('Shared to the Highway.');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = original;
      notify((e && e.message) || 'Could not share.');
    }
  }

  // Route a message object (from history or live) to the right bubble.
  function appendMessage(m) {
    if (m.kind === 'gift') appendGiftBubble(m);
    else if (m.kind === 'poll') appendPollBubble(m);
    else if (m.kind === 'quiz') appendQuizBubble(m);
    else if (m.kind === 'hwevent') appendHighwayEventBubble(m);
    else if (m.kind === 'voice') return; // legacy voice notes (feature removed)
    else appendTextBubble(m);
    // Advertisement after every 20 exchanged messages (text + gifts).
    if (m.kind !== 'voice' && m.kind !== 'poll' && m.kind !== 'quiz' && m.kind !== 'hwevent') {
      maybeInsertStreamAd(chatBody(), 'chat_inline', 'chat', 20);
    }
  }

  // A like/comment on a picture this conversation shared to the Highway. Shown as
  // a centered system card with the picture's thumbnail.
  function appendHighwayEventBubble(m) {
    const b = chatBody();
    if (!b) return;
    let p = {};
    try { p = typeof m.body === 'string' ? JSON.parse(m.body) : (m.body || {}); } catch (_e) { p = {}; }
    const who = esc(p.byName || 'Someone');
    const line = p.action === 'comment'
      ? `💬 <b>${who}</b> commented on your shared image`
      : `❤️ <b>${who}</b> liked your shared image`;
    const card = el(`
      <div class="hwevent-card">
        ${p.image ? `<img class="hwevent-thumb" src="${esc(p.image)}" loading="lazy" alt="" />` : ''}
        <div class="hwevent-body">
          <div class="hwevent-line">${line}</div>
          ${p.action === 'comment' && p.text ? `<div class="hwevent-text"></div>` : ''}
          <div class="time">${fmtTime(m.at)} · on the Highway 🌊</div>
        </div>
      </div>
    `);
    if (p.action === 'comment' && p.text) card.querySelector('.hwevent-text').textContent = '“' + p.text + '”';
    const thumb = card.querySelector('.hwevent-thumb');
    if (thumb && p.image) thumb.addEventListener('click', () => openLightbox(p.image));
    b.appendChild(card);
    scrollBody();
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
    mountBubble(bubble, m);
    scrollBody();
  }

  // Restart the CSS pop animation on demand (send/receive fires it once; this
  // re-triggers it on click via a forced reflow).
  function replayPop(emoji) {
    emoji.style.animation = 'none';
    void emoji.offsetWidth;
    emoji.style.animation = '';
  }

  /* ---------- Polls (WhatsApp-style, in chat) ---------- */

  // Poll builder modal. `target` is { to } (1:1) or { groupId } (group).
  function openPollBuilder(target) {
    const MAX = 12;
    const { card, close } = openModal('Create a poll', `
      <div class="poll-builder">
        <label class="pb-label">Question</label>
        <input id="pbQ" class="pb-input" maxlength="300" placeholder="Ask something…" autocomplete="off" />
        <label class="pb-label">Options</label>
        <div id="pbOptions" class="pb-options"></div>
        <button class="ghost small" id="pbAdd" type="button">＋ Add option</button>
        <label class="pb-multi"><input type="checkbox" id="pbMulti" /> Allow multiple answers</label>
        <div class="pb-error hidden" id="pbError"></div>
        <div class="pb-actions">
          <button class="ghost" id="pbCancel" type="button">Cancel</button>
          <button class="primary" id="pbCreate" type="button">Create poll</button>
        </div>
      </div>
    `);
    const optsBox = card.querySelector('#pbOptions');
    const addBtn = card.querySelector('#pbAdd');
    const errBox = card.querySelector('#pbError');
    const showErr = (msg) => { errBox.textContent = msg; errBox.classList.remove('hidden'); };

    function refresh() {
      addBtn.disabled = optsBox.children.length >= MAX;
      optsBox.querySelectorAll('.pb-opt-x').forEach((b) => {
        b.style.visibility = optsBox.children.length > 2 ? 'visible' : 'hidden';
      });
      optsBox.querySelectorAll('.pb-opt-input').forEach((inp, i) => { inp.placeholder = 'Option ' + (i + 1); });
    }
    function addOption() {
      if (optsBox.children.length >= MAX) return;
      const row = el('<div class="pb-opt"><input class="pb-input pb-opt-input" maxlength="120" autocomplete="off" /><button class="pb-opt-x" type="button" title="Remove option">✕</button></div>');
      row.querySelector('.pb-opt-x').addEventListener('click', () => { row.remove(); refresh(); });
      optsBox.appendChild(row);
      refresh();
    }
    addOption();
    addOption();
    addBtn.addEventListener('click', addOption);
    card.querySelector('#pbCancel').addEventListener('click', close);
    card.querySelector('#pbCreate').addEventListener('click', () => {
      const question = card.querySelector('#pbQ').value.trim();
      const options = Array.from(optsBox.querySelectorAll('.pb-opt-input')).map((i) => i.value.trim()).filter(Boolean);
      const multi = card.querySelector('#pbMulti').checked;
      if (!question) return showErr('Ask a question for your poll.');
      if (options.length < 2) return showErr('Add at least two options.');
      if (!state.socket) return showErr('You appear to be offline.');
      state.socket.emit('poll:create', Object.assign({ question, options, multi }, target), (res) => {
        if (res && res.error) return showErr(res.error);
        close();
      });
    });
    card.querySelector('#pbQ').focus();
  }

  // Render a poll as a standalone card CENTERED in the chat (not a side bubble).
  // m.poll is the payload; m.fromName (group only) labels who created it.
  function appendPollBubble(m) {
    const b = chatBody();
    if (!b || !m.poll) return;
    const card = el('<div class="poll-card"></div>');
    card.dataset.pollId = m.poll.id;
    card._poll = m.poll;
    card._at = m.at;
    card._author = (!m.mine && m.fromName) ? m.fromName : null;
    renderPollInner(card);
    b.appendChild(card);
    scrollBody();
  }

  // Coloured, hover-labelled segments for one option's vote bar. Each gender
  // gets a slice sized by its share of that option's votes; the title reveals
  // the exact Male / Female / other breakdown on hover.
  function voteBarSegs(g) {
    g = g || { male: 0, female: 0, other: 0 };
    return [
      ['male', g.male, 'Male'],
      ['female', g.female, 'Female'],
      ['other', g.other, 'Other / unspecified'],
    ]
      .filter(([, n]) => n > 0)
      .map(([cls, n, label]) =>
        `<span class="vote-seg vote-seg-${cls}" style="flex-grow:${n}" title="${label}: ${n} vote${n === 1 ? '' : 's'}"></span>`)
      .join('');
  }

  // Legend explaining the Male / Female vote colours.
  const VOTE_LEGEND_HTML =
    '<div class="vote-legend">' +
    '<span class="vote-legend-item"><span class="vote-dot vote-seg-male"></span>Male</span>' +
    '<span class="vote-legend-item"><span class="vote-dot vote-seg-female"></span>Female</span>' +
    '<span class="vote-legend-item"><span class="vote-dot vote-seg-other"></span>Other</span>' +
    '</div>';

  function renderPollInner(card) {
    const p = card._poll;
    const total = p.total || 0;
    card.innerHTML = `
      <div class="poll-q"><span class="poll-ico">📊</span><span class="poll-q-text"></span></div>
      <div class="poll-sub"></div>
      <div class="poll-opts"></div>
      ${VOTE_LEGEND_HTML}
      <span class="time">${fmtTime(card._at)}</span>
    `;
    card.querySelector('.poll-q-text').textContent = p.question;
    card.querySelector('.poll-sub').textContent =
      `${card._author ? card._author + ' · ' : ''}${p.multi ? 'Select one or more' : 'Select one'} · ${total} vote${total === 1 ? '' : 's'}`;
    const box = card.querySelector('.poll-opts');
    (p.options || []).forEach((o, i) => {
      const mineSel = (p.myVotes || []).includes(i);
      const pct = total ? Math.round((o.count / total) * 100) : 0;
      const opt = el(`
        <button class="poll-opt${mineSel ? ' sel' : ''}" type="button">
          <span class="poll-bar" style="width:${pct}%">${voteBarSegs(o.genders)}</span>
          <span class="poll-opt-mark">${mineSel ? '✓' : ''}</span>
          <span class="poll-opt-text"></span>
          <span class="poll-opt-count">${o.count}</span>
        </button>
      `);
      opt.querySelector('.poll-opt-text').textContent = o.text;
      opt.addEventListener('click', () => votePoll(p.id, i));
      box.appendChild(opt);
    });
  }

  function votePoll(pollId, option) {
    if (!state.socket) return;
    state.socket.emit('poll:vote', { pollId, option }, (res) => {
      if (res && res.error) return notify(res.error);
      if (res && res.poll) updatePollCard(res.poll);
    });
  }

  // Repaint a poll card in place from a fresh payload (own vote ack or the
  // 'poll:update' broadcast when someone else votes).
  function updatePollCard(poll) {
    const b = chatBody();
    if (!b || !poll) return;
    const card = b.querySelector(`.poll-card[data-poll-id="${poll.id}"]`);
    if (!card) return;
    card._poll = poll;
    renderPollInner(card);
  }

  /* ---------- Quizzes attempted together (in chat) ---------- */

  // Picker: list the available quizzes; choosing one starts it in this chat.
  async function openQuizPicker(toId) {
    const { card, close } = openModal('Take a quiz together', `
      <div class="quiz-picker"><div class="hint">Loading quizzes…</div></div>
    `);
    const box = card.querySelector('.quiz-picker');
    let quizzes = [];
    try { quizzes = ((await api.get('/api/content/quizzes')).quizzes || []).filter((q) => q.type === 'compatibility'); }
    catch (_e) { box.innerHTML = '<div class="hint">Could not load quizzes.</div>'; return; }
    if (!quizzes.length) { box.innerHTML = '<div class="hint">No compatibility quizzes are available yet.</div>'; return; }
    box.innerHTML = '<div class="pb-label">Pick a quiz — you’ll both answer it, then see how much you match.</div>';
    quizzes.forEach((q) => {
      const item = el(`
        <button class="quiz-pick" type="button">
          <span class="quiz-pick-title"></span>
          <span class="quiz-pick-sub">${q.questionCount} question${q.questionCount === 1 ? '' : 's'}</span>
        </button>`);
      item.querySelector('.quiz-pick-title').textContent = q.title;
      item.addEventListener('click', () => {
        if (!state.socket) return;
        item.disabled = true;
        state.socket.emit('quiz:start', { to: toId, quizId: q.id }, (res) => {
          if (res && res.error) { item.disabled = false; return notify(res.error); }
          close();
        });
      });
      box.appendChild(item);
    });
  }

  // A quiz appears as a centered card in the chat (like polls).
  function appendQuizBubble(m) {
    const b = chatBody();
    if (!b || !m.quiz) return;
    const card = el('<div class="quiz-card"></div>');
    card.dataset.quizId = m.quiz.id;
    card._quiz = m.quiz;
    card._at = m.at;
    card._draft = (m.quiz.myAnswers || m.quiz.questions.map(() => -1)).slice();
    renderQuizInner(card);
    b.appendChild(card);
    scrollBody();
  }

  function renderQuizInner(card) {
    const q = card._quiz;
    card.innerHTML = `
      <div class="quiz-head"><span class="quiz-ico">🧩</span> <span class="quiz-title"></span></div>
      <div class="quiz-body"></div>
      <span class="time">${fmtTime(card._at)}</span>
    `;
    card.querySelector('.quiz-title').textContent = q.title;
    const body = card.querySelector('.quiz-body');

    if (q.bothDone && q.result) {
      // ----- result: compatibility + per-question comparison -----
      const r = q.result;
      body.appendChild(el(`
        <div class="quiz-result">
          <div class="quiz-score">${r.percent}%</div>
          <div class="quiz-score-sub">${r.matches} of ${r.total} answers matched</div>
        </div>`));
      q.questions.forEach((qq, i) => {
        const pq = r.perQuestion[i];
        const row = el(`<div class="quiz-cmp${pq.same ? ' match' : ''}"></div>`);
        row.appendChild(el('<div class="quiz-cmp-q"></div>')).textContent = qq.prompt;
        const you = qq.options[pq.mine] != null ? qq.options[pq.mine] : '—';
        const them = qq.options[pq.theirs] != null ? qq.options[pq.theirs] : '—';
        const line = el(`<div class="quiz-cmp-a"><span class="qc-you"></span><span class="qc-sep">${pq.same ? '✓' : 'vs'}</span><span class="qc-them"></span></div>`);
        line.querySelector('.qc-you').textContent = 'You: ' + you;
        line.querySelector('.qc-them').textContent = them + ' :Them';
        row.appendChild(line);
        body.appendChild(row);
      });
      return;
    }

    if (q.iSubmitted) {
      // ----- answered, waiting for the other person -----
      body.appendChild(el(
        `<div class="quiz-wait">✓ You’re done — waiting for ${esc(peerLabel())} to finish the quiz…</div>`
      ));
      return;
    }

    // ----- answer form -----
    body.appendChild(el('<div class="quiz-sub">Answer together — pick your response to each. You’ll both see how much you have in common once you’re both done.</div>'));
    q.questions.forEach((qq, i) => {
      const block = el('<div class="quiz-q"></div>');
      block.appendChild(el('<div class="quiz-q-prompt"></div>')).textContent = (i + 1) + '. ' + qq.prompt;
      const opts = el('<div class="quiz-q-opts"></div>');
      qq.options.forEach((optText, oi) => {
        const btn = el(`<button class="quiz-opt${card._draft[i] === oi ? ' sel' : ''}" type="button"></button>`);
        btn.textContent = optText;
        btn.addEventListener('click', () => {
          card._draft[i] = oi;
          opts.querySelectorAll('.quiz-opt').forEach((b, bi) => b.classList.toggle('sel', bi === oi));
          const done = card._draft.every((a) => a >= 0);
          const sub = card.querySelector('.quiz-submit');
          if (sub) sub.disabled = !done;
        });
        opts.appendChild(btn);
      });
      block.appendChild(opts);
      body.appendChild(block);
    });
    const allDone = card._draft.every((a) => a >= 0);
    const submit = el(`<button class="primary quiz-submit" type="button"${allDone ? '' : ' disabled'}>Submit my answers</button>`);
    submit.addEventListener('click', () => {
      if (!state.socket) return;
      if (!card._draft.every((a) => a >= 0)) return;
      submit.disabled = true;
      state.socket.emit('quiz:answer', { chatQuizId: q.id, answers: card._draft }, (res) => {
        if (res && res.error) { submit.disabled = false; return notify(res.error); }
        if (res && res.quiz) updateQuizCard(res.quiz);
      });
    });
    body.appendChild(submit);
  }

  // Repaint a quiz card from a fresh payload (own submit ack or 'quiz:update').
  function updateQuizCard(quiz) {
    const b = chatBody();
    if (!b || !quiz) return;
    const card = b.querySelector(`.quiz-card[data-quiz-id="${quiz.id}"]`);
    if (!card) return;
    card._quiz = quiz;
    if (!card._draft) card._draft = (quiz.myAnswers || quiz.questions.map(() => -1)).slice();
    renderQuizInner(card);
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

  var REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '🔥', '👍', '💡', '🙏'];

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
    picker.appendChild(el('<div class="gift-picker-title">Send a gift</div>'));
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
      appendGiftBubble({ body: giftId, mine: true, at: m.at || Date.now(), id: m.id, status: m.status });
    });
  }

  function sendMessage(input) {
    const body = input.value.trim();
    if (!body || !state.peer || !state.socket) return;
    input.value = '';
    clearComposerPreview();
    // Capture and clear the reply target before the round-trip. A reply to a
    // shared file carries a snapshot (replyFile) since the file isn't persisted.
    const replyingToFile = !!(state.replyTo && state.replyTo.file);
    const replyTo = state.replyTo && !replyingToFile ? state.replyTo.id : null;
    const replyFile = replyingToFile
      ? { id: state.replyTo.id, from: state.replyTo.from, text: state.replyTo.text }
      : null;
    const replySnapshot = state.replyTo
      ? { id: state.replyTo.id, mine: state.replyTo.mine, from: state.replyTo.from, text: state.replyTo.text }
      : null;
    cancelReply();
    state.socket.emit('chat:message', { to: state.peer.id, body, replyTo, replyFile }, (res) => {
      if (res && res.error) return notify(res.error);
      // Echo is handled here for the sending tab. Use the server's returned body.
      const m = (res && res.message) || {};
      appendTextBubble({ body: m.body != null ? m.body : body, mine: true, at: m.at || Date.now(), id: m.id, status: m.status, reply: m.reply || replySnapshot });
    });
  }

  async function sendFile(file) {
    if (!state.peer || !state.socket) return;
    const buf = await file.arrayBuffer();
    const fid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const mime = file.type || 'application/octet-stream';
    const peerId = state.peer.id;
    state.socket.emit('chat:file', { to: peerId, id: fid, name: file.name, mime, data: buf }, (res) => {
      if (res && res.error) return notify(res.error);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      const entry = { id: fid, from: state.me.id, mine: true, name: file.name, mime, size: file.size, at: Date.now(), url };
      cacheSharedFile(peerId, entry);
      idbSaveFile(peerId, entry, blob); // survive a refresh (this browser only)
      appendFileBubble(entry, true, url);
    });
  }

  /* ---------- shared-file cache (client-only; kept until the chat/session is
     closed so images don't vanish when you switch conversations and back).
     Nothing is stored on the server; blobs live in this tab's memory only. */
  function cacheSharedFile(peerId, entry) {
    if (!state.sharedFiles) state.sharedFiles = {};
    (state.sharedFiles[peerId] = state.sharedFiles[peerId] || []).push(entry);
  }
  function uncacheSharedFile(peerId, fid) {
    const arr = state.sharedFiles && state.sharedFiles[peerId];
    if (!arr) return;
    const i = arr.findIndex((e) => e.id === fid);
    if (i >= 0) { try { URL.revokeObjectURL(arr[i].url); } catch (_e) {} arr.splice(i, 1); }
  }

  /* Persist shared files in THIS browser (IndexedDB) so they survive a page
     refresh — without ever storing them on the server. Each user keeps their own
     copy of the blobs they sent/received, per conversation, capped so storage
     can't grow without bound. Falls back silently to memory-only when IndexedDB
     is unavailable (e.g. private browsing). */
  var FILE_DB = null;
  var FILES_PER_PEER = 80; // keep the most recent N files per conversation
  function idb() {
    if (FILE_DB) return FILE_DB;
    FILE_DB = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('gx_chat_files', 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) {
          const os = db.createObjectStore('files', { keyPath: 'key' });
          os.createIndex('peer', 'peerId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return FILE_DB;
  }
  function idbKey(peerId, fid) { return peerId + ':' + fid; }
  async function idbSaveFile(peerId, entry, blob) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put({
          key: idbKey(peerId, entry.id), peerId, fid: entry.id, from: entry.from,
          mine: entry.mine, name: entry.name, mime: entry.mime, size: entry.size, at: entry.at, blob,
        });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (_e) { /* IndexedDB unavailable — memory cache still applies */ }
  }
  async function idbDeleteFile(peerId, fid) {
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').delete(idbKey(peerId, fid));
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (_e) {}
  }
  async function idbLoadFiles(peerId) {
    try {
      const db = await idb();
      const rows = await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readonly');
        const out = [];
        const cur = tx.objectStore('files').index('peer').openCursor(IDBKeyRange.only(peerId));
        cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
        cur.onerror = () => rej(cur.error);
      });
      rows.sort((a, b) => a.at - b.at);
      // Prune oldest beyond the cap (keeps storage bounded).
      if (rows.length > FILES_PER_PEER) {
        const drop = rows.splice(0, rows.length - FILES_PER_PEER);
        drop.forEach((r) => idbDeleteFile(peerId, r.fid));
      }
      return rows.map((r) => ({
        id: r.fid, from: r.from, mine: r.mine, name: r.name, mime: r.mime, size: r.size, at: r.at,
        url: URL.createObjectURL(r.blob),
      }));
    } catch (_e) { return null; } // signal "IDB unavailable" so caller can fall back
  }
  function removeFileBubble(fid, from) {
    const b = chatBody();
    if (!b) return;
    const bubble = b.querySelector(`.bubble[data-id="${fid}"]`);
    if (!bubble) return;
    if (from != null && String(bubble.dataset.from) !== String(from)) return;
    (bubble.closest('.msg-row') || bubble).remove();
  }
  function startReplyToFile(meta, mine) {
    const label = /^image\//.test(meta.mime) ? '📷 Photo' : ('📄 ' + (meta.name || 'File'));
    state.replyTo = { id: meta.id, mine, from: meta.from, text: label, file: true };
    renderReplyBanner();
    const input = document.getElementById('msgInput');
    if (input) input.focus();
  }
  function deleteSharedFile(fid) {
    if (!state.peer || !state.socket) return;
    removeFileBubble(fid, state.me.id);
    uncacheSharedFile(state.peer.id, fid);
    idbDeleteFile(state.peer.id, fid);
    state.socket.emit('chat:file:delete', { to: state.peer.id, id: fid });
  }
  // Reply + (for the sender) delete controls on a shared-file bubble.
  function attachFileActions(bubble, meta, mine) {
    if (!meta || !meta.id) return;
    const actions = el('<div class="bubble-actions"></div>');
    const reply = el('<button class="act-btn" title="Reply">↩</button>');
    reply.addEventListener('click', (e) => { e.stopPropagation(); startReplyToFile(meta, mine); });
    actions.appendChild(reply);
    if (mine) {
      const del = el('<button class="act-btn" title="Delete for both">🗑</button>');
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSharedFile(meta.id); });
      actions.appendChild(del);
    }
    bubble.appendChild(actions);
  }

  function notify(text) {
    const b = chatBody();
    if (!b) return alert(text);
    b.appendChild(el(`<div class="typing" style="align-self:center;color:var(--danger)">${esc(text)}</div>`));
    scrollBody();
  }

  // Toast-ish helper that never depends on an open chat body.
  function notifyToast(text) {
    const t = el(`<div class="toast">${esc(text)}</div>`);
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
  }

  /* ---------- screen sharing (browser-tab only) ----------
     One-directional WebRTC: the sharer captures a single browser TAB and
     streams it peer-to-peer to the chat partner. The server only relays the
     offer/answer/ICE (see socket.js). The tab-only rule is enforced on the
     sharer's side: any non-tab surface the user picks is stopped and refused,
     so a window or a whole screen can never be shared. */
  const ICE_CONFIG = {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  };
  state.screen = state.screen || null; // { pc, stream, role, peerId } while active

  function reflectScreenShare(peerId) {
    const btn = document.getElementById('screenShareBtn');
    if (!btn) return;
    const s = state.screen;
    const here = s && s.peerId === peerId;
    btn.classList.toggle('on', !!here);
    btn.textContent = here
      ? (s.role === 'sharer' ? '🖥️ Stop sharing' : '🖥️ Stop viewing')
      : '🖥️ Share screen';
  }

  // Floating panel that hosts the <video>, reused for sharer and viewer.
  function screenPanel() {
    let panel = document.getElementById('screenPanel');
    if (panel) return panel;
    panel = el(`
      <div id="screenPanel" class="screen-panel hidden">
        <div class="screen-panel-head">
          <span class="screen-dot"></span>
          <span class="screen-title" id="screenTitle">Screen share</span>
          <div class="screen-actions">
            <button class="icon-btn small" id="screenFsBtn" title="Fullscreen">⛶</button>
            <button class="icon-btn small" id="screenCloseBtn" title="Stop">✕</button>
          </div>
        </div>
        <video id="screenVideo" autoplay playsinline></video>
      </div>`);
    document.body.appendChild(panel);
    panel.querySelector('#screenCloseBtn').addEventListener('click', () => stopScreenShare());
    panel.querySelector('#screenFsBtn').addEventListener('click', () => {
      const v = panel.querySelector('#screenVideo');
      if (v && v.requestFullscreen) v.requestFullscreen().catch(() => {});
    });
    return panel;
  }

  function showScreenPanel(title) {
    const panel = screenPanel();
    panel.querySelector('#screenTitle').textContent = title;
    panel.classList.remove('hidden');
    return panel;
  }

  function newScreenPc(peerId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    pc.onicecandidate = (e) => {
      if (e.candidate && state.socket) {
        state.socket.emit('screen:ice', { to: peerId, candidate: e.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        if (state.screen && state.screen.pc === pc) stopScreenShare(true);
      }
    };
    return pc;
  }

  function toggleScreenShare(peer) {
    if (!state.socket) return;
    if (state.screen) { stopScreenShare(); return; } // second click ends it
    startScreenShare(peer);
  }

  async function startScreenShare(peer) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return notifyToast('Screen sharing is not supported in this browser.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser' },
        audio: false,
        // Steer the picker toward a single browser tab.
        monitorTypeSurfaces: 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (e) {
      return; // user cancelled the picker or denied permission
    }
    const track = stream.getVideoTracks()[0];
    const surface = track && track.getSettings ? track.getSettings().displaySurface : null;
    // Hard rule: only a browser tab may be shared. A window, a whole screen,
    // or a browser that can't report the surface type is refused outright.
    if (surface !== 'browser') {
      stream.getTracks().forEach((t) => t.stop());
      return notifyToast('You can only share a browser tab — pick a tab, not a window or a screen.');
    }

    const pc = newScreenPc(peer.id);
    state.screen = { pc, stream, role: 'sharer', peerId: peer.id };
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    // Ending the share from the browser's own "Stop sharing" bar tears down too.
    track.addEventListener('ended', () => stopScreenShare());

    const panel = showScreenPanel('You are sharing a tab with ' + esc(peer.displayName || peer.username));
    const v = panel.querySelector('#screenVideo');
    v.srcObject = stream; v.muted = true; // never echo your own audio (none here anyway)

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('screen:offer', { to: peer.id, sdp: pc.localDescription });
    } catch (e) {
      stopScreenShare();
      return notifyToast('Could not start the screen share.');
    }
    reflectScreenShare(peer.id);
  }

  async function handleScreenOffer(msg) {
    if (state.screen) return; // already busy; one screen share at a time
    const fromId = msg.from;
    const peer = state.chatPeers[fromId] || (state.peer && state.peer.id === fromId ? state.peer : null);
    const name = peer ? (peer.displayName || peer.username) : 'Someone';
    const pc = newScreenPc(fromId);
    state.screen = { pc, stream: null, role: 'viewer', peerId: fromId };
    pc.ontrack = (e) => {
      const panel = showScreenPanel(esc(name) + ' is sharing a tab');
      const v = panel.querySelector('#screenVideo');
      v.srcObject = e.streams[0]; v.muted = false;
      state.screen.stream = e.streams[0];
    };
    try {
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      state.socket.emit('screen:answer', { to: fromId, sdp: pc.localDescription });
    } catch (e) {
      return stopScreenShare(true);
    }
    reflectScreenShare(fromId);
  }

  async function handleScreenAnswer(msg) {
    const s = state.screen;
    if (!s || s.role !== 'sharer' || s.peerId !== msg.from) return;
    try { await s.pc.setRemoteDescription(msg.sdp); } catch (e) { /* ignore */ }
  }

  async function handleScreenIce(msg) {
    const s = state.screen;
    if (!s || s.peerId !== msg.from || !msg.candidate) return;
    try { await s.pc.addIceCandidate(msg.candidate); } catch (e) { /* late/dup candidate */ }
  }

  function stopScreenShare(silent) {
    const s = state.screen;
    if (!s) return;
    state.screen = null;
    if (!silent && state.socket) state.socket.emit('screen:stop', { to: s.peerId });
    try { if (s.stream) s.stream.getTracks().forEach((t) => t.stop()); } catch (_e) {}
    try { s.pc.close(); } catch (_e) {}
    const panel = document.getElementById('screenPanel');
    if (panel) {
      const v = panel.querySelector('#screenVideo');
      if (v) v.srcObject = null;
      panel.classList.add('hidden');
    }
    reflectScreenShare(s.peerId);
  }

  /* ---------- video calls (1:1 and group) ----------
     Full-mesh WebRTC: each participant holds one RTCPeerConnection per other
     participant (groups are capped at 4, so at most 3 links). The server
     (socket.js) tracks the room and relays signaling; whoever joins later
     sends the offers, so two sides never offer to each other at once.
     Quality: HD 720p/30fps camera capture with echo cancellation and noise
     suppression, a generous video bitrate ceiling (lower per link in group
     calls, where we upload one stream per peer), and a live per-tile quality
     badge read from getStats(). */
  const CALL_VIDEO = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' };
  const CALL_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const RING_TIMEOUT_MS = 45000;
  state.call = null; // { room, target, title, local, peers: Map(id -> peer), iceServers, … }
  state.incomingCall = null; // { ring, close, stopTone }

  async function getCallMedia() {
    try { return await navigator.mediaDevices.getUserMedia({ video: CALL_VIDEO, audio: CALL_AUDIO }); }
    catch (_e) {}
    try { return await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO }); } // no camera → voice only
    catch (_e) { return null; }
  }

  // Start (or join) a call. target: { kind:'dm', to, name } | { kind:'group', groupId, name }.
  async function startCall(target) {
    if (!state.socket) return;
    if (state.call) return notifyToast('You are already in a call.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
      return notifyToast('Video calls are not supported in this browser.');
    }
    const local = await getCallMedia();
    if (!local) return notifyToast('Allow camera/microphone access to start a call.');
    local.getAudioTracks().forEach((t) => { try { t.contentHint = 'speech'; } catch (_e) {} });

    const call = {
      room: null, target, title: target.name || 'Call', local,
      peers: new Map(), iceServers: ICE_CONFIG.iceServers,
      micOn: true, camOn: local.getVideoTracks().length > 0, everConnected: false,
      camTrack: local.getVideoTracks()[0] || null, // our camera (null = voice only)
      screen: null,       // MediaStream while we share our screen
      startedAt: 0,       // first moment someone connected (call timer)
      chatUnread: 0,
    };
    state.call = call;
    renderCallPanel();
    setCallStatus(target.kind === 'dm' ? 'Ringing…' : 'Waiting for others to join…');
    askNotificationPermission();
    joinCallRoom(call, false);
    call.statsTimer = setInterval(updateCallQuality, 2000);
  }

  // Ask the server to put us in the call room, then offer to everyone already
  // there. `rejoin` = our socket reconnected mid-call (the server dropped us
  // when it disconnected), so rebuild every link from scratch.
  function joinCallRoom(call, rejoin) {
    const target = call.target;
    const payload = target.kind === 'dm' ? { kind: 'dm', to: target.to } : { kind: 'group', groupId: target.groupId };
    state.socket.emit('call:join', payload, (res) => {
      if (state.call !== call) return; // hung up while joining
      if (!res || res.error) { endCall(true); return notifyToast((res && res.error) || 'Could not start the call.'); }
      call.room = res.room;
      if (Array.isArray(res.iceServers) && res.iceServers.length) call.iceServers = res.iceServers;
      if (rejoin) [...call.peers.keys()].forEach(removeCallPeer);
      (res.peers || []).forEach((p) => addCallPeer(p.id, p.name, true));
      if (res.peers && res.peers.length) setCallStatus('');
      else if (rejoin && target.kind === 'group') setCallStatus('Waiting for others to join…');
      // Nobody picked up a 1:1 call in time → give up.
      if (!rejoin && target.kind === 'dm' && !(res.peers && res.peers.length)) {
        call.ringTimer = setTimeout(() => {
          if (state.call === call && !call.everConnected) { endCall(); notifyToast('No answer.'); }
        }, RING_TIMEOUT_MS);
      }
    });
  }

  // Ask once (on a click, as browsers require) so later calls can raise a
  // system notification even when this tab is in the background.
  function askNotificationPermission() {
    try {
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    } catch (_e) {}
  }

  // Create the link to one other participant. `offerer` = we send the offer.
  function addCallPeer(id, name, offerer) {
    const call = state.call;
    if (!call) return null;
    if (call.peers.has(id)) return call.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: call.iceServers });
    const peer = { id, name: name || 'Someone', pc, pendingIce: [], stream: null, state: {} };
    call.peers.set(id, peer);
    call.local.getAudioTracks().forEach((t) => pc.addTrack(t, call.local));
    const video = outgoingVideoTrack(call);
    peer.videoSender = video ? pc.addTrack(video, call.local) : null;

    pc.onicecandidate = (e) => {
      if (e.candidate && state.socket && call.room) {
        state.socket.emit('call:signal', { room: call.room, to: id, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      peer.stream = e.streams[0] || new MediaStream([e.track]);
      const v = peer.tile && peer.tile.querySelector('video');
      if (v && v.srcObject !== peer.stream) v.srcObject = peer.stream;
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (!peer.connected) { peer.connected = true; callToast(`${peer.name} joined`); }
        call.everConnected = true;
        if (!call.startedAt) call.startedAt = Date.now();
        clearTimeout(call.ringTimer);
        setCallStatus('');
        tuneCallSenders();
        sendCallState(); // so they see our mute / camera / screen state
      } else if (pc.connectionState === 'failed') {
        // Try to recover the path (e.g. a network switch) before giving up.
        if (offerer) { try { pc.restartIce(); } catch (_e) {} renegotiate(peer); }
      }
    };

    peer.tile = callTile(peer.name, false);
    document.getElementById('callGrid').appendChild(peer.tile);
    layoutCallGrid();
    updateCallHeader();
    if (offerer) renegotiate(peer);
    return peer;
  }

  async function renegotiate(peer) {
    const call = state.call;
    if (!call) return;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      state.socket.emit('call:signal', { room: call.room, to: peer.id, sdp: peer.pc.localDescription });
    } catch (_e) { /* the next ICE restart retries */ }
  }

  function removeCallPeer(id) {
    const call = state.call;
    const peer = call && call.peers.get(id);
    if (!peer) return;
    call.peers.delete(id);
    try { peer.pc.close(); } catch (_e) {}
    if (peer.tile) peer.tile.remove();
    layoutCallGrid();
    updateCallHeader();
  }

  async function handleCallSignal(msg) {
    const call = state.call;
    if (!call || msg.room !== call.room) return;
    let peer = call.peers.get(msg.from);
    if (!peer) {
      const known = state.chatPeers[msg.from];
      peer = addCallPeer(msg.from, known ? (known.displayName || known.username) : null, false);
      if (!peer) return;
    }
    const pc = peer.pc;
    try {
      if (msg.sdp) {
        await pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          state.socket.emit('call:signal', { room: call.room, to: peer.id, sdp: pc.localDescription });
        }
        // Candidates that arrived before the description can be applied now.
        const queued = peer.pendingIce.splice(0);
        for (const c of queued) { try { await pc.addIceCandidate(c); } catch (_e) {} }
      } else if (msg.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
        else peer.pendingIce.push(msg.candidate);
      }
    } catch (_e) { /* stale or duplicate signal */ }
  }

  // Bitrate ceilings: a 1:1 call gets HD headroom; in a group each link is
  // capped lower, since we upload a separate copy of our video to every peer.
  function tuneCallSenders() {
    const call = state.call;
    if (!call) return;
    const maxBitrate = call.peers.size <= 1 ? 2500000 : 1200000;
    call.peers.forEach((peer) => {
      peer.pc.getSenders().forEach((s) => {
        if (!s.track) return;
        try {
          const p = s.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          if (s.track.kind === 'video') {
            p.encodings[0].maxBitrate = maxBitrate;
            p.encodings[0].maxFramerate = 30;
            p.degradationPreference = 'balanced';
          } else {
            p.encodings[0].maxBitrate = 64000; // clear Opus voice
          }
          s.setParameters(p).catch(() => {});
        } catch (_e) {}
      });
    });
  }

  // Read each link's stats and badge the tile: resolution/fps when healthy,
  // a warning when packets are being lost or the round trip is long.
  async function updateCallQuality() {
    const call = state.call;
    if (!call) return;
    for (const peer of call.peers.values()) {
      if (!peer.tile || peer.pc.connectionState !== 'connected') continue;
      let height = 0, fps = 0, lost = 0, recv = 0, rtt = 0;
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            height = r.frameHeight || 0; fps = Math.round(r.framesPerSecond || 0);
            lost = r.packetsLost || 0; recv = r.packetsReceived || 0;
          }
          if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime) rtt = r.currentRoundTripTime;
        });
      } catch (_e) { continue; }
      const dLost = lost - (peer.lastLost || 0), dRecv = recv - (peer.lastRecv || 0);
      peer.lastLost = lost; peer.lastRecv = recv;
      const lossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : 0;
      const weak = lossPct > 5 || rtt > 0.4;
      const badge = peer.tile.querySelector('.call-quality');
      badge.classList.toggle('weak', weak);
      badge.textContent = weak ? 'Weak connection'
        : height ? `${height >= 720 ? 'HD ' : ''}${height}p · ${fps}fps` : '';
    }
  }

  // The video we send: our screen while sharing, else the camera (or none).
  function outgoingVideoTrack(call) {
    if (call.screen) return call.screen.getVideoTracks()[0] || null;
    return call.camTrack;
  }

  function callTile(name, isLocal) {
    const initial = esc((String(name || '?').trim()[0] || '?').toUpperCase());
    const tile = el(`
      <div class="call-tile${isLocal ? ' local' : ''}">
        <video autoplay playsinline${isLocal ? ' muted' : ''}></video>
        <button class="call-tile-zoom" type="button" title="Enlarge (double-click works too)">⛶</button>
        <div class="call-tile-off"><span class="call-initial">${initial}</span><span class="call-off-note">Camera off</span></div>
        <div class="call-tile-name"><span class="call-mic-off" title="Microphone muted">🔇</span><span class="call-name-text">${esc(name)}</span></div>
        <div class="call-quality"></div>
      </div>`);
    tile.querySelector('.call-tile-zoom').addEventListener('click', () => toggleTileZoom(tile));
    tile.addEventListener('dblclick', () => toggleTileZoom(tile));
    return tile;
  }

  // Grid shape follows the number of tiles; every tile is the same size (CSS).
  function layoutCallGrid() {
    const grid = document.getElementById('callGrid');
    if (grid) grid.dataset.count = String(grid.children.length);
  }

  // Show one tile full screen (e.g. to read a shared tab), or go back.
  function toggleTileZoom(tile) {
    if (document.fullscreenElement === tile) document.exitFullscreen().catch(() => {});
    else if (tile.requestFullscreen) tile.requestFullscreen().catch(() => {});
  }

  function setCallStatus(text) {
    const s = document.getElementById('callStatus');
    if (s) { s.textContent = text; s.classList.toggle('hidden', !text); }
  }

  // A short-lived note over the video ("Asha joined", "Ravi is sharing…").
  function callToast(text) {
    const stage = document.querySelector('#callPanel .call-stage');
    if (!stage) return;
    const t = el(`<div class="call-toast">${esc(text)}</div>`);
    stage.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // Header subtitle: who's here and for how long.
  function updateCallHeader() {
    const call = state.call;
    const sub = document.getElementById('callSub');
    if (!call || !sub) return;
    const people = call.peers.size + 1;
    let text;
    if (!call.startedAt) {
      text = call.target.kind === 'dm' ? `Calling ${call.title}…` : 'Waiting for others to join…';
    } else {
      const secs = Math.floor((Date.now() - call.startedAt) / 1000);
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      text = `${people} ${people === 1 ? 'person' : 'people'} · ${mm}:${ss}`;
    }
    sub.textContent = text;
  }

  // Our mic / camera / screen state → everyone else in the call (they show a
  // muted icon, a "camera off" card, or feature our screen).
  function sendCallState() {
    const call = state.call;
    if (!call || !call.room || !state.socket) return;
    state.socket.emit('call:state', {
      room: call.room,
      mic: call.micOn,
      cam: !!(call.camTrack && call.camOn) || !!call.screen,
      screen: !!call.screen,
    });
  }

  function applyPeerState(msg) {
    const call = state.call;
    if (!call || msg.room !== call.room) return;
    const peer = call.peers.get(msg.from);
    if (!peer || !peer.tile) return;
    const wasSharing = !!peer.state.screen;
    peer.state = { mic: msg.mic !== false, cam: msg.cam !== false, screen: !!msg.screen };
    peer.tile.classList.toggle('mic-off', !peer.state.mic);
    peer.tile.classList.toggle('cam-off', !peer.state.cam);
    peer.tile.classList.toggle('screen', peer.state.screen);
    if (peer.state.screen && !wasSharing) callToast(`${peer.name} is sharing their screen`);
    if (!peer.state.screen && wasSharing) callToast(`${peer.name} stopped sharing`);
    layoutCallGrid();
  }

  // Reflect our own state on our tile and the control buttons.
  function reflectLocalCallState() {
    const call = state.call;
    const panel = document.getElementById('callPanel');
    if (!call || !panel) return;
    const me = panel.querySelector('.call-tile.local');
    const camShown = !!(call.camTrack && call.camOn) || !!call.screen;
    me.classList.toggle('mic-off', !call.micOn);
    me.classList.toggle('cam-off', !camShown);
    me.classList.toggle('screen', !!call.screen);
    me.querySelector('.call-name-text').textContent = call.screen ? 'You (sharing screen)' : 'You';
    me.querySelector('.call-off-note').textContent = call.camTrack ? 'Camera off' : 'No camera';
    const setBtn = (id, on, labelOn, labelOff, tipOn, tipOff) => {
      const b = panel.querySelector(id);
      b.classList.toggle('off', !on);
      b.querySelector('.call-btn-label').textContent = on ? labelOn : labelOff;
      b.title = on ? tipOn : tipOff;
    };
    setBtn('#callMicBtn', call.micOn, 'Mute', 'Unmute', 'Mute your microphone', 'Unmute your microphone');
    setBtn('#callCamBtn', !!(call.camTrack && call.camOn), 'Stop video', 'Start video', 'Turn your camera off', 'Turn your camera on');
    panel.querySelector('#callCamBtn').disabled = !call.camTrack;
    const share = panel.querySelector('#callShareBtn');
    share.classList.toggle('active', !!call.screen);
    share.querySelector('.call-btn-label').textContent = call.screen ? 'Stop sharing' : 'Share screen';
    share.title = call.screen ? 'Stop sharing your screen' : 'Show a browser tab to everyone in the call';
  }

  function renderCallPanel() {
    const call = state.call;
    let panel = document.getElementById('callPanel');
    if (panel) panel.remove();
    const btn = (id, icon, label, extra) =>
      `<button class="call-btn${extra || ''}" id="${id}"><span class="call-btn-icon">${icon}</span><span class="call-btn-label">${label}</span><span class="call-badge hidden"></span></button>`;
    panel = el(`
      <div id="callPanel" class="call-panel">
        <div class="call-head">
          <span class="screen-dot"></span>
          <div class="call-head-text">
            <span class="call-title">${esc(call.title)}</span>
            <span class="call-sub" id="callSub"></span>
          </div>
          <button class="icon-btn small" id="callMinBtn" title="Shrink to a small window (keep chatting)">▭</button>
          <button class="icon-btn small" id="callFsBtn" title="Fullscreen">⛶</button>
        </div>
        <div class="call-body">
          <div class="call-stage">
            <div class="call-grid" id="callGrid"></div>
            <div class="call-status" id="callStatus"></div>
          </div>
          <aside class="call-chat" id="callChat">
            <div class="call-chat-head">
              <b>Chat</b><span class="hint">Saved in your ${call.target.kind === 'dm' ? 'chat' : 'group chat'} too</span>
              <button class="icon-btn small" id="callChatClose" title="Close chat">✕</button>
            </div>
            <div class="call-chat-list" id="callChatList"><div class="call-chat-empty">Messages you send here go to everyone in the call.</div></div>
            <form class="call-chat-form" id="callChatForm">
              <input type="text" id="callChatInput" placeholder="Type a message…" autocomplete="off" dir="auto" maxlength="4000" />
              <button class="primary small" type="submit">Send</button>
            </form>
          </aside>
        </div>
        <div class="call-controls">
          ${btn('callMicBtn', '🎤', 'Mute')}
          ${btn('callCamBtn', '📷', 'Stop video')}
          ${btn('callShareBtn', '🖥️', 'Share screen')}
          ${btn('callChatBtn', '💬', 'Chat')}
          ${btn('callEndBtn', '📞', 'Leave', ' end')}
        </div>
      </div>`);
    document.body.appendChild(panel);

    const me = callTile('You', true);
    me.querySelector('video').srcObject = call.local;
    panel.querySelector('#callGrid').appendChild(me);
    layoutCallGrid();
    reflectLocalCallState();
    updateCallHeader();
    call.headerTimer = setInterval(updateCallHeader, 1000);

    panel.querySelector('#callEndBtn').addEventListener('click', () => endCall());
    panel.querySelector('#callMicBtn').addEventListener('click', () => {
      call.micOn = !call.micOn;
      call.local.getAudioTracks().forEach((t) => { t.enabled = call.micOn; });
      reflectLocalCallState();
      sendCallState();
    });
    panel.querySelector('#callCamBtn').addEventListener('click', () => {
      if (!call.camTrack) return;
      call.camOn = !call.camOn;
      call.camTrack.enabled = call.camOn;
      reflectLocalCallState();
      sendCallState();
    });
    panel.querySelector('#callShareBtn').addEventListener('click', () => {
      if (call.screen) stopCallScreenShare(); else startCallScreenShare();
    });
    panel.querySelector('#callChatBtn').addEventListener('click', () => toggleCallChat());
    panel.querySelector('#callChatClose').addEventListener('click', () => toggleCallChat(false));
    panel.querySelector('#callChatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      sendCallChat();
    });
    panel.querySelector('#callMinBtn').addEventListener('click', () => panel.classList.toggle('min'));
    panel.querySelector('#callFsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (panel.requestFullscreen) panel.requestFullscreen().catch(() => {});
    });
  }

  /* ----- screen sharing inside a call -----
     Same tab-only rule as the 1:1 "Share screen" button (see startScreenShare):
     only a single browser tab can be shown, never a window or a whole screen.
     The screen replaces our camera on every link (replaceTrack — no
     renegotiation); with no camera there is no video sender yet, so one is
     added and that link renegotiated. */
  async function startCallScreenShare() {
    const call = state.call;
    if (!call || call.screen) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return notifyToast('Screen sharing is not supported in this browser.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: { ideal: 15, max: 30 } },
        audio: false,
        monitorTypeSurfaces: 'exclude',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
      });
    } catch (_e) { return; } // picker cancelled
    const track = stream.getVideoTracks()[0];
    const surface = track && track.getSettings ? track.getSettings().displaySurface : null;
    if (surface !== 'browser') {
      stream.getTracks().forEach((t) => t.stop());
      return notifyToast('You can only share a browser tab — pick a tab, not a window or a screen.');
    }
    if (state.call !== call) { stream.getTracks().forEach((t) => t.stop()); return; }
    try { track.contentHint = 'detail'; } catch (_e) {} // keep text sharp
    call.screen = stream;
    track.addEventListener('ended', () => stopCallScreenShare()); // browser's own "Stop sharing"
    call.peers.forEach((peer) => setPeerVideo(peer, track));
    showLocalPreview();
    reflectLocalCallState();
    layoutCallGrid();
    sendCallState();
    callToast('You are sharing a tab with everyone in the call');
  }

  function stopCallScreenShare() {
    const call = state.call;
    if (!call || !call.screen) return;
    const screen = call.screen;
    call.screen = null;
    screen.getTracks().forEach((t) => t.stop());
    call.peers.forEach((peer) => setPeerVideo(peer, call.camTrack));
    showLocalPreview();
    reflectLocalCallState();
    layoutCallGrid();
    sendCallState();
  }

  function setPeerVideo(peer, track) {
    if (peer.videoSender) {
      peer.videoSender.replaceTrack(track).catch(() => {});
    } else if (track) {
      peer.videoSender = peer.pc.addTrack(track, state.call.local);
      renegotiate(peer);
    }
  }

  // Our own tile previews what we send: the shared tab, or the camera.
  function showLocalPreview() {
    const call = state.call;
    const v = document.querySelector('#callPanel .call-tile.local video');
    if (!call || !v) return;
    v.srcObject = call.screen || call.local;
  }

  /* ----- chat inside a call -----
     Messages go through the normal chat (1:1 or the group), so they're kept in
     the conversation history; the call panel just shows them alongside the video. */
  function toggleCallChat(open) {
    const call = state.call;
    const panel = document.getElementById('callPanel');
    if (!call || !panel) return;
    const isOpen = open == null ? !panel.classList.contains('chat-open') : open;
    panel.classList.toggle('chat-open', isOpen);
    panel.querySelector('#callChatBtn').classList.toggle('active', isOpen);
    if (isOpen) {
      panel.classList.remove('min');
      call.chatUnread = 0;
      setCallChatBadge();
      setTimeout(() => panel.querySelector('#callChatInput').focus(), 0);
    }
  }

  function setCallChatBadge() {
    const call = state.call;
    const badge = document.querySelector('#callChatBtn .call-badge');
    if (!call || !badge) return;
    badge.textContent = call.chatUnread > 9 ? '9+' : String(call.chatUnread);
    badge.classList.toggle('hidden', !call.chatUnread);
  }

  function appendCallChat(name, body, mine, at) {
    const call = state.call;
    const list = document.getElementById('callChatList');
    if (!call || !list) return;
    const empty = list.querySelector('.call-chat-empty');
    if (empty) empty.remove();
    const item = el(`<div class="call-chat-msg${mine ? ' mine' : ''}"><div class="call-chat-meta"><b></b> <span>${fmtTime(at || Date.now())}</span></div><div class="call-chat-text"></div></div>`);
    item.querySelector('b').textContent = mine ? 'You' : name;
    item.querySelector('.call-chat-text').textContent = body;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    const panel = document.getElementById('callPanel');
    if (!mine && panel && !panel.classList.contains('chat-open')) {
      call.chatUnread += 1;
      setCallChatBadge();
      callToast(`💬 ${name}: ${body.length > 60 ? body.slice(0, 60) + '…' : body}`);
    }
  }

  function sendCallChat() {
    const call = state.call;
    const input = document.getElementById('callChatInput');
    if (!call || !input || !state.socket) return;
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    const t = call.target;
    if (t.kind === 'dm') {
      state.socket.emit('chat:message', { to: t.to, body }, (res) => {
        if (res && res.error) { input.value = body; return notifyToast(res.error); }
        const m = (res && res.message) || {};
        appendCallChat('You', m.body != null ? m.body : body, true, m.at);
        // The 1:1 chat open behind the call shows it as well.
        if (state.peer && state.peer.id === t.to) appendTextBubble({ body: m.body != null ? m.body : body, mine: true, at: m.at || Date.now(), id: m.id, status: m.status });
      });
    } else {
      // The server echoes group messages to every member, us included — the
      // group:message handler adds it to this panel then.
      state.socket.emit('group:message', { groupId: t.groupId, body }, (res) => {
        if (res && res.error) { input.value = body; notifyToast(res.error); }
      });
    }
  }

  // Hang up. `silent` skips telling the server (it already knows / never joined).
  function endCall(silent) {
    const call = state.call;
    if (!call) return;
    state.call = null;
    clearTimeout(call.ringTimer);
    clearInterval(call.statsTimer);
    clearInterval(call.headerTimer);
    if (!silent && call.room && state.socket) state.socket.emit('call:leave', { room: call.room });
    call.peers.forEach((p) => { try { p.pc.close(); } catch (_e) {} });
    try { call.local.getTracks().forEach((t) => t.stop()); } catch (_e) {}
    try { if (call.screen) call.screen.getTracks().forEach((t) => t.stop()); } catch (_e) {}
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const panel = document.getElementById('callPanel');
    if (panel) panel.remove();
  }

  // A soft two-tone ring while an incoming call waits. Returns a stopper.
  function startRingTone() {
    let ctx, timer;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        [0, 0.25].forEach((delay, i) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = i ? 660 : 880;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
          g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + delay + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.22);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + 0.24);
        });
      };
      beep();
      timer = setInterval(beep, 2000);
    } catch (_e) {}
    return () => { clearInterval(timer); try { if (ctx) ctx.close(); } catch (_e) {} };
  }

  // Make a ring hard to miss when the tab isn't in front: flash the tab title,
  // vibrate (phones), and raise a system notification if allowed. Returns a stopper.
  function alertIncomingCall(text) {
    const original = document.title;
    let flip = false;
    const timer = setInterval(() => { flip = !flip; document.title = flip ? text : original; }, 1000);
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (_e) {}
    let note = null;
    try {
      if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        note = new Notification(text, { body: 'Tap to answer', tag: 'gxm-call', requireInteraction: true });
        note.onclick = () => { window.focus(); note.close(); };
      }
    } catch (_e) {}
    return () => {
      clearInterval(timer);
      document.title = original;
      try { if (navigator.vibrate) navigator.vibrate(0); } catch (_e) {}
      try { if (note) note.close(); } catch (_e) {}
    };
  }

  function dismissIncomingCall() {
    const inc = state.incomingCall;
    if (!inc) return;
    state.incomingCall = null;
    clearTimeout(inc.timer);
    inc.stopTone();
    inc.close();
  }

  function handleIncomingCall(ring) {
    // Busy in another call (or already being rung): leave it unanswered.
    if (state.call || state.incomingCall) return;
    const isGroup = ring.kind === 'group';
    const who = esc(ring.fromName || 'Someone');
    const groupName = esc(ring.groupName || 'a group');
    const line = !isGroup ? `<b>${who}</b> is calling you`
      : ring.ongoing ? `A video call is in progress in <b>${groupName}</b> (${Number(ring.count) || 1} in the call)`
      : `${who} started a call in <b>${groupName}</b>`;
    const { card, close } = openModal(isGroup ? 'Group video call' : 'Incoming video call', `
      <p class="incoming-call">${line}</p>
      <div class="row-actions">
        <button class="ghost" id="callDecline">Decline</button>
        <button class="primary" id="callAccept">📹 Join</button>
      </div>`);
    const stopAlert = alertIncomingCall(isGroup ? `📹 Call in ${ring.groupName || 'a group'}` : `📹 ${ring.fromName || 'Someone'} is calling`);
    const stopTone = startRingTone();
    const inc = { ring, close, stopTone: () => { stopTone(); stopAlert(); } };
    state.incomingCall = inc;
    inc.timer = setTimeout(dismissIncomingCall, RING_TIMEOUT_MS);
    // Closing the dialog any way (✕ or clicking outside) declines the call.
    const declineOnClose = () => {
      if (state.incomingCall === inc) { state.socket.emit('call:decline', { room: ring.room }); dismissIncomingCall(); }
    };
    card.querySelector('.modal-x').addEventListener('click', declineOnClose);
    card.parentNode.addEventListener('click', (e) => { if (e.target === card.parentNode) declineOnClose(); });
    card.querySelector('#callDecline').addEventListener('click', () => {
      state.socket.emit('call:decline', { room: ring.room });
      dismissIncomingCall();
    });
    card.querySelector('#callAccept').addEventListener('click', () => {
      askNotificationPermission();
      dismissIncomingCall();
      startCall(isGroup
        ? { kind: 'group', groupId: ring.groupId, name: ring.groupName || 'Group call' }
        : { kind: 'dm', to: ring.from, name: ring.fromName });
    });
  }

  /* ---------- socket ---------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ withCredentials: true });
    state.socket = s;

    // Learn which friends/relations are online now, and refresh on reconnect.
    s.on('connect', () => {
      seedFriendPresence();
      // Reconnected mid-call: the server dropped us from the room — rejoin it.
      if (state.call && state.call.room) joinCallRoom(state.call, true);
    });

    // A friend/relation came online or went offline — flip their dot live.
    s.on('presence:update', (p) => {
      if (!p || p.userId == null) return;
      setOnline(p.userId, !!p.online);
    });

    s.on('chat:message', (m) => {
      const c = state.call;
      if (c && c.target.kind === 'dm' && m.kind === 'text') {
        if (m.from === c.target.to) appendCallChat(c.title, m.body, false, m.at);
        else if (m.from === state.me.id && m.to === c.target.to) appendCallChat('You', m.body, true, m.at); // sent from another tab
      }
      // Track the peer so it shows under "Chats".
      if (!state.chatPeers[m.from] && m.from !== state.me.id) rememberPeer(m.from);
      if (!state.chatPeers[m.to] && m.to !== state.me.id) rememberPeer(m.to);
      const peerId = state.peer && state.peer.id;
      const relevant = peerId && (m.from === peerId || m.to === peerId);
      if (relevant) {
        appendMessage(m);
        if (m.from === peerId) markChatRead(); // reading it as it arrives → blue ticks
      } else {
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
      const blob = new Blob([meta.data], { type: meta.mime });
      const url = URL.createObjectURL(blob);
      const entry = { id: meta.id, from: meta.from, mine: false, name: meta.name, mime: meta.mime, size: meta.size, at: meta.at || Date.now(), url };
      // Cache it under the sender's conversation so it survives switching chats
      // (memory) and a page refresh (IndexedDB, this browser only).
      cacheSharedFile(meta.from, entry);
      idbSaveFile(meta.from, entry, blob);
      if (peerId && meta.from === peerId) {
        appendFileBubble(entry, false, url);
      } else {
        rememberPeer(meta.from);
        notifyIncomingFile(meta);
      }
    });

    // The sender removed a file they shared — drop it from the view and cache.
    s.on('chat:file:delete', (payload) => {
      const id = payload && payload.id;
      const from = payload && payload.from;
      if (!id) return;
      removeFileBubble(id, from);
      if (from != null) { uncacheSharedFile(from, id); idbDeleteFile(from, id); }
    });

    // Screen-share signaling (WebRTC; the media is peer-to-peer).
    s.on('screen:offer', (msg) => handleScreenOffer(msg));
    s.on('screen:answer', (msg) => handleScreenAnswer(msg));
    s.on('screen:ice', (msg) => handleScreenIce(msg));
    s.on('screen:stop', (msg) => {
      if (state.screen && state.screen.peerId === msg.from) stopScreenShare(true);
    });

    // Group chat message for one of my groups.
    s.on('group:message', (m) => {
      const c = state.call;
      if (c && c.target.kind === 'group' && c.target.groupId === m.groupId && (m.kind || 'text') === 'text') {
        appendCallChat(m.fromName || 'Someone', m.body, !!m.mine, m.at);
      }
      if (state.group && state.group.gid === m.groupId) appendGroupMessage(m);
      else if (!m.mine) {
        const tabId = 'g' + m.groupId;
        if (state.openChats.some((p) => p.id === tabId)) { state.unread[tabId] = true; renderChatTabs(); }
        else notify(`${m.fromName} messaged a group`);
        // Blink the "Chats" nav button for an unread group message elsewhere.
        if (state.tab !== 'chats') markNav('chats', true);
      }
    });

    // Video calls.
    s.on('call:ring', (ring) => handleIncomingCall(ring));
    s.on('call:ring-stop', ({ room }) => {
      if (state.incomingCall && state.incomingCall.ring.room === room) dismissIncomingCall();
    });
    s.on('call:peer-joined', ({ room, peer }) => {
      if (state.call && state.call.room === room && peer) {
        removeCallPeer(peer.id); // a rejoin replaces any stale link to them
        addCallPeer(peer.id, peer.name, false);
        setCallStatus('');
        sendCallState(); // tell the newcomer our mic / camera / screen state
      }
    });
    s.on('call:peer-left', ({ room, userId }) => {
      const call = state.call;
      if (!call || call.room !== room) return;
      if (call.target.kind === 'dm') { endCall(); return notifyToast('Call ended.'); }
      const gone = call.peers.get(userId);
      if (gone) callToast(`${gone.name} left`);
      removeCallPeer(userId);
      if (!call.peers.size) setCallStatus('Everyone else left — waiting…');
    });
    s.on('call:declined', ({ room, name }) => {
      if (state.call && state.call.room === room && !state.call.everConnected) {
        endCall();
        notifyToast(`${name || 'They'} declined the call.`);
      }
    });
    s.on('call:signal', (msg) => handleCallSignal(msg));
    s.on('call:state', (msg) => applyPeerState(msg));
    // How many people are in a group's call — keeps "Join call" current.
    s.on('group:call', ({ groupId, count }) => {
      if (state.group && state.group.gid === groupId) reflectGroupCall(count);
    });

    // A poll's tallies changed (someone voted) — repaint the card in place.
    s.on('poll:update', (e) => { if (e && e.poll) updatePollCard(e.poll); });
    s.on('quiz:update', (e) => { if (e && e.quiz) updateQuizCard(e.quiz); });

    // A group I'm in changed (created / invited / joined / left / renamed / deleted).
    s.on('group:changed', ({ groupId, deleted }) => {
      if (deleted) {
        const tabId = 'g' + groupId;
        if (state.openChats.some((p) => p.id === tabId)) {
          if (state.group && state.group.gid === groupId) notify('This group chat was deleted by its creator.');
          closeChatTab(tabId);
        }
      } else if (state.group && state.group.gid === groupId) openGroup(groupId); // refresh header/members
      if (state.tab === 'chats') renderList();
      refreshRequestBadge(); // blinks "Requests" if a new invite raised the count
    });

    // Someone sent me a friend request — light up "Requests" live.
    s.on('notify:request', () => {
      refreshRequestBadge(); // recomputes count and blinks the button if it grew
      if (isExploreActive('requests')) renderRequests(); // already open: refresh list
    });

    // Someone finished a compatibility link this member shared: the result is
    // ready for both of them. Show a clickable toast that opens it.
    // Something new for the Notifications section (a compatibility result, or
    // a newly published quiz/poll).
    s.on('notify:new', () => {
      if (isExploreActive('notifications')) renderNotifications();
      else refreshNotifBadge();
    });

    s.on('quiz:matched', (d) => {
      if (isExploreActive('notifications')) renderNotifications();
      else refreshNotifBadge();
      if (!d || !d.token) return;
      const pts = d.points ? ` · +${d.points} points` : '';
      const t = el(`<a class="toast toast-link" href="/m/${encodeURIComponent(d.token)}" target="_blank" rel="noopener"></a>`);
      t.textContent = `🧩 ${d.bName} answered “${d.quizTitle}” — ${d.percent}% match${pts}. See results ↗`;
      document.body.appendChild(t);
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 10000);
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
        icon: e.icon || activityIcon(e.activity || ''),
        at: e.at || Date.now(),
        text: e.text,
        image: e.image || null,
      });
    });

    // A new Highway post from anyone — prepend it to an open Highway feed.
    s.on('highway:new', (p) => { if (p && p.id) pushHighwayPost(p); });

    s.on('chat:receipt', (r) => applyReceipt(r));

    s.on('chat:reaction', (e) => {
      if (e && e.messageId != null) updateReaction(e.messageId, e.userId, e.emoji);
    });

    // My account was just suspended (e.g. mass-reported) — show the notice.
    s.on('account:suspended', (e) => { showSuspendedScreen({ suspended: true, suspendedUntil: e && e.until, error: 'Your account has been suspended.', reason: e && e.reason }); });

    s.on('connect_error', () => { /* auth or network issue; UI still works for browsing */ });
  }

  function notifyIncomingFile(meta) {
    // Light-touch: user is chatting elsewhere. Surface a hint in the list tab.
    if (state.tab !== 'chats') renderList();
  }

  // Track a chat peer by id. Someone not in the people list (it's capped and
  // leaves out hidden profiles) is looked up on the server, so they always show
  // with their real name and a working profile link.
  const peerLookups = {};
  function rememberPeer(id) {
    if (state.chatPeers[id]) return Promise.resolve(state.chatPeers[id]);
    const found = state.peopleCache.find((u) => u.id === id);
    if (found) { state.chatPeers[id] = found; return Promise.resolve(found); }
    if (!peerLookups[id]) {
      peerLookups[id] = api.get('/api/users/' + id + '/summary')
        .then(({ user }) => {
          state.chatPeers[id] = user;
          if (state.tab === 'chats') renderList();
          renderChatTabs();
          return user;
        })
        .catch(() => null)
        .finally(() => { delete peerLookups[id]; });
    }
    return peerLookups[id];
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
  function genderIcon(g) {
    return g === 'Female' ? '♀' : g === 'Male' ? '♂' : '⚧';
  }

  /* ----------------------------------------------------------------------
     In-app camera + post details for the gallery.
  ---------------------------------------------------------------------- */

  // Caption text with #tags highlighted (input is escaped first).
  function captionHtml(text) {
    return esc(text || '').replace(/#([\p{L}\p{N}_]{1,50})/gu, '<span class="hashtag">#$1</span>');
  }

  // Upload a photo or reel to the gallery with its details. Text fields go
  // before the file so the server has them when the file arrives.
  async function postGalleryItem(kind, file, details, onProgress) {
    const fd = new FormData();
    fd.append('caption', details.caption || '');
    fd.append('location', details.location || '');
    fd.append('music', details.music || '');
    fd.append('musicMixed', details.musicMixed ? '1' : '0');
    fd.append(kind === 'reel' ? 'reel' : 'photo', file);
    const { photo } = await uploadWithProgress(
      kind === 'reel' ? '/api/profile/gallery/reel' : '/api/profile/gallery',
      fd,
      onProgress || function () {}
    );
    return photo;
  }

  // Background-music <select> options.
  function musicOptions(selected) {
    return ['<option value="">No music</option>']
      .concat(gxmMusic.TRACKS.map((t) => `<option value="${t.id}"${t.id === selected ? ' selected' : ''}>${t.emoji} ${esc(t.name)}</option>`))
      .join('');
  }

  // The "post details" step shown before a gallery upload: a preview, caption
  // (with #tags), place and background music. Resolves with
  // { caption, location, music, musicMixed } or null when cancelled.
  // `opts.musicMixed` = the music is already recorded into the reel (so it's
  // shown but can't be changed here).
  function openPostDetails(opts) {
    return new Promise((resolve) => {
      const isReel = opts.kind === 'reel';
      const mixed = !!opts.musicMixed;
      const box = el(`
        <div class="lightbox post-modal">
          <div class="post-shell">
            <h3 class="post-title">${isReel ? '🎬 New reel' : '📷 New photo'}</h3>
            <div class="post-preview${isReel ? ' reel' : ''}">
              ${isReel ? `<video src="${opts.previewUrl}" controls playsinline></video>` : `<img src="${opts.previewUrl}" alt="" />`}
            </div>
            <label class="post-label">Caption
              <textarea class="post-caption" maxlength="500" rows="3" placeholder="Say something… add #tags like #weekend #travel"></textarea>
            </label>
            <div class="post-tags"></div>
            <label class="post-label">Location</label>
            <div class="post-loc-row">
              <input class="post-location" maxlength="120" placeholder="Add a place (optional)" />
              <button type="button" class="ghost small post-geo" title="Fill in the nearest town">📍 Use my location</button>
            </div>
            <label class="post-label">Background music</label>
            <div class="post-music-row">
              ${mixed
                ? `<span class="chip static">🎵 ${esc((gxmMusic.byId(opts.music) || {}).name || 'Music')} — recorded into the reel</span>`
                : `<select class="post-music">${musicOptions(opts.music || '')}</select>
                   <button type="button" class="ghost small post-music-try" title="Listen">▶ Listen</button>`}
            </div>
            ${isReel && !mixed ? '<p class="hint">Music plays along with the reel’s own sound when people watch it.</p>' : ''}
            <div class="post-actions">
              <button type="button" class="ghost post-cancel">Cancel</button>
              <button type="button" class="primary post-ok">Post to gallery</button>
            </div>
          </div>
        </div>`);
      const cap = box.querySelector('.post-caption');
      const tags = box.querySelector('.post-tags');
      const loc = box.querySelector('.post-location');
      const musicSel = box.querySelector('.post-music');
      const tryBtn = box.querySelector('.post-music-try');
      const vid = box.querySelector('.post-preview video');
      let player = null;
      const stopMusic = () => { if (player) { player.stop(); player = null; } if (tryBtn) tryBtn.textContent = '▶ Listen'; };

      cap.addEventListener('input', () => {
        const found = [...new Set((cap.value.match(/#[\p{L}\p{N}_]{1,50}/gu) || []))];
        tags.innerHTML = found.map((t) => `<span class="chip static hashtag-chip">${esc(t)}</span>`).join('');
      });
      box.querySelector('.post-geo').addEventListener('click', (ev) => {
        const btn = ev.currentTarget;
        if (!navigator.geolocation) { alert('Location isn’t available on this device.'); return; }
        btn.disabled = true;
        btn.textContent = '📍 Finding…';
        navigator.geolocation.getCurrentPosition(async (pos) => {
          try {
            // Rounded to ~1 km before it leaves the device; only the place name is kept.
            const { place } = await api.post('/api/geo/nearest', {
              lat: Math.round(pos.coords.latitude * 100) / 100,
              lon: Math.round(pos.coords.longitude * 100) / 100,
            });
            loc.value = place;
          } catch (e) { alert(e.message); }
          btn.disabled = false;
          btn.textContent = '📍 Use my location';
        }, () => {
          alert('Couldn’t get your location. Allow location access, or type the place.');
          btn.disabled = false;
          btn.textContent = '📍 Use my location';
        }, { timeout: 15000, maximumAge: 600000 });
      });
      if (tryBtn) {
        tryBtn.addEventListener('click', () => {
          if (player) { stopMusic(); return; }
          if (!musicSel.value) return;
          player = gxmMusic.play(musicSel.value, { volume: 0.4 });
          tryBtn.textContent = '⏹ Stop';
        });
        musicSel.addEventListener('change', () => { if (player) { stopMusic(); tryBtn.click(); } });
      }

      const finish = (result) => {
        stopMusic();
        if (vid) vid.pause();
        box.remove();
        resolve(result);
      };
      box.querySelector('.post-cancel').addEventListener('click', () => finish(null));
      box.querySelector('.post-ok').addEventListener('click', () => finish({
        caption: cap.value.trim(),
        location: loc.value.trim(),
        music: mixed ? opts.music : (musicSel.value || ''),
        musicMixed: mixed,
      }));
      document.body.appendChild(box);
      cap.focus();
    });
  }

  // Full-screen camera: take a photo or record a reel (up to 1 minute) with
  // the device's camera and microphone, optionally with background music
  // mixed into the reel. After capture, the details step opens and the item is
  // uploaded; `onPosted(photo)` then adds it to the gallery grid.
  function openCamera(onPosted) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('This browser can’t open the camera. Try Chrome or Safari, or use “Add photo” / “Add reel”.');
      return;
    }
    let mode = 'photo';
    let facing = 'user';
    let stream = null;
    let recorder = null;
    let recTimer = null;
    let recStart = 0;
    let music = null; // player while recording
    let audioNodes = [];

    const box = el(`
      <div class="lightbox cam-modal">
        <div class="cam-shell">
          <div class="cam-top">
            <button class="cam-icon cam-close" title="Close">✕</button>
            <div class="cam-modes">
              <button class="cam-mode on" data-mode="photo">📷 Photo</button>
              <button class="cam-mode" data-mode="reel">🎬 Reel</button>
            </div>
            <button class="cam-icon cam-flip" title="Switch camera">🔄</button>
          </div>
          <div class="cam-stage">
            <video class="cam-view" autoplay playsinline muted></video>
            <div class="cam-timer hidden"><span class="cam-dot"></span><span class="cam-time">0:00</span> / 1:00</div>
            <div class="cam-msg hidden"></div>
          </div>
          <div class="cam-music hidden">
            🎵 <select class="cam-music-sel">${musicOptions('')}</select>
            <span class="hint">mixed into your reel with your voice</span>
          </div>
          <div class="cam-bottom">
            <button class="cam-shutter" title="Take photo"></button>
          </div>
          <div class="cam-hint hint">Tap the button to take a photo.</div>
        </div>
      </div>`);
    const view = box.querySelector('.cam-view');
    const shutter = box.querySelector('.cam-shutter');
    const hint = box.querySelector('.cam-hint');
    const msg = box.querySelector('.cam-msg');
    const timerEl = box.querySelector('.cam-timer');
    const timeEl = box.querySelector('.cam-time');
    const musicRow = box.querySelector('.cam-music');
    const musicSel = box.querySelector('.cam-music-sel');
    const modeBtns = box.querySelectorAll('.cam-mode');
    const flipBtn = box.querySelector('.cam-flip');

    const showMsg = (text) => { msg.textContent = text; msg.classList.toggle('hidden', !text); };
    const stopStream = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
    const hasMic = () => !!(stream && stream.getAudioTracks().length);

    async function startStream() {
      stopStream();
      const video = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video,
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (e) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video }); // camera without mic
        } catch (e2) {
          showMsg('Camera access was blocked. Allow the camera for this site in your browser settings, then try again.');
          shutter.disabled = true;
          return;
        }
      }
      view.srcObject = stream;
      view.classList.toggle('mirror', facing === 'user');
      shutter.disabled = false;
      showMsg('');
      paintMode();
    }

    function paintMode() {
      modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      shutter.classList.toggle('reel', mode === 'reel');
      musicRow.classList.toggle('hidden', mode !== 'reel');
      shutter.title = mode === 'reel' ? 'Start recording' : 'Take photo';
      hint.textContent = mode === 'reel'
        ? (hasMic() ? 'Tap to start recording — talk while you record. Stops by itself at 1 minute.' : 'Microphone is blocked, so the reel will have no voice. Tap to start recording (up to 1 minute).')
        : 'Tap the button to take a photo.';
    }

    function takePhoto() {
      const w = view.videoWidth;
      const h = view.videoHeight;
      if (!w || !h) return;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      if (facing === 'user') { g.translate(w, 0); g.scale(-1, 1); } // save selfies as seen
      g.drawImage(view, 0, 0, w, h);
      c.toBlob((blob) => {
        if (blob) finishCapture('photo', new File([blob], 'photo.jpg', { type: 'image/jpeg' }), null);
      }, 'image/jpeg', 0.9);
    }

    function pickMime() {
      const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
      return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    }

    function startRecording() {
      if (!window.MediaRecorder) { alert('Recording isn’t supported in this browser. Use “Add reel” to upload a video instead.'); return; }
      // Mix the microphone and any background music into one audio track.
      const ctx = gxmMusic.getCtx();
      const mixDest = ctx.createMediaStreamDestination();
      audioNodes = [];
      if (hasMic()) {
        const mic = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        mic.connect(mixDest);
        audioNodes.push(mic);
      }
      const trackId = musicSel.value;
      if (trackId) {
        const bus = ctx.createGain();
        bus.connect(mixDest);
        bus.connect(ctx.destination); // so you hear it while recording
        audioNodes.push(bus);
        music = gxmMusic.play(trackId, { ctx, destination: bus, volume: 0.35 });
      }
      const tracks = stream.getVideoTracks().concat(hasMic() || trackId ? mixDest.stream.getAudioTracks() : []);
      const mime = pickMime();
      const chunks = [];
      try {
        recorder = new MediaRecorder(new MediaStream(tracks), {
          mimeType: mime || undefined,
          videoBitsPerSecond: 2500000,
          audioBitsPerSecond: 128000,
        });
      } catch (e) {
        alert('Couldn’t start recording on this device.');
        cleanupAudio();
        return;
      }
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        cleanupAudio();
        const base = (recorder.mimeType || mime || 'video/webm').split(';')[0];
        const ext = base === 'video/mp4' ? 'mp4' : 'webm';
        const file = new File([new Blob(chunks, { type: base })], `reel.${ext}`, { type: base });
        recorder = null;
        if (file.size) finishCapture('reel', file, trackId || null);
      };
      recorder.start(1000);
      recStart = Date.now();
      timerEl.classList.remove('hidden');
      shutter.classList.add('recording');
      shutter.title = 'Stop recording';
      modeBtns.forEach((b) => { b.disabled = true; });
      flipBtn.disabled = true;
      musicSel.disabled = true;
      hint.textContent = 'Recording… tap to stop.';
      recTimer = setInterval(() => {
        const secs = (Date.now() - recStart) / 1000;
        timeEl.textContent = fmtReelTime(Math.min(secs, MAX_REEL_SECONDS));
        if (secs >= MAX_REEL_SECONDS) stopRecording(); // 1-minute cap
      }, 200);
    }

    function stopRecording() {
      clearInterval(recTimer);
      recTimer = null;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      timerEl.classList.add('hidden');
      shutter.classList.remove('recording');
      modeBtns.forEach((b) => { b.disabled = false; });
      flipBtn.disabled = false;
      musicSel.disabled = false;
    }

    function cleanupAudio() {
      if (music) { music.stop(); music = null; }
      audioNodes.forEach((n) => { try { n.disconnect(); } catch (_e) { /* gone */ } });
      audioNodes = [];
    }

    async function finishCapture(kind, file, trackId) {
      stopStream();
      box.classList.add('hidden');
      const url = URL.createObjectURL(file);
      const details = await openPostDetails({ kind, previewUrl: url, music: trackId, musicMixed: !!trackId });
      URL.revokeObjectURL(url);
      if (!details) { box.classList.remove('hidden'); startStream(); return; } // back to the camera
      close();
      const toast = el('<div class="cam-upload-toast">Uploading… 0%</div>');
      document.body.appendChild(toast);
      try {
        const photo = await postGalleryItem(kind, file, details, (pct) => { toast.textContent = `Uploading… ${pct}%`; });
        onPosted(photo);
      } catch (e) { alert(e.message); }
      toast.remove();
    }

    function close() {
      if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
      clearInterval(recTimer);
      cleanupAudio();
      stopStream();
      box.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape' && !box.classList.contains('hidden')) close(); }

    shutter.addEventListener('click', () => {
      if (mode === 'photo') takePhoto();
      else if (recorder) stopRecording();
      else startRecording();
    });
    modeBtns.forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; paintMode(); }));
    flipBtn.addEventListener('click', () => { facing = facing === 'user' ? 'environment' : 'user'; startStream(); });
    box.querySelector('.cam-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
    startStream();
  }

  // "0:42"-style label for a reel's length.
  function fmtReelTime(secs) {
    const s = Math.max(0, Math.round(Number(secs) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Length in seconds of a picked video file, or null if the browser can't
  // read it (the server checks again either way).
  function readVideoDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement('video');
      let settled = false;
      const done = (d) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(Number.isFinite(d) ? d : null);
      };
      v.preload = 'metadata';
      v.onloadedmetadata = () => done(v.duration);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 8000);
      v.src = url;
    });
  }

  // POST a FormData with upload progress (0-100) — for large files like reels,
  // where api.postForm would give no feedback. Resolves with the JSON reply.
  function uploadWithProgress(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_e) { /* no body */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
      xhr.send(fd);
    });
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

  // Full-screen slideshow over a list of images. `items` is an array of
  // { url, caption? }; `startIndex` is where to begin. The viewer can slide to
  // the next/previous item with the on-screen arrows, the keyboard (←/→), a
  // swipe on touch, or auto-play. Used by both the GIF "feelings" collection
  // and the photo gallery.
  function openSlideshow(items, startIndex, opts) {
    items = (items || []).filter(Boolean);
    if (!items.length) return;
    opts = opts || {};
    let i = Math.max(0, Math.min(startIndex || 0, items.length - 1));
    let timer = null;

    const box = el(`
      <div class="lightbox slideshow">
        <button class="lb-close" title="Close">✕</button>
        <button class="ss-nav ss-prev" title="Previous (←)" aria-label="Previous">‹</button>
        <div class="ss-stage">
          <img class="ss-img" alt="" />
          <div class="ss-caption"></div>
        </div>
        <button class="ss-nav ss-next" title="Next (→)" aria-label="Next">›</button>
        <div class="ss-bar">
          <button class="ss-play" title="Play / pause slideshow">▶</button>
          <span class="ss-count"></span>
        </div>
      </div>
    `);

    const img = box.querySelector('.ss-img');
    const cap = box.querySelector('.ss-caption');
    const count = box.querySelector('.ss-count');
    const playBtn = box.querySelector('.ss-play');

    const paint = () => {
      const it = items[i];
      img.src = it.url;
      cap.textContent = it.caption || '';
      cap.style.display = it.caption ? '' : 'none';
      count.textContent = `${i + 1} / ${items.length}`;
    };
    const go = (delta) => {
      i = (i + delta + items.length) % items.length;
      paint();
    };

    const stopAuto = () => {
      if (timer) { clearInterval(timer); timer = null; }
      playBtn.textContent = '▶';
      playBtn.classList.remove('on');
    };
    const startAuto = () => {
      if (items.length < 2) return;
      timer = setInterval(() => go(1), 2500);
      playBtn.textContent = '⏸';
      playBtn.classList.add('on');
    };
    const toggleAuto = () => { timer ? stopAuto() : startAuto(); };

    const close = () => {
      stopAuto();
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') { stopAuto(); go(1); }
      else if (e.key === 'ArrowLeft') { stopAuto(); go(-1); }
      else if (e.key === ' ') { e.preventDefault(); toggleAuto(); }
    }

    box.querySelector('.lb-close').addEventListener('click', close);
    box.querySelector('.ss-prev').addEventListener('click', () => { stopAuto(); go(-1); });
    box.querySelector('.ss-next').addEventListener('click', () => { stopAuto(); go(1); });
    playBtn.addEventListener('click', toggleAuto);
    box.addEventListener('click', (e) => { if (e.target === box || e.target.classList.contains('ss-stage')) close(); });
    document.addEventListener('keydown', onKey);

    // Touch swipe to change slides.
    let sx = null;
    box.querySelector('.ss-stage').addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    box.querySelector('.ss-stage').addEventListener('touchend', (e) => {
      if (sx == null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 40) { stopAuto(); go(dx < 0 ? 1 : -1); }
      sx = null;
    });

    document.body.appendChild(box);
    paint();
    if (opts.autoplay) startAuto();
  }

  // Rich gallery-photo viewer: the full-size image alongside emoji reactions
  // ("likes") and a comment thread. `opts.isOwner` disables reacting/commenting
  // on your own photos (you can still read reactions and delete comments).
  // `opts.onUpdate({ reactionCount, commentCount, myReaction })` lets the
  // originating gallery cell keep its little activity badges in sync.
  let musicMuted = false; // gallery viewer background music, per session
  function openPhotoViewer(startPhoto, opts) {
    opts = opts || {};
    const isOwner = !!opts.isOwner;
    const onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : function () {};

    // The viewer doubles as a slider: when `opts.items` (the full gallery) is
    // supplied it can page between photos with the arrows, keyboard or a swipe,
    // reloading each photo's reactions + comments. `photo` is reassigned on
    // navigation, so the react/comment closures below read it at call time.
    let items = (opts.items && opts.items.length) ? opts.items.filter(Boolean) : [startPhoto];
    let idx = items.indexOf(startPhoto);
    if (idx < 0) idx = 0;
    let photo = items[idx];
    const multi = items.length > 1;

    const box = el(`
      <div class="lightbox photo-viewer${multi ? ' pv-multi' : ''}">
        <button class="lb-close" title="Close">✕</button>
        <button class="pv-nav pv-prev" title="Previous (←)" aria-label="Previous">‹</button>
        <div class="pv-shell">
          <div class="pv-media"><img alt="" /><video class="hidden" controls playsinline preload="metadata"></video></div>
          <div class="pv-panel">
            <div class="pv-count hint"></div>
            <div class="pv-details"></div>
            <div class="pv-reactions" id="pvReactions"></div>
            <div class="pv-comments-wrap">
              <div class="comments" id="pvPhotoComments"><div class="hint">Loading…</div></div>
            </div>
            <div id="pvPhotoForm"></div>
          </div>
        </div>
        <button class="pv-nav pv-next" title="Next (→)" aria-label="Next">›</button>
      </div>
    `);
    const mediaImg = box.querySelector('.pv-media img');
    const mediaVid = box.querySelector('.pv-media video');
    const countEl = box.querySelector('.pv-count');

    const detailsEl = box.querySelector('.pv-details');
    let bgMusic = null;
    const stopBgMusic = () => { if (bgMusic) { bgMusic.stop(); bgMusic = null; } };
    const close = () => { stopBgMusic(); mediaVid.pause(); box.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (multi && e.key === 'ArrowRight') go(1);
      else if (multi && e.key === 'ArrowLeft') go(-1);
    }
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.classList.contains('lb-close') || e.target.classList.contains('pv-shell')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);

    /* ----- reactions ----- */
    const reactBar = box.querySelector('#pvReactions');
    let myReaction = null;
    let counts = {}; // emoji -> count

    function totalReactions() {
      return Object.values(counts).reduce((a, b) => a + b, 0);
    }
    function paintReactions() {
      reactBar.innerHTML = '';
      GALLERY_REACTIONS.forEach((r) => {
        const n = counts[r.emoji] || 0;
        const btn = el(
          `<button class="pv-react${myReaction === r.emoji ? ' on' : ''}" title="${esc(r.label)}">
             <span class="pv-react-emoji">${r.emoji}</span>${n ? `<span class="pv-react-count">${n}</span>` : ''}
           </button>`
        );
        if (isOwner) {
          btn.disabled = true;
          btn.title = `${r.label} — ${n}`;
        } else {
          btn.addEventListener('click', () => react(r.emoji));
        }
        reactBar.appendChild(btn);
      });
      onUpdate({ reactionCount: totalReactions(), commentCount: commentsBox.querySelectorAll('.comment').length, myReaction }, photo);
    }
    async function react(emoji) {
      try {
        const { reactions } = await api.post('/api/social/photo/' + photo.id + '/react', { emoji });
        counts = {};
        reactions.reactions.forEach((r) => { counts[r.emoji] = r.count; });
        myReaction = reactions.mine;
        paintReactions();
      } catch (e) { alert(e.message); }
    }

    /* ----- comments ----- */
    const commentsBox = box.querySelector('#pvPhotoComments');
    const renderPhotoComment = (c) => {
      const isReply = !!c.parentId;
      const item = el(`
        <div class="comment${isReply ? ' is-reply' : ''}" data-id="${c.id}">
          <img class="avatar sm" src="${avatarUrl(c.author.avatar)}" />
          <div class="c-body">
            <div class="c-head"><b class="c-author" data-u="${esc(c.author.username)}">${esc(c.author.displayName)}</b> <span class="hint">${fmtDate(c.at)}</span></div>
            <div class="c-text"></div>
            <div class="c-reacts"></div>
            <div class="c-actions"></div>
            ${isReply ? '' : '<div class="c-replies"></div>'}
          </div>
        </div>
      `);
      item.querySelector('.c-text').textContent = c.body;
      item.querySelector('.c-author').addEventListener('click', () => { close(); showProfile(c.author.username); });

      if (c.canDelete) {
        const del = el('<button class="ghost small">Delete</button>');
        del.addEventListener('click', async () => {
          try {
            await api.del('/api/social/photo-comment/' + c.id);
            item.remove();
            if (!commentsBox.querySelector('.comment')) commentsBox.appendChild(el('<div class="hint">No comments yet.</div>'));
            paintReactions();
          } catch (e) { alert(e.message); }
        });
        item.querySelector('.c-head').appendChild(del);
      }

      /* ----- emoji reactions on this comment ----- */
      const reactsBox = item.querySelector('.c-reacts');
      c.reactions = c.reactions || { reactions: [], total: 0, mine: null };
      const paintCommentReacts = () => {
        reactsBox.innerHTML = '';
        (c.reactions.reactions || []).forEach((r) => {
          const pill = el(`<button class="cr-pill${c.reactions.mine === r.emoji ? ' on' : ''}"><span>${r.emoji}</span><span class="cr-n">${r.count}</span></button>`);
          pill.addEventListener('click', () => reactComment(r.emoji));
          reactsBox.appendChild(pill);
        });
        const add = el('<button class="cr-add" title="Add a reaction">😊 ＋</button>');
        add.addEventListener('click', () => {
          const open = item.querySelector('.cr-picker');
          if (open) { open.remove(); return; }
          const picker = el('<div class="cr-picker"></div>');
          GALLERY_REACTIONS.forEach((g) => {
            const b = el(`<button title="${esc(g.label)}">${g.emoji}</button>`);
            b.addEventListener('click', () => { picker.remove(); reactComment(g.emoji); });
            picker.appendChild(b);
          });
          reactsBox.after(picker);
        });
        reactsBox.appendChild(add);
      };
      const reactComment = async (emoji) => {
        try {
          const { reactions } = await api.post('/api/social/photo-comment/' + c.id + '/react', { emoji });
          c.reactions = reactions;
          paintCommentReacts();
        } catch (e) { alert(e.message); }
      };
      paintCommentReacts();

      /* ----- reply ----- */
      const actions = item.querySelector('.c-actions');
      const replyBtn = el('<button class="c-reply-btn">↩ Reply</button>');
      actions.appendChild(replyBtn);
      replyBtn.addEventListener('click', () => {
        const existing = item.querySelector(':scope > .c-body > .reply-form');
        if (existing) { existing.remove(); return; }
        const form = el(`<div class="reply-form"><input maxlength="500" placeholder="Reply to ${esc(c.author.displayName)}…" /><button class="primary small">Reply</button></div>`);
        const input = form.querySelector('input');
        const submit = async () => {
          const body = input.value.trim();
          if (!body) return;
          try {
            const parentId = c.parentId || c.id;
            const { comment } = await api.post('/api/social/photo/' + photo.id + '/comment', { body, parentId });
            form.remove();
            const threadTop = commentsBox.querySelector('.comment[data-id="' + comment.parentId + '"]');
            const container = threadTop && threadTop.querySelector('.c-replies');
            if (container) container.appendChild(renderPhotoComment(comment));
            paintReactions();
          } catch (e) { alert(e.message); }
        };
        form.querySelector('button').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        actions.after(form);
        input.focus();
      });

      /* ----- nested replies (top-level comments only) ----- */
      if (!isReply && c.replies && c.replies.length) {
        const container = item.querySelector('.c-replies');
        c.replies.forEach((rc) => container.appendChild(renderPhotoComment(rc)));
      }

      return item;
    };

    if (!isOwner) {
      const form = el(`
        <div class="comment-form">
          <input id="pcInput" maxlength="500" placeholder="Say something about this photo…" />
          <button class="primary small" id="pcSend">Post</button>
        </div>
      `);
      box.querySelector('#pvPhotoForm').appendChild(form);
      const input = form.querySelector('#pcInput');
      const send = async () => {
        const body = input.value.trim();
        if (!body) return;
        try {
          const { comment } = await api.post('/api/social/photo/' + photo.id + '/comment', { body });
          input.value = '';
          const hint = commentsBox.querySelector('.hint');
          if (hint) hint.remove();
          commentsBox.prepend(renderPhotoComment(comment));
          paintReactions();
        } catch (e) { alert(e.message); }
      };
      form.querySelector('#pcSend').addEventListener('click', send);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    }

    /* ----- slider navigation ----- */
    function go(delta) {
      if (!multi) return;
      idx = (idx + delta + items.length) % items.length;
      photo = items[idx];
      loadPhoto();
    }
    if (multi) {
      box.querySelector('.pv-prev').addEventListener('click', () => go(-1));
      box.querySelector('.pv-next').addEventListener('click', () => go(1));
      // Swipe on the image to page between photos.
      let sx = null;
      const media = box.querySelector('.pv-media');
      media.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
      media.addEventListener('touchend', (e) => {
        if (sx == null) return;
        const dx = e.changedTouches[0].clientX - sx;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        sx = null;
      });
    }

    // Paint the currently-selected photo, then load its authoritative detail
    // (comments + reaction counts) from the server.
    // Caption (#tags), place and music for the current item. Music chosen for
    // a photo — or for an uploaded reel — plays while it's open; music recorded
    // into a reel is already in its soundtrack.
    function paintDetails() {
      stopBgMusic();
      const track = photo.music && gxmMusic.byId(photo.music);
      const bits = [];
      if (photo.caption) bits.push(`<p class="pv-caption">${captionHtml(photo.caption)}</p>`);
      if (photo.location) bits.push(`<div class="pv-place">📍 ${esc(photo.location)}</div>`);
      if (track) bits.push(`<div class="pv-music">🎵 ${esc(track.name)}${photo.musicMixed ? '' : ' <button class="ghost small pv-music-toggle"></button>'}</div>`);
      detailsEl.innerHTML = bits.join('');
      detailsEl.style.display = bits.length ? '' : 'none';
      if (!track || photo.musicMixed) return;
      const btn = detailsEl.querySelector('.pv-music-toggle');
      const paintBtn = () => { btn.textContent = bgMusic ? '🔇 Mute' : '🔊 Play'; };
      btn.addEventListener('click', () => {
        if (bgMusic) { stopBgMusic(); musicMuted = true; } else { bgMusic = gxmMusic.play(photo.music, { volume: 0.35 }); musicMuted = false; }
        paintBtn();
      });
      if (!musicMuted) bgMusic = gxmMusic.play(photo.music, { volume: 0.35 });
      paintBtn();
    }

    function loadPhoto() {
      paintDetails();
      const isReel = photo.kind === 'reel';
      mediaImg.classList.toggle('hidden', isReel);
      mediaVid.classList.toggle('hidden', !isReel);
      if (isReel) {
        mediaImg.removeAttribute('src');
        mediaVid.src = photo.url;
        mediaVid.play().catch(() => {}); // autoplay with sound may be blocked; controls stay available
      } else {
        mediaVid.pause();
        mediaVid.removeAttribute('src');
        mediaVid.load();
        mediaImg.src = photo.url;
      }
      countEl.textContent = multi ? `${idx + 1} / ${items.length}` : '';
      countEl.style.display = multi ? '' : 'none';
      counts = {};
      (photo.reactions || []).forEach((r) => { counts[r.emoji] = r.count; });
      myReaction = photo.myReaction || null;
      const ci = box.querySelector('#pcInput');
      if (ci) ci.value = '';
      commentsBox.innerHTML = '<div class="hint">Loading…</div>';
      paintReactions();
      loadDetail();
    }
    async function loadDetail() {
      const target = photo; // guard against navigating away mid-request
      try {
        const detail = await api.get('/api/social/photo/' + target.id);
        if (photo !== target) return;
        counts = {};
        detail.reactions.reactions.forEach((r) => { counts[r.emoji] = r.count; });
        myReaction = detail.reactions.mine;
        commentsBox.innerHTML = '';
        if (!detail.comments.length) commentsBox.appendChild(el('<div class="hint">No comments yet.</div>'));
        else detail.comments.forEach((c) => commentsBox.appendChild(renderPhotoComment(c)));
        paintReactions();
      } catch (e) {
        if (photo !== target) return;
        commentsBox.innerHTML = '';
        commentsBox.appendChild(el(`<div class="hint">${esc(e.message)}</div>`));
        paintReactions();
      }
    }

    loadPhoto();
  }

  // Render the GIF "feelings" collection into an already-built profile view.
  // Non-owners see the GIFs they're allowed to (subject to the owner's chosen
  // visibility); the owner additionally gets a visibility selector and upload +
  // delete controls. Clicking any GIF opens the slideshow at that GIF.
  // Follower counts, the Follow button (someone else's profile) and the friend
  // fee setting (your own profile). Following is free and earns the member a
  // point. Friend requests cost the sender the member's friend fee once
  // accepted; the member earns double. The fee is fixed on each request when
  // it's sent, so changing it never touches earlier requests.
  function renderFollow(view, profile, isMe) {
    let f = profile.follow || { followers: 0, following: 0, isFollowing: false };
    const counts = view.querySelector('#pvFollowCounts');
    const paintCounts = () => {
      counts.innerHTML = `<strong>${f.followers}</strong> follower${f.followers === 1 ? '' : 's'} · <strong>${f.following}</strong> following`;
    };
    paintCounts();

    const slot = view.querySelector('#pvFollow');
    if (slot) {
      const paintBtn = () => {
        slot.innerHTML = '';
        const btn = f.isFollowing
          ? el('<button class="ghost following-btn" title="Unfollow">✓ Following</button>')
          : el('<button class="ghost" title="Free — they earn a point, and you see a preview of their profile and their updates on Recent Activity.">➕ Follow</button>');
        btn.addEventListener('click', async () => {
          if (f.isFollowing && !confirm(`Unfollow ${profile.displayName || '@' + profile.username}?`)) return;
          btn.disabled = true;
          try {
            const out = f.isFollowing
              ? await api.del('/api/follow/' + encodeURIComponent(profile.username))
              : await api.post('/api/follow/' + encodeURIComponent(profile.username), {});
            f = out.follow;
            // Following changes what of the profile is visible: reload it.
            if (profile.access !== 'full') return showProfile(profile.username);
            paintCounts();
            paintBtn();
          } catch (e) { btn.disabled = false; alert(e.message); }
        });
        slot.appendChild(btn);
      };
      paintBtn();
    }

    const feeBox = view.querySelector('#pvFriendFee');
    if (isMe && feeBox) {
      api.get('/api/social/friend-fee').then((me) => {
        feeBox.innerHTML = `
          <div class="ff-row">
            <label for="ffInput">Friend request fee</label>
            <input id="ffInput" type="number" min="0" max="${me.maxFee}" step="1" value="${me.fee}" />
            <span class="ff-gain">you earn <strong id="ffGain">${me.gain}</strong> per accepted request</span>
            <button class="ghost small" id="ffSave">Save</button>
          </div>
          <p class="hint">When you accept someone’s friend request, they pay this many points (0–${me.maxFee}) and you receive double. Changing it only affects future requests; unfriending reverses it. So far you’ve earned <strong>${me.earned}</strong> from friend requests and spent <strong>${me.spent}</strong> on yours. Followers are free and earn you 1 point each.</p>
        `;
        const input = feeBox.querySelector('#ffInput');
        const gain = feeBox.querySelector('#ffGain');
        input.addEventListener('input', () => { gain.textContent = (Number(input.value) || 0) * me.multiplier; });
        feeBox.querySelector('#ffSave').addEventListener('click', async () => {
          try {
            const out = await api.put('/api/social/friend-fee', { fee: Number(input.value) });
            gain.textContent = out.gain;
            notifyToast(`Friend fee saved: new requests cost ${out.fee}, you earn ${out.gain}.`);
          } catch (e) { alert(e.message); }
        });
      }).catch(() => {});
    }
  }

  function renderGifSection(view, profile, isMe) {
    const gifBox = view.querySelector('#pvGifs');
    const gifCount = view.querySelector('#gifCount');
    const gifSlideBtn = view.querySelector('#gifSlideshow');
    const visBox = view.querySelector('#pvGifVisibility');
    if (!gifBox) return;

    const gifItems = () =>
      Array.from(gifBox.querySelectorAll('.cell img')).map((im) => ({ url: im.src, caption: im.dataset.caption || '' }));
    const updateGifCount = () => {
      const n = gifBox.querySelectorAll('.cell').length;
      gifCount.textContent = isMe ? `(${n}/${MAX_GIFS})` : (n ? `(${n})` : '');
    };
    const syncGifSlideBtn = () => {
      if (gifSlideBtn) gifSlideBtn.style.display = gifBox.querySelector('.cell') ? '' : 'none';
    };

    const makeGifCell = (g) => {
      const cell = el(`<div class="cell gif-cell">
        <img src="${esc(g.url)}" loading="lazy" data-caption="${esc(g.caption || '')}" />
        <span class="cell-zoom">⤢</span>
        ${g.caption ? `<span class="gif-cap"></span>` : ''}
      </div>`);
      if (g.caption) cell.querySelector('.gif-cap').textContent = g.caption;
      const open = () => {
        const cells = Array.from(gifBox.querySelectorAll('.cell'));
        openSlideshow(gifItems(), cells.indexOf(cell), { autoplay: false });
      };
      cell.querySelector('img').addEventListener('click', open);
      cell.querySelector('.cell-zoom').addEventListener('click', open);
      if (isMe) {
        const del = el('<button class="del" title="Delete GIF">✕</button>');
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm('Delete this GIF?')) return;
          try {
            await api.del('/api/profile/gifs/' + g.id);
            cell.remove();
            updateGifCount();
            refreshGifAddBtn();
            syncGifSlideBtn();
            if (!gifBox.querySelector('.cell')) gifBox.appendChild(el('<div class="hint">No GIFs yet.</div>'));
          } catch (e) { alert(e.message); }
        });
        cell.appendChild(del);
      }
      return cell;
    };

    // Populate the grid (or an appropriate empty/locked hint).
    const gifs = profile.gifs || [];
    if (gifs.length) {
      gifs.forEach((g) => gifBox.appendChild(makeGifCell(g)));
    } else if (profile.gifsLocked) {
      const why = profile.gifVisibility === 'friends'
        ? 'Only their connections can see these GIFs.'
        : 'These GIFs are private.';
      gifBox.appendChild(el(`<div class="hint">🔒 ${why}</div>`));
    } else {
      gifBox.appendChild(el('<div class="hint">No GIFs yet.</div>'));
    }
    updateGifCount();
    syncGifSlideBtn();

    if (gifSlideBtn) {
      gifSlideBtn.addEventListener('click', () => openSlideshow(gifItems(), 0, { autoplay: true }));
    }

    // Owner-only: visibility selector + uploader.
    let gifAddBtn = null;
    function refreshGifAddBtn() {
      if (!gifAddBtn) return;
      const full = gifBox.querySelectorAll('.cell').length >= MAX_GIFS;
      gifAddBtn.disabled = full;
      gifAddBtn.textContent = full ? `Collection full (${MAX_GIFS})` : '＋ Add GIF';
    }
    if (!isMe) return;

    // Visibility selector.
    const sel = el('<select class="gif-vis-select" title="Who can see your GIFs"></select>');
    GIF_VISIBILITY.forEach((o) => {
      const opt = el(`<option value="${o.value}">${o.label}</option>`);
      if ((profile.gifVisibility || 'public') === o.value) opt.selected = true;
      sel.appendChild(opt);
    });
    const visWrap = el('<div class="gif-vis"><span class="hint">Who can see these:</span></div>');
    visWrap.appendChild(sel);
    visBox.appendChild(visWrap);
    sel.addEventListener('change', async () => {
      const prev = sel.dataset.prev || profile.gifVisibility || 'public';
      try {
        await api.put('/api/profile/gifs/visibility', { visibility: sel.value });
        sel.dataset.prev = sel.value;
        notifyToast('GIF visibility updated.');
      } catch (e) { alert(e.message); sel.value = prev; }
    });
    sel.dataset.prev = profile.gifVisibility || 'public';

    // Uploader — GIF files only; no cropping, so animation is preserved.
    gifAddBtn = el('<button class="ghost small" style="margin-top:12px">＋ Add GIF</button>');
    const gifIn = el('<input type="file" accept="image/gif" class="hidden" />');
    gifAddBtn.addEventListener('click', () => gifIn.click());
    gifIn.addEventListener('change', async () => {
      const picked = gifIn.files[0];
      gifIn.value = '';
      if (!picked) return;
      if (!/image\/gif/i.test(picked.type)) { alert('Please choose a GIF file.'); return; }
      const caption = (prompt('Add a short caption for this GIF (optional):', '') || '').trim().slice(0, 80);
      const fd = new FormData();
      fd.append('gif', picked);
      if (caption) fd.append('caption', caption);
      try {
        const { gif } = await api.postForm('/api/profile/gifs', fd);
        const hint = gifBox.querySelector('.hint');
        if (hint) hint.remove();
        gifBox.prepend(makeGifCell(gif));
        updateGifCount();
        refreshGifAddBtn();
        syncGifSlideBtn();
      } catch (e) { alert(e.message); }
    });
    view.appendChild(gifIn);
    gifBox.after(gifAddBtn);
    refreshGifAddBtn();
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
      profile.gender,
      profile.country,
    ].filter(Boolean).join(' · ');

    const relLine = [profile.education, profile.educationStream, profile.workStatus].filter(Boolean).map(esc).join(' · ');

    const badges = [];
    if (profile.gender) badges.push(`${genderIcon(profile.gender)} ${esc(profile.gender)}`);
    const place = [profile.city, profile.state, profile.country].filter(Boolean).join(', ');
    if (place) badges.push(`📍 ${esc(place)}`);
    const badgesHtml = badges.map((b) => `<span class="badge">${b}</span>`).join('');


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
              <div class="follow-counts" id="pvFollowCounts"></div>
              ${badgesHtml ? `<div class="pro-badges">${badgesHtml}</div>` : ''}
              ${relLine ? `<div class="rel-line">🎓 ${relLine}</div>` : ''}
            </div>
            <div class="pro-rating" title="Overall — the mean of the four rating dimensions">
              <div class="pro-score">${score}</div>
              <div class="stars">${starsHtml(profile.rating.average, false)}</div>
              <div class="pro-rcount">${profile.rating.count} rating${profile.rating.count === 1 ? '' : 's'}</div>
              <div class="pro-likes" title="Likes received on the Highway (counts toward leaderboard rank)">❤️ ${profile.likes || 0} like${(profile.likes || 0) === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div class="pro-actions pv-actions">
            ${!isMe && profile.friends.state === 'friends' ? '<button class="primary" id="pvChat">💬 Message</button>' : ''}
            ${!isMe ? `<span id="pvFollow"></span>` : ''}
            ${!isMe ? `<span id="pvFriend"></span>` : ''}
            ${!isMe ? `<span id="pvBlock"></span>` : ''}
            ${isMe ? '<button class="ghost" id="pvEdit">✎ Edit profile</button>' : ''}
            ${isMe ? '<button class="ghost" id="pvCameraTop" title="Take a photo or record a reel for your gallery">📷 Camera</button>' : ''}
            <button class="ghost" id="pvShare" title="Copy a shareable link to this profile">🔗 Share</button>
            ${isMe && profile.referralCode ? '<button class="ghost" id="pvRefer" title="Invite someone to join getxmatch with your referral code">🎟️ Refer</button>' : ''}
          </div>
          ${isMe && profile.referralCode ? `<div class="referral-box">Your referral code: <b class="referral-code">${esc(profile.referralCode)}</b>
            <span class="hint">You get 4 points for everyone who joins with it, and they get 2.</span></div>` : ''}
          ${isMe ? '<div class="follow-fee-box" id="pvFriendFee"></div>' : ''}
          ${!isMe && profile.access !== 'full' ? `<div class="access-note">🔒 ${profile.access === 'follower'
            ? `You follow ${esc(profile.displayName)}, so you see a preview. Become friends to see the complete profile and to chat.`
            : `Follow ${esc(profile.displayName)} to see a preview of their photos and their updates on Recent Activity. Become friends to see the complete profile and to chat.`}</div>` : ''}
        </div>

        <div class="pro-grid">
          <div class="pro-col-main">
            ${profile.about ? card('📝', 'About me', `<p class="rich">${esc(profile.about)}</p>`) : ''}
            <section class="card">
              <h3 class="card-title">📷 Gallery <span class="hint" id="galCount"></span>
                <button class="ghost small gal-slideshow" id="galSlideshow" title="Play as slideshow" style="float:right">▶ Slideshow</button>
              </h3>
              <div class="gallery" id="pvGallery"></div>
            </section>
            ${profile.access === 'full' ? `<section class="card">
              <h3 class="card-title">🎞️ GIF feelings <span class="hint" id="gifCount"></span>
                <button class="ghost small gal-slideshow" id="gifSlideshow" title="Play as slideshow" style="float:right">▶ Slideshow</button>
              </h3>
              <p class="hint" style="margin:-4px 0 10px">GIFs that capture a mood. ${isMe ? `Up to ${MAX_GIFS}. Choose who can see them below.` : 'Open one to slide through them.'}</p>
              <div id="pvGifVisibility"></div>
              <div class="gallery gif-gallery" id="pvGifs"></div>
            </section>` : ''}
            ${isMe ? `<section class="card">
              <h3 class="card-title">🎞️ Profile picture buffer <span class="hint" id="bufCount"></span></h3>
              <p class="hint" style="margin:-4px 0 10px">Up to ${MAX_BUFFER} pictures. In chat, your picture is picked at random from these and changes every 20 seconds.</p>
              <div class="gallery" id="pvBuffer"></div>
            </section>` : ''}
            ${profile.access === 'full' ? `<section class="card">
              <h3 class="card-title">💬 Comments</h3>
              <div id="pvCommentForm"></div>
              <div class="comments" id="pvComments"></div>
            </section>` : ''}
          </div>
          <div class="pro-col-side">
            <section class="card pro-qr-card">
              <h3 class="card-title">🔳 Profile QR code</h3>
              <a class="pro-qr-link" href="/u/${encodeURIComponent(profile.username)}" target="_blank" rel="noopener" title="Open ${esc(profile.displayName || profile.username)}’s profile link">
                <img class="pro-qr" src="/qr/u/${encodeURIComponent(profile.username)}.png" alt="QR code for @${esc(profile.username)}’s getxmatch profile" width="200" height="256" loading="lazy" />
              </a>
              <p class="hint">${isMe ? 'Your permanent getxmatch QR code. Anyone who scans or taps it lands on your profile.' : 'Scan or tap to open this profile.'}</p>
              <div class="row-actions">
                <button class="ghost small" id="pvQrShare">📤 Share QR</button>
                <a class="ghost small btn-link" href="/qr/u/${encodeURIComponent(profile.username)}.png?download=1" download="getxmatch-${esc(profile.username)}-qr.png">⬇ Download</a>
              </div>
            </section>
            <section class="card">
              <h3 class="card-title">⭐ Ratings</h3>
              ${!isMe ? '<p class="hint" style="margin:-4px 0 12px">Rate them 1–5 stars on each.</p>' : ''}
              <div id="pvRatings"></div>
            </section>
            ${profile.interests.length ? card('❤️', 'Interests', `<div class="chip-row">${profile.interests.map((i) => `<span class="chip static">${esc(i)}</span>`).join('')}</div>`) : ''}
            <section class="card">
              <h3 class="card-title">👥 Connections <span class="hint">(${profile.friends.count})</span></h3>
              <div id="pvFriends"></div>
            </section>
          </div>
        </div>
      </div>
    `);
    main.innerHTML = '';
    main.appendChild(view);

    /* ----- ratings: four independent 1-5 star dimensions ----- */
    renderRatingsCard(view, profile, isMe, username);

    /* ----- friend & block buttons ----- */
    const anyBlock = !isMe && profile.blocked && (profile.blocked.iBlocked || profile.blocked.blockedMe || profile.blocked.ageWall);
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
      galCount.textContent = profile.access === 'full' ? `(${n})` : `(${profile.galleryTotal || 0})`;
    };
    // The photos currently in the grid, in DOM order — the slider pages through
    // exactly these. Each cell keeps a reference to its photo + meta repainter.
    const galleryPhotos = () => Array.from(gal.querySelectorAll('.cell')).map((c) => c._photo).filter(Boolean);
    const metaUpdaters = new Map(); // photoId -> (state) => repaint that cell's badges
    const makeCell = (ph) => {
      ph.reactionCount = ph.reactionCount || 0;
      ph.commentCount = ph.commentCount || 0;
      const isReel = ph.kind === 'reel';
      const cell = isReel
        ? el(`<div class="cell reel-cell"><video src="${ph.url}#t=0.1" muted playsinline preload="metadata"></video><span class="reel-badge">▶ ${fmtReelTime(ph.duration)}</span><span class="cell-zoom">⤢</span><span class="cell-meta"></span></div>`)
        : el(`<div class="cell"><img src="${ph.url}" loading="lazy" /><span class="cell-zoom">⤢</span><span class="cell-meta"></span></div>`);
      cell._photo = ph;
      const meta = cell.querySelector('.cell-meta');
      const paintMeta = () => {
        const bits = [];
        if (ph.reactionCount) bits.push(`❤ ${ph.reactionCount}`);
        if (ph.commentCount) bits.push(`💬 ${ph.commentCount}`);
        meta.textContent = bits.join('  ');
        meta.style.display = bits.length ? '' : 'none';
      };
      paintMeta();
      metaUpdaters.set(ph.id, (s) => {
        ph.reactionCount = s.reactionCount;
        ph.commentCount = s.commentCount;
        ph.myReaction = s.myReaction;
        paintMeta();
      });
      const open = () => openPhotoViewer(ph, {
        isOwner: isMe,
        ownerUsername: profile.username,
        items: galleryPhotos(),
        onUpdate: (s, forPhoto) => {
          const fn = metaUpdaters.get((forPhoto || ph).id);
          if (fn) fn(s);
        },
      });
      cell.querySelector(isReel ? 'video' : 'img').addEventListener('click', open);
      cell.querySelector('.cell-zoom').addEventListener('click', open);
      if (isReel) cell.querySelector('.reel-badge').addEventListener('click', open);
      if (isMe) {
        const del = el(`<button class="del" title="Delete ${isReel ? 'reel' : 'photo'}">✕</button>`);
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm(isReel ? 'Delete this reel?' : 'Delete this photo?')) return;
          try { await api.del('/api/profile/gallery/' + ph.id); metaUpdaters.delete(ph.id); cell.remove(); updateCount(); syncGalSlideBtn(); }
          catch (e) { alert(e.message); }
        });
        cell.appendChild(del);
      }
      return cell;
    };
    if (!profile.gallery.length) {
      gal.appendChild(el(`<div class="hint">${profile.access === 'full' || !profile.galleryTotal
        ? 'No photos or reels yet.'
        : `🔒 ${profile.galleryTotal} photo${profile.galleryTotal === 1 ? '' : 's'} — follow to see a preview, or become friends to see them all.`}</div>`));
    } else profile.gallery.forEach((ph) => gal.appendChild(makeCell(ph)));
    updateCount();
    if (profile.access === 'follower' && profile.galleryTotal > profile.gallery.length) {
      gal.after(el(`<p class="hint gal-locked">🔒 Showing the newest ${profile.gallery.length} of ${profile.galleryTotal}. Become friends to see the whole gallery.</p>`));
    }

    /* ----- gallery slideshow ----- */
    const galSlideBtn = view.querySelector('#galSlideshow');
    const galItems = () =>
      Array.from(gal.querySelectorAll('.cell img')).map((im) => ({ url: im.src }));
    const syncGalSlideBtn = () => {
      if (galSlideBtn) galSlideBtn.style.display = gal.querySelector('.cell img') ? '' : 'none';
    };
    if (galSlideBtn) {
      galSlideBtn.addEventListener('click', () => openSlideshow(galItems(), 0, { autoplay: true }));
      syncGalSlideBtn();
    }

    // Adding to the gallery (own profile): pick a photo or reel from the
    // device, or capture one with the in-app camera. There's no limit on how
    // many; each item can carry a caption with #tags, a place and music.
    const addPosted = (photo) => {
      const hint = gal.querySelector('.hint');
      if (hint) hint.remove();
      gal.prepend(makeCell(photo));
      updateCount();
      syncGalSlideBtn();
    };
    if (isMe) {
      const bar = el(`<div class="gal-add-row">
        <button class="primary small" id="pvCamera" title="Take a photo or record a reel">📷 Camera</button>
        <button class="ghost small" id="pvAdd">＋ Add photo</button>
        <button class="ghost small" id="pvAddReel">＋ Add reel</button>
        <span class="hint gal-upload-status"></span>
      </div>`);
      const status = bar.querySelector('.gal-upload-status');
      const fileIn = el('<input type="file" accept="image/*" class="hidden" />');
      const reelIn = el('<input type="file" accept="video/mp4,video/quicktime,video/webm,video/*" class="hidden" />');
      bar.querySelector('#pvCamera').addEventListener('click', () => openCamera(addPosted));
      bar.querySelector('#pvAdd').addEventListener('click', () => fileIn.click());
      bar.querySelector('#pvAddReel').addEventListener('click', () => reelIn.click());

      fileIn.addEventListener('change', async () => {
        const picked = fileIn.files[0];
        fileIn.value = '';
        if (!picked) return;
        const cropped = await cropImage(picked);
        if (!cropped) return;
        const url = URL.createObjectURL(cropped);
        const details = await openPostDetails({ kind: 'photo', previewUrl: url });
        URL.revokeObjectURL(url);
        if (!details) return;
        try {
          addPosted(await postGalleryItem('photo', cropped, details, (pct) => { status.textContent = `Uploading… ${pct}%`; }));
        } catch (e) { alert(e.message); }
        status.textContent = '';
      });

      // Reels picked from the device: length and size are checked here first
      // so nobody waits on an upload the server would reject anyway.
      reelIn.addEventListener('change', async () => {
        const picked = reelIn.files[0];
        reelIn.value = '';
        if (!picked) return;
        if (picked.size > MAX_REEL_MB * 1024 * 1024) {
          alert(`Reels can be up to ${MAX_REEL_MB} MB. This video is ${Math.round(picked.size / 1048576)} MB.`);
          return;
        }
        const secs = await readVideoDuration(picked);
        if (secs != null && secs > MAX_REEL_SECONDS + 0.5) {
          alert(`Reels can be up to 1 minute long. This video is ${Math.round(secs)} seconds — please trim it and try again.`);
          return;
        }
        const url = URL.createObjectURL(picked);
        const details = await openPostDetails({ kind: 'reel', previewUrl: url });
        URL.revokeObjectURL(url);
        if (!details) return;
        try {
          addPosted(await postGalleryItem('reel', picked, details, (pct) => { status.textContent = `Uploading reel… ${pct}%`; }));
        } catch (e) { alert(e.message); }
        status.textContent = '';
      });
      view.appendChild(fileIn);
      view.appendChild(reelIn);
      gal.after(bar);
    }

    const camTop = view.querySelector('#pvCameraTop');
    if (camTop) camTop.addEventListener('click', () => openCamera(addPosted));

    /* ----- GIF "feelings" collection (complete profile only) ----- */
    if (profile.access === 'full') renderGifSection(view, profile, isMe);

    /* ----- profile picture buffer (own profile only) ----- */
    if (isMe) {
      const buf = view.querySelector('#pvBuffer');
      const bufCount = view.querySelector('#bufCount');
      const updateBufCount = () => {
        bufCount.textContent = `(${buf.querySelectorAll('.cell').length}/${MAX_BUFFER})`;
      };
      const makeBufCell = (ph) => {
        const cell = el(`<div class="cell"><img src="${ph.url}" loading="lazy" /><span class="cell-zoom">⤢</span></div>`);
        cell.querySelector('img').addEventListener('click', () => openLightbox(ph.url));
        cell.querySelector('.cell-zoom').addEventListener('click', () => openLightbox(ph.url));
        const del = el('<button class="del" title="Remove picture">✕</button>');
        del.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          if (!confirm('Remove this picture from your buffer?')) return;
          try { await api.del('/api/profile/buffer/' + ph.id); cell.remove(); updateBufCount(); refreshBufBtn(); }
          catch (e) { alert(e.message); }
        });
        cell.appendChild(del);
        return cell;
      };
      const bufList = profile.buffer || [];
      if (!bufList.length) buf.appendChild(el('<div class="hint">No pictures yet.</div>'));
      else bufList.forEach((ph) => buf.appendChild(makeBufCell(ph)));
      updateBufCount();

      const bufBtn = el('<button class="ghost small" style="margin-top:12px">＋ Add picture</button>');
      function refreshBufBtn() {
        const full = buf.querySelectorAll('.cell').length >= MAX_BUFFER;
        bufBtn.disabled = full;
        bufBtn.textContent = full ? `Buffer full (${MAX_BUFFER})` : '＋ Add picture';
      }
      const bufIn = el('<input type="file" accept="image/*" class="hidden" />');
      bufBtn.addEventListener('click', () => bufIn.click());
      bufIn.addEventListener('change', async () => {
        const picked = bufIn.files[0];
        bufIn.value = '';
        if (!picked) return;
        const cropped = await cropImage(picked);
        if (!cropped) return;
        const fd = new FormData();
        fd.append('photo', cropped);
        try {
          const { photo } = await api.postForm('/api/profile/buffer', fd);
          const hint = buf.querySelector('.hint');
          if (hint) hint.remove();
          buf.prepend(makeBufCell(photo));
          updateBufCount();
          refreshBufBtn();
        } catch (e) { alert(e.message); }
        bufIn.value = '';
      });
      view.appendChild(bufIn);
      buf.after(bufBtn);
      refreshBufBtn();
    }

    /* ----- connections, grouped into a block per relationship kind ----- */
    const friendsBox = view.querySelector('#pvFriends');
    if (profile.access !== 'full' && profile.friends.count) {
      friendsBox.appendChild(el('<div class="hint">🔒 Only friends can see who they’re connected with.</div>'));
    } else if (!profile.friends.list.length) {
      friendsBox.appendChild(el('<div class="hint">No connections yet.</div>'));
    } else {
      // Bucket each accepted connection by its relationship kind.
      seedOnline(profile.friends.list);
      const byType = {};
      profile.friends.list.forEach((f) => {
        const t = REL_TYPES[f.relType] ? f.relType : 'friend';
        (byType[t] = byType[t] || []).push(f);
      });
      // Render one labelled block per kind: the special bonds first (canonical
      // order), plain friends last.
      const displayOrder = [...REL_ORDER.filter((t) => t !== 'friend'), 'friend'];
      displayOrder.forEach((t) => {
        const members = byType[t];
        if (!members || !members.length) return;
        const meta = REL_TYPES[t];
        // Everything other than plain friends is a "special" bond that gets a
        // highlighted, colour-coded card so it stands out.
        const special = t !== 'friend' ? ' rel-special' : '';
        const group = el(`<div class="rel-group rel-${t}${special}"></div>`);
        group.appendChild(el(
          `<div class="rel-group-head"><span class="rel-emoji">${meta.emoji}</span> ${esc(meta.label)} <span class="hint">(${members.length})</span></div>`
        ));
        const row = el('<div class="friend-row"></div>');
        members.forEach((f) => {
          const chip = el(`<div class="friend-chip" title="@${esc(f.username)}">${avatarWithPresence(f.id, f.avatar, 'sm')}<span>${esc(f.displayName)}</span></div>`);
          chip.addEventListener('click', () => showProfile(f.username));
          row.appendChild(chip);
        });
        group.appendChild(row);
        friendsBox.appendChild(group);
      });
    }

    /* ----- comments ----- */
    const commentsBox = view.querySelector('#pvComments');
    if (commentsBox) {
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
    }

    /* ----- follows ----- */
    renderFollow(view, profile, isMe);

    /* ----- misc wiring ----- */

    view.querySelector('#pvBack').addEventListener('click', () => {
      if (state.peer) openChat(state.peer);
      else { document.getElementById('shell').classList.remove('viewing-main'); main.innerHTML = ''; }
    });
    const editBtn = view.querySelector('#pvEdit');
    if (editBtn) editBtn.addEventListener('click', () => renderProfileEditor(false));

    // Shareable profile link. Anyone who opens it lands on this member's
    // profile; signing up is required before they can do anything.
    // Share the QR image itself where the device supports sharing files (most
    // phones → WhatsApp, Instagram, Telegram …); otherwise share/copy the link.
    const qrShare = view.querySelector('#pvQrShare');
    if (qrShare) {
      qrShare.addEventListener('click', async () => {
        const link = location.origin + '/u/' + encodeURIComponent(profile.username);
        const text = `${profile.displayName || profile.username} on getxmatch`;
        try {
          const blob = await (await fetch('/qr/u/' + encodeURIComponent(profile.username) + '.png')).blob();
          const file = new File([blob], `getxmatch-${profile.username}-qr.png`, { type: 'image/png' });
          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: text, text: `${text}: ${link}` });
            return;
          }
          if (navigator.share) { await navigator.share({ title: text, url: link }); return; }
        } catch (e) { if (e && e.name === 'AbortError') return; }
        try { await navigator.clipboard.writeText(link); notifyToast('Profile link copied — the QR opens it too.'); }
        catch (_e) { prompt('Copy this profile link:', link); }
      });
    }

    const shareBtn = view.querySelector('#pvShare');
    if (shareBtn) {
      const link = location.origin + '/u/' + encodeURIComponent(profile.username);
      shareBtn.addEventListener('click', async () => {
        if (navigator.share) {
          try { await navigator.share({ title: profile.displayName, url: link }); return; }
          catch (_e) { /* user cancelled or unsupported — fall back to copy */ }
        }
        try { await navigator.clipboard.writeText(link); notifyToast('Profile link copied to share'); }
        catch (_e) { prompt('Copy this link to share:', link); }
      });
    }
    // Refer: same as Share, but the link invites someone to sign up with my code.
    const referBtn = view.querySelector('#pvRefer');
    if (referBtn) {
      const link = location.origin + '/?ref=' + encodeURIComponent(profile.referralCode);
      const text = `Join me on getxmatch! Use my referral code ${profile.referralCode} when you sign up.`;
      referBtn.addEventListener('click', async () => {
        if (navigator.share) {
          try { await navigator.share({ title: 'Join getxmatch', text, url: link }); return; }
          catch (_e) { /* user cancelled or unsupported — fall back to copy */ }
        }
        try { await navigator.clipboard.writeText(link); notifyToast('Referral link copied to share'); }
        catch (_e) { prompt('Copy this link to share:', link); }
      });
    }
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
    } else if (b.ageWall) {
      // One of you is under 18 and the other isn't — no contact is possible.
      slot.appendChild(el('<span class="pill" title="Members under 18 and adults cannot contact each other">Age-restricted</span>'));
    } else {
      const btn = el('<button class="ghost small">🚫 Block</button>');
      btn.addEventListener('click', () => act(
        () => api.post('/api/social/block/' + u),
        'Block @' + profile.username + '? This removes any friendship and stops all messages and gifts between you.'
      ));
      slot.appendChild(btn);
    }

    // Ignore (one-way mute of their Highway posts) — independent of blocking.
    const ig = profile.ignore || {};
    if (ig.iIgnore) {
      const un = el('<button class="ghost small" title="Stop ignoring">🔕 Ignoring — undo</button>');
      un.addEventListener('click', () => act(() => api.del('/api/social/ignore/' + u)));
      slot.appendChild(un);
    } else if (!b.iBlocked) {
      const ib = el('<button class="ghost small" title="Hide their Highway posts from your feed">🔕 Ignore</button>');
      ib.addEventListener('click', () => act(() => api.post('/api/social/ignore/' + u)));
      slot.appendChild(ib);
    }

    // Report — always available (except on yourself, which never reaches here).
    const rep = el('<button class="ghost small" title="Report this profile">🚩 Report</button>');
    rep.addEventListener('click', async () => {
      const reason = prompt('Report @' + profile.username + '?\nOptionally add a reason:', '');
      if (reason === null) return; // cancelled
      try {
        const res = await api.post('/api/social/report/' + u, { reason: reason || '' });
        notify(res.message || 'Reported.');
      } catch (e) {
        if (e.data && e.data.suspended) return; // handled by the global suspended notice
        alert(e.message);
      }
    });
    slot.appendChild(rep);
  }

  // "Add friend" button: sends a friend request to `username`, then calls
  // `refresh`.
  // `fee` (optional) is what the request costs once accepted (they earn double).
  function relationshipRequestEl(username, refresh, fee) {
    const u = encodeURIComponent(username);
    const priced = Number.isInteger(fee);
    const b = el(`<button class="primary small" title="Send a friend request${priced ? ` — if accepted it costs you ${fee} point${fee === 1 ? '' : 's'} and they earn ${fee * 2}` : ''}">🤝 Add friend${priced && fee ? ` · ${fee} pt${fee === 1 ? '' : 's'}` : ''}</button>`);
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (priced && fee && !confirm(`Send a friend request? If they accept, it costs you ${fee} point${fee === 1 ? '' : 's'} and they earn ${fee * 2}.`)) return;
      b.disabled = true;
      try {
        const out = await api.post('/api/social/friend/' + u, {});
        if (!priced && out && out.fee) notifyToast(`Friend request sent. If accepted, it costs you ${out.fee} point${out.fee === 1 ? '' : 's'} and they earn ${out.theyEarn}.`);
        refreshRequestBadge();
        refresh();
      } catch (err) { alert(err.message); b.disabled = false; }
    });
    return b;
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
        slot.appendChild(relationshipRequestEl(profile.username, refresh, profile.friends.fee));
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
      case 'friends': return el('<span class="pill friend-pill">✓ Connected</span>');
      case 'outgoing': return btn('Cancel request', 'ghost', () => api.del('/api/social/friend/' + u));
      case 'incoming': return btn('Accept request', 'primary', () => api.post('/api/social/friend/' + u + '/accept'));
      default: return relationshipRequestEl(username, refresh);
    }
  }

  function openExplore(view) {
    if (view === 'highway') return renderHighway();
    if (view === 'notifications') return renderNotifications();
    if (view === 'requests') return renderRequests();
    if (view === 'quizzes') return renderQuizzes();
    if (view === 'polls') return renderPolls();
    if (view === 'blogs') return renderBlogs();
    if (view === 'leaderboard') return renderLeaderboard();
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

    /* ----- likes + comments (any registered user) ----- */
    const likes = p.likes || { count: 0, mine: false };
    const foot = el(`
      <div class="hw-foot">
        <button class="hw-like${likes.mine ? ' on' : ''}" type="button" title="Like this post">
          <span class="hw-like-ico">${likes.mine ? '❤️' : '🤍'}</span>
          <span class="hw-like-n">${likes.count || ''}</span>
        </button>
        <button class="hw-comment-toggle" type="button" title="Show comments">
          💬 <span class="hw-comment-n">${p.commentCount || ''}</span>
        </button>
      </div>
    `);
    card.appendChild(foot);
    const commentsBox = el('<div class="hw-comments" hidden></div>');
    card.appendChild(commentsBox);

    const setCommentCount = (n) => {
      foot.querySelector('.hw-comment-n').textContent = n || '';
    };

    const likeBtn = foot.querySelector('.hw-like');
    let likeBusy = false;
    likeBtn.addEventListener('click', async () => {
      if (likeBusy) return;
      likeBusy = true;
      try {
        const { likes: st } = await api.post('/api/highway/' + p.id + '/like', {});
        likeBtn.classList.toggle('on', st.mine);
        likeBtn.querySelector('.hw-like-ico').textContent = st.mine ? '❤️' : '🤍';
        likeBtn.querySelector('.hw-like-n').textContent = st.count || '';
      } catch (e) { alert(e.message); }
      finally { likeBusy = false; }
    });

    const cToggle = foot.querySelector('.hw-comment-toggle');
    let loaded = false;
    cToggle.addEventListener('click', async () => {
      commentsBox.hidden = !commentsBox.hidden;
      if (commentsBox.hidden || loaded) return;
      loaded = true;
      await loadHighwayComments(commentsBox, p, setCommentCount);
    });

    return card;
  }

  // Build one Highway comment row. `onCount(n)` keeps the post's counter in sync.
  function highwayCommentEl(c, listEl, onCount) {
    const item = el(`
      <div class="hw-comment" data-id="${c.id}">
        <img class="avatar sm" src="${avatarUrl(c.author.avatar)}" alt="" />
        <div class="hw-comment-body">
          <div class="hw-comment-head">
            <b class="hw-comment-author"></b>
            <span class="hint">${fmtDate(c.at)} · ${fmtTime(c.at)}</span>
          </div>
          <div class="hw-comment-text"></div>
        </div>
      </div>
    `);
    const author = item.querySelector('.hw-comment-author');
    author.textContent = c.author.displayName;
    author.style.cursor = 'pointer';
    author.addEventListener('click', () => showProfile(c.author.username));
    item.querySelector('.hw-comment-text').textContent = c.body;
    if (c.canDelete) {
      const del = el('<button class="ghost small hw-comment-del" title="Delete comment">✕</button>');
      del.addEventListener('click', async () => {
        try {
          const res = await api.del('/api/highway/comment/' + c.id);
          item.remove();
          if (!listEl.querySelector('.hw-comment')) listEl.appendChild(el('<div class="hint">No comments yet.</div>'));
          if (res && typeof res.commentCount === 'number') onCount(res.commentCount);
        } catch (e) { alert(e.message); }
      });
      item.querySelector('.hw-comment-head').appendChild(del);
    }
    return item;
  }

  // Populate a post's comments panel: the thread + an add-a-comment box.
  async function loadHighwayComments(box, p, onCount) {
    box.innerHTML = `
      <div class="hw-comment-list"><div class="hint">Loading…</div></div>
      <div class="hw-comment-form">
        <input class="hw-comment-input" maxlength="500" placeholder="Write a comment…" />
        <button class="primary small hw-comment-send" type="button">Post</button>
      </div>`;
    const list = box.querySelector('.hw-comment-list');
    const input = box.querySelector('.hw-comment-input');
    const sendBtn = box.querySelector('.hw-comment-send');

    const send = async () => {
      const body = input.value.trim();
      if (!body) return;
      sendBtn.disabled = true;
      try {
        const res = await api.post('/api/highway/' + p.id + '/comment', { body });
        input.value = '';
        const hint = list.querySelector('.hint');
        if (hint) hint.remove();
        list.appendChild(highwayCommentEl(res.comment, list, onCount));
        if (typeof res.commentCount === 'number') onCount(res.commentCount);
      } catch (e) { alert(e.message); }
      finally { sendBtn.disabled = false; }
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

    try {
      const { comments } = await api.get('/api/highway/' + p.id + '/comments');
      list.innerHTML = '';
      if (!comments.length) list.appendChild(el('<div class="hint">No comments yet.</div>'));
      else comments.forEach((c) => list.appendChild(highwayCommentEl(c, list, onCount)));
    } catch (e) {
      list.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
    }
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

  // Load the set of users I ignore, so live feeds can filter their content.
  async function loadIgnored() {
    try {
      const { ids } = await api.get('/api/social/ignored');
      state.ignored = {};
      (ids || []).forEach((id) => { state.ignored[id] = true; });
    } catch (_e) { /* ignore */ }
  }

  // Live socket push: a new post from anyone. Fill in viewer-specific fields.
  function pushHighwayPost(payload) {
    if (!highwayFeed || !document.body.contains(highwayFeed)) { highwayFeed = null; return; }
    if (payload.author && state.ignored[payload.author.id]) return; // muted author
    const mine = !!(state.me && payload.author && payload.author.id === state.me.id);
    prependHighwayPost(highwayFeed, {
      id: payload.id, body: payload.body, image: payload.image,
      createdAt: payload.createdAt, author: payload.author, mine, friendState: mine ? 'self' : 'none',
    });
    trimHighwayFeed(highwayFeed);
  }

  /* ---------- Friend requests ---------- */
  /* ---------- Notifications ---------- */
  // Compatibility results (links you shared that someone completed, and links
  // you completed) plus quizzes and polls published since your last login.
  async function renderNotifications() {
    const main = openMainView();
    main.appendChild(sectionShell('Notifications', 'Compatibility results from shared quizzes, and new quizzes and polls since your last login.'));
    const body = main.querySelector('#sectionBody');
    let data;
    try { data = await api.get('/api/notifications'); }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }

    // Opening the section marks everything as read.
    api.post('/api/notifications/read', {}).catch(() => {});
    const badge = document.getElementById('notifBadge');
    if (badge) badge.classList.add('hidden');
    markNav('notifications', false);

    const items = data.items || [];
    if (!items.length) {
      body.innerHTML = '<div class="empty-main">🔔 You’re all caught up. When someone takes a quiz you shared — or a new quiz or poll is published — it will show up here.</div>';
      return;
    }
    body.innerHTML = '';
    const list = el('<div class="notif-list card"></div>');
    items.forEach((it) => list.appendChild(notificationEl(it)));
    body.appendChild(list);
  }

  function notificationEl(it) {
    let icon = '🔔';
    let html = '';
    if (it.kind === 'match_shared') {
      icon = '🧩';
      html = `<strong>${esc(it.otherName)}</strong> attempted the quiz you shared, <em>“${esc(it.quizTitle)}”</em>. ` +
        `You’re <strong>${it.percent}% compatible</strong> (${it.score} of ${it.total} answers in common).`;
    } else if (it.kind === 'match_answered') {
      icon = '🧩';
      html = `You attempted <strong>${esc(it.otherName)}</strong>’s shared quiz <em>“${esc(it.quizTitle)}”</em>. ` +
        `You’re <strong>${it.percent}% compatible</strong> (${it.score} of ${it.total} answers in common).`;
    } else if (it.kind === 'follow') {
      icon = '➕';
      html = `<strong>${esc(it.otherName)}</strong> started following you.`;
    } else if (it.kind === 'new_quiz') {
      icon = '🧠';
      html = `New quiz: <strong>${esc(it.title)}</strong>`;
    } else if (it.kind === 'new_poll') {
      icon = '📊';
      html = `New poll: <strong>${esc(it.title)}</strong>`;
    }
    const pts = it.points ? `<span class="notif-pts">+${it.points} pts</span>` : '';
    const row = el(`
      <div class="notif-item${it.unread ? ' unread' : ''}" role="link" tabindex="0">
        <div class="notif-icon">${icon}</div>
        <div class="notif-main">
          <div class="notif-text">${html}</div>
          <div class="notif-meta hint">${it.unread ? '<span class="notif-new">New</span> · ' : ''}${fmtDate(it.at)} · ${fmtTime(it.at)}${pts ? ' · ' + pts : ''}</div>
        </div>
        <div class="notif-go">${it.kind === 'follow' ? '›' : '↗'}</div>
      </div>
    `);
    const open = () => {
      if (it.kind === 'follow') { if (it.otherUsername) showProfile(it.otherUsername); return; }
      window.open(it.link, '_blank', 'noopener');
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return row;
  }

  async function renderRequests() {
    const main = openMainView();
    main.appendChild(sectionShell('Friend Requests', 'People who want to be your friend. View their profile, then accept or decline.'));
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
              <div class="handle">@${esc(u.username)} · wants to be your friend</div>
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

  /* ---------- Quizzes ---------- */
  // "2 min 30 s" / "45 s".
  function fmtSecs(total) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (!m) return `${s} s`;
    return s ? `${m} min ${s} s` : `${m} min`;
  }

  // A quiz card's total time: sum of the per-question limits.
  function quizTimeLabel(q) {
    if (!q.questionCount) return '—';
    if (!q.totalSeconds) return 'No time limit';
    return fmtSecs(q.totalSeconds) + (q.untimedQuestions ? ` + ${q.untimedQuestions} untimed` : '');
  }

  async function renderQuizzes() {
    const main = openMainView();
    main.appendChild(sectionShell('Quizzes', 'Answer timed questions to earn points. Compatibility quizzes also give you a link to share — see how much you have in common.'));
    const body = main.querySelector('#sectionBody');
    let quizzes;
    try { quizzes = (await api.get('/api/content/quizzes')).quizzes; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    if (!quizzes.length) { body.innerHTML = '<div class="empty-main">No quizzes yet. Check back soon!</div>'; return; }
    body.innerHTML = '';
    const grid = el('<div class="card-grid"></div>');
    quizzes.forEach((q) => {
      // Clicking a quiz opens its own page in a new tab, where a registered user
      // takes it (a logged-out visitor is prompted to register).
      const url = '/quizzes/' + q.id;
      const card = el(`
        <div class="tile quiz-tile-link" role="link" tabindex="0" title="Open this quiz in a new tab">
          ${q.categoryLabel ? `<span class="quiz-type quiz-cat">${esc(q.categoryLabel)}</span>` : ''}
          ${q.shareable ? `<span class="quiz-type">${esc(q.typeLabel)}</span>` : ''}
          <h3>${esc(q.title)}</h3>
          <p class="rich">${esc(q.description || '')}</p>
          <ul class="quiz-stats">
            <li><span>Questions</span><strong>${q.questionCount}</strong></li>
            <li><span>Total time</span><strong>${esc(quizTimeLabel(q))}</strong></li>
            <li><span>Negative marking</span><strong>${q.negativeMarks ? `Yes · −${q.negativeMarks} per unanswered` : 'No'}</strong></li>
            <li><span>Attempted by</span><strong>${q.attemptedBy} ${q.attemptedBy === 1 ? 'person' : 'people'}</strong></li>
          </ul>
          <div class="quiz-top-h">Top scorers</div>
          <div class="quiz-top"></div>
          <button class="primary small" data-take="${q.id}">${q.shareable ? 'Attempt &amp; share ↗' : 'Attempt ↗'}</button>
        </div>
      `);
      const topBox = card.querySelector('.quiz-top');
      if (!q.topScorers || !q.topScorers.length) topBox.appendChild(el('<div class="hint">No attempts yet — be the first!</div>'));
      (q.topScorers || []).forEach((t, i) => {
        const rowEl = el(`<button type="button" class="quiz-top-row" title="View profile">
          <span class="quiz-medal">${['🥇', '🥈', '🥉'][i] || '#' + (i + 1)}</span>
          <img class="avatar xs" src="${avatarUrl(t.avatar)}" alt="" />
          <span class="quiz-top-name">${esc(t.displayName)}</span>
          <span class="quiz-top-pts">${t.points} pts${t.durationMs != null ? ' · ' + fmtSecs(Math.max(1, Math.round(t.durationMs / 1000))) : ''}</span>
        </button>`);
        rowEl.addEventListener('click', (e) => { e.stopPropagation(); showProfile(t.username); });
        topBox.appendChild(rowEl);
      });
      const open = () => window.open(url, '_blank', 'noopener');
      card.querySelector('[data-take]').addEventListener('click', (e) => { e.stopPropagation(); open(); });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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

    // Load ads up front so interstitials between questions are ready.
    loadAds().catch(() => {});

    body.innerHTML = '';
    const total = quiz.questions.length;
    const answers = quiz.questions.map(() => -1);
    let adCount = 0; // running index into the content_inline slot list

    const form = el('<div class="quiz-form card"></div>');
    form.appendChild(el('<p class="hint">Pick the answer that fits you for each question. When you finish you\'ll get a private link to send to someone — your shared score is revealed once they answer too.</p>'));
    const stepHost = el('<div class="quiz-step"></div>');
    form.appendChild(stepHost);
    const result = el('<div class="msg" id="quizResult"></div>');
    form.appendChild(result);
    const share = el('<div class="share-box" hidden></div>');
    form.appendChild(share);
    body.appendChild(form);

    // Show an interstitial ad while switching pages, then run `next`. Falls
    // through immediately when no inline ad is configured.
    function interstitial(next) {
      const ad = slotEl('content_inline', adCount++);
      if (!ad) { next(); return; }
      result.className = 'msg'; result.textContent = '';
      stepHost.innerHTML = '';
      const wrap = el('<div class="quiz-interstitial"></div>');
      ad.classList.add('ad-inline-row');
      wrap.appendChild(ad);
      const cont = el('<button class="primary">Continue ›</button>');
      const row = el('<div class="row-actions"></div>');
      row.appendChild(cont);
      wrap.appendChild(row);
      stepHost.appendChild(wrap);
      cont.addEventListener('click', next);
    }

    async function submitAnswers(submitBtn) {
      submitBtn.disabled = true;
      try {
        const out = await api.post('/api/content/quizzes/' + id + '/match', { answers });
        stepHost.innerHTML = '';
        result.className = 'msg ok';
        result.textContent = 'Your answers are locked in. Share this link — it stays active for 24 hours.';
        renderShareBox(share, out.token);
      } catch (e) {
        submitBtn.disabled = false;
        result.className = 'msg error';
        result.textContent = e.message;
      }
    }

    function renderStep(i) {
      result.className = 'msg'; result.textContent = '';
      stepHost.innerHTML = '';
      const qq = quiz.questions[i];
      stepHost.appendChild(el(`<div class="quiz-progress">Question ${i + 1} of ${total}</div>`));
      const block = el(`<div class="quiz-q"><div class="quiz-prompt">${i + 1}. ${esc(qq.prompt)}</div></div>`);
      qq.options.forEach((opt, oi) => {
        const optEl = el(`<label class="quiz-opt"><input type="radio" name="q${i}" value="${oi}"${answers[i] === oi ? ' checked' : ''} /> <span>${esc(opt)}</span></label>`);
        optEl.querySelector('input').addEventListener('change', () => { answers[i] = oi; });
        block.appendChild(optEl);
      });
      stepHost.appendChild(block);

      const actions = el('<div class="row-actions"></div>');
      if (i > 0) {
        const prev = el('<button class="ghost">‹ Back</button>');
        prev.addEventListener('click', () => interstitial(() => renderStep(i - 1)));
        actions.appendChild(prev);
      } else {
        const quit = el('<button class="ghost">Back to quizzes</button>');
        quit.addEventListener('click', renderQuizzes);
        actions.appendChild(quit);
      }
      const last = i === total - 1;
      const next = el(`<button class="primary">${last ? 'Get my share link' : 'Next ›'}</button>`);
      next.addEventListener('click', () => {
        if (answers[i] < 0) {
          result.className = 'msg error';
          result.textContent = 'Please pick an answer to continue.';
          return;
        }
        if (last) submitAnswers(next);
        else interstitial(() => renderStep(i + 1));
      });
      actions.appendChild(next);
      stepHost.appendChild(actions);
    }

    renderStep(0);
  }

  // Render the shareable link + copy / WhatsApp / Telegram buttons.
  function renderShareBox(host, token) {
    const link = location.origin + '/m/' + token;
    const text = 'Take this compatibility quiz with me — let\'s see how much we have in common! ' + link;
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
    const grid = el('<div class="card-grid polls-grid"></div>');
    polls.forEach((p) => grid.appendChild(pollCard(p)));
    body.appendChild(grid);
    decorateSectionWithAds(main);
  }

  function pollCard(p) {
    // Clicking a poll opens its own page in a new tab, where a registered user
    // votes (a logged-out visitor is prompted to register). The card here shows
    // a read-only preview of the current tallies.
    const url = '/polls/' + p.id;
    const card = el(`<div class="tile poll-card poll-card-link" role="link" tabindex="0" title="Open this poll in a new tab">
      <h3>${esc(p.question)}</h3>${p.closed ? '<span class="pill">Closed</span>' : ''}
      <div class="poll-opts"></div>
      <div class="poll-open">${p.closed ? 'See results ↗' : 'Open &amp; vote ↗'}</div>
    </div>`);
    const optsBox = card.querySelector('.poll-opts');
    p.options.forEach((opt, oi) => {
      const count = p.counts[oi] || 0;
      const pct = p.total ? Math.round((count / p.total) * 100) : 0;
      const mine = p.myVote === oi;
      optsBox.appendChild(el(`
        <div class="poll-opt${mine ? ' mine' : ''}" data-i="${oi}">
          <div class="poll-bar poll-bar-split" style="width:${pct}%">${voteBarSegs(p.genders && p.genders[oi])}</div>
          <span class="poll-label">${esc(opt)}${mine ? ' ✓' : ''}</span>
          <span class="poll-pct">${pct}% · ${count}</span>
        </div>
      `));
    });
    optsBox.appendChild(el(VOTE_LEGEND_HTML));
    optsBox.appendChild(el(`<div class="hint" style="margin-top:8px">${p.total} vote${p.total === 1 ? '' : 's'}</div>`));
    const open = () => window.open(url, '_blank', 'noopener');
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
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
    main.appendChild(sectionShell('Leaderboard', 'Kings & Queens ranks everyone by overall points. The four quiz boards rank members by the points they earned in that category’s quizzes. Points can go below zero: a stopped quiz and every quiz reattempt cost 10 points. Earn points from quizzes, ratings, Highway likes, friends and accepted friend requests (the sender pays your friend fee, you earn double), polls (5 per poll), compatibility links (10 for sharing, 5 for answering) and followers (1 each).'));
    const body = main.querySelector('#sectionBody');
    let boards;
    try {
      const out = await api.get('/api/leaderboard');
      boards = out.boards || [{ id: 'kings_queens', label: 'Kings & Queens', emoji: '👑', description: '', rows: out.leaderboard || [] }];
    } catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    body.innerHTML = '';

    if (!boards.some((b) => b.id === state.lbBoard)) state.lbBoard = boards[0].id;
    const tabs = el('<div class="lb-tabs" role="tablist"></div>');
    const panel = el('<div></div>');
    boards.forEach((b) => {
      const t = el(`<button type="button" role="tab" class="lb-tab${b.id === 'kings_queens' ? ' lb-tab-kq' : ''}">${b.emoji} ${esc(b.label)}</button>`);
      t.addEventListener('click', () => { state.lbBoard = b.id; paint(); });
      t.dataset.board = b.id;
      tabs.appendChild(t);
    });
    body.appendChild(tabs);
    body.appendChild(panel);

    function paint() {
      const board = boards.find((b) => b.id === state.lbBoard);
      tabs.querySelectorAll('.lb-tab').forEach((t) => {
        const on = t.dataset.board === board.id;
        t.classList.toggle('on', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      const kq = board.id === 'kings_queens';
      panel.innerHTML = '';
      const card = el(`
        <div class="lb-board card${kq ? ' lb-kq' : ''}">
          <div class="lb-board-head">
            <div class="lb-board-emoji">${board.emoji}</div>
            <div><h3>${esc(board.label)}</h3><div class="hint">${esc(board.description || '')}</div></div>
          </div>
          <div class="lb-list"></div>
        </div>
      `);
      const list = card.querySelector('.lb-list');
      if (!board.rows.length) {
        list.appendChild(el(`<div class="empty-main">${kq ? 'No ranked members yet.' : `No one has points in ${esc(board.label)} yet — take one of its quizzes to be first!`}</div>`));
      }
      board.rows.forEach((r) => {
        const medal = r.rank === 1 ? (kq ? '👑' : '🥇') : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `#${r.rank}`;
        const row = el(`
          <div class="lb-row${r.isMe ? ' me' : ''}${kq && r.rank <= 3 ? ' lb-top' : ''}">
            <div class="lb-rank">${medal}</div>
            <img class="avatar sm" src="${avatarUrl(r.avatar)}" />
            <div class="lb-id">
              <div class="name">${esc(r.displayName)}${r.isMe ? ' <span class="pill">you</span>' : ''}</div>
              <div class="handle">@${esc(r.username)}${r.country ? ' · ' + esc(r.country) : ''}</div>
            </div>
            <div class="lb-stats">
              ${kq ? `
              <span title="Average rating">⭐ ${r.ratingAvg || '—'}</span>
              <span title="Likes received on the Highway">❤️ ${r.likes || 0}</span>
              <span title="Friends">👥 ${r.friends}</span>
              <span title="Quizzes">🧠 ${r.quizzes}</span>
              <span title="Polls voted in">📊 ${r.polls || 0}</span>
              <span title="Followers">➕ ${r.followers || 0}</span>` : `
              <span title="Overall points (Kings &amp; Queens)">👑 ${r.totalPoints} overall</span>`}
            </div>
            <div class="lb-score${r.points < 0 ? ' neg' : ''}" title="${kq ? `Overall points${r.penalty ? ` (${r.penalty} deducted for stopped quizzes and reattempts)` : ''}` : `Points in ${esc(board.label)} quizzes`}">${r.points} pts</div>
            <div class="lb-action"></div>
          </div>
        `);
        row.querySelector('.lb-id').addEventListener('click', () => showProfile(r.username));
        row.querySelector('.avatar').addEventListener('click', () => showProfile(r.username));
        const fb = friendButtonEl(r.username, r.friendState, renderLeaderboard);
        if (fb) row.querySelector('.lb-action').appendChild(fb);
        list.appendChild(row);
      });
      panel.appendChild(card);
    }
    paint();
  }

  /* ---------- Recent Activity ---------- */

  // Build one feed row. `live` items (streamed just now) show "just now".
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
    // News headline (matched to my interests): opens the article on the
    // source's own site.
    if (ev.type === 'news' && ev.news && /^https?:\/\//i.test(ev.news.link)) {
      item.classList.add('feed-news');
      const a = el('<a class="feed-news-link" target="_blank" rel="noopener noreferrer nofollow"></a>');
      a.href = ev.news.link;
      a.textContent = ev.text;
      const text = item.querySelector('.feed-text');
      text.textContent = '';
      text.appendChild(a);
      if (ev.news.snippet) text.after(Object.assign(document.createElement('div'), { className: 'feed-news-snippet', textContent: ev.news.snippet }));
      const meta = item.querySelector('.feed-time');
      meta.textContent = `${ev.news.source}${ev.news.interest ? ' · ' + ev.news.interest : ''} · ${meta.textContent}`;
    }
    if (ev.image) {
      const img = el('<img class="feed-thumb" alt="shared image" loading="lazy" />');
      img.src = ev.image;
      img.addEventListener('click', () => openLightbox(ev.image));
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

  /* ---- live activity feed ----
     Logged-in clients receive each new activity row over the socket
     ('activity:new' → pushLiveActivity); the sign-in page has no socket, so it
     polls instead (startAuthActivityPoll).
  */
  const activityFeeds = []; // mounted feed elements that live socket updates flow into
  const ACTIVITY_MAX = 200; // the feed shows the latest 200 activities (mirrors FEED_SIZE in src/routes/events.js)

  function activityIcon(activity) {
    const a = String(activity).toLowerCase();
    if (/(chat|messag|talk)/.test(a)) return '💬';
    if (/(match|paired|connect)/.test(a)) return '🧩';
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
      while (feed.querySelectorAll('.feed-item').length > ACTIVITY_MAX) feed.removeChild(feed.lastChild);
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
          while (feed.querySelectorAll('.feed-item').length > ACTIVITY_MAX) feed.removeChild(feed.lastChild);
        });
      } catch (_e) { /* ignore transient errors */ }
      setTimeout(poll, 6000);
    };
    setTimeout(poll, 6000);
  }

  boot();
})();
