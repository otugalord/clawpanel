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

const URL_REGEX = /(https:\/\/[^\s]+(?:claude\.ai|anthropic\.com)[^\s]*)/i;

function cleanAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function startLogin() {
  // Kill any previous session
  if (currentSession && currentSession.pty) {
    try { currentSession.pty.kill(); } catch {}
  }
  currentSession = null;

  return new Promise((resolve) => {
    const env = { ...process.env, TERM: 'xterm-256color' };
    // Remove API key so claude initiates OAuth
    delete env.ANTHROPIC_API_KEY;

    let p;
    try {
      // `claude /login` is the recommended way to trigger login. Fallback to
      // `claude` which prompts too.
      p = pty.spawn('claude', ['/login'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: process.env.HOME || '/root',
        env,
      });
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
        resolve({ ok: false, error: 'Timed out waiting for login URL' });
      }
    }, 15000);

    p.onData((data) => {
      const clean = cleanAnsi(data);
      session.output += clean;
      if (session.output.length > 20000) {
        session.output = session.output.slice(-10000);
      }
      if (!session.url) {
        const m = session.output.match(URL_REGEX);
        if (m) {
          session.url = m[1].replace(/[)\].,;'"`]+$/, '');
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ ok: true, url: session.url });
          }
        }
      }
    });

    p.onExit(() => {
      session.done = true;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        const err = session.url ? null : 'claude exited before producing a login URL';
        resolve(err ? { ok: false, error: err, output: session.output.slice(-500) } : { ok: true, url: session.url });
      }
    });
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
