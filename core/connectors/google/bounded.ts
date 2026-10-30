import { abortRace } from './abort.js';
/** Bound the stream itself, including chunked responses without Content-Length. */
export async function boundedBytes(response:Response,limit:number,signal?:AbortSignal):Promise<Buffer>{
 if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid response byte limit');
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await (signal?abortRace(reader.read(),signal):reader.read());if(done)break;size+=value.byteLength;if(size>limit)throw Error('Google response byte limit exceeded');chunks.push(value);}return Buffer.concat(chunks,size);}
 catch(error){void reader.cancel().catch(()=>{});throw error;}finally{try{reader.releaseLock();}catch{}}
}
export async function boundedJson(response:Response,limit=2*1024*1024,signal?:AbortSignal):Promise<Record<string,any>>{
 const value:unknown=JSON.parse((await boundedBytes(response,limit,signal)).toString('utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Google JSON object');return value as Record<string,any>;
}
export function text(value:unknown):value is string{return typeof value==='string'&&value.length>0;}
