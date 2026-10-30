/** Settle the caller independently of dependencies which ignore cancellation.
 * Both promise branches stay observed after cancellation. */
export function abortRace<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason??Error('Google operation cancelled'));};
  const cleanup=()=>signal.removeEventListener('abort',abort);
  work.then(value=>{cleanup();if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{cleanup();reject(error);});
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
}
