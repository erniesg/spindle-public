import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleService } from '../../core/connectors/google/service.js';
import { GoogleOAuth,scopes } from '../../core/connectors/google/oauth.js';
import { GoogleWakeJournal } from '../../core/connectors/google/wake-journal.js';
import { GmailSync } from '../../core/connectors/google/gmail.js';
import { GmailWatch } from '../../core/connectors/google/watch.js';
import { AgentStore } from '../../core/storage/agent-store.js';
const route={route:'r',workspace:'w',account:'demo@example.test',epoch:'e',subscription:'s',audience:'a',serviceAccountEmail:'push@example.test'};
const wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('finite wait expired');};
function fixture(mode:'local'|'push'='local',relevant:(message:unknown,signal:AbortSignal)=>Promise<string|undefined>=async()=>undefined){
 const dir=mkdtempSync(join(tmpdir(),'google-service-')),journal=new GoogleWakeJournal(join(dir,'wake')),tasks=new AgentStore(join(dir,'tasks'));
 let valid=true,watches=0;
 const http=(async(url)=>{const u=String(url);if(u.endsWith('/watch')){watches++;return Response.json({historyId:'999',expiration:String(Date.now()+7*86400000)});}if(u.endsWith('/profile'))return Response.json({emailAddress:route.account,historyId:'10'});if(u.includes('/messages?'))return Response.json({messages:[{id:'m'}]});if(u.includes('/history?'))return Response.json({historyId:'11',history:[]});return Response.json({id:'m',internalDate:'1000'});}) as typeof fetch;
 const sync=new GmailSync(join(dir,'sync'),tasks,http);
 const current=async()=>{if(!valid)throw Error('revoked');};
 const oauth={connectionState:async()=>valid?{accountId:route.account,connectionEpoch:route.epoch,grants:[scopes.mail]}:undefined,connectorAccess:async()=>({assertCurrent:current,token:async()=>{await current();return 'invented';}})} as unknown as GoogleOAuth;
 const service=new GoogleService({connectionId:'c',route,mode,topicName:'projects/demo-project/topics/demo-topic',bootstrapSince:500,intervalMs:20,relevant},oauth,sync,journal,new GmailWatch(journal,http),http);
 return {service,journal,revoke:()=>{valid=false;},watches:()=>watches,clean:async()=>{await service.stop();sync.close();tasks.close();journal.close();rmSync(dir,{recursive:true,force:true});}};
}
test('actual ticks retain pending push correlation across recovery bucket and do not reuse completed hints',async()=>{
 const f=fixture('push',async()=> 'prepare');const captured:ReturnType<GoogleWakeJournal['claim']>[]=[];
 const claim=f.journal.claim.bind(f.journal);f.journal.claim=(...args)=>{const result=claim(...args);if(result)captured.push(result);return result;};
 try{
 f.journal.enqueue(route,'authenticated-push',{receiptAt:Date.now()-10});
 f.service.start();await wait(()=>!!f.service.status().lastSync);
 assert.equal(captured[0]?.receipt?.delivery,'authenticated-push');
 assert.equal(f.journal.admissionStatus(route)[0].receipt.delivery,'authenticated-push');
 await wait(()=>captured.length>1);assert.equal(captured[1]?.receipt,undefined);
 }finally{await f.clean();}
});
test('actual start timer reconciles local mode, stop settles, restart retains bootstrap',async()=>{
 const f=fixture();try{f.service.start();await wait(()=>!!f.service.status().lastSync);assert.equal(f.service.status().mode,'local');await f.service.stop();assert.equal(f.service.status().running,false);assert.equal(f.watches(),0);assert.equal(f.journal.bootstrap(route,500),500);assert.throws(()=>f.journal.bootstrap(route,501),/boundary changed/);f.service.start();await new Promise(r=>setTimeout(r,30));await f.service.stop();assert.equal((f.journal.status(route) as {backlog:number}).backlog,0);}finally{await f.clean();}
});
test('push mode starts watch and renews before expiry without treating watch ID as cursor',async()=>{
 const f=fixture('push');try{f.service.start();await wait(()=>!!f.service.status().lastSync);assert.equal(f.watches(),1);f.journal.recordWatch(route,'123',Date.now()+1000);await wait(()=>f.watches()===2);assert.equal(f.journal.watch(route)?.historyId,'999');}finally{await f.clean();}
});
test('revoke during relevance prevents success completion and exposes retry backlog',async()=>{
 let release!:()=>void,entered=false;
 const f=fixture('local',async()=>{entered=true;await new Promise<void>(r=>{release=r;});return 'prepare';});
 try{f.service.start();await wait(()=>entered);f.revoke();release();await wait(()=>!!f.service.status().failure);assert.equal(f.service.status().lastSync,undefined);assert.ok((f.journal.status(route) as {backlog:number}).backlog>0);}finally{await f.clean();}
});
test('stop settles despite noncooperative relevance and late resolution cannot complete wake',async()=>{
 let entered=false,release!:()=>void;
 const f=fixture('local',async()=>{entered=true;await new Promise<void>(r=>{release=r;});return 'prepare';});
 try{f.service.start();await wait(()=>entered);const stopped=f.service.stop();let settled=false;void stopped.then(()=>{settled=true;});await new Promise(r=>setTimeout(r,80));assert.equal(settled,true,'shutdown must not wait for relevance');release();await stopped;assert.equal(f.service.status().lastSync,undefined);assert.ok((f.journal.status(route) as {backlog:number}).backlog>0);}finally{release?.();await f.clean();}
});
test('stop aborts active relevance and does not complete its captured wake',async()=>{
 let entered=false;
 const f=fixture('local',async(_m,signal)=>{entered=true;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return undefined;});
 try{f.service.start();await wait(()=>entered);await f.service.stop();assert.equal(f.service.status().lastSync,undefined);assert.ok((f.journal.status(route) as {backlog:number}).backlog>0);}finally{await f.clean();}
});
