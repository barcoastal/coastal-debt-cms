const {fromUrl} = require('./google-click-ids');

function plan(db, since) {
  const rows = db.prepare("SELECT id, gclid, hidden_fields FROM leads WHERE created_at >= ? AND COALESCE(TRIM(gclid), '') = '' ORDER BY id").all(since);
  return rows.flatMap(row => {
    let fields;
    try { fields = JSON.parse(row.hidden_fields || '{}'); } catch (_) { return []; }
    const value = fields.page_url || fields.sourceURL || fields.source_url;
    try { if (new URL(value).hostname !== 'info.coastaldebt.com') return []; } catch (_) { return []; }
    const ids = fromUrl(value);
    if (!ids.gclid) return [];
    return [{id:row.id, before:{gclid:row.gclid, hidden_fields:row.hidden_fields}, after:{gclid:ids.gclid,
      hidden_fields:JSON.stringify({...fields, ...(ids.gbraid ? {gbraid:ids.gbraid} : {}), ...(ids.wbraid ? {wbraid:ids.wbraid} : {}),
        gclid_capture_source:ids.source, gclid_recovered_at:new Date().toISOString()})}}];
  });
}
function apply(db, changes) {
  return db.transaction(() => {
    const update = db.prepare('UPDATE leads SET gclid=?, hidden_fields=? WHERE id=? AND gclid IS ? AND hidden_fields IS ?');
    for (const row of changes) {
      const result = update.run(row.after.gclid,row.after.hidden_fields,row.id,row.before.gclid,row.before.hidden_fields);
      if (result.changes !== 1) throw new Error('Lead changed after preview: ' + row.id);
    }
    if (changes.length) db.prepare('INSERT INTO activity_logs (user_name, action, entity_type, details) VALUES (?, ?, ?, ?)')
      .run('Codex — user requested', 'updated', 'leads', 'Recovered saved Google click IDs for leads: ' + changes.map(row => row.id).join(', '));
    return changes.length;
  })();
}
module.exports = {plan, apply};
