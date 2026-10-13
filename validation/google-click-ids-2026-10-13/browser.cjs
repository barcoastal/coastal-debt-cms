const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/Users/baralezrah/coastal-debt-cms/node_modules/playwright');
const root = path.resolve(__dirname,'../..');
const generated = '/private/tmp/coastal-phone-schedule-20261012/generated';
const click = 'CjwKCAj-Test_GoogleClickID';
const query = '?cmpid=6855272ea2fde3e964e81fb6&ref_id='+click+'&sub9=g&gbraid=test-braid&wbraid=test-web-braid&tkclid=referral-id#assessment';

(async()=>{
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    for (const width of [1440,390]) for (const file of fs.readdirSync(generated).filter(file=>file.endsWith('.html')&&!file.includes('variant-b'))) {
      const context = await browser.newContext({viewport:{width,height:900}});
      const page = await context.newPage(), visitors = [], leads = [];
      await page.addInitScript(()=>{window._abVariant='B';window.trakkit={getClickId:()=> '01ARZ3NDEKTSV4RRFFQ69G5FAV'};});
      await page.route('**/*',route=>{
        const request=route.request(), url=new URL(request.url());
        if(url.hostname!=='capture.test')return route.abort();
        if(request.method()==='POST'){
          if(url.pathname==='/api/leads')leads.push(request.postDataJSON());
          if(url.pathname==='/api/visitors/track')visitors.push(request.postDataJSON());
          return route.fulfill({json:{success:true}});
        }
        if(request.resourceType()==='document')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(generated,file),'utf8')});
        if(url.pathname==='/api/phone-schedule/runtime.js')return route.fulfill({contentType:'text/javascript',body:'document.documentElement.dataset.coastalPhoneState="open";'});
        if(url.pathname==='/api/visitors/ip')return route.fulfill({json:{ip:'127.0.0.1'}});
        const local=path.join(root,'public',url.pathname.replace(/^\/lp\//,''));
        if(fs.existsSync(local)&&fs.statSync(local).isFile())return route.fulfill({path:local});
        return route.fulfill({json:{}});
      });
      await page.goto('https://capture.test/lp/'+file.replace('.html','')+'/'+query,{waitUntil:'load'});
      const url=new URL(page.url());
      assert.equal(url.searchParams.get('gclid'),click);assert.equal(url.searchParams.get('ref_id'),click);assert.equal(url.hash,'#assessment');
      const values=await page.locator('input[name=gclid],input#gclid').evaluateAll(inputs=>inputs.map(el=>el.value));
      if(file==='pdf-v2.html')assert.equal(await page.evaluate(()=>localStorage.getItem('cd_gclid')),click);
      else assert.ok(values.includes(click),file+' captured GCLID');
      if(visitors.length)assert.equal(visitors.at(-1).gclid,click,file+' visitor');
      if(file==='join4.html'){
        if(width<760){await page.click('#debtPickerTrigger');await page.click('[role="option"][data-value="$50,000 - $100,000"]');}
        else await page.selectOption('#debtSelect',{label:'$50,000 - $100,000'});
        await page.click('#debtContinue');await page.check('input[name="_qualificationMca"][value="Yes"]');
        for(const input of await page.locator('#dynamicFormFields input:not([type=hidden])').all()){
          const name=await input.getAttribute('name');await input.fill(name==='email'?'test@example.test':name==='phone'?'2025550143':'Example');
        }
        await page.check('#consentCb');await page.click('#leadForm .submit-btn');await page.locator('#formSuccess:visible').waitFor();
      }
      if(file==='join5.html'){
        for(const input of await page.locator('#bottomFormFields input:not([type=hidden])').all()){
          const name=await input.getAttribute('name');await input.fill(name==='email'?'test@example.test':name==='phone'?'2025550143':'Example');
        }
        await page.check('#bottomConsentCheckbox');await page.click('#bottomLeadForm .submit-btn');await page.locator('#bottomFormSuccess:visible').waitFor();
      }
      if(['join4.html','join5.html'].includes(file)){
        assert.equal(leads.length,1);assert.equal(leads[0].gclid,click);
        assert.equal(leads[0].tkclid,'01ARZ3NDEKTSV4RRFFQ69G5FAV');assert.equal(leads[0].affiliate_tkclid,'referral-id');assert.equal(leads[0].ab_variant,'B');
      }
      await context.close();console.log('PASS: '+file+' '+width+'px');
    }
    // Normalization only changes URLs from the known Google campaign.
    for(const test of [
      {suffix:'?ref_id=affiliate-id',expected:null},
      {suffix:'?cmpid=facebook&ref_id=facebook-id',expected:null},
      {suffix:'?gbraid=braid-only&wbraid=web-only',expected:null},
      {suffix:query.replace('#assessment','')+'&gclid=already-present',expected:'already-present'}
    ]){
      const page=await browser.newPage();
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:require('../../server/lib/google-click-ids').inject('<html><head></head><body></body></html>')}));
      await page.goto('https://capture.test/'+test.suffix);
      assert.equal(new URL(page.url()).searchParams.get('gclid'),test.expected);await page.close();
    }
    console.log('PASS: 34 template/viewport cases, hero and footer submissions, visitor capture, preserved A/B and Trakkit IDs, non-Google exclusion.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
