import { Terminal } from '../assets/vendor/xterm-6.0.0.mjs';
import { FitAddon } from '../assets/vendor/xterm-addon-fit-0.11.0.mjs';
import { api } from './api.js';
import { state, activeTab } from './state.js';
import { icon } from './icons.js';
import { commandForEvent, shortcutLabel, shortcutTitle } from './keyboard.js';

let terminal = null;
let fit = null;
let observer = null;
let shellOptions = null;
let shellIndex = 0;
let sessionId = null;
let generation = 0;
let lifecycle = Promise.resolve();
let inputQueue = Promise.resolve();
let pendingInput = [];
let pendingBytes = 0;
let queuedBytes = 0;
let ready = false;
let acceptingInput = false;
let choosingShell = true;
let startPath = '';

const pane = () => document.getElementById('terminal-pane');
const hint = (text) => { document.getElementById('terminal-hint').textContent = text; };

function shellHint() {
  return choosingShell
    ? `${shortcutLabel('terminalChoose') || 'Shell button'} switch shell before typing · ${shortcutLabel('terminalCycle') || 'Shell button'} anytime`
    : `${shortcutLabel('terminalCycle') || 'Shell button'} switch shell · ${shortcutLabel('terminalClose') || 'Close button'} close`;
}

export function refreshTerminalShortcuts() {
  document.getElementById('terminal-close').title = shortcutTitle('Close terminal', 'terminalClose');
  document.getElementById('terminal-shell').title = shortcutTitle('Switch shell', 'terminalCycle');
  if (terminal && ready && acceptingInput) hint(shellHint());
}

function currentPath() {
  const tab = activeTab();
  return (tab?.view === 'viz' ? state.viz.result?.path : null) || tab?.path || state.app?.home;
}

function writeInput(bytes) {
  if (!terminal || !acceptingInput) return;
  if (pendingBytes + queuedBytes + bytes.length > 1048576) {
    hint('Input buffer full; wait before pasting again');
    return;
  }
  if (!ready) {
    pendingInput.push(bytes);
    pendingBytes += bytes.length;
    return;
  }
  const id = sessionId;
  const token = generation;
  queuedBytes += bytes.length;
  inputQueue = inputQueue.then(async () => {
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      if (token !== generation || id !== sessionId) return;
      await api.terminalWrite(id, Array.from(bytes.subarray(offset, offset + 8192)));
    }
  }).catch((error) => {
    if (token === generation && terminal) hint(String(error));
  }).finally(() => {
    if (token === generation) queuedBytes -= bytes.length;
  });
}

async function readOutput(id, token, term) {
  try {
    while (token === generation && terminal === term && sessionId === id) {
      const output = await api.terminalRead(id);
      if (token !== generation || terminal !== term) return;
      if (output.data.length) {
        await new Promise(resolve => term.write(new Uint8Array(output.data), resolve));
      }
      if (token !== generation || terminal !== term) return;
      if (output.exit) {
        acceptingInput = false;
        hint(output.exit.error || `Exited (${output.exit.code}) · ${shortcutLabel('terminalChoose') || 'Shell button'} switch shell`);
        choosingShell = true;
        sessionId = null;
        await api.terminalClose(id);
        return;
      }
    }
  } catch (error) {
    if (token === generation && terminal === term) {
      hint(String(error));
      sessionId = null;
      acceptingInput = false;
      choosingShell = true;
      await api.terminalClose(id).catch(() => {});
    }
  }
}

function startSession() {
  const token = ++generation;
  const selected = shellOptions[shellIndex];
  const path = startPath;
  choosingShell = true;
  ready = false;
  acceptingInput = selected.available;
  pendingInput = [];
  pendingBytes = 0;
  queuedBytes = 0;
  inputQueue = Promise.resolve();
  document.getElementById('terminal-shell').textContent = selected.label;
  hint(`${selected.available ? 'Starting…' : 'Not installed'} · ${shortcutLabel('terminalChoose') || 'Shell button'} switch shell`);
  lifecycle = lifecycle.catch(() => {}).then(async () => {
    if (sessionId !== null) {
      const old = sessionId;
      sessionId = null;
      await api.terminalClose(old);
    }
    if (token !== generation || !terminal) return;
    terminal.reset();
    if (!selected.available) return;
    fit.fit();
    const info = await api.terminalStart(path, selected.id, terminal.cols, terminal.rows);
    if (token !== generation || !terminal) {
      await api.terminalClose(info.id);
      return;
    }
    sessionId = info.id;
    fit.fit();
    await api.terminalResize(info.id, terminal.cols, terminal.rows).catch(() => {});
    if (token !== generation || !terminal) return;
    ready = true;
    const pathLabel = document.getElementById('terminal-path');
    pathLabel.textContent = info.path;
    pathLabel.title = `Started in ${info.path}`;
    hint(shellHint());
    readOutput(info.id, token, terminal);
    const buffered = pendingInput;
    pendingInput = [];
    pendingBytes = 0;
    buffered.forEach(writeInput);
  }).catch(error => {
    if (token === generation && terminal) {
      acceptingInput = false;
      hint(String(error));
    }
  });
}

function cycleShell() {
  if (!terminal || !shellOptions) return;
  shellIndex = (shellIndex + 1) % shellOptions.length;
  startSession();
  terminal.focus();
}

export function closeTerminal() {
  generation++;
  pendingInput = [];
  pendingBytes = 0;
  acceptingInput = false;
  observer?.disconnect();
  observer = null;
  terminal?.dispose();
  terminal = null;
  fit = null;
  pane().hidden = true;
  document.getElementById('terminal-screen').replaceChildren();
  lifecycle = lifecycle.catch(() => {}).then(async () => {
    if (sessionId !== null) {
      const old = sessionId;
      sessionId = null;
      await api.terminalClose(old);
    }
  });
  document.getElementById('files-scroll')?.focus({ preventScroll: true });
}

export async function openTerminal() {
  const path = currentPath();
  if (!path) return;
  if (terminal) {
    terminal.focus();
    return;
  }
  pane().hidden = false;
  hint('Loading shells…');
  const opening = ++generation;
  try {
    shellOptions ||= await api.terminalShells();
  } catch (error) {
    if (opening === generation) hint(String(error));
    return;
  }
  if (opening !== generation || pane().hidden) return;
  if (state.app?.platform !== 'windows') shellOptions = shellOptions.filter(s => s.available);
  startPath = path;
  shellIndex = 0;
  terminal = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    scrollback: 3000,
    allowProposedApi: false,
    theme: { background: '#080a0e', foreground: '#e7ecf3', cursor: '#5eead4', selectionBackground: '#284442' },
  });
  const term = terminal;
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal-screen'));
  term.onData(data => writeInput(new TextEncoder().encode(data)));
  term.onBinary(data => writeInput(Uint8Array.from(data, char => char.charCodeAt(0))));
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    const command = commandForEvent(event, 'terminal');
    const cycle = command === 'terminalCycle' || (command === 'terminalChoose' && choosingShell);
    const close = command === 'terminalClose' || (command === 'terminalCancel' && choosingShell);
    if (cycle || close) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        if (cycle) cycleShell();
        else closeTerminal();
      }
      return false;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
      api.copyText(term.getSelection()).catch(error => hint(String(error)));
      term.clearSelection();
      event.preventDefault();
      return false;
    }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      choosingShell = false;
      hint(shellHint());
    }
    return true;
  });
  let resizeTimer;
  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (terminal !== term) return;
      fit.fit();
      if (sessionId !== null) api.terminalResize(sessionId, term.cols, term.rows).catch(() => {});
    }, 80);
  });
  observer.observe(document.getElementById('terminal-screen'));
  fit.fit();
  term.focus();
  startSession();
}

export function initTerminal() {
  document.getElementById('terminal-close').innerHTML = icon('x', 14);
  document.getElementById('terminal-close').addEventListener('click', closeTerminal);
  document.getElementById('terminal-shell').addEventListener('click', cycleShell);
  pane().addEventListener('keydown', event => event.stopPropagation());
  pane().addEventListener('paste', () => { choosingShell = false; });
}
