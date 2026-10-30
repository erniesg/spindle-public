import {installPurposeTransport} from '../blocking/worker.js';
import {purposeNativeTransport} from './purpose-transport.js';
import {installPomodoroDispatch} from '../pomodoro/dispatch.js';
import { visibleText } from './extract.js';
import { pixelDocument } from './pixels.js';
import { pairingReply } from './pairing.js';
import { nativeFailure } from './native-failure.js';
let port:chrome.runtime.Port|null=null,sequence=0,busy=false,enrollmentGeneration=0,focusGeneration=0;
let pairing:Promise<Record<string,unknown>>|null=null,revoking=false,revocationPending=false,revocationToken:unknown;
const navigation=new Map<number,number>();
const pending=new Map<number,{resolve:(value:Record<string,unknown>)=>void;timer:ReturnType<typeof setTimeout>}>();
function connect(){if(port)return port;const p=chrome.runtime.connectNative('ai.berlayar.spindle.preview');port=p;p.onDisconnect.addListener(()=>{const failure=nativeFailure(chrome.runtime.lastError?.message);port=null;for(const v of pending.values()){clearTimeout(v.timer);v.resolve({failure});}pending.clear();});p.onMessage.addListener((m:unknown)=>{if(m&&typeof m==='object'&&'id'in m&&typeof m.id==='number'){const value=pending.get(m.id);if(value){clearTimeout(value.timer);pending.delete(m.id);value.resolve(m as Record<string,unknown>);}}});return p;}
function request(message:Record<string,unknown>):Promise<Record<string,unknown>>{if(pending.size>=3||pending.size>=2&&message.kind!=='revoke')return Promise.resolve({});const p=connect(),id=++sequence;return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve({failure:'HOST_TIMEOUT'});},2000);pending.set(id,{resolve,timer});p.postMessage({schema:'spindle-browser-preview/v1',...message,id});});}
// Timer owns a separate Native Messaging port/slot: never borrows capture/revoke capacity.
let timerPort:chrome.runtime.Port|null=null,timerSequence=0;
let timerPending:{id:number;port:chrome.runtime.Port;resolve:(value:{ok:boolean;value?:unknown;code?:string})=>void;timer:ReturnType<typeof setTimeout>}|undefined;
function connectTimer(){
 if(timerPort)return timerPort;const p=chrome.runtime.connectNative('ai.berlayar.spindle.preview');timerPort=p;
 p.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(timerPort===p)timerPort=null;const pending=timerPending;if(pending?.port===p){clearTimeout(pending.timer);timerPending=undefined;pending.resolve({ok:false,code:'POMODORO_UNAVAILABLE'});}});
 p.onMessage.addListener((value:unknown)=>{const pending=timerPending;if(pending?.port!==p||!value||typeof value!=='object'||!('id'in value)||value.id!==pending.id)return;clearTimeout(pending.timer);timerPending=undefined;const v=value as {ok?:unknown;value?:unknown;code?:unknown};pending.resolve({ok:v.ok===true,value:v.value,...(typeof v.code==='string'?{code:v.code}:{})});});
 return p;
}
installPomodoroDispatch(async data=>{
 const config=await chrome.storage.local.get('profileToken');if(typeof config.profileToken!=='string'||revoking)return {ok:false,code:'POMODORO_ACCESS_REQUIRED'};
 if(timerPending)return {ok:false,code:'POMODORO_BUSY'};
 const p=connectTimer(),id=timerSequence=timerSequence%1000000+1;
 return new Promise(resolve=>{const timeout=setTimeout(()=>{if(timerPending?.id!==id||timerPending.port!==p)return;timerPending=undefined;if(timerPort===p)timerPort=null;p.disconnect();resolve({ok:false,code:'POMODORO_UNAVAILABLE'});},1500);
  timerPending={id,port:p,resolve,timer:timeout};
  try{p.postMessage({schema:'spindle-browser-preview/v1',id,kind:'pomodoro',profileToken:config.profileToken,data});}catch{clearTimeout(timeout);timerPending=undefined;if(timerPort===p)timerPort=null;p.disconnect();resolve({ok:false,code:'POMODORO_UNAVAILABLE'});}
 });
});
const purposeBridge=purposeNativeTransport(async()=>(await chrome.storage.local.get('profileToken')).profileToken,()=>revoking);
installPurposeTransport(purposeBridge.request);
chrome.runtime.onSuspend?.addListener(()=>purposeBridge.retire());
chrome.runtime.onMessage.addListener((message:unknown,_sender,reply)=>{
  if(!message||typeof message!=='object'||!('kind'in message))return;
  if(message.kind==='revoke'){
    if(revocationPending){reply({ok:false});return;}
    revocationPending=true;revoking=true;purposeBridge.retire();enrollmentGeneration++;const activePair=pairing;
    void(async()=>{try{const config=await chrome.storage.local.get('profileToken');const result=activePair?await activePair:{};revocationToken=result.profileToken??config.profileToken??revocationToken;await chrome.storage.local.clear();const ack=typeof revocationToken==='string'?await request({kind:'revoke',profileToken:revocationToken}):{};if(ack.ok===true){revoking=false;revocationToken=undefined;reply({ok:true});}else reply({ok:false});}catch{reply({ok:false});}finally{revocationPending=false;}})();return true;
  }
  if(message.kind==='pair'&&'code'in message&&typeof message.code==='string'){
    if(pairing||revoking){reply({ok:false});return;}
    const generation=enrollmentGeneration;pairing=request({kind:'pair',code:message.code});
    void pairing.then(async value=>{if(generation!==enrollmentGeneration||revoking){reply({ok:false});return;}if(typeof value.profileToken==='string')await chrome.storage.local.set({profileToken:value.profileToken});reply(pairingReply(value));}).finally(()=>{pairing=null;});return true;
  }
});
chrome.storage.onChanged.addListener((changes,area)=>{
  // Capture reads local configuration, never session grants. Exclude only the
  // blocking-owned local keys; unknown/mixed capture changes still fence work.
  if(area==='local'&&'profileToken'in changes)purposeBridge.retire();
  if(area==='session')return;
  if(area==='local'&&Object.keys(changes).every(key=>key==='sitePolicy'||key==='sitePolicyRevision'))return;
  enrollmentGeneration++;
});
async function observe(manual?:chrome.tabs.Tab){if(busy||revoking){if(manual)await chrome.action.setBadgeText({tabId:manual.id,text:'WAIT'});return;}busy=true;let captured=false;const generation=enrollmentGeneration,focus=focusGeneration;try{
  const config=await chrome.storage.local.get(['profileToken','origins']);if(typeof config.profileToken!=='string'||!Array.isArray(config.origins)||!config.origins.length)return;
  const win=await chrome.windows.getLastFocused({populate:true,windowTypes:['normal']});if(win.focused!==true||win.incognito!==false)return;
  const tab=win.tabs?.find(t=>t.active);if(!tab||tab.incognito!==false||!tab.id||!tab.url||win.id===undefined)return;
  if(manual&&manual.id!==tab.id)return;
  const nav=navigation.get(tab.id)??0;
  const url=new URL(tab.url);if(!['http:','https:'].includes(url.protocol)||!config.origins.includes(url.origin))return;
  if(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&!url.pathname.startsWith('/sample/'))return;
  const permitted=()=>chrome.permissions.contains({origins:[url.origin+'/*']});
  if(!await permitted())return;
  const challenge=await request({kind:'challenge',profileToken:config.profileToken});if(!challenge.challenge||manual&&challenge.rich!==true)return;
  if(generation!==enrollmentGeneration||focus!==focusGeneration)return;
  // Start the optional pixel fence BEFORE extracting text, not after the
  // asynchronous context acknowledgement. Unsupported pixels never gate Basic.
  const screenshotPermitted=async()=>Boolean(manual)||(await chrome.storage.local.get('automaticRich')).automaticRich===true&&await chrome.permissions.contains({origins:['<all_urls>']});
  const baseline=challenge.rich===true&&await screenshotPermitted()?await chrome.scripting.executeScript({target:{tabId:tab.id},func:pixelDocument,args:[Boolean(manual)]}):[];
  const proof=baseline[0]?.result;
  const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:visibleText,args:[Boolean(manual)]});const result=results[0];if(!result?.result||!result.documentId)return;
  const fresh=await chrome.tabs.get(tab.id),focused=await chrome.windows.get(win.id);
  if((navigation.get(tab.id)??0)!==nav||!fresh.active||fresh.incognito!==false||fresh.url!==tab.url||focused.focused!==true||focused.incognito!==false)return;
  const identity=await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[result.documentId]},func:(action:boolean)=>(action||document.hasFocus())&&document.visibilityState==='visible',args:[Boolean(manual)]});
  if(identity[0]?.result!==true)return;
  const currentConfig=await chrome.storage.local.get(['profileToken','origins']);
  if(generation!==enrollmentGeneration||focus!==focusGeneration||currentConfig.profileToken!==config.profileToken||!Array.isArray(currentConfig.origins)||!currentConfig.origins.includes(url.origin)||!await permitted())return;
  const browserDocument=result.documentId+':'+nav;
  const resource=url.origin+(url.pathname==='/'?'':url.pathname);
  const ack=await request({kind:'context',profileToken:config.profileToken,data:{challenge:challenge.challenge,private:false,focused:true,document:browserDocument,url:resource,title:(fresh.title??'').slice(0,256),text:result.result.text}});
  if(ack.ok!==true)return;
  // Screenshot capability never enrolls origins for collection.
  if(!proof||baseline[0]?.documentId!==result.documentId||!await screenshotPermitted())return;
  const admit=await request({kind:'challenge',profileToken:config.profileToken});
  if(admit.rich!==true||!admit.challenge||generation!==enrollmentGeneration||focus!==focusGeneration)return;
  const before=await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[result.documentId]},func:pixelDocument,args:[Boolean(manual)]});
  if(!before[0]?.result||before[0].result.revision!==proof.revision||before[0].result.width!==proof.width||before[0].result.height!==proof.height)return;
  const still=await chrome.tabs.get(tab.id),window=await chrome.windows.get(win.id);
  if(!still.active||still.url!==tab.url||still.incognito!==false||window.focused!==true||window.incognito!==false||(navigation.get(tab.id)??0)!==nav||generation!==enrollmentGeneration||focus!==focusGeneration)return;
  if(!await screenshotPermitted()||generation!==enrollmentGeneration||focus!==focusGeneration)return;
  const image=await chrome.tabs.captureVisibleTab(win.id,{format:'png'});
  if(!image.startsWith('data:image/png;base64,')||image.length>2_800_022)throw new Error('IMAGE_BOUND');
  const after=await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[result.documentId]},func:pixelDocument,args:[Boolean(manual)]});
  const finalTab=await chrome.tabs.get(tab.id),finalWindow=await chrome.windows.get(win.id);
  const finalConfig=await chrome.storage.local.get(['profileToken','origins']);
  if(!after[0]?.result||after[0].result.revision!==proof.revision||after[0].result.width!==proof.width||after[0].result.height!==proof.height||!finalTab.active||finalTab.url!==tab.url||finalTab.incognito!==false||finalWindow.focused!==true||finalWindow.incognito!==false||(navigation.get(tab.id)??0)!==nav||generation!==enrollmentGeneration||focus!==focusGeneration||finalConfig.profileToken!==config.profileToken||!Array.isArray(finalConfig.origins)||!finalConfig.origins.includes(url.origin)||!await permitted()||!await screenshotPermitted())return;
  const finalAdmission=await request({kind:'challenge',profileToken:config.profileToken});
  if(finalAdmission.rich!==true||JSON.stringify(finalAdmission.challenge)!==JSON.stringify(admit.challenge)||generation!==enrollmentGeneration||focus!==focusGeneration||(navigation.get(tab.id)??0)!==nav)return;
  // The admission reply is itself asynchronous. Re-probe the exact document
  // after it; no more awaited metadata work may sit between this check and send.
  const last=await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[result.documentId]},func:pixelDocument,args:[Boolean(manual)]});
  if(!last[0]?.result||last[0].result.revision!==proof.revision||last[0].result.width!==proof.width||last[0].result.height!==proof.height||generation!==enrollmentGeneration||focus!==focusGeneration||(navigation.get(tab.id)??0)!==nav)return;
  const saved=await request({kind:'image',profileToken:config.profileToken,data:{challenge:admit.challenge,private:false,focused:true,gesture:Boolean(manual),automatic:!manual,document:browserDocument,url:resource,image:image.slice(22)}});
  captured=saved.ok===true;
}catch{/* Unknown permission/profile/document/host state is denial, never native fallback. */}finally{busy=false;if(manual)await chrome.action.setBadgeText({tabId:manual.id,text:captured?'OK':'NO'}).catch(()=>{});}}
chrome.action.onClicked.addListener(tab=>void observe(tab));
chrome.permissions.onRemoved.addListener(()=>{enrollmentGeneration++;});
chrome.tabs.onActivated.addListener(()=>{focusGeneration++;void observe();});chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url){navigation.set(id,(navigation.get(id)??0)+1);if(navigation.size>100)navigation.delete(navigation.keys().next().value??id);}if(change.status==='complete'||change.url)void observe();});chrome.windows.onFocusChanged.addListener(()=>{focusGeneration++;void observe();});
setInterval(()=>void observe(),1000);
