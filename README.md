# ClawPanel

> Self-hosted VPS management platform with native Claude Code AI integration.

ClawPanel turns any Ubuntu/Debian VPS into a full-featured control panel with a built-in AI coding assistant. Manage your apps, domains, SSL, and terminals from a single dark-themed web UI — and build new projects interactively through Claude Code right in your browser.

<p align="center">
  <img alt="stack" src="https://img.shields.io/badge/stack-Node%2020%20%7C%20Express%20%7C%20React%20%7C%20SQLite-6c63ff">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

## Install

One-line installer (run as root on a fresh Ubuntu/Debian VPS):

```bash
curl -fsSL https://raw.githubusercontent.com/otugalord/clawpanel/main/install.sh | bash
```

The installer is idempotent — you can safely re-run it to update. It installs Node.js 20, PM2, nginx, certbot, clones the repo, builds the frontend, starts ClawPanel under PM2, and configures an nginx reverse proxy on port 80.

After the install finishes, open `http://<your-server-ip>` in your browser and create the admin account (setup wizard).

---

## Features

- 🤖 **Claude Code AI Chat** — a full chat interface with a persistent `claude` CLI PTY session per project. Stream responses live to the browser with markdown rendering, live preview iframe, and slash commands (`/clear`, `/restart`, `/preview`).
- 📦 **App Manager (PM2)** — register, start, stop, restart and delete Node.js apps. Auto-detect scripts, free-port scanner, real-time CPU/RAM/uptime stats.
- 🖥️ **Live Terminal** — full xterm.js terminal tabs with real PTY sessions over WebSocket. Resize-aware, multi-session.
- 🌐 **Domain Manager + SSL** — add domains, link them to apps (automatic nginx config generation), install Let's Encrypt SSL via certbot with live log streaming.
- 📊 **System Dashboard** — CPU, RAM, disk, uptime, running processes, and recent Claude Code activity. Stats refresh every 10 seconds over WebSocket.
- 🔑 **API Keys** — generate and revoke API keys for headless access; use with `X-API-Key` header.
- 🔒 **JWT auth** — 7-day tokens, rate-limited login, first-run setup wizard.

---

## Requirements

- **OS:** Ubuntu 20.04+ or Debian 11+
- **RAM:** 1 GB minimum (2 GB recommended for the frontend build)
- **Disk:** 1 GB free
- **Network:** HTTP (port 80) accessible; port 3000 is used internally by the backend
- **Claude Code CLI:** installed and authenticated on the server — ClawPanel shells out to `claude` so it must be on the `PATH`. Install instructions: https://docs.anthropic.com/claude-code

ClawPanel automatically installs: `node` (20.x via NodeSource), `npm`, `pm2` (global), `nginx`, `certbot`, and `sqlite3`.

---

## Usage

### First run

1. Browse to `http://<your-server-ip>` after the installer completes.
2. The setup wizard asks you to pick a username and password for the admin account.
3. You land on the Dashboard showing your server stats.

### Create your first app

1. Go to **Apps** → click **Nova App**.
2. Pick a name (e.g. `my-blog`) — ClawPanel creates `/root/apps/my-blog/` and auto-assigns a free port.
3. Click the **Claude** icon on the app card. You land in the Claude Code chat with that folder as the working directory.
4. Ask Claude to build whatever you want: *"Build a Node.js Express hello world server and start it"*.
5. Back on **Apps**, hit **Start** — PM2 picks up the script and runs it.

### Connect a domain

1. Point your DNS A record to the server IP.
2. Go to **Domínios** → **Adicionar** → type the domain.
3. Click **Ligar** and pick the app. ClawPanel generates the nginx config and reloads.
4. Click **Install SSL** to run certbot automatically. Live logs stream into the browser.

### Terminal

Open the **Terminal** tab for a full bash session in your browser. Multi-tab support — each tab is an independent PTY.

### Settings

- Change the admin password
- Generate API keys for headless / CI access
- Set your Anthropic API key (picked up automatically by the Claude Code CLI)
- Configure the apps directory (default: `/root/apps`)

---

## Architecture

```
  browser ─┬─ HTTP  ──┐
           │          ▼
           │    nginx :80
           │          │
           │          ▼
           └─ WS ── Express :3000 ──┬─ SQLite (better-sqlite3)
                                    ├─ node-pty  ─── bash / claude CLI
                                    ├─ PM2 API   ─── user apps
                                    └─ certbot / nginx shell-outs
```

**Backend:** Node.js 20 + Express + WebSocket (`ws`) + `better-sqlite3` + `node-pty` + `pm2` + `systeminformation`

**Frontend:** React 18 + Vite + `react-router-dom` + `@xterm/xterm` + `marked` + `lucide-react` + `react-hot-toast`

**Database:** SQLite at `/opt/clawpanel/backend/clawpanel.db` (auto-created on first run)

---

## Development

```bash
# Backend (port 3000)
cd backend
npm install
node server.js

# Frontend (port 5173, proxies /api and /ws to :3000)
cd frontend
npm install
npm run dev
```

---

## Service management

```bash
pm2 logs clawpanel          # tail logs
pm2 restart clawpanel       # restart
pm2 stop clawpanel          # stop
pm2 monit                   # interactive monitor
```

Database lives at `backend/clawpanel.db`. Environment variables in `backend/.env`:

```
PORT=3000
HOST=0.0.0.0
JWT_SECRET=<random-generated>
```

---

## Security notes

- Always change the default admin password after setup.
- The JWT secret is generated randomly by the installer — keep `backend/.env` private.
- ClawPanel runs as root by default (needed for nginx/certbot/apps management). Run it behind a firewall and only expose port 80/443.
- The Claude Code PTY is spawned with `--dangerously-skip-permissions` so it can write to project folders without prompting. Only give access to trusted users.

---

## License

MIT © 2026 [otugalord](https://github.com/otugalord)
