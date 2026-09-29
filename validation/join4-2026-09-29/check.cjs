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
request('post','/',{name:'Join Version 4',slug:'join4',template_type:'join4'});
assert.equal(page.template_type,'join4');
let generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(!/{{[^}]+}}/.test(generated),'all placeholders resolved');
assert.ok(generated.includes('Take control of your'));
assert.ok(generated.includes('cd-trustbar'));
assert.ok(!generated.includes('handleJoinSubmit'));
const saved = JSON.parse(page.content);
assert.ok(saved.j2ConsultTitle);
request('put','/:id',{content:{...saved,headline:'Custom $& headline <safe>',j2ConsultTitle:'Custom consultation'},hidden_fields:{campaign_note:'join4-test'}});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(generated.includes('Custom $&amp; headline &lt;safe&gt;'));
assert.ok(generated.includes('Custom consultation'));
assert.equal(request('get','/:id').template_type,'join4');
assert.ok(generated.includes('name="campaign_note" value="join4-test"'));
const v2 = fs.readFileSync(path.join(root,'templates/landing-page-join-v2.html'),'utf8');
const v4 = fs.readFileSync(path.join(root,'templates/landing-page-join4.html'),'utf8');
const blocks = [...v2.matchAll(/<!-- J2SECTION:([a-z0-9]+) -->[\s\S]*?<!-- \/J2SECTION:\1 -->/g)];
for (const block of blocks) assert.ok(v4.includes(block[0]), 'V2 section unchanged: '+block[1]);
const order = blocks.map(b=>b[1]).reverse();
request('put','/:id',{content:{...saved,j2SectionOrder:order}});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.deepEqual([...generated.matchAll(/<!-- J2SECTION:([a-z0-9]+) -->/g)].map(m=>m[1]),order);
assert.ok(generated.indexOf('JOIN4:HERO') < generated.indexOf('J2SECTION:'));
assignedForm = {fields:JSON.stringify([{name:'first_name',label:"Owner's first name",type:'text',required:true}]),skip_pre_qual:1,submit_button_text:'Request a call',success_message:'Your advisor will be in touch.'};
request('put','/:id',{content:{...saved,formMode:'normal'},form_id:99});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(generated.includes('data-skip-prequal="false"'));
assert.ok(generated.includes('data-form-mode="prequalify"'));
assert.ok(!generated.includes('data-form-mode="normal"'));
assert.ok(generated.includes('Request a call'));
assert.ok(generated.includes('Your advisor will be in touch.'));
assignedForm = null;
request('put','/:id',{content:saved,hidden_fields:{},form_id:null});

const admin = fs.readFileSync(path.join(root,'admin/pages.html'),'utf8');
assert.equal((admin.match(/<option value="join4">/g)||[]).length,3);
for(const [,script] of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(script.trim()) new vm.Script(script);
console.log('PASS: Join4 create/edit/read, hero escaping, V2 content, attribution fields, CMS selectors and admin syntax.');
