// Developer CLI over core/preview/chrome-install. Recipients use the app's buttons instead.
// Usage: enroll-browser.js EXTENSION_ID [--resource-root PATH] [--inspect|--remove]
//        enroll-browser.js --stage-extension [--resource-root PATH]
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { inspectChromeNativeHost, installChromeNativeHost, removeChromeNativeHost, stageChromeExtension } from '../core/preview/chrome-install.js';

async function main(){
 const args=process.argv.slice(2),flag=(name:string)=>args.includes(name),rootIndex=args.indexOf('--resource-root');
 const root=rootIndex>=0?resolve(args[rootIndex+1]??''):resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const context={home:homedir()},id=args[0]??'';
 let result:unknown;
 if(flag('--stage-extension'))result=await stageChromeExtension(root,context);
 else if(flag('--remove')){await removeChromeNativeHost(context);result={removed:true};}
 else if(flag('--inspect'))result=await inspectChromeNativeHost(id,root,context);
 else result=await installChromeNativeHost(id,root,context);
 console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
