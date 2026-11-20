import { clamp, esc } from './util.js';

const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2.5;

function aspectOf(item) {
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  if (!width || !height) return 4 / 3;
  return clamp(width / height, MIN_ASPECT, MAX_ASPECT);
}

function rowsFor(items, width, rowHeight, gap) {
  const rows = [];
  let row = [];
  let x = 0;
  for (const item of items) {
    const w = Math.max(4, rowHeight * aspectOf(item));
    if (row.length && x + gap + w > width + 0.01) {
      rows.push(row);
      row = [];
      x = 0;
    }
    row.push({ item, w });
    x += (row.length > 1 ? gap : 0) + w;
  }
  if (row.length) rows.push(row);
  return rows;
}

function usedHeight(rows, rowHeight, gap) {
  return rows.length * rowHeight + Math.max(0, rows.length - 1) * gap;
}

function fit(items, width, height, gap, minRow) {
  if (usedHeight(rowsFor(items, width, minRow, gap), minRow, gap) > height + 0.5) {
    return null;
  }
  let lo = minRow;
  let hi = height;
  for (let step = 0; step < 40; step += 1) {
    const mid = (lo + hi) / 2;
    if (usedHeight(rowsFor(items, width, mid, gap), mid, gap) <= height + 0.01) lo = mid;
    else hi = mid;
  }
  const rowHeight = lo;
  const rows = rowsFor(items, width, rowHeight, gap);
  if (rows.length * rowHeight > height + 0.5) return null;

  const y0 = Math.max(0, (height - usedHeight(rows, rowHeight, gap)) / 2);
  const tiles = [];
  let y = y0;
  for (const row of rows) {
    const natural = row.reduce((sum, cell) => sum + cell.w, 0) + gap * (row.length - 1);
    const scale = natural > 0 ? width / natural : 1;
    const step = gap * scale;
    let x = 0;
    row.forEach((cell, index) => {
      const w = index === row.length - 1 ? width - x : cell.w * scale;
      tiles.push({ item: cell.item, x, y, w, h: rowHeight });
      x += w + step;
    });
    y += rowHeight + gap;
  }
  return tiles;
}

/// Packs the most leading items that fit into width × height at a readable
/// minimum tile height. Rows are justified so each one spans the container.
export function packMosaic(items, width, height, options = {}) {
  if (!Array.isArray(items) || !items.length || width < 8 || height < 8) return [];
  const maxTiles = Math.max(1, options.maxTiles || 12);
  const gap = options.gap ?? 2;
  const minRow = options.minRow || clamp(height * 0.16, 18, 54);
  const pool = items.filter((item) => item && item.url).slice(0, maxTiles);
  for (let count = pool.length; count >= 1; count -= 1) {
    const tiles = fit(pool.slice(0, count), width, height, gap, minRow);
    if (tiles) return tiles;
  }
  return [];
}

export function mosaicHtml(tiles, width, height) {
  return tiles
    .map(({ item, x, y, w, h }) => {
      const style = [
        `left:${((x / width) * 100).toFixed(3)}%`,
        `top:${((y / height) * 100).toFixed(3)}%`,
        `width:${((w / width) * 100).toFixed(3)}%`,
        `height:${((h / height) * 100).toFixed(3)}%`,
      ].join(';');
      return `<img src="${esc(item.url)}" alt="" title="${esc(item.name || '')}" draggable="false" decoding="async" style="${style}">`;
    })
    .join('');
}
