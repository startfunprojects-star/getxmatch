/* getxmatch SPA */
(function () {
  'use strict';

  const root = document.getElementById('app');
  // Stroke chevrons for arrow buttons: unlike the ‹ › glyphs they sit dead
  // centre in a round button whatever the font.
  const CHEVRON_LEFT = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
  const CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

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

  /* ---------- Oversized photos: offer to compress ----------
     Photos must be IMAGE_MAX_BYTES or smaller (the server's MAX_UPLOAD_MB). When
     someone picks bigger ones we ask whether to compress them; on yes, each is
     re-encoded (and if needed scaled down) in the browser until it fits. GIFs
     can't be shrunk without losing their animation, so those are explained and
     skipped. */
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
  const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';

  // Ask a yes/no question in a modal. Resolves true (yes) / false (no / closed).
  function askYesNo(title, html, yesLabel, noLabel) {
    return new Promise((resolve) => {
      const { card, close } = openModal(title, `
        <div class="ask-body">${html}</div>
        <div class="row-actions">
          <button class="primary" type="button" data-ans="yes">${esc(yesLabel)}</button>
          ${noLabel ? `<button class="ghost" type="button" data-ans="no">${esc(noLabel)}</button>` : ''}
        </div>`);
      let done = false;
      const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
      card.querySelector('[data-ans="yes"]').addEventListener('click', () => finish(true));
      const no = card.querySelector('[data-ans="no"]');
      if (no) no.addEventListener('click', () => finish(false));
      // ✕ or a click outside counts as "no".
      new MutationObserver((_m, obs) => {
        if (!document.body.contains(card)) { obs.disconnect(); finish(false); }
      }).observe(document.body, { childList: true });
    });
  }

  /* In-app replacements for the browser's confirm() / prompt(). The browser's
     own dialogs dim the whole page, and on some phones and in-app browsers the
     page isn't redrawn after they close — it stays blurred or white until a
     refresh. These are ordinary page elements, so that can't happen. */
  function confirmBox(message, okLabel) {
    const html = esc(message).replace(/\n/g, '<br>');
    return askYesNo('Please confirm', `<p>${html}</p>`, okLabel || 'OK', 'Cancel');
  }

  // Every alert(...) in this file shows the in-app message box instead of the
  // browser's (this declaration shadows window.alert inside the app).
  function alert(message) {
    return askYesNo('Notice', `<p>${esc(String(message == null ? '' : message)).replace(/\n/g, '<br>')}</p>`, 'OK', '');
  }

  // Resolves with the text entered (possibly ''), or null when cancelled.
  function promptBox(title, label, value) {
    return new Promise((resolve) => {
      const { card, close } = openModal(title, `
        <form class="prompt-form">
          ${label ? `<label class="hint">${esc(label)}</label>` : ''}
          <input type="text" class="prompt-input" maxlength="500" autocomplete="off" dir="auto" />
          <div class="row-actions">
            <button class="primary" type="submit">OK</button>
            <button class="ghost" type="button" data-cancel>Cancel</button>
          </div>
        </form>`);
      const input = card.querySelector('.prompt-input');
      input.value = value || '';
      let done = false;
      const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
      card.querySelector('.prompt-form').addEventListener('submit', (e) => { e.preventDefault(); finish(input.value); });
      card.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      new MutationObserver((_m, obs) => {
        if (!document.body.contains(card)) { obs.disconnect(); finish(null); }
      }).observe(document.body, { childList: true });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  // Shrink one photo under `max` bytes: lower the quality step by step, then
  // scale it down, keeping it as sharp as the limit allows. WebP keeps any
  // transparency; browsers that can't write WebP get JPEG on white. Resolves
  // with the smaller File, or null when it can't be brought under the limit.
  async function compressImage(file, max) {
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_e) {
      try { bitmap = await createImageBitmap(file); } catch (_e2) { return null; }
    }
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    const type = probe.toDataURL('image/webp').startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
    const target = max * 0.95; // a little headroom under the limit
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    for (let round = 0; round < 8; round++) {
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
      ctx.drawImage(bitmap, 0, 0, w, h);
      for (const q of [0.9, 0.82, 0.74, 0.65]) {
        const blob = await canvasBlob(canvas, type, q);
        if (blob && blob.size <= target) {
          if (bitmap.close) bitmap.close();
          const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + (type === 'image/webp' ? '.webp' : '.jpg');
          return new File([blob], name, { type });
        }
      }
      if (Math.max(w, h) <= 640) break; // already small — don't make it unusable
      scale *= 0.75;
    }
    if (bitmap.close) bitmap.close();
    return null;
  }

  // Check a set of picked files. Photos over the limit are offered compression
  // (one question for all of them). Resolves with the files to use: everything
  // that fits, plus the successfully compressed ones. Videos pass through.
  async function fitImagesToLimit(files, max) {
    max = max || IMAGE_MAX_BYTES;
    const list = Array.from(files || []).filter(Boolean);
    const big = list.filter((f) => /^image\//.test(f.type) && f.size > max);
    if (!big.length) return list;
    const gifs = big.filter((f) => /image\/gif/i.test(f.type));
    const photos = big.filter((f) => !/image\/gif/i.test(f.type));
    const limit = fmtMB(max);
    if (gifs.length) {
      await askYesNo('GIF too large',
        `<p>${gifs.length === 1 ? `This GIF is <b>${fmtMB(gifs[0].size)}</b>` : `${gifs.length} GIFs are`} over the ${limit} limit.
         GIFs can't be compressed without losing their animation, so ${gifs.length === 1 ? 'it' : 'they'} won't be added.
         Please choose a GIF that's ${limit} or smaller.</p>`, 'OK', '');
    }
    const keep = new Map(); // original → file to use
    if (photos.length) {
      const what = photos.length === 1
        ? `This photo is <b>${fmtMB(photos[0].size)}</b>`
        : `${photos.length} photos are larger than ${limit} (biggest: <b>${fmtMB(Math.max(...photos.map((f) => f.size)))}</b>)`;
      const yes = await askYesNo('Photo too large',
        `<p>${what}. Photos must be ${limit} or smaller.</p>
         <p>Compress ${photos.length === 1 ? 'it' : 'them'} to fit? ${photos.length === 1 ? 'It' : 'They'}'ll look almost the same.</p>`,
        'Compress', 'Cancel');
      if (!yes) {
        notifyToast(photos.length === 1 ? `Photo not added — it must be ${limit} or smaller.` : `${photos.length} photos not added — each must be ${limit} or smaller.`);
      } else {
        const busy = openModal('Compressing…', '<p class="hint">Making your photos smaller — this takes a moment.</p>');
        const failed = [];
        const shrunk = [];
        for (const f of photos) {
          const out = await compressImage(f, max);
          if (out) { keep.set(f, out); shrunk.push(`${fmtMB(f.size)} → ${fmtMB(out.size)}`); }
          else failed.push(f);
        }
        busy.close();
        if (failed.length) {
          await askYesNo('Couldn’t compress',
            `<p>${failed.length === 1 ? 'One photo' : `${failed.length} photos`} couldn't be brought under ${limit} without ruining the quality, so ${failed.length === 1 ? 'it' : 'they'} won't be added.
             Please choose a smaller photo${failed.length === 1 ? '' : 's'}.</p>`, 'OK', '');
        }
        if (shrunk.length) notifyToast(`Compressed: ${shrunk.join(', ')}`);
      }
    }
    // Keep the picked order; drop what didn't fit.
    return list
      .map((f) => (big.includes(f) ? keep.get(f) || null : f))
      .filter(Boolean);
  }

  // Single-file version: resolves with a file that fits, or null.
  async function fitImageToLimit(file, max) {
    if (!file) return null;
    const out = await fitImagesToLimit([file], max);
    return out[0] || null;
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
    { emoji: '❤️', label: 'Like' },
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
  const SUSPEND_REASONS = {
    'highway-reported': 'A Highway post of yours was reported by 5 members and has been removed. You can use getxmatch again in 6 hours.',
    'mass-reported': 'Your profile was reported by many members.',
    'report-abuse': 'Too many reports were filed from your account in a short time.',
  };
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
          ${data && data.reason ? `<p class="hint">Reason: ${esc(SUSPEND_REASONS[data.reason] || data.reason)}</p>` : ''}
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
            <div class="forgot-row"><a href="#" id="forgotLink">Forgot password?</a></div>
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
    const forgot = card.querySelector('#forgotLink');
    if (forgot) forgot.addEventListener('click', (e) => {
      e.preventDefault();
      renderForgot(String(new FormData(form).get('identifier') || '').trim());
    });
    if (authNotice) { msg.textContent = authNotice; msg.className = 'msg ok'; authNotice = ''; }

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

  // A one-time message shown on the next login screen (e.g. after a reset).
  let authNotice = '';

  /* Forgot password: email a 6-digit code, then enter it with a new password. */
  function renderForgot(prefill) {
    root.innerHTML = '';
    const card = el(`
      <div class="auth-wrap"><div class="auth-card">
        <h1 class="brand">get<span class="x">x</span>match</h1>
        <p class="auth-sub">Reset your password</p>
        <form id="fpStart">
          <label>Username or email</label>
          <input name="identifier" autocomplete="username" required />
          <p class="hint">We'll email a 6-digit code to the address on your account.</p>
          <div class="msg" id="fpMsg"></div>
          <button class="primary" type="submit" style="width:100%;margin-top:14px">Email me a code</button>
        </form>
        <form id="fpReset" hidden>
          <p class="hint" id="fpSent"></p>
          <label>Code from the email</label>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required
                 style="letter-spacing:8px;text-align:center;font-size:22px" />
          <label>New password</label>
          <input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required />
          <label>Repeat new password</label>
          <input name="password2" type="password" autocomplete="new-password" minlength="8" required />
          <div class="msg" id="fpMsg2"></div>
          <button class="primary" type="submit" style="width:100%;margin-top:14px">Set new password</button>
          <div class="auth-toggle"><a href="#" id="fpAgain">Send a new code</a></div>
        </form>
        <div class="auth-toggle"><a href="#" id="fpBack">Back to log in</a></div>
      </div></div>
    `);
    root.appendChild(card);
    const start = card.querySelector('#fpStart');
    const reset = card.querySelector('#fpReset');
    const showErr = (box, err) => { box.textContent = err.message; box.className = 'msg error'; };
    let identifier = '';
    start.identifier.value = prefill || '';

    const sendCode = async () => {
      await api.post('/api/auth/password/forgot', { identifier });
      start.hidden = true;
      reset.hidden = false;
      card.querySelector('#fpSent').textContent =
        `If “${identifier}” has an email address on getxmatch, we've sent it a code. It expires in 10 minutes. Members without an email address can ask the admin to reset their password.`;
      reset.code.focus();
    };
    start.addEventListener('submit', async (e) => {
      e.preventDefault();
      identifier = start.identifier.value.trim();
      const btn = start.querySelector('button');
      btn.disabled = true;
      try { await sendCode(); } catch (err) { showErr(card.querySelector('#fpMsg'), err); }
      btn.disabled = false;
    });
    card.querySelector('#fpAgain').addEventListener('click', async (e) => {
      e.preventDefault();
      try { await sendCode(); notifyToast('A new code is on its way.'); } catch (err) { showErr(card.querySelector('#fpMsg2'), err); }
    });
    reset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const box = card.querySelector('#fpMsg2');
      if (reset.password.value !== reset.password2.value) return showErr(box, new Error('The two passwords are different.'));
      try {
        await api.post('/api/auth/password/reset', { identifier, code: reset.code.value, password: reset.password.value });
        authNotice = 'Your password was changed. Log in with your new password.';
        renderAuth('login');
      } catch (err) { showErr(box, err); }
    });
    card.querySelector('#fpBack').addEventListener('click', (e) => { e.preventDefault(); renderAuth('login'); });
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
            ${e.avatar ? '<button class="ghost small" id="removeAvatar" type="button">Remove picture</button>' : ''}
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
    let removeAvatar = false;
    const rmAv = wrap.querySelector('#removeAvatar');
    if (rmAv) rmAv.addEventListener('click', () => {
      removeAvatar = true;
      avatarFile = null;
      wrap.querySelector('#avPreview').src = avatarUrl(null);
      rmAv.remove();
      notifyToast('Picture will be removed when you save.');
    });
    avInput.addEventListener('change', async () => {
      const picked = avInput.files[0] || null;
      avInput.value = '';
      if (!picked) return;
      // Let the user keep just part of it, then make sure it fits the 5 MB limit.
      const cropped = await fitImageToLimit(await cropImage(picked));
      if (!cropped) return; // cancelled / too large
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
      else if (removeAvatar) fd.append('removeAvatar', '1');

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
            <button data-view="suggestions">💡 Suggestions</button>
            <button data-view="account">⚙️ Account</button>
          </div>
          <div class="search"><input id="searchInput" placeholder="Search people…" /></div>
          <div class="list" id="list"></div>
        </aside>
        <div class="main-col">
          <div class="mobile-bar">
            <button class="ghost small" id="mobileBack" title="Back to the dashboard">${CHEVRON_LEFT}<span>Dashboard</span></button>
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
    initPush(); // installed app: icon badge + push notifications
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
    syncAppBadge();
  }

  /* ---------- installed app: icon badge + push notifications ---------- */
  // The badge on the home-screen icon = unread messages + unread Notifications.
  // While the app is closed the service worker (sw.js) keeps it up to date
  // from push messages; while it's open we set it here.
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let swReady = null;
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    if (!swReady) swReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
    return swReady;
  }
  function b64ToBytes(b64) {
    const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function subscribePush() {
    const reg = await registerServiceWorker();
    if (!reg || !reg.pushManager) throw new Error('Notifications aren’t supported here.');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api.get('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
  }
  async function pushEnabled() {
    if (!pushSupported || Notification.permission !== 'granted') return false;
    const reg = await registerServiceWorker();
    return !!(reg && reg.pushManager && await reg.pushManager.getSubscription());
  }
  // Called once after sign-in: keep this device's subscription fresh.
  function initPush() {
    registerServiceWorker();
    if (pushSupported && Notification.permission === 'granted') subscribePush().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAppBadge(); });
    syncAppBadge();
  }
  let badgeTimer = null;
  function syncAppBadge() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(async () => {
      try {
        const { count } = await api.get('/api/push/badge');
        if (navigator.setAppBadge) {
          if (count > 0) await navigator.setAppBadge(count);
          else await navigator.clearAppBadge();
        }
        // Nothing left unread: tidy away notifications already on the phone.
        if (!count && swReady) {
          const reg = await swReady;
          if (reg && reg.getNotifications) (await reg.getNotifications()).forEach((n) => n.close());
        }
      } catch (_e) { /* badge is best-effort */ }
    }, 800);
  }
  // Card at the top of Notifications offering to switch them on (it needs a tap:
  // browsers only ask for permission after one).
  async function pushPromptEl() {
    if (!pushSupported || await pushEnabled()) return null;
    if (Notification.permission === 'denied') {
      return el(`<div class="card push-prompt"><div class="hint">🔕 Notifications are blocked for getxmatch on this device.
        To see a dot on the app icon for new messages, quizzes and polls, allow notifications for getxmatch in your phone or browser settings.</div></div>`);
    }
    const card = el(`
      <div class="card push-prompt">
        <div><strong>📲 Get a dot on the app icon</strong><br>
        <span class="hint">See new messages, quizzes and polls on your phone even when getxmatch is closed.</span></div>
        <button type="button" class="primary">Turn on</button>
      </div>`);
    card.querySelector('button').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { card.remove(); return; }
        await subscribePush();
        card.innerHTML = '<div class="hint">✅ Notifications are on for this device.</div>';
        syncAppBadge();
      } catch (err) { e.target.disabled = false; notify(err.message || 'Could not turn on notifications.'); }
    });
    return card;
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
      // Every conversation from the server (newest first, with unread counts),
      // plus anyone chatted with this session who isn't on it yet.
      const [chats, gs] = await Promise.all([
        api.get('/api/social/chats').then((r) => r.chats || []).catch(() => null),
        api.get('/api/groups').then((r) => r.groups || []).catch(() => []),
      ]);
      (chats || []).forEach((c) => { state.chatPeers[c.id] = { ...(state.chatPeers[c.id] || {}), ...c }; });
      items = Object.values(state.chatPeers).filter((p) =>
        !q || (p.displayName || '').toLowerCase().includes(q.toLowerCase()) ||
        p.username.toLowerCase().includes(q.toLowerCase()));
      groups = gs;
      if (q) groups = groups.filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
    }

    listEl.innerHTML = '';
    if (!items.length && !groups.length) {
      listEl.appendChild(el(`<div style="padding:20px;color:var(--muted)">${state.tab === 'people' ? 'No people found yet.' : 'No conversations yet.'}</div>`));
      return;
    }
    // Chats tab: people and groups together, the latest conversation on top,
    // each with how many messages are waiting. People tab: search results.
    const rows = [
      ...groups.map((g) => ({ g, at: g.lastAt || 0, unread: state.group && state.group.gid === g.id ? 0 : (g.unread || 0) })),
      ...items.map((u) => ({ u, at: u.lastAt || 0, unread: state.peer && state.peer.id === u.id ? 0 : (u.unread || 0) })),
    ];
    if (state.tab !== 'people') {
      rows.sort((a, b) => b.at - a.at);
      // "Delete all chats" (for me only) above the conversation list.
      const bar = el('<div class="list-actions"><button type="button" class="ghost small" title="Delete every chat, for you only">🗑 Delete all chats</button></div>');
      bar.querySelector('button').addEventListener('click', clearAllConversations);
      listEl.appendChild(bar);
    }
    const unreadPill = (n) => (n ? `<span class="list-unread" title="${n} unread">${n > 99 ? '99+' : n}</span>` : '');
    rows.forEach(({ g, u, unread }) => {
      let row;
      if (g) {
        const joined = (g.members || []).filter((m) => m.status === 'joined');
        row = el(`
          <div class="list-item${unread ? ' has-unread' : ''}" data-id="g${g.id}">
            <div class="list-gicon">👥</div>
            <div style="min-width:0">
              <div class="name">${esc(g.name)}</div>
              <div class="handle">${joined.length}/${g.max} members</div>
            </div>
            ${unreadPill(unread)}
          </div>
        `);
        if (state.group && state.group.gid === g.id) row.classList.add('active');
        row.addEventListener('click', () => openGroup(g.id));
      } else {
        row = el(`
          <div class="list-item${unread ? ' has-unread' : ''}" data-id="${u.id}">
            ${avatarWithPresence(u.id, u.avatar, '')}
            <div style="min-width:0">
              <div class="name">${esc(u.displayName || u.username)}</div>
              <div class="handle">@${esc(u.username)}</div>
            </div>
            ${unreadPill(unread)}
          </div>
        `);
        if (state.peer && state.peer.id === u.id) row.classList.add('active');
        // Only friends can chat: searching for anyone else opens their profile.
        row.addEventListener('click', () => (state.tab === 'people' && !u.isFriend ? showProfile(u.username) : openChat(u)));
      }
      listEl.appendChild(row);
    });
  }

  // Sidebar default (People tab, no search): my accepted friends / relationships.
  // Each opens a chat when clicked. Search still finds anyone to message.
  async function renderFriendsList(listEl) {
    let friends = [];
    let chats = [];
    try {
      [friends, chats] = await Promise.all([
        api.get('/api/social/friends').then((r) => r.friends || []),
        api.get('/api/social/chats').then((r) => r.chats || []).catch(() => []),
      ]);
    } catch (_e) { /* fall through to empty state */ }
    if (!document.body.contains(listEl)) return; // navigated away while loading
    // Friends I've chatted with most recently first, with unread counts.
    const chatOf = new Map(chats.map((c) => [c.id, c]));
    friends.sort((a, b) => ((chatOf.get(b.id) || {}).lastAt || 0) - ((chatOf.get(a.id) || {}).lastAt || 0));

    listEl.innerHTML = '';
    if (!friends.length) {
      listEl.appendChild(el(
        `<div style="padding:20px;color:var(--muted)">No friends yet.<br><span class="hint">Search above to find people, follow them or send a friend request. Only friends can chat.</span></div>`
      ));
      return;
    }
    seedOnline(friends);
    friends.forEach((u) => {
      const n = state.peer && state.peer.id === u.id ? 0 : ((chatOf.get(u.id) || {}).unread || 0);
      const row = el(`
        <div class="list-item${n ? ' has-unread' : ''}" data-id="${u.id}">
          ${avatarWithPresence(u.id, u.avatar, '')}
          <div style="min-width:0">
            <div class="name">${esc(u.displayName || u.username)}</div>
            <div class="handle">@${esc(u.username)}</div>
          </div>
          ${n ? `<span class="list-unread" title="${n} unread">${n > 99 ? '99+' : n}</span>` : ''}
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

    cancelVoiceRecorder();
    state.peer = null;
    state.group = { gid, name: group.name, members: group.members, max: group.max };
    closeReactionPalette();
    registerGroupTab({ gid, name: group.name });
    document.querySelectorAll('.list-item').forEach((r) => r.classList.toggle('active', r.dataset.id === 'g' + gid));
    clearListUnread('g' + gid);
    syncAppBadge(); // opening it marked it read
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
          <div class="group-avatars">${joined.map((m) => `<img class="avatar sm" src="${avatarUrl(m.avatar)}" title="${esc(m.displayName)}"/>`).join('')}</div>
          <div class="chat-head-id">
            <div class="name">${esc(group.name)}</div>
            <div class="status">${joined.length}/${group.max} member${joined.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} invited` : ''}</div>
          </div>
          <button class="ghost small" id="groupCallBtn" title="Start or join the group's video call">📹 Call</button>
          <button class="ghost small" id="groupAddBtn" title="Add someone">＋ Add</button>
          <button class="ghost small" id="groupClearBtn" title="Delete this group's chat (for you)">🗑 Clear</button>
          ${isOwner ? '<button class="ghost small" id="groupRenameBtn" title="Rename this group">✎ Rename</button>' : ''}
          ${isOwner
            ? '<button class="ghost small" id="groupDeleteBtn" title="Delete this group for everyone">Delete</button>'
            : '<button class="ghost small" id="groupLeaveBtn" title="Leave this group">Leave</button>'}
        </div>
        <div class="chat-body" id="chatBody"></div>
        <div class="gift-picker hidden" id="giftPicker"></div>
        <div class="reply-banner hidden" id="replyBanner"></div>
        <div class="voice-recorder hidden" id="voiceRecorder"></div>
        <div class="composer-preview hidden" id="composerPreview"></div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="giftBtn" title="Send the group a gift">🎁</button>
          <button class="icon-btn" id="pollBtn" title="Create a poll">📊</button>
          <button class="icon-btn" id="quizBtn" title="Take a quiz together">🧩</button>
          <button class="icon-btn" id="voiceBtn" title="Record a voice note">🎤</button>
          <div class="composer-field">
            <button type="button" class="composer-more" title="Gift, poll or quiz" aria-label="More: gift, poll or quiz" aria-expanded="false">＋</button>
            <input type="text" id="msgInput" placeholder="Message the group…" autocomplete="off" dir="auto" />
            <button class="icon-btn" id="attachBtn" title="Share a file with the group (delivered live to members online, never stored)">📎</button>
          </div>
          <button class="primary" id="sendBtn" aria-label="Send"><span class="send-label">Send</span></button>
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

    view.querySelector('#groupAddBtn').addEventListener('click', () => openGroupAdder(state.group));
    view.querySelector('#groupClearBtn').addEventListener('click', () => clearConversation('group', gid));
    view.querySelector('#groupCallBtn').addEventListener('click', () =>
      startCall({ kind: 'group', groupId: gid, name: group.name }));
    reflectGroupCall(group.callCount || 0);
    const leaveBtn = view.querySelector('#groupLeaveBtn');
    if (leaveBtn) leaveBtn.addEventListener('click', async () => {
      if (!(await confirmBox('Leave this group chat?', 'Leave'))) return;
      try { await api.post('/api/groups/' + gid + '/leave', {}); } catch (e) { return notify(e.message); }
      closeChatTab('g' + gid);
    });
    const renameBtn = view.querySelector('#groupRenameBtn');
    if (renameBtn) renameBtn.addEventListener('click', async () => {
      const name = await promptBox('Rename group', 'Group name (leave empty to use members\' names):', group.name);
      if (name === null) return;
      try { await api.put('/api/groups/' + gid, { name: name.trim() }); } catch (e) { return notify(e.message); }
      openGroup(gid);
    });
    const deleteBtn = view.querySelector('#groupDeleteBtn');
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
      if (!(await confirmBox('Delete this group chat for everyone? All its messages will be removed.', 'Delete'))) return;
      try { await api.del('/api/groups/' + gid); } catch (e) { return notify(e.message); }
      closeChatTab('g' + gid);
      if (state.tab === 'chats') renderList();
    });

    const input = phoneComposer(view);
    const send = () => sendGroupMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    composerKeydown(input, send);
    input.addEventListener('input', () => updateComposerPreview(input.value));
    // Put the cursor in the composer right away so the user can type at once.
    setTimeout(() => input.focus(), 0);

    // Poll builder, quiz picker, gifts and files — same tools as a 1:1 chat.
    view.querySelector('#pollBtn').addEventListener('click', () => openPollBuilder({ groupId: gid }));
    view.querySelector('#quizBtn').addEventListener('click', () => openQuizPicker({ groupId: gid }));
    view.querySelector('#voiceBtn').addEventListener('click', () => startVoiceRecorder({ groupId: gid }));
    const fileInput = view.querySelector('#fileInput');
    view.querySelector('#attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) sendFile(fileInput.files[0]);
      fileInput.value = '';
    });
    wireGiftPicker(view);
    state.replyTo = null; // never carry a half-composed reply into another chat
    renderReplyBanner();

    // Shared files live only in this browser (IndexedDB); interleave them with
    // the stored messages by time so the history reads in order.
    let files = await idbLoadFiles('g' + gid);
    if (files == null) files = ((state.sharedFiles && state.sharedFiles['g' + gid]) || []).slice();
    if (!(state.group && state.group.gid === gid)) return; // switched away meanwhile
    const timeline = [];
    messages.forEach((m) => timeline.push({ at: m.at, seq: 0, render: () => appendGroupMessage(m) }));
    files.forEach((f) => timeline.push({ at: f.at, seq: 1, render: () => appendFileBubble(f, f.mine, f.url) }));
    timeline.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    timeline.forEach((it) => it.render());
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
    const replyTo = state.replyTo && !state.replyTo.file ? state.replyTo.id : null;
    input.value = '';
    clearComposerPreview();
    cancelReply();
    state.socket.emit('group:message', { groupId: gid, body, replyTo }, (res) => {
      if (res && res.error) { notify(res.error); input.value = body; updateComposerPreview(body); }
    });
  }

  // Render a group message bubble. Others' messages show the sender's name.
  function appendGroupMessage(m) {
    const b = chatBody();
    if (!b) return;
    if (m.kind === 'deleted') return appendDeletedBubble(m);
    if (m.kind === 'poll') return appendPollBubble(m);
    if (m.kind === 'quiz') return appendQuizBubble(m);
    if (m.kind === 'gift') return appendGiftBubble(m);
    if (m.kind === 'voice') return isVoiceBody(m.body) ? appendVoiceBubble(m) : undefined;
    const narration = narrationText(m.body);
    if (narration != null) {
      return appendNarrationLine(narration, m.at, { author: m.mine ? 'You' : m.fromName });
    }
    const side = m.mine ? 'me' : 'them';
    const bubble = el(`<div class="bubble ${side}"></div>`);
    if (m.id) bubble.dataset.id = m.id;
    if (!m.mine) bubble.appendChild(el(`<div class="bubble-author">${esc(m.fromName)}</div>`));
    if (m.reply) bubble.appendChild(renderQuote(m.reply));
    appendRichText(bubble, m.body);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    attachBubbleActions(bubble, m);
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
    cancelVoiceRecorder();
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
  // A "Show N more" button for a list whose rows past the first `keep` start
  // hidden; once expanded it flips to "Show less" and collapses them again.
  function showMoreToggle(list, keep, moreLabel) {
    const btn = el('<button class="ghost small alerts-more" type="button" aria-expanded="false"></button>');
    btn.textContent = moreLabel;
    let open = false;
    btn.addEventListener('click', () => {
      open = !open;
      list.querySelectorAll('.alert-item').forEach((r, i) => { if (i >= keep) r.classList.toggle('hidden', !open); });
      btn.textContent = open ? 'Show less' : moreLabel;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) list.closest('.alerts-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return btn;
  }

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
      panel.appendChild(showMoreToggle(list, SHOW, `Show ${items.length - SHOW} more`));
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
        sec.appendChild(showMoreToggle(jl, SHOW, `Show ${jobItems.length - SHOW} more jobs`));
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
    if (file.size > ACTIVITY_IMG_MAX_BYTES) {
      file = await fitImageToLimit(file, ACTIVITY_IMG_MAX_BYTES); // offer to compress
      if (!file) { onStatus(`Not shared — images must be ${fmtMB(ACTIVITY_IMG_MAX_BYTES)} or smaller.`, true); return false; }
    }
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
    if (ca.mine) parts.push(`<span class="act-me">${chatActivityIcon(ca.mine)} You're ${esc(ca.mine)} ${esc(peerName)}</span>`);
    if (ca.theirs) parts.push(`<span class="act-them">${chatActivityIcon(ca.theirs)} ${esc(peerName)}'s ${esc(ca.theirs)} you</span>`);
    status.innerHTML = parts.length
      ? parts.join('<span class="act-sep">·</span>')
      : '<span class="hint">Set what you’re doing:</span>' +
        (state.activities || []).map((a) =>
          `<button type="button" class="act-chip" data-activity="${esc(a)}" title="${esc(a)}">` +
          `<span aria-hidden="true">${chatActivityIcon(a)}</span>${esc(chatActivityLabel(a))}</button>`).join('');
  }

  // Icon + short label for each chat activity verb (src/activities.js).
  const CHAT_ACTIVITY_ICONS = {
    'chatting with': '💬', 'video calling': '📹', 'getting to know': '🤝', 'vibing with': '🎶', 'texting': '📱',
  };
  function chatActivityIcon(activity) { return CHAT_ACTIVITY_ICONS[activity] || '✨'; }
  function chatActivityLabel(activity) {
    return String(activity).replace(/\s+with$/, '');
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
      activities.map((a) => `<option value="${esc(a)}">${chatActivityIcon(a)} ${esc(a)}</option>`).join('');
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
    // One-tap chips shown while nothing is set.
    view.querySelector('#activityStatus').addEventListener('click', (e) => {
      const chip = e.target.closest('.act-chip');
      if (chip) send(chip.dataset.activity);
    });
  }

  async function openChat(peer) {
    state.peer = peer;
    state.group = null; // leaving any group view
    state.replyTo = null; // clear any half-composed reply from a previous chat
    cancelVoiceRecorder(); // a recording never follows you into another chat
    closeReactionPalette();
    state.chatPeers[peer.id] = { ...(state.chatPeers[peer.id] || {}), ...peer, unread: 0 };
    delete state.unread[peer.id];
    clearListUnread(String(peer.id));
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
          <img class="avatar sm" id="peerAvatar" src="${avatarUrl(peer.avatar)}" style="cursor:pointer" />
          <div class="chat-head-id">
            <div class="name" id="peerName" style="cursor:pointer">${esc(peer.displayName || peer.username)}</div>
            <div class="status">@${esc(peer.username)}</div>
          </div>
          <button class="ghost small" id="callBtn" title="Start a video call">📹 Call</button>
          <button class="ghost small" id="screenShareBtn" title="Share your screen, a window or a browser tab with this person">🖥️ Share screen</button>
          <button class="ghost small" id="makeGroupBtn" title="Start a group chat with this person and others">👥 Group</button>
          <button class="ghost small" id="clearChatBtn" title="Delete this whole chat (for you)">🗑 Delete chat</button>
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
        <div class="voice-recorder hidden" id="voiceRecorder"></div>
        <div class="composer-preview hidden" id="composerPreview"></div>
        <div class="composer">
          <input type="file" id="fileInput" class="hidden" />
          <button class="icon-btn" id="giftBtn" title="Send a gift">🎁</button>
          <button class="icon-btn" id="pollBtn" title="Create a poll">📊</button>
          <button class="icon-btn" id="quizBtn" title="Take a quiz together">🧩</button>
          <button class="icon-btn" id="voiceBtn" title="Record a voice note">🎤</button>
          <div class="composer-field">
            <button type="button" class="composer-more" title="Gift, poll or quiz" aria-label="More: gift, poll or quiz" aria-expanded="false">＋</button>
            <input type="text" id="msgInput" placeholder="Type a message…" autocomplete="off" dir="auto" />
            <button class="icon-btn" id="attachBtn" title="Share a file (delivered live, never stored)">📎</button>
          </div>
          <button class="primary" id="sendBtn" aria-label="Send"><span class="send-label">Send</span></button>
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

    const openPeerProfile = () => showProfile(peer.username);
    view.querySelector('#peerAvatar').addEventListener('click', openPeerProfile);
    view.querySelector('#peerName').addEventListener('click', openPeerProfile);
    view.querySelector('#makeGroupBtn').addEventListener('click', () => openGroupCreator(peer));
    view.querySelector('#clearChatBtn').addEventListener('click', () => clearConversation('dm', peer.id));
    view.querySelector('#screenShareBtn').addEventListener('click', () => toggleScreenShare(peer));
    view.querySelector('#callBtn').addEventListener('click', () =>
      startCall({ kind: 'dm', to: peer.id, name: peer.displayName || peer.username }));
    reflectScreenShare(peer.id);


    setupActivityBar(view, peer);

    const input = phoneComposer(view);
    const send = () => sendMessage(input);
    view.querySelector('#sendBtn').addEventListener('click', send);
    composerKeydown(input, send);
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


    wireGiftPicker(view);

    // Poll builder.
    view.querySelector('#pollBtn').addEventListener('click', () => openPollBuilder({ to: peer.id }));
    // Quiz picker — start a quiz to attempt together.
    view.querySelector('#quizBtn').addEventListener('click', () => openQuizPicker(peer.id));
    view.querySelector('#voiceBtn').addEventListener('click', () => startVoiceRecorder({ to: peer.id }));

    await loadChatHistory(view, peer);
  }

  // Gift button + picker inside a chat view (1:1 or group).
  function wireGiftPicker(view) {
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
  }

  // Load a 1:1 conversation's persisted history (text, gifts, …) plus the files
  // kept in this browser, in time order.
  async function loadChatHistory(view, peer) {
    // Load persisted history (text + gifts).
    adState.counters.chat = 0; // restart the every-20-messages ad cadence per chat
    try {
      const { messages, canChat, total } = await api.get(`/api/users/${peer.id}/messages`);
      if (state.peer && state.peer.id === peer.id) showLargeChatNotice(view, peer, total || 0);
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

  // Past LARGE_CHAT messages only the newest ones load, and long histories make
  // the chat slower, so suggest clearing it. "Not now" hides the notice for
  // this conversation for a week (kept in this browser only).
  const LARGE_CHAT = 500;
  const LARGE_CHAT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  function showLargeChatNotice(view, peer, total) {
    const old = view.querySelector('.chat-large-notice');
    if (old) old.remove();
    if (total < LARGE_CHAT) return;
    const key = `gx-large-chat-${state.me.id}-${peer.id}`;
    try {
      const snoozed = Number(localStorage.getItem(key) || 0);
      if (snoozed && Date.now() - snoozed < LARGE_CHAT_SNOOZE_MS) return;
    } catch (_e) {}
    const name = esc(peer.displayName || peer.username);
    const note = el(`
      <div class="chat-large-notice" role="status">
        <div class="cln-text">
          <strong>This conversation is getting long.</strong>
          You and ${name} have exchanged over ${LARGE_CHAT} messages. To keep your chat fast and responsive, we recommend clearing it —
          only the most recent ${LARGE_CHAT} messages are shown. Clearing removes the history for you only; ${name} keeps their copy.
        </div>
        <div class="cln-actions">
          <button type="button" class="primary small" data-clear>Clear chat</button>
          <button type="button" class="ghost small" data-later>Not now</button>
        </div>
      </div>
    `);
    note.querySelector('[data-clear]').addEventListener('click', async () => {
      if (await clearConversation('dm', peer.id)) note.remove();
    });
    note.querySelector('[data-later]').addEventListener('click', () => {
      try { localStorage.setItem(key, String(Date.now())); } catch (_e) {}
      note.remove();
    });
    const body = view.querySelector('#chatBody');
    if (body && body.parentNode) body.parentNode.insertBefore(note, body);
  }

  // Replace a conversation's composer (and its share / group / activity
  // controls) with a "friends only" notice and a way to their profile.
  function lockChatComposer(view, peer) {
    ['.composer', '#activityBar', '#callBtn', '#screenShareBtn', '#makeGroupBtn', '#giftPicker', '#voiceRecorder'].forEach((sel) => {
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
    syncAppBadge();
  }
  // Drop the unread count from a Chats-list row ('12' for a person, 'g3' for a group).
  function clearListUnread(id) {
    const row = document.querySelector(`#list .list-item[data-id="${id}"]`);
    if (!row) return;
    row.classList.remove('has-unread');
    const pill = row.querySelector('.list-unread');
    if (pill) pill.remove();
  }
  document.addEventListener('visibilitychange', markChatRead);
  window.addEventListener('focus', markChatRead);
  // Same for an open group chat (unread counts in the Chats list).
  function markGroupRead() {
    if (!state.socket || !state.group || document.visibilityState !== 'visible') return;
    state.socket.emit('group:read', { groupId: state.group.gid });
  }
  document.addEventListener('visibilitychange', markGroupRead);
  window.addEventListener('focus', markGroupRead);

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
      link.addEventListener('click', (e) => { e.preventDefault(); openLightbox(url); });
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
    // A preview card (featured image, title, site) for the first ordinary link.
    const plain = (str.match(new RegExp(URL_RE.source, 'gi')) || []).find((u) => !isMediaUrl(u));
    if (plain) attachLinkPreview(container, plain);
  }

  /* ---------- link previews ----------
     The server reads the page's featured image / title / description (Open
     Graph) and serves a small copy of the image itself, so members' browsers
     never contact the linked site. Results are cached here per page load. */
  const linkPreviewCache = new Map(); // url -> Promise<preview|null>
  function fetchLinkPreview(url) {
    if (!linkPreviewCache.has(url)) {
      linkPreviewCache.set(url, api.get('/api/link-preview?url=' + encodeURIComponent(url))
        .then((r) => r.preview || null)
        .catch(() => null));
    }
    return linkPreviewCache.get(url);
  }

  function attachLinkPreview(container, url) {
    const slot = el('<div class="link-card-slot"></div>');
    container.appendChild(slot);
    fetchLinkPreview(url).then((p) => {
      if (!p || (!p.title && !p.image) || !document.body.contains(slot)) { slot.remove(); return; }
      const nearBottom = isNearBottom(chatBody());
      const card = el(`
        <a class="link-card" target="_blank" rel="noopener noreferrer nofollow">
          ${p.image ? '<span class="link-card-img"><img alt="" loading="lazy" /></span>' : ''}
          <span class="link-card-text">
            <span class="link-card-site"></span>
            <span class="link-card-title"></span>
            <span class="link-card-desc"></span>
          </span>
        </a>`);
      card.href = url;
      if (p.image) {
        const img = card.querySelector('img');
        img.src = p.image;
        img.addEventListener('error', () => card.querySelector('.link-card-img').remove());
      }
      card.querySelector('.link-card-site').textContent = p.site || '';
      card.querySelector('.link-card-title').textContent = p.title || url;
      const d = card.querySelector('.link-card-desc');
      if (p.description) d.textContent = p.description; else d.remove();
      slot.replaceWith(card);
      if (nearBottom) scrollBody(); // keep a chat pinned to the newest message
    });
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
    if (meta.groupId != null && !mine && meta.fromName) bubble.appendChild(el(`<div class="bubble-author">${esc(meta.fromName)}</div>`));
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
    if (meta.groupId == null) attachFileActions(bubble, meta, mine); // reply / delete-for-both are 1:1 only
    mountBubble(bubble, { mine: mine, from: meta.from, groupId: meta.groupId });
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
      const file = await fitImageToLimit(new File([blob], meta.name || 'image', { type: blob.type || meta.mime }));
      if (!file) { btn.disabled = false; btn.textContent = original; return; }
      const fd = new FormData();
      fd.append('image', file, file.name);
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
    if (m.kind === 'deleted') return appendDeletedBubble(m);
    if (m.kind === 'gift') appendGiftBubble(m);
    else if (m.kind === 'poll') appendPollBubble(m);
    else if (m.kind === 'quiz') appendQuizBubble(m);
    else if (m.kind === 'hwevent') appendHighwayEventBubble(m);
    else if (m.kind === 'call') return appendCallBubble(m);
    else if (m.kind === 'voice') { if (isVoiceBody(m.body)) appendVoiceBubble(m); else return; } // old-style notes are skipped
    else appendTextBubble(m);
    // Advertisement after every 20 exchanged messages (text + gifts).
    if (m.kind !== 'voice' && m.kind !== 'poll' && m.kind !== 'quiz' && m.kind !== 'hwevent') {
      maybeInsertStreamAd(chatBody(), 'chat_inline', 'chat', 20);
    }
  }

  // A 1:1 video call nobody answered: a centered line in the conversation, with
  // "Call back" for the person who missed it.
  function appendCallBubble(m) {
    const b = chatBody();
    if (!b) return;
    let p = {};
    try { p = typeof m.body === 'string' ? JSON.parse(m.body) : (m.body || {}); } catch (_e) { p = {}; }
    const declined = p.status === 'declined';
    const line = m.mine
      ? (declined ? `${esc(peerLabel())} declined your video call` : `${esc(peerLabel())} missed your video call`)
      : (declined ? 'You declined a video call' : 'Missed video call');
    const card = el(`
      <div class="call-log${!m.mine && !declined ? ' missed' : ''}">
        <span class="call-log-icon">📹</span>
        <span class="call-log-line">${line}</span>
        <span class="time">${fmtTime(m.at)}</span>
      </div>`);
    if (state.peer) {
      const again = el(`<button type="button" class="ghost small call-log-btn">${m.mine ? 'Call again' : 'Call back'}</button>`);
      again.addEventListener('click', () => startCall({ kind: 'dm', to: state.peer.id, name: peerLabel() }));
      card.appendChild(again);
    }
    b.appendChild(card);
    scrollBody();
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
        <span class="gift-name">${m.groupId != null
          ? `${m.mine ? 'You' : esc(m.fromName || 'Someone')} sent the group “${esc(gift.name)}”`
          : `${m.mine ? 'You sent' : 'Sent you'} a ${esc(gift.name)}`}</span>
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
  // `target` is a 1:1 peer id, or { groupId } for a group chat.
  async function openQuizPicker(target) {
    const where = typeof target === 'object' ? target : { to: target };
    const { card, close } = openModal('Take a quiz together', `
      <div class="quiz-picker"><div class="hint">Loading quizzes…</div></div>
    `);
    const box = card.querySelector('.quiz-picker');
    let quizzes = [];
    try { quizzes = ((await api.get('/api/content/quizzes')).quizzes || []).filter((q) => q.type === 'compatibility'); }
    catch (_e) { box.innerHTML = '<div class="hint">Could not load quizzes.</div>'; return; }
    if (!quizzes.length) { box.innerHTML = '<div class="hint">No compatibility quizzes are available yet.</div>'; return; }
    box.innerHTML = where.groupId
      ? '<div class="pb-label">Pick a quiz — everyone in the group answers it, then sees how much they match each other.</div>'
      : '<div class="pb-label">Pick a quiz — you’ll both answer it, then see how much you match.</div>';
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
        state.socket.emit('quiz:start', { ...where, quizId: q.id }, (res) => {
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

    if (q.group && q.iSubmitted) {
      // ----- group: my match with each member who has finished -----
      const waiting = q.people.filter((p) => !p.submitted).map((p) => p.name);
      if (q.results && q.results.length) {
        q.results.forEach((r) => {
          const row = el(`<div class="quiz-group-row"><span class="qg-name"></span><span class="qg-pct">${r.percent}%</span><span class="qg-sub">${r.matches}/${r.total} matched</span></div>`);
          row.querySelector('.qg-name').textContent = 'You & ' + r.name;
          body.appendChild(row);
        });
      } else {
        body.appendChild(el('<div class="quiz-wait">✓ You’re done — your matches appear as others finish.</div>'));
      }
      if (waiting.length) {
        const w = el('<div class="quiz-sub"></div>');
        w.textContent = 'Still answering: ' + waiting.join(', ');
        body.appendChild(w);
      }
      return;
    }

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
    body.appendChild(el(q.group
      ? '<div class="quiz-sub">Answer together — pick your response to each. Once you submit, you’ll see how much you match everyone else who has finished.</div>'
      : '<div class="quiz-sub">Answer together — pick your response to each. You’ll both see how much you have in common once you’re both done.</div>'));
    // Questions and options in a random order, picked once per card so a
    // re-render mid-answer doesn't reshuffle. Answers keep original indexes.
    const shuffle = (a) => {
      for (let k = a.length - 1; k > 0; k -= 1) {
        const j = Math.floor(Math.random() * (k + 1));
        [a[k], a[j]] = [a[j], a[k]];
      }
      return a;
    };
    if (!card._order || card._order.length !== q.questions.length) {
      card._order = shuffle(q.questions.map((_x, k) => k));
      card._optOrder = q.questions.map((qq) => shuffle(qq.options.map((_x, k) => k)));
    }
    card._order.forEach((i, pos) => {
      const qq = q.questions[i];
      const block = el('<div class="quiz-q"></div>');
      block.appendChild(el('<div class="quiz-q-prompt"></div>')).textContent = (pos + 1) + '. ' + qq.prompt;
      const opts = el('<div class="quiz-q-opts"></div>');
      const optOrder = card._optOrder[i] && card._optOrder[i].length === qq.options.length ? card._optOrder[i] : qq.options.map((_x, k) => k);
      optOrder.forEach((oi) => {
        const btn = el(`<button class="quiz-opt${card._draft[i] === oi ? ' sel' : ''}" type="button"></button>`);
        btn.textContent = qq.options[oi];
        btn.dataset.oi = oi;
        btn.addEventListener('click', () => {
          card._draft[i] = oi;
          opts.querySelectorAll('.quiz-opt').forEach((b) => b.classList.toggle('sel', Number(b.dataset.oi) === oi));
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

  /* ---------- voice notes (1:1 and group) ----------
     Recorded with the browser's own MediaRecorder (Opus/WebM on Chrome, Firefox
     and Android; AAC/MP4 on Safari and iPhone) with echo cancellation and noise
     suppression, then uploaded. The server converts every note to AAC .m4a —
     the one format every browser plays — and evens out the volume, so a note
     recorded anywhere plays everywhere. Playback streams from /api/voice/:id,
     which only the people in that conversation can open. */
  const VOICE_MAX_SECONDS = 300;
  let voiceRec = null; // the recording in progress

  function isVoiceBody(body) {
    return typeof body === 'string' && body.charAt(0) === '{' && body.indexOf('voiceId') > -1;
  }
  function voiceInfo(body) {
    try { return JSON.parse(body) || {}; } catch (_e) { return {}; }
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function voiceLabel(body) {
    const d = voiceInfo(body).dur;
    return d ? `🎤 Voice note (${fmtClock(d)})` : '🎤 Voice note';
  }

  function pickRecorderType() {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  // target: { to } for a 1:1 chat or { groupId } for a group chat.
  async function startVoiceRecorder(target) {
    if (voiceRec) return;
    const bar = document.getElementById('voiceRecorder');
    if (!bar) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      return alert('Voice notes aren’t supported in this browser. Try Chrome, Edge, Firefox or Safari.');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (_e) {
      return alert('Allow microphone access to record a voice note.');
    }
    const type = pickRecorderType();
    let recorder;
    try { recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined); }
    catch (_e) { recorder = new MediaRecorder(stream); }

    const rec = { target, stream, recorder, chunks: [], started: Date.now(), cancelled: false, replyTo: state.replyTo && !state.replyTo.file ? state.replyTo.id : null };
    recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); });
    try { recorder.start(250); }
    catch (_e) {
      stream.getTracks().forEach((t) => t.stop());
      return alert('Couldn’t start recording. Check that no other app is using the microphone and try again.');
    }
    voiceRec = rec;

    // Recording bar: pulsing dot, timer, live level meter, cancel and send.
    bar.innerHTML = `
      <button type="button" class="vr-btn vr-cancel" title="Discard">🗑</button>
      <span class="vr-dot"></span>
      <span class="vr-time">0:00</span>
      <canvas class="vr-level" width="240" height="32"></canvas>
      <span class="vr-hint">Recording… tap ➤ to send</span>
      <button type="button" class="vr-btn vr-send" title="Send voice note">➤</button>`;
    bar.classList.remove('hidden');
    const composer = bar.parentNode.querySelector('.composer');
    if (composer) composer.classList.add('hidden');
    bar.querySelector('.vr-cancel').addEventListener('click', () => stopVoiceRecorder(false));
    bar.querySelector('.vr-send').addEventListener('click', () => stopVoiceRecorder(true));

    // Level meter (display only — the recording itself comes from MediaRecorder).
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      rec.audioCtx = new AC();
      const src = rec.audioCtx.createMediaStreamSource(stream);
      const an = rec.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const canvas = bar.querySelector('.vr-level');
      const g = canvas.getContext('2d');
      const levels = [];
      const draw = () => {
        if (voiceRec !== rec) return;
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        levels.push(Math.min(1, peak / 70));
        if (levels.length > 60) levels.shift();
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = getComputedStyle(bar).getPropertyValue('--vr-wave') || '#1f4e8c';
        levels.forEach((l, i) => {
          const h = Math.max(2, l * canvas.height);
          g.fillRect(i * 4, (canvas.height - h) / 2, 2.5, h);
        });
        rec.raf = requestAnimationFrame(draw);
      };
      draw();
    } catch (_e) { /* no meter, recording still works */ }

    rec.timer = setInterval(() => {
      const secs = (Date.now() - rec.started) / 1000;
      const t = bar.querySelector('.vr-time');
      if (t) t.textContent = fmtClock(secs);
      if (secs >= VOICE_MAX_SECONDS) stopVoiceRecorder(true); // 5-minute cap: send what we have
    }, 250);
  }

  function closeVoiceBar() {
    const bar = document.getElementById('voiceRecorder');
    if (!bar) return;
    bar.classList.add('hidden');
    bar.innerHTML = '';
    const composer = bar.parentNode && bar.parentNode.querySelector('.composer');
    if (composer) composer.classList.remove('hidden');
  }

  // Stop recording; `send` uploads it, otherwise it's thrown away.
  function stopVoiceRecorder(send) {
    const rec = voiceRec;
    if (!rec) return;
    voiceRec = null;
    clearInterval(rec.timer);
    if (rec.raf) cancelAnimationFrame(rec.raf);
    try { if (rec.audioCtx) rec.audioCtx.close(); } catch (_e) {}
    const secs = (Date.now() - rec.started) / 1000;
    rec.recorder.addEventListener('stop', async () => {
      rec.stream.getTracks().forEach((t) => t.stop());
      if (!send) return closeVoiceBar();
      if (secs < 0.7) { closeVoiceBar(); return notifyToast('Hold on a little longer to record a voice note.'); }
      const bar = document.getElementById('voiceRecorder');
      if (bar) bar.innerHTML = '<span class="vr-dot sending"></span><span class="vr-hint">Sending voice note…</span>';
      const mime = rec.recorder.mimeType || (rec.chunks[0] && rec.chunks[0].type) || 'audio/webm';
      const ext = /mp4|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('audio', new Blob(rec.chunks, { type: mime.split(';')[0] }), 'voice.' + ext);
      if (rec.target.to) fd.append('to', String(rec.target.to));
      if (rec.target.groupId) fd.append('groupId', String(rec.target.groupId));
      if (rec.replyTo) fd.append('replyTo', String(rec.replyTo));
      try {
        await api.postForm('/api/voice', fd);
        if (rec.replyTo) cancelReply();
        // The note arrives on every tab (this one too) as a chat message.
      } catch (e) {
        notify(e.message || 'Could not send the voice note.');
      }
      closeVoiceBar();
    }, { once: true });
    try { rec.recorder.stop(); } catch (_e) { rec.stream.getTracks().forEach((t) => t.stop()); closeVoiceBar(); }
  }

  // Leaving a chat while recording throws the recording away.
  function cancelVoiceRecorder() { stopVoiceRecorder(false); }

  // A voice-note bubble: play/pause, a seekable progress bar, time, and speed.
  function appendVoiceBubble(m) {
    const b = chatBody();
    if (!b) return;
    const info = voiceInfo(m.body);
    const bubble = el(`<div class="bubble voice ${m.mine ? 'me' : 'them'}"></div>`);
    if (m.id) bubble.dataset.id = m.id;
    if (m.groupId != null && !m.mine && m.fromName) bubble.appendChild(el(`<div class="bubble-author">${esc(m.fromName)}</div>`));
    if (m.reply) bubble.appendChild(renderQuote(m.reply));
    const player = el(`
      <div class="voice-note">
        <button type="button" class="vn-play" title="Play">▶</button>
        <div class="vn-track" title="Seek"><div class="vn-fill"></div><div class="vn-knob"></div></div>
        <span class="vn-time">${fmtClock(info.dur)}</span>
        <button type="button" class="vn-speed" title="Playback speed">1×</button>
      </div>`);
    bubble.appendChild(player);
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    attachBubbleActions(bubble, m);
    mountBubble(bubble, m);
    wireVoicePlayer(player, info);
    scrollBody();
    return bubble;
  }

  const VOICE_SPEEDS = [1, 1.5, 2];
  function wireVoicePlayer(player, info) {
    const audio = new Audio();
    audio.preload = 'none'; // nothing downloads until someone presses play
    audio.src = '/api/voice/' + encodeURIComponent(info.voiceId);
    const playBtn = player.querySelector('.vn-play');
    const track = player.querySelector('.vn-track');
    const fill = player.querySelector('.vn-fill');
    const knob = player.querySelector('.vn-knob');
    const time = player.querySelector('.vn-time');
    const speedBtn = player.querySelector('.vn-speed');
    let speed = 0;
    const total = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : info.dur || 0);
    const paint = () => {
      const frac = total() ? Math.min(1, audio.currentTime / total()) : 0;
      fill.style.width = (frac * 100) + '%';
      knob.style.left = (frac * 100) + '%';
      time.textContent = audio.currentTime > 0 && !audio.ended ? fmtClock(audio.currentTime) : fmtClock(total());
    };
    let raf = null;
    const loop = () => { paint(); if (!audio.paused) raf = requestAnimationFrame(loop); };
    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        // Only one voice note plays at a time.
        document.querySelectorAll('.voice-note.playing').forEach((o) => { if (o !== player && o._audio) o._audio.pause(); });
        player.classList.add('loading');
        audio.play().catch(() => { player.classList.remove('loading'); notifyToast('Couldn’t play this voice note.'); });
      } else audio.pause();
    });
    audio.addEventListener('playing', () => { player.classList.remove('loading'); player.classList.add('playing'); playBtn.textContent = '❚❚'; playBtn.title = 'Pause'; loop(); });
    audio.addEventListener('pause', () => { player.classList.remove('playing'); playBtn.textContent = '▶'; playBtn.title = 'Play'; if (raf) cancelAnimationFrame(raf); paint(); });
    audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('error', () => { player.classList.remove('loading', 'playing'); });
    // Click or drag on the bar to jump to that point.
    const seek = (clientX) => {
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const go = () => { audio.currentTime = frac * total(); paint(); };
      if (audio.readyState >= 1) go();
      else { audio.preload = 'metadata'; audio.addEventListener('loadedmetadata', go, { once: true }); audio.load(); }
    };
    track.addEventListener('pointerdown', (e) => {
      seek(e.clientX);
      const move = (ev) => seek(ev.clientX);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    speedBtn.addEventListener('click', () => {
      speed = (speed + 1) % VOICE_SPEEDS.length;
      audio.playbackRate = VOICE_SPEEDS[speed];
      speedBtn.textContent = VOICE_SPEEDS[speed] + '×';
    });
    player._audio = audio;
  }

  /* ---------- reply / quote ---------- */

  function peerLabel() {
    return (state.peer && (state.peer.displayName || state.peer.username)) || 'Them';
  }

  // A short text snapshot of a message, for quoting.
  function previewTextOf(m) {
    if (m.kind === 'voice') return voiceLabel(m.body);
    if (m.kind === 'call') return '📹 Video call';
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
    q.querySelector('.rq-who').textContent = mine ? 'You' : (reply.fromName || peerLabel());
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
    actions.appendChild(reply);
    const more = el('<button class="act-btn" title="More: delete / unsend">⋯</button>');
    more.addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(more, m, bubble); });
    actions.appendChild(more);
    bubble.appendChild(actions);
    if (m.groupId != null) return; // group messages: no emoji reactions
    const react = el('<button class="act-btn" title="React">🙂</button>');
    react.addEventListener('click', (e) => { e.stopPropagation(); openReactionPalette(react, m.id); });
    actions.appendChild(react);

    bubble._reactions = Array.isArray(m.reactions) ? m.reactions.slice() : [];
    const rc = el('<div class="reactions hidden"></div>');
    bubble.appendChild(rc);
    bubble._reactionsEl = rc;
    renderReactions(bubble);
  }

  /* ---------- deleting messages ----------
     "Delete for me" hides one message for you; "Unsend" (your own messages)
     removes it for everyone, leaving "This message was deleted". */
  function appendDeletedBubble(m) {
    const b = chatBody();
    if (!b) return;
    const bubble = el(`<div class="bubble deleted ${m.mine ? 'me' : 'them'}"></div>`);
    if (m.id) bubble.dataset.id = m.id;
    if (m.groupId != null && !m.mine && m.fromName) bubble.appendChild(el(`<div class="bubble-author">${esc(m.fromName)}</div>`));
    bubble.appendChild(el(`<span class="deleted-text">🚫 ${m.mine ? 'You deleted this message' : 'This message was deleted'}</span>`));
    bubble.appendChild(el(`<span class="time">${fmtTime(m.at)}</span>`));
    // Even a deleted message can be removed from your own view.
    const actions = el('<div class="bubble-actions"></div>');
    const more = el('<button class="act-btn" title="Delete for me">⋯</button>');
    more.addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(more, { ...m, kind: 'deleted' }, bubble); });
    actions.appendChild(more);
    bubble.appendChild(actions);
    mountBubble(bubble, { ...m, status: undefined, id: null }); // no read ticks on a deleted message
    scrollBody();
  }

  // Turn an existing bubble into the "deleted" placeholder (after an unsend).
  function markBubbleDeleted(id, groupId) {
    const b = chatBody();
    const bubble = b && b.querySelector(`.bubble[data-id="${Number(id)}"], .poll-card[data-message-id="${Number(id)}"]`);
    if (!bubble) return;
    const row = bubble.closest('.msg-row') || bubble;
    const mine = bubble.classList.contains('me');
    const author = bubble.querySelector('.bubble-author');
    const at = bubble.querySelector('.time');
    const audio = bubble.querySelector('.voice-note');
    if (audio && audio._audio) audio._audio.pause();
    const replacement = el(`<div class="bubble deleted ${mine ? 'me' : 'them'}" data-id="${Number(id)}"></div>`);
    if (author) replacement.appendChild(author);
    replacement.appendChild(el(`<span class="deleted-text">🚫 ${mine ? 'You deleted this message' : 'This message was deleted'}</span>`));
    if (at) { const t = at.cloneNode(true); const tk = t.querySelector('.ticks'); if (tk) tk.remove(); replacement.appendChild(t); }
    const actions = el('<div class="bubble-actions"></div>');
    const more = el('<button class="act-btn" title="Delete for me">⋯</button>');
    const m = { id: Number(id), mine, kind: 'deleted', groupId };
    more.addEventListener('click', (e) => { e.stopPropagation(); openMessageMenu(more, m, replacement); });
    actions.appendChild(more);
    replacement.appendChild(actions);
    bubble.replaceWith(replacement);
    void row;
  }

  function openMessageMenu(anchor, m, bubble) {
    closeReactionPalette();
    const menu = el('<div class="msg-menu"></div>');
    const item = (label, fn, danger) => {
      const b = el(`<button type="button" class="${danger ? 'danger' : ''}">${label}</button>`);
      b.addEventListener('click', (e) => { e.stopPropagation(); closeReactionPalette(); fn(); });
      menu.appendChild(b);
    };
    const inGroup = m.groupId != null;
    const base = inGroup ? `/api/groups/${m.groupId}/messages/${m.id}` : `/api/users/messages/${m.id}`;
    item('🗑 Delete for me', async () => {
      try { await api.post(base + '/hide', {}); (bubble.closest('.msg-row') || bubble).remove(); }
      catch (e) { alert(e.message); }
    });
    if (m.mine && m.kind !== 'deleted') {
      item('↩️ Unsend for everyone', async () => {
        if (!(await confirmBox('Unsend this message? It will be removed for everyone in this chat.', 'Unsend'))) return;
        try { await api.post(base + '/unsend', {}); markBubbleDeleted(m.id, m.groupId); }
        catch (e) { alert(e.message); }
      }, true);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)) + 'px';
    menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left - 80)) + 'px';
    state._reactPalette = menu; // shares the palette's close-on-outside-click handling
    setTimeout(() => document.addEventListener('click', closeReactionPaletteOnce), 0);
  }

  // "Delete chat": remove the whole conversation from your view.
  async function clearConversation(kind, id) {
    const msg = kind === 'group'
      ? 'Delete this group chat for you? All its messages will be removed from your view. Other members keep theirs.'
      : 'Delete this whole chat? All messages will be removed for you. The other person keeps their copy.';
    if (!(await confirmBox(msg, 'Delete chat'))) return false;
    try {
      await api.del(kind === 'group' ? `/api/groups/${id}/messages` : `/api/users/${id}/messages`);
      await idbClearPeer(kind === 'group' ? 'g' + id : id);
      const b = chatBody();
      if (b) b.innerHTML = '<div class="hint chat-cleared">Chat deleted. New messages will appear here.</div>';
      notifyToast('Chat deleted.');
      if (kind !== 'group') delete state.chatPeers[id];
      if (state.tab === 'chats') renderList();
      return true;
    } catch (e) { alert(e.message); return false; }
  }

  // Delete every one-to-one and group chat, for this member only.
  async function clearAllConversations() {
    const msg = 'Delete all your chats? Every conversation, including group chats, will be removed for you. ' +
      'The other people keep their copies, and new messages will still reach you.';
    if (!(await confirmBox(msg, 'Delete all chats'))) return;
    try {
      await api.del('/api/social/chats');
      await idbClearAll();
      state.chatPeers = {};
      const b = chatBody();
      if (b && (state.peer || state.group)) b.innerHTML = '<div class="hint chat-cleared">Chat deleted. New messages will appear here.</div>';
      notifyToast('All chats deleted.');
      renderList();
    } catch (e) { alert(e.message); }
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

  /* ---------- Phone composer (WhatsApp-style) ----------
     On a phone the message box becomes a rounded field that grows with the
     text (Enter adds a line; the round button sends), the round button is a
     mic while the box is empty and a send arrow once you type, and the gift /
     poll / quiz tools sit behind the ＋ button. Larger screens keep the
     single-line box and the row of tools exactly as before (see style.css). */
  const PHONE_MQ = '(max-width: 600px), (pointer: coarse) and (max-height: 500px)';
  function isPhone() { return !!(window.matchMedia && window.matchMedia(PHONE_MQ).matches); }

  // Larger screens: swap the one-line <input> for a <textarea> that starts one
  // line tall and grows with Alt+Enter line breaks (up to ~6 lines, then scrolls).
  function desktopComposer(input) {
    const ta = document.createElement('textarea');
    ta.id = 'msgInput';
    ta.rows = 1;
    ta.placeholder = input.placeholder;
    ta.autocomplete = 'off';
    ta.dir = 'auto';
    ta.title = 'Enter to send · Alt+Enter for a new line';
    input.replaceWith(ta);
    const sync = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 150) + 'px';
    };
    // Sending clears the box in code (no input event), so watch value writes too.
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); sync(); },
    });
    ta.addEventListener('input', sync);
    return ta;
  }

  // Message box keys: Enter sends; Alt+Enter / Shift+Enter add a new line.
  // (On phones the box is multiline and Enter always adds a line.)
  function composerKeydown(input, send) {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || input._multiline) return;
      e.preventDefault();
      if (e.altKey || e.shiftKey) {
        if (input.tagName !== 'TEXTAREA') return;
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      send();
    });
    composerPaste(input);
  }

  // Pasting into the message box: text goes in as usual; a copied image (or a
  // file copied in the file manager) is shown in a small preview and shared
  // like a 📎 attachment once confirmed. Images pasted alongside text (e.g.
  // from a document) are offered too, and the text is still pasted.
  function composerPaste(input) {
    input.addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      if (!e.clipboardData.getData('text/plain')) e.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const named = files.map((f, i) => (f.name && f.name !== 'image.png') ? f
        : new File([f], `pasted-${stamp}${files.length > 1 ? '-' + (i + 1) : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }));
      confirmPastedFiles(named, input);
    });
  }

  function confirmPastedFiles(files, input) {
    const urls = files.map((f) => (/^image\//.test(f.type) ? URL.createObjectURL(f) : ''));
    const n = files.length;
    const { card, close } = openModal(n === 1 ? (urls[0] ? 'Send this image?' : 'Send this file?') : `Send these ${n} files?`, `
      <div class="paste-preview">
        ${files.map((f, i) => urls[i]
          ? `<img src="${urls[i]}" alt="${esc(f.name)}" />`
          : `<div class="paste-file">📄 ${esc(f.name)}</div>`).join('')}
      </div>
      <div class="row-actions" style="justify-content:flex-end">
        <button type="button" class="ghost" data-cancel>Cancel</button>
        <button type="button" class="primary" data-send>Send</button>
      </div>`);
    const done = () => { urls.forEach((u) => u && URL.revokeObjectURL(u)); close(); input.focus(); };
    const sendBtn = card.querySelector('[data-send]');
    card.querySelector('[data-cancel]').addEventListener('click', done);
    card.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true;
      for (const f of files) await sendFile(f);
      done();
    });
    sendBtn.focus(); // Enter sends, Esc / ✕ / outside click cancels
  }

  // Returns the message box for `view`: a growing <textarea> everywhere. On
  // phones Enter adds a line; on larger screens Enter sends and Alt+Enter (or
  // Shift+Enter) adds a line (see composerKeydown).
  function phoneComposer(view) {
    let input = view.querySelector('#msgInput');
    const composer = view.querySelector('.composer');
    if (!composer) return input;
    if (!isPhone()) return desktopComposer(input);
    composer.classList.add('phone');

    const ta = document.createElement('textarea');
    ta.id = 'msgInput';
    ta.rows = 1;
    ta.placeholder = input.placeholder;
    ta.autocomplete = 'off';
    ta.dir = 'auto';
    ta.setAttribute('enterkeyhint', 'enter');
    input.replaceWith(ta);
    input = ta;
    input._multiline = true;

    const sync = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 132) + 'px'; // up to ~6 lines, then scroll
      composer.classList.toggle('has-text', !!ta.value.trim());
    };
    // Sending clears the box in code (no input event), so watch value writes too.
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); sync(); },
    });
    ta.addEventListener('input', sync);
    sync();

    // ＋ opens a small tray with the gift / poll / quiz tools.
    const more = composer.querySelector('.composer-more');
    const setOpen = (open) => {
      composer.classList.toggle('tools-open', open);
      more.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    more.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!composer.classList.contains('tools-open')); });
    composer.querySelectorAll('#giftBtn, #pollBtn, #quizBtn').forEach((b) => b.addEventListener('click', () => setOpen(false)));
    if (!phoneComposer.bound) {
      // One listener for every chat: a tap outside the composer closes the tray.
      phoneComposer.bound = true;
      document.addEventListener('click', (e) => {
        if (e.target.closest('.composer')) return;
        document.querySelectorAll('.composer.tools-open').forEach((c) => {
          c.classList.remove('tools-open');
          const m = c.querySelector('.composer-more');
          if (m) m.setAttribute('aria-expanded', 'false');
        });
      });
    }
    return input;
  }

  function startReply(m) {
    state.replyTo = { id: m.id, mine: m.mine, fromName: m.fromName, text: previewTextOf(m) };
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
    body.querySelector('.rb-who').textContent = 'Replying to ' + (state.replyTo.mine ? 'yourself' : (state.replyTo.fromName || peerLabel()));
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
    if (state.group && state.socket) {
      // The server delivers it to every member (us included) as a group message.
      return state.socket.emit('group:gift', { groupId: state.group.gid, gift: giftId }, (res) => {
        if (res && res.error) notify(res.error);
      });
    }
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
    if (state.group && state.socket) return sendGroupFile(file);
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

  // Share a file with the group: relayed live to members who are online.
  async function sendGroupFile(file) {
    const gid = state.group.gid;
    const buf = await file.arrayBuffer();
    const fid = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const mime = file.type || 'application/octet-stream';
    state.socket.emit('group:file', { groupId: gid, id: fid, name: file.name, mime, data: buf }, (res) => {
      if (res && res.error) return notify(res.error);
      const blob = new Blob([buf], { type: mime });
      const url = URL.createObjectURL(blob);
      const entry = { id: fid, groupId: gid, from: state.me.id, mine: true, name: file.name, mime, size: file.size, at: Date.now(), url };
      cacheSharedFile('g' + gid, entry);
      idbSaveFile('g' + gid, entry, blob);
      if (state.group && state.group.gid === gid) appendFileBubble(entry, true, url);
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
          groupId: entry.groupId, fromName: entry.fromName,
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
  // Forget every file kept for one conversation (after "Delete chat").
  async function idbClearPeer(peerId) {
    const rows = await idbLoadFiles(peerId);
    (rows || []).forEach((r) => { idbDeleteFile(peerId, r.id); try { URL.revokeObjectURL(r.url); } catch (_e) {} });
    if (state.sharedFiles) delete state.sharedFiles[peerId];
  }

  // Every file kept in this browser, for every chat.
  async function idbClearAll() {
    Object.values(state.sharedFiles || {}).forEach((arr) => (arr || []).forEach((r) => { try { URL.revokeObjectURL(r.url); } catch (_e) {} }));
    state.sharedFiles = {};
    try {
      const db = await idb();
      await new Promise((res, rej) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
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
        groupId: r.groupId, fromName: r.fromName,
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

  /* ---------- screen sharing ----------
     One-directional WebRTC: the sharer picks a browser tab, an app window or
     the whole screen in the browser's own picker and streams it peer-to-peer
     to the chat partner. The server only relays the offer/answer/ICE (see
     socket.js). */
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
        <div class="screen-stage"><video id="screenVideo" autoplay playsinline></video></div>
        <div class="screen-resize" title="Drag to resize"></div>
      </div>`);
    document.body.appendChild(panel);
    makeDraggable(panel, { onMove: (x, y) => { state.screenPanelPos = { x, y }; } });
    makeScreenPanelResizable(panel);
    panel.querySelector('#screenCloseBtn').addEventListener('click', () => stopScreenShare());
    panel.querySelector('#screenFsBtn').addEventListener('click', () => {
      const v = panel.querySelector('#screenVideo');
      if (v && v.requestFullscreen) v.requestFullscreen().catch(() => {});
    });
    return panel;
  }

  /* The screen-share window keeps a steady 16:9 frame: the shared tab is fitted
     inside it (dark bars when its shape differs), so the window never jumps
     around as the stream's resolution or the sharer's tab size changes. It's
     resized only from the corner grip, which keeps the 16:9 shape and stays on
     screen. */
  const SCREEN_PANEL_MIN = 280;
  function clampScreenPanelWidth(w) {
    if (!window.innerWidth || !window.innerHeight) return Math.max(SCREEN_PANEL_MIN, w);
    const head = 40; // title bar height
    const maxByHeight = (window.innerHeight * 0.88 - head) * 16 / 9;
    const max = Math.max(SCREEN_PANEL_MIN, Math.min(window.innerWidth - 16, maxByHeight));
    return Math.round(Math.min(max, Math.max(SCREEN_PANEL_MIN, w)));
  }

  function makeScreenPanelResizable(panel) {
    const grip = panel.querySelector('.screen-resize');
    let rs = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Anchor the top-left corner so the window grows towards the grip.
      const r = panel.getBoundingClientRect();
      placeFloating(panel, r.left, r.top);
      rs = { id: e.pointerId, x: e.clientX, w: r.width, left: r.left };
      try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
      panel.classList.add('resizing');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      const room = window.innerWidth - rs.left - 8; // don't grow past the right edge
      const w = Math.min(room, clampScreenPanelWidth(rs.w + (e.clientX - rs.x)));
      panel.style.width = Math.max(SCREEN_PANEL_MIN, w) + 'px';
      state.screenPanelWidth = panel.offsetWidth;
      const r = panel.getBoundingClientRect();
      const pos = placeFloating(panel, r.left, r.top); // keep the bottom on screen too
      state.screenPanelPos = pos;
    });
    const end = (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      rs = null;
      panel.classList.remove('resizing');
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  function showScreenPanel(title) {
    const panel = screenPanel();
    // Re-open at the size and place it was last given (kept on screen).
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      if (state.screenPanelWidth) panel.style.width = clampScreenPanelWidth(state.screenPanelWidth) + 'px';
      if (state.screenPanelPos) placeFloating(panel, state.screenPanelPos.x, state.screenPanelPos.y);
    }
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

  // Screen-share picker: a browser tab, an app window or the entire screen.
  const DISPLAY_MEDIA_OPTS = {
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
    selfBrowserSurface: 'exclude', // don't offer the getxmatch tab itself (mirror effect)
    surfaceSwitching: 'include',
  };
  function surfaceName(track) {
    const s = track && track.getSettings ? track.getSettings().displaySurface : '';
    return s === 'monitor' ? 'screen' : s === 'window' ? 'window' : s === 'browser' ? 'tab' : 'screen';
  }

  async function startScreenShare(peer) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return notifyToast('Screen sharing is not supported in this browser.');
    }
    let stream;
    try {
      // Any browser tab, an app window or the whole screen — the browser's own
      // picker lets the person choose.
      stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTS);
    } catch (e) {
      return; // user cancelled the picker or denied permission
    }
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch (_e) {} // keep text sharp

    const pc = newScreenPc(peer.id);
    state.screen = { pc, stream, role: 'sharer', peerId: peer.id };
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    // Ending the share from the browser's own "Stop sharing" bar tears down too.
    track.addEventListener('ended', () => stopScreenShare());

    const panel = showScreenPanel(`You are sharing your ${surfaceName(track)} with ` + (peer.displayName || peer.username));
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
      const panel = showScreenPanel(name + ' is sharing their screen');
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
    const payload = target.kind === 'room' ? { room: target.room }
      : target.kind === 'dm' ? { kind: 'dm', to: target.to } : { kind: 'group', groupId: target.groupId };
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
    share.title = call.screen ? 'Stop sharing your screen' : 'Show your screen, a window or a tab to everyone in the call';
  }

  // Header icons (plain line icons read better than emoji at small sizes).
  const svgIcon = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON_MINIMIZE = svgIcon('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>');
  const ICON_EXPAND = svgIcon('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>');
  const ICON_FULLSCREEN = svgIcon('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>');

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
          <button class="call-head-btn" id="callMinBtn" type="button" title="Minimize to a small window (keep chatting)">${ICON_MINIMIZE}<span>Minimize</span></button>
          <button class="call-head-btn" id="callFsBtn" type="button" title="Fullscreen">${ICON_FULLSCREEN}<span>Fullscreen</span></button>
        </div>
        <div class="call-body">
          <div class="call-stage">
            <div class="call-grid" id="callGrid"></div>
            <div class="call-status" id="callStatus"></div>
          </div>
          <aside class="call-chat" id="callChat">
            <div class="call-chat-head">
              <b>Chat</b><span class="hint">Only for this call · not saved</span>
              <button class="icon-btn small" id="callChatClose" title="Close chat">✕</button>
            </div>
            <div class="call-chat-list" id="callChatList"><div class="call-chat-empty">Messages here go only to people in this call and disappear when it ends.</div></div>
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
          ${btn('callAddBtn', '➕', 'Add')}
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
    panel.querySelector('#callMinBtn').addEventListener('click', () => setCallMinimized(!panel.classList.contains('min')));
    makeCallPanelDraggable(panel, call);
    makeCallPanelResizable(panel, call);
    panel.querySelector('#callAddBtn').addEventListener('click', () => openCallAdder());
    panel.querySelector('#callFsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (panel.requestFullscreen) panel.requestFullscreen().catch(() => {});
    });
  }

  /* ----- floating windows you can drag anywhere -----
     Used by the minimized video-call window and the screen-share window. Grab
     any part that isn't a button (mouse or finger) and move it; it stays fully
     on screen — also when the browser window is resized or the phone rotates.
     opts.active() says whether it may be dragged right now; opts.onMove(x, y)
     remembers where it was left. */
  function placeFloating(panel, x, y) {
    // A minimized/hidden browser window measures 0×0 — don't squash the window then.
    if (!window.innerWidth || !window.innerHeight) return { x, y };
    const w = panel.offsetWidth, h = panel.offsetHeight;
    x = Math.min(Math.max(0, window.innerWidth - w), Math.max(0, x));
    y = Math.min(Math.max(0, window.innerHeight - h), Math.max(0, y));
    panel.style.width = w + 'px'; // phones stretch it edge to edge; freeze that width while it floats
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.classList.add('moved');
    return { x, y };
  }

  function clearFloatingPos(panel) {
    ['left', 'top', 'right', 'bottom', 'width'].forEach((k) => { panel.style[k] = ''; });
    panel.classList.remove('moved');
  }

  function makeDraggable(panel, opts) {
    opts = opts || {};
    const active = opts.active || (() => true);
    const onMove = opts.onMove || (() => {});
    let drag = null;
    panel.classList.add('draggable');
    panel.addEventListener('pointerdown', (e) => {
      if (!active() || e.button > 0) return;
      if (e.target.closest('button, input, textarea, select, a, form, .zoom-ctl, .screen-resize')) return;
      const r = panel.getBoundingClientRect();
      // The bottom-right corner of a resizable window resizes it instead.
      if (getComputedStyle(panel).resize !== 'none' && e.clientX > r.right - 22 && e.clientY > r.bottom - 22) return;
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moving: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // A small threshold so a tap/click on the window still works as a click.
      if (!drag.moving && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      if (!drag.moving) {
        drag.moving = true;
        panel.classList.add('dragging');
        try { panel.setPointerCapture(drag.id); } catch (_e) {}
      }
      e.preventDefault();
      const pos = placeFloating(panel, e.clientX - drag.dx, e.clientY - drag.dy);
      onMove(pos.x, pos.y);
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      panel.classList.remove('dragging');
      drag = null;
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // Keep it on screen when the browser window changes size or rotates.
    const onResize = () => {
      if (!document.body.contains(panel)) return window.removeEventListener('resize', onResize);
      if (!panel.classList.contains('moved') || !active()) return;
      // Keep its size (narrowing only if the screen got smaller), then pull it back on screen.
      panel.style.width = Math.min(panel.offsetWidth, window.innerWidth - 16) + 'px';
      const r = panel.getBoundingClientRect();
      const pos = placeFloating(panel, r.left, r.top);
      onMove(pos.x, pos.y);
    };
    window.addEventListener('resize', onResize);
  }

  // Minimized call window: draggable while minimized; it returns to the same
  // spot the next time the call is minimized.
  function setCallMinimized(on) {
    const call = state.call;
    const panel = document.getElementById('callPanel');
    if (!call || !panel) return;
    panel.classList.toggle('min', on);
    const minBtn = panel.querySelector('#callMinBtn');
    minBtn.innerHTML = (on ? ICON_EXPAND : ICON_MINIMIZE) + `<span>${on ? 'Expand' : 'Minimize'}</span>`;
    minBtn.title = on ? 'Back to the full call screen' : 'Minimize to a small window (keep chatting)';
    if (on) {
      if (call.minSize) { panel.style.width = call.minSize.w + 'px'; panel.style.height = call.minSize.h + 'px'; }
      if (call.minPos) placeFloating(panel, call.minPos.x, call.minPos.y);
    } else {
      clearFloatingPos(panel);
      panel.style.height = '';
    }
  }

  // Resize the minimized call window from its corner grip (any size from a
  // small thumbnail up to almost the whole screen); remembered for the call.
  function makeCallPanelResizable(panel, call) {
    const grip = el('<div class="call-resize" title="Drag to resize"></div>');
    panel.appendChild(grip);
    let rs = null;
    grip.addEventListener('pointerdown', (e) => {
      if (!panel.classList.contains('min')) return;
      e.preventDefault();
      e.stopPropagation();
      const r = panel.getBoundingClientRect();
      placeFloating(panel, r.left, r.top); // anchor the top-left corner
      rs = { id: e.pointerId, x: e.clientX, y: e.clientY, w: r.width, h: r.height, left: r.left, top: r.top };
      try { grip.setPointerCapture(e.pointerId); } catch (_e) {}
      panel.classList.add('resizing');
    });
    grip.addEventListener('pointermove', (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      const w = Math.max(260, Math.min(window.innerWidth - rs.left - 8, rs.w + (e.clientX - rs.x)));
      const h = Math.max(220, Math.min(window.innerHeight - rs.top - 8, rs.h + (e.clientY - rs.y)));
      panel.style.width = w + 'px';
      panel.style.height = h + 'px';
      call.minSize = { w, h };
    });
    const end = (e) => {
      if (!rs || e.pointerId !== rs.id) return;
      rs = null;
      panel.classList.remove('resizing');
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  function makeCallPanelDraggable(panel, call) {
    makeDraggable(panel, {
      active: () => panel.classList.contains('min'),
      onMove: (x, y) => { call.minPos = { x, y }; },
    });
  }

  /* ----- screen sharing inside a call -----
     Any tab, window or the whole screen (same picker as the 1:1 "Share
     screen" button). The screen replaces our camera on every link (replaceTrack — no
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
      stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_OPTS);
    } catch (_e) { return; } // picker cancelled
    const track = stream.getVideoTracks()[0];
    if (state.call !== call) { stream.getTracks().forEach((t) => t.stop()); return; }
    try { track.contentHint = 'detail'; } catch (_e) {} // keep text sharp
    call.screen = stream;
    track.addEventListener('ended', () => stopCallScreenShare()); // browser's own "Stop sharing"
    call.peers.forEach((peer) => setPeerVideo(peer, track));
    showLocalPreview();
    reflectLocalCallState();
    layoutCallGrid();
    sendCallState();
    callToast(`You are sharing your ${surfaceName(track)} with everyone in the call`);
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
     Relayed live to the people in the call only (`call:chat`): never stored,
     and never shown in the 1:1 or group conversation. */
  function toggleCallChat(open) {
    const call = state.call;
    const panel = document.getElementById('callPanel');
    if (!call || !panel) return;
    const isOpen = open == null ? !panel.classList.contains('chat-open') : open;
    panel.classList.toggle('chat-open', isOpen);
    panel.querySelector('#callChatBtn').classList.toggle('active', isOpen);
    if (isOpen) {
      setCallMinimized(false);
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
    appendRichText(item.querySelector('.call-chat-text'), body);
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
    state.socket.emit('call:chat', { room: call.room, body }, (res) => {
      if (res && res.error) { input.value = body; return notifyToast(res.error); }
      appendCallChat('You', body, true, res && res.at);
    });
  }

  // "Add" during a call: ring one more person (up to 4 in the call). In a group
  // call it lists the group's members; otherwise your friends.
  async function openCallAdder() {
    const call = state.call;
    if (!call || !call.room) return notifyToast('Wait until the call has connected.');
    if (call.peers.size + 1 >= 4) return notifyToast('A call can have at most 4 people.');
    // Already in the call, or the person this 1:1 call is ringing.
    const inCall = new Set([...call.peers.keys(), state.me && state.me.id, call.target.to].filter(Boolean));
    let people = [];
    try {
      if (call.target.kind === 'group') {
        const { group } = await api.get('/api/groups/' + call.target.groupId);
        people = (group.members || []).filter((m) => m.status === 'joined')
          .map((m) => ({ id: m.id, username: m.username, displayName: m.displayName, avatar: m.avatar }));
      } else {
        people = (await api.get('/api/social/friends')).friends || [];
      }
    } catch (e) { return notifyToast(e.message); }
    people = people.filter((p) => !inCall.has(p.id));
    const { card, close } = openModal('Add to call', `
      <p class="hint">They’ll get a ring and can join this call. Up to 4 people in a call.</p>
      <div class="pick-list call-add-list">${people.length ? '' : '<div class="hint">Nobody else to add.</div>'}</div>`);
    const list = card.querySelector('.call-add-list');
    people.forEach((p) => {
      const row = el(`<button type="button" class="pick-row call-add-row">${avatarWithPresence(p.id, p.avatar, 'sm')}<span class="call-add-name"></span><span class="call-add-state hint">Add</span></button>`);
      row.querySelector('.call-add-name').textContent = p.displayName || p.username;
      row.addEventListener('click', () => {
        row.disabled = true;
        row.querySelector('.call-add-state').textContent = 'Ringing…';
        state.socket.emit('call:invite', { room: call.room, userId: p.id }, (res) => {
          if (res && res.error) { row.disabled = false; row.querySelector('.call-add-state').textContent = 'Add'; return notifyToast(res.error); }
          callToast(`Ringing ${res.name || p.displayName}…`);
          close();
        });
      });
      list.appendChild(row);
    });
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
    const line = !isGroup && ring.invited ? `<b>${who}</b> is adding you to a video call (${Number(ring.count) || 1} in the call)`
      : !isGroup ? `<b>${who}</b> is calling you`
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
        : ring.invited
          ? { kind: 'room', room: ring.room, name: `${ring.fromName || 'Call'}’s call` }
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
      // Move the conversation to the top of Chats (and count it if unseen).
      const otherId = m.from === state.me.id ? m.to : m.from;
      const cp = state.chatPeers[otherId];
      if (cp) {
        cp.lastAt = m.at || Date.now();
        if (!relevant && !m.mine && m.from !== state.me.id) cp.unread = (cp.unread || 0) + 1;
      }
      if (state.tab === 'chats' || !document.getElementById('searchInput').value.trim()) renderList();
      syncAppBadge();
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
    // A file shared in one of my groups (live only, never stored server-side).
    s.on('group:file', (meta) => {
      const blob = new Blob([meta.data], { type: meta.mime });
      const url = URL.createObjectURL(blob);
      const entry = { id: meta.id, groupId: meta.groupId, from: meta.from, fromName: meta.fromName, mine: false, name: meta.name, mime: meta.mime, size: meta.size, at: meta.at || Date.now(), url };
      cacheSharedFile('g' + meta.groupId, entry);
      idbSaveFile('g' + meta.groupId, entry, blob);
      if (state.group && state.group.gid === meta.groupId) appendFileBubble(entry, false, url);
      else notify(`${meta.fromName || 'Someone'} shared a file in a group`);
    });

    s.on('group:message', (m) => {
      if (state.group && state.group.gid === m.groupId) { appendGroupMessage(m); markGroupRead(); }
      else if (!m.mine) {
        const tabId = 'g' + m.groupId;
        if (state.openChats.some((p) => p.id === tabId)) { state.unread[tabId] = true; renderChatTabs(); }
        else notify(`${m.fromName} messaged a group`);
        // Blink the "Chats" nav button for an unread group message elsewhere.
        if (state.tab !== 'chats') markNav('chats', true);
      }
      if (state.tab === 'chats') renderList();
      syncAppBadge();
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
      const gone = call.peers.get(userId);
      if (call.target.kind !== 'group' && call.peers.size <= 1) { endCall(); return notifyToast('Call ended.'); }
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
    s.on('call:chat', (m) => {
      if (state.call && state.call.room === m.room) appendCallChat(m.fromName || 'Someone', m.body, false, m.at);
    });
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
      const won = d.points > 0 ? ` · you won ${d.points} points` : d.points < 0 ? ` · you lost ${-d.points} points` : '';
      t.textContent = d.challenge
        ? `⚔️ ${d.bName} ${d.forfeit ? 'forfeited' : 'finished'} your “${d.quizTitle}” challenge — ${d.winner === 'tie' ? 'it’s a tie' : d.winner === 'a' ? 'you won' : 'they won'} (${d.aPoints}–${d.bPoints})${won}. See results ↗`
        : d.scored
        ? `🧠 ${d.bName} took on your “${d.quizTitle}” — you ${d.aCorrect}, them ${d.bCorrect} of ${d.graded}${pts}. See results ↗`
        : `🧩 ${d.bName} answered “${d.quizTitle}” — ${d.percent}% match${pts}. See results ↗`;
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
    s.on('suggestion:update', (d) => {
      notifyToast(d.replied ? '💡 The admin replied to your suggestion.' : '💡 Your suggestion’s status was updated.');
      if (isExploreActive('suggestions')) renderSuggestions();
    });
    s.on('blog:liked', (d) => notifyToast(`@${d.by} liked your blog post — +1 point.`));
    s.on('blog:comment', (d) => notifyToast(`@${d.by} commented on your blog post.`));

    s.on('chat:receipt', (r) => applyReceipt(r));
    s.on('chat:unsent', (e) => {
      const other = e.from === state.me.id ? e.to : e.from;
      if (state.peer && state.peer.id === other) markBubbleDeleted(e.id);
    });
    s.on('group:unsent', (e) => {
      if (state.group && state.group.gid === e.groupId) markBubbleDeleted(e.id, e.groupId);
    });

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
  /* ---------- Zoom for full-size images ----------
     attachZoom(img, host) lets the viewer zoom an image up to 5×: mouse wheel
     (towards the pointer), pinch on touch screens, double-click / double-tap
     to jump in and out, drag to move around a zoomed image, and the −/+ buttons
     it adds to `host`. Returns { reset, isZoomed, wasDragged, destroy }. */
  function attachZoom(img, host) {
    const MIN = 1, MAX = 5;
    let s = 1, tx = 0, ty = 0;
    let dragged = false;
    img.classList.add('zoomable');
    img.draggable = false;

    const controls = el(`
      <div class="zoom-ctl" role="group" aria-label="Zoom">
        <button type="button" class="zoom-out" title="Zoom out (−)">−</button>
        <button type="button" class="zoom-level" title="Reset zoom (0)">100%</button>
        <button type="button" class="zoom-in" title="Zoom in (+)">+</button>
      </div>`);
    host.appendChild(controls);
    const level = controls.querySelector('.zoom-level');

    const base = () => {
      const r = img.getBoundingClientRect();
      return { left: r.left - tx, top: r.top - ty, w: r.width / s, h: r.height / s };
    };
    const clamp = () => {
      if (s <= 1) { s = 1; tx = 0; ty = 0; return; }
      const b = base();
      tx = Math.min(0, Math.max(b.w - b.w * s, tx));
      ty = Math.min(0, Math.max(b.h - b.h * s, ty));
    };
    const apply = (animate) => {
      clamp();
      img.style.transition = animate ? 'transform .18s ease' : 'none';
      img.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
      img.classList.toggle('zoomed', s > 1);
      level.textContent = Math.round(s * 100) + '%';
    };
    // Zoom to `ns`, keeping the image point under (cx, cy) where it is.
    const zoomAt = (ns, cx, cy, animate) => {
      ns = Math.min(MAX, Math.max(MIN, ns));
      const b = base();
      if (cx == null) { cx = b.left + b.w / 2; cy = b.top + b.h / 2; }
      const px = cx - b.left, py = cy - b.top;
      tx = px - (px - tx) * (ns / s);
      ty = py - (py - ty) * (ns / s);
      s = ns;
      apply(animate);
    };
    const reset = () => { s = 1; tx = 0; ty = 0; apply(false); };

    controls.querySelector('.zoom-in').addEventListener('click', (e) => { e.stopPropagation(); zoomAt(s * 1.5, null, null, true); });
    controls.querySelector('.zoom-out').addEventListener('click', (e) => { e.stopPropagation(); zoomAt(s / 1.5, null, null, true); });
    level.addEventListener('click', (e) => { e.stopPropagation(); reset(); });

    const onWheel = (e) => {
      e.preventDefault();
      zoomAt(s * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY, false);
    };
    img.addEventListener('wheel', onWheel, { passive: false });
    img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (s > 1) { s = 1; apply(true); } else zoomAt(2.5, e.clientX, e.clientY, true);
    });

    // Pointer gestures: one finger/mouse drags a zoomed image; two pinch.
    const pts = new Map();
    let pinch = null, pan = null, lastTap = 0;
    img.addEventListener('pointerdown', (e) => {
      try { img.setPointerCapture(e.pointerId); } catch (_e) { /* keep tracking without capture */ }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragged = false;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s };
        pan = null;
      } else if (pts.size === 1) {
        pan = { x: e.clientX, y: e.clientY, tx, ty };
        // Double-tap on touch screens (dblclick isn't fired there).
        if (e.pointerType === 'touch') {
          const now = Date.now();
          if (now - lastTap < 300) {
            if (s > 1) { s = 1; apply(true); } else zoomAt(2.5, e.clientX, e.clientY, true);
            lastTap = 0;
          } else lastTap = now;
        }
      }
    });
    img.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt(pinch.s * (d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2, false);
        dragged = true;
      } else if (pan && s > 1) {
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
        tx = pan.tx + dx; ty = pan.ty + dy;
        apply(false);
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) { const [p] = [...pts.values()]; pan = { x: p.x, y: p.y, tx, ty }; }
      if (!pts.size) pan = null;
    };
    img.addEventListener('pointerup', end);
    img.addEventListener('pointercancel', end);

    const onKey = (e) => {
      if (!document.body.contains(img)) { document.removeEventListener('keydown', onKey); return; }
      if (e.key === '+' || e.key === '=') zoomAt(s * 1.5, null, null, true);
      else if (e.key === '-' || e.key === '_') zoomAt(s / 1.5, null, null, true);
      else if (e.key === '0') reset();
    };
    document.addEventListener('keydown', onKey);
    apply(false);

    return {
      reset,
      isZoomed: () => s > 1,
      wasDragged: () => dragged,
      destroy: () => document.removeEventListener('keydown', onKey),
    };
  }

  function openLightbox(url) {
    const box = el(`<div class="lightbox"><img alt="" /><button class="lb-close" title="Close">✕</button></div>`);
    const img = box.querySelector('img');
    img.src = url;
    const zoom = attachZoom(img, box);
    const close = () => { zoom.destroy(); box.remove(); document.removeEventListener('keydown', onKey); };
    // A click on the dark backdrop closes — but not right after dragging/zooming.
    box.addEventListener('click', (e) => {
      if (e.target.classList.contains('lb-close')) return close();
      if (e.target === box && !zoom.wasDragged()) close();
    });
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
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
        <button class="ss-nav ss-prev" title="Previous (←)" aria-label="Previous">${CHEVRON_LEFT}</button>
        <div class="ss-stage">
          <img class="ss-img" alt="" />
          <div class="ss-caption"></div>
        </div>
        <button class="ss-nav ss-next" title="Next (→)" aria-label="Next">${CHEVRON_RIGHT}</button>
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

    const zoom = attachZoom(img, box);
    // Zoom −/+ sit in the same bottom toolbar as play and the counter.
    box.querySelector('.ss-bar').appendChild(box.querySelector('.zoom-ctl'));
    const paint = () => {
      const it = items[i];
      zoom.reset(); // each picture starts unzoomed
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
      zoom.destroy();
      box.remove();
      document.removeEventListener('keydown', onKey);
    };
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' && !zoom.isZoomed()) { stopAuto(); go(1); }
      else if (e.key === 'ArrowLeft' && !zoom.isZoomed()) { stopAuto(); go(-1); }
      else if (e.key === ' ') { e.preventDefault(); toggleAuto(); }
    }

    box.querySelector('.lb-close').addEventListener('click', close);
    box.querySelector('.ss-prev').addEventListener('click', () => { stopAuto(); go(-1); });
    box.querySelector('.ss-next').addEventListener('click', () => { stopAuto(); go(1); });
    playBtn.addEventListener('click', toggleAuto);
    box.addEventListener('click', (e) => {
      if ((e.target === box || e.target.classList.contains('ss-stage')) && !zoom.wasDragged()) close();
    });
    document.addEventListener('keydown', onKey);
    // Zooming in pauses the slideshow so the picture doesn't change under you.
    img.addEventListener('wheel', () => stopAuto(), { passive: true });
    img.addEventListener('pointerdown', () => stopAuto());

    // Touch swipe to change slides (one finger, only when not zoomed in).
    let sx = null;
    box.querySelector('.ss-stage').addEventListener('touchstart', (e) => {
      sx = e.touches.length === 1 && !zoom.isZoomed() ? e.touches[0].clientX : null;
    }, { passive: true });
    box.querySelector('.ss-stage').addEventListener('touchend', (e) => {
      if (sx == null || zoom.isZoomed()) { sx = null; return; }
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
        <button class="pv-nav pv-prev" title="Previous (←)" aria-label="Previous">${CHEVRON_LEFT}</button>
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
        <button class="pv-nav pv-next" title="Next (→)" aria-label="Next">${CHEVRON_RIGHT}</button>
      </div>
    `);
    const mediaImg = box.querySelector('.pv-media img');
    const zoom = attachZoom(mediaImg, box.querySelector('.pv-media'));
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
        btn.addEventListener('click', () => react(r.emoji));
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
      appendRichText(item.querySelector('.c-text'), c.body);
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

    {
      const form = el(`
        <div class="comment-form">
          <input id="pcInput" maxlength="500" placeholder="${isOwner ? 'Add a comment…' : 'Say something about this…'}" />
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
      media.addEventListener('touchstart', (e) => {
        sx = e.touches.length === 1 && !zoom.isZoomed() ? e.touches[0].clientX : null;
      }, { passive: true });
      media.addEventListener('touchend', (e) => {
        if (sx == null || zoom.isZoomed()) { sx = null; return; }
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
      box.querySelector('.pv-media').classList.toggle('pv-reel', isReel); // hides the zoom buttons
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
        zoom.reset();
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
  // Who follows a member / who they follow, in a modal. Each row opens that
  // member's profile; members you don't follow yet get a Follow button.
  async function showFollowList(profile, which) {
    const name = profile.displayName || '@' + profile.username;
    const title = which === 'followers' ? `${name}’s followers` : `${name} follows`;
    const { card, close } = openModal(title, '<div class="hint">Loading…</div>');
    const body = card.querySelector('.modal-body');
    let users;
    try { users = (await api.get(`/api/follow/${encodeURIComponent(profile.username)}/${which}`)).users || []; }
    catch (e) { body.innerHTML = `<div class="msg error">${esc(e.message)}</div>`; return; }
    if (!users.length) {
      body.innerHTML = `<div class="hint">${which === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</div>`;
      return;
    }
    body.innerHTML = '<input type="search" class="follow-search" placeholder="Search…" aria-label="Search" /><div class="pick-list follow-list"></div>';
    const list = body.querySelector('.follow-list');
    users.forEach((u) => {
      const row = el(`
        <div class="list-item follow-row" data-q="${esc((u.displayName + ' ' + u.username).toLowerCase())}">
          <img class="avatar" src="${avatarUrl(u.avatar)}" alt="" />
          <div style="min-width:0">
            <div class="name">${esc(u.displayName)}${u.isMe ? ' <span class="hint">(you)</span>' : ''}</div>
            <div class="handle">@${esc(u.username)} · since ${fmtDate(u.since)}</div>
          </div>
        </div>`);
      if (!u.isMe && !u.iFollow) {
        const btn = el('<button type="button" class="ghost small follow-row-btn">➕ Follow</button>');
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true;
          try { await api.post('/api/follow/' + encodeURIComponent(u.username), {}); btn.textContent = '✓ Following'; }
          catch (err) { btn.disabled = false; alert(err.message); }
        });
        row.appendChild(btn);
      }
      row.addEventListener('click', () => { close(); showProfile(u.username); });
      list.appendChild(row);
    });
    const search = body.querySelector('.follow-search');
    if (users.length < 8) search.remove();
    else search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll('.follow-row').forEach((r) => r.classList.toggle('hidden', !!q && !r.dataset.q.includes(q)));
    });
  }

  function renderFollow(view, profile, isMe) {
    let f = profile.follow || { followers: 0, following: 0, isFollowing: false };
    const counts = view.querySelector('#pvFollowCounts');
    const paintCounts = () => {
      counts.innerHTML = `<button type="button" class="link-btn" data-list="followers"><strong>${f.followers}</strong> follower${f.followers === 1 ? '' : 's'}</button> · <button type="button" class="link-btn" data-list="following"><strong>${f.following}</strong> following</button>`;
      counts.querySelectorAll('[data-list]').forEach((b) =>
        b.addEventListener('click', () => showFollowList(profile, b.dataset.list)));
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
          if (f.isFollowing && !(await confirmBox(`Unfollow ${profile.displayName || '@' + profile.username}?`, 'Unfollow'))) return;
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
        input.addEventListener('input', () => {
          if (Number(input.value) > me.maxFee) input.value = me.maxFee; // can't go above the cap
          gain.textContent = (Number(input.value) || 0) * me.multiplier;
        });
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
          <div class="pro-cover${profile.cover ? ' has-photo' : ''}"${profile.cover ? ` style="background-image:url('${esc(profile.cover)}')"` : ''}>
            ${isMe ? `<div class="cover-actions">
              <button class="ghost small cover-btn" id="pvCoverBtn" type="button">🖼️ ${profile.cover ? 'Change cover' : 'Add cover photo'}</button>
              ${profile.cover ? '<button class="ghost small cover-btn" id="pvCoverRemove" type="button">✕ Remove</button>' : ''}
            </div>` : ''}
          </div>
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
              ${isMe && profile.points ? `<div class="pro-points" title="Your total points — they decide your leaderboard rank">🏆 <b>${profile.points.total}</b> point${profile.points.total === 1 ? '' : 's'}${profile.points.rank ? ` · rank #${profile.points.rank}` : ''}</div>` : ''}
            </div>
          </div>
          <div class="pro-actions pv-actions">
            ${!isMe && profile.friends.state === 'friends' ? '<button class="primary" id="pvChat">💬 Message</button>' : ''}
            ${!isMe ? `<span id="pvFollow"></span>` : ''}
            ${!isMe ? `<span id="pvFriend"></span>` : ''}
            ${!isMe ? `<span id="pvBlock"></span>` : ''}
            ${isMe ? '<button class="ghost" id="pvEdit">✎ Edit profile</button>' : ''}
            ${isMe ? '<button class="ghost" id="pvAccount" title="Password, email, download my data, delete account">⚙️ Account</button>' : ''}
            ${isMe ? '<button class="ghost" id="pvCameraTop" title="Take a photo or record a reel for your gallery">📷 Camera</button>' : ''}
            <button class="ghost" id="pvShare" title="Copy a shareable link to this profile">🔗 Share</button>
            ${isMe && profile.referralCode ? '<button class="ghost" id="pvRefer" title="Invite someone to join getxmatch with your referral code">🎟️ Refer</button>' : ''}
          </div>
          ${isMe && profile.referralCode ? `<div class="referral-box">Your referral code: <b class="referral-code">${esc(profile.referralCode)}</b>
            <button type="button" class="primary small" id="pvReferBox">📤 Share code</button>
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
          if (!(await confirmBox(isReel ? 'Delete this reel?' : 'Delete this photo?', 'Delete'))) return;
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
        const cropped = await fitImageToLimit(await cropImage(picked));
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

    /* ----- follows ----- */
    renderFollow(view, profile, isMe);

    /* ----- misc wiring ----- */

    // Own profile: add / change / remove the cover picture behind the name.
    const coverBtn = view.querySelector('#pvCoverBtn');
    if (coverBtn) {
      const coverIn = el('<input type="file" accept="image/*" class="hidden" />');
      view.appendChild(coverIn);
      coverBtn.addEventListener('click', () => coverIn.click());
      coverIn.addEventListener('change', async () => {
        const picked = coverIn.files[0];
        coverIn.value = '';
        if (!picked) return;
        const file = await fitImageToLimit(await cropImage(picked));
        if (!file) return;
        const fd = new FormData();
        fd.append('cover', file);
        coverBtn.disabled = true;
        coverBtn.textContent = 'Uploading…';
        try { await api.putForm('/api/profile/cover', fd); showProfile(username); }
        catch (e) { coverBtn.disabled = false; coverBtn.textContent = '🖼️ Change cover'; alert(e.message); }
      });
    }
    const coverRemove = view.querySelector('#pvCoverRemove');
    if (coverRemove) coverRemove.addEventListener('click', async () => {
      if (!(await confirmBox('Remove your cover photo?', 'Remove'))) return;
      try { await api.del('/api/profile/cover'); showProfile(username); } catch (e) { alert(e.message); }
    });

    // Tap the profile picture to see it full size (zoomable).
    if (profile.avatar) {
      const av = view.querySelector('.pro-avatar');
      av.classList.add('clickable');
      av.title = 'View full size';
      av.addEventListener('click', () => openLightbox(avatarUrl(profile.avatar)));
    }
    view.querySelector('#pvBack').addEventListener('click', () => {
      if (state.peer) openChat(state.peer);
      else { document.getElementById('shell').classList.remove('viewing-main'); main.innerHTML = ''; }
    });
    const accountBtn = view.querySelector('#pvAccount');
    if (accountBtn) accountBtn.addEventListener('click', () => {
      const nav = document.querySelector('#exploreNav button[data-view="account"]');
      if (nav) nav.click(); else renderAccount();
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
        catch (_e) { promptBox('Copy link', 'Copy this profile link:', link); }
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
        catch (_e) { promptBox('Copy link', 'Copy this link to share:', link); }
      });
    }
    // Refer: opens the same share window as a poll, with a link that invites
    // someone to sign up with my code.
    if (profile.referralCode) {
      const openRefer = () => openShareSheet({
        title: 'Share your referral code',
        hint: `Anyone who joins with code ${profile.referralCode} gets 2 points, and you get 4.`,
        url: location.origin + '/?ref=' + encodeURIComponent(profile.referralCode),
        text: `Join me on getxmatch! Use my referral code ${profile.referralCode} when you sign up.`,
      });
      view.querySelectorAll('#pvRefer, #pvReferBox').forEach((b) => b.addEventListener('click', openRefer));
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
      if (confirmMsg && !(await confirmBox(confirmMsg, 'OK'))) return;
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
      const reason = await promptBox('Report @' + profile.username, 'Optionally add a reason:', '');
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
      if (priced && fee && !(await confirmBox(`Send a friend request? If they accept, it costs you ${fee} point${fee === 1 ? '' : 's'} and they earn ${fee * 2}.`, 'Send request'))) return;
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
      case 'awaiting_guardian':
        slot.appendChild(el('<span class="pill" title="A parent has to approve this friendship before you can chat">⏳ Waiting for parent approval</span>'));
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
  // `fstate` is one of self|friends|incoming|outgoing|awaiting_guardian|none.
  // Returns null for self.
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
      case 'awaiting_guardian': return el('<span class="pill" title="A parent has to approve this friendship first">⏳ Parent approval</span>');
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
    if (view === 'suggestions') return renderSuggestions();
    if (view === 'account') return renderAccount();
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
          <label class="hw-attach" title="Add photos or videos (up to 10)">📷 <span id="hwFileName">Add photos / videos</span>
            <input type="file" id="hwImage" accept="image/*,video/*" multiple hidden />
          </label>
          <span class="spacer"></span>
          <button class="primary" id="hwPost">Post to Highway</button>
        </div>
        <div class="hw-picked hidden" id="hwPicked"></div>
        <div class="msg" id="hwMsg"></div>
      </div>
    `);
    body.appendChild(composer);

    const feed = el('<div class="highway-feed" id="hwFeed"><div class="hint" style="padding:16px">Loading…</div></div>');
    body.appendChild(feed);
    highwayFeed = feed;

    // Picked photos/videos, previewed under the box; each can be removed.
    const MAX_HW_MEDIA = 10;
    const fileInput = composer.querySelector('#hwImage');
    const fileName = composer.querySelector('#hwFileName');
    const pickedBox = composer.querySelector('#hwPicked');
    let picked = []; // [{ file, url }]
    const renderPicked = () => {
      pickedBox.innerHTML = '';
      pickedBox.classList.toggle('hidden', !picked.length);
      fileName.textContent = picked.length ? `${picked.length} selected · add more` : 'Add photos / videos';
      picked.forEach((pk, i) => {
        const isVideo = pk.file.type.startsWith('video/');
        const cell = el(`<div class="hw-picked-item">${isVideo ? '<video muted playsinline></video><span class="hw-picked-badge">▶</span>' : '<img alt="" />'}<button type="button" class="hw-picked-x" title="Remove">✕</button></div>`);
        cell.querySelector(isVideo ? 'video' : 'img').src = pk.url;
        cell.querySelector('.hw-picked-x').addEventListener('click', () => {
          URL.revokeObjectURL(pk.url);
          picked.splice(i, 1);
          renderPicked();
        });
        pickedBox.appendChild(cell);
      });
    };
    fileInput.addEventListener('change', async () => {
      const msg = composer.querySelector('#hwMsg'); msg.className = 'msg';
      let files = Array.from(fileInput.files || []).filter((f) => /^(image|video)\//.test(f.type));
      fileInput.value = '';
      files = await fitImagesToLimit(files); // offer to compress photos over 5 MB
      const room = MAX_HW_MEDIA - picked.length;
      if (files.length > room) { msg.className = 'msg error'; msg.textContent = `You can add up to ${MAX_HW_MEDIA} photos or videos to one post.`; }
      files.slice(0, Math.max(0, room)).forEach((file) => picked.push({ file, url: URL.createObjectURL(file) }));
      renderPicked();
    });
    const postBtn = composer.querySelector('#hwPost');
    postBtn.addEventListener('click', async () => {
      const msg = composer.querySelector('#hwMsg'); msg.className = 'msg';
      const text = composer.querySelector('#hwText').value.trim();
      if (!text && !picked.length) { msg.className = 'msg error'; msg.textContent = 'Write something or add a photo or video.'; return; }
      const fd = new FormData();
      fd.append('body', text);
      picked.forEach((pk) => fd.append('media', pk.file));
      postBtn.disabled = true;
      postBtn.textContent = picked.length ? 'Uploading…' : 'Posting…';
      try {
        const { post } = await api.postForm('/api/highway', fd);
        composer.querySelector('#hwText').value = '';
        picked.forEach((pk) => URL.revokeObjectURL(pk.url));
        picked = [];
        renderPicked();
        prependHighwayPost(feed, post);
        trimHighwayFeed(feed);
      } catch (e) { msg.className = 'msg error'; msg.textContent = e.message; }
      finally { postBtn.disabled = false; postBtn.textContent = 'Post to Highway'; }
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

  // A blog post listed on the Highway: cover, title and opening; opens the post.
  function highwayBlogEl(b) {
    const box = el(`
      <button type="button" class="hw-blog">
        ${b.cover ? `<img class="hw-blog-cover" src="${esc(b.cover)}" alt="" loading="lazy" />` : ''}
        <span class="hw-blog-text">
          <span class="hw-blog-kicker">📝 New blog post${b.category ? ' · ' + esc(b.category) : ''} · ${b.readMinutes} min read</span>
          <strong class="hw-blog-title"></strong>
          <span class="hw-blog-excerpt"></span>
          <span class="hw-blog-cta">Read the post →</span>
        </span>
      </button>`);
    box.querySelector('.hw-blog-title').textContent = b.title;
    box.querySelector('.hw-blog-excerpt').textContent = b.excerpt || '';
    box.addEventListener('click', () => openBlog(b.id));
    return box;
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
    if (p.blog) card.appendChild(highwayBlogEl(p.blog));
    const media = (p.media && p.media.length) ? p.media : (p.image ? [{ url: p.image, kind: 'image' }] : []);
    if (media.length) card.appendChild(highwayMediaEl(media));

    const actionSlot = card.querySelector('.hw-action');
    if (p.mine) {
      const del = el('<button class="ghost small" type="button" title="Delete this post">Delete</button>');
      del.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!(await confirmBox('Delete this post?', 'Delete'))) return;
        del.disabled = true;
        try { await api.del('/api/highway/' + p.id); }
        catch (e) { del.disabled = false; return notifyToast(e.message); }
        removeHighwayCard(card);
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
        </button>
        <button class="hw-like-n" type="button" title="See who liked this">${likesLabel(likes.count)}</button>
        <button class="hw-comment-toggle" type="button" title="Show comments">
          💬 <span class="hw-comment-n">${p.commentCount || ''}</span>
        </button>
        ${p.mine ? '' : `<button class="hw-report" type="button" title="Report this post"${p.reported ? ' disabled' : ''}>🚩 ${p.reported ? 'Reported' : 'Report'}</button>`}
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
        foot.querySelector('.hw-like-n').textContent = likesLabel(st.count);
      } catch (e) { alert(e.message); }
      finally { likeBusy = false; }
    });

    foot.querySelector('.hw-like-n').addEventListener('click', () => openHighwayLikes(p.id));

    const reportBtn = foot.querySelector('.hw-report');
    if (reportBtn) reportBtn.addEventListener('click', async () => {
      const reason = await promptBox('Report this post',
        'Why are you reporting it? (optional) — a post reported by 5 people is removed and its author is blocked for 6 hours.', '');
      if (reason === null) return;
      reportBtn.disabled = true;
      try {
        const res = await api.post('/api/highway/' + p.id + '/report', { reason });
        reportBtn.textContent = '🚩 Reported';
        if (res.removed) { removeHighwayCard(card); notifyToast('Thanks — this post has been removed.'); }
        else notifyToast(res.already ? 'You already reported this post.' : 'Thanks — your report was received.');
      } catch (e) { reportBtn.disabled = false; alert(e.message); }
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
  function highwayCommentEl(c, listEl, onCount, post) {
    const item = el(`
      <div class="hw-comment${c.parentId ? ' is-reply' : ''}" data-id="${c.id}">
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
    appendRichText(item.querySelector('.hw-comment-text'), c.body);
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

    // Reply (threads stay one level deep: a reply to a reply joins the thread).
    if (post) {
      const body = item.querySelector('.hw-comment-body');
      const replyBtn = el('<button class="hw-reply-btn" type="button">↩ Reply</button>');
      body.appendChild(replyBtn);
      replyBtn.addEventListener('click', () => {
        const open = body.querySelector(':scope > .hw-reply-form');
        if (open) { open.remove(); return; }
        const form = el(`<div class="hw-reply-form"><input maxlength="500" placeholder="Reply to ${esc(c.author.displayName)}…" /><button class="primary small" type="button">Reply</button></div>`);
        const input = form.querySelector('input');
        const submit = async () => {
          const text = input.value.trim();
          if (!text) return;
          try {
            const res = await api.post('/api/highway/' + post.id + '/comment', { body: text, parentId: c.id });
            form.remove();
            const threadTop = listEl.querySelector(`.hw-comment[data-id="${res.comment.parentId}"]`);
            const replies = threadTop && threadTop.querySelector(':scope > .hw-comment-body > .hw-replies');
            if (replies) replies.appendChild(highwayCommentEl(res.comment, listEl, onCount, post));
            if (typeof res.commentCount === 'number') onCount(res.commentCount);
          } catch (e) { alert(e.message); }
        };
        form.querySelector('button').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        replyBtn.after(form);
        input.focus();
      });
      if (!c.parentId) {
        const replies = el('<div class="hw-replies"></div>');
        (c.replies || []).forEach((rc) => replies.appendChild(highwayCommentEl(rc, listEl, onCount, post)));
        body.appendChild(replies);
      }
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
        list.appendChild(highwayCommentEl(res.comment, list, onCount, p));
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
      else comments.forEach((c) => list.appendChild(highwayCommentEl(c, list, onCount, p)));
    } catch (e) {
      list.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
    }
  }

  function likesLabel(n) {
    return n ? `${n} like${n === 1 ? '' : 's'}` : '';
  }

  // A post's photos/videos: one shows big; 2–4 in a grid; more show "+N" on
  // the 4th tile. Photos open a full-screen slideshow; videos play in place.
  function highwayMediaEl(media) {
    const shown = media.slice(0, 4);
    const grid = el(`<div class="hw-media" data-count="${shown.length}"></div>`);
    const photos = media.filter((m) => m.kind !== 'video');
    shown.forEach((m, i) => {
      const extra = i === 3 && media.length > 4 ? media.length - 4 : 0;
      const tile = el('<div class="hw-media-tile"></div>');
      if (m.kind === 'video') {
        const v = el('<video controls preload="metadata" playsinline></video>');
        v.src = m.url;
        tile.appendChild(v);
      } else {
        const img = el('<img loading="lazy" alt="shared photo" />');
        img.src = m.url;
        img.addEventListener('click', () => openSlideshow(photos.map((ph) => ({ url: ph.url })), photos.indexOf(m)));
        tile.appendChild(img);
      }
      if (extra) {
        const more = el(`<button type="button" class="hw-media-more">+${extra}</button>`);
        more.addEventListener('click', () => openHighwayMediaAll(media));
        tile.appendChild(more);
      }
      grid.appendChild(tile);
    });
    return grid;
  }

  // Every photo/video of a post, one under the other.
  function openHighwayMediaAll(media) {
    const { card } = openModal(`${media.length} photos & videos`, '<div class="hw-media-all"></div>');
    const list = card.querySelector('.hw-media-all');
    media.forEach((m) => {
      const node = m.kind === 'video' ? el('<video controls preload="metadata" playsinline></video>') : el('<img loading="lazy" alt="" />');
      node.src = m.url;
      list.appendChild(node);
    });
  }

  // "Who liked this": everyone who liked a post, with a link to their profile.
  async function openHighwayLikes(postId) {
    const { card, close } = openModal('Liked by', '<div class="hw-likers"><div class="hint">Loading…</div></div>');
    const box = card.querySelector('.hw-likers');
    let likes = [];
    try { likes = (await api.get('/api/highway/' + postId + '/likes')).likes || []; }
    catch (e) { box.innerHTML = `<div class="hint">${esc(e.message)}</div>`; return; }
    if (!likes.length) { box.innerHTML = '<div class="hint">No likes yet.</div>'; return; }
    box.innerHTML = '';
    likes.forEach((u) => {
      const row = el(`
        <button class="hw-liker" type="button">
          <img class="avatar sm" src="${avatarUrl(u.avatar)}" alt="" />
          <span class="hw-liker-name"><b></b> <span class="hint"></span></span>
          <span class="hint">${fmtDate(u.at)}</span>
        </button>`);
      row.querySelector('b').textContent = u.id === (state.me && state.me.id) ? 'You' : u.displayName;
      row.querySelector('.hw-liker-name .hint').textContent = '@' + u.username;
      row.addEventListener('click', () => { close(); showProfile(u.username); });
      box.appendChild(row);
    });
  }

  // Take a deleted post off the feed, with any ad that sat right after it, and
  // show the empty message if nothing is left.
  function removeHighwayCard(card) {
    const feed = card.parentNode;
    const next = card.nextElementSibling;
    if (next && next.classList.contains('ad-stream')) next.remove();
    card.remove();
    if (feed && !feed.querySelector('.highway-post') && !feed.querySelector('.empty-main')) {
      feed.appendChild(el('<div class="empty-main">No posts yet — be the first to hit the Highway!</div>'));
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
      id: payload.id, body: payload.body, image: payload.image, media: payload.media, blog: payload.blog,
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
    api.post('/api/notifications/read', {}).then(syncAppBadge, () => {});
    const badge = document.getElementById('notifBadge');
    if (badge) badge.classList.add('hidden');
    markNav('notifications', false);
    pushPromptEl().then((card) => { if (card && body.isConnected) body.prepend(card); });

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

  // Result line of a shared-quiz notification: right answers head to head for
  // a standard quiz, compatibility otherwise.
  function matchLine(it) {
    if (it.challenge) {
      const v = it.outcome === 'tie' ? 'It’s a tie' : it.outcome === 'won' ? 'You won' : `${esc(it.otherName)} won`;
      const moved = it.delta > 0 ? ` You won <strong>${it.delta} points</strong>.` : it.delta < 0 ? ` You lost <strong>${-it.delta} points</strong>.` : ' No points changed hands.';
      const how = it.forfeit ? (it.outcome === 'won' ? ` — ${esc(it.otherName)} left the quiz and forfeited.` : ' — you left the quiz and forfeited.')
        : ` — you scored ${it.myPoints}, ${esc(it.otherName)} scored ${it.theirPoints}.`;
      return `<strong>${v}</strong>${how}${moved}`;
    }
    if (it.scored) {
      const v = it.myCorrect === it.theirCorrect ? 'It’s a tie' : it.myCorrect > it.theirCorrect ? 'You won' : `${esc(it.otherName)} won`;
      return `<strong>${v}</strong> — you got ${it.myCorrect} of ${it.graded} right, ${esc(it.otherName)} got ${it.theirCorrect}.`;
    }
    return `You’re <strong>${it.percent}% compatible</strong> (${it.score} of ${it.total} answers in common).`;
  }

  function notificationEl(it) {
    let icon = '🔔';
    let html = '';
    if (it.kind === 'match_shared') {
      icon = '🧩';
      html = `<strong>${esc(it.otherName)}</strong> attempted the quiz you shared, <em>“${esc(it.quizTitle)}”</em>. ` +
        matchLine(it);
    } else if (it.kind === 'match_answered') {
      icon = '🧩';
      html = `You attempted <strong>${esc(it.otherName)}</strong>’s shared quiz <em>“${esc(it.quizTitle)}”</em>. ` +
        matchLine(it);
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
          ${q.badge ? `<span class="quiz-type">${esc(q.typeLabel)}</span>` : ''}
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
      <div class="poll-foot">
        <span class="poll-open">${p.closed ? 'See results ↗' : 'Open &amp; vote ↗'}</span>
        <button type="button" class="ghost small poll-share" title="Share this poll on WhatsApp, Facebook, X, Instagram and more">📤 Share</button>
      </div>
    </div>`);
    card.querySelector('.poll-share').addEventListener('click', (e) => { e.stopPropagation(); sharePoll(p); });
    card.querySelector('.poll-share').addEventListener('keydown', (e) => e.stopPropagation());
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

  // Share a community poll. The link carries ?r=<results version>: a new
  // version means a new URL, so WhatsApp / Facebook / LinkedIn etc. fetch the
  // preview afresh and it shows the current results (the page's preview image
  // is the live results card).
  function sharePoll(p) {
    let h = 5381;
    for (const ch of JSON.stringify([p.counts, !!p.closed])) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    const url = `${location.origin}/polls/${p.id}?r=${p.total}-${h.toString(36)}`;
    const results = p.total
      ? p.options.map((o, i) => `${o.length > 40 ? o.slice(0, 39) + '…' : o} ${Math.round(((p.counts[i] || 0) / p.total) * 100)}%`).join(' · ') + ` — ${p.total} vote${p.total === 1 ? '' : 's'}`
      : 'No votes yet — be the first';
    openShareSheet({
      title: 'Share this poll',
      hint: 'The link previews with the poll’s current results.',
      url,
      text: `📊 ${p.question} — ${results}`,
      image: `/og/poll/${p.id}.png`,
      imageName: 'poll-results.png',
    });
  }

  // A share window for any link: the phone's own share sheet (reaches
  // Instagram, Snapchat and every other installed app), copy, and a button for
  // each major platform. `image` (optional) is offered as a download for
  // Instagram / Stories, which have no link-sharing page.
  function openShareSheet({ title, hint, url, text, image, imageName }) {
    const u = encodeURIComponent(url);
    const t = encodeURIComponent(text);
    const both = encodeURIComponent(`${text} ${url}`);
    const abs = image ? new URL(image, location.origin).href : '';
    const targets = [
      ['WhatsApp', 's-wa', `https://wa.me/?text=${both}`],
      ['Facebook', 's-fb', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
      ['X', 's-x', `https://twitter.com/intent/tweet?url=${u}&text=${t}`],
      ['Telegram', 's-tg', `https://t.me/share/url?url=${u}&text=${t}`],
      ['LinkedIn', 's-li', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
      ['Reddit', 's-rd', `https://www.reddit.com/submit?url=${u}&title=${t}`],
      ['Threads', '', `https://www.threads.net/intent/post?text=${both}`],
      ['Bluesky', '', `https://bsky.app/intent/compose?text=${both}`],
      ['Pinterest', 's-pi', `https://pinterest.com/pin/create/button/?url=${u}&description=${t}${abs ? '&media=' + encodeURIComponent(abs) : ''}`],
      ['Tumblr', '', `https://www.tumblr.com/widgets/share/tool?canonicalUrl=${u}&caption=${t}`],
      ['Email', '', `mailto:?subject=${encodeURIComponent(text.slice(0, 120))}&body=${both}`],
      ['SMS', '', `sms:?&body=${both}`],
    ];
    const { card } = openModal(title, `
      <div class="share-sheet">
        ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
        ${image ? `<img class="share-preview" src="${esc(image)}" alt="" />` : ''}
        <div class="share-row">
          <input class="share-input" type="text" readonly value="${esc(url)}" aria-label="Link" />
          <button type="button" class="primary small" data-copy>Copy</button>
        </div>
        <div class="share-actions">
          ${navigator.share ? '<button type="button" class="chip-btn" data-native>📤 More apps…</button>' : ''}
          ${targets.map(([name, cls, href]) => `<a class="chip-btn ${cls}" target="_blank" rel="noopener noreferrer" href="${esc(href)}">${name}</a>`).join('')}
          ${image ? `<a class="chip-btn" href="${esc(image)}" download="${esc(imageName || 'image.png')}">⬇️ Image for Instagram</a>` : ''}
        </div>
      </div>`);
    const copy = card.querySelector('[data-copy]');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); }
      catch (_e) { const i = card.querySelector('.share-input'); i.select(); try { document.execCommand('copy'); } catch (_e2) { /* ignore */ } }
      copy.textContent = 'Copied!';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    const native = card.querySelector('[data-native]');
    if (native) native.addEventListener('click', () => navigator.share({ title, text, url }).catch(() => {}));
  }

  /* ---------- Blogs ----------
     Any member can write a post (rich editor, drafts, cover, category, tags).
     Published posts are shown to everyone here, can be searched / filtered /
     sorted, liked (1 point to the writer per like) and commented on, and are
     listed on the Highway when first published. */
  const blogFilter = { q: '', category: '', tag: '', author: '', sort: 'new', period: '', mine: false };
  let blogMeta = null;

  function blogQuery(offset) {
    const p = new URLSearchParams();
    Object.entries(blogFilter).forEach(([k, v]) => {
      if (k === 'mine') { if (v) p.set('mine', '1'); }
      else if (v) p.set(k, v);
    });
    if (offset) p.set('offset', offset);
    return '/api/blogs?' + p.toString();
  }

  function blogAuthorHtml(b) {
    return `<span class="blog-by"><img class="avatar xs" src="${avatarUrl(b.author.avatar)}" alt="" /><span class="blog-by-name"></span></span>`;
  }

  function blogCardEl(b) {
    const card = el(`
      <article class="tile blog-card${b.cover ? '' : ' no-cover'}" tabindex="0">
        ${b.cover ? `<img class="blog-cover" src="${esc(b.cover)}" loading="lazy" alt="" />` : ''}
        <div class="blog-card-top">
          ${b.category ? `<button type="button" class="blog-cat" data-cat></button>` : ''}
          ${b.status === 'draft' ? '<span class="blog-draft">Draft</span>' : ''}
        </div>
        <h3></h3>
        <p class="blog-excerpt"></p>
        <div class="blog-card-foot">
          ${blogAuthorHtml(b)}
          <span class="hint">${fmtDate(b.publishedAt || b.createdAt)} · ${b.readMinutes} min read</span>
          <span class="blog-stats hint">❤ ${b.likes} · 💬 ${b.comments}</span>
        </div>
      </article>`);
    card.querySelector('h3').textContent = b.title;
    card.querySelector('.blog-excerpt').textContent = b.excerpt || '';
    card.querySelector('.blog-by-name').textContent = b.author.displayName;
    const cat = card.querySelector('[data-cat]');
    if (cat) {
      cat.textContent = b.category;
      cat.addEventListener('click', (e) => { e.stopPropagation(); blogFilter.category = b.category; blogFilter.mine = false; renderBlogs(); });
    }
    if (b.author.username) {
      const by = card.querySelector('.blog-by');
      by.title = 'More posts by ' + b.author.displayName;
      by.addEventListener('click', (e) => { e.stopPropagation(); Object.assign(blogFilter, { author: b.author.username, mine: false }); renderBlogs(); });
    }
    const open = () => (b.status === 'draft' ? openBlogEditor(b.id) : openBlog(b.id));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return card;
  }

  async function renderBlogs() {
    const main = openMainView();
    main.appendChild(sectionShell('Blogs', 'Stories, tips and ideas written by members. Every like earns the writer a point.'));
    const body = main.querySelector('#sectionBody');
    if (!blogMeta) {
      try { blogMeta = await api.get('/api/blogs/meta'); } catch (_e) { blogMeta = { categories: [], tags: [] }; }
    }
    body.innerHTML = '';
    const bar = el(`
      <div class="blog-toolbar">
        <div class="blog-tabs" role="tablist">
          <button type="button" data-tab="all" role="tab">All posts</button>
          <button type="button" data-tab="mine" role="tab">My posts</button>
        </div>
        <button type="button" class="primary blog-write">✍️ Write a post</button>
        <form class="blog-filters" role="search">
          <input type="search" name="q" placeholder="Search posts, writers, tags…" aria-label="Search blog posts" />
          <select name="category" aria-label="Category"><option value="">All categories</option></select>
          <select name="period" aria-label="Published">
            <option value="">Any time</option><option value="week">This week</option>
            <option value="month">This month</option><option value="year">This year</option>
          </select>
          <select name="sort" aria-label="Sort by">
            <option value="new">Newest</option><option value="liked">Most liked</option>
            <option value="commented">Most commented</option><option value="read">Most read</option>
            <option value="old">Oldest</option>
          </select>
        </form>
        <div class="blog-active"></div>
        <div class="blog-tags chip-row"></div>
      </div>`);
    const form = bar.querySelector('.blog-filters');
    blogMeta.categories.forEach((c) => form.category.appendChild(new Option(c, c)));
    form.q.value = blogFilter.q;
    form.category.value = blogFilter.category;
    form.period.value = blogFilter.period;
    form.sort.value = blogFilter.sort;
    bar.querySelectorAll('[data-tab]').forEach((t) => {
      const on = (t.dataset.tab === 'mine') === blogFilter.mine;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.addEventListener('click', () => { blogFilter.mine = t.dataset.tab === 'mine'; renderBlogs(); });
    });
    bar.querySelector('.blog-write').addEventListener('click', () => openBlogEditor(null));
    let typing = null;
    const apply = () => {
      Object.assign(blogFilter, { q: form.q.value.trim(), category: form.category.value, period: form.period.value, sort: form.sort.value });
      loadList(true);
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
    form.q.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(apply, 350); });
    ['category', 'period', 'sort'].forEach((n) => form[n].addEventListener('change', apply));

    const tags = bar.querySelector('.blog-tags');
    blogMeta.tags.forEach((t) => {
      const chip = el('<button type="button" class="chip"></button>');
      chip.textContent = '#' + t;
      chip.classList.toggle('on', blogFilter.tag.toLowerCase() === t.toLowerCase());
      chip.addEventListener('click', () => { blogFilter.tag = blogFilter.tag.toLowerCase() === t.toLowerCase() ? '' : t; renderBlogs(); });
      tags.appendChild(chip);
    });

    // "Showing: posts by X · #tag" with ✕ to clear each.
    const active = bar.querySelector('.blog-active');
    const pills = [];
    if (blogFilter.author) pills.push(['author', 'Writer: @' + blogFilter.author]);
    if (blogFilter.tag) pills.push(['tag', '#' + blogFilter.tag]);
    pills.forEach(([key, label]) => {
      const p = el('<button type="button" class="chip on"></button>');
      p.textContent = label + ' ✕';
      p.addEventListener('click', () => { blogFilter[key] = ''; renderBlogs(); });
      active.appendChild(p);
    });

    body.appendChild(bar);
    const grid = el('<div class="card-grid blog-grid"></div>');
    const more = el('<button type="button" class="ghost blog-more hidden">Load more</button>');
    body.appendChild(grid);
    body.appendChild(more);
    let next = 0;
    let seq = 0;
    async function loadList(reset) {
      const mySeq = ++seq;
      if (reset) { next = 0; grid.innerHTML = '<div class="empty-main">Loading…</div>'; }
      let data;
      try { data = await api.get(blogQuery(next)); }
      catch (e) { grid.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
      if (mySeq !== seq) return; // a newer search has started
      if (reset) grid.innerHTML = '';
      data.blogs.forEach((b) => grid.appendChild(blogCardEl(b)));
      if (!grid.children.length) {
        const filtered = blogFilter.q || blogFilter.category || blogFilter.tag || blogFilter.author || blogFilter.period;
        grid.innerHTML = `<div class="empty-main">${blogFilter.mine
          ? 'You haven’t written anything yet. Tap “Write a post” to start.'
          : filtered ? 'No posts match. Try other words or clear a filter.' : 'No posts yet. Be the first to write one!'}</div>`;
      }
      next = data.nextOffset;
      more.classList.toggle('hidden', !data.more);
    }
    more.addEventListener('click', () => loadList(false));
    loadList(true);
    decorateSectionWithAds(main);
  }

  // The body of a post: member posts are HTML (cleaned on the server with an
  // allowlist); older admin posts are plain text.
  function fillBlogBody(target, blog) {
    if (blog.format === 'html') {
      target.innerHTML = blog.body;
      target.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow ugc'; });
      target.querySelectorAll('img').forEach((img) => {
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(img.src));
      });
    } else {
      appendRichText(target, blog.body);
    }
  }

  async function openBlog(id) {
    const main = openMainView();
    main.appendChild(sectionShell('Blog', ''));
    const body = main.querySelector('#sectionBody');
    let blog;
    try { blog = (await api.get('/api/blogs/' + id)).blog; }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    main.querySelector('.section-head').remove();
    body.innerHTML = '';
    const article = el(`
      <article class="card blog-full">
        <button class="ghost small blog-back" type="button">← All posts</button>
        ${blog.cover ? `<img class="blog-cover-full" src="${esc(blog.cover)}" alt="" />` : ''}
        <div class="blog-card-top">
          ${blog.category ? '<button type="button" class="blog-cat" data-cat></button>' : ''}
          ${blog.status === 'draft' ? '<span class="blog-draft">Draft — only you can see this</span>' : ''}
        </div>
        <h1 class="blog-title"></h1>
        ${blog.excerpt ? '<p class="blog-lede"></p>' : ''}
        <div class="blog-meta">
          ${blogAuthorHtml(blog)}
          <span class="hint">${fmtDate(blog.publishedAt || blog.createdAt)} · ${blog.readMinutes} min read · ${blog.views} read${blog.views === 1 ? '' : 's'}${blog.updatedAt && blog.publishedAt && blog.updatedAt - blog.publishedAt > 60000 ? ' · edited' : ''}</span>
          <span class="blog-own"></span>
        </div>
        <div class="blog-body"></div>
        <div class="blog-tags chip-row"></div>
        <div class="blog-actions">
          <button type="button" class="blog-like"></button>
          <button type="button" class="ghost small blog-share">🔗 Copy link</button>
        </div>
        <section class="blog-comments">
          <h3>Comments</h3>
          <form class="blog-comment-form">
            <textarea maxlength="1000" rows="2" placeholder="Write a comment…" aria-label="Write a comment" dir="auto"></textarea>
            <button class="primary small" type="submit">Comment</button>
          </form>
          <div class="blog-comment-list"></div>
        </section>
      </article>`);
    article.querySelector('.blog-title').textContent = blog.title;
    if (blog.excerpt) article.querySelector('.blog-lede').textContent = blog.excerpt;
    article.querySelector('.blog-by-name').textContent = blog.author.displayName;
    if (blog.author.username) {
      article.querySelector('.blog-by').addEventListener('click', () => showProfile(blog.author.username));
      article.querySelector('.blog-by').title = 'View profile';
    }
    article.querySelector('.blog-back').addEventListener('click', renderBlogs);
    const cat = article.querySelector('[data-cat]');
    if (cat) {
      cat.textContent = blog.category;
      cat.addEventListener('click', () => { Object.assign(blogFilter, { category: blog.category, mine: false }); renderBlogs(); });
    }
    fillBlogBody(article.querySelector('.blog-body'), blog);
    const tagRow = article.querySelector('.blog-tags');
    blog.tags.forEach((t) => {
      const chip = el('<button type="button" class="chip"></button>');
      chip.textContent = '#' + t;
      chip.addEventListener('click', () => { Object.assign(blogFilter, { tag: t, mine: false }); renderBlogs(); });
      tagRow.appendChild(chip);
    });

    if (blog.mine) {
      const own = article.querySelector('.blog-own');
      const edit = el('<button type="button" class="ghost small">✏️ Edit</button>');
      const del = el('<button type="button" class="ghost small">Delete</button>');
      edit.addEventListener('click', () => openBlogEditor(blog.id));
      del.addEventListener('click', async () => {
        if (!(await confirmBox('Delete this post? Its likes, comments and Highway listing go too.', 'Delete'))) return;
        try { await api.del('/api/blogs/' + blog.id); notifyToast('Post deleted.'); renderBlogs(); }
        catch (e) { alert(e.message); }
      });
      own.append(edit, del);
    }

    const likeBtn = article.querySelector('.blog-like');
    const paintLike = () => {
      likeBtn.className = 'blog-like' + (blog.liked ? ' on' : '');
      likeBtn.textContent = `${blog.liked ? '❤️' : '🤍'} ${blog.likes} like${blog.likes === 1 ? '' : 's'}`;
      likeBtn.title = blog.mine ? 'Likes on your post (each one is a point for you)' : blog.liked ? 'Unlike' : 'Like — gives the writer 1 point';
      likeBtn.disabled = blog.mine || blog.status !== 'published';
    };
    paintLike();
    likeBtn.addEventListener('click', async () => {
      likeBtn.disabled = true;
      try { const r = await api.post('/api/blogs/' + blog.id + '/like', {}); blog.liked = r.liked; blog.likes = r.likes; }
      catch (e) { alert(e.message); }
      paintLike();
    });
    article.querySelector('.blog-share').addEventListener('click', async () => {
      const url = location.origin + '/blog/' + blog.id;
      try { await navigator.clipboard.writeText(url); notifyToast('Link copied.'); }
      catch (_e) { promptBox('Link to this post', '', url); }
    });

    // Comments (one level of replies).
    const list = article.querySelector('.blog-comment-list');
    const form = article.querySelector('.blog-comment-form');
    if (blog.status !== 'published') form.remove();
    const paintComments = (comments) => {
      list.innerHTML = '';
      if (!comments.length) { list.innerHTML = '<p class="hint">No comments yet. Start the conversation.</p>'; return; }
      const one = (c, isReply) => {
        const item = el(`
          <div class="comment${isReply ? ' is-reply' : ''}">
            <img class="avatar sm" src="${avatarUrl(c.author.avatar)}" alt="" />
            <div class="c-body">
              <div class="c-head"><b class="c-author"></b> <span class="hint">${fmtDate(c.at)} · ${fmtTime(c.at)}</span></div>
              <div class="c-text"></div>
              <div class="c-actions"></div>
              ${isReply ? '' : '<div class="c-replies"></div>'}
            </div>
          </div>`);
        item.querySelector('.c-author').textContent = c.author.displayName;
        item.querySelector('.c-author').addEventListener('click', () => showProfile(c.author.username));
        appendRichText(item.querySelector('.c-text'), c.body);
        const actions = item.querySelector('.c-actions');
        if (!isReply && form.isConnected) {
          const reply = el('<button type="button" class="link-btn">Reply</button>');
          reply.addEventListener('click', () => {
            if (item.querySelector('.blog-reply-form')) return;
            const rf = el(`<form class="blog-comment-form blog-reply-form"><textarea maxlength="1000" rows="1" placeholder="Write a reply…" dir="auto"></textarea><button class="primary small" type="submit">Reply</button></form>`);
            rf.addEventListener('submit', (e) => { e.preventDefault(); send(rf, c.id); });
            item.querySelector('.c-replies').appendChild(rf);
            rf.querySelector('textarea').focus();
          });
          actions.appendChild(reply);
        }
        if (c.canDelete) {
          const del = el('<button type="button" class="link-btn">Delete</button>');
          del.addEventListener('click', async () => {
            if (!(await confirmBox('Delete this comment?', 'Delete'))) return;
            try { paintComments((await api.del('/api/blogs/comments/' + c.id)).comments); } catch (e) { alert(e.message); }
          });
          actions.appendChild(del);
        }
        if (!isReply) c.replies.forEach((r) => item.querySelector('.c-replies').appendChild(one(r, true)));
        return item;
      };
      comments.forEach((c) => list.appendChild(one(c, false)));
    };
    async function send(f, parentId) {
      const ta = f.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return;
      f.querySelector('button').disabled = true;
      try {
        paintComments((await api.post('/api/blogs/' + blog.id + '/comments', { body: text, parentId })).comments);
        ta.value = '';
      } catch (e) { alert(e.message); }
      f.querySelector('button').disabled = false;
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); send(form, null); });
    body.appendChild(article);
    api.get('/api/blogs/' + blog.id + '/comments').then((r) => paintComments(r.comments)).catch(() => {});
  }

  /* ---------- Blog editor ----------
     A contenteditable editor with a formatting toolbar. Whatever it produces
     is cleaned again on the server, so the toolbar is a convenience, not a
     security boundary. New posts keep an unsaved copy in this browser. */
  const BLOG_DRAFT_KEY = 'gx-blog-unsaved';

  async function openBlogEditor(id) {
    const main = openMainView();
    main.appendChild(sectionShell(id ? 'Edit post' : 'Write a post', 'Write it your way: headings, lists, quotes, pictures, videos and links. Save a draft any time.'));
    const body = main.querySelector('#sectionBody');
    if (!blogMeta) {
      try { blogMeta = await api.get('/api/blogs/meta'); } catch (_e) { blogMeta = { categories: ['Other'], tags: [] }; }
    }
    let blog = null;
    if (id) {
      try { blog = (await api.get('/api/blogs/' + id)).blog; }
      catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    }
    body.innerHTML = '';
    const wrap = el(`
      <div class="blog-editor card">
        <div class="be-cover">
          <img class="be-cover-img hidden" alt="" />
          <div class="be-cover-actions">
            <label class="ghost small be-btn">🖼️ <span class="be-cover-label">Add a cover picture</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden /></label>
            <button type="button" class="ghost small be-cover-remove hidden">Remove cover</button>
          </div>
        </div>
        <input class="be-title" type="text" maxlength="150" placeholder="Title" aria-label="Title" dir="auto" />
        <textarea class="be-excerpt" maxlength="300" rows="2" placeholder="A short summary (shown in the list and on the Highway)" aria-label="Summary" dir="auto"></textarea>
        <div class="be-row">
          <label>Category <select class="be-category"></select></label>
          <label class="be-tags-label">Tags <input class="be-tags" type="text" placeholder="e.g. travel, india, food (up to 8)" /></label>
        </div>
        <div class="be-toolbar" role="toolbar" aria-label="Formatting">
          <select data-block aria-label="Text style">
            <option value="p">Paragraph</option><option value="h2">Heading</option>
            <option value="h3">Subheading</option><option value="h4">Small heading</option>
            <option value="blockquote">Quote</option><option value="pre">Code</option>
          </select>
          <span class="be-sep"></span>
          <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <button type="button" data-cmd="superscript" title="Superscript">x²</button>
          <button type="button" data-cmd="subscript" title="Subscript">x₂</button>
          <label class="be-color" title="Text colour">A<input type="color" data-color="foreColor" value="#8c2f39" /></label>
          <label class="be-color be-mark" title="Highlight">🖍<input type="color" data-color="hiliteColor" value="#fff3a3" /></label>
          <span class="be-sep"></span>
          <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>
          <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
          <button type="button" data-cmd="outdent" title="Outdent list item">⇤</button>
          <button type="button" data-cmd="indent" title="Indent list item">⇥</button>
          <span class="be-sep"></span>
          <button type="button" data-cmd="justifyLeft" title="Align left">⯇</button>
          <button type="button" data-cmd="justifyCenter" title="Centre">≡</button>
          <button type="button" data-cmd="justifyRight" title="Align right">⯈</button>
          <button type="button" data-cmd="justifyFull" title="Justify">☰</button>
          <span class="be-sep"></span>
          <button type="button" data-act="link" title="Add a link (Ctrl+K)">🔗</button>
          <button type="button" data-cmd="unlink" title="Remove link">⛓️‍💥</button>
          <label class="be-btn" title="Insert pictures">🖼️<input type="file" data-act="image" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden /></label>
          <button type="button" data-act="video" title="Embed a YouTube video">▶️</button>
          <button type="button" data-act="table" title="Insert a table">▦</button>
          <button type="button" data-cmd="insertHorizontalRule" title="Divider">―</button>
          <span class="be-sep"></span>
          <button type="button" data-cmd="removeFormat" title="Clear formatting">⌫ Format</button>
          <button type="button" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button type="button" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
        </div>
        <div class="be-body blog-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Your post" data-placeholder="Tell your story…" dir="auto"></div>
        <div class="be-preview blog-body hidden"></div>
        <div class="be-foot">
          <span class="hint be-count"></span>
          <span class="hint be-saved"></span>
          <span class="be-spacer"></span>
          <button type="button" class="ghost be-cancel">Cancel</button>
          <button type="button" class="ghost be-preview-btn">👁 Preview</button>
          <button type="button" class="ghost be-draft">Save draft</button>
          <button type="button" class="primary be-publish"></button>
        </div>
      </div>`);
    const $ = (s) => wrap.querySelector(s);
    const title = $('.be-title');
    const excerpt = $('.be-excerpt');
    const category = $('.be-category');
    const tags = $('.be-tags');
    const editor = $('.be-body');
    const preview = $('.be-preview');
    blogMeta.categories.forEach((c) => category.appendChild(new Option(c, c)));
    $('.be-publish').textContent = blog && blog.status === 'published' ? 'Update post' : 'Publish';
    if (blog && blog.status === 'published') $('.be-draft').textContent = 'Unpublish to draft';

    // Cover picture.
    let coverFile = null;
    let removeCover = false;
    const coverImg = $('.be-cover-img');
    const showCover = (src) => {
      coverImg.classList.toggle('hidden', !src);
      if (src) coverImg.src = src;
      $('.be-cover-remove').classList.toggle('hidden', !src);
      $('.be-cover-label').textContent = src ? 'Change cover' : 'Add a cover picture';
    };
    $('.be-cover input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      coverFile = f; removeCover = false;
      showCover(URL.createObjectURL(f));
    });
    $('.be-cover-remove').addEventListener('click', () => { coverFile = null; removeCover = true; showCover(null); });

    // Fill from the saved post, or from an unsaved copy of a new one.
    let unsaved = null;
    if (!blog) { try { unsaved = JSON.parse(localStorage.getItem(BLOG_DRAFT_KEY) || 'null'); } catch (_e) { unsaved = null; } }
    const src = blog || unsaved || {};
    title.value = src.title || '';
    excerpt.value = blog ? (blog.excerpt || '') : (src.excerpt || '');
    category.value = src.category || 'Other';
    tags.value = (src.tags || []).join(', ');
    if (blog) {
      if (blog.format === 'html') editor.innerHTML = blog.body;
      else editor.innerText = blog.body;
    } else if (unsaved && unsaved.body) {
      editor.innerHTML = unsaved.body;
      $('.be-saved').textContent = 'Restored your unsaved post.';
    }
    if (blog && blog.cover) showCover(blog.cover);

    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_e) { /* older browsers */ }

    // Keep the caret's place so toolbar dialogs can insert where it was.
    let savedRange = null;
    const saveRange = () => {
      const sel = window.getSelection();
      if (sel.rangeCount && editor.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
    };
    const restoreRange = () => {
      editor.focus();
      if (!savedRange) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    };
    editor.addEventListener('keyup', saveRange);
    editor.addEventListener('mouseup', saveRange);
    editor.addEventListener('blur', saveRange);
    const exec = (cmd, val) => {
      restoreRange();
      // Colours as inline style; everything else as plain tags (<strong>, <em>…),
      // which is what the server keeps.
      try { document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor'); } catch (_e) { /* older browsers */ }
      document.execCommand(cmd, false, val == null ? null : val);
      saveRange();
      changed();
    };
    const insertHtml = (html) => exec('insertHTML', html);

    // Word count, reading time and the browser-side unsaved copy.
    let saveTimer = null;
    const changed = () => {
      const words = (editor.innerText.match(/\S+/g) || []).length;
      $('.be-count').textContent = `${words} word${words === 1 ? '' : 's'} · ${Math.max(1, Math.round(words / 200))} min read`;
      editor.classList.toggle('empty', !editor.textContent.trim() && !editor.querySelector('img,iframe'));
      if (blog) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(BLOG_DRAFT_KEY, JSON.stringify({
            title: title.value, excerpt: excerpt.value, category: category.value,
            tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), body: editor.innerHTML,
          }));
          $('.be-saved').textContent = 'Saved in this browser.';
        } catch (_e) { /* storage unavailable */ }
      }, 600);
    };
    [title, excerpt, tags].forEach((i) => i.addEventListener('input', changed));
    category.addEventListener('change', changed);
    editor.addEventListener('input', changed);
    changed();

    // Toolbar.
    const toolbar = $('.be-toolbar');
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the selection
    toolbar.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => exec(b.dataset.cmd)));
    // Text style (paragraph, headings, quote, code). Done by hand rather than
    // with formatBlock, which browsers handle inconsistently: quotes nest or
    // can't be undone, and turning a block back into a paragraph often fails.
    const blockSelect = toolbar.querySelector('[data-block]');
    const TEXT_BLOCKS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV'];
    const topBlock = (node) => {
      while (node && node.parentNode !== editor) node = node.parentNode;
      return node && editor.contains(node) ? node : null;
    };
    // Loose text and inline tags sitting straight in the editor get a <p>.
    const wrapLoose = () => {
      let run = null;
      [...editor.childNodes].forEach((n) => {
        const inline = n.nodeType === 3 || (n.nodeType === 1 && !/^(P|H\d|BLOCKQUOTE|PRE|DIV|UL|OL|TABLE|FIGURE|IFRAME|HR)$/.test(n.nodeName));
        if (!inline) { run = null; return; }
        if (n.nodeType === 3 && !n.textContent.trim() && !run) return;
        if (!run) { run = document.createElement('p'); editor.insertBefore(run, n); }
        run.appendChild(n);
      });
    };
    const currentBlocks = () => {
      restoreRange();
      wrapLoose();
      const sel = window.getSelection();
      if (!sel.rangeCount) return [];
      const r = sel.getRangeAt(0);
      // A range can sit on the editor itself (e.g. after Select all).
      const first = r.startContainer === editor ? editor.childNodes[r.startOffset] || editor.lastChild : topBlock(r.startContainer);
      const last = r.endContainer === editor ? editor.childNodes[Math.max(0, r.endOffset - 1)] : topBlock(r.endContainer);
      if (!first) return [];
      const out = [];
      for (let n = first; n; n = n.nextSibling) { if (n.nodeType === 1) out.push(n); if (n === last) break; }
      return out;
    };
    const setBlock = (tag) => {
      const blocks = currentBlocks().filter((b) => TEXT_BLOCKS.includes(b.nodeName));
      if (!blocks.length) return;
      const sel = window.getSelection();
      const r = sel.getRangeAt(0);
      const marks = [r.startContainer, r.startOffset, r.endContainer, r.endOffset];
      const made = [];
      blocks.forEach((b) => {
        // A quote or box holding several paragraphs: each becomes its own block.
        const inner = [...b.children].some((c) => TEXT_BLOCKS.includes(c.nodeName))
          ? [...b.childNodes] : [b];
        if (inner[0] !== b) { inner.forEach((c) => editor.insertBefore(c, b)); b.remove(); }
        inner.forEach((old) => {
          if (old.nodeType !== 1) { if (old.textContent.trim()) { const p = document.createElement(tag); editor.insertBefore(p, old); p.appendChild(old); made.push(p); } else old.remove(); return; }
          if (old.nodeName.toLowerCase() === tag) { made.push(old); return; }
          const fresh = document.createElement(tag);
          if (old.style.textAlign) fresh.style.textAlign = old.style.textAlign;
          while (old.firstChild) fresh.appendChild(old.firstChild);
          if (!fresh.firstChild) fresh.appendChild(document.createElement('br'));
          old.replaceWith(fresh);
          made.push(fresh);
        });
      });
      // The text nodes moved but were not replaced, so the caret can go back
      // (a range on the editor itself is now stale, so it covers the new blocks).
      try {
        const nr = document.createRange();
        if (marks[0] === editor) nr.setStartBefore(made[0]); else nr.setStart(marks[0], marks[1]);
        if (marks[2] === editor) nr.setEndAfter(made[made.length - 1]); else nr.setEnd(marks[2], marks[3]);
        sel.removeAllRanges();
        sel.addRange(nr);
      } catch (_e) { /* caret was on a removed element */ }
      saveRange();
      changed();
      syncBlockSelect();
    };
    // Show the style of the block the caret is in, so picking "Paragraph"
    // on a heading or quote is a real change.
    const syncBlockSelect = () => {
      const sel = window.getSelection();
      if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
      const b = topBlock(sel.anchorNode);
      const tag = b && b.nodeType === 1 ? b.nodeName.toLowerCase() : 'p';
      blockSelect.value = [...blockSelect.options].some((o) => o.value === tag) ? tag : 'p';
    };
    blockSelect.addEventListener('change', () => setBlock(blockSelect.value));
    const onSelChange = () => {
      if (!editor.isConnected) { document.removeEventListener('selectionchange', onSelChange); return; }
      syncBlockSelect();
    };
    document.addEventListener('selectionchange', onSelChange);
    // Enter at the end of a heading or quote, or on an empty last line of
    // code, carries on in a normal paragraph. Shift+Enter stays in the block.
    editor.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const sel = window.getSelection();
      if (!sel.rangeCount || !sel.isCollapsed) return;
      const b = topBlock(sel.anchorNode);
      if (!b || b.nodeType !== 1 || !/^(H\d|BLOCKQUOTE|PRE)$/.test(b.nodeName)) return;
      const after = document.createRange();
      after.setStart(sel.anchorNode, sel.anchorOffset);
      after.setEnd(b, b.childNodes.length);
      const atEnd = !after.toString().replace(/​/g, '').length && !after.cloneContents().querySelector('img,iframe');
      if (b.nodeName === 'PRE') {
        e.preventDefault();
        // Enter on an empty last line leaves the code box; otherwise a new line.
        const lastLineEmpty = atEnd && (b.innerText.endsWith('\n\n') || !b.innerText.trim());
        if (!lastLineEmpty) { document.execCommand('insertLineBreak'); changed(); return; }
        while (b.lastChild && b.lastChild.nodeName === 'BR' && b.childNodes.length > 1) b.lastChild.remove();
      } else if (!atEnd) {
        return; // let the browser split it
      }
      e.preventDefault();
      if (b.nodeName === 'BLOCKQUOTE' && !b.textContent.trim() && !b.querySelector('img,iframe')) {
        // Enter on an empty quote line turns it into a paragraph.
        setBlock('p');
        return;
      }
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      b.after(p);
      sel.collapse(p, 0);
      saveRange();
      changed();
    });
    toolbar.querySelectorAll('[data-color]').forEach((inp) => {
      inp.addEventListener('input', () => exec(inp.dataset.color, inp.value));
    });
    toolbar.querySelector('[data-act="link"]').addEventListener('click', addLink);
    async function addLink() {
      saveRange();
      const url = await promptBox('Add a link', 'Web address (https://…)', 'https://');
      if (!url || url === 'https://') return;
      const href = /^(https?:|mailto:)/i.test(url) ? url : 'https://' + url;
      const sel = savedRange && !savedRange.collapsed;
      if (sel) exec('createLink', href);
      else insertHtml(`<a href="${esc(href)}">${esc(url)}</a>&nbsp;`);
    }
    toolbar.querySelector('[data-act="video"]').addEventListener('click', async () => {
      saveRange();
      const url = await promptBox('Embed a YouTube video', 'Paste the YouTube link', '');
      if (!url) return;
      const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{6,20})/);
      if (!m) return alert('That doesn’t look like a YouTube link.');
      insertHtml(`<iframe src="https://www.youtube-nocookie.com/embed/${m[1]}" title="YouTube video" allowfullscreen></iframe><p><br></p>`);
    });
    toolbar.querySelector('[data-act="table"]').addEventListener('click', () => {
      const cell = '<td><br></td>';
      const row = `<tr>${cell.repeat(3)}</tr>`;
      insertHtml(`<table><thead><tr><th>Heading</th><th>Heading</th><th>Heading</th></tr></thead><tbody>${row}${row}</tbody></table><p><br></p>`);
    });

    // Pictures: chosen from the toolbar, pasted or dropped. Each is uploaded
    // (and checked) first, then placed at the caret.
    async function uploadImages(files) {
      for (const f of files) {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) { alert('Pictures must be JPG, PNG, WEBP or GIF.'); continue; }
        $('.be-saved').textContent = 'Uploading picture…';
        try {
          const fd = new FormData();
          fd.append('image', f);
          const r = await api.postForm('/api/blogs/images', fd);
          insertHtml(`<figure><img src="${esc(r.url)}" alt="" /><figcaption>Caption (optional)</figcaption></figure><p><br></p>`);
          $('.be-saved').textContent = '';
        } catch (e) { $('.be-saved').textContent = ''; alert(e.message); }
      }
    }
    toolbar.querySelector('[data-act="image"]').addEventListener('change', (e) => { saveRange(); uploadImages([...e.target.files]); e.target.value = ''; });
    editor.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData && e.clipboardData.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); saveRange(); uploadImages(files); }
    });
    editor.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      if (document.caretRangeFromPoint) savedRange = document.caretRangeFromPoint(e.clientX, e.clientY);
      uploadImages(files);
    });
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); addLink(); }
    });

    // Preview, save, publish.
    $('.be-preview-btn').addEventListener('click', () => {
      const showing = !preview.classList.contains('hidden');
      if (!showing) { preview.innerHTML = ''; fillBlogBody(preview, { format: 'html', body: editor.innerHTML }); }
      preview.classList.toggle('hidden', showing);
      editor.classList.toggle('hidden', !showing);
      toolbar.classList.toggle('hidden', !showing);
      $('.be-preview-btn').textContent = showing ? '👁 Preview' : '✏️ Keep writing';
    });
    $('.be-cancel').addEventListener('click', () => (blog && blog.status === 'published' ? openBlog(blog.id) : renderBlogs()));
    const save = async (status) => {
      const fd = new FormData();
      fd.append('title', title.value);
      fd.append('excerpt', excerpt.value);
      fd.append('category', category.value);
      fd.append('tags', JSON.stringify(tags.value.split(',').map((t) => t.trim()).filter(Boolean)));
      fd.append('body', editor.innerHTML);
      fd.append('status', status);
      if (coverFile) fd.append('cover', coverFile);
      if (removeCover) fd.append('removeCover', '1');
      const buttons = wrap.querySelectorAll('.be-foot button');
      buttons.forEach((b) => { b.disabled = true; });
      try {
        const r = blog ? await api.putForm('/api/blogs/' + blog.id, fd) : await api.postForm('/api/blogs', fd);
        try { localStorage.removeItem(BLOG_DRAFT_KEY); } catch (_e) { /* ignore */ }
        blogMeta = null; // categories/tags may have changed
        if (status === 'draft') {
          notifyToast('Draft saved. Only you can see it.');
          blog = r.blog;
          $('.be-saved').textContent = 'Draft saved.';
          buttons.forEach((b) => { b.disabled = false; });
          return;
        }
        notifyToast(blog && blog.publishedAt ? 'Post updated.' : 'Published! It’s in Blogs and on the Highway.');
        openBlog(r.blog.id);
      } catch (e) {
        buttons.forEach((b) => { b.disabled = false; });
        alert(e.message);
      }
    };
    $('.be-draft').addEventListener('click', () => save('draft'));
    $('.be-publish').addEventListener('click', () => save('published'));
    body.appendChild(wrap);
    (title.value ? editor : title).focus();
  }

  /* ---------- Suggestions ----------
     Send the admin an idea or report a problem. The admin sees who sent it,
     can set a status and reply; both show up here. */
  const SUGGESTION_STATUS = {
    new: ['Sent', 'sg-new'],
    reviewing: ['Being reviewed', 'sg-reviewing'],
    planned: ['Planned', 'sg-planned'],
    done: ['Done', 'sg-done'],
    declined: ['Not planned', 'sg-declined'],
  };

  async function renderSuggestions() {
    const main = openMainView();
    main.appendChild(sectionShell('Suggestions', 'Tell the getxmatch team how to make it better. The admin reads every suggestion and can reply here.'));
    const body = main.querySelector('#sectionBody');
    let data;
    try { data = await api.get('/api/suggestions'); }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    body.innerHTML = '';
    const form = el(`
      <form class="card suggestion-form">
        <label>What is it about?
          <select name="category"></select>
        </label>
        <label>Your suggestion
          <textarea name="body" rows="5" maxlength="${data.max}" placeholder="Describe your idea, what could be better, or a problem you ran into…" dir="auto" required></textarea>
        </label>
        <div class="suggestion-foot">
          <span class="hint sg-count">0 / ${data.max}</span>
          <button class="primary" type="submit">Send to admin</button>
        </div>
        <p class="hint">The admin will see your name and username with your suggestion.</p>
      </form>`);
    data.categories.forEach((c) => form.category.appendChild(new Option(c, c)));
    const count = form.querySelector('.sg-count');
    form.body.addEventListener('input', () => { count.textContent = `${form.body.value.length} / ${data.max}`; });
    const list = el('<div class="suggestion-list"></div>');
    const paint = () => {
      list.innerHTML = data.suggestions.length ? '<h3>Your suggestions</h3>' : '';
      data.suggestions.forEach((sg) => {
        const [label, cls] = SUGGESTION_STATUS[sg.status] || SUGGESTION_STATUS.new;
        const item = el(`
          <div class="card suggestion-item">
            <div class="suggestion-meta">
              <span class="pill">${esc(sg.category)}</span>
              <span class="sg-status ${cls}">${esc(label)}</span>
              <span class="hint">${fmtDate(sg.createdAt)} · ${fmtTime(sg.createdAt)}</span>
            </div>
            <p class="suggestion-body"></p>
            ${sg.reply ? '<div class="suggestion-reply"><b>Reply from the admin</b><p></p></div>' : ''}
          </div>`);
        item.querySelector('.suggestion-body').textContent = sg.body;
        if (sg.reply) item.querySelector('.suggestion-reply p').textContent = sg.reply;
        list.appendChild(item);
      });
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await api.post('/api/suggestions', { category: form.category.value, body: form.body.value });
        data.suggestions.unshift(r.suggestion);
        form.body.value = '';
        count.textContent = `0 / ${data.max}`;
        paint();
        notifyToast('Thanks! Your suggestion was sent to the admin.');
      } catch (err) { alert(err.message); }
      btn.disabled = false;
    });
    body.appendChild(form);
    body.appendChild(list);
    paint();
  }

  /* ---------- Account settings ----------
     Email, password, parent controls (under 18), download my data and delete
     account (src/routes/account.js). */
  async function renderAccount() {
    const main = openMainView();
    main.appendChild(sectionShell('Account settings', 'Your login details, your data and your account.'));
    const body = main.querySelector('#sectionBody');
    let acc;
    try { acc = await api.get('/api/account'); }
    catch (e) { body.innerHTML = `<div class="empty-main">${esc(e.message)}</div>`; return; }
    body.innerHTML = '';
    const wrap = el('<div class="account-view"></div>');
    body.appendChild(wrap);
    const showMsg = (box, text, ok) => { box.textContent = text; box.className = ok ? 'msg ok' : 'msg error'; };
    const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

    /* --- Email --- */
    const emailCard = el(`
      <section class="card account-card">
        <h3 class="card-title">✉️ Email address</h3>
        <p>${acc.email ? `Your email is <b>${esc(acc.email)}</b>.` : 'Your account has no email address yet. Add one so you can reset your password if you forget it.'}</p>
        <form class="account-form" data-step="start">
          <label>New email address<input name="email" type="email" autocomplete="email" required /></label>
          <label>Your password<input name="password" type="password" autocomplete="current-password" required /></label>
          <div><button class="primary" type="submit">${acc.email ? 'Change email' : 'Add email'}</button></div>
        </form>
        <form class="account-form" data-step="verify" hidden>
          <p class="hint acc-pending"></p>
          <label>Code from the email<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required /></label>
          <div class="account-actions"><button class="primary" type="submit">Confirm new email</button>
            <button class="ghost" type="button" data-cancel>Cancel</button></div>
        </form>
        <div class="msg"></div>
      </section>`);
    const [eStart, eVerify] = emailCard.querySelectorAll('form');
    const eMsg = emailCard.querySelector('.msg');
    const showVerify = (addr) => {
      eStart.hidden = true;
      eVerify.hidden = false;
      eVerify.querySelector('.acc-pending').textContent = `We emailed a 6-digit code to ${addr}. Enter it here to finish the change.`;
    };
    if (acc.pendingEmail) showVerify(acc.pendingEmail);
    eStart.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(eStart.querySelector('button'), async () => {
        try {
          const r = await api.post('/api/account/email/start', { email: eStart.email.value, password: eStart.password.value });
          eStart.reset();
          eMsg.className = 'msg';
          showVerify(r.pendingEmail);
        } catch (err) { showMsg(eMsg, err.message); }
      });
    });
    eVerify.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(eVerify.querySelector('button'), async () => {
        try {
          const r = await api.post('/api/account/email/verify', { code: eVerify.code.value });
          if (state.me) state.me.email = r.email;
          notifyToast('Your email address was changed.');
          renderAccount();
        } catch (err) { showMsg(eMsg, err.message); }
      });
    });
    eVerify.querySelector('[data-cancel]').addEventListener('click', async () => {
      try { await api.del('/api/account/email/pending'); } catch (_e) { /* ignore */ }
      eVerify.hidden = true;
      eStart.hidden = false;
      eMsg.className = 'msg';
    });
    wrap.appendChild(emailCard);

    /* --- Password --- */
    const pwCard = el(`
      <section class="card account-card">
        <h3 class="card-title">🔑 Password</h3>
        <form class="account-form">
          <label>Current password<input name="current" type="password" autocomplete="current-password" required /></label>
          <label>New password<input name="next" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required /></label>
          <label>Repeat new password<input name="next2" type="password" autocomplete="new-password" minlength="8" required /></label>
          <p class="hint">Changing your password signs you out on every other device.</p>
          <div><button class="primary" type="submit">Change password</button></div>
        </form>
        <div class="msg"></div>
      </section>`);
    const pwForm = pwCard.querySelector('form');
    const pwMsg = pwCard.querySelector('.msg');
    pwForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (pwForm.next.value !== pwForm.next2.value) return showMsg(pwMsg, 'The two new passwords are different.');
      busy(pwForm.querySelector('button'), async () => {
        try {
          await api.put('/api/account/password', { currentPassword: pwForm.current.value, newPassword: pwForm.next.value });
          pwForm.reset();
          showMsg(pwMsg, 'Your password was changed. Other devices have been signed out.', true);
        } catch (err) { showMsg(pwMsg, err.message); }
      });
    });
    wrap.appendChild(pwCard);

    /* --- Parent controls (members under 18) --- */
    if (acc.isMinor || acc.guardian) wrap.appendChild(guardianCard(acc.guardian, showMsg, busy));

    /* --- Download my data --- */
    wrap.appendChild(el(`
      <section class="card account-card">
        <h3 class="card-title">📦 Download my data</h3>
        <p>Get a .zip file with your account and profile details, points, friends, messages, posts, blogs, quiz and poll activity, plus your photos, reels and voice notes.</p>
        <div><a class="button-link" href="/api/account/export" download>⬇ Download my data</a></div>
        <p class="hint">Files shared in chats are never stored on getxmatch, so they can't be included.</p>
      </section>`));

    /* --- Delete account --- */
    const delCard = el(`
      <section class="card account-card account-danger">
        <h3 class="card-title">🗑️ Delete my account</h3>
        <p>This permanently deletes your profile, photos, reels, posts, blogs, messages, friends and points. It can't be undone. You may want to download your data first.</p>
        <form class="account-form">
          <label>Your password<input name="password" type="password" autocomplete="current-password" required /></label>
          <label>Type DELETE to confirm<input name="confirm" autocomplete="off" placeholder="DELETE" required /></label>
          <div><button class="danger" type="submit">Delete my account forever</button></div>
        </form>
        <div class="msg"></div>
      </section>`);
    const delForm = delCard.querySelector('form');
    const delMsg = delCard.querySelector('.msg');
    delForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (delForm.confirm.value.trim().toUpperCase() !== 'DELETE') return showMsg(delMsg, 'Type DELETE to confirm.');
      if (!(await confirmBox('Delete your getxmatch account and everything in it? This cannot be undone.', 'Delete forever'))) return;
      busy(delForm.querySelector('button'), async () => {
        try {
          await api.post('/api/account/delete', { password: delForm.password.value, confirm: delForm.confirm.value });
          try { if (state.socket) state.socket.disconnect(); } catch (_e) { /* ignore */ }
          state.me = null;
          authNotice = 'Your account was deleted. Thank you for being part of getxmatch.';
          renderAuth('login');
        } catch (err) { showMsg(delMsg, err.message); }
      });
    });
    wrap.appendChild(delCard);
  }

  // Parent controls card. `g` is null (none linked) or { email, status, … }.
  function guardianCard(g, showMsg, busy) {
    const card = el('<section class="card account-card"><h3 class="card-title">👪 Parent controls</h3><div class="acc-body"></div><div class="msg"></div></section>');
    const bodyEl = card.querySelector('.acc-body');
    const msg = card.querySelector('.msg');
    const paint = (g) => {
      msg.className = 'msg';
      if (!g) {
        bodyEl.innerHTML = `
          <p>Because you're under 18, you can link a parent or guardian. They'll get a weekly summary of your activity (never your messages) and can approve new friends before you connect.</p>
          <form class="account-form">
            <label>Parent's or guardian's email<input name="email" type="email" autocomplete="off" required /></label>
            <div><button class="primary" type="submit">Send invitation</button></div>
          </form>`;
        const f = bodyEl.querySelector('form');
        f.addEventListener('submit', (e) => {
          e.preventDefault();
          busy(f.querySelector('button'), async () => {
            try {
              const r = await api.put('/api/account/guardian', { email: f.email.value });
              paint(r.guardian);
              showMsg(msg, 'Invitation sent. Ask your parent to open the email and confirm.', true);
            } catch (err) { showMsg(msg, err.message); }
          });
        });
        return;
      }
      if (g.status === 'pending') {
        bodyEl.innerHTML = `
          <p>Waiting for <b>${esc(g.email)}</b> to confirm from the email we sent. Nothing changes until they do.</p>
          <div class="account-actions"><button class="ghost" data-act="resend">Send the email again</button>
            <button class="ghost" data-act="remove">Remove</button></div>`;
      } else {
        bodyEl.innerHTML = `
          <p>Linked to <b>${esc(g.email)}</b>.</p>
          <ul class="acc-list">
            <li>${g.approveFriends ? 'New friends need their approval before you can chat.' : 'New friends don’t need their approval.'}</li>
            <li>${g.weeklySummary ? 'They get a weekly summary email.' : 'Weekly summaries are off.'}</li>
            ${g.pendingApprovals ? `<li>${g.pendingApprovals} friend request${g.pendingApprovals === 1 ? ' is' : 's are'} waiting for them.</li>` : ''}
          </ul>
          <p class="hint">Only your parent can change these or remove the link. Parent controls end automatically when you turn 18.</p>
          <div class="account-actions">${g.removalRequested
            ? '<span class="hint">You asked your parent to remove parent controls.</span>'
            : '<button class="ghost" data-act="remove">Ask to remove parent controls</button>'}</div>`;
      }
      const resend = bodyEl.querySelector('[data-act="resend"]');
      if (resend) resend.addEventListener('click', () => busy(resend, async () => {
        try { await api.post('/api/account/guardian/resend'); showMsg(msg, 'Sent again.', true); }
        catch (err) { showMsg(msg, err.message); }
      }));
      const remove = bodyEl.querySelector('[data-act="remove"]');
      if (remove) remove.addEventListener('click', async () => {
        const active = g.status === 'active';
        const ask = active ? 'Ask your parent to remove parent controls? They will get an email and decide.' : 'Remove this parent invitation?';
        if (!(await confirmBox(ask, active ? 'Ask' : 'Remove'))) return;
        busy(remove, async () => {
          try {
            const r = await api.del('/api/account/guardian');
            paint(r.guardian);
            if (r.result === 'requested') showMsg(msg, 'We emailed your parent. They decide whether to remove parent controls.', true);
          } catch (err) { showMsg(msg, err.message); }
        });
      });
    };
    paint(g);
    return card;
  }

  /* ---------- Leaderboard ---------- */
  // 1234 → "1,234"; negatives keep a proper minus sign.
  function fmtPoints(n) {
    const v = Number(n) || 0;
    return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString();
  }

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
        const medal = r.rank === 1 ? (kq ? '👑' : '🥇') : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `<span class="lb-rank-num">${r.rank}</span>`;
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
              <span class="lb-stat" title="Average rating">⭐ <b>${r.ratingAvg || '—'}</b></span>
              <span class="lb-stat" title="Likes received on the Highway">❤️ <b>${fmtPoints(r.likes || 0)}</b></span>
              <span class="lb-stat" title="Friends">👥 <b>${fmtPoints(r.friends || 0)}</b></span>
              <span class="lb-stat" title="Quizzes">🧠 <b>${fmtPoints(r.quizzes || 0)}</b></span>
              <span class="lb-stat" title="Polls voted in">📊 <b>${fmtPoints(r.polls || 0)}</b></span>
              <span class="lb-stat" title="Followers">➕ <b>${fmtPoints(r.followers || 0)}</b></span>` : `
              <span class="lb-stat" title="Overall points (Kings &amp; Queens)">👑 <b>${fmtPoints(r.totalPoints)}</b> overall</span>`}
            </div>
            <div class="lb-score${r.points < 0 ? ' neg' : ''}${r.rank <= 3 ? ' lb-score-' + r.rank : ''}" title="${kq ? `Overall points${r.penalty ? ` (${r.penalty} deducted for stopped quizzes and reattempts)` : ''}` : `Points in ${esc(board.label)} quizzes`}">
              <span class="lb-score-val">${fmtPoints(r.points)}</span><span class="lb-score-unit">${Math.abs(r.points) === 1 ? 'point' : 'points'}</span>
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
