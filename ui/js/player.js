import { api, mediaUrl } from './api.js';
import { state, scheduleSave, mediaKindOf } from './state.js';
import { icon } from './icons.js';
import { esc, basename, dirname, clamp, fmtDuration, uid } from './util.js';
import { toast, showMenu, promptDialog, confirmDialog } from './dialogs.js';

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

function renderBar() {
  if (!ui) return;
  const item = current();
  ui.name.textContent = item ? item.name : 'Playlist';
  ui.sub.textContent = item ? dirname(item.path) : `${state.media.queue.length} item${state.media.queue.length === 1 ? '' : 's'}`;
  ui.count.textContent = String(state.media.queue.length);
  renderArt(item);
  updatePlayButton();
  updateMuteButton();
  updateQueue();
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
    ui.clear.disabled = true;
    return;
  }
  ui.clear.disabled = false;
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
    added += 1;
  }
  renderBar();
  scheduleSave();
  if (added) {
    toast(`Added ${added} item${added === 1 ? '' : 's'} to the playlist`, {
      type: 'success',
      icon: 'playlist',
      action: { label: 'Show', onClick: () => showQueue() },
    });
  } else if (skipped) {
    toast('Already in the playlist', { type: 'info', icon: 'playlist' });
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

function mergeIntoPlaylist(playlist) {
  const seen = new Set(playlist.items.map((item) => item.path.toLowerCase()));
  let added = 0;
  for (const item of state.media.queue) {
    if (seen.has(item.path.toLowerCase())) continue;
    seen.add(item.path.toLowerCase());
    playlist.items.push({ path: item.path, name: item.name, kind: item.kind });
    added += 1;
  }
  if (!added) {
    toast(`Everything is already in “${playlist.name}”`, { type: 'info', icon: 'playlist' });
    return;
  }
  playlist.updatedAt = Date.now();
  scheduleSave();
  toast(`Saved ${added} item${added === 1 ? '' : 's'} to “${playlist.name}”`, { type: 'success', icon: 'playlist' });
}

async function savePlaylistAs() {
  if (!state.media.queue.length) {
    toast('The playlist is empty — add some audio or video first', { type: 'info', icon: 'playlist' });
    return;
  }
  const name = await promptDialog({
    title: 'Save playlist',
    label: 'Playlist name',
    value: nextPlaylistName(),
    confirmLabel: 'Save',
    hint: 'Saved playlists persist with your settings and can be reopened from the player.',
  });
  if (!name) return;
  const trimmed = name.slice(0, 80);
  const existing = playlistNamed(trimmed);
  if (existing) {
    const replace = await confirmDialog({
      title: 'Replace playlist',
      message: `A playlist named “${existing.name}” already exists. Replace its contents with the current playlist?`,
      confirmLabel: 'Replace',
    });
    if (!replace) return;
    existing.items = copyQueue();
    existing.updatedAt = Date.now();
    scheduleSave();
    toast(`Replaced “${existing.name}”`, { type: 'success', icon: 'playlist' });
    return;
  }
  state.playlists.push({ id: uid(), name: trimmed, items: copyQueue(), updatedAt: Date.now() });
  scheduleSave();
  toast(`Saved “${trimmed}”`, { type: 'success', icon: 'playlist' });
}

export function showSavePlaylistMenu(anchor) {
  if (!state.media.queue.length) {
    toast('The playlist is empty — add some audio or video first', { type: 'info', icon: 'playlist' });
    return;
  }
  if (!state.playlists.length) {
    savePlaylistAs();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  showMenu({
    x: rect.left,
    y: rect.top,
    items: [
      ...state.playlists.map((playlist) => ({
        label: playlist.name,
        icon: 'playlist',
        shortcut: String(playlist.items.length),
        onClick: () => mergeIntoPlaylist(playlist),
      })),
      { separator: true },
      { label: 'Save as new playlist…', icon: 'plus', onClick: () => savePlaylistAs() },
    ],
  });
}

function openPlaylist(playlist) {
  if (!playlist.items.length) {
    toast(`“${playlist.name}” is empty`, { type: 'info', icon: 'playlist' });
    return;
  }
  state.media.queue = playlist.items.map((item) => ({ ...item }));
  state.media.index = 0;
  playIndex(0, { autoplay: false, user: false });
  queueOpen = true;
  updateQueue();
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
  scheduleSave();
  toast(`Deleted “${playlist.name}”`, { type: 'info', icon: 'playlist' });
}

export function showOpenPlaylistsMenu(anchor) {
  if (!state.playlists.length) {
    toast('No saved playlists yet — save the current playlist first', { type: 'info', icon: 'playlist' });
    return;
  }
  const rect = anchor.getBoundingClientRect();
  showMenu({
    x: rect.left,
    y: rect.top,
    items: state.playlists.map((playlist) => ({
      label: playlist.name,
      icon: 'playlist',
      shortcut: String(playlist.items.length),
      submenu: [
        { label: 'Open playlist', icon: 'play', onClick: () => openPlaylist(playlist) },
        { label: 'Add to current playlist', icon: 'plus', onClick: () => addToPlaylist(playlist.items) },
        { separator: true },
        { label: 'Delete playlist', icon: 'trash', danger: true, onClick: () => deletePlaylist(playlist) },
      ],
    })),
  });
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

function stopPlayback() {
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
  queueOpen = false;
  bar.hidden = true;
  renderBar();
  scheduleSave();
  notifyPlayback();
}

function removeAt(index) {
  const list = state.media.queue;
  if (index < 0 || index >= list.length) return;
  const wasCurrent = index === state.media.index;
  const wasPlaying = wasCurrent && !engine.paused;
  list.splice(index, 1);
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
        <span class="player-queue-meta" data-player-queue-meta></span>
        <button class="mini-btn" type="button" data-player="open" title="Open a saved playlist">Open</button>
        <button class="mini-btn" type="button" data-player="save" title="Save the current playlist">Save</button>
        <button class="mini-btn" type="button" data-player="clear">Clear</button>
      </div>
      <div class="player-queue-list" data-player-queue-list></div>
    </div>`;

  ui = {
    art: bar.querySelector('[data-player-art]'),
    name: bar.querySelector('[data-player-name]'),
    sub: bar.querySelector('[data-player-sub]'),
    toggle: bar.querySelector('[data-player="toggle"]'),
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
    clear: bar.querySelector('[data-player="clear"]'),
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
    } else if (action === 'open') {
      showOpenPlaylistsMenu(button);
    } else if (action === 'save') {
      showSavePlaylistMenu(button);
    } else if (action === 'clear') {
      state.media.queue = [];
      stopPlayback();
      toast('Playlist cleared', { type: 'info', icon: 'playlist' });
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
