// Explicit desktop-control mode: same frontend and real account/Native Messaging
// paths, no collector/helper, fake capture events, OS capture permissions or store.
import {createServer as httpServer} from 'node:http';
import {createServer as ipcServer,type Socket} from 'node:net';
import type {AddressInfo} from 'node:net';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {mkdir,lstat,open,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PomodoroControl} from './pomodoro-control.js';
import {PurposeControl} from '../blocking/control.js';
import type {PurposeClassifier} from '../blocking/classifier.js';
import {optionalPurpose} from './purpose-config.js';
import {pomodoroAsset} from '../pomodoro/assets.js';
import {previewUiAsset} from './ui-assets.js';
import {openInspector} from '../capture-check/app.js';
const here=dirname(fileURLToPath(import.meta.url));
export async function runTimerOnly(directory:string,noOpen=false,options:{purposeClassifier?:PurposeClassifier}={}){
 if(!isAbsolute(directory))throw Error('ABSOLUTE_CONTROL_DIRECTORY_REQUIRED');
 await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw Error('CONTROL_DIRECTORY_DENIED');await chmod(directory,0o700);
 const connection=join(directory,'connection.json');try{await lstat(connection);throw Error('CONTROL_DIRECTORY_IN_USE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const lockPath=join(directory,'timer-only.lock'),lock=await open(lockPath,'wx',0o600);
 const secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');let pair=randomBytes(16).toString('hex'),profile:string|undefined;
 const purpose=new PurposeControl(()=>profile,async signal=>{signal.throwIfAborted();const identity=await timer.route('session',{});signal.throwIfAborted();return identity as {binding:string};},options.purposeClassifier??optionalPurpose());
 const timer=new PomodoroControl(()=>profile,()=>purpose.revokeProfile()),sockets=new Set<Socket>();
 const ipcPath=process.platform==='win32'?`\\\\.\\pipe\\spindle-timer-${randomUUID()}`:join(directory,'ipc.sock');
 let origin='',closed=false,connectionOwned=false,ipcOwned=false,connectionData='';
 const ipc=ipcServer(socket=>{
  sockets.add(socket);const abort=new AbortController();socket.on('close',()=>{sockets.delete(socket);abort.abort();});socket.on('error',()=>{});socket.setTimeout(2500,()=>socket.destroy());let pending='',handled=false;
  socket.on('data',chunk=>{if(handled){socket.destroy();return;}pending+=chunk.toString('utf8');if(Buffer.byteLength(pending)>16384){socket.destroy();return;}const index=pending.indexOf('\n');if(index<0)return;handled=true;
   void(async()=>{try{
    const m=JSON.parse(pending.slice(0,index));if(m.schema!=='spindle-browser-preview/v1'||m.secret!==secret){socket.destroy();return;}
    let result:unknown={ok:false};
    if(m.kind==='pair'&&typeof m.code==='string'&&m.code===pair&&!profile){profile=randomBytes(32).toString('hex');result={ok:true,profileToken:profile};}
    else if(m.kind==='revoke'&&profile&&m.profileToken===profile){timer.revokeProfile();purpose.revokeProfile();profile=undefined;pair=randomBytes(16).toString('hex');result={ok:true};}
    else if(m.kind==='pomodoro')result=await timer.extension(m.data,m.profileToken,abort.signal);
    else if(m.kind==='purpose')result=await purpose.extension(m.data,m.profileToken,abort.signal);
    if(!socket.destroyed)socket.end(JSON.stringify(result)+'\n');
   }catch{socket.destroy();}})();
  });
 });
 const server=httpServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"};
  const reply=(status:number,value:unknown,type='application/json')=>{res.writeHead(status,{...headers,'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(value):value as string|Buffer);};
  try{
   if(!origin||req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin){reply(403,{code:'FORBIDDEN'});return;}
   if(req.method==='GET'&&['/','/ui.js'].includes(req.url??'')){reply(200,await readFile(join(here,req.url==='/'?'index.html':'ui.js')),req.url==='/'?'text/html':'text/javascript');return;}
   if(req.method==='GET'){const asset=await previewUiAsset(req.url??'');if(asset){reply(200,asset.body,asset.type.split(';')[0]);return;}}
   if(req.method==='GET'&&req.url?.startsWith('/pomodoro/')){const asset=await pomodoroAsset(req.url.replace('/pomodoro/','/pomodoro/app/'));if(asset){reply(200,asset.body,asset.type.split(';')[0]);return;}}
   const auth=req.headers.authorization??'',expected=`Bearer ${token}`;
   if(Buffer.byteLength(auth)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(auth),Buffer.from(expected))){reply(401,{code:'UNAUTHORIZED'});return;}
   if(req.method==='GET'&&req.url==='/state'){reply(200,{mode:'timer-only',pair:profile?'enrolled':pair,capture:'unavailable-timer-only',pomodoroAccess:timer.accessEnabled});return;}
   if(req.method!=='POST'){reply(404,{code:'NOT_FOUND'});return;}
   if(req.headers.origin!==origin){reply(403,{code:'ORIGIN_DENIED'});return;}
   if(req.headers['content-type']!=='application/json'){reply(415,{code:'JSON_REQUIRED'});return;}
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw Error('BODY_BOUND');}
   const value:unknown=JSON.parse(raw||'{}');
   if(req.url==='/quit'){reply(200,{ok:true});void close();return;}
   const match=/^\/pomodoro\/(signin|session|read|command|signout|access)$/.exec(req.url??'');
   if(!match){reply(404,{code:'CAPTURE_UNAVAILABLE_TIMER_ONLY'});return;}
   reply(200,await timer.route(match[1]!,value));
  }catch(error){const code=error instanceof Error?error.message:'POMODORO_UNAVAILABLE';reply(code==='SIGNIN_REQUIRED'?401:409,{code:['SIGNIN_REQUIRED','ACCOUNT_CHANGED','PROFILE_REQUIRED','POMODORO_SIGNIN_BUSY'].includes(code)?code:'INVALID_POMODORO_REQUEST'});}
 });server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=16;
 const signals=()=>void close();
 async function close(){if(closed)return;closed=true;purpose.close();process.off('SIGINT',signals);process.off('SIGTERM',signals);for(const socket of sockets)socket.destroy();await timer.close().catch(()=>{});server.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>ipc.close(()=>r()))]);if(connectionOwned){try{if(await readFile(connection,'utf8')===connectionData)await rm(connection,{force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}if(ipcOwned&&process.platform!=='win32')await rm(ipcPath,{force:true});await lock.close();await rm(lockPath,{force:true});}
 try{
  await new Promise<void>((resolve,reject)=>{ipc.once('error',reject);ipc.listen(ipcPath,resolve);});ipcOwned=true;if(process.platform!=='win32')await chmod(ipcPath,0o600);
  connectionData=JSON.stringify({ipcPath,secret});await writeFile(connection,connectionData,{mode:0o600,flag:'wx'});connectionOwned=true;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 }catch(error){await close();throw error;}
 const url=`${origin}/#${token}`;if(!noOpen)openInspector(url);
 process.once('SIGINT',signals);process.once('SIGTERM',signals);
 return {origin,url,close}; // Trusted launcher only; never print/persist the bearer URL.
}
