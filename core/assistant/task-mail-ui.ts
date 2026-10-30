import type {TaskMailReview,TaskMailReviewPage} from '../agent/mail-host.js';

const text=(tag:string,value:string)=>{const node=document.createElement(tag);node.textContent=value;return node;};
/** Read-only saved bytes. No send, approval, correction, continuation or model call. */
export function createTaskMailReview(token:string){
 const element=document.createElement('section');element.id='task-mail-review';element.hidden=true;
 element.append(text('h3','Email drafts saved locally'),text('p','Read-only saved drafts, including partial or blocked work. Opening or refreshing this view does not run the model or authorize sending.'));
 const status=text('p',''),refresh=text('button','Refresh saved drafts') as HTMLButtonElement,content=document.createElement('div');
 const first=text('button','First saved draft') as HTMLButtonElement,next=text('button','Next saved draft') as HTMLButtonElement;first.type=next.type=refresh.type='button';first.hidden=next.hidden=true;
 status.setAttribute('role','status');element.append(status,refresh,first,next,content);
 let taskId='',key='',revision=0,hasSavedView=false,after='',nextAfter:string|undefined;
 const addresses=(values:{address:string;name?:string}[])=>values.map(v=>v.name?`${v.name} <${v.address}>`:v.address).join(', ');
 function row(view:TaskMailReview){
  const article=document.createElement('article');article.className='mail-draft';
  article.append(text('h4',view.state==='available'?view.record.content.subject||'(No subject)':'Saved draft unavailable'),text('p',`Local draft · revision ${view.draft.revision}`));
  if(view.state==='available'){
   const record=view.record;article.append(text('p',`From: ${record.sender??record.accountId}`),text('p',`To: ${addresses(record.content.to)}`));
   if(record.content.cc?.length)article.append(text('p',`Cc: ${addresses(record.content.cc)}`));
   if(record.content.bcc?.length)article.append(text('p',`Bcc: ${addresses(record.content.bcc)}`));
   if(record.content.text!==undefined)article.append(text('h5','Message'),text('pre',record.content.text));
   if(record.content.html!==undefined){const html=document.createElement('details');html.append(text('summary','HTML alternative (shown as text, not executed)'),text('pre',record.content.html));article.append(html);}
   article.append(text('h5','Attachments'));
   const files=document.createElement('ul');for(const file of record.attachments)files.append(text('li',`${file.name} · ${file.mimeType} · ${file.bytes} bytes`));article.append(record.attachments.length?files:text('p','No attachments.'));
   const details=document.createElement('details');details.append(text('summary','Saved version and source details'),text('pre',JSON.stringify({createdAt:record.createdAt,draft:view.draft,mime:record.mime,attachments:record.attachments,sourceIds:record.provenanceIds},null,2)));article.append(details);
  }else article.append(text('p','This saved draft could not be verified. No replacement or model retry was made; other valid drafts remain available.'));
  article.append(text('h5','Recorded send status'));
  if(!view.sends.length)article.append(text('p','No send has been recorded.'));
  for(const send of view.sends){
   const outcome=send.outcome,message=outcome===null?'Result not observed — reconciliation needed.':outcome.state==='uncertain'?'Unknown send result — do not retry.':outcome.state==='sent'?'Provider acknowledged this message; recipient delivery is not established.':outcome.state==='no_send'?'Provider rejected this attempt; no automatic retry.':'Send denied.';
   article.append(text('p',`Draft revision ${send.draft.revision}: ${message}`));
  }
  return article;
 }
 async function load(cursor=after){
  if(!taskId)return;const selected=taskId,request=++revision;refresh.disabled=first.disabled=next.disabled=true;status.textContent='Loading saved drafts…';
  try{
   const response=await fetch(`/api/task-mail?taskId=${encodeURIComponent(selected)}${cursor?'&after='+encodeURIComponent(cursor):''}`,{headers:{Authorization:`Bearer ${token}`}});
   if(request!==revision||selected!==taskId)return;
   if(response.status===404){element.hidden=true;content.replaceChildren();hasSavedView=false;return;}
   if(!response.ok)throw Error('Saved draft review unavailable.');
   const page=await response.json() as TaskMailReviewPage,views=page.drafts;
   if(request!==revision||selected!==taskId)return;
   element.hidden=false;content.replaceChildren(...views.map(row));hasSavedView=true;after=cursor;nextAfter=page.next;first.hidden=!after;next.hidden=!nextAfter;status.textContent=views.length?'Saved immutable revisions; task status and uncertainty are unchanged.':'No saved email draft yet. Ready is not required; refresh after work is retained.';
  }catch{if(request===revision&&selected===taskId){element.hidden=false;status.textContent=hasSavedView?'Could not refresh. The displayed saved copy has not been updated.':'Saved draft review unavailable. Reopen the private worker link or try refreshing.';}}
  finally{if(request===revision)refresh.disabled=first.disabled=next.disabled=false;}
 }
 refresh.onclick=()=>void load();first.onclick=()=>void load('');next.onclick=()=>{if(nextAfter)void load(nextAfter);};
 return {element,select(id:string,stateKey:string){const selectionKey=id+'\0'+stateKey;if(selectionKey===key)return;key=selectionKey;if(taskId!==id){revision++;content.replaceChildren();hasSavedView=false;after='';nextAfter=undefined;first.hidden=next.hidden=true;}taskId=id;void load();}};
}
