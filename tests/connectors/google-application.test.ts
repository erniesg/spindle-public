import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startGoogleApplication} from '../../core/connectors/google/main.js';
import {scopes} from '../../core/connectors/google/oauth.js';

test('explicit application host runs real OAuth, timer, sync and durable task admission; closes and reopens',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-app-'));let calls=0;
 const credentials={get:async()=>JSON.stringify({refreshToken:'invented',accountId:'test@example.test',connectionEpoch:'epoch',grants:[scopes.mail]}),set:async()=>{},delete:async()=>{},compareAndSet:async()=>true};
 const http:typeof fetch=async input=>{calls++;const url=String(input);if(url.includes('/token'))return Response.json({access_token:'invented',expires_in:3600});if(url.endsWith('/profile'))return Response.json({emailAddress:'test@example.test',historyId:'10'});if(url.includes('/messages?'))return Response.json({messages:[{id:'one'}]});if(url.includes('/history?'))return Response.json({historyId:'10',history:[]});return Response.json({id:'one',internalDate:'1000'});};
 const config={clientId:'invented',connectionId:'connection',dataDirectory:dir,mode:'local' as const,bootstrapSince:500,intervalMs:60000,route:{route:'route',account:'test@example.test',workspace:'test',epoch:'epoch',audience:'https://receiver.example.test',subscription:'projects/test/subscriptions/test',serviceAccountEmail:'push@test.example'},relevant:async()=> 'prepare',listen:{port:0}};
 let app:Awaited<ReturnType<typeof startGoogleApplication>>|undefined;
 try {
  for(let run=0;run<2;run++){
   app=await startGoogleApplication(config,{credentials,http});const address=app.address;assert.ok(address&&typeof address!=='string');assert.equal(address.address,'127.0.0.1');const base=`http://127.0.0.1:${address.port}`;
   assert.equal((await fetch(base+'/wrong')).status,404);
   assert.equal((await fetch(base+'/google/push/route')).status,405);
   assert.equal((await fetch(base+'/google/push/route',{method:'POST',body:'invalid'})).status,503);
   const deadline=Date.now()+3000;while(!app.status().lastSync&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));if(run===0)assert.ok(app.status().lastSync,app.status().failure);
   const db=new DatabaseSync(join(dir,'tasks.sqlite'));try{assert.equal(db.prepare('SELECT count(*) n FROM agent_tasks').get()!.n,1);}finally{db.close();}
   await app.stop();await app.stop();const before=calls;await new Promise(r=>setTimeout(r,30));assert.equal(calls,before);await assert.rejects(fetch(base));
  }
 }finally{await app?.stop();rmSync(dir,{recursive:true,force:true});}
});
