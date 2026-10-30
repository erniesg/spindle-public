using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace Spindle {
 public sealed class WindowPixelResult {
  public string Text="",Image="",Pixels="captured",Ocr="ocr-not-requested",Retention="image-not-requested";
  public int SourceWidth,SourceHeight,ImageWidth,ImageHeight,OcrWidth,OcrHeight;
  public double CapturedAt,FramePTS=-1;
  public bool NoChange;
  public string Status(bool needOcr,bool retain){return Pixels!="captured"?Pixels:retain&&Image.Length==0?Retention:needOcr?Ocr:"native-text";}
  public static WindowPixelResult Failure(string code){return new WindowPixelResult{Pixels=code,Ocr="ocr-not-run",Retention="image-not-run"};}
 }
 public static class WindowPixels {
  // Resource budgets, independent of the user's window dimensions. One native worker owns these buffers.
  // 128 MiB supports an 8K backing bitmap; OCR has separate bounded scratch buffers.
  public const long MaxBitmapBytes=128L*1024*1024;
  public const int MaxOcrPixels=4000000,MaxImageBytes=2000000;
  public static bool CanAllocate(int width,int height){return width>0&&height>0&&(long)width*height<=MaxBitmapBytes/4;}
  public static Size OcrSize(int width,int height,int maxDimension){
   if(maxDimension<=0)throw new ArgumentOutOfRangeException("maxDimension");
   double scale=Math.Min(1,Math.Min((double)maxDimension/Math.Max(width,height),Math.Sqrt((double)MaxOcrPixels/((long)width*height))));
   return new Size(Math.Max(1,(int)(width*scale)),Math.Max(1,(int)(height*scale)));
  }
  static Bitmap Resize(Bitmap source,int width,int height){
   var bitmap=new Bitmap(width,height,PixelFormat.Format32bppArgb);
   try{using(var graphics=Graphics.FromImage(bitmap)){graphics.CompositingMode=CompositingMode.SourceCopy;graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(source,new Rectangle(0,0,width,height));}return bitmap;}
   catch{bitmap.Dispose();throw;}
  }
  sealed class BoundedPng:MemoryStream {
   public bool Exceeded;
   public override void Write(byte[] buffer,int offset,int count){if(Position+count>MaxImageBytes){Exceeded=true;throw new IOException("PNG_BYTE_BUDGET");}base.Write(buffer,offset,count);}
   public override void WriteByte(byte value){if(Position>=MaxImageBytes){Exceeded=true;throw new IOException("PNG_BYTE_BUDGET");}base.WriteByte(value);}
   public override void SetLength(long value){if(value>MaxImageBytes){Exceeded=true;throw new IOException("PNG_BYTE_BUDGET");}base.SetLength(value);}
  }
  public static WindowPixelResult Process(Bitmap source,bool retain,bool needOcr,int maxOcrDimension,Func<Bitmap,string> recognize,Func<bool> current){
   var result=new WindowPixelResult{SourceWidth=source.Width,SourceHeight=source.Height};
   if(needOcr){
    if(maxOcrDimension<=0)result.Ocr="ocr-engine-unavailable";
    else try{
     if(!current())return WindowPixelResult.Failure("pixels-cancelled");
     var size=OcrSize(source.Width,source.Height,maxOcrDimension);result.OcrWidth=size.Width;result.OcrHeight=size.Height;
     using(var bitmap=Resize(source,size.Width,size.Height)){
      if(!current())return WindowPixelResult.Failure("pixels-cancelled");
      var text=recognize(bitmap);result.Text=text??"";result.Ocr=text==null?"ocr-language-unavailable":text.Length==0?"ocr-empty":"local-ocr";
     }
    }catch{result.Text="";result.Ocr="ocr-failed";}
   }
   if(retain){
    // Encode full resolution first. Reduce only if the existing wire/store byte budget requires it.
    int width=source.Width,height=source.Height;
    while(true){
     if(!current())return WindowPixelResult.Failure("pixels-cancelled");
     Bitmap reduced=null;
     try{
      var bitmap=width==source.Width&&height==source.Height?source:(reduced=Resize(source,width,height));
      using(var stream=new BoundedPng()){
       try{bitmap.Save(stream,ImageFormat.Png);}
       catch{if(!stream.Exceeded){result.Retention="image-encode-failed";break;}}
       if(!stream.Exceeded){result.Image=Convert.ToBase64String(stream.ToArray());result.ImageWidth=width;result.ImageHeight=height;result.Retention=reduced==null?"image-retained":"image-retained-reduced";break;}
      }
     }catch{result.Retention="image-encode-failed";break;}
     finally{if(reduced!=null)reduced.Dispose();}
     if(width==1&&height==1){result.Retention="image-byte-budget";break;}
     double scale=Math.Min((double)width/source.Width,(double)height/source.Height)*0.75;
     width=Math.Max(1,(int)(source.Width*scale));height=Math.Max(1,(int)(source.Height*scale));
    }
   }
   return current()?result:WindowPixelResult.Failure("pixels-cancelled");
  }
 }
}
