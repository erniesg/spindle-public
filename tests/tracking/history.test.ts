import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startTrackingServer } from '../../core/tracking/server.js';
import { TrackingClient } from '../../core/tracking/client.js';
import { AccountClient } from '../../core/account/client.js';
import { EncryptedStore } from '../../core/tracking/store.js';
import type { HistoryRecord, Operation } from '../../core/tracking/types.js';
import { validateOperation } from '../../core/tracking/types.js';
function observation(deviceId:string):Operation {
 const id=randomUUID(),now=Date.now();
 const record:HistoryRecord={schema:'spindle-tracking/v1',deviceId,recordingId:'recording',visitId:id,revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:1,expiresAt:now+60000,labelRevision:0,correctionRevision:0,scopes:{recording:true,retention:true,upload:true,pixels:false},activity:{awake:true,unlocked:true,inputAgeBucket:'over-5m',heartbeatAt:1,coverage:'observed'},visit:{id,key:'process-incarnation/window',app:'sample-editor',title:'Invented editing session',start:0,end:1000,clock:'native-clock-incarnation',revision:1,browser:false,text:'INVENTED_CONTEXT_SENTINEL',textSource:'native',url:'',image:'',availability:'native-text',sampledAt:1,framePTS:null,expiresAt:now+60000}};
 return {id:randomUUID(),deviceId,recordingId:'recording',visitId:id,record};
}
test('device-free account sessions read admitted history without enrolling or gaining write access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-history-reader-')),key=randomBytes(32),directory=join(dir,'server');
 const server=await startTrackingServer(directory,key);
 try{
  const collector=new TrackingClient(server.origin,join(dir,'collector'),randomBytes(32));
  await collector.signin('invented-reader','invented-password-123','Invented collector',true);
  const op=observation((await collector.inspect()).deviceId);await collector.enqueue(op);await collector.sync();
  const reader=new AccountClient(server.origin);await reader.signin('invented-reader','invented-password-123');
  const page=await reader.request('/history?cursor=0&limit=16') as {entries:{record:HistoryRecord}[]};
  assert.equal(page.entries.length,1);assert.equal(page.entries[0]!.record.visit.text,'INVENTED_CONTEXT_SENTINEL');
  await assert.rejects(reader.request('/sync',{operations:[op]}),/ACCOUNT_HTTP_403/);
  const foreign=new AccountClient(server.origin);await foreign.signin('invented-other','invented-password-123',true);
  assert.deepEqual((await foreign.request('/history?cursor=0') as {entries:unknown[]}).entries,[]);
  assert.equal((await fetch(server.origin+'/history',{headers:{Origin:server.origin}})).status,401);
  assert.equal((await fetch(server.origin+'/history',{headers:{Origin:'https://wrong.invalid'}})).status,403);
  const auth=await fetch(server.origin+'/signin',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'invented-reader',password:'invented-password-123'})});
  const cookie=auth.headers.get('set-cookie')!.split(';')[0]!,csrf=(await auth.json() as {csrf:string}).csrf;
  const denied=await fetch(server.origin+'/sync',{method:'POST',headers:{Origin:server.origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operations:[op]})});
  assert.equal(denied.status,403);assert.deepEqual(await denied.json(),{code:'DEVICE_REQUIRED'});
  const state=await new EncryptedStore<{accounts:{name:string;devices:unknown[]}[]}>(directory,key,()=>({accounts:[]})).transaction(s=>s,false);
  assert.equal(state.accounts.find(a=>a.name==='invented-reader')!.devices.length,1);
  assert.equal(state.accounts.find(a=>a.name==='invented-other')!.devices.length,0);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('string activity enums do not accept arrays',()=>{
 for(const [field,value] of [['coverage',['observed']],['inputAgeBucket',['unknown']]] as const){const op=observation('device');(op.record!.activity as unknown as Record<string,unknown>)[field]=value;assert.throws(()=>validateOperation(op),/INVALID_ACTIVITY/);}
});

test('saturated offline deletion survives restart, preserves unrelated work and prevents resurrection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-capacity-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 try{
  let a=new TrackingClient(server.origin,join(dir,'a'),key);await a.signin('capacity','invented-password-123','Mac',true);const device=(await a.inspect()).deviceId;
  const ops=Array.from({length:64},()=>observation(device));for(const op of ops)await a.enqueue(op);
  a=new TrackingClient(server.origin,join(dir,'a'),key);await a.enqueue(ops[0]!);assert.equal((await a.inspect()).pending,64);
  const first=ops[0]!;await a.enqueue({id:randomUUID(),deviceId:device,recordingId:first.recordingId,visitId:first.visitId,delete:true});
  await a.enqueue({id:randomUUID(),deviceId:device,recordingId:'recording',visitId:'unknown',delete:true});assert.equal((await a.inspect()).pending,65);
  await assert.rejects(a.enqueue(observation(device)),/PENDING_BOUND/);
  for(let i=0;i<63;i++)await a.enqueue({id:randomUUID(),deviceId:device,recordingId:'recording',visitId:`fence-${i}`,delete:true});
  a=new TrackingClient(server.origin,join(dir,'a'),key);
  await assert.rejects(a.enqueue({id:randomUUID(),deviceId:device,recordingId:'recording',visitId:'overflow',delete:true}),/PENDING_BOUND_DELETE_REQUIRES_SYNC/);
  assert.equal((await a.inspect()).pending,128);
  await a.enqueue({id:randomUUID(),deviceId:device,recordingId:'recording',visitId:'unknown',delete:true});
  assert.equal((await a.inspect()).pending,128);
  a=new TrackingClient(server.origin,join(dir,'a'),key);while((await a.inspect()).pending)await a.sync();while((await a.sync()).hasMore){}
  assert.equal((await a.inspect()).entries.length,128);assert.equal((await a.inspect()).entries.filter(e=>e.record).length,63);
  await a.enqueue(first);await a.sync();assert.equal((await a.inspect()).entries.find(e=>e.visitId===first.visitId)!.deleted,true);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

function maximumPng(width=1000,height=666){
 const chunk=(name:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 const stride=width*3+1,raw=width===1000&&height===666?randomBytes(height*stride):Buffer.alloc(height*stride);for(let i=0;i<height;i++)raw[i*stride]=0;
 const parts=[Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))];
 const pad=2_000_000-parts.reduce((n,b)=>n+b.length,0)-12;assert.ok(pad>=0);parts.splice(2,0,chunk('paDd',Buffer.alloc(pad)));return Buffer.concat(parts);
}
test('Node22 maximum 2MB valid PNG actual authenticated HTTP and encrypted store restart readback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tracking-rich-')),key=randomBytes(32),clientKey=randomBytes(32);let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin;
 try{
  let a=new TrackingClient(origin,join(dir,'a'),clientKey);await a.signin('rich','invented-password-123','Mac',true);const op=observation((await a.inspect()).deviceId),png=maximumPng();assert.equal(png.length,2_000_000);
  op.record!.scopes.pixels=true;op.record!.visit.image=png.toString('base64');validateOperation(op);
  const malformed=structuredClone(op);malformed.record!.visit.image+='=';assert.throws(()=>validateOperation(malformed),/PIXELS_DENIED/);
  // Cross-platform admission bounds total pixels, not the Mac producer's dimensions.
  const dimensions=Buffer.from(png);dimensions.writeUInt32BE(32769,16);dimensions.writeUInt32BE(1024,20);malformed.record!.visit.image=dimensions.toString('base64');assert.throws(()=>validateOperation(malformed),/PIXELS_DENIED/);
  const maximum=structuredClone(op);maximum.record!.visit.image=maximumPng(2560,1600).toString('base64');validateOperation(maximum);
  const tooTall=Buffer.from(png);tooTall.writeUInt32BE(1024,16);tooTall.writeUInt32BE(32769,20);malformed.record!.visit.image=tooTall.toString('base64');assert.throws(()=>validateOperation(malformed),/PIXELS_DENIED/);
  await a.enqueue(op);await a.sync();
  const reader=new AccountClient(origin);await reader.signin('rich','invented-password-123');
  type TextPage={entries:{key:string;deleted:boolean;record?:{visit:Record<string,unknown>;scopes:Record<string,unknown>}}[];cursor:number;hasMore:boolean};
  const projected=await reader.request('/user-memory/activity?cursor=0&limit=1') as TextPage;
  assert.equal(projected.entries.length,1);assert.ok(JSON.stringify(projected).length<10000);
  assert.deepEqual(Object.keys(projected.entries[0]!.record!.visit).sort(),['expiresAt','id','text','title']);
  assert.deepEqual(Object.keys(projected.entries[0]!.record!.scopes).sort(),['recording','retention','upload']);
  const next=observation(op.deviceId);await a.enqueue(next);await a.enqueue({id:randomUUID(),deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,delete:true});await a.sync();
  let cursor=projected.cursor;const seen:TextPage['entries']=[];
  do{const page=await reader.request(`/user-memory/activity?cursor=${cursor}&limit=1`) as TextPage;assert.ok(page.cursor>cursor);cursor=page.cursor;seen.push(...page.entries);if(!page.hasMore)break;}while(true);
  assert.ok(seen.some(e=>e.key===projected.entries[0]!.key&&e.deleted));assert.ok(seen.some(e=>e.record?.visit.text==='INVENTED_CONTEXT_SENTINEL'));
  // Keep the original Rich restart/readback checks on a separate admitted visit.
  const rich=observation(op.deviceId);rich.record!.scopes.pixels=true;rich.record!.visit.image=op.record!.visit.image;await a.enqueue(rich);await a.sync();
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));a=new TrackingClient(origin,join(dir,'a'),clientKey);await a.sync();assert.equal((await a.inspect()).entries.find(e=>e.visitId===rich.visitId)!.record!.visit.image,op.record!.visit.image);
  const b=new TrackingClient(origin,join(dir,'b'),randomBytes(32));await b.signin('rich','invented-password-123','Windows');await b.sync();assert.equal((await b.inspect()).entries.find(e=>e.visitId===rich.visitId)!.record!.visit.image,op.record!.visit.image);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('capture metadata cannot smuggle raw input fields',()=>{
 const op=observation('device');op.record!.visit.capture={pixels:'ok',ocr:'ok',image:'ok',sourceWidth:1,sourceHeight:1,imageWidth:1,imageHeight:1,ocrWidth:1,ocrHeight:1,typedKeys:'SECRET'} as never;
 assert.throws(()=>validateOperation(op));
});
test('real signin, two clients, encrypted restart, offline pending, isolation and deletion fences',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-tracking-test-')),key=randomBytes(32),clientKey=randomBytes(32);
 let server=await startTrackingServer(join(dir,'server'),key);const origin=server.origin;
 try{
  const a=new TrackingClient(origin,join(dir,'a'),clientKey),b=new TrackingClient(origin,join(dir,'b'),randomBytes(32));
  await a.signin('sample-account','invented-password-123','Mac invented',true);
  await b.signin('sample-account','invented-password-123','Windows invented');
  const bad=new TrackingClient(origin,join(dir,'bad'),randomBytes(32));await assert.rejects(bad.signin('sample-account','wrong-password-123','Bad'),/401/);
  const other=new TrackingClient(origin,join(dir,'other'),randomBytes(32));await other.signin('other-account','invented-password-456','Other',true);
  const op=observation((await a.inspect()).deviceId);await a.enqueue(op);await a.sync();await b.sync();assert.equal((await b.inspect()).entries[0]!.record!.visit.text,'INVENTED_CONTEXT_SENTINEL');
  await a.enqueue(op);await a.sync();assert.equal((await a.inspect()).entries.length,1);
  await other.sync();assert.equal((await other.inspect()).entries.length,0);await assert.rejects(other.enqueue(op),/DEVICE_DENIED/);
  await server.close();
  const second=observation(op.deviceId);await a.enqueue(second);await assert.rejects(a.sync());
  const restarted=new TrackingClient(origin,join(dir,'a'),clientKey);assert.equal((await restarted.inspect()).pending,1);
  server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));
  await restarted.signin('sample-account','invented-password-123','Mac invented');assert.equal((await restarted.inspect()).deviceId,op.deviceId);
  // Lose an actual committed HTTP reply, then replay the durable pending batch.
  const originalFetch=globalThis.fetch;let lost=false;
  globalThis.fetch=async(input,init)=>{const response=await originalFetch(input,init);if(String(input).endsWith('/sync')&&!lost){lost=true;await response.body?.cancel();throw Error('SIMULATED_LOST_REPLY');}return response;};
  try{await assert.rejects(restarted.sync(),/SIMULATED_LOST_REPLY/);}finally{globalThis.fetch=originalFetch;}
  assert.equal((await restarted.inspect()).pending,1);
  await restarted.sync();await b.sync();assert.equal((await b.inspect()).entries.length,2);
  // Higher revision arrives first; late older version cannot roll it back.
  const newer=structuredClone(second);newer.id=randomUUID();newer.record!.revision=3;newer.record!.visit.text='NEWER';await restarted.enqueue(newer);await restarted.sync();
  await restarted.enqueue({...second,id:randomUUID()});await restarted.sync();await b.sync();assert.equal((await b.inspect()).entries.find(e=>e.visitId===second.visitId)!.record!.visit.text,'NEWER');
  const deletion:Operation={id:randomUUID(),deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,delete:true};await b.enqueue(deletion);await b.sync();
  await restarted.enqueue({...op,id:randomUUID()});await restarted.sync();await b.sync();assert.equal((await b.inspect()).entries.find(e=>e.visitId===op.visitId)!.deleted,true);
  await server.close();server=await startTrackingServer(join(dir,'server'),key,Number(new URL(origin).port));await restarted.sync();assert.equal((await restarted.inspect()).entries.find(e=>e.visitId===op.visitId)!.record,undefined);
  const disk=await readFile(join(dir,'server','tracking.enc'));assert.equal(disk.includes(Buffer.from('INVENTED_CONTEXT_SENTINEL')),false);assert.equal(disk.includes(Buffer.from('invented-password')),false);
  const pendingDisk=await readFile(join(dir,'a','tracking.enc'));assert.equal(pendingDisk.includes(Buffer.from('NEWER')),false);
  await assert.rejects(startTrackingServer(join(dir,'server'),randomBytes(32)),/./);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
test('HTTP boundary rejects wrong origin, csrf, foreign device and malformed/bounded input',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-auth-test-'));const server=await startTrackingServer(dir,randomBytes(32));
 const call=async(path:string,body:unknown,cookie='',csrf='',origin=server.origin)=>fetch(server.origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify(body)});
 try{
  assert.equal((await call('/register',{name:'account',password:'invented-password'},'','','http://evil.invalid')).status,403);
  const auth=await call('/register',{name:'account',password:'invented-password'});const cookie=auth.headers.get('set-cookie')!.split(';')[0]!,csrf=(await auth.json() as {csrf:string}).csrf;
  assert.equal((await call('/devices',{name:'sample'},cookie,'wrong')).status,403);
  const bound=await call('/devices',{name:'sample'},cookie,csrf);const deviceId=(await bound.json() as {deviceId:string}).deviceId;
  const op=observation('foreign');assert.equal((await call('/sync',{operations:[op]},cookie,csrf)).status,403);
  const otherAuth=await call('/register',{name:'other-account',password:'invented-password'}),otherCookie=otherAuth.headers.get('set-cookie')!.split(';')[0]!,otherCsrf=(await otherAuth.json() as {csrf:string}).csrf;
  await call('/devices',{name:'other'},otherCookie,otherCsrf);
  assert.equal((await call('/sync',{operations:[observation(deviceId)]},otherCookie,otherCsrf)).status,403);
  assert.equal((await call('/sync',{operations:[{id:randomUUID(),deviceId,recordingId:'recording',visitId:'victim',delete:true}]},otherCookie,otherCsrf)).status,403);
  assert.equal((await call('/sync',{operations:Array(17).fill(observation(deviceId))},cookie,csrf)).status,400);
  assert.equal((await call('/sync',{x:'x'.repeat(3000001)},cookie,csrf)).status,413);
  assert.equal((await call('/sync',{operations:[{...observation(deviceId),record:{rawKeys:'secret'}}]},cookie,csrf)).status,400);
  await call('/logout',{},cookie,csrf);assert.equal((await call('/devices',{name:'sample'},cookie,csrf)).status,401);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
