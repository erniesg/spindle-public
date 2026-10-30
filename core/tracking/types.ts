// Storage envelope, not a capture clock. Native adapters preserve PreviewVisit timings.
import type { PreviewVisit } from '../preview/session.js';
export interface ActivityEvidence {
  awake: boolean | null; unlocked: boolean | null;
  inputAgeBucket: 'under-15s'|'15s-1m'|'1m-5m'|'over-5m'|'unknown';
  heartbeatAt: number; coverage: 'observed'|'gap'|'unknown';
}
export interface HistoryRecord {
  schema: 'spindle-tracking/v1'; deviceId: string; recordingId: string; visitId: string;
  revision: number; evidenceRevision?: number; consentRevision: number; policyRevision: number;
  wallAnchor: number; monotonicAnchor: number; observedAt: number;
  expiresAt: number; visit: PreviewVisit; activity: ActivityEvidence;
  scopes: {recording: true; retention: true; upload: true; pixels: boolean};
  // #67 owns interpretation; storage preserves independent correction revisions.
  labelRevision: number; correctionRevision: number;
}
// Memory eviction is not source removal. Restore only the exact retained frame,
// never across a source/sample/consent boundary or after either context expires.
export function preserveEvictedImage(next:HistoryRecord,old?:HistoryRecord,now=Date.now()){
  const v=next.visit,p=old?.visit;
  if(!v.image&&v.imageAvailable===true&&p?.image&&next.scopes.pixels&&old!.scopes.pixels&&v.expiresAt>now&&p.expiresAt>now&&(v.imageExpiresAt??v.expiresAt)>now&&(p.imageExpiresAt??p.expiresAt)>now&&next.consentRevision===old!.consentRevision&&next.policyRevision===old!.policyRevision&&['id','key','revision','textSource','sampledAt','framePTS','imageRevision','imageSampledAt','imageExpiresAt'].every(k=>v[k as keyof PreviewVisit]===p[k as keyof PreviewVisit])){v.image=p.image;if(p.capture)v.capture=structuredClone(p.capture);}
}
export const evidenceRevision=(r:HistoryRecord)=>r.evidenceRevision??r.revision;
export function evidenceFingerprint(r:HistoryRecord){
  const v=r.visit;
  return JSON.stringify([r.consentRevision,r.policyRevision,r.scopes,v.key,v.app,v.title,v.revision,v.browser,v.text,v.textSource,v.url,v.image,v.imageRevision,v.availability]);
}
// Optional context retention is independent of the measured interval envelope.
export function expireContext(r:HistoryRecord,now=Date.now()):boolean {
  const v=r.visit;
  let imageExpired=false;
  if((v.imageExpiresAt??v.expiresAt)<=now&&(v.image||v.imageAvailable)){v.image='';v.imageAvailable=false;imageExpired=true;}
  if(v.expiresAt>now)return imageExpired;
  const changed=!!(v.title||v.url||v.text||v.image||v.imageAvailable);
  v.title='';v.url='';v.text='';v.image='';
  if(v.imageAvailable!==undefined)v.imageAvailable=false;
  return changed||imageExpired;
}
export interface Operation { id: string; deviceId: string; recordingId: string; visitId: string; record?: HistoryRecord; delete?: true }
export interface Entry { key: string; deviceId: string; recordingId: string; visitId: string; seq: number; deleted: boolean; record?: HistoryRecord }
export const recordKey=(v: Pick<Operation,'deviceId'|'recordingId'|'visitId'>)=>`${v.deviceId}/${v.recordingId}/${v.visitId}`;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
export const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function validatePage(value:unknown,cursor:number,now=Date.now()): asserts value is {entries:Entry[];cursor:number;hasMore:boolean} {
  if(!integer(cursor)||!obj(value)||Object.keys(value).sort().join(',')!=='cursor,entries,hasMore'||!Array.isArray(value.entries)||value.entries.length>16||!integer(value.cursor)||typeof value.hasMore!=='boolean'||value.entries.reduce((bytes,e)=>bytes+Buffer.byteLength(JSON.stringify(e)),0)>3_000_000)throw Error('INVALID_PAGE');
  let seq=cursor;const keys=new Set<string>();
  for(const e of value.entries){
    if(!obj(e)||Object.keys(e).some(k=>!['key','deviceId','recordingId','visitId','seq','deleted','record'].includes(k))||!identifier(e.deviceId)||!identifier(e.recordingId)||!identifier(e.visitId)||e.key!==recordKey(e as unknown as Entry)||keys.has(String(e.key))||!integer(e.seq)||Number(e.seq)<=seq||typeof e.deleted!=='boolean'||(e.deleted?e.record!==undefined:e.record===undefined))throw Error('INVALID_PAGE');
    validateOperation({id:'page',deviceId:e.deviceId,recordingId:e.recordingId,visitId:e.visitId,...(e.deleted?{delete:true}:{record:e.record})},now);
    seq=Number(e.seq);keys.add(String(e.key));
  }
  if(value.cursor!==seq||value.hasMore&&value.entries.length===0)throw Error('INVALID_PAGE');
}
export function validateOperation(value:unknown,now=Date.now()): asserts value is Operation {
  if(!obj(value)||!identifier(value.id)||!identifier(value.deviceId)||!identifier(value.recordingId)||!identifier(value.visitId))throw Error('INVALID_OPERATION');
  if(Object.keys(value).some(k=>!['id','deviceId','recordingId','visitId','record','delete'].includes(k)))throw Error('INVALID_OPERATION');
  if(value.delete===true&&value.record===undefined)return;
  const r=value.record;
  if(value.delete!==undefined||!obj(r)||r.schema!=='spindle-tracking/v1'||r.deviceId!==value.deviceId||r.recordingId!==value.recordingId||r.visitId!==value.visitId)throw Error('INVALID_RECORD');
  const keys=['schema','deviceId','recordingId','visitId','revision','consentRevision','policyRevision','wallAnchor','monotonicAnchor','observedAt','expiresAt','visit','activity','scopes','labelRevision','correctionRevision'];
  if(r.evidenceRevision!==undefined&&(!integer(r.evidenceRevision)||Number(r.evidenceRevision)>Number(r.revision)))throw Error('INVALID_EVIDENCE_REVISION');
  if(Object.keys(r).some(k=>k!=='evidenceRevision'&&!keys.includes(k))||keys.some(k=>!(k in r)))throw Error('INVALID_RECORD');
  for(const k of ['revision','consentRevision','policyRevision','wallAnchor','expiresAt','labelRevision','correctionRevision'])if(!integer(r[k]))throw Error('INVALID_TIME_OR_REVISION');
  for(const k of ['monotonicAnchor','observedAt'])if(typeof r[k]!=='number'||!Number.isFinite(r[k])||Number(r[k])<0)throw Error('INVALID_CLOCK');
  if(Number(r.expiresAt)<=now||Number(r.expiresAt)>now+30*86400000)throw Error('RETENTION_BOUND');
  if(!obj(r.scopes)||r.scopes.recording!==true||r.scopes.retention!==true||r.scopes.upload!==true||typeof r.scopes.pixels!=='boolean'||Object.keys(r.scopes).length!==4)throw Error('CONSENT_REQUIRED');
  const a=r.activity;
  if(!obj(a)||Object.keys(a).length!==5||![true,false,null].includes(a.awake as boolean|null)||![true,false,null].includes(a.unlocked as boolean|null)||(typeof a.inputAgeBucket!=='string'||!['under-15s','15s-1m','1m-5m','over-5m','unknown'].includes(a.inputAgeBucket))||(typeof a.heartbeatAt!=='number'||!Number.isFinite(a.heartbeatAt)||a.heartbeatAt<0)||(typeof a.coverage!=='string'||!['observed','gap','unknown'].includes(a.coverage)))throw Error('INVALID_ACTIVITY');
  const v=r.visit;
  if(!obj(v)||v.id!==r.visitId)throw Error('INVALID_VISIT');
  const strings:Record<string,number>={id:128,key:256,app:128,title:256,clock:128,text:4096,textSource:512,url:2048,image:2800000,availability:80};
  const allowed=[...Object.keys(strings),'start','end','revision','browser','sampledAt','framePTS','expiresAt','imageRevision','imageAvailable','imageSampledAt','imageExpiresAt','capture'];
  if(Object.keys(v).some(k=>!allowed.includes(k)))throw Error('INVALID_VISIT');
  for(const [k,max] of Object.entries(strings))if(typeof v[k]!=='string'||String(v[k]).length>max)throw Error('INVALID_VISIT');
  for(const k of ['start','revision','sampledAt','expiresAt'])if(typeof v[k]!=='number'||!Number.isFinite(v[k])||Number(v[k])<0)throw Error('INVALID_VISIT');
  for(const k of ['imageSampledAt','imageExpiresAt'])if(v[k]!==undefined&&(typeof v[k]!=='number'||!Number.isFinite(v[k])||Number(v[k])<0))throw Error('INVALID_VISIT');
  if(v.imageSampledAt!==undefined&&Number(v.imageSampledAt)<Number(v.start))throw Error('INVALID_VISIT');
  if(v.end!==null&&(typeof v.end!=='number'||!Number.isFinite(v.end)||v.end<Number(v.start)))throw Error('INVALID_VISIT');
  if(v.end!==null&&(v.image||v.imageAvailable===true)&&Number(v.imageSampledAt??v.sampledAt)>Number(v.end))throw Error('IMAGE_TIME_DENIED');
  if(typeof v.browser!=='boolean'||Number(v.sampledAt)<Number(v.start)||v.framePTS!==null&&(typeof v.framePTS!=='number'||!Number.isFinite(v.framePTS)))throw Error('INVALID_VISIT');
  if(v.imageRevision!==undefined&&!integer(v.imageRevision)||v.imageAvailable!==undefined&&typeof v.imageAvailable!=='boolean')throw Error('INVALID_VISIT');
  if(v.capture!==undefined){
    const c=v.capture,codes=['pixels','ocr','image'],dimensions=['sourceWidth','sourceHeight','imageWidth','imageHeight','ocrWidth','ocrHeight'];
    if(!obj(c)||Object.keys(c).length!==9||codes.some(k=>typeof c[k]!=='string'||!/^[a-z0-9-]{1,80}$/.test(String(c[k])))||dimensions.some(k=>!integer(c[k])||Number(c[k])>2147483647))throw Error('INVALID_CAPTURE');
  }
  if(v.url){const u=new URL(String(v.url));if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('UNSANITISED_URL');}
  // An explicit invalidation preserves only measured time, never new browser
  // content/proof. Normal browser observations still require the enrolled DOM seam.
  const gap=v.availability==='coverage-gap'&&v.end!==null&&v.title===''&&v.text===''&&v.url===''&&v.image===''&&v.imageAvailable===false&&v.textSource==='unavailable'&&v.sampledAt===v.start&&v.imageSampledAt===undefined&&v.imageExpiresAt===undefined&&v.framePTS===null&&v.capture===undefined;
  if(v.availability==='coverage-gap'&&!gap)throw Error('INVALID_GAP_CONTEXT');
  if(v.browser&&!gap&&(!String(v.textSource).startsWith('dom:')||!['browser-receipt-timed-partial','browser-manual-rich-partial','browser-automatic-rich-partial'].includes(String(v.availability))))throw Error('BROWSER_PROOF_REQUIRED');
  if(v.image){
    const image=String(v.image),png=Buffer.from(image,'base64');
    // Shared history admits bounded Windows 4K frames too; the Mac producer's
    // own downscale limit must not become a cross-platform admission rule.
    if(!r.scopes.pixels||png.length<33||png.length>2_000_000||png.toString('base64')!==image||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)<1||png.readUInt32BE(20)<1||png.readUInt32BE(16)*png.readUInt32BE(20)>32*1024*1024)throw Error('PIXELS_DENIED');
  }
}
