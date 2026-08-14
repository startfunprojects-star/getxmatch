/* Standalone page for a shared compatibility-quiz link (/m/<token>).
   Works for logged-out recipients — it only talks to the public /api/match/* endpoints. */
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

    if (data.state === 'done') return renderResult(data.result, data.quizTitle, data.isInitiator);
    if (data.state === 'expired') return renderError('This link has expired. Ask your friend to send a fresh one.');
    if (data.state === 'waiting') return renderWaiting(data);
    if (data.state === 'open') return renderForm(data);
    renderError('Something went wrong.');
  }

  function renderError(msg) {
    root.innerHTML = '';
    root.appendChild(el(`<div class="match-empty"><div class="match-emoji">🙈</div><h2>${esc(msg)}</h2></div>`));
  }

  // The initiator opened their own link before anyone answered.
  function renderWaiting(data) {
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="match-empty">
        <div class="match-emoji">⏳</div>
        <h2>Waiting for your match</h2>
        <p class="match-sub">You answered “${esc(data.quizTitle)}”. Share the link with someone and reopen it here once they've answered to reveal your compatibility score.</p>
        <p class="hint">${expiryLine(data.expiresAt)}</p>
        <button class="primary" id="refresh">Refresh</button>
      </div>
    `));
    root.querySelector('#refresh').addEventListener('click', load);
  }

  function expiryLine(expiresAt) {
    const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    return mins > 0 ? `Link active for about ${mins} more minute${mins === 1 ? '' : 's'}.` : 'This link is about to expire.';
  }

  // Responder answers the quiz.
  function renderForm(data) {
    root.innerHTML = '';
    root.appendChild(el(`
      <div class="match-intro">
        <div class="match-emoji">💘</div>
        <h2>${esc(data.aName)} invited you</h2>
        <p class="match-sub">Answer “${esc(data.quizTitle)}” to see how compatible the two of you are.</p>
        ${data.quizDescription ? `<p class="hint">${esc(data.quizDescription)}</p>` : ''}
        <p class="hint">${expiryLine(data.expiresAt)}</p>
      </div>
    `));

    const form = el('<div class="quiz-form"></div>');
    form.appendChild(el(`
      <div class="quiz-q">
        <div class="quiz-prompt">Your name</div>
        <input id="matchName" class="share-input" maxlength="50" placeholder="What should we call you?" />
      </div>
    `));
    data.questions.forEach((q, qi) => {
      const block = el(`<div class="quiz-q"><div class="quiz-prompt">${qi + 1}. ${esc(q.prompt)}</div></div>`);
      q.options.forEach((opt, oi) => {
        block.appendChild(el(`<label class="quiz-opt"><input type="radio" name="q${qi}" value="${oi}" /> <span>${esc(opt)}</span></label>`));
      });
      form.appendChild(block);
    });

    const submit = el('<button class="primary">See our compatibility</button>');
    const msg = el('<div class="msg"></div>');
    form.appendChild(submit);
    form.appendChild(msg);
    root.appendChild(form);

    submit.addEventListener('click', async () => {
      const name = form.querySelector('#matchName').value.trim();
      const answers = data.questions.map((_q, qi) => {
        const sel = form.querySelector(`input[name="q${qi}"]:checked`);
        return sel ? Number(sel.value) : -1;
      });
      if (!name) { msg.className = 'msg error'; msg.textContent = 'Please enter your name.'; return; }
      if (answers.some((a) => a < 0)) { msg.className = 'msg error'; msg.textContent = 'Please answer every question.'; return; }
      submit.disabled = true;
      try {
        const out = await api.post('/api/match/' + encodeURIComponent(token) + '/answer', { name, answers });
        renderResult(out.result, data.quizTitle, false);
      } catch (e) {
        submit.disabled = false;
        msg.className = 'msg error';
        msg.textContent = e.message;
      }
    });
  }

  function renderResult(r, quizTitle, isInitiator) {
    root.innerHTML = '';
    const pct = r.percent;
    const verdict =
      pct >= 80 ? 'You two are a serious match! 🔥' :
      pct >= 50 ? 'Solid compatibility — plenty in common. 😊' :
      pct >= 25 ? 'A few sparks. Opposites can attract! ✨' :
      'Very different tastes — but that keeps it interesting! 🙃';

    root.appendChild(el(`
      <div class="match-result">
        <div class="match-emoji">💘</div>
        <div class="score-ring" style="--pct:${pct}">
          <div class="score-num">${pct}<span>%</span></div>
        </div>
        <h2>${esc(r.aName)} &amp; ${esc(r.bName)}</h2>
        <p class="match-sub">${esc(verdict)}</p>
        <p class="hint">${r.score} of ${r.total} answers in common on “${esc(quizTitle)}”.</p>
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

    if (!isInitiator) {
      root.appendChild(el('<p class="hint" style="text-align:center;margin-top:16px">Want your own matches? <a href="/">Join getxmatch</a>.</p>'));
    }
  }

  load();
})();
