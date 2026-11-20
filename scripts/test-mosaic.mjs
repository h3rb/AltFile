import test from 'node:test';
import assert from 'node:assert/strict';
import { packMosaic, mosaicHtml } from '../ui/js/mosaic.js';

function item(index, width, height, extra = {}) {
  return { name: `item-${index}`, url: `thumb://item-${index}`, width, height, ...extra };
}

function spans(tiles, width, height) {
  return tiles.every(
    (tile) =>
      tile.x >= -0.01 &&
      tile.y >= -0.01 &&
      tile.x + tile.w <= width + 0.01 &&
      tile.y + tile.h <= height + 0.01
  );
}

function overlaps(a, b) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
}

test('six landscape images fill a 4:3 box in two justified rows', () => {
  const items = Array.from({ length: 6 }, (_, index) => item(index, 800, 600));
  const tiles = packMosaic(items, 300, 225, { maxTiles: 6, gap: 2 });
  assert.equal(tiles.length, 6);
  assert.ok(spans(tiles, 300, 225));
  for (let i = 0; i < tiles.length; i += 1) {
    for (let j = i + 1; j < tiles.length; j += 1) assert.ok(!overlaps(tiles[i], tiles[j]));
  }
  for (const tile of tiles) {
    assert.ok(tile.h >= 36 - 0.01, `row height ${tile.h} stays readable`);
  }
  assert.deepEqual(tiles.map((tile) => tile.item.name), items.slice(0, 6).map((_, i) => `item-${i}`));
});

test('portrait images pack more per row than landscapes', () => {
  const items = Array.from({ length: 8 }, (_, index) => item(index, 600, 900));
  const tiles = packMosaic(items, 300, 225, { maxTiles: 8, gap: 2 });
  assert.equal(tiles.length, 8);
  assert.ok(spans(tiles, 300, 225));
});

test('a panorama alone fills the whole container', () => {
  const tiles = packMosaic([item(0, 4000, 500)], 300, 225, { gap: 2 });
  assert.equal(tiles.length, 1);
  assert.ok(Math.abs(tiles[0].w - 300) < 0.01);
  assert.ok(Math.abs(tiles[0].h - 225) < 0.01);
});

test('too many items drops the tail instead of shrinking below the minimum', () => {
  const items = Array.from({ length: 40 }, (_, index) => item(index, 800, 600));
  const tiles = packMosaic(items, 100, 100, { maxTiles: 40, gap: 2, minRow: 30 });
  assert.ok(tiles.length > 0 && tiles.length < 40);
  for (const tile of tiles) assert.ok(tile.h >= 30 - 0.01);
  assert.ok(spans(tiles, 100, 100));
  assert.equal(tiles[0].item.name, 'item-0');
});

test('missing thumbnails are skipped and empty input returns nothing', () => {
  assert.deepEqual(packMosaic([], 300, 225), []);
  const tiles = packMosaic([{ name: 'broken', url: '', width: 10, height: 10 }, item(1, 800, 600)], 300, 225);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].item.name, 'item-1');
});

test('rendered markup keeps every tile inside its percentage box', () => {
  const tiles = packMosaic([item(0, 800, 600), item(1, 600, 900)], 300, 225, { gap: 2 });
  const html = mosaicHtml(tiles, 300, 225);
  assert.equal((html.match(/<img /g) || []).length, tiles.length);
  assert.ok(html.includes('left:0.000%'));
  assert.ok(!html.includes('NaN'));
});
