// Development-only relocation of new timer modules into the existing extension root.
// Shared build/worker/options hooks remain tracker-owned; this does not change a manifest.
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function buildPomodoroExtension(root:string){
 const destination=join(root,'build/browser-extension/preview/pomodoro');
 await mkdir(join(destination,'shared'),{recursive:true});
 for(const module of ['page','transport','dispatch']){
  const source=await readFile(join(root,`build/browser-extension/pomodoro/${module}.js`),'utf8');
  await writeFile(join(destination,module+'.js'),source.replaceAll('../../core/pomodoro/','./shared/'));
 }
 await cp(join(root,'browser-extension/pomodoro/pomodoro.html'),join(destination,'pomodoro.html'));
 for(const file of ['ui.js','client.js','protocol.js','style.css'])await cp(join(root,'build/core/pomodoro',file),join(destination,'shared',file));
 const worker=join(root,'build/browser-extension/preview/worker.js');
 await writeFile(worker,(await readFile(worker,'utf8')).replace("'../pomodoro/dispatch.js'","'./pomodoro/dispatch.js'"));
}
