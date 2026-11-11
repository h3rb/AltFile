import { api, mediaUrl, gifUrl } from './api.js';
import { state, app } from './state.js';
import { selectedEntries, focusedEntry, wantsThumb, isGifEntry, archiveSupported, archiveSummaryFor } from './files.js';
import { icon, kindIcon } from './icons.js';
import { playEntry, addToPlaylist, onPlayback, seekPlayback, isLooping, setLoop } from './player.js';
import { fontTileHtml, observeFontTiles } from './fonts.js';
import { wireModelPreview, stopModelPreview, isRotatableModel } from './model.js';
import { loadWave, drawWaveform } from './waveform.js';
import {
  esc,
  basename,
  dirname,
  humanSize,
  humanCount,
  fmtFullDate,
  fmtDuration,
  kindLabel,
  kindColor,
  themeColor,
  isTextEntry,
  clamp,
  debounce,
} from './util.js';

const MEDIA_KINDS = new Set(['audio', 'video']);

let stopPlaybackMirror = null;

function metaRow(key, value, mono = false) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="meta-row"><span class="meta-key">${esc(key)}</span><span class="meta-value${mono ? ' mono' : ''}">${esc(value)}</span></div>`;
}

function metaRowField(key, field, mono = false) {
  return `<div class="meta-row" data-meta-field="${esc(field)}" hidden><span class="meta-key">${esc(key)}</span><span class="meta-value${mono ? ' mono' : ''}"></span></div>`;
}

function setMetaField(root, field, value) {
  const row = root.querySelector(`[data-meta-field="${field}"]`);
  if (!row) return;
  if (value === null || value === undefined || value === '') {
    row.hidden = true;
    return;
  }
  row.querySelector('.meta-value').textContent = String(value);
  row.hidden = false;
}

function kindTile(entry, size = 46) {
  const color = kindColor(entry.kind);
  return `<div class="kind-tile" style="--kind-color:${color};--kind-glow:${themeColor(0.06)};min-height:150px">${kindIcon(entry.kind, size)}</div>`;
}

function actionsHtml(entry, info) {
  const path = esc(entry.path);
  if (info.isDir) {
    return `
      <button class="mini-btn primary" type="button" data-action="open-folder" data-path="${path}">${icon('folderOpen', 13)} Open</button>
      <button class="mini-btn" type="button" data-action="visualize" data-path="${path}">${icon('chart', 13)} Visualize</button>
      <button class="mini-btn" type="button" data-action="reveal" data-path="${path}">${icon('external', 13)} Reveal</button>
      <button class="mini-btn" type="button" data-action="copy-path" data-path="${path}">${icon('copy', 13)} Copy path</button>`;
  }
  if (MEDIA_KINDS.has(info.kind)) {
    const kind = esc(info.kind);
    const looping = isLooping();
    return `
      <button class="mini-btn primary" type="button" data-action="play" data-path="${path}" data-kind="${kind}">${icon('play', 13)} Play</button>
      <button class="mini-btn${looping ? ' active' : ''}" type="button" data-action="loop" aria-pressed="${looping}" title="Loop current file: ${looping ? 'on' : 'off'}">${icon('repeat', 13)} Loop</button>
      <button class="mini-btn" type="button" data-action="playlist-add" data-path="${path}" data-kind="${kind}">${icon('playlist', 13)} Add to playlist</button>
      <button class="mini-btn" type="button" data-action="reveal" data-path="${path}">${icon('external', 13)} Reveal</button>
      <button class="mini-btn" type="button" data-action="copy-path" data-path="${path}">${icon('copy', 13)} Copy path</button>`;
  }
  return `
    <button class="mini-btn primary" type="button" data-action="open" data-path="${path}">${icon('open', 13)} Open</button>
    <button class="mini-btn" type="button" data-action="reveal" data-path="${path}">${icon('external', 13)} Reveal</button>
    <button class="mini-btn" type="button" data-action="copy-path" data-path="${path}">${icon('copy', 13)} Copy path</button>`;
}

function audioMediaHtml(entry, info) {
  return `
    <div class="audio-preview">
      <div class="audio-wave-wrap">
        <canvas class="audio-wave" aria-hidden="true"></canvas>
        <div class="audio-wave-state" data-audio-state>${icon('loader', 13, 'spin')} Reading waveform…</div>
      </div>
      <div class="audio-strip">
        <span class="audio-length" data-audio-length>—</span>
        <span class="audio-format">${esc((info.ext || 'audio').toUpperCase())} · ${esc(kindLabel(info.kind))}</span>
      </div>
    </div>`;
}

function videoMediaHtml(entry, info, thumb) {
  const poster = thumb && thumb.url ? ` poster="${esc(thumb.url)}"` : '';
  return `
    <div class="video-preview" data-video-preview>
      <video class="video-el" src="${esc(mediaUrl(entry.path))}" preload="metadata" muted playsinline${poster}></video>
      <div class="video-strip">
        <span class="video-length" data-video-length>—</span>
        <span class="video-scrub-hint">${icon('waveform', 10)} Hover the timeline to scrub</span>
      </div>
      <div class="video-timeline" data-video-timeline>
        <div class="vtl-fill" data-vtl-fill></div>
        <div class="vtl-knob" data-vtl-knob></div>
        <span class="vtl-bubble" data-vtl-bubble hidden>0:00</span>
      </div>
      <div class="video-note" data-video-note hidden></div>
    </div>`;
}

function archivePreviewHtml(summary) {
  const rows = summary.top
    .map((name) => {
      const dir = name.endsWith('/');
      return `<li class="${dir ? 'is-dir' : ''}">${icon(dir ? 'folder' : 'fileText', 11)}<span>${esc(name)}</span></li>`;
    })
    .join('');
  const parts = [
    `${humanCount(summary.files)} ${summary.files === 1 ? 'file' : 'files'}`,
    `${humanCount(summary.folders)} ${summary.folders === 1 ? 'folder' : 'folders'}`,
  ];
  if (summary.bytes > 0) parts.push(humanSize(summary.bytes));
  return `
    <div class="preview-media archive-preview">
      <div class="archive-prev-head">
        <span class="archive-prev-format">${icon('archive', 13)}${esc(summary.format)}</span>
        <span class="archive-prev-kind">${esc(summary.kind)}</span>
      </div>
      <ul class="archive-prev-list">
        ${rows || '<li class="is-empty"><span>No entries</span></li>'}
        ${summary.truncated ? '<li class="is-empty"><span>Partial scan of a large archive</span></li>' : ''}
      </ul>
      <div class="archive-prev-foot">${parts.map((part) => `<span>${esc(part)}</span>`).join('')}</div>
    </div>`;
}

function modelMediaHtml(entry, info, thumb) {
  const badge = `${kindLabel(info.kind)}${info.ext ? ` · ${info.ext.toUpperCase()}` : ''}`;
  const poster = thumb && thumb.url ? `<img class="model-poster" src="${esc(thumb.url)}" alt="">` : '';
  return `
    <div class="preview-media model-preview">
      ${poster}
      <canvas class="model-canvas" aria-label="3D model preview"></canvas>
      <span class="thumb-badge">${icon('cube', 9)} ${esc(badge)}</span>
    </div>`;
}

function mediaHtml(entry, thumb, info, archive) {
  if (archive) return archivePreviewHtml(archive);
  if (info.kind === 'audio') return audioMediaHtml(entry, info);
  if (info.kind === 'video') return videoMediaHtml(entry, info, thumb);
  const font = fontTileHtml(entry, { large: true });
  if (font) return `<div class="preview-media">${font}</div>`;
  if (isRotatableModel(info)) return modelMediaHtml(entry, info, thumb);
  const badge = `${kindLabel(info.kind)}${info.ext ? ` · ${info.ext.toUpperCase()}` : ''}`;
  if (thumb && thumb.url) {
    const gif = isGifEntry(entry);
    return `
      <div class="preview-media${gif ? ' is-gif' : ''}">
        <img src="${esc(thumb.url)}" alt=""${gif ? ` data-gif-path="${esc(entry.path)}" data-gif-mtime="${entry.modified || 0}" title="Hover to play"` : ''}>
        <span class="thumb-badge">${icon('image', 9)} ${esc(badge)}</span>
      </div>`;
  }
  return `<div class="preview-media">${kindTile(entry)}</div>`;
}

function wireGifPreview(img) {
  const holder = img.closest('.preview-media');
  if (!holder) return;
  const still = img.src;
  img.dataset.stillSrc = still;
  holder.addEventListener('mouseenter', () => {
    if (img.dataset.gifActive === '1') return;
    img.dataset.gifActive = '1';
    img.src = gifUrl(img.dataset.gifPath, Number(img.dataset.gifMtime) || 0);
  });
  holder.addEventListener('mouseleave', () => {
    if (img.dataset.gifActive !== '1') return;
    delete img.dataset.gifActive;
    img.src = still;
  });
}

function subjectHtml(entry, info, thumb, text, archive) {
  const isText = !info.isDir && isTextEntry(entry);
  const showMedia = info.isDir || !isText;
  const sizeLabel = info.isDir
    ? info.entryCount != null
      ? `${humanCount(info.entryCount)} ${info.entryCount === 1 ? 'item' : 'items'}`
      : 'Folder'
    : humanSize(info.size);
  const media = !info.isDir && MEDIA_KINDS.has(info.kind);

  const meta = [
    metaRow('Type', `${kindLabel(info.kind)}${info.ext ? ` (.${info.ext})` : ''}`),
    media ? metaRowField('Duration', 'duration') : '',
    media && info.kind === 'video' ? metaRowField('Resolution', 'resolution') : '',
    media && info.kind === 'audio' ? metaRowField('Bitrate', 'bitrate', true) : '',
    media && info.kind === 'audio' ? metaRowField('Sample rate', 'sampleRate') : '',
    media && info.kind === 'audio' ? metaRowField('Channels', 'channels') : '',
    metaRow('Size', sizeLabel),
    archive ? metaRow('Contents', `${humanCount(archive.files)} ${archive.files === 1 ? 'file' : 'files'} · ${humanCount(archive.folders)} ${archive.folders === 1 ? 'folder' : 'folders'}`) : '',
    archive ? metaRow('Content type', archive.kind) : '',
    metaRow('Modified', fmtFullDate(info.modified)),
    metaRow('Created', info.created ? fmtFullDate(info.created) : ''),
    metaRow('Dimensions', info.dimensions ? `${info.dimensions[0]} × ${info.dimensions[1]} px` : ''),
    metaRow('Attribute', info.readonly ? 'Read-only' : ''),
    metaRow('Location', dirname(info.path), true),
  ].join('');

  let textBlock = '';
  if (isText && !info.isDir) {
    if (text && !text.binary) {
      const shown = text.text.length > 14000 ? `${text.text.slice(0, 14000)}\n…` : text.text;
      textBlock = `<pre class="preview-text">${esc(shown)}</pre>`;
      if (text.truncated || text.text.length > 14000) {
        textBlock += `<div class="preview-note">Preview truncated${text.encoding ? ` · ${esc(text.encoding)}` : ''}</div>`;
      }
    } else if (text && text.binary) {
      textBlock = '<div class="preview-note">Binary content — open the file to view it.</div>';
    }
  }

  return `
    ${showMedia ? mediaHtml(entry, thumb, info, archive) : ''}
    <div class="preview-title">${esc(info.name || entry.name)}</div>
    <div class="preview-sub">${esc(dirname(info.path) || info.path)}</div>
    ${textBlock}
    <div class="meta-list">${meta}</div>
    <div class="preview-actions">${actionsHtml(entry, info)}</div>`;
}

function skeletonHtml(entry) {
  return `
    <div class="preview-media">${kindTile(entry)}</div>
    <div class="preview-title">${esc(entry.name)}</div>
    <div class="preview-sub">Loading details…</div>`;
}

function multiHtml(entries) {
  const total = entries.reduce((sum, entry) => sum + (entry.size || 0), 0);
  const files = entries.filter((entry) => !entry.isDir).length;
  const list = entries
    .slice(0, 60)
    .map(
      (entry) => `
        <div class="preview-list-item">
          <span class="row-icon" style="--kind-color:${kindColor(entry.kind)}">${kindIcon(entry.kind, 15)}</span>
          <span>${esc(entry.name)}</span>
        </div>`
    )
    .join('');
  return `
    <div class="preview-title">${humanCount(entries.length)} ${entries.length === 1 ? 'item' : 'items'} selected</div>
    <div class="preview-sub">${humanCount(files)} files · ${humanSize(total)}</div>
    <div class="preview-list">${list}${entries.length > 60 ? `<div class="insight-empty">…and ${humanCount(entries.length - 60)} more</div>` : ''}</div>`;
}

function emptyHtml() {
  return `
    <div class="preview-empty">
      ${icon('eye', 26)}
      <strong>Nothing selected</strong>
      <span>Select a file or folder to see its thumbnail, metadata and a quick preview.</span>
    </div>`;
}

function teardownMedia(container) {
  stopModelPreview();
  stopPlaybackMirror?.();
  stopPlaybackMirror = null;
  for (const video of container.querySelectorAll('video')) {
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch {
      /* detached element */
    }
  }
}

function probeDuration(entry, onReady) {
  const probe = new Audio();
  probe.preload = 'metadata';
  const done = () => {
    probe.removeAttribute('src');
    probe.load();
  };
  probe.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(probe.duration)) onReady(probe.duration);
    done();
  });
  probe.addEventListener('error', done, { once: true });
  probe.src = mediaUrl(entry.path);
}

async function wireAudioPreview(entry, info, body, token) {
  const canvas = body.querySelector('.audio-wave');
  const statusEl = body.querySelector('[data-audio-state]');
  const lengthEl = body.querySelector('[data-audio-length]');
  if (!canvas) return;
  let seekDuration = 0;

  canvas.addEventListener('click', (event) => {
    if (!seekDuration) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    playEntry(
      { path: entry.path, name: basename(entry.path), kind: 'audio' },
      { startAt: fraction * seekDuration }
    );
  });

  const data = await loadWave(entry, info.size || 0, info.ext);
  if (token !== state.preview.token || !canvas.isConnected) return;

  const bitrate = data.duration ? (info.size * 8) / data.duration : 0;
  seekDuration = data.duration || 0;
  drawWaveform(canvas, data.peaks);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => drawWaveform(canvas, data.peaks));
    observer.observe(canvas);
  }

  if (data.duration) {
    if (lengthEl) lengthEl.textContent = fmtDuration(data.duration);
    setMetaField(body, 'duration', fmtDuration(data.duration));
  }
  if (data.sampleRate) {
    setMetaField(body, 'sampleRate', `${(data.sampleRate / 1000).toFixed(1)} kHz`);
  }
  if (data.channels) {
    setMetaField(
      body,
      'channels',
      data.channels === 1 ? 'Mono' : data.channels === 2 ? 'Stereo' : `${data.channels} channels`
    );
  }
  if (bitrate) {
    setMetaField(body, 'bitrate', `${Math.round(bitrate / 1000)} kbps`);
  }

  if (statusEl) {
    if (data.note) {
      statusEl.hidden = false;
      statusEl.textContent =
        data.note === 'large'
          ? 'File is too large for an inline waveform'
          : 'Waveform unavailable for this format';
    } else {
      statusEl.hidden = true;
    }
  }

  if (!data.duration) {
    probeDuration(entry, (seconds) => {
      if (token !== state.preview.token || !canvas.isConnected) return;
      seekDuration = seconds;
      if (lengthEl) lengthEl.textContent = fmtDuration(seconds);
      setMetaField(body, 'duration', fmtDuration(seconds));
      if (info.size && seconds > 0) {
        setMetaField(body, 'bitrate', `${Math.round((info.size * 8) / seconds / 1000)} kbps`);
      }
    });
  }
}

function wireVideoPreview(entry, info, body, token) {
  const video = body.querySelector('.video-el');
  const timeline = body.querySelector('[data-video-timeline]');
  if (!video || !timeline) return;
  const lengthEl = body.querySelector('[data-video-length]');
  const fill = body.querySelector('[data-vtl-fill]');
  const knob = body.querySelector('[data-vtl-knob]');
  const bubble = body.querySelector('[data-vtl-bubble]');
  const note = body.querySelector('[data-video-note]');
  let duration = 0;
  let frame = 0;
  let seekToken = 0;
  let playerSnapshot = null;

  const paint = (frac, seconds) => {
    const pct = clamp(frac, 0, 1) * 100;
    if (fill) fill.style.width = `${pct}%`;
    if (knob) knob.style.left = `${pct}%`;
    if (bubble) {
      bubble.textContent = fmtDuration(seconds);
      bubble.style.left = `${clamp(pct, 6, 94)}%`;
    }
  };

  const seek = (clientX) => {
    if (!duration) return;
    const rect = timeline.getBoundingClientRect();
    const frac = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const seconds = frac * duration;
    paint(frac, seconds);
    if (playerSnapshot) seekPlayback(seconds);
    const mine = ++seekToken;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (mine !== seekToken || token !== state.preview.token) return;
      try {
        if (typeof video.fastSeek === 'function') video.fastSeek(seconds);
        else video.currentTime = seconds;
      } catch {
        video.currentTime = seconds;
      }
    });
  };

  video.addEventListener('loadedmetadata', () => {
    if (token !== state.preview.token) return;
    duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (lengthEl) lengthEl.textContent = duration ? fmtDuration(duration) : '—';
    setMetaField(body, 'duration', duration ? fmtDuration(duration) : '');
    if (video.videoWidth && video.videoHeight) {
      setMetaField(body, 'resolution', `${video.videoWidth} × ${video.videoHeight}`);
    }
    if (duration > 0.2) {
      try {
        video.currentTime = Math.min(0.12, duration / 2);
      } catch {
        /* seeking may fail on unsupported containers */
      }
    }
    paint(0, 0);
  });

  video.addEventListener('error', () => {
    if (token !== state.preview.token || !note) return;
    note.hidden = false;
    note.textContent =
      'This format cannot be previewed here. Use Play for the in-app player or open it with the default app.';
    if (lengthEl) lengthEl.textContent = '—';
  });

  video.addEventListener('timeupdate', () => {
    if (token !== state.preview.token || !duration) return;
    paint(video.currentTime / duration, video.currentTime);
  });

  timeline.addEventListener('pointerenter', (event) => {
    if (bubble) bubble.hidden = false;
    seek(event.clientX);
  });
  timeline.addEventListener('pointermove', (event) => seek(event.clientX));
  timeline.addEventListener('pointerleave', () => {
    if (bubble) bubble.hidden = true;
  });
  timeline.addEventListener('pointerdown', (event) => {
    try {
      timeline.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    seek(event.clientX);
  });
  timeline.addEventListener('pointerup', (event) => {
    try {
      timeline.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  stopPlaybackMirror?.();
  stopPlaybackMirror = onPlayback((snapshot) => {
    if (token !== state.preview.token || !video.isConnected) return;
    const same = Boolean(snapshot.path) && snapshot.path.toLowerCase() === entry.path.toLowerCase();
    playerSnapshot = same ? snapshot : null;
    if (!same) {
      if (!video.paused) video.pause();
      return;
    }
    const max = duration || video.duration || snapshot.duration || 0;
    if (max > 0) {
      const target = clamp(snapshot.time, 0, max);
      if (Math.abs(video.currentTime - target) > 0.4) {
        try {
          video.currentTime = target;
        } catch {
          /* seeking may fail on unsupported containers */
        }
      }
    }
    if (snapshot.playing) {
      if (video.paused) video.play().catch(() => {});
    } else if (!video.paused) {
      video.pause();
    }
  });
}

export function renderPreview() {
  const pane = document.getElementById('preview-pane');
  if (!pane) return;
  if (!pane.querySelector('.preview-body')) {
    pane.innerHTML = `
      <div class="preview-head">
        <h3>Preview</h3>
        <button class="icon-btn tiny" type="button" data-action="close-preview" title="Close preview">${icon('x', 13)}</button>
      </div>
      <div class="preview-body"></div>`;
  }
  if (!state.preview.open) {
    stopModelPreview();
    pane.hidden = true;
    return;
  }

  const body = pane.querySelector('.preview-body');
  const selected = selectedEntries();
  const token = ++state.preview.token;

  if (selected.length > 1) {
    teardownMedia(body);
    body.innerHTML = multiHtml(selected);
    return;
  }

  const entry = selected.length === 1 ? selected[0] : focusedEntry();
  if (!entry) {
    teardownMedia(body);
    body.innerHTML = emptyHtml();
    return;
  }

  teardownMedia(body);
  body.innerHTML = skeletonHtml(entry);

  (async () => {
    try {
      const info = await api.fileInfo(entry.path);
      if (token !== state.preview.token) return;

      const thumb = wantsThumb(entry) ? await api.thumbnail(entry.path, 460).catch(() => null) : null;
      if (token !== state.preview.token) return;

      const text = !info.isDir && isTextEntry(entry)
        ? await api.textPreview(entry.path, 64 * 1024).catch(() => null)
        : null;
      if (token !== state.preview.token) return;

      const archive = archiveSupported(entry) ? await archiveSummaryFor(entry) : null;
      if (token !== state.preview.token) return;

      body.innerHTML = subjectHtml(entry, info, thumb, text, archive);
      observeFontTiles(body);
      const media = body.querySelector('.preview-media img');
      if (media) {
        if (media.dataset.gifPath) wireGifPreview(media);
        media.onerror = () => {
          if (media.dataset.gifActive === '1' && media.dataset.stillSrc) {
            delete media.dataset.gifActive;
            media.src = media.dataset.stillSrc;
            return;
          }
          const holder = media.closest('.preview-media');
          if (holder) holder.innerHTML = kindTile(entry);
        };
      }
      if (!info.isDir && isRotatableModel(info)) {
        wireModelPreview(entry, body, token);
      } else if (!info.isDir && info.kind === 'audio') {
        wireAudioPreview(entry, info, body, token);
      } else if (!info.isDir && info.kind === 'video') {
        wireVideoPreview(entry, info, body, token);
      }
    } catch (error) {
      if (token !== state.preview.token) return;
      body.innerHTML = `
        <div class="preview-empty">
          ${icon('alert', 24)}
          <strong>Could not load preview</strong>
          <span>${esc(String(error))}</span>
        </div>`;
    }
  })();
}

export const refreshPreviewSoon = debounce(renderPreview, 80);

function onPreviewClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const path = button.dataset.path || '';
  if (action === 'close-preview') {
    app.togglePreview?.();
  } else if (action === 'open-folder') {
    app.navigate?.(path);
  } else if (action === 'open') {
    app.openPath?.(path);
  } else if (action === 'play') {
    playEntry({ path, name: basename(path), kind: button.dataset.kind });
  } else if (action === 'loop') {
    setLoop();
  } else if (action === 'playlist-add') {
    addToPlaylist({ path, name: basename(path), kind: button.dataset.kind });
  } else if (action === 'visualize') {
    app.visualizePath?.(path);
  } else if (action === 'reveal') {
    app.reveal?.({ path });
  } else if (action === 'copy-path') {
    app.copyPath?.([{ path }]);
  }
}

export function initPreview() {
  const pane = document.getElementById('preview-pane');
  if (!pane) return;
  pane.addEventListener('click', onPreviewClick);
  renderPreview();
}
