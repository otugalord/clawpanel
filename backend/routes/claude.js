const express = require('express');
const { db } = require('../db/database');
const claudeSvc = require('../services/claude-code');

const router = express.Router();

// GET /api/claude/sessions — list all sessions with their project
router.get('/sessions', (req, res) => {
  const rows = db.prepare(`
    SELECT cs.*, a.name as project_name, a.folder as project_folder
    FROM claude_sessions cs
    JOIN apps a ON a.id = cs.project_id
    ORDER BY cs.updated_at DESC
  `).all();
  const live = claudeSvc.listSessions();
  const liveMap = new Map(live.map((l) => [l.projectId, l]));
  res.json({
    sessions: rows.map((r) => ({
      ...r,
      messages: JSON.parse(r.messages || '[]'),
      live: liveMap.get(r.project_id) || null,
    })),
    live,
  });
});

// GET /api/claude/session/:projectId — history for a project
router.get('/session/:projectId', (req, res) => {
  const pid = parseInt(req.params.projectId, 10);
  const project = db.prepare('SELECT * FROM apps WHERE id=?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  let session = db.prepare('SELECT * FROM claude_sessions WHERE project_id=?').get(pid);
  if (!session) {
    const info = db.prepare('INSERT INTO claude_sessions(project_id) VALUES (?)').run(pid);
    session = db.prepare('SELECT * FROM claude_sessions WHERE id=?').get(info.lastInsertRowid);
  }
  res.json({
    project,
    session: { ...session, messages: JSON.parse(session.messages || '[]') },
    live: claudeSvc.getSession(pid) ? { streaming: true } : null,
  });
});

// POST /api/claude/session/:projectId/message — persist a chat message (no AI call; WS handles streaming)
router.post('/session/:projectId/message', (req, res) => {
  const pid = parseInt(req.params.projectId, 10);
  const project = db.prepare('SELECT * FROM apps WHERE id=?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  let session = db.prepare('SELECT * FROM claude_sessions WHERE project_id=?').get(pid);
  if (!session) {
    const info = db.prepare('INSERT INTO claude_sessions(project_id) VALUES (?)').run(pid);
    session = db.prepare('SELECT * FROM claude_sessions WHERE id=?').get(info.lastInsertRowid);
  }
  const messages = JSON.parse(session.messages || '[]');
  const { role, content } = req.body || {};
  if (!role || !content) return res.status(400).json({ error: 'role e content obrigatórios' });
  messages.push({ role, content, at: new Date().toISOString() });
  if (messages.length > 500) messages.splice(0, messages.length - 500);
  db.prepare('UPDATE claude_sessions SET messages=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(JSON.stringify(messages), session.id);
  res.json({ ok: true });
});

// POST /api/claude/session/:projectId/clear
router.post('/session/:projectId/clear', (req, res) => {
  const pid = parseInt(req.params.projectId, 10);
  db.prepare('UPDATE claude_sessions SET messages=?, updated_at=CURRENT_TIMESTAMP WHERE project_id=?')
    .run('[]', pid);
  res.json({ ok: true });
});

// POST /api/claude/session/:projectId/restart — kill pty
router.post('/session/:projectId/restart', (req, res) => {
  const pid = parseInt(req.params.projectId, 10);
  claudeSvc.killSession(pid);
  res.json({ ok: true });
});

module.exports = router;
