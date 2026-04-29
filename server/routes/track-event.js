// /api/track-event — server-side mirror for browser-fired Meta Pixel events.
// Persists each event to meta_events and fans out to Meta's Conversions API
// via the existing sendFacebookEvent() helper in routes/facebook.js (which
// authenticates with facebook_config.page_access_token).
// Browser-fired fbq() and server CAPI dedupe on the shared event_id.
//
// POST /api/track-event
// Body: { event, event_id, placement, visitor_id, url, pdf_url }
//   event:        Meta event name (default "Lead")
//   event_id:     unique id matching the browser fbq() eventID for dedup
//   placement:    where the event fired (e.g. "hero", "form-submit")
//   visitor_id:   our internal visitor id
//   url:          page URL the user was on
//   pdf_url:      the PDF being downloaded (optional context)

const express = require('express');
const router = express.Router();
const { db } = require('../database');
const facebookModule = require('./facebook');
const sendFacebookEvent = facebookModule.sendFacebookEvent;

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

  const finalEventId = event_id || `srv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const userAgent = req.headers['user-agent'] || '';
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const fbp = getCookie(req, '_fbp');
  const fbc = getCookie(req, '_fbc');

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

  res.json({ ok: true, event_id: finalEventId });

  setImmediate(async () => {
    try {
      const result = await sendFacebookEvent(event, {
        client_user_agent: userAgent,
        client_ip_address: ip,
        fbp, fbc
      }, {
        event_id: finalEventId,
        event_source_url: url || undefined
      });
      if (rowId) {
        const status = result.success ? 'sent' : (result.error && /not configured/i.test(result.error) ? 'skipped' : 'error');
        const response = result.success
          ? `events_received: ${result.events_received || 0}`
          : (result.error || 'unknown');
        db.prepare(`UPDATE meta_events SET capi_status = ?, capi_response = ? WHERE id = ?`)
          .run(status, String(response).slice(0, 500), rowId);
      }
    } catch (err) {
      console.error('CAPI fan-out error:', err.message);
      if (rowId) {
        db.prepare(`UPDATE meta_events SET capi_status = 'error', capi_response = ? WHERE id = ?`)
          .run(String(err.message).slice(0, 500), rowId);
      }
    }
  });
});

module.exports = router;
