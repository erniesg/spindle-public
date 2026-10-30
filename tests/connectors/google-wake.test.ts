import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GoogleWakeJournal } from '../../core/connectors/google/wake-journal.js';
import { GmailSync } from '../../core/connectors/google/gmail.js';
import { AgentStore } from '../../core/storage/agent-store.js';
import { GoogleOAuth, scopes } from '../../core/connectors/google/oauth.js';
const route={route:'push-demo',workspace:'demo',account:'demo@example.test',epoch:'epoch-one'};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'spindle-google-wake-'));return {path:join(dir,'wake.db'),clean:()=>rmSync(dir,{recursive:true,force:true})};}
test('durable delivery deduplicates after reopen and separates epochs',()=>{
 const f=fixture();let j=new GoogleWakeJournal(f.path);
 try{assert.equal(j.enqueue(route,'m1'),true);j.close();j=new GoogleWakeJournal(f.path);assert.equal(j.enqueue(route,'m1'),false);assert.ok(j.claim(route,100));assert.equal(j.claim({...route,epoch:'epoch-two'},100),undefined);assert.equal(j.enqueue({...route,epoch:'epoch-two'},'m1'),true);}finally{j.close();f.clean();}
});
test('captured completion preserves arrivals during drain and rejects expired owners',()=>{
 const f=fixture(),j=new GoogleWakeJournal(f.path);
 try{j.enqueue(route,'m1');const first=j.claim(route,100,10)!;j.enqueue(route,'m2');assert.equal(j.claim(route,101),undefined);j.complete(first,101);const second=j.claim(route,102,10)!;assert.equal(second.sequence,2);assert.throws(()=>j.complete(first,103),/lease lost/);const replacement=j.claim(route,113)!;assert.throws(()=>j.complete(second,114),/lease lost/);j.complete(replacement,114);assert.equal(j.claim(route,115),undefined);}finally{j.close();f.clean();}
});
test('retry deadlines and watch metadata survive restart',()=>{
 const f=fixture();let j=new GoogleWakeJournal(f.path);
 try{j.recordWatch(route,'123',20000);j.enqueue(route,'m1');const claim=j.claim(route,100)!;j.retry(claim,500,101);j.close();j=new GoogleWakeJournal(f.path);assert.deepEqual({...j.watch(route)}, {historyId:'123',expiresAt:20000});assert.equal(j.claim(route,499),undefined);assert.ok(j.claim(route,500));}finally{j.close();f.clean();}
});
test('failed durable enqueue rolls back delivery dedup so redelivery remains possible',()=>{
 const f=fixture(),j=new GoogleWakeJournal(f.path),db=new DatabaseSync(f.path);
 try{db.exec("CREATE TRIGGER fail_wake BEFORE UPDATE ON google_wake BEGIN SELECT RAISE(ABORT,'invented disk failure'); END");assert.throws(()=>j.enqueue(route,'m1'),/invented disk failure/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM google_delivery').get()!.n,0);db.exec('DROP TRIGGER fail_wake');assert.equal(j.enqueue(route,'m1'),true);assert.ok(j.claim(route));}finally{db.close();j.close();f.clean();}
});
test('cancelled relevance leaves no task or cursor after SQLite reopen',async()=>{
 const f=fixture(),taskPath=f.path+'.tasks',tasks=new AgentStore(taskPath),controller=new AbortController();
 const http=(async(url)=>String(url).endsWith('profile')?Response.json({emailAddress:route.account,historyId:'10'}):String(url).includes('messages?')?Response.json({messages:[{id:'m1'}]}):Response.json({id:'m1'})) as typeof fetch;
 const sync=new GmailSync(f.path,tasks,http);
 try{await assert.rejects(sync.poll(route.account,route.workspace,'invented',async()=>{controller.abort();return 'prepare';},{signal:controller.signal}));}finally{sync.close();tasks.close();}
 const reopened=new DatabaseSync(f.path),reopenedTasks=new DatabaseSync(taskPath);
 try{assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM google_cursor').get()!.n,0);assert.equal(reopenedTasks.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()!.n,0);}finally{reopened.close();reopenedTasks.close();f.clean();}
});
test('legacy epoch survives refresh rotation but same-account reconnect and revoke fence captured access',async()=>{
 let saved:string|undefined=JSON.stringify({refreshToken:'legacy-demo',accountId:route.account,grants:[scopes.mail]});
 const store={compareAndDelete:async(_id:string,expected:string)=>{if(saved!==expected)return false;saved=undefined;return true;},get:async()=>saved,set:async(_id:string,v:string)=>{saved=v;},delete:async()=>{saved=undefined;},compareAndSet:async(_id:string,prior:string|undefined,v:string)=>{if(saved!==prior)return false;saved=v;return true;}};
 const oauth=new GoogleOAuth('demo',store,(async(url)=>String(url).includes('/profile')?Response.json({emailAddress:route.account}):Response.json({access_token:'demo-access',refresh_token:'rotated-demo',scope:scopes.mail})) as typeof fetch);
 const old=await oauth.connectorAccess('demo',scopes.mail);await old.token();assert.equal((await oauth.connectionState('demo'))!.connectionEpoch,old.connectionEpoch);await old.assertCurrent();
 const reopened=new GoogleOAuth('demo',store);assert.equal((await reopened.connectionState('demo'))!.connectionEpoch,old.connectionEpoch);
 const flow=oauth.begin(12345,[scopes.mail]);await oauth.exchange(`${flow.redirect}?state=${flow.state}&code=demo`,flow,'demo');await assert.rejects(old.token(),/epoch changed/);
 const fresh=await oauth.connectorAccess('demo',scopes.mail);assert.notEqual(fresh.connectionEpoch,old.connectionEpoch);await oauth.disconnect('demo',false);await assert.rejects(fresh.assertCurrent(),/epoch changed/);
});
