import {PomodoroClient,type TimerTransport} from './client.js';
import {validDurations,type Action} from './protocol.js';
export function mountPomodoro(root:HTMLElement,transport:TimerTransport,signin?:(name:string,password:string,register:boolean)=>Promise<void>){
 root.innerHTML=`<section class="pomodoro" aria-label="Synchronized Pomodoro"><header><p class="eyebrow">SPINDLE · POMODORO</p><h1>Make room for focus.</h1><p>One timer across your desktop, web and extension. Recording stays off.</p></header>
 <form class="signin" hidden><h2>Sign in to Spindle</h2><label>Account <input name="account" autocomplete="username" required pattern="[a-z0-9._-]{3,64}" maxlength="64"></label><label>Password <input name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="256"></label><label class="check"><input name="register" type="checkbox">Create an invented test account</label><button type="submit">Sign in</button></form>
 <p class="account"></p><p class="connection" role="status" aria-live="polite"></p><article><p class="phase">Focus</p><output class="countdown" aria-label="Remaining time">—</output><p class="timer-status">No timer loaded</p><div class="actions"></div></article>
 <fieldset><legend>Phase durations</legend><label>Focus minutes <input class="focus-duration" type="number" min="0.0166666667" max="180" step="any" value="25"></label><label>Break minutes <input class="break-duration" type="number" min="0.0166666667" max="180" step="any" value="5"></label><p class="duration-note">Applied when starting a new focus timer. A finished phase waits for you to start the next.</p></fieldset>
 <footer><button class="refresh">Refresh / reconnect</button><button class="signout">Sign out</button><p class="revision"></p></footer></section>`;
 const element=<T extends HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
 const actions:Record<Action,string>={start:'Start focus',pause:'Pause',resume:'Resume',reset:'Reset',end:'End phase',next:'Start next phase'};
 const buttons=new Map<Action,HTMLButtonElement>();
 for(const [action,title] of Object.entries(actions) as [Action,string][]){const b=document.createElement('button');b.textContent=title;b.dataset.action=action;b.onclick=()=>{
  if(action==='start'){
   const durations={focusMs:Math.round(Number(element<HTMLInputElement>('.focus-duration').value)*60000),breakMs:Math.round(Number(element<HTMLInputElement>('.break-duration').value)*60000)};
   if(!validDurations(durations)){element('.connection').textContent='Choose durations between 1 second and 180 minutes.';return;}
   const edit=durationEdit;
   void client.act(action,durations).then(()=>{const canonical=client.snapshot?.timer.durations;if(edit===durationEdit&&client.fresh&&canonical?.focusMs===durations.focusMs&&canonical.breakMs===durations.breakMs){durationDirty=false;draw();}});
  }else void client.act(action);
 };buttons.set(action,b);element('.actions').append(b);}
 const form=element<HTMLFormElement>('.signin');form.hidden=!signin;
 let signingIn=false,signinError='',durationDirty=false,durationEdit=0,disposed=false;
 for(const selector of ['.focus-duration','.break-duration'])element<HTMLInputElement>(selector).oninput=()=>{durationDirty=true;durationEdit++;draw();};
 const client=new PomodoroClient(transport,draw);
 function draw(){
  if(disposed)return;
  const timer=client.snapshot?.timer,remaining=client.remaining();
  element('.account').textContent=client.account?`Signed in as ${client.account.name}`:'Not signed in';
  element('.connection').textContent=signinError||(!client.fresh&&client.connection==='online'?'Stale — refresh before using controls.':client.message);
  if(!client.account)durationDirty=false;
  if(timer&&!durationDirty){element<HTMLInputElement>('.focus-duration').value=String(timer.durations.focusMs/60000);element<HTMLInputElement>('.break-duration').value=String(timer.durations.breakMs/60000);}
  element('.duration-note').textContent=durationDirty?'Your duration draft applies on the next Start; it has not changed the shared timer.':'Shared durations. Applied on Start; a finished phase waits for you to start the next.';
  element('.connection').dataset.state=client.fresh?'online':client.connection;
  element('.phase').textContent=timer?.phase==='break'?'Break':'Focus';
  const seconds=Math.ceil((remaining??0)/1000);
  element('.countdown').textContent=remaining===undefined?'—':`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
  element('.timer-status').textContent=timer?timer.status==='completed'?'Phase complete — ready when you are.':timer.status==='running'&&remaining===0?'Phase ending — synchronizing…':timer.status:'No timer loaded';
  for(const [action,b] of buttons){b.hidden=!timer||!(action==='start'&&timer.status==='idle'||action==='pause'&&timer.status==='running'||action==='resume'&&timer.status==='paused'||action==='next'&&timer.status==='completed'||action==='end'&&['running','paused'].includes(timer.status)||action==='reset');b.disabled=signingIn||client.pending||!client.fresh;}
  element<HTMLButtonElement>('.signout').disabled=!client.account||signingIn;
  element<HTMLButtonElement>('.refresh').disabled=client.pending||signingIn;
  element('.revision').textContent=timer?`Shared revision ${timer.revision} · ${client.fresh?'up to date':'not confirmed'}`:'';
  form.hidden=!signin||!!client.account;
 }
 form.onsubmit=event=>{event.preventDefault();if(signingIn||!signin)return;const data=new FormData(form);const name=String(data.get('account')??''),password=String(data.get('password')??''),register=data.get('register')==='on';form.reset();signingIn=true;signinError='';draw();
  void signin(name,password,register).then(()=>client.connect()).catch(()=>{signinError='Sign in unavailable. Check your account or connection.';}).finally(()=>{signingIn=false;draw();});
 };
 element('.refresh').onclick=()=>void(client.account?client.refresh():client.connect());element('.signout').onclick=()=>void client.signout();
 const onVisibility=()=>{if(document.visibilityState==='visible'){draw();void client.refresh();}};
 document.addEventListener('visibilitychange',onVisibility);
 const redraw=setInterval(draw,250),poll=setInterval(()=>{if(document.visibilityState==='visible')void client.refresh();},2000);
 void client.connect();
 return {client,dispose(){disposed=true;clearInterval(redraw);clearInterval(poll);document.removeEventListener('visibilitychange',onVisibility);root.replaceChildren();}};
}
