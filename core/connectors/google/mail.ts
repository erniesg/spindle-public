import { boundedBytes } from './bounded.js';
export interface MailAccess { accountId:string; token(options?:{signal?:AbortSignal}):Promise<string> }
function decode(data:unknown,size:unknown):Buffer {
 if(typeof data!=='string'||!/^[A-Za-z0-9_-]*$/.test(data)||data.length%4===1)throw Error('Invalid Gmail base64url');
 const bytes=Buffer.from(data,'base64url');
 if(bytes.toString('base64url')!==data||!Number.isSafeInteger(size)||size!==bytes.length)throw Error('Invalid Gmail body size');
 return bytes;
}
/** Selection is supplied by trusted admission, never by the model. */
export class SelectedMail {
 private readonly selected:Set<string>;
 private readonly parts=new Map<string,Map<string,{id:string;size:number;mimeType:string;version:string}>>();
 private readonly queries:Map<string,string>;
 constructor(readonly access:MailAccess,selected:ReadonlySet<string>,private http:typeof fetch=fetch,queries:ReadonlyMap<string,string>=new Map()){this.selected=new Set(selected);this.queries=new Map(queries);}
 async search(reference:string,signal:AbortSignal){
  const query=this.queries.get(reference);if(typeof query!=='string'||!query||query.length>8192)throw Error('Unknown admitted query reference');
  const {bytes,value}=await this.get(`?${new URLSearchParams({q:query,maxResults:'100'})}`,signal);
  const messages=value.messages??[];
  if(!Array.isArray(messages)||messages.length>100||messages.some((m:any)=>!m||typeof m.id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(m.id))||new Set(messages.map((m:any)=>m.id)).size!==messages.length|| (value.nextPageToken!==undefined&&(typeof value.nextPageToken!=='string'||!value.nextPageToken||value.nextPageToken.length>8192)))throw Error('Invalid Gmail search response');
  signal.throwIfAborted();for(const m of messages)this.selected.add(m.id);
  return {bytes,providerId:reference,providerVersion:'observed-search',mimeType:'application/json',search:{messages:messages.map((m:any)=>({id:m.id})),...(value.nextPageToken===undefined?{}:{nextPageToken:value.nextPageToken})}};
 }
 private async get(path:string,signal:AbortSignal){
  signal.throwIfAborted();const token=await this.access.token({signal});signal.throwIfAborted();
  const response=await this.http(`https://gmail.googleapis.com/gmail/v1/users/me/messages${path.startsWith('?')?'':'/'}${path}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
  if(!response.ok)throw Error(`Gmail read denied (${response.status})`);
  const bytes=await boundedBytes(response,8*1024*1024);signal.throwIfAborted();
  const value=JSON.parse(bytes.toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Gmail response');
  return {bytes,value};
 }
 async read(id:string,signal:AbortSignal){
  if(!this.selected.has(id))throw Error('Message outside admitted selection');
  const {bytes,value}=await this.get(`${encodeURIComponent(id)}?format=full`,signal);
  if(value.id!==id||typeof value.historyId!=='string'||!value.historyId||!value.payload)throw Error('Invalid Gmail message');
  const parts=new Map<string,{id:string;size:number;mimeType:string;version:string}>();let count=0;
  const bodies:Record<string,string[]>={'text/plain':[],'text/html':[]};let bodyBytes=0;
  const visit=(part:any,depth:number)=>{
   if(++count>1000||depth>30||!part||typeof part.partId!=='string'||typeof part.mimeType!=='string')throw Error('Invalid Gmail MIME tree');
   if(part.body?.attachmentId){if(parts.has(part.partId)||typeof part.body.attachmentId!=='string'||!Number.isSafeInteger(part.body.size)||part.body.size<0)throw Error('Invalid Gmail attachment');parts.set(part.partId,{id:part.body.attachmentId,size:part.body.size,mimeType:part.mimeType,version:value.historyId});}
   if(part.body?.data!==undefined){const decoded=decode(part.body.data,part.body.size);if(Object.hasOwn(bodies,part.mimeType)){bodyBytes+=decoded.length;if(bodyBytes>65536)throw Error('Message text exceeds bound');bodies[part.mimeType].push(decoded.toString('utf8'));}}
   if(part.parts!==undefined){if(!Array.isArray(part.parts))throw Error('Invalid Gmail parts');for(const child of part.parts)visit(child,depth+1);}
  };visit(value.payload,0);this.parts.set(id,parts);
  const headers=value.payload.headers??[];if(!Array.isArray(headers))throw Error('Invalid Gmail headers');
  const header=(name:string)=>{const h=headers.find((h:any)=>typeof h?.name==='string'&&h.name.toLowerCase()===name);const s=h?.value??'';if(typeof s!=='string'||s.length>8192)throw Error('Invalid Gmail header');return s;};
  const mimeType=bodies['text/plain'].length?'text/plain':'text/html';
  const message={subject:header('subject'),from:header('from'),text:bodies[mimeType].join('\n'),mimeType};
  return {bytes,providerId:id,providerVersion:value.historyId as string,mimeType:'application/json',originalUrl:`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(id)}`,parts:[...parts.keys()],message};
 }
 async attachment(message:string,part:string,signal:AbortSignal){
  const selected=this.parts.get(message)?.get(part);if(!this.selected.has(message)||!selected)throw Error('Attachment outside read selection');
  const {value}=await this.get(`${encodeURIComponent(message)}/attachments/${encodeURIComponent(selected.id)}`,signal);
  const bytes=decode(value.data,value.size);if(bytes.length!==selected.size)throw Error('Attachment size changed');
  return {bytes,providerId:`${message}/${part}`,providerVersion:selected.version,mimeType:selected.mimeType,originalUrl:`https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message)}`};
 }
}
