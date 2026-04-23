const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../database');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'coastal-debt-secret-key-change-in-production';
const TOKEN_TTL = '7d';

function issueToken(affiliate) {
  return jwt.sign({
    scope: 'affiliate',
    affiliate_id: affiliate.affiliate_id,
    label: affiliate.label,
    key_id: affiliate.id
  }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAffiliateAuth(req, res, next) {
  const token = req.cookies?.affiliate_token
    || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.scope !== 'affiliate') return res.status(401).json({ error: 'Wrong token scope' });
    const aff = db.prepare('SELECT * FROM affiliate_keys WHERE id = ? AND is_active = 1').get(decoded.key_id);
    if (!aff) return res.status(401).json({ error: 'Affiliate not found or deactivated' });
    req.affiliate = aff;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- Login ---
router.post('/login', (req, res) => {
  const { affiliate_id, pin } = req.body || {};
  if (!affiliate_id || !pin) return res.status(400).json({ error: 'affiliate_id and pin required' });

  const aff = db.prepare('SELECT * FROM affiliate_keys WHERE affiliate_id = ? AND is_active = 1').get(String(affiliate_id).trim().toLowerCase());
  if (!aff || !aff.login_pin || aff.login_pin !== String(pin)) {
    return res.status(401).json({ error: 'Invalid affiliate ID or PIN' });
  }

  const token = issueToken(aff);
  res.cookie('affiliate_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  res.json({ token, affiliate_id: aff.affiliate_id, label: aff.label });
});

router.post('/logout', (req, res) => {
  res.clearCookie('affiliate_token');
  res.json({ status: 'ok' });
});

// --- Profile + stats ---
router.get('/me', requireAffiliateAuth, (req, res) => {
  const aff = req.affiliate;
  res.json({
    affiliate_id: aff.affiliate_id,
    label: aff.label,
    email: aff.email || '',
    api_key_preview: (aff.api_key || '').slice(0, 16) + '...',
    postback_url_template: aff.postback_url_template || '',
    default_payout_cents: aff.default_payout_cents || 0
  });
});

router.get('/me/stats', requireAffiliateAuth, (req, res) => {
  const affId = req.affiliate.affiliate_id;
  const totals = db.prepare(`
    SELECT
      COUNT(*) as leads_total,
      SUM(CASE WHEN DATE(created_at) = DATE('now') THEN 1 ELSE 0 END) as leads_today,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as leads_7d,
      SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as leads_30d
    FROM leads
    WHERE json_extract(hidden_fields, '$.affiliate_id') = ?
  `).get(affId);

  let conversions = { count: 0, total_payout: 0 };
  try {
    conversions = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(payout), 0) as total_payout
      FROM affiliate_outbound_events
      WHERE affiliate_id = ? AND http_status BETWEEN 200 AND 299
    `).get(affId) || conversions;
  } catch (e) {}

  res.json({
    leads: totals,
    conversions: { count: conversions.count || 0, total_payout_dollars: conversions.total_payout || 0 }
  });
});

router.get('/me/leads', requireAffiliateAuth, (req, res) => {
  const affId = req.affiliate.affiliate_id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = parseInt(req.query.offset, 10) || 0;
  const leads = db.prepare(`
    SELECT id, first_name, last_name, full_name, email, phone, company_name,
           debt_amount, has_mca, rt_clickid, eli_clickid, created_at, hidden_fields,
           transfer_status, stage, contract_sign_date
    FROM leads
    WHERE json_extract(hidden_fields, '$.affiliate_id') = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(affId, limit, offset);

  // For each lead, include the conversion events if any
  const enriched = leads.map(l => {
    let hf = {};
    try { hf = JSON.parse(l.hidden_fields || '{}'); } catch (e) {}
    let conversions = [];
    try {
      conversions = db.prepare(`
        SELECT event, http_status, payout, sent_at FROM affiliate_outbound_events WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 5
      `).all(l.id);
    } catch (e) {}
    return {
      id: l.id,
      created_at: l.created_at,
      name: l.full_name || ((l.first_name || '') + ' ' + (l.last_name || '')).trim(),
      email: l.email,
      phone: l.phone,
      company: l.company_name,
      debt_amount: l.debt_amount,
      has_mca: l.has_mca,
      click_id: l.rt_clickid || hf.click_id || hf.clickid || '',
      sub1: hf.sub1 || '',
      sub2: hf.sub2 || '',
      sub3: hf.sub3 || '',
      sub4: hf.sub4 || '',
      sub5: hf.sub5 || '',
      utm_source: hf.utm_source || '',
      utm_campaign: hf.utm_campaign || '',
      transfer_status: l.transfer_status || '',
      stage: l.stage || '',
      last_event: hf.last_event || '',
      conversions
    };
  });

  res.json({ leads: enriched, limit, offset });
});

module.exports = router;
