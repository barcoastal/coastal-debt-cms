const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'coastal-debt-secret-key-change-in-production';

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied' });
  }

  try {
    const verified = jwt.verify(token, JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const validPassword = bcrypt.compareSync(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: !!process.env.RAILWAY_VOLUME_MOUNT_PATH,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  if (logActivity) logActivity(user.id, user.name, 'login', 'user', user.id, 'Login successful', req.ip);

  res.json({
    message: 'Login successful',
    user: { id: user.id, email: user.email, name: user.name, role: user.role }
  });
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// Get current user
router.get('/me', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

// Get all users (admin only)
router.get('/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const users = db.prepare('SELECT id, email, name, role, created_at FROM users').all();
  res.json(users);
});

// Create user (admin only)
router.post('/users', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name required' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    const result = db.prepare(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, ?, ?)
    `).run(email, passwordHash, name, role || 'editor');

    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'user', result.lastInsertRowid, `Created user: ${name}`, req.ip);
    res.json({ id: result.lastInsertRowid, message: 'User created' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user (admin only)
router.put('/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { email, password, name, role } = req.body;
  const userId = req.params.id;

  let query = 'UPDATE users SET email = ?, name = ?, role = ?';
  let params = [email, name, role];

  if (password) {
    query += ', password_hash = ?';
    params.push(bcrypt.hashSync(password, 10));
  }

  query += ' WHERE id = ?';
  params.push(userId);

  db.prepare(query).run(...params);
  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'user', parseInt(userId), `Updated user: ${name}`, req.ip);
  res.json({ message: 'User updated' });
});

// Delete user (admin only)
router.delete('/users/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  // Prevent deleting yourself
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  const delUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'user', parseInt(req.params.id), `Deleted user: ${delUser?.name || req.params.id}`, req.ip);
  res.json({ message: 'User deleted' });
});

module.exports = router;
module.exports.authenticateToken = authenticateToken;
