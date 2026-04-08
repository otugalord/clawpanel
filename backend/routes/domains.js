const express = require('express');
const { db } = require('../db/database');
const nginxsvc = require('../services/nginx');
const certbot = require('../services/certbot');

const router = express.Router();

// GET /api/domains
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, a.name as app_name, a.port as app_port
    FROM domains d
    LEFT JOIN apps a ON a.id = d.linked_app_id
    ORDER BY d.domain
  `).all();
  res.json({ domains: rows });
});

// POST /api/domains
router.post('/', (req, res) => {
  const { domain } = req.body || {};
  try {
    const d = nginxsvc.safeDomain(domain);
    db.prepare('INSERT INTO domains(domain) VALUES (?)').run(d);
    const row = db.prepare('SELECT * FROM domains WHERE domain=?').get(d);
    res.json({ domain: row });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/domains/:id/link — link to app and write nginx config
router.post('/:id/link', (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { app_id } = req.body || {};
  const app = app_id ? db.prepare('SELECT * FROM apps WHERE id=?').get(app_id) : null;
  if (!app) return res.status(400).json({ error: 'App inválida' });
  if (!app.port) return res.status(400).json({ error: 'App não tem porta definida' });
  try {
    nginxsvc.writeConfig(row.domain, app.port);
    const test = nginxsvc.testConfig();
    if (!test.ok) {
      nginxsvc.removeConfig(row.domain);
      return res.status(500).json({ error: 'nginx test falhou: ' + test.error });
    }
    nginxsvc.reload();
    db.prepare('UPDATE domains SET linked_app_id=? WHERE id=?').run(app.id, row.id);
    db.prepare('UPDATE apps SET domain=? WHERE id=?').run(row.domain, app.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/domains/:id/unlink
router.post('/:id/unlink', (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    nginxsvc.removeConfig(row.domain);
    nginxsvc.reload();
  } catch {}
  if (row.linked_app_id) db.prepare('UPDATE apps SET domain=NULL WHERE id=?').run(row.linked_app_id);
  db.prepare('UPDATE domains SET linked_app_id=NULL, ssl_enabled=0 WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// DELETE /api/domains/:id
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try { nginxsvc.removeConfig(row.domain); nginxsvc.reload(); } catch {}
  db.prepare('DELETE FROM domains WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// POST /api/domains/:id/ssl — installs SSL (streams log via WS broadcast)
router.post('/:id/ssl', async (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { email } = req.body || {};
  const logs = [];
  const ok = await certbot.installSSL(row.domain, email, (chunk) => {
    logs.push(chunk);
    const broadcast = req.app.get('wsBroadcast');
    if (broadcast) broadcast({ type: 'ssl_log', domain: row.domain, data: chunk });
  });
  if (ok) db.prepare('UPDATE domains SET ssl_enabled=1 WHERE id=?').run(row.id);
  res.json({ ok, log: logs.join('') });
});

// POST /api/domains/:id/ssl/remove
router.post('/:id/ssl/remove', async (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const logs = [];
  const ok = await certbot.removeSSL(row.domain, (c) => logs.push(c));
  if (ok) db.prepare('UPDATE domains SET ssl_enabled=0 WHERE id=?').run(row.id);
  res.json({ ok, log: logs.join('') });
});

module.exports = router;
