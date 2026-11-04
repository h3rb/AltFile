import { esc } from './util.js';
import { icon } from './icons.js';

const overlayRoot = () => document.getElementById('overlays');

let toastSeq = 0;

export function toast(message, options = {}) {
  const {
    type = 'info',
    timeout = type === 'error' ? 5600 : 3200,
    id = null,
    action = null,
    icon: iconName = null,
  } = options;
  const root = document.getElementById('toasts');
  if (!root) return null;

  let el = id ? document.getElementById(`toast-${id}`) : null;
  if (!el) {
    el = document.createElement('div');
    el.id = `toast-${id || ++toastSeq}`;
    el.className = 'toast';
    el.innerHTML = `
      <span class="toast-icon"></span>
      <span class="toast-msg"></span>
      <button class="toast-stop" type="button" aria-label="Dismiss"></button>
      <button class="toast-close" type="button" aria-label="Close">${icon('x', 13)}</button>
    `;
    root.append(el);
    while (root.children.length > 4) root.firstElementChild.remove();
    el.querySelector('.toast-close').addEventListener('click', () => dismiss(el));
  }

  el.className = `toast toast-${type} show`;
  const glyph = iconName || (type === 'error' ? 'alert' : type === 'success' ? 'check' : type === 'busy' ? 'loader' : 'info');
  el.querySelector('.toast-icon').innerHTML = icon(glyph, 15, type === 'busy' ? 'spin' : '');
  el.querySelector('.toast-msg').textContent = message;

  const stopBtn = el.querySelector('.toast-stop');
  if (action && action.onClick) {
    stopBtn.hidden = false;
    stopBtn.textContent = action.label || 'Undo';
    stopBtn.onclick = () => {
      action.onClick();
      dismiss(el);
    };
  } else {
    stopBtn.hidden = true;
  }

  clearTimeout(el._timer);
  if (timeout > 0) {
    el._timer = setTimeout(() => dismiss(el), timeout);
  }
  return el;
}

export function dismiss(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  clearTimeout(el._timer);
  el.classList.remove('show');
  setTimeout(() => el.remove(), 180);
}

export function anyOverlayOpen() {
  return Boolean(document.querySelector('.modal-backdrop, .menu-layer'));
}

function trapFocus(container) {
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusables = [...container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

export function openModal({
  title,
  subtitle = '',
  body = '',
  actions = [],
  width = 460,
  className = '',
  onClose = null,
}) {
  const layer = document.createElement('div');
  layer.className = 'modal-backdrop';
  layer.innerHTML = `
    <div class="modal ${className}" role="dialog" aria-modal="true" style="--modal-w:${width}px">
      <header class="modal-head">
        <div class="modal-titles">
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="icon-btn modal-x" type="button" aria-label="Close">${icon('x', 16)}</button>
      </header>
      <div class="modal-body"></div>
      <footer class="modal-foot"></footer>
    </div>
  `;
  const bodyEl = layer.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.append(body);

  const foot = layer.querySelector('.modal-foot');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    layer.classList.remove('open');
    setTimeout(() => layer.remove(), 140);
    if (onClose) onClose();
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-${action.kind || 'ghost'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', async () => {
      if (action.onClick) {
        const result = await action.onClick({ close, body: bodyEl, button: btn });
        if (result === false) return;
      }
      if (action.close !== false) close();
    });
    foot.append(btn);
  }

  layer.querySelector('.modal-x').addEventListener('click', close);
  layer.addEventListener('mousedown', (event) => {
    if (event.target === layer) close();
  });
  trapFocus(layer);
  overlayRoot().append(layer);
  requestAnimationFrame(() => layer.classList.add('open'));
  setTimeout(() => {
    const focusTarget = layer.querySelector('[data-autofocus]') || foot.querySelector('.btn-primary') || layer.querySelector('.modal-x');
    focusTarget?.focus();
  }, 30);

  return { el: layer, body: bodyEl, close };
}

export function promptDialog({
  title,
  label = 'Name',
  value = '',
  confirmLabel = 'Save',
  hint = '',
  selectBase = false,
}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const body = document.createElement('div');
    body.innerHTML = `
      <label class="field">
        <span>${esc(label)}</span>
        <input class="text-input" type="text" spellcheck="false" autocomplete="off" data-autofocus>
      </label>
      ${hint ? `<p class="field-hint">${esc(hint)}</p>` : ''}
    `;
    const input = body.querySelector('input');
    input.value = value;
    const modal = openModal({
      title,
      body,
      width: 440,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => finish(null) },
        {
          label: confirmLabel,
          kind: 'primary',
          onClick: () => {
            const next = input.value.trim();
            if (!next) {
              input.classList.add('invalid');
              input.focus();
              return false;
            }
            finish(next);
          },
        },
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => {
      input.focus();
      if (selectBase) {
        const dot = value.lastIndexOf('.');
        if (dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      } else {
        input.select();
      }
    }, 40);
    input.addEventListener('input', () => input.classList.remove('invalid'));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const next = input.value.trim();
        if (!next) return;
        finish(next);
        modal.close();
      }
    });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, detail = '' }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const body = document.createElement('div');
    body.innerHTML = `
      <p class="confirm-message">${esc(message)}</p>
      ${detail ? `<div class="confirm-detail">${esc(detail)}</div>` : ''}
    `;
    openModal({
      title,
      body,
      width: 440,
      className: danger ? 'danger-modal' : '',
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => finish(false) },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          onClick: () => finish(true),
        },
      ],
      onClose: () => finish(false),
    });
  });
}

let activeMenu = null;

export function showMenu({ x, y, items, align = 'left', anchor = null }) {
  if (activeMenu) activeMenu();
  const layer = document.createElement('div');
  layer.className = 'menu-layer';
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');

  let index = 0;
  for (const item of items) {
    if (!item || item.hidden) continue;
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${item.danger ? ' danger' : ''}`;
    btn.disabled = Boolean(item.disabled);
    btn.dataset.index = String(index++);
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `
      <span class="menu-ico">${item.icon ? icon(item.icon, 15) : ''}</span>
      <span class="menu-label">${esc(item.label)}</span>
      ${item.shortcut ? `<kbd>${esc(item.shortcut)}</kbd>` : ''}
    `;
    btn.addEventListener('click', () => {
      close();
      item.onClick?.();
    });
    menu.append(btn);
  }
  if (!menu.children.length) return () => {};

  layer.append(menu);
  document.body.append(layer);

  let left = x;
  let top = y;
  if (align === 'right') left = x - menu.offsetWidth;
  const margin = 8;
  left = Math.max(margin, Math.min(left, window.innerWidth - menu.offsetWidth - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - menu.offsetHeight - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointer = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    const buttons = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(current + 1) % buttons.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length].focus();
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault();
      buttons[current].click();
    }
  };
  const timer = setTimeout(() => document.addEventListener('pointerdown', onPointer, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close, { once: true });

  function close() {
    clearTimeout(timer);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    if (activeMenu === close) activeMenu = null;
  }
  activeMenu = close;
  requestAnimationFrame(() => {
    menu.classList.add('open');
    menu.querySelector('.menu-item:not([disabled])')?.focus();
  });
  return close;
}

export function closeMenu() {
  if (activeMenu) activeMenu();
}
