import {AccountClient,validateWorkOSSessionCredentials,type WorkOSSessionCredentials} from '../account/client.js';
import {startDesktopWorkOSLogin,type DesktopWorkOSAttempt} from '../account/workos-desktop.js';
import {validateServiceOrigin} from './tracking-setup.js';
import {validateWorkOSCleanupLeases,type WorkOSCleanupLease} from './settings.js';
export interface NativeWorkOSSessions {account:{id:string;name:string};tracking:WorkOSSessionCredentials;timer:WorkOSSessionCredentials}
export interface PreviewWorkOSStatus {state:'idle'|'waiting'|'connected'|'failed';backendOrigin?:string;accountName?:string;accountId?:string;code?:string}
interface Dependencies {
 persistCleanup:(leases:readonly WorkOSCleanupLease[])=>Promise<void>;
 transport?:typeof fetch;
 start?:(clientId:string)=>Promise<DesktopWorkOSAttempt>;
 adopt:(origin:string,deviceName:string,sessions:NativeWorkOSSessions,check:()=>void)=>Promise<void>;
 revoke?:(origin:string,session:WorkOSSessionCredentials)=>Promise<void>;
}
async function boundedJson(response:Response,maximum:number):Promise<unknown>{
 if(!response.ok){await response.body?.cancel();throw Error('WORKOS_SIGNIN_UNAVAILABLE');}
 if(!response.body)throw Error('WORKOS_SIGNIN_UNAVAILABLE');const reader=response.body.getReader();let text='',size=0;const decoder=new TextDecoder();
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>maximum)throw Error('WORKOS_SIGNIN_UNAVAILABLE');text+=decoder.decode(item.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 finally{void reader.cancel().catch(()=>{});}
}
/** Owns one native attempt. Its public view contains connection metadata only. */
export class PreviewWorkOSControl {
 private generation=0;private closed=false;private processing:Promise<void>|undefined;private attempt:DesktopWorkOSAttempt|undefined;
 private view:PreviewWorkOSStatus={state:'idle'};
 private durabilityUncertain=false;private cleanup:WorkOSCleanupLease[]=[];private owned:WorkOSCleanupLease[]=[];
 private cleanupTail:Promise<void>=Promise.resolve();
 constructor(private readonly dependencies:Dependencies){}
 status():PreviewWorkOSStatus{return {...this.view};}
 private async persist(leases:WorkOSCleanupLease[]){
  validateWorkOSCleanupLeases(leases);
  try{await this.dependencies.persistCleanup(structuredClone(leases));this.durabilityUncertain=false;}catch{this.durabilityUncertain=true;throw Error('WORKOS_DURABILITY_PENDING');}
 }
 restoreCleanup(leases:readonly WorkOSCleanupLease[]){
  if(this.closed||this.processing||this.attempt)throw Error('WORKOS_HOST_BUSY');
  validateWorkOSCleanupLeases(leases);const restored=[...this.cleanup,...this.owned,...leases].map(({owned:_,...lease})=>structuredClone(lease)),pending:WorkOSCleanupLease[]=[];
  for(const item of restored)if(!pending.some(old=>old.origin===item.origin&&old.session.cookie===item.session.cookie))pending.push(item);
  validateWorkOSCleanupLeases(pending);this.cleanup=pending;this.owned=[];
  if(this.cleanup.length)this.view={state:'failed',backendOrigin:this.cleanup[0].origin,code:'WORKOS_REVOCATION_PENDING'};
 }
 async retryCleanup(){
  try{await this.cleanupIssued();if(!this.cleanup.length&&!this.attempt)this.view={state:'idle'};}
  catch(error){this.view={state:'failed',backendOrigin:this.cleanup[0]?.origin,code:this.durabilityUncertain||error instanceof Error&&error.message==='WORKOS_DURABILITY_PENDING'?'WORKOS_DURABILITY_PENDING':'WORKOS_REVOCATION_PENDING'};throw error;}
 }
 private cleanupIssued(targets=this.cleanup.slice()){
  const task=this.cleanupTail.catch(()=>{}).then(async()=>{
   let failed=false;const confirmed:WorkOSCleanupLease[]=[];
   for(const item of targets){try{await (this.dependencies.revoke?.(item.origin,item.session)??new AccountClient(item.origin).revokeWorkOSSession(item.session,AbortSignal.timeout(3000)));confirmed.push(item);}catch{failed=true;}}
   if(confirmed.length||this.durabilityUncertain){const remaining=this.cleanup.filter(item=>!confirmed.includes(item)),owned=this.owned.filter(item=>!confirmed.includes(item));await this.persist([...remaining,...owned]);this.cleanup=remaining;this.owned=owned;}
   if(failed)throw Error('WORKOS_REVOCATION_PENDING');
  });this.cleanupTail=task;return task;
 }
 async close(){this.closed=true;await this.retire();}
 retire(){const cleanup=this.cancel(true);this.view={state:'idle'};return cleanup;}
 async cancel(retireOwned=false){
  ++this.generation;const attempt=this.attempt,backendOrigin=this.view.backendOrigin;this.attempt=undefined;
  if(this.view.state==='waiting')this.view={state:'failed',backendOrigin:this.view.backendOrigin,code:'WORKOS_SIGNIN_CANCELLED'};
  try{await attempt?.cancel();await this.processing;await this.cleanupIssued([...this.cleanup,...(retireOwned?this.owned:[])]);}
  catch(error){const code=this.durabilityUncertain||error instanceof Error&&error.message==='WORKOS_DURABILITY_PENDING'?'WORKOS_DURABILITY_PENDING':'WORKOS_REVOCATION_PENDING';this.view={state:'failed',backendOrigin,code};throw Error(code);}
 }
 async begin(value:unknown,ownerCheck:()=>void):Promise<{authorizationUrl:string}>{
  if(this.closed)throw Error('WORKOS_HOST_CLOSING');
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('WORKOS_BACKEND_CONFIG_INVALID');
  const input=value as {origin?:unknown;deviceName?:unknown;syncConsent?:unknown};
  if(input.syncConsent!==true)throw Error('WORKOS_SYNC_CONSENT_REQUIRED');
  if(Object.keys(value).sort().join(',')!=='deviceName,origin,syncConsent'||typeof input.origin!=='string'||typeof input.deviceName!=='string'||input.deviceName.length<1||input.deviceName.length>80||/[\u0000-\u001f\u007f]/.test(input.deviceName))throw Error('WORKOS_BACKEND_CONFIG_INVALID');
  validateServiceOrigin(input.origin);ownerCheck();await this.cancel(true);ownerCheck();
  const origin=input.origin,deviceName=input.deviceName,generation=this.generation;
  const check=()=>{if(generation!==this.generation)throw Error('WORKOS_SIGNIN_CANCELLED');ownerCheck();};
  this.view={state:'waiting',backendOrigin:origin};
  try{
   const transport=this.dependencies.transport??fetch;
   const config=await boundedJson(await transport(origin+'/auth/workos/config',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Origin:origin}}),4096) as {configured?:unknown;clientId?:unknown;backendOrigin?:unknown};check();
   if(config?.configured!==true||config.backendOrigin!==origin||typeof config.clientId!=='string'||!/^client_[A-Za-z0-9]{1,200}$/.test(config.clientId))throw Error('WORKOS_BACKEND_CONFIG_INVALID');
   const attempt=await (this.dependencies.start?.(config.clientId)??startDesktopWorkOSLogin(config.clientId,{callbackPort:43168}));
   try{check();const url=new URL(attempt.authorizationUrl);if(url.origin!=='https://api.workos.com'||url.pathname!=='/user_management/authorize')throw Error('WORKOS_BACKEND_CONFIG_INVALID');}
   catch(error){await attempt.cancel();throw error;}
   this.attempt=attempt;
   void attempt.callback.then(callback=>{const task=(async()=>{
    let issued:WorkOSCleanupLease[]=[];
    try{
     check();
     // Do not abort this exchange on cancellation: read returned authority so it
     // can be revoked even when the local owner retired while the backend issued it.
     const result=await boundedJson(await transport(origin+'/auth/workos/native',{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(15000),headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:callback.code,codeVerifier:callback.codeVerifier})}),16384) as NativeWorkOSSessions;
     for(const role of ['tracking','timer'] as const){const candidate=result?.[role];try{validateWorkOSSessionCredentials(candidate);const item={origin,clientId:config.clientId as string,role,session:candidate};issued.push(item);this.cleanup.push(item);}catch{/* Revoke every individually valid credential even if its peer is malformed. */}}
     await this.persist([...this.cleanup,...this.owned]);
     if(issued.length!==2||result.account?.id!==result.tracking.account.id||result.account?.name!==result.tracking.account.name||result.account.id!==result.timer.account.id||result.account.name!==result.timer.account.name||result.tracking.cookie===result.timer.cookie)throw Error('WORKOS_BACKEND_CONFIG_INVALID');
     check();await this.dependencies.adopt(origin,deviceName,result,check);check();
     // The tracking client and parent settings have committed. Keep timer
     // cleanup authority encrypted; it restores as pending after a crash.
     const remaining=this.cleanup.filter(item=>!issued.includes(item)),owned=[...this.owned,...issued.filter(item=>item.role==='timer').map(item=>({...item,owned:true as const}))];
     await this.persist([...remaining,...owned]);check();this.cleanup=remaining;this.owned=owned;issued=[];
     this.attempt=undefined;this.view={state:'connected',backendOrigin:origin,accountName:result.account.name,accountId:result.account.id};
    }catch(error){
     try{await this.cleanupIssued(issued);}catch(cleanupError){if(generation===this.generation)this.view={state:'failed',backendOrigin:origin,code:this.durabilityUncertain||cleanupError instanceof Error&&cleanupError.message==='WORKOS_DURABILITY_PENDING'?'WORKOS_DURABILITY_PENDING':'WORKOS_REVOCATION_PENDING'};return;}
     if(generation===this.generation)this.view={state:'failed',backendOrigin:origin,code:error instanceof Error&&['WORKOS_BACKEND_CONFIG_INVALID','WORKOS_DURABILITY_PENDING'].includes(error.message)?error.message:'WORKOS_SIGNIN_UNAVAILABLE'};
    }finally{if(generation===this.generation)this.attempt=undefined;}
   })();this.processing=task;void task.finally(()=>{if(this.processing===task)this.processing=undefined;});return task;
   },error=>{if(generation===this.generation){this.attempt=undefined;this.view={state:'failed',backendOrigin:origin,code:error instanceof Error&&error.message==='WORKOS_DESKTOP_EXPIRED'?'WORKOS_SIGNIN_EXPIRED':'WORKOS_SIGNIN_UNAVAILABLE'};}});
   return {authorizationUrl:attempt.authorizationUrl};
  }catch(error){if(generation===this.generation)this.view={state:'failed',backendOrigin:origin,code:error instanceof Error&&['WORKOS_BACKEND_CONFIG_INVALID','WORKOS_DURABILITY_PENDING'].includes(error.message)?error.message:'WORKOS_SIGNIN_UNAVAILABLE'};throw Error(this.view.code??'WORKOS_SIGNIN_UNAVAILABLE');}
 }
}
