import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../../core/storage/agent-store.js';
import {GmailSync} from '../../core/connectors/google/gmail.js';

for(const mode of ['abort-response','epoch-response','abort-relevance','eligibility'] as const)test(`Gmail lifecycle ${mode}`,async()=>{
 const tasks=new AgentStore(':memory:');const controller=new AbortController();let current=true,relevance=0,requests=0;
 const http=(async(input: string | URL | Request)=>{
  requests++;const url=String(input);
  if(url.endsWith('profile'))return Response.json({emailAddress:'self@example.test',historyId:'10'});
  if(url.includes('messages?'))return Response.json({messages:[{id:'old'},{id:'new'}]});
  if(mode==='abort-response')controller.abort();
  if(mode==='epoch-response')current=false;
  return Response.json({id:url.includes('/old?')?'old':'new',internalDate:url.includes('/old?')?'1':'100',labelIds:['SENT']});
 }) as typeof fetch;
 const sync=new GmailSync(':memory:',tasks,http);
 try{
  const poll=sync.poll('self@example.test','workspace','invented',async()=>{relevance++;if(mode==='abort-relevance')controller.abort();return 'prepare';},{signal:controller.signal,assertCurrent(){if(!current)throw Error('connection changed');},eligibleDuringReconciliation(message){return Number((message as {internalDate:string}).internalDate)>=100;}});
  if(mode==='eligibility'){assert.equal(await poll,2);assert.equal(relevance,1);}else {await assert.rejects(poll);assert.equal(relevance,mode==='abort-relevance'?1:0);}
  assert.ok(requests>=3);
 }finally{sync.close();tasks.close();}
});
