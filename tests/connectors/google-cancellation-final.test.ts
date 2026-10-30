import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GmailSync } from '../../core/connectors/google/gmail.js';
import { GmailWatch } from '../../core/connectors/google/watch.js';
import { boundedBytes } from '../../core/connectors/google/bounded.js';
import type { AgentStore } from '../../core/storage/agent-store.js';
const route={route:'r',workspace:'w',account:'demo@example.test',epoch:'e',subscription:'s',audience:'a',serviceAccountEmail:'p@example.test'};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
async function finite(work:Promise<unknown>){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('finite cancellation guard')),150);})]);}finally{clearTimeout(timer!);}}
for(const phase of ['fetch','body','current','relevance'] as const)test(`Gmail cancellation fences noncooperative ${phase}, reopened cursor unchanged`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-cancel-')),entered=deferred<void>(),late=deferred<any>(),controller=new AbortController();let admissions=0,calls=0;
 const http=(async(url:unknown)=>{calls++;if(phase==='fetch'){entered.resolve();return late.promise;}if(phase==='body'){return new Response(new ReadableStream({pull(){entered.resolve();return late.promise;},cancel(){return late.promise;}}));}const u=String(url);return Response.json(u.endsWith('/profile')?{emailAddress:route.account,historyId:'10'}:u.includes('/messages?')?{messages:[{id:'m'}]}:{id:'m'});}) as typeof fetch;
 const sync=new GmailSync(join(dir,'sync'),{admit(){admissions++;}} as unknown as AgentStore,http);
 const work=sync.poll(route.account,route.workspace,'invented',async()=>{if(phase==='relevance'){entered.resolve();await late.promise;}return 'prepare';},{signal:controller.signal,assertCurrent:async()=>{if(phase==='current'){entered.resolve();await late.promise;}}});
 // Attach the rejection observer before cancellation.
 const rejected=assert.rejects(work);try{await finite(entered.promise);controller.abort();await finite(rejected);const captured=calls;late.resolve(Response.json({emailAddress:route.account,historyId:'10'}));await new Promise(r=>setTimeout(r,5));assert.equal(admissions,0);assert.equal(calls,captured);sync.close();const db=new DatabaseSync(join(dir,'sync'));try{assert.equal((db.prepare('SELECT count(*) AS n FROM google_cursor').get() as {n:number}).n,0);assert.equal((db.prepare('SELECT count(*) AS n FROM google_poll_lease').get() as {n:number}).n,0);}finally{db.close();}}finally{controller.abort();late.resolve(undefined);await rejected;try{sync.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
for(const phase of ['fetch','body','current','cancel'] as const)test(`Watch cancellation/disposal settles noncooperative ${phase}`,async()=>{
 const entered=deferred<void>(),late=deferred<any>(),controller=new AbortController();let records=0;
 const http=(async()=>{if(phase==='fetch'){entered.resolve();return late.promise;}if(phase==='body')return new Response(new ReadableStream({pull(){entered.resolve();return late.promise;},cancel(){return late.promise;}}));return new Response(new ReadableStream({cancel(){entered.resolve();return late.promise;}}));}) as typeof fetch;
 const watch=new GmailWatch({recordWatch(){records++;}},http),lifecycle={signal:controller.signal,assertCurrent:async()=>{if(phase==='current'){entered.resolve();await late.promise;}}};
 const work=phase==='cancel'?watch.stop('invented',lifecycle):watch.start(route,'invented','projects/demo-project/topics/demo-topic',lifecycle);
 const observed=phase==='cancel'?work:assert.rejects(work);
 try{await finite(entered.promise);if(phase!=='cancel')controller.abort();await finite(observed);assert.equal(records,0);}finally{controller.abort();late.resolve(Response.json({historyId:'10',expiration:String(Date.now()+60000)}));await observed;}
});
test('boundedBytes rejects cancellation without awaiting noncooperative cancel rejection',async()=>{
 const entered=deferred<void>(),cancel=deferred<void>(),controller=new AbortController();
 const response=new Response(new ReadableStream({pull(){entered.resolve();},cancel(){return cancel.promise;}}));
 const work=assert.rejects(boundedBytes(response,64,controller.signal));await finite(entered.promise);controller.abort();await finite(work);cancel.reject(Error('late stream disposal failure'));await new Promise(r=>setTimeout(r,5));
});
