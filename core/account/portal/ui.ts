/** Small browser-only rendering helpers for the approved Spindle app design. Every dynamic value goes through esc(). */
export const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

const paths:Record<string,string>={
 today:'<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>',
 clock:'<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
 attention:'<circle cx="5" cy="12" r="3"></circle><circle cx="17" cy="5" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="m8 10 6-3m-6 7 7 3m2-9 1 7"></path>',
 devices:'<rect x="2" y="4" width="14" height="11" rx="2"></rect><path d="M6 19h6m-3-4v4"></path><rect x="16" y="9" width="6" height="12" rx="2"></rect>',
 settings:'<path d="M4 7h16M4 17h16"></path><circle cx="9" cy="7" r="3" fill="white"></circle><circle cx="15" cy="17" r="3" fill="white"></circle>',
 close:'<path d="m6 6 12 12M18 6 6 18"></path>',
 menu:'<path d="M4 6h16M4 12h16M4 18h16"></path>',
 chevron:'<path d="m6 9 6 6 6-6"></path>',
 arrow:'<path d="M4 12h16m-6-6 6 6-6 6"></path>',
 check:'<path d="m5 12 4 4L19 6"></path>',
 review:'<rect x="5" y="4" width="14" height="17" rx="2"></rect><path d="M9 4V2h6v2M9 10h6M9 14h4"></path>',
 mail:'<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>',
 send:'<path d="M21 3 10 14"></path><path d="m21 3-7 18-4-7-7-4Z"></path>',
 file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"></path><path d="M14 3v6h6"></path>',
 download:'<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"></path>',
 alert:'<circle cx="12" cy="12" r="9"></circle><path d="M12 7v6m0 4h.01"></path>',
 external:'<path d="M14 3h7v7m0-7-11 11M9 4H4v16h16v-5"></path>',
 folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>',
};
export function icon(name:keyof typeof paths|string,size=18,className=''){
 return `<svg${className?` class="${className}"`:''} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??''}</svg>`;
}
/** Task-card icon variant (reference task-card.js uses a heavier stroke and its own class). */
export function taskIcon(name:string){return `<svg class="sp-task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??''}</svg>`;}

export function shortTime(value:string|number|undefined){
 if(value===undefined||value==='')return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
 return date.toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false});
}
export function clockTime(value:string|number|undefined){
 if(value===undefined||value==='')return '';const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
 return date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
}
export function longDate(date=new Date()){return date.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});}

/** "Harbour Arts <hi@harbour.example>" → {name, address}. */
export function sender(from:string){
 const text=String(from??'').trim(),match=/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(text);
 if(match){const address=match[2]!.trim();return {name:match[1]!.trim()||address.split('@')[0]!,address};}
 return {name:text.includes('@')?text.split('@')[0]!:text||'Someone',address:text.includes('@')?text:''};
}
export const possessive=(name:string)=>name.endsWith('s')?name+'’':name+'’s';
/** Browser sign-in accounts carry an internal identifier, not a person's name. */
export const displayName=(name:string)=>{if(/^workos\./.test(String(name??'')))return 'You';const first=String(name??'').split(/[\s._-]+/)[0]||'';return first?first[0]!.toUpperCase()+first.slice(1):'You';};
export function bytes(n:number){return n<1024?n+' B':n<1048576?Math.round(n/1024)+' KB':(n/1048576).toFixed(1)+' MB';}

export const spaceName=(name:string)=>{const n=displayName(name);return n==='You'?'Your space':`${n}’s space`;};
