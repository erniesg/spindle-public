import { EvidenceStore, digest, type Namespace } from '../evidence/store.js';
import { WebReader, boundedOperation } from './web.js';
/** Structural Playwright-compatible seam. Operator owns browser installation/context lifecycle. */
export interface InspectionPage {
 url():string;
 evaluate<T>(fn:()=>T):Promise<T>;
}
export class BrowserPageInspector {
 constructor(private readonly store:EvidenceStore,private readonly trusted:WebReader,private readonly timeoutMs=15000){}
 async inspect(page:InspectionPage,reference:string,ns:Namespace,signal?:AbortSignal){
 signal?.throwIfAborted();const expected=this.trusted.resolve(reference);const before=page.url();
 // Identity is never sliced into a different destination (including path/query).
 if(before.length>8192||expected.length>8192)throw new Error('Oversized browser URL identity');
 if(new URL(before).href!==new URL(expected).href)throw new Error('Browser destination changed');
 const observed=await boundedOperation(()=>page.evaluate(()=>{
 // All extraction budgets apply in the page, before Playwright serializes a result.
 // DOM-owned strings already exist: attributes are length-checked immediately, never
 // split/trimmed/concatenated first. Text is read in small CharacterData chunks.
 const limits={value:2048,text:100000,nodes:20000,fields:500,related:32,options:500,material:512000};
 let remaining=limits.material,visited=0;
 const incomplete=():never=>{throw new Error('Incomplete requirements scan: extraction budget limit exceeded');};
 const charge=(bytes:number)=>{if(bytes>remaining)incomplete();remaining-=bytes;};
 const visit=()=>{if(++visited>limits.nodes)incomplete();};
 // Six bytes per UTF-16 unit covers JSON escapes/UTF-8; fixed container charges
 // cover keys, punctuation, booleans and numbers. Also charge temporary text/attrs.
 const value=(raw:string,identity=false)=>{
 if(raw.length>limits.value){if(identity)throw new Error('Oversized field identity');incomplete();}
 charge(6*raw.length+8);return raw;
 };
 const attr=(el:Element,name:string,identity=false)=>{const raw=el.getAttribute(name);return raw===null?null:value(raw,identity);};
 const excluded=(el:Element)=>['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','INPUT','TEXTAREA'].includes(el.tagName);
 // Native editability includes inherited/plaintext-only state and readonly islands.
 // Keep walking editable regions for passwords and visit limits; never read their text.
 const editableText=(node:Text)=>{
 let parent=node.parentElement as Element|null;while(parent&&!(parent instanceof HTMLElement)){visit();parent=parent.parentElement;}
 return parent?.isContentEditable??false;
 };
 // Iterative depth-first walk: no eager NodeList/array of descendants or recursion.
 // One ancestor frame per visited node at most; each auxiliary walk shares the
 // same visit budget as the document scan, so repeated label references are bounded.
 const walk=(root:Node,consume:(node:Node,hidden:boolean)=>void,rendered:boolean)=>{
 const stack:{node:Node;hidden:boolean}[]=[];
 let node:Node|null=root,hidden=false;
 while(node){
 visit();const el=node instanceof Element?node:undefined;
 const style=rendered&&el?getComputedStyle(el):undefined;
 const displayHidden:boolean=hidden||style?.display==='none';
 const visibility=rendered?(style?.visibility??(node.parentElement?getComputedStyle(node.parentElement).visibility:'visible')):'visible';
 consume(node,displayHidden||visibility==='hidden'||visibility==='collapse');
 if(node.firstChild&&!(el&&excluded(el))){stack.push({node,hidden});hidden=displayHidden;node=node.firstChild;continue;}
 while(node!==root&&!node.nextSibling){const parent=stack.pop()!;node=parent.node;hidden=parent.hidden;}
 if(node===root)break;
 node=node.nextSibling;
 }
 };
 const append=(current:string,raw:Text,max:number)=>{
 // Check the node length before even a substring of an oversized value is made.
 if(raw.length>max-current.length)incomplete();
 for(let offset=0;offset<raw.length;offset+=256){
 const count=Math.min(256,raw.length-offset);charge(6*count+8);
 const chunk=raw.substringData(offset,count).replace(/\s+/g,' ');
 if(current.length+chunk.length>max)incomplete();current+=chunk;
 }
 return current;
 };
 const textOf=(root:Node)=>{
 let text='';walk(root,(node,hidden)=>{
 if(node instanceof Text&&!hidden&&!editableText(node)){if(text){if(text.length===limits.value)incomplete();text+=' ';charge(6);}text=append(text,node,limits.value);}
 },false);return text.trim();
 };
 const inspectField=(el:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,index:number)=>{
 charge(512);
 let label='';const labels=el.labels;
 if(labels&&labels.length>limits.related)incomplete();
 for(let i=0;labels&&i<labels.length;i++){
 const part=textOf(labels[i]!);if(label.length+part.length+(label?1:0)>limits.value)incomplete();
 if(label)label+=' ';label+=part;
 }
 let description='';const describedBy=attr(el,'aria-describedby');
 if(describedBy){
 const ids=describedBy.trim().split(/\s+/,limits.related+1);if(ids.length>limits.related)incomplete();
 for(const id of ids){const target=document.getElementById(id);const part=target?textOf(target):'';
 if(description.length+part.length+(description?1:0)>limits.value)incomplete();if(description)description+=' ';description+=part;}
 }
 const options:{value:string;label:string}[]=[];
 if(el instanceof HTMLSelectElement){
 if(el.options.length>limits.options)incomplete();
 for(let i=0;i<el.options.length;i++){
 visit();charge(64);const option=el.options[i]!;
 const optionText=()=>textOf(option).replace(/\s+/g,' ');
 options.push({value:attr(option,'value')??optionText(),label:attr(option,'label')??optionText()});
 }
 }
 return {index,id:attr(el,'id',true)??'',name:attr(el,'name',true)??'',label,type:value(el.type),required:el.required,
 pattern:attr(el,'pattern'),min:attr(el,'min'),max:attr(el,'max'),minLength:attr(el,'minlength'),maxLength:attr(el,'maxlength'),accept:attr(el,'accept'),description,options};
 };
 const url=location.href;if(url.length>8192)throw new Error('Oversized browser URL identity');charge(6*url.length+128);
 let title='',hasTitle=false,text='';const fields:ReturnType<typeof inspectField>[]=[];
 walk(document,(node,hidden)=>{
 if(node instanceof Element){
 if(node.tagName==='TITLE'&&!hasTitle){title=textOf(node);hasTitle=true;}
 if(node instanceof HTMLInputElement||node instanceof HTMLSelectElement||node instanceof HTMLTextAreaElement){
 // Inspect authentication even when hidden. No value/defaultValue is read.
 attr(node,'type');if(node.type==='password')throw new Error('Authentication form requires operator');
 if(!hidden){const rect=node.getBoundingClientRect();if(rect.width||rect.height){
 if(fields.length===limits.fields)incomplete();fields.push(inspectField(node,fields.length));
 }}
 }
 }else if(node instanceof Text&&!hidden&&document.body?.contains(node)&&!editableText(node)){
 if(text){if(text.length===limits.text)incomplete();text+=' ';charge(6);}text=append(text,node,limits.text);
 }
 },true);
 return {url,title,text:text.trim(),fields};
 }),signal,this.timeoutMs);
 signal?.throwIfAborted();if(page.url()!==before||observed.url!==before)throw new Error('Stale browser navigation');
 if(observed.fields.some(f=>f.type==='password'))throw new Error('Authentication form requires operator');
 const bytes=Buffer.from(JSON.stringify(observed));const snapshot=this.store.put(ns,bytes,'application/json',[],{provider:'web',providerId:observed.url,originalUrl:observed.url,providerVersion:digest(bytes)});
 return {observed,...snapshot,limitations:['Visible page text contains attachment/photo/deadline requirements; these are observations, not verified compliance.']};
 }
}
