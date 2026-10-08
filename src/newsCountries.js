'use strict';

// The country each member gets alerts and news for on Recent Activity.
//
// Members pick it from the Alerts panel (stored in profiles.news_country); until
// they do, their profile country is used. 'Worldwide' means no country: alerts
// from every country fetched, and news from the international feeds only.
// Each country maps to its Google News edition [hl, gl, ceid] — English
// editions where Google has one, the local-language edition otherwise.

const db = require('./db');

const WORLDWIDE = 'Worldwide';

const EDITIONS = {
  Afghanistan: ['en', 'AF', 'AF:en'],
  Albania: ['en', 'AL', 'AL:en'],
  Algeria: ['fr', 'DZ', 'DZ:fr'],
  Argentina: ['es-419', 'AR', 'AR:es-419'],
  Australia: ['en-AU', 'AU', 'AU:en'],
  Austria: ['de-AT', 'AT', 'AT:de'],
  Bangladesh: ['bn', 'BD', 'BD:bn'],
  Belgium: ['fr', 'BE', 'BE:fr'],
  Brazil: ['pt-BR', 'BR', 'BR:pt-419'],
  Bulgaria: ['bg', 'BG', 'BG:bg'],
  Canada: ['en-CA', 'CA', 'CA:en'],
  Chile: ['es-419', 'CL', 'CL:es-419'],
  China: ['zh-CN', 'CN', 'CN:zh-Hans'],
  Colombia: ['es-419', 'CO', 'CO:es-419'],
  Croatia: ['en', 'HR', 'HR:en'],
  Czechia: ['cs', 'CZ', 'CZ:cs'],
  Denmark: ['en', 'DK', 'DK:en'],
  Egypt: ['ar', 'EG', 'EG:ar'],
  Finland: ['fi', 'FI', 'FI:fi'],
  France: ['fr', 'FR', 'FR:fr'],
  Germany: ['de', 'DE', 'DE:de'],
  Ghana: ['en-GH', 'GH', 'GH:en'],
  Greece: ['el', 'GR', 'GR:el'],
  Hungary: ['hu', 'HU', 'HU:hu'],
  Iceland: ['en', 'IS', 'IS:en'],
  India: ['en-IN', 'IN', 'IN:en'],
  Indonesia: ['en-ID', 'ID', 'ID:en'],
  Iran: ['en', 'IR', 'IR:en'],
  Iraq: ['ar', 'IQ', 'IQ:ar'],
  Ireland: ['en-IE', 'IE', 'IE:en'],
  Israel: ['en-IL', 'IL', 'IL:en'],
  Italy: ['it', 'IT', 'IT:it'],
  Japan: ['ja', 'JP', 'JP:ja'],
  Jordan: ['ar', 'JO', 'JO:ar'],
  Kenya: ['en-KE', 'KE', 'KE:en'],
  Malaysia: ['en-MY', 'MY', 'MY:en'],
  Mexico: ['es-419', 'MX', 'MX:es-419'],
  Nepal: ['en', 'NP', 'NP:en'],
  Netherlands: ['nl', 'NL', 'NL:nl'],
  'New Zealand': ['en-NZ', 'NZ', 'NZ:en'],
  Nigeria: ['en-NG', 'NG', 'NG:en'],
  Norway: ['no', 'NO', 'NO:no'],
  Pakistan: ['en-PK', 'PK', 'PK:en'],
  Peru: ['es-419', 'PE', 'PE:es-419'],
  Philippines: ['en-PH', 'PH', 'PH:en'],
  Poland: ['pl', 'PL', 'PL:pl'],
  Portugal: ['pt-PT', 'PT', 'PT:pt-150'],
  Qatar: ['ar', 'QA', 'QA:ar'],
  Romania: ['ro', 'RO', 'RO:ro'],
  Russia: ['ru', 'RU', 'RU:ru'],
  'Saudi Arabia': ['ar', 'SA', 'SA:ar'],
  Singapore: ['en-SG', 'SG', 'SG:en'],
  'South Africa': ['en-ZA', 'ZA', 'ZA:en'],
  'South Korea': ['ko', 'KR', 'KR:ko'],
  Spain: ['es', 'ES', 'ES:es'],
  'Sri Lanka': ['en', 'LK', 'LK:en'],
  Sweden: ['sv', 'SE', 'SE:sv'],
  Switzerland: ['de', 'CH', 'CH:de'],
  Thailand: ['th', 'TH', 'TH:th'],
  Turkey: ['tr', 'TR', 'TR:tr'],
  Ukraine: ['uk', 'UA', 'UA:uk'],
  'United Arab Emirates': ['ar', 'AE', 'AE:ar'],
  'United Kingdom': ['en-GB', 'GB', 'GB:en'],
  'United States': ['en-US', 'US', 'US:en'],
  Vietnam: ['vi', 'VN', 'VN:vi'],
};

const COUNTRIES = Object.keys(EDITIONS).sort((a, b) => a.localeCompare(b));
// Countries refreshed in the background (the ones most members use). A country
// outside this set still gets one fetch when a member picks it.
const MAX_ACTIVE_COUNTRIES = 30;

const isCountry = (c) => Object.prototype.hasOwnProperty.call(EDITIONS, c);

// "hl=…&gl=…&ceid=…" for a country's Google News edition.
function editionQuery(country) {
  const [hl, gl, ceid] = EDITIONS[country] || EDITIONS.India;
  return `hl=${encodeURIComponent(hl)}&gl=${gl}&ceid=${encodeURIComponent(ceid)}`;
}

function effective(newsCountry, profileCountry) {
  if (newsCountry === WORLDWIDE || isCountry(newsCountry)) return newsCountry;
  return isCountry(profileCountry) ? profileCountry : WORLDWIDE;
}

// { country, chosen } for a member: the country in use, and whether they picked
// it themselves (false = following their profile country).
function forUser(userId) {
  const r = db.prepare('SELECT country, news_country FROM profiles WHERE user_id = ?').get(userId);
  const chosen = !!(r && r.news_country && (r.news_country === WORLDWIDE || isCountry(r.news_country)));
  return { country: effective(r && r.news_country, r && r.country), chosen };
}

// Save a member's pick ('' / null = follow the profile country again).
function setForUser(userId, country) {
  const v = country === WORLDWIDE || isCountry(country) ? country : null;
  db.prepare('UPDATE profiles SET news_country = ? WHERE user_id = ?').run(v, userId);
  return forUser(userId);
}

// Countries members use, most members first.
function inUse(limit = MAX_ACTIVE_COUNTRIES) {
  const counts = new Map();
  db.prepare('SELECT country, news_country FROM profiles').all().forEach((r) => {
    const c = effective(r.news_country, r.country);
    if (c !== WORLDWIDE) counts.set(c, (counts.get(c) || 0) + 1);
  });
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([c]) => c);
}

module.exports = { WORLDWIDE, COUNTRIES, isCountry, editionQuery, forUser, setForUser, inUse };
