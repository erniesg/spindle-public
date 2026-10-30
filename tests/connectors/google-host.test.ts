import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {scopes} from '../../core/connectors/google/oauth.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {startGoogleApplication, type GoogleApplicationConfig} from '../../core/connectors/google/main.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const wait=async(check:()=>boolean)=>{for(let i=0;i<300;i++){if(check())return;await delay(5);}throw Error('finite host latch expired');};
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
function notification(c:GoogleApplicationConfig){const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',kid:'host'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:c.route.audience,email:c.route.serviceAccountEmail,email_verified:true,iat:now,exp:now+300})).toString('base64url');return {authorization:`Bearer ${h}.${p}.${sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey).toString('base64url')}`,body:JSON.stringify({subscription:c.route.subscription,message:{messageId:'host-message',data:Buffer.from(JSON.stringify({emailAddress:c.route.account,historyId:'11'})).toString('base64')}})};}
function keyResponse(){return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'host',alg:'RS256'}]});}
function config(dir:string):GoogleApplicationConfig{return {clientId:'invented',connectionId:'c',dataDirectory:dir,mode:'push',topicName:'projects/test/topics/test',bootstrapSince:0,intervalMs:60000,route:{route:'r',account:'a@example.test',workspace:'w',epoch:'e',subscription:'projects/test/subscriptions/test',audience:'https://example.test',serviceAccountEmail:'push@example.test'},relevant:async()=>undefined,listen:{port:0}};}
const credentials={get:async()=>undefined,set:async()=>{},delete:async()=>{},compareAndSet:async()=>false};
test('invalid runtime configuration is rejected before creating directories or stores',async()=>{
 const root=mkdtempSync(join(tmpdir(),'google-invalid-'));
 try{for(const patch of [{mode:'pussh'},{relevant:null},{bootstrapSince:NaN},{intervalMs:2147483648},{route:{route:'r'}},{dataDirectory:123},{onSynchronized:1}]){
  const directory=join(root,'not-created');await assert.rejects(async()=>{const unexpected=await startGoogleApplication({...config(directory),...patch} as any,{credentials});await unexpected.stop();});assert.equal(existsSync(directory),false);
 }}finally{rmSync(root,{recursive:true,force:true});}
});
test('host rejects route, method, bearer and overload before awaiting body',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-ingress-'));const app=await startGoogleApplication(config(dir),{credentials});
 const address=app.address;assert.ok(address&&typeof address!=='string');const port=address.port;
 const sockets:ReturnType<typeof request>[]=[];
 function partial(path:string,method='POST',authorization='Bearer a.b.c'){
  let resolve!:(status:number)=>void;const result=new Promise<number>(r=>resolve=r);
  const req=request({hostname:'127.0.0.1',port,path,method,headers:{authorization,'content-length':'100'}},res=>{resolve(res.statusCode!);res.resume();});req.on('error',()=>{});req.flushHeaders();sockets.push(req);return {req,result};
 }
 try{
  for(const [path,method,auth,status] of [['/wrong','POST','Bearer a.b.c',404],['/google/push/r','PUT','Bearer a.b.c',405],['/google/push/r','POST','bad',401]] as const){assert.equal(await Promise.race([partial(path,method,auth).result,delay(500).then(()=>0)]),status);}
  for(let i=0;i<8;i++)partial('/google/push/r');await delay(50);
  assert.equal(await Promise.race([partial('/google/push/r').result,delay(500).then(()=>0)]),503);
 }finally{for(const socket of sockets)socket.destroy();await app.stop();rmSync(dir,{recursive:true,force:true});}
});

test('RSA notification through actual HTTP host admits before 60000ms recovery, disconnect cancels post-body intake',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-rsa-host-')),c=config(dir);let delivered=false,keyEntered=false,release!:()=>void,holdKeys=false;
 const keys=new Promise<void>(r=>release=r);c.relevant=async()=> 'prepare';
 const protectedStore={...credentials,compareAndSet:async()=>true,get:async()=>JSON.stringify({refreshToken:'invented',accountId:c.route.account,connectionEpoch:c.route.epoch,grants:[scopes.mail]})};
 const http:typeof fetch=async input=>{const url=String(input);if(url.endsWith('/certs')){keyEntered=true;if(holdKeys)await keys;return keyResponse();}if(url.includes('/token'))return Response.json({access_token:'invented',expires_in:3600});if(url.endsWith('/watch'))return Response.json({historyId:'10',expiration:String(Date.now()+7*86400000)});if(url.endsWith('/profile'))return Response.json({emailAddress:c.route.account,historyId:delivered?'11':'10'});if(url.includes('/messages?'))return Response.json({messages:[]});if(url.includes('/history?'))return Response.json({historyId:delivered?'11':'10',history:delivered?[{id:'11',messagesAdded:[{message:{id:'new'}}]}]:[]});return Response.json({id:'new',internalDate:'1000'});};
 let app=await startGoogleApplication(c,{credentials:protectedStore,http});
 try{
  await wait(()=>!!app.status().lastSync);const addr=app.address;assert.ok(addr&&typeof addr!=='string');const push=notification(c);delivered=true;const start=performance.now();
  assert.equal((await fetch(`http://127.0.0.1:${addr.port}/google/push/r`,{method:'POST',headers:{authorization:push.authorization},body:push.body})).status,204);
  const count=()=>{const db=new DatabaseSync(join(dir,'tasks.sqlite'));try{return Number(db.prepare('SELECT count(*) n FROM agent_tasks').get()!.n);}finally{db.close();}};
  await wait(()=>count()===1);assert.ok(performance.now()-start<60000);console.log(`LOCAL host notification admission ${Math.round(performance.now()-start)}ms, not Google latency`);
  await app.stop();
  // New host has no JWKS cache; disconnect only AFTER complete body is sent.
  holdKeys=true;keyEntered=false;app=await startGoogleApplication(c,{credentials:protectedStore,http});const second=app.address;assert.ok(second&&typeof second!=='string');
  const req=request({hostname:'127.0.0.1',port:second.port,path:'/google/push/r',method:'POST',headers:{authorization:push.authorization}},res=>res.resume());req.on('error',()=>{});req.end(push.body.replace('host-message','disconnected'));
  await wait(()=>keyEntered);req.destroy();await delay(50);release();await delay(50);
  const db=new DatabaseSync(join(dir,'wakes.sqlite'));try{assert.equal(db.prepare("SELECT count(*) n FROM google_delivery WHERE message='disconnected'").get()!.n,0);}finally{db.close();}
 }finally{release();await app.stop();rmSync(dir,{recursive:true,force:true});}
});
test('active request deadline cancels completed-body intake and leaves no late durable notification',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-deadline-')),c=config(dir);let entered=false,release!:()=>void;
 const keys=new Promise<void>(r=>release=r);
 const app=await startGoogleApplication(c,{credentials,http:async()=>{entered=true;await keys;return keyResponse();}});
 const address=app.address;assert.ok(address&&typeof address!=='string');const push=notification(c);
 const req=request({hostname:'127.0.0.1',port:address.port,path:'/google/push/r',method:'POST',headers:{authorization:push.authorization}},res=>res.resume());req.on('error',()=>{});
 const closed=new Promise<void>(r=>req.once('close',()=>r()));
 try{req.end(push.body);await wait(()=>entered);await Promise.race([closed,delay(12000).then(()=>{throw Error('active request deadline did not close socket');})]);release();await delay(50);
  const db=new DatabaseSync(join(dir,'wakes.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM google_delivery').get()!.n,0);}finally{db.close();}
 }finally{req.destroy();release();await app.stop();rmSync(dir,{recursive:true,force:true});}
});
test('actual Node executable launches trusted invented application module and exits on SIGTERM',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-cli-')),modulePath=join(dir,'application.mjs');
 const c=config(join(dir,'data'));c.mode='local';delete c.listen;
 writeFileSync(modulePath,`export function googleApplicationConfig(){return {...${JSON.stringify(c)},relevant:async()=>undefined,onSynchronized:()=>console.log('fixture-ready')}};export const googleApplicationDependencies={credentials:{get:async()=>JSON.stringify({refreshToken:'invented',accountId:'a@example.test',connectionEpoch:'e',grants:['https://www.googleapis.com/auth/gmail.readonly']}),set:async()=>{},delete:async()=>{},compareAndSet:async()=>true},http:async input=>{const u=String(input);return Response.json(u.includes('/token')?{access_token:'invented',expires_in:3600}:u.endsWith('/profile')?{emailAddress:'a@example.test',historyId:'10'}:{messages:[]})}};`);
 const child=spawn(process.execPath,['--max-old-space-size=256',new URL('../../core/connectors/google/main.js',import.meta.url).pathname,'--application-module',modulePath],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);const exited=new Promise<{code:number|null,signal:NodeJS.Signals|null}>(r=>child.once('exit',(code,signal)=>r({code,signal})));
 try{await wait(()=>output.includes('fixture-ready'));child.kill('SIGTERM');const result=await Promise.race([exited,delay(3000).then(()=>{throw Error('CLI failed to stop '+errors);})]);assert.equal(result.code,0,errors);assert.equal(result.signal,null);}finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;rmSync(dir,{recursive:true,force:true});}
});
