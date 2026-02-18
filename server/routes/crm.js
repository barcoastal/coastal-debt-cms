const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, getTodayInTz } = require('../lib/timezone');

const router = express.Router();

// ============ PIPELINE ============

// GET /pipeline/stages — ordered stage names from postback_config
router.get('/pipeline/stages', authenticateToken, (req, res) => {
  const stages = db.prepare(`
    SELECT DISTINCT event_name FROM postback_config WHERE is_active = 1 ORDER BY id ASC
  `).all().map(r => r.event_name);
  res.json(stages);
});

// GET /pipeline — leads grouped by latest conversion event stage
router.get('/pipeline', authenticateToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;

  // Get stage order from postback_config
  const stages = db.prepare(`
    SELECT DISTINCT event_name FROM postback_config WHERE is_active = 1 ORDER BY id ASC
  `).all().map(r => r.event_name);

  // Get leads with their latest conversion event name
  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.debt_amount,
           l.created_at, l.assigned_to, lp.name as landing_page_name, lp.platform,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_stage
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    ORDER BY l.created_at DESC
    LIMIT ?
  `).all(limit);

  // Group leads by stage
  const pipeline = {};
  stages.forEach(s => { pipeline[s] = []; });
  pipeline['_no_events'] = [];

  leads.forEach(lead => {
    const stage = lead.current_stage;
    if (!stage) {
      pipeline['_no_events'].push(lead);
    } else if (pipeline[stage]) {
      pipeline[stage].push(lead);
    } else {
      // Stage not in postback_config, create dynamic group
      if (!pipeline[stage]) pipeline[stage] = [];
      pipeline[stage].push(lead);
    }
  });

  res.json({ stages, pipeline });
});

// ============ NOTES ============

// GET /leads/:id/notes
router.get('/leads/:id/notes', authenticateToken, (req, res) => {
  const notes = db.prepare(`
    SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json(notes);
});

// POST /leads/:id/notes
router.post('/leads/:id/notes', authenticateToken, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const result = db.prepare(`
    INSERT INTO lead_notes (lead_id, user_id, user_name, content)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, req.user.id, req.user.name || req.user.email, content.trim());

  const note = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(result.lastInsertRowid);
  res.json(note);
});

// PUT /notes/:noteId
router.put('/notes/:noteId', authenticateToken, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const note = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(req.params.noteId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  // Only author or admin can edit
  if (note.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  db.prepare(`
    UPDATE lead_notes SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(content.trim(), req.params.noteId);

  res.json({ message: 'Note updated' });
});

// DELETE /notes/:noteId
router.delete('/notes/:noteId', authenticateToken, (req, res) => {
  const note = db.prepare('SELECT * FROM lead_notes WHERE id = ?').get(req.params.noteId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  if (note.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  db.prepare('DELETE FROM lead_notes WHERE id = ?').run(req.params.noteId);
  res.json({ message: 'Note deleted' });
});

// ============ TASKS ============

// GET /leads/:id/tasks
router.get('/leads/:id/tasks', authenticateToken, (req, res) => {
  const tasks = db.prepare(`
    SELECT * FROM lead_tasks WHERE lead_id = ? ORDER BY status ASC, due_date ASC, created_at DESC
  `).all(req.params.id);
  res.json(tasks);
});

// POST /leads/:id/tasks
router.post('/leads/:id/tasks', authenticateToken, (req, res) => {
  const { title, description, due_date, assignee_id } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  let assignee_name = null;
  if (assignee_id) {
    const user = db.prepare('SELECT name FROM users WHERE id = ?').get(assignee_id);
    assignee_name = user ? user.name : null;
  }

  const result = db.prepare(`
    INSERT INTO lead_tasks (lead_id, title, description, due_date, assignee_id, assignee_name, created_by_id, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id, title.trim(), description || null, due_date || null,
    assignee_id || null, assignee_name,
    req.user.id, req.user.name || req.user.email
  );

  const task = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(result.lastInsertRowid);
  res.json(task);
});

// PUT /tasks/:taskId
router.put('/tasks/:taskId', authenticateToken, (req, res) => {
  const { title, description, due_date, assignee_id, status } = req.body;

  const task = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const fields = [];
  const params = [];

  if (title !== undefined) { fields.push('title = ?'); params.push(title.trim()); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description || null); }
  if (due_date !== undefined) { fields.push('due_date = ?'); params.push(due_date || null); }
  if (assignee_id !== undefined) {
    fields.push('assignee_id = ?');
    params.push(assignee_id || null);
    let name = null;
    if (assignee_id) {
      const user = db.prepare('SELECT name FROM users WHERE id = ?').get(assignee_id);
      name = user ? user.name : null;
    }
    fields.push('assignee_name = ?');
    params.push(name);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    params.push(status);
    if (status === 'done') {
      fields.push('completed_at = CURRENT_TIMESTAMP');
    } else {
      fields.push('completed_at = NULL');
    }
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(req.params.taskId);
  db.prepare(`UPDATE lead_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(req.params.taskId);
  res.json(updated);
});

// DELETE /tasks/:taskId
router.delete('/tasks/:taskId', authenticateToken, (req, res) => {
  const task = db.prepare('SELECT * FROM lead_tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare('DELETE FROM lead_tasks WHERE id = ?').run(req.params.taskId);
  res.json({ message: 'Task deleted' });
});

// GET /tasks/my — tasks assigned to current user
router.get('/tasks/my', authenticateToken, (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, (l.first_name || ' ' || l.last_name) as lead_name, l.company_name as lead_company
    FROM lead_tasks t
    LEFT JOIN leads l ON t.lead_id = l.id
    WHERE t.assignee_id = ? AND t.status = 'open'
    ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
  `).all(req.user.id);
  res.json(tasks);
});

// GET /tasks/overdue — all overdue open tasks
router.get('/tasks/overdue', authenticateToken, (req, res) => {
  const today = getTodayInTz(getConfiguredTimezone());
  const tasks = db.prepare(`
    SELECT t.*, (l.first_name || ' ' || l.last_name) as lead_name, l.company_name as lead_company
    FROM lead_tasks t
    LEFT JOIN leads l ON t.lead_id = l.id
    WHERE t.status = 'open' AND t.due_date < ?
    ORDER BY t.due_date ASC
  `).all(today);
  res.json(tasks);
});

module.exports = router;
