import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentStore } from '../../storage/agent-store.js';
import { LinuxCredentialStore } from './credentials.js';
import { GoogleOAuth, type CredentialStore } from './oauth.js';
import { GmailSync } from './gmail.js';
import { GoogleWakeJournal } from './wake-journal.js';
import { GmailWatch } from './watch.js';
import { GoogleService, validateGoogleServiceConfig, type GoogleServiceConfig } from './service.js';

export interface GoogleApplicationConfig extends GoogleServiceConfig {
 /** Standalone Desktop client only; omit when injecting the backend-owned OAuth. */
 clientId?:string; dataDirectory:string;
 /** Omit to embed handle() in an already approved receiver. Explicit numeric bind only. */
 listen?:{host?:string;port:number};
}
/** Trusted application assembly; dependency injection is for finite tests, not model input. */
export async function startGoogleApplication(config:GoogleApplicationConfig,dependencies:{oauth?:GoogleOAuth;credentials?:CredentialStore;http?:typeof fetch;tasks?:AgentStore}={}) {
 validateGoogleServiceConfig(config);
 if((!dependencies.oauth&&(typeof config.clientId!=='string'||!config.clientId.trim()||config.clientId.length>2048))||typeof config.dataDirectory!=='string'||!config.dataDirectory.trim()||config.dataDirectory.length>4096||config.dataDirectory.includes('\0'))throw Error('Client and data directory required');
 if(config.listen!==undefined&&(!config.listen||typeof config.listen!=='object'))throw Error('Invalid explicit receiver address');
 config={...config,route:{...config.route}};
 const listen=config.listen&&{...config.listen};
 if(listen&&((listen.host!==undefined&&typeof listen.host!=='string')||!isIP(listen.host??'127.0.0.1')||!Number.isInteger(listen.port)||listen.port<0||listen.port>65535))throw Error('Invalid explicit receiver address');
 const directory=resolve(config.dataDirectory);mkdirSync(directory,{recursive:true,mode:0o700});
 const http=dependencies.http??fetch;
 const oauth=dependencies.oauth??new GoogleOAuth(config.clientId!,dependencies.credentials??new LinuxCredentialStore(),http);
 const tasks=dependencies.tasks??new AgentStore(join(directory,'tasks.sqlite'));
 const closeTasks=()=>{if(!dependencies.tasks)tasks.close();};
 let journal:GoogleWakeJournal|undefined,sync:GmailSync|undefined;
 try {
 journal=new GoogleWakeJournal(join(directory,'wakes.sqlite'));sync=new GmailSync(join(directory,'gmail.sqlite'),tasks,http);
 const service=new GoogleService(config,oauth,sync,journal,new GmailWatch(journal,http),http);
 const controller=new AbortController();let stopped=false;let stopping:Promise<void>|undefined;let stoppedStatus:ReturnType<GoogleService['status']>|undefined;
 const handle=(request:Request,receiptAt=Date.now())=>{
  const url=new URL(request.url);
  if(stopped)return Promise.resolve(new Response(null,{status:503}));
  if(url.pathname!==`/google/push/${encodeURIComponent(config.route.route)}`)return Promise.resolve(new Response(null,{status:404}));
  if(request.method!=='POST')return Promise.resolve(new Response(null,{status:405}));
  return service.handle(config.route.route,request,receiptAt);
 };
 // Bound ingress BEFORE allocating body buffers; intake's own limit starts later.
 const requests=new Set<AbortController>();
 const server=listen?createServer({maxHeaderSize:24576,headersTimeout:10000,requestTimeout:10000,connectionsCheckingInterval:1000},async(req,res)=>{
  const receiptAt=Date.now();
  const reject=(status:number)=>{res.shouldKeepAlive=false;res.writeHead(status,{'connection':'close'});res.end();};
  if(stopped){reject(503);return;}
  if(req.url!==`/google/push/${encodeURIComponent(config.route.route)}`){reject(404);return;}
  if(req.method!=='POST'){reject(405);return;}
  if(config.mode!=='push'){reject(503);return;}
  const auth=req.headers.authorization??'';
  if(auth.length>16384||!/^Bearer [A-Za-z0-9_.-]+$/.test(auth)){reject(401);return;}
  if(requests.size>=8){reject(503);return;}
  if(req.headers['content-length']!==undefined&&(!/^\d+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>65536)){reject(413);return;}
  const active=new AbortController();requests.add(active);
  const abort=()=>active.abort();
  const disconnected=()=>{if(!res.writableFinished)abort();};
  const cancelBody=()=>{if(!req.complete)req.destroy();};
  req.once('aborted',abort);res.once('close',disconnected);controller.signal.addEventListener('abort',abort,{once:true});active.signal.addEventListener('abort',cancelBody,{once:true});
  const timeout=setTimeout(()=>{abort();res.destroy();},10000);
  let bytes=0;const chunks:Buffer[]=[];
  try {
   for await(const chunk of req){active.signal.throwIfAborted();const b=Buffer.from(chunk);bytes+=b.length;if(bytes>65536){reject(413);return;}chunks.push(b);}
   active.signal.throwIfAborted();
   const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
   const response=await handle(new Request('http://receiver.invalid'+req.url,{method:'POST',headers,signal:active.signal,body:Buffer.concat(chunks,bytes)}),receiptAt);
   active.signal.throwIfAborted();res.writeHead(response.status);res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.destroyed){if(!res.headersSent)res.writeHead(400);res.end();}}finally{
   clearTimeout(timeout);req.removeListener('aborted',abort);res.removeListener('close',disconnected);controller.signal.removeEventListener('abort',abort);active.signal.removeEventListener('abort',cancelBody);requests.delete(active);
  }
 }):undefined;
 if(server){server.maxConnections=16;server.maxRequestsPerSocket=16;server.keepAliveTimeout=1000;server.setTimeout(10000,socket=>socket.destroy());}
 const stop=()=>stopping??=(async()=>{stopped=true;controller.abort();const closed=server?.listening?new Promise<void>((done,error)=>server.close(e=>e?error(e):done())):Promise.resolve();server?.closeAllConnections();await service.stop();try{stoppedStatus=service.status();await closed;}finally{try{sync!.close();}finally{try{journal!.close();}finally{closeTasks();}}}})();
 try {
  if(server)await new Promise<void>((done,error)=>{server.once('error',error);server.listen(listen!.port,listen!.host??'127.0.0.1',()=>{server.removeListener('error',error);done();});});
  service.start();
 }catch(error){await stop();throw error;}
 return {handle,stop,status:()=>stoppedStatus??service.status(),address:server?.address()};
 }catch(error){try{sync?.close();}catch{}try{journal?.close();}catch{}try{closeTasks();}catch{}throw error;}
}

/** Explicit operator-selected, trusted application code, never a model-supplied path. */
async function main(){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--application-module')throw Error('Usage: main.js --application-module /absolute/trusted-application.mjs');
 if(!args[1].startsWith('/'))throw Error('Application module must be absolute');
 const module=await import(pathToFileURL(args[1]).href);
 if(typeof module.googleApplicationConfig!=='function')throw Error('Expected trusted googleApplicationConfig()');
 const app=await startGoogleApplication(await module.googleApplicationConfig(),module.googleApplicationDependencies);
 const stop=()=>{void app.stop().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)void main().catch(error=>{console.error(error);process.exitCode=1;});
