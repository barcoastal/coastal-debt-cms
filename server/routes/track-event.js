// /api/track-event — server-side mirror for browser-fired Meta Pixel events.
// Persists each event to meta_events and (if a CAPI access token is configured)
// fires the same event to Meta's Conversions API with the matching event_id so the
// pixel + CAPI events dedupe.
//
// POST /api/track-event
// Body: { event, event_id, placement, visitor_id, url, pdf_url }
//   event:        Meta event name (e.g. "Lead", "ViewContent")
//   event_id:     unique id matching the browser fbq() eventID for dedup
//   placement:    where the event fired (e.g. "hero", "form-submit")
//   visitor_id:   our internal visitor id
//   url:          page URL the user was on
//   pdf_url:      the PDF being downloaded (optional context)

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../database');

const META_API_VERSION = 'v21.0';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s).trim().toLowerCase()).digest('hex');
}
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

router.post('/', async (req, res) => {
  const {
    event = 'Lead',
    event_id,
    placement,
    visitor_id,
    url,
    pdf_url
  } = req.body || {};

  // Generate event_id server-side if missing so we can still record + dedupe
  const finalEventId = event_id || `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const userAgent = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const fbp = getCookie(req, '_fbp');
  const fbc = getCookie(req, '_fbc');

  // Persist locally — this is the source-of-truth for "every download"
  let rowId = null;
  try {
    const r = db.prepare(`
      INSERT OR IGNORE INTO meta_events
        (event_name, event_id, placement, visitor_id, url, pdf_url, user_agent, ip, fbp, fbc, capi_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(event, finalEventId, placement || null, visitor_id || null, url || null, pdf_url || null, userAgent, ip, fbp, fbc);
    rowId = r.lastInsertRowid;
  } catch (e) {
    console.error('meta_events insert failed:', e.message);
  }

  // Fire CAPI in the background — don't block the response
  res.json({ ok: true, event_id: finalEventId });

  setImmediate(() => fireCapi(rowId, {
    event_name: event,
    event_id: finalEventId,
    url: url || '',
    user_agent: userAgent,
    ip, fbp, fbc, visitor_id: visitor_id || ''
  }).catch(err => console.error('CAPI error:', err.message)));
});

async function fireCapi(rowId, ctx) {
  let cfg;
  try {
    cfg = db.prepare('SELECT pixel_id, capi_access_token, test_event_code FROM facebook_config WHERE id = 1').get();
  } catch (e) { return; }
  if (!cfg || !cfg.pixel_id || !cfg.capi_access_token) {
    if (rowId) db.prepare(`UPDATE meta_events SET capi_status = 'skipped' WHERE id = ?`).run(rowId);
    return;
  }

  const userData = {
    client_user_agent: ctx.user_agent || undefined,
    client_ip_address: ctx.ip || undefined,
    fbp: ctx.fbp || undefined,
    fbc: ctx.fbc || undefined
  };
  if (ctx.visitor_id) userData.external_id = sha256(ctx.visitor_id);

  const eventTime = Math.floor(Date.now() / 1000);
  const body = {
    data: [{
      event_name: ctx.event_name,
      event_time: eventTime,
      event_id: ctx.event_id,
      event_source_url: ctx.url || undefined,
      action_source: 'website',
      user_data: userData,
      custom_data: {
        content_name: 'MCA Debt Relief Guide',
        content_category: 'PDF Guide',
        content_ids: ['mca-debt-relief-guide'],
        content_type: 'product',
        currency: 'USD',
        value: 0
      }
    }]
  };
  if (cfg.test_event_code) body.test_event_code = cfg.test_event_code;

  const url = `https://graph.facebook.com/${META_API_VERSION}/${cfg.pixel_id}/events?access_token=${encodeURIComponent(cfg.capi_access_token)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();

  if (rowId) {
    db.prepare(`UPDATE meta_events SET capi_status = ?, capi_response = ? WHERE id = ?`).run(
      r.ok ? 'sent' : 'error',
      text.slice(0, 500),
      rowId
    );
  }
}

module.exports = router;
