const form = document.querySelector('form')!;
const status = document.querySelector('output')!;
async function show(): Promise<void> {
 status.textContent='Checking protection and cleanup…';
 // Unknown state must not keep the previous render's version or enabled action.
 policyVersion=undefined;
 (document.querySelector('#pause') as HTMLButtonElement).disabled=true;
 (document.querySelector('#resume') as HTMLButtonElement).disabled=true;
 let result;
 try { result=await chrome.runtime.sendMessage({type:'blocking-status'}); }
 catch { status.textContent='Protection state unknown; reopen controls or Remove policy to recover.'; return; }
 if(!result?.ok || (!result.sitePolicy && !result.absenceVerified)) {
  status.textContent='Cleanup incomplete; protection state unknown. Retry or Remove policy to recover.'; return;
 }
 const {sitePolicy}=result;
 policyVersion=sitePolicy?.pending ? undefined : sitePolicy?.version;
 (document.querySelector('#pause') as HTMLButtonElement).disabled=result.state!=='active' || result.pause?.supported!==true;
 (document.querySelector('#resume') as HTMLButtonElement).disabled=result.state!=='paused';
 if(sitePolicy?.pending) {
  status.textContent='Policy change incomplete; protection may be partial. Retry the chosen policy or Remove policy to recover. Resource overrides are disabled.';
  return;
 }
 const scope=sitePolicy ? `${sitePolicy.host}${sitePolicy.subdomains ? ' and all subdomains' : ' only'}; policy v${sitePolicy.version}` : '';
 if(result.state==='paused') {
  // Display only; the worker's browser alarm owns expiry and this page re-reads on change.
  status.textContent=`Paused: ${scope}. Blocking resumes automatically at ${new Date(sitePolicy.pausedUntil).toLocaleTimeString()} even with this page closed, or Resume now.`;
  return;
 }
 status.textContent = sitePolicy ? `Active: ${scope}; ${sitePolicy.purpose ? `purpose: ${sitePolicy.purpose}` : 'whole-site only; no resource exceptions'}.${result.pause?.supported===true ? '' : ' Pause unsupported in this browser.'}` : 'No site policy active.';
}
let policyVersion:number|undefined;
document.querySelector('#pause')!.addEventListener('click',()=>{
 status.textContent='Pausing…';
 void chrome.runtime.sendMessage({type:'site-pause',version:policyVersion,seconds:Number((document.querySelector('#pause-seconds') as HTMLSelectElement).value)}).then(async result=>{
  await show(); if(!result?.ok) status.textContent+=` Pause failed: ${result?.error}`;
 }).catch(()=>{status.textContent='Pause state unknown; reopen controls.';});
});
document.querySelector('#resume')!.addEventListener('click',()=>{
 status.textContent='Resuming…';
 void chrome.runtime.sendMessage({type:'site-resume',version:policyVersion}).then(async result=>{
  await show(); if(!result?.ok) status.textContent+=` Resume failed: ${result?.error}`;
 }).catch(()=>{status.textContent='Resume state unknown; reopen controls.';});
});
form.addEventListener('submit', event => {
 event.preventDefault();
 const host = (document.querySelector('#host') as HTMLInputElement).value.trim().toLowerCase().replace(/\.$/,'');
 const subdomains = (document.querySelector('#subdomains') as HTMLInputElement).checked;
 if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) { status.textContent = 'Enter a hostname only.'; return; }
 // Called directly in a user gesture; permission applies only to the chosen site.
 void chrome.permissions.request({permissions:['declarativeNetRequestWithHostAccess'], origins:[host,`${host}.`].flatMap(h=>[`http://${subdomains ? '*.' : ''}${h}/*`, `https://${subdomains ? '*.' : ''}${h}/*`])}).then(async granted => {
  if (!granted) { status.textContent = 'Permission declined; unchanged.'; return; }
  const result = await chrome.runtime.sendMessage({type:'site-block',host,subdomains,purpose:(document.querySelector('#purpose') as HTMLInputElement).value});
  await show(); if (!result.ok) status.textContent += ` Control failed: ${result.error}`;
 });
});
document.querySelector('#remove')!.addEventListener('click', () => {
 void chrome.runtime.sendMessage({type:'site-remove'}).then(async result => {
  await show(); if (!result.ok) status.textContent += ` Control failed: ${result.error}`;
 });
});
document.querySelector('#processing-consent')!.addEventListener('change',()=>{
 if(!(document.querySelector('#processing-consent') as HTMLInputElement).checked)void chrome.runtime.sendMessage({type:'purpose-cancel'}).catch(()=>{});
});
document.querySelector('#jev-review')!.addEventListener('click',()=>{
 // Replace historical feedback synchronously: a new click must never appear to
 // have succeeded/failed using the previous request's still-visible result.
 status.textContent='Reviewing the selected resource with Jev; it remains gated until eligibility is confirmed…';
 void(async()=>{
  try{
   const {sitePolicy}=await chrome.storage.local.get('sitePolicy');
   const result=await chrome.runtime.sendMessage({type:'resource-jev',version:sitePolicy?.version,
    resource:(document.querySelector('#resource') as HTMLInputElement).value,
    tabId:Number((document.querySelector('#tab') as HTMLSelectElement).value),seconds:Number((document.querySelector('#seconds') as HTMLInputElement).value),
    processingConsent:(document.querySelector('#processing-consent') as HTMLInputElement).checked});
   status.textContent=result.ok?'Last action: Jev eligibility passed and this resource/tab was admitted. Navigation, expiry or worker restart can re-gate access.':result.error;
  }catch{status.textContent='Jev review unavailable; resource remains gated.';}
 })();
});
document.querySelector('#review')!.addEventListener('click', () => {
 void (async()=>{
  try {
   const {sitePolicy}=await chrome.storage.local.get('sitePolicy');
   const result=await chrome.runtime.sendMessage({type:'resource-review',version:sitePolicy?.version,
    resource:(document.querySelector('#resource') as HTMLInputElement).value,
    tabId:Number((document.querySelector('#tab') as HTMLSelectElement).value),
    seconds:Number((document.querySelector('#seconds') as HTMLInputElement).value),
    override:(document.querySelector('#override') as HTMLInputElement).checked});
   status.textContent=result.ok?'Last action: explicit override applied for this resource and tab. Navigation or expiry can re-gate access.':result.error;
  } catch { status.textContent='Review failed; resource remains gated.'; }
 })();
});
void chrome.tabs.query({}).then(tabs=>{
 const select=document.querySelector('#tab')!;
 for(const tab of tabs) if(!tab.incognito && tab.id!==undefined) {
  const option=document.createElement('option'); option.value=String(tab.id); option.textContent=`Tab ${tab.id}`; select.append(option);
 }
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.sitePolicy) void show();});
void show();
