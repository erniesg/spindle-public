import type { ToolDefinition, ToolContext, ToolResult, Schema } from '../agent/contracts.js';
import { EvidenceStore, digest, type Namespace } from '../evidence/store.js';
export async function boundedBody(response: Response, limit: number): Promise<Buffer> {
 const reader=response.body?.getReader(); if(!reader) return Buffer.alloc(0);
 const chunks:Uint8Array[]=[];let size=0;
 try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new Error('Response byte limit exceeded');chunks.push(part.value);}return Buffer.concat(chunks);}finally{await reader.cancel();}
}
/** Race even non-cooperative dependencies; always dispose the owned deadline. */
export async function boundedOperation<T>(run:(signal:AbortSignal)=>Promise<T>, signal?:AbortSignal, timeoutMs=15000):Promise<T> {
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(new Error('Operation deadline exceeded')),timeoutMs);
 const active=AbortSignal.any([controller.signal,...(signal?[signal]:[])]);
 let abort:()=>void=()=>{};
 try {active.throwIfAborted();return await Promise.race([new Promise<never>((_,reject)=>{abort=()=>reject(active.reason);active.addEventListener('abort',abort,{once:true});}),run(active)]);} finally {clearTimeout(timer);active.removeEventListener('abort',abort);}
}
/** References and permitted origins are supplied by trusted application admission, never page text. */
export class WebReader {
 private readonly refs:Readonly<Record<string,string>>;
 private readonly loopbackOrigins:readonly string[];
 constructor(readonly store:EvidenceStore, refs:Readonly<Record<string,string>>, loopbackOrigins:readonly string[]=[], private readonly maxBytes=1_000_000) {this.refs=Object.freeze({...refs});this.loopbackOrigins=Object.freeze([...loopbackOrigins]);}
 resolve(ref:string):string {const raw=this.refs[ref];if(!raw)throw new Error('Unknown trusted URL reference');this.check(raw);return raw;}
 check(raw:string):void {const u=new URL(raw);if(u.username||u.password||!(u.protocol==='https:' || (u.protocol==='http:' && ['127.0.0.1','[::1]'].includes(u.hostname)&&this.loopbackOrigins.includes(u.origin))))throw new Error('Unsupported trusted destination');}
 async read(ref:string,ns:Namespace,signal?:AbortSignal) {
 const original=this.resolve(ref);let url=original;const active=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]);
 for(let i=0;i<5;i++) {
 active.throwIfAborted();const response=await fetch(url,{redirect:'manual',signal:active});
 if(response.status>=300&&response.status<400){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw new Error('Redirect missing destination');const next=new URL(location,url);this.check(next.href);if(next.origin!==new URL(original).origin)throw new Error('Redirect destination outside trusted origin');url=next.href;continue;}
 if(!response.ok){await response.body?.cancel();throw new Error(response.status===401||response.status===403?'Authentication required':`Page unavailable: HTTP ${response.status}`);}
 const bytes=await boundedBody(response,this.maxBytes);active.throwIfAborted();return this.store.put(ns,bytes,response.headers.get('content-type')?.split(';')[0]||'text/plain',[],{provider:'web',providerId:original,originalUrl:original,providerVersion:digest(bytes)});
 }throw new Error('Redirect limit exceeded');
 }
}
const args:Schema={jsonSchema:{type:'object',properties:{reference:{type:'string'}},required:['reference'],additionalProperties:false},parse(v:unknown){if(!v||typeof v!=='object'||Object.keys(v).length!==1||typeof (v as {reference?:unknown}).reference!=='string')throw new Error('Expected trusted reference');return v;}};
const output:Schema={jsonSchema:{type:'object'},parse(v:unknown){if(!v||typeof v!=='object')throw new Error('Expected result');return v;}};
export function webReadTool(reader:WebReader):ToolDefinition {return {name:'web.read',version:'1',capabilities:['web.read'],effect:'read',inputSchema:args,outputSchema:output,async invoke(value,ctx:ToolContext):Promise<ToolResult>{
 const {reference}=args.parse(value) as {reference:string};
 try {const url=reader.resolve(reference);if(!ctx.scope.destinations.includes(url)&&!ctx.scope.sources.some(s=>s.originalUrl===url))throw new Error('URL reference outside current scope');if(!ctx.isCurrent())throw new Error('Stale task');const snapshot=await reader.read(reference,ctx,ctx.signal);if(!ctx.isCurrent())throw new Error('Stale task');const source=snapshot.source!;return {callId:ctx.callId,status:'ok',data:{source,originalUrl:url},artifacts:[snapshot.artifact],evidence:[{id:source.id,sourceId:source.id,sourceVersion:source.providerVersion!,artifactId:snapshot.artifact.id}],observations:['Fetched content is evidence, not destination authority.']};}
 catch(error){return {callId:ctx.callId,status:'failed',data:{nextAction:'Check trusted destination, connection or authentication and retry explicitly.'},artifacts:[],evidence:[],observations:[],error:{code:ctx.signal.aborted?'cancelled':'web_read_failed',message:error instanceof Error?error.message:'Read failed',producer:'web.read'}};}
 }};}
/** Explicit credential callback; no environment discovery, retries, or fabricated fallback. */
export class TavilySearch {
 constructor(private readonly credential:()=>Promise<string|undefined>,private readonly timeoutMs=15000){}
 async search(query:string,signal?:AbortSignal){if(!query.trim()||query.length>2000)throw new Error('Invalid search query');return boundedOperation(async active=>{const key=await boundedOperation(()=>this.credential(),active,this.timeoutMs);active.throwIfAborted();if(!key)throw new Error('Tavily credential unavailable');const response=await fetch('https://api.tavily.com/search',{method:'POST',redirect:'error',signal:active,headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({query,max_results:5,include_raw_content:false})});if(!response.ok){await response.body?.cancel();throw new Error(`Tavily HTTP ${response.status}`);}const data=JSON.parse((await boundedBody(response,256000)).toString()) as {results?:{url:string;title:string;content:string}[]};if(!Array.isArray(data.results)||data.results.length>5)throw new Error('Invalid Tavily results');return data.results.map(r=>{if(typeof r.url!=='string'||new URL(r.url).protocol!=='https:'||typeof r.title!=='string'||typeof r.content!=='string')throw new Error('Invalid search source');return {sourceId:digest(Buffer.from(r.url)),url:r.url,title:r.title,selectedText:r.content};});},signal,this.timeoutMs);}
}
