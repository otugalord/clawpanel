/**
 * Simple version-based DB migration system.
 * Migrations run once in order. Current version tracked in settings table.
 */
const { db, getSetting, setSetting } = require('./database');

const MIGRATIONS = [
  {
    id: 1,
    name: 'add script column to apps',
    sql: `ALTER TABLE apps ADD COLUMN script TEXT DEFAULT ''`,
    check: () => {
      try { db.prepare('SELECT script FROM apps LIMIT 1').get(); return true; } catch { return false; }
    },
  },
  {
    id: 2,
    name: 'add notes column to apps',
    sql: `ALTER TABLE apps ADD COLUMN notes TEXT DEFAULT ''`,
    check: () => {
      try { db.prepare('SELECT notes FROM apps LIMIT 1').get(); return true; } catch { return false; }
    },
  },
  {
    id: 3,
    name: 'add indexes',
    sql: [
      `CREATE INDEX IF NOT EXISTS idx_apps_port ON apps(port)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,
    ],
  },
];

function runMigrations() {
  const current = parseInt(getSetting('db_version', '0'), 10);
  let ran = 0;
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    // Some migrations add columns that might already exist
    if (m.check && m.check()) {
      console.log(`[migrations] skip #${m.id} (${m.name}) — already applied`);
      setSetting('db_version', String(m.id));
      continue;
    }
    try {
      const sqls = Array.isArray(m.sql) ? m.sql : [m.sql];
      for (const s of sqls) db.exec(s);
      setSetting('db_version', String(m.id));
      console.log(`[migrations] ✓ #${m.id}: ${m.name}`);
      ran++;
    } catch (e) {
      // Column-already-exists errors are safe to ignore
      if (e.message && e.message.includes('duplicate column')) {
        console.log(`[migrations] skip #${m.id} (${m.name}) — column already exists`);
        setSetting('db_version', String(m.id));
      } else {
        console.error(`[migrations] ✗ #${m.id} (${m.name}):`, e.message);
      }
    }
  }
  if (ran > 0) console.log(`[migrations] ${ran} migration(s) applied`);
}

module.exports = { runMigrations };
