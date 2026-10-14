/* Standalone page for a shared compatibility-quiz link (/m/<token>).
   Works for logged-out recipients — it only talks to the public /api/match/* endpoints.
   Open links (open compatibility quizzes) can be answered by any registered
   member: the sharer sees every responder's result, a responder sees only
   their own compatibility with the sharer, and guests are asked to log in.
   Standard-quiz links (data.scored) compare how many answers each person got
   right instead of how many they picked in common. Those links are challenges
   (data.challenge): one member who hasn't taken the quiz accepts it and plays
   it in full screen on the quiz page; the winner takes the loser's points. */
(function () {
  'use strict';

  const root = document.getElementById('matchRoot');
  const token = decodeURIComponent(location.pathname.replace(/^\/m\/?/, '').split('/')[0] || '');

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

  async function load() {
    if (!token) return renderError('This link is missing its code.');
    let data;
    try { data = await api.get('/api/match/' + encodeURIComponent(token)); }
    catch (e) { return renderError(e.message); }

    if (data.challenge) return renderChallenge(data);
    if (data.state === 'done') return renderResult(data);
    if (data.state === 'expired') return renderError('This link has expired. Ask your friend to send a fresh one.');
    if (data.state === 'waiting') return renderWaiting(data);
    if (data.state === 'open_owner') return renderOpenOwner(data);
    if (data.state === 'login_required') return renderLoginRequired(data);
    if (data.state === 'open') return renderForm(data);
    renderError('Something went wrong.');
  }

  function renderError(msg) {
    root.innerHTML = '';
    root.appendChild(el(`<div class="match-empty"><div class="match-emoji">🙈</div><h2>${esc(msg)}</h2></div>`));
  }

  // The initiator opened their own link before anyone answered. Auto-poll so the
  // result appears for them the moment their match finishes.
  let pollTimer = null;
  function renderWaiting(data) {
    if (pollTimer) clearTimeout(pollTimer);
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="match-empty">
        <div class="match-emoji">⏳</div>
        <h2>${data.scored ? 'Waiting for your challenger' : 'Waiting for your match'}</h2>
        <p class="match-sub">You answered “${esc(data.quizTitle)}”. Share the link with someone — this page updates automatically the moment they finish, and you’ll both see ${data.scored ? 'who got more answers right' : 'your compatibility results'}.</p>
        ${pointsRule(data.points)}
        <p class="match-expiry">${expiryLine(data.expiresAt, data.ttlHours)}</p>
        <div class="waiting-dots">Listening for your result…</div>
      </div>
    `));
    pollTimer = setTimeout(load, 4000); // re-check every 4s until they answer
  }

  // "This link is active for 24 hours — until 24 Sep, 3:05 pm (23 h 12 min left)."
  function expiryLine(expiresAt, ttlHours) {
    const left = expiresAt - Date.now();
    if (left <= 60000) return '⏳ This link is about to expire.';
    const mins = Math.round(left / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const leftTxt = h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
    let until = '';
    try { until = new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_e) { until = new Date(expiresAt).toLocaleString(); }
    return `⏳ This link is active for ${ttlHours || 24} hours — until ${esc(until)} (${leftTxt} left).`;
  }

  // An open link, viewed by a guest: only registered members can answer.
  function renderLoginRequired(data) {
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="match-empty">
        <div class="match-emoji">🔐</div>
        <h2>${esc(data.aName)} invited you to “${esc(data.quizTitle)}”</h2>
        <p class="match-sub">This is an open compatibility quiz — any getxmatch member can answer it and see how compatible they are with ${esc(data.aName)}.</p>
        <p class="hint">🏆 Answering earns you <strong>${data.points.responder} point${data.points.responder === 1 ? '' : 's'}</strong>, and ${esc(data.aName)} earns ${data.points.sharer}.</p>
        <p style="margin-top:14px"><a class="primary chat-cta" href="/">Log in or join getxmatch</a></p>
        <p class="hint">Then open this link again to answer.</p>
      </div>
    `));
  }

  // The sharer of an open link: everyone who answered, with each person's
  // compatibility. Re-polls while the link is still open.
  function renderOpenOwner(data) {
    if (pollTimer) clearTimeout(pollTimer);
    const openDetails = new Set(
      Array.from(root.querySelectorAll('.open-resp[open]')).map((d) => d.dataset.key)
    );
    root.innerHTML = '';
    const n = data.responses.length;
    root.appendChild(el(`
      <div class="match-empty">
        <div class="match-emoji">👥</div>
        <h2>Your open compatibility quiz</h2>
        <p class="match-sub">You answered “${esc(data.quizTitle)}”. Any getxmatch member with this link can answer it — you’ll see your compatibility with each of them here.</p>
        <p class="hint">🏆 You earn <strong>${data.points.sharer} points</strong> for each member who answers, and they earn ${data.points.responder}.</p>
        <p class="match-expiry">${data.expired ? '⏳ This link has expired — no one new can answer it.' : expiryLine(data.expiresAt, data.ttlHours)}</p>
        <h3 style="margin-top:16px">${n ? `${n} ${n === 1 ? 'person has' : 'people have'} answered` : 'No one has answered yet'}</h3>
        ${!n && !data.expired ? '<div class="waiting-dots">Listening for answers…</div>' : ''}
      </div>
    `));
    const list = el('<div class="breakdown"></div>');
    data.responses.forEach((r) => {
      const key = (r.username || r.bName) + ':' + r.completedAt;
      const item = el(`
        <details class="bd-row open-resp" data-key="${esc(key)}">
          <summary class="bd-answers" style="cursor:pointer">
            <strong style="color:var(--text)">${esc(r.bName)}</strong>
            <span>${r.score} of ${r.total} in common</span>
            <span>${r.pointsAwarded ? `+${data.points.sharer} pts` : 'no points (already earned together)'}</span>
            <span class="bd-mark"><strong style="color:var(--accent)">${r.percent}%</strong></span>
          </summary>
          <div class="open-resp-body" style="margin-top:10px"></div>
        </details>
      `);
      if (openDetails.has(key)) item.open = true;
      const body = item.querySelector('.open-resp-body');
      r.breakdown.forEach((b, i) => {
        body.appendChild(el(`
          <div class="bd-row ${b.match ? 'is-match' : 'no-match'}" style="margin-bottom:6px">
            <div class="bd-q">${i + 1}. ${esc(b.prompt)}</div>
            <div class="bd-answers">
              <span class="bd-a">You: ${esc(b.a == null ? '—' : b.a)}</span>
              <span class="bd-a">${esc(r.bName)}: ${esc(b.b == null ? '—' : b.b)}</span>
              <span class="bd-mark">${b.match ? '✅' : '❌'}</span>
            </div>
          </div>
        `));
      });
      if (r.username) {
        body.appendChild(el(`<a class="primary chat-cta" href="/?chat=${encodeURIComponent(r.username)}">💬 Chat with ${esc(r.bName)}</a>`));
      }
      list.appendChild(item);
    });
    root.appendChild(list);
    if (!data.expired) pollTimer = setTimeout(load, 8000);
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // A standard-quiz challenge, in whatever state it's in.
  function renderChallenge(data) {
    if (pollTimer) clearTimeout(pollTimer);
    if (data.state === 'done') return renderResult(data);
    if (data.state === 'expired') return renderError('This challenge has expired. Ask your friend to send a fresh one.');
    const stakes = `<p class="hint">🏆 Whoever scores more points wins and takes the other’s points for this quiz. A tie moves no points.</p>`;
    root.innerHTML = '';
    if (data.state === 'waiting') {
      root.appendChild(el(`
        <div class="match-empty">
          <div class="match-emoji">⚔️</div>
          <h2>${data.acceptedBy ? `${esc(data.acceptedBy)} accepted your challenge` : 'Waiting for a challenger'}</h2>
          <p class="match-sub">You scored <strong>${plural(data.aPoints, 'point')}</strong> on “${esc(data.quizTitle)}”. ${data.acceptedBy
            ? 'They’re taking the quiz now — this page updates the moment they finish.'
            : 'Share this link with one person who hasn’t taken the quiz yet. Only one person can accept it.'}</p>
          ${stakes}
          ${data.acceptedBy ? '' : `<p class="match-expiry">${data.expired ? '⏳ This link has expired — no one can accept it now.' : expiryLine(data.expiresAt, data.ttlHours)}</p>`}
          ${data.expired && !data.acceptedBy ? '' : '<div class="waiting-dots">Listening for the result…</div>'}
        </div>
      `));
      if (!(data.expired && !data.acceptedBy)) pollTimer = setTimeout(load, 5000);
      return;
    }
    if (data.state === 'login_required') {
      root.appendChild(el(`
        <div class="match-empty">
          <div class="match-emoji">⚔️</div>
          <h2>${esc(data.aName)} challenged you to “${esc(data.quizTitle)}”</h2>
          <p class="match-sub">Outscore ${esc(data.aName)} to win their points. You’ll see both scores at the end.</p>
          ${stakes}
          <p style="margin-top:14px"><a class="primary chat-cta" href="/">Log in or join getxmatch</a></p>
          <p class="hint">Challenges are for members — log in, then open this link again.</p>
        </div>
      `));
      return;
    }
    if (data.state === 'unavailable') {
      root.appendChild(el(`
        <div class="match-empty">
          <div class="match-emoji">🙅</div>
          <h2>${esc(data.reason || 'You can’t accept this challenge.')}</h2>
          <p class="match-sub">“${esc(data.quizTitle)}” — a challenge from ${esc(data.aName)}.</p>
          <p class="hint"><a href="/quizzes">Find a quiz to challenge your own friends →</a></p>
        </div>
      `));
      return;
    }
    // state 'challenge': this member can take it on.
    root.appendChild(el(`
      <div class="match-empty">
        <div class="match-emoji">⚔️</div>
        <h2>${esc(data.aName)} challenged you to “${esc(data.quizTitle)}”</h2>
        <p class="match-sub">Outscore ${esc(data.aName)} to win their points. Their score stays hidden until you finish — then you’ll both see who won.</p>
        ${data.quizDescription ? `<p class="hint">${esc(data.quizDescription)}</p>` : ''}
        ${stakes}
        <p class="hint">You’ll take the same ${plural(data.questionCount, 'question')} in full screen, with the same timers. Only one person can accept this challenge${data.accepted ? ' — you already did, so finish it now' : ''}.</p>
        <p style="margin-top:14px"><a class="primary chat-cta" href="${esc(data.quizUrl)}">${data.accepted ? 'Continue the challenge' : 'Accept the challenge'} →</a></p>
        <p class="match-expiry">${expiryLine(data.expiresAt, data.ttlHours)}</p>
      </div>
    `));
  }

  // How points work for a shared compatibility link.
  function pointsRule(p) {
    if (!p) return '';
    return `<p class="hint">🏆 When a signed-in member finishes the quiz from this link, the person who shared it gets <strong>${p.sharer} points</strong> and the person who answered gets <strong>${p.responder} points</strong>.</p>`;
  }

  // Responder answers the quiz.
  function renderForm(data) {
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="match-intro">
        <div class="match-emoji">🧩</div>
        <h2>${esc(data.aName)} invited you</h2>
        <p class="match-sub">${data.open
          ? `Answer “${esc(data.quizTitle)}” to see how compatible you are with ${esc(data.aName)}. This is an open quiz — other members may answer too, but you’ll only see your own result.`
          : data.scored
            ? `${esc(data.aName)} took “${esc(data.quizTitle)}” — can you get more answers right? You’ll both see the scores.`
            : `Answer “${esc(data.quizTitle)}” to see how compatible the two of you are — you’ll both see the results.`}</p>
        ${data.quizDescription ? `<p class="hint">${esc(data.quizDescription)}</p>` : ''}
        ${data.points ? (data.loggedIn
          ? `<p class="hint">🏆 Finish the quiz to earn <strong>${data.points.responder} points</strong> — and ${esc(data.aName)} earns ${data.points.sharer}.</p>`
          : `<p class="hint">🏆 <a href="/?signup=1">Sign in or join</a> before answering to earn <strong>${data.points.responder} points</strong> (and give ${esc(data.aName)} ${data.points.sharer}). Guests can still play, but no one earns points.</p>`) : ''}
        <p class="match-expiry">${expiryLine(data.expiresAt, data.ttlHours)}</p>
      </div>
    `));

    const form = el('<div class="quiz-form"></div>');
    // Open links are for members only; their getxmatch name is used.
    if (!data.open) {
      form.appendChild(el(`
        <div class="quiz-q">
          <div class="quiz-prompt">Your name</div>
          <input id="matchName" class="share-input" maxlength="50" placeholder="What should we call you?" />
        </div>
      `));
    }
    data.questions.forEach((q, qi) => {
      const block = el(`<div class="quiz-q"><div class="quiz-prompt">${qi + 1}. ${esc(q.prompt)}</div></div>`);
      q.options.forEach((opt, oi) => {
        block.appendChild(el(`<label class="quiz-opt"><input type="radio" name="q${qi}" value="${oi}" /> <span>${esc(opt)}</span></label>`));
      });
      form.appendChild(block);
    });

    const submit = el(`<button class="primary">${data.scored ? 'See who scored more' : 'See our compatibility'}</button>`);
    const msg = el('<div class="msg"></div>');
    form.appendChild(submit);
    form.appendChild(msg);
    root.appendChild(form);

    submit.addEventListener('click', async () => {
      const nameInput = form.querySelector('#matchName');
      const name = nameInput ? nameInput.value.trim() : '';
      const answers = data.questions.map((_q, qi) => {
        const sel = form.querySelector(`input[name="q${qi}"]:checked`);
        return sel ? Number(sel.value) : -1;
      });
      if (nameInput && !name) { msg.className = 'msg error'; msg.textContent = 'Please enter your name.'; return; }
      if (answers.some((a) => a < 0)) { msg.className = 'msg error'; msg.textContent = 'Please answer every question.'; return; }
      submit.disabled = true;
      try {
        const out = await api.post('/api/match/' + encodeURIComponent(token) + '/answer', { name, answers });
        if (!out.quizTitle) out.quizTitle = data.quizTitle;
        renderResult(out);
      } catch (e) {
        submit.disabled = false;
        msg.className = 'msg error';
        msg.textContent = e.message;
      }
    });
  }

  // Result-screen line about the points this link earned.
  function pointsResult(data) {
    const p = data.points;
    if (!p) return '';
    if (p.challenge) {
      if (data.viewer !== 'a' && data.viewer !== 'b') return '';
      if (p.you > 0) return `<p class="match-points">🏆 You won ${plural(p.you, 'point')}!</p>`;
      if (p.you < 0) return `<p class="hint">You lost ${plural(-p.you, 'point')} to your opponent.</p>`;
      return '<p class="hint">No points changed hands.</p>';
    }
    if (p.awarded) {
      if (data.viewer === 'a' || data.viewer === 'b') return `<p class="match-points">🏆 +${p.you} point${p.you === 1 ? '' : 's'} added to your score.</p>`;
      return '';
    }
    if (data.viewer !== 'a' && data.viewer !== 'b') return '';
    if (p.reason === 'repeat' && data.open) return '<p class="hint">No points for this one — you two already earned points together on this quiz.</p>';
    if (p.reason === 'guest') return '<p class="hint">No points for this one — it was answered without a getxmatch account.</p>';
    return '<p class="hint">No points for this one — you two already earned points together on this quiz.</p>';
  }

  // Standard quiz: just the two scores — nothing per question, so the page
  // never gives away which answers were right.
  function renderScored(data) {
    const r = data.result;
    const c = r.challenge;
    const pct = c
      ? (Math.max(c.aPoints, c.bPoints) > 0 ? Math.round((Math.min(Math.max(c.aPoints, 0), Math.max(c.bPoints, 0)) / Math.max(c.aPoints, c.bPoints)) * 100) : 100)
      : r.graded ? Math.round((Math.max(r.aCorrect, r.bCorrect) / r.graded) * 100) : 0;
    // Challenges are decided on points; older links on right answers.
    const verdict = c
      ? (c.forfeit ? `${r.aName} wins — ${r.bName} left the quiz and forfeited. 🏆`
        : c.winner === 'tie' ? 'It’s a tie — no points change hands. 🤝'
        : `${c.winner === 'a' ? r.aName : r.bName} wins${c.transfer ? ` and takes ${plural(c.transfer, 'point')}` : ''}! 🏆`)
      : r.aCorrect === r.bCorrect ? 'It’s a tie! 🤝'
      : `${r.aCorrect > r.bCorrect ? r.aName : r.bName} wins! 🏆`;
    root.appendChild(el(`
      <div class="match-result">
        <div class="match-emoji">🧠</div>
        <div class="score-ring" style="--pct:${pct}">
          <div class="score-num">${c ? c.aPoints : r.aCorrect}<span>–</span>${c ? c.bPoints : r.bCorrect}</div>
        </div>
        <h2>${esc(r.aName)} vs ${esc(r.bName)}</h2>
        <p class="match-sub">${esc(verdict)}</p>
        <p class="hint">On “${esc(data.quizTitle)}”, ${c ? `${esc(r.aName)} scored ${plural(c.aPoints, 'point')} and ${esc(r.bName)} ${plural(c.bPoints, 'point')}.` : `${esc(r.aName)} got ${r.aCorrect} of ${r.graded} right and ${esc(r.bName)} got ${r.bCorrect} of ${r.graded}.`}</p>
        ${pointsResult(data)}
      </div>
    `));
  }

  function renderResult(data) {
    if (pollTimer) clearTimeout(pollTimer);
    const r = data.result;
    const quizTitle = data.quizTitle;
    root.innerHTML = '';
    if (r.scored) {
      renderScored(data);
      renderChatCta(data);
      return;
    }
    const pct = r.percent;
    const verdict =
      pct >= 80 ? 'Great minds think alike! 🎓' :
      pct >= 50 ? 'Strong common ground — plenty to discuss. 📚' :
      pct >= 25 ? 'Some shared ideas, and lots to learn from each other. 💡' :
      'Different perspectives — perfect for a good debate! 🧠';

    root.appendChild(el(`
      <div class="match-result">
        <div class="match-emoji">🧩</div>
        <div class="score-ring" style="--pct:${pct}">
          <div class="score-num">${pct}<span>%</span></div>
        </div>
        <h2>${esc(r.aName)} &amp; ${esc(r.bName)}</h2>
        <p class="match-sub">${esc(verdict)}</p>
        <p class="hint">${r.score} of ${r.total} answers in common on “${esc(quizTitle)}”.</p>
        ${pointsResult(data)}
      </div>
    `));

    const list = el('<div class="breakdown"></div>');
    r.breakdown.forEach((b, i) => {
      list.appendChild(el(`
        <div class="bd-row ${b.match ? 'is-match' : 'no-match'}">
          <div class="bd-q">${i + 1}. ${esc(b.prompt)}</div>
          <div class="bd-answers">
            <span class="bd-a">${esc(r.aName)}: ${esc(b.a == null ? '—' : b.a)}</span>
            <span class="bd-a">${esc(r.bName)}: ${esc(b.b == null ? '—' : b.b)}</span>
            <span class="bd-mark">${b.match ? '✅' : '❌'}</span>
          </div>
        </div>
      `));
    });
    root.appendChild(list);
    renderChatCta(data);
  }

  // Chat call-to-action based on who's viewing and whether they can chat.
  function renderChatCta(data) {
    const chat = data.chat || {};
    const cta = el('<div class="match-cta"></div>');
    if (chat.canChat && chat.otherUsername) {
      cta.appendChild(el(`
        <a class="primary chat-cta" href="/?chat=${encodeURIComponent(chat.otherUsername)}">
          💬 Chat with ${esc(chat.otherName || 'your match')}
        </a>
      `));
      cta.appendChild(el('<p class="hint">Hit it off? Take the conversation into getxmatch.</p>'));
    } else if (chat.needSignup && chat.otherUsername) {
      cta.appendChild(el(`
        <a class="primary chat-cta" href="/?signup=1&chat=${encodeURIComponent(chat.otherUsername)}">
          💬 Sign up to chat with ${esc(chat.otherName || 'your match')}
        </a>
      `));
      cta.appendChild(el('<p class="hint">Create a free getxmatch account to message them and make your own matches.</p>'));
    } else if (data.viewer === 'a') {
      cta.appendChild(el(`<p class="hint">${esc(chat.otherName || 'Your match')} answered as a guest. When they join getxmatch you'll be able to chat.</p>`));
    } else {
      cta.appendChild(el('<p class="hint"><a href="/">Join getxmatch</a> to make your own matches.</p>'));
    }
    root.appendChild(cta);
  }

  load();
})();
