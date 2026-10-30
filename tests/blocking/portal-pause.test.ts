import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
// Production worker bytes with a fake browser and a controllable clock. Pure
// journal/DNR/alarm fixture; not Chrome, enrollment, native or installed evidence.
const A={host:'a.test',subdomains:false,purpose:'study',version:1};
const T0=1_000_000_000;
async function harness({grant=false,alarms=true}={}){
 const source=(await readFile(new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8')).replace(/^(?:import|export) .*;\n/gm,'');
 const clock={now:T0};
 const local:Record<string,any>={sitePolicy:structuredClone(A),sitePolicyRevision:1};
 let dynamic='a.test',guard='a.test',authority=grant,permitted=true,fault='',interrupt='';
 const armed=new Map<string,number>();const reloads:number[]=[];let listeners:Record<string,Function>={};
 const session:any=grant?{blockingGrants:{8:{resource:'https://a.test/lesson',expires:T0+60000,version:1}}}:{};
 const boundary=(name:string)=>{if(fault===name||fault===`${name}-always`){if(fault===name)fault='';throw Error(name);}if(interrupt===name)return new Promise<void>(()=>{});};
 const event=(name:string)=>({addListener:(fn:Function)=>listeners[name]=fn});
 const chrome:any={runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},permissions:{contains:async()=>permitted},
  storage:{local:{get:async()=>structuredClone(local),set:async(v:any)=>{await boundary(v.sitePolicy?.pending?'journal':'commit');Object.assign(local,structuredClone(v));},remove:async(k:string)=>{await boundary('remove');delete local[k];}},
   session:{get:async()=>structuredClone(session),set:async(v:any)=>Object.assign(session,structuredClone(v)),remove:async(k:string)=>{delete session[k];}},onChanged:event('storage')},
  declarativeNetRequest:{RuleActionType:{BLOCK:'block'},ResourceType:{MAIN_FRAME:'main_frame'},
   getSessionRules:async()=>authority?[{id:100008,priority:2,action:{type:'allow'},condition:{tabIds:[8],resourceTypes:['main_frame'],isUrlFilterCaseSensitive:true,regexFilter:String.raw`^https://a\.test/lesson$`}}]:[],
   updateSessionRules:async()=>{authority=false;},
   updateDynamicRules:async(v:any)=>{await boundary('dnr');dynamic=v.addRules?.length?v.addRules[0].condition.regexFilter.includes('a\\.test')?'a.test':'other':'';}},
  scripting:{unregisterContentScripts:async()=>{await boundary('unregister');guard='';},registerContentScripts:async(v:any)=>{await boundary('register');guard=v[0].matches[0].includes('a.test')?'a.test':'other';}},
  tabs:{remove:async()=>{},query:async()=>[{id:8,url:'https://a.test/lesson'}],get:async(id:number)=>({id,url:'https://a.test/lesson',incognito:false}),reload:async(id:number)=>{reloads.push(id);},sendMessage:async()=>{},update:async()=>{},onRemoved:event('removed'),onUpdated:event('updated')},
  alarms:alarms?{create:async(name:string,info:{when:number})=>{if(name==='blocking-pause')await boundary('alarm');armed.set(name,info.when);},clear:async(name:string)=>{armed.delete(name);},onAlarm:event('alarm')}:{clear:async()=>{},onAlarm:event('alarm')}};
 async function boot(){listeners={};await runInNewContext(source+'\nready;',{chrome,Map,Set,WeakSet,URL,console,Date:{now:()=>clock.now}});await settle();}
 const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
 const send=(message:any)=>new Promise<any>(resolve=>listeners.message(message,{id:'test',url:'blocking.html'},resolve));
 await boot();
 return {local,clock,armed,reloads,settle,boot,
  state:()=>({dynamic,guard,authority}),
  fail:(name:string)=>{fault=name;},interrupt:(name:string)=>{interrupt=name;},restart:async()=>{interrupt='';await boot();},
  revokeSite:()=>{permitted=false;},
  fire:async(name='blocking-pause')=>{listeners.alarm({name});await settle();},
  clear:async()=>{const old=local.sitePolicy;delete local.sitePolicy;delete local.sitePolicyRevision;listeners.storage({sitePolicy:{oldValue:old}},'local');await settle();},
  send,
  pause:(seconds=60,version=local.sitePolicy?.version)=>send({type:'site-pause',version,seconds}),
  resume:(version=local.sitePolicy?.version)=>send({type:'site-resume',version}),
  status:()=>send({type:'blocking-status'}),
  check:()=>new Promise<any>(resolve=>listeners.message({type:'resource-check',resource:'https://a.test/lesson'},{id:'test',tab:{id:8},url:'https://a.test/lesson'},resolve))};
}

test('pause arms a browser-owned deadline, lifts the same DNR/guard enforcement and revokes resource exceptions',async()=>{
 const w=await harness({grant:true});
 const result=await w.pause(60);
 assert.equal(result.ok,true,result.error);
 assert.deepEqual(w.state(),{dynamic:'',guard:'',authority:false});
 assert.deepEqual(w.local.sitePolicy,{host:'a.test',subdomains:false,purpose:'study',version:2,pausedUntil:T0+60000});
 assert.equal(w.local.sitePolicyRevision,2);
 assert.equal(w.armed.get('blocking-pause'),T0+60000);
 assert.equal((await w.check()).active,false);
 const status=await w.status();
 assert.equal(status.state,'paused');assert.deepEqual({...status.pause},{supported:true,minSeconds:30,maxSeconds:1800});
});

test('expiry is the original deadline: early alarm and restart re-arm it, due alarm or due restart re-blocks',async()=>{
 const w=await harness();
 assert.equal((await w.pause(60)).ok,true);
 w.clock.now=T0+30000;await w.fire();
 assert.equal(w.local.sitePolicy.pausedUntil,T0+60000,'early wakeup neither resumes nor extends');
 assert.equal(w.armed.get('blocking-pause'),T0+60000);
 w.armed.clear();await w.restart();
 assert.equal(w.local.sitePolicy.pausedUntil,T0+60000,'worker restart keeps the same deadline');
 assert.equal(w.armed.get('blocking-pause'),T0+60000);
 w.clock.now=T0+60000;await w.fire();
 assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.local.sitePolicy.version,3);
 assert.deepEqual(w.state(),{dynamic:'a.test',guard:'a.test',authority:false});
 assert.ok(w.reloads.includes(8),'existing matching tab is re-gated');
 assert.equal(w.armed.has('blocking-pause'),false);
 // Missed alarm (browser closed past the deadline): startup resumes without one.
 assert.equal((await w.pause(60)).ok,true);w.clock.now+=3_600_000;await w.restart();
 assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.state().dynamic,'a.test');
});

test('compare-and-set, bounds, idempotent resume and pending gate',async()=>{
 const w=await harness();
 for(const seconds of [0,29,1801,1.5,'60',undefined]) assert.equal((await w.send({type:'site-pause',version:1,seconds})).ok,false,`seconds ${seconds}`);
 const stale=await w.pause(60,0);
 assert.equal(stale.ok,false);assert.equal(stale.state,'active');assert.equal(stale.sitePolicy.version,1);
 assert.equal(w.state().dynamic,'a.test');assert.equal(w.armed.has('blocking-pause'),false);
 const noop=await w.resume();assert.equal(noop.ok,true);assert.equal(w.local.sitePolicy.version,1,'resume of an active policy changes nothing');
 assert.equal((await w.pause(60)).ok,true);
 assert.equal((await w.pause(60)).ok,false,'already paused; no silent extension');
 assert.equal(w.local.sitePolicy.pausedUntil,T0+60000);
 assert.equal((await w.resume(1)).ok,false,'stale resume');
 const resumed=await w.resume();assert.equal(resumed.ok,true);assert.equal(resumed.state,'active');
 assert.deepEqual(w.state().dynamic,'a.test');assert.equal(w.armed.has('blocking-pause'),false);
 w.local.sitePolicy={...w.local.sitePolicy,pending:{policy:null,revision:9}};
 assert.equal((await w.pause(60)).ok,false,'pending journal blocks pause');
});

test('without a browser-owned expiry pause is unsupported or refused and enforcement is untouched',async()=>{
 const none=await harness({alarms:false});
 const status=await none.status();assert.equal(status.pause.supported,false);
 const unsupported=await none.pause(60);assert.equal(unsupported.ok,false);assert.match(unsupported.error,/unsupported/i);
 assert.deepEqual(none.local.sitePolicy,A);assert.equal(none.state().dynamic,'a.test');
 const w=await harness();w.fail('alarm');
 assert.equal((await w.pause(60)).ok,false);
 assert.deepEqual(w.local.sitePolicy,A);assert.deepEqual(w.state(),{dynamic:'a.test',guard:'a.test',authority:false});
});

test('interrupted pause/resume recover from the journal; resume never silently regains revoked site access',async()=>{
 const w=await harness();w.interrupt('dnr');void w.pause(60);await w.settle();
 assert.ok(w.local.sitePolicy.pending);await w.restart();
 assert.equal(w.local.sitePolicy.pending,undefined);assert.equal(w.local.sitePolicy.pausedUntil,T0+60000);assert.equal(w.state().dynamic,'');
 // Pending pause recovered after its deadline applies the block instead.
 const late=await harness();late.interrupt('dnr');void late.pause(60);await late.settle();
 late.clock.now=T0+61000;await late.restart();
 assert.equal(late.local.sitePolicy.pausedUntil,undefined);assert.equal(late.state().dynamic,'a.test');
 w.revokeSite();const resumed=await w.resume();
 assert.equal(resumed.ok,false);assert.match(resumed.error,/site permission/);
 assert.ok(w.local.sitePolicy.pending,'reported incomplete, never Active');
 assert.equal((await w.status()).state,'pending');
 assert.equal((await w.send({type:'site-remove'})).ok,true);assert.equal(w.local.sitePolicy,undefined);
});

test('a failed final pause save after rule removal still ends at the original deadline in the same live worker',async()=>{
 for(const late of [60000,3_600_000]) {
  const w=await harness();w.fail('commit');
  assert.equal((await w.pause(60)).ok,false);
  assert.ok(w.local.sitePolicy.pending);assert.deepEqual(w.state(),{dynamic:'',guard:'',authority:false});
  assert.equal(w.armed.get('blocking-pause'),T0+60000);
  w.clock.now=T0+late;await w.fire();
  assert.equal(w.local.sitePolicy.pending,undefined,`+${late}ms`);assert.equal(w.local.sitePolicy.pausedUntil,undefined);
  assert.deepEqual(w.state(),{dynamic:'a.test',guard:'a.test',authority:false});assert.ok(w.reloads.includes(8));
  assert.equal((await w.status()).state,'active');
 }
 // An early wakeup re-arms the original deadline; it neither commits nor extends.
 const e=await harness();e.fail('commit');await e.pause(60);
 e.clock.now=T0+30000;e.armed.clear();await e.fire();
 assert.equal(e.armed.get('blocking-pause'),T0+60000);assert.ok(e.local.sitePolicy.pending);
 // Overdue resource-check queues the same recovery while replying gated.
 const c=await harness();c.fail('commit');await c.pause(60);
 c.clock.now=T0+60000;assert.equal((await c.check()).gated,true);await c.settle();
 assert.equal(c.local.sitePolicy.pending,undefined);assert.equal(c.state().dynamic,'a.test');
 // Revoked site access is a known hold, never a silent regain or an Active claim.
 const r=await harness();r.fail('commit');await r.pause(60);
 r.revokeSite();r.clock.now=T0+60000;await r.fire();
 assert.ok(r.local.sitePolicy.pending);assert.equal(r.state().dynamic,'');
 const status=await r.status();assert.equal(status.ok,true);assert.equal(status.state,'pending');
 assert.equal((await r.send({type:'site-remove'})).ok,true);assert.equal(r.local.sitePolicy,undefined);
});

test('remove, capture clear and replacement end a pause and its alarm',async()=>{
 const w=await harness();assert.equal((await w.pause(60)).ok,true);
 assert.equal((await w.send({type:'site-remove'})).ok,true);
 assert.equal(w.local.sitePolicy,undefined);assert.equal(w.armed.has('blocking-pause'),false);
 w.clock.now=T0+60000;await w.fire();assert.equal(w.local.sitePolicy,undefined,'stale alarm cannot resurrect a policy');
 const c=await harness();assert.equal((await c.pause(60)).ok,true);await c.clear();
 assert.equal(c.local.sitePolicy,undefined);assert.equal(c.armed.has('blocking-pause'),false);assert.equal(c.state().dynamic,'');
 const r=await harness();assert.equal((await r.pause(60)).ok,true);
 assert.equal((await r.send({type:'site-block',host:'a.test',purpose:''})).ok,true);
 assert.equal(r.local.sitePolicy.pausedUntil,undefined);assert.equal(r.state().dynamic,'a.test');assert.equal(r.armed.has('blocking-pause'),false);
});

test('a pause beyond the bound after a clock change fails closed on startup',async()=>{
 const w=await harness();assert.equal((await w.pause(60)).ok,true);
 w.clock.now=T0-3_600_000;await w.restart();
 assert.equal(w.local.sitePolicy.pausedUntil,undefined);assert.equal(w.state().dynamic,'a.test');
});

test('extension controls send the shown version, enable only the valid action and report the pause truthfully',async()=>{
 const source=await readFile(new URL('../../browser-extension/preview/blocking/controls.js',import.meta.url),'utf8');
 const elements=new Map<string,any>(),handlers=new Map<string,Function>(),sent:any[]=[];
 const element=(name:string)=>{if(!elements.has(name))elements.set(name,{textContent:'',value:'',checked:false,disabled:false,addEventListener:(event:string,fn:Function)=>handlers.set(name+':'+event,fn),append:()=>{}});return elements.get(name);};
 let snapshot:any={ok:true,state:'active',absenceVerified:true,sitePolicy:{...A},pause:{supported:true}};
 const chrome={runtime:{sendMessage:async(m:any)=>{sent.push(m);return m.type==='blocking-status'?snapshot:{ok:true};}},storage:{local:{get:async()=>({})},onChanged:{addListener:()=>{}}},tabs:{query:async()=>[]}};
 runInNewContext(source.replace(/^export \{\};?\s*$/gm,''),{document:{querySelector:element,createElement:()=>({})},chrome,Date,Number});
 const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
 await settle();
 assert.match(element('output').textContent,/^Active: a\.test only; policy v1/);
 assert.equal(element('#pause').disabled,false);assert.equal(element('#resume').disabled,true);
 element('#pause-seconds').value='300';snapshot={...snapshot,state:'paused',sitePolicy:{...A,version:2,pausedUntil:T0+300000}};
 handlers.get('#pause:click')!();await settle();
 assert.deepEqual({...sent.find(m=>m.type==='site-pause')},{type:'site-pause',version:1,seconds:300});
 assert.match(element('output').textContent,/^Paused: a\.test only; policy v2\. Blocking resumes automatically at .* even with this page closed/);
 assert.equal(element('#pause').disabled,true);assert.equal(element('#resume').disabled,false);
 handlers.get('#resume:click')!();await settle();
 assert.deepEqual({...sent.find(m=>m.type==='site-resume')},{type:'site-resume',version:2});
 snapshot={ok:true,state:'active',absenceVerified:true,sitePolicy:{...A},pause:{supported:false}};
 handlers.get('#remove:click')!();await settle();
 assert.match(element('output').textContent,/Pause unsupported in this browser\./);assert.equal(element('#pause').disabled,true);
 // An unknown-state reply clears the previous render's enabled action and version.
 snapshot={ok:true,state:'paused',absenceVerified:true,sitePolicy:{...A,version:2,pausedUntil:T0+300000},pause:{supported:true}};
 handlers.get('#remove:click')!();await settle();assert.equal(element('#resume').disabled,false);
 snapshot={ok:false,error:'unknown'};
 handlers.get('#remove:click')!();await settle();
 assert.match(element('output').textContent,/^Cleanup incomplete; protection state unknown/);
 assert.equal(element('#pause').disabled,true);assert.equal(element('#resume').disabled,true);
 sent.length=0;handlers.get('#resume:click')!();await settle();
 assert.equal(sent.find(m=>m.type==='site-resume').version,undefined,'no stale version is sent');
});
