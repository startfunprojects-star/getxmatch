'use strict';

// Progressive-enhancement script for the public poll & quiz pages.
// A registered user can vote / take the quiz right here; a logged-out visitor
// is prompted to register when they try. Loaded as an external file because the
// pages' Content-Security-Policy forbids inline scripts.

// Share bar on poll pages: Copy link, and the phone's own share sheet (which
// reaches Instagram, Snapchat and any other installed app).
(function () {
  var bar = document.querySelector('.gx-share');
  if (!bar) return;
  var url = bar.getAttribute('data-url');
  var text = bar.getAttribute('data-text');
  var copy = bar.querySelector('.gx-share-copy');
  copy.addEventListener('click', function () {
    var done = function () { copy.textContent = '✓ Copied'; setTimeout(function () { copy.textContent = '🔗 Copy link'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link', url); });
    else window.prompt('Copy this link', url);
  });
  var native = bar.querySelector('.gx-share-native');
  if (navigator.share) {
    native.hidden = false;
    native.addEventListener('click', function () {
      navigator.share({ title: document.title, text: text, url: url }).catch(function () {});
    });
  }
})();

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
    // Opened from a standard-quiz challenge link (/quizzes/:id?challenge=…).
    var challengeToken = '';
    try { challengeToken = new URLSearchParams(window.location.search).get('challenge') || ''; } catch (_e) {}
    var intro = root.querySelector('.gx-proctor-intro');
    var startBtn = root.querySelector('.gx-start');
    var bar = root.querySelector('.gx-proctor-bar');
    var strikesEl = root.querySelector('.gx-proctor-strikes');
    var warn = root.querySelector('.gx-proctor-warn');
    var warnTitle = warn.querySelector('h2');
    var warnMsg = warn.querySelector('.gx-proctor-msg');
    var returnBtn = warn.querySelector('.gx-return');
    var hintEl = root.querySelector('.gx-hint');
    var step = root.querySelector('.gx-step');
    var progressEl = step.querySelector('.gx-progress');
    var earnedEl = step.querySelector('.gx-earned');
    var timerEl = step.querySelector('.gx-timer');
    var timebar = step.querySelector('.gx-timebar');
    var fieldsets = form.querySelectorAll('.gx-q');
    var submitBtn = form.querySelector('.gx-submit');

    var session = null;
    var penalty = 10;
    var active = false; // monitoring is on
    var finishing = false; // submitting — leaving full screen is expected
    var lastStrikeAt = 0;
    // One action (e.g. Alt+Tab) fires blur + visibility + fullscreen events at
    // once; count them as a single incident.
    var GRACE_MS = 1500;
    var envTimer = null;
    // Current question, driven by the server's session state.
    var qIndex = 0;
    var qDeadline = 0; // local ms when the current question's time runs out (0 = untimed)
    var qLimitMs = 0;
    var qTimer = null;
    var answering = false;
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

    function stopQuestionTimer() {
      if (qTimer) { clearInterval(qTimer); qTimer = null; }
    }

    function stopMonitoring() {
      active = false;
      stopQuestionTimer();
      if (envTimer) { clearInterval(envTimer); envTimer = null; }
    }

    function showLocked(until, lead) {
      stopMonitoring();
      exitFs();
      form.hidden = true;
      bar.hidden = true;
      step.hidden = true;
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

    function fmtClock(ms) {
      var t = Math.max(0, Math.ceil(ms / 1000));
      var m = Math.floor(t / 60);
      var sec = t % 60;
      return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function tick() {
      if (!qDeadline) return;
      var left = qDeadline - Date.now();
      timerEl.textContent = '⏱ ' + fmtClock(left);
      timerEl.classList.toggle('low', left <= 5000);
      var fill = timebar.querySelector('span');
      if (fill) fill.style.width = Math.max(0, Math.min(100, (left / qLimitMs) * 100)) + '%';
      // Time's up: skip the question (the server records it as unanswered
      // unless a picked option still lands within its grace window).
      if (left <= 0) { stopQuestionTimer(); sendAnswer(true); }
    }

    // Show the question at position `state.index` with its countdown
    // (remainingMs is measured by the server, so the local clock's accuracy
    // doesn't matter). Every attempt has its own random order: state.q is the
    // question to show there and state.opts its options in display order (the
    // radio values stay the original option indexes).
    function showQuestion(state) {
      stopQuestionTimer();
      qIndex = state.index;
      var shown = state.q != null ? state.q : qIndex;
      for (var i = 0; i < fieldsets.length; i++) fieldsets[i].hidden = i !== shown;
      var fs = fieldsets[shown];
      var num = fs.querySelector('.gx-qn');
      if (num) num.textContent = (qIndex + 1) + '.';
      if (state.opts) {
        var byValue = {};
        var labels = fs.querySelectorAll('.gx-qopt');
        for (var k = 0; k < labels.length; k++) {
          var inp = labels[k].querySelector('input');
          if (inp) { byValue[inp.value] = labels[k]; inp.checked = false; }
        }
        state.opts.forEach(function (oi) { if (byValue[oi]) fs.appendChild(byValue[oi]); });
      }
      var secs = parseInt(fs.getAttribute('data-seconds'), 10) || 0;
      progressEl.textContent = 'Question ' + (qIndex + 1) + ' of ' + fieldsets.length;
      // Standard quizzes keep the score hidden until the end (points is null).
      earnedEl.textContent = !state.maxPoints ? '' : state.points == null ? 'Score shown at the end' : state.points + ' / ' + state.maxPoints + ' pts';
      submitBtn.textContent = qIndex === fieldsets.length - 1 ? 'Finish quiz' : 'Next';
      submitBtn.disabled = false;
      step.hidden = false;
      if (secs && state.remainingMs != null) {
        qLimitMs = secs * 1000;
        qDeadline = Date.now() + state.remainingMs;
        timebar.classList.remove('untimed');
        tick();
        qTimer = setInterval(tick, 250);
      } else {
        qDeadline = 0;
        timerEl.textContent = 'No time limit';
        timerEl.classList.remove('low');
        timebar.classList.add('untimed');
      }
      var first = fs.querySelector('input[type="radio"]');
      if (first && warn.hidden) { try { first.focus({ preventScroll: true }); } catch (_e) {} }
    }

    function begin(strikes, state) {
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
      if (state && state.done) finish();
      else showQuestion(state || { index: 0, remainingMs: null, points: 0, maxPoints: 0 });
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
      fetch(base + '/proctor' + (challengeToken ? '?challenge=' + encodeURIComponent(challengeToken) : ''), { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (d) {
          if (!d) return;
          if (d.penalty) penalty = d.penalty;
          if (d.lockedUntil) { showLocked(d.lockedUntil); return; }
          var lead = '';
          if (d.challenge) {
            if (d.challenge.error) {
              challengeToken = '';
              lead = '<strong>' + esc(d.challenge.error) + '</strong> ';
              if (!d.reattempt) showNote(lead + 'You can still take the quiz on your own.');
            } else {
              startBtn.textContent = 'Accept challenge in full screen';
              showNote('⚔️ <strong>' + esc(d.challenge.aName) + ' challenged you.</strong> Their score stays hidden until you finish. ' +
                'Score more to win their points — if you score less, ' +
                esc(d.challenge.aName) + ' takes yours. A tie moves no points. Leaving full screen twice forfeits the challenge.');
              return;
            }
          }
          // Already attempted: starting again costs points straight away.
          if (d.reattempt) {
            var cost = d.reattemptPenalty || 10;
            startBtn.textContent = 'Reattempt quiz (−' + cost + ' points)';
            showNote(lead + '<strong>You’ve attempted this quiz before.</strong> Starting it again deducts ' + cost +
              ' points from your score straight away, and this new attempt replaces your earlier score — even if it’s lower.' +
              (d.reattemptNoChallenge ? ' A reattempt doesn’t give you a challenge link — only your first attempt can challenge someone.' : ''));
          }
        })
        .catch(function () {});
    }

    startBtn.addEventListener('click', function () {
      if (!loggedIn) { promptRegister('attempt this quiz'); return; }
      var p = envProblem();
      if (p) { showNote(esc(p) + ' — turn it off, then start the quiz.'); return; }
      startBtn.disabled = true;
      var fsReady = enterFs(); // inside the click so the browser allows it
      postJson(base + '/proctor/start', challengeToken ? { challenge: challengeToken } : {})
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
          if (note) note.hidden = true;
          fsReady.then(function (ok) {
            if (!ok && fsSupported) {
              startBtn.disabled = false;
              showNote('Your browser blocked full screen. Allow full screen for this site, then start the quiz again.');
              return;
            }
            begin(d.strikes || 0, d.state);
          });
        })
        .catch(function () { startBtn.disabled = false; exitFs(); showNote('Network error — please try again.'); });
    });

    // Celebration for a correct answer (the server picks which ones): firework
    // bursts, confetti, a pop-up cheer and a synthesised "hurray". It sits in
    // `root` so it shows in full screen, and never takes clicks.
    var CHEERS = ['Yeee! 🎉', 'Hurray! 🥳', 'Woohoo! 🔥', 'Boom! 💥', 'Nailed it! 🎯', 'Yesss! ✨'];
    var COLORS = ['#ff4d6d', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f1c', '#ffffff'];
    var audioCtx = null;

    function playHurray() {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        var ac = audioCtx;
        if (ac.state === 'suspended') ac.resume();
        var t0 = ac.currentTime;
        var out = ac.createGain();
        out.gain.value = 0.5;
        out.connect(ac.destination);
        var noise = function (len) {
          var buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
          var data = buf.getChannelData(0);
          for (var i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
          var src = ac.createBufferSource();
          src.buffer = buf;
          return src;
        };
        // Firework pops: short bursts of filtered noise.
        [0, 0.18, 0.32, 0.5].forEach(function (at) {
          var s = noise(0.25);
          var f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900 + Math.random() * 1500;
          var g = ac.createGain();
          g.gain.setValueAtTime(0.9, t0 + at);
          g.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.22);
          s.connect(f); f.connect(g); g.connect(out);
          s.start(t0 + at); s.stop(t0 + at + 0.25);
        });
        // "Hurray": a quick rising major arpeggio.
        [523.25, 659.25, 783.99, 1046.5].forEach(function (hz, i) {
          var o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = hz;
          var g = ac.createGain();
          var at = t0 + 0.1 + i * 0.09;
          g.gain.setValueAtTime(0, at);
          g.gain.linearRampToValueAtTime(0.25, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, at + (i === 3 ? 0.7 : 0.25));
          o.connect(g); g.connect(out);
          o.start(at); o.stop(at + 0.75);
        });
        // Crowd cheer: band-passed noise that swells and fades.
        var crowd = noise(1.4);
        var bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
        var cg = ac.createGain();
        cg.gain.setValueAtTime(0, t0 + 0.1);
        cg.gain.linearRampToValueAtTime(0.35, t0 + 0.4);
        cg.gain.exponentialRampToValueAtTime(0.001, t0 + 1.5);
        crowd.connect(bp); bp.connect(cg); cg.connect(out);
        crowd.start(t0 + 0.1); crowd.stop(t0 + 1.5);
      } catch (_e) { /* sound is a nice-to-have */ }
    }

    function celebrate() {
      playHurray();
      var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var cheer = document.createElement('div');
      cheer.textContent = CHEERS[Math.floor(Math.random() * CHEERS.length)];
      cheer.style.cssText = 'position:fixed;left:50%;top:38%;z-index:2147483647;pointer-events:none;' +
        'font:800 clamp(34px,8vw,72px)/1 system-ui,sans-serif;color:#fff;white-space:nowrap;' +
        'text-shadow:0 3px 0 #ff4d6d,0 6px 18px rgba(0,0,0,.45);transform:translate(-50%,-50%) scale(.3);opacity:0;' +
        'transition:transform .35s cubic-bezier(.2,1.6,.4,1),opacity .35s';
      root.appendChild(cheer);
      requestAnimationFrame(function () { cheer.style.transform = 'translate(-50%,-50%) scale(1)'; cheer.style.opacity = '1'; });
      setTimeout(function () { cheer.style.opacity = '0'; cheer.style.transform = 'translate(-50%,-70%) scale(1.1)'; }, 1300);
      setTimeout(function () { cheer.remove(); }, 1750);
      if (still) return;

      var canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none';
      root.appendChild(canvas);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var W = window.innerWidth, H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      var rand = function (a, b) { return a + Math.random() * (b - a); };
      var color = function () { return COLORS[Math.floor(Math.random() * COLORS.length)]; };
      var parts = [];
      // Confetti from both bottom corners.
      [[0, -1], [W, 1]].forEach(function (side) {
        for (var i = 0; i < 70; i += 1) {
          var ang = rand(55, 80) * Math.PI / 180;
          var sp = rand(0.8, 1.25) * Math.sqrt(0.45 * H); // reaches most of the way up on any screen
          parts.push({ kind: 'confetti', x: side[0], y: H, vx: -side[1] * Math.cos(ang) * sp, vy: -Math.sin(ang) * sp,
            w: rand(6, 11), h: rand(3, 6), rot: rand(0, 6.28), vr: rand(-0.3, 0.3), c: color(), life: rand(110, 160) });
        }
      });
      // Firework rockets that burst into sparks.
      var rockets = [];
      for (var r = 0; r < 3; r += 1) {
        rockets.push({ x: rand(W * 0.2, W * 0.8), y: H, ty: rand(H * 0.15, H * 0.4), vy: -rand(11, 14), delay: r * 12, c: color() });
      }
      var frame = 0;
      (function loop() {
        frame += 1;
        ctx.clearRect(0, 0, W, H);
        rockets.forEach(function (k) {
          if (k.done || frame < k.delay) return;
          k.y += k.vy;
          ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(k.x, k.y, 2.5, 0, 6.28); ctx.fill();
          if (k.y <= k.ty) {
            k.done = true;
            for (var s = 0; s < 60; s += 1) {
              var a = rand(0, 6.28), v = rand(2, 7);
              parts.push({ kind: 'spark', x: k.x, y: k.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: Math.random() < 0.7 ? k.c : color(), life: rand(45, 70) });
            }
          }
        });
        parts.forEach(function (p) {
          p.life -= 1;
          if (p.life <= 0) return;
          ctx.globalAlpha = Math.min(1, p.life / 30);
          ctx.fillStyle = p.c;
          if (p.kind === 'spark') {
            p.vx *= 0.96; p.vy = p.vy * 0.96 + 0.08;
            p.x += p.vx; p.y += p.vy;
            ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 6.28); ctx.fill();
          } else {
            p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.25;
            p.x += p.vx + Math.sin(frame / 8 + p.w) * 0.6; p.y += p.vy; p.rot += p.vr;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(frame / 6 + p.rot)) + 1);
            ctx.restore();
          }
        });
        ctx.globalAlpha = 1;
        parts = parts.filter(function (p) { return p.life > 0; });
        if (frame < 200 && (parts.length || rockets.some(function (k) { return !k.done; }))) requestAnimationFrame(loop);
        else canvas.remove();
      })();
    }

    // Send the current question's answer (or a timeout) and move on.
    function sendAnswer(timedOut) {
      if (!active || answering) return;
      var picked = form.querySelector('.gx-q:not([hidden]) input[type="radio"]:checked');
      if (!picked && !timedOut) { showNote('Pick an answer, or wait for the timer to skip this question.'); return; }
      answering = true;
      stopQuestionTimer();
      submitBtn.disabled = true;
      if (note) note.hidden = true;
      postJson(base + '/proctor/answer', { session: session, index: qIndex, option: picked ? parseInt(picked.value, 10) : -1 })
        .then(function (r) {
          answering = false;
          var d = r.data || {};
          if (r.status === 423) { showLocked(d.lockedUntil); return; }
          if (!(r.status >= 200 && r.status < 300 && d.state)) {
            submitBtn.disabled = false;
            showNote(esc(d.error || 'Could not save your answer. Please try again.'));
            return;
          }
          var lost = d.earned < 0 ? ' ' + (-d.earned) + ' point' + (d.earned === -1 ? ' was' : 's were') + ' deducted.' : '';
          if (d.accepted && timedOut && !d.answered) showNote('Time’s up — that question was skipped.' + lost);
          else if (d.accepted && d.late) showNote('Too late — that answer arrived after the time limit and earned no points.' + lost);
          if (d.celebrate) celebrate();
          if (d.state.done) finish();
          else showQuestion(d.state);
        })
        .catch(function () {
          answering = false;
          submitBtn.disabled = false;
          showNote('Network error — please try again.');
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      sendAnswer(false);
    });

    // All questions answered: lock in the attempt and get the share link.
    function finish() {
      finishing = true;
      stopQuestionTimer();
      submitBtn.disabled = true;
      postJson(base + '/match', { session: session })
        .then(function (r) {
          var d = r.data || {};
          if (r.status === 423) { showLocked(d.lockedUntil); return; }
          if (r.status >= 200 && r.status < 300 && (d.token || d.total)) {
            stopMonitoring();
            exitFs();
            bar.hidden = true;
            step.hidden = true;
            if (d.challengeDone) {
              form.hidden = true;
              if (hintEl) hintEl.hidden = true;
              var res = root.querySelector('.gx-result');
              if (res) {
                res.hidden = false;
                res.innerHTML = '<h2>Challenge complete ⚔️</h2>' +
                  '<p>You scored <strong>' + d.points + ' of ' + d.maxPoints + ' points</strong>' +
                  '.</p>' +
                  (d.token ? '<p style="margin-top:14px"><a class="cta" href="/m/' + encodeURIComponent(d.token) + '">See who won →</a></p>' : '');
              }
              return;
            }
            var link = d.token ? window.location.origin + '/m/' + d.token : '';
            var result = root.querySelector('.gx-result');
            form.hidden = true;
            if (hintEl) hintEl.hidden = true;
            if (result) {
              var summary = (d.maxPoints ? 'You earned <strong>' + d.points + ' of ' + d.maxPoints + ' points</strong>' : 'You finished the quiz') +
                (d.graded
                  ? '.'
                  : ' and answered ' + d.answered + ' of ' + d.total + ' question' + (d.total === 1 ? '' : 's') + ' in time.');
              result.hidden = false;
              if (!link) {
                result.innerHTML = '<h2>Your answers are locked in 🎉</h2>' +
                  '<p>' + summary + '</p>' +
                  '<p>Your points count toward the leaderboard (only your latest attempt at each quiz counts).</p>' +
                  (d.challengeBlocked ? '<p>You’ve attempted this quiz before, so this attempt can’t be used to challenge anyone — only a first attempt can.</p>' : '') +
                  '<p style="margin-top:14px"><a class="cta" href="/quizzes">More quizzes →</a></p>';
                return;
              }
              result.innerHTML =
                '<h2>Your answers are locked in 🎉</h2>' +
                '<p>' + summary + '</p>' +
                '<p>Share this link — <strong>it stays active for 24 hours</strong>, until ' + esc(fmtUntil(d.expiresAt)) + '. ' +
                (d.open
                  ? 'Any getxmatch member can answer it. You’ll see your compatibility with each of them, and each of them sees their own result with you. ' +
                    'You earn <strong>' + d.sharePoints.sharer + ' points</strong> for every member who answers, and they earn <strong>' + d.sharePoints.responder + ' point' + (d.sharePoints.responder === 1 ? '' : 's') + '</strong>.</p>'
                  : d.challenge
                    ? 'Challenge one member who hasn’t taken this quiz yet: they play it in full screen with the same timers. ' +
                      '<strong>Whoever scores more wins the other’s points for this quiz</strong> — if they beat you, you lose your ' + d.points +
                      ' point' + (d.points === 1 ? '' : 's') + ' to them. A tie moves no points. Only one person can accept.</p>'
                    : 'When someone answers it, you’ll both see your compatibility results. If they’re a signed-in member, ' +
                      'you earn <strong>' + d.sharePoints.sharer + ' points</strong> and they earn <strong>' + d.sharePoints.responder + ' points</strong>.</p>') +
                '<div class="gx-share">' +
                '<input type="text" readonly value="' + esc(link) + '" />' +
                '<button type="button" class="cta" id="gxCopy">Copy link</button>' +
                '</div>' +
                '<p style="margin-top:14px"><a class="cta" href="' + esc(link) + '">' + (d.open ? 'See who answered →' : d.challenge ? 'Open the challenge page →' : 'Open the match page →') + '</a></p>';
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
          submitBtn.disabled = false;
          showNote(esc(d.error || 'Could not submit your answers. Please try again.'));
        })
        .catch(function () { finishing = false; submitBtn.disabled = false; showNote('Network error — please try again.'); });
    }
  }
})();
