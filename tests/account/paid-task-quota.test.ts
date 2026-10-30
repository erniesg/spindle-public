import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {EncryptedStore} from '../../core/tracking/store.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {paidTaskAdmission,type PaidTaskQuota} from '../../core/account/paid-task-quota.js';
type State={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'spindle-invented-quota-')),key=randomBytes(32);let clock=1_000_000;
 const initial=():State=>({accounts:[{id:'owner'},{id:'other'}]}),store=new EncryptedStore(directory,key,initial);
 const admission=()=>paidTaskAdmission(new EncryptedStore(directory,key,initial),()=>clock);
 const admit=paidTaskAdmission(store,()=>clock);
 return {admit,store,admission,advance:(n:number)=>{clock+=n;},async close(){await store.settle();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}
const quota=(error:any)=>error.status===429&&error.message==='PAID_TASK_QUOTA';
test('two actual tasks share an account limit; replay and another owner remain available across restart',async()=>{
 const f=await fixture();let dispatches=0;const tasks=new Map<string,{id:string}>();
 const create=(id:string)=>()=>{dispatches++;const t=tasks.get(id)??{id};tasks.set(id,t);return t;};
 try{
  await f.admit('owner','workspace:preparation:one',create('prep'));
  await f.admit('owner','workspace:mail:two',create('mail'));
  await assert.rejects(f.admit('owner','workspace:mail:three',create('third')),quota);assert.equal(dispatches,2);
  assert.equal((await f.admission()('owner','workspace:preparation:one',create('prep'))).id,'prep');
  await f.admit('other','workspace:mail:one',create('other1'));await f.admit('other','workspace:mail:two',create('other2'));
  await f.store.transaction(s=>{assert.equal(s.accounts[0].paidTasks!.admissions.length,2);assert.equal(s.accounts[0].paidTasks!.admissions[0].taskId,'prep');},false);
 }finally{await f.close();}
});
test('unknown initialization is never refunded or aged out; cancellation does not refund a known admission',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.admit('owner','unknown',()=>{throw Error('invented crash');}));
  await f.admit('owner','cancelled',()=>({id:'cancelled-task'}));
  await assert.rejects(f.admit('owner','third',()=>({id:'third'})),quota);
  f.advance(86400000);await f.admit('owner','new-day',()=>({id:'new-day'}));
  await assert.rejects(f.admit('owner','third',()=>({id:'third'})),quota);
  await f.store.transaction(s=>assert.ok(s.accounts[0].paidTasks!.admissions.some(a=>a.identity==='unknown'&&!a.taskId)),false);
 }finally{await f.close();}
});
test('clock rollback fails closed for new tasks, while the same admission remains idempotent',async()=>{
 const f=await fixture();try{
  await f.admit('owner','one',()=>({id:'one'}));f.advance(-1);
  await assert.rejects(f.admit('owner','two',()=>({id:'two'})),quota);
  assert.equal((await f.admit('owner','one',()=>({id:'one'}))).id,'one');
 }finally{await f.close();}
});
test('concurrent same-identity admission uses one slot and failed durable reservation dispatches nothing',async()=>{
 const f=await fixture();try{
  const tasks=new Map<string,{id:string}>();const create=()=>{const t=tasks.get('one')??{id:'one'};tasks.set('one',t);return t;};
  const results=await Promise.all([f.admit('owner','one',create),f.admit('owner','one',create)]);assert.equal(results[0].id,results[1].id);
  await f.admit('owner','two',()=>({id:'two'}));await assert.rejects(f.admit('owner','three',()=>({id:'three'})),quota);
  let dispatches=0;const broken=new EncryptedStore<State>(join(f.store.directory,'missing'),randomBytes(32),()=>{throw Error('invented store failure');});
  await assert.rejects(paidTaskAdmission(broken)('owner','one',()=>{dispatches++;return {id:'one'};}));assert.equal(dispatches,0);
 }finally{await f.close();}
});
test('failed Task-id attachment holds the reservation and dispatch until an exact durable-identity retry',async()=>{
 const f=await fixture();const original=f.store.transaction.bind(f.store);let writes=0,dispatches=0;let tasks=new AgentStore(join(f.store.directory,'tasks.sqlite'));
 const event={workspaceId:'workspace',accountId:'owner',messageId:'stable-event',outcome:'Invented attach-failure task'};
 const create=()=>tasks.admit(event,4);
 f.store.transaction=((...args:Parameters<typeof f.store.transaction>)=>{
  if(++writes===2)return Promise.reject(Error('invented attachment failure'));
  return original(...args);
 }) as typeof f.store.transaction;
 try{
  await assert.rejects((async()=>{await f.admit('owner','stable-event',create);dispatches++;})());assert.equal(dispatches,0);assert.equal(tasks.tasks(event).length,1);
  await original(s=>assert.deepEqual(s.accounts[0].paidTasks!.admissions.map(a=>a.taskId),[undefined]),false);
  const actualId=tasks.taskForEvent(event)!.id;tasks.close();tasks=new AgentStore(join(f.store.directory,'tasks.sqlite'));
  f.store.transaction=original;
  assert.equal((await f.admission()('owner','stable-event',create)).id,actualId);dispatches++;
  assert.equal(tasks.tasks(event).length,1);assert.equal(dispatches,1);
  await f.admit('owner','second',()=>({id:'second'}));await assert.rejects(f.admit('owner','third',()=>({id:'third'})),quota);
 }finally{f.store.transaction=original;tasks.close();await f.close();}
});
