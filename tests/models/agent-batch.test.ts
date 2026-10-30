import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,copyFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../core/storage/agent-store.js';
import {AgentRuntime} from '../../core/agent/runtime.js';
import {NebiusAgentProvider} from '../../core/models/agent-provider.js';
import {FileCallBudget} from '../../core/models/file-budget.js';
import type {ModelDeclaration} from '../../core/models/provider.js';
const model:ModelDeclaration={provider:'nebius',id:'explicit-test-model',text:true,jsonObject:true,inputContextTokens:65536,maxOutputTokens:1024,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-26',source:'https://example.test/pricing'}};
test('scripted local HTTP native batch overlaps real reads and next request contains both actual results and IDs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'batch-http-'));const store=new AgentStore(join(dir,'tasks.sqlite'));let active=0,peak=0,turn=0;
 writeFileSync(join(dir,'a.txt'),'001234');writeFileSync(join(dir,'b.txt'),'Changed requirement');
 const budgetPath=join(dir,'budget.json');writeFileSync(budgetPath,JSON.stringify({provider:'nebius',currency:'USD',hardTaskLimit:3,reservedWorstCase:0,observedSpend:0,requests:[]}));
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);writeFileSync(join(dir,`request-${turn}.json`),body);turn++;
 const task=JSON.parse(request.messages[1].content).untrustedTask;
 if(!task.observations.length)res.end(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{tool_calls:['a','b'].map(id=>({id,type:'function',function:{name:'files.read',arguments:JSON.stringify({id})}}))}}]}));
 else {assert.deepEqual(task.observations.map((o:{callId:string,data:unknown})=>[o.callId,o.data]),[['a','001234'],['b','Changed requirement']]);res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({next_action:{kind:'ready',result:'Both files observed'}})}}]}));}
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{const task=store.admit({workspaceId:'w',accountId:'a',messageId:'m',outcome:'Read permitted invented files'},10);
 const provider=new NebiusAgentProvider({model,budget:new FileCallBudget(budgetPath),credential:async()=>'local-fixture-only',persist:async e=>{writeFileSync(join(dir,`envelope-${e.cursor}.json`),JSON.stringify(e));},transport:(_,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 await new AgentRuntime(store,[{name:'files.read',version:'1',effect:'read',capabilities:[],inputSchema:{jsonSchema:{type:'object'},parse(v){assert.ok(v&&typeof v==='object'&&'id'in v&&['a','b'].includes(String(v.id)));return v;}},outputSchema:{jsonSchema:{type:'string'},parse:v=>v},async invoke(args,ctx){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,ctx.callId==='a'?20:1));active--;return {callId:ctx.callId,status:'ok',data:readFileSync(join(dir,`${(args as {id:string}).id}.txt`),'utf8'),artifacts:[],evidence:[],observations:[]};}}]).run(task.id,provider,2);
 assert.equal(peak,2);assert.equal(turn,2);assert.equal(store.get(task.id).status,'ready');assert.equal(store.get(task.id).budget.used,4);
 writeFileSync(join(dir,'task-result.json'),JSON.stringify(store.get(task.id),null,2));
 // Explicit local evidence opt-in; only this test's invented files/envelopes.
 if(process.env.SPINDLE_BATCH_EVIDENCE_DIR){const target=process.env.SPINDLE_BATCH_EVIDENCE_DIR;mkdirSync(target,{recursive:true});for(const file of ['a.txt','b.txt','request-0.json','request-1.json','envelope-0.json','envelope-1.json','task-result.json'])copyFileSync(join(dir,file),join(target,file));}
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
