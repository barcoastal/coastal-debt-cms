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
  // Mask access_token for security
  res.json({
    ...config,
    access_token: config.access_token ? '••••' + config.access_token.slice(-6) : null,
    has_access_token: !!config.access_token
  });
});

/**
 * POST /config — Saves TikTok config (authenticated)
 */
router.post('/config', authenticateToken, (req, res) => {
  const { access_token, advertiser_id, default_landing_page_id } = req.body;

  const existing = db.prepare('SELECT id FROM tiktok_config WHERE id = 1').get();

  if (existing) {
    // Only update access_token if a new one is provided (not masked)
    if (access_token && !access_token.startsWith('••••')) {
      db.prepare(`
        UPDATE tiktok_config SET
          access_token = ?,
          advertiser_id = ?,
          default_landing_page_id = ?,
          connected_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(access_token, advertiser_id || null, default_landing_page_id || null);
    } else {
      db.prepare(`
        UPDATE tiktok_config SET
          advertiser_id = ?,
          default_landing_page_id = ?,
          connected_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(advertiser_id || null, default_landing_page_id || null);
    }
  } else {
    db.prepare(`
      INSERT INTO tiktok_config (id, access_token, advertiser_id, default_landing_page_id, connected_at)
      VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(access_token || null, advertiser_id || null, default_landing_page_id || null);
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
  if (!config.default_landing_page_id) {
    return { synced: 0, error: 'Default landing page not configured' };
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
            config.default_landing_page_id,
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
