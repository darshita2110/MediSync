const jwt = require('jsonwebtoken');
const { uuid } = require('../utils/validation');

function requireAuth(req, res, next) {
  const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Missing or malformed token' });
  try {
    const payload = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
    uuid(payload.userId, 'token user');
    req.user = { id: payload.userId, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
