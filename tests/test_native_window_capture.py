"""Source wiring contracts only: no AX/UIA, pixels or native acceptance proof."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativeWindowCaptureTests(unittest.TestCase):
    def test_mac_pixels_do_not_depend_on_text_or_edit_policy(self):
        source = (ROOT / 'platforms/macos/Preview.swift').read_text()
        worker = source.split('final class FrameWorker', 1)[1].split('final class PreviewRecorder', 1)[0]
        start = source.split('func startPixels(', 1)[1].split('final class CanvasFixture', 1)[0]
        for path in (worker, start):
            for forbidden in ('scan(', '.safe', 'surfaceSafe', 'previewViewing', 'AXEdited', 'PreviewImagePolicy'):
                self.assertNotIn(forbidden, path)
        observe = source.split('func observe()', 1)[1].split('func startPixels(', 1)[0]
        self.assertLess(observe.index('self.startPixels(target)'), observe.index('let result=scan('))
        self.assertIn('needsOCR = !result.complete || result.text.isEmpty', observe)
        for fence in ('owner.worker===self', 'owner.generation==self.generation', 'owner.eligible(', 'hostSeconds()-pts<1'):
            self.assertIn(fence, worker)
        eligible = source.split('func eligible(', 1)[1].split('func observe()', 1)[0]
        self.assertIn('current(e,r),pixels,pixelAllowed,CGPreflightScreenCaptureAccess()', eligible)
        self.assertIn('resolveWindow(', eligible)
        self.assertIn('processBirth(pid)==birth', source)
        self.assertIn('pixelAllowed=admitted && allowed.contains(id) && !browser', source)
        self.assertIn('bodyText(string(e,"AXValue"),title)', source)
        self.assertIn('SCREEN_RECORDING_GRANTED', source)
        self.assertIn('SCREEN_RECORDING_REQUIRED', source)
        self.assertIn('pixels-unavailable-association', start)
        self.assertIn('pixels-unavailable-stream-acquisition', start)

    def test_mac_rich_samples_ocr_their_own_frame_and_do_not_split_ax_over_it(self):
        source = (ROOT / 'platforms/macos/Preview.swift').read_text()
        worker = source.split('final class FrameWorker', 1)[1].split('final class PreviewRecorder', 1)[0]
        observe = source.split('func observe()', 1)[1].split('func startPixels(', 1)[0]
        self.assertIn('owner.needsOCR || owner.rich', worker)
        self.assertIn('"text":text,"textSource":"ocr"', worker)
        self.assertIn('let atomicRich=', observe)
        self.assertIn('&& !atomicRich', observe)

    def test_mac_same_geometry_uses_exact_nonempty_window_title(self):
        source = (ROOT / 'platforms/macos/Preview.swift').read_text()
        self.assertIn('struct WindowCandidate', source)
        self.assertIn('func resolveWindow(', source)
        self.assertIn('title.isEmpty', source)
        self.assertIn('visible.count==1', source)
        self.assertIn('$0.title==title', source)
        self.assertIn('resolveWindow(candidates,title:state.title)', source)
        self.assertIn('return matched?.id==captured', source)

    def test_mac_worker_is_owned_before_stream_start_can_deliver_frames(self):
        source = (ROOT / 'platforms/macos/Preview.swift').read_text()
        start = source.split('func startPixels(', 1)[1].split('final class CanvasFixture', 1)[0]
        self.assertLess(start.index('self.pendingStream=candidate'), start.index('self.worker=worker'))
        self.assertLess(start.index('self.worker=worker'), start.index('try await candidate.startCapture()'))
        self.assertLess(start.index('try await candidate.startCapture()'), start.index('self.stream=candidate'))
    def test_windows_pixels_do_not_depend_on_uia_layout(self):
        source = (ROOT / 'platforms/windows/Preview.cs').read_text()
        image = source.split('static WindowPixelResult Image(', 1)[1].split('static void Observe(', 1)[0]
        for forbidden in ('Inspect(', '.Safe', 'ReadOnlyImage', 'ImageBounds', 'photos'):
            self.assertNotIn(forbidden, image)
        observe = source.split('static void Observe(', 1)[1].split('static void Handle(', 1)[0]
        self.assertIn('wantPixels=pixels', observe)
        self.assertNotIn('surface.Safe', observe)
        self.assertIn('if(next==null||browser||pending', observe)
        self.assertIn('native-text-unavailable', observe)
        self.assertIn('needOCR=wantImage||photos||surface==null||!surface.Complete||text.Length==0', observe)
        for fence in ('lease.Current', 'PhysicalPixels()', 'SameRect(hwnd,rect)', 'active.TakeBitmap(lease'):
            self.assertIn(fence, image)
        self.assertNotIn('PrintWindow(', source)
        self.assertIn('if(Supported.Contains(app))allowed.Add(app)', source)
        self.assertIn('pixels=c.pixels;rich=c.rich&&pixels', source)
        self.assertIn('GetForegroundWindow()==target&&Identity(target,out check)==k', observe)
        for selector in ('PhotosCanvas', 'PhotosViewingButton', 'PhotosZoom', 'ReadOnlyImage'):
            self.assertNotIn(selector, source)

    def test_windows_rich_uses_same_bitmap_ocr_not_an_earlier_uia_read(self):
        source = (ROOT / 'platforms/windows/Preview.cs').read_text()
        observe = source.split('static void Observe(', 1)[1].split('static void Handle(', 1)[0]
        self.assertIn('try{if(!wantImage){', observe)
        self.assertIn('needOCR=wantImage||photos||surface==null||!surface.Complete||text.Length==0', observe)
        self.assertIn('if(needOCR){text=capture.Text;textSource="ocr";}', observe)
        self.assertIn('if(wantImage&&capture!=null&&capture.Pixels!="captured")', observe)
        self.assertIn('sampledAt=Now();image="";', observe)

    def test_windows_input_eof_invalidates_queued_start_before_exit_dispatch(self):
        source = (ROOT / 'platforms/windows/Preview.cs').read_text()
        reader = source.split('var input=new Thread(delegate(){', 1)[1]
        self.assertIn('running=false;Commands.Receive();work.Cancel();try', reader)

    def test_permission_states_are_exposed_independently(self):
        app = (ROOT / 'core/preview/app.ts').read_text()
        self.assertIn("capabilities.accessibility=e.code==='NATIVE_READY'?'granted':'required'", app)
        self.assertIn("capabilities.screenRecording=e.code==='SCREEN_RECORDING_GRANTED'?'granted':'required'", app)
        self.assertIn('lastCode,capabilities,pair:', app)
        self.assertIn('code:lastCode,capabilities', app)
        ui = (ROOT / 'core/preview/ui.ts').read_text()
        self.assertIn('Accessibility: ${state.capabilities.accessibility}', ui)
        self.assertIn('Screen Recording: ${state.capabilities.screenRecording}', ui)

    def test_preview_start_and_signin_share_exclusive_owner_and_publish_sink_after_async_fences(self):
        source = (ROOT / 'core/preview/app.ts').read_text()
        signin = source.split("if(req.url==='/tracking/signin')", 1)[1].split("else if(req.url==='/tracking/sync')", 1)[0]
        start = source.split("else if(req.url==='/start')", 1)[1].split("else if(req.url==='/pause')", 1)[0]
        self.assertIn('await controls.run(async()=>{', signin)
        self.assertIn('await controls.run(async()=>{', start)
        self.assertIn('await saveSettings();checkStart();', start)
        self.assertLess(start.index('await saveSettings();checkStart();'), start.index('new CollectorHistory('))
        self.assertLess(start.index('new CollectorHistory('), start.index('session.start(preferences)'))
        self.assertIn('await stopHistory();throw e;', start)
        helper = source.split('export async function signinPausedCollector(', 1)[1].split('export async function runPreview(', 1)[0]
        self.assertEqual(helper.count("throw Error('SIGNIN_CANCELLED')"), 2)

    def test_launcher_and_package_use_only_active_swift_source(self):
        launcher = (ROOT / 'platforms/macos/start-preview.command').read_text()
        package = (ROOT / 'tools/package_preview.py').read_text()
        self.assertNotIn('PreviewImagePolicy.swift', launcher)
        self.assertNotIn('PreviewImagePolicy.swift', package)
        self.assertIn('"$root/platforms/macos/Preview.swift"', launcher)
        self.assertIn("ROOT/'platforms/macos/Preview.swift'", package)


if __name__ == '__main__':
    unittest.main()
