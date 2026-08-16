/* Standalone page for public broadcast ("live") chats. Works for logged-out
   visitors AND registered users — it only ever WATCHES and comments, never
   joins the private conversation. Two modes, chosen from the URL:
     /live          -> directory of active broadcasts
     /live/<token>  -> watch one broadcast                                    */
(function () {
  'use strict';

  var root = document.getElementById('liveRoot');

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (_e) { return ''; }
  }
  function ago(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h';
  }

  var socket = null;
  function connect() {
    if (socket) return socket;
    socket = window.io ? window.io({ withCredentials: true }) : null;
    return socket;
  }

  /* ======================= LIST MODE ======================= */
  async function renderList() {
    document.title = 'getxmatch · live chats';
    root.innerHTML = '<div class="loading">Loading live chats…</div>';
    var data;
    try { data = await window.api.get('/api/broadcast'); }
    catch (_e) { data = { broadcasts: [] }; }
    paintList(data.broadcasts || []);

    // Live-refresh the directory as broadcasts start/stop.
    var s = connect();
    if (s) s.on('broadcast:listChanged', refreshList);
    // Fallback poll so viewer counts stay fresh even without events. Guard
    // against stacking intervals if renderList runs more than once.
    if (!renderList._timer) renderList._timer = setInterval(refreshList, 10000);
  }

  async function refreshList() {
    try {
      var data = await window.api.get('/api/broadcast');
      paintList(data.broadcasts || []);
    } catch (_e) { /* ignore */ }
  }

  function paintList(list) {
    root.innerHTML = '';
    var head = el(
      '<div class="live-list-head">' +
        '<h1>🔴 Live right now</h1>' +
        '<p class="hint">' + (list.length
          ? 'Jump into a live chat — watch it unfold and drop a flying comment. You can watch without an account.'
          : 'No one is broadcasting right now. Check back soon.') +
        '</p></div>'
    );
    root.appendChild(head);

    if (!list.length) {
      root.appendChild(el('<div class="live-empty">📭 Nothing live at the moment.</div>'));
      return;
    }

    var grid = el('<div class="live-grid"></div>');
    list.forEach(function (b) {
      var card = el(
        '<a class="live-card" href="/live/' + encodeURIComponent(b.token) + '">' +
          '<div class="live-card-badge">● LIVE</div>' +
          '<div class="live-card-title">' + esc(b.title || 'A live chat') + '</div>' +
          '<div class="live-card-people">' +
            '<span>' + esc(b.ownerName) + '</span>' +
            '<span class="live-card-amp">⇄</span>' +
            '<span>' + esc(b.peerName) + '</span>' +
          '</div>' +
          '<div class="live-card-meta">' +
            '<span>👁️ ' + b.viewers + ' watching</span>' +
            '<span>· ' + ago(b.startedAt) + ' ago</span>' +
          '</div>' +
        '</a>'
      );
      grid.appendChild(card);
    });
    root.appendChild(grid);
  }

  /* ======================= WATCH MODE ======================= */
  function guestName() {
    try { return localStorage.getItem('gxm_guest_name') || ''; } catch (_e) { return ''; }
  }
  function setGuestName(v) {
    try { localStorage.setItem('gxm_guest_name', v || ''); } catch (_e) { /* ignore */ }
  }

  var watchState = { token: null, info: null, ended: false };

  async function renderWatch(token) {
    watchState.token = token;
    root.innerHTML = '<div class="loading">Connecting to the live chat…</div>';

    var s = connect();
    if (!s) { root.innerHTML = '<div class="live-empty">Live chat is unavailable.</div>'; return; }

    s.on('broadcast:message', function (m) { if (!watchState.ended) appendMessage(m); });
    s.on('broadcast:comment', function (c) { if (c && (!c.token || c.token === token)) flyComment(c); });
    s.on('broadcast:viewers', function (e) { if (e && e.token === token) setViewers(e.count); });
    s.on('broadcast:ended', function (e) { if (!e || e.token === token) showEnded(); });
    s.on('disconnect', function () { /* socket will auto-reconnect and re-watch */ });
    s.on('connect', doWatch);

    doWatch();
  }

  function doWatch() {
    var s = connect();
    s.emit('broadcast:watch', { token: watchState.token }, function (res) {
      if (!res || res.error) return showEnded(res && res.error);
      watchState.info = res.info;
      watchState.ended = false;
      paintWatch(res.info, res.messages || []);
    });
  }

  function paintWatch(info, messages) {
    document.title = 'Live · ' + (info.title || (info.ownerName + ' ⇄ ' + info.peerName));
    root.innerHTML = '';
    var view = el(
      '<div class="watch">' +
        '<div class="watch-head">' +
          '<a class="icon-btn small" href="/live" title="All live chats">←</a>' +
          '<div class="watch-id">' +
            '<div class="watch-title">' + esc(info.title || 'Live chat') + '</div>' +
            '<div class="watch-people">' + esc(info.ownerName) + ' ⇄ ' + esc(info.peerName) + '</div>' +
          '</div>' +
          '<div class="watch-live"><span class="live-dot"></span>LIVE</div>' +
          '<div class="watch-viewers" id="watchViewers">👁️ ' + info.viewers + '</div>' +
        '</div>' +
        '<div class="watch-stage">' +
          '<div class="watch-body" id="watchBody"></div>' +
          '<div class="fly-layer" id="flyLayer"></div>' +
        '</div>' +
        '<div class="watch-note">👀 You are watching — participants can\'t see who\'s here, only the count. Your comment flies across everyone\'s screen for a moment.</div>' +
        '<div class="watch-composer">' +
          '<input type="text" id="guestName" class="watch-guest" maxlength="24" placeholder="name (optional)" />' +
          '<input type="text" id="commentInput" class="watch-comment" maxlength="200" placeholder="Send a flying comment…" autocomplete="off" />' +
          '<button class="primary" id="commentSend">Send</button>' +
          '<button class="ghost" id="shareBtn" title="Share this live chat">Share</button>' +
        '</div>' +
      '</div>'
    );
    root.appendChild(view);

    var body = view.querySelector('#watchBody');
    if (!messages.length) {
      body.appendChild(el('<div class="watch-hint">Waiting for the next message…</div>'));
    } else {
      messages.forEach(appendMessage);
    }

    var gname = view.querySelector('#guestName');
    gname.value = guestName();
    gname.addEventListener('change', function () { setGuestName(gname.value.trim()); });

    var input = view.querySelector('#commentInput');
    var send = function () { sendComment(input); };
    view.querySelector('#commentSend').addEventListener('click', send);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    view.querySelector('#shareBtn').addEventListener('click', shareLink);
  }

  function appendMessage(m) {
    var body = document.getElementById('watchBody');
    if (!body) return;
    var hint = body.querySelector('.watch-hint');
    if (hint) hint.remove();
    var side = watchState.info && m.from === watchState.info.ownerId ? 'owner' : 'peer';
    var row = el(
      '<div class="watch-msg ' + side + '">' +
        '<div class="watch-msg-name">' + esc(m.fromName) + '</div>' +
        '<div class="watch-bubble' + (m.kind && m.kind !== 'text' ? ' special' : '') + '"></div>' +
        '<div class="watch-msg-time">' + fmtTime(m.at) + '</div>' +
      '</div>'
    );
    row.querySelector('.watch-bubble').textContent = m.text;
    body.appendChild(row);
    // Keep pinned to the latest unless the viewer scrolled up.
    var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    if (nearBottom) body.scrollTop = body.scrollHeight;
  }

  function setViewers(n) {
    var v = document.getElementById('watchViewers');
    if (v) v.textContent = '👁️ ' + n;
  }

  // A flying comment: drifts across the stage and is removed after ~10s.
  var flownIds = {};
  function flyComment(c) {
    var layer = document.getElementById('flyLayer');
    if (!layer || !c) return;
    if (c.id) { // one comment flies once, even if delivered on two channels
      if (flownIds[c.id]) return;
      flownIds[c.id] = 1;
      setTimeout(function () { delete flownIds[c.id]; }, 12000);
    }
    var node = el('<div class="fly-comment"><b></b><span></span></div>');
    node.querySelector('b').textContent = (c.name || 'Guest') + ': ';
    node.querySelector('span').textContent = c.text;
    // Random vertical lane within the stage.
    node.style.top = (6 + Math.random() * 78) + '%';
    layer.appendChild(node);
    var kill = function () { if (node.parentNode) node.parentNode.removeChild(node); };
    node.addEventListener('animationend', kill);
    setTimeout(kill, 10000); // hard cap: disappears within 10 seconds
  }

  function sendComment(input) {
    var text = (input.value || '').trim();
    if (!text) return;
    var s = connect();
    if (!s) return;
    s.emit('broadcast:comment', { token: watchState.token, text: text, guestName: guestName() }, function (res) {
      if (res && res.error) { flashComposerError(res.error); return; }
    });
    input.value = '';
    input.focus();
  }

  function flashComposerError(msg) {
    var input = document.getElementById('commentInput');
    if (!input) return alert(msg);
    var prev = input.placeholder;
    input.placeholder = msg;
    setTimeout(function () { if (input) input.placeholder = prev; }, 1800);
  }

  async function shareLink() {
    var url = location.href;
    var title = watchState.info
      ? (watchState.info.ownerName + ' ⇄ ' + watchState.info.peerName + ' — live on getxmatch')
      : 'Live chat on getxmatch';
    if (navigator.share) {
      try { await navigator.share({ title: title, url: url }); return; } catch (_e) { /* fall through */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      var btn = document.getElementById('shareBtn');
      if (btn) { var t = btn.textContent; btn.textContent = 'Link copied!'; setTimeout(function () { btn.textContent = t; }, 1600); }
    } catch (_e) {
      prompt('Copy this link to share:', url);
    }
  }

  function showEnded(msg) {
    watchState.ended = true;
    root.innerHTML = '';
    root.appendChild(el(
      '<div class="live-ended">' +
        '<div class="live-ended-emoji">📴</div>' +
        '<h1>' + esc(msg || 'This broadcast has ended') + '</h1>' +
        '<p class="hint">The live chat is no longer running.</p>' +
        '<a class="primary" href="/live">See other live chats</a>' +
      '</div>'
    ));
  }

  /* ---------- router ---------- */
  function boot() {
    var m = location.pathname.match(/^\/live\/(.+)$/);
    if (m && m[1]) renderWatch(decodeURIComponent(m[1].replace(/\/+$/, '')));
    else renderList();
  }

  boot();
})();
