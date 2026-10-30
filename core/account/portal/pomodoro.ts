import type {PortalContext} from './types.js';
import {PomodoroClient,TimerSessionChanged,type AuthenticatedSnapshot,type TimerTransport} from '../../pomodoro/client.js';
import {validDurations,type Action,type Command,type Durations} from '../../pomodoro/protocol.js';
import {createFocusDial} from '../../pomodoro/focus-dial.js';
import {createLifeDial} from '../../ui/life-dial.js';
import {button,setStatus,statusRegion,textField,type StatusState} from '../../ui/dom.js';

/** Why the last request failed. Presentation only; PomodoroClient keeps canonical timer semantics. */
type Failure='conflict'|'rejected'|'uncertain'|'offline'|'session'|'unsupported'|undefined;
const labels:Record<Action,string>={start:'Start focus',pause:'Pause',resume:'Resume',reset:'Reset',end:'End phase',next:'Start next phase'};
const allowed=(action:Action,status:string)=>action==='start'?status==='idle':action==='pause'?status==='running':action==='resume'?status==='paused':action==='next'?status==='completed':action==='end'?status==='running'||status==='paused':true;
const presets=[25,50,90];
/** Presentation tone of the connection badge per view state. */
const tone:Partial<Record<string,StatusState>>={online:'success',loading:'loading',pending:'loading',offline:'error',conflict:'error',uncertain:'error',unsupported:'error','signed-out':'error'};

/**
 * Shared account Pomodoro view. The shell owns identity: this view never signs in/out,
 * persists timer state, starts a timer by itself or replays a command. Reads/commands go
 * only through the shell's AccountClient so cookie/CSRF/origin/account remain authoritative.
 * Presentation is the approved Lock-in focus dial (core/pomodoro/focus-dial.ts) on shared
 * core/ui primitives; every value shown comes from PomodoroClient, never a second clock.
 */
export function mountPomodoro(context:PortalContext):()=>void {
 const {root,client:account,signal}=context,doc=root.ownerDocument;
 if(signal.aborted)return ()=>{};
 let failure:Failure,reported=false,disposed=false,durationDirty=false,durationEdit=0,inputError='';
 const classify=(error:unknown,operation:'read'|'command'):never=>{
  const message=error instanceof Error?error.message:'';
  if(/^(ACCOUNT_HTTP_40[13]|SIGNIN_REQUIRED|ACCOUNT_CHANGED)$/.test(message)){
   failure='session';
   // The shell decides whether to restore or sign out; report once per mount.
   if(!reported&&!disposed){reported=true;context.onError(error);}
   throw new TimerSessionChanged(message);
  }
  // 409/400 are definite server refusals: the command did not apply. Anything else after
  // sending a command may have committed, so it is uncertain and must not be replayed.
  failure=/^ACCOUNT_HTTP_40[45]$/.test(message)?'unsupported':operation==='read'?'offline':message==='ACCOUNT_HTTP_409'?'conflict':message==='ACCOUNT_HTTP_400'?'rejected':'uncertain';
  throw error;
 };
 const transport:TimerTransport={
  async session(){const a=account.account;if(!a)throw new TimerSessionChanged('SIGNIN_REQUIRED');return {id:a.id,name:a.name};},
  async read(){try{const value=await account.request('/pomodoro/read',{},signal) as AuthenticatedSnapshot;failure=undefined;return value;}catch(error){return classify(error,'read');}},
  async command(command:Command){try{const value=await account.request('/pomodoro/command',command,signal) as AuthenticatedSnapshot;failure=undefined;return value;}catch(error){return classify(error,'command');}},
  // Unmount retires only this view; account signout belongs to the shell.
  async signout(){},
 };
 const el=<K extends keyof HTMLElementTagNameMap>(tag:K,className:string,text?:string)=>{const node=doc.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
 const view=el('section','sp-theme pomodoro-view');view.setAttribute('aria-label','Shared Pomodoro timer');
 const heading=el('header','pomodoro-heading'),titles=el('div','pomodoro-titles');
 const connection=statusRegion();connection.className+=' pomodoro-connection';
 titles.append(el('p','pomodoro-eyebrow','Focus timer'),el('h2','pomodoro-title','Pomodoro'));heading.append(titles,connection);
 const who=el('p','pomodoro-account');
 const dial=createFocusDial(doc),face=dial.root,status=el('p','pomodoro-timer-status');
 const actions=el('div','sp-actions pomodoro-actions'),buttons=new Map<Action,HTMLButtonElement>();
 for(const [action,title] of Object.entries(labels) as [Action,string][]){const b=button(title,{variant:action==='start'||action==='next'||action==='pause'||action==='resume'?'primary':action==='reset'?'secondary':'quiet'});b.className+=' pomodoro-action';b.dataset.pomodoroAction=action;b.addEventListener('click',()=>run(action));buttons.set(action,b);actions.append(b);}
 const timing=el('details','pomodoro-timing'),timingSummary=el('summary','pomodoro-timing-summary'),timingValue=el('span','pomodoro-timing-value');timingSummary.append(el('span','pomodoro-timing-label','Timing'),timingValue);
 const durations=el('fieldset','pomodoro-durations'),note=el('p','pomodoro-duration-note');
 const focusField=textField('Focus minutes',{name:'focusMinutes'}),breakField=textField('Break minutes',{name:'breakMinutes'}),focusInput=focusField.input,breakInput=breakField.input;
 focusInput.className+=' pomodoro-focus-minutes';breakInput.className+=' pomodoro-break-minutes';
 const onDuration=()=>{durationDirty=true;durationEdit++;inputError='';draw();};
 for(const input of [focusInput,breakInput]){input.type='number';input.min='0.0166666667';input.max='180';input.step='any';input.addEventListener('input',onDuration);}
 // Presets only edit the same unsaved draft; Start remains the one explicit action that sends durations.
 const presetRow=el('div','fd-presets'),presetButtons=presets.map(n=>{const b=button(`${n} min`);b.addEventListener('click',()=>{focusInput.value=String(n);onDuration();});presetRow.append(b);return {n,b};});
 presetRow.setAttribute('role','group');presetRow.setAttribute('aria-label','Focus duration presets');
 durations.append(el('legend','pomodoro-legend','Durations for the next Start'),focusField.root,breakField.root,note);
 timing.append(timingSummary,presetRow,durations);
 const footer=el('footer','pomodoro-footer'),revision=el('p','pomodoro-revision'),refresh=button('Refresh',{variant:'quiet'});refresh.className+=' pomodoro-refresh';footer.append(revision,refresh);
 const error=statusRegion();error.className+=' pomodoro-error';
 const privacy=el('p','pomodoro-privacy','Timer only: starting it never starts recording, capture or notifications. Every client signed into this account shows the same server timer.');
 const lifeDial=createLifeDial(doc);
 view.append(heading,who,face,actions,status,timing,footer,error,privacy,lifeDial.root);root.replaceChildren(view);
 const timer=new PomodoroClient(transport,draw);
 function run(action:Action){
  if(disposed)return;let chosen:Durations|undefined;
  if(action==='start'){
   chosen={focusMs:Math.round(Number(focusInput.value)*60000),breakMs:Math.round(Number(breakInput.value)*60000)};
   if(!validDurations(chosen)){inputError='Choose durations between 1 second and 180 minutes.';draw();return;}
  }
  inputError='';const edit=durationEdit;
  void timer.act(action,chosen).then(()=>{
   if(disposed)return;
   const shared=timer.snapshot?.timer.durations;if(chosen&&edit===durationEdit&&timer.fresh&&shared?.focusMs===chosen.focusMs&&shared.breakMs===chosen.breakMs)durationDirty=false;
   // A refused command definitely did not apply: reading current state is reconciliation, not replay.
   if(timer.connection==='stale'&&(failure==='conflict'||failure==='rejected'))void timer.refresh();else draw();
  });
 }
 function message(){
  if(timer.connection==='signed-out')return failure==='unsupported'?['unsupported','This account service does not offer the shared timer.']:!account.account||failure==='session'?['signed-out','Your account session ended. Sign in again to use the timer.']:failure==='offline'?['offline','Could not load the shared timer. Refresh to try again.']:['error',timer.message];
  if(timer.connection==='syncing')return ['loading','Loading your shared timer…'];
  if(timer.connection==='stale')return failure==='conflict'?['conflict','Another client changed the timer first. Your action was not applied or replayed; reloading the server timer…']:failure==='rejected'?['conflict','The server refused that action. Nothing was replayed; reloading the server timer…']:failure==='uncertain'?['uncertain','No reply from the server: the action may already have applied. Checking the server timer; the action will not be replayed.']:failure==='unsupported'?['unsupported','This account service does not offer the shared timer.']:['offline','Server unavailable. Showing the last confirmed time; controls stay disabled until a refresh succeeds.'];
  if(timer.pending)return ['pending','Sending to your account…'];
  return timer.fresh?['online','Synchronized with your account']:['stale','Not confirmed recently — refreshing…'];
 }
 function draw(){
  if(disposed)return;
  // Defence in depth: the shell aborts on identity change, but never paint one account's timer under another.
  const owner=account.account,mismatch=!!timer.account&&owner?.id!==timer.account.id,snapshot=mismatch?undefined:timer.snapshot?.timer,remaining=mismatch?undefined:timer.remaining();
  const [state,text]=mismatch?['signed-out','Account changed. Waiting for the portal to reload this view.']:message();
  view.dataset.pomodoroState=state;setStatus(connection,tone[state]??'idle',state==='online'?'Live':state==='pending'?'Sending':state==='loading'?'Loading':state==='unsupported'?'Unavailable':state==='signed-out'?'Signed out':'Not live');connection.dataset.pomodoroState=state;
  const errorText=inputError||(['online','pending','loading','stale'].includes(state)?'':text);setStatus(error,errorText?'error':'idle',errorText);error.hidden=!errorText;
  status.textContent=!snapshot?(state==='loading'?'Loading…':'No timer loaded'):snapshot.status==='completed'?'Phase complete — start the next phase when you are ready.':snapshot.status==='running'&&remaining===0?'Phase ending — confirming with the server…':snapshot.status==='running'?`Running · ${text}`:snapshot.status==='paused'?`Paused · ${text}`:`Ready · ${text}`;
  who.textContent=timer.account&&!mismatch?`Signed in as ${timer.account.name}`:'Not signed in';
  dial.update({phase:snapshot?.phase,status:snapshot?.status,remainingMs:remaining,totalMs:snapshot?(snapshot.phase==='break'?snapshot.durations.breakMs:snapshot.durations.focusMs):undefined});
  view.dataset.pomodoroStatus=snapshot?.status??'none';view.dataset.pomodoroRevision=snapshot?String(snapshot.revision):'';view.dataset.pomodoroSession=snapshot?.sessionId??'';
  if(!snapshot)durationDirty=false;
  if(snapshot&&!durationDirty){focusInput.value=String(snapshot.durations.focusMs/60000);breakInput.value=String(snapshot.durations.breakMs/60000);}
  timingValue.textContent=`${focusInput.value||'—'} min focus · ${breakInput.value||'—'} min break`;
  for(const {n,b} of presetButtons){b.setAttribute('aria-pressed',String(Number(focusInput.value)===n));b.disabled=!snapshot;}
  note.textContent=durationDirty?'Draft: applies on the next Start; the shared timer is unchanged.':'Shared durations for this account. A finished phase waits for you.';
  for(const [action,b] of buttons){b.hidden=!snapshot||!allowed(action,snapshot.status);b.disabled=timer.pending||!timer.fresh||mismatch;}
  focusInput.disabled=breakInput.disabled=!snapshot;
  refresh.disabled=timer.pending||state==='unsupported';
  revision.textContent=snapshot?`${snapshot.sessionId?`Session ${snapshot.sessionId.slice(0,8)} · `:''}revision ${snapshot.revision} · ${timer.fresh?'confirmed':'not confirmed'}`:'';
 }
 refresh.addEventListener('click',()=>{if(!disposed)void(timer.account?timer.refresh():timer.connect());});
 const visible=()=>doc.visibilityState==='visible';
 const onVisibility=()=>{if(visible()){draw();void timer.refresh();}};
 doc.addEventListener('visibilitychange',onVisibility);
 const redraw=setInterval(draw,250),poll=setInterval(()=>{if(visible())void timer.refresh();},2000);
 const dispose=()=>{
  if(disposed)return;disposed=true;clearInterval(redraw);clearInterval(poll);doc.removeEventListener('visibilitychange',onVisibility);signal.removeEventListener('abort',dispose);
  // Bumps the client generation so in-flight replies are discarded; transport signout is a no-op.
  lifeDial.dispose();void timer.signout();root.replaceChildren();
 };
 signal.addEventListener('abort',dispose,{once:true});
 draw();void timer.connect();
 return dispose;
}
