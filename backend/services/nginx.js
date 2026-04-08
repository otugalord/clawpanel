const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SITES_AVAILABLE = '/etc/nginx/sites-available';
const SITES_ENABLED = '/etc/nginx/sites-enabled';

function safeDomain(d) {
  if (!/^[a-z0-9.-]+$/i.test(d)) throw new Error('Invalid domain');
  return d.trim().toLowerCase();
}

function buildConfig(domain, port) {
  const d = safeDomain(domain);
  const p = parseInt(port, 10);
  if (!p || p < 1 || p > 65535) throw new Error('Invalid port');
  return `# VPSOne auto-generated for ${d}
server {
    listen 80;
    listen [::]:80;
    server_name ${d} www.${d};

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:${p};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
`;
}

function writeConfig(domain, port) {
  const d = safeDomain(domain);
  if (!fs.existsSync(SITES_AVAILABLE)) fs.mkdirSync(SITES_AVAILABLE, { recursive: true });
  if (!fs.existsSync(SITES_ENABLED)) fs.mkdirSync(SITES_ENABLED, { recursive: true });
  const confPath = path.join(SITES_AVAILABLE, `${d}.conf`);
  fs.writeFileSync(confPath, buildConfig(d, port), 'utf8');
  const linkPath = path.join(SITES_ENABLED, `${d}.conf`);
  if (!fs.existsSync(linkPath)) {
    try { fs.symlinkSync(confPath, linkPath); } catch {}
  }
  return confPath;
}

function removeConfig(domain) {
  const d = safeDomain(domain);
  const confPath = path.join(SITES_AVAILABLE, `${d}.conf`);
  const linkPath = path.join(SITES_ENABLED, `${d}.conf`);
  try { fs.unlinkSync(linkPath); } catch {}
  try { fs.unlinkSync(confPath); } catch {}
}

function testConfig() {
  try {
    execSync('nginx -t', { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString() || e.message };
  }
}

function reload() {
  try {
    execSync('nginx -s reload', { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString() || e.message };
  }
}

function streamCommand(cmd, args, onData) {
  const proc = spawn(cmd, args);
  proc.stdout.on('data', (d) => onData(d.toString()));
  proc.stderr.on('data', (d) => onData(d.toString()));
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
  });
}

module.exports = { buildConfig, writeConfig, removeConfig, testConfig, reload, streamCommand, safeDomain };
