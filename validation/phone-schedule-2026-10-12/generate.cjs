// Exercise the real page routes and generator without starting workers or opening a database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const output = process.env.PHONE_PREVIEW_DIR || '/private/tmp/coastal-phone-schedule-20261012/generated';
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
  writeFileSync(file, data) { fs.writeFileSync(path.join(output, page.template_type + (path.basename(file)==='variant-b.html' ? '-variant-b' : '') + '.html'),data); }
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

const types = ['form', 'call', 'game', 'article', 'authority', 'leadgen', 'mca-variant', 'rich', 'pdf', 'pdf-v2', 'cobrand', 'join', 'join-v2', 'clickchoose', 'join3', 'join4', 'join5'];
for (const type of types) {
  request('post','/',{name:'Schedule preview '+type,slug:'phone-preview-'+type,template_type:type});
  request('put','/:id',{content:{...JSON.parse(page.content),phone:'(888) 555-0100'}});
  const html = fs.readFileSync(path.join(output,type+'.html'),'utf8');
  assert.equal((html.match(/id="coastal-phone-visibility"/g)||[]).length,1,type);
  assert.ok(html.indexOf('/api/phone-schedule/runtime.js') < html.indexOf('<body'), type+' early scheduling');
}
page.ab_config=JSON.stringify({enabled:true,variantB_template:'call'});
moduleContext.exports.generateLandingPage(1);
assert.ok(fs.readFileSync(path.join(output,'join5-variant-b.html'),'utf8').includes('/api/phone-schedule/runtime.js'));
console.log('PASS: phone scheduling injected into all 17 templates and template-level variant B.');
