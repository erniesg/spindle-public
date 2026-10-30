import type {AppContext} from './context.js';
import {PomodoroClient,TimerSessionChanged,type AuthenticatedSnapshot,type TimerTransport} from '../../pomodoro/client.js';
import {validDurations,type Action,type Command,type Durations} from '../../pomodoro/protocol.js';
import {esc,icon} from './ui.js';

/** Lock in: the approved focus timer bound to the account's shared Pomodoro (/pomodoro/read, /pomodoro/command).
 * Every value shown comes from PomodoroClient; commands are never replayed. */
const PRESETS=[25,50,90];
const mmss=(ms:number|undefined)=>{if(ms===undefined)return '--:--';const s=Math.ceil(ms/1000),m=Math.floor(s/60);return `${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};

export function mountLockIn(context:AppContext){
 const {main,signal,client}=context;let failure='';let draft:Durations|undefined;
 main.className='main main-lock-in';
 const classify=(error:unknown):never=>{
  const message=error instanceof Error?error.message:'';
  if(/^(ACCOUNT_HTTP_401|SIGNIN_REQUIRED|ACCOUNT_CHANGED)$/.test(message)){context.failed(error);throw new TimerSessionChanged(message);}
  failure=/^ACCOUNT_HTTP_40[45]$/.test(message)?'unavailable':message==='ACCOUNT_HTTP_409'||message==='ACCOUNT_HTTP_400'?'refused':'offline';throw error;
 };
 const transport:TimerTransport={
  async session(){const a=client.account;if(!a)throw new TimerSessionChanged('SIGNIN_REQUIRED');return {id:a.id,name:a.name};},
  async read(){try{const v=await client.request('/pomodoro/read',{},signal) as AuthenticatedSnapshot;failure='';return v;}catch(e){return classify(e);}},
  async command(command:Command){try{const v=await client.request('/pomodoro/command',command,signal) as AuthenticatedSnapshot;failure='';return v;}catch(e){return classify(e);}},
  async signout(){},
 };
 main.innerHTML=`<div class="li-page"><header class="page-header sp-page-header"><div class="sp-page-heading-copy"><div class="sp-page-title-line"><h1>Lock in</h1></div><p>A moment to focus. A little room to rest.</p></div></header>
<div class="li-workspace"><section class="li-timer" aria-label="Focus timer"><span class="li-eyebrow" role="status" aria-live="polite" data-li-eyebrow>Ready when you are</span>
<div class="li-clock"><svg class="li-timer-ring" viewBox="0 0 300 300" aria-hidden="true"><circle cx="150" cy="150" r="141"></circle><circle class="li-timer-progress" data-li-progress cx="150" cy="150" r="141" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"></circle></svg><strong role="timer" aria-label="Time remaining" data-li-clock>--:--</strong><span data-li-phase>focus</span></div>
<div class="li-timer-actions" data-li-actions></div><p class="li-timer-note" data-li-note></p></section>
<form class="li-config" data-li-form><details class="li-option"><summary><span>Timing</span><span data-li-summary>25 min focus · 5 min break</span></summary><div class="li-option-body"><div class="li-presets" role="group" aria-label="Focus duration presets">${PRESETS.map(n=>`<button type="button" data-li-preset="${n}" aria-pressed="false">${n} min</button>`).join('')}</div><div class="fields-two"><label class="field">Focus · minutes<input name="focusMinutes" type="number" min="1" max="180" step="1" value="25"></label><label class="field">Break · minutes<input name="breakMinutes" type="number" min="1" max="60" step="1" value="5"></label></div><p class="li-helper">Your break starts after focus. When it ends, start again when you’re ready.</p></div></details><p class="li-error" role="alert" data-li-error></p></form></div></div>`;
 const $=<T extends Element=HTMLElement>(s:string)=>main.querySelector<T>(s)! as unknown as T;
 const clock=$('[data-li-clock]'),phase=$('[data-li-phase]'),eyebrow=$('[data-li-eyebrow]'),actions=$('[data-li-actions]'),note=$('[data-li-note]'),summary=$('[data-li-summary]'),errorNode=$('[data-li-error]');
 const ring=$<SVGCircleElement>('[data-li-progress]'),focusInput=$<HTMLInputElement>('input[name=focusMinutes]'),breakInput=$<HTMLInputElement>('input[name=breakMinutes]');
 const timer=new PomodoroClient(transport,()=>draw());let lastActions='';
 const chosen=():Durations=>({focusMs:Math.round(Number(focusInput.value)*60000),breakMs:Math.round(Number(breakInput.value)*60000)});
 function buttonsFor(status:string|undefined):[Action,string,boolean][]{
  switch(status){
   case 'idle':return [['start','Start focus',true]];
   case 'running':return [['pause','Pause',true],['end','End',false]];
   case 'paused':return [['resume','Resume',true],['reset','Reset',false]];
   case 'completed':return [['next','Start next',true],['reset','Reset',false]];
   default:return [];
  }
 }
 function draw(){
  if(signal.aborted)return;
  const t=timer.snapshot?.timer,remaining=timer.remaining();
  const total=t?(t.phase==='break'?t.durations.breakMs:t.durations.focusMs):undefined;
  clock.textContent=t?mmss(t.status==='idle'?(draft?.focusMs??t.durations.focusMs):remaining):'--:--';
  phase.textContent=t?.phase==='break'?'break':'focus';
  const progress=t&&total&&t.status!=='idle'&&remaining!==undefined?Math.max(0,Math.min(1,remaining/total)):0;
  ring.style.strokeDashoffset=String(1-progress);
  eyebrow.textContent=!t?(timer.connection==='syncing'?'Loading…':'Timer unavailable'):t.status==='running'?(t.phase==='break'?'Taking a break':'Locked in'):t.status==='paused'?'Paused':t.status==='completed'?(t.phase==='break'?'Break’s over':'Nice work'):'Ready when you are';
  const list=buttonsFor(t?.status),key=list.map(b=>b[0]).join()+(timer.pending||!timer.fresh?'-busy':'');
  if(key!==lastActions){lastActions=key;actions.innerHTML=list.map(([action,label,primary])=>`<button type="button" class="button ${primary?'primary':''} li-start" data-li-action="${action}" ${timer.pending||!timer.fresh?'disabled':''}>${esc(label)}${action==='start'||action==='next'?` ${icon('arrow',15)}`:''}</button>`).join('');}
  const d=t?.durations;
  note.textContent=t?`${Math.round((d!.breakMs)/60000)} minute break follows automatically.`:'';
  if(t&&!draft){focusInput.value=String(Math.round(d!.focusMs/60000));breakInput.value=String(Math.round(d!.breakMs/60000));}
  summary.textContent=`${focusInput.value} min focus · ${breakInput.value} min break`;
  for(const b of main.querySelectorAll<HTMLButtonElement>('[data-li-preset]'))b.setAttribute('aria-pressed',String(Number(focusInput.value)===Number(b.dataset.liPreset)));
  errorNode.textContent=failure==='unavailable'?'Lock in isn’t available right now.':failure==='refused'?'The timer changed somewhere else. It’s up to date now.':failure==='offline'&&timer.connection!=='online'?'We couldn’t reach your timer. Trying again…':'';
 }
 main.addEventListener('click',event=>{
  const target=(event.target as Element).closest<HTMLElement>('[data-li-action],[data-li-preset]');if(!target)return;
  if(target.dataset.liPreset){focusInput.value=target.dataset.liPreset;draft=chosen();draw();return;}
  const action=target.dataset.liAction as Action;let durations:Durations|undefined;
  if(action==='start'){durations=chosen();if(!validDurations(durations)){errorNode.textContent='Choose between 1 and 180 minutes.';return;}}
  void timer.act(action,durations).then(()=>{if(action==='start')draft=undefined;if(timer.connection==='stale'&&failure==='refused')void timer.refresh();draw();});
 },{signal});
 main.addEventListener('input',()=>{draft=chosen();draw();},{signal});
 const tick=setInterval(draw,250),refresh=setInterval(()=>{if(document.visibilityState==='visible')void timer.refresh();},2000);
 signal.addEventListener('abort',()=>{clearInterval(tick);clearInterval(refresh);void timer.signout();},{once:true});
 void timer.connect();
}
