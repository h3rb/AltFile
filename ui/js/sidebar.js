import { state, activeTab, app, scheduleSave } from './state.js';
import { esc, basename, humanSize, uid } from './util.js';
import { icon } from './icons.js';
import { toast } from './dialogs.js';

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

function navItem({ path, name, meta = '', iconName = 'folder', active = false, removable = false, bookmarkId = '', meter = null }) {
  return `
    <div class="drive-wrap">
      <button class="nav-item${active ? ' active' : ''}" type="button" data-path="${esc(path)}" title="${esc(path)}">
        ${icon(iconName, 15)}
        <span class="nav-name">${esc(name)}</span>
        ${meta ? `<span class="nav-meta">${esc(meta)}</span>` : ''}
        ${removable ? `<span class="nav-remove" role="button" tabindex="0" data-bookmark="${esc(bookmarkId)}" title="Remove bookmark">${icon('x', 11)}</span>` : ''}
      </button>
      ${meter !== null ? `<div class="drive-meter"><span style="width:${Math.max(0, Math.min(100, meter))}%"></span></div>` : ''}
    </div>`;
}

export function renderSidebar() {
  const quick = document.getElementById('quick-nav');
  const bookmarkList = document.getElementById('bookmark-list');
  const driveList = document.getElementById('drive-list');
  const settingsBtn = document.getElementById('settings-btn');
  const addBtn = document.getElementById('add-bookmark');
  const badge = document.getElementById('portable-badge');
  if (!quick || !bookmarkList || !driveList) return;

  const current = activePath();
  const places = state.places || [];
  const quickPlaces = places.filter((place) => place.kind === 'quick');
  const drives = places.filter((place) => place.kind === 'drive');

  if (settingsBtn) settingsBtn.innerHTML = `${icon('settings', 15)}<span>Settings</span>`;
  if (addBtn) addBtn.innerHTML = icon('plus', 13);

  if (badge) {
    badge.hidden = !state.app?.portable;
    badge.title = state.app?.portable ? `Portable data: ${state.app.dataDir}` : '';
  }

  quick.innerHTML = `
    <div class="nav-heading"><span>Quick access</span></div>
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
}

export function addBookmark(path, name) {
  if (!path) return;
  if (state.bookmarks.some((bookmark) => samePath(bookmark.path, path))) {
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
  const item = event.target.closest('.nav-item[data-path]');
  if (!item) return;
  app.navigate?.(item.dataset.path);
}

export function initSidebar() {
  const roots = [document.getElementById('quick-nav'), document.getElementById('bookmark-list'), document.getElementById('drive-list')];
  roots.forEach((root) => root?.addEventListener('click', onListClick));

  document.getElementById('settings-btn')?.addEventListener('click', () => app.openSettings?.());
  document.getElementById('add-bookmark')?.addEventListener('click', () => app.bookmarkCurrent?.());
  document.getElementById('palette-hint')?.addEventListener('click', () => app.openPalette?.());
}
