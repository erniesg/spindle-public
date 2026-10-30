import test from 'node:test';
import assert from 'node:assert/strict';
import {TextProvider,CallBudget,ModelError,type ModelDeclaration} from '../../core/models/provider.js';
const model:ModelDeclaration={provider:'nebius',id:'synthetic-envelope',text:true,jsonObject:true,inputContextTokens:16384,maxOutputTokens:256,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,verifiedAt:'2026-10-24',source:'https://example.org/synthetic-pricing'}};
function client(metadata:Record<string,unknown>){
 const budget=new CallBudget(1,1);
 return new TextProvider(model,budget,async()=>'invented-key',async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"activity":"coding"}',...metadata}}],usage:{prompt_tokens:66,completion_tokens:6}}),{status:200}));
}
test('Nebius valid JSON accepts absent, null and empty no-tool metadata and settles usage',async()=>{
 for(const metadata of [{},{tool_calls:null,function_call:null},{tool_calls:[],function_call:null},{tool_calls:[]}]){
  const provider=client(metadata);const result=await provider.complete('Return JSON',{text:'invented code'},{current:()=>true});
  assert.deepEqual(result.value,{activity:'coding'});assert.deepEqual(result.usage,{inputTokens:66,outputTokens:6});assert.equal(provider.budget.snapshot().accountedUsd,0.000072);
 }
});
test('actual or malformed tool metadata is still rejected even with valid content and stop',async()=>{
 for(const metadata of [{tool_calls:[{type:'function',function:{name:'shell',arguments:'{}'}}]},{tool_calls:{}},{tool_calls:false},{tool_calls:'[]'},{function_call:{name:'shell',arguments:'{}'}},{function_call:[]},{function_call:''}]){
  const provider=client(metadata);await assert.rejects(provider.complete('Return JSON',{}, {current:()=>true}),(e:unknown)=>e instanceof ModelError&&e.code==='MALFORMED_RESPONSE');
  assert.ok(provider.budget.snapshot().accountedUsd>0.000072,'invalid response keeps the full reservation');
 }
});
