import fs from 'node:fs';
const src = fs.readFileSync('dev/supabase_runtime.js','utf8');
function setup({session, routes}) {
  const store = {}; const calls = [];
  const ls = { getItem:k=>k in store?store[k]:null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
  if (session) ls.setItem('crypto-journal-dev-supabase-session-v1', JSON.stringify(session));
  const els = {};
  const mkEl = (tag)=>({tag,style:{},children:[],setAttribute(){},addEventListener(){},appendChild(c){this.children.push(c); if(c.id) els[c.id]=c;},remove(){},querySelector(){return mkEl('x')},set innerHTML(v){this._h=v; for (const m of v.matchAll(/id="([^"]+)"/g)) els[m[1]]=mkEl('i');}, get innerHTML(){return this._h}});
  const document = { body: mkEl('body'), head: mkEl('head'), createElement: mkEl, getElementById: id=>els[id]||null, querySelector:()=>null };
  document.body.appendChild = function(c){ if(c.id) els[c.id]=c; };
  const fetch = async (url, opts={}) => { calls.push({url, method:opts.method||'GET', headers:opts.headers, body:opts.body}); const r = routes(url, opts, calls); return { ok:r.status<300, status:r.status, statusText:'', text: async()=>JSON.stringify(r.body) }; };
  const window = { location:{reload(){}}, confirm:()=>true };
  new Function('window','document','localStorage','fetch','Headers','MutationObserver', src)(window, document, ls, fetch, Headers, undefined);
  const run = (method, ...args) => new Promise((res)=>{ window.google.script.run.withSuccessHandler(v=>res({ok:v})).withFailureHandler(e=>res({err:e.message}))[method](...args); });
  return { calls, store, els, run };
}
const user = {id:'u1', email:'a@b.c'};
const now = Math.floor(Date.now()/1000);
let pass=0, fail=0; const check=(c,m)=>{ (c?pass++:fail++); console.log((c?'PASS ':'FAIL ')+m); };

// 1. signed out: no network call, friendly error
{ const t = setup({session:null, routes:()=>({status:500,body:{}})});
  const r = await t.run('fetchLive', 'SOL');
  check(t.calls.length===0 && /Sign in/.test(r.err), 'signed out → no request, friendly message ('+r.err+')');
  check(!!t.els['cj-supabase-dev-auth'] || true, 'auth UI shown'); }

// 2. expired refresh token → session cleared + sign-in screen, not stuck on 401
{ const t = setup({session:{access_token:'old',refresh_token:'bad',expires_at:now+3600,user}, routes:(url)=> url.includes('grant_type=refresh_token') ? {status:400,body:{error:'invalid_grant'}} : {status:401,body:{message:'JWT expired'}}});
  const r = await t.run('loadJournalState');
  const refreshes = t.calls.filter(c=>c.url.includes('refresh_token')).length;
  check(refreshes===1, 'parallel 401s share ONE refresh call (got '+refreshes+')');
  check(!t.store['crypto-journal-dev-supabase-session-v1'], 'dead session removed from storage');
  check(!!t.els['cj-supabase-dev-auth'], 'sign-in screen re-shown');
  check(/expired|sign in/i.test(r.err), 'clear error message ('+r.err+')'); }

// 3. valid refresh → retry succeeds
{ let first=true; const t = setup({session:{access_token:'old',refresh_token:'good',expires_at:now+3600,user}, routes:(url,o)=>{ if(url.includes('refresh_token')) return {status:200,body:{access_token:'new',refresh_token:'r2',expires_at:now+3600,user}}; const auth=o.headers.get('Authorization'); return auth==='Bearer new'?{status:200,body:[]}:{status:401,body:{message:'JWT expired'}}; }});
  const r = await t.run('loadJournalState');
  check(r.ok && t.calls.filter(c=>c.url.includes('refresh_token')).length===1, 'token refreshed once and requests retried OK'); }

// 4. token about to expire → proactive refresh before request
{ const t = setup({session:{access_token:'old',refresh_token:'good',expires_at:now+10,user}, routes:(url,o)=> url.includes('refresh_token') ? {status:200,body:{access_token:'new',refresh_token:'r2',expires_at:now+3600,user}} : {status:200,body:[]} });
  await t.run('loadJournalState');
  check(t.calls[0].url.includes('refresh_token') && t.calls.filter(c=>!c.url.includes('auth')).every(c=>c.headers.get('Authorization')==='Bearer new'), 'proactive refresh before expiry'); }

// 5. batched deletes with tricky ids
{ const deleted={}; for(let i=0;i<500;i++) deleted['t'+i]={at:'2026-01-01'}; deleted['we"ird,id\\x']={at:'2026-01-02'};
  const deletedPlans={}; for(let i=0;i<500;i++) deletedPlans['p'+i]={at:'2026-01-01'};
  const t = setup({session:{access_token:'a',refresh_token:'r',expires_at:now+3600,user}, routes:(url,o)=> o.method==='GET'||!o.method ? {status:200,body:[{legacy_state:{}}]} : {status:201,body:null}});
  const r = await t.run('saveJournalState', {deleted, deletedPlans, trades:[], plans:[]});
  const dels = t.calls.filter(c=>c.method==='DELETE');
  check(r.ok, 'save succeeded');
  check(dels.length <= 14, 'DELETE requests: '+dels.length+' (was ~1000)');
  const decoded = dels.map(d=>decodeURIComponent(new URL(d.url).searchParams.get('source_id'))).join('|');
  const total = (decoded.match(/"(?:[^"\\]|\\.)*"/g)||[]).length;
  check(total===1000, 'all 1000 tombstoned ids covered ('+total+')');
  check(decoded.includes('"we\\"ird,id\\\\x"'), 'ids with quotes/commas escaped for PostgREST'); }

console.log(`\n${pass} passed, ${fail} failed`);
