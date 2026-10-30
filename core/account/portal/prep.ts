import type {PreparationStatus} from '../client.js';
import {esc} from './ui.js';

export type Prep=PreparationStatus&{
 budget?:{limitUsd?:number;reservedUsd?:number;decisionCalls?:number;visionCalls?:number};
 /** Optional ordered tool activity; preferred over the coarse step map when present. */
 timeline?:{id?:string;tool?:string;label?:string;status?:string;state?:string;at?:string;observedAt?:string}[];
 cost?:{usd?:number;steps?:number};
};
type Source={id:string;provider?:string;providerId?:string;mimeType?:string;snapshotArtifactId?:string;name?:string};
export type ChipState='pending'|'running'|'done'|'failed';
export interface Chip {label:string;state:ChipState}

const IMAGES=new Set(['image/png','image/jpeg','image/webp']);
const TOOL_LABELS:Record<string,string>={
 discovery:'Find your files',read:'Read your files',ocr:'Read documents',photo:'Prepare photo',pdfFill:'Fill form',pdfRender:'Check form',draft:'Save draft',driveOutput:'Save to Drive',
 'photo.spec':'Look up spec','photo.lookup_spec':'Look up spec','photo.remove_background':'Remove background','photo.background':'Remove background','photo.retouch':'Retouch','photo.crop':'Crop','photo.check':'Check','photo.validate':'Check',
 'ocr.read':'Read documents','pdf.fill':'Fill form','pdf.render':'Check form','drive.save':'Save to Drive','drive.upload':'Save to Drive','drive.output':'Save to Drive',
};
const ORDER=['discovery','read','ocr','photo','pdfFill','pdfRender','driveOutput'] as const;
const human=(value:string)=>{const text=value.replace(/^[a-z]+[._]/,'').replace(/[._-]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim().toLowerCase();return text?text[0]!.toUpperCase()+text.slice(1):'Step';};
const chipState=(value:string|undefined):ChipState=>value==='ok'||value==='done'||value==='succeeded'||value==='skipped'?'done':value==='running'||value==='in_progress'?'running':value==='failed'||value==='error'||value==='blocked'||value==='needs_input'?'failed':'pending';
export const preparationLive=(p:Prep|undefined)=>p?.execution?.state==='running'||p?.execution?.state==='queued';

/** Tool steps in order. Uses the backend's ordered timeline, then the agent checklist, then the fixed step map. */
export function chips(p:Prep|undefined):Chip[]{
 if(!p)return [];
 if(Array.isArray(p.timeline)&&p.timeline.length){
  const seen=new Map<string,Chip>();
  for(const entry of p.timeline){const key=entry.label??entry.tool??entry.id??'';if(!key)continue;const label=entry.label??TOOL_LABELS[entry.tool??'']??human(entry.tool??entry.id??'');seen.set(label,{label,state:chipState(entry.status??entry.state)});}
  return [...seen.values()];
 }
 const items=p.checklist?.items??[];
 if(items.length)return items.filter(i=>i.state!=='skipped').map(i=>({label:i.title,state:chipState(i.state)}));
 const steps=p.steps??{},live=preparationLive(p);
 return ORDER.filter(key=>steps[key]||live).map(key=>({label:TOOL_LABELS[key]!,state:chipState(steps[key]?.status)}));
}
export function chipsHtml(list:Chip[]){
 if(!list.length)return '';
 return `<div class="sp-tool-chips" role="list" aria-label="Steps">${list.map(c=>`<span role="listitem" class="sp-tool-chip is-${c.state}"><span class="sp-tool-dot" aria-hidden="true"></span>${esc(c.label)}${c.state==='done'?'<span class="sp-sr"> · done</span>':c.state==='running'?'<span class="sp-sr"> · working</span>':''}</span>`).join('')}</div>`;
}
/** "$0.12 · 9 steps" from the recorded model budget; empty when the backend did not report spend. */
export function costLine(p:Prep|undefined){
 if(!p)return '';
 const usd=p.cost?.usd??p.budget?.reservedUsd,steps=p.cost?.steps??chips(p).filter(c=>c.state==='done').length;
 if(typeof usd!=='number'||!Number.isFinite(usd))return '';
 return `$${usd.toFixed(2)}${steps?` · ${steps} step${steps===1?'':'s'}`:''}`;
}
/** Prepared photo (current output) and the original it came from (a source snapshot). */
export function photoPair(p:Prep|undefined){
 if(!p)return {};
 const sources=(p.sources as Source[])??[],snapshots=new Set(sources.map(s=>s.snapshotArtifactId).filter(Boolean));
 const final=p.artifacts.filter(a=>IMAGES.has(a.mimeType)&&!snapshots.has(a.id)&&a.current!==false).at(-1);
 const originalSource=sources.find(s=>IMAGES.has(s.mimeType??'')&&s.snapshotArtifactId);
 return {final,original:originalSource?p.artifacts.find(a=>a.id===originalSource.snapshotArtifactId):undefined,originalName:originalSource?.name};
}
export function pdfs(p:Prep|undefined){
 if(!p)return [];const snapshots=new Set(((p.sources as Source[])??[]).map(s=>s.snapshotArtifactId));
 return p.artifacts.filter(a=>a.mimeType==='application/pdf'&&!snapshots.has(a.id)&&a.current!==false);
}
export function sourceName(p:Prep|undefined,sourceId:string){
 const s=((p?.sources as Source[])??[]).find(x=>x.id===sourceId);
 if(!s)return 'Your files';
 return s.name??(s.provider==='gmail'?'The email':s.provider==='drive'?'Your Drive folder':'Your files');
}
