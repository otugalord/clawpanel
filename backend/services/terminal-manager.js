const pty = require('node-pty');
const { v4: uuidv4 } = require('uuid');

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // id -> { pty, listeners:Set, cwd, createdAt }
  }

  create(cwd = '/root') {
    const id = uuidv4();
    const shell = process.env.SHELL || '/bin/bash';
    const p = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    const session = { id, pty: p, listeners: new Set(), cwd, createdAt: Date.now() };
    p.onData((data) => {
      for (const l of session.listeners) { try { l({ type: 'terminal_output', sessionId: id, data }); } catch {} }
    });
    p.onExit(() => {
      for (const l of session.listeners) { try { l({ type: 'terminal_exit', sessionId: id }); } catch {} }
      this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    return { id, cwd, createdAt: session.createdAt };
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.pty.write(data);
    return true;
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.pty.resize(cols, rows); return true; } catch { return false; }
  }

  subscribe(id, listener) {
    const s = this.sessions.get(id);
    if (s) s.listeners.add(listener);
  }

  unsubscribe(id, listener) {
    const s = this.sessions.get(id);
    if (s) s.listeners.delete(listener);
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    try { s.pty.kill(); } catch {}
    this.sessions.delete(id);
    return true;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt }));
  }
}

const terminalManager = new TerminalManager();
module.exports = { terminalManager };
