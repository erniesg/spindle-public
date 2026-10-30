import type {AppContext} from './context.js';
import {esc,icon,bytes,displayName} from './ui.js';
import {accountTabs,pageHeader} from './connections.js';

interface Download {name:string;url:string;platform:string|null;kind:string|null;sizeBytes?:number;sha256?:string}
/** Public same-site download catalogue served by the edge; a missing catalogue falls back to the downloads page. */
export async function readDownloads(signal:AbortSignal):Promise<Download[]>{
 const response=await fetch('/downloads/manifest.json',{credentials:'same-origin',redirect:'error',cache:'no-store',signal});
 if(!response.ok)throw Error('DOWNLOADS_'+response.status);
 const value=await response.json() as {artifacts?:unknown};
 return Array.isArray(value?.artifacts)?(value.artifacts as Download[]).filter(a=>a&&typeof a.name==='string'&&typeof a.url==='string'&&a.url.startsWith('/downloads/')&&!a.url.includes('..')):[];
}

export function mountDevices(context:AppContext){
 const {main,signal}=context;let list:Download[]|undefined;
 main.className='main main-devices';
 const card=(title:string,body:string,platformIcon:string,item:Download|undefined,label:string)=>`<section class="ac-flow sp-device-card"><div class="sp-device-head"><span class="sp-device-icon" aria-hidden="true">${icon(platformIcon,22)}</span><div><h2>${esc(title)}</h2><p>${esc(body)}</p></div></div><div class="ac-actions"><a class="button primary" href="${esc(item?.url??'/downloads/')}" ${item?'download':''}>${icon('download',15)} ${esc(label)}</a>${item?.sizeBytes?`<span class="ac-muted">${esc(bytes(item.sizeBytes))}</span>`:''}</div></section>`;
 const paint=()=>{
  const mac=list?.find(a=>/^mac/i.test(a.platform??'')||/mac/i.test(a.name)&&a.kind==='desktop');
  const chrome=list?.find(a=>a.platform==='chrome'||/chrome/i.test(a.name)&&a.kind==='extension');
  const sums=list?.find(a=>/SHA256SUMS/i.test(a.name));
  main.innerHTML=`<div class="ac-page">${pageHeader('Devices','One space, across your devices.')}${accountTabs('devices')}
${card('Spindle for Mac','Notices where your time goes and helps you lock in. Apple silicon, macOS 15 or later.','devices',mac,'Download for Mac')}
${card('Chrome extension','Keeps distracting sites out of the way while you focus. Works with Spindle for Mac.','external',chrome,'Download for Chrome')}
<p class="ac-muted sp-checksums"><a class="ac-link" href="${esc(sums?.url??'/downloads/')}">Checksums</a> · <a class="ac-link" href="/downloads/">All downloads</a></p></div>`;
 };
 paint();
 void readDownloads(signal).then(v=>{list=v;if(!signal.aborted)paint();},()=>{});
}

export function mountAccount(context:AppContext,signOut:()=>void){
 const {main,signal}=context,name=context.client.account?.name??'';
 main.className='main main-account';
 main.innerHTML=`<div class="ac-page">${pageHeader('Account','Your profile and sign-in.')}${accountTabs('account')}<section class="ac-profile"><div class="ac-avatar" aria-hidden="true">${esc(displayName(name)[0]??'')}</div><div><h2>${esc(displayName(name))}</h2><p>${esc(name)}</p></div><button class="button" data-signout>Sign out</button></section><section class="ac-account-next" data-names><h2>Names on your documents</h2><p>Names Spindle reads from photos are checked against these. A near match is left for you to confirm.</p><form class="sp-folder-form" data-names-form><label for="sp-names">Names<span>As printed, separated by commas.</span></label><div class="sp-folder-row"><input id="sp-names" name="names" autocomplete="off" maxlength="720" spellcheck="false"><button class="button" type="submit">Save</button></div><p class="ac-muted" data-names-status role="status"></p></form></section><section class="ac-account-next"><h2>Make Spindle useful to you</h2><p>Connect Google and choose the folder Spindle can use.</p><a class="button" href="#connections">Manage connections</a></section></div>`;
 main.querySelector('[data-signout]')!.addEventListener('click',signOut,{signal});
 const form=main.querySelector<HTMLFormElement>('[data-names-form]')!,input=form.querySelector<HTMLInputElement>('input')!,status=form.querySelector<HTMLElement>('[data-names-status]')!;
 const show=(v:unknown)=>{const names=(v as {names?:unknown})?.names;if(Array.isArray(names))input.value=names.filter(n=>typeof n==='string').join(', ');};
 void context.client.request('/profile/document-names',{},signal).then(show,()=>{});
 form.addEventListener('submit',e=>{e.preventDefault();status.textContent='Saving…';
  const names=input.value.split(',').map(n=>n.trim()).filter(Boolean);
  context.client.request('/profile/document-names/save',{names},signal).then(v=>{show(v);status.textContent='Saved';},()=>{status.textContent='Use up to 8 names, letters only.';});
 },{signal});
}
