const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');

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
}, 0);

// Submit lead (public endpoint - from landing pages)
router.post('/', async (req, res) => {
  const {
    landing_page_slug,
    full_name,
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
  console.log('Lead rt_clickid:', { body: rt_clickid_body, cookie: req.cookies?.['rtkclickid-store'], allCookies: Object.keys(req.cookies || {}), final: rt_clickid });

  // Find the landing page
  const page = db.prepare('SELECT * FROM landing_pages WHERE slug = ?').get(landing_page_slug);

  if (!page) {
    return res.status(400).json({ error: 'Invalid landing page' });
  }

  // Get the form if assigned
  let form = null;
  if (page.form_id) {
    form = db.prepare('SELECT * FROM forms WHERE id = ?').get(page.form_id);
  }

  // Insert lead
  const result = db.prepare(`
    INSERT INTO leads (
      landing_page_id, full_name, company_name, email, phone,
      debt_amount, has_mca, considered_bankruptcy, gclid, msclkid, fbclid, rt_clickid, eli_clickid, hidden_fields
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    page.id,
    full_name,
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

  // Determine webhook URL: page webhook overrides form webhook
  const webhookUrl = page.webhook_url || (form ? form.webhook_url : null);

  // Send to webhook if configured
  if (webhookUrl) {
    try {
      const webhookData = {
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
        traffic_source: page.traffic_source,
        landing_page: page.name,
        ...hiddenFields,
        submitted_at: new Date().toISOString()
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
  if (page.platform === 'meta' && sendFacebookEvent) {
    const nameParts = (full_name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

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
    const eventSourceUrl = `${baseUrl}/${page.slug}`;

    sendFacebookEvent('Lead', {
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

  res.json({ success: true, id: result.lastInsertRowid });

  // Send lead notification email (async, don't block)
  if (sendLeadNotification) {
    sendLeadNotification({ full_name, company_name, email, phone }, page).catch(() => {});
  }
});

// Get all leads (admin)
router.get('/', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, search, landing_page_id, platform, from_date, to_date,
          event, campaign, has_mca, debt_amount, stage, transfer_status } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform,
           v.utm_campaign,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE 1=1
  `;
  let countQuery = `
    SELECT COUNT(*) as total FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (l.full_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    countQuery += ` AND (l.full_name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
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
    query += ` AND l.created_at >= ?`;
    countQuery += ` AND l.created_at >= ?`;
    params.push(from_date);
  }

  if (to_date) {
    query += ` AND l.created_at <= ?`;
    countQuery += ` AND l.created_at <= ?`;
    params.push(to_date);
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

// Get single lead (with events timeline)
router.get('/:id', authenticateToken, (req, res) => {
  const lead = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
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
  const { transfer_status, five9_dispo, stage, contract_sign_date, total_debt_sign } = req.body;
  const fields = [];
  const params = [];

  if (transfer_status !== undefined) { fields.push('transfer_status = ?'); params.push(transfer_status); }
  if (five9_dispo !== undefined) { fields.push('five9_dispo = ?'); params.push(five9_dispo); }
  if (stage !== undefined) { fields.push('stage = ?'); params.push(stage); }
  if (contract_sign_date !== undefined) { fields.push('contract_sign_date = ?'); params.push(contract_sign_date); }
  if (total_debt_sign !== undefined) { fields.push('total_debt_sign = ?'); params.push(total_debt_sign); }

  if (!fields.length) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(req.params.id);
  db.prepare(`UPDATE leads SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ success: true });
});

// Delete lead
router.delete('/:id', authenticateToken, (req, res) => {
  const lead = db.prepare('SELECT full_name FROM leads WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'deleted', 'lead', parseInt(req.params.id), `Deleted lead: ${lead?.full_name || req.params.id}`, req.ip);
  res.json({ message: 'Lead deleted' });
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
    query += ` AND l.created_at >= ?`;
    params.push(from_date);
  }

  if (to_date) {
    query += ` AND l.created_at <= ?`;
    params.push(to_date);
  }

  query += ` ORDER BY l.created_at DESC`;

  const leads = db.prepare(query).all(...params);

  // Create CSV
  const headers = [
    'ID', 'Full Name', 'Company', 'Email', 'Phone', 'Debt Amount',
    'Has MCA', 'Considered Bankruptcy', 'GCLID', 'RT Click ID', 'Eli Click ID',
    'Cost', 'Landing Page', 'Traffic Source', 'Platform', 'Created At'
  ];

  const rows = leads.map(l => [
    l.id,
    l.full_name,
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
