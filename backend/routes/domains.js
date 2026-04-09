const express = require('express');
const dns = require('dns').promises;
const { execSync } = require('child_process');
const { db } = require('../db/database');
const nginxsvc = require('../services/nginx');
const certbot = require('../services/certbot');

const router = express.Router();

function getServerIp() {
  try { return execSync("hostname -I", { encoding: 'utf8', timeout: 3000 }).split(' ')[0].trim(); }
  catch { return '127.0.0.1'; }
}

async function checkDns(domain) {
  const serverIp = getServerIp();
  try {
    const addrs = await dns.resolve4(domain);
    const match = addrs.includes(serverIp);
    return { ok: match, serverIp, resolved: addrs, match };
  } catch (e) {
    return { ok: false, serverIp, resolved: [], error: e.code || e.message };
  }
}

// GET /api/domains — includes live DNS check
router.get('/', async (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, a.name as app_name, a.port as app_port
    FROM domains d
    LEFT JOIN apps a ON a.id = d.linked_app_id
    ORDER BY d.domain
  `).all();
  // Parallel DNS checks
  const results = await Promise.all(rows.map(async (r) => {
    const dnsCheck = await checkDns(r.domain);
    return { ...r, dns_ok: dnsCheck.ok, dns_resolved: dnsCheck.resolved, server_ip: dnsCheck.serverIp };
  }));
  res.json({ domains: results });
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
  if (!app) return res.status(400).json({ error: 'Invalid app' });
  if (!app.port) return res.status(400).json({ error: 'App has no port defined' });
  try {
    nginxsvc.writeConfig(row.domain, app.port);
    const test = nginxsvc.testConfig();
    if (!test.ok) {
      nginxsvc.removeConfig(row.domain);
      return res.status(500).json({ error: 'nginx test failed: ' + test.error });
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

// GET /api/domains/:id/dns — check DNS for a specific domain
router.get('/:id/dns', async (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(await checkDns(row.domain));
});

// POST /api/domains/:id/ssl — installs SSL with DNS pre-flight check
router.post('/:id/ssl', async (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // DNS pre-flight: check root domain AND www separately
  const [rootDns, wwwDns] = await Promise.all([
    checkDns(row.domain),
    checkDns('www.' + row.domain),
  ]);

  if (!rootDns.ok) {
    return res.status(400).json({
      ok: false,
      error: `DNS not pointing to this server. ${row.domain} resolves to [${rootDns.resolved.join(', ') || 'nothing'}] but this server is ${rootDns.serverIp}. Update your A record at your registrar and wait for propagation (up to 48h).`,
    });
  }

  const includeWww = wwwDns.ok;
  const { email } = req.body || {};
  const logs = [];
  const logCb = (chunk) => {
    logs.push(chunk);
    const broadcast = req.app.get('wsBroadcast');
    if (broadcast) broadcast({ type: 'ssl_log', domain: row.domain, data: chunk });
  };

  if (!includeWww) {
    logCb(`Note: www.${row.domain} does not point to this server — requesting SSL for ${row.domain} only.\n`);
  }

  const ok = await certbot.installSSL(row.domain, email, logCb, { includeWww });
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
