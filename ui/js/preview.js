import { api, mediaUrl, gifUrl } from './api.js';
import { state, app } from './state.js';
import {
  selectedEntries,
  focusedEntry,
  wantsThumb,
  isGifEntry,
  archiveSupported,
  archiveListable,
  archiveSummaryFor,
  discSupported,
  discSummaryFor,
  folderMosaicFor,
} from './files.js';
import { packMosaic, mosaicHtml } from './mosaic.js';
import { icon, kindIcon } from './icons.js';
import { playEntry, addToPlaylist, onPlayback, seekPlayback, isLooping, setLoop, setActiveSoundFont, soundfontLabel } from './player.js';
import { fontTileHtml, observeFontTiles } from './fonts.js';
import { isSoundfontEntry, soundfontTileHtml, observeSoundfontTiles, soundfontMeta, loadSoundfont } from './sf2.js';
import { isMidiPath, renderMidi } from './midi.js';
import { isTrackerPath, loadTracker, trackerKindLabel, auditionTrackerSample } from './tracker.js';
import { noteName } from './tracker-formats.js';
import { EXPORT_FORMATS, exportFileName, quickExportPath, writeSample } from './tracker-export.js';
import { openModal, showMenu, toast } from './dialogs.js';
import { wireModelPreview, stopModelPreview, isRotatableModel } from './model.js';
import { loadWave, drawWaveform } from './waveform.js';
import {
  esc,
  basename,
  dirname,
  joinPath,
  humanSize,
  humanCount,
  fmtFullDate,
  fmtDuration,
  entryKindLabel,
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

function plural(count, word) {
  return `${humanCount(count)} ${count === 1 ? word : `${word}s`}`;
}

function fillSceneInfo(root, scene) {
  setMetaField(root, 'modelTitle', scene.title);
  setMetaField(root, 'designer', scene.designer);
  setMetaField(root, 'application', scene.application);

  const objects = [plural(scene.objects, 'object')];
  if (scene.parts > scene.objects) objects.push(plural(scene.parts, 'part'));
  if (scene.plates > 1) objects.push(`plate 1 of ${scene.plates}`);
  setMetaField(root, 'objects', objects.join(' · '));

  const triangles = [humanCount(scene.triangles)];
  if (scene.painted) triangles.push(`${humanCount(scene.painted)} painted`);
  if (scene.sampled) triangles.push('simplified preview');
  setMetaField(root, 'triangles', triangles.join(' · '));

  if (Array.isArray(scene.extent)) {
    const metres = Math.max(...scene.extent) >= 1000;
    const parts = scene.extent.map((mm) => (metres ? (mm / 1000).toFixed(2) : mm >= 100 ? `${Math.round(mm)}` : mm.toFixed(1)));
    setMetaField(root, 'extent', `${parts.join(' × ')} ${metres ? 'm' : 'mm'}`);
  }

  const row = root.querySelector('[data-meta-field="materials"]');
  const materials = Array.isArray(scene.materials) ? scene.materials : [];
  if (!row || !materials.length) return;
  const value = row.querySelector('.meta-value');
  value.textContent = '';
  value.classList.add('meta-swatches');
  for (const material of materials) {
    const chip = document.createElement('span');
    chip.className = 'meta-swatch';
    const percent = material.share >= 0.995 ? '100%' : `${(material.share * 100).toFixed(material.share < 0.1 ? 1 : 0)}%`;
    chip.title = `${material.name} · ${material.color} · ${percent} of surface`;
    const dot = document.createElement('i');
    dot.style.background = material.color;
    const label = document.createElement('span');
    label.textContent = `${material.name} ${percent}`;
    chip.append(dot, label);
    value.append(chip);
  }
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
  if (isSoundfontEntry(entry)) {
    const active = state.soundFont && state.soundFont.toLowerCase() === entry.path.toLowerCase();
    return `
      <button class="mini-btn${active ? ' active' : ' primary'}" type="button" data-action="use-soundfont" data-path="${path}" aria-pressed="${active}">${icon(active ? 'check' : 'piano', 13)} ${active ? 'Using for MIDI' : 'Use for MIDI'}</button>
      ${state.soundFont ? `<button class="mini-btn" type="button" data-action="reset-soundfont">${icon('refresh', 13)} Use built-in</button>` : ''}
      <button class="mini-btn" type="button" data-action="open" data-path="${path}">${icon('open', 13)} Open</button>
      <button class="mini-btn" type="button" data-action="reveal" data-path="${path}">${icon('external', 13)} Reveal</button>
      <button class="mini-btn" type="button" data-action="copy-path" data-path="${path}">${icon('copy', 13)} Copy path</button>`;
  }
  if (archiveSupported(entry)) {
    const name = esc(entry.name);
    return `
      <button class="mini-btn primary" type="button" data-action="extract" data-path="${path}" data-name="${name}">${icon('download', 13)} Extract To…</button>
      <button class="mini-btn" type="button" data-action="open" data-path="${path}">${icon('open', 13)} Open</button>
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
        <span class="audio-format">${esc((info.ext || 'audio').toUpperCase())} · ${esc(entryKindLabel(info))}</span>
      </div>
    </div>`;
}

function trackerMediaHtml(entry, info) {
  const label = trackerKindLabel(entry.path);
  return `
    <div class="audio-preview is-tracker" data-tracker-preview>
      <div class="audio-wave-wrap">
        <canvas class="audio-wave tracker-grid" tabindex="0" role="img" aria-label="Tracker pattern grid"></canvas>
        <div class="audio-wave-state" data-audio-state>${icon('loader', 13, 'spin')} Rendering tracker…</div>
      </div>
      <div class="audio-strip">
        <span class="audio-length" data-audio-length>—</span>
        <span class="audio-pos" data-tracker-pos hidden></span>
        <span class="audio-format">${esc((info.ext || 'mod').toUpperCase())} · ${esc(label)}</span>
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
  const head = `
      <div class="archive-prev-head">
        <span class="archive-prev-format">${icon(summary.filesystem ? 'disc' : 'archive', 13)}${esc(summary.format)}</span>
        <span class="archive-prev-kind">${esc(summary.kind)}</span>
      </div>`;
  if (summary.locked) {
    return `
    <div class="preview-media archive-preview">
      ${head}
      <div class="archive-locked">
        ${icon('lock', 26)}
        <strong>Password protected</strong>
        <span>Contents cannot be listed without the password.</span>
      </div>
    </div>`;
  }
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
      ${head}
      <ul class="archive-prev-list">
        ${rows || '<li class="is-empty"><span>No entries</span></li>'}
        ${summary.truncated ? '<li class="is-empty"><span>Partial scan of a large archive</span></li>' : ''}
      </ul>
      <div class="archive-prev-foot">${parts.map((part) => `<span>${esc(part)}</span>`).join('')}</div>
    </div>`;
}

function modelMediaHtml(entry, info, thumb) {
  const badge = `${entryKindLabel(info)}${info.ext ? ` · ${info.ext.toUpperCase()}` : ''}`;
  const poster = thumb && thumb.url ? `<img class="model-poster" src="${esc(thumb.url)}" alt="">` : '';
  return `
    <div class="preview-media model-preview">
      ${poster}
      <canvas class="model-canvas" aria-label="3D model preview"></canvas>
      <span class="thumb-badge">${icon('cube', 9)} ${esc(badge)}</span>
    </div>`;
}

function soundfontMediaHtml(entry) {
  const active = state.soundFont && state.soundFont.toLowerCase() === entry.path.toLowerCase();
  return `
    <div class="preview-media soundfont-preview">
      ${soundfontTileHtml(entry, { large: true })}
      <div class="sf2-prev-note${active ? ' active' : ''}" data-sf2-note>
        ${icon(active ? 'check' : 'piano', 12)}
        <span>${active ? 'Active SoundFont for MIDI playback' : 'Activate from the button below to play MIDI files with it'}</span>
      </div>
    </div>`;
}

function folderMosaicPreviewHtml(mosaic) {
  return `
    <div class="preview-media folder-mosaic-preview">
      <div class="folder-mosaic-fill" data-folder-mosaic></div>
      <span class="thumb-badge">${icon('image', 9)} ${humanCount(mosaic.media)} images &amp; videos</span>
    </div>`;
}

function mediaHtml(entry, thumb, info, archive, mosaic) {
  if (archive) return archivePreviewHtml(archive);
  if (info.isDir) {
    if (mosaic && mosaic.items.length) return folderMosaicPreviewHtml(mosaic);
    return `<div class="preview-media">${kindTile(entry)}</div>`;
  }
  if (info.kind === 'audio') {
    return isTrackerPath(entry.path) ? trackerMediaHtml(entry, info) : audioMediaHtml(entry, info);
  }
  if (info.kind === 'video') return videoMediaHtml(entry, info, thumb);
  if (isSoundfontEntry(entry)) return soundfontMediaHtml(entry);
  const font = fontTileHtml(entry, { large: true });
  if (font) return `<div class="preview-media">${font}</div>`;
  if (isRotatableModel(info)) return modelMediaHtml(entry, info, thumb);
  const badge = `${entryKindLabel(info)}${info.ext ? ` · ${info.ext.toUpperCase()}` : ''}`;
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

function wireFolderMosaic(body, mosaic) {
  const holder = body.querySelector('[data-folder-mosaic]');
  if (!holder || !mosaic || !mosaic.items.length) return;
  const width = holder.clientWidth;
  const height = holder.clientHeight;
  if (!width || !height) return;
  const tiles = packMosaic(mosaic.items, width, height, { maxTiles: 16, gap: 3 });
  if (!tiles.length) return;
  holder.innerHTML = mosaicHtml(tiles, width, height);
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

function subjectHtml(entry, info, thumb, text, archive, mosaic) {
  const isText = !info.isDir && isTextEntry(entry);
  const showMedia = info.isDir || !isText;
  const sizeLabel = info.isDir
    ? info.entryCount != null
      ? `${humanCount(info.entryCount)} ${info.entryCount === 1 ? 'item' : 'items'}`
      : 'Folder'
    : humanSize(info.size);
  const media = !info.isDir && MEDIA_KINDS.has(info.kind);
  const scene = !info.isDir && (info.ext || '').toLowerCase() === '3mf';
  const soundfont = !info.isDir && isSoundfontEntry(entry);
  const tracker = !info.isDir && isTrackerPath(entry.path);

  const meta = [
    metaRow('Type', `${entryKindLabel(info)}${info.ext ? ` (.${info.ext})` : ''}`),
    tracker ? metaRowField('Title', 'trackTitle') : '',
    tracker ? metaRowField('Tracker', 'trackerName') : '',
    tracker ? metaRowField('Orders', 'trackerOrders') : '',
    tracker ? metaRowField('Patterns', 'trackerPatterns') : '',
    tracker ? metaRowField('Samples', 'trackerSamples') : '',
    scene ? metaRowField('Title', 'modelTitle') : '',
    scene ? metaRowField('Designer', 'designer') : '',
    scene ? metaRowField('Slicer', 'application') : '',
    scene ? metaRowField('Objects', 'objects') : '',
    scene ? metaRowField('Triangles', 'triangles') : '',
    scene ? metaRowField('Extent', 'extent') : '',
    scene ? metaRowField('Materials', 'materials') : '',
    media ? metaRowField('Duration', 'duration') : '',
    media && info.kind === 'video' ? metaRowField('Resolution', 'resolution') : '',
    media && info.kind === 'audio' ? metaRowField('Bitrate', 'bitrate', true) : '',
    media && info.kind === 'audio' ? metaRowField('Sample rate', 'sampleRate') : '',
    media && info.kind === 'audio' ? metaRowField('Channels', 'channels') : '',
    soundfont ? metaRowField('SoundFont', 'sfName') : '',
    soundfont ? metaRowField('Presets', 'sfPresets') : '',
    soundfont ? metaRowField('Instruments', 'sfInstruments') : '',
    soundfont ? metaRowField('Samples', 'sfSamples') : '',
    soundfont ? metaRowField('Engine', 'sfEngine') : '',
    soundfont ? metaRowField('Version', 'sfVersion') : '',
    metaRow('Size', sizeLabel),
    archive && !archive.locked ? metaRow('Contents', `${humanCount(archive.files)} ${archive.files === 1 ? 'file' : 'files'} · ${humanCount(archive.folders)} ${archive.folders === 1 ? 'folder' : 'folders'}`) : '',
    archive ? metaRow('Content type', archive.kind) : '',
    archive && archive.filesystem ? metaRow('Filesystem', archive.filesystem) : '',
    archive && archive.label ? metaRow('Volume', archive.label) : '',
    archive && archive.locked ? metaRow('Protection', 'Password required') : '',
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
    ${showMedia ? mediaHtml(entry, thumb, info, archive, mosaic) : ''}
    <div class="preview-title">${esc(info.name || entry.name)}</div>
    <div class="preview-sub">${esc(dirname(info.path) || info.path)}</div>
    <div class="preview-actions">${actionsHtml(entry, info)}</div>
    ${tracker ? '<div class="sound-bank" data-sound-bank hidden></div>' : ''}
    ${textBlock}
    <div class="meta-list">${meta}</div>`;
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
  stopAudition();
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

let audition = null;
let auditionToken = 0;

function stopAudition() {
  auditionToken += 1;
  if (!audition) return;
  const { audio, url, row } = audition;
  audition = null;
  try {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } catch {
    /* no source yet */
  }
  URL.revokeObjectURL(url);
  row.classList.remove('is-playing');
  row.querySelector('.sb-play').innerHTML = icon('play', 11);
}

function sampleLength(frames, rate) {
  const seconds = frames / rate;
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 10) return `${seconds.toFixed(seconds < 1 ? 2 : 1)} s`;
  return fmtDuration(seconds);
}

function fillSoundBank(el, entry, result) {
  stopAudition();
  const bank = result.bank || [];
  if (!bank.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.innerHTML = `
    <div class="sb-head"><span>Sound bank</span><span class="sb-count">${bank.length} ${bank.length === 1 ? 'sample' : 'samples'}</span></div>
    <div class="sb-list">
      ${bank
        .map(
          (s, i) => `
        <button type="button" class="sb-row" data-bank-index="${i}" title="Play ${esc(s.name)} once">
          <span class="sb-play">${icon('play', 11)}</span>
          <span class="sb-name">${esc(s.name)}</span>
          <span class="sb-len">${sampleLength(s.frames, s.rate)}</span>
        </button>`
        )
        .join('')}
    </div>`;
  el.hidden = false;

  const audio = new Audio();
  audio.addEventListener('ended', () => {
    if (audition && audition.audio === audio) stopAudition();
  });

  el.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.sb-row');
    if (!row || !el.contains(row)) return;
    event.preventDefault();
    const index = Number(row.dataset.bankIndex);
    const sample = bank[index];
    if (sample) openSampleMenu(event, entry, sample, index);
  });

  el.addEventListener('click', async (event) => {
    const row = event.target.closest('.sb-row');
    if (!row || !el.contains(row)) return;
    if (audition && audition.row === row) {
      stopAudition();
      return;
    }
    stopAudition();
    const token = auditionToken;
    const index = Number(row.dataset.bankIndex);
    let clip = null;
    try {
      clip = await auditionTrackerSample(entry, index);
    } catch {
      clip = null;
    }
    if (!clip) return;
    if (token !== auditionToken || !row.isConnected) {
      URL.revokeObjectURL(clip.url);
      return;
    }
    audition = { audio, url: clip.url, row };
    row.classList.add('is-playing');
    row.querySelector('.sb-play').innerHTML = icon('pause', 11);
    audio.src = clip.url;
    audio.play().catch(() => {
      if (audition && audition.row === row) stopAudition();
    });
  });
}

function formatLabel(format) {
  return EXPORT_FORMATS.find((item) => item.ext === format)?.label || format.toUpperCase();
}

async function exportSampleAs(entry, sample, index, format) {
  const name = exportFileName(entry.path, index, format);
  let target = null;
  try {
    target = await api.saveFileDialog({
      title: 'Export sample as',
      defaultPath: joinPath(dirname(entry.path), name),
      filters: [{ name: formatLabel(format), extensions: [format] }],
    });
  } catch (error) {
    toast(String(error), { type: 'error' });
    return false;
  }
  if (!target) return false;
  try {
    const bytes = await writeSample(sample, format, target);
    toast(`Exported ${basename(target)} · ${humanSize(bytes)}`, { type: 'success' });
    return true;
  } catch (error) {
    toast(String(error?.message || error), { type: 'error' });
    return false;
  }
}

async function quickExportSample(entry, sample, index, format) {
  const target = quickExportPath(entry.path, index, format);
  try {
    const bytes = await writeSample(sample, format, target);
    toast(`Exported ${basename(target)} · ${humanSize(bytes)}`, { type: 'success' });
  } catch (error) {
    toast(String(error?.message || error), { type: 'error' });
  }
}

function openSampleExportDialog(entry, sample, index) {
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="field">
      <span>Format</span>
      <select class="select" data-autofocus>
        ${EXPORT_FORMATS.map((item) => `<option value="${item.ext}">${esc(item.label)}</option>`).join('')}
      </select>
    </label>
    <p class="field-hint">Rendered from the original sample at ${Math.round(sample.rate)} Hz and saved where you choose.</p>
  `;
  openModal({
    title: 'Export sample',
    subtitle: sample.name,
    body,
    width: 440,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Export…',
        kind: 'primary',
        onClick: ({ body: content }) =>
          exportSampleAs(entry, sample, index, content.querySelector('select').value),
      },
    ],
  });
}

function openSampleMenu(event, entry, sample, index) {
  showMenu({
    x: event.clientX,
    y: event.clientY,
    items: [
      { label: 'Export as…', icon: 'download', onClick: () => openSampleExportDialog(entry, sample, index) },
      {
        label: 'Quick Export',
        icon: 'archive',
        submenu: EXPORT_FORMATS.map((item) => ({
          label: item.label,
          onClick: () => quickExportSample(entry, sample, index, item.ext),
        })),
      },
    ],
  });
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

const TRACKER_ROW_H = 12;
const TRACKER_HEADER_H = 15;
const TRACKER_GUTTER = 28;
const TRACKER_CHAN_W = 56;

function trackerGeometry(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  return {
    width,
    height,
    rows: Math.max(1, Math.floor((height - TRACKER_HEADER_H) / TRACKER_ROW_H)),
    visibleChannels: Math.max(1, Math.floor((width - TRACKER_GUTTER) / TRACKER_CHAN_W)),
  };
}

function trackerSnapshot(song, time) {
  const refs = song.rowRefs;
  if (!refs || !refs.length) return { index: 0, order: 0, row: 0 };
  let lo = 0;
  let hi = refs.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (refs[mid].time <= time) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { index: best, order: refs[best].order, row: refs[best].row };
}

function findTrackerRow(song, order, row, fromIndex) {
  const refs = song.rowRefs || [];
  for (let i = Math.max(0, fromIndex); i < refs.length; i += 1) {
    if (refs[i].order === order && refs[i].row === row) return refs[i];
  }
  for (let i = 0; i < refs.length; i += 1) {
    if (refs[i].order === order && refs[i].row === row) return refs[i];
  }
  return null;
}

function drawTrackerGrid(canvas, result, view) {
  const geometry = trackerGeometry(canvas);
  if (!geometry.width || !geometry.height) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(geometry.width * dpr) || canvas.height !== Math.round(geometry.height * dpr)) {
    canvas.width = Math.round(geometry.width * dpr);
    canvas.height = Math.round(geometry.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, geometry.width, geometry.height);

  const song = result.song;
  const snap = trackerSnapshot(song, view.time);
  view.snap = snap;
  if (view.cursorOrder == null) {
    view.cursorOrder = snap.order;
    view.cursorRow = snap.row;
  }
  const order = view.playing ? snap.order : view.cursorOrder;
  const row = view.playing ? snap.row : view.cursorRow;
  view.order = order;
  view.row = row;
  const patternIndex = song.orders[order];
  const pattern = patternIndex != null ? song.patterns[patternIndex] : null;
  const channelsLen = pattern ? pattern.channelsLen || song.channels : song.channels;
  const channels = Math.min(pattern ? channelsLen : song.channels, song.channels, 64);
  const shownChannels = Math.min(channels, geometry.visibleChannels);
  const totalRows = pattern ? pattern.rows : 64;
  const start = clamp(row - Math.floor(geometry.rows / 2), 0, Math.max(0, totalRows - geometry.rows));
  view.start = start;
  view.shownChannels = shownChannels;

  const font = '9px monospace';
  ctx.fillStyle = '#070b10';
  ctx.fillRect(0, 0, geometry.width, geometry.height);

  ctx.fillStyle = 'rgba(120, 145, 170, 0.08)';
  ctx.fillRect(0, 0, geometry.width, TRACKER_HEADER_H);
  ctx.font = '8.5px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(160, 180, 200, 0.55)';
  ctx.fillText('ORD ROW', 4, TRACKER_HEADER_H / 2);
  for (let ch = 0; ch < shownChannels; ch += 1) {
    const x = TRACKER_GUTTER + ch * TRACKER_CHAN_W + TRACKER_CHAN_W / 2;
    ctx.fillText(String(ch + 1).padStart(2, '0'), x, TRACKER_HEADER_H / 2);
  }

  ctx.font = font;
  for (let r = 0; r < geometry.rows; r += 1) {
    const row = start + r;
    if (row >= totalRows) break;
    const y = TRACKER_HEADER_H + r * TRACKER_ROW_H;
    if (row % 16 === 0) {
      ctx.fillStyle = 'rgba(120, 145, 170, 0.07)';
      ctx.fillRect(0, y, geometry.width, TRACKER_ROW_H);
    } else if (row % 4 === 0) {
      ctx.fillStyle = 'rgba(120, 145, 170, 0.035)';
      ctx.fillRect(0, y, geometry.width, TRACKER_ROW_H);
    }
    if (row === view.row) {
      const tint = view.playing ? 'rgba(77, 163, 255, ' : 'rgba(163, 230, 53, ';
      ctx.fillStyle = `${tint}0.16)`;
      ctx.fillRect(0, y, geometry.width, TRACKER_ROW_H);
      ctx.fillStyle = `${tint}0.9)`;
      ctx.fillRect(0, y, 2, TRACKER_ROW_H);
    }
    ctx.fillStyle = 'rgba(150, 170, 190, 0.45)';
    ctx.fillText(row.toString(16).toUpperCase().padStart(2, '0'), 4, y + TRACKER_ROW_H / 2);
    ctx.fillStyle = 'rgba(110, 135, 160, 0.35)';
    ctx.fillText(String(order + 1).padStart(2, '0'), 20, y + TRACKER_ROW_H / 2);
    if (!pattern) continue;
    for (let ch = 0; ch < shownChannels; ch += 1) {
      const cell = pattern.cells[row * channelsLen + ch];
      const x = TRACKER_GUTTER + ch * TRACKER_CHAN_W;
      const midY = y + TRACKER_ROW_H / 2;
      const hasNote = cell && cell.note >= 0 && cell.note < 254;
      ctx.fillStyle = 'rgba(110, 135, 160, 0.22)';
      ctx.fillText('···', x + 3, midY);
      if (!cell) continue;
      if (hasNote) {
        ctx.fillStyle = '#b9d9ff';
        ctx.fillText(noteName(cell.note), x + 3, midY);
      }
      if (cell.ins) {
        ctx.fillStyle = 'rgba(170, 200, 225, 0.75)';
        ctx.fillText(String(cell.ins).padStart(2, '0'), x + 21, midY);
      }
      if (cell.vol >= 0) {
        ctx.fillStyle = 'rgba(130, 200, 165, 0.8)';
        ctx.fillText(String(cell.vol).padStart(2, '0'), x + 39, midY);
      }
    }
  }
  if (pattern && totalRows > geometry.rows) {
    const trackH = geometry.height - TRACKER_HEADER_H;
    const thumbY = TRACKER_HEADER_H + (start / totalRows) * trackH;
    const thumbH = Math.max(8, (geometry.rows / totalRows) * trackH);
    ctx.fillStyle = 'rgba(150, 180, 210, 0.14)';
    ctx.fillRect(geometry.width - 3, thumbY, 3, thumbH);
  }
}

async function wireAudioPreview(entry, info, body, token) {
  const canvas = body.querySelector('.audio-wave');
  const statusEl = body.querySelector('[data-audio-state]');
  const lengthEl = body.querySelector('[data-audio-length]');
  if (!canvas) return;
  let seekDuration = 0;
  let seekHandler = null;

  canvas.addEventListener('click', (event) => {
    if (!seekDuration) return;
    if (seekHandler) {
      seekHandler(event);
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    playEntry(
      { path: entry.path, name: basename(entry.path), kind: 'audio' },
      { startAt: fraction * seekDuration }
    );
  });

  if (isTrackerPath(entry.path)) {
    const formatEl = body.querySelector('.audio-format');
    const posEl = body.querySelector('[data-tracker-pos]');
    const view = { time: 0, start: 0, playing: false, cursorOrder: null, cursorRow: null };
    let result = null;
    let paint = () => {};
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.innerHTML = `${icon('loader', 13, 'spin')} Rendering tracker…`;
    }
    try {
      result = await loadTracker(entry);
      if (token !== state.preview.token || !canvas.isConnected) return;
      seekDuration = result.duration || 0;
      paint = () => {
        if (!result || !canvas.isConnected) return;
        drawTrackerGrid(canvas, result, view);
        if (posEl) {
          const snap = view.snap || trackerSnapshot(result.song, view.time);
          const order = view.order ?? snap.order;
          const row = view.row ?? snap.row;
          const pattern = result.song.patterns[result.song.orders[order]];
          posEl.textContent = `Ord ${String(order + 1).padStart(2, '0')} · Row ${String(row + 1).padStart(2, '0')}/${pattern ? pattern.rows : 64}`;
          posEl.hidden = false;
        }
      };
      seekHandler = (event) => {
        if (!result) return;
        const rect = canvas.getBoundingClientRect();
        if (event.clientY - rect.top < TRACKER_HEADER_H) return;
        const row = view.start + Math.floor((event.clientY - rect.top - TRACKER_HEADER_H) / TRACKER_ROW_H);
        const snap = view.snap || trackerSnapshot(result.song, view.time);
        if (row < 0) return;
        const ref = findTrackerRow(result.song, view.order ?? snap.order, row, snap.index);
        if (!ref) return;
        playEntry(
          { path: entry.path, name: basename(entry.path), kind: 'audio' },
          { startAt: ref.time }
        );
      };
      const stepOrder = (delta) => {
        const orders = result.song.orders;
        let next = view.cursorOrder + delta;
        while (next >= 0 && next < orders.length) {
          if (orders[next] != null) break;
          next += delta;
        }
        if (next < 0 || next >= orders.length) return;
        view.cursorOrder = next;
        const pattern = result.song.patterns[orders[next]];
        view.cursorRow = Math.min(view.cursorRow, (pattern ? pattern.rows : 64) - 1);
      };
      canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
      canvas.addEventListener('keydown', (event) => {
        if (!result || view.playing) return;
        const pattern = result.song.patterns[result.song.orders[view.cursorOrder]];
        const rows = pattern ? pattern.rows : 64;
        if (event.key === 'ArrowUp') {
          view.cursorRow = clamp(view.cursorRow - 1, 0, rows - 1);
        } else if (event.key === 'ArrowDown') {
          view.cursorRow = clamp(view.cursorRow + 1, 0, rows - 1);
        } else if (event.key === 'ArrowLeft') {
          stepOrder(-1);
        } else if (event.key === 'ArrowRight') {
          stepOrder(1);
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        paint();
      });
      if (lengthEl) lengthEl.textContent = fmtDuration(result.duration);
      setMetaField(body, 'duration', fmtDuration(result.duration));
      setMetaField(body, 'sampleRate', `${(result.sampleRate / 1000).toFixed(1)} kHz`);
      setMetaField(body, 'channels', 'Stereo');
      setMetaField(body, 'trackTitle', result.song.title);
      setMetaField(body, 'trackerName', result.song.tracker);
      setMetaField(body, 'trackerOrders', String(result.song.orders.length));
      setMetaField(body, 'trackerPatterns', String(result.song.patternCount));
      setMetaField(body, 'trackerSamples', String(result.song.sampleCount));
      if (formatEl) formatEl.textContent = `${result.song.format} · ${trackerKindLabel(entry.path, result.song.format)}`;
      const bankEl = body.querySelector('[data-sound-bank]');
      if (bankEl) fillSoundBank(bankEl, entry, result);
      if (statusEl) statusEl.hidden = true;
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => paint());
        observer.observe(canvas);
      }
      stopPlaybackMirror = onPlayback((snapshot) => {
        if (snapshot.path && snapshot.path.toLowerCase() === entry.path.toLowerCase()) {
          const wasPlaying = view.playing;
          view.time = snapshot.time;
          view.playing = snapshot.playing;
          if (wasPlaying && !view.playing && view.snap) {
            view.cursorOrder = view.snap.order;
            view.cursorRow = view.snap.row;
          }
        } else {
          view.playing = false;
        }
        paint();
      });
      paint();
    } catch {
      if (token !== state.preview.token || !canvas.isConnected) return;
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'Tracker preview unavailable — press Play';
      }
    }
    return;
  }

  if (isMidiPath(entry.path)) {
    const formatEl = body.querySelector('.audio-format');
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.innerHTML = `${icon('loader', 13, 'spin')} Rendering MIDI…`;
    }
    try {
      let sf2 = null;
      let sf2Key = 'gen';
      if (state.soundFont) {
        try {
          sf2 = await loadSoundfont(state.soundFont);
          sf2Key = state.soundFont;
        } catch {
          sf2 = null;
          sf2Key = 'gen';
        }
      }
      const result = await renderMidi(entry.path, sf2, sf2Key);
      if (token !== state.preview.token || !canvas.isConnected) return;
      seekDuration = result.duration || 0;
      drawWaveform(canvas, result.peaks);
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => drawWaveform(canvas, result.peaks));
        observer.observe(canvas);
      }
      if (lengthEl) lengthEl.textContent = fmtDuration(result.duration);
      setMetaField(body, 'duration', fmtDuration(result.duration));
      setMetaField(body, 'sampleRate', `${(result.sampleRate / 1000).toFixed(1)} kHz`);
      setMetaField(body, 'channels', result.channels === 1 ? 'Mono' : 'Stereo');
      if (formatEl) formatEl.textContent = `MIDI · ${soundfontLabel()}`;
      if (statusEl) statusEl.hidden = true;
    } catch {
      if (token !== state.preview.token || !canvas.isConnected) return;
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = 'MIDI preview unavailable — press Play';
      }
    }
    return;
  }

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

async function wireSoundfontPreview(entry, info, body, token) {
  observeSoundfontTiles(body);
  const meta = await soundfontMeta(entry.path, entry.modified || 0, info.size || 0);
  if (token !== state.preview.token || !body.isConnected || !meta) return;
  setMetaField(body, 'sfName', meta.name || '');
  setMetaField(body, 'sfPresets', meta.presetCount ? humanCount(meta.presetCount) : '');
  setMetaField(body, 'sfInstruments', meta.instrumentCount ? humanCount(meta.instrumentCount) : '');
  setMetaField(body, 'sfSamples', meta.sampleCount ? humanCount(meta.sampleCount) : '');
  setMetaField(body, 'sfEngine', meta.engine || '');
  setMetaField(body, 'sfVersion', meta.version || '');
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

      const archive = archiveListable(entry)
        ? await archiveSummaryFor(entry)
        : discSupported(entry)
          ? await discSummaryFor(entry)
          : null;
      if (token !== state.preview.token) return;

      const mosaic = info.isDir ? await folderMosaicFor(entry, 16) : null;
      if (token !== state.preview.token) return;

      body.innerHTML = subjectHtml(entry, info, thumb, text, archive, mosaic);
      wireFolderMosaic(body, mosaic);
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
        wireModelPreview(entry, body, token).then((scene) => {
          if (scene && token === state.preview.token) fillSceneInfo(body, scene);
        });
      } else if (!info.isDir && info.kind === 'audio') {
        wireAudioPreview(entry, info, body, token);
      } else if (!info.isDir && info.kind === 'video') {
        wireVideoPreview(entry, info, body, token);
      } else if (!info.isDir && isSoundfontEntry(entry)) {
        wireSoundfontPreview(entry, info, body, token);
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
  } else if (action === 'extract') {
    app.extractArchive?.({ path, name: button.dataset.name || basename(path) });
  } else if (action === 'copy-path') {
    app.copyPath?.([{ path }]);
  } else if (action === 'use-soundfont') {
    setActiveSoundFont(path);
  } else if (action === 'reset-soundfont') {
    setActiveSoundFont(null);
  }
}

export function initPreview() {
  const pane = document.getElementById('preview-pane');
  if (!pane) return;
  pane.addEventListener('click', onPreviewClick);
  renderPreview();
}
