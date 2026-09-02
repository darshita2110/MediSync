// src/controllers/auth.controller.js
// The signup and login logic.

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');   // your existing pool

const SALT_ROUNDS = 10;

// Build a signed token that identifies the user on future requests.
function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function signup(req, res) {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Never store the raw password — store a one-way hash.
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase(), passwordHash, name || null]
    );

    const user = result.rows[0];
    const token = signToken(user);

    return res.status(201).json({ user, token });
  } catch (err) {
    // 23505 = Postgres unique_violation — the email is already taken.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await db.query(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );

    const user = result.rows[0];

    // Same vague message whether email is unknown or password is wrong —
    // don't reveal which emails have accounts.
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken(user);
    delete user.password_hash;   // never send the hash back

    return res.json({ user, token });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = { signup, login };