import {readFile} from 'node:fs/promises';
import {spindleUiCss} from '../ui/styles.js';
import {focusDialCss,focusDialFontFaceCss} from '../pomodoro/focus-dial-style.js';
import {previewCss} from './preview-style.js';
// Public, content-free shared presentation for the local desktop controls: the
// one theme/primitive stylesheet, the approved focus dial, and the hash-verified
// fonts tools/build-assets.ts staged beside the portal modules. Exact allowlist;
// no arbitrary path, account data or API. Absent fonts are a plain miss
// (system-font fallback), never a substitute file.
const modules:Record<string,string>={
 '/ui/dom.js':'../ui/dom.js',
 '/pomodoro/focus-dial.js':'../pomodoro/focus-dial.js',
};
const fonts:Record<string,string>={
 '/portal/fonts/instrument.woff2':'font/woff2',
 '/portal/fonts/dm-sans-normal.woff2':'font/woff2',
 '/portal/fonts/dm-sans-OFL.txt':'text/plain; charset=utf-8',
 '/portal/fonts/Instrument-Serif-OFL.txt':'text/plain; charset=utf-8',
};
export async function previewUiAsset(pathname:string):Promise<{type:string;body:string|Buffer}|undefined>{
 if(pathname==='/spindle-ui.css')return {type:'text/css; charset=utf-8',body:spindleUiCss};
 if(pathname==='/preview.css')return {type:'text/css; charset=utf-8',body:previewCss};
 if(pathname==='/focus-dial.css')return {type:'text/css; charset=utf-8',body:focusDialCss};
 if(pathname==='/portal/fonts.css')return {type:'text/css; charset=utf-8',body:focusDialFontFaceCss};
 try{
  if(Object.hasOwn(modules,pathname))return {type:'text/javascript; charset=utf-8',body:await readFile(new URL(modules[pathname]!,import.meta.url))};
  if(Object.hasOwn(fonts,pathname)){
   const body=await readFile(new URL('../account/portal/'+pathname.slice('/portal/fonts/'.length),import.meta.url));
   return body.byteLength<=1_000_000?{type:fonts[pathname]!,body}:undefined;
  }
 }catch{/* Unbuilt module or unstaged font: not served. */}
 return undefined;
}
