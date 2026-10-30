import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CallBudget} from '../../core/models/provider.js';
import {PurposeClassifier,JEV_ENDPOINT,JEV_RESERVE_USD} from '../../core/blocking/classifier.js';
import {PurposeControl} from '../../core/blocking/control.js';
import {JEV_MODEL,JEV_SCOPE_REVISION,SCORE_LEVELS} from '../../core/blocking/jev.js';
import type {PurposeIdentity,PurposeScope} from '../../core/blocking/purpose.js';
import type {PurposeProcessingGrant} from '../../core/blocking/wire.js';
const resource='https://example.test/lesson',evidenceId=`static:${'a'.repeat(64)}`;
const identity:PurposeIdentity={requestId:'review-one',resource,purpose:'Learn eigenvectors',policyVersion:1,modelRevision:JEV_SCOPE_REVISION,consentRevision:1,evidenceId};
const scope:PurposeScope={modelRevision:JEV_SCOPE_REVISION,consentRevision:1,fields:['resource','purpose','title','pageText'],pageTextSource:{resource,evidenceId}};
const input=()=>({requestId:identity.requestId,resource,purpose:identity.purpose,policyVersion:1,expectedModelRevision:JEV_SCOPE_REVISION,expectedConsentRevision:1,title:'An invented lesson',pageText:'An eigenvector is a nonzero vector whose direction is unchanged under a matrix transformation.'});
function native(kind:'allow'|'deny'|'ambiguous'){
 const label=kind==='allow'?'relevant':kind==='deny'?'unrelated':'insufficient',level=kind==='allow'?4:kind==='deny'?0:2;
 return {model:JEV_MODEL,answers:{
  relevance_choice:{type:'choice',choice:label,confidence:.99,probabilities:{relevant:label==='relevant'?.99:.005,unrelated:label==='unrelated'?.99:.005,insufficient:label==='insufficient'?.99:.005}},
  relevance_score:{type:'score',score:level,confidence:.99,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[i,v])),probabilities:Object.fromEntries(SCORE_LEVELS.map((_,i)=>[i,i===level?1:0]))},
  explains_concept:{type:'noul',noul:kind==='allow'?.99:kind==='deny'?.01:.5},
 },usage:{input_tokens:100,output_tokens:50}};
}
const response=(kind:'allow'|'deny'|'ambiguous')=>new Response(JSON.stringify(native(kind)),{headers:{'Content-Type':'application/json'}});

test('production Jev client pilot: allowed, unrelated and ambiguous are native semantic signals, not path words',async()=>{
 for(const [kind,verdict] of [['allow','allow'],['deny','deny'],['ambiguous','unknown']] as const){
  const budget=new CallBudget(.02,3);let posts=0;
  const classify=new PurposeClassifier(budget,async()=>'invented-test-key',async(url,options)=>{
   posts++;assert.equal(url,JEV_ENDPOINT);assert.equal(options?.redirect,'error');assert.equal(options?.credentials,'omit');
   const body=JSON.parse(options?.body as string);assert.equal(body.model,JEV_MODEL);assert.equal(body.state.pageText,input().pageText);
   for(const key of ['requestId','policyVersion','consentRevision','binding','grantId','accountId','evidenceId'])assert.equal(key in body.state,false);
   assert.equal(body.questions.explains_concept.type,'noul');return response(kind);
  });
  const result=await classify.classify(input(),{scope,current:()=>identity});
  assert.equal(result?.verdict,verdict);assert.equal(result?.authority,'none');assert.equal(result?.evidenceId,evidenceId);assert.equal(posts,1);
  assert.equal(budget.snapshot().calls,1);assert.ok(budget.snapshot().accountedUsd<JEV_RESERVE_USD);
 }
});

test('malformed/provider-failure input cannot unlock; dispatched unknown calls keep their reservation and never retry',async()=>{
 for(const output of [new Response('error',{status:503}),new Response('{}'),new Response('x'.repeat(65537))]){
  const budget=new CallBudget(.02,3);let posts=0;
  const client=new PurposeClassifier(budget,async()=>'fixture-key',async()=>{posts++;return output;});
  assert.equal((await client.classify(input(),{scope,current:()=>identity}))?.verdict,'unknown');assert.equal(posts,1);
  assert.equal(budget.snapshot().accountedUsd,JEV_RESERVE_USD);
 }
});

test('absolute deadline checks after synchronous durable reservation prevent late dispatch; valid late usage is settled before rejection',async()=>{
 let clock=100,posts=0;
 const original=new CallBudget(.02,3);
 const budget={reserve:(usd:number)=>{const id=original.reserve(usd);clock+=1500;return id;},settle:original.settle.bind(original),stop:original.stop.bind(original),snapshot:original.snapshot.bind(original)};
 const client=new PurposeClassifier(budget,async()=>'fixture-key',async()=>{posts++;return response('allow');},()=>clock);
 assert.equal((await client.classify(input(),{scope,current:()=>identity}))?.reason,'timeout');assert.equal(posts,0);
 const second=new CallBudget(.02,3);clock=100;
 const late=new PurposeClassifier(second,async()=>'fixture-key',async()=>{clock+=1500;return response('allow');},()=>clock);
 assert.equal((await late.classify(input(),{scope,current:()=>identity}))?.reason,'timeout');assert.ok(second.snapshot().accountedUsd<JEV_RESERVE_USD);
});

test('busy rejects before another key/reservation; changed evidence or policy cannot reuse a valid response',async()=>{
 let release!:(v:Response)=>void,started!:()=>void,keys=0;
 const dispatched=new Promise<void>(resolve=>{started=resolve;}),budget=new CallBudget(.02,3);let current={...identity};
 const client=new PurposeClassifier(budget,async()=>{keys++;return 'fixture-key';},()=>{started();return new Promise< Response>(resolve=>{release=resolve;});});
 const first=client.classify(input(),{scope,current:()=>current});await dispatched;
 assert.equal(await client.classify(input(),{scope,current:()=>current}),undefined);assert.equal(keys,1);assert.equal(budget.snapshot().calls,1);
 current={...identity,evidenceId:`static:${'b'.repeat(64)}`};release(response('allow'));assert.equal((await first)?.reason,'stale');
});

test('explicit cumulative request cap rejects further work before key access even after reservations settle',async()=>{
 const budget=new CallBudget(.02,100);let keys=0;
 const client=new PurposeClassifier(budget,async()=>{keys++;return 'fixture-key';},async()=>response('allow'),()=>performance.now(),3);
 for(let i=0;i<3;i++)assert.equal((await client.classify(input(),{scope,current:()=>identity}))?.verdict,'allow');
 assert.equal((await client.classify(input(),{scope,current:()=>identity}))?.reason,'budget-denied');assert.equal(keys,3);assert.equal(budget.snapshot().calls,3);
});
test('independent classifiers sharing a cumulative budget cannot race past the selected three-call cap',async()=>{
 const budget=new CallBudget(.02,100);for(let i=0;i<2;i++){const id=budget.reserve(0);budget.settle(id,0);}
 let entered=0,ready!:()=>void,release!:()=>void,posts=0;
 const both=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const make=()=>new PurposeClassifier(budget,async()=>{if(++entered===2)ready();await gate;return 'fixture-key';},async()=>{posts++;return response('allow');},()=>performance.now(),3);
 const calls=[make().classify(input(),{scope,current:()=>identity}),make().classify(input(),{scope,current:()=>identity})];await both;release();
 const results=await Promise.all(calls);assert.equal(posts,1);assert.equal(budget.snapshot().calls,3);assert.equal(results.filter(r=>r?.verdict==='allow').length,1);
});
test('insufficient monetary headroom denies before reading a credential or reserving',async()=>{
 const budget=new CallBudget(.001,3);let keys=0,posts=0;
 const client=new PurposeClassifier(budget,async()=>{keys++;return 'fixture-key';},async()=>{posts++;return response('allow');},()=>performance.now(),3);
 const result=await client.classify(input(),{scope,current:()=>identity});assert.equal(result?.reason,'budget-denied');assert.equal(keys,0);assert.equal(posts,0);assert.equal(budget.snapshot().calls,0);
});
test('authenticated wire revoke retires an active classification before a pending credential can dispatch',async()=>{
 let release!:(key:string)=>void,entered!:()=>void,posts=0;const started=new Promise<void>(resolve=>{entered=resolve;});
 const client=new PurposeClassifier(new CallBudget(.02,3),()=>{entered();return new Promise(resolve=>{release=resolve;});},async()=>{posts++;return response('allow');});
 const control=new PurposeControl(()=> 'profile',async()=>({binding:'signin'}),client);
 const granted=await control.extension({action:'grant',binding:'signin',approved:true,resource,purpose:identity.purpose,policyVersion:1,source:{resource,evidenceId,mode:'static-resource'},fields:['resource','purpose','title','summary','pageText']},'profile');
 assert.ok(granted.ok);const grant=granted.value as PurposeProcessingGrant;
 const pending=control.extension({action:'classify',binding:'signin',grantId:grant.id,request:{...input(),expectedConsentRevision:grant.revision}},'profile');
 await started;const revoked=await control.extension({action:'revoke',binding:'signin'},'profile');release('fixture-key');const result=await pending;
 assert.equal(revoked.ok,true);assert.equal(posts,0);assert.equal(result.ok,false);control.close();
});
test('capture-free authenticated control needs a separate one-use processing grant and host-issued signin binding',async()=>{
 const budget=new CallBudget(.02,3);let keys=0,binding='host-signin-binding';
 const client=new PurposeClassifier(budget,async()=>{keys++;return 'fixture-key';},async()=>response('allow'));
 const control=new PurposeControl(()=> 'paired-profile',async()=>({binding}),client);
 const session=await control.extension({action:'session'},'paired-profile');assert.deepEqual(session,{ok:true,value:{binding,configured:true}});assert.equal(keys,0);
 const grant=await control.extension({action:'grant',binding,approved:true,resource,purpose:identity.purpose,policyVersion:1,
  source:{resource,evidenceId,mode:'static-resource'},fields:['resource','purpose','title','summary','pageText']},'paired-profile');
 assert.ok(grant.ok);const g=grant.value as PurposeProcessingGrant;
 const wire={action:'classify',binding,grantId:g.id,request:{...input(),expectedConsentRevision:g.revision}};
 assert.equal((await control.extension(wire,'different-profile')).ok,false);assert.equal(keys,0);
 const accepted=await control.extension(wire,'paired-profile');assert.ok(accepted.ok&&'verdict'in accepted.value);assert.equal(accepted.value.verdict,'allow');
 assert.equal((await control.extension(wire,'paired-profile')).ok,false);assert.equal(keys,1);
 const bad=await control.extension({action:'grant',binding,approved:false,resource},'paired-profile');assert.equal(bad.ok,false);
 binding='other-signin';assert.equal((await control.extension(wire,'paired-profile')).ok,false);assert.equal(keys,1);
 control.close();assert.equal((await control.extension({action:'session'},'paired-profile')).ok,false);
});
