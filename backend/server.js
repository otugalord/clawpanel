/**
 * ClawPanel — self-hosted VPS management platform
 * Express + WebSocket + SQLite + node-pty
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const { db } = require('./db/database');
const { router: authRouter, authMiddleware, verifyJwtToken } = require('./routes/auth');
const appsRouter = require('./routes/apps');
const domainsRouter = require('./routes/domains');
const claudeRouter = require('./routes/claude');
const terminalRouter = require('./routes/terminal');
const { router: systemRouter, getStats } = require('./routes/system');
const claudeSvc = require('./services/claude-code');
const { terminalManager } = require('./services/terminal-manager');
const { authTerminal } = require('./services/auth-terminal');
const pm2svc = require('./services/pm2');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

const app = express();
const server = http.createServer(app);

// ─── Security headers (HTTP-safe) ────────────────────────────────────────
// We intentionally don't use helmet() because its defaults ship COOP/COEP
// headers that break window.open() on plain HTTP origins (where ClawPanel
// most often runs initially). We set only the headers that matter and are
// safe over HTTP. Nginx/certbot can add HSTS later once HTTPS is set up.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  // Only emit HSTS when the request actually came in over HTTPS
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, version: '0.1.0' }));

// Public auth routes
app.use('/api/auth', authRouter);

// Protected API
app.use('/api/apps', authMiddleware, appsRouter);
app.use('/api/domains', authMiddleware, domainsRouter);
app.use('/api/claude', authMiddleware, claudeRouter);
app.use('/api/terminal', authMiddleware, terminalRouter);
app.use('/api/system', authMiddleware, systemRouter);

// Serve built frontend in production
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res.type('text').send('ClawPanel API up. Frontend not built yet — cd frontend && npm run build')
  );
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
const statsSubs = new Set();
const logSubs = new Map(); // appName -> Set<ws>

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) { if (c.readyState === 1) c.send(data); }
}

app.set('wsBroadcast', broadcast);

wss.on('connection', (ws, req) => {
  // Auth via ?token=...
  const urlObj = new URL(req.url, 'http://localhost');
  const token = urlObj.searchParams.get('token');
  if (!token || !verifyJwtToken(token)) {
    wsSend(ws, { type: 'error', error: 'unauthorized' });
    try { ws.close(); } catch {}
    return;
  }
  ws.clawpanelUser = verifyJwtToken(token);

  ws.claudeSubs = new Set(); // projectIds
  ws.terminalSubs = new Set(); // session ids
  ws.authTerminalSubs = new Set(); // auth terminal session ids
  ws.statsSubscribed = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    for (const pid of ws.claudeSubs) claudeSvc.unsubscribe(pid, ws.claudeListener);
    for (const sid of ws.terminalSubs) terminalManager.unsubscribe(sid, ws.terminalListener);
    for (const sid of ws.authTerminalSubs) authTerminal.unsubscribe(sid, ws.authTerminalListener);
    statsSubs.delete(ws);
    for (const set of logSubs.values()) set.delete(ws);
  });

  ws.claudeListener = (payload) => wsSend(ws, payload);
  ws.terminalListener = (payload) => wsSend(ws, payload);
  ws.authTerminalListener = (payload) => wsSend(ws, payload);

  wsSend(ws, { type: 'ready' });
});

async function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'claude_message': {
      const pid = parseInt(msg.projectId, 10);
      const project = db.prepare('SELECT * FROM apps WHERE id=?').get(pid);
      if (!project) return wsSend(ws, { type: 'error', error: 'project not found' });

      // Subscribe if not yet
      if (!ws.claudeSubs.has(pid)) {
        // Ensure session exists
        if (!claudeSvc.getSession(pid)) claudeSvc.spawnSession(pid, project.folder);
        claudeSvc.subscribe(pid, ws.claudeListener);
        ws.claudeSubs.add(pid);
      }
      claudeSvc.sendMessage(pid, project.folder, msg.message || '');
      // Persist user message
      let session = db.prepare('SELECT * FROM claude_sessions WHERE project_id=?').get(pid);
      if (!session) {
        const info = db.prepare('INSERT INTO claude_sessions(project_id) VALUES (?)').run(pid);
        session = db.prepare('SELECT * FROM claude_sessions WHERE id=?').get(info.lastInsertRowid);
      }
      const messages = JSON.parse(session.messages || '[]');
      messages.push({ role: 'user', content: msg.message, at: new Date().toISOString() });
      db.prepare('UPDATE claude_sessions SET messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(JSON.stringify(messages), session.id);
      break;
    }
    case 'claude_subscribe': {
      const pid = parseInt(msg.projectId, 10);
      const project = db.prepare('SELECT * FROM apps WHERE id=?').get(pid);
      if (!project) return;
      if (!claudeSvc.getSession(pid)) claudeSvc.spawnSession(pid, project.folder);
      if (!ws.claudeSubs.has(pid)) {
        claudeSvc.subscribe(pid, ws.claudeListener);
        ws.claudeSubs.add(pid);
      }
      break;
    }
    case 'claude_raw': {
      const pid = parseInt(msg.projectId, 10);
      const project = db.prepare('SELECT * FROM apps WHERE id=?').get(pid);
      if (!project) return;
      claudeSvc.sendRawInput(pid, project.folder, msg.data || '');
      break;
    }
    case 'terminal_create': {
      const session = terminalManager.create(msg.cwd || process.env.HOME || '/root');
      terminalManager.subscribe(session.id, ws.terminalListener);
      ws.terminalSubs.add(session.id);
      wsSend(ws, { type: 'terminal_ready', sessionId: session.id, cwd: session.cwd });
      break;
    }
    case 'terminal_subscribe': {
      if (!ws.terminalSubs.has(msg.sessionId)) {
        terminalManager.subscribe(msg.sessionId, ws.terminalListener);
        ws.terminalSubs.add(msg.sessionId);
      }
      break;
    }
    case 'terminal_input': {
      terminalManager.write(msg.sessionId, msg.data || '');
      break;
    }
    case 'terminal_resize': {
      terminalManager.resize(msg.sessionId, msg.cols || 80, msg.rows || 24);
      break;
    }
    case 'terminal_kill': {
      terminalManager.kill(msg.sessionId);
      ws.terminalSubs.delete(msg.sessionId);
      break;
    }
    // ─── AUTH TERMINAL (claude auth login PTY) ─────────────────
    case 'auth_terminal_create': {
      const result = authTerminal.create();
      if (result.error) {
        wsSend(ws, { type: 'auth_terminal_error', error: result.error });
        break;
      }
      authTerminal.subscribe(result.id, ws.authTerminalListener);
      ws.authTerminalSubs.add(result.id);
      wsSend(ws, { type: 'auth_terminal_ready', sessionId: result.id });
      break;
    }
    case 'auth_terminal_input': {
      authTerminal.write(msg.sessionId, msg.data || '');
      break;
    }
    case 'auth_terminal_resize': {
      authTerminal.resize(msg.sessionId, msg.cols || 100, msg.rows || 24);
      break;
    }
    case 'auth_terminal_kill': {
      authTerminal.kill(msg.sessionId);
      ws.authTerminalSubs.delete(msg.sessionId);
      break;
    }
    case 'subscribe_stats': {
      if (!ws.statsSubscribed) {
        statsSubs.add(ws);
        ws.statsSubscribed = true;
        const s = await getStats();
        wsSend(ws, { type: 'stats', ...s });
      }
      break;
    }
    case 'subscribe_logs': {
      const appName = msg.appName;
      if (!appName) return;
      if (!logSubs.has(appName)) logSubs.set(appName, new Set());
      logSubs.get(appName).add(ws);
      // Start tailing via pm2 if not already
      startLogTail(appName);
      break;
    }
    case 'unsubscribe_logs': {
      const set = logSubs.get(msg.appName);
      if (set) set.delete(ws);
      break;
    }
    case 'ping':
      wsSend(ws, { type: 'pong' });
      break;
  }
}

// ─── Stats broadcast loop ─────────────────────────────────────────────────
setInterval(async () => {
  if (statsSubs.size === 0) return;
  const s = await getStats();
  const payload = JSON.stringify({ type: 'stats', ...s });
  for (const ws of statsSubs) {
    if (ws.readyState === 1) ws.send(payload);
    else statsSubs.delete(ws);
  }
}, 10000);

// ─── PM2 log tailing via bus ──────────────────────────────────────────────
const logTailsStarted = new Set();
function startLogTail(appName) {
  if (logTailsStarted.has(appName)) return;
  logTailsStarted.add(appName);
  const pm2 = require('pm2');
  pm2.connect((err) => {
    if (err) return;
    pm2.launchBus((e, bus) => {
      if (e) return;
      bus.on('log:out', (packet) => {
        if (packet?.process?.name !== appName) return;
        const subs = logSubs.get(appName);
        if (!subs) return;
        const line = { type: 'log_line', appName, stream: 'out', line: packet.data, ts: Date.now() };
        for (const ws of subs) wsSend(ws, line);
      });
      bus.on('log:err', (packet) => {
        if (packet?.process?.name !== appName) return;
        const subs = logSubs.get(appName);
        if (!subs) return;
        const line = { type: 'log_line', appName, stream: 'err', line: packet.data, ts: Date.now() };
        for (const ws of subs) wsSend(ws, line);
      });
    });
  });
}

// Buffer claude output into the session history (last assistant reply)
const claudeBuffers = new Map(); // projectId -> string
setInterval(() => {
  // periodic flush of claude buffers into DB as assistant messages
  for (const [pid, buf] of claudeBuffers.entries()) {
    if (!buf) continue;
    try {
      let session = db.prepare('SELECT * FROM claude_sessions WHERE project_id=?').get(pid);
      if (!session) {
        const info = db.prepare('INSERT INTO claude_sessions(project_id) VALUES (?)').run(pid);
        session = db.prepare('SELECT * FROM claude_sessions WHERE id=?').get(info.lastInsertRowid);
      }
      const messages = JSON.parse(session.messages || '[]');
      // Append only if last message isn't the same assistant text
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant' || last.content !== buf) {
        messages.push({ role: 'assistant', content: buf, at: new Date().toISOString() });
        if (messages.length > 500) messages.splice(0, messages.length - 500);
        db.prepare('UPDATE claude_sessions SET messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(JSON.stringify(messages), session.id);
      }
    } catch {}
  }
  claudeBuffers.clear();
}, 3000);

// Hook into claude-code service to capture output
const origSpawn = claudeSvc.spawnSession;
claudeSvc.spawnSession = function (projectId, cwd) {
  const s = origSpawn.call(this, projectId, cwd);
  if (s) {
    s.listeners.add((payload) => {
      if (payload.type === 'claude_output') {
        const prev = claudeBuffers.get(projectId) || '';
        claudeBuffers.set(projectId, (prev + payload.data).slice(-50000));
      }
    });
  }
  return s;
};

// ─── START ────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log(`✅ ClawPanel API listening on http://${HOST}:${PORT}`);
  console.log(`   WebSocket on ws://${HOST}:${PORT}/ws`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
});
