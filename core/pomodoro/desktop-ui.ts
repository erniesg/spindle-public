import {mountPomodoro} from './ui.js';
import {TimerSessionChanged,type Identity,type AuthenticatedSnapshot,type TimerTransport} from './client.js';
import {object,type Command} from './protocol.js';
export function mountDesktopPomodoro(root:HTMLElement,request:(path:string,data:unknown)=>Promise<unknown>,origin:()=>string,onIdentity?:(enabled:boolean)=>void){
 let binding='';
 const call=async(path:string,data:unknown={})=>{
  const value=await request('/pomodoro/'+path,data);
  if(value&&typeof value==='object'&&'code'in value&&['SIGNIN_REQUIRED','ACCOUNT_CHANGED'].includes(String(value.code)))throw new TimerSessionChanged('SIGNIN_REQUIRED');
  if(object(value)&&typeof value.code==='string')throw Error(value.code);
  return value;
 };
 const transport:TimerTransport={
  session:async()=>{const identity=await call('session');if(!object(identity)||typeof identity.binding!=='string')throw new TimerSessionChanged('SESSION_BINDING_REQUIRED');binding=identity.binding;onIdentity?.(identity.extensionEnabled===true);return identity as unknown as Identity;},
  read:async()=>await call('read',{binding}) as AuthenticatedSnapshot,
  command:async(command:Command)=>await call('command',{binding,command}) as AuthenticatedSnapshot,
  signout:async()=>{const previous=binding;binding='';await call('signout',{binding:previous});},
 };
 return {...mountPomodoro(root,transport,async(name,password,register)=>{await call('signin',{origin:origin(),name,password,register});}),setExtensionAccess:async(enabled:boolean)=>await call('access',{binding,enabled})};
}
