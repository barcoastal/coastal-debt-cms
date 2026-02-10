const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { generateLandingPage } = require('./pages');

const router = express.Router();

// Default form fields
const defaultFields = [
  { name: 'full_name', label: 'Full Name', type: 'text', required: true, placeholder: 'John Smith' },
  { name: 'company_name', label: 'Company Name', type: 'text', required: true, placeholder: 'Your Company' },
  { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'john@company.com' },
  { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: '(555) 123-4567' }
];

// Get all forms
router.get('/', authenticateToken, (req, res) => {
  const forms = db.prepare('SELECT * FROM forms ORDER BY created_at DESC').all();

  forms.forEach(form => {
    try {
      form.fields = JSON.parse(form.fields || '[]');
    } catch (e) {
      form.fields = [];
    }
  });

  res.json(forms);
});

// Get single form
router.get('/:id', authenticateToken, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(req.params.id);

  if (!form) {
    return res.status(404).json({ error: 'Form not found' });
  }

  try {
    form.fields = JSON.parse(form.fields || '[]');
  } catch (e) {
    form.fields = [];
  }

  res.json(form);
});

// Create form
router.post('/', authenticateToken, (req, res) => {
  const { name, platform, webhook_url, fields, submit_button_text, success_message } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Form name required' });
  }

  const result = db.prepare(`
    INSERT INTO forms (name, platform, webhook_url, fields, submit_button_text, success_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    platform || 'other',
    webhook_url || '',
    JSON.stringify(fields || defaultFields),
    submit_button_text || 'Get My Free Debt Analysis',
    success_message || 'Thank you! A debt specialist will call you within 15 minutes.'
  );

  res.json({ id: result.lastInsertRowid, message: 'Form created' });
});

// Update form
router.put('/:id', authenticateToken, (req, res) => {
  const { name, platform, webhook_url, fields, submit_button_text, success_message, is_active } = req.body;

  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(req.params.id);
  if (!form) {
    return res.status(404).json({ error: 'Form not found' });
  }

  db.prepare(`
    UPDATE forms SET
      name = ?, platform = ?, webhook_url = ?, fields = ?,
      submit_button_text = ?, success_message = ?, is_active = ?
    WHERE id = ?
  `).run(
    name || form.name,
    platform || form.platform,
    webhook_url !== undefined ? webhook_url : form.webhook_url,
    fields ? JSON.stringify(fields) : form.fields,
    submit_button_text || form.submit_button_text,
    success_message || form.success_message,
    is_active !== undefined ? (is_active ? 1 : 0) : form.is_active,
    req.params.id
  );

  // Regenerate all landing pages that use this form
  const pages = db.prepare('SELECT id FROM landing_pages WHERE form_id = ?').all(req.params.id);
  pages.forEach(p => generateLandingPage(p.id));

  res.json({ message: 'Form updated' });
});

// Duplicate form
router.post('/:id/duplicate', authenticateToken, (req, res) => {
  const form = db.prepare('SELECT * FROM forms WHERE id = ?').get(req.params.id);
  if (!form) {
    return res.status(404).json({ error: 'Form not found' });
  }

  const result = db.prepare(`
    INSERT INTO forms (name, platform, webhook_url, fields, submit_button_text, success_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    form.name + ' (Copy)',
    form.platform,
    form.webhook_url || '',
    form.fields,
    form.submit_button_text,
    form.success_message
  );

  res.json({ id: result.lastInsertRowid, message: 'Form duplicated' });
});

// Delete form
router.delete('/:id', authenticateToken, (req, res) => {
  // Check if form is used by any landing page
  const usedBy = db.prepare('SELECT COUNT(*) as count FROM landing_pages WHERE form_id = ?').get(req.params.id);

  if (usedBy.count > 0) {
    return res.status(400).json({ error: 'Form is used by landing pages. Remove it from pages first.' });
  }

  db.prepare('DELETE FROM forms WHERE id = ?').run(req.params.id);
  res.json({ message: 'Form deleted' });
});

module.exports = router;
