import {button,card,setStatus,statusRegion,textField} from './dom.js';
import {boundary,drawFace,geometry,YEARS,WEEKS} from './life-dial-geometry.js';

export type AgeInput={state:'empty'}|{state:'invalid'}|{state:'valid';age:number;weeks:number;gridAge:number};
/** Whole-year approximation only; 80 is the illustration size, not an age limit or prediction. */
export function parseAge(value:string):AgeInput {
 if(!value.trim())return {state:'empty'};
 const age=Number(value);
 if(!Number.isFinite(age)||!Number.isInteger(age)||age<0||age>130)return {state:'invalid'};
 return {state:'valid',age,weeks:boundary(age),gridAge:Math.min(age,YEARS)};
}

/** Per-view illustration only. No account, network, profile, storage or timer dependency. */
export function createLifeDial(doc:Document):{root:HTMLElement;dispose:()=>void}{
 const field=textField('Age in whole years (optional)',{name:'illustrativeAge',autocomplete:'off',hint:'Only in this view. Not saved or sent. Clear it or leave this view to forget it.'});
 const input=field.input;input.type='number';input.min='0';input.max='130';input.step='1';
 const clear=button('Clear age',{variant:'quiet'}),status=statusRegion(),canvas=doc.createElement('canvas');
 canvas.className='life-dial-canvas';canvas.setAttribute('role','img');
 const note=doc.createElement('p');note.className='sp-muted';
 note.textContent='An illustrative 80-year grid of 4,174 weeks — not a lifespan prediction. Whole-year weeks are estimates, not a birth-date calculation.';
 const controls=doc.createElement('div');controls.className='life-dial-controls';controls.append(field.root,clear);
 const legend=doc.createElement('p');legend.className='sp-muted';legend.textContent='Graphite: estimated earlier weeks · Gold: entered year · Pale: later weeks in the illustration.';
 const root=card('Life in weeks',note,canvas,controls,status,legend);root.className+=' sp-theme life-dial-card';
 let disposed=false;
 const label=()=>{
  const age=parseAge(input.validity.badInput?'invalid':input.value);
  return age.state==='empty'?'No age supplied':age.state==='invalid'?'Enter a whole-number age from 0 to 130.':`Age ${age.age} · Estimated ${age.weeks.toLocaleString('en-US')} weeks.${age.age>YEARS?' Beyond the illustrative grid: dots and hand stop at 80; your entered age is unchanged.':''}`;
 };
 function draw(){
  if(disposed)return;
  const age=parseAge(input.validity.badInput?'invalid':input.value),description=label();
  input.setAttribute('aria-invalid',String(age.state==='invalid'));
  clear.disabled=age.state==='empty';canvas.setAttribute('aria-label',`${description}. Illustrative ${YEARS}-year grid, ${WEEKS.toLocaleString('en-US')} week dots. Not a lifespan prediction.`);
  setStatus(status,age.state==='invalid'?'error':'idle',description);
  try{
   const ctx=canvas.getContext('2d');if(!ctx||ctx.isContextLost())throw Error('unavailable');
   const box=canvas.getBoundingClientRect();if(!box.width)return;
   const ratio=Math.min(2,doc.defaultView?.devicePixelRatio||1),width=box.width,height=box.height;
   canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);
   const style=doc.defaultView!.getComputedStyle(root),role=(name:string)=>style.getPropertyValue(name).trim();
   const colors={ink:role('--sp-ink'),sub:role('--sp-muted'),edge:role('--sp-line'),now:role('--sp-accent')};
   const fonts={body:role('--sp-font'),display:role('--sp-display-font')};
   if([...Object.values(colors),...Object.values(fonts)].some(value=>!value))throw Error('unavailable');
   const layout=geometry(width,height),start=age.state==='valid'?boundary(age.gridAge):0,end=age.state==='valid'&&age.gridAge<YEARS?boundary(age.gridAge+1):start;
   for(const [index,point] of layout.points.entries()){
    ctx.fillStyle=age.state!=='valid'?colors.edge:index<start?colors.sub:index<end?colors.now:colors.edge;
    ctx.beginPath();ctx.arc(point.x,point.y,point.r,0,Math.PI*2);ctx.fill();
   }
   drawFace(ctx,layout,age.state==='valid'?age.age:0,colors,fonts,{hand:age.state==='valid',centre:age.state==='valid',handAge:age.state==='valid'?age.gridAge:0});
  }catch{
   // No substitute picture or false success when this browser cannot draw the actual face.
   canvas.width=canvas.width;setStatus(status,'error',`${description}. Canvas renderer unavailable.`);
  }
 }
 const onClear=()=>{input.value='';draw();};
 input.addEventListener('input',draw);clear.addEventListener('click',onClear);
 const Observer=doc.defaultView?.ResizeObserver,observer=Observer?new Observer(draw):undefined;
 observer?.observe(canvas);
 // Called after mounting too: fonts may finish asynchronously, but retired views never draw.
 void doc.fonts?.ready.then(draw);
 canvas.addEventListener('contextlost',draw);canvas.addEventListener('contextrestored',draw);
 draw();
 return {root,dispose(){if(disposed)return;disposed=true;observer?.disconnect();input.removeEventListener('input',draw);clear.removeEventListener('click',onClear);canvas.removeEventListener('contextlost',draw);canvas.removeEventListener('contextrestored',draw);input.value='';canvas.width=canvas.width;canvas.setAttribute('aria-label','No age supplied');setStatus(status,'idle','No age supplied');}};
}
