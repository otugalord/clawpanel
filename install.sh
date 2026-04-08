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
echo "  ║        ClawPanel Installer v0.1.0        ║"
echo "  ╚═══════════════════════════════════════╝"
echo

# ─── root check ─────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "Este instalador tem de ser executado como root (sudo bash install.sh)"
  exit 1
fi

# ─── OS check ───────────────────────────────────────
if ! grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null; then
  warn "Só testado em Ubuntu 20.04+ / Debian 11+. A continuar mesmo assim…"
fi

export DEBIAN_FRONTEND=noninteractive

# ─── base packages ──────────────────────────────────
info "A actualizar apt e a instalar dependências base…"
apt-get update -qq
apt-get install -y -qq curl git build-essential python3 ca-certificates gnupg >/dev/null
ok "base: curl git build-essential python3"

# ─── Node.js 20 ─────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | grep -oE 'v[0-9]+' | tr -d v)" -lt 20 ]]; then
  info "A instalar Node.js 20 (via NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v)  npm $(npm -v)"

# ─── PM2 ────────────────────────────────────────────
if ! command -v pm2 >/dev/null 2>&1; then
  info "A instalar PM2 global…"
  npm install -g pm2 >/dev/null 2>&1
fi
ok "pm2 $(pm2 -v)"

# ─── nginx ──────────────────────────────────────────
if ! command -v nginx >/dev/null 2>&1; then
  info "A instalar nginx…"
  apt-get install -y -qq nginx >/dev/null
fi
ok "nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# ─── certbot ────────────────────────────────────────
if ! command -v certbot >/dev/null 2>&1; then
  info "A instalar certbot…"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
fi
ok "certbot $(certbot --version 2>&1 | awk '{print $2}')"

# ─── sqlite3 ────────────────────────────────────────
apt-get install -y -qq sqlite3 libsqlite3-dev >/dev/null || true

# ─── clone or update ────────────────────────────────
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "A actualizar repositório em $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only >/dev/null 2>&1 || warn "git pull falhou — a usar versão local"
elif [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/backend/package.json" ]]; then
  info "Instalação existente sem .git em $INSTALL_DIR — a reutilizar"
else
  info "A clonar ClawPanel para $INSTALL_DIR…"
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR" 2>&1 | tail -3 || {
    err "Falhou git clone. Define CLAWPANEL_REPO ou copia manualmente para $INSTALL_DIR"
    exit 1
  }
fi
ok "código em $INSTALL_DIR"

# ─── npm install (backend) ──────────────────────────
info "A instalar dependências backend (pode demorar)…"
cd "$INSTALL_DIR/backend"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
ok "backend deps instaladas"

# ─── npm install + build (frontend) ─────────────────
info "A instalar e buildar frontend…"
cd "$INSTALL_DIR/frontend"
npm install --no-audit --no-fund 2>&1 | tail -3
npm run build 2>&1 | tail -3
ok "frontend buildado em $INSTALL_DIR/frontend/dist"

# ─── apps dir ───────────────────────────────────────
mkdir -p /root/apps
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
  ok "criado .env com JWT_SECRET aleatório"
else
  ok ".env já existe (mantido)"
fi

# ─── start with PM2 ─────────────────────────────────
info "A (re)iniciar serviço ClawPanel com PM2…"
cd "$INSTALL_DIR/backend"
if pm2 describe "$SERVICE_NAME" >/dev/null 2>&1; then
  pm2 restart "$SERVICE_NAME" --update-env >/dev/null
else
  pm2 start server.js --name "$SERVICE_NAME" --time --cwd "$INSTALL_DIR/backend" >/dev/null
fi
pm2 save --force >/dev/null 2>&1 || true

# pm2 startup (idempotent)
pm2 startup systemd -u root --hp /root 2>&1 | grep -Eo 'sudo.*' | bash 2>/dev/null || true

ok "pm2 service '$SERVICE_NAME' a correr"

# ─── nginx reverse proxy (port 80 → 3000) ──────────
NGINX_CONF="/etc/nginx/sites-available/clawpanel.conf"
if [[ ! -f "$NGINX_CONF" ]]; then
  info "A criar config nginx (porta 80 → $PORT)…"
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
    }
}
EOF
  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/clawpanel.conf
  rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx || systemctl restart nginx
    ok "nginx configurado e recarregado"
  else
    warn "nginx -t falhou — config criada mas não aplicada"
  fi
else
  ok "config nginx já existe"
fi

# ─── firewall (ufw) ─────────────────────────────────
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
fi

# ─── health check ───────────────────────────────────
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "health check OK"
else
  warn "health check falhou — ver: pm2 logs clawpanel"
fi

# ─── done ───────────────────────────────────────────
IP=$(curl -fsS4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║  $(green '✓ ClawPanel instalado com sucesso!')         ║"
echo "  ╚═══════════════════════════════════════════╝"
echo
echo "  $(bold 'Aceder:')       http://${IP}"
echo "  $(bold 'Porta direta:') http://${IP}:${PORT}"
echo "  $(bold 'Logs:')         pm2 logs clawpanel"
echo "  $(bold 'Restart:')      pm2 restart clawpanel"
echo
echo "  Primeira visita → cria o utilizador administrador."
echo
