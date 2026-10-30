import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

async function worker(fault:'set'|'get'|'remove'|'network'|'network-set'|'alarm'|'enumerate-once'|'enumerate'|'permissions-once'|'clear-once'|'get-enumerate'|undefined, restored=false, other=false, initialTime=1000, snapshot?:any){
 const source=await readFile(new URL('../../browser-extension/preview/blocking/worker.js',import.meta.url),'utf8');
 const listeners:Record<string,Function>={};
 const event=(key:string)=>({addListener:(fn:Function)=>{listeners[key]=fn;}});
 const owned=(id:number,resource:string)=>({id:id+100000,priority:2,action:{type:'allow'},condition:{regexFilter:`^${resource.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,isUrlFilterCaseSensitive:true,tabIds:[id],resourceTypes:['main_frame']}});
 let now=initialTime;let fail=fault;let rules:any[]=restored?[owned(1,'http://example.test/a')]:[];
 let persisted:any=restored?{1:{resource:'http://example.test/a',expires:2000,version:1}}:{};
 if(other) { persisted[2]={resource:'http://example.test/b',expires:60000,version:1};rules.push(owned(2,'http://example.test/b')); }
 if(snapshot) { persisted=structuredClone(snapshot.persisted);rules=structuredClone(snapshot.rules); }
 let closed=false;let enumerations=0;let reloads=0;
 let tab:any={id:1,url:'http://unrelated.test/',incognito:false};
 const alarms=new Map<string,any>();
 let policy:any=snapshot?.absentPolicy?undefined:{host:'example.test',purpose:'education',version:1};
 const chrome={runtime:{id:'test',getURL:(s:string)=>s,onMessage:event('message')},permissions:{contains:async()=>{if(fail==='permissions-once'){fail=undefined;throw Error('permissions unavailable');}return true;}},
 storage:{session:{get:async()=>{if(fail==='get'||fail==='get-enumerate')throw Error('read failed');return {blockingGrants:structuredClone(persisted)};},set:async(v:any)=>{if(fail==='set'||fail==='network-set')throw Error('write failed');persisted=structuredClone(v.blockingGrants);},remove:async()=>{if(fail==='remove')throw Error('remove failed');persisted={};}},local:{get:async()=>({sitePolicy:policy}),set:async(v:any)=>{if(v.sitePolicy)policy=v.sitePolicy;},remove:async()=>{policy=undefined;}},onChanged:event('storage')},
 declarativeNetRequest:{RuleActionType:{ALLOW:'allow'},ResourceType:{MAIN_FRAME:'main_frame'},getSessionRules:async()=>{enumerations++;if(fail==='enumerate-once'){fail=undefined;throw Error('enumeration unavailable');}if(fail==='enumerate'||fail==='get-enumerate')throw Error('enumeration unavailable');return rules;},updateDynamicRules:async()=>{},updateSessionRules:async(v:any)=>{if(fail==='network'||fail==='network-set')throw Error('network control failed');rules=rules.filter(r=>!v.removeRuleIds.includes(r.id));rules.push(...(v.addRules??[]));}},
 alarms:{create:async(k:string,v:any)=>{if(fail==='alarm')throw Error('alarm failed');alarms.set(k,v);},clear:async(k:string)=>{if(fail==='clear-once'){fail=undefined;throw Error('clear unavailable');}return alarms.delete(k);},onAlarm:event('alarm')},
 scripting:{unregisterContentScripts:async()=>{}},
 tabs:{query:async()=>[{id:1}],sendMessage:async()=>{},remove:async()=>{closed=true;},get:async()=>tab,update:async()=>{},reload:async()=>{reloads++;},onRemoved:event('removed'),onUpdated:event('updated')}};
 const context={chrome,Map,URL,Date:{now:()=>now},console:{error:()=>{}},admitResource:async()=>({grant:true})};
 const initialized=runInNewContext(source.replace(/^(?:import|export) .*;\n/gm,'')+'\nready;',context);
 await initialized;
 return {clear:async()=>{policy=undefined;listeners.storage({sitePolicy:{oldValue:{version:1}}},'local');await runInNewContext('mutation',context);},reloads:()=>reloads,enumerations:()=>enumerations,closed:()=>closed,rules:()=>rules,alarms,snapshot:()=>structuredClone({persisted,rules}),
 update:async(change:any,current:any)=>{tab=current;listeners.updated(1,change);await runInNewContext('mutation',context);},
fail:(v:typeof fault)=>{fail=v;},time:(v:number)=>{now=v;},
 recover:()=>new Promise<any>(resolve=>listeners.message({type:'site-remove'},{id:'test',url:'blocking.html'},resolve)),
 retry:async()=>{listeners.alarm({name:'blocking-recovery'});await runInNewContext('mutation',context);},
 grant:()=>new Promise<any>(resolve=>listeners.message({type:'resource-review',resource:'http://example.test/a',override:true,version:1,tabId:1,seconds:1},{id:'test',url:'blocking.html'},resolve)),
 expire:async()=>{now=3000;listeners.alarm({name:'blocking-1'});await runInNewContext('mutation',context);},
 revoke:async()=>{listeners.removed(1);await runInNewContext('mutation',context);}};
}

test('startup preserves unrelated session rules while cleaning owned orphans and retaining valid grants',async()=>{
 const baseline=await worker(undefined,true);
 const snapshot=baseline.snapshot();
 const sentinel={id:42,priority:1,action:{type:'block'},condition:{urlFilter:'sentinel.test',resourceTypes:['main_frame']}};
 const collision={...sentinel,id:100003};
 snapshot.rules.push(sentinel,collision,{...snapshot.rules[0],id:100004,condition:{...snapshot.rules[0].condition,tabIds:[4]}});
 snapshot.persisted[3]={resource:'http://example.test/a',expires:0,version:1};
 const w=await worker(undefined,false,false,1000,snapshot);
 assert.deepEqual(w.rules().map(r=>r.id),[100001,42,100003]);
 await w.expire();assert.deepEqual(w.rules(),[sentinel,collision]);
});

for(const absentPolicy of [false,true]) test(`session ownership survives startup, clear and recovery (absent=${absentPolicy})`,async()=>{
 const sentinel={id:42,priority:1,action:{type:'block'},condition:{urlFilter:'sentinel.test'}};
 const collision={...sentinel,id:100001};
 const w=await worker(undefined,false,false,1000,{absentPolicy,persisted:{1:{resource:'http://example.test/a',expires:2000,version:1}},rules:[sentinel,collision]});
 assert.deepEqual(w.rules(),[sentinel,collision]);
 if(!absentPolicy)assert.equal((await w.grant()).ok,false,'never overwrite a foreign ID collision');
 await w.clear();assert.deepEqual(w.rules(),[sentinel,collision]);
 assert.equal((await w.recover()).ok,true);assert.deepEqual(w.rules(),[sentinel,collision]);
});

for(const operation of ['expire','revoke'] as const) test(`transient startup enumeration failure recovers ${operation} without restart`,async()=>{
 const w=await worker('enumerate-once',true);await w[operation]();assert.equal(w.rules().length,0);
});
test('persistent startup enumeration failure closes known target without deleting uninspected rules',async()=>{
 const w=await worker('enumerate',true);assert.ok(w.alarms.has('blocking-recovery'));assert.equal(w.enumerations(),2);assert.equal(w.closed(),true);assert.equal(w.rules().length,1);assert.equal(w.reloads(),0,'failed initialization must not induce reload events that retry itself');
 await w.retry();assert.equal(w.enumerations(),4);assert.ok(w.alarms.has('blocking-recovery'));
 w.fail(undefined);await w.retry();assert.equal(w.enumerations(),6);assert.equal(w.rules().length,0);assert.equal(w.alarms.has('blocking-recovery'),false);
});
test('explicit control recovery retries failed startup without restart',async()=>{
 const w=await worker('enumerate-once',true);assert.equal((await w.recover()).ok,true);assert.equal(w.rules().length,0);
});
for(const fault of ['permissions-once','clear-once','get-enumerate'] as const) test(`initialization ${fault} failure cannot poison explicit recovery`,async()=>{
 const w=await worker(fault,true);assert.equal(w.rules().length,fault==='clear-once'?0:1);w.fail(undefined);assert.equal((await w.recover()).ok,true);assert.equal(w.rules().length,0);
});
test('successful startup preserves a bounded cold-restored exception',async()=>{
 const w=await worker(undefined,true);assert.equal(w.rules().length,1);assert.equal(w.alarms.get('blocking-1').when,2000);
});

test('failed grant persistence cannot leave a permissive network rule',async()=>{
 const w=await worker('set');assert.equal((await w.grant()).ok,false);assert.equal(w.rules().length,0);
});
for(const fault of ['set','remove'] as const) for(const operation of ['revoke','expire'] as const) test(`${operation} removes network authority despite ${fault} failure`,async()=>{
 const w=await worker(undefined,false,fault==='set');assert.equal((await w.grant()).ok,true);w.fail(fault);await w[operation]();assert.equal(w.rules().some(rule=>rule.id===100001),false);
});
test('restart with unreadable metadata removes orphaned network authority',async()=>{
 const w=await worker('get',true);assert.equal(w.rules().length,0);
});
for(const fault of ['set','remove'] as const) test(`expired restart metadata cannot keep authority when ${fault} fails`,async()=>{
 const w=await worker(fault,true,fault==='set',3000);assert.equal(w.rules().some(rule=>rule.id===100001),false);
});
test('failed network revoke retains grant and schedules recovery',async()=>{
 const w=await worker(undefined);await w.grant();w.fail('network');await w.expire();assert.equal(w.rules().length,1);assert.ok(w.alarms.has('blocking-1'));w.fail(undefined);await w.expire();assert.equal(w.rules().length,0);
});
test('ungranted origin status-only event revokes hidden URL authority',async()=>{
 const w=await worker(undefined);await w.grant();await w.update({status:'complete'},{id:1,status:'complete'});assert.equal(w.rules().length,0);
});
test('stale status event cannot revoke current exact resource',async()=>{
 const w=await worker(undefined);await w.grant();await w.update({status:'complete'},{id:1,url:'http://example.test/a'});assert.equal(w.rules().length,1);
});
test('failed early revoke survives restart as pending rather than future expiry',async()=>{
 const w=await worker(undefined);await w.grant();w.fail('network');await w.revoke();
 const restarted=await worker(undefined,false,false,1000,w.snapshot());assert.equal(restarted.rules().length,0);
});
test('failed network and cancellation persistence closes the affected tab',async()=>{
 const w=await worker(undefined);await w.grant();w.fail('network-set');await w.revoke();assert.equal(w.closed(),true);
});
test('alarm failure prevents installation of a network exception',async()=>{
 const w=await worker('alarm');assert.equal((await w.grant()).ok,false);assert.equal(w.rules().length,0);
});
