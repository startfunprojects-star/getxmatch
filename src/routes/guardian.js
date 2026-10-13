'use strict';

// Parent / guardian pages (src/guardian.js). No login: the private token in
// the URL (sent only to the parent's email) is the key. Plain forms, no
// scripts, so they work in any email app's browser.
//
//   GET  /guardian/confirm/:token   confirm the link (a button, so email
//   POST /guardian/confirm/:token   scanners that open links don't confirm it)
//   GET  /guardian/:token           parent controls
//   POST /guardian/:token/settings | /approve/:fid | /decline/:fid | /unlink

const express = require('express');
const seo = require('../seo');
const guardian = require('../guardian');

const router = express.Router();
const esc = seo.esc;

// Never cache or index these pages, and don't leak the token in Referer.
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const STYLE = `<style>
.gd h1{font-size:26px;margin:8px 0 6px}
.gd .lead{color:var(--muted);margin:0 0 18px}
.gd form{margin:0}
.gd .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.gd .btn{font:inherit;font-weight:700;border-radius:999px;padding:9px 18px;border:1px solid var(--border);background:var(--bg2);color:var(--text);cursor:pointer}
.gd .btn.primary{background:var(--grad);color:#fff;border-color:transparent}
.gd .btn.danger{color:#b3261e;border-color:#e6b8b5}
.gd label.check{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;cursor:pointer}
.gd label.check input{margin-top:4px;width:18px;height:18px}
.gd .note{padding:10px 14px;border-radius:10px;background:color-mix(in srgb,var(--accent) 10%,transparent);margin:0 0 16px}
.gd .muted{color:var(--muted);font-size:14px}
.gd .card:hover{transform:none}
</style>`;

function page(res, title, body, status = 200) {
  const seoDescriptor = seo.resolveSeo({ noindex: true, nofollow: true }, { canonicalPath: '/', title, description: 'Parent controls on getxmatch.' });
  res.status(status).type('html').send(seo.renderDocument({ seoDescriptor, jsonLd: null, bodyHtml: `${STYLE}<div class="gd">${body}</div>` }));
}

function notFound(res) {
  page(res, 'Link not valid', `<h1>This link isn't valid any more</h1>
    <p class="lead">It may have been replaced by a newer email, or the parent link was removed. Use the newest email from getxmatch, or ask your child to add you again in their Account settings.</p>`, 404);
}

/* ------------------------------- confirmation ------------------------------- */

router.get('/confirm/:token', (req, res) => {
  page(res, 'Confirm parent controls', `<h1>Confirm parent controls</h1>
    <p class="lead">Confirm that you are the parent or guardian of the getxmatch member who added your email address.</p>
    <div class="card">
      <p>Once confirmed you can approve or decline new friends before they connect with your child, and you get a short weekly summary of their activity. You will never see their private messages.</p>
      <form method="post"><button class="btn primary" type="submit">Yes, I'm their parent or guardian</button></form>
    </div>
    <p class="muted">Don't know this person? Just close this page. Nothing is linked until you confirm.</p>`);
});

router.post('/confirm/:token', (req, res) => {
  const g = guardian.confirm(req.params.token);
  if (!g) return notFound(res);
  res.redirect(303, `/guardian/${encodeURIComponent(g.manage_token)}?done=confirmed`);
});

/* ------------------------------ parent controls ------------------------------ */

const NOTES = {
  confirmed: 'Thank you. Parent controls are now on. Bookmark this page, or use the link in any email from getxmatch to come back.',
  saved: 'Your settings were saved.',
  approved: 'Approved. They are now friends.',
  declined: 'Declined. The friend request was removed.',
};

function load(req, res) {
  const g = guardian.byManageToken(req.params.token);
  if (!g || g.status !== 'active') { notFound(res); return null; }
  return g;
}

router.get('/:token', (req, res) => {
  const g = load(req, res);
  if (!g) return;
  const c = guardian.child(g.user_id) || { name: 'your child', username: '' };
  const pending = guardian.pendingFor(g.user_id);
  const s = guardian.weeklyStats(g.user_id, Date.now() - 7 * 24 * 60 * 60 * 1000);
  const base = `/guardian/${encodeURIComponent(req.params.token)}`;
  const note = NOTES[req.query.done];

  const requests = pending.length
    ? pending.map((p) => `<div class="card"><div class="row">
        <div><b>${esc(p.name)}</b>${p.username ? ` <span class="muted">@${esc(p.username)}</span>` : ''}${p.country ? `<div class="muted">${esc(p.country)}</div>` : ''}
          <div class="muted">Waiting since ${esc(new Date(p.at).toDateString())}</div></div>
        <div class="row" style="justify-content:flex-end">
          <form method="post" action="${base}/approve/${p.friendshipId}"><button class="btn primary" type="submit">Approve</button></form>
          <form method="post" action="${base}/decline/${p.friendshipId}"><button class="btn" type="submit">Decline</button></form>
        </div></div></div>`).join('')
    : '<p class="muted">Nothing is waiting for you.</p>';

  page(res, 'Parent controls', `
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
    ${g.removal_requested_at ? `<div class="note">${esc(c.name)} asked to remove parent controls. Nothing changes unless you remove them below.</div>` : ''}
    <h1>Parent controls for ${esc(c.name)}</h1>
    <p class="lead">@${esc(c.username)} on getxmatch. These controls end automatically when they turn 18.</p>

    <h2>Friend requests waiting for you</h2>
    ${requests}

    <h2>This week</h2>
    <div class="card">
      <p>${s.newFriends.length ? `New friends: ${esc(s.newFriends.join(', '))}` : 'No new friends this week.'}</p>
      <p class="muted">Quizzes taken: ${s.quizzes} · Highway posts: ${s.posts} · Blogs published: ${s.blogs} · Chat messages sent: ${s.messages} · Points: ${s.points}</p>
      <p class="muted">Message contents are private and never shown.</p>
    </div>

    <h2>Settings</h2>
    <form class="card" method="post" action="${base}/settings">
      <label class="check"><input type="checkbox" name="approveFriends" value="1" ${g.approve_friends ? 'checked' : ''} />
        <span><b>Approve new friends</b><br><span class="muted">New friendships wait for your approval before they can chat.</span></span></label>
      <label class="check"><input type="checkbox" name="weeklySummary" value="1" ${g.weekly_summary ? 'checked' : ''} />
        <span><b>Weekly summary email</b><br><span class="muted">Sent to ${esc(g.email)} once a week.</span></span></label>
      <button class="btn primary" type="submit">Save settings</button>
    </form>

    <h2>Remove parent controls</h2>
    <form class="card" method="post" action="${base}/unlink">
      <p class="muted">Stops approvals and weekly emails, and approves anything still waiting for you. ${esc(c.name)} can add a parent again later.</p>
      <button class="btn danger" type="submit">Remove parent controls</button>
    </form>`);
});

router.post('/:token/settings', (req, res) => {
  const g = load(req, res);
  if (!g) return;
  guardian.updateSettings(g.user_id, {
    approveFriends: req.body && req.body.approveFriends === '1',
    weeklySummary: req.body && req.body.weeklySummary === '1',
  });
  res.redirect(303, `/guardian/${encodeURIComponent(req.params.token)}?done=saved`);
});

router.post('/:token/approve/:fid', (req, res) => {
  const g = load(req, res);
  if (!g) return;
  guardian.approve(g.user_id, parseInt(req.params.fid, 10));
  res.redirect(303, `/guardian/${encodeURIComponent(req.params.token)}?done=approved`);
});

router.post('/:token/decline/:fid', (req, res) => {
  const g = load(req, res);
  if (!g) return;
  guardian.decline(g.user_id, parseInt(req.params.fid, 10));
  res.redirect(303, `/guardian/${encodeURIComponent(req.params.token)}?done=declined`);
});

router.post('/:token/unlink', (req, res) => {
  const g = load(req, res);
  if (!g) return;
  const c = guardian.child(g.user_id) || { name: 'your child' };
  guardian.unlink(g.user_id);
  page(res, 'Parent controls removed', `<h1>Parent controls removed</h1>
    <p class="lead">You are no longer linked to ${esc(c.name)} on getxmatch and won't get any more emails about their account.</p>`);
});

module.exports = router;
