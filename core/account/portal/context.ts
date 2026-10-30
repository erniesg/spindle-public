import type {AccountClient} from '../client.js';

export interface DraftRef {artifactId:string;sha256:string;draftId:string;revision:number}
export type InboxState='detected'|'preparing'|'ready'|'drafting'|'draft_ready'|'sending'|'sent'|'ignored'|'failed';
export interface InboxItem {
 id:string;threadId:string;from:string;subject:string;receivedAt:string;summary:string;state:InboxState;
 preparationTaskId?:string;mailTaskId?:string;draft?:DraftRef;error?:string;sentAt?:string;
}
export interface InboxStatus {watching:boolean;connectionId?:string;googleAccountId?:string;rootId?:string;rootName?:string;items:InboxItem[]}

/** One signed-in shell owns identity and cancellation; views paint only into `main`. */
export interface AppContext {
 main:HTMLElement;
 client:AccountClient;
 signal:AbortSignal;
 /** Same-origin JSON POST with CSRF; rejects on signal abort or account change. */
 api<T=unknown>(path:string,data?:Record<string,unknown>):Promise<T>;
 route:string;
 params:string[];
 go(route:string):void;
 toast(text:string):void;
 /** Update the Today count in the sidebar. */
 setCount(count:number):void;
 /** Called for any error; 401 signs the shell out, everything else is the view's to show. */
 failed(error:unknown):boolean;
}
export type AppView=(context:AppContext)=>(()=>void)|void;

/** Visible polling that pauses while the tab is hidden and stops on abort. */
export function poll(signal:AbortSignal,every:number,run:()=>Promise<void>){
 let timer:ReturnType<typeof setTimeout>|undefined,running=false;
 const tick=async()=>{
  if(signal.aborted)return;timer=undefined;
  if(document.visibilityState==='visible'&&!running){running=true;try{await run();}catch{/* each view reports its own state */}finally{running=false;}}
  if(!signal.aborted)timer=setTimeout(()=>{void tick();},every);
 };
 const visible=()=>{if(document.visibilityState==='visible'&&timer){clearTimeout(timer);void tick();}};
 document.addEventListener('visibilitychange',visible,{signal});
 signal.addEventListener('abort',()=>{if(timer)clearTimeout(timer);},{once:true});
 void tick();
}

/** Blob URLs for prepared artifacts, revoked when the owning view goes away. */
export class ArtifactCache {
 private urls=new Map<string,Promise<{url:string;mimeType:string;size:number}>>();
 constructor(private readonly context:Pick<AppContext,'client'|'signal'>){
  context.signal.addEventListener('abort',()=>{for(const p of this.urls.values())void p.then(v=>URL.revokeObjectURL(v.url),()=>{});this.urls.clear();},{once:true});
 }
 get(taskId:string,artifactId:string){
  const key=taskId+'\0'+artifactId;let found=this.urls.get(key);
  if(!found){
   found=(this.context.client.request('/preparation/artifact',{taskId,artifactId},this.context.signal) as Promise<{bytes:Uint8Array;mimeType:string}>).then(r=>{
    const type=String(r.mimeType).split(';')[0]!.trim();
    return {url:URL.createObjectURL(new Blob([r.bytes as BlobPart],{type})),mimeType:type,size:r.bytes.length};
   });
   found.catch(()=>this.urls.delete(key));this.urls.set(key,found);
  }
  return found;
 }
}
