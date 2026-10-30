import {randomUUID} from 'node:crypto';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {AccountClient} from '../account/client.js';
import type {AgentProvider} from '../agent/contracts.js';
import {digest,type EvidenceStore,type Namespace} from '../evidence/store.js';
import {USER_MEMORY_LIMITS as limits,type MemoryKind,type UserMemorySource,type UserMemoryEntry} from './user-protocol.js';
import {UserMemoryStore,boundedText,type LearningJob} from './user-store.js';
import {learnSource} from './learning.js';
import {syncUserMemory} from './sync.js';
export interface MemoryChoices {conversation:boolean;activity:boolean;processing:boolean;sync:boolean}
export interface UserMemoryOptions {
 evidence:EvidenceStore;/** Root used to construct evidence. Needed to purge owned immutable snapshots on forget. */evidenceRoot:string;
 account:AccountClient;workspaceId:string;provider?:AgentProvider;
}
const off:MemoryChoices={conversation:false,activity:false,processing:false,sync:false};
/** Explicit finite application lifecycle. Starting/signing in never starts capture or enrolls a device. */
export function createUserMemoryApplication(options:UserMemoryOptions){
 const {evidence,account,workspaceId}=options;if(!boundedText(workspaceId,limits.workspace))throw Error('INVALID_WORKSPACE');
 const store=new UserMemoryStore(evidence.db);let generation=0;let controller=new AbortController();let binding='';let timer:ReturnType<typeof setInterval>|undefined;let running:Promise<void>|undefined;let stopped=false;
 const invalidate=()=>{generation++;controller.abort();controller=new AbortController();};
 const endExpiredSession=async()=>{invalidate();binding='';await account.signout().catch(()=>{});};
 const ns=():Namespace=>{const id=account.account?.id;if(id!==binding){invalidate();binding=id??'';}if(!id)throw Error('SIGNIN_REQUIRED');return {workspaceId,accountId:id};};
 const choices=(n:Namespace):MemoryChoices=>({...off,...JSON.parse(store.state(n,'choices')??'{}') as Partial<MemoryChoices>});
 const purgeEnvelopes=(n:Namespace)=>{
  if(store.jobs(n).some(j=>j.state==='running'))invalidate();
  // Old extraction prompts copied prior memory, including in abstaining jobs. Purge only this application's tasks.
  if(evidence.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_model_envelopes'").get())
   for(const job of store.jobs(n))if(job.taskId)evidence.db.prepare('DELETE FROM agent_model_envelopes WHERE workspace=? AND account=? AND task=?').run(n.workspaceId,n.accountId,job.taskId);
 };
 const unlinkOwned=(job:LearningJob)=>{if(!/^[a-f0-9-]{36}$/.test(job.artifactId))throw Error('INVALID_OWNED_ARTIFACT');try{unlinkSync(join(options.evidenceRoot,'artifacts',job.artifactId));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
 const purge=(n:Namespace,job:LearningJob,exceptKey?:string,intent:'forget'|'replacement'='forget')=>store.transaction(()=>{
  if(!/^[a-f0-9-]{36}$/.test(job.artifactId))throw Error('INVALID_OWNED_ARTIFACT');
  if(intent==='forget')store.forgetSource(n,job.source);
  purgeEnvelopes(n);
  // Fence first; immutable source is application-owned, never imported from Google/task context.
  for(const entry of store.entries(n))if(intent==='forget'&&entry.key!==exceptKey&&!entry.deleted&&entry.origin==='inferred'&&entry.sources?.some(s=>s.id===job.source.id))store.mutate(n,{key:entry.key,origin:'user',forget:true});
  store.redactSource(n,job.source.sourceId,intent==='replacement');
  const clean={...job,state:'cancelled' as const,source:{...job.source,excerpt:''}};delete clean.text;delete clean.error;store.job(n,clean);store.removeSource(n,job.source.id);
  store.afterCommit(()=>unlinkOwned(job));
  evidence.db.prepare('DELETE FROM sources WHERE id=? AND workspace=? AND account=?').run(job.source.sourceId,n.workspaceId,n.accountId);
  evidence.db.prepare('DELETE FROM artifacts WHERE id=? AND workspace=? AND account=?').run(job.artifactId,n.workspaceId,n.accountId);
 });
 const forgetDependencies=(n:Namespace,key:string)=>store.transaction(()=>{purgeEnvelopes(n);for(const id of store.bindings(n,key)){const job=store.jobs(n).find(j=>j.source.id===id);if(job)purge(n,job,key);}});
 const invalidateActivity=(n:Namespace,id:string,intent:'forget'|'replacement'='forget')=>{
  const jobs=store.jobs(n).filter(j=>j.source.kind==='activity'&&(j.activityKey===id||j.activityKey==='activity:'+id));
  for(const job of jobs)if(job.state!=='cancelled')purge(n,job,undefined,intent);
 };
 const expireMemories=(n:Namespace)=>{for(const entry of store.entries(n))if(!entry.deleted&&entry.origin==='inferred'&&entry.sources?.some(s=>s.expiresAt&&Date.parse(s.expiresAt)<=Date.now())){forgetDependencies(n,entry.key);store.mutate(n,{key:entry.key,origin:'user',forget:true});}};
 const admit=(n:Namespace,kind:'conversation'|'activity',id:string,text:string,observedAt:string,expiresAt?:string,activity?:{key:string;revision:string;sourceRevision:number;contentStart:number})=>{
  if(!boundedText(text,8192)||!boundedText(id,limits.eventId))throw Error('SOURCE_BOUND');
  const existing=store.jobs(n).find(j=>j.id===id);if(existing)return existing;
  if(store.jobs(n).length>=1000)throw Error('TURN_BOUND');
  const snapshot=evidence.put(n,Buffer.from(text),'text/plain',[],{provider:'user',providerId:activity?.revision??kind+':'+id,providerVersion:'1'});const source=snapshot.source!;
  const ref:UserMemorySource={id,kind,sourceId:source.id,workspaceId:n.workspaceId,accountId:n.accountId,sha256:source.sha256,excerpt:'',observedAt,...(expiresAt?{expiresAt}:{}),...(activity?{activityKey:activity.key,activityRevision:activity.sourceRevision}:{})};
  const job:LearningJob={id,source:ref,artifactId:snapshot.artifact.id,state:'queued',...(activity?{activityKey:activity.key,activityRevision:activity.revision,contentStart:activity.contentStart}:{}),...(kind==='conversation'?{text}:{})};
  store.transaction(()=>{store.source(n,ref);store.job(n,job);});return job;
 };
 const pollActivity=async(n:Namespace,signal:AbortSignal,current:()=>boolean)=>{
  const cursor=Number(store.state(n,'activityCursor')??0);const raw=await account.request(`/user-memory/activity?cursor=${cursor}&limit=16`,undefined,signal);
  if(!current())throw Error('SESSION_CHANGED');
  const page=raw as {entries:ActivityEntry[];cursor:number;hasMore:boolean};
  if(!page||Object.keys(page).sort().join(',')!=='cursor,entries,hasMore'||!Array.isArray(page.entries)||page.entries.length>16||!Number.isSafeInteger(page.cursor)||page.cursor<cursor||typeof page.hasMore!=='boolean')throw Error('INVALID_ACTIVITY_PAGE');
  let seq=cursor;const keys=new Set<string>();
  for(const e of page.entries){
   if(!e||!['deviceId','recordingId','visitId'].every(k=>typeof e[k as keyof ActivityEntry]==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(e[k as keyof ActivityEntry] as string))||e.key!==`${e.deviceId}/${e.recordingId}/${e.visitId}`||keys.has(e.key)||!Number.isSafeInteger(e.seq)||e.seq<=seq||typeof e.deleted!=='boolean')throw Error('INVALID_ACTIVITY_IDENTITY');seq=e.seq;keys.add(e.key);
   if(e.deleted){if(e.record!==undefined)throw Error('INVALID_ACTIVITY_DELETE');continue;}
   const r=e.record,v=r?.visit;
   if(!r||r.schema!=='spindle-tracking/v1'||r.deviceId!==e.deviceId||r.recordingId!==e.recordingId||r.visitId!==e.visitId||!Number.isSafeInteger(r.revision)||r.revision<0||!Number.isSafeInteger(r.consentRevision)||r.consentRevision<0||!Number.isSafeInteger(r.policyRevision)||r.policyRevision<0||!Number.isSafeInteger(r.wallAnchor)||r.wallAnchor<0||!Number.isFinite(r.monotonicAnchor)||r.monotonicAnchor<0||!Number.isFinite(r.observedAt)||r.observedAt<0||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<0||r.expiresAt>Date.now()+30*86400000||!v||v.id!==e.visitId||!Number.isFinite(v.expiresAt)||v.expiresAt<0||typeof v.title!=='string'||v.title.length>256||typeof v.text!=='string'||v.text.length>4096||r.scopes?.recording!==true||r.scopes.retention!==true||r.scopes.upload!==true)throw Error('INVALID_ACTIVITY_RECORD');
  }
  if(page.cursor!==seq||page.hasMore&&!page.entries.length)throw Error('INVALID_ACTIVITY_CURSOR');
  const admitted:Array<{id:string;identity:string;revision:number;text:string;hash:string;observedAt:string;expiresAt:string;isNew:boolean;contentStart:number}>=[];const invalidated:string[]=[];
  for(const e of page.entries){
   const id=e.key;const r=e.record;const expired=r&&Math.min(r.expiresAt,r.visit.expiresAt)<=Date.now();
   if(e.deleted||expired){invalidated.push(id);continue;}
   if(!r)continue;
   const identity=`${id}:${r.revision}:${r.consentRevision}:${r.policyRevision}`;
   const text=[r.visit.title,r.visit.text].filter(Boolean).join('\n');if(!text.trim())continue;
   const hash=digest(Buffer.from(text));const old=store.jobs(n).find(j=>j.activityKey===id&&j.activityRevision===identity);
   if(old&&old.source.sha256!==hash)throw Error('ACTIVITY_REVISION_HASH_CHANGED');
   const wall=r.wallAnchor+r.observedAt-r.monotonicAnchor,expiry=Math.min(r.expiresAt,r.visit.expiresAt);
   if(wall<0||!Number.isFinite(wall)||wall>=expiry||!Number.isFinite(new Date(wall).getTime()))throw Error('INVALID_ACTIVITY_TIME');
   admitted.push({id,identity,revision:r.revision,text,hash,contentStart:r.visit.title&&r.visit.text?r.visit.title.length+1:0,observedAt:new Date(wall).toISOString(),expiresAt:new Date(expiry).toISOString(),isNew:!old});
  }
  // Validate every revision/hash/time before admitting any page text or purging a prior source.
  for(const id of invalidated)invalidateActivity(n,id);
  for(const source of admitted){if(source.isNew)invalidateActivity(n,source.id,'replacement');admit(n,'activity','activity:'+digest(Buffer.from(source.identity+':'+source.hash)),source.text,source.observedAt,source.expiresAt,{key:source.id,revision:source.identity,sourceRevision:source.revision,contentStart:source.contentStart});}
  store.setState(n,'activityCursor',String(page.cursor));
 };
 const drain=():Promise<void>=>{
  if(running)return running;if(stopped)return Promise.resolve();
  running=(async()=>{let n:Namespace;try{n=ns();}catch{return;}const g=generation;const signal=controller.signal;const current=()=>!stopped&&!signal.aborted&&generation===g&&account.account?.id===n.accountId;
   try{
    const c=choices(n);expireMemories(n);
    for(const job of store.jobs(n)){
     // Recovery after a crash between durable source intent and unlink.
     if(job.state==='cancelled'){unlinkOwned(job);continue;}
     if(job.state==='running'){job.state='uncertain';job.error='Interrupted provider dispatch; no automatic paid replay';store.job(n,job);}
     if(job.source.expiresAt&&Date.parse(job.source.expiresAt)<=Date.now())purge(n,job);
    }
    if(c.activity&&c.processing){
     try{await pollActivity(n,signal,current);if(current())store.setState(n,'activityError','');}
     catch(e){if(!current())return;if(e instanceof Error&&e.message==='ACCOUNT_HTTP_401'){await endExpiredSession();return;}store.setState(n,'activityError',e instanceof Error&&/^(ACCOUNT_HTTP_|INVALID_|ACTIVITY_)/.test(e.message)?e.message:'ACTIVITY_REQUEST_FAILED');}
    }
    const onDeleted=(key:string)=>{forgetDependencies(n,key);store.acknowledge(n,store.outbox(n).filter(o=>o.key===key).map(o=>o.id));};
    const onInvalidated=(entry:UserMemoryEntry)=>{
     const old=store.canonical(n,entry.key);
     // Only the superseded canonical provenance, never historical key bindings or fresh queued sources.
     if(!old||old.deleted||old.origin!=='inferred'||old.revision>=entry.revision)return;
     store.transaction(()=>{for(const source of old.sources??[]){const job=store.jobs(n).find(j=>j.source.id===source.id);if(job&&job.state!=='cancelled')purge(n,job,undefined,'replacement');}});
    };
    // Read automatic invalidations before extracting. Offline puts are never silently rebased:
    // only a verified, still-admitted completed source may be extracted again with a NEW ID.
    if(current()&&c.sync&&c.activity&&c.processing){
     await syncUserMemory(store,n,account,signal,current,onDeleted,true,onInvalidated);
     for(const op of store.outbox(n)){
      const canonical=store.canonical(n,op.key);
      if(op.origin!=='inferred'||canonical?.deletionReason!=='source_invalidated'||op.expectedRevision>=canonical.revision||!op.sources?.length)continue;
      const jobs=op.sources.map(s=>store.jobs(n).find(j=>j.source.id===s.id&&j.source.sourceId===s.sourceId&&j.source.sha256===s.sha256));
      if(jobs.some(j=>!j||j.state!=='completed'||store.sourceForgotten(n,j.source)||j.source.expiresAt&&Date.parse(j.source.expiresAt)<=Date.now()))continue;
      // Activity polling must have succeeded this pass; stale/offline metadata is not re-evaluation authority.
      if(jobs.some(j=>j!.source.kind==='activity')&&(!c.activity||!c.processing||store.state(n,'activityError')))continue;
      for(const job of jobs){const s=evidence.source(n,job!.source.sourceId);if(s.sha256!==job!.source.sha256||s.snapshotArtifactId!==job!.artifactId||digest(evidence.read(n,job!.artifactId,32768))!==job!.source.sha256)throw Error('ACTIVITY_SOURCE_CHANGED');}
      store.transaction(()=>{store.acknowledge(n,[op.id]);for(const job of jobs)store.job(n,{...job!,state:'queued'});});
     }
    }
    let count=0;
    for(const job of store.jobs(n)){
     if(!current())return;if(count>=4)break;
     if(job.state!=='queued'||!(job.source.kind==='conversation'?c.conversation:c.activity)||!c.processing)continue;
     if(!options.provider){store.setState(n,'error','MODEL_NOT_CONFIGURED');break;}
     count++;job.state='running';store.job(n,job);
     try{await learnSource({store,evidence,ns:n,job,provider:options.provider,signal,current:()=>current()&&(!job.source.expiresAt||Date.parse(job.source.expiresAt)>Date.now())&&store.jobs(n).some(j=>j.id===job.id&&j.state==='running')});if(!current())return;job.state='completed';delete job.error;store.job(n,job);}
     catch{if(current()&&store.jobs(n).some(j=>j.id===job.id&&j.state==='running')){job.state='uncertain';job.error='Planner did not complete; acknowledged local saves remain; no automatic paid replay';store.job(n,job);}}
    }
    if(current()&&c.sync)await syncUserMemory(store,n,account,signal,current,onDeleted,false,onInvalidated);
    if(current()){expireMemories(n);if(options.provider)store.setState(n,'error','');}
   }catch(e){if(current()){if(e instanceof Error&&e.message==='ACCOUNT_HTTP_401')await endExpiredSession();else store.setState(n,'error',e instanceof Error&&/^(ACCOUNT_HTTP_409|INVALID_|ACTIVITY_)/.test(e.message)?e.message:'MEMORY_REQUEST_FAILED');}}
  })().finally(()=>{running=undefined;});return running;
 };
 const service={
  async signin(name:string,password:string,register=false){invalidate();binding='';await running;if(!boundedText(name,128)||!boundedText(password,512))throw Error('INVALID_SIGNIN');await account.signin(name,password,register);const n=ns();store.setState(n,'bound','true');void drain();},
  async signout(){invalidate();binding='';await Promise.all([account.signout(),running]);},
  session(){invalidate();binding=account.account?.id??'';},
  status(afterKey=''){if(afterKey&&!boundedText(afterKey,limits.key))throw Error('INVALID_MEMORY_CURSOR');let n:Namespace;try{n=ns();}catch{return {authenticated:false as const,configured:true};}expireMemories(n);const c=choices(n);const page=store.entries(n).filter(e=>e.key>afterKey);return {authenticated:true as const,account:account.account,choices:c,providerConfigured:!!options.provider,nextAfter:page.length>50?page[49].key:null,entries:page.slice(0,50).map(e=>({...e,...(e.pending&&store.state(n,'error')==='ACCOUNT_HTTP_409'?{conflict:store.canonical(n,e.key)}:{})})), turns:store.jobs(n).filter(j=>j.source.kind==='conversation').slice(-50).map(j=>({id:j.id,text:j.text??'[Forgotten]',state:j.state,error:j.error})),pending:store.outbox(n).length+store.sourceOutbox(n).length,lastSync:store.state(n,'lastSync')??null,error:store.state(n,'error')??'',activityError:store.state(n,'activityError')??''};},
  configure(input:MemoryChoices){const n=ns();if(!input||Object.keys(input).sort().join(',')!=='activity,conversation,processing,sync'||Object.values(input).some(v=>typeof v!=='boolean'))throw Error('INVALID_CHOICES');invalidate();store.setState(n,'choices',JSON.stringify(input));void drain();},
  conversation(text:string){const n=ns(),c=choices(n);if(!c.conversation)throw Error('CONVERSATION_LEARNING_DISABLED');const job=admit(n,'conversation',randomUUID(),text,new Date().toISOString());void drain();return {id:job.id,state:job.state};},
  correct(key:string,kind:MemoryKind,value:string,expectedRevision:number){const n=ns();if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('INVALID_REVISION');store.mutate(n,{key,kind,value,origin:'user',expectedRevision});void drain();},
  resolve(key:string,revision:number,input?:{kind:MemoryKind;value:string}){const n=ns();if(store.state(n,'error')!=='ACCOUNT_HTTP_409')throw Error('NO_VISIBLE_CONFLICT');store.resolve(n,key,revision,input);store.setState(n,'error','');void drain();},
  forget(key:string){const n=ns();invalidate();store.transaction(()=>{forgetDependencies(n,key);store.mutate(n,{key,origin:'user',forget:true});});void drain();},
  forgetConversation(id:string){const n=ns();const job=store.jobs(n).find(j=>j.id===id&&j.source.kind==='conversation');if(!job)throw Error('TURN_UNAVAILABLE');invalidate();purge(n,job);void drain();},
  recall(query:string){const n=ns();expireMemories(n);if(!boundedText(query,512))return [];const tokens=query.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.slice(0,16)??[];return store.entries(n).filter(e=>!e.deleted&&tokens.some(t=>`${e.key} ${e.value}`.toLowerCase().includes(t))).slice(0,20);},
  start(){if(stopped)throw Error('APPLICATION_STOPPED');if(!timer){timer=setInterval(()=>void drain(),1000);timer.unref();void drain();}},
  drain,
  async stop(){stopped=true;invalidate();if(timer)clearInterval(timer);timer=undefined;await running;},
 };
 return service;
}
export type UserMemoryApplication=ReturnType<typeof createUserMemoryApplication>;
// Narrow view of the existing account/history contract. No collector, capture clock or screenshot reads are introduced.
interface ActivityEntry {key:string;deviceId:string;recordingId:string;visitId:string;seq:number;deleted:boolean;record?:{schema:string;deviceId:string;recordingId:string;visitId:string;revision:number;consentRevision:number;policyRevision:number;wallAnchor:number;monotonicAnchor:number;observedAt:number;expiresAt:number;scopes:{recording:boolean;retention:boolean;upload:boolean};visit:{id:string;title:string;text:string;expiresAt:number}}}
