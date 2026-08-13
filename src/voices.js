'use strict';

// Catalog of voice-changer presets offered before sending a voice note.
// A user recording a note can morph it toward one of these target voices:
//   - 10 "female" targets (typically chosen by male users)
//   - 10 "male"   targets (typically chosen by female users)
//
// Realism note: `pitch` (semitones) and `bright` (high-shelf dB) drive the
// built-in BROWSER fallback, which is an audio *effect* — deeper/brighter, not
// a truly realistic different person. For realistic conversion, set
// VOICE_API_URL + VOICE_API_KEY (see src/voice.js); each preset's
// `providerVoice` then maps to a real voice on that provider.
const FEMALE_VOICES = [
  { id: 'f-aria',   name: 'Aria',   pitch: 4, bright: 3, providerVoice: null },
  { id: 'f-bella',  name: 'Bella',  pitch: 5, bright: 4, providerVoice: null },
  { id: 'f-chloe',  name: 'Chloe',  pitch: 6, bright: 3, providerVoice: null },
  { id: 'f-diana',  name: 'Diana',  pitch: 5, bright: 5, providerVoice: null },
  { id: 'f-elena',  name: 'Elena',  pitch: 7, bright: 2, providerVoice: null },
  { id: 'f-fiona',  name: 'Fiona',  pitch: 4, bright: 6, providerVoice: null },
  { id: 'f-grace',  name: 'Grace',  pitch: 6, bright: 4, providerVoice: null },
  { id: 'f-hana',   name: 'Hana',   pitch: 5, bright: 6, providerVoice: null },
  { id: 'f-ivy',    name: 'Ivy',    pitch: 7, bright: 5, providerVoice: null },
  { id: 'f-jade',   name: 'Jade',   pitch: 6, bright: 6, providerVoice: null },
];

const MALE_VOICES = [
  { id: 'm-atlas',  name: 'Atlas',  pitch: -5, bright: -3, providerVoice: null },
  { id: 'm-bruno',  name: 'Bruno',  pitch: -6, bright: -4, providerVoice: null },
  { id: 'm-cole',   name: 'Cole',   pitch: -4, bright: -2, providerVoice: null },
  { id: 'm-dexter', name: 'Dexter', pitch: -7, bright: -5, providerVoice: null },
  { id: 'm-ethan',  name: 'Ethan',  pitch: -5, bright: -2, providerVoice: null },
  { id: 'm-felix',  name: 'Felix',  pitch: -6, bright: -3, providerVoice: null },
  { id: 'm-gunnar', name: 'Gunnar', pitch: -7, bright: -6, providerVoice: null },
  { id: 'm-hank',   name: 'Hank',   pitch: -4, bright: -4, providerVoice: null },
  { id: 'm-ivan',   name: 'Ivan',   pitch: -6, bright: -5, providerVoice: null },
  { id: 'm-jax',    name: 'Jax',    pitch: -5, bright: -6, providerVoice: null },
];

const VOICES = [
  ...FEMALE_VOICES.map((v) => ({ ...v, gender: 'female' })),
  ...MALE_VOICES.map((v) => ({ ...v, gender: 'male' })),
];

const byId = new Map(VOICES.map((v) => [v.id, v]));

function getVoice(id) {
  return byId.get(id) || null;
}

module.exports = { VOICES, FEMALE_VOICES, MALE_VOICES, getVoice };
