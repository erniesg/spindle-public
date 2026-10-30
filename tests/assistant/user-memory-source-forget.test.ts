import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,renameSync,mkdirSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,alice} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {syncUserMemory} from '../../core/memory/sync.js';
const ns={workspaceId:'w',accountId:alice};
const off={conversation:true,activity:false,processing:false,sync:false};
test('source forget without a key is durable, content-free, stable and invalid ACK remains pending',async()=>{
 const sent:unknown[]=[];let valid=false;
 const f=fixture(undefined,(url,data)=>{if(url.pathname==='/user-memory/forget-source'){sent.push(data);return {acknowledged:[valid?(data as {id:string}).id:'wrong']};}if(url.pathname==='/user-memory/changes')return {entries:[],cursor:0,hasMore:false};return {};});
 let app=f.app;
 try{await app.signin('Alice','sample');await app.drain();app.configure(off);await app.drain();const turn=app.conversation('Invented private tea');await app.drain();const store=new UserMemoryStore(f.evidence.db),job=store.jobs(ns)[0];
 app.forgetConversation(turn.id);await app.drain();assert.equal(app.status().pending,1);assert.equal(existsSync(join(f.root,'artifacts',job.artifactId)),false);assert.equal(JSON.stringify(store.jobs(ns)).includes('Invented private tea'),false);
 await app.stop();app=f.service();await app.signin('Alice','sample');await app.drain();app.configure({...off,conversation:false,sync:true});await app.drain();assert.equal(app.status().pending,1);assert.match(app.status().error??'',/INVALID_SOURCE_ACK/);valid=true;await app.drain();assert.equal(app.status().pending,0);assert.deepEqual(sent[0],sent[1]);assert.equal(JSON.stringify(sent).includes('tea'),false);
 app.forgetConversation(turn.id);await app.drain();assert.equal(app.status().pending,0);
 }finally{await app.stop();await f.close();}
});
test('full source queue fails atomically before content or snapshot erasure',async()=>{
 const f=fixture();try{await f.app.signin('Alice','sample');await f.app.drain();f.app.configure(off);await f.app.drain();const turn=f.app.conversation('Keep until durable');await f.app.drain();
 const store=new UserMemoryStore(f.evidence.db),job=store.jobs(ns)[0];
 // Fill the bounded durable queue through the public store seam.
 for(let i=0;i<256;i++)store.forgetSource(ns,{...job.source,sourceId:'other-'+i});
 assert.throws(()=>f.app.forgetConversation(turn.id),/SOURCE_OUTBOX_FULL/);assert.equal(store.jobs(ns)[0].text,'Keep until durable');assert.equal(existsSync(join(f.root,'artifacts',job.artifactId)),true);
 }finally{await f.close();}
});
test('source purge removes superseded unsent inference even beneath an independent pending correction',async()=>{
 const f=fixture();try{await f.app.signin('Alice','sample');await f.app.drain();f.app.configure({...off,processing:true});await f.app.drain();const turn=f.app.conversation('I prefer tea');await f.app.drain();f.app.correct('drink','preference','Prefers coffee',1);await f.app.drain();f.app.forgetConversation(turn.id);await f.app.drain();const store=new UserMemoryStore(f.evidence.db);assert.equal(JSON.stringify(store.outbox(ns)).includes('tea'),false);assert.equal(f.app.recall('coffee')[0].value,'Prefers coffee');assert.equal(store.sourceOutbox(ns).length,1);
 }finally{await f.close();}
});
for(const mode of ['revoke','account','stop'] as const)test('late source ACK fenced on '+mode,async()=>{
 let release!:(v:Response)=>void,enter!:()=>void;const started=new Promise<void>(r=>enter=r);
 const f=fixture(undefined);try{await f.app.signin('Alice','sample');await f.app.drain();f.app.configure(off);await f.app.drain();const turn=f.app.conversation('Sample');await f.app.drain();f.app.forgetConversation(turn.id);await f.app.drain();
 const store=new UserMemoryStore(f.evidence.db),op=store.sourceOutbox(ns)[0],controller=new AbortController();let current=true;
 const request=f.account.request.bind(f.account);f.account.request=async(path,body,signal)=>{if(path==='/user-memory/forget-source'){enter();return await new Promise<Response>(r=>release=r).then(r=>r.json());}return request(path,body,signal);};
 const syncing=syncUserMemory(store,ns,f.account,controller.signal,()=>current,()=>{});await started;
 if(mode==='account')await f.account.signin('Bob','sample');else if(mode==='stop')controller.abort();else current=false;
 release(Response.json({acknowledged:[op.id]}));await assert.rejects(syncing,/SESSION_CHANGED/);assert.deepEqual(store.sourceOutbox(ns),[op]);assert.equal(store.state(ns,'lastSync'),undefined);
 }finally{await f.close();}
});
test('SQL failure rolls back intent/redaction before unlink; unlink failure follows durable commit',async()=>{
 const f=fixture();try{await f.app.signin('Alice','sample');await f.app.drain();f.app.configure(off);await f.app.drain();const turn=f.app.conversation('Snapshot sample');await f.app.drain();const store=new UserMemoryStore(f.evidence.db),job=store.jobs(ns)[0],path=join(f.root,'artifacts',job.artifactId);
 f.evidence.db.exec("CREATE TRIGGER fail_source_delete BEFORE DELETE ON artifacts BEGIN SELECT RAISE(ABORT,'INVENTED_SQL_FAILURE'); END;");
 assert.throws(()=>f.app.forgetConversation(turn.id),/INVENTED_SQL_FAILURE/);assert.equal(store.sourceOutbox(ns).length,0);assert.equal(store.jobs(ns)[0].text,'Snapshot sample');assert.equal(existsSync(path),true);
 f.evidence.db.exec('DROP TRIGGER fail_source_delete');renameSync(path,path+'.saved');mkdirSync(path);
 assert.throws(()=>f.app.forgetConversation(turn.id));assert.equal(store.sourceOutbox(ns).length,1);assert.equal(store.jobs(ns)[0].text,undefined);assert.equal(store.sourceForgotten(ns,job.source),true);
 rmdirSync(path);renameSync(path+'.saved',path);await f.app.stop();const restarted=f.service();try{await restarted.signin('Alice','sample');await restarted.drain();assert.equal(existsSync(path),false);assert.equal(store.sourceOutbox(ns).length,1);}finally{await restarted.stop();}
 }finally{await f.close();}
});
