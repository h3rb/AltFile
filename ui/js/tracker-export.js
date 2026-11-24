import { api } from './api.js';
import { basename, dirname, joinPath } from './util.js';

const VORBIS_QUALITY = 5;

export const EXPORT_FORMATS = [
  { ext: 'ogg', label: 'OGG (Vorbis)' },
  { ext: 'flac', label: 'FLAC' },
  { ext: 'wav', label: 'WAV' },
];

export function exportFileName(sourcePath, index, ext) {
  const name = basename(sourcePath);
  const stem = name.replace(/\.[^.]+$/, '') || name;
  return `${stem}-${String(index + 1).padStart(2, '0')}.${ext}`;
}

export function quickExportPath(sourcePath, index, ext) {
  return joinPath(dirname(sourcePath), exportFileName(sourcePath, index, ext));
}

function sampleFloats(sample) {
  const out = new Float32Array(sample.frames);
  for (let i = 0; i < sample.frames; i += 1) {
    out[i] = Math.max(-1, Math.min(1, sample.data[i] || 0));
  }
  return out;
}

function wavBytes(pcm, rate) {
  const frames = pcm.length;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const write = (off, text) => {
    for (let i = 0; i < text.length; i += 1) bytes[off + i] = text.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    const v = pcm[i];
    view.setInt16(44 + i * 2, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true);
  }
  return bytes;
}

let vorbisModule = null;

async function createVorbisEncoder() {
  if (!vorbisModule) {
    try {
      vorbisModule = await import('../vendor/wasm-media-encoders.js');
    } catch (error) {
      throw new Error(`OGG Vorbis export is not available in this build (${error.message})`);
    }
  }
  return vorbisModule.createOggEncoder();
}

async function oggVorbis(pcm, rate) {
  const encoder = await createVorbisEncoder();
  encoder.configure({ sampleRate: rate, channels: 1, vbrQuality: VORBIS_QUALITY });
  const parts = [];
  const step = 4096;
  for (let offset = 0; offset < pcm.length; offset += step) {
    const chunk = encoder.encode([pcm.subarray(offset, offset + step)]);
    if (chunk.length) parts.push(chunk.slice());
  }
  const tail = encoder.finalize();
  if (tail.length) parts.push(tail.slice());
  if (!parts.length) throw new Error('The OGG Vorbis encoder produced no audio');
  return concatBytes(parts);
}

function streamInfo(rate, frames) {
  const info = new Uint8Array(34);
  const view = new DataView(info.buffer);
  view.setUint16(0, 4096);
  view.setUint16(2, 4096);
  let value = (BigInt(rate) << 44n) | (15n << 36n);
  value |= BigInt(Math.min(frames, 0xfffffffff));
  for (let i = 0; i < 8; i += 1) info[10 + i] = Number((value >> BigInt(8 * (7 - i))) & 0xffn);
  return info;
}

function flacContainer(frames, totalFrames, rate, description) {
  const parts = [];
  const magic = new TextEncoder().encode('fLaC');
  if (description && description.length >= 4 && description[0] === 0x66 && description[1] === 0x4c) {
    parts.push(description);
  } else {
    parts.push(magic);
    const info = description && description.length === 34 ? description : streamInfo(rate, totalFrames);
    parts.push(new Uint8Array([0x80, 0x00, 0x00, 0x22]));
    parts.push(info);
  }
  parts.push(...frames);
  return concatBytes(parts);
}

async function flacBytes(pcm, rate) {
  const config = { codec: 'flac', sampleRate: rate, numberOfChannels: 1, bitsPerSample: 16, bitrate: 700000 };
  const support =
    typeof AudioEncoder === 'undefined'
      ? { supported: false }
      : await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return flacVerbatim(pcm, rate);
  const frames = [];
  let description = null;
  let failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !description) {
        description = new Uint8Array(meta.decoderConfig.description);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push(data);
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(config);
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i];
    samples[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  encoder.encode(
    new AudioData({
      format: 's16',
      sampleRate: rate,
      numberOfFrames: pcm.length,
      numberOfChannels: 1,
      timestamp: 0,
      data: samples,
    })
  );
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!frames.length) throw new Error('The FLAC encoder produced no audio');
  return flacContainer(frames, pcm.length, rate, description);
}

function flacCrc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function flacCrc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function flacFrameNumber(value) {
  if (value < 0x80) return [value];
  const bits = value.toString(2);
  const extra = bits.length <= 11 ? 2 : bits.length <= 16 ? 3 : bits.length <= 21 ? 4 : bits.length <= 26 ? 5 : bits.length <= 31 ? 6 : 7;
  const firstBits = 7 - extra;
  const out = [0];
  for (let i = 0; i < extra; i += 1) out[0] |= 1 << (7 - i);
  out[0] |= parseInt(bits.slice(0, firstBits), 2) || 0;
  const rest = bits.slice(firstBits);
  for (let i = 0; i < extra - 1; i += 1) {
    out.push(0x80 | parseInt(rest.slice(i * 6, i * 6 + 6).padStart(6, '0'), 2));
  }
  return out;
}

// Verbatim-subframe FLAC is uncompressed but valid, used when WebCodecs has no FLAC encoder.
function flacVerbatim(pcm, rate) {
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i];
    samples[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  const parts = [new TextEncoder().encode('fLaC'), new Uint8Array([0x80, 0x00, 0x00, 0x22]), streamInfo(rate, pcm.length)];
  const block = 4096;
  let frame = 0;
  for (let start = 0; start < pcm.length; start += block, frame += 1) {
    const count = Math.min(block, pcm.length - start);
    const last = count < block;
    const header = [0xff, 0xf8, ((last ? 0x07 : 0x0c) << 4) | 0x00, 0x08, ...flacFrameNumber(frame)];
    if (last) header.push((count - 1) >> 8, (count - 1) & 0xff);
    const headerBytes = Uint8Array.from(header);
    const body = new Uint8Array(1 + count * 2);
    body[0] = 0x02;
    for (let i = 0; i < count; i += 1) {
      const value = samples[start + i];
      body[1 + i * 2] = (value >> 8) & 0xff;
      body[2 + i * 2] = value & 0xff;
    }
    const frameBytes = concatBytes([headerBytes, Uint8Array.from([flacCrc8(headerBytes)]), body]);
    const crc = flacCrc16(frameBytes);
    parts.push(frameBytes, Uint8Array.from([crc >> 8, crc & 0xff]));
  }
  return concatBytes(parts);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export async function encodeSample(sample, format) {
  const pcm = sampleFloats(sample);
  if (format === 'wav') return wavBytes(pcm, sample.rate);
  if (format === 'ogg') return oggVorbis(pcm, sample.rate);
  if (format === 'flac') return flacBytes(pcm, sample.rate);
  throw new Error(`Unknown export format: ${format}`);
}

function toBase64(bytes) {
  let text = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    text += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(text);
}

export async function writeSample(sample, format, path) {
  const bytes = await encodeSample(sample, format);
  await api.saveBytes(path, toBase64(bytes));
  return bytes.length;
}
