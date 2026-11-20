import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../ui/js/keyboard.js', import.meta.url), 'utf8');
const keys = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const event = (key, options = {}) => ({ key, ...options });
beforeEach(() => keys.resetBindings());

test('all defaults are valid, unique within their scope and round-trip', () => {
  const defaults = Object.fromEntries(keys.COMMANDS.map(command => [command.id, command.defaults]));
  keys.loadBindings(defaults);
  assert.deepEqual(keys.savedBindings(), defaults);
  for (const command of keys.COMMANDS) {
    for (const binding of command.defaults) {
      const [, ctrl, alt, shift, key] = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(.+)$/.exec(binding);
      assert.equal(keys.commandForEvent(event(key === 'Space' ? ' ' : key,
        { ctrlKey: !!ctrl, altKey: !!alt, shiftKey: !!shift }), command.scope), command.id);
    }
  }
});

test('normalizes case, primary modifier, menu keys, shifted symbols and plus', () => {
  assert.equal(keys.eventBinding(event('k', { ctrlKey: true })), 'Ctrl+K');
  assert.equal(keys.eventBinding(event('K', { metaKey: true, shiftKey: true })), 'Ctrl+Shift+K');
  assert.equal(keys.eventBinding(event(':', { shiftKey: true })), ':');
  assert.equal(keys.eventBinding(event('+', { ctrlKey: true, shiftKey: true })), 'Ctrl++');
  assert.equal(keys.eventBinding(event('Apps')), 'ContextMenu');
  assert.equal(keys.eventBinding(event(' ')), 'Space');
});

test('ignores modifier-only, composition, AltGr and unidentified keys', () => {
  for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process', 'Unidentified']) {
    assert.equal(keys.eventBinding(event(key)), null);
  }
  assert.equal(keys.eventBinding(event('a', { isComposing: true })), null);
  assert.equal(keys.eventBinding(event('@', { getModifierState: name => name === 'AltGraph' })), null);
  assert.equal(keys.eventBinding(event('k', { ctrlKey: true, metaKey: true })), null);
});

test('modifiers match exactly and do not leak into other commands', () => {
  assert.equal(keys.commandForEvent(event('w', { ctrlKey: true })), 'closeTab');
  assert.equal(keys.commandForEvent(event('W', { ctrlKey: true, shiftKey: true })), undefined);
  assert.equal(keys.commandForEvent(event('W', { ctrlKey: true, shiftKey: true }), 'terminal'), 'terminalClose');
  assert.equal(keys.commandForEvent(event('F2', { altKey: true })), undefined);
});

test('rebind replaces every default alias and updates labels', () => {
  assert.equal(keys.setBinding('refresh', 'Ctrl+Shift+R'), '');
  assert.equal(keys.commandForEvent(event('F5')), undefined);
  assert.equal(keys.commandForEvent(event('r', { ctrlKey: true })), undefined);
  assert.equal(keys.commandForEvent(event('R', { ctrlKey: true, shiftKey: true })), 'refresh');
  assert.equal(keys.shortcutTitle('Refresh', 'refresh'), 'Refresh (Ctrl+Shift+R)');
  assert.equal(keys.isDefaultBinding(event('F5')), true);
});

test('rejects conflicting keys including secondary aliases without changing bindings', () => {
  assert.match(keys.setBinding('preview', 'Ctrl+T'), /New tab/);
  assert.match(keys.setBinding('preview', 'Ctrl+R'), /Refresh/);
  assert.deepEqual(keys.savedBindings(), {});
});

test('independent terminal and browser scopes can reuse a key', () => {
  assert.equal(keys.setBinding('terminalClose', 'Ctrl+T'), '');
  assert.equal(keys.commandForEvent(event('t', { ctrlKey: true })), 'newTab');
  assert.equal(keys.commandForEvent(event('t', { ctrlKey: true }), 'terminal'), 'terminalClose');
  assert.match(keys.setBinding('terminalCycle', 'Ctrl+T'), /Close terminal/);
});

test('slash stays the search shortcut and is never a terminal key', () => {
  assert.equal(keys.commandForEvent(event('/')), 'search');
  assert.equal(keys.commandForEvent(event('?', { shiftKey: true })), undefined);
  assert.equal(keys.commandForEvent(event('/'), 'terminal'), undefined);
  assert.ok(!keys.shortcutLabel('terminal').includes('/'));
  assert.equal(keys.shortcutLabel('terminal'), '. · : · | · ` · F4');
});

test('unbinding persists and reset restores aliases', () => {
  assert.equal(keys.setBinding('terminal', null), '');
  const saved = keys.savedBindings();
  keys.loadBindings(saved);
  assert.equal(keys.commandForEvent(event('.')), undefined);
  assert.equal(keys.shortcutLabel('terminal'), '');
  assert.equal(keys.resetBinding('terminal'), '');
  assert.equal(keys.commandForEvent(event(':', { shiftKey: true })), 'terminal');
  assert.deepEqual(keys.savedBindings(), {});
});

test('reset reports conflicts and reset-all always restores coherent defaults', () => {
  keys.setBinding('preview', 'F6');
  keys.setBinding('newTab', 'Ctrl+P');
  assert.match(keys.resetBinding('preview'), /New tab/);
  assert.equal(keys.shortcutLabel('preview'), 'F6');
  keys.resetBindings();
  assert.equal(keys.shortcutLabel('preview'), 'Ctrl+P');
});

test('persists moved default keys without depending on property order', () => {
  keys.setBinding('preview', 'F6');
  keys.setBinding('newTab', 'Ctrl+P');
  const saved = keys.savedBindings();
  keys.resetBindings();
  keys.loadBindings(saved);
  assert.deepEqual(keys.savedBindings(), saved);
  saved.preview.push('F7');
  assert.deepEqual(keys.getBindings('preview'), ['F6']);
});

test('rejects reserved and malformed chords', () => {
  for (const binding of ['Tab', 'Shift+Tab', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl', 'Ctrl+k', 'Shift+:', 'Meta+K', '<img>', 'Ctrl+Ctrl+K']) {
    assert.ok(keys.setBinding('preview', binding), binding);
  }
  assert.equal(keys.setBinding('preview', 'Ctrl++'), '');
});

test('validates persisted mappings and rejects conflicts', () => {
  keys.loadBindings({ preview: ['F6'], unknown: ['F7'], newTab: ['<script>'], copy: null });
  assert.deepEqual(keys.savedBindings(), { preview: ['F6'] });
  keys.loadBindings({ preview: ['Ctrl+T'] });
  assert.deepEqual(keys.savedBindings(), {});
  keys.loadBindings(JSON.parse('{"__proto__":["F6"]}'));
  assert.deepEqual(keys.savedBindings(), {});
  keys.loadBindings(null);
  assert.equal(keys.shortcutLabel('rename'), 'F2');
});
