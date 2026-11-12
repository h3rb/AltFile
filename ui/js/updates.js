import { state } from './state.js';
import { esc } from './util.js';

const API_URL = 'https://api.github.com/repos/h3rb/AltFile/releases/latest';
const RELEASES_URL = 'https://github.com/h3rb/AltFile/releases/latest';
const CACHE_KEY = 'altfe.update.latest';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT = 8000;

const info = { latest: '', url: RELEASES_URL, checkedAt: 0, error: false, checking: false };
const listeners = new Set();

function parseVersion(value) {
  const match = String(value || '').replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(latest, installed) {
  const next = parseVersion(latest);
  const now = parseVersion(installed);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

function current() {
  return { ...info, available: isNewer(info.latest, state.app?.version) };
}

function notify() {
  const snapshot = current();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

function loadCache() {
  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!stored || typeof stored.latest !== 'string') return;
    info.latest = stored.latest;
    info.url = typeof stored.url === 'string' && stored.url ? stored.url : RELEASES_URL;
    info.checkedAt = Number(stored.checkedAt) || 0;
  } catch {}
}

function saveCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ latest: info.latest, url: info.url, checkedAt: info.checkedAt })
    );
  } catch {}
}

export function updateInfo() {
  return current();
}

export function onUpdate(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updatePillHtml() {
  const update = current();
  if (!update.available) return '';
  return `<span class="update-pill" title="Update available: ${esc(update.latest)}">${esc(update.latest)}</span>`;
}

export async function checkForUpdates({ force = false } = {}) {
  if (info.checking) return current();
  if (!force && info.checkedAt && Date.now() - info.checkedAt < CHECK_INTERVAL) return current();
  info.checking = true;
  notify();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const response = await fetch(API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const release = await response.json();
    info.latest = String(release.tag_name || '');
    info.url = String(release.html_url || RELEASES_URL);
    info.checkedAt = Date.now();
    info.error = false;
    saveCache();
  } catch {
    info.error = true;
  } finally {
    clearTimeout(timer);
    info.checking = false;
    notify();
  }
  return current();
}

export function initUpdates(listener) {
  if (listener) listeners.add(listener);
  loadCache();
  notify();
  checkForUpdates().catch(() => {});
}
