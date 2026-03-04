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
  const newCallIds = []; // Track newly inserted calls for auto-transcription
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
        const call = rawCall.call || rawCall;
        if (!call.uuid) continue;

        // Check duplicate before processing
        const existing = db.prepare('SELECT id FROM calls WHERE retreaver_uuid = ?').get(call.uuid);
        if (existing) { skipped++; continue; }

        try {
          const inserted = processCallData(call, campaignFilterName);
          if (inserted && inserted.hasRecording) newCallIds.push(inserted.id);
          synced++;
        } catch (insertErr) {
          console.error(`Retreaver sync: insert error for ${call.uuid}: ${insertErr.message}`);
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

    // Auto-transcribe new calls in background (if OpenAI key is set)
    if (newCallIds.length > 0 && process.env.OPENAI_API_KEY) {
      console.log(`Auto-transcribing ${newCallIds.length} new calls...`);
      (async () => {
        for (const id of newCallIds) {
          try { await transcribeCallBackground(id); } catch (e) {
            console.error(`Auto-transcribe error for call ${id}:`, e.message);
          }
        }
        console.log(`Auto-transcription batch complete: ${newCallIds.length} calls`);
      })();
    }

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

// ─── REDTRACK EVENTS ─────────────────────────────────────

const REDTRACK_API_KEY = process.env.REDTRACK_API_KEY || 'tQqIhdIIBzLQg3J9Z3zs';

// GET /calls/:id/events - Fetch RedTrack conversion events for a call's clickid
router.get('/calls/:id/events', requireAuth, async (req, res) => {
  const call = db.prepare('SELECT rt_clickid, call_start FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.rt_clickid) return res.json({ events: [], message: 'No RedTrack click ID for this call' });

  try {
    // Need date range for RedTrack API — use call date ± 7 days
    const callDate = call.call_start ? new Date(call.call_start) : new Date();
    const dateFrom = new Date(callDate);
    dateFrom.setDate(dateFrom.getDate() - 7);
    const dateTo = new Date(callDate);
    dateTo.setDate(dateTo.getDate() + 30);

    const url = `https://api.redtrack.io/conversions?api_key=${REDTRACK_API_KEY}&clickid=${encodeURIComponent(call.rt_clickid)}&date_from=${dateFrom.toISOString().split('T')[0]}&date_to=${dateTo.toISOString().split('T')[0]}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `RedTrack API error: ${resp.status} - ${text}` });
    }

    const data = await resp.json();
    const items = data.items || data || [];

    // Map to clean event objects
    const events = (Array.isArray(items) ? items : []).map(item => ({
      id: item.id,
      type: item.type,
      campaign: item.campaign,
      offer: item.offer,
      source: item.source,
      keyword: item.rt_keyword || item.sub2 || '',
      ad_group_id: item.rt_adgroup_id || item.sub4 || '',
      campaign_id: item.rt_campaign_id || item.sub6 || '',
      ad_id: item.rt_ad_id || item.sub5 || '',
      utm_campaign: item.rt_campaign || item.sub1 || '',
      payout: item.payout || 0,
      revenue: item.payout || 0,
      cost: item.cost || 0,
      city: item.city,
      region: item.region,
      country: item.country,
      device: item.device,
      os: item.os,
      browser: item.browser,
      track_time: item.track_time,
      conv_time: item.conv_time,
      page_url: item.page_url || item.page || '',
      ref_id: item.ref_id || '',
      clickid: item.clickid
    }));

    // Cache event summaries in DB
    const eventSummaries = events.map(e => ({ type: e.type, payout: e.payout, conv_time: e.conv_time }));
    db.prepare('UPDATE calls SET rt_events = ? WHERE id = ?').run(JSON.stringify(eventSummaries), req.params.id);

    res.json({ events, total: data.total || events.length });
  } catch (err) {
    console.error('RedTrack events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TRANSCRIBE + SCORE ────────────────────────────────────

// Background transcription worker — Step 1: OpenAI Whisper, Step 2: Claude scoring
async function transcribeCallBackground(callId) {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
  if (!call || !call.recording_url) return;

  try {
    db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('processing', call.id);

    // --- Step 1: Download audio ---
    console.log(`Transcribing call ${call.id}: downloading from ${call.recording_url.slice(0, 80)}...`);
    const audioResp = await fetch(call.recording_url);
    if (!audioResp.ok) throw new Error(`Failed to download recording: ${audioResp.status}`);

    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`Transcribing call ${call.id}: audio size ${sizeMB}MB, duration ${call.duration}s`);

    if (audioBuffer.length > 25 * 1024 * 1024) {
      throw new Error(`Recording too large (${sizeMB}MB). Maximum is 25MB.`);
    }

    // --- Step 2: Transcribe with OpenAI Whisper ---
    const openaiKey = (process.env.OPENAI_API_KEY || '').replace(/\s+/g, '');
    if (!openaiKey) throw new Error('OPENAI_API_KEY not configured on server');

    // Determine file extension for the form upload
    let ext = 'mp3';
    if (call.recording_url.includes('.wav')) ext = 'wav';
    else if (call.recording_url.includes('.mp4')) ext = 'mp4';
    else if (call.recording_url.includes('.m4a')) ext = 'm4a';

    // Build multipart form data manually
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const formParts = [];

    // File part
    formParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="call.${ext}"\r\n` +
      `Content-Type: audio/${ext === 'mp3' ? 'mpeg' : ext}\r\n\r\n`
    );
    formParts.push(audioBuffer);
    formParts.push('\r\n');

    // Model part
    formParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );

    // Language hint
    formParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `en\r\n`
    );

    // Response format
    formParts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `text\r\n`
    );

    formParts.push(`--${boundary}--\r\n`);

    // Combine parts into a single buffer
    const bodyParts = formParts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
    const formBody = Buffer.concat(bodyParts);

    console.log(`Transcribing call ${call.id}: sending to OpenAI Whisper...`);
    const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: formBody
    });

    if (!whisperResp.ok) {
      const errText = await whisperResp.text();
      throw new Error(`Whisper API error ${whisperResp.status}: ${errText.slice(0, 300)}`);
    }

    const transcript = await whisperResp.text();
    console.log(`Transcribing call ${call.id}: Whisper returned ${transcript.length} chars`);

    if (!transcript || transcript.trim().length < 5) {
      // Very short or empty — likely silence/hangup
      db.prepare(`UPDATE calls SET
        transcript = ?,
        call_score = 1,
        score_reason = 'No speech detected — likely hangup or silence',
        transferred = 0,
        transcript_status = 'completed'
        WHERE id = ?`).run(transcript || '(no speech)', call.id);
      console.log(`Transcription complete for call ${call.id}: no speech detected, score=1`);
      return;
    }

    // --- Step 3: Score with Claude ---
    const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '');
    if (!anthropicKey) {
      // Save transcript without scoring
      db.prepare(`UPDATE calls SET transcript = ?, transcript_status = 'completed' WHERE id = ?`).run(transcript, call.id);
      console.log(`Transcription complete for call ${call.id}: saved transcript (no scoring — ANTHROPIC_API_KEY missing)`);
      return;
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: anthropicKey });

    console.log(`Transcribing call ${call.id}: scoring with Claude...`);
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are analyzing a phone call transcript for Coastal Debt Resolve, an MCA debt settlement company.

Here is the transcript:
---
${transcript}
---

Return a JSON object with:
1. score — qualification score 1-10
2. score_reason — brief explanation of the score (1 sentence)
3. transferred — boolean, was the call transferred to a specialist?
4. summary — one-sentence summary of the call

SCORING:
- 10: Call was transferred to a specialist/closer
- 8-9: Qualified — has MCA/business debt, interested in settlement services
- 5-7: Partial — some interest, gathering info, uncertain
- 3-4: Low — not the right fit, not interested, unqualified
- 1-2: Spam, wrong number, hangup, or <30 seconds of conversation

Return ONLY valid JSON, no markdown fences.`
      }]
    });

    const responseText = message.content[0].text.trim();
    const cleaned = responseText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const result = JSON.parse(cleaned);

    db.prepare(`UPDATE calls SET
      transcript = ?,
      call_score = ?,
      score_reason = ?,
      transferred = ?,
      transcript_status = 'completed'
      WHERE id = ?`).run(
      transcript,
      result.score || 0,
      result.score_reason || result.summary || '',
      result.transferred ? 1 : 0,
      call.id
    );

    console.log(`Transcription complete for call ${call.id}: score=${result.score}`);
  } catch (err) {
    const safeMsg = (err.message || 'Unknown error')
      .replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-ant-***')
      .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***')
      .slice(0, 500);
    console.error(`Transcription error for call ${callId}:`, safeMsg);
    db.prepare('UPDATE calls SET transcript_status = ?, score_reason = ? WHERE id = ?').run('failed', 'Error: ' + safeMsg, callId);
  }
}

// POST /calls/:id/transcribe - Kick off async transcription
router.post('/calls/:id/transcribe', requireAuth, async (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  if (!call.recording_url) return res.status(400).json({ error: 'No recording URL available' });
  if (call.transcript_status === 'processing') {
    // Check if it's been stuck processing for more than 5 minutes — reset it
    return res.json({ success: true, message: 'Already processing' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'OPENAI_API_KEY not configured on server. Add it in Railway environment variables.' });
  }

  // Mark as processing and respond immediately
  db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('processing', call.id);

  // Process in background (don't await)
  transcribeCallBackground(call.id);

  res.json({ success: true, message: 'Transcription started — check back in a minute' });
});

// GET /calls/:id/transcript-status - Poll for transcription status
router.get('/calls/:id/transcript-status', requireAuth, (req, res) => {
  const call = db.prepare('SELECT transcript_status, transcript, call_score, score_reason, transferred FROM calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

// POST /calls/transcribe-batch - Kick off async batch transcription
router.post('/calls/transcribe-batch', requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'OPENAI_API_KEY not configured on server. Add it in Railway environment variables.' });
  }

  const pending = db.prepare(`SELECT id FROM calls WHERE transcript_status = 'pending' AND recording_url != '' AND recording_url IS NOT NULL ORDER BY call_start DESC LIMIT 10`).all();

  if (pending.length === 0) return res.json({ queued: 0, message: 'No pending calls to transcribe' });

  // Mark all as processing
  for (const row of pending) {
    db.prepare('UPDATE calls SET transcript_status = ? WHERE id = ?').run('processing', row.id);
  }

  // Process sequentially in background (don't await)
  (async () => {
    for (const row of pending) {
      await transcribeCallBackground(row.id);
    }
    console.log(`Batch transcription complete: ${pending.length} calls processed`);
  })();

  res.json({ queued: pending.length, message: `${pending.length} calls queued for transcription` });
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

// ─── WEBHOOK (REAL-TIME) ─────────────────────────────────

// Helper: process a single call object from the API and insert into DB
function processCallData(call, campaignFilterName) {
  const uuid = call.uuid;
  if (!uuid) return null;

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM calls WHERE retreaver_uuid = ?').get(uuid);
  if (existing) return null;

  // Extract tags object
  let tags = {};
  try {
    if (call.tags && typeof call.tags === 'object') tags = call.tags;
    else if (call.tags && typeof call.tags === 'string') tags = JSON.parse(call.tags);
  } catch (e) {}

  // RedTrack click ID
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

  const campaignId = call.cid || call.system_campaign_id?.toString() || '';
  const campaignName = campaignFilterName || utmCampaign || ('Campaign ' + campaignId);
  const transferred = call.converted ? 1 : 0;
  const callerNumber = call.caller || '';
  const formattedCaller = formatPhoneNumber(callerNumber);

  // Match to visitor/lead via rt_clickid
  let visitorId = null, eliClickid = '', leadId = null;
  if (rtClickid) {
    const visitor = db.prepare('SELECT id, eli_clickid FROM visitors WHERE rt_clickid = ?').get(rtClickid);
    if (visitor) { visitorId = visitor.id; eliClickid = visitor.eli_clickid || ''; }
    const lead = db.prepare('SELECT id FROM leads WHERE rt_clickid = ?').get(rtClickid);
    if (lead) leadId = lead.id;
  }

  const result = db.prepare(`INSERT INTO calls (
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

  return { uuid, id: result.lastInsertRowid, hasRecording: !!call.recording_url };
}

// Generate or get webhook key
function getWebhookKey() {
  let row = db.prepare("SELECT value FROM settings WHERE key = 'retreaver_webhook_key'").get();
  if (!row) {
    const crypto = require('crypto');
    const key = crypto.randomBytes(24).toString('hex');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('retreaver_webhook_key', ?)").run(key);
    return key;
  }
  return row.value;
}

// GET /webhook-url - Show the webhook URL to configure in Retreaver
router.get('/webhook-url', requireAuth, (req, res) => {
  const key = getWebhookKey();
  const base = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const webhookUrl = `${base}/api/retreaver/webhook?key=${key}&call_uuid=[call_uuid]`;
  res.json({ webhook_url: webhookUrl, key });
});

// POST /webhook - Real-time call ingestion from Retreaver (no auth — secured by key)
router.post('/webhook', async (req, res) => {
  const key = req.query.key;
  const storedKey = db.prepare("SELECT value FROM settings WHERE key = 'retreaver_webhook_key'").get();
  if (!key || !storedKey || key !== storedKey.value) {
    return res.status(401).json({ error: 'Invalid webhook key' });
  }

  const callUuid = req.query.call_uuid || req.body.call_uuid || req.body.uuid;
  if (!callUuid) {
    return res.status(400).json({ error: 'Missing call_uuid' });
  }

  // Check duplicate before making API call
  const existing = db.prepare('SELECT id FROM calls WHERE retreaver_uuid = ?').get(callUuid);
  if (existing) {
    return res.json({ status: 'duplicate', message: 'Call already exists' });
  }

  // Fetch full call details from Retreaver API
  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) {
    return res.status(500).json({ error: 'Retreaver not configured' });
  }

  try {
    const url = `https://api.retreaver.com/calls/${callUuid}.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Retreaver webhook: failed to fetch call ${callUuid}: ${resp.status}`);
      return res.status(502).json({ error: `Failed to fetch call details: ${resp.status}` });
    }

    const data = await resp.json();
    const call = data.call || data;

    const campaignFilterName = config.campaign_filter_name || '';
    const inserted = processCallData(call, campaignFilterName);

    if (inserted) {
      console.log(`Retreaver webhook: ingested call ${callUuid}`);
      // Auto-transcribe in background
      if (inserted.hasRecording && process.env.OPENAI_API_KEY) {
        transcribeCallBackground(inserted.id);
      }
      res.json({ status: 'ok', message: 'Call ingested', uuid: callUuid });
    } else {
      res.json({ status: 'duplicate', message: 'Call already exists' });
    }
  } catch (err) {
    console.error(`Retreaver webhook error for ${callUuid}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Also support GET for webhook (some systems use GET)
router.get('/webhook', async (req, res) => {
  const key = req.query.key;
  const storedKey = db.prepare("SELECT value FROM settings WHERE key = 'retreaver_webhook_key'").get();
  if (!key || !storedKey || key !== storedKey.value) {
    return res.status(401).json({ error: 'Invalid webhook key' });
  }

  const callUuid = req.query.call_uuid;
  if (!callUuid || callUuid === '[call_uuid]') {
    return res.json({ status: 'ok', message: 'Webhook endpoint active' });
  }

  const existing = db.prepare('SELECT id FROM calls WHERE retreaver_uuid = ?').get(callUuid);
  if (existing) {
    return res.json({ status: 'duplicate', message: 'Call already exists' });
  }

  const config = db.prepare('SELECT * FROM retreaver_config WHERE id = 1').get();
  if (!config || !config.api_key) {
    return res.status(500).json({ error: 'Retreaver not configured' });
  }

  try {
    const url = `https://api.retreaver.com/calls/${callUuid}.json?api_key=${encodeURIComponent(config.api_key)}&company_id=${encodeURIComponent(config.company_id)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(502).json({ error: `Failed to fetch call: ${resp.status}` });
    }

    const data = await resp.json();
    const call = data.call || data;
    const campaignFilterName = config.campaign_filter_name || '';
    const inserted = processCallData(call, campaignFilterName);

    if (inserted) {
      console.log(`Retreaver webhook (GET): ingested call ${callUuid}`);
      // Auto-transcribe in background
      if (inserted.hasRecording && process.env.OPENAI_API_KEY) {
        transcribeCallBackground(inserted.id);
      }
      res.json({ status: 'ok', message: 'Call ingested', uuid: callUuid });
    } else {
      res.json({ status: 'duplicate', message: 'Call already exists' });
    }
  } catch (err) {
    console.error(`Retreaver webhook error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TEST API KEY ─────────────────────────────────────────

router.get('/test-api-key', requireAuth, async (req, res) => {
  const rawKey = process.env.ANTHROPIC_API_KEY || '';
  const cleanKey = rawKey.replace(/\s+/g, '');
  if (!cleanKey) {
    return res.json({ success: false, error: 'ANTHROPIC_API_KEY not set in environment' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: cleanKey });
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Reply with only the word "OK"' }]
    });
    const reply = msg.content[0]?.text || '';
    res.json({ success: true, reply, key_length: cleanKey.length, key_prefix: cleanKey.slice(0, 10) + '...' });
  } catch (err) {
    const safeMsg = (err.message || '').replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-ant-***');
    res.json({ success: false, error: safeMsg, key_length: cleanKey.length, key_prefix: cleanKey.slice(0, 10) + '...' });
  }
});

// ─── RT EVENTS BATCH ─────────────────────────────────────

// POST /calls/fetch-events-batch — Fetch and cache RedTrack events for calls
router.post('/calls/fetch-events-batch', requireAuth, async (req, res) => {
  const callIds = req.body.call_ids || [];
  // Get calls that have rt_clickid but no cached events
  let calls;
  if (callIds.length > 0) {
    const placeholders = callIds.map(() => '?').join(',');
    calls = db.prepare(`SELECT id, rt_clickid, call_start FROM calls WHERE id IN (${placeholders}) AND rt_clickid IS NOT NULL AND rt_clickid != '' AND rt_events IS NULL`).all(...callIds);
  } else {
    calls = db.prepare(`SELECT id, rt_clickid, call_start FROM calls WHERE rt_clickid IS NOT NULL AND rt_clickid != '' AND rt_events IS NULL ORDER BY call_start DESC LIMIT 25`).all();
  }

  let fetched = 0, errors = 0;
  for (const call of calls) {
    try {
      const callDate = call.call_start ? new Date(call.call_start) : new Date();
      const dateFrom = new Date(callDate);
      dateFrom.setDate(dateFrom.getDate() - 7);
      const dateTo = new Date(callDate);
      dateTo.setDate(dateTo.getDate() + 30);

      const url = `https://api.redtrack.io/conversions?api_key=${REDTRACK_API_KEY}&clickid=${encodeURIComponent(call.rt_clickid)}&date_from=${dateFrom.toISOString().split('T')[0]}&date_to=${dateTo.toISOString().split('T')[0]}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const items = data.items || data || [];
        const events = (Array.isArray(items) ? items : []).map(item => ({
          type: item.type || '',
          payout: item.payout || 0,
          conv_time: item.conv_time || ''
        }));
        db.prepare('UPDATE calls SET rt_events = ? WHERE id = ?').run(JSON.stringify(events), call.id);
        fetched++;
      } else {
        // Cache empty array so we don't re-fetch
        db.prepare('UPDATE calls SET rt_events = ? WHERE id = ?').run('[]', call.id);
        errors++;
      }
    } catch (err) {
      db.prepare('UPDATE calls SET rt_events = ? WHERE id = ?').run('[]', call.id);
      errors++;
    }
  }

  res.json({ fetched, errors, total: calls.length });
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
