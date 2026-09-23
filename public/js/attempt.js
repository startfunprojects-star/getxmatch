'use strict';

// Progressive-enhancement script for the public poll & quiz pages.
// A registered user can vote / take the quiz right here; a logged-out visitor
// is prompted to register when they try. Loaded as an external file because the
// pages' Content-Security-Policy forbids inline scripts.

(function () {
  var root = document.getElementById('gxAttempt');
  if (!root) return;

  var kind = root.getAttribute('data-kind');
  var id = root.getAttribute('data-id');
  var loggedIn = root.getAttribute('data-logged') === '1';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var note = root.querySelector('.gx-note');
  function showNote(html) {
    if (!note) return;
    note.innerHTML = html;
    note.hidden = false;
  }
  function promptRegister(action) {
    showNote(
      '<strong>Join getxmatch to ' + esc(action) + '.</strong>' +
      '<div><a class="cta" href="/">Register or sign in →</a></div>'
    );
  }

  async function postJson(url, body, keepalive) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
      keepalive: !!keepalive,
    });
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    return { status: res.status, data: data };
  }

  /* -------------------------------------------------- Poll ------------------ */
  if (kind === 'poll') {
    var closed = root.getAttribute('data-closed') === '1';

    function barSegs(g) {
      g = g || { male: 0, female: 0, other: 0 };
      var parts = [['male', g.male, 'Male'], ['female', g.female, 'Female'], ['other', g.other, 'Other / unspecified']];
      var html = '';
      for (var j = 0; j < parts.length; j++) {
        var n = parts[j][1] || 0;
        if (n <= 0) continue;
        html += '<span class="gx-seg gx-seg-' + parts[j][0] + '" style="flex-grow:' + n +
          '" title="' + esc(parts[j][2]) + ': ' + n + ' vote' + (n === 1 ? '' : 's') + '"></span>';
      }
      return html;
    }

    function paintPoll(poll) {
      var total = poll.total || 0;
      var btns = root.querySelectorAll('.gx-opt');
      for (var i = 0; i < btns.length; i++) {
        var n = (poll.counts && poll.counts[i]) || 0;
        var pct = total ? Math.round((n / total) * 100) : 0;
        var bar = btns[i].querySelector('.gx-opt-bar');
        var meta = btns[i].querySelector('.gx-opt-meta');
        if (bar) {
          bar.style.width = pct + '%';
          bar.innerHTML = barSegs(poll.genders && poll.genders[i]);
        }
        if (meta) meta.textContent = pct + '% · ' + n;
        var mine = poll.myVote === i;
        btns[i].classList.toggle('mine', mine);
      }
      var totalEl = document.querySelector('.gx-total');
      if (totalEl) totalEl.textContent = total + ' vote' + (total === 1 ? '' : 's') + ' so far';
    }

    root.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.gx-opt') : null;
      if (!btn || closed || btn.disabled) return;
      var i = parseInt(btn.getAttribute('data-i'), 10);
      if (isNaN(i)) return;
      if (!loggedIn) { promptRegister('vote'); return; }
      if (note) note.hidden = true;
      postJson('/api/content/polls/' + id + '/vote', { option: i })
        .then(function (r) {
          if (r.status === 401) { loggedIn = false; promptRegister('vote'); return; }
          if (r.status >= 200 && r.status < 300 && r.data && r.data.poll) { paintPoll(r.data.poll); return; }
          showNote(esc((r.data && r.data.error) || 'Could not record your vote. Please try again.'));
        })
        .catch(function () { showNote('Network error — please try again.'); });
    });
  }

  /* -------------------------------------------------- Quiz ------------------ */
  // The quiz is proctored: it runs in full screen inside a server-side session.
  // Leaving it (Esc, tab/app switch, minimise, another display, automation) is
  // reported to the server, which counts strikes — the first is a warning, the
  // second stops the attempt, locks the quiz for 24h and deducts points.
  if (kind === 'quiz') {
    var form = document.getElementById('gxQuizForm');
    if (!form) return;
    var base = '/api/content/quizzes/' + id;
    var intro = root.querySelector('.gx-proctor-intro');
    var startBtn = root.querySelector('.gx-start');
    var bar = root.querySelector('.gx-proctor-bar');
    var strikesEl = root.querySelector('.gx-proctor-strikes');
    var warn = root.querySelector('.gx-proctor-warn');
    var warnTitle = warn.querySelector('h2');
    var warnMsg = warn.querySelector('.gx-proctor-msg');
    var returnBtn = warn.querySelector('.gx-return');
    var hintEl = root.querySelector('.gx-hint');

    var session = null;
    var penalty = 10;
    var active = false; // monitoring is on
    var finishing = false; // submitting — leaving full screen is expected
    var lastStrikeAt = 0;
    // One action (e.g. Alt+Tab) fires blur + visibility + fullscreen events at
    // once; count them as a single incident.
    var GRACE_MS = 1500;
    var envTimer = null;
    var fsSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);

    function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

    function lockKeys() {
      // Keyboard Lock (Chromium): while in full screen, Esc must be held to exit
      // and OS shortcuts such as Alt+Tab / the Windows key are captured.
      try { if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(function () {}); } catch (_e) {}
    }
    function unlockKeys() {
      try { if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock(); } catch (_e) {}
    }

    // Must be called synchronously inside a click handler (user gesture).
    function enterFs() {
      var fn = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!fn) return Promise.resolve(false);
      try {
        return Promise.resolve(fn.call(root, { navigationUI: 'hide' })).then(
          function () { lockKeys(); return true; },
          function () { return false; }
        );
      } catch (_e) { return Promise.resolve(false); }
    }
    function exitFs() {
      unlockKeys();
      if (!fsElement()) return;
      var fn = document.exitFullscreen || document.webkitExitFullscreen;
      try { var p = fn.call(document); if (p && p.catch) p.catch(function () {}); } catch (_e) {}
    }

    // What a web page can observe about the environment. (Remote-desktop tools
    // that don't change these signals are invisible to the browser.)
    function envProblem() {
      if (navigator.webdriver) return 'Browser automation or remote control is active';
      if (window.screen && window.screen.isExtended) return 'A second display or screen mirroring is connected';
      return null;
    }

    function fmtUntil(ms) {
      try { return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
      catch (_e) { return new Date(ms).toLocaleString(); }
    }

    function updateStrikes(n) {
      strikesEl.textContent = n ? 'Warning given — leaving again stops the quiz' : 'Stay in full screen until you submit';
      strikesEl.classList.toggle('warned', n > 0);
    }

    function stopMonitoring() {
      active = false;
      if (envTimer) { clearInterval(envTimer); envTimer = null; }
    }

    function showLocked(until, lead) {
      stopMonitoring();
      exitFs();
      form.hidden = true;
      bar.hidden = true;
      warn.hidden = true;
      if (intro) intro.hidden = true;
      if (hintEl) hintEl.hidden = true;
      showNote('<strong>' + esc(lead || 'You can’t attempt this quiz right now.') + '</strong>' +
        '<div>You can attempt it again after ' + esc(fmtUntil(until)) + '.</div>');
    }

    function showWarning(title, msg, canReturn) {
      warnTitle.textContent = title;
      warnMsg.textContent = msg;
      returnBtn.hidden = !canReturn;
      returnBtn.textContent = fsSupported ? 'Return to full screen' : 'Continue the quiz';
      warn.hidden = false;
      form.hidden = true;
      if (canReturn) returnBtn.focus();
    }

    function begin(strikes) {
      active = true;
      finishing = false;
      lastStrikeAt = Date.now(); // ignore the transition into full screen
      if (intro) intro.hidden = true;
      if (note) note.hidden = true;
      warn.hidden = true;
      bar.hidden = false;
      form.hidden = false;
      updateStrikes(strikes);
      if (!envTimer) envTimer = setInterval(function () {
        var p = envProblem();
        if (p) violation('environment', p);
      }, 2000);
    }

    function violation(reason, detail) {
      if (!active || finishing) return;
      var now = Date.now();
      if (now - lastStrikeAt < GRACE_MS) return;
      lastStrikeAt = now;
      showWarning('You left the quiz', 'Checking…', false);
      postJson(base + '/proctor/violation', { session: session, reason: reason }, true)
        .then(function (r) {
          var d = r.data || {};
          if (d.terminated) {
            showLocked(d.lockedUntil || Date.now() + 864e5,
              'Quiz stopped — you left the quiz a second time. ' + (d.penalty || penalty) + ' points were deducted from your score.');
            return;
          }
          if (typeof d.strikes === 'number') updateStrikes(d.strikes);
          showWarning(
            'Warning: you left the quiz',
            (detail ? detail + '. ' : '') + 'The quiz must stay in full screen. If you leave it again, the quiz will stop, ' +
              'you won’t be able to attempt it for 24 hours and ' + penalty + ' points will be deducted from your score.',
            true
          );
        })
        .catch(function () {
          showWarning('Warning: you left the quiz', 'The quiz must stay in full screen until you submit.', true);
        });
    }

    returnBtn.addEventListener('click', function () {
      var p = envProblem();
      if (p) { warnMsg.textContent = p + ' — turn it off, then return to the quiz.'; return; }
      var go = function () { lastStrikeAt = Date.now(); warn.hidden = true; form.hidden = false; };
      if (!fsSupported || fsElement()) { go(); return; }
      enterFs().then(function (ok) {
        if (ok) go();
        else warnMsg.textContent = 'Your browser blocked full screen. Allow full screen for this site, then try again.';
      });
    });

    function onFsChange() { if (!fsElement()) violation('exit-fullscreen'); }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') violation('hidden'); });
    window.addEventListener('blur', function () { violation('blur'); });
    if (window.screen && window.screen.addEventListener) {
      window.screen.addEventListener('change', function () { var p = envProblem(); if (p) violation('display', p); });
    }
    // Closing or reloading the page mid-quiz also counts as leaving it.
    window.addEventListener('pagehide', function () {
      if (!active || finishing || !session || !navigator.sendBeacon) return;
      try {
        navigator.sendBeacon(base + '/proctor/violation',
          new Blob([JSON.stringify({ session: session, reason: 'closed' })], { type: 'application/json' }));
      } catch (_e) {}
    });

    if (loggedIn) {
      fetch(base + '/proctor', { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (d) {
          if (!d) return;
          if (d.penalty) penalty = d.penalty;
          if (d.lockedUntil) showLocked(d.lockedUntil);
        })
        .catch(function () {});
    }

    startBtn.addEventListener('click', function () {
      if (!loggedIn) { promptRegister('attempt this quiz'); return; }
      var p = envProblem();
      if (p) { showNote(esc(p) + ' — turn it off, then start the quiz.'); return; }
      startBtn.disabled = true;
      var fsReady = enterFs(); // inside the click so the browser allows it
      postJson(base + '/proctor/start', {})
        .then(function (r) {
          var d = r.data || {};
          if (r.status === 401) { loggedIn = false; startBtn.disabled = false; exitFs(); promptRegister('attempt this quiz'); return; }
          if (r.status === 423) { showLocked(d.lockedUntil); return; }
          if (!(r.status >= 200 && r.status < 300 && d.session)) {
            startBtn.disabled = false; exitFs();
            showNote(esc(d.error || 'Could not start the quiz. Please try again.'));
            return;
          }
          session = d.session;
          if (d.penalty) penalty = d.penalty;
          fsReady.then(function (ok) {
            if (!ok && fsSupported) {
              startBtn.disabled = false;
              showNote('Your browser blocked full screen. Allow full screen for this site, then start the quiz again.');
              return;
            }
            begin(d.strikes || 0);
          });
        })
        .catch(function () { startBtn.disabled = false; exitFs(); showNote('Network error — please try again.'); });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!active || !session) return;
      var fieldsets = form.querySelectorAll('.gx-q');
      var answers = [];
      var missing = false;
      for (var i = 0; i < fieldsets.length; i++) {
        var picked = fieldsets[i].querySelector('input[type="radio"]:checked');
        if (!picked) { missing = true; break; }
        answers.push(parseInt(picked.value, 10));
      }
      if (missing) { showNote('Please answer every question before submitting.'); return; }

      var submitBtn = form.querySelector('.gx-submit');
      if (submitBtn) submitBtn.disabled = true;
      if (note) note.hidden = true;
      finishing = true;

      postJson(base + '/match', { answers: answers, session: session })
        .then(function (r) {
          var d = r.data || {};
          if (r.status === 423) { showLocked(d.lockedUntil); return; }
          if (r.status >= 200 && r.status < 300 && d.token) {
            stopMonitoring();
            exitFs();
            bar.hidden = true;
            var link = window.location.origin + '/m/' + d.token;
            var result = root.querySelector('.gx-result');
            form.hidden = true;
            if (hintEl) hintEl.hidden = true;
            if (result) {
              result.hidden = false;
              result.innerHTML =
                '<h2>Your answers are locked in 🎉</h2>' +
                '<p>Share this link — it stays active for one hour. When someone else answers, you’ll both see how well you match.</p>' +
                '<div class="gx-share">' +
                '<input type="text" readonly value="' + esc(link) + '" />' +
                '<button type="button" class="cta" id="gxCopy">Copy link</button>' +
                '</div>' +
                '<p style="margin-top:14px"><a class="cta" href="' + esc(link) + '">Open the match page →</a></p>';
              var copyBtn = document.getElementById('gxCopy');
              var input = result.querySelector('.gx-share input');
              if (copyBtn && input) {
                copyBtn.addEventListener('click', function () {
                  input.select();
                  var done = function () { copyBtn.textContent = 'Copied ✓'; };
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(link).then(done, function () { try { document.execCommand('copy'); done(); } catch (_e) {} });
                  } else { try { document.execCommand('copy'); done(); } catch (_e) {} }
                });
              }
            }
            return;
          }
          finishing = false;
          if (submitBtn) submitBtn.disabled = false;
          showNote(esc(d.error || 'Could not submit your answers. Please try again.'));
        })
        .catch(function () { finishing = false; if (submitBtn) submitBtn.disabled = false; showNote('Network error — please try again.'); });
    });
  }
})();
