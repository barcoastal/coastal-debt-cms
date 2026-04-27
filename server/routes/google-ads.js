const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, getTodayInTz, getTimezoneOffsetHours, getSqliteOffsetStr, formatLocalDate } = require('../lib/timezone');

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

// Get/set MCC (login_customer_id)
router.get('/mcc', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT login_customer_id FROM google_ads_config WHERE id = 1').get();
  res.json({ login_customer_id: config?.login_customer_id || '' });
});

router.post('/mcc', authenticateToken, (req, res) => {
  const { login_customer_id } = req.body;
  const cleanId = (login_customer_id || '').replace(/[^0-9]/g, '');
  db.prepare('UPDATE google_ads_config SET login_customer_id = ? WHERE id = 1').run(cleanId || null);
  console.log('MCC login_customer_id set to:', cleanId || '(cleared)');
  res.json({ message: 'MCC account ID saved', login_customer_id: cleanId });
});

// Get/set Auction Insights Sheets (multiple, with labels)
router.get('/auction-insights-sheet', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT auction_insights_sheets FROM google_ads_config WHERE id = 1').get();
  let sheets = [];
  try { sheets = JSON.parse(config?.auction_insights_sheets || '[]'); } catch (e) {}
  res.json({ sheets });
});

router.post('/auction-insights-sheet', authenticateToken, (req, res) => {
  let { sheets } = req.body;
  if (!Array.isArray(sheets)) sheets = [];

  // Clean up: extract sheet IDs from URLs, trim labels
  sheets = sheets.filter(s => s && s.sheet_id).map(s => {
    let id = (s.sheet_id || '').trim();
    const match = id.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (match) id = match[1];
    return { label: (s.label || '').trim() || 'Untitled', sheet_id: id };
  });

  const json = JSON.stringify(sheets);
  const existing = db.prepare('SELECT id FROM google_ads_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE google_ads_config SET auction_insights_sheets = ? WHERE id = 1').run(json);
  } else {
    db.prepare('INSERT INTO google_ads_config (id, auction_insights_sheets) VALUES (1, ?)').run(json);
  }
  res.json({ message: 'Auction insights sheets saved', sheets });
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

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);

    if (!developerToken) return { error: 'No developer token' };

    // Sanitize GCLID - only allow alphanumeric, hyphens, underscores
    const safeGclid = gclid.replace(/[^a-zA-Z0-9_-]/g, '');

    // click_view requires segments.date filter — query last 90 days
    const tz = getConfiguredTimezone();
    const endDate = getTodayInTz(tz);
    const endDateObj = new Date(endDate + 'T00:00:00');
    const past90 = new Date(endDateObj.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDate = formatLocalDate(past90);

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

  // 7. Try API access with multiple versions and configs
  const accessToken = await getValidAccessToken(config);
  await ensureLoginCustomerId(config);
  const mcc = config.login_customer_id;
  checks.push({ step: 'MCC', status: mcc ? 'OK' : 'WARN', detail: 'login_customer_id: ' + (mcc || '(not set)') });
  checks.push({ step: 'Dev Token', status: 'INFO', detail: 'Using: ' + developerToken.substring(0, 6) + '...' });

  const versions = ['v18', 'v17', 'v16', 'v20'];
  const configs = mcc
    ? [{ mcc, label: 'with MCC' }, { mcc: null, label: 'without MCC' }]
    : [{ mcc: null, label: 'no MCC' }];

  for (const ver of versions) {
    for (const cfg of configs) {
      try {
        const hdrs = {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        };
        if (cfg.mcc) hdrs['login-customer-id'] = cfg.mcc;

        const testRes = await fetch(
          `https://googleads.googleapis.com/${ver}/customers/${config.customer_id}/googleAds:search`,
          { method: 'POST', headers: hdrs, body: JSON.stringify({ query: 'SELECT customer.id FROM customer LIMIT 1' }) }
        );
        const testData = await testRes.json();
        if (!testData.error) {
          checks.push({ step: `API ${ver} ${cfg.label}`, status: 'OK', detail: 'Query succeeded!' });
        } else {
          const code = testData.error.details?.[0]?.errors?.[0]?.errorCode;
          checks.push({ step: `API ${ver} ${cfg.label}`, status: 'FAIL', detail: JSON.stringify(code || testData.error.status) });
        }
      } catch (e) {
        checks.push({ step: `API ${ver} ${cfg.label}`, status: 'FAIL', detail: e.message });
      }
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

    console.log('MCC detection: accessible customers:', customerIds);

    // First pass: look for a manager account by checking details
    for (const customerId of customerIds) {
      try {
        const detailRes = await fetch(`https://googleads.googleapis.com/v20/customers/${customerId}`, { headers });
        const detail = await detailRes.json();
        console.log(`MCC detection: account ${customerId} — manager=${detail.manager}, name=${detail.descriptiveName || 'N/A'}`);
        if (detail.manager) {
          db.prepare('UPDATE google_ads_config SET login_customer_id = ? WHERE id = 1').run(customerId);
          console.log('Auto-detected MCC account:', customerId);
          config.login_customer_id = customerId;
          return customerId;
        }
      } catch (e) {
        console.log(`MCC detection: failed to get details for ${customerId}:`, e.message);
      }
    }

    // Second pass: if no manager found, try each account as login_customer_id
    // by testing a simple campaign query on the target account
    console.log('MCC detection: no manager found, testing each account as login_customer_id...');
    for (const customerId of customerIds) {
      if (customerId === config.customer_id) continue;
      try {
        const testHeaders = getApiHeaders(accessToken, developerToken, customerId);
        const testResponse = await fetch(
          `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:search`,
          {
            method: 'POST',
            headers: testHeaders,
            body: JSON.stringify({ query: 'SELECT campaign.id FROM campaign LIMIT 1', pageSize: 1 })
          }
        );
        const testData = await testResponse.json();
        if (!testData.error) {
          db.prepare('UPDATE google_ads_config SET login_customer_id = ? WHERE id = 1').run(customerId);
          console.log('Found working login_customer_id by testing:', customerId);
          config.login_customer_id = customerId;
          return customerId;
        }
        console.log(`MCC detection: ${customerId} as login_customer_id failed:`, testData.error?.message?.substring(0, 100));
      } catch (e) {
        console.log(`MCC detection: ${customerId} test error:`, e.message);
      }
    }

    console.log('MCC detection: no working login_customer_id found');
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

    const headers = getApiHeaders(accessToken, developerToken, config.login_customer_id);

    // First: test basic access with simplest possible query
    const testResponse = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:search`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: 'SELECT customer.id FROM customer LIMIT 1' })
      }
    );
    const testData = await testResponse.json();
    if (testData.error) {
      // Show full error details for debugging
      const fullErr = JSON.stringify(testData.error).substring(0, 500);
      return {
        total: leads.length, fetched: 0, failed: leads.length,
        last_error: `API access test failed: ${fullErr}`,
        debug: { customer_id: config.customer_id, login_customer_id: config.login_customer_id || '(not set)' }
      };
    }

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
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:search`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query })
      }
    );

    const data = await response.json();
    if (data.error) {
      const errMsg = data.error.message || JSON.stringify(data.error);
      return {
        total: leads.length, fetched: 0, failed: leads.length,
        last_error: errMsg,
        debug: { customer_id: config.customer_id, login_customer_id: config.login_customer_id || '(not set)' }
      };
    }

    // Build CPC by date: sum cost and clicks across all campaigns per date
    const cpcByDate = {};
    const results = data.results || [];
    for (const row of results) {
      const date = row.segments.date;
      if (!cpcByDate[date]) cpcByDate[date] = { cost: 0, clicks: 0 };
      cpcByDate[date].cost += parseInt(row.metrics.costMicros || 0);
      cpcByDate[date].clicks += parseInt(row.metrics.clicks || 0);
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

// Get campaigns (active by default, all=1 for all)
router.get('/campaigns', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const showAll = req.query.all === '1';
    const whereClause = showAll ? '' : `WHERE campaign.status = 'ENABLED'`;
    const query = `SELECT campaign.id, campaign.name, campaign.status FROM campaign ${whereClause} ORDER BY campaign.name`;

    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
        body: JSON.stringify({ query })
      }
    );
    const data = await response.json();
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    const campaigns = (data[0]?.results || []).map(r => ({
      id: r.campaign.id, name: r.campaign.name, status: r.campaign.status
    }));
    res.json({ campaigns });
  } catch (err) {
    console.error('Error fetching campaigns:', err);
    res.status(500).json({ error: 'Failed to fetch campaigns: ' + err.message });
  }
});

// Get ad groups (filter by campaign name or id)
router.get('/ad-groups', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const { campaign, campaign_id, all } = req.query;
    const filters = [];
    if (all !== '1') filters.push(`ad_group.status = 'ENABLED'`, `campaign.status = 'ENABLED'`);
    if (campaign_id) filters.push(`campaign.id = ${parseInt(campaign_id, 10) || 0}`);
    if (campaign) filters.push(`campaign.name = '${String(campaign).replace(/'/g, "\\'")}'`);
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const query = `
      SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name
      FROM ad_group
      ${whereClause}
      ORDER BY campaign.name, ad_group.name
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
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    const ad_groups = (data[0]?.results || []).map(r => ({
      id: r.adGroup.id,
      name: r.adGroup.name,
      status: r.adGroup.status,
      campaign_id: r.campaign.id,
      campaign_name: r.campaign.name
    }));
    res.json({ ad_groups });
  } catch (err) {
    console.error('Error fetching ad groups:', err);
    res.status(500).json({ error: 'Failed to fetch ad groups: ' + err.message });
  }
});

// ─── Landing-page intelligence endpoints ──────────────────────────────────

// Get quality-score data per ad_group (aggregated from keyword level)
// Returns { ad_groups: [{ campaign_id, campaign_name, ad_group_id, ad_group_name,
//   avg_quality_score, lp_experience_breakdown, ad_relevance_breakdown,
//   expected_ctr_breakdown, keyword_count }] }
router.get('/quality-scores', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const query = `
      SELECT
        campaign.id, campaign.name,
        ad_group.id, ad_group.name,
        ad_group_criterion.criterion_id,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.creative_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr
      FROM keyword_view
      WHERE ad_group_criterion.status = 'ENABLED'
        AND ad_group_criterion.negative = FALSE
        AND ad_group.status = 'ENABLED'
        AND campaign.status = 'ENABLED'
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
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    // Aggregate per ad_group
    const groups = new Map();
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        const key = row.adGroup.id;
        if (!groups.has(key)) {
          groups.set(key, {
            campaign_id: row.campaign.id,
            campaign_name: row.campaign.name,
            ad_group_id: row.adGroup.id,
            ad_group_name: row.adGroup.name,
            qs_sum: 0, qs_count: 0,
            lp_experience: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
            ad_relevance: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
            expected_ctr: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 }
          });
        }
        const g = groups.get(key);
        const qi = row.adGroupCriterion?.qualityInfo || {};
        if (typeof qi.qualityScore === 'number') {
          g.qs_sum += qi.qualityScore;
          g.qs_count += 1;
        }
        const pcq = qi.postClickQualityScore || 'UNKNOWN';
        const cq = qi.creativeQualityScore || 'UNKNOWN';
        const ec = qi.searchPredictedCtr || 'UNKNOWN';
        if (g.lp_experience[pcq] !== undefined) g.lp_experience[pcq]++;
        if (g.ad_relevance[cq] !== undefined) g.ad_relevance[cq]++;
        if (g.expected_ctr[ec] !== undefined) g.expected_ctr[ec]++;
      }
    }

    const ad_groups = [...groups.values()].map(g => ({
      campaign_id: g.campaign_id,
      campaign_name: g.campaign_name,
      ad_group_id: g.ad_group_id,
      ad_group_name: g.ad_group_name,
      keyword_count: g.qs_count,
      avg_quality_score: g.qs_count ? +(g.qs_sum / g.qs_count).toFixed(2) : null,
      lp_experience_breakdown: g.lp_experience,
      ad_relevance_breakdown: g.ad_relevance,
      expected_ctr_breakdown: g.expected_ctr
    }));

    res.json({ ad_groups });
  } catch (err) {
    console.error('Error fetching quality scores:', err);
    res.status(500).json({ error: 'Failed to fetch quality scores: ' + err.message });
  }
});

// Get landing_page_view metrics per URL with optional date range
// query: ?days=30 (default 30)
// Returns { landing_pages: [{ unexpanded_final_url, clicks, impressions, ctr,
//   cost_micros, conversions, avg_cpc_micros, mobile_friendly_click_rate }] }
router.get('/landing-page-stats', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
    const query = `
      SELECT
        landing_page_view.unexpanded_final_url,
        metrics.clicks,
        metrics.impressions,
        metrics.ctr,
        metrics.cost_micros,
        metrics.conversions,
        metrics.average_cpc,
        metrics.mobile_friendly_clicks_percentage
      FROM landing_page_view
      WHERE segments.date DURING LAST_${days === 7 ? '7_DAYS' : days === 14 ? '14_DAYS' : days === 30 ? '30_DAYS' : '30_DAYS'}
    `;
    // landing_page_view doesn't accept arbitrary day ranges; fall back to LAST_30_DAYS for non-standard windows
    const safeQuery = `
      SELECT
        landing_page_view.unexpanded_final_url,
        metrics.clicks,
        metrics.impressions,
        metrics.ctr,
        metrics.cost_micros,
        metrics.conversions,
        metrics.average_cpc,
        metrics.mobile_friendly_clicks_percentage
      FROM landing_page_view
      WHERE segments.date DURING LAST_30_DAYS
    `;

    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: getApiHeaders(accessToken, developerToken, config.login_customer_id),
        body: JSON.stringify({ query: safeQuery })
      }
    );
    const data = await response.json();
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    // Aggregate by URL (one URL can appear in multiple campaigns)
    const byUrl = new Map();
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        const url = row.landingPageView?.unexpandedFinalUrl || '';
        if (!url) continue;
        if (!byUrl.has(url)) {
          byUrl.set(url, {
            unexpanded_final_url: url,
            clicks: 0, impressions: 0, cost_micros: 0, conversions: 0,
            mobile_clicks_pct_sum: 0, mobile_clicks_pct_count: 0
          });
        }
        const p = byUrl.get(url);
        const m = row.metrics || {};
        p.clicks += parseInt(m.clicks || 0, 10);
        p.impressions += parseInt(m.impressions || 0, 10);
        p.cost_micros += parseInt(m.costMicros || 0, 10);
        p.conversions += parseFloat(m.conversions || 0);
        if (typeof m.mobileFriendlyClicksPercentage === 'number') {
          p.mobile_clicks_pct_sum += m.mobileFriendlyClicksPercentage;
          p.mobile_clicks_pct_count += 1;
        }
      }
    }

    const landing_pages = [...byUrl.values()].map(p => ({
      unexpanded_final_url: p.unexpanded_final_url,
      clicks: p.clicks,
      impressions: p.impressions,
      ctr: p.impressions ? +(p.clicks / p.impressions).toFixed(4) : 0,
      cost_micros: p.cost_micros,
      conversions: +p.conversions.toFixed(2),
      avg_cpc_micros: p.clicks ? Math.round(p.cost_micros / p.clicks) : 0,
      mobile_friendly_click_rate: p.mobile_clicks_pct_count
        ? +(p.mobile_clicks_pct_sum / p.mobile_clicks_pct_count).toFixed(4) : 0
    }));

    res.json({ landing_pages });
  } catch (err) {
    console.error('Error fetching landing page stats:', err);
    res.status(500).json({ error: 'Failed to fetch landing page stats: ' + err.message });
  }
});

// Get ads with their final URLs (for auto-linking LPs to campaigns/ad_groups)
// Returns { ads: [{ campaign_id, campaign_name, ad_group_id, ad_group_name, final_urls: [..] }] }
router.get('/ads-by-url', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const query = `
      SELECT
        campaign.id, campaign.name,
        ad_group.id, ad_group.name,
        ad_group_ad.ad.id,
        ad_group_ad.ad.final_urls
      FROM ad_group_ad
      WHERE ad_group_ad.status = 'ENABLED'
        AND ad_group.status = 'ENABLED'
        AND campaign.status = 'ENABLED'
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
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    const ads = [];
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        ads.push({
          campaign_id: row.campaign.id,
          campaign_name: row.campaign.name,
          ad_group_id: row.adGroup.id,
          ad_group_name: row.adGroup.name,
          ad_id: row.adGroupAd?.ad?.id,
          final_urls: row.adGroupAd?.ad?.finalUrls || []
        });
      }
    }

    res.json({ ads });
  } catch (err) {
    console.error('Error fetching ads-by-url:', err);
    res.status(500).json({ error: 'Failed to fetch ads-by-url: ' + err.message });
  }
});

// Build a Google Ads "DURING" / "BETWEEN" date filter from the request body.
// Accepts: { days: 7|14|30|... } OR { range: 'today'|'yesterday'|'mtd'|'all' }
//          OR { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }.
// Defaults to LAST_30_DAYS. Returns { clause: 'segments.date DURING ...', label: '30d' }.
function buildGadsDateClause(body) {
  const { range, days, from, to } = body || {};
  if (range === 'today') return { clause: "segments.date DURING TODAY", label: 'Today' };
  if (range === 'yesterday') return { clause: "segments.date DURING YESTERDAY", label: 'Yesterday' };
  if (range === 'mtd') return { clause: "segments.date DURING THIS_MONTH", label: 'MTD' };
  if (range === 'last_month') return { clause: "segments.date DURING LAST_MONTH", label: 'Last month' };
  if (range === 'all') {
    // Google Ads has no "all time" — use widest practical window
    return { clause: "segments.date DURING LAST_30_DAYS", label: 'Last 30 days (max window)' };
  }
  if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { clause: `segments.date BETWEEN '${from}' AND '${to}'`, label: `${from} → ${to}` };
  }
  const d = parseInt(days, 10);
  if (d === 7) return { clause: "segments.date DURING LAST_7_DAYS", label: 'Last 7 days' };
  if (d === 14) return { clause: "segments.date DURING LAST_14_DAYS", label: 'Last 14 days' };
  if (d === 30) return { clause: "segments.date DURING LAST_30_DAYS", label: 'Last 30 days' };
  return { clause: "segments.date DURING LAST_30_DAYS", label: 'Last 30 days' };
}

// Refresh LP metrics: combines QS + landing_page_view + ads-by-url
// Auto-links LPs to campaigns/ad_groups by URL match, populates gads_lp_metrics cache
router.post('/refresh-lp-metrics', authenticateToken, async (req, res) => {
  const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
  if (!config || !config.refresh_token_encrypted || !config.customer_id) {
    return res.status(400).json({ error: 'Google Ads not connected' });
  }

  const dateFilter = buildGadsDateClause(req.body);

  try {
    const accessToken = await getValidAccessToken(config);
    const developerToken = getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });
    const headers = getApiHeaders(accessToken, developerToken, config.login_customer_id);
    const url = `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`;

    const runQuery = async (query) => {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
      const d = await r.json();
      const apiError = d.error || d[0]?.error;
      if (apiError) throw new Error(apiError.message || JSON.stringify(apiError));
      return d;
    };

    // Pre-build LP slug set so we can match any URL that contains one of our
    // slugs as a path segment (works regardless of prefix: /lp/X/, /X/, etc).
    const lpsForMatching = db.prepare('SELECT id, slug FROM landing_pages').all();
    const lpSlugSetLower = new Set(lpsForMatching.map(lp => String(lp.slug || '').toLowerCase()));

    // Returns the LP slug found in a URL (any path segment), or null.
    // Tries /lp/{slug} first, then /a/{slug}, then any path segment that exactly
    // matches an LP slug in our DB. Tracking-redirect URLs (click.coastaldebt.com
    // etc.) often won't have the slug — those just stay unmatched.
    function extractLpSlug(rawUrl) {
      if (!rawUrl) return null;
      // Strip query/hash and split
      const cleaned = String(rawUrl).split('#')[0].split('?')[0];
      // Try common prefixes first for precision
      const m = cleaned.match(/\/(?:lp|a|landing|page)\/([^\/]+)/i);
      if (m && m[1]) {
        const slug = decodeURIComponent(m[1]).toLowerCase();
        if (lpSlugSetLower.has(slug)) return slug;
      }
      // Fall back: any path segment that matches a known LP slug
      let path;
      try { path = new URL(cleaned, 'https://placeholder.local').pathname; }
      catch (e) { path = cleaned; }
      const segs = path.split('/').filter(Boolean);
      for (const seg of segs) {
        const slug = decodeURIComponent(seg).toLowerCase();
        if (lpSlugSetLower.has(slug)) return slug;
      }
      return null;
    }

    // 1) ads with final URLs → exact slug → {campaign, ad_group}
    const adsData = await runQuery(`
      SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.final_urls
      FROM ad_group_ad
      WHERE ad_group_ad.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
    `);
    const slugToGroup = new Map();
    const unmatchedAdUrls = [];
    // adGroupId → Set<url> — every unique final URL the ads in that ad group use
    const urlsByAdGroup = new Map();
    for (const stream of adsData) {
      for (const row of (stream.results || [])) {
        const finalUrls = row.adGroupAd?.ad?.finalUrls || [];
        const group = {
          campaign_id: row.campaign.id,
          campaign_name: row.campaign.name,
          ad_group_id: row.adGroup.id,
          ad_group_name: row.adGroup.name
        };
        const agId = String(row.adGroup.id);
        if (!urlsByAdGroup.has(agId)) urlsByAdGroup.set(agId, new Set());
        const urlSet = urlsByAdGroup.get(agId);
        for (const u of finalUrls) {
          if (u) urlSet.add(u);
          const slug = extractLpSlug(u);
          if (slug) {
            if (!slugToGroup.has(slug)) slugToGroup.set(slug, group);
          } else {
            unmatchedAdUrls.push({ url: u, campaign: row.campaign.name, ad_group: row.adGroup.name });
          }
        }
      }
    }
    console.log(`[refresh-lp-metrics] LPs matched from Google Ads: ${slugToGroup.size}, unmatched URLs: ${unmatchedAdUrls.length}`);

    // 2) keyword-level QS + keyword text → aggregated per ad_group
    //     Pulls all enabled keywords across all enabled campaigns/ad groups,
    //     not just ones tied to system LPs.
    const qsData = await runQuery(`
      SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.quality_info.quality_score,
        ad_group_criterion.quality_info.post_click_quality_score,
        ad_group_criterion.quality_info.creative_quality_score,
        ad_group_criterion.quality_info.search_predicted_ctr
      FROM keyword_view
      WHERE ad_group_criterion.status = 'ENABLED'
        AND ad_group_criterion.negative = FALSE
        AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
    `);
    const qsByAdGroup = new Map();
    for (const stream of qsData) {
      for (const row of (stream.results || [])) {
        const key = row.adGroup.id;
        if (!qsByAdGroup.has(key)) {
          qsByAdGroup.set(key, {
            campaign_id: row.campaign.id,
            campaign_name: row.campaign.name,
            ad_group_name: row.adGroup.name,
            keywords: [],
            qs_sum: 0, qs_count: 0,
            lp: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
            ar: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
            ec: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 }
          });
        }
        const g = qsByAdGroup.get(key);
        const qi = row.adGroupCriterion?.qualityInfo || {};
        const kwText = row.adGroupCriterion?.keyword?.text;
        const kwMatch = row.adGroupCriterion?.keyword?.matchType;
        if (kwText) g.keywords.push({
          text: kwText,
          match_type: kwMatch || null,
          quality_score: typeof qi.qualityScore === 'number' ? qi.qualityScore : null,
          post_click_quality_score: qi.postClickQualityScore || null,
          creative_quality_score: qi.creativeQualityScore || null,
          search_predicted_ctr: qi.searchPredictedCtr || null
        });
        if (typeof qi.qualityScore === 'number') { g.qs_sum += qi.qualityScore; g.qs_count++; }
        const pcq = qi.postClickQualityScore || 'UNKNOWN';
        const cq = qi.creativeQualityScore || 'UNKNOWN';
        const ec = qi.searchPredictedCtr || 'UNKNOWN';
        if (g.lp[pcq] !== undefined) g.lp[pcq]++;
        if (g.ar[cq] !== undefined) g.ar[cq]++;
        if (g.ec[ec] !== undefined) g.ec[ec]++;
      }
    }

    // 2b) Pull all enabled ad groups (in case some have no keywords yet, e.g.
    //     Performance Max) so they still appear in the folder view.
    const allAgData = await runQuery(`
      SELECT campaign.id, campaign.name, ad_group.id, ad_group.name
      FROM ad_group
      WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
    `);
    for (const stream of allAgData) {
      for (const row of (stream.results || [])) {
        if (qsByAdGroup.has(row.adGroup.id)) continue;
        qsByAdGroup.set(row.adGroup.id, {
          campaign_id: row.campaign.id,
          campaign_name: row.campaign.name,
          ad_group_name: row.adGroup.name,
          keywords: [],
          qs_sum: 0, qs_count: 0,
          lp: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
          ar: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 },
          ec: { ABOVE_AVERAGE: 0, AVERAGE: 0, BELOW_AVERAGE: 0, UNKNOWN: 0 }
        });
      }
    }

    // 2c) Ad-group level metrics (impressions/clicks/cost/conversions for the
    //     last 30 days) so the folder view can show spend per ad group even
    //     when no LP is linked.
    const agStatsData = await runQuery(`
      SELECT ad_group.id,
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM ad_group
      WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
        AND ${dateFilter.clause}
    `);
    const agStatsById = new Map();
    for (const stream of agStatsData) {
      for (const row of (stream.results || [])) {
        const key = row.adGroup.id;
        if (!agStatsById.has(key)) agStatsById.set(key, { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
        const s = agStatsById.get(key);
        const m = row.metrics || {};
        s.impressions += parseInt(m.impressions || 0, 10);
        s.clicks += parseInt(m.clicks || 0, 10);
        s.cost_micros += parseInt(m.costMicros || 0, 10);
        s.conversions += parseFloat(m.conversions || 0);
      }
    }

    // 3) landing_page_view metrics
    const lpvData = await runQuery(`
      SELECT
        landing_page_view.unexpanded_final_url,
        metrics.clicks, metrics.impressions, metrics.ctr,
        metrics.cost_micros, metrics.conversions, metrics.average_cpc,
        metrics.mobile_friendly_clicks_percentage
      FROM landing_page_view
      WHERE ${dateFilter.clause}
    `);
    // Aggregate landing_page_view metrics by slug (multiple URLs that resolve
    // to the same slug merge their metrics)
    const lpvBySlug = new Map();
    for (const stream of lpvData) {
      for (const row of (stream.results || [])) {
        const u = row.landingPageView?.unexpandedFinalUrl;
        if (!u) continue;
        const slug = extractLpSlug(u);
        if (!slug) continue;
        if (!lpvBySlug.has(slug)) {
          lpvBySlug.set(slug, { clicks: 0, impressions: 0, cost_micros: 0, conversions: 0, mob_sum: 0, mob_count: 0 });
        }
        const p = lpvBySlug.get(slug);
        const m = row.metrics || {};
        p.clicks += parseInt(m.clicks || 0, 10);
        p.impressions += parseInt(m.impressions || 0, 10);
        p.cost_micros += parseInt(m.costMicros || 0, 10);
        p.conversions += parseFloat(m.conversions || 0);
        if (typeof m.mobileFriendlyClicksPercentage === 'number') {
          p.mob_sum += m.mobileFriendlyClicksPercentage;
          p.mob_count++;
        }
      }
    }

    // 4) Match LPs by slug (re-use the slug set built earlier for matching)
    const allLps = lpsForMatching;
    const updatePage = db.prepare(`
      UPDATE landing_pages
      SET gads_campaign_id = ?, gads_campaign_name = ?, gads_ad_group_id = ?, gads_ad_group_name = ?
      WHERE id = ?
    `);
    const upsertMetrics = db.prepare(`
      INSERT INTO gads_lp_metrics (
        landing_page_id, quality_score, post_click_quality_score, creative_quality_score,
        search_predicted_ctr, qs_keyword_count, qs_breakdown,
        impressions, clicks, cost_micros, conversions, ctr, avg_cpc_micros,
        mobile_friendly_click_rate, range_label, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(landing_page_id) DO UPDATE SET
        quality_score = excluded.quality_score,
        post_click_quality_score = excluded.post_click_quality_score,
        creative_quality_score = excluded.creative_quality_score,
        search_predicted_ctr = excluded.search_predicted_ctr,
        qs_keyword_count = excluded.qs_keyword_count,
        qs_breakdown = excluded.qs_breakdown,
        impressions = excluded.impressions,
        clicks = excluded.clicks,
        cost_micros = excluded.cost_micros,
        conversions = excluded.conversions,
        ctr = excluded.ctr,
        avg_cpc_micros = excluded.avg_cpc_micros,
        mobile_friendly_click_rate = excluded.mobile_friendly_click_rate,
        range_label = excluded.range_label,
        refreshed_at = CURRENT_TIMESTAMP
    `);

    // pickDominant: returns label of bucket with highest count, or null
    const pickDominant = (b) => {
      const entries = [['ABOVE_AVERAGE', b.ABOVE_AVERAGE], ['AVERAGE', b.AVERAGE], ['BELOW_AVERAGE', b.BELOW_AVERAGE]];
      const best = entries.sort((a, b) => b[1] - a[1])[0];
      return best && best[1] > 0 ? best[0] : null;
    };

    let linkedCount = 0;
    let metricsCount = 0;
    for (const lp of allLps) {
      const slugLower = String(lp.slug || '').toLowerCase();
      const group = slugToGroup.get(slugLower) || null;
      const lpvStats = lpvBySlug.get(slugLower) || null;

      if (group) {
        updatePage.run(group.campaign_id, group.campaign_name, group.ad_group_id, group.ad_group_name, lp.id);
        linkedCount++;
      }

      // Metrics row even when no QS/LPV available, so freshness shows
      const qs = group ? qsByAdGroup.get(group.ad_group_id) : null;
      const avgQs = qs && qs.qs_count ? +(qs.qs_sum / qs.qs_count).toFixed(2) : null;
      const breakdown = qs ? JSON.stringify({ lp: qs.lp, ar: qs.ar, ec: qs.ec }) : null;

      const clicks = lpvStats ? lpvStats.clicks : 0;
      const impressions = lpvStats ? lpvStats.impressions : 0;
      const costMicros = lpvStats ? lpvStats.cost_micros : 0;

      upsertMetrics.run(
        lp.id,
        avgQs,
        qs ? pickDominant(qs.lp) : null,
        qs ? pickDominant(qs.ar) : null,
        qs ? pickDominant(qs.ec) : null,
        qs ? qs.qs_count : 0,
        breakdown,
        impressions,
        clicks,
        costMicros,
        lpvStats ? lpvStats.conversions : 0,
        impressions ? +(clicks / impressions).toFixed(4) : 0,
        clicks ? Math.round(costMicros / clicks) : 0,
        lpvStats && lpvStats.mob_count ? +(lpvStats.mob_sum / lpvStats.mob_count).toFixed(4) : 0,
        dateFilter.label
      );
      metricsCount++;
    }

    // 5) Populate gads_ad_group_meta with all enabled ad groups
    const upsertAgMeta = db.prepare(`
      INSERT INTO gads_ad_group_meta (
        ad_group_id, ad_group_name, campaign_id, campaign_name,
        keywords, keyword_count, avg_quality_score,
        post_click_quality_score, creative_quality_score, search_predicted_ctr,
        qs_breakdown, impressions, clicks, cost_micros, conversions,
        ad_urls, range_label, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(ad_group_id) DO UPDATE SET
        ad_group_name = excluded.ad_group_name,
        campaign_id = excluded.campaign_id,
        campaign_name = excluded.campaign_name,
        keywords = excluded.keywords,
        keyword_count = excluded.keyword_count,
        avg_quality_score = excluded.avg_quality_score,
        post_click_quality_score = excluded.post_click_quality_score,
        creative_quality_score = excluded.creative_quality_score,
        search_predicted_ctr = excluded.search_predicted_ctr,
        qs_breakdown = excluded.qs_breakdown,
        impressions = excluded.impressions,
        clicks = excluded.clicks,
        cost_micros = excluded.cost_micros,
        conversions = excluded.conversions,
        ad_urls = excluded.ad_urls,
        range_label = excluded.range_label,
        refreshed_at = CURRENT_TIMESTAMP
    `);
    let adGroupCount = 0;
    for (const [adGroupId, g] of qsByAdGroup) {
      const stats = agStatsById.get(adGroupId) || { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 };
      const avgQs = g.qs_count ? +(g.qs_sum / g.qs_count).toFixed(2) : null;
      const adUrlSet = urlsByAdGroup.get(String(adGroupId));
      const adUrlsJson = adUrlSet ? JSON.stringify([...adUrlSet]) : '[]';
      upsertAgMeta.run(
        String(adGroupId),
        g.ad_group_name,
        String(g.campaign_id),
        g.campaign_name,
        JSON.stringify(g.keywords),
        g.keywords.length,
        avgQs,
        pickDominant(g.lp),
        pickDominant(g.ar),
        pickDominant(g.ec),
        JSON.stringify({ lp: g.lp, ar: g.ar, ec: g.ec }),
        stats.impressions,
        stats.clicks,
        stats.cost_micros,
        stats.conversions,
        adUrlsJson,
        dateFilter.label
      );
      adGroupCount++;
    }

    // Drop ad groups that are no longer enabled (so cache stays accurate).
    // Manual folders (is_manual=1) are preserved across syncs.
    const liveIds = [...qsByAdGroup.keys()].map(String);
    if (liveIds.length) {
      const placeholders = liveIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM gads_ad_group_meta WHERE COALESCE(is_manual, 0) = 0 AND ad_group_id NOT IN (${placeholders})`).run(...liveIds);
    } else {
      db.prepare('DELETE FROM gads_ad_group_meta WHERE COALESCE(is_manual, 0) = 0').run();
    }

    // Diagnostic: which slugs in Google Ads have NO matching LP in our DB,
    // and which LPs didn't get linked. Helps Bar spot URL mismatches.
    const lpSlugSet = new Set(allLps.map(lp => String(lp.slug || '').toLowerCase()));
    const orphanGoogleSlugs = [...slugToGroup.keys()].filter(s => !lpSlugSet.has(s));
    const unlinkedLps = allLps.filter(lp => !slugToGroup.has(String(lp.slug || '').toLowerCase())).map(lp => lp.slug);

    res.json({
      success: true,
      linked: linkedCount,
      metrics_updated: metricsCount,
      ad_groups_cached: adGroupCount,
      total_lps: allLps.length,
      range_label: dateFilter.label,
      diagnostic: {
        google_ads_slugs_seen: slugToGroup.size,
        google_ads_slugs_no_lp: orphanGoogleSlugs.slice(0, 20),
        lps_without_match: unlinkedLps.slice(0, 20),
        unmatched_ad_urls_sample: unmatchedAdUrls.slice(0, 10)
      }
    });
  } catch (err) {
    console.error('Error refreshing LP metrics:', err);
    res.status(500).json({ error: 'Failed to refresh LP metrics: ' + err.message });
  }
});

// Read cached ad-group meta (campaigns + ad groups + keywords + QS + spend)
// This is what the LP folder view uses to show ALL active campaigns,
// including ones not currently linked to any system LP.
router.get('/ad-group-meta', authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT ad_group_id, ad_group_name, campaign_id, campaign_name,
      keywords, keyword_count, avg_quality_score,
      post_click_quality_score, creative_quality_score, search_predicted_ctr,
      qs_breakdown, impressions, clicks, cost_micros, conversions, range_label,
      ad_urls, COALESCE(is_manual, 0) AS is_manual, refreshed_at
    FROM gads_ad_group_meta
    ORDER BY campaign_name, ad_group_name
  `).all();
  const ad_groups = rows.map(r => ({
    ...r,
    keywords: (() => { try { return JSON.parse(r.keywords || '[]'); } catch (e) { return []; } })(),
    qs_breakdown: (() => { try { return JSON.parse(r.qs_breakdown || '{}'); } catch (e) { return {}; } })(),
    ad_urls: (() => { try { return JSON.parse(r.ad_urls || '[]'); } catch (e) { return []; } })()
  }));
  res.json({ ad_groups });
});

// Create a manual folder: a synthetic campaign + first ad group not tied to Google Ads.
// Survives syncs (is_manual = 1). Bar uses this when the real campaign isn't live yet.
router.post('/manual-folder', authenticateToken, (req, res) => {
  const { campaign_name, ad_group_name } = req.body || {};
  if (!campaign_name || !ad_group_name) {
    return res.status(400).json({ error: 'campaign_name and ad_group_name required' });
  }
  const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  const stamp = Date.now().toString(36);
  // If the campaign_name already exists as a manual folder, reuse its synthetic id
  const existing = db.prepare(`
    SELECT campaign_id FROM gads_ad_group_meta
    WHERE COALESCE(is_manual, 0) = 1 AND campaign_name = ?
    LIMIT 1
  `).get(campaign_name);
  const campaignId = existing ? existing.campaign_id : `manual:${slugify(campaign_name)}-${stamp}`;
  const adGroupId = `manual:${slugify(campaign_name)}-${slugify(ad_group_name)}-${stamp}`;

  // Reject duplicate ad-group name within the same manual campaign
  const dup = db.prepare(`
    SELECT 1 FROM gads_ad_group_meta
    WHERE campaign_id = ? AND ad_group_name = ?
  `).get(campaignId, ad_group_name);
  if (dup) return res.status(409).json({ error: 'Ad group with that name already exists in this folder' });

  db.prepare(`
    INSERT INTO gads_ad_group_meta (
      ad_group_id, ad_group_name, campaign_id, campaign_name,
      keywords, keyword_count, is_manual, refreshed_at
    ) VALUES (?, ?, ?, ?, '[]', 0, 1, CURRENT_TIMESTAMP)
  `).run(adGroupId, ad_group_name, campaignId, campaign_name);

  res.json({
    success: true,
    campaign_id: campaignId,
    campaign_name,
    ad_group_id: adGroupId,
    ad_group_name
  });
});

// Add another ad group to an existing manual campaign.
router.post('/manual-ad-group', authenticateToken, (req, res) => {
  const { campaign_id, ad_group_name } = req.body || {};
  if (!campaign_id || !ad_group_name) {
    return res.status(400).json({ error: 'campaign_id and ad_group_name required' });
  }
  const camp = db.prepare(`
    SELECT campaign_name, COALESCE(is_manual, 0) AS is_manual
    FROM gads_ad_group_meta WHERE campaign_id = ? LIMIT 1
  `).get(campaign_id);
  if (!camp) return res.status(404).json({ error: 'Campaign not found' });
  if (!camp.is_manual) return res.status(400).json({ error: 'Cannot add ad group to a Google Ads-synced campaign — manage in Google Ads' });

  const dup = db.prepare(`
    SELECT 1 FROM gads_ad_group_meta WHERE campaign_id = ? AND ad_group_name = ?
  `).get(campaign_id, ad_group_name);
  if (dup) return res.status(409).json({ error: 'Ad group with that name already exists in this folder' });

  const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
  const stamp = Date.now().toString(36);
  const adGroupId = `manual:${slugify(camp.campaign_name)}-${slugify(ad_group_name)}-${stamp}`;

  db.prepare(`
    INSERT INTO gads_ad_group_meta (
      ad_group_id, ad_group_name, campaign_id, campaign_name,
      keywords, keyword_count, is_manual, refreshed_at
    ) VALUES (?, ?, ?, ?, '[]', 0, 1, CURRENT_TIMESTAMP)
  `).run(adGroupId, ad_group_name, campaign_id, camp.campaign_name);

  res.json({ success: true, ad_group_id: adGroupId, ad_group_name, campaign_id, campaign_name: camp.campaign_name });
});

// Delete a manual folder (campaign + all its ad groups). Only manual ones — Google Ads
// rows are managed by sync. LPs tagged to the folder become Unassigned.
router.delete('/manual-folder/:campaign_id', authenticateToken, (req, res) => {
  const cid = req.params.campaign_id;
  const camp = db.prepare(`
    SELECT COALESCE(is_manual, 0) AS is_manual FROM gads_ad_group_meta WHERE campaign_id = ? LIMIT 1
  `).get(cid);
  if (!camp) return res.status(404).json({ error: 'Folder not found' });
  if (!camp.is_manual) return res.status(400).json({ error: 'Cannot delete a Google Ads-synced folder' });

  // Unlink LPs tagged to this manual folder so they fall back to Unassigned
  db.prepare(`
    UPDATE landing_pages
    SET gads_campaign_id = NULL, gads_campaign_name = NULL, gads_ad_group_id = NULL, gads_ad_group_name = NULL
    WHERE gads_campaign_id = ?
  `).run(cid);
  const result = db.prepare(`DELETE FROM gads_ad_group_meta WHERE campaign_id = ?`).run(cid);
  res.json({ success: true, ad_groups_deleted: result.changes });
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
module.exports.getValidAccessToken = getValidAccessToken;
module.exports.getDeveloperToken = getDeveloperToken;
