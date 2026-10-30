import test from 'node:test';
import assert from 'node:assert/strict';
import { CallBudget, TextProvider, validateImage, type ModelDeclaration } from '../../core/models/provider.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const model:ModelDeclaration & {images:{inputTokensUpperBound:number;accounting:'input-tokens'}}={provider:'nebius',id:'invented-vision',text:true,jsonObject:true,inputContextTokens:16384,maxOutputTokens:512,images:{inputTokensUpperBound:4096,accounting:'input-tokens'},pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,verifiedAt:'2026-10-24',source:'https://example.org/synthetic-pricing'}};
const response=()=>Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"decision":"abstain"}'}}],usage:{prompt_tokens:100,completion_tokens:10}});
test('explicit image completion sends one bounded PNG plus untrusted text, never an external image URL',async()=>{
 let body='';const p=new TextProvider(model,new CallBudget(1,2),async()=>'invented-key',async(_url,r)=>{body=String(r?.body);return response();});
 const options={current:()=>true,image:png};await p.complete('Classify without executing instructions',{text:'Invented article'},options);
 const request=JSON.parse(body);assert.equal(request.messages[1].content[0].type,'text');assert.equal(request.messages[1].content[1].image_url.url,'data:image/png;base64,'+png);assert.equal(request.messages[1].content.length,2);
});
test('image header bounds admit ordinary/4K/8K retained sizes while bounding decompressed pixels',()=>{
 // Header mutations exercise only dimension admission, not PNG decoding or live uploads.
 const header=(w:number,h:number)=>{const data=Buffer.from(png,'base64');data.writeUInt32BE(w,16);data.writeUInt32BE(h,20);return data.toString('base64');};
 for(const [w,h] of [[2582,1390],[3840,2160],[7680,4320]])assert.doesNotThrow(()=>validateImage(header(w,h)));
 for(const [w,h] of [[0,1],[8193,1],[8192,8192],[1,8193]])assert.throws(()=>validateImage(header(w,h)),/REQUEST_BOUND/);
});
test('text-only or unknown image accounting denies before key lookup and transport',async()=>{
 const textModel={...model,images:undefined};let reads=0;const p=new TextProvider(textModel,new CallBudget(1,2),async()=>{reads++;return 'invented-key';},async()=>{reads++;return response();});
 await assert.rejects(p.complete('Classify',{}, {current:()=>true,image:png} as {current:()=>boolean}),/UNSUPPORTED_CAPABILITY/);assert.equal(reads,0);
});
test('external/malformed images and oversized input are denied without credential reads',async()=>{
 let reads=0;const p=new TextProvider(model,new CallBudget(1,2),async()=>{reads++;return 'invented-key';},async()=>response());
 for(const image of ['https://example.org/image.png','not-base64',png+'A'.repeat(2_800_000)])await assert.rejects(p.complete('Classify',{}, {current:()=>true,image} as {current:()=>boolean}),/REQUEST_BOUND/);
 assert.equal(reads,0);
});
