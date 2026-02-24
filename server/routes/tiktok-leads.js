const express = require('express');
const crypto = require('crypto');
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

// Field mapping: TikTok field name -> our field name
const FIELD_MAP = {
  full_name: '_full_name',
  name: '_full_name',
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'email',
  phone_number: 'phone',
  phone: 'phone',
  company_name: 'company_name',
  company: 'company_name',
  how_much_debt: 'debt_amount',
  debt_amount: 'debt_amount',
  has_mca: 'has_mca',
  considered_bankruptcy: 'considered_bankruptcy',
  city: '_city',
  state: '_state',
  zip_code: '_zip',
  street_address: '_street'
};

/**
 * GET /config — Returns current TikTok config (authenticated)
 */
router.get('/config', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT * FROM tiktok_config WHERE id = 1').get();
  if (!config) return res.json({});
  // Mask access_token and app_secret for security
  res.json({
    ...config,
    access_token: config.access_token ? '••••' + config.access_token.slice(-6) : null,
    has_access_token: !!config.access_token,
    app_id: config.app_id || '',
    app_secret: config.app_secret ? '••••' + config.app_secret.slice(-4) : null,
    has_app_secret: !!config.app_secret
  });
});

/**
 * GET /connect — Generate TikTok OAuth authorization URL
 */
router.get('/connect', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT app_id FROM tiktok_config WHERE id = 1').get();
  if (!config || !config.app_id) {
    return res.status(400).json({ error: 'Save your TikTok App ID first' });
  }

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = baseUrl.replace(/\/$/, '');

  const authUrl = `https://business-api.tiktok.com/portal/auth?app_id=${encodeURIComponent(config.app_id)}&state=tiktok_oauth&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.json({ auth_url: authUrl });
});

/**
 * GET /callback — OAuth callback: exchange auth_code for access_token
 */
router.get('/callback', async (req, res) => {
  const { auth_code } = req.query;

  if (!auth_code) {
    return res.redirect('/admin/settings.html?tiktok_error=no_auth_code');
  }

  const config = db.prepare('SELECT app_id, app_secret FROM tiktok_config WHERE id = 1').get();
  if (!config || !config.app_id || !config.app_secret) {
    return res.redirect('/admin/settings.html?tiktok_error=missing_app_credentials');
  }

  try {
    const tokenResponse = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.app_id,
        secret: config.app_secret,
        auth_code: auth_code
      })
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.code !== 0 || !tokenData.data?.access_token) {
      const errMsg = tokenData.message || 'Token exchange failed';
      console.error('TikTok OAuth error:', errMsg, tokenData);
      return res.redirect('/admin/settings.html?tiktok_error=' + encodeURIComponent(errMsg));
    }

    const accessToken = tokenData.data.access_token;
    const advertiserId = tokenData.data.advertiser_ids?.[0] || null;

    // Save the access token
    const existing = db.prepare('SELECT id FROM tiktok_config WHERE id = 1').get();
    if (existing) {
      const updates = ['access_token = ?', 'connected_at = CURRENT_TIMESTAMP'];
      const params = [accessToken];

      // Auto-fill advertiser_id if we got one and none is set
      if (advertiserId) {
        const currentConfig = db.prepare('SELECT advertiser_id FROM tiktok_config WHERE id = 1').get();
        if (!currentConfig.advertiser_id) {
          updates.push('advertiser_id = ?');
          params.push(advertiserId);
        }
      }

      db.prepare(`UPDATE tiktok_config SET ${updates.join(', ')} WHERE id = 1`).run(...params);
    } else {
      db.prepare(`
        INSERT INTO tiktok_config (id, access_token, advertiser_id, connected_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
      `).run(accessToken, advertiserId);
    }

    if (logActivity) logActivity(null, 'System', 'connected', 'tiktok', null, 'TikTok connected via OAuth', null);
    console.log('TikTok OAuth: access token saved successfully');
    res.redirect('/admin/settings.html?tiktok_connected=true');
  } catch (err) {
    console.error('TikTok OAuth callback error:', err);
    res.redirect('/admin/settings.html?tiktok_error=token_exchange_failed');
  }
});

/**
 * POST /config — Saves TikTok config (authenticated)
 */
router.post('/config', authenticateToken, (req, res) => {
  const { access_token, advertiser_id, default_landing_page_id, app_id, app_secret } = req.body;

  const existing = db.prepare('SELECT id FROM tiktok_config WHERE id = 1').get();

  if (existing) {
    const updates = [];
    const params = [];

    // Only update access_token if a new one is provided (not masked)
    if (access_token && !access_token.startsWith('••••')) {
      updates.push('access_token = ?');
      params.push(access_token);
    }

    // Only update app_secret if a new one is provided (not masked)
    if (app_secret && !app_secret.startsWith('••••')) {
      updates.push('app_secret = ?');
      params.push(app_secret);
    }

    updates.push('advertiser_id = ?', 'default_landing_page_id = ?', 'app_id = ?', 'connected_at = CURRENT_TIMESTAMP');
    params.push(advertiser_id || null, default_landing_page_id || null, app_id || null);

    db.prepare(`UPDATE tiktok_config SET ${updates.join(', ')} WHERE id = 1`).run(...params);
  } else {
    db.prepare(`
      INSERT INTO tiktok_config (id, access_token, advertiser_id, default_landing_page_id, app_id, app_secret, connected_at)
      VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(access_token || null, advertiser_id || null, default_landing_page_id || null, app_id || null, app_secret || null);
  }

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'connected', 'tiktok', null, 'TikTok config updated', req.ip);
  res.json({ message: 'Config saved' });
});

/**
 * Helper: process a single lead from either webhook or API poll
 */
function processLead(leadData, source) {
  const config = db.prepare('SELECT * FROM tiktok_config WHERE id = 1').get();

  const tiktokLeadId = leadData.lead_id || leadData.id || ('wh_' + crypto.randomBytes(8).toString('hex'));

  // Deduplicate
  const existing = db.prepare(
    `SELECT id FROM leads WHERE hidden_fields LIKE ?`
  ).get(`%"tiktok_lead_id":"${tiktokLeadId}"%`);
  if (existing) return { duplicate: true };

  // Extract fields - handle multiple payload formats
  const fields = {};
  const extraFields = {};

  // Format 1: fields as array of {name, value} (API poll + some webhooks)
  const leadFields = leadData.fields || leadData.field_data || leadData.user_info || [];
  if (Array.isArray(leadFields)) {
    for (const item of leadFields) {
      const fieldName = (item.name || item.key || '').toLowerCase().trim();
      const fieldValue = item.value || (Array.isArray(item.values) ? item.values[0] : '');
      const ourField = FIELD_MAP[fieldName];
      if (ourField) {
        fields[ourField] = fieldValue;
      } else if (fieldName) {
        extraFields[fieldName] = fieldValue;
      }
    }
  } else if (typeof leadFields === 'object' && leadFields !== null) {
    // Format 2: fields as flat object {email: "...", phone: "..."}
    for (const [key, val] of Object.entries(leadFields)) {
      const fieldName = key.toLowerCase().trim();
      const fieldValue = typeof val === 'string' ? val : (val?.value || String(val));
      const ourField = FIELD_MAP[fieldName];
      if (ourField) {
        fields[ourField] = fieldValue;
      } else if (fieldName) {
        extraFields[fieldName] = fieldValue;
      }
    }
  }

  // Format 3: top-level fields (some webhook formats put fields at root)
  for (const [key, val] of Object.entries(leadData)) {
    if (['lead_id', 'id', 'form_id', 'form_name', 'ad_id', 'campaign_id', 'advertiser_id',
         'create_time', 'created_time', 'fields', 'field_data', 'user_info', 'event_type'].includes(key)) continue;
    const fieldName = key.toLowerCase().trim();
    const ourField = FIELD_MAP[fieldName];
    if (ourField && !fields[ourField]) {
      fields[ourField] = typeof val === 'string' ? val : String(val);
    }
  }

  // Derive first_name/last_name from full_name if needed
  if (!fields.first_name && !fields.last_name && fields._full_name) {
    const parts = fields._full_name.trim().split(/\s+/);
    fields.first_name = parts[0] || '';
    fields.last_name = parts.slice(1).join(' ') || '';
  }

  const eliClickId = 'eli_' + crypto.randomBytes(12).toString('hex');

  const hiddenFields = {
    source: 'tiktok_lead_gen',
    tiktok_lead_id: tiktokLeadId,
    tiktok_form_id: leadData.form_id || '',
    tiktok_form_name: leadData.form_name || leadData.tiktok_task_name || '',
    tiktok_ad_id: leadData.ad_id || '',
    tiktok_campaign_id: leadData.campaign_id || '',
    sync_method: source,
    ...extraFields
  };

  // Move underscore-prefixed mapped fields into hidden_fields
  for (const [key, val] of Object.entries(fields)) {
    if (key.startsWith('_')) {
      hiddenFields[key.slice(1)] = val;
    }
  }

  const fullName = [fields.first_name, fields.last_name].filter(Boolean).join(' ');

  let createdAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  if (leadData.create_time || leadData.created_time) {
    try {
      const ts = leadData.create_time || leadData.created_time;
      const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
      if (!isNaN(d.getTime())) {
        createdAt = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      }
    } catch (e) {}
  }

  const result = db.prepare(`
    INSERT INTO leads (
      landing_page_id, full_name, first_name, last_name, company_name, email, phone,
      debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, hidden_fields, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)
  `).run(
    config?.default_landing_page_id || null,
    fullName,
    fields.first_name || '',
    fields.last_name || '',
    fields.company_name || '',
    fields.email || '',
    fields.phone || '',
    fields.debt_amount || '',
    fields.has_mca || '',
    fields.considered_bankruptcy || '',
    eliClickId,
    JSON.stringify(hiddenFields),
    createdAt
  );

  console.log(`TikTok ${source}: imported lead ${result.lastInsertRowid} (${eliClickId}, tiktok_lead=${tiktokLeadId})`);

  // Send notification
  if (sendLeadNotification) {
    const landingPage = config?.default_landing_page_id
      ? db.prepare('SELECT * FROM landing_pages WHERE id = ?').get(config.default_landing_page_id)
      : { name: 'TikTok Lead Gen Form', platform: 'tiktok' };
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
    console.error('Failed to create lead event for TikTok lead:', evtErr);
  }

  return { imported: true, leadId: result.lastInsertRowid, eliClickId };
}

/**
 * POST /webhook — Receive leads from TikTok Instant Form (Custom API webhook)
 * Configure this URL in TikTok Ads Manager → Lead Gen Form → CRM → Custom API
 */
router.post('/webhook', (req, res) => {
  // Always respond 200 immediately so TikTok doesn't retry
  res.status(200).json({ code: 0, message: 'ok' });

  const payload = req.body;
  console.log('TikTok webhook received:', JSON.stringify(payload).slice(0, 2000));

  try {
    // Handle different payload structures
    // Structure 1: single lead object
    // Structure 2: array of leads
    // Structure 3: nested under data/leads key
    let leads = [];

    if (Array.isArray(payload)) {
      leads = payload;
    } else if (payload.leads && Array.isArray(payload.leads)) {
      leads = payload.leads;
    } else if (payload.data?.leads && Array.isArray(payload.data.leads)) {
      leads = payload.data.leads;
    } else if (payload.lead_id || payload.id || payload.fields || payload.field_data || payload.user_info) {
      leads = [payload];
    } else if (payload.data && (payload.data.lead_id || payload.data.fields)) {
      leads = [payload.data];
    } else {
      // Unknown format — treat entire payload as a single lead
      console.log('TikTok webhook: unknown payload format, treating as single lead');
      leads = [payload];
    }

    let imported = 0;
    for (const lead of leads) {
      try {
        const result = processLead(lead, 'webhook');
        if (result.imported) imported++;
      } catch (err) {
        console.error('TikTok webhook: error processing lead:', err.message);
      }
    }

    if (imported > 0) {
      console.log(`TikTok webhook: imported ${imported} lead(s)`);
    }
  } catch (err) {
    console.error('TikTok webhook processing error:', err);
  }
});

/**
 * GET /webhook-url — Returns the webhook URL to configure in TikTok (authenticated)
 */
router.get('/webhook-url', authenticateToken, (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/tiktok-leads/webhook`;
  res.json({ webhook_url: webhookUrl });
});

/**
 * Core sync function: fetch leads from TikTok Business API
 * Uses the Leads API: get form libraries, then create download task + download leads
 */
async function syncTikTokLeads() {
  const config = db.prepare('SELECT * FROM tiktok_config WHERE id = 1').get();
  if (!config || !config.access_token) {
    return { synced: 0, error: 'TikTok not configured (missing access token)' };
  }
  if (!config.advertiser_id) {
    return { synced: 0, error: 'TikTok Advertiser ID not configured' };
  }

  const headers = {
    'Access-Token': config.access_token,
    'Content-Type': 'application/json'
  };

  let synced = 0;
  const errors = [];

  try {
    // Step 1: Get form libraries (list all instant forms)
    const formsUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/lead/form/get/');
    formsUrl.searchParams.set('advertiser_id', config.advertiser_id);
    formsUrl.searchParams.set('page_size', '100');

    console.log('TikTok sync: fetching form libraries...');
    const formsRes = await fetch(formsUrl.toString(), { headers });
    const formsData = await formsRes.json();
    console.log('TikTok forms response:', JSON.stringify(formsData).slice(0, 500));

    if (formsData.code !== 0) {
      const errMsg = formsData.message || 'API error (code: ' + formsData.code + ')';
      console.error('TikTok forms API error:', errMsg);
      return { synced: 0, error: errMsg };
    }

    const forms = formsData.data?.list || formsData.data?.forms || [];
    if (!forms.length) {
      return { synced: 0, message: 'No lead gen forms found' };
    }

    console.log(`TikTok sync: found ${forms.length} form(s)`);

    // Step 2: For each form, create a download task and fetch leads
    for (const form of forms) {
      const formId = form.form_id || form.id || form.page_id;
      const formName = form.form_name || form.name || form.page_name || '';
      if (!formId) continue;

      try {
        // Create a lead download task
        console.log(`TikTok sync: creating download task for form "${formName}" (${formId})...`);
        const taskRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/lead/task/create/', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            advertiser_id: config.advertiser_id,
            form_id: formId
          })
        });
        const taskData = await taskRes.json();
        console.log('TikTok download task response:', JSON.stringify(taskData).slice(0, 500));

        if (taskData.code !== 0) {
          errors.push(`Form ${formId}: ${taskData.message || 'Failed to create download task'}`);
          continue;
        }

        const taskId = taskData.data?.task_id;
        if (!taskId) {
          errors.push(`Form ${formId}: No task_id returned`);
          continue;
        }

        // Wait briefly for the task to process
        await new Promise(r => setTimeout(r, 2000));

        // Download leads from the task
        const downloadUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/lead/task/download/');
        downloadUrl.searchParams.set('advertiser_id', config.advertiser_id);
        downloadUrl.searchParams.set('task_id', taskId);

        const downloadRes = await fetch(downloadUrl.toString(), { headers });
        const downloadData = await downloadRes.json();
        console.log('TikTok download response:', JSON.stringify(downloadData).slice(0, 500));

        if (downloadData.code !== 0) {
          errors.push(`Form ${formId} download: ${downloadData.message || 'Download failed'}`);
          continue;
        }

        const leads = downloadData.data?.list || downloadData.data?.leads || [];
        console.log(`TikTok sync: form "${formName}" returned ${leads.length} lead(s)`);

        for (const lead of leads) {
          if (!lead.lead_id && !lead.id) continue;
          lead.form_id = formId;
          lead.form_name = formName;
          try {
            const result = processLead(lead, 'api_poll');
            if (result.imported) synced++;
          } catch (err) {
            if (!err.message?.includes('duplicate')) {
              errors.push(`Lead ${lead.lead_id || lead.id}: ${err.message}`);
            }
          }
        }
      } catch (formErr) {
        errors.push(`Form ${formId}: ${formErr.message}`);
      }
    }
  } catch (err) {
    console.error('TikTok sync error:', err);
    return { synced, error: err.message, errors: errors.length ? errors : undefined };
  }

  if (synced > 0) {
    console.log(`TikTok sync complete: ${synced} new leads imported`);
  }
  return { synced, message: synced === 0 ? 'No new leads found' : undefined, errors: errors.length ? errors : undefined };
}

/**
 * POST /sync — Manual sync trigger (authenticated)
 */
router.post('/sync', authenticateToken, async (req, res) => {
  try {
    const result = await syncTikTokLeads();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Background sync - poll every 5 minutes
let syncInterval = null;
function startBackgroundSync() {
  if (syncInterval) return;
  syncInterval = setInterval(async () => {
    try {
      const config = db.prepare('SELECT access_token FROM tiktok_config WHERE id = 1').get();
      if (config && config.access_token) {
        await syncTikTokLeads();
      }
    } catch (err) {
      console.error('TikTok background sync error:', err.message);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // Run first sync 15 seconds after startup
  setTimeout(async () => {
    try {
      const config = db.prepare('SELECT access_token FROM tiktok_config WHERE id = 1').get();
      if (config && config.access_token) {
        console.log('Running initial TikTok lead sync...');
        const result = await syncTikTokLeads();
        if (result.synced > 0) {
          console.log(`TikTok initial sync: imported ${result.synced} leads`);
        }
      }
    } catch (err) {
      console.error('TikTok initial sync error:', err.message);
    }
  }, 15 * 1000);
}

// Start background sync
startBackgroundSync();

module.exports = router;
