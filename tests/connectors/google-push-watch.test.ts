import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GooglePushIntake } from '../../core/connectors/google/push.js';
import { GmailWatch } from '../../core/connectors/google/watch.js';
import { GoogleWakeJournal } from '../../core/connectors/google/wake-journal.js';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const route={route:'r',workspace:'w',account:'invented@example.test',epoch:'e',subscription:'projects/demo/subscriptions/mail',audience:'https://receiver.example.test/push',serviceAccountEmail:'push@demo.iam.gserviceaccount.com'};
const http:typeof fetch=async(input)=>{assert.equal(input,'https://www.googleapis.com/oauth2/v3/certs');return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256'}]});};
function request(overrides:Record<string,unknown>={},bodyOverride:Record<string,unknown>={},bad=false){
 const now=Math.floor(Date.now()/1000),h=Buffer.from(JSON.stringify({alg:'RS256',kid:'test'})).toString('base64url'),p=Buffer.from(JSON.stringify({iss:'https://accounts.google.com',aud:route.audience,email:route.serviceAccountEmail,email_verified:true,iat:now,exp:now+300,...overrides})).toString('base64url');
 const signature=sign('RSA-SHA256',Buffer.from(h+'.'+p),privateKey);if(bad)signature[0]^=1;
 return new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${h}.${p}.${signature.toString('base64url')}`},body:JSON.stringify({subscription:route.subscription,message:{messageId:'delivery',data:Buffer.from(JSON.stringify({emailAddress:route.account,historyId:'123'})).toString('base64')},...bodyOverride})});
}
test('real RSA authentication precedes durable acknowledgement; replay is safe',async()=>{
 const journal=new GoogleWakeJournal(':memory:');try{const intake=new GooglePushIntake([route],journal,http);
 assert.equal((await intake.handle('r',request())).status,204);assert.equal((await intake.handle('r',request())).status,204);
 const claim=journal.claim(route);assert.equal(claim?.sequence,1);assert.equal(journal.watch(route),undefined);
 }finally{journal.close();}
});
test('bad signatures, audience, service account, expiry, subscription and account cannot enqueue',async()=>{
 let calls=0;const intake=new GooglePushIntake([route],{enqueue:()=>{calls++;return true;}},http);
 for(const req of [request({}, {},true),request({aud:'other'}),request({email:'other'}),request({email_verified:false}),request({exp:1}),request({},{subscription:'other'}),request({},{message:{messageId:'x',data:Buffer.from(JSON.stringify({emailAddress:'other',historyId:'1'})).toString('base64')}})])assert.equal((await intake.handle('r',req)).status,400);
 assert.equal((await intake.handle('unknown',request())).status,404);assert.equal(calls,0);
});
test('journal failure is not acknowledged and trusted route is copied',async()=>{
 const copy={...route};let account='';const intake=new GooglePushIntake([copy],{enqueue:r=>{account=r.account;throw Error('disk');}},http);copy.account='attacker';
 assert.equal((await intake.handle('r',request())).status,503);assert.equal(account,route.account);
});
test('watch renewal records separate metadata, no label filter, stop uses actual endpoint',async()=>{
 const journal=new GoogleWakeJournal(':memory:');const urls:string[]=[];
 const watch=new GmailWatch(journal,async(input,init)=>{urls.push(String(input));if(String(input).endsWith('/watch')){assert.deepEqual(JSON.parse(String(init?.body)),{topicName:'projects/demo-project/topics/mail'});return Response.json({historyId:'999',expiration:String(Date.now()+86400000)});}return new Response(null,{status:204});});
 try{await watch.start(route,'invented','projects/demo-project/topics/mail',{assertCurrent:()=>{}});assert.equal(journal.watch(route)?.historyId,'999');assert.equal(journal.claim(route),undefined);await watch.stop('invented',{assertCurrent:()=>{}});assert.ok(urls[1].endsWith('/stop'));}finally{journal.close();}
});
test('watch rejects stale lifecycle and malformed expiry without journal writes',async()=>{
 let writes=0;const watch=new GmailWatch({recordWatch:()=>{writes++;}},async()=>Response.json({historyId:'1',expiration:'0'}));
 await assert.rejects(watch.start(route,'invented','projects/demo-project/topics/mail',{assertCurrent:()=>{}}));
 await assert.rejects(watch.start(route,'invented','projects/demo-project/topics/mail',{assertCurrent:()=>{throw Error('stale');}}));assert.equal(writes,0);
});
