const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {analyzeRun}=require('../../server/lib/ab-statistics');
const root=path.resolve(__dirname,'../..'), output='/private/tmp/coastal-ab-outcomes-preview';fs.mkdirSync(output,{recursive:true});
const now=Date.parse('2026-10-07T12:00:00Z');
const stats={visitors:100,leads:10,converted:10,rate:10};
const outcomes={A:{opportunities:1,closedWon:0,matched:10,leads:10,unmatched:0,repeated:0},B:{opportunities:5,closedWon:1,matched:9,leads:10,unmatched:1,repeated:1}};
let connected=true,stale=false;
(async()=>{const browser=await chromium.launch({headless:true,channel:'chrome'});try{
 const page=await browser.newPage({viewport:{width:1440,height:1200}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.hostname!=='ab-preview.test')return route.abort();
  if(url.pathname==='/api/ab-tests'){
   const historical=url.searchParams.get('source')==='historical';
   const run={id:historical?-1:1,page_id:18,name:'Google — business debt relief',slug:'mca-debt',template:'join-v2',b_name:'Join Version 4',config:{split:50},started_at:now-7*86400000,ended_at:null,source:historical?'historical':'live',stats:{A:stats,B:stats,U:stats},outcomes:historical?null:structuredClone(outcomes)};
   run.inference=analyzeRun(run,run.stats,now);
   if(!connected && run.outcomes)for(const o of Object.values(run.outcomes)){o.opportunities=null;o.closedWon=null;o.matched=0;o.unmatched=10;}
   return route.fulfill({json:{runs:[run],selectedId:run.id,source:url.searchParams.get('source')||'active',timezone:'America/New_York',today:'2026-10-07',from:'',to:'',activeCount:1,endedCount:0,historicalCount:1,
    outcomeSync:{connected,available:connected,lastSuccess:now,stale},daily:[{date:'2026-10-01',A:{...stats,outcomes:run.outcomes?.A},B:{...stats,outcomes:run.outcomes?.B}}],recent:[{lead_id:100,variant:'B',first_seen:now,created_at:now,outcome:{state:'matched',opportunity:1,closed_won:1}}]}});
  }
  if(url.pathname==='/api/auth/me')return route.fulfill({json:{name:'Preview',email:'preview@example.test'}});
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{timezone:'America/New_York',pages:[]}});
  const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+'/admin/')||!fs.existsSync(file))return route.abort();
  return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
 });
 await page.goto('https://ab-preview.test/admin/ab-tests.html');await page.locator('#report[aria-busy="false"]').waitFor();
 assert.equal(await page.locator('#oppTotal').innerText(),'6');assert.equal(await page.locator('#wonTotal').innerText(),'1');
 assert.match(await page.locator('.ab-business').innerText(),/9 of 10 submissions matched/);
 await page.screenshot({path:output+'/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'View results for Google — business debt relief',exact:true}).click();
 await page.locator('#runDetail:visible').waitFor();assert.equal(await page.locator('.ab-variant-sales').count(),2);
 assert.match(await page.locator('#leadsBody').innerText(),/Closed Won/);
 const downloadPromise=page.waitForEvent('download');await page.click('#exportResults');const dl=await downloadPromise;await dl.saveAs(output+'/results.csv');
 const csv=fs.readFileSync(output+'/results.csv','utf8');assert.match(csv,/"Opportunities","Closed Won","Matched submissions"/);assert.match(csv,/,"5","1","9","1",/);
 await page.screenshot({path:output+'/detail.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:output+'/mobile-detail.png',fullPage:true});await page.click('#backToTests');await page.locator('#overview:visible').waitFor();
 await page.screenshot({path:output+'/mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 stale=true;await page.click('#refresh');await page.locator('#report[aria-busy="false"]').waitFor();assert.match(await page.locator('#outcomeSync').innerText(),/delayed/);
 connected=false;await page.click('#refresh');await page.locator('#report[aria-busy="false"]').waitFor();assert.equal(await page.locator('#oppTotal').innerText(),'—');
 assert.match(await page.locator('#outcomeSync').innerText(),/not configured/);
 await page.click('[data-view="historical"]');await page.locator('#report[aria-busy="false"]').waitFor();assert.equal(await page.locator('.ab-business').count(),0);assert.ok(await page.locator('#outcomeSync').isHidden());
 assert.deepEqual(errors,[]);console.log('PASS: A/B sales counts, matched/unmatched coverage, detail and lead outcome, CSV values, mobile overflow, delayed/disconnected/historical states; no browser errors.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
