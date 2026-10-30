import {AccountClient,validateWorkOSSessionCredentials,type WorkOSSessionCredentials} from '../account/client.js';
import { randomUUID } from 'node:crypto';
import { EncryptedStore } from './store.js';
import { preserveEvictedImage, expireContext, recordKey, validatePage, validateOperation, type Operation, type Entry, type HistoryRecord } from './types.js';
import type {EarnedLease,BrowserLease} from '../blocking/earned-time.js';
type DeleteTarget=Pick<Operation,'deviceId'|'recordingId'|'visitId'>;
export interface EarnedReply {enabled?:boolean;balance?:{earnedSeconds:number;spentSeconds:number;availableSeconds:number;basis:string};policy?:{ratio:number;windowHours:number;minimumSeconds:number;maximumSeconds:number;source:string};lease?:BrowserLease;replayed?:boolean;expired?:boolean}
const earnedId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const earnedHost=(v:unknown):v is string=>typeof v==='string'&&v.length<=253&&/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v);
const earnedCount=(v:unknown,min=0)=>Number.isSafeInteger(v)&&Number(v)>=min;
function earnedLeaseCopy(v:unknown):EarnedLease|undefined{
  if(!v||typeof v!=='object'||Array.isArray(v))return;const l=v as Record<string,unknown>;
  if(!earnedId(l.requestId)||!earnedId(l.accountId)||!earnedId(l.deviceId)||!earnedHost(l.host)||!earnedCount(l.policyVersion,1)||!earnedCount(l.seconds,30)||Number(l.seconds)>1800||!earnedCount(l.issuedAt)||l.expiresAt!==Number(l.issuedAt)+Number(l.seconds)*1000)return;
  return {requestId:l.requestId,accountId:l.accountId,deviceId:l.deviceId,host:l.host,policyVersion:Number(l.policyVersion),seconds:Number(l.seconds),issuedAt:Number(l.issuedAt),expiresAt:Number(l.expiresAt)};
}
/** Allowlisted projection of the account reply; unexpected shapes are unknown, never guessed. */
function earnedReply(v:Record<string,unknown>,action:string):(Omit<EarnedReply,'lease'>&{lease?:EarnedLease})|undefined{
  if(action==='status'){const lease=earnedLeaseCopy(v.lease);return lease&&typeof v.expired==='boolean'?{lease,expired:v.expired}:undefined;}
  const b=v.balance as Record<string,unknown>|undefined,p=v.policy as Record<string,unknown>|undefined;
  if(v.configured!==true||typeof v.enabled!=='boolean'||!b||typeof b!=='object'||!p||typeof p!=='object')return;
  if(!earnedCount(b.earnedSeconds)||!earnedCount(b.spentSeconds)||!earnedCount(b.availableSeconds)||typeof b.basis!=='string'||b.basis.length>200)return;
  if(typeof p.ratio!=='number'||!earnedCount(p.windowHours,1)||!earnedCount(p.minimumSeconds,1)||!earnedCount(p.maximumSeconds,1)||typeof p.source!=='string'||p.source.length>200)return;
  const reply:Omit<EarnedReply,'lease'>&{lease?:EarnedLease}={enabled:v.enabled,balance:{earnedSeconds:Number(b.earnedSeconds),spentSeconds:Number(b.spentSeconds),availableSeconds:Number(b.availableSeconds),basis:b.basis},policy:{ratio:p.ratio,windowHours:Number(p.windowHours),minimumSeconds:Number(p.minimumSeconds),maximumSeconds:Number(p.maximumSeconds),source:p.source}};
  if(action==='redeem'){const lease=earnedLeaseCopy(v.lease);if(!lease||typeof v.replayed!=='boolean')return;reply.lease=lease;reply.replayed=v.replayed;}
  return reply;
}
type AcknowledgedTarget=DeleteTarget&{browser:boolean;revision:number};
type BoundsIntent={id:string;record:HistoryRecord;baseRevision:number};
type RevocationLease=Pick<WorkOSSessionCredentials,'cookie'|'csrf'>;
interface PendingState { pendingRevocations?:RevocationLease[]; bounds?:BoundsIntent[]; awaitingHistory?:AcknowledgedTarget[]; deleting?:DeleteTarget[]; schema:1; origin:string; account:string; accountId?:string; cookie:string; csrf:string; deviceId:string; deviceSecret:string; deviceName:string; pending:Operation[]; cursor:number; entries:Entry[]; lastSync:number|null; error:string }
// Only metadata waits outside the bounded transport queue; the entire deletion
// intent is encrypted before acknowledgement and survives restart/offline periods.
function stageDeletion(s:PendingState){
  while(s.deleting?.length&&s.pending.length<128){const target=s.deleting.shift()!;if(!s.pending.some(o=>o.delete&&recordKey(o)===recordKey(target)))s.pending.push({...target,id:randomUUID(),delete:true});}
  if(!s.deleting?.length)delete s.deleting;
}
function eraseTargets(s:PendingState,requested:Map<string,DeleteTarget>){
  const targets=new Map((s.deleting??[]).map(t=>[recordKey(t),t]));for(const [key,target] of requested)targets.set(key,target);
  if(targets.size>10064)throw Error('DELETE_INTENT_BOUND');
  s.pending=s.pending.filter(o=>!targets.has(recordKey(o)));s.bounds=s.bounds?.filter(b=>!targets.has(recordKey(b.record)));
  s.deleting=[...targets.values()].map(t=>({deviceId:t.deviceId,recordingId:t.recordingId,visitId:t.visitId}));stageDeletion(s);
  for(const e of s.entries)if(targets.has(e.key)){e.deleted=true;delete e.record;}
}
const boundPut=(b:BoundsIntent):Operation=>({id:b.id,deviceId:b.record.deviceId,recordingId:b.record.recordingId,visitId:b.record.visitId,record:b.record});
function validateBounds(b:BoundsIntent,deviceId:string){
  if(!b||!b.record||!Number.isSafeInteger(b.baseRevision)||b.baseRevision<0||b.record.revision<=b.baseRevision||b.record.deviceId!==deviceId||b.record.visit.availability!=='coverage-gap')throw Error('INVALID_BOUNDS_INTENT');
  validateOperation(boundPut(b),Math.min(Date.now(),b.record.expiresAt-1));
}
// A timing-only change must not replace unavailable-but-durable evidence with a
// blank template. Wait in this SAME encrypted state for the exact authenticated
// base to arrive through normal paging; deletion always supersedes this work.
function resolveBounds(s:PendingState,materialize=true){
  const remaining:BoundsIntent[]=[],expired=new Map<string,DeleteTarget>();
  for(const b of s.bounds??[]){
    const key=recordKey(b.record),entry=s.entries.find(e=>e.key===key);
    if(s.pending.some(o=>o.delete&&recordKey(o)===key)||s.deleting?.some(t=>recordKey(t)===key))continue;
    if(b.record.expiresAt<=Date.now()){expired.set(key,b.record);continue;}
    if(entry?.deleted&&!s.awaitingHistory?.some(t=>recordKey(t)===key))continue;
    if(!materialize){remaining.push(b);continue;}
    const queued=s.pending.find(o=>o.record&&recordKey(o)===key)?.record,base=queued??entry?.record;
    if(base&&base.revision>=b.record.revision&&base.visit.end!==null&&base.visit.end<=b.record.visit.end!)continue;
    if(base&&base.revision>b.baseRevision)throw Error('RECONCILIATION_CONFLICT');
    if((!base||base.revision!==b.baseRevision)&&!entry?.deleted||s.pending.length>=64){remaining.push(b);continue;}
    const record=structuredClone(b.record);
    if(base){
      if(['consentRevision','policyRevision','wallAnchor','monotonicAnchor'].some(k=>base[k as keyof HistoryRecord]!==record[k as keyof HistoryRecord])||(['recording','retention','upload','pixels'] as const).some(k=>base.scopes[k]!==record.scopes[k])||['id','key','app','clock','start','revision','browser'].some(k=>base.visit[k as keyof typeof base.visit]!==record.visit[k as keyof typeof record.visit]))throw Error('RECONCILIATION_CONFLICT');
      const visit=structuredClone(base.visit),end=Math.min(visit.end??record.visit.end!,record.visit.end!);
      if(visit.sampledAt<end&&(visit.imageSampledAt??visit.sampledAt)<end){visit.end=end;record.visit=visit;expireContext(record);preserveEvictedImage(record,entry?.record);}
    }
    const op=boundPut({...b,record});validateOperation(op);s.pending=s.pending.filter(o=>!o.record||recordKey(o)!==key);s.pending.push(op);
  }
  s.bounds=remaining;if(expired.size)eraseTargets(s,expired);
}
export class TrackingClient {
  private store:EncryptedStore<PendingState>;private busy=false;
  private idle:Promise<void>=Promise.resolve();private releaseIdle=()=>{};
  private beginNetwork(){this.busy=true;this.idle=new Promise<void>(resolve=>{this.releaseIdle=resolve;});}
  private endNetwork(){this.busy=false;this.releaseIdle();}
  // Owner first detaches producers/holds its timer, then waits before reauth.
  async settle(){await this.idle;await this.store.settle();}
  constructor(readonly origin:string,directory:string,key:Buffer){
    const u=new URL(origin);if(u.origin!==origin||u.username||u.password||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))throw Error('TLS_REQUIRED');
    this.store=new EncryptedStore(directory,Buffer.from(key),()=>({schema:1,origin,account:'',cookie:'',csrf:'',deviceId:'',deviceSecret:'',deviceName:'',pending:[],cursor:0,entries:[],lastSync:null,error:''}));
  }
  private state(reconcile=false){return this.store.transaction(s=>{
    if(s.schema!==1||s.origin!==this.origin)throw Error('CLIENT_IDENTITY_MISMATCH');
    if(s.pendingRevocations){if(!Array.isArray(s.pendingRevocations)||s.pendingRevocations.length>8)throw Error('INVALID_REVOCATION_LEASES');const cookies=new Set<string>();for(const lease of s.pendingRevocations){if(!lease||Object.keys(lease).sort().join(',')!=='cookie,csrf'||!/^spindle_session=[a-f0-9]{64}$/.test(lease.cookie)||!/^[a-f0-9]{64}$/.test(lease.csrf)||cookies.has(lease.cookie))throw Error('INVALID_REVOCATION_LEASES');cookies.add(lease.cookie);}}

    if(!Array.isArray(s.entries)||!Array.isArray(s.pending)||!Number.isSafeInteger(s.cursor)||s.cursor<0)throw Error('INVALID_CACHE');
    if(s.awaitingHistory){if(!Array.isArray(s.awaitingHistory)||s.awaitingHistory.length>10000)throw Error('INVALID_ACK_IDENTITIES');for(const t of s.awaitingHistory){if(!t||Object.keys(t).sort().join(',')!=='browser,deviceId,recordingId,revision,visitId'||typeof t.browser!=='boolean'||!Number.isSafeInteger(t.revision)||t.revision<0)throw Error('INVALID_ACK_IDENTITIES');validateOperation({id:'ack-identity',deviceId:t.deviceId,recordingId:t.recordingId,visitId:t.visitId,delete:true});}}
    const awaiting=new Map((s.awaitingHistory??[]).map(t=>[recordKey(t),t])),keys=new Set<string>();
    for(const e of s.entries){
      validatePage({entries:[e],cursor:e.seq,hasMore:false},e.seq-1,Math.min(Date.now(),e.record?.expiresAt===undefined?Date.now():e.record.expiresAt-1));
      if(e.seq>s.cursor||keys.has(e.key))throw Error('INVALID_CACHE');keys.add(e.key);
      if(e.record&&e.record.expiresAt<=Date.now()){
        // Local expiry/clock skew is not proof of a server tombstone. Keep only
        // the identity needed for a later explicit erase, never expired content.
        if(e.deviceId===s.deviceId){const old=awaiting.get(e.key);awaiting.set(e.key,{deviceId:e.deviceId,recordingId:e.recordingId,visitId:e.visitId,browser:e.record.visit.browser||old?.browser===true,revision:Math.max(e.record.revision,old?.revision??0)});}
        delete e.record;e.deleted=true;
      }
      if(e.record)expireContext(e.record);
    }
    for(const o of s.pending)validateOperation(o,Math.min(Date.now(),o.record?.expiresAt===undefined?Date.now():o.record.expiresAt-1));
    s.pending=s.pending.map(o=>o.record&&o.record.expiresAt<=Date.now()?{id:o.id,deviceId:o.deviceId,recordingId:o.recordingId,visitId:o.visitId,delete:true}:o);
    for(const o of s.pending)if(o.record)expireContext(o.record);
    if(s.deleting){if(!Array.isArray(s.deleting)||s.deleting.length>10064)throw Error('INVALID_DELETE_INTENT');for(const target of s.deleting){if(Object.keys(target).sort().join(',')!=='deviceId,recordingId,visitId')throw Error('INVALID_DELETE_INTENT');validateOperation({...target,id:'delete-intent',delete:true});}}
    if(awaiting.size>10000)throw Error('HISTORY_BOUND');s.awaitingHistory=[...awaiting.values()];
    if(s.bounds){if(!Array.isArray(s.bounds)||s.bounds.length>64)throw Error('BOUNDS_INTENT_BOUND');for(const b of s.bounds)validateBounds(b,s.deviceId);}
    resolveBounds(s,reconcile);stageDeletion(s);return s;
  });}
  private async request(path:string,data:unknown,credentials?:{cookie:string;csrf:string}){
    const response=await fetch(this.origin+path,{method:data===undefined?'GET':'POST',headers:{Origin:this.origin,...(data===undefined?{}:{'Content-Type':'application/json'}),...(credentials?{Cookie:credentials.cookie,'X-CSRF-Token':credentials.csrf}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw Error(`TRACKING_HTTP_${response.status}`);}
    const reader=response.body!.getReader();let size=0;const chunks:Uint8Array[]=[];
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>3_100_000){await reader.cancel();throw Error('RESPONSE_BOUND');}chunks.push(value);}
    return {value:JSON.parse(Buffer.concat(chunks).toString()) as Record<string,unknown>,cookie:response.headers.get('set-cookie')?.split(';')[0]??''};
  }
  private stageRevocation(s:PendingState,lease:RevocationLease){
    if(s.pendingRevocations?.some(v=>v.cookie===lease.cookie))return;
    if((s.pendingRevocations?.length??0)>=8)throw Error('REVOCATION_LEASE_BOUND');
    (s.pendingRevocations??=[]).push({cookie:lease.cookie,csrf:lease.csrf});
  }
  /** Every failed logout retains its encrypted authority; reconnect retries it. */
  private async retryRevocations(){
    const leases=(await this.state()).pendingRevocations??[];
    for(const lease of leases){
      try{await this.request('/logout',{},lease);}
      catch(error){if(!(error instanceof Error)||error.message!=='TRACKING_HTTP_401')continue;}
      await this.store.transaction(s=>{s.pendingRevocations=s.pendingRevocations?.filter(v=>v.cookie!==lease.cookie);});
    }
    await this.store.transaction(s=>{if(s.pendingRevocations?.length)s.error='SESSION_REVOCATION_PENDING';else if(s.error==='SESSION_REVOCATION_PENDING')s.error='';});
  }
  // Password is used only for this request, never persisted. No capture starts here.
  async signin(name:string,password:string,deviceName:string,register=false){
    if(this.busy)throw Error('CLIENT_BUSY');this.beginNetwork();
    try{await this.retryRevocations();const old=await this.state();if(old.account&&old.account!==name)throw Error('ACCOUNT_SWITCH_REQUIRES_NEW_STORE');
      const auth=await this.request(register?'/register':'/signin',{name,password});const credentials={cookie:auth.cookie,csrf:String(auth.value.csrf)};
      const bound=await this.request('/devices',{name:deviceName,...(old.deviceId?{deviceId:old.deviceId,secret:old.deviceSecret}:{})},credentials);
      await this.store.transaction(s=>{s.account=name;s.cookie=credentials.cookie;s.csrf=credentials.csrf;s.deviceId=String(bound.value.deviceId);s.deviceSecret=String(bound.value.secret??old.deviceSecret);s.deviceName=typeof bound.value.name==='string'?bound.value.name:deviceName;});
    }finally{this.endNetwork();}
  }
  /** Trusted native-host session adoption; this never starts capture or changes upload consent. */
  async signinWorkOSSession(value:WorkOSSessionCredentials,deviceName:string){
    validateWorkOSSessionCredentials(value);const incoming={account:{...value.account},cookie:value.cookie,csrf:value.csrf};
    if(typeof deviceName!=='string'||deviceName.length<1||deviceName.length>80)throw Error('INVALID_DEVICE_NAME');
    if(this.busy)throw Error('CLIENT_BUSY');this.beginNetwork();
    const verifier=new AccountClient(this.origin);let journaled=false;
    try{
      await this.retryRevocations();
      // The incoming bearer already exists remotely. Journal before any risky
      // verification or device work, so failure/restart cannot orphan it.
      await this.store.transaction(s=>{this.stageRevocation(s,incoming);s.error='SESSION_REVOCATION_PENDING';});journaled=true;
      const old=await this.state();
      if(old.account&&(old.account!==incoming.account.name||!old.accountId||old.accountId!==incoming.account.id))throw Error('ACCOUNT_SWITCH_REQUIRES_NEW_STORE');
      await verifier.signinWorkOSSession(incoming);
      const bound=await this.request('/devices',{name:deviceName,...(old.deviceId?{deviceId:old.deviceId,secret:old.deviceSecret}:{})},incoming);
      if(typeof bound.value.deviceId!=='string'||!bound.value.deviceId||typeof (bound.value.secret??old.deviceSecret)!=='string'||!(bound.value.secret??old.deviceSecret))throw Error('INVALID_DEVICE_SESSION');
      await this.store.transaction(s=>{
        // Promotion and displacement share one durable commit. Never lose the
        // old bearer between replacing current credentials and remembering logout.
        if(s.cookie&&s.cookie!==incoming.cookie)this.stageRevocation(s,{cookie:s.cookie,csrf:s.csrf});
        s.account=incoming.account.name;s.accountId=incoming.account.id;s.cookie=incoming.cookie;s.csrf=incoming.csrf;s.deviceId=String(bound.value.deviceId);s.deviceSecret=String(bound.value.secret??old.deviceSecret);s.deviceName=typeof bound.value.name==='string'?bound.value.name:deviceName;
        s.pendingRevocations=s.pendingRevocations?.filter(v=>v.cookie!==incoming.cookie);
      });
      await this.retryRevocations();
    }catch(error){if(journaled)await this.retryRevocations();throw error;}
    finally{this.endNetwork();}
  }
  async enqueue(op:Operation){validateOperation(op);const copy=structuredClone(op);if(copy.record)expireContext(copy.record);await this.store.transaction(s=>{
    if(!s.account||!s.deviceId)throw Error('SIGNIN_REQUIRED');if(copy.deviceId!==s.deviceId&&!copy.delete)throw Error('DEVICE_DENIED');
    if(s.pending.some(v=>v.id===copy.id)){if(JSON.stringify(s.pending.find(v=>v.id===copy.id))!==JSON.stringify(copy))throw Error('OPERATION_CONFLICT');return;}
    const pending=copy.delete?s.pending.filter(o=>recordKey(o)!==recordKey(copy)):s.pending;
    // Reserve bounded extra space for privacy fences without discarding unrelated puts.
    if(pending.length+(copy.delete?0:s.bounds?.length??0)>=(copy.delete?128:64))throw Error(copy.delete?'PENDING_BOUND_DELETE_REQUIRES_SYNC':'PENDING_BOUND');
    s.pending=[...pending,copy];
    if(copy.delete){const key=recordKey(copy);s.bounds=s.bounds?.filter(b=>recordKey(b.record)!==key);const entry=s.entries.find(e=>e.key===key);if(entry){entry.deleted=true;delete entry.record;}}
  });}
  // Collector updates supersede only unsent puts for the same visit. In-flight
  // batches retain their IDs, so their acknowledgements cannot remove a newer put.
  async enqueueLatest(operations:Operation[]){
    const copies=structuredClone(operations);for(const op of copies){validateOperation(op);if(op.record)expireContext(op.record);}
    return this.store.transaction(s=>{
      if(!s.account||!s.deviceId)throw Error('SIGNIN_REQUIRED');
      let pending=[...s.pending];
      for(const op of copies){
        if(s.bounds?.some(b=>recordKey(b.record)===recordKey(op)))throw Error('BOUNDS_RECONCILIATION_PENDING');
        if(op.deviceId!==s.deviceId||!op.record)throw Error('DEVICE_DENIED');
        const key=recordKey(op),old=pending.find(o=>recordKey(o)===key);
        if(old?.delete||s.entries.some(e=>e.key===key&&e.deleted))throw Error('VISIT_DELETED');
        if(old?.record&&old.record.revision>=op.record.revision)throw Error('STALE_REVISION');
        preserveEvictedImage(op.record,old?.record??s.entries.find(e=>e.key===key&&!e.deleted)?.record);
        pending=pending.filter(o=>recordKey(o)!==key);pending.push(op);
      }
      if(pending.length+(s.bounds?.length??0)>64)throw Error('PENDING_BOUND');
      // Fail before replacing the durable file, not after accepting unbounded work.
      if(Buffer.byteLength(JSON.stringify({...s,pending}))>30_000_000)throw Error('PENDING_BYTES_BOUND');
      s.pending=pending;return pending.length+(s.bounds?.length??0);
    });
  }
  async reconcileBounds(operations:Operation[]){
    const copies=structuredClone(operations);if(copies.length>64)throw Error('BOUNDS_INTENT_BOUND');
    await this.state();return this.store.transaction(s=>{
      const bounds=[...(s.bounds??[])];for(const op of copies){if(!op.record||op.delete)throw Error('INVALID_BOUNDS_INTENT');const key=recordKey(op),old=bounds.find(b=>recordKey(b.record)===key);
        const b={id:op.id,record:op.record,baseRevision:old?.baseRevision??op.record.revision-1};
        if(old){b.record.visit.end=Math.min(b.record.visit.end!,old.record.visit.end!);b.record.observedAt=b.record.visit.end;b.record.activity.heartbeatAt=b.record.visit.end;}
        validateBounds(b,s.deviceId);
        if(old){if(op.record.revision<old.record.revision)throw Error('STALE_BOUNDS_INTENT');if(op.record.revision===old.record.revision&&JSON.stringify(op.record)!==JSON.stringify(old.record))throw Error('RECONCILIATION_CONFLICT');bounds.splice(bounds.indexOf(old),1,b);}else bounds.push(b);
      }
      if(bounds.length>64)throw Error('BOUNDS_INTENT_BOUND');s.bounds=bounds;resolveBounds(s);return s.pending.length+(s.bounds?.length??0);
    });
  }
  async eraseDeviceHistory(browserOnly=false){
    await this.state();
    await this.store.transaction(s=>{
      const targets=new Map<string,DeleteTarget>();
      for(const b of s.bounds??[])if(!browserOnly||b.record.visit.browser)targets.set(recordKey(b.record),b.record);
      for(const t of s.awaitingHistory??[])if(t.deviceId===s.deviceId&&(!browserOnly||t.browser))targets.set(recordKey(t),t);
      for(const e of s.entries)if(e.deviceId===s.deviceId&&!e.deleted&&(!browserOnly||e.record?.visit.browser))targets.set(recordKey(e),e);
      for(const o of s.pending)if(o.deviceId===s.deviceId&&(!browserOnly||o.record?.visit.browser))targets.set(recordKey(o),o);
      eraseTargets(s,targets);
    });
  }
  async eraseVisits(targets:DeleteTarget[]){
    if(!Array.isArray(targets)||targets.length>10000)throw Error('DELETE_INTENT_BOUND');
    const copies=targets.map(t=>({deviceId:t.deviceId,recordingId:t.recordingId,visitId:t.visitId}));for(const t of copies)validateOperation({...t,id:'visit-invalidation',delete:true});
    await this.state();await this.store.transaction(s=>{if(copies.some(t=>t.deviceId!==s.deviceId))throw Error('DEVICE_DENIED');eraseTargets(s,new Map(copies.map(t=>[recordKey(t),t])));});
  }
  async sync(){
    if(this.busy)throw Error('CLIENT_BUSY');this.beginNetwork();
    try{
      await this.retryRevocations();const s=await this.state(true);if(!s.cookie)throw Error('SIGNIN_REQUIRED');
      const batch:Operation[]=[];let bytes=32;
      for(const queued of s.pending){
        // Expired pending content is never uploaded; preserve only its deletion fence.
        const op:Operation=queued.record&&queued.record.expiresAt<=Date.now()?{id:queued.id,deviceId:queued.deviceId,recordingId:queued.recordingId,visitId:queued.visitId,delete:true}:queued;
        const n=Buffer.byteLength(JSON.stringify(op))+1;if(batch.length>=16||bytes+n>3_000_000)break;batch.push(op);bytes+=n;
      }
      if(batch.length){const result=await this.request('/sync',{operations:batch},s);const ids=new Set(batch.map(o=>o.id));if(!Array.isArray(result.value.acknowledged)||result.value.acknowledged.length!==batch.length||new Set(result.value.acknowledged).size!==batch.length||!result.value.acknowledged.every(id=>typeof id==='string'&&ids.has(id)))throw Error('INVALID_ACK');await this.store.transaction(v=>{
        const known=new Map((v.awaitingHistory??[]).map(t=>[recordKey(t),t]));
        for(const op of batch){const key=recordKey(op);if(op.delete)known.delete(key);else{const old=known.get(key);known.set(key,{deviceId:op.deviceId,recordingId:op.recordingId,visitId:op.visitId,browser:op.record!.visit.browser||old?.browser===true,revision:Math.max(op.record!.revision,old?.revision??0)});}}
        if(known.size>10000)throw Error('HISTORY_BOUND');
        // ACK removes raw puts only in the same durable commit that retains
        // their purge identity, even if the following history read never works.
        v.awaitingHistory=[...known.values()];v.pending=v.pending.filter(o=>!ids.has(o.id));stageDeletion(v);
      });}
      // One bounded page per call, persistent cursor permits incremental reconnect.
      const page=await this.request(`/history?cursor=${s.cursor}&limit=16`,undefined,s);
      validatePage(page.value,s.cursor);
      await this.store.transaction(v=>{
        for(const entry of page.value.entries as Entry[]){const old=v.entries.find(e=>e.key===entry.key);
          if(old?.deleted&&!entry.deleted)continue; // not deletion proof; retain purge identity
          v.awaitingHistory=v.awaitingHistory?.filter(t=>recordKey(t)!==entry.key||!entry.deleted&&(entry.record?.revision??-1)<t.revision);
          if(!entry.deleted&&(v.pending.some(o=>o.delete&&recordKey(o)===entry.key)||v.deleting?.some(o=>recordKey(o)===entry.key)))continue;
          if(old&&old.seq>=entry.seq)continue;
          if(old)v.entries.splice(v.entries.indexOf(old),1,entry);else{if(v.entries.length>=10000)throw Error('HISTORY_BOUND');v.entries.push(entry);}
        }v.cursor=Math.max(v.cursor,Number(page.value.cursor));v.lastSync=Date.now();v.error=v.pendingRevocations?.length?'SESSION_REVOCATION_PENDING':'';
      });const latest=await this.state(true);return {hasMore:page.value.hasMore===true,pending:latest.pending.length+(latest.deleting?.length??0)+(latest.bounds?.length??0)};
    }catch(e){await this.store.transaction(s=>{s.error='SYNC_FAILED';});throw e;}finally{this.endNetwork();}
  }
  /** Study -> earned leisure on the existing authenticated account. Exact known
   * paths only; redeem always uses this client's own registered device. Returns
   * a validated projection, never cookies, CSRF, device secrets or raw bodies.
   * HTTP refusals are definitive (no debit); any other failure is EARNED_RESULT_UNKNOWN. */
  async earnedLeisure(action:'read'|'opt-in'|'redeem'|'status',data:Record<string,unknown>={}):Promise<EarnedReply>{
    if(!['read','opt-in','redeem','status'].includes(action)||!data||typeof data!=='object'||Array.isArray(data))throw Error('EARNED_REQUEST_INVALID');
    const names=Object.keys(data).sort().join(',');
    const body=action==='read'&&names===''?{}:action==='opt-in'&&names==='enabled'&&typeof data.enabled==='boolean'?{enabled:data.enabled}:action==='status'&&names==='requestId'&&earnedId(data.requestId)?{requestId:data.requestId}:action==='redeem'&&names==='host,policyVersion,requestId,seconds'&&earnedId(data.requestId)&&earnedHost(data.host)&&Number.isSafeInteger(data.policyVersion)&&Number(data.policyVersion)>=1&&Number.isSafeInteger(data.seconds)&&Number(data.seconds)>=30&&Number(data.seconds)<=1800?{requestId:data.requestId,host:data.host,policyVersion:data.policyVersion,seconds:data.seconds}:undefined;
    if(!body)throw Error('EARNED_REQUEST_INVALID');
    // Share the one network slot with sync/sign-in: wait briefly, never overlap.
    for(let i=0;this.busy&&i<4;i++)await this.idle;
    if(this.busy)throw Error('CLIENT_BUSY');this.beginNetwork();
    try{
      const s=await this.state();if(!s.cookie||!s.deviceId)throw Error('SIGNIN_REQUIRED');
      const sent=action==='redeem'?{...body,deviceId:s.deviceId}:body;
      let value:Record<string,unknown>;
      try{value=(await this.request('/earned-leisure/'+action,sent,s)).value;}
      catch(error){const status=error instanceof Error?/^TRACKING_HTTP_(4\d\d)$/.exec(error.message)?.[1]:undefined;
        if(status==='401'||status==='403')throw Error(action==='redeem'&&status==='403'?'EARNED_DEVICE_DENIED':'SIGNIN_REQUIRED');
        if(status==='404'&&action==='status')throw Error('EARNED_LEASE_NOT_FOUND');
        if(status)throw Error(action==='redeem'&&status==='409'?'EARNED_REDEEM_REFUSED':'EARNED_REQUEST_REFUSED');
        throw Error('EARNED_RESULT_UNKNOWN');}
      const reply=earnedReply(value,action);
      if(!reply)throw Error('EARNED_RESULT_UNKNOWN');
      if(reply.lease&&(action==='redeem'||action==='status')&&(reply.lease.requestId!==body.requestId||reply.lease.deviceId!==s.deviceId||s.accountId!==undefined&&reply.lease.accountId!==s.accountId||action==='redeem'&&(reply.lease.host!==body.host||reply.lease.policyVersion!==body.policyVersion||reply.lease.seconds!==body.seconds)))throw Error('EARNED_RESULT_UNKNOWN');
      // Validate private account/device bindings before projecting the browser DTO.
      if(reply.lease){const {requestId,host,policyVersion,seconds,issuedAt,expiresAt}=reply.lease;
        return {...reply,lease:{requestId,host,policyVersion,seconds,issuedAt,expiresAt}};}
      return reply;
    }finally{this.endNetwork();}
  }
  async processing(local:boolean){return (await this.request('/processing',{local},await this.state())).value;}
  async sessions(from:number,to:number){return (await this.request(`/sessions?from=${from}&to=${to}`,undefined,await this.state())).value as unknown as import('./session.js').SessionReport;}
  async correct(key:string,evidenceRevision:number,expectedRevision:number,labels:import('../classification/types.js').Labels){return (await this.request('/corrections',{key,evidenceRevision,expectedRevision,labels},await this.state())).value;}
  async undo(key:string,evidenceRevision:number,expectedRevision:number){return (await this.request('/corrections',{key,evidenceRevision,expectedRevision,undo:true},await this.state())).value;}
  async devices(){return (await this.request('/devices',undefined,await this.state())).value;}
  async inspect(){const s=await this.state();return {pendingRevocations:s.pendingRevocations?.length??0,account:s.account,...(s.accountId?{accountId:s.accountId}:{}),deviceId:s.deviceId,deviceName:s.deviceName,pending:s.pending.length+(s.deleting?.length??0)+(s.bounds?.length??0),reconciling:s.bounds?.length??0,awaitingHistory:s.awaitingHistory?.length??0,lastSync:s.lastSync,error:s.error,cursor:s.cursor,entries:s.entries.filter(e=>!s.pending.some(o=>o.delete&&recordKey(o)===e.key)).map(e=>e.record&&e.record.expiresAt<=Date.now()?{...e,record:undefined,deleted:true}:e)};}
}
