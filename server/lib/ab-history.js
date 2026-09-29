// Historical attribution is a snapshot of legacy records, separate from measured cohorts.
const { dateRange, dayAt } = require('./ab-store');
const utc = value => value ? Date.parse(String(value).replace(' ', 'T').replace(/Z?$/, 'Z')) : NaN;
const parse = value => { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch (_) { return {}; } };
function pageSlug(value) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://info.coastaldebt.com');
    if (url.hostname !== 'info.coastaldebt.com') return null;
    return /^\/lp\/([^/]+)\/?(?:index\.html)?$/.exec(url.pathname)?.[1] || null;
  } catch (_) { return null; }
}

function createHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_history_meta (id INTEGER PRIMARY KEY CHECK(id=1), imported_at INTEGER NOT NULL, cutoff INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ab_history_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, config TEXT NOT NULL DEFAULT '{}',
      b_name TEXT NOT NULL DEFAULT '', basis TEXT NOT NULL, excluded_updated_visitors INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ab_history_records (
      kind TEXT NOT NULL CHECK(kind IN ('visitor','lead')), source_id INTEGER NOT NULL,
      run_id INTEGER NOT NULL REFERENCES ab_history_runs(id), variant TEXT NOT NULL CHECK(variant IN ('A','B','U')),
      recorded_at INTEGER NOT NULL, attribution TEXT NOT NULL, visitor_id INTEGER,
      PRIMARY KEY(kind,source_id)
    );
    CREATE INDEX IF NOT EXISTS ab_history_record_range ON ab_history_records(run_id,recorded_at,kind);
  `);
  const importOnce = db.transaction(() => {
    if (db.prepare('SELECT id FROM ab_history_meta WHERE id=1').get()) return;
    const cutoff = db.prepare('SELECT MIN(started_at) t FROM ab_runs').get()?.t;
    if (!cutoff) return;
    const pages = db.prepare('SELECT id,name,slug,ab_config FROM landing_pages').all();
    const pageBySlug = new Map(pages.map(p => [p.slug, p]));
    const byPage = new Map();
    const logs = db.prepare("SELECT id,entity_id,details,created_at FROM activity_logs WHERE entity_type='ab_test' ORDER BY created_at,id").all();
    const runInsert = db.prepare('INSERT INTO ab_history_runs(page_id,name,slug,started_at,ended_at,config,b_name,basis) VALUES (?,?,?,?,?,?,?,?)');
    for (const page of pages) {
      const events = logs.filter(e => e.entity_id === page.id && utc(e.created_at) < cutoff);
      let active = null;
      const periods = [];
      for (const event of events) {
        const at = utc(event.created_at);
        if (!Number.isFinite(at)) continue;
        const enabled = /^(Enabled|Started) A\/B test/i.test(event.details || '');
        const disabled = /^Disabled A\/B test/i.test(event.details || '');
        if (!enabled && !disabled) continue;
        if (active && at > active.start) { active.end = at; periods.push(active); }
        active = null;
        if (enabled) active = { start: at, end: cutoff };
      }
      if (active) periods.push(active);
      for (const period of periods) {
        // The first measured run preserves the configuration at the historical cutoff.
        // Earlier activity logs preserve dates, but not the old split/configuration.
        const measured = period.end === cutoff ? db.prepare('SELECT config FROM ab_runs WHERE page_id=? ORDER BY started_at,id LIMIT 1').get(page.id) : null;
        const cfg = measured ? parse(measured.config) : { split: null };
        const b = cfg.variantB_page ? pages.find(p => p.id === Number(cfg.variantB_page)) : null;
        const result = runInsert.run(page.id,page.name,page.slug,period.start,period.end,JSON.stringify(cfg),b?.name || 'B (recorded variant)', 'Activity log');
        const run = {id:Number(result.lastInsertRowid),page_id:page.id,start:period.start,end:period.end,bIds:new Set(b ? [b.id] : []),config:cfg};
        if (!byPage.has(page.id)) byPage.set(page.id, []);
        byPage.get(page.id).push(run);
      }
    }
    const periodAt = (pageId, at) => (byPage.get(pageId) || []).find(r => at >= r.start && at < r.end);
    const leads = db.prepare(`SELECT l.id,l.landing_page_id,l.ab_variant,l.hidden_fields,l.created_at,v.id visitor_id
      FROM leads l LEFT JOIN visitors v ON l.eli_clickid <> '' AND v.eli_clickid=l.eli_clickid
      WHERE l.created_at < ?`).all(new Date(cutoff).toISOString().replace('T',' ').replace('Z',''));
    // Learn former B source pages from lead URL + explicit variant evidence, not current settings.
    for (const lead of leads) {
      const origin = pageBySlug.get(pageSlug(parse(lead.hidden_fields).page_url));
      const run = origin && periodAt(origin.id, utc(lead.created_at));
      if (run && lead.ab_variant === 'B' && lead.landing_page_id !== origin.id) run.bIds.add(lead.landing_page_id);
    }
    for (const periods of byPage.values()) for (const run of periods) {
      if (run.bIds.size) db.prepare('UPDATE ab_history_runs SET b_name=? WHERE id=?').run([...run.bIds].map(id => pages.find(p => p.id===id)?.name || `Page ${id}`).join(' / '),run.id);
    }
    const insert = db.prepare('INSERT OR IGNORE INTO ab_history_records(kind,source_id,run_id,variant,recorded_at,attribution,visitor_id) VALUES (?,?,?,?,?,?,?)');
    for (const lead of leads) {
      const fields = parse(lead.hidden_fields);
      const origin = pageBySlug.get(pageSlug(fields.page_url));
      const at = utc(lead.created_at);
      // An explicit different URL must never fall back to the source page's own test.
      const run = fields.page_url ? (origin && periodAt(origin.id, at)) : periodAt(lead.landing_page_id, at);
      if (!run) continue;
      let variant = 'U', attribution = 'unassigned';
      if (origin && ['A','B'].includes(lead.ab_variant)) { variant = lead.ab_variant; attribution = 'tagged'; }
      else if (origin && run.bIds.size && lead.landing_page_id === run.page_id) { variant = 'A'; attribution = 'inferred_source'; }
      else if (origin && run.bIds.has(lead.landing_page_id)) { variant = 'B'; attribution = 'inferred_source'; }
      else if (!fields.page_url && ['A','B'].includes(lead.ab_variant)) {
        const couldBeSource = [...byPage.values()].flat().some(r => at >= r.start && at < r.end && r.bIds.has(lead.landing_page_id));
        if (!couldBeSource) { variant=lead.ab_variant; attribution='inferred_origin'; }
      }
      insert.run('lead',lead.id,run.id,variant,at,attribution,lead.visitor_id || null);
    }
    const visitors = db.prepare('SELECT id,landing_page,ab_variant,first_visit,last_visit FROM visitors').all();
    for (const visitor of visitors) {
      const page = pageBySlug.get(pageSlug(visitor.landing_page));
      if (!page || !byPage.has(page.id)) continue;
      const at = utc(visitor.last_visit);
      if (at >= cutoff) {
        if (utc(visitor.first_visit) < cutoff) {
          const latest = byPage.get(page.id).at(-1);
          db.prepare('UPDATE ab_history_runs SET excluded_updated_visitors=excluded_updated_visitors+1 WHERE id=?').run(latest.id);
        }
        continue;
      }
      const run = periodAt(page.id, at);
      if (!run) continue;
      let variant = 'U', attribution = 'unassigned';
      if (['A','B'].includes(visitor.ab_variant)) { variant=visitor.ab_variant; attribution='tagged'; }
      else if (run.bIds.size) { variant='A'; attribution='inferred_untagged'; }
      insert.run('visitor',visitor.id,run.id,variant,at,attribution,visitor.id);
    }
    db.prepare('INSERT INTO ab_history_meta(id,imported_at,cutoff) VALUES (1,?,?)').run(Date.now(),cutoff);
  });
  function report(query={}) {
    importOnce();
    let timezone=db.prepare("SELECT value FROM settings WHERE key='timezone'").get()?.value || 'America/New_York';
    try { dayAt(Date.now(),timezone); } catch (_) { timezone='America/New_York'; }
    const range=dateRange(query,timezone);
    const meta=db.prepare('SELECT * FROM ab_history_meta WHERE id=1').get();
    const rows=db.prepare('SELECT * FROM ab_history_records WHERE recorded_at>=? AND recorded_at<?').all(range.start,range.end);
    const fresh=()=>({visitors:0,leads:0,converted:0,rate:null,taggedVisitors:0,inferredVisitors:0,taggedLeads:0,inferredLeads:0});
    function summarize(records) {
      const stats={A:fresh(),B:fresh(),U:fresh()};
      for (const r of records) {
        const s=stats[r.variant];
        if(r.kind==='visitor') {s.visitors++; s[r.attribution==='tagged'?'taggedVisitors':'inferredVisitors']++;}
        else {s.leads++;s[r.attribution==='tagged'?'taggedLeads':'inferredLeads']++;}
      }
      for(const v of ['A','B','U']) {
        const s=stats[v];
        s.converted=new Set(records.filter(r=>r.kind==='lead' && r.variant===v && r.visitor_id).map(r=>r.visitor_id)).size;
        s.rate=s.visitors && s.leads<=s.visitors ? s.leads/s.visitors*100 : null;
      }
      return stats;
    }
    const runs=db.prepare('SELECT * FROM ab_history_runs ORDER BY started_at DESC,id DESC').all().map(r=>({...r,id:-r.id,source:'historical',template:'Historical page',config:parse(r.config),stats:summarize(rows.filter(x=>x.run_id===r.id))}));
    const selected=runs.find(r=>r.id===Number(query.run)) || runs.find(r=>r.page_id===Number(query.page)) || runs[0];
    const selectedRows=selected ? rows.filter(r=>r.run_id===-selected.id) : [];
    const days=new Map();
    for(const r of selectedRows) {const day=dayAt(r.recorded_at,timezone);if(!days.has(day))days.set(day,[]);days.get(day).push(r);}
    const daily=[...days.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,records])=>({date,...summarize(records)}));
    const recent=selectedRows.filter(r=>r.kind==='lead').sort((a,b)=>b.recorded_at-a.recorded_at).slice(0,50).map(r=>({lead_id:r.source_id,variant:r.variant,created_at:r.recorded_at,first_seen:null,attribution:r.attribution}));
    return {source:'historical',timezone,today:dayAt(Date.now(),timezone),from:range.from,to:range.to,trackingSince:meta?.cutoff || null,importedAt:meta?.imported_at || null,runs,selectedId:selected?.id || null,daily,recent};
  }
  return {importOnce,report};
}
module.exports={createHistory,pageSlug,utc};
