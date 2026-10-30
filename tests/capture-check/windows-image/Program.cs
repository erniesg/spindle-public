// Real Windows/GDI regression; no process admission or private desktop capture.
// The capture target is this test's own invented window. Invoke the production image path.
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
class Program {
 [STAThread] static void Main(string[] args){
  Application.EnableVisualStyles();var form=new Form{Text="Spindle invented large-window regression",Size=new Size(1920,1080),StartPosition=FormStartPosition.Manual,Location=new Point(30,30)};
  form.Controls.Add(new Label{Text="SPINDLE LARGE WINDOW\nINVENTED PIXELS",Font=new Font(FontFamily.GenericSansSerif,40),Dock=DockStyle.Fill});
  Exception failure=null;
  form.Shown+=delegate{var hwnd=form.Handle;var worker=new Thread(delegate(){try{
   var assembly=Assembly.LoadFrom(Path.GetFullPath(args[0]));var type=assembly.GetType("Spindle.PreviewProgram");
   var lease=Activator.CreateInstance(assembly.GetType("Spindle.PreviewLease"),new object[]{CancellationToken.None,(Func<bool>)(()=>true)});
   var method=type.GetMethod("Image",BindingFlags.Static|BindingFlags.NonPublic);
   var parameters=method.GetParameters();var call=new object[parameters.Length];call[0]=hwnd;call[1]=true;call[2]=false;call[3]=lease;
   for(int i=4;i<call.Length;i++)call[i]=null;
   var result=method.Invoke(null,call);string image=result as string;
   if(image==null)image=(string)result.GetType().GetField("Image").GetValue(result);
   if(String.IsNullOrEmpty(image))throw new Exception("A 1920x1080 authorized window must produce a Rich PNG without manual resizing");
   using(var stream=new MemoryStream(Convert.FromBase64String(image)))using(var bitmap=new Bitmap(stream)){
    if(bitmap.Width!=form.Width||bitmap.Height!=form.Height)throw new Exception("Compressible large-window PNG must keep its original dimensions");
   }
   Console.WriteLine("PASS actual production large-window capture retains full-resolution PNG");
  }catch(Exception e){failure=e.GetBaseException();}finally{form.BeginInvoke((Action)(()=>form.Close()));}});worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();};
  Application.Run(form);if(failure!=null){Console.Error.WriteLine(failure.Message);Environment.ExitCode=1;}
 }
}
