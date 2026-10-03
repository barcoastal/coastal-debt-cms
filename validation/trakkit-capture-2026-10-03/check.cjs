// Isolated browser regression checks. Every request is fulfilled locally or aborted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

(async () => {
  const browser = await chromium.launch({headless:true, channel:'chrome'});
  try {
    const templates = fs.readdirSync(path.join(root, 'templates')).filter(file =>
      read('templates/' + file).includes('function ownTkclid()'));
    assert.equal(templates.length, 15);
    let checks = 0;
    const cases = [
      {name:'SDK with blocked cookies', sdk:'sdk-id', cookie:'', expected:'sdk-id'},
      {name:'cookie fallback', cookie:'tkclid=cookie-id', expected:'cookie-id'},
      {name:'SDK error with cookie fallback', sdkError:true, cookie:'tkclid=cookie-id', expected:'cookie-id'},
      {name:'keep previously captured value', cookie:'', existing:'saved-id', expected:'saved-id'},
      {name:'unavailable tracker never invents an ID', cookie:'', expected:''},
      {name:'late tracker response', cookie:'', late:'late-id', expected:'late-id'},
      {name:'dynamic form and programmatic FormData', cookie:'', sdk:'dynamic-id', dynamic:true, expected:'dynamic-id'},
      {name:'storage exceptions do not break submissions', cookieError:true, storeError:true, expected:''}
    ];
    for (const file of templates) {
      const html = read('templates/' + file);
      const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .find(m => m[1].includes('function ownTkclid()'))[1];
      for (const scenario of cases) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => route.request().resourceType() === 'document'
          ? route.fulfill({contentType:'text/html',body:'<form id="hero"><button>Send</button></form><form id="bottom"><button>Send</button></form><form id="search" action="/search"></form>'})
          : route.abort());
        await page.goto('https://capture.test/?tkclid=referral-id');
        await page.evaluate(s => {
          Object.defineProperty(document, 'cookie', {configurable:true, get(){if(s.cookieError) throw Error('Cookie denied');return s.cookie || '';},set(){}});
          if (s.storeError) Object.defineProperty(window, 'localStorage', {get(){throw Error('Storage denied');}});
          if (s.sdk || s.sdkError) window.trakkit = {getClickId(){if(s.sdkError) throw Error('SDK failed'); return s.sdk;}};
          if (s.existing) document.querySelector('#hero').insertAdjacentHTML('beforeend','<input type="hidden" name="tkclid" value="'+s.existing+'">');
        }, scenario);
        await page.addScriptTag({content:script});
        assert.equal(await page.locator('#hero input[name="tkclid"]').count(), 1, file + ': field exists before tracker response');
        assert.equal(await page.locator('#search input').count(), 0);
        const result = await page.evaluate(s => {
          if (s.late) window.trakkit = {getClickId:()=>s.late};
          const form = s.dynamic ? document.body.appendChild(document.createElement('form')) : document.querySelector('#hero');
          if (s.dynamic) return Object.fromEntries(new FormData(form));
          let result;
          form.addEventListener('submit', e => {e.preventDefault();result=Object.fromEntries(new FormData(form));});
          form.requestSubmit();
          return result;
        }, scenario);
        assert.equal(result.tkclid || '', scenario.expected, file + ': ' + scenario.name);
        assert.equal(result.affiliate_tkclid, 'referral-id', 'Referral ID remains separate');
        assert.deepEqual(errors, []);
        checks++;
        await context.close();
      }
    }
    console.log(`PASS: ${checks} browser checks across ${templates.length} capture blocks.`);

    // Exercise the full shared Join3/Join4 submit handler with cookies unavailable.
    for (const template of ['join3','join4']) {
      const html = read(`validation/${template}-2026-09-${template === 'join3' ? '24' : '29'}/preview/index.html`);
      const context = await browser.newContext();
      const page = await context.newPage();
      const leads = [];
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        Object.defineProperty(document, 'cookie', {get:()=>'',set(){}});
        window.trakkit = {getClickId:()=> 'memory-only-id'};
      });
      await page.route('**/*', route => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.hostname !== 'capture.test') return route.abort();
        if (req.method() === 'POST') {
          if (url.pathname === '/api/leads') leads.push(req.postDataJSON());
          return route.fulfill({json:{success:true}});
        }
        if (url.pathname.endsWith('/join3.js')) return route.fulfill({contentType:'text/javascript',body:read('public/assets/join3.js')});
        if (url.pathname === '/api/visitors/ip') return route.fulfill({json:{ip:'127.0.0.1'}});
        if (req.resourceType() === 'document') return route.fulfill({contentType:'text/html',body:html});
        return route.abort();
      });
      await page.goto('https://capture.test/lp/' + template + '/?tkclid=referral-id');
      await page.selectOption('#debtSelect', {label:'$50,000 - $100,000'});
      if (await page.locator('#debtContinue').count()) await page.click('#debtContinue');
      await page.check('input[name="_qualificationMca"][value="Yes"]');
      for (const field of await page.locator('#dynamicFormFields input:not([type="hidden"])').all()) {
        const name = await field.getAttribute('name');
        await field.fill(name === 'email' ? 'capture-test@example.test' : name === 'phone' ? '2025550143' : 'Test');
      }
      await page.check('#consentCb');
      await page.click('#leadForm .submit-btn');
      await page.locator('#formSuccess:visible').waitFor();
      assert.equal(leads.length, 1);
      assert.equal(leads[0].tkclid, 'memory-only-id');
      assert.equal(leads[0].affiliate_tkclid, 'referral-id');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS: ${template} submits the in-memory ID exactly once, with affiliate attribution preserved.`);
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
