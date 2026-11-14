import { state, activeTab, app, scheduleSave } from './state.js';
import { esc, basename, humanSize, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './dialogs.js';
import { updatePillHtml } from './updates.js';

const QUICK_ICONS = {
  home: 'home',
  desktop: 'monitor',
  documents: 'fileText',
  downloads: 'download',
  pictures: 'image',
  music: 'music',
  videos: 'video',
};

function normalize(path) {
  if (!path) return '';
  return path.replace(/[\\/]+$/, (match) => (match.length && path.length <= 3 ? match : '')).toLowerCase();
}

function samePath(a, b) {
  return normalize(a) === normalize(b);
}

function activePath() {
  return activeTab()?.path || '';
}

function navItem({ path, name, meta = '', iconName = 'folder', active = false, removable = false, bookmarkId = '', meter = null, title = '' }) {
  return `
    <div class="drive-wrap">
      <button class="nav-item${active ? ' active' : ''}" type="button" data-path="${esc(path)}" title="${esc(title || path)}">
        ${icon(iconName, 15)}
        <span class="nav-name">${esc(name)}</span>
        ${meta ? `<span class="nav-meta">${esc(meta)}</span>` : ''}
        ${removable ? `<span class="nav-remove" role="button" tabindex="0" data-bookmark="${esc(bookmarkId)}" title="Remove bookmark">${icon('x', 11)}</span>` : ''}
      </button>
      ${meter !== null ? `<div class="drive-meter"><span style="width:${Math.max(0, Math.min(100, meter))}%"></span></div>` : ''}
    </div>`;
}

function shareHost(path) {
  return String(path || '').replace(/^\\+/, '').split(/[\\/]/)[0] || '';
}

let expandedPlaylistId = null;

function playlistTracks(playlist) {
  if (!playlist.items.length) {
    return '<div class="playlist-tracks"><div class="nav-empty">This playlist is empty.</div></div>';
  }
  const playing =
    playlist.id === state.selectedPlaylistId ? state.media.queue[state.media.index]?.path : null;
  return `<div class="playlist-tracks">${playlist.items
    .map((item, index) => {
      const active = playing === item.path;
      return `
        <button class="playlist-track${active ? ' active' : ''}" type="button" data-track-playlist-id="${esc(playlist.id)}" data-track-index="${index}" title="${esc(item.path)}">
          ${icon(item.kind === 'video' ? 'video' : 'music', 13)}
          <span class="nav-name">${esc(item.name)}</span>
        </button>`;
    })
    .join('')}</div>`;
}

function playlistItem(playlist) {
  const active = playlist.id === state.selectedPlaylistId;
  const expanded = playlist.id === expandedPlaylistId;
  const count = playlist.items.length;
  return `
    <div class="drive-wrap">
      <button class="nav-item${active ? ' active' : ''}" type="button" data-playlist-id="${esc(playlist.id)}" aria-expanded="${expanded}" title="${esc(playlist.name)} — ${count} item${count === 1 ? '' : 's'}">
        ${icon('playlist', 15)}
        <span class="nav-name">${esc(playlist.name)}</span>
        <span class="nav-meta">${count}</span>
      </button>
      ${expanded ? playlistTracks(playlist) : ''}
    </div>`;
}

let dropTarget = null;

function playlistDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest('#playlist-list .nav-item[data-playlist-id]') || null;
}

function highlightPlaylist(item) {
  if (item === dropTarget) return;
  dropTarget?.classList.remove('drop-target');
  dropTarget = item;
  dropTarget?.classList.add('drop-target');
}

function initPlaylistDrop() {
  const webview = globalThis.__TAURI__?.webview?.getCurrentWebview?.();
  if (!webview?.onDragDropEvent) return;
  const toCss = (position) => ({
    x: (position?.x || 0) / (window.devicePixelRatio || 1),
    y: (position?.y || 0) / (window.devicePixelRatio || 1),
  });
  webview
    .onDragDropEvent((event) => {
      const payload = event?.payload || {};
      if (payload.type === 'leave' || payload.type === 'enter') {
        highlightPlaylist(null);
        return;
      }
      if (payload.type === 'over') {
        const point = toCss(payload.position);
        highlightPlaylist(playlistDropTarget(point.x, point.y));
        return;
      }
      if (payload.type !== 'drop') return;
      const point = toCss(payload.position);
      const item = playlistDropTarget(point.x, point.y);
      highlightPlaylist(null);
      const id = item?.dataset.playlistId;
      const paths = Array.isArray(payload.paths) ? payload.paths : [];
      if (id && paths.length) app.addPathsToPlaylist?.(id, paths);
    })
    .catch(() => {});
}

export function renderSidebar() {
  const quick = document.getElementById('quick-nav');
  const bookmarkList = document.getElementById('bookmark-list');
  const playlistNav = document.getElementById('playlist-nav');
  const playlistList = document.getElementById('playlist-list');
  const driveList = document.getElementById('drive-list');
  const networkList = document.getElementById('network-list');
  const rescanBtn = document.getElementById('rescan-network');
  const settingsBtn = document.getElementById('settings-btn');
  const addBtn = document.getElementById('add-bookmark');
  const addPlaylistBtn = document.getElementById('add-playlist');
  if (!quick || !bookmarkList || !driveList) return;

  const current = activePath();
  const places = state.places || [];
  const quickPlaces = places.filter((place) => place.kind === 'quick');
  const drives = places.filter((place) => place.kind === 'drive');

  if (settingsBtn) settingsBtn.innerHTML = `${icon('settings', 15)}<span>Settings</span>${updatePillHtml()}`;
  if (addBtn) addBtn.innerHTML = icon('plus', 13);
  if (addPlaylistBtn) addPlaylistBtn.innerHTML = icon('plus', 13);

  quick.innerHTML = `
    <div class="nav-list">
      ${quickPlaces
        .map((place) =>
          navItem({
            path: place.path,
            name: place.name,
            iconName: QUICK_ICONS[place.id] || 'folder',
            active: samePath(place.path, current),
          })
        )
        .join('')}
    </div>`;

  bookmarkList.innerHTML = state.bookmarks.length
    ? state.bookmarks
        .map((bookmark) =>
          navItem({
            path: bookmark.path,
            name: bookmark.name,
            iconName: 'bookmark',
            active: samePath(bookmark.path, current),
            removable: true,
            bookmarkId: bookmark.id,
          })
        )
        .join('')
    : '<div class="nav-empty">Use the + button to pin a folder here.</div>';

  if (playlistNav && playlistList) {
    playlistNav.toggleAttribute('hidden', !state.showPlaylists);
    dropTarget = null;
    if (expandedPlaylistId && !state.playlists.some((playlist) => playlist.id === expandedPlaylistId)) {
      expandedPlaylistId = null;
    }
    if (state.showPlaylists) {
      playlistList.innerHTML = state.playlists.length
        ? state.playlists.map((playlist) => playlistItem(playlist)).join('')
        : '<div class="nav-empty">No saved playlists yet.</div>';
    }
  }

  driveList.innerHTML = drives.length
    ? drives
        .map((drive) => {
          const hasSpace = Number.isFinite(drive.total) && Number.isFinite(drive.free) && drive.total > 0;
          const used = hasSpace ? ((drive.total - drive.free) / drive.total) * 100 : null;
          const meta = hasSpace ? `${humanSize(drive.free)} free` : '';
          return navItem({
            path: drive.path,
            name: drive.name,
            iconName: 'drive',
            meta,
            meter: used,
            active: samePath(drive.path, current),
          });
        })
        .join('')
    : '<div class="nav-empty">No drives detected.</div>';

  if (rescanBtn) rescanBtn.innerHTML = icon('refresh', 12);
  const onWindows = state.app ? state.app.platform === 'windows' : true;
  document.querySelector('.nav-heading.sub')?.toggleAttribute('hidden', !onWindows);
  networkList?.toggleAttribute('hidden', !onWindows);
  if (networkList && onWindows) {
    const shares = state.network;
    networkList.innerHTML =
      shares === null
        ? '<div class="nav-empty">Scanning the network…</div>'
        : shares.length
          ? shares
              .map((share) => {
                const host = shareHost(share.path);
                return navItem({
                  path: share.path,
                  name: share.name,
                  iconName: 'network',
                  meta: share.kind === 'share' && host.toLowerCase() !== share.name.toLowerCase() ? host : '',
                  title: share.comment ? `${share.path}\n${share.comment}` : share.path,
                  active: samePath(share.path, current),
                });
              })
              .join('')
          : '<div class="nav-empty">No shared folders found.</div>';
  }
}

export function isBookmarked(path) {
  return Boolean(path) && state.bookmarks.some((bookmark) => samePath(bookmark.path, path));
}

export function addBookmark(path, name) {
  if (!path) return;
  if (isBookmarked(path)) {
    toast('That folder is already bookmarked', { type: 'info', icon: 'bookmark' });
    return;
  }
  state.bookmarks.push({ id: uid(), name: name || basename(path) || path, path });
  scheduleSave();
  renderSidebar();
  toast(`Bookmarked ${basename(path) || path}`, { type: 'success', icon: 'bookmark' });
}

export function addBookmarkCurrent() {
  const tab = activeTab();
  if (!tab) return;
  addBookmark(tab.path);
}

export function removeBookmark(id) {
  const bookmark = state.bookmarks.find((item) => item.id === id);
  if (!bookmark) return;
  state.bookmarks = state.bookmarks.filter((item) => item.id !== id);
  scheduleSave();
  renderSidebar();
  toast(`Removed bookmark “${bookmark.name}”`, { type: 'info', icon: 'bookmark' });
}

function onListClick(event) {
  const remove = event.target.closest('.nav-remove');
  if (remove) {
    event.preventDefault();
    event.stopPropagation();
    removeBookmark(remove.dataset.bookmark);
    return;
  }
  const track = event.target.closest('.playlist-track');
  if (track) {
    app.playPlaylistTrack?.(track.dataset.trackPlaylistId, Number(track.dataset.trackIndex));
    return;
  }
  const playlist = event.target.closest('.nav-item[data-playlist-id]');
  if (playlist) {
    app.openPlaylist?.(playlist.dataset.playlistId);
    return;
  }
  const item = event.target.closest('.nav-item[data-path]');
  if (!item) return;
  app.navigate?.(item.dataset.path);
}

function onListContextMenu(event) {
  if (event.target.closest('.nav-remove')) return;
  const playlist = event.target.closest('.nav-item[data-playlist-id]');
  if (playlist) {
    event.preventDefault();
    event.stopPropagation();
    const id = playlist.dataset.playlistId;
    expandedPlaylistId = expandedPlaylistId === id ? null : id;
    renderSidebar();
    return;
  }
  const item = event.target.closest('.nav-item[data-path]');
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  app.navMenu?.(item.dataset.path, event.clientX, event.clientY);
}

export function initSidebar() {
  const roots = [
    document.getElementById('quick-nav'),
    document.getElementById('bookmark-list'),
    document.getElementById('playlist-list'),
    document.getElementById('drive-list'),
    document.getElementById('network-list'),
  ];
  roots.forEach((root) => {
    root?.addEventListener('click', onListClick);
    root?.addEventListener('contextmenu', onListContextMenu);
  });

  document.getElementById('settings-btn')?.addEventListener('click', () => app.openSettings?.());
  document.getElementById('add-bookmark')?.addEventListener('click', () => app.bookmarkCurrent?.());
  document.getElementById('add-playlist')?.addEventListener('click', () => app.newPlaylist?.());
  document.getElementById('rescan-network')?.addEventListener('click', () => app.rescanNetwork?.());
  document.getElementById('palette-hint')?.addEventListener('click', () => app.openPalette?.());
  initPlaylistDrop();
}
