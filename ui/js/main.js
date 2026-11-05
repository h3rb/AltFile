import { api, listen } from './api.js';
import {
  state,
  app,
  activeTab,
  createTab,
  addRecent,
  loadSession,
  scheduleSave,
  saveSessionNow,
} from './state.js';
import { icon } from './icons.js';
import {
  esc,
  basename,
  dirname,
  joinPath,
  splitPath,
  isPathLike,
  debounce,
} from './util.js';
import { toast, showMenu, closeMenu, anyOverlayOpen } from './dialogs.js';
import * as files from './files.js';
import * as sidebar from './sidebar.js';
import * as preview from './preview.js';
import * as player from './player.js';
import * as viz from './viz.js';
import * as ops from './ops.js';
import * as palette from './palette.js';
import { openSettings } from './settings.js';
import { systemMenuItem } from './systemmenu.js';

const VIEW_BUTTONS = { grid: 'view-grid', list: 'view-list', viz: 'view-viz' };
const SORT_LABELS = { name: 'Name', size: 'Size', modified: 'Modified', kind: 'Kind' };

let pathEditing = false;
let fsTimer = 0;
let searchTimer = null;
let windowTitle = null;

function normalizePath(path) {
  if (!path) return '';
  return path.replace(/[\\/]+$/, (match) => (path.length <= 3 ? match : '')).toLowerCase();
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function setStaticIcons() {
  const map = {
    'nav-back': ['chevronLeft', 17],
    'nav-forward': ['chevronRight', 17],
    'nav-up': ['chevronUp', 17],
    refresh: ['refresh', 15],
    'path-edit': ['pencil', 13],
    'new-tab': ['plus', 15],
    'search-glyph': ['search', 14],
    'search-scope': ['layers', 13],
    'view-grid': ['grid', 14],
    'view-list': ['list', 14],
    'view-viz': ['chart', 15],
    'preview-toggle': ['panelRight', 15],
    'more-btn': ['more', 16],
  };
  for (const [id, [name, size]] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = icon(name, size);
  }
}

function tabLabel(path) {
  return basename(path) || path || 'Home';
}

function applyWindowTitle(path) {
  const title = path || 'Alt File Explorer';
  if (title === windowTitle) return;
  windowTitle = title;
  document.title = title;
  try {
    const winApi = globalThis.__TAURI__?.window;
    const current = winApi?.getCurrentWindow?.() || winApi?.getCurrent?.();
    Promise.resolve(current?.setTitle?.(title)).catch(() => {});
  } catch {
    /* document.title still updates without the native bridge */
  }
}

function renderTabs() {
  const root = document.getElementById('tabs');
  if (!root) return;
  root.innerHTML = state.tabs
    .map(
      (tab) => `
        <div class="tab${tab.id === state.activeId ? ' active' : ''}" data-tab-id="${esc(tab.id)}" role="tab" aria-selected="${tab.id === state.activeId}" title="${esc(tab.path)}">
          ${icon('folder', 13)}
          <span class="tab-name">${esc(tabLabel(tab.path))}</span>
          <button class="tab-close" type="button" data-close-tab="${esc(tab.id)}" aria-label="Close tab" title="Close tab (Ctrl+W)">${icon('x', 11)}</button>
        </div>`
    )
    .join('');

  applyWindowTitle(activeTab()?.path);
}

function renderPathbar() {
  const crumbs = document.getElementById('crumbs');
  const input = document.getElementById('path-input');
  const tab = activeTab();
  if (!crumbs || !tab) return;
  const sep = state.app?.sep || (navigator.userAgent.includes('Windows') ? '\\' : '/');
  const parts = splitPath(tab.path, sep);
  const list = parts.length ? parts : [{ label: tab.path, path: tab.path }];
  crumbs.innerHTML = list
    .map(
      (part, index) =>
        `<button class="crumb${index === list.length - 1 ? ' current' : ''}" type="button" data-path="${esc(part.path)}" title="${esc(part.path)}">${esc(part.label)}</button>${index < list.length - 1 ? `<span class="crumb-sep">${icon('chevronRight', 9)}</span>` : ''}`
    )
    .join('');
  if (input && input.hidden) input.value = tab.path;
}

function syncSearchUi() {
  const input = document.getElementById('search-input');
  const scope = document.getElementById('search-scope');
  const tab = activeTab();
  if (!input) return;
  const value = tab?.query || '';
  if (input.value !== value) input.value = value;
  const recursive = state.searchRecursive;
  input.placeholder = recursive ? 'Search subfolders' : 'Filter this folder';
  if (scope) {
    scope.classList.toggle('on', recursive);
    scope.title = recursive
      ? 'Searching this folder and its subfolders — click to search only this folder'
      : 'Searching this folder only — click to include subfolders';
    scope.setAttribute('aria-pressed', recursive ? 'true' : 'false');
  }
}

function updateToolbar() {
  const tab = activeTab();
  if (!tab) return;
  const back = document.getElementById('nav-back');
  const forward = document.getElementById('nav-forward');
  const up = document.getElementById('nav-up');
  const previewToggle = document.getElementById('preview-toggle');
  const sortBtn = document.getElementById('sort-btn');
  if (back) back.disabled = tab.index <= 0;
  if (forward) forward.disabled = tab.index >= tab.history.length - 1;
  const parent = state.listing?.parent || dirname(tab.path) || null;
  if (up) up.disabled = !parent;

  for (const [view, id] of Object.entries(VIEW_BUTTONS)) {
    const button = document.getElementById(id);
    if (button) {
      button.classList.toggle('active', tab.view === view);
      button.setAttribute('aria-pressed', tab.view === view ? 'true' : 'false');
    }
  }
  if (previewToggle) {
    const active = state.preview.open && tab.view !== 'viz';
    previewToggle.classList.toggle('active', active);
    previewToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    previewToggle.title = state.preview.open ? 'Hide preview (Ctrl+P)' : 'Show preview (Ctrl+P)';
  }
  if (sortBtn) {
    const arrow = tab.sort.dir < 0 ? 'chevronDown' : 'chevronUp';
    sortBtn.innerHTML = `${icon('sort', 13)}<span>${esc(SORT_LABELS[tab.sort.key] || 'Name')}</span>${icon(arrow, 11)}`;
    sortBtn.title = `Sort by ${SORT_LABELS[tab.sort.key] || 'Name'} — click to change`;
  }
  syncSearchUi();
}

function applyView() {
  const tab = activeTab();
  const vizMode = tab?.view === 'viz';
  const filesPane = document.getElementById('files-pane');
  const vizPane = document.getElementById('viz-pane');
  const filterbar = document.getElementById('filterbar');
  const previewPane = document.getElementById('preview-pane');
  if (filesPane) filesPane.hidden = vizMode;
  if (vizPane) vizPane.hidden = !vizMode;
  if (filterbar) filterbar.hidden = vizMode;
  if (previewPane) previewPane.hidden = vizMode || !state.preview.open;
  updateToolbar();
}

function renderChrome() {
  renderTabs();
  renderPathbar();
  sidebar.renderSidebar();
  files.renderFilters();
  applyView();
  files.updateStatus();
}

function afterFilesLoaded() {
  const tab = activeTab();
  if (tab && state.listing) {
    tab.path = state.listing.path;
    if (tab.history[tab.index] && !samePath(tab.history[tab.index], tab.path)) {
      tab.history[tab.index] = tab.path;
    }
  }
  renderChrome();
  preview.refreshPreviewSoon();
  if (tab?.view === 'viz') viz.ensureViz();
}

async function navigate(path, options = {}) {
  const tab = activeTab();
  if (!tab) return false;
  const target = String(path || '').trim();
  if (!target) return false;
  if (options.newTab) {
    openTab(target, { view: options.view });
    return true;
  }

  const changed = !samePath(tab.path, target);
  if (options.view) tab.view = options.view;
  if (options.history !== false && changed) {
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(target);
    tab.index = tab.history.length - 1;
  }
  tab.path = target;
  tab.query = '';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  addRecent(target);
  if (pathEditing) endPathEdit(false);
  renderChrome();
  scheduleSave();
  const ok = await files.refreshFiles();
  if (ok) {
    const scroll = document.getElementById('files-scroll');
    if (scroll) scroll.scrollTop = 0;
  }
  return ok;
}

async function goHistory(offset) {
  const tab = activeTab();
  if (!tab) return;
  const next = tab.index + offset;
  if (next < 0 || next >= tab.history.length) return;
  tab.index = next;
  tab.path = tab.history[next];
  tab.query = '';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  syncSearchUi();
  renderChrome();
  await files.refreshFiles();
  scheduleSave();
}

function goUp() {
  const tab = activeTab();
  if (!tab) return;
  const parent = state.listing?.parent || dirname(tab.path);
  if (parent) navigate(parent);
}

async function refreshCurrent() {
  const scroll = document.getElementById('files-scroll');
  const top = scroll?.scrollTop || 0;
  const ok = await files.refreshFiles();
  if (ok && scroll) scroll.scrollTop = top;
  return ok;
}

async function openTab(path, options = {}) {
  const previous = activeTab();
  if (previous) {
    const scroll = document.getElementById('files-scroll');
    previous.scrollTop = scroll?.scrollTop || 0;
  }
  const tab = createTab(path || previous?.path || state.app?.home || '/', {
    view: options.view || previous?.view || 'grid',
    sort: previous?.sort,
    filter: previous?.filter || 'all',
    showHidden: previous?.showHidden || false,
  });
  state.tabs.push(tab);
  state.activeId = tab.id;
  tab.query = '';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  addRecent(tab.path);
  scheduleSave();
  renderChrome();
  await files.refreshFiles();
  if (tab.view === 'viz') viz.ensureViz();
}

async function activateTab(id) {
  if (id === state.activeId) return;
  const previous = activeTab();
  if (previous) {
    const scroll = document.getElementById('files-scroll');
    previous.scrollTop = scroll?.scrollTop || 0;
  }
  state.activeId = id;
  const tab = activeTab();
  if (!tab) return;
  tab.query = '';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  syncSearchUi();
  renderChrome();
  await files.refreshFiles();
  const scroll = document.getElementById('files-scroll');
  if (scroll) scroll.scrollTop = tab.scrollTop || 0;
  if (tab.view === 'viz') viz.ensureViz();
  scheduleSave();
}

async function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const wasActive = state.activeId === id;
  state.tabs.splice(index, 1);
  if (!state.tabs.length) {
    const tab = createTab(state.app?.home || '/');
    state.tabs.push(tab);
    state.activeId = tab.id;
    await files.refreshFiles();
  } else if (wasActive) {
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    state.activeId = next.id;
    state.searchResults = null;
    state.searching = false;
    await files.refreshFiles();
  }
  renderChrome();
  scheduleSave();
}

function openEntry(entry) {
  if (!entry) return;
  if (entry.isDir) {
    navigate(entry.path);
    return;
  }
  api.openPath(entry.path).catch((error) => toast(String(error), { type: 'error' }));
}

function openPath(path) {
  if (!path) return;
  api.openPath(path).catch((error) => toast(String(error), { type: 'error' }));
}

function visualizePath(path) {
  navigate(path, { view: 'viz' });
}

function setView(view) {
  const tab = activeTab();
  if (!tab || !VIEW_BUTTONS[view]) return;
  tab.view = view;
  applyView();
  scheduleSave();
  if (view === 'viz') {
    viz.ensureViz();
  } else {
    files.renderFiles();
    preview.renderPreview();
  }
}

function setPreviewOpen(open) {
  state.preview.open = Boolean(open);
  applyView();
  scheduleSave();
  if (state.preview.open) preview.renderPreview();
}

function togglePreview() {
  setPreviewOpen(!state.preview.open);
}

async function setShowHidden(value) {
  const tab = activeTab();
  if (!tab) return;
  tab.showHidden = Boolean(value);
  scheduleSave();
  await files.refreshFiles({ silent: true });
  files.renderFilters();
  updateToolbar();
  if (tab.view === 'viz') viz.ensureViz();
}

function toggleHidden() {
  const tab = activeTab();
  if (!tab) return;
  setShowHidden(!tab.showHidden);
}

function setSort(key) {
  const tab = activeTab();
  if (!tab || !SORT_LABELS[key]) return;
  if (tab.sort.key === key) tab.sort.dir = tab.sort.dir < 0 ? 1 : -1;
  else tab.sort = { key, dir: key === 'size' || key === 'modified' ? -1 : 1 };
  files.recomputeVisible();
  files.renderFiles();
  updateToolbar();
  scheduleSave();
}

function clearQuery() {
  const tab = activeTab();
  if (!tab) return;
  tab.query = '';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  syncSearchUi();
  files.recomputeVisible();
  files.renderFiles();
  files.renderFilters();
  scheduleSave();
}

function resetFilters() {
  const tab = activeTab();
  if (!tab) return;
  tab.query = '';
  tab.filter = 'all';
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  syncSearchUi();
  files.recomputeVisible();
  files.renderFiles();
  files.renderFilters();
  scheduleSave();
}

function beginPathEdit() {
  const tab = activeTab();
  const input = document.getElementById('path-input');
  const crumbs = document.getElementById('crumbs');
  if (!tab || !input) return;
  pathEditing = true;
  closeMenu();
  input.hidden = false;
  if (crumbs) crumbs.hidden = true;
  input.value = tab.path;
  input.focus();
  input.select();
}

function endPathEdit(commit) {
  if (!pathEditing) return;
  pathEditing = false;
  const input = document.getElementById('path-input');
  const crumbs = document.getElementById('crumbs');
  const value = input?.value.trim() || '';
  if (input) input.hidden = true;
  if (crumbs) crumbs.hidden = false;
  if (commit && value) {
    let target = value.replace(/^"(.*)"$/, '$1');
    if (/^[A-Za-z]:$/.test(target)) target = `${target}\\`;
    if (!isPathLike(target)) target = joinPath(activeTab()?.path || '', target);
    navigate(target);
  } else {
    renderPathbar();
  }
}

function resetSearch() {
  if (searchTimer) {
    searchTimer.cancel();
    searchTimer = null;
  }
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  files.recomputeVisible();
  files.renderFiles();
  files.renderFilters();
}

async function runSearchNow() {
  const tab = activeTab();
  if (!tab) return;
  const query = (tab.query || '').trim();
  if (!state.searchRecursive || query.length < 2) {
    resetSearch();
    return;
  }
  const token = ++state.searchToken;
  const tabId = tab.id;
  const path = tab.path;
  files.beginSearch();
  try {
    const hits = await api.searchFiles(path, query, 400, tab.showHidden);
    if (token !== state.searchToken || activeTab()?.id !== tabId) return;
    files.finishSearch(hits);
  } catch (error) {
    if (token !== state.searchToken || activeTab()?.id !== tabId) return;
    files.finishSearch([]);
    toast(String(error), { type: 'error' });
  }
}

function scheduleRunSearch() {
  if (searchTimer) searchTimer.cancel();
  searchTimer = debounce(() => {
    searchTimer = null;
    runSearchNow();
  }, 240);
  searchTimer();
}

function onSearchInput() {
  const tab = activeTab();
  const input = document.getElementById('search-input');
  if (!tab || !input) return;
  tab.query = input.value;
  if (state.searchRecursive && tab.query.trim().length >= 2) scheduleRunSearch();
  else resetSearch();
}

function setSearchRecursive(value) {
  const next = Boolean(value);
  if (next === state.searchRecursive) return;
  state.searchRecursive = next;
  scheduleSave();
  syncSearchUi();
  const tab = activeTab();
  if (!tab) return;
  if (next && (tab.query || '').trim().length >= 2) scheduleRunSearch();
  else if (!next) resetSearch();
}

function toggleSearchScope() {
  setSearchRecursive(!state.searchRecursive);
}

let networkLoading = false;

async function loadNetwork() {
  if (networkLoading) return;
  if (state.app?.platform !== 'windows') {
    state.network = [];
    sidebar.renderSidebar();
    return;
  }
  networkLoading = true;
  state.network = null;
  sidebar.renderSidebar();
  const merge = (items) => {
    if (!items?.length) return;
    const list = state.network || [];
    for (const place of items) {
      const known = list.some((other) => other.path.toLowerCase() === place.path.toLowerCase());
      if (!known) list.push(place);
    }
    state.network = list;
    sidebar.renderSidebar();
  };
  const ask = (call) => Promise.resolve(call).then(merge).catch(() => {});
  await Promise.all([ask(api.networkPlaces()), ask(api.networkComputers())]);
  state.network = state.network || [];
  networkLoading = false;
  sidebar.renderSidebar();
}

function focusSearch() {
  const tab = activeTab();
  if (tab?.view === 'viz') setView('grid');
  const input = document.getElementById('search-input');
  input?.focus();
  input?.select();
}

function showButtonMenu(button, items) {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  showMenu({ x: rect.right, y: rect.bottom + 6, align: 'right', items });
}

function sortMenuItems() {
  const tab = activeTab();
  if (!tab) return [];
  const items = ['name', 'size', 'modified', 'kind'].map((key) => ({
    label: SORT_LABELS[key],
    icon: tab.sort.key === key ? 'check' : null,
    onClick: () => setSort(key),
  }));
  items.push({ separator: true });
  items.push({
    label: 'Ascending',
    icon: tab.sort.dir > 0 ? 'check' : null,
    onClick: () => {
      tab.sort.dir = 1;
      files.recomputeVisible();
      files.renderFiles();
      updateToolbar();
      scheduleSave();
    },
  });
  items.push({
    label: 'Descending',
    icon: tab.sort.dir < 0 ? 'check' : null,
    onClick: () => {
      tab.sort.dir = -1;
      files.recomputeVisible();
      files.renderFiles();
      updateToolbar();
      scheduleSave();
    },
  });
  return items;
}

function moreMenuItems() {
  const tab = activeTab();
  if (!tab) return [];
  return [
    { label: 'New folder', icon: 'folderPlus', shortcut: 'Ctrl+Shift+N', onClick: () => ops.newFolder() },
    { label: 'New tab', icon: 'plus', shortcut: 'Ctrl+T', onClick: () => openTab(tab.path) },
    { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => refreshCurrent() },
    { label: 'Playlist', icon: 'playlist', hidden: !player.hasQueue(), onClick: () => player.showQueue() },
    { separator: true },
    {
      label: tab.showHidden ? 'Hide hidden files' : 'Show hidden files',
      icon: tab.showHidden ? 'eyeOff' : 'eye',
      onClick: () => toggleHidden(),
    },
    { label: 'Bookmark this folder', icon: 'bookmark', onClick: () => sidebar.addBookmarkCurrent() },
    { label: 'Copy current path', icon: 'copy', onClick: () => ops.copyEntryPaths([{ path: tab.path, name: tabLabel(tab.path) }]) },
    { separator: true },
    { label: 'Command palette', icon: 'command', shortcut: 'Ctrl+K', onClick: () => openPalette() },
    { label: 'Settings', icon: 'settings', onClick: () => openSettings() },
  ];
}

function backgroundMenu(x, y) {
  const tab = activeTab();
  if (!tab) return;
  showMenu({
    x,
    y,
    items: [
      { label: 'New folder', icon: 'folderPlus', shortcut: 'Ctrl+Shift+N', onClick: () => ops.newFolder() },
      {
        label: 'Paste',
        icon: 'clipboard',
        shortcut: 'Ctrl+V',
        disabled: !state.clipboard.paths.length,
        onClick: () => ops.pasteIntoCurrent(),
      },
      { label: 'Refresh', icon: 'refresh', shortcut: 'F5', onClick: () => refreshCurrent() },
      { separator: true },
      {
        label: tab.showHidden ? 'Hide hidden files' : 'Show hidden files',
        icon: tab.showHidden ? 'eyeOff' : 'eye',
        onClick: () => toggleHidden(),
      },
      { label: 'Bookmark this folder', icon: 'bookmark', onClick: () => sidebar.addBookmarkCurrent() },
      { label: 'Command palette', icon: 'command', shortcut: 'Ctrl+K', onClick: () => openPalette() },
      { separator: true },
      systemMenuItem(tab.path),
      { label: 'Settings', icon: 'settings', onClick: () => openSettings() },
    ],
  });
}

function navMenu(path, x, y) {
  showMenu({
    x,
    y,
    items: [
      { label: 'Open', icon: 'folderOpen', onClick: () => navigate(path) },
      { label: 'Open in new tab', icon: 'plus', onClick: () => openTab(path) },
      { label: 'Reveal in file manager', icon: 'external', onClick: () => ops.revealEntry({ path, isDir: true }) },
      { separator: true },
      systemMenuItem(path),
    ],
  });
}

function entryMenu(entry, x, y) {
  const list = files.selectedEntries();
  const targets = list.length ? list : [entry];
  const single = targets.length === 1;
  const playable = targets.filter((item) => !item.isDir && (item.kind === 'audio' || item.kind === 'video'));
  const systemMenu = systemMenuItem(entry.path);
  if (!single) systemMenu.hidden = true;
  showMenu({
    x,
    y,
    items: [
      {
        label: entry.isDir ? 'Open folder' : 'Open',
        icon: entry.isDir ? 'folderOpen' : 'play',
        shortcut: 'Enter',
        onClick: () => openEntry(entry),
      },
      {
        label: 'Play',
        icon: 'play',
        hidden: !playable.length,
        disabled: playable.length !== 1,
        onClick: () => player.playEntry(entry),
      },
      {
        label: playable.length > 1 ? `Add ${playable.length} to playlist` : 'Add to playlist',
        icon: 'playlist',
        hidden: !playable.length,
        onClick: () => player.addToPlaylist(playable),
      },
      {
        label: 'Show playlist',
        icon: 'list',
        hidden: !player.hasQueue(),
        onClick: () => player.showQueue(),
      },
      {
        label: 'Open in new tab',
        icon: 'plus',
        hidden: !entry.isDir,
        disabled: !single,
        onClick: () => openTab(entry.path),
      },
      {
        label: 'Visualize folder',
        icon: 'chart',
        hidden: !entry.isDir,
        disabled: !single,
        onClick: () => visualizePath(entry.path),
      },
      { label: 'Reveal in file manager', icon: 'external', onClick: () => ops.revealEntry(entry) },
      { separator: true },
      systemMenu,
      { separator: true },
      {
        label: targets.length > 1 ? `Copy ${targets.length} items` : 'Copy',
        icon: 'copy',
        shortcut: 'Ctrl+C',
        onClick: () => ops.copySelection(false),
      },
      {
        label: targets.length > 1 ? `Cut ${targets.length} items` : 'Cut',
        icon: 'cut',
        shortcut: 'Ctrl+X',
        onClick: () => ops.copySelection(true),
      },
      { label: 'Copy path', icon: 'clipboard', onClick: () => ops.copyEntryPaths(targets) },
      { separator: true },
      {
        label: 'Rename',
        icon: 'pencil',
        shortcut: 'F2',
        hidden: !single,
        onClick: () => ops.renameEntry(entry),
      },
      {
        label: 'Move to Trash',
        icon: 'trash',
        shortcut: 'Del',
        danger: true,
        onClick: () => ops.removeEntries(targets),
      },
      { separator: true },
      {
        label: 'Properties',
        icon: 'info',
        hidden: !single,
        onClick: () => ops.showProperties(entry),
      },
    ],
  });
}

function openPalette() {
  closeMenu();
  palette.openPalette();
}

function isEditable(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function onKeyDown(event) {
  if (event.defaultPrevented) return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;
  const lower = key.toLowerCase();

  const paletteOpen = Boolean(document.querySelector('.palette-backdrop'));
  if (paletteOpen) {
    if (mod && lower === 'k') {
      event.preventDefault();
      palette.closePalette();
    }
    return;
  }
  if (anyOverlayOpen()) return;

  if (mod && lower === 'k') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (mod && lower === 'l') {
    event.preventDefault();
    beginPathEdit();
    return;
  }
  if (key === 'Escape' && pathEditing) {
    event.preventDefault();
    endPathEdit(false);
    return;
  }
  if (isEditable(event.target)) return;

  if (key === ' ' && player.hasQueue() && !event.target.closest?.('button, [role="button"]')) {
    event.preventDefault();
    player.togglePlay();
    return;
  }

  const tab = activeTab();
  if (!tab) return;
  const vizMode = tab.view === 'viz';

  if (key === 'Escape') {
    if ((tab.query || '').trim() || state.searchResults !== null) {
      event.preventDefault();
      clearQuery();
    } else {
      files.clearSelection();
    }
    return;
  }

  if (mod && key === 'Tab') {
    event.preventDefault();
    const index = state.tabs.findIndex((item) => item.id === state.activeId);
    const next = state.tabs[(index + (event.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length];
    if (next) activateTab(next.id);
    return;
  }
  if (mod && lower === 't') {
    event.preventDefault();
    openTab(tab.path);
    return;
  }
  if (mod && lower === 'w') {
    event.preventDefault();
    closeTab(state.activeId);
    return;
  }
  if (mod && lower === 'p') {
    event.preventDefault();
    togglePreview();
    return;
  }
  if (mod && lower === 'r') {
    event.preventDefault();
    refreshCurrent();
    return;
  }
  if (mod && ['1', '2', '3'].includes(key)) {
    event.preventDefault();
    setView(key === '1' ? 'grid' : key === '2' ? 'list' : 'viz');
    return;
  }
  if (mod && event.shiftKey && lower === 'n') {
    event.preventDefault();
    ops.newFolder();
    return;
  }
  if (mod && lower === 'f') {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (mod && lower === 'a') {
    event.preventDefault();
    files.selectAll();
    return;
  }
  if (mod && (lower === 'c' || lower === 'x')) {
    if (window.getSelection()?.toString()) return;
    event.preventDefault();
    ops.copySelection(lower === 'x');
    return;
  }
  if (mod && lower === 'v') {
    event.preventDefault();
    ops.pasteIntoCurrent();
    return;
  }

  if (event.altKey && key === 'ArrowLeft') {
    event.preventDefault();
    goHistory(-1);
    return;
  }
  if (event.altKey && key === 'ArrowRight') {
    event.preventDefault();
    goHistory(1);
    return;
  }
  if (event.altKey && key === 'ArrowUp') {
    event.preventDefault();
    goUp();
    return;
  }

  if (key === 'F5') {
    event.preventDefault();
    refreshCurrent();
    return;
  }
  if (key === 'F2') {
    event.preventDefault();
    if (!vizMode) ops.renameEntry(files.focusedEntry());
    return;
  }
  if (key === 'Delete') {
    event.preventDefault();
    if (!vizMode) ops.removeEntries();
    return;
  }
  if (key === '/') {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (key === 'Backspace') {
    event.preventDefault();
    goUp();
    return;
  }
  if (key === 'Enter') {
    if (vizMode) return;
    const entry = files.focusedEntry();
    if (entry) {
      event.preventDefault();
      openEntry(entry);
    }
    return;
  }

  if (!vizMode) {
    const moves = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      Home: 'home',
      End: 'end',
      PageUp: 'pageup',
      PageDown: 'pagedown',
    };
    const direction = moves[key];
    if (direction) {
      event.preventDefault();
      files.moveFocusByDirection(direction, event.shiftKey);
    }
  }
}

async function refreshPreservingSelection() {
  const tab = activeTab();
  if (!tab) return;
  const scroll = document.getElementById('files-scroll');
  const top = scroll?.scrollTop || 0;
  const selected = [...state.selection];
  const focusPath = files.focusedEntry()?.path;
  const ok = await files.refreshFiles({ silent: true });
  if (!ok) return;
  const present = new Set(state.visibleEntries.map((entry) => entry.path));
  state.selection = new Set(selected.filter((path) => present.has(path)));
  if (focusPath) {
    const index = state.visibleEntries.findIndex((entry) => entry.path === focusPath);
    if (index >= 0) {
      state.focusIndex = index;
      state.anchorIndex = index;
    }
  }
  files.updateSelectionUI();
  if (scroll) scroll.scrollTop = top;
}

function bindStaticEvents() {
  document.getElementById('nav-back')?.addEventListener('click', () => goHistory(-1));
  document.getElementById('nav-forward')?.addEventListener('click', () => goHistory(1));
  document.getElementById('nav-up')?.addEventListener('click', goUp);
  document.getElementById('refresh')?.addEventListener('click', () => refreshCurrent());
  document.getElementById('new-tab')?.addEventListener('click', () => openTab(activeTab()?.path));

  document.getElementById('tabs')?.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close-tab]');
    if (close) {
      event.stopPropagation();
      closeTab(close.dataset.closeTab);
      return;
    }
    const tab = event.target.closest('[data-tab-id]');
    if (tab) activateTab(tab.dataset.tabId);
  });
  document.getElementById('tabs')?.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const tab = event.target.closest('[data-tab-id]');
    if (tab) closeTab(tab.dataset.tabId);
  });

  document.querySelector('.tabstrip')?.addEventListener('contextmenu', (event) => {
    const tab = activeTab();
    if (!tab) return;
    event.preventDefault();
    showMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: 'Copy to Clipboard',
          icon: 'copy',
          onClick: () => ops.copyEntryPaths([{ path: tab.path, name: tabLabel(tab.path) }]),
        },
      ],
    });
  });

  document.getElementById('crumbs')?.addEventListener('click', (event) => {
    const crumb = event.target.closest('.crumb[data-path]');
    if (crumb) navigate(crumb.dataset.path);
  });
  document.getElementById('path-edit')?.addEventListener('click', () => {
    if (pathEditing) endPathEdit(false);
    else beginPathEdit();
  });

  const pathInput = document.getElementById('path-input');
  pathInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      endPathEdit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      endPathEdit(false);
    }
  });
  pathInput?.addEventListener('blur', () => {
    if (pathEditing) endPathEdit(true);
  });

  const searchInput = document.getElementById('search-input');
  searchInput?.addEventListener('input', onSearchInput);
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      clearQuery();
      searchInput.blur();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (state.searchRecursive) runSearchNow();
      else {
        const first = state.visibleEntries[0];
        if (first) openEntry(first);
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      searchInput.blur();
      files.moveFocusByDirection('down');
    }
  });
  document.getElementById('search-scope')?.addEventListener('click', toggleSearchScope);

  for (const [view, id] of Object.entries(VIEW_BUTTONS)) {
    document.getElementById(id)?.addEventListener('click', () => setView(view));
  }
  document.getElementById('preview-toggle')?.addEventListener('click', togglePreview);

  const sortBtn = document.getElementById('sort-btn');
  sortBtn?.addEventListener('click', () => showButtonMenu(sortBtn, sortMenuItems()));
  const moreBtn = document.getElementById('more-btn');
  moreBtn?.addEventListener('click', () => showButtonMenu(moreBtn, moreMenuItems()));

  document.getElementById('content')?.addEventListener('contextmenu', (event) => {
    if (event.target.closest('#files-scroll, .files-pane') && !event.target.closest('[data-path]')) {
      event.preventDefault();
      backgroundMenu(event.clientX, event.clientY);
    }
  });

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('beforeunload', () => saveSessionNow());
}

function assignBridge() {
  Object.assign(app, {
    navigate,
    openTab,
    openEntry,
    openPath,
    visualizePath,
    refresh: refreshCurrent,
    refreshViz: () => viz.loadViz(true),
    setView,
    setFilter: (filter) => files.setFilter(filter),
    setShowHidden,
    toggleHidden,
    setPreviewOpen,
    togglePreview,
    setSearchRecursive,
    newFolder: ops.newFolder,
    rename: ops.renameEntry,
    remove: ops.removeEntries,
    copy: (cut = false) => ops.copySelection(cut),
    cut: () => ops.copySelection(true),
    paste: ops.pasteIntoCurrent,
    copyPath: ops.copyEntryPaths,
    reveal: ops.revealEntry,
    properties: ops.showProperties,
    bookmarkCurrent: sidebar.addBookmarkCurrent,
    rescanNetwork: loadNetwork,
    openSettings,
    openPalette,
    resetFilters,
    clearSearch: clearQuery,
    closeTab,
    playMedia: player.playEntry,
    addToPlaylist: player.addToPlaylist,
    showPlaylist: player.showQueue,
    togglePlayback: player.togglePlay,
    entryMenu,
    backgroundMenu,
    navMenu,
    toast,
    copyText: (text) =>
      api.copyText(text).then(
        () => toast('Copied to clipboard', { type: 'success', icon: 'copy' }),
        (error) => toast(String(error), { type: 'error' })
      ),
    onFilesLoaded: afterFilesLoaded,
    onSelectionChange: () => {
      preview.refreshPreviewSoon();
      updateToolbar();
    },
  });
}

function listenFilesystem() {
  listen('fs:changed', () => {
    clearTimeout(fsTimer);
    fsTimer = setTimeout(() => {
      if (!state.booted) return;
      refreshPreservingSelection();
    }, 420);
  }).catch(() => {});
}

async function boot() {
  setStaticIcons();
  try {
    state.app = await api.appInfo();
  } catch {
    state.app = { home: '/', sep: '/', platform: 'unknown', portable: false, version: '0.2.1', dataDir: '', cacheDir: '' };
  }
  try {
    state.places = await api.listPlaces();
  } catch {
    state.places = [];
  }

  await loadSession();
  assignBridge();
  sidebar.initSidebar();
  files.initFiles();
  player.initPlayer();
  preview.initPreview();
  viz.initViz();
  ops.initOps();
  bindStaticEvents();
  listenFilesystem();
  renderChrome();
  preview.renderPreview();
  loadNetwork().catch(() => {});

  const ok = await files.refreshFiles();
  const tab = activeTab();
  if (!ok && tab) {
    const home = state.app?.home;
    if (home && !samePath(tab.path, home)) {
      toast(`Could not open that folder — showing ${home}`, { type: 'warn' });
      tab.path = home;
      tab.history = [home];
      tab.index = 0;
      tab.query = '';
      state.searchResults = null;
      state.searching = false;
      trackRecent(home);
      syncSearchUi();
      renderChrome();
      await files.refreshFiles();
    }
  }
  state.booted = true;
  scheduleSave();
}

function trackRecent(path) {
  if (path) addRecent(path);
}

boot().catch((error) => {
  console.error(error);
  const appRoot = document.getElementById('app');
  if (appRoot) {
    appRoot.innerHTML = `
      <div class="pane-state" style="position:fixed">
        <div class="state-card">
          <div class="state-icon">${icon('alert', 28)}</div>
          <div class="state-title">Alt File Explorer failed to start</div>
          <div class="state-text">${esc(String(error))}</div>
        </div>
      </div>`;
  }
});
