import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, lstat, chmod, readFile, open, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from '../storage.js';
// One runtime owns a directory. Encrypted files are fsync'd before rename;
// directory durability barriers apply where the platform supports them.
// Encryption key is injected by a trusted key provider; never stored alongside data.
export class EncryptedStore<T> {
  private tail:Promise<unknown>=Promise.resolve(); private pending=0; private observers=new Set<(state:never)=>void>();
  constructor(readonly directory:string,private key:Buffer,private initial:()=>T){if(key.length!==32)throw Error('KEY_UNAVAILABLE');}
  private async prepare(){await mkdir(this.directory,{recursive:true,mode:0o700});const s=await lstat(this.directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('STORE_PATH_DENIED');await chmod(this.directory,0o700);}
  private async load():Promise<T>{
    await this.prepare();
    // A sole runtime owns this directory; serialized transactions cannot have
    // an active staging write here. Recover only our interrupted encrypted files.
    for(const name of await readdir(this.directory))if(/^\.tracking-[a-f0-9]{16}\.tmp$/.test(name))await rm(join(this.directory,name),{force:true});
    let bytes:Buffer;
    try{const path=join(this.directory,'tracking.enc');const info=await lstat(path);if(info.isSymbolicLink())throw Error('STORE_PATH_DENIED');if(info.size>32_000_032)throw Error('STORE_BOUND');bytes=await readFile(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return this.initial();throw e;}
    if(bytes.length<32||bytes.length>32_000_032||bytes.toString('ascii',0,4)!=='STK1')throw Error('STORE_UNREADABLE');
    const d=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(4,16));d.setAAD(Buffer.from('STK1'));d.setAuthTag(bytes.subarray(16,32));
    return JSON.parse(Buffer.concat([d.update(bytes.subarray(32)),d.final()]).toString()) as T;
  }
  private async save(value:T){
    const plain=Buffer.from(JSON.stringify(value));if(plain.length>32_000_000)throw Error('STORE_FULL');
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from('STK1'));
    const encrypted=Buffer.concat([c.update(plain),c.final()]);plain.fill(0);
    const path=join(this.directory,`.tracking-${randomBytes(8).toString('hex')}.tmp`);
    try{const f=await open(path,'wx',0o600);try{await f.writeFile(Buffer.concat([Buffer.from('STK1'),iv,c.getAuthTag(),encrypted]));await f.sync();}finally{await f.close();}await rename(path,join(this.directory,'tracking.enc'));await syncDirectory(this.directory);}finally{await rm(path,{force:true});}
  }
  transaction<R>(fn:(state:T)=>R|Promise<R>,write=true):Promise<R>{
    if(this.pending>=8)return Promise.reject(Error('STORE_BUSY'));this.pending++;
    const task=this.tail.catch(()=>{}).then(async()=>{const state=await this.load();const result=await fn(state);if(write){await this.save(state);this.notify(state);}return result;}).finally(()=>{this.pending--;});this.tail=task;return task;
  }
  /** Synchronous observer of each durably committed write. Callbacks must be pure checks:
   * no store/OAuth re-entry, no I/O. A throwing observer never fails the committed write. */
  observe(observer:(state:Readonly<T>)=>void):()=>void{const entry=observer as (state:never)=>void;this.observers.add(entry);return ()=>{this.observers.delete(entry);};}
  private notify(state:T){for(const observer of [...this.observers]){try{(observer as (state:Readonly<T>)=>void)(state);}catch{/* Observer faults stay local to the observer. */}}}
  async settle(){await this.tail.catch(()=>{});}
}
