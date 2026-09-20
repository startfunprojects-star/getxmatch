'use strict';

// Profile reporting + account suspension.
//   - A profile that accumulates REPORTS_TO_SUSPEND_PROFILE reports is suspended
//     for SUSPEND_MS (7 days).
//   - A user who files REPORT_ABUSE_LIMIT reports within REPORT_ABUSE_WINDOW_MS
//     (12 hours) is themselves suspended for 7 days (report-spam abuse).
// Reports are deduped one-per-reporter-per-target, so "50 reports" means 50
// distinct people.

const db = require('./db');

const SUSPEND_MS = 7 * 24 * 60 * 60 * 1000;          // 7 days
const REPORTS_TO_SUSPEND_PROFILE = 50;               // reports received
const REPORT_ABUSE_LIMIT = 50;                        // reports filed
const REPORT_ABUSE_WINDOW_MS = 12 * 60 * 60 * 1000;  // 12 hours

// Remaining suspension in ms for a user row (0 = not suspended). Accepts a row
// that has a `suspended_until` field.
function suspensionRemaining(user) {
  if (!user || !user.suspended_until) return 0;
  const remaining = user.suspended_until - Date.now();
  return remaining > 0 ? remaining : 0;
}

function suspend(userId, reason) {
  const until = Date.now() + SUSPEND_MS;
  db.prepare('UPDATE users SET suspended_until = ?, suspended_reason = ? WHERE id = ?').run(until, reason, userId);
  return until;
}

// Record one report (deduped per reporter→reported). Applies the two thresholds.
// Returns { created, reportedSuspended, reporterSuspended, receivedCount }.
function recordReport(reporterId, reportedId, reason) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO reports (reporter_id, reported_id, reason, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(reporter_id, reported_id) DO NOTHING`
    )
    .run(reporterId, reportedId, String(reason || '').slice(0, 500), now);
  const created = info.changes > 0;

  let reportedSuspended = false;
  let reporterSuspended = false;
  let receivedCount = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE reported_id = ?').get(reportedId).n;

  if (created) {
    // Suspend the reported profile once it crosses the threshold (only flip a
    // profile that isn't already serving a suspension).
    if (receivedCount >= REPORTS_TO_SUSPEND_PROFILE) {
      const target = db.prepare('SELECT suspended_until FROM users WHERE id = ?').get(reportedId);
      if (!target || !target.suspended_until || target.suspended_until < now) {
        suspend(reportedId, 'mass-reported');
        reportedSuspended = true;
      }
    }
    // Suspend a report-spamming reporter (too many reports in a short window).
    const filed = db
      .prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at >= ?')
      .get(reporterId, now - REPORT_ABUSE_WINDOW_MS).n;
    if (filed >= REPORT_ABUSE_LIMIT) {
      suspend(reporterId, 'report-abuse');
      reporterSuspended = true;
    }
  }

  return { created, reportedSuspended, reporterSuspended, receivedCount };
}

module.exports = {
  SUSPEND_MS,
  REPORTS_TO_SUSPEND_PROFILE,
  REPORT_ABUSE_LIMIT,
  REPORT_ABUSE_WINDOW_MS,
  suspensionRemaining,
  suspend,
  recordReport,
};
