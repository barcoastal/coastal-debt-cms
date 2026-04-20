# Reddit CAPI Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll RedTrack conversions every 5 min, filter to Reddit-sourced visitors, forward to Reddit Conversions API.

**Architecture:** `setInterval`-driven poller in `server/index.js` calls `syncRedditCapi()`, which pulls RedTrack `/conversions`, looks up each visitor by `rt_clickid`, skips non-Reddit traffic (no `rdt_cid`), dedups via `conversion_events`, and calls `sendRedditEvent()` which hits Reddit Ads API using the existing OAuth token cache. Admin UI extends `admin/reddit.html` with mapping config, events log, and manual sync.

**Tech Stack:** Node.js / Express, better-sqlite3, Reddit Ads API v2, RedTrack API, crypto (SHA-256). No test framework — verification via curl, admin endpoints, and the `capi_payload` debug column.

**Spec:** `docs/superpowers/specs/2026-04-20-reddit-capi-design.md`

**Verification philosophy:** This codebase has no automated test suite. Every task ends with a curl/runtime verification step. The `POST /api/reddit-ads/capi/test` endpoint (Task 4) and manual sync (Task 8) serve as our test harness for the rest of the plan.

---

## Task 1 — Database migrations

**Files:**
- Modify: `server/database.js` (append migrations near existing `ALTER TABLE` block around line 200-265)

- [ ] **Step 1: Open `server/database.js` and locate the block of additive migrations**

Find the line containing `try { db.exec(\`ALTER TABLE postback_config ADD COLUMN send_to_tiktok INTEGER DEFAULT 0\`); } catch (e) {}` (around line 238). New migrations will be appended after that block but before unrelated sections.

- [ ] **Step 2: Add the migrations**

Insert this block after the last CAPI-related `ALTER TABLE` line:

```js
// Reddit CAPI — event-name mapping table
db.exec(`
  CREATE TABLE IF NOT EXISTS reddit_capi_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    redtrack_event_name TEXT NOT NULL UNIQUE,
    reddit_event_type TEXT NOT NULL,
    reddit_custom_event_name TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// Reddit CAPI — idempotency key column on conversion_events
try { db.exec(`ALTER TABLE conversion_events ADD COLUMN redtrack_conversion_id TEXT`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_ce_rt_conv_id ON conversion_events(redtrack_conversion_id, source)`); } catch (e) {}
```

- [ ] **Step 3: Restart the server and verify the schema**

Run in the project root:

```bash
npm run dev
```

In another terminal:

```bash
sqlite3 /Users/baralezrah/coastal-debt-cms/database.sqlite ".schema reddit_capi_config"
sqlite3 /Users/baralezrah/coastal-debt-cms/database.sqlite "PRAGMA table_info(conversion_events);" | grep redtrack_conversion_id
```

Expected:
- First command prints the `CREATE TABLE reddit_capi_config` DDL
- Second command prints a row containing `redtrack_conversion_id|TEXT`

- [ ] **Step 4: Commit**

```bash
git add server/database.js
git commit -m "feat(reddit-capi): add schema for event mapping and idempotency key"
```

---

## Task 2 — `sendRedditEvent` function

**Files:**
- Modify: `server/routes/reddit-ads.js` (append new function + helpers, export it)

- [ ] **Step 1: Add `crypto` import at the top of `server/routes/reddit-ads.js`**

Locate the top of the file. After the existing `const { authenticateToken } = require('./auth');` line, add:

```js
const crypto = require('crypto');
```

- [ ] **Step 2: Add `sendRedditEvent` function above `module.exports`**

Insert this function right before `module.exports = router;` at the bottom of `server/routes/reddit-ads.js`:

```js
/**
 * Send a single conversion event to Reddit Conversions API.
 * Returns { success, error, payload }.
 *
 * @param {object} mapping - reddit_capi_config row (reddit_event_type, reddit_custom_event_name)
 * @param {object} conv - RedTrack conversion row (id, clickid, type, payout, created_at)
 * @param {object} visitor - visitors row (rdt_cid, ip_address, user_agent, eli_clickid)
 * @param {object|null} lead - leads row (email, phone) or null
 */
async function sendRedditEvent(mapping, conv, visitor, lead) {
  try {
    const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id = 1').get();
    if (!config || !config.account_id || !config.client_id || !config.client_secret || !config.refresh_token) {
      return { success: false, error: 'Reddit Ads not configured (missing account_id / OAuth credentials)' };
    }

    const hash = (val) => {
      if (!val) return null;
      return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
    };

    const normalizePhone = (phone) => {
      if (!phone) return null;
      const digits = phone.replace(/\D/g, '');
      return digits || null;
    };

    const user = {};
    if (lead?.email) user.email = hash(lead.email);
    const phoneDigits = normalizePhone(lead?.phone);
    if (phoneDigits) user.phone_number = hash(phoneDigits);
    if (visitor.eli_clickid) user.external_id = hash(visitor.eli_clickid);
    if (visitor.ip_address) user.ip_address = visitor.ip_address;
    if (visitor.user_agent) user.user_agent = visitor.user_agent;

    const eventPayload = {
      event_at: new Date(conv.created_at || Date.now()).toISOString(),
      event_type: {
        tracking_type: mapping.reddit_event_type,
        custom_event_name: mapping.reddit_event_type === 'Custom' ? (mapping.reddit_custom_event_name || null) : null
      },
      click_id: visitor.rdt_cid,
      event_metadata: {
        currency: 'USD',
        value_decimal: conv.payout != null ? parseFloat(conv.payout) : 0,
        conversion_id: String(conv.id)
      },
      user
    };

    const requestBody = {
      test_mode: !!mapping._test_mode,
      events: [eventPayload]
    };

    const url = `https://ads-api.reddit.com/api/v2.0/conversions/events/${config.account_id}`;

    const doRequest = async (token) => fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'CoastalDebtCMS/1.0'
      },
      body: JSON.stringify(requestBody)
    });

    let token = await getRedditAccessToken(config);
    let response = await doRequest(token);

    // 401 → force token refresh once and retry
    if (response.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
      token = await getRedditAccessToken(config);
      response = await doRequest(token);
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = result.message || result.error || `Reddit API ${response.status}`;
      console.error('Reddit CAPI error:', errMsg);
      return { success: false, error: errMsg, payload: requestBody };
    }

    console.log(`Reddit CAPI: sent ${mapping.reddit_event_type} for conv ${conv.id} (rdt_cid=${visitor.rdt_cid})`);
    return { success: true, payload: requestBody };
  } catch (err) {
    console.error('Reddit CAPI request failed:', err);
    return { success: false, error: err.message };
  }
}
```

- [ ] **Step 3: Export `sendRedditEvent` from the module**

At the bottom of `server/routes/reddit-ads.js`, locate the existing exports:

```js
module.exports = router;
module.exports.fetchRedditMissingCosts = fetchRedditMissingCosts;
module.exports.getRedditTotalSpend = getRedditTotalSpend;
```

Add a new export line:

```js
module.exports.sendRedditEvent = sendRedditEvent;
```

- [ ] **Step 4: Restart server and verify module loads**

Run in another terminal:

```bash
node -e "const r = require('/Users/baralezrah/coastal-debt-cms/server/routes/reddit-ads.js'); console.log(typeof r.sendRedditEvent);"
```

Expected: prints `function`

- [ ] **Step 5: Commit**

```bash
git add server/routes/reddit-ads.js
git commit -m "feat(reddit-capi): add sendRedditEvent for Reddit Conversions API"
```

---

## Task 3 — Test endpoint for `sendRedditEvent`

**Files:**
- Modify: `server/routes/reddit-ads.js` (add `POST /capi/test` route)

This is the verification harness for the rest of the plan. Use Reddit's `test_mode: true` so events don't pollute production metrics.

- [ ] **Step 1: Add the route**

In `server/routes/reddit-ads.js`, insert this route before the final `module.exports`:

```js
/**
 * POST /capi/test — Fire a synthetic test event to Reddit CAPI (test_mode = true).
 * Body: { reddit_event_type?, reddit_custom_event_name?, rdt_cid?, email?, phone?, payout? }
 */
router.post('/capi/test', authenticateToken, async (req, res) => {
  try {
    const {
      reddit_event_type = 'Lead',
      reddit_custom_event_name = null,
      rdt_cid = 'test_rdt_cid_00000',
      email = 'test@example.com',
      phone = '+15551234567',
      payout = 10
    } = req.body || {};

    const mapping = { reddit_event_type, reddit_custom_event_name, _test_mode: true };
    const conv = { id: `test_${Date.now()}`, created_at: new Date().toISOString(), payout };
    const visitor = { rdt_cid, eli_clickid: 'test_eli', ip_address: '127.0.0.1', user_agent: 'CoastalDebtCMS-Test/1.0' };
    const lead = { email, phone };

    const result = await sendRedditEvent(mapping, conv, visitor, lead);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
```

- [ ] **Step 2: Restart server and call the endpoint**

First get a JWT by logging into the admin at `http://localhost:3000/admin` in a browser, then copy the token from localStorage (devtools → Application → Local Storage → `token`).

```bash
TOKEN="<paste-jwt-here>"
curl -sS -X POST http://localhost:3000/api/reddit-ads/capi/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reddit_event_type":"Lead","rdt_cid":"test_rdt_cid_00000","payout":25}' | jq .
```

Expected: `{"success": true, "payload": {...}}`. If you see `{"success": false, "error": "..."}`, inspect the error.

Common errors to handle before proceeding:
- `"Reddit Ads not configured"` → open `admin/reddit.html`, fill OAuth credentials, save
- `"Reddit API 400"` with "missing click_id" → the `rdt_cid` default above should avoid this; check the payload

- [ ] **Step 3: Commit**

```bash
git add server/routes/reddit-ads.js
git commit -m "feat(reddit-capi): add test endpoint for Reddit Conversions API"
```

---

## Task 4 — RedTrack conversions fetcher

**Files:**
- Create: `server/services/reddit-capi-sync.js`

- [ ] **Step 1: Create `server/services/` if it doesn't exist**

```bash
mkdir -p /Users/baralezrah/coastal-debt-cms/server/services
```

- [ ] **Step 2: Create the file with the fetcher only (poller comes next task)**

Write `server/services/reddit-capi-sync.js`:

```js
const REDTRACK_API_KEY = process.env.REDTRACK_API_KEY || 'tQqIhdIIBzLQg3J9Z3zs';

/**
 * Fetch individual RedTrack conversions in a time window.
 * Returns an array of { id, clickid, type, payout, created_at }.
 */
async function fetchRedTrackConversions(fromIso, toIso) {
  const params = new URLSearchParams({
    api_key: REDTRACK_API_KEY,
    date_from: fromIso.substring(0, 10),
    date_to: toIso.substring(0, 10),
    per: '500'
  });

  const url = `https://api.redtrack.io/conversions?${params}`;
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RedTrack /conversions ${response.status}: ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : (data.items || data.rows || data.data || []);

  return rows.map(row => ({
    id: row.id || row._id || row.conversion_id || `${row.clickid}_${row.type}_${row.created_at}`,
    clickid: row.clickid || row.click_id || '',
    type: row.type || row.event || row.conversion_type || '',
    payout: row.payout != null ? parseFloat(row.payout) : (row.revenue != null ? parseFloat(row.revenue) : 0),
    created_at: row.created_at || row.time || row.date || new Date().toISOString()
  })).filter(r => r.clickid && r.type);
}

module.exports = { fetchRedTrackConversions };
```

- [ ] **Step 3: Verify the fetcher works**

Run a one-off from the repo root:

```bash
cd /Users/baralezrah/coastal-debt-cms && node -e "
  const { fetchRedTrackConversions } = require('./server/services/reddit-capi-sync');
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 7*24*3600*1000).toISOString();
  fetchRedTrackConversions(from, to).then(rows => {
    console.log('Total:', rows.length);
    console.log('Sample:', JSON.stringify(rows.slice(0, 2), null, 2));
  }).catch(e => console.error('ERR:', e.message));
"
```

Expected: prints a count and up to two sample rows. If zero rows, that's fine — verifies auth and shape; adjust date range if needed.

If the fetch errors with `403` or empty body, inspect RedTrack's docs for the current conversions endpoint — the field name mapping in Step 2 may need adjusting to match the actual response shape (the `.map()` already handles common variants).

- [ ] **Step 4: Commit**

```bash
git add server/services/reddit-capi-sync.js
git commit -m "feat(reddit-capi): add RedTrack conversions fetcher"
```

---

## Task 5 — `syncRedditCapi` poller function

**Files:**
- Modify: `server/services/reddit-capi-sync.js` (add poller)

- [ ] **Step 1: Extend `server/services/reddit-capi-sync.js`**

Append this to the existing file, before the `module.exports`:

```js
const db = require('../database');
const { sendRedditEvent } = require('../routes/reddit-ads');

/**
 * Pull last 2h of RedTrack conversions, filter to Reddit-sourced traffic,
 * dedup, and fire to Reddit CAPI. Logs to conversion_events.
 *
 * Returns { scanned, sent, failed, skipped, blocked }.
 */
async function syncRedditCapi() {
  const redditConfig = db.prepare('SELECT * FROM reddit_ads_config WHERE id=1').get();
  if (!redditConfig || !redditConfig.account_id) {
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'reddit_not_configured' };
  }

  const mappings = db.prepare('SELECT * FROM reddit_capi_config WHERE is_active=1').all();
  if (mappings.length === 0) {
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'no_active_mappings' };
  }
  const eventMap = Object.fromEntries(mappings.map(m => [m.redtrack_event_name.toLowerCase(), m]));

  const fromIso = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const toIso = new Date().toISOString();

  let conversions;
  try {
    conversions = await fetchRedTrackConversions(fromIso, toIso);
  } catch (err) {
    console.error('Reddit CAPI sync — RedTrack fetch failed:', err.message);
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'redtrack_fetch_failed', error: err.message };
  }

  const stats = { scanned: conversions.length, sent: 0, failed: 0, skipped: 0, blocked: 0 };

  for (const conv of conversions) {
    try {
      const mapping = eventMap[String(conv.type).toLowerCase()];
      if (!mapping) { stats.skipped++; continue; }

      const visitor = db.prepare('SELECT * FROM visitors WHERE rt_clickid = ?').get(conv.clickid);
      if (!visitor || !visitor.rdt_cid) { stats.skipped++; continue; }

      const existing = db.prepare(`
        SELECT id FROM conversion_events
        WHERE source='reddit_capi' AND redtrack_conversion_id = ? AND status='sent'
      `).get(String(conv.id));
      if (existing) { stats.skipped++; continue; }

      const lead = db.prepare('SELECT id, email, phone, is_blocked FROM leads WHERE eli_clickid = ?').get(visitor.eli_clickid);

      if (lead && lead.is_blocked) {
        db.prepare(`
          INSERT INTO conversion_events
            (lead_id, eli_clickid, conversion_action_name, revenue, source, status, error_message, redtrack_conversion_id)
          VALUES (?, ?, ?, ?, 'reddit_capi', 'blocked', 'Lead is blocked', ?)
        `).run(lead.id, visitor.eli_clickid, conv.type, conv.payout || null, String(conv.id));
        stats.blocked++;
        continue;
      }

      const result = await sendRedditEvent(mapping, conv, visitor, lead);

      db.prepare(`
        INSERT INTO conversion_events
          (lead_id, eli_clickid, conversion_action_name, conversion_value, revenue, source, status, error_message, sent_at, capi_payload, redtrack_conversion_id)
        VALUES (?, ?, ?, ?, ?, 'reddit_capi', ?, ?, ${result.success ? 'CURRENT_TIMESTAMP' : 'NULL'}, ?, ?)
      `).run(
        lead?.id || null,
        visitor.eli_clickid,
        conv.type,
        conv.payout || null,
        conv.payout || null,
        result.success ? 'sent' : 'failed',
        result.error || null,
        result.payload ? JSON.stringify(result.payload) : null,
        String(conv.id)
      );

      if (result.success) stats.sent++; else stats.failed++;
    } catch (err) {
      console.error('Reddit CAPI sync — error on conversion', conv.id, err);
      stats.failed++;
    }
  }

  if (stats.sent > 0 || stats.failed > 0) {
    console.log(`Reddit CAPI sync: scanned=${stats.scanned} sent=${stats.sent} failed=${stats.failed} skipped=${stats.skipped} blocked=${stats.blocked}`);
  }
  return stats;
}

module.exports.syncRedditCapi = syncRedditCapi;
```

- [ ] **Step 2: Verify the poller loads without error**

```bash
node -e "const s = require('/Users/baralezrah/coastal-debt-cms/server/services/reddit-capi-sync'); console.log(typeof s.syncRedditCapi);"
```

Expected: prints `function`

- [ ] **Step 3: Commit**

```bash
git add server/services/reddit-capi-sync.js
git commit -m "feat(reddit-capi): add syncRedditCapi poller"
```

---

## Task 6 — Manual sync endpoint + config + events routes

**Files:**
- Modify: `server/routes/reddit-ads.js` (add routes below `/capi/test`)

- [ ] **Step 1: Add route imports and handlers**

At the top of `server/routes/reddit-ads.js`, after the `const crypto = require('crypto');` line added in Task 2, add a lazy require for the sync service (avoids circular deps — the sync service requires this file):

```js
let _syncRedditCapi = null;
setTimeout(() => {
  try { _syncRedditCapi = require('../services/reddit-capi-sync').syncRedditCapi; } catch (e) {}
}, 0);
```

- [ ] **Step 2: Add mapping config CRUD routes**

Insert before `module.exports` in `server/routes/reddit-ads.js`:

```js
/**
 * GET /capi/config — list event mappings
 */
router.get('/capi/config', authenticateToken, (req, res) => {
  const rows = db.prepare('SELECT * FROM reddit_capi_config ORDER BY created_at DESC').all();
  res.json(rows);
});

/**
 * POST /capi/config — create a mapping
 * Body: { redtrack_event_name, reddit_event_type, reddit_custom_event_name? }
 */
router.post('/capi/config', authenticateToken, (req, res) => {
  const { redtrack_event_name, reddit_event_type, reddit_custom_event_name = null } = req.body || {};
  if (!redtrack_event_name || !reddit_event_type) {
    return res.status(400).json({ error: 'redtrack_event_name and reddit_event_type required' });
  }
  const allowed = ['Lead', 'Purchase', 'SignUp', 'AddToCart', 'ViewContent', 'PageVisit', 'Custom'];
  if (!allowed.includes(reddit_event_type)) {
    return res.status(400).json({ error: `reddit_event_type must be one of ${allowed.join(', ')}` });
  }
  try {
    const r = db.prepare(`
      INSERT INTO reddit_capi_config (redtrack_event_name, reddit_event_type, reddit_custom_event_name)
      VALUES (?, ?, ?)
    `).run(redtrack_event_name.toLowerCase(), reddit_event_type, reddit_custom_event_name);
    res.json({ id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /capi/config/:id — update a mapping
 */
router.put('/capi/config/:id', authenticateToken, (req, res) => {
  const { redtrack_event_name, reddit_event_type, reddit_custom_event_name, is_active } = req.body || {};
  db.prepare(`
    UPDATE reddit_capi_config SET
      redtrack_event_name = COALESCE(?, redtrack_event_name),
      reddit_event_type = COALESCE(?, reddit_event_type),
      reddit_custom_event_name = ?,
      is_active = COALESCE(?, is_active)
    WHERE id = ?
  `).run(
    redtrack_event_name ? redtrack_event_name.toLowerCase() : null,
    reddit_event_type || null,
    reddit_custom_event_name ?? null,
    is_active != null ? (is_active ? 1 : 0) : null,
    req.params.id
  );
  res.json({ success: true });
});

/**
 * DELETE /capi/config/:id
 */
router.delete('/capi/config/:id', authenticateToken, (req, res) => {
  db.prepare('DELETE FROM reddit_capi_config WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

/**
 * GET /capi/events — recent reddit_capi events
 */
router.get('/capi/events', authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = parseInt(req.query.offset) || 0;
  const rows = db.prepare(`
    SELECT ce.*, l.first_name, l.last_name, l.email
    FROM conversion_events ce
    LEFT JOIN leads l ON ce.lead_id = l.id
    WHERE ce.source = 'reddit_capi'
    ORDER BY ce.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) as c FROM conversion_events WHERE source = 'reddit_capi'").get().c;
  res.json({ events: rows, total });
});

/**
 * POST /capi/events/:id/retry — retry a failed event
 */
router.post('/capi/events/:id/retry', authenticateToken, async (req, res) => {
  const ev = db.prepare("SELECT * FROM conversion_events WHERE id = ? AND source = 'reddit_capi'").get(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (!ev.redtrack_conversion_id) return res.status(400).json({ error: 'Missing redtrack_conversion_id' });

  const mapping = db.prepare('SELECT * FROM reddit_capi_config WHERE redtrack_event_name = ?').get(String(ev.conversion_action_name).toLowerCase());
  if (!mapping) return res.status(400).json({ error: 'No mapping for event name' });

  const visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(ev.eli_clickid);
  if (!visitor || !visitor.rdt_cid) return res.status(400).json({ error: 'Visitor has no rdt_cid' });

  const lead = ev.lead_id ? db.prepare('SELECT email, phone FROM leads WHERE id = ?').get(ev.lead_id) : null;

  const conv = {
    id: ev.redtrack_conversion_id,
    clickid: visitor.rt_clickid,
    type: ev.conversion_action_name,
    payout: ev.revenue || 0,
    created_at: ev.created_at
  };

  const result = await sendRedditEvent(mapping, conv, visitor, lead);

  db.prepare(`
    UPDATE conversion_events SET
      status = ?, error_message = ?, capi_payload = ?,
      sent_at = ${result.success ? 'CURRENT_TIMESTAMP' : 'sent_at'}
    WHERE id = ?
  `).run(
    result.success ? 'sent' : 'failed',
    result.error || null,
    result.payload ? JSON.stringify(result.payload) : ev.capi_payload,
    req.params.id
  );

  res.json(result);
});

/**
 * POST /capi/sync — manual sync trigger
 */
router.post('/capi/sync', authenticateToken, async (req, res) => {
  if (!_syncRedditCapi) return res.status(503).json({ error: 'Sync service not loaded yet' });
  const stats = await _syncRedditCapi();
  res.json(stats);
});
```

- [ ] **Step 3: Restart server and smoke-test each route**

```bash
TOKEN="<paste-jwt-here>"

# Create a mapping
curl -sS -X POST http://localhost:3000/api/reddit-ads/capi/config \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"redtrack_event_name":"lead","reddit_event_type":"Lead"}' | jq .

# List mappings
curl -sS http://localhost:3000/api/reddit-ads/capi/config \
  -H "Authorization: Bearer $TOKEN" | jq .

# Trigger manual sync
curl -sS -X POST http://localhost:3000/api/reddit-ads/capi/sync \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected:
- First: `{"id": 1}`
- Second: array with one row
- Third: `{"scanned": N, "sent": 0, "failed": 0, "skipped": N, "blocked": 0}` (skipped will be high because no visitors match yet — that's fine)

- [ ] **Step 4: Commit**

```bash
git add server/routes/reddit-ads.js
git commit -m "feat(reddit-capi): add mapping config, events, retry, manual sync routes"
```

---

## Task 7 — Wire poller into `setInterval`

**Files:**
- Modify: `server/index.js` (add `setInterval` near line 359 where `fetchRedditMissingCosts` is registered)

- [ ] **Step 1: Locate the existing Reddit cost-sync interval**

Find this block in `server/index.js` (around line 356-360):

```js
setInterval(fetchRedditMissingCosts, 15 * 60 * 1000);
```

- [ ] **Step 2: Add the Reddit CAPI sync interval**

Immediately after that line, add:

```js
// Reddit CAPI sync — pull RedTrack conversions and forward to Reddit every 5 min
const { syncRedditCapi } = require('./services/reddit-capi-sync');
setTimeout(() => {
  syncRedditCapi().catch(err => console.error('Reddit CAPI sync (initial) error:', err));
  setInterval(() => {
    syncRedditCapi().catch(err => console.error('Reddit CAPI sync error:', err));
  }, 5 * 60 * 1000);
}, 30 * 1000);
```

- [ ] **Step 3: Restart and verify**

```bash
npm run dev
```

Wait ~30 seconds after boot. You should see a log line like:

```
Reddit CAPI sync: scanned=N sent=0 failed=0 skipped=N blocked=0
```

(The log only prints when sent+failed > 0, so with zero Reddit traffic you'll just see silence — that's fine. Trigger manually to verify:)

```bash
curl -sS -X POST http://localhost:3000/api/reddit-ads/capi/sync -H "Authorization: Bearer $TOKEN" | jq .
```

Expected: returns stats object.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(reddit-capi): schedule syncRedditCapi every 5 min"
```

---

## Task 8 — Admin UI: event mapping section

**Files:**
- Modify: `admin/reddit.html` (add section + JS)

- [ ] **Step 1: Inspect the existing structure**

Open `admin/reddit.html` and locate the main container of the OAuth form. Identify a good place to append new sections — typically right before the closing `</main>` or `</body>` tag, or inside the main content wrapper.

- [ ] **Step 2: Add the mapping HTML block**

Insert this HTML block inside the main content area (after the existing OAuth config section):

```html
<!-- Reddit CAPI — Event Mapping -->
<section class="card" style="margin-top:24px;">
  <h2>Reddit CAPI — Event Mapping</h2>
  <p style="color:#666;font-size:13px;">Map RedTrack event names to Reddit Conversions API event types. Only visitors with a <code>rdt_cid</code> are sent.</p>

  <table id="capiMappingsTable" style="width:100%;border-collapse:collapse;margin-bottom:16px;">
    <thead>
      <tr style="text-align:left;border-bottom:1px solid #ddd;">
        <th style="padding:8px;">RedTrack event</th>
        <th style="padding:8px;">Reddit event</th>
        <th style="padding:8px;">Custom name</th>
        <th style="padding:8px;">Active</th>
        <th style="padding:8px;"></th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>

  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <input id="newMapRtName" placeholder="redtrack event (e.g. lead)" style="padding:6px;" />
    <select id="newMapRedditType" style="padding:6px;">
      <option>Lead</option>
      <option>Purchase</option>
      <option>SignUp</option>
      <option>AddToCart</option>
      <option>ViewContent</option>
      <option>PageVisit</option>
      <option>Custom</option>
    </select>
    <input id="newMapCustomName" placeholder="custom event name (if Custom)" style="padding:6px;display:none;" />
    <button id="newMapAddBtn" class="btn-primary">Add Mapping</button>
  </div>
</section>
```

- [ ] **Step 3: Add the JS that wires it up**

Append inside the `<script>` block at the bottom of `admin/reddit.html`:

```js
async function loadCapiMappings() {
  const tbody = document.querySelector('#capiMappingsTable tbody');
  const token = localStorage.getItem('token');
  const res = await fetch('/api/reddit-ads/capi/config', { headers: { 'Authorization': 'Bearer ' + token } });
  const rows = await res.json();
  tbody.innerHTML = rows.map(r => `
    <tr style="border-bottom:1px solid #eee;">
      <td style="padding:8px;"><code>${r.redtrack_event_name}</code></td>
      <td style="padding:8px;">${r.reddit_event_type}</td>
      <td style="padding:8px;">${r.reddit_custom_event_name || '—'}</td>
      <td style="padding:8px;">
        <input type="checkbox" data-id="${r.id}" class="capiActiveToggle" ${r.is_active ? 'checked' : ''} />
      </td>
      <td style="padding:8px;">
        <button data-id="${r.id}" class="capiDelBtn" style="color:#c00;background:none;border:none;cursor:pointer;">Delete</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.capiActiveToggle').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      await fetch('/api/reddit-ads/capi/config/' + e.target.dataset.id, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: e.target.checked })
      });
    });
  });
  tbody.querySelectorAll('.capiDelBtn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      if (!confirm('Delete this mapping?')) return;
      await fetch('/api/reddit-ads/capi/config/' + e.target.dataset.id, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token }
      });
      loadCapiMappings();
    });
  });
}

document.getElementById('newMapRedditType').addEventListener('change', (e) => {
  document.getElementById('newMapCustomName').style.display = e.target.value === 'Custom' ? '' : 'none';
});

document.getElementById('newMapAddBtn').addEventListener('click', async () => {
  const token = localStorage.getItem('token');
  const rtName = document.getElementById('newMapRtName').value.trim();
  const reType = document.getElementById('newMapRedditType').value;
  const custom = document.getElementById('newMapCustomName').value.trim() || null;
  if (!rtName) { alert('RedTrack event name required'); return; }
  const res = await fetch('/api/reddit-ads/capi/config', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ redtrack_event_name: rtName, reddit_event_type: reType, reddit_custom_event_name: custom })
  });
  const data = await res.json();
  if (data.error) { alert('Error: ' + data.error); return; }
  document.getElementById('newMapRtName').value = '';
  document.getElementById('newMapCustomName').value = '';
  loadCapiMappings();
});

loadCapiMappings();
```

- [ ] **Step 4: Verify in browser**

Restart `npm run dev`, open `http://localhost:3000/admin/reddit.html`, log in if needed. The new "Reddit CAPI — Event Mapping" section should render with an empty table (or the `lead` mapping you created in Task 6). Add a new mapping (e.g. `qualified` → `Lead`) and confirm the row appears, the delete button works, and the active toggle persists across refresh.

- [ ] **Step 5: Commit**

```bash
git add admin/reddit.html
git commit -m "feat(reddit-capi): admin UI for event-mapping config"
```

---

## Task 9 — Admin UI: recent events + manual sync

**Files:**
- Modify: `admin/reddit.html` (add two more sections + JS)

- [ ] **Step 1: Add HTML blocks after the mapping section**

Insert right after the Event Mapping `<section>`:

```html
<!-- Reddit CAPI — Manual Sync -->
<section class="card" style="margin-top:24px;">
  <h2>Reddit CAPI — Sync</h2>
  <button id="syncCapiBtn" class="btn-primary">Sync now</button>
  <pre id="syncCapiResult" style="margin-top:12px;background:#f5f5f5;padding:12px;border-radius:4px;display:none;"></pre>
</section>

<!-- Reddit CAPI — Recent Events -->
<section class="card" style="margin-top:24px;">
  <h2>Reddit CAPI — Recent Events</h2>
  <table id="capiEventsTable" style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="text-align:left;border-bottom:1px solid #ddd;">
        <th style="padding:8px;">When</th>
        <th style="padding:8px;">Lead</th>
        <th style="padding:8px;">RT event</th>
        <th style="padding:8px;">Value</th>
        <th style="padding:8px;">Status</th>
        <th style="padding:8px;">Error</th>
        <th style="padding:8px;"></th>
      </tr>
    </thead>
    <tbody></tbody>
  </table>
  <button id="refreshCapiEventsBtn" style="margin-top:12px;">Refresh</button>
</section>
```

- [ ] **Step 2: Add JS for sync + events**

Append to the `<script>` block:

```js
document.getElementById('syncCapiBtn').addEventListener('click', async () => {
  const token = localStorage.getItem('token');
  const resultEl = document.getElementById('syncCapiResult');
  resultEl.style.display = 'block';
  resultEl.textContent = 'Syncing…';
  try {
    const res = await fetch('/api/reddit-ads/capi/sync', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    resultEl.textContent = JSON.stringify(data, null, 2);
    loadCapiEvents();
  } catch (err) {
    resultEl.textContent = 'Error: ' + err.message;
  }
});

async function loadCapiEvents() {
  const token = localStorage.getItem('token');
  const tbody = document.querySelector('#capiEventsTable tbody');
  const res = await fetch('/api/reddit-ads/capi/events?limit=50', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const data = await res.json();
  tbody.innerHTML = (data.events || []).map(ev => {
    const statusColor = ev.status === 'sent' ? '#0a0' : (ev.status === 'failed' ? '#c00' : '#888');
    const name = [ev.first_name, ev.last_name].filter(Boolean).join(' ') || ev.email || ev.eli_clickid || '—';
    return `
      <tr style="border-bottom:1px solid #eee;">
        <td style="padding:8px;">${ev.created_at}</td>
        <td style="padding:8px;">${name}</td>
        <td style="padding:8px;"><code>${ev.conversion_action_name || '—'}</code></td>
        <td style="padding:8px;">${ev.revenue != null ? '$' + ev.revenue : '—'}</td>
        <td style="padding:8px;color:${statusColor};font-weight:600;">${ev.status}</td>
        <td style="padding:8px;color:#c00;font-size:11px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(ev.error_message || '').replace(/"/g, '&quot;')}">${ev.error_message || ''}</td>
        <td style="padding:8px;">
          ${ev.status === 'failed' ? `<button data-id="${ev.id}" class="capiRetryBtn">Retry</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.capiRetryBtn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const r = await fetch('/api/reddit-ads/capi/events/' + id + '/retry', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await r.json();
      alert(data.success ? 'Retried — sent.' : 'Retry failed: ' + (data.error || 'unknown'));
      loadCapiEvents();
    });
  });
}

document.getElementById('refreshCapiEventsBtn').addEventListener('click', loadCapiEvents);
loadCapiEvents();
```

- [ ] **Step 3: Verify in browser**

Reload `admin/reddit.html`. Click "Sync now" — the result box should show the stats JSON. The events table should render (empty at first). Click the test endpoint from Task 3 via curl to generate a real event flowing through, then click "Refresh" and confirm rows appear.

- [ ] **Step 4: End-to-end smoke test**

With at least one `reddit_capi_config` row configured for a RedTrack event your traffic uses (e.g. `lead` → `Lead`), run the test endpoint once more with a realistic payload, then check the admin events table. Expected: a `sent` row. Check Reddit Ads Manager → Events Manager to confirm the event arrived (may take a few minutes).

- [ ] **Step 5: Commit**

```bash
git add admin/reddit.html
git commit -m "feat(reddit-capi): admin UI for manual sync and events log"
```

---

## Task 10 — Deploy

**Files:**
- None changed. Push to `main`.

- [ ] **Step 1: Confirm all commits are on `main`**

```bash
cd /Users/baralezrah/coastal-debt-cms && git status && git log --oneline -10
```

Expected: clean working tree, the last 9 commits are all from this feature.

- [ ] **Step 2: Push to Railway**

```bash
git push origin main
```

Railway will auto-deploy. The DB migrations in Task 1 are additive + idempotent, safe on the production SQLite file.

- [ ] **Step 3: Verify production**

Wait ~2 minutes for deploy, then hit:

```bash
curl -sS -X POST https://<railway-domain>/api/reddit-ads/capi/sync \
  -H "Authorization: Bearer <prod-jwt>" | jq .
```

Expected: returns stats object. Then open the production admin page → Reddit → confirm three new sections render.

---

## Self-Review Notes

**Spec coverage:** Every spec section maps to a task — schema (T1), sendRedditEvent (T2), test harness (T3), RedTrack fetcher (T4), poller (T5), routes (T6), scheduler (T7), admin UI mapping (T8), admin UI events + sync (T9), deploy (T10).

**Dedup rule** in poller matches spec: `source='reddit_capi' AND redtrack_conversion_id=? AND status='sent'`.

**Type consistency:** `sendRedditEvent(mapping, conv, visitor, lead)` signature is identical in Task 2, Task 5, and Task 6 retry handler.

**No tests in plan** — deliberate: repo has no test framework. Every task ends with a curl/runtime verification step that exercises the new code path.
