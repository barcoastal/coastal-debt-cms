const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, localDateToUtcRange, getTodayInTz, getTimezoneOffsetHours } = require('../lib/timezone');

const router = express.Router();

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

  const tz = getConfiguredTimezone();
  const todayStr = getTodayInTz(tz);
  const { start: todayStart, end: todayEnd } = localDateToUtcRange(todayStr, tz);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const leadsToday = db.prepare(countQuery(`l.created_at >= ? AND l.created_at <= ?`)).get(...params, todayStart, todayEnd).count;
  const leadsThisWeek = db.prepare(countQuery(`l.created_at >= ?`)).get(...params, weekAgo).count;
  const leadsThisMonth = db.prepare(countQuery(`l.created_at >= ?`)).get(...params, monthAgo).count;
  const activePages = db.prepare('SELECT COUNT(*) as count FROM landing_pages WHERE is_active = 1').get().count;

  // Revenue metrics
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(revenue), 0) as total FROM conversion_events WHERE revenue IS NOT NULL').get().total;
  const revenueThisMonth = db.prepare('SELECT COALESCE(SUM(revenue), 0) as total FROM conversion_events WHERE revenue IS NOT NULL AND created_at >= ?').get(monthAgo).total;
  const totalCostCents = db.prepare(`SELECT COALESCE(SUM(l.cost_cents), 0) as total FROM leads l ${join} ${where}`).get(...params).total;

  res.json({
    totalLeads: db.prepare(`SELECT COUNT(*) as count FROM leads l ${join} ${where}`).get(...params).count,
    leadsToday,
    leadsThisWeek,
    leadsThisMonth,
    activePages,
    totalPages: db.prepare('SELECT COUNT(*) as count FROM landing_pages').get().count,
    totalRevenue,
    revenueThisMonth,
    totalCostCents
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

  // Add date range default if no from/to specified
  if (!req.query.from) {
    conditions.push(`l.created_at >= DATE('now', '-${days} days')`);
  }

  const needsJoin = req.query.platform || req.query.page;
  const join = needsJoin ? 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id' : '';
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const tzOffset = getTimezoneOffsetHours(getConfiguredTimezone());
  const offsetStr = (tzOffset >= 0 ? '+' : '') + tzOffset.toFixed(1) + ' hours';
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
    const platforms = ['google', 'meta', 'bing'];
    const result = {};

    for (const platform of platforms) {
      // Revenue: from conversion_events.revenue joined through leads → landing_pages.platform
      const revenueRow = db.prepare(`
        SELECT COALESCE(SUM(ce.revenue), 0) as revenue
        FROM conversion_events ce
        JOIN leads l ON ce.lead_id = l.id
        JOIN landing_pages lp ON l.landing_page_id = lp.id
        WHERE lp.platform = ? AND ce.revenue IS NOT NULL
      `).get(platform);

      // Leads count
      const leadsRow = db.prepare(`
        SELECT COUNT(*) as count FROM leads l
        JOIN landing_pages lp ON l.landing_page_id = lp.id
        WHERE lp.platform = ?
      `).get(platform);

      const revenue = revenueRow.revenue || 0;
      const leads = leadsRow.count || 0;
      let cost = 0;

      if (platform === 'google') {
        // Google cost from leads.cost_cents
        const costRow = db.prepare(`
          SELECT COALESCE(SUM(l.cost_cents), 0) as total
          FROM leads l
          JOIN landing_pages lp ON l.landing_page_id = lp.id
          WHERE lp.platform = 'google'
        `).get();
        cost = (costRow.total || 0) / 100;
      } else if (platform === 'meta') {
        // Meta cost from Facebook Marketing API (cached 5 min)
        const now = Date.now();
        if (fbSpendCache.data !== null && now - fbSpendCache.timestamp < 5 * 60 * 1000) {
          cost = fbSpendCache.data;
        } else {
          try {
            const fbConfig = db.prepare('SELECT * FROM facebook_config WHERE id = 1').get();
            if (fbConfig && fbConfig.ad_account_id && fbConfig.page_access_token) {
              const params = new URLSearchParams({
                fields: 'spend',
                date_preset: 'maximum',
                access_token: fbConfig.page_access_token
              });
              const fbRes = await fetch(`https://graph.facebook.com/v21.0/${fbConfig.ad_account_id}/insights?${params}`);
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
      // Bing: cost = 0 (stub)

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
    SELECT l.id, l.full_name, l.company_name, l.email, l.phone,
           l.cost_cents, l.cost_currency, l.gclid, l.eli_clickid, l.rt_clickid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo, l.stage,
           l.contract_sign_date, l.total_debt_sign,
           lp.name as landing_page_name,
           v.utm_campaign,
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
    SELECT l.id, l.full_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid, l.msclkid,
           l.created_at, l.has_mca, l.transfer_status, l.five9_dispo,
           l.stage, l.contract_sign_date, l.total_debt_sign,
           lp.name as landing_page_name,
           v.utm_campaign,
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

// Meta Ads: Summary stats
router.get('/meta-ads/summary', authenticateToken, (req, res) => {
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

  res.json({
    total_leads: totalLeads,
    instant_form_leads: instantFormCount || 0,
    landing_page_leads: totalLeads - (instantFormCount || 0),
    events_sent: eventStats.events_sent || 0
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
    SELECT l.id, l.full_name, l.company_name, l.email, l.phone,
           l.eli_clickid, l.rt_clickid, l.fbclid, l.hidden_fields, l.created_at,
           lp.name as landing_page_name,
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

  // Exclude paid traffic
  conditions.push(`(v.gclid IS NULL OR v.gclid = '')`);
  conditions.push(`(v.utm_medium IS NULL OR LOWER(v.utm_medium) NOT IN (${PAID_MEDIUMS.map(() => '?').join(',')}))`);
  params.push(...PAID_MEDIUMS);

  if (!req.query.from) {
    conditions.push(`v.first_visit >= DATE('now', '-' || ? || ' days')`);
    params.push(days);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

  const tzOffset = getTimezoneOffsetHours(getConfiguredTimezone());
  const offsetStr = (tzOffset >= 0 ? '+' : '') + tzOffset.toFixed(1) + ' hours';
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
    SELECT l.id, l.full_name, l.company_name, l.email, l.phone,
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

module.exports = router;
