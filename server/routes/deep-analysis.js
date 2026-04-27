const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, localDateToUtcRange, getSqliteOffsetStr } = require('../lib/timezone');

const router = express.Router();

// Helper: build WHERE clauses for date range + platform
function buildFilters(req, tableAlias = 'l', pageAlias = 'lp') {
  const { platform, from, to } = req.query;
  const conditions = [];
  const params = [];

  if (platform) {
    conditions.push(`${pageAlias}.platform = ?`);
    params.push(platform);
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

// GET /api/deep-analysis/scorecard
// Returns per-platform: spend, leads, cpl, revenue, roi, conv_rate
router.get('/scorecard', authenticateToken, (req, res) => {
  try {
    const { conditions, params } = buildFilters(req);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT
        COALESCE(lp.platform, 'other') AS platform,
        COUNT(l.id) AS leads,
        COALESCE(SUM(l.cost_cents), 0) AS spend_cents,
        COALESCE(SUM(ce.revenue), 0) AS revenue,
        COUNT(DISTINCT CASE WHEN ce.id IS NOT NULL THEN l.id END) AS converted_leads
      FROM leads l
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      LEFT JOIN conversion_events ce ON ce.lead_id = l.id
      ${where}
      GROUP BY COALESCE(lp.platform, 'other')
      ORDER BY leads DESC
    `).all(...params);

    const scorecard = rows.map(r => {
      const spend = r.spend_cents / 100;
      const cpl = r.leads > 0 ? spend / r.leads : 0;
      const roi = spend > 0 ? ((r.revenue - spend) / spend) * 100 : 0;
      const conv_rate = r.leads > 0 ? (r.converted_leads / r.leads) * 100 : 0;
      return {
        platform: r.platform,
        leads: r.leads,
        spend,
        cpl,
        revenue: r.revenue,
        roi,
        conv_rate
      };
    });

    res.json(scorecard);
  } catch (err) {
    console.error('Scorecard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deep-analysis/funnel
// Returns funnel counts: visitors → leads → qualified → calls → transferred → signed
router.get('/funnel', authenticateToken, (req, res) => {
  try {
    const { from, to, platform } = req.query;
    const tz = getConfiguredTimezone();
    const dateConditions = [];
    const dateParams = [];

    if (from) {
      dateConditions.push(`>= ?`);
      dateParams.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      dateConditions.push(`<= ?`);
      dateParams.push(localDateToUtcRange(to, tz).end);
    }

    const dateWhereVisitors = dateConditions.length
      ? dateConditions.map((c, i) => `v.first_visit ${c}`).join(' AND ')
      : '1=1';
    const dateWhereLeads = dateConditions.length
      ? dateConditions.map((c, i) => `l.created_at ${c}`).join(' AND ')
      : '1=1';

    // Visitors
    let visitorParams = [...dateParams];
    let visitorPlatformJoin = '';
    let visitorPlatformWhere = '';
    if (platform) {
      visitorPlatformJoin = 'LEFT JOIN landing_pages lp ON v.landing_page = lp.slug';
      visitorPlatformWhere = ' AND lp.platform = ?';
      visitorParams.push(platform);
    }
    const visitors = db.prepare(`
      SELECT COUNT(*) AS cnt FROM visitors v
      ${visitorPlatformJoin}
      WHERE ${dateWhereVisitors} ${visitorPlatformWhere}
    `).get(...visitorParams).cnt;

    // Leads
    let leadParams = [...dateParams];
    let leadPlatformJoin = '';
    let leadPlatformWhere = '';
    if (platform) {
      leadPlatformJoin = 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id';
      leadPlatformWhere = ' AND lp.platform = ?';
      leadParams.push(platform);
    }
    const leadsTotal = db.prepare(`
      SELECT COUNT(*) AS cnt FROM leads l
      ${leadPlatformJoin}
      WHERE ${dateWhereLeads} ${leadPlatformWhere}
    `).get(...leadParams).cnt;

    // Qualified (has debt_amount)
    const qualified = db.prepare(`
      SELECT COUNT(*) AS cnt FROM leads l
      ${leadPlatformJoin}
      WHERE ${dateWhereLeads} ${leadPlatformWhere}
        AND l.debt_amount IS NOT NULL AND l.debt_amount != ''
    `).get(...leadParams).cnt;

    // Calls (matched to lead)
    let callParams = [...dateParams];
    let callPlatformJoin = '';
    let callPlatformWhere = '';
    if (platform) {
      callPlatformJoin = 'LEFT JOIN leads l2 ON c.lead_id = l2.id LEFT JOIN landing_pages lp ON l2.landing_page_id = lp.id';
      callPlatformWhere = ' AND lp.platform = ?';
      callParams.push(platform);
    }
    const callDateWhere = dateConditions.length
      ? dateConditions.map(c => `c.created_at ${c}`).join(' AND ')
      : '1=1';
    const calls = db.prepare(`
      SELECT COUNT(*) AS cnt FROM calls c
      ${callPlatformJoin}
      WHERE c.lead_id IS NOT NULL AND ${callDateWhere} ${callPlatformWhere}
    `).get(...callParams).cnt;

    // Transferred
    const transferred = db.prepare(`
      SELECT COUNT(*) AS cnt FROM calls c
      ${callPlatformJoin}
      WHERE c.lead_id IS NOT NULL AND c.transferred = 1 AND ${callDateWhere} ${callPlatformWhere}
    `).get(...callParams).cnt;

    // Signed (has total_debt_sign or contract_sign_date)
    const signed = db.prepare(`
      SELECT COUNT(*) AS cnt FROM leads l
      ${leadPlatformJoin}
      WHERE ${dateWhereLeads} ${leadPlatformWhere}
        AND (
          (l.total_debt_sign IS NOT NULL AND l.total_debt_sign != '')
          OR (l.contract_sign_date IS NOT NULL AND l.contract_sign_date != '')
        )
    `).get(...leadParams).cnt;

    res.json({
      visitors,
      leads: leadsTotal,
      qualified,
      calls,
      transferred,
      signed
    });
  } catch (err) {
    console.error('Funnel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deep-analysis/campaigns
// Returns per-campaign metrics
router.get('/campaigns', authenticateToken, (req, res) => {
  try {
    const { from, to, platform } = req.query;
    const tz = getConfiguredTimezone();
    const conditions = [];
    const params = [];

    if (from) {
      conditions.push(`v.first_visit >= ?`);
      params.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      conditions.push(`v.first_visit <= ?`);
      params.push(localDateToUtcRange(to, tz).end);
    }
    if (platform) {
      conditions.push(`lp.platform = ?`);
      params.push(platform);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT
        v.utm_campaign,
        v.utm_source,
        v.utm_medium,
        COALESCE(lp.platform, 'other') AS platform,
        COUNT(DISTINCT v.id) AS visitors,
        COUNT(DISTINCT CASE WHEN v.converted = 1 THEN v.id END) AS leads,
        COALESCE(SUM(CASE WHEN v.converted = 1 THEN l.cost_cents ELSE 0 END), 0) AS spend_cents,
        COALESCE(SUM(ce.revenue), 0) AS revenue,
        COUNT(DISTINCT CASE WHEN ce.id IS NOT NULL THEN l.id END) AS converted_leads,
        COUNT(DISTINCT c.id) AS calls,
        COALESCE(AVG(c.call_score), 0) AS avg_call_score,
        COUNT(DISTINCT CASE WHEN c.transferred = 1 THEN c.id END) AS transfers
      FROM visitors v
      LEFT JOIN landing_pages lp ON v.landing_page = lp.slug
      LEFT JOIN leads l ON v.lead_id = l.id
      LEFT JOIN conversion_events ce ON ce.lead_id = l.id
      LEFT JOIN calls c ON c.lead_id = l.id
      ${where}
      GROUP BY v.utm_campaign, v.utm_source, v.utm_medium, COALESCE(lp.platform, 'other')
      HAVING v.utm_campaign IS NOT NULL AND v.utm_campaign != ''
      ORDER BY leads DESC
    `).all(...params);

    const campaigns = rows.map(r => {
      const spend = r.spend_cents / 100;
      const cpl = r.leads > 0 ? spend / r.leads : 0;
      const roi = spend > 0 ? ((r.revenue - spend) / spend) * 100 : 0;
      const conv_rate = r.visitors > 0 ? (r.leads / r.visitors) * 100 : 0;
      const transfer_rate = r.calls > 0 ? (r.transfers / r.calls) * 100 : 0;
      const lead_to_conv = r.leads > 0 ? (r.converted_leads / r.leads) * 100 : 0;
      return {
        utm_campaign: r.utm_campaign,
        utm_source: r.utm_source,
        utm_medium: r.utm_medium,
        platform: r.platform,
        visitors: r.visitors,
        leads: r.leads,
        conv_rate,
        spend,
        cpl,
        revenue: r.revenue,
        roi,
        calls: r.calls,
        avg_call_score: Math.round(r.avg_call_score * 10) / 10,
        transfer_rate,
        lead_to_conv
      };
    });

    res.json(campaigns);
  } catch (err) {
    console.error('Campaigns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deep-analysis/landing-pages
// Returns per-landing-page metrics
router.get('/landing-pages', authenticateToken, (req, res) => {
  try {
    const { from, to, platform } = req.query;
    const tz = getConfiguredTimezone();
    const conditions = [];
    const params = [];

    if (from) {
      conditions.push(`v.first_visit >= ?`);
      params.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      conditions.push(`v.first_visit <= ?`);
      params.push(localDateToUtcRange(to, tz).end);
    }
    if (platform) {
      conditions.push(`lp.platform = ?`);
      params.push(platform);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT
        lp.id AS page_id,
        lp.name AS page_name,
        lp.slug,
        lp.platform,
        COUNT(DISTINCT v.id) AS visitors,
        COUNT(DISTINCT CASE WHEN v.converted = 1 THEN v.id END) AS leads,
        COALESCE(AVG(CASE WHEN l.debt_amount IS NOT NULL AND l.debt_amount != '' THEN CAST(REPLACE(REPLACE(l.debt_amount, '$', ''), ',', '') AS REAL) END), 0) AS avg_debt,
        COALESCE(SUM(CASE WHEN l.has_mca = 'yes' OR l.has_mca = '1' THEN 1 ELSE 0 END), 0) AS mca_count,
        COUNT(DISTINCT CASE WHEN v.converted = 1 THEN v.id END) AS lead_count_for_mca,
        COALESCE(SUM(ce.revenue), 0) AS revenue,
        COALESCE(SUM(l.cost_cents), 0) AS spend_cents,
        COUNT(DISTINCT c.id) AS calls,
        COUNT(DISTINCT CASE WHEN c.transferred = 1 THEN c.id END) AS transfers
      FROM visitors v
      LEFT JOIN landing_pages lp ON v.landing_page = lp.slug
      LEFT JOIN leads l ON v.lead_id = l.id
      LEFT JOIN conversion_events ce ON ce.lead_id = l.id
      LEFT JOIN calls c ON c.lead_id = l.id
      ${where}
      GROUP BY lp.id
      HAVING lp.id IS NOT NULL
      ORDER BY leads DESC
    `).all(...params);

    const pages = rows.map(r => {
      const spend = r.spend_cents / 100;
      const conv_rate = r.visitors > 0 ? (r.leads / r.visitors) * 100 : 0;
      const roi = spend > 0 ? ((r.revenue - spend) / spend) * 100 : 0;
      const transfer_rate = r.calls > 0 ? (r.transfers / r.calls) * 100 : 0;
      const mca_pct = r.lead_count_for_mca > 0 ? (r.mca_count / r.lead_count_for_mca) * 100 : 0;
      return {
        page_name: r.page_name,
        slug: r.slug,
        platform: r.platform,
        visitors: r.visitors,
        leads: r.leads,
        conv_rate,
        avg_debt: Math.round(r.avg_debt),
        mca_pct: Math.round(mca_pct * 10) / 10,
        calls: r.calls,
        transfer_rate,
        revenue: r.revenue,
        roi,
        spend
      };
    });

    res.json(pages);
  } catch (err) {
    console.error('Landing pages error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deep-analysis/call-quality
// Returns call stats grouped by platform
router.get('/call-quality', authenticateToken, (req, res) => {
  try {
    const { from, to } = req.query;
    const tz = getConfiguredTimezone();
    const conditions = [];
    const params = [];

    if (from) {
      conditions.push(`c.created_at >= ?`);
      params.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      conditions.push(`c.created_at <= ?`);
      params.push(localDateToUtcRange(to, tz).end);
    }

    const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

    // Per-platform call stats
    const platformStats = db.prepare(`
      SELECT
        COALESCE(lp.platform, 'other') AS platform,
        COUNT(c.id) AS total_calls,
        COALESCE(AVG(c.call_score), 0) AS avg_score,
        COALESCE(AVG(c.duration), 0) AS avg_duration,
        COUNT(CASE WHEN c.transferred = 1 THEN 1 END) AS transfers,
        COUNT(CASE WHEN c.call_score >= 7 THEN 1 END) AS high_score,
        COUNT(CASE WHEN c.call_score < 7 AND c.call_score IS NOT NULL THEN 1 END) AS low_score
      FROM calls c
      LEFT JOIN leads l ON c.lead_id = l.id
      LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
      WHERE c.lead_id IS NOT NULL ${where}
      GROUP BY COALESCE(lp.platform, 'other')
      ORDER BY total_calls DESC
    `).all(...params);

    // Top dispositions
    const dispositions = db.prepare(`
      SELECT
        COALESCE(c.disposition, 'Unknown') AS disposition,
        COUNT(*) AS cnt
      FROM calls c
      WHERE c.lead_id IS NOT NULL ${where}
      GROUP BY COALESCE(c.disposition, 'Unknown')
      ORDER BY cnt DESC
      LIMIT 10
    `).all(...params);

    res.json({
      platforms: platformStats.map(r => ({
        platform: r.platform,
        total_calls: r.total_calls,
        avg_score: Math.round(r.avg_score * 10) / 10,
        avg_duration: Math.round(r.avg_duration),
        transfer_rate: r.total_calls > 0 ? Math.round((r.transfers / r.total_calls) * 1000) / 10 : 0,
        high_score: r.high_score,
        low_score: r.low_score
      })),
      dispositions: dispositions.map(r => ({ name: r.disposition, count: r.cnt }))
    });
  } catch (err) {
    console.error('Call quality error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deep-analysis/heatmap
// Returns lead counts grouped by day-of-week × hour-of-day
router.get('/heatmap', authenticateToken, (req, res) => {
  try {
    const { from, to, platform, metric } = req.query;
    const tz = getConfiguredTimezone();
    const offsetStr = getSqliteOffsetStr(tz);
    const conditions = [];
    const params = [];

    if (from) {
      conditions.push(`l.created_at >= ?`);
      params.push(localDateToUtcRange(from, tz).start);
    }
    if (to) {
      conditions.push(`l.created_at <= ?`);
      params.push(localDateToUtcRange(to, tz).end);
    }

    let platformJoin = '';
    if (platform) {
      platformJoin = 'LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id';
      conditions.push(`lp.platform = ?`);
      params.push(platform);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    // Lead volume by day-of-week and hour
    const rows = db.prepare(`
      SELECT
        CAST(strftime('%w', datetime(l.created_at, '${offsetStr}')) AS INTEGER) AS dow,
        CAST(strftime('%H', datetime(l.created_at, '${offsetStr}')) AS INTEGER) AS hour,
        COUNT(l.id) AS lead_count
      FROM leads l
      ${platformJoin}
      ${where}
      GROUP BY dow, hour
      ORDER BY dow, hour
    `).all(...params);

    // Initialize 7×24 grid
    const grid = [];
    for (let d = 0; d < 7; d++) {
      grid[d] = new Array(24).fill(0);
    }
    for (const r of rows) {
      grid[r.dow][r.hour] = r.lead_count;
    }

    res.json({ grid });
  } catch (err) {
    console.error('Heatmap error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Media Buyer Pivot ──────────────────────────────────────────────────────
// POST /api/deep-analysis/pivot
// Body: { rows: [...], cols: [...optional], measures: [...], filters: { from, to, platform, country, device, source } }
// Allowed dimensions: source, medium, campaign, term, content, country, region, city,
//                     device, browser, os, landing_page, ab_variant, weekday, hour,
//                     funnel_stage, has_gclid, has_fbclid, has_msclkid, day
// Allowed measures:   visits, step1_debt, step2_mca_yes, step2_mca_no, leads,
//                     debt_to_visit_pct, mca_yes_to_debt_pct, lead_to_visit_pct,
//                     lead_to_mca_yes_pct, total_debt_amount

const DIMENSION_EXPR = {
  source:        `COALESCE(NULLIF(LOWER(v.utm_source), ''), 'direct/unknown')`,
  medium:        `COALESCE(NULLIF(LOWER(v.utm_medium), ''), '(none)')`,
  campaign:      `COALESCE(NULLIF(v.utm_campaign, ''), '(none)')`,
  term:          `COALESCE(NULLIF(v.utm_term, ''), '(none)')`,
  content:       `COALESCE(NULLIF(v.utm_content, ''), '(none)')`,
  country:       `COALESCE(NULLIF(v.country, ''), 'Unknown')`,
  region:        `COALESCE(NULLIF(v.region, ''), 'Unknown')`,
  city:          `COALESCE(NULLIF(v.city, ''), 'Unknown')`,
  device:        `COALESCE(NULLIF(v.device_type, ''), 'Unknown')`,
  browser:       `COALESCE(NULLIF(v.browser, ''), 'Unknown')`,
  os:            `COALESCE(NULLIF(v.os, ''), 'Unknown')`,
  landing_page:  `COALESCE(NULLIF(v.landing_page, ''), '(none)')`,
  ab_variant:    `COALESCE(NULLIF(v.ab_variant, ''), '(default)')`,
  weekday:       `CASE strftime('%w', v.first_visit) WHEN '0' THEN 'Sun' WHEN '1' THEN 'Mon' WHEN '2' THEN 'Tue' WHEN '3' THEN 'Wed' WHEN '4' THEN 'Thu' WHEN '5' THEN 'Fri' WHEN '6' THEN 'Sat' END`,
  hour:          `strftime('%H', v.first_visit)`,
  day:           `DATE(v.first_visit)`,
  has_gclid:     `CASE WHEN v.gclid IS NOT NULL AND v.gclid != '' THEN 'Yes' ELSE 'No' END`,
  has_fbclid:    `CASE WHEN v.fbclid IS NOT NULL AND v.fbclid != '' THEN 'Yes' ELSE 'No' END`,
  has_msclkid:   `CASE WHEN v.msclkid IS NOT NULL AND v.msclkid != '' THEN 'Yes' ELSE 'No' END`,
  funnel_stage:  `CASE
                    WHEN v.converted = 1 THEN '5_lead'
                    WHEN v.step2_mca_value = 'Yes' THEN '4_mca_yes'
                    WHEN v.step2_mca_value = 'No'  THEN '3_mca_no'
                    WHEN v.step1_debt_at IS NOT NULL THEN '2_debt'
                    ELSE '1_visit_only'
                  END`
};

router.post('/pivot', authenticateToken, (req, res) => {
  try {
    const { rows = [], cols = [], measures = ['visits', 'step1_debt', 'step2_mca_yes', 'step2_mca_no', 'leads'], filters = {} } = req.body || {};
    const allDims = [...rows, ...cols].filter(Boolean);
    if (allDims.length === 0) return res.status(400).json({ error: 'At least one row dimension required' });
    for (const d of allDims) {
      if (!DIMENSION_EXPR[d]) return res.status(400).json({ error: `Unknown dimension: ${d}` });
    }

    const tz = getConfiguredTimezone();
    const where = [];
    const params = [];
    if (filters.from) { where.push(`v.first_visit >= ?`); params.push(localDateToUtcRange(filters.from, tz).start); }
    if (filters.to)   { where.push(`v.first_visit <= ?`); params.push(localDateToUtcRange(filters.to, tz).end); }
    if (filters.country) { where.push(`v.country = ?`); params.push(filters.country); }
    if (filters.device)  { where.push(`v.device_type = ?`); params.push(filters.device); }
    if (filters.source)  { where.push(`LOWER(v.utm_source) = ?`); params.push(String(filters.source).toLowerCase()); }
    if (filters.platform) {
      where.push(`v.landing_page IN (SELECT '/lp/' || slug || '/' FROM landing_pages WHERE platform = ?) OR v.landing_page LIKE '%' || (SELECT '/' || slug || '/' FROM landing_pages WHERE platform = ? LIMIT 1) || '%'`);
      params.push(filters.platform, filters.platform);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const dimSelect = allDims.map((d, i) => `${DIMENSION_EXPR[d]} AS d${i}`).join(', ');
    const dimGroup  = allDims.map((d, i) => `d${i}`).join(', ');

    const sql = `
      WITH base AS (
        SELECT
          ${dimSelect},
          v.id AS visitor_id,
          v.step1_debt_at, v.step2_mca_value, v.converted,
          (SELECT SUM(
            CASE
              WHEN l.debt_amount LIKE '%,%' THEN
                CAST(REPLACE(REPLACE(REPLACE(l.debt_amount, '$', ''), ',', ''), '+', '') AS REAL)
              ELSE CAST(l.debt_amount AS REAL)
            END
          ) FROM leads l WHERE l.eli_clickid = v.eli_clickid) AS lead_debt
        FROM visitors v
        ${whereSql}
      )
      SELECT
        ${dimGroup},
        COUNT(*) AS visits,
        SUM(CASE WHEN step1_debt_at IS NOT NULL THEN 1 ELSE 0 END) AS step1_debt,
        SUM(CASE WHEN step2_mca_value = 'Yes' THEN 1 ELSE 0 END) AS step2_mca_yes,
        SUM(CASE WHEN step2_mca_value = 'No'  THEN 1 ELSE 0 END) AS step2_mca_no,
        SUM(CASE WHEN converted = 1 THEN 1 ELSE 0 END) AS leads,
        ROUND(COALESCE(SUM(lead_debt), 0)) AS total_debt_amount
      FROM base
      GROUP BY ${dimGroup}
      ORDER BY visits DESC
      LIMIT 5000
    `;

    const data = db.prepare(sql).all(...params).map(r => {
      const dimValues = {};
      allDims.forEach((d, i) => { dimValues[d] = r[`d${i}`]; });
      const visits = r.visits || 0;
      const step1 = r.step1_debt || 0;
      const yes = r.step2_mca_yes || 0;
      const leads = r.leads || 0;
      return {
        ...dimValues,
        visits,
        step1_debt: step1,
        step2_mca_yes: yes,
        step2_mca_no: r.step2_mca_no || 0,
        leads,
        total_debt_amount: r.total_debt_amount || 0,
        debt_to_visit_pct: visits ? +(step1 / visits * 100).toFixed(1) : 0,
        mca_yes_to_debt_pct: step1 ? +(yes / step1 * 100).toFixed(1) : 0,
        lead_to_visit_pct: visits ? +(leads / visits * 100).toFixed(2) : 0,
        lead_to_mca_yes_pct: yes ? +(leads / yes * 100).toFixed(1) : 0
      };
    });

    res.json({ rows, cols, measures, data, count: data.length });
  } catch (err) {
    console.error('Pivot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Google Ads demographic breakdowns ──────────────────────────────────────
// Per-demographic clicks / impressions / cost / conversions / CR pulled live
// from Google Ads. Filter: ?days=7|14|30 (default 30).
const googleAds = require('./google-ads');

async function runGadsQuery(query, accessToken, developerToken, customerId, loginCustomerId) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  const lid = loginCustomerId || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
  const r = await fetch(
    `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query }) }
  );
  const d = await r.json();
  const apiError = d.error || d[0]?.error;
  if (apiError) throw new Error(apiError.message || JSON.stringify(apiError));
  return d;
}

function dateClause(req) {
  const days = parseInt(req.query.days, 10);
  if (days === 7) return 'LAST_7_DAYS';
  if (days === 14) return 'LAST_14_DAYS';
  return 'LAST_30_DAYS';
}

async function pullDemographic(req, res, viewName, idField, valueField, label) {
  try {
    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.refresh_token_encrypted || !config.customer_id) {
      return res.status(400).json({ error: 'Google Ads not connected' });
    }
    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.status(401).json({ error: 'Failed to get Google Ads access token' });
    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const range = dateClause(req);
    const query = `
      SELECT
        ${valueField},
        metrics.impressions, metrics.clicks, metrics.cost_micros,
        metrics.conversions, metrics.average_cpc, metrics.ctr
      FROM ${viewName}
      WHERE segments.date DURING ${range}
    `;

    const data = await runGadsQuery(query, accessToken, developerToken, config.customer_id, config.login_customer_id);
    const buckets = new Map();
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        // Resolve nested path "ad_group_criterion.gender.type" → row.adGroupCriterion.gender.type
        const parts = valueField.split('.');
        let v = row;
        for (const p of parts) {
          const camel = p.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
          v = v && v[camel];
        }
        const key = String(v || 'UNKNOWN');
        if (!buckets.has(key)) buckets.set(key, { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
        const b = buckets.get(key);
        const m = row.metrics || {};
        b.impressions += parseInt(m.impressions || 0, 10);
        b.clicks += parseInt(m.clicks || 0, 10);
        b.cost_micros += parseInt(m.costMicros || 0, 10);
        b.conversions += parseFloat(m.conversions || 0);
      }
    }
    const rows = [...buckets.entries()].map(([key, b]) => ({
      [label]: key,
      impressions: b.impressions,
      clicks: b.clicks,
      cost: +(b.cost_micros / 1_000_000).toFixed(2),
      conversions: +b.conversions.toFixed(2),
      ctr: b.impressions ? +(b.clicks / b.impressions * 100).toFixed(2) : 0,
      cpc: b.clicks ? +(b.cost_micros / b.clicks / 1_000_000).toFixed(2) : 0,
      conv_rate: b.clicks ? +(b.conversions / b.clicks * 100).toFixed(2) : 0,
      cpa: b.conversions ? +(b.cost_micros / b.conversions / 1_000_000).toFixed(2) : 0
    })).sort((a, b) => b.clicks - a.clicks);
    res.json({ range, rows });
  } catch (err) {
    console.error(`${viewName} error:`, err);
    res.status(500).json({ error: err.message });
  }
}

// ─── Multi-dimensional Google Ads pivot ──────────────────────────────────
// POST /api/deep-analysis/google-pivot
// Body: {
//   dimensions: ['age','gender'],          // group rows by these
//   filters:    { gender: ['FEMALE'], age: ['AGE_RANGE_45_54'] },
//   metrics:    ['clicks','cost','conversions','conv_rate','cpa'],
//   sort:       { metric: 'conversions', dir: 'desc' },
//   days:       30,                         // 7|14|30|90
//   limit:      100
// }
//
// Each dimension maps to a Google Ads `segments.*` field. The query asks
// Google Ads for the cross-product of all chosen segments and we filter +
// aggregate locally so any combo works (e.g. age × gender × income).

const PIVOT_DIM_MAP = {
  age:        { gads: 'segments.age_range',         path: ['segments', 'ageRange'] },
  gender:     { gads: 'segments.gender',            path: ['segments', 'gender'] },
  income:     { gads: 'segments.income_range',      path: ['segments', 'incomeRange'] },
  parental:   { gads: 'segments.parental_status',   path: ['segments', 'parentalStatus'] },
  device:     { gads: 'segments.device',            path: ['segments', 'device'] },
  day_of_week:{ gads: 'segments.day_of_week',       path: ['segments', 'dayOfWeek'] },
  hour:       { gads: 'segments.hour',              path: ['segments', 'hour'] },
  region:     { gads: 'segments.geo_target_region', path: ['segments', 'geoTargetRegion'] },
  campaign:   { gads: 'campaign.name',              path: ['campaign', 'name'] },
  ad_group:   { gads: 'adGroup.name',               path: ['adGroup', 'name'], gadsField: 'ad_group.name' }
};

// Each demographic dimension lives on its OWN view in Google Ads. You can't
// cross-segment them in a single query (gender × age in one query returns
// nothing for Search campaigns). We pull each demographic separately, keyed
// by ad_group, then "join" client-side using percentage distribution.
//
// Non-demographic dims (device, hour, day_of_week, region) DO support
// multi-segment queries on `ad_group`.
const DEMO_VIEWS = {
  age:      { view: 'age_range_view',       segPath: ['adGroupCriterion', 'ageRange', 'type'] },
  gender:   { view: 'gender_view',          segPath: ['adGroupCriterion', 'gender', 'type'] },
  income:   { view: 'income_range_view',    segPath: ['adGroupCriterion', 'incomeRange', 'type'] },
  parental: { view: 'parental_status_view', segPath: ['adGroupCriterion', 'parentalStatus', 'type'] }
};
const SEGMENT_DIMS = {
  device:      { gads: 'segments.device',            path: ['segments', 'device'] },
  day_of_week: { gads: 'segments.day_of_week',       path: ['segments', 'dayOfWeek'] },
  hour:        { gads: 'segments.hour',              path: ['segments', 'hour'] },
  region:      { gads: 'segments.geo_target_region', path: ['segments', 'geoTargetRegion'] }
};
const RESOURCE_DIMS = {
  campaign:  { gads: 'campaign.name',  id: 'campaign.id',  path: ['campaign', 'name'],  idPath: ['campaign', 'id'] },
  ad_group:  { gads: 'ad_group.name',  id: 'ad_group.id',  path: ['adGroup', 'name'],   idPath: ['adGroup', 'id'] }
};

function pickPath(row, path) {
  let v = row;
  for (const p of path) { v = v && v[p]; if (v === undefined) break; }
  return v == null ? 'UNKNOWN' : String(v);
}

async function gadsQuery(config, accessToken, developerToken, gaql) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'Content-Type': 'application/json'
  };
  const lid = config.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
  const r = await fetch(
    `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
    { method: 'POST', headers, body: JSON.stringify({ query: gaql }) }
  );
  const data = await r.json();
  const apiError = data.error || data[0]?.error;
  if (apiError) throw new Error(apiError.message || JSON.stringify(apiError));
  return data;
}

// Deep sync — pulls every segment Google Ads exposes per ad group and writes
// to the gads_segments cache. Run from the Google Deep Analysis page.
router.post('/deep-sync', authenticateToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.refresh_token_encrypted || !config.customer_id) {
      return res.status(400).json({ error: 'Google Ads not connected' });
    }
    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.status(401).json({ error: 'Failed to get Google Ads access token' });
    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const days = parseInt(req.body?.days, 10);
    const range = ({ 7: 'LAST_7_DAYS', 14: 'LAST_14_DAYS', 30: 'LAST_30_DAYS', 90: 'LAST_90_DAYS' })[days] || 'LAST_30_DAYS';
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'Content-Type': 'application/json'
    };
    const lid = config.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
    const url = `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`;

    const runQuery = async (gaql) => {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: gaql }) });
      const d = await r.json();
      const apiError = d.error || d[0]?.error;
      if (apiError) throw new Error(apiError.message || JSON.stringify(apiError));
      return d;
    };

    // Wipe segments table — this is a full refresh
    db.prepare('DELETE FROM gads_segments').run();

    const insert = db.prepare(`
      INSERT INTO gads_segments (
        ad_group_id, ad_group_name, campaign_id, campaign_name,
        segment_type, segment_value, impressions, clicks, cost_micros, conversions,
        range_label, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const insertMany = db.transaction((rows) => {
      for (const r of rows) insert.run(...r);
    });

    const counts = {};
    const errors = {};

    // Helper to pull from a *_view that's keyed on ad_group + criterion
    const syncDemoView = async (segType, viewName, valueField) => {
      try {
        const gaql = `
          SELECT ad_group.id, ad_group.name, campaign.id, campaign.name,
            ${valueField},
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
          FROM ${viewName}
          WHERE segments.date DURING ${range}
        `;
        const data = await runQuery(gaql);
        const rows = [];
        for (const stream of data) {
          for (const row of (stream.results || [])) {
            const m = row.metrics || {};
            // Resolve nested path "ad_group_criterion.gender.type" → row.adGroupCriterion.gender.type
            const camelPath = valueField.split('.').map(p => p.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
            let segVal = row;
            for (const p of camelPath) { segVal = segVal && segVal[p]; if (segVal === undefined) break; }
            rows.push([
              row.adGroup?.id, row.adGroup?.name,
              row.campaign?.id, row.campaign?.name,
              segType, String(segVal || 'UNKNOWN'),
              parseInt(m.impressions || 0, 10),
              parseInt(m.clicks || 0, 10),
              parseInt(m.costMicros || 0, 10),
              parseFloat(m.conversions || 0),
              range
            ]);
          }
        }
        insertMany(rows);
        counts[segType] = rows.length;
      } catch (err) {
        errors[segType] = err.message;
        counts[segType] = 0;
      }
    };

    // Helper to pull from ad_group with a single segment
    const syncAdGroupSegment = async (segType, gadsField, jsonPath) => {
      try {
        const gaql = `
          SELECT ad_group.id, ad_group.name, campaign.id, campaign.name,
            ${gadsField},
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
          FROM ad_group
          WHERE segments.date DURING ${range}
            AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
        `;
        const data = await runQuery(gaql);
        const rows = [];
        for (const stream of data) {
          for (const row of (stream.results || [])) {
            const m = row.metrics || {};
            let segVal = row;
            for (const p of jsonPath) { segVal = segVal && segVal[p]; if (segVal === undefined) break; }
            rows.push([
              row.adGroup?.id, row.adGroup?.name,
              row.campaign?.id, row.campaign?.name,
              segType, String(segVal != null ? segVal : 'UNKNOWN'),
              parseInt(m.impressions || 0, 10),
              parseInt(m.clicks || 0, 10),
              parseInt(m.costMicros || 0, 10),
              parseFloat(m.conversions || 0),
              range
            ]);
          }
        }
        insertMany(rows);
        counts[segType] = rows.length;
      } catch (err) {
        errors[segType] = err.message;
        counts[segType] = 0;
      }
    };

    // Demographics
    await syncDemoView('age',      'age_range_view',       'ad_group_criterion.age_range.type');
    await syncDemoView('gender',   'gender_view',          'ad_group_criterion.gender.type');
    await syncDemoView('income',   'income_range_view',    'ad_group_criterion.income_range.type');
    await syncDemoView('parental', 'parental_status_view', 'ad_group_criterion.parental_status.type');
    // Device, hour, day-of-week, geo
    await syncAdGroupSegment('device',   'segments.device',            ['segments', 'device']);
    await syncAdGroupSegment('hour',     'segments.hour',              ['segments', 'hour']);
    await syncAdGroupSegment('dow',      'segments.day_of_week',       ['segments', 'dayOfWeek']);
    await syncAdGroupSegment('geo',      'segments.geo_target_region', ['segments', 'geoTargetRegion']);

    // Search terms (per ad group)
    try {
      const gaql = `
        SELECT ad_group.id, ad_group.name, campaign.id, campaign.name,
          search_term_view.search_term,
          metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM search_term_view
        WHERE segments.date DURING ${range}
      `;
      const data = await runQuery(gaql);
      const rows = [];
      for (const stream of data) {
        for (const row of (stream.results || [])) {
          const m = row.metrics || {};
          rows.push([
            row.adGroup?.id, row.adGroup?.name,
            row.campaign?.id, row.campaign?.name,
            'search_term', row.searchTermView?.searchTerm || 'UNKNOWN',
            parseInt(m.impressions || 0, 10),
            parseInt(m.clicks || 0, 10),
            parseInt(m.costMicros || 0, 10),
            parseFloat(m.conversions || 0),
            range
          ]);
        }
      }
      insertMany(rows);
      counts.search_term = rows.length;
    } catch (err) {
      errors.search_term = err.message;
      counts.search_term = 0;
    }

    // Conversion actions — segment metrics by which conversion action fired.
    // Includes conversions_value (revenue / lead value) so we can answer
    // "where is the money going / coming from".
    try {
      const gaql = `
        SELECT ad_group.id, ad_group.name, campaign.id, campaign.name,
          segments.conversion_action_name, segments.conversion_action_category,
          metrics.conversions, metrics.conversions_value,
          metrics.all_conversions, metrics.all_conversions_value,
          metrics.cost_micros, metrics.clicks, metrics.impressions
        FROM ad_group
        WHERE segments.date DURING ${range}
          AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
      `;
      const data = await runQuery(gaql);
      const insertConv = db.prepare(`
        INSERT INTO gads_segments (
          ad_group_id, ad_group_name, campaign_id, campaign_name,
          segment_type, segment_value, impressions, clicks, cost_micros,
          conversions, conversions_value, all_conversions, all_conversions_value,
          range_label, refreshed_at
        ) VALUES (?, ?, ?, ?, 'conversion_action', ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      const insertConvMany = db.transaction(rows => { for (const r of rows) insertConv.run(...r); });
      const rows = [];
      for (const stream of data) {
        for (const row of (stream.results || [])) {
          const m = row.metrics || {};
          const actionName = row.segments?.conversionActionName || 'UNKNOWN';
          rows.push([
            row.adGroup?.id, row.adGroup?.name,
            row.campaign?.id, row.campaign?.name,
            actionName,
            parseInt(m.impressions || 0, 10),
            parseInt(m.clicks || 0, 10),
            parseInt(m.costMicros || 0, 10),
            parseFloat(m.conversions || 0),
            parseFloat(m.conversionsValue || 0),
            parseFloat(m.allConversions || 0),
            parseFloat(m.allConversionsValue || 0),
            range
          ]);
        }
      }
      insertConvMany(rows);
      counts.conversion_action = rows.length;
    } catch (err) {
      errors.conversion_action = err.message;
      counts.conversion_action = 0;
    }

    // Roll up per-ad-group conversions_value into gads_ad_group_meta
    try {
      const aggCols = db.prepare(`
        SELECT ad_group_id,
          SUM(COALESCE(conversions_value, 0)) AS conv_val,
          SUM(COALESCE(all_conversions, 0)) AS all_conv,
          SUM(COALESCE(all_conversions_value, 0)) AS all_conv_val
        FROM gads_segments
        WHERE segment_type = 'conversion_action'
        GROUP BY ad_group_id
      `).all();
      const upd = db.prepare(`UPDATE gads_ad_group_meta SET conversions_value = ?, all_conversions = ?, all_conversions_value = ? WHERE ad_group_id = ?`);
      for (const r of aggCols) {
        upd.run(r.conv_val, r.all_conv, r.all_conv_val, String(r.ad_group_id));
      }
    } catch (e) { /* ad-group meta enrichment is best-effort */ }

    res.json({
      success: true,
      range,
      duration_ms: Date.now() - t0,
      counts,
      errors,
      total_rows: Object.values(counts).reduce((s, n) => s + (n || 0), 0)
    });
  } catch (err) {
    console.error('deep-sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// "Where is the money?" — surfaces best ROI vs worst spend-per-conv from cache.
// Returns: top winners (best ROI), top wasters (high spend, zero/low conv),
// conversion-action mix, and aggregate totals.
router.get('/money-map', authenticateToken, (req, res) => {
  try {
    const lvl = (req.query.level || 'campaign').toLowerCase(); // 'campaign' | 'ad_group'
    const groupBy = lvl === 'ad_group' ? 'ad_group_id' : 'campaign_id';
    const labelCol = lvl === 'ad_group' ? 'ad_group_name' : 'campaign_name';

    const rows = db.prepare(`
      SELECT
        ${groupBy} AS key_id,
        ${labelCol} AS label,
        campaign_name,
        SUM(COALESCE(impressions, 0)) AS impressions,
        SUM(COALESCE(clicks, 0)) AS clicks,
        SUM(COALESCE(cost_micros, 0)) AS cost_micros,
        SUM(COALESCE(conversions, 0)) AS conversions,
        SUM(COALESCE(conversions_value, 0)) AS conv_value,
        SUM(COALESCE(all_conversions, 0)) AS all_conv,
        SUM(COALESCE(all_conversions_value, 0)) AS all_conv_value,
        MAX(range_label) AS range_label,
        MAX(refreshed_at) AS refreshed_at
      FROM gads_ad_group_meta
      WHERE COALESCE(is_manual, 0) = 0
      GROUP BY ${groupBy}
    `).all();

    if (rows.length === 0) {
      return res.json({
        winners: [], wasters: [], no_conv: [], conv_mix: [],
        totals: { spend: 0, conv: 0, conv_value: 0, roi: 0, cpa: 0 },
        notes: 'Cache empty — click Sync Deep Data first.'
      });
    }

    const enriched = rows.map(r => {
      const cost = (r.cost_micros || 0) / 1_000_000;
      const conv = r.conversions || 0;
      const value = r.conv_value || 0;
      return {
        key_id: r.key_id, label: r.label, campaign_name: r.campaign_name,
        impressions: r.impressions, clicks: r.clicks,
        spend: +cost.toFixed(2),
        conv: +conv.toFixed(2),
        conv_value: +value.toFixed(2),
        all_conv: +(r.all_conv || 0).toFixed(2),
        all_conv_value: +(r.all_conv_value || 0).toFixed(2),
        cpa: conv > 0 ? +(cost / conv).toFixed(2) : null,
        cpc: r.clicks > 0 ? +(cost / r.clicks).toFixed(2) : 0,
        conv_rate: r.clicks > 0 ? +(conv / r.clicks * 100).toFixed(2) : 0,
        roas: cost > 0 ? +(value / cost).toFixed(2) : 0,
        net: +(value - cost).toFixed(2),
        // ROI as "percent return": (value - cost) / cost
        roi_pct: cost > 0 ? +((value - cost) / cost * 100).toFixed(1) : null
      };
    });

    // Filter where spend = 0 — they're noise
    const withSpend = enriched.filter(r => r.spend > 0.01);

    // Winners: highest ROI %, but only if they have meaningful spend (>= $20)
    const winners = withSpend
      .filter(r => r.spend >= 20 && r.roi_pct != null)
      .sort((a, b) => b.roi_pct - a.roi_pct)
      .slice(0, 10);

    // Wasters: high spend with zero or near-zero conv
    const wasters = withSpend
      .filter(r => r.conv < 1)
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    // No-conv-but-spending watch list (subset of wasters but nicer UX)
    const noConv = withSpend.filter(r => r.conv === 0).sort((a, b) => b.spend - a.spend).slice(0, 10);

    // Conversion-action mix
    const convMix = db.prepare(`
      SELECT segment_value AS action,
        SUM(COALESCE(conversions, 0)) AS conv,
        SUM(COALESCE(conversions_value, 0)) AS conv_value,
        SUM(COALESCE(cost_micros, 0)) AS cost_micros
      FROM gads_segments
      WHERE segment_type = 'conversion_action'
      GROUP BY segment_value
      ORDER BY conv_value DESC, conv DESC
    `).all().map(r => ({
      action: r.action,
      conversions: +(r.conv || 0).toFixed(2),
      value: +(r.conv_value || 0).toFixed(2),
      cost_attributed: +((r.cost_micros || 0) / 1_000_000).toFixed(2)
    }));

    // Totals across the enriched set
    const tot = enriched.reduce((acc, r) => ({
      spend: acc.spend + r.spend,
      conv: acc.conv + r.conv,
      conv_value: acc.conv_value + r.conv_value,
      clicks: acc.clicks + r.clicks
    }), { spend: 0, conv: 0, conv_value: 0, clicks: 0 });
    const totals = {
      spend: +tot.spend.toFixed(2),
      conv: +tot.conv.toFixed(2),
      conv_value: +tot.conv_value.toFixed(2),
      clicks: tot.clicks,
      cpa: tot.conv > 0 ? +(tot.spend / tot.conv).toFixed(2) : null,
      roas: tot.spend > 0 ? +(tot.conv_value / tot.spend).toFixed(2) : 0,
      net: +(tot.conv_value - tot.spend).toFixed(2),
      roi_pct: tot.spend > 0 ? +((tot.conv_value - tot.spend) / tot.spend * 100).toFixed(1) : null
    };

    res.json({
      level: lvl,
      range: rows[0]?.range_label || 'cached',
      last_refreshed: rows[0]?.refreshed_at,
      winners, wasters, no_conv: noConv, conv_mix: convMix,
      totals,
      total_groups: enriched.length
    });
  } catch (err) {
    console.error('money-map error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Quick status — when was deep sync last run, how many rows per segment type
router.get('/deep-sync-status', authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT segment_type, COUNT(*) AS n, MIN(refreshed_at) AS oldest, MAX(refreshed_at) AS newest, MIN(range_label) AS range_label
    FROM gads_segments
    GROUP BY segment_type
  `).all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  res.json({
    total,
    by_type: rows,
    last_refreshed: rows[0]?.newest || null
  });
});

// Simplest possible "is the Google Ads pipe working?" probe.
// Pulls every campaign (any status) with its 30-day metrics. No segments,
// no joins, no filters beyond date.
router.get('/gads-test', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config) return res.json({ ok: false, step: 'config', error: 'No google_ads_config row' });
    if (!config.customer_id) return res.json({ ok: false, step: 'customer_id', error: 'customer_id not set' });
    if (!config.refresh_token_encrypted) return res.json({ ok: false, step: 'refresh_token', error: 'Not connected — go to Integrations and connect Google Ads' });

    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.json({ ok: false, step: 'access_token', error: 'getValidAccessToken returned null', customer_id: config.customer_id, login_customer_id: config.login_customer_id });

    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.json({ ok: false, step: 'developer_token', error: 'developer token not configured' });

    const gaql = `
      SELECT campaign.id, campaign.name, campaign.status,
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
    `;

    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'Content-Type': 'application/json'
    };
    const lid = config.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
    const r = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query: gaql }) }
    );
    const data = await r.json();
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.json({ ok: false, step: 'gaql', error: apiError.message || JSON.stringify(apiError), gaql });

    const campaigns = [];
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        const m = row.metrics || {};
        campaigns.push({
          id: row.campaign?.id,
          name: row.campaign?.name,
          status: row.campaign?.status,
          impressions: parseInt(m.impressions || 0, 10),
          clicks: parseInt(m.clicks || 0, 10),
          cost: +(parseInt(m.costMicros || 0, 10) / 1_000_000).toFixed(2),
          conversions: +parseFloat(m.conversions || 0).toFixed(2)
        });
      }
    }
    campaigns.sort((a, b) => b.clicks - a.clicks);

    res.json({
      ok: true,
      customer_id: config.customer_id,
      login_customer_id: config.login_customer_id,
      total_campaigns: campaigns.length,
      total_clicks: campaigns.reduce((s, c) => s + c.clicks, 0),
      total_cost: +campaigns.reduce((s, c) => s + c.cost, 0).toFixed(2),
      campaigns: campaigns.slice(0, 50)
    });
  } catch (err) {
    res.json({ ok: false, step: 'exception', error: err.message });
  }
});

// Pivot pulls from the local gads_ad_group_meta cache that Bar populates with
// "Sync Google Ads" on the LP folder view. Instant data, no API round-trip.
// Demographic dims (age, gender, income, parental) require a live API call —
// merged in only when those dims are requested.
// ─── Cache-only pivot ──────────────────────────────────────────────────
// Reads gads_ad_group_meta + gads_segments, no live API calls.
// Supports any combo of: campaign, ad_group, age, gender, income, parental,
// device, hour, dow, geo, search_term. Multi-segment combos use distribution
// weighting (Google Ads doesn't expose true cross-tabs for Search campaigns).
const SEG_TYPES = new Set(['age', 'gender', 'income', 'parental', 'device', 'hour', 'dow', 'geo', 'search_term']);

router.post('/google-pivot', authenticateToken, async (req, res) => {
  try {
    const {
      dimensions = ['campaign'],
      filters = {},
      metrics = ['clicks', 'cost', 'conversions', 'conv_rate', 'cpa'],
      sort = { metric: 'clicks', dir: 'desc' },
      limit = 200
    } = req.body || {};
    if (!dimensions.length) return res.status(400).json({ error: 'At least one dimension required' });

    // Detect what kind of dim each one is
    const allDims = [...new Set([...dimensions, ...Object.keys(filters || {})])];
    const segDims = allDims.filter(d => SEG_TYPES.has(d));
    const flatDims = allDims.filter(d => d === 'campaign' || d === 'ad_group');
    const unknownDims = allDims.filter(d => !SEG_TYPES.has(d) && d !== 'campaign' && d !== 'ad_group');
    if (unknownDims.length) return res.status(400).json({ error: `Unknown dim(s): ${unknownDims.join(', ')}` });

    // Pull cached meta (per ad-group totals) + segment rows
    const meta = db.prepare(`
      SELECT campaign_id, campaign_name, ad_group_id, ad_group_name,
        impressions, clicks, cost_micros, conversions, refreshed_at, range_label
      FROM gads_ad_group_meta
      WHERE COALESCE(is_manual, 0) = 0
    `).all();

    if (meta.length === 0) {
      return res.json({
        dimensions, filters, metrics, range: 'cache',
        rows: [], total_rows: 0,
        totals: { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
        diagnostic: {
          source: 'gads_ad_group_meta cache',
          notes: 'Cache empty — click "Sync Deep Data" above first.'
        }
      });
    }

    // segData[segType] = Map<ad_group_id, [{value, impressions, clicks, cost_micros, conversions}, ...]>
    const segData = {};
    for (const segType of segDims) {
      const rows = db.prepare(`
        SELECT ad_group_id, segment_value, impressions, clicks, cost_micros, conversions
        FROM gads_segments WHERE segment_type = ?
      `).all(segType);
      const byAg = new Map();
      for (const r of rows) {
        if (!byAg.has(r.ad_group_id)) byAg.set(r.ad_group_id, []);
        byAg.get(r.ad_group_id).push({
          value: r.segment_value,
          impressions: r.impressions || 0,
          clicks: r.clicks || 0,
          cost_micros: r.cost_micros || 0,
          conversions: r.conversions || 0
        });
      }
      segData[segType] = byAg;
    }

    // For each ad_group meta row, expand to cross-product of requested segments
    const expanded = [];
    for (const m of meta) {
      const baseDims = { campaign: m.campaign_name, ad_group: m.ad_group_name };
      const baseMetrics = {
        impressions: m.impressions || 0,
        clicks: m.clicks || 0,
        cost_micros: m.cost_micros || 0,
        conversions: m.conversions || 0
      };

      // Compute distribution per requested seg dim for this ad_group
      const dists = segDims.map(segType => {
        const list = (segData[segType] && segData[segType].get(m.ad_group_id)) || [];
        if (!list.length) return null;
        const total = list.reduce((s, x) => s + x.impressions, 0);
        return {
          segType,
          buckets: list.map(x => ({
            value: x.value,
            share: total > 0 ? x.impressions / total : 0,
            absMetrics: { impressions: x.impressions, clicks: x.clicks, cost_micros: x.cost_micros, conversions: x.conversions }
          }))
        };
      }).filter(Boolean);

      // No seg dims → emit one row with base metrics
      if (dists.length === 0) {
        if (segDims.length > 0) continue; // requested seg but no data for this ad_group
        expanded.push({ ...baseDims, _metrics: baseMetrics });
        continue;
      }

      // Cartesian product over seg dims, weight base metrics by combined share
      let stack = [{ row: { ...baseDims }, weight: 1, abs: null }];
      for (const dist of dists) {
        const next = [];
        for (const s of stack) {
          for (const b of dist.buckets) {
            next.push({
              row: { ...s.row, [dist.segType]: b.value },
              weight: s.weight * b.share,
              abs: dists.length === 1 ? b.absMetrics : null
            });
          }
        }
        stack = next;
      }

      for (const s of stack) {
        const m_out = s.abs ? s.abs : {
          impressions: baseMetrics.impressions * s.weight,
          clicks: baseMetrics.clicks * s.weight,
          cost_micros: baseMetrics.cost_micros * s.weight,
          conversions: baseMetrics.conversions * s.weight
        };
        expanded.push({ ...s.row, _metrics: m_out });
      }
    }

    // Apply filters
    const filtered = expanded.filter(r => {
      for (const [d, allowed] of Object.entries(filters || {})) {
        if (!allowed || allowed.length === 0) continue;
        if (!allowed.includes(String(r[d]))) return false;
      }
      return true;
    });

    // Aggregate by selected dimensions
    const groups = new Map();
    for (const r of filtered) {
      const dimVals = {};
      for (const d of dimensions) dimVals[d] = r[d] != null ? String(r[d]) : 'UNKNOWN';
      const key = dimensions.map(d => dimVals[d]).join('||');
      if (!groups.has(key)) {
        groups.set(key, { ...dimVals, impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
      }
      const g = groups.get(key);
      g.impressions += r._metrics.impressions;
      g.clicks += r._metrics.clicks;
      g.cost_micros += r._metrics.cost_micros;
      g.conversions += r._metrics.conversions;
    }

    const rows = [...groups.values()].map(g => {
      const cost = g.cost_micros / 1_000_000;
      const dimVals = {};
      dimensions.forEach(d => { dimVals[d] = g[d]; });
      return {
        ...dimVals,
        impressions: Math.round(g.impressions),
        clicks: Math.round(g.clicks),
        cost: +cost.toFixed(2),
        conversions: +g.conversions.toFixed(2),
        ctr: g.impressions ? +(g.clicks / g.impressions * 100).toFixed(2) : 0,
        cpc: g.clicks ? +(cost / g.clicks).toFixed(2) : 0,
        conv_rate: g.clicks ? +(g.conversions / g.clicks * 100).toFixed(2) : 0,
        cpa: g.conversions ? +(cost / g.conversions).toFixed(2) : 0
      };
    });

    const sortMetric = sort && sort.metric || 'clicks';
    const sortDir = (sort && sort.dir) === 'asc' ? 1 : -1;
    rows.sort((a, b) => ((a[sortMetric] || 0) - (b[sortMetric] || 0)) * sortDir);
    const limited = rows.slice(0, Math.min(parseInt(limit, 10) || 200, 5000));

    const totals = rows.reduce((acc, r) => ({
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      cost: +(acc.cost + r.cost).toFixed(2),
      conversions: +(acc.conversions + r.conversions).toFixed(2)
    }), { impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    totals.ctr = totals.impressions ? +(totals.clicks / totals.impressions * 100).toFixed(2) : 0;
    totals.cpc = totals.clicks ? +(totals.cost / totals.clicks).toFixed(2) : 0;
    totals.conv_rate = totals.clicks ? +(totals.conversions / totals.clicks * 100).toFixed(2) : 0;
    totals.cpa = totals.conversions ? +(totals.cost / totals.conversions).toFixed(2) : 0;

    return res.json({
      dimensions, filters, metrics,
      range: meta[0]?.range_label || 'cached',
      rows: limited, total_rows: rows.length, totals,
      diagnostic: {
        source: 'gads_ad_group_meta + gads_segments cache',
        ad_groups_in_cache: meta.length,
        seg_types_used: segDims,
        last_refreshed: meta[0]?.refreshed_at,
        notes: segDims.length > 1
          ? 'Multi-segment combo — numbers are weighted estimates because Google Ads does not expose true cross-tabs.'
          : (segDims.length === 1 ? 'Single segment — exact numbers from cache.' : 'Aggregated from ad-group totals.')
      }
    });
  } catch (err) {
    console.error('google-pivot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Old code below kept dead but unused — TODO clean up
router.post('/google-pivot-legacy-DEAD', authenticateToken, async (req, res) => {
  try {
    const {
      dimensions = ['campaign'],
      filters = {},
      metrics = ['clicks', 'cost', 'conversions', 'conv_rate', 'cpa'],
      sort = { metric: 'clicks', dir: 'desc' },
      days = 30,
      limit = 200
    } = req.body || {};
    if (!dimensions.length) return res.status(400).json({ error: 'At least one dimension required' });

    // ─── Cache-backed path ─────────────────────────────────────────────
    // For non-demographic dims, hit the local cache. Always fast, always works
    // (assuming the user has run "Sync Google Ads" at least once).
    const allDemoDims = [...new Set([...dimensions, ...Object.keys(filters || {})])].filter(d => DEMO_VIEWS[d]);
    const useCache = allDemoDims.length === 0;

    if (useCache) {
      const cached = db.prepare(`
        SELECT campaign_id, campaign_name, ad_group_id, ad_group_name,
          impressions, clicks, cost_micros, conversions, range_label, refreshed_at
        FROM gads_ad_group_meta
      `).all();

      if (cached.length === 0) {
        return res.json({
          dimensions, filters, metrics, range: 'cache',
          rows: [], total_rows: 0, totals: { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
          diagnostic: { source: 'cache', notes: 'gads_ad_group_meta cache is empty. Go to Landing Pages and click "Sync Google Ads" first.' }
        });
      }

      // Aggregate rows by selected dimensions
      const groups = new Map();
      for (const r of cached) {
        const dimVals = {};
        for (const d of dimensions) {
          if (d === 'campaign') dimVals[d] = r.campaign_name || 'Unknown';
          else if (d === 'ad_group') dimVals[d] = r.ad_group_name || 'Unknown';
          else dimVals[d] = 'N/A';
        }
        const key = dimensions.map(d => dimVals[d]).join('||');
        if (!groups.has(key)) groups.set(key, { ...dimVals, impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
        const g = groups.get(key);
        g.impressions += r.impressions || 0;
        g.clicks += r.clicks || 0;
        g.cost_micros += r.cost_micros || 0;
        g.conversions += r.conversions || 0;
      }

      const rows = [...groups.values()].map(g => {
        const cost = g.cost_micros / 1_000_000;
        const dimVals = {};
        dimensions.forEach(d => { dimVals[d] = g[d]; });
        return {
          ...dimVals,
          impressions: g.impressions, clicks: g.clicks,
          cost: +cost.toFixed(2), conversions: +g.conversions.toFixed(2),
          ctr: g.impressions ? +(g.clicks / g.impressions * 100).toFixed(2) : 0,
          cpc: g.clicks ? +(cost / g.clicks).toFixed(2) : 0,
          conv_rate: g.clicks ? +(g.conversions / g.clicks * 100).toFixed(2) : 0,
          cpa: g.conversions ? +(cost / g.conversions).toFixed(2) : 0
        };
      });

      const sortMetric = sort && sort.metric || 'clicks';
      const sortDir = (sort && sort.dir) === 'asc' ? 1 : -1;
      rows.sort((a, b) => ((a[sortMetric] || 0) - (b[sortMetric] || 0)) * sortDir);
      const limited = rows.slice(0, Math.min(parseInt(limit, 10) || 200, 1000));
      const totals = rows.reduce((acc, r) => ({
        impressions: acc.impressions + r.impressions,
        clicks: acc.clicks + r.clicks,
        cost: +(acc.cost + r.cost).toFixed(2),
        conversions: +(acc.conversions + r.conversions).toFixed(2)
      }), { impressions: 0, clicks: 0, cost: 0, conversions: 0 });
      totals.ctr = totals.impressions ? +(totals.clicks / totals.impressions * 100).toFixed(2) : 0;
      totals.cpc = totals.clicks ? +(totals.cost / totals.clicks).toFixed(2) : 0;
      totals.conv_rate = totals.clicks ? +(totals.conversions / totals.clicks * 100).toFixed(2) : 0;
      totals.cpa = totals.conversions ? +(totals.cost / totals.conversions).toFixed(2) : 0;

      return res.json({
        dimensions, filters, metrics,
        range: cached[0]?.range_label || 'cached',
        rows: limited, total_rows: rows.length, totals,
        diagnostic: {
          source: 'gads_ad_group_meta cache',
          cached_rows: cached.length,
          last_refreshed: cached[0]?.refreshed_at,
          notes: 'Pulled from local cache populated by "Sync Google Ads" on the Landing Pages page. Hit Sync to refresh.'
        }
      });
    }

    // ─── Live API path (for demographic dims) ───────────────────────────────

    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.refresh_token_encrypted || !config.customer_id) {
      return res.status(400).json({ error: 'Google Ads not connected' });
    }
    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.status(401).json({ error: 'Failed to get Google Ads access token' });
    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const range = ({ 7: 'LAST_7_DAYS', 14: 'LAST_14_DAYS', 30: 'LAST_30_DAYS', 90: 'LAST_90_DAYS' })[parseInt(days, 10)] || 'LAST_30_DAYS';
    const debug = { queries: [], counts: {} };

    // Step 1: pull each requested DEMOGRAPHIC dimension from its own view.
    // Result: demoData[dim] = Map<adGroupId, Map<demoValue, {imp,clicks,cost,conv}>>
    const demoData = {};
    for (const dim of allDemoDims) {
      const view = DEMO_VIEWS[dim].view;
      const gaql = `
        SELECT ad_group.id, ${dim === 'age' ? 'ad_group_criterion.age_range.type' :
                              dim === 'gender' ? 'ad_group_criterion.gender.type' :
                              dim === 'income' ? 'ad_group_criterion.income_range.type' :
                              'ad_group_criterion.parental_status.type'},
          metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM ${view}
        WHERE segments.date DURING ${range}
      `;
      debug.queries.push({ dim, view, gaql: gaql.replace(/\s+/g, ' ').trim() });
      try {
        const data = await gadsQuery(config, accessToken, developerToken, gaql);
        const byAdGroup = new Map();
        let cnt = 0;
        for (const stream of data) {
          for (const row of (stream.results || [])) {
            cnt++;
            const agId = pickPath(row, ['adGroup', 'id']);
            const val = pickPath(row, DEMO_VIEWS[dim].segPath);
            if (!byAdGroup.has(agId)) byAdGroup.set(agId, new Map());
            const inner = byAdGroup.get(agId);
            if (!inner.has(val)) inner.set(val, { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
            const cell = inner.get(val);
            const m = row.metrics || {};
            cell.impressions += parseInt(m.impressions || 0, 10);
            cell.clicks += parseInt(m.clicks || 0, 10);
            cell.cost_micros += parseInt(m.costMicros || 0, 10);
            cell.conversions += parseFloat(m.conversions || 0);
          }
        }
        demoData[dim] = byAdGroup;
        debug.counts[dim] = cnt;
      } catch (err) {
        // One view failing (e.g. income_range_view requires special access) shouldn't kill the whole pivot
        debug.counts[dim] = 0;
        debug.queries[debug.queries.length - 1].error = err.message;
        console.warn(`[google-pivot] ${view} failed:`, err.message);
      }
    }

    // Step 2: pull non-demographic dims from ad_group, segmented
    const allOtherDims = [...new Set([...dimensions, ...Object.keys(filters || {})])].filter(d => !DEMO_VIEWS[d]);
    const otherSegments = allOtherDims.filter(d => SEGMENT_DIMS[d]);
    const otherResource = allOtherDims.filter(d => RESOURCE_DIMS[d]);
    const adGroupRows = new Map(); // adGroupId → array of segment rows {device, hour, region, …, metrics}
    if (otherSegments.length || otherResource.length || allDemoDims.length === 0) {
      const selectFields = [
        'ad_group.id', 'ad_group.name', 'campaign.id', 'campaign.name',
        ...otherSegments.map(d => SEGMENT_DIMS[d].gads),
        'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions'
      ];
      const gaql = `
        SELECT ${selectFields.join(', ')}
        FROM ad_group
        WHERE segments.date DURING ${range}
          AND ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED'
      `;
      debug.queries.push({ dim: 'base', view: 'ad_group', gaql: gaql.replace(/\s+/g, ' ').trim() });
      const data = await gadsQuery(config, accessToken, developerToken, gaql);
      let cnt = 0;
      for (const stream of data) {
        for (const row of (stream.results || [])) {
          cnt++;
          const agId = pickPath(row, ['adGroup', 'id']);
          if (!adGroupRows.has(agId)) adGroupRows.set(agId, []);
          const baseRow = {
            campaign: pickPath(row, ['campaign', 'name']),
            ad_group: pickPath(row, ['adGroup', 'name'])
          };
          for (const d of otherSegments) baseRow[d] = pickPath(row, SEGMENT_DIMS[d].path);
          const m = row.metrics || {};
          baseRow._m = {
            impressions: parseInt(m.impressions || 0, 10),
            clicks: parseInt(m.clicks || 0, 10),
            cost_micros: parseInt(m.costMicros || 0, 10),
            conversions: parseFloat(m.conversions || 0)
          };
          adGroupRows.get(agId).push(baseRow);
        }
      }
      debug.counts.base = cnt;
    }

    // Step 3: build the cross-product. For each ad_group:
    //   - take its base segment rows (or one fake row if only demographics asked)
    //   - take each demographic dim's distribution for that ad_group
    //   - emit synthetic rows = baseRow × demo combos, weighting metrics by demo share
    function rowsForAdGroup(agId) {
      const baseList = adGroupRows.get(agId) && adGroupRows.get(agId).length ? adGroupRows.get(agId)
        : [{ campaign: '', ad_group: '', _m: null }];

      // For each demo dim, get this ad_group's distribution
      const demoDists = allDemoDims.map(dim => {
        const adMap = demoData[dim] && demoData[dim].get(agId);
        if (!adMap || adMap.size === 0) return null;
        const total = [...adMap.values()].reduce((s, c) => s + c.impressions, 0);
        return {
          dim,
          buckets: [...adMap.entries()].map(([val, c]) => ({
            value: val,
            share: total > 0 ? c.impressions / total : 0,
            // Also keep absolute when there are no base rows (pure demographic query)
            abs: c
          })),
          totalImp: total
        };
      }).filter(Boolean);

      const out = [];
      for (const base of baseList) {
        if (demoDists.length === 0) {
          if (base._m) out.push({ ...base, _metrics: base._m });
          continue;
        }
        // Cartesian product across demo dims
        const stack = [{ row: { ...base }, weight: 1, absMetrics: null }];
        for (const dist of demoDists) {
          const next = [];
          for (const s of stack) {
            for (const b of dist.buckets) {
              const newRow = { ...s.row, [dist.dim]: b.value };
              const newWeight = s.weight * b.share;
              // If pure demographic (no base metrics), use absolute metrics from first dim
              const absMetrics = s.absMetrics || (s.row._m == null && demoDists.length === 1
                ? { impressions: b.abs.impressions, clicks: b.abs.clicks, cost_micros: b.abs.cost_micros, conversions: b.abs.conversions }
                : s.absMetrics);
              next.push({ row: newRow, weight: newWeight, absMetrics });
            }
          }
          stack.length = 0;
          stack.push(...next);
        }
        for (const s of stack) {
          if (base._m) {
            // Distribute base metrics by combined demographic weight
            s.row._metrics = {
              impressions: base._m.impressions * s.weight,
              clicks: base._m.clicks * s.weight,
              cost_micros: base._m.cost_micros * s.weight,
              conversions: base._m.conversions * s.weight
            };
          } else if (s.absMetrics) {
            s.row._metrics = s.absMetrics;
          }
          if (s.row._metrics) out.push(s.row);
        }
      }
      return out;
    }

    // Walk every ad_group seen in any pulled view
    const allAgIds = new Set();
    for (const m of Object.values(demoData)) for (const k of m.keys()) allAgIds.add(k);
    for (const k of adGroupRows.keys()) allAgIds.add(k);

    const allRows = [];
    for (const agId of allAgIds) {
      for (const r of rowsForAdGroup(agId)) {
        // Apply filters
        let pass = true;
        for (const [d, allowed] of Object.entries(filters || {})) {
          if (!allowed || allowed.length === 0) continue;
          if (!allowed.includes(String(r[d]))) { pass = false; break; }
        }
        if (!pass) continue;
        allRows.push(r);
      }
    }

    // Step 4: aggregate by selected `dimensions`
    const groups = new Map();
    for (const r of allRows) {
      const key = dimensions.map(d => r[d] != null ? String(r[d]) : 'UNKNOWN').join('||');
      if (!groups.has(key)) {
        const dimVals = {};
        dimensions.forEach(d => { dimVals[d] = r[d] != null ? String(r[d]) : 'UNKNOWN'; });
        groups.set(key, { ...dimVals, impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
      }
      const g = groups.get(key);
      g.impressions += r._metrics.impressions;
      g.clicks += r._metrics.clicks;
      g.cost_micros += r._metrics.cost_micros;
      g.conversions += r._metrics.conversions;
    }

    const rows = [...groups.values()].map(g => {
      const cost = g.cost_micros / 1_000_000;
      const dimVals = {};
      dimensions.forEach(d => { dimVals[d] = g[d]; });
      return {
        ...dimVals,
        impressions: Math.round(g.impressions),
        clicks: Math.round(g.clicks),
        cost: +cost.toFixed(2),
        conversions: +g.conversions.toFixed(2),
        ctr: g.impressions ? +(g.clicks / g.impressions * 100).toFixed(2) : 0,
        cpc: g.clicks ? +(cost / g.clicks).toFixed(2) : 0,
        conv_rate: g.clicks ? +(g.conversions / g.clicks * 100).toFixed(2) : 0,
        cpa: g.conversions ? +(cost / g.conversions).toFixed(2) : 0
      };
    });

    const sortMetric = sort && sort.metric || 'clicks';
    const sortDir = (sort && sort.dir) === 'asc' ? 1 : -1;
    rows.sort((a, b) => ((a[sortMetric] || 0) - (b[sortMetric] || 0)) * sortDir);
    const limited = rows.slice(0, Math.min(parseInt(limit, 10) || 200, 1000));

    const totals = rows.reduce((acc, r) => ({
      impressions: acc.impressions + r.impressions,
      clicks: acc.clicks + r.clicks,
      cost: +(acc.cost + r.cost).toFixed(2),
      conversions: +(acc.conversions + r.conversions).toFixed(2)
    }), { impressions: 0, clicks: 0, cost: 0, conversions: 0 });
    totals.ctr = totals.impressions ? +(totals.clicks / totals.impressions * 100).toFixed(2) : 0;
    totals.cpc = totals.clicks ? +(totals.cost / totals.clicks).toFixed(2) : 0;
    totals.conv_rate = totals.clicks ? +(totals.conversions / totals.clicks * 100).toFixed(2) : 0;
    totals.cpa = totals.conversions ? +(totals.cost / totals.conversions).toFixed(2) : 0;

    res.json({
      dimensions, filters, metrics, range,
      rows: limited, total_rows: rows.length, totals,
      diagnostic: {
        ...debug,
        notes: allDemoDims.length > 1
          ? 'Multiple demographic dimensions combined via per-view distribution × ad-group base metrics. Numbers are estimates because Google Ads does not expose true age × gender × income cross-tabs for Search campaigns.'
          : (allDemoDims.length === 1
            ? 'Single demographic dimension pulled directly from its view (exact).'
            : 'No demographic dimensions — exact metrics from ad_group segments.')
      }
    });
  } catch (err) {
    console.error('google-pivot error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/demographics/gender', authenticateToken, (req, res) =>
  pullDemographic(req, res, 'gender_view', 'ad_group_criterion.criterion_id', 'ad_group_criterion.gender.type', 'gender'));

router.get('/demographics/age-range', authenticateToken, (req, res) =>
  pullDemographic(req, res, 'age_range_view', 'ad_group_criterion.criterion_id', 'ad_group_criterion.age_range.type', 'age_range'));

router.get('/demographics/household-income', authenticateToken, (req, res) =>
  pullDemographic(req, res, 'income_range_view', 'ad_group_criterion.criterion_id', 'ad_group_criterion.income_range.type', 'income_range'));

router.get('/demographics/parental-status', authenticateToken, (req, res) =>
  pullDemographic(req, res, 'parental_status_view', 'ad_group_criterion.criterion_id', 'ad_group_criterion.parental_status.type', 'parental_status'));

router.get('/demographics/geo', authenticateToken, async (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.refresh_token_encrypted || !config.customer_id) {
      return res.status(400).json({ error: 'Google Ads not connected' });
    }
    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.status(401).json({ error: 'Failed to get Google Ads access token' });
    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    const range = dateClause(req);
    // user_location_view groups by physical location (where the user actually is)
    const query = `
      SELECT
        user_location_view.country_criterion_id,
        segments.geo_target_region,
        segments.geo_target_city,
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM user_location_view
      WHERE segments.date DURING ${range}
    `;
    const data = await runGadsQuery(query, accessToken, developerToken, config.customer_id, config.login_customer_id);
    const byRegion = new Map();
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        const region = row.segments?.geoTargetRegion || 'Unknown';
        if (!byRegion.has(region)) byRegion.set(region, { impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
        const b = byRegion.get(region);
        const m = row.metrics || {};
        b.impressions += parseInt(m.impressions || 0, 10);
        b.clicks += parseInt(m.clicks || 0, 10);
        b.cost_micros += parseInt(m.costMicros || 0, 10);
        b.conversions += parseFloat(m.conversions || 0);
      }
    }
    const rows = [...byRegion.entries()].map(([region, b]) => ({
      region_resource: region,
      impressions: b.impressions,
      clicks: b.clicks,
      cost: +(b.cost_micros / 1_000_000).toFixed(2),
      conversions: +b.conversions.toFixed(2),
      ctr: b.impressions ? +(b.clicks / b.impressions * 100).toFixed(2) : 0,
      cpc: b.clicks ? +(b.cost_micros / b.clicks / 1_000_000).toFixed(2) : 0,
      cpa: b.conversions ? +(b.cost_micros / b.conversions / 1_000_000).toFixed(2) : 0
    })).sort((a, b) => b.clicks - a.clicks);
    res.json({ range, rows });
  } catch (err) {
    console.error('geo demographics error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
