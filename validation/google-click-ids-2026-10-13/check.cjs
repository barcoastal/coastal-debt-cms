const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const ids = require('../../server/lib/google-click-ids');
const recovery = require('../../server/lib/google-click-id-recovery');
const root = path.resolve(__dirname,'../..');
const click = 'EAIaIQobChMI-Test_Google-ID';
const pageUrl = 'https://info.coastaldebt.com/lp/mca-debt/?cmpid=6855272ea2fde3e964e81fb6&sub9=g&ref_id='+click+'&gbraid=braid-test&wbraid=web-braid-test';
assert.equal(ids.resolve({page_url:pageUrl}).gclid,click);
assert.equal(ids.resolve({sourceURL:pageUrl}).gclid,click);
assert.equal(ids.resolve({gclid:'explicit-click',page_url:pageUrl}).gclid,'explicit-click');
assert.equal(ids.fromUrl(pageUrl+'&gclid=direct-google').gclid,'direct-google');
assert.equal(ids.fromUrl(pageUrl.replace('6855272ea2fde3e964e81fb6','facebook-campaign')).gclid,'');
assert.equal(ids.fromUrl('https://example.test/?ref_id='+click).gclid,'');
assert.equal(ids.fromUrl('https://example.test/?gbraid=some-braid&wbraid=other-braid').gclid,'');
assert.equal(ids.fromUrl('https://example.test/?gclid=%7Bgclid%7D').gclid,'');
assert.equal(ids.cleanId('undefined'),''); assert.equal(ids.cleanId({}),'');
assert.equal(ids.resolve({page_url:'bad'}).gclid,'');
assert.equal(ids.forRequest({body:{},headers:{referer:pageUrl},get:()=> 'info.coastaldebt.com'}).gclid,click);
assert.equal(ids.forRequest({body:{},headers:{referer:pageUrl},get:()=> 'unrelated.test'}).gclid,'');
assert.equal(ids.resolve({page_url:pageUrl}).gbraid,'braid-test');
const injected = ids.inject('<html><head><script>existing()</script></head></html>');
assert.equal(ids.inject(injected),injected);
assert.ok(injected.indexOf('coastal-google-click-ids')<injected.indexOf('existing()'));

const db = new Database(':memory:');
db.exec('CREATE TABLE leads (id INTEGER PRIMARY KEY,gclid TEXT,hidden_fields TEXT,created_at TEXT); CREATE TABLE activity_logs (user_name TEXT,action TEXT,entity_type TEXT,details TEXT);');
const insert = db.prepare('INSERT INTO leads VALUES (?,?,?,?)');
insert.run(1,'',JSON.stringify({page_url:pageUrl,unrelated:'keep'}),'2026-10-12');
insert.run(2,'already-saved',JSON.stringify({page_url:pageUrl}),'2026-10-12');
insert.run(3,'',JSON.stringify({page_url:pageUrl}),'2025-01-01');
insert.run(4,'',JSON.stringify({page_url:'https://info.coastaldebt.com/?ref_id=affiliate'}),'2026-10-12');
insert.run(5,'','bad JSON','2026-10-12');
insert.run(6,'',JSON.stringify({page_url:pageUrl.replace('info.coastaldebt.com','other.test')}),'2026-10-12');
const plan = recovery.plan(db,'2026-09-13'); assert.deepEqual(plan.map(row=>row.id),[1]);
assert.equal(recovery.apply(db,plan),1); assert.equal(recovery.plan(db,'2026-09-13').length,0);
assert.equal(db.prepare('SELECT gclid FROM leads WHERE id=1').get().gclid,click);
assert.equal(JSON.parse(db.prepare('SELECT hidden_fields FROM leads WHERE id=1').get().hidden_fields).unrelated,'keep');
assert.equal(db.prepare('SELECT gclid FROM leads WHERE id=2').get().gclid,'already-saved');
assert.throws(()=>recovery.apply(db,plan),/changed after preview/);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_logs').get().n,1);
db.close();
console.log('PASS: capture precedence, campaign boundary, invalid IDs, braid separation, same-site referrer, safe/idempotent recovery.');

// Run the real route handlers, isolating every external service and database write.
async function checkRoute(file, routePath) {
  const handlers = new Map(), writes = [], webhooks = [], conversions = [];
  const router = {};
  for (const method of ['get','post','put','patch','delete']) router[method]=(url,...callbacks)=>handlers.set(method+' '+url,callbacks.at(-1));
  const db = {prepare(sql){return {
    get(){if(sql.includes('FROM landing_pages WHERE slug'))return {id:1,name:'Test',form_id:null,webhook_url:'https://webhook.test',traffic_source:'Google'};if(sql.includes('FROM postback_config'))return {conversion_action_id:'conversion-test'};return undefined;},
    run(...args){writes.push({sql,args});return {lastInsertRowid:123};},all(){return []}
  }}};
  const callbacks = [];
  const context = vm.createContext({
    module:{exports:{}},console:{log(){},error(message){throw new Error(message)}},process:{env:{}},URL,AbortSignal,
    setTimeout:fn=>callbacks.push(fn),setInterval:()=>{},clearTimeout:()=>{},
    fetch:async(url,options)=>{assert.equal(url,'https://webhook.test');webhooks.push(JSON.parse(options.body));return {status:200};},
    require(name){
      if(name==='express')return {Router:()=>router}; if(name==='../database')return db;
      if(name==='./auth')return {authenticateToken(){}};
      if(name==='../lib/timezone')return {getConfiguredTimezone:()=> 'America/New_York'};
      if(name==='../lib/google-click-ids')return ids;
      if(name==='../lib/ab-tests')return {convert(){}};
      if(name==='./google-ads')return {uploadConversion:async(...args)=>{conversions.push(args);return {success:true}}};
      if(['./settings','./notifications','./facebook','./bing-ads','./salesforce'].includes(name))return {};
      throw new Error('Unexpected import: '+name);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root,'server/routes',file),'utf8'),context);
  callbacks.forEach(fn=>fn());
  const body = {landing_page_slug:'mca-debt',first_name:'Test',last_name:'Example',company_name:'Example',email:'test@example.test',phone:'2025550143',eli_clickid:'eli_test',gclid:'',page_url:pageUrl,rt_clickid:'existing-redtrack'};
  const req = {body,headers:{},cookies:{},get:()=> 'info.coastaldebt.com',ip:'127.0.0.1'};
  let response;
  await handlers.get('post '+routePath)(req,{json(value){response=value},status(code){throw new Error('HTTP '+code)}});
  assert.equal(response.success,true);
  if(file==='leads.js') {
    const lead = writes.find(row=>row.sql.includes('INSERT INTO leads'));
    assert.equal(lead.args[13],click);
    const hidden = JSON.parse(lead.args[19]); assert.equal(hidden.gbraid,'braid-test'); assert.equal(hidden.gclid_capture_source,'google_ref_id');
    assert.equal(webhooks.length,1); assert.equal(webhooks[0].gclid,click); assert.equal(webhooks[0].wbraid,'web-braid-test');
    assert.equal(conversions[0][0],click);
    assert.equal(writes.find(row=>row.sql.includes('INSERT INTO conversion_events')).args[2],click);
  } else assert.equal(writes.find(row=>row.sql.includes('INSERT INTO visitors')).args[1],click);
}
Promise.resolve().then(()=>checkRoute('leads.js','/')).then(()=>checkRoute('visitors.js','/track')).then(()=>{
  console.log('PASS: real lead/visitor handlers receive the recovered GCLID; lead storage, webhook and conversion upload use it.');
}).catch(error=>{console.error(error);process.exitCode=1;});
