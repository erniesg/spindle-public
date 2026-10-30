import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PreviewSettingsStore} from '../../core/preview/settings.js';
import {reopenTracking,validateTrackingSetup} from '../../core/preview/tracking-setup.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {startTrackingServer} from '../../core/tracking/server.js';
test('protected setup reopens the same registered device without signin/enrollment and refuses other-account queue adoption',async()=>{
 await mkdir('.local',{recursive:true});const dir=await mkdtemp(resolve('.local/setup-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32));
 try{
  const setup={origin:server.origin,name:'invented-setup',deviceName:'Invented Windows'},path=join(dir,'account');
  const client=new TrackingClient(setup.origin,path,key);await client.signin(setup.name,'invented-password-123',setup.deviceName,true);
  const id=(await client.inspect()).deviceId,settings=new PreviewSettingsStore(join(dir,'settings'));
  await settings.write({schema:'spindle-preview-settings/v1',profileToken:'a'.repeat(64),preferences:null,tracking:setup,timerOrigin:server.origin},key);
  const saved=await new PreviewSettingsStore(join(dir,'settings')).read(key);assert.deepEqual(saved.tracking,setup);assert.equal(saved.timerOrigin,server.origin);
  const reopened=await reopenTracking(saved.tracking!,path,key);assert.equal((await reopened.inspect()).deviceId,id);await reopened.sync();
  await reopened.signin(setup.name,'invented-password-123','Accidental reconnect rename');assert.equal((await reopened.inspect()).deviceId,id);assert.equal((await reopened.inspect()).deviceName,setup.deviceName);
  assert.equal((await reopened.devices()).devices instanceof Array,true);assert.equal(((await reopened.devices()).devices as unknown[]).length,1);
  await assert.rejects(reopened.signin('different-account','invented-password-456','Other'),/ACCOUNT_SWITCH_REQUIRES_NEW_STORE/);
  await assert.rejects(reopenTracking({...setup,name:'different-account'},path,key),/ACCOUNT_SIGNIN_REQUIRED/);
  await assert.rejects(reopenTracking({...setup,origin:'https://other.example'},path,key),/CLIENT_IDENTITY_MISMATCH/);
  assert.equal((await reopened.inspect()).account,setup.name);
  const encrypted=await readFile(join(path,'tracking.enc'));assert.equal(encrypted.includes(Buffer.from('invented-password-123')),false);assert.equal(encrypted.includes(Buffer.from(setup.name)),false);
  for(const origin of ['http://example.com','https://user:password@example.com','https://example.com/path','https://example.com?token=secret'])assert.throws(()=>validateTrackingSetup({...setup,origin}),/TLS_REQUIRED/);
  assert.throws(()=>validateTrackingSetup({...setup,password:'do-not-save'}),/SETTINGS_INVALID/);
  await settings.write({...saved,timerOrigin:'http://example.com'},key);await assert.rejects(settings.read(key),/TLS_REQUIRED/);
 }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
