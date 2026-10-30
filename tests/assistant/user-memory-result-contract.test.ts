// Deterministic replay/scripted Ready only; no paid-model or native acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,alice,bob} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import * as learning from '../../core/memory/learning.js';
import type {AgentProvider,Decision,Schema,Task,ToolMetadata} from '../../core/agent/contracts.js';
const ns={workspaceId:'w',accountId:alice},choices={conversation:true,activity:false,processing:true,sync:false};
const quote='For fictional community grant applications, I prefer concise plain-language answers.';
const value='Prefers concise plain-language answers for fictional community grant applications.';
const key='preference_concise_plain_language';
const tool=(key:string,kind:string,value:string,quote:string):Decision=>({kind:'tool',name:'memory.learn',args:{key,kind,value,quote}});
const rejection={saved:false,reason:'unsupported_learning_declaration'};
const successSchema={type:'object',additionalProperties:false,required:['saved','durability','sync','value','outcome'],properties:{saved:{const:true},durability:{const:'local'},sync:{enum:['pending','synced']},value:{type:'string',minLength:1,maxLength:8192,pattern:'\\S'},outcome:{enum:['saved','already_saved']}}};
const falseSchema={type:'object',additionalProperties:false,required:['saved','reason'],properties:{saved:{const:false},reason:{enum:['user_correction_preserved','forgotten_key_preserved','unsupported_learning_declaration']}}};
const expectedSchema={oneOf:[successSchema,falseSchema]};
const schema=():Schema=>learning.learningResultSchema;
test('strict public result schema/parser reject malformed, extra and contradictory data',()=>{
 const s=schema();assert.deepEqual(s.jsonSchema,expectedSchema);
 for(const outcome of ['saved','already_saved'])for(const sync of ['pending','synced']){const v={saved:true,durability:'local',sync,value:quote,outcome};assert.deepEqual(s.parse(v),v);}
 for(const reason of ['user_correction_preserved','forgotten_key_preserved','unsupported_learning_declaration']){const v={saved:false,reason};assert.deepEqual(s.parse(v),v);}
 const ok={saved:true,durability:'local',sync:'pending',value:quote,outcome:'saved'};
 for(const bad of [null,[],{},true,{...ok,saved:'true'},{...ok,value:''},{...ok,value:'  '},{...ok,value:'x'.repeat(8193)},{...ok,value:1},{...ok,durability:'remote'},{...ok,sync:'unknown'},{...ok,outcome:'accepted'},{...ok,reason:'unsupported_learning_declaration'},{...ok,id:'private'},{saved:true,durability:'local',sync:'pending',value:quote},{saved:false},{saved:false,reason:'unknown'},{...rejection,value:quote},{...rejection,durability:'local'},{...rejection,sync:'pending'},{...rejection,outcome:'saved'}])assert.throws(()=>s.parse(bad),/INVALID_LEARNING_RESULT/);
});
for(const [label,source,canonical,prefKey,goalKey,raw] of [
 ['actual IDs26–29',quote,quote,key,'goal_concise_plain_language',value],
 ['changed tea','For evenings, I prefer tea only after dinner.','For evenings, I prefer tea only after dinner.','tea_preference','tea_goal','Prefers tea only after dinner for evenings.'],
 ['changed coffee','For mornings, I prefer coffee before breakfast.','For mornings, I prefer coffee before breakfast.','coffee_preference','coffee_goal','Prefers coffee before breakfast for mornings.'],
] as const)test(label+': real factory/runtime returns typed rejection then provider chooses its own Ready',async()=>{
 const decisions:Decision[]=[tool(prefKey,'preference',raw,source),tool(prefKey,'preference',raw,source),{kind:'batch',calls:['c1','c2'].map(callId=>({callId,name:'memory.learn',args:{key:prefKey,kind:'preference',value:source,quote:source}}))},tool(goalKey,'goal',raw.replace(/\.$/,''),source)];
 const seen:Task[]=[],metadata:ToolMetadata[][]=[],intents:string[][]=[];let f:ReturnType<typeof fixture>;
 const provider:AgentProvider={id:'actual-decisions-scripted-ready-not-live',async next(t,tools){seen.push(structuredClone(t));metadata.push(structuredClone([...tools]));intents.push(new UserMemoryStore(f.evidence.db).outbox(ns).map(o=>o.id));if(seen.length<=4)return decisions[seen.length-1];assert.equal(t.pending,undefined);assert.equal(t.recovery,'clean');assert.deepEqual(t.observations.at(-1)?.data,rejection);return {kind:'ready',result:'Scripted stop after observing rejection'};}};
 f=fixture(provider);try{
  await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();f.app.conversation(source);await f.app.drain();
  assert.equal(seen.length,5,'wrong-kind policy result must be observable on a subsequent decision');
  assert.equal(metadata[0][0].version,'2');assert.deepEqual(metadata[0][0].outputSchema,expectedSchema);
  const last=seen[4];assert.deepEqual(last.decisions,decisions,'unsafe proposal remains a proposal, not abstention');assert.equal(last.run.cursor,4);assert.equal(last.budget.used,10);
  assert.deepEqual(last.observations.map(o=>o.status),Array(5).fill('ok'));
  assert.deepEqual(last.observations.map(o=>o.data),[...['saved','already_saved','already_saved','already_saved'].map(outcome=>({saved:true,durability:'local',sync:'pending',value:canonical,outcome})),rejection]);
  const store=new UserMemoryStore(f.evidence.db),entries=store.entries(ns);assert.equal(entries.length,1);assert.equal(entries[0].kind,'preference');assert.equal(entries[0].key,prefKey);assert.equal(entries[0].value,canonical);assert.equal(entries[0].revision,1);assert.equal(entries[0].sources?.[0].excerpt,source);assert.equal(store.bindings(ns,prefKey).length,1);assert.deepEqual(store.bindings(ns,goalKey),[]);assert.equal(store.outbox(ns).length,1);for(const ids of intents.slice(1))assert.deepEqual(ids,intents[1]);assert.equal(store.jobs(ns)[0].state,'completed');
 }finally{await f.close();}
});
test('new source at an existing key earns saved, not already_saved based on key existence',async()=>{
 const seen:Task[]=[];const f=fixture({id:'scripted-changed-source',async next(t){seen.push(structuredClone(t));const source=t.requestedOutcome.includes('coffee')?'For mornings, I prefer coffee before breakfast.':'For evenings, I prefer tea only after dinner.';return t.observations.length<2?tool('drink','preference',source,source):{kind:'ready',result:'Done'};}});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();for(const source of ['For evenings, I prefer tea only after dinner.','For mornings, I prefer coffee before breakfast.']){f.app.conversation(source);await f.app.drain();}
  for(const t of [seen[2],seen[5]])assert.deepEqual(t.observations.map(o=>(o.data as {outcome:string}).outcome),['saved','already_saved']);const store=new UserMemoryStore(f.evidence.db);assert.equal(store.outbox(ns).length,2);assert.equal(store.bindings(ns,'drink').length,2);assert.equal(store.entries(ns)[0].value,'For mornings, I prefer coffee before breakfast.');assert.equal(store.entries(ns)[0].revision,2);
 }finally{await f.close();}
});
test('verified identical canonical entry reports already_saved/synced without a new intent',async()=>{
 let calls=0;const seen:Task[]=[];let f:ReturnType<typeof fixture>;
 f=fixture({id:'scripted-canonical',async next(t){seen.push(structuredClone(t));if(++calls===2){const store=new UserMemoryStore(f.evidence.db),entry=store.entries(ns)[0];const {pending,...canonical}=entry;store.putCanonical(ns,{...canonical,seq:1,updatedAt:new Date().toISOString()});store.acknowledge(ns,store.outbox(ns).map(o=>o.id));}return calls<=2?tool('drink','preference','tea','I prefer tea'):{kind:'ready',result:'Done'};}});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.deepEqual(seen[2].observations[1].data,{saved:true,durability:'local',sync:'synced',value:'I prefer tea.',outcome:'already_saved'});assert.deepEqual(new UserMemoryStore(f.evidence.db).outbox(ns),[]);}finally{await f.close();}
});
for(const mode of ['quote','revoke','owner','field','hash','forgotten','expired','read-error','mutation-error','commit','saved-commit'] as const)test('rejection boundary does not soften '+mode+' failure into normal feedback',async()=>{
 const f=fixture();try{
  await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({...choices,processing:false});await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();const base=new UserMemoryStore(f.evidence.db),job=base.jobs(ns)[0];let checks=0,calls=0;
  if(mode==='commit'||mode==='saved-commit')f.evidence.db.exec('PRAGMA foreign_keys=ON; CREATE TABLE contract_parent(id INTEGER PRIMARY KEY); CREATE TABLE contract_child(id INTEGER REFERENCES contract_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  if(mode==='mutation-error')f.evidence.db.exec("CREATE TRIGGER fail_contract_mutation BEFORE INSERT ON user_memory_outbox BEGIN SELECT RAISE(ABORT,'UNSUPPORTED_LEARNING_DECLARATION'); END");
  class BoundaryStore extends UserMemoryStore {
   override transaction<T>(fn:()=>T):T{return super.transaction(()=>{const result=fn();if(mode==='commit'||mode==='saved-commit')this.db.exec('INSERT INTO contract_child VALUES(99)');return result;});}
   override sources(...args:Parameters<UserMemoryStore['sources']>){if(mode==='read-error'&&checks===2)throw Error('UNSUPPORTED_LEARNING_DECLARATION');return super.sources(...args);}
  }
  const store=new BoundaryStore(f.evidence.db);
  const current=()=>{if(++checks===2){if(mode==='revoke')return false;if(mode==='owner')job.source.accountId=bob;if(mode==='field')job.contentStart=2;if(mode==='hash')writeFileSync(join(f.root,'artifacts',job.artifactId),'changed');if(mode==='forgotten')base.forgetSource(ns,job.source);if(mode==='expired')job.source.expiresAt=new Date(0).toISOString();}return true;};
  await assert.rejects(learning.learnSource({store,evidence:f.evidence,ns,job,signal:new AbortController().signal,current,provider:{id:'scripted-hard-failure',async next(){calls++;return tool('wrong',mode==='mutation-error'||mode==='saved-commit'?'preference':'goal','Prefers tea',mode==='quote'?'not in source':'I prefer tea');}}}),/LEARNING_(UNCERTAIN|REVOKED)/);
  assert.equal(calls,1,'no normal policy feedback or Ready after integrity/commit failure');assert.deepEqual(store.entries(ns),[]);assert.deepEqual(store.outbox(ns),[]);assert.deepEqual(store.bindings(ns,'wrong'),[]);
 }finally{await f.close();}
});
test('undefined mutate is not proof of identical qualified provenance',async()=>{
 const f=fixture();try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({...choices,processing:false});await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();const base=new UserMemoryStore(f.evidence.db),job=base.jobs(ns)[0];
  class MismatchStore extends UserMemoryStore {override mutate(){return undefined;}override entries(){return [{workspaceId:'w',key:'drink',revision:1,seq:1,deleted:false,updatedAt:new Date().toISOString(),kind:'preference' as const,value:'I prefer tea.',origin:'inferred' as const,pending:false,sources:[{...job.source,excerpt:'I prefer tea',providerId:'different'}]}];}}
  let calls=0;await assert.rejects(learning.learnSource({store:new MismatchStore(f.evidence.db),evidence:f.evidence,ns,job,signal:new AbortController().signal,current:()=>true,provider:{id:'scripted-mismatch',async next(){calls++;return tool('drink','preference','tea','I prefer tea');}}}),/LEARNING_UNCERTAIN/);assert.equal(calls,1);
 }finally{await f.close();}
});
