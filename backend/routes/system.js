const express = require('express');
const si = require('systeminformation');
const os = require('os');
const fsLib = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { db, getSetting, setSetting } = require('../db/database');
const pm2svc = require('../services/pm2');
const claudeLogin = require('../services/claude-login');

const router = express.Router();

// ─── Claude Code CLI status ───────────────────────────────────────────────
/**
 * Real check: spawn `claude auth status --json` and parse the output.
 * Folder-existence heuristics are unreliable — on a dev box ~/.claude can
 * exist from previous use even when the current credentials are invalid.
 *
 * If the user configured an API key in settings, that takes precedence and
 * is considered "authenticated" regardless of the OAuth session state.
 */
function runClaudeAuthStatus() {
  try {
    const env = { ...process.env };
    // Ask claude about its OAuth session, ignoring any ANTHROPIC_API_KEY that
    // might be in the parent env (otherwise the CLI may short-circuit).
    delete env.ANTHROPIC_API_KEY;
    const out = execSync('claude auth status --json', {
      encoding: 'utf8',
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    const trimmed = (out || '').trim();
    if (!trimmed) return { ok: false, loggedIn: false };
    // Some CLI versions prefix with ANSI or banner lines — extract the JSON block
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) return { ok: false, loggedIn: false, raw: trimmed };
    const json = JSON.parse(trimmed.slice(start, end + 1));
    return {
      ok: true,
      loggedIn: !!json.loggedIn,
      authMethod: json.authMethod || null,
      apiProvider: json.apiProvider || null,
      email: json.email || null,
      orgName: json.orgName || null,
      subscriptionType: json.subscriptionType || null,
    };
  } catch (e) {
    // If the command is missing or exits non-zero, treat as not-logged-in
    const stderr = (e.stderr && e.stderr.toString()) || e.message || '';
    return { ok: false, loggedIn: false, error: stderr.slice(0, 300) };
  }
}

function checkClaudeStatus() {
  const result = {
    installed: false,
    authenticated: false,
    authMethod: null, // 'api_key' | 'oauth' | null
    version: null,
    binary: null,
    configDir: null,
    email: null,
    subscriptionType: null,
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

    // Config dir (informational only — NOT used to decide authentication)
    const home = process.env.HOME || '/root';
    result.configDir = path.join(home, '.claude');

    // Precedence: API key in settings wins for spawning claude in chat mode
    const apiKey = getSetting('anthropic_api_key');
    if (apiKey && apiKey.trim()) {
      result.authenticated = true;
      result.authMethod = 'api_key';
    }

    // Real OAuth check via `claude auth status --json`
    const authStatus = runClaudeAuthStatus();
    if (authStatus.ok && authStatus.loggedIn) {
      // Promote to authenticated if not already set by api_key
      if (!result.authenticated) {
        result.authenticated = true;
        result.authMethod = 'oauth';
      } else {
        result.oauthAlsoAvailable = true;
      }
      result.email = authStatus.email;
      result.subscriptionType = authStatus.subscriptionType;
    } else if (!result.authenticated && authStatus.error) {
      result.error = authStatus.error;
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

// ─── Claude OAuth login flow ────────────────────────────────────────────
// POST /api/system/claude-login/start → spawns claude login PTY, returns URL
router.post('/claude-login/start', async (req, res) => {
  try {
    const result = await claudeLogin.startLogin();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/system/claude-login/status → current login session state
router.get('/claude-login/status', (req, res) => {
  const loginStatus = claudeLogin.getStatus();
  const claudeStatus = checkClaudeStatus();
  res.json({ login: loginStatus, claude: claudeStatus });
});

// POST /api/system/claude-login/code → submit verification code if claude asks
router.post('/claude-login/code', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  const ok = claudeLogin.sendCode(code);
  res.json({ ok });
});

// POST /api/system/claude-login/cancel
router.post('/claude-login/cancel', (req, res) => {
  claudeLogin.cancel();
  res.json({ ok: true });
});

// POST /api/system/claude-api-key → save / clear the Anthropic API key
router.post('/claude-api-key', (req, res) => {
  const { api_key } = req.body || {};
  if (api_key === null || api_key === '') {
    setSetting('anthropic_api_key', '');
    return res.json({ ok: true, cleared: true });
  }
  if (typeof api_key !== 'string' || !api_key.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Invalid API key. Must start with sk-ant-' });
  }
  setSetting('anthropic_api_key', api_key.trim());
  res.json({ ok: true });
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
