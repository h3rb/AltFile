import { api } from './api.js';
import { joinPath } from './util.js';

const WINDOWS = /Windows/i.test(navigator.userAgent);
const ABSOLUTE = /^[A-Za-z]:[\\/]|^[\\/]|^\\\\/;

export function looksLikePath(text) {
  return /[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || text === '.' || text === '..'
    || text.startsWith('~') || text.startsWith('./') || text.startsWith('../');
}

function expandHome(text, home) {
  if (!home) return text;
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return joinPath(home, text.slice(2));
  return text;
}

function splitAtLastSeparator(value) {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return index < 0
    ? { dir: '', fragment: value }
    : { dir: value.slice(0, index + 1), fragment: value.slice(index + 1) };
}

function commonPrefix(names) {
  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (!name.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

// Returns the completed text, or null when the input cannot be extended.
export async function completePath(text, base, showHidden, home) {
  if (!text) return null;
  const value = expandHome(text, home);
  const { dir, fragment } = splitAtLastSeparator(value);
  const target = dir
    ? (ABSOLUTE.test(dir) ? dir : (base ? joinPath(base, dir) : ''))
    : base;
  if (!target) return null;
  let listing;
  try {
    listing = await api.listDir(target, showHidden);
  } catch {
    return null;
  }
  const matches = listing.entries.filter((entry) => (WINDOWS
    ? entry.name.toLowerCase().startsWith(fragment.toLowerCase())
    : entry.name.startsWith(fragment)));
  if (!matches.length) return null;
  const separator = value.includes('/') ? '/' : (value.includes('\\') ? '\\' : (WINDOWS ? '\\' : '/'));
  const completed = matches.length === 1
    ? `${matches[0].name}${matches[0].isDir ? separator : ''}`
    : commonPrefix(matches.map((entry) => entry.name));
  const next = `${dir}${completed}`;
  return next === text ? null : next;
}
