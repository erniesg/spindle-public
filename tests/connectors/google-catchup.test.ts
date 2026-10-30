import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../../core/storage/agent-store.js';
import {GmailSync} from '../../core/connectors/google/gmail.js';

test('large bootstrap resumes across restarts, then large incremental catchup makes progress',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gmail-catchup-')),path=join(dir,'sync.db');
 const tasks=new AgentStore(':memory:');let incremental=false,eligible=0,complete=false,fail=true;
 const http=(async(input:string|URL|Request)=>{
  const u=new URL(String(input));if(u.pathname.endsWith('profile'))return Response.json({emailAddress:'self@example.test',historyId:incremental?'300':'100'});
  if(u.pathname.endsWith('/messages')||u.pathname.endsWith('/history')){
   const page=Number(u.searchParams.get('pageToken')??0);
   const messages=Array.from({length:100},(_,i)=>({id:`${incremental?'h':'b'}${page*100+i}`}));
   return Response.json(incremental?{historyId:'300',history:messages.map((m,i)=>({id:String(i+1),messagesAdded:[{message:m}]})),...(page<10?{nextPageToken:String(page+1)}:{})}:{messages,...(page<10?{nextPageToken:String(page+1)}:{})});
  }
  const id=u.pathname.split('/').at(-1)!;return Response.json({id,internalDate:Number(id.slice(1))<1098?'1':'100'});
 }) as typeof fetch;
 try {
  for(let tick=0;tick<150&&!complete;tick++){
   const sync=new GmailSync(path,tasks,http);
   try{await sync.poll('self@example.test','w','t',async()=>{if(fail){fail=false;throw Error('admission preparation failed');}eligible++;return 'prepare invented application';},{eligibleDuringReconciliation:m=>Number((m as {internalDate:string}).internalDate)>=100,onProgress:c=>{complete=c;}});}catch(e){assert.match(String(e),/admission preparation failed/);}finally{sync.close();}
   if(!complete){const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT count(*) AS n FROM google_cursor').get()!.n,0);db.close();}
  }
  assert.equal(complete,true);assert.equal(eligible,2);
  incremental=true;complete=false;let seen=0;
  for(let tick=0;tick<150&&!complete;tick++){const sync=new GmailSync(path,tasks,http);try{await sync.poll('self@example.test','w','t',async()=>{seen++;return undefined;},{onProgress:c=>{complete=c;}});}finally{sync.close();}}
  assert.equal(complete,true);assert.equal(seen,1100);
 }finally{tasks.close();rmSync(dir,{recursive:true,force:true});}
});

test('expired Gmail lease cannot be resurrected after slow work',async()=>{
 const tasks=new AgentStore(':memory:');let now=1000;
 const http=(async(input:string|URL|Request)=>Response.json(String(input).endsWith('profile')?{emailAddress:'a',historyId:'10'}:String(input).includes('messages?')?{messages:[{id:'m'}]}:{id:'m'})) as typeof fetch;
 const sync=new GmailSync(':memory:',tasks,http);
 try{await assert.rejects(sync.poll('a','w','t',async()=>{now+=60001;return 'x';},{now:()=>now}),/lease expired/);}finally{sync.close();tasks.close();}
});
