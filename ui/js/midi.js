import { mediaUrl } from './api.js';

const MIDI_EXTS = new Set(['mid', 'midi', 'rmi', 'kar']);
const SAMPLE_RATE = 44100;
const MAX_DURATION = 600;
const CHUNK = 16 * 1024 * 1024;
const MAX_MIDI = 32 * 1024 * 1024;
const RENDER_CACHE = 6;

const renderCache = new Map();

export function isMidiPath(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return MIDI_EXTS.has(ext);
}

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

async function fetchRange(path, start, end) {
  const res = await fetch(mediaUrl(path), { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) throw new Error(`Read failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function readBytes(path) {
  const head = await fetch(mediaUrl(path), { method: 'HEAD' });
  const total = Math.min(Number(head.headers.get('content-length')) || 0, MAX_MIDI);
  if (!total) {
    const res = await fetch(mediaUrl(path));
    return res.arrayBuffer();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK - 1, total - 1);
    const part = await fetchRange(path, offset, end);
    if (!part.length) break;
    out.set(part.subarray(0, end - offset + 1), offset);
    offset += part.length;
  }
  return out.buffer;
}

function parseTrack(bytes) {
  const events = [];
  let p = 0;
  let tick = 0;
  let running = 0;
  const varlen = () => {
    let value = 0;
    let byte;
    do {
      byte = bytes[p++];
      value = (value << 7) | (byte & 0x7f);
    } while (byte & 0x80 && p < bytes.length);
    return value;
  };
  while (p < bytes.length) {
    tick += varlen();
    let status = bytes[p];
    if (status & 0x80) { p += 1; running = status; } else { status = running; }
    if (!status) break;
    const type = status & 0xf0;
    const chan = status & 0x0f;
    if (status === 0xff) {
      const metaType = bytes[p++];
      const len = varlen();
      const data = bytes.subarray(p, p + len);
      p += len;
      if (metaType === 0x51 && len >= 3) {
        events.push({ tick, kind: 'tempo', us: (data[0] << 16) | (data[1] << 8) | data[2] });
      }
    } else if (status === 0xf0 || status === 0xf7) {
      p += varlen();
    } else if (type === 0x80) {
      const key = bytes[p++]; const vel = bytes[p++];
      events.push({ tick, kind: 'off', chan, key, vel });
    } else if (type === 0x90) {
      const key = bytes[p++]; const vel = bytes[p++];
      events.push({ tick, kind: vel === 0 ? 'off' : 'on', chan, key, vel });
    } else if (type === 0xb0) {
      const ctrl = bytes[p++]; const val = bytes[p++];
      events.push({ tick, kind: 'cc', chan, ctrl, val });
    } else if (type === 0xc0) {
      events.push({ tick, kind: 'program', chan, prog: bytes[p++] });
    } else if (type === 0xe0) {
      const l = bytes[p++]; const h = bytes[p++];
      events.push({ tick, kind: 'bend', chan, value: (h << 7) | l });
    } else if (type === 0xa0) {
      p += 2;
    } else if (type === 0xd0) {
      p += 1;
    } else {
      break;
    }
  }
  return events;
}

export function parseMidi(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let p = 0;
  if (fourcc(bytes, 0) === 'RIFF') {
    p = 12;
    while (p + 8 <= bytes.length) {
      const id = fourcc(bytes, p);
      const size = dv.getUint32(p + 4, true);
      if (id === 'MThd') break;
      p += 8 + size + (size & 1);
    }
  }
  if (fourcc(bytes, p) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLen = dv.getUint32(p + 4, false);
  const ntrks = dv.getUint16(p + 10, false);
  const division = dv.getUint16(p + 12, false);
  p += 8 + headerLen;

  let ppqn = division & 0x7fff;
  let smpte = 0;
  if (division & 0x8000) {
    const frames = 256 - ((division >> 8) & 0xff);
    const ticksPerFrame = division & 0xff;
    smpte = frames * ticksPerFrame;
    ppqn = 0;
  }
  if (!ppqn && !smpte) ppqn = 480;

  const events = [];
  for (let t = 0; t < ntrks && p + 8 <= bytes.length; t += 1) {
    const id = fourcc(bytes, p);
    const len = dv.getUint32(p + 4, false);
    p += 8;
    if (id === 'MTrk') {
      events.push(...parseTrack(bytes.subarray(p, p + len)));
    }
    p += len;
  }
  events.sort((a, b) => a.tick - b.tick);

  let tempo = 500000;
  let lastTick = 0;
  let lastSec = 0;
  const timed = [];
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastSec += smpte ? delta / smpte : (delta * (tempo / 1e6)) / ppqn;
    lastTick = ev.tick;
    if (ev.kind === 'tempo') tempo = ev.us;
    timed.push({ ...ev, time: lastSec });
  }
  return { events: timed, duration: lastSec };
}

function noteFrequency(key, bendSemitones) {
  return 440 * Math.pow(2, (key - 69 + bendSemitones) / 12);
}

const FAMILY = [
  { type: 'triangle', attack: 0.004, decay: 1.4, sustain: 0.0, release: 0.25, cutoff: 5200, gain: 0.5 },
  { type: 'sine', attack: 0.002, decay: 0.7, sustain: 0.0, release: 0.2, cutoff: 7000, gain: 0.5, metallic: true },
  { type: 'sine', attack: 0.02, decay: 0.1, sustain: 0.85, release: 0.18, cutoff: 6000, gain: 0.4, organ: true },
  { type: 'sawtooth', attack: 0.004, decay: 0.9, sustain: 0.12, release: 0.2, cutoff: 3200, gain: 0.34, pluck: true },
  { type: 'triangle', attack: 0.004, decay: 0.6, sustain: 0.05, release: 0.18, cutoff: 2400, gain: 0.5 },
  { type: 'sawtooth', attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.3, cutoff: 3600, gain: 0.3, ensemble: true },
  { type: 'sawtooth', attack: 0.04, decay: 0.2, sustain: 0.8, release: 0.3, cutoff: 4000, gain: 0.3, ensemble: true },
  { type: 'sawtooth', attack: 0.03, decay: 0.25, sustain: 0.75, release: 0.25, cutoff: 3000, gain: 0.32, brass: true },
  { type: 'square', attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.22, cutoff: 3400, gain: 0.26 },
  { type: 'sine', attack: 0.03, decay: 0.15, sustain: 0.8, release: 0.25, cutoff: 6500, gain: 0.42, flute: true },
  { type: 'square', attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.2, cutoff: 4200, gain: 0.26 },
  { type: 'sawtooth', attack: 0.08, decay: 0.4, sustain: 0.7, release: 0.5, cutoff: 2600, gain: 0.26, ensemble: true },
  { type: 'sine', attack: 0.01, decay: 0.5, sustain: 0.3, release: 0.4, cutoff: 5000, gain: 0.4 },
  { type: 'triangle', attack: 0.005, decay: 0.5, sustain: 0.2, release: 0.25, cutoff: 4200, gain: 0.42 },
  { type: 'sawtooth', attack: 0.004, decay: 0.4, sustain: 0.1, release: 0.2, cutoff: 3000, gain: 0.34 },
  { type: 'sine', attack: 0.01, decay: 0.6, sustain: 0.2, release: 0.4, cutoff: 5000, gain: 0.4 },
];

function makeNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function envGain(ctx, time, peak, attack, decay, sustain, release) {
  const gain = ctx.createGain();
  const g = gain.gain;
  g.setValueAtTime(0.0001, time);
  g.linearRampToValueAtTime(Math.max(0.0002, peak), time + Math.max(0.001, attack));
  const susLevel = Math.max(0.0001, peak * sustain);
  g.exponentialRampToValueAtTime(susLevel, time + attack + Math.max(0.01, decay));
  return { gain, stop(at) {
    const rel = Math.max(0.03, release);
    g.cancelScheduledValues(at);
    g.setValueAtTime(Math.max(0.0001, susLevel), at);
    g.exponentialRampToValueAtTime(0.0001, at + rel);
    return at + rel + 0.02;
  } };
}

function generativeVoice(ctx, dest, noise, note) {
  const { chan, key, vel, program, time, bend } = note;
  const freq = noteFrequency(key, bend);
  const velocity = Math.max(0.05, vel / 127);
  const nodes = [];
  let stopAt;

  if (chan === 9) {
    stopAt = drumVoice(ctx, dest, noise, key, velocity, time);
    return { stop(at) { return stopAt; } };
  }

  const fam = FAMILY[Math.floor(program / 8) % 16];
  const peak = velocity * fam.gain;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = Math.min(16000, fam.cutoff + freq * 2);
  filter.Q.value = fam.brass ? 1.2 : 0.7;
  const env = envGain(ctx, time, peak, fam.attack, fam.decay, fam.sustain, fam.release);
  filter.connect(env.gain);
  env.gain.connect(dest);

  const addOsc = (type, ratio, detune, level) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * ratio;
    osc.detune.value = detune;
    const og = ctx.createGain();
    og.gain.value = level;
    osc.connect(og);
    og.connect(filter);
    osc.start(time);
    nodes.push(osc);
    return osc;
  };

  addOsc(fam.type, 1, 0, 1);
  if (fam.ensemble) { addOsc(fam.type, 1, 7, 0.6); addOsc(fam.type, 1, -7, 0.6); }
  if (fam.organ) { addOsc('sine', 2, 0, 0.4); addOsc('sine', 3, 0, 0.2); }
  if (fam.metallic) { addOsc('square', 2.76, 0, 0.18); }
  if (fam.flute) { addOsc('sine', 2, 0, 0.15); }
  if (fam.pluck) { filter.frequency.setValueAtTime(Math.min(12000, fam.cutoff + freq * 4), time); filter.frequency.exponentialRampToValueAtTime(Math.max(400, fam.cutoff * 0.5), time + fam.decay); }

  return { stop(at) {
    const end = env.stop(at);
    for (const osc of nodes) { try { osc.stop(end); } catch { /* already stopped */ } }
    return end;
  } };
}

function drumVoice(ctx, dest, noise, key, velocity, time) {
  const out = ctx.createGain();
  out.connect(dest);
  let end = time + 0.3;
  const tone = (freq, freqEnd, dur, level, type = 'sine') => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), time + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * velocity, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g); g.connect(out);
    osc.start(time); osc.stop(time + dur + 0.02);
    end = Math.max(end, time + dur);
  };
  const burst = (dur, level, filterType, freq) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level * velocity, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(time); src.stop(time + dur + 0.02);
    end = Math.max(end, time + dur);
  };
  if (key === 35 || key === 36) tone(130, 45, 0.22, 0.9);
  else if (key === 38 || key === 40) { burst(0.18, 0.5, 'highpass', 1400); tone(190, 120, 0.12, 0.4); }
  else if (key === 42 || key === 44) burst(0.05, 0.32, 'highpass', 7000);
  else if (key === 46) burst(0.3, 0.3, 'highpass', 7000);
  else if (key === 49 || key === 57) burst(0.7, 0.3, 'highpass', 5000);
  else if (key === 51 || key === 59) burst(0.4, 0.22, 'bandpass', 6000);
  else if (key === 45 || key === 47 || key === 48 || key === 50) tone(220 + (key - 45) * 30, 90, 0.25, 0.6);
  else if (key === 39) burst(0.12, 0.4, 'bandpass', 1800);
  else if (key === 56) { tone(540, 540, 0.15, 0.3, 'square'); tone(800, 800, 0.15, 0.2, 'square'); }
  else if (key === 37) burst(0.04, 0.3, 'bandpass', 2500);
  else if (key >= 60 && key <= 69) tone(300 + (key - 60) * 40, 200, 0.15, 0.4, 'triangle');
  else burst(0.15, 0.3, 'highpass', 4000);
  return end;
}

function tcSeconds(tc) {
  if (tc <= -12000) return 0;
  return Math.pow(2, tc / 1200);
}

function findPreset(sf2, chan, program) {
  const bank = chan === 9 ? 128 : 0;
  const prog = chan === 9 ? 0 : program;
  const presets = sf2.presets || [];
  return presets.find((p) => p.bank === bank && p.program === prog)
    || presets.find((p) => p.bank === 0 && p.program === prog)
    || presets.find((p) => p.bank === bank)
    || presets[0]
    || null;
}

function sf2Voice(ctx, dest, sf2, buffers, noise, note) {
  const { chan, key, vel, program, time, bend } = note;
  const preset = findPreset(sf2, chan, program);
  if (!preset || !preset.zones) return generativeVoice(ctx, dest, noise, note);
  const velocity = vel / 127;
  const voices = [];
  for (const pz of preset.zones) {
    if (key < pz.keyLow || key > pz.keyHigh || vel < pz.velLow || vel > pz.velHigh) continue;
    const instrument = sf2.instruments[pz.instrument];
    if (!instrument) continue;
    for (const iz of instrument.zones) {
      if (key < iz.keyLow || key > iz.keyHigh || vel < iz.velLow || vel > iz.velHigh) continue;
      const sample = sf2.samples[iz.sample];
      if (!sample || !sample.data.length) continue;
      let buffer = buffers.get(iz.sample);
      if (!buffer) {
        buffer = ctx.createBuffer(1, sample.data.length, sample.sampleRate);
        buffer.copyToChannel(sample.data, 0);
        buffers.set(iz.sample, buffer);
      }
      const rootKey = iz.rootKey >= 0 ? iz.rootKey : sample.rootKey;
      const cents = (key - rootKey) * 100 + iz.coarseTune * 100 + iz.fineTune + sample.pitchCorrection + bend * 100;
      const rate = Math.pow(2, cents / 1200);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = rate;
      const looping = (iz.loopMode & 1) && sample.loopEnd > sample.loopStart + 1;
      if (looping) {
        src.loop = true;
        src.loopStart = Math.max(0, (sample.loopStart + iz.loopStartOffset) / sample.sampleRate);
        src.loopEnd = Math.max(src.loopStart + 0.01, (sample.loopEnd + iz.loopEndOffset) / sample.sampleRate);
      }
      const atten = Math.pow(10, -Math.max(0, iz.attenuation) / 200);
      const peak = Math.max(0.0002, velocity * atten * 0.9);
      const attack = Math.max(0.001, tcSeconds(iz.attack));
      const hold = tcSeconds(iz.hold);
      const decay = Math.max(0.001, tcSeconds(iz.decay) || 0.001);
      const sustainLevel = Math.pow(10, -Math.max(0, iz.sustain) / 200);
      const release = Math.max(0.03, tcSeconds(iz.release) || 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(peak, time + attack);
      g.gain.linearRampToValueAtTime(Math.max(0.0001, peak * sustainLevel), time + attack + hold + decay);
      src.connect(g); g.connect(dest);
      const offset = Math.max(0, iz.startOffset / sample.sampleRate);
      try { src.start(time, offset); } catch { continue; }
      voices.push({ src, g, peak, sustainLevel, release });
    }
  }
  if (!voices.length) return generativeVoice(ctx, dest, noise, note);
  return { stop(at) {
    let end = at;
    for (const v of voices) {
      v.g.gain.cancelScheduledValues(at);
      v.g.gain.setValueAtTime(Math.max(0.0001, v.peak * v.sustainLevel), at);
      v.g.gain.exponentialRampToValueAtTime(0.0001, at + v.release);
      const stopTime = at + v.release + 0.02;
      try { v.src.stop(stopTime); } catch { /* already stopped */ }
      end = Math.max(end, stopTime);
    }
    return end;
  } };
}

function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const str = (off, text) => { for (let i = 0; i < text.length; i += 1) dv.setUint8(off + i, text.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * blockAlign, true);
  dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataSize, true);
  const channels = [];
  for (let c = 0; c < numCh; c += 1) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function computePeaks(buffer, count = 640) {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / count));
  const peaks = new Array(count).fill(0);
  for (let i = 0; i < count; i += 1) {
    let max = 0;
    const start = i * step;
    for (let j = 0; j < step; j += 1) {
      const v = Math.abs(data[start + j] || 0);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  return peaks;
}

async function render(path, sf2) {
  const buffer = await readBytes(path);
  const { events, duration } = parseMidi(buffer);
  const seconds = Math.min(MAX_DURATION, Math.max(1, duration + 1.5));
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const noise = makeNoise(ctx);
  const buffers = new Map();

  const channels = [];
  for (let c = 0; c < 16; c += 1) {
    const gain = ctx.createGain();
    gain.gain.value = c === 9 ? 0.9 : 0.8;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { gain.connect(pan); pan.connect(master); } else { gain.connect(master); }
    channels.push({ gain, pan, program: 0, volume: 1, bend: 0, sustain: false, active: new Map(), held: new Set() });
  }

  const makeVoice = (note) => (sf2 ? sf2Voice(ctx, channels[note.chan].gain, sf2, buffers, noise, note) : generativeVoice(ctx, channels[note.chan].gain, noise, note));

  const stopKey = (chan, key, at) => {
    const list = chan.active.get(key);
    if (!list) return;
    for (const voice of list) voice.stop(at);
    chan.active.delete(key);
  };

  for (const ev of events) {
    if (ev.time > seconds) break;
    const chan = channels[ev.chan];
    if (!chan) continue;
    if (ev.kind === 'program') {
      chan.program = ev.prog;
    } else if (ev.kind === 'cc') {
      if (ev.ctrl === 7) { chan.volume = ev.val / 127; chan.gain.gain.setTargetAtTime(chan.volume * (ev.chan === 9 ? 0.9 : 0.8), ev.time, 0.02); }
      else if (ev.ctrl === 10 && chan.pan) { chan.pan.pan.setTargetAtTime((ev.val - 64) / 63, ev.time, 0.02); }
      else if (ev.ctrl === 64) {
        chan.sustain = ev.val >= 64;
        if (!chan.sustain) { for (const key of chan.held) stopKey(chan, key, ev.time); chan.held.clear(); }
      }
    } else if (ev.kind === 'bend') {
      chan.bend = ((ev.value - 8192) / 8192) * 2;
    } else if (ev.kind === 'on') {
      const note = { chan: ev.chan, key: ev.key, vel: ev.vel, program: chan.program, time: ev.time, bend: chan.bend };
      const voice = makeVoice(note);
      const list = chan.active.get(ev.key) || [];
      list.push(voice);
      chan.active.set(ev.key, list);
    } else if (ev.kind === 'off') {
      if (chan.sustain) chan.held.add(ev.key);
      else stopKey(chan, ev.key, ev.time);
    }
  }
  const tail = seconds;
  for (const chan of channels) { for (const key of [...chan.active.keys()]) stopKey(chan, key, tail); }

  const rendered = await ctx.startRendering();
  const blob = encodeWav(rendered);
  return {
    url: URL.createObjectURL(blob),
    duration: rendered.duration,
    peaks: computePeaks(rendered),
    sampleRate: SAMPLE_RATE,
    channels: 2,
  };
}

export function renderMidi(path, sf2, sf2Key = 'gen') {
  const key = `${path.toLowerCase()}|${sf2Key}`;
  let pending = renderCache.get(key);
  if (!pending) {
    pending = render(path, sf2);
    renderCache.set(key, pending);
    if (renderCache.size > RENDER_CACHE) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        const old = renderCache.get(oldest);
        renderCache.delete(oldest);
        old?.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
      }
    }
    pending.catch(() => { if (renderCache.get(key) === pending) renderCache.delete(key); });
  }
  return pending;
}

export function clearMidiCache() {
  for (const pending of renderCache.values()) {
    pending.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
  }
  renderCache.clear();
}