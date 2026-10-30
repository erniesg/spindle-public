import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,open,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Vault} from '../../core/preview/vault.js';
import {PreviewSettingsStore} from '../../core/preview/settings.js';

test('POSIX settings commit/clear fsync files and directories; failed cleanup cannot complete revocation',{skip:process.platform==='win32'},async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/vault-durable-')),key=randomBytes(32),token=randomBytes(32).toString('hex');
 const probe=await open(join(dir,'probe'),'wx',0o600),prototype=Object.getPrototypeOf(probe),original=prototype.sync;
 const stages:string[]=[];let failDirectory=false;
 const sync=mock.method(prototype,'sync',async function(this:Awaited<ReturnType<typeof open>>){const directory=(await this.stat()).isDirectory();stages.push(directory?'directory':'file');if(directory&&failDirectory)throw Error('INVENTED_DIRECTORY_SYNC_FAILURE');await original.call(this);});
 try{
  await probe.close();const vault=new Vault(join(dir,'context')),settings=new PreviewSettingsStore(join(dir,'settings'));
  await settings.write({schema:'spindle-preview-settings/v1',profileToken:token,preferences:null},key);
  assert.deepEqual(stages,['file','directory'],'acknowledged settings must reach both durability barriers');
  await vault.write({invented:'context'},key,900000,()=>true);await settings.beginBrowserRevocation(key,token);
  failDirectory=true;
  await assert.rejects(settings.finishBrowserRevocation(key,()=>vault.clear()),/INVENTED_DIRECTORY_SYNC_FAILURE/);
  failDirectory=false;assert.equal((await settings.read(key)).revocation?.pending,true);
  stages.length=0;await settings.finishBrowserRevocation(key,()=>vault.clear());
  assert.deepEqual(stages,['directory','file','directory'],'cleanup barrier precedes completed receipt barriers');
  assert.equal((await settings.read(key)).revocation?.pending,false);assert.equal(await vault.read(key),null);
 }finally{sync.mock.restore();await probe.close();await rm(dir,{recursive:true,force:true});}
});
