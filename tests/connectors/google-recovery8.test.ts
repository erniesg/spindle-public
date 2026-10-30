import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GmailSync} from '../../core/connectors/google/gmail.js';
import {GoogleWakeJournal} from '../../core/connectors/google/wake-journal.js';
import {AgentStore} from '../../core/storage/agent-store.js';
const account='a';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'recovery8-'));return {dir,path:join(dir,'sync.db'),tasks:new AgentStore(':memory:')};}
test('reconnect epoch reopens with new bootstrap eligibility rather than old cursor',async()=>{
 const f=fixture();let epoch='one',seen:string[]=[];
 const http=(async(input)=>{const u=new URL(String(input));if(u.pathname.endsWith('profile'))return Response.json({emailAddress:account,historyId:'10'});if(u.pathname.endsWith('/history'))return Response.json({historyId:'20',history:[{id:'11',messagesAdded:[{message:{id:'old'}}]}]});if(u.pathname.endsWith('/messages'))return Response.json({messages:[{id:'old'},{id:'new'}]});const id=u.pathname.split('/').at(-1);return Response.json({id,internalDate:id==='old'?'1':'200'});}) as typeof fetch;
 let sync=new GmailSync(f.path,f.tasks,http);
 try{await sync.poll(account,'w','t',async()=>undefined,{connectionEpoch:epoch} as any);sync.close();epoch='two';sync=new GmailSync(f.path,f.tasks,http);await sync.poll(account,'w','t',async(m:any)=>{seen.push(m.id);return undefined;},{connectionEpoch:epoch,eligibleDuringReconciliation:(m:any)=>Number(m.internalDate)>=100} as any);assert.deepEqual(seen,['new']);}finally{sync.close();f.tasks.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('confirmed deleted message advances durable page offset to following admission',async()=>{
 const f=fixture();let seen=0;
 const http=(async(input)=>{const s=String(input);if(s.endsWith('profile'))return Response.json({emailAddress:account,historyId:'10'});if(s.includes('messages?'))return Response.json({messages:[{id:'gone'},{id:'next'}]});if(s.includes('/gone?'))return Response.json({error:{errors:[{reason:'notFound'}]}},{status:404});return Response.json({id:'next'});}) as typeof fetch;
 const sync=new GmailSync(f.path,f.tasks,http);try{await sync.poll(account,'w','t',async()=>{seen++;return 'prepare';});assert.equal(seen,1);}finally{sync.close();f.tasks.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('invalid full list page token restarts original baseline and completes without duplicate tasks',async()=>{
 const f=fixture();let invalid=false,complete=false,lists=0;
 const http=(async(input)=>{const u=new URL(String(input));if(u.pathname.endsWith('profile'))return Response.json({emailAddress:account,historyId:'10'});if(u.pathname.endsWith('/messages')){lists++;if(u.searchParams.has('pageToken')&&!invalid){invalid=true;return Response.json({error:{errors:[{reason:'invalidArgument',message:'Invalid page token'}]}},{status:400});}return Response.json({messages:invalid?[{id:'m1'},{id:'m2'}]:[{id:'m1'}],...(!invalid?{nextPageToken:'expired'}:{})});}return Response.json({id:u.pathname.split('/').at(-1)});}) as typeof fetch;
 const sync=new GmailSync(f.path,f.tasks,http);try{await sync.poll(account,'w','t',async()=> 'prepare',{onProgress:c=>{complete=c;}});assert.equal(complete,true);assert.ok(lists>=3);}finally{sync.close();f.tasks.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('retry clock rollover releases live lease but never resurrects expired lease',()=>{
 const journal=new GoogleWakeJournal(':memory:'),r={route:'r',workspace:'w',account:'a',epoch:'e'};
 try{journal.enqueue(r,'one');const c=journal.claim(r,100,10)!;journal.retry(c,100,101);assert.ok(journal.claim(r,101,10));journal.enqueue({...r,epoch:'other'},'two');const expired=journal.claim({...r,epoch:'other'},100,10)!;assert.throws(()=>journal.retry(expired,100,111),/lease lost/);}finally{journal.close();}
});
