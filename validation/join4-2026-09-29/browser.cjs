process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY='1';
const {chromium}=require('playwright');
const fs=require('fs');
(async()=>{
const browser=await chromium.launch({headless:true,channel:"chrome"});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{
 const req=route.request();
 // Only the isolated preview may receive form submissions or tracking.
 if(req.method()!=='GET'&&!req.url().startsWith('http://localhost:3098/'))return route.abort();
 if(/googletagmanager|google-analytics|facebook.net|tiktok|uniclick|retreaver|trakkit|clarity.ms/.test(req.url()))return route.abort();
 return route.continue();
});
await page.goto('http://localhost:3098/lp/join4/',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(2500);
await page.screenshot({path:__dirname+'/preview/desktop.png',fullPage:true});
console.log('desktop',await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,forms:document.querySelectorAll('#leadForm').length,hero:document.querySelector('#join4-hero').getBoundingClientRect().toJSON(),errors:[]})));
await page.selectOption('#debtSelect',{label:'$50,000 - $100,000'});
await page.check('input[name="_qualificationMca"][value="Yes"]');
console.log('fields',await page.locator('#dynamicFormFields input').evaluateAll(els=>els.map(e=>({name:e.name,type:e.type,required:e.required}))));
for(const field of await page.locator('#dynamicFormFields input').all()){
 const name=await field.getAttribute('name');
 await field.fill(name==='email'?'join4-test@example.com':name==='phone'?'2025550143':'Preview');
}
await page.check('#consentCb');
await page.click('#leadForm .submit-btn');
await page.locator('#formSuccess:visible').waitFor();
console.log('form success');
await page.setViewportSize({width:390,height:844});
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(2500);
await page.screenshot({path:__dirname+'/preview/mobile.png',fullPage:true});
console.log('mobile',await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,hero:document.querySelector('#join4-hero').getBoundingClientRect().toJSON()})));
await page.click('#debtPickerTrigger');
await page.screenshot({path:__dirname+'/preview/mobile-debt-picker.png',fullPage:false});
const bounds = await page.locator('#debtPickerOptions').boundingBox();
if (!bounds || bounds.width < 250 || bounds.x < 0 || bounds.x + bounds.width > 390) throw new Error('Mobile picker dimensions invalid');
await page.getByRole('option', {name:'Under $20,000',exact:true}).click();
await page.locator('#debtNotice:visible').waitFor();
await page.click('#debtPickerTrigger');
await page.getByRole('option', {name:'$50,000 - $100,000',exact:true}).click();
await page.locator('[data-step="2"]:visible').waitFor();
await page.click('[data-back="1"]');
if ((await page.locator('#debtPickerTrigger').textContent()) !== 'Select your debt amount') throw new Error('Picker did not reset');
console.log('PASS: mobile picker sizing, qualification and back navigation');
console.log('errors',errors);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
