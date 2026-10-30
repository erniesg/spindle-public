// Optional actual authenticated backend boundary. Invented admitted activity, no native capture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {isAbsolute,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {AccountClient} from '../../core/account/client.js';
import {EvidenceStore} from '../../core/evidence/store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {USER_MEMORY_LIMITS} from '../../core/memory/user-protocol.js';
import {scripted} from './user-memory-fixture.js';
const modulePath=process.env.SPINDLE_MEMORY_SERVER_MODULE;
// Checksum-correct maximum supported Rich fixture; no actual screen content.
function maximumPng(){
 const chunk=(name:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1000);ihdr.writeUInt32BE(666,4);ihdr[8]=8;ihdr[9]=2;
 const raw=randomBytes(666*3001);for(let i=0;i<666;i++)raw[i*3001]=0;
 const parts=[Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))];
 const pad=2_000_000-parts.reduce((n,b)=>n+b.length,0)-12;assert.ok(pad>=0);parts.splice(2,0,chunk('paDd',Buffer.alloc(pad)));return Buffer.concat(parts);
}
test('actual backend: Rich text projection, offline learner deletion, memory-only peer/restart, late source conflict and maximum keys',{skip:!modulePath},async()=>{
 if(!isAbsolute(modulePath!))throw Error('ABSOLUTE_SERVER_MODULE_REQUIRED');
 const module=await import(pathToFileURL(modulePath!).href) as {startTrackingServer:(directory:string,key:Buffer)=>Promise<{origin:string;close:()=>Promise<void>}>};
 const root=mkdtempSync(join(tmpdir(),'spindle-activity-memory-')),key=randomBytes(32);let server=await module.startTrackingServer(join(root,'server'),key);
 let ea=new EvidenceStore(join(root,'a')),eb=new EvidenceStore(join(root,'b'));let modelCalls=0;const base=scripted();
 const application=(evidence:EvidenceStore,label:string,learning=false)=>createUserMemoryApplication({evidence,evidenceRoot:join(root,label),account:new AccountClient(server.origin),workspaceId:'activity-workspace',...(learning?{provider:{id:'scripted-not-model-quality',next(...args:Parameters<typeof base.next>){modelCalls++;assert.doesNotMatch(args[0].requestedOutcome,/NEVER_SEND_URL/);return base.next(...args);}}}:{})});
 let a=application(ea,'a',true),b=application(eb,'b');
 try{
  const producer=new AccountClient(server.origin);await producer.signin('activity-sample','Invented-activity-password-98!',true);
  // Explicit run-owned collector fixture uses the existing 3MB upload contract, not the memory client's 1MB request bound.
  const auth=await fetch(server.origin+'/signin',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'activity-sample',password:'Invented-activity-password-98!'})});assert.equal(auth.status,200);
  const cookie=auth.headers.get('set-cookie')!.split(';')[0],csrf=(await auth.json() as {csrf:string}).csrf;
  const upload=async(path:string,data:unknown)=>{const response=await fetch(server.origin+path,{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(data)});assert.equal(response.status,200);return response.json();};
  const {deviceId}=await upload('/devices',{name:'Invented source producer'}) as {deviceId:string};
  const now=Date.now(),source={deviceId,recordingId:'sample-recording',visitId:'sample-visit'};
  const record={schema:'spindle-tracking/v1',...source,revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+600000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:true},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:1,coverage:'observed'},visit:{id:source.visitId,key:'sample-window',app:'sample-editor',title:'Invented activity',start:0,end:1000,clock:'sample-source-clock',revision:1,browser:false,text:'I prefer tea',textSource:'native',url:'https://example.test/NEVER_SEND_URL',image:maximumPng().toString('base64'),availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+600000}};
  await upload('/sync',{operations:[{id:randomUUID(),...source,record}]});
  await a.signin('activity-sample','Invented-activity-password-98!');await a.drain();await b.signin('activity-sample','Invented-activity-password-98!');await b.drain();
  a.configure({conversation:false,activity:true,processing:true,sync:true});await a.drain();
  const state=a.status();assert.equal(state.authenticated&&state.activityError,'');const learned=a.recall('tea')[0];assert.equal(learned?.origin,'inferred');assert.equal(learned.sources?.[0].activityKey,`${deviceId}/sample-recording/sample-visit`);assert.equal(learned.sources?.[0].activityRevision,1);assert.equal(modelCalls,2);
  await a.drain();assert.equal(modelCalls,2);b.configure({conversation:false,activity:false,processing:false,sync:true});await b.drain();assert.equal(b.recall('tea')[0]?.value,'I prefer tea.');
  // API-valid pre-existing long rows must not poison this memory-only reader's cursor.
  for(const length of [513,USER_MEMORY_LIMITS.key])await producer.request('/user-memory/sync',{operations:[{id:randomUUID(),workspaceId:'activity-workspace',key:'k'.repeat(length),expectedRevision:0,action:'put',origin:'user',kind:'fact',value:`Key length ${length}`,sources:[]}]});
  await b.drain();assert.equal(b.recall('length').length,2);assert.doesNotThrow(()=>b.status('k'.repeat(USER_MEMORY_LIMITS.key)));
  // A queues an offline derived put, then remains entirely stopped while the source is removed.
  a.configure({conversation:false,activity:false,processing:false,sync:false});await a.drain();const n={workspaceId:'activity-workspace',accountId:(a.status() as {account:{id:string}}).account.id};
  new UserMemoryStore(ea.db).mutate(n,{key:'offline-copy',kind:'preference',value:'Prefers tea',origin:'inferred',sources:learned.sources});
  await a.stop();await upload('/sync',{operations:[{id:randomUUID(),...source,delete:true}]});await b.drain();assert.deepEqual(b.recall('tea'),[],'memory-only B must receive the shared tombstone without A');
  assert.equal(modelCalls,2);await producer.signout();await b.stop();ea.close();eb.close();await server.close();
  server=await module.startTrackingServer(join(root,'server'),key);ea=new EvidenceStore(join(root,'a'));eb=new EvidenceStore(join(root,'b'));a=application(ea,'a',true);b=application(eb,'b');
  await b.signin('activity-sample','Invented-activity-password-98!');await b.drain();assert.deepEqual(b.recall('tea'),[],'shared deletion survives server/client restart');assert.equal(b.recall('length').length,2);
  await a.signin('activity-sample','Invented-activity-password-98!');await a.drain();a.configure({conversation:false,activity:false,processing:false,sync:true});await a.drain();
  const conflict=a.status();assert.equal(conflict.authenticated&&conflict.error,'ACCOUNT_HTTP_409','stale offline source put is visibly rejected');assert.deepEqual(a.recall('tea'),[]);await b.drain();assert.deepEqual(b.recall('tea'),[]);assert.equal(modelCalls,2,'privacy invalidation does not invoke extraction');
 }finally{await a.stop();await b.stop();ea.close();eb.close();await server.close();rmSync(root,{recursive:true,force:true});}
});
