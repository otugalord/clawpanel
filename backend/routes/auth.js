const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/database');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'clawpanel-dev-secret-change-me';
const JWT_EXPIRES = '7d';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function hasUsers() {
  return db.prepare('SELECT COUNT(*) as c FROM users').get().c > 0;
}

// GET /api/auth/status — tells frontend if setup is needed
router.get('/status', (req, res) => {
  res.json({ setup: !hasUsers() });
});

// POST /api/auth/setup — first-time admin creation
router.post('/setup', loginLimiter, async (req, res) => {
  if (hasUsers()) return res.status(409).json({ error: 'Setup already complete' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 6) {
    return res.status(400).json({ error: 'Username e password (>=6 chars) obrigatórios' });
  }
  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users(username,password_hash) VALUES (?,?)').run(username.trim(), hash);
  const user = { id: info.lastInsertRowid, username: username.trim() };
  res.json({ token: sign(user), user });
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Credenciais em falta' });
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username.trim());
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
  res.json({ token: sign(user), user: { id: user.id, username: user.username } });
});

// Auth middleware
function authMiddleware(req, res, next) {
  // API key fallback
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const row = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(keyHash);
    if (row) {
      db.prepare('UPDATE api_keys SET last_used=CURRENT_TIMESTAMP WHERE id=?').run(row.id);
      req.user = { id: row.user_id, username: 'api' };
      return next();
    }
  }
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function verifyJwtToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// GET /api/auth/me
router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password
router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password muito curta' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const ok = await bcrypt.compare(oldPassword || '', user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Password antiga incorrecta' });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
  res.json({ ok: true });
});

// ─── API KEYS ─────────────────────────────────────
router.get('/api-keys', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id,name,created_at,last_used FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  res.json({ keys: rows });
});

router.post('/api-keys', authMiddleware, (req, res) => {
  const name = (req.body?.name || 'unnamed').slice(0, 50);
  const raw = 'cp_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  db.prepare('INSERT INTO api_keys(user_id,key_hash,name) VALUES (?,?,?)').run(req.user.id, keyHash, name);
  res.json({ key: raw, name });
});

router.delete('/api-keys/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = { router, authMiddleware, verifyJwtToken, JWT_SECRET };
