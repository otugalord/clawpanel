const express = require('express');
const si = require('systeminformation');
const os = require('os');
const fsLib = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { db, getSetting, setSetting } = require('../db/database');
const pm2svc = require('../services/pm2');

const router = express.Router();

// ─── Claude Code CLI status ───────────────────────────────────────────────
function checkClaudeStatus() {
  const result = {
    installed: false,
    authenticated: false,
    version: null,
    binary: null,
    configDir: null,
    error: null,
  };
  try {
    // Is the binary on PATH?
    const which = execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!which) throw new Error('claude not on PATH');
    result.binary = which;
    result.installed = true;

    // Version
    try {
      result.version = execSync('claude --version', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {}

    // Check auth — ~/.claude dir with credentials/settings
    const home = process.env.HOME || '/root';
    const configDir = path.join(home, '.claude');
    result.configDir = configDir;
    if (fsLib.existsSync(configDir)) {
      // Heuristics: any of these files indicate the user has auth state
      const signals = [
        '.credentials.json',
        'credentials.json',
        'settings.json',
        'auth.json',
        'oauth.json',
      ];
      const found = signals.some((f) => fsLib.existsSync(path.join(configDir, f)));
      // Also accept any file inside the dir (setup has ran at least once)
      let hasAny = false;
      try {
        hasAny = fsLib.readdirSync(configDir).length > 0;
      } catch {}
      result.authenticated = found || hasAny;
    }
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

async function getStats() {
  try {
    const [cpu, mem, fs, load, time, osinfo] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpu(),
      si.time(),
      si.osInfo(),
    ]);
    const rootFs = fs.find((f) => f.mount === '/') || fs[0] || { size: 0, used: 0 };
    return {
      cpu: { load: +(cpu.currentLoad || 0).toFixed(1), cores: load.cores, brand: load.brand },
      ram: { total: mem.total, used: mem.active, free: mem.available, pct: +((mem.active / mem.total) * 100).toFixed(1) },
      disk: { total: rootFs.size, used: rootFs.used, pct: +((rootFs.used / rootFs.size) * 100).toFixed(1) },
      uptime: time.uptime,
      hostname: osinfo.hostname,
      platform: osinfo.platform,
      distro: osinfo.distro,
    };
  } catch (e) {
    return {
      cpu: { load: 0 }, ram: { total: os.totalmem(), used: os.totalmem() - os.freemem() },
      disk: {}, uptime: os.uptime(), hostname: os.hostname(),
      error: e.message,
    };
  }
}

// GET /api/system/stats
router.get('/stats', async (req, res) => {
  res.json(await getStats());
});

// GET /api/system/claude-status
router.get('/claude-status', (req, res) => {
  res.json(checkClaudeStatus());
});

// GET /api/system/dashboard
router.get('/dashboard', async (req, res) => {
  const stats = await getStats();
  let procs = [];
  try { procs = await pm2svc.list(); } catch {}
  const runningApps = procs.filter((p) => p.pm2_env?.status === 'online').length;
  const apps = db.prepare('SELECT * FROM apps').all();
  const domains = db.prepare('SELECT * FROM domains').all();
  // last claude activity
  const claudeRows = db.prepare(`
    SELECT cs.*, a.name as project_name
    FROM claude_sessions cs
    JOIN apps a ON a.id = cs.project_id
    ORDER BY cs.updated_at DESC LIMIT 5
  `).all();
  res.json({
    stats,
    apps: apps.length,
    runningApps,
    domains: domains.length,
    procs: procs.length,
    claudeActivity: claudeRows.map((r) => {
      let last = null;
      try {
        const msgs = JSON.parse(r.messages || '[]');
        last = msgs[msgs.length - 1];
      } catch {}
      return {
        project_id: r.project_id,
        project_name: r.project_name,
        updated_at: r.updated_at,
        last_role: last?.role,
        last_snippet: last?.content?.slice(0, 120),
      };
    }),
  });
});

// GET /api/system/settings
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const out = {};
  for (const r of rows) {
    // Mask secrets
    if (r.key.includes('api_key') || r.key.includes('secret') || r.key.includes('password')) {
      out[r.key] = r.value ? '***' + r.value.slice(-4) : '';
    } else {
      out[r.key] = r.value;
    }
  }
  res.json({ settings: out });
});

// PUT /api/system/settings
router.put('/settings', (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.startsWith('***')) continue; // ignore masked echo
    setSetting(k, v);
  }
  res.json({ ok: true });
});

module.exports = { router, getStats };
