const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || '/Users/baralezrah/coastal-debt-cms/node_modules/playwright');
const model = require('../../public/assets/phone-schedule');
const root = path.resolve(__dirname, '../..');
const output = '/private/tmp/coastal-phone-schedule-20261012';
const runtime = ['phone-schedule.js','phone-visibility.js'].map(file => fs.readFileSync(path.join(root,'public/assets',file),'utf8')).join('\n');
const payload = schedule => ({schedule, serverTime:Date.parse('2026-10-12T21:59:58Z')});
const phoneCount = page => page.locator('a[href^="tel:" i]:visible').count();
const formCount = page => page.locator('form input:not([type=hidden]):visible, form select:visible, form button:visible').count();
const settle = page => page.waitForFunction(() => ['open','closed'].includes(document.documentElement.dataset.coastalPhoneState));

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const generated = path.join(output,'generated');
    for (const width of [1440,390]) for (const file of fs.readdirSync(generated).filter(file => file.endsWith('.html'))) {
      let schedule = model.defaults();
      const context = await browser.newContext({viewport:{width,height:900}});
      const page = await context.newPage();
      const requests = [];
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname !== 'phone.test') return route.abort();
        if (request.method() !== 'GET') { requests.push(url.pathname); return route.fulfill({json:{success:true}}); }
        if (url.pathname === '/api/phone-schedule/runtime.js') return route.fulfill({contentType:'text/javascript',body:runtime+'\nstartCoastalPhoneVisibility('+JSON.stringify(payload(schedule))+');'});
        if (url.pathname === '/api/phone-schedule/public') return route.fulfill({json:payload(schedule)});
        if (request.resourceType() === 'document') return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(generated,file),'utf8')});
        const local = path.join(root,'public',url.pathname.replace(/^\/lp\//,''));
        if (fs.existsSync(local) && fs.statSync(local).isFile()) return route.fulfill({path:local});
        return route.fulfill({json:{}});
      });
      await page.goto('https://phone.test/lp/preview/',{waitUntil:'load'}); await settle(page);
      const openCount = await phoneCount(page), fields = await formCount(page);
      assert.ok(await page.locator('a[href^="tel:" i]').count()>0,file+' '+width+' has phone links');
      schedule.mode = 'hidden';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => document.documentElement.dataset.coastalPhoneState === 'closed');
      assert.equal(await phoneCount(page),0,file+' '+width+' closed phones');
      assert.equal(await formCount(page),fields,file+' '+width+' forms stay available');
      // Simulate a delayed call-tracking script replacing a number and adding a CTA.
      await page.evaluate(() => {
        const call = document.createElement('a');call.id='dynamic-test-call';call.href='TEL:8885550100';call.textContent='Call Now: 888-555-0100';document.body.appendChild(call);
      });
      assert.equal(await page.locator('#dynamic-test-call').isVisible(),false);
      await page.locator('#dynamic-test-call').evaluate(el => el.remove());
      schedule.mode = 'always';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => document.documentElement.dataset.coastalPhoneState === 'open');
      assert.equal(await phoneCount(page),openCount,file+' restores original visibility');
      schedule.mode = 'hidden';
      await page.reload({waitUntil:'load'}); await settle(page);
      assert.equal(await phoneCount(page),0,file+' hidden on initial load');
      assert.ok(!requests.includes('/api/leads'),'no lead submissions');
      await context.close();
      console.log('PASS: '+file+' at '+width+'px (show, hide, restore, dynamic phones, forms)');
    }

    // Open pages cross closing time without reloading, using the server clock.
    const context = await browser.newContext(); const page = await context.newPage();
    await page.clock.install({time:new Date('2030-01-01T00:00:00Z')});
    let scheduled = model.defaults(); scheduled.mode = 'scheduled';
    await page.route('**/*',route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/phone-schedule/runtime.js') return route.fulfill({contentType:'text/javascript',body:runtime+'\nstartCoastalPhoneVisibility('+JSON.stringify(payload(scheduled))+');'});
      return route.fulfill({contentType:'text/html',body:require('../../server/lib/phone-visibility')('<html><head></head><body><a href="tel:123">Call</a><div id="mobileStickyCtaBar"><a href="tel:123">Call</a><a href="#form">Form</a></div><form id="form"><input type="tel"></form></body></html>')});
    });
    await page.goto('https://clock.test/'); await settle(page); assert.equal(await phoneCount(page),2);
    await page.clock.fastForward(3000);
    assert.equal(await phoneCount(page),0,'closes at the schedule boundary despite wrong device clock');
    assert.equal(await page.locator('#mobileStickyCtaBar').isVisible(),true,'mixed mobile bar preserves form link');
    assert.equal(await page.locator('input[type=tel]').isVisible(),true);
    await context.close();
    console.log('PASS: automatic boundary switch, server clock, mixed mobile call/form bar.');

    // Exercise the actual admin UI with isolated API fixtures.
    let saved = model.defaults(), writes = 0, failSave = false;
    const adminContext = await browser.newContext({viewport:{width:1440,height:1100}});
    const admin = await adminContext.newPage();
    await admin.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname !== 'admin.test') return route.abort();
      if (url.pathname === '/api/phone-schedule') {
        if (request.method() === 'PUT') {
          if (failSave) return route.fulfill({status:500,json:{error:'Test save failed'}});
          saved = model.normalize(request.postDataJSON()); writes++;
        }
        return route.fulfill({json:payload(saved)});
      }
      if (url.pathname === '/api/auth/me') return route.fulfill({json:{id:1,name:'Admin',email:'admin@example.test',role:'admin'}});
      if (url.pathname.startsWith('/api/')) return route.fulfill({json:{}});
      const local = url.pathname.startsWith('/admin/') ? path.join(root,url.pathname) : path.join(root,'public',url.pathname);
      if (fs.existsSync(local) && fs.statSync(local).isFile()) return route.fulfill({path:local});
      return route.abort();
    });
    await admin.goto('https://admin.test/admin/platform-settings.html#phone');
    await admin.locator('#tab-phone.active').waitFor();
    assert.equal(await admin.locator('#phoneScheduleMode').inputValue(),'always');
    await admin.selectOption('#phoneScheduleMode','scheduled');
    await admin.selectOption('#phoneScheduleTimezone','America/Chicago');
    await admin.fill('#phone-mon-start','10:00'); await admin.fill('#phone-mon-end','19:00');
    await admin.selectOption('#phone-sat-mode','all-day');
    await admin.fill('#phone-fri-start','22:00'); await admin.fill('#phone-fri-end','02:00');
    assert.match(await admin.locator('#phone-fri-overnight').innerText(),/next day/);
    await admin.click('#phoneScheduleSave');
    await admin.waitForFunction(() => document.getElementById('phoneScheduleMessage').textContent.startsWith('Saved'));
    assert.equal(writes,1); assert.equal(saved.timezone,'America/Chicago'); assert.equal(saved.days.mon.start,'10:00');
    await admin.reload(); await admin.locator('#tab-phone.active').waitFor();
    assert.equal(await admin.locator('#phone-mon-start').inputValue(),'10:00');
    assert.equal(await admin.locator('#phone-sat-mode').inputValue(),'all-day');
    await admin.waitForFunction(() => getComputedStyle(document.querySelector('[onclick="switchTab(\'phone\')"]')).color === 'rgb(48, 82, 255)');
    await admin.screenshot({path:path.join(output,'admin-desktop.png'),fullPage:true});
    await admin.setViewportSize({width:390,height:844});
    assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth),'admin mobile overflow');
    await admin.screenshot({path:path.join(output,'admin-mobile.png')});
    await admin.locator('#phone-mon-mode').scrollIntoViewIfNeeded();
    await admin.screenshot({path:path.join(output,'admin-mobile-hours.png')});
    await admin.locator('#phoneScheduleSave').scrollIntoViewIfNeeded();
    await admin.screenshot({path:path.join(output,'admin-mobile-save.png')});
    failSave = true; await admin.selectOption('#phoneScheduleMode','hidden'); await admin.click('#phoneScheduleSave');
    await admin.locator('#phoneScheduleMessage[data-error=true]').waitFor();
    assert.equal(saved.mode,'scheduled','failed save preserves existing schedule');
    failSave = false; await admin.click('#phoneScheduleSave');
    await admin.waitForFunction(() => document.getElementById('phoneScheduleMessage').textContent.startsWith('Saved'));
    assert.equal(saved.mode,'hidden');
    await adminContext.close();
    console.log('PASS: editable admin days, timezone, overnight, save/reload, hide override, failed-save feedback and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
