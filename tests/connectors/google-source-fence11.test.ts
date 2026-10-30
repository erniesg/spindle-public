import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleOAuth, scopes, type CredentialStore } from '../../core/connectors/google/oauth.js';
import { googleSourceTools } from '../../core/connectors/google/tools.js';
import { EvidenceStore } from '../../core/evidence/store.js';
import { connectedGoogle } from '../../core/connectors/google/connected.js';
import { AgentStore } from '../../core/storage/agent-store.js';
const names=['mail.read','mail.attachments','mail.search','drive.read','drive.list'];
for(const name of names)for(const invalidation of ['disconnect','reconnect','grant-loss'])test(`${name} denies ${invalidation} during actual local HTTP retrieval`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'fence11-'));const store=new EvidenceStore(root);
 let raw:string|undefined=JSON.stringify({refreshToken:'invented',accountId:'a@example.test',connectionEpoch:'epoch1',grants:Object.values(scopes)});
 const credentials:CredentialStore={get:async()=>raw,set:async(_id,v)=>{raw=v;},delete:async()=>{raw=undefined;},compareAndSet:async(_id,expected,value)=>{if(raw!==expected)return false;raw=value;return true;}};
 const oauth=new GoogleOAuth('invented',credentials,async()=>Response.json({access_token:'invented'}));
 let arrived!:()=>void,release!:()=>void;const arrival=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
 const message={id:'m',historyId:'1',payload:{partId:'0',mimeType:'text/plain',body:{attachmentId:'att',size:2}}};
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://local');
  const final=name==='mail.read'||name==='mail.search'||(name==='mail.attachments'&&url.pathname.includes('/attachments/'))||(name==='drive.read'&&url.searchParams.get('alt')==='media')||(name==='drive.list'&&url.pathname.endsWith('/files'));
  if(final){arrived();await gate;}
  const value=url.pathname.includes('/attachments/')?{data:'SGk',size:2}:url.pathname.includes('/messages/')?message:url.pathname.endsWith('/messages')?{messages:[{id:'m'}]}:url.pathname.endsWith('/files')?{files:name==='drive.read'?[{id:'f',name:'Invented file',mimeType:'application/pdf',version:'1'}]:[]}: {id:url.pathname.endsWith('/root')?'root':'f',name:'Invented',mimeType:url.pathname.endsWith('/root')?'application/vnd.google-apps.folder':'application/pdf',version:'1',parents:url.pathname.endsWith('/root')?[]:['root'],trashed:false};
  res.end(url.searchParams.get('alt')==='media'?'PDF':JSON.stringify(value));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
 try{
  const tools=await googleSourceTools(oauth,'c','w',new Set(['m']),store,(url,init)=>{const u=new URL(String(url));return fetch(`http://127.0.0.1:${address.port}${u.pathname}${u.search}`,init);},new Set(['root']),new Map([['q','invented']]));
  const tool=tools.find(t=>t.name===name)!;
  const args=name==='mail.read'?{messageId:'m'}:name==='mail.attachments'?{messageId:'m',partId:'0'}:name==='mail.search'?{queryReference:'q'}:name==='drive.read'?{fileId:'f'}:{folderId:'root'};
  const ctx={callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a@example.test',scope:{sources:[],destinations:[],grants:[]},budget:{limit:5,used:0},signal:AbortSignal.timeout(5000),isCurrent:()=>true};
  if(name==='drive.read'){
   assert.equal((await tools.find(t=>t.name==='drive.list')!.invoke({},ctx)).status,'ok');
   // Establish actual observed provider IDs before testing a late retrieval fence.
   store.db.exec('DELETE FROM sources; DELETE FROM artifacts');
  }
  if(name==='mail.attachments'){
   assert.equal((await tools.find(t=>t.name==='mail.read')!.invoke({messageId:'m'},ctx)).status,'ok');
   // The prerequisite discovery snapshot is not part of the invalidated invocation.
   store.db.exec('DELETE FROM sources; DELETE FROM artifacts');
  }
  const pending=tool.invoke(args,ctx);await Promise.race([arrival,new Promise((_,reject)=>setTimeout(()=>reject(Error('HTTP retrieval did not arrive')),6000).unref())]);
  if(invalidation==='disconnect')raw=undefined;else {const c=JSON.parse(raw!);if(invalidation==='reconnect')c.connectionEpoch='epoch2';else c.grants=[];raw=JSON.stringify(c);}
  release();const result=await pending;assert.equal(result.status,'failed');assert.deepEqual(result.observations,[]);assert.deepEqual(result.artifacts,[]);assert.deepEqual(result.evidence,[]);
  for(const table of ['artifacts','sources'])assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
 }finally{release();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
test('protected source fence lookup is abortable and does not persist after late resolution',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fence11-cancel-'));const store=new EvidenceStore(root);let calls=0,release!:(v:string)=>void,entered!:()=>void;
 const waiting=new Promise<void>(r=>entered=r);const raw=JSON.stringify({refreshToken:'invented',accountId:'a@example.test',connectionEpoch:'e',grants:[scopes.mail]});
 const credentials:CredentialStore={get:async()=>{if(++calls===5){entered();return new Promise<string>(r=>release=r);}return raw;},set:async()=>{},delete:async()=>{},compareAndSet:async()=>true};
 try{
 const oauth=new GoogleOAuth('invented',credentials,async()=>Response.json({access_token:'invented'}));
 const tools=await googleSourceTools(oauth,'c','w',new Set(['m']),store,async()=>Response.json({id:'m',historyId:'1',payload:{partId:'0',mimeType:'text/plain',body:{data:'SGk',size:2}}}));
 const controller=new AbortController();
 const pending=tools[0].invoke({messageId:'m'},{callId:'c',taskId:'t',runId:'r',workspaceId:'w',accountId:'a@example.test',scope:{sources:[],destinations:[],grants:[]},budget:{limit:5,used:0},signal:controller.signal,isCurrent:()=>true});
 await waiting;controller.abort();assert.equal((await pending).status,'failed');release(raw);await new Promise(r=>setImmediate(r));assert.equal(store.db.prepare('SELECT count(*) AS n FROM sources').get()!.n,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
for(const invalidation of [false,true])test(`connected Gmail forwards protected lifecycle and explicit eligibility (invalidate=${invalidation})`,async()=>{
 const originalFetch=globalThis.fetch;const tasks=new AgentStore(':memory:');let raw=JSON.stringify({refreshToken:'invented',accountId:'a@example.test',connectionEpoch:'e',grants:[scopes.mail]}),relevant=0;
 const credentials:CredentialStore={get:async()=>raw,set:async()=>{},delete:async()=>{},compareAndSet:async(_id,expected,value)=>{if(raw!==expected)return false;raw=value;return true;}};
 const oauth=new GoogleOAuth('invented',credentials,async()=>Response.json({access_token:'invented'}));
 globalThis.fetch=async input=>{const u=String(input);if(u.endsWith('/profile'))return Response.json({emailAddress:'a@example.test',historyId:'10'});if(u.includes('messages?'))return Response.json({messages:[{id:'old'},{id:'new'}]});if(invalidation){const c=JSON.parse(raw);c.connectionEpoch='replacement';raw=JSON.stringify(c);}return Response.json({id:u.includes('/old?')?'old':'new',internalDate:u.includes('/old?')?'1':'100'});};
 const connection=await connectedGoogle(oauth,'c');const gmail=connection.gmail(':memory:',tasks);
 try{
  const poll=gmail.poll('w',async()=>{relevant++;return 'invented';},{eligibleDuringReconciliation:m=>Number((m as {internalDate:string}).internalDate)>=100});
  if(invalidation){await assert.rejects(poll,/epoch/);assert.equal(relevant,0);}else{assert.equal(await poll,2);assert.equal(relevant,1);}
 }finally{gmail.close();tasks.close();globalThis.fetch=originalFetch;}
});
