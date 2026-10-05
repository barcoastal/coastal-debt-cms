// Isolated dashboard UI: real HTML/CSS/JS, synthetic API results, no live requests.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {analyzeRun}=require('../../server/lib/ab-statistics');
const root=path.resolve(__dirname,'../..');
const output=process.env.AB_SCREENSHOTS || '/private/tmp/coastal-ab-statistics-20261005';
fs.mkdirSync(output,{recursive:true});
const now=Date.parse('2026-10-05T12:00:00Z');
const variant=(visitors,converted,leads=converted)=>({visitors,converted,leads,rate:visitors?converted/visitors*100:0});
function make(id,name,slug,a,b,days,split=50) {
  const run={id,page_id:id,name,slug,template:'authority',b_name:'Coastal assessment',config:{split},started_at:now-days*86400000,ended_at:null,source:'live',stats:{A:a,B:b}};
  run.inference=analyzeRun(run,run.stats,now); return run;
}
const active=[
  make(1,'Google (old design)','mca-debt',variant(63,4),variant(56,7,8),4),
  make(2,'MCA Consolidation LP','mca-consolidation',variant(200,20),variant(200,50),9),
  make(3,'Facebook','fb-social',variant(0,0),variant(0,0),6),
  make(4,'MCA Debt Relief - Facebook','restructure-mca-business-loans-now-social',variant(126,7),variant(460,32),6,80)
];
const ended=make(5,'Ended assessment','ended',variant(1000,100),variant(1000,101),10);
ended.ended_at=now-86400000;ended.inference=analyzeRun(ended,ended.stats,now);
const historical={...active[0],id:-1,source:'historical',ended_at:now-10*86400000};
delete historical.inference;
historical.stats={A:{...variant(60,0,5),rate:8.33,taggedLeads:5},B:{...variant(90,0,10),rate:11.11,taggedLeads:10},U:variant(0,0)};

(async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      const req=route.request();const url=new URL(req.url());
      if(url.hostname!=='ab-preview.test'||req.method()!=='GET')return route.abort();
      if(url.pathname==='/api/ab-tests') {
        const source=url.searchParams.get('source')||'active';
        const runs=structuredClone(source==='ended'?[ended]:source==='historical'?[historical]:active);
        if(url.searchParams.get('from'))for(const r of runs)r.stats={A:variant(0,0),B:variant(0,0),U:variant(0,0)};
        const selected=runs.find(r=>r.id===Number(url.searchParams.get('run')))||runs[0];
        return route.fulfill({json:{runs,selectedId:selected.id,daily:[],recent:[],source,timezone:'America/New_York',today:'2026-10-05',from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||'',activeCount:4,endedCount:1,historicalCount:1,trackingSince:now-10*86400000}});
      }
      if(url.pathname==='/api/auth/me')return route.fulfill({json:{name:'Preview',email:'preview@example.test'}});
      if(url.pathname.startsWith('/api/'))return route.fulfill({json:{timezone:'America/New_York',pages:[]}});
      const file=path.resolve(root,'.'+url.pathname);
      if(!file.startsWith(root+'/admin/')||!fs.existsSync(file))return route.abort();
      const type=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
      return route.fulfill({contentType:type,body:fs.readFileSync(file)});
    });
    await page.goto('https://ab-preview.test/admin/ab-tests.html');
    await page.locator('#report[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('.ab-test-card').count(),4);
    assert.equal(await page.locator('.ab-test-card .is-winner').count(),1);
    assert.match(await page.locator('.ab-test-card').first().innerText(),/Collecting data/);
    assert.match(await page.locator('.ab-test-card').first().innerText(),/86.98|87.0%/);
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'View results for MCA Consolidation LP',exact:true}).click();
    await page.locator('#statisticalVerdict .is-winner').waitFor();
    assert.equal(await page.locator('.ab-model-checks .met').count(),4);
    assert.match(await page.locator('#statisticalVerdict').innerText(),/20 \/ 200/);
    await page.selectOption('#datePreset','today');
    await page.locator('#report[aria-busy="false"]').waitFor();
    assert.match(await page.locator('#statisticalVerdict').innerText(),/Variant B is winning/);
    assert.match(await page.locator('#statisticalVerdict').innerText(),/20 \/ 200/);
    assert.match(await page.locator('#variantCards').innerText(),/0/);
    const downloaded=page.waitForEvent('download');
    await page.click('#exportResults');
    const download=await downloaded;
    await download.saveAs(path.join(output,'results.csv'));
    assert.match(fs.readFileSync(path.join(output,'results.csv'),'utf8'),/"beta-binomial-v1","full_run","winner","B"/);
    await page.selectOption('#datePreset','all');
    await page.locator('#report[aria-busy="false"]').waitFor();
    await page.screenshot({path:path.join(output,'detail.png'),fullPage:true});
    await page.click('#backToTests');
    await page.locator('#overview:visible').waitFor();
    await page.click('[data-view="ended"]');
    await page.locator('.ab-test-card .is-inconclusive').waitFor();
    await page.click('[data-view="historical"]');
    await page.locator('.ab-test-card .is-unavailable').waitFor();
    assert.match(await page.locator('.ab-test-card').innerText(),/Historical estimates only/);
    await page.click('[data-view="active"]');
    await page.locator('.ab-test-card .is-winner').waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile has no horizontal overflow');
    await page.getByRole('button',{name:'View results for MCA Consolidation LP',exact:true}).click();
    await page.locator('#statisticalVerdict .is-winner').waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile detail has no horizontal overflow');
    await page.screenshot({path:path.join(output,'mobile-detail.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    console.log('PASS: card verdicts, full-run detail, minimum checks, date filters, CSV model metadata, ended/historical states, mobile layouts, and no browser errors.');
    console.log('Screenshots: '+output);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
