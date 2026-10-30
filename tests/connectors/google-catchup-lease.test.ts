import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../../core/storage/agent-store.js';
import {GmailSync} from '../../core/connectors/google/gmail.js';
import {GoogleWakeJournal} from '../../core/connectors/google/wake-journal.js';

test('slow cumulative work renews live ownership without changing final cursor early',async()=>{
 const tasks=new AgentStore(':memory:');let now=1000,count=0;
 const http=(async(input:string|URL|Request)=>{
  now+=20000;
  return Response.json(String(input).endsWith('profile')?{emailAddress:'a',historyId:'10'}:String(input).includes('messages?')?{messages:[{id:'one'},{id:'two'},{id:'three'}]}:{id:new URL(String(input)).pathname.split('/').at(-1)});
 }) as typeof fetch;
 const sync=new GmailSync(':memory:',tasks,http);
 try{for(let i=0;i<5&&count<3;i++)await sync.poll('a','w','t',async()=>{now+=20000;count++;return undefined;},{now:()=>now});assert.equal(count,3);assert.ok(now>61000);}finally{sync.close();tasks.close();}
});
test('wake renewal is token conditional and cannot resurrect expiry',()=>{
 const journal=new GoogleWakeJournal(':memory:');const route={route:'r',workspace:'w',account:'a',epoch:'e'};
 try{journal.enqueue(route,'m');const first=journal.claim(route,1000)!;journal.renew(first,50000);assert.equal(journal.claim(route,62000),undefined);assert.throws(()=>journal.renew(first,110000),/lease lost/);const second=journal.claim(route,110000)!;assert.throws(()=>journal.renew(first,110001),/lease lost/);journal.complete(second,110002);}finally{journal.close();}
});
