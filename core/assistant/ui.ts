import {bindUserMemory} from './user-memory-ui.js';
import {createTaskMailReview} from './task-mail-ui.js';
import type { Task } from '../agent/contracts.js';
import type { MemoryRecord } from '../memory/store.js';
import type { TaskSummary, TaskView } from './task-view.js';
import { preparationCopy, type PreparationNotice } from '../notifications/events.js';
const key='spindle-preparation-token';
const fragment=location.hash.slice(1);
if(/^[a-f0-9]{64}$/.test(fragment))sessionStorage.setItem(key,fragment);
history.replaceState(null,'',location.pathname+location.search);
const token=sessionStorage.getItem(key)??'';
bindUserMemory(token);
const mailReview=createTaskMailReview(token);
const byId=(id:string)=>document.getElementById(id)!;
const text=(tag:string,value:string)=>{const node=document.createElement(tag);node.textContent=value;return node;};
async function api<T>(path:string,id?:number):Promise<T>{
 const response=await fetch(path,{method:id===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(id===undefined?{}:{'Content-Type':'application/json'})},...(id===undefined?{}:{body:JSON.stringify({id})})});
 if(!response.ok)throw Error('Preview unavailable. Reopen the link from your local worker.');return response.json() as Promise<T>;
}
const labels:Record<Task['status'],string>={working:'Working on preparation',ready:'Preparation needs review',blocked:'Needs your attention',cancelled:'Cancelled'};
const itemLabels={done:'Done',in_progress:'Current',pending:'Next',blocked:'Blocked',skipped:'Skipped'};
let selected=new URLSearchParams(location.search).get('task');
let selectionRevision=0;
const links=new Map<string,HTMLAnchorElement>();
let taskBody:HTMLElement|undefined;let technical:HTMLElement|undefined;let rendered='';
function renderTask(task:TaskView){
 const root=byId('task');
 if(!taskBody||!root.contains(taskBody)){
  rendered='';taskBody=document.createElement('div');const details=document.createElement('details');
  technical=text('pre','');details.append(text('summary','Technical details'),technical);root.replaceChildren(taskBody,details,mailReview.element);
 }
 mailReview.select(task.id,`${task.generation}:${task.status}`);
 // Interactive disclosure stays mounted. Only changed read-only content is reconciled.
 const fingerprint=JSON.stringify(task);
 if(rendered===fingerprint)return;
 rendered=fingerprint;technical!.textContent='Run, budget and revision metadata only. Full raw tool payload viewer is not implemented.\n'+JSON.stringify({run:task.run,budget:task.budget,generation:task.generation,recovery:task.recovery,checklistRevision:task.checklist.revision,applicationRevision:task.applicationRevision},null,2);
 const body=document.createElement('div');body.append(text('h2',task.requestedOutcome),text('p',labels[task.status]));
 body.append(text('h3','Requested outcome'),text('p',task.requestedOutcome),text('h3','Checklist'));
 if(!task.checklist.items.length)body.append(text('p','The checklist will appear after the first inspection.'));
 const list=document.createElement('ul');
 for(const item of task.checklist.items){const row=text('li',`${itemLabels[item.state]} · ${item.title}`);if(item.blocker)row.append(text('p',item.blocker));list.append(row);}body.append(list);
 const nextAction=task.status==='blocked'&&task.blocker?task.blocker:task.nextAction==='Choose next action from observation'?'Continue checking the request.':task.nextAction==='Review prepared result'?'Review the preparation when application review is connected.':task.nextAction;
 body.append(text('h3','Next action'),text('p',nextAction));
 if(task.blocker)body.append(text('h3','What needs attention'),text('p',task.blocker));
 body.append(text('h3','What will prove completion'),text('p','Preparation status is not a validated application or a submitted result. Application review must be connected, and a submitted result must be verified at the destination.'));
 taskBody.replaceChildren(...Array.from(body.childNodes));
}
const shown=new Map<number,{notice:PreparationNotice;node:HTMLElement}>();const acked=new Set<number>();
async function refresh(){
 try {
 const tasks=await api<TaskSummary[]>('/api/tasks');const nav=byId('tasks');
 const ids=new Set(tasks.map(task=>task.id));
 for(const [id,link] of links)if(!ids.has(id)){link.remove();links.delete(id);}
 for(const task of tasks){let link=links.get(task.id);if(!link){link=text('a',task.requestedOutcome) as HTMLAnchorElement;link.href=`/?task=${encodeURIComponent(task.id)}`;link.onclick=e=>{e.preventDefault();const revision=++selectionRevision;selected=task.id;history.replaceState(null,'',link!.href);byId('task').replaceChildren(text('p','Loading current task…'));void api<TaskView>(`/api/tasks/${encodeURIComponent(task.id)}`).then(current=>{if(revision===selectionRevision)renderTask(current);}).catch(()=>{if(revision===selectionRevision)byId('task').replaceChildren(text('p','Task unavailable.'));});};links.set(task.id,link);nav.append(link);}if(link.textContent!==task.requestedOutcome)link.textContent=task.requestedOutcome;}
 const revision=selectionRevision;
 const id=selected??tasks[0]?.id;
 const task=id?await api<TaskView>(`/api/tasks/${encodeURIComponent(id)}`).catch(()=>undefined):undefined;
 // A pending poll cannot undo a newer explicit task selection.
 if(revision===selectionRevision){if(task){selected=task.id;renderTask(task);}else byId('task').replaceChildren(text('p',selected?'Task unavailable.':'No tasks yet.'));}
 const notices=await api<PreparationNotice[]>('/api/notices');
 for(const notice of notices){if(shown.has(notice.id))continue;const node=text('div',preparationCopy[notice.kind]);node.className='notice';const link=text('a','Open task') as HTMLAnchorElement;link.href=notice.deepLink;node.append(document.createTextNode(' '),link);byId('notices').append(node);shown.set(notice.id,{notice,node});}
 // ACK only after a paint opportunity AND visible viewport presentation. Hidden tabs retain delivery.
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 if(document.visibilityState==='visible')for(const [id,{node}] of shown){const rect=node.getBoundingClientRect();if(!acked.has(id)&&rect.bottom>0&&rect.top<innerHeight){await api('/api/ack',id);acked.add(id);}}
 // Bound long-lived DOM/history; acknowledged events remain durable in SQLite, not requeued.
 for(const [id,{node}] of shown)if(shown.size>100&&acked.has(id)){node.remove();shown.delete(id);acked.delete(id);}
 byId('error').textContent='';
 }catch(error){byId('error').textContent=error instanceof Error?error.message:'Preview unavailable.';}
 finally{setTimeout(()=>void refresh(),1000);}
}
// This panel is deliberately independent of task polling: drafts are never reconciled away.
const memoryForm=byId('memory-form') as HTMLFormElement;
const memoryKey=byId('memory-key') as HTMLInputElement;
const memoryKind=byId('memory-kind') as HTMLSelectElement;
const memoryValue=byId('memory-value') as HTMLTextAreaElement;
const memoryMore=byId('memory-more') as HTMLButtonElement;
let memoryAfter='';
const memoryStatus=(value:string)=>{byId('memory-status').textContent=value;};
function memoryRow(record:MemoryRecord):HTMLElement {
 const row=document.createElement('article');
 row.append(text('h3',record.key),text('p',`${record.kind} · ${record.userCorrected?'User entered / corrected':'Model inferred'} · version ${record.version}`),text('p',record.value));
 const correct=text('button','Correct') as HTMLButtonElement;correct.type='button';
 correct.onclick=()=>{memoryKey.value=record.key;memoryKey.readOnly=true;memoryKind.value=record.kind;memoryValue.value=record.value;memoryValue.focus();};
 const details=document.createElement('details');details.append(text('summary','Origin and history'));
 const history=document.createElement('div');const older=text('button','Load older history') as HTMLButtonElement;older.type='button';older.hidden=true;
 let before:number|undefined;let loaded=false;
 const load=async()=>{
  older.disabled=true;
  try {
   const records=await api<MemoryRecord[]>(`/api/memory/history?key=${encodeURIComponent(record.key)}${before===undefined?'':`&before=${before}`}`);
   for(const revision of [...records].reverse())history.append(text('p',`Version ${revision.version} · ${revision.createdAt} · ${revision.userCorrected?'User entered / corrected':'Model inferred'} · ${revision.kind}: ${revision.value}\nSource IDs: ${revision.sourceIds.join(', ')||'None (explicit user entry)'}`));
   before=records[0]?.version;older.hidden=records.length<100||before===1;loaded=true;
  }catch{history.append(text('p','History unavailable. Reload this page to retry.'));}
  finally{older.disabled=false;}
 };
 details.append(text('p','Source IDs identify provenance records, not links to an exact source viewer.'),history,older);
 older.onclick=()=>void load();details.ontoggle=()=>{if(details.open&&!loaded){loaded=true;void load();}};
 row.append(correct,details);return row;
}
async function loadMemory(reset=false){
 memoryMore.disabled=true;
 try {
  const records=await api<MemoryRecord[]>(`/api/memory?after=${encodeURIComponent(reset?'':memoryAfter)}`);
  if(reset)byId('memory-list').replaceChildren();
  for(const record of records)byId('memory-list').append(memoryRow(record));
  memoryAfter=records.at(-1)?.key??memoryAfter;memoryMore.hidden=records.length<50;
  memoryForm.hidden=false;memoryStatus(records.length?'Saved locally in this workspace and account.':'No more saved context.');
 }catch{memoryStatus('Saved context unavailable. Start the preview with an explicit context directory to enable it.');}
 finally{memoryMore.disabled=false;}
}
byId('memory-new').onclick=()=>{memoryForm.reset();memoryKey.readOnly=false;memoryKey.focus();};
memoryMore.onclick=()=>void loadMemory();
memoryForm.onsubmit=event=>{
 event.preventDefault();const submit=memoryForm.querySelector('button[type="submit"]') as HTMLButtonElement;
 submit.disabled=true;
 void (async()=>{
  try {
   const response=await fetch('/api/memory',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({key:memoryKey.value,kind:memoryKind.value,value:memoryValue.value})});
   if(!response.ok)throw Error('Could not save context. Your draft is unchanged. Check the fields or reopen the local link.');
   await loadMemory(true);memoryStatus('Context saved. It grants no preparation or submission permission.');
  }catch(error){memoryStatus(error instanceof Error?error.message:'Could not save context.');}
  finally{submit.disabled=false;}
 })();
};
void loadMemory(true);
void refresh();
