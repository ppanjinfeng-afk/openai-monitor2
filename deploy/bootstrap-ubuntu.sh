#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR="${2:-/opt/openai-monitor}"
APP_USER="${SUDO_USER:-${USER:-root}}"
NODE_MAJOR="${NODE_MAJOR:-20}"
APP_BRANCH="${APP_BRANCH:-main}"
START_SERVICES="${START_SERVICES:-true}"
CERTBOT_DOMAINS="${CERTBOT_DOMAINS:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://xn--2team-cd2h.com}"
PUBLIC_TUNNEL_ENABLED="${PUBLIC_TUNNEL_ENABLED:-}"
ADMIN_BASIC_AUTH_ENABLED="${ADMIN_BASIC_AUTH_ENABLED:-}"
ADMIN_BASIC_AUTH_USER="${ADMIN_BASIC_AUTH_USER:-}"
ADMIN_BASIC_AUTH_PASS="${ADMIN_BASIC_AUTH_PASS:-}"
APP_HOME="$(getent passwd "$APP_USER" | awk -F: '{print $6}' || true)"
APP_HOME="${APP_HOME:-/home/$APP_USER}"
PUPPETEER_CACHE_DIR="${PUPPETEER_CACHE_DIR:-$APP_HOME/.cache/puppeteer}"
CDK_TEAM_WORKER_CONCURRENCY="${CDK_TEAM_WORKER_CONCURRENCY:-3}"
BROWSER_TASK_CONCURRENCY="${BROWSER_TASK_CONCURRENCY:-3}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: bash bootstrap-ubuntu.sh <repo-url> [app-dir]"
  echo "Optional env: APP_BRANCH, CERTBOT_DOMAINS, CERTBOT_EMAIL, PUBLIC_BASE_URL, CDK_TEAM_WORKER_CONCURRENCY, BROWSER_TASK_CONCURRENCY, ADMIN_BASIC_AUTH_USER, ADMIN_BASIC_AUTH_PASS"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/8] Installing system packages..."
apt-get update
apt-get install -y curl git unzip build-essential python3 nginx ca-certificates certbot python3-certbot-nginx

CURRENT_NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if (( CURRENT_NODE_MAJOR < NODE_MAJOR )); then
  echo "[2/8] Installing Node.js ${NODE_MAJOR}..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "[2/8] Node.js already installed: $(node -v)"
fi

echo "[3/8] Installing Puppeteer runtime libraries..."
apt-get install -y \
  fonts-liberation \
  libasound2t64 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  xdg-utils

echo "[4/8] Cloning or updating project branch: $APP_BRANCH"
mkdir -p "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" reset --hard "origin/$APP_BRANCH"
else
  rm -rf "$APP_DIR"
  git clone --branch "$APP_BRANCH" "$REPO_URL" "$APP_DIR"
fi

mkdir -p "$APP_DIR/data"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "[5/8] Installing npm dependencies..."
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
mkdir -p "$PUPPETEER_CACHE_DIR"
PUPPETEER_CACHE_DIR="$PUPPETEER_CACHE_DIR" npx puppeteer browsers install chrome || true
chown -R "$APP_USER":"$APP_USER" "$APP_HOME/.cache" 2>/dev/null || true

if [[ -n "$PUBLIC_TUNNEL_ENABLED" ]]; then
  echo "Setting public_tunnel_enabled=$PUBLIC_TUNNEL_ENABLED"
  PUBLIC_TUNNEL_ENABLED="$PUBLIC_TUNNEL_ENABLED" node - <<'NODE'
const db = require('./db');
db.prepare(`
  INSERT INTO settings (key, value)
  VALUES ('public_tunnel_enabled', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(process.env.PUBLIC_TUNNEL_ENABLED);
NODE
fi

if [[ -n "$ADMIN_BASIC_AUTH_ENABLED$ADMIN_BASIC_AUTH_USER$ADMIN_BASIC_AUTH_PASS" ]]; then
  echo "Configuring admin auth settings..."
  ADMIN_BASIC_AUTH_ENABLED="$ADMIN_BASIC_AUTH_ENABLED" \
  ADMIN_BASIC_AUTH_USER="$ADMIN_BASIC_AUTH_USER" \
  ADMIN_BASIC_AUTH_PASS="$ADMIN_BASIC_AUTH_PASS" \
    node "$APP_DIR/deploy/scripts/configure-admin-auth.js"
fi

echo "[6/8] Installing systemd services..."
cp "$APP_DIR/deploy/systemd/openai-monitor.service" /etc/systemd/system/openai-monitor.service
cp "$APP_DIR/deploy/systemd/openai-monitor-healthcheck.service" /etc/systemd/system/openai-monitor-healthcheck.service
cp "$APP_DIR/deploy/systemd/openai-monitor-healthcheck.timer" /etc/systemd/system/openai-monitor-healthcheck.timer
cp "$APP_DIR/deploy/systemd/openai-monitor-cdk-expire.service" /etc/systemd/system/openai-monitor-cdk-expire.service
cp "$APP_DIR/deploy/systemd/openai-monitor-cdk-expire.timer" /etc/systemd/system/openai-monitor-cdk-expire.timer
chmod +x "$APP_DIR/deploy/scripts/openai-monitor-healthcheck.sh"
mkdir -p /etc/systemd/system/openai-monitor.service.d
{
  echo "[Service]"
  echo "Environment=PUPPETEER_CACHE_DIR=$PUPPETEER_CACHE_DIR"
  echo "Environment=PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
  echo "Environment=CDK_TEAM_WORKER_CONCURRENCY=$CDK_TEAM_WORKER_CONCURRENCY"
  echo "Environment=BROWSER_TASK_CONCURRENCY=$BROWSER_TASK_CONCURRENCY"
} > /etc/systemd/system/openai-monitor.service.d/runtime.conf
systemctl daemon-reload

echo "[7/8] Installing nginx config..."
cp "$APP_DIR/deploy/nginx/openai-monitor.conf" /etc/nginx/sites-available/openai-monitor.conf
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/openai-monitor.conf /etc/nginx/sites-enabled/openai-monitor.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [[ "$START_SERVICES" == "true" ]]; then
  systemctl enable --now openai-monitor
  systemctl enable --now openai-monitor-healthcheck.timer
  systemctl enable --now openai-monitor-cdk-expire.timer
fi

echo "[8/8] Optional HTTPS..."
if [[ -n "$CERTBOT_DOMAINS" ]]; then
  certbot_args=(--nginx --non-interactive --agree-tos --redirect)
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    certbot_args+=(--email "$CERTBOT_EMAIL")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi

  IFS=',' read -ra domains <<< "$CERTBOT_DOMAINS"
  for domain in "${domains[@]}"; do
    domain="$(echo "$domain" | xargs)"
    if [[ -n "$domain" ]]; then
      certbot_args+=(-d "$domain")
    fi
  done

  certbot "${certbot_args[@]}"
  nginx -t
  systemctl reload nginx
else
  echo "Skipping HTTPS. Set CERTBOT_DOMAINS=example.com,www.example.com to enable it."
fi

echo
echo "Done."
echo "Useful checks:"
echo "   systemctl status openai-monitor --no-pager"
echo "   systemctl status nginx --no-pager"
echo "   curl http://127.0.0.1:3000/api/checks/status"
echo
echo "If you have an existing database, upload it to:"
echo "   $APP_DIR/data/monitor.db"
echo "Then restart:"
echo "   systemctl restart openai-monitor"
echo
echo "Service status:"
echo "   systemctl status openai-monitor --no-pager"
echo "   systemctl status openai-monitor-healthcheck.timer --no-pager"
echo "   systemctl status openai-monitor-cdk-expire.timer --no-pager"
