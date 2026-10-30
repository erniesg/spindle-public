using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using Spindle;
class ProcessingTests {
 static void Check(bool ok,string reason){if(!ok)throw new Exception(reason);}
 static void Main(){
  Check(WindowPixels.CanAllocate(7680,4320),"8K backing bitmap fits the declared memory budget");
  Check(!WindowPixels.CanAllocate(16384,16384)&&!WindowPixels.CanAllocate(int.MaxValue,int.MaxValue)&&!WindowPixels.CanAllocate(-1,100),"Impossible allocations must not overflow or allocate");
  Check(WindowPixels.OcrSize(3840,2160,10000)==new Size(2666,1500),"4K OCR fits its separate work budget, with full-window aspect ratio");
  Check(WindowPixels.OcrSize(3840,2160,1000)==new Size(1000,562),"Respect the OS OCR engine maximum");
  using(var bitmap=new Bitmap(3840,2160,PixelFormat.Format32bppRgb)){
   using(var g=Graphics.FromImage(bitmap))g.Clear(Color.White);
   var result=WindowPixels.Process(bitmap,true,true,10000,b=>{Check(b.Width==2666&&b.Height==1500,"OCR must receive its processing copy");return "INVENTED OCR";},()=>true);
   Check(result.Ocr=="local-ocr"&&result.Text=="INVENTED OCR","OCR result is retained");
   Check(result.Retention=="image-retained"&&result.ImageWidth==3840&&result.ImageHeight==2160,"OCR scaling must not reduce a compressible Rich image");
   foreach(var mode in new[]{0,1,2}){
    var failed=WindowPixels.Process(bitmap,true,true,mode==2?0:10000,b=>{if(mode==0)return null;throw new Exception("invented OCR failure");},()=>true);
    Check(failed.Ocr==(mode==0?"ocr-language-unavailable":mode==1?"ocr-failed":"ocr-engine-unavailable"),"Missing language, failed OCR, and unavailable engine remain distinct");
    Check(failed.Image.Length>0&&failed.Pixels=="captured","OCR failure must not discard Rich");
   }
   var ordinary=WindowPixels.Process(bitmap,false,true,10000,b=>"INVENTED",()=>true);
   Check(ordinary.Image==""&&ordinary.Retention=="image-not-requested","Pixels-only must not encode or retain a PNG");
   var cancelled=WindowPixels.Process(bitmap,true,true,10000,b=>"INVENTED",()=>false);
   Check(cancelled.Image==""&&cancelled.Text==""&&cancelled.Pixels=="pixels-cancelled","Cancelled work cannot expose results");
  }
  using(var noisy=new Bitmap(1920,1080,PixelFormat.Format32bppRgb)){
   var bytes=new byte[1920*1080*4];new Random(33).NextBytes(bytes);
   var bits=noisy.LockBits(new Rectangle(0,0,1920,1080),ImageLockMode.WriteOnly,PixelFormat.Format32bppRgb);
   try{for(int y=0;y<1080;y++)Marshal.Copy(bytes,y*1920*4,IntPtr.Add(bits.Scan0,y*bits.Stride),1920*4);}finally{noisy.UnlockBits(bits);}
   var result=WindowPixels.Process(noisy,true,false,0,b=>{throw new Exception("OCR was not requested");},()=>true);
   Check(result.Retention=="image-retained-reduced"&&result.ImageWidth<1920&&result.ImageHeight<1080,"Incompressible PNG must adapt to bytes rather than reject the window");
   var png=Convert.FromBase64String(result.Image);Check(png.Length<=2000000,"PNG must fit the existing transport and store budget");
   using(var stream=new MemoryStream(png))using(var decoded=new Bitmap(stream))Check(decoded.Width==result.ImageWidth&&decoded.Height==result.ImageHeight,"Declared retained dimensions must match actual PNG");
  }
  Console.WriteLine("PASS 4K/8K sizing, OCR-independent Rich, stage outcomes, Default, cancellation and adaptive PNG encoding");
 }
}
