const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const v = require('../utils/validation');
const { HttpError } = require('../utils/errors');

function signToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' });
}

async function signup(req, res) {
  const email = v.email(req.body.email);
  const password = v.password(req.body.password, { signup: true });
  const name = v.text(req.body.name, 'name', { max: 200 });
  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  try {
    const result = await db.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`, [email, passwordHash, name]);
    user = result.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }
  return res.status(201).json({ user, token: signToken(user) });
}

async function login(req, res) {
  const email = v.email(req.body.email);
  const password = v.password(req.body.password);
  const result = await db.query(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    throw new HttpError(401, 'Invalid email or password');
  }
  delete user.password_hash;
  return res.json({ user, token: signToken(user) });
}

module.exports = { signup, login };
