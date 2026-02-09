const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import uploadConversion (loaded after initialization)
let uploadConversion = null;
let sendFacebookEvent = null;
setTimeout(() => {
  try {
    uploadConversion = require('./google-ads').uploadConversion;
  } catch (e) {
    console.log('Google Ads module not loaded yet');
  }
  try {
    sendFacebookEvent = require('./facebook').sendFacebookEvent;
  } catch (e) {
    console.log('Facebook module not loaded yet');
  }
}, 0);

/**
 * PUBLIC POSTBACK ENDPOINT
 * Salesforce (or any system) calls this when a lead converts
 *
 * URL: POST /api/postback/conversion
 *
 * Required params (query string or body):
 *   - eli_clickid: The unique visitor ID
 *   - event: Event name (e.g., "qualified", "appointment", "closed", "sale")
 *
 * Optional params:
 *   - value: Conversion value in dollars
 *   - debt_amount: Debt amount in dollars (sent to Google Ads as revenue)
 *   - revenue: Revenue in dollars (tracked internally, sent to Facebook CAPI)
 *   - currency: Currency code (default: USD)
 *   - transaction_id: Unique ID from Salesforce to prevent duplicates
 *
 * Example URLs:
 *   /api/postback/conversion?eli_clickid=eli_abc123&event=qualified
 *   /api/postback/conversion?eli_clickid=eli_abc123&event=sale&debt_amount=50000&revenue=5000
 */
router.all('/conversion', async (req, res) => {
  // Accept params from query string OR body (for flexibility)
  const params = { ...req.query, ...req.body };

  const {
    eli_clickid,
    event,
    value,
    debt_amount,
    revenue,
    currency = 'USD',
    transaction_id,
    transfer_status,
    five9_dispo,
    stage,
    contract_sign_date,
    total_debt_sign
  } = params;

  // Validate required fields
  if (!eli_clickid) {
    return res.status(400).json({
      success: false,
      error: 'eli_clickid is required'
    });
  }

  if (!event) {
    return res.status(400).json({
      success: false,
      error: 'event is required'
    });
  }

  // Find the lead by eli_clickid
  const lead = db.prepare(`
    SELECT l.*, v.gclid as visitor_gclid
    FROM leads l
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid
    WHERE l.eli_clickid = ?
  `).get(eli_clickid);

  if (!lead) {
    // Try finding in visitors table directly
    const visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(eli_clickid);

    if (!visitor) {
      return res.status(404).json({
        success: false,
        error: 'No lead or visitor found with this eli_clickid'
      });
    }

    // Log the event even without a lead
    db.prepare(`
      INSERT INTO conversion_events (eli_clickid, gclid, conversion_action_name, conversion_value, source, status, error_message)
      VALUES (?, ?, ?, ?, 'postback', 'pending', 'No lead found, visitor only')
    `).run(eli_clickid, visitor.gclid, event, value || null);

    return res.json({
      success: true,
      warning: 'Visitor found but no lead associated',
      gclid: visitor.gclid
    });
  }

  // Get the GCLID (from lead or visitor)
  const gclid = lead.gclid || lead.visitor_gclid;

  if (!gclid) {
    // Log the event but can't send to Google
    db.prepare(`
      INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, source, status, error_message)
      VALUES (?, ?, ?, ?, 'postback', 'failed', 'No GCLID available')
    `).run(lead.id, eli_clickid, event, value || null);

    return res.json({
      success: true,
      warning: 'Lead found but no GCLID - cannot send to Google Ads',
      lead_id: lead.id
    });
  }

  // Check for duplicate transaction
  if (transaction_id) {
    const existing = db.prepare(`
      SELECT id FROM conversion_events
      WHERE eli_clickid = ? AND conversion_action_name = ? AND source = 'postback'
      AND created_at > datetime('now', '-24 hours')
    `).get(eli_clickid, event);

    if (existing) {
      return res.json({
        success: true,
        warning: 'Duplicate event ignored',
        event_id: existing.id
      });
    }
  }

  // Find matching postback config to get conversion_action_id
  const config = db.prepare(`
    SELECT * FROM postback_config WHERE event_name = ? AND is_active = 1
  `).get(event);

  let googleResult = null;
  let status = 'logged';

  // If we have a conversion action configured, send to Google Ads
  // Use debt_amount as revenue, fall back to value
  const googleAdsValue = debt_amount ? parseFloat(debt_amount) : (value ? parseFloat(value) : null);
  if (config && config.conversion_action_id && uploadConversion) {
    googleResult = await uploadConversion(
      gclid,
      config.conversion_action_id,
      null,
      googleAdsValue,
      currency
    );
    status = googleResult.success ? 'sent' : 'failed';
  }

  // Log the conversion event
  const eventLog = db.prepare(`
    INSERT INTO conversion_events (lead_id, eli_clickid, gclid, conversion_action_id, conversion_action_name, conversion_value, debt_amount, revenue, source, status, error_message, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'postback', ?, ?, ${status === 'sent' ? 'CURRENT_TIMESTAMP' : 'NULL'})
  `).run(
    lead.id,
    eli_clickid,
    gclid,
    config?.conversion_action_id || null,
    event,
    value || null,
    debt_amount ? parseFloat(debt_amount) : null,
    revenue ? parseFloat(revenue) : null,
    status,
    googleResult?.error || null
  );

  // Send to Facebook CAPI if event config has send_to_facebook enabled
  let fbResult = null;
  if (config && config.send_to_facebook && sendFacebookEvent) {
    try {
      const nameParts = (lead.full_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const fbValue = revenue ? parseFloat(revenue) : (debt_amount ? parseFloat(debt_amount) : (value ? parseFloat(value) : undefined));
      fbResult = await sendFacebookEvent(event, {
        email: lead.email,
        phone: lead.phone,
        firstName,
        lastName
      }, { value: fbValue, currency });

      // Log Facebook CAPI result in conversion_events
      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, debt_amount, revenue, source, status, error_message, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, 'facebook_capi', ?, ?, ${fbResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'})
      `).run(
        lead.id,
        eli_clickid,
        event,
        value || null,
        debt_amount ? parseFloat(debt_amount) : null,
        revenue ? parseFloat(revenue) : null,
        fbResult.success ? 'sent' : 'failed',
        fbResult.error || null
      );
    } catch (err) {
      console.error('Failed to send Facebook CAPI event:', err);
    }
  }

  // Update lead status if needed
  db.prepare(`
    UPDATE leads SET
      hidden_fields = json_set(COALESCE(hidden_fields, '{}'), '$.last_event', ?),
      hidden_fields = json_set(COALESCE(hidden_fields, '{}'), '$.last_event_time', ?)
    WHERE id = ?
  `).run(event, new Date().toISOString(), lead.id);

  // Update Salesforce tracking fields if provided
  const sfFields = [];
  const sfParams = [];
  if (transfer_status !== undefined) { sfFields.push('transfer_status = ?'); sfParams.push(transfer_status); }
  if (five9_dispo !== undefined) { sfFields.push('five9_dispo = ?'); sfParams.push(five9_dispo); }
  if (stage !== undefined) { sfFields.push('stage = ?'); sfParams.push(stage); }
  if (contract_sign_date !== undefined) { sfFields.push('contract_sign_date = ?'); sfParams.push(contract_sign_date); }
  if (total_debt_sign !== undefined) { sfFields.push('total_debt_sign = ?'); sfParams.push(total_debt_sign); }
  if (sfFields.length) {
    sfParams.push(lead.id);
    db.prepare(`UPDATE leads SET ${sfFields.join(', ')} WHERE id = ?`).run(...sfParams);
  }

  res.json({
    success: true,
    event_id: eventLog.lastInsertRowid,
    lead_id: lead.id,
    gclid: gclid,
    debt_amount: debt_amount ? parseFloat(debt_amount) : null,
    revenue: revenue ? parseFloat(revenue) : null,
    google_ads_sent: status === 'sent',
    google_ads_configured: !!(config && config.conversion_action_id),
    facebook_capi_sent: fbResult?.success || false
  });
});

/**
 * Get postback URL for Salesforce setup
 */
router.get('/url', authenticateToken, (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

  res.json({
    postback_url: `${baseUrl}/api/postback/conversion`,
    example_full: `${baseUrl}/api/postback/conversion?eli_clickid={eli_clickid}&event={event_name}&value={value}`,
    parameters: {
      eli_clickid: 'Required - The visitor ID from the lead',
      event: 'Required - Event name (e.g., qualified, appointment, closed, sale)',
      value: 'Optional - Conversion value in dollars',
      debt_amount: 'Optional - Debt amount in dollars (sent to Google Ads as revenue)',
      revenue: 'Optional - Revenue in dollars (tracked internally, sent to Facebook CAPI)',
      currency: 'Optional - Currency code (default: USD)',
      transaction_id: 'Optional - Unique ID to prevent duplicates',
      transfer_status: 'Optional - Lead transfer status from Salesforce',
      five9_dispo: 'Optional - Five9 disposition',
      stage: 'Optional - Lead stage in pipeline',
      contract_sign_date: 'Optional - Contract signing date',
      total_debt_sign: 'Optional - Total debt at signing'
    }
  });
});

/**
 * ADMIN: Get all postback configurations
 */
router.get('/config', authenticateToken, (req, res) => {
  const configs = db.prepare('SELECT * FROM postback_config ORDER BY created_at DESC').all();
  res.json(configs);
});

/**
 * ADMIN: Create postback configuration
 */
router.post('/config', authenticateToken, (req, res) => {
  const { name, event_name, google_ads_event_name, conversion_action_id, send_to_facebook } = req.body;

  if (!name || !event_name) {
    return res.status(400).json({ error: 'Name and event_name required' });
  }

  const result = db.prepare(`
    INSERT INTO postback_config (name, event_name, google_ads_event_name, conversion_action_id, send_to_facebook)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, event_name.toLowerCase(), google_ads_event_name || null, conversion_action_id || null, send_to_facebook ? 1 : 0);

  res.json({ id: result.lastInsertRowid, message: 'Config created' });
});

/**
 * ADMIN: Update postback configuration
 */
router.put('/config/:id', authenticateToken, (req, res) => {
  const { name, event_name, google_ads_event_name, conversion_action_id, is_active, send_to_facebook } = req.body;

  db.prepare(`
    UPDATE postback_config SET
      name = COALESCE(?, name),
      event_name = COALESCE(?, event_name),
      google_ads_event_name = ?,
      conversion_action_id = ?,
      is_active = COALESCE(?, is_active),
      send_to_facebook = COALESCE(?, send_to_facebook)
    WHERE id = ?
  `).run(name, event_name?.toLowerCase(), google_ads_event_name || null, conversion_action_id || null, is_active, send_to_facebook != null ? (send_to_facebook ? 1 : 0) : null, req.params.id);

  res.json({ message: 'Config updated' });
});

/**
 * ADMIN: Delete postback configuration
 */
router.delete('/config/:id', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM postback_config WHERE id = ?').run(req.params.id);
  res.json({ message: 'Config deleted' });
});

/**
 * ADMIN: Get conversion events log
 */
router.get('/events', authenticateToken, (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const events = db.prepare(`
    SELECT ce.*, l.full_name, l.company_name, l.email
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    ORDER BY ce.created_at DESC
    LIMIT ? OFFSET ?
  `).all(parseInt(limit), parseInt(offset));

  const total = db.prepare('SELECT COUNT(*) as count FROM conversion_events').get().count;

  res.json({
    events,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * ADMIN: Retry failed conversion
 */
router.post('/events/:id/retry', authenticateToken, async (req, res) => {
  const event = db.prepare('SELECT * FROM conversion_events WHERE id = ?').get(req.params.id);

  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  if (!event.gclid) {
    return res.status(400).json({ error: 'No GCLID available' });
  }

  if (!event.conversion_action_id) {
    return res.status(400).json({ error: 'No conversion action configured' });
  }

  if (!uploadConversion) {
    return res.status(500).json({ error: 'Google Ads module not loaded' });
  }

  const result = await uploadConversion(
    event.gclid,
    event.conversion_action_id,
    null,
    event.conversion_value
  );

  if (result.success) {
    db.prepare(`
      UPDATE conversion_events SET status = 'sent', sent_at = CURRENT_TIMESTAMP, error_message = NULL
      WHERE id = ?
    `).run(req.params.id);
    res.json({ success: true, message: 'Conversion sent to Google Ads' });
  } else {
    db.prepare(`
      UPDATE conversion_events SET error_message = ? WHERE id = ?
    `).run(result.error, req.params.id);
    res.status(400).json({ error: result.error });
  }
});

module.exports = router;
