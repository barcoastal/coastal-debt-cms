const express = require('express');
const db = require('../database');
const { authenticateToken } = require('./auth');
const { getConfiguredTimezone, localDateToUtcRange, getTodayInTz, getTimezoneOffsetHours, getSqliteOffsetStr } = require('../lib/timezone');

const router = express.Router();

// RedTrack server-side click creation for visitors
const RT_API_KEY = process.env.REDTRACK_API_KEY || 'tQqIhdIIBzLQg3J9Z3zs';
const RT_CAMPAIGNS = {
  google:   '6855272ea2fde3e964e81fb6',
  bing:     '685d8993e716389bea3a393a',
  meta:     '685e703c73306f36aa1ddcd3',
  facebook: '685e703c73306f36aa1ddcd3',
  tiktok:   '697a25cdcad13a4d8c67233e',
  reddit:   '69b90b3d6ee379cc32a10958',
  outbrain: '6936e2124771cdaf5c31b2bf',
  vibe:     '697a30edb0f7a392bd042a3c',
  organic:  '685425cdc6ecfb983788b92c'
};

async function createRedTrackClick(source, params = {}) {
  try {
    const campaignHash = RT_CAMPAIGNS[source?.toLowerCase()] || RT_CAMPAIGNS.organic;
    const url = new URL(`https://click.coastaldebt.com/${campaignHash}`);
    url.searchParams.set('format', 'json');
    if (params.gclid) url.searchParams.set('ref_id', params.gclid);
    if (params.fbclid) url.searchParams.set('ref_id', params.fbclid);
    if (params.msclkid) url.searchParams.set('ref_id', params.msclkid);
    if (params.utm_source) url.searchParams.set('utm_source', params.utm_source);

    console.log(`[RedTrack] Creating click: source=${source}, campaign=${campaignHash}, url=${url.toString()}`);

    const res = await fetch(url.toString(), {
      headers: { 'X-API-KEY': RT_API_KEY },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    });

    console.log(`[RedTrack] Response: status=${res.status}, type=${res.headers.get('content-type')}`);

    if (res.status >= 300) {
      const text = await res.text();
      console.error(`[RedTrack] Non-200 response: ${res.status} — ${text.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    console.log(`[RedTrack] Response data:`, JSON.stringify(data));

    if (data.clickid) {
      console.log(`[RedTrack] Click created: ${data.clickid} (source: ${source})`);
      return data.clickid;
    }
    console.warn(`[RedTrack] No clickid in response`);
    return null;
  } catch (err) {
    console.error(`[RedTrack] Click creation failed: ${err.name}: ${err.message}`);
    return null;
  }
}

// Debug endpoint — test RedTrack click creation from production server
router.get('/test-redtrack', authenticateToken, async (req, res) => {
  const source = req.query.source || 'google';
  const gclid = req.query.gclid || 'test_' + Date.now();
  const result = await createRedTrackClick(source, { gclid, utm_source: source });
  res.json({ source, gclid, rt_clickid: result, success: !!result });
});

// Lookup visitor by eli_clickid
router.get('/lookup/:eli', authenticateToken, (req, res) => {
  const visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(req.params.eli);
  if (!visitor) return res.status(404).json({ error: 'Visitor not found' });
  // Also find associated lead
  const lead = db.prepare('SELECT * FROM leads WHERE eli_clickid = ?').get(req.params.eli);
  res.json({ visitor, lead: lead || null });
});

// Return visitor IP (public endpoint - called from landing pages)
router.get('/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  res.json({ ip });
});

// Track visitor (public endpoint - called from landing pages)
router.post('/track', async (req, res) => {
  const {
    eli_clickid,
    gclid,
    msclkid,
    rt_clickid: rt_clickid_body,
    fbclid,
    fbc,
    fbp,
    rdt_cid,
    user_agent,
    browser,
    browser_version,
    os,
    os_version,
    device_type,
    screen_width,
    screen_height,
    language,
    timezone,
    referrer_url,
    landing_page,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    ab_variant
  } = req.body;

  // Get rt_clickid from: body → cookie → create server-side via RedTrack API
  let rt_clickid = rt_clickid_body || req.cookies?.['rtkclickid-store'] || '';
  if (!rt_clickid || rt_clickid === 'adblock_blocked') {
    const source = gclid ? 'google' : msclkid ? 'bing' : fbclid ? 'facebook' : rdt_cid ? 'reddit' : (utm_source || '').toLowerCase() || 'organic';
    const ssClickId = await createRedTrackClick(source, { gclid, fbclid, msclkid, utm_source });
    rt_clickid = ssClickId || 'adblock_blocked';
  }
  console.log('Visitor rt_clickid:', { body: rt_clickid_body, cookie: req.cookies?.['rtkclickid-store'], final: rt_clickid });

  if (!eli_clickid) {
    return res.status(400).json({ error: 'eli_clickid required' });
  }

  // Get IP address
  const ip_address = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                     req.headers['x-real-ip'] ||
                     req.connection?.remoteAddress ||
                     req.ip || '';

  // Check if visitor exists
  const existing = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(eli_clickid);

  if (existing) {
    // Update existing visitor
    db.prepare(`
      UPDATE visitors SET
        last_visit = CURRENT_TIMESTAMP,
        visit_count = visit_count + 1,
        gclid = COALESCE(NULLIF(?, ''), gclid),
        msclkid = COALESCE(NULLIF(?, ''), msclkid),
        rt_clickid = COALESCE(NULLIF(?, ''), rt_clickid),
        fbclid = COALESCE(NULLIF(?, ''), fbclid),
        fbc = COALESCE(NULLIF(?, ''), fbc),
        fbp = COALESCE(NULLIF(?, ''), fbp),
        rdt_cid = COALESCE(NULLIF(?, ''), rdt_cid),
        landing_page = COALESCE(NULLIF(?, ''), landing_page),
        utm_source = COALESCE(NULLIF(?, ''), utm_source),
        utm_medium = COALESCE(NULLIF(?, ''), utm_medium),
        utm_campaign = COALESCE(NULLIF(?, ''), utm_campaign),
        utm_term = COALESCE(NULLIF(?, ''), utm_term),
        utm_content = COALESCE(NULLIF(?, ''), utm_content),
        ab_variant = COALESCE(NULLIF(?, ''), ab_variant)
      WHERE eli_clickid = ?
    `).run(gclid || '', msclkid || '', rt_clickid || '', fbclid || '', fbc || '', fbp || '', rdt_cid || '', landing_page || '', utm_source || '', utm_medium || '', utm_campaign || '', utm_term || '', utm_content || '', ab_variant || '', eli_clickid);

    res.json({ success: true, visitor_id: existing.id, returning: true });
  } else {
    // Create new visitor
    const result = db.prepare(`
      INSERT INTO visitors (
        eli_clickid, gclid, msclkid, rt_clickid, fbclid, fbc, fbp, rdt_cid, ip_address,
        user_agent, browser, browser_version, os, os_version, device_type,
        screen_width, screen_height, language, timezone,
        referrer_url, landing_page,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, ab_variant
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eli_clickid,
      gclid || '',
      msclkid || '',
      rt_clickid || '',
      fbclid || '',
      fbc || '',
      fbp || '',
      rdt_cid || '',
      ip_address,
      user_agent || '',
      browser || '',
      browser_version || '',
      os || '',
      os_version || '',
      device_type || '',
      screen_width || 0,
      screen_height || 0,
      language || '',
      timezone || '',
      referrer_url || '',
      landing_page || '',
      utm_source || '',
      utm_medium || '',
      utm_campaign || '',
      utm_term || '',
      utm_content || '',
      ab_variant || ''
    );

    // Try to get geo info from IP (async, don't wait)
    if (ip_address && ip_address !== '::1' && ip_address !== '127.0.0.1') {
      fetchGeoInfo(ip_address, result.lastInsertRowid);
    }

    res.json({ success: true, visitor_id: result.lastInsertRowid, returning: false });
  }
});

// Fetch geo info from IP (background)
async function fetchGeoInfo(ip, visitorId) {
  try {
    // Using ip-api.com (free, no API key needed, 45 req/min limit)
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country,timezone,isp`);
    const data = await response.json();

    if (data.status === 'success') {
      db.prepare(`
        UPDATE visitors SET
          city = ?,
          region = ?,
          country = ?,
          timezone = COALESCE(NULLIF(timezone, ''), ?),
          isp = ?
        WHERE id = ?
      `).run(
        data.city || '',
        data.regionName || '',
        data.country || '',
        data.timezone || '',
        data.isp || '',
        visitorId
      );
    }
  } catch (err) {
    console.error('Geo lookup failed:', err.message);
  }
}

// Get all visitors (admin)
router.get('/', authenticateToken, (req, res) => {
  const tz = getConfiguredTimezone();
  const offsetStr = getSqliteOffsetStr(tz);
  const { page = 1, limit = 50, converted, search, from_date, to_date } = req.query;
  const offset = (page - 1) * limit;

  let query = `SELECT * FROM visitors WHERE 1=1`;
  let countQuery = `SELECT COUNT(*) as total FROM visitors WHERE 1=1`;
  const params = [];

  if (converted !== undefined && converted !== '') {
    query += ` AND converted = ?`;
    countQuery += ` AND converted = ?`;
    params.push(converted === 'true' || converted === '1' ? 1 : 0);
  }

  if (search) {
    query += ` AND (eli_clickid LIKE ? OR ip_address LIKE ? OR city LIKE ? OR country LIKE ?)`;
    countQuery += ` AND (eli_clickid LIKE ? OR ip_address LIKE ? OR city LIKE ? OR country LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (from_date) {
    query += ` AND DATE(last_visit, '${offsetStr}') >= DATE(?)`;
    countQuery += ` AND DATE(last_visit, '${offsetStr}') >= DATE(?)`;
    params.push(from_date);
  }

  if (to_date) {
    query += ` AND DATE(last_visit, '${offsetStr}') <= DATE(?)`;
    countQuery += ` AND DATE(last_visit, '${offsetStr}') <= DATE(?)`;
    params.push(to_date);
  }

  const total = db.prepare(countQuery).get(...params).total;

  query += ` ORDER BY last_visit DESC LIMIT ? OFFSET ?`;
  const visitors = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));

  res.json({
    visitors,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// Get single visitor
router.get('/:id', authenticateToken, (req, res) => {
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(req.params.id);

  if (!visitor) {
    return res.status(404).json({ error: 'Visitor not found' });
  }

  res.json(visitor);
});

// Get visitor by eli_clickid
router.get('/by-clickid/:clickid', authenticateToken, (req, res) => {
  const visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(req.params.clickid);

  if (!visitor) {
    return res.status(404).json({ error: 'Visitor not found' });
  }

  res.json(visitor);
});

// Export visitors to CSV
router.get('/export/csv', authenticateToken, (req, res) => {
  const { converted } = req.query;

  let query = `SELECT * FROM visitors WHERE 1=1`;
  const params = [];

  if (converted !== undefined && converted !== '') {
    query += ` AND converted = ?`;
    params.push(converted === 'true' || converted === '1' ? 1 : 0);
  }

  query += ` ORDER BY last_visit DESC`;
  const visitors = db.prepare(query).all(...params);

  const headers = [
    'ID', 'Eli Click ID', 'GCLID', 'RT Click ID', 'IP Address',
    'City', 'Region', 'Country', 'Timezone', 'ISP',
    'Browser', 'OS', 'Device Type', 'Screen',
    'Language', 'Referrer', 'Landing Page',
    'UTM Source', 'UTM Medium', 'UTM Campaign',
    'Converted', 'Lead ID', 'First Visit', 'Last Visit', 'Visits'
  ];

  const rows = visitors.map(v => [
    v.id,
    v.eli_clickid,
    v.gclid,
    v.rt_clickid,
    v.ip_address,
    v.city,
    v.region,
    v.country,
    v.timezone,
    v.isp,
    `${v.browser} ${v.browser_version}`,
    `${v.os} ${v.os_version}`,
    v.device_type,
    `${v.screen_width}x${v.screen_height}`,
    v.language,
    v.referrer_url,
    v.landing_page,
    v.utm_source,
    v.utm_medium,
    v.utm_campaign,
    v.converted ? 'Yes' : 'No',
    v.lead_id || '',
    v.first_visit,
    v.last_visit,
    v.visit_count
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.map(cell => `"${cell || ''}"`).join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=visitors-${Date.now()}.csv`);
  res.send(csv);
});

// Track phone click (public endpoint - called from landing pages)
router.post('/phone-click', (req, res) => {
  const { eli_clickid, page_slug } = req.body;

  if (!eli_clickid) {
    return res.status(400).json({ error: 'eli_clickid required' });
  }

  try {
    // Mark visitor as converted
    db.prepare(`
      UPDATE visitors SET converted = 1, last_visit = CURRENT_TIMESTAMP
      WHERE eli_clickid = ?
    `).run(eli_clickid);

    // Log activity
    db.prepare(`
      INSERT INTO activity_logs (action, entity_type, details, created_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run('phone_click', 'visitor', JSON.stringify({ eli_clickid, page_slug: page_slug || '' }));

    res.json({ success: true });
  } catch (err) {
    console.error('Phone click tracking error:', err.message);
    res.status(500).json({ error: 'Failed to track phone click' });
  }
});

module.exports = router;
