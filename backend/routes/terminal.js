const express = require('express');
const { terminalManager } = require('../services/terminal-manager');

const router = express.Router();

router.get('/sessions', (req, res) => {
  res.json({ sessions: terminalManager.list() });
});

router.post('/sessions', (req, res) => {
  const { cwd } = req.body || {};
  const session = terminalManager.create(cwd || process.env.HOME || '/root');
  res.json({ session });
});

router.delete('/sessions/:id', (req, res) => {
  terminalManager.kill(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
