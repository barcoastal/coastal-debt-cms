const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { encrypt, decrypt, getSmtpConfig, createTransporter } = require('../lib/smtp');

const router = express.Router();

// ============ SMTP CONFIG ============

// GET /smtp - get SMTP config (mask password)
router.get('/smtp', authenticateToken, (req, res) => {
  const config = getSmtpConfig();
  res.json({
    smtp_host: config.smtp_host || '',
    smtp_port: config.smtp_port || '587',
    smtp_user: config.smtp_user || '',
    smtp_pass: config.smtp_pass ? '********' : '',
    smtp_from: config.smtp_from || ''
  });
});

// POST /smtp - save SMTP config
router.post('/smtp', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from } = req.body;
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?');

  const save = db.transaction(() => {
    if (smtp_host !== undefined) upsert.run('smtp_host', smtp_host, smtp_host);
    if (smtp_port !== undefined) upsert.run('smtp_port', smtp_port, smtp_port);
    if (smtp_user !== undefined) upsert.run('smtp_user', smtp_user, smtp_user);
    if (smtp_from !== undefined) upsert.run('smtp_from', smtp_from, smtp_from);
    // Only update password if it's not the masked placeholder
    if (smtp_pass && smtp_pass !== '********') {
      const encrypted = encrypt(smtp_pass);
      upsert.run('smtp_pass', encrypted, encrypted);
    }
  });

  save();
  res.json({ message: 'SMTP settings saved' });
});

// POST /smtp/test - send test email
router.post('/smtp/test', authenticateToken, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });

  const transporter = createTransporter();
  if (!transporter) {
    return res.status(400).json({ error: 'SMTP not configured' });
  }

  const config = getSmtpConfig();

  try {
    await transporter.sendMail({
      from: config.smtp_from || config.smtp_user,
      to,
      subject: 'Coastal Debt CMS - Test Email',
      html: '<h2>Test Email</h2><p>Your SMTP configuration is working correctly.</p><p>Sent from Coastal Debt CMS</p>'
    });
    res.json({ message: 'Test email sent successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
});

// ============ LEAD NOTIFICATION CONFIG ============

// GET /lead-config
router.get('/lead-config', authenticateToken, (req, res) => {
  const config = db.prepare("SELECT * FROM notification_config WHERE type = 'new_lead'").get();
  res.json(config || { type: 'new_lead', enabled: 0, email_recipients: '' });
});

// POST /lead-config
router.post('/lead-config', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { enabled, email_recipients } = req.body;
  const existing = db.prepare("SELECT id FROM notification_config WHERE type = 'new_lead'").get();

  if (existing) {
    db.prepare("UPDATE notification_config SET enabled = ?, email_recipients = ? WHERE type = 'new_lead'")
      .run(enabled ? 1 : 0, email_recipients || '');
  } else {
    db.prepare("INSERT INTO notification_config (type, enabled, email_recipients) VALUES ('new_lead', ?, ?)")
      .run(enabled ? 1 : 0, email_recipients || '');
  }

  res.json({ message: 'Lead notification config saved' });
});

// ============ ALERT RULES CRUD ============

// GET /alert-rules
router.get('/alert-rules', authenticateToken, (req, res) => {
  const rules = db.prepare('SELECT * FROM alert_rules ORDER BY created_at DESC').all();
  res.json(rules);
});

// POST /alert-rules
router.post('/alert-rules', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { name, metric, condition, threshold, time_window_hours, secondary_metric, secondary_condition, secondary_threshold, email_recipients } = req.body;

  if (!name || !metric || !condition || threshold === undefined || !time_window_hours) {
    return res.status(400).json({ error: 'Name, metric, condition, threshold, and time_window_hours are required' });
  }

  const result = db.prepare(`
    INSERT INTO alert_rules (name, metric, condition, threshold, time_window_hours, secondary_metric, secondary_condition, secondary_threshold, email_recipients)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, metric, condition, threshold, time_window_hours, secondary_metric || null, secondary_condition || null, secondary_threshold !== undefined ? secondary_threshold : null, email_recipients || '');

  res.json({ message: 'Alert rule created', id: result.lastInsertRowid });
});

// PUT /alert-rules/:id
router.put('/alert-rules/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { name, enabled, metric, condition, threshold, time_window_hours, secondary_metric, secondary_condition, secondary_threshold, email_recipients } = req.body;

  db.prepare(`
    UPDATE alert_rules SET name = ?, enabled = ?, metric = ?, condition = ?, threshold = ?, time_window_hours = ?,
    secondary_metric = ?, secondary_condition = ?, secondary_threshold = ?, email_recipients = ?
    WHERE id = ?
  `).run(name, enabled ? 1 : 0, metric, condition, threshold, time_window_hours, secondary_metric || null, secondary_condition || null, secondary_threshold !== undefined ? secondary_threshold : null, email_recipients || '', req.params.id);

  res.json({ message: 'Alert rule updated' });
});

// DELETE /alert-rules/:id
router.delete('/alert-rules/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(req.params.id);
  res.json({ message: 'Alert rule deleted' });
});

// ============ EXPORTED HELPERS ============

/**
 * Send email notification when a new lead arrives
 */
async function sendLeadNotification(lead, landingPage) {
  try {
    const config = db.prepare("SELECT * FROM notification_config WHERE type = 'new_lead' AND enabled = 1").get();
    if (!config || !config.email_recipients) return;

    const transporter = createTransporter();
    if (!transporter) return;

    const smtpConfig = getSmtpConfig();
    const recipients = config.email_recipients.split(',').map(e => e.trim()).filter(Boolean);
    if (recipients.length === 0) return;

    const pageName = typeof landingPage === 'object' ? (landingPage.name || landingPage.slug || 'Unknown') : (landingPage || 'Unknown');

    await transporter.sendMail({
      from: smtpConfig.smtp_from || smtpConfig.smtp_user,
      to: recipients.join(', '),
      subject: `New Lead: ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || 'Unknown'}`,
      html: `
        <h2>New Lead Received</h2>
        <table style="border-collapse:collapse;width:100%;max-width:500px;">
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Name</td><td style="padding:8px;border:1px solid #ddd;">${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Company</td><td style="padding:8px;border:1px solid #ddd;">${lead.company_name || '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Email</td><td style="padding:8px;border:1px solid #ddd;">${lead.email || '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Phone</td><td style="padding:8px;border:1px solid #ddd;">${lead.phone || '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Landing Page</td><td style="padding:8px;border:1px solid #ddd;">${pageName}</td></tr>
        </table>
        <p style="color:#666;font-size:12px;margin-top:16px;">Sent from Coastal Debt CMS</p>
      `
    });

    console.log('Lead notification email sent to:', recipients.join(', '));
  } catch (err) {
    console.error('Failed to send lead notification:', err.message);
  }
}

/**
 * Evaluate all enabled alert rules against DB metrics
 */
async function evaluateAlertRules() {
  try {
    const rules = db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all();
    if (rules.length === 0) return;

    console.log(`Alert evaluation: checking ${rules.length} rule(s)...`);

    for (const rule of rules) {
      try {
        // 1-hour cooldown
        if (rule.last_triggered_at) {
          const lastTriggered = new Date(rule.last_triggered_at).getTime();
          if (Date.now() - lastTriggered < 60 * 60 * 1000) continue;
        }

        const windowStart = new Date(Date.now() - rule.time_window_hours * 60 * 60 * 1000).toISOString();

        // Get primary metric value
        const primaryValue = getMetricValue(rule.metric, windowStart);

        // Check primary condition
        if (!checkCondition(primaryValue, rule.condition, rule.threshold)) continue;

        // Check secondary condition if present
        if (rule.secondary_metric && rule.secondary_condition !== null && rule.secondary_threshold !== null) {
          const secondaryValue = getMetricValue(rule.secondary_metric, windowStart);
          if (!checkCondition(secondaryValue, rule.secondary_condition, rule.secondary_threshold)) continue;
        }

        // Rule triggered - send email
        console.log(`Alert triggered: "${rule.name}" (${rule.metric} = ${primaryValue})`);

        if (rule.notify_email) {
          await sendAlertEmail(rule, primaryValue);
        }

        db.prepare('UPDATE alert_rules SET last_triggered_at = CURRENT_TIMESTAMP WHERE id = ?').run(rule.id);
      } catch (err) {
        console.error(`Error evaluating rule "${rule.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error('Alert evaluation error:', err.message);
  }
}

function getMetricValue(metric, windowStart) {
  switch (metric) {
    case 'spend': {
      const row = db.prepare('SELECT COALESCE(SUM(cost_cents), 0) as val FROM leads WHERE created_at >= ?').get(windowStart);
      return (row.val || 0) / 100; // Return in dollars
    }
    case 'leads': {
      const row = db.prepare('SELECT COUNT(*) as val FROM leads WHERE created_at >= ?').get(windowStart);
      return row.val || 0;
    }
    case 'visitors': {
      const row = db.prepare('SELECT COUNT(*) as val FROM visitors WHERE first_visit >= ?').get(windowStart);
      return row.val || 0;
    }
    case 'clicks': {
      const row = db.prepare("SELECT COUNT(*) as val FROM visitors WHERE first_visit >= ? AND (gclid IS NOT NULL AND gclid != '')").get(windowStart);
      return row.val || 0;
    }
    case 'conversions': {
      const row = db.prepare("SELECT COUNT(*) as val FROM conversion_events WHERE created_at >= ? AND status = 'sent'").get(windowStart);
      return row.val || 0;
    }
    default:
      return 0;
  }
}

function checkCondition(value, condition, threshold) {
  switch (condition) {
    case 'greater_than': return value > threshold;
    case 'less_than': return value < threshold;
    case 'equals': return value === threshold;
    default: return false;
  }
}

async function sendAlertEmail(rule, currentValue) {
  const transporter = createTransporter();
  if (!transporter) return;

  const smtpConfig = getSmtpConfig();
  const recipients = (rule.email_recipients || '').split(',').map(e => e.trim()).filter(Boolean);
  if (recipients.length === 0) return;

  const conditionText = rule.condition.replace('_', ' ');

  await transporter.sendMail({
    from: smtpConfig.smtp_from || smtpConfig.smtp_user,
    to: recipients.join(', '),
    subject: `Alert: ${rule.name}`,
    html: `
      <h2>Alert Rule Triggered</h2>
      <p><strong>Rule:</strong> ${rule.name}</p>
      <p><strong>Condition:</strong> ${rule.metric} ${conditionText} ${rule.threshold}</p>
      <p><strong>Current Value:</strong> ${currentValue}</p>
      <p><strong>Time Window:</strong> Last ${rule.time_window_hours} hour(s)</p>
      ${rule.secondary_metric ? `<p><strong>Secondary:</strong> ${rule.secondary_metric} ${(rule.secondary_condition || '').replace('_', ' ')} ${rule.secondary_threshold}</p>` : ''}
      <p style="color:#666;font-size:12px;margin-top:16px;">Sent from Coastal Debt CMS</p>
    `
  });

  console.log(`Alert email sent for rule "${rule.name}" to:`, recipients.join(', '));
}

module.exports = router;
module.exports.sendLeadNotification = sendLeadNotification;
module.exports.evaluateAlertRules = evaluateAlertRules;
