import {AccountClient,AccountRequestFailure} from '../client.js';
import {brandSvg} from './brand.js';
import {esc,icon,displayName,spaceName} from './ui.js';
import type {AppContext,AppView} from './context.js';
import {mountToday} from './today.js';
import {mountReview} from './review.js';
import {mountConnections} from './connections.js';
import {mountDevices,mountAccount} from './settings.js';
import {mountLockIn} from './lock-in.js';
import {mountAttention} from './attention.js';

/** Spindle web app: the approved design shell over the signed-in account's real APIs. Nothing is seeded. */
const client=new AccountClient(location.origin,fetch,true);
const app=document.getElementById('app')!;
const toastNode=document.getElementById('toast');
let restored=false,controller:AbortController|undefined,shellFor:string|undefined,epoch=0,authAvailable:boolean|undefined,todayCount=0,toastTimer:ReturnType<typeof setTimeout>|undefined;

const views:Record<string,AppView>={
 today:mountToday,review:mountReview,connections:mountConnections,devices:mountDevices,'lock-in':mountLockIn,attention:mountAttention,
 account:context=>mountAccount(context,signOut),
};
const navMain:[string,string,string][]=[['today','Today','today'],['lock-in','Lock in','clock'],['attention','Attention','attention']];
const navBottom:[string,string,string][]=[['devices','Devices','devices'],['connections','Connections','settings']];
const titles:Record<string,string>={today:'Today',review:'Review',connections:'Connections',devices:'Devices','lock-in':'Lock in',attention:'Attention',account:'Account'};

function parse(){
 const raw=location.hash.replace(/^#\/?/,''),[page='',...params]=raw.split('/');
 return {page:page||'today',params};
}
function toast(text:string){
 if(!toastNode)return;toastNode.textContent=text;toastNode.classList.add('visible');
 if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastNode.classList.remove('visible'),3200);
}
const navLink=([route,label,glyph]:[string,string,string],active:string)=>`<a href="#${route}" data-route="${route}" class="nav-item${route===active?' active':''}" ${route===active?'aria-current="page"':''}>${icon(glyph)}<span>${label}</span>${route==='today'?`<span class="nav-count" data-today-count ${todayCount?'':'hidden'}>${todayCount||''}</span>`:''}</a>`;

function renderShell(active:string){
 const name=client.account?.name??'';
 app.innerHTML=`<div class="menu-scrim" data-menu-close></div><div class="app-layout"><aside class="sidebar" id="app-sidebar" aria-label="Spindle navigation"><button type="button" class="icon-button mobile-nav-close" data-menu-close aria-label="Close navigation">${icon('close',16)}</button><a class="brand spindle-brand" href="#today" aria-label="Spindle home" data-spindle-brand="outlined" data-brand-font="classic">${brandSvg}</a><a class="workspace workspace-compact" href="#account"><span class="workspace-label">${esc(spaceName(name))}</span></a><nav class="nav-list" aria-label="Main navigation">${navMain.map(n=>navLink(n,active)).join('')}</nav><div class="sidebar-bottom"><nav class="nav-list" aria-label="Settings">${navBottom.map(n=>navLink(n,active)).join('')}</nav></div></aside>
<div class="app-column"><header class="topbar"><div class="topbar-left"><button class="icon-button mobile-menu" data-menu aria-label="Open navigation" aria-controls="app-sidebar" aria-expanded="false">${icon('menu',17)}</button></div><div class="topbar-actions shell-actions"><a class="ac-shell-account" href="#account">${esc(displayName(name))}</a><button type="button" class="ac-shell-account sp-signout" data-signout>Sign out</button></div></header><main class="main" id="main" tabindex="-1"></main></div></div>`;
 shellFor=client.account?.id;
}
function setActive(active:string){
 for(const link of app.querySelectorAll<HTMLAnchorElement>('.nav-item[data-route]')){const on=link.dataset.route===active||active==='review'&&link.dataset.route==='today';link.classList.toggle('active',on);if(on)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
 closeMenu();
}
function closeMenu(){app.querySelector('.sidebar')?.classList.remove('open');app.querySelector('.menu-scrim')?.classList.remove('open');app.querySelector('[data-menu]')?.setAttribute('aria-expanded','false');}
function setCount(count:number){todayCount=count;const badge=app.querySelector<HTMLElement>('[data-today-count]');if(badge){badge.textContent=count?String(count):'';badge.hidden=!count;}}

const authLost=(error:unknown)=>error instanceof AccountRequestFailure&&error.status===401||/ACCOUNT_HTTP_401|SIGNIN_REQUIRED|ACCOUNT_CHANGED/.test(String(error));
function route(){
 controller?.abort();controller=undefined;
 if(!client.account)return signedOut();
 const {page,params}=parse(),name=Object.hasOwn(views,page)?page:'today';
 if(page==='signin'||page==='signup'){location.replace('#today');return;}
 if(shellFor!==client.account.id||!app.querySelector('#main'))renderShell(name);
 setActive(name);
 document.title=`${titles[name]??'Spindle'} · Spindle`;
 const main=app.querySelector<HTMLElement>('#main')!,active=new AbortController(),owner=client.account.id;controller=active;
 main.replaceChildren();main.removeAttribute('class');main.className='main';
 const context:AppContext={
  main,client,signal:active.signal,route:name,params,
  api:<T>(path:string,data:Record<string,unknown>={})=>client.request(path,data,active.signal) as Promise<T>,
  go:(next:string)=>{location.hash='#'+next;},toast,setCount,
  failed:(error:unknown)=>{
   if(active.signal.aborted||client.account?.id!==owner)return true;
   if(authLost(error)){++epoch;void client.signout().catch(()=>{});signedOut();return true;}
   return false;
  },
 };
 try{views[name]!(context);}catch(error){if(!context.failed(error))main.innerHTML='<p class="ac-error" role="alert">Something went wrong. Please refresh.</p>';}
}

function signedOut(){
 controller?.abort();controller=undefined;shellFor=undefined;setCount(0);
 const signup=parse().page==='signup';
 document.title='Spindle · Make time for what you mean to do.';
 const unavailable=authAvailable===false;
 app.innerHTML=`<div class="app-layout"><main class="main main-signup" id="main" tabindex="-1"><div class="ac-auth"><a class="ac-wordmark spindle-brand" href="#signin" aria-label="Spindle" data-spindle-brand="outlined" data-brand-font="classic">${brandSvg}</a><div class="ac-auth-body"><h1>${signup?'A little space for you.':'Welcome back.'}</h1><p>${signup?'Create your Spindle account.':'Sign in to your space.'}</p>${unavailable?'<p class="ac-error" role="alert">Sign-in isn’t available right now. Please try again soon.</p>':''}<a class="button primary sp-auth-continue" ${unavailable||authAvailable===undefined?'aria-disabled="true"':''} href="/auth/workos/begin" data-auth>${signup?'Create account':'Continue'}</a><p class="ac-auth-switch">${signup?'Already have an account? <a href="#signin">Sign in</a>':'New here? <a href="#signup">Create an account</a>'}</p></div></div></main></div>`;
}
async function signOut(){
 ++epoch;controller?.abort();
 try{await client.signout();}catch{/* the server session may already be gone */}
 location.hash='#signin';signedOut();toast('Signed out.');
}

app.addEventListener('click',event=>{
 const target=event.target as Element;
 if(target.closest('[data-auth][aria-disabled="true"]')){event.preventDefault();return;}
 if(target.closest('[data-signout]')){event.preventDefault();void signOut();return;}
 if(target.closest('[data-menu]')){app.querySelector('.sidebar')?.classList.add('open');app.querySelector('.menu-scrim')?.classList.add('open');app.querySelector('[data-menu]')?.setAttribute('aria-expanded','true');app.querySelector<HTMLElement>('[data-menu-close]')?.focus();return;}
 if(target.closest('[data-menu-close]')){closeMenu();return;}
});
window.addEventListener('hashchange',()=>{if(client.account)route();else signedOut();});
window.addEventListener('pagehide',()=>{controller?.abort();});

void fetch('/auth/workos/config',{credentials:'same-origin',redirect:'error',cache:'no-store'}).then(async response=>{
 if(!response.ok)throw Error();
 const config=await response.json() as {configured?:boolean;clientId?:string;backendOrigin?:string};
 authAvailable=config?.configured===true&&typeof config.clientId==='string'&&!!config.clientId.trim()&&config.backendOrigin===location.origin;
}).catch(()=>{authAvailable=false;}).finally(()=>{if(restored&&!client.account)signedOut();});

const restoring=epoch;
void client.restore().then(()=>{restored=true;if(restoring===epoch)route();},()=>{restored=true;if(restoring===epoch)signedOut();});
