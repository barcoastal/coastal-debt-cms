// Exercise the real page routes and generator without starting workers or opening a database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'preview');
fs.mkdirSync(output, {recursive:true});
const routes = new Map();
const router = {};
for (const method of ['get','post','put','delete','patch']) router[method] = (url, ...handlers) => routes.set(method + ' ' + url, handlers.at(-1));
let page;
let assignedForm = null;
const db = { prepare(sql) { return {
  all() { return []; },
  get() {
    if (sql.includes('FROM landing_pages WHERE id')) return page ? {...page} : undefined;
    if (sql.includes('FROM forms WHERE id')) return assignedForm ? {...assignedForm} : undefined;
    return undefined;
  },
  run(...args) {
    if (sql.includes('INSERT INTO landing_pages')) {
      const keys = ['name','slug','platform','traffic_source','form_id','content','sections_visible','hidden_fields','template_type'];
      page = {id:1,is_active:1,ab_config:'{}',...Object.fromEntries(keys.map((key,i)=>[key,args[i]]))};
      return {lastInsertRowid:1};
    }
    if (sql.includes('UPDATE landing_pages SET')) {
      const keys = ['name','slug','platform','traffic_source','webhook_url','form_id','content','sections_visible','hidden_fields','is_active','template_type'];
      keys.forEach((key,i)=>page[key]=args[i]); return {changes:1};
    }
    throw new Error('Unexpected write: ' + sql);
  }
}; } };
const fakeFs = {...fs,
  existsSync(file) { if (String(file).includes('/public/uploads')) return true; return fs.existsSync(file); },
  mkdirSync(file) { assert.ok(String(file).startsWith(path.join(root,'public'))); },
  writeFileSync(file, data) { assert.equal(path.basename(file),'index.html'); fs.writeFileSync(path.join(output, 'index.html'),data); }
};
const multer = () => ({single:()=> (_req,_res,next)=>next()}); multer.diskStorage = value => value;
const moduleContext = {exports:{}};
const routeFile = path.join(root,'server/routes/pages.js');
const context = vm.createContext({
  module:moduleContext, exports:moduleContext.exports, __dirname:path.dirname(routeFile),
  require(name) {
    if (name==='express') return {Router:()=>router};
    if (name==='fs') return fakeFs;
    if (name==='path') return path;
    if (name==='multer') return multer;
    if (name==='../database') return db;
    if (name==='./auth') return {authenticateToken:()=>{}};
    if (name==='../templates/join5-content.json') return require(path.join(root,'server/templates/join5-content.json'));
    if (name==='../lib/phone-visibility') return require(path.join(root,'server/lib/phone-visibility'));
    if (name==='../templates/join3') return require(path.join(root,'server/templates/join3'));
    throw new Error('Unexpected import '+name);
  }, process:{env:{}}, console, setTimeout:()=>0, clearTimeout:()=>{}
});
vm.runInContext(fs.readFileSync(routeFile,'utf8'),context,{filename:routeFile});
function request(method, url, body={}) {
  let response;
  const res = {status(code){throw new Error('HTTP '+code);},json(data){response=data;}};
  routes.get(method+' '+url)({body,params:{id:'1'},user:{id:1,name:'Preview'},ip:'127.0.0.1'},res);
  return response;
}
request('post','/',{name:'Join Version 5 — Bankruptcy',slug:'bankruptcy-alternative-v5',template_type:'join5'});
assert.equal(page.template_type,'join5');
const readPreview=()=>fs.readFileSync(path.join(output,'index.html'),'utf8');
let generated=readPreview();
assert.ok(!/{{[^}]+}}/.test(generated),'all placeholders resolved');
assert.ok(generated.includes('JOIN4:HERO'));
assert.ok(generated.includes('Business Bankruptcy Questions? We Have Answers.'));
assert.ok(generated.includes('calcSlider'));
assert.ok(!generated.includes('heroFormSuccess'));
assert.equal((generated.match(/id="leadForm"/g)||[]).length,1);
const saved=JSON.parse(page.content);
const source=require('../../server/templates/join5-content.json');
assert.deepEqual(saved.eduSections,source.eduSections);
assert.deepEqual(saved.caseStudies,source.caseStudies);
request('put','/:id',{content:{...saved,headline:'Custom $& headline <safe>'},hidden_fields:{campaign_note:'join5-test'}});
generated=readPreview();
assert.ok(generated.includes('Custom $&amp; headline &lt;safe&gt;'));
assert.equal(request('get','/:id').template_type,'join5');
assert.ok(generated.includes('name="campaign_note" value="join5-test"'));
const hide=Object.fromEntries(['howItWorks','educational','calculator','comparison','caseStudies','personCta','testimonials','faq','cta','guide'].map(k=>[k,false]));
request('put','/:id',{content:saved,sections_visible:hide});
generated=readPreview();
assert.ok(!generated.includes('id="calcSlider"'));
fs.writeFileSync(path.join(output,'hidden.html'),generated);
assignedForm={fields:JSON.stringify([{name:'first_name',label:'First Name',type:'text',required:true},{name:'last_name',label:'Last Name',type:'text',required:true},{name:'company_name',label:'Business Name',type:'text',required:true},{name:'email',label:'Email',type:'email',required:true},{name:'phone',label:'Phone',type:'tel',required:true}]),skip_pre_qual:1,submit_button_text:'Get My Free Consultation',success_message:'An advisor will contact you.'};
request('put','/:id',{content:{...saved,formMode:'normal'},sections_visible:{},form_id:6,hidden_fields:{campaign_note:'join5-test'}});
generated=readPreview();
assert.ok(generated.includes('data-skip-prequal="false"'));
assert.ok(generated.includes('data-form-mode="prequalify"'));
for(const [,script] of generated.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(script.trim()&&!script.trim().startsWith('{'))new vm.Script(script);
const admin=fs.readFileSync(path.join(root,'admin/pages.html'),'utf8');
assert.equal((admin.match(/<option value="join5">/g)||[]).length,3);
for(const [,script] of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script.trim())new vm.Script(script);
console.log('PASS: Version 5 create/edit/read, reference content, V4 qualification, hidden sections, escaping and CMS selectors.');
