const express = require('express');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

const HMAC_SECRET = process.env.ENCRYPTION_KEY || 'coastal-debt-cms-encryption-key-32';

// 1x1 transparent GIF
const TRACKING_PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function generateToken(queueId) {
  const data = String(queueId);
  const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex').slice(0, 16);
  const encoded = Buffer.from(data).toString('base64url');
  return encoded + '.' + hmac;
}

function verifyToken(token) {
  try {
    const [encoded, hmac] = token.split('.');
    if (!encoded || !hmac) return null;
    const data = Buffer.from(encoded, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex').slice(0, 16);
    if (hmac !== expected) return null;
    return parseInt(data);
  } catch (e) {
    return null;
  }
}

// Click tracking token includes queue_id and URL
function generateClickToken(queueId, url) {
  const data = JSON.stringify({ q: queueId, u: url });
  const hmac = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex').slice(0, 16);
  const encoded = Buffer.from(data).toString('base64url');
  return encoded + '.' + hmac;
}

function verifyClickToken(token) {
  try {
    const [encoded, hmac] = token.split('.');
    if (!encoded || !hmac) return null;
    const data = Buffer.from(encoded, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex').slice(0, 16);
    if (hmac !== expected) return null;
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

// GET /t/o/:token.gif — Open tracking pixel
router.get('/o/:tokenFile', (req, res) => {
  const tokenParam = req.params.tokenFile.replace(/\.gif$/, '');
  const queueId = verifyToken(tokenParam);

  if (queueId) {
    try {
      const item = db.prepare('SELECT id, campaign_id, lead_id FROM email_queue WHERE id = ?').get(queueId);
      if (item) {
        // Record open event
        db.prepare(`
          INSERT INTO email_opens (queue_id, campaign_id, lead_id, ip_address, user_agent)
          VALUES (?, ?, ?, ?, ?)
        `).run(queueId, item.campaign_id, item.lead_id, req.ip, req.headers['user-agent'] || '');

        // Update queue item
        db.prepare(`
          UPDATE email_queue SET open_count = open_count + 1,
          opened_at = COALESCE(opened_at, CURRENT_TIMESTAMP) WHERE id = ?
        `).run(queueId);

        // Update campaign counter (only increment on first open per queue item)
        if (item.campaign_id) {
          const openCount = db.prepare('SELECT open_count FROM email_queue WHERE id = ?').get(queueId);
          if (openCount && openCount.open_count === 1) {
            db.prepare('UPDATE email_campaigns SET open_count = open_count + 1 WHERE id = ?').run(item.campaign_id);
          }
        }
      }
    } catch (e) {
      console.error('Open tracking error:', e.message);
    }
  }

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': TRACKING_PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });
  res.send(TRACKING_PIXEL);
});

// GET /t/c/:token — Click tracking redirect
router.get('/c/:token', (req, res) => {
  const data = verifyClickToken(req.params.token);

  if (!data || !data.u) {
    return res.status(400).send('Invalid link');
  }

  const queueId = data.q;
  const originalUrl = data.u;

  if (queueId) {
    try {
      const item = db.prepare('SELECT id, campaign_id, lead_id FROM email_queue WHERE id = ?').get(queueId);
      if (item) {
        // Record click event
        db.prepare(`
          INSERT INTO email_clicks (queue_id, campaign_id, lead_id, original_url, ip_address, user_agent)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(queueId, item.campaign_id, item.lead_id, originalUrl, req.ip, req.headers['user-agent'] || '');

        // Update queue item
        db.prepare(`
          UPDATE email_queue SET click_count = click_count + 1,
          clicked_at = COALESCE(clicked_at, CURRENT_TIMESTAMP) WHERE id = ?
        `).run(queueId);

        // Update campaign counter (only on first click per queue item)
        if (item.campaign_id) {
          const clickCount = db.prepare('SELECT click_count FROM email_queue WHERE id = ?').get(queueId);
          if (clickCount && clickCount.click_count === 1) {
            db.prepare('UPDATE email_campaigns SET click_count = click_count + 1 WHERE id = ?').run(item.campaign_id);
          }
        }
      }
    } catch (e) {
      console.error('Click tracking error:', e.message);
    }
  }

  res.redirect(302, originalUrl);
});

// GET /t/u/:token — Unsubscribe page
router.get('/u/:token', (req, res) => {
  const queueId = verifyToken(req.params.token);
  if (!queueId) return res.status(400).send('Invalid unsubscribe link');

  const item = db.prepare('SELECT id, to_email, to_name, campaign_id FROM email_queue WHERE id = ?').get(queueId);
  if (!item) return res.status(404).send('Not found');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f3f4f6;margin:0}
.card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:400px;text-align:center}
h2{margin:0 0 12px;color:#1f2937}p{color:#6b7280;margin:0 0 24px}
button{background:#ef4444;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:1rem;cursor:pointer}
button:hover{background:#dc2626}.success{color:#10b981}</style></head>
<body><div class="card">
<h2>Unsubscribe</h2>
<p>Remove <strong>${item.to_email}</strong> from our mailing list?</p>
<form method="POST" action="/t/u/${req.params.token}">
  <button type="submit">Unsubscribe</button>
</form>
</div></body></html>`);
});

// POST /t/u/:token — Process unsubscribe
router.post('/u/:token', express.urlencoded({ extended: false }), (req, res) => {
  const queueId = verifyToken(req.params.token);
  if (!queueId) return res.status(400).send('Invalid unsubscribe link');

  const item = db.prepare('SELECT id, to_email, lead_id, campaign_id FROM email_queue WHERE id = ?').get(queueId);
  if (!item) return res.status(404).send('Not found');

  try {
    // Record unsubscribe
    db.prepare(`
      INSERT INTO email_unsubscribes (lead_id, email, campaign_id, reason)
      VALUES (?, ?, ?, 'user_request')
    `).run(item.lead_id, item.to_email, item.campaign_id);

    // Mark lead as unsubscribed
    if (item.lead_id) {
      db.prepare('UPDATE leads SET email_unsubscribed = 1 WHERE id = ?').run(item.lead_id);
    }

    // Update campaign counter
    if (item.campaign_id) {
      db.prepare('UPDATE email_campaigns SET unsubscribe_count = unsubscribe_count + 1 WHERE id = ?').run(item.campaign_id);
    }
  } catch (e) {
    console.error('Unsubscribe error:', e.message);
  }

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f3f4f6;margin:0}
.card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:400px;text-align:center}
h2{margin:0 0 12px;color:#10b981}p{color:#6b7280}</style></head>
<body><div class="card">
<h2>Unsubscribed</h2>
<p>You have been removed from our mailing list. You will no longer receive marketing emails from us.</p>
</div></body></html>`);
});

module.exports = router;
module.exports.generateToken = generateToken;
module.exports.generateClickToken = generateClickToken;
