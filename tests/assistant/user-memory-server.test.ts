// Optional real account-server boundary. Explicit absolute operator module only; never a repository dependency.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {isAbsolute,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {scripted} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {USER_MEMORY_LIMITS as limits,type UserMemoryMutation,type UserMemorySource} from '../../core/memory/user-protocol.js';
const modulePath=process.env.SPINDLE_MEMORY_SERVER_MODULE;
test('real account server: Unicode byte-bounded queues retry stable IDs, read deletion while pending and accept only interoperable user provenance',{skip:!modulePath},async()=>{
 if(!isAbsolute(modulePath!))throw Error('ABSOLUTE_SERVER_MODULE_REQUIRED');
 const module=await import(pathToFileURL(modulePath!).href) as {startTrackingServer:(directory:string,key:Buffer)=>Promise<{origin:string;close:()=>Promise<void>}>};
 const root=mkdtempSync(join(tmpdir(),'spindle-memory-bytes-')),server=await module.startTrackingServer(join(root,'server'),randomBytes(32));
 const ea=new EvidenceStore(join(root,'a')),eb=new EvidenceStore(join(root,'b'));const sent:UserMemoryMutation[][]=[];let loseAck=false;
 const aa=new AccountClient(server.origin,async(input,init)=>{
  if(new URL(String(input)).pathname==='/user-memory/sync'){
   assert.ok(Buffer.byteLength(String(init?.body),'utf8')<=limits.requestBytes);sent.push((JSON.parse(String(init?.body)) as {operations:UserMemoryMutation[]}).operations);
   const response=await fetch(input,init);if(loseAck){loseAck=false;await response.body?.cancel();throw Error('INVENTED_LOST_ACK');}return response;
  }return fetch(input,init);
 }),ab=new AccountClient(server.origin);
 const application=(evidence:EvidenceStore,label:string,account:AccountClient)=>createUserMemoryApplication({evidence,evidenceRoot:join(root,label),account,workspaceId:'sample-workspace',provider:scripted()});
 const a=application(ea,'a',aa),b=application(eb,'b',ab),off={conversation:false,activity:false,processing:false,sync:false};
 try{
  await a.signin('memory-bytes','Invented-only-password-98!',true);await a.drain();await b.signin('memory-bytes','Invented-only-password-98!');await b.drain();
  b.configure({...off,sync:true});await b.drain();b.correct('delete-me','fact','Incoming deletion sentinel',0);await b.drain();a.configure({...off,sync:true});await a.drain();assert.equal(a.recall('sentinel').length,1);
  a.configure(off);await a.drain();b.forget('delete-me');await b.drain();
  for(let i=0;i<16;i++){a.correct(String(i).padStart(2,'0')+'鍵'.repeat(8190),'fact','值'.repeat(8192),0);await a.drain();}
  const ns={workspaceId:'sample-workspace',accountId:aa.account!.id},store=new UserMemoryStore(ea.db),queued=store.outbox(ns);
  assert.equal(queued.length,16);assert.ok(Buffer.byteLength(JSON.stringify({operations:queued}))>limits.requestBytes);
  loseAck=true;a.configure({...off,sync:true});await a.drain();assert.equal(store.outbox(ns).length,16);await a.drain();
  assert.deepEqual(sent[0],sent[1]);assert.ok(store.outbox(ns).length>0);assert.equal(store.canonical(ns,'delete-me')?.deleted,true);assert.deepEqual(a.recall('sentinel'),[]);
  for(let i=0;i<16&&store.outbox(ns).length;i++)await a.drain();assert.equal(store.outbox(ns).length,0);assert.deepEqual(sent.slice(1).flat().map(o=>o.id),queued.map(o=>o.id));
  await b.drain();for(const op of queued)assert.equal(new UserMemoryStore(eb.db).canonical(ns,op.key)?.value,op.value);
  const source:UserMemorySource={id:'source-event',kind:'activity',sourceId:'source',...ns,sha256:'a'.repeat(64),excerpt:'Invented provenance',observedAt:new Date().toISOString(),activityKey:'not-a-history-key',activityRevision:0};
  const mutation:UserMemoryMutation={id:'invalid-source',workspaceId:ns.workspaceId,key:'metadata',expectedRevision:0,action:'put',kind:'fact',value:'Independent correction',origin:'user',sources:[source]};
  await assert.rejects(ab.request('/user-memory/sync',{operations:[mutation]}),/ACCOUNT_HTTP_400/);
  await ab.request('/user-memory/sync',{operations:[{...mutation,id:'valid-source',sources:[{...source,activityKey:'device/recording/visit'}]}]});
  await a.drain();assert.equal(store.canonical(ns,'metadata')?.value,'Independent correction');assert.equal(store.canonical(ns,'metadata')?.sources?.[0].activityKey,'device/recording/visit');assert.equal(a.status().authenticated&&a.status().error,'');
 }finally{await a.stop();await b.stop();ea.close();eb.close();await server.close();rmSync(root,{recursive:true,force:true});}
});
test('real account server: two-client learning/recall, other-user denial, client/server restart, correction and forget',{skip:!modulePath},async()=>{
 if(!isAbsolute(modulePath!))throw Error('ABSOLUTE_SERVER_MODULE_REQUIRED');
 const module=await import(pathToFileURL(modulePath!).href) as {startTrackingServer:(directory:string,key:Buffer)=>Promise<{origin:string;close:()=>Promise<void>}>};
 const root=mkdtempSync(join(tmpdir(),'spindle-shared-memory-')),key=randomBytes(32);let server=await module.startTrackingServer(join(root,'server'),key);
 let ea=new EvidenceStore(join(root,'a')),eb=new EvidenceStore(join(root,'b'));const ec=new EvidenceStore(join(root,'c'));
 const application=(evidence:EvidenceStore,label:string)=>createUserMemoryApplication({evidence,evidenceRoot:join(root,label),account:new AccountClient(server.origin),workspaceId:'sample-workspace',provider:scripted()});
 let a=application(ea,'a'),b=application(eb,'b');const c=application(ec,'c');
 const choices={conversation:true,activity:false,processing:true,sync:true};
 try{
  await a.signin('memory-sample','Invented-only-password-98!',true);await a.drain();await b.signin('memory-sample','Invented-only-password-98!');await b.drain();a.configure(choices);await a.drain();b.configure(choices);await b.drain();a.conversation('I prefer tea');await a.drain();await b.drain();assert.equal(b.recall('tea')[0]?.value,'I prefer tea.');assert.equal(b.recall('tea')[0].pending,false);
  const entry=b.recall('tea')[0];b.correct(entry.key,'preference','Prefers coffee',entry.revision);await b.drain();await a.drain();assert.equal(a.recall('coffee')[0]?.origin,'user');
  await c.signin('other-memory-user','Invented-other-password-98!',true);await c.drain();c.configure(choices);await c.drain();assert.deepEqual(c.recall('coffee'),[]);
  await a.stop();await b.stop();await c.stop();ea.close();eb.close();await server.close();server=await module.startTrackingServer(join(root,'server'),key);
  ea=new EvidenceStore(join(root,'a'));eb=new EvidenceStore(join(root,'b'));a=application(ea,'a');b=application(eb,'b');assert.equal(a.status().authenticated,false);assert.equal(b.status().authenticated,false);
  await a.signin('memory-sample','Invented-only-password-98!');await a.drain();await b.signin('memory-sample','Invented-only-password-98!');await b.drain();assert.equal(a.recall('coffee')[0]?.origin,'user');assert.equal(b.recall('coffee')[0]?.value,'Prefers coffee');
  a.forget('drink');await a.drain();await b.drain();assert.deepEqual(b.recall('coffee'),[]);
 }finally{await a.stop();await b.stop();await c.stop();ea.close();eb.close();ec.close();await server.close();rmSync(root,{recursive:true,force:true});}
});
