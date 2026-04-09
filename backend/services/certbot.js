const { spawn } = require('child_process');
const { safeDomain } = require('./nginx');

function installSSL(domain, email, onData, { includeWww = true } = {}) {
  const d = safeDomain(domain);
  const mail = email || `admin@${d}`;
  const args = [
    '--nginx',
    '-d', d,
  ];
  if (includeWww) {
    args.push('-d', `www.${d}`);
  }
  args.push(
    '--non-interactive',
    '--agree-tos',
    '-m', mail,
    '--redirect',
  );
  onData?.(`Running: certbot ${args.join(' ')}\n`);
  const proc = spawn('certbot', args);
  proc.stdout.on('data', (c) => onData?.(c.toString()));
  proc.stderr.on('data', (c) => onData?.(c.toString()));
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code === 0));
  });
}

function removeSSL(domain, onData) {
  const d = safeDomain(domain);
  const proc = spawn('certbot', ['delete', '--cert-name', d, '--non-interactive']);
  proc.stdout.on('data', (c) => onData?.(c.toString()));
  proc.stderr.on('data', (c) => onData?.(c.toString()));
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code === 0));
  });
}

module.exports = { installSSL, removeSSL };
