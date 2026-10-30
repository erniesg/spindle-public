// Native adapter: foreground/UIA + persistent exact-window WGC, no monitor fallback.
// Local Windows.Media.Ocr fallback. Shared TypeScript owns visits/storage/policy.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Media.Ocr;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.ApplicationModel;
using Windows.Management.Deployment;
namespace Spindle {
 [DataContract] public class PreviewCommand {
  [DataMember] public string schema; [DataMember] public string action; [DataMember] public int epoch; [DataMember] public string[] apps;
  public int Receipt;
  [DataMember] public bool pixels; [DataMember] public bool rich;
 }
 public static class PreviewProgram {
  static readonly Stopwatch Clock=Stopwatch.StartNew();static readonly string ClockId=Guid.NewGuid().ToString();
  static readonly double QpcOffset=Stopwatch.GetTimestamp()*1000.0/Stopwatch.Frequency-Clock.Elapsed.TotalMilliseconds;
  static readonly object StreamGate=new object();static WindowStream stream;static Rect streamRect;static int closingStreams;static double closingSince,focusAt;
  static readonly object Output=new object();static Control dispatch;static volatile bool running;static bool pending,pixels,rich;
  static int epoch,revision;static string key;static IntPtr window;static double lastRead=-1000;
  static CancellationTokenSource work=new CancellationTokenSource();
  static readonly PreviewCommandFence Commands=new PreviewCommandFence();
  static readonly object PackageLock=new object();
  static readonly Dictionary<string,string> PackageCache=new Dictionary<string,string>();
  static void CloseStream(WindowStream expected=null){
   WindowStream old;lock(StreamGate){if(expected!=null&&!Object.ReferenceEquals(stream,expected))return;old=stream;stream=null;if(old==null)return;old.Cancel();Volatile.Write(ref closingSince,Now());Interlocked.Increment(ref closingStreams);}
   ThreadPool.QueueUserWorkItem(delegate{try{old.Dispose();}catch{Emit("{\"kind\":\"error\",\"code\":\"WINDOWS_STREAM_CLOSE_FAILED\"}");Environment.Exit(1);}finally{Interlocked.Decrement(ref closingStreams);}});
  }
  static void Fence(){work.Cancel();work=new CancellationTokenSource();CloseStream();}
  static readonly ObservationContinuity continuity=new ObservationContinuity();
  static HashSet<string> allowed=new HashSet<string>();
  static readonly HashSet<string> Supported=new HashSet<string>(new[]{"explorer","notepad","wordpad","mspaint","photos","spindlefixture"},StringComparer.OrdinalIgnoreCase);
  delegate void EventCallback(IntPtr hook,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time);
  static EventCallback callback;static IntPtr hook,destroyHook;static System.Windows.Forms.Timer timer;
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process,ref uint length,StringBuilder name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr process,ref uint length,StringBuilder family);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min,uint max,IntPtr module,EventCallback callback,uint pid,uint thread,uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first,IntPtr second);
  static bool PhysicalPixels(){return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),new IntPtr(-4));}
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
  static double Now(){return Clock.Elapsed.TotalMilliseconds;}
  static string Q(string s){if(s==null)return "null";var b=new StringBuilder("\"");foreach(char c in s){if(c=='"')b.Append("\\\"");else if(c=='\\')b.Append("\\\\");else if(c<32)b.Append("\\u"+((int)c).ToString("x4"));else b.Append(c);}return b.Append('"').ToString();}
  static string N(double n){return n.ToString("F3",System.Globalization.CultureInfo.InvariantCulture);}
  static void Emit(string s){lock(Output)Console.WriteLine("{\"schema\":\"spindle-native-preview/v1\","+s.Substring(1));}
  static string Identity(IntPtr hwnd,out string app){app="";uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid==0)return null;try{using(var p=Process.GetProcessById((int)pid)){
   app=p.ProcessName.ToLowerInvariant();uint length=256;var family=new StringBuilder((int)length);
   // Live OS package identity, never a guessed Store path or executable basename.
   IntPtr handle=OpenProcess(0x1000,false,pid);string packaged=null;
   try{
    if(handle!=IntPtr.Zero&&GetPackageFamilyName(handle,ref length,family)==0&&PreviewAdmission.PackageApp(family.ToString())!=null){
     string incarnation=pid+":"+p.StartTime.ToUniversalTime().Ticks;
     lock(PackageLock){if(!PackageCache.TryGetValue(incarnation,out packaged)){
      uint size=512;var name=new StringBuilder((int)size);
      if(GetPackageFullName(handle,ref size,name)==0){var package=new PackageManager().FindPackageForUser(String.Empty,name.ToString());if(package!=null&&!package.IsDevelopmentMode&&(package.SignatureKind==PackageSignatureKind.Store||package.SignatureKind==PackageSignatureKind.System))packaged=PreviewAdmission.PackageApp(family.ToString());}
      if(PackageCache.Count>=64)PackageCache.Clear();PackageCache[incarnation]=packaged;
     }}
    }
   }finally{if(handle!=IntPtr.Zero)CloseHandle(handle);}
   if(packaged!=null)app=packaged;
   else if(app=="photos"||Supported.Contains(app)&&!PreviewAdmission.Allowed(app,p.MainModule.FileName,Environment.SystemDirectory,AppDomain.CurrentDomain.BaseDirectory))return null;
   return pid+":"+p.StartTime.ToUniversalTime().Ticks+":"+hwnd.ToInt64();}}catch{return null;}}
  static string Prefix(string s,int n){return s.Length>n?s.Substring(0,n):s;}
  static void Key(){
   try{var dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"SpindlePreview");Directory.CreateDirectory(dir);var path=Path.Combine(dir,"key.dpapi");byte[] bytes;
    if(File.Exists(path)){if(new FileInfo(path).Length>4096)throw new Exception();bytes=ProtectedData.Unprotect(File.ReadAllBytes(path),null,DataProtectionScope.CurrentUser);}
    else{bytes=new byte[32];using(var rng=RandomNumberGenerator.Create())rng.GetBytes(bytes);var encrypted=ProtectedData.Protect(bytes,null,DataProtectionScope.CurrentUser);using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None))file.Write(encrypted,0,encrypted.Length);}
    if(bytes.Length!=32)throw new Exception();Emit("{\"kind\":\"key\",\"value\":"+Q(Convert.ToBase64String(bytes))+"}");Array.Clear(bytes,0,bytes.Length);
   }catch{Emit("{\"kind\":\"key\",\"value\":\"\"}");}
  }
  sealed class Surface {public bool Complete=true;public int Pid;public readonly List<AutomationElement> Texts=new List<AutomationElement>();public readonly List<TextPattern> Documents=new List<TextPattern>();}
  sealed class SurfaceNode {public AutomationElement Element;public int Depth;public SurfaceNode(AutomationElement element,int depth){Element=element;Depth=depth;}}
  // Optional read-only text extractor, not authorization for window pixels.
  static Surface Inspect(IntPtr hwnd,PreviewLease lease){
   var surface=new Surface();var stack=new Stack<SurfaceNode>();var metadata=new CacheRequest();metadata.TreeScope=TreeScope.Element;
   foreach(var property in new[]{AutomationElement.ProcessIdProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsPasswordProperty,AutomationElement.ControlTypeProperty})metadata.Add(property);
   // NEVER cache Name/Value/Text: excluded siblings have not passed their gates.
   if(!lease.Current){surface.Complete=false;return surface;}
   var root=AutomationElement.FromHandle(hwnd).GetUpdatedCache(metadata);int pid=root.Cached.ProcessId;surface.Pid=pid;
   uint expected;GetWindowThreadProcessId(hwnd,out expected);
   if(pid!=(int)expected||root.Cached.IsOffscreen||root.Cached.IsPassword||!lease.Current){surface.Complete=false;return surface;}
   stack.Push(new SurfaceNode(root,0));var budget=Stopwatch.StartNew();int count=0;
   while(stack.Count>0){if(!lease.Current||count++>=180||budget.ElapsedMilliseconds>120){surface.Complete=false;break;}
    var item=stack.Pop();var current=item.Element.Cached;if(current.IsOffscreen)continue;
    if(current.ProcessId!=pid||current.IsPassword){surface.Complete=false;continue;}
    if(current.ControlType==ControlType.Text){surface.Texts.Add(item.Element);continue;}
    if(current.ControlType==ControlType.Document){object pattern;if(!item.Element.TryGetCurrentPattern(TextPattern.Pattern,out pattern)||!((TextPattern)pattern).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute).Equals(true)){surface.Complete=false;continue;}surface.Documents.Add((TextPattern)pattern);continue;}
    // Editable/password/chrome/image/unknown subtrees are not read as text.
    // Their visible pixels remain in explicitly authorized WINDOW screenshots.
    if(current.ControlType!=ControlType.Window&&current.ControlType!=ControlType.Pane&&current.ControlType!=ControlType.Group&&current.ControlType!=ControlType.List&&current.ControlType!=ControlType.ListItem){surface.Complete=false;continue;}
    if(item.Depth>=8){surface.Complete=false;continue;}
    var child=TreeWalker.RawViewWalker.GetFirstChild(item.Element,metadata);int children=0;
    while(child!=null&&children++<40){stack.Push(new SurfaceNode(child,item.Depth+1));child=TreeWalker.RawViewWalker.GetNextSibling(child,metadata);}
    if(child!=null)surface.Complete=false;
   }
   return surface;
  }
  static string ReadText(Surface surface,PreviewLease lease){
   var result=new StringBuilder();foreach(var element in surface.Texts){
    if(!lease.Current)return "";var current=element.Current;
    var name=PreviewAdmission.ReadName(()=>lease.Current,current.IsOffscreen,current.ProcessId==surface.Pid,current.IsPassword,current.ControlType==ControlType.Text,()=>element.Current.Name);
    if(name!=null)result.AppendLine(Prefix(name,512));
   }
   foreach(var document in surface.Documents){
    if(!lease.Current)return "";var ranges=document.GetVisibleRanges();if(ranges.Length>8)continue;
    foreach(var range in ranges){if(!lease.Current)return "";
     if(!range.GetAttributeValue(TextPattern.IsReadOnlyAttribute).Equals(true)||!range.GetAttributeValue(TextPattern.IsHiddenAttribute).Equals(false))continue;
     if(!lease.Current)return "";result.AppendLine(range.GetText(Math.Max(0,4096-result.Length)));if(result.Length>=4096)break;
    }
   }
   return Prefix(result.ToString(),4096);
  }
  static bool SameRect(IntPtr hwnd,Rect expected){Rect actual;return PhysicalPixels()&&GetWindowRect(hwnd,out actual)&&actual.Left==expected.Left&&actual.Top==expected.Top&&actual.Right==expected.Right&&actual.Bottom==expected.Bottom;}
  static WindowPixelResult Image(IntPtr hwnd,bool retain,bool needOCR,PreviewLease lease,Func<bool> acquiringAllowed,double visitStart){
   if(!lease.Current)return WindowPixelResult.Failure("pixels-cancelled");
   if(!PhysicalPixels())return WindowPixelResult.Failure("pixels-unavailable-dpi-context");
   Rect rect;if(!GetWindowRect(hwnd,out rect))return WindowPixelResult.Failure("pixels-window-unavailable");
   long width=(long)rect.Right-rect.Left,height=(long)rect.Bottom-rect.Top;
   if(width<=0||height<=0||width>Int32.MaxValue||height>Int32.MaxValue)return WindowPixelResult.Failure("pixels-window-unavailable");
   int w=(int)width,h=(int)height;if(!WindowPixels.CanAllocate(w,h))return WindowPixelResult.Failure("pixels-memory-budget");
   try{
    WindowStream active;Rect original;lock(StreamGate){active=stream;original=streamRect;}
    if(active!=null&&(original.Left!=rect.Left||original.Top!=rect.Top||original.Right!=rect.Right||original.Bottom!=rect.Bottom)){CloseStream(active);return WindowPixelResult.Failure("pixels-window-changed");}
    if(active==null){
     if(Volatile.Read(ref closingStreams)!=0)return WindowPixelResult.Failure("pixels-stream-closing");
     // This method runs on the extraction worker, never the event/timing pump.
     WindowStream candidate=new WindowStream(hwnd,acquiringAllowed,Now,QpcOffset,visitStart);
     lock(StreamGate){if(lease.Current&&stream==null&&Volatile.Read(ref closingStreams)==0){stream=candidate;streamRect=rect;active=candidate;candidate=null;}}
     if(candidate!=null){candidate.Dispose();return WindowPixelResult.Failure("pixels-cancelled");}
    }
    double capturedAt,framePTS;string code;using(var bitmap=active.TakeBitmap(lease,out capturedAt,out framePTS,out code)){
    if(bitmap==null){if(active.IsCancelled)CloseStream(active);var unavailable=WindowPixelResult.Failure(code);unavailable.NoChange=code=="pixels-awaiting-fresh-frame"&&active.HasCopiedFrame;return unavailable;}
    if(!lease.Current)return WindowPixelResult.Failure("pixels-cancelled");
    if(!SameRect(hwnd,rect))return WindowPixelResult.Failure("pixels-window-changed");
    int maximum=0;if(needOCR)try{maximum=(int)OcrEngine.MaxImageDimension;}catch{/* Rich remains independent of OCR. */}
    var result=WindowPixels.Process(bitmap,retain,needOCR,maximum,delegate(Bitmap input){
     if(!lease.Current||!SameRect(hwnd,rect))return "";
     var engine=OcrEngine.TryCreateFromLanguage(new Language("en-US"));if(engine==null)return null;
     int ow=input.Width,oh=input.Height;byte[] data=new byte[ow*oh*4];
     try{
      var bits=input.LockBits(new Rectangle(0,0,ow,oh),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
      try{for(int y=0;y<oh;y++)Marshal.Copy(IntPtr.Add(bits.Scan0,y*bits.Stride),data,y*ow*4,ow*4);}finally{input.UnlockBits(bits);}
      for(int i=3;i<data.Length;i+=4)data[i]=255;
      if(!lease.Current||!SameRect(hwnd,rect))return "";
      using(var software=new SoftwareBitmap(BitmapPixelFormat.Bgra8,ow,oh,BitmapAlphaMode.Premultiplied)){software.CopyFromBuffer(data.AsBuffer());if(!lease.Current||!SameRect(hwnd,rect))return "";return Prefix(engine.RecognizeAsync(software).AsTask().GetAwaiter().GetResult().Text,4096);}
     }finally{Array.Clear(data,0,data.Length);}
    },()=>lease.Current&&SameRect(hwnd,rect));
    result.CapturedAt=capturedAt;result.FramePTS=framePTS;return result;
   }}catch(UnauthorizedAccessException){return WindowPixelResult.Failure("pixels-stream-permission-denied");}
   catch(NotSupportedException){return WindowPixelResult.Failure("pixels-stream-unsupported");}
   catch(OutOfMemoryException){return WindowPixelResult.Failure("pixels-allocation-failed");}
   catch{return WindowPixelResult.Failure("pixels-processing-failed");}
  }
  static string CaptureJson(WindowPixelResult c){return c==null?"null":"{\"pixels\":"+Q(c.Pixels)+",\"ocr\":"+Q(c.Ocr)+",\"image\":"+Q(c.Retention)+",\"sourceWidth\":"+c.SourceWidth+",\"sourceHeight\":"+c.SourceHeight+",\"imageWidth\":"+c.ImageWidth+",\"imageHeight\":"+c.ImageHeight+",\"ocrWidth\":"+c.OcrWidth+",\"ocrHeight\":"+c.OcrHeight+"}";}
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size; public uint tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  static double lastActivity=-1000;
  static void Activity(double at){
   if(at-lastActivity<1000)return;lastActivity=at;
   var input=new LastInput{size=(uint)Marshal.SizeOf(typeof(LastInput))};string bucket="unknown";
   if(GetLastInputInfo(ref input)){uint age=unchecked((uint)Environment.TickCount-input.tick);bucket=age<15000?"under-15s":age<60000?"15s-1m":age<300000?"1m-5m":"over-5m";}
   Emit("{\"kind\":\"activity\",\"epoch\":"+epoch+",\"at\":"+N(at)+",\"inputAgeBucket\":"+Q(bucket)+"}");
  }
  static void Observe(uint? eventTime=null){
   double at=Now();
   if(Volatile.Read(ref closingStreams)!=0&&at-Volatile.Read(ref closingSince)>3000){Emit("{\"kind\":\"error\",\"code\":\"WINDOWS_STREAM_STOP_TIMEOUT\"}");Environment.Exit(1);return;}
   if(pending&&at-lastRead>3000){if(running)Emit("{\"kind\":\"gap\",\"epoch\":"+epoch+",\"at\":"+N(lastRead)+"}");running=false;Fence();Emit("{\"kind\":\"error\",\"code\":\"WINDOWS_WORKER_TIMEOUT\"}");Environment.Exit(1);return;}
   if(!running||!Commands.Current)return;
   if(!continuity.Observe(at,unchecked((uint)Environment.TickCount),eventTime)){Fence();running=false;Emit("{\"kind\":\"gap\",\"epoch\":"+epoch+",\"at\":"+N(continuity.ReliableThrough)+"}");return;}
   Emit("{\"kind\":\"clock\",\"at\":"+N(at)+"}");Activity(at);
   IntPtr hwnd=GetForegroundWindow();string app;string identity=Identity(hwnd,out app);bool browser=app=="chrome"||app=="chromium";
   string next=identity!=null&&(browser||allowed.Contains(app))?identity:null;
   if(next!=key){Fence();key=next;window=next==null?IntPtr.Zero:hwnd;focusAt=at;revision++;string title="";if(next!=null&&!browser){var caption=new StringBuilder(257);if(!Commands.TryRead(()=>GetWindowText(hwnd,caption,caption.Capacity)))return;title=caption.ToString();}
    if(!Commands.Current)return;
    Emit("{\"kind\":\"focus\",\"epoch\":"+epoch+",\"revision\":"+revision+",\"at\":"+N(at)+",\"clock\":"+Q(ClockId)+",\"key\":"+Q(next)+",\"app\":"+Q(app)+",\"title\":"+Q(title)+",\"browser\":"+(browser?"true":"false")+"}");}
   if(next==null||browser||pending||at-lastRead<500)return;pending=true;lastRead=at;int e=epoch,r=revision;string k=key;IntPtr target=window;double visitStart=focusAt;bool wantImage=pixels&&rich,photos=app=="photos",wantPixels=pixels;var token=work.Token;
   var lease=new PreviewLease(token,delegate{string check;return running&&Commands.Current&&GetForegroundWindow()==target&&Identity(target,out check)==k;});
   var thread=new Thread(delegate(){string text="",image="",title="",status="native-text",textSource="native";WindowPixelResult capture=null;double sampledAt=at;try{
     var caption=new StringBuilder(257);if(!lease.Try(()=>GetWindowText(target,caption,caption.Capacity),out var titleLength))return;title=caption.ToString();
     Surface surface=null;
     // Rich OCR and PNG must use the same captured bitmap; a preceding
     // complete UIA read can already be stale. Basic still prefers UIA.
     try{if(!wantImage){if(!lease.Try(()=>Inspect(target,lease),out surface))return;if(!lease.Try(()=>ReadText(surface,lease),out text))return;}}
     catch{surface=null;text="";status="native-text-unavailable";}
     bool needOCR=wantImage||photos||surface==null||!surface.Complete||text.Length==0;
     if(wantPixels&&(wantImage||needOCR)){capture=Image(target,wantImage,needOCR,lease,delegate{return running&&Commands.Current&&!token.IsCancellationRequested&&GetForegroundWindow()==target;},visitStart);if(capture.NoChange)return;image=capture.Image;status=capture.Status(needOCR,wantImage);if(capture.CapturedAt>0)sampledAt=capture.CapturedAt;if(needOCR){text=capture.Text;textSource="ocr";}}
     if(wantImage&&capture!=null&&capture.Pixels!="captured"){
      // No bitmap exists to pair with text: a fresh scoped UIA-only acquisition
      // remains useful. Never use this fallback alongside a successful Rich frame.
      sampledAt=Now();image="";
      try{if(!lease.Try(()=>Inspect(target,lease),out surface))return;if(!lease.Try(()=>ReadText(surface,lease),out text))return;textSource="native";status=surface!=null&&surface.Complete?"native-text":"native-text-incomplete";}
      catch{text="";}
     }
     if(!lease.Current)return;
     var finalCaption=new StringBuilder(257);if(!lease.Try(()=>GetWindowText(target,finalCaption,finalCaption.Capacity),out titleLength)||finalCaption.ToString()!=title)return;
    }catch{text="";image="";status="native-text-unavailable";}
    finally{try{dispatch.BeginInvoke((Action)delegate{pending=false;});}catch{}}
    if(!lease.Current)return;
    try{dispatch.BeginInvoke((Action)delegate{Observe();string check;if(!lease.Current||!running||epoch!=e||revision!=r||key!=k||GetForegroundWindow()!=target||Identity(target,out check)!=k)return;
      Emit("{\"kind\":\"sample\",\"epoch\":"+e+",\"revision\":"+r+",\"at\":"+N(sampledAt)+(capture!=null&&capture.FramePTS>=0&&capture.Pixels=="captured"?",\"framePTS\":"+N(capture.FramePTS):"")+",\"title\":"+Q(title)+",\"text\":"+Q(text)+",\"textSource\":"+Q(textSource)+",\"status\":"+Q(status)+",\"image\":"+Q(image)+",\"capture\":"+CaptureJson(capture)+"}");});}catch{}
   });thread.IsBackground=true;thread.SetApartmentState(ApartmentState.MTA);thread.Start();
  }
  static void Handle(PreviewCommand c){
   if(c.schema!="spindle-native-preview/v1"){running=false;Emit("{\"kind\":\"error\",\"code\":\"PROTOCOL_VERSION\"}");return;}
   if(c.action=="key"){Key();return;}
   if(c.action=="quit"){Fence();running=false;Application.ExitThread();return;}
   if(c.action=="stop"){running=false;Fence();revision++;key=null;return;}
   if(c.action=="start"){Commands.TryStart(c.Receipt,delegate{Fence();running=false;epoch=c.epoch;revision=0;key="initial";allowed=new HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var app in c.apps??new string[0])if(Supported.Contains(app))allowed.Add(app);pixels=c.pixels;rich=c.rich&&pixels;continuity.Start(Now());running=true;Observe();});}
  }
  class Canvas:Control { public int Counter; public Canvas(){DoubleBuffered=true;Dock=DockStyle.Fill;AccessibleRole=AccessibleRole.Pane;} protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Color.White);using(var font=new Font(FontFamily.GenericMonospace,25))e.Graphics.DrawString("SPINDLE CANVAS OCR\nINVENTED ONLY\nCOUNTER "+Counter,font,Brushes.Black,20,25);} }
  static void Fixtures(){Application.EnableVisualStyles();var forms=new List<Form>();var labels=new List<Label>();var canvas=new Canvas();for(int i=0;i<3;i++){var f=new Form();f.Text=i==2?"Spindle canvas OCR":"Spindle native "+(i==0?"A":"B");f.Size=new Size(560,300);f.StartPosition=FormStartPosition.Manual;f.Location=new Point(100+i*70,180+i*45);if(i==2)f.Controls.Add(canvas);else{var label=new Label{Dock=DockStyle.Fill,Font=new Font(SystemFonts.DefaultFont.FontFamily,22),Padding=new Padding(20)};labels.Add(label);f.Controls.Add(label);}forms.Add(f);f.Show();}int count=0;var timer=new System.Windows.Forms.Timer();timer.Interval=1000;timer.Tick+=delegate{count++;canvas.Counter=count;canvas.Invalidate();for(int i=0;i<labels.Count;i++)labels[i].Text="SPINDLE NATIVE "+(i==0?"A":"B")+"\nINVENTED ONLY\nCOUNTER "+count;};timer.Start();Application.Run(new ApplicationContext());timer.Stop();foreach(var f in forms)f.Dispose();}
  [STAThread] public static void Main(string[] args){
   try{
    if(Array.IndexOf(args,"--fixture")>=0){Fixtures();return;}
    // Only the control process uses this private worker role after acquiring its
    // separate lifetime lease. Standalone/default launches still acquire ownership.
    if(args.Length==1&&args[0]=="--capture-worker"){RunNative();return;}
    // The current-user store/connection has one native owner, across sessions.
    string sid=System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
    using(var owner=new Mutex(false,"Global\\SpindlePreview-"+sid)){
     bool acquired;try{acquired=owner.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}
     if(!acquired){Emit("{\"kind\":\"error\",\"code\":\"WINDOWS_CAPTURE_OWNER_BUSY\"}");Environment.ExitCode=2;return;}
     try{if(args.Length==1&&args[0]=="--owner-lease"){Emit("{\"kind\":\"owner-ready\"}");Console.ReadLine();}else RunNative();}finally{owner.ReleaseMutex();}
    }
   }catch{Emit("{\"kind\":\"error\",\"code\":\"WINDOWS_PROVIDER_UNAVAILABLE\"}");Environment.ExitCode=1;}
  }
  static void RunNative(){
    Console.OutputEncoding=new UTF8Encoding(false);Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);dispatch=new Control();var handle=dispatch.Handle;
    callback=delegate(IntPtr h,uint evt,IntPtr hwnd,int obj,int child,uint thread,uint time){if(running&&evt==0x8001&&obj==0&&hwnd==window){Fence();revision++;key=null;window=IntPtr.Zero;Emit("{\"kind\":\"focus\",\"epoch\":"+epoch+",\"revision\":"+revision+",\"at\":"+N(Now())+",\"key\":null}");}Observe(time);};hook=SetWinEventHook(3,3,IntPtr.Zero,callback,0,0,0);destroyHook=SetWinEventHook(0x8001,0x8001,IntPtr.Zero,callback,0,0,0);
    Microsoft.Win32.SystemEvents.PowerModeChanged+=delegate(object sender,Microsoft.Win32.PowerModeChangedEventArgs e){if(e.Mode==Microsoft.Win32.PowerModes.Suspend)dispatch.BeginInvoke((Action)delegate{if(running)Emit("{\"kind\":\"gap\",\"epoch\":"+epoch+",\"at\":"+N(Now())+"}");Fence();running=false;});};
    timer=new System.Windows.Forms.Timer();timer.Interval=100;timer.Tick+=delegate{Observe();};timer.Start();Microsoft.Win32.SystemEvents.SessionSwitch+=delegate(object sender,Microsoft.Win32.SessionSwitchEventArgs e){if(e.Reason==Microsoft.Win32.SessionSwitchReason.SessionLock)dispatch.BeginInvoke((Action)delegate{Fence();running=false;revision++;key=null;Emit("{\"kind\":\"locked\"}");});};Emit("{\"kind\":\"ready\",\"permission\":true,\"clock\":"+Q(ClockId)+",\"at\":"+N(Now())+"}");
    var input=new Thread(delegate(){string line;while((line=Console.ReadLine())!=null){if(line.Length>4096)continue;try{var serializer=new DataContractJsonSerializer(typeof(PreviewCommand));var command=(PreviewCommand)serializer.ReadObject(new MemoryStream(Encoding.UTF8.GetBytes(line)));if(command.action=="start"||command.action=="stop"||command.action=="quit"){command.Receipt=Commands.Receive();work.Cancel();}dispatch.BeginInvoke((Action)delegate{Handle(command);});}catch{}}running=false;Commands.Receive();work.Cancel();try{dispatch.BeginInvoke((Action)delegate{Application.ExitThread();});}catch{}});input.IsBackground=true;input.Start();Application.Run(new ApplicationContext());Fence();running=false;timer.Stop();if(hook!=IntPtr.Zero)UnhookWinEvent(hook);if(destroyHook!=IntPtr.Zero)UnhookWinEvent(destroyHook);dispatch.Dispose();
  }
 }
}
