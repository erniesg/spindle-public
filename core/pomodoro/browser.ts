import {object} from './protocol.js';
import {TimerSessionChanged,type Identity,type AuthenticatedSnapshot,type TimerTransport} from './client.js';
import type {Command} from './protocol.js';
/** Same-origin browser cookies stay HttpOnly. Never copies Cookie/Origin headers or uses Buffer. */
export class BrowserTimerTransport implements TimerTransport {
 private csrf='';
 private async post(path:string,data:unknown,csrf=true):Promise<unknown>{
  const response=await fetch(path,{method:'POST',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':this.csrf}:{})},body:JSON.stringify(data)});
  if(!response.ok){await response.body?.cancel();if(response.status===401||response.status===403)throw new TimerSessionChanged('ACCOUNT_SESSION_CHANGED');throw Error(`POMODORO_HTTP_${response.status}`);}
  const text=await response.text();if(text.length>16000)throw Error('RESPONSE_BOUND');return JSON.parse(text);
 }
 async session():Promise<Identity>{
  const value=await this.post('/pomodoro/session',{},false);
  if(!object(value)||typeof value.csrf!=='string'||!/^[a-f0-9]{64}$/.test(value.csrf)||!object(value.account)||typeof value.account.id!=='string'||typeof value.account.name!=='string')throw Error('INVALID_SESSION');
  this.csrf=value.csrf;return {id:value.account.id,name:value.account.name};
 }
 async signin(name:string,password:string,register=false){this.csrf='';await this.post(register?'/register':'/signin',{name,password},false);}
 async read(){return await this.post('/pomodoro/read',{}) as AuthenticatedSnapshot;}
 async command(command:Command){return await this.post('/pomodoro/command',command) as AuthenticatedSnapshot;}
 async signout(){try{await this.post('/logout',{});}finally{this.csrf='';}}
}
