import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {InboxService,parseTriage,type EmailTriage} from '../../core/inbox/service.js';

// Fake dependencies only: no Google, model or mail provider is reached. Every RPC is recorded.
type Call={service:string;owner:string;path:string;data:Record<string,unknown>};
const encode=(text:string)=>Buffer.from(text,'utf8').toString('base64url');
function message(id:string,threadId:string,internalDate:number,headers:Record<string,string>,body:string,files:{filename:string;mimeType:string;attachmentId:string}[]=[]){
 return {id,threadId,internalDate:String(internalDate),payload:{mimeType:'multipart/mixed',headers:Object.entries(headers).map(([name,value])=>({name,value})),parts:[{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{data:encode(body)}},{mimeType:'text/html',body:{data:encode('<p>html</p>')}}]},...files.map(f=>({mimeType:f.mimeType,filename:f.filename,body:{attachmentId:f.attachmentId,size:12}}))]}};
}
async function fixture(options:{failFirstPreparation?:boolean}={}){
 const directory=await mkdtemp(join(tmpdir(),'spindle-invented-inbox-')),calls:Call[]=[],triaged:{from:string;subject:string;body:string}[]=[],gmail:string[]=[],emailed:{name:string;mimeType:string;providerId:string;bytes:Uint8Array}[][]=[];
 const now=Date.now(),messages=[
  message('m-relevant','thread-1',now+60_000,{From:'Invented Clerk <clerk@example.test>',Subject:'Passport photo request','Message-ID':'<m1@example.test>',References:'<earlier@example.test>'},'Please send a 35x45mm photo on a white background and the filled form.',[{filename:'Invented Form.pdf',mimeType:'application/pdf',attachmentId:'att-1'},{filename:'invite.ics',mimeType:'text/calendar',attachmentId:'att-2'}]),
  message('m-irrelevant','thread-2',now+61_000,{From:'news@example.test',Subject:'Weekly newsletter','Message-ID':'<m2@example.test>'},'Invented newsletter content.'),
  message('m-old','thread-3',now-86_400_000,{From:'old@example.test',Subject:'Old request for documents','Message-ID':'<m3@example.test>'},'Please send documents.')
 ];
 let preparationState='working',preparationRequests=0,mailState:{state:string;drafts:any[]}={state:'working',drafts:[]};
 const record=(service:string)=>(owner:string,_session:string,path:string,data:Record<string,unknown>)=>{calls.push({service,owner,path,data:structuredClone(data)});return Promise.resolve();};
 const http=(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=new URL(String(input));gmail.push(url.pathname+url.search);
  assert.equal(new Headers(init?.headers).get('authorization'),'Bearer INVENTED_GMAIL_TOKEN');
  if(url.pathname.endsWith('/attachments/att-1'))return Response.json({data:encode('%PDF-invented')});
  if(url.pathname.endsWith('/messages'))return Response.json({messages:[...messages].reverse().map(m=>({id:m.id,threadId:m.threadId}))});
  const found=messages.find(m=>url.pathname.endsWith('/messages/'+m.id));return found?Response.json(found):new Response(null,{status:404});
 }) as typeof fetch;
 const inbox=new InboxService({directory,pollIntervalMs:0,
  triage:async(email):Promise<EmailTriage>=>{triaged.push(email);return /photo/i.test(email.subject)?{relevant:true,title:'Passport photo',summary:'Asks for a photo and a form.',instruction:'Prepare a 35x45mm white-background photo and fill the form.'}:{relevant:false,title:'Newsletter',summary:'A newsletter.',instruction:''};},
  google:{
   handle:async(owner,session,path,data)=>{await record('google')(owner,session,path,data);if(path==='/google/list')return {connections:[{id:'conn-1',status:'connected',roots:['root-1'],grants:['https://www.googleapis.com/auth/drive']}]};if(path==='/google/drive/check')return {name:'Invented folder'};throw Error('unexpected google path '+path);},
   gmailToken:async()=>({token:'INVENTED_GMAIL_TOKEN',http})
  },
  preparation:{handle:async(owner,session,path,data,extra)=>{await record('preparation')(owner,session,path,data);if(path==='/preparation/request')emailed.push(extra?.emailAttachments??[]);
   if(path==='/preparation/request'){preparationRequests++;if(options.failFirstPreparation&&preparationRequests===1)throw Error('INVENTED_TRANSIENT');return {taskId:'prep-1'};}
   if(path==='/preparation/resume'){preparationState='working';return {taskId:'prep-1'};}
   if(path==='/preparation/status')return {state:preparationState,...(preparationState==='blocked'?{blocker:'GOOGLE_NETWORK_UNAVAILABLE',canResume:true,generation:1}:{}),uploads:[{artifactId:'out-pdf',state:'verified'},{artifactId:'out-png',state:'verified'}]};
   throw Error('unexpected preparation path '+path);}},
  mail:{handle:async(owner,session,path,data)=>{await record('mail')(owner,session,path,data);
   if(path==='/mail/sources')return {artifacts:[{artifactId:'source-pdf',mimeType:'application/pdf',name:'source-statement.pdf'},{artifactId:'out-pdf',mimeType:'application/pdf',name:'prepared-form.pdf'},{artifactId:'out-png',mimeType:'image/png',name:'prepared-photo.png'}]};
   if(path==='/mail/request')return {taskId:'mail-1'};
   if(path==='/mail/status')return mailState;
   if(path==='/mail/publish'){mailState={...mailState,drafts:mailState.drafts.map(d=>({...d,publish:{state:'verified'}}))};return mailState;}
   throw Error('unexpected mail path '+path);}}
 });
 // One owner status poll, then wait for the background steps it started (status replies before they finish).
 const status=async(owner='owner-a')=>{const result=await inbox.handle(owner,'session-'+owner,'/inbox/status',{}) as any;await inbox.close();return result;};
 const items=async(owner='owner-a')=>(JSON.parse(await readFile(join(directory,'inbox',owner+'.json'),'utf8')).items as any[]).filter(i=>i.state!=='ignored');
 return {inbox,directory,calls,triaged,gmail,emailed,status,items,setPreparation:(state:string)=>{preparationState=state;},setMail:(value:typeof mailState)=>{mailState=value;},
  of:(service:string,path:string)=>calls.filter(c=>c.service===service&&c.path===path),
  close:async()=>{await inbox.close();await rm(directory,{recursive:true,force:true});}};
}
const draft={artifactId:'draft-artifact',sha256:'a'.repeat(64),draftId:'draft-1',revision:1};

test('relevant mail -> preparation (saveOutputs, stable id) -> threaded reply draft with prepared outputs -> one Gmail draft; never sends',async()=>{
 const f=await fixture();try{
  const first=await f.status();
  assert.equal(first.watching,true);assert.equal(first.connectionId,'conn-1');assert.equal(first.rootId,'root-1');
  assert.deepEqual(f.of('google','/google/drive/check').map(c=>c.data),[{connectionId:'conn-1',rootId:'root-1'}]);
  assert.match(f.gmail[0]!,/q=in%3Ainbox/);
  // Triage sees only new mail: the message older than `since` is skipped before triage.
  assert.deepEqual(f.triaged.map(t=>t.subject),['Passport photo request','Weekly newsletter']);
  assert.equal(f.triaged[0]!.from,'Invented Clerk <clerk@example.test>');assert.match(f.triaged[0]!.body,/35x45mm photo/);
  const listed=(await f.status()).items as any[];
  assert.deepEqual(listed.map(i=>i.id),['m-relevant'],'ignored mail is not listed; old mail never became an item');
  for(const hidden of ['instruction','references','messageId','replyTo'])assert.ok(!(hidden in listed[0]),hidden+' is not exposed by status');
  let items=await f.items();
  const prep=f.of('preparation','/preparation/request');assert.equal(prep.length,1);
  assert.equal(prep[0]!.owner,'owner-a');
  assert.deepEqual({...prep[0]!.data,request:undefined},{connectionId:'conn-1',rootId:'root-1',request:undefined,requestId:prep[0]!.data.requestId,processingConsent:true,saveOutputs:true,newIntent:true});
  assert.match(String(prep[0]!.data.requestId),/^inbox-[a-f0-9]{48}$/);assert.match(String(prep[0]!.data.request),/Prepare a 35x45mm white-background photo/);
  assert.equal(items[0].state,'preparing');assert.equal(items[0].preparationTaskId,'prep-1');
  // The email's PDF attachment (not the calendar file) is handed to preparation directly; nothing is written to Drive.
  assert.deepEqual(f.emailed[0]!.map(a=>[a.name,a.mimeType,Buffer.from(a.bytes).toString()]),[['Invented Form.pdf','application/pdf','%PDF-invented']]);
  assert.match(f.emailed[0]![0]!.providerId,/^m-relevant:[a-f0-9]{16}$/);
  assert.match(String(prep[0]!.data.request),/"Invented Form\.pdf"/);
  assert.deepEqual(listed[0].attachments.map((a:any)=>a.name),['Invented Form.pdf']);
  // Still working: no draft is requested.
  await f.status();assert.equal(f.of('mail','/mail/request').length,0);
  // A transient network blocker is resumed automatically instead of failing the request.
  f.setPreparation('blocked');await f.status();items=await f.items();
  assert.equal(items[0].state,'preparing');assert.equal(items[0].resumes,1);
  assert.deepEqual(f.of('preparation','/preparation/resume').map(c=>[c.data.taskId,c.data.expectedGeneration]),[['prep-1',1]]);
  f.setPreparation('ready');await f.status();await f.status();items=await f.items();assert.equal(items[0].state,'drafting');
  const mail=f.of('mail','/mail/request');assert.equal(mail.length,1);const data=mail[0]!.data,text=String(data.request);
  assert.equal(data.connectionId,'conn-1');assert.equal(data.processingConsent,true);assert.equal(data.sourceTaskId,'prep-1');
  assert.deepEqual(data.attachmentIds,['out-pdf','out-png'],'only prepared outputs are attached, never the source document');
  assert.match(String(data.requestId),/^inbox-[a-f0-9]{48}$/);assert.notEqual(data.requestId,prep[0]!.data.requestId);
  assert.ok(text.includes('reply.threadId="thread-1"'),text);assert.ok(text.includes('reply.inReplyTo="<m1@example.test>"'),text);
  assert.ok(text.includes('reply.references=["<earlier@example.test>","<m1@example.test>"]'),text);
  assert.ok(text.includes('Address it to clerk@example.test only'),text);assert.ok(text.includes('Re: Passport photo request'),text);assert.match(text,/never send/);
  f.setMail({state:'ready',drafts:[{draft,publish:null,send:null}]});
  await f.status();items=await f.items();assert.equal(items[0].state,'draft_ready');assert.deepEqual(items[0].draft,draft);assert.equal(items[0].published,true);
  for(let n=0;n<3;n++)await f.status();
  const publish=f.of('mail','/mail/publish');assert.equal(publish.length,1,'the draft is placed in Gmail Drafts exactly once');
  assert.deepEqual({...publish[0]!.data,requestId:undefined},{taskId:'mail-1',draft,requestId:undefined});assert.match(String(publish[0]!.data.requestId),/^inbox-[a-f0-9]{48}$/);
  assert.equal(f.calls.some(c=>c.path==='/mail/send'),false,'inbox automation never sends');
  assert.equal(f.of('preparation','/preparation/request').length,1,'preparation is requested once');assert.equal(f.of('mail','/mail/request').length,1,'the reply is requested once');
  assert.deepEqual(f.triaged.length,2,'already-seen messages are not re-triaged');
 }finally{await f.close();}
});

test('request ids are stable for the same owner and message across retries and service instances, and differ per owner',async()=>{
 const a=await fixture({failFirstPreparation:true}),b=await fixture();try{
  await a.status();await a.status();assert.equal(a.of('preparation','/preparation/request').length,1);
  await a.status();assert.equal((await a.items())[0].state,'preparing','a transient failure leaves the item retryable');
  const [failed,retried]=a.of('preparation','/preparation/request');assert.equal(failed!.data.requestId,retried!.data.requestId);
  assert.equal(a.emailed[0]![0]!.providerId,a.emailed[1]![0]!.providerId,'the attachment keeps a stable source id across retries');
  await b.status();await b.status();assert.equal(b.of('preparation','/preparation/request')[0]!.data.requestId,failed!.data.requestId,'stable across independent instances');
  await b.status('owner-b');await b.status('owner-b');
  const other=b.of('preparation','/preparation/request').find(c=>c.owner==='owner-b')!;assert.notEqual(other.data.requestId,failed!.data.requestId);
 }finally{await a.close();await b.close();}
});

test('per-owner isolation, dismiss, and the router refuses unknown paths and invalid configuration',async()=>{
 const f=await fixture();try{
  await f.status('owner-a');await f.status('owner-a');
  assert.equal(f.calls.every(c=>c.owner==='owner-a'),true);
  await assert.rejects(f.inbox.handle('owner-a','s','/inbox/configure',{connectionId:'../x',rootId:'root-1'}),(e:any)=>e.status===400&&e.code==='INVALID_INBOX_CONFIGURATION');
  await assert.rejects(f.inbox.handle('owner-a','s','/inbox/unknown',{}),(e:any)=>e.status===404);
  await assert.rejects(f.inbox.handle('../escape','s','/inbox/status',{}),(e:any)=>e.status===400&&e.code==='INVALID_OWNER');
  const dismissed=await f.inbox.handle('owner-a','session-owner-a','/inbox/dismiss',{id:'m-relevant'}) as any;await f.inbox.close();
  assert.equal(dismissed.items[0].state,'preparing','in-flight preparation cannot be dismissed');
  f.setPreparation('cancelled');await f.status();const after=await f.inbox.handle('owner-a','session-owner-a','/inbox/dismiss',{id:'m-relevant'}) as any;await f.inbox.close();
  assert.deepEqual(after.items,[],'a stopped item can be dismissed');
 }finally{await f.close();}
});

test('triage parsing fails closed and never marks an instruction-less email relevant',()=>{
 assert.throws(()=>parseTriage(null),/INVALID_TRIAGE/);assert.throws(()=>parseTriage({relevant:'yes'}),/INVALID_TRIAGE/);
 assert.deepEqual(parseTriage({relevant:true,title:'',summary:'s',instruction:'  '}),{relevant:false,title:'Request',summary:'s',instruction:''});
 const parsed=parseTriage({relevant:true,title:'T\u0000itle',summary:'x'.repeat(400),instruction:'Do\nit'});
 assert.equal(parsed.relevant,true);assert.equal(parsed.title,'T itle');assert.equal(parsed.summary.length,300);assert.equal(parsed.instruction,'Do it');
});
