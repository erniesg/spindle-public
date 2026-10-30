import {object,validCommand} from '../../core/pomodoro/protocol.js';
/** Tracker calls this once from its worker. A dedicated timer slot never occupies capture/revoke/purpose capacity. */
export function installPomodoroDispatch(send:(request:unknown)=>Promise<{ok:boolean;value?:unknown;code?:string}>){
 let pending=false;
 chrome.runtime.onMessage.addListener((message:unknown,sender,reply)=>{
  if(!object(message)||message.kind!=='pomodoro')return;
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('pomodoro/pomodoro.html')||Object.keys(message).sort().join(',')!=='kind,request'||!validRequest(message.request)||pending){reply({ok:false});return;}
  pending=true;
  void send(message.request).then(reply,()=>reply({ok:false})).finally(()=>{pending=false;});return true;
 });
}
function validRequest(value:unknown){
 if(!object(value))return false;
 if(value.action==='session')return Object.keys(value).join(',')==='action';
 if(typeof value.binding!=='string'||!/^[a-f0-9-]{36}$/.test(value.binding))return false;
 if(value.action==='command')return Object.keys(value).sort().join(',')==='action,binding,command'&&validCommand(value.command);
 return Object.keys(value).sort().join(',')==='action,binding'&&['read','signout'].includes(value.action as string);
}
