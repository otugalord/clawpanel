#!/usr/bin/env bash
#
# ClawPanel installer — one-liner to self-host the platform
#
#   curl -fsSL https://raw.githubusercontent.com/otugalord/clawpanel/main/install.sh | bash
#
set -euo pipefail

INSTALL_DIR="${CLAWPANEL_DIR:-/opt/clawpanel}"
REPO_URL="${CLAWPANEL_REPO:-https://github.com/otugalord/clawpanel}"
PORT="${CLAWPANEL_PORT:-3000}"
SERVICE_NAME="clawpanel"

# ─── colors ─────────────────────────────────────────
bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }
info() { echo -e "  $(bold "→") $1"; }
ok() { echo -e "  $(green "✓") $1"; }
warn() { echo -e "  $(yellow "!") $1"; }
err() { echo -e "  $(red "✗") $1" >&2; }

echo
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        ClawPanel Installer v0.2.0        ║"
echo "  ╚═══════════════════════════════════════╝"
echo

# ─── root check ─────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This installer must be run as root (sudo bash install.sh)"
  exit 1
fi

# ─── OS check ───────────────────────────────────────
if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  warn "Only tested on Ubuntu 20.04+ / Debian 11+. Continuing anyway…"
fi

export DEBIAN_FRONTEND=noninteractive

# ─── base packages ──────────────────────────────────
info "Updating apt and installing base dependencies…"
apt-get update -qq
apt-get install -y -qq curl git build-essential python3 ca-certificates gnupg >/dev/null
ok "base: curl git build-essential python3"

# ─── Node.js 20 ─────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | grep -oE 'v[0-9]+' | tr -d v)" -lt 20 ]]; then
  info "Installing Node.js 20 (via NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)  npm $(npm -v)"

# ─── PM2 ────────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  info "Installing PM2 globally…"
  npm install -g pm2 >/dev/null 2>&1
fi
ok "pm2 $(pm2 -v)"

# ─── Claude Code CLI ────────────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  info "Installing Claude Code CLI (@anthropic-ai/claude-code)…"
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -3 || {
    warn "Failed to install claude CLI — you can install manually later: npm i -g @anthropic-ai/claude-code"
  }
fi
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>&1 | head -1)"
else
  warn "claude CLI not detected on PATH"
fi

# ─── clawpanel system user ──────────────────────────
# Claude Code refuses --dangerously-skip-permissions when run as root,
# so we create a dedicated unprivileged user that the backend drops
# privileges to whenever it spawns claude.
if ! id "clawpanel" >/dev/null 2>&1; then
  info "Creating 'clawpanel' system user…"
  useradd -m -s /bin/bash clawpanel
  ok "user 'clawpanel' created (uid=$(id -u clawpanel))"
else
  ok "user 'clawpanel' already exists (uid=$(id -u clawpanel))"
fi

# Ensure the user has a passwordless sudoers entry (only used for apt/apt-get
# operations during app setup — tighten this in production if desired)
if [[ ! -f /etc/sudoers.d/clawpanel ]]; then
  echo "clawpanel ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/clawpanel
  chmod 440 /etc/sudoers.d/clawpanel
  ok "sudoers.d entry added for clawpanel"
fi

# Mirror root's claude state (credentials + trust + projects + sessions) to
# the clawpanel user so it can run claude without re-authenticating.
mkdir -p /home/clawpanel/.claude
if [[ -d /root/.claude ]]; then
  # Copy entire directory tree (credentials, projects, sessions, mcp cache, ...)
  cp -r /root/.claude/. /home/clawpanel/.claude/ 2>/dev/null || true
  ok "mirrored /root/.claude → /home/clawpanel/.claude"
fi
if [[ -f /root/.claude.json ]]; then
  cp /root/.claude.json /home/clawpanel/.claude.json
  ok "trust config copied to /home/clawpanel/.claude.json"
fi
chown -R clawpanel:clawpanel /home/clawpanel/.claude /home/clawpanel/.claude.json 2>/dev/null || true
chmod 700 /home/clawpanel/.claude 2>/dev/null || true
find /home/clawpanel/.claude -name '.credentials.json' -exec chmod 600 {} \; 2>/dev/null || true

# Apps directory must be readable by the clawpanel user
mkdir -p /root/apps
chmod 755 /root 2>/dev/null || true
chmod -R 755 /root/apps 2>/dev/null || true

# ─── nginx ──────────────────────────────────────────
if ! command -v nginx >/dev/null 2>&1; then
  info "Installing nginx…"
  apt-get install -y -qq nginx >/dev/null
fi
ok "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# ─── certbot ────────────────────────────────────────
if ! command -v certbot >/dev/null 2>&1; then
  info "Installing certbot…"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
fi
ok "certbot $(certbot --version 2>&1 | awk '{print $2}')"

# ─── sqlite3 ────────────────────────────────────────
apt-get install -y -qq sqlite3 libsqlite3-dev >/dev/null || true

# ─── clone or update ────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating repository at $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || warn "git pull failed — using local version"
elif [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/backend/package.json" ]]; then
  info "Existing install without .git at $INSTALL_DIR — reusing"
else
  info "Cloning ClawPanel into $INSTALL_DIR…"
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | tail -3 || {
    err "git clone failed. Set CLAWPANEL_REPO or copy manually to $INSTALL_DIR"
    exit 1
  }
fi
ok "source code at $INSTALL_DIR"

# ─── npm install (backend) ──────────────────────────
info "Installing backend dependencies (this can take a while)…"
cd "$INSTALL_DIR/backend"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
ok "backend deps installed"

# ─── npm install + build (frontend) ─────────────────
info "Installing and building frontend…"
cd "$INSTALL_DIR/frontend"
npm install --no-audit --no-fund 2>&1 | tail -3
npm run build 2>&1 | tail -3
ok "frontend built at $INSTALL_DIR/frontend/dist"

# ─── apps dir ───────────────────────────────────────
mkdir -p /root/apps
chmod 755 /root/apps
ok "apps directory: /root/apps"

# ─── env file (JWT secret) ──────────────────────────
ENV_FILE="$INSTALL_DIR/backend/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  JWT_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
HOST=0.0.0.0
JWT_SECRET=$JWT_SECRET
EOF
  ok "created .env with random JWT_SECRET"
else
  ok ".env already exists (kept)"
fi

# ─── start with PM2 ─────────────────────────────────
info "Starting ClawPanel service under PM2…"
cd "$INSTALL_DIR/backend"
if pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
  pm2 restart "$SERVICE_NAME" --update-env >/dev/null
else
  pm2 start server.js --name "$SERVICE_NAME" --time --cwd "$INSTALL_DIR/backend" >/dev/null
fi
pm2 save --force >/dev/null 2>&1 || true

# pm2 startup (idempotent)
pm2 startup systemd -u root --hp /root 2>&1 | grep -Eo 'sudo.*' | bash 2>/dev/null || true

ok "pm2 service '$SERVICE_NAME' running"

# ─── nginx reverse proxy (port 80 → $PORT) ─────────
NGINX_CONF="/etc/nginx/sites-available/clawpanel.conf"

# Check port 80 — is something else already listening?
PORT80_HOLDER=""
if command -v ss >/dev/null 2>&1; then
  PORT80_HOLDER=$(ss -ltnp 2>/dev/null | awk '$4 ~ /:80$/ {print $NF}' | head -1)
fi
if [[ -n "$PORT80_HOLDER" && "$PORT80_HOLDER" != *"nginx"* ]]; then
  warn "port 80 already in use by: $PORT80_HOLDER (nginx will not serve on 80)"
fi

info "Writing nginx config (port 80 → $PORT)…"
cat > "$NGINX_CONF" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 50M;

    location /ws {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/clawpanel.conf
# Remove default site only if it exists and we're taking port 80
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

if nginx -t 2>&1 | grep -q "successful"; then
  systemctl enable nginx >/dev/null 2>&1 || true
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx && ok "nginx reloaded"
  else
    systemctl start nginx && ok "nginx started"
  fi
else
  warn "nginx -t failed — run: nginx -t"
  nginx -t 2>&1 | head -5 | sed 's/^/    /'
fi

# ─── firewall (ufw) ─────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null 2>&1 && ok "ufw: port 80/tcp allowed"
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw allow "$PORT"/tcp >/dev/null 2>&1 && ok "ufw: port $PORT/tcp allowed"
  fi
fi

# ─── health check ───────────────────────────────────
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "health check OK"
else
  warn "health check failed — run: pm2 logs clawpanel"
fi

# ─── done ───────────────────────────────────────────
IP=$(curl -fsS4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║  $(green '✓ ClawPanel installed successfully!')          ║"
echo "  ╚═══════════════════════════════════════════╝"
echo
echo "  $(bold 'Access:')       http://${IP}"
echo "  $(bold 'Direct port:')  http://${IP}:${PORT}"
echo "  $(bold 'Logs:')         pm2 logs clawpanel"
echo "  $(bold 'Restart:')      pm2 restart clawpanel"
echo
echo "  $(bold '1.') First visit → create your admin user."
echo
echo "  $(bold '2.') $(yellow 'IMPORTANT — Authenticate Claude Code:')"
echo "     Open ClawPanel → Settings → Sign in with Anthropic,"
echo "     or run $(bold 'claude setup-token') on the server."
echo "     Without this the Claude Code chat won't work."
echo

