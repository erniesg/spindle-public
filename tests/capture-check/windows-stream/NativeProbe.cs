// Native API feasibility/integration only. Captures this invented form, never a display.
using System;using System.Diagnostics;using System.Drawing;using System.Drawing.Imaging;using System.Runtime.InteropServices;using System.Threading;using System.Windows.Forms;using Spindle;
class NativeProbe:Form {
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 static readonly Stopwatch clock=Stopwatch.StartNew();int count;bool live=true;
 NativeProbe(){Text="Spindle WGC invented-only probe";Size=new Size(640,420);StartPosition=FormStartPosition.CenterScreen;DoubleBuffered=true;}
 protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(count%2==0?Color.CornflowerBlue:Color.LightGreen);using(var font=new Font(FontFamily.GenericSansSerif,24))e.Graphics.DrawString("SPINDLE WGC\nINVENTED ONLY\nCOUNTER "+count,font,Brushes.Black,20,20);}
 [STAThread]static void Main(string[]args){Application.EnableVisualStyles();var f=new NativeProbe();var timer=new System.Windows.Forms.Timer{Interval=200};timer.Tick+=(s,e)=>{f.count++;f.Invalidate();};timer.Start();
  f.Shown+=(s,e)=>{IntPtr target=f.Handle;new Thread(()=>{
   try{
    for(int i=0;i<600&&GetForegroundWindow()!=target;i++)Thread.Sleep(100);
    Func<bool> current=()=>f.live&&GetForegroundWindow()==target;
    if(!current())throw new Exception("INVENTED_WINDOW_FOREGROUND_REQUIRED");
    double offset=Stopwatch.GetTimestamp()*1000.0/Stopwatch.Frequency-clock.Elapsed.TotalMilliseconds,start=clock.Elapsed.TotalMilliseconds;
    var lease=new PreviewLease(CancellationToken.None,current);double previous=-1;int acquired=0;string lastCode="";
    using(var stream=new WindowStream(target,current,()=>clock.Elapsed.TotalMilliseconds,offset,start)){
     for(int i=0;i<150&&acquired<3;i++){
      double at,pts;string code;using(var bitmap=stream.TakeBitmap(lease,out at,out pts,out code)){
       lastCode=code;if(bitmap!=null){if(at<start||at<=previous||Math.Abs(pts-offset-at)>0.1)throw new Exception("FRAME_CLOCK_IDENTITY");
        if(bitmap.Width<400||bitmap.Height<250)throw new Exception("FRAME_GEOMETRY");
        bitmap.Save(args[0]+"-"+acquired+".png",ImageFormat.Png);previous=at;acquired++;
        Console.WriteLine("FRAME "+acquired+" "+bitmap.Width+"x"+bitmap.Height+" mappedAtMs="+at.ToString("F3")+" rawQpcMs="+pts.ToString("F3"));
       }
      }Thread.Sleep(240);
     }
     if(acquired!=3)throw new Exception("NO_THREE_FRESH_WGC_FRAMES "+lastCode);
     if(Array.IndexOf(args,"--producer-failure")>=0){
      // Controlled producer fault after real frames, not an OS/device-loss claim.
      // Null pool makes the production event handler's acquisition throw.
      typeof(WindowStream).GetMethod("Arrived",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).Invoke(stream,new object[]{null,null});
      double failedAt,failedPts;string failedCode;
      using(var failed=stream.TakeBitmap(lease,out failedAt,out failedPts,out failedCode)){
       if(!stream.IsCancelled||failed!=null||failedCode!="pixels-stream-unavailable")throw new Exception("PRODUCER_FAILURE_MUST_RETIRE_AND_DISCLOSE "+failedCode);
      }
      Console.WriteLine("PASS controlled producer failure retires generation and reports unavailable");
     }
     stream.Cancel();double a,p;string c;if(stream.TakeBitmap(lease,out a,out p,out c)!=null)throw new Exception("CANCELLED_STREAM_RETURNED_PIXELS");
    }
    Console.WriteLine("PASS actual WGC self-window frames, capture timestamps, geometry and cancellation");
   }catch(Exception ex){Console.WriteLine("FAIL "+ex.GetType().Name+" "+ex.Message+" HRESULT="+ex.HResult);Environment.ExitCode=1;}
   finally{f.live=false;f.BeginInvoke((Action)(()=>f.Close()));}
  }){IsBackground=true}.Start();};Application.Run(f);timer.Dispose();
 }
}
