// Real Nebius adapter/HTTP/SQLite; scripted decisions, no paid calls or semantic-quality claim.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,alice} from './user-memory-fixture.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import {AgentSessionStore} from '../../core/models/agent-session-store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
const ns={workspaceId:'w',accountId:alice};
for(const late of [false,true])for(const action of ['fact','source','expiry'] as const)test(`multi-job ${action} forget removes owned envelopes (${late?'late HTTP response':'completed abstention'}), including old prompt copies`,async()=>{
 const f=fixture();const prompts:string[]=[];let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(JSON.parse(body).messages[1].content);const task=payload.untrustedTask;prompts.push(task.requestedOutcome);
  const next=task.requestedOutcome.includes('Unrelated turn')||task.observations.length?{kind:'ready',result:'Done'}:{kind:'tool',name:'memory.learn',args:{key:'drink',kind:'preference',value:'Prefers tea',quote:'I prefer tea'}};
  if(late&&task.requestedOutcome.includes('Unrelated turn')){entered();await gate;}
  res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:next})}}],usage:{prompt_tokens:100,completion_tokens:20}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const path=join(f.root,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const envelopes=new AgentSessionStore(f.evidence.db);
 const provider=new NebiusAgentProvider({model:{provider:'nebius',id:'explicit-test-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.test/pricing'}},budget:new FileCallBudget(path),credential:async()=>'mock-only',persist:envelopes.persist,transport:(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const app=createUserMemoryApplication({evidence:f.evidence,evidenceRoot:f.root,account:f.account,workspaceId:'w',provider});
 try{
  await app.signin('Alice','invented');await app.drain();app.configure({conversation:true,activity:false,processing:true,sync:false});await app.drain();const turn=app.conversation('I prefer tea');await app.drain();assert.equal(app.recall('tea')[0].value,'I prefer tea.');
  app.conversation('Unrelated turn');const inFlight=app.drain();if(late)await waiting;else await inFlight;const store=new UserMemoryStore(f.evidence.db),jobs=store.jobs(ns);assert.equal(jobs.length,2);
  // Simulate an envelope retained by the previous prompt format on an abstaining job.
  const row=f.evidence.db.prepare('SELECT rowid,body FROM agent_model_envelopes WHERE task=?').get(jobs[1].taskId!)!;
  const legacy=JSON.parse(row.body as string);legacy.legacyCurrentMemory='Prefers tea';f.evidence.db.prepare('UPDATE agent_model_envelopes SET body=? WHERE rowid=?').run(JSON.stringify(legacy),row.rowid!);
  // An unrelated task journal in the same namespace is not application-owned extraction data.
  f.evidence.db.prepare('INSERT INTO agent_model_envelopes SELECT workspace,account,?,run,cursor,reservation,? FROM agent_model_envelopes LIMIT 1').run('unrelated-task','{"keep":"unrelated task"}');
  if(action==='fact')app.forget('drink');
  else if(action==='source')app.forgetConversation(turn.id);
  else {const job=jobs[0];job.source.expiresAt=new Date(Date.now()-1).toISOString();store.job(ns,job);const op=store.outbox(ns)[0];op.sources![0].expiresAt=job.source.expiresAt;f.evidence.db.prepare('UPDATE user_memory_outbox SET body=? WHERE id=?').run(JSON.stringify(op),op.id);}
  if(action==='expiry'&&late)app.status(); // Expiry may be discovered by a status read during model I/O.
  release();await inFlight;await app.drain();assert.deepEqual(app.recall('tea'),[]);
  const retained=f.evidence.db.prepare('SELECT task,body FROM agent_model_envelopes').all();assert.equal(retained.length,1);assert.equal(retained[0].task,'unrelated-task');assert.doesNotMatch(JSON.stringify(retained),/Prefers tea|I prefer tea/);
  assert.doesNotMatch(prompts.at(-1)!,/CURRENT MEMORY|Prefers tea|I prefer tea/,'new extraction prompts must not copy prior memory');
  assert.equal(store.jobs(ns)[1].state,late?'uncertain':'completed');assert.ok(f.evidence.source(ns,jobs[1].source.sourceId),'unrelated source remains');
 }finally{release();await app.stop();await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});await f.close();}
});
