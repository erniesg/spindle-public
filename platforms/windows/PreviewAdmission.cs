using System;
namespace Spindle {
 public static class PreviewAdmission {
  public static string ReadName(Func<bool> current,bool offscreen,bool sameProcess,bool password,bool roleAdmitted,Func<string> read){
   if(offscreen||!sameProcess||password||!roleAdmitted||!current())return null;
   var name=read();return current()?name:null;
  }
  public static bool PhotosFamily(string family){return String.Equals(family,"Microsoft.Windows.Photos_8wekyb3d8bbwe",StringComparison.Ordinal);}
  public static string PackageApp(string family){
   if(PhotosFamily(family))return "photos";
   if(String.Equals(family,"Microsoft.WindowsNotepad_8wekyb3d8bbwe",StringComparison.Ordinal))return "notepad";
   if(String.Equals(family,"Microsoft.Paint_8wekyb3d8bbwe",StringComparison.Ordinal))return "mspaint";
   return null;
  }
  static string Clean(string path){return (path??"").Replace('/','\\').TrimEnd('\\');}
  public static bool Allowed(string app,string executable,string systemDirectory,string fixtureDirectory){
   string system=Clean(systemDirectory),actual=Clean(executable),expected=null;
   if(app=="spindlefixture")expected=Clean(fixtureDirectory)+"\\SpindleFixture.exe";
   else if(app=="notepad"||app=="mspaint")expected=system+"\\"+app+".exe";
   else if(app=="explorer"){int end=system.LastIndexOf('\\');if(end>0)expected=system.Substring(0,end)+"\\explorer.exe";}
   // Store families are admitted separately through live signed package identity.
   // WordPad/unknown relocations lack a verified path: fail closed.
   return expected!=null&&String.Equals(actual,expected,StringComparison.OrdinalIgnoreCase);
  }
 }
}
