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

router.post('/google-pivot', authenticateToken, async (req, res) => {
  try {
    const {
      dimensions = ['age'],
      filters = {},
      metrics = ['clicks', 'cost', 'conversions', 'conv_rate', 'cpa'],
      sort = { metric: 'clicks', dir: 'desc' },
      days = 30,
      limit = 200
    } = req.body || {};

    if (!dimensions.length) return res.status(400).json({ error: 'At least one dimension required' });
    for (const d of dimensions) {
      if (!PIVOT_DIM_MAP[d]) return res.status(400).json({ error: `Unknown dimension: ${d}` });
    }
    for (const d of Object.keys(filters || {})) {
      if (!PIVOT_DIM_MAP[d]) return res.status(400).json({ error: `Unknown filter dimension: ${d}` });
    }

    const config = db.prepare('SELECT * FROM google_ads_config WHERE id = 1').get();
    if (!config || !config.refresh_token_encrypted || !config.customer_id) {
      return res.status(400).json({ error: 'Google Ads not connected' });
    }
    const accessToken = await googleAds.getValidAccessToken(config);
    if (!accessToken) return res.status(401).json({ error: 'Failed to get Google Ads access token' });
    const developerToken = googleAds.getDeveloperToken(config);
    if (!developerToken) return res.status(400).json({ error: 'Developer token not configured' });

    // Build SELECT — every dimension we'll group by OR filter on must be in SELECT
    const allDims = [...new Set([...dimensions, ...Object.keys(filters || {})])];
    const dimSelect = allDims.map(d => PIVOT_DIM_MAP[d].gadsField || PIVOT_DIM_MAP[d].gads);
    const metricSelect = ['metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions'];
    const range = ({ 7: 'LAST_7_DAYS', 14: 'LAST_14_DAYS', 30: 'LAST_30_DAYS', 90: 'LAST_90_DAYS' })[parseInt(days, 10)] || 'LAST_30_DAYS';

    // FROM clause: campaign gives best segment combination support
    const query = `
      SELECT ${[...dimSelect, ...metricSelect].join(', ')}
      FROM campaign
      WHERE segments.date DURING ${range}
        AND campaign.status = 'ENABLED'
    `;

    // Run query
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': developerToken,
      'Content-Type': 'application/json'
    };
    const lid = config.login_customer_id || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    if (lid) headers['login-customer-id'] = String(lid).replace(/-/g, '');
    const r = await fetch(
      `https://googleads.googleapis.com/v20/customers/${config.customer_id}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query }) }
    );
    const data = await r.json();
    const apiError = data.error || data[0]?.error;
    if (apiError) return res.status(400).json({ error: apiError.message || JSON.stringify(apiError) });

    // Pull dim value via path
    const getDim = (row, dim) => {
      const path = PIVOT_DIM_MAP[dim].path;
      let v = row;
      for (const p of path) { v = v && v[p]; if (v === undefined) break; }
      return v == null ? 'UNKNOWN' : String(v);
    };

    // Apply filters and aggregate
    const groups = new Map();
    for (const stream of data) {
      for (const row of (stream.results || [])) {
        // Filters
        let pass = true;
        for (const [d, allowed] of Object.entries(filters || {})) {
          if (!allowed || allowed.length === 0) continue;
          if (!allowed.includes(getDim(row, d))) { pass = false; break; }
        }
        if (!pass) continue;

        const key = dimensions.map(d => getDim(row, d)).join('||');
        if (!groups.has(key)) {
          const dimVals = {};
          dimensions.forEach(d => { dimVals[d] = getDim(row, d); });
          groups.set(key, { ...dimVals, impressions: 0, clicks: 0, cost_micros: 0, conversions: 0 });
        }
        const g = groups.get(key);
        const m = row.metrics || {};
        g.impressions += parseInt(m.impressions || 0, 10);
        g.clicks      += parseInt(m.clicks || 0, 10);
        g.cost_micros += parseInt(m.costMicros || 0, 10);
        g.conversions += parseFloat(m.conversions || 0);
      }
    }

    // Compute derived metrics
    const rows = [...groups.values()].map(g => {
      const cost = g.cost_micros / 1_000_000;
      return {
        ...dimensions.reduce((acc, d) => ({ ...acc, [d]: g[d] }), {}),
        impressions: g.impressions,
        clicks: g.clicks,
        cost: +cost.toFixed(2),
        conversions: +g.conversions.toFixed(2),
        ctr: g.impressions ? +(g.clicks / g.impressions * 100).toFixed(2) : 0,
        cpc: g.clicks ? +(cost / g.clicks).toFixed(2) : 0,
        conv_rate: g.clicks ? +(g.conversions / g.clicks * 100).toFixed(2) : 0,
        cpa: g.conversions ? +(cost / g.conversions).toFixed(2) : 0
      };
    });

    // Sort + limit
    const sortMetric = sort && sort.metric || 'clicks';
    const sortDir = (sort && sort.dir) === 'asc' ? 1 : -1;
    rows.sort((a, b) => ((a[sortMetric] || 0) - (b[sortMetric] || 0)) * sortDir);
    const limited = rows.slice(0, Math.min(parseInt(limit, 10) || 200, 1000));

    // Totals (for the un-limited filtered set so user sees the real total)
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
      dimensions,
      filters,
      metrics,
      range,
      rows: limited,
      total_rows: rows.length,
      totals
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
