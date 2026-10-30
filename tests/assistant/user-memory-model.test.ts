// Transport-scripted responses through the production Nebius adapter. Not a semantic quality evaluation or live model call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './user-memory-fixture.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import {AgentSessionStore} from '../../core/models/agent-session-store.js';
import {createUserMemoryApplication} from '../../core/memory/application.js';
import {learningResultSchema} from '../../core/memory/learning.js';
test('production model adapter + durable budget/envelopes + registered source tool over HTTP stub',async()=>{
 const f=fixture();let requests=0;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);const payload=JSON.parse(request.messages[1].content);assert.equal(payload.registeredTools.length,1);assert.equal(payload.registeredTools[0].name,'memory.learn');assert.match(payload.untrustedTask.requestedOutcome,/I prefer tea/);requests++;
 assert.deepEqual(payload.registeredTools[0].outputSchema,learningResultSchema.jsonSchema);
 if(requests===2)assert.deepEqual(payload.untrustedTask.observations[0].data,{saved:true,durability:'local',sync:'pending',value:'I prefer tea.',outcome:'saved'});
 if(requests===3){assert.equal(payload.untrustedTask.observations[1].status,'ok');assert.deepEqual(payload.untrustedTask.observations[1].data,{saved:false,reason:'unsupported_learning_declaration'});assert.equal(payload.untrustedTask.decisions[1].args.kind,'goal');}
 const action=requests===3?{kind:'ready',result:'Scripted Ready after rejected proposal'}:{kind:'tool',name:'memory.learn',args:{key:requests===1?'drink':'wrong_goal',kind:requests===1?'preference':'goal',value:'Prefers tea',quote:'I prefer tea'}};
 res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:action})}}],usage:{prompt_tokens:100,completion_tokens:20}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const path=join(f.root,'budget.json');writeFileSync(path,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:1,reservedWorstCase:0,observedSpend:0,requests:[]}));const budget=new FileCallBudget(path),envelopes=new AgentSessionStore(f.evidence.db);
 const provider=new NebiusAgentProvider({model:{provider:'nebius',id:'explicit-test-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-25',source:'https://example.test/pricing'}},budget,credential:async()=>'mock-only',persist:envelopes.persist,transport:(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const app=createUserMemoryApplication({evidence:f.evidence,evidenceRoot:f.root,account:f.account,workspaceId:'w',provider});
 try{await app.signin('Alice','invented');await app.drain();app.configure({conversation:true,activity:false,processing:true,sync:false});await app.drain();app.conversation('I prefer tea');await app.drain();assert.equal(app.recall('tea')[0].origin,'inferred');assert.equal(app.recall('tea').length,1);assert.equal(requests,3);assert.equal(budget.snapshot().calls,3);assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM agent_model_envelopes').get()?.n,3);
 app.forget('drink');await app.drain();assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM agent_model_envelopes').get()?.n,0);
 }finally{await app.stop();await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});await f.close();}
});
