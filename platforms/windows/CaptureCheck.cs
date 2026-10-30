// Native smoke-test provider. Only explicitly allowed synthetic fixture PIDs
// are read. Windows UI Automation runs off the message-loop thread.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Spindle {
    public static class NativeProgram {
        [STAThread]
        public static void Main(string[] args) {
            try { CaptureCheck.Run(Array.IndexOf(args, "--fixture") >= 0); }
            catch { Console.WriteLine("{\"kind\":\"error\",\"code\":\"HELPER_EXITED\"}"); Environment.ExitCode = 1; }
        }
    }
    [DataContract]
    public class Command {
        [DataMember] public string action;
        [DataMember] public int epoch;
        [DataMember] public int[] pids;
        [DataMember] public string target;
    }
    public static class CaptureCheck {
        static readonly Stopwatch Clock = Stopwatch.StartNew();
        static readonly object OutputLock = new object();
        static Control dispatch;
        static bool running, pending;
        static int epoch, revision;
        static string key;
        static IntPtr currentWindow;
        static HashSet<int> allowed = new HashSet<int>();
        static double lastRead = -1000;
        static readonly ObservationContinuity continuity = new ObservationContinuity();
        static System.Windows.Forms.Timer timer;
        static WinEventDelegate callback;
        static IntPtr foregroundHook, focusHook;
        static Dictionary<string, Form> fixtures = new Dictionary<string, Form>();
        static Dictionary<string, Label> labels = new Dictionary<string, Label>();
        static int update;
        static readonly string OwnExecutable = Process.GetCurrentProcess().MainModule.FileName;
        static bool IsFixtureProcess(int pid) {
            if (pid == Process.GetCurrentProcess().Id) return false;
            try {
                using (Process process = Process.GetProcessById(pid)) {
                    return String.Equals(process.MainModule.FileName, OwnExecutable, StringComparison.OrdinalIgnoreCase);
                }
            } catch { return false; }
        }
        delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventDelegate cb, uint pid, uint thread, uint flags);
        [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        static double Now() { return Clock.Elapsed.TotalMilliseconds; }
        static string Q(string value) {
            if (value == null) return "null";
            StringBuilder b = new StringBuilder("\"");
            foreach (char c in value) {
                if (c == '"') b.Append("\\\"");
                else if (c == '\\') b.Append("\\\\");
                else if (c < 32) b.Append("\\u" + ((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }
        static string N(double value) { return value.ToString("F3", System.Globalization.CultureInfo.InvariantCulture); }
        static void Emit(string json) { lock (OutputLock) Console.WriteLine(json); }
        static string Prefix(string s, int max) { return s.Length > max ? s.Substring(0, max) : s; }
        static void Observe(uint? eventTick = null) {
            if (!running) return;
            double at = Now();
            if (!continuity.Observe(at, unchecked((uint)Environment.TickCount), eventTick)) {
                running = false; key = null; currentWindow = IntPtr.Zero;
                Emit("{\"kind\":\"coverageGap\",\"at\":" + N(continuity.ReliableThrough) + ",\"epoch\":" + epoch + "}");
                return;
            }
            IntPtr hwnd = GetForegroundWindow();
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            string nextKey = allowed.Contains((int)pid) && IsFixtureProcess((int)pid) ? pid.ToString() + ":" + hwnd.ToInt64().ToString() : null;
            if (nextKey != key) {
                key = nextKey;
                currentWindow = nextKey == null ? IntPtr.Zero : hwnd;
                revision++;
                string title = "";
                if (nextKey != null) {
                    StringBuilder caption = new StringBuilder(257);
                    GetWindowText(hwnd, caption, caption.Capacity);
                    title = Prefix(caption.ToString(), 256);
                }
                Emit("{\"kind\":\"focus\",\"at\":" + N(at) + ",\"epoch\":" + epoch + ",\"revision\":" + revision + ",\"key\":" + Q(key) + ",\"title\":" + Q(title) + "}");
            }
            if (key == null || pending || at - lastRead < 250) return;
            pending = true;
            lastRead = at;
            string jobKey = key;
            int jobEpoch = epoch, jobRevision = revision;
            IntPtr jobWindow = currentWindow;
            Thread worker = new Thread(delegate() {
                string text = "";
                string status = "ok";
                try { text = ReadText(jobWindow); if (text.Length == 0) status = "empty"; }
                catch { status = "unavailable"; } // Exceptions may contain user paths: never emit them.
                try {
                    dispatch.BeginInvoke((Action)delegate {
                        pending = false;
                        Observe(); // Revalidate actual focus before publishing optional context.
                        if (!running || epoch != jobEpoch || revision != jobRevision || key != jobKey) return;
                        Emit("{\"kind\":\"text\",\"at\":" + N(at) + ",\"epoch\":" + jobEpoch + ",\"revision\":" + jobRevision + ",\"key\":" + Q(jobKey) + ",\"text\":" + Q(text) + ",\"status\":" + Q(status) + "}");
                    });
                } catch { } // The owning message loop may already be closed.
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        }
        static string ReadText(IntPtr hwnd) {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            Stack<KeyValuePair<AutomationElement, int>> stack = new Stack<KeyValuePair<AutomationElement, int>>();
            stack.Push(new KeyValuePair<AutomationElement, int>(root, 0));
            StringBuilder result = new StringBuilder();
            Stopwatch budget = Stopwatch.StartNew();
            int count = 0;
            while (stack.Count > 0 && count++ < 120 && budget.ElapsedMilliseconds < 180 && result.Length < 4000) {
                KeyValuePair<AutomationElement, int> item = stack.Pop();
                AutomationElement element = item.Key;
                AutomationElement.AutomationElementInformation current = element.Current;
                if (current.IsPassword || current.IsOffscreen || current.ControlType == ControlType.Edit || current.ControlType == ControlType.ComboBox) continue;
                if (current.ControlType == ControlType.Text && !String.IsNullOrEmpty(current.Name)) result.AppendLine(current.Name);
                if (item.Value >= 7) continue;
                AutomationElement child = TreeWalker.ControlViewWalker.GetFirstChild(element);
                int children = 0;
                while (child != null && children++ < 40 && budget.ElapsedMilliseconds < 180) {
                    stack.Push(new KeyValuePair<AutomationElement, int>(child, item.Value + 1));
                    child = TreeWalker.ControlViewWalker.GetNextSibling(child);
                }
            }
            return Prefix(result.ToString(), 4096);
        }
        static void Handle(Command command) {
            if (command.action == "quit") { running = false; Application.ExitThread(); return; }
            if (command.action == "activate" && fixtures.ContainsKey(command.target ?? "")) {
                Form form = fixtures[command.target];
                if (form.IsDisposed) { Emit("{\"kind\":\"error\",\"code\":\"FIXTURE_FAILED\"}"); return; }
                form.Show(); form.BringToFront(); form.Activate();
                if (!SetForegroundWindow(form.Handle)) Emit("{\"kind\":\"activationDenied\"}");
                return;
            }
            if (command.action == "start") {
                running = false;
                epoch = command.epoch;
                allowed = new HashSet<int>(command.pids ?? new int[0]);
                revision = 0;
                key = "not-an-actual-window";
                currentWindow = IntPtr.Zero;
                lastRead = -1000;
                continuity.Start(Now());
                running = true;
                Observe();
            }
            if (command.action == "stop") {
                Observe(); // A queued stop must not hide a stall by beating the timer callback.
                running = false; key = null; currentWindow = IntPtr.Zero;
                Emit("{\"kind\":\"stopped\",\"at\":" + N(Now()) + ",\"epoch\":" + epoch + "}");
            }
        }
        static void MakeFixtures() {
            foreach (string target in new string[] { "A", "B" }) {
                string name = target;
                Form form = new Form();
                form.Text = "Spindle Test " + name;
                form.Size = new Size(620, 320);
                form.StartPosition = FormStartPosition.Manual;
                form.Location = new Point(name == "A" ? 100 : 250, name == "A" ? 100 : 220);
                Label label = new Label();
                label.AutoSize = false;
                label.Dock = DockStyle.Fill;
                label.Padding = new Padding(24);
                label.Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 19);
                form.Controls.Add(label);
                form.Activated += delegate { Emit("{\"kind\":\"fixtureFocus\",\"target\":" + Q(name) + ",\"at\":" + N(Now()) + "}"); };
                fixtures[name] = form; labels[name] = label;
                form.Show();
            }
            timer = new System.Windows.Forms.Timer();
            timer.Interval = 500;
            timer.Tick += delegate {
                foreach (KeyValuePair<string, Label> pair in labels) {
                    pair.Value.Text = "SPINDLE TEST " + pair.Key + "\nInvented " + (pair.Key == "A" ? "learning" : "leisure") + " example\nContent update: " + update + "\nThis text changes without switching windows.";
                }
                update++;
            };
            timer.Start();
        }
        public static void Run(bool fixtureMode) {
            Console.OutputEncoding = new UTF8Encoding(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            Application.EnableVisualStyles();
            dispatch = new Control();
            IntPtr handle = dispatch.Handle;
            if (fixtureMode) MakeFixtures();
            else {
                callback = delegate(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time) { Observe(time); };
                foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
                focusHook = SetWinEventHook(0x8005, 0x8005, IntPtr.Zero, callback, 0, 0, 0);
                timer = new System.Windows.Forms.Timer();
                timer.Interval = 50; timer.Tick += delegate { Observe(); }; timer.Start();
            }
            Emit("{\"kind\":\"ready\",\"at\":" + N(Now()) + ",\"permission\":true}");
            Thread input = new Thread(delegate() {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (line.Length > 4096) continue;
                    try {
                        DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(Command));
                        Command command = (Command)serializer.ReadObject(new MemoryStream(Encoding.UTF8.GetBytes(line)));
                        dispatch.BeginInvoke((Action)delegate { Handle(command); });
                    } catch { }
                }
                try { dispatch.BeginInvoke((Action)delegate { Application.ExitThread(); }); } catch { }
            });
            input.IsBackground = true; input.Start();
            Application.Run(new ApplicationContext());
            running = false;
            if (timer != null) timer.Stop();
            if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
            if (focusHook != IntPtr.Zero) UnhookWinEvent(focusHook);
            foreach (Form form in fixtures.Values) form.Dispose();
            dispatch.Dispose();
        }
    }
}
