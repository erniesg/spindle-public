import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { TrackingClient } from '../../core/tracking/client.js';
import { EncryptedStore } from '../../core/tracking/store.js';
import { type Entry } from '../../core/tracking/types.js';

test('explicit mock HTTP responses: reject duplicate acknowledgements and malformed pages before persistence',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-malformed-')),key=randomBytes(32);let reply:unknown={};
 const server=createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(reply));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const state={schema:1,origin,account:'invented',cookie:'mock-session',csrf:'mock-csrf',deviceId:'device',deviceSecret:'mock-secret',deviceName:'mock',pending:[] as unknown[],cursor:0,entries:[] as Entry[],lastSync:null,error:''};
 const store=new EncryptedStore(join(dir,'client'),key,()=>state);
 const tomb=(id:string,seq:number)=>({key:`device/recording/${id}`,deviceId:'device',recordingId:'recording',visitId:id,seq,deleted:true});
 try{
  await store.transaction(s=>{s.pending=['A','B'].map(id=>({id,deviceId:'device',recordingId:'recording',visitId:id,delete:true}));});
  let client=new TrackingClient(origin,join(dir,'client'),key);reply={acknowledged:['A','A']};
  await t.test('duplicate ACK retains both pending operations',async()=>{await assert.rejects(client.sync(),/INVALID_ACK/);assert.equal((await client.inspect()).pending,2);});
  await store.transaction(s=>{s.pending=[];});
  const valid=tomb('A',1);
  const cases:unknown[]=[
   {entries:[],cursor:2,hasMore:false},{entries:[],cursor:0,hasMore:true},
   {entries:[valid],cursor:1,hasMore:'false'}, {entries:[valid],cursor:2,hasMore:false},
   {entries:[{...valid,key:'wrong'}],cursor:1,hasMore:false},
   {entries:[{...valid,deleted:'true'}],cursor:1,hasMore:false},
   {entries:[{...valid,rawKeys:'SECRET'}],cursor:1,hasMore:false},
   {entries:[{...valid,deleted:false}],cursor:1,hasMore:false},
   {entries:[{...valid,record:{}}],cursor:1,hasMore:false},
   {entries:[{...valid,deleted:false,record:{}}],cursor:1,hasMore:false},
   {entries:[tomb('B',2),valid],cursor:1,hasMore:false},
   {entries:[valid,{...valid,seq:2}],cursor:2,hasMore:false},
   {entries:Array.from({length:17},(_,i)=>tomb(`v${i}`,i+1)),cursor:17,hasMore:false},
   {entries:[{...valid,raw:'x'.repeat(3_100_001)}],cursor:1,hasMore:false},
  ];
  for(const [i,response] of cases.entries())await t.test(`malformed page ${i}`,async()=>{
   await store.transaction(s=>{s.entries=[];s.cursor=0;});client=new TrackingClient(origin,join(dir,'client'),key);reply=response;
   await assert.rejects(client.sync());client=new TrackingClient(origin,join(dir,'client'),key);const s=await client.inspect();assert.equal(s.cursor,0);assert.deepEqual(s.entries,[]);
  });
  await store.transaction(s=>{s.entries=[];s.cursor=0;});
  reply={entries:[valid],cursor:1,hasMore:false};await client.sync();assert.equal((await client.inspect()).entries.length,1);
  await store.transaction(s=>{s.entries=[{...valid,rawKeys:'SECRET'} as Entry];});await assert.rejects(client.inspect());
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
