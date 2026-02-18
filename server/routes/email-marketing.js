const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { createTransporter, getSmtpConfig } = require('../lib/smtp');

const router = express.Router();

// ============ TEMPLATE VARIABLES ============

const AVAILABLE_VARIABLES = [
  { name: 'first_name', description: 'First word of lead name' },
  { name: 'last_name', description: 'Rest of lead name' },
  { name: 'full_name', description: 'Full name' },
  { name: 'company_name', description: 'Company name' },
  { name: 'email', description: 'Email address' },
  { name: 'phone', description: 'Phone number' },
  { name: 'debt_amount', description: 'Debt amount' },
  { name: 'stage', description: 'Lead stage' },
  { name: 'platform', description: 'Ad platform' },
  { name: 'landing_page', description: 'Landing page name' },
  { name: 'created_date', description: 'Lead creation date' },
  { name: 'unsubscribe_url', description: 'Unsubscribe link (auto-generated)' },
  { name: 'current_year', description: 'Current year' }
];

function resolveVariables(text, lead, extras = {}) {
  if (!text) return text;
  const vars = {
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.full_name || '',
    company_name: lead.company_name || '',
    email: lead.email || '',
    phone: lead.phone || '',
    debt_amount: lead.debt_amount || '',
    stage: lead.stage || '',
    platform: extras.platform || lead.platform || '',
    landing_page: extras.landing_page || lead.landing_page_name || '',
    created_date: lead.created_at ? new Date(lead.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '',
    unsubscribe_url: extras.unsubscribe_url || '#',
    current_year: new Date().getFullYear().toString(),
    ...extras
  };

  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

// ============ SEGMENT QUERY BUILDER ============

function buildSegmentQuery(filterCriteria) {
  let criteria;
  try {
    criteria = typeof filterCriteria === 'string' ? JSON.parse(filterCriteria) : filterCriteria;
  } catch (e) {
    criteria = { logic: 'AND', filters: [] };
  }

  const logic = (criteria.logic || 'AND').toUpperCase();
  const filters = criteria.filters || [];
  const conditions = [];
  const params = [];

  // Always exclude unsubscribed and leads without email
  const baseWhere = "l.email IS NOT NULL AND l.email != '' AND COALESCE(l.email_unsubscribed, 0) = 0";

  for (const f of filters) {
    const { field, operator, value } = f;
    switch (field) {
      case 'current_stage': {
        if (operator === 'in' && Array.isArray(value)) {
          const placeholders = value.map(() => '?').join(',');
          conditions.push(`(SELECT ce.conversion_action_name FROM conversion_events ce WHERE ce.lead_id = l.id ORDER BY ce.created_at DESC LIMIT 1) IN (${placeholders})`);
          params.push(...value);
        } else if (operator === 'equals') {
          conditions.push(`(SELECT ce.conversion_action_name FROM conversion_events ce WHERE ce.lead_id = l.id ORDER BY ce.created_at DESC LIMIT 1) = ?`);
          params.push(value);
        }
        break;
      }
      case 'platform': {
        if (operator === 'equals') {
          conditions.push('lp.platform = ?');
          params.push(value);
        } else if (operator === 'in' && Array.isArray(value)) {
          conditions.push(`lp.platform IN (${value.map(() => '?').join(',')})`);
          params.push(...value);
        }
        break;
      }
      case 'landing_page_id': {
        if (operator === 'equals') {
          conditions.push('l.landing_page_id = ?');
          params.push(value);
        } else if (operator === 'in' && Array.isArray(value)) {
          conditions.push(`l.landing_page_id IN (${value.map(() => '?').join(',')})`);
          params.push(...value);
        }
        break;
      }
      case 'has_mca': {
        conditions.push('l.has_mca = ?');
        params.push(value);
        break;
      }
      case 'debt_amount': {
        if (operator === 'equals') {
          conditions.push('l.debt_amount = ?');
          params.push(value);
        }
        break;
      }
      case 'stage': {
        if (operator === 'equals') {
          conditions.push('l.stage = ?');
          params.push(value);
        } else if (operator === 'in' && Array.isArray(value)) {
          conditions.push(`l.stage IN (${value.map(() => '?').join(',')})`);
          params.push(...value);
        }
        break;
      }
      case 'transfer_status': {
        if (operator === 'equals') {
          conditions.push('l.transfer_status = ?');
          params.push(value);
        }
        break;
      }
      case 'created_at': {
        if (operator === 'between' && Array.isArray(value) && value.length === 2) {
          conditions.push('l.created_at >= ? AND l.created_at <= ?');
          params.push(value[0], value[1].length === 10 ? value[1] + ' 23:59:59' : value[1]);
        } else if (operator === 'after') {
          conditions.push('l.created_at >= ?');
          params.push(value);
        } else if (operator === 'before') {
          conditions.push('l.created_at <= ?');
          params.push(value);
        }
        break;
      }
      case 'assigned_to': {
        if (operator === 'equals') {
          conditions.push('l.assigned_to = ?');
          params.push(value);
        } else if (operator === 'is_null') {
          conditions.push('l.assigned_to IS NULL');
        }
        break;
      }
      case 'utm_campaign': {
        if (operator === 'equals') {
          conditions.push('v.utm_campaign = ?');
          params.push(value);
        } else if (operator === 'contains') {
          conditions.push('v.utm_campaign LIKE ?');
          params.push(`%${value}%`);
        }
        break;
      }
      case 'email': {
        if (operator === 'contains') {
          conditions.push('l.email LIKE ?');
          params.push(`%${value}%`);
        }
        break;
      }
      case 'has_email': {
        conditions.push("l.email IS NOT NULL AND l.email != ''");
        break;
      }
    }
  }

  const filterWhere = conditions.length > 0 ? conditions.join(` ${logic} `) : '1=1';

  return {
    where: `${baseWhere} AND (${filterWhere})`,
    params
  };
}

function getSegmentLeadQuery(filterCriteria) {
  const { where, params } = buildSegmentQuery(filterCriteria);
  return {
    sql: `
      SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.debt_amount,
             l.stage, l.created_at, lp.name as landing_page_name, lp.platform
      FROM leads l
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
      WHERE ${where}
      ORDER BY l.created_at DESC
    `,
    countSql: `
      SELECT COUNT(*) as total
      FROM leads l
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
      WHERE ${where}
    `,
    params
  };
}

// ============ TEMPLATES CRUD ============

router.get('/templates/variables', authenticateToken, (req, res) => {
  res.json(AVAILABLE_VARIABLES);
});

router.get('/templates', authenticateToken, (req, res) => {
  const templates = db.prepare('SELECT * FROM email_templates ORDER BY created_at DESC').all();
  res.json(templates);
});

router.get('/templates/:id', authenticateToken, (req, res) => {
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json(template);
});

router.post('/templates', authenticateToken, (req, res) => {
  const { name, subject, html_body, text_body } = req.body;
  if (!name || !subject || !html_body) {
    return res.status(400).json({ error: 'Name, subject, and html_body are required' });
  }

  const result = db.prepare(`
    INSERT INTO email_templates (name, subject, html_body, text_body, created_by_id, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, subject, html_body, text_body || null, req.user.id, req.user.name || req.user.email);

  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(result.lastInsertRowid);
  res.json(template);
});

router.put('/templates/:id', authenticateToken, (req, res) => {
  const { name, subject, html_body, text_body, is_active } = req.body;

  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const fields = [];
  const params = [];

  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (subject !== undefined) { fields.push('subject = ?'); params.push(subject); }
  if (html_body !== undefined) { fields.push('html_body = ?'); params.push(html_body); }
  if (text_body !== undefined) { fields.push('text_body = ?'); params.push(text_body); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  fields.push('updated_at = CURRENT_TIMESTAMP');

  params.push(req.params.id);
  db.prepare(`UPDATE email_templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/templates/:id', authenticateToken, (req, res) => {
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  // Check if template is used by any non-draft campaign
  const inUse = db.prepare(`SELECT id FROM email_campaigns WHERE template_id = ? AND status != 'draft' LIMIT 1`).get(req.params.id);
  if (inUse) {
    return res.status(400).json({ error: 'Template is in use by active campaigns' });
  }

  db.prepare('DELETE FROM email_templates WHERE id = ?').run(req.params.id);
  res.json({ message: 'Template deleted' });
});

// POST /templates/:id/preview — render with real lead data
router.post('/templates/:id/preview', authenticateToken, (req, res) => {
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { lead_id } = req.body;
  let lead;
  if (lead_id) {
    lead = db.prepare(`
      SELECT l.*, lp.name as landing_page_name, lp.platform
      FROM leads l LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      WHERE l.id = ?
    `).get(lead_id);
  }
  if (!lead) {
    // Use sample data
    lead = {
      first_name: 'John', last_name: 'Smith', full_name: 'John Smith', company_name: 'Acme Corp', email: 'john@acme.com',
      phone: '(555) 123-4567', debt_amount: '$150,000', stage: 'qualified',
      created_at: new Date().toISOString(), landing_page_name: 'Business Debt Relief', platform: 'google'
    };
  }

  const subject = resolveVariables(template.subject, lead);
  const html_body = resolveVariables(template.html_body, lead);

  res.json({ subject, html_body });
});

// POST /templates/:id/send-test — send test email
router.post('/templates/:id/send-test', authenticateToken, async (req, res) => {
  const template = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(req.params.id);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { to_email } = req.body;
  if (!to_email) return res.status(400).json({ error: 'to_email is required' });

  const transporter = createTransporter();
  if (!transporter) return res.status(400).json({ error: 'SMTP not configured' });

  const smtpConfig = getSmtpConfig();
  const fromName = db.prepare("SELECT value FROM settings WHERE key = 'email_from_name'").get();

  // Use sample data for test
  const lead = {
    first_name: 'Test', last_name: 'User', full_name: 'Test User', company_name: 'Test Company', email: to_email,
    phone: '(555) 000-0000', debt_amount: '$100,000', stage: 'lead',
    created_at: new Date().toISOString(), landing_page_name: 'Test Page', platform: 'google'
  };

  const subject = resolveVariables(template.subject, lead);
  const html_body = resolveVariables(template.html_body, lead);

  try {
    const from = fromName ? `${fromName.value} <${smtpConfig.smtp_from || smtpConfig.smtp_user}>` : (smtpConfig.smtp_from || smtpConfig.smtp_user);
    await transporter.sendMail({
      from,
      to: to_email,
      subject: '[TEST] ' + subject,
      html: html_body
    });
    res.json({ message: 'Test email sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
});

// ============ SEGMENTS CRUD ============

router.get('/segments', authenticateToken, (req, res) => {
  const segments = db.prepare('SELECT * FROM email_segments ORDER BY created_at DESC').all();

  // Add lead count for each segment
  segments.forEach(seg => {
    try {
      const { countSql, params } = getSegmentLeadQuery(seg.filter_criteria);
      const result = db.prepare(countSql).get(...params);
      seg.lead_count = result ? result.total : 0;
    } catch (e) {
      seg.lead_count = 0;
    }
  });

  res.json(segments);
});

router.get('/segments/:id', authenticateToken, (req, res) => {
  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  res.json(segment);
});

router.post('/segments', authenticateToken, (req, res) => {
  const { name, description, filter_criteria } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const criteria = typeof filter_criteria === 'object' ? JSON.stringify(filter_criteria) : (filter_criteria || '{}');

  const result = db.prepare(`
    INSERT INTO email_segments (name, description, filter_criteria, created_by_id, created_by_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, description || null, criteria, req.user.id, req.user.name || req.user.email);

  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(result.lastInsertRowid);
  res.json(segment);
});

router.put('/segments/:id', authenticateToken, (req, res) => {
  const { name, description, filter_criteria } = req.body;

  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  const fields = [];
  const params = [];

  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description || null); }
  if (filter_criteria !== undefined) {
    const criteria = typeof filter_criteria === 'object' ? JSON.stringify(filter_criteria) : filter_criteria;
    fields.push('filter_criteria = ?');
    params.push(criteria);
  }
  fields.push('updated_at = CURRENT_TIMESTAMP');

  params.push(req.params.id);
  db.prepare(`UPDATE email_segments SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/segments/:id', authenticateToken, (req, res) => {
  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  db.prepare('DELETE FROM email_segments WHERE id = ?').run(req.params.id);
  res.json({ message: 'Segment deleted' });
});

// GET /segments/:id/count — preview matching lead count
router.get('/segments/:id/count', authenticateToken, (req, res) => {
  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  const { countSql, params } = getSegmentLeadQuery(segment.filter_criteria);
  const result = db.prepare(countSql).get(...params);
  res.json({ count: result ? result.total : 0 });
});

// GET /segments/:id/leads — preview matching leads (paginated)
router.get('/segments/:id/leads', authenticateToken, (req, res) => {
  const segment = db.prepare('SELECT * FROM email_segments WHERE id = ?').get(req.params.id);
  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  const offset = (page - 1) * limit;

  const { sql, countSql, params } = getSegmentLeadQuery(segment.filter_criteria);
  const total = db.prepare(countSql).get(...params).total;
  const leads = db.prepare(sql + ' LIMIT ? OFFSET ?').all(...params, limit, offset);

  res.json({ leads, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// POST /segments/preview-count — preview count without saving
router.post('/segments/preview-count', authenticateToken, (req, res) => {
  const { filter_criteria } = req.body;
  const { countSql, params } = getSegmentLeadQuery(filter_criteria || {});
  const result = db.prepare(countSql).get(...params);
  res.json({ count: result ? result.total : 0 });
});

// ============ CAMPAIGNS CRUD ============

router.get('/campaigns', authenticateToken, (req, res) => {
  const campaigns = db.prepare(`
    SELECT c.*, t.name as template_name, s.name as segment_name
    FROM email_campaigns c
    LEFT JOIN email_templates t ON c.template_id = t.id
    LEFT JOIN email_segments s ON c.segment_id = s.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(campaigns);
});

router.get('/campaigns/:id', authenticateToken, (req, res) => {
  const campaign = db.prepare(`
    SELECT c.*, t.name as template_name, s.name as segment_name
    FROM email_campaigns c
    LEFT JOIN email_templates t ON c.template_id = t.id
    LEFT JOIN email_segments s ON c.segment_id = s.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  res.json(campaign);
});

router.post('/campaigns', authenticateToken, (req, res) => {
  const { name, template_id, segment_id, subject_override } = req.body;
  if (!name || !template_id) {
    return res.status(400).json({ error: 'Name and template_id are required' });
  }

  const template = db.prepare('SELECT id FROM email_templates WHERE id = ?').get(template_id);
  if (!template) return res.status(400).json({ error: 'Template not found' });

  const result = db.prepare(`
    INSERT INTO email_campaigns (name, template_id, segment_id, subject_override, created_by_id, created_by_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, template_id, segment_id || null, subject_override || null, req.user.id, req.user.name || req.user.email);

  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(result.lastInsertRowid);
  res.json(campaign);
});

router.put('/campaigns/:id', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft') {
    return res.status(400).json({ error: 'Can only edit draft campaigns' });
  }

  const { name, template_id, segment_id, subject_override } = req.body;
  const fields = [];
  const params = [];

  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (template_id !== undefined) { fields.push('template_id = ?'); params.push(template_id); }
  if (segment_id !== undefined) { fields.push('segment_id = ?'); params.push(segment_id || null); }
  if (subject_override !== undefined) { fields.push('subject_override = ?'); params.push(subject_override || null); }
  fields.push('updated_at = CURRENT_TIMESTAMP');

  params.push(req.params.id);
  db.prepare(`UPDATE email_campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  res.json(updated);
});

router.delete('/campaigns/:id', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft') {
    return res.status(400).json({ error: 'Can only delete draft campaigns' });
  }

  db.prepare('DELETE FROM email_queue WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM email_campaigns WHERE id = ?').run(req.params.id);
  res.json({ message: 'Campaign deleted' });
});

// POST /campaigns/:id/schedule
router.post('/campaigns/:id/schedule', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft') {
    return res.status(400).json({ error: 'Can only schedule draft campaigns' });
  }

  const { scheduled_at } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at is required' });

  db.prepare(`
    UPDATE email_campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(scheduled_at, req.params.id);

  res.json({ message: 'Campaign scheduled' });
});

// POST /campaigns/:id/send-now
router.post('/campaigns/:id/send-now', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    return res.status(400).json({ error: 'Campaign must be draft or scheduled to send' });
  }

  // The worker will pick this up and enqueue
  db.prepare(`
    UPDATE email_campaigns SET status = 'sending', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(req.params.id);

  res.json({ message: 'Campaign queued for sending' });
});

// POST /campaigns/:id/pause
router.post('/campaigns/:id/pause', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'sending') {
    return res.status(400).json({ error: 'Can only pause sending campaigns' });
  }

  db.prepare(`UPDATE email_campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ message: 'Campaign paused' });
});

// POST /campaigns/:id/resume
router.post('/campaigns/:id/resume', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'paused') {
    return res.status(400).json({ error: 'Can only resume paused campaigns' });
  }

  db.prepare(`UPDATE email_campaigns SET status = 'sending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  res.json({ message: 'Campaign resumed' });
});

// POST /campaigns/:id/cancel
router.post('/campaigns/:id/cancel', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['sending', 'paused', 'scheduled'].includes(campaign.status)) {
    return res.status(400).json({ error: 'Cannot cancel this campaign' });
  }

  db.prepare(`UPDATE email_campaigns SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
  // Cancel queued emails
  db.prepare(`UPDATE email_queue SET status = 'failed', error_message = 'Campaign cancelled' WHERE campaign_id = ? AND status = 'queued'`).run(req.params.id);
  res.json({ message: 'Campaign cancelled' });
});

// GET /campaigns/:id/stats
router.get('/campaigns/:id/stats', authenticateToken, (req, res) => {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const stats = {
    total_recipients: campaign.total_recipients,
    sent_count: campaign.sent_count,
    failed_count: campaign.failed_count,
    open_count: campaign.open_count,
    click_count: campaign.click_count,
    unsubscribe_count: campaign.unsubscribe_count,
    bounce_count: campaign.bounce_count,
    open_rate: campaign.sent_count > 0 ? ((campaign.open_count / campaign.sent_count) * 100).toFixed(1) : '0.0',
    click_rate: campaign.sent_count > 0 ? ((campaign.click_count / campaign.sent_count) * 100).toFixed(1) : '0.0',
    unsubscribe_rate: campaign.sent_count > 0 ? ((campaign.unsubscribe_count / campaign.sent_count) * 100).toFixed(1) : '0.0'
  };

  res.json(stats);
});

// GET /campaigns/:id/recipients — per-recipient status list
router.get('/campaigns/:id/recipients', authenticateToken, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as total FROM email_queue WHERE campaign_id = ?').get(req.params.id).total;
  const recipients = db.prepare(`
    SELECT eq.id, eq.to_email, eq.to_name, eq.status, eq.error_message,
           eq.sent_at, eq.opened_at, eq.clicked_at, eq.open_count, eq.click_count
    FROM email_queue eq
    WHERE eq.campaign_id = ?
    ORDER BY eq.id ASC
    LIMIT ? OFFSET ?
  `).all(req.params.id, limit, offset);

  res.json({ recipients, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

// Export for use in email-worker
module.exports = router;
module.exports.resolveVariables = resolveVariables;
module.exports.buildSegmentQuery = buildSegmentQuery;
module.exports.getSegmentLeadQuery = getSegmentLeadQuery;
