'use strict';

// Every quiz belongs to one category, chosen by the admin. Points from every
// quiz count toward the overall "Kings & Queens" board; categories with
// `board: true` also get a leaderboard of their own (src/points.js).
const QUIZ_CATEGORIES = [
  { id: 'polymath', label: 'The Grand Polymath', emoji: '🧭', board: true },
  { id: 'think_tank', label: 'The Think Tank', emoji: '💡', board: true },
  { id: 'wordsmith', label: 'The Wordsmith', emoji: '✒️', board: true },
  { id: 'knowledge_vault', label: 'The Knowledge Vault', emoji: '🏛️', board: true },
  { id: 'others', label: 'Others', emoji: '🧩', board: false }, // overall points only
];

const byId = new Map(QUIZ_CATEGORIES.map((c) => [c.id, c]));

function isValidCategory(id) {
  return byId.has(id);
}

function categoryLabel(id) {
  const c = byId.get(id);
  return c ? c.label : null;
}

module.exports = { QUIZ_CATEGORIES, isValidCategory, categoryLabel };
