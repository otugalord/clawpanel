/**
 * Simple structured logger for ClawPanel.
 * Writes to console (PM2 captures it) with ISO timestamps and level tags.
 * Optionally appends to a log file with daily rotation (keep 7 days).
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.CLAWPANEL_LOG_DIR || path.join(__dirname, '..', 'logs');
const MAX_AGE_DAYS = 7;

// Ensure log dir exists
try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function logFile() {
  return path.join(LOG_DIR, `clawpanel-${todayStr()}.log`);
}

function format(level, msg, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

function write(level, msg, meta) {
  const line = format(level, msg, meta);
  // Console (PM2 will capture)
  if (level === 'error') console.error(line);
  else console.log(line);
  // File
  try { fs.appendFileSync(logFile(), line + '\n'); } catch {}
}

// Cleanup old logs on startup
try {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!f.startsWith('clawpanel-') || !f.endsWith('.log')) continue;
    const fp = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch {}
  }
} catch {}

const logger = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => { if (process.env.DEBUG) write('debug', msg, meta); },
};

module.exports = logger;
