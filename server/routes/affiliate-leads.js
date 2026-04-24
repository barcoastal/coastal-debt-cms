const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const { authenticateToken } = require('./auth');

function sign(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

const router = express.Router();

function generateEliClickId() {
  return 'eli_' + crypto.randomBytes(12).toString('hex');
}

function generateApiKey() {
  return 'affk_' + crypto.randomBytes(24).toString('hex');
}

function getHub() {
  return db.prepare("SELECT id FROM landing_pages WHERE slug = 'affiliate-leads-hub'").get();
}

function getZapierUrl() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'affiliate_zapier_webhook_url'").get();
  return row ? row.value : '';
}

async function fireZapier(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, body: text.slice(0, 500) };
}

function buildZapierPayload(lead, affiliate, extra) {
  const hf = (() => { try { return JSON.parse(lead.hidden_fields || '{}'); } catch (e) { return {}; } })();
  return {
    lead_id: lead.id,
    eli_clickid: lead.eli_clickid,
    rt_clickid: lead.rt_clickid || hf.rt_clickid || hf.click_id || '',
    click_id: lead.rt_clickid || hf.rt_clickid || hf.click_id || '',
    affiliate_id: affiliate && affiliate.affiliate_id,
    affiliate_label: affiliate && affiliate.label,
    sub_id: hf.sub_id || '',
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    full_name: lead.full_name || '',
    email: lead.email || '',
    phone: lead.phone || '',
    company_name: lead.company_name || '',
    debt_amount: lead.debt_amount || '',
    has_mca: lead.has_mca || '',
    considered_bankruptcy: lead.considered_bankruptcy || '',
    gclid: lead.gclid || '',
    state: hf.state || '',
    created_at: lead.created_at,
    hidden_fields: hf,
    extra: extra || {}
  };
}

// --- Public endpoint: affiliates submit leads here ---
router.post('/submit', async (req, res) => {
  const apiKey = req.get('X-API-Key') || req.body.api_key || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

  const affiliate = db.prepare('SELECT * FROM affiliate_keys WHERE api_key = ? AND is_active = 1').get(apiKey);
  if (!affiliate) return res.status(401).json({ error: 'Invalid or revoked API key' });

  db.prepare('UPDATE affiliate_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(affiliate.id);

  const body = req.body || {};
  const firstName = body.first_name || body.firstName || '';
  const lastName = body.last_name || body.lastName || '';
  const email = body.email || '';
  const phone = body.phone || '';

  if (!email && !phone) {
    return res.status(400).json({ error: 'email or phone is required' });
  }

  const fullName = (firstName + ' ' + lastName).trim() || body.full_name || body.name || '';
  const hub = getHub();
  const landingPageId = hub ? hub.id : null;
  const eliClickid = body.eli_clickid || generateEliClickId();

  const known = new Set([
    'first_name','firstName','last_name','lastName','full_name','name','email','phone',
    'company_name','company','debt_amount','has_mca','considered_bankruptcy',
    'gclid','rt_clickid','eli_clickid','api_key'
  ]);
  const hiddenFields = {};
  for (const k of Object.keys(body)) {
    if (known.has(k)) continue;
    hiddenFields[k] = body[k];
  }
  hiddenFields.affiliate_id = affiliate.affiliate_id;
  hiddenFields.affiliate_label = affiliate.label;
  hiddenFields.utm_source = hiddenFields.utm_source || 'affiliate';
  hiddenFields.utm_medium = hiddenFields.utm_medium || 'affiliate';
  if (!hiddenFields.ip_address) hiddenFields.ip_address = req.ip;
  if (!hiddenFields.user_agent) hiddenFields.user_agent = req.get('User-Agent') || '';

  const info = db.prepare(`
    INSERT INTO leads (landing_page_id, full_name, first_name, last_name, company_name, email, phone,
      debt_amount, has_mca, considered_bankruptcy, gclid, rt_clickid, eli_clickid, hidden_fields)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    landingPageId, fullName, firstName, lastName,
    body.company_name || body.company || '', email, phone,
    body.debt_amount || '', body.has_mca || '', body.considered_bankruptcy || '',
    body.gclid || '', body.rt_clickid || body.click_id || '', eliClickid,
    JSON.stringify(hiddenFields)
  );

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(info.lastInsertRowid);

  // Fire Zapier asynchronously (don't block the affiliate's response)
  const zapierUrl = getZapierUrl();
  let zapierStatus = 'not_configured';
  let zapierDetail = '';
  if (zapierUrl) {
    try {
      const payload = buildZapierPayload(lead, affiliate, {});
      const result = await fireZapier(zapierUrl, payload);
      zapierStatus = result.ok ? 'sent' : 'failed';
      zapierDetail = `${result.status} ${result.body.slice(0, 200)}`;
    } catch (e) {
      zapierStatus = 'error';
      zapierDetail = e.message;
    }
  }

  // Record forward attempt
  try {
    db.prepare(`
      INSERT INTO affiliate_forward_events (lead_id, affiliate_id, target, status, detail, sent_at)
      VALUES (?, ?, 'zapier', ?, ?, CURRENT_TIMESTAMP)
    `).run(lead.id, affiliate.affiliate_id, zapierStatus, zapierDetail);
  } catch (e) { /* table may not exist on first run */ }

  res.json({
    status: 'accepted',
    lead_id: lead.id,
    eli_clickid: eliClickid,
    zapier: zapierStatus
  });
});

// --- Admin: list affiliate leads (any lead tagged with hidden_fields.affiliate_id) ---
router.get('/', authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const affiliateFilter = req.query.affiliate_id;

  let where = `json_extract(l.hidden_fields, '$.affiliate_id') IS NOT NULL AND json_extract(l.hidden_fields, '$.affiliate_id') != ''`;
  const params = [];
  if (affiliateFilter) {
    where += ` AND json_extract(l.hidden_fields, '$.affiliate_id') = ?`;
    params.push(affiliateFilter);
  }

  const leads = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.full_name, l.email, l.phone, l.company_name,
           l.debt_amount, l.has_mca, l.gclid, l.rt_clickid, l.eli_clickid, l.created_at, l.hidden_fields, l.payout_cents_override,
           lp.slug as landing_page_slug, lp.name as landing_page_name
    FROM leads l
    LEFT JOIN landing_pages lp ON l.landing_page_id = lp.id
    WHERE ${where}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as n FROM leads l WHERE ${where}`).get(...params).n;
  res.json({ leads, total, limit, offset });
});

// --- Admin: API keys CRUD ---
router.get('/keys', authenticateToken, (req, res) => {
  const keys = db.prepare('SELECT * FROM affiliate_keys ORDER BY created_at DESC').all();
  res.json({ keys });
});

router.post('/keys', authenticateToken, (req, res) => {
  const { affiliate_id, label, notes, email, postback_url_template, login_pin, default_payout_cents, postback_urls_by_event, webhook_secret } = req.body || {};
  if (!affiliate_id || !label) return res.status(400).json({ error: 'affiliate_id and label required' });

  const safeAffId = String(affiliate_id).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const existing = db.prepare('SELECT id FROM affiliate_keys WHERE affiliate_id = ?').get(safeAffId);
  if (existing) return res.status(400).json({ error: 'affiliate_id already exists' });

  let byEventJson = '{}';
  if (postback_urls_by_event) {
    try { byEventJson = JSON.stringify(typeof postback_urls_by_event === 'string' ? JSON.parse(postback_urls_by_event) : postback_urls_by_event); }
    catch (e) { return res.status(400).json({ error: 'postback_urls_by_event must be valid JSON' }); }
  }

  const apiKey = generateApiKey();
  const info = db.prepare(`
    INSERT INTO affiliate_keys (affiliate_id, label, api_key, notes, email, postback_url_template, login_pin, default_payout_cents, postback_urls_by_event, webhook_secret)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    safeAffId, label, apiKey, notes || '',
    email || '', postback_url_template || '', login_pin || '',
    parseInt(default_payout_cents, 10) || 0,
    byEventJson, webhook_secret || ''
  );

  res.json({
    id: info.lastInsertRowid,
    affiliate_id: safeAffId,
    label,
    api_key: apiKey
  });
});

router.patch('/keys/:id', authenticateToken, (req, res) => {
  const { is_active, label, notes, email, postback_url_template, login_pin, default_payout_cents, postback_urls_by_event, webhook_secret } = req.body || {};
  const fields = [];
  const params = [];
  if (typeof is_active !== 'undefined') { fields.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (typeof label !== 'undefined') { fields.push('label = ?'); params.push(label); }
  if (typeof notes !== 'undefined') { fields.push('notes = ?'); params.push(notes); }
  if (typeof email !== 'undefined') { fields.push('email = ?'); params.push(email); }
  if (typeof postback_url_template !== 'undefined') { fields.push('postback_url_template = ?'); params.push(postback_url_template); }
  if (typeof login_pin !== 'undefined') { fields.push('login_pin = ?'); params.push(login_pin); }
  if (typeof default_payout_cents !== 'undefined') { fields.push('default_payout_cents = ?'); params.push(parseInt(default_payout_cents, 10) || 0); }
  if (typeof postback_urls_by_event !== 'undefined') {
    try {
      const normalized = typeof postback_urls_by_event === 'string' ? JSON.parse(postback_urls_by_event) : postback_urls_by_event;
      fields.push('postback_urls_by_event = ?'); params.push(JSON.stringify(normalized || {}));
    } catch (e) { return res.status(400).json({ error: 'postback_urls_by_event must be valid JSON' }); }
  }
  if (typeof webhook_secret !== 'undefined') { fields.push('webhook_secret = ?'); params.push(webhook_secret); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE affiliate_keys SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ status: 'ok' });
});

// Set / clear per-lead payout override
router.patch('/leads/:id/payout', authenticateToken, (req, res) => {
  const { payout_cents } = req.body || {};
  const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (payout_cents === null || payout_cents === '' || typeof payout_cents === 'undefined') {
    db.prepare('UPDATE leads SET payout_cents_override = NULL WHERE id = ?').run(req.params.id);
    return res.json({ status: 'cleared' });
  }
  const v = parseInt(payout_cents, 10);
  if (isNaN(v) || v < 0) return res.status(400).json({ error: 'payout_cents must be a non-negative integer' });
  db.prepare('UPDATE leads SET payout_cents_override = ? WHERE id = ?').run(v, req.params.id);
  res.json({ status: 'ok', payout_cents: v });
});

// Fire outbound postback to affiliate — called on conversion events
// Resolution order for URL: per-event map → default postback_url_template
// Resolution order for payout: explicit arg → lead.payout_cents_override → affiliate.default_payout_cents
async function fireAffiliatePostback(lead, event, payoutCents) {
  let hf = {};
  try { hf = JSON.parse(lead.hidden_fields || '{}'); } catch (e) {}
  const affId = hf.affiliate_id || hf.aff;
  if (!affId) return { skipped: true, reason: 'No affiliate_id on lead' };

  const aff = db.prepare('SELECT * FROM affiliate_keys WHERE affiliate_id = ? AND is_active = 1').get(affId);
  if (!aff) return { skipped: true, reason: 'Affiliate not found or inactive' };

  // Pick URL: event-specific first, then default
  let urlTemplate = '';
  try {
    const byEvent = JSON.parse(aff.postback_urls_by_event || '{}');
    if (event && byEvent[event]) urlTemplate = byEvent[event];
  } catch (e) {}
  if (!urlTemplate) urlTemplate = aff.postback_url_template || '';
  if (!urlTemplate) return { skipped: true, reason: 'No postback URL configured for this event or default' };

  // Payout: explicit → lead override → affiliate default
  let payout;
  if (typeof payoutCents === 'number') payout = payoutCents;
  else if (lead.payout_cents_override != null) payout = lead.payout_cents_override;
  else payout = aff.default_payout_cents || 0;
  const payoutDollars = (payout / 100).toFixed(2);
  const clickId = hf.click_id || hf.clickid || lead.rt_clickid || hf.sub_id || '';
  const ts = Math.floor(Date.now() / 1000);

  const replacements = {
    clickid: clickId,
    click_id: clickId,
    sub1: hf.sub1 || '', sub2: hf.sub2 || '', sub3: hf.sub3 || '',
    sub4: hf.sub4 || '', sub5: hf.sub5 || '',
    payout: payoutDollars,
    payout_cents: String(payout),
    event: event || 'conversion',
    lead_id: String(lead.id),
    email: lead.email || '',
    phone: lead.phone || '',
    eli_clickid: lead.eli_clickid || '',
    timestamp: String(ts)
  };

  // First pass: fill all replacements except {sig}
  let url = urlTemplate;
  for (const [k, v] of Object.entries(replacements)) {
    if (k === 'sig') continue;
    url = url.replace(new RegExp('\\{' + k + '\\}', 'g'), encodeURIComponent(v));
  }
  // Signature: HMAC-SHA256 of clickid|event|payout_cents|timestamp (stable payload)
  let signature = '';
  if (aff.webhook_secret) {
    const signPayload = [clickId, event || 'conversion', String(payout), String(ts)].join('|');
    signature = sign(aff.webhook_secret, signPayload);
  }
  url = url.replace(/\{sig\}/g, encodeURIComponent(signature));

  const headers = {};
  if (signature) {
    headers['X-Signature'] = 'sha256=' + signature;
    headers['X-Signature-Timestamp'] = String(ts);
  }

  try {
    const res = await fetch(url, { method: 'GET', headers });
    const body = await res.text();
    const truncated = body.slice(0, 500);
    try {
      db.prepare(`
        INSERT INTO affiliate_outbound_events (lead_id, affiliate_id, event, url, http_status, response_body, payout)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lead.id, affId, event || 'conversion', url, res.status, truncated, payout / 100);
    } catch (e) {}
    return { sent: true, http_status: res.status, url, body: truncated, signed: !!signature };
  } catch (err) {
    try {
      db.prepare(`
        INSERT INTO affiliate_outbound_events (lead_id, affiliate_id, event, url, http_status, response_body, payout)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).run(lead.id, affId, event || 'conversion', url, String(err.message).slice(0, 500), payout / 100);
    } catch (e) {}
    return { sent: false, error: err.message };
  }
}

// Admin: manual fire of affiliate postback
router.post('/:id/fire-postback', authenticateToken, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { event, payout_cents } = req.body || {};
  const result = await fireAffiliatePostback(lead, event || 'conversion', typeof payout_cents !== 'undefined' ? parseInt(payout_cents, 10) : undefined);
  res.json(result);
});

// Admin: outbound postback events log
router.get('/outbound-events', authenticateToken, (req, res) => {
  const leadId = req.query.lead_id;
  let rows = [];
  try {
    if (leadId) {
      rows = db.prepare('SELECT * FROM affiliate_outbound_events WHERE lead_id = ? ORDER BY sent_at DESC').all(leadId);
    } else {
      rows = db.prepare('SELECT * FROM affiliate_outbound_events ORDER BY sent_at DESC LIMIT 200').all();
    }
  } catch (e) { rows = []; }
  res.json({ events: rows });
});

router.delete('/keys/:id', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM affiliate_keys WHERE id = ?').run(req.params.id);
  res.json({ status: 'ok' });
});

// --- Admin: Zapier webhook config ---
router.get('/config', authenticateToken, (req, res) => {
  res.json({ zapier_webhook_url: getZapierUrl() });
});

router.post('/config', authenticateToken, (req, res) => {
  const { zapier_webhook_url } = req.body || {};
  const url = (zapier_webhook_url || '').trim();
  db.prepare(`INSERT INTO settings (key, value) VALUES ('affiliate_zapier_webhook_url', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(url);
  res.json({ status: 'ok', zapier_webhook_url: url });
});

// --- Admin: resend a lead to Zapier ---
router.post('/:id/resend', authenticateToken, async (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const hidden = (() => { try { return JSON.parse(lead.hidden_fields || '{}'); } catch (e) { return {}; } })();
  const affiliate = hidden.affiliate_id
    ? db.prepare('SELECT * FROM affiliate_keys WHERE affiliate_id = ?').get(hidden.affiliate_id)
    : null;

  const zapierUrl = getZapierUrl();
  if (!zapierUrl) return res.status(400).json({ error: 'Zapier webhook URL not configured' });

  try {
    const result = await fireZapier(zapierUrl, buildZapierPayload(lead, affiliate, {}));
    try {
      db.prepare(`
        INSERT INTO affiliate_forward_events (lead_id, affiliate_id, target, status, detail, sent_at)
        VALUES (?, ?, 'zapier', ?, ?, CURRENT_TIMESTAMP)
      `).run(lead.id, hidden.affiliate_id || '', result.ok ? 'sent' : 'failed', `${result.status} ${result.body.slice(0, 200)}`);
    } catch (e) { /* table may not exist */ }
    res.json({ status: result.ok ? 'sent' : 'failed', http_status: result.status, body: result.body });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Admin: Zapier forward events log ---
router.get('/forwards', authenticateToken, (req, res) => {
  const leadId = req.query.lead_id;
  let rows = [];
  try {
    if (leadId) {
      rows = db.prepare('SELECT * FROM affiliate_forward_events WHERE lead_id = ? ORDER BY sent_at DESC').all(leadId);
    } else {
      rows = db.prepare('SELECT * FROM affiliate_forward_events ORDER BY sent_at DESC LIMIT 200').all();
    }
  } catch (e) { rows = []; }
  res.json({ events: rows });
});

module.exports = router;
module.exports.fireAffiliatePostback = fireAffiliatePostback;
