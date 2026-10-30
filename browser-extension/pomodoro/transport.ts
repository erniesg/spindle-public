import {TimerSessionChanged,type TimerTransport,type Identity,type AuthenticatedSnapshot} from '../../core/pomodoro/client.js';
import {object,type Command} from '../../core/pomodoro/protocol.js';
export class ExtensionTimerTransport implements TimerTransport {
 private binding='';
 private async request(request:unknown){
  const response:unknown=await chrome.runtime.sendMessage({kind:'pomodoro',request});
  if(response&&typeof response==='object'&&'code'in response&&['SIGNIN_REQUIRED','ACCOUNT_CHANGED','POMODORO_ACCESS_REQUIRED'].includes(String(response.code)))throw new TimerSessionChanged('SIGNIN_REQUIRED');
  if(!response||typeof response!=='object'||!('ok'in response)||response.ok!==true||!('value'in response))throw Error('POMODORO_HOST_UNAVAILABLE');
  return response.value;
 }
 async session(){const identity=await this.request({action:'session'});if(!object(identity)||typeof identity.binding!=='string')throw new TimerSessionChanged('SESSION_BINDING_REQUIRED');this.binding=identity.binding;return identity as unknown as Identity;}
 async read(){return await this.request({action:'read',binding:this.binding}) as AuthenticatedSnapshot;}
 async command(command:Command){return await this.request({action:'command',binding:this.binding,command}) as AuthenticatedSnapshot;}
 async signout(){const binding=this.binding;this.binding='';await this.request({action:'signout',binding});}
}
