import { h, colorFor, initials } from './util.js';
import { icon } from './icons.js';

export function toast(text, kind = 'info', ms = 4000) {
  const el = h('div', { class: `toast ${kind}` }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function avatar(name, size = '', speaking = false) {
  return h(
    'div',
    { class: `avatar ${size}${speaking ? ' speaking' : ''}`, style: { background: colorFor(name || '?') } },
    initials(name),
  );
}

/**
 * Open a modal dialog. Returns { el, close }.
 * @param {{title:string, body:Node, footer?:Node[], small?:boolean, onClose?:Function}} opts
 */
export function modal({ title, body, footer, small, tabs, onClose }) {
  const root = document.getElementById('modal-root');
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation();
      close();
    }
  };
  const closeBtn = h('button', { class: 'icon-btn', title: 'Close', onclick: close }, icon('x'));
  const box = h(
    'div',
    { class: `modal${small ? ' small' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), closeBtn),
    tabs || null,
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, ...footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => e.target === backdrop && close() }, box);
  root.append(backdrop);
  document.addEventListener('keydown', onKey, true);
  return { el: box, close };
}

/** Simple text prompt as a modal. Resolves with the value or null. */
export function promptModal(title, label, initial = '', extra = null) {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { value: initial, maxlength: 32 });
    const finish = (value) => {
      if (done) return;
      done = true;
      m.close();
      resolve(value);
    };
    const body = h(
      'form',
      {
        onsubmit: (e) => {
          e.preventDefault();
          finish(input.value.trim() || null);
        },
      },
      h('label', { class: 'field' }, h('span', {}, label), input),
      extra,
    );
    const m = modal({
      title,
      body,
      small: true,
      footer: [
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => finish(input.value.trim() || null) }, 'Create'),
      ],
      onClose: () => finish(null),
    });
    setTimeout(() => input.focus(), 0);
  });
}

export function confirmModal(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title,
      small: true,
      body: h('p', {}, text),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, okLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

let currentPopover = null;

/** Show a popover next to an anchor element. Returns a close function. */
export function popover(anchor, content, onClose) {
  closePopover();
  const root = document.getElementById('popover-root');
  const el = h('div', { class: 'popover' }, content);
  root.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let left = r.left - w - 8;
  if (left < 8) left = Math.min(r.right + 8, window.innerWidth - w - 8);
  const top = Math.max(8, Math.min(r.top, window.innerHeight - hgt - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  const onDown = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  currentPopover = {
    close: () => {
      document.removeEventListener('mousedown', onDown);
      el.remove();
      currentPopover = null;
      onClose?.();
    },
  };
  return currentPopover.close;
}

export function closePopover() {
  currentPopover?.close();
}
