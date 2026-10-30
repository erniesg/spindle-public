import {resourceIdentity} from '../../core/blocking/policy.js';
import {PURPOSE_PAGE_TEXT_BYTES} from '../../core/blocking/purpose.js';

const RAW_BYTES=131072;
const encoder=new TextEncoder();
const unavailable=()=>new Error('STATIC_CONTENT_UNAVAILABLE');
const check=(signal:AbortSignal)=>{if(signal.aborted)throw unavailable();};

// A public-looking DNS name is not a DNS/provenance certificate. The privileged
// caller must already admit this exact resource and hold its extension permission.
function validateResource(resource:string):void {
 if(typeof resource!=='string'||resource.length>2048||resourceIdentity(resource)!==resource)throw unavailable();
 const {hostname}=new URL(resource);
 if(!hostname.includes('.')||hostname.endsWith('.')||hostname.includes(':')||/^\d+(?:\.\d+){3}$/.test(hostname)
  ||/(^|\.)(localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname))throw unavailable();
}

function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(unavailable());};
  const cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});
  work.then(value=>{cleanup();signal.aborted?reject(unavailable()):resolve(value);},()=>{cleanup();reject(unavailable());});
  if(signal.aborted)abort();
 });
}
function cancel(body:ReadableStream<Uint8Array>|undefined|null):void {
 if(body)void body.cancel().catch(()=>{});
}
function contentType(value:string|null):boolean {
 // No sniffing or fallback encodings. ASCII is unambiguous without a charset;
 // non-ASCII requires a UTF-8 header, BOM or explicit HTML declaration below.
 const match=/^text\/html\s*(?:;\s*charset\s*=\s*(?:"(utf-?8)"|(utf-?8))\s*)?$/i.exec(value??'');
 if(!match)throw unavailable();
 return Boolean(match[1]||match[2]);
}
async function readPrefix(response:Response,signal:AbortSignal):Promise<{raw:Uint8Array;truncated:boolean}> {
 if(!response.body)throw unavailable();
 const reader=response.body.getReader(),buffer=new Uint8Array(RAW_BYTES);
 let size=0,finished=false;
 const stop=()=>{void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',stop,{once:true});
 try {
  check(signal);
  while(size<RAW_BYTES){
   const part=await abortable(reader.read(),signal);check(signal);
   if(part.done){finished=true;return {raw:buffer.slice(0,size),truncated:false};}
   if(!(part.value instanceof Uint8Array))throw unavailable();
   const bytes=part.value.subarray(0,RAW_BYTES-size);buffer.set(bytes,size);size+=bytes.byteLength;
  }
  // Do not read one more byte to distinguish exact-limit EOF: conservatively
  // disclose truncation whenever the prefix ceiling is reached.
  stop();finished=true;return {raw:buffer,truncated:true};
 }finally{
  signal.removeEventListener('abort',stop);if(!finished)stop();reader.releaseLock();
 }
}

const entities:Readonly<Record<string,string>>={
 amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',trade:'™',
 ndash:'–',mdash:'—',hellip:'…',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”',bull:'•',middot:'·',
 laquo:'«',raquo:'»',eacute:'é',Eacute:'É',ouml:'ö',auml:'ä',uuml:'ü',szlig:'ß',
 times:'×',divide:'÷',minus:'−',plusmn:'±',le:'≤',ge:'≥',ne:'≠',infin:'∞',sum:'∑',int:'∫',
 radic:'√',rarr:'→',larr:'←',harr:'↔',isin:'∈',notin:'∉',sub:'⊂',sup:'⊃',
 alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',theta:'θ',lambda:'λ',mu:'μ',pi:'π',
 sigma:'σ',phi:'φ',omega:'ω',Delta:'Δ',Sigma:'Σ',Pi:'Π',Omega:'Ω'
};
function decode(value:string,metadata=false):string {
 if(metadata&&/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw unavailable();
 const decoded=value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);/gi,(_,entity:string)=>{
  if(entity.startsWith('#')){
   const hex=entity[1]?.toLowerCase()==='x',point=Number.parseInt(entity.slice(hex?2:1),hex?16:10);
   if(!Number.isSafeInteger(point)||point===0||point>0x10ffff||(point>=0xd800&&point<=0xdfff)
    ||(point<32&&![9,10,13].includes(point))||(point>=127&&point<=159))throw unavailable();
   return String.fromCodePoint(point);
  }
  if(!Object.hasOwn(entities,entity))throw unavailable();
  return entities[entity];
 });
 // In metadata, ambiguous/missing entity terminators are not silently repaired.
 if(metadata&&/&(?:#[^\s;]*|[a-z][a-z0-9]*);?/i.test(value.replace(/&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);/gi,'')))throw unavailable();
 return decoded;
}
const normalise=(value:string)=>value.replace(/\s+/gu,' ').trim();
function bounded(value:string,limit:number,utf8=false):string {
 let result='',size=0;
 for(const char of value){const length=utf8?encoder.encode(char).byteLength:char.length;if(size+length>limit)break;result+=char;size+=length;}
 return result;
}
interface Tag {name:string;closing:boolean;selfClosing:boolean;attrs:Map<string,string>;end:number}
function tagAt(html:string,start:number,truncated:boolean):Tag|undefined {
 let i=start+1,quote='';
 for(;i<html.length;i++){
  const char=html[i];if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;
 }
 if(i===html.length){if(truncated)return;throw unavailable();}
 const token=html.slice(start+1,i),match=/^(\/)?([a-z][a-z0-9:-]*)(?=\s|\/|$)/i.exec(token);
 if(!match)throw unavailable();
 const closing=Boolean(match[1]),attrs=new Map<string,string>();let rest=token.slice(match[0].length),selfClosing=false;
 while(rest){
  if(/^\s*\/?\s*$/.test(rest)){selfClosing=rest.includes('/');break;}
  const attr=/^\s+([a-z_:][a-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/i.exec(rest);
  if(!attr||closing)throw unavailable();
  const name=attr[1].toLowerCase();if(attrs.has(name))throw unavailable();
  attrs.set(name,attr[2]??attr[3]??attr[4]??'');rest=rest.slice(attr[0].length);
 }
 return {name:match[2].toLowerCase(),closing,selfClosing,attrs,end:i+1};
}
const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const excluded=new Set(['script','style','noscript','form','textarea','input','select','option','button','output','template','iframe','object','embed','frameset','frame','canvas']);
const rawTags=new Set(['script','style','noscript','textarea','iframe','title','xmp','noembed','noframes','plaintext']);
function hidden(attrs:Map<string,string>):boolean {
 if(attrs.has('hidden')||attrs.has('inert'))return true;
 if(attrs.has('contenteditable')&&decode(attrs.get('contenteditable')!).trim().toLowerCase()!=='false')return true;
 if(decode(attrs.get('aria-hidden')??'').trim().toLowerCase()==='true')return true;
 const style=decode(attrs.get('style')??'').replace(/\/\*[\s\S]*?\*\//g,'');
 return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i.test(style);
}

/** Bounded, non-evaluating STATIC snapshot tokenizer, not a rendered DOM or an
 * all-hidden-content/privacy certificate. No URL attributes are followed, no
 * DOM is constructed, and CSS/layout/JS visibility is not inferred. Unsupported
 * entities/ambiguous metadata fail closed rather than fabricating evidence. */
function extract(html:string,truncated:boolean):{title?:string;summary?:string;pageText:string;clipped:boolean;utf8:boolean} {
 const stack:{name:string;blocked:boolean}[]=[],text:string[]=[];
 let title:string|undefined,summary:string|undefined,utf8=false,i=0;
 while(i<html.length){
  const blocked=stack.at(-1)?.blocked??false,inHead=stack.some(entry=>entry.name==='head');
  if(html[i]!=='<'||!/[a-z!/?]/i.test(html[i+1]??'')){
   let end=html.indexOf('<',i+1);if(end<0)end=html.length;
   if(!blocked&&!inHead)text.push(decode(html.slice(i,end)));i=end;continue;
  }
  if(html.startsWith('<!--',i)){
   const end=html.indexOf('-->',i+4);if(end<0){if(!truncated)throw unavailable();break;}i=end+3;continue;
  }
  if(/^<!doctype\s/i.test(html.slice(i,i+11))){const end=html.indexOf('>',i+2);if(end<0){if(!truncated)throw unavailable();break;}i=end+1;continue;}
  // CDATA in foreign content is plain data; never parse its markup as tags.
  if(html.startsWith('<![CDATA[',i)&&stack.some(entry=>entry.name==='svg'||entry.name==='math')){
   const end=html.indexOf(']]>',i+9);if(end<0){if(!truncated)throw unavailable();break;}
   if(!blocked&&!inHead)text.push(html.slice(i+9,end));i=end+3;continue;
  }
  const tag=tagAt(html,i,truncated);if(!tag)break;i=tag.end;
  const localName=tag.name.split(':').at(-1)!;
  if(tag.closing){
   const index=stack.findLastIndex(entry=>entry.name===tag.name);
   if(index>=0)stack.length=index;
   continue;
  }
  const skip=blocked||excluded.has(localName)||hidden(tag.attrs);
  if(localName==='meta'&&!skip){
   const charset=tag.attrs.get('charset');
   if(charset!==undefined){if(!/^utf-?8$/i.test(decode(charset,true)))throw unavailable();utf8=true;}
   const equiv=decode(tag.attrs.get('http-equiv')??'',true).toLowerCase();
   if(equiv==='content-type'){
    if(!contentType(decode(tag.attrs.get('content')??'',true)))throw unavailable();utf8=true;
   }
   if(decode(tag.attrs.get('name')??'',true).toLowerCase()==='description'){
    if(summary!==undefined||!tag.attrs.has('content'))throw unavailable();
    summary=normalise(decode(tag.attrs.get('content')!,true));
   }
  }
  if(rawTags.has(localName)){
   // Raw-text closing tags are recognised without interpreting their contents.
   const endTag=new RegExp('</'+tag.name+'\\s*>','ig');endTag.lastIndex=i;const end=endTag.exec(html);
   if(!end){if(!truncated)throw unavailable();break;}
   if(localName==='title'&&!skip&&!stack.some(entry=>['svg','math'].includes(entry.name))){
    if(title!==undefined)throw unavailable();title=normalise(decode(html.slice(i,end.index),true));
   }
   i=endTag.lastIndex;continue;
  }
  // HTML non-void self-closing syntax does not close an element. Only foreign
  // SVG/MathML self-closing syntax is honoured; this keeps hidden/form blocks in.
  const foreign=['svg','math'].includes(localName)||stack.some(entry=>['svg','math'].includes(entry.name));
  if(!voidTags.has(localName)&&!(tag.selfClosing&&foreign)){
   if(stack.length>=128)throw unavailable();stack.push({name:tag.name,blocked:skip});
  }
 }
 const body=normalise(text.join(' ')),pageText=bounded(body,PURPOSE_PAGE_TEXT_BYTES,true);
 const shortTitle=title===undefined?undefined:bounded(title,200),shortSummary=summary===undefined?undefined:bounded(summary,1000);
 return {...(shortTitle===undefined?{}:{title:shortTitle}),...(shortSummary===undefined?{}:{summary:shortSummary}),
  pageText,clipped:pageText!==body||shortTitle!==title||shortSummary!==summary,utf8};
}

/** The worker fences root policy/host permission/current tab/explicit processing
 * consent before calling and again after awaiting. This is not a backend fetch
 * endpoint, crawler, player, classifier, enrollment or authorization mechanism.
 * evidenceId = SHA-256(UTF8(exact canonical URL + NUL) || bounded raw HTML bytes).
 */
export async function producePurposeContent(resource:string,signal:AbortSignal,transport:typeof fetch=fetch):Promise<{
 resource:string;evidenceId:string;title?:string;summary?:string;pageText:string;truncated:boolean;
}> {
 let response:Response|undefined;
 try{
  check(signal);validateResource(resource);
  const pending=transport(resource,{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal});
  // Also dispose an injected/uncooperative transport's late response after abort.
  void pending.then(value=>{if(signal.aborted)cancel(value.body);},()=>{});
  response=await abortable(pending,signal);check(signal);
  if(!response.ok||response.redirected||(response.url&&response.url!==resource))throw unavailable();
  const declared=contentType(response.headers.get('content-type'));
  const {raw,truncated}=await readPrefix(response,signal);check(signal);
  const html=new TextDecoder('utf-8',{fatal:true}).decode(raw,{stream:truncated});
  const result=extract(html,truncated);
  const bom=raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf;
  if(!declared&&!result.utf8&&!bom&&raw.some(byte=>byte>=128))throw unavailable();
  const url=encoder.encode(resource+'\0'),bound=new Uint8Array(url.byteLength+raw.byteLength);
  bound.set(url);bound.set(raw,url.byteLength);
  const digest=await abortable(crypto.subtle.digest('SHA-256',bound),signal);check(signal);
  const evidenceId='static:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return {resource,evidenceId,...(result.title===undefined?{}:{title:result.title}),...(result.summary===undefined?{}:{summary:result.summary}),
   pageText:result.pageText,truncated:truncated||result.clipped};
 }catch{
  if(response&&!response.body?.locked)cancel(response.body);
  throw unavailable();
 }
}
