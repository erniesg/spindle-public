import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,scripted,alice} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import type {AgentProvider} from '../../core/agent/contracts.js';
import type {UserMemoryEntry,UserMemoryMutation} from '../../core/memory/user-protocol.js';
const choices={conversation:true,activity:false,processing:true,sync:false};
const ns={workspaceId:'w',accountId:alice};
async function ready(f:ReturnType<typeof fixture>){await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();}
function entries(f:ReturnType<typeof fixture>){const s=f.app.status();if(!s.authenticated)throw Error();return s.entries;}
test('SQLite restart does not relearn; binding requires reauthentication and account switching isolates every view',async()=>{
 let calls=0;const base=scripted();const f=fixture({id:'counted',next(...args){calls++;return base.next(...args);}});
 try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();assert.equal(calls,2);await f.app.stop();
 const second=f.service();await f.account.signout();assert.equal(second.status().authenticated,false);await second.signin('Alice','invented');await second.drain();assert.equal(calls,2);assert.equal(second.recall('tea').length,1);
 await second.signin('Bob','invented');await second.drain();assert.deepEqual(second.recall('tea'),[]);const status=second.status();assert.equal(status.authenticated&&status.turns.length,0);await second.stop();
 }finally{await f.close();}
});
test('inference cannot override user correction; forget purges original source, excerpts and queued content and prevents resurrection',async()=>{
 const f=fixture();try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);const job=store.jobs(ns)[0];
 f.app.correct('drink','preference','Prefers coffee',entries(f)[0].revision);f.app.conversation('I prefer tea');await f.app.drain();assert.equal(entries(f)[0].value,'Prefers coffee');
 f.app.forget('drink');await f.app.drain();assert.deepEqual(f.app.recall('coffee'),[]);assert.equal(existsSync(join(f.root,'artifacts',job.artifactId)),false);assert.equal(store.jobs(ns)[0].text,undefined);assert.equal(store.outbox(ns).some(o=>o.action==='put'&&o.key==='drink'),false);
 f.app.conversation('I prefer tea');await f.app.drain();assert.equal(entries(f)[0].deleted,true);
 assert.throws(()=>f.app.correct('drink','preference','new',entries(f)[0].revision),/RECREATE/);
 }finally{await f.close();}
});
for(const [name,provider] of [['quote not present',scripted('not in source')],['model owner/grant injection',scripted('I prefer tea',{accountId:'other',origin:'user',grants:['all']})]] as const)test(name+' cannot commit',async()=>{const f=fixture(provider);try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();assert.deepEqual(entries(f),[]);const s=f.app.status();assert.equal(s.authenticated&&s.turns[0].state,'uncertain');}finally{await f.close();}});
test('hash corruption rejects source before model invocation',async()=>{
 let called=false;const f=fixture({id:'must-not-run',async next(){called=true;return {kind:'ready',result:'none'};}});try{await ready(f);f.app.configure({...choices,processing:false});await f.app.drain();const turn=f.app.conversation('I prefer tea');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);const job=store.jobs(ns).find(j=>j.id===turn.id)!;
 f.evidence.db.prepare("UPDATE sources SET body=json_set(body,'$.sha256',?) WHERE id=?").run('0'.repeat(64),job.source.sourceId);
 f.app.configure(choices);await f.app.drain();assert.equal(called,false);assert.deepEqual(entries(f),[]);
 }finally{await f.close();}
});
test('forget turn fences delayed provider and late commit; revocation never marks a partial job completed',async()=>{
 let release!:(v:Awaited<ReturnType<AgentProvider['next']>>)=>void;let entered!:()=>void;const inside=new Promise<void>(r=>entered=r);
 const f=fixture({id:'delayed',async next(){entered();return new Promise(r=>release=r);}});
 try{await ready(f);const turn=f.app.conversation('I prefer tea');await inside;f.app.forgetConversation(turn.id);release({kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}});await f.app.drain();assert.deepEqual(entries(f),[]);const s=f.app.status();assert.equal(s.authenticated&&s.turns[0].state,'cancelled');assert.equal(s.authenticated&&s.turns[0].text,'[Forgotten]');}finally{await f.close();}
});
for(const mode of ['revoke','switch'] as const)test(mode+' fences late learning and never exposes a previous-user cache',async()=>{
 let release!:(v:Awaited<ReturnType<AgentProvider['next']>>)=>void;let enter!:()=>void;const started=new Promise<void>(r=>enter=r);const f=fixture({id:'delayed',async next(){enter();return new Promise(r=>release=r);}});
 try{await ready(f);f.app.conversation('I prefer tea');await started;if(mode==='switch')await f.app.signin('Bob','invented');else f.app.configure({...choices,conversation:false,processing:false});release({kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}});await f.app.drain();await f.app.drain();assert.deepEqual(entries(f),[]);const s=f.app.status();if(mode==='switch')assert.equal(s.authenticated&&s.turns.length,0);else assert.notEqual(s.authenticated&&s.turns[0].state,'completed');}finally{await f.close();}
});
test('server-expired authentication hides cached memory and invalidates the session',async()=>{
 const f=fixture(scripted(),()=>new Response('',{status:401}));try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();assert.equal(f.app.recall('tea').length,1);f.app.configure({...choices,sync:true});await f.app.drain();assert.equal(f.app.status().authenticated,false);assert.throws(()=>f.app.recall('tea'),/SIGNIN/);}finally{await f.close();}
});
test('no configured provider truthfully queues turns',async()=>{const f=fixture();const app= (await import('../../core/memory/application.js')).createUserMemoryApplication({evidence:f.evidence,evidenceRoot:f.root,account:f.account,workspaceId:'w'});try{await app.signin('Alice','invented');await app.drain();app.configure(choices);await app.drain();app.conversation('I prefer tea');await app.drain();const s=app.status();assert.equal(s.authenticated&&s.error,'MODEL_NOT_CONFIGURED');assert.equal(s.authenticated&&s.turns[0].state,'queued');}finally{await app.stop();await f.close();}});
for(const mode of ['badAck','conflict'] as const)test(mode+' preserves outbox or atomic page cursor and exposes status',async()=>{
 const f=fixture(scripted(),url=>url.pathname.endsWith('/sync')?mode==='conflict'?new Response('',{status:409}):{acknowledged:['invented-not-sent'],entries:[]}:{entries:[{key:'invalid'}],cursor:999,hasMore:false});
 try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();const store=new UserMemoryStore(f.evidence.db);const before=store.outbox(ns)[0].id;
 f.app.configure({...choices,sync:true});await f.app.drain();assert.equal(store.outbox(ns)[0].id,before);assert.equal(store.state(ns,'cursor'),undefined);assert.ok(f.app.status().authenticated);const s=f.app.status();assert.match(s.authenticated?s.error:'',/INVALID_/);
 }finally{await f.close();}
});
test('409 with valid changes is visible, retains unsynced correction, and does not use blind last-write-wins',async()=>{
 const f=fixture(scripted(),url=>url.pathname.endsWith('/sync')?new Response('',{status:409}):{entries:[],cursor:0,hasMore:false});try{await ready(f);f.app.conversation('I prefer tea');await f.app.drain();f.app.configure({...choices,sync:true});await f.app.drain();const s=f.app.status();assert.equal(s.authenticated&&s.error,'ACCOUNT_HTTP_409');assert.equal(s.authenticated&&s.pending,1);}finally{await f.close();}
});
test('two authenticated clients: automatic inference -> canonical sync -> second client recall; remote tombstone defeats stale offline replay',async()=>{
 const canonical=new Map<string,UserMemoryEntry>();const seen=new Map<string,UserMemoryEntry>();let seq=0;
 const server=(url:URL,data:unknown)=>{
  if(url.pathname.endsWith('/forget-source'))return {acknowledged:[(data as {id:string}).id]};
  if(url.pathname.endsWith('/sync')){const ops=(data as {operations:UserMemoryMutation[]}).operations;const output:UserMemoryEntry[]=[];
   for(const op of ops){const previous=canonical.get(op.key);if(!seen.has(op.id)&&((previous?.revision??0)!==op.expectedRevision||previous?.deleted&&op.origin==='inferred'))return new Response('',{status:409});
    const entry=seen.get(op.id)??{workspaceId:'w',key:op.key,revision:op.expectedRevision+1,seq:++seq,deleted:op.action==='forget',updatedAt:new Date().toISOString(),...(op.action==='put'?{kind:op.kind,value:op.value,origin:op.origin,sources:op.sources}:{})};seen.set(op.id,entry);canonical.set(op.key,entry);output.push(entry);}
   return {acknowledged:ops.map(o=>o.id),entries:output};
  }const cursor=Number(url.searchParams.get('cursor'));const records=[...canonical.values()].filter(e=>e.seq>cursor).sort((a,b)=>a.seq-b.seq);return {entries:records,cursor:records.at(-1)?.seq??cursor,hasMore:false};
 };
 const a=fixture(scripted(),server),b=fixture(scripted(),server);try{await ready(a);await ready(b);a.app.conversation('I prefer tea');await a.app.drain();a.app.configure({...choices,sync:true});await a.app.drain();assert.equal(entries(a)[0].pending,false);b.app.configure({...choices,sync:true});await b.app.drain();assert.equal(b.app.recall('tea')[0].value,'I prefer tea.');
 b.app.configure({...choices,sync:false});await b.app.drain();b.app.correct('drink','preference','Offline correction',entries(b)[0].revision);
 a.app.forget('drink');await a.app.drain();await a.app.drain();b.app.configure({...choices,sync:true});await b.app.drain();assert.deepEqual(b.app.recall('Offline'),[]);assert.equal(entries(b)[0].deleted,true);
 }finally{await a.close();await b.close();}
});
