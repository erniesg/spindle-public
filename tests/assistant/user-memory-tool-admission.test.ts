// Offline dispatcher/control regressions, not live semantic/model acceptance.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,alice,bob} from './user-memory-fixture.js';
import {UserMemoryStore} from '../../core/memory/user-store.js';
import {learnSource} from '../../core/memory/learning.js';
import {admitLearning} from '../../core/memory/admission.js';
import type {MemoryKind} from '../../core/memory/user-protocol.js';
import type {AgentProvider,ToolResult} from '../../core/agent/contracts.js';
const ns={workspaceId:'w',accountId:alice},choices={conversation:true,activity:false,processing:true,sync:false};
const action=(quote:string,value='Prefers tea',kind:MemoryKind='preference',key='drink')=>({kind:'tool' as const,name:'memory.learn',args:{key,kind,value,quote}});
for(const [source,values,canonical] of [
 ['For fictional community grant applications, I prefer concise plain-language answers.',['concise plain-language answers','For fictional community grant applications, I prefer concise plain-language answers.','Prefers concise plain-language answers for fictional community grant applications.'],'For fictional community grant applications, I prefer concise plain-language answers.'],
 ['I dislike coffee',['coffee','Dislikes coffee','I dislike coffee'],'I dislike coffee.'],
 ['For evenings, I like tea only after dinner',['tea only after dinner','Likes tea only after dinner for evenings'],'For evenings, I like tea only after dinner.'],
] as const)test('source-derived canonical value retains full predicate and qualifications: '+source,()=>{for(const value of values)assert.equal(admitLearning(source,{key:'drink',kind:'preference',value,quote:source}),canonical);});
test('fact and goal admitted values are returned unchanged',()=>{assert.equal(admitLearning('I am drafting this week',{kind:'fact',quote:'I am drafting this week',value:'Drafting this week'}),'Drafting this week');assert.equal(admitLearning('I want to finish this week',{kind:'goal',quote:'I want to finish this week',value:'Wants to finish this week'}),'Wants to finish this week');});
for(const [source,quote,value,kind] of [
 ['I prefer tea','I prefer tea','Prefers tea','preference'],
 ['I prefer tea','I prefer tea','I prefer tea','preference'],
 ['For fictional community grant applications, I prefer concise plain-language answers.','For fictional community grant applications, I prefer concise plain-language answers.','For fictional community grant applications, I prefer concise plain-language answers.','preference'],
 ['I prefer tea\nonly in the evening','I prefer tea\nonly in the evening','I prefer tea\nonly in the evening','preference'],
 ['I prefer tea\nonly in the evening','I prefer tea\nonly in the evening','Prefers tea only in the evening','preference'],
 ['I want to finish the application\nthis week','I want to finish the application\nthis week','Wants to finish the application this week','goal'],
 ['For grant applications, I prefer concise answers.','For grant applications, I prefer concise answers.','Prefers concise answers for grant applications.','preference'],
 ['Sample editor\nI am drafting the workshop application in this sample session.','I am drafting the workshop application in this sample session.','Drafting the workshop application in this sample session.','fact'],
 ['Sample editor\nI am drafting the application this week.','I am drafting the application this week.','Drafting the application this week.','goal'],
 ['My goal is to finish the application this week.','My goal is to finish the application this week.','To finish the application this week.','goal'],
 ['Sample editor\nI want to finish the application this week.','I want to finish the application this week.','Wants to finish the application this week.','goal'],
] as const)test('bounded grounding preserves supported '+kind+': '+quote,()=>{assert.doesNotThrow(()=>admitLearning(source,{quote,value,kind},source.startsWith('Sample editor\n')?'Sample editor\n'.length:0));});
for(const [name,source,quote,value,kind] of [
 ['actual quoted third party',"The fictional email says: 'Mira prefers formal language.' I have not stated my own writing preference here.","'Mira prefers formal language.'",'Mira prefers formal language.','preference'],
 ['renamed third party','Ari prefers tea','Ari prefers tea','Prefers tea','preference'],
 ['verbatim third party','Ari prefers tea','Ari prefers tea','Ari prefers tea','preference'],
 ['verbatim explicit secret','I prefer the password SampleOnly123','I prefer the password SampleOnly123','I prefer the password SampleOnly123','preference'],
 ['verbatim permission','I prefer to grant access to everything','I prefer to grant access to everything','I prefer to grant access to everything','preference'],
 ['verbatim uncertainty','I might prefer tea','I might prefer tea','I might prefer tea','preference'],
 ['quoted first person','The note reads: "I prefer tea"','I prefer tea','Prefers tea','preference'],
 ['email from header','Email from Ari\nI prefer tea','I prefer tea','Prefers tea','preference'],
 ['sender header','From: Bri\nI prefer tea','I prefer tea','Prefers tea','preference'],
 ['forwarded header','Forwarded message\nI prefer tea','I prefer tea','Prefers tea','preference'],
 ['wrapped preference','I prefer tea\nonly in the evening','I prefer tea','Prefers tea','preference'],
 ['wrapped preference after period','I prefer tea.\nonly in the evening','I prefer tea.','Prefers tea','preference'],
 ['wrapped fact','I am drafting the application\nthis week','I am drafting the application','Drafting the application','fact'],
 ['wrapped goal','I want to finish the application\nthis week','I want to finish the application','Wants to finish the application','goal'],
 ['named third-party note',"Ari's note\nI prefer tea",'I prefer tea','Prefers tea','preference'],
 ['speaker label','Ari:\nI prefer tea','I prefer tea','Prefers tea','preference'],
 ['reported first person','Ari said. I prefer tea','I prefer tea','Prefers tea','preference'],
 ['inner substring','I wonder whether I prefer tea','I prefer tea','Prefers tea','preference'],
 ['lost qualification','I prefer tea in the evening','I prefer tea','Prefers tea','preference'],
 ['unsupported value','I prefer tea','I prefer tea','Prefers coffee','preference'],
 ['partial object loses modifier','I prefer concise plain-language answers','I prefer concise plain-language answers','plain-language answers','preference'],
 ['object loses time','I prefer tea only in the evening','I prefer tea only in the evening','tea','preference'],
 ['opposite predicate','I dislike coffee','I dislike coffee','Prefers coffee','preference'],
 ['contradictory scope','For grant applications, I prefer tea','For grant applications, I prefer tea','Prefers tea for unrelated travel','preference'],
 ['object third party','Ari prefers tea','Ari prefers tea','tea','preference'],
 ['object quoted speaker','The note reads: "I prefer tea"','I prefer tea','tea','preference'],
 ['object secret','I prefer the password SampleOnly123','I prefer the password SampleOnly123','the password SampleOnly123','preference'],
 ['object permission','I prefer to grant access to everything','I prefer to grant access to everything','to grant access to everything','preference'],
 ['object uncertainty','I might prefer tea','I might prefer tea','tea','preference'],
 ['unsupported negation','I do not prefer tea','I do not prefer tea','tea','preference'],
 ['dropped time','I am drafting this in this sample session','I am drafting this in this sample session','Drafting this','fact'],
 ['permission claim','I prefer to grant access to everything','I prefer to grant access to everything','Prefers to grant access to everything','preference'],
 ['explicit secret','I use password SampleOnly123','I use password SampleOnly123','Uses password SampleOnly123','fact'],
 ['uncertainty','I might prefer tea','I might prefer tea','Prefers tea','preference'],
] as const)test('unsupported '+name+' never writes or acknowledges a save',async()=>{
 assert.throws(()=>admitLearning(source,{quote,value,kind}),/UNSUPPORTED_LEARNING_DECLARATION/);
 const observations:ToolResult[][]=[];const provider:AgentProvider={id:'deterministic-unsupported-no-live',async next(t){observations.push(t.observations);if(t.observations.length){assert.equal(t.observations[0].status,'ok');assert.deepEqual(t.observations[0].data,{saved:false,reason:'unsupported_learning_declaration'});return {kind:'ready',result:'Scripted abstention after rejected proposal'};}return action(quote,value,kind);}};
 const f=fixture(provider);try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();f.app.conversation(source);await f.app.drain();assert.deepEqual(new UserMemoryStore(f.evidence.db).outbox(ns),[]);assert.deepEqual(new UserMemoryStore(f.evidence.db).entries(ns),[]);assert.equal(observations.length,2);assert.equal(new UserMemoryStore(f.evidence.db).jobs(ns)[0].state,'completed');assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM user_memory_bindings').get()?.n,0);}finally{await f.close();}
});
test('second persistence failure rolls back that intent/binding, not the earlier durable tool save; no success ACK for failure',async()=>{
 let calls=0;const observations:ToolResult[][]=[];const f=fixture({id:'deterministic-sql-failure',async next(t){calls++;observations.push(t.observations);return action('I prefer tea','Prefers tea','preference',calls===1?'drink':'second');}});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.evidence.db.exec("CREATE TRIGGER fail_second_binding BEFORE INSERT ON user_memory_bindings WHEN NEW.key='second' BEGIN SELECT RAISE(ABORT,'INVENTED_WRITE_FAILURE'); END");f.app.configure(choices);await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.equal(calls,2);assert.deepEqual(observations[1][0].data,{saved:true,durability:'local',sync:'pending',value:'I prefer tea.',outcome:'saved'});assert.equal(f.app.recall('tea').length,1);assert.equal(f.app.recall('tea')[0].key,'drink');assert.equal(new UserMemoryStore(f.evidence.db).outbox(ns).length,1);assert.equal(f.evidence.db.prepare('SELECT count(*) AS n FROM user_memory_bindings').get()?.n,1);}finally{await f.close();}
});
for(const mode of ['revoke','source-change','wrong-owner','field-change'] as const)test(mode+' at commit rolls back actual tool mutation and binding',async()=>{
 const f=fixture();let current=true,calls=0;try{
  await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({...choices,processing:false});await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();const base=new UserMemoryStore(f.evidence.db),job=base.jobs(ns)[0];job.state='running';base.job(ns,job);
  class CommitRaceStore extends UserMemoryStore {override mutate(...input:Parameters<UserMemoryStore['mutate']>){const result=super.mutate(...input);if(mode==='revoke')current=false;else if(mode==='wrong-owner')job.source.accountId=bob;else if(mode==='field-change')job.contentStart=2;else writeFileSync(join(f.root,'artifacts',job.artifactId),'Changed immutable source');return result;}}
  const store=new CommitRaceStore(f.evidence.db);const provider:AgentProvider={id:'deterministic-commit-race',async next(){calls++;return action('I prefer tea');}};
  await assert.rejects(learnSource({store,evidence:f.evidence,ns,job,provider,signal:new AbortController().signal,current:()=>current}),/LEARNING_(REVOKED|UNCERTAIN)/);assert.equal(calls,1);assert.deepEqual(store.outbox(ns),[]);assert.deepEqual(store.entries(ns),[]);assert.deepEqual(store.bindings(ns,'drink'),[]);
 }finally{await f.close();}
});
test('later explicit correction is preserved and subsequent same-key tool ACK does not claim it saved inference',async()=>{
 let calls=0;const observed:ToolResult[][]=[];let f:ReturnType<typeof fixture>;
 const provider:AgentProvider={id:'deterministic-correction-race',async next(t){calls++;observed.push(t.observations);if(calls===2){const entry=f.app.recall('tea')[0];f.app.correct('drink','preference','Prefers coffee',entry.revision);}if(calls<=2)return action('I prefer tea');throw Error('NO_READY');}};
 f=fixture(provider);try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.equal(f.app.recall('coffee')[0]?.origin,'user');assert.deepEqual(observed[2][1].data,{saved:false,reason:'user_correction_preserved'});assert.doesNotMatch(JSON.stringify(observed[2]),/Prefers coffee/);assert.equal(f.app.recall('tea').length,0);}finally{await f.close();}
});
test('forgotten-key no-op never claims a canonical save or echoes a value',async()=>{
 let calls=0;const seen:ToolResult[][]=[];const f=fixture({id:'deterministic-protected-object',async next(t){seen.push(t.observations);if(++calls===1)return action('I prefer tea','tea');throw Error('NO_READY');}});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure(choices);await f.app.drain();f.app.forget('drink');await f.app.drain();f.app.conversation('I prefer tea');await f.app.drain();assert.deepEqual(seen[1][0].data,{saved:false,reason:'forgotten_key_preserved'});assert.deepEqual(f.app.recall('tea'),[]);assert.equal(new UserMemoryStore(f.evidence.db).outbox(ns)[0].action,'forget');}finally{await f.close();}
});
for(const kind of ['fact','goal'] as const)test('actual activity ingress supports time-qualified '+kind+' tool save without ready',async()=>{
 const quote='I am drafting the application this week.',now=Date.now();let calls=0;
 const f=fixture({id:'deterministic-activity-no-ready',async next(){if(++calls===1)return action(quote,'Drafting the application this week.',kind,'project');throw Error('NO_READY');}},url=>{
  const cursor=Number(url.searchParams.get('cursor'));return {entries:cursor?[]:[{key:'device/recording/visit',deviceId:'device',recordingId:'recording',visitId:'visit',seq:1,deleted:false,record:{schema:'spindle-tracking/v1',deviceId:'device',recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:0,expiresAt:now+60000,scopes:{recording:true,retention:true,upload:true},visit:{id:'visit',title:'Sample editor',text:quote,expiresAt:now+60000}}}],cursor:1,hasMore:false};
 });
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();const entry=f.app.recall('application')[0];assert.equal(calls,2);assert.equal(entry.kind,kind);assert.equal(entry.value,'Drafting the application this week.');assert.equal(entry.sources![0].kind,'activity');assert.equal(entry.sources![0].expiresAt,new Date(now+60000).toISOString());}finally{await f.close();}
});
test('actual trusted activity body object normalizes with source scope, direction and time intact',async()=>{
 const quote='For evenings, I dislike coffee after dinner.',now=Date.now();let calls=0;const seen:ToolResult[][]=[];
 const f=fixture({id:'deterministic-activity-object',async next(t){seen.push(t.observations);if(++calls===1)return action(quote,'coffee after dinner','preference','drink');throw Error('NO_READY');}},url=>{const cursor=Number(url.searchParams.get('cursor'));return {entries:cursor?[]:[{key:'device/recording/visit',deviceId:'device',recordingId:'recording',visitId:'visit',seq:1,deleted:false,record:{schema:'spindle-tracking/v1',deviceId:'device',recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:0,expiresAt:now+60000,scopes:{recording:true,retention:true,upload:true},visit:{id:'visit',title:'Sample editor',text:quote,expiresAt:now+60000}}}],cursor:1,hasMore:false};});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();const entry=f.app.recall('coffee')[0];assert.equal(entry.value,quote);assert.equal(entry.sources![0].excerpt,quote);assert.equal(entry.sources![0].kind,'activity');assert.equal((seen[1][0].data as {value:string}).value,entry.value);}finally{await f.close();}
});
for(const [title,text] of [['Email from Ari','I prefer tea'],['From: Bri','I prefer tea'],['Ari:','I prefer tea'],['Bri:','I prefer tea'],['Ari:\nEditor','I prefer tea'],['Ari：','I prefer tea'],['Sample editor','I prefer tea\nonly in the evening'],['','I prefer tea\nonly in the evening']] as const)test('real activity field grounding rejects '+(title||'untitled')+' / '+text.replace(/\n/g,' '),async()=>{
 const now=Date.now();let calls=0;const f=fixture({id:'deterministic-activity-rejection',async next(t){calls++;if(t.observations.length){assert.equal(t.observations[0].status,'ok');assert.deepEqual(t.observations[0].data,{saved:false,reason:'unsupported_learning_declaration'});return {kind:'ready',result:'Scripted abstention after rejected activity proposal'};}return action('I prefer tea');}},url=>{const cursor=Number(url.searchParams.get('cursor'));return {entries:cursor?[]:[{key:'device/recording/visit',deviceId:'device',recordingId:'recording',visitId:'visit',seq:1,deleted:false,record:{schema:'spindle-tracking/v1',deviceId:'device',recordingId:'recording',visitId:'visit',revision:1,consentRevision:1,policyRevision:1,wallAnchor:now,monotonicAnchor:0,observedAt:0,expiresAt:now+60000,scopes:{recording:true,retention:true,upload:true},visit:{id:'visit',title,text,expiresAt:now+60000}}}],cursor:1,hasMore:false};});
 try{await f.app.signin('Alice','invented');await f.app.drain();f.app.configure({conversation:false,activity:true,processing:true,sync:false});await f.app.drain();const store=new UserMemoryStore(f.evidence.db);assert.equal(calls,2);assert.deepEqual(store.entries(ns),[]);assert.deepEqual(store.outbox(ns),[]);assert.equal(store.jobs(ns)[0].state,'completed');assert.equal(store.jobs(ns)[0].contentStart,title?title.length+1:0);assert.deepEqual(store.bindings(ns,'drink'),[]);}finally{await f.close();}
});
