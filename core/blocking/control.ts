import {randomUUID} from 'node:crypto';
import {resourceIdentity} from './policy.js';
import {JEV_SCOPE_REVISION} from './jev.js';
import {PurposeClassifier} from './classifier.js';
import type {PurposeField,PurposeIdentity} from './purpose.js';
import type {PurposeProcessingGrant,PurposeWireResponse} from './wire.js';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).sort().join(',')===names.sort().join(',');
const fields:PurposeField[]=['resource','purpose','title','summary','pageText'];
function admitted<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(Error('PURPOSE_RETIRED'));
 return new Promise((resolve,reject)=>{const abort=()=>reject(Error('PURPOSE_RETIRED'));
  signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}

/** Authenticated Native Messaging adapter. The host supplies profile and the
 * existing per-signin account binding. No timer/capture permission is consulted
 * or created; processing has a separate single-use, content-scoped grant.
 */
export class PurposeControl {
 private grant:PurposeProcessingGrant|undefined;
 private pending:AbortController|undefined;
 private revision=0;private epoch=0;private closed=false;
 constructor(private profile:()=>string|undefined,
  private session:(signal:AbortSignal)=>Promise<{binding:string}>,
  private classifier?:PurposeClassifier){}
 revokeProfile(){this.epoch++;this.grant=undefined;this.pending?.abort();}
 close(){if(!this.closed){this.closed=true;this.revokeProfile();}}
 async extension(raw:unknown,profile:unknown,signal?:AbortSignal):Promise<PurposeWireResponse>{
  if(this.closed||typeof profile!=='string'||!profile||profile!==this.profile())return {ok:false,code:'PURPOSE_ACCESS_REQUIRED'};
  if(!object(raw)||Buffer.byteLength(JSON.stringify(raw))>8192)return {ok:false,code:'PURPOSE_INVALID'};
  // Revocation is authenticated by the current profile and stored opaque grant,
  // never queued behind the credential/model operation that it must cancel.
  if(raw.action==='revoke'&&keys(raw,['action','binding'])){
   if(!this.grant||raw.binding!==this.grant.binding)return {ok:false,code:'ACCOUNT_CHANGED'};
   this.revokeProfile();return {ok:true,value:{revoked:true}};
  }
  if(this.pending)return {ok:false,code:'PURPOSE_BUSY'};
  if(!this.classifier)return {ok:false,code:'PURPOSE_UNCONFIGURED'};
  const controller=new AbortController(),epoch=this.epoch,deadline=performance.now()+1400;
  const cancel=()=>controller.abort();if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,1400);this.pending=controller;
  const live=()=>!this.closed&&!controller.signal.aborted&&performance.now()<deadline&&epoch===this.epoch&&profile===this.profile();
  try {
   const identity=await admitted(this.session(controller.signal),controller.signal);
   if(!live())return {ok:false,code:'PURPOSE_RETIRED'};
   if(raw.action==='session'&&keys(raw,['action']))return {ok:true,value:{binding:identity.binding,configured:true}};
   if(raw.binding!==identity.binding)return {ok:false,code:'ACCOUNT_CHANGED'};
   if(raw.action==='grant'){
    if(!keys(raw,['action','binding','approved','resource','purpose','policyVersion','source','fields'])||raw.approved!==true
     ||typeof raw.resource!=='string'||resourceIdentity(raw.resource)!==raw.resource||typeof raw.purpose!=='string'||!raw.purpose.trim()||raw.purpose.length>120
     ||!Number.isSafeInteger(raw.policyVersion)||Number(raw.policyVersion)<1||!Array.isArray(raw.fields)
     ||raw.fields.length!==fields.length||new Set(raw.fields).size!==fields.length||raw.fields.some(v=>!fields.includes(v as PurposeField))
     ||!object(raw.source)||!keys(raw.source,['resource','evidenceId','mode'])||raw.source.resource!==raw.resource
     ||raw.source.mode!=='static-resource'||typeof raw.source.evidenceId!=='string'||!/^static:[a-f0-9]{64}$/.test(raw.source.evidenceId))return {ok:false,code:'PURPOSE_CONSENT_REQUIRED'};
    if(this.revision>=Number.MAX_SAFE_INTEGER)return {ok:false,code:'PURPOSE_UNAVAILABLE'};
    this.grant={id:randomUUID(),binding:identity.binding,revision:++this.revision,modelRevision:JEV_SCOPE_REVISION,
     resource:raw.resource,purpose:raw.purpose,policyVersion:raw.policyVersion as number,
     source:{resource:raw.source.resource as string,evidenceId:raw.source.evidenceId,mode:'static-resource'},fields:[...fields]};
    return {ok:true,value:structuredClone(this.grant)};
   }
   const grant=this.grant;
   if(raw.action!=='classify'||!keys(raw,['action','binding','grantId','request'])||!grant||grant.id!==raw.grantId||grant.binding!==identity.binding||!object(raw.request))return {ok:false,code:'PURPOSE_CONSENT_REQUIRED'};
   const request=raw.request;
   if(request.resource!==grant.resource||request.purpose!==grant.purpose||request.policyVersion!==grant.policyVersion
    ||request.expectedConsentRevision!==grant.revision||request.expectedModelRevision!==grant.modelRevision)return {ok:false,code:'PURPOSE_STALE'};
   const current=():PurposeIdentity|undefined=>live()&&this.grant===grant&&typeof request.requestId==='string'?{
    requestId:request.requestId,resource:grant.resource,purpose:grant.purpose,policyVersion:grant.policyVersion,
    consentRevision:grant.revision,modelRevision:grant.modelRevision,evidenceId:grant.source.evidenceId,
   }:undefined;
   try{
    const result=await this.classifier.classify(request,{scope:{modelRevision:grant.modelRevision,consentRevision:grant.revision,fields:grant.fields,pageTextSource:grant.source},current,signal:controller.signal});
    if(!live()||this.grant!==grant)return {ok:false,code:'PURPOSE_RETIRED'};
    // Recheck the real account session after the model await, not an echoed ID.
    const after=await admitted(this.session(controller.signal),controller.signal);
    if(!live()||after.binding!==grant.binding)return {ok:false,code:'ACCOUNT_CHANGED'};
    return result?{ok:true,value:result}:{ok:false,code:'PURPOSE_UNAVAILABLE'};
   }finally{if(this.grant===grant)this.grant=undefined;}
  }catch{return {ok:false,code:'PURPOSE_UNAVAILABLE'};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(this.pending===controller)this.pending=undefined;}
 }
}
