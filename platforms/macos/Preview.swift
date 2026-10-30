// Integrated PREVIEW adapter. Shared TypeScript owns visits, retention and controls.
// Direct Apple APIs; no imported third-party provider. Native build/execution pending.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision
import CoreMedia
import CoreVideo
import CoreImage
import Security
import Darwin

// NSRunningApplication.launchDate is absent for bare executable fixtures. Use
// kernel process-start identity instead; never replace a missing birth with PID/0.
func processBirth(_ pid:pid_t)->String? {
    guard pid>0 else{return nil}
    var info=proc_bsdinfo()
    let size=Int32(MemoryLayout<proc_bsdinfo>.stride)
    guard proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,size)==size,
          info.pbi_pid==UInt32(pid),info.pbi_start_tvsec>0,info.pbi_start_tvusec<1_000_000 else{return nil}
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}

let originTime = ProcessInfo.processInfo.systemUptime
let clockID = UUID().uuidString
func now() -> Double { (ProcessInfo.processInfo.systemUptime-originTime)*1000 }
func hostSeconds() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }
let outputLock = NSLock()
func emit(_ object: [String:Any]) {
    var packet=object;packet["schema"]="spindle-native-preview/v1"
    guard let data = try? JSONSerialization.data(withJSONObject: packet) else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
struct AXRead {let status:AXError;let value:CFTypeRef?}
func readAttr(_ e:AXUIElement,_ name:String)->AXRead {
    var value:CFTypeRef?;let status=AXUIElementCopyAttributeValue(e,name as CFString,&value)
    return AXRead(status:status,value:value)
}
func attr(_ e: AXUIElement,_ name: String) -> CFTypeRef? {let read=readAttr(e,name);return read.status == .success ? read.value : nil}
func leafStatus(_ status:AXError,_ leaf:Bool)->Bool {
    status == .success || (leaf && (status == .attributeUnsupported || status == .noValue))
}
func readChildren(_ e:AXUIElement,leaf:Bool=false)->[AXUIElement]? {
    let read=readAttr(e,"AXChildren")
    guard leafStatus(read.status,leaf) else{return nil}
    if read.status != .success{return []}
    return read.value as? [AXUIElement]
}
func expired(_ busy:Bool,_ started:Double,_ at:Double)->Bool {busy && at-started>3000}
final class ControlFence {
    private let lock=NSLock();private var received=0,active=0
    func receive()->Int{lock.lock();defer{lock.unlock()};received+=1;return received}
    func activate(_ value:Int){lock.lock();active=value;lock.unlock()}
    var current:Bool{lock.lock();defer{lock.unlock()};return received==active}
    func start(_ receipt:Int,_ setup:()->Void)->Bool {
        lock.lock();let admitted=receipt==received;if admitted{active=receipt};lock.unlock()
        guard admitted,current else{return false};setup();return current
    }
}
let controls=ControlFence()
func alreadyStopped(_ error:NSError)->Bool {
    error.domain==SCStreamErrorDomain && error.code==SCStreamError.Code.attemptToStopStreamState.rawValue
}
func stopSafely(_ operation:() async throws -> Void) async -> Bool {
    do{try await operation();return true}catch{return alreadyStopped(error as NSError)}
}
func string(_ e: AXUIElement,_ name: String) -> String { attr(e,name) as? String ?? "" }
// AX may expose window chrome as static text. A repeated title is not document
// content and must not suppress OCR. Conservatively ignore even a body label
// equal to the title; permitted pixels can still supply it through OCR.
func bodyText(_ value:String,_ title:String)->String {
    value.trimmingCharacters(in:.whitespacesAndNewlines)==title.trimmingCharacters(in:.whitespacesAndNewlines) ? "" : value
}

// Accessibility does not publish the WindowServer ID. Geometry remains the
// primary public bridge; exact titles only disambiguate otherwise identical
// same-process geometry. Never infer an ID from order or a partial title.
struct WindowCandidate:Equatable {
    let id:CGWindowID,title:String,layer:Int,onScreen:Bool
}
func resolveWindow(_ candidates:[WindowCandidate],title:String)->WindowCandidate? {
    let visible=candidates.filter{$0.onScreen && $0.layer==0}
    guard !visible.isEmpty else{return nil}
    if visible.count==1{return visible[0]}
    guard !title.isEmpty,visible.allSatisfy({!$0.title.isEmpty}) else{return nil}
    let exact=visible.filter{$0.title==title}
    return exact.count==1 ? exact[0] : nil
}

// Verify the live signed process, not just an attacker-controlled bundle identifier.
func signedSystemApp(_ app:NSRunningApplication,_ id:String) -> Bool {
    let paths=["com.apple.TextEdit":"/System/Applications/TextEdit.app/Contents/MacOS/TextEdit",
               "com.apple.Preview":"/System/Applications/Preview.app/Contents/MacOS/Preview",
               "com.apple.finder":"/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"]
    guard let path=paths[id],app.executableURL?.resolvingSymlinksInPath().path==path else{return false}
    var code:SecCode?,requirement:SecRequirement?
    guard SecCodeCopyGuestWithAttributes(nil,[kSecGuestAttributePid:NSNumber(value:app.processIdentifier)] as CFDictionary,[],&code)==errSecSuccess,
          SecRequirementCreateWithString("anchor apple and identifier \"\(id)\"" as CFString,[],&requirement)==errSecSuccess,
          let code=code,let requirement=requirement else{return false}
    return SecCodeCheckValidity(code,[],requirement)==errSecSuccess
}

struct Surface {var text="",complete=true}
// Optional bounded text extraction, never pixel admission. Unknown/image/editable
// subtrees make text incomplete and request OCR of the authorized window instead.
func scan(_ window:AXUIElement,current:()->Bool) -> Surface {
    var result=Surface(),stack:[(AXUIElement,Int)]=[(window,0)],lines:[String]=[],count=0
    let deadline=now()+120
    var sourcePID:pid_t=0
    guard current(),AXUIElementGetPid(window,&sourcePID) == .success else{result.complete=false;return result}
    let title=string(window,"AXTitle")
    while let (e,depth)=stack.popLast() {
        count+=1
        guard current(),count<=180,now()<=deadline else{result.complete=false;break}
        _ = AXUIElementSetMessagingTimeout(e,0.02)
        var elementPID:pid_t=0
        guard AXUIElementGetPid(e,&elementPID) == .success,elementPID==sourcePID else{result.complete=false;break}
        let hidden=readAttr(e,"AXHidden"),roleRead=readAttr(e,"AXRole")
        guard hidden.status == .success || hidden.status == .attributeUnsupported || hidden.status == .noValue,
              roleRead.status == .success,let role=roleRead.value as? String else{result.complete=false;break}
        if (hidden.value as? Bool)==true {continue}
        if role=="AXStaticText" {
            guard current() else{result.complete=false;break}
            let value=bodyText(string(e,"AXValue"),title)
            if !value.isEmpty{lines.append(String(value.prefix(512)))}
            continue
        }
        // Do not descend into password/editable/web/chrome or unknown surfaces.
        // Screenshots are NOT masked: explicit native window scope is the boundary.
        guard ["AXWindow","AXGroup","AXScrollArea","AXSplitGroup","AXList","AXOutline","AXRow","AXCell"].contains(role) else{result.complete=false;continue}
        guard let children=readChildren(e) else{result.complete=false;continue}
        if children.count>40 || depth>=8 {if !children.isEmpty{result.complete=false};continue}
        for child in children.reversed(){stack.append((child,depth+1))}
    }
    result.text=String(lines.joined(separator:"\n").prefix(4096));return result
}
func keychainKey() -> Data? {
    let query:[CFString:Any] = [kSecClass:kSecClassGenericPassword,kSecAttrService:"ai.berlayar.spindle.preview",kSecAttrAccount:"context-v1",kSecReturnData:true,kSecMatchLimit:kSecMatchLimitOne]
    var result:CFTypeRef?; let status=SecItemCopyMatching(query as CFDictionary,&result)
    if status==errSecSuccess { return result as? Data }
    guard status==errSecItemNotFound else { return nil }
    var bytes=[UInt8](repeating:0,count:32)
    guard SecRandomCopyBytes(kSecRandomDefault,bytes.count,&bytes)==errSecSuccess else { return nil }
    let data=Data(bytes)
    let add:[CFString:Any] = [kSecClass:kSecClassGenericPassword,kSecAttrService:"ai.berlayar.spindle.preview",kSecAttrAccount:"context-v1",kSecValueData:data]
    guard SecItemAdd(add as CFDictionary,nil)==errSecSuccess else { return nil };return data
}

let extractionQueue=DispatchQueue(label:"spindle.preview.extraction",qos:.userInitiated)
let pixelJobLock=NSLock()
var pixelJobBusy=false,pixelJobStarted=0.0
let maxCaptureWidth=1120,maxCaptureHeight=700
// ScreenCaptureKit gives window content in points plus its backing scale. Keep
// the target proportional to that content instead of letterboxing it in a
// fixed 1120x700 surface, while retaining the existing pixel limits.
func captureDimensions(_ contentRect:CGRect,_ pointPixelScale:CGFloat)->(width:Int,height:Int)? {
    guard contentRect.width.isFinite,contentRect.height.isFinite,pointPixelScale.isFinite,
          contentRect.width>0,contentRect.height>0,pointPixelScale>0 else{return nil}
    let sourceWidth=contentRect.width*pointPixelScale,sourceHeight=contentRect.height*pointPixelScale
    guard sourceWidth.isFinite,sourceHeight.isFinite else{return nil}
    let fit=min(1,min(CGFloat(maxCaptureWidth)/sourceWidth,CGFloat(maxCaptureHeight)/sourceHeight))
    let width=Int((sourceWidth*fit).rounded(.down)),height=Int((sourceHeight*fit).rounded(.down))
    guard width>0,height>0 else{return nil};return (width,height)
}
func sameCaptureBounds(_ left:CGSize,_ right:CGSize)->Bool {
    abs(left.width-right.width)<0.5 && abs(left.height-right.height)<0.5
}
func acceptsStartedCapture(_ expectedGeneration:Int,_ currentGeneration:Int,_ eligible:Bool)->Bool {
    expectedGeneration==currentGeneration && eligible
}
final class FrameWorker:NSObject,SCStreamOutput,SCStreamDelegate {
    weak var owner:PreviewRecorder?
    let epoch:Int,revision:Int,generation:Int,minimumPTS:Double
    private var lastPTS = -Double.infinity
    init(_ owner:PreviewRecorder,_ epoch:Int,_ revision:Int,_ generation:Int){
        self.owner=owner;self.epoch=epoch;self.revision=revision;self.generation=generation;minimumPTS=hostSeconds()
    }
    func stream(_ stream:SCStream,didStopWithError error:Error){
        DispatchQueue.main.async{guard let owner=self.owner,owner.worker===self else{return};owner.pixelFailure(self.revision,"pixels-unavailable-stream")}
    }
    func admitted()->Bool {
        DispatchQueue.main.sync {
            guard let owner=self.owner,owner.worker===self,owner.generation==self.generation else{return false}
            return owner.eligible(self.epoch,self.revision)
        }
    }
    func stream(_ stream:SCStream,didOutputSampleBuffer sample:CMSampleBuffer,of type:SCStreamOutputType){
        guard type == .screen,sample.isValid,
              let info=CMSampleBufferGetSampleAttachmentsArray(sample,createIfNecessary:false) as? [[SCStreamFrameInfo:Any]],
              let raw=info.first?[.status] as? Int,SCFrameStatus(rawValue:raw) == .complete else{return}
        let pts=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
        // SCStream PTS and this fence use the host clock, NOT the adapter's relative clock.
        guard pts.isFinite,pts>=minimumPTS,pts>lastPTS,hostSeconds()-pts>=0,hostSeconds()-pts<1 else{return}
        lastPTS=pts
        pixelJobLock.lock();if pixelJobBusy{pixelJobLock.unlock();return};pixelJobBusy=true;pixelJobStarted=now();pixelJobLock.unlock()
        extractionQueue.async {
            defer{pixelJobLock.lock();pixelJobBusy=false;pixelJobLock.unlock()}
            // Retain at most one sample; do not even access its pixel buffer until admitted.
            guard self.admitted() else{return}
            let state:(Bool,Bool)?=DispatchQueue.main.sync {
                guard let owner=self.owner else{return nil}
                // Rich text and PNG come from this same admitted frame, never a
                // cached AX read from another acquisition. Basic still prefers AX.
                return (owner.rich,owner.needsOCR || owner.rich)
            }
            guard let (rich,needOCR)=state,rich || needOCR,self.admitted(),
                  hostSeconds()-pts<1,
                  let pixels=CMSampleBufferGetImageBuffer(sample),CVPixelBufferGetWidth(pixels)<=1120,CVPixelBufferGetHeight(pixels)<=700 else{return}
            let at=now();var text="",image=""
            if needOCR {
                guard self.admitted() else{return}
                let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false
                if (try? VNImageRequestHandler(cvPixelBuffer:pixels,options:[:]).perform([request])) != nil {
                    text=String((request.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\n").prefix(4096))
                }
            }
            if rich {
                guard self.admitted() else{return}
                let ci=CIImage(cvPixelBuffer:pixels),context=CIContext()
                if let cg=context.createCGImage(ci,from:ci.extent) {
                    let rep=NSBitmapImageRep(cgImage:cg)
                    if let png=rep.representation(using:.png,properties:[:]),png.count<=2_000_000 {image=png.base64EncodedString()}
                }
            }
            guard self.admitted(),now()-at<2000 else{return}
            DispatchQueue.main.async {
                guard let owner=self.owner,owner.worker===self,owner.generation==self.generation,owner.eligible(self.epoch,self.revision) else{return}
                var message:[String:Any] = ["kind":"sample","epoch":self.epoch,"revision":self.revision,"at":at,"framePTS":pts,"frameClock":"screen-capture-kit","status":"pixel-window-readback","text":text,"textSource":"ocr"]
                if rich {message["image"]=image}
                emit(message)
            }
        }
    }
}
final class PreviewRecorder {
    var running=false,epoch=0,revision=0,rich=false,pixels=false,pixelAllowed=false,needsOCR=true
    var allowed=Set<String>(),key:String?=nil,window:AXUIElement?=nil,pid:pid_t=0,birth:String?=nil
    var known:[AXUIElement]=[],lastObservation=0.0,lastRead = -1000.0,textBusy=false,textStartedAt=0.0
    var stream:SCStream?,pendingStream:SCStream?,worker:FrameWorker?,starting=false,generation=0
    var startStartedAt=0.0,pendingStopRequested=false,stopOperations:[UUID:Double]=[:]
    var stopping:Bool{!stopOperations.isEmpty}
    var captureWindowID:CGWindowID?
    var captureBounds:CGSize?
    var lastActivity = -1000.0
    var trusted:[String:Bool]=[:]
    let supported:Set<String>=["com.apple.TextEdit","com.apple.Preview","com.apple.finder","spindlefixture"]
    init(){
        emit(["kind":"ready","permission":true,"at":now(),"clock":clockID])
        _ = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main){[weak self]_ in self?.observe()}
        _ = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.sessionDidResignActiveNotification,object:nil,queue:.main){[weak self]_ in self?.stop();emit(["kind":"locked"])}
        _ = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.willSleepNotification,object:nil,queue:.main){[weak self]_ in
            guard let self=self else{return};emit(["kind":"gap","epoch":self.epoch,"at":now()]);self.stop()
        }
        _ = Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){[weak self]_ in self?.observe()}
    }
    func command(_ c:[String:Any]) {
        guard c["schema"] as? String == "spindle-native-preview/v1" else{stop();emit(["kind":"error","code":"PROTOCOL_VERSION"]);return}
        switch c["action"] as? String {
        case "key":if let data=keychainKey(),data.count==32{emit(["kind":"key","value":data.base64EncodedString()])}else{emit(["kind":"key","value":""])}
        case "start":
            _ = controls.start(c["receiptSerial"] as? Int ?? -1) {
                stop();epoch=c["epoch"] as? Int ?? 0;revision=0;known=[];key="initial"
                allowed=Set(c["apps"] as? [String] ?? []).intersection(supported)
                guard controls.current else{return}
                let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                guard controls.current else{return}
                emit(["kind":"capability","code":AXIsProcessTrusted() ? "NATIVE_READY" : "ACCESSIBILITY_REQUIRED"])
                pixels=c["pixels"] as? Bool == true
                var screenGranted=CGPreflightScreenCaptureAccess()
                if pixels && !screenGranted{guard controls.current else{return};screenGranted=CGRequestScreenCaptureAccess()}
                guard controls.current else{return}
                emit(["kind":"capability","code":pixels ? (screenGranted ? "SCREEN_RECORDING_GRANTED" : "SCREEN_RECORDING_REQUIRED") : "SCREEN_RECORDING_NOT_REQUESTED"])
                pixels=pixels && screenGranted
                guard controls.current else{return}
                rich=(c["rich"] as? Bool == true)&&pixels
                running=true;lastObservation=now();observe()
            }
        case "stop":stop()
        case "quit":stop();NSApplication.shared.terminate(nil)
        default:break
        }
    }
    func stopStream(_ candidate:SCStream){
        let operation=UUID();stopOperations[operation]=now()
        Task{ @MainActor in
            defer{self.stopOperations.removeValue(forKey:operation)}
            if !(await stopSafely({try await candidate.stopCapture()})){emit(["kind":"error","code":"STREAM_STOP_FAILED"]);exit(1)}
        }
    }
    func stopPixels(){
        generation+=1;worker=nil;captureWindowID=nil;captureBounds=nil
        if let previous=stream{stream=nil;stopStream(previous)}
        if let pending=pendingStream,!pendingStopRequested{pendingStopRequested=true;stopStream(pending)}
    }
    func stop(){running=false;revision+=1;stopPixels();window=nil;key=nil;needsOCR=true}
    func pixelFailure(_ rev:Int,_ status:String){if revision==rev{stopPixels();emit(["kind":"sample","epoch":epoch,"revision":rev,"at":now(),"status":status])}}
    func current(_ e:Int,_ r:Int)->Bool {
        guard running,controls.current,e==epoch,r==revision,AXIsProcessTrusted(),let app=NSWorkspace.shared.frontmostApplication,
              app.processIdentifier==pid,let birth=birth,processBirth(pid)==birth,let window=window else{return false}
        let application=AXUIElementCreateApplication(pid);_ = AXUIElementSetMessagingTimeout(application,0.02)
        guard let focus=attr(application,"AXFocusedWindow"),CFGetTypeID(focus)==AXUIElementGetTypeID(),CFEqual(focus,window) else{return false}
        return true
    }
    func targetState(_ target:AXUIElement)->(point:CGPoint,dimensions:CGSize,title:String)? {
        guard let pos=attr(target,"AXPosition"),let size=attr(target,"AXSize"),
              CFGetTypeID(pos)==AXValueGetTypeID(),CFGetTypeID(size)==AXValueGetTypeID() else{return nil}
        var point=CGPoint.zero,dimensions=CGSize.zero
        guard AXValueGetValue(unsafeBitCast(pos,to:AXValue.self),.cgPoint,&point),AXValueGetValue(unsafeBitCast(size,to:AXValue.self),.cgSize,&dimensions) else{return nil}
        return (point,dimensions,string(target,"AXTitle"))
    }
    func cgCandidates(_ point:CGPoint,_ dimensions:CGSize)->[WindowCandidate] {
        let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        return list.compactMap { info in
            guard (info[kCGWindowOwnerPID as String] as? Int)==Int(pid),
                  let layer=info[kCGWindowLayer as String] as? Int,
                  let number=info[kCGWindowNumber as String] as? NSNumber,
                  let bounds=info[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:bounds as CFDictionary),
                  abs(rect.minX-point.x)<2 && abs(rect.minY-point.y)<2 && abs(rect.width-dimensions.width)<2 && abs(rect.height-dimensions.height)<2 else{return nil}
            return WindowCandidate(id:CGWindowID(number.uint32Value),title:info[kCGWindowName as String] as? String ?? "",layer:layer,onScreen:true)
        }
    }
    func eligible(_ e:Int,_ r:Int)->Bool {
        guard current(e,r),pixels,pixelAllowed,CGPreflightScreenCaptureAccess() else{return false}
        guard let captured=captureWindowID else{return true}
        guard let window=window,let state=targetState(window),current(e,r) else{return false}
        let matched=resolveWindow(cgCandidates(state.point,state.dimensions),title:state.title)
        guard captureBounds.map({sameCaptureBounds($0,state.dimensions)}) ?? true else{return false}
        guard current(e,r) else{return false}
        return matched?.id==captured
    }
    func observe(){
        let at=now()
        pixelJobLock.lock();let pixelExpired=expired(pixelJobBusy,pixelJobStarted,at);pixelJobLock.unlock()
        if pixelExpired || expired(textBusy,textStartedAt,at) || expired(starting,startStartedAt,at) || stopOperations.values.contains(where:{at-$0>3000}){
            if running{emit(["kind":"gap","epoch":epoch,"at":lastObservation])};emit(["kind":"error","code":"MAC_WORKER_TIMEOUT"]);stop();exit(1)
        }
        guard running,controls.current else{return}
        if at-lastObservation>1000{emit(["kind":"gap","epoch":epoch,"at":lastObservation]);stop();return}
        lastObservation=at;emit(["kind":"clock","at":at])
        if at-lastActivity>=1000 {
            lastActivity=at
            // Age only: no event taps, key values, pointer positions or raw stream.
            let types:[CGEventType]=[.keyDown,.mouseMoved,.leftMouseDown,.rightMouseDown,.scrollWheel]
            let ages=types.map {
                CGEventSource.secondsSinceLastEventType(.combinedSessionState,eventType:$0)
            }
            let age=ages.min() ?? -1
            let bucket = !age.isFinite || age<0 ? "unknown" : age<15 ? "under-15s" : age<60 ? "15s-1m" : age<300 ? "1m-5m" : "over-5m"
            emit(["kind":"activity","epoch":epoch,"at":at,"inputAgeBucket":bucket])
        }
        guard let app=NSWorkspace.shared.frontmostApplication else{stop();return}
        let fixturePath=Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("SpindleFixture").resolvingSymlinksInPath()
        let isFixture:Bool
        if let actual=app.executableURL?.resolvingSymlinksInPath(),let expected=fixturePath{isFixture=actual==expected}else{isFixture=false}
        let id=isFixture ? "spindlefixture" : (app.bundleIdentifier ?? "")
        let browser=["com.google.Chrome","org.chromium.Chromium"].contains(id)
        let incarnation=processBirth(app.processIdentifier)
        let stamp="\(app.processIdentifier):\(incarnation ?? "unavailable"):\(id)"
        if incarnation != nil && !isFixture && supported.contains(id) && trusted[stamp]==nil {
            if trusted.count>=32{trusted.removeAll()};trusted[stamp]=signedSystemApp(app,id)
        }
        let admitted=incarnation != nil && (isFixture || trusted[stamp]==true)
        var next:String?=nil,target:AXUIElement?=nil
        if browser,incarnation != nil {
            // Metadata only; no title/AX/OCR/pixel fallback for any browser state.
            let list=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
            if let top=list.first(where:{($0[kCGWindowOwnerPID as String] as? Int)==Int(app.processIdentifier)&&($0[kCGWindowLayer as String] as? Int)==0}),let wid=top[kCGWindowNumber as String] as? Int{next="browser:\(stamp):\(wid)"}
        } else if admitted,allowed.contains(id),AXIsProcessTrusted() {
            let application=AXUIElementCreateApplication(app.processIdentifier);_ = AXUIElementSetMessagingTimeout(application,0.02)
            if let value=attr(application,"AXFocusedWindow"),CFGetTypeID(value)==AXUIElementGetTypeID(){
                let w=unsafeBitCast(value,to:AXUIElement.self);_ = AXUIElementSetMessagingTimeout(w,0.02)
                if known.firstIndex(where:{CFEqual($0,w)})==nil,known.count<64{known.append(w)}
                if let index=known.firstIndex(where:{CFEqual($0,w)}){next="\(stamp):\(index)";target=w}
            }
        }
        if next != key {
            revision+=1;stopPixels();key=next;window=target;pid=app.processIdentifier;birth=incarnation
            pixelAllowed=admitted && allowed.contains(id) && !browser;needsOCR=true;lastRead = -1000
            guard controls.current else{return}
            let title=target.map{String(string($0,"AXTitle").prefix(256))} ?? ""
            guard controls.current else{return}
            emit(["kind":"focus","epoch":epoch,"revision":revision,"at":at,"clock":clockID,"key":next as Any? ?? NSNull(),"app":id,"title":title,"browser":browser])
        }
        // Acquisition is independent of optional AX text/layout availability.
        if self.stream != nil,!self.eligible(epoch,revision){self.stopPixels()}
        if let target=target,self.eligible(epoch,revision),self.stream==nil,!self.starting,!self.stopping{self.startPixels(target)}
        guard let target=target,at-lastRead>=500,!textBusy else{return};lastRead=at;textBusy=true;textStartedAt=at
        let e=epoch,r=revision
        extractionQueue.async {
            let valid={DispatchQueue.main.sync{self.current(e,r)}}
            let result=scan(target,current:valid)
            DispatchQueue.main.async {
                self.textBusy=false
                guard self.current(e,r) else{return}
                self.needsOCR = !result.complete || result.text.isEmpty
                // Do not interleave AX-only updates over an active atomic Rich stream.
                // If pixels are unavailable, fresh AX remains usable without an image.
                let atomicRich=self.rich && self.pixels && self.pixelAllowed && (self.stream != nil || self.starting)
                if (!self.pixels || !self.pixelAllowed || !self.needsOCR) && !atomicRich {
                    emit(["kind":"sample","epoch":e,"revision":r,"at":at,"text":result.text,"textSource":"native","status":result.complete ? "native-text" : "native-text-incomplete"])
                }
            }
        }
    }
    func startPixels(_ target:AXUIElement){
        let e=epoch,r=revision,p=pid,g=generation;starting=true;startStartedAt=now()
        Task { @MainActor in
            var owned:SCStream?
            defer{self.starting=false;if let owned=owned,self.pendingStream===owned{self.pendingStream=nil}}
            var failure="pixels-unavailable-shareable-content"
            do {
                guard self.generation==g,self.eligible(e,r) else{return}
                let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
                guard self.generation==g,self.eligible(e,r),let state=self.targetState(target),self.current(e,r) else{return}
                let candidates=content.windows.compactMap { candidate -> WindowCandidate? in
                    guard candidate.owningApplication?.processID==p,
                          abs(candidate.frame.minX-state.point.x)<2 && abs(candidate.frame.minY-state.point.y)<2 && abs(candidate.frame.width-state.dimensions.width)<2 && abs(candidate.frame.height-state.dimensions.height)<2 else{return nil}
                    return WindowCandidate(id:candidate.windowID,title:candidate.title ?? "",layer:candidate.windowLayer,onScreen:candidate.isOnScreen)
                }
                guard self.generation==g,self.eligible(e,r) else{return}
                guard let selected=resolveWindow(candidates,title:state.title),self.current(e,r) else{self.pixelFailure(r,"pixels-unavailable-association");return}
                self.captureWindowID=selected.id
                guard self.eligible(e,r) else{self.pixelFailure(r,"pixels-unavailable-association");return}
                guard let window=content.windows.first(where:{$0.windowID==selected.id}) else{self.pixelFailure(r,"pixels-unavailable-association");return}
                let filter=SCContentFilter(desktopIndependentWindow:window)
                guard let dimensions=captureDimensions(filter.contentRect,CGFloat(filter.pointPixelScale)) else{self.pixelFailure(r,"pixels-unavailable-stream-acquisition");return}
                self.captureBounds=state.dimensions
                failure="pixels-unavailable-stream-acquisition"
                let config=SCStreamConfiguration();config.width=dimensions.width;config.height=dimensions.height;config.scalesToFit=true;config.preservesAspectRatio=true;config.queueDepth=3;config.minimumFrameInterval=CMTime(value:1,timescale:2);config.capturesAudio=false;config.showsCursor=false;config.pixelFormat=kCVPixelFormatType_32BGRA
                let worker=FrameWorker(self,e,r,g),candidate=SCStream(filter:filter,configuration:config,delegate:worker)
                try candidate.addStreamOutput(worker,type:.screen,sampleHandlerQueue:DispatchQueue(label:"spindle.preview.frames"))
                owned=candidate;self.pendingStream=candidate;self.pendingStopRequested=false;self.worker=worker
                try await candidate.startCapture()
                if acceptsStartedCapture(g,self.generation,self.eligible(e,r)){self.captureWindowID=selected.id;self.worker=worker;self.stream=candidate}
                else {self.stopPixels()}
            }catch{if self.generation==g{self.pixelFailure(r,failure)}}
        }
    }
}
final class CanvasFixture:NSView {
    var count=0
    override func draw(_ dirtyRect:NSRect){NSColor.white.setFill();NSBezierPath(rect:bounds).fill();("SPINDLE CANVAS OCR\nINVENTED ONLY\nCOUNTER \(count)" as NSString).draw(in:bounds.insetBy(dx:24,dy:24),withAttributes:[.font:NSFont.monospacedSystemFont(ofSize:28,weight:.regular),.foregroundColor:NSColor.black])}
}
let app=NSApplication.shared
if CommandLine.arguments.contains("--policy-test") {
    // This helper is itself a bare executable: exercise the real kernel route,
    // independent of optional LaunchServices launch-date metadata.
    guard let ownBirth=processBirth(getpid()) else{fatalError("PROCESS_BIRTH_UNAVAILABLE")}
    precondition(processBirth(getpid())==ownBirth && processBirth(-1)==nil && processBirth(0)==nil)
    precondition(bodyText("Spindle canvas OCR","Spindle canvas OCR").isEmpty)
    precondition(bodyText("  Spindle canvas OCR\n","Spindle canvas OCR").isEmpty)
    precondition(bodyText("INVENTED ONLY\nCOUNTER 1","Spindle canvas OCR")=="INVENTED ONLY\nCOUNTER 1")
    let a=WindowCandidate(id:11,title:"Invented image A.png",layer:0,onScreen:true)
    let b=WindowCandidate(id:22,title:"Invented image B.png",layer:0,onScreen:true)
    precondition(resolveWindow([a],title:"")?.id==a.id)
    precondition(resolveWindow([a,b],title:"Invented image A.png")?.id==a.id)
    precondition(resolveWindow([b,a],title:"Invented image B.png")?.id==b.id)
    precondition(resolveWindow([a,b],title:"Invented image B.png")?.id != a.id)
    precondition(resolveWindow([a,b],title:"")==nil)
    precondition(resolveWindow([a,WindowCandidate(id:33,title:"Invented image A.png",layer:0,onScreen:true)],title:"Invented image A.png")==nil)
    precondition(resolveWindow([a,WindowCandidate(id:44,title:"",layer:0,onScreen:true)],title:"Invented image A.png")==nil)
    precondition(resolveWindow([a,WindowCandidate(id:55,title:"Invented image B.png",layer:1,onScreen:true)],title:"")?.id==a.id)
    precondition(resolveWindow([WindowCandidate(id:66,title:"Invented image B.png",layer:0,onScreen:false)],title:"Invented image B.png")==nil)
    // Regression: the real shortened Preview windows must not be padded to 700px.
    guard let imageA=captureDimensions(CGRect(x:0,y:0,width:560,height:322),2),let imageB=captureDimensions(CGRect(x:0,y:0,width:560,height:302),2),let bounded=captureDimensions(CGRect(x:0,y:0,width:1600,height:1000),2) else{preconditionFailure("capture dimensions unavailable")}
    precondition(imageA.width==1120 && imageA.height==644)
    precondition(imageB.width==1120 && imageB.height==604)
    precondition(bounded.width==1120 && bounded.height==700)
    if case .some = captureDimensions(CGRect(x:0,y:0,width:0,height:322),2){preconditionFailure("invalid dimensions admitted")}
    precondition(sameCaptureBounds(CGSize(width:560,height:322),CGSize(width:560,height:322)))
    precondition(!sameCaptureBounds(CGSize(width:560,height:322),CGSize(width:560,height:302)))
    // A resize can happen while startCapture awaits; reject and reset that stale stream.
    precondition(acceptsStartedCapture(7,7,true))
    precondition(!acceptsStartedCapture(7,7,false) && !acceptsStartedCapture(7,8,true))
    precondition(!leafStatus(.cannotComplete,true) && !leafStatus(.failure,true) && !leafStatus(.attributeUnsupported,false) && leafStatus(.attributeUnsupported,true))
    precondition(!expired(true,10000,10010) && expired(true,10000,13001) && !expired(false,0,10000))
    let fence=ControlFence();let start=fence.receive();_ = fence.receive();fence.activate(start);precondition(!fence.current)
    var reads=0
    precondition(!fence.start(start,{reads+=1}) && reads==0)
    let stopped=NSError(domain:SCStreamErrorDomain,code:SCStreamError.Code.attemptToStopStreamState.rawValue)
    precondition(alreadyStopped(stopped) && alreadyStopped(stopped) && !alreadyStopped(NSError(domain:"unrelated",code:stopped.code)))
    // Controlled completion orders exercise the SAME idempotent stop operation as SCStream.
    // These are policy oracles, not execution of Apple's stream lifecycle.
    let finished=DispatchSemaphore(value:0)
    Task.detached {
        for stopBeforeStart in [true,false] {
            var live = !stopBeforeStart
            let stop:() async throws -> Void = {
                guard live else{throw stopped};live=false
            }
            let first=await stopSafely(stop);precondition(first)
            if stopBeforeStart{live=true} // delayed successful start after an early stop
            let second=await stopSafely(stop);precondition(second && !live)
        }
        let unknown=await stopSafely({throw NSError(domain:"unrelated",code:stopped.code)});precondition(!unknown)
        finished.signal()
    }
    precondition(finished.wait(timeout:.now()+3) == .success)
    print("PASS native policy checks; no capture or permissions requested")
}else if CommandLine.arguments.contains("--fixture") {
    app.setActivationPolicy(.regular)
    var windows:[NSWindow]=[],labels:[NSTextField]=[]
    let canvas=CanvasFixture(frame:NSRect(x:0,y:0,width:550,height:250))
    for i in 0..<3 {
        let window=NSWindow(contentRect:NSRect(x:120+i*60,y:250-i*40,width:550,height:250),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
        window.title=i==2 ? "Spindle canvas OCR" : "Spindle native \(i==0 ? "A":"B")";window.isReleasedWhenClosed=false
        if i==2{window.contentView=canvas}else{let label=NSTextField(labelWithString:"");label.frame=NSRect(x:24,y:24,width:500,height:200);label.font = .systemFont(ofSize:26);window.contentView?.addSubview(label);labels.append(label)}
        windows.append(window);window.makeKeyAndOrderFront(nil)
    }
    var count=0
    let timer=Timer.scheduledTimer(withTimeInterval:1,repeats:true){_ in count+=1;canvas.count=count;canvas.needsDisplay=true;for(i,label)in labels.enumerated(){label.stringValue="SPINDLE NATIVE \(i==0 ? "A":"B")\nINVENTED ONLY\nCOUNTER \(count)"}}
    app.activate(ignoringOtherApps:true)
    withExtendedLifetime((windows,timer)){app.run()}
}else{
    app.setActivationPolicy(.accessory)
    let recorder=PreviewRecorder()
    DispatchQueue.global().async {
        while let line=readLine(){guard line.utf8.count<=4096,let data=line.data(using:.utf8),var c=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else{continue};if let action=c["action"] as? String,["start","stop","quit"].contains(action){c["receiptSerial"]=controls.receive()};DispatchQueue.main.async{recorder.command(c)}}
        DispatchQueue.main.async{recorder.stop();app.terminate(nil)}
    }
    withExtendedLifetime(recorder){app.run()}
}
