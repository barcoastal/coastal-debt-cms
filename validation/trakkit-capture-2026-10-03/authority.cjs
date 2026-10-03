// Run against a downloaded public Authority page. No request reaches a live endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const original = fs.readFileSync(process.argv[2], 'utf8');
const template = fs.readFileSync(path.join(root, 'templates/landing-page-authority.html'), 'utf8');
const scripts = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g;
const fixedBlock = [...template.matchAll(scripts)].find(m => m[0].includes('function ownTkclid()'))[0];
const fixed = original.replace(scripts, block => block.includes('function tkclidFromCookie()') || block.includes('function ownTkclid()') ? fixedBlock : block);

(async () => {
  const browser = await chromium.launch({headless:true,channel:'chrome'});
  try {
    for (const [version, html] of [['before',original],['after',fixed]]) {
      for (const formId of ['leadForm','bottomLeadForm']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const leads = [];
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.addInitScript(() => {
          Object.defineProperty(document,'cookie',{get:()=>'',set(){}});
          window.trakkit = {getClickId:()=> 'memory-only-id'};
        });
        await page.route('**/*', route => {
          const req=route.request(); const url=new URL(req.url());
          if(url.hostname!=='capture.test') return route.abort();
          if(req.method()==='POST') {
            if(url.pathname==='/api/leads') leads.push(req.postDataJSON());
            return route.fulfill({json:{success:true}});
          }
          if(req.resourceType()==='document') return route.fulfill({contentType:'text/html',body:html});
          if(url.pathname==='/api/visitors/ip') return route.fulfill({json:{ip:'127.0.0.1'}});
          return route.abort();
        });
        await page.goto('https://capture.test/lp/facebook-open-lead/?tkclid=referral-id');
        const form=page.locator('#'+formId);
        for(const field of await form.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])').all()) {
          const type=await field.getAttribute('type');
          await field.fill(type==='email'?'capture-test@example.test':type==='tel'?'2025550143':'Test');
        }
        for(const choice of await form.locator('input[type="radio"][value="Yes"]:visible').all()) await choice.check();
        for(const consent of await form.locator('input[type="checkbox"][required]').all()) await consent.check();
        await form.locator('.submit-btn').click();
        await page.waitForFunction(()=>document.querySelector('#heroFormSuccess').style.display==='block');
        assert.equal(leads.length,1);
        assert.equal(leads[0].tkclid || '',version==='before'?'':'memory-only-id');
        assert.equal(leads[0].affiliate_tkclid,'referral-id');
        assert.deepEqual(errors,[]);
        console.log(`PASS: Authority ${formId}, ${version}: ${version==='before'?'reproduced missing ID':'in-memory ID included once'}.`);
        await context.close();
      }
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
