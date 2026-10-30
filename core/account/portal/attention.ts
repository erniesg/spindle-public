import type {AppContext} from './context.js';
import {parseHistory,parseSummary,CLASSIFY_CATEGORIES,type TrackingEntry} from './tracking.js';
import {esc,clockTime} from './ui.js';

/** Attention: real tracked history (/history) with each block's label from /sessions. Nothing is sampled or seeded. */
const COLORS:Record<string,string>={work:'var(--category-work)',learning:'var(--category-learning)',communication:'var(--category-social)',admin:'var(--category-life-admin)',personal:'var(--category-exercise)',leisure:'var(--category-entertainment)',uncategorized:'var(--sp-line)'};
const NAMES=Object.fromEntries(CLASSIFY_CATEGORIES as unknown as [string,string][]);
const duration=(ms:number)=>{const m=Math.round(ms/60000);return m<60?`${m}m`:`${Math.floor(m/60)}h${m%60?` ${m%60}m`:''}`;};
const DAY=86400000,HOUR=3600000,MAX_PAGES=80;
interface Block {key:string;start:number;end:number;app:string;title:string;category:string;label:string;described:boolean}
type RawVisit={key?:unknown;label?:{description?:unknown;label?:unknown;categoryId?:unknown;activityId?:unknown}|null};

export function blockLabel(raw:RawVisit['label'],app:string){
 const text=typeof raw?.description==='string'?raw.description:typeof raw?.label==='string'?raw.label:'';
 const free=text.trim().slice(0,120);
 if(free)return free;
 const activity=typeof raw?.activityId==='string'&&raw.activityId?raw.activityId.replace(/[-_]+/g,' '):'';
 const category=typeof raw?.categoryId==='string'?NAMES[raw.categoryId]??'':'';
 return activity?activity[0]!.toUpperCase()+activity.slice(1):category||app||'Untitled';
}

export function mountAttention(context:AppContext){
 const {main,signal,client}=context;
 let period:'day'|'week'='week',blocks:Block[]=[],loaded=false,error='';
 const entries=new Map<string,TrackingEntry>();let cursor=0,hasMore=true;
 main.className='main main-attention';
 const range=()=>{const now=Date.now();if(period==='day')return {from:now-DAY,to:now,step:HOUR,count:24};const end=new Date();end.setHours(24,0,0,0);return {from:end.getTime()-7*DAY,to:now,step:DAY,count:7};};
 async function load(){
  try{
   for(let i=0;i<MAX_PAGES&&hasMore;i++){
    const page=parseHistory(await client.request(`/history?cursor=${cursor}&limit=16`,undefined,signal),cursor);
    for(const e of page.entries)entries.set(e.key,e);cursor=page.cursor;hasMore=page.hasMore;
   }
   const r=range(),raw=await client.request(`/sessions?from=${Math.floor(r.from)}&to=${Math.floor(r.to)}`,undefined,signal) as {visits?:RawVisit[]};
   parseSummary(raw);
   const labels=new Map<string,RawVisit['label']>();for(const v of raw.visits??[])if(typeof v?.key==='string')labels.set(v.key,v.label??null);
   blocks=[];
   for(const e of entries.values()){
    if(e.deleted||e.start===null)continue;const end=e.end??Date.now(),start=Math.max(e.start,r.from),stop=Math.min(end,r.to);if(stop<=start)continue;
    const l=labels.get(e.key),category=typeof l?.categoryId==='string'&&COLORS[l.categoryId]?l.categoryId:'uncategorized';
    blocks.push({key:e.key,start,end:stop,app:e.app,title:e.title,category,label:blockLabel(l,e.app),described:typeof l?.description==='string'&&!!l.description.trim()||typeof l?.label==='string'&&!!l.label.trim()});
   }
   blocks.sort((a,b)=>b.start-a.start);error='';
  }catch(e){if(context.failed(e))return;error=/40[45]/.test(String(e))?'Attention isn’t available yet. Get Spindle for Mac to start.':'We couldn’t load your attention just now.';}
  loaded=true;if(!signal.aborted)paint();
 }
 function chart(){
  const r=range(),buckets=Array.from({length:r.count},(_,i)=>({start:r.from+i*r.step,parts:new Map<string,number>()}));
  for(const b of blocks)for(const bucket of buckets){const s=Math.max(b.start,bucket.start),e=Math.min(b.end,bucket.start+r.step);if(e>s)bucket.parts.set(b.category,(bucket.parts.get(b.category)??0)+e-s);}
  const max=Math.max(HOUR,...buckets.map(b=>[...b.parts.values()].reduce((a,c)=>a+c,0)));
  const W=1000,H=280,pad=34,bw=(W-pad)/r.count;
  const bars=buckets.map((bucket,i)=>{let y=H-24;return [...bucket.parts].map(([cat,ms])=>{const h=Math.max(1,(ms/max)*(H-40));y-=h;return `<rect x="${pad+i*bw+bw*.12}" y="${y}" width="${bw*.76}" height="${h}" rx="2" fill="${COLORS[cat]}"><title>${esc(NAMES[cat]??cat)} · ${esc(duration(ms))}</title></rect>`;}).join('');}).join('');
  const labels=buckets.map((bucket,i)=>(period==='week'||i%3===0)?`<text x="${pad+i*bw+bw/2}" y="${H-4}" text-anchor="middle">${esc(period==='week'?new Date(bucket.start).toLocaleDateString('en-GB',{weekday:'short'}):new Date(bucket.start).toLocaleTimeString('en-GB',{hour:'2-digit',hour12:false}))}</text>`:'').join('');
  return `<svg class="sp-attention-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Attention by ${period==='week'?'day':'hour'}"><line x1="${pad}" x2="${W}" y1="${H-24}" y2="${H-24}"></line><text x="0" y="${H-26}">0</text><text x="0" y="16">${esc(duration(max))}</text>${bars}${labels}</svg>`;
 }
 function paint(){
  const total=blocks.reduce((a,b)=>a+b.end-b.start,0),used=new Set(blocks.map(b=>b.category));
  const body=!loaded?'<p class="sp-quiet" role="status">Loading…</p>':error?`<p class="ac-error" role="alert">${esc(error)}</p>`:!blocks.length?'<section class="sp-empty-state"><h2>Nothing here yet.</h2><p>When Spindle for Mac is running, your time shows up here, quietly sorted.</p><a class="button primary" href="#devices">Get Spindle for Mac</a></section>'
   :`<section class="at-visualization"><div class="at-card-head"><div class="at-visualization-title"><h2><span>Observed attention</span><span class="at-view-total">${esc(duration(total))}</span></h2></div></div><div class="at-visualization-body"><div class="at-plot">${chart()}</div><div class="at-legend">${[...used].map(c=>`<button type="button" tabindex="-1"><i style="background:${COLORS[c]}"></i>${esc(NAMES[c]??c)}</button>`).join('')}</div></div></section>
<section class="sp-blocks" aria-labelledby="sp-blocks-title"><div class="today-section-heading"><h2 id="sp-blocks-title">Recent blocks</h2></div><ol class="sp-block-list">${blocks.slice(0,12).map(b=>`<li><span class="sp-block-dot" style="background:${COLORS[b.category]}" aria-hidden="true"></span><span class="sp-block-main"><strong>${esc(b.label)}${b.described&&b.category!=='uncategorized'?` <span class="sp-block-chip">${esc(NAMES[b.category]??b.category)}</span>`:''}</strong><small>${esc([b.app,b.title].filter(Boolean).join(' · '))}</small></span><span class="sp-block-time">${esc(clockTime(b.start))}–${esc(clockTime(b.end))} · ${esc(duration(b.end-b.start))}</span></li>`).join('')}</ol></section>`;
  main.innerHTML=`<div class="at-page"><div class="at-header sp-page-header"><div class="sp-page-heading-copy"><div class="sp-page-title-line"><h1>Attention</h1></div></div></div><div class="at-toolbar"><div></div><div class="at-controls"><div class="at-period" role="group" aria-label="Time period"><button type="button" class="${period==='day'?'active':''}" aria-pressed="${period==='day'}" data-at-period="day">24h</button><button type="button" class="${period==='week'?'active':''}" aria-pressed="${period==='week'}" data-at-period="week">Weekly</button></div></div></div>${body}</div>`;
 }
 main.addEventListener('click',event=>{const b=(event.target as Element).closest<HTMLElement>('[data-at-period]');if(!b)return;period=b.dataset.atPeriod as 'day'|'week';loaded=false;paint();void load();},{signal});
 paint();void load();
}
