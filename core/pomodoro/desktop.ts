import {randomUUID} from 'node:crypto';
import {AccountClient,validateWorkOSSessionCredentials,type WorkOSSessionCredentials} from '../account/client.js';
import {validCommand,object} from './protocol.js';
import type {AuthenticatedSnapshot,Identity} from './client.js';
export interface DesktopIdentity extends Identity {binding:string}
/** Mounted only behind existing desktop bearer/Host/Origin controls. No device enrollment. */
export class DesktopPomodoro {
 private client:AccountClient|undefined;private retiring:AccountClient|undefined;private generation=0;private signingIn=false;private binding='';
 async signin(value:unknown){
  if(this.signingIn)throw Error('POMODORO_SIGNIN_BUSY');
  if(!object(value)||Object.keys(value).some(k=>!['origin','name','password','register'].includes(k))||typeof value.origin!=='string'||typeof value.name!=='string'||typeof value.password!=='string'||value.register!==undefined&&typeof value.register!=='boolean')throw Error('INVALID_POMODORO_SIGNIN');
  this.signingIn=true;const generation=++this.generation;const previous=this.client??this.retiring;this.retiring=previous;this.client=undefined;this.binding='';
  try{await previous?.signout();if(this.retiring===previous)this.retiring=undefined;const client=new AccountClient(value.origin);await client.signin(value.name,value.password,value.register===true);if(generation!==this.generation){await client.signout();throw Error('ACCOUNT_CHANGED');}this.client=client;this.binding=randomUUID();return this.session();}
  finally{this.signingIn=false;}
 }
 /** Trusted native host only; WorkOS credentials never enter extension or browser request dispatch. */
 async signinWorkOSSession(origin:string,session:WorkOSSessionCredentials){
  validateWorkOSSessionCredentials(session);const client=new AccountClient(origin);
  if(this.signingIn)throw Error('POMODORO_SIGNIN_BUSY');
  this.signingIn=true;const generation=++this.generation;const previous=this.client??this.retiring;this.retiring=previous;this.client=undefined;this.binding='';
  try{
   await previous?.signout();if(this.retiring===previous)this.retiring=undefined;await client.signinWorkOSSession(session);
   if(generation!==this.generation){await client.signout();throw Error('ACCOUNT_CHANGED');}
   this.client=client;this.binding=randomUUID();return this.session();
  }catch(error){await client.revokeWorkOSSession(session);throw error;}
  finally{this.signingIn=false;}
 }
 async session():Promise<DesktopIdentity>{const account=this.client?.account;if(!account)throw Error('SIGNIN_REQUIRED');return {...account,binding:this.binding};}
 private bound(binding:unknown){if(!this.client)throw Error('SIGNIN_REQUIRED');if(typeof binding!=='string'||!binding||binding!==this.binding)throw Error('ACCOUNT_CHANGED');return this.client;}
 async read(binding:unknown,signal?:AbortSignal):Promise<AuthenticatedSnapshot>{return await this.bound(binding).request('/pomodoro',undefined,signal) as AuthenticatedSnapshot;}
 async command(value:unknown,binding:unknown,signal?:AbortSignal):Promise<AuthenticatedSnapshot>{const client=this.bound(binding);if(!validCommand(value))throw Error('INVALID_POMODORO_COMMAND');return await client.request('/pomodoro/command',value,signal) as AuthenticatedSnapshot;}
 async signout(binding:unknown,signal?:AbortSignal){this.bound(binding);return this.close(signal);}
 /** Trusted host teardown only. Never expose unbound close through HTTP/Native Messaging. */
 async close(signal?:AbortSignal){++this.generation;const client=this.client??this.retiring;this.retiring=client;this.client=undefined;this.binding='';await client?.signout(signal);if(this.retiring===client)this.retiring=undefined;return {ok:true};}
 /** No arbitrary URL, account ID, signin or recording operation from the extension. */
 async extension(value:unknown,signal?:AbortSignal){
  if(!object(value))throw Error('INVALID_POMODORO_REQUEST');
  if(value.action==='session'&&Object.keys(value).join(',')==='action')return this.session();
  // Validate binding before dispatch, not after a command could mutate another account.
  this.bound(value.binding);
  if(value.action==='command'&&Object.keys(value).sort().join(',')==='action,binding,command')return this.command(value.command,value.binding,signal);
  if(Object.keys(value).sort().join(',')!=='action,binding')throw Error('INVALID_POMODORO_REQUEST');
  if(value.action==='read')return this.read(value.binding,signal);if(value.action==='signout')return this.signout(value.binding,signal);
  throw Error('INVALID_POMODORO_REQUEST');
 }
}
