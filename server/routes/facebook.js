const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import uploadConversion (loaded after initialization)
let uploadConversion = null;
setTimeout(() => {
  try {
    uploadConversion = require('./google-ads').uploadConversion;
  } catch (e) {}
}, 0);

// Field mapping: Facebook field name → our field name
const FIELD_MAP = {
  full_name: 'full_name',
  name: 'full_name',
  first_name: '_first_name',
  last_name: '_last_name',
  email: 'email',
  phone_number: 'phone',
  phone: 'phone',
  company_name: 'company_name',
  company: 'company_name',
  job_title: '_job_title',
  city: '_city',
  state: '_state',
  zip_code: '_zip',
  street_address: '_street'
};

/**
 * WEBHOOK VERIFICATION
 * Facebook sends a GET request to verify the webhook URL
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe') {
    const config = db.prepare('SELECT verify_token FROM facebook_config WHERE id = 1').get();

    if (config && token === config.verify_token) {
      console.log('Facebook webhook verified');
      return res.status(200).send(challenge);
    }
  }

  res.status(403).send('Forbidden');
});

/**
 * WEBHOOK RECEIVER
 * Facebook sends leadgen events here
 */
router.post('/webhook', async (req, res) => {
  // Always respond 200 quickly to acknowledge receipt
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'page') return;

    const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
    if (!config || !config.page_access_token) {
      console.error('Facebook config not set up');
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === 'leadgen') {
          const leadgenId = change.value.leadgen_id;
          console.log('Facebook lead received:', leadgenId);
          await processLeadgenEvent(leadgenId, config);
        }
      }
    }
  } catch (err) {
    console.error('Facebook webhook error:', err);
  }
});

/**
 * Fetch lead data from Facebook Graph API and insert into DB
 */
async function processLeadgenEvent(leadgenId, config) {
  try {
    // Fetch lead data from Facebook
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${config.page_access_token}`
    );
    const data = await response.json();

    if (data.error) {
      console.error('Facebook API error:', data.error.message);
      return;
    }

    // Map Facebook fields to our fields
    const fields = {};
    for (const item of data.field_data || []) {
      const ourField = FIELD_MAP[item.name];
      if (ourField) {
        fields[ourField] = Array.isArray(item.values) ? item.values[0] : item.values;
      }
    }

    // Combine first_name + last_name if full_name not provided
    if (!fields.full_name && (fields._first_name || fields._last_name)) {
      fields.full_name = [fields._first_name, fields._last_name].filter(Boolean).join(' ');
    }

    // Get the landing page to associate with
    const landingPageId = config.default_landing_page_id;
    if (!landingPageId) {
      console.error('No default landing page configured for Facebook leads');
      return;
    }

    // Build hidden fields from unmapped data
    const hiddenFields = {
      source: 'facebook_instant_form',
      fb_leadgen_id: leadgenId,
      fb_form_id: data.form_id || '',
      fb_created_time: data.created_time || ''
    };

    // Add extra mapped fields to hidden_fields
    for (const [key, val] of Object.entries(fields)) {
      if (key.startsWith('_')) {
        hiddenFields[key.slice(1)] = val;
      }
    }

    // Insert lead
    const result = db.prepare(`
      INSERT INTO leads (
        landing_page_id, full_name, company_name, email, phone,
        debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, hidden_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
    `).run(
      landingPageId,
      fields.full_name || '',
      fields.company_name || '',
      fields.email || '',
      fields.phone || '',
      '',
      '',
      '',
      'fb_' + leadgenId,
      JSON.stringify(hiddenFields)
    );

    console.log(`Facebook lead inserted: ID ${result.lastInsertRowid}`);

    // Auto-create "lead" conversion event
    try {
      const leadConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_id, conversion_action_name, source, status)
        VALUES (?, ?, ?, 'lead', 'auto', 'logged')
      `).run(result.lastInsertRowid, 'fb_' + leadgenId, leadConfig?.conversion_action_id || null);
    } catch (err) {
      console.error('Failed to create lead event for FB lead:', err);
    }

    // Send "Lead" event to Facebook CAPI — Instant Form leads are always from Facebook
    try {
      const nameParts = (fields.full_name || '').trim().split(/\s+/);
      const firstName = fields._first_name || nameParts[0] || '';
      const lastName = fields._last_name || nameParts.slice(1).join(' ') || '';

      const fbResult = await sendFacebookEvent('Lead', {
        email: fields.email,
        phone: fields.phone,
        firstName,
        lastName
      });

      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, source, status, error_message, sent_at)
        VALUES (?, ?, 'lead', NULL, 'facebook_capi', ?, ?, ${fbResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'})
      `).run(
        result.lastInsertRowid,
        'fb_' + leadgenId,
        fbResult.success ? 'sent' : 'failed',
        fbResult.error || null
      );
      console.log(`Facebook CAPI Lead event for instant form lead ${result.lastInsertRowid}: ${fbResult.success ? 'sent' : 'failed'}`);
    } catch (err) {
      console.error('Failed to send Facebook CAPI Lead event for instant form:', err);
    }

  } catch (err) {
    console.error('Failed to process Facebook lead:', err);
  }
}

/**
 * Send a conversion event to Facebook Conversions API (CAPI)
 *
 * @param {string} eventName - e.g. "Lead", "Purchase", or custom event
 * @param {object} userData - { email, phone, firstName, lastName }
 * @param {object} [options] - { value, currency }
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendFacebookEvent(eventName, userData, options = {}) {
  try {
    const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
    if (!config || !config.page_access_token || !config.pixel_id) {
      return { success: false, error: 'Facebook CAPI not configured (missing token or pixel_id)' };
    }

    // Hash helper - SHA256, lowercase, trimmed
    const hash = (val) => {
      if (!val) return null;
      return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
    };

    // Normalize phone to E.164-ish (digits only, strip leading +)
    const normalizePhone = (phone) => {
      if (!phone) return null;
      const digits = phone.replace(/\D/g, '');
      return digits || null;
    };

    // Build user_data with hashed fields
    const user_data = {};
    if (userData.email) user_data.em = [hash(userData.email)];
    if (userData.phone) user_data.ph = [hash(normalizePhone(userData.phone))];
    if (userData.firstName) user_data.fn = [hash(userData.firstName)];
    if (userData.lastName) user_data.ln = [hash(userData.lastName)];

    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      user_data
    };

    // Add custom_data if value is provided
    if (options.value !== undefined && options.value !== null) {
      eventData.custom_data = {
        value: parseFloat(options.value),
        currency: options.currency || 'USD'
      };
    }

    const response = await fetch(`https://graph.facebook.com/v21.0/${config.pixel_id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [eventData],
        access_token: config.page_access_token
      })
    });

    const result = await response.json();

    if (result.error) {
      console.error('Facebook CAPI error:', result.error.message);
      return { success: false, error: result.error.message };
    }

    console.log(`Facebook CAPI: sent "${eventName}" event, events_received: ${result.events_received}`);
    return { success: true, events_received: result.events_received };
  } catch (err) {
    console.error('Facebook CAPI request failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * ADMIN: Get Facebook config
 */
router.get('/config', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
  res.json(config || {});
});

/**
 * ADMIN: Save Facebook config
 */
router.post('/config', authenticateToken, (req, res) => {
  const { page_access_token, verify_token, app_id, app_secret, default_landing_page_id, pixel_id, ad_account_id } = req.body;

  const existing = db.prepare('SELECT id FROM facebook_config WHERE id = 1').get();

  if (existing) {
    db.prepare(`
      UPDATE facebook_config SET
        page_access_token = ?,
        verify_token = ?,
        app_id = ?,
        app_secret = ?,
        default_landing_page_id = ?,
        pixel_id = ?,
        ad_account_id = ?,
        connected_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(page_access_token, verify_token, app_id || null, app_secret || null, default_landing_page_id || null, pixel_id || null, ad_account_id || null);
  } else {
    db.prepare(`
      INSERT INTO facebook_config (id, page_access_token, verify_token, app_id, app_secret, default_landing_page_id, pixel_id, ad_account_id, connected_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(page_access_token, verify_token, app_id || null, app_secret || null, default_landing_page_id || null, pixel_id || null, ad_account_id || null);
  }

  res.json({ message: 'Config saved' });
});

/**
 * ADMIN: Get Facebook Ad Account stats (last 30 days)
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
    if (!config || !config.ad_account_id || !config.page_access_token) {
      return res.status(400).json({ error: 'Ad Account ID or Access Token not configured' });
    }

    // Query Facebook Marketing API for account insights
    const params = new URLSearchParams({
      fields: 'spend,impressions,clicks,actions',
      date_preset: 'last_30d',
      access_token: config.page_access_token
    });

    const response = await fetch(
      `https://graph.facebook.com/v21.0/${config.ad_account_id}/insights?${params}`
    );
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Extract values from insights response
    let totalSpend = 0;
    let impressions = 0;
    let clicks = 0;
    let fbLeads = 0;

    if (data.data && data.data.length > 0) {
      const row = data.data[0];
      totalSpend = parseFloat(row.spend || 0);
      impressions = parseInt(row.impressions || 0, 10);
      clicks = parseInt(row.clicks || 0, 10);

      // Find lead count from actions array
      if (row.actions) {
        const leadAction = row.actions.find(a => a.action_type === 'lead');
        if (leadAction) {
          fbLeads = parseInt(leadAction.value || 0, 10);
        }
      }
    }

    // Count local meta-platform leads in last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const localLeadsResult = db.prepare(`
      SELECT COUNT(*) as count FROM leads l
      JOIN landing_pages lp ON l.landing_page_id = lp.id
      WHERE lp.platform = 'meta'
      AND l.created_at >= ?
    `).get(thirtyDaysAgo.toISOString());
    const localLeads = localLeadsResult ? localLeadsResult.count : 0;

    // Calculate avg CPL using local leads (more accurate for this CMS)
    const avgCpl = localLeads > 0 ? totalSpend / localLeads : 0;

    res.json({
      total_spend: totalSpend,
      avg_cpl: avgCpl,
      fb_leads: fbLeads,
      local_leads: localLeads,
      impressions,
      clicks
    });
  } catch (err) {
    console.error('Facebook stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * ADMIN: Test Facebook connection
 */
router.post('/test', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();

  if (!config || !config.page_access_token) {
    return res.status(400).json({ error: 'No page access token configured' });
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/me?access_token=${config.page_access_token}`
    );
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    res.json({ success: true, page_name: data.name, page_id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.sendFacebookEvent = sendFacebookEvent;
