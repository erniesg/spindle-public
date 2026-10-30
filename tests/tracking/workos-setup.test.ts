import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {trackingStoreDirectory,reopenTracking,validateTrackingSetup} from '../../core/preview/tracking-setup.js';
import {TrackingClient} from '../../core/tracking/client.js';
import {CollectorHistory} from '../../core/tracking/collector.js';
import {PreviewSession} from '../../core/preview/session.js';
import {startTrackingServer} from '../../core/tracking/server.js';
const id='12345678-1234-4123-8123-123456789abc',other='aaaaaaaa-1234-4123-8123-123456789abc';
test('tracking store selection keeps exact legacy root and isolates canonical service and verified UUID',()=>{
 const root='/invented/account',origin='https://service.example';
 assert.equal(trackingStoreDirectory(root,origin),root);
 const selected=trackingStoreDirectory(root,origin,id);assert.equal(selected,trackingStoreDirectory(root,origin,id));assert.match(selected,/^\/invented\/account\/workos-[a-f0-9]{64}$/);
 assert.notEqual(selected,trackingStoreDirectory(root,origin,other));assert.notEqual(selected,trackingStoreDirectory(root,'https://other.example',id));
 for(const bad of ['',id.toUpperCase(),'../escape','not-a-uuid'])assert.throws(()=>trackingStoreDirectory(root,origin,bad),/SETTINGS_INVALID/);
 for(const bad of ['https://service.example/','http://service.example','https://user:pass@service.example','https://service.example/path'])assert.throws(()=>trackingStoreDirectory(root,bad,id),/TLS_REQUIRED/);
 const setup={origin,name:'workos.invented',deviceName:'Computer'};
 validateTrackingSetup(setup);validateTrackingSetup({...setup,workosAccountId:id});
 for(const extra of [{workosAccountId:undefined},{workosAccountId:'bad'},{directory:'/escape'},{workosAccountId:id,extra:true}])assert.throws(()=>validateTrackingSetup({...setup,...extra}),/SETTINGS_INVALID/);
});
test('WorkOS store adoption and reopen preserve a populated direct store without migration or queue adoption',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spindle-workos-setup-')),key=randomBytes(32),server=await startTrackingServer(join(dir,'server'),randomBytes(32)),root=join(dir,'account');
 let sink:CollectorHistory|undefined;
 try{
  const directSetup={origin:server.origin,name:'direct-setup',deviceName:'Direct'};
  const direct=new TrackingClient(server.origin,root,key);await direct.signin(directSetup.name,'invented-only-password',directSetup.deviceName,true);
  const directState=await direct.inspect(),session=new PreviewSession();sink=new CollectorHistory(session,direct,directState.deviceId,86400000);
  session.start({pixels:false,rich:false,retain:true});session.focus({epoch:session.epoch,revision:1,at:0,key:'invented-window',app:'invented-editor',title:'Invented',clock:'invented-clock',browser:false});session.sample({epoch:session.epoch,revision:1,at:1,text:'Invented text',status:'native-text'});session.pause(10);await sink.dispose();sink=undefined;
  const pending=(await direct.inspect()).pending;assert.ok(pending>0);await direct.settle();const preserved=await readFile(join(root,'tracking.enc'));
  const response=await fetch(server.origin+'/register',{method:'POST',headers:{Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify({name:'workos.setup',password:'invented-only-password'})});
  assert.equal(response.status,200);const {csrf}=await response.json() as {csrf:string},cookie=response.headers.get('set-cookie')!.split(';')[0];
  const current=await fetch(server.origin+'/session',{headers:{Origin:server.origin,Cookie:cookie}}),{account}=await current.json() as {account:{id:string;name:string}};
  const setup={origin:server.origin,name:account.name,deviceName:'WorkOS',workosAccountId:account.id},selected=trackingStoreDirectory(root,server.origin,account.id);
  const workos=new TrackingClient(server.origin,selected,key);await workos.signinWorkOSSession({account,cookie,csrf},setup.deviceName);const workosState=await workos.inspect();assert.equal(workosState.pending,0);
  assert.deepEqual(await readFile(join(root,'tracking.enc')),preserved);
  const reopened=await reopenTracking(setup,root,key);assert.equal((await reopened.inspect()).accountId,account.id);assert.equal((await reopened.inspect()).deviceId,workosState.deviceId);
  await assert.rejects(reopenTracking({...setup,name:'different-name'},root,key),/ACCOUNT_SIGNIN_REQUIRED/);
  await assert.rejects(reopenTracking({...setup,deviceName:'Different device hint'},root,key),/ACCOUNT_SIGNIN_REQUIRED/);
  await assert.rejects(reopenTracking({...setup,workosAccountId:other},root,key),/ACCOUNT_SIGNIN_REQUIRED/);
  const directAgain=await reopenTracking(directSetup,root,key),after=await directAgain.inspect();assert.equal(after.deviceId,directState.deviceId);assert.equal(after.pending,pending);assert.equal(after.account,directSetup.name);
 }finally{await sink?.dispose();await server.close();await rm(dir,{recursive:true,force:true});}
});
