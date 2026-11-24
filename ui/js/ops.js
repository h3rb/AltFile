import { api, listen } from './api.js';
import { state, app, activeTab } from './state.js';
import {
  selectedEntries,
  focusedEntry,
  refreshFiles,
  selectPath,
} from './files.js';
import { promptDialog, extractDialog, confirmDialog, openModal, toast } from './dialogs.js';
import { esc, basename, dirname, joinPath, humanSize, humanCount, fmtFullDate, entryKindLabel } from './util.js';

function targetEntries(entries) {
  if (entries && entries.length) return entries;
  const selected = selectedEntries();
  if (selected.length) return selected;
  const focused = focusedEntry();
  return focused ? [focused] : [];
}

function samePath(a, b) {
  if (!a || !b) return false;
  const strip = (value) => value.replace(/[\\/]+$/, '').toLowerCase() || value.toLowerCase();
  return strip(a) === strip(b);
}

function multipleLabel(entries) {
  return `${humanCount(entries.length)} ${entries.length === 1 ? 'item' : 'items'}`;
}

const queue = [];
const queueListeners = new Set();
let queueSeq = 0;
let queueRunning = false;
let queueActive = null;

export function queueItems() {
  return queue;
}

export function onQueueChange(listener) {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

function emitQueue() {
  for (const listener of queueListeners) {
    try {
      listener();
    } catch {
      /* a queue view must not break the operation */
    }
  }
}

export function clearFinishedOps() {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].status === 'done' || queue[i].status === 'error') queue.splice(i, 1);
  }
  emitQueue();
}

function enqueue(spec) {
  const item = {
    id: ++queueSeq,
    done: 0,
    total: spec.total || 0,
    current: '',
    error: '',
    startedAt: 0,
    finishedAt: 0,
    ...spec,
    status: 'queued',
  };
  queue.push(item);
  emitQueue();
  app.openQueueTab?.({ activate: false });
  pumpQueue();
  return item;
}

async function pumpQueue() {
  if (queueRunning) return;
  const next = queue.find((item) => item.status === 'queued');
  if (!next) return;
  queueRunning = true;
  queueActive = next;
  next.status = 'running';
  next.startedAt = Date.now();
  emitQueue();
  try {
    await next.run(next);
    next.status = 'done';
  } catch (error) {
    next.status = 'error';
    next.error = String(error?.message || error);
  }
  next.finishedAt = Date.now();
  queueActive = null;
  queueRunning = false;
  emitQueue();
  pumpQueue();
}

export async function newFolder() {
  const tab = activeTab();
  if (!tab) return;
  const name = await promptDialog({
    title: 'New folder',
    label: 'Folder name',
    value: 'New folder',
    confirmLabel: 'Create',
    selectBase: true,
    hint: `Created in ${tab.path}`,
  });
  if (!name) return;
  try {
    const path = await api.createFolder(tab.path, name);
    toast(`Created “${basename(path)}”`, { type: 'success', icon: 'folderPlus' });
    await refreshFiles({ silent: true });
    selectPath(path);
  } catch (error) {
    toast(String(error), { type: 'error' });
  }
}

export async function renameEntry(entry) {
  const list = targetEntries(entry ? [entry] : null);
  if (!list.length) return;
  if (list.length > 1) {
    toast('Select a single item to rename', { type: 'info' });
    return;
  }
  const current = list[0];
  const name = await promptDialog({
    title: 'Rename',
    label: 'New name',
    value: current.name,
    confirmLabel: 'Rename',
    selectBase: !current.isDir,
  });
  if (!name || name === current.name) return;
  try {
    const path = await api.renamePath(current.path, name);
    toast(`Renamed to “${basename(path)}”`, { type: 'success', icon: 'pencil' });
    await refreshFiles({ silent: true });
    selectPath(path);
  } catch (error) {
    toast(String(error), { type: 'error' });
  }
}

export async function removeEntries(entries) {
  const list = targetEntries(entries);
  if (!list.length) return;
  const names = list.slice(0, 8).map((entry) => entry.name).join('\n');
  const detail = list.length > 8 ? `${names}\n…and ${list.length - 8} more` : names;
  const confirmed = await confirmDialog({
    title: 'Move to Trash',
    message: `Move ${multipleLabel(list)} to the Trash?`,
    detail,
    confirmLabel: 'Move to Trash',
    danger: true,
  });
  if (!confirmed) return;
  enqueue({
    kind: 'delete',
    title: `Move ${multipleLabel(list)} to Trash`,
    detail: list.length === 1 ? list[0].path : dirname(list[0].path),
    total: list.length,
    run: async () => {
      const result = await api.deletePaths(list.map((entry) => entry.path));
      toast(`Moved ${humanCount(result.done)} ${result.done === 1 ? 'item' : 'items'} to the Trash`, {
        type: 'success',
        icon: 'trash',
      });
      await refreshFiles({ silent: true });
    },
  });
}

const ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tgz', '.tbz2', '.tbz'];

function archiveStem(name) {
  const lower = name.toLowerCase();
  for (const suffix of ARCHIVE_SUFFIXES) {
    if (lower.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function defaultExtractTarget(entry) {
  return joinPath(dirname(entry.path), archiveStem(entry.name || basename(entry.path)));
}

export async function extractArchive(entry) {
  if (!entry || !entry.path) return;
  const name = entry.name || basename(entry.path);
  const target = await extractDialog({ name, value: defaultExtractTarget(entry) });
  if (!target) return;

  enqueue({
    kind: 'extract',
    title: `Extract “${name}”`,
    detail: target,
    total: 1,
    run: async () => {
      const dest = await api.extractArchive(entry.path, target);
      const tab = activeTab();
      if (tab && samePath(dirname(dest), tab.path)) {
        await refreshFiles({ silent: true });
        selectPath(dest);
      }
      toast(`Extracted to “${basename(dest)}”`, {
        type: 'success',
        icon: 'archive',
        timeout: 6500,
        action: { label: 'Open', onClick: () => app.navigate?.(dest) },
      });
    },
  });
}

export function copySelection(cut = false, entries = null) {
  const list = targetEntries(entries);
  if (!list.length) {
    toast('Nothing selected', { type: 'info' });
    return;
  }
  state.clipboard = { paths: list.map((entry) => entry.path), cut };
  toast(`${cut ? 'Cut' : 'Copied'} ${multipleLabel(list)}`, {
    type: 'info',
    icon: cut ? 'cut' : 'copy',
  });
}

export async function pasteInto(destDir) {
  const tab = activeTab();
  const dest = destDir || state.listing?.path || tab?.path;
  const clip = state.clipboard;
  if (!dest) return;
  if (!clip.paths.length) {
    toast('Clipboard is empty', { type: 'info', icon: 'clipboard' });
    return;
  }

  const sources = clip.cut
    ? clip.paths.filter((path) => !samePath(dirname(path), dest))
    : clip.paths;
  if (!sources.length) {
    toast('Those items are already in this folder', { type: 'info' });
    return;
  }

  const verb = clip.cut ? 'Moving' : 'Copying';
  const pastVerb = clip.cut ? 'Moved' : 'Copied';
  enqueue({
    kind: clip.cut ? 'move' : 'copy',
    title: `${verb} ${multipleLabel(sources)}`,
    detail: dest,
    total: sources.length,
    run: async () => {
      const result = await api.copyPaths(sources, dest, clip.cut);
      if (result.errors && result.errors.length) {
        toast(`${pastVerb} ${humanCount(result.done)}; ${result.errors.length} failed — ${result.errors[0]}`, {
          type: 'warn',
          timeout: 6500,
          icon: 'alert',
        });
      } else {
        toast(`${pastVerb} ${humanCount(result.done)} ${result.done === 1 ? 'item' : 'items'} here`, {
          type: 'success',
          icon: clip.cut ? 'cut' : 'copy',
        });
      }
      if (clip.cut && result.done > 0) state.clipboard = { paths: [], cut: false };
      if (samePath(dest, tab?.path)) await refreshFiles({ silent: true });
    },
  });
}

export function pasteIntoCurrent() {
  const tab = activeTab();
  if (!tab) return;
  return pasteInto(tab.path);
}

export async function copyEntryPaths(entries) {
  const list = targetEntries(entries);
  if (!list.length) return;
  const text = list.map((entry) => entry.path).join('\n');
  try {
    await api.copyText(text);
    toast(list.length === 1 ? 'Path copied' : `Copied ${list.length} paths`, {
      type: 'success',
      icon: 'copy',
    });
  } catch (error) {
    toast(String(error), { type: 'error' });
  }
}

export async function revealEntry(entry) {
  const list = targetEntries(entry ? [entry] : null);
  if (!list.length) return;
  try {
    await api.revealPath(list[0].path);
  } catch (error) {
    toast(String(error), { type: 'error' });
  }
}

export async function showProperties(entry) {
  const list = targetEntries(entry ? [entry] : null);
  if (!list.length) return;
  const target = list[0];
  let info;
  try {
    info = await api.fileInfo(target.path);
  } catch (error) {
    toast(String(error), { type: 'error' });
    return;
  }

  const rows = [
    ['Kind', `${entryKindLabel(info)}${info.ext ? ` (.${info.ext})` : ''}`],
    ['Location', dirname(info.path)],
    ['Size', info.isDir ? (info.entryCount != null ? `${humanCount(info.entryCount)} ${info.entryCount === 1 ? 'item' : 'items'}` : 'Folder') : humanSize(info.size)],
    ['Modified', fmtFullDate(info.modified)],
    ['Created', info.created ? fmtFullDate(info.created) : '—'],
  ];
  if (info.dimensions) rows.push(['Dimensions', `${info.dimensions[0]} × ${info.dimensions[1]} px`]);
  if (info.readonly) rows.push(['Attributes', 'Read-only']);

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="meta-list">
      ${rows
        .map(
          ([key, value]) =>
            `<div class="meta-row"><span class="meta-key">${esc(key)}</span><span class="meta-value${key === 'Location' ? ' mono' : ''}">${esc(value)}</span></div>`
        )
        .join('')}
      <div class="meta-row"><span class="meta-key">Path</span><span class="meta-value mono">${esc(info.path)}</span></div>
    </div>`;

  openModal({
    title: info.name || target.name,
    subtitle: info.isDir ? 'Folder properties' : 'File properties',
    body,
    width: 540,
    actions: [
      {
        label: 'Copy path',
        kind: 'ghost',
        onClick: () => {
          api.copyText(info.path).then(
            () => toast('Path copied', { type: 'success', icon: 'copy' }),
            (error) => toast(String(error), { type: 'error' })
          );
          return false;
        },
      },
      { label: 'Close', kind: 'primary' },
    ],
  });
}

function onProgress(payload) {
  if (!payload || !queueActive) return;
  if (queueActive.kind !== 'copy' && queueActive.kind !== 'move') return;
  queueActive.done = payload.done || 0;
  queueActive.current = payload.current || '';
  emitQueue();
}

export function initOps() {
  listen('op:progress', (event) => onProgress(event.payload)).catch(() => {});
}
