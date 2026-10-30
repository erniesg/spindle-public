import type {AppContext,InboxItem,InboxStatus} from './context.js';
import {poll,ArtifactCache} from './context.js';
import {esc,icon,taskIcon,shortTime,clockTime,longDate,sender,possessive} from './ui.js';
import {chips,chipsHtml,photoPair,type Prep} from './prep.js';
import type {GoogleConnections} from '../google-client.js';

export const MILESTONES=['Read the email','Prepare your files','Write your reply','Your review','Send'];
interface Look {taskState:string;lifecycle:string;tone:string;label:string;icon:string;summary:string;step:number}
/** Consumer wording and card state for one inbox request. */
export function look(item:InboxItem):Look{
 switch(item.state){
  case 'detected':return {taskState:'started',lifecycle:'working',tone:'working',label:'Picked up',icon:'clock',summary:'Spindle picked this up.',step:1};
  case 'preparing':return {taskState:'working',lifecycle:'working',tone:'working',label:'Preparing',icon:'clock',summary:'Preparing your files…',step:1};
  case 'ready':case 'drafting':return {taskState:'working',lifecycle:'working',tone:'working',label:'Writing reply',icon:'clock',summary:'Your files are ready. Writing your reply…',step:2};
  case 'draft_ready':return {taskState:'review',lifecycle:'review',tone:'review',label:'Ready for review',icon:'review',summary:'Your reply and files are ready to review.',step:3};
  case 'sending':return {taskState:'submitting',lifecycle:'working',tone:'working',label:'Sending',icon:'send',summary:'Sending your reply…',step:4};
  case 'sent':return {taskState:'completed',lifecycle:'success',tone:'success',label:'Sent',icon:'check',summary:item.sentAt?`Sent at ${clockTime(item.sentAt)}.`:'Sent.',step:5};
  case 'failed':return {taskState:'error',lifecycle:'error',tone:'attention',label:'Needs attention',icon:'alert',summary:'Spindle couldn’t finish this one. You can still reply from Gmail.',step:1};
  default:return {taskState:'idle',lifecycle:'neutral',tone:'neutral',label:'Set aside',icon:'mail',summary:'Spindle set this aside.',step:0};
 }
}
export function milestonesHtml(step:number,prefix='sp-task'){
 return MILESTONES.map((title,i)=>{
  const done=i<step,current=i===step;
  return `<li class="${done?'is-done':current?'is-current':''}"><span class="${prefix}-step-icon" aria-hidden="true">${done?taskIcon('check'):current?taskIcon('clock'):i+1}</span><span>${esc(title)}</span></li>`;
 }).join('');
}

export interface InboxCardOptions {prep?:Prep;photo?:string;link?:boolean}
export function inboxCard(item:InboxItem,options:InboxCardOptions={}){
 const l=look(item),who=sender(item.from),showChips=['preparing','ready','drafting','draft_ready'].includes(item.state);
 const list=showChips?chips(options.prep):[],done=Math.min(l.step,MILESTONES.length);
 return `<section class="sp-task-card sp-task-card-today" data-task-state="${l.taskState}" data-lifecycle="${l.lifecycle}" data-card-tone="${l.tone}" data-inbox-item="${esc(item.id)}" aria-label="${esc(item.subject)}">
<div class="sp-task-card-top"><span class="sp-task-eyebrow">${esc(who.name)}</span><div class="sp-task-card-meta"><span class="sp-task-lifecycle" role="status">${taskIcon(l.icon)}${esc(l.label)}</span></div></div>
<div class="sp-task-card-body"><div class="sp-task-card-copy"><h3>${esc(item.subject||'(No subject)')}</h3><p class="sp-task-origin">From ${esc(possessive(who.name))} email · ${esc(shortTime(item.receivedAt))}${item.summary?`<br><span>${esc(item.summary)}</span>`:''}</p></div>${options.photo?`<figure class="sp-task-photo"><img src="${esc(options.photo)}" alt="Prepared photo"></figure>`:''}</div>
<div class="sp-task-summary"><div><p>${esc(l.summary)}</p>${chipsHtml(list)}</div></div>
<details class="sp-task-progress"><summary><span>${done} of ${MILESTONES.length} steps</span><progress value="${done}" max="${MILESTONES.length}" aria-label="Progress">${done} of ${MILESTONES.length}</progress>${taskIcon('chevron')}</summary><ol class="sp-task-milestones">${milestonesHtml(l.step)}</ol></details>
${options.link===false?'':`<div class="sp-task-card-actions"><a class="sp-task-action" href="#review/${encodeURIComponent(item.id)}">${item.state==='draft_ready'?'Review and send':item.state==='sent'?'View':'Open'}${taskIcon('arrow')}</a></div>`}
</section>`;
}

/** Shared /inbox/status read: 404 (not deployed yet) reads as "not watching". */
export async function readInbox(context:Pick<AppContext,'api'>):Promise<InboxStatus>{
 try{const value=await context.api<InboxStatus>('/inbox/status',{});return {...value,items:Array.isArray(value?.items)?value.items:[]};}
 catch(error){if(/ACCOUNT_HTTP_404/.test(String(error)))return {watching:false,items:[]};throw error;}
}
export async function readGoogle(context:Pick<AppContext,'api'>){
 const value=await context.api<GoogleConnections>('/google/list',{});
 const list=Array.isArray(value?.connections)?value.connections:[];
 return list.find(c=>c.status==='connected')??list.find(c=>c.status==='pending')??list[0];
}
export const visibleItems=(status:InboxStatus|undefined)=>(status?.items??[]).filter(i=>i.state!=='ignored').sort((a,b)=>String(b.receivedAt).localeCompare(String(a.receivedAt)));

export function mountToday(context:AppContext){
 const {main,signal}=context,artifacts=new ArtifactCache(context);
 const preps=new Map<string,Prep>(),photos=new Map<string,string>();
 let inbox:InboxStatus|undefined,connected:boolean|undefined,error='',painted='';
 main.className='main main-today';
 const paint=()=>{
  const items=visibleItems(inbox);
  context.setCount(items.filter(i=>i.state==='draft_ready').length);
  let body:string;
  if(inbox===undefined&&!error)body='<p class="sp-quiet" role="status">Loading…</p>';
  else if(items.length)body=items.map(item=>inboxCard(item,{prep:item.preparationTaskId?preps.get(item.preparationTaskId):undefined,photo:photos.get(item.id)})).join('');
  else if(connected===false||inbox&&!inbox.watching&&!inbox.connectionId)body=`<section class="sp-empty-state"><span class="sp-empty-mark" aria-hidden="true">${icon('mail',22)}</span><h2>Let Spindle look after requests.</h2><p>Connect Google and choose a folder. Spindle will prepare replies to requests that arrive in your inbox.</p><a class="button primary" href="#connections">Connect Google</a></section>`;
  else if(inbox&&!inbox.watching)body=`<section class="sp-empty-state"><span class="sp-empty-mark" aria-hidden="true">${icon('folder',22)}</span><h2>Choose a folder to finish.</h2><p>Spindle uses the files in one Drive folder to prepare your replies.</p><a class="button primary" href="#connections">Choose folder</a></section>`;
  else body=`<section class="sp-empty-state is-watching"><span class="sp-watch-dot" aria-hidden="true"></span><h2>Spindle is watching your inbox.</h2><p>When a request arrives, it will appear here with your reply ready to review.</p>${inbox?.rootName?`<p class="sp-quiet">Using ${esc(inbox.rootName)}</p>`:''}</section>`;
  const html=`<div class="today-page"><header class="page-header today-header sp-page-header"><div class="sp-page-heading-copy"><div class="sp-page-title-line"><h1>Today</h1></div><p class="today-date"><time datetime="${new Date().toISOString().slice(0,10)}">${esc(longDate())}</time></p></div></header>
${error?`<p class="ac-error" role="alert">${esc(error)}</p>`:''}<div class="today-content">${body}</div></div>`;
  if(html===painted)return;
  const open=new Set([...main.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.closest('[data-inbox-item]')?.getAttribute('data-inbox-item')));
  painted=html;main.innerHTML=html;
  for(const d of main.querySelectorAll<HTMLDetailsElement>('[data-inbox-item] details'))if(open.has(d.closest('[data-inbox-item]')!.getAttribute('data-inbox-item')))d.open=true;
 };
 paint();
 poll(signal,3000,async()=>{
  try{
   inbox=await readInbox(context);error='';
   if(!inbox.watching&&!inbox.connectionId&&connected===undefined){try{connected=(await readGoogle(context))?.status==='connected';}catch{connected=undefined;}}
   const work:Promise<void>[]=[];
   for(const item of visibleItems(inbox)){
    const taskId=item.preparationTaskId;if(!taskId)continue;
    const known=preps.get(taskId),active=['detected','preparing','ready','drafting'].includes(item.state);
    if(!known||active)work.push(context.api<Prep>('/preparation/status',{taskId}).then(p=>{preps.set(taskId,p);}).catch(()=>{}));
   }
   await Promise.all(work);
   for(const item of visibleItems(inbox)){
    if(photos.has(item.id)||!item.preparationTaskId||!['draft_ready','sending','sent'].includes(item.state))continue;
    const final=photoPair(preps.get(item.preparationTaskId)).final;
    if(final)void artifacts.get(item.preparationTaskId,final.id).then(v=>{if(signal.aborted)return;photos.set(item.id,v.url);paint();},()=>{});
   }
  }catch(e){if(context.failed(e))return;error='We couldn’t refresh just now. Trying again…';}
  if(!signal.aborted)paint();
 });
}
