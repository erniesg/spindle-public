import type {UserMemoryApplication} from '../memory/application.js';
type Status=ReturnType<UserMemoryApplication['status']>;
/** Static forms stay mounted across polls; no credentials/drafts enter browser storage. */
export function bindUserMemory(token:string){
 const el=(id:string)=>document.getElementById(id)!;
 const input=(id:string)=>el(id) as HTMLInputElement;
 const form=(id:string)=>el(id) as HTMLFormElement;
 const text=(tag:string,value:string)=>{const node=document.createElement(tag);node.textContent=value;return node;};
 let epoch=0,identity='',fingerprint='',afterKey='',nextAfter:string|null=null,editing:{key:string;revision:number;resolve?:boolean}|undefined;
 const message=(value:string)=>{el('user-memory-status').textContent=value;};
 async function request(data?:Record<string,unknown>):Promise<Status>{const response=await fetch('/api/user-memory?after='+encodeURIComponent(afterKey),{method:data?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});if(!response.ok)throw Error(response.status===404?'Shared memory is not configured for this launcher.':'Shared memory request failed. Your draft is unchanged; check choices, sign-in or configuration.');return response.json() as Promise<Status>;}
 function render(s:Status){
  form('user-signin').hidden=s.authenticated;el('user-connected').hidden=!s.authenticated;
  const next=s.authenticated?s.account!.id:'';
  if(identity!==next){identity=next;afterKey='';editing=undefined;fingerprint='';form('user-correction').hidden=true;form('user-tell').reset();form('user-choices').reset();if(s.authenticated)for(const key of ['conversation','activity','processing','sync'] as const)input('user-'+key).checked=s.choices[key];}
  if(!s.authenticated){el('user-entries').replaceChildren();el('user-turns').replaceChildren();message('Sign in to view or learn shared memory. Cached memories stay hidden until authentication.');return;}
  message(`${s.account!.name} · ${s.providerConfigured?'Model configured':'Blocked: model not configured'} · ${s.pending} pending · Last sync: ${s.lastSync??'never'}${s.error?' · '+s.error:''}${s.activityError?' · Activity: '+s.activityError:''}`);
  nextAfter=s.nextAfter;el('user-memory-first').hidden=!afterKey;el('user-memory-more').hidden=!nextAfter;
  const hash=JSON.stringify([s.entries,s.turns]);if(hash===fingerprint)return;fingerprint=hash;
  el('user-turns').replaceChildren(...s.turns.map(turn=>{const row=document.createElement('article');row.append(text('p',turn.text??''),text('p',`${turn.state}${turn.error?' · '+turn.error:''}`));if(turn.state!=='cancelled'){const forget=text('button','Forget turn') as HTMLButtonElement;forget.type='button';forget.onclick=()=>void action({action:'forgetConversation',id:turn.id});row.append(forget);}return row;}));
  el('user-entries').replaceChildren(...s.entries.map(entry=>{
   const row=document.createElement('article');row.append(text('h4',entry.key),text('p',entry.deleted?'Forgotten (tombstone)':entry.value??''),text('p',`${entry.origin??'deleted'} · revision ${entry.revision} · ${entry.pending?'pending, not synced':'synced'}`));
   if(entry.conflict){row.append(text('p',`Conflict: server revision ${entry.conflict.revision}. Server value: ${entry.conflict.value??'[forgotten or locally purged]'}. Pending changes have not been applied.`));if(entry.deleted){const retry=text('button','Reapply forget at shown server revision') as HTMLButtonElement;retry.type='button';retry.onclick=()=>void action({action:'retryForget',key:entry.key,revision:entry.conflict!.revision});row.append(retry);}}
   if(!entry.deleted||!entry.pending){
    const correct=text('button',entry.deleted?'Recreate explicitly':entry.conflict?'Review / reapply correction':'Correct') as HTMLButtonElement;correct.type='button';correct.onclick=()=>{editing={key:entry.key,revision:entry.conflict?.revision??entry.revision,resolve:!!entry.conflict};el('user-correcting').textContent='Correcting: '+entry.key;input('user-correction-kind').value=entry.kind??'fact';input('user-correction-value').value=entry.value??'';form('user-correction').hidden=false;input('user-correction-value').focus();};
    const forget=text('button','Forget') as HTMLButtonElement;forget.type='button';forget.onclick=()=>void action({action:'forget',key:entry.key});
    row.append(correct,forget);
    const origin=document.createElement('details');origin.append(text('summary','Origin'));
    for(const source of entry.sources??[])origin.append(text('p',`${source.kind} · ${source.observedAt} · ${source.id}\nExact source quote: ${source.excerpt}`));
    if(!entry.sources?.length)origin.append(text('p','Explicit user correction.'));row.append(origin);
   }
   return row;
  }));
 }
 async function action(data:Record<string,unknown>,success?:()=>void){const generation=++epoch;try{const state=await request(data);if(generation!==epoch)return;render(state);success?.();}catch(e){if(generation===epoch)message((e as Error).message);}}
 form('user-signin').onsubmit=e=>{e.preventDefault();const password=input('user-password').value;input('user-password').value='';void action({action:'signin',name:input('user-name').value,password,register:input('user-register').checked});};
 el('user-signout').onclick=()=>{++epoch;el('user-connected').hidden=true;el('user-entries').replaceChildren();el('user-turns').replaceChildren();void action({action:'signout'});};
 form('user-choices').onsubmit=e=>{e.preventDefault();void action({action:'configure',conversation:input('user-conversation').checked,activity:input('user-activity').checked,processing:input('user-processing').checked,sync:input('user-sync').checked});};
 form('user-tell').onsubmit=e=>{e.preventDefault();const field=input('user-utterance'),value=field.value;void action({action:'conversation',text:value},()=>{if(field.value===value)field.value='';});};
 form('user-correction').onsubmit=e=>{e.preventDefault();if(!editing)return;void action({action:editing.resolve?'resolve':'correct',key:editing.key,revision:editing.revision,kind:input('user-correction-kind').value,value:input('user-correction-value').value},()=>{editing=undefined;form('user-correction').hidden=true;});};
 el('user-correction-cancel').onclick=()=>{editing=undefined;form('user-correction').hidden=true;};
 el('user-memory-more').onclick=()=>{if(nextAfter){afterKey=nextAfter;++epoch;void poll(false);}};
 el('user-memory-first').onclick=()=>{afterKey='';++epoch;void poll(false);};
 el('user-sync-now').onclick=()=>void action({action:'sync'});
 async function poll(schedule=true){const generation=epoch;try{const s=await request();if(generation===epoch)render(s);}catch(e){if(generation===epoch)message((e as Error).message);}finally{if(schedule)setTimeout(()=>void poll(),1000);}}
 void poll();
}
