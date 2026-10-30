import type {AppContext,InboxItem,InboxStatus,DraftRef} from './context.js';
import {poll,ArtifactCache} from './context.js';
import {AccountRequestFailure} from '../client.js';
import {esc,icon,shortTime,clockTime,sender,possessive,bytes} from './ui.js';
import {chips,chipsHtml,costLine,photoPair,pdfs,sourceName,preparationLive,type Prep} from './prep.js';
import {look,MILESTONES,readInbox} from './today.js';

interface Mailbox {address:string;name?:string}
interface MailDraft {
 attachmentsComplete?:boolean;draft:DraftRef;sender?:string;
 content:{to?:Mailbox[];cc?:Mailbox[];subject?:string;text?:string;html?:string};
 attachments?:{artifactId:string;sha256:string;name:string;mimeType?:string;bytes?:number}[];
 send?:{state:string;code?:string}|null;
}
type SendState='idle'|'sending'|'sent'|'uncertain'|'not_sent'|'changed';
const draftKey=(d:DraftRef|undefined)=>d?[d.draftId,d.revision,d.sha256].join(':'):'';
const mailboxes=(list:Mailbox[]|undefined)=>(list??[]).map(m=>m.name?`${m.name} <${m.address}>`:m.address).join(', ');
const plain=(html:string)=>{try{return new DOMParser().parseFromString(html,'text/html').body.textContent??'';}catch{return '';}};
/** Shown whenever the provider outcome is not definitely known. Never claims nothing was sent. */
export const UNCERTAIN_SEND='We couldn’t confirm it was sent. Check your Sent folder before trying again.';

export function mountReview(context:AppContext){
 const {main,signal,api}=context,id=decodeURIComponent(context.params[0]??''),artifacts=new ArtifactCache(context);
 const requestIds=new Map<string,string>(),urls=new Map<string,string>();
 let item:InboxItem|undefined,inbox:InboxStatus|undefined,prep:Prep|undefined,draft:MailDraft|undefined,loadedDraft='',missing=false,error='';
 let sendState:SendState='idle',sentAt:string|undefined,compare=false,citation:string|undefined,preview:string|undefined,progressOpen:boolean|undefined,painted='';
 main.className='main main-workshop';

 const want=(taskId:string|undefined,artifactId:string|undefined)=>{
  if(!taskId||!artifactId)return undefined;const key=taskId+':'+artifactId;
  if(!urls.has(key)){urls.set(key,'');void artifacts.get(taskId,artifactId).then(v=>{if(signal.aborted)return;urls.set(key,v.url);paint();},()=>{urls.delete(key);});}
  return urls.get(key)||undefined;
 };
 function header(){
  const l=look(item!),who=sender(item!.from);
  const status=sendState==='sent'?{label:'Sent',tone:'success'}:sendState==='sending'?{label:'Sending',tone:'working'}:{label:l.label,tone:l.lifecycle==='review'?'review':l.lifecycle==='success'?'success':'working'};
  return `<a class="wk-back" href="#today">← Today</a><header class="wk-heading sp-page-header"><div class="sp-page-heading-copy"><div class="sp-page-title-line"><h1>${esc(item!.subject||'(No subject)')}</h1></div><span class="wk-eyebrow">${esc(who.name)}${who.address&&who.address!==who.name?` · ${esc(who.address)}`:''}</span><p class="wk-trigger">From ${esc(possessive(who.name))} email · ${esc(shortTime(item!.receivedAt))}${item!.summary?`<br><span>${esc(item!.summary)}</span>`:''}</p></div><div class="wk-heading-meta"><span class="wk-status wk-status-${status.tone}" role="status">${esc(status.label)}</span></div></header>`;
 }
 function progress(){
  const l=look(item!),step=sendState==='sent'?MILESTONES.length:l.step,list=chips(prep);
  const open=progressOpen??(step<3);
  return `<details class="wk-progress-block wk-unified-progress" data-wk-progress ${open?'open':''}><summary><span>${Math.min(step,MILESTONES.length)} of ${MILESTONES.length} steps</span><progress class="wk-progress-bar" value="${Math.min(step,MILESTONES.length)}" max="${MILESTONES.length}" aria-label="Progress">${step} of ${MILESTONES.length}</progress></summary><ol class="wk-checklist wk-timeline" aria-label="Progress">${MILESTONES.map((title,i)=>{
   const done=i<step,current=i===step;
   const time=i===0?clockTime(item!.receivedAt):i===4&&(sentAt||item!.sentAt)?clockTime(sentAt??item!.sentAt):'';
   return `<li class="${done?'is-done':current?'is-current':''}"><span class="wk-check" aria-hidden="true">${done?'✓':current?'•':''}</span><div class="wk-step-body"><div class="wk-step-line"><span>${esc(title)}</span>${done&&time?`<time>${esc(time)}</time>`:current&&i<3?'<span class="wk-step-time">Working…</span>':current?'<span class="wk-step-time">Waiting for you</span>':''}</div>${i===1&&list.length?chipsHtml(list):''}</div></li>`;
  }).join('')}</ol></details>`;
 }
 function fields(){
  const list=(prep?.fields??[]).filter(f=>f.label);
  if(!list.length)return '';
  return `<form class="wk-fields-readonly" aria-label="Your details"><dl class="wk-details">${list.map((f,i)=>{
   const fid='rv-'+i,sources=[...new Set(f.citations.map(c=>sourceName(prep,c.sourceId)))],open=citation===f.id;
   return `<div class="wk-detail-row"><dt><label for="${fid}">${esc(f.label)}</label></dt><dd><div class="wk-value-wrap is-editing"><input id="${fid}" type="text" readonly value="${esc(f.value)}" ${f.unresolved?'placeholder="Not found"':''}>${sources.length?`<button type="button" class="wk-source" data-cite="${esc(f.id)}" aria-expanded="${open}" title="${esc(sources.join(', '))}" aria-label="Where this came from"><span aria-hidden="true">*</span></button>`:''}</div>${open?`<section class="wk-citation-preview" role="region" aria-label="Source for ${esc(f.label)}"><div class="wk-citation-top"><span class="wk-citation-source">From</span><button type="button" class="wk-citation-close" data-cite="${esc(f.id)}" aria-label="Close">×</button></div><h4>${esc(sources.join(' · '))}</h4><p class="wk-citation-evidence">${esc(f.label)}: ${esc(f.value)}</p></section>`:''}</dd></div>`;
  }).join('')}</dl></form>`;
 }
 function photo(){
  const pair=photoPair(prep);if(!pair.final||!item?.preparationTaskId)return '';
  const final=want(item.preparationTaskId,pair.final.id),original=pair.original&&compare?want(item.preparationTaskId,pair.original.id):undefined;
  return `<section class="wk-photo-field" aria-labelledby="wk-photo-title"><div class="wk-photo-label"><h3 id="wk-photo-title">Your photo</h3></div><div class="wk-photo-final">${final?`<img src="${esc(final)}" alt="Prepared photo">`:'<span class="sp-img-wait"></span>'}</div><p>Prepared · ${esc(bytes(pair.final.bytes))}</p>${pair.original?`<button type="button" class="wk-link" data-compare aria-expanded="${compare}">${compare?'Hide comparison':'Original &amp; final'}</button>`:''}${compare&&pair.original?`<div class="wk-inline-photo-compare"><div class="wk-photo-compare"><figure><div>${original?`<img src="${esc(original)}" alt="Original photo">`:''}</div><figcaption>Original</figcaption></figure><figure><div>${final?`<img src="${esc(final)}" alt="Prepared photo">`:''}</div><figcaption>Final</figcaption></figure></div></div>`:''}</section>`;
 }
 function files(){
  const list=pdfs(prep);if(!list.length||!item?.preparationTaskId)return '';
  const names=new Map((draft?.attachments??[]).map(a=>[a.artifactId,a.name]));
  return `<section class="sp-review-files" aria-labelledby="rv-files"><div class="wk-section-top"><h2 id="rv-files">Prepared files</h2></div>${list.map(a=>{
   const url=want(item!.preparationTaskId,a.id),name=names.get(a.id)??'Prepared form.pdf',open=preview===a.id;
   return `<div class="sp-file-row"><span class="sp-file-icon" aria-hidden="true">${icon('file',20)}</span><span class="sp-file-name"><strong>${esc(name)}</strong><small>PDF · ${esc(bytes(a.bytes))}</small></span><span class="sp-file-actions"><button type="button" class="wk-link" data-preview="${esc(a.id)}" aria-expanded="${open}">${open?'Hide':'Preview'}</button>${url?`<a class="wk-link" href="${esc(url)}" download="${esc(name)}">Download</a>`:''}</span></div>${open&&url?`<iframe class="sp-pdf-preview" src="${esc(url)}" title="${esc(name)}"></iframe>`:''}`;
  }).join('')}</section>`;
 }
 function email(){
  if(!item?.draft)return item&&['ready','drafting'].includes(item.state)?'<section class="sp-reply"><div class="wk-section-top"><h2>Your reply</h2></div><p class="wk-preparing-note">Writing your reply…</p></section>':'';
  if(!draft)return '<section class="sp-reply"><div class="wk-section-top"><h2>Your reply</h2></div><p class="wk-preparing-note">Loading your reply…</p></section>';
  const c=draft.content,body=c.text??(c.html?plain(c.html):'');
  return `<section class="sp-reply" aria-labelledby="rv-reply"><div class="wk-section-top"><h2 id="rv-reply">Your reply</h2></div><div class="sp-mail"><dl class="sp-mail-head"><div><dt>To</dt><dd>${esc(mailboxes(c.to))}</dd></div>${c.cc?.length?`<div><dt>Cc</dt><dd>${esc(mailboxes(c.cc))}</dd></div>`:''}<div><dt>Subject</dt><dd>${esc(c.subject??'')}</dd></div></dl><div class="sp-mail-body">${esc(body)}</div>${draft.attachments?.length?`<ul class="sp-attachments" aria-label="Attachments">${draft.attachments.map(a=>`<li class="sp-attachment">${icon('file',15)}<span>${esc(a.name)}</span>${a.bytes?`<small>${esc(bytes(a.bytes))}</small>`:''}</li>`).join('')}</ul>`:''}</div></section>`;
 }
 function approval(){
  if(!item)return '';
  const sent=sendState==='sent'||item.state==='sent';
  if(sent){const at=sentAt??item.sentAt;return `<footer class="wk-approval sp-sent"><span class="sp-sent-mark" role="status" tabindex="-1">${icon('check',16)} Sent${at?` at ${esc(clockTime(at))}`:''}</span></footer>`;}
  if(!item.draft||!item.mailTaskId)return '';
  const message=sendState==='uncertain'?UNCERTAIN_SEND:sendState==='not_sent'?'Not sent. Please try again.':sendState==='changed'?'This reply changed. Review the latest version, then send.':`Sends from your Gmail${draft?.sender?` (${esc(draft.sender)})`:''}${draft?.attachments?.length?` with ${draft.attachments.length} file${draft.attachments.length===1?'':'s'}`:''}.`;
  const blocked=sendState==='sending'||!draft||draft.attachmentsComplete===false;
  return `<footer class="wk-approval"><span ${sendState==='uncertain'||sendState==='not_sent'?'class="sp-send-warning" role="alert"':''}>${message}</span><button class="button primary" data-send ${blocked?'disabled':''}>${sendState==='sending'?'Sending…':`Send ${icon('send',15)}`}</button></footer>`;
 }
 function paint(){
  let html:string;
  if(!item){html=`<div class="wk-page"><a class="wk-back" href="#today">← Today</a>${missing?'<p class="sp-quiet">This request is no longer in your inbox.</p>':error?`<p class="ac-error" role="alert">${esc(error)}</p>`:'<p class="sp-quiet" role="status">Loading…</p>'}</div>`;}
  else{
   const preparing=!prep||(!prep.fields?.length&&preparationLive(prep))||['detected','preparing'].includes(item.state)&&!prep.fields?.length;
   const status=sendState==='sent'||item.state==='sent'?'success':item.state==='draft_ready'?'review':'working';
   const cost=costLine(prep);
   const details=fields(),pic=photo();
   html=`<div class="wk-page" data-wk-status="${status}">${header()}${progress()}<div class="wk-content">${error?`<p class="wk-input-note wk-error" role="alert">${esc(error)}</p>`:''}${item.state==='failed'?`<p class="ac-error" role="alert">Spindle couldn’t finish this one. You can still reply from Gmail.</p>`:''}${preparing&&!details?'<p class="wk-preparing-note">The details will appear here as they’re prepared.</p>':`<div class="wk-review-layout"><section class="wk-review-main"><div class="wk-section-top"><h2>Your details</h2><div class="wk-save-meta">${cost?`<span class="sp-cost">${esc(cost)}</span>`:''}</div></div><div class="wk-edit-grid${pic?'':' is-single'}">${details||'<p class="sp-quiet">No details were needed.</p>'}${pic}</div></section></div>`}${files()}${email()}${approval()}</div></div>`;
  }
  if(html===painted)return;painted=html;
  const y=window.scrollY,focused=document.activeElement?.closest?.('[data-send],[data-compare],[data-preview],[data-cite]');
  const focusKey=focused?['data-send','data-compare','data-preview','data-cite'].find(a=>focused.hasAttribute(a)):undefined,focusValue=focusKey?focused!.getAttribute(focusKey):null;
  main.innerHTML=html;window.scrollTo(0,y);
  if(focusKey){const next=main.querySelector<HTMLElement>(focusValue?`[${focusKey}="${CSS.escape(focusValue)}"]`:`[${focusKey}]`)??main.querySelector<HTMLElement>('.sp-sent-mark');next?.focus({preventScroll:true});}
 }
 async function loadDraft(){
  if(!item?.draft||!item.mailTaskId)return;const key=draftKey(item.draft);if(key===loadedDraft&&draft)return;
  const value=await api<MailDraft>('/mail/draft',{taskId:item.mailTaskId,draft:item.draft});
  if(signal.aborted)return;draft=value;loadedDraft=key;
  if(value.send?.state==='sent'&&sendState!=='sent'){sendState='sent';}
 }
 async function refresh(){
  try{
   inbox=await readInbox(context);item=inbox.items.find(i=>i.id===id);missing=!item;error='';
   if(item?.preparationTaskId&&(!prep||preparationLive(prep)||['detected','preparing','ready','drafting'].includes(item.state)))prep=await api<Prep>('/preparation/status',{taskId:item.preparationTaskId});
   if(item?.state==='sent'&&sendState!=='sent'){sendState='sent';sentAt=item.sentAt;}
   await loadDraft();
  }catch(e){if(context.failed(e))return;error='We couldn’t refresh just now. Trying again…';}
  if(!signal.aborted)paint();
 }
 async function send(){
  if(!item?.draft||!item.mailTaskId||sendState==='sending'||sendState==='sent')return;
  const ref=item.draft,key=draftKey(ref);let requestId=requestIds.get(key);if(!requestId){requestId=crypto.randomUUID();requestIds.set(key,requestId);}
  sendState='sending';paint();
  try{
   const status=await api<{drafts?:{draft?:DraftRef;send?:{state:string}|null}[]}>('/mail/send',{taskId:item.mailTaskId,draft:ref,requestId});
   const outcome=status?.drafts?.find(d=>d.draft?.draftId===ref.draftId)?.send;
   if(outcome?.state==='sent'){sendState='sent';sentAt=new Date().toISOString();}
   else if(outcome?.state==='denied'||outcome?.state==='no_send')sendState='not_sent';
   else sendState='uncertain';
  }catch(e){
   if(context.failed(e))return;
   const code=e instanceof AccountRequestFailure?e.code:'';
   // Rejected before any provider call: the draft is stale or incomplete. Everything else is unknown.
   if(code==='MAIL_DRAFT_NOT_CURRENT'||code==='MAIL_ATTACHMENT_SELECTION_INCOMPLETE'){sendState='changed';draft=undefined;loadedDraft='';void refresh();}
   else sendState='uncertain';
  }
  paint();
 }
 main.addEventListener('click',event=>{
  const target=(event.target as Element).closest<HTMLElement>('[data-send],[data-cite],[data-compare],[data-preview]');if(!target)return;
  if(target.hasAttribute('data-send')){void send();return;}
  if(target.dataset.cite!==undefined){citation=citation===target.dataset.cite?undefined:target.dataset.cite;}
  else if(target.hasAttribute('data-compare'))compare=!compare;
  else if(target.dataset.preview)preview=preview===target.dataset.preview?undefined:target.dataset.preview;
  paint();
 },{signal});
 main.addEventListener('toggle',event=>{const d=event.target as HTMLElement;if(d.matches?.('[data-wk-progress]'))progressOpen=(d as HTMLDetailsElement).open;},{signal,capture:true});
 paint();
 poll(signal,3000,refresh);
}
