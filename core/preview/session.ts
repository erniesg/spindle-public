// PREVIEW v1: one native event clock owns visits. Browser enrichment is challenge-bound;
// no subtraction across producer clocks, no inference/attention/time multiplication.
import { createHash, randomUUID } from 'node:crypto';
export type PreviewChange={kind:'gap'|'focus';at:number};
export interface Options { pixels: boolean; rich: boolean; retain: boolean }
export interface CaptureDetails { pixels:string; ocr:string; image:string; sourceWidth:number; sourceHeight:number; imageWidth:number; imageHeight:number; ocrWidth:number; ocrHeight:number }
export interface PreviewVisit { id:string; key:string; app:string; title:string; start:number; end:number|null; clock:string; revision:number; browser:boolean; text:string; textSource:string; url:string; image:string; imageRevision?:number; imageAvailable?:boolean; capture?:CaptureDetails; availability:string; imageSampledAt?:number; imageExpiresAt?:number; sampledAt:number; framePTS:number|null; expiresAt:number }
const obj=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const num=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const str=(x:unknown,max:number):x is string=>typeof x==='string'&&x.length<=max;
export class PreviewSession {
  readonly schema='spindle-capture-preview/v1';
  private listeners=new Set<(change?:PreviewChange)=>void>();
  subscribe(listener:(change?:PreviewChange)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private changed(change?:PreviewChange){for(const listener of this.listeners)listener(change);}
  private evictImage(v:PreviewVisit){if(v.image){v.image='';v.imageAvailable=true;if(v.capture)v.capture={...v.capture,image:'image-evicted',imageWidth:0,imageHeight:0};}}
  private imageDigests=new Map<string,string>();
  private setImage(v:PreviewVisit,image:string){
    const digest=image?createHash('sha256').update(image).digest('hex'):undefined;
    const changed=digest?this.imageDigests.get(v.id)!==digest:v.imageAvailable===true;
    v.imageAvailable=image.length>0;
    if(!image){this.imageDigests.delete(v.id);delete v.imageSampledAt;delete v.imageExpiresAt;if(v.capture?.image.startsWith('image-retained'))v.capture={...v.capture,image:'image-evicted',imageWidth:0,imageHeight:0};}
    else {for(const id of this.imageDigests.keys())if(!this.visits.some(x=>x.id===id))this.imageDigests.delete(id);this.imageDigests.set(v.id,digest!);}
    v.image=image;if(changed)v.imageRevision=(v.imageRevision??0)+1;
    return changed;
  }
  private invalidateContext(v:PreviewVisit){v.title='';v.text='';v.url='';v.textSource='unavailable';v.sampledAt=v.start;v.framePTS=null;this.setImage(v,'');delete v.capture;v.availability='coverage-gap';}
  private closeVisit(v:PreviewVisit,at:number){v.end=at;if(v.sampledAt>at||(v.imageSampledAt??v.sampledAt)>at)this.invalidateContext(v);}
  epoch=0; recording=false; visits:PreviewVisit[]=[]; options:Options={pixels:false,rich:false,retain:false};
  revision=0; lastAt=0; rejected=0; gaps=0; private lifecycle=0;
  get generation(){return this.lifecycle;}
  get active(){return this.visits.at(-1)?.end===null?this.visits.at(-1):undefined;}
  start(options:Options){this.pause(this.lastAt);this.epoch++;this.options={...options};this.recording=true;this.revision=0;this.lifecycle++;this.changed();}
  pause(at=this.lastAt){const v=this.active;if(v)this.closeVisit(v,Math.max(v.start,this.lastAt,at));this.recording=false;this.lifecycle++;this.changed();}
  clear(){this.pause();this.visits=[];this.lastAt=0;this.lifecycle++;this.changed();}
  focus(e:unknown){
    if(!obj(e)||!this.recording||e.epoch!==this.epoch||!num(e.at)||e.at<this.lastAt||!num(e.revision)||e.revision<=this.revision)return false;
    if(e.key!==null&&(!str(e.key,256)||!str(e.app,128)||!str(e.title,256)||!str(e.clock,128)))return false;
    // Browser boundaries are receipt-timed estimates; authoritative native events win.
    const at=e.at;if(this.visits.some(v=>v.start>at||v.end!==null&&v.end>at||v.sampledAt>=at||(v.imageSampledAt??v.sampledAt)>=at))this.lifecycle++;this.visits=this.visits.filter(v=>v.start<=at);for(const v of this.visits){if(v.end!==null&&v.end>at)v.end=at;if(v.sampledAt>=at||(v.imageSampledAt??v.sampledAt)>=at)this.invalidateContext(v);}
    if(this.active)this.active.end=e.at;
    this.lastAt=e.at;this.revision=e.revision;
    if(e.key!==null&&str(e.key,256)&&str(e.app,128)&&str(e.title,256)&&str(e.clock,128)){
      if(this.visits.length>=100)this.visits.shift();
      this.visits.push({id:randomUUID(),key:e.key,app:e.app,title:e.browser===true?'':e.title,start:e.at,end:null,clock:e.clock,revision:e.revision,browser:e.browser===true,text:'',textSource:'unavailable',url:'',image:'',imageRevision:0,imageAvailable:false,sampledAt:e.at,framePTS:null,expiresAt:Date.now()+900000,availability:e.browser===true?'browser-companion-required':'text-pending'});
    }this.changed({kind:'focus',at});return true;
  }
  sample(e:unknown){
    const v=this.active;
    if(!obj(e)||!v||!this.recording||v.browser||e.epoch!==this.epoch||e.revision!==v.revision||!num(e.at)||e.at<v.start||e.at<v.sampledAt){this.rejected++;return false;}
    // Native samples are atomic acquisitions: never combine an old frame/text with
    // a newer partial result (including image-only and denied-image refreshes).
    if(!(this.options.rich&&this.options.retain&&this.options.pixels&&str(e.image,2_800_000)&&/^[A-Za-z0-9+/]*={0,2}$/.test(e.image)))this.setImage(v,'');v.framePTS=null;
    if(!str(e.text,4096)){v.text='';v.textSource='unavailable';}
    v.sampledAt=e.at;v.expiresAt=Date.now()+900000;if(num(e.framePTS))v.framePTS=e.framePTS;
    if(str(e.title,256))v.title=e.title;
    delete v.capture;
    if(obj(e.capture)){
      const c=e.capture,code=(x:unknown):x is string=>str(x,80)&&/^[a-z0-9-]+$/.test(x),dimension=(x:unknown):x is number=>num(x)&&Number.isSafeInteger(x)&&x<=2147483647;
      if(code(c.pixels)&&code(c.ocr)&&code(c.image)&&dimension(c.sourceWidth)&&dimension(c.sourceHeight)&&dimension(c.imageWidth)&&dimension(c.imageHeight)&&dimension(c.ocrWidth)&&dimension(c.ocrHeight))v.capture={pixels:c.pixels,ocr:c.ocr,image:c.image,sourceWidth:c.sourceWidth,sourceHeight:c.sourceHeight,imageWidth:c.imageWidth,imageHeight:c.imageHeight,ocrWidth:c.ocrWidth,ocrHeight:c.ocrHeight};
    }
    if(str(e.text,4096)){v.text=e.text;v.textSource=e.textSource==='ocr'?'ocr':'native';}
    if(str(e.status,80))v.availability=e.status;
    if(this.options.rich&&this.options.retain&&this.options.pixels&&str(e.image,2_800_000)&&/^[A-Za-z0-9+/]*={0,2}$/.test(e.image)){if(this.setImage(v,e.image)){v.imageSampledAt=e.at;v.imageExpiresAt=v.expiresAt;}for(const old of this.visits){if(this.visits.reduce((n,x)=>n+x.image.length,0)<=6_000_000)break;this.evictImage(old);}}
    this.changed();return true;
  }
  gap(at:unknown){
    if(!num(at))return;this.recording=false;this.lifecycle++;this.visits=this.visits.filter(v=>v.start<at);
    for(const v of this.visits){if(v.end===null||v.end>at)v.end=at;if(v.sampledAt>=at||(v.imageSampledAt??v.sampledAt)>=at)this.invalidateContext(v);}
    this.gaps++;this.changed({kind:'gap',at});
  }
  revokeBrowser(){this.lifecycle++;for(const v of this.visits)if(v.browser){v.text='';v.title='';v.url='';this.setImage(v,'');v.textSource='unavailable';v.availability='profile-revoked';}this.changed();}
  challenge(){const v=this.active;return this.recording&&v?.browser?{visit:v.id,epoch:this.epoch,revision:v.revision,lifecycle:this.lifecycle}:null;}
  browser(e:unknown,at=this.lastAt){
    const c=this.challenge(),v=this.active;
    if(!obj(e)||!obj(e.challenge)||!c||!v||JSON.stringify(e.challenge)!==JSON.stringify(c)||e.private!==false||e.focused!==true||!str(e.document,128)||!str(e.url,2048)||!str(e.title,256)||!str(e.text,4096))return false;
    let url:URL;try{url=new URL(e.url);}catch{return false;}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return false;
    // Only the enrolled companion supplies paths; credentials/query/fragment are rejected.
    const resource=url.origin+(url.pathname==='/'?'':url.pathname);
    const doc=`${v.key}/${e.document}`;
    if(v.url&&v.url!==resource||v.textSource.startsWith('dom:')&&v.textSource!==`dom:${doc}`){
      const boundary=Math.max(this.lastAt,v.start,at);this.closeVisit(v,boundary);
      this.visits.push({...v,id:randomUUID(),start:boundary,end:null,text:'',image:'',imageRevision:0,imageAvailable:false});if(this.visits.length>100)this.visits.shift();
    }
    const target=this.active;if(!target)return false;
    const changed=target.url!==resource||target.title!==e.title||target.text!==e.text||target.textSource!==`dom:${doc}`;
    // An unchanged DOM poll is not a fresh screenshot. Preserve its original
    // lifetime; invalidate on genuine context change or expiry, including when
    // bytes were evicted from preview memory but remain in durable history.
    if(changed){this.lifecycle++;}
    if(changed||target.expiresAt<=Date.now()||(target.imageExpiresAt??target.expiresAt)<=Date.now())this.setImage(target,'');
    const hasImage=target.imageAvailable===true;
    if(!hasImage)target.sampledAt=Math.max(target.start,this.lastAt,at);target.url=resource;if(!hasImage)target.expiresAt=Date.now()+900000;target.title=e.title;target.text=e.text;target.textSource=`dom:${doc}`;if(!hasImage)target.availability='browser-receipt-timed-partial';this.changed();return true;
  }
  // The owner supplies receipt time from the active native clock mapping. A
  // focus-event timestamp is not a browser acquisition timestamp.
  browserImage(e:unknown,at:number){
    const v=this.active,c=this.challenge();
    if(!obj(e)||!obj(e.challenge)||!v||!c||!this.options.pixels||!this.options.rich||!this.options.retain||(e.gesture!==true&&e.automatic!==true)||e.private!==false||e.focused!==true||JSON.stringify(e.challenge)!==JSON.stringify(c)||!num(at)||at<v.start||at<v.sampledAt||!str(e.document,128)||v.textSource!==`dom:${v.key}/${e.document}`||e.url!==v.url||!str(e.image,2_800_000)||!/^[A-Za-z0-9+/]+={0,2}$/.test(e.image))return false;
    const png=Buffer.from(e.image,'base64');
    if(png.length<33||png.length>2_000_000||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.toString('ascii',12,16)!=='IHDR'||png.readUInt32BE(16)<1||png.readUInt32BE(16)>2560||png.readUInt32BE(20)<1||png.readUInt32BE(20)>1600)return false;
    if((v.imageExpiresAt??v.expiresAt)<=Date.now())this.setImage(v,'');
    if(this.setImage(v,e.image)){v.imageSampledAt=at;v.imageExpiresAt=Date.now()+900000;}
    v.expiresAt=Math.max(v.expiresAt,v.imageExpiresAt??v.expiresAt);v.availability=e.automatic===true?'browser-automatic-rich-partial':'browser-manual-rich-partial';
    for(const old of this.visits){if(this.visits.reduce((n,x)=>n+x.image.length,0)<=6_000_000)break;this.evictImage(old);}
    this.changed();return true;
  }
  expire(now=Date.now()){this.visits=this.visits.filter(v=>v.end===null||v.expiresAt>now);for(const visit of this.visits)if((visit.imageExpiresAt??visit.expiresAt)<=now)this.setImage(visit,'');const v=this.active;if(v&&v.expiresAt<=now){v.text='';this.setImage(v,'');v.url='';v.title='';v.availability='context-expired';}this.changed();}
  snapshot(){this.expire();return structuredClone({schema:this.schema,generation:this.lifecycle,recording:this.recording,options:this.options,visits:this.visits});}
  feedback(){return {schema:'spindle-preview-feedback/v1',platform:process.platform,arch:process.arch,nativeAcceptance:'not-validated',recording:this.recording,visits:this.visits.length,withText:this.visits.filter(v=>v.text).length,withImage:this.visits.filter(v=>v.image).length,rejected:this.rejected,gaps:this.gaps};}
}
