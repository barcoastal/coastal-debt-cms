const { randomBytes } = require('crypto');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function configOf(page) { try { return JSON.parse(page.ab_config || '{}'); } catch (_) { return {}; } }
function dayAt(ms, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function midnight(date, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Use valid YYYY-MM-DD dates.');
  const target = Date.parse(date + 'T00:00:00Z');
  let ms = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map(x => [x.type, x.value]));
    ms += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return ms;
}
function dateRange(query, timezone) {
  const from = query.from || '';
  const to = query.to || '';
  const start = from ? midnight(from, timezone) : 0;
  let end = Date.now() + 1;
  if (to) {
    midnight(to, timezone);
    const next = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    end = midnight(next, timezone);
  }
  if (from && to && from > to) throw new Error('Start date must be on or before end date.');
  return { from, to, start, end };
}
const empty = () => ({ visitors: 0, leads: 0, converted: 0, rate: 0 });

function createStore(db, now = Date.now) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ab_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER NOT NULL,
      name TEXT NOT NULL, slug TEXT NOT NULL, template TEXT, b_name TEXT, b_page_id INTEGER,
      config TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ab_one_active_run ON ab_runs(page_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS ab_participants (
      token TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES ab_runs(id),
      variant TEXT NOT NULL CHECK (variant IN ('A','B')), assigned_at INTEGER NOT NULL,
      first_seen INTEGER, last_seen INTEGER
    );
    CREATE INDEX IF NOT EXISTS ab_participant_cohort ON ab_participants(run_id, first_seen);
    CREATE TABLE IF NOT EXISTS ab_conversions (
      lead_id INTEGER PRIMARY KEY, token TEXT NOT NULL REFERENCES ab_participants(token), created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ab_conversion_token ON ab_conversions(token);
  `);
  const sync = db.transaction(page => {
    const cfg = configOf(page);
    const config = JSON.stringify(stable(cfg));
    const current = db.prepare('SELECT * FROM ab_runs WHERE page_id = ? AND ended_at IS NULL').get(page.id);
    if (current && cfg.enabled && current.config === config) return current;
    if (current) db.prepare('UPDATE ab_runs SET ended_at = ? WHERE id = ?').run(now(), current.id);
    if (!cfg.enabled) return null;
    const b = cfg.variantB_page ? db.prepare('SELECT id, name, template_type FROM landing_pages WHERE id = ?').get(cfg.variantB_page) : null;
    const result = db.prepare('INSERT INTO ab_runs (page_id,name,slug,template,b_name,b_page_id,config,started_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(page.id, page.name, page.slug, page.template_type || 'form', b ? b.name : (cfg.variantB_template || 'Content overrides'), b?.id || null, config, now());
    return db.prepare('SELECT * FROM ab_runs WHERE id = ?').get(result.lastInsertRowid);
  });
  function syncAll() {
    db.prepare('SELECT * FROM landing_pages').all().forEach(sync);
    db.prepare('UPDATE ab_runs SET ended_at = ? WHERE ended_at IS NULL AND page_id NOT IN (SELECT id FROM landing_pages)').run(now());
  }
  function assign(run, cookieToken, oldVariant, random = Math.random) {
    let p = cookieToken && db.prepare('SELECT * FROM ab_participants WHERE token = ? AND run_id = ?').get(cookieToken, run.id);
    if (p) return p;
    const cfg = JSON.parse(run.config);
    const split = Math.max(0, Math.min(100, Number(cfg.split ?? 50)));
    // Keep existing visitors in their established variant on the first measured run only.
    const previous = db.prepare('SELECT id FROM ab_runs WHERE page_id = ? AND id < ? LIMIT 1').get(run.page_id, run.id);
    const variant = !previous && ['A', 'B'].includes(oldVariant) ? oldVariant : (random() * 100 < split ? 'B' : 'A');
    const token = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO ab_participants (token,run_id,variant,assigned_at) VALUES (?,?,?,?)').run(token, run.id, variant, now());
    return db.prepare('SELECT * FROM ab_participants WHERE token = ?').get(token);
  }
  function expose(token) {
    db.prepare('UPDATE ab_participants SET first_seen = COALESCE(first_seen, ?), last_seen = ? WHERE token = ?').run(now(), now(), token);
  }
  function convert(req, leadId, destinationId) {
    // The actual test URL identifies the experiment, even when B uses another page's form.
    let slug;
    try {
      const ref = new URL(req.get('referer'));
      if (ref.host !== req.get('host')) return;
      slug = /^\/lp\/([^/]+)\/?(?:index\.html)?$/.exec(ref.pathname)?.[1];
    } catch (_) { return; }
    if (!slug) return;
    const page = db.prepare('SELECT id FROM landing_pages WHERE slug = ?').get(slug);
    const token = page && (req.get('x-coastal-ab-exposure') || req.cookies?.[`ab_session_${page.id}`]);
    if (!token) return;
    const p = db.prepare('SELECT p.*, r.page_id, r.b_page_id FROM ab_participants p JOIN ab_runs r ON r.id = p.run_id WHERE p.token = ? AND r.page_id = ?').get(token, page.id);
    if (!p || (destinationId !== p.page_id && !(p.variant === 'B' && destinationId === p.b_page_id))) return;
    expose(token);
    db.prepare('INSERT OR IGNORE INTO ab_conversions (lead_id,token,created_at) VALUES (?,?,?)').run(leadId, token, now());
  }
  function report(query = {}) {
    syncAll();
    let timezone = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get()?.value || 'America/New_York';
    try { dayAt(now(), timezone); } catch (_) { timezone = 'America/New_York'; }
    const range = dateRange(query, timezone);
    const runs = db.prepare('SELECT * FROM ab_runs ORDER BY started_at DESC, id DESC').all();
    const counts = db.prepare(`SELECT p.run_id, p.variant, COUNT(*) visitors, SUM(COALESCE(c.leads,0)) leads,
      SUM(CASE WHEN c.leads > 0 THEN 1 ELSE 0 END) converted
      FROM ab_participants p LEFT JOIN (SELECT token, COUNT(*) leads FROM ab_conversions GROUP BY token) c ON c.token = p.token
      WHERE p.first_seen >= ? AND p.first_seen < ? GROUP BY p.run_id, p.variant`).all(range.start, range.end);
    for (const run of runs) {
      run.config = JSON.parse(run.config);
      run.stats = { A: empty(), B: empty() };
      for (const row of counts.filter(c => c.run_id === run.id)) run.stats[row.variant] = { visitors: row.visitors, leads: row.leads, converted: row.converted, rate: row.visitors ? row.converted / row.visitors * 100 : 0 };
    }
    const selected = runs.find(r => r.id === Number(query.run)) || runs.find(r => r.page_id === Number(query.page)) || runs[0];
    const daily = [];
    let recent = [];
    if (selected) {
      const rows = db.prepare(`SELECT p.first_seen, p.variant, COALESCE(c.leads,0) leads FROM ab_participants p
        LEFT JOIN (SELECT token, COUNT(*) leads FROM ab_conversions GROUP BY token) c ON c.token = p.token
        WHERE p.run_id = ? AND p.first_seen >= ? AND p.first_seen < ? ORDER BY p.first_seen`).all(selected.id, range.start, range.end);
      const days = new Map();
      for (const row of rows) {
        const day = dayAt(row.first_seen, timezone);
        if (!days.has(day)) days.set(day, { date: day, A: empty(), B: empty() });
        const stats = days.get(day)[row.variant];
        stats.visitors++; stats.leads += row.leads; stats.converted += row.leads > 0 ? 1 : 0;
        stats.rate = stats.converted / stats.visitors * 100;
      }
      daily.push(...days.values());
      recent = db.prepare(`SELECT c.lead_id, c.created_at, p.variant, p.first_seen FROM ab_conversions c
        JOIN ab_participants p ON p.token = c.token WHERE p.run_id = ? AND p.first_seen >= ? AND p.first_seen < ? ORDER BY c.created_at DESC LIMIT 50`).all(selected.id, range.start, range.end);
    }
    return { timezone, today: dayAt(now(), timezone), from: range.from, to: range.to, trackingSince: db.prepare('SELECT MIN(started_at) started FROM ab_runs').get().started, runs, selectedId: selected?.id || null, daily, recent };
  }
  return { sync, syncAll, assign, expose, convert, report };
}
module.exports = { createStore, configOf, dateRange, dayAt };
