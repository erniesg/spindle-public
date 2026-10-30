// Real Windows Photos integration assertion. Start the production preview with
// only photos + pixels, foreground its supplied invented image, then run with
// SPINDLE_PREVIEW_SESSION pointing to a private {origin,token} session file.
import {readFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const s=JSON.parse(await readFile(process.env.SPINDLE_PREVIEW_SESSION,'utf8'));
const body=v=>v.app==='photos'&&v.textSource==='ocr'&&/SPINDLE/.test(v.text)&&/ONLY/.test(v.text)&&v.text.length>25;
let state;for(let i=0;i<40;i++){state=await (await fetch(s.origin+'/state',{headers:{Authorization:'Bearer '+s.token}})).json();if(state.visits.some(body))break;await new Promise(r=>setTimeout(r,250));}
assert(state.visits.some(body),'Actual Photos sample must supply image-body OCR; window chrome and imperfect block-font spelling are allowed. Observed: '+state.visits.map(v=>v.availability).join(','));
if(!state.options.rich)assert(state.visits.every(v=>!v.image),'Pixels-only must retain no PNGs');
console.log('PASS actual Photos image-body OCR through production native capture.');
