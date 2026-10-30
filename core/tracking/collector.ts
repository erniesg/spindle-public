import { randomUUID } from 'node:crypto';
import { PreviewSession } from '../preview/session.js';
import { TrackingClient } from './client.js';
import type { ActivityEvidence, HistoryRecord, Operation } from './types.js';

// Thin sink for the existing visit owner; no sampling timer or duration clock.
// Unknown activity is intentional until a native source supplies coarse evidence.
export class CollectorHistory {
  private tail:Promise<void>=Promise.resolve();
  private queued=0;
  private unsubscribe:()=>void;
  private epoch=-1;
  private recordingId='';
  private wallAnchor=0;
  private monotonicAnchor=0;
  private excluded=new Set<string>();
  private versions=new Map<string,{fingerprint:string;revision:number;activity:ActivityEvidence}>();
  // Bounded redacted templates retain source identities/intervals/acquisition times after preview
  // eviction, never their titles, text, URLs or pixels. Not another clock/store.
  private known=new Map<string,HistoryRecord>();
  private activity:ActivityEvidence={awake:null,unlocked:null,inputAgeBucket:'unknown',heartbeatAt:0,coverage:'unknown'};
  status='ready';
  constructor(private session:PreviewSession,private client:TrackingClient,private deviceId:string,private retentionMs:number){
    if(!Number.isSafeInteger(retentionMs)||retentionMs<60000||retentionMs>30*86400000)throw Error('RETENTION_BOUND');
    this.unsubscribe=session.subscribe(change=>{if(change?.kind==='gap'){this.invalidate(change.at,true);this.capture(true);}else{if(change?.kind==='focus')this.invalidate(change.at,true);this.capture();}});
  }
  evidence(activity:ActivityEvidence){this.activity=structuredClone(activity);this.capture();}
  private stop(code:string){if(this.status!=='ready')return;this.status=code;this.session.pause(this.session.lastAt);this.capture(true);}
  private capture(final=false){
    if(this.status!=='ready'&&!final)return;
    const s=this.session;
    if(!s.options.retain)return;
    if(this.epoch!==s.epoch){this.epoch=s.epoch;this.recordingId=randomUUID();this.wallAnchor=0;this.versions.clear();this.known.clear();this.excluded=new Set(s.visits.map(v=>v.id));}
    if(!s.visits.length)return;
    // Anchor the native monotonic coordinate at its first received observation.
    // Receipt wall time is an estimate, not an invented native wall timestamp.
    if(!this.wallAnchor){this.wallAnchor=Date.now();this.monotonicAnchor=s.lastAt;}
    const visible=new Set(s.visits.map(v=>v.id));
    for(const id of this.versions.keys())if(!visible.has(id))this.versions.delete(id);
    const operations:Operation[]=[];
    for(const visit of s.visits){
      if(this.excluded.has(visit.id))continue;
      // Unenrolled browser intervals have no document proof and cannot be uploaded.
      if(visit.browser&&visit.availability==='profile-revoked'){
        if(this.versions.has(visit.id))operations.push({id:randomUUID(),deviceId:this.deviceId,recordingId:this.recordingId,visitId:visit.id,delete:true});
        this.versions.delete(visit.id);this.known.delete(visit.id);this.excluded.add(visit.id);continue;
      }
      if(visit.browser&&!(visit.availability==='coverage-gap'&&this.known.has(visit.id))&&(!visit.textSource.startsWith('dom:')||!['browser-receipt-timed-partial','browser-manual-rich-partial','browser-automatic-rich-partial'].includes(visit.availability)))continue;
      if(!this.known.has(visit.id)&&this.known.size>=10000){this.stop('HISTORY_BOUND');return;}
      const old=this.versions.get(visit.id);
      const activity=visit===s.active||!old?{...this.activity,heartbeatAt:Math.max(this.activity.heartbeatAt,s.lastAt)}:{...old.activity,heartbeatAt:Math.max(old.activity.heartbeatAt,visit.end??visit.start)};
      const fingerprint=JSON.stringify([visit,activity]);
      if(old?.fingerprint===fingerprint)continue;
      const revision=Math.max(old?.revision??0,this.known.get(visit.id)?.revision??0)+1;
      this.versions.set(visit.id,{fingerprint,revision,activity});
      operations.push({id:randomUUID(),deviceId:this.deviceId,recordingId:this.recordingId,visitId:visit.id,record:{schema:'spindle-tracking/v1',deviceId:this.deviceId,recordingId:this.recordingId,visitId:visit.id,revision,consentRevision:1,policyRevision:1,wallAnchor:this.wallAnchor,monotonicAnchor:this.monotonicAnchor,observedAt:Math.max(s.lastAt,visit.end??s.lastAt,activity.heartbeatAt),expiresAt:Date.now()+this.retentionMs,visit:structuredClone(visit),activity:structuredClone(activity),scopes:{recording:true,retention:true,upload:true,pixels:s.options.pixels},labelRevision:0,correctionRevision:0}});
    }
    for(const op of operations)if(op.record){const r=structuredClone(op.record),v=r.visit;v.title='';v.text='';v.url='';v.image='';v.textSource='unavailable';v.availability='coverage-gap';v.framePTS=null;v.imageRevision=(v.imageRevision??0)+(v.imageAvailable?1:0);v.imageAvailable=false;delete v.imageExpiresAt;delete v.capture;this.known.set(op.visitId,r);}
    this.enqueue(operations,final);
  }
  private invalidate(at:number,reconcile=false){
    const operations:Operation[]=[];
    for(const [id,known] of this.known){
      const end=known.visit.end??known.observedAt,late=known.visit.sampledAt>=at||(known.visit.imageSampledAt??known.visit.sampledAt)>=at;if(end<=at&&known.visit.start<at&&!late)continue;
      const op={id:randomUUID(),deviceId:this.deviceId,recordingId:known.recordingId,visitId:id};
      if(known.visit.start>=at||known.expiresAt<=Date.now()){operations.push({...op,delete:true});this.known.delete(id);this.versions.delete(id);this.excluded.add(id);continue;}
      // Visible intervals are reconciled by normal capture below, preserving
      // exact pre-boundary evidence/corrections. The new native UUID is not in
      // this prior-known table and must never be caught by a blanket cutoff.
      if(reconcile&&this.session.visits.some(v=>v.id===id))continue;
      const record=structuredClone(known);record.revision++;record.visit.end=Math.min(record.visit.end??at,at);record.observedAt=record.visit.end;record.activity.heartbeatAt=record.visit.end;record.visit.sampledAt=record.visit.start;delete record.visit.imageSampledAt;delete record.visit.imageExpiresAt;
      operations.push({...op,record});this.known.set(id,record);this.versions.delete(id);
    }
    this.enqueue(operations,true,true);
  }
  private enqueue(operations:Operation[],final=false,invalidation=false){
    if(!operations.length)return;
    // Preserve immutable updates before PreviewSession evicts its 100-visit ring.
    // Saturation stops acquisition explicitly; it is never a silent rolling loss.
    this.queued++;
    this.tail=this.tail.then(async()=>{try{const puts=operations.filter(op=>op.record);const pending=puts.length?(invalidation?await this.client.reconcileBounds(puts):await this.client.enqueueLatest(puts)):0;const deletes=operations.filter(op=>op.delete);if(invalidation&&deletes.length)await this.client.eraseVisits(deletes);else for(const op of deletes)await this.client.enqueue(op);if(pending>=63)this.stop('HISTORY_PENDING_SYNC_AND_RESTART');}catch(e){this.stop(e instanceof Error?e.message:'HISTORY_WRITE_FAILED');}finally{this.queued--;}});
    if(!final&&this.queued>=4)this.stop('HISTORY_BACKPRESSURE');
  }
  private async drain(){let tail:Promise<void>;do{tail=this.tail;await tail;}while(tail!==this.tail);}
  async settle(){await this.drain();if(this.status!=='ready')throw Error(this.status);}
  async dispose(){this.unsubscribe();await this.drain();}
}
