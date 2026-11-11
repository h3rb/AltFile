import { mediaUrl } from './api.js';
import { themeColor } from './util.js';

const MAX_WAVE_BYTES = 48 * 1024 * 1024;
const WAVE_BUCKETS = 460;
const MAX_CACHE = 48;
const MAX_ACTIVE = 2;

const cache = new Map();
const pending = new Map();
const queue = [];
let active = 0;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is unavailable');
    audioCtx = new Ctx();
  }
  return audioCtx;
}

function keyFor(entry, size) {
  return `${entry.path.toLowerCase()}|${entry.modified || 0}|${size || 0}`;
}

export function cachedWave(entry, size) {
  return cache.get(keyFor(entry, size)) || null;
}

function computePeaks(buffer) {
  const channel = buffer.getChannelData(0);
  const buckets = WAVE_BUCKETS;
  const size = Math.max(1, Math.floor(channel.length / buckets));
  const peaks = new Float32Array(buckets);
  let max = 0.0001;
  for (let b = 0; b < buckets; b += 1) {
    const start = b * size;
    const end = Math.min(channel.length, start + size);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const value = Math.abs(channel[i]);
      if (value > peak) peak = value;
    }
    peaks[b] = peak;
    if (peak > max) max = peak;
  }
  for (let i = 0; i < buckets; i += 1) peaks[i] /= max;
  return peaks;
}

export function fallbackPeaks(seed) {
  const buckets = 120;
  const peaks = new Float32Array(buckets);
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  for (let i = 0; i < buckets; i += 1) {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    const noise = ((hash >>> 0) % 1000) / 1000;
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin((i / buckets) * Math.PI * 2.4));
    peaks[i] = 0.12 + noise * 0.55 * envelope;
  }
  return peaks;
}

function readWavFormat(bytes) {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes);
  const tag = (offset) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 16 <= view.byteLength) {
      return {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
      };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

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

async function decode(entry, size, ext) {
  try {
    const response = await fetch(mediaUrl(entry.path));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const wav = (ext || '').toLowerCase() === 'wav' ? readWavFormat(bytes) : null;
    const buffer = await getAudioContext().decodeAudioData(bytes);
    const data = {
      peaks: computePeaks(buffer),
      duration: buffer.duration,
      sampleRate: wav ? wav.sampleRate : 0,
      channels: wav ? wav.channels : buffer.numberOfChannels,
      note: '',
    };
    cache.set(keyFor(entry, size), data);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return data;
  } catch {
    return { peaks: fallbackPeaks(entry.name || entry.path), duration: 0, note: 'unavailable' };
  }
}

export function loadWave(entry, size, ext = '') {
  const key = keyFor(entry, size);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if ((size || 0) > MAX_WAVE_BYTES) {
    return Promise.resolve({ peaks: fallbackPeaks(entry.name || entry.path), duration: 0, note: 'large' });
  }
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = enqueue(() => decode(entry, size, ext)).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

export function drawWaveform(canvas, peaks, { subtle = false } = {}) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || 276));
  const height = Math.max(1, Math.round(rect.height || 64));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const count = Math.max(1, Math.min(peaks.length, Math.round(width)));
  const bars = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count));
    let peak = 0;
    for (let j = start; j < end && j < peaks.length; j += 1) {
      if (peaks[j] > peak) peak = peaks[j];
    }
    bars[i] = peak;
  }

  const mid = height / 2;
  const slot = width / count;
  const bar = Math.max(1, slot * (subtle ? 0.9 : 0.62));
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  if (subtle) {
    gradient.addColorStop(0, themeColor(0.14));
    gradient.addColorStop(0.5, themeColor(0.24));
    gradient.addColorStop(1, themeColor(0.1));
  } else {
    gradient.addColorStop(0, themeColor(0.92));
    gradient.addColorStop(0.5, themeColor(0.72));
    gradient.addColorStop(1, 'rgba(124, 156, 255, 0.8)');
  }
  ctx.fillStyle = gradient;
  for (let i = 0; i < count; i += 1) {
    const amp = Math.max(1, bars[i] * (mid - (subtle ? 1 : 3)));
    const x = i * slot + (slot - bar) / 2;
    ctx.fillRect(x, mid - amp, bar, amp * 2);
  }
  if (!subtle) {
    ctx.fillStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.fillRect(0, mid, width, 1);
  }
}
