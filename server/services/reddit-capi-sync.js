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

const db = require('../database');
const { sendRedditEvent } = require('../routes/reddit-ads');

/**
 * Pull last 2h of RedTrack conversions, filter to Reddit-sourced traffic,
 * dedup, and fire to Reddit CAPI. Logs to conversion_events.
 *
 * Returns { scanned, sent, failed, skipped, blocked }.
 */
async function syncRedditCapi(hoursLookback = 2) {
  const redditConfig = db.prepare('SELECT * FROM reddit_ads_config WHERE id=1').get();
  if (!redditConfig || !redditConfig.pixel_id || !redditConfig.capi_access_token) {
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'reddit_capi_not_configured' };
  }

  const mappings = db.prepare('SELECT * FROM reddit_capi_config WHERE is_active=1').all();
  if (mappings.length === 0) {
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'no_active_mappings' };
  }
  const eventMap = Object.fromEntries(mappings.map(m => [m.redtrack_event_name.toLowerCase(), m]));

  const hours = Math.min(Math.max(parseFloat(hoursLookback) || 2, 1), 168);
  const fromIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const toIso = new Date().toISOString();

  let conversions;
  try {
    conversions = await fetchRedTrackConversions(fromIso, toIso);
  } catch (err) {
    console.error('Reddit CAPI sync — RedTrack fetch failed:', err.message);
    return { scanned: 0, sent: 0, failed: 0, skipped: 0, blocked: 0, reason: 'redtrack_fetch_failed', error: err.message };
  }

  const stats = {
    scanned: conversions.length, sent: 0, failed: 0, skipped: 0, blocked: 0, window_hours: hours,
    skip_reasons: { no_mapping: 0, no_visitor_match: 0, no_rdt_cid: 0, already_sent: 0 }
  };

  for (const conv of conversions) {
    try {
      const mapping = eventMap[String(conv.type).toLowerCase()];
      if (!mapping) { stats.skipped++; stats.skip_reasons.no_mapping++; continue; }

      // Find visitor: try visitors.rt_clickid first, then fall back to leads.rt_clickid → visitor via eli_clickid
      let visitor = db.prepare('SELECT * FROM visitors WHERE rt_clickid = ?').get(conv.clickid);
      let leadByRt = null;
      if (!visitor) {
        leadByRt = db.prepare('SELECT * FROM leads WHERE rt_clickid = ?').get(conv.clickid);
        if (leadByRt && leadByRt.eli_clickid) {
          visitor = db.prepare('SELECT * FROM visitors WHERE eli_clickid = ?').get(leadByRt.eli_clickid);
        }
      }
      if (!visitor) { stats.skipped++; stats.skip_reasons.no_visitor_match++; continue; }

      // Load full lead (we need rdt_cid fallback + PII for hashing)
      const lead = db.prepare('SELECT * FROM leads WHERE eli_clickid = ?').get(visitor.eli_clickid) || leadByRt;

      // rdt_cid can live on visitor (from /api/visitors/track) OR lead (from form submission)
      if (!visitor.rdt_cid && lead?.rdt_cid) {
        visitor = { ...visitor, rdt_cid: lead.rdt_cid };
      }
      if (!visitor.rdt_cid) { stats.skipped++; stats.skip_reasons.no_rdt_cid++; continue; }

      const existing = db.prepare(`
        SELECT id FROM conversion_events
        WHERE source='reddit_capi' AND redtrack_conversion_id = ? AND status='sent'
      `).get(String(conv.id));
      if (existing) { stats.skipped++; stats.skip_reasons.already_sent++; continue; }

      if (lead && lead.is_blocked) {
        db.prepare(`
          INSERT INTO conversion_events
            (lead_id, eli_clickid, conversion_action_name, revenue, source, status, error_message, redtrack_conversion_id)
          VALUES (?, ?, ?, ?, 'reddit_capi', 'blocked', 'Lead is blocked', ?)
        `).run(lead.id, visitor.eli_clickid, conv.type, conv.payout != null ? conv.payout : null, String(conv.id));
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
        conv.payout != null ? conv.payout : null,
        conv.payout != null ? conv.payout : null,
        result.success ? 'sent' : 'failed',
        result.error || null,
        result.payload ? JSON.stringify(result.payload) : null,
        String(conv.id)
      );

      if (result.success) stats.sent++; else stats.failed++;
    } catch (err) {
      console.error('Reddit CAPI sync — error on conversion', conv.id, err);
      stats.failed++;
      // Best-effort log to conversion_events so operator can see what failed
      try {
        db.prepare(`
          INSERT INTO conversion_events
            (eli_clickid, conversion_action_name, revenue, source, status, error_message, redtrack_conversion_id)
          VALUES (?, ?, ?, 'reddit_capi', 'failed', ?, ?)
        `).run(
          null,
          conv.type,
          conv.payout != null ? conv.payout : null,
          err.message,
          String(conv.id)
        );
      } catch (_) { /* best effort */ }
    }
  }

  if (stats.sent > 0 || stats.failed > 0) {
    console.log(`Reddit CAPI sync: scanned=${stats.scanned} sent=${stats.sent} failed=${stats.failed} skipped=${stats.skipped} blocked=${stats.blocked}`);
  }
  return stats;
}

module.exports = { fetchRedTrackConversions, syncRedditCapi };
