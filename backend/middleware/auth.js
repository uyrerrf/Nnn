'use strict';
const jwt = require('jsonwebtoken');

// FIX: removed socketAuthMiddleware — it referenced socket.handshake which is
// Socket.IO API. This project uses raw `ws` and handles auth inline in
// server.js panelWss.on('connection'). Dead code deleted.

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'No token' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { authMiddleware };
