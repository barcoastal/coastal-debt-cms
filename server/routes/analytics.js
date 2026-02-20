const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, localDateToUtcRange, getTodayInTz, getTimezoneOffsetHours, getSqliteOffsetStr, formatLocalDate } = require('../lib/timezone');

const router = express.Router();

// --- Reused encryption helpers (same key as google-ads.js) ---
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
  } catch (e) { return null; }
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || '';
const GOOGLE_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
const GOOGLE_LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '';

async function getGoogleAccessToken(config) {
  const expiresAt = new Date(config.token_expires_at);
  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    const refreshToken = decrypt(config.refresh_token_encrypted);
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' })
    });
    const tokens = await resp.json();
    if (tokens.access_token) {
      db.prepare('UPDATE google_ads_config SET access_token_encrypted = ?, token_expires_at = ? WHERE id = 1')
        .run(encrypt(tokens.access_token), new Date(Date.now() + tokens.expires_in * 1000).toISOString());
      return tokens.access_token;
    }
  }
  return decrypt(config.access_token_encrypted);
}

// Helper: build WHERE clause from common filters
function buildFilters(req, tableAlias = 'l', pageAlias = 'lp') {
  const { platform, page, from, to } = req.query;
  const conditions = [];
  const params = [];

  if (platform) {
    conditions.push(`${pageAlias}.platform = ?`);
    params.push(platform);
  }
  if (page) {
    conditions.push(`${pageAlias}.slug = ?`);
    params.push(page);
  }
  const tz = getConfiguredTimezone();
  if (from) {
    conditions.push(`${tableAlias}.created_at >= ?`);
    params.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    conditions.push(`${tableAlias}.created_at <= ?`);
    params.push(localDateToUtcRange(to, tz).end);
  }

  return { conditions, params };
}

// Get distinct campaign names for filter dropdowns
router.get('/campaigns', authenticateToken, (req, res) => {
  const campaigns = db.prepare(`
    SELECT DISTINCT v.utm_campaign
    FROM visitors v
    WHERE v.utm_campaign IS NOT NULL AND v.utm_campaign != ''
    ORDER BY v.utm_campaign
  `).all();
  res.json(campaigns.map(r => r.utm_campaign));
});

// Get distinct conversion event names for filter dropdowns
router.get('/event-names', authenticateToken, (req, res) => {
  const events = db.prepare(`
    SELECT DISTINCT ce.conversion_action_name
    FROM conversion_events ce
    WHERE ce.conversion_action_name IS NOT NULL
    ORDER BY ce.conversion_action_name
  `).all();
  res.json(events.map(r => r.conversion_action_name));
});

// Get dashboard stats
router.get('/dashboard', authenticateToken, (req, res) => {
  const { conditions, params } = buildFilters(req);
  const needsJoin = conditions.length > 0;
  const join = needsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countQuery = (extraWhere) => {
    const allConditions = conditions.length > 0 || extraWhere
      ? 'WHERE ' + [...conditions, ...(extraWhere ? [extraWhere] : [])].join(' AND ')
      : '';
    return `SELECT COUNT(*) as count FROM leads l ${join} ${allConditions}`;
  };

  // --- Always-shown stats: platform/page filters only, NO date filter ---
  const { platform, page } = req.query;
  const fixedConds = [];
  const fixedParams = [];
  if (platform) { fixedConds.push(`lp.platform = ?`); fixedParams.push(platform); }
  if (page) { fixedConds.push(`lp.slug = ?`); fixedParams.push(page); }
  const fixedNeedsJoin = fixedConds.length > 0;
  const fixedJoin = fixedNeedsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';

  const fixedCount = (dateWhere) => {
    const all = [...fixedConds, dateWhere].filter(Boolean);
    const w = all.length ? 'WHERE ' + all.join(' AND ') : '';
    return `SELECT COUNT(*) as count FROM leads l ${fixedJoin} ${w}`;
  };

  // Revenue query helper (joins conversion_events through leads)
  const fixedRevenue = (dateWhere) => {
    const all = [...(fixedNeedsJoin ? fixedConds : []), dateWhere].filter(Boolean);
    const w = all.length ? 'WHERE ' + all.join(' AND ') : '';
    const ceJoin = fixedNeedsJoin
      ? 'JOIN leads l ON ce.lead_id = l.id LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id'
      : '';
    return `SELECT COALESCE(SUM(ce.revenue), 0) as total FROM conversion_events ce ${ceJoin} ${w}`;
  };

  // Cost query helper
  const fixedCost = (dateWhere) => {
    const all = [...fixedConds, dateWhere].filter(Boolean);
    const w = all.length ? 'WHERE ' + all.join(' AND ') : '';
    return `SELECT COALESCE(SUM(l.cost_cents), 0) as total FROM leads l ${fixedJoin} ${w}`;
  };

  // Compute timezone-aware Today, WTD start, MTD start
  const tz = getConfiguredTimezone();
  const todayStr = getTodayInTz(tz);
  const { start: todayStart, end: todayEnd } = localDateToUtcRange(todayStr, tz);

  // WTD: start of calendar week (Sunday) in configured timezone
  const todayDate = new Date(todayStr + 'T00:00:00');
  const dayOfWeek = todayDate.getDay(); // 0=Sun
  const wtdDate = new Date(todayDate);
  wtdDate.setDate(wtdDate.getDate() - dayOfWeek);
  const wtdStr = formatLocalDate(wtdDate);
  const { start: wtdStart } = localDateToUtcRange(wtdStr, tz);

  // MTD: first of current month in configured timezone
  const mtdStr = todayStr.substring(0, 8) + '01';
  const { start: mtdStart } = localDateToUtcRange(mtdStr, tz);

  // Lead counts — always shown, not affected by date range filter
  const leadsToday = db.prepare(fixedCount(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, todayStart, todayEnd).count;
  const leadsWTD = db.prepare(fixedCount(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, wtdStart, todayEnd).count;
  const leadsMTD = db.prepare(fixedCount(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, mtdStart, todayEnd).count;
  const activePages = db.prepare('SELECT COUNT(*) as count FROM landing_pages WHERE is_active = 1').get().count;

  // Revenue — always shown, timezone-aware
  const revenueToday = db.prepare(fixedRevenue(`ce.created_at >= ? AND ce.created_at <= ?`)).get(...fixedParams, todayStart, todayEnd).total;
  const revenueWTD = db.prepare(fixedRevenue(`ce.created_at >= ? AND ce.created_at <= ?`)).get(...fixedParams, wtdStart, todayEnd).total;
  const revenueMTD = db.prepare(fixedRevenue(`ce.created_at >= ? AND ce.created_at <= ?`)).get(...fixedParams, mtdStart, todayEnd).total;

  // Cost — always shown, timezone-aware
  const costToday = db.prepare(fixedCost(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, todayStart, todayEnd).total;
  const costWTD = db.prepare(fixedCost(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, wtdStart, todayEnd).total;
  const costMTD = db.prepare(fixedCost(`l.created_at >= ? AND l.created_at <= ?`)).get(...fixedParams, mtdStart, todayEnd).total;

  // Filtered total (respects user date range)
  const totalLeads = db.prepare(`SELECT COUNT(*) as count FROM leads l ${join} ${where}`).get(...params).count;

  // --- Filtered aggregates (respects ALL filters including date range) ---
  // Filtered revenue
  const filteredRevenueJoin = needsJoin
    ? 'JOIN leads l ON ce.lead_id = l.id LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id'
    : '';
  const filteredRevenueConds = [];
  const filteredRevenueParams = [];
  if (platform) { filteredRevenueConds.push(`lp.platform = ?`); filteredRevenueParams.push(platform); }
  if (page) { filteredRevenueConds.push(`lp.slug = ?`); filteredRevenueParams.push(page); }
  if (req.query.from) { filteredRevenueConds.push(`ce.created_at >= ?`); filteredRevenueParams.push(localDateToUtcRange(req.query.from, tz).start); }
  if (req.query.to) { filteredRevenueConds.push(`ce.created_at <= ?`); filteredRevenueParams.push(localDateToUtcRange(req.query.to, tz).end); }
  const filteredRevenueWhere = filteredRevenueConds.length ? 'WHERE ' + filteredRevenueConds.join(' AND ') : '';
  const filteredRevenue = db.prepare(`SELECT COALESCE(SUM(ce.revenue), 0) as total FROM conversion_events ce ${filteredRevenueJoin} ${filteredRevenueWhere}`).get(...filteredRevenueParams).total;

  // Filtered cost (all platforms)
  const filteredCost = db.prepare(`SELECT COALESCE(SUM(l.cost_cents), 0) as total FROM leads l ${join} ${where}`).get(...params).total;

  // Per-platform cost (respects date filter, ignores platform filter)
  const platformCostConds = [];
  const platformCostParams = [];
  if (req.query.from) { platformCostConds.push(`l.created_at >= ?`); platformCostParams.push(localDateToUtcRange(req.query.from, tz).start); }
  if (req.query.to) { platformCostConds.push(`l.created_at <= ?`); platformCostParams.push(localDateToUtcRange(req.query.to, tz).end); }
  const platformCostDateWhere = platformCostConds.length ? ' AND ' + platformCostConds.join(' AND ') : '';

  const googleCost = db.prepare(`SELECT COALESCE(SUM(l.cost_cents), 0) as total FROM leads l JOIN landing_pages lp ON l.landing_page_id = lp.id WHERE lp.platform = 'google' ${platformCostDateWhere}`).get(...platformCostParams).total;
  const metaCost = db.prepare(`SELECT COALESCE(SUM(l.cost_cents), 0) as total FROM leads l JOIN landing_pages lp ON l.landing_page_id = lp.id WHERE lp.platform = 'meta' ${platformCostDateWhere}`).get(...platformCostParams).total;

  res.json({
    totalLeads,
    leadsToday,
    leadsWTD,
    leadsMTD,
    activePages,
    totalPages: db.prepare('SELECT COUNT(*) as count FROM landing_pages').get().count,
    revenueToday,
    revenueWTD,
    revenueMTD,
    costToday,
    costWTD,
    costMTD,
    filteredRevenue,
    filteredCost,
    googleCost,
    metaCost
  });
});

// Leads by traffic source
router.get('/by-source', authenticateToken, (req, res) => {
  const { conditions, params } = buildFilters(req);
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const data = db.prepare(`
    SELECT lp.traffic_source, COUNT(l.id) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    ${where}
    GROUP BY lp.traffic_source
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Leads by platform
router.get('/by-platform', authenticateToken, (req, res) => {
  const { conditions, params } = buildFilters(req);
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const data = db.prepare(`
    SELECT lp.platform, COUNT(l.id) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    ${where}
    GROUP BY lp.platform
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Leads by landing page
router.get('/by-page', authenticateToken, (req, res) => {
  const { conditions, params } = buildFilters(req);
  const where = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

  const data = db.prepare(`
    SELECT lp.id, lp.name, lp.traffic_source, COUNT(l.id) as count
    FROM landing_pages lp
    LEFT JOIN leads l ON l.landing_page_id = lp.id
    ${where}
    GROUP BY lp.id
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Leads over time
router.get('/over-time', authenticateToken, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const { conditions, params } = buildFilters(req);
  const tz = getConfiguredTimezone();
  const offsetStr = getSqliteOffsetStr(tz);

  // Add date range default if no from/to specified
  if (!req.query.from) {
    const todayStr = getTodayInTz(tz);
    const todayDate = new Date(todayStr + 'T00:00:00');
    const startDate = new Date(todayDate);
    startDate.setDate(startDate.getDate() - days);
    const startStr = formatLocalDate(startDate);
    const { start } = localDateToUtcRange(startStr, tz);
    conditions.push(`l.created_at >= ?`);
    params.push(start);
  }

  const needsJoin = req.query.platform || req.query.page;
  const join = needsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const data = db.prepare(`
    SELECT DATE(l.created_at, '${offsetStr}') as date, COUNT(*) as count
    FROM leads l
    ${join}
    ${where}
    GROUP BY DATE(l.created_at, '${offsetStr}')
    ORDER BY date ASC
  `).all(...params);

  res.json(data);
});

// Recent leads
router.get('/recent', authenticateToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const { conditions, params } = buildFilters(req);
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const leads = db.prepare(`
    SELECT l.*, lp.name as landing_page_name, lp.traffic_source
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ?
  `).all(...params, limit);

  res.json(leads);
});

// Platform financials
let fbSpendCache = { data: null, timestamp: 0 };

router.get('/platform-financials', authenticateToken, async (req, res) => {
  try {
    const { from, to } = req.query;
    const tz = getConfiguredTimezone();
    const dateConds = [];
    const dateParams = [];
    const eventDateConds = [];
    const eventDateParams = [];

    if (from) {
      dateConds.push(`l.created_at >= ?`);
      dateParams.push(localDateToUtcRange(from, tz).start);
      eventDateConds.push(`ce.created_at >= ?`);
      eventDateParams.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      dateConds.push(`l.created_at <= ?`);
      dateParams.push(localDateToUtcRange(to, tz).end);
      eventDateConds.push(`ce.created_at <= ?`);
      eventDateParams.push(localDateToUtcRange(to, tz).end);
    }

    const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
    const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

    const platforms = ['google', 'meta', 'bing', 'reddit', 'outbrain'];
    const result = {};

    for (const platform of platforms) {
      // Revenue: from conversion_events.revenue joined through leads → landing_pages.platform
      const revenueRow = db.prepare(`
        SELECT COALESCE(SUM(ce.revenue), 0) as revenue
        FROM conversion_events ce
        JOIN leads l ON ce.lead_id = l.id
        JOIN landing_pages lp ON l.landing_page_id = lp.id
        WHERE lp.platform = ? AND ce.revenue IS NOT NULL ${eventDateWhere}
      `).get(platform, ...eventDateParams);

      // Leads count
      const leadsRow = db.prepare(`
        SELECT COUNT(*) as count FROM leads l
        JOIN landing_pages lp ON l.landing_page_id = lp.id
        WHERE lp.platform = ? ${dateWhere}
      `).get(platform, ...dateParams);

      const revenue = revenueRow.revenue || 0;
      const leads = leadsRow.count || 0;
      let cost = 0;

      if (platform === 'google') {
        // Google cost from leads.cost_cents
        const costRow = db.prepare(`
          SELECT COALESCE(SUM(l.cost_cents), 0) as total
          FROM leads l
          JOIN landing_pages lp ON l.landing_page_id = lp.id
          WHERE lp.platform = 'google' ${dateWhere}
        `).get(...dateParams);
        cost = (costRow.total || 0) / 100;
      } else if (platform === 'meta') {
        // Meta cost from DB (per-lead cost_cents, same as Google)
        const metaCostRow = db.prepare(`
          SELECT COALESCE(SUM(l.cost_cents), 0) as total
          FROM leads l
          JOIN landing_pages lp ON l.landing_page_id = lp.id
          WHERE lp.platform = 'meta' ${dateWhere}
        `).get(...dateParams);
        cost = (metaCostRow.total || 0) / 100;

        // Fallback to Facebook API if no DB costs exist
        if (cost === 0) {
          const now = Date.now();
          if (fbSpendCache.data !== null && now - fbSpendCache.timestamp < 5 * 60 * 1000) {
            cost = fbSpendCache.data;
          } else {
            try {
              const fbConfig = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
              const fbAdsToken = fbConfig?.user_access_token || fbConfig?.page_access_token;
              if (fbConfig && fbConfig.ad_account_id && fbAdsToken) {
                const fbParams = new URLSearchParams({
                  fields: 'spend',
                  access_token: fbAdsToken
                });
                if (from && to) {
                  fbParams.set('time_range', JSON.stringify({ since: from, until: to }));
                } else if (from) {
                  fbParams.set('time_range', JSON.stringify({ since: from, until: getTodayInTz(tz) }));
                } else {
                  fbParams.set('date_preset', 'maximum');
                }
                const normalizedAcctId = fbConfig.ad_account_id.startsWith('act_') ? fbConfig.ad_account_id : 'act_' + fbConfig.ad_account_id;
                const fbRes = await fetch(`https://graph.facebook.com/v21.0/${normalizedAcctId}/insights?${fbParams}`);
                const fbData = await fbRes.json();
                if (fbData.data && fbData.data.length > 0) {
                  cost = parseFloat(fbData.data[0].spend || 0);
                }
              }
            } catch (err) {
              console.error('Failed to fetch Facebook spend:', err.message);
            }
            fbSpendCache = { data: cost, timestamp: now };
          }
        }
      } else {
        // All other platforms: cost from leads.cost_cents
        const otherCostRow = db.prepare(`
          SELECT COALESCE(SUM(l.cost_cents), 0) as total
          FROM leads l
          JOIN landing_pages lp ON l.landing_page_id = lp.id
          WHERE lp.platform = ? ${dateWhere}
        `).get(platform, ...dateParams);
        cost = (otherCostRow.total || 0) / 100;
      }

      const profit = revenue - cost;
      const cpl = leads > 0 ? cost / leads : 0;
      const roas = cost > 0 ? revenue / cost : 0;

      result[platform] = { revenue, cost, profit, leads, cpl, roas };
    }

    res.json(result);
  } catch (err) {
    console.error('Platform financials error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Financials over time (daily leads, cost, revenue, profit)
router.get('/financials-over-time', authenticateToken, (req, res) => {
  try {
    const { conditions, params } = buildFilters(req);
    const tz = getConfiguredTimezone();
    const offsetStr = getSqliteOffsetStr(tz);

    // Default to last 30 days if no from/to specified
    if (!req.query.from) {
      const todayStr = getTodayInTz(tz);
      const todayDate = new Date(todayStr + 'T00:00:00');
      const startDate = new Date(todayDate);
      startDate.setDate(startDate.getDate() - 30);
      const startStr = formatLocalDate(startDate);
      const { start } = localDateToUtcRange(startStr, tz);
      conditions.push(`l.created_at >= ?`);
      params.push(start);
    }

    const needsJoin = req.query.platform || req.query.page;
    const join = needsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Query 1: leads + cost per day from leads table
    const leadsData = db.prepare(`
      SELECT DATE(l.created_at, '${offsetStr}') as date,
             COUNT(*) as leads,
             COALESCE(SUM(l.cost_cents), 0) as cost_cents
      FROM leads l
      ${join}
      ${where}
      GROUP BY DATE(l.created_at, '${offsetStr}')
      ORDER BY date ASC
    `).all(...params);

    // Query 2: revenue per day from conversion_events
    // Rebuild conditions for ce table
    const ceConds = [];
    const ceParams = [];
    if (req.query.platform) {
      ceConds.push(`lp.platform = ?`);
      ceParams.push(req.query.platform);
    }
    if (req.query.page) {
      ceConds.push(`lp.slug = ?`);
      ceParams.push(req.query.page);
    }
    if (req.query.from) {
      ceConds.push(`ce.created_at >= ?`);
      ceParams.push(localDateToUtcRange(req.query.from, tz).start);
    }
    if (req.query.to) {
      ceConds.push(`ce.created_at <= ?`);
      ceParams.push(localDateToUtcRange(req.query.to, tz).end);
    }
    if (!req.query.from) {
      const todayStr = getTodayInTz(tz);
      const todayDate = new Date(todayStr + 'T00:00:00');
      const startDate = new Date(todayDate);
      startDate.setDate(startDate.getDate() - 30);
      const startStr = formatLocalDate(startDate);
      const { start } = localDateToUtcRange(startStr, tz);
      ceConds.push(`ce.created_at >= ?`);
      ceParams.push(start);
    }

    const ceNeedsJoin = req.query.platform || req.query.page;
    const ceJoin = ceNeedsJoin
      ? 'JOIN leads l ON ce.lead_id = l.id LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id'
      : '';
    const ceWhere = ceConds.length > 0 ? 'WHERE ' + ceConds.join(' AND ') : '';

    const revenueData = db.prepare(`
      SELECT DATE(ce.created_at, '${offsetStr}') as date,
             COALESCE(SUM(ce.revenue), 0) as revenue
      FROM conversion_events ce
      ${ceJoin}
      ${ceWhere}
      GROUP BY DATE(ce.created_at, '${offsetStr}')
      ORDER BY date ASC
    `).all(...ceParams);

    // Merge into a single array keyed by date
    const revenueMap = {};
    for (const r of revenueData) {
      revenueMap[r.date] = r.revenue || 0;
    }

    // Also collect dates from revenue that may not have leads
    const allDates = new Set(leadsData.map(d => d.date));
    for (const r of revenueData) allDates.add(r.date);

    const leadsMap = {};
    for (const d of leadsData) {
      leadsMap[d.date] = d;
    }

    const merged = [...allDates].sort().map(date => {
      const ld = leadsMap[date] || { leads: 0, cost_cents: 0 };
      const revenue = revenueMap[date] || 0;
      const cost = (ld.cost_cents || 0) / 100;
      return {
        date,
        leads: ld.leads || 0,
        cost,
        revenue,
        profit: revenue - cost
      };
    });

    res.json(merged);
  } catch (err) {
    console.error('Financials over time error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pipeline summary (leads grouped by latest conversion stage)
router.get('/pipeline-summary', authenticateToken, (req, res) => {
  try {
    const { conditions, params } = buildFilters(req);
    const needsJoin = req.query.platform || req.query.page;
    const join = needsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // For each lead, find the latest conversion_action_name
    const data = db.prepare(`
      SELECT
        COALESCE(
          (SELECT ce.conversion_action_name
           FROM conversion_events ce
           WHERE ce.lead_id = l.id
           ORDER BY ce.created_at DESC
           LIMIT 1),
          'New'
        ) as stage,
        COUNT(*) as count
      FROM leads l
      ${join}
      ${where}
      GROUP BY stage
      ORDER BY count DESC
    `).all(...params);

    res.json({ stages: data });
  } catch (err) {
    console.error('Pipeline summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Real ad spend from Google Ads API + Facebook Marketing API
router.get('/real-ad-spend', authenticateToken, async (req, res) => {
  const { from, to } = req.query;
  let googleSpend = null;
  let metaSpend = null;

  // --- Google Ads: total account spend via API ---
  try {
    const gConfig = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (gConfig && gConfig.refresh_token_encrypted && gConfig.customer_id) {
      const devToken = GOOGLE_DEVELOPER_TOKEN || (gConfig.developer_token_encrypted ? decrypt(gConfig.developer_token_encrypted) : null);
      if (devToken) {
        const accessToken = await getGoogleAccessToken(gConfig);
        const customerId = gConfig.customer_id.replace(/-/g, '');
        const lid = gConfig.login_customer_id || GOOGLE_LOGIN_CUSTOMER_ID;
        const headers = {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': devToken,
          'Content-Type': 'application/json'
        };
        if (lid) headers['login-customer-id'] = lid.replace(/-/g, '');

        // Build date conditions for GAQL
        let dateFilter = '';
        if (from && to) {
          dateFilter = `WHERE segments.date >= '${from}' AND segments.date <= '${to}'`;
        } else if (from) {
          dateFilter = `WHERE segments.date >= '${from}'`;
        } else if (to) {
          dateFilter = `WHERE segments.date <= '${to}'`;
        }

        const gaqlQuery = `SELECT metrics.cost_micros FROM customer ${dateFilter}`;
        const gRes = await fetch(`https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: gaqlQuery, pageSize: 1 })
        });
        const gData = await gRes.json();
        if (gData.results && gData.results.length > 0) {
          const costMicros = parseInt(gData.results[0].metrics.costMicros || '0', 10);
          googleSpend = costMicros / 1000000;
        } else if (!gData.error) {
          googleSpend = 0;
        }
      }
    }
  } catch (e) {
    console.error('Real ad spend - Google error:', e.message);
  }

  // --- Facebook: total account spend via Marketing API ---
  try {
    const fbConfig = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
    if (fbConfig && fbConfig.ad_account_id) {
      const adsToken = fbConfig.user_access_token || fbConfig.page_access_token;
      if (adsToken) {
        const adAccountId = fbConfig.ad_account_id.startsWith('act_') ? fbConfig.ad_account_id : 'act_' + fbConfig.ad_account_id;
        const fbParams = new URLSearchParams({ fields: 'spend', access_token: adsToken });
        if (from && to) {
          fbParams.set('time_range', JSON.stringify({ since: from, until: to }));
        } else if (from) {
          fbParams.set('time_range', JSON.stringify({ since: from, until: getTodayInTz(getConfiguredTimezone()) }));
        } else {
          fbParams.set('date_preset', 'maximum');
        }
        const fbRes = await fetch(`https://graph.facebook.com/v21.0/${adAccountId}/insights?${fbParams}`);
        const fbData = await fbRes.json();
        if (fbData.data && fbData.data.length > 0) {
          metaSpend = parseFloat(fbData.data[0].spend || 0);
        } else if (!fbData.error) {
          metaSpend = 0;
        }
      }
    }
  } catch (e) {
    console.error('Real ad spend - Meta error:', e.message);
  }

  res.json({ googleSpend, metaSpend });
});

// Google Ads: Summary stats
router.get('/google-ads/summary', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const dateConds = [];
  const dateParams = [];
  const eventDateConds = [];
  const eventDateParams = [];

  if (from) {
    dateConds.push(`l.created_at >= ?`);
    dateParams.push(localDateToUtcRange(from, tz).start);
    eventDateConds.push(`ce.created_at >= ?`);
    eventDateParams.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    dateConds.push(`l.created_at <= ?`);
    dateParams.push(localDateToUtcRange(to, tz).end);
    eventDateConds.push(`ce.created_at <= ?`);
    eventDateParams.push(localDateToUtcRange(to, tz).end);
  }

  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
  const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

  const leadStats = db.prepare(`
    SELECT COUNT(*) as total_leads,
           COALESCE(SUM(l.cost_cents), 0) as total_cost_cents,
           COUNT(l.cost_cents) as leads_with_cost
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'google' ${dateWhere}
  `).get(...dateParams);

  const eventStats = db.prepare(`
    SELECT COUNT(*) as events_sent
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'google' AND ce.status = 'sent' ${eventDateWhere}
  `).get(...eventDateParams);

  const totalLeads = leadStats.total_leads || 0;
  const totalCostCents = leadStats.total_cost_cents || 0;

  res.json({
    total_leads: totalLeads,
    total_cost_cents: totalCostCents,
    leads_with_cost: leadStats.leads_with_cost || 0,
    avg_cpl_cents: totalLeads > 0 ? Math.round(totalCostCents / totalLeads) : 0,
    events_sent: eventStats.events_sent || 0
  });
});

// Google Ads: Conversion events breakdown by type
router.get('/google-ads/events-breakdown', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`ce.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`ce.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const data = db.prepare(`
    SELECT ce.conversion_action_name, COUNT(*) as count
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'google'
      AND ce.conversion_action_name IS NOT NULL
      ${dateWhere}
    GROUP BY ce.conversion_action_name
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Google Ads: Leads with latest conversion status
router.get('/google-ads/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'google' ${dateWhere}
  `).get(...params).count;

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.cost_cents, l.cost_currency, l.gclid, l.eli_clickid, l.rt_clickid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo, l.stage,
           l.contract_sign_date, l.total_debt_sign, l.is_blocked,
           lp.name as landing_page_name,
           v.utm_campaign, v.ip_address,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE lp.platform = 'google' ${dateWhere}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// Bing Ads: Summary stats
router.get('/bing-ads/summary', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const dateConds = [];
  const dateParams = [];
  const eventDateConds = [];
  const eventDateParams = [];

  if (from) {
    dateConds.push(`l.created_at >= ?`);
    dateParams.push(localDateToUtcRange(from, tz).start);
    eventDateConds.push(`ce.created_at >= ?`);
    eventDateParams.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    dateConds.push(`l.created_at <= ?`);
    dateParams.push(localDateToUtcRange(to, tz).end);
    eventDateConds.push(`ce.created_at <= ?`);
    eventDateParams.push(localDateToUtcRange(to, tz).end);
  }

  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
  const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

  const leadStats = db.prepare(`
    SELECT COUNT(*) as total_leads
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'bing' ${dateWhere}
  `).get(...dateParams);

  const eventStats = db.prepare(`
    SELECT COUNT(*) as events_sent
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'bing' AND ce.status = 'sent' ${eventDateWhere}
  `).get(...eventDateParams);

  res.json({
    total_leads: leadStats.total_leads || 0,
    events_sent: eventStats.events_sent || 0
  });
});

// Bing Ads: Conversion events breakdown by type
router.get('/bing-ads/events-breakdown', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`ce.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`ce.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const data = db.prepare(`
    SELECT ce.conversion_action_name, COUNT(*) as count
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'bing'
      AND ce.conversion_action_name IS NOT NULL
      ${dateWhere}
    GROUP BY ce.conversion_action_name
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Bing Ads: Leads with latest conversion status
router.get('/bing-ads/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'bing' ${dateWhere}
  `).get(...params).count;

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid, l.msclkid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo,
           l.stage, l.contract_sign_date, l.total_debt_sign, l.is_blocked,
           lp.name as landing_page_name,
           v.utm_campaign, v.ip_address,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE lp.platform = 'bing' ${dateWhere}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// Reddit: Summary stats
router.get('/reddit/summary', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const dateConds = [];
  const dateParams = [];
  const eventDateConds = [];
  const eventDateParams = [];

  if (from) {
    dateConds.push(`l.created_at >= ?`);
    dateParams.push(localDateToUtcRange(from, tz).start);
    eventDateConds.push(`ce.created_at >= ?`);
    eventDateParams.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    dateConds.push(`l.created_at <= ?`);
    dateParams.push(localDateToUtcRange(to, tz).end);
    eventDateConds.push(`ce.created_at <= ?`);
    eventDateParams.push(localDateToUtcRange(to, tz).end);
  }

  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
  const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

  const leadStats = db.prepare(`
    SELECT COUNT(*) as total_leads
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'reddit' ${dateWhere}
  `).get(...dateParams);

  const eventStats = db.prepare(`
    SELECT COUNT(*) as events_sent
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'reddit' AND ce.status = 'sent' ${eventDateWhere}
  `).get(...eventDateParams);

  res.json({
    total_leads: leadStats.total_leads || 0,
    events_sent: eventStats.events_sent || 0
  });
});

// Reddit: Conversion events breakdown by type
router.get('/reddit/events-breakdown', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`ce.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`ce.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const data = db.prepare(`
    SELECT ce.conversion_action_name, COUNT(*) as count
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'reddit'
      AND ce.conversion_action_name IS NOT NULL
      ${dateWhere}
    GROUP BY ce.conversion_action_name
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Reddit: Leads with latest conversion status
router.get('/reddit/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'reddit' ${dateWhere}
  `).get(...params).count;

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo,
           l.stage, l.contract_sign_date, l.total_debt_sign, l.is_blocked,
           lp.name as landing_page_name,
           v.utm_campaign, v.ip_address,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE lp.platform = 'reddit' ${dateWhere}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// Outbrain: Summary stats
router.get('/outbrain/summary', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const dateConds = [];
  const dateParams = [];
  const eventDateConds = [];
  const eventDateParams = [];

  if (from) {
    dateConds.push(`l.created_at >= ?`);
    dateParams.push(localDateToUtcRange(from, tz).start);
    eventDateConds.push(`ce.created_at >= ?`);
    eventDateParams.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    dateConds.push(`l.created_at <= ?`);
    dateParams.push(localDateToUtcRange(to, tz).end);
    eventDateConds.push(`ce.created_at <= ?`);
    eventDateParams.push(localDateToUtcRange(to, tz).end);
  }

  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
  const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

  const leadStats = db.prepare(`
    SELECT COUNT(*) as total_leads
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'outbrain' ${dateWhere}
  `).get(...dateParams);

  const eventStats = db.prepare(`
    SELECT COUNT(*) as events_sent
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'outbrain' AND ce.status = 'sent' ${eventDateWhere}
  `).get(...eventDateParams);

  res.json({
    total_leads: leadStats.total_leads || 0,
    events_sent: eventStats.events_sent || 0
  });
});

// Outbrain: Conversion events breakdown by type
router.get('/outbrain/events-breakdown', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`ce.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`ce.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const data = db.prepare(`
    SELECT ce.conversion_action_name, COUNT(*) as count
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'outbrain'
      AND ce.conversion_action_name IS NOT NULL
      ${dateWhere}
    GROUP BY ce.conversion_action_name
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Outbrain: Leads with latest conversion status
router.get('/outbrain/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'outbrain' ${dateWhere}
  `).get(...params).count;

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo,
           l.stage, l.contract_sign_date, l.total_debt_sign, l.is_blocked,
           lp.name as landing_page_name,
           v.utm_campaign, v.ip_address,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE lp.platform = 'outbrain' ${dateWhere}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// Meta Ads: Summary stats
router.get('/meta-ads/summary', authenticateToken, async (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const dateConds = [];
  const dateParams = [];
  const eventDateConds = [];
  const eventDateParams = [];

  if (from) {
    dateConds.push(`l.created_at >= ?`);
    dateParams.push(localDateToUtcRange(from, tz).start);
    eventDateConds.push(`ce.created_at >= ?`);
    eventDateParams.push(localDateToUtcRange(from, tz).start);
  }
  if (to) {
    dateConds.push(`l.created_at <= ?`);
    dateParams.push(localDateToUtcRange(to, tz).end);
    eventDateConds.push(`ce.created_at <= ?`);
    eventDateParams.push(localDateToUtcRange(to, tz).end);
  }

  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';
  const eventDateWhere = eventDateConds.length ? ' AND ' + eventDateConds.join(' AND ') : '';

  const leadStats = db.prepare(`
    SELECT COUNT(*) as total_leads
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta' ${dateWhere}
  `).get(...dateParams);

  // Count instant form leads (hidden_fields contains facebook_instant_form source)
  const instantFormCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta' AND l.hidden_fields LIKE '%"source":"facebook_instant_form"%' ${dateWhere}
  `).get(...dateParams).count;

  const eventStats = db.prepare(`
    SELECT COUNT(*) as events_sent
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta' AND ce.status = 'sent' ${eventDateWhere}
  `).get(...eventDateParams);

  const totalLeads = leadStats.total_leads || 0;

  // Cost aggregation from leads.cost_cents (per-lead attributed costs)
  const costStats = db.prepare(`
    SELECT COALESCE(SUM(l.cost_cents), 0) as total_cost_cents,
           COUNT(l.cost_cents) as leads_with_cost
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta' ${dateWhere}
  `).get(...dateParams);

  const dbCostCents = costStats.total_cost_cents || 0;

  // Also fetch total spend from Facebook API for the selected date range
  let fbSpend = 0;
  try {
    const fbConfig = db.prepare('SELECT ad_account_id, page_access_token, user_access_token FROM facebook_config WHERE id = 1').get();
    if (fbConfig && fbConfig.ad_account_id) {
      const adsToken = fbConfig.user_access_token || fbConfig.page_access_token;
      const adAccountId = fbConfig.ad_account_id.startsWith('act_') ? fbConfig.ad_account_id : 'act_' + fbConfig.ad_account_id;

      if (adsToken) {
        const fbParams = new URLSearchParams({
          fields: 'spend',
          access_token: adsToken
        });

        // Use time_range if dates specified, otherwise use a preset
        if (from && to) {
          fbParams.set('time_range', JSON.stringify({ since: from, until: to }));
        } else if (from) {
          fbParams.set('time_range', JSON.stringify({ since: from, until: getTodayInTz(tz) }));
        } else {
          fbParams.set('date_preset', 'maximum');
        }

        const fbRes = await fetch(`https://graph.facebook.com/v21.0/${adAccountId}/insights?${fbParams}`);
        const fbData = await fbRes.json();
        if (fbData.data && fbData.data.length > 0) {
          fbSpend = parseFloat(fbData.data[0].spend || 0);
        }
      }
    }
  } catch (e) {
    console.error('Meta summary: FB API error:', e.message);
  }

  // Use FB API spend if available, otherwise fall back to DB costs
  const totalSpendCents = fbSpend > 0 ? Math.round(fbSpend * 100) : dbCostCents;

  res.json({
    total_leads: totalLeads,
    instant_form_leads: instantFormCount || 0,
    landing_page_leads: totalLeads - (instantFormCount || 0),
    events_sent: eventStats.events_sent || 0,
    total_cost_cents: totalSpendCents,
    leads_with_cost: costStats.leads_with_cost || 0,
    avg_cpl_cents: totalLeads > 0 ? Math.round(totalSpendCents / totalLeads) : 0
  });
});

// Meta Ads: Conversion events breakdown by type
router.get('/meta-ads/events-breakdown', authenticateToken, (req, res) => {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`ce.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`ce.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const data = db.prepare(`
    SELECT ce.conversion_action_name, COUNT(*) as count
    FROM conversion_events ce
    JOIN leads l ON ce.lead_id = l.id
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta'
      AND ce.conversion_action_name IS NOT NULL
      ${dateWhere}
    GROUP BY ce.conversion_action_name
    ORDER BY count DESC
  `).all(...params);

  res.json(data);
});

// Meta Ads: Leads with latest conversion status
router.get('/meta-ads/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conds = [];
  const params = [];

  if (from) { conds.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conds.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  const dateWhere = conds.length ? ' AND ' + conds.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE lp.platform = 'meta' ${dateWhere}
  `).get(...params).count;

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid, l.fbclid, l.hidden_fields, l.created_at, l.is_blocked,
           l.cost_cents,
           lp.name as landing_page_name,
           v.ip_address,
           CASE WHEN l.hidden_fields LIKE '%"source":"facebook_instant_form"%' THEN 'Instant Form' ELSE 'Landing Page' END as lead_source,
           (
             SELECT ce.conversion_action_name
             FROM conversion_events ce
             WHERE ce.lead_id = l.id
             ORDER BY ce.created_at DESC
             LIMIT 1
           ) as current_status
    FROM leads l
    JOIN landing_pages lp ON l.landing_page_id = lp.id
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid AND l.eli_clickid != ''
    WHERE lp.platform = 'meta' ${dateWhere}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// ─── Organic Traffic Endpoints ───────────────────────────────────────────────

const PAID_MEDIUMS = ['cpc', 'ppc', 'paid', 'paidsearch'];
const SEARCH_ENGINES = ['google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex'];
const SOCIAL_DOMAINS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'youtube', 'reddit', 'pinterest', 't.co', 'x.com'];

// SQL CASE expression to classify traffic type from visitors table
const TRAFFIC_TYPE_CASE = `
  CASE
    WHEN v.gclid IS NOT NULL AND v.gclid != ''
      THEN 'paid'
    WHEN LOWER(v.utm_medium) IN (${PAID_MEDIUMS.map(() => '?').join(',')})
      THEN 'paid'
    WHEN v.referrer_url IS NOT NULL AND v.referrer_url != '' AND (
      ${SEARCH_ENGINES.map(() => `LOWER(v.referrer_url) LIKE ?`).join(' OR ')}
    ) THEN 'organic_search'
    WHEN v.referrer_url IS NOT NULL AND v.referrer_url != '' AND (
      ${SOCIAL_DOMAINS.map(() => `LOWER(v.referrer_url) LIKE ?`).join(' OR ')}
    ) THEN 'social'
    WHEN v.referrer_url IS NOT NULL AND v.referrer_url != ''
      THEN 'referral'
    ELSE 'direct'
  END
`;

// Params needed to bind for the TRAFFIC_TYPE_CASE
function trafficTypeParams() {
  return [
    ...PAID_MEDIUMS,
    ...SEARCH_ENGINES.map(d => `%${d}.%`),
    ...SOCIAL_DOMAINS.map(d => `%${d}.%`)
  ];
}

function buildVisitorDateFilters(req) {
  const { from, to } = req.query;
  const tz = getConfiguredTimezone();
  const conditions = [];
  const params = [];
  if (from) { conditions.push(`v.first_visit >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conditions.push(`v.first_visit <= ?`); params.push(localDateToUtcRange(to, tz).end); }
  return { conditions, params };
}

// Organic summary
router.get('/organic/summary', authenticateToken, (req, res) => {
  const { conditions, params } = buildVisitorDateFilters(req);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const ttp = trafficTypeParams();

  const rows = db.prepare(`
    SELECT
      ${TRAFFIC_TYPE_CASE} as traffic_type,
      COUNT(*) as cnt,
      SUM(CASE WHEN v.converted = 1 THEN 1 ELSE 0 END) as converted
    FROM visitors v
    ${where}
    GROUP BY traffic_type
  `).all(...ttp, ...params);

  const byType = {};
  rows.forEach(r => { byType[r.traffic_type] = r; });

  const organicSearch = (byType.organic_search || { cnt: 0, converted: 0 });
  const social = (byType.social || { cnt: 0, converted: 0 });
  const referral = (byType.referral || { cnt: 0, converted: 0 });
  const direct = (byType.direct || { cnt: 0, converted: 0 });

  const totalVisitors = organicSearch.cnt + social.cnt + referral.cnt + direct.cnt;
  const convertedVisitors = organicSearch.converted + social.converted + referral.converted + direct.converted;

  res.json({
    totalVisitors,
    convertedVisitors,
    conversionRate: totalVisitors > 0 ? Math.round((convertedVisitors / totalVisitors) * 10000) / 100 : 0,
    directVisitors: direct.cnt,
    organicSearchVisitors: organicSearch.cnt,
    socialVisitors: social.cnt,
    referralVisitors: referral.cnt
  });
});

// Organic over time
router.get('/organic/over-time', authenticateToken, (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const { conditions, params } = buildVisitorDateFilters(req);
  const tz = getConfiguredTimezone();
  const offsetStr = getSqliteOffsetStr(tz);

  // Exclude paid traffic
  conditions.push(`(v.gclid IS NULL OR v.gclid = '')`);
  conditions.push(`(v.utm_medium IS NULL OR LOWER(v.utm_medium) NOT IN (${PAID_MEDIUMS.map(() => '?').join(',')}))`);
  params.push(...PAID_MEDIUMS);

  if (!req.query.from) {
    const todayStr = getTodayInTz(tz);
    const todayDate = new Date(todayStr + 'T00:00:00');
    const startDate = new Date(todayDate);
    startDate.setDate(startDate.getDate() - days);
    const startStr = formatLocalDate(startDate);
    const { start } = localDateToUtcRange(startStr, tz);
    conditions.push(`v.first_visit >= ?`);
    params.push(start);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const data = db.prepare(`
    SELECT DATE(v.first_visit, '${offsetStr}') as date, COUNT(*) as count
    FROM visitors v
    ${where}
    GROUP BY DATE(v.first_visit, '${offsetStr}')
    ORDER BY date ASC
  `).all(...params);

  res.json(data);
});

// Top referrers
router.get('/organic/top-referrers', authenticateToken, (req, res) => {
  const { conditions, params } = buildVisitorDateFilters(req);

  // Exclude paid traffic
  conditions.push(`(v.gclid IS NULL OR v.gclid = '')`);
  conditions.push(`(v.utm_medium IS NULL OR LOWER(v.utm_medium) NOT IN (${PAID_MEDIUMS.map(() => '?').join(',')}))`);
  params.push(...PAID_MEDIUMS);

  // Must have a referrer
  conditions.push(`v.referrer_url IS NOT NULL`);
  conditions.push(`v.referrer_url != ''`);

  const where = 'WHERE ' + conditions.join(' AND ');

  const data = db.prepare(`
    SELECT
      CASE
        WHEN INSTR(REPLACE(REPLACE(LOWER(v.referrer_url), 'https://', ''), 'http://', ''), '/') > 0
        THEN SUBSTR(REPLACE(REPLACE(LOWER(v.referrer_url), 'https://', ''), 'http://', ''), 1, INSTR(REPLACE(REPLACE(LOWER(v.referrer_url), 'https://', ''), 'http://', ''), '/') - 1)
        ELSE REPLACE(REPLACE(LOWER(v.referrer_url), 'https://', ''), 'http://', '')
      END as domain,
      COUNT(*) as visitors,
      SUM(CASE WHEN v.converted = 1 THEN 1 ELSE 0 END) as conversions
    FROM visitors v
    ${where}
    GROUP BY domain
    ORDER BY visitors DESC
    LIMIT 20
  `).all(...params);

  res.json(data);
});

// Organic leads
router.get('/organic/leads', authenticateToken, (req, res) => {
  const { from, to, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const tz = getConfiguredTimezone();
  const conditions = [];
  const params = [];

  if (from) { conditions.push(`l.created_at >= ?`); params.push(localDateToUtcRange(from, tz).start); }
  if (to) { conditions.push(`l.created_at <= ?`); params.push(localDateToUtcRange(to, tz).end); }

  // Exclude paid: join visitors via eli_clickid, filter non-paid
  conditions.push(`(v.gclid IS NULL OR v.gclid = '')`);
  conditions.push(`(v.utm_medium IS NULL OR LOWER(v.utm_medium) NOT IN (${PAID_MEDIUMS.map(() => '?').join(',')}))`);
  params.push(...PAID_MEDIUMS);

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM leads l
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid
    ${where}
  `).get(...params).count;

  const ttp = trafficTypeParams();

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone,
           l.created_at, v.referrer_url, v.utm_source, v.utm_medium,
           ${TRAFFIC_TYPE_CASE} as traffic_type
    FROM leads l
    LEFT JOIN visitors v ON l.eli_clickid = v.eli_clickid
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...ttp, ...params, parseInt(limit), offset);

  res.json({
    leads,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
});

// ─── Campaigns Performance ─────────────────────────────────────────────────

router.get('/campaigns/performance', authenticateToken, (req, res) => {
  try {
    const { from, to, source, medium, platform } = req.query;
    const tz = getConfiguredTimezone();
    const visitorConds = [];
    const visitorParams = [];

    if (from) { visitorConds.push(`v.first_visit >= ?`); visitorParams.push(localDateToUtcRange(from, tz).start); }
    if (to) { visitorConds.push(`v.first_visit <= ?`); visitorParams.push(localDateToUtcRange(to, tz).end); }
    if (source) { visitorConds.push(`v.utm_source = ?`); visitorParams.push(source); }
    if (medium) { visitorConds.push(`v.utm_medium = ?`); visitorParams.push(medium); }
    if (platform) { visitorConds.push(`v.utm_medium = ?`); visitorParams.push(platform); }

    // Only include visitors with a campaign
    visitorConds.push(`v.utm_campaign IS NOT NULL`);
    visitorConds.push(`v.utm_campaign != ''`);

    const visitorWhere = 'WHERE ' + visitorConds.join(' AND ');

    // Main query: group visitors by campaign, join to leads for form-answer counts
    const rows = db.prepare(`
      SELECT
        v.utm_campaign,
        v.utm_source,
        v.utm_medium,
        COUNT(DISTINCT v.id) as visitors,
        COUNT(DISTINCT l.id) as leads,
        COUNT(DISTINCT CASE WHEN l.debt_amount IS NOT NULL AND l.debt_amount != '' AND l.debt_amount != '0' THEN l.id END) as answered_debt,
        COUNT(DISTINCT CASE WHEN l.has_mca IS NOT NULL AND l.has_mca != '' THEN l.id END) as answered_mca
      FROM visitors v
      LEFT JOIN leads l ON v.lead_id = l.id
      ${visitorWhere}
      GROUP BY v.utm_campaign, v.utm_source, v.utm_medium
      ORDER BY visitors DESC
    `).all(...visitorParams);

    // Second query: event breakdowns grouped by campaign + event name
    const eventConds = [...visitorConds.filter(c => c.startsWith('v.'))];
    const eventParams = [...visitorParams];

    const eventRows = db.prepare(`
      SELECT
        v.utm_campaign,
        v.utm_source,
        v.utm_medium,
        ce.conversion_action_name,
        COUNT(ce.id) as event_count
      FROM conversion_events ce
      JOIN leads l ON ce.lead_id = l.id
      JOIN visitors v ON v.lead_id = l.id
      ${visitorWhere}
      AND ce.conversion_action_name IS NOT NULL
      GROUP BY v.utm_campaign, v.utm_source, v.utm_medium, ce.conversion_action_name
    `).all(...visitorParams);

    // Build event map: campaign_key -> { eventName: count }
    const eventMap = {};
    for (const er of eventRows) {
      const key = `${er.utm_campaign}||${er.utm_source}||${er.utm_medium}`;
      if (!eventMap[key]) eventMap[key] = {};
      eventMap[key][er.conversion_action_name] = er.event_count;
    }

    // Merge events into rows
    const campaigns = rows.map(r => {
      const key = `${r.utm_campaign}||${r.utm_source}||${r.utm_medium}`;
      return {
        ...r,
        events: eventMap[key] || {}
      };
    });

    res.json({ campaigns });
  } catch (err) {
    console.error('Campaigns performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
