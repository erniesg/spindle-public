import {readFile} from 'node:fs/promises';
const assets=new Map<string,string>([
 ['/pomodoro/app/','index.html'],['/pomodoro/app/index.html','index.html'],
 ...['style.css','web.js','browser.js','client.js','protocol.js','ui.js','desktop-ui.js'].map(file=>['/pomodoro/app/'+file,file] as [string,string]),
]);
/** Public, content-free assets only. No arbitrary paths, account data or API proxy. */
export async function pomodoroAsset(pathname:string){
 const file=assets.get(pathname);if(!file)return undefined;
 return {body:await readFile(new URL(file,import.meta.url)),type:file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8'};
}
