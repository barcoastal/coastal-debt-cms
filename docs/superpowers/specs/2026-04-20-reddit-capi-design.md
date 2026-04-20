# Reddit Conversions API Integration — Design

**Date**: 2026-04-20
**Status**: Approved — ready for implementation plan
**Author**: Bar Elezra

## Problem

The CMS already captures Reddit click IDs (`rdt_cid`) on every landing page and stores Reddit Ads OAuth credentials in `reddit_ads_config`. What's missing is a way to send conversion events back to Reddit so Reddit Ads can optimize against real downstream conversions (lead, qualified, sale, etc.) rather than just the pixel's client-side Lead event.

RedTrack is the source of truth for conversion events in this stack. The CMS must pull events from RedTrack's API on a schedule and forward those that came from Reddit-sourced traffic to Reddit's Conversions API.

## Goals

- Send downstream conversion events to Reddit Conversions API for Reddit-sourced traffic only
- Reuse existing infrastructure: `reddit_ads_config` OAuth, `conversion_events` log table, admin page patterns from Facebook/TikTok CAPI
- Full visibility in admin UI: event mappings, recent events, retry failed, manual sync
- Idempotent: running the sync twice must not send the same event twice

## Non-Goals

- Sending events for non-Reddit traffic (Approach A — Reddit-sourced only)
- Firing Lead on form submit (approach deferred — all events flow via RedTrack polling)
- Real-time webhooks from RedTrack (pull model only, matches existing architecture)
- Batching multiple events per Reddit API call (single-event requests are fine at current volume)

## Architecture

Three pieces:

1. **`sendRedditEvent(mapping, conv, visitor, lead)`** — new function in `server/routes/reddit-ads.js`. Reuses existing `getRedditAccessToken()` for OAuth. Hits `POST https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id}`. Exported alongside `fetchRedditMissingCosts` and `getRedditTotalSpend`.

2. **`syncRedditCapi()` poller** — new file `server/services/reddit-capi-sync.js`. Runs every 5 minutes via `setInterval` registered in `server/index.js` (same pattern as Facebook cron-sync). Pulls RedTrack `/conversions` for the last 2 hours, filters to visitors with `rdt_cid`, dedups against `conversion_events`, sends each to Reddit, logs result.

3. **Admin UI** — new section in existing `admin/reddit.html`: event mapping config, recent events log, retry failed, manual sync button.

### Data Flow

```
[RedTrack /conversions API]
         │
         ▼
[syncRedditCapi poller — every 5 min]
         │
         ▼ match visitor by rt_clickid; require visitor.rdt_cid
         │
         ▼ dedup via conversion_events (source=reddit_capi, redtrack_conversion_id)
         │
         ▼ map RedTrack event → Reddit event via reddit_capi_config
         │
         ▼
[sendRedditEvent()] → Reddit Ads Conversions API
         │
         ▼
[conversion_events row, source='reddit_capi']
```

## Data Model

### New table `reddit_capi_config`

Event name mapping plus enable/disable.

```sql
CREATE TABLE reddit_capi_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  redtrack_event_name TEXT NOT NULL UNIQUE,  -- e.g. 'lead', 'qualified', 'sale'
  reddit_event_type TEXT NOT NULL,           -- 'Lead', 'Purchase', 'SignUp', 'AddToCart', 'ViewContent', 'Custom'
  reddit_custom_event_name TEXT,             -- only used when reddit_event_type = 'Custom'
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Reuse `conversion_events` for logging

Source column already exists. New source value: `reddit_capi`. Add one column for idempotency:

```sql
ALTER TABLE conversion_events ADD COLUMN redtrack_conversion_id TEXT;
CREATE INDEX idx_ce_rt_conv_id ON conversion_events(redtrack_conversion_id, source);
```

Dedup rule before sending:

```sql
SELECT id FROM conversion_events
WHERE source='reddit_capi'
  AND redtrack_conversion_id = ?
  AND status = 'sent'
```

If a row exists, skip. Failed rows are allowed to retry naturally via the next poll cycle.

### No changes to `visitors` or `leads`

`rdt_cid` is captured on all landing pages (form, call, article, authority, join) into `visitors.rdt_cid`. `rt_clickid` is set server-side during visitor registration via the existing RedTrack API integration in `server/routes/visitors.js`.

## Polling Flow

```js
async function syncRedditCapi() {
  const config = db.prepare('SELECT * FROM reddit_ads_config WHERE id=1').get();
  if (!config?.account_id) return;

  const mappings = db.prepare(
    'SELECT * FROM reddit_capi_config WHERE is_active=1'
  ).all();
  if (!mappings.length) return;

  const eventMap = Object.fromEntries(
    mappings.map(m => [m.redtrack_event_name.toLowerCase(), m])
  );

  const from = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const to = new Date().toISOString();
  const conversions = await fetchRedTrackConversions(from, to);

  for (const conv of conversions) {
    try {
      const mapping = eventMap[conv.type?.toLowerCase()];
      if (!mapping) continue;

      const visitor = db.prepare(
        'SELECT * FROM visitors WHERE rt_clickid = ?'
      ).get(conv.clickid);
      if (!visitor?.rdt_cid) continue;

      const existing = db.prepare(`
        SELECT id FROM conversion_events
        WHERE source='reddit_capi' AND redtrack_conversion_id=? AND status='sent'
      `).get(conv.id);
      if (existing) continue;

      const lead = db.prepare(
        'SELECT id, email, phone, is_blocked FROM leads WHERE eli_clickid=?'
      ).get(visitor.eli_clickid);

      if (lead?.is_blocked) {
        logBlocked(conv, visitor, mapping);
        continue;
      }

      const result = await sendRedditEvent(mapping, conv, visitor, lead);
      logConversionEvent(conv, visitor, mapping, result);
    } catch (err) {
      console.error('Reddit CAPI sync error for conversion:', conv.id, err);
    }
  }
}
```

Constants:

- Poll interval: `5 minutes`
- Lookback window: `2 hours` (generous overlap against dedup)
- Startup delay: `30 seconds` after server boot before first run
- Per-conversion failures are isolated via try/catch around the loop body

RedTrack `/conversions` API specifics (exact fields, auth, pagination) are resolved during implementation.

## Reddit CAPI Request

**Endpoint**: `POST https://ads-api.reddit.com/api/v2.0/conversions/events/{account_id}`
**Auth**: `Bearer <token>` (reuse existing `getRedditAccessToken(config)`)

**Payload shape**:

```json
{
  "test_mode": false,
  "events": [{
    "event_at": "2026-04-20T15:30:00Z",
    "event_type": {
      "tracking_type": "Lead",
      "custom_event_name": null
    },
    "click_id": "<visitor.rdt_cid>",
    "event_metadata": {
      "currency": "USD",
      "value_decimal": 50.00,
      "conversion_id": "<redtrack conversion id>"
    },
    "user": {
      "email": "<sha256 lowercase>",
      "phone_number": "<sha256 e.164>",
      "external_id": "<sha256 eli_clickid>",
      "ip_address": "<visitor.ip_address>",
      "user_agent": "<visitor.user_agent>"
    }
  }]
}
```

**Hashing**: SHA-256 of lowercased email, E.164 phone, raw `eli_clickid`. Reuse existing helper from `facebook.js` or inline a small SHA-256 helper — same algorithm.

**`conversion_id`** = RedTrack conversion ID. Lets Reddit dedup against their own pixel if the same event fires client-side too.

**`value_decimal`** = RedTrack `payout` (fallback: 0 if null/missing).

**Return shape**: `{ success: boolean, error: string | null, payload: object }` — matches `sendFacebookEvent` / `sendTikTokEvent` for consistency.

Single event per request is fine at current volume. Reddit's published limit is ~1000 events/sec.

## Admin UI

Add three blocks to existing `admin/reddit.html` (already has OAuth config).

### 1. Event Mapping Config

Table of `redtrack_event_name` → `reddit_event_type`.

- Dropdown for Reddit event type: `Lead`, `Purchase`, `SignUp`, `AddToCart`, `ViewContent`, `Custom`
- `custom_event_name` input shown only when type = `Custom`
- Active toggle per row
- Add / edit / delete rows

### 2. Recent Events

Last 50 `conversion_events` rows where `source = 'reddit_capi'`.

Columns: date, lead name, RedTrack event, Reddit event, value, status (sent / failed / blocked / skipped), error. Retry button on failed rows.

### 3. Manual Sync

Button "Sync now" → `POST /api/reddit-ads/capi/sync` → runs `syncRedditCapi()` once immediately. Useful for testing and backfill.

### New Routes (all in `server/routes/reddit-ads.js`, authenticated)

```
GET    /api/reddit-ads/capi/config              list mappings
POST   /api/reddit-ads/capi/config              create mapping
PUT    /api/reddit-ads/capi/config/:id          update mapping
DELETE /api/reddit-ads/capi/config/:id          delete mapping
GET    /api/reddit-ads/capi/events?limit=50     recent events with pagination
POST   /api/reddit-ads/capi/events/:id/retry    retry one event
POST   /api/reddit-ads/capi/sync                manual sync trigger
POST   /api/reddit-ads/capi/test                fire a test event (test_mode=true)
```

## Error Handling

### Per-conversion failures

Caught in try/catch inside the loop, logged to `conversion_events` with `status='failed'` + error message. Poller continues to next conversion.

### Reddit API errors

- `401 Unauthorized` → clear `cachedToken`, force refresh via `getRedditAccessToken`, retry once
- `429 Rate Limit` → log, skip remainder of this run, wait for next cycle
- `5xx` → log as failed. Next poll will retry naturally (only `status='sent'` rows are skipped by dedup)

### RedTrack API errors

Log to console, skip the entire run (do not partially process). Next cycle in 5 minutes will retry.

### Missing data guards

- No `rdt_cid` on visitor → skip silently (not Reddit-sourced, per Approach A)
- No event mapping for RedTrack event type → skip silently
- No Reddit OAuth config in `reddit_ads_config` → poller exits early
- No active mappings → poller exits early

### Conversion window

Reddit CAPI accepts events up to 7 days old. Our 2h lookback window is well within this limit.

### Lead blocked check

Reuse existing `leads.is_blocked` pattern from `postback.js`. Logged with `status='blocked'`, not sent to Reddit.

### Idempotency

Two layers:

1. Local: dedup on `(source='reddit_capi', redtrack_conversion_id, status='sent')` before sending
2. Remote: Reddit dedups on `event_metadata.conversion_id` server-side

### Startup safety

30 second delay after server boot before first poll run (matches Facebook cron-sync pattern). `setInterval` spacing = 5 minutes after that.

## Testing

- **`POST /api/reddit-ads/capi/test`** — admin-only endpoint, fires a synthetic event with `test_mode: true` so it doesn't pollute production metrics
- **Manual sync button** on admin page for immediate trigger and backfill
- **`capi_payload` column** on `conversion_events` stores the full sent payload for debugging (matches Facebook / TikTok pattern)
- **Debug visibility**: admin events table exposes full payload + response error text

## Files Touched

New:

- `server/services/reddit-capi-sync.js` — poller logic
- No new admin HTML file (extend existing `admin/reddit.html`)

Modified:

- `server/routes/reddit-ads.js` — add `sendRedditEvent`, CAPI config routes, events routes, test + manual-sync routes
- `server/database.js` — add `reddit_capi_config` table + `redtrack_conversion_id` column on `conversion_events`
- `server/index.js` — wire up `setInterval` for the poller with 30s startup delay
- `admin/reddit.html` — add three UI blocks (mapping config, recent events, manual sync)

## Open Questions (resolved during implementation)

- Exact shape of RedTrack `/conversions` API response (field names: `id`, `clickid`, `type`, `payout`, `created_at` — to be verified against API docs)
- Whether RedTrack conversions API requires pagination for the 2h window (likely yes; handle `next_page` or `offset` if present)
- Whether Reddit API prefers `value_decimal` or `value` in cents (verify against current docs at implementation time)
