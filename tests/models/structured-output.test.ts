import test from 'node:test';
import assert from 'node:assert/strict';
import {TextProvider,CallBudget,ModelError,type ModelDeclaration} from '../../core/models/provider.js';
const model:ModelDeclaration={provider:'nebius',id:'synthetic-schema',text:true,jsonObject:true,jsonSchema:true,inputContextTokens:16384,maxOutputTokens:256,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-24',source:'https://example.org/synthetic-pricing'}};
const schema={type:'object',properties:{activity:{enum:['coding','reading']}},required:['activity'],additionalProperties:false};
test('explicit schema capability sends bounded strict schema; default stays JSON object',async()=>{
 const requests:any[]=[];const provider=new TextProvider(model,new CallBudget(1,3),async()=>'invented-key',async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"activity":"coding"}'}}]}));});
 await provider.complete('Return JSON',{}, {current:()=>true,schema});assert.deepEqual(requests[0].response_format,{type:'json_schema',json_schema:{name:'spindle_labels',strict:true,schema}});
 await provider.complete('Return JSON',{}, {current:()=>true});assert.deepEqual(requests[1].response_format,{type:'json_object'});
 await assert.rejects(provider.complete('Return JSON',{}, {current:()=>true,schema:{enum:['x'.repeat(8192)]}}),(e:unknown)=>e instanceof ModelError&&e.code==='REQUEST_TOO_LARGE');assert.equal(requests.length,2);
});
test('schema without explicit capability fails before credentials, budget and network',async()=>{
 const budget=new CallBudget(1,1);let touched=false;const provider=new TextProvider({...model,jsonSchema:false},budget,async()=>{touched=true;return 'invented-key';},async()=>{touched=true;throw new Error('must not call');});
 await assert.rejects(provider.complete('Return JSON',{}, {current:()=>true,schema}),(e:unknown)=>e instanceof ModelError&&e.code==='UNSUPPORTED_CAPABILITY');assert.equal(touched,false);assert.equal(budget.snapshot().calls,0);
});
