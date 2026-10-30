import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const A={host:'a.test',subdomains:false,purpose:'study',version:1};
async function harness(enabled=true,withGrant=false){
 const source=(await readFile(new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8')).replace(/^(?:import|export) .*;\n/gm,'');
 const local:Record<string,any>={sitePolicyRevision:1,...(enabled?{sitePolicy:A}:{})};let dynamic=enabled?'a.test':'',guard=enabled?'a.test':'',fault='',interrupt='';
 let context:any,listeners:Record<string,Function>={};
 let session:any=withGrant?{blockingGrants:{8:{resource:'https://a.test/lesson',expires:Date.now()+60000,version:1}}}:{};
 let authority=withGrant;const dynamicRemovals:number[][]=[];let recoveryAlarms=0;
 let tabs:any[]=[];let reloadFault='',reloads=0;
 const boundary=(name:string)=>{if(fault===`clear-${name}`){fault='';delete local.sitePolicy;delete local.sitePolicyRevision;listeners.storage({sitePolicy:{oldValue:A}},'local');}if(fault===name || fault===`${name}-always`){if(fault===name)fault='';throw Error(name);}if(interrupt===name) return new Promise<void>(()=>{});};
 const event=(name:string)=>({addListener:(fn:Function)=>listeners[name]=fn});
 const chrome:any={runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},permissions:{contains:async()=>true},
 storage:{local:{get:async()=>structuredClone(local),set:async(v:any)=>{await boundary(v.sitePolicy?.pending?'journal':'commit');Object.assign(local,structuredClone(v));},remove:async(k:string)=>{await boundary('remove');delete local[k];}},session:{get:async()=>structuredClone(session),set:async(v:any)=>Object.assign(session,structuredClone(v)),remove:async(k:string)=>{delete session[k];}},onChanged:event('storage')},
 declarativeNetRequest:{RuleActionType:{BLOCK:'block'},ResourceType:{MAIN_FRAME:'main_frame'},getSessionRules:async()=>authority?[{id:100008,priority:2,action:{type:'allow'},condition:{tabIds:[8],resourceTypes:['main_frame'],isUrlFilterCaseSensitive:true,regexFilter:String.raw`^https://a\.test/lesson$`}}]:[],updateSessionRules:async()=>{await boundary('session');authority=false;},updateDynamicRules:async(v:any)=>{dynamicRemovals.push(v.removeRuleIds);await boundary('dnr');dynamic=v.addRules?.length?'b.test':'';}},
 scripting:{unregisterContentScripts:async()=>{await boundary('unregister');guard='';},registerContentScripts:async()=>{await boundary('register');guard='b.test';}},
 tabs:{remove:async()=>{},query:async()=>{await boundary('tabs');if(reloadFault==='unknown' && reloads)throw Error('query unavailable');return structuredClone(tabs);},reload:async()=>{reloads++;if(reloadFault){if(reloadFault==='closed')tabs=[];if(reloadFault==='unrelated')tabs=[{id:8,url:'https://unrelated.test/'}];if(reloadFault==='identity')tabs=[{id:8}];if(reloadFault==='pending')tabs=[{id:8,url:'https://unrelated.test/',pendingUrl:'https://b.test/lesson'}];throw Error('reload rejected');}},sendMessage:async()=>{},onRemoved:event('removed'),onUpdated:event('updated')},alarms:{create:async(name:string)=>{if(name==='blocking-recovery')recoveryAlarms++;},clear:async()=>{},onAlarm:event('alarm')}};
 async function boot(){listeners={};context={chrome,Map,Date,URL,console};await runInNewContext(source+'\nready;',context);}
 await boot();
 return {authority:()=>authority,removals:()=>dynamicRemovals,alarms:()=>recoveryAlarms,existing:(mode:string)=>{tabs=[{id:8,url:'https://b.test/lesson'}];reloadFault=mode;},recover:()=>{reloadFault='';tabs=[{id:8,url:'https://b.test/lesson'}];},reloads:()=>reloads,local,state:()=>({dynamic,guard}),fail:(s:string)=>{fault=s;},interrupt:(s:string)=>{interrupt=s;},restart:async()=>{interrupt='';await boot();},settle:async()=>{await new Promise(resolve=>setImmediate(resolve));},alarm:()=>listeners.alarm({name:'blocking-recovery'}),clear:()=>{delete local.sitePolicy;delete local.sitePolicyRevision;listeners.storage({sitePolicy:{oldValue:A}},'local');},send:async(type='site-block')=>new Promise<any>(resolve=>listeners.message({type,host:'b.test',purpose:'study'},{id:'test',url:'blocking.html'},resolve))};
}
for(const mode of ['surviving','unknown','identity','pending']) test(`existing matching tab reload ${mode} failure retains pending and recovery retries`,async()=>{
 const w=await harness();w.existing(mode);assert.equal((await w.send()).ok,false);assert.ok(w.local.sitePolicy.pending);
 w.recover();await w.restart();assert.equal(w.local.sitePolicy.host,'b.test');assert.equal(w.local.sitePolicy.pending,undefined);assert.equal(w.reloads(),2);
});
for(const mode of ['closed','unrelated']) test(`reload rejection after tab ${mode} does not block policy commit`,async()=>{
 const w=await harness();w.existing(mode);assert.equal((await w.send()).ok,true);assert.equal(w.local.sitePolicy.pending,undefined);
});
for(const fault of ['journal','unregister','register','dnr','commit']) test(`initial enable ${fault} failure recovers without false Active`,async()=>{
 const w=await harness(false);w.fail(fault);assert.equal((await w.send()).ok,false);
 if(fault==='journal'){assert.equal(w.local.sitePolicy,undefined);assert.equal(w.state().dynamic,'');return;}
 assert.ok(w.local.sitePolicy.pending);await w.restart();assert.equal(w.local.sitePolicy.host,'b.test');assert.equal(w.state().dynamic,'b.test');
});
test('capture clear during replacement DNR await cannot resurrect policy',async()=>{
 const w=await harness();w.fail('clear-dnr');assert.equal((await w.send()).ok,false);assert.equal(w.local.sitePolicy,undefined);assert.equal(w.state().dynamic,'');
});
test('persistent forward failure remains pending without retry loop; explicit removal supersedes it',async()=>{
 const w=await harness();w.fail('register-always');assert.equal((await w.send()).ok,false);await w.restart();assert.ok(w.local.sitePolicy.pending);await new Promise(resolve=>setTimeout(resolve,20));assert.ok(w.local.sitePolicy.pending);assert.equal((await w.send('site-remove')).ok,true);assert.equal(w.local.sitePolicy,undefined);assert.equal(w.state().dynamic,'');
});
for(const operation of ['site-block','site-remove']) for(const fault of (operation==='site-block'?['journal','unregister','register','dnr','commit']:['journal','unregister','dnr','commit','remove'])) test(`${operation} ${fault} failure is truthful and restart recoverable`,async()=>{
 const w=await harness();w.fail(fault);const result=await w.send(operation);assert.equal(result.ok,false);
 if(fault==='journal'){assert.equal(w.local.sitePolicy.host,'a.test');assert.equal(w.state().dynamic,'a.test');return;}
 assert.ok(w.local.sitePolicy?.pending,'partial enforcement must not be reported Active');
 await w.restart();assert.equal(w.local.sitePolicy?.pending,undefined);
 assert.equal(w.state().dynamic,operation==='site-block'?'b.test':'');assert.equal(w.state().guard,operation==='site-block'?'b.test':'');
 assert.equal(w.local.sitePolicy?.host,operation==='site-block'?'b.test':undefined);
});
for(const operation of ['site-block','site-remove']) for(const boundary of (operation==='site-block'?['unregister','register','dnr','commit']:['unregister','dnr','commit','remove'])) test(`${operation} interrupted at ${boundary} resumes from durable intent`,async()=>{
 const w=await harness();w.interrupt(boundary);void w.send(operation);await new Promise(resolve=>setImmediate(resolve));assert.ok(w.local.sitePolicy?.pending);await w.restart();assert.equal(w.local.sitePolicy?.pending,undefined);assert.equal(w.state().dynamic,operation==='site-block'?'b.test':'');
});

for(const boundary of ['unregister','tabs','session','dnr']) {
 test(`capture clear transient ${boundary} failure retries in same worker`,async()=>{
  const w=await harness(true,true);w.fail(boundary);w.clear();await w.settle();
  w.alarm();await w.settle();assert.deepEqual(w.state(),{dynamic:'',guard:''});assert.equal(w.local.sitePolicy,undefined);assert.equal(w.authority(),false);assert.ok(w.removals().every(ids=>ids.length===1&&ids[0]===78001));
 });
 test(`capture clear interrupted ${boundary} reconciles absent policy after restart`,async()=>{
  const w=await harness(true,true);w.interrupt(boundary);w.clear();await w.settle();
  await w.restart();assert.deepEqual(w.state(),{dynamic:'',guard:''});assert.equal(w.local.sitePolicy,undefined);assert.equal(w.authority(),false);
 });
}
test('absent-policy persistent cleanup failure has one automatic retry and truthful status',async()=>{
 const w=await harness();w.fail('dnr-always');w.clear();await w.settle();
 assert.equal(w.alarms(),1);w.alarm();await w.settle();assert.equal(w.alarms(),1);
 assert.equal((await w.send('blocking-status')).ok,false);assert.equal(w.alarms(),1);
 w.fail('');assert.equal((await w.send('blocking-status')).absenceVerified,true);
 assert.deepEqual(w.state(),{dynamic:'',guard:''});assert.equal(w.local.sitePolicy,undefined);
});
