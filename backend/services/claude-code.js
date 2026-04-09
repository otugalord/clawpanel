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
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSetting } = require('../db/database');
const { getCredentialFiles, extractTokenFromCredentialsJson } = require('../routes/system');

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
  // Required when running as root so the CLI accepts --dangerously-skip-permissions
  env.IS_SANDBOX = '1';
  env.CI = '1';

  const apiKey = getSetting('anthropic_api_key');
  if (apiKey && apiKey.trim()) {
    env.ANTHROPIC_API_KEY = apiKey.trim();
    return env;
  }
  delete env.ANTHROPIC_API_KEY;

  if (env.CLAUDE_CODE_OAUTH_TOKEN && /sk-ant-oat/.test(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return env;
  }

  try {
    for (const file of getCredentialFiles()) {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const extracted = extractTokenFromCredentialsJson(raw);
      if (extracted && extracted.token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = extracted.token;
        process.env.CLAUDE_CODE_OAUTH_TOKEN = extracted.token;
        const home = file.includes('/.claude/') ? file.split('/.claude/')[0] : null;
        if (home) env.HOME = home;
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
  try {
    const home = claudeHome || process.env.HOME || '/root';
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
  } catch {}
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

  const env = buildEnv();
  trustProjectFolder(cwd, env.HOME);

  const isFirst = !s.hasFirstMessage;
  // Use --session-id for the first message, --resume for subsequent ones.
  // No --dangerously-skip-permissions: it's rejected when running as root
  // even with IS_SANDBOX=1. --print mode auto-skips the trust dialog so
  // we don't need it.
  const args = ['--print'];
  if (isFirst) {
    args.push('--session-id', s.sessionId);
  } else {
    args.push('--resume', s.sessionId);
  }
  args.push(message);

  console.log(`[claude-code] spawn project=${projectId} session=${s.sessionId.slice(0,8)} first=${isFirst}`);
  // stdio: ignore stdin (claude --print otherwise waits 3s for piped input)
  const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  subscribe, unsubscribe, listSessions,
};
