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
 * Core sync function: fetch leads from TikTok Business API and import them
 */
async function syncTikTokLeads() {
  const config = db.prepare('SELECT * FROM tiktok_config WHERE id = 1').get();
  if (!config || !config.access_token) {
    return { synced: 0, error: 'TikTok not configured (missing access token)' };
  }
  if (!config.advertiser_id) {
    return { synced: 0, error: 'TikTok Advertiser ID not configured' };
  }

  let synced = 0;
  const errors = [];

  try {
    // Fetch lead tasks/forms from TikTok
    const url = new URL('https://business-api.tiktok.com/open_api/v1.3/page/lead/task/get/');
    url.searchParams.set('advertiser_id', config.advertiser_id);
    url.searchParams.set('page_size', '100');

    const tasksRes = await fetch(url.toString(), {
      headers: {
        'Access-Token': config.access_token,
        'Content-Type': 'application/json'
      }
    });
    const tasksData = await tasksRes.json();

    if (tasksData.code !== 0) {
      const errMsg = tasksData.message || 'Unknown TikTok API error (code: ' + tasksData.code + ')';
      console.error('TikTok API error:', errMsg);
      return { synced: 0, error: errMsg };
    }

    const tasks = tasksData.data?.list || [];
    if (!tasks.length) {
      return { synced: 0, message: 'No lead gen tasks found' };
    }

    // For each task/form, fetch leads
    for (const task of tasks) {
      try {
        const leadsUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/page/lead/task/leads/get/');
        leadsUrl.searchParams.set('advertiser_id', config.advertiser_id);
        leadsUrl.searchParams.set('task_id', task.task_id);
        leadsUrl.searchParams.set('page_size', '100');

        const leadsRes = await fetch(leadsUrl.toString(), {
          headers: {
            'Access-Token': config.access_token,
            'Content-Type': 'application/json'
          }
        });
        const leadsData = await leadsRes.json();

        if (leadsData.code !== 0) {
          errors.push(`Task ${task.task_id}: ${leadsData.message || 'API error'}`);
          continue;
        }

        const leads = leadsData.data?.list || [];

        for (const lead of leads) {
          const tiktokLeadId = lead.lead_id || lead.id;
          if (!tiktokLeadId) continue;

          // Deduplicate: check if already imported
          const existing = db.prepare(
            `SELECT id FROM leads WHERE hidden_fields LIKE ?`
          ).get(`%"tiktok_lead_id":"${tiktokLeadId}"%`);

          if (existing) continue;

          // Map fields from lead data
          const fields = {};
          const extraFields = {};

          // TikTok leads may come as key-value pairs in different structures
          const leadFields = lead.fields || lead.field_data || [];
          if (Array.isArray(leadFields)) {
            for (const item of leadFields) {
              const fieldName = (item.name || item.key || '').toLowerCase().trim();
              const fieldValue = item.value || (Array.isArray(item.values) ? item.values[0] : '');
              const ourField = FIELD_MAP[fieldName];
              if (ourField) {
                fields[ourField] = fieldValue;
              } else {
                extraFields[fieldName] = fieldValue;
              }
            }
          } else if (typeof leadFields === 'object') {
            // Some API versions return fields as an object
            for (const [key, val] of Object.entries(leadFields)) {
              const fieldName = key.toLowerCase().trim();
              const fieldValue = typeof val === 'string' ? val : (val?.value || String(val));
              const ourField = FIELD_MAP[fieldName];
              if (ourField) {
                fields[ourField] = fieldValue;
              } else {
                extraFields[fieldName] = fieldValue;
              }
            }
          }

          // Derive first_name/last_name from full_name if needed
          if (!fields.first_name && !fields.last_name && fields._full_name) {
            const parts = fields._full_name.trim().split(/\s+/);
            fields.first_name = parts[0] || '';
            fields.last_name = parts.slice(1).join(' ') || '';
          }

          // Generate unique eli_clickid
          const eliClickId = 'eli_' + crypto.randomBytes(12).toString('hex');

          // Build hidden fields
          const hiddenFields = {
            source: 'tiktok_lead_gen',
            tiktok_lead_id: tiktokLeadId,
            tiktok_task_id: task.task_id,
            tiktok_task_name: task.task_name || '',
            sync_method: 'api_poll',
            ...extraFields
          };

          // Move underscore-prefixed mapped fields into hidden_fields
          for (const [key, val] of Object.entries(fields)) {
            if (key.startsWith('_')) {
              hiddenFields[key.slice(1)] = val;
            }
          }

          const fullName = [fields.first_name, fields.last_name].filter(Boolean).join(' ');

          // Parse created_time
          let createdAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
          if (lead.create_time || lead.created_time) {
            try {
              const ts = lead.create_time || lead.created_time;
              // TikTok may return Unix timestamp (seconds)
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
            config.default_landing_page_id || null,
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

          synced++;
          console.log(`TikTok sync: imported lead ${result.lastInsertRowid} (${eliClickId}, tiktok_lead=${tiktokLeadId})`);

          // Send notification
          if (sendLeadNotification) {
            const landingPage = config.default_landing_page_id
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
        }
      } catch (taskErr) {
        errors.push(`Task ${task.task_id}: ${taskErr.message}`);
      }
    }
  } catch (err) {
    console.error('TikTok sync error:', err);
    return { synced, error: err.message, errors: errors.length ? errors : undefined };
  }

  if (synced > 0) {
    console.log(`TikTok sync complete: ${synced} new leads imported`);
  }
  return { synced, errors: errors.length ? errors : undefined };
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
