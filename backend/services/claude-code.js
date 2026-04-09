/**
 * Claude Code chat manager — uses `claude --print` (non-interactive mode)
 * with stable session IDs for conversation continuity.
 *
 * Why not interactive PTY?
 *   - The interactive TUI requires several confirmation dialogs (folder
 *     trust + bypass-permissions warning) that are fragile to handle
 *     programmatically.
 *   - --print mode automatically skips the trust dialog and runs cleanly
 *     even as root with IS_SANDBOX=1.
 *   - --session-id <uuid> + --resume gives us conversation continuity.
 *
 * Lifecycle per project:
 *   - First message: spawn `claude -p --session-id <uuid> "msg"` in cwd
 *   - Save the uuid in memory
 *   - Subsequent messages: spawn `claude -p --resume <uuid> "msg"` in cwd
 *
 * Each spawn streams stdout/stderr back to listeners, which the WS layer
 * forwards as `claude_output` chunks and ends with `claude_done`.
 */
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('../db/database');
const { getCredentialFiles, extractTokenFromCredentialsJson } = require('../routes/system');

// ─── Non-root user for spawning claude ───────────────────────────────────
// Running claude as root triggers "--dangerously-skip-permissions cannot be
// used with root/sudo privileges". The install.sh creates a dedicated
// `clawpanel` system user that we drop privileges to when spawning claude.
const CLAWPANEL_USER = process.env.CLAWPANEL_USER || 'clawpanel';
const CLAWPANEL_HOME = process.env.CLAWPANEL_HOME || `/home/${CLAWPANEL_USER}`;

let _cachedUserInfo = null;
function getClawpanelUser() {
  if (_cachedUserInfo !== null) return _cachedUserInfo;
  if (process.getuid && process.getuid() !== 0) {
    // Not running as root — no need (or ability) to drop privileges
    _cachedUserInfo = { drop: false };
    return _cachedUserInfo;
  }
  try {
    const uid = parseInt(execSync(`id -u ${CLAWPANEL_USER} 2>/dev/null`).toString().trim(), 10);
    const gid = parseInt(execSync(`id -g ${CLAWPANEL_USER} 2>/dev/null`).toString().trim(), 10);
    if (!Number.isNaN(uid) && !Number.isNaN(gid)) {
      _cachedUserInfo = { drop: true, uid, gid, home: CLAWPANEL_HOME };
      console.log(`[claude-code] will drop privileges to ${CLAWPANEL_USER} (uid=${uid} gid=${gid})`);
      return _cachedUserInfo;
    }
  } catch {}
  console.warn(`[claude-code] ⚠ ${CLAWPANEL_USER} user not found — claude will run as current user`);
  _cachedUserInfo = { drop: false };
  return _cachedUserInfo;
}

/**
 * Ensure the clawpanel user has a copy of the current credentials file.
 * Called lazily before spawning so any credentials that landed in /root/.claude
 * (e.g. from a previous auth flow) are mirrored to /home/clawpanel/.claude.
 */
function syncCredentialsToClawpanelUser() {
  const info = getClawpanelUser();
  if (!info.drop) return; // Not running as root, nothing to sync
  const targetDir = path.join(info.home, '.claude');
  const targetFile = path.join(targetDir, '.credentials.json');
  try {
    // Find the newest source credentials file
    let sourceFile = null;
    let sourceMtime = 0;
    for (const f of getCredentialFiles()) {
      if (f === targetFile) continue;
      try {
        if (fs.existsSync(f)) {
          const st = fs.statSync(f);
          if (st.mtimeMs > sourceMtime) {
            sourceFile = f;
            sourceMtime = st.mtimeMs;
          }
        }
      } catch {}
    }
    if (!sourceFile) return;
    // Target older than source → copy
    let copy = true;
    try {
      if (fs.existsSync(targetFile)) {
        const tst = fs.statSync(targetFile);
        if (tst.mtimeMs >= sourceMtime) copy = false;
      }
    } catch {}
    if (!copy) return;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.copyFileSync(sourceFile, targetFile);
    try {
      fs.chownSync(targetDir, info.uid, info.gid);
      fs.chownSync(targetFile, info.uid, info.gid);
    } catch {}
    console.log(`[claude-code] synced credentials ${sourceFile} → ${targetFile}`);
  } catch (e) {
    console.error('[claude-code] syncCredentialsToClawpanelUser failed:', e.message);
  }
}


// projectId -> { sessionId, cwd, listeners: Set, current: ChildProcess|null, createdAt }
const sessions = new Map();

function uuidv4() {
  return crypto.randomUUID();
}

/**
 * Strip ANSI escape sequences and terminal control codes so they don't
 * appear as □[?25h garbage in the chat UI.
 */
function stripAnsi(s) {
  if (!s) return s;
  return String(s)
    // CSI sequences (colors, cursor, erase): \x1b[...X
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Character-set selection: \x1b(B, \x1b)0 etc
    .replace(/\x1b[()][A-Z0-9]/g, '')
    // DEC private-mode single chars: \x1b=, \x1b>
    .replace(/\x1b[=>]/g, '')
    // Stray single ESC and BEL
    .replace(/[\x1b\x07]/g, '');
}

function getSession(projectId) {
  return sessions.get(projectId) || null;
}

function listSessions() {
  return [...sessions.entries()].map(([projectId, s]) => ({
    projectId,
    sessionId: s.sessionId,
    cwd: s.cwd,
    createdAt: s.createdAt,
    streaming: !!s.current,
  }));
}

/**
 * Build the env vars for spawning claude. Tries (in order):
 *   1. DB anthropic_api_key  → ANTHROPIC_API_KEY
 *   2. existing CLAUDE_CODE_OAUTH_TOKEN env
 *   3. ~/.claude/.credentials.json → CLAUDE_CODE_OAUTH_TOKEN + HOME
 */
function buildEnv() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  env.IS_SANDBOX = '1';
  env.CI = '1';

  // If we're going to drop to the clawpanel user, HOME must point to its home
  // directory so claude finds the credentials there.
  const info = getClawpanelUser();
  if (info.drop) {
    env.HOME = info.home;
    env.USER = CLAWPANEL_USER;
    env.LOGNAME = CLAWPANEL_USER;
  }

  // 1. API key takes precedence
  const apiKey = getSetting('anthropic_api_key');
  if (apiKey && apiKey.trim()) {
    env.ANTHROPIC_API_KEY = apiKey.trim();
    return env;
  }
  delete env.ANTHROPIC_API_KEY;

  // 2. Already-set OAuth token in env
  if (env.CLAUDE_CODE_OAUTH_TOKEN && /sk-ant-oat/.test(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return env;
  }

  // 3. Read from credentials file and inject
  // Prefer the clawpanel user's own credentials file if it exists
  const candidates = [];
  if (info.drop) candidates.push(path.join(info.home, '.claude', '.credentials.json'));
  candidates.push(...getCredentialFiles());
  try {
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const extracted = extractTokenFromCredentialsJson(raw);
      if (extracted && extracted.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = extracted.token;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = extracted.token;
        console.log(`[claude-code] using OAuth token from ${file}`);
        return env;
      }
    }
  } catch (e) {
    console.error('[claude-code] failed to read credentials file:', e.message);
  }
  return env;
}

/**
 * Mark a folder as trusted in claude's per-user config so the CLI doesn't
 * show the workspace trust dialog when not running with --print.
 */
function trustProjectFolder(folder, claudeHome) {
  const info = getClawpanelUser();
  const targets = new Set();
  targets.add(claudeHome || process.env.HOME || '/root');
  if (info.drop) targets.add(info.home);
  for (const home of targets) {
    try {
      const cfgPath = path.join(home, '.claude.json');
      let cfg = {};
      if (fs.existsSync(cfgPath)) {
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8') || '{}'); } catch {}
      }
      if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
      if (!cfg.projects[folder]) cfg.projects[folder] = {};
      cfg.projects[folder].hasTrustDialogAccepted = true;
      cfg.bypassPermissionsModeAccepted = true;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      // Fix ownership of the file we just wrote if it's in the clawpanel home
      if (info.drop && home === info.home) {
        try { fs.chownSync(cfgPath, info.uid, info.gid); } catch {}
      }
    } catch {}
  }
}

function ensureSession(projectId, cwd) {
  let s = sessions.get(projectId);
  if (!s) {
    if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
    s = {
      sessionId: uuidv4(),
      cwd,
      listeners: new Set(),
      current: null,
      createdAt: Date.now(),
    };
    sessions.set(projectId, s);
  }
  return s;
}

function _emit(session, projectId, payload) {
  for (const l of session.listeners) {
    try { l(payload); } catch {}
  }
}

/**
 * Send a message to claude for this project. Streams the response chunks
 * back via listeners as `claude_output` events, then `claude_done` on
 * completion.
 */
function sendMessage(projectId, cwd, message) {
  const s = ensureSession(projectId, cwd);
  // Kill any in-flight request for this project before starting a new one
  if (s.current) {
    try { s.current.kill(); } catch {}
    s.current = null;
  }

  // Mirror credentials from whichever location they live in to the clawpanel
  // user's home before each spawn. Cheap (mtime-gated copy) and idempotent.
  syncCredentialsToClawpanelUser();

  const env = buildEnv();
  const info = getClawpanelUser();
  trustProjectFolder(cwd, env.HOME);
  // Also make sure the clawpanel user can read the project folder
  if (info.drop) {
    try {
      const st = fs.statSync(cwd);
      if (st.uid !== info.uid || st.gid !== info.gid) {
        // chmod to allow read/execute by the clawpanel user so it can cd into it
        fs.chmodSync(cwd, 0o755);
      }
    } catch {}
  }

  const isFirst = !s.hasFirstMessage;
  // Use --session-id for the first message, --resume for subsequent ones.
  // --dangerously-skip-permissions is safe to pass now that we drop to a
  // dedicated non-root user (claude only refuses it as root).
  const args = ['--print', '--dangerously-skip-permissions'];
  if (isFirst) {
    args.push('--session-id', s.sessionId);
  } else {
    args.push('--resume', s.sessionId);
  }
  args.push(message);

  console.log(`[claude-code] spawn project=${projectId} session=${s.sessionId.slice(0,8)} first=${isFirst} drop=${info.drop}`);
  const spawnOpts = { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] };
  if (info.drop) {
    spawnOpts.uid = info.uid;
    spawnOpts.gid = info.gid;
  }
  const child = spawn('claude', args, spawnOpts);
  s.current = child;
  s.hasFirstMessage = true;

  let stderrBuf = '';
  child.stdout.on('data', (data) => {
    const clean = stripAnsi(data.toString());
    if (clean) _emit(s, projectId, { type: 'claude_output', projectId, data: clean });
  });
  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuf += text;
    // Forward stderr too — the user can see errors live
    const clean = stripAnsi(text);
    if (clean) _emit(s, projectId, { type: 'claude_output', projectId, data: clean });
  });
  child.on('error', (err) => {
    _emit(s, projectId, {
      type: 'claude_output',
      projectId,
      data: `\n[ClawPanel] Failed to spawn claude: ${err.message}\n`,
    });
    _emit(s, projectId, { type: 'claude_done', projectId });
    s.current = null;
  });
  child.on('exit', (code, signal) => {
    s.current = null;
    if (code !== 0 && code !== null) {
      console.warn(`[claude-code] exit code=${code} stderr=${stderrBuf.slice(-200)}`);
    }
    _emit(s, projectId, { type: 'claude_done', projectId, exitCode: code });
  });
  return true;
}

function sendRawInput(projectId, cwd, data) {
  // No interactive PTY in print mode — convert raw input to a message.
  // Strip control characters and treat the buffer as a message.
  const text = String(data || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  if (!text) return false;
  return sendMessage(projectId, cwd, text);
}

function killSession(projectId) {
  const s = sessions.get(projectId);
  if (!s) return false;
  if (s.current) {
    try { s.current.kill(); } catch {}
    s.current = null;
  }
  // Reset session id so the next message starts a new conversation
  s.sessionId = uuidv4();
  s.hasFirstMessage = false;
  return true;
}

function subscribe(projectId, listener) {
  const s = sessions.get(projectId);
  if (s) s.listeners.add(listener);
}

function unsubscribe(projectId, listener) {
  const s = sessions.get(projectId);
  if (s) s.listeners.delete(listener);
}

// Server.js historically called spawnSession() to ensure a session existed
// before subscribing. We keep that name for backward compat — it just creates
// the in-memory state, no process is spawned until the first sendMessage().
function spawnSession(projectId, cwd) {
  return ensureSession(projectId, cwd);
}

module.exports = {
  getSession, spawnSession, sendMessage, sendRawInput, killSession,
  subscribe, unsubscribe, listSessions, syncCredentialsToClawpanelUser,
};
