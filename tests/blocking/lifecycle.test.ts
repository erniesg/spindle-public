import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {admitResource} from '../../core/blocking/admission.js';
import {resourceIdentity} from '../../core/blocking/policy.js';
async function worker(deferred?:'restore'|'restore-unexpired'|'stop'){
 const source=await readFile(process.env.SPINDLE_BLOCKING_WORKER ?? new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8');
 const listeners:Record<string,Function>={};
 const event=(name:string)=>({addListener:(fn:Function)=>{listeners[name]=fn;}});
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const saved:Record<string,unknown>[]=[];
 let local:Record<string,any>={sitePolicyRevision:1,sitePolicy:{host:'example.test',purpose:'study',version:1}};
 let registered=true; let dynamic=true; let blockedReload=false; let sessions=[1,2].map(id=>({id:100000+id,priority:2,action:{type:'allow'},condition:{tabIds:[id],resourceTypes:['main_frame'],isUrlFilterCaseSensitive:true,regexFilter:id===1?'^http://example\\.test/a$':'^http://example\\.test/b$'}}));
 const chrome={permissions:{contains:async()=>true},runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},
 storage:{session:{get:async()=>{if(deferred?.startsWith('restore')) await gate;return {blockingGrants:{1:{resource:'http://example.test/a',version:1,expires:Date.now()+(deferred==='restore'?-1:60000)},2:{resource:'http://example.test/b',version:1,expires:Date.now()+60000}}};},set:async(value:Record<string,unknown>)=>{saved.push(value);},remove:async()=>{saved.push({blockingGrants:{}});}},local:{get:async()=>({...local}),set:async(value:Record<string,any>)=>{Object.assign(local,value);},remove:async(key:string)=>{delete local[key];}},onChanged:event('storage')},
 declarativeNetRequest:{RuleActionType:{BLOCK:'block'},ResourceType:{MAIN_FRAME:'main_frame'},getSessionRules:async()=>sessions,updateSessionRules:async(change:{removeRuleIds:number[];addRules?:typeof sessions})=>{sessions=[...sessions.filter(rule=>!change.removeRuleIds.includes(rule.id)),...change.addRules??[]];},updateDynamicRules:async(change:{addRules?:unknown[]})=>{dynamic=Boolean(change.addRules?.length);}},
 alarms:{create:async()=>{},clear:async()=>{},onAlarm:event('alarm')},tabs:{query:async()=>[],reload:async()=>{if(dynamic)blockedReload=true;}, sendMessage:async()=>{},onRemoved:event('removed'),onUpdated:event('updated')},
 scripting:{registerContentScripts:async()=>{registered=true;},unregisterContentScripts:async()=>{if(deferred==='stop') await gate;registered=false;}}};
 const purposeCalls={content:0,model:0};
 const context={chrome,Map,Date,URL,console,admitResource,resourceIdentity,AbortController,setTimeout,clearTimeout,
  producePurposeContent:async()=>{purposeCalls.content++;return {evidenceId:`static:${'a'.repeat(64)}`,pageText:'Invented lesson'};},
  requestPurposeEligibility:async()=>{purposeCalls.model++;return {verdict:'allow',reason:'classified'};}};
 const initialized=runInNewContext(source.replace(/^(?:import|export) .*;\n/gm,'')+'\nready;', context);
 if(!deferred?.startsWith('restore')) await initialized;
 return {listeners,chrome,saved,release,initialized,purposeCalls,setPolicy:(policy:unknown)=>{local.sitePolicy=policy;},drain:()=>runInNewContext('mutation',context),state:()=>({registered,dynamic,sessions,blockedReload})};
}
test('production Jev review route requires separate processing consent before content/native work',async()=>{
 const w=await worker();let answer:{ok:boolean;error:string}|undefined;
 const handled=w.listeners.message({type:'resource-jev',resource:'http://example.test/a',tabId:1,version:1,processingConsent:false},{id:'test',url:'blocking.html'},(value:any)=>{answer=value;});
 assert.equal(handled,true,'production worker must handle the Jev review, not silently discard the optional feature');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(answer?.ok,false);assert.match(answer?.error??'',/processing consent/i);
 assert.equal(w.state().sessions.length,2,'denied processing cannot install a resource exception');
});
test('withdrawing consent during initial tab lookup prevents content or classifier dispatch',async()=>{
 const w=await worker();let release!:(value:unknown)=>void,started!:()=>void;
 const entered=new Promise<void>(resolve=>{started=resolve;});let first=true;
 Object.assign(w.chrome.tabs,{get:async()=>{if(first){first=false;started();return new Promise(resolve=>{release=resolve;});}return {id:1,url:'http://example.test/a',incognito:false};},update:async()=>{}});
 const result=new Promise<{ok:boolean}>(resolve=>w.listeners.message({type:'resource-jev',resource:'http://example.test/a',tabId:1,version:1,processingConsent:true},{id:'test',url:'blocking.html'},resolve));
 await entered;w.listeners.message({type:'purpose-cancel'},{id:'test',url:'blocking.html'},()=>{});
 release({id:1,url:'http://example.test/a',incognito:false});
 assert.equal((await result).ok,false);assert.equal(w.purposeCalls.content,0);assert.equal(w.purposeCalls.model,0);
});
test('incidental worker initialization preserves unexpired session grant',async()=>{
 const w=await worker();assert.equal(w.state().sessions.length,2);
});
test('observed departure cannot be erased by a same-resource return before queued reconciliation',async()=>{
 const w=await worker();
 Object.assign(w.chrome.tabs,{get:async()=>({url:'http://example.test/a'})});
 w.listeners.updated(1,{url:'http://example.test/departed'});
 w.listeners.updated(1,{url:'http://example.test/a'});
 await w.drain();
 assert.deepEqual(w.state().sessions.map(rule=>rule.id),[100002],
  'a fresh current-tab read must not erase an already observed departure');
});
test('cold restoration retains delivered departure before a same-resource return',async()=>{
 const w=await worker('restore-unexpired');
 Object.assign(w.chrome.tabs,{get:async()=>({url:'http://example.test/a'})});
 w.listeners.updated(1,{url:'http://example.test/departed'});
 w.listeners.updated(1,{url:'http://example.test/a'});
 w.release();await w.initialized;await w.drain();
 assert.deepEqual(w.state().sessions.map(rule=>rule.id),[100002],
  'a delivered cold-start departure must invalidate restored authority, not be erased by return');
});
test('cold-start departure does not cancel authority from a later processed deliberate review',async()=>{
 const w=await worker('restore-unexpired');
 Object.assign(w.chrome.tabs,{get:async()=>({url:'http://example.test/a'}),update:async()=>{}});
 const reviewed=new Promise<{ok:boolean}>(resolve=>w.listeners.message({type:'resource-review',resource:'http://example.test/a',tabId:1,version:1,override:true,seconds:30},{id:'test',url:'blocking.html'},resolve));
 w.listeners.updated(1,{url:'http://example.test/departed'});
 w.release();await w.initialized;await w.drain();
 assert.equal((await reviewed).ok,true);
 assert.deepEqual(w.state().sessions.map(rule=>rule.id).sort(),[100001,100002],
  'an old event must not revoke a replacement grant created after restoration');
});
test('whole-site block needs no purpose, while purpose-less resource review stays gated',async()=>{
 const w=await worker();
 const result=await new Promise<{ok:boolean}>(resolve=>w.listeners.message({type:'site-block',host:'example.test'},{id:'test',url:'blocking.html'},resolve));
 assert.equal(result.ok,true,'purpose is optional for the independent whole-site policy');
 assert.equal(w.state().dynamic,true);assert.equal(w.state().sessions.length,0);
 const {sitePolicy}=await w.chrome.storage.local.get();assert.equal(sitePolicy.purpose,'');
 const review=await new Promise<{ok:boolean;error:string}>(resolve=>w.listeners.message({type:'resource-review',resource:'http://example.test/a',tabId:1,version:sitePolicy.version,override:true},{id:'test',url:'blocking.html'},resolve));
 assert.equal(review.ok,false);assert.match(review.error,/Choose an allowed purpose/);
 assert.equal(w.state().sessions.length,0);
});
test('explicit removal unregisters dormant document guard',async()=>{
 const w=await worker();await new Promise<void>(resolve=>w.listeners.message({type:'site-remove'},{id:'test',url:'blocking.html'},()=>resolve()));
 assert.equal(w.state().registered,false);assert.equal(w.state().dynamic,false);assert.equal(w.state().blockedReload,false);
});
test('capture local.clear reconciles blocking enforcement',async()=>{
 const w=await worker();w.setPolicy(undefined);w.listeners.storage({sitePolicy:{oldValue:{host:'example.test'}}},'local');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.state().dynamic,false);assert.equal(w.state().registered,false);
});

test('cold alarm waits for restore and preserves other unexpired grants',async()=>{
 const w=await worker('restore');
 w.listeners.alarm({name:'blocking-1'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.saved.length,0,'alarm must not persist an empty pre-restore map');
 w.release();await w.initialized;await w.drain();
 const last=w.saved.at(-1)! as {blockingGrants:Record<string,unknown>};
 assert.deepEqual(Object.keys(last.blockingGrants),['2']);
});
test('storage deletion cleanup occupies the same queue as controls',async()=>{
 const w=await worker('stop');w.setPolicy(undefined);
 w.listeners.storage({sitePolicy:{oldValue:{version:1}}},'local');
 await new Promise(resolve=>setImmediate(resolve));
 let replied=false;
 w.listeners.message({type:'site-block',host:'example.test',purpose:'education'},{id:'test',url:'blocking.html'},(result:{ok:boolean})=>{assert.equal(result.ok,true);replied=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(replied,false,'new controls must not overtake pending production guard shutdown');
 w.release();await w.drain();assert.equal(replied,true);
 assert.equal(w.state().dynamic,true,'old deletion cannot remove the newly installed rule');
 assert.equal(w.state().registered,true);
});

test('queued stale deletion and stale alarm preserve current policy generation',async()=>{
 const w=await worker();
 w.setPolicy({version:1});
 w.listeners.storage({sitePolicy:{oldValue:{version:0}}},'local');
 w.listeners.alarm({name:'blocking-1'});
 await w.drain();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.state().dynamic,true);assert.equal(w.state().registered,true);
 assert.equal(w.saved.length,0,'current unexpired grants must not be revoked');
});
test('deletion revalidates generation after deferred production guard API',async()=>{
 const w=await worker('stop');w.setPolicy(undefined);
 w.listeners.storage({sitePolicy:{oldValue:{version:0}}},'local');
 await new Promise(resolve=>setImmediate(resolve));
 w.setPolicy({version:1});w.release();await w.drain();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(w.state().dynamic,true,'changed policy must prevent old destructive cleanup');
 assert.equal(w.saved.length,0);
});
