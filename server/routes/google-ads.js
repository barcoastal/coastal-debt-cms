const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, getTimezoneOffsetHours, getSqliteOffsetStr } = require('../lib/timezone');

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
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '';

// Scopes needed for Google Ads API
const SCOPES = [
  'https://www.googleapis.com/auth/adwords'
];

// Helper: build standard Google Ads API headers
function getApiHeaders(accessToken, developerToken, loginCustomerId) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  const lid = loginCustomerId || LOGIN_CUSTOMER_ID;
  if (lid) headers['login-customer-id'] = lid.replace(/-/g, '');
  return headers;
}

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

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account'
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  console.log('OAuth URL redirect_uri:', REDIRECT_URI);
  console.log('OAuth URL client_id:', GOOGLE_CLIENT_ID.substring(0, 20) + '...');

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

    const headers = getApiHeaders(accessToken, developerToken);
    console.log('API headers (redacted):', { ...headers, 'Authorization': 'Bearer ***', 'developer-token': '***' });

    // List accessible customers
    const response = await fetch('https://googleads.googleapis.com/v20/customers:listAccessibleCustomers', {
      headers
    });

    const responseText = await response.text();
    console.log('Accessible customers raw response:', response.status, responseText.substring(0, 500));

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return res.status(400).json({ error: `Google API returned non-JSON (status ${response.status}): ${responseText.substring(0, 200)}` });
    }

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    // Return accounts with just their IDs if we can't fetch details
    const accounts = [];
    const customerIds = (data.resourceNames || []).map(r => r.replace('customers/', ''));

    for (const customerId of customerIds) {
      try {
        const detailRes = await fetch(`https://googleads.googleapis.com/v20/customers/${customerId}`, {
          headers
        });
        const detailText = await detailRes.text();
        let detail;
        try { detail = JSON.parse(detailText); } catch (e) { detail = {}; }

        if (!detail.error && detail.descriptiveName) {
          accounts.push({
            customer_id: customerId,
            name: detail.descriptiveName,
            is_manager: detail.manager || false
          });
        } else {
          console.log(`Account ${customerId} detail error:`, detailText.substring(0, 200));
          accounts.push({ customer_id: customerId, name: `Account ${customerId}` });
        }
      } catch (e) {
        accounts.push({ customer_id: customerId, name: `Account ${customerId}` });
      }
    }

    // Auto-detect MCC (manager account) and save for login-customer-id header
    const managerAccount = accounts.find(a => a.is_manager);
    if (managerAccount) {
      db.prepare('UPDATE google_ads_config SET login_customer_id = ? WHERE id = 1').run(managerAccount.customer_id);
      console.log('Auto-detected MCC account:', managerAccount.customer_id, managerAccount.name);
    }

    res.json({ accounts });
  } catch (err) {
    console.error('Error fetching accounts:', err);
    res.status(500).json({ error: 'Failed to fetch accounts: ' + err.message });
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
    return { error: 'Google Ads not configured' };
  }

  // Auto-detect MCC if not set
  await ensureLoginCustomerId(config);

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    if (!developerToken) return { error: 'No developer token' };

    // Sanitize GCLID - only allow alphanumeric, hyphens, underscores
    const safeGclid = gclid.replace(/[^a-zA-Z0-9_-]/g, '');

    // click_view requires segments.date filter — query last 90 days
    const today = new Date();
    const past90 = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = past90.toISOString().split('T')[0];
    const endDate = today.toISOString().split('T')[0];

    const query = `
      SELECT
        click_view.gclid,
        metrics.cost_micros,
        segments.date
      FROM click_view
      WHERE click_view.gclid = '${safeGclid}'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
      LIMIT 1
    `;

    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
        body: JSON.stringify({ query })
      }
    );

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('Google Ads non-JSON response:', response.status, responseText.substring(0, 300));
      return { error: `API returned non-JSON (status ${response.status})` };
    }

    // searchStream returns errors as [{error: ...}]
    const apiError = data.error || data[0]?.error;
    if (apiError) {
      console.error('Google Ads API error:', JSON.stringify(apiError));
      return { error: apiError.message || JSON.stringify(apiError) };
    }

    // Debug: log what the API actually returns
    const hasResults = data[0]?.results?.length > 0;
    console.log(`GCLID cost lookup: gclid=${safeGclid.substring(0, 20)}... dates=${startDate}~${endDate} hasResults=${hasResults} response=${JSON.stringify(data).substring(0, 500)}`);

    // Parse response - cost_micros is in millionths of the account currency
    if (data[0]?.results?.[0]?.metrics?.costMicros) {
      const costMicros = parseInt(data[0].results[0].metrics.costMicros);
      return {
        cost_cents: Math.round(costMicros / 10000), // Convert micros to cents
        currency: 'USD'
      };
    }

    return { error: `No cost data found for GCLID. API response: ${JSON.stringify(data).substring(0, 300)}` };
  } catch (err) {
    console.error('Error fetching GCLID cost:', err);
    return { error: err.message };
  }
}

// Diagnostic endpoint - test the full cost-fetching chain
router.get('/diagnose', authenticateToken, async (req, res) => {
  const checks = [];

  // 1. Check config exists
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config) {
    checks.push({ step: 'Config', status: 'FAIL', detail: 'No google_ads_config row found' });
    return res.json({ ok: false, checks });
  }
  checks.push({ step: 'Config', status: 'OK', detail: 'Config row exists' });

  // 2. Check refresh token
  if (!config.refresh_token_encrypted) {
    checks.push({ step: 'OAuth', status: 'FAIL', detail: 'No refresh token — need to connect via OAuth' });
    return res.json({ ok: false, checks });
  }
  const refreshToken = decrypt(config.refresh_token_encrypted);
  if (!refreshToken) {
    checks.push({ step: 'OAuth', status: 'FAIL', detail: 'Cannot decrypt refresh token — ENCRYPTION_KEY mismatch? Current key starts with: ' + ENCRYPTION_KEY.substring(0, 8) + '...' });
    return res.json({ ok: false, checks });
  }
  checks.push({ step: 'OAuth', status: 'OK', detail: 'Refresh token decrypted OK' });

  // 3. Check customer ID
  if (!config.customer_id) {
    checks.push({ step: 'Account', status: 'FAIL', detail: 'No customer_id — need to select an account after OAuth' });
    return res.json({ ok: false, checks });
  }
  checks.push({ step: 'Account', status: 'OK', detail: 'Customer ID: ' + config.customer_id });

  // 4. Check developer token
  const developerToken = getDeveloperToken(config);
  if (!developerToken) {
    checks.push({ step: 'Developer Token', status: 'FAIL', detail: 'No developer token in env var or DB' });
    return res.json({ ok: false, checks });
  }
  checks.push({ step: 'Developer Token', status: 'OK', detail: 'Token found (length: ' + developerToken.length + ')' });

  // 5. Check access token refresh
  try {
    const accessToken = await getValidAccessToken(config);
    if (!accessToken) {
      checks.push({ step: 'Access Token', status: 'FAIL', detail: 'getValidAccessToken returned null' });
      return res.json({ ok: false, checks });
    }
    checks.push({ step: 'Access Token', status: 'OK', detail: 'Got valid access token' });
  } catch (err) {
    checks.push({ step: 'Access Token', status: 'FAIL', detail: 'Token refresh error: ' + err.message });
    return res.json({ ok: false, checks });
  }

  // 6. Check leads with GCLIDs
  const leadCount = db.prepare(`SELECT COUNT(*) as cnt FROM leads WHERE gclid IS NOT NULL AND gclid != '' AND cost_cents IS NULL`).get();
  checks.push({ step: 'Leads', status: leadCount.cnt > 0 ? 'OK' : 'WARN', detail: leadCount.cnt + ' leads with GCLIDs needing cost data' });

  // 7. Try a real API call with one GCLID
  if (leadCount.cnt > 0) {
    const testLead = db.prepare(`SELECT id, gclid FROM leads WHERE gclid IS NOT NULL AND gclid != '' AND cost_cents IS NULL ORDER BY created_at DESC LIMIT 1`).get();
    checks.push({ step: 'Test GCLID', status: 'INFO', detail: 'Testing with lead #' + testLead.id + ', GCLID: ' + testLead.gclid.substring(0, 20) + '...' });

    const result = await fetchGclidCost(testLead.gclid);
    if (result.cost_cents !== undefined) {
      checks.push({ step: 'API Call', status: 'OK', detail: 'Got cost: $' + (result.cost_cents / 100).toFixed(2) });
    } else {
      checks.push({ step: 'API Call', status: 'FAIL', detail: 'Error: ' + (result.error || 'Unknown') });
    }
  }

  const allOk = checks.every(c => c.status === 'OK' || c.status === 'INFO' || c.status === 'WARN');
  res.json({ ok: allOk, checks });
});

// Endpoint to manually fetch cost for a lead
router.post('/fetch-lead-cost/:leadId', authenticateToken, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.leadId);

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  if (!lead.gclid) {
    return res.status(400).json({ error: 'Lead has no GCLID' });
  }

  const result = await fetchGclidCost(lead.gclid);

  if (result.cost_cents !== undefined) {
    db.prepare(`
      UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(result.cost_cents, result.currency, lead.id);

    res.json({ cost_cents: result.cost_cents, cost_currency: result.currency });
  } else {
    res.json({ cost_cents: null, message: result.error || 'Could not fetch cost' });
  }
});

// Auto-detect MCC (manager account) and save login_customer_id if not set
async function ensureLoginCustomerId(config) {
  if (config.login_customer_id) return config.login_customer_id;

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return null;

    const headers = getApiHeaders(accessToken, developerToken);
    const response = await fetch('https://googleads.googleapis.com/v20/customers:listAccessibleCustomers', { headers });
    const data = await response.json();
    const customerIds = (data.resourceNames || []).map(r => r.replace('customers/', ''));

    for (const customerId of customerIds) {
      try {
        const detailRes = await fetch(`https://googleads.googleapis.com/v20/customers/${customerId}`, { headers });
        const detail = await detailRes.json();
        if (detail.manager) {
          db.prepare('UPDATE google_ads_config SET login_customer_id = ? WHERE id = 1').run(customerId);
          console.log('Auto-detected MCC account:', customerId, detail.descriptiveName);
          config.login_customer_id = customerId;
          return customerId;
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('Error detecting MCC:', err.message);
  }
  return null;
}

// Standalone function to fetch missing costs (used by route and background job)
// Uses campaign-level average CPC per date (click_view requires Standard API access)
async function fetchMissingCosts() {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) return { total: 0, fetched: 0, failed: 0 };

  // Auto-detect MCC if not set
  await ensureLoginCustomerId(config);

  const leads = db.prepare(`
    SELECT id, gclid, DATE(created_at) as lead_date FROM leads
    WHERE gclid IS NOT NULL AND gclid != '' AND cost_cents IS NULL
    ORDER BY created_at DESC
    LIMIT 100
  `).all();

  if (!leads.length) return { total: 0, fetched: 0, failed: 0 };

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return { total: leads.length, fetched: 0, failed: leads.length, last_error: 'No developer token' };

    // Find date range from leads
    const dates = leads.map(l => l.lead_date).filter(Boolean);
    const minDate = dates.reduce((a, b) => a < b ? a : b);
    const maxDate = dates.reduce((a, b) => a > b ? a : b);

    // Query campaign-level cost and clicks grouped by date
    const query = `
      SELECT
        metrics.cost_micros,
        metrics.clicks,
        segments.date
      FROM campaign
      WHERE segments.date >= '${minDate}'
        AND segments.date <= '${maxDate}'
        AND metrics.clicks > 0
    `;

    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
        body: JSON.stringify({ query })
      }
    );

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return { total: leads.length, fetched: 0, failed: leads.length, last_error: `API returned non-JSON (status ${response.status})` };
    }

    // searchStream returns errors as [{error: ...}]
    const apiError = data.error || data[0]?.error;
    if (apiError) {
      return { total: leads.length, fetched: 0, failed: leads.length, last_error: apiError.message || JSON.stringify(apiError) };
    }

    // Build CPC by date: sum cost and clicks across all campaigns per date
    const cpcByDate = {};
    for (const batch of data) {
      if (!batch.results) continue;
      for (const row of batch.results) {
        const date = row.segments.date;
        if (!cpcByDate[date]) cpcByDate[date] = { cost: 0, clicks: 0 };
        cpcByDate[date].cost += parseInt(row.metrics.costMicros || 0);
        cpcByDate[date].clicks += parseInt(row.metrics.clicks || 0);
      }
    }

    // Calculate overall average CPC as fallback for dates with no data
    let totalCost = 0, totalClicks = 0;
    for (const d of Object.values(cpcByDate)) {
      totalCost += d.cost;
      totalClicks += d.clicks;
    }
    const overallCpcCents = totalClicks > 0 ? Math.round(totalCost / totalClicks / 10000) : null;

    console.log(`Google Ads CPC data: ${Object.keys(cpcByDate).length} dates, ${totalClicks} total clicks, overall avg CPC: ${overallCpcCents ? '$' + (overallCpcCents / 100).toFixed(2) : 'N/A'}`);

    // Apply CPC to each lead based on its creation date
    let fetched = 0, failed = 0;
    for (const lead of leads) {
      const dateData = cpcByDate[lead.lead_date];
      let costCents = null;

      if (dateData && dateData.clicks > 0) {
        costCents = Math.round(dateData.cost / dateData.clicks / 10000);
      } else if (overallCpcCents !== null) {
        costCents = overallCpcCents;
      }

      if (costCents !== null) {
        db.prepare('UPDATE leads SET cost_cents = ?, cost_currency = ?, cost_fetched_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(costCents, 'USD', lead.id);
        fetched++;
      } else {
        failed++;
      }
    }

    if (fetched > 0) console.log(`Google Ads costs: fetched ${fetched}/${leads.length} (${failed} failed)`);

    const result = { total: leads.length, fetched, failed };
    if (failed > 0 && !overallCpcCents) result.last_error = 'No campaign cost data found for lead dates';
    return result;
  } catch (err) {
    console.error('Error fetching campaign CPC:', err);
    return { total: leads.length, fetched: 0, failed: leads.length, last_error: err.message };
  }
}

// Batch fetch costs for leads without cost data
router.post('/fetch-all-costs', authenticateToken, async (req, res) => {
  const result = await fetchMissingCosts();
  res.json(result);
});

// Get cost statistics
router.get('/stats', authenticateToken, (req, res) => {
  const tz = getConfiguredTimezone();
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_leads,
      COUNT(cost_cents) as leads_with_cost,
      SUM(cost_cents) as total_cost_cents,
      AVG(cost_cents) as avg_cost_cents
    FROM leads
    WHERE created_at >= date('now', '${getSqliteOffsetStr(tz)}', '-30 days')
  `).get();

  const byPage = db.prepare(`
    SELECT
      lp.name as page_name,
      COUNT(l.id) as lead_count,
      SUM(l.cost_cents) as total_cost_cents,
      AVG(l.cost_cents) as avg_cost_cents
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE l.created_at >= date('now', '${getSqliteOffsetStr(tz)}', '-30 days')
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
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}:uploadClickConversions`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
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
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
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
module.exports.fetchMissingCosts = fetchMissingCosts;
module.exports.uploadConversion = uploadConversion;
