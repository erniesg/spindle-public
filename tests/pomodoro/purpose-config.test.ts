// Host configuration/lazy credential parsing with invented files and a vendor
// protocol fixture. No real key, provider call or spending authority.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredPurpose} from '../../core/preview/purpose-config.js';
import {JEV_MODEL,JEV_SCOPE_REVISION,SCORE_LEVELS} from '../../core/blocking/jev.js';
import type {PurposeIdentity} from '../../core/blocking/purpose.js';
const source={resource:'https://gating.example/lesson',evidenceId:'static:'+'a'.repeat(64),mode:'static-resource' as const};
const input={requestId:'config-test',resource:source.resource,purpose:'Practice algebra',policyVersion:1,expectedModelRevision:JEV_SCOPE_REVISION,expectedConsentRevision:1,title:'Invented algebra',summary:'Invented worked example',pageText:'Invented equations and worked solution.'};
const identity:PurposeIdentity={requestId:input.requestId,resource:input.resource,purpose:input.purpose,policyVersion:1,modelRevision:JEV_SCOPE_REVISION,consentRevision:1,evidenceId:source.evidenceId};
const admission={scope:{modelRevision:JEV_SCOPE_REVISION,consentRevision:1,fields:['resource','purpose','title','summary','pageText'] as const,pageTextSource:source},current:()=>identity};
test('explicit dotenv/raw config reads credentials lazily and never adopts an env assignment as a raw key',async()=>{
 await mkdir('.local',{recursive:true});const directory=await mkdtemp(join(process.cwd(),'.local/purpose-config-'));
 const config=join(directory,'config.json'),key=join(directory,'key.env'),budget=join(directory,'budget.json');let calls=0,authorization='';const original=globalThis.fetch;
 const journal=async()=>writeFile(budget,JSON.stringify({provider:'typesafe',currency:'USD',hardTaskLimit:.02,reservedWorstCase:0,observedSpend:0,requests:[]}),{mode:0o600});
 const select=async(format:string)=>{await writeFile(config,JSON.stringify({provider:'typesafe',keyFile:key,keyFormat:format,budgetFile:budget,maximumCalls:3}),{mode:0o600});return configuredPurpose(config)!;};
 try{
  globalThis.fetch=async(_url,options)=>{calls++;authorization=new Headers(options?.headers).get('Authorization')??'';return Response.json({model:JEV_MODEL,answers:{relevance_choice:{type:'choice',choice:'relevant',confidence:.99,probabilities:{relevant:.99,unrelated:.005,insufficient:.005}},relevance_score:{type:'score',score:4,confidence:.99,legend:Object.fromEntries(SCORE_LEVELS.map((v,i)=>[i,v])),probabilities:{0:0,1:0,2:0,3:0,4:1}},explains_concept:{type:'noul',noul:.99}},usage:{input_tokens:10,output_tokens:1}});};
  await journal();const dotenv=await select('dotenv'); // Key does not exist yet.
  assert.equal(await dotenv.classify({},admission),undefined);assert.equal(calls,0);
  await writeFile(key,"TYPESAFE_API_KEY='invented-local-key'\n",{mode:0o600});
  assert.equal((await dotenv.classify(input,admission))?.verdict,'allow');assert.equal(authorization,'Bearer invented-local-key');assert.equal(calls,1);
  await journal();const rawAssignment=await select('raw');assert.equal((await rawAssignment.classify(input,admission))?.verdict,'unknown');assert.equal(calls,1);assert.equal(JSON.parse(await readFile(budget,'utf8')).requests.length,0);
  await writeFile(key,'invented-raw-key\n');const raw=await select('raw');assert.equal((await raw.classify(input,admission))?.verdict,'allow');assert.equal(authorization,'Bearer invented-raw-key');
  await writeFile(config,JSON.stringify({provider:'nebius',keyFile:key,keyFormat:'dotenv',budgetFile:budget,maximumCalls:3}));assert.throws(()=>configuredPurpose(config),/PURPOSE_CONFIGURATION_UNAVAILABLE/);
 }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
