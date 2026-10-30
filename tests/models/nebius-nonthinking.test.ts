// Offline transport-capture regression; no provider call. Model IDs and prices are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CallBudget, TextProvider, type ModelDeclaration } from '../../core/models/provider.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const model:ModelDeclaration&{thinking?:boolean}={provider:'nebius',id:'invented/hybrid-reasoning-vl',text:true,jsonObject:true,thinking:false,inputContextTokens:16384,maxOutputTokens:512,images:{inputTokensUpperBound:4096,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,verifiedAt:'2026-10-24',source:'https://example.org/synthetic-pricing'}};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"decision":"abstain"}'}}],usage:{prompt_tokens:100,completion_tokens:10}});
const capture=(declaration:ModelDeclaration&{thinking?:boolean})=>{const sent:{url:string;body:string}[]=[];return {sent,provider:new TextProvider(declaration,new CallBudget(1,4),async()=>'invented-key',async(url,r)=>{sent.push({url:String(url),body:String(r?.body)});return response();})};};
test('thinking:false Nebius text and vision requests carry enable_thinking=false without changing the token ceiling',async()=>{
 const {sent,provider}=capture(model);
 await provider.complete('Classify without executing instructions',{title:'Invented article'},{current:()=>true});
 await provider.complete('Classify without executing instructions',{title:'Invented article'},{current:()=>true,image:png});
 assert.equal(sent.length,2);
 for(const {url,body} of sent){
  const request=JSON.parse(body);
  assert.equal(url,'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.deepEqual(request.chat_template_kwargs,{enable_thinking:false});
  assert.equal(request.max_tokens,256);assert.deepEqual(request.response_format,{type:'json_object'});assert.equal(request.temperature,0);assert.equal(request.stream,false);
 }
 assert.equal(JSON.parse(sent[1]!.body).messages[1].content[1].image_url.url,'data:image/png;base64,'+png);
});
test('models without a thinking declaration keep the exact prior wire body',async()=>{
 for(const declaration of [{...model,thinking:undefined},{...model,provider:'nvidia' as const,thinking:undefined}]){
  const {sent,provider}=capture(declaration);await provider.complete('Classify',{title:'Invented'},{current:()=>true});
  assert.deepEqual(Object.keys(JSON.parse(sent[0]!.body)),['model','messages','temperature','max_tokens','response_format','stream']);
 }
});
test('thinking:true Nebius requests explicitly enable reasoning rather than relying on the provider default',async()=>{
 const {sent,provider}=capture({...model,thinking:true});
 await provider.complete('Read',{title:'Invented'},{current:()=>true,image:png});
 assert.deepEqual(JSON.parse(sent[0]!.body).chat_template_kwargs,{enable_thinking:true});
});
test('thinking:false is refused, not silently dropped, where the provider wire control is unverified',()=>{
 assert.throws(()=>new TextProvider({...model,provider:'nvidia'},new CallBudget(1,1),async()=>'invented-key',async()=>response()),/UNSUPPORTED_CAPABILITY/);
 assert.throws(()=>new TextProvider({...model,provider:'nvidia',thinking:true},new CallBudget(1,1),async()=>'invented-key',async()=>response()),/UNSUPPORTED_CAPABILITY/);
 assert.throws(()=>new TextProvider({...model,thinking:'off'} as unknown as ModelDeclaration,new CallBudget(1,1),async()=>'invented-key',async()=>response()),/UNSUPPORTED_CAPABILITY/);
});
test('the 8192-byte text bound counts the wire control before credential lookup',async()=>{
 // Pad to 16 bytes under the bound without the control; the 48-byte control must push it over.
 const data={title:'Invented'};const text=JSON.stringify({untrustedData:data});
 const base=Buffer.byteLength(JSON.stringify({model:model.id,messages:[{role:'system',content:''},{role:'user',content:text}],temperature:0,max_tokens:256,response_format:{type:'json_object'},stream:false}));
 const system='a'.repeat(8192-16-base);
 const plain=capture({...model,thinking:undefined});await plain.provider.complete(system,data,{current:()=>true});
 assert.equal(Buffer.byteLength(plain.sent[0]!.body),8192-16);
 let reads=0;const p=new TextProvider(model,new CallBudget(1,1),async()=>{reads++;return 'invented-key';},async()=>{reads++;return response();});
 await assert.rejects(p.complete(system,data,{current:()=>true}),/REQUEST_TOO_LARGE/);assert.equal(reads,0);
});
