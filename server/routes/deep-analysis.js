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

module.exports = router;
