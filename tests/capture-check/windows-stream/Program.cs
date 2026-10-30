using System;
using Spindle;
class Frame:IDisposable {public bool Disposed;public string Marker;public Frame(string marker){Marker=marker;}public void Dispose(){Disposed=true;}}
class Program {
 static void Check(bool value,string message){if(!value)throw new Exception(message);}
 static void Main(){
  bool current=true;double at;
  using(var frames=new LatestWindowFrame<Frame>()){
   Frame old=new Frame("old"),fresh=new Frame("fresh");
   frames.Publish(old,100,()=>current);frames.Publish(fresh,150,()=>current);
   Check(old.Disposed,"Superseded pixel frame must release its resources");
   var taken=frames.Take(120,180,250,()=>current,out at);
   Check(taken==fresh&&at==150&&!fresh.Disposed,"Newest admitted frame must retain capture time and transfer ownership");taken.Dispose();
   Check(frames.Take(120,180,250,()=>current,out at)==null,"A consumed frame cannot be reused");
   foreach(double time in new[]{119.0,181.0,-1,double.NaN,double.PositiveInfinity}){
    var bad=new Frame("wrong-time");frames.Publish(bad,time,()=>current);
    Check(frames.Take(120,180,250,()=>current,out at)==null&&bad.Disposed,"Pre-visit/future/invalid frame must not be returned");
   }
   var stale=new Frame("stale");frames.Publish(stale,200,()=>current);
   Check(frames.Take(120,451,250,()=>current,out at)==null&&stale.Disposed,"Old-frame reuse must be unavailable");
   Frame newer=new Frame("newer"),late=new Frame("out-of-order");frames.Publish(newer,600,()=>current);frames.Publish(late,550,()=>current);
   Check(late.Disposed,"Out-of-order arrival cannot replace newer pixels");
   current=false;Check(frames.Take(500,650,250,()=>current,out at)==null&&newer.Disposed,"Pause before copy must release queued pixels");
   var denied=new Frame("denied");frames.Publish(denied,700,()=>current);Check(denied.Disposed,"Cancelled producer cannot retain incoming pixels");
   current=true;frames.Dispose();var stopped=new Frame("stopped");frames.Publish(stopped,800,()=>current);Check(stopped.Disposed,"Disposed generation cannot accept a late frame");
  }
  Console.WriteLine("PASS bounded frame ownership, capture-time admission, pause and generation disposal");
 }
}
