const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function humanSize(bytes, digits = 1) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 ? 0 : digits;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

export function humanCount(n) {
  return (Number(n) || 0).toLocaleString();
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit' });

export function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return shortDateFmt.format(d);
  return dateFmt.format(d);
}

export function fmtFullDate(ms) {
  if (!ms) return '—';
  return dateFmt.format(new Date(ms));
}

export function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtRelative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(ms);
}

export function basename(path, sep = '\\') {
  if (!path) return '';
  const clean = path.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function dirname(path) {
  if (!path) return '';
  const clean = path.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  if (idx < 0) return '';
  const parent = clean.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent || (clean.startsWith('/') ? '/' : '');
}

export function joinPath(dir, name) {
  if (!dir) return name;
  if (dir.endsWith('\\') || dir.endsWith('/')) return dir + name;
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;
}

export function splitPath(path, sep = '\\') {
  if (!path) return [];
  let normalized = path.replace(/[\\/]/g, sep);
  const parts = [];

  if (sep === '\\') {
    const drive = normalized.match(/^([A-Za-z]:)(\\|$)/);
    if (drive) {
      let current = `${drive[1]}\\`;
      parts.push({ label: drive[1], path: current });
      normalized = normalized.slice(drive[0].length).replace(/^\\+/, '');
    } else if (normalized.startsWith('\\\\')) {
      const bits = normalized.slice(2).split('\\').filter(Boolean);
      if (bits.length) {
        let current = `\\\\${bits[0]}\\`;
        parts.push({ label: bits[0], path: current });
        if (bits[1]) {
          current = `\\\\${bits[0]}\\${bits[1]}\\`;
          parts.push({ label: bits[1], path: current });
          normalized = bits.slice(2).join('\\');
        } else {
          normalized = '';
        }
      }
    }
  } else {
    parts.push({ label: '/', path: '/' });
    normalized = normalized.replace(/^\/+/, '');
  }

  let current = parts.length ? parts[parts.length - 1].path : '';
  for (const bit of normalized.split(sep).filter(Boolean)) {
    current = current.endsWith(sep) ? current + bit : `${current}${sep}${bit}`;
    parts.push({ label: bit, path: current });
  }
  return parts;
}

export function naturalCompare(a, b) {
  return collator.compare(a, b);
}

export function fuzzy(name, query) {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (n === q) {
    return { score: 4000, indices: Array.from({ length: n.length }, (_, i) => i) };
  }
  if (n.startsWith(q)) {
    return { score: 2600 - n.length, indices: Array.from({ length: q.length }, (_, i) => i) };
  }
  const at = n.indexOf(q);
  if (at >= 0) {
    return {
      score: 1800 - at * 4 - (n.length - q.length),
      indices: Array.from({ length: q.length }, (_, i) => at + i),
    };
  }
  let qi = 0;
  let streak = 0;
  let bonus = 0;
  const indices = [];
  for (let i = 0; i < n.length && qi < q.length; i += 1) {
    if (n[i] === q[qi]) {
      indices.push(i);
      streak += 1;
      bonus += streak * 3;
      qi += 1;
    } else {
      streak = 0;
    }
  }
  if (qi !== q.length) return null;
  return { score: 500 + bonus - n.length, indices };
}

export function highlightName(name, indices) {
  if (!indices || !indices.length) return esc(name);
  const set = new Set(indices);
  let out = '';
  let buffer = '';
  let inMark = false;
  for (let i = 0; i < name.length; i += 1) {
    const marked = set.has(i);
    if (marked !== inMark) {
      out += inMark ? `<mark>${esc(buffer)}</mark>` : esc(buffer);
      buffer = '';
      inMark = marked;
    }
    buffer += name[i];
  }
  out += inMark ? `<mark>${esc(buffer)}</mark>` : esc(buffer);
  return out;
}

export const KIND_LABELS = {
  folder: 'Folder',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  code: 'Code',
  doc: 'Document',
  archive: 'Archive',
  exe: 'Program',
  font: 'Font',
  file: 'File',
  other: 'Group',
};

export const KIND_COLORS = {
  folder: '#5eead4',
  image: '#2dd4bf',
  video: '#818cf8',
  audio: '#e879f9',
  code: '#60a5fa',
  doc: '#fbbf24',
  archive: '#fb923c',
  exe: '#f87171',
  font: '#a78bfa',
  file: '#94a3b8',
  other: '#64748b',
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] || 'File';
}

export function kindColor(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.file;
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml',
  'toml', 'xml', 'ini', 'cfg', 'conf', 'env', 'rs', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'py', 'rb', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs',
  'php', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'bat',
  'cmd', 'lua', 'r', 'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro', 'gradle', 'cmake', 'gitignore', 'dockerfile',
]);

export function isTextEntry(entry) {
  if (!entry || entry.isDir) return false;
  return TEXT_EXTS.has((entry.ext || '').toLowerCase());
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function percent(part, total) {
  if (!total) return '0%';
  const value = (part / total) * 100;
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function sumSizes(entries) {
  return (entries || []).reduce((total, entry) => total + (entry.size || 0), 0);
}

export function isPathLike(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('~') || value.startsWith('\\\\');
}
