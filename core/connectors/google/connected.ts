import { GoogleOAuth, scopes } from './oauth.js';
import { GmailSync, type GmailPollLifecycle } from './gmail.js';
import { abortRace } from './abort.js';
import { DriveReader } from './drive.js';
import type { AgentStore } from '../../storage/agent-store.js';
/** Production construction seam: account and grants come only from protected OAuth state. */
export async function connectedGoogle(oauth:GoogleOAuth,connectionId:string) {
 const mail=await oauth.connectorAccess(connectionId,scopes.mail);
 return {
  accountId:mail.accountId,
  gmail(path:string,tasks:AgentStore) {
   const sync=new GmailSync(path,tasks);
   return {close:()=>sync.close(),poll:async(workspace:string,relevant:(message:unknown)=>Promise<string|undefined>,options:Pick<GmailPollLifecycle,'signal'|'eligibleDuringReconciliation'>={})=>{
    const current=()=>mail.assertCurrent({signal:options.signal});
    await current();
    const token=options.signal?await abortRace(mail.token({signal:options.signal}),options.signal):await mail.token();
    return sync.poll(mail.accountId,workspace,token,relevant,{...options,connectionEpoch:mail.connectionEpoch,assertCurrent:current});
   }};
  },
  async drive(roots:ReadonlySet<string>) {
   const drive=await oauth.connectorAccess(connectionId,scopes.drive);
   if(drive.accountId!==mail.accountId)throw Error('Reconnect required: account mismatch');
   // Refresh and enforce the grant for every operation, not merely at construction.
   const selectedRoots=new Set(roots);
   const retrieve=async<T>(read:(reader:DriveReader)=>Promise<T>)=>{await drive.assertCurrent();const result=await read(new DriveReader(await drive.token(),drive.accountId,selectedRoots));await drive.assertCurrent();return result;};
   return {list:async(folder:string,page?:string)=>retrieve(reader=>reader.list(folder,page)),read:async(id:string)=>retrieve(reader=>reader.read(id))};
  }
 };
}
