import { isNativeFailure } from './native-failure.js';

export function pairingReply(value:Record<string,unknown>){
 if(typeof value.profileToken==='string')return {ok:true};
 return isNativeFailure(value.failure)?{ok:false,failure:value.failure}:{ok:false};
}

export function pairingStatus(result:Record<string,unknown>|undefined){
 if(result?.ok===true)return 'Paired. Recording is controlled in the local app.';
 switch(result?.failure){
  case 'HOST_NOT_FOUND':return 'Pairing failed [HOST_NOT_FOUND]. Re-run Enroll Browser.command, then reload this extension.';
  case 'HOST_FORBIDDEN':return 'Pairing failed [HOST_FORBIDDEN]. Re-run Enroll Browser.command with this extension ID, then reload this extension.';
  case 'HOST_LAUNCH_FAILED':return 'Pairing failed [HOST_LAUNCH_FAILED]. Keep the preview package in place, then re-run Enroll Browser.command.';
  case 'HOST_EXITED':return 'Pairing failed [HOST_EXITED]. Relaunch the local Spindle Preview app, then try again.';
  case 'HOST_PROTOCOL_ERROR':return 'Pairing failed [HOST_PROTOCOL_ERROR]. Reload this extension, then try again.';
  case 'HOST_DISCONNECTED':return 'Pairing failed [HOST_DISCONNECTED]. Re-run Enroll Browser.command, then reload this extension.';
  case 'HOST_TIMEOUT':return 'Pairing failed [HOST_TIMEOUT]. Keep the local Spindle Preview app running, then try again.';
  default:return 'Pairing failed [PAIR_REJECTED]. Copy the current code from the local app and try again.';
 }
}
