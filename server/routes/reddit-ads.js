const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const crypto = require('crypto');

let _syncRedditCapi = null;
setTimeout(() => {
  try { _syncRedditCapi = require('../services/reddit-capi-sync').syncRedditCapi; } catch (e) {}
}, 0);

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
    pixel_id: config.pixel_id || '',
    has_capi_access_token: !!config.capi_access_token,
    capi_access_token: config.capi_access_token ? '••••' + config.capi_access_token.slice(-6) : null,
    capi_access_token_length: config.capi_access_token ? config.capi_access_token.length : 0,
    capi_access_token_starts: config.capi_access_token ? config.capi_access_token.slice(0, 20) : null,
    capi_test_id: config.capi_test_id || '',
    connected_at: config.connected_at
  });
});

/**
 * POST /config — Save Reddit Ads config (authenticated)
 */
router.post('/config', authenticateToken, (req, res) => {
  const { account_id, client_id, client_secret, refresh_token, pixel_id, capi_access_token, capi_test_id } = req.body;

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
    if (pixel_id !== undefined) { updates.push('pixel_id = ?'); params.push(pixel_id); }
    if (capi_access_token && capi_access_token !== '••••' + (existing.capi_access_token || '').slice(-6)) {
      updates.push('capi_access_token = ?'); params.push(capi_access_token);
    }
    if (capi_test_id !== undefined) { updates.push('capi_test_id = ?'); params.push(capi_test_id); }
    if (updates.length > 0) {
      updates.push('connected_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE reddit_ads_config SET ${updates.join(', ')} WHERE id = 1`).run(...params);
    }
  } else {
    db.prepare(`INSERT INTO reddit_ads_config (id, account_id, client_id, client_secret, refresh_token, pixel_id, capi_access_token, connected_at) VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(account_id || '', client_id || '', client_secret || '', refresh_token || '', pixel_id || '', capi_access_token || '');
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
  const toIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? d + 'T00:00:00Z' : d;
  const reportRes = await fetch(`https://ads-api.reddit.com/api/v3/ad_accounts/${config.account_id}/reports`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'CoastalDebtCMS/1.0',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: {
        starts_at: toIso(startDate),
        ends_at: toIso(endDate),
        fields: ['spend', 'clicks', 'impressions'],
        breakdowns: ['DATE']
      }
    })
  });
  const reportData = await reportRes.json();
  if (!reportRes.ok) {
    throw new Error(reportData.error?.message || reportData.message || `Reddit API error ${reportRes.status}`);
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

    // Build CPC by date. v3 response shape: { data: { metrics: [{ date, spend, clicks, impressions }, ...] } }
    const cpcByDate = {};
    const rows = reportData?.data?.metrics || [];
    for (const row of rows) {
      const date = row.date || row.breakdown_value || '';
      if (!date) continue;
      const normalizedDate = String(date).substring(0, 10);
      if (!cpcByDate[normalizedDate]) cpcByDate[normalizedDate] = { cost: 0, clicks: 0 };
      // Reddit API returns spend in micros (millionths of a dollar)
      const spend = parseFloat(row.spend || 0);
      const clicks = parseInt(row.clicks || 0);
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
    const rows = reportData?.data?.metrics || [];
    let total = 0;
    for (const row of rows) {
      const spend = parseFloat(row.spend || 0);
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

/**
 * Send a single conversion event to Reddit Conversions API.
 * Returns { success, error, payload }.
 *
 * @param {object} mapping - reddit_capi_config row (reddit_event_type, reddit_custom_event_name)
 * @param {object} conv - RedTrack conversion row (id, clickid, type, payout, created_at)
 * @param {object} visitor - visitors row (rdt_cid, ip_address, user_agent, eli_clickid)
 * @param {object|null} lead - leads row (email, phone) or null
 */
async function sendRedditEvent(mapping, conv, visitor, lead) {
  try {
    if (!visitor || !visitor.rdt_cid) {
      return { success: false, error: 'visitor has no rdt_cid — cannot send Reddit CAPI event' };
    }

    const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
    if (!config || !config.pixel_id || !config.capi_access_token) {
      return { success: false, error: 'Reddit CAPI not configured (missing pixel_id or capi_access_token)' };
    }

    const hash = (val) => {
      if (!val) return null;
      return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
    };

    const normalizePhone = (phone) => {
      if (!phone) return null;
      const digits = phone.replace(/\D/g, '');
      return digits || null;
    };

    const user = {};
    if (lead?.email) user.email = hash(lead.email);
    const phoneDigits = normalizePhone(lead?.phone);
    if (phoneDigits) user.phone_number = hash(phoneDigits);
    if (visitor.eli_clickid) user.external_id = hash(visitor.eli_clickid);
    if (visitor.ip_address) user.ip_address = visitor.ip_address;
    if (visitor.user_agent) user.user_agent = visitor.user_agent;

    // Reddit v3 uses uppercase tracking_type (LEAD, PURCHASE, SIGN_UP, ADD_TO_CART, VIEW_CONTENT, PAGE_VISIT, CUSTOM).
    const V3_TRACKING_TYPE = {
      Lead: 'LEAD',
      Purchase: 'PURCHASE',
      SignUp: 'SIGN_UP',
      AddToCart: 'ADD_TO_CART',
      ViewContent: 'VIEW_CONTENT',
      PageVisit: 'PAGE_VISIT',
      Custom: 'CUSTOM'
    };
    const trackingType = V3_TRACKING_TYPE[mapping.reddit_event_type] || mapping.reddit_event_type;

    // Reddit v3 wants event_at as Unix epoch MILLISECONDS.
    const eventAtMs = (() => {
      if (!conv.created_at) return Date.now();
      const s = String(conv.created_at);
      const normalized = s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z');
      const d = new Date(normalized);
      return isNaN(d.getTime()) ? Date.now() : d.getTime();
    })();

    const eventPayload = {
      event_at: eventAtMs,
      action_source: 'WEBSITE',
      type: {
        tracking_type: trackingType,
        ...(trackingType === 'CUSTOM' ? { custom_event_name: mapping.reddit_custom_event_name || null } : {})
      },
      click_id: visitor.rdt_cid,
      metadata: {
        currency: 'USD',
        ...(conv.payout != null ? { value: parseFloat(conv.payout) } : {}),
        conversion_id: String(conv.id)
      },
      user
    };

    const requestBody = {
      data: {
        ...(mapping._test_mode && config.capi_test_id ? { test_id: config.capi_test_id } : {}),
        events: [eventPayload]
      }
    };

    const url = `https://ads-api.reddit.com/api/v3/pixels/${config.pixel_id}/conversion_events`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.capi_access_token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'CoastalDebtCMS/1.0'
      },
      body: JSON.stringify(requestBody)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      const raw = result.error?.message || result.message || result.error || `Reddit API ${response.status}`;
      const errMsg = typeof raw === 'string' ? raw : JSON.stringify(raw);
      // If Reddit returned validation fields, surface them so we can diagnose which field is wrong
      const fields = result.error?.fields || result.fields;
      const fullErr = fields && fields.length ? `${errMsg} — ${fields.map(f => `${f.field}: ${f.message}`).join('; ')}` : errMsg;
      console.error('Reddit CAPI error:', fullErr);
      return { success: false, error: fullErr, payload: requestBody };
    }

    console.log(`Reddit CAPI: sent ${mapping.reddit_event_type} for conv ${conv.id} (rdt_cid=${visitor.rdt_cid})`);
    return { success: true, payload: requestBody };
  } catch (err) {
    console.error('Reddit CAPI request failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * POST /capi/test — Fire a synthetic test event to Reddit CAPI (test_mode = true).
 * Body: { reddit_event_type?, reddit_custom_event_name?, rdt_cid?, email?, phone?, payout? }
 */
router.post('/capi/test', authenticateToken, async (req, res) => {
  try {
    const {
      reddit_event_type = 'Lead',
      reddit_custom_event_name = null,
      rdt_cid = 'test_rdt_cid_00000',
      email = 'test@example.com',
      phone = '+15551234567',
      payout = 10
    } = req.body || {};

    const mapping = { reddit_event_type, reddit_custom_event_name, _test_mode: true };
    const conv = { id: `test_${Date.now()}`, created_at: new Date().toISOString(), payout };
    const visitor = { rdt_cid, eli_clickid: 'test_eli', ip_address: '127.0.0.1', user_agent: 'CoastalDebtCMS-Test/1.0' };
    const lead = { email, phone };

    const result = await sendRedditEvent(mapping, conv, visitor, lead);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /capi/config — list event mappings
 */
router.get('/capi/config', authenticateToken, (req, res) => {
  const rows = db.prepare('SELECT * FROM reddit_capi_config ORDER BY created_at DESC').all();
  res.json(rows);
});

/**
 * POST /capi/config — create a mapping
 * Body: { redtrack_event_name, reddit_event_type, reddit_custom_event_name? }
 */
router.post('/capi/config', authenticateToken, (req, res) => {
  const { redtrack_event_name, reddit_event_type, reddit_custom_event_name = null } = req.body || {};
  if (!redtrack_event_name || !reddit_event_type) {
    return res.status(400).json({ error: 'redtrack_event_name and reddit_event_type required' });
  }
  const allowed = ['Lead', 'Purchase', 'SignUp', 'AddToCart', 'ViewContent', 'PageVisit', 'Custom'];
  if (!allowed.includes(reddit_event_type)) {
    return res.status(400).json({ error: `reddit_event_type must be one of ${allowed.join(', ')}` });
  }
  try {
    const r = db.prepare(`
      INSERT INTO reddit_capi_config (redtrack_event_name, reddit_event_type, reddit_custom_event_name)
      VALUES (?, ?, ?)
    `).run(redtrack_event_name.toLowerCase(), reddit_event_type, reddit_custom_event_name);
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /capi/config/:id — update a mapping
 */
router.put('/capi/config/:id', authenticateToken, (req, res) => {
  const { redtrack_event_name, reddit_event_type, reddit_custom_event_name, is_active } = req.body || {};
  db.prepare(`
    UPDATE reddit_capi_config SET
      redtrack_event_name = COALESCE(?, redtrack_event_name),
      reddit_event_type = COALESCE(?, reddit_event_type),
      reddit_custom_event_name = ?,
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    redtrack_event_name ? redtrack_event_name.toLowerCase() : null,
    reddit_event_type || null,
    reddit_custom_event_name ?? null,
    is_active != null ? (is_active ? 1 : 0) : null,
    req.params.id
  );
  res.json({ success: true });
});

/**
 * DELETE /capi/config/:id
 */
router.delete('/capi/config/:id', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM reddit_capi_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

/**
 * GET /capi/events — recent reddit_capi events
 */
router.get('/capi/events', authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const rows = db.prepare(`
    SELECT ce.*, l.first_name, l.last_name, l.email
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    WHERE ce.source = 'reddit_capi'
    ORDER BY ce.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) as c FROM conversion_events WHERE source = 'reddit_capi'").get().c;
  res.json({ events: rows, total });
});

/**
 * POST /capi/events/:id/retry — retry a failed event
 */
router.post('/capi/events/:id/retry', authenticateToken, async (req, res) => {
  const ev = db.prepare("SELECT * FROM conversion_events WHERE id = ? AND source = 'reddit_capi'").get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (!ev.redtrack_conversion_id) return res.status(400).json({ error: 'Missing redtrack_conversion_id' });

  const mapping = db.prepare('SELECT * FROM reddit_capi_config WHERE redtrack_event_name = ?').get(String(ev.conversion_action_name).toLowerCase());
  if (!mapping) return res.status(400).json({ error: 'No mapping for event name' });

  const visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(ev.eli_clickid);
  if (!visitor || !visitor.rdt_cid) return res.status(400).json({ error: 'Visitor has no rdt_cid' });

  const lead = ev.lead_id ? db.prepare('SELECT email, phone FROM leads WHERE id = ?').get(ev.lead_id) : null;

  const conv = {
    id: ev.redtrack_conversion_id,
    clickid: visitor.rt_clickid,
    type: ev.conversion_action_name,
    payout: ev.revenue ?? null,
    created_at: ev.created_at
  };

  const result = await sendRedditEvent(mapping, conv, visitor, lead);

  db.prepare(`
    UPDATE conversion_events SET
      status = ?, error_message = ?, capi_payload = ?,
      sent_at = ${result.success ? 'CURRENT_TIMESTAMP' : 'sent_at'}
    WHERE id = ?
  `).run(
    result.success ? 'sent' : 'failed',
    result.error || null,
    result.payload ? JSON.stringify(result.payload) : ev.capi_payload,
    req.params.id
  );

  res.json(result);
});

/**
 * POST /capi/sync — manual sync trigger
 */
router.post('/capi/sync', authenticateToken, async (req, res) => {
  if (!_syncRedditCapi) return res.status(503).json({ error: 'Sync service not loaded yet' });
  const hours = req.query.hours || req.body?.hours || 2;
  const stats = await _syncRedditCapi(hours);
  res.json(stats);
});

module.exports = router;
module.exports.fetchRedditMissingCosts = fetchRedditMissingCosts;
module.exports.getRedditTotalSpend = getRedditTotalSpend;
module.exports.sendRedditEvent = sendRedditEvent;
