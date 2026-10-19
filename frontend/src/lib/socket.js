/**
 * socket.js
 *
 * Thin wrapper around window.__ratSend.
 * App.jsx maintains the actual WebSocket; tabs only call send().
 */

/**
 * Send a command to a specific device.
 * @param {string} deviceId
 * @param {object|string} cmd  - { type, ...args } or just a command string
 */
export function send(deviceId, cmd) {
  if (typeof window.__ratSend !== 'function') return false;
  const payload = typeof cmd === 'string' ? { type: cmd } : cmd;
  return window.__ratSend(deviceId, payload);
}

/**
 * Subscribe to incoming messages for a specific device.
 * Returns an unsubscribe function.
 *
 * @param {string}   deviceId
 * @param {function} handler  - (msg) => void
 */
export function subscribe(deviceId, handler) {
  const listener = (e) => {
    if (e.detail.deviceId === deviceId) handler(e.detail.msg);
  };
  window.addEventListener('rat_msg', listener);
  return () => window.removeEventListener('rat_msg', listener);
}

/**
 * Subscribe to messages for a specific device AND message type.
 *
 * @param {string}   deviceId
 * @param {string|string[]} types - single type string or array
 * @param {function} handler
 */
export function subscribeType(deviceId, types, handler) {
  const typeSet = Array.isArray(types) ? new Set(types) : new Set([types]);
  const listener = (e) => {
    const { deviceId: from, msg } = e.detail;
    if (from !== deviceId) return;
    const t = msg.type || msg.cmd || '';
    if (typeSet.has(t)) handler(msg);
  };
  window.addEventListener('rat_msg', listener);
  return () => window.removeEventListener('rat_msg', listener);
}
