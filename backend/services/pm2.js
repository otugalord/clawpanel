const pm2 = require('pm2');

function connect() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => (err ? reject(err) : resolve()));
  });
}

function disconnect() {
  pm2.disconnect();
}

function list() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      pm2.list((e, procs) => {
        pm2.disconnect();
        if (e) return reject(e);
        resolve(procs || []);
      });
    });
  });
}

function describe(name) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      pm2.describe(name, (e, procs) => {
        pm2.disconnect();
        if (e) return reject(e);
        resolve(procs || []);
      });
    });
  });
}

function action(cmd, name) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      pm2[cmd](name, (e, p) => {
        pm2.disconnect();
        if (e) return reject(e);
        resolve(p);
      });
    });
  });
}

function start(opts) {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) return reject(err);
      pm2.start(opts, (e, proc) => {
        pm2.disconnect();
        if (e) return reject(e);
        resolve(proc);
      });
    });
  });
}

function del(name) { return action('delete', name); }
function restart(name) { return action('restart', name); }
function stop(name) { return action('stop', name); }

module.exports = { list, describe, start, del, restart, stop, connect, disconnect };
