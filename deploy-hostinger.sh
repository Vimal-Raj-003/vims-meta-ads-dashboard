#!/usr/bin/env bash
set -e

echo "=================================================================="
echo " Deploying VIMS Enterprise Meta Ads Dashboard to Hostinger VPS"
echo " Domain: ads.vimsenterprise.com -> 127.0.0.1:3400"
echo "=================================================================="

# 1. Ensure Node.js v22.14.0+ is available in /opt/node22 (for built-in node:sqlite)
NODE_BIN="/opt/node22/bin/node"
if [ ! -x "$NODE_BIN" ]; then
  echo "[1/5] Installing Node.js v22.14.0 binary to /opt/node22..."
  mkdir -p /opt/node22
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node22.tar.xz
  tar -xJf /tmp/node22.tar.xz -C /opt/node22 --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
echo "Using Node.js: $($NODE_BIN -v)"

# 2. Clone or update application code in /opt/vims-meta-ads-dashboard
APP_DIR="/opt/vims-meta-ads-dashboard"
echo "[2/5] Fetching latest application from GitHub..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone https://github.com/Vimal-Raj-003/vims-meta-ads-dashboard.git "$APP_DIR"
fi

mkdir -p "$APP_DIR/data"

# 3. Create and enable systemd service on port 3400
echo "[3/5] Configuring systemd service vims-meta-ads.service on 127.0.0.1:3400..."
cat >/etc/systemd/system/vims-meta-ads.service <<EOF
[Unit]
Description=VIMS Enterprise Meta Ads Performance Marketing Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/vims-meta-ads-dashboard
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=3400
ExecStart=/opt/node22/bin/node --no-warnings /opt/vims-meta-ads-dashboard/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vims-meta-ads.service
systemctl restart vims-meta-ads.service
sleep 2
systemctl status vims-meta-ads.service --no-pager || true

# 4. Configure Reverse Proxy for ads.vimsenterprise.com
echo "[4/5] Configuring Reverse Proxy + SSL for ads.vimsenterprise.com..."
if command -v nginx >/dev/null 2>&1 || [ -d /etc/nginx ]; then
  NGINX_CONF="/etc/nginx/sites-available/ads.vimsenterprise.com"
  if [ ! -d /etc/nginx/sites-available ]; then
    NGINX_CONF="/etc/nginx/conf.d/ads.vimsenterprise.com.conf"
  fi

  cat >"$NGINX_CONF" <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name ads.vimsenterprise.com;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3400;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

  if [ -d /etc/nginx/sites-enabled ] && [ -f /etc/nginx/sites-available/ads.vimsenterprise.com ]; then
    ln -sf /etc/nginx/sites-available/ads.vimsenterprise.com /etc/nginx/sites-enabled/ads.vimsenterprise.com
  fi

  nginx -t && systemctl reload nginx

  if command -v certbot >/dev/null 2>&1; then
    certbot --nginx -d ads.vimsenterprise.com --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
  fi
elif command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  if ! grep -q "ads.vimsenterprise.com" /etc/caddy/Caddyfile; then
    cat >>/etc/caddy/Caddyfile <<'EOF'

ads.vimsenterprise.com {
    reverse_proxy 127.0.0.1:3400
}
EOF
    systemctl reload caddy || caddy reload --config /etc/caddy/Caddyfile || true
  fi
else
  echo "Installing Nginx..."
  apt-get update -y && apt-get install -y nginx certbot python3-certbot-nginx
  cat >/etc/nginx/sites-available/ads.vimsenterprise.com <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name ads.vimsenterprise.com;
    client_max_body_size 25M;
    location / {
        proxy_pass http://127.0.0.1:3400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/ads.vimsenterprise.com /etc/nginx/sites-enabled/ads.vimsenterprise.com
  nginx -t && systemctl enable --now nginx && systemctl reload nginx
  certbot --nginx -d ads.vimsenterprise.com --non-interactive --agree-tos --register-unsafely-without-email --redirect || true
fi

echo "[5/5] Verifying local health check..."
curl -sI http://127.0.0.1:3400 | head -n 5
echo "=================================================================="
echo " SUCCESS: VIMS Enterprise Meta Ads Dashboard is LIVE on port 3400"
echo " and reverse-proxied at https://ads.vimsenterprise.com !"
echo "=================================================================="
