export const COMMANDS = [
  ['palette', 'Command palette', ['Ctrl+K', 'Ctrl+ContextMenu']],
  ['editPath', 'Edit path', ['Ctrl+L']],
  ['newTab', 'New tab', ['Ctrl+T']],
  ['closeTab', 'Close tab', ['Ctrl+W']],
  ['nextTab', 'Next tab', ['Ctrl+Tab']],
  ['previousTab', 'Previous tab', ['Ctrl+Shift+Tab']],
  ['preview', 'Toggle preview', ['Ctrl+P']],
  ['grid', 'Grid view', ['Ctrl+1']],
  ['list', 'List view', ['Ctrl+2']],
  ['visualize', 'Visualize folder', ['Ctrl+3']],
  ['refresh', 'Refresh', ['F5', 'Ctrl+R']],
  ['search', 'Focus search / filter', ['/', 'Ctrl+F']],
  ['newFolder', 'New folder', ['Ctrl+Shift+N']],
  ['selectAll', 'Select all files', ['Ctrl+A']],
  ['copy', 'Copy selection', ['Ctrl+C']],
  ['cut', 'Cut selection', ['Ctrl+X']],
  ['paste', 'Paste', ['Ctrl+V']],
  ['rename', 'Rename', ['F2']],
  ['trash', 'Move to Trash', ['Delete']],
  ['back', 'Back', ['Alt+ArrowLeft']],
  ['forward', 'Forward', ['Alt+ArrowRight']],
  ['parent', 'Up one folder', ['ArrowLeft', 'Alt+ArrowUp', 'Backspace']],
  ['enterPreview', 'Enter folder / preview file / context menu', ['ArrowRight']],
  ['open', 'Open focused item', ['Enter']],
  ['up', 'Previous item', ['ArrowUp']],
  ['down', 'Next item', ['ArrowDown']],
  ['home', 'First item', ['Home']],
  ['end', 'Last item', ['End']],
  ['pageup', 'Page up', ['PageUp']],
  ['pagedown', 'Page down', ['PageDown']],
  ['selectUp', 'Extend selection up', ['Shift+ArrowUp']],
  ['selectDown', 'Extend selection down', ['Shift+ArrowDown']],
  ['selectLeft', 'Extend selection left', ['Shift+ArrowLeft']],
  ['selectRight', 'Extend selection right', ['Shift+ArrowRight']],
  ['selectHome', 'Extend selection to first item', ['Shift+Home']],
  ['selectEnd', 'Extend selection to last item', ['Shift+End']],
  ['selectPageup', 'Extend selection a page up', ['Shift+PageUp']],
  ['selectPagedown', 'Extend selection a page down', ['Shift+PageDown']],
  ['clear', 'Clear search / selection', ['Escape']],
  ['contextMenu', 'Context menu for focus', ['ContextMenu']],
  ['windowMenu', 'Window menu (Windows)', ['Alt+ContextMenu']],
  ['playPause', 'Play / pause media', ['Space']],
  ['terminal', 'Open terminal in active folder', ['.', ':']],
  ['terminalChoose', 'Switch shell before typing', ['\\'], 'terminal'],
  ['terminalCycle', 'Switch terminal shell anytime', ['Ctrl+\\'], 'terminal'],
  ['terminalClose', 'Close terminal', ['Ctrl+Shift+W'], 'terminal'],
  ['terminalCancel', 'Close terminal before typing', ['Escape'], 'terminal'],
].map(([id, label, defaults, scope = 'browser']) => ({ id, label, defaults, scope }));

const commandMap = new Map(COMMANDS.map(command => [command.id, command]));
const namedKeys = new Set(['Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ContextMenu',
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`)]);
let overrides = {};

function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (key === 'Apps') return 'ContextMenu';
  if (namedKeys.has(key)) return key;
  if (typeof key !== 'string' || [...key].length !== 1 || /\s|\p{C}/u.test(key)) return null;
  const upper = key.toUpperCase();
  return [...upper].length === 1 ? upper : key;
}

export function eventBinding(event) {
  if (event.isComposing || event.getModifierState?.('AltGraph') || (event.ctrlKey && event.metaKey)) return null;
  const key = normalizeKey(event.key);
  if (!key) return null;
  const shift = event.shiftKey && (namedKeys.has(key) || /\p{L}/u.test(key));
  return `${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`;
}

function validBinding(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(.+)$/u.exec(value);
  if (!match) return false;
  const [, ctrl, alt, shift, key] = match;
  return eventBinding({ key: key === 'Space' ? ' ' : key, ctrlKey: !!ctrl, altKey: !!alt, shiftKey: !!shift }) === value
    && !['Tab', 'Shift+Tab', 'Alt+F4', 'Ctrl+Alt+Delete'].includes(value);
}

export function getBindings(id) {
  return overrides[id] || commandMap.get(id)?.defaults || [];
}

export function commandForEvent(event, scope = 'browser') {
  const binding = eventBinding(event);
  return binding ? COMMANDS.find(command => command.scope === scope && getBindings(command.id).includes(binding))?.id : undefined;
}

export function isDefaultBinding(event) {
  const binding = eventBinding(event);
  return COMMANDS.some(command => command.scope === 'browser' && command.defaults.includes(binding));
}

const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function isEditingChord(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  return EDITING_KEYS.has(event.key.length === 1 ? event.key.toLowerCase() : event.key);
}

export function bindingLabel(binding) {
  return binding.replace(/ContextMenu$/, 'Menu').replace(/ArrowUp$/, '↑').replace(/ArrowDown$/, '↓')
    .replace(/ArrowLeft$/, '←').replace(/ArrowRight$/, '→').replace(/Escape$/, 'Esc').replace(/Delete$/, 'Del');
}

export function shortcutLabel(id) {
  return getBindings(id).map(bindingLabel).join(' / ');
}

export function shortcutTitle(label, id) {
  const keys = shortcutLabel(id);
  return keys ? `${label} (${keys})` : label;
}

export function isCustomized(id) {
  return Object.hasOwn(overrides, id);
}

function conflict(id, bindings) {
  const scope = commandMap.get(id).scope;
  return COMMANDS.find(command => command.id !== id && command.scope === scope
    && getBindings(command.id).some(binding => bindings.includes(binding)));
}

export function setBinding(id, binding) {
  if (!commandMap.has(id)) return 'Unknown command';
  if (binding !== null && !validBinding(binding)) return 'That key is reserved or cannot be used. Choose another shortcut.';
  const bindings = binding === null ? [] : [binding];
  const other = conflict(id, bindings);
  if (other) return `Already used by “${other.label}”. Rebind or disable that command first.`;
  overrides[id] = bindings;
  return '';
}

export function resetBinding(id) {
  const command = commandMap.get(id);
  if (!command) return 'Unknown command';
  const other = conflict(id, command.defaults);
  if (other) return `A default key is used by “${other.label}”. Rebind it or restore all defaults.`;
  delete overrides[id];
  return '';
}

export function resetBindings() {
  overrides = {};
}

export function savedBindings() {
  return Object.fromEntries(Object.entries(overrides).map(([id, bindings]) => [id, [...bindings]]));
}

export function loadBindings(saved) {
  overrides = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
  for (const { id } of COMMANDS) {
    if (!Object.hasOwn(saved, id)) continue;
    const bindings = saved[id];
    if (Array.isArray(bindings) && bindings.length <= 3 && bindings.every(validBinding)) {
      overrides[id] = [...new Set(bindings)];
    }
  }
  if (COMMANDS.some(command => conflict(command.id, getBindings(command.id)))) overrides = {};
}
