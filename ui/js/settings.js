import { api } from './api.js';
import { state, activeTab, app, scheduleSave } from './state.js';
import { openModal, confirmDialog, toast } from './dialogs.js';
import { icon } from './icons.js';
import { applyThemeHue, esc, humanSize, humanCount, clamp, debounce } from './util.js';
import { renderFiles } from './files.js';
import { setModelSpin } from './model.js';
import { setLoop, setActiveSoundFont, soundfontLabel } from './player.js';
import { renderViz, refreshViz } from './viz.js';
import { checkForUpdates, installUpdate, onUpdate, updateInfo } from './updates.js';

import { COMMANDS, eventBinding, shortcutLabel, isCustomized, setBinding, resetBinding, resetBindings } from './keyboard.js';

function shortcutRows() {
  return ['browser', 'terminal'].map(scope => `
    <div class="shortcut-section">${scope === 'terminal' ? 'Inside the terminal' : 'While browsing'}</div>
    ${COMMANDS.filter(command => command.scope === scope && (command.id !== 'windowMenu' || state.app?.platform === 'windows')).map(command => `
      <div class="shortcut-row" data-shortcut-row="${command.id}">
        <span class="shortcut-label">${esc(command.label)}</span>
        <button type="button" class="shortcut-binding" data-rebind="${command.id}" aria-label="Rebind ${esc(command.label)}">${esc(shortcutLabel(command.id) || 'Not assigned')}</button>
        <button type="button" class="mini-btn" data-reset-binding="${command.id}" aria-label="Reset ${esc(command.label)}" ${isCustomized(command.id) ? '' : 'disabled'}>Reset</button>
        <div class="shortcut-editor" hidden>
          <span role="status" aria-live="polite">Press a key combination. Escape cancels.</span>
          <button type="button" class="mini-btn" data-disable-binding="${command.id}">Unbind</button>
          <button type="button" class="mini-btn" data-cancel-binding="${command.id}">Cancel</button>
        </div>
      </div>`).join('')}`).join('');
}

function initShortcutEditor(body, onChange) {
  const list = body.querySelector('#settings-shortcuts');
  let editing = null;
  const suppressedKeys = new Set();
  const render = (focusId) => {
    editing = null;
    list.innerHTML = shortcutRows();
    if (focusId) list.querySelector(`[data-rebind="${focusId}"]`)?.focus({ preventScroll: true });
  };
  const message = (text) => {
    list.querySelector(`[data-shortcut-row="${editing}"] [role="status"]`).textContent = text;
  };
  const changed = (id) => {
    scheduleSave();
    onChange();
    render(id);
  };
  const start = (id) => {
    render();
    editing = id;
    const row = list.querySelector(`[data-shortcut-row="${id}"]`);
    row.classList.add('recording');
    row.querySelector('.shortcut-editor').hidden = false;
    const button = row.querySelector('[data-rebind]');
    button.textContent = 'Press shortcut…';
    button.focus({ preventScroll: true });
  };
  list.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.rebind) start(button.dataset.rebind);
    if (button.dataset.cancelBinding) render(button.dataset.cancelBinding);
    if (button.dataset.disableBinding) {
      const id = button.dataset.disableBinding;
      setBinding(id, null);
      changed(id);
    }
    if (button.dataset.resetBinding) {
      const id = button.dataset.resetBinding;
      const error = resetBinding(id);
      if (error) { start(id); message(error); }
      else changed(id);
    }
  });
  body.querySelector('#settings-reset-shortcuts').addEventListener('click', () => {
    resetBindings();
    changed();
  });
  const onKeyDown = event => {
    if (event.repeat && suppressedKeys.has(event.code || event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!editing || !body.closest('.modal-backdrop')?.contains(event.target)) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      render(editing);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedKeys.add(event.code || event.key);
    if (event.repeat) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      render(editing);
      return;
    }
    const binding = eventBinding(event);
    if (!binding) return;
    const error = setBinding(editing, binding);
    if (error) message(error);
    else changed(editing);
  };
  const onKeyUp = event => {
    if (!suppressedKeys.delete(event.code || event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
  };
}

const rerender = debounce(() => renderFiles(), 220);
const rerenderViz = debounce(() => {
  if (activeTab()?.view === 'viz') renderViz();
}, 220);

function updateRowHtml() {
  const update = updateInfo();
  const job = update.install || {};
  if (job.running) {
    const percent = job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0;
    const label =
      job.phase === 'installing'
        ? 'Installing update…'
        : job.total > 0
          ? `Downloading ${esc(update.latest)}… ${percent}%`
          : `Downloading ${esc(update.latest)}…`;
    const meter =
      job.phase === 'download' && job.total > 0
        ? `<div class="update-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><i style="width:${percent}%"></i></div>`
        : '';
    return `<span id="settings-update-status">${label}</span>${meter}`;
  }
  if (update.checking && !update.available) {
    return `<span id="settings-update-status">Checking for updates…</span><span class="nav-meta">Please wait</span>`;
  }
  if (update.available && job.error) {
    return `<span id="settings-update-status" title="${esc(job.error)}">Update failed</span>
      <button class="mini-btn" id="settings-update-action" data-action="install" type="button">${icon('download', 12)} Retry</button>`;
  }
  if (update.available) {
    return `<span id="settings-update-status">Version ${esc(update.latest)} is available</span>
      <button class="mini-btn" id="settings-update-action" data-action="install" type="button">${icon('download', 12)} Get update</button>`;
  }
  if (update.error) {
    return `<span id="settings-update-status">Could not check for updates</span>
      <button class="mini-btn" id="settings-update-action" data-action="check" type="button">Retry</button>`;
  }
  return `<span id="settings-update-status">${update.checkedAt ? 'Up to date' : 'Not checked yet'}</span>
    <button class="mini-btn" id="settings-update-action" data-action="check" type="button">Check now</button>`;
}

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
      <div class="settings-group-title">Visualization</div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Treemap depth threshold</div>
          <div class="setting-desc">Inside the treemap, a folder's contents are drawn one level deeper while the folder takes more than this share of its section. Lower values reveal more levels; higher values keep the map calmer.</div>
        </div>
        <div class="setting-control">
          <input class="range" id="settings-nested-share" type="range" min="1" max="50" step="1" value="${state.nestedShare}">
          <span id="settings-nested-value" class="nav-meta">${state.nestedShare}%</span>
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
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">MIDI SoundFont</div>
          <div class="setting-desc">MIDI files play with a built-in generative General MIDI synth by default. Right-click any .sf2 file and choose <strong>Use for MIDI playback</strong> to play MIDI files with that SoundFont instead.</div>
        </div>
        <div class="setting-control">
          <span class="nav-meta" id="settings-soundfont-name" title="${esc(state.soundFont || '')}">${esc(soundfontLabel())}</span>
          <button class="mini-btn" id="settings-soundfont-reset" type="button"${state.soundFont ? '' : ' hidden'}>${icon('refresh', 12)} Use built-in</button>
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
          <div class="setting-label">DOS wildcard matching</div>
          <div class="setting-desc">Match whole filenames, ignoring case: <code>*</code> matches any number of characters and <code>?</code> matches one. For example, <code>report?.txt</code>. <code>*.*</code> also includes extensionless names.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-search-wildcards"${state.searchWildcards ? ' checked' : ''}>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-main">
          <div class="setting-label">Regular expression matching</div>
          <div class="setting-desc">Match within filenames, ignoring case by default; use anchors for a whole name, e.g. <code>^report[0-9]+\\.txt$</code>. Look-around and backreferences are not supported.</div>
          <div class="setting-desc">Both styles apply to filtering and subfolder searches. With both enabled, either interpretation can match; invalid regex falls back to wildcards. With neither enabled, fuzzy matching is used.</div>
        </div>
        <div class="setting-control">
          <input type="checkbox" id="settings-search-regex"${state.searchRegex ? ' checked' : ''}>
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
          <div class="setting-desc">Adds <strong>Explore in AltFile</strong> to the right-click menu for folders and folder backgrounds. It opens AltFile at that folder, or focuses the open window and navigates it there. Windows 11 keeps these entries in the classic menu: press Shift+F10 (or the Menu key), or choose <strong>Show more options</strong>. The button removes them again once they are installed.</div>
        </div>
        <div class="setting-control">
          <button class="mini-btn" id="settings-install-menu" type="button">${icon('external', 12)} Add AltFile Context Menu Items</button>
        </div>
      </div>
    </div>` : ''}

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
      <div class="shortcut-heading">
        <div class="settings-group-title">Keyboard shortcuts</div>
        <button type="button" class="mini-btn" id="settings-reset-shortcuts">Restore all defaults</button>
      </div>
      <p class="setting-desc">Click a binding, then press its replacement. Changes save automatically and replace all keys shown for that command. Escape cancels; Tab moves focus. Text editing and dialog navigation keep their standard keys. System-reserved shortcuts may not reach the app.</p>
      <div id="settings-shortcuts">${shortcutRows()}</div>
      <p class="setting-desc">Mouse gestures are unchanged: Ctrl+Wheel zooms the grid / drifts the list; Ctrl+Middle toggles autoscroll.</p>
    </div>

    <div class="settings-group">
      <div class="settings-group-title">About</div>
      <div class="about-line"><span>Alt File Explorer</span><strong>v${esc(appInfo.version || '0.2.2')}</strong></div>
      <div class="about-line"><span>Platform</span><strong>${esc(appInfo.platform || 'unknown')}</strong></div>
      <div class="about-line"><span>Build</span><strong>Tauri 2 · Rust · system WebView</strong></div>
      <div class="about-line"><span>Mode</span><strong>${appInfo.portable ? 'Portable' : 'Installed'}</strong></div>
      <div class="cache-line" id="settings-update-row">${updateRowHtml()}</div>
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
  const updateRow = body.querySelector('#settings-update-row');
  const repaintUpdateRow = () => {
    if (updateRow) updateRow.innerHTML = updateRowHtml();
  };
  const stopUpdates = onUpdate(repaintUpdateRow);
  let stopShortcuts = () => {};
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
    onClose: () => { stopUpdates(); stopShortcuts(); },
  });
  stopShortcuts = initShortcutEditor(body, () => app.refreshShortcutHints?.());

  body.querySelector('#settings-update-row')?.addEventListener('click', async (event) => {
    const action = event.target.closest('#settings-update-action');
    if (!action || action.disabled) return;
    if (action.dataset.action === 'install') {
      action.disabled = true;
      try {
        await installUpdate();
        toast('Restarting to install the update…', { type: 'success', icon: 'download' });
      } catch (error) {
        toast(String(error?.message || error), { type: 'error' });
      }
      return;
    }
    action.disabled = true;
    const result = await checkForUpdates({ force: true });
    if (result.error) toast('Could not check for updates', { type: 'error' });
    else if (result.available) toast(`Alt File Explorer ${result.latest} is available`, { type: 'success', icon: 'download' });
    else toast('You are on the latest version', { type: 'success', icon: 'check' });
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

  const refreshVizSoon = debounce(() => {
    if (activeTab()?.view === 'viz') refreshViz();
  }, 350);

  const shareRange = body.querySelector('#settings-nested-share');
  const shareValue = body.querySelector('#settings-nested-value');
  shareRange?.addEventListener('input', () => {
    const value = clamp(Math.round(Number(shareRange.value) || 1), 1, 50);
    state.nestedShare = value;
    if (shareValue) shareValue.textContent = `${value}%`;
    scheduleSave();
    state.viz.cache.clear();
    rerenderViz();
    refreshVizSoon();
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

  body.querySelector('#settings-soundfont-reset')?.addEventListener('click', () => {
    setActiveSoundFont(null);
    const name = body.querySelector('#settings-soundfont-name');
    if (name) {
      name.textContent = soundfontLabel();
      name.title = '';
    }
    const reset = body.querySelector('#settings-soundfont-reset');
    if (reset) reset.hidden = true;
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
  body.querySelector('#settings-search-wildcards')?.addEventListener('change', (event) => {
    app.setSearchPatterns?.(event.target.checked, state.searchRegex);
  });
  body.querySelector('#settings-search-regex')?.addEventListener('change', (event) => {
    app.setSearchPatterns?.(state.searchWildcards, event.target.checked);
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

  const menuButton = body.querySelector('#settings-install-menu');
  let menuInstalled = false;
  const paintMenuButton = () => {
    if (!menuButton) return;
    menuButton.innerHTML = menuInstalled
      ? `${icon('trash', 12)} Remove AltFile Context Menu Items`
      : `${icon('external', 12)} Add AltFile Context Menu Items`;
  };
  const refreshMenuButton = async () => {
    if (!menuButton) return;
    try {
      menuInstalled = await api.explorerMenuStatus();
    } catch {
      menuInstalled = false;
    }
    paintMenuButton();
  };

  menuButton?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (menuInstalled) {
        await api.uninstallExplorerMenu();
        menuInstalled = false;
        toast('Removed the AltFile context menu entries', { type: 'success', icon: 'check' });
      } else {
        const label = await api.installExplorerMenu();
        menuInstalled = true;
        toast(`Added "${label}" to the folder menu (Windows 11: under "Show more options")`, { type: 'success', icon: 'check' });
      }
    } catch (error) {
      toast(String(error), { type: 'error' });
      await refreshMenuButton();
    } finally {
      button.disabled = false;
      paintMenuButton();
    }
  });

  updateCacheLine();
  refreshMenuButton();
  return modal;
}
