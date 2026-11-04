import { fontUrl } from './api.js';
import { esc, kindColor } from './util.js';
import { kindIcon } from './icons.js';

const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const SPECIMEN = [
  'Aa', 'Bb', 'Cc', 'Dd', 'Ee', 'Ff', 'Gg', 'Hh', 'Ii', 'Jj', 'Kk', 'Ll', 'Mm',
  'Nn', 'Oo', 'Pp', 'Qq', 'Rr', 'Ss', 'Tt', 'Uu', 'Vv', 'Ww', 'Xx', 'Yy', 'Zz',
  '01234',
];

const MAX_ACTIVE = 2;
const MAX_CACHE = 800;

const familyCache = new Map();
const queue = [];
let active = 0;
let seq = 0;
let observer = null;

const specimenHtml = SPECIMEN.map((token) => `<span class="spec-token">${token}</span>`).join('');

export function isFontEntry(entry) {
  return !!entry && !entry.isDir && FONT_EXTS.has((entry.ext || '').toLowerCase());
}

export function fontTileHtml(entry, { large = false } = {}) {
  if (!isFontEntry(entry)) return '';
  const classes = large ? 'font-tile large' : 'font-tile';
  return `
    <div class="${classes}" style="--kind-color:${kindColor('font')}" data-font-path="${esc(entry.path)}" data-font-mtime="${entry.modified || 0}">
      <span class="font-fallback">${kindIcon('font', large ? 46 : 30)}</span>
      <span class="specimen">${specimenHtml}</span>
    </div>`;
}

function loadFamily(path, mtime) {
  const key = `${path.toLowerCase()}|${mtime}`;
  const cached = familyCache.get(key);
  if (cached) return cached;

  const family = `altfe-font-${(seq += 1)}`;
  const job = (async () => {
    const face = new FontFace(family, `url("${fontUrl(path, mtime)}")`, { display: 'block' });
    await face.load();
    document.fonts.add(face);
    return family;
  })();

  familyCache.set(key, job);
  if (familyCache.size > MAX_CACHE) {
    const oldest = familyCache.keys().next().value;
    if (oldest !== undefined) familyCache.delete(oldest);
  }
  job.catch(() => {
    if (familyCache.get(key) === job) familyCache.delete(key);
  });
  return job;
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const el = queue.shift();
    if (!el.isConnected) continue;
    active += 1;
    const path = el.dataset.fontPath;
    const mtime = Number(el.dataset.fontMtime) || 0;
    loadFamily(path, mtime)
      .then((family) => {
        if (!el.isConnected) return;
        el.style.setProperty('--specimen-font', `"${family}"`);
        el.classList.add('font-ready');
      })
      .catch(() => {
        if (el.isConnected) el.classList.add('font-failed');
      })
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function enqueue(el) {
  if (el.dataset.fontQueued === '1') return;
  el.dataset.fontQueued = '1';
  queue.push(el);
  pump();
}

export function observeFontTiles(root) {
  const scope = root || document;
  const targets = [...scope.querySelectorAll('.font-tile[data-font-path]')];
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(enqueue);
    return;
  }

  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        enqueue(entry.target);
      }
    },
    { rootMargin: '320px 0px' }
  );
  targets.forEach((target) => observer.observe(target));
}
