using System;
using System.Threading;
namespace Spindle {
 // A lease is checked before EACH native acquisition/processing/transport stage.
 // It does not interrupt an OS call already in progress. Only one worker is owned.
 public sealed class PreviewCommandFence {
  int received,active;
  public int Receive(){return Interlocked.Increment(ref received);}
  public void Activate(int receipt){Volatile.Write(ref active,receipt);}
  public bool Current {get{return Volatile.Read(ref active)==Volatile.Read(ref received);}}
  public bool TryStart(int receipt,Action setup){if(receipt!=Volatile.Read(ref received))return false;Activate(receipt);if(!Current)return false;setup();return Current;}
  public bool TryRead(Action acquire){if(!Current)return false;acquire();return Current;}
 }
 public sealed class PreviewLease {
  readonly CancellationToken token; readonly Func<bool> current;
  public PreviewLease(CancellationToken token,Func<bool> current){this.token=token;this.current=current;}
  public bool Current { get {return !token.IsCancellationRequested&&current()&&!token.IsCancellationRequested;} }
  public bool Try<T>(Func<T> read,out T value){value=default(T);if(!Current)return false;value=read();return Current;}
 }
}
