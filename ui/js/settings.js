import { api } from './api.js';
import { state, activeTab, app, scheduleSave } from './state.js';
import { openModal, confirmDialog, toast } from './dialogs.js';
import { icon } from './icons.js';
import { applyThemeHue, esc, humanSize, humanCount, clamp, debounce } from './util.js';
import { renderFiles } from './files.js';
import { setModelSpin } from './model.js';
import { setLoop } from './player.js';
import { renderViz } from './viz.js';

const SHORTCUTS = [
  ['Ctrl', 'K', 'Command palette'],
  ['Ctrl', 'L', 'Edit path'],
  ['Ctrl', 'T', 'New tab'],
  ['Ctrl', 'W', 'Close tab'],
  ['Ctrl', 'P', 'Toggle preview'],
  ['Ctrl', '1', 'Grid view'],
  ['Ctrl', '2', 'List view'],
  ['Ctrl', '3', 'Visualize'],
  ['Ctrl', 'C', 'Copy selection'],
  ['Ctrl', 'X', 'Cut selection'],
  ['Ctrl', 'V', 'Paste'],
  ['F2', '', 'Rename'],
  ['Del', '', 'Move to Trash'],
  ['F5', '', 'Refresh'],
  ['Alt', '←', 'Back'],
  ['Alt', '↑', 'Up one folder'],
  ['/', '', 'Filter this folder'],
  ['Esc', '', 'Clear search / selection'],
];

const rerender = debounce(() => renderFiles(), 220);
const rerenderViz = debounce(() => {
  if (activeTab()?.view === 'viz') renderViz();
}, 220);

function settingsHtml() {
  const tab = activeTab();
  const appInfo = state.app || {};
  return `
    <div class="settings-group">
      <div class="settings-group-title">Appearance</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Theme</div>
          <div class="setting-desc">Pick the hue for the accent color. Dark mode is the default and only theme in this build.</div>
        </div>
        <div class="setting-control">
          <input class="range hue-range" id="settings-hue" type="range" min="0" max="360" step="1" value="${Math.round(state.themeHue)}">
          <span id="settings-hue-value" class="nav-meta">${Math.round(state.themeHue)}°</span>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Thumbnail size</div>
          <div class="setting-desc">Cards scale from compact to extra large. Media thumbnails are generated on demand.</div>
        </div>
        <div class="setting-control">
          <input class="range" id="settings-thumb-size" type="range" min="120" max="260" step="8" value="${state.thumbSize}">
          <span id="settings-thumb-value" class="nav-meta">${state.thumbSize} px</span>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Preview panel</div>
          <div class="setting-desc">Show a details panel with thumbnails, metadata and text previews.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-preview"${state.preview.open ? ' checked' : ''}>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Rotate 3D models</div>
          <div class="setting-desc">Spin STL, OBJ, PLY and 3MF previews in the preview panel. Turn off to keep a static three-quarter view.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-model-spin"${state.modelSpin ? ' checked' : ''}>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Playlists in sidebar</div>
          <div class="setting-desc">Show saved playlists under Bookmarks in the left panel. Click one to open it in the player.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-show-playlists"${state.showPlaylists ? ' checked' : ''}>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Playback</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Loop playback</div>
          <div class="setting-desc">Repeat the current audio or video file when it ends instead of moving to the next item. The Loop button in the preview actions and player bar toggles the same setting.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-media-loop"${state.media.loop ? ' checked' : ''}>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Browsing</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Show hidden files</div>
          <div class="setting-desc">Include dotfiles and hidden system items in this tab${tab ? ` (${esc(tab.path)})` : ''}.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-hidden"${tab?.showHidden ? ' checked' : ''}>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Search subfolders</div>
          <div class="setting-desc">When on, the search box scans the current folder and everything inside it. When off, it only filters the files listed here. The scope button next to the search box toggles the same setting.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-search-recursive"${state.searchRecursive ? ' checked' : ''}>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Session restore</div>
          <div class="setting-desc">Tabs, bookmarks, recent folders and preferences are saved automatically.</div>
        </div>
        <div class="setting-control"><span class="nav-meta">Always on</span></div>
      </div>
    </div>

    ${appInfo.platform === 'windows' ? `
    <div class="settings-group">
      <div class="settings-group-title">Windows integration</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">File Explorer context menu</div>
          <div class="setting-desc">Adds <strong>Explore in AltFile</strong> to the right-click menu for folders. It opens AltFile at that folder, or focuses the open window and navigates it there.</div>
        </div>
        <div class="setting-control">
          <button class="mini-btn" id="settings-install-menu" type="button">${icon('external', 12)} Add AltFile Context Menu Items</button>
        </div>
      </div>
    </div>` : ''}

    <div class="settings-group">
      <div class="settings-group-title">Visualizer</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Scan depth</div>
          <div class="setting-desc">How many folder levels the visualization scans and keeps. Deeper folders are skipped. 1–255 levels.</div>
        </div>
        <div class="setting-control">
          <input class="range" id="settings-viz-depth" type="range" min="1" max="255" step="1" value="${state.vizDepth}">
          <span id="settings-viz-depth-value" class="nav-meta">${state.vizDepth} levels</span>
        </div>
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Storage</div>
      <div class="cache-line">
        <span id="settings-cache">Measuring thumbnail cache…</span>
        <button class="mini-btn" id="settings-clear-cache" type="button">${icon('trash', 12)} Clear cache</button>
      </div>
      <div class="settings-code">${esc(appInfo.cacheDir || '')}</div>
      <div class="cache-line">
        <span>${appInfo.portable ? 'Portable data folder' : 'Application data folder'}</span>
        <button class="mini-btn" id="settings-open-data" type="button">${icon('external', 12)} Open</button>
      </div>
      <div class="settings-code">${esc(appInfo.dataDir || '')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">Keyboard shortcuts</div>
      <div class="shortcut-grid">
        ${SHORTCUTS.map(
          ([mod, key, label]) =>
            `<span>${mod ? `<kbd>${esc(mod)}</kbd>` : ''}${key ? `<kbd>${esc(key)}</kbd>` : ''}${esc(label)}</span>`
        ).join('')}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">About</div>
      <div class="about-line"><span>Alt File Explorer</span><strong>v${esc(appInfo.version || '0.2.2')}</strong></div>
      <div class="about-line"><span>Platform</span><strong>${esc(appInfo.platform || 'unknown')}</strong></div>
      <div class="about-line"><span>Build</span><strong>Tauri 2 · Rust · system WebView</strong></div>
      <div class="about-line"><span>Mode</span><strong>${appInfo.portable ? 'Portable' : 'Installed'}</strong></div>
    </div>`;
}

async function updateCacheLine() {
  const line = document.getElementById('settings-cache');
  if (!line) return;
  try {
    const stats = await api.cacheStats();
    line.textContent = `${humanCount(stats.files)} files · ${humanSize(stats.bytes)} of ${humanSize(stats.maxBytes)}`;
  } catch {
    line.textContent = 'Thumbnail cache unavailable';
  }
}

export function openSettings() {
  const body = document.createElement('div');
  body.innerHTML = settingsHtml();
  const appInfo = state.app || {};
  const modal = openModal({
    headerClass: 'settings-head',
    headerHtml: `
      <div class="settings-brand">
        <img class="settings-logo" src="assets/logo.png" alt="">
        <span class="settings-app-name">Alt File Explorer</span>
        <span class="settings-divider" aria-hidden="true"></span>
        <h2 class="settings-title">Settings</h2>
      </div>
      ${appInfo.portable ? `<span class="mini-badge settings-portable" title="Portable data: ${esc(appInfo.dataDir || '')}">PORTABLE</span>` : ''}`,
    body,
    width: 660,
    actions: [{ label: 'Done', kind: 'primary' }],
  });

  const hueRange = body.querySelector('#settings-hue');
  const hueValue = body.querySelector('#settings-hue-value');
  hueRange?.addEventListener('input', () => {
    const hue = clamp(Math.round(Number(hueRange.value) || 0), 0, 360);
    state.themeHue = hue;
    if (hueValue) hueValue.textContent = `${hue}°`;
    applyThemeHue(hue);
    scheduleSave();
    rerender();
    rerenderViz();
  });

  const range = body.querySelector('#settings-thumb-size');
  const thumbValue = body.querySelector('#settings-thumb-value');
  range?.addEventListener('input', () => {
    const value = clamp(Number(range.value) || 176, 120, 260);
    state.thumbSize = value;
    if (thumbValue) thumbValue.textContent = `${value} px`;
    const scroll = document.getElementById('files-scroll');
    if (scroll) scroll.style.setProperty('--card-size', `${value}px`);
    scheduleSave();
    rerender();
  });

  const depthRange = body.querySelector('#settings-viz-depth');
  const depthValue = body.querySelector('#settings-viz-depth-value');
  depthRange?.addEventListener('input', () => {
    const value = clamp(Math.round(Number(depthRange.value) || 64), 1, 255);
    state.vizDepth = value;
    if (depthValue) depthValue.textContent = `${value} level${value === 1 ? '' : 's'}`;
    scheduleSave();
  });
  depthRange?.addEventListener('change', () => {
    state.viz.cache.clear();
    if (activeTab()?.view === 'viz') app.refreshViz?.();
  });

  body.querySelector('#settings-preview')?.addEventListener('change', (event) => {
    state.preview.open = event.target.checked;
    scheduleSave();
    app.setPreviewOpen?.(event.target.checked);
  });

  body.querySelector('#settings-model-spin')?.addEventListener('change', (event) => {
    scheduleSave();
    setModelSpin(event.target.checked);
  });

  body.querySelector('#settings-media-loop')?.addEventListener('change', (event) => {
    setLoop(event.target.checked);
  });

  body.querySelector('#settings-show-playlists')?.addEventListener('change', (event) => {
    state.showPlaylists = event.target.checked;
    scheduleSave();
    app.renderSidebar?.();
  });

  body.querySelector('#settings-hidden')?.addEventListener('change', (event) => {
    app.setShowHidden?.(event.target.checked);
  });

  body.querySelector('#settings-search-recursive')?.addEventListener('change', (event) => {
    app.setSearchRecursive?.(event.target.checked);
  });

  body.querySelector('#settings-clear-cache')?.addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: 'Clear thumbnail cache',
      message: 'Delete all cached thumbnails?',
      detail: 'They will be regenerated automatically the next time they are needed.',
      confirmLabel: 'Clear cache',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const freed = await api.clearCache();
      toast(`Cleared ${humanSize(freed)} of cached thumbnails`, { type: 'success', icon: 'trash' });
      await updateCacheLine();
      renderFiles();
    } catch (error) {
      toast(String(error), { type: 'error' });
    }
  });

  body.querySelector('#settings-open-data')?.addEventListener('click', () => {
    if (state.app?.dataDir) {
      api.openPath(state.app.dataDir).catch((error) => toast(String(error), { type: 'error' }));
    }
  });

  body.querySelector('#settings-install-menu')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const label = await api.installExplorerMenu();
      toast(`Added "${label}" to the File Explorer folder menu`, { type: 'success', icon: 'check' });
    } catch (error) {
      toast(String(error), { type: 'error' });
    } finally {
      button.disabled = false;
    }
  });

  updateCacheLine();
  return modal;
}
