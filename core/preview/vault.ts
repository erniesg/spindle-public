import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { mkdir,readFile,open,rename,rm,readdir,lstat,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from '../storage.js';
// One encrypted snapshot, bounded work. No plaintext temp/WAL/log fallback.
export class Vault {
  private tail:Promise<unknown>=Promise.resolve(); private pending=0; private generation=0;
  constructor(readonly directory:string,private now=Date.now,private maxTtl=3_600_000,private timeAnomalyPolicy:'erase'|'preserve'='erase'){}
  private async prepare(){await mkdir(this.directory,{recursive:true,mode:0o700});if((await lstat(this.directory)).isSymbolicLink())throw new Error('STORE_PATH_DENIED');await chmod(this.directory,0o700);}
  private async syncDirectory(){await syncDirectory(this.directory);}
  private async removeSnapshot(){await rm(join(this.directory,'context.enc'),{force:true});await this.syncDirectory();}
  read(key:Buffer|null):Promise<unknown>{
    if(!key||key.length!==32)return Promise.reject(new Error('KEY_UNAVAILABLE'));
    const task=this.tail.catch(()=>{}).then(()=>this.readExclusive(key));this.tail=task;return task;
  }
  private async readExclusive(key:Buffer,clock?:number):Promise<unknown>{
    await this.prepare();
    // Only known run-owned encrypted staging files; never traverse/delete unrelated resources.
    for(const n of await readdir(this.directory))if(/^\.preview-[a-f0-9]{16}\.tmp$/.test(n))await rm(join(this.directory,n),{force:true});
    let b:Buffer;try{const path=join(this.directory,'context.enc');if((await lstat(path)).isSymbolicLink())throw new Error();b=await readFile(path);}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT')return null;throw new Error('STORE_UNREADABLE');}
    let expires:number,created:number,now:number;
    try{
      if(b.length<48||b.length>8_000_100||b.toString('ascii',0,4)!=='SPV1')throw new Error();
      expires=b.readDoubleBE(4);created=b.readDoubleBE(12);now=clock??this.now();
    }catch{throw new Error('STORE_UNREADABLE');}
    const outsideWindow=!Number.isFinite(expires)||!Number.isFinite(created)||expires<=now||now<created;
    // Select one policy at one instant. Preserve must never fall through to an
    // erase check, even if the wall clock steps during the filesystem work.
    if(this.timeAnomalyPolicy==='preserve'){
      if(outsideWindow||!Number.isFinite(now))throw new Error('STORE_CLOCK_ANOMALY');
    }else if(outsideWindow){
      try{await this.removeSnapshot();}catch{throw new Error('STORE_UNREADABLE');}return null;
    }
    try{const d=createDecipheriv('aes-256-gcm',key,b.subarray(20,32));d.setAAD(b.subarray(0,20));d.setAuthTag(b.subarray(32,48));return JSON.parse(Buffer.concat([d.update(b.subarray(48)),d.final()]).toString('utf8'));}catch{throw new Error('STORE_UNREADABLE');}
  }
  write(value:unknown,key:Buffer|null,ttl:number,current:()=>boolean):Promise<void>{
    if(!current())return Promise.resolve();
    if(!key||key.length!==32)return Promise.reject(new Error('KEY_UNAVAILABLE'));
    if(!Number.isFinite(ttl)||ttl<1000||ttl>this.maxTtl)return Promise.reject(new Error('RETENTION_BOUND'));
    if(this.pending>=2)return Promise.reject(new Error('STORE_BUSY'));
    const plaintext=Buffer.from(JSON.stringify(value));if(plaintext.length>8_000_000)return Promise.reject(new Error('STORE_BOUND'));
    const generation=this.generation,secret=Buffer.from(key);this.pending++;
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(!current()||generation!==this.generation)return;
      // Validate the retained snapshot under the same serialized writer before
      // replacing it: bad clocks and wrong keys cannot reset durable settings.
      await this.prepare();const created=this.now();
      if(this.timeAnomalyPolicy==='preserve')await this.readExclusive(secret,created);
      const header=Buffer.alloc(20);header.write('SPV1');header.writeDoubleBE(created+ttl,4);header.writeDoubleBE(created,12);
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(header);const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      const temp=join(this.directory,`.preview-${randomBytes(8).toString('hex')}.tmp`);
      try{const file=await open(temp,'wx',0o600);try{await file.writeFile(Buffer.concat([header,nonce,cipher.getAuthTag(),ciphertext]));await file.sync();}finally{await file.close();}if(current()&&generation===this.generation){await rename(temp,join(this.directory,'context.enc'));await this.syncDirectory();}}finally{await rm(temp,{force:true});}
    }).finally(()=>{plaintext.fill(0);secret.fill(0);this.pending--;});this.tail=task;return task;
  }
  async clear(){this.generation++;const task=this.tail.catch(()=>{}).then(async()=>{await this.prepare();await this.removeSnapshot();});this.tail=task;await task;}
  async settle(){await this.tail.catch(()=>{});}
}
