using System;
namespace Spindle {
 // One queued GPU frame. Take transfers ownership; a consumer must dispose it.
 public sealed class LatestWindowFrame<T>:IDisposable where T:class,IDisposable {
  readonly object gate=new object();T latest;double capturedAt;bool stopped;
  public void Publish(T frame,double at,Func<bool> current){
   lock(gate){
    if(stopped||!current()||Double.IsNaN(at)||Double.IsInfinity(at)||at<0||latest!=null&&at<capturedAt){frame.Dispose();return;}
    var old=latest;latest=frame;capturedAt=at;if(old!=null)old.Dispose();
   }
  }
  public T Take(double visitStart,double now,double maxAge,Func<bool> current,out double at){
   lock(gate){at=capturedAt;var frame=latest;latest=null;
    if(frame==null)return null;
    if(stopped||!current()||at<visitStart||at>now||now-at>maxAge){frame.Dispose();return null;}
    return frame;
   }
  }
  public void Dispose(){lock(gate){stopped=true;var frame=latest;latest=null;if(frame!=null)frame.Dispose();}}
 }
}
