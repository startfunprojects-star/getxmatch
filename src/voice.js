'use strict';

// Server-side voice conversion provider.
//
// Two modes:
//   1. Realistic (opt-in): if VOICE_API_URL + VOICE_API_KEY are set, recorded
//      audio is POSTed to that provider (e.g. an ElevenLabs-style voice
//      changer) and the realistic result is returned. The audio leaves your
//      server for the provider — a privacy trade-off worth noting for an
//      intimate app.
//   2. Fallback (default): no provider configured. convert() returns null,
//      and the CLIENT applies a browser audio effect using the preset's
//      pitch/bright params. This is an effect, not realistic.
const config = require('./config');
const { getVoice } = require('./voices');

function realisticConfigured() {
  return !!(config.voiceApi && config.voiceApi.url && config.voiceApi.key);
}

// Convert `buffer` (recorded audio) toward the given preset. Returns
// { buffer, mime } on success, or null to signal "use the browser fallback".
async function convert(buffer, mime, voiceId) {
  const voice = getVoice(voiceId);
  if (!voice) throw new Error('Unknown voice.');
  if (!realisticConfigured()) return null; // client handles the fallback

  // Generic provider call. The exact contract depends on your provider; this
  // sends the raw audio with the mapped target voice id and expects audio back.
  const target = voice.providerVoice || voice.id;
  const res = await fetch(config.voiceApi.url, {
    method: 'POST',
    headers: {
      'Content-Type': mime || 'application/octet-stream',
      'X-Api-Key': config.voiceApi.key,
      'X-Target-Voice': target,
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Voice provider error (${res.status}).`);
  const out = Buffer.from(await res.arrayBuffer());
  return { buffer: out, mime: res.headers.get('content-type') || mime || 'audio/mpeg' };
}

module.exports = { realisticConfigured, convert };
