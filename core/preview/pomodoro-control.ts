import type {WorkOSSessionCredentials} from '../account/client.js';
import {DesktopPomodoro} from '../pomodoro/desktop.js';
import {object} from '../pomodoro/protocol.js';
/** Shared by ordinary preview and explicit timer-only mode. No collector authority. */
export class PomodoroControl {
 private desktop=new DesktopPomodoro();private grant:{binding:string;profile:string}|undefined;
 private pending:AbortController|undefined;private epoch=0;private closed=false;
 constructor(private profile:()=>string|undefined,private accountRetired:()=>void=()=>{}){}
 private live(){if(this.closed)throw Error('HOST_CLOSING');}
 get accessEnabled(){return !this.closed&&!!this.grant&&this.grant.profile===this.profile();}
 revokeProfile(){this.grant=undefined;this.epoch++;this.pending?.abort();}
 /** Trusted native host only, deliberately absent from route() and extension(). */
 async signinWorkOSSession(origin:string,session:WorkOSSessionCredentials){
  this.live();this.accountRetired();this.revokeProfile();const identity=await this.desktop.signinWorkOSSession(origin,session);
  try{this.live();return identity;}catch(error){await this.desktop.close();throw error;}
 }
 async route(action:string,value:unknown):Promise<unknown>{
  this.live();
  if(!object(value))throw Error('INVALID_POMODORO_REQUEST');
  if(action==='signin'){this.accountRetired();this.revokeProfile();const identity=await this.desktop.signin(value);this.live();return identity;}
  if(action==='session'){
   if(Object.keys(value).length)throw Error('INVALID_POMODORO_REQUEST');
   const identity=await this.desktop.session();this.live();return {...identity,extensionEnabled:this.grant?.binding===identity.binding&&this.grant.profile===this.profile()};
  }
  if(action==='command'){
   if(Object.keys(value).sort().join(',')!=='binding,command')throw Error('INVALID_POMODORO_REQUEST');
   return this.desktop.command(value.command,value.binding);
  }
  if(action==='access'){
   if(Object.keys(value).sort().join(',')!=='binding,enabled'||typeof value.enabled!=='boolean')throw Error('INVALID_POMODORO_REQUEST');
   const identity=await this.desktop.session();this.live();if(value.binding!==identity.binding)throw Error('ACCOUNT_CHANGED');
   const profile=this.profile();if(value.enabled&&!profile)throw Error('PROFILE_REQUIRED');
   this.revokeProfile();if(value.enabled)this.grant={binding:identity.binding,profile:profile!};return {enabled:!!this.grant};
  }
  if(Object.keys(value).join(',')!=='binding')throw Error('INVALID_POMODORO_REQUEST');
  if(action==='read')return this.desktop.read(value.binding);
  if(action==='signout'){
   const identity=await this.desktop.session();this.live();if(value.binding!==identity.binding)throw Error('ACCOUNT_CHANGED');
   this.accountRetired();this.revokeProfile();return this.desktop.signout(value.binding,AbortSignal.timeout(1500));
  }
  throw Error('INVALID_POMODORO_REQUEST');
 }
 async extension(value:unknown,profile:unknown,signal?:AbortSignal):Promise<Record<string,unknown>>{
  if(this.closed)return {ok:false,code:'SIGNIN_REQUIRED'};
  const grant=this.grant;
  if(typeof profile!=='string'||!grant||profile!==this.profile()||profile!==grant.profile)return {ok:false,code:'POMODORO_ACCESS_REQUIRED'};
  if(this.pending)return {ok:false,code:'POMODORO_BUSY'};
  const controller=new AbortController(),epoch=this.epoch;this.pending=controller;
  const cancel=()=>controller.abort();if(signal?.aborted)cancel();signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,1400);
  try{
   const identity=await this.desktop.session();if(identity.binding!==grant.binding)throw Error('ACCOUNT_CHANGED');
   if(object(value)&&value.action==='signout'&&Object.keys(value).sort().join(',')==='action,binding'&&value.binding===identity.binding)this.accountRetired();
   const result=await this.desktop.extension(value,controller.signal);
   if(controller.signal.aborted||epoch!==this.epoch||this.grant!==grant||this.profile()!==profile)throw Error('POMODORO_RESPONSE_RETIRED');
   if(object(value)&&value.action==='signout'){this.grant=undefined;this.epoch++;}
   return {ok:true,value:result};
  }catch(error){const code=error instanceof Error&&['SIGNIN_REQUIRED','ACCOUNT_CHANGED'].includes(error.message)?error.message:'POMODORO_UNAVAILABLE';return {ok:false,code};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(this.pending===controller)this.pending=undefined;}
 }
 async close(){if(this.closed)return;this.closed=true;this.accountRetired();this.revokeProfile();await this.desktop.close(AbortSignal.timeout(1500));}
}
