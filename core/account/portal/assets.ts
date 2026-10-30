import {readFile} from 'node:fs/promises';
import {portalHtml,portalCss} from './page.js';
import {focusDialFontFaceCss} from '../../pomodoro/focus-dial-style.js';
import {portalWebFiles} from './web-manifest.js';

// Explicit browser-only module allowlist; never expose arbitrary core/server/config files.
const modules:Record<string,string>={
 '/portal/code/account/portal/app.js':'./app.js',
 '/portal/code/account/portal/brand.js':'./brand.js',
 '/portal/code/account/portal/ui.js':'./ui.js',
 '/portal/code/account/portal/context.js':'./context.js',
 '/portal/code/account/portal/prep.js':'./prep.js',
 '/portal/code/account/portal/today.js':'./today.js',
 '/portal/code/account/portal/review.js':'./review.js',
 '/portal/code/account/portal/connections.js':'./connections.js',
 '/portal/code/account/portal/settings.js':'./settings.js',
 '/portal/code/account/portal/lock-in.js':'./lock-in.js',
 '/portal/code/account/portal/attention.js':'./attention.js',
 '/portal/code/account/portal/tracking.js':'./tracking.js',
 '/portal/code/account/portal/pomodoro.js':'./pomodoro.js',
 '/portal/code/account/portal/blocking.js':'./blocking.js',
 '/portal/code/account/portal/application.js':'./application.js',
 '/portal/code/account/client.js':'../client.js',
 '/portal/code/pomodoro/client.js':'../../pomodoro/client.js',
 '/portal/code/pomodoro/protocol.js':'../../pomodoro/protocol.js',
 '/portal/code/pomodoro/focus-dial.js':'../../pomodoro/focus-dial.js',
 '/portal/code/ui/dom.js':'../../ui/dom.js',
 '/portal/code/ui/life-dial.js':'../../ui/life-dial.js',
 '/portal/code/ui/life-dial-geometry.js':'../../ui/life-dial-geometry.js',
};
// Approved focus-dial fonts, staged by tools/build-assets.ts. Absent files are a plain 404 (system-font fallback).
const fonts:Record<string,{file:string;type:string}>={
 '/portal/fonts/instrument.woff2':{file:'./instrument.woff2',type:'font/woff2'},
 '/portal/fonts/dm-sans-normal.woff2':{file:'./dm-sans-normal.woff2',type:'font/woff2'},
 '/portal/fonts/dm-sans-OFL.txt':{file:'./dm-sans-OFL.txt',type:'text/plain; charset=utf-8'},
 '/portal/fonts/Instrument-Serif-OFL.txt':{file:'./Instrument-Serif-OFL.txt',type:'text/plain; charset=utf-8'},
};
const web=new Map(portalWebFiles.map(f=>['/portal/web/'+f.path,f]));
export async function portalAsset(pathname:string):Promise<{type:string;body:string|Buffer}|undefined>{
 if(pathname==='/portal'||pathname==='/portal/')return {type:'text/html; charset=utf-8',body:portalHtml};
 if(pathname==='/portal/styles.css')return {type:'text/css; charset=utf-8',body:portalCss};
 if(pathname==='/portal/fonts.css')return {type:'text/css; charset=utf-8',body:focusDialFontFaceCss};
 if(Object.hasOwn(fonts,pathname)){
  try{return {type:fonts[pathname]!.type,body:await readFile(new URL(fonts[pathname]!.file,import.meta.url))};}catch{return undefined;}
 }
 const file=web.get(pathname);
 if(file){try{return {type:file.type,body:await readFile(new URL('./web/'+file.path,import.meta.url))};}catch{return undefined;}}
 if(pathname==='/portal/build'){
  try{return {type:'application/json; charset=utf-8',body:await readFile(new URL('./build.json',import.meta.url))};}
  catch{return {type:'application/json; charset=utf-8',body:JSON.stringify({source:'unbound',sourceDirty:true})};}
 }
 const relative=modules[pathname];if(!Object.hasOwn(modules,pathname)||!relative)return undefined;
 return {type:'text/javascript; charset=utf-8',body:await readFile(new URL(relative,import.meta.url))};
}
