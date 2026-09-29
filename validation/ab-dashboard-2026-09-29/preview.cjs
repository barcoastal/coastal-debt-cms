// Isolated UI fixtures: in-memory database, no production imports or integrations.
const express=require('express');
const Database=require('better-sqlite3');
const path=require('node:path');
const {createStore}=require('../../server/lib/ab-store');
const db=new Database(':memory:');
db.exec(`CREATE TABLE landing_pages(id INTEGER PRIMARY KEY,name TEXT,slug TEXT,template_type TEXT,ab_config TEXT); CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings VALUES ('timezone','America/New_York');`);
const page=(id,name,slug,cfg)=>db.prepare('INSERT OR REPLACE INTO landing_pages VALUES (?,?,?,?,?)').run(id,name,slug,'join3',JSON.stringify(cfg));
page(1,'Business Debt Relief','business-debt-relief',{enabled:true,split:50,variantB_page:2});
page(2,'Facebook Open Lead','facebook-open-lead',{});
page(3,'Join3 · Coastal Assessment','join3',{enabled:true,split:50,variantB:{headline:'Explore your options'}});
let time=Date.parse('2026-09-21T12:00:00Z'),lead=100;
const store=createStore(db,()=>time);store.syncAll();
function seed(id,days){const p=db.prepare('SELECT * FROM landing_pages WHERE id=?').get(id);const run=store.sync(p);for(let d=0;d<days;d++){time+=86400000;for(let i=0;i<40+d*7;i++){const variant=i%5===0?'A':'B';const s=store.assign(run,null,variant);store.expose(s.token);if(i%7===0 || (variant==='B'&&i%11===0)){const req={cookies:{['ab_session_'+id]:s.token},get:k=>({host:'localhost:3098',referer:'http://localhost:3098/lp/'+p.slug+'/'})[k]};store.convert(req,lead++,variant==='B'&&id===1?2:id);}}}}
seed(1,3);page(1,'Business Debt Relief','business-debt-relief',{enabled:true,split:80,variantB_page:2});store.syncAll();seed(1,3);
time=Date.parse('2026-09-22T12:00:00Z');seed(3,5);page(3,'Join3 · Coastal Assessment','join3',{enabled:false});store.syncAll();
const app=express();app.use(express.json());app.use(require('cookie-parser')());
app.use('/admin',express.static(path.join(__dirname,'../../admin')));
app.get('/api/ab-tests',(req,res)=>{try{res.json(store.report(req.query));}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/auth/me',(req,res)=>res.json({name:'Design preview',email:'Local fixtures only'}));
app.get('/api/settings',(req,res)=>res.json({timezone:'America/New_York'}));
app.get('/api/pages',(req,res)=>res.json({pages:db.prepare('SELECT * FROM landing_pages').all()}));
app.listen(3098,'127.0.0.1',()=>console.log('Isolated A/B dashboard preview: http://127.0.0.1:3098/admin/ab-tests.html'));
