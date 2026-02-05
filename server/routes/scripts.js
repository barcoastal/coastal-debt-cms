const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { generateLandingPage } = require('./pages');

const router = express.Router();

// Get all scripts
router.get('/', authenticateToken, (req, res) => {
  const scripts = db.prepare('SELECT * FROM scripts ORDER BY created_at DESC').all();

  scripts.forEach(script => {
    try {
      script.landing_page_ids = JSON.parse(script.landing_page_ids || '[]');
    } catch (e) {
      script.landing_page_ids = [];
    }
  });

  res.json(scripts);
});

// Get single script
router.get('/:id', authenticateToken, (req, res) => {
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);

  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }

  try {
    script.landing_page_ids = JSON.parse(script.landing_page_ids || '[]');
  } catch (e) {
    script.landing_page_ids = [];
  }

  res.json(script);
});

// Create script
router.post('/', authenticateToken, (req, res) => {
  const { name, type, code, position, landing_page_ids } = req.body;

  if (!name || !code) {
    return res.status(400).json({ error: 'Name and code required' });
  }

  const result = db.prepare(`
    INSERT INTO scripts (name, type, code, position, landing_page_ids)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    name,
    type || 'analytics',
    code,
    position || 'head',
    JSON.stringify(landing_page_ids || [])
  );

  // Regenerate affected landing pages
  regenerateAffectedPages(landing_page_ids || []);

  res.json({ id: result.lastInsertRowid, message: 'Script created' });
});

// Update script
router.put('/:id', authenticateToken, (req, res) => {
  const { name, type, code, position, landing_page_ids, is_active } = req.body;

  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);
  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }

  db.prepare(`
    UPDATE scripts SET
      name = ?, type = ?, code = ?, position = ?,
      landing_page_ids = ?, is_active = ?
    WHERE id = ?
  `).run(
    name || script.name,
    type || script.type,
    code || script.code,
    position || script.position,
    JSON.stringify(landing_page_ids || JSON.parse(script.landing_page_ids || '[]')),
    is_active !== undefined ? (is_active ? 1 : 0) : script.is_active,
    req.params.id
  );

  // Regenerate affected landing pages
  const oldPageIds = JSON.parse(script.landing_page_ids || '[]');
  const newPageIds = landing_page_ids || oldPageIds;
  const allAffectedIds = [...new Set([...oldPageIds, ...newPageIds])];

  regenerateAffectedPages(allAffectedIds);

  res.json({ message: 'Script updated' });
});

// Delete script
router.delete('/:id', authenticateToken, (req, res) => {
  const script = db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id);

  if (script) {
    const pageIds = JSON.parse(script.landing_page_ids || '[]');
    db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);

    // Regenerate affected landing pages
    regenerateAffectedPages(pageIds);
  }

  res.json({ message: 'Script deleted' });
});

// Helper to regenerate affected pages
function regenerateAffectedPages(pageIds) {
  if (!pageIds || pageIds.length === 0) {
    // Global script - regenerate all active pages
    const pages = db.prepare('SELECT id FROM landing_pages WHERE is_active = 1').all();
    pages.forEach(p => generateLandingPage(p.id));
  } else {
    // Regenerate specific pages
    pageIds.forEach(id => generateLandingPage(id));
  }
}

module.exports = router;
