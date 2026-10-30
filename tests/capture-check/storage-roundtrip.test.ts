import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,open,rm,writeFile,copyFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Vault} from '../../core/preview/vault.js';
import {PreviewSettingsStore} from '../../core/preview/settings.js';
import {EncryptedStore} from '../../core/tracking/store.js';

test('encrypted settings, context deletion and tracking survive reopening on the actual filesystem',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-storage-')),key=randomBytes(32);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const settingsDir=join(dir,'settings'),contextDir=join(dir,'context'),trackingDir=join(dir,'tracking');
 const preferences={apps:['photos'],pixels:true,retain:false,rich:false};
 await new PreviewSettingsStore(settingsDir).write({schema:'spindle-preview-settings/v1',profileToken:null,preferences},key);
 assert.deepEqual((await new PreviewSettingsStore(settingsDir).read(key)).preferences,preferences);
 const vault=new Vault(contextDir);
 await vault.write({invented:'ROUNDTRIP_SENTINEL'},key,900000,()=>true);
 assert.deepEqual(await new Vault(contextDir).read(key),{invented:'ROUNDTRIP_SENTINEL'});
 assert.equal((await readFile(join(contextDir,'context.enc'))).includes(Buffer.from('ROUNDTRIP_SENTINEL')),false);
 await vault.clear();assert.equal(await new Vault(contextDir).read(key),null);
 const initial=()=>({value:''});
 await new EncryptedStore(trackingDir,key,initial).transaction(s=>{s.value='INVENTED_TRACKING';});
 assert.equal(await new EncryptedStore(trackingDir,key,initial).transaction(s=>s.value,false),'INVENTED_TRACKING');
});

test('file flush failures still reject encrypted writes and leave the previous snapshot readable',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-flush-')),key=randomBytes(32);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const vault=new Vault(join(dir,'context'));await vault.write({value:'before'},key,900000,()=>true);
 const probe=await open(join(dir,'probe'),'wx'),prototype=Object.getPrototypeOf(probe),original=prototype.sync;
 await probe.close();
 const sync=mock.method(prototype,'sync',async function(this:Awaited<ReturnType<typeof open>>){
  if((await this.stat()).isFile())throw Object.assign(Error('INVENTED_FILE_FLUSH_FAILURE'),{code:'EPERM'});
  await original.call(this);
 });
 try{await assert.rejects(vault.write({value:'after'},key,900000,()=>true),/INVENTED_FILE_FLUSH_FAILURE/);}
 finally{sync.mock.restore();}
 assert.deepEqual(await new Vault(join(dir,'context')).read(key),{value:'before'});
});

test('tracking reopen removes only its interrupted encrypted staging files',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-tracking-recover-')),key=randomBytes(32);
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const initial=()=>({value:'committed'});
 await new EncryptedStore(dir,key,initial).transaction(()=>{});
 const orphan='.tracking-0123456789abcdef.tmp',unrelated='.tracking-not-owned.tmp';
 await copyFile(join(dir,'tracking.enc'),join(dir,orphan));
 await writeFile(join(dir,unrelated),'unrelated');
 assert.equal(await new EncryptedStore(dir,key,initial).transaction(s=>s.value,false),'committed');
 assert.deepEqual((await readdir(dir)).sort(),[unrelated,'tracking.enc'].sort());
});
