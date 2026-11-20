import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleChips } from '../ui/js/chipfit.js';

const DEFS = [
  { id: 'all', label: 'All' },
  { id: 'folders', label: 'Folders' },
  { id: 'images', label: 'Images' },
  { id: 'videos', label: 'Videos' },
  { id: 'recent', label: 'Recent', smart: true },
  { id: 'large', label: 'Large', smart: true },
];

test('keeps All and smart chips even with no matches', () => {
  const ids = visibleChips(DEFS, new Map()).map((def) => def.id);
  assert.deepEqual(ids, ['all', 'recent', 'large']);
});

test('drops category chips that have no entries', () => {
  const ids = visibleChips(DEFS, new Map([['folders', 4], ['videos', 0]])).map((def) => def.id);
  assert.deepEqual(ids, ['all', 'folders', 'recent', 'large']);
});

test('keeps every populated category in definition order', () => {
  const counts = new Map([['videos', 2], ['folders', 9], ['images', 1]]);
  const ids = visibleChips(DEFS, counts).map((def) => def.id);
  assert.deepEqual(ids, ['all', 'folders', 'images', 'videos', 'recent', 'large']);
});

test('keeps the active filter visible even when it has no entries', () => {
  const ids = visibleChips(DEFS, new Map([['folders', 3]]), 'videos').map((def) => def.id);
  assert.deepEqual(ids, ['all', 'folders', 'videos', 'recent', 'large']);
});

test('keeps active smart filter once', () => {
  const ids = visibleChips(DEFS, new Map(), 'recent').map((def) => def.id);
  assert.deepEqual(ids, ['all', 'recent', 'large']);
});
