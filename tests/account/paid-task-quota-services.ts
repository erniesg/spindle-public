// Generic N4 service proof, NOT public delivery: private HTTP authenticates the
// invented account/Google grant; real services receive explicit durable admission.
import {createHash} from 'node:crypto';
import {startTrackingServer} from '../../core/tracking/server.js';
import {EncryptedStore} from '../../core/tracking/store.js';
import {SharedGoogle,type SharedGoogleConfig,type PrivateGoogleConnection} from '../../core/tracking/google.js';
import {paidTaskAdmission,type PaidTaskQuota} from '../../core/account/paid-task-quota.js';
import {PreparationService,type PreparationConfig} from '../../core/preparation/service.js';
import {MailService,type MailServiceConfig} from '../../core/mail/service.js';
import {AccountClient} from '../../core/account/client.js';

type State={accounts:{id:string;google?:PrivateGoogleConnection[];paidTasks?:PaidTaskQuota}[];sessions:Record<string,{account:string;expires:number}>};
export async function quotaServices(directory:string,key:Buffer,googleConfig:SharedGoogleConfig,preparation:PreparationConfig,mail:MailServiceConfig){
 const server=await startTrackingServer(directory,key,0,undefined,googleConfig);
 const store=new EncryptedStore<State>(directory,key,()=>({accounts:[],sessions:{}}));
 const google=new SharedGoogle(store,googleConfig,()=>server.origin),admission=paidTaskAdmission(store);
 const prep=new PreparationService(preparation,(...args)=>google.preparationBinding(...args),admission);
 const mails=new MailService(mail,(...args)=>google.mailBinding(...args),admission);
 let session='';
 const transport:typeof fetch=async(input,init)=>{
  const response=await fetch(input,init),cookie=response.headers.get('set-cookie')?.match(/^spindle_session=([a-f0-9]{64})/);
  if(cookie)session=createHash('sha256').update(cookie[1]!).digest('hex');
  return response;
 };
 const client=new AccountClient(server.origin,transport);
 return {client,transport,origin:server.origin,
  async request(path:string,data:Record<string,unknown>){
   const owner=client.account!.id;
   // Use the actual authenticated session, not a fabricated service owner grant.
   await store.transaction(s=>{if(s.sessions[session]?.account!==owner||s.sessions[session].expires<=Date.now())throw Error('SIGNIN_REQUIRED');},false);
   return path.startsWith('/preparation/')?prep.handle(owner,session,path,data):mails.handle(owner,session,path,data);
  },
  async close(){await prep.close();await mails.close();await google.close();await server.close();await store.settle();}
 };
}
