import {validSnapshot,type Action,type Command,type Durations,type Snapshot} from './protocol.js';
export interface Identity {id:string;name:string}
export interface AuthenticatedSnapshot extends Snapshot {accountId:string}
export interface TimerTransport {
 session():Promise<Identity>;
 read():Promise<AuthenticatedSnapshot>;
 command(command:Command):Promise<AuthenticatedSnapshot>;
 signout():Promise<void>;
}
export type Connection='signed-out'|'syncing'|'online'|'stale';
export class TimerSessionChanged extends Error {}
/** One request at a time; never queues/replays offline commands. No persistent tick clock. */
export class PomodoroClient {
 account:Identity|undefined;snapshot:Snapshot|undefined;connection:Connection='signed-out';message='Sign in to synchronize your timer.';
 private generation=0;private busy=false;private receivedAt=0;private monotonicAt=0;
 constructor(private transport:TimerTransport,private changed:()=>void=()=>{},private wall=()=>Date.now(),private monotonic=()=>performance.now()){}
 get pending(){return this.busy;}
 get fresh(){return this.connection==='online'&&this.wall()-this.receivedAt>=0&&this.wall()-this.receivedAt<6000&&Math.abs((this.wall()-this.receivedAt)-(this.monotonic()-this.monotonicAt))<2000;}
 remaining():number|undefined {
  if(!this.snapshot)return undefined;
  const t=this.snapshot.timer;
  return t.status==='running'?Math.max(0,t.deadlineAt!-this.snapshot.serverNow-Math.max(0,this.wall()-this.receivedAt)):t.remainingMs;
 }
 private clear(){this.account=undefined;this.snapshot=undefined;this.connection='signed-out';}
 private accept(value:unknown,generation:number){
  if(generation!==this.generation)return;
  if(!validSnapshot(value)||!('accountId'in value)||value.accountId!==this.account?.id){this.clear();this.message='Account changed. Reconnect before using the timer.';throw Error('ACCOUNT_CHANGED');}
  if(this.snapshot&&value.timer.revision<this.snapshot.timer.revision)throw Error('STALE_RESPONSE');
  this.snapshot=value;this.receivedAt=this.wall();this.monotonicAt=this.monotonic();this.connection='online';this.message='Synchronized';
 }
 async connect(){
  if(this.busy)return;this.busy=true;const generation=++this.generation;this.clear();this.connection='syncing';this.changed();
  try{const identity=await this.transport.session();if(generation!==this.generation)return;this.account=identity;this.accept(await this.transport.read(),generation);}
  catch{if(generation===this.generation){this.clear();this.message='Sign in or reconnect to synchronize your timer.';}}
  finally{if(generation===this.generation)this.busy=false;this.changed();}
 }
 async refresh(){
  if(this.busy||!this.account)return;this.busy=true;const generation=this.generation;this.changed();
  try{this.accept(await this.transport.read(),generation);}
  catch(error){if(generation===this.generation&&this.account){if(error instanceof TimerSessionChanged){this.clear();this.message='Account session changed. Reconnect to verify your account.';}else{this.connection='stale';this.message='Offline or session unavailable. Reconnect; no actions will be replayed.';}}}
  finally{if(generation===this.generation)this.busy=false;this.changed();}
 }
 async act(action:Action,durations?:Durations){
  if(this.busy||!this.fresh||!this.snapshot||!this.account){this.message='Refresh the timer before using controls.';this.changed();return;}
  this.busy=true;const generation=this.generation;
  const command:Command={id:crypto.randomUUID(),expectedRevision:this.snapshot.timer.revision,action,...(durations?{durations}:{})};this.changed();
  try{this.accept(await this.transport.command(command),generation);}
  catch(error){if(generation===this.generation&&this.account){if(error instanceof TimerSessionChanged){this.clear();this.message='Account session changed. Reconnect to verify your account.';}else{this.connection='stale';this.message='Timer changed or response was lost. Refresh to reconcile; action was not replayed.';}}}
  finally{if(generation===this.generation)this.busy=false;this.changed();}
 }
 async signout(){++this.generation;this.busy=false;this.clear();this.message='Signed out. The shared timer is unchanged.';this.changed();try{await this.transport.signout();}catch{this.message='Local view cleared; server signout unavailable. Reconnect to verify.';this.changed();}}
}
