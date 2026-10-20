'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

const router = express.Router();

// POST /api/auth/login
// Body: { username, password }
//
// FIX: was reading ADMIN_PASSWORD (plaintext) but .env.example ships
// ADMIN_PASSWORD_HASH (bcrypt). Now uses bcrypt.compare against the hash.
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const adminUser = process.env.ADMIN_USERNAME;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminUser || !adminHash) {
      console.error('[AUTH] ADMIN_USERNAME / ADMIN_PASSWORD_HASH not set in env');
      return res.status(500).json({ error: 'Server auth not configured' });
    }

    if (username !== adminUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, adminHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { username, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, expiresIn: 86400 });
  } catch (err) {
    console.error('[AUTH]', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now - 86400) {
      return res.status(401).json({ error: 'Token too old to refresh' });
    }
    const newToken = jwt.sign(
      { username: payload.username, role: payload.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token: newToken, expiresIn: 86400 });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
