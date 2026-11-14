import { pageUrl } from './api.js';
import { esc } from './util.js';

const PAGE_EXTS = new Set(['html', 'htm', 'md', 'markdown']);
const PAGE_WIDTH = 1024;
const MAX_FRAMES = 16;

const wanted = new Set();
const frames = new Map();
let observer = null;
let resizer = null;

export function isPageEntry(entry) {
  return Boolean(entry && !entry.isDir && PAGE_EXTS.has((entry.ext || '').toLowerCase()));
}

export function pageTileHtml(entry) {
  if (!isPageEntry(entry)) return '';
  return `
        <div class="page-tile" data-page-path="${esc(entry.path)}" data-page-mtime="${entry.modified || 0}">
          <span class="page-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        </div>`;
}

function updateScale(tile) {
  const frame = frames.get(tile);
  if (!frame) return;
  const width = tile.clientWidth;
  if (!width) return;
  frame.style.transform = `scale(${width / PAGE_WIDTH})`;
}

function mount(tile) {
  if (frames.has(tile) || !tile.isConnected) return;
  const frame = document.createElement('iframe');
  frame.className = 'page-frame';
  frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('tabindex', '-1');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('scrolling', 'no');
  frame.src = pageUrl(tile.dataset.pagePath, Number(tile.dataset.pageMtime) || 0);
  frame.addEventListener('load', () => tile.classList.add('page-ready'), { once: true });
  tile.append(frame);
  frames.set(tile, frame);
  if (resizer) resizer.observe(tile);
  updateScale(tile);
}

function unmount(tile) {
  const frame = frames.get(tile);
  if (!frame) return;
  frames.delete(tile);
  if (resizer) resizer.unobserve(tile);
  tile.classList.remove('page-ready');
  frame.remove();
}

function sync() {
  for (const tile of [...frames.keys()]) {
    if (frames.size <= MAX_FRAMES) break;
    if (!wanted.has(tile)) unmount(tile);
  }
  for (const tile of wanted) {
    if (frames.has(tile) || !tile.isConnected) continue;
    if (frames.size >= MAX_FRAMES) {
      const idle = [...frames.keys()].find((el) => !wanted.has(el));
      if (idle === undefined) break;
      unmount(idle);
    }
    mount(tile);
  }
}

export function observePageTiles() {
  const scroll = document.getElementById('files-scroll');
  const targets = [...document.querySelectorAll('.page-tile[data-page-path]')];

  wanted.clear();
  for (const tile of [...frames.keys()]) {
    if (!tile.isConnected) unmount(tile);
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (!targets.length) return;

  if (!resizer && 'ResizeObserver' in window) {
    resizer = new ResizeObserver((entries) => {
      for (const entry of entries) updateScale(entry.target);
    });
  }

  if (!('IntersectionObserver' in window)) {
    targets.forEach(mount);
    return;
  }

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) wanted.add(entry.target);
        else wanted.delete(entry.target);
      }
      sync();
    },
    { root: scroll || null, rootMargin: '80px 0px' }
  );
  targets.forEach((target) => observer.observe(target));
}
