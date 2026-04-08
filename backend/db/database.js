const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.CLAWPANEL_DB || path.join(__dirname, '..', 'clawpanel.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Init schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Seed default settings
const defaults = {
  apps_dir: '/root/apps',
  theme: 'dark',
  version: '0.1.0',
};
const setStmt = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) setStmt.run(k, v);

// Ensure apps dir exists
try {
  const appsDir = db.prepare('SELECT value FROM settings WHERE key=?').get('apps_dir').value;
  if (!fs.existsSync(appsDir)) fs.mkdirSync(appsDir, { recursive: true });
} catch {}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
}

module.exports = { db, getSetting, setSetting };
