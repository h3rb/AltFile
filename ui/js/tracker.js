import { mediaUrl } from './api.js';
import { isTrackerExt, parseTracker, sampleBank, TRACKER_FORMAT_LABELS } from './tracker-formats.js';

// Tracker modules are rendered offline into a WAV blob and reuse the player's
// waveform/seek conventions (like MIDI), but with a small software mixer.

const RATE = 44100;
const MAX_MODULE_BYTES = 48 * 1024 * 1024;
const MAX_SECONDS = 300;
const MAX_ROWS = 30000;
const MAX_AUDITION_SECONDS = 10;
const MAX_CACHE = 2;
const MAX_ACTIVE = 1;
const WAVE_BUCKETS = 460;

const cache = new Map();
const pending = new Map();
const queue = [];
let active = 0;

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active += 1;
    task()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function extOf(path) {
  const base = String(path || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function isTrackerPath(path) {
  return isTrackerExt(extOf(path));
}

const EXT_FORMAT = {
  mod: 'MOD', stm: 'STM', s3m: 'S3M', s3z: 'S3M', s3t: 'S3I', s3i: 'S3I',
  xm: 'XM', xmz: 'XM', it: 'IT', itz: 'IT', mptm: 'MPTM', mptmz: 'MPTM', mdz: 'MOD',
};

export function trackerKindLabel(path, format) {
  return TRACKER_FORMAT_LABELS[format || EXT_FORMAT[extOf(path)] || ''] || 'Tracker module';
}

// Render results are keyed by path only so the preview and the player share one
// mixdown; size is still used for the cache-hit watermark in callers.
function keyFor(entry) {
  return String(entry.path || '').toLowerCase();
}

export function cachedTracker(entry) {
  return cache.get(keyFor(entry)) || null;
}

export function clearTrackerCache() {
  for (const value of cache.values()) {
    if (value?.url) URL.revokeObjectURL(value.url);
  }
  cache.clear();
}

// ---------------------------------------------------------------- containers

function u16(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
}

function u32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function nameAt(bytes, off, len) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    const c = bytes[off + i];
    if (!c) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function zipEntries(bytes) {
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 0x10000 - 22);
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = u16(bytes, eocd + 10);
  let cd = u32(bytes, eocd + 16);
  const entries = [];
  for (let i = 0; i < count && cd + 46 <= bytes.length; i += 1) {
    if (u32(bytes, cd) !== 0x02014b50) break;
    const method = u16(bytes, cd + 10);
    const csize = u32(bytes, cd + 20);
    const usize = u32(bytes, cd + 24);
    const nameLen = u16(bytes, cd + 28);
    const extraLen = u16(bytes, cd + 30);
    const commentLen = u16(bytes, cd + 32);
    const local = u32(bytes, cd + 42);
    const name = nameAt(bytes, cd + 46, nameLen);
    entries.push({ method, csize, usize, local, name });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function unpackContainer(bytes, ext) {
  if (isZip(bytes)) {
    if (typeof DecompressionStream !== 'function') throw new Error('Compressed modules are not supported here');
    let best = null;
    for (const entry of zipEntries(bytes)) {
      if (!entry.usize || entry.name.endsWith('/')) continue;
      const e = extOf(entry.name);
      const score = isTrackerExt(e) ? 2 : 1;
      if (!best || score > best.score || (score === best.score && entry.usize > best.usize)) best = { ...entry, score };
    }
    if (!best) throw new Error('no module inside archive');
    if (best.local + 30 > bytes.length) throw new Error('damaged module archive');
    const nameLen = u16(bytes, best.local + 26);
    const extraLen = u16(bytes, best.local + 28);
    const start = best.local + 30 + nameLen + extraLen;
    const raw = bytes.subarray(start, start + best.csize);
    if (best.method === 0) return { bytes: raw, ext: extOf(best.name) || ext };
    if (best.method === 8) return { bytes: await inflateRaw(raw), ext: extOf(best.name) || ext };
    throw new Error('unsupported compression in archive');
  }
  if (isGzip(bytes)) {
    if (typeof DecompressionStream !== 'function') throw new Error('Compressed modules are not supported here');
    return { bytes: await gunzip(bytes), ext: ext === 'gz' ? '' : ext };
  }
  return { bytes, ext };
}

// ---------------------------------------------------------------- rendering

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function makeChannel(index, song) {
  const pan = song.channelPan[index] ?? 32;
  return {
    idx: index,
    sample: null,
    sampleIndex: -1,
    pos: 0,
    dir: 1,
    step: 0,
    baseStep: 0,
    targetStep: 0,
    vol: 0,
    pan,
    gl: 0.707,
    gr: 0.707,
    gain: 0,
    targetGain: 0,
    active: false,
    note: -1,
    ins: 0,
    fx: null,
    vibPhase: 0,
    vibSpeed: 0,
    vibDepth: 0,
    offset: 0,
    delay: -1,
    delayNote: null,
    cut: -1,
    glide: false,
  };
}

function resolveSampleIndex(song, ch, note, ins) {
  if (ins > 0) ch.ins = ins;
  const wanted = ch.ins;
  if (song.instruments.length && wanted > 0) {
    const inst = song.instruments[Math.min(wanted, song.instruments.length) - 1];
    if (inst) {
      const map = inst.noteMap;
      if (map && map.length) {
        const idx = clamp(note, 0, map.length - 1);
        let sampleNo = map[idx];
        if (!sampleNo) {
          for (let i = 0; i < map.length; i += 1) {
            if (map[i]) {
              sampleNo = map[i];
              break;
            }
          }
        }
        if (sampleNo > 0) {
          const gi = (inst.sampleBase || 0) + sampleNo - 1;
          if (gi >= 0 && gi < song.samples.length) return gi;
        }
      }
      if ((inst.sampleBase || 0) < song.samples.length) return inst.sampleBase || 0;
    }
  }
  if (wanted > 0 && wanted - 1 < song.samples.length) return wanted - 1;
  return ch.sampleIndex;
}

function triggerNote(song, ch, note, ins, offset, glide) {
  if (note < 0) note = ch.note >= 0 ? ch.note : 48;
  ch.note = note;
  const index = resolveSampleIndex(song, ch, note, ins);
  if (index < 0 || index >= song.samples.length) return;
  const smp = song.samples[index];
  if (!smp || !smp.data.length) {
    ch.active = false;
    return;
  }
  const speed = (smp.c5speed || 8363) / RATE;
  const step = speed * 2 ** ((note - smp.baseNote) / 12);
  if (glide && ch.active && ch.sample) {
    ch.targetStep = step;
    return;
  }
  ch.sample = smp;
  ch.sampleIndex = index;
  ch.baseStep = step;
  ch.step = step;
  ch.targetStep = step;
  ch.pos = clamp(offset || 0, 0, Math.max(0, smp.data.length - 1));
  ch.dir = 1;
  ch.vol = smp.volume;
  ch.pan = smp.panning >= 0 ? smp.panning : song.channelPan[ch.idx] ?? 32;
  ch.gain = 0;
  ch.active = true;
  ch.vibPhase = 0;
}

function volumeGain(ch, song, globalVol) {
  const channelVol = (song.channelVol[ch.idx] ?? 64) / 64;
  return (ch.vol / 64) * channelVol * globalVol * 0.5;
}

function applyTick(song, ch, tick, state) {
  const fx = ch.fx;
  if (!fx) return;
  const up = fx.x || 0;
  const down = fx.y || 0;
  switch (fx.t) {
    case 'volslide':
      if (tick === 0) {
        if (fx.fine) {
          if (fx.x && !fx.y) ch.vol = clamp(ch.vol + fx.x, 0, 64);
          if (fx.y && !fx.x) ch.vol = clamp(ch.vol - fx.y, 0, 64);
          if (fx.x && fx.y) ch.vol = clamp(ch.vol + fx.x - fx.y, 0, 64);
        }
      } else if (!fx.fine) {
        ch.vol = clamp(ch.vol + up - down, 0, 64);
      }
      break;
    case 'gvolslide':
      if (tick > 0) state.globalVolume = clamp(state.globalVolume + up - down, 0, 128);
      break;
    case 'gvol':
      state.globalVolume = clamp(fx.v, 0, 128);
      break;
    case 'setvol':
      ch.vol = clamp(fx.v, 0, 64);
      break;
    case 'chvol':
      song.channelVol[ch.idx] = clamp(fx.v, 0, 64);
      break;
    case 'chvolslide':
      if (tick > 0) song.channelVol[ch.idx] = clamp((song.channelVol[ch.idx] ?? 64) + up - down, 0, 64);
      break;
    case 'pan':
      if (fx.v >= 0) ch.pan = clamp(fx.v, 0, 64);
      break;
    case 'noteoff':
      if (tick === 0) ch.active = false;
      break;
    case 'vib': {
      if (tick === 0) {
        if (fx.x) ch.vibSpeed = fx.x;
        if (fx.y) ch.vibDepth = fx.y;
      }
      ch.vibPhase += (ch.vibSpeed || 1) / 32;
      const depth = fx.fine ? ch.vibDepth / 4 : ch.vibDepth;
      const offset = Math.sin(ch.vibPhase * Math.PI * 2) * (depth / 32);
      ch.step = ch.baseStep * 2 ** (offset / 12);
      break;
    }
    case 'arp':
      if (fx.x || fx.y) {
        const semis = [0, fx.x, fx.y][tick % 3];
        ch.step = ch.baseStep * 2 ** (semis / 12);
      }
      break;
    case 'portaUp':
      if (fx.fine) {
        if (tick === 0) ch.baseStep *= 2 ** (fx.v / (12 * 64));
      } else {
        ch.baseStep *= 2 ** (fx.v / (12 * 64));
      }
      ch.step = ch.baseStep;
      break;
    case 'portaDown':
      if (fx.fine) {
        if (tick === 0) ch.baseStep /= 2 ** (fx.v / (12 * 64));
      } else {
        ch.baseStep /= 2 ** (fx.v / (12 * 64));
      }
      ch.step = ch.baseStep;
      break;
    case 'tone':
      if (tick === 0 && ch.active && ch.sample) {
        ch.baseStep += (ch.targetStep - ch.baseStep) * Math.min(1, Math.max(0.02, (fx.v || 1) / 32));
        ch.step = ch.baseStep;
      } else {
        ch.step = ch.baseStep;
      }
      break;
    default:
      break;
  }
}

function handleCell(song, ch, c, state) {
  ch.fx = c?.fx || null;
  ch.offset = 0;
  ch.delay = -1;
  ch.delayNote = null;
  ch.cut = -1;
  const fx = ch.fx;
  if (fx) {
    if (fx.t === 'speed') {
      if (fx.v > 0) state.speed = clamp(fx.v, 1, 32);
    } else if (fx.t === 'tempo') {
      state.tempo = clamp(fx.v, 32, 255);
    } else if (fx.t === 'stmTempo') {
      const speed = Math.max(1, fx.v >> 4 || 6);
      const factor = fx.v & 15;
      const constants = [140, 50, 25, 15, 10, 7, 6, 4, 3, 3, 2, 2, 2, 2, 1, 1];
      const tickHz = 50 - Math.floor((constants[speed] * factor) / 16);
      state.speed = speed;
      state.tempo = clamp(Math.round((tickHz > 0 ? tickHz : 50) * 2.5), 32, 255);
    } else if (fx.t === 'jump') {
      state.jump = fx.v;
    } else if (fx.t === 'break') {
      if (state.jump < 0) state.jump = state.order + 1;
      state.breakRow = Math.max(0, fx.v);
    } else if (fx.t === 'offset') {
      ch.offset = fx.v * 256;
    } else if (fx.t === 'setvol') {
      ch.vol = clamp(fx.v, 0, 64);
    } else if (fx.t === 'pan') {
      if (fx.v >= 0) ch.pan = clamp(fx.v, 0, 64);
    } else if (fx.t === 'gvol') {
      state.globalVolume = clamp(fx.v, 0, 128);
    } else if (fx.t === 'chvol') {
      song.channelVol[ch.idx] = clamp(fx.v, 0, 64);
    } else if (fx.t === 'delay') {
      ch.delay = clamp(fx.v, 0, 31);
    } else if (fx.t === 'cut') {
      ch.cut = clamp(fx.v, 0, 31);
    } else if (fx.t === 'vib') {
      if (fx.x) ch.vibSpeed = fx.x;
      if (fx.y) ch.vibDepth = fx.y;
    }
  }
  if (!c) return;
  if (c.note === 254 || c.note === 255) {
    ch.active = false;
    return;
  }
  const tone = fx && (fx.t === 'tone');
  if (ch.delay >= 0 && (c.note >= 0 || c.ins > 0)) {
    ch.delayNote = { note: c.note, ins: c.ins, vol: c.vol };
    return;
  }
  if (c.note >= 0) {
    triggerNote(song, ch, c.note, c.ins, ch.offset, tone && ch.active && ch.sample);
  } else if (c.ins > 0) {
    ch.ins = c.ins;
  }
  if (c.vol >= 0) ch.vol = clamp(c.vol, 0, 64);
  if (tone) ch.glide = true;
}

function mixTick(song, chans, frames, chunks, blocks, frameCounter) {
  const out = new Int16Array(frames * 2);
  let blockPeak = frameCounter.block || 0;
  let blockCount = frameCounter.blockCount || 0;
  for (let f = 0; f < frames; f += 1) {
    let left = 0;
    let right = 0;
    for (let ci = 0; ci < chans.length; ci += 1) {
      const ch = chans[ci];
      if (!ch.active || !ch.sample) continue;
      const smp = ch.sample;
      const data = smp.data;
      const len = data.length;
      if (ch.pos >= len || ch.pos < 0) {
        ch.active = false;
        continue;
      }
      const i = ch.pos | 0;
      const frac = ch.pos - i;
      const a = data[i] || 0;
      const b = i + 1 < len ? data[i + 1] : a;
      const value = (a + (b - a) * frac) * ch.gain;
      left += value * ch.gl;
      right += value * ch.gr;
      if (smp.loopMode && smp.loopEnd > smp.loopStart + 1) {
        if (smp.loopMode === 2) {
          ch.pos += ch.step * ch.dir;
          if (ch.pos >= smp.loopEnd) {
            ch.pos = smp.loopEnd - (ch.pos - smp.loopEnd);
            ch.dir = -1;
          } else if (ch.pos < smp.loopStart) {
            ch.pos = smp.loopStart + (smp.loopStart - ch.pos);
            ch.dir = 1;
          }
        } else {
          ch.pos += ch.step;
          if (ch.pos >= smp.loopEnd) {
            ch.pos = smp.loopStart + ((ch.pos - smp.loopStart) % (smp.loopEnd - smp.loopStart));
          }
        }
      } else {
        ch.pos += ch.step;
        if (ch.pos >= len) ch.active = false;
      }
    }
    const l = clamp(left, -1, 1);
    const r = clamp(right, -1, 1);
    out[f * 2] = (l * 32767) | 0;
    out[f * 2 + 1] = (r * 32767) | 0;
    const peak = Math.max(Math.abs(l), Math.abs(r));
    if (peak > blockPeak) blockPeak = peak;
    blockCount += 1;
    if (blockCount >= 64) {
      blocks.push(blockPeak);
      blockPeak = 0;
      blockCount = 0;
    }
  }
  frameCounter.block = blockPeak;
  frameCounter.blockCount = blockCount;
  chunks.push(out);
}

function encodeWav(chunks, frames) {
  const dataBytes = frames * 4;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (off, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(off + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return URL.createObjectURL(new Blob([header, ...chunks], { type: 'audio/wav' }));
}

// One-off audition: the sample at its own rate, capped, with a short fade to
// avoid clicks. Deliberately ignores module mixing/effects.
function encodeSampleWav(entry) {
  const rate = entry.rate;
  const frames = Math.min(entry.frames, Math.floor(rate * MAX_AUDITION_SECONDS));
  const gain = 0.85 * Math.min(1, entry.volume / 64);
  const fade = Math.max(8, Math.floor(rate * 0.003));
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    let amp = (entry.data[i] || 0) * gain;
    if (i < fade) amp *= i / fade;
    const tail = frames - i;
    if (tail <= fade) amp *= tail / fade;
    const v = Math.max(-1, Math.min(1, amp));
    pcm[i * 2] = v < 0 ? v * 0x8000 : v * 0x7fff;
    pcm[i * 2 + 1] = pcm[i * 2];
  }
  const dataBytes = frames * 4;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const write = (off, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(off + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  return URL.createObjectURL(new Blob([header, pcm], { type: 'audio/wav' }));
}

export async function auditionTrackerSample(entry, index) {
  let result = cache.get(keyFor(entry));
  if (!result) result = await loadTracker(entry);
  const item = result.bank ? result.bank[index] : null;
  if (!item) return null;
  return {
    url: encodeSampleWav(item),
    seconds: Math.min(item.frames / item.rate, MAX_AUDITION_SECONDS),
  };
}

function resamplePeaks(blocks, buckets) {
  const peaks = new Float32Array(buckets);
  if (!blocks.length) {
    peaks.fill(0.05);
    return peaks;
  }
  let max = 0.0001;
  for (const v of blocks) if (v > max) max = v;
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor((i * blocks.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((i + 1) * blocks.length) / buckets));
    let peak = 0;
    for (let j = start; j < end && j < blocks.length; j += 1) if (blocks[j] > peak) peak = blocks[j];
    peaks[i] = clamp(peak / max, 0.02, 1);
  }
  return peaks;
}

function renderSong(song) {
  const chans = Array.from({ length: song.channels }, (_, i) => makeChannel(i, song));
  const chunks = [];
  const blocks = [];
  const rowRefs = [];
  const state = {
    speed: clamp(song.initialSpeed || 6, 1, 32),
    tempo: clamp(song.initialTempo || 125, 32, 255),
    globalVolume: clamp(song.globalVolume ?? 128, 0, 128),
    order: 0,
    row: 0,
    jump: -1,
    breakRow: -1,
  };
  let frames = 0;
  let rows = 0;
  let orderPos = 0;
  let row = 0;
  const frameCounter = { block: 0, blockCount: 0 };
  const maxFrames = RATE * MAX_SECONDS;

  const patternAt = (order) => (order >= 0 && order < song.orders.length ? song.patterns[song.orders[order]] : null);

  while (rows < MAX_ROWS && frames < maxFrames) {
    const pattern = patternAt(orderPos);
    if (!pattern) break;
    if (row >= pattern.rows) {
      orderPos += 1;
      row = 0;
      if (orderPos >= song.orders.length) break;
      continue;
    }
    state.order = orderPos;
    state.row = row;
    state.jump = -1;
    state.breakRow = -1;
    rowRefs.push({ order: orderPos, row, time: frames / RATE });

    const cells = pattern.cells;
    const channelsLen = pattern.channelsLen || song.channels;
    for (let ch = 0; ch < chans.length; ch += 1) {
      const c = ch < channelsLen ? cells[row * channelsLen + ch] : null;
      handleCell(song, chans[ch], c || null, state);
    }

    const speed = clamp(state.speed, 1, 32);
    for (let tick = 0; tick < speed && frames < maxFrames; tick += 1) {
      if (tick > 0) {
        for (const ch of chans) {
          if (ch.delayNote && tick === ch.delay) {
            const d = ch.delayNote;
            triggerNote(song, ch, d.note >= 0 ? d.note : ch.note, d.ins, ch.offset, false);
            if (d.vol >= 0) ch.vol = clamp(d.vol, 0, 64);
            ch.delayNote = null;
          }
          if (ch.cut === tick) ch.vol = 0;
          if (ch.fx) applyTick(song, ch, tick, state);
          else ch.step = ch.baseStep;
        }
      } else {
        for (const ch of chans) {
          if (ch.fx) applyTick(song, ch, 0, state);
          else ch.step = ch.baseStep;
        }
      }
      const globalVol = clamp(state.globalVolume, 0, 128) / 128;
      for (const ch of chans) {
        ch.targetGain = ch.active ? volumeGain(ch, song, globalVol) : 0;
        ch.gain += (ch.targetGain - ch.gain) * 0.25;
        const panAngle = (ch.pan / 64) * Math.PI * 0.5;
        ch.gl = Math.cos(panAngle);
        ch.gr = Math.sin(panAngle);
      }
      const tickSeconds = 2.5 / clamp(state.tempo, 32, 255);
      const tickFrames = Math.max(1, Math.round(tickSeconds * RATE));
      mixTick(song, chans, Math.min(tickFrames, maxFrames - frames), chunks, blocks, frameCounter);
      frames += Math.min(tickFrames, maxFrames - frames);
    }
    rows += 1;

    if (state.jump >= 0) {
      if (state.jump >= song.orders.length) break;
      const targetPattern = patternAt(state.jump);
      if (!targetPattern) break;
      const nextRow = state.breakRow >= 0 ? Math.min(state.breakRow, targetPattern.rows - 1) : 0;
      // Backward or same-row jumps are loop points; render one pass.
      if (state.jump < state.order || (state.jump === state.order && nextRow <= state.row)) break;
      orderPos = state.jump;
      row = nextRow;
    } else {
      row += 1;
      if (row >= pattern.rows) {
        orderPos += 1;
        row = 0;
      }
    }
    if (orderPos >= song.orders.length) break;
  }

  if (frameCounter.blockCount > 0) blocks.push(frameCounter.block);
  const duration = frames / RATE;
  const peaks = resamplePeaks(blocks, WAVE_BUCKETS);
  const url = encodeWav(chunks, frames);
  const info = {
    format: song.format,
    tracker: song.tracker,
    title: song.title,
    channels: song.channels,
    patternCount: song.patterns.length,
    sampleCount: song.samples.length,
    initialSpeed: song.initialSpeed,
    initialTempo: song.initialTempo,
    orders: song.orders.slice(0, 256),
    patterns: song.patterns.map((p) => ({ rows: p.rows, channelsLen: p.channelsLen, cells: p.cells })),
    rowRefs,
    sampleNames: song.samples.slice(0, 64).map((s) => s.name),
  };
  return { url, duration, peaks, sampleRate: RATE, channels: 2, song: info, bank: sampleBank(song) };
}

async function loadSong(entry) {
  const response = await fetch(mediaUrl(entry.path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = new Uint8Array(await response.arrayBuffer());
  if (raw.length > MAX_MODULE_BYTES) throw new Error('module is too large to preview');
  const packed = await unpackContainer(raw, extOf(entry.path));
  const song = parseTracker(packed.bytes, packed.ext || extOf(entry.path));
  return renderSong(song);
}

export function loadTracker(entry) {
  const key = keyFor(entry);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = enqueue(() => loadSong(entry))
    .then((result) => {
      cache.set(key, result);
      while (cache.size > MAX_CACHE) {
        const oldest = cache.keys().next().value;
        const value = cache.get(oldest);
        if (value?.url) URL.revokeObjectURL(value.url);
        cache.delete(oldest);
      }
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
