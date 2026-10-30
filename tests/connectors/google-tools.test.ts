import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AgentRuntime } from '../../core/agent/runtime.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleSourceTools } from '../../core/connectors/google/tools.js';
import { GoogleOAuth } from '../../core/connectors/google/oauth.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { SelectedMail } from '../../core/connectors/google/mail.js';
for(const rootAttachment of [false,true])test(`runtime consumes registered mail parts and durable exact-byte snapshots (root=${rootAttachment})`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'google-runtime-'));let evidence=new EvidenceStore(root);const state=new AgentStore(':memory:');
 try {
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const raw={id:'m',historyId:'7',payload:{partId:'opaque-part',mimeType:'text/plain',headers:[{name:'Subject',value:'Invented request'},{name:'From',value:'invented@example.test'}],body:{data:'SGVsbG8',size:5},parts:[{partId:'attachment',mimeType:'application/octet-stream',body:{attachmentId:'provider-attachment',size:2}}]}};
 if(rootAttachment)Object.assign(raw.payload,{partId:'',body:{attachmentId:'provider-attachment',size:2},parts:[]});
 const tools=await googleSourceTools(oauth,'c','w',new Set(['m']),evidence,async url=>Response.json(String(url).includes('/attachments/')?{data:'AP8',size:2}:raw));
 const attachmentTool=tools.find(t=>t.name==='mail.attachments')!;
 assert.throws(()=>attachmentTool.inputSchema.parse({messageId:'',partId:''}));
 const task=state.admit({accountId:'a',workspaceId:'w',messageId:'m',outcome:'read invented mail'},10);
 await new AgentRuntime(state,tools).run(task.id,{id:'script-not-live-model',async next(s){
 if(!s.observations.length)return {kind:'tool',name:'mail.read',args:{messageId:'m'}};
 const first=s.observations[0].data as any;
 assert.deepEqual(first.message,{subject:'Invented request',from:'invented@example.test',text:rootAttachment?'':'Hello',mimeType:rootAttachment?'text/html':'text/plain'});
 assert.equal(first.source.providerId,'m');assert.equal(first.source.providerVersion,'7');assert.equal(first.source.accountId,'a');
 assert.deepEqual(JSON.parse(evidence.read({workspaceId:'w',accountId:'a'},first.artifact.id).toString()),raw);
 if(rootAttachment)assert.deepEqual(first.parts,['']);
 if(s.observations.length===1)return {kind:'tool',name:'mail.attachments',args:{messageId:'m',partId:first.parts[0]}};
 const result=s.observations[1].data as any;
 assert.equal(result.artifact.sha256,createHash('sha256').update(Buffer.from([0,255])).digest('hex'));
 return {kind:'ready',result:'invented bytes observed'};
 }},3);
 const observations=state.get(task.id).observations;assert.equal(observations.length,2);
 const id=(observations[1].data as any).artifact.id;evidence.close();evidence=new EvidenceStore(root);
 assert.deepEqual(evidence.read({workspaceId:'w',accountId:'a'},id),Buffer.from([0,255]));
 assert.throws(()=>evidence.read({workspaceId:'other',accountId:'a'},id));
 }finally{state.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});
test('registered source output rejects malformed envelopes and models failures without null',async()=>{
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const [tool]=await googleSourceTools(oauth,'c','w',new Set(),{} as EvidenceStore);
 assert.throws(()=>tool.outputSchema.parse(null));
 assert.throws(()=>tool.outputSchema.parse({source:{},artifact:{}}));
 assert.throws(()=>tool.outputSchema.parse({code:'source_unavailable',nextAction:'Retry',extra:true}));
 assert.deepEqual(tool.outputSchema.parse({code:'source_unavailable',nextAction:'Retry'}),{code:'source_unavailable',nextAction:'Retry'});
});
test('selected mail denies arbitrary IDs without network and preserves attachment bytes',async()=>{
 let calls=0;
 const reader=new SelectedMail({accountId:'a',token:async()=> 'token'},new Set(['m']),async(url)=>{calls++;return Response.json(String(url).includes('/attachments/')?{data:'AP8',size:2}:{id:'m',historyId:'7',payload:{partId:'0',mimeType:'application/octet-stream',body:{attachmentId:'att',size:2}}});});
 await assert.rejects(reader.read('other',new AbortController().signal));assert.equal(calls,0);
 const message=await reader.read('m',new AbortController().signal);
 assert.equal(message.providerVersion,'7');
 assert.deepEqual((await reader.attachment('m','0',new AbortController().signal)).bytes,Buffer.from([0,255]));
});

test('source namespace and stale responses deny writes; local commit failures propagate',async()=>{
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 let calls=0,writes=0,current=true;
 const store={put(){writes++;throw Error('uncertain local commit');}} as unknown as EvidenceStore;
 const raw={id:'m',historyId:'1',payload:{partId:'0',mimeType:'text/plain',body:{data:'SGk',size:2}}};
 const [tool]=await googleSourceTools(oauth,'c','w',new Set(['m']),store,async()=>{calls++;current=false;return Response.json(raw);});
 const ctx={callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'wrong',scope:{sources:[],destinations:[],grants:[]},budget:{limit:5,used:0},signal:new AbortController().signal,isCurrent:()=>current};
 assert.equal((await tool.invoke({messageId:'m'},ctx)).status,'failed');assert.equal(calls,0);
 ctx.accountId='a';assert.equal((await tool.invoke({messageId:'m'},ctx)).status,'failed');assert.equal(writes,0);
 current=true;ctx.isCurrent=()=>true;
 await assert.rejects(tool.invoke({messageId:'m'},ctx),/uncertain local commit/);assert.equal(writes,1);
});

// Finite HTTP adapter only: this exercises the real registry/runtime/store path, not Google acceptance.
test('runtime discovers Drive IDs and preserves exact bytes across evidence reopen',async()=>{
 const root=mkdtempSync(join(tmpdir(),'drive-runtime-'));let evidence=new EvidenceStore(root);const state=new AgentStore(':memory:');
 const bytes=Buffer.from([0,255,80,68,70]);const calls:string[]=[];
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const file={id:'observed-file',name:'Invented renamed file',mimeType:'application/pdf',version:'19',parents:['root'],trashed:false};
 const listing={files:[{id:file.id,name:file.name,mimeType:file.mimeType,version:file.version}]};
 try{
 const tools=await googleSourceTools(oauth,'c','w',new Set(),evidence,async input=>{
  const url=new URL(String(input));calls.push(url.pathname+url.search);
  if(url.pathname.endsWith('/files') )return Response.json(listing);
  if(url.pathname.endsWith('/files/root'))return Response.json({id:'root',name:'Invented folder',mimeType:'application/vnd.google-apps.folder',version:'3',parents:[],trashed:false});
  assert.ok(url.pathname.endsWith('/files/'+file.id));
  return url.searchParams.get('alt')==='media'?new Response(bytes):Response.json(file);
 },new Set(['root']));
 const task=state.admit({accountId:'a',workspaceId:'w',messageId:'drive-event',outcome:'inspect invented Drive source'},10);
 await new AgentRuntime(state,tools).run(task.id,{id:'script-not-live-model',async next(s){
  if(!s.observations.length)return {kind:'tool',name:'drive.list',args:{folderId:'root'}};
  const discovery=s.observations[0].data as any;assert.deepEqual(discovery.listing,listing);
  if(s.observations.length===1)return {kind:'tool',name:'drive.read',args:{fileId:discovery.listing.files[0].id}};
  const read=s.observations[1].data as any;
  assert.equal(read.artifact.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(read.source.providerId,file.id);assert.equal(read.source.providerVersion,'19');assert.equal(read.source.accountId,'a');assert.equal(read.source.originalUrl,undefined);
  return {kind:'ready',result:'observed discovered bytes'};
 }},3);
 const completed=state.get(task.id);assert.equal(completed.status,'ready',JSON.stringify(completed));assert.equal(completed.observations.length,2);
 const snapshots=completed.observations.map(o=>o.data as any);evidence.close();evidence=new EvidenceStore(root);
 assert.deepEqual(JSON.parse(evidence.read({workspaceId:'w',accountId:'a'},snapshots[0].artifact.id).toString()),listing);
 assert.deepEqual(evidence.read({workspaceId:'w',accountId:'a'},snapshots[1].artifact.id),bytes);
 for(const snapshot of snapshots){assert.equal(evidence.source({workspaceId:'w',accountId:'a'},snapshot.source.id).snapshotArtifactId,snapshot.artifact.id);
 for(const ns of [{workspaceId:'other',accountId:'a'},{workspaceId:'w',accountId:'other'}]){assert.throws(()=>evidence.read(ns,snapshot.artifact.id));assert.throws(()=>evidence.source(ns,snapshot.source.id));}}
 assert.ok(calls.some(c=>c.includes('alt=media')));
 }finally{state.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});
test('source insert abort publishes no half metadata and runtime requires reconciliation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'google-atomic-'));let evidence=new EvidenceStore(root);const state=new AgentStore(':memory:');
 try{
 evidence.db.exec("CREATE TRIGGER abort_source BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'injected source commit failure'); END");
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const tools=await googleSourceTools(oauth,'c','w',new Set(['m']),evidence,async()=>Response.json({id:'m',historyId:'7',payload:{partId:'0',mimeType:'text/plain',body:{data:'SGk',size:2}}}));
 const task=state.admit({accountId:'a',workspaceId:'w',messageId:'m',outcome:'commit invented source'},5);let turns=0;
 await new AgentRuntime(state,tools).run(task.id,{id:'script-not-live-model',async next(){turns++;return {kind:'tool',name:'mail.read',args:{messageId:'m'}};}},2);
 const blocked=state.get(task.id);assert.equal(turns,1);assert.equal(blocked.status,'blocked');assert.equal(blocked.recovery,'reconciliation_required');assert.match(blocked.blocker!,/injected source commit failure/);
 assert.equal(blocked.pending?.effect,'write_local');assert.deepEqual(blocked.observations,[]);
 evidence.close();evidence=new EvidenceStore(root);
 for(const table of ['artifacts','sources'])assert.equal(evidence.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
 assert.equal(evidence.recoverOrphans(),1);assert.equal(evidence.recoverOrphans(),0);
 state.recover(task.id);assert.equal(state.get(task.id).recovery,'reconciliation_required');
 }finally{state.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});

for(const name of ['drive.list','drive.read'])test(`${name} stops after aborted late metadata without snapshots`,async()=>{
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const controller=new AbortController();let calls=0,writes=0,cancelled=0,priming=name==='drive.read';let requestSignal:AbortSignal|undefined;
 const directory=mkdtempSync(join(tmpdir(),'source-late-')),store=new EvidenceStore(directory),put=store.put.bind(store);store.put=(...args)=>{writes++;return put(...args);};
 try{
 const tools=await googleSourceTools(oauth,'c','w',new Set(),store,async(url,init)=>{
  if(priming)return Response.json(String(url).includes('/files?')?{files:[{id:'observed',name:'Invented file',mimeType:'application/pdf',version:'1'}]}:{id:'root',mimeType:'application/vnd.google-apps.folder',version:'1',parents:[],trashed:false});
  calls++;requestSignal=init?.signal as AbortSignal;controller.abort();
  const bytes=Buffer.from(JSON.stringify({id:'root',mimeType:'application/vnd.google-apps.folder',version:'1',parents:[],trashed:false}));
  return new Response(new ReadableStream({start(c){c.enqueue(bytes);},pull(c){c.close();},cancel(){cancelled++;}},{highWaterMark:0}));
 },new Set(['root']));
 const tool=tools.find(t=>t.name===name)!;
 const ctx={callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a',scope:{sources:[],destinations:[],grants:[]},budget:{limit:5,used:0},signal:controller.signal,isCurrent:()=>true};
 if(priming){assert.equal((await tools.find(t=>t.name==='drive.list')!.invoke({},ctx)).status,'ok');priming=false;writes=0;}
 const result=await tool.invoke(name==='drive.list'?{}:{fileId:'observed'},ctx);
 assert.equal(result.status,'failed');assert.equal(calls,1);assert.equal(writes,0);assert.equal(cancelled,1);assert.equal(requestSignal?.aborted,true);
 await Promise.resolve();assert.equal(calls,1);assert.equal(writes,0);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('mail search inventory is registered',async()=>{
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const tools=await googleSourceTools(oauth,'c','w',new Set(),{} as EvidenceStore);
 assert.ok(tools.find(t=>t.name==='mail.search'));
});

test('runtime searches trusted queries then reads discovered request; selection is copied',async()=>{
 const root=mkdtempSync(join(tmpdir(),'search-runtime-'));const evidence=new EvidenceStore(root),state=new AgentStore(':memory:');let calls=0;
 const queries=new Map([['request','subject:Invented']]);
 const oauth={connectorAccess:async()=>({accountId:'a',assertCurrent:async()=>{},token:async()=> 'token'})} as unknown as GoogleOAuth;
 const raw={messages:[{id:'found'}],nextPageToken:'more'};
 try{
 const tools=await googleSourceTools(oauth,'c','w',new Set(),evidence,async input=>{
 calls++;const url=new URL(String(input));assert.equal(url.origin,'https://gmail.googleapis.com');
 if(url.searchParams.has('q')){assert.equal(url.searchParams.get('q'),'subject:Invented');assert.equal(url.searchParams.get('maxResults'),'100');return Response.json(raw);}
 return Response.json({id:'found',historyId:'9',payload:{partId:'0',mimeType:'text/plain',body:{data:Buffer.from('Please submit invented PDF').toString('base64url'),size:26}}});
 },undefined,queries);
 queries.set('request','expanded');queries.set('untrusted','all');
 const search=tools.find(t=>t.name==='mail.search')!;
 const ctx={callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a',scope:{sources:[],destinations:[],grants:[]},budget:{limit:5,used:0},signal:new AbortController().signal,isCurrent:()=>true};
 assert.equal((await search.invoke({queryReference:'untrusted'},ctx)).status,'failed');assert.equal(calls,0);
 assert.equal((await search.invoke({queryReference:'request'},{...ctx,accountId:'wrong'})).status,'failed');assert.equal(calls,0);
 assert.equal((await search.invoke({queryReference:'request'},{...ctx,signal:AbortSignal.abort()})).status,'failed');assert.equal(calls,0);
 assert.throws(()=>search.inputSchema.parse({queryReference:'request',q:'all'}));
 const task=state.admit({accountId:'a',workspaceId:'w',messageId:'search-event',outcome:'find invented request'},10);
 await new AgentRuntime(state,tools).run(task.id,{id:'script-not-live',async next(s){
 if(!s.observations.length)return {kind:'tool',name:'mail.search',args:{queryReference:'request'}};
 const first=s.observations[0].data as any;assert.deepEqual(JSON.parse(evidence.read({workspaceId:'w',accountId:'a'},first.artifact.id).toString()),raw);assert.equal(first.source.providerId,'request');assert.equal(first.search.nextPageToken,'more');
 if(s.observations.length===1)return {kind:'tool',name:'mail.read',args:{messageId:first.search.messages[0].id}};
 assert.equal((s.observations[1].data as any).message.text,'Please submit invented PDF');return {kind:'ready',result:'request observed'};
 }},3);assert.equal(calls,2);assert.equal(state.get(task.id).observations.length,2);
 }finally{state.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});
