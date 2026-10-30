import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {TrackingClient} from '../tracking/client.js';
// Serializes the entire preview store lifecycle, not just published clients.
// Fencing is synchronous: no admission can join a drain already in progress.
export class PreviewStoreOwner {
 private tail:Promise<unknown>=Promise.resolve();private generation=0;private ready=false;private terminal=false;
 private queue<T>(operation:()=>Promise<T>){const task=this.tail.catch(()=>{}).then(operation);this.tail=task;return task;}
 run<T>(operation:(check:()=>void)=>Promise<T>):Promise<T>{
  if(!this.ready||this.terminal)return Promise.reject(Error('SETTINGS_KEY_REQUIRED'));
  const generation=this.generation,check=()=>{if(this.terminal||generation!==this.generation)throw Error('STORE_OPERATION_CANCELLED');};
  return this.queue(async()=>{check();return operation(check);});
 }
 recover(operation:(current:()=>boolean)=>Promise<boolean>){
  this.ready=false;const generation=++this.generation;
  const current=()=>!this.terminal&&generation===this.generation;
  return this.queue(async()=>{const ready=await operation(current);if(current())this.ready=ready;});
 }
 close(operation:()=>Promise<void>){this.terminal=true;this.ready=false;++this.generation;return this.queue(operation);}
}
export type TrackingSetup={origin:string;name:string;deviceName:string;workosAccountId?:string};
const workosId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Existing direct accounts retain their exact path; verified WorkOS identities
 * select a separate encrypted store without migrating or adopting another queue. */
export function trackingStoreDirectory(accountDirectory:string,origin:string,workosAccountId?:string){
 validateServiceOrigin(origin);
 if(workosAccountId===undefined)return accountDirectory;
 if(typeof workosAccountId!=='string'||!workosId.test(workosAccountId))throw Error('SETTINGS_INVALID');
 return join(accountDirectory,'workos-'+createHash('sha256').update(JSON.stringify([origin,workosAccountId])).digest('hex'));
}
// Settings contain only connection hints. Credentials/queue/device secret stay in
// the existing encrypted client store under the OS-protected preview key.
export function validateServiceOrigin(origin:string){
 const u=new URL(origin);if(u.origin!==origin||u.username||u.password||!(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)))throw Error('TLS_REQUIRED');
}
export function validateTrackingSetup(value:unknown):asserts value is TrackingSetup{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('SETTINGS_INVALID');
 const fields=Object.keys(value).sort().join(',');
 if(fields!=='deviceName,name,origin'&&fields!=='deviceName,name,origin,workosAccountId')throw Error('SETTINGS_INVALID');
 const s=value as TrackingSetup;
 if(typeof s.origin!=='string'||typeof s.name!=='string'||!/^[a-z0-9._-]{3,64}$/.test(s.name)||typeof s.deviceName!=='string'||s.deviceName.length<1||s.deviceName.length>80)throw Error('SETTINGS_INVALID');
 validateServiceOrigin(s.origin);
 if('workosAccountId'in s&&(typeof s.workosAccountId!=='string'||!workosId.test(s.workosAccountId)))throw Error('SETTINGS_INVALID');
}
export async function reopenTracking(setup:TrackingSetup,directory:string,key:Buffer){
 validateTrackingSetup(setup);
 const client=new TrackingClient(setup.origin,trackingStoreDirectory(directory,setup.origin,setup.workosAccountId),key),state=await client.inspect();
 // Never manufacture a new device during launch, or adopt a different account.
 if(state.account!==setup.name||!state.deviceId||setup.workosAccountId!==undefined&&(state.accountId!==setup.workosAccountId||state.deviceName!==setup.deviceName))throw Error('ACCOUNT_SIGNIN_REQUIRED');
 return client;
}
