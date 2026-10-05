const assert = require('node:assert/strict');
const {analyzeRun, betaGreater} = require('../../server/lib/ab-statistics');
const {createStore} = require('../../server/lib/ab-store');
const Database = require('better-sqlite3');
const DAY = 86400000;
const now = Date.parse('2026-10-05T12:00:00Z');
const run = {started_at:now-8*DAY,ended_at:null,config:{split:50}};
const stats = (na,sa,nb,sb) => ({A:{visitors:na,converted:sa},B:{visitors:nb,converted:sb}});
const model = (s, changes={}) => analyzeRun({...run,...changes},s,now);
// Independent reference: scipy.integrate.quad(beta_B.pdf(x) * beta_A.cdf(x)).
const references = [
  [63,4,56,7,.869757024177], [32,2,33,5,.861125018036],
  [126,7,460,32,.664920110441], [100,10,100,20,.975173033152],
  [1000,100,1000,200,.999999999852], [10000,1000,10000,1100,.989457354431],
  [100,0,100,20,.999999850440], [100,100,100,90,.000366333278],
  [100000,50000,100000,50100,.672638796726], [0,0,1,1,2/3]
];
for (const [na,sa,nb,sb,expected] of references) {
  const actual=betaGreater(sa+1,na-sa+1,sb+1,nb-sb+1);
  assert.ok(Math.abs(actual-expected)<1e-7,JSON.stringify({na,sa,nb,sb,actual,expected}));
  const reversed=betaGreater(sb+1,nb-sb+1,sa+1,na-sa+1);
  assert.ok(Math.abs(actual+reversed-1)<1e-7);
}
assert.equal(betaGreater(1,1,1,1),.5);
assert.equal(betaGreater(50001,50001,50001,50001),.5);
assert.equal(model(stats(0,0,0,0)).status,'waiting');
assert.equal(model(stats(0,0,100,20)).status,'waiting');
assert.equal(model(stats(500,0,500,0)).status,'waiting');
assert.equal(model(stats(100,10,100,20)).winner,'B');
assert.equal(model(stats(100,20,100,10)).winner,'A');
assert.equal(model(stats(100,0,100,20)).winner,'B','a zero-conversion control is valid');
assert.equal(model(stats(100,10,100,20),{started_at:now-6.999*DAY}).status,'collecting');
assert.equal(model(stats(99,10,100,20)).status,'collecting');
assert.equal(model(stats(100,0,100,19)).status,'collecting');
assert.equal(model(stats(1000,100,1000,101)).status,'inconclusive');
assert.equal(model(stats(1000,100,1000,100)).leadingVariant,null);
assert.equal(model(stats(100,10,100,20),{config:{split:0}}).status,'unavailable');
assert.equal(model(stats(100,10,100,20),{config:{split:100}}).status,'unavailable');
assert.equal(model(stats(100,10,100,20),{source:'historical'}).status,'unavailable');
assert.equal(model(stats(10,11,100,20)).status,'unavailable');
assert.equal(model(stats(100,10,100,20),{ended_at:now-2*DAY}).status,'collecting','ended tests use their actual duration');
assert.equal(model(stats(100,10,100,20),{ended_at:now-DAY}).winner,'B');
assert.equal(model(stats(100,0,100,20)).lift,null,'zero baseline does not produce infinite lift');

// Real SQL aggregation: include only exposed participants, dedupe conversions,
// retain full-run inference under date filters, and preserve old-run isolation.
const db = new Database(':memory:');
db.exec(`CREATE TABLE landing_pages(id INTEGER PRIMARY KEY,name TEXT,slug TEXT,template_type TEXT,ab_config TEXT);
CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES ('timezone','America/New_York');
INSERT INTO landing_pages VALUES(1,'Test','test','authority','{"enabled":true,"split":50}');`);
let time=now-8*DAY;
const store=createStore(db,()=>time);
store.syncAll();
const stored=store.sync(db.prepare('SELECT * FROM landing_pages WHERE id=1').get());
const insert=db.prepare('INSERT INTO ab_participants VALUES (?,?,?,?,?,?)');
const conversion=db.prepare('INSERT INTO ab_conversions VALUES (?,?,?)');
let lead=0;
db.transaction(()=>{
  for (const variant of ['A','B']) for(let i=0;i<200;i++) {
    const token=variant+'-'+i;
    insert.run(token,stored.id,variant,time,time,time);
    if(i<(variant==='A'?20:50)) conversion.run(++lead,token,time);
  }
  conversion.run(++lead,'A-0',time); // Repeat lead is not a second converted visitor.
  insert.run('unexposed',stored.id,'A',time,null,null);
})();
time=now;
const all=store.report().runs[0];
assert.deepEqual(all.inference.stats,stats(200,20,200,50));
assert.equal(all.stats.A.leads,21);
assert.equal(all.inference.winner,'B');
const filtered=store.report({from:'2026-10-04',to:'2026-10-05'}).runs[0];
assert.equal(filtered.stats.A.visitors,0);
assert.deepEqual(filtered.inference,all.inference,'date filters cannot change winner assessment');
db.prepare('UPDATE landing_pages SET ab_config=? WHERE id=1').run(JSON.stringify({enabled:true,split:80}));
const changed=store.report();
assert.equal(changed.runs[0].inference.status,'waiting');
assert.equal(changed.runs[1].inference.winner,'B');
db.close();
console.log('PASS: Bayesian numerical references, symmetry, zero events, A/B winners, thresholds, ended and historical runs, duplicate leads, exposure gating, full-run/date-filter isolation, and new-run reset.');
