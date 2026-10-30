import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../../core/storage/agent-store.js';
import {GmailSync} from '../../core/connectors/google/gmail.js';
test('failed durable admission preserves item offset and final cursor across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gmail-admission-')),path=join(dir,'sync.db');const tasks=new AgentStore(join(dir,'tasks.db'));
 const admit=tasks.admit.bind(tasks);let fail=true,firstId='';
 tasks.admit=(event,limit)=>{if(event.messageId==='two'&&fail){fail=false;throw Error('injected admission failure');}const task=admit(event,limit);if(event.messageId==='one')firstId=task.id;return task;};
 const http=(async(input:string|URL|Request)=>Response.json(String(input).endsWith('profile')?{emailAddress:'a',historyId:'10'}:String(input).includes('messages?')?{messages:[{id:'one'},{id:'two'}]}:{id:new URL(String(input)).pathname.split('/').at(-1)})) as typeof fetch;
 let sync=new GmailSync(path,tasks,http);
 try{
  await assert.rejects(sync.poll('a','w','t',async()=> 'prepare'),/injected admission failure/);sync.close();
  const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT count(*) AS n FROM google_cursor').get()!.n,0);assert.equal(JSON.parse(String(db.prepare('SELECT state FROM google_catchup').get()!.state)).offset,1);db.close();
  sync=new GmailSync(path,tasks,http);assert.equal(await sync.poll('a','w','t',async()=> 'prepare'),1);
  assert.equal(admit({accountId:'a',workspaceId:'w',messageId:'one',outcome:'prepare'},100).id,firstId);
 }finally{sync.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
