const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Import logActivity (loaded after initialization to avoid circular deps)
let logActivity = null;
setTimeout(() => {
  try { logActivity = require('./settings').logActivity; } catch (e) {}
}, 0);

// Import uploadConversion (loaded after initialization)
let uploadConversion = null;
let sendLeadNotification = null;
setTimeout(() => {
  try {
    uploadConversion = require('./google-ads').uploadConversion;
  } catch (e) {}
  try {
    sendLeadNotification = require('./notifications').sendLeadNotification;
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
  how_much_debt: 'debt_amount',
  debt_amount: 'debt_amount',
  any_mcas: 'has_mca',
  has_mca: 'has_mca',
  considered_bankruptcy: 'considered_bankruptcy',
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
 * SYNC: Fetch leads directly from Facebook API (no webhook needed)
 * This polls all active leadgen forms and imports new leads
 */
async function syncFacebookLeads() {
  const config = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
  if (!config || !config.page_access_token || !config.default_landing_page_id) {
    return { synced: 0, error: 'Facebook not configured' };
  }

  // Get page ID from token
  let pageId;
  try {
    const meRes = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${config.page_access_token}`);
    const meData = await meRes.json();
    if (meData.error) return { synced: 0, error: meData.error.message };
    pageId = meData.id;
  } catch (e) {
    return { synced: 0, error: 'Failed to get page ID: ' + e.message };
  }
  let totalSynced = 0;
  let errors = [];

  try {
    // Get all active forms
    const formsRes = await fetch(
      `https://graph.facebook.com/v21.0/${pageId}/leadgen_forms?access_token=${config.page_access_token}&limit=50`
    );
    const formsData = await formsRes.json();
    if (formsData.error) {
      return { synced: 0, error: formsData.error.message };
    }

    const activeForms = (formsData.data || []).filter(f => f.status === 'ACTIVE');

    for (const form of activeForms) {
      try {
        // Fetch recent leads from each form (last 50)
        const leadsRes = await fetch(
          `https://graph.facebook.com/v21.0/${form.id}/leads?access_token=${config.page_access_token}&limit=50`
        );
        const leadsData = await leadsRes.json();
        if (leadsData.error) {
          errors.push(`Form ${form.name}: ${leadsData.error.message}`);
          continue;
        }

        for (const lead of leadsData.data || []) {
          // Check if already imported by fb_leadgen_id in hidden_fields
          const existing = db.prepare(
            `SELECT id FROM leads WHERE hidden_fields LIKE ?`
          ).get(`%"fb_leadgen_id":"${lead.id}"%`);

          if (existing) continue;

          // Map fields
          const fields = {};
          for (const item of lead.field_data || []) {
            const ourField = FIELD_MAP[item.name];
            if (ourField) {
              fields[ourField] = Array.isArray(item.values) ? item.values[0] : item.values;
            }
          }

          // Combine first + last name
          if (!fields.full_name && (fields._first_name || fields._last_name)) {
            fields.full_name = [fields._first_name, fields._last_name].filter(Boolean).join(' ');
          }

          // Generate unique eli_clickid
          const eliClickId = 'eli_' + crypto.randomBytes(12).toString('hex');

          // Build hidden fields
          const hiddenFields = {
            source: 'facebook_instant_form',
            fb_leadgen_id: lead.id,
            fb_form_id: form.id,
            fb_form_name: form.name,
            fb_created_time: lead.created_time || '',
            sync_method: 'api_poll'
          };

          // Add extra fields to hidden_fields
          for (const item of lead.field_data || []) {
            if (!FIELD_MAP[item.name]) {
              hiddenFields[item.name] = Array.isArray(item.values) ? item.values[0] : item.values;
            }
          }
          for (const [key, val] of Object.entries(fields)) {
            if (key.startsWith('_')) {
              hiddenFields[key.slice(1)] = val;
            }
          }

          // Insert lead with unique eli_clickid and fbclid
          const result = db.prepare(`
            INSERT INTO leads (
              landing_page_id, full_name, company_name, email, phone,
              debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, fbclid, hidden_fields
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
          `).run(
            config.default_landing_page_id,
            fields.full_name || '',
            fields.company_name || '',
            fields.email || '',
            fields.phone || '',
            fields.debt_amount || '',
            fields.has_mca || '',
            fields.considered_bankruptcy || '',
            eliClickId,
            '', // fbclid - not available from instant forms, stored when available from website clicks
            JSON.stringify(hiddenFields)
          );

          totalSynced++;
          console.log(`Facebook sync: imported lead ${result.lastInsertRowid} (${eliClickId}, fb_leadgen=${lead.id}) from "${form.name}"`);

          // Send notification
          if (sendLeadNotification) {
            const landingPage = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(config.default_landing_page_id);
            sendLeadNotification(fields, landingPage).catch(() => {});
          }

          // Auto-create "lead" conversion event
          try {
            const leadConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
            db.prepare(`
              INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_id, conversion_action_name, source, status)
              VALUES (?, ?, ?, 'lead', 'auto', 'logged')
            `).run(result.lastInsertRowid, eliClickId, leadConfig?.conversion_action_id || null);
          } catch (evtErr) {
            console.error('Failed to create lead event for synced FB lead:', evtErr);
          }

          // Send "Lead" event to Facebook CAPI
          try {
            const nameParts = (fields.full_name || '').trim().split(/\s+/);
            const firstName = fields._first_name || nameParts[0] || '';
            const lastName = fields._last_name || nameParts.slice(1).join(' ') || '';

            const fbResult = await sendFacebookEvent('Lead', {
              email: fields.email,
              phone: fields.phone,
              firstName,
              lastName
            }, {});

            db.prepare(`
              INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, source, status, error_message, sent_at, capi_payload)
              VALUES (?, ?, 'lead', NULL, 'facebook_capi', ?, ?, ${fbResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)
            `).run(
              result.lastInsertRowid,
              eliClickId,
              fbResult.success ? 'sent' : 'failed',
              fbResult.error || null,
              fbResult.payload ? JSON.stringify(fbResult.payload) : null
            );
            console.log(`Facebook CAPI Lead event for synced lead ${result.lastInsertRowid}: ${fbResult.success ? 'sent' : 'failed'}`);
          } catch (capiErr) {
            console.error('Failed to send Facebook CAPI Lead event for synced lead:', capiErr);
          }
        }
      } catch (formErr) {
        errors.push(`Form ${form.name}: ${formErr.message}`);
      }
    }
  } catch (err) {
    return { synced: totalSynced, error: err.message };
  }

  if (totalSynced > 0) {
    console.log(`Facebook sync complete: ${totalSynced} new leads imported`);
  }

  return { synced: totalSynced, errors: errors.length ? errors : undefined };
}

// Manual sync endpoint
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const result = await syncFacebookLeads();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Background sync - runs every 5 minutes
let syncInterval = null;
function startBackgroundSync() {
  if (syncInterval) return;
  syncInterval = setInterval(async () => {
    try {
      const config = db.prepare('SELECT page_access_token FROM facebook_config WHERE id = 1').get();
      if (config && config.page_access_token) {
        await syncFacebookLeads();
      }
    } catch (err) {
      console.error('Facebook background sync error:', err.message);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // Run first sync 10 seconds after startup
  setTimeout(async () => {
    try {
      const config = db.prepare('SELECT page_access_token FROM facebook_config WHERE id = 1').get();
      if (config && config.page_access_token) {
        console.log('Running initial Facebook lead sync...');
        const result = await syncFacebookLeads();
        if (result.synced > 0) {
          console.log(`Initial sync: imported ${result.synced} leads`);
        }
      }
    } catch (err) {
      console.error('Initial Facebook sync error:', err.message);
    }
  }, 10 * 1000);
}

// Migrate old leads that have fb_ prefix in eli_clickid — give them unique IDs
try {
  const oldLeads = db.prepare(`SELECT id, eli_clickid FROM leads WHERE eli_clickid LIKE 'fb_%'`).all();
  if (oldLeads.length > 0) {
    const update = db.prepare(`UPDATE leads SET eli_clickid = ? WHERE id = ?`);
    for (const lead of oldLeads) {
      const newEli = 'eli_' + crypto.randomBytes(12).toString('hex');
      update.run(newEli, lead.id);
    }
    // Also update conversion_events that reference old eli_clickids
    for (const lead of oldLeads) {
      const newEli = db.prepare(`SELECT eli_clickid FROM leads WHERE id = ?`).get(lead.id)?.eli_clickid;
      if (newEli) {
        db.prepare(`UPDATE conversion_events SET eli_clickid = ? WHERE eli_clickid = ?`).run(newEli, lead.eli_clickid);
      }
    }
    console.log(`Migrated ${oldLeads.length} leads from fb_ to unique eli_clickid`);
  }
} catch (err) {
  console.error('eli_clickid migration error:', err.message);
}

// Backfill "lead" conversion events for FB instant form leads that don't have one
try {
  const leadsWithoutEvent = db.prepare(`
    SELECT l.id, l.eli_clickid FROM leads l
    WHERE l.hidden_fields LIKE '%"source":"facebook_instant_form"%'
      AND NOT EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.lead_id = l.id AND ce.conversion_action_name = 'lead' AND ce.source = 'auto'
      )
  `).all();
  if (leadsWithoutEvent.length > 0) {
    const leadConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
    for (const lead of leadsWithoutEvent) {
      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_id, conversion_action_name, source, status)
        VALUES (?, ?, ?, 'lead', 'auto', 'logged')
      `).run(lead.id, lead.eli_clickid, leadConfig?.conversion_action_id || null);
    }
    console.log(`Backfilled "lead" events for ${leadsWithoutEvent.length} Facebook instant form leads`);
  }
} catch (err) {
  console.error('Lead event backfill error:', err.message);
}

// Start background sync
startBackgroundSync();

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

    // Check if already imported
    const existing = db.prepare(
      `SELECT id FROM leads WHERE hidden_fields LIKE ?`
    ).get(`%"fb_leadgen_id":"${leadgenId}"%`);
    if (existing) {
      console.log(`Facebook lead ${leadgenId} already exists (lead ID ${existing.id}), skipping`);
      return;
    }

    // Generate unique eli_clickid
    const eliClickId = 'eli_' + crypto.randomBytes(12).toString('hex');

    // Build hidden fields from unmapped data
    const hiddenFields = {
      source: 'facebook_instant_form',
      fb_leadgen_id: leadgenId,
      fb_form_id: data.form_id || '',
      fb_created_time: data.created_time || '',
      sync_method: 'webhook'
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
        debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, fbclid, hidden_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
    `).run(
      landingPageId,
      fields.full_name || '',
      fields.company_name || '',
      fields.email || '',
      fields.phone || '',
      fields.debt_amount || '',
      fields.has_mca || '',
      fields.considered_bankruptcy || '',
      eliClickId,
      '', // fbclid
      JSON.stringify(hiddenFields)
    );

    console.log(`Facebook lead inserted: ID ${result.lastInsertRowid} (${eliClickId})`);

    // Send lead notification email
    if (sendLeadNotification) {
      const landingPage = db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(landingPageId);
      sendLeadNotification(fields, landingPage).catch(() => {});
    }

    // Auto-create "lead" conversion event
    try {
      const leadConfig = db.prepare(`SELECT * FROM postback_config WHERE event_name = 'lead' AND is_active = 1`).get();
      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_id, conversion_action_name, source, status)
        VALUES (?, ?, ?, 'lead', 'auto', 'logged')
      `).run(result.lastInsertRowid, eliClickId, leadConfig?.conversion_action_id || null);
    } catch (err) {
      console.error('Failed to create lead event for FB lead:', err);
    }

    // Send "Lead" event to Facebook CAPI — Instant Form leads are always from Facebook
    // Note: Instant form leads come from Facebook directly, so no fbc/fbp/IP/UA available
    try {
      const nameParts = (fields.full_name || '').trim().split(/\s+/);
      const firstName = fields._first_name || nameParts[0] || '';
      const lastName = fields._last_name || nameParts.slice(1).join(' ') || '';

      const fbResult = await sendFacebookEvent('Lead', {
        email: fields.email,
        phone: fields.phone,
        firstName,
        lastName
      }, {});

      db.prepare(`
        INSERT INTO conversion_events (lead_id, eli_clickid, conversion_action_name, conversion_value, source, status, error_message, sent_at, capi_payload)
        VALUES (?, ?, 'lead', NULL, 'facebook_capi', ?, ?, ${fbResult.success ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?)
      `).run(
        result.lastInsertRowid,
        eliClickId,
        fbResult.success ? 'sent' : 'failed',
        fbResult.error || null,
        fbResult.payload ? JSON.stringify(fbResult.payload) : null
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
 * @param {object} userData - { email, phone, firstName, lastName, fbc, fbp, client_ip_address, client_user_agent }
 * @param {object} [options] - { value, currency, event_source_url, event_id }
 * @returns {Promise<{success: boolean, error?: string, event_id?: string}>}
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

    // Add match quality parameters (not hashed)
    if (userData.fbc) user_data.fbc = userData.fbc;
    if (userData.fbp) user_data.fbp = userData.fbp;
    if (userData.client_ip_address) user_data.client_ip_address = userData.client_ip_address;
    if (userData.client_user_agent) user_data.client_user_agent = userData.client_user_agent;

    // Generate event_id for deduplication if not provided
    const event_id = options.event_id || crypto.randomUUID();

    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id,
      user_data
    };

    // Add event_source_url if provided
    if (options.event_source_url) {
      eventData.event_source_url = options.event_source_url;
    }

    // Add custom_data if value is provided
    if (options.value !== undefined && options.value !== null) {
      eventData.custom_data = {
        value: parseFloat(options.value),
        currency: options.currency || 'USD'
      };
    }

    const requestBody = {
      data: [eventData],
      access_token: config.page_access_token
    };

    // Include test_event_code if configured
    if (config.test_event_code) {
      requestBody.test_event_code = config.test_event_code;
    }

    const response = await fetch(`https://graph.facebook.com/v21.0/${config.pixel_id}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const result = await response.json();

    // Build sanitized payload for debug storage (exclude access_token)
    const debugPayloadForError = {
      data: requestBody.data,
      test_event_code: requestBody.test_event_code || null
    };

    if (result.error) {
      console.error('Facebook CAPI error:', result.error.message);
      return { success: false, error: result.error.message, payload: debugPayloadForError };
    }

    // Build sanitized payload for debug storage (exclude access_token)
    const debugPayload = {
      data: requestBody.data,
      test_event_code: requestBody.test_event_code || null
    };

    console.log(`Facebook CAPI: sent "${eventName}" event, events_received: ${result.events_received}, event_id: ${event_id}`);
    return { success: true, events_received: result.events_received, event_id, payload: debugPayload };
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
  const { page_access_token, verify_token, app_id, app_secret, default_landing_page_id, pixel_id, ad_account_id, test_event_code } = req.body;

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
        test_event_code = ?,
        connected_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(page_access_token, verify_token, app_id || null, app_secret || null, default_landing_page_id || null, pixel_id || null, ad_account_id || null, test_event_code || null);
  } else {
    db.prepare(`
      INSERT INTO facebook_config (id, page_access_token, verify_token, app_id, app_secret, default_landing_page_id, pixel_id, ad_account_id, test_event_code, connected_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(page_access_token, verify_token, app_id || null, app_secret || null, default_landing_page_id || null, pixel_id || null, ad_account_id || null, test_event_code || null);
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'connected', 'facebook', null, 'Facebook config updated', req.ip);
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

/**
 * DEBUG: Get recent Facebook CAPI events with match quality info
 */
router.get('/debug/events', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, status, has_fbc } = req.query;
  const offset = (page - 1) * limit;

  let where = `WHERE ce.source = 'facebook_capi'`;
  const params = [];

  if (status) {
    where += ` AND ce.status = ?`;
    params.push(status);
  }

  const query = `
    SELECT ce.*, l.full_name, l.email, l.phone, l.eli_clickid as lead_eli,
           v.fbc, v.fbp, v.ip_address, v.user_agent, v.fbclid, v.landing_page
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    ${where}
    ORDER BY ce.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) as total FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    ${where}
  `;

  let events = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));
  const total = db.prepare(countQuery).get(...params).total;

  // Parse capi_payload and extract match quality fields
  events = events.map(e => {
    let payload = null;
    try { payload = e.capi_payload ? JSON.parse(e.capi_payload) : null; } catch (err) {}

    // Extract match quality from payload or visitor record
    const userData = payload?.data?.[0]?.user_data || {};
    return {
      ...e,
      capi_payload: payload,
      match_quality: {
        fbc: !!(userData.fbc || e.fbc),
        fbp: !!(userData.fbp || e.fbp),
        ip: !!(userData.client_ip_address || e.ip_address),
        ua: !!(userData.client_user_agent || e.user_agent),
        email: !!(userData.em),
        phone: !!(userData.ph),
        event_source_url: !!(payload?.data?.[0]?.event_source_url)
      }
    };
  });

  // Filter by has_fbc after processing
  if (has_fbc === 'yes') {
    events = events.filter(e => e.match_quality.fbc);
  } else if (has_fbc === 'no') {
    events = events.filter(e => !e.match_quality.fbc);
  }

  // Summary stats (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const statsRows = db.prepare(`
    SELECT ce.status, ce.capi_payload,
           v.fbc, v.fbp, v.ip_address, v.user_agent
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE ce.source = 'facebook_capi' AND ce.created_at >= ?
  `).all(thirtyDaysAgo.toISOString());

  let totalEvents = statsRows.length;
  let sentCount = 0, failedCount = 0, withFbc = 0, withFbp = 0, withIpUa = 0;
  for (const row of statsRows) {
    if (row.status === 'sent') sentCount++;
    if (row.status === 'failed') failedCount++;
    let p = null;
    try { p = row.capi_payload ? JSON.parse(row.capi_payload) : null; } catch (err) {}
    const ud = p?.data?.[0]?.user_data || {};
    if (ud.fbc || row.fbc) withFbc++;
    if (ud.fbp || row.fbp) withFbp++;
    if ((ud.client_ip_address || row.ip_address) && (ud.client_user_agent || row.user_agent)) withIpUa++;
  }

  res.json({
    events,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    summary: {
      total_events: totalEvents,
      sent: sentCount,
      failed: failedCount,
      pct_fbc: totalEvents ? Math.round((withFbc / totalEvents) * 100) : 0,
      pct_fbp: totalEvents ? Math.round((withFbp / totalEvents) * 100) : 0,
      pct_ip_ua: totalEvents ? Math.round((withIpUa / totalEvents) * 100) : 0
    }
  });
});

/**
 * DEBUG: Look up a specific lead's Facebook CAPI data
 */
router.get('/debug/lead/:id', authenticateToken, (req, res) => {
  const identifier = req.params.id;

  // Try by lead ID first, then by eli_clickid
  let lead = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.platform
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE l.id = ?
  `).get(identifier);

  if (!lead) {
    lead = db.prepare(`
      SELECT l.*, lp.name as landing_page_name, lp.platform
      FROM leads l
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      WHERE l.eli_clickid = ?
    `).get(identifier);
  }

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  try { lead.hidden_fields = JSON.parse(lead.hidden_fields || '{}'); } catch (e) { lead.hidden_fields = {}; }

  // Get visitor record
  const visitor = lead.eli_clickid
    ? db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(lead.eli_clickid)
    : null;

  // Get all Facebook CAPI events for this lead
  let fbEvents = db.prepare(`
    SELECT * FROM conversion_events
    WHERE lead_id = ? AND source = 'facebook_capi'
    ORDER BY created_at DESC
  `).all(lead.id);

  fbEvents = fbEvents.map(e => {
    let payload = null;
    try { payload = e.capi_payload ? JSON.parse(e.capi_payload) : null; } catch (err) {}
    return { ...e, capi_payload: payload };
  });

  // Build match quality checklist
  const nameParts = (lead.full_name || '').trim().split(/\s+/);
  const matchChecklist = {
    email: { present: !!lead.email, value: lead.email ? '***' : null },
    phone: { present: !!lead.phone, value: lead.phone ? '***' : null },
    fbc: { present: !!(visitor?.fbc), value: visitor?.fbc || null },
    fbp: { present: !!(visitor?.fbp), value: visitor?.fbp || null },
    fbclid: { present: !!(visitor?.fbclid), value: visitor?.fbclid || null },
    client_ip: { present: !!(visitor?.ip_address), value: visitor?.ip_address || null },
    client_ua: { present: !!(visitor?.user_agent), value: visitor?.user_agent ? visitor.user_agent.substring(0, 80) + '...' : null },
    event_source_url: { present: !!(visitor?.landing_page), value: visitor?.landing_page || null },
    first_name: { present: !!(nameParts[0]), value: nameParts[0] || null },
    last_name: { present: !!(nameParts.slice(1).join(' ')), value: nameParts.slice(1).join(' ') || null }
  };

  res.json({
    lead,
    visitor: visitor ? {
      eli_clickid: visitor.eli_clickid,
      fbc: visitor.fbc,
      fbp: visitor.fbp,
      fbclid: visitor.fbclid,
      ip_address: visitor.ip_address,
      user_agent: visitor.user_agent,
      landing_page: visitor.landing_page,
      utm_source: visitor.utm_source,
      utm_campaign: visitor.utm_campaign,
      first_visit: visitor.first_visit
    } : null,
    fb_events: fbEvents,
    match_checklist: matchChecklist
  });
});

/**
 * DEBUG: Send a manual test event to Facebook CAPI
 */
router.post('/debug/test-event', authenticateToken, async (req, res) => {
  const { email, phone, first_name, last_name, fbc, fbp, event_name, client_ip, client_ua, event_source_url } = req.body;

  if (!event_name) {
    return res.status(400).json({ error: 'event_name is required' });
  }

  const result = await sendFacebookEvent(event_name, {
    email: email || '',
    phone: phone || '',
    firstName: first_name || '',
    lastName: last_name || '',
    fbc: fbc || '',
    fbp: fbp || '',
    client_ip_address: client_ip || '',
    client_user_agent: client_ua || ''
  }, {
    event_source_url: event_source_url || ''
  });

  res.json({
    success: result.success,
    error: result.error || null,
    event_id: result.event_id || null,
    events_received: result.events_received || null,
    payload_sent: result.payload || null,
    facebook_response: result.success
      ? { events_received: result.events_received }
      : { error: result.error }
  });
});

module.exports = router;
module.exports.sendFacebookEvent = sendFacebookEvent;
