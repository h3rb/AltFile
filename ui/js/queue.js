import { queueItems, clearFinishedOps, onQueueChange } from './ops.js';
import { activeTab } from './state.js';
import { icon } from './icons.js';
import { esc, humanCount } from './util.js';

const KIND_META = {
  copy: { icon: 'copy', label: 'Copy' },
  move: { icon: 'cut', label: 'Move' },
  extract: { icon: 'archive', label: 'Extract' },
  delete: { icon: 'trash', label: 'Delete' },
};

const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
};

function timeLabel(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function progressHtml(item) {
  if (item.status === 'queued') {
    return `<div class="op-progress"><span class="op-count">Waiting</span></div>`;
  }
  if (item.status === 'done' || item.status === 'error') return '';
  if (item.total > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((item.done / item.total) * 100)));
    return `<div class="op-progress">
      <div class="op-bar"><i style="width:${percent}%"></i></div>
      <span class="op-count">${humanCount(item.done)} / ${humanCount(item.total)}${item.current ? ` · ${esc(item.current)}` : ''}</span>
    </div>`;
  }
  return `<div class="op-progress"><div class="op-bar indeterminate"><i></i></div><span class="op-count">Working…</span></div>`;
}

function rowHtml(item) {
  const meta = KIND_META[item.kind] || KIND_META.copy;
  const status = STATUS_LABEL[item.status] || item.status;
  const when = item.startedAt ? timeLabel(item.startedAt) : '';
  return `
    <article class="op-row status-${item.status}">
      <span class="op-icon">${icon(meta.icon, 16)}</span>
      <div class="op-main">
        <div class="op-title">${esc(item.title)}<span class="op-kind">${meta.label}</span></div>
        ${item.detail ? `<div class="op-detail">${esc(item.detail)}</div>` : ''}
        ${progressHtml(item)}
        ${item.error ? `<div class="op-error">${esc(item.error)}</div>` : ''}
      </div>
      <div class="op-side">
        <span class="op-status">${esc(status)}</span>
        <span class="op-time">${when}</span>
      </div>
    </article>`;
}

export function renderQueue() {
  const root = document.getElementById('queue-pane');
  if (!root) return;
  const items = queueItems();
  const active = items.filter((item) => item.status === 'running').length;
  const queued = items.filter((item) => item.status === 'queued').length;
  const finished = items.filter((item) => item.status === 'done' || item.status === 'error').length;
  if (activeTab()?.kind === 'queue') {
    const count = document.getElementById('status-count');
    const selection = document.getElementById('status-selection');
    const size = document.getElementById('status-size');
    if (count) count.textContent = `${items.length} ${items.length === 1 ? 'operation' : 'operations'}`;
    if (selection) selection.textContent = active ? `${active} running` : queued ? `${queued} queued` : '';
    if (size) size.textContent = '';
  }

  if (!items.length) {
    root.innerHTML = `
      <div class="queue-empty">
        ${icon('clock', 26)}
        <h2>No file operations</h2>
        <p>Long copies, moves, deletes and archive extractions run here in the background. Queue one from any folder and it will show up in this tab.</p>
      </div>`;
    return;
  }

  const summary = [
    active ? `${active} running` : '',
    queued ? `${queued} queued` : '',
  ].filter(Boolean).join(' · ') || 'Idle';
  root.innerHTML = `
    <header class="queue-head">
      <div>
        <h2>File operations</h2>
        <p>${summary}${finished ? ` · ${finished} finished` : ''}</p>
      </div>
      <button class="mini-btn" type="button" data-queue-clear${finished ? '' : ' disabled'}>${icon('trash', 12)} Clear finished</button>
    </header>
    <div class="queue-list">${items.map(rowHtml).join('')}</div>`;
}

export function initQueue() {
  onQueueChange(renderQueue);
  document.getElementById('queue-pane')?.addEventListener('click', (event) => {
    if (event.target.closest('[data-queue-clear]')) clearFinishedOps();
  });
  renderQueue();
}
