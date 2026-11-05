import { api } from './api.js';
import { applyThemeHue, basename, clamp, DEFAULT_HUE, uid } from './util.js';

export const state = {
  app: null,
  places: [],
  network: null,
  tabs: [],
  activeId: null,
  listing: null,
  error: null,
  loading: false,
  loadToken: 0,
  visibleEntries: [],
  selection: new Set(),
  anchorIndex: null,
  focusIndex: 0,
  searchResults: null,
  searching: false,
  searchToken: 0,
  bookmarks: [],
  recent: [],
  thumbSize: 176,
  vizDepth: 64,
  searchRecursive: false,
  modelSpin: true,
  themeHue: DEFAULT_HUE,
  clipboard: { paths: [], cut: false },
  preview: { open: true, token: 0 },
  media: {
    queue: [],
    index: -1,
    volume: 0.9,
    muted: false,
    playing: false,
  },
  playlists: [],
  viz: {
    cache: new Map(),
    result: null,
    loading: false,
    error: null,
    progress: null,
    requestToken: 0,
    focusPath: null,
    selectedPath: null,
    key: null,
    scanPath: null,
  },
  renderLimit: 1500,
  booted: false,
};

export const app = {};

export function createTab(path, extra = {}) {
  const view = ['grid', 'list', 'viz'].includes(extra.view) ? extra.view : 'grid';
  return {
    id: uid(),
    path,
    history: [path],
    index: 0,
    view,
    sort: extra.sort || { key: 'name', dir: 1 },
    filter: extra.filter || 'all',
    query: '',
    showHidden: Boolean(extra.showHidden),
    scrollTop: 0,
  };
}

export function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeId) || null;
}

export function addRecent(path) {
  if (!path) return;
  const lower = path.toLowerCase();
  state.recent = [path, ...state.recent.filter((p) => p.toLowerCase() !== lower)].slice(0, 14);
}

const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'm4a', 'aac', 'wma', 'opus', 'mid', 'midi', 'aiff']);
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'm2ts', 'ogv']);

export function mediaKindOf(path, kind) {
  if (kind === 'audio' || kind === 'video') return kind;
  const ext = basename(path).split('.').pop().toLowerCase();
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

function normalizeMediaItem(item) {
  if (!item || typeof item.path !== 'string' || !item.path) return null;
  const kind = mediaKindOf(item.path, item.kind);
  if (!kind) return null;
  return {
    path: item.path,
    name: typeof item.name === 'string' && item.name ? item.name : basename(item.path),
    kind,
  };
}

function restoreMedia(saved) {
  if (Array.isArray(saved.mediaQueue)) {
    state.media.queue = saved.mediaQueue.slice(0, 500).map(normalizeMediaItem).filter(Boolean);
  }
  if (Number.isFinite(saved.mediaIndex)) {
    state.media.index = clamp(Math.round(saved.mediaIndex), -1, state.media.queue.length - 1);
  }
  if (Number.isFinite(saved.mediaVolume)) {
    state.media.volume = clamp(saved.mediaVolume, 0, 1);
  }
  state.media.muted = saved.mediaMuted === true;
}

function normalizeSort(sort) {
  const keys = new Set(['name', 'size', 'modified', 'kind']);
  if (!sort || typeof sort !== 'object') return { key: 'name', dir: 1 };
  return {
    key: keys.has(sort.key) ? sort.key : 'name',
    dir: Number(sort.dir) < 0 ? -1 : 1,
  };
}

export async function loadSession() {
  let saved = null;
  try {
    saved = await api.loadSettings();
  } catch {
    saved = null;
  }
  if (saved && typeof saved === 'object') {
    if (Array.isArray(saved.bookmarks)) {
      state.bookmarks = saved.bookmarks
        .filter((b) => b && typeof b.path === 'string' && b.path)
        .map((b) => ({ id: b.id || uid(), name: String(b.name || b.path), path: b.path }));
    }
    if (Array.isArray(saved.recent)) {
      state.recent = saved.recent.filter((p) => typeof p === 'string' && p).slice(0, 14);
    }
    if (Number.isFinite(saved.thumbSize)) {
      state.thumbSize = clamp(saved.thumbSize, 120, 260);
    }
    if (Number.isFinite(saved.vizDepth)) {
      state.vizDepth = clamp(Math.round(saved.vizDepth), 1, 255);
    }
    state.preview.open = saved.previewOpen !== false;
    state.searchRecursive = saved.searchRecursive === true;
    state.modelSpin = saved.modelSpin !== false;
    if (Number.isFinite(saved.themeHue)) {
      state.themeHue = ((saved.themeHue % 360) + 360) % 360;
    }
    restoreMedia(saved);

    if (Array.isArray(saved.playlists)) {
      const names = new Set();
      for (const savedPlaylist of saved.playlists.slice(0, 40)) {
        if (!savedPlaylist || typeof savedPlaylist.name !== 'string') continue;
        const name = savedPlaylist.name.trim().slice(0, 80);
        if (!name || names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        state.playlists.push({
          id: typeof savedPlaylist.id === 'string' && savedPlaylist.id ? savedPlaylist.id : uid(),
          name,
          items: Array.isArray(savedPlaylist.items)
            ? savedPlaylist.items.slice(0, 500).map(normalizeMediaItem).filter(Boolean)
            : [],
          updatedAt: Number.isFinite(savedPlaylist.updatedAt) ? savedPlaylist.updatedAt : 0,
        });
      }
    }

    if (Array.isArray(saved.tabs)) {
      for (const savedTab of saved.tabs) {
        if (!savedTab || typeof savedTab.path !== 'string' || !savedTab.path) continue;
        state.tabs.push(
          createTab(savedTab.path, {
            view: savedTab.view,
            sort: normalizeSort(savedTab.sort),
            filter: typeof savedTab.filter === 'string' ? savedTab.filter : 'all',
            showHidden: Boolean(savedTab.showHidden),
          })
        );
      }
    }
    const index = clamp(Number(saved.activeIndex) || 0, 0, Math.max(0, state.tabs.length - 1));
    state.activeId = state.tabs[index]?.id || null;
  }

  if (!state.tabs.length) {
    const tab = createTab(state.app?.home || '/');
    state.tabs = [tab];
    state.activeId = tab.id;
  }

  applyThemeHue(state.themeHue);
}

export function captureSession() {
  return {
    version: 1,
    tabs: state.tabs.map((tab) => ({
      path: tab.path,
      view: tab.view,
      sort: tab.sort,
      filter: tab.filter,
      showHidden: tab.showHidden,
    })),
    activeIndex: Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId)),
    bookmarks: state.bookmarks,
    recent: state.recent,
    thumbSize: state.thumbSize,
    vizDepth: state.vizDepth,
    searchRecursive: state.searchRecursive,
    modelSpin: state.modelSpin,
    themeHue: state.themeHue,
    previewOpen: state.preview.open,
    mediaQueue: state.media.queue
      .slice(0, 200)
      .map((item) => ({ path: item.path, name: item.name, kind: item.kind })),
    mediaIndex: state.media.index,
    mediaVolume: state.media.volume,
    mediaMuted: state.media.muted,
    playlists: state.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      updatedAt: playlist.updatedAt,
      items: playlist.items.map((item) => ({ path: item.path, name: item.name, kind: item.kind })),
    })),
  };
}

let saveTimer = 0;
let saving = false;
let saveAgain = false;

export async function saveSessionNow() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    await api.saveSettings(captureSession());
  } catch {
    // Settings persistence is best-effort; never interrupt browsing.
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      saveSessionNow();
    }
  }
}

export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSessionNow, 600);
}
