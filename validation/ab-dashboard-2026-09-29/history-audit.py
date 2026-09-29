"""Read-only production source audit. Recovery runs only against an in-memory copy."""
from pathlib import Path
import base64,shlex,subprocess
root=Path(__file__).resolve().parents[2]
source=base64.b64encode((root/'server/lib/ab-history.js').read_bytes()).decode()
code=r'''
const D=require('better-sqlite3');
const source=new D(process.env.RAILWAY_VOLUME_MOUNT_PATH+'/cms.db',{readonly:true,fileMustExist:true});
const db=new D(':memory:');
const specs=[
 ['landing_pages','id INTEGER,name TEXT,slug TEXT,ab_config TEXT','SELECT id,name,slug,ab_config FROM landing_pages'],
 ['settings','key TEXT,value TEXT',"SELECT key,value FROM settings WHERE key='timezone'"],
 ['ab_runs','id INTEGER,page_id INTEGER,started_at INTEGER,config TEXT','SELECT id,page_id,started_at,config FROM ab_runs'],
 ['activity_logs','id INTEGER,entity_type TEXT,entity_id INTEGER,details TEXT,created_at TEXT',"SELECT id,entity_type,entity_id,details,created_at FROM activity_logs WHERE entity_type='ab_test'"],
 ['visitors','id INTEGER,eli_clickid TEXT,landing_page TEXT,ab_variant TEXT,first_visit TEXT,last_visit TEXT','SELECT id,eli_clickid,landing_page,ab_variant,first_visit,last_visit FROM visitors'],
 ['leads','id INTEGER,landing_page_id INTEGER,ab_variant TEXT,hidden_fields TEXT,created_at TEXT,eli_clickid TEXT',`SELECT id,landing_page_id,ab_variant,CASE WHEN json_valid(hidden_fields) THEN json_object('page_url',json_extract(hidden_fields,'$.page_url')) ELSE '{}' END hidden_fields,created_at,eli_clickid FROM leads`]
];
for(const [table,ddl,query] of specs){db.exec('CREATE TABLE '+table+'('+ddl+')');const rows=source.prepare(query).all();if(rows.length){const insert=db.prepare('INSERT INTO '+table+' VALUES ('+Object.keys(rows[0]).map(()=>'?').join(',')+')');db.transaction(()=>rows.forEach(r=>insert.run(...Object.values(r))))();}}
source.close();
const moduleContext={exports:{}};
require('vm').runInNewContext(Buffer.from('SOURCE','base64').toString(),{module:moduleContext,require:n=>n==='./ab-store'?require('./server/lib/ab-store'):require(n),URL,console});
const history=moduleContext.exports.createHistory(db);history.importOnce();
const result=history.report({page:7});
console.log(JSON.stringify({cutoff:result.trackingSince,runs:result.runs.map(r=>({id:r.id,page:r.page_id,start:new Date(r.started_at).toISOString(),end:new Date(r.ended_at).toISOString(),b:r.b_name,split:r.config.split,stats:r.stats,updatedVisitors:r.excluded_updated_visitors})),days:result.daily.length}));
db.close();
'''.replace('SOURCE',source)
args=['railway','ssh','-p','bc953cc9-888c-46ba-9983-7f2b413fafa8','-s','7fc17f8e-37cd-4ca7-b4b9-d1e8f9033d83','-e','25da855a-47ed-48fd-b9ef-bdc7307b905c','--','node -e '+shlex.quote(code)]
result=subprocess.run(args,capture_output=True,text=True)
if result.returncode:
 print(result.stderr[-1500:]); print(result.stdout[-1500:]); raise SystemExit(result.returncode)
print(result.stdout)
