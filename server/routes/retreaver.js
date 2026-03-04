const express = require('express');
const router = express.Router();
const db = require('../database');

// Auth middleware (same as other routes)
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'coastal-debt-secret-key-change-in-production');
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── CONFIG ───────────────────────────────────────────────

// GET /config - Return config (mask API key)
router.get('/config', requireAuth, (req, res) => {
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config) return res.json({});
  res.json({
    api_key: config.api_key ? '••••••' + config.api_key.slice(-4) : '',
    company_id: config.company_id || '',
    campaign_filter_id: config.campaign_filter_id || '',
    campaign_filter_name: config.campaign_filter_name || '',
    last_sync_at: config.last_sync_at,
    connected_at: config.connected_at,
    has_key: !!config.api_key
  });
});

// POST /config - Save API key + company ID + campaign filter
router.post('/config', requireAuth, (req, res) => {
  let { api_key, company_id, campaign_filter_id, campaign_filter_name } = req.body;
  if (!company_id) return res.status(400).json({ error: 'Company ID is required' });

  // If API key is masked (starts with dots), keep the existing one
  const isMasked = api_key && api_key.includes('••');
  if (isMasked) {
    const existing = db.prepare('SELECT api_key FROM retreaver_config WHERE id = 1').get();
    if (existing) {
      api_key = existing.api_key;
    } else {
      return res.status(400).json({ error: 'API key is required' });
    }
  }
  if (!api_key) return res.status(400).json({ error: 'API key is required' });

  db.prepare(`INSERT INTO retreaver_config (id, api_key, company_id, campaign_filter_id, campaign_filter_name, connected_at)
    VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, company_id = excluded.company_id, campaign_filter_id = excluded.campaign_filter_id, campaign_filter_name = excluded.campaign_filter_name, connected_at = CURRENT_TIMESTAMP`)
    .run(api_key, company_id, campaign_filter_id || null, campaign_filter_name || null);

  res.json({ success: true });
});

// GET /campaigns - List Retreaver campaigns for the dropdown
router.get('/campaigns', requireAuth, async (req, res) => {
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) return res.status(400).json({ error: 'Retreaver not configured' });

  try {
    const url = `https://api.retreaver.com/campaigns.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `Retreaver API error: ${resp.status} - ${text}` });
    }
    const raw = await resp.json();
    // Retreaver returns [{campaign: {id, name, ...}}, ...] — unwrap
    let campaigns = [];
    if (Array.isArray(raw)) {
      campaigns = raw.map(item => {
        const c = item.campaign || item;
        return {
          id: c.id,
          cid: c.cid || c.client_cid || '',
          name: c.name || c.display_name || ('Campaign ' + c.id)
        };
      });
    }
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /test - Test connection by fetching 1 call
router.post('/test', requireAuth, async (req, res) => {
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) return res.status(400).json({ error: 'Retreaver not configured' });

  try {
    const url = `https://api.retreaver.com/calls.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}&per_page=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `Retreaver API error: ${resp.status} - ${text}` });
    }
    const data = await resp.json();
    res.json({ success: true, message: `Connected! Found ${Array.isArray(data) ? data.length : 0} call(s) in test.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CALL SYNC ────────────────────────────────────────────

async function syncCalls() {
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) return { synced: 0, skipped: 0, error: 'Not configured' };

  let synced = 0, skipped = 0, errors = 0, page = 1;
  const perPage = 25;

  // Resolve campaign name from filter
  const campaignFilterName = config.campaign_filter_name || '';

  // If campaign_filter_id looks numeric, resolve it to the cid hash
  let campaignCid = config.campaign_filter_id || '';
  if (campaignCid && /^\d+$/.test(campaignCid)) {
    try {
      console.log(`Retreaver sync: resolving numeric campaign ID ${campaignCid} to cid hash...`);
      const campResp = await fetch(`https://api.retreaver.com/campaigns.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}`);
      if (campResp.ok) {
        const camps = await campResp.json();
        if (Array.isArray(camps)) {
          for (const item of camps) {
            const c = item.campaign || item;
            if (c.id?.toString() === campaignCid && c.cid) {
              console.log(`Retreaver sync: resolved campaign ${campaignCid} → cid ${c.cid}`);
              campaignCid = c.cid;
              // Update DB so we don't have to resolve again
              db.prepare('UPDATE retreaver_config SET campaign_filter_id = ? WHERE id = 1').run(c.cid);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.error('Retreaver sync: failed to resolve campaign cid:', e.message);
    }
  }

  try {
    while (true) {
      let url = `https://api.retreaver.com/calls.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}&per_page=${perPage}&page=${page}`;
      if (campaignCid) {
        url += `&client_cid=${encodeURIComponent(campaignCid)}`;
      }
      const resp = await fetch(url);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`Retreaver sync: API error ${resp.status} on page ${page}: ${errText}`);
        return { synced, skipped, error: `API error ${resp.status}: ${errText}` };
      }

      const rawCalls = await resp.json();
      if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
        if (page === 1) console.log('Retreaver sync: no calls returned from API');
        break;
      }

      console.log(`Retreaver sync page ${page}: ${rawCalls.length} calls`);

      for (const rawCall of rawCalls) {
        // Retreaver wraps each call in {call: {...}} — unwrap it
        const call = rawCall.call || rawCall;
        const uuid = call.uuid;
        if (!uuid) continue;

        // Check for duplicate
        const existing = db.prepare('SELECT id FROM calls WHERE retreaver_uuid = ?').get(uuid);
        if (existing) { skipped++; continue; }

        // Extract tags object
        let tags = {};
        try {
          if (call.tags && typeof call.tags === 'object') tags = call.tags;
          else if (call.tags && typeof call.tags === 'string') tags = JSON.parse(call.tags);
        } catch (e) {}

        // RedTrack click ID — Retreaver stores as "red_track_clickid" in tags
        const rtClickid = tags.red_track_clickid || tags.rt_clickid || tags.sub_id || call.sid || '';

        // Extract keyword and ad group from visitor_url UTM params
        let keyword = '', adGroup = '', utmCampaign = '';
        if (call.visitor_url) {
          try {
            const vUrl = new URL(call.visitor_url);
            keyword = vUrl.searchParams.get('utm_term') || vUrl.searchParams.get('hsa_kw') || '';
            adGroup = vUrl.searchParams.get('hsa_grp') || vUrl.searchParams.get('sub4') || '';
            utmCampaign = vUrl.searchParams.get('utm_campaign') || '';
          } catch (e) {}
        }

        // Campaign info — API gives cid + system_campaign_id, not name
        const campaignId = call.cid || call.system_campaign_id?.toString() || '';
        const campaignName = campaignFilterName || utmCampaign || ('Campaign ' + campaignId);

        // Converted = Retreaver's equivalent of "transferred"
        const transferred = call.converted ? 1 : 0;

        // Caller number
        const callerNumber = call.caller || '';
        const formattedCaller = formatPhoneNumber(callerNumber);

        // Match to visitor/lead via rt_clickid
        let visitorId = null, eliClickid = '', leadId = null;
        if (rtClickid) {
          const visitor = db.prepare('SELECT id, eli_clickid FROM visitors WHERE rt_clickid = ?').get(rtClickid);
          if (visitor) {
            visitorId = visitor.id;
            eliClickid = visitor.eli_clickid || '';
          }
          const lead = db.prepare('SELECT id FROM leads WHERE rt_clickid = ?').get(rtClickid);
          if (lead) leadId = lead.id;
        }

        try {
          db.prepare(`INSERT INTO calls (
            retreaver_uuid, caller_number, formatted_caller_number, campaign_name, campaign_id,
            ad_group, keyword, rt_clickid, eli_clickid, visitor_id, lead_id,
            duration, status, disposition, transferred, recording_url,
            transcript_status, tags, metadata, call_start, call_end
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
            uuid, callerNumber, formattedCaller, campaignName, campaignId,
            adGroup, keyword, rtClickid, eliClickid, visitorId, leadId,
            call.total_duration || call.dialed_call_duration || 0,
            call.status || '',
            call.hung_up_by || '',
            transferred,
            call.recording_url || '',
            JSON.stringify(tags),
            JSON.stringify({ visitor_url: call.visitor_url || '', via: call.via || '', caller_state: call.caller_state || '', caller_city: call.caller_city || '' }),
            call.start_time || call.created_at || null,
            call.end_time || null
          );
          synced++;
        } catch (insertErr) {
          console.error(`Retreaver sync: insert error for ${uuid}: ${insertErr.message}`);
          errors++;
        }
      }

      // If fewer results than per_page, we're on the last page
      if (rawCalls.length < perPage) break;
      page++;
    }

    // Update last_sync_at
    db.prepare('UPDATE retreaver_config SET last_sync_at = CURRENT_TIMESTAMP WHERE id = 1').run();

    console.log(`Retreaver sync complete: ${synced} synced, ${skipped} skipped, ${errors} errors`);
    return { synced, skipped, errors };
  } catch (err) {
    console.error('Retreaver sync error:', err.message);
    return { synced, skipped, errors, error: err.message };
  }
}

function formatPhoneNumber(num) {
  if (!num) return '';
  const digits = num.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return num;
}

// POST /sync - Manual sync trigger
router.post('/sync', requireAuth, async (req, res) => {
  const result = await syncCalls();
  res.json(result);
});

// GET /debug-sync - Show raw API response structure (for debugging)
router.get('/debug-sync', requireAuth, async (req, res) => {
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) return res.status(400).json({ error: 'Not configured' });

  const results = {};

  // Show saved config (masked)
  results.config = {
    company_id: config.company_id,
    campaign_filter_id: config.campaign_filter_id || '(none)',
    campaign_filter_name: config.campaign_filter_name || '(none)',
    api_key_last4: config.api_key ? config.api_key.slice(-4) : '(empty)'
  };

  try {
    // Try WITHOUT campaign filter first
    const urlAll = `https://api.retreaver.com/calls.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}&per_page=2`;
    const respAll = await fetch(urlAll);
    if (respAll.ok) {
      const dataAll = await respAll.json();
      results.without_filter = {
        is_array: Array.isArray(dataAll),
        length: Array.isArray(dataAll) ? dataAll.length : null,
        first_item_keys: Array.isArray(dataAll) && dataAll.length > 0 ? Object.keys(dataAll[0]) : null,
        first_item: Array.isArray(dataAll) && dataAll.length > 0 ? dataAll[0] : dataAll,
      };
    } else {
      results.without_filter = { status: respAll.status, body: await respAll.text() };
    }

    // Try WITH campaign filter
    if (config.campaign_filter_id) {
      const urlFiltered = `https://api.retreaver.com/calls.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}&per_page=2&client_cid=${encodeURIComponent(config.campaign_filter_id)}`;
      const respFiltered = await fetch(urlFiltered);
      if (respFiltered.ok) {
        const dataFiltered = await respFiltered.json();
        results.with_filter = {
          filter_param: `client_cid=${config.campaign_filter_id}`,
          is_array: Array.isArray(dataFiltered),
          length: Array.isArray(dataFiltered) ? dataFiltered.length : null,
          first_item_keys: Array.isArray(dataFiltered) && dataFiltered.length > 0 ? Object.keys(dataFiltered[0]) : null,
          first_item: Array.isArray(dataFiltered) && dataFiltered.length > 0 ? dataFiltered[0] : dataFiltered,
        };
      } else {
        results.with_filter = { status: respFiltered.status, body: await respFiltered.text() };
      }
    }

    res.json(results);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── CALL DATA ────────────────────────────────────────────

// GET /calls - Paginated list with filters
router.get('/calls', requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  const offset = (page - 1) * limit;

  let where = ['1=1'];
  let params = [];

  if (req.query.campaign) {
    where.push('campaign_name LIKE ?');
    params.push(`%${req.query.campaign}%`);
  }
  if (req.query.keyword) {
    where.push('keyword LIKE ?');
    params.push(`%${req.query.keyword}%`);
  }
  if (req.query.score_min) {
    where.push('call_score >= ?');
    params.push(parseInt(req.query.score_min));
  }
  if (req.query.score_max) {
    where.push('call_score <= ?');
    params.push(parseInt(req.query.score_max));
  }
  if (req.query.transferred !== undefined && req.query.transferred !== '') {
    where.push('transferred = ?');
    params.push(parseInt(req.query.transferred));
  }
  if (req.query.date_from) {
    where.push('call_start >= ?');
    params.push(req.query.date_from);
  }
  if (req.query.date_to) {
    where.push('call_start <= ?');
    params.push(req.query.date_to + ' 23:59:59');
  }
  if (req.query.transcript_status) {
    where.push('transcript_status = ?');
    params.push(req.query.transcript_status);
  }

  const whereClause = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) as count FROM calls WHERE ${whereClause}`).get(...params).count;
  const calls = db.prepare(`SELECT * FROM calls WHERE ${whereClause} ORDER BY call_start DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({
    calls,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// GET /calls/:id - Single call detail with linked visitor/lead
router.get('/calls/:id', requireAuth, (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });

  let visitor = null, lead = null;
  if (call.visitor_id) visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(call.visitor_id);
  if (call.lead_id) lead = db.prepare('SELECT id, first_name, last_name, email, phone, company_name, debt_amount, stage, created_at FROM leads WHERE id = ?').get(call.lead_id);

  res.json({ call, visitor, lead });
});

// GET /calls/:id/recording - Proxy audio stream from Retreaver
router.get('/calls/:id/recording', requireAuth, async (req, res) => {
  const call = db.prepare('SELECT recording_url FROM calls WHERE id = ?').get(req.params.id);
  if (!call || !call.recording_url) return res.status(404).json({ error: 'No recording available' });

  try {
    const resp = await fetch(call.recording_url);
    if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch recording' });

    const contentType = resp.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    if (resp.headers.get('content-length')) {
      res.setHeader('Content-Length', resp.headers.get('content-length'));
    }
    res.setHeader('Accept-Ranges', 'bytes');

    // Pipe the response body
    const reader = resp.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(value);
      }
    };
    await pump();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TRANSCRIBE + SCORE ────────────────────────────────────

// POST /calls/:id/transcribe - Single call transcription + scoring
router.post('/calls/:id/transcribe', requireAuth, async (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.recording_url) return res.status(400).json({ error: 'No recording URL available' });

  try {
    // Update status to processing
    db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('processing', call.id);

    // Download the audio file
    const audioResp = await fetch(call.recording_url);
    if (!audioResp.ok) throw new Error(`Failed to download recording: ${audioResp.status}`);

    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    const base64Audio = audioBuffer.toString('base64');

    // Determine media type from URL or default to mp3
    let mediaType = 'audio/mpeg';
    if (call.recording_url.includes('.wav')) mediaType = 'audio/wav';
    else if (call.recording_url.includes('.mp4') || call.recording_url.includes('.m4a')) mediaType = 'audio/mp4';

    // Call Claude API for transcription + scoring
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic();

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'audio',
            source: { type: 'base64', media_type: mediaType, data: base64Audio }
          },
          {
            type: 'text',
            text: `You are analyzing a phone call for Coastal Debt Resolve, an MCA debt settlement company.

Listen to this call and return a JSON object with:
1. transcript — full conversation with speaker labels (Agent: / Caller:)
2. score — qualification score 1-10
3. score_reason — brief explanation of the score
4. transferred — boolean, was the call transferred to a specialist?
5. summary — one-sentence summary

SCORING:
- 10: Call was transferred to a specialist/closer
- 8-9: Qualified — has MCA/business debt, interested in settlement services
- 5-7: Partial — some interest, gathering info, uncertain
- 3-4: Low — not the right fit, not interested, unqualified
- 1-2: Spam, wrong number, hangup, or <30 seconds

Return ONLY valid JSON, no markdown fences.`
          }
        ]
      }]
    });

    const responseText = message.content[0].text.trim();
    let result;
    try {
      // Strip markdown fences if present
      const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new Error('Failed to parse Claude response as JSON: ' + responseText.slice(0, 200));
    }

    // Save to database
    db.prepare(`UPDATE calls SET
      transcript = ?,
      call_score = ?,
      score_reason = ?,
      transferred = ?,
      transcript_status = 'completed'
      WHERE id = ?`).run(
      result.transcript || '',
      result.score || 0,
      result.score_reason || result.summary || '',
      result.transferred ? 1 : 0,
      call.id
    );

    res.json({
      success: true,
      transcript: result.transcript,
      score: result.score,
      score_reason: result.score_reason,
      transferred: result.transferred,
      summary: result.summary
    });
  } catch (err) {
    console.error('Transcription error:', err.message);
    db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('failed', call.id);
    res.status(500).json({ error: err.message });
  }
});

// POST /calls/transcribe-batch - Process up to 10 pending calls
router.post('/calls/transcribe-batch', requireAuth, async (req, res) => {
  const pending = db.prepare(`SELECT id FROM calls WHERE transcript_status = 'pending' AND recording_url != '' AND recording_url IS NOT NULL ORDER BY call_start DESC LIMIT 10`).all();

  if (pending.length === 0) return res.json({ processed: 0, message: 'No pending calls to transcribe' });

  let processed = 0, failed = 0;
  for (const row of pending) {
    try {
      // Make internal request to single transcribe endpoint
      const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(row.id);
      if (!call || !call.recording_url) continue;

      db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('processing', call.id);

      const audioResp = await fetch(call.recording_url);
      if (!audioResp.ok) { db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('failed', call.id); failed++; continue; }

      const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
      const base64Audio = audioBuffer.toString('base64');

      let mediaType = 'audio/mpeg';
      if (call.recording_url.includes('.wav')) mediaType = 'audio/wav';
      else if (call.recording_url.includes('.mp4') || call.recording_url.includes('.m4a')) mediaType = 'audio/mp4';

      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic();

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'audio', source: { type: 'base64', media_type: mediaType, data: base64Audio } },
            { type: 'text', text: `You are analyzing a phone call for Coastal Debt Resolve, an MCA debt settlement company.

Listen to this call and return a JSON object with:
1. transcript — full conversation with speaker labels (Agent: / Caller:)
2. score — qualification score 1-10
3. score_reason — brief explanation of the score
4. transferred — boolean, was the call transferred to a specialist?
5. summary — one-sentence summary

SCORING:
- 10: Call was transferred to a specialist/closer
- 8-9: Qualified — has MCA/business debt, interested in settlement services
- 5-7: Partial — some interest, gathering info, uncertain
- 3-4: Low — not the right fit, not interested, unqualified
- 1-2: Spam, wrong number, hangup, or <30 seconds

Return ONLY valid JSON, no markdown fences.` }
          ]
        }]
      });

      const cleaned = message.content[0].text.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
      const result = JSON.parse(cleaned);

      db.prepare(`UPDATE calls SET transcript = ?, call_score = ?, score_reason = ?, transferred = ?, transcript_status = 'completed' WHERE id = ?`)
        .run(result.transcript || '', result.score || 0, result.score_reason || '', result.transferred ? 1 : 0, call.id);
      processed++;
    } catch (err) {
      console.error(`Batch transcribe error for call ${row.id}:`, err.message);
      db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('failed', row.id);
      failed++;
    }
  }

  res.json({ processed, failed, total: pending.length });
});

// ─── STATS ────────────────────────────────────────────────

router.get('/stats', requireAuth, (req, res) => {
  const totalCalls = db.prepare('SELECT COUNT(*) as count FROM calls').get().count;
  const avgScore = db.prepare('SELECT AVG(call_score) as avg FROM calls WHERE call_score IS NOT NULL').get().avg || 0;
  const transferCount = db.prepare('SELECT COUNT(*) as count FROM calls WHERE transferred = 1').get().count;
  const transferRate = totalCalls > 0 ? (transferCount / totalCalls * 100).toFixed(1) : 0;

  const topKeywords = db.prepare(`SELECT keyword, COUNT(*) as count FROM calls WHERE keyword != '' AND keyword IS NOT NULL GROUP BY keyword ORDER BY count DESC LIMIT 5`).all();
  const topCampaigns = db.prepare(`SELECT campaign_name, COUNT(*) as count FROM calls WHERE campaign_name != '' AND campaign_name IS NOT NULL GROUP BY campaign_name ORDER BY count DESC LIMIT 5`).all();
  const pendingTranscripts = db.prepare(`SELECT COUNT(*) as count FROM calls WHERE transcript_status = 'pending' AND recording_url != '' AND recording_url IS NOT NULL`).get().count;

  res.json({
    total_calls: totalCalls,
    avg_score: Math.round(avgScore * 10) / 10,
    transfer_rate: parseFloat(transferRate),
    transfer_count: transferCount,
    top_keywords: topKeywords,
    top_campaigns: topCampaigns,
    pending_transcripts: pendingTranscripts
  });
});

// ─── BACKGROUND SYNC ──────────────────────────────────────

let retreaverSyncInterval = null;
function startRetreaverBackgroundSync() {
  if (retreaverSyncInterval) return;
  retreaverSyncInterval = setInterval(async () => {
    try {
      const config = db.prepare('SELECT api_key FROM retreaver_config WHERE id = 1').get();
      if (config && config.api_key) {
        await syncCalls();
      }
    } catch (err) {
      console.error('Retreaver background sync error:', err.message);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  // First sync 20s after startup (staggered from other syncs)
  setTimeout(async () => {
    try {
      const config = db.prepare('SELECT api_key FROM retreaver_config WHERE id = 1').get();
      if (config && config.api_key) {
        console.log('Running initial Retreaver call sync...');
        const result = await syncCalls();
        if (result.synced > 0) {
          console.log(`Retreaver initial sync: imported ${result.synced} calls`);
        }
      }
    } catch (err) {
      console.error('Retreaver initial sync error:', err.message);
    }
  }, 20 * 1000);
}

// Start background sync
startRetreaverBackgroundSync();

module.exports = router;
