import { api, gifUrl, mediaUrl } from './api.js';
import { state, activeTab, app, scheduleSave } from './state.js';
import { icon, kindIcon } from './icons.js';
import { fontTileHtml, observeFontTiles } from './fonts.js';
import { pageTileHtml, observePageTiles } from './pages.js';
import { detailCellHtml, observeDetails } from './details.js';
import {
  esc,
  humanSize,
  humanCount,
  fmtDate,
  fmtRelative,
  naturalCompare,
  compactCount,
  fuzzy,
  highlightName,
  kindLabel,
  kindColor,
  clamp,
  sumSizes,
} from './util.js';

const LARGE_FILE = 64 * 1024 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1500;

const THUMB_KINDS = new Set(['image', 'video', 'audio', 'exe', 'shortcut']);
const THUMB_MODELS = new Set(['stl', 'obj', 'ply', '3mf']);
const NO_DOC_THUMB = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rtf']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'tbz']);

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

function compareEntries(a, b, sort) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  let result = 0;
  if (sort.key === 'size') {
    result = a.size - b.size;
  } else if (sort.key === 'modified') {
    result = a.modified - b.modified;
  } else if (sort.key === 'kind') {
    result = naturalCompare(kindLabel(a.kind), kindLabel(b.kind));
  }
  if (!result) result = naturalCompare(a.name, b.name);
  return result * (sort.dir < 0 ? -1 : 1);
}

export function recomputeVisible() {
  const tab = activeTab();
  matchMap.clear();
  if (!tab) {
    state.visibleEntries = [];
    return;
  }
  const query = (tab.query || '').trim();

  if (state.searchResults !== null) {
    let items = state.searchResults.filter((entry) => matchesFilter(entry, tab.filter));
    if (query) {
      for (const entry of items) {
        const match = fuzzy(entry.name, query);
        if (match) matchMap.set(entry.path, match.indices);
      }
    }
    state.visibleEntries = items;
    return;
  }

  const base = state.listing?.entries || [];
  let items = base.filter((entry) => matchesFilter(entry, tab.filter));

  if (query) {
    const scored = [];
    for (const entry of items) {
      const match = fuzzy(entry.name, query);
      if (!match) continue;
      matchMap.set(entry.path, match.indices);
      scored.push({ entry, score: match.score });
    }
    scored.sort((a, b) => b.score - a.score || naturalCompare(a.entry.name, b.entry.name));
    items = scored.map((item) => item.entry);
  } else {
    items = items.slice().sort((a, b) => compareEntries(a, b, tab.sort));
  }

  state.visibleEntries = items;
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
  state.searching = true;
  state.searchResults = [];
  recomputeVisible();
  renderFilters();
  renderFiles();
}

export function finishSearch(results) {
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
        <div class="folder-tile" data-count-path="${esc(entry.path)}" data-count-mtime="${entry.modified || 0}" data-size-path="${esc(entry.path)}" data-size-mtime="${entry.modified || 0}" style="--kind-color:${color};--kind-glow:${rgba(color, 0.12)}">
          <svg class="folder-shape" viewBox="3 5 18 15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <div class="folder-counts" hidden>
            <span class="count-row">
              <span class="folder-count" data-role="folders">${icon('folder', 14)}<span class="count-value">0</span></span>
              <span class="folder-count" data-role="files">${icon('fileText', 14)}<span class="count-value">0</span></span>
            </span>
            <span class="folder-size" data-role="size" hidden></span>
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
    : `${archiveTileHtml(entry) || fontTileHtml(entry) || pageTileHtml(entry) || `<div class="kind-tile" style="--kind-color:${color};--kind-glow:${rgba(color, 0.12)}">${kindIcon(entry.kind, 34)}</div>`}
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

function rowHtml(entry, index) {
  const color = kindColor(entry.kind);
  const classes = ['file-row'];
  if (state.selection.has(entry.path)) classes.push('selected');
  if (state.focusIndex === index) classes.push('focused');
  return `
    <div class="${classes.join(' ')}" data-path="${esc(entry.path)}" data-index="${index}" title="${esc(entry.path)}">
      <div class="cell-name">
        <span class="row-icon" style="--kind-color:${color}">${kindIcon(entry.kind, 16)}</span>
        <span class="row-name">${nameHtml(entry)}</span>
        ${entry.isSymlink ? '<span class="symlink-badge">link</span>' : ''}
      </div>
      <div class="cell-size"${entry.isDir ? ` data-size-path="${esc(entry.path)}" data-size-mtime="${entry.modified || 0}"` : ''}>${entry.isDir ? '—' : esc(humanSize(entry.size))}</div>
      <div class="cell-date">${esc(fmtDate(entry.modified))}</div>
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
    <button class="${cls('modified')}" type="button" data-sort="modified">Modified ${sortArrow(tab, 'modified')}</button>
    <button class="${cls('kind')}" type="button" data-sort="kind">Kind ${sortArrow(tab, 'kind')}</button>
    <div class="head-cell detail">Details</div>`;
}

function searchBanner(tab) {
  const count = state.visibleEntries.length;
  const scope = state.searchRecursive ? 'including subfolders' : 'in this folder';
  const label = state.searching
    ? `<span>${icon('loader', 12, 'spin')} Searching ${scope}…</span>`
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
  root.innerHTML = FILTERS.map((filter) => {
    const active = tab.filter === filter.id;
    const count = filter.id === 'all' ? base.length : counts.get(filter.id) || 0;
    const showCount = count > 0 || filter.id === 'all';
    return `
      <button class="chip${active ? ' active' : ''}${filter.smart ? ' smart' : ''}" type="button" data-filter="${filter.id}" title="${esc(filter.label)}">
        ${filter.smart ? icon(filter.icon, 12) : ''}
        <span>${esc(filter.label)}</span>
        ${showCount ? `<span class="count">${humanCount(count)}</span>` : ''}
      </button>`;
  }).join('');
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

  if (state.loading || state.error) {
    // Loading and error overlays are managed by refreshFiles.
  } else if (!items.length) {
    emptyState(tab);
  } else {
    hidePaneState();
  }

  observeThumbs();
  observeCounts();
  observeArchives();
  observeFontTiles();
  observePageTiles();
  observeSizes();
  observeDetails();
  paintSelection();
  updateStatus();
  app.onSelectionChange?.();
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
        : 'Ctrl+K commands · / search · F2 rename · Del to trash';
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
        const url = info && info.url ? info.url : null;
        thumbCache.set(job.key, url);
        if (thumbCache.size > MAX_CACHE) {
          const oldest = thumbCache.keys().next().value;
          if (oldest !== undefined) thumbCache.delete(oldest);
        }
        if (url) attachThumb(job.img, url);
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
    const url = thumbCache.get(key);
    if (url) attachThumb(img, url);
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

function scrollIndexIntoView(index) {
  const scroll = scrollEl();
  if (!scroll) return;
  const el = scroll.querySelector(`[data-index="${index}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function gridColumns() {
  const scroll = scrollEl();
  const grid = scroll?.querySelector('.files-grid');
  if (!grid) return 1;
  const value = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, value.split(' ').filter(Boolean).length);
}

export function moveFocusByDirection(direction, extend = false) {
  const items = state.visibleEntries;
  if (!items.length) return;
  const tab = activeTab();
  const gridMode = tab?.view === 'grid' && state.searchResults === null;
  const step = gridMode && (direction === 'up' || direction === 'down') ? gridColumns() : 1;
  let delta = 0;
  if (direction === 'up') delta = -step;
  else if (direction === 'down') delta = step;
  else if (direction === 'left') delta = -1;
  else if (direction === 'right') delta = 1;
  else if (direction === 'home') delta = -state.focusIndex;
  else if (direction === 'end') delta = items.length - 1 - state.focusIndex;
  else if (direction === 'pagedown') delta = step * 3;
  else if (direction === 'pageup') delta = -step * 3;

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
let dragCandidate = null;
let dragBusy = false;

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

function onPointerDown(event) {
  if (event.button !== 0 || !event.isPrimary || dragBusy) return;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return;
  const el = event.target.closest('[data-path]');
  if (!el || !scrollEl()?.contains(el)) return;
  dragCandidate = { el, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
}

function onPointerMove(event) {
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
  if (dragCandidate && event.pointerId === dragCandidate.pointerId) dragCandidate = null;
}

function onClick(event) {
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

export function initFiles() {
  const scroll = scrollEl();
  const head = document.getElementById('files-head');
  const chips = document.getElementById('chips');
  const pane = paneStateEl();
  scroll?.addEventListener('click', onClick);
  scroll?.addEventListener('dblclick', onDoubleClick);
  scroll?.addEventListener('contextmenu', onContextMenu);
  scroll?.addEventListener('pointerdown', onPointerDown);
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
  window.addEventListener('blur', () => stopCardVideo(hoverVideoThumb));
  head?.addEventListener('click', onHeadClick);
  chips?.addEventListener('click', onChipsClick);
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

    recomputeVisible();
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
