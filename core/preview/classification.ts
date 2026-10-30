import { createHash,randomUUID } from 'node:crypto';
import { LocalLabels } from '../classification/local.js';
import type { EvidenceRef,Field,Labels,PermittedEvidence } from '../classification/types.js';
import { ModelOperations,RemoteConsent } from '../models/operations.js';
import type { TextProvider } from '../models/provider.js';
import { PreviewSession,type PreviewVisit } from './session.js';
const field=(s:string):Field<string>=>s?{state:'value',value:s}:{state:'empty'};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
// Only the production owner binds this downstream reader. It does not collect,
// authenticate raw events, infer elapsed time or grant recording/remote scopes.
export class CaptureClassification {
  readonly recordingId=randomUUID();
  readonly labels=new LocalLabels(randomUUID());
  readonly remote=new RemoteConsent();
  private known=new Map<string,{recording:string;signature:string;revision:number;expiresAt:number}>();
  private enabled=false;
  private fault='';
  private remoteText=false;
  private remoteImage=false;
  private job:{generation:number;controller:AbortController}|null=null;
  private unsubscribe:()=>void;
  constructor(private session:PreviewSession,private provider?:TextProvider){this.unsubscribe=session.subscribe(()=>this.sync());}
  dispose(){this.job?.controller.abort();this.revokeRemote();for(const [id,entry] of this.known)this.labels.delete(entry.recording,id);this.known.clear();this.local(false);this.unsubscribe();}
  inspect(id:string){const entry=this.known.get(id);if(!entry)throw new Error('CONTEXT_UNAVAILABLE');return this.labels.inspect(entry.recording,id);}
  private available(v:PreviewVisit){
    const browser=v.browser&&v.textSource.startsWith('dom:')&&['browser-receipt-timed-partial','browser-manual-rich-partial','browser-automatic-rich-partial'].includes(v.availability);
    const native=!v.browser&&(['native-text','native-text-incomplete','native-text-pixels-unsupported-privacy-proof','local-ocr','pixel-window-readback','pixels-required-for-image-document'].includes(v.availability)||(v.availability==='ocr-empty-or-surface-unavailable'&&v.imageAvailable===true)||(v.capture?.pixels==='captured'&&(v.imageAvailable===true||v.capture.ocr==='local-ocr'||v.capture.ocr==='ocr-not-requested'&&v.textSource==='native')));
    return v.expiresAt>Date.now()&&(browser||native);
  }
  private projection(v:PreviewVisit){
    if(!this.available(v))return null;
    const browser=v.browser;
    let domain:Field<string>={state:'unsupported'};
    if(browser){try{const host=new URL(v.url).hostname;if(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))domain=field(host);}catch{/* no raw URL fallback */}}
    // Observed here means admitted sampled CONTENT, not whole-visit timing or
    // attention. Receipt-timed browser duration stays partial in the capture owner.
    return {source:browser?'browser' as const:'native' as const,coverage:'observed' as const,appId:field(v.app),domain,title:field(v.title),text:field(v.text)};
  }
  sync(){
    try{
      if(this.job&&this.job.generation!==this.session.generation)this.job.controller.abort();
      const visits=new Map(this.session.visits.map(v=>[v.id,v]));
      for(const [id,entry] of this.known){const v=visits.get(id);if(!v||entry.expiresAt<=Date.now()||!this.available(v)){this.labels.delete(entry.recording,id);this.known.delete(id);}}
      if(!this.enabled||this.fault)return;
      for(const [id,visit] of visits){
        const evidence=this.projection(visit);if(!evidence)continue;
        const signature=digest(JSON.stringify({evidence,imageRevision:visit.imageRevision??0})),previous=this.known.get(id);
        if(previous?.signature===signature){previous.expiresAt=visit.expiresAt;continue;}
        const revision=(previous?.revision??0)+1,recording=previous?.recording??`${this.recordingId}:${randomUUID()}`;
        const input:PermittedEvidence={...evidence,ref:{ownerId:this.labels.ownerId,recordingId:recording,visitId:id,evidenceId:id,evidenceRevision:revision,consentRevision:0,policyRevision:this.session.generation,deletionRevision:0}};
        this.labels.admit(input);this.known.set(id,{recording,signature,revision,expiresAt:visit.expiresAt});
      }
    }catch{
      // A downstream failure never interrupts capture or leaves remote work live.
      this.fault='CLASSIFICATION_UNAVAILABLE';this.job?.controller.abort();this.revokeRemote();
      for(const [id,entry] of this.known)this.labels.delete(entry.recording,id);
      this.known.clear();this.labels.setProcessing(false);this.enabled=false;
    }
  }
  local(enabled:boolean){this.enabled=enabled;this.labels.setProcessing(enabled);if(!enabled)this.revokeRemote();this.sync();}
  grantRemote(text:boolean,image:boolean){
    if(!this.enabled||this.fault||!this.provider)throw new Error('MODEL_UNAVAILABLE');
    if(image&&!this.provider.model.images)throw new Error('UNSUPPORTED_CAPABILITY');
    if(!text&&!image){this.revokeRemote();return;}
    this.remote.grant({provider:this.provider.model.provider,modelId:this.provider.model.id,operations:['classify'],fields:[...(text?['appId','domain','title','text'] as const:[]),...(image?['image'] as const:[])]});
    this.remoteText=text;this.remoteImage=image;
  }
  revokeRemote(){this.remote.revoke();this.remoteText=false;this.remoteImage=false;}
  correct(id:string,value:Labels,expected?:EvidenceRef){this.sync();const entry=this.known.get(id);if(!entry)throw new Error('CONTEXT_UNAVAILABLE');if(expected&&JSON.stringify(expected)!==JSON.stringify(this.labels.inspect(entry.recording,id).ref))throw new Error('STALE_EVIDENCE');this.labels.correct(entry.recording,id,value);}
  snapshot(){
    this.session.expire();this.sync();
    return {enabled:this.enabled,code:this.fault||'READY',busy:!!this.job,catalogue:this.labels.concepts().filter(c=>!c.retired&&(c.kind==='category'||c.kind==='activity')),remote:{text:this.remoteText,image:this.remoteImage},model:this.provider?.model.id??null,vision:!!this.provider?.model.images,assignments:this.enabled?[...this.known].map(([id,entry])=>this.labels.inspect(entry.recording,id)):[]};
  }
  async classify(id:string,mode:'text'|'image'){
    this.session.expire();this.sync();
    if(!this.enabled||this.fault)return {status:'PROCESSING_OFF'};
    if(!this.provider)return {status:'MODEL_UNAVAILABLE'};
    if(this.job)return {status:'CLASSIFIER_BUSY'};
    const visit=this.session.visits.find(v=>v.id===id),entry=this.known.get(id);
    if(!visit||!entry)return {status:'CONTEXT_UNAVAILABLE'};
    if(mode==='image'&&!this.remoteImage)return {status:'FIELDS_DENIED'};
    const image=mode==='image'?visit.image:undefined;
    if(mode==='image'&&!image)return {status:'IMAGE_UNAVAILABLE'}; // no silent text fallback
    const generation=this.session.generation,signature=entry.signature,imageDigest=image===undefined?null:digest(image);
    const current=()=>{
      this.session.expire();this.sync();
      const v=this.session.visits.find(v=>v.id===id);
      return this.enabled&&!this.fault&&(imageDigest===null||this.remoteImage)&&this.session.generation===generation&&this.known.get(id)?.recording===entry.recording&&this.known.get(id)?.signature===signature&&!!v&&(imageDigest===null||digest(v.image)===imageDigest);
    };
    const controller=new AbortController();this.job={generation,controller};
    try{return await new ModelOperations(this.remote,this.provider).classify(this.labels,entry.recording,id,{current,image,signal:controller.signal});}
    finally{this.job=null;}
  }
}
