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
function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Attempt 1: claude auth status --json (preferred, structured) */
function tryJsonStatus() {
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const out = execSync('claude auth status --json', {
      encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const trimmed = stripAnsi(out).trim();
    if (!trimmed) return null;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    const json = JSON.parse(trimmed.slice(start, end + 1));
    return {
      source: 'json',
      loggedIn: !!json.loggedIn,
      authMethod: json.authMethod || null,
      apiProvider: json.apiProvider || null,
      email: json.email || null,
      orgName: json.orgName || null,
      subscriptionType: json.subscriptionType || null,
    };
  } catch {
    return null;
  }
}

/** Attempt 2: plain `claude auth status` — regex for "logged in" / email */
function tryPlainTextStatus() {
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const out = execSync('claude auth status', {
      encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const clean = stripAnsi(out);
    const low = clean.toLowerCase();
    const emailMatch = clean.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const notLoggedIn = /not (?:logged in|authenticated)|no account|please (?:log ?in|sign ?in)/.test(low);
    const loggedIn =
      !notLoggedIn && (
        /(logged in|authenticated|signed in)/.test(low) ||
        !!emailMatch
      );
    return {
      source: 'plain',
      loggedIn,
      email: emailMatch ? emailMatch[0] : null,
      raw: clean.slice(0, 300),
    };
  } catch {
    return null;
  }
}

/** Attempt 3: `claude --version` — last-resort reachability check */
function tryVersionCheck() {
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const out = execSync('claude --version', {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    const clean = stripAnsi(out).toLowerCase();
    if (!clean) return { source: 'version', loggedIn: false };
    if (/not (?:logged in|authenticated)|unauthorized|auth error/.test(clean)) {
      return { source: 'version', loggedIn: false };
    }
    // Version ran clean with no auth error → last-resort assume authenticated.
    // This only gets consulted if the other two failed entirely.
    return { source: 'version', loggedIn: true };
  } catch {
    return { source: 'version', loggedIn: false };
  }
}

/**
 * Attempt 4: read ~/.claude/.credentials.json directly.
 *
 * The real format used by `claude setup-token` is:
 *   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-...", ... } }
 *
 * We look for nested OAuth fields, top-level token fields, or any
 * sk-ant-oat string anywhere in the file. Returns the extracted token
 * so other parts of the system can pass it as CLAUDE_CODE_OAUTH_TOKEN.
 */
function getCredentialFiles() {
  const homes = new Set();
  if (process.env.HOME) homes.add(process.env.HOME);
  homes.add('/root');
  // Also check common dev install locations
  homes.add('/home/' + (process.env.USER || ''));
  const files = [];
  for (const h of homes) {
    if (!h || h === '/home/') continue;
    files.push(path.join(h, '.claude', '.credentials.json'));
    files.push(path.join(h, '.claude', 'credentials.json'));
  }
  return files;
}

function extractTokenFromCredentialsJson(raw) {
  if (!raw || !raw.trim()) return null;
  // Try parse first — handles nested objects properly
  try {
    const j = JSON.parse(raw);
    // Common shapes:
    //  { claudeAiOauth: { accessToken: "..." } }
    //  { access_token: "..." }
    //  { oauth_token: "..." }
    //  { token: "sk-ant-..." }
    if (j.claudeAiOauth && typeof j.claudeAiOauth === 'object') {
      const t = j.claudeAiOauth.accessToken || j.claudeAiOauth.access_token;
      if (t) return { token: t, email: j.claudeAiOauth.email || null, sub: j.claudeAiOauth.subscriptionType || null };
    }
    if (j.access_token) return { token: j.access_token, email: j.email || null };
    if (j.oauth_token || j.oauthToken) return { token: j.oauth_token || j.oauthToken, email: j.email || null };
    if (j.token && /sk-ant-/i.test(j.token)) return { token: j.token, email: j.email || null };
  } catch {}
  // Fallback: regex sweep for sk-ant-oat pattern
  const m = raw.match(/sk-ant-oat[A-Za-z0-9_-]+/);
  if (m) return { token: m[0], email: null };
  return null;
}

function tryCredentialsFile() {
  for (const file of getCredentialFiles()) {
    try {
      if (!fsLib.existsSync(file)) continue;
      const raw = fsLib.readFileSync(file, 'utf8');
      const extracted = extractTokenFromCredentialsJson(raw);
      if (extracted && extracted.token) {
        return {
          source: 'credentials_file',
          loggedIn: true,
          authMethod: 'oauth',
          email: extracted.email,
          subscriptionType: extracted.sub || null,
          token: extracted.token,
          file,
        };
      }
    } catch {}
  }
  return null;
}

/** Attempt 5: env / .env file fallback */
function tryEnvToken() {
  // Direct env var
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN && /sk-ant-oat/.test(process.env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return { source: 'env', loggedIn: true, authMethod: 'oauth', token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  // .env file in backend dir (in case PM2 didn't pick up the var)
  const envCandidates = [
    path.join(__dirname, '..', '.env'),
    '/opt/clawpanel/backend/.env',
    '/root/clawpanel/backend/.env',
  ];
  for (const f of envCandidates) {
    try {
      if (!fsLib.existsSync(f)) continue;
      const raw = fsLib.readFileSync(f, 'utf8');
      const m = raw.match(/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*["']?(sk-ant-oat[A-Za-z0-9_-]+)["']?/);
      if (m) {
        // Cache into process.env for subsequent calls
        process.env.CLAUDE_CODE_OAUTH_TOKEN = m[1];
        return { source: 'env_file', loggedIn: true, authMethod: 'oauth', token: m[1], file: f };
      }
    } catch {}
  }
  return null;
}

function runClaudeAuthStatus() {
  // Order of precedence — return as soon as we find auth evidence.
  // IMPORTANT: do NOT cache the short-lived accessToken from credentials.json
  // into process.env — that would override the CLI's own token-refresh logic.
  // Only cache long-lived tokens (from setup-token / CLAUDE_CODE_OAUTH_TOKEN).
  const env = tryEnvToken();
  if (env) {
    // Long-lived token from env → safe to cache
    if (env.token) process.env.CLAUDE_CODE_OAUTH_TOKEN = env.token;
    return { ok: true, ...env };
  }
  const f = tryCredentialsFile();
  if (f) {
    // Found credentials file — don't inject the token into process.env
    // (it's short-lived). Just confirm auth exists.
    return { ok: true, ...f };
  }
  const j = tryJsonStatus();
  if (j && j.loggedIn) return { ok: true, ...j };
  const p = tryPlainTextStatus();
  if (p && p.loggedIn) return { ok: true, ...p };
  // Fall back to whatever the structured calls returned (even if loggedIn=false)
  if (j) return { ok: true, ...j };
  if (p) return { ok: true, ...p };
  const v = tryVersionCheck();
  if (v) return { ok: v.loggedIn === true, ...v };
  return { ok: false, loggedIn: false };
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

// ─── Stats with 5-second cache ────────────────────────────────────────────
let _statsCache = null;
let _statsCacheTime = 0;
const STATS_TTL = 5000; // 5 seconds

router.get('/stats', async (req, res) => {
  const now = Date.now();
  if (_statsCache && now - _statsCacheTime < STATS_TTL) {
    return res.json(_statsCache);
  }
  _statsCache = await getStats();
  _statsCacheTime = now;
  res.json(_statsCache);
});

// GET /api/system/claude-status — always fresh, no cache
router.get('/claude-status', (req, res) => {
  // Clear any stale env token that might have been cached from a deleted credentials file
  const home = process.env.HOME || '/root';
  const credPath = path.join(home, '.claude', '.credentials.json');
  if (!fsLib.existsSync(credPath) && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // Token in env but no creds file → might be stale
    // Don't clear it outright (could be a long-lived setup-token), but
    // flag the status so the frontend knows
  }
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

// GET /api/system/logs — last 100 lines of the log file
router.get('/logs', (req, res) => {
  try {
    const logDir = process.env.CLAWPANEL_LOG_DIR || path.join(__dirname, '..', 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logDir, `clawpanel-${today}.log`);
    if (!fsLib.existsSync(logFile)) return res.json({ lines: [] });
    const content = fsLib.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/info — public IP, hostname, OS
let _cachedIp = null;
function getServerIp() {
  if (_cachedIp) return _cachedIp;
  try {
    _cachedIp = execSync("hostname -I | awk '{print $1}'", { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    _cachedIp = '127.0.0.1';
  }
  return _cachedIp;
}

router.get('/info', async (req, res) => {
  try {
    const osinfo = await si.osInfo();
    res.json({
      ip: getServerIp(),
      hostname: osinfo.hostname,
      os: osinfo.distro || osinfo.platform,
      uptime: os.uptime(),
    });
  } catch (e) {
    res.json({ ip: getServerIp(), hostname: os.hostname(), os: os.platform(), uptime: os.uptime() });
  }
});

module.exports = {
  router,
  getStats,
  checkClaudeStatus,
  getServerIp,
  getCredentialFiles,
  extractTokenFromCredentialsJson,
};
