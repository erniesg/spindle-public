import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {GmailSync} from '../../core/connectors/google/gmail.js';
import {AgentStore} from '../../core/storage/agent-store.js';
import {boundedBytes} from '../../core/connectors/google/bounded.js';
import {GoogleOAuth,scopes} from '../../core/connectors/google/oauth.js';
import {connectedGoogle} from '../../core/connectors/google/connected.js';
test('cross-instance owner lease, admission failure and malformed response preserve cursor after reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-safety-'));const path=join(dir,'cursor');const tasks=new AgentStore(join(dir,'tasks'));
 let mode='normal';const http=(async(input:unknown)=>{const url=String(input);if(url.endsWith('/profile'))return Response.json(mode==='profile'?{emailAddress:'a@b.invalid'}:{emailAddress:'a@b.invalid',historyId:'10'});if(url.includes('messages/'))return Response.json({id:'one'});if(url.includes('/history'))return Response.json(mode==='history'?{}:{historyId:'11',history:[{id:'11',messagesAdded:[{message:{id:'one'}}]}]});return Response.json({messages:[mode==='ids'?{}:{id:'one'}]});}) as typeof fetch;
 let a=new GmailSync(path,tasks,http);const b=new GmailSync(path,tasks,http);let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 try{const first=a.poll('a@b.invalid','w','test',async()=>{entered();await gate;return undefined;});await started;
 await assert.rejects(b.poll('a@b.invalid','w','test',async()=>undefined),/busy/);
 await b.poll('a@b.invalid','other','test',async()=>undefined);release();await first;
 const cursor=()=>{const db=new DatabaseSync(path);try{return db.prepare('SELECT cursor FROM google_cursor WHERE account=?').get(JSON.stringify(['w','a@b.invalid']));}finally{db.close();}};
 const before=cursor();mode='history';await assert.rejects(a.poll('a@b.invalid','w','test',async()=>undefined),/cursor/);assert.deepEqual(cursor(),before);
 mode='profile';await assert.rejects(a.poll('a@b.invalid','w','test',async()=>undefined),/profile/);
 mode='ids';await assert.rejects(a.poll('a@b.invalid','new','test',async()=>undefined),/messages/);
 mode='normal';const admit=tasks.admit;tasks.admit=()=>{throw Error('forced admission failure');};await assert.rejects(a.poll('a@b.invalid','w','test',async()=>'task'),/forced admission/);tasks.admit=admit;
 a.close();a=new GmailSync(path,tasks,http);assert.deepEqual(cursor(),before);await a.poll('a@b.invalid','w','test',async()=>undefined);
 }finally{a.close();b.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('aggregate bytes across message responses stop before cursor advancement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'google-budget-'));const tasks=new AgentStore(join(dir,'tasks'));const path=join(dir,'cursor');let reads=0;
 const http=(async(input:unknown)=>{const url=String(input);if(url.endsWith('/profile'))return Response.json({emailAddress:'a@b.invalid',historyId:'1'});if(url.includes('messages/')){reads++;return Response.json({id:url.split('/').pop()?.split('?')[0],padding:'x'.repeat(1900000)});}return Response.json({messages:Array.from({length:12},(_,i)=>({id:String(i)}))});}) as typeof fetch;
 const sync=new GmailSync(path,tasks,http);try{await assert.rejects(sync.poll('a@b.invalid','w','test',async()=>undefined),/byte limit/);assert.ok(reads<12);const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT * FROM google_cursor').all().length,0);}finally{db.close();}}finally{sync.close();tasks.close();rmSync(dir,{recursive:true,force:true});}
});
test('protected connection construction denies absent grants without network',async()=>{
 let calls=0;const store={get:async()=>JSON.stringify({accountId:'verified@example.invalid',refreshToken:'invented',grants:[]}),set:async()=>{},delete:async()=>{},compareAndSet:async()=>{throw Error('unexpected write');}};
 const oauth=new GoogleOAuth('invented',store,(async()=>{calls++;throw Error('network forbidden');}) as typeof fetch);
 const access=await oauth.connectorAccess('connection',scopes.mail);assert.equal(access.accountId,'verified@example.invalid');await assert.rejects(access.token(),/grant absent/);
 const connected=await connectedGoogle(oauth,'connection');const drive=await connected.drive(new Set(['root']));await assert.rejects(drive.list('root'),/grant absent/);assert.equal(calls,0);
});
test('actual local chunked HTTP response is cancelled at byte bound; no Google endpoint',async()=>{
 let closed!:()=>void;const disconnected=new Promise<void>(r=>closed=r);let requests=0;
 const server=createServer((req,res)=>{requests++;assert.equal(req.headers.host?.startsWith('127.0.0.1:'),true);res.writeHead(200);const timer=setInterval(()=>res.write(Buffer.alloc(8192)),2);res.on('close',()=>{clearInterval(timer);closed();});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 try{const response=await fetch(`http://127.0.0.1:${address.port}`);await assert.rejects(boundedBytes(response,1024),/byte limit/);await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(Error('stream not cancelled')),1000).unref())]);assert.equal(requests,1);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
