import { api, gifUrl, mediaUrl } from './api.js';
import { state, activeTab, app, scheduleSave } from './state.js';
import { icon, kindIcon } from './icons.js';
import { shortcutLabel } from './keyboard.js';
import { fontTileHtml, observeFontTiles } from './fonts.js';
import { soundfontTileHtml, observeSoundfontTiles } from './sf2.js';
import { pageTileHtml, observePageTiles } from './pages.js';
import { detailCellHtml, observeDetails } from './details.js';
import { cachedWave, fallbackPeaks, loadWave, drawWaveform } from './waveform.js';
import { packMosaic, mosaicHtml } from './mosaic.js';
import { visibleChips } from './chipfit.js';
import { spanRect, rectsIntersect, marqueeSelection } from './marquee.js';
import {
  esc,
  basename,
  humanSize,
  humanCount,
  fmtDate,
  fmtFullDate,
  fmtRelative,
  naturalCompare,
  compactCount,
  fuzzy,
  highlightName,
  kindLabel,
  kindColor,
  clamp,
  debounce,
  sumSizes,
} from './util.js';

const LARGE_FILE = 64 * 1024 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1500;
const CARD_MIN = 120;
const CARD_MAX = 260;
const CARD_STEP = 8;
const WHEEL_ZOOM_THRESHOLD = 40;
const DRIFT_SPEED = 85;
const PAN_DEAD_ZONE = 10;
const PAN_GAIN = 2.4;
const PAN_MAX_SPEED = 1500;

const THUMB_KINDS = new Set(['image', 'video', 'audio', 'exe', 'shortcut']);
const THUMB_MODELS = new Set(['stl', 'obj', 'ply', '3mf']);
const NO_DOC_THUMB = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rtf']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'tbz']);

const FILTERS = [
  { id: 'all', label: 'All', icon: 'layers' },
  { id: 'folders', label: 'Folders', icon: 'folder' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'videos', label: 'Videos', icon: 'video' },
  { id: 'audio', label: 'Audio', icon: 'music' },
  { id: 'docs', label: 'Docs', icon: 'fileText' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'archives', label: 'Archives', icon: 'archive' },
  { id: 'models', label: 'Models', icon: 'cube' },
  { id: 'recent', label: 'Recent', icon: 'sparkles', smart: true },
  { id: 'large', label: 'Large', icon: 'funnel', smart: true },
];

const matchMap = new Map();
let filterCache = null;
const thumbCache = new Map();
const thumbQueue = [];
const MAX_CACHE = 4000;
const MAX_REQUESTS = 4;
let thumbActive = 0;
let observer = null;
let hoverVideoThumb = null;

const countCache = new Map();
const countQueue = [];
const MAX_COUNT_CACHE = 4000;
const MAX_COUNT_REQUESTS = 3;
let countActive = 0;
let countObserver = null;

const sizeCache = new Map();
const sizeQueue = [];
const MAX_SIZE_CACHE = 4000;
const MAX_SIZE_REQUESTS = 2;
let sizeActive = 0;
let sizeObserver = null;

const archiveCache = new Map();
const archiveQueue = [];
const MAX_ARCHIVE_CACHE = 4000;
const MAX_ARCHIVE_REQUESTS = 2;
let archiveActive = 0;
let archiveObserver = null;

const MOSAIC_THUMB_SIZE = 256;
const MOSAIC_GRID_TILES = 8;
const MAX_MOSAIC_CACHE = 400;
const MAX_MOSAIC_REQUESTS = 2;

const mosaicCache = new Map();
const mosaicQueue = [];
let mosaicActive = 0;
let mosaicObserver = null;

const isoCache = new Map();
const isoQueue = [];
const MAX_ISO_CACHE = 500;
const MAX_ISO_REQUESTS = 2;
let isoActive = 0;
let isoObserver = null;

let waveObserver = null;
let waveResizeBound = false;

const scrollEl = () => document.getElementById('files-scroll');
const paneStateEl = () => document.getElementById('pane-state');

export function isGifEntry(entry) {
  return Boolean(entry && !entry.isDir && entry.kind === 'image' && (entry.ext || '').toLowerCase() === 'gif');
}

export function wantsThumb(entry) {
  if (!entry || entry.isDir) return false;
  if (THUMB_KINDS.has(entry.kind)) return true;
  if (entry.kind === 'model') return THUMB_MODELS.has((entry.ext || '').toLowerCase());
  if (entry.kind === 'doc') return !NO_DOC_THUMB.has((entry.ext || '').toLowerCase());
  return false;
}

function thumbRequestSize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return Math.min(512, Math.max(192, Math.ceil((state.thumbSize * dpr) / 64) * 64));
}

function rgba(color, alpha) {
  const value = String(color || '#94a3b8');
  if (/^rgba?\(/.test(value.trim())) {
    const [r, g, b] = value.replace(/^rgba?\(|\)$/g, '').split(',').map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hex = value.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16) || 148;
  const g = parseInt(full.slice(2, 4), 16) || 163;
  const b = parseInt(full.slice(4, 6), 16) || 184;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function matchesFilter(entry, filter) {
  switch (filter) {
    case 'folders':
      return entry.isDir;
    case 'images':
      return entry.kind === 'image';
    case 'videos':
      return entry.kind === 'video';
    case 'audio':
      return entry.kind === 'audio';
    case 'docs':
      return entry.kind === 'doc';
    case 'code':
      return entry.kind === 'code';
    case 'archives':
      return entry.kind === 'archive';
    case 'models':
      return entry.kind === 'model';
    case 'recent':
      return entry.modified > Date.now() - RECENT_MS;
    case 'large':
      return !entry.isDir && entry.size >= LARGE_FILE;
    case 'all':
    default:
      return true;
  }
}

function touchedDate(entry) {
  return Math.max(entry.modified || 0, entry.created || 0);
}

function compareEntries(a, b, sort) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let result = 0;
  if (sort.key === 'size') {
    result = a.size - b.size;
  } else if (sort.key === 'modified') {
    result = touchedDate(a) - touchedDate(b);
  } else if (sort.key === 'kind') {
    result = naturalCompare(kindLabel(a.kind), kindLabel(b.kind));
  }
  if (!result) result = naturalCompare(a.name, b.name);
  return result * (sort.dir < 0 ? -1 : 1);
}

function setMatchRange(path, range) {
  if (range) matchMap.set(path, Array.from({ length: range[1] - range[0] }, (_, index) => range[0] + index));
}

export function recomputeVisible() {
  const tab = activeTab();
  matchMap.clear();
  state.filtering = false;
  if (state.searchResults === null) state.searchError = null;
  if (!tab) {
    filterCache = null;
    state.visibleEntries = [];
    return;
  }
  const query = (tab.query || '').trim();
  const patterns = state.searchWildcards || state.searchRegex;
  const isSearch = state.searchResults !== null;
  const base = isSearch ? state.searchResults : state.listing?.entries || [];
  let items = base.filter((entry) => matchesFilter(entry, tab.filter));

  if (!query || !patterns || isSearch) filterCache = null;
  if (query && patterns && !isSearch && state.listing) {
    const listing = state.listing;
    const path = tab.path;
    const token = state.loadToken;
    const wildcards = state.searchWildcards;
    const regex = state.searchRegex;
    const key = JSON.stringify([tab.id, path, token, query, wildcards, regex]);
    if (filterCache?.listing !== listing || filterCache?.key !== key) {
      const request = { listing, key, matches: null, error: null, promise: null };
      filterCache = request;
      const isCurrent = () => filterCache === request && state.listing === listing && state.loadToken === token
        && activeTab() === tab && tab.path === path && tab.query.trim() === query && state.searchResults === null
        && state.searchWildcards === wildcards && state.searchRegex === regex;
      request.promise = api.filterNames(base.map((entry) => entry.name), query, wildcards, regex)
        .then((matches) => {
          request.matches = new Map(matches.map((match) => [base[match.index].path, match.range]));
        })
        .catch((error) => {
          request.matches = new Map();
          request.error = String(error);
        })
        .then(() => {
          if (!isCurrent()) return;
          recomputeVisible();
          renderFiles();
          renderFilters();
        });
    }
    state.filtering = filterCache.matches === null;
    state.searchError = filterCache.error;
    if (state.filtering) {
      state.visibleEntries = [];
      return filterCache.promise;
    }
    items = items.filter((entry) => {
      if (!filterCache.matches.has(entry.path)) return false;
      setMatchRange(entry.path, filterCache.matches.get(entry.path));
      return true;
    });
  } else if (query && patterns && isSearch) {
    items.forEach((entry) => setMatchRange(entry.path, entry.matchRange));
  } else if (query) {
    items = items.filter((entry) => {
      const match = fuzzy(entry.name, query);
      if (match) matchMap.set(entry.path, match.indices);
      return Boolean(match);
    });
  }

  state.visibleEntries = items.slice().sort((a, b) => compareEntries(a, b, tab.sort));
  state.focusIndex = clamp(state.focusIndex, 0, Math.max(0, state.visibleEntries.length - 1));
}

export function currentItems() {
  return state.visibleEntries;
}

export function selectedEntries() {
  if (!state.selection.size) return [];
  return state.visibleEntries.filter((entry) => state.selection.has(entry.path));
}

export function focusedEntry() {
  return state.visibleEntries[state.focusIndex] || null;
}

export function selectPath(path) {
  if (!path) return;
  const index = state.visibleEntries.findIndex((entry) => entry.path === path);
  if (index < 0) return;
  state.selection = new Set([path]);
  state.focusIndex = index;
  state.anchorIndex = index;
  updateSelectionUI();
  scrollIndexIntoView(index);
}

export function selectAll() {
  state.selection = new Set(state.visibleEntries.map((entry) => entry.path));
  updateSelectionUI();
}

export function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  updateSelectionUI();
}

export function setFilter(filter) {
  const tab = activeTab();
  if (!tab) return;
  tab.filter = FILTERS.some((item) => item.id === filter) ? filter : 'all';
  recomputeVisible();
  renderFilters();
  renderFiles();
  scheduleSave();
}

export function setQuery(query) {
  const tab = activeTab();
  if (!tab) return;
  tab.query = query;
  recomputeVisible();
  renderFiles();
  renderFilters();
}

export function beginSearch() {
  state.searchError = null;
  state.searching = true;
  state.searchResults = [];
  recomputeVisible();
  renderFilters();
  renderFiles();
}

export function finishSearch(results, error = null) {
  state.searchError = error;
  state.searching = false;
  state.searchResults = Array.isArray(results) ? results : [];
  recomputeVisible();
  renderFiles();
  renderFilters();
}

export function clearSearchState() {
  state.searching = false;
  state.searchResults = null;
  recomputeVisible();
  renderFilters();
  renderFiles();
}

function nameHtml(entry) {
  return highlightName(entry.name, matchMap.get(entry.path));
}

function badgeHtml(entry) {
  if (entry.isDir) {
    return entry.isSymlink
      ? `<span class="thumb-badge">${icon('cornerUpLeft', 9)} LINK</span>`
      : '';
  }
  const ext = (entry.ext || '').toUpperCase();
  if (entry.kind === 'video') {
    return `<span class="thumb-badge">${icon('play', 9)} ${esc(ext || 'VIDEO')}</span>`;
  }
  if (entry.kind === 'audio') {
    return `<span class="thumb-badge">${icon('music', 9)} ${esc(ext || 'AUDIO')}</span>`;
  }
  if (entry.kind === 'model' && THUMB_MODELS.has((entry.ext || '').toLowerCase())) {
    return `<span class="thumb-badge">${icon('cube', 9)} ${esc(ext)}</span>`;
  }
  if (entry.kind === 'soundfont') {
    return `<span class="thumb-badge">${icon('piano', 9)} ${esc(ext || 'SF2')}</span>`;
  }
  if (entry.kind === 'image' && entry.ext === 'gif') {
    return '<span class="thumb-badge">GIF</span>';
  }
  if (entry.kind === 'doc' && entry.ext === 'pdf') {
    return `<span class="thumb-badge">${icon('fileText', 9)} PDF</span>`;
  }
  return '';
}

function folderTileHtml(entry) {
  const color = kindColor(entry.kind);
  return `
        <div class="folder-tile" data-count-path="${esc(entry.path)}" data-count-mtime="${entry.modified || 0}" data-size-path="${esc(entry.path)}" data-size-mtime="${entry.modified || 0}" data-media-path="${esc(entry.path)}" data-media-mtime="${entry.modified || 0}" style="--kind-color:${color};--kind-glow:${rgba(color, 0.12)}">
          <div class="folder-fill" aria-hidden="true"></div>
          <div class="folder-mosaic" hidden></div>
          <svg class="folder-frame" viewBox="2.8 4.8 18.4 15.4" preserveAspectRatio="none" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="frame-shadow" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path class="frame-line" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <div class="folder-counts" hidden>
            <span class="count-row">
              <span class="folder-count" data-role="folders">${icon('folder', 14)}<span class="count-value">0</span></span>
              <span class="folder-count" data-role="files">${icon('fileText', 14)}<span class="count-value">0</span></span>
            </span>
            <span class="folder-size" data-role="size" hidden></span>
            <span class="folder-hints" data-role="hints" hidden>
              <span class="folder-hint" data-role="audio" title="Contains audio" style="color:${kindColor('audio')}">${kindIcon('audio', 13)}</span>
              <span class="folder-hint" data-role="video" title="Contains video" style="color:${kindColor('video')}">${kindIcon('video', 13)}</span>
              <span class="folder-hint" data-role="model" title="Contains 3D models" style="color:${kindColor('model')}">${kindIcon('model', 13)}</span>
            </span>
          </div>
        </div>`;
}

export function archiveSupported(entry) {
  return Boolean(
    entry && !entry.isDir && entry.kind === 'archive' && ARCHIVE_EXTS.has((entry.ext || '').toLowerCase())
  );
}

export function archiveFormat(entry) {
  const name = (entry.name || '').toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'TAR.GZ';
  if (name.endsWith('.tar.bz2') || name.endsWith('.tbz2') || name.endsWith('.tbz')) return 'TAR.BZ2';
  return (entry.ext || 'archive').toUpperCase();
}

function archiveTileHtml(entry) {
  if (!archiveSupported(entry)) return '';
  const color = kindColor('archive');
  return `
        <div class="archive-tile" data-archive-path="${esc(entry.path)}" data-archive-mtime="${entry.modified || 0}" style="--kind-color:${color};--kind-glow:${rgba(color, 0.14)}">
          <div class="archive-head">${icon('archive', 11)}<span>${esc(archiveFormat(entry))}</span></div>
          <div class="archive-rows" hidden></div>
          <div class="archive-foot" hidden>
            <span class="archive-kind"></span>
            <span class="archive-nums">
              <span class="archive-count">${icon('fileText', 9)}<b data-role="files"></b></span>
              <span class="archive-count">${icon('folder', 9)}<b data-role="folders"></b></span>
            </span>
          </div>
          <div class="archive-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>
          <div class="archive-note" hidden></div>
        </div>`;
}

function cardHtml(entry, index) {
  const color = kindColor(entry.kind);
  const thumb = wantsThumb(entry);
  const classes = ['file-card'];
  if (state.selection.has(entry.path)) classes.push('selected');
  if (state.focusIndex === index) classes.push('focused');
  const meta = entry.isDir ? fmtRelative(entry.modified) : humanSize(entry.size);
  const thumbClass = entry.isDir ? 'card-thumb folder-thumb' : 'card-thumb';
  const gif = isGifEntry(entry);
  const hoverVideo = !entry.isDir && entry.kind === 'video';
  const thumbBody = entry.isDir
    ? folderTileHtml(entry)
    : `${isoTileHtml(entry) || archiveTileHtml(entry) || fontTileHtml(entry) || soundfontTileHtml(entry) || pageTileHtml(entry) || `<div class="kind-tile" style="--kind-color:${color};--kind-glow:${rgba(color, 0.12)}">${kindIcon(entry.kind, 34)}</div>`}
        ${thumb ? '<img alt="" decoding="async" draggable="false">' : ''}`;
  return `
    <article class="${classes.join(' ')}" data-path="${esc(entry.path)}" data-index="${index}" title="${esc(entry.path)}">
      <div class="${thumbClass}"${thumb ? ` data-thumb-path="${esc(entry.path)}" data-thumb-mtime="${entry.modified || 0}"` : ''}${gif ? ` data-gif-path="${esc(entry.path)}" data-gif-mtime="${entry.modified || 0}"` : ''}${hoverVideo ? ` data-video-path="${esc(entry.path)}"` : ''}>
        ${thumbBody}
        ${badgeHtml(entry)}
        ${entry.kind === 'shortcut' ? `<span class="shortcut-mark" title="Shortcut">${icon('link', 11)}</span>` : ''}
      </div>
      <div class="card-name">${nameHtml(entry)}</div>
      <div class="card-meta">
        <span class="kind-label" style="--kind-color:${color}">${esc(kindLabel(entry.kind))}</span>
        <span class="dot">·</span>
        <span>${meta}</span>
      </div>
    </article>`;
}

function rowWaveHtml(entry) {
  if (entry.kind !== 'audio' || entry.isDir) return '';
  return `<canvas class="row-wave" aria-hidden="true" data-wave-path="${esc(entry.path)}" data-wave-mtime="${entry.modified || 0}" data-wave-size="${entry.size || 0}" data-wave-ext="${esc(entry.ext || '')}"></canvas>`;
}

function rowHtml(entry, index) {
  const color = kindColor(entry.kind);
  const classes = ['file-row'];
  if (state.selection.has(entry.path)) classes.push('selected');
  if (state.focusIndex === index) classes.push('focused');
  const wave = rowWaveHtml(entry);
  const nameBlock = wave
    ? `<span class="row-name-wrap">${wave}<span class="row-name">${nameHtml(entry)}</span></span>`
    : `<span class="row-name">${nameHtml(entry)}</span>`;
  return `
    <div class="${classes.join(' ')}" data-path="${esc(entry.path)}" data-index="${index}" title="${esc(entry.path)}">
      <div class="cell-name">
        <span class="row-icon" style="--kind-color:${color}">${kindIcon(entry.kind, 16)}</span>
        ${nameBlock}
        ${entry.isSymlink ? '<span class="symlink-badge">link</span>' : ''}
      </div>
      <div class="cell-size"${entry.isDir ? ` data-size-path="${esc(entry.path)}" data-size-mtime="${entry.modified || 0}"` : ''}>${entry.isDir ? '—' : esc(humanSize(entry.size))}</div>
      <div class="cell-date" title="Latest of modified or created">${esc(fmtFullDate(touchedDate(entry)))}</div>
      <div class="cell-kind">${esc(kindLabel(entry.kind, entry.ext))}</div>
      ${detailCellHtml(entry)}
    </div>`;
}

function resultHtml(entry, index) {
  const color = kindColor(entry.kind);
  const classes = ['result-row'];
  if (state.selection.has(entry.path)) classes.push('selected');
  const parent = entry.parent || '';
  return `
    <div class="${classes.join(' ')}" data-path="${esc(entry.path)}" data-index="${index}" title="${esc(entry.path)}">
      <div class="result-name">
        <span class="row-icon" style="--kind-color:${color}">${kindIcon(entry.kind, 16)}</span>
        <span class="row-name">${nameHtml(entry)}</span>
      </div>
      <div class="result-path">${esc(parent)}</div>
      <div class="result-size">${entry.isDir ? '—' : esc(humanSize(entry.size))}</div>
      <div class="result-date">${esc(fmtDate(entry.modified))}</div>
    </div>`;
}

function sortArrow(tab, key) {
  if (tab.sort.key !== key) return '';
  return icon(tab.sort.dir < 0 ? 'chevronDown' : 'chevronUp', 10);
}

function headHtml(tab) {
  const cls = (key) => `head-cell ${key}${tab.sort.key === key ? ' active' : ''}`;
  return `
    <button class="${cls('name')}" type="button" data-sort="name">Name ${sortArrow(tab, 'name')}</button>
    <button class="${cls('size')}" type="button" data-sort="size">Size ${sortArrow(tab, 'size')}</button>
    <button class="${cls('modified')}" type="button" data-sort="modified" title="Latest of modified or created">Date ${sortArrow(tab, 'modified')}</button>
    <button class="${cls('kind')}" type="button" data-sort="kind">Kind ${sortArrow(tab, 'kind')}</button>
    <div class="head-cell detail">Details</div>`;
}

function searchBanner(tab) {
  const count = state.visibleEntries.length;
  const scope = state.searchRecursive ? 'including subfolders' : 'in this folder';
  const label = state.searching
    ? `<span>${icon('loader', 12, 'spin')} Searching ${scope}…</span>`
    : state.searchError ? '<span>Search could not complete</span>'
    : `<span>Found <strong>${humanCount(count)}</strong> ${count === 1 ? 'item' : 'items'} for <strong>${esc(tab.query)}</strong> ${scope}</span>`;
  return `
    <div class="results-banner">
      ${icon('search', 14)}
      ${label}
      <span class="spacer"></span>
      <button class="mini-btn" type="button" data-action="reset-filters">${icon('x', 12)} Clear</button>
    </div>`;
}

export function renderFilters() {
  const root = document.getElementById('chips');
  if (!root) return;
  const tab = activeTab();
  if (!tab) {
    root.innerHTML = '';
    return;
  }
  const base = state.searchResults !== null ? state.searchResults : state.listing?.entries || [];
  const counts = new Map();
  for (const entry of base) {
    for (const filter of FILTERS) {
      if (filter.id === 'all') continue;
      if (matchesFilter(entry, filter.id)) counts.set(filter.id, (counts.get(filter.id) || 0) + 1);
    }
  }
  root.innerHTML = visibleChips(FILTERS, counts, tab.filter)
    .map((filter) => {
      const active = tab.filter === filter.id;
      const count = filter.id === 'all' ? base.length : counts.get(filter.id) || 0;
      const showCount = count > 0 || filter.id === 'all';
      const pinned = filter.id === 'all' || filter.smart || active;
      return `
      <button class="chip${active ? ' active' : ''}${filter.smart ? ' smart' : ''}" type="button" data-filter="${filter.id}"${pinned ? ' data-pinned="true"' : ''} title="${esc(filter.label)}">
        ${icon(filter.icon, 12)}
        <span class="chip-label">${esc(filter.label)}</span>
        ${showCount ? `<span class="count">${humanCount(count)}</span>` : ''}
      </button>`;
    })
    .join('');
  layoutChips(root);
}

function layoutChips(root) {
  const chipsRoot = root || document.getElementById('chips');
  if (!chipsRoot) return;
  const buttons = [...chipsRoot.querySelectorAll('.chip')];
  chipsRoot.classList.remove('compact');
  for (const button of buttons) button.hidden = false;
  if (!chipsRoot.clientWidth) return;

  const fits = () => chipsRoot.scrollWidth <= chipsRoot.clientWidth + 1;
  if (fits()) return;
  chipsRoot.classList.add('compact');
  if (fits()) return;
  for (let i = buttons.length - 1; i >= 0 && !fits(); i -= 1) {
    const button = buttons[i];
    if (button.dataset.pinned === 'true') continue;
    button.hidden = true;
  }
}

export function renderPaneState({ iconName = 'info', title = '', text = '', actions = [], skeleton = false }) {
  const el = paneStateEl();
  if (!el) return;
  el.hidden = false;
  if (skeleton) {
    el.innerHTML = `<div class="skeleton-grid">${Array.from({ length: 10 }, () => '<div class="skeleton-card"></div>').join('')}</div>`;
    return;
  }
  const actionHtml = actions
    .map(
      (action) =>
        `<button class="btn btn-${action.kind || 'ghost'}" type="button" data-action="${esc(action.action)}">${action.icon ? icon(action.icon, 13) : ''}${esc(action.label)}</button>`
    )
    .join('');
  el.innerHTML = `
    <div class="state-card">
      <div class="state-icon">${icon(iconName, 28)}</div>
      <div class="state-title">${esc(title)}</div>
      ${text ? `<div class="state-text">${esc(text)}</div>` : ''}
      ${actionHtml ? `<div class="state-actions">${actionHtml}</div>` : ''}
    </div>`;
}

export function hidePaneState() {
  const el = paneStateEl();
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function emptyState(tab) {
  const isSearch = state.searchResults !== null;
  const filtering = Boolean((tab.query || '').trim()) || tab.filter !== 'all';
  if (state.searchError) {
    renderPaneState({
      iconName: 'alert',
      title: 'Cannot match this search',
      text: state.searchError,
      actions: [{ label: 'Clear search', action: 'reset-filters', kind: 'primary', icon: 'x' }],
    });
    return;
  }
  if (state.filtering) {
    renderPaneState({ iconName: 'loader', title: 'Filtering filenames…' });
    return;
  }
  if (isSearch && state.searching) {
    hidePaneState();
    return;
  }
  if (isSearch) {
    renderPaneState({
      iconName: 'search',
      title: 'No matching files',
      text: tab.query ? `Nothing matched “${tab.query}” in ${state.searchRecursive ? 'this folder or its subfolders' : 'this folder'}.` : 'Try a different search.',
      actions: [{ label: 'Clear search', action: 'reset-filters', kind: 'primary', icon: 'x' }],
    });
    return;
  }
  if (filtering) {
    renderPaneState({
      iconName: 'funnel',
      title: 'Nothing in this view',
      text: 'No items match the active filters. Clear them to see everything in this folder.',
      actions: [{ label: 'Clear filters', action: 'reset-filters', kind: 'primary', icon: 'x' }],
    });
    return;
  }
  const actions = [{ label: 'New folder', action: 'new-folder', kind: 'primary', icon: 'folderPlus' }];
  if (!tab.showHidden) actions.push({ label: 'Show hidden', action: 'show-hidden', icon: 'eye' });
  renderPaneState({
    iconName: 'folderOpen',
    title: 'This folder is empty',
    text: 'Drop files here from Explorer, or create a folder to get started.',
    actions,
  });
}

export function renderFiles() {
  stopDrift();
  stopPanning();
  cancelMarquee();
  const scroll = scrollEl();
  const tab = activeTab();
  if (!scroll || !tab) return;

  stopCardVideo(hoverVideoThumb);
  scroll.style.setProperty('--card-size', `${state.thumbSize}px`);
  const head = document.getElementById('files-head');
  const isSearch = state.searchResults !== null;
  const items = state.visibleEntries;
  const listMode = tab.view === 'list' && !isSearch;

  if (head) {
    head.hidden = !listMode;
    if (listMode) head.innerHTML = headHtml(tab);
  }

  const limit = Math.min(items.length, state.renderLimit);
  const remaining = items.length - limit;
  let html = '';

  if (isSearch) html += searchBanner(tab);

  if (listMode) {
    html += `<div class="files-list">${items.slice(0, limit).map((entry, index) => rowHtml(entry, index)).join('')}</div>`;
  } else if (isSearch) {
    html += items.slice(0, limit).map((entry, index) => resultHtml(entry, index)).join('');
  } else {
    html += `<div class="files-grid">${items.slice(0, limit).map((entry, index) => cardHtml(entry, index)).join('')}</div>`;
  }

  if (remaining > 0) {
    html += `<div class="load-more-row"><button class="mini-btn" type="button" data-action="load-more">Show ${humanCount(Math.min(PAGE_SIZE, remaining))} more</button></div>`;
  }

  scroll.innerHTML = html;
  document.getElementById('search-input')?.setAttribute('aria-invalid', state.searchError ? 'true' : 'false');

  if (state.loading || state.error) {
    // Loading and error overlays are managed by refreshFiles.
  } else if (!items.length) {
    emptyState(tab);
  } else {
    hidePaneState();
  }

  observeThumbs();
  observeCounts();
  observeFolderMedia();
  observeArchives();
  observeIso();
  observeFontTiles();
  observeSoundfontTiles();
  observePageTiles();
  observeSizes();
  observeDetails();
  observeRowWaves();
  paintSelection();
  updateStatus();
  app.onSelectionChange?.();
}

function paintRowWave(canvas) {
  const path = canvas.dataset.wavePath;
  if (!path || !canvas.isConnected) return;
  const entry = {
    path,
    name: basename(path),
    modified: Number(canvas.dataset.waveMtime) || 0,
  };
  const size = Number(canvas.dataset.waveSize) || 0;
  const known = cachedWave(entry, size);
  drawWaveform(canvas, known ? known.peaks : fallbackPeaks(entry.name), { subtle: true });
  if (known) return;
  loadWave(entry, size, canvas.dataset.waveExt)
    .then((data) => {
      if (!canvas.isConnected || canvas.dataset.wavePath !== path) return;
      drawWaveform(canvas, data.peaks, { subtle: true });
    })
    .catch(() => {});
}

function redrawRowWaves() {
  const scroll = scrollEl();
  if (!scroll) return;
  for (const canvas of scroll.querySelectorAll('.row-wave')) {
    if (!canvas.getBoundingClientRect().width) continue;
    paintRowWave(canvas);
  }
}

function observeRowWaves() {
  if (!waveResizeBound) {
    waveResizeBound = true;
    window.addEventListener('resize', debounce(redrawRowWaves, 160));
  }
  if (waveObserver) waveObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.row-wave');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(paintRowWave);
    return;
  }
  waveObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        waveObserver.unobserve(entry.target);
        paintRowWave(entry.target);
      }
    },
    { root: scroll, rootMargin: '160px 0px' }
  );
  targets.forEach((target) => waveObserver.observe(target));
}

function paintSelection() {
  const scroll = scrollEl();
  if (!scroll) return;
  const focused = state.visibleEntries[state.focusIndex]?.path;
  for (const el of scroll.querySelectorAll('[data-path]')) {
    el.classList.toggle('selected', state.selection.has(el.dataset.path));
    el.classList.toggle('focused', Boolean(focused) && el.dataset.path === focused);
  }
}

export function updateSelectionUI() {
  paintSelection();
  updateStatus();
  app.onSelectionChange?.();
}

export function updateStatus() {
  const countEl = document.getElementById('status-count');
  const selectionEl = document.getElementById('status-selection');
  const hintEl = document.getElementById('status-hint');
  const sizeEl = document.getElementById('status-size');
  const tab = activeTab();
  if (!tab) return;

  const items = state.visibleEntries;
  const selected = selectedEntries();
  const files = items.filter((entry) => !entry.isDir);
  const total = sumSizes(files);

  if (countEl) {
    const suffix = state.searchResults !== null ? ' found' : '';
    countEl.textContent = `${humanCount(items.length)} ${items.length === 1 ? 'item' : 'items'}${suffix}${state.listing?.truncated ? ' · truncated' : ''}`;
  }
  if (selectionEl) {
    selectionEl.textContent = selected.length
      ? `${humanCount(selected.length)} selected · ${humanSize(sumSizes(selected))}`
      : '';
  }
  if (hintEl) {
    hintEl.textContent =
      tab.view === 'viz'
        ? 'Click a tile for details · double-click to drill in'
        : [['palette', 'commands'], ['search', 'search'], ['rename', 'rename'], ['trash', 'to trash']]
          .filter(([id]) => shortcutLabel(id)).map(([id, label]) => `${shortcutLabel(id)} ${label}`).join(' · ');
  }
  if (sizeEl) {
    sizeEl.textContent = items.length ? `${humanCount(files.length)} files · ${humanSize(total)}` : '';
  }
}

function attachThumb(img, url) {
  if (!img) return;
  img.dataset.stillSrc = url;
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    if (img.dataset.gifActive === '1' && img.dataset.stillSrc) {
      delete img.dataset.gifActive;
      img.src = img.dataset.stillSrc;
      return;
    }
    img.remove();
  };
  if (img.dataset.gifActive !== '1') img.src = url;
}

function showLockedThumb(el) {
  if (!el || el.dataset.pdfLocked === '1') return;
  el.dataset.pdfLocked = '1';
  el.querySelector('img')?.remove();
  const lock = document.createElement('div');
  lock.className = 'lock-overlay';
  lock.innerHTML = `${icon('lock', 26)}<span>Password protected</span>`;
  el.append(lock);
  el.title = 'Password-protected PDF';
}

function playCardGif(thumb) {
  if (!thumb || thumb.dataset.gifPlaying === '1') return;
  const img = thumb.querySelector('img');
  if (!img) return;
  thumb.dataset.gifPlaying = '1';
  img.dataset.gifActive = '1';
  img.src = gifUrl(thumb.dataset.gifPath, Number(thumb.dataset.gifMtime) || 0);
}

function stopCardGif(thumb) {
  if (!thumb || thumb.dataset.gifPlaying !== '1') return;
  delete thumb.dataset.gifPlaying;
  const img = thumb.querySelector('img');
  if (!img) return;
  delete img.dataset.gifActive;
  if (img.dataset.stillSrc) img.src = img.dataset.stillSrc;
}

function onCardGifOver(event) {
  const thumb = event.target.closest?.('.card-thumb[data-gif-path]');
  if (!thumb || thumb.contains(event.relatedTarget)) return;
  playCardGif(thumb);
}

function onCardGifOut(event) {
  const thumb = event.target.closest?.('.card-thumb[data-gif-path]');
  if (!thumb || thumb.contains(event.relatedTarget)) return;
  stopCardGif(thumb);
}

function playCardVideo(thumb) {
  if (!thumb || thumb.dataset.videoPlaying === '1') return;
  thumb.dataset.videoPlaying = '1';
  const video = document.createElement('video');
  video.className = 'thumb-video';
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.disablePictureInPicture = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.addEventListener('playing', () => {
    if (thumb.dataset.videoPlaying === '1') video.classList.add('playing');
  });
  video.addEventListener('error', () => stopCardVideo(thumb));
  video.src = mediaUrl(thumb.dataset.videoPath);
  thumb.append(video);
  hoverVideoThumb = thumb;
  const started = video.play();
  if (started && started.catch) started.catch(() => {});
}

function stopCardVideo(thumb) {
  if (!thumb) return;
  delete thumb.dataset.videoPlaying;
  if (hoverVideoThumb === thumb) hoverVideoThumb = null;
  const video = thumb.querySelector?.('video.thumb-video');
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.remove();
}

function onCardVideoOver(event) {
  const thumb = event.target.closest?.('.card-thumb[data-video-path]');
  if (!thumb || thumb.contains(event.relatedTarget)) return;
  if (hoverVideoThumb && hoverVideoThumb !== thumb) stopCardVideo(hoverVideoThumb);
  playCardVideo(thumb);
}

function onCardVideoOut(event) {
  const thumb = event.target.closest?.('.card-thumb[data-video-path]');
  if (!thumb || thumb.contains(event.relatedTarget)) return;
  stopCardVideo(thumb);
}

function pumpThumbs() {
  while (thumbActive < MAX_REQUESTS && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive += 1;
    api
      .thumbnail(job.path, job.size)
      .then((info) => {
        const result = { url: info && info.url ? info.url : null, locked: Boolean(info && info.locked) };
        thumbCache.set(job.key, result);
        if (thumbCache.size > MAX_CACHE) {
          const oldest = thumbCache.keys().next().value;
          if (oldest !== undefined) thumbCache.delete(oldest);
        }
        if (result.url) attachThumb(job.img, result.url);
        else if (result.locked) showLockedThumb(job.img?.parentElement);
      })
      .catch(() => {
        thumbCache.set(job.key, null);
      })
      .finally(() => {
        thumbActive -= 1;
        pumpThumbs();
      });
  }
}

function loadThumb(el) {
  if (!el || el.dataset.thumbLoaded === '1') return;
  el.dataset.thumbLoaded = '1';
  const img = el.querySelector('img');
  if (!img) return;
  const path = el.dataset.thumbPath;
  const mtime = Number(el.dataset.thumbMtime) || 0;
  const size = thumbRequestSize();
  const key = `${path.toLowerCase()}|${mtime}|${size}`;
  if (thumbCache.has(key)) {
    const result = thumbCache.get(key);
    if (result?.url) attachThumb(img, result.url);
    else if (result?.locked) showLockedThumb(el);
    return;
  }
  thumbQueue.push({ key, path, size, img });
  pumpThumbs();
}

function observeThumbs() {
  if (observer) observer.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.card-thumb[data-thumb-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadThumb);
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadThumb(entry.target);
      }
    },
    { root: scroll, rootMargin: '320px 0px' }
  );
  targets.forEach((target) => observer.observe(target));
}

function countsKey(path, mtime, showHidden) {
  return `${path.toLowerCase()}|${mtime}|${showHidden ? 1 : 0}`;
}

function applyCounts(el, counts) {
  if (!el || !counts) return;
  const row = el.querySelector('.folder-counts');
  if (!row) return;
  const set = (role, value) => {
    const valueEl = row.querySelector(`[data-role="${role}"] .count-value`);
    if (valueEl) valueEl.textContent = compactCount(value);
  };
  set('folders', counts.folders);
  set('files', counts.files);
  row.title = `${humanCount(counts.folders)} folders · ${humanCount(counts.files)} files`;
  row.hidden = false;

  const hints = row.querySelector('.folder-hints');
  if (hints) {
    let any = false;
    for (const [role, present] of [
      ['audio', counts.hasAudio],
      ['video', counts.hasVideo],
      ['model', counts.hasModel],
    ]) {
      const hint = hints.querySelector(`[data-role="${role}"]`);
      if (!hint) continue;
      hint.hidden = !present;
      if (present) any = true;
    }
    hints.hidden = !any;
  }
}

function pumpCounts() {
  while (countActive < MAX_COUNT_REQUESTS && countQueue.length) {
    const job = countQueue.shift();
    countActive += 1;
    api
      .folderCounts(job.path, job.showHidden)
      .then((counts) => {
        countCache.set(job.key, counts);
        if (countCache.size > MAX_COUNT_CACHE) {
          const oldest = countCache.keys().next().value;
          if (oldest !== undefined) countCache.delete(oldest);
        }
        if (job.el.isConnected) applyCounts(job.el, counts);
      })
      .catch(() => {
        countCache.set(job.key, null);
      })
      .finally(() => {
        countActive -= 1;
        pumpCounts();
      });
  }
}

function loadCounts(el) {
  if (!el || el.dataset.countLoaded === '1') return;
  el.dataset.countLoaded = '1';
  const path = el.dataset.countPath;
  if (!path) return;
  const mtime = Number(el.dataset.countMtime) || 0;
  const showHidden = Boolean(activeTab()?.showHidden);
  const key = countsKey(path, mtime, showHidden);
  if (countCache.has(key)) {
    const counts = countCache.get(key);
    if (counts) applyCounts(el, counts);
    return;
  }
  countQueue.push({ key, path, showHidden, el });
  pumpCounts();
}

function observeCounts() {
  if (countObserver) countObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.folder-tile[data-count-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadCounts);
    return;
  }
  countObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        countObserver.unobserve(entry.target);
        loadCounts(entry.target);
      }
    },
    { root: scroll, rootMargin: '240px 0px' }
  );
  targets.forEach((target) => countObserver.observe(target));
}

function archiveKey(path, mtime) {
  return `${path.toLowerCase()}|${mtime}`;
}

export function archiveSummaryFor(entry) {
  const key = archiveKey(entry.path, entry.modified || 0);
  let pending = archiveCache.get(key);
  if (!pending) {
    pending = api.archiveSummary(entry.path).catch(() => null);
    archiveCache.set(key, pending);
    if (archiveCache.size > MAX_ARCHIVE_CACHE) {
      const oldest = archiveCache.keys().next().value;
      if (oldest !== undefined) archiveCache.delete(oldest);
    }
  }
  return pending;
}

function isoSupported(entry) {
  return Boolean(entry && !entry.isDir && (entry.ext || '').toLowerCase() === 'iso');
}

function isoKey(path, mtime) {
  return `${path}|${mtime}`;
}

function isoInfoFor(path, mtime) {
  const key = isoKey(path, mtime);
  let pending = isoCache.get(key);
  if (!pending) {
    pending = api.isoInfo(path).catch(() => null);
    isoCache.set(key, pending);
    if (isoCache.size > MAX_ISO_CACHE) {
      const oldest = isoCache.keys().next().value;
      if (oldest !== undefined) isoCache.delete(oldest);
    }
  }
  return pending;
}

function isoTileHtml(entry) {
  if (!isoSupported(entry)) return '';
  const color = kindColor('archive');
  return `
        <div class="iso-tile" data-iso-path="${esc(entry.path)}" data-iso-mtime="${entry.modified || 0}" style="--kind-color:${color};--kind-glow:${rgba(color, 0.14)}">
          <div class="iso-head">${icon('disc', 11)}<span>ISO</span></div>
          <div class="iso-disc">${icon('disc', 34)}</div>
          <div class="iso-label" hidden></div>
        </div>`;
}

function applyIso(el, info) {
  if (!el) return;
  const disc = el.querySelector('.iso-disc');
  const label = el.querySelector('.iso-label');
  if (info && info.iconUrl && disc) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('load', () => disc.replaceChildren(img), { once: true });
    img.src = info.iconUrl;
  }
  const text = info && info.label ? String(info.label).trim() : '';
  if (text && label) {
    label.textContent = text;
    label.title = text;
    label.hidden = false;
  }
  if (text || (info && info.iconFrom)) {
    el.title = [text, info && info.iconFrom ? `Icon: ${info.iconFrom}` : ''].filter(Boolean).join(' · ');
  }
}

function pumpIso() {
  while (isoActive < MAX_ISO_REQUESTS && isoQueue.length) {
    const job = isoQueue.shift();
    if (!job.el.isConnected) continue;
    isoActive += 1;
    isoInfoFor(job.path, job.mtime)
      .then((info) => {
        if (job.el.isConnected) applyIso(job.el, info);
      })
      .finally(() => {
        isoActive -= 1;
        pumpIso();
      });
  }
}

function loadIso(el) {
  if (!el || el.dataset.isoLoaded === '1') return;
  el.dataset.isoLoaded = '1';
  const path = el.dataset.isoPath;
  if (!path) return;
  isoQueue.push({ path, mtime: Number(el.dataset.isoMtime) || 0, el });
  pumpIso();
}

function observeIso() {
  if (isoObserver) isoObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.iso-tile[data-iso-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadIso);
    return;
  }
  isoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        isoObserver.unobserve(entry.target);
        loadIso(entry.target);
      }
    },
    { root: scroll, rootMargin: '240px 0px' }
  );
  targets.forEach((target) => isoObserver.observe(target));
}

function archiveRowHtml(name) {
  const clean = name.replace(/\/+$/, '');
  const base = clean.slice(clean.lastIndexOf('/') + 1) || clean;
  return `<div class="archive-row">${icon(name.endsWith('/') ? 'folder' : 'fileText', 9)}<span>${esc(base)}</span></div>`;
}

function applyArchive(el, summary) {
  if (!el) return;
  el.querySelector('.archive-skeleton')?.remove();
  if (!summary) {
    el.classList.add('archive-unknown');
    const note = el.querySelector('.archive-note');
    if (note) {
      note.textContent = 'Contents unavailable';
      note.hidden = false;
    }
    el.title = 'Archive index could not be read';
    return;
  }
  if (summary.locked) {
    el.querySelector('.archive-rows')?.remove();
    el.querySelector('.archive-foot')?.remove();
    const lock = document.createElement('div');
    lock.className = 'lock-overlay archive-lock';
    lock.innerHTML = `${icon('lock', 26)}<span>Password protected</span>`;
    el.append(lock);
    el.title = `${summary.format} · password-protected archive`;
    return;
  }
  const rows = el.querySelector('.archive-rows');
  if (rows) {
    rows.innerHTML = summary.top.slice(0, 4).map(archiveRowHtml).join('');
    rows.hidden = !summary.top.length;
  }
  const kind = el.querySelector('.archive-kind');
  if (kind) kind.textContent = summary.kind;
  const files = el.querySelector('[data-role="files"]');
  const folders = el.querySelector('[data-role="folders"]');
  if (files) files.textContent = compactCount(summary.files) + (summary.truncated ? '+' : '');
  if (folders) folders.textContent = compactCount(summary.folders) + (summary.truncated ? '+' : '');
  const foot = el.querySelector('.archive-foot');
  if (foot) foot.hidden = false;
  el.title = `${summary.format} · ${summary.kind} · ${humanCount(summary.files)} ${summary.files === 1 ? 'file' : 'files'} · ${humanCount(summary.folders)} ${summary.folders === 1 ? 'folder' : 'folders'}${summary.truncated ? ' · partial scan' : ''}`;
}

function pumpArchives() {
  while (archiveActive < MAX_ARCHIVE_REQUESTS && archiveQueue.length) {
    const job = archiveQueue.shift();
    archiveActive += 1;
    archiveSummaryFor(job.entry)
      .then((summary) => {
        if (job.el.isConnected) applyArchive(job.el, summary);
      })
      .finally(() => {
        archiveActive -= 1;
        pumpArchives();
      });
  }
}

function loadArchive(el) {
  if (!el || el.dataset.archiveLoaded === '1') return;
  el.dataset.archiveLoaded = '1';
  const path = el.dataset.archivePath;
  if (!path) return;
  archiveQueue.push({ entry: { path, modified: Number(el.dataset.archiveMtime) || 0 }, el });
  pumpArchives();
}

function observeArchives() {
  if (archiveObserver) archiveObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.archive-tile[data-archive-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadArchive);
    return;
  }
  archiveObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        archiveObserver.unobserve(entry.target);
        loadArchive(entry.target);
      }
    },
    { root: scroll, rootMargin: '240px 0px' }
  );
  targets.forEach((target) => archiveObserver.observe(target));
}

function applySize(el, info) {
  if (!el || !info) return;
  const label = `${humanSize(info.bytes)}${info.truncated ? '+' : ''}`;
  const title = info.truncated ? 'Partial size of a very large folder' : '';
  const chip = el.querySelector('.folder-size');
  if (chip) {
    const row = el.querySelector('.folder-counts');
    if (row) row.hidden = false;
    chip.textContent = label;
    chip.title = title;
    chip.hidden = false;
    return;
  }
  el.textContent = label;
  if (title) el.title = title;
}

function pumpSizes() {
  while (sizeActive < MAX_SIZE_REQUESTS && sizeQueue.length) {
    const job = sizeQueue.shift();
    sizeActive += 1;
    api
      .folderSize(job.path, job.showHidden)
      .then((info) => {
        sizeCache.set(job.key, info);
        if (sizeCache.size > MAX_SIZE_CACHE) {
          const oldest = sizeCache.keys().next().value;
          if (oldest !== undefined) sizeCache.delete(oldest);
        }
        if (job.el.isConnected) applySize(job.el, info);
      })
      .catch(() => {
        sizeCache.set(job.key, null);
      })
      .finally(() => {
        sizeActive -= 1;
        pumpSizes();
      });
  }
}

function loadSize(el) {
  if (!el || el.dataset.sizeLoaded === '1') return;
  el.dataset.sizeLoaded = '1';
  const path = el.dataset.sizePath;
  if (!path) return;
  const mtime = Number(el.dataset.sizeMtime) || 0;
  const showHidden = Boolean(activeTab()?.showHidden);
  const key = countsKey(path, mtime, showHidden);
  if (sizeCache.has(key)) {
    const info = sizeCache.get(key);
    if (info) applySize(el, info);
    return;
  }
  sizeQueue.push({ key, path, showHidden, el });
  pumpSizes();
}

function observeSizes() {
  if (sizeObserver) sizeObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.folder-tile[data-size-path], .cell-size[data-size-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadSize);
    return;
  }
  sizeObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sizeObserver.unobserve(entry.target);
        loadSize(entry.target);
      }
    },
    { root: scroll, rootMargin: '240px 0px' }
  );
  targets.forEach((target) => sizeObserver.observe(target));
}

function mosaicInfo(entry, limit) {
  const showHidden = Boolean(activeTab()?.showHidden);
  const sort = state.folderMediaSort;
  const key = `${entry.path.toLowerCase()}|${entry.modified || 0}|${showHidden ? 1 : 0}|${sort}|${limit}`;
  let pending = mosaicCache.get(key);
  if (!pending) {
    pending = enqueueMosaic(() =>
      api
        .folderMedia(entry.path, showHidden, sort, limit)
        .then(async (info) => {
          if (!info || !Array.isArray(info.items) || !info.items.length) return null;
          const thumbs = [];
          for (let index = 0; index < info.items.length; index += 3) {
            const batch = info.items.slice(index, index + 3);
            const loaded = await Promise.all(
              batch.map((item) => api.thumbnail(item.path, MOSAIC_THUMB_SIZE).catch(() => null))
            );
            batch.forEach((item, position) => {
              const thumb = loaded[position];
              if (!thumb || !thumb.url || !thumb.width || !thumb.height) return;
              thumbs.push({ ...item, url: thumb.url, width: thumb.width, height: thumb.height });
            });
          }
          return thumbs.length ? { files: info.files, media: info.media, items: thumbs } : null;
        })
        .catch(() => null)
    );
    mosaicCache.set(key, pending);
    if (mosaicCache.size > MAX_MOSAIC_CACHE) {
      const oldest = mosaicCache.keys().next().value;
      if (oldest !== undefined) mosaicCache.delete(oldest);
    }
  }
  return pending;
}

function enqueueMosaic(job) {
  return new Promise((resolve) => {
    mosaicQueue.push({ job, resolve });
    pumpMosaics();
  });
}

function pumpMosaics() {
  while (mosaicActive < MAX_MOSAIC_REQUESTS && mosaicQueue.length) {
    const { job, resolve } = mosaicQueue.shift();
    mosaicActive += 1;
    job()
      .then(resolve, () => resolve(null))
      .finally(() => {
        mosaicActive -= 1;
        pumpMosaics();
      });
  }
}

export function folderMosaicFor(entry, limit = MOSAIC_GRID_TILES) {
  if (!entry?.isDir) return Promise.resolve(null);
  return mosaicInfo(entry, limit);
}

function applyMosaic(el, data) {
  const holder = el.querySelector('.folder-mosaic');
  if (!holder || !el.isConnected) return;
  holder.hidden = false;
  const width = holder.clientWidth;
  const height = holder.clientHeight;
  if (!width || !height) {
    holder.hidden = true;
    return;
  }
  const tiles = packMosaic(data.items, width, height, { maxTiles: MOSAIC_GRID_TILES, gap: 2 });
  if (!tiles.length) return;
  holder.innerHTML = mosaicHtml(tiles, width, height);
  el.classList.add('has-mosaic');
  el.title = `${humanCount(data.media)} of ${humanCount(data.files)} files are images or videos`;
}

function loadMosaic(el) {
  if (!el || el.dataset.mosaicLoaded === '1') return;
  el.dataset.mosaicLoaded = '1';
  const path = el.dataset.mediaPath;
  if (!path) return;
  mosaicInfo({ path, modified: Number(el.dataset.mediaMtime) || 0 }, MOSAIC_GRID_TILES).then((data) => {
    if (data) applyMosaic(el, data);
  });
}

function observeFolderMedia() {
  if (mosaicObserver) mosaicObserver.disconnect();
  const scroll = scrollEl();
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.folder-tile[data-media-path]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(loadMosaic);
    return;
  }
  mosaicObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        mosaicObserver.unobserve(entry.target);
        loadMosaic(entry.target);
      }
    },
    { root: scroll, rootMargin: '200px 0px' }
  );
  targets.forEach((target) => mosaicObserver.observe(target));
}

function scrollIndexIntoView(index) {
  const scroll = scrollEl();
  if (!scroll) return;
  const el = scroll.querySelector(`[data-index="${index}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

export function moveFocusByDirection(direction, extend = false) {
  const items = state.visibleEntries;
  if (!items.length) return;
  let delta = 0;
  if (direction === 'up') delta = -1;
  else if (direction === 'down') delta = 1;
  else if (direction === 'left') delta = -1;
  else if (direction === 'right') delta = 1;
  else if (direction === 'home') delta = -state.focusIndex;
  else if (direction === 'end') delta = items.length - 1 - state.focusIndex;
  else if (direction === 'pagedown') delta = 3;
  else if (direction === 'pageup') delta = -3;

  const next = clamp(state.focusIndex + delta, 0, items.length - 1);
  state.focusIndex = next;
  const target = items[next];

  if (extend) {
    const anchor = state.anchorIndex ?? next;
    const [a, b] = anchor <= next ? [anchor, next] : [next, anchor];
    state.selection = new Set(items.slice(a, b + 1).map((entry) => entry.path));
  } else {
    state.selection = new Set([target.path]);
    state.anchorIndex = next;
  }

  updateSelectionUI();
  scrollIndexIntoView(next);
}

function handleAction(action, el) {
  switch (action) {
    case 'clear-search':
    case 'reset-filters':
      app.resetFilters?.();
      break;
    case 'load-more':
      state.renderLimit += PAGE_SIZE;
      renderFiles();
      break;
    case 'retry':
      app.refresh?.();
      break;
    case 'show-hidden':
      app.toggleHidden?.();
      break;
    case 'new-folder':
      app.newFolder?.();
      break;
    case 'go-home':
      app.navigate?.(state.app?.home || '/');
      break;
    case 'open-settings':
      app.openSettings?.();
      break;
    default:
      break;
  }
  if (el) el.blur();
}

function clickedIndex(el) {
  const index = Number(el.dataset.index);
  return Number.isFinite(index) ? index : -1;
}

const DRAG_THRESHOLD = 6;
const MARQUEE_THRESHOLD = 5;
let dragCandidate = null;
let dragBusy = false;
let marqueeDrag = null;
let suppressEmptyClick = false;

function entryForElement(el) {
  const path = el?.dataset?.path;
  if (!path) return null;
  return state.visibleEntries.find((entry) => entry.path === path) || null;
}

function dragChannel() {
  const core = globalThis.__TAURI__?.core;
  if (core?.Channel) return new core.Channel();
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals?.transformCallback) return null;
  const id = internals.transformCallback(() => {}, false);
  return {
    __TAURI_CHANNEL_MARKER__: true,
    id,
    toJSON: () => `__CHANNEL__:${id}`,
  };
}

async function dragPreview(entry) {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const color = kindColor(entry.kind);
  ctx.fillStyle = 'rgba(13, 18, 25, 0.95)';
  ctx.beginPath();
  ctx.roundRect(4, 4, size - 8, size - 8, 18);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  const svg = kindIcon(entry.kind, 48).replaceAll('currentColor', color);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await image.decode();
    ctx.drawImage(image, 24, 24, 48, 48);
  } catch {
    // The plain plate still works if the glyph cannot be rasterised.
  }
  return canvas.toDataURL('image/png');
}

async function beginDrag(el) {
  const entry = entryForElement(el);
  if (!entry) return;
  if (!state.selection.has(entry.path)) {
    state.selection = new Set([entry.path]);
    state.focusIndex = state.visibleEntries.indexOf(entry);
    state.anchorIndex = state.focusIndex;
    updateSelectionUI();
  }
  const invoke = globalThis.__TAURI__?.core?.invoke;
  const onEvent = dragChannel();
  if (!invoke || !onEvent || dragBusy) return;
  dragBusy = true;
  try {
    const image = await dragPreview(entry);
    if (!image) return;
    await invoke('plugin:drag|start_drag', {
      item: selectedEntries().map((item) => item.path),
      image,
      options: { mode: 'copy' },
      onEvent,
    });
  } catch (error) {
    console.warn('File drag failed:', error);
  } finally {
    dragBusy = false;
  }
}

function samePaths(a, b) {
  if (a.size !== b.size) return false;
  for (const path of a) if (!b.has(path)) return false;
  return true;
}

function cancelMarquee() {
  if (!marqueeDrag) return;
  marqueeDrag.box?.remove();
  marqueeDrag = null;
}

function endMarquee() {
  if (!marqueeDrag) return;
  if (marqueeDrag.active) suppressEmptyClick = true;
  cancelMarquee();
}

function marqueeBounds(x, y) {
  const scroll = scrollEl();
  if (!scroll) return null;
  const bounds = scroll.getBoundingClientRect();
  const rect = spanRect(marqueeDrag.x0, marqueeDrag.y0, x, y);
  let left = Math.max(rect.left, bounds.left);
  let right = Math.min(rect.left + rect.width, bounds.right);
  if (activeTab()?.view === 'list') {
    const row = scroll.querySelector('.file-row');
    if (row) {
      const rowRect = row.getBoundingClientRect();
      left = Math.min(left, Math.max(rowRect.left, bounds.left));
      right = Math.max(right, Math.min(rowRect.right, bounds.right));
    }
  }
  const top = Math.max(rect.top, bounds.top);
  const bottom = Math.min(rect.top + rect.height, bounds.bottom);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function updateMarquee(x, y) {
  const scroll = scrollEl();
  if (!scroll || !marqueeDrag) return;
  const rect = marqueeBounds(x, y);
  if (!rect) return;
  if (!marqueeDrag.box) {
    marqueeDrag.box = document.createElement('div');
    marqueeDrag.box.className = 'marquee-box';
    document.body.appendChild(marqueeDrag.box);
  }
  marqueeDrag.box.style.left = `${rect.left}px`;
  marqueeDrag.box.style.top = `${rect.top}px`;
  marqueeDrag.box.style.width = `${rect.width}px`;
  marqueeDrag.box.style.height = `${rect.height}px`;

  const hits = [];
  let firstIndex = -1;
  let lastIndex = -1;
  for (const el of scroll.querySelectorAll('[data-path]')) {
    const index = clickedIndex(el);
    const entry = state.visibleEntries[index];
    if (!entry) continue;
    if (!rectsIntersect(rect, el.getBoundingClientRect())) continue;
    hits.push(entry.path);
    if (firstIndex < 0 || index < firstIndex) firstIndex = index;
    if (index > lastIndex) lastIndex = index;
  }
  const selection = marqueeSelection(hits, marqueeDrag.base, marqueeDrag.additive);
  if (!samePaths(selection, state.selection)) {
    state.selection = selection;
    if (firstIndex >= 0) {
      state.anchorIndex = firstIndex;
      state.focusIndex = lastIndex;
    }
    updateSelectionUI();
  }
}

function onPointerDown(event) {
  if (event.button !== 0 || !event.isPrimary || dragBusy) return;
  const scroll = scrollEl();
  if (!scroll || !scroll.contains(event.target)) return;
  const el = event.target.closest('[data-path]');
  if (el) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    dragCandidate = { el, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    return;
  }
  const tab = activeTab();
  if (!tab || (tab.view !== 'grid' && tab.view !== 'list')) return;
  if (state.searchResults !== null) return;
  if (event.target.closest('button, a, input, textarea, select')) return;
  event.preventDefault();
  marqueeDrag = {
    pointerId: event.pointerId,
    x0: event.clientX,
    y0: event.clientY,
    additive: event.ctrlKey || event.metaKey || event.shiftKey,
    base: new Set(state.selection),
    active: false,
    box: null,
  };
}

function onPointerMove(event) {
  if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
    if ((event.buttons & 1) === 0) {
      endMarquee();
      return;
    }
    const dx = event.clientX - marqueeDrag.x0;
    const dy = event.clientY - marqueeDrag.y0;
    if (!marqueeDrag.active) {
      if (dx * dx + dy * dy < MARQUEE_THRESHOLD * MARQUEE_THRESHOLD) return;
      marqueeDrag.active = true;
    }
    updateMarquee(event.clientX, event.clientY);
    return;
  }
  if (!dragCandidate || event.pointerId !== dragCandidate.pointerId) return;
  if ((event.buttons & 1) === 0) {
    dragCandidate = null;
    return;
  }
  const dx = event.clientX - dragCandidate.x;
  const dy = event.clientY - dragCandidate.y;
  if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
  const target = dragCandidate.el;
  dragCandidate = null;
  beginDrag(target);
}

function onPointerUp(event) {
  if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
    endMarquee();
    return;
  }
  if (dragCandidate && event.pointerId === dragCandidate.pointerId) dragCandidate = null;
}

function onClick(event) {
  if (suppressEmptyClick) {
    suppressEmptyClick = false;
    return;
  }
  const scroll = scrollEl();
  if (!scroll) return;
  const actionEl = event.target.closest('[data-action]');
  if (actionEl && (scroll.contains(actionEl) || paneStateEl()?.contains(actionEl))) {
    handleAction(actionEl.dataset.action, actionEl);
    return;
  }

  const el = event.target.closest('[data-path]');
  if (!el || !scroll.contains(el)) {
    if (!event.target.closest('.results-banner')) clearSelection();
    return;
  }
  const index = clickedIndex(el);
  if (index < 0) return;
  const additive = event.ctrlKey || event.metaKey;
  const range = event.shiftKey;

  if (range) {
    const anchor = state.anchorIndex ?? index;
    const [a, b] = anchor <= index ? [anchor, index] : [index, anchor];
    state.selection = new Set(state.visibleEntries.slice(a, b + 1).map((entry) => entry.path));
  } else if (additive) {
    if (state.selection.has(el.dataset.path)) state.selection.delete(el.dataset.path);
    else state.selection.add(el.dataset.path);
    state.anchorIndex = index;
  } else {
    state.selection = new Set([el.dataset.path]);
    state.anchorIndex = index;
  }
  state.focusIndex = index;
  updateSelectionUI();
}

function onDoubleClick(event) {
  const el = event.target.closest('[data-path]');
  if (!el) return;
  const entry = state.visibleEntries[clickedIndex(el)];
  if (entry) app.openEntry?.(entry);
}

function onContextMenu(event) {
  event.preventDefault();
  const el = event.target.closest('[data-path]');
  if (!el) {
    app.backgroundMenu?.(event.clientX, event.clientY);
    return;
  }
  const index = clickedIndex(el);
  const entry = state.visibleEntries[index];
  if (!entry) return;
  if (!state.selection.has(entry.path)) {
    state.selection = new Set([entry.path]);
    state.focusIndex = index;
    state.anchorIndex = index;
    updateSelectionUI();
  } else {
    state.focusIndex = index;
    paintSelection();
  }
  app.entryMenu?.(entry, event.clientX, event.clientY);
}

function onHeadClick(event) {
  const button = event.target.closest('[data-sort]');
  if (!button) return;
  const tab = activeTab();
  if (!tab) return;
  const key = button.dataset.sort;
  if (tab.sort.key === key) {
    tab.sort.dir = tab.sort.dir < 0 ? 1 : -1;
  } else {
    tab.sort = { key, dir: key === 'size' || key === 'modified' ? -1 : 1 };
  }
  recomputeVisible();
  renderFiles();
  scheduleSave();
  button.blur();
}

function onChipsClick(event) {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  setFilter(button.dataset.filter);
  button.blur();
}

let wheelZoomDelta = 0;
let driftDirection = 0;
let driftFrame = 0;
let driftLast = 0;
let panState = null;

function setThumbSize(next) {
  const value = clamp(Math.round(next / CARD_STEP) * CARD_STEP, CARD_MIN, CARD_MAX);
  if (value === state.thumbSize) return;
  state.thumbSize = value;
  scrollEl()?.style.setProperty('--card-size', `${value}px`);
  const range = document.getElementById('settings-thumb-size');
  const label = document.getElementById('settings-thumb-value');
  if (range) range.value = String(value);
  if (label) label.textContent = `${value} px`;
  scheduleSave();
}

function stepDrift(now) {
  const scroll = scrollEl();
  if (!scroll || !driftDirection) {
    driftFrame = 0;
    return;
  }
  if (driftLast) {
    const dt = Math.min(64, now - driftLast) / 1000;
    const max = scroll.scrollHeight - scroll.clientHeight;
    scroll.scrollTop = clamp(scroll.scrollTop + driftDirection * DRIFT_SPEED * dt, 0, max);
    if ((driftDirection > 0 && scroll.scrollTop >= max) || (driftDirection < 0 && scroll.scrollTop <= 0)) {
      stopDrift();
      return;
    }
  }
  driftLast = now;
  driftFrame = requestAnimationFrame(stepDrift);
}

function startDrift(direction) {
  driftDirection = direction;
  if (driftFrame) return;
  driftLast = 0;
  driftFrame = requestAnimationFrame(stepDrift);
}

function stopDrift() {
  driftDirection = 0;
  if (driftFrame) cancelAnimationFrame(driftFrame);
  driftFrame = 0;
  driftLast = 0;
}

function stepPan(now) {
  const pan = panState;
  if (!pan) return;
  const scroll = scrollEl();
  if (!scroll) {
    stopPanning();
    return;
  }
  if (pan.last && pan.speed) {
    const dt = Math.min(64, now - pan.last) / 1000;
    const max = scroll.scrollHeight - scroll.clientHeight;
    scroll.scrollTop = clamp(scroll.scrollTop + pan.speed * dt, 0, max);
  }
  pan.last = now;
  pan.frame = requestAnimationFrame(stepPan);
}

function startPanning(x, y) {
  stopDrift();
  stopPanning();
  const anchor = document.createElement('div');
  anchor.className = 'pan-anchor';
  anchor.innerHTML = icon('autoscroll', 22);
  anchor.style.left = `${x}px`;
  anchor.style.top = `${y}px`;
  document.body.append(anchor);
  document.body.classList.add('panning');
  panState = { anchor, y, speed: 0, frame: 0, last: 0 };
  panState.frame = requestAnimationFrame(stepPan);
}

function stopPanning() {
  if (!panState) return;
  cancelAnimationFrame(panState.frame);
  panState.anchor.remove();
  document.body.classList.remove('panning');
  panState = null;
}

function onCtrlWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  const tab = activeTab();
  if (!tab) return;
  if (tab.view === 'grid' && state.searchResults === null) {
    event.preventDefault();
    wheelZoomDelta += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
    if (Math.abs(wheelZoomDelta) < WHEEL_ZOOM_THRESHOLD) return;
    const direction = wheelZoomDelta < 0 ? 1 : -1;
    wheelZoomDelta = 0;
    setThumbSize(state.thumbSize + direction * CARD_STEP);
    return;
  }
  if (tab.view === 'list') {
    if (!event.deltaY) return;
    event.preventDefault();
    stopPanning();
    startDrift(event.deltaY < 0 ? -1 : 1);
  }
}

function onPanMouseDown(event) {
  if (panState) {
    if (event.button === 0 || event.button === 1) stopPanning();
    return;
  }
  if (event.button !== 1 || (!event.ctrlKey && !event.metaKey)) return;
  const tab = activeTab();
  const scroll = scrollEl();
  if (!tab || tab.view !== 'list' || !scroll || !scroll.contains(event.target)) return;
  event.preventDefault();
  startPanning(event.clientX, event.clientY);
}

function onPanMouseMove(event) {
  if (!panState) return;
  const offset = event.clientY - panState.y;
  const magnitude = Math.abs(offset);
  panState.speed =
    magnitude <= PAN_DEAD_ZONE
      ? 0
      : (offset < 0 ? -1 : 1) * Math.min(PAN_MAX_SPEED, (magnitude - PAN_DEAD_ZONE) * PAN_GAIN);
}

export function initFiles() {
  const scroll = scrollEl();
  const head = document.getElementById('files-head');
  const chips = document.getElementById('chips');
  const pane = paneStateEl();
  scroll?.addEventListener('click', onClick);
  scroll?.addEventListener('dblclick', onDoubleClick);
  scroll?.addEventListener('contextmenu', onContextMenu);
  scroll?.addEventListener('wheel', onCtrlWheel, { passive: false });
  scroll?.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('mousedown', onPanMouseDown, true);
  window.addEventListener('mousemove', onPanMouseMove);
  window.addEventListener('keyup', (event) => {
    if (event.key === 'Control' || event.key === 'Meta') stopDrift();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      stopDrift();
      stopPanning();
      cancelMarquee();
    }
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  scroll?.addEventListener('dragstart', (event) => {
    if (event.target.closest('[data-path]')) event.preventDefault();
  });
  scroll?.addEventListener('mouseover', onCardGifOver);
  scroll?.addEventListener('mouseout', onCardGifOut);
  scroll?.addEventListener('mouseover', onCardVideoOver);
  scroll?.addEventListener('mouseout', onCardVideoOut);
  window.addEventListener('blur', () => {
    stopCardVideo(hoverVideoThumb);
    stopDrift();
    stopPanning();
    cancelMarquee();
  });
  head?.addEventListener('click', onHeadClick);
  chips?.addEventListener('click', onChipsClick);
  if (chips && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => layoutChips(chips)).observe(chips);
  }
  pane?.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) handleAction(actionEl.dataset.action, actionEl);
  });
}

export async function refreshFiles({ silent = false } = {}) {
  const tab = activeTab();
  if (!tab) return false;
  const token = ++state.loadToken;

  if (!silent) {
    state.loading = true;
    state.error = null;
    renderPaneState({ skeleton: true });
    renderFiles();
  }

  try {
    const listing = await api.listDir(tab.path, tab.showHidden);
    if (token !== state.loadToken) return false;

    state.loading = false;
    state.error = null;
    state.listing = listing;
    state.selection = new Set();
    state.anchorIndex = null;
    state.focusIndex = 0;
    if (!silent) state.renderLimit = PAGE_SIZE;

    let filtering = recomputeVisible();
    while (filtering) {
      renderFiles();
      await filtering;
      if (token !== state.loadToken) return false;
      filtering = recomputeVisible();
    }
    hidePaneState();
    renderFiles();
    renderFilters();
    app.onFilesLoaded?.();
    api.watchDirectory(listing.path).catch(() => {});
    return true;
  } catch (error) {
    if (token !== state.loadToken) return false;
    state.loading = false;
    state.error = String(error);
    state.listing = null;
    state.visibleEntries = [];
    state.selection = new Set();
    const scroll = scrollEl();
    if (scroll) scroll.innerHTML = '';
    renderFilters();
    renderPaneState({
      iconName: 'alert',
      title: "Can't open this folder",
      text: String(error),
      actions: [
        { label: 'Try again', action: 'retry', kind: 'primary', icon: 'refresh' },
        { label: 'Go home', action: 'go-home', icon: 'home' },
      ],
    });
    updateStatus();
    app.onFilesLoaded?.();
    return false;
  }
}
