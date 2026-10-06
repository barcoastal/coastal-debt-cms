const { createHash } = require('crypto');
const { dayAt, dateRange } = require('./ab-store');

const normalize = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const hash = s => createHash('sha256').update(s).digest('hex');
const stamp = s => { const v=String(s).replace(' ', 'T'); return typeof s === 'number' ? s : Date.parse(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(v) ? v : v+'Z'); };
const sfKey = id => String(id).slice(0, 15);
function identity(lead) {
  let hidden = {}; try { hidden = JSON.parse(lead.hidden_fields || '{}') || {}; } catch (_) {}
  const click = [hidden.tkclid, hidden.trakkit_click_id].find(s => typeof s === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s));
  return { ...lead, click: click?.toUpperCase() || null,
    emailHash: lead.email?.trim() ? hash(lead.email.trim().toLowerCase()) : null,
    nameHash: (lead.first_name || lead.last_name) && lead.company_name ? hash(normalize([lead.first_name, lead.last_name].filter(Boolean).join(' ')) + '|' + normalize(lead.company_name)) : null,
    submitted: stamp(lead.created_at) };
}

// Match a submission, not just a person: returning clients can have old deals.
function matchOutcomes(leads, snapshot) {
  const clicks = new Map(snapshot.clicks.map(c => [c.id, c]));
  const events = new Map();
  for (const event of snapshot.events) {
    if (!events.has(event.click_id)) events.set(event.click_id, []);
    events.get(event.click_id).push(event);
  }
  return leads.map(raw => {
    const l = identity(raw);
    const candidates = snapshot.crm.filter(r => l.salesforce_lead_id ? sfKey(r.id) === sfKey(l.salesforce_lead_id) :
      Date.parse(r.created_at) >= l.submitted && Date.parse(r.created_at) <= l.submitted + 300000 &&
      ((l.emailHash && r.email_hash === l.emailHash) || (l.nameHash && r.name_hash === l.nameHash)));
    if (candidates.length > 1) return { lead_id: l.id, state: 'ambiguous', matched_by: null, entity: null, opportunity: null, closed_won: null };
    const crm = candidates[0];
    if (crm?.converted_opportunity_id && !crm.opportunity_id) return { lead_id: l.id, state: 'pending', matched_by: 'crm', entity: null, opportunity: null, closed_won: null };
    const tracked = l.click && clicks.has(l.click);
    const approved = (events.get(l.click) || []).filter(e => e.status === 'approved' && Date.parse(e.occurred_at) >= l.submitted - 60000);
    const won = approved.some(e => e.type === 'closed_won') || crm?.stage === 'Closed Won';
    const opportunity = won || !!crm?.opportunity_id || approved.some(e => e.type === 'opportunity');
    const txid = approved.find(e => ['opportunity','closed_won'].includes(e.type) && /^006[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(e.txid || ''))?.txid;
    return { lead_id: l.id, state: crm || tracked ? 'matched' : 'unmatched', matched_by: crm ? 'crm' : tracked ? 'click' : null,
      entity: crm?.opportunity_id ? 'opp:' + sfKey(crm.opportunity_id) : txid ? 'opp:' + sfKey(txid) : crm ? 'lead:' + sfKey(crm.id) : tracked ? 'click:' + l.click : null,
      opportunity: crm || tracked ? Number(opportunity) : null, closed_won: crm || tracked ? Number(won) : null };
  });
}

function createReader(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000,
    statement_timeout: 12000, options: '-c default_transaction_read_only=on', application_name: 'coastal-ab-outcomes' });
  pool.on('error', () => {});
  const read = async leads => {
    const ids = leads.map(identity);
    const clicks = [...new Set(ids.map(l => l.click).filter(Boolean))];
    const dates = ids.flatMap(l => [l.submitted, l.submitted + 300000]).map(ms => new Date(ms).toISOString().slice(0, 10)).sort();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const crm = leads.length ? (await client.query(`SELECT * FROM coastal_ab.crm_leads
        WHERE created_day >= $1 AND created_day <= $2 AND (email_hash = ANY($3::text[]) OR name_hash = ANY($4::text[])) LIMIT 50001`,
        [dates[0], dates.at(-1), ids.map(l => l.emailHash).filter(Boolean), ids.map(l => l.nameHash).filter(Boolean)])).rows : [];
      const linked = [...new Set(ids.map(l => l.salesforce_lead_id).filter(Boolean))];
      if (linked.length) {
        const known = new Set(crm.map(r => r.id));
        for (const row of (await client.query('SELECT * FROM coastal_ab.crm_leads WHERE id = ANY($1::text[])', [linked])).rows) if (!known.has(row.id)) crm.push(row);
      }
      if (crm.length > 50000) throw new Error('Outcome lookup exceeded its limit');
      const found = (await client.query('SELECT id FROM coastal_ab.clicks WHERE id = ANY($1::text[])', [clicks])).rows;
      const events = (await client.query('SELECT * FROM coastal_ab.events WHERE click_id = ANY($1::text[])', [clicks])).rows;
      const sync = (await client.query('SELECT * FROM coastal_ab.sync')).rows;
      await client.query('COMMIT');
      return { crm, clicks: found, events, sync };
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err; }
    finally { client.release(); }
  };
  return Object.assign(read, { close: () => pool.end() });
}

function createOutcomes(db, { connectionString = process.env.TRAKKIT_DATABASE_URL, reader, now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS ab_lead_outcomes (
    lead_id INTEGER PRIMARY KEY, state TEXT NOT NULL, matched_by TEXT, entity TEXT,
    opportunity INTEGER, closed_won INTEGER, checked_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ab_outcome_sync (id INTEGER PRIMARY KEY CHECK(id=1), last_success INTEGER, last_error TEXT, source_sync TEXT);`);
  const enabled = !!(reader || connectionString);
  const read = reader || (connectionString ? createReader(connectionString) : null);
  let pending, attempted = 0;
  const cohort = () => db.prepare(`SELECT l.id,l.email,l.first_name,l.last_name,l.company_name,l.hidden_fields,l.salesforce_lead_id,l.created_at,
    p.run_id,p.variant,p.first_seen FROM ab_conversions c JOIN ab_participants p ON p.token=c.token JOIN leads l ON l.id=c.lead_id
    WHERE p.first_seen IS NOT NULL ORDER BY l.created_at,l.id`).all();
  async function refresh() {
    if (!enabled) return;
    if (pending) return pending;
    if (attempted && now() - attempted < 60000) return;
    attempted = now();
    pending = (async () => {
      try {
        const leads = cohort();
        const snapshot = await read(leads);
        const records = matchOutcomes(leads, snapshot);
        db.transaction(() => {
          const save = db.prepare(`INSERT OR REPLACE INTO ab_lead_outcomes VALUES (@lead_id,@state,@matched_by,@entity,@opportunity,@closed_won,@checked_at)`);
          for (const r of records) save.run({ ...r, checked_at: now() });
          db.prepare('INSERT OR REPLACE INTO ab_outcome_sync VALUES (1,?,NULL,?)').run(now(), JSON.stringify(snapshot.sync));
        })();
        console.log('[ab-outcomes] ' + JSON.stringify({ leads: leads.length, matched: records.filter(r => r.state === 'matched').length,
          opportunities: new Set(records.filter(r => r.opportunity).map(r => r.entity)).size, closedWon: new Set(records.filter(r => r.closed_won).map(r => r.entity)).size }));
      } catch (_) {
        db.prepare(`INSERT INTO ab_outcome_sync(id,last_error) VALUES (1,'Trakkit update failed')
          ON CONFLICT(id) DO UPDATE SET last_error=excluded.last_error`).run();
      } finally { pending = null; }
    })();
    return pending;
  }
  function enrich(report, query = {}) {
    const state = db.prepare('SELECT * FROM ab_outcome_sync WHERE id=1').get();
    let sync = []; try { sync = JSON.parse(state?.source_sync || '[]'); } catch (_) {}
    const stale = sync.length < 2 || sync.some(s => s.status !== 'complete' || !Number.isFinite(Date.parse(s.updated_at)) || now() - Date.parse(s.updated_at) > 3600000);
    const available = enabled && !!state?.last_success;
    report.outcomeSync = { connected: enabled, available, lastSuccess: state?.last_success || null,
      stale: !!state?.last_error || !state?.last_success || now() - state.last_success > 600000 || stale,
      sourceUpdatedAt: sync.length ? Math.min(...sync.map(s => Date.parse(s.updated_at))) : null,
      error: state?.last_error || null };
    const range = dateRange(query, report.timezone);
    const outcomes = new Map(db.prepare('SELECT * FROM ab_lead_outcomes').all().map(r => [r.lead_id,r]));
    const rows = cohort();
    // An entity belongs to its first attributed submission in each run, even
    // when the date filter excludes it. Never move the sale to a later variant.
    const owners = new Map();
    for (const row of rows) {
      const o = outcomes.get(row.id);
      if (o?.entity && !owners.has(row.run_id + ':' + o.entity)) owners.set(row.run_id + ':' + o.entity, row.id);
    }
    const blank = () => ({ opportunities: available ? 0 : null, closedWon: available ? 0 : null, matched: 0, unmatched: 0, repeated: 0, leads: 0 });
    const byRun = new Map();
    for (const run of report.runs) {
      run.outcomes = run.source === 'historical' ? null : { A: blank(), B: blank() };
      if (run.outcomes) byRun.set(run.id, run.outcomes);
    }
    const daily = new Map(report.daily.map(d => [d.date, d]));
    if (byRun.has(report.selectedId)) for (const d of report.daily) for (const v of ['A','B']) d[v].outcomes = blank();
    for (const row of rows) {
      const totals = byRun.get(row.run_id)?.[row.variant];
      if (!totals || row.first_seen < range.start || row.first_seen >= range.end) continue;
      const o = outcomes.get(row.id);
      const repeated = !!o?.entity && owners.get(row.run_id + ':' + o.entity) !== row.id;
      const targets = [totals];
      if (row.run_id === report.selectedId) {
        const day = daily.get(dayAt(row.first_seen, report.timezone))?.[row.variant]?.outcomes;
        if (day) targets.push(day);
      }
      for (const s of targets) {
        s.leads++; s.matched += available && o?.state === 'matched' ? 1 : 0;
        s.unmatched += !available || o?.state !== 'matched' ? 1 : 0;
        if (available && o?.state === 'matched') {
          s.repeated += Number(repeated);
          if (!repeated) { s.opportunities += Number(o.opportunity); s.closedWon += Number(o.closed_won); }
        }
      }
    }
    for (const row of report.recent) row.outcome = byRun.has(report.selectedId) && available ? outcomes.get(row.lead_id) || null : null;
    return report;
  }
  return { refresh, enrich, enabled };
}
module.exports = { identity, matchOutcomes, createReader, createOutcomes };
