// Parsers for tracker modules (MOD, STM, S3M, S3I/S3T, XM, IT/MPTM).
// Each parser returns a song description consumed by tracker.js:
//   { format, tracker, title, channels, orders, patterns, samples,
//     instruments, initialSpeed, initialTempo, globalVolume, channelPan, channelVol }
// A pattern is { rows, cells } where cells is a flat rows*channels array of
// null or { note, ins, vol, fx }. Notes are 0-119 (C-0 = 0), -1 = empty,
// 254 = note cut, 255 = note off. Effects are normalised objects whose `t`
// field is one of: arp, portaUp, portaDown, tone, vib, volslide, jump, break,
// speed, tempo, offset, setvol, pan, gvol, gvolslide, chvol, chvolslide, cut,
// delay, retrig, tremor, stmTempo.

export const TRACKER_EXTS = new Set([
  'mod', 'stm', 's3m', 's3z', 's3t', 's3i', 'xm', 'xmz', 'it', 'itz', 'mptm', 'mptmz', 'mdz',
]);

const EXT_FORMAT = {
  mod: 'MOD', stm: 'STM', s3m: 'S3M', s3z: 'S3M', s3t: 'S3I', s3i: 'S3I',
  xm: 'XM', xmz: 'XM', it: 'IT', itz: 'IT', mptm: 'MPTM', mptmz: 'MPTM', mdz: 'MOD',
};

export const TRACKER_FORMAT_LABELS = {
  MOD: 'ProTracker module',
  STM: 'Scream Tracker 2 module',
  S3M: 'Scream Tracker 3 module',
  S3I: 'Scream Tracker 3 instrument',
  XM: 'FastTracker II module',
  IT: 'Impulse Tracker module',
  MPTM: 'OpenMPT module',
};

const MOD_MAGICS = new Set([
  'M.K.', 'M!K!', 'M&K!', 'FLT4', 'FLT8', '4CHN', '6CHN', '8CHN', 'OCTA', 'CD81', 'CD61', 'OKTA',
]);

export function isTrackerExt(ext) {
  return TRACKER_EXTS.has(String(ext || '').toLowerCase());
}

export function trackerFormatOf(bytes, ext) {
  const e = String(ext || '').toLowerCase();
  if (bytes && bytes.length >= 4) {
    if (ascii(bytes, 0, 17) === 'Extended Module: ') return 'XM';
    if (ascii(bytes, 0, 4) === 'IMPM') return e === 'mptm' || e === 'mptmz' ? 'MPTM' : 'IT';
    if (bytes.length >= 48 && ascii(bytes, 44, 4) === 'SCRM') return 'S3M';
    if (bytes.length >= 1084 && MOD_MAGICS.has(ascii(bytes, 1080, 4))) return 'MOD';
    if (bytes.length >= 80 && ascii(bytes, 76, 4) === 'SCRS') return 'S3I';
    if (bytes.length >= 32 && (bytes[28] === 0x1a || bytes[28] === 0x02) && bytes[29] === 2) return 'STM';
    if (bytes.length >= 1084 && /^[1-9][0-9]CH$/.test(ascii(bytes, 1080, 4))) return 'MOD';
  }
  return EXT_FORMAT[e] || null;
}

// ---------------------------------------------------------------- primitives

function ascii(bytes, off, len) {
  let out = '';
  const end = Math.min(bytes.length, off + len);
  for (let i = Math.max(0, off); i < end; i += 1) {
    const c = bytes[i];
    if (!c) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function fixedName(bytes, off, len) {
  return ascii(bytes, off, len).replace(/\u0000+/g, ' ').replace(/\s+$/, '').trim();
}

function u8(bytes, off) {
  return off >= 0 && off < bytes.length ? bytes[off] : 0;
}

function i8(bytes, off) {
  const v = u8(bytes, off);
  return v > 127 ? v - 256 : v;
}

function u16(bytes, off) {
  return u8(bytes, off) | (u8(bytes, off + 1) << 8);
}

function i16(bytes, off) {
  const v = u16(bytes, off);
  return v > 0x7fff ? v - 0x10000 : v;
}

function u16be(bytes, off) {
  return (u8(bytes, off) << 8) | u8(bytes, off + 1);
}

function u32(bytes, off) {
  return (u8(bytes, off) | (u8(bytes, off + 1) << 8) | (u8(bytes, off + 2) << 16) | (u8(bytes, off + 3) << 24)) >>> 0;
}

function newSong(format) {
  return {
    format,
    tracker: TRACKER_FORMAT_LABELS[format] || format,
    title: '',
    channels: 4,
    orders: [],
    patterns: [],
    samples: [],
    instruments: [],
    initialSpeed: 6,
    initialTempo: 125,
    globalVolume: 128,
    channelPan: [],
    channelVol: [],
    restart: 0,
  };
}

function newPattern(rows, channels) {
  return { rows, channelsLen: channels, cells: new Array(rows * channels).fill(null) };
}

function cell(note = -1, ins = 0, vol = -1, fx = null) {
  return { note, ins, vol, fx };
}

function hasData(c) {
  return c.note !== -1 || c.ins !== 0 || c.vol !== -1 || c.fx !== null;
}

function put(pattern, row, ch, c) {
  if (!c || !hasData(c)) return;
  pattern.cells[row * pattern.channelsLen + ch] = c;
}

function sample(data, options = {}) {
  const out = {
    name: options.name || '',
    data,
    loopStart: options.loopStart || 0,
    loopEnd: options.loopEnd || 0,
    loopMode: options.loopMode || 0,
    c5speed: options.c5speed || 8363,
    baseNote: options.baseNote ?? 48,
    volume: Math.max(0, Math.min(64, options.volume ?? 64)),
    panning: options.panning ?? -1,
  };
  if (out.loopEnd > data.length) out.loopEnd = data.length;
  if (out.loopStart >= out.loopEnd) {
    out.loopStart = 0;
    out.loopEnd = 0;
    out.loopMode = 0;
  }
  if (!out.loopMode) {
    out.loopStart = 0;
    out.loopEnd = 0;
  }
  return out;
}

function pcm8(bytes, start, length, signed, delta = false) {
  const out = new Float32Array(Math.max(0, length));
  let prev = 0;
  for (let i = 0; i < out.length; i += 1) {
    let v = u8(bytes, start + i);
    if (delta) {
      prev = (prev + (v > 127 ? v - 256 : v)) & 0xffff;
      v = prev & 0xff;
    }
    if (!signed) v -= 128;
    else if (v > 127) v -= 256;
    out[i] = v / 128;
  }
  return out;
}

function pcm16(bytes, start, length, bigEndian = false, delta = false) {
  const out = new Float32Array(Math.max(0, length));
  let prev = 0;
  for (let i = 0; i < out.length; i += 1) {
    const raw = bigEndian ? u16be(bytes, start + i * 2) : u16(bytes, start + i * 2);
    let v = raw > 0x7fff ? raw - 0x10000 : raw;
    if (delta) {
      prev = (prev + v) & 0xffff;
      if (prev > 0x7fff) prev -= 0x10000;
      v = prev;
    }
    out[i] = v / 32768;
  }
  return out;
}

// ---------------------------------------------------------------- MOD

const MOD_PERIODS = [
  1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907,
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
];

function modNoteFromPeriod(period) {
  if (!period) return -1;
  let best = 0;
  let dist = Infinity;
  for (let i = 0; i < MOD_PERIODS.length; i += 1) {
    const d = Math.abs(MOD_PERIODS[i] - period);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best + 12;
}

function modEffect(eff, param) {
  switch (eff) {
    case 0x0:
      return param ? { t: 'arp', x: param >> 4, y: param & 15 } : null;
    case 0x1:
      return { t: 'portaUp', v: param };
    case 0x2:
      return { t: 'portaDown', v: param };
    case 0x3:
      return { t: 'tone', v: param };
    case 0x4:
      return { t: 'vib', x: param >> 4, y: param & 15 };
    case 0x5:
      return { t: 'tone', v: param, x: param >> 4, y: param & 15 };
    case 0x6:
      return { t: 'vib', x: param >> 4, y: param & 15, up: param >> 4, down: param & 15 };
    case 0x8:
      return param ? { t: 'pan', v: Math.round((param / 255) * 64) } : null;
    case 0x9:
      return param ? { t: 'offset', v: param } : null;
    case 0xa:
      return param ? { t: 'volslide', x: param >> 4, y: param & 15 } : null;
    case 0xb:
      return { t: 'jump', v: param };
    case 0xc:
      return { t: 'setvol', v: Math.min(64, param) };
    case 0xd: {
      const row = (param >> 4) * 10 + (param & 15);
      return { t: 'break', v: row };
    }
    case 0xe: {
      const sub = param >> 4;
      const x = param & 15;
      if (sub === 1) return { t: 'portaUp', v: x, fine: true };
      if (sub === 2) return { t: 'portaDown', v: x, fine: true };
      if (sub === 8) return { t: 'pan', v: x * 4 };
      if (sub === 0x9) return { t: 'retrig', v: x };
      if (sub === 0xa) return { t: 'volslide', x, y: 0, fine: true };
      if (sub === 0xb) return { t: 'volslide', x: 0, y: x, fine: true };
      if (sub === 0xc) return { t: 'cut', v: x };
      if (sub === 0xd) return { t: 'delay', v: x };
      return null;
    }
    case 0xf:
      return param <= 0x1f ? { t: 'speed', v: param || 6 } : { t: 'tempo', v: param };
    default:
      return null;
  }
}

export function parseMod(bytes, ext = 'mod') {
  if (bytes.length < 600) throw new Error('truncated MOD');
  const magic = bytes.length >= 1084 ? ascii(bytes, 1080, 4) : '';
  const hasMagic = MOD_MAGICS.has(magic);
  let channels = 4;
  if (hasMagic) {
    if (/^[1-9][0-9]CH$/.test(magic) || /^[1-9][0-9]CN$/.test(magic)) channels = Number(magic.slice(0, 2));
    else if (magic === '6CHN' || magic === 'CD61') channels = 6;
    else if (magic === '8CHN' || magic === 'OCTA' || magic === 'CD81' || magic === 'OKTA') channels = 8;
    else if (magic === 'FLT8') channels = 8;
  }
  const sampleCount = hasMagic || bytes.length >= 1084 ? 31 : 15;
  const headerSize = sampleCount === 31 ? 1084 : 600;
  if (bytes.length < headerSize) throw new Error('truncated MOD');

  const song = newSong('MOD');
  song.channels = channels;
  song.tracker = 'ProTracker';
  song.title = fixedName(bytes, 0, 20);
  song.initialSpeed = 6;
  song.initialTempo = 125;
  song.globalVolume = 128;
  song.channelPan = Array.from({ length: channels }, (_, i) => [16, 48, 48, 16][i & 3]);
  song.channelVol = new Array(channels).fill(64);

  const songLen = Math.min(128, u8(bytes, 950));
  const sampleHeaders = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const off = 20 + i * 30;
    const name = fixedName(bytes, off, 22);
    const words = u16be(bytes, off + 22);
    const finetuneRaw = u8(bytes, off + 24) & 0x0f;
    const finetune = finetuneRaw > 7 ? finetuneRaw - 16 : finetuneRaw;
    const volume = Math.min(64, u8(bytes, off + 25));
    const loopStart = u16be(bytes, off + 26) * 2;
    const loopLen = u16be(bytes, off + 28) * 2;
    sampleHeaders.push({ name, length: words * 2, finetune, volume, loopStart, loopEnd: loopStart + loopLen });
  }

  song.orders = [];
  for (let i = 0; i < songLen; i += 1) {
    const o = u8(bytes, 952 + i);
    if (o < 128) song.orders.push(o);
  }
  if (!song.orders.length) song.orders.push(0);
  const highest = Math.max(...song.orders);
  const patternBytes = 64 * channels * 4;
  const usablePatterns = Math.max(1, Math.min(highest + 1, Math.floor((bytes.length - headerSize) / patternBytes) || 1));

  let dataPos = headerSize + usablePatterns * patternBytes;
  for (let p = 0; p < usablePatterns; p += 1) {
    const pattern = newPattern(64, channels);
    pattern.channelsLen = channels;
    const base = headerSize + p * patternBytes;
    for (let row = 0; row < 64; row += 1) {
      for (let ch = 0; ch < channels; ch += 1) {
        const off = base + (row * channels + ch) * 4;
        if (off + 3 >= bytes.length) continue;
        const b0 = bytes[off];
        const b1 = bytes[off + 1];
        const b2 = bytes[off + 2];
        const b3 = bytes[off + 3];
        const ins = (b0 & 0xf0) | (b2 >> 4);
        const period = ((b0 & 0x0f) << 8) | b1;
        const note = modNoteFromPeriod(period);
        const fx = modEffect(b2 & 0x0f, b3);
        const c = cell(note, ins, -1, fx);
        put(pattern, row, ch, c);
      }
    }
    song.patterns.push(pattern);
  }
  song.patterns.forEach((pattern) => {
    pattern.channelsLen = channels;
  });

  for (let i = 0; i < sampleHeaders.length; i += 1) {
    const h = sampleHeaders[i];
    const len = Math.max(0, Math.min(h.length, bytes.length - dataPos));
    const pcm = pcm8(bytes, dataPos, len, true);
    dataPos += h.length;
    const loopMode = h.loopEnd > h.loopStart + 1 ? 1 : 0;
    const s = sample(pcm, {
      name: h.name,
      loopStart: h.loopStart,
      loopEnd: h.loopEnd,
      loopMode,
      c5speed: 8363 * 2 ** (h.finetune / 96),
      baseNote: 36,
      volume: h.volume,
    });
    song.samples.push(s);
  }
  song.restart = Math.min(u8(bytes, 951), song.orders.length - 1);
  return song;
}

// ---------------------------------------------------------------- STM

const STM_TEMPO_CONSTANTS = [140, 50, 25, 15, 10, 7, 6, 4, 3, 3, 2, 2, 2, 2, 1, 1];

function stmEffect(eff, param) {
  switch (eff) {
    case 0x1:
      return { t: 'stmTempo', v: param };
    case 0x2:
      return { t: 'jump', v: param };
    case 0x3:
      return { t: 'break', v: 0 };
    case 0x4:
      return param ? { t: 'volslide', x: param >> 4, y: param & 15 } : null;
    case 0x5:
      return { t: 'portaDown', v: param };
    case 0x6:
      return { t: 'portaUp', v: param };
    case 0x7:
      return { t: 'tone', v: param };
    case 0x8:
      return { t: 'vib', x: param >> 4, y: param & 15 };
    case 0x9:
      return null;
    case 0xa:
      return param ? { t: 'arp', x: param >> 4, y: param & 15 } : null;
    case 0xb:
      return { t: 'tone', v: param };
    case 0xe:
      return { t: 'offset', v: param };
    default:
      return null;
  }
}

export function parseStm(bytes) {
  if (bytes.length < 0x430) throw new Error('truncated STM');
  if (bytes[29] !== 2) throw new Error('STM without internal samples');
  const song = newSong('STM');
  song.channels = 4;
  song.tracker = `Scream Tracker ${u8(bytes, 30)}.${String(u8(bytes, 31)).padStart(2, '0')}`;
  song.title = fixedName(bytes, 0, 20);
  const tempoByte = u8(bytes, 0x20) || 0x60;
  const speed = Math.max(1, tempoByte >> 4 || 6);
  const factor = Math.min(15, tempoByte & 15);
  const tickHz = 50 - Math.floor((STM_TEMPO_CONSTANTS[speed] * factor) / 16);
  song.initialSpeed = speed;
  song.initialTempo = Math.min(255, Math.max(32, Math.round((tickHz > 0 ? tickHz : 50) * 2.5)));
  song.globalVolume = Math.min(128, u8(bytes, 0x22) * 2 || 128);
  song.channelPan = [16, 48, 48, 16];
  song.channelVol = [64, 64, 64, 64];

  const patternCount = Math.min(64, u8(bytes, 0x21));
  const major = u8(bytes, 30);
  const minor = u8(bytes, 31);
  const orderLen = major === 2 && minor === 0 ? 64 : 128;
  const orderStart = 0x30 + 31 * 32;
  for (let i = 0; i < orderLen; i += 1) {
    const o = u8(bytes, orderStart + i);
    if (o === 0x63 || o === 0xff) break;
    if (o < patternCount) song.orders.push(o);
  }
  if (!song.orders.length) song.orders.push(0);

  const headers = [];
  for (let i = 0; i < 31; i += 1) {
    const off = 0x30 + i * 32;
    headers.push({
      name: fixedName(bytes, off, 13),
      pos: u16(bytes, off + 14) * 16,
      length: u16(bytes, off + 16),
      loopStart: u16(bytes, off + 18),
      loopEnd: u16(bytes, off + 20),
      volume: Math.min(64, u8(bytes, off + 22)),
      c5speed: u16(bytes, off + 24) || 8448,
    });
  }

  let pos = orderStart + orderLen;
  for (let p = 0; p < patternCount; p += 1) {
    const pattern = newPattern(64, 4);
    pattern.channelsLen = 4;
    for (let row = 0; row < 64; row += 1) {
      for (let ch = 0; ch < 4; ch += 1) {
        if (pos >= bytes.length) break;
        let b0 = bytes[pos];
        let note = -1;
        let ins = 0;
        let vol = -1;
        let eff = 0;
        let param = 0;
        if (b0 === 252) {
          pos += 1;
        } else if (b0 === 253) {
          note = 254;
          pos += 1;
        } else if (b0 === 251) {
          pos += 1;
        } else {
          note = b0 === 255 ? -1 : (b0 >> 4) * 12 + (b0 & 15);
          const b1 = u8(bytes, pos + 1);
          const b2 = u8(bytes, pos + 2);
          const b3 = u8(bytes, pos + 3);
          ins = b1 >> 3;
          vol = ((b1 & 7) | ((b2 >> 4) << 3));
          if (vol > 64) vol = -1;
          eff = b2 & 15;
          param = b3;
          pos += 4;
        }
        put(pattern, row, ch, cell(note, ins, vol, stmEffect(eff, param)));
      }
    }
    song.patterns.push(pattern);
  }

  for (const h of headers) {
    const len = Math.max(0, Math.min(h.length, bytes.length - h.pos));
    const pcm = pcm8(bytes, h.pos, len, true);
    song.samples.push(sample(pcm, {
      name: h.name,
      loopStart: h.loopStart,
      loopEnd: h.loopEnd,
      loopMode: h.loopEnd > h.loopStart + 1 ? 1 : 0,
      c5speed: h.c5speed,
      baseNote: 24,
      volume: h.volume,
    }));
  }
  return song;
}

// ---------------------------------------------------------------- S3M

function s3mEffect(eff, param) {
  switch (eff) {
    case 1:
      return { t: 'speed', v: param || 6 };
    case 2:
      return { t: 'jump', v: param };
    case 3:
      return { t: 'break', v: (param >> 4) * 10 + (param & 15) };
    case 4:
      return param ? { t: 'volslide', x: param >> 4, y: param & 15, fine: param === 0xf0 || param === 0x0f } : null;
    case 5:
      return { t: 'portaDown', v: param };
    case 6:
      return { t: 'portaUp', v: param };
    case 7:
      return { t: 'tone', v: param };
    case 8:
      return { t: 'vib', x: param >> 4, y: param & 15 };
    case 9:
      return null;
    case 10:
      return param ? { t: 'arp', x: param >> 4, y: param & 15 } : null;
    case 11:
      return { t: 'vib', x: param >> 4, y: param & 15, up: param >> 4, down: param & 15 };
    case 12:
      return { t: 'tone', v: param, up: param >> 4, down: param & 15 };
    case 15:
      return { t: 'offset', v: param };
    case 17:
      return null;
    case 19: {
      const sub = param >> 4;
      const x = param & 15;
      if (sub === 8) return { t: 'pan', v: x * 4 };
      if (sub === 0xc) return { t: 'cut', v: x };
      if (sub === 0xd) return { t: 'delay', v: x };
      return null;
    }
    case 20:
      return param >= 0x20 ? { t: 'tempo', v: param } : null;
    case 21:
      return { t: 'vib', x: param >> 4, y: param & 15, fine: true };
    case 22:
      return { t: 'gvol', v: Math.min(128, param * 2) };
    case 23:
      return param ? { t: 'gvolslide', x: param >> 4, y: param & 15 } : null;
    case 24:
      return { t: 'pan', v: param <= 0x80 ? Math.round((param / 128) * 64) : -1 };
    default:
      return null;
  }
}

function s3mSampleFormat(ffi) {
  const signed = (ffi & 1) !== 0;
  return { signed, unsigned: !signed && (ffi & 2) !== 0 };
}

export function parseS3m(bytes) {
  if (bytes.length < 0x60 || ascii(bytes, 44, 4) !== 'SCRM') throw new Error('not an S3M');
  const song = newSong('S3M');
  song.title = fixedName(bytes, 0, 28);
  song.tracker = 'Scream Tracker 3';
  const ordNum = u16(bytes, 32);
  const insNum = u16(bytes, 34);
  const patNum = u16(bytes, 36);
  const ffi = u16(bytes, 42);
  song.initialSpeed = Math.max(1, u8(bytes, 49));
  song.initialTempo = Math.max(32, u8(bytes, 50));
  song.globalVolume = Math.min(128, u8(bytes, 48) * 2);
  const dp = u8(bytes, 53);
  song.channels = 32;

  const channelPan = new Array(32).fill(-1);
  song.channelVol = new Array(32).fill(64);
  for (let i = 0; i < 32; i += 1) {
    const setting = u8(bytes, 0x40 + i);
    if (setting & 0x80) song.channelVol[i] = 0;
    const pan = setting & 0x0f;
    const defaults = [16, 48, 48, 16];
    channelPan[i] = defaults[i & 3];
    if (pan < 8) channelPan[i] = 16;
    else if (pan >= 8) channelPan[i] = 48;
  }
  let ptr = 96;
  const orders = [];
  for (let i = 0; i < ordNum; i += 1) {
    const o = u8(bytes, ptr + i);
    if (o < 0xfe) orders.push(o);
  }
  ptr += ordNum;
  const insPtrs = [];
  for (let i = 0; i < insNum; i += 1) insPtrs.push(u16(bytes, ptr + i * 2) * 16);
  ptr += insNum * 2;
  const patPtrs = [];
  for (let i = 0; i < patNum; i += 1) patPtrs.push(u16(bytes, ptr + i * 2) * 16);
  ptr += patNum * 2;
  if (dp === 252) {
    for (let i = 0; i < 32; i += 1) {
      const p = u8(bytes, ptr + i);
      if (p & 0x20) channelPan[i] = Math.round(((p & 0x0f) / 15) * 64);
    }
  }
  song.channelPan = channelPan;
  song.orders = orders.length ? orders : [0];

  let maxChannel = 1;
  for (let p = 0; p < patNum; p += 1) {
    const pattern = newPattern(64, 32);
    pattern.channelsLen = 32;
    if (patPtrs[p]) {
      let pos = patPtrs[p];
      const len = u16(bytes, pos);
      const rows = u16(bytes, pos + 2) || 64;
      pos += 2;
      const end = Math.min(bytes.length, pos + len);
      let row = 0;
      while (row < rows && pos < end) {
        const b = u8(bytes, pos);
        pos += 1;
        if (!b) {
          row += 1;
          continue;
        }
        const ch = b & 31;
        if (ch + 1 > maxChannel) maxChannel = ch + 1;
        let note = -1;
        let ins = 0;
        let vol = -1;
        let fx = null;
        if (b & 0x20) {
          const n = u8(bytes, pos);
          ins = u8(bytes, pos + 1);
          pos += 2;
          if (n === 0xfe) note = 254;
          else if (n !== 0xff) note = (n >> 4) * 12 + (n & 15);
        }
        if (b & 0x40) {
          vol = u8(bytes, pos);
          pos += 1;
          if (vol > 64) vol = -1;
        }
        if (b & 0x80) {
          const eff = u8(bytes, pos);
          const param = u8(bytes, pos + 1);
          pos += 2;
          fx = s3mEffect(eff, param);
        }
        put(pattern, row, ch, cell(note, ins, vol, fx));
      }
    }
    song.patterns.push(pattern);
  }
  song.patterns.forEach((pattern) => {
    pattern.channelsLen = 32;
    pattern.cells.length = pattern.rows * 32;
  });
  song.channels = Math.max(1, Math.min(32, maxChannel));

  const fmt = s3mSampleFormat(ffi);
  for (let i = 0; i < insNum; i += 1) {
    const off = insPtrs[i];
    if (!off || off + 80 > bytes.length) {
      song.samples.push(sample(new Float32Array(0)));
      continue;
    }
    const type = u8(bytes, off);
    if (type === 2) {
      song.samples.push(sample(new Float32Array(0), { name: fixedName(bytes, off + 48, 28) }));
      continue;
    }
    const memseg = (u8(bytes, off + 13) << 16) | u16(bytes, off + 14);
    const pos = memseg * 16;
    const length = Math.min(u32(bytes, off + 16), 0xffffff);
    const loopStart = u32(bytes, off + 20);
    const loopEnd = u32(bytes, off + 24);
    const volume = Math.min(64, u8(bytes, off + 28));
    const pack = u8(bytes, off + 30);
    const flags = u8(bytes, off + 31);
    const c2spd = Math.max(1, u32(bytes, off + 32) || 8363);
    const stereo = (flags & 2) !== 0;
    const sixteen = (flags & 4) !== 0;
    const name = fixedName(bytes, off + 48, 28);
    const byteLen = Math.min(length * (sixteen ? 2 : 1), Math.max(0, bytes.length - pos));
    let data;
    if (sixteen) {
      data = pcm16(bytes, pos, byteLen >> 1);
    } else {
      data = pcm8(bytes, pos, byteLen, fmt.signed, pack === 1);
    }
    if (stereo) {
      const mono = new Float32Array(Math.max(1, data.length >> 1));
      for (let j = 0; j < mono.length; j += 1) mono[j] = data[j * 2];
      data = mono;
    }
    song.samples.push(sample(data, {
      name,
      loopStart,
      loopEnd,
      loopMode: flags & 1 ? (loopEnd > loopStart + 1 ? 1 : 0) : 0,
      c5speed: c2spd,
      baseNote: 48,
      volume,
    }));
  }
  return song;
}

// ---------------------------------------------------------------- S3I / S3T

export function parseS3i(bytes) {
  if (bytes.length < 80 || ascii(bytes, 76, 4) !== 'SCRS') throw new Error('not an S3I');
  const song = newSong('S3I');
  const length = Math.min(u32(bytes, 16), Math.max(0, bytes.length - 80));
  const loopStart = u32(bytes, 20);
  const loopEnd = u32(bytes, 24);
  const volume = Math.min(64, u8(bytes, 28));
  const pack = u8(bytes, 30);
  const flags = u8(bytes, 31);
  const c2spd = Math.max(1, u32(bytes, 32) || 8363);
  const sixteen = (flags & 4) !== 0;
  let data = sixteen ? pcm16(bytes, 80, length) : pcm8(bytes, 80, length, true, pack === 1);
  if ((flags & 2) !== 0) {
    const mono = new Float32Array(Math.max(1, data.length >> 1));
    for (let i = 0; i < mono.length; i += 1) mono[i] = data[i * 2];
    data = mono;
  }
  song.title = fixedName(bytes, 48, 28) || fixedName(bytes, 4, 12);
  song.tracker = 'Scream Tracker 3 instrument';
  song.channels = 4;
  song.channelPan = [16, 48, 48, 16];
  song.channelVol = [64, 64, 64, 64];
  song.samples.push(sample(data, {
    name: song.title,
    loopStart,
    loopEnd,
    loopMode: flags & 1 ? 1 : 0,
    c5speed: c2spd,
    baseNote: 48,
    volume,
  }));
  const pattern = newPattern(64, 4);
  pattern.channelsLen = 4;
  put(pattern, 0, 0, cell(48, 1, -1, null));
  put(pattern, 63, 0, cell(255, 0, -1, null));
  song.patterns.push(pattern);
  song.orders = [0];
  return song;
}

// ---------------------------------------------------------------- XM

function xmEffect(eff, param) {
  switch (eff) {
    case 0x0:
      return param ? { t: 'arp', x: param >> 4, y: param & 15 } : null;
    case 0x1:
      return { t: 'portaUp', v: param };
    case 0x2:
      return { t: 'portaDown', v: param };
    case 0x3:
      return { t: 'tone', v: param };
    case 0x4:
      return { t: 'vib', x: param >> 4, y: param & 15 };
    case 0x5:
      return { t: 'tone', v: param, up: param >> 4, down: param & 15 };
    case 0x6:
      return { t: 'vib', x: param >> 4, y: param & 15, up: param >> 4, down: param & 15 };
    case 0x8:
      return { t: 'pan', v: Math.round((param / 255) * 64) };
    case 0x9:
      return { t: 'offset', v: param };
    case 0xa:
      return param ? { t: 'volslide', x: param >> 4, y: param & 15 } : null;
    case 0xb:
      return { t: 'jump', v: param };
    case 0xc:
      return { t: 'setvol', v: Math.min(64, param) };
    case 0xd:
      return { t: 'break', v: (param >> 4) * 10 + (param & 15) };
    case 0xe: {
      const sub = param >> 4;
      const x = param & 15;
      if (sub === 0xa) return { t: 'volslide', x, y: 0, fine: true };
      if (sub === 0xb) return { t: 'volslide', x: 0, y: x, fine: true };
      if (sub === 0xc) return { t: 'cut', v: x };
      if (sub === 0xd) return { t: 'delay', v: x };
      return null;
    }
    case 0xf:
      return param <= 0x1f ? { t: 'speed', v: param || 6 } : { t: 'tempo', v: param };
    case 0x10:
      return { t: 'gvol', v: Math.min(128, param * 2) };
    case 0x11:
      return param ? { t: 'gvolslide', x: param >> 4, y: param & 15 } : null;
    case 0x14:
      return { t: 'noteoff' };
    case 0x19:
      return { t: 'panslide', v: param };
    case 0x21:
      return { t: 'retrig', v: param };
    default:
      return null;
  }
}

function applyXmVolumeColumn(c, byte) {
  if (!byte) return;
  if (byte >= 0x10 && byte <= 0x50) {
    c.vol = byte - 0x10;
  } else if (byte >= 0x60 && byte <= 0x6f) {
    if (!c.fx) c.fx = { t: 'volslide', x: 0, y: byte & 15 };
  } else if (byte >= 0x70 && byte <= 0x7f) {
    if (!c.fx) c.fx = { t: 'volslide', x: byte & 15, y: 0 };
  } else if (byte >= 0x80 && byte <= 0x8f) {
    if (!c.fx) c.fx = { t: 'volslide', x: 0, y: byte & 15, fine: true };
  } else if (byte >= 0x90 && byte <= 0x9f) {
    if (!c.fx) c.fx = { t: 'volslide', x: byte & 15, y: 0, fine: true };
  } else if (byte >= 0xa0 && byte <= 0xaf) {
    if (!c.fx) c.fx = { t: 'vib', x: byte & 15, y: 0 };
  } else if (byte >= 0xb0 && byte <= 0xbf) {
    if (!c.fx) c.fx = { t: 'vib', x: 0, y: byte & 15 };
  } else if (byte >= 0xc0 && byte <= 0xcf) {
    if (!c.fx) c.fx = { t: 'pan', v: (byte & 15) * 4 };
  } else if (byte >= 0xf0 && byte <= 0xff) {
    if (!c.fx) c.fx = { t: 'tone', v: byte & 15 };
  }
}

export function parseXm(bytes) {
  if (bytes.length < 80 || ascii(bytes, 0, 17) !== 'Extended Module: ') throw new Error('not an XM');
  const song = newSong('XM');
  song.title = fixedName(bytes, 17, 20);
  song.tracker = fixedName(bytes, 38, 20) || 'FastTracker II';
  const headerSize = u32(bytes, 60);
  const songLen = u16(bytes, 64);
  const numChannels = u16(bytes, 68) || 4;
  const numPatterns = u16(bytes, 70);
  const numInstruments = u16(bytes, 72);
  song.channels = Math.max(1, Math.min(64, numChannels));
  song.initialSpeed = Math.max(1, u16(bytes, 76));
  song.initialTempo = Math.max(32, u16(bytes, 78));
  song.globalVolume = 128;
  song.channelPan = new Array(song.channels).fill(32);
  song.channelVol = new Array(song.channels).fill(64);
  const restart = u16(bytes, 66);
  const ordersStart = 80;
  for (let i = 0; i < songLen; i += 1) {
    const o = u8(bytes, ordersStart + i);
    if (o < numPatterns) song.orders.push(o);
  }
  song.orders = song.orders.length ? song.orders : [0];
  song.restart = restart;

  let pos = 60 + headerSize;
  for (let p = 0; p < numPatterns; p += 1) {
    if (pos + 9 > bytes.length) {
      song.patterns.push(newPattern(64, song.channels));
      continue;
    }
    const headLen = u32(bytes, pos);
    const rows = Math.max(1, Math.min(256, u16(bytes, pos + 5)));
    const dataLen = u16(bytes, pos + 7);
    const dataStart = pos + headLen;
    const pattern = newPattern(rows, song.channels);
    pattern.channelsLen = song.channels;
    let dp = dataStart;
    const end = Math.min(bytes.length, dataStart + dataLen);
    for (let row = 0; row < rows; row += 1) {
      for (let ch = 0; ch < song.channels; ch += 1) {
        if (dp >= end) break;
        const b = bytes[dp];
        dp += 1;
        if (!b) continue;
        let note = -1;
        let ins = 0;
        let volByte = 0;
        let eff = 0;
        let param = 0;
        if (b & 1) {
          const n = u8(bytes, dp);
          dp += 1;
          if (n === 97) note = 255;
          else if (n > 0 && n <= 96) note = n - 1;
        }
        if (b & 2) {
          ins = u8(bytes, dp);
          dp += 1;
        }
        if (b & 4) {
          volByte = u8(bytes, dp);
          dp += 1;
        }
        if (b & 8) {
          eff = u8(bytes, dp);
          param = u8(bytes, dp + 1);
          dp += 2;
        }
        const c = cell(note, ins, -1, xmEffect(eff, param));
        applyXmVolumeColumn(c, volByte);
        put(pattern, row, ch, c);
      }
    }
    song.patterns.push(pattern);
    pos = dataStart + dataLen;
  }

  for (let i = 0; i < numInstruments; i += 1) {
    if (pos + 29 > bytes.length) break;
    const instStart = pos;
    const instSize = u32(bytes, instStart);
    const name = fixedName(bytes, instStart + 4, 22);
    const numSamples = u16(bytes, instStart + 27);
    let sampleHeaderSize = 0;
    const noteMap = new Uint8Array(96);
    if (numSamples > 0) {
      sampleHeaderSize = u32(bytes, instStart + 29);
      for (let n = 0; n < 96; n += 1) noteMap[n] = u8(bytes, instStart + 33 + n);
    }
    const sampleBase = song.samples.length;
    const sampleHeaders = [];
    let sp = instStart + instSize;
    for (let s = 0; s < numSamples; s += 1) {
      const h = sp;
      const length = u32(bytes, h);
      const loopStart = u32(bytes, h + 4);
      const loopLen = u32(bytes, h + 8);
      const volume = Math.min(64, u8(bytes, h + 12));
      const finetune = i8(bytes, h + 13);
      const type = u8(bytes, h + 14);
      const panning = u8(bytes, h + 15);
      const relNote = i8(bytes, h + 16);
      const sname = fixedName(bytes, h + 18, 22);
      sampleHeaders.push({ length, loopStart, loopLen, volume, finetune, type, panning, relNote, name: sname });
      sp += Math.max(sampleHeaderSize, 40);
    }
    let dataPos = sp;
    for (const h of sampleHeaders) {
      const sixteen = (h.type & 0x10) !== 0;
      const byteLen = Math.min(h.length, Math.max(0, bytes.length - dataPos));
      const data = sixteen ? pcm16(bytes, dataPos, byteLen >> 1, false, true) : pcm8(bytes, dataPos, byteLen, true, true);
      dataPos += h.length;
      const loopMode = h.type & 3;
      const s = sample(data, {
        name: h.name,
        loopStart: sixteen ? h.loopStart >> 1 : h.loopStart,
        loopEnd: sixteen ? (h.loopStart + h.loopLen) >> 1 : h.loopStart + h.loopLen,
        loopMode: loopMode === 1 ? 1 : loopMode === 2 ? 2 : 0,
        c5speed: 8363 * 2 ** (h.finetune / (128 * 12)),
        baseNote: 60 + h.relNote,
        volume: h.volume,
        panning: Math.round((h.panning / 255) * 64),
      });
      song.samples.push(s);
    }
    song.instruments.push({ name, noteMap, sampleBase, sampleCount: numSamples });
    pos = dataPos;
  }
  return song;
}

// ---------------------------------------------------------------- IT

const IT_NOTE_CUT = 254;
const IT_NOTE_OFF = 255;

function itEffect(cmd, param) {
  const letter = cmd > 0 && cmd <= 26 ? String.fromCharCode(64 + cmd) : '';
  switch (letter) {
    case 'A':
      return param ? { t: 'speed', v: param } : null;
    case 'B':
      return { t: 'jump', v: param };
    case 'C':
      return { t: 'break', v: param };
    case 'D':
      return param ? { t: 'volslide', x: param >> 4, y: param & 15, fine: param === 0xf0 || param === 0x0f } : null;
    case 'E':
      return { t: 'portaDown', v: param };
    case 'F':
      return { t: 'portaUp', v: param };
    case 'G':
      return { t: 'tone', v: param };
    case 'H':
      return { t: 'vib', x: param >> 4, y: param & 15 };
    case 'J':
      return param ? { t: 'arp', x: param >> 4, y: param & 15 } : null;
    case 'K':
      return { t: 'vib', x: param >> 4, y: param & 15, up: param >> 4, down: param & 15 };
    case 'L':
      return { t: 'tone', v: param, up: param >> 4, down: param & 15 };
    case 'M':
      return { t: 'chvol', v: Math.min(64, param) };
    case 'N':
      return param ? { t: 'chvolslide', x: param >> 4, y: param & 15 } : null;
    case 'O':
      return { t: 'offset', v: param * 2 };
    case 'S': {
      const sub = param >> 4;
      const x = param & 15;
      if (sub === 8) return { t: 'pan', v: x * 4 };
      if (sub === 0xc) return { t: 'cut', v: x };
      if (sub === 0xd) return { t: 'delay', v: x };
      return null;
    }
    case 'T':
      return param >= 0x20 ? { t: 'tempo', v: param } : null;
    case 'U':
      return { t: 'vib', x: param >> 4, y: param & 15, fine: true };
    case 'V':
      return { t: 'gvol', v: Math.min(128, param) };
    case 'W':
      return param ? { t: 'gvolslide', x: param >> 4, y: param & 15 } : null;
    case 'X':
      return { t: 'pan', v: Math.min(64, param) };
    default:
      return null;
  }
}

function applyItVolumeColumn(c, byte) {
  if (byte <= 64) {
    c.vol = byte;
  } else if (byte >= 128 && byte <= 192) {
    if (!c.fx) c.fx = { t: 'pan', v: byte - 128 };
  } else if (byte >= 65 && byte <= 74) {
    if (!c.fx) c.fx = { t: 'volslide', x: byte - 65, y: 0, fine: true };
  } else if (byte >= 75 && byte <= 84) {
    if (!c.fx) c.fx = { t: 'volslide', x: 0, y: byte - 75, fine: true };
  } else if (byte >= 85 && byte <= 94) {
    if (!c.fx) c.fx = { t: 'volslide', x: byte - 85, y: 0 };
  } else if (byte >= 95 && byte <= 104) {
    if (!c.fx) c.fx = { t: 'volslide', x: 0, y: byte - 95 };
  } else if (byte >= 105 && byte <= 114) {
    if (!c.fx) c.fx = { t: 'portaDown', v: (byte - 105) * 4 };
  } else if (byte >= 115 && byte <= 124) {
    if (!c.fx) c.fx = { t: 'portaUp', v: (byte - 115) * 4 };
  } else if (byte >= 193 && byte <= 202) {
    if (!c.fx) c.fx = { t: 'tone', v: [1, 4, 8, 16, 32, 64, 96, 128, 255][byte - 193] };
  } else if (byte >= 203 && byte <= 212) {
    if (!c.fx) c.fx = { t: 'vib', x: 0, y: byte - 203 };
  }
}

class BitReader {
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
    this.bit = 0;
  }

  read(count) {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byteIndex = this.pos + (this.bit >> 3);
      if (byteIndex >= this.end) throw new Error('truncated IT sample');
      const bit = (this.bytes[byteIndex] >> (this.bit & 7)) & 1;
      value |= bit << i;
      this.bit += 1;
    }
    return value;
  }
}

export function decodeItSample(bytes, start, end, length, sixteen, it215) {
  const out = sixteen ? new Float32Array(length) : new Float32Array(length);
  const defWidth = sixteen ? 17 : 9;
  const fetchA = sixteen ? 4 : 3;
  const lowerB = sixteen ? -8 : -4;
  const upperB = sixteen ? 7 : 3;
  const blockSamples = sixteen ? 0x4000 : 0x8000;
  let written = 0;
  let pos = start;
  while (written < length) {
    if (pos + 2 > end) break;
    const blockSize = u16(bytes, pos);
    pos += 2;
    if (!blockSize) continue;
    const blockEnd = Math.min(end, pos + blockSize);
    const reader = new BitReader(bytes, pos, blockEnd);
    const count = Math.min(length - written, blockSamples);
    let width = defWidth;
    let mem1 = 0;
    let mem2 = 0;
    let w = 0;
    try {
      while (w < count) {
        let v = reader.read(width);
        const topBit = 1 << (width - 1);
        if (width <= 6) {
          if (v === topBit) {
            let next = reader.read(fetchA) + 1;
            if (next >= width) next += 1;
            width = next;
          } else {
            if (v & topBit) v -= topBit << 1;
            mem1 += v;
            mem2 += mem1;
            out[written + w] = (it215 ? mem2 : mem1) / (sixteen ? 32768 : 128);
            w += 1;
          }
        } else if (width < defWidth) {
          if (v >= topBit + lowerB && v <= topBit + upperB) {
            let next = v - (topBit + lowerB) + 1;
            if (next >= width) next += 1;
            width = next;
          } else {
            if (v & topBit) v -= topBit << 1;
            mem1 += v;
            mem2 += mem1;
            out[written + w] = (it215 ? mem2 : mem1) / (sixteen ? 32768 : 128);
            w += 1;
          }
        } else if (v & topBit) {
          width = (v & ~topBit) + 1;
          if (width > defWidth) break;
        } else {
          mem1 += v;
          mem2 += mem1;
          out[written + w] = (it215 ? mem2 : mem1) / (sixteen ? 32768 : 128);
          w += 1;
        }
      }
    } catch {
      /* truncated block: keep what was decoded */
    }
    written += Math.min(count, Math.max(w, 0));
    pos = blockEnd;
    if (pos <= start) break;
    start = pos;
  }
  return out;
}

export function parseIt(bytes, ext = 'it') {
  if (bytes.length < 0xc0 || ascii(bytes, 0, 4) !== 'IMPM') throw new Error('not an IT');
  const song = newSong(ext === 'mptm' || ext === 'mptmz' ? 'MPTM' : 'IT');
  song.title = fixedName(bytes, 4, 26);
  song.tracker = 'Impulse Tracker';
  const ordNum = u16(bytes, 32);
  const insNum = u16(bytes, 34);
  const smpNum = u16(bytes, 36);
  const patNum = u16(bytes, 38);
  const cwtv = u16(bytes, 40);
  const cmwt = u16(bytes, 42);
  const flags = u16(bytes, 44);
  song.initialSpeed = Math.max(1, u8(bytes, 50));
  song.initialTempo = Math.max(32, u8(bytes, 51));
  song.globalVolume = Math.min(128, u8(bytes, 48));
  song.channels = 64;
  song.channelPan = new Array(64).fill(32);
  song.channelVol = new Array(64).fill(64);

  const orderStart = 0xc0;
  for (let i = 0; i < ordNum; i += 1) {
    const o = u8(bytes, orderStart + i);
    if (o < 0xfe) song.orders.push(o);
  }
  song.orders = song.orders.length ? song.orders : [0];
  let ptr = orderStart + ordNum;
  const insPtrs = [];
  for (let i = 0; i < insNum; i += 1) insPtrs.push(u32(bytes, ptr + i * 4));
  ptr += insNum * 4;
  const smpPtrs = [];
  for (let i = 0; i < smpNum; i += 1) smpPtrs.push(u32(bytes, ptr + i * 4));
  ptr += smpNum * 4;
  const patPtrs = [];
  for (let i = 0; i < patNum; i += 1) patPtrs.push(u32(bytes, ptr + i * 4));

  for (let i = 0; i < 64; i += 1) {
    const pan = u8(bytes, 64 + i);
    const vol = Math.min(64, u8(bytes, 128 + i));
    if (pan !== 0xff) {
      const p = pan & 0x7f;
      if (p <= 64) song.channelPan[i] = p;
      if (pan & 0x80) song.channelVol[i] = 0;
    }
    if (vol !== 0xff) song.channelVol[i] = vol;
  }

  let maxChannel = 1;
  for (let p = 0; p < patNum; p += 1) {
    const pattern = newPattern(64, 64);
    pattern.channelsLen = 64;
    if (patPtrs[p]) {
      const pos0 = patPtrs[p];
      const len = u16(bytes, pos0);
      const rows = Math.max(1, Math.min(200, u16(bytes, pos0 + 2) || 64));
      let pos = pos0 + 8;
      const end = Math.min(bytes.length, pos + len);
      pattern.rows = rows;
      pattern.cells = new Array(rows * 64).fill(null);
      const mask = new Uint8Array(64);
      const last = new Array(64).fill(null);
      let row = 0;
      while (row < rows && pos < end) {
        const b = u8(bytes, pos);
        pos += 1;
        if (!b) {
          row += 1;
          continue;
        }
        let ch = b & 0x7f;
        if (ch) ch -= 1;
        if (ch >= 64) {
          mask.fill(0);
          continue;
        }
        if (ch + 1 > maxChannel) maxChannel = ch + 1;
        let m = mask[ch];
        if (b & 0x80) {
          m = u8(bytes, pos);
          pos += 1;
          mask[ch] = m;
        }
        let note = -1;
        let ins = 0;
        let vol = -1;
        let fx = null;
        if (!last[ch]) last[ch] = { note: -1, ins: 0, vol: -1, fx: null };
        if (m & 0x10) note = last[ch].note;
        if (m & 0x20) ins = last[ch].ins;
        if (m & 0x40) vol = last[ch].vol;
        if (m & 0x80) fx = last[ch].fx;
        if (m & 0x01) {
          const n = u8(bytes, pos);
          pos += 1;
          if (n === 0xff) note = IT_NOTE_OFF;
          else if (n === 0xfe) note = IT_NOTE_CUT;
          else if (n === 0xfd) note = IT_NOTE_OFF;
          else if (n < 0x80) note = n;
          last[ch].note = note;
        }
        if (m & 0x02) {
          ins = u8(bytes, pos);
          pos += 1;
          last[ch].ins = ins;
        }
        if (m & 0x04) {
          const v = u8(bytes, pos);
          pos += 1;
          const c = cell(-1, 0, -1, null);
          applyItVolumeColumn(c, v);
          vol = c.vol;
          if (c.fx) fx = c.fx;
          last[ch].vol = vol;
          last[ch].fx = fx;
        }
        if (m & 0x08) {
          const cmd = u8(bytes, pos);
          const param = u8(bytes, pos + 1);
          pos += 2;
          fx = itEffect(cmd, param);
          last[ch].fx = fx;
        }
        put(pattern, row, ch, cell(note, ins, vol, fx));
      }
    }
    song.patterns.push(pattern);
  }
  const usedChannels = Math.max(4, Math.min(64, maxChannel));
  song.channels = usedChannels;
  song.patterns.forEach((pattern) => {
    pattern.channelsLen = 64;
    pattern.cells.length = pattern.rows * 64;
  });
  song.channelPan = song.channelPan.slice(0, usedChannels);
  song.channelVol = song.channelVol.slice(0, usedChannels);

  const sampleFlags = [];
  for (let i = 0; i < smpNum; i += 1) {
    const off = smpPtrs[i];
    if (!off || off + 80 > bytes.length) {
      song.samples.push(sample(new Float32Array(0)));
      sampleFlags.push({});
      continue;
    }
    const smpFlags = u8(bytes, off + 18);
    const volume = Math.min(64, u8(bytes, off + 19));
    const name = fixedName(bytes, off + 20, 26);
    const cvt = u8(bytes, off + 46);
    const dfltPan = u8(bytes, off + 47);
    const length = u32(bytes, off + 48);
    const loopStart = u32(bytes, off + 52);
    const loopEnd = u32(bytes, off + 56);
    const c5speed = Math.max(1, u32(bytes, off + 60) || 8363);
    const dataPtr = u32(bytes, off + 72);
    const sixteen = (smpFlags & 2) !== 0;
    const compressed = (smpFlags & 8) !== 0;
    const loop = (smpFlags & 16) !== 0;
    const pingpong = (smpFlags & 64) !== 0;
    const signed = (cvt & 1) !== 0;
    const bigEndian = (cvt & 2) !== 0;
    const delta = (cvt & 4) !== 0;
    let data = new Float32Array(0);
    if (dataPtr && length) {
      if (compressed) {
        data = decodeItSample(bytes, dataPtr, bytes.length, length, sixteen, cmwt > 0x214);
        if (!signed) for (let j = 0; j < data.length; j += 1) data[j] = Math.max(-1, Math.min(1, data[j]));
      } else {
        const byteLen = Math.min(length * (sixteen ? 2 : 1), Math.max(0, bytes.length - dataPtr));
        data = sixteen ? pcm16(bytes, dataPtr, byteLen >> 1, bigEndian, delta) : pcm8(bytes, dataPtr, byteLen, true, delta || !signed);
      }
    }
    void cwtv;
    void flags;
    song.samples.push(sample(data, {
      name,
      loopStart,
      loopEnd,
      loopMode: loop ? (pingpong ? 2 : 1) : 0,
      c5speed,
      baseNote: 60,
      volume,
      panning: dfltPan & 0x80 ? Math.round(((dfltPan & 0x7f) / 64) * 64) : -1,
    }));
    sampleFlags.push({ sixteen, compressed });
  }

  for (let i = 0; i < insNum; i += 1) {
    const off = insPtrs[i];
    const name = off + 32 <= bytes.length ? fixedName(bytes, off + 32, 26) : '';
    const noteMap = new Uint8Array(120);
    if (off && off + 64 + 240 <= bytes.length) {
      for (let n = 0; n < 120; n += 1) noteMap[n] = u8(bytes, off + 64 + n * 2);
    }
    song.instruments.push({ name, noteMap, sampleBase: 0, sampleCount: smpNum });
  }
  return song;
}

// ---------------------------------------------------------------- sound bank

// Samples with actual audio data, in playback order; `number` is the 1-based
// sample slot used by the formats.
export function sampleBank(song) {
  const bank = [];
  song.samples.forEach((s, i) => {
    if (!s.data || !s.data.length) return;
    bank.push({
      number: i + 1,
      name: s.name || `Sample ${i + 1}`,
      frames: s.data.length,
      rate: Math.min(96000, Math.max(4000, Math.round(s.c5speed || 8363))),
      volume: s.volume ?? 64,
      loopMode: s.loopMode || 0,
      data: s.data,
    });
  });
  return bank;
}

// ---------------------------------------------------------------- entry point

export function parseTracker(bytes, ext = '') {
  const format = trackerFormatOf(bytes, ext);
  if (!format) throw new Error('unrecognised tracker format');
  switch (format) {
    case 'MOD':
      return parseMod(bytes, ext);
    case 'STM':
      return parseStm(bytes);
    case 'S3M':
      return parseS3m(bytes);
    case 'S3I':
      return parseS3i(bytes);
    case 'XM':
      return parseXm(bytes);
    case 'IT':
    case 'MPTM':
      return parseIt(bytes, ext);
    default:
      throw new Error(`unsupported tracker format ${format}`);
  }
}

export const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(note) {
  if (note === 254) return '^^^';
  if (note === 255) return '===';
  if (note < 0 || note > 119) return '---';
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12)}`;
}
