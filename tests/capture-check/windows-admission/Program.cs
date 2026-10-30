using System;
using Spindle;
class Program {
 static void Main(){
  if(PreviewAdmission.Allowed("notepad",@"C:\Users\sample\notepad.exe",@"C:\Windows\System32",@"C:\Preview\runtime"))throw new Exception("Spoofed app admitted");
  if(!PreviewAdmission.Allowed("notepad",@"C:\Windows\System32\notepad.exe",@"C:\Windows\System32",@"C:\Preview\runtime"))throw new Exception("System app denied");
  if(PreviewAdmission.Allowed("spindlefixture",@"C:\Other\SpindleFixture.exe",@"C:\Windows\System32",@"C:\Preview\runtime"))throw new Exception("Foreign fixture admitted");
  if(!PreviewAdmission.Allowed("spindlefixture",@"C:\Preview\runtime\SpindleFixture.exe",@"C:\Windows\System32",@"C:\Preview\runtime"))throw new Exception("Run-owned fixture denied");
  if(!PreviewAdmission.PhotosFamily("Microsoft.Windows.Photos_8wekyb3d8bbwe"))throw new Exception("OS Photos family denied");
  foreach(var family in new[]{"Microsoft.Windows.Photos_fakepublisher","Photos","",null})if(PreviewAdmission.PhotosFamily(family))throw new Exception("Unverified Photos family admitted");
  if(PreviewAdmission.PackageApp("Microsoft.WindowsNotepad_8wekyb3d8bbwe")!="notepad"||PreviewAdmission.PackageApp("Microsoft.Paint_8wekyb3d8bbwe")!="mspaint"||PreviewAdmission.PackageApp("Microsoft.Windows.Photos_8wekyb3d8bbwe")!="photos")throw new Exception("Approved ordinary Store family denied");
  foreach(var family in new[]{"Microsoft.WindowsNotepad_fakepublisher","Microsoft.Paint_fakepublisher","Microsoft.Paint_8wekyb3d8bbwe.extra","Notepad","",null})if(PreviewAdmission.PackageApp(family)!=null)throw new Exception("Unverified ordinary app family admitted");
  int nameReads=0;
  foreach(var gate in new[]{0,1,2,3,4}){
   var name=PreviewAdmission.ReadName(()=>gate!=0,gate==1,gate!=2,gate==3,gate!=4,()=>{nameReads++;return "INVENTED OFFSCREEN/EXCLUDED SENTINEL";});
   if(name!=null||nameReads!=0)throw new Exception("Excluded node reached Name-property acquisition");
  }
  if(PreviewAdmission.ReadName(()=>true,false,true,false,true,()=>{nameReads++;return "INVENTED VISIBLE LABEL";})!="INVENTED VISIBLE LABEL"||nameReads!=1)throw new Exception("Admitted name denied");
  foreach(var stopAt in new[]{0,1,2,3}){
   var cancel=new System.Threading.CancellationTokenSource();int reads=0;
   var lease=new PreviewLease(cancel.Token,()=>true);
   for(int stage=0;stage<4;stage++){if(stage==stopAt)cancel.Cancel();int value;lease.Try(()=>++reads,out value);}
   if(reads!=stopAt)throw new Exception("Paused work reached a later acquisition stage");
  }
  var commands=new PreviewCommandFence();int queuedStart=commands.Receive();commands.Receive();commands.Activate(queuedStart);
  if(commands.Current)throw new Exception("Queued Start bypassed a later received Pause");
  int acquired=0;var queue=new System.Collections.Generic.Queue<Action>();
  queue.Enqueue(()=>commands.TryStart(queuedStart,()=>{acquired++;commands.TryRead(()=>acquired++);}));
  queue.Dequeue()();if(acquired!=0)throw new Exception("Superseded queued Start reached setup/title acquisition");
  int resume=commands.Receive();commands.Activate(resume);if(!commands.Current)throw new Exception("Fresh Start denied");
  bool focused=true;var active=new PreviewLease(System.Threading.CancellationToken.None,()=>focused);int ignored;
  if(active.Try(()=>{focused=false;return 1;},out ignored))throw new Exception("Changed target committed");
  if(active.Try(()=>{throw new Exception("Unfocused work read content");},out ignored))throw new Exception("Unfocused work admitted");
  Console.WriteLine("PASS production identity/each-stage cancellation guard; invented inputs, no Windows API execution");
 }
}
