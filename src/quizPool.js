'use strict';

// Question pools for standard quizzes.
//
// Besides its own questions, a standard quiz can have a pool of extra
// questions (each a prompt, its options and the correct option). Once the
// pool has at least POOL_MIN_ACTIVE questions it is active: every attempt
// then swaps a random number of the quiz's questions — at least 30% of them
// (3 of 10) and at most all of them — for random pool questions.
//
//   - A pool question takes the place (and the points and time limit) of the
//     quiz question it replaces, so every attempt is worth the same points.
//   - A pool question is used at most once per attempt, and never alongside
//     a quiz question with the same prompt.
//   - The attempt's question list is stored on its proctor session
//     (quiz_proctor_sessions.served), so scoring always uses the questions
//     that member was actually shown.

const crypto = require('crypto');

const POOL_MIN_ACTIVE = 20;
const POOL_MAX = 500;
const MIN_REPLACE_SHARE = 0.3;

const promptKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Validate + normalise a pool from the admin. Returns { value } or { error }.
// `questions` are the quiz's own (already normalised) questions.
function normalizePool(raw, questions) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch (_e) { arr = null; }
  }
  if (arr == null) return { value: [] };
  if (!Array.isArray(arr)) return { error: 'The question pool is not valid.' };
  if (arr.length > POOL_MAX) return { error: `A question pool can hold at most ${POOL_MAX} questions.` };
  const quizPrompts = new Set((questions || []).map((q) => promptKey(q.prompt)));
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const q = arr[i];
    const n = i + 1;
    const prompt = (q && typeof q.prompt === 'string' ? q.prompt : '').trim();
    const options = Array.isArray(q && q.options) ? q.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 8) : [];
    if (!prompt) return { error: `Pool question ${n} needs a prompt.` };
    if (options.length < 2) return { error: `Pool question ${n} needs at least two options.` };
    const answer = Number(q.answer == null || q.answer === '' ? NaN : q.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) {
      return { error: `Please mark the correct answer for pool question ${n}.` };
    }
    const key = promptKey(prompt);
    if (quizPrompts.has(key)) return { error: `Pool question ${n} is the same as one of the quiz’s questions.` };
    if (seen.has(key)) return { error: `Pool question ${n} repeats an earlier pool question.` };
    seen.add(key);
    out.push({ prompt: prompt.slice(0, 300), options, answer });
  }
  return { value: out };
}

function isActive(pool) {
  return Array.isArray(pool) && pool.length >= POOL_MIN_ACTIVE;
}

// A random permutation of 0..n-1 (Fisher–Yates).
function shuffled(n) {
  const a = Array.from({ length: n }, (_v, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The question list for one new attempt, or null when the pool isn't active
// (the attempt then uses the quiz's questions as they are). Each served
// question keeps its slot's points and time limit and carries `qid`: 'q<i>'
// for the quiz's own question i, 'p<j>' for pool question j.
function buildServed(questions, pool) {
  const n = Array.isArray(questions) ? questions.length : 0;
  if (!n || !isActive(pool)) return null;
  const quizPrompts = new Set(questions.map((q) => promptKey(q.prompt)));
  // Usable pool questions: each prompt once, none matching a quiz question.
  const seen = new Set();
  const candidates = [];
  pool.forEach((p, j) => {
    const key = promptKey(p && p.prompt);
    const opts = Array.isArray(p && p.options) ? p.options : [];
    if (!key || opts.length < 2 || quizPrompts.has(key) || seen.has(key)) return;
    if (!Number.isInteger(p.answer) || p.answer < 0 || p.answer >= opts.length) return;
    seen.add(key);
    candidates.push(j);
  });
  const maxK = Math.min(n, candidates.length);
  if (!maxK) return null;
  const minK = Math.min(maxK, Math.max(1, Math.ceil(n * MIN_REPLACE_SHARE)));
  const k = minK + crypto.randomInt(maxK - minK + 1);
  const slots = shuffled(n).slice(0, k);
  const picks = shuffled(candidates.length).slice(0, k).map((c) => candidates[c]);
  const served = questions.map((q, i) => ({ ...q, qid: 'q' + i }));
  slots.forEach((slot, t) => {
    const j = picks[t];
    const p = pool[j];
    const orig = questions[slot];
    served[slot] = {
      prompt: p.prompt,
      options: p.options.slice(),
      answer: p.answer,
      points: orig.points,
      seconds: orig.seconds,
      qid: 'p' + j,
    };
  });
  return served;
}

module.exports = { POOL_MIN_ACTIVE, POOL_MAX, MIN_REPLACE_SHARE, normalizePool, isActive, buildServed };
