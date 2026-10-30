import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';
import { driveOutputUploader, driveOutputGrants, DriveUploadError, type GeneratedDriveArtifact, type DriveUploadIntent, type DriveOutputContext } from '../../core/connectors/google/upload.js';
const sha = (b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const artifact = (mimeType='application/pdf'):GeneratedDriveArtifact=>{const bytes=Buffer.from(mimeType==='application/json'?'{"messages":[{"role":"user","content":"Invented request"}]}':'%PDF-invented-output');return {id:'generated-artifact',mimeType,sha256:sha(bytes),bytes};};
const metadata=(intent:DriveUploadIntent)=>({id:intent.providerId,name:intent.name,mimeType:intent.mimeType,parents:[intent.rootId],version:'19',size:String(intent.size),trashed:false,sha256Checksum:intent.sha256});
function fixture(options:{grants?:string[];roots?:string[];root?:Record<string,unknown>;provider?:(url:URL,init:RequestInit)=>Promise<Response>}={}){
 let current=true,selected=true;const calls:{url:URL;init:RequestInit}[]=[];
 let saved=JSON.stringify({accountId:'invented@example.test',connectionEpoch:'invented-epoch',refreshToken:'invented-refresh',grants:options.grants??[driveOutputGrants.file]});
 const http:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input));calls.push({url,init});
  if(url.hostname==='oauth2.googleapis.com')return Response.json({access_token:'invented-token'});
  if(url.pathname==='/drive/v3/files/root')return Response.json({id:'root',mimeType:'application/vnd.google-apps.folder',version:'3',trashed:false,isAppAuthorized:true,capabilities:{canAddChildren:true},...options.root});
  if(url.pathname==='/drive/v3/files/generateIds')return Response.json({ids:['reserved-output-id'],space:'drive'});
  if(options.provider)return options.provider(url,init);
  throw Error('Unexpected fixture request');
 };
 const oauth=new GoogleOAuth('invented-client',{get:async()=>saved,set:async()=>{throw Error('Unexpected set');},delete:async()=>{},compareAndSet:async(_id,old,value)=>{if(old!==saved)return false;saved=value;return true;}},http);
 const destination={rootId:'root',selectedRoots:new Set(options.roots??['root']),async assertCurrent(){if(!selected)throw Error('Selected root revision changed');}};
 const ctx:DriveOutputContext={signal:new AbortController().signal,isCurrent:()=>current};
 return {http,oauth,destination,ctx,calls,stale(){current=false;},deselect(){selected=false;},revoke(){const c=JSON.parse(saved);c.grants=[];saved=JSON.stringify(c);}};
}
async function uploader(f:ReturnType<typeof fixture>,grant=driveOutputGrants.file as string){return driveOutputUploader(f.oauth,'connection',f.destination,grant as typeof driveOutputGrants.file,f.http);}
function uncertain(error:unknown){assert.ok(error instanceof DriveUploadError);assert.equal(error.effect,'uncertain');return true;}

test('new multipart binary output retains exact bytes, original hash, selected parent and readback provenance',async()=>{
 let intent:DriveUploadIntent;const a=artifact();const original=Buffer.from(a.bytes);
 const f=fixture({provider:async(url,init)=>{
  assert.equal(url.origin,'https://www.googleapis.com');assert.equal(url.pathname,'/upload/drive/v3/files');assert.equal(url.searchParams.get('uploadType'),'multipart');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer invented-token');
  const boundary=headers.get('content-type')!.split('boundary=')[1];const body=Buffer.from(init.body as Uint8Array);
  const prefix=`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`;
  assert.ok(body.toString().startsWith(prefix));const end=body.indexOf('\r\n--'+boundary,prefix.length);
  assert.deepEqual(JSON.parse(body.subarray(prefix.length,end).toString()),{id:intent.providerId,name:'Filled form.pdf',mimeType:'application/pdf',parents:['root'],appProperties:{spindle:'output'}});
  assert.ok(body.includes(original));assert.ok(body.toString().endsWith(`\r\n--${boundary}--\r\n`));
  return Response.json(metadata(intent));
 }});
 const u=await uploader(f);intent=await u.prepare(a,'Filled form.pdf',f.ctx);
 assert.equal(f.calls.filter(c=>c.init.method==='POST'&&c.url.pathname.includes('/upload/')).length,0);
 const saved=JSON.parse(JSON.stringify(intent));const result=await u.upload(saved,a,f.ctx);
 assert.deepEqual(result,{intent:saved,providerVersion:'19',mimeType:a.mimeType,sha256Checksum:a.sha256,verification:'requires_readback'});
 assert.deepEqual(a.bytes,original);assert.equal(result.intent.sha256,sha(original));
 assert.ok(f.calls.every(c=>c.init.method!=='PATCH'&&c.init.method!=='DELETE'));
});

test('readonly/missing grant and unselected root fail before token refresh or Google network',async()=>{
 for(const options of [{grants:[scopes.drive]},{grants:[]},{roots:[]}]){
  const f=fixture(options);await assert.rejects(async()=>{const u=await uploader(f);await u.prepare(artifact(),'output.pdf',f.ctx);});assert.equal(f.calls.length,0);
 }
 const f=fixture();await assert.rejects(uploader(f,scopes.drive));assert.equal(f.calls.length,0);
});

test('drive.file does not infer existing-parent authorization from readonly visibility',async()=>{
 for(const root of [{isAppAuthorized:false},{isAppAuthorized:undefined},{capabilities:{canAddChildren:false}},{mimeType:'application/vnd.google-apps.shortcut'},{trashed:true},{id:'other'},{version:undefined}]){
  const f=fixture({root});const u=await uploader(f);await assert.rejects(u.prepare(artifact(),'output.pdf',f.ctx));assert.ok(f.calls.every(c=>!c.url.pathname.includes('generateIds')&&!c.url.pathname.includes('/upload/')));
 }
 // An actual broad grant works only when explicitly selected by trusted host; no scope request/fallback.
 const f=fixture({grants:[driveOutputGrants.all],root:{isAppAuthorized:false}});const u=await uploader(f,driveOutputGrants.all);await u.prepare(artifact(),'output.pdf',f.ctx);
});

test('bad generated bytes/hash/name/MIME/size deny before network; changed artifact cannot use an old intent',async()=>{
 const f=fixture();const u=await uploader(f);
 for(const [a,name] of [[{...artifact(),sha256:'0'.repeat(64)},'output.pdf'],[artifact(),'../original.pdf'],[artifact(),'bad\r\nname.pdf'],[artifact(),'x'.repeat(181)],[artifact('application/vnd.google-apps.document'),'output.pdf'],[{...artifact(),bytes:Buffer.alloc(5*1024*1024+1)},'output.pdf']] as [GeneratedDriveArtifact,string][]){await assert.rejects(u.prepare(a,name,f.ctx));}
 assert.equal(f.calls.length,0);
 const a=artifact();const intent=await u.prepare(a,'output.pdf',f.ctx);a.bytes[0]=0;
 const before=f.calls.length;await assert.rejects(u.upload(intent,a,f.ctx));assert.equal(f.calls.length,before);
});

test('cancelled/stale/deselected/revoked operations never start upload',async()=>{
 for(const change of ['cancel','stale','root','grant']){
  const f=fixture();const u=await uploader(f);const a=artifact();const intent=await u.prepare(a,'output.pdf',f.ctx);
  if(change==='cancel')f.ctx.signal=AbortSignal.abort();if(change==='stale')f.stale();if(change==='root')f.deselect();if(change==='grant')f.revoke();
  const before=f.calls.length;await assert.rejects(u.upload(intent,a,f.ctx));assert.equal(f.calls.length,before);
 }
});

test('post-dispatch cancellation/staleness/root removal and malformed replies are uncertain, not success',async()=>{
 for(const mode of ['cancel','stale','root','grant','bad-json','bad-id','bad-parent','bad-mime','bad-version','bad-size','bad-hash','no-checksum','oversize','http500']){
  let intent:DriveUploadIntent;const controller=new AbortController();const a=artifact();
  const f=fixture({provider:async()=>{
   if(mode==='cancel')controller.abort();if(mode==='stale')f.stale();if(mode==='root')f.deselect();if(mode==='grant')f.revoke();
   if(mode==='bad-json')return new Response('{');if(mode==='http500')return new Response('',{status:500});if(mode==='oversize')return new Response('x'.repeat(65537));
   const m:any=metadata(intent);if(mode==='bad-id')m.id='original';if(mode==='bad-parent')m.parents=['other'];if(mode==='bad-mime')m.mimeType='text/plain';if(mode==='bad-version')m.version='';if(mode==='bad-size')m.size='999';if(mode==='bad-hash')m.sha256Checksum='0'.repeat(64);if(mode==='no-checksum')delete m.sha256Checksum;
   return Response.json(m);
  }});f.ctx.signal=controller.signal;
  const u=await uploader(f);intent=await u.prepare(a,'output.pdf',f.ctx);
  if(mode==='no-checksum'){const result=await u.upload(intent,a,f.ctx);assert.equal(result.verification,'requires_readback');assert.equal(result.sha256Checksum,undefined);}
  else await assert.rejects(u.upload(intent,a,f.ctx),uncertain);
  assert.equal(f.calls.filter(c=>c.url.pathname.includes('/upload/')).length,1);
 }
});

test('lost response reconciles the saved ID across reconstruction; conflicts never overwrite originals',async()=>{
 let intent:DriveUploadIntent;let created=false;let attempts=0;
 const f=fixture({provider:async(url,init)=>{
  if(init.method==='POST'){attempts++;if(!created){created=true;throw Error('Invented response lost');}return new Response('',{status:409});}
  assert.equal(url.pathname,'/drive/v3/files/reserved-output-id');return created?Response.json(metadata(intent)):new Response('',{status:404});
 }});
 const a=artifact();let u=await uploader(f);intent=await u.prepare(a,'output.pdf',f.ctx);
 assert.equal(await u.reconcile(intent,f.ctx),undefined);
 await assert.rejects(u.upload(intent,a,f.ctx),uncertain);assert.equal(attempts,1);
 u=await uploader(f);intent=JSON.parse(JSON.stringify(intent));const result=await u.reconcile(intent,f.ctx);assert.equal(result?.intent.providerId,intent.providerId);
 const retried=await u.upload(intent,a,f.ctx);assert.equal(retried.intent.providerId,intent.providerId);assert.equal(attempts,2);
 assert.equal(f.calls.filter(c=>c.url.pathname.endsWith('/generateIds')).length,1);
 assert.ok(f.calls.every(c=>c.init.method!=='PATCH'&&c.init.method!=='DELETE'));
});

test('409 mismatch and hung transport remain uncertain; no automatic POST retry',async()=>{
 for(const mode of ['conflict','hang']){
  let intent:DriveUploadIntent;const controller=new AbortController();
  const f=fixture({provider:async(_url,init)=>{if(init.method==='POST'){if(mode==='hang'){queueMicrotask(()=>controller.abort());return new Promise<Response>(()=>{});}return new Response('',{status:409});}return Response.json({...metadata(intent),sha256Checksum:'0'.repeat(64)});}});
  const u=await uploader(f);const a=artifact();intent=await u.prepare(a,'output.pdf',f.ctx);f.ctx.signal=controller.signal;
  await assert.rejects(u.upload(intent,a,f.ctx),uncertain);assert.equal(f.calls.filter(c=>c.url.pathname.includes('/upload/')).length,1);
 }
});

test('upload snapshots host-owned bytes and intent before awaits; later mutation cannot alter the dispatched artifact',async()=>{
 const a=artifact();const original=Buffer.from(a.bytes);let intent:DriveUploadIntent;let uploading=false;
 const f=fixture({provider:async(_url,init)=>{assert.ok(Buffer.from(init.body as Uint8Array).includes(original));return Response.json(metadata(saved));}});
 const u=await uploader(f);intent=await u.prepare(a,'Output.pdf',f.ctx);const saved={...intent};
 // Mutate at the first destination fence, after upload's synchronous snapshot.
 const current=f.destination.assertCurrent.bind(f.destination);
 f.destination.assertCurrent=async()=>{if(uploading){a.bytes.fill(0);intent.name='Changed.pdf';intent.providerId='original-file';}await current();};
 uploading=true;const result=await u.upload(intent,a,f.ctx);assert.deepEqual(result.intent,saved);
});

test('stale root metadata blocks subsequent create; late responses and streamed body cancellation settle finitely',async()=>{
 for(const mode of ['root-stale','late-response','body-abort']){
  let intent:DriveUploadIntent;let uploading=false;let cancelled=0;const controller=new AbortController();
  const f=fixture({provider:async()=>{
   if(mode==='late-response'){queueMicrotask(()=>controller.abort());return new Promise<Response>(resolve=>{setImmediate(()=>resolve(new Response(new ReadableStream({cancel(){cancelled++;}}))));});}
   return new Response(new ReadableStream({start(c){c.enqueue(Buffer.from('{'));queueMicrotask(()=>controller.abort());},cancel(){cancelled++;}},{highWaterMark:0}));
  }});
  const base=f.http;const http:typeof fetch=async(input,init)=>{const r=await base(input,init);if(uploading&&mode==='root-stale'&&String(input).includes('/files/root?'))f.stale();return r;};
  const u=await driveOutputUploader(f.oauth,'connection',f.destination,driveOutputGrants.file,http);const a=artifact();intent=await u.prepare(a,'Output.pdf',f.ctx);uploading=true;f.ctx.signal=controller.signal;
  if(mode==='root-stale'){await assert.rejects(u.upload(intent,a,f.ctx),e=>{assert.ok(e instanceof DriveUploadError);assert.equal(e.effect,'none');return true;});assert.equal(f.calls.filter(c=>c.url.pathname.includes('/upload/')).length,0);}
  else{await assert.rejects(u.upload(intent,a,f.ctx),uncertain);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancelled,1);}
 }
});

test('intent namespace/content rebinding denies before network and selected-root sets are copied',async()=>{
 const f=fixture();const u=await uploader(f);const a=artifact();const intent=await u.prepare(a,'Output.pdf',f.ctx);
 for(const changed of [{rootId:'elsewhere'},{accountId:'other@example.test'},{connectionEpoch:'new-epoch'},{artifactId:'different-artifact'},{providerId:'root'},{sha256:'0'.repeat(64)},{mimeType:'text/plain'},{size:1}]){
  const before=f.calls.length;await assert.rejects(u.upload({...intent,...changed},a,f.ctx));assert.equal(f.calls.length,before);
 }
 f.destination.selectedRoots.add('elsewhere');await assert.rejects(u.upload({...intent,rootId:'elsewhere'},a,f.ctx));
});

test('sanitized generated session JSON uses the same immutable artifact upload path',async()=>{
 let intent:DriveUploadIntent;const a=artifact('application/json');const f=fixture({provider:async()=>Response.json(metadata(intent))});const u=await uploader(f);
 intent=await u.prepare(a,'Session.json',f.ctx);const r=await u.upload(intent,a,f.ctx);assert.equal(r.intent.artifactId,a.id);assert.equal(r.intent.sha256,a.sha256);assert.equal(r.mimeType,'application/json');
});
