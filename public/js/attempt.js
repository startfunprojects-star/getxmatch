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

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    var data = null;
    try { data = await res.json(); } catch (_e) {}
    return { status: res.status, data: data };
  }

  /* -------------------------------------------------- Poll ------------------ */
  if (kind === 'poll') {
    var closed = root.getAttribute('data-closed') === '1';

    function paintPoll(poll) {
      var total = poll.total || 0;
      var btns = root.querySelectorAll('.gx-opt');
      for (var i = 0; i < btns.length; i++) {
        var n = (poll.counts && poll.counts[i]) || 0;
        var pct = total ? Math.round((n / total) * 100) : 0;
        var bar = btns[i].querySelector('.gx-opt-bar');
        var meta = btns[i].querySelector('.gx-opt-meta');
        if (bar) bar.style.width = pct + '%';
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
  if (kind === 'quiz') {
    var form = document.getElementById('gxQuizForm');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fieldsets = form.querySelectorAll('.gx-q');
      var answers = [];
      var missing = false;
      for (var i = 0; i < fieldsets.length; i++) {
        var picked = fieldsets[i].querySelector('input[type="radio"]:checked');
        if (!picked) { missing = true; break; }
        answers.push(parseInt(picked.value, 10));
      }
      if (missing) { showNote('Please answer every question before submitting.'); return; }
      if (!loggedIn) { promptRegister('take this quiz'); return; }

      var submitBtn = form.querySelector('.gx-submit');
      if (submitBtn) submitBtn.disabled = true;
      if (note) note.hidden = true;

      postJson('/api/content/quizzes/' + id + '/match', { answers: answers })
        .then(function (r) {
          if (r.status === 401) { loggedIn = false; if (submitBtn) submitBtn.disabled = false; promptRegister('take this quiz'); return; }
          if (r.status >= 200 && r.status < 300 && r.data && r.data.token) {
            var link = window.location.origin + '/m/' + r.data.token;
            var result = root.querySelector('.gx-result');
            form.hidden = true;
            var hint = root.querySelector('.gx-hint');
            if (hint) hint.hidden = true;
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
          if (submitBtn) submitBtn.disabled = false;
          showNote(esc((r.data && r.data.error) || 'Could not submit your answers. Please try again.'));
        })
        .catch(function () { if (submitBtn) submitBtn.disabled = false; showNote('Network error — please try again.'); });
    });
  }
})();
