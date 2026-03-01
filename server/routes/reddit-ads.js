const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');

const router = express.Router();

// Cached access token
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get a valid Reddit OAuth2 access token, refreshing if needed.
 */
async function getRedditAccessToken(config) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const auth = Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CoastalDebtCMS/1.0'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refresh_token
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(`Reddit OAuth error: ${data.error}`);

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * GET /config — Returns current Reddit Ads config (authenticated)
 */
router.get('/config', authenticateToken, (req, res) => {
  const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
  if (!config) return res.json({});
  res.json({
    account_id: config.account_id || '',
    client_id: config.client_id || '',
    has_client_secret: !!config.client_secret,
    client_secret: config.client_secret ? '••••' + config.client_secret.slice(-4) : null,
    has_refresh_token: !!config.refresh_token,
    refresh_token: config.refresh_token ? '••••' + config.refresh_token.slice(-6) : null,
    connected_at: config.connected_at
  });
});

/**
 * POST /config — Save Reddit Ads config (authenticated)
 */
router.post('/config', authenticateToken, (req, res) => {
  const { account_id, client_id, client_secret, refresh_token } = req.body;

  const existing = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
  if (existing) {
    const updates = [];
    const params = [];
    if (account_id !== undefined) { updates.push('account_id = ?'); params.push(account_id); }
    if (client_id !== undefined) { updates.push('client_id = ?'); params.push(client_id); }
    if (client_secret && client_secret !== '••••' + (existing.client_secret || '').slice(-4)) {
      updates.push('client_secret = ?'); params.push(client_secret);
    }
    if (refresh_token && refresh_token !== '••••' + (existing.refresh_token || '').slice(-6)) {
      updates.push('refresh_token = ?'); params.push(refresh_token);
    }
    if (updates.length > 0) {
      updates.push('connected_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE reddit_ads_config SET ${updates.join(', ')} WHERE id = 1`).run(...params);
    }
  } else {
    db.prepare(`INSERT INTO reddit_ads_config (id, account_id, client_id, client_secret, refresh_token, connected_at) VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(account_id || '', client_id || '', client_secret || '', refresh_token || '');
  }

  // Clear cached token so new credentials are used
  cachedToken = null;
  tokenExpiresAt = 0;

  res.json({ success: true });
});

/**
 * POST /test-connection — Test Reddit Ads API connection
 */
router.post('/test-connection', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
    if (!config || !config.client_id || !config.client_secret || !config.refresh_token) {
      return res.json({ success: false, error: 'Missing Reddit Ads credentials' });
    }
    const token = await getRedditAccessToken(config);
    const accountRes = await fetch('https://ads-api.reddit.com/api/v3/me', {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'CoastalDebtCMS/1.0' }
    });
    const accountData = await accountRes.json();
    if (accountRes.ok) {
      res.json({ success: true, data: accountData });
    } else {
      res.json({ success: false, error: accountData.message || JSON.stringify(accountData) });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/**
 * Fetch daily spend + clicks from Reddit Ads Reporting API.
 * Returns: { [date]: { cost (dollars), clicks } }
 */
async function fetchRedditDailySpend(config, startDate, endDate) {
  const token = await getRedditAccessToken(config);
  const reportRes = await fetch(`https://ads-api.reddit.com/api/v3/accounts/${config.account_id}/reports`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'CoastalDebtCMS/1.0',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      start_date: startDate,
      end_date: endDate,
      level: 'ACCOUNT',
      metrics: ['spend', 'clicks'],
      breakdowns: ['date']
    })
  });
  const reportData = await reportRes.json();
  if (!reportRes.ok) {
    throw new Error(reportData.message || `Reddit API error ${reportRes.status}`);
  }
  return reportData;
}

/**
 * Fetch missing per-lead costs for Reddit leads (mirrors TikTok/Google Ads pattern).
 * Uses Reddit Ads Reporting API to get daily spend + clicks, computes average CPC per day.
 */
async function fetchRedditMissingCosts() {
  const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
  if (!config || !config.client_id || !config.client_secret || !config.refresh_token || !config.account_id) {
    return { total: 0, fetched: 0, failed: 0 };
  }

  const leads = db.prepare(`
    SELECT l.id, DATE(l.created_at) as lead_date
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'reddit' AND l.cost_cents IS NULL
    ORDER BY l.created_at DESC
    LIMIT 100
  `).all();

  if (!leads.length) return { total: 0, fetched: 0, failed: 0 };

  try {
    // Find date range from leads
    const dates = leads.map(l => l.lead_date).filter(Boolean);
    const minDate = dates.reduce((a, b) => a < b ? a : b);
    const maxDate = dates.reduce((a, b) => a > b ? a : b);

    const reportData = await fetchRedditDailySpend(config, minDate, maxDate);

    // Build CPC by date
    // Reddit report response: array of objects with date, spend (in micros or dollars), clicks
    const cpcByDate = {};
    const rows = reportData.data || reportData.results || reportData || [];
    const rowList = Array.isArray(rows) ? rows : [];
    for (const row of rowList) {
      const date = row.date || row.breakdown_value || '';
      if (!date) continue;
      // Normalize date to YYYY-MM-DD
      const normalizedDate = date.substring(0, 10);
      if (!cpcByDate[normalizedDate]) cpcByDate[normalizedDate] = { cost: 0, clicks: 0 };
      // Reddit API returns spend in micros (millionths of a dollar)
      const spend = parseFloat(row.spend || row.metrics?.spend || 0);
      const clicks = parseInt(row.clicks || row.metrics?.clicks || 0);
      // If spend looks like micros (> 1000 for any day), convert from micros
      cpcByDate[normalizedDate].cost += spend > 10000 ? spend / 1000000 : spend;
      cpcByDate[normalizedDate].clicks += clicks;
    }

    // Calculate overall average CPC as fallback
    let totalCost = 0, totalClicks = 0;
    for (const d of Object.values(cpcByDate)) {
      totalCost += d.cost;
      totalClicks += d.clicks;
    }
    const overallCpcCents = totalClicks > 0 ? Math.round(totalCost / totalClicks * 100) : null;

    console.log(`Reddit CPC data: ${Object.keys(cpcByDate).length} dates, ${totalClicks} total clicks, overall avg CPC: ${overallCpcCents ? '$' + (overallCpcCents / 100).toFixed(2) : 'N/A'}`);

    // Apply CPC to each lead based on its creation date
    let fetched = 0, failed = 0;
    for (const lead of leads) {
      const dateData = cpcByDate[lead.lead_date];
      let costCents = null;

      if (dateData && dateData.clicks > 0) {
        costCents = Math.round(dateData.cost / dateData.clicks * 100);
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

    if (fetched > 0) console.log(`Reddit costs: fetched ${fetched}/${leads.length} (${failed} failed)`);

    const result = { total: leads.length, fetched, failed };
    if (failed > 0 && !overallCpcCents) result.last_error = 'No Reddit cost data found for lead dates';
    return result;
  } catch (err) {
    console.error('Error fetching Reddit CPC:', err);
    return { total: leads.length, fetched: 0, failed: leads.length, last_error: err.message };
  }
}

/**
 * Get total Reddit spend for a date range (used by real-ad-spend endpoint).
 */
async function getRedditTotalSpend(from, to) {
  const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
  if (!config || !config.client_id || !config.client_secret || !config.refresh_token || !config.account_id) {
    return null;
  }

  try {
    const startDate = from || new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0];
    const endDate = to || new Date().toISOString().split('T')[0];
    const reportData = await fetchRedditDailySpend(config, startDate, endDate);

    const rows = reportData.data || reportData.results || reportData || [];
    const rowList = Array.isArray(rows) ? rows : [];
    let total = 0;
    for (const row of rowList) {
      const spend = parseFloat(row.spend || row.metrics?.spend || 0);
      total += spend > 10000 ? spend / 1000000 : spend;
    }
    return total;
  } catch (err) {
    console.error('Real ad spend - Reddit error:', err.message);
    return null;
  }
}

/**
 * POST /fetch-all-costs — Manual trigger to fetch missing Reddit costs
 */
router.post('/fetch-all-costs', authenticateToken, async (req, res) => {
  try {
    const result = await fetchRedditMissingCosts();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.fetchRedditMissingCosts = fetchRedditMissingCosts;
module.exports.getRedditTotalSpend = getRedditTotalSpend;
