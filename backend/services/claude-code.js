/**
 * Claude Code PTY session manager.
 * One persistent pty per project (app) id. If it dies, next message respawns.
 */
const pty = require('node-pty');
const fs = require('fs');
const { getSetting } = require('../db/database');

const sessions = new Map(); // projectId -> { pty, listeners:Set, cwd, createdAt }

function getSession(projectId) {
  return sessions.get(projectId) || null;
}

function spawnSession(projectId, cwd) {
  if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, TERM: 'xterm-256color' };
  const anthropicKey = getSetting('anthropic_api_key');
  if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;

  const claudePath = process.env.CLAUDE_BIN || 'claude';
  let p;
  try {
    p = pty.spawn(claudePath, ['--dangerously-skip-permissions'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    });
  } catch (e) {
    console.error('[claude-code] spawn failed:', e.message);
    return null;
  }

  const session = {
    pty: p,
    listeners: new Set(),
    cwd,
    createdAt: Date.now(),
    buffer: '',
    isStreaming: false,
    idleTimer: null,
  };

  p.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > 200000) session.buffer = session.buffer.slice(-100000);
    session.isStreaming = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.isStreaming = false;
      for (const l of session.listeners) { try { l({ type: 'claude_done', projectId }); } catch {} }
    }, 800);
    for (const l of session.listeners) { try { l({ type: 'claude_output', projectId, data }); } catch {} }
  });

  p.onExit(({ exitCode }) => {
    for (const l of session.listeners) { try { l({ type: 'claude_exit', projectId, exitCode }); } catch {} }
    sessions.delete(projectId);
  });

  sessions.set(projectId, session);
  return session;
}

function sendMessage(projectId, cwd, message) {
  let session = sessions.get(projectId);
  if (!session || !session.pty) session = spawnSession(projectId, cwd);
  if (!session) return false;
  // Claude CLI treats \r as submission in interactive mode
  session.pty.write(message + '\r');
  return true;
}

function sendRawInput(projectId, cwd, data) {
  let session = sessions.get(projectId);
  if (!session || !session.pty) session = spawnSession(projectId, cwd);
  if (!session) return false;
  session.pty.write(data);
  return true;
}

function killSession(projectId) {
  const s = sessions.get(projectId);
  if (!s) return false;
  try { s.pty.kill(); } catch {}
  sessions.delete(projectId);
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

function listSessions() {
  const out = [];
  for (const [id, s] of sessions.entries()) {
    out.push({ projectId: id, cwd: s.cwd, createdAt: s.createdAt, streaming: s.isStreaming });
  }
  return out;
}

module.exports = {
  getSession, spawnSession, sendMessage, sendRawInput, killSession,
  subscribe, unsubscribe, listSessions,
};
