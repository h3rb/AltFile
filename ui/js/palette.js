import { state, activeTab, app } from './state.js';
import { selectedEntries } from './files.js';
import { icon, kindIcon } from './icons.js';
import {
  esc,
  fuzzy,
  basename,
  kindLabel,
  humanSize,
  fmtRelative,
  isPathLike,
  clamp,
} from './util.js';

const QUICK_ICONS = {
  home: 'home',
  desktop: 'monitor',
  documents: 'fileText',
  downloads: 'download',
  pictures: 'image',
  music: 'music',
  videos: 'video',
};

let session = null;

function actionItems() {
  const tab = activeTab();
  if (!tab) return [];
  const selected = selectedEntries();
  const items = [
    {
      group: 'Actions',
      label: 'New tab',
      sub: 'Open the current folder in a new tab',
      icon: 'plus',
      run: () => app.openTab?.(tab.path),
    },
    {
      group: 'Actions',
      label: 'New folder',
      sub: 'Create a folder in the current directory',
      icon: 'folderPlus',
      run: () => app.newFolder?.(),
    },
    {
      group: 'Actions',
      label: 'Refresh',
      sub: 'Reload the current folder',
      icon: 'refresh',
      run: () => app.refresh?.(),
    },
    {
      group: 'Actions',
      label: 'Visualize this folder',
      sub: 'Open the treemap visualization',
      icon: 'chart',
      run: () => app.setView?.('viz'),
    },
    {
      group: 'Actions',
      label: state.preview.open ? 'Hide preview panel' : 'Show preview panel',
      sub: 'Toggle the details pane',
      icon: 'panelRight',
      run: () => app.togglePreview?.(),
    },
    {
      group: 'Actions',
      label: tab.showHidden ? 'Hide hidden files' : 'Show hidden files',
      sub: 'Toggle dotfiles and system items',
      icon: tab.showHidden ? 'eyeOff' : 'eye',
      run: () => app.toggleHidden?.(),
    },
    {
      group: 'Actions',
      label: 'Bookmark this folder',
      sub: tab.path,
      icon: 'bookmark',
      run: () => app.bookmarkCurrent?.(),
    },
    {
      group: 'Actions',
      label: 'Copy current path',
      sub: tab.path,
      icon: 'copy',
      run: () => app.copyPath?.([{ path: tab.path, name: basename(tab.path) }]),
    },
    {
      group: 'Actions',
      label: 'Settings',
      sub: 'Appearance, storage and shortcuts',
      icon: 'settings',
      run: () => app.openSettings?.(),
    },
  ];

  if (state.media.queue.length) {
    items.push({
      group: 'Actions',
      label: 'Show playlist',
      sub: `${state.media.queue.length} item${state.media.queue.length === 1 ? '' : 's'} queued`,
      icon: 'playlist',
      run: () => app.showPlaylist?.(),
    });
  }

  const playable = selected.filter((entry) => !entry.isDir && (entry.kind === 'audio' || entry.kind === 'video'));
  if (playable.length) {
    items.unshift({
      group: 'Actions',
      label: playable.length === 1 ? `Play “${playable[0].name}”` : `Play ${playable.length} selected`,
      sub: 'Open in the media player',
      icon: 'play',
      run: () => {
        if (playable.length === 1) {
          app.playMedia?.(playable[0]);
        } else {
          app.addToPlaylist?.(playable);
          app.showPlaylist?.();
        }
      },
    });
    items.splice(1, 0, {
      group: 'Actions',
      label: playable.length === 1 ? 'Add to playlist' : `Add ${playable.length} to playlist`,
      sub: 'Queue without playing',
      icon: 'playlist',
      run: () => app.addToPlaylist?.(playable),
    });
  }

  if (selected.length) {
    items.unshift({
      group: 'Actions',
      label: `Copy ${selected.length} selected`,
      sub: 'Copy to clipboard',
      icon: 'copy',
      run: () => app.copy?.(false),
    });
    items.splice(1, 0, {
      group: 'Actions',
      label: `Cut ${selected.length} selected`,
      sub: 'Move on paste',
      icon: 'cut',
      run: () => app.cut?.(),
    });
    items.splice(2, 0, {
      group: 'Actions',
      label: `Move ${selected.length} selected to Trash`,
      sub: 'This can be undone from the system Trash',
      icon: 'trash',
      run: () => app.remove?.(),
    });
    if (selected.length === 1) {
      items.splice(3, 0, {
        group: 'Actions',
        label: `Rename “${selected[0].name}”`,
        sub: 'Change the item name',
        icon: 'pencil',
        run: () => app.rename?.(selected[0]),
      });
    }
  }

  if (state.clipboard.paths.length) {
    items.push({
      group: 'Actions',
      label: 'Paste into this folder',
      sub: `${state.clipboard.paths.length} item${state.clipboard.paths.length === 1 ? '' : 's'} on the clipboard`,
      icon: 'clipboard',
      run: () => app.paste?.(),
    });
  }

  return items;
}

function placeItems() {
  return (state.places || []).map((place) => ({
    group: 'Places',
    label: place.name,
    sub: place.path,
    icon: place.kind === 'drive' ? 'drive' : QUICK_ICONS[place.id] || 'folder',
    run: () => app.navigate?.(place.path),
  }));
}

function bookmarkItems() {
  return state.bookmarks.map((bookmark) => ({
    group: 'Bookmarks',
    label: bookmark.name,
    sub: bookmark.path,
    icon: 'bookmark',
    run: () => app.navigate?.(bookmark.path),
  }));
}

function recentItems() {
  return state.recent.map((path) => ({
    group: 'Recent',
    label: basename(path) || path,
    sub: path,
    icon: 'clock',
    run: () => app.navigate?.(path),
  }));
}

function fileItems() {
  const entries = state.listing?.entries || [];
  return entries.map((entry) => ({
    group: 'In this folder',
    label: entry.name,
    sub: `${kindLabel(entry.kind)} · ${entry.isDir ? fmtRelative(entry.modified) : humanSize(entry.size)}`,
    kind: entry.kind,
    run: () => app.openEntry?.(entry),
  }));
}

function pathItem(query) {
  if (!isPathLike(query)) return null;
  return {
    group: 'Go to',
    label: query,
    sub: 'Navigate to this path',
    icon: 'arrowUpRight',
    run: () => app.navigate?.(query),
  };
}

function score(item, query) {
  if (!query) return 1;
  const primary = fuzzy(item.label, query);
  const secondary = item.sub ? fuzzy(item.sub, query) : null;
  if (!primary && !secondary) return null;
  return Math.max(primary ? primary.score : 0, secondary ? secondary.score * 0.35 : 0);
}

function buildResults(query) {
  const trimmed = query.trim();
  const commandOnly = trimmed.startsWith('>');
  const needle = commandOnly ? trimmed.slice(1).trim() : trimmed;

  const groups = [];
  const addGroup = (name, items, limit) => {
    if (!items.length) return;
    groups.push({ name, items: items.slice(0, limit) });
  };

  if (commandOnly) {
    const matches = actionItems()
      .map((item) => ({ item, s: score(item, needle) }))
      .filter((row) => row.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((row) => row.item);
    addGroup('Actions', matches, 20);
    return groups;
  }

  const special = pathItem(trimmed);
  if (special) addGroup('Go to', [special], 1);

  const actions = actionItems()
    .map((item) => ({ item, s: score(item, needle) }))
    .filter((row) => row.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((row) => row.item);
  addGroup('Actions', actions, trimmed ? 8 : 14);

  const places = placeItems()
    .map((item) => ({ item, s: score(item, needle) }))
    .filter((row) => row.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((row) => row.item);
  addGroup('Places', places, trimmed ? 5 : 12);

  const bookmarks = bookmarkItems()
    .map((item) => ({ item, s: score(item, needle) }))
    .filter((row) => row.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((row) => row.item);
  addGroup('Bookmarks', bookmarks, trimmed ? 5 : 10);

  const recent = recentItems()
    .map((item) => ({ item, s: score(item, needle) }))
    .filter((row) => row.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((row) => row.item);
  addGroup('Recent', recent, trimmed ? 5 : 8);

  const entries = fileItems()
    .map((item) => ({ item, s: score(item, needle) }))
    .filter((row) => row.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((row) => row.item);
  addGroup('In this folder', entries, trimmed ? 14 : 10);

  return groups;
}

function iconHtml(item) {
  return item.kind ? kindIcon(item.kind, 15) : icon(item.icon || 'file', 15);
}

function render() {
  if (!session) return;
  const { input, list } = session;
  const groups = buildResults(input.value);
  session.flat = [];
  const html = [];

  for (const group of groups) {
    html.push(`<div class="palette-group">${esc(group.name)}</div>`);
    for (const item of group.items) {
      const index = session.flat.length;
      session.flat.push(item);
      html.push(`
        <button class="palette-item" type="button" data-palette-index="${index}">
          <span class="p-icon">${iconHtml(item)}</span>
          <span class="p-main">
            <span class="p-label">${esc(item.label)}</span>
            ${item.sub ? `<span class="p-sub">${esc(item.sub)}</span>` : ''}
          </span>
          <span class="p-enter">${icon('cornerUpLeft', 12)}</span>
        </button>`);
    }
  }

  list.innerHTML = html.length ? html.join('') : '<div class="palette-empty">No commands, places or files match your search.</div>';
  session.active = -1;
  setActive(session.flat.length ? 0 : -1);
}

function setActive(index) {
  if (!session) return;
  if (!session.flat.length) {
    session.active = -1;
    return;
  }
  const next = clamp(index, 0, session.flat.length - 1);
  session.active = next;
  for (const el of session.list.querySelectorAll('.palette-item')) {
    el.classList.toggle('active', Number(el.dataset.paletteIndex) === next);
  }
  session.list.querySelector(`[data-palette-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
}

function runIndex(index) {
  if (!session || index < 0 || index >= session.flat.length) return;
  const item = session.flat[index];
  closePalette();
  item.run();
}

function onKeyDown(event) {
  if (!session) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setActive(session.active + 1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActive(session.active - 1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runIndex(session.active);
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    setActive(session.active + (event.shiftKey ? -1 : 1));
  }
}

function onListClick(event) {
  const button = event.target.closest('[data-palette-index]');
  if (!button) return;
  runIndex(Number(button.dataset.paletteIndex));
}

function onListHover(event) {
  const button = event.target.closest('[data-palette-index]');
  if (!button) return;
  const index = Number(button.dataset.paletteIndex);
  if (index !== session?.active) setActive(index);
}

export function openPalette() {
  if (session) {
    closePalette();
    return;
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.innerHTML = `
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette-input-row">
        ${icon('search', 16)}
        <input type="text" spellcheck="false" autocomplete="off" placeholder="Search commands, places and files…" aria-label="Search commands">
        <kbd>esc</kbd>
      </div>
      <div class="palette-list"></div>
      <div class="palette-foot">
        <span>${icon('chevronUp', 11)}${icon('chevronDown', 11)} navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>&gt;</kbd> commands only</span>
      </div>
    </div>`;

  document.getElementById('overlays').append(backdrop);
  const input = backdrop.querySelector('input');
  const list = backdrop.querySelector('.palette-list');
  session = { backdrop, input, list, flat: [], active: -1 };

  input.addEventListener('input', render);
  backdrop.addEventListener('keydown', onKeyDown);
  list.addEventListener('click', onListClick);
  list.addEventListener('pointermove', onListHover);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closePalette();
  });

  render();
  requestAnimationFrame(() => {
    backdrop.classList.add('open');
    input.focus();
  });
}

export function closePalette() {
  if (!session) return;
  const { backdrop } = session;
  session = null;
  backdrop.classList.remove('open');
  setTimeout(() => backdrop.remove(), 140);
}
