// Dry-run by default. Restore only empty GCLIDs from the lead's own saved URL.
// Never re-submit a lead, send a webhook, upload a conversion or alter visitors.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const recovery = require('../server/lib/google-click-id-recovery');
const since = process.argv.find(arg => arg.startsWith('--since='))?.slice(8);
if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '')) throw new Error('Specify --since=YYYY-MM-DD (UTC)');
const apply = process.argv.includes('--apply');
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!volume) throw new Error('RAILWAY_VOLUME_MOUNT_PATH is required');
const db = new Database(path.join(volume,'cms.db'), {readonly:!apply});
try {
  const changes = recovery.plan(db,since);
  let backup = null, count = 0;
  if (apply && changes.length) {
    const directory = path.join(volume,'backups'); fs.mkdirSync(directory,{recursive:true,mode:0o700});
    backup = path.join(directory,'google-click-ids-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    fs.writeFileSync(backup,JSON.stringify(changes,null,2),{mode:0o600,flag:'wx'});
    count = recovery.apply(db,changes);
  }
  console.log(JSON.stringify({mode:apply?'applied':'preview',since,eligible:changes.length,updated:count,ids:changes.map(row=>row.id),backup}));
} finally {db.close();}
