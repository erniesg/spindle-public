using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
namespace Spindle {
 // CreateForWindow only. OS capture border remains enabled; no monitor fallback.
 // Construct/dispose on a background worker, never the foreground event pump.
 public sealed class WindowStream:IDisposable {
  [ComImport,Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface CaptureItemInterop {[PreserveSig]int CreateForWindow(IntPtr window,ref Guid iid,out IntPtr item);}
  [DllImport("d3d11.dll")]static extern int D3D11CreateDevice(IntPtr adapter,int driver,IntPtr software,uint flags,IntPtr levels,uint count,uint sdk,out IntPtr device,out uint level,out IntPtr context);
  [DllImport("d3d11.dll")]static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi,out IntPtr device);
  readonly LatestWindowFrame<Direct3D11CaptureFrame> frames=new LatestWindowFrame<Direct3D11CaptureFrame>();
  readonly Func<bool> allowed;readonly Func<double> now;readonly double qpcOffset,visitStart;
  IDirect3DDevice device;GraphicsCaptureItem item;Direct3D11CaptureFramePool pool;GraphicsCaptureSession session;SizeInt32 size;
  int cancelled,disposed,copiedFrames;string failure="pixels-awaiting-frame",terminalFailure;
  // Extraction polls at 500ms; allow that interval plus 250ms scheduling margin.
  // This is the queued-frame limit, not an accepted readback/coverage budget.
  public const double MaxFrameAgeMs=750;
  public string Availability {get{return Volatile.Read(ref terminalFailure)??failure;}}
  public bool IsCancelled {get{return Volatile.Read(ref cancelled)!=0;}}
  public bool HasCopiedFrame {get{return Volatile.Read(ref copiedFrames)!=0;}}
  bool Current(){return Volatile.Read(ref cancelled)==0&&allowed();}
  static IDirect3DDevice Device(){
   IntPtr native=IntPtr.Zero,context=IntPtr.Zero,dxgi=IntPtr.Zero,projected=IntPtr.Zero;uint level;
   try{
    int result=D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out native,out level,out context);
    if(result<0)result=D3D11CreateDevice(IntPtr.Zero,5,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out native,out level,out context);
    Marshal.ThrowExceptionForHR(result);var iid=new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    Marshal.ThrowExceptionForHR(Marshal.QueryInterface(native,ref iid,out dxgi));
    Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out projected));
    return (IDirect3DDevice)Marshal.GetObjectForIUnknown(projected);
   }finally{if(projected!=IntPtr.Zero)Marshal.Release(projected);if(dxgi!=IntPtr.Zero)Marshal.Release(dxgi);if(context!=IntPtr.Zero)Marshal.Release(context);if(native!=IntPtr.Zero)Marshal.Release(native);}
  }
  public WindowStream(IntPtr target,Func<bool> allowed,Func<double> now,double qpcOffset,double visitStart){
   this.allowed=allowed;this.now=now;this.qpcOffset=qpcOffset;this.visitStart=visitStart;
   try{
    if(!Current())throw new OperationCanceledException();
    if(!GraphicsCaptureSession.IsSupported())throw new NotSupportedException("pixels-stream-unsupported");
    var factory=(CaptureItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
    var iid=new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");IntPtr raw;
    Marshal.ThrowExceptionForHR(factory.CreateForWindow(target,ref iid,out raw));
    try{item=(GraphicsCaptureItem)Marshal.GetObjectForIUnknown(raw);}finally{Marshal.Release(raw);}
    size=item.Size;if(!WindowPixels.CanAllocate(size.Width,size.Height))throw new InvalidOperationException("pixels-memory-budget");
    device=Device();pool=Direct3D11CaptureFramePool.CreateFreeThreaded(device,DirectXPixelFormat.B8G8R8A8UIntNormalized,2,size);
    pool.FrameArrived+=Arrived;item.Closed+=Closed;session=pool.CreateCaptureSession(item);
    if(!Current())throw new OperationCanceledException();session.StartCapture();
   }catch{Dispose();throw;}
  }
  void Fail(string code){Interlocked.CompareExchange(ref terminalFailure,code,null);Cancel();}
  void Closed(GraphicsCaptureItem sender,object ignored){Fail("pixels-window-closed");}
  void Arrived(Direct3D11CaptureFramePool sender,object ignored){
   Direct3D11CaptureFrame frame=null;
   try{
    if(!Current())return;frame=sender.TryGetNextFrame();if(frame==null)return;
    if(!Current())return;
    if(frame.ContentSize.Width!=size.Width||frame.ContentSize.Height!=size.Height){Fail("pixels-window-changed");return;}
    double at=frame.SystemRelativeTime.TotalMilliseconds-qpcOffset;
    frames.Publish(frame,at,Current);frame=null;failure="pixels-captured-stream";
   }catch{if(Current())Fail("pixels-stream-unavailable");}
   finally{if(frame!=null)frame.Dispose();}
  }
  public Bitmap TakeBitmap(PreviewLease lease,out double capturedAt,out double framePTS,out string code){
   capturedAt=framePTS=0;code=Availability;
   if(!Current()||!lease.Current){code=Volatile.Read(ref cancelled)!=0?Availability:"pixels-cancelled";return null;}
   double at;var frame=frames.Take(visitStart,now(),MaxFrameAgeMs,()=>Current()&&lease.Current,out at);
   if(frame==null){if(Current())code="pixels-awaiting-fresh-frame";return null;}
   using(frame){
    if(!Current()||!lease.Current){code="pixels-cancelled";return null;}
    // A taken frame is owned by this worker, not the producer's newest-frame slot.
    using(var bitmap=SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface,BitmapAlphaMode.Ignore).AsTask().GetAwaiter().GetResult()){
     if(!Current()||!lease.Current){code="pixels-cancelled";return null;}
     if(bitmap.PixelWidth!=size.Width||bitmap.PixelHeight!=size.Height||!WindowPixels.CanAllocate(bitmap.PixelWidth,bitmap.PixelHeight)){code="pixels-window-changed";return null;}
     byte[] data=new byte[bitmap.PixelWidth*bitmap.PixelHeight*4];Bitmap result=null;
     try{
      bitmap.CopyToBuffer(data.AsBuffer());if(!Current()||!lease.Current){code="pixels-cancelled";return null;}
      result=new Bitmap(bitmap.PixelWidth,bitmap.PixelHeight,PixelFormat.Format32bppArgb);
      var bits=result.LockBits(new Rectangle(0,0,result.Width,result.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
      try{for(int y=0;y<result.Height;y++)Marshal.Copy(data,y*result.Width*4,IntPtr.Add(bits.Scan0,y*bits.Stride),result.Width*4);}finally{result.UnlockBits(bits);}
      if(!Current()||!lease.Current){result.Dispose();result=null;code="pixels-cancelled";return null;}
      capturedAt=at;framePTS=frame.SystemRelativeTime.TotalMilliseconds;code="captured";Interlocked.Exchange(ref copiedFrames,1);var owned=result;result=null;return owned;
     }finally{Array.Clear(data,0,data.Length);if(result!=null)result.Dispose();}
    }
   }
  }
  public void Cancel(){Interlocked.Exchange(ref cancelled,1);}
  public void Dispose(){
   Cancel();if(Interlocked.Exchange(ref disposed,1)!=0)return;
   frames.Dispose();
   try{if(session!=null)session.Dispose();}finally{
    try{if(pool!=null){pool.FrameArrived-=Arrived;pool.Dispose();}}finally{
     if(item!=null)item.Closed-=Closed;if(device!=null)device.Dispose();
    }
   }
  }
 }
}
