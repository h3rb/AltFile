import { mediaUrl } from './api.js';
import { state } from './state.js';
import { esc, humanCount, kindColor } from './util.js';
import { icon } from './icons.js';

const SF2_EXTS = new Set(['sf2']);
const CHUNK = 16 * 1024 * 1024;
const HEADER_PEEK = 64 * 1024;
const MAX_PDTA = 12 * 1024 * 1024;
const MAX_SF2 = 256 * 1024 * 1024;

const MAX_ACTIVE = 2;
const MAX_CACHE = 600;
const metaCache = new Map();
const fullCache = new Map();
const queue = [];
let active = 0;
let observer = null;

const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startloopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  exclusiveClass: 57,
  overridingRootKey: 58,
  delayVolEnv: 34,
  attackVolEnv: 35,
  holdVolEnv: 36,
  decayVolEnv: 37,
  sustainVolEnv: 38,
  releaseVolEnv: 39,
};

function decoder() {
  return new TextDecoder('latin1');
}

function cstr(bytes) {
  const end = bytes.indexOf(0);
  return decoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
}

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function isSoundfontEntry(entry) {
  return !!entry && !entry.isDir && SF2_EXTS.has((entry.ext || '').toLowerCase());
}

function subchunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const map = new Map();
  let p = 0;
  while (p + 8 <= bytes.length) {
    const id = fourcc(bytes, p);
    const size = dv.getUint32(p + 4, true);
    p += 8;
    if (p + size > bytes.length) break;
    map.set(id, bytes.subarray(p, p + size));
    p += size + (size & 1);
  }
  return map;
}

function parseInfo(bytes) {
  const info = { name: '', copyright: '', engine: '', software: '', comment: '', version: '' };
  if (!bytes) return info;
  for (const [id, data] of subchunks(bytes)) {
    if (id === 'INAM') info.name = cstr(data);
    else if (id === 'ICOP') info.copyright = cstr(data);
    else if (id === 'isng') info.engine = cstr(data);
    else if (id === 'ISFT') info.software = cstr(data);
    else if (id === 'ICMT') info.comment = cstr(data);
    else if (id === 'ifil' && data.length >= 4) {
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      info.version = `${v.getUint16(0, true)}.${v.getUint16(2, true)}`;
    }
  }
  return info;
}

function records(bytes, stride) {
  if (!bytes) return { dv: null, count: 0, base: 0 };
  return {
    dv: new DataView(bytes.buffer),
    count: Math.floor(bytes.length / stride),
    base: bytes.byteOffset,
  };
}

function parsePdta(bytes, { full = false, smpl = null } = {}) {
  const chunks = subchunks(bytes);
  const phdr = records(chunks.get('phdr'), 38);
  const pbag = records(chunks.get('pbag'), 4);
  const pgen = records(chunks.get('pgen'), 4);
  const inst = records(chunks.get('inst'), 22);
  const ibag = records(chunks.get('ibag'), 4);
  const igen = records(chunks.get('igen'), 4);
  const shdr = records(chunks.get('shdr'), 46);

  const presetCount = Math.max(0, phdr.count - 1);
  const instrumentCount = Math.max(0, inst.count - 1);
  const sampleCount = Math.max(0, shdr.count - 1);

  const presets = [];
  for (let i = 0; i < presetCount; i += 1) {
    const off = phdr.base + i * 38;
    presets.push({
      name: cstr(new Uint8Array(phdr.dv.buffer, off, 20)),
      program: phdr.dv.getUint16(off + 20, true),
      bank: phdr.dv.getUint16(off + 22, true),
      bagNdx: phdr.dv.getUint16(off + 24, true),
    });
  }

  const meta = {
    presetCount,
    instrumentCount,
    sampleCount,
    presets: presets.map((p) => ({ name: p.name, bank: p.bank, program: p.program })),
  };
  if (!full) return meta;

  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const off = shdr.base + i * 46;
    const start = shdr.dv.getUint32(off + 20, true);
    const end = shdr.dv.getUint32(off + 24, true);
    const loopStart = shdr.dv.getUint32(off + 28, true);
    const loopEnd = shdr.dv.getUint32(off + 32, true);
    const sampleRate = shdr.dv.getUint32(off + 36, true) || 44100;
    const rootKey = shdr.dv.getUint8(off + 40);
    const pitchCorrection = shdr.dv.getInt8(off + 41);
    const type = shdr.dv.getUint16(off + 44, true);
    const frames = Math.max(0, Math.min(end, smpl ? smpl.length : 0) - start);
    const data = new Float32Array(frames);
    if (smpl) {
      for (let f = 0; f < frames; f += 1) data[f] = smpl[start + f] / 32768;
    }
    samples.push({
      name: cstr(new Uint8Array(shdr.dv.buffer, off, 20)),
      data,
      sampleRate,
      rootKey: rootKey === 255 ? 60 : rootKey,
      pitchCorrection,
      loopStart: Math.max(0, loopStart - start),
      loopEnd: Math.max(0, loopEnd - start),
      type,
    });
  }

  const readGens = (bagRec, genRec, bagIndex) => {
    const start = bagRec.dv.getUint16(bagRec.base + bagIndex * 4, true);
    const end = bagIndex + 1 < bagRec.count
      ? bagRec.dv.getUint16(bagRec.base + (bagIndex + 1) * 4, true)
      : genRec.count;
    const out = [];
    for (let g = start; g < end && g < genRec.count; g += 1) {
      const off = genRec.base + g * 4;
      out.push({ oper: genRec.dv.getUint16(off, true), amount: genRec.dv.getUint16(off + 2, true) });
    }
    return out;
  };

  const zoneFrom = (gens, isInstrument) => {
    const zone = {
      keyLow: 0, keyHigh: 127, velLow: 0, velHigh: 127,
      sample: -1, instrument: -1, rootKey: -1, coarseTune: 0, fineTune: 0,
      attenuation: 0, loopMode: 0, startOffset: 0, endOffset: 0,
      loopStartOffset: 0, loopEndOffset: 0, exclusiveClass: 0,
      attack: -12000, hold: -12000, decay: -12000, sustain: 0, release: -12000,
    };
    for (const { oper, amount } of gens) {
      const signed = amount > 32767 ? amount - 65536 : amount;
      switch (oper) {
        case GEN.keyRange: zone.keyLow = amount & 0xff; zone.keyHigh = (amount >> 8) & 0xff; break;
        case GEN.velRange: zone.velLow = amount & 0xff; zone.velHigh = (amount >> 8) & 0xff; break;
        case GEN.sampleID: zone.sample = amount; break;
        case GEN.instrument: zone.instrument = amount; break;
        case GEN.overridingRootKey: zone.rootKey = amount; break;
        case GEN.coarseTune: zone.coarseTune = signed; break;
        case GEN.fineTune: zone.fineTune = signed; break;
        case GEN.initialAttenuation: zone.attenuation = signed; break;
        case GEN.sampleModes: zone.loopMode = amount; break;
        case GEN.exclusiveClass: zone.exclusiveClass = amount; break;
        case GEN.startAddrsOffset: zone.startOffset += signed; break;
        case GEN.startAddrsCoarseOffset: zone.startOffset += signed * 32768; break;
        case GEN.endAddrsOffset: zone.endOffset += signed; break;
        case GEN.endAddrsCoarseOffset: zone.endOffset += signed * 32768; break;
        case GEN.startloopAddrsOffset: zone.loopStartOffset += signed; break;
        case GEN.startloopAddrsCoarseOffset: zone.loopStartOffset += signed * 32768; break;
        case GEN.endloopAddrsOffset: zone.loopEndOffset += signed; break;
        case GEN.attackVolEnv: zone.attack = signed; break;
        case GEN.holdVolEnv: zone.hold = signed; break;
        case GEN.decayVolEnv: zone.decay = signed; break;
        case GEN.sustainVolEnv: zone.sustain = signed; break;
        case GEN.releaseVolEnv: zone.release = signed; break;
        default: break;
      }
    }
    return zone;
  };

  const instruments = [];
  for (let i = 0; i < instrumentCount; i += 1) {
    const off = inst.base + i * 22;
    const bagStart = inst.dv.getUint16(off + 20, true);
    const bagEnd = i + 1 < inst.count
      ? inst.dv.getUint16(inst.base + (i + 1) * 22 + 20, true)
      : ibag.count;
    const zones = [];
    for (let b = bagStart; b < bagEnd && b < ibag.count; b += 1) {
      zones.push(zoneFrom(readGens(ibag, igen, b), true));
    }
    instruments.push({ name: cstr(new Uint8Array(inst.dv.buffer, off, 20)), zones });
  }

  for (let i = 0; i < presetCount; i += 1) {
    const bagStart = presets[i].bagNdx;
    const bagEnd = i + 1 < presetCount ? presets[i + 1].bagNdx : pbag.count;
    const zones = [];
    for (let b = bagStart; b < bagEnd && b < pbag.count; b += 1) {
      zones.push(zoneFrom(readGens(pbag, pgen, b), false));
    }
    presets[i].zones = zones;
  }

  return { ...meta, presets, instruments, samples };
}

export function parseSf2(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'sfbk') {
    throw new Error('Not a SoundFont (SF2) file');
  }
  const dv = new DataView(buffer);
  const lists = new Map();
  let p = 12;
  const riffEnd = Math.min(bytes.length, 8 + dv.getUint32(4, true));
  while (p + 8 <= riffEnd) {
    const id = fourcc(bytes, p);
    const size = dv.getUint32(p + 4, true);
    if (id === 'LIST') {
      const type = fourcc(bytes, p + 8);
      const bodyStart = p + 12;
      const bodyEnd = Math.min(bodyStart + size - 4, bytes.length);
      lists.set(type, bytes.subarray(bodyStart, bodyEnd));
    }
    p += 8 + size + (size & 1);
  }
  const info = parseInfo(lists.get('INFO'));
  const sdta = lists.get('sdta');
  let smpl = null;
  if (sdta) {
    const smplBytes = subchunks(sdta).get('smpl');
    if (smplBytes) {
      smpl = new Int16Array(smplBytes.buffer, smplBytes.byteOffset, Math.floor(smplBytes.length / 2));
    }
  }
  const pdta = parsePdta(lists.get('pdta') || new Uint8Array(0), { full: true, smpl });
  return { info, ...pdta };
}

async function fetchRange(path, start, end) {
  const res = await fetch(mediaUrl(path), { headers: { Range: `bytes=${start}-${end}` } });
  if (!res.ok && res.status !== 206) throw new Error(`Read failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchAll(path, size) {
  const total = Math.min(size, MAX_SF2);
  const out = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK - 1, total - 1);
    const part = await fetchRange(path, offset, end);
    out.set(part.subarray(0, end - offset + 1), offset);
    offset += part.length || end - offset + 1;
    if (!part.length) break;
  }
  return out.buffer;
}

function sizeFromHeaders(res) {
  const range = res.headers.get('content-range');
  const total = range && /\/(\d+)\s*$/.exec(range.trim());
  if (total) return Number(total[1]) || 0;
  return Number(res.headers.get('content-length')) || 0;
}

export async function soundfontMetaFor(path, size = 0) {
  const head = await fetchRange(path, 0, HEADER_PEEK - 1);
  if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'sfbk') {
    throw new Error('Not a SoundFont (SF2) file');
  }
  const hdv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const riffEnd = Math.min(size || Infinity, 8 + hdv.getUint32(4, true));
  let info = { name: '', copyright: '', engine: '', software: '', comment: '', version: '' };
  let pdta = { presetCount: 0, instrumentCount: 0, sampleCount: 0, presets: [] };
  let p = 12;
  let guard = 0;
  while (p + 12 <= riffEnd && guard < 16) {
    guard += 1;
    const hdr = p + 12 <= head.length ? head.subarray(p, p + 12) : await fetchRange(path, p, p + 11);
    if (hdr.length < 12 || fourcc(hdr, 0) !== 'LIST') break;
    const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength);
    const listSize = dv.getUint32(4, true);
    const type = fourcc(hdr, 8);
    const bodyOffset = p + 12;
    const bodySize = Math.max(0, listSize - 4);
    if (type === 'INFO') {
      if (bodyOffset < head.length) {
        info = parseInfo(head.subarray(bodyOffset, Math.min(bodyOffset + bodySize, head.length)));
      } else {
        const want = Math.min(bodySize, 8192);
        info = parseInfo(await fetchRange(path, bodyOffset, bodyOffset + want - 1));
      }
    } else if (type === 'pdta' && bodySize > 0) {
      const want = Math.min(bodySize, MAX_PDTA);
      pdta = parsePdta(await fetchRange(path, bodyOffset, bodyOffset + want - 1), { full: false });
    }
    p += 8 + listSize + (listSize & 1);
  }
  return { ...info, ...pdta, sizeBytes: size };
}

export function loadSoundfont(path) {
  const key = path.toLowerCase();
  let pending = fullCache.get(key);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(mediaUrl(path), { method: 'HEAD' });
      const size = sizeFromHeaders(res);
      const buffer = await fetchAll(path, size || MAX_SF2);
      return parseSf2(buffer);
    })();
    fullCache.set(key, pending);
    if (fullCache.size > 8) {
      const oldest = fullCache.keys().next().value;
      if (oldest !== undefined && oldest !== key) fullCache.delete(oldest);
    }
    pending.catch(() => {
      if (fullCache.get(key) === pending) fullCache.delete(key);
    });
  }
  return pending;
}

export function soundfontTileHtml(entry, { large = false } = {}) {
  if (!isSoundfontEntry(entry)) return '';
  const color = kindColor('soundfont');
  const inUse = state.soundFont && state.soundFont.toLowerCase() === entry.path.toLowerCase();
  return `
    <div class="sf2-tile${large ? ' large' : ''}${inUse ? ' in-use' : ''}" data-sf2-path="${esc(entry.path)}" data-sf2-mtime="${entry.modified || 0}" data-sf2-size="${entry.size || 0}" style="--kind-color:${color};--kind-glow:rgba(52,211,153,0.14)">
      <div class="sf2-head">${icon('piano', 11)}<span>SF2</span>${inUse ? '<span class="sf2-use">MIDI</span>' : ''}</div>
      <div class="sf2-keys" aria-hidden="true">
        <svg viewBox="0 0 60 34" preserveAspectRatio="none">
          <rect x="1" y="1" width="58" height="32" rx="2" class="sf2-keys-body"/>
          <path d="M11 1v32M21 1v32M31 1v32M41 1v32M51 1v32" class="sf2-keys-line"/>
          <rect x="8" y="1" width="6" height="19" class="sf2-black"/>
          <rect x="18" y="1" width="6" height="19" class="sf2-black"/>
          <rect x="38" y="1" width="6" height="19" class="sf2-black"/>
          <rect x="48" y="1" width="6" height="19" class="sf2-black"/>
        </svg>
      </div>
      <div class="sf2-name" hidden></div>
      <div class="sf2-foot" hidden>
        <span class="sf2-count">${icon('piano', 9)}<b data-role="presets"></b></span>
        <span class="sf2-count">${icon('waveform', 9)}<b data-role="samples"></b></span>
      </div>
      <div class="sf2-skeleton" aria-hidden="true"><i></i><i></i></div>
      <div class="sf2-note" hidden></div>
    </div>`;
}

function applySoundfont(el, meta) {
  if (!el) return;
  el.querySelector('.sf2-skeleton')?.remove();
  if (!meta) {
    el.classList.add('sf2-unknown');
    const note = el.querySelector('.sf2-note');
    if (note) { note.textContent = 'SoundFont'; note.hidden = false; }
    return;
  }
  const name = el.querySelector('.sf2-name');
  const label = (meta.name || '').trim();
  if (name && label) { name.textContent = label; name.title = label; name.hidden = false; }
  const presets = el.querySelector('[data-role="presets"]');
  const samples = el.querySelector('[data-role="samples"]');
  if (presets) presets.textContent = humanCount(meta.presetCount);
  if (samples) samples.textContent = humanCount(meta.sampleCount);
  const foot = el.querySelector('.sf2-foot');
  if (foot) foot.hidden = false;
  el.title = `${label || 'SoundFont'} · ${humanCount(meta.presetCount)} presets · ${humanCount(meta.instrumentCount)} instruments · ${humanCount(meta.sampleCount)} samples`;
}

function metaKey(path, mtime) {
  return `${path.toLowerCase()}|${mtime}`;
}

function metaFor(path, mtime, size) {
  const key = metaKey(path, mtime);
  let pending = metaCache.get(key);
  if (!pending) {
    pending = soundfontMetaFor(path, size).catch(() => null);
    metaCache.set(key, pending);
    if (metaCache.size > MAX_CACHE) {
      const oldest = metaCache.keys().next().value;
      if (oldest !== undefined) metaCache.delete(oldest);
    }
  }
  return pending;
}

export function soundfontMeta(path, mtime = 0, size = 0) {
  return metaFor(path, mtime, size);
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    if (!job.el.isConnected) continue;
    active += 1;
    metaFor(job.path, job.mtime, job.size)
      .then((meta) => { if (job.el.isConnected) applySoundfont(job.el, meta); })
      .finally(() => { active -= 1; pump(); });
  }
}

function loadTile(el) {
  if (!el || el.dataset.sf2Loaded === '1') return;
  el.dataset.sf2Loaded = '1';
  const path = el.dataset.sf2Path;
  if (!path) return;
  queue.push({ path, mtime: Number(el.dataset.sf2Mtime) || 0, size: Number(el.dataset.sf2Size) || 0, el });
  pump();
}

export function observeSoundfontTiles(root) {
  const scope = root || document.getElementById('files-scroll') || document;
  const targets = [...scope.querySelectorAll('.sf2-tile[data-sf2-path]')];
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) { targets.forEach(loadTile); return; }
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadTile(entry.target);
      }
    },
    { rootMargin: '320px 0px' }
  );
  targets.forEach((target) => observer.observe(target));
}