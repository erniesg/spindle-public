import type {PurposeTransport,PurposeWireRequest,PurposeWireResponse} from '../../core/blocking/wire.js';
// Independent from capture, timer and profile-revoke ports. One normal request
// plus one priority processing-revoke control; only Root authenticates revocation.
export function purposeNativeTransport(profile:()=>Promise<unknown>,revoking:()=>boolean){
 interface Slot {finish:(value:PurposeWireResponse)=>void}
 let active:Slot|undefined,priority:Slot|undefined,sequence=0,generation=0;
 const request:PurposeTransport=(data:PurposeWireRequest,signal?:AbortSignal)=>{
  if(signal?.aborted||revoking())return Promise.resolve({ok:false,code:'PURPOSE_RETIRED'});
  if(new TextEncoder().encode(JSON.stringify(data)).byteLength>8192)return Promise.resolve({ok:false,code:'PURPOSE_INVALID'});
  const revoke=data.action==='revoke';
  if(revoke?priority:active)return Promise.resolve({ok:false,code:'PURPOSE_BUSY'});
  const epoch=generation,deadline=performance.now()+1500;
  return new Promise(resolve=>{
   let port:chrome.runtime.Port|undefined,done=false;
   const id=sequence=sequence%1000000+1;
   const slot:Slot={finish(value){if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    if(revoke){if(priority===slot)priority=undefined;}else if(active===slot)active=undefined;
    if(port){port.onMessage.removeListener(message);port.onDisconnect.removeListener(disconnect);try{port.disconnect();}catch{/* Already disconnected. */}}resolve(value);
   }};
   const cancel=()=>slot.finish({ok:false,code:'PURPOSE_RETIRED'});
   const disconnect=()=>{void chrome.runtime.lastError;slot.finish({ok:false,code:'PURPOSE_UNAVAILABLE'});};
   const message=(value:unknown)=>{
    if(!value||typeof value!=='object'||!('id'in value)||value.id!==id)return;
    if(signal?.aborted||revoking()||generation!==epoch||performance.now()>=deadline){cancel();return;}
    const result=value as {ok?:unknown;value?:unknown;code?:unknown};
    if(result.ok===true)slot.finish({ok:true,value:result.value} as PurposeWireResponse);
    else slot.finish({ok:false,code:typeof result.code==='string'?result.code:'PURPOSE_UNAVAILABLE'});
   };
   const timer=setTimeout(()=>slot.finish({ok:false,code:'PURPOSE_UNAVAILABLE'}),1500);
   if(revoke)priority=slot;else active=slot;
   signal?.addEventListener('abort',cancel,{once:true});
   void(async()=>{try{
    const token=await profile();
    if(done)return;
    if(signal?.aborted||revoking()||generation!==epoch||performance.now()>=deadline){cancel();return;}
    if(typeof token!=='string'||!token){slot.finish({ok:false,code:'PURPOSE_ACCESS_REQUIRED'});return;}
    port=chrome.runtime.connectNative('ai.berlayar.spindle.preview');port.onMessage.addListener(message);port.onDisconnect.addListener(disconnect);
    port.postMessage({schema:'spindle-browser-preview/v1',id,kind:'purpose',profileToken:token,data});
   }catch{slot.finish({ok:false,code:'PURPOSE_UNAVAILABLE'});}})();
  });
 };
 return {request,retire(){generation++;active?.finish({ok:false,code:'PURPOSE_RETIRED'});priority?.finish({ok:false,code:'PURPOSE_RETIRED'});}};
}
