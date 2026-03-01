const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, localDateToUtcRange, getNowInTz } = require('../lib/timezone');

const router = express.Router();

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
let sendLeadNotification = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
  try { sendLeadNotification = require('./notifications').sendLeadNotification; } catch (e) {}
}, 0);

// Import Google Ads functions (will be loaded after module initialization)
let fetchGclidCost = null;
let uploadConversion = null;
let sendFacebookEvent = null;
let uploadBingConversion = null;
let pushLeadToSalesforce = null;
setTimeout(() => {
  try {
    fetchGclidCost = require('./google-ads').fetchGclidCost;
    uploadConversion = require('./google-ads').uploadConversion;
  } catch (e) {
    console.log('Google Ads module not loaded yet');
  }
  try {
    sendFacebookEvent = require('./facebook').sendFacebookEvent;
  } catch (e) {
    console.log('Facebook module not loaded yet');
  }
  try {
    uploadBingConversion = require('./bing-ads').uploadBingConversion;
  } catch (e) {
    console.log('Bing Ads module not loaded yet');
  }
  try {
    pushLeadToSalesforce = require('./salesforce').pushLeadToSalesforce;
  } catch (e) {
    console.log('Salesforce module not loaded yet');
  }
}, 0);

// Submit lead (public endpoint - from landing pages)
router.post('/', async (req, res) => {
  const {
    landing_page_slug,
    article_slug,
    first_name,
    last_name,
    company_name,
    email,
    phone,
    debt_amount,
    has_mca,
    considered_bankruptcy,
    gclid,
    msclkid,
    fbclid,
    rt_clickid: rt_clickid_body,
    eli_clickid,
    ...hiddenFields
  } = req.body;

  // Get rt_clickid from: body → RedTrack cookie
  const rt_clickid = rt_clickid_body || req.cookies?.['rtkclickid-store'] || '';
  console.log('Lead click IDs:', { gclid: gclid || '', eli_clickid: eli_clickid || '', rt_clickid_body: rt_clickid_body || '', rt_clickid_cookie: req.cookies?.['rtkclickid-store'] || '', rt_clickid_final: rt_clickid, msclkid: msclkid || '', fbclid: fbclid || '', slug: landing_page_slug || article_slug });

  // Find the landing page or article
  let page = null;
  let article = null;

  if (article_slug) {
    article = db.prepare('SELECT * FROM articles WHERE slug = ?').get(article_slug);
    if (!article) return res.status(400).json({ error: 'Invalid article' });
  } else {
    page = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(landing_page_slug);
    if (!page) return res.status(400).json({ error: 'Invalid landing page' });
  }

  // Get the form if assigned
  let form = null;
  const formId = article ? article.form_id : page.form_id;
  if (formId) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(formId);
  }

  // Insert lead
  const full_name = [first_name, last_name].filter(Boolean).join(' ');
  const result = db.prepare(`
    INSERT INTO leads (
      landing_page_id, article_id, full_name, first_name, last_name, company_name, email, phone,
      debt_amount, has_mca, considered_bankruptcy, gclid, msclkid, fbclid, rt_clickid, eli_clickid, hidden_fields
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    page ? page.id : null,
    article ? article.id : null,
    full_name,
    first_name || '',
    last_name || '',
    company_name,
    email,
    phone,
    debt_amount,
    has_mca,
    considered_bankruptcy,
    gclid || '',
    msclkid || '',
    fbclid || '',
    rt_clickid || '',
    eli_clickid || '',
    JSON.stringify(hiddenFields)
  );

  // Determine webhook URL: page/article webhook overrides form webhook
  const sourceEntity = page || article;
  const webhookUrl = (page ? page.webhook_url : null) || (form ? form.webhook_url : null);

  // Send to webhook if configured
  if (webhookUrl) {
    try {
      const webhookData = {
        first_name: first_name || '',
        last_name: last_name || '',
        full_name,
        company_name,
        email,
        phone,
        debt_amount,
        has_mca,
        considered_bankruptcy,
        gclid: gclid || '',
        msclkid: msclkid || '',
        rt_clickid: rt_clickid || '',
        eli_clickid: eli_clickid || '',
        traffic_source: sourceEntity.traffic_source,
        landing_page: sourceEntity.name,
        source_type: article ? 'article' : 'landing_page',
        ...hiddenFields,
        submitted_at: new Date().toLocaleString('en-US', { timeZone: getConfiguredTimezone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '')
      };

      console.log('Sending to webhook:', webhookUrl);
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookData)
      }).then(res => console.log('Webhook response:', res.status))
        .catch(err => console.error('Webhook error:', err));
    } catch (err) {
      console.error('Webhook error:', err);
    }
  }

  // Mark visitor as converted
  if (eli_clickid) {
    try {
      db.prepare(`
        UPDATE visitors SET converted = 1, lead_id = ? WHERE eli_clickid = ?
      `).run(result.lastInsertRowid, eli_clickid);
    } catch (err) {
      console.error('Failed to mark visitor as converted:', err);
    }
  }

  // Check if visitor's IP is in the blocklist
  let isBlocked = false;
  if (eli_clickid) {
    try {
      const visitor = db.prepare('SELECT ip_address FROM visitors WHERE eli_clickid = ?').get(eli_clickid);
      if (visitor && visitor.ip_address) {
        const blocked = db.prepare('SELECT id FROM blocked_ips WHERE ip_address = ?').get(visitor.ip_address);
        if (blocked) {
          isBlocked = true;
          db.prepare('UPDATE leads SET is_blocked = 1 WHERE id = ?').run(result.lastInsertRowid);
          console.log(`Lead ${result.lastInsertRowid} marked as blocked (IP: ${visitor.ip_address})`);
        }
      }
    } catch (err) {
      console.error('Failed to check IP blocklist:', err);
    }
  }

  // Fetch Google Ads cost for GCLID (async, don't block response)
  if (gclid && fetchGclidCost) {
    fetchGclidCost(gclid).then(cost => {
      if (cost) {
        db.prepare(`
          UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(cost.cost_cents, cost.currency, result.lastInsertRowid);
        console.log(`Fetched cost for lead ${result.lastInsertRowid}: $${(cost.cost_cents/100).toFixed(2)}`);
      }
    }).catch(err => console.error('Failed to fetch GCLID cost:', err));
  }

  // Skip all conversion event sends if lead is from a blocked IP
  if (!isBlocked) {
    // Auto-create "lead" conversion event for every lead submission
    try {
      const leadConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();

      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, gclid, conversion_action_id, conversion_action_name, source, status)
        VALUES (?, ?, ?, ?, 'lead', 'auto', ?)
      `).run(
        result.lastInsertRowid,
        eli_clickid || '',
        gclid || '',
        leadConfig?.conversion_action_id || null,
        (gclid && leadConfig?.conversion_action_id) ? 'pending' : 'logged'
      );

      // Send to Google Ads if GCLID + conversion action configured
      if (gclid && leadConfig?.conversion_action_id && uploadConversion) {
        const leadId = result.lastInsertRowid;
        uploadConversion(gclid, leadConfig.conversion_action_id).then(gadsResult => {
          const evt = db.prepare(`SELECT id FROM conversion_events WHERE lead_id = ? AND conversion_action_name = 'lead' ORDER BY id DESC LIMIT 1`).get(leadId);
          if (gadsResult.success && evt) {
            db.prepare(`UPDATE conversion_events SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`).run(evt.id);
          } else if (evt) {
            db.prepare(`UPDATE conversion_events SET status = 'failed', error_message = ? WHERE id = ?`).run(gadsResult.error, evt.id);
          }
        }).catch(err => console.error('Failed to send lead event to Google Ads:', err));
      }
    } catch (err) {
      console.error('Failed to create lead conversion event:', err);
    }

    // Auto-send 'lead' event to Bing Ads if msclkid + config present
    if (msclkid && uploadBingConversion) {
      try {
        const bingConfig = db.prepare('SELECT * FROM bing_ads_config WHERE id = 1').get();
        const leadBingConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
        if (bingConfig && bingConfig.refresh_token_encrypted && leadBingConfig && leadBingConfig.send_to_bing && leadBingConfig.bing_conversion_goal_id) {
          const leadId = result.lastInsertRowid;
          uploadBingConversion(msclkid, leadBingConfig.bing_conversion_goal_id).then(bingResult => {
            db.prepare(`
              INSERT INTO conversion_events (lead_id, eli_clickid, msclkid, conversion_action_name, source, status, error_message, sent_at)
              VALUES (?, ?, ?, 'lead', 'bing_ads', ?, ?, ${bingResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'})
            `).run(
              leadId,
              eli_clickid || '',
              msclkid,
              bingResult.success ? 'sent' : 'failed',
              bingResult.error || null
            );
            console.log(`Bing Ads lead event for lead ${leadId}: ${bingResult.success ? 'sent' : 'failed'}`);
          }).catch(err => console.error('Failed to send Bing Ads lead event:', err));
        }
      } catch (err) {
        console.error('Failed to check Bing Ads config for lead event:', err);
      }
    }

    // Send "Lead" event to Facebook CAPI if lead is from a meta-platform page
    if (sourceEntity.platform === 'meta' && sendFacebookEvent) {
      const leadConfig = db.prepare(`SELECT facebook_event_name FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
      const fbLeadEvent = leadConfig?.facebook_event_name || 'Lead';

      const firstName = first_name || '';
      const lastName = last_name || '';

      // Look up visitor record for fbc/fbp/fbclid/IP/UA
      const visitor = eli_clickid ? db.prepare('SELECT fbc, fbp, fbclid, ip_address, user_agent FROM visitors WHERE eli_clickid = ?').get(eli_clickid) : null;

      // Resolve fbc: visitor cookie → construct from fbclid (form or visitor)
      let fbc = visitor?.fbc || '';
      if (!fbc) {
        const resolvedFbclid = fbclid || visitor?.fbclid || '';
        if (resolvedFbclid) {
          // Construct fbc in Facebook's format: fb.1.{timestamp_ms}.{fbclid}
          fbc = `fb.1.${Date.now()}.${resolvedFbclid}`;
        }
      }

      // Get client IP and user agent: prefer visitor's stored values (original browser), fallback to request
      const clientIp = visitor?.ip_address ||
                       req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                       req.headers['x-real-ip'] ||
                       req.connection?.remoteAddress || req.ip || '';
      const clientUa = visitor?.user_agent || req.headers['user-agent'] || '';

      // Build event_source_url from the landing page slug
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
      const eventSourceUrl = article ? `${baseUrl}/a/${article.slug}` : `${baseUrl}/${page.slug}`;

      sendFacebookEvent(fbLeadEvent, {
        email,
        phone,
        firstName,
        lastName,
        fbc,
        fbp: visitor?.fbp || '',
        client_ip_address: clientIp,
        client_user_agent: clientUa
      }, {
        event_source_url: eventSourceUrl
      }).then(fbResult => {
        db.prepare(`
          INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, source, status, error_message, sent_at, capi_payload)
          VALUES (?, ?, 'lead', NULL, 'facebook_capi', ?, ?, ${fbResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)
        `).run(
          result.lastInsertRowid,
          eli_clickid || '',
          fbResult.success ? 'sent' : 'failed',
          fbResult.error || null,
          fbResult.payload ? JSON.stringify(fbResult.payload) : null
        );
        console.log(`Facebook CAPI Lead event for lead ${result.lastInsertRowid}: ${fbResult.success ? 'sent' : 'failed'}${fbResult.event_id ? ', event_id: ' + fbResult.event_id : ''}`);
      }).catch(err => console.error('Failed to send Facebook CAPI Lead event:', err));
    }

    // Auto-push to Salesforce
    if (pushLeadToSalesforce) {
      pushLeadToSalesforce(result.lastInsertRowid).catch(err =>
        console.error('Salesforce auto-push error:', err));
    }
  } else {
    // Log blocked lead event
    try {
      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, gclid, conversion_action_name, source, status, error_message)
        VALUES (?, ?, ?, 'lead', 'auto', 'blocked', 'IP is on blocklist - conversion events skipped')
      `).run(result.lastInsertRowid, eli_clickid || '', gclid || '');
    } catch (err) {
      console.error('Failed to log blocked lead event:', err);
    }
  }

  res.json({ success: true, id: result.lastInsertRowid });

  // Send lead notification email (async, don't block)
  if (sendLeadNotification) {
    sendLeadNotification({ first_name, last_name, full_name, company_name, email, phone }, sourceEntity).catch(() => {});
  }
});

// Get all leads (admin)
router.get('/', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, search, landing_page_id, platform, from_date, to_date,
          event, campaign, has_mca, debt_amount, stage, transfer_status } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform,
           a.name as article_name, a.platform as article_platform,
           COALESCE(lp.name, a.name) as source_name,
           COALESCE(lp.platform, a.platform) as source_platform,
           v.utm_campaign, v.ip_address,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN articles a ON l.article_id = a.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE 1=1
  `;
  let countQuery = `
    SELECT COUNT(*) as total FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN articles a ON l.article_id = a.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    countQuery += ` AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (landing_page_id) {
    query += ` AND l.landing_page_id = ?`;
    countQuery += ` AND l.landing_page_id = ?`;
    params.push(landing_page_id);
  }

  if (platform) {
    query += ` AND lp.platform = ?`;
    countQuery += ` AND lp.platform = ?`;
    params.push(platform);
  }

  if (from_date) {
    const tz = getConfiguredTimezone();
    query += ` AND l.created_at >= ?`;
    countQuery += ` AND l.created_at >= ?`;
    params.push(from_date.length === 10 ? localDateToUtcRange(from_date, tz).start : from_date);
  }

  if (to_date) {
    const tz = getConfiguredTimezone();
    query += ` AND l.created_at <= ?`;
    countQuery += ` AND l.created_at <= ?`;
    params.push(to_date.length === 10 ? localDateToUtcRange(to_date, tz).end : to_date);
  }

  if (event) {
    const eventFilter = ` AND EXISTS (SELECT 1 FROM conversion_events ce2 WHERE ce2.lead_id = l.id AND ce2.conversion_action_name = ?)`;
    query += eventFilter;
    countQuery += eventFilter;
    params.push(event);
  }

  if (campaign) {
    query += ` AND v.utm_campaign = ?`;
    countQuery += ` AND v.utm_campaign = ?`;
    params.push(campaign);
  }

  if (has_mca) {
    query += ` AND l.has_mca = ?`;
    countQuery += ` AND l.has_mca = ?`;
    params.push(has_mca);
  }

  if (debt_amount) {
    query += ` AND l.debt_amount = ?`;
    countQuery += ` AND l.debt_amount = ?`;
    params.push(debt_amount);
  }

  if (stage) {
    query += ` AND l.stage = ?`;
    countQuery += ` AND l.stage = ?`;
    params.push(stage);
  }

  if (transfer_status) {
    query += ` AND l.transfer_status = ?`;
    countQuery += ` AND l.transfer_status = ?`;
    params.push(transfer_status);
  }

  const total = db.prepare(countQuery).get(...params).total;

  query += ` ORDER BY l.created_at DESC LIMIT ? OFFSET ?`;
  const leads = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));

  // Parse hidden_fields JSON
  leads.forEach(lead => {
    try {
      lead.hidden_fields = JSON.parse(lead.hidden_fields || '{}');
    } catch (e) {
      lead.hidden_fields = {};
    }
  });

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// ─── Blocked IPs Management ────────────────────────────────────────────────

// List all blocked IPs
router.get('/blocked-ips/list', authenticateToken, (req, res) => {
  const ips = db.prepare('SELECT * FROM blocked_ips ORDER BY created_at DESC').all();
  res.json(ips);
});

// Add IP to blocklist
router.post('/blocked-ips', authenticateToken, (req, res) => {
  const { ip_address, reason } = req.body;
  if (!ip_address) return res.status(400).json({ error: 'ip_address is required' });

  try {
    const result = db.prepare('INSERT INTO blocked_ips (ip_address, reason) VALUES (?, ?)').run(ip_address.trim(), reason || '');
    // Mark all existing leads from this IP as blocked
    const affected = db.prepare(`
      UPDATE leads SET is_blocked = 1
      WHERE eli_clickid IN (SELECT eli_clickid FROM visitors WHERE ip_address = ?)
        AND is_blocked = 0
    `).run(ip_address.trim());
    if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'created', 'blocked_ip', result.lastInsertRowid, `Blocked IP: ${ip_address}`, req.ip);
    res.json({ id: result.lastInsertRowid, affected_leads: affected.changes });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'IP already blocked' });
    res.status(500).json({ error: err.message });
  }
});

// Remove IP from blocklist
router.delete('/blocked-ips/:id', authenticateToken, (req, res) => {
  const ip = db.prepare('SELECT ip_address FROM blocked_ips WHERE id = ?').get(req.params.id);
  if (!ip) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM blocked_ips WHERE id = ?').run(req.params.id);
  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'blocked_ip', parseInt(req.params.id), `Unblocked IP: ${ip.ip_address}`, req.ip);
  res.json({ message: 'IP removed from blocklist' });
});

// Manually block a lead (sets is_blocked = 1, adds visitor IP to blocklist)
router.post('/:id/block', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT l.eli_clickid FROM leads l WHERE l.id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  db.prepare('UPDATE leads SET is_blocked = 1 WHERE id = ?').run(req.params.id);

  let ip_address = null;
  if (lead.eli_clickid) {
    const visitor = db.prepare('SELECT ip_address FROM visitors WHERE eli_clickid = ?').get(lead.eli_clickid);
    if (visitor && visitor.ip_address) {
      ip_address = visitor.ip_address;
      try {
        db.prepare('INSERT OR IGNORE INTO blocked_ips (ip_address, reason) VALUES (?, ?)').run(ip_address, req.body.reason || 'Blocked from lead #' + req.params.id);
        // Mark all other leads from this IP as blocked
        db.prepare(`
          UPDATE leads SET is_blocked = 1
          WHERE eli_clickid IN (SELECT eli_clickid FROM visitors WHERE ip_address = ?)
            AND is_blocked = 0
        `).run(ip_address);
      } catch (err) {
        console.error('Failed to add IP to blocklist:', err);
      }
    }
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'lead', parseInt(req.params.id), `Blocked lead #${req.params.id}${ip_address ? ' (IP: ' + ip_address + ')' : ''}`, req.ip);
  res.json({ success: true, ip_address });
});

// Unblock a lead (sets is_blocked = 0)
router.post('/:id/unblock', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  db.prepare('UPDATE leads SET is_blocked = 0 WHERE id = ?').run(req.params.id);
  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'updated', 'lead', parseInt(req.params.id), `Unblocked lead #${req.params.id}`, req.ip);
  res.json({ success: true });
});

// Get single lead (with events timeline)
router.get('/:id', authenticateToken, (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform,
           a.name as article_name, a.platform as article_platform,
           v.ip_address
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN articles a ON l.article_id = a.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE l.id = ?
  `).get(req.params.id);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  try {
    lead.hidden_fields = JSON.parse(lead.hidden_fields || '{}');
  } catch (e) {
    lead.hidden_fields = {};
  }

  // Include event timeline
  lead.events = db.prepare(`
    SELECT id, conversion_action_name, conversion_value, debt_amount,
           revenue, source, status, error_message, created_at, sent_at
    FROM conversion_events
    WHERE lead_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);

  res.json(lead);
});

// Get lead events timeline
router.get('/:id/events', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const events = db.prepare(`
    SELECT id, conversion_action_name, conversion_value, debt_amount,
           revenue, source, status, error_message, created_at, sent_at
    FROM conversion_events
    WHERE lead_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);

  res.json(events);
});

// Update lead fields (Salesforce tracking)
router.patch('/:id', authenticateToken, (req, res) => {
  const { transfer_status, five9_dispo, stage, contract_sign_date, total_debt_sign, eli_clickid, fbclid } = req.body;
  const fields = [];
  const params = [];

  if (transfer_status !== undefined) { fields.push('transfer_status = ?'); params.push(transfer_status); }
  if (five9_dispo !== undefined) { fields.push('five9_dispo = ?'); params.push(five9_dispo); }
  if (stage !== undefined) { fields.push('stage = ?'); params.push(stage); }
  if (contract_sign_date !== undefined) { fields.push('contract_sign_date = ?'); params.push(contract_sign_date); }
  if (total_debt_sign !== undefined) { fields.push('total_debt_sign = ?'); params.push(total_debt_sign); }
  if (eli_clickid !== undefined) { fields.push('eli_clickid = ?'); params.push(eli_clickid); }
  if (fbclid !== undefined) { fields.push('fbclid = ?'); params.push(fbclid); }

  if (!fields.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(req.params.id);
  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// Delete lead (cascades to conversion_events and visitors)
router.delete('/:id', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT first_name, last_name, eli_clickid FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  // Delete related records first
  db.prepare('DELETE FROM conversion_events WHERE lead_id = ?').run(req.params.id);
  if (lead.eli_clickid) {
    db.prepare('UPDATE visitors SET lead_id = NULL, converted = 0 WHERE lead_id = ?').run(req.params.id);
  }
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'lead', parseInt(req.params.id), `Deleted lead: ${[lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || req.params.id}`, req.ip);
  res.json({ message: 'Lead deleted' });
});

// Zapier webhook - validates API key
// POST /api/leads/zapier?key=xxx — accepts any JSON body, tries every field name
router.post('/zapier', async (req, res) => {
  try {
    const apiKey = req.query.key;
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });
    const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('zapier_api_key');
    if (!stored || stored.value !== apiKey) return res.status(403).json({ error: 'Invalid API key' });

    const body = req.body;
    console.log('Zapier incoming:', JSON.stringify(body));

    // Grab every value from the body regardless of key name
    const allValues = Object.entries(body);
    function find(...keywords) {
      for (const kw of keywords) {
        const match = allValues.find(([k]) => k.toLowerCase().replace(/[^a-z]/g, '').includes(kw));
        if (match && match[1]) return String(match[1]);
      }
      return '';
    }

    const zapFirstName = find('firstname', 'first');
    const zapLastName = find('lastname', 'last');
    const fullName = find('fullname', 'name') || [zapFirstName, zapLastName].filter(Boolean).join(' ');
    const firstName = zapFirstName || fullName.trim().split(/\s+/)[0] || '';
    const lastName = zapLastName || fullName.trim().split(/\s+/).slice(1).join(' ') || '';
    const email = find('email', 'mail');
    const phone = find('phone', 'tel', 'mobile', 'cell');
    const company = find('company', 'business');
    const debt = find('debt', 'amount', 'howmuch');
    const mca = find('mca', 'merchant');

    // Find landing page: meta page first, then any
    let pageId = null;
    const fbConfig = db.prepare('SELECT default_landing_page_id FROM facebook_config WHERE id = 1').get();
    if (fbConfig && fbConfig.default_landing_page_id) pageId = fbConfig.default_landing_page_id;
    if (!pageId) {
      const p = db.prepare("SELECT id FROM landing_pages WHERE platform = 'meta' ORDER BY id DESC LIMIT 1").get();
      if (p) pageId = p.id;
    }
    if (!pageId) {
      const p = db.prepare('SELECT id FROM landing_pages ORDER BY id DESC LIMIT 1').get();
      if (p) pageId = p.id;
    }
    if (!pageId) return res.status(400).json({ error: 'No landing pages exist' });

    const result = db.prepare(`
      INSERT INTO leads (
        landing_page_id, full_name, first_name, last_name, company_name, email, phone,
        debt_amount, has_mca, considered_bankruptcy, gclid, msclkid, fbclid, rt_clickid, eli_clickid, hidden_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', ?, ?)
    `).run(
      pageId, fullName, firstName, lastName, company, email, phone, debt, mca,
      'zapier_' + Date.now(),
      JSON.stringify({ source: 'facebook_instant_form', platform: 'facebook', raw: body })
    );

    console.log(`Zapier lead #${result.lastInsertRowid}: ${fullName} | ${email} | ${phone}`);

    // Notification
    if (sendLeadNotification) {
      const lp = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(pageId);
      sendLeadNotification({ first_name: firstName, last_name: lastName, full_name: fullName, company_name: company, email, phone }, lp).catch(() => {});
    }

    // Conversion event
    try {
      db.prepare(`INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, source, status) VALUES (?, ?, 'lead', 'zapier', 'logged')`).run(result.lastInsertRowid, '');
    } catch (e) {}

    // Facebook CAPI
    if (sendFacebookEvent) {
      const zapierLeadConfig = db.prepare(`SELECT facebook_event_name FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
      const fbLeadEvent = zapierLeadConfig?.facebook_event_name || 'Lead';
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.connection?.remoteAddress || req.ip || '';
      const clientUa = req.headers['user-agent'] || '';
      sendFacebookEvent(fbLeadEvent, { email, phone, firstName, lastName, client_ip_address: clientIp, client_user_agent: clientUa }, {}).catch(() => {});
    }

    // Auto-push to Salesforce
    if (pushLeadToSalesforce) {
      pushLeadToSalesforce(result.lastInsertRowid).catch(() => {});
    }

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('Zapier error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get lead email history
router.get('/:id/emails', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const emails = db.prepare(`
    SELECT eq.id, eq.subject, eq.status, eq.to_email, eq.sent_at, eq.opened_at, eq.clicked_at,
           eq.open_count, eq.click_count, eq.error_message,
           ec.name as campaign_name
    FROM email_queue eq
    LEFT JOIN email_campaigns ec ON eq.campaign_id = ec.id
    WHERE eq.lead_id = ?
    ORDER BY eq.queued_at DESC
  `).all(req.params.id);

  res.json(emails);
});

// Export leads to CSV
router.get('/export/csv', authenticateToken, (req, res) => {
  const { landing_page_id, from_date, to_date } = req.query;

  let query = `
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE 1=1
  `;
  const params = [];

  if (landing_page_id) {
    query += ` AND l.landing_page_id = ?`;
    params.push(landing_page_id);
  }

  if (from_date) {
    const tz = getConfiguredTimezone();
    query += ` AND l.created_at >= ?`;
    params.push(from_date.length === 10 ? localDateToUtcRange(from_date, tz).start : from_date);
  }

  if (to_date) {
    const tz = getConfiguredTimezone();
    query += ` AND l.created_at <= ?`;
    params.push(to_date.length === 10 ? localDateToUtcRange(to_date, tz).end : to_date);
  }

  query += ` ORDER BY l.created_at DESC`;

  const leads = db.prepare(query).all(...params);

  // Create CSV
  const headers = [
    'ID', 'First Name', 'Last Name', 'Company', 'Email', 'Phone', 'Debt Amount',
    'Has MCA', 'Considered Bankruptcy', 'GCLID', 'RT Click ID', 'Eli Click ID',
    'Cost', 'Landing Page', 'Traffic Source', 'Platform', 'Created At'
  ];

  const rows = leads.map(l => [
    l.id,
    l.first_name || '',
    l.last_name || '',
    l.company_name,
    l.email,
    l.phone,
    l.debt_amount,
    l.has_mca,
    l.considered_bankruptcy,
    l.gclid,
    l.rt_clickid,
    l.eli_clickid,
    l.cost_cents ? `$${(l.cost_cents/100).toFixed(2)}` : '',
    l.landing_page_name,
    l.traffic_source,
    l.platform,
    l.created_at
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.map(cell => `"${cell || ''}"`).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=leads-${Date.now()}.csv`);
  res.send(csv);
});

module.exports = router;
