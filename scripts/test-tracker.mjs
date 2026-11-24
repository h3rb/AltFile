import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeItSample,
  noteName,
  parseTracker,
  sampleBank,
  trackerFormatOf,
} from '../ui/js/tracker-formats.js';

function buf(size) {
  return new Uint8Array(size);
}

function str(bytes, off, text) {
  for (let i = 0; i < text.length; i += 1) bytes[off + i] = text.charCodeAt(i);
}

function le16(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >> 8) & 0xff;
}

function le32(bytes, off, value) {
  bytes[off] = value & 0xff;
  bytes[off + 1] = (value >> 8) & 0xff;
  bytes[off + 2] = (value >> 16) & 0xff;
  bytes[off + 3] = (value >> 24) & 0xff;
}

function be16(bytes, off, value) {
  bytes[off] = (value >> 8) & 0xff;
  bytes[off + 1] = value & 0xff;
}

function modFile() {
  const sampleLen = 32;
  const bytes = buf(1084 + 64 * 4 * 4 + sampleLen);
  str(bytes, 0, 'modtest');
  str(bytes, 20, 'bass');
  be16(bytes, 20 + 22, sampleLen / 2);
  bytes[20 + 25] = 64;
  bytes[950] = 1;
  bytes[951] = 0;
  bytes[952] = 0;
  str(bytes, 1080, 'M.K.');
  const cellOff = 1084;
  bytes[cellOff] = 0x01;
  bytes[cellOff + 1] = 428 & 0xff;
  bytes[cellOff + 2] = 0x10;
  bytes[cellOff + 3] = 0x00;
  const data = 1084 + 64 * 4 * 4;
  bytes[data] = 0;
  bytes[data + 1] = 64;
  bytes[data + 2] = 192;
  return bytes;
}

function stmFile() {
  const sampleLen = 16;
  const orderStart = 0x410;
  const patternStart = orderStart + 64;
  const sampleStart = 0x560;
  const bytes = buf(sampleStart + sampleLen);
  str(bytes, 0, 'stmtest');
  bytes[28] = 0x1a;
  bytes[29] = 2;
  bytes[30] = 2;
  bytes[31] = 0;
  bytes[0x20] = 0x60;
  bytes[0x21] = 1;
  bytes[0x22] = 64;
  str(bytes, 0x30, 'wave');
  le16(bytes, 0x30 + 14, sampleStart / 16);
  le16(bytes, 0x30 + 16, sampleLen);
  bytes[0x30 + 22] = 64;
  le16(bytes, 0x30 + 24, 8448);
  bytes[orderStart] = 0;
  for (let i = 1; i < 64; i += 1) bytes[orderStart + i] = 0x63;
  bytes[patternStart] = 0x40;
  bytes[patternStart + 1] = 1 << 3;
  for (let i = 4; i < 64 * 4; i += 1) bytes[patternStart + i] = 0xfc;
  for (let i = 0; i < sampleLen; i += 1) bytes[sampleStart + i] = i === 0 ? 0 : 64;
  return bytes;
}

function s3mFile() {
  const bytes = buf(0x320);
  str(bytes, 0, 's3mtest');
  le16(bytes, 32, 1);
  le16(bytes, 34, 1);
  le16(bytes, 36, 1);
  str(bytes, 44, 'SCRM');
  bytes[48] = 64;
  bytes[49] = 6;
  bytes[50] = 125;
  bytes[96] = 0;
  le16(bytes, 97, 0x1e);
  le16(bytes, 99, 0x26);
  const pat = 0x260;
  le16(bytes, pat, 3 + 64);
  le16(bytes, pat + 2, 64);
  bytes[pat + 4] = 0x20;
  bytes[pat + 5] = 0x40;
  bytes[pat + 6] = 1;
  const ins = 0x1e0;
  bytes[ins] = 1;
  bytes[ins + 13] = 0;
  le16(bytes, ins + 14, 0x30);
  le32(bytes, ins + 16, 32);
  bytes[ins + 28] = 64;
  le32(bytes, ins + 32, 8363);
  str(bytes, ins + 48, 'wave');
  for (let i = 0; i < 32; i += 1) bytes[0x300 + i] = i === 0 ? 128 : 192;
  return bytes;
}

function xmFile() {
  const patternStart = 81;
  const patternData = [
    0x03, 61, 1, 0,
  ];
  while (patternData.length < 128) patternData.push(0);
  const instStart = patternStart + 9 + patternData.length;
  const sampleHeaderStart = instStart + 129;
  const sampleDataStart = sampleHeaderStart + 40;
  const bytes = buf(sampleDataStart + 16);
  str(bytes, 0, 'Extended Module: ');
  str(bytes, 17, 'xmtest');
  str(bytes, 38, 'FastTracker v2.00');
  le16(bytes, 58, 0x0104);
  le32(bytes, 60, 21);
  le16(bytes, 64, 1);
  le16(bytes, 68, 2);
  le16(bytes, 70, 1);
  le16(bytes, 72, 1);
  le16(bytes, 76, 6);
  le16(bytes, 78, 125);
  bytes[80] = 0;
  le32(bytes, patternStart, 9);
  le16(bytes, patternStart + 5, 64);
  le16(bytes, patternStart + 7, patternData.length);
  for (let i = 0; i < patternData.length; i += 1) bytes[patternStart + 9 + i] = patternData[i];
  le32(bytes, instStart, 129);
  str(bytes, instStart + 4, 'inst');
  le16(bytes, instStart + 27, 1);
  le32(bytes, instStart + 29, 40);
  for (let n = 0; n < 96; n += 1) bytes[instStart + 33 + n] = 1;
  le32(bytes, sampleHeaderStart, 16);
  bytes[sampleHeaderStart + 12] = 64;
  bytes[sampleHeaderStart + 15] = 128;
  str(bytes, sampleHeaderStart + 18, 'smp');
  for (let i = 0; i < 16; i += 1) bytes[sampleDataStart + i] = i === 0 ? 0 : 8;
  return bytes;
}

function itSampleHeader(bytes, off, { dataPtr, length = 16, flags = 0x01, cvt = 1, cmwt = 0x0214 }) {
  bytes[off + 18] = flags;
  bytes[off + 19] = 64;
  str(bytes, off + 20, 'itsmp');
  bytes[off + 46] = cvt;
  bytes[off + 47] = 0x80;
  le32(bytes, off + 48, length);
  le32(bytes, off + 60, 8363);
  le32(bytes, off + 72, dataPtr);
  str(bytes, off + 0, 'IMPI');
  bytes[off + 16] = 1;
  bytes[off + 17] = cmwt & 0xff;
}

function itFile({ compressed = false } = {}) {
  const bytes = buf(0x2a0);
  str(bytes, 0, 'IMPM');
  str(bytes, 4, 'ittest');
  le16(bytes, 32, 1);
  le16(bytes, 34, 0);
  le16(bytes, 36, 1);
  le16(bytes, 38, 1);
  le16(bytes, 40, 0x0214);
  le16(bytes, 42, compressed ? 0x0215 : 0x0214);
  bytes[48] = 128;
  bytes[50] = 6;
  bytes[51] = 125;
  for (let i = 0; i < 64; i += 1) {
    bytes[64 + i] = 0xff;
    bytes[128 + i] = 0xff;
  }
  bytes[0xc0] = 0;
  le32(bytes, 0xc1, 0x100);
  le32(bytes, 0xc5, 0x200);
  const pat = 0x200;
  const patData = [0x81, 0x03, 60, 1];
  while (patData.length < 68) patData.push(0);
  le16(bytes, pat, patData.length);
  le16(bytes, pat + 2, 64);
  for (let i = 0; i < patData.length; i += 1) bytes[pat + 8 + i] = patData[i];
  itSampleHeader(bytes, 0x100, {
    dataPtr: 0x280,
    flags: compressed ? 0x09 : 0x01,
    length: 16,
    cmwt: compressed ? 0x0215 : 0x0214,
  });
  if (compressed) {
    le16(bytes, 0x280, 2);
    bytes[0x282] = 0x05;
    le16(bytes, 0x284, 3);
    bytes[0x286] = 0x01;
  } else {
    bytes[0x280] = 0;
    bytes[0x281] = 32;
    bytes[0x282] = 224;
  }
  return bytes;
}

function s3iFile() {
  const bytes = buf(96);
  str(bytes, 4, 's3itest');
  str(bytes, 76, 'SCRS');
  le32(bytes, 16, 16);
  le32(bytes, 20, 0);
  le32(bytes, 24, 16);
  bytes[28] = 64;
  le32(bytes, 32, 8363);
  for (let i = 0; i < 16; i += 1) bytes[80 + i] = 128 + (i % 4) * 16;
  return bytes;
}

test('sniffs tracker formats from magic and extension', () => {
  assert.equal(trackerFormatOf(modFile(), 'mod'), 'MOD');
  assert.equal(trackerFormatOf(stmFile(), 'stm'), 'STM');
  assert.equal(trackerFormatOf(s3mFile(), 's3m'), 'S3M');
  assert.equal(trackerFormatOf(xmFile(), 'xm'), 'XM');
  assert.equal(trackerFormatOf(itFile(), 'it'), 'IT');
  assert.equal(trackerFormatOf(buf(8), 'mdz'), 'MOD');
  assert.equal(trackerFormatOf(buf(8), 'mptmz'), 'MPTM');
  assert.equal(trackerFormatOf(buf(8), 'nope'), null);
});

test('note names follow tracker convention', () => {
  assert.equal(noteName(0), 'C-0');
  assert.equal(noteName(60), 'C-5');
  assert.equal(noteName(254), '^^^');
  assert.equal(noteName(255), '===');
  assert.equal(noteName(-1), '---');
});

test('parses a MOD with period notes and PCM sample', () => {
  const song = parseTracker(modFile(), 'mod');
  assert.equal(song.format, 'MOD');
  assert.equal(song.title, 'modtest');
  assert.equal(song.channels, 4);
  assert.deepEqual(song.orders, [0]);
  assert.equal(song.patterns.length, 1);
  assert.equal(song.patterns[0].rows, 64);
  const cell = song.patterns[0].cells[0];
  assert.equal(cell.note, 36);
  assert.equal(cell.ins, 1);
  assert.equal(song.samples.length, 31);
  assert.equal(song.samples[0].data.length, 32);
  assert.ok(Math.abs(song.samples[0].data[1] - 0.5) < 1e-6);
  assert.equal(song.samples[0].baseNote, 36);
});

test('parses an STM v2 with packed patterns', () => {
  const song = parseTracker(stmFile(), 'stm');
  assert.equal(song.format, 'STM');
  assert.equal(song.title, 'stmtest');
  assert.equal(song.initialSpeed, 6);
  assert.equal(song.initialTempo, 125);
  assert.equal(song.orders[0], 0);
  assert.equal(song.patterns[0].cells[0].note, 48);
  assert.equal(song.patterns[0].cells[0].ins, 1);
  assert.equal(song.patterns[0].cells[1], null);
  assert.equal(song.samples[0].data.length, 16);
  assert.ok(Math.abs(song.samples[0].data[1] - 0.5) < 1e-6);
});

test('parses an S3M with packed pattern and unsigned sample', () => {
  const song = parseTracker(s3mFile(), 's3m');
  assert.equal(song.format, 'S3M');
  assert.equal(song.title, 's3mtest');
  assert.equal(song.initialSpeed, 6);
  assert.equal(song.initialTempo, 125);
  assert.equal(song.patterns[0].cells[0].note, 48);
  assert.equal(song.patterns[0].cells[0].ins, 1);
  assert.equal(song.samples.length, 1);
  assert.equal(song.samples[0].data.length, 32);
  assert.ok(Math.abs(song.samples[0].data[0] - 0) < 1e-6);
  assert.ok(Math.abs(song.samples[0].data[1] - 0.5) < 1e-6);
});

test('parses an S3I/S3T instrument as a one-sample sound bank', () => {
  const song = parseTracker(s3iFile(), 's3t');
  assert.equal(song.format, 'S3I');
  assert.equal(song.samples.length, 1);
  const bank = sampleBank(song);
  assert.equal(bank.length, 1);
  assert.equal(bank[0].number, 1);
  assert.equal(bank[0].name, 's3itest');
  assert.equal(bank[0].rate, 8363);
  assert.equal(bank[0].frames, 16);
});

test('sound bank skips empty sample slots', () => {
  const mod = sampleBank(parseTracker(modFile(), 'mod'));
  assert.equal(mod.length, 1);
  assert.equal(mod[0].number, 1);
  assert.equal(mod[0].name, 'bass');
  const s3m = sampleBank(parseTracker(s3mFile(), 's3m'));
  assert.equal(s3m.length, 1);
  assert.equal(s3m[0].frames, 32);
});

test('parses an XM with delta samples and instrument note map', () => {
  const song = parseTracker(xmFile(), 'xm');
  assert.equal(song.format, 'XM');
  assert.equal(song.title, 'xmtest');
  assert.equal(song.channels, 2);
  assert.equal(song.patterns[0].cells[0].note, 60);
  assert.equal(song.patterns[0].cells[0].ins, 1);
  assert.equal(song.instruments.length, 1);
  assert.equal(song.instruments[0].noteMap[60], 1);
  assert.equal(song.samples.length, 1);
  assert.ok(Math.abs(song.samples[0].data[1] - 8 / 128) < 1e-6);
  assert.ok(Math.abs(song.samples[0].data[2] - 16 / 128) < 1e-6);
  assert.equal(song.samples[0].baseNote, 60);
});

test('parses an IT with uncompressed signed sample', () => {
  const song = parseTracker(itFile(), 'it');
  assert.equal(song.format, 'IT');
  assert.equal(song.title, 'ittest');
  assert.equal(song.orders[0], 0);
  assert.equal(song.patterns[0].cells[0].note, 60);
  assert.equal(song.patterns[0].cells[0].ins, 1);
  assert.equal(song.samples.length, 1);
  assert.ok(Math.abs(song.samples[0].data[1] - 0.25) < 1e-6);
  assert.equal(song.samples[0].baseNote, 60);
});

test('decodes IT214/IT215 compressed deltas', () => {
  const block = new Uint8Array([0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  const it214 = decodeItSample(block, 0, block.length, 2, false, false);
  const it215 = decodeItSample(block, 0, block.length, 2, false, true);
  assert.ok(Math.abs(it214[0] - 1 / 128) < 1e-6);
  assert.ok(Math.abs(it214[1] - 1 / 128) < 1e-6);
  assert.ok(Math.abs(it215[0] - 1 / 128) < 1e-6);
  assert.ok(Math.abs(it215[1] - 2 / 128) < 1e-6);
});
