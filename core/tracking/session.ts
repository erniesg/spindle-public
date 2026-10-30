import { LocalLabels } from '../classification/local.js';
import type { Labels, Field, SuggestionSource } from '../classification/types.js';
import { evidenceRevision, type Entry, type HistoryRecord } from './types.js';
export type SessionReport = ReturnType<typeof projectSession>;
export interface Correction { evidenceRevision:number; revision:number; history:Labels[] }
// Remote model output is stored as inference, never as manual correction history.
// description is optional: records written before it existed load unchanged.
export interface Inference { evidenceRevision:number; labels:Labels; source:SuggestionSource; provider:string; model:string; requestId:string; description?:string }
export interface LabelState { local:boolean; corrections:Record<string,Correction>; inferences?:Record<string,Inference> }
const field=(value:string):Field<string>=>value?{state:'value',value}:{state:'empty'};
// Rehydrate the existing deterministic consumer per evidence, not a second classifier.
export function labelEngine(owner:string,r:HistoryRecord){
  r={...structuredClone(r),revision:evidenceRevision(r)};if(r.visit.expiresAt<=Date.now()){r.visit.title='';r.visit.url='';r.visit.text='';}
  const engine=new LocalLabels(owner);engine.setProcessing(true);
  let domain:Field<string>={state:'unavailable'};
  // History URLs may exceed the classifier's domain bound. Missing optional
  // evidence must not prevent projection of valid time or other admitted fields.
  if(r.visit.url)try{const host=new URL(r.visit.url).hostname;if(host.length<=253&&/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host))domain=field(host);}catch{/* unavailable */}
  const available=r.visit.expiresAt>Date.now()&&!['coverage-gap','profile-revoked','context-expired','text-pending','browser-companion-required'].includes(r.visit.availability)&&(r.visit.browser?r.visit.textSource.startsWith('dom:'):['native','ocr'].includes(r.visit.textSource));
  engine.admit({ref:{ownerId:owner,recordingId:r.recordingId,visitId:r.visitId,evidenceId:r.visitId,evidenceRevision:r.revision,consentRevision:r.consentRevision,policyRevision:r.policyRevision,deletionRevision:0},source:r.visit.browser?'browser':'native',coverage:available?'observed':'unknown',appId:field(r.visit.app),domain,title:field(r.visit.title),text:available?field(r.visit.text):{state:'stale'}});
  return engine;
}
export function assignment(owner:string,r:HistoryRecord,state:LabelState,key:string){
  r={...r,revision:evidenceRevision(r)};
  if(!state.local||r.visit.expiresAt<=Date.now())return null;
  const engine=labelEngine(owner,r),c=state.corrections[key],i=state.inferences?.[key];
  // Rehydrate through the same ticket path; a later user correction still wins.
  const remote=i?.evidenceRevision===r.revision&&engine.applySuggestion(engine.beginSuggestion(r.recordingId,r.visitId),i.labels,i.source,i.description);
  if(c?.evidenceRevision===r.revision)for(const labels of c.history)engine.correct(r.recordingId,r.visitId,labels);
  const inspected=engine.inspect(r.recordingId,r.visitId);
  return {...inspected,correctionRevision:c?.evidenceRevision===r.revision?c.revision:0,remoteInference:remote&&inspected.source==='inference'?{provider:i!.provider,model:i!.model,requestId:i!.requestId}:null};
}
// Drop inference for deleted, changed or context-expired evidence.
export function pruneInferences(entries:Entry[],state:LabelState,now=Date.now()){
  for(const [key,i] of Object.entries(state.inferences??{})){const r=entries.find(e=>e.key===key&&!e.deleted)?.record;if(!r||evidenceRevision(r)!==i.evidenceRevision||r.visit.expiresAt<=now)delete state.inferences![key];}
}
export function range(start:string|null,end:string|null){
  if(!start||!end||!/^\d{1,16}$/.test(start)||!/^\d{1,16}$/.test(end))throw Error('INVALID_RANGE');
  const from=Number(start),to=Number(end);
  if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||to<=from||to-from>31*86400000||to>8640000000000000)throw Error('INVALID_RANGE');
  return {from,to};
}
/** Internal key selection bounds projected visits only; clock consistency still
 * uses every live entry, including entries outside the requested time range. */
export function projectSession(owner:string,entries:Entry[],state:LabelState,from:number,to:number,selectedKeys?:ReadonlySet<string>){
  const live=entries.filter(e=>!e.deleted&&e.record);
  const offsets=new Map<string,Set<number>>();
  for(const e of live){const r=e.record!,key=JSON.stringify([r.deviceId,r.recordingId,r.visit.clock]);const values=offsets.get(key)??new Set<number>();values.add(r.wallAnchor-r.monotonicAnchor);offsets.set(key,values);}
  const anomalies:{key:string;reason:string}[]=[];let matched=0;
  const selected=selectedKeys?live.filter(e=>selectedKeys.has(e.key)):live;
  const visits=selected.map(e=>{
    const r={...e.record!,revision:evidenceRevision(e.record!)},v=r.visit;
    // All elapsed values are in the source monotonic domain. Never extrapolate
    // an open visit to request time, nor across a recording/clock incarnation.
    const end=Math.min(v.end??Infinity,r.observedAt,r.activity.heartbeatAt);
    const valid=end>=v.start&&r.activity.heartbeatAt<=r.observedAt;
    const clockConflict=offsets.get(JSON.stringify([r.deviceId,r.recordingId,v.clock]))!.size>1;
    const startUTC=r.wallAnchor+v.start-r.monotonicAnchor,endUTC=r.wallAnchor+end-r.monotonicAnchor;
    const start=Math.max(from,startUTC),stop=Math.min(to,endUTC);
    if(!valid||!Number.isFinite(startUTC)||!Number.isFinite(endUTC)){anomalies.push({key:e.key,reason:'invalid-source-clock'});return null;}
    if(stop<=start)return null;
    if(++matched>512)throw Error('RANGE_BOUND');
    if(clockConflict)anomalies.push({key:e.key,reason:'inconsistent-clock-anchor'});
    const available=r.activity.awake!==false&&r.activity.unlocked!==false;
    const coverage=!clockConflict&&r.activity.coverage==='observed'&&r.activity.awake===true&&r.activity.unlocked===true?'observed':'unknown';
    const content=v.expiresAt>Date.now();
    return {key:e.key,deviceId:r.deviceId,recordingId:r.recordingId,visitId:r.visitId,start,end:stop,duration:stop-start,available,coverage,recentInputHint:['under-15s','15s-1m'].includes(r.activity.inputAgeBucket),inputAgeBucket:r.activity.inputAgeBucket,clock:{source:v.clock,wallAnchor:r.wallAnchor,monotonicAnchor:r.monotonicAnchor,start:v.start,end:v.end,observedAt:r.observedAt,heartbeatAt:r.activity.heartbeatAt},evidenceRevision:r.revision,correctionRevision:content&&state.corrections[e.key]?.evidenceRevision===r.revision?state.corrections[e.key]!.revision:0,label:assignment(owner,r,state,e.key),context:{app:v.app,title:content?v.title:'',url:content?v.url:'',text:content?v.text:'',imageAvailable:content&&!!v.image,textState:content?(v.text?'available':'missing'):'expired',imageState:content?(v.image?'available':'missing'):'expired',sampledAt:v.sampledAt,imageSampledAt:v.imageSampledAt??v.sampledAt,imageExpiresAt:v.imageExpiresAt??v.expiresAt,framePTS:v.framePTS,imageRevision:v.imageRevision??0,textSource:v.textSource,expiresAt:v.expiresAt,availability:v.availability}};
  }).filter((v):v is NonNullable<typeof v>=>v!==null).sort((a,b)=>a.start-b.start||a.key.localeCompare(b.key));
  // Sweep endpoints; do not sum confidence or simultaneous device minutes.
  const points=[...new Set([from,to,...visits.flatMap(v=>[v.start,v.end])])].sort((a,b)=>a-b);
  const blocks=[];let personTime=0,references=0;const perDevice:Record<string,number>={};
  for(let i=0;i<points.length-1;i++){
    const start=points[i]!,end=points[i+1]!,active=visits.filter(v=>v.start<=start&&v.end>=end),observed=active.filter(v=>v.available&&v.coverage==='observed');
    references+=active.length;if(references>32768)throw Error('RANGE_BOUND');
    const devices=[...new Set(observed.map(v=>v.deviceId))];
    if(devices.length)personTime+=end-start;
    for(const device of devices)perDevice[device]=(perDevice[device]??0)+end-start;
    blocks.push({start,end,duration:end-start,visits:active.map(v=>v.key),devices,coverage:devices.length?'observed':'unknown',state:devices.length?'observed':active.length?'partial':'gap',ambiguous:devices.length>1,recentInputHint:observed.filter(v=>v.recentInputHint).map(v=>v.key)});
  }
  return {from,to,personTime,perDevice,visits,blocks,anomalies,processing:state.local?'local':'off',attribution:'Recent input is a provisional hint, not attention; quiet reading is not absence.'};
}
