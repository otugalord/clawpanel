/**
 * Auth Terminal manager — spawns `claude auth login` as a PTY session
 * that the browser can attach to via WebSocket.
 *
 * Lifecycle:
 *   1. `create()` spawns `claude auth login` which prints the OAuth URL and
 *      immediately exits (this is the claude CLI behaviour).
 *   2. We keep the session in memory in the "waiting_for_code" state and
 *      send a helpful message to the frontend. The embedded xterm stays
 *      open; the user sees the URL and instructions.
 *   3. The user clicks Authorize on Anthropic's page, gets a code, and
 *      pastes it into the manual input field below the terminal (or into
 *      the terminal itself). Each paste flows through `write()`.
 *   4. `write()` still fires the debounced `auth_code_submitted` event even
 *      if the PTY is no longer alive, so the server can re-check auth.
 *   5. After 10 minutes in "waiting_for_code", we time out and emit a final
 *      `auth_terminal_exit`.
 *
 * Emits (via Node EventEmitter):
 *   - 'auth_code_submitted' { sessionId, reason } — fired when we believe
 *     the user just submitted a code or when the PTY exits. Server listens
 *     for this and broadcasts the current claude auth status.
 */
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const WAITING_TTL_MS = 10 * 60 * 1000; // 10 minutes in waiting_for_code
const MAX_SPAWN_MS = 2 * 60 * 1000;    // kill a hung PTY after 2 min
const AUTH_DEBOUNCE_MS = 5 * 1000;     // fire check 5s after the last keystroke

class AuthTerminalManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // id -> { pty, listeners:Set, createdAt, timer, codeTimer }
  }

  create() {
    // Only ever keep one live auth session at a time — kill any previous
    for (const id of Array.from(this.sessions.keys())) {
      this.kill(id);
    }

    const id = uuidv4();
    const env = { ...process.env, TERM: 'xterm-256color' };
    // Remove any inherited API key so the CLI runs a real OAuth flow
    delete env.ANTHROPIC_API_KEY;

    // Use `claude setup-token` rather than `claude auth login` because:
    //  - setup-token has an interactive Ink TUI that stays alive waiting for
    //    the user to paste the code via stdin
    //  - auth login prints the URL then sits silently with no input prompt
    //  - setup-token validates the code immediately and reports success/error
    let p;
    try {
      p = pty.spawn('claude', ['setup-token'], {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: process.env.HOME || '/root',
        env,
      });
    } catch (e) {
      return { error: 'Failed to spawn claude: ' + e.message };
    }

    const session = {
      id,
      pty: p,
      state: 'active', // 'active' | 'waiting_for_code' | 'closed'
      listeners: new Set(),
      createdAt: Date.now(),
      spawnTimer: null,  // kills a hung PTY after MAX_SPAWN_MS
      waitTimer: null,   // final cleanup after WAITING_TTL_MS
      codeTimer: null,   // debounced auth check trigger
      output: '',        // rolling buffer so late subscribers see what happened
    };

    p.onData((data) => {
      session.output += data;
      if (session.output.length > 20000) {
        session.output = session.output.slice(-12000);
      }
      for (const l of session.listeners) {
        try { l({ type: 'auth_terminal_output', sessionId: id, data }); } catch {}
      }
      // Detect auth-completion signals from setup-token's TUI output.
      // Real claude success strings observed in cli.js:
      //   "Logged in as ..."
      //   "Authentication successful, but ..."
      //   "Successfully logged in"
      const cleanRecent = session.output
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .slice(-1500)
        .toLowerCase();
      if (
        !session.completed &&
        (cleanRecent.includes('logged in as') ||
         cleanRecent.includes('authentication successful') ||
         cleanRecent.includes('successfully logged in') ||
         cleanRecent.includes('token saved'))
      ) {
        session.completed = true;
        console.log('[auth-terminal] success detected from claude output');
        try {
          this.emit('auth_code_submitted', { sessionId: id, reason: 'success_detected' });
        } catch {}
      }
    });

    p.onExit(({ exitCode }) => {
      // The CLI has printed the URL and exited. Transition to waiting_for_code
      // and KEEP the session alive so the embedded terminal UI stays open
      // and the user can paste the auth code.
      session.state = 'waiting_for_code';
      session.pty = null;
      session.exitCode = exitCode;

      if (session.spawnTimer) {
        clearTimeout(session.spawnTimer);
        session.spawnTimer = null;
      }

      // Helpful prompt appended to the terminal output
      const helpMsg =
        '\r\n\x1b[33m📋 Copy the code from the Anthropic page and paste it in the field below.\x1b[0m\r\n';
      session.output += helpMsg;
      for (const l of session.listeners) {
        try { l({ type: 'auth_terminal_output', sessionId: id, data: helpMsg }); } catch {}
      }

      // Fire the auth check immediately — in case the CLI completed auth by
      // itself (older versions) or the user already had a valid session.
      try { this.emit('auth_code_submitted', { sessionId: id, reason: 'pty_exit' }); } catch {}

      // Schedule final cleanup after 10 minutes of waiting
      session.waitTimer = setTimeout(() => {
        if (!this.sessions.has(id)) return;
        for (const l of session.listeners) {
          try { l({ type: 'auth_terminal_exit', sessionId: id, reason: 'timeout' }); } catch {}
        }
        this.sessions.delete(id);
      }, WAITING_TTL_MS);
    });

    // Kill the PTY if it hangs without producing output (2 min safety)
    session.spawnTimer = setTimeout(() => {
      if (session.pty) {
        try { session.pty.kill(); } catch {}
      }
    }, MAX_SPAWN_MS);

    this.sessions.set(id, session);
    return { id, createdAt: session.createdAt };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return false;

    // If the PTY is still alive, forward keystrokes to it. After the PTY has
    // exited (waiting_for_code state), we echo what the user types back to the
    // terminal UI so they get visual feedback while pasting the code.
    if (s.pty) {
      try { s.pty.write(data); } catch {}
    } else if (s.state === 'waiting_for_code') {
      // Echo to the xterm so the user sees the code appearing
      for (const l of s.listeners) {
        try { l({ type: 'auth_terminal_output', sessionId: id, data }); } catch {}
      }
    }

    // Debounce: every keystroke resets the 5s window so the full code has
    // time to be submitted before we check. Works regardless of PTY state.
    if (s.codeTimer) clearTimeout(s.codeTimer);
    s.codeTimer = setTimeout(() => {
      try { this.emit('auth_code_submitted', { sessionId: id, reason: 'debounce' }); } catch {}
    }, AUTH_DEBOUNCE_MS);
    return true;
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return false;
    try { s.pty.resize(cols, rows); return true; } catch { return false; }
  }

  subscribe(id, listener) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.listeners.add(listener);
    // Replay buffered output so new subscribers catch up
    if (s.output) {
      try { listener({ type: 'auth_terminal_output', sessionId: id, data: s.output }); } catch {}
    }
    return true;
  }

  unsubscribe(id, listener) {
    const s = this.sessions.get(id);
    if (s) s.listeners.delete(listener);
  }

  kill(id, reason = 'cancelled') {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.pty) { try { s.pty.kill(); } catch {} }
    if (s.spawnTimer) clearTimeout(s.spawnTimer);
    if (s.waitTimer) clearTimeout(s.waitTimer);
    if (s.codeTimer) clearTimeout(s.codeTimer);
    // Notify listeners explicitly — this is the only path that should emit
    // auth_terminal_exit to the frontend (natural PTY exit is silent on the
    // UI, we just transition to waiting_for_code).
    for (const l of s.listeners) {
      try { l({ type: 'auth_terminal_exit', sessionId: id, reason }); } catch {}
    }
    this.sessions.delete(id);
    return true;
  }

  get(id) { return this.sessions.get(id) || null; }
}

const authTerminal = new AuthTerminalManager();
module.exports = { authTerminal };
