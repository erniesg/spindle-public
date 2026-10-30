import type {AppContext,InboxStatus} from './context.js';
import type {GoogleConnectionStatus,GoogleConnectionStart} from '../google-client.js';
import {esc,icon} from './ui.js';
import {readInbox,readGoogle} from './today.js';

/** Accepts an ordinary Drive folder link (or a bare folder id) and returns the folder id. */
export function driveFolderId(input:string):string|undefined{
 const text=String(input??'').trim();
 if(/^[A-Za-z0-9_-]{10,200}$/.test(text))return text;
 let url:URL;try{url=new URL(text);}catch{return undefined;}
 if(url.protocol!=='https:'||!/(^|\.)drive\.google\.com$/.test(url.hostname))return undefined;
 const match=/\/folders\/([A-Za-z0-9_-]{10,200})/.exec(url.pathname)??(url.searchParams.get('id')?[,url.searchParams.get('id')!]:null);
 return match&&/^[A-Za-z0-9_-]{10,200}$/.test(match[1]!)?match[1]:undefined;
}
export function accountTabs(active:'connections'|'devices'|'account'){
 return `<nav class="ac-tabs sp-tabs" aria-label="Your account"><a href="#account" ${active==='account'?'aria-current="page"':''}>Account</a><a href="#connections" ${active==='connections'?'aria-current="page"':''}>Connections</a><a href="#devices" ${active==='devices'?'aria-current="page"':''}>Devices</a></nav>`;
}
export function pageHeader(title:string,subtitle:string){
 return `<header class="page-header sp-page-header"><div class="sp-page-heading-copy"><div class="sp-page-title-line"><h1>${esc(title)}</h1></div><p class="muted">${esc(subtitle)}</p></div></header>`;
}
const looksLikeEmail=(v:unknown):v is string=>typeof v==='string'&&/^[^\s@]+@[^\s@]+$/.test(v);

export function mountConnections(context:AppContext){
 const {main,signal,api}=context;
 let google:GoogleConnectionStatus|undefined,inbox:InboxStatus|undefined,loaded=false,busy='',notice='',error='',folderName='',folderDraft='',changing=false;
 const returned=context.params[0];
 if(returned==='connected')notice='Google is connected.';
 if(returned==='failed')error='Google wasn’t connected. Please try again.';
 if(returned)history.replaceState(null,'','#connections');
 main.className='main main-connections';

 function googleSection(){
  if(!loaded)return '<section class="ac-google"><p class="sp-quiet" role="status">Loading…</p></section>';
  const head=(detail:string,state:string,attention=false)=>`<div class="ac-provider-head"><span class="ac-google-mark" aria-hidden="true">G</span><div><h2>Google</h2><p>${detail}</p></div><span class="${state==='Not connected'?'ac-neutral':`ac-state${attention?' needs-attention':''}`}">${esc(state)}</span></div>`;
  if(!google||google.status==='disconnected'&&!google.accountId){
   return `<section class="ac-google">${head('Gmail and Drive.','Not connected')}<p>Spindle reads requests in your inbox, prepares files from one Drive folder, and drafts replies for you to send.</p><button class="button primary" data-connect ${busy?'disabled':''}>${busy==='connect'?'Opening Google…':'Connect Google'}</button></section>`;
  }
  const email=looksLikeEmail(google.accountId)?esc(google.accountId):looksLikeEmail(inbox?.googleAccountId)?esc(inbox!.googleAccountId):'Your Google account';
  if(google.status!=='connected'){
   const pending=google.status==='pending';
   return `<section class="ac-google">${head(email,pending?'Not finished':'Needs attention',true)}<div class="ac-error" role="alert"><strong>${pending?'Finish connecting Google':'Reconnect Google to continue'}</strong><p>${pending?'Google didn’t finish connecting.':'Spindle can’t reach this Google account right now.'}</p><button class="button primary" data-connect ${busy?'disabled':''}>${busy==='connect'?'Opening Google…':'Reconnect Google'}</button></div><div class="ac-actions"><button class="ac-link" data-disconnect ${busy?'disabled':''}>Disconnect</button></div></section>`;
  }
  const missing=google.missingGrants?.length>0;
  const root=inbox?.rootId??google.roots?.[0];
  const name=folderName||inbox?.rootName||'';
  const folder=root&&!changing?`<div class="sp-folder-chosen"><span class="ac-verified">✓ ${esc(name||'Folder connected')}</span><button class="ac-link" data-change-folder ${busy?'disabled':''}>Change folder</button></div>${inbox?.watching?'<p class="ac-muted">Spindle is watching your inbox.</p>':''}`
   :`<form class="sp-folder-form" data-folder-form><label for="sp-folder">Drive folder<span>Paste the link to the folder Spindle should use.</span></label><div class="sp-folder-row"><input id="sp-folder" name="folder" type="url" inputmode="url" autocomplete="off" placeholder="https://drive.google.com/drive/folders/…" value="${esc(folderDraft)}" required ${busy?'disabled':''}><button class="button primary" type="submit" ${busy?'disabled':''}>${busy==='folder'?'Checking…':'Use this folder'}</button></div>${root?'<button type="button" class="ac-link" data-cancel-folder>Cancel</button>':''}</form>`;
  return `<section class="ac-google">${head(email,missing?'Needs attention':'Connected',missing)}${missing?`<div class="ac-error" role="alert"><strong>Reconnect Google to finish setup</strong><p>Spindle needs Gmail and Drive together.</p><button class="button primary" data-connect ${busy?'disabled':''}>${busy==='connect'?'Opening Google…':'Reconnect Google'}</button></div>`:'<p class="ac-verified">✓ Gmail and Drive connected</p>'}<h3>Folder</h3>${folder}<div class="ac-actions"><button class="ac-link" data-disconnect ${busy?'disabled':''}>${busy==='disconnect'?'Disconnecting…':'Disconnect'}</button></div></section>`;
 }
 function paint(){
  const y=window.scrollY;
  main.innerHTML=`<div class="ac-page">${pageHeader('Connections','You choose what Spindle can use.')}${accountTabs('connections')}${error?`<p class="ac-error" role="alert">${esc(error)}</p>`:''}${notice?`<p class="ac-notice" role="status">${esc(notice)}</p>`:''}${googleSection()}<div class="ac-device-summary"><h2>Devices</h2><p>Get Spindle for your Mac and Chrome.</p><a class="ac-link" href="#devices">Connect devices</a></div></div>`;
  window.scrollTo(0,y);
 }
 async function load(){
  try{
   google=await readGoogle(context);
   try{inbox=await readInbox(context);}catch(e){if(context.failed(e))return;inbox=undefined;}
   loaded=true;
  }catch(e){if(context.failed(e))return;loaded=true;error='We couldn’t load your connections. Please refresh.';}
  if(!signal.aborted)paint();
 }
 async function act(name:string,run:()=>Promise<void>){
  if(busy)return;busy=name;error='';notice='';paint();
  try{await run();}catch(e){if(context.failed(e))return;error=messageFor(name,e);}
  finally{busy='';}
  if(!signal.aborted)paint();
 }
 function messageFor(name:string,e:unknown){
  const code=String((e as {code?:string})?.code??(e as Error)?.message??'');
  if(name==='folder')return /ROOT|DRIVE|SOURCE|404|403/.test(code)?'That folder couldn’t be opened. Check the link and that it’s in this Google account.':'We couldn’t use that folder. Please try again.';
  if(name==='connect')return /NOT_CONFIGURED|503/.test(code)?'Google isn’t available right now. Please try again later.':'We couldn’t open Google. Please try again.';
  return 'Something went wrong. Please try again.';
 }
 main.addEventListener('click',event=>{
  const target=(event.target as Element).closest<HTMLElement>('[data-connect],[data-disconnect],[data-change-folder],[data-cancel-folder]');if(!target)return;
  if(target.hasAttribute('data-connect'))void act('connect',async()=>{
   const start=await api<GoogleConnectionStart>('/google/begin',google?.id?{connectionId:google.id}:{});
   const url=new URL(start.authorizationUrl);if(url.protocol!=='https:'||url.hostname!=='accounts.google.com')throw Error('GOOGLE_CLIENT_CONFIGURATION');
   location.assign(url.href);await new Promise(()=>{});
  });
  else if(target.hasAttribute('data-disconnect'))void act('disconnect',async()=>{
   await api('/google/disconnect',{connectionId:google!.id});folderName='';notice='Google is disconnected.';await load();
  });
  else if(target.hasAttribute('data-change-folder')){changing=true;paint();main.querySelector<HTMLInputElement>('#sp-folder')?.focus();}
  else if(target.hasAttribute('data-cancel-folder')){changing=false;folderDraft='';paint();}
 },{signal});
 main.addEventListener('submit',event=>{
  const form=(event.target as Element).closest<HTMLFormElement>('[data-folder-form]');if(!form)return;event.preventDefault();
  const input=form.querySelector<HTMLInputElement>('#sp-folder')!;folderDraft=input.value;
  const rootId=driveFolderId(input.value);
  if(!rootId){error='Paste a Google Drive folder link, like drive.google.com/drive/folders/…';notice='';paint();return;}
  void act('folder',async()=>{
   const connectionId=google!.id;
   await api('/google/roots',{connectionId,roots:[rootId]});
   const meta=await api<{name?:string;title?:string;mimeType?:string}>('/google/drive/check',{connectionId,rootId});
   folderName=typeof meta?.name==='string'?meta.name:typeof meta?.title==='string'?meta.title:'';
   try{inbox=await api<InboxStatus>('/inbox/configure',{connectionId,rootId});if(inbox?.rootName)folderName=inbox.rootName;}
   catch(e){if(context.failed(e))return;if(!/ACCOUNT_HTTP_404/.test(String(e)))throw e;}
   google=await readGoogle(context);changing=false;folderDraft='';notice=folderName?`Spindle will use ${folderName}.`:'Folder saved.';
  });
 },{signal});
 paint();void load();
}
