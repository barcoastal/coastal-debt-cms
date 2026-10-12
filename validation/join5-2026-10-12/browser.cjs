const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'/Users/baralezrah/coastal-debt-cms/node_modules/playwright');
const root=path.resolve(__dirname,'../..');
const output='/private/tmp/coastal-join5-20261012';
const click='01ARZ3NDEKTSV4RRFFQ69G5FAV';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  for(const scenario of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844},{name:'bottom',width:1440,height:1000},{name:'hidden',width:390,height:844}]){
   const context=await browser.newContext({viewport:{width:scenario.width,height:scenario.height}});
   const page=await context.newPage(),leads=[],errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(id=>{window._abVariant='B';window.trakkit={getClickId:()=>id}},click);
   await page.route('**/*',route=>{
    const req=route.request(),u=new URL(req.url());
    if(u.hostname!=='join5.test')return ['image','font','stylesheet'].includes(req.resourceType())?route.continue():route.abort();
    if(req.method()==='POST'){if(u.pathname==='/api/leads')leads.push(req.postDataJSON());return route.fulfill({json:{success:true}})}
    if(u.pathname==='/api/visitors/ip')return route.fulfill({json:{ip:'127.0.0.1'}});
    if(req.resourceType()==='document')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'preview',scenario.name==='hidden'?'hidden.html':'index.html'),'utf8')});
    const file=path.join(root,'public',u.pathname.replace(/^\/lp\//,''));
    if(fs.existsSync(file)&&fs.statSync(file).isFile())return route.fulfill({path:file});
    return route.abort();
   });
   await page.goto('https://join5.test/lp/bankruptcy-alternative-v5/?gclid=test-google&utm_source=Google&tkclid=referral-id',{waitUntil:'networkidle'});
   assert.deepEqual(errors,[],scenario.name+' initial errors');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),scenario.name+' overflow');
   assert.equal(await page.locator('#leadForm').count(),1);
   if(scenario.name!=='hidden'){
    assert.equal(await page.locator('#stepsGrid .step-card').count(),3);
    assert.ok(await page.locator('#casesGrid .case-card').count()>0);
    assert.ok(await page.locator('#compGrid .comp-card').count()===2);
    await page.locator('#calcSlider').fill('200000');await page.locator('#calcSlider').dispatchEvent('input');
    assert.ok((await page.locator('#calcAmountDisplay').innerText()).includes('200,000'));
    await page.locator('.faq-q').first().click();assert.equal(await page.locator('.faq-a').first().isVisible(),true);
   }
   await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:output+'/'+scenario.name+'.png'});
   if(scenario.name==='desktop'){
    await page.locator('#compGrid').scrollIntoViewIfNeeded();await page.screenshot({path:output+'/lower-sections.png'});await page.evaluate(()=>scrollTo(0,0));
   }
   if(scenario.name==='mobile'){
    const h=await page.locator('#join4-hero h1').boundingBox(),card=await page.locator('#assessment').boundingBox(),bullets=await page.locator('.hero-benefits').boundingBox();
    assert.ok(card.y>h.y && card.y<bullets.y,'mobile form follows heading before benefits');
   }
   if(scenario.name==='bottom'){
    for(const input of await page.locator('#bottomFormFields input:not([type="hidden"])').all()){
     const name=await input.getAttribute('name');await input.fill(name==='email'?'test@example.test':name==='phone'?'2025550143':'Example');
    }
    await page.check('#bottomConsentCheckbox');await page.click('#bottomLeadForm .submit-btn');
    await page.locator('#bottomFormSuccess:visible').waitFor();
   }else{
    if(scenario.width<760){await page.click('#debtPickerTrigger');await page.click('[role="option"][data-value="$50,000 - $100,000"]')}
    else await page.selectOption('#debtSelect',{label:'$50,000 - $100,000'});
    await page.click('#debtContinue');await page.check('input[name="_qualificationMca"][value="Yes"]');
    for(const input of await page.locator('#dynamicFormFields input:not([type="hidden"])').all()){
     const name=await input.getAttribute('name');await input.fill(name==='email'?'test@example.test':name==='phone'?'2025550143':'Example');
    }
    await page.check('#consentCb');await page.click('#leadForm .submit-btn');await page.locator('#formSuccess:visible').waitFor();
   }
   assert.equal(leads.length,1,scenario.name+' single submission');
   assert.equal(leads[0].tkclid,click);assert.equal(leads[0].affiliate_tkclid,'referral-id');
   assert.equal(leads[0].gclid,'test-google');assert.equal(leads[0].ab_variant,'B');
   assert.equal(leads[0].landing_page_slug,'bankruptcy-alternative-v5');
   assert.ok(leads[0].eli_clickid);assert.deepEqual(errors,[]);
   assert.equal(await page.locator('#leadForm').isVisible(),false);
   if(scenario.name!=='hidden')assert.equal(await page.locator('#bottomLeadForm').isVisible(),false);
   await context.close();console.log('PASS: '+scenario.name);
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
