const tauri = globalThis.__TAURI__;
const IS_WINDOWS = /Windows/i.test(navigator.userAgent);

export function mediaUrl(path) {
  const encoded = encodeURIComponent(path || '');
  return IS_WINDOWS
    ? `http://media.localhost/${encoded}`
    : `media://localhost/${encoded}`;
}

export function fontUrl(path, mtime = 0) {
  const encoded = encodeURIComponent(path || '');
  const base = IS_WINDOWS ? `http://font.localhost/${encoded}` : `font://localhost/${encoded}`;
  return mtime ? `${base}?m=${mtime}` : base;
}

function invoke(cmd, args) {
  if (!tauri?.core?.invoke) {
    return Promise.reject(new Error('Tauri bridge unavailable'));
  }
  return tauri.core.invoke(cmd, args);
}

export const api = {
  appInfo: () => invoke('app_info'),
  listPlaces: () => invoke('list_places'),
  listDir: (path, showHidden) => invoke('list_dir', { path, showHidden }),
  folderCounts: (path, showHidden) => invoke('folder_counts', { path, showHidden }),
  folderSize: (path, showHidden) => invoke('folder_size', { path, showHidden }),
  openPath: (path) => invoke('open_path', { path }),
  revealPath: (path) => invoke('reveal_path', { path }),
  shellMenuItems: (path) => invoke('shell_menu_items', { path }),
  shellMenuInvoke: (path, id) => invoke('shell_menu_invoke', { path, id }),
  copyText: (text) => invoke('copy_text', { text }),
  fileInfo: (path) => invoke('file_info', { path }),
  textPreview: (path, maxBytes) => invoke('text_preview', { path, maxBytes }),
  copyPaths: (sources, destDir, cut) => invoke('copy_paths', { sources, destDir, cut }),
  deletePaths: (items) => invoke('delete_paths', { items }),
  createFolder: (parent, name) => invoke('create_folder', { parent, name }),
  renamePath: (path, newName) => invoke('rename_path', { path, newName }),
  watchDirectory: (path) => invoke('watch_directory', { path }),
  thumbnail: (path, size, force = false) => invoke('thumbnail', { path, size, force }),
  cacheStats: () => invoke('thumbnail_cache_stats'),
  clearCache: () => invoke('clear_thumbnail_cache'),
  vizScan: (path, includeHidden, maxDepth) => invoke('viz_scan', { path, includeHidden, maxDepth }),
  cancelScan: () => invoke('cancel_scan'),
  searchFiles: (path, query, limit, includeHidden) =>
    invoke('search_files', { path, query, limit, includeHidden }),
  loadSettings: () => invoke('load_settings'),
  saveSettings: (settings) => invoke('save_settings', { settings }),
};

export function listen(event, handler) {
  if (!tauri?.event?.listen) {
    return Promise.resolve(() => {});
  }
  return tauri.event.listen(event, handler);
}
