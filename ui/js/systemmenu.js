import { api } from './api.js';
import { state } from './state.js';
import { toast } from './dialogs.js';

function onWindows() {
  return (state.app?.platform || '').toLowerCase() === 'windows';
}

function toMenuItems(items, path) {
  return items.map((item) => {
    if (item.separator) return { separator: true };
    if (item.children?.length) {
      return {
        label: item.label,
        disabled: item.disabled,
        submenu: toMenuItems(item.children, path),
      };
    }
    return {
      label: item.label,
      icon: item.checked ? 'check' : null,
      disabled: item.disabled,
      onClick: () => {
        api.shellMenuInvoke(path, item.id).catch((error) => toast(String(error), { type: 'error' }));
      },
    };
  });
}

export function systemMenuItem(path, { hidden = false } = {}) {
  return {
    label: 'System Menu',
    icon: 'command',
    hidden: hidden || !onWindows(),
    submenu: async () => {
      const items = await api.shellMenuItems(path);
      return toMenuItems(items, path);
    },
  };
}
