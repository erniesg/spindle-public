import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {EncryptedStore} from '../../core/tracking/store.js';
import {paidTaskAdmission,validatePublicPaidAccess,type PaidTaskQuota} from '../../core/account/paid-task-quota.js';

type State={accounts:{id:string;paidTasks?:PaidTaskQuota}[]};
const owner=randomUUID(),other=randomUUID();
const quota=(error:any)=>error.status===429&&error.message==='PAID_TASK_QUOTA';
async function fixture(dailyTasks:number){
 const directory=await mkdtemp(join(tmpdir(),'spindle-invented-owner-quota-')),key=randomBytes(32);let clock=1_000_000;
 const initial=():State=>({accounts:[{id:owner},{id:other}]}),store=new EncryptedStore(directory,key,initial);
 const access={mode:'owner' as const,accountId:owner,dailyTasks};
 return {store,admit:paidTaskAdmission(store,()=>clock,access),reopened:()=>paidTaskAdmission(new EncryptedStore(directory,key,initial),()=>clock,access),advance:(n:number)=>{clock+=n;},
  async close(){await store.settle();key.fill(0);await rm(directory,{recursive:true,force:true});}};
}

test('owner paid-access mode validates exactly one named account and a bounded integer daily task count',()=>{
 const valid={mode:'owner',accountId:owner,dailyTasks:5};
 const copy=validatePublicPaidAccess(valid)!;assert.deepEqual(copy,valid);assert.ok(Object.isFrozen(copy));assert.notEqual(copy,valid);
 (valid as any).accountId=other;assert.equal((copy as any).accountId,owner,'caller mutation cannot open the gate for another account');
 for(const dailyTasks of [1,200])assert.equal((validatePublicPaidAccess({mode:'owner',accountId:owner,dailyTasks}) as any).dailyTasks,dailyTasks);
 for(const bad of [
  {mode:'owner',accountId:owner,dailyTasks:0},{mode:'owner',accountId:owner,dailyTasks:201},{mode:'owner',accountId:owner,dailyTasks:1.5},
  {mode:'owner',accountId:owner,dailyTasks:'3'},{mode:'owner',accountId:owner,dailyTasks:-1},{mode:'owner',accountId:owner,dailyTasks:Number.NaN},
  {mode:'owner',accountId:owner},{mode:'owner',dailyTasks:3},{mode:'owner',accountId:'not-a-uuid',dailyTasks:3},{mode:'owner',accountId:owner.toUpperCase(),dailyTasks:3},
  {mode:'owner',accountId:owner,dailyTasks:3,scopeId:'extra'},{mode:'owner',accountId:owner,dailyTasks:3,extra:true},{mode:'Owner',accountId:owner,dailyTasks:3}
 ])assert.throws(()=>validatePublicPaidAccess(bad),/PUBLIC_PAID_ACCESS_INVALID/,JSON.stringify(bad));
 assert.throws(()=>paidTaskAdmission({} as any,Date.now,{mode:'owner',accountId:owner,dailyTasks:0} as any),/PUBLIC_PAID_ACCESS_INVALID/);
});

test('owner mode admits exactly dailyTasks per 24h for the named account; replay is free and survives reopen',async()=>{
 const f=await fixture(3);let created=0;const create=(id:string)=>()=>{created++;return {id};};
 try{
  for(const n of [1,2,3])await f.admit(owner,'workspace:preparation:'+n,create('task-'+n));
  await assert.rejects(f.admit(owner,'workspace:preparation:4',create('task-4')),quota);assert.equal(created,3,'refusal happens before Task initialization');
  assert.equal((await f.reopened()(owner,'workspace:preparation:2',create('task-2'))).id,'task-2','replaying an admitted identity does not consume another slot');
  await assert.rejects(f.reopened()(owner,'workspace:preparation:5',create('task-5')),quota);
  f.advance(24*60*60*1000);await f.admit(owner,'workspace:preparation:next-day',create('next-day'));
  await f.store.transaction(s=>{assert.equal(s.accounts.find(a=>a.id===owner)!.paidTasks!.admissions.length,1);},false);
 }finally{await f.close();}
});

test('owner mode refuses every other account, including admission and reconcile, before any Task is created',async()=>{
 const f=await fixture(200);let created=0;
 try{
  await assert.rejects(f.admit(other,'workspace:preparation:1',()=>{created++;return {id:'foreign'};}),quota);
  await assert.rejects(f.admit(randomUUID(),'workspace:mail:1',()=>{created++;return {id:'unknown'};}),quota);
  await assert.rejects(f.admit.reconcile(other,'workspace:preparation:1','foreign'),quota);
  assert.equal(created,0);
  await f.store.transaction(s=>{assert.equal(s.accounts.find(a=>a.id===other)!.paidTasks,undefined,'no quota state is written for a refused account');},false);
  assert.equal((await f.admit(owner,'workspace:preparation:1',()=>({id:'mine'}))).id,'mine');
 }finally{await f.close();}
});

test('a single-task owner bound refuses the second distinct task',async()=>{
 const f=await fixture(1);try{
  await f.admit(owner,'one',()=>({id:'one'}));await assert.rejects(f.admit(owner,'two',()=>({id:'two'})),quota);
 }finally{await f.close();}
});
