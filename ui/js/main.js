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
import { completePath, looksLikePath } from './pathcomplete.js';
import * as files from './files.js';
import * as sidebar from './sidebar.js';
import * as preview from './preview.js';
import * as player from './player.js';
import * as viz from './viz.js';
import * as ops from './ops.js';
import * as palette from './palette.js';
import { openSettings } from './settings.js';
import { initUpdates } from './updates.js';
import { systemMenuItem } from './systemmenu.js';
import { isSoundfontEntry } from './sf2.js';
import { initTerminal, openTerminal, refreshTerminalShortcuts } from './terminal.js';
import { commandForEvent, isDefaultBinding, isEditingChord, shortcutLabel, shortcutTitle, getBindings, bindingLabel } from './keyboard.js';

const VIEW_BUTTONS = { grid: 'view-grid', list: 'view-list', viz: 'view-viz' };
const SORT_LABELS = { name: 'Name', size: 'Size', modified: 'Date', kind: 'Kind' };

let pathEditing = false;
let fsTimer = 0;
let searchTimer = null;
let windowTitle = null;
let pendingLaunchPath = '';
let placesRefreshing = false;
let placesRefreshPending = false;
let selectionRefreshing = false;
let selectionRefreshPending = false;

function applyLaunchPath(path) {
  const target = String(path || '').trim();
  if (!target) return;
  if (state.booted) navigate(target);
  else pendingLaunchPath = target;
}

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
          <button class="tab-close" type="button" data-close-tab="${esc(tab.id)}" aria-label="Close tab" title="${esc(shortcutTitle('Close tab', 'closeTab'))}">${icon('x', 11)}</button>
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
  const modes = [state.searchWildcards && 'Wildcards', state.searchRegex && 'Regex'].filter(Boolean);
  input.placeholder = `${recursive ? 'Search subfolders' : 'Filter this folder'}${modes.length ? ` · ${modes.join(' + ')}` : ''}`;
  input.title = modes.length
    ? `${modes.join(' + ')}: ${modes.length === 2 ? 'a name can match either pattern style. ' : ''}Wildcards match the whole name; regex matches within the name. Case-insensitive by default.`
    : 'Fuzzy filename matching. Enable wildcards or regular expressions in Settings.';
  if (scope) {
    scope.classList.toggle('on', recursive);
    scope.title = recursive
      ? 'Searching this folder and its subfolders — click to search only this folder'
      : 'Searching this folder only — click to include subfolders';
    scope.setAttribute('aria-pressed', recursive ? 'true' : 'false');
  }
}

function refreshShortcutHints() {
  const hints = {
    'nav-back': ['Back', 'back'], 'nav-forward': ['Forward', 'forward'], 'nav-up': ['Up one folder', 'parent'],
    refresh: ['Refresh', 'refresh'], 'path-edit': ['Edit path', 'editPath'], 'new-tab': ['New tab', 'newTab'],
    'view-grid': ['Grid view', 'grid'], 'view-list': ['List view', 'list'], 'view-viz': ['Visualize folder — right-click for more options', 'visualize'],
    'preview-toggle': [state.preview.open ? 'Hide preview' : 'Show preview', 'preview'],
    'palette-hint': ['Command palette', 'palette'],
  };
  for (const [id, [label, command]] of Object.entries(hints)) {
    const button = document.getElementById(id);
    if (button) button.title = shortcutTitle(label, command);
  }
  const paletteHint = document.getElementById('palette-hint');
  if (paletteHint) paletteHint.innerHTML = `<kbd>${esc(bindingLabel(getBindings('palette')[0] || 'Commands'))}</kbd>`;
  const searchHint = document.querySelector('.search-kbd');
  if (searchHint) {
    searchHint.textContent = bindingLabel(getBindings('search')[0] || '');
    searchHint.hidden = !searchHint.textContent;
  }
  for (const button of document.querySelectorAll('[data-close-tab]')) button.title = shortcutTitle('Close tab', 'closeTab');
  files.updateStatus();
  refreshTerminalShortcuts();
  player.refreshShortcutHints();
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
    previewToggle.title = shortcutTitle(state.preview.open ? 'Hide preview' : 'Show preview', 'preview');
  }
  if (sortBtn) {
    const arrow = tab.sort.dir < 0 ? 'chevronDown' : 'chevronUp';
    sortBtn.innerHTML = `${icon('sort', 13)}<span>${esc(SORT_LABELS[tab.sort.key] || 'Name')}</span>${icon(arrow, 11)}`;
    sortBtn.title = `Sort by ${SORT_LABELS[tab.sort.key] || 'Name'} — click to change`;
  }
  refreshShortcutHints();
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
  viz.syncVizWatch();
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

async function refreshPlaces() {
  if (placesRefreshing) {
    placesRefreshPending = true;
    return;
  }
  placesRefreshing = true;
  try {
    do {
      placesRefreshPending = false;
      const places = await api.listPlaces();
      if (JSON.stringify(places) !== JSON.stringify(state.places)) {
        state.places = places;
        sidebar.renderDrives();
      }
    } while (placesRefreshPending);
  } catch (error) {
    console.warn('Could not refresh drives', error);
  } finally {
    placesRefreshing = false;
  }
}

async function refreshCurrent() {
  refreshPlaces();
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

async function openTypedPath(value) {
  const tab = activeTab();
  let target = value.replace(/^"(.*)"$/, '$1');
  if (/^[A-Za-z]:$/.test(target)) target = `${target}\\`;
  if (!isPathLike(target)) target = joinPath(tab?.path || '', target);
  try {
    const info = await api.fileInfo(target);
    clearQuery();
    if (info.isDir) navigate(info.path);
    else api.openPath(info.path).catch((error) => toast(String(error), { type: 'error' }));
  } catch {
    toast(`No matching path: ${target}`, { type: 'error' });
  }
}

function visualizePath(path) {
  navigate(path, { view: 'viz' });
}

function vizTabMenuItems(path) {
  return [
    {
      label: 'Visualize in New Tab',
      icon: 'plus',
      onClick: () => openTab(path, { view: 'viz' }),
    },
    {
      label: 'Visualize each first level folder in a separate tab',
      icon: 'chart',
      onClick: () => visualizeSubfoldersInTabs(path),
    },
    {
      label: 'Export visualization as PNG',
      icon: 'download',
      onClick: () => viz.exportPng(),
    },
  ];
}

async function visualizeSubfoldersInTabs(path) {
  const tab = activeTab();
  const showHidden = Boolean(tab?.showHidden);
  let entries = null;
  if (state.listing && samePath(state.listing.path, path)) {
    entries = state.listing.entries;
  } else {
    try {
      entries = (await api.listDir(path, showHidden)).entries;
    } catch (error) {
      toast(String(error), { type: 'error' });
      return;
    }
  }
  const folders = (entries || []).filter((entry) => entry.isDir);
  if (!folders.length) {
    toast('No subfolders to visualize', { type: 'error' });
    return;
  }

  const previous = activeTab();
  if (previous) {
    const scroll = document.getElementById('files-scroll');
    previous.scrollTop = scroll?.scrollTop || 0;
  }
  const extra = {
    view: 'viz',
    sort: tab?.sort,
    filter: 'all',
    showHidden,
  };
  const tabs = folders.map((entry) => createTab(entry.path, extra));
  state.tabs.push(...tabs);
  state.activeId = tabs[0].id;
  state.searchToken += 1;
  state.searchResults = null;
  state.searching = false;
  addRecent(tabs[0].path);
  syncSearchUi();
  renderChrome();
  scheduleSave();
  await files.refreshFiles();
  viz.ensureViz();
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

function shouldSearchRecursively(query) {
  return state.searchRecursive && query.length >= (state.searchWildcards || state.searchRegex ? 1 : 2);
}

async function runSearchNow() {
  if (searchTimer) {
    searchTimer.cancel();
    searchTimer = null;
  }
  const tab = activeTab();
  if (!tab) return;
  const query = (tab.query || '').trim();
  if (!shouldSearchRecursively(query)) {
    resetSearch();
    return;
  }
  const token = ++state.searchToken;
  const tabId = tab.id;
  const path = tab.path;
  files.beginSearch();
  try {
    const hits = await api.searchFiles(path, query, 400, tab.showHidden, state.searchWildcards, state.searchRegex);
    if (token !== state.searchToken || activeTab()?.id !== tabId) return;
    files.finishSearch(hits);
  } catch (error) {
    if (token !== state.searchToken || activeTab()?.id !== tabId) return;
    files.finishSearch([], String(error));
  }
}

function scheduleRunSearch() {
  state.searchToken += 1;
  files.beginSearch();
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
  if (shouldSearchRecursively(tab.query.trim())) scheduleRunSearch();
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
  if (shouldSearchRecursively((tab.query || '').trim())) scheduleRunSearch();
  else resetSearch();
}

function setSearchPatterns(wildcards, regex) {
  state.searchWildcards = Boolean(wildcards);
  state.searchRegex = Boolean(regex);
  scheduleSave();
  syncSearchUi();
  if (shouldSearchRecursively((activeTab()?.query || '').trim())) scheduleRunSearch();
  else resetSearch();
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
    { label: 'New folder', icon: 'folderPlus', shortcut: shortcutLabel('newFolder'), onClick: () => ops.newFolder() },
    { label: 'New tab', icon: 'plus', shortcut: shortcutLabel('newTab'), onClick: () => openTab(tab.path) },
    { label: 'Refresh', icon: 'refresh', shortcut: shortcutLabel('refresh'), onClick: () => refreshCurrent() },
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
    { label: 'Command palette', icon: 'command', shortcut: shortcutLabel('palette'), onClick: () => openPalette() },
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
      { label: 'New folder', icon: 'folderPlus', shortcut: shortcutLabel('newFolder'), onClick: () => ops.newFolder() },
      {
        label: 'Paste',
        icon: 'clipboard',
        shortcut: shortcutLabel('paste'),
        disabled: !state.clipboard.paths.length,
        onClick: () => ops.pasteIntoCurrent(),
      },
      { label: 'Refresh', icon: 'refresh', shortcut: shortcutLabel('refresh'), onClick: () => refreshCurrent() },
      {
        label: 'Select all',
        icon: 'check',
        shortcut: shortcutLabel('selectAll'),
        hidden: state.selection.size > 1 || !state.visibleEntries.length,
        onClick: () => files.selectAll(),
      },
      {
        label: 'Invert selection',
        icon: 'repeat',
        shortcut: shortcutLabel('invertSelection'),
        hidden: state.selection.size < 2,
        onClick: () => files.invertSelection(),
      },
      { separator: true },
      {
        label: tab.showHidden ? 'Hide hidden files' : 'Show hidden files',
        icon: tab.showHidden ? 'eyeOff' : 'eye',
        onClick: () => toggleHidden(),
      },
      { label: 'Bookmark this folder', icon: 'bookmark', onClick: () => sidebar.addBookmarkCurrent() },
      { label: 'Command palette', icon: 'command', shortcut: shortcutLabel('palette'), onClick: () => openPalette() },
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

function entryMenu(entry, x, y, selection = null) {
  const list = selection === null ? files.selectedEntries() : selection;
  const targets = list.length ? list : [entry];
  const single = targets.length === 1;
  const soundfont = single && isSoundfontEntry(entry);
  const soundfontActive = soundfont && state.soundFont && state.soundFont.toLowerCase() === entry.path.toLowerCase();
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
        shortcut: shortcutLabel('open'),
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
        label: soundfontActive ? 'Using for MIDI playback' : 'Use for MIDI playback',
        icon: soundfontActive ? 'check' : 'piano',
        hidden: !soundfont,
        onClick: () => player.setActiveSoundFont(entry.path),
      },
      {
        label: 'Reset MIDI SoundFont',
        icon: 'refresh',
        hidden: !state.soundFont,
        onClick: () => player.setActiveSoundFont(null),
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
      {
        label: 'Extract To…',
        icon: 'download',
        hidden: !(single && files.archiveSupported(entry)),
        onClick: () => ops.extractArchive(entry),
      },
      { label: 'Reveal in file manager', icon: 'external', onClick: () => ops.revealEntry(entry) },
      { separator: true },
      systemMenu,
      { separator: true },
      {
        label: targets.length > 1 ? `Copy ${targets.length} items` : 'Copy',
        icon: 'copy',
        shortcut: shortcutLabel('copy'),
        onClick: () => ops.copySelection(false, targets),
      },
      {
        label: targets.length > 1 ? `Cut ${targets.length} items` : 'Cut',
        icon: 'cut',
        shortcut: shortcutLabel('cut'),
        onClick: () => ops.copySelection(true, targets),
      },
      { label: 'Copy path', icon: 'clipboard', onClick: () => ops.copyEntryPaths(targets) },
      { separator: true },
      {
        label: 'Invert selection',
        icon: 'repeat',
        shortcut: shortcutLabel('invertSelection'),
        hidden: targets.length < 2,
        onClick: () => files.invertSelection(),
      },
      {
        label: 'Select all',
        icon: 'check',
        shortcut: shortcutLabel('selectAll'),
        hidden: targets.length > 1,
        onClick: () => files.selectAll(),
      },
      { separator: true },
      {
        label: 'Rename',
        icon: 'pencil',
        shortcut: shortcutLabel('rename'),
        hidden: !single,
        onClick: () => ops.renameEntry(entry),
      },
      {
        label: 'Move to Trash',
        icon: 'trash',
        shortcut: shortcutLabel('trash'),
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

function openKeyboardMenu() {
  const contextual = document.activeElement?.closest?.(
    '.nav-item[data-path], .nav-item[data-playlist-id], .playlist-track, .crumb[data-path], .tab[data-tab-id]'
  );
  if (contextual) {
    const box = contextual.getBoundingClientRect();
    contextual.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      })
    );
    if (document.querySelector('.menu')) return;
  }
  const selected = files.selectedEntries();
  if (selected.length) {
    const entry = files.focusedEntry() || selected[0];
    const el = document.querySelector('#files-scroll .file-card.focused, #files-scroll .file-row.focused');
    const box = el?.getBoundingClientRect() || document.getElementById('files-scroll')?.getBoundingClientRect();
    if (box) {
      entryMenu(entry, box.left + box.width / 2, box.top + Math.min(box.height / 2, 48));
      return;
    }
  }
  openPalette();
}

function crumbMenu(path, x, y) {
  const sep = state.app?.sep || (navigator.userAgent.includes('Windows') ? '\\' : '/');
  const parts = splitPath(path, sep);
  const name = parts.length ? parts[parts.length - 1].label : path;
  entryMenu({ path, name: name || path, isDir: true, kind: 'folder' }, x, y, []);
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

// WebView2 also opens its own context menu for the Menu key; a trusted
// keyboard contextmenu (button -1) shortly after our handler is that menu.
let menuKeyAt = 0;

function suppressNativeMenuKey(event) {
  if (event.button === -1 && performance.now() - menuKeyAt < 600) event.preventDefault();
}

function onKeyDown(event) {
  if (event.defaultPrevented || event.isComposing || event.getModifierState?.('AltGraph') || event.target.closest?.('#terminal-pane')) return;
  const key = event.key;
  const command = commandForEvent(event);
  const editable = isEditable(event.target);
  const inputCommand = !editable || event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(key);
  if (document.querySelector('.palette-backdrop')) {
    if (command === 'palette' && inputCommand) {
      event.preventDefault();
      palette.closePalette();
    }
    return;
  }
  if (anyOverlayOpen()) return;
  if (editable && (!inputCommand || isEditingChord(event) || !['palette', 'editPath', 'windowMenu'].includes(command))) return;
  if (command && (key === 'ContextMenu' || key === 'Apps')) menuKeyAt = performance.now();
  if (command === 'palette') {
    event.preventDefault();
    openPalette();
    return;
  }
  if (command === 'editPath') {
    event.preventDefault();
    beginPathEdit();
    return;
  }
  if (command === 'windowMenu') {
    event.preventDefault();
    if (state.app?.platform === 'windows') api.openWindowMenu().catch(() => {});
    return;
  }
  if (command === 'contextMenu') {
    event.preventDefault();
    openKeyboardMenu();
    return;
  }
  if (command === 'playPause') {
    const nativeActivation = (key === ' ' || key === 'Enter') && event.target.closest?.('button, [role="button"]');
    if (player.hasQueue() && !nativeActivation) {
      event.preventDefault();
      player.togglePlay();
    }
    return;
  }

  const tab = activeTab();
  if (!tab) return;
  const vizMode = tab.view === 'viz';
  if (command) {
    if ((command === 'copy' || command === 'cut') && window.getSelection()?.toString()) return;
    event.preventDefault();
    switch (command) {
      case 'terminal': if (!event.repeat) openTerminal(); break;
      case 'clear':
        if ((tab.query || '').trim() || state.searchResults !== null) clearQuery();
        else files.clearSelection();
        break;
      case 'nextTab':
      case 'previousTab': {
        const index = state.tabs.findIndex(item => item.id === state.activeId);
        const next = state.tabs[(index + (command === 'previousTab' ? -1 : 1) + state.tabs.length) % state.tabs.length];
        if (next) activateTab(next.id);
        break;
      }
      case 'newTab': openTab(tab.path); break;
      case 'closeTab': closeTab(state.activeId); break;
      case 'preview': togglePreview(); break;
      case 'refresh': refreshCurrent(); break;
      case 'grid': setView('grid'); break;
      case 'list': setView('list'); break;
      case 'visualize': setView('viz'); break;
      case 'newFolder': ops.newFolder(); break;
      case 'search': focusSearch(); break;
      case 'selectAll': files.selectAll(); break;
      case 'invertSelection': files.invertSelection(); break;
      case 'toggleSelect': files.toggleFocusedSelection(); break;
      case 'copy':
      case 'cut':
        ops.copySelection(command === 'cut');
        break;
      case 'paste': ops.pasteIntoCurrent(); break;
      case 'back': goHistory(-1); break;
      case 'forward': goHistory(1); break;
      case 'parent':
        if (key === 'ArrowLeft' && tab.view === 'grid' && !vizMode && state.searchResults === null) {
          files.moveFocusByDirection('left');
          break;
        }
        if (!event.repeat && !state.loading && !(vizMode && key === 'ArrowLeft' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)) goUp();
        break;
      case 'rename': if (!vizMode) ops.renameEntry(files.focusedEntry()); break;
      case 'trash': if (!vizMode) ops.removeEntries(); break;
      case 'open':
        if (!vizMode && files.focusedEntry()) openEntry(files.focusedEntry());
        break;
      case 'enterPreview': {
        if (vizMode) break;
        if (key === 'ArrowRight' && tab.view === 'grid' && state.searchResults === null) {
          files.moveFocusByDirection('right');
          break;
        }
        if (event.repeat || state.loading) break;
        const entry = files.focusedEntry();
        if (!entry) break;
        if (entry.isDir) navigate(entry.path);
        else {
          if (state.selection.size !== 1 || !state.selection.has(entry.path)) files.selectPath(entry.path);
          if (state.preview.open) {
            const el = document.querySelector('#files-scroll .file-card.focused, #files-scroll .file-row.focused');
            const box = el?.getBoundingClientRect() || document.getElementById('files-scroll')?.getBoundingClientRect();
            if (box) entryMenu(entry, box.left + box.width / 2, box.top + Math.min(box.height / 2, 48));
          } else setPreviewOpen(true);
        }
        break;
      }
      default:
        if (!vizMode) {
          const extend = command.startsWith('select');
          const additive = command.startsWith('add');
          const direction = extend ? command.slice(6).toLowerCase() : additive ? command.slice(3).toLowerCase() : command;
          files.moveFocusByDirection(direction, extend, additive);
        }
    }
    return;
  }

  if (isDefaultBinding(event)) event.preventDefault();
  if (!editable && !event.ctrlKey && !event.metaKey && !event.altKey && [...key].length === 1 && key !== ' ') {
    event.preventDefault();
    focusSearch();
    const input = document.getElementById('search-input');
    input.setRangeText(key, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
  }
}

async function refreshPreservingSelection() {
  if (selectionRefreshing) {
    selectionRefreshPending = true;
    return;
  }
  selectionRefreshing = true;
  try {
    do {
      selectionRefreshPending = false;
      const tab = activeTab();
      if (!tab) return;
      const scroll = document.getElementById('files-scroll');
      const top = scroll?.scrollTop || 0;
      const selected = [...state.selection];
      const focusPath = files.focusedEntry()?.path;
      const ok = await files.refreshFiles({ silent: true });
      if (!ok) continue;
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
    } while (selectionRefreshPending);
  } finally {
    selectionRefreshing = false;
  }
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
    const tabId = event.target.closest('[data-tab-id]')?.dataset.tabId;
    const tab = state.tabs.find((item) => item.id === tabId) || activeTab();
    if (!tab) return;
    event.preventDefault();
    const items = [
      {
        label: 'Copy path to clipboard',
        icon: 'copy',
        onClick: () => ops.copyEntryPaths([{ path: tab.path, name: tabLabel(tab.path) }]),
      },
    ];
    if (!sidebar.isBookmarked(tab.path)) {
      items.push({
        label: 'Bookmark',
        icon: 'bookmark',
        onClick: () => sidebar.addBookmark(tab.path),
      });
    }
    showMenu({ x: event.clientX, y: event.clientY, items });
  });

  document.getElementById('crumbs')?.addEventListener('click', (event) => {
    const crumb = event.target.closest('.crumb[data-path]');
    if (crumb) navigate(crumb.dataset.path);
  });
  document.getElementById('crumbs')?.addEventListener('contextmenu', (event) => {
    const crumb = event.target.closest('.crumb[data-path]');
    if (!crumb) return;
    event.preventDefault();
    event.stopPropagation();
    crumbMenu(crumb.dataset.path, event.clientX, event.clientY);
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
    } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const typed = pathInput.value;
      const tab = activeTab();
      completePath(typed, tab?.path || '', tab?.showHidden, state.app?.home)
        .then((next) => {
          if (!next || !pathEditing || pathInput.value !== typed) return;
          pathInput.value = next;
          pathInput.setSelectionRange(next.length, next.length);
        })
        .catch(() => {});
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
      const typed = searchInput.value.trim();
      if (!state.searchWildcards && !state.searchRegex && looksLikePath(typed)) {
        openTypedPath(typed);
        return;
      }
      if (state.searchRecursive) runSearchNow();
      else {
        const first = state.visibleEntries[0];
        if (first) openEntry(first);
      }
    } else if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && looksLikePath(searchInput.value)) {
      event.preventDefault();
      const typed = searchInput.value;
      const tab = activeTab();
      completePath(typed, tab?.path || '', tab?.showHidden, state.app?.home)
        .then((next) => {
          if (!next || searchInput.value !== typed) return;
          searchInput.value = next;
          searchInput.setSelectionRange(next.length, next.length);
          onSearchInput();
        })
        .catch(() => {});
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
  const vizBtn = document.getElementById('view-viz');
  vizBtn?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const tab = activeTab();
    if (!tab) return;
    const items = vizTabMenuItems(tab.path);
    if (event.button === -1 || (event.clientX === 0 && event.clientY === 0)) {
      showButtonMenu(vizBtn, items);
    } else {
      showMenu({ x: event.clientX, y: event.clientY, items });
    }
  });
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
  window.addEventListener('contextmenu', suppressNativeMenuKey, true);
  window.addEventListener('beforeunload', () => saveSessionNow());
  window.addEventListener('focus', refreshPlaces);
}

function assignBridge() {
  Object.assign(app, {
    navigate,
    openTab,
    openEntry,
    openPath,
    visualizePath,
    refresh: refreshCurrent,
    setView,
    setFilter: (filter) => files.setFilter(filter),
    setShowHidden,
    toggleHidden,
    setPreviewOpen,
    togglePreview,
    setSearchRecursive,
    setSearchPatterns,
    refreshShortcutHints,
    newFolder: ops.newFolder,
    rename: ops.renameEntry,
    remove: ops.removeEntries,
    copy: (cut = false) => ops.copySelection(cut),
    cut: () => ops.copySelection(true),
    paste: ops.pasteIntoCurrent,
    copyPath: ops.copyEntryPaths,
    reveal: ops.revealEntry,
    properties: ops.showProperties,
    extractArchive: ops.extractArchive,
    bookmarkCurrent: sidebar.addBookmarkCurrent,
    renderSidebar: sidebar.renderSidebar,
    rescanNetwork: loadNetwork,
    openSettings,
    openPalette,
    resetFilters,
    clearSearch: clearQuery,
    closeTab,
    playMedia: player.playEntry,
    setSoundFont: player.setActiveSoundFont,
    refreshSoundFontUI: () => {
      files.renderFiles();
      preview.refreshPreviewSoon();
    },
    addToPlaylist: player.addToPlaylist,
    addPathsToPlaylist: player.addPathsToPlaylist,
    openPlaylist: player.openPlaylistById,
    playPlaylistTrack: player.playPlaylistTrack,
    newPlaylist: player.newPlaylist,
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
  listen('open-path', (event) => applyLaunchPath(event.payload)).catch(() => {});
}

async function boot() {
  setStaticIcons();
  try {
    state.app = await api.appInfo();
  } catch {
    state.app = { home: '/', sep: '/', platform: 'unknown', portable: false, version: '0.2.2', dataDir: '', cacheDir: '' };
  }
  await listen('drives:changed', refreshPlaces).catch(() => {});
  await refreshPlaces();

  await loadSession();
  assignBridge();
  sidebar.initSidebar();
  files.initFiles();
  player.initPlayer();
  preview.initPreview();
  viz.initViz();
  initTerminal();
  ops.initOps();
  bindStaticEvents();
  listenFilesystem();
  renderChrome();
  preview.renderPreview();
  loadNetwork().catch(() => {});
  initUpdates(() => sidebar.renderSidebar());

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
  const launchPath = await api.takeLaunchPath().catch(() => null);
  if (launchPath) pendingLaunchPath = launchPath;
  state.booted = true;
  if (pendingLaunchPath) {
    const target = pendingLaunchPath;
    pendingLaunchPath = '';
    await navigate(target);
  }
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
