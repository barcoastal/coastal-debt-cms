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

// Encryption key - in production, use environment variable
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return null;
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return null;
  }
}

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_ADS_REDIRECT_URI || 'http://localhost:3000/api/google-ads/callback';
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';

// Scopes needed for Google Ads API
const SCOPES = [
  'https://www.googleapis.com/auth/adwords'
];

// Helper: get developer token from env var or DB (backwards compat)
function getDeveloperToken(config) {
  if (DEVELOPER_TOKEN) return DEVELOPER_TOKEN;
  if (config && config.developer_token_encrypted) return decrypt(config.developer_token_encrypted);
  return null;
}

// Get connection status
router.get('/status', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted) {
    return res.json({ connected: false });
  }

  res.json({
    connected: true,
    customer_id: config.customer_id,
    account_name: config.account_name,
    connected_at: config.connected_at
  });
});

// Save developer token
router.post('/developer-token', authenticateToken, (req, res) => {
  const { developer_token } = req.body;

  if (!developer_token) {
    return res.status(400).json({ error: 'Developer token required' });
  }

  const encrypted = encrypt(developer_token);

  // Upsert config
  const existing = db.prepare('SELECT id FROM google_ads_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE google_ads_config SET developer_token_encrypted = ? WHERE id = 1').run(encrypted);
  } else {
    db.prepare('INSERT INTO google_ads_config (id, developer_token_encrypted) VALUES (1, ?)').run(encrypted);
  }

  res.json({ message: 'Developer token saved' });
});

// Check if developer token exists
router.get('/has-developer-token', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT developer_token_encrypted FROM google_ads_config WHERE id = 1').get();
  res.json({ has_token: !!(config && config.developer_token_encrypted) });
});

// Initiate OAuth flow
router.get('/connect', authenticateToken, (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth not configured. Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET environment variables.' });
  }
  if (!DEVELOPER_TOKEN) {
    // Check DB fallback
    const config = db.prepare('SELECT developer_token_encrypted FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.developer_token_encrypted) {
      return res.status(500).json({ error: 'Developer token not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN environment variable.' });
    }
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    `&access_type=offline` +
    `&prompt=select_account%20consent`;

  res.json({ auth_url: authUrl });
});

// OAuth callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/admin/settings.html?error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/admin/settings.html?error=no_code');
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (tokens.error) {
      return res.redirect('/admin/settings.html?error=' + encodeURIComponent(tokens.error_description || tokens.error));
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

    // Save tokens
    const existing = db.prepare('SELECT id FROM google_ads_config WHERE id = 1').get();
    if (existing) {
      db.prepare(`
        UPDATE google_ads_config SET
          access_token_encrypted = ?,
          refresh_token_encrypted = ?,
          token_expires_at = ?,
          connected_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(
        encrypt(tokens.access_token),
        encrypt(tokens.refresh_token),
        expiresAt
      );
    } else {
      db.prepare(`
        INSERT INTO google_ads_config (id, access_token_encrypted, refresh_token_encrypted, token_expires_at, connected_at)
        VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        encrypt(tokens.access_token),
        encrypt(tokens.refresh_token),
        expiresAt
      );
    }

    if (logActivity) logActivity(null, 'System', 'connected', 'google_ads', null, 'Google Ads connected via OAuth', req.ip);
    res.redirect('/admin/settings.html?connected=true');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/admin/settings.html?error=token_exchange_failed');
  }
});

// Get accessible Google Ads accounts
router.get('/accounts', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();

  if (!config || !config.access_token_encrypted) {
    return res.status(400).json({ error: 'Not connected to Google Ads' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    if (!developerToken) {
      return res.status(400).json({ error: 'Developer token not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN env variable.' });
    }

    // List accessible customers
    const response = await fetch('https://googleads.googleapis.com/v15/customers:listAccessibleCustomers', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': developerToken
      }
    });

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Get details for each customer
    const accounts = [];
    for (const resourceName of (data.resourceNames || [])) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const detailRes = await fetch(`https://googleads.googleapis.com/v15/${resourceName}`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'developer-token': developerToken,
            'login-customer-id': customerId
          }
        });
        const detail = await detailRes.json();
        if (detail.descriptiveName) {
          accounts.push({
            customer_id: customerId,
            name: detail.descriptiveName
          });
        }
      } catch (e) {
        accounts.push({ customer_id: customerId, name: customerId });
      }
    }

    res.json({ accounts });
  } catch (err) {
    console.error('Error fetching accounts:', err);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Select account to use
router.post('/select-account', authenticateToken, (req, res) => {
  const { customer_id, account_name } = req.body;

  if (!customer_id) {
    return res.status(400).json({ error: 'Customer ID required' });
  }

  db.prepare(`
    UPDATE google_ads_config SET customer_id = ?, account_name = ? WHERE id = 1
  `).run(customer_id, account_name || customer_id);

  res.json({ message: 'Account selected' });
});

// Disconnect
router.post('/disconnect', authenticateToken, (req, res) => {
  db.prepare(`
    UPDATE google_ads_config SET
      access_token_encrypted = NULL,
      refresh_token_encrypted = NULL,
      token_expires_at = NULL,
      customer_id = NULL,
      account_name = NULL,
      connected_at = NULL
    WHERE id = 1
  `).run();

  if (logActivity) logActivity(req.user.id, req.user.name || req.user.email, 'disconnected', 'google_ads', null, 'Google Ads disconnected', req.ip);
  res.json({ message: 'Disconnected' });
});

// Helper: Get valid access token (refresh if needed)
async function getValidAccessToken(config) {
  const expiresAt = new Date(config.token_expires_at);
  const now = new Date();

  // If token expires in less than 5 minutes, refresh it
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    const refreshToken = decrypt(config.refresh_token_encrypted);

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });

    const tokens = await response.json();

    if (tokens.access_token) {
      const newExpiresAt = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString();

      db.prepare(`
        UPDATE google_ads_config SET
          access_token_encrypted = ?,
          token_expires_at = ?
        WHERE id = 1
      `).run(encrypt(tokens.access_token), newExpiresAt);

      return tokens.access_token;
    }
  }

  return decrypt(config.access_token_encrypted);
}

// Fetch cost for a GCLID
async function fetchGclidCost(gclid) {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return null;
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    if (!developerToken) return null;

    // Query click_view for this GCLID
    const query = `
      SELECT
        click_view.gclid,
        metrics.cost_micros,
        segments.date
      FROM click_view
      WHERE click_view.gclid = '${gclid}'
      LIMIT 1
    `;

    const response = await fetch(
      `https://googleads.googleapis.com/v15/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Google Ads API error:', data.error);
      return null;
    }

    // Parse response - cost_micros is in millionths of the account currency
    if (data[0]?.results?.[0]?.metrics?.costMicros) {
      const costMicros = parseInt(data[0].results[0].metrics.costMicros);
      return {
        cost_cents: Math.round(costMicros / 10000), // Convert micros to cents
        currency: 'USD'
      };
    }

    return null;
  } catch (err) {
    console.error('Error fetching GCLID cost:', err);
    return null;
  }
}

// Endpoint to manually fetch cost for a lead
router.post('/fetch-lead-cost/:leadId', authenticateToken, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.leadId);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!lead.gclid) {
    return res.status(400).json({ error: 'Lead has no GCLID' });
  }

  const cost = await fetchGclidCost(lead.gclid);

  if (cost) {
    db.prepare(`
      UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cost.cost_cents, cost.currency, lead.id);

    res.json({ cost_cents: cost.cost_cents, cost_currency: cost.currency });
  } else {
    res.json({ cost_cents: null, message: 'Could not fetch cost' });
  }
});

// Batch fetch costs for leads without cost data
router.post('/fetch-all-costs', authenticateToken, async (req, res) => {
  const leads = db.prepare(`
    SELECT id, gclid FROM leads
    WHERE gclid IS NOT NULL AND gclid != '' AND cost_cents IS NULL
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  let fetched = 0;
  let failed = 0;

  for (const lead of leads) {
    const cost = await fetchGclidCost(lead.gclid);
    if (cost) {
      db.prepare(`
        UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cost.cost_cents, cost.currency, lead.id);
      fetched++;
    } else {
      failed++;
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  res.json({ total: leads.length, fetched, failed });
});

// Get cost statistics
router.get('/stats', authenticateToken, (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_leads,
      COUNT(cost_cents) as leads_with_cost,
      SUM(cost_cents) as total_cost_cents,
      AVG(cost_cents) as avg_cost_cents
    FROM leads
    WHERE created_at >= date('now', '-30 days')
  `).get();

  const byPage = db.prepare(`
    SELECT
      lp.name as page_name,
      COUNT(l.id) as lead_count,
      SUM(l.cost_cents) as total_cost_cents,
      AVG(l.cost_cents) as avg_cost_cents
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE l.created_at >= date('now', '-30 days')
    GROUP BY lp.id
    ORDER BY lead_count DESC
  `).all();

  res.json({
    total_leads: stats.total_leads || 0,
    leads_with_cost: stats.leads_with_cost || 0,
    total_spend_cents: stats.total_cost_cents || 0,
    avg_cpl_cents: Math.round(stats.avg_cost_cents || 0),
    by_page: byPage
  });
});

// Upload conversion to Google Ads
async function uploadConversion(gclid, conversionAction, conversionTime, conversionValue = null, currencyCode = 'USD') {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    console.error('Google Ads not configured');
    return { success: false, error: 'Google Ads not configured' };
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    if (!developerToken) {
      return { success: false, error: 'Developer token not configured' };
    }

    const conversion = {
      gclid: gclid,
      conversionAction: `customers/${config.customer_id}/conversionActions/${conversionAction}`,
      conversionDateTime: conversionTime || new Date().toISOString().replace('T', ' ').substring(0, 19) + '+00:00'
    };

    if (conversionValue) {
      conversion.conversionValue = conversionValue;
      conversion.currencyCode = currencyCode;
    }

    const response = await fetch(
      `https://googleads.googleapis.com/v15/customers/${config.customer_id}:uploadClickConversions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          conversions: [conversion],
          partialFailure: true
        })
      }
    );

    const data = await response.json();

    if (data.error) {
      console.error('Google Ads conversion upload error:', data.error);
      return { success: false, error: data.error.message };
    }

    console.log('Conversion uploaded successfully for GCLID:', gclid);
    return { success: true, data };
  } catch (err) {
    console.error('Error uploading conversion:', err);
    return { success: false, error: err.message };
  }
}

// Get conversion actions from Google Ads
router.get('/conversion-actions', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();

  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    const query = `
      SELECT
        conversion_action.id,
        conversion_action.name,
        conversion_action.status,
        conversion_action.type
      FROM conversion_action
      WHERE conversion_action.status = 'ENABLED'
    `;

    const response = await fetch(
      `https://googleads.googleapis.com/v15/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
      }
    );

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const actions = [];
    if (data[0]?.results) {
      data[0].results.forEach(r => {
        actions.push({
          id: r.conversionAction.id,
          name: r.conversionAction.name,
          type: r.conversionAction.type
        });
      });
    }

    res.json({ actions });
  } catch (err) {
    console.error('Error fetching conversion actions:', err);
    res.status(500).json({ error: 'Failed to fetch conversion actions' });
  }
});

// Manual conversion upload from admin
router.post('/upload-conversion', authenticateToken, async (req, res) => {
  const { lead_id, conversion_action_id, conversion_value } = req.body;

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!lead.gclid) {
    return res.status(400).json({ error: 'Lead has no GCLID' });
  }

  const result = await uploadConversion(
    lead.gclid,
    conversion_action_id,
    null,
    conversion_value
  );

  if (result.success) {
    // Log the conversion
    db.prepare(`
      INSERT INTO conversion_events (lead_id, gclid, eli_clickid, conversion_action_id, conversion_value, sent_at, status)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'sent')
    `).run(lead.id, lead.gclid, lead.eli_clickid, conversion_action_id, conversion_value || null);

    res.json({ success: true, message: 'Conversion uploaded to Google Ads' });
  } else {
    res.status(400).json({ error: result.error });
  }
});

// Export for use in leads route
module.exports = router;
module.exports.fetchGclidCost = fetchGclidCost;
module.exports.uploadConversion = uploadConversion;
