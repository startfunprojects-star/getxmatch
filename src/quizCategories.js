'use strict';

// Every quiz belongs to one category, chosen by the admin. Each category has
// its own leaderboard (src/points.js), alongside the overall "Kings & Queens"
// board.
const QUIZ_CATEGORIES = [
  { id: 'polymath', label: 'The Grand Polymath', emoji: '🧭' },
  { id: 'think_tank', label: 'The Think Tank', emoji: '💡' },
  { id: 'wordsmith', label: 'The Wordsmith', emoji: '✒️' },
  { id: 'knowledge_vault', label: 'The Knowledge Vault', emoji: '🏛️' },
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
