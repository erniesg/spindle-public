import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installPurposeTransport,requestPurposeEligibility} from '../../browser-extension/blocking/purpose-client.js';
import {PurposeControl} from '../../core/blocking/control.js';
import {PurposeClassifier} from '../../core/blocking/classifier.js';
import {CallBudget} from '../../core/models/provider.js';
import {JEV_MODEL,SCORE_LEVELS} from '../../core/blocking/jev.js';
const resource='https://example.test/lesson';
const evidence={resource,purpose:'Learn matrix eigenvectors',policyVersion:4,source:{resource,evidenceId:`static:${'c'.repeat(64)}`,mode:'static-resource' as const},title:'Invented linear algebra lesson',pageText:'An eigenvector is a nonzero vector scaled by the matrix transformation.'};
const answer=(label:'relevant'|'unrelated'|'insufficient')=>({model:JEV_MODEL,answers:{
 relevance_choice:{type:'choice',choice:label,confidence:.99,probabilities:{relevant:label==='relevant'?.99:.005,unrelated:label==='unrelated'?.99:.005,insufficient:label==='insufficient'?.99:.005}},
 relevance_score:{type:'score',score:label==='relevant'?4:label==='unrelated'?0:2,confidence:.99,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[i,v])),probabilities:Object.fromEntries(SCORE_LEVELS.map((_,i)=>[i,i===(label==='relevant'?4:label==='unrelated'?0:2)?1:0]))},
 explains_concept:{type:'noul',noul:label==='relevant'?.99:label==='unrelated'?.01:.5},
},usage:{input_tokens:200,output_tokens:60}});

test('browser eligibility uses real grant/classify protocol and strict native model codec; no capture/timer grant',async()=>{
 for(const [label,expected] of [['relevant','allow'],['unrelated','deny'],['insufficient','unknown']] as const){
  const actions:string[]=[];let calls=0;
  const host=new PurposeControl(()=> 'profile',async()=>({binding:'host-issued-session'}),new PurposeClassifier(new CallBudget(.02,3),async()=>'fixture-key',async()=>{calls++;return Response.json(answer(label));}));
  installPurposeTransport(async(raw,signal)=>{actions.push(raw.action);return host.extension(raw,'profile',signal);});
  const result=await requestPurposeEligibility(evidence,()=>true,new AbortController().signal);
  assert.equal(result.verdict,expected);assert.deepEqual(actions,['session','grant','classify']);assert.equal(calls,1);host.close();
 }
});
test('a changed source/navigation cannot apply an otherwise strong positive, and abort sends no new model request',async()=>{
 let current=true,calls=0;
 const host=new PurposeControl(()=> 'profile',async()=>({binding:'host-issued-session'}),new PurposeClassifier(new CallBudget(.02,3),async()=>'fixture-key',async()=>{calls++;current=false;return Response.json(answer('relevant'));}));
 installPurposeTransport((raw,signal)=>host.extension(raw,'profile',signal));
 assert.equal((await requestPurposeEligibility(evidence,()=>current,new AbortController().signal)).reason,'stale');
 const cancel=new AbortController();cancel.abort();
 assert.equal((await requestPurposeEligibility(evidence,()=>true,cancel.signal)).verdict,'unknown');assert.equal(calls,1);host.close();
});
test('actual supplied description survives projection and text is reduced only to fit the bounded provider envelope',async()=>{
 let received:any;
 const host=new PurposeControl(()=> 'profile',async()=>({binding:'host-issued-session'}),new PurposeClassifier(new CallBudget(.02,3),async()=>'fixture-key',async(_url,options)=>{received=JSON.parse(options?.body as string);return Response.json(answer('relevant'));}));
 installPurposeTransport((raw,signal)=>host.extension(raw,'profile',signal));
 const rich={...evidence,summary:'An actual description with relevant explanation.',pageText:'界'.repeat(1365)};
 const result=await requestPurposeEligibility(rich,()=>true,new AbortController().signal);
 assert.equal(result.verdict,'allow');assert.equal(received.state.metadata.summary,rich.summary);assert.ok(Buffer.byteLength(JSON.stringify(received))<=8192);host.close();
});
test('host failure or a forged source grant cannot fall back to path/manual allow',async()=>{
 installPurposeTransport(async()=>({ok:false,code:'PURPOSE_UNAVAILABLE'}));
 assert.equal((await requestPurposeEligibility(evidence,()=>true,new AbortController().signal)).verdict,'unknown');
 const host=new PurposeControl(()=> 'profile',async()=>({binding:'host-issued-session'}),new PurposeClassifier(new CallBudget(.02,3),async()=>{throw Error('must not read a key');}));
 installPurposeTransport(async(raw,signal)=>{
  const result=await host.extension(raw,'profile',signal);
  if(raw.action==='grant'&&result.ok&&'source'in result.value)result.value.source={...result.value.source,evidenceId:`static:${'d'.repeat(64)}`};
  return result;
 });
 assert.equal((await requestPurposeEligibility(evidence,()=>true,new AbortController().signal)).reason,'stale');host.close();
});
