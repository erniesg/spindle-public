import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {LinuxCredentialStore} from '../../core/connectors/google/credentials.js';

test('Linux backend lock makes competing instance CAS atomic and orders deletion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spindle-lock-test-'));let saved:string|undefined='invented-old';
 // Only Secret Service IO is simulated; exclusion is the real filesystem implementation.
 class FakeSecretService extends LinuxCredentialStore {
  protected override async run(args:string[],input?:string){
   await new Promise(r=>setTimeout(r,10));
   if(args[0]==='lookup')return saved??'';
   if(args[0]==='store')saved=input;
   if(args[0]==='clear')saved=undefined;
   return '';
  }
 }
 try {
  const a=new FakeSecretService(root),b=new FakeSecretService(root);
  const results=await Promise.all([a.compareAndSet('demo','invented-old','invented-a'),b.compareAndSet('demo','invented-old','invented-b')]);
  assert.equal(results.filter(Boolean).length,1);
  const beforeDelete=saved;await b.delete('demo');
  // Once deleted, the stale pre-deletion snapshot cannot restore a credential.
  assert.equal(await a.compareAndSet('demo',beforeDelete,'late'),false);assert.equal(saved,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Linux lock rejects a second process within its bounded wait',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spindle-process-lock-test-'));
 const moduleUrl=new URL('../../core/connectors/google/credentials.js',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {LinuxCredentialStore} from ${JSON.stringify(moduleUrl)}; class Held extends LinuxCredentialStore {async run(){console.log('held');await new Promise(r=>setTimeout(r,3000));return '';}} await new Held(${JSON.stringify(root)}).set('demo','invented');`],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');
 try {
  await once(child.stdout,'data');
  const store=new LinuxCredentialStore(root),start=Date.now();
  await assert.rejects(store.compareAndSet('demo',undefined,'invented'),/store busy/);
  assert.ok(Date.now()-start<2900);
  const [code]=await exited;assert.equal(code,0);
 }finally{child.kill('SIGKILL');await exited;await rm(root,{recursive:true,force:true});}
});
