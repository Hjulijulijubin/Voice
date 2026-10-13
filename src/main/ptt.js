'use strict';

/**
 * Global push-to-talk: works while a game or any other app has focus.
 *
 * Electron's globalShortcut only reports key presses, not releases, so we use
 * the optional native `uiohook-napi` module. If it is unavailable (e.g. no
 * prebuilt binary for the platform), PTT still works while the Voice window
 * is focused.
 *
 * macOS: the app must be allowed under
 *   System Settings → Privacy & Security → Accessibility / Input Monitoring.
 */

let uiohook = null;
try {
  uiohook = require('uiohook-napi');
} catch {
  uiohook = null;
}

/** KeyboardEvent.code → uiohook key name, where they differ. */
const CODE_ALIASES = {
  ControlLeft: 'Ctrl',
  ControlRight: 'CtrlRight',
  AltLeft: 'Alt',
  AltRight: 'AltRight',
  ShiftLeft: 'Shift',
  ShiftRight: 'ShiftRight',
  MetaLeft: 'Meta',
  MetaRight: 'MetaRight',
  OSLeft: 'Meta',
  OSRight: 'MetaRight',
  IntlBackslash: 'Backslash',
};

function codeToKeycode(code) {
  if (!uiohook || typeof code !== 'string') return null;
  const keys = uiohook.UiohookKey;
  let name = CODE_ALIASES[code] || code;
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit\d$/.test(code)) name = code.slice(5);
  return Object.prototype.hasOwnProperty.call(keys, name) ? keys[name] : null;
}

class GlobalPtt {
  constructor(onChange) {
    this.onChange = onChange;
    this.binding = null; // { keycode } | { mouse }
    this.down = false;
    this.started = false;
    this.available = !!uiohook;
  }

  _start() {
    if (this.started || !uiohook) return;
    const { uIOhook } = uiohook;
    uIOhook.on('keydown', (e) => this.binding?.keycode === e.keycode && this._set(true));
    uIOhook.on('keyup', (e) => this.binding?.keycode === e.keycode && this._set(false));
    uIOhook.on('mousedown', (e) => this.binding?.mouse === e.button && this._set(true));
    uIOhook.on('mouseup', (e) => this.binding?.mouse === e.button && this._set(false));
    try {
      uIOhook.start();
      this.started = true;
    } catch (err) {
      console.warn('global push-to-talk unavailable:', err.message);
      this.available = false;
    }
  }

  _set(down) {
    if (down === this.down) return; // ignore key repeat
    this.down = down;
    this.onChange(down);
  }

  /**
   * @param {null | {type:'key', code:string} | {type:'mouse', button:number}} binding
   * @returns {boolean} true if the binding is active globally
   */
  bind(binding) {
    this.down = false;
    if (!binding || !uiohook) {
      this.binding = null;
      return false;
    }
    if (binding.type === 'mouse') {
      // DOM buttons are 0-based (0 left, 1 middle, 2 right, 3 back, 4 forward);
      // uiohook buttons are 1-based.
      this.binding = { mouse: Number(binding.button) + 1 };
    } else {
      const keycode = codeToKeycode(binding.code);
      this.binding = keycode == null ? null : { keycode };
    }
    if (this.binding) this._start();
    return !!this.binding && this.available;
  }

  stop() {
    if (this.started && uiohook) {
      try {
        uiohook.uIOhook.stop();
      } catch {
        /* ignore */
      }
    }
    this.started = false;
  }
}

module.exports = { GlobalPtt, codeToKeycode };
