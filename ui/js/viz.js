import { api, listen } from './api.js';
import { state, activeTab, app } from './state.js';
import { icon, kindIcon } from './icons.js';
import {
  esc,
  humanSize,
  humanCount,
  percent,
  basename,
  kindLabel,
  kindColor,
  themeColor,
} from './util.js';
import { showMenu } from './dialogs.js';
import { systemMenuItem } from './systemmenu.js';

const MAX_CACHED_SCANS = 6;
const DIR_PALETTE = ['#2dd4bf', '#60a5fa', '#a78bfa', '#f472b6', '#fbbf24', '#4ade80', '#fb923c'];
const EXT_GROUPS = {
  image: 'png jpg jpeg gif webp bmp ico svg avif tif tiff heic',
  video: 'mp4 mkv mov avi webm m4v wmv flv mpg mpeg ts',
  audio: 'mp3 wav flac ogg m4a aac wma opus',
  code: 'rs js mjs cjs ts tsx jsx py go java c h cpp hpp cc cs php rb swift kt kts lua sh bash ps1 html css scss less json jsonc yaml yml toml xml sql vue svelte astro',
  doc: 'pdf doc docx xls xlsx ppt pptx txt md markdown rtf odt csv tsv',
  archive: 'zip rar 7z tar gz bz2 xz iso cab',
  exe: 'exe msi dll bat cmd appimage deb rpm lnk',
  font: 'ttf otf woff woff2 eot',
};
const EXT_KIND = new Map();
for (const [kind, list] of Object.entries(EXT_GROUPS)) {
  for (const ext of list.split(' ')) EXT_KIND.set(ext, kind);
}

let rects = [];
let hoverPath = null;
let paintFrame = 0;
let observer = null;

function pathKey(path) {
  if (!path) return '';
  const stripped = path.replace(/[\\/]+$/, '');
  return (stripped || path).toLowerCase();
}

function samePath(a, b) {
  return pathKey(a) === pathKey(b);
}

function withinPath(path, dir) {
  const target = pathKey(path);
  const base = pathKey(dir);
  if (!base) return true;
  return target === base || target.startsWith(`${base}\\`) || target.startsWith(`${base}/`);
}

function isSynthetic(node) {
  return Boolean(node) && node.kind === 'other' && node.name.endsWith(' more items');
}

function hash(text) {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
}

function toRgba(hex, alpha) {
  const value = (hex || '#94a3b8').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const r = parseInt(full.slice(0, 2), 16) || 148;
  const g = parseInt(full.slice(2, 4), 16) || 163;
  const b = parseInt(full.slice(4, 6), 16) || 184;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function colorFor(node) {
  if (node.kind === 'other') return '#64748b';
  if (node.isDir) return DIR_PALETTE[hash(node.name) % DIR_PALETTE.length];
  return kindColor(node.kind);
}

function kindForExt(ext) {
  return EXT_KIND.get((ext || '').toLowerCase()) || 'file';
}

function findNode(root, path) {
  if (!root) return null;
  if (samePath(root.path, path)) return root;
  for (const child of root.children || []) {
    if (samePath(child.path, root.path)) continue;
    if (samePath(child.path, path)) return child;
    if (child.isDir) {
      const found = findNode(child, path);
      if (found) return found;
    }
  }
  return null;
}

function pathChain(root, target) {
  const chain = [];
  const visit = (node) => {
    chain.push(node);
    if (samePath(node.path, target)) return true;
    for (const child of node.children || []) {
      if (!child.isDir) continue;
      if (samePath(child.path, node.path)) continue;
      if (visit(child)) return true;
    }
    chain.pop();
    return false;
  };
  if (visit(root)) return chain;
  return [root];
}

function focusNode() {
  const result = state.viz.result;
  if (!result) return null;
  return findNode(result.root, state.viz.focusPath) || result.root;
}

function selectedNode() {
  const result = state.viz.result;
  if (!result || !state.viz.selectedPath) return null;
  const node = findNode(result.root, state.viz.selectedPath);
  return node && !isSynthetic(node) ? node : null;
}

function cacheResult(key, result) {
  state.viz.cache.set(key, result);
  while (state.viz.cache.size > MAX_CACHED_SCANS) {
    const oldest = state.viz.cache.keys().next().value;
    if (oldest === undefined) break;
    state.viz.cache.delete(oldest);
  }
}

export function ensureViz() {
  const tab = activeTab();
  if (!tab) return;
  const key = `${pathKey(tab.path)}|${tab.showHidden ? '1' : '0'}|${state.vizDepth}`;
  if (state.viz.key === key && state.viz.loading) {
    renderViz();
    return;
  }
  if (state.viz.result && state.viz.key === key && !state.viz.error) {
    renderViz();
    return;
  }
  loadViz(false);
}

export async function loadViz(force = false) {
  const tab = activeTab();
  if (!tab) return;
  const path = tab.path;
  const includeHidden = tab.showHidden;
  const key = `${pathKey(path)}|${includeHidden ? '1' : '0'}|${state.vizDepth}`;

  state.viz.key = key;
  state.viz.scanPath = path;
  state.viz.selectedPath = null;

  if (!force && state.viz.cache.has(key)) {
    const cached = state.viz.cache.get(key);
    state.viz.result = cached;
    state.viz.loading = false;
    state.viz.error = null;
    state.viz.progress = null;
    state.viz.focusPath = cached.path;
    renderViz();
    return;
  }

  const token = ++state.viz.requestToken;
  state.viz.result = null;
  state.viz.loading = true;
  state.viz.error = null;
  state.viz.progress = { scanned: 0, bytes: 0, current: path };
  state.viz.focusPath = path;
  renderViz();

  try {
    const result = await api.vizScan(path, includeHidden, state.vizDepth);
    if (token !== state.viz.requestToken) return;
    cacheResult(key, result);
    state.viz.result = result;
    state.viz.loading = false;
    state.viz.progress = null;
    state.viz.error = null;
    state.viz.focusPath = result.path;
    renderViz();
  } catch (error) {
    if (token !== state.viz.requestToken) return;
    const message = String(error);
    state.viz.loading = false;
    state.viz.progress = null;
    if (message.includes('cancelled')) {
      state.viz.error = null;
      renderViz();
    } else {
      state.viz.error = message;
      renderViz();
    }
  }
}

function headerHtml(path) {
  const result = state.viz.result;
  const focus = focusNode();
  const tab = activeTab();
  const hidden = Boolean(tab?.showHidden);
  const title = result ? basename(result.path) || result.path : basename(path) || path;
  let crumbs = '';
  if (result && focus) {
    const chain = pathChain(result.root, focus.path);
    crumbs = chain
      .map(
        (node, index) =>
          `<button class="viz-crumb${index === chain.length - 1 ? ' current' : ''}" type="button" data-viz-path="${esc(node.path)}" title="${esc(node.path)}">${esc(node.name)}</button>${index < chain.length - 1 ? `<span class="crumb-sep">${icon('chevronRight', 9)}</span>` : ''}`
      )
      .join('');
  } else {
    crumbs = `<span class="viz-crumb current">${esc(path)}</span>`;
  }

  return `
    <div class="viz-header">
      <div class="viz-title">
        ${icon('chart', 16)}
        <div class="viz-title-block">
          <h2>${esc(title)}</h2>
          <div class="viz-subpath">${crumbs}</div>
        </div>
      </div>
      <div class="viz-actions">
        <label class="switch">
          <input type="checkbox" id="viz-hidden"${hidden ? ' checked' : ''}>
          <span>Hidden</span>
        </label>
        <button class="icon-btn" type="button" data-action="viz-rescan" title="Rescan folder"${state.viz.loading ? ' disabled' : ''}>${icon('refresh', 15)}</button>
      </div>
    </div>`;
}

function progressHtml(progress) {
  return `
    <div class="viz-progress" id="viz-progress">
      ${icon('loader', 14, 'spin')}
      <span class="progress-text">Scanning ${humanCount(progress?.scanned || 0)} folders · ${humanSize(progress?.bytes || 0)}</span>
      <span class="progress-path">${esc(progress?.current || '')}</span>
      <button class="icon-btn tiny" type="button" data-action="viz-cancel" title="Stop scan">${icon('x', 12)}</button>
    </div>`;
}

function emptyOverlay(title, text, actions = '') {
  return `
    <div class="viz-empty">
      <div class="state-icon">${icon('chart', 24)}</div>
      <div class="state-title">${esc(title)}</div>
      <div class="state-text">${esc(text)}</div>
      ${actions ? `<div class="state-actions">${actions}</div>` : ''}
    </div>`;
}

function errorOverlay(message) {
  return `
    <div class="viz-error">
      <div class="state-icon">${icon('alert', 24)}</div>
      <div class="state-title">Could not scan this folder</div>
      <div class="state-text">${esc(message)}</div>
      <div class="state-actions">
        <button class="btn btn-primary" type="button" data-action="viz-rescan">${icon('refresh', 13)} Try again</button>
      </div>
    </div>`;
}

function overlayHtml() {
  if (state.viz.loading) return progressHtml(state.viz.progress);
  if (state.viz.error) return errorOverlay(state.viz.error);
  if (!state.viz.result) {
    return emptyOverlay('Visualization cancelled', 'The scan was stopped before any data was collected.', '<button class="btn btn-primary" type="button" data-action="viz-rescan">Rescan</button>');
  }
  const focus = focusNode();
  const drawable = (focus?.children || []).some((child) => child.size > 0);
  if (drawable) return '';
  const result = state.viz.result;
  if (result.totalSize === 0) {
    return emptyOverlay(
      'Nothing to visualize',
      'This folder is empty or its contents are not readable.',
      '<button class="btn btn-primary" type="button" data-action="viz-rescan">Rescan</button>'
    );
  }
  const chain = focus ? pathChain(result.root, focus.path) : [];
  const parent = chain.length > 1 ? chain[chain.length - 2] : null;
  const actions = [
    parent
      ? `<button class="btn btn-primary" type="button" data-viz-path="${esc(parent.path)}">${icon('chevronLeft', 13)} Back to ${esc(parent.name)}</button>`
      : '',
    `<button class="btn btn-ghost" type="button" data-action="viz-rescan">${icon('refresh', 13)} Rescan</button>`,
  ].join('');
  return emptyOverlay('No deeper breakdown', 'Files in this folder were counted towards its size but are below the detail depth.', actions);
}

function barRow(name, bytes, total, color, files) {
  const width = total > 0 ? Math.max(1, (bytes / total) * 100) : 0;
  return `
    <div class="bar-row">
      <div class="bar-head">
        <span class="bar-name">${esc(name)}</span>
        <span class="bar-value">${humanSize(bytes)}${files != null ? ` · ${humanCount(files)}` : ''}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%;background:${color}"></div></div>
    </div>`;
}

function statsCard(result, focus) {
  const notes = [];
  if (result.truncated) notes.push('Scan hit the 600k entry limit — sizes are partial.');
  if (result.errors) notes.push(`${humanCount(result.errors)} folders could not be read.`);
  notes.push(`Scanned in ${(result.elapsedMs / 1000).toFixed(result.elapsedMs > 10000 ? 0 : 1)}s${result.includeHidden ? ' · hidden included' : ''}`);

  const rootFocused = !focus || samePath(focus.path, result.path);
  const cells = rootFocused
    ? [
        [humanSize(result.totalSize), 'Total size'],
        [humanCount(result.fileCount), 'Files'],
        [humanCount(result.dirCount), 'Folders'],
        [humanSize(focus?.size || result.totalSize), 'In view'],
      ]
    : [
        [humanSize(focus.size), 'This folder'],
        [humanCount(focus.fileCount), 'Files'],
        [humanCount(focus.dirCount), 'Subfolders'],
        [percent(focus.size, result.totalSize), 'Of scan'],
      ];

  return `
    <div class="insight-card">
      <div class="insight-title">${icon('chart', 12)} Overview</div>
      <div class="stat-grid">
        ${cells
          .map(
            ([value, label]) =>
              `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`
          )
          .join('')}
      </div>
      <div class="insight-note">${notes.map(esc).join('<br>')}</div>
    </div>`;
}

function selectedCard(node, focus) {
  if (!node) {
    return `
      <div class="insight-card">
        <div class="insight-title">${icon('info', 12)} Selected</div>
        <div class="insight-empty">Click a tile to inspect it. Double-click a folder tile to drill in. Scroll and hover for details.</div>
      </div>`;
  }
  const path = esc(node.path);
  const actions = node.isDir
    ? `<button class="mini-btn primary" type="button" data-action="viz-open-folder" data-path="${path}">${icon('folderOpen', 12)} Open</button>
       <button class="mini-btn" type="button" data-action="viz-visualize" data-path="${path}">${icon('chart', 12)} Drill in</button>`
    : `<button class="mini-btn primary" type="button" data-action="viz-open-file" data-path="${path}">${icon('play', 12)} Open</button>`;
  return `
    <div class="insight-card">
      <div class="insight-title">${icon('info', 12)} Selected</div>
      <div class="selected-node">
        <div class="sel-name">${esc(node.name)}</div>
        <div class="sel-path">${esc(node.path)}</div>
        <div class="sel-meta">
          <span class="sel-pill">${esc(node.isDir ? 'Folder' : kindLabel(node.kind))}</span>
          <span class="sel-pill">${humanSize(node.size)}</span>
          <span class="sel-pill">${percent(node.size, focus?.size || 0)} of ${humanSize(focus?.size || 0)}</span>
          ${node.isDir ? `<span class="sel-pill">${humanCount(node.fileCount)} ${node.fileCount === 1 ? 'file' : 'files'}</span>` : ''}
        </div>
        <div class="sel-actions">
          ${actions}
          <button class="mini-btn" type="button" data-action="viz-reveal" data-path="${path}">${icon('external', 12)} Reveal</button>
          <button class="mini-btn" type="button" data-action="viz-copy" data-path="${path}">${icon('copy', 12)} Copy path</button>
        </div>
      </div>
    </div>`;
}

function largestFilesCard(result, focus) {
  const rootFocused = !focus || samePath(focus.path, result.path);
  const all = result.topFiles || [];
  const files = (rootFocused ? all : all.filter((file) => withinPath(file.path, focus.path))).slice(0, 8);
  const title = rootFocused ? 'Largest files' : `Largest in ${focus.name}`;
  if (!files.length) {
    return `
      <div class="insight-card">
        <div class="insight-title">${icon('file', 12)} ${esc(title)}</div>
        <div class="insight-empty">${rootFocused ? 'No files larger than 256 KB were found.' : 'No files larger than 256 KB in this folder.'}</div>
      </div>`;
  }
  const rows = files
    .map(
      (file) => `
        <div class="big-file" data-action="viz-reveal" data-path="${esc(file.path)}" title="Reveal ${esc(file.name)}">
          ${kindIcon(kindForExt(file.ext), 14)}
          <span class="bf-name">${esc(file.name)}</span>
          <span class="bf-size">${humanSize(file.size)}</span>
        </div>`
    )
    .join('');
  return `
    <div class="insight-card">
      <div class="insight-title">${icon('file', 12)} ${esc(title)}</div>
      ${rows}
    </div>`;
}

function contentsCard(focus) {
  const items = (focus.children || [])
    .filter((child) => child.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, 8);
  if (!items.length) {
    return `
      <div class="insight-card">
        <div class="insight-title">${icon('layers', 12)} Contents</div>
        <div class="insight-empty">No child items were recorded at this depth.</div>
      </div>`;
  }
  const rows = items
    .map((child) => barRow(`${child.name}${child.isDir ? '/' : ''}`, child.size, focus.size, colorFor(child), null))
    .join('');
  return `
    <div class="insight-card">
      <div class="insight-title">${icon('layers', 12)} Contents</div>
      ${rows}
    </div>`;
}

function extensionsCard(result) {
  const stats = (result.extStats || []).slice(0, 8);
  if (!stats.length) {
    return `
      <div class="insight-card">
        <div class="insight-title">${icon('layers', 12)} By extension</div>
        <div class="insight-empty">No file extensions were recorded.</div>
      </div>`;
  }
  const rows = stats
    .map((stat) => {
      const kind = kindForExt(stat.ext);
      const name = stat.ext ? `.${stat.ext}` : '(no extension)';
      return barRow(name, stat.bytes, result.totalSize, kindColor(kind), stat.files);
    })
    .join('');
  return `
    <div class="insight-card">
      <div class="insight-title">${icon('layers', 12)} By extension</div>
      ${rows}
    </div>`;
}

function insightsHtml() {
  const result = state.viz.result;
  if (!result) {
    return `
      <div class="insight-card">
        <div class="insight-title">${icon('sparkles', 12)} Insights</div>
        <div class="insight-empty">Insights appear after the folder is scanned.</div>
      </div>`;
  }
  const focus = focusNode();
  const rootFocused = !focus || samePath(focus.path, result.path);
  const scopeCard = rootFocused ? extensionsCard(result) : contentsCard(focus);
  return statsCard(result, focus) + selectedCard(selectedNode(), focus) + largestFilesCard(result, focus) + scopeCard;
}

function shellHtml(path) {
  return `
    <div class="viz-body">
      <div class="viz-canvas-wrap">
        <canvas class="viz-canvas"></canvas>
        ${overlayHtml()}
        <div class="viz-tooltip" id="viz-tooltip" hidden></div>
        <div class="viz-legend" id="viz-legend" hidden></div>
      </div>
      <aside class="viz-insights">${insightsHtml()}</aside>
    </div>`;
}

export function renderViz() {
  const pane = document.getElementById('viz-pane');
  if (!pane) return;
  const tab = activeTab();
  const path = state.viz.result?.path || state.viz.scanPath || tab?.path || '';
  pane.innerHTML = headerHtml(path) + shellHtml(path);

  if (observer) observer.disconnect();
  const wrap = pane.querySelector('.viz-canvas-wrap');
  if (wrap && 'ResizeObserver' in window) {
    observer = new ResizeObserver(() => schedulePaint());
    observer.observe(wrap);
  }
  const canvas = pane.querySelector('.viz-canvas');
  canvas?.addEventListener('pointerleave', onPointerLeave);
  schedulePaint();
  updateProgressDom();
}

function refreshInsights() {
  const aside = document.querySelector('#viz-pane .viz-insights');
  if (aside) aside.innerHTML = insightsHtml();
}

function worstRow(values, start, end, sum, side) {
  if (end <= start || sum <= 0) return Infinity;
  let max = 0;
  let min = Infinity;
  for (let i = start; i < end; i += 1) {
    if (values[i] > max) max = values[i];
    if (values[i] < min) min = values[i];
  }
  if (min <= 0) min = 0.0001;
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * max) / s2, s2 / (side2 * min));
}

function layoutTreemap(items, x, y, width, height, out) {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (!items.length || total <= 0 || width <= 2 || height <= 2) return;
  const scale = (width * height) / total;
  const values = items.map((item) => Math.max(1, item.size * scale));

  let rx = x;
  let ry = y;
  let rw = width;
  let rh = height;
  let index = 0;

  while (index < items.length && rw > 1 && rh > 1) {
    const side = Math.min(rw, rh);
    let end = index + 1;
    let sum = values[index];
    let worst = worstRow(values, index, end, sum, side);

    while (end < items.length) {
      const nextSum = sum + values[end];
      const nextWorst = worstRow(values, index, end + 1, nextSum, side);
      if (nextWorst > worst) break;
      sum = nextSum;
      end += 1;
      worst = nextWorst;
    }

    if (rw >= rh) {
      const columnWidth = sum / rh;
      let cy = ry;
      for (let i = index; i < end; i += 1) {
        const itemHeight = columnWidth > 0 ? values[i] / columnWidth : 0;
        out.push({ node: items[i], x: rx, y: cy, w: columnWidth, h: itemHeight });
        cy += itemHeight;
      }
      rx += columnWidth;
      rw -= columnWidth;
    } else {
      const rowHeight = sum / rw;
      let cx = rx;
      for (let i = index; i < end; i += 1) {
        const itemWidth = rowHeight > 0 ? values[i] / rowHeight : 0;
        out.push({ node: items[i], x: cx, y: ry, w: itemWidth, h: rowHeight });
        cx += itemWidth;
      }
      ry += rowHeight;
      rh -= rowHeight;
    }
    index = end;
  }
}

function drawFolderGlyph(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 12, size / 12);
  ctx.beginPath();
  ctx.moveTo(0.8, 2.4);
  ctx.lineTo(4.2, 2.4);
  ctx.lineTo(5.6, 4);
  ctx.lineTo(11.2, 4);
  ctx.lineTo(11.2, 10.8);
  ctx.quadraticCurveTo(11.2, 11.4, 10.6, 11.4);
  ctx.lineTo(1.4, 11.4);
  ctx.quadraticCurveTo(0.8, 11.4, 0.8, 10.8);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

const NESTED_CHILD_LIMIT = 80;

function drawFolderContents(ctx, node, x, y, w, h, hovered) {
  const header = 19;
  const innerX = x + 2;
  const innerY = y + header;
  const innerW = w - 4;
  const innerH = h - header - 2;
  if (innerW < 8 || innerH < 8) return;

  let children = (node.children || []).filter((child) => child.size > 0);
  if (!children.length) return;
  if (children.length > NESTED_CHILD_LIMIT) {
    const rest = children.slice(NESTED_CHILD_LIMIT - 1);
    const restSize = rest.reduce((sum, child) => sum + child.size, 0);
    children = children.slice(0, NESTED_CHILD_LIMIT - 1);
    if (restSize > 0) {
      children.push({
        name: `+${rest.length} more`,
        size: restSize,
        kind: 'other',
        isDir: false,
        path: `${node.path}\u0000rest`,
      });
    }
  }

  ctx.save();
  ctx.beginPath();
  const radius = Math.min(4, Math.min(w, h) / 3);
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x + 1.2, y + 1.2, Math.max(0, w - 2.4), Math.max(0, h - 2.4), radius);
  } else {
    ctx.rect(x + 1.2, y + 1.2, Math.max(0, w - 2.4), Math.max(0, h - 2.4));
  }
  ctx.clip();

  ctx.fillStyle = 'rgba(3, 6, 10, 0.46)';
  ctx.fillRect(innerX, innerY, innerW, innerH);

  const cells = [];
  layoutTreemap(children, innerX, innerY, innerW, innerH, cells);
  for (const cell of cells) {
    const { node: child, x: cx, y: cy, w: cw, h: ch } = cell;
    if (cw < 1.2 || ch < 1.2) continue;
    const color = colorFor(child);
    const alpha = child.isDir ? (hovered ? 0.62 : 0.5) : hovered ? 0.78 : 0.66;

    ctx.fillStyle = toRgba(color, alpha);
    ctx.fillRect(cx + 0.5, cy + 0.5, Math.max(0, cw - 1), Math.max(0, ch - 1));
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(3, 6, 10, 0.6)';
    ctx.strokeRect(cx + 0.5, cy + 0.5, Math.max(0, cw - 1), Math.max(0, ch - 1));

    if (cw > 30 && ch > 12) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx + 1, cy + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
      ctx.clip();
      ctx.font = '500 9px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(242, 249, 255, 0.92)';
      ctx.textBaseline = 'top';
      ctx.fillText(fitText(ctx, child.name, cw - 7), cx + 3, cy + 2);
      ctx.restore();
    }
  }

  if (hovered) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(x + 1.2, y + 1.2, Math.max(0, w - 2.4), Math.max(0, h - 2.4));
  }
  ctx.restore();
}

function fitText(ctx, text, maxWidth) {
  if (maxWidth <= 6) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${text.slice(0, low)}…` : '';
}

function paint() {
  const canvas = document.querySelector('#viz-pane .viz-canvas');
  if (!canvas) return;
  const focus = focusNode();
  const children = (focus?.children || []).filter((child) => child.size > 0);

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth < 4 || cssHeight < 4) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  rects = [];
  const pad = 2;
  layoutTreemap(children, pad, pad, Math.max(0, cssWidth - pad * 2), Math.max(0, cssHeight - pad * 2), rects);

  for (const rect of rects) {
    const { node, x, y, w, h } = rect;
    if (w <= 0.8 || h <= 0.8) continue;
    const color = colorFor(node);
    const hovered = hoverPath === node.path;
    const selected = state.viz.selectedPath === node.path && !isSynthetic(node);
    const baseAlpha = node.isDir ? 0.34 : 0.52;

    const trace = () => {
      ctx.beginPath();
      const radius = Math.min(4, Math.min(w, h) / 3);
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x + 1.2, y + 1.2, Math.max(0, w - 2.4), Math.max(0, h - 2.4), radius);
      } else {
        ctx.rect(x + 1.2, y + 1.2, Math.max(0, w - 2.4), Math.max(0, h - 2.4));
      }
    };
    trace();
    ctx.fillStyle = toRgba(color, hovered ? baseAlpha + 0.2 : selected ? baseAlpha + 0.12 : baseAlpha);
    ctx.fill();

    const folderBlock = node.isDir && !isSynthetic(node);
    const hasChildren = folderBlock && (node.children || []).some((child) => child.size > 0);
    const showContents = hasChildren && w >= 60 && h >= 54;
    if (showContents) drawFolderContents(ctx, node, x, y, w, h, hovered);

    trace();
    ctx.lineWidth = selected ? 2 : hovered ? 1.4 : 1;
    ctx.strokeStyle = selected
      ? themeColor(0.95)
      : hovered
        ? 'rgba(255, 255, 255, 0.6)'
        : toRgba(color, 0.42);
    ctx.stroke();

    if (folderBlock && w >= 20 && h >= 18) {
      drawFolderGlyph(ctx, x + 5, y + 5, w > 44 && h > 20 ? 11 : 9, 'rgba(246, 251, 255, 0.88)');
    }

    if (w > 44 && h > 20) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 3, y + 3, Math.max(0, w - 6), Math.max(0, h - 6));
      ctx.clip();
      const labelX = x + 6 + (folderBlock ? 15 : 0);
      const label = fitText(ctx, node.name, x + w - 6 - labelX);
      if (label) {
        ctx.font = '600 11px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = hovered ? 'rgba(255, 255, 255, 0.98)' : 'rgba(238, 245, 252, 0.9)';
        ctx.textBaseline = 'top';
        ctx.fillText(label, labelX, y + 6);
        if (!showContents && h > 38 && w > 64) {
          ctx.font = '500 9.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
          ctx.fillStyle = 'rgba(226, 236, 248, 0.62)';
          ctx.fillText(fitText(ctx, humanSize(node.size), w - 12), x + 6, y + 21);
        }
      }
      ctx.restore();
    }
  }

  updateLegend(children);
}

function schedulePaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    paint();
  });
}

function updateLegend(children) {
  const el = document.getElementById('viz-legend');
  if (!el) return;
  const kinds = new Map();
  const addKind = (kind) => {
    if (!kind || kinds.has(kind)) return;
    kinds.set(kind, kindColor(kind));
  };
  for (const child of children) {
    if (child.isDir) {
      addKind('folder');
      for (const nested of child.children || []) {
        if (!nested.isDir) addKind(nested.kind);
      }
    } else {
      addKind(child.kind);
    }
  }
  if (!kinds.size) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = [...kinds.entries()]
    .map(
      ([kind, color]) =>
        `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${esc(kind === 'folder' ? 'Folder' : kindLabel(kind))}</span>`
    )
    .join('');
}

function hitTest(x, y) {
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i];
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return rect;
  }
  return null;
}

function hideTooltip() {
  const tooltip = document.getElementById('viz-tooltip');
  if (tooltip) tooltip.hidden = true;
  const canvas = document.querySelector('#viz-pane .viz-canvas');
  if (canvas) canvas.classList.remove('hovering');
}

function showTooltip(rect, clientX, clientY) {
  const tooltip = document.getElementById('viz-tooltip');
  const wrap = tooltip?.parentElement;
  if (!tooltip || !wrap) return;
  const node = rect.node;
  const focus = focusNode();
  const detail = node.isDir ? 'Folder' : kindLabel(node.kind);
  const share = percent(node.size, focus?.size || 0);
  tooltip.innerHTML = `
    <strong>${esc(node.name)}</strong>
    <div>${esc(detail)} · ${humanSize(node.size)} · ${esc(share)} of ${humanSize(focus?.size || 0)}${node.isDir ? ` · ${humanCount(node.fileCount)} ${node.fileCount === 1 ? 'file' : 'files'}` : ''}</div>
    ${samePath(node.path, focus?.path) ? '' : `<div class="tt-path">${esc(node.path)}</div>`}`;
  tooltip.hidden = false;
  const box = wrap.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = clientX - box.left + 14;
  let top = clientY - box.top + 16;
  left = Math.max(6, Math.min(left, box.width - width - 8));
  top = Math.max(6, Math.min(top, box.height - height - 8));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function onPointerMove(event) {
  const canvas = event.target.closest?.('.viz-canvas');
  if (!canvas || state.viz.loading || state.viz.error) {
    hideTooltip();
    return;
  }
  const box = canvas.getBoundingClientRect();
  const hit = hitTest(event.clientX - box.left, event.clientY - box.top);
  const nextPath = hit ? hit.node.path : null;
  if (nextPath !== hoverPath) {
    hoverPath = nextPath;
    canvas.classList.toggle('hovering', Boolean(hit));
    schedulePaint();
  }
  if (hit) showTooltip(hit, event.clientX, event.clientY);
  else hideTooltip();
}

function onPointerLeave() {
  hoverPath = null;
  hideTooltip();
  schedulePaint();
}

function drillTo(path) {
  if (!path) return;
  state.viz.focusPath = path;
  state.viz.selectedPath = null;
  hoverPath = null;
  renderViz();
}

function onCanvasClick(event) {
  const canvas = event.target.closest?.('.viz-canvas');
  if (!canvas || state.viz.loading || state.viz.error) return;
  const box = canvas.getBoundingClientRect();
  const hit = hitTest(event.clientX - box.left, event.clientY - box.top);
  if (!hit || isSynthetic(hit.node)) {
    if (hit && isSynthetic(hit.node)) return;
    if (!state.viz.selectedPath) return;
    state.viz.selectedPath = null;
    refreshInsights();
    schedulePaint();
    return;
  }
  state.viz.selectedPath = hit.node.path;
  refreshInsights();
  schedulePaint();
}

function onCanvasDoubleClick(event) {
  const canvas = event.target.closest?.('.viz-canvas');
  if (!canvas || state.viz.loading || state.viz.error) return;
  const box = canvas.getBoundingClientRect();
  const hit = hitTest(event.clientX - box.left, event.clientY - box.top);
  if (!hit || !hit.node.isDir || isSynthetic(hit.node)) return;
  if (samePath(hit.node.path, focusNode()?.path)) return;
  drillTo(hit.node.path);
}

function onCanvasContextMenu(event) {
  const canvas = event.target.closest?.('.viz-canvas');
  if (!canvas) return;
  event.preventDefault();
  if (state.viz.loading || state.viz.error) return;
  const box = canvas.getBoundingClientRect();
  const hit = hitTest(event.clientX - box.left, event.clientY - box.top);
  if (!hit) return;
  const node = hit.node;
  showMenu({
    x: event.clientX,
    y: event.clientY,
    items: [
      {
        label: node.isDir ? 'Open folder' : 'Open file',
        icon: node.isDir ? 'folderOpen' : 'play',
        onClick: () => (node.isDir ? app.navigate?.(node.path) : app.openPath?.(node.path)),
      },
      {
        label: 'Visualize this folder',
        icon: 'chart',
        hidden: !node.isDir || isSynthetic(node),
        disabled: isSynthetic(node),
        onClick: () => drillTo(node.path),
      },
      { separator: true },
      { label: 'Reveal in file manager', icon: 'external', onClick: () => app.reveal?.({ path: node.path }) },
      { label: 'Copy path', icon: 'copy', onClick: () => app.copyPath?.([{ path: node.path }]) },
      { separator: true },
      systemMenuItem(node.path, { hidden: isSynthetic(node) || (node.path || '').length === 0 }),
    ],
  });
}

function updateProgressDom() {
  const el = document.getElementById('viz-progress');
  if (!el) return;
  const progress = state.viz.progress;
  if (!progress) return;
  const text = el.querySelector('.progress-text');
  const pathEl = el.querySelector('.progress-path');
  if (text) text.textContent = `Scanning ${humanCount(progress.scanned || 0)} folders · ${humanSize(progress.bytes || 0)}`;
  if (pathEl) pathEl.textContent = progress.current || '';
}

function onVizClick(event) {
  const crumb = event.target.closest('[data-viz-path]');
  if (crumb) {
    drillTo(crumb.dataset.vizPath);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const path = button.dataset.path || '';
  switch (action) {
    case 'viz-rescan':
      loadViz(true);
      break;
    case 'viz-cancel':
      api.cancelScan().catch(() => {});
      break;
    case 'viz-open-folder':
      app.navigate?.(path);
      break;
    case 'viz-open-file':
      app.openPath?.(path);
      break;
    case 'viz-visualize':
      drillTo(path);
      break;
    case 'viz-reveal':
      app.reveal?.({ path });
      break;
    case 'viz-copy':
      app.copyPath?.([{ path }]);
      break;
    default:
      break;
  }
}

function onVizChange(event) {
  if (event.target.id !== 'viz-hidden') return;
  app.setShowHidden?.(event.target.checked);
}

function onProgressEvent(event) {
  const payload = event.payload;
  if (!payload || !state.viz.loading) return;
  if (!samePath(payload.root, state.viz.scanPath)) return;
  state.viz.progress = payload;
  updateProgressDom();
}

export function initViz() {
  const pane = document.getElementById('viz-pane');
  if (!pane) return;
  pane.addEventListener('click', onVizClick);
  pane.addEventListener('change', onVizChange);
  pane.addEventListener('pointermove', onPointerMove);
  pane.addEventListener('click', onCanvasClick);
  pane.addEventListener('dblclick', onCanvasDoubleClick);
  pane.addEventListener('contextmenu', onCanvasContextMenu);
  listen('viz:progress', onProgressEvent).catch(() => {});
}
