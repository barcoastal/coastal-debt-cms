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
request('post','/',{name:'Join3',slug:'join3',template_type:'join3'});
assert.equal(page.template_type,'join3');
let generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(!/{{[^}]+}}/.test(generated),'all placeholders resolved');
assert.ok(generated.includes('Take control of your'));
assert.ok(generated.includes('tel:8889615338'));
assert.ok(generated.includes('Coastal Debt Resolve'));
assert.ok(!generated.includes('Business Debt Insider'));
const saved = JSON.parse(page.content);
request('put','/:id',{template_type:'join3',content:{...saved,headline:'Custom $& headline <safe>',colors:{primary:'#123456'}},sections_visible:{faq:false},hidden_fields:{campaign_note:'preview-campaign'}});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(generated.includes('Custom $&amp; headline &lt;safe&gt;'));
assert.ok(generated.includes('--primary:#123456'));
assert.ok(!generated.includes('class="faq-list"'));
assert.ok(generated.includes('name="campaign_note" value="preview-campaign"'));
assert.equal(request('get','/:id').template_type,'join3');
// Assigned forms must preserve options, apostrophes and success text without breaking scripts.
assignedForm = {fields:JSON.stringify([{name:'first_name',label:"Owner's first name",type:'text',required:true},{name:'industry',label:'Industry',type:'select',options:'Retail,Services'}]),skip_pre_qual:1,submit_button_text:'Request a call',success_message:'Your advisor will be in touch.'};
request('put','/:id',{content:saved,sections_visible:{},form_id:99});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
assert.ok(generated.includes('data-skip-prequal="true"'));
assert.ok(generated.includes('Request a call'));
assert.ok(generated.includes('Your advisor will be in touch.'));
for(const [,script] of generated.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(script.trim()) new vm.Script(script);
// Restore the canonical default preview, with real generation and harmless local endpoints.
assignedForm = null;
request('put','/:id',{content:saved,form_id:null,hidden_fields:{}});
generated = fs.readFileSync(path.join(output,'index.html'),'utf8');
for(const [,script] of generated.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(script.trim()) new vm.Script(script);
const admin = fs.readFileSync(path.join(root,'admin/pages.html'),'utf8');
assert.equal((admin.match(/<option value="join3">/g)||[]).length,3);
for(const [,script] of admin.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) if(script.trim()) new vm.Script(script);
console.log('PASS: Join3 create/edit/read, generated HTML, content escaping, visibility, form assignment, and all three CMS selectors.');
