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
    has_app_secret: !!config.app_secret,
    pixel_code: config.pixel_code || '',
    test_event_code: config.test_event_code || ''
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
  const { access_token, advertiser_id, default_landing_page_id, app_id, app_secret, pixel_code, test_event_code } = req.body;

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

    updates.push('advertiser_id = ?', 'default_landing_page_id = ?', 'app_id = ?', 'pixel_code = ?', 'test_event_code = ?', 'connected_at = CURRENT_TIMESTAMP');
    params.push(advertiser_id || null, default_landing_page_id || null, app_id || null, pixel_code || null, test_event_code || null);

    db.prepare(`UPDATE tiktok_config SET ${updates.join(', ')} WHERE id = 1`).run(...params);
  } else {
    db.prepare(`
      INSERT INTO tiktok_config (id, access_token, advertiser_id, default_landing_page_id, app_id, app_secret, pixel_code, test_event_code, connected_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(access_token || null, advertiser_id || null, default_landing_page_id || null, app_id || null, app_secret || null, pixel_code || null, test_event_code || null);
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
 * Parse CSV text into array of objects using header row as keys
 */
function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]?.trim()?.toLowerCase()] = values[j]?.trim() || '';
    }
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Core sync function: fetch leads from TikTok Business API
 * Uses: GET /page/get/ to list forms, then POST /page/lead/task/ + GET /page/lead/task/download/
 * Also tries direct GET /lead/get/ endpoint for newer API access
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
    // Step 1: List all instant forms via /page/get/
    const formsUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/page/get/');
    formsUrl.searchParams.set('advertiser_id', config.advertiser_id);
    formsUrl.searchParams.set('page_size', '100');

    console.log('TikTok sync: fetching instant forms...');
    const formsRes = await fetch(formsUrl.toString(), { headers });
    const formsData = await formsRes.json();
    console.log('TikTok forms response:', JSON.stringify(formsData).slice(0, 1000));

    if (formsData.code !== 0) {
      const errMsg = formsData.message || 'API error (code: ' + formsData.code + ')';
      console.error('TikTok forms API error:', errMsg);
      return { synced: 0, error: errMsg };
    }

    const forms = formsData.data?.list || formsData.data?.pages || formsData.data?.forms || [];
    if (!forms.length) {
      return { synced: 0, message: 'No lead gen forms found for this advertiser' };
    }

    console.log(`TikTok sync: found ${forms.length} form(s)`);

    // Step 2: For each form, try direct lead access first, then fall back to task-based download
    for (const form of forms) {
      const pageId = form.page_id || form.form_id || form.id;
      const formName = form.page_name || form.form_name || form.name || form.title || '';
      if (!pageId) continue;

      console.log(`TikTok sync: processing form "${formName}" (page_id: ${pageId})`);

      // Method A: Try direct lead access via /lead/get/
      try {
        const leadUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/lead/get/');
        leadUrl.searchParams.set('advertiser_id', config.advertiser_id);
        leadUrl.searchParams.set('page_id', pageId);
        leadUrl.searchParams.set('lead_source', 'INSTANT_FORM');

        const leadRes = await fetch(leadUrl.toString(), { headers });
        const leadData = await leadRes.json();
        console.log(`TikTok lead/get response for ${pageId}:`, JSON.stringify(leadData).slice(0, 500));

        if (leadData.code === 0 && leadData.data) {
          const leads = leadData.data?.list || leadData.data?.leads || [];
          if (Array.isArray(leads) && leads.length > 0) {
            console.log(`TikTok sync (direct): form "${formName}" returned ${leads.length} lead(s)`);
            for (const lead of leads) {
              lead.form_id = pageId;
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
            continue; // Direct method worked, skip task-based for this form
          }
        }
      } catch (directErr) {
        console.log(`TikTok sync: direct /lead/get/ failed for ${pageId}, trying task-based download...`, directErr.message);
      }

      // Method B: Task-based download (create task -> poll -> download CSV)
      try {
        console.log(`TikTok sync: creating download task for form "${formName}" (${pageId})...`);
        const taskRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/page/lead/task/', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            advertiser_id: config.advertiser_id,
            page_id: pageId
          })
        });
        const taskData = await taskRes.json();
        console.log('TikTok task response:', JSON.stringify(taskData).slice(0, 500));

        if (taskData.code !== 0) {
          errors.push(`Form ${pageId}: ${taskData.message || 'Failed to create download task'}`);
          continue;
        }

        const taskId = taskData.data?.task_id;
        if (!taskId) {
          errors.push(`Form ${pageId}: No task_id returned`);
          continue;
        }

        // Poll task status until SUCCEED (max 30 seconds)
        let taskReady = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(r => setTimeout(r, 3000));

          const pollRes = await fetch('https://business-api.tiktok.com/open_api/v1.3/page/lead/task/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              advertiser_id: config.advertiser_id,
              page_id: pageId,
              task_id: taskId
            })
          });
          const pollData = await pollRes.json();

          const status = pollData.data?.status || pollData.data?.task_status;
          console.log(`TikTok task ${taskId} status: ${status} (attempt ${attempt + 1})`);

          if (status === 'SUCCEED' || status === 'SUCCESS' || status === 'COMPLETED') {
            taskReady = true;
            break;
          }
          if (status === 'FAILED' || status === 'ERROR') {
            errors.push(`Form ${pageId}: Download task failed`);
            break;
          }
        }

        if (!taskReady) {
          if (!errors.some(e => e.includes(pageId))) {
            errors.push(`Form ${pageId}: Download task timed out`);
          }
          continue;
        }

        // Download leads CSV
        const downloadUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/page/lead/task/download/');
        downloadUrl.searchParams.set('advertiser_id', config.advertiser_id);
        downloadUrl.searchParams.set('task_id', taskId);

        const downloadRes = await fetch(downloadUrl.toString(), { headers });
        const contentType = downloadRes.headers.get('content-type') || '';

        if (contentType.includes('json')) {
          // JSON response (might be error or structured data)
          const downloadData = await downloadRes.json();
          console.log('TikTok download JSON response:', JSON.stringify(downloadData).slice(0, 500));

          if (downloadData.code !== 0) {
            errors.push(`Form ${pageId} download: ${downloadData.message || 'Download failed'}`);
            continue;
          }

          const leads = downloadData.data?.list || downloadData.data?.leads || [];
          for (const lead of leads) {
            lead.form_id = pageId;
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
        } else {
          // CSV/text response
          const csvText = await downloadRes.text();
          console.log(`TikTok download: received ${csvText.length} bytes of CSV data`);

          const rows = parseCSV(csvText);
          console.log(`TikTok sync: parsed ${rows.length} lead(s) from CSV for form "${formName}"`);

          for (const row of rows) {
            // CSV rows have headers as keys, map them to our lead format
            const leadObj = {
              lead_id: row.lead_id || row.id || ('csv_' + crypto.randomBytes(6).toString('hex')),
              form_id: pageId,
              form_name: formName,
              create_time: row.create_time || row.created_time || row.submit_time,
              // Flatten CSV columns as field data
              fields: Object.entries(row)
                .filter(([k]) => !['lead_id', 'id', 'create_time', 'created_time', 'submit_time'].includes(k))
                .map(([name, value]) => ({ name, value }))
            };

            try {
              const result = processLead(leadObj, 'api_poll');
              if (result.imported) synced++;
            } catch (err) {
              if (!err.message?.includes('duplicate')) {
                errors.push(`CSV lead: ${err.message}`);
              }
            }
          }
        }
      } catch (taskErr) {
        errors.push(`Form ${pageId}: ${taskErr.message}`);
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

/**
 * Send a conversion event to TikTok Events API
 *
 * @param {string} eventName - e.g. "CompletePayment", "SubmitForm", "Contact"
 * @param {object} userData - { email, phone, external_id, client_ip_address, client_user_agent }
 * @param {object} [options] - { value, currency, event_source_url, event_id }
 * @returns {Promise<{success: boolean, error?: string, event_id?: string, payload?: object}>}
 */
async function sendTikTokEvent(eventName, userData, options = {}) {
  try {
    const config = db.prepare('SELECT * FROM tiktok_config WHERE id = 1').get();
    if (!config || !config.access_token || !config.pixel_code) {
      return { success: false, error: 'TikTok Events API not configured (missing access_token or pixel_code)' };
    }

    // Hash helper - SHA256, lowercase, trimmed
    const hash = (val) => {
      if (!val) return null;
      return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
    };

    // Normalize phone to digits only
    const normalizePhone = (phone) => {
      if (!phone) return null;
      return phone.replace(/\D/g, '') || null;
    };

    const event_id = options.event_id || crypto.randomUUID();
    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');

    // Build context.user with hashed fields
    const user = {};
    if (userData.email) user.email = hash(userData.email);
    if (userData.phone) user.phone_number = hash(normalizePhone(userData.phone));
    if (userData.external_id) user.external_id = hash(userData.external_id);

    const context = { user };
    if (options.event_source_url) {
      context.page = { url: options.event_source_url };
    }
    if (userData.client_ip_address) context.ip = userData.client_ip_address;
    if (userData.client_user_agent) context.user_agent = userData.client_user_agent;

    const body = {
      pixel_code: config.pixel_code,
      event: eventName,
      event_id,
      timestamp,
      context,
      properties: {}
    };

    if (options.value !== undefined && options.value !== null) {
      body.properties.value = parseFloat(options.value);
      body.properties.currency = options.currency || 'USD';
    }
    body.properties.content_type = 'product';

    // Include test_event_code if configured
    if (config.test_event_code) {
      body.test_event_code = config.test_event_code;
    }

    const response = await fetch('https://business-api.tiktok.com/open_api/v1.2/pixel/track/', {
      method: 'POST',
      headers: {
        'Access-Token': config.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result = await response.json();

    // Build sanitized payload for debug storage (exclude access_token)
    const debugPayload = { ...body };

    if (result.code !== 0) {
      console.error('TikTok Events API error:', result.message);
      return { success: false, error: result.message || 'TikTok API error (code: ' + result.code + ')', event_id, payload: debugPayload };
    }

    console.log(`TikTok Events API: sent "${eventName}" event, event_id: ${event_id}`);
    return { success: true, event_id, payload: debugPayload };
  } catch (err) {
    console.error('TikTok Events API request failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * DEBUG: Get recent TikTok CAPI events with match quality info
 */
router.get('/debug/events', authenticateToken, (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const offset = (page - 1) * limit;

  let where = `WHERE ce.source = 'tiktok_capi'`;
  const params = [];

  if (status) {
    where += ` AND ce.status = ?`;
    params.push(status);
  }

  const query = `
    SELECT ce.*, l.first_name, l.last_name, l.email, l.phone, l.eli_clickid as lead_eli,
           v.ip_address, v.user_agent, v.landing_page
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
    ${where}
  `;

  let events = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));
  const total = db.prepare(countQuery).get(...params).total;

  // Parse capi_payload and extract match quality fields
  events = events.map(e => {
    let payload = null;
    try { payload = e.capi_payload ? JSON.parse(e.capi_payload) : null; } catch (err) {}

    const ctx = payload?.context || {};
    const user = ctx.user || {};
    return {
      ...e,
      capi_payload: payload,
      match_quality: {
        email: !!user.email,
        phone: !!user.phone_number,
        external_id: !!user.external_id,
        ip: !!(ctx.ip || e.ip_address),
        ua: !!(ctx.user_agent || e.user_agent),
        event_source_url: !!(ctx.page?.url)
      }
    };
  });

  // Summary stats (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const statsRows = db.prepare(`
    SELECT ce.status, ce.capi_payload,
           v.ip_address, v.user_agent
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE ce.source = 'tiktok_capi' AND ce.created_at >= ?
  `).all(thirtyDaysAgoStr);

  let totalEvents = statsRows.length;
  let sentCount = 0, failedCount = 0, withEmail = 0, withPhone = 0, withIpUa = 0, withExternalId = 0;
  for (const row of statsRows) {
    if (row.status === 'sent') sentCount++;
    if (row.status === 'failed') failedCount++;
    let p = null;
    try { p = row.capi_payload ? JSON.parse(row.capi_payload) : null; } catch (err) {}
    const ctx = p?.context || {};
    const user = ctx.user || {};
    if (user.email) withEmail++;
    if (user.phone_number) withPhone++;
    if (user.external_id) withExternalId++;
    if ((ctx.ip || row.ip_address) && (ctx.user_agent || row.user_agent)) withIpUa++;
  }

  res.json({
    events,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    summary: {
      total_events: totalEvents,
      sent: sentCount,
      failed: failedCount,
      pct_email: totalEvents ? Math.round((withEmail / totalEvents) * 100) : 0,
      pct_phone: totalEvents ? Math.round((withPhone / totalEvents) * 100) : 0,
      pct_external_id: totalEvents ? Math.round((withExternalId / totalEvents) * 100) : 0,
      pct_ip_ua: totalEvents ? Math.round((withIpUa / totalEvents) * 100) : 0
    }
  });
});

/**
 * DEBUG: Look up a specific lead's TikTok CAPI data
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

  // Get all TikTok CAPI events for this lead
  let ttEvents = db.prepare(`
    SELECT * FROM conversion_events
    WHERE lead_id = ? AND source = 'tiktok_capi'
    ORDER BY created_at DESC
  `).all(lead.id);

  ttEvents = ttEvents.map(e => {
    let payload = null;
    try { payload = e.capi_payload ? JSON.parse(e.capi_payload) : null; } catch (err) {}
    return { ...e, capi_payload: payload };
  });

  // Build match quality checklist
  const matchChecklist = {
    email: { present: !!lead.email, value: lead.email ? '***' : null },
    phone: { present: !!lead.phone, value: lead.phone ? '***' : null },
    external_id: { present: !!lead.eli_clickid, value: lead.eli_clickid || null },
    client_ip: { present: !!(visitor?.ip_address), value: visitor?.ip_address || null },
    client_ua: { present: !!(visitor?.user_agent), value: visitor?.user_agent ? visitor.user_agent.substring(0, 80) + '...' : null },
    event_source_url: { present: !!(visitor?.landing_page), value: visitor?.landing_page || null }
  };

  res.json({
    lead,
    visitor: visitor ? {
      eli_clickid: visitor.eli_clickid,
      ip_address: visitor.ip_address,
      user_agent: visitor.user_agent,
      landing_page: visitor.landing_page,
      utm_source: visitor.utm_source,
      utm_campaign: visitor.utm_campaign,
      first_visit: visitor.first_visit
    } : null,
    tt_events: ttEvents,
    match_checklist: matchChecklist
  });
});

/**
 * DEBUG: Send a manual test event to TikTok Events API
 */
router.post('/debug/test-event', authenticateToken, async (req, res) => {
  const { email, phone, event_name, external_id, client_ip, client_ua, event_source_url } = req.body;

  if (!event_name) {
    return res.status(400).json({ error: 'event_name is required' });
  }

  const result = await sendTikTokEvent(event_name, {
    email: email || '',
    phone: phone || '',
    external_id: external_id || '',
    client_ip_address: client_ip || '',
    client_user_agent: client_ua || ''
  }, {
    event_source_url: event_source_url || ''
  });

  res.json({
    success: result.success,
    error: result.error || null,
    event_id: result.event_id || null,
    payload_sent: result.payload || null,
    tiktok_response: result.success
      ? { status: 'ok' }
      : { error: result.error }
  });
});

module.exports = router;
module.exports.sendTikTokEvent = sendTikTokEvent;
