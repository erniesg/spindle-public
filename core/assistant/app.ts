import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AgentStore } from '../storage/agent-store.js';
import type { TaskNamespace } from '../notifications/events.js';
import type { EvidenceStore } from '../evidence/store.js';
import { MemoryStore } from '../memory/store.js';
import type { UserMemoryApplication } from '../memory/application.js';
import type { TaskMailReviewPage } from '../agent/mail-host.js';

/** Explicitly started preparation preview. Does not start capture or a task worker. */
export async function startTaskReview(store:AgentStore, namespace:TaskNamespace, evidence?:EvidenceStore, userMemory?:UserMemoryApplication, reviewMail?:(taskId:string,after:string)=>TaskMailReviewPage) {
 const trusted=Object.freeze({...namespace}); const token=randomBytes(32).toString('hex');
 const memory=evidence?new MemoryStore(evidence):undefined;
 let origin='';
 // A valid 8192-character shared-memory cursor can occupy 73728 percent-encoded bytes.
 const server=createServer({maxHeaderSize:131072},async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.headers.host!==new URL(origin).host || (req.headers.origin!==undefined&&req.headers.origin!==origin)) {reply(403,{error:'Access denied'});return;}
  let url:URL;
  try {url=new URL(req.url??'/',origin);}catch {reply(400,{error:'Invalid request target'});return;}
  if(req.method==='GET'&&['/','/ui.js','/user-memory-ui.js','/task-mail-ui.js','/style.css','/notifications/events.js'].includes(url.pathname)) {
   const file=url.pathname==='/'?'index.html':url.pathname==='/notifications/events.js'?'../notifications/events.js':url.pathname.slice(1);
   try { const data=await readFile(new URL(file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript'});res.end(data); }
   catch {reply(500,{error:'Preview assets unavailable'});}return;
  }
  const auth=Buffer.from(req.headers.authorization??'');const expected=Buffer.from(`Bearer ${token}`);
  if(auth.length!==expected.length||!timingSafeEqual(auth,expected)){reply(403,{error:'Access denied'});return;}
  try {
   if(userMemory&&url.pathname==='/api/user-memory') {
    if(req.method==='GET'){reply(200,userMemory.status(url.searchParams.get('after')??''));return;}
    if(req.method==='POST'){
     if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{error:'Access denied'});return;}
     const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>131072){reply(413,{error:'Request too large'});return;}chunks.push(b);}
     const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid request');
     const input=value as Record<string,unknown>;
     const fields:Record<string,string[]>={signin:['name','password','register'],signout:[],configure:['conversation','activity','processing','sync'],conversation:['text'],correct:['key','kind','value','revision'],forget:['key'],forgetConversation:['id'],resolve:['key','kind','value','revision'],retryForget:['key','revision'],sync:[]};
     const action=String(input.action);if(!fields[action]||Object.keys(input).some(k=>k!=='action'&&!fields[action].includes(k)))throw Error('Invalid action');
     if(action==='signin'){if(typeof input.name!=='string'||typeof input.password!=='string'||input.register!==undefined&&typeof input.register!=='boolean')throw Error('Invalid signin');await userMemory.signin(input.name,input.password,input.register===true);}
     else if(action==='signout')await userMemory.signout();
     else if(action==='configure')userMemory.configure({conversation:input.conversation as boolean,activity:input.activity as boolean,processing:input.processing as boolean,sync:input.sync as boolean});
     else if(action==='conversation'){if(typeof input.text!=='string')throw Error('Invalid conversation');userMemory.conversation(input.text);}
     else if(action==='correct'){if(typeof input.key!=='string'||typeof input.value!=='string'||!['fact','preference','goal'].includes(String(input.kind)))throw Error('Invalid correction');userMemory.correct(input.key,input.kind as 'fact'|'preference'|'goal',input.value,input.revision as number);}
     else if(action==='forget'){if(typeof input.key!=='string')throw Error('Invalid key');userMemory.forget(input.key);}
     else if(action==='resolve'){if(typeof input.key!=='string'||typeof input.value!=='string'||!['fact','preference','goal'].includes(String(input.kind))||!Number.isSafeInteger(input.revision))throw Error('Invalid resolution');userMemory.resolve(input.key,input.revision as number,{kind:input.kind as 'fact'|'preference'|'goal',value:input.value});}
     else if(action==='retryForget'){if(typeof input.key!=='string'||!Number.isSafeInteger(input.revision))throw Error('Invalid resolution');userMemory.resolve(input.key,input.revision as number);}
     else if(action==='forgetConversation'){if(typeof input.id!=='string')throw Error('Invalid turn');userMemory.forgetConversation(input.id);}
     else if(action==='sync')await userMemory.drain();
     reply(200,userMemory.status(url.searchParams.get('after')??''));return;
    }
   }
   if(memory&&req.method==='GET'&&url.pathname==='/api/memory') {
    reply(200,memory.list(trusted,url.searchParams.get('after')??''));return;
   }
   if(memory&&req.method==='GET'&&url.pathname==='/api/memory/history') {
    const key=url.searchParams.get('key');if(!key||key.length>8192){reply(400,{error:'Invalid key'});return;}
    reply(200,memory.history(trusted,key,url.searchParams.has('before')?Number(url.searchParams.get('before')):undefined));return;
   }
   if(memory&&req.method==='POST'&&url.pathname==='/api/memory') {
    if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{error:'Access denied'});return;}
    const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of req){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>32768){reply(413,{error:'Request too large'});return;}chunks.push(buffer);}
    const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)){reply(400,{error:'Invalid memory'});return;}
    const input=value as Record<string,unknown>;
    if(Object.keys(input).length!==3||Object.keys(input).some(key=>!['key','kind','value'].includes(key))||typeof input.key!=='string'||typeof input.value!=='string'||!['fact','preference','goal'].includes(String(input.kind))){reply(400,{error:'Invalid memory'});return;}
    // Namespace and correction authority are startup/user-route decisions, never body fields.
    reply(200,memory.record(trusted,{key:input.key,kind:input.kind as 'fact'|'preference'|'goal',value:input.value,sourceIds:[],userCorrected:true}));return;
   }
   if(reviewMail&&req.method==='GET'&&url.pathname==='/api/task-mail'){
    const id=url.searchParams.get('taskId');
    if(!id||url.searchParams.getAll('taskId').length!==1||url.searchParams.getAll('after').length>1||[...url.searchParams.keys()].some(k=>!['taskId','after'].includes(k))){reply(400,{error:'Invalid task'});return;}
    if(!store.taskView(trusted,id)){reply(404,{error:'Task unavailable'});return;}
    reply(200,reviewMail(id,url.searchParams.get('after')??''));return;
   }
   if(req.method==='GET'&&url.pathname==='/api/tasks') {reply(200,store.taskSummaries(trusted));return;}
   if(req.method==='GET'&&url.pathname.startsWith('/api/tasks/')) {
    const id=url.pathname.slice('/api/tasks/'.length);
    // Unknown IDs and foreign IDs have the same response and lookup path.
    const task=store.taskView(trusted,id);
    reply(task?200:404,task??{error:'Task unavailable'});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/notices'){reply(200,store.notifications(trusted));return;}
   if(req.method==='POST'&&url.pathname==='/api/ack') {
    if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){reply(403,{error:'Access denied'});return;}
    let body='';let bytes=0;
    for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>256){reply(413,{error:'Request too large'});return;}body+=String(chunk);}
    const value:unknown=JSON.parse(body);
    const id=typeof value==='object'&&value!==null&&'id' in value?value.id:undefined;
    if(typeof id!=='number'||!Number.isSafeInteger(id)||id<1){reply(400,{error:'Invalid notice'});return;}
    reply(store.acknowledge(trusted,id)?200:404,{ok:true});return;
   }
   reply(404,{error:'Not found'});
  } catch {reply(400,{error:'Request unavailable'});}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw Error('No loopback address');
 origin=`http://127.0.0.1:${address.port}`;
 return {origin,token,url:`${origin}/#${token}`,close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();})};
}
