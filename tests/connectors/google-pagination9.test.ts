import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {GmailSync} from '../../core/connectors/google/gmail.js';
import {AgentStore} from '../../core/storage/agent-store.js';

for(const incremental of [false,true])test(`invalid ${incremental?'history':'full'} page token resumes original baseline after reopening`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pagination9-')),path=join(dir,'sync.db'),taskPath=join(dir,'tasks.db');
 let tasks=new AgentStore(taskPath),sync:GmailSync;
 let phase=0,complete=false;const starts:string[]=[];
 const ids=Array.from({length:20},(_,i)=>`m${i}`);
 const http=(async(input)=>{
  const u=new URL(String(input));
  if(u.pathname.endsWith('/profile'))return Response.json({emailAddress:'a',historyId:phase?'999':'20'});
  if(u.pathname.endsWith(incremental?'/history':'/messages')){
   if(incremental)starts.push(u.searchParams.get('startHistoryId')!);
   if(u.searchParams.has('pageToken')){
    assert.equal(u.searchParams.get('pageToken'),'expired');
    if(phase===1){phase=2;return Response.json({error:{errors:[{reason:'invalidArgument',message:'Invalid page token'}]}},{status:400});}
    throw Error('unexpected page request');
   }
   const selected=phase===2?[...ids,'next']:ids;
   return Response.json(incremental?{historyId:'888',history:selected.map(id=>({id:'11',messagesAdded:[{message:{id}}]})),...(phase===0?{nextPageToken:'expired'}:{})}:{messages:selected.map(id=>({id})),...(phase===0?{nextPageToken:'expired'}:{})});
  }
  return Response.json({id:u.pathname.split('/').at(-1)});
 }) as typeof fetch;
 sync=new GmailSync(path,tasks,http);
 const key=JSON.stringify(['w','a','epoch']);
 if(incremental){const db=new DatabaseSync(path);db.prepare('INSERT INTO google_cursor VALUES (?,?)').run(key,'10');db.close();}
 const lifecycle={connectionEpoch:'epoch',onProgress:(c:boolean)=>{complete=c;}};
 try{
  await sync.poll('a','w','t',async()=> 'prepare',lifecycle);
  assert.equal(complete,false);
  sync.close();tasks.close();phase=1;
  tasks=new AgentStore(taskPath);sync=new GmailSync(path,tasks,http);
  await sync.poll('a','w','t',async()=> 'prepare',lifecycle);
  assert.equal(complete,false);
  let db=new DatabaseSync(path);assert.equal((db.prepare('SELECT cursor FROM google_cursor WHERE account=?').get(key) as any)?.cursor,incremental?'10':undefined);db.close();
  await sync.poll('a','w','t',async()=> 'prepare',lifecycle);
  assert.equal(complete,true);
  db=new DatabaseSync(path);assert.equal((db.prepare('SELECT cursor FROM google_cursor WHERE account=?').get(key) as any).cursor,'20');assert.equal((db.prepare('SELECT count(*) AS n FROM google_catchup').get() as any).n,0);db.close();
  const taskDb=new DatabaseSync(taskPath);assert.equal((taskDb.prepare('SELECT count(*) AS n FROM agent_tasks').get() as any).n,21);taskDb.close();
  if(incremental)assert.deepEqual(starts,['10','10','10']);
 }finally{sync.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});

for(const incremental of [false,true])test(`generic invalidArgument retains ${incremental?'history':'full'} pagination checkpoint`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pagination9-denial-')),path=join(dir,'sync.db'),tasks=new AgentStore(':memory:');
 const http=(async(input)=>String(input).endsWith('/profile')?Response.json({emailAddress:'a',historyId:'999'}):Response.json({error:{errors:[{reason:'invalidArgument',message:'Permission invalid'}]}},{status:400})) as typeof fetch;
 const sync=new GmailSync(path,tasks,http),db=new DatabaseSync(path),key=JSON.stringify(['w','a','epoch']);
 const state=JSON.stringify({incremental,start:incremental?'10':undefined,cursor:'20',page:'expired',offset:0});
 db.prepare('INSERT INTO google_catchup VALUES (?,?)').run(key,state);
 try{await assert.rejects(sync.poll('a','w','t',async()=> 'prepare',{connectionEpoch:'epoch'}),/Gmail 400/);assert.equal((db.prepare('SELECT state FROM google_catchup WHERE owner=?').get(key) as any).state,state);}finally{db.close();sync.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
