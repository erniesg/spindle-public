import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseGoogleConnection, type CredentialStore, type GoogleOperation } from './oauth.js';
export interface CredentialExit {code:number|null;stdout:string;stderr:string}
/** Only an empty exit-1 lookup means no record; all other failures deny access. */
export function interpretCredentialExit(result:CredentialExit,allowMissing=false):string {
 if(result.code===0)return result.stdout.trimEnd();
 if(allowMissing&&result.code===1&&result.stdout===''&&result.stderr==='')return '';
 throw Error('Protected credential operation failed');
}
/** No shell, no plaintext fallback. Requires an unlocked Secret Service session. */
export class LinuxCredentialStore implements CredentialStore {
 constructor(private lockDirectory=join(tmpdir(),`spindle-credential-locks-${process.getuid?.()}`)) {}
 /** Filesystem exclusion shared by all application-owned instances/processes.
  * Never steal a stale lock: a crashed owner requires explicit recovery. */
 private async exclusive<T>(id:string,operation:()=>Promise<T>):Promise<T> {
  await mkdir(this.lockDirectory,{mode:0o700}).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='EEXIST')throw e;});
  const root=await lstat(this.lockDirectory);
  if(!root.isDirectory()||root.uid!==process.getuid?.()||(root.mode&0o777)!==0o700)throw Error('Unsafe credential lock directory');
  const lock=join(this.lockDirectory,createHash('sha256').update(id).digest('hex'));
  const deadline=Date.now()+2000;
  for(;;){try{await mkdir(lock,{mode:0o700});break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(Date.now()>=deadline)throw Error('Credential store busy; retry after owner finishes');await delay(20);}}
  try{return await operation();}finally{await rmdir(lock);}
 }
 protected async run(args:string[],input?:string):Promise<string> {
  if(process.platform!=='linux') throw Error('Protected credential store unavailable on this platform');
  return new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/secret-tool',args,{stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS}});
   // Do not release exclusion until the killed helper actually exits.
   const timer=setTimeout(()=>{child.kill('SIGKILL');},5000);
   let output='',stderr='',overflow=false; child.stdout.setEncoding('utf8');child.stdout.on('data',(s:string)=>{output+=s;if(Buffer.byteLength(output)>65536){overflow=true;child.kill('SIGKILL');}});
   child.stderr.setEncoding('utf8');child.stderr.on('data',(s:string)=>{stderr+=s;if(Buffer.byteLength(stderr)>65536){overflow=true;child.kill('SIGKILL');}});child.on('error',()=>reject(Error('Protected credential store unavailable')));
   child.on('close',code=>{clearTimeout(timer);try{if(overflow)throw Error('Protected credential operation failed');resolve(interpretCredentialExit({code,stdout:output,stderr},args[0]==='lookup'));}catch(error){reject(error);}});child.stdin.on('error',()=>{});child.stdin.end(input);
  });
 }
 async get(id:string){return (await this.run(['lookup','application','spindle','connection',id]))||undefined;}
 async set(id:string,value:string){await this.exclusive(id,()=>this.run(['store','--label=Spindle Google connection','application','spindle','connection',id],value));}
 async delete(id:string){await this.exclusive(id,()=>this.run(['clear','application','spindle','connection',id]));}
 /** Delete the captured connection, including ordinary refresh generations, under the same process-shared lock as writes. */
 async deleteConnectionEpoch(id:string,epoch:string,accountId:string):Promise<boolean>{return this.exclusive(id,async()=>{
  const raw=await this.get(id);if(raw===undefined)return false;
  const current=parseGoogleConnection(raw)!;
  if(current.connectionEpoch!==epoch||current.accountId!==accountId)return false;
  await this.run(['clear','application','spindle','connection',id]);return true;
 });}
 async compareAndDelete(id:string,expected:string):Promise<boolean>{return this.exclusive(id,async()=>{
  if(await this.get(id)!==expected)return false;
  await this.run(['clear','application','spindle','connection',id]);return true;
 });}
 async compareAndSet(id:string,expected:string|undefined,value:string,options?:GoogleOperation):Promise<boolean>{return this.exclusive(id,async()=>{
  options?.signal?.throwIfAborted();
  if(await this.get(id)!==expected)return false;
  options?.signal?.throwIfAborted();
  // Dispatch is the commit boundary: an already-running Secret Service write
  // cannot be rolled back safely if cancellation arrives after dispatch.
  await this.run(['store','--label=Spindle Google connection','application','spindle','connection',id],value);return true;
 });}
}
