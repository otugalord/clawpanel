const express = require('express');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execSync } = require('child_process');
const { db, getSetting } = require('../db/database');
const pm2svc = require('../services/pm2');

const router = express.Router();

function openPort(port) {
  if (!port) return;
  try {
    execSync(`ufw allow ${port}/tcp 2>/dev/null`, { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start = 3001, end = 9999) {
  for (let p = start; p <= end; p++) {
    const used = db.prepare('SELECT 1 FROM apps WHERE port=?').get(p);
    if (used) continue;
    if (!(await portInUse(p))) return p;
  }
  throw new Error('No free port');
}

// GET /api/apps — list apps merged with live PM2 state
router.get('/', async (req, res) => {
  try {
    const apps = db.prepare('SELECT * FROM apps ORDER BY name').all();
    let procs = [];
    try { procs = await pm2svc.list(); } catch {}
    const procMap = new Map(procs.map((p) => [p.name, p]));
    const out = apps.map((a) => {
      const p = procMap.get(a.name);
      return {
        ...a,
        env_vars: JSON.parse(a.env_vars || '{}'),
        live: p
          ? {
              status: p.pm2_env?.status,
              cpu: p.monit?.cpu,
              memory: p.monit?.memory,
              uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
              restarts: p.pm2_env?.restart_time,
              pid: p.pid,
            }
          : null,
      };
    });
    res.json({ apps: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/apps — create app (folder + DB row)
router.post('/', async (req, res) => {
  try {
    const { name, port: portRaw, script } = req.body || {};
    const slug = slugify(name);
    if (!slug) return res.status(400).json({ error: 'Nome inválido' });
    if (db.prepare('SELECT 1 FROM apps WHERE name=?').get(slug)) return res.status(409).json({ error: 'Nome já existe' });
    const appsDir = getSetting('apps_dir', '/root/apps');
    const folder = path.join(appsDir, slug);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const port = portRaw ? parseInt(portRaw, 10) : await findFreePort();
    const info = db
      .prepare('INSERT INTO apps(name,folder,port,status,script) VALUES (?,?,?,?,?)')
      .run(slug, folder, port, 'stopped', script || '');
    const app = db.prepare('SELECT * FROM apps WHERE id=?').get(info.lastInsertRowid);
    openPort(port);
    res.json({ app });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/apps/free-port
router.get('/free-port', async (req, res) => {
  try { res.json({ port: await findFreePort() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/apps/:id
router.get('/:id', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  app.env_vars = JSON.parse(app.env_vars || '{}');
  try {
    const procs = await pm2svc.describe(app.name);
    app.live = procs[0] || null;
  } catch { app.live = null; }
  res.json({ app });
});

// PUT /api/apps/:id
router.put('/:id', (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  const fields = [];
  const values = [];
  for (const k of ['port', 'domain', 'script']) {
    if (body[k] !== undefined) { fields.push(`${k}=?`); values.push(body[k]); }
  }
  if (body.env_vars !== undefined) { fields.push('env_vars=?'); values.push(JSON.stringify(body.env_vars || {})); }
  if (fields.length) {
    values.push(req.params.id);
    db.prepare(`UPDATE apps SET ${fields.join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values);
  }
  const updated = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  updated.env_vars = JSON.parse(updated.env_vars || '{}');
  res.json({ app: updated });
});

// DELETE /api/apps/:id
router.delete('/:id', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  try { await pm2svc.del(app.name); } catch {}
  db.prepare('DELETE FROM apps WHERE id=?').run(app.id);
  res.json({ ok: true });
});

// POST /api/apps/:id/start
router.post('/:id/start', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  const env = JSON.parse(app.env_vars || '{}');
  if (app.port) env.PORT = String(app.port);
  try {
    // Detect script: prefer explicit script; else package.json start; else index.js
    let script = app.script || '';
    if (!script) {
      const pkgPath = path.join(app.folder, 'package.json');
      if (fs.existsSync(pkgPath)) {
        script = 'npm';
      } else if (fs.existsSync(path.join(app.folder, 'index.js'))) {
        script = 'index.js';
      } else {
        return res.status(400).json({ error: 'Nada para iniciar. Define script ou cria index.js / package.json' });
      }
    }
    const opts = {
      name: app.name,
      cwd: app.folder,
      env,
      autorestart: true,
      max_restarts: 10,
    };
    if (script === 'npm') { opts.script = 'npm'; opts.args = 'start'; }
    else { opts.script = path.isAbsolute(script) ? script : path.join(app.folder, script); }
    await pm2svc.start(opts);
    openPort(app.port);
    db.prepare('UPDATE apps SET status=? WHERE id=?').run('online', app.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/stop', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  try { await pm2svc.stop(app.name); db.prepare('UPDATE apps SET status=? WHERE id=?').run('stopped', app.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/restart', async (req, res) => {
  const app = db.prepare('SELECT * FROM apps WHERE id=?').get(req.params.id);
  if (!app) return res.status(404).json({ error: 'Not found' });
  try { await pm2svc.restart(app.name); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
