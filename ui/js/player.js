import { api, mediaUrl } from './api.js';
import { state, app, scheduleSave, mediaKindOf } from './state.js';
import { icon } from './icons.js';
import { esc, basename, dirname, clamp, fmtDuration, themeColor, uid } from './util.js';
import { toast, showMenu, confirmDialog } from './dialogs.js';

const AUDIO = 'audio';
const VIDEO = 'video';

let bar = null;
let engine = null;
let ui = null;
let duration = 0;
let seeking = false;
let queueOpen = false;
let artToken = 0;
let userInitiated = false;
let suppressError = false;
let pendingSeek = null;
let audioCtx = null;
let analyser = null;
let freqData = null;
let beatLevel = 0;
let beatAvg = 0;
let lastBeatAt = 0;
let pulseFrame = 0;
let timeData = null;
let scopeCanvas = null;
let scopeCtx = null;
let scopePath = null;
let scopeTriedAt = 0;
const playbackListeners = new Set();

function current() {
  const index = state.media.index;
  return index >= 0 ? state.media.queue[index] || null : null;
}

function playbackSnapshot() {
  const item = current();
  return {
    path: item ? item.path : null,
    playing: Boolean(engine && !engine.paused && !engine.ended),
    time: engine ? Number(engine.currentTime) || 0 : 0,
    duration,
  };
}

function notifyPlayback() {
  if (!playbackListeners.size) return;
  const snapshot = playbackSnapshot();
  for (const listener of playbackListeners) {
    try {
      listener(snapshot);
    } catch {
      /* a preview listener must not break playback */
    }
  }
}

export function onPlayback(listener) {
  playbackListeners.add(listener);
  listener(playbackSnapshot());
  return () => playbackListeners.delete(listener);
}

function ensureAnalyser() {
  if (analyser) return true;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return false;
  try {
    audioCtx = new Ctx();
    const source = audioCtx.createMediaElementSource(engine);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.45;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    return true;
  } catch {
    analyser = null;
    return false;
  }
}

function setBeat(value) {
  beatLevel = value;
  document.documentElement.style.setProperty('--beat', value.toFixed(3));
}

function stopPulse() {
  if (pulseFrame) cancelAnimationFrame(pulseFrame);
  pulseFrame = 0;
  beatAvg = 0;
  lastBeatAt = 0;
  setBeat(0);
  detachScope();
}

function detachScope() {
  scopeCanvas?.remove();
  scopeCanvas = null;
  scopeCtx = null;
  scopePath = null;
}

function mountScope() {
  const item = current();
  if (!item || item.kind !== AUDIO) return false;
  if (scopeCanvas && scopePath === item.path && scopeCanvas.isConnected) return true;
  detachScope();
  const now = performance.now();
  if (now - scopeTriedAt < 400) return false;
  scopeTriedAt = now;
  const thumb = [...document.querySelectorAll('.files-grid .file-card')]
    .find((card) => samePath(card.getAttribute('data-path') || '', item.path))
    ?.querySelector('.card-thumb');
  if (!thumb) return false;
  const canvas = document.createElement('canvas');
  canvas.className = 'card-scope';
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  thumb.append(canvas);
  scopeCanvas = canvas;
  scopeCtx = ctx;
  scopePath = item.path;
  return true;
}

function drawScope() {
  if (!analyser || !freqData || !timeData || !mountScope()) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(scopeCanvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(scopeCanvas.clientHeight * dpr));
  if (scopeCanvas.width !== width || scopeCanvas.height !== height) {
    scopeCanvas.width = width;
    scopeCanvas.height = height;
  }
  const ctx = scopeCtx;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(6, 10, 14, 0.78)';
  ctx.fillRect(0, 0, width, height);

  const bars = Math.max(16, Math.round(width / (7 * dpr)));
  const maxBin = Math.floor(freqData.length * 0.62);
  const slot = width / bars;
  for (let i = 0; i < bars; i += 1) {
    const t = (i + 0.5) / bars;
    const bin = Math.max(1, Math.min(maxBin, Math.round(t * t * maxBin)));
    const value = freqData[bin] / 255;
    const barHeight = Math.max(1, value * height * 0.74);
    ctx.fillStyle = themeColor(0.18 + value * 0.62);
    ctx.fillRect(i * slot + slot * 0.2, height - barHeight, slot * 0.6, barHeight);
  }

  analyser.getByteTimeDomainData(timeData);
  const points = Math.min(160, Math.round(width / 2));
  ctx.beginPath();
  for (let i = 0; i <= points; i += 1) {
    const sample = timeData[Math.floor((i / points) * (timeData.length - 1))];
    const x = (i / points) * width;
    const y = height / 2 + ((sample - 128) / 128) * height * 0.36;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeStyle = 'rgba(226, 255, 250, 0.86)';
  ctx.stroke();
}

export function startPulse() {
  if (pulseFrame || !engine) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  if (!ensureAnalyser()) return;
  audioCtx?.resume?.().catch(() => {});
  const tick = () => {
    if (!engine || engine.paused || engine.ended || engine.muted || engine.volume === 0) {
      pulseFrame = 0;
      setBeat(0);
      return;
    }
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    for (let i = 1; i <= 5; i += 1) sum += freqData[i];
    const energy = sum / (5 * 255);
    const now = performance.now();
    if (
      now - lastBeatAt > 110 &&
      energy > 0.14 &&
      energy > beatAvg * 1.4 + 0.02
    ) {
      lastBeatAt = now;
      beatLevel = Math.min(1, 0.5 + energy);
    }
    beatAvg += (energy - beatAvg) * 0.07;
    setBeat(beatLevel);
    beatLevel *= 0.9;
    drawScope();
    pulseFrame = requestAnimationFrame(tick);
  };
  pulseFrame = requestAnimationFrame(tick);
}

export function seekPlayback(seconds) {
  if (!engine || !current() || !Number.isFinite(seconds)) return false;
  const max = Number.isFinite(engine.duration) && engine.duration > 0 ? engine.duration : duration;
  try {
    engine.currentTime = clamp(seconds, 0, max || seconds);
  } catch {
    return false;
  }
  notifyPlayback();
  return true;
}

function itemFor(entry) {
  const kind = mediaKindOf(entry.path, entry.kind);
  if (!kind) return null;
  return {
    path: entry.path,
    name: entry.name || basename(entry.path),
    kind,
  };
}

function samePath(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function findIndex(path) {
  return state.media.queue.findIndex((item) => samePath(item.path, path));
}

function selectedPlaylist() {
  return state.playlists.find((playlist) => playlist.id === state.selectedPlaylistId) || null;
}

function renderBar() {
  if (!ui) return;
  const item = current();
  const playlist = selectedPlaylist();
  ui.name.textContent = item ? item.name : 'Playlist';
  ui.sub.textContent = item ? dirname(item.path) : `${state.media.queue.length} item${state.media.queue.length === 1 ? '' : 's'}`;
  ui.count.textContent = String(state.media.queue.length);
  ui.playlistName.textContent = playlist ? playlist.name : 'No playlist';
  ui.playlistPick.title = playlist ? `Playlist: ${playlist.name}` : 'Choose a playlist';
  renderArt(item);
  updatePlayButton();
  updateMuteButton();
  syncLoopButtons();
  updateQueue();
}

function syncLoopButtons() {
  const on = state.media.loop;
  if (ui?.loop) {
    ui.loop.classList.toggle('active', on);
    ui.loop.setAttribute('aria-pressed', String(on));
    ui.loop.title = on ? 'Loop current file: on' : 'Loop current file: off';
  }
  for (const button of document.querySelectorAll('.preview-actions [data-action="loop"]')) {
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Loop current file: on' : 'Loop current file: off';
  }
}

export function isLooping() {
  return state.media.loop;
}

export function setLoop(enabled) {
  state.media.loop = typeof enabled === 'boolean' ? enabled : !state.media.loop;
  scheduleSave();
  syncLoopButtons();
  return state.media.loop;
}

function renderArt(item) {
  if (!ui) return;
  const token = ++artToken;
  ui.art.innerHTML = icon(item ? (item.kind === VIDEO ? 'video' : 'music') : 'playlist', 16);
  ui.art.classList.toggle('empty', !item);
  if (!item) return;
  api
    .thumbnail(item.path, 96)
    .then((info) => {
      if (token !== artToken || !info || !info.url) return;
      ui.art.innerHTML = `<img src="${esc(info.url)}" alt="">`;
    })
    .catch(() => {});
}

function updatePlayButton() {
  if (!ui || !engine) return;
  const paused = engine.paused || engine.ended;
  ui.toggle.innerHTML = icon(paused ? 'play' : 'pause', 16);
  ui.toggle.title = paused ? 'Play (Space)' : 'Pause (Space)';
  ui.toggle.classList.toggle('playing', !paused);
}

function updateMuteButton() {
  if (!ui || !engine) return;
  const muted = engine.muted || engine.volume === 0;
  ui.mute.innerHTML = icon(muted ? 'volumeX' : 'volume', 15);
  ui.mute.title = muted ? 'Unmute' : 'Mute';
  ui.volume.value = String(state.media.volume);
}

function paintSeek(frac, seconds) {
  if (!ui) return;
  const value = clamp(frac, 0, 1);
  ui.fill.style.width = `${value * 100}%`;
  ui.current.textContent = fmtDuration(seconds || 0);
  if (!seeking) ui.range.value = String(Math.round(value * 1000));
}

function setDuration(value) {
  duration = Number.isFinite(value) && value > 0 ? value : 0;
  if (!ui) return;
  ui.total.textContent = duration ? fmtDuration(duration) : '0:00';
  ui.range.disabled = !duration;
  updateQueue();
}

function updateQueue() {
  if (!ui) return;
  if (queueOpen) {
    ui.queue.hidden = false;
    requestAnimationFrame(() => ui.queue.classList.add('open'));
    renderQueue();
  } else {
    ui.queue.classList.remove('open');
    ui.queue.hidden = true;
  }
  ui.queueBtn.classList.toggle('active', queueOpen);
}

function renderQueue() {
  if (!ui || !queueOpen) return;
  const items = state.media.queue;
  ui.queueMeta.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  if (!items.length) {
    ui.queueList.innerHTML = '<div class="pq-empty">The playlist is empty. Add audio or video from the preview pane or the file menu.</div>';
    return;
  }
  ui.queueList.innerHTML = items
    .map((item, index) => {
      const active = index === state.media.index;
      return `
        <div class="pq-item${active ? ' active' : ''}" data-queue-index="${index}">
          <span class="pq-icon">${icon(item.kind === VIDEO ? 'video' : 'music', 14)}</span>
          <span class="pq-text">
            <span class="pq-name">${esc(item.name)}</span>
            <span class="pq-sub">${esc(dirname(item.path) || item.path)}</span>
          </span>
          ${active ? '<span class="pq-now">playing</span>' : ''}
          <button class="pq-remove" type="button" data-queue-remove="${index}" title="Remove from playlist" aria-label="Remove from playlist">${icon('x', 11)}</button>
        </div>`;
    })
    .join('');
  ui.queueList.querySelector('.pq-item.active')?.scrollIntoView({ block: 'nearest' });
}

function playIndex(index, { autoplay = true, user = true, startAt = null } = {}) {
  const list = state.media.queue;
  if (!list.length) return;
  const next = clamp(index, 0, list.length - 1);
  const item = list[next];
  state.media.index = next;
  userInitiated = user;
  suppressError = false;
  pendingSeek = Number.isFinite(startAt) ? Math.max(0, startAt) : null;
  duration = 0;
  setDuration(0);
  paintSeek(0, 0);
  bar.hidden = false;
  renderBar();
  engine.src = mediaUrl(item.path);
  engine.load();
  engine.volume = state.media.volume;
  engine.muted = state.media.muted;
  if (autoplay) {
    engine.play().catch((error) => {
      if (error && (error.name === 'AbortError' || error.name === 'NotAllowedError')) return;
    });
  } else {
    updatePlayButton();
  }
  scheduleSave();
  notifyPlayback();
}

export function playEntry(entry, { autoplay = true, startAt = null } = {}) {
  const item = itemFor(entry);
  if (!item) {
    toast('Only audio and video files can be played', { type: 'warn' });
    return;
  }
  let index = findIndex(item.path);
  if (index < 0) {
    index = state.media.index >= 0
      ? state.media.index + 1
      : state.media.queue.length;
    state.media.queue.splice(index, 0, item);
    if (state.media.index >= index) state.media.index += 1;
    renderQueue();
  }
  playIndex(index, { autoplay, startAt });
}

export function addToPlaylist(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  const addedItems = [];
  let added = 0;
  let skipped = 0;
  for (const entry of list) {
    const item = itemFor(entry);
    if (!item) {
      skipped += 1;
      continue;
    }
    if (findIndex(item.path) >= 0) {
      skipped += 1;
      continue;
    }
    state.media.queue.push(item);
    addedItems.push(item);
    added += 1;
  }

  let playlist = selectedPlaylist();
  let created = false;
  if (added) {
    if (!playlist) {
      playlist = { id: uid(), name: nextPlaylistName(), items: copyQueue(), updatedAt: Date.now() };
      state.playlists.push(playlist);
      state.selectedPlaylistId = playlist.id;
      created = true;
    } else {
      const seen = new Set(playlist.items.map((item) => item.path.toLowerCase()));
      for (const item of addedItems) {
        const key = item.path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        playlist.items.push({ path: item.path, name: item.name, kind: item.kind });
      }
      playlist.updatedAt = Date.now();
    }
    scheduleSave();
    app.renderSidebar?.();
  }

  renderBar();
  if (added) {
    toast(
      created
        ? `Created “${playlist.name}” with ${added} item${added === 1 ? '' : 's'}`
        : `Added ${added} item${added === 1 ? '' : 's'} to “${playlist.name}”`,
      { type: 'success', icon: 'playlist', action: { label: 'Show', onClick: () => showQueue() } }
    );
  } else if (skipped) {
    toast('Already in the playlist', { type: 'info', icon: 'playlist' });
  }
  return added;
}

export function addPathsToPlaylist(playlistId, paths) {
  const playlist = state.playlists.find((entry) => entry.id === playlistId);
  if (!playlist) return 0;
  const seen = new Set(playlist.items.map((item) => item.path.toLowerCase()));
  let added = 0;
  let invalid = 0;
  let duplicate = 0;
  for (const raw of Array.isArray(paths) ? paths : [paths]) {
    const path = String(raw || '');
    if (!path) continue;
    const kind = mediaKindOf(path);
    if (!kind) {
      invalid += 1;
      continue;
    }
    const key = path.toLowerCase();
    if (seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    playlist.items.push({ path, name: basename(path), kind });
    added += 1;
  }
  if (added) {
    playlist.updatedAt = Date.now();
    scheduleSave();
    app.renderSidebar?.();
    toast(`Added ${added} item${added === 1 ? '' : 's'} to “${playlist.name}”`, {
      type: 'success',
      icon: 'playlist',
    });
  } else if (duplicate) {
    toast('Already in the playlist', { type: 'info', icon: 'playlist' });
  } else if (invalid) {
    toast('Only audio and video files can be added to a playlist', { type: 'warn' });
  }
  return added;
}

function copyQueue() {
  return state.media.queue.map((item) => ({ path: item.path, name: item.name, kind: item.kind }));
}

function playlistNamed(name) {
  const key = name.toLowerCase();
  return state.playlists.find((playlist) => playlist.name.toLowerCase() === key) || null;
}

function nextPlaylistName() {
  let index = state.playlists.length + 1;
  while (playlistNamed(`Playlist ${index}`)) index += 1;
  return `Playlist ${index}`;
}

function selectPlaylist(playlist, { index = 0, autoplay = false } = {}) {
  if (!playlist) return;
  state.selectedPlaylistId = playlist.id;
  state.media.queue = playlist.items.map((item) => ({ ...item }));
  if (state.media.queue.length) {
    state.media.index = clamp(index, 0, state.media.queue.length - 1);
    playIndex(state.media.index, { autoplay, user: autoplay });
  } else {
    state.media.index = -1;
    clearEngine();
    renderBar();
  }
  bar.hidden = false;
  queueOpen = true;
  renderBar();
  updateQueue();
  scheduleSave();
  app.renderSidebar?.();
}

export function openPlaylistById(id) {
  selectPlaylist(state.playlists.find((playlist) => playlist.id === id));
}

export function playPlaylistTrack(id, index) {
  const playlist = state.playlists.find((item) => item.id === id);
  if (!playlist || !playlist.items.length) return;
  selectPlaylist(playlist, { index, autoplay: true });
}

function startNewPlaylist() {
  state.selectedPlaylistId = null;
  state.media.queue = [];
  state.media.index = -1;
  clearEngine();
  bar.hidden = false;
  queueOpen = true;
  renderBar();
  updateQueue();
  scheduleSave();
  app.renderSidebar?.();
}

export function newPlaylist() {
  const playlist = { id: uid(), name: nextPlaylistName(), items: [], updatedAt: Date.now() };
  state.playlists.push(playlist);
  state.selectedPlaylistId = playlist.id;
  scheduleSave();
  app.renderSidebar?.();
  renderBar();
  toast(`Created “${playlist.name}”`, { type: 'success', icon: 'playlist' });
  return playlist;
}

function showPlaylistPicker(anchor) {
  const playlist = selectedPlaylist();
  const items = state.playlists.map((entry) => ({
    label: entry.name,
    icon: entry.id === state.selectedPlaylistId ? 'check' : 'playlist',
    shortcut: String(entry.items.length),
    onClick: () => selectPlaylist(entry),
  }));
  if (items.length) items.push({ separator: true });
  items.push({ label: 'New playlist', icon: 'plus', onClick: () => startNewPlaylist() });
  if (playlist) {
    items.push({ separator: true });
    items.push({
      label: `Delete “${playlist.name}”`,
      icon: 'trash',
      danger: true,
      onClick: () => deletePlaylist(playlist),
    });
  }
  const rect = anchor.getBoundingClientRect();
  showMenu({ x: rect.left, y: rect.top, items });
}

async function deletePlaylist(playlist) {
  const ok = await confirmDialog({
    title: 'Delete playlist',
    message: `Delete “${playlist.name}” from your saved playlists?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  state.playlists = state.playlists.filter((item) => item.id !== playlist.id);
  if (state.selectedPlaylistId === playlist.id) state.selectedPlaylistId = null;
  scheduleSave();
  app.renderSidebar?.();
  renderBar();
  toast(`Deleted “${playlist.name}”`, { type: 'info', icon: 'playlist' });
}

export function togglePlay() {
  if (!engine) return;
  if (!current()) {
    if (state.media.queue.length) playIndex(Math.max(0, state.media.index), { autoplay: true });
    return;
  }
  if (engine.paused || engine.ended) {
    if (engine.ended) engine.currentTime = 0;
    engine.play().catch(() => {});
  } else {
    engine.pause();
  }
}

function step(delta, wrap) {
  const list = state.media.queue;
  if (!list.length) return;
  let next = state.media.index + delta;
  if (wrap) {
    next = (next + list.length) % list.length;
  } else if (next >= list.length) {
    engine.pause();
    engine.currentTime = duration || 0;
    updatePlayButton();
    return;
  } else if (next < 0) {
    next = 0;
  }
  playIndex(next, { autoplay: true });
}

function clearEngine() {
  if (!engine) return;
  suppressError = true;
  pendingSeek = null;
  stopPulse();
  engine.pause();
  engine.removeAttribute('src');
  engine.load();
  duration = 0;
  state.media.index = -1;
  state.media.playing = false;
}

function stopPlayback() {
  if (!engine) return;
  clearEngine();
  queueOpen = false;
  bar.hidden = true;
  renderBar();
  scheduleSave();
  notifyPlayback();
}

function removeAt(index) {
  const list = state.media.queue;
  if (index < 0 || index >= list.length) return;
  const removed = list[index];
  const wasCurrent = index === state.media.index;
  const wasPlaying = wasCurrent && !engine.paused;
  list.splice(index, 1);
  const playlist = selectedPlaylist();
  if (playlist) {
    playlist.items = playlist.items.filter((item) => !samePath(item.path, removed.path));
    playlist.updatedAt = Date.now();
    app.renderSidebar?.();
  }
  if (!list.length) {
    stopPlayback();
    return;
  }
  if (wasCurrent) {
    state.media.index = clamp(index, 0, list.length - 1);
    playIndex(state.media.index, { autoplay: wasPlaying });
  } else if (index < state.media.index) {
    state.media.index -= 1;
  }
  renderBar();
  scheduleSave();
}

export function showQueue() {
  if (!bar) return;
  if (!state.media.queue.length) {
    toast('The playlist is empty', { type: 'info', icon: 'playlist' });
    return;
  }
  bar.hidden = false;
  if (!current()) {
    playIndex(clamp(state.media.index, 0, state.media.queue.length - 1), {
      autoplay: false,
      user: false,
    });
  }
  queueOpen = true;
  renderBar();
}

export function hasQueue() {
  return state.media.queue.length > 0;
}

export function initPlayer() {
  bar = document.getElementById('player-bar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="player-inner">
      <div class="player-now">
        <span class="player-art empty" data-player-art></span>
        <span class="player-now-text">
          <span class="player-name" data-player-name>Playlist</span>
          <span class="player-sub" data-player-sub></span>
        </span>
      </div>
      <div class="player-controls">
        <button class="player-btn" type="button" data-player="prev" title="Previous">${icon('skipBack', 15)}</button>
        <button class="player-btn player-play" type="button" data-player="toggle" title="Play (Space)">${icon('play', 16)}</button>
        <button class="player-btn" type="button" data-player="next" title="Next">${icon('skipForward', 15)}</button>
        <button class="player-btn player-loop-btn" type="button" data-player="loop" aria-pressed="${state.media.loop}" title="Loop current file: ${state.media.loop ? 'on' : 'off'}">${icon('repeat', 15)}</button>
      </div>
      <div class="player-timeline">
        <span class="player-time" data-player-current>0:00</span>
        <div class="player-track">
          <div class="player-fill" data-player-fill></div>
          <input class="player-range" data-player-range type="range" min="0" max="1000" step="1" value="0" disabled aria-label="Seek">
        </div>
        <span class="player-time" data-player-total>0:00</span>
      </div>
      <div class="player-aside">
        <button class="player-btn" type="button" data-player="mute" title="Mute">${icon('volume', 15)}</button>
        <input class="player-volume" data-player-volume type="range" min="0" max="1" step="0.01" value="${state.media.volume}" aria-label="Volume">
        <button class="player-btn player-queue-btn" type="button" data-player="queue" title="Playlist">
          ${icon('list', 15)}<span class="player-count" data-player-count>0</span>
        </button>
        <button class="player-btn" type="button" data-player="close" title="Stop and close player">${icon('x', 14)}</button>
      </div>
    </div>
    <div class="player-queue" data-player-queue hidden>
      <div class="player-queue-head">
        <span>Playlist</span>
        <button class="player-playlist-pick" type="button" data-player="pick" title="Choose a playlist">
          <span data-player-playlist>No playlist</span>
          ${icon('chevronDown', 12)}
        </button>
        <span class="player-queue-meta" data-player-queue-meta></span>
      </div>
      <div class="player-queue-list" data-player-queue-list></div>
    </div>`;

  ui = {
    art: bar.querySelector('[data-player-art]'),
    name: bar.querySelector('[data-player-name]'),
    sub: bar.querySelector('[data-player-sub]'),
    toggle: bar.querySelector('[data-player="toggle"]'),
    loop: bar.querySelector('[data-player="loop"]'),
    mute: bar.querySelector('[data-player="mute"]'),
    volume: bar.querySelector('[data-player-volume]'),
    range: bar.querySelector('[data-player-range]'),
    fill: bar.querySelector('[data-player-fill]'),
    current: bar.querySelector('[data-player-current]'),
    total: bar.querySelector('[data-player-total]'),
    count: bar.querySelector('[data-player-count]'),
    queueBtn: bar.querySelector('[data-player="queue"]'),
    queue: bar.querySelector('[data-player-queue]'),
    queueList: bar.querySelector('[data-player-queue-list]'),
    queueMeta: bar.querySelector('[data-player-queue-meta]'),
    playlistPick: bar.querySelector('[data-player="pick"]'),
    playlistName: bar.querySelector('[data-player-playlist]'),
  };

  engine = document.createElement('video');
  engine.className = 'media-engine';
  engine.preload = 'metadata';
  engine.playsInline = true;
  engine.crossOrigin = 'anonymous';
  document.body.append(engine);

  engine.addEventListener('loadedmetadata', () => {
    if (pendingSeek != null) {
      const maxTime = Number.isFinite(engine.duration)
        ? Math.max(0, engine.duration - 0.05)
        : pendingSeek;
      engine.currentTime = Math.min(pendingSeek, maxTime);
      pendingSeek = null;
    }
    setDuration(engine.duration);
    paintSeek(duration ? engine.currentTime / duration : 0, engine.currentTime);
    renderBar();
    notifyPlayback();
  });
  engine.addEventListener('durationchange', () => {
    setDuration(engine.duration);
    notifyPlayback();
  });
  engine.addEventListener('timeupdate', () => {
    if (!duration) setDuration(engine.duration);
    paintSeek(duration ? engine.currentTime / duration : 0, engine.currentTime);
    notifyPlayback();
  });
  engine.addEventListener('play', () => {
    state.media.playing = true;
    updatePlayButton();
    notifyPlayback();
    startPulse();
  });
  engine.addEventListener('pause', () => {
    state.media.playing = false;
    updatePlayButton();
    notifyPlayback();
    stopPulse();
  });
  engine.addEventListener('ended', () => {
    state.media.playing = false;
    updatePlayButton();
    notifyPlayback();
    stopPulse();
    if (state.media.loop) {
      engine.currentTime = 0;
      engine.play().catch(() => {});
      return;
    }
    if (state.media.index < state.media.queue.length - 1) {
      playIndex(state.media.index + 1, { autoplay: true });
    }
  });
  engine.addEventListener('volumechange', () => {
    state.media.volume = engine.muted ? state.media.volume : engine.volume;
    state.media.muted = engine.muted;
    updateMuteButton();
    if (!engine.paused && !engine.ended) {
      if (engine.muted || engine.volume === 0) stopPulse();
      else startPulse();
    }
    scheduleSave();
  });
  engine.addEventListener('error', () => {
    if (suppressError || !current()) return;
    state.media.playing = false;
    updatePlayButton();
    stopPulse();
    if (userInitiated) {
      const item = current();
      toast(`Can't play “${item.name}” — the format may not be supported.`, { type: 'error' });
    }
  });

  bar.addEventListener('click', (event) => {
    const queueItem = event.target.closest('[data-queue-index]');
    const remove = event.target.closest('[data-queue-remove]');
    if (remove) {
      event.stopPropagation();
      removeAt(Number(remove.dataset.queueRemove));
      return;
    }
    if (queueItem) {
      const index = Number(queueItem.dataset.queueIndex);
      queueOpen = false;
      playIndex(index, { autoplay: true });
      return;
    }

    const button = event.target.closest('[data-player]');
    if (!button) return;
    const action = button.dataset.player;
    if (action === 'toggle') togglePlay();
    else if (action === 'prev') step(-1, true);
    else if (action === 'next') step(1, true);
    else if (action === 'loop') setLoop();
    else if (action === 'mute') {
      engine.muted = !engine.muted;
      updateMuteButton();
    } else if (action === 'queue') {
      if (queueOpen) {
        queueOpen = false;
        updateQueue();
      } else {
        showQueue();
      }
    } else if (action === 'pick') {
      showPlaylistPicker(button);
    } else if (action === 'close') {
      stopPlayback();
    }
  });

  ui.range.addEventListener('input', () => {
    seeking = true;
    if (!duration) return;
    const frac = Number(ui.range.value) / 1000;
    engine.currentTime = frac * duration;
    paintSeek(frac, frac * duration);
  });
  ui.range.addEventListener('change', () => {
    seeking = false;
  });
  ui.range.addEventListener('pointerup', () => {
    seeking = false;
  });

  ui.volume.addEventListener('input', () => {
    const value = clamp(Number(ui.volume.value) || 0, 0, 1);
    state.media.volume = value;
    engine.volume = value;
    if (value > 0 && engine.muted) engine.muted = false;
    updateMuteButton();
  });

  document.addEventListener('pointerdown', (event) => {
    if (!queueOpen || bar.contains(event.target) || event.target.closest?.('.menu-layer')) return;
    queueOpen = false;
    updateQueue();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && queueOpen) {
      queueOpen = false;
      updateQueue();
    }
  });

  engine.volume = state.media.volume;
  engine.muted = state.media.muted;

  if (state.media.queue.length) {
    if (state.media.index < 0) state.media.index = 0;
    playIndex(state.media.index, { autoplay: false, user: false });
  } else {
    bar.hidden = true;
    renderBar();
  }
}
