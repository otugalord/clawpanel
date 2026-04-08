/**
 * Auth Terminal manager — spawns `claude auth login` as a PTY session
 * that the browser can attach to via WebSocket. Unlike the previous "parse
 * URL from backend" approach, the user sees the real terminal output and
 * can click the URL themselves. Session lifetime is capped at 5 minutes.
 *
 * Emits (via Node EventEmitter):
 *   - 'auth_code_submitted' { sessionId } — fired 5 seconds after the last
 *     user input arrived. Server listens for this and triggers a claude
 *     auth status check, broadcasting the result to WS clients.
 */
const pty = require('node-pty');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const MAX_SESSION_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_DEBOUNCE_MS = 5 * 1000;    // fire check 5s after the last keystroke

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

    let p;
    try {
      p = pty.spawn('claude', ['auth', 'login'], {
        name: 'xterm-256color',
        cols: 100,
        rows: 24,
        cwd: process.env.HOME || '/root',
        env,
      });
    } catch (e) {
      return { error: 'Failed to spawn claude: ' + e.message };
    }

    const session = {
      id,
      pty: p,
      listeners: new Set(),
      createdAt: Date.now(),
      timer: null,
      codeTimer: null, // debounced auth check trigger
      output: '', // small rolling buffer so late subscribers see what happened
    };

    p.onData((data) => {
      session.output += data;
      if (session.output.length > 20000) {
        session.output = session.output.slice(-12000);
      }
      for (const l of session.listeners) {
        try { l({ type: 'auth_terminal_output', sessionId: id, data }); } catch {}
      }
    });

    p.onExit(({ exitCode }) => {
      for (const l of session.listeners) {
        try { l({ type: 'auth_terminal_exit', sessionId: id, exitCode }); } catch {}
      }
      if (session.timer) clearTimeout(session.timer);
      if (session.codeTimer) clearTimeout(session.codeTimer);
      // When the PTY exits, the user probably completed auth. Fire the event
      // immediately so the server re-checks auth status right away.
      try { this.emit('auth_code_submitted', { sessionId: id, reason: 'pty_exit' }); } catch {}
      this.sessions.delete(id);
    });

    // Auto-kill after 5 minutes
    session.timer = setTimeout(() => {
      try { p.kill(); } catch {}
    }, MAX_SESSION_MS);

    this.sessions.set(id, session);
    return { id, createdAt: session.createdAt };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.write(data);
      // Debounce: every keystroke resets the 5s window so the full code has
      // time to be submitted before we check. A newline or carriage return
      // is a strong "I just submitted something" signal → also triggers.
      if (s.codeTimer) clearTimeout(s.codeTimer);
      s.codeTimer = setTimeout(() => {
        try { this.emit('auth_code_submitted', { sessionId: id, reason: 'debounce' }); } catch {}
      }, AUTH_DEBOUNCE_MS);
      return true;
    } catch {
      return false;
    }
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return false;
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

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.pty.kill(); } catch {}
    if (s.timer) clearTimeout(s.timer);
    if (s.codeTimer) clearTimeout(s.codeTimer);
    this.sessions.delete(id);
    return true;
  }

  get(id) { return this.sessions.get(id) || null; }
}

const authTerminal = new AuthTerminalManager();
module.exports = { authTerminal };
