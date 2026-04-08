/**
 * Claude Code OAuth login helper.
 *
 * Spawns a headless PTY running the `claude` CLI in login mode, parses the
 * OAuth URL from its output, and keeps the PTY alive in the background so the
 * user can complete the browser flow. When claude writes credentials to
 * ~/.claude/ the PTY will naturally finish and the next call to
 * /api/system/claude-status returns authenticated=true.
 */
const pty = require('node-pty');

let currentSession = null; // { pty, output, url, startedAt, done }

// Match any URL on anthropic.com or claude.ai (OAuth flow can use either)
const URL_REGEX = /(https?:\/\/[^\s"'<>`]*?(?:claude\.ai|anthropic\.com)[^\s"'<>`]*)/i;

function cleanAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\(B/g, '')
    .replace(/\x1b=/g, '')
    .replace(/\x1b>/g, '');
}

function spawnClaude(args) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  // Remove API key so claude initiates OAuth instead of using the key
  delete env.ANTHROPIC_API_KEY;
  return pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: process.env.HOME || '/root',
    env,
  });
}

async function startLogin() {
  // Kill any previous session
  if (currentSession && currentSession.pty) {
    try { currentSession.pty.kill(); } catch {}
  }
  currentSession = null;

  return new Promise((resolve) => {
    // `claude auth login` is the real command for OAuth flow.
    // Fallbacks in case the CLI changes: `claude /login` then plain `claude`.
    const argCandidates = [
      ['auth', 'login'],
      ['/login'],
      [],
    ];

    let attempt = 0;
    let p;
    try {
      p = spawnClaude(argCandidates[attempt]);
    } catch (e) {
      return resolve({ ok: false, error: 'Failed to spawn claude: ' + e.message });
    }

    const session = {
      pty: p,
      output: '',
      url: null,
      startedAt: Date.now(),
      done: false,
    };
    currentSession = session;

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled && !session.url) {
        settled = true;
        resolve({
          ok: false,
          error: 'Timed out waiting for login URL (30s)',
          output: session.output.slice(-800),
        });
      }
    }, 30000);

    const tryExtractUrl = () => {
      if (session.url) return;
      const m = session.output.match(URL_REGEX);
      if (m) {
        session.url = m[1].replace(/[)\].,;'"`]+$/, '');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve({ ok: true, url: session.url });
        }
      }
    };

    const attachListeners = (proc) => {
      proc.onData((data) => {
        const clean = cleanAnsi(data);
        session.output += clean;
        if (session.output.length > 40000) {
          session.output = session.output.slice(-20000);
        }
        tryExtractUrl();

        // Some claude versions ask the user to choose auth method or press Enter
        // before printing the URL. Send newlines to nudge it.
        if (!session.url && /select|choose|press|enter|continue/i.test(clean)) {
          try { proc.write('\r'); } catch {}
        }
      });

      proc.onExit(({ exitCode }) => {
        session.done = true;
        if (settled) return;
        // Try the next candidate if the current one died without producing a URL
        if (!session.url && attempt < argCandidates.length - 1) {
          attempt += 1;
          try {
            p = spawnClaude(argCandidates[attempt]);
            session.pty = p;
            session.done = false;
            attachListeners(p);
            return;
          } catch (e) {
            // fall through to resolve with error
          }
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: `claude exited (code ${exitCode}) before producing a login URL`,
          output: session.output.slice(-800),
        });
      });
    };

    attachListeners(p);
  });
}

function getStatus() {
  if (!currentSession) return { active: false };
  return {
    active: !currentSession.done,
    url: currentSession.url,
    startedAt: currentSession.startedAt,
    done: currentSession.done,
    outputTail: currentSession.output.slice(-400),
  };
}

function sendCode(code) {
  if (!currentSession || !currentSession.pty || currentSession.done) return false;
  try {
    currentSession.pty.write(String(code || '') + '\r');
    return true;
  } catch {
    return false;
  }
}

function cancel() {
  if (currentSession && currentSession.pty) {
    try { currentSession.pty.kill(); } catch {}
  }
  currentSession = null;
  return true;
}

module.exports = { startLogin, getStatus, sendCode, cancel };
