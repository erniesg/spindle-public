import { createHash } from 'node:crypto';
import { Vault } from './vault.js';
import {validateWorkOSSessionCredentials,type WorkOSSessionCredentials} from '../account/client.js';
import {validateServiceOrigin,validateTrackingSetup,type TrackingSetup} from './tracking-setup.js';
export type CapturePreferences={apps:string[];pixels:boolean;rich:boolean;retain:boolean};
// Encrypted cleanup authority only. Owned timer leases never restore a login,
// provider refresh token, extension grant, recording or upload permission.
export type WorkOSCleanupLease={origin:string;clientId:string;role:'tracking'|'timer';session:WorkOSSessionCredentials;owned?:true};
export function validateWorkOSCleanupLeases(value:unknown):asserts value is WorkOSCleanupLease[]{
 if(!Array.isArray(value)||value.length>8)throw Error('SETTINGS_INVALID');const unique=new Set<string>();
 for(const lease of value){
  if(!lease||typeof lease!=='object'||Array.isArray(lease)||Object.keys(lease).sort().join(',')!==(lease.owned===undefined?'clientId,origin,role,session':'clientId,origin,owned,role,session')||typeof lease.origin!=='string'||lease.origin.length>2048||typeof lease.clientId!=='string'||!/^client_[A-Za-z0-9]{1,200}$/.test(lease.clientId)||!['tracking','timer'].includes(lease.role)||lease.owned!==undefined&&(lease.owned!==true||lease.role!=='timer'))throw Error('SETTINGS_INVALID');
  validateServiceOrigin(lease.origin);validateWorkOSSessionCredentials(lease.session);const id=lease.origin+'|'+lease.session.cookie;if(unique.has(id))throw Error('SETTINGS_INVALID');unique.add(id);
 }
}
export type PreviewSettings={schema:'spindle-preview-settings/v1';profileToken:string|null;preferences:CapturePreferences|null;tracking?:TrackingSetup;timerOrigin?:string;workosCleanup?:WorkOSCleanupLease[];revocation?:{tokenHash:string;pending:boolean}};
const lifetime=10*365*24*3600*1000;
export class PreviewSettingsStore {
  private vault:Vault;
  constructor(directory:string){this.vault=new Vault(directory,Date.now,lifetime,'preserve');}
  async read(key:Buffer):Promise<PreviewSettings>{
    const value=await this.vault.read(key);
    if(value===null)return {schema:'spindle-preview-settings/v1',profileToken:null,preferences:null};
    if(typeof value!=='object'||!value||!('schema'in value)||value.schema!=='spindle-preview-settings/v1'||!('profileToken'in value)||!('preferences'in value))throw new Error('SETTINGS_INVALID');
    const {profileToken,preferences}=value;
    if(profileToken!==null&&(typeof profileToken!=='string'||!/^[a-f0-9]{64}$/.test(profileToken)))throw new Error('SETTINGS_INVALID');
    if(preferences!==null){
      if(typeof preferences!=='object'||!('apps'in preferences)||!Array.isArray(preferences.apps)||preferences.apps.length>8||!preferences.apps.every(x=>typeof x==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(x)))throw new Error('SETTINGS_INVALID');
      for(const field of ['pixels','rich','retain'])if(!(field in preferences)||typeof (preferences as Record<string,unknown>)[field]!=='boolean')throw new Error('SETTINGS_INVALID');
    }
    if('revocation'in value){const r=value.revocation;if(!r||typeof r!=='object'||!('tokenHash'in r)||typeof r.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(r.tokenHash)||!('pending'in r)||typeof r.pending!=='boolean'||r.pending&&profileToken!==null)throw new Error('SETTINGS_INVALID');}
    if('workosCleanup'in value)validateWorkOSCleanupLeases(value.workosCleanup);
    if('tracking'in value)validateTrackingSetup(value.tracking);
    if('timerOrigin'in value){if(typeof value.timerOrigin!=='string')throw Error('SETTINGS_INVALID');validateServiceOrigin(value.timerOrigin);}
    return value as PreviewSettings;
  }
  write(value:PreviewSettings,key:Buffer){if(value.workosCleanup!==undefined)validateWorkOSCleanupLeases(value.workosCleanup);return this.vault.write(value,key,lifetime,()=>true);}
  async beginBrowserRevocation(key:Buffer,token:string){
    if(!/^[a-f0-9]{64}$/.test(token))throw Error('PROFILE_DENIED');
    const saved=await this.read(key),tokenHash=createHash('sha256').update(token).digest('hex');
    if(saved.revocation?.tokenHash===tokenHash)return saved; // retry, never revoke a later enrollment
    if(saved.profileToken!==token)throw Error('PROFILE_DENIED');
    saved.profileToken=null;saved.revocation={tokenHash,pending:true};
    await this.write(saved,key);return saved;
  }
  async finishBrowserRevocation(key:Buffer,erase:()=>Promise<void>,tokenHash?:string){
    const saved=await this.read(key);
    if(tokenHash!==undefined&&saved.revocation?.tokenHash!==tokenHash)throw Error('REVOCATION_RECEIPT_REQUIRED_RETRY');
    if(!saved.revocation?.pending)return saved;
    // Keep a durable disabled/pending receipt until all local deletion intent is
    // durable. A failed erase must not turn token rotation into a false success.
    await erase();saved.revocation.pending=false;await this.write(saved,key);return saved;
  }
  settle(){return this.vault.settle();}
}
