// Actual application/authenticated backend; only inference decisions are scripted. No capture/provider network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
const modulePath=process.env.SPINDLE_MEMORY_SERVER_MODULE;
for(const sameKey of [false,true])test(`actual backend: activity replacement ${sameKey?'same':'different'} key, offline/restart/lost ACK and permanent forget`,{skip:!modulePath},async()=>{
 if(!isAbsolute(modulePath!))throw Error('ABSOLUTE_SERVER_MODULE_REQUIRED');
 const module=await import(pathToFileURL(modulePath!).href) as {startTrackingServer:(directory:string,key:Buffer)=>Promise<{origin:string;close:()=>Promise<void>}>};
 const root=mkdtempSync(join(tmpdir(),'spindle-revision-')),server=await module.startTrackingServer(join(root,'server'),randomBytes(32));
 let ea=new EvidenceStore(join(root,'a'));const eb=new EvidenceStore(join(root,'b'));let revision=1,lost=false,loseNext=false;const writes:Array<{path:string;body:any}>=[];
 const account=new AccountClient(server.origin,async(input,init)=>{const path=new URL(String(input)).pathname;if(init?.body&&path.startsWith('/user-memory/'))writes.push({path,body:JSON.parse(String(init.body))});const response=await fetch(input,init);if(path==='/user-memory/sync'&&response.ok&&loseNext){loseNext=false;lost=true;throw Error('lost ACK');}return response;});
 const memoryKey=()=>sameKey?'drink':`drink-${revision}`;
 const application=()=>createUserMemoryApplication({evidence:ea,evidenceRoot:join(root,'a'),account,workspaceId:'w',provider:{id:'scripted-zero-network',async next(t){return t.observations.length?{kind:'ready',result:'Done'}:{kind:'tool',name:'memory.learn',args:{key:memoryKey(),kind:'preference',value:revision===1?'Prefers tea':'Prefers coffee',quote:revision===1?'I prefer tea':'I prefer coffee'}};}}});
 let a=application();const b=createUserMemoryApplication({evidence:eb,evidenceRoot:join(root,'b'),account:new AccountClient(server.origin),workspaceId:'w'});const producer=new AccountClient(server.origin);
 const choices={conversation:false,activity:true,processing:true,sync:true};
 try{
  await producer.signin('invented-revision','invented-password-123',true);const {deviceId}=await producer.request('/devices',{name:'Invented producer'}) as {deviceId:string};
  const now=Date.now(),identity={deviceId,recordingId:'recording',visitId:'visit'};
  const record={schema:'spindle-tracking/v1',...identity,revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'unknown',heartbeatAt:1,coverage:'observed'},visit:{id:'visit',key:'window',app:'sample',title:'Invented preference',start:0,end:1000,clock:'clock',revision:1,browser:false,text:'I prefer tea',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+600000}};
  const upload=()=>producer.request('/sync',{operations:[{id:randomUUID(),...identity,record}]});
  await upload();await a.signin('invented-revision','invented-password-123');await a.drain();await b.signin('invented-revision','invented-password-123');await b.drain();
  a.configure(choices);await a.drain();b.configure({...choices,activity:false,processing:false});await b.drain();assert.equal(b.recall('tea')[0]?.pending,false);
  const original=a.recall('tea')[0],oldSource=original.sources![0],oldKey=original.key;
  const ns={workspaceId:'w',accountId:account.account!.id};
  // The server must invalidate unsupported inference without any new extraction.
  a.configure({...choices,processing:false});await a.drain();revision=2;record.revision=2;record.visit.revision=2;record.visit.text='I prefer coffee';await upload();await b.drain();assert.deepEqual(b.recall('tea'),[]);
  const tombstone=new UserMemoryStore(eb.db).canonical(ns,oldKey)!;assert.equal(tombstone.deletionReason,'source_invalidated');
  // Offline learning sees the real new history, not a source alias. Restart before resync.
  a.configure({...choices,sync:false});await a.drain();assert.equal(a.recall('coffee')[0]?.pending,true);const fresh=a.recall('coffee')[0].sources![0];assert.equal(fresh.activityKey,oldSource.activityKey);assert.equal(fresh.activityRevision,2);assert.notEqual(fresh.sourceId,oldSource.sourceId);
  if(sameKey){
   const put=(sources:typeof original.sources,expectedRevision:number)=>producer.request('/user-memory/sync',{operations:[{id:randomUUID(),workspaceId:'w',key:oldKey,expectedRevision,action:'put',origin:'inferred',kind:'preference',value:'Prefers coffee',sources}]});
   await assert.rejects(put([fresh],0),/ACCOUNT_HTTP_409/,'fresh provenance does not bypass exact tombstone CAS');
   await assert.rejects(put([oldSource],tombstone.revision),/ACCOUNT_HTTP_409/,'exact CAS does not bless the obsolete source');
  }
  assert.equal(new UserMemoryStore(ea.db).sourceOutbox(ns).length,0);assert.equal(writes.filter(w=>w.path==='/user-memory/forget-source').length,0);
  await a.stop();ea.close();ea=new EvidenceStore(join(root,'a'));a=application();await a.signin('invented-revision','invented-password-123');await a.drain();loseNext=true;a.configure(choices);await a.drain();for(let i=0;i<4;i++)await a.drain();await b.drain();
  assert.ok(lost);const syncWrites=writes.filter(w=>w.path==='/user-memory/sync').map(w=>JSON.stringify(w.body));assert.ok(syncWrites.some((body,i)=>syncWrites.indexOf(body)<i),'lost ACK retries the exact stable payload');assert.equal(a.status().authenticated&&(a.status() as any).pending,0);assert.equal((a.status() as any).error,'');assert.equal(b.recall('coffee')[0]?.value,'I prefer coffee.');assert.deepEqual(b.recall('tea'),[]);
  const store=new UserMemoryStore(ea.db);assert.equal(store.sourceOutbox(ns).length,0);assert.equal(store.jobs(ns).find(j=>j.source.id===oldSource.id)?.state,'cancelled');
  // Same history identity's later revision is usable, but user corrections cannot be overwritten by replacement.
  const coffee=b.recall('coffee')[0];b.correct(coffee.key,'preference','User chooses cocoa',coffee.revision);await b.drain();await a.drain();revision=3;record.revision=3;record.visit.revision=3;await upload();await a.drain();await b.drain();assert.equal(b.recall('cocoa')[0]?.origin,'user');
  // Explicit source forget still fences ALL later revisions and new-key attempts on that identity.
  const current=store.jobs(ns).find(j=>j.source.activityRevision===3)!;
  await producer.request('/user-memory/forget-source',{id:randomUUID(),workspaceId:'w',kind:'activity',sourceId:current.source.sourceId,activityKey:current.source.activityKey});
  revision=4;record.revision=4;record.visit.revision=4;await upload();
  await assert.rejects(producer.request('/user-memory/sync',{operations:[{id:randomUUID(),workspaceId:'w',key:'brand-new-after-forget',expectedRevision:0,action:'put',origin:'inferred',kind:'preference',value:'Prefers coffee',sources:[{...current.source,activityRevision:4}]}]}),/ACCOUNT_HTTP_409/);
  // Explicit key forget clears the revivable marker and cannot be inferred back even with fresh provenance.
  await b.drain();b.forget(oldKey);await b.drain();const permanent=new UserMemoryStore(eb.db).canonical(ns,oldKey)!;assert.equal(permanent.deleted,true);assert.equal(permanent.deletionReason,undefined);
  const {activityKey,activityRevision,...unrelated}=current.source;
  await assert.rejects(producer.request('/user-memory/sync',{operations:[{id:randomUUID(),workspaceId:'w',key:oldKey,expectedRevision:permanent.revision,action:'put',origin:'inferred',kind:'fact',value:'unrelated valid source',sources:[{...unrelated,id:'unrelated',sourceId:randomUUID(),kind:'conversation'}]}]}),/ACCOUNT_HTTP_409/,'permanent key forget rejects even unrelated unfenced inference');
  await a.drain();assert.equal(store.sourceForgotten(ns,oldSource),true);assert.throws(()=>store.mutate(ns,{key:oldKey,kind:'preference',value:'late tea',origin:'inferred',sources:[oldSource]}),/SOURCE_FORGOTTEN/);
 }finally{await a.stop();await b.stop();await producer.signout();ea.close();eb.close();await server.close();rmSync(root,{recursive:true,force:true});}
});
