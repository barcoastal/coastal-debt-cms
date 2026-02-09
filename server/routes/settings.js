const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { authenticateToken } = require('./auth');

// Encryption for SMTP password (same pattern as google-ads.js)
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';
const IV_LENGTH = 16;
function encryptValue(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = path.basename(file.originalname, ext).replace(/[^a-z0-9-_]/gi, '-');
    cb(null, `${name}-${Date.now()}${ext}`);
  }
});

const allowedTypes = ['.ico', '.png', '.jpg', '.jpeg', '.svg', '.webp'];

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .ico, .png, .jpg, .jpeg, .svg, .webp files are allowed'));
    }
  }
});

// Activity logging helper
function logActivity(userId, userName, action, entityType, entityId, details, ipAddress) {
  try {
    db.prepare(`
      INSERT INTO activity_logs (user_id, user_name, action, entity_type, entity_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId || null, userName || 'System', action, entityType || null, entityId || null, details || null, ipAddress || null);
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

// ============ SETTINGS CRUD ============

// Get all settings
router.get('/', authenticateToken, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// Save settings
router.post('/', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const allowedKeys = ['timezone', 'favicon_url', 'meta_image_url', 'site_name', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'];
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?');

  const saveMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (allowedKeys.includes(key)) {
        // Encrypt smtp_pass, skip if masked placeholder
        if (key === 'smtp_pass') {
          if (value && value !== '********') {
            const encrypted = encryptValue(value);
            upsert.run(key, encrypted, encrypted);
          }
          continue;
        }
        upsert.run(key, value || '', value || '');
      }
    }
  });

  saveMany(Object.entries(req.body));

  logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'settings', null, 'Updated platform settings', req.ip);

  res.json({ message: 'Settings saved' });
});

// ============ ACTIVITY LOGS ============

// Get paginated activity logs
router.get('/activity', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, user_id, from_date, to_date, entity_type } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM activity_logs WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) as total FROM activity_logs WHERE 1=1';
  const params = [];

  if (user_id) {
    query += ' AND user_id = ?';
    countQuery += ' AND user_id = ?';
    params.push(user_id);
  }

  if (from_date) {
    query += ' AND created_at >= ?';
    countQuery += ' AND created_at >= ?';
    params.push(from_date);
  }

  if (to_date) {
    query += ' AND created_at <= ?';
    countQuery += ' AND created_at <= ?';
    params.push(to_date);
  }

  if (entity_type) {
    query += ' AND entity_type = ?';
    countQuery += ' AND entity_type = ?';
    params.push(entity_type);
  }

  const total = db.prepare(countQuery).get(...params).total;

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const logs = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));

  res.json({
    logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// Get activity logs for a specific user
router.get('/activity/user/:id', authenticateToken, (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as total FROM activity_logs WHERE user_id = ?').get(req.params.id).total;
  const logs = db.prepare('SELECT * FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.params.id, parseInt(limit), parseInt(offset));

  res.json({
    logs,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// Export activity logs to CSV
router.get('/activity/export', authenticateToken, (req, res) => {
  const { user_id, from_date, to_date, entity_type } = req.query;

  let query = 'SELECT * FROM activity_logs WHERE 1=1';
  const params = [];

  if (user_id) { query += ' AND user_id = ?'; params.push(user_id); }
  if (from_date) { query += ' AND created_at >= ?'; params.push(from_date); }
  if (to_date) { query += ' AND created_at <= ?'; params.push(to_date); }
  if (entity_type) { query += ' AND entity_type = ?'; params.push(entity_type); }

  query += ' ORDER BY created_at DESC';
  const logs = db.prepare(query).all(...params);

  const headers = ['Date', 'User', 'Action', 'Entity Type', 'Entity ID', 'Details', 'IP Address'];
  const rows = logs.map(l => [
    l.created_at,
    l.user_name,
    l.action,
    l.entity_type,
    l.entity_id,
    l.details,
    l.ip_address
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.map(cell => `"${(cell || '').toString().replace(/"/g, '""')}"`).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=activity-logs-${Date.now()}.csv`);
  res.send(csv);
});

// ============ USER PERMISSIONS ============

const DEFAULT_PERMISSIONS = {
  admin: { pages: true, leads: true, forms: true, scripts: true, integrations: true, users: true, settings: true },
  editor: { pages: true, leads: true, forms: true, scripts: true, integrations: false, users: false, settings: false },
  viewer: { pages: false, leads: true, forms: false, scripts: false, integrations: false, users: false, settings: false }
};

// Get default permissions for each role
router.get('/permissions-defaults', authenticateToken, (req, res) => {
  res.json(DEFAULT_PERMISSIONS);
});

// Get user permissions
router.get('/permissions/:userId', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, role, permissions FROM users WHERE id = ?').get(req.params.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  let permissions;
  try {
    permissions = JSON.parse(user.permissions || '{}');
  } catch (e) {
    permissions = {};
  }

  // Merge with defaults: user overrides take precedence
  const defaults = DEFAULT_PERMISSIONS[user.role] || DEFAULT_PERMISSIONS.viewer;
  const effective = { ...defaults, ...permissions };

  res.json({ permissions: effective, overrides: permissions, defaults, role: user.role });
});

// Update user permissions (admin only)
router.put('/permissions/:userId', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ error: 'Permissions object required' });
  }

  const user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), req.params.userId);

  logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'user_permissions', parseInt(req.params.userId), `Updated permissions for ${user.name}`, req.ip);

  res.json({ message: 'Permissions updated' });
});

// ============ FILE UPLOAD ============

router.post('/upload', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 2MB)' : err.message });
      }
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const url = `/lp/uploads/${req.file.filename}`;
    res.json({ url, filename: req.file.filename });
  });
});

module.exports = router;
module.exports.logActivity = logActivity;
