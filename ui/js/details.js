import { api, mediaUrl } from './api.js';
import { activeTab } from './state.js';
import { icon } from './icons.js';
import { compactCount, esc, fmtDuration, humanCount } from './util.js';

const MAX_CACHE = 4000;
const MAX_REQUESTS = 3;
const MAX_MEDIA_REQUESTS = 2;
const MEDIA_TIMEOUT = 10000;

const cache = new Map();
const queue = [];
let active = 0;
let mediaActive = 0;
let observer = null;

const MEDIA_MODES = new Set(['audio', 'video']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'tbz']);

function detailMode(entry) {
  if (entry.isDir) return 'counts';
  if (entry.kind === 'image') return 'px';
  if (entry.kind === 'video') return 'video';
  if (entry.kind === 'audio') return 'audio';
  if (entry.kind === 'model') return 'mesh';
  if (entry.kind === 'archive' && ARCHIVE_EXTS.has((entry.ext || '').toLowerCase())) return 'archive';
  return '';
}

function extent(value) {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return String(Math.round(value));
  if (abs >= 1) return String(Number(value.toFixed(2)));
  return String(Number(value.toPrecision(2)));
}

function textDetail(text, title) {
  return { html: `<span class="detail-text">${esc(text)}</span>`, title: title || text };
}

const missing = '<span class="detail-none">—</span>';

function pair(name, value, suffix = '') {
  return `<span class="detail-pair">${icon(name, 11)}${esc(compactCount(value))}${suffix}</span>`;
}

function probeDuration(tag, path) {
  return new Promise((resolve) => {
    const el = document.createElement(tag);
    el.preload = 'metadata';
    el.muted = true;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener('loadedmetadata', onMetadata);
      el.removeEventListener('error', onError);
      el.removeAttribute('src');
      resolve(value);
    };
    const onMetadata = () => {
      if (!Number.isFinite(el.duration) || el.duration <= 0) {
        finish(null);
        return;
      }
      const length = fmtDuration(el.duration);
      if (tag === 'video' && el.videoWidth && el.videoHeight) {
        finish(textDetail(length, `${el.videoWidth} × ${el.videoHeight} · ${length}`));
        return;
      }
      finish(textDetail(length, length));
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), MEDIA_TIMEOUT);
    el.addEventListener('loadedmetadata', onMetadata);
    el.addEventListener('error', onError);
    el.src = mediaUrl(path);
  });
}

async function resolveDetail(job) {
  switch (job.mode) {
    case 'counts': {
      const counts = await api.folderCounts(job.path, job.showHidden);
      return {
        html: pair('folder', counts.folders) + pair('fileText', counts.files),
        title: `${humanCount(counts.folders)} folders · ${humanCount(counts.files)} files`,
      };
    }
    case 'px': {
      const info = await api.fileInfo(job.path);
      const [width, height] = info.dimensions || [];
      if (!width || !height) return null;
      return textDetail(`${humanCount(width)} × ${humanCount(height)}`, `${humanCount(width)} × ${humanCount(height)} px`);
    }
    case 'mesh': {
      const bounds = await api.meshBounds(job.path);
      if (!bounds) return null;
      const text = [bounds.width, bounds.height, bounds.depth].map(extent).join(' × ');
      return textDetail(text, `Bounding box ${text}`);
    }
    case 'archive': {
      const summary = await api.archiveSummary(job.path);
      if (!summary) return null;
      const mark = summary.truncated ? '+' : '';
      return {
        html: pair('fileText', summary.files, mark) + pair('folder', summary.folders, mark),
        title: `${summary.format} · ${summary.kind} · ${humanCount(summary.files)} ${summary.files === 1 ? 'file' : 'files'} · ${humanCount(summary.folders)} ${summary.folders === 1 ? 'folder' : 'folders'}${summary.truncated ? ' · partial scan' : ''}`,
      };
    }
    case 'audio':
    case 'video':
      return probeDuration(job.mode, job.path);
    default:
      return null;
  }
}

function apply(el, detail) {
  if (!el) return;
  if (!detail) {
    el.innerHTML = missing;
    el.removeAttribute('title');
    return;
  }
  el.innerHTML = detail.html;
  if (detail.title) el.title = detail.title;
}

function remember(key, detail) {
  cache.set(key, detail);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function run(job, media) {
  if (media) mediaActive += 1;
  else active += 1;
  resolveDetail(job)
    .then((detail) => {
      remember(job.key, detail);
      if (job.el.isConnected) apply(job.el, detail);
    })
    .catch(() => {
      remember(job.key, null);
    })
    .finally(() => {
      if (media) mediaActive -= 1;
      else active -= 1;
      pump();
    });
}

function pump() {
  while (queue.length) {
    const job = queue[0];
    const media = MEDIA_MODES.has(job.mode);
    if (media ? mediaActive >= MAX_MEDIA_REQUESTS : active >= MAX_REQUESTS) break;
    queue.shift();
    run(job, media);
  }
}

function load(el) {
  if (!el || el.dataset.detailLoaded === '1') return;
  el.dataset.detailLoaded = '1';
  const mode = el.dataset.detail;
  const path = el.dataset.detailPath;
  if (!mode || !path) return;
  const mtime = Number(el.dataset.detailMtime) || 0;
  const showHidden = Boolean(activeTab()?.showHidden);
  const key = `${mode}|${path.toLowerCase()}|${mtime}|${showHidden ? 1 : 0}`;
  if (cache.has(key)) {
    apply(el, cache.get(key));
    return;
  }
  queue.push({ key, mode, path, showHidden, el });
  pump();
}

export function detailCellHtml(entry) {
  const mode = detailMode(entry);
  if (!mode) return '<div class="cell-detail"><span class="detail-none">—</span></div>';
  return `<div class="cell-detail" data-detail="${mode}" data-detail-path="${esc(entry.path)}" data-detail-mtime="${entry.modified || 0}"></div>`;
}

export function observeDetails() {
  if (observer) observer.disconnect();
  const scroll = document.getElementById('files-scroll');
  if (!scroll) return;
  const targets = scroll.querySelectorAll('.cell-detail[data-detail]');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) {
    targets.forEach(load);
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        load(entry.target);
      }
    },
    { root: scroll, rootMargin: '240px 0px' }
  );
  targets.forEach((target) => observer.observe(target));
}
