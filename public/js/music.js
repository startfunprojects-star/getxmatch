/* Background music for gallery photos and reels.
   Every track is composed right here with the Web Audio API — chords, bass,
   melody and drums from oscillators and noise — so there are no audio files
   and nothing to license: the music is original and royalty-free.

   gxmMusic.TRACKS            → [{ id, name, emoji }]
   gxmMusic.play(id, opts)    → { stop() }  loops until stopped
     opts.ctx          an AudioContext to use (default: a shared one)
     opts.destination  node to play into (default: the speakers)
     opts.volume       0-1 (default 0.5)
   Track ids must match MUSIC_TRACKS in src/profileFields.js. */
window.gxmMusic = (function () {
  const TRACKS = [
    { id: 'chill', name: 'Chill vibes', emoji: '🌴' },
    { id: 'upbeat', name: 'Upbeat pop', emoji: '🎉' },
    { id: 'lofi', name: 'Lo-fi beats', emoji: '☕' },
    { id: 'romantic', name: 'Romantic piano', emoji: '💞' },
    { id: 'dreamy', name: 'Dreamy night', emoji: '🌙' },
  ];

  // Chords are MIDI note lists, one per bar (16 sixteenth-note steps).
  // `arp` indexes into the chord (-1 = rest); drums are 16-step patterns.
  const SONGS = {
    chill: {
      bpm: 92, pad: 'triangle', lead: 'triangle', cutoff: 1800,
      chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
      arp: [0, -1, 1, -1, 2, -1, 1, -1, 0, -1, 2, -1, 1, -1, 2, -1], arpOct: 12,
      kick: 'x.......x.......', snare: '....x.......x...', hat: '..x...x...x...x.',
    },
    upbeat: {
      bpm: 122, pad: 'sawtooth', lead: 'square', cutoff: 2600,
      chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]],
      arp: [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 2, 1, 0, 1], arpOct: 12,
      kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.',
    },
    lofi: {
      bpm: 76, pad: 'triangle', lead: 'sine', cutoff: 1100, swing: 0.18,
      chords: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [57, 60, 64, 67]],
      arp: [3, -1, -1, 2, -1, -1, 1, -1, -1, -1, 2, -1, 0, -1, -1, -1], arpOct: 12,
      kick: 'x.....x...x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    },
    romantic: {
      bpm: 68, pad: 'sine', lead: 'piano', cutoff: 2200,
      chords: [[48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]],
      arp: [0, 1, 2, 1, 2, 1, 0, 1, 0, 1, 2, 1, 2, 1, 0, 1], arpOct: 24,
      kick: '................', snare: '................', hat: '................',
    },
    dreamy: {
      bpm: 80, pad: 'sawtooth', lead: 'bell', cutoff: 900,
      chords: [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]],
      arp: [3, -1, -1, -1, -1, -1, 2, -1, -1, -1, 1, -1, -1, -1, -1, -1], arpOct: 12,
      kick: 'x...............', snare: '................', hat: '......x.......x.',
    },
  };

  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let shared = null;
  let noiseBuf = null;

  function getCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!shared) shared = new AC();
    if (shared.state === 'suspended') shared.resume().catch(() => {});
    return shared;
  }

  function noise(ctx) {
    if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function play(id, opts) {
    const song = SONGS[id];
    if (!song) return { stop() {} };
    opts = opts || {};
    const ctx = opts.ctx || getCtx();
    const master = ctx.createGain();
    master.gain.value = opts.volume == null ? 0.5 : opts.volume;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp);
    comp.connect(opts.destination || ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = song.cutoff;
    filter.connect(master);

    const step = 60 / song.bpm / 4; // one sixteenth note
    const env = (g, t, a, peak, d) => {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    };
    const tone = (type, freq, t, a, peak, d, out) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      o.connect(g);
      g.connect(out || filter);
      env(g, t, a, peak, d);
      o.start(t);
      o.stop(t + a + d + 0.05);
    };
    const pad = (notes, t, len) => notes.forEach((n) => {
      tone(song.pad, hz(n), t, 0.4, 0.05, len, filter);
      tone(song.pad, hz(n) * 1.004, t, 0.4, 0.035, len, filter); // detuned double
    });
    const lead = (m, t) => {
      if (song.lead === 'piano') { tone('triangle', hz(m), t, 0.005, 0.12, 1.1, master); tone('sine', hz(m) * 2, t, 0.005, 0.03, 0.5, master); }
      else if (song.lead === 'bell') { tone('sine', hz(m), t, 0.005, 0.1, 1.6, master); tone('sine', hz(m) * 2.76, t, 0.005, 0.03, 0.6, master); }
      else tone(song.lead, hz(m), t, 0.01, song.lead === 'square' ? 0.035 : 0.08, step * 1.8, filter);
    };
    const kick = (t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      o.connect(g);
      g.connect(master);
      env(g, t, 0.003, 0.9, 0.25);
      o.start(t);
      o.stop(t + 0.3);
    };
    const hiss = (t, type, freq, peak, d) => {
      const s = ctx.createBufferSource();
      s.buffer = noise(ctx);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ctx.createGain();
      s.connect(f);
      f.connect(g);
      g.connect(master);
      env(g, t, 0.002, peak, d);
      s.start(t, Math.random() * 0.5);
      s.stop(t + d + 0.05);
    };

    let n = 0; // absolute step counter
    let next = ctx.currentTime + 0.08;
    function schedule() {
      while (next < ctx.currentTime + 0.2) {
        const s = n % 16;
        const bar = Math.floor(n / 16) % song.chords.length;
        const chord = song.chords[bar];
        const t = next + (song.swing && s % 2 ? step * song.swing : 0);
        if (s === 0) {
          pad(chord, t, step * 15);
          tone('triangle', hz(chord[0] - 12), t, 0.01, 0.22, step * 7, master); // bass
          tone('triangle', hz(chord[0] - 12), t + step * 8, 0.01, 0.18, step * 6, master);
        }
        const a = song.arp[s];
        if (a >= 0 && chord[a] != null) lead(chord[a] + song.arpOct, t);
        if (song.kick[s] === 'x') kick(t);
        if (song.snare[s] === 'x') hiss(t, 'bandpass', 1800, 0.35, 0.18);
        if (song.hat[s] === 'x') hiss(t, 'highpass', 7000, 0.12, 0.05);
        n++;
        next += step;
      }
    }
    schedule();
    const timer = setInterval(schedule, 25);
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0, t + 0.25);
        setTimeout(() => { try { comp.disconnect(); } catch (_e) { /* already gone */ } }, 400);
      },
    };
  }

  const byId = (id) => TRACKS.find((t) => t.id === id) || null;
  return { TRACKS, play, byId, getCtx };
})();
