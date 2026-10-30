// Capture Check's first provider: permissioned AX reads of explicitly allowed
// synthetic fixture processes only. No screen, browser, input or disk capture.
import AppKit
import ApplicationServices
import Foundation

let startTime = ProcessInfo.processInfo.systemUptime
func now() -> Double { (ProcessInfo.processInfo.systemUptime - startTime) * 1000 }
let outputLock = NSLock()
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    outputLock.unlock()
}
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    return attribute(element, name) as? String ?? ""
}

final class Recorder {
    var running = false
    var allowed = Set<pid_t>()
    var epoch = 0
    var revision = 0
    var currentKey: String? = nil
    var knownWindows: [AXUIElement] = []
    var observers: [AXObserver] = []
    var timer: Timer?
    var pending = false
    var lastRead: Double = -1000
    var lastObservation: Double = 0
    var trusted = false
    let ownExecutable = Bundle.main.executableURL?.resolvingSymlinksInPath()

    init() {
        trusted = AXIsProcessTrusted()
        emit(["kind": "ready", "at": now(), "permission": trusted])
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.observe() }
    }

    func clearObservers() {
        for observer in observers {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        observers.removeAll()
    }

    func command(_ command: [String: Any]) {
        switch command["action"] as? String {
        case "permission":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case "start":
            running = false
            clearObservers()
            epoch = command["epoch"] as? Int ?? 0
            allowed = Set((command["pids"] as? [Int] ?? []).filter { $0 > 0 && $0 <= Int(Int32.max) }.map { pid_t($0) })
            currentKey = nil
            knownWindows.removeAll()
            revision = 0
            lastRead = -1000
            for pid in allowed {
                var observer: AXObserver?
                let callback: AXObserverCallback = { _, _, _, pointer in
                    guard let pointer = pointer else { return }
                    let owner = Unmanaged<Recorder>.fromOpaque(pointer).takeUnretainedValue()
                    owner.observe()
                }
                if AXObserverCreate(pid, callback, &observer) == .success, let observer = observer {
                    let application = AXUIElementCreateApplication(pid)
                    for notification in [kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification, kAXValueChangedNotification] {
                        _ = AXObserverAddNotification(observer, application, notification as CFString, Unmanaged.passUnretained(self).toOpaque())
                    }
                    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
                    observers.append(observer)
                }
            }
            lastObservation = now()
            running = true
            // Force a first context event even if the initial source is excluded.
            currentKey = "not-an-actual-window"
            observe()
        case "stop":
            observe() // A queued stop must not hide a stall by beating the timer.
            running = false
            currentKey = nil
            knownWindows.removeAll()
            allowed.removeAll()
            clearObservers()
            emit(["kind": "stopped", "at": now(), "epoch": epoch])
        case "quit":
            running = false
            clearObservers()
            NSApplication.shared.terminate(nil)
        default: break
        }
    }

    func observe() {
        let at = now() // Timestamp before AX lookup; never after slow extraction.
        // Conservative preview safety ceiling, not a validated timing budget.
        if running && at - lastObservation > 1000 {
            running = false
            emit(["kind": "coverageGap", "code": "MAC_COVERAGE_GAP", "at": lastObservation, "epoch": epoch])
            return
        }
        if running { lastObservation = at }
        let permission = AXIsProcessTrusted()
        if permission != trusted {
            trusted = permission
            emit(["kind": "permission", "granted": permission, "at": now()])
        }
        guard running else { return }
        var target: AXUIElement? = nil
        var key: String? = nil
        if trusted, let app = NSWorkspace.shared.frontmostApplication, allowed.contains(app.processIdentifier),
           app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
           let executable = app.executableURL?.resolvingSymlinksInPath(), let own = ownExecutable, executable == own {
            let application = AXUIElementCreateApplication(app.processIdentifier)
            _ = AXUIElementSetMessagingTimeout(application, 0.05)
            if let value = attribute(application, kAXFocusedWindowAttribute as CFString), CFGetTypeID(value) == AXUIElementGetTypeID() {
                let window = unsafeBitCast(value, to: AXUIElement.self)
                _ = AXUIElementSetMessagingTimeout(window, 0.05)
                // CFHash is not a unique window ID. Compare AX identities before
                // allocating a bounded per-recording source key.
                var index = knownWindows.firstIndex(where: { CFEqual($0, window) })
                if index == nil && knownWindows.count < 64 {
                    knownWindows.append(window)
                    index = knownWindows.count - 1
                }
                if let index = index {
                    target = window
                    key = "\(app.processIdentifier):\(index)"
                }
            }
        }
        if key != currentKey {
            revision += 1
            currentKey = key
            let title = target.map { String(stringAttribute($0, kAXTitleAttribute as CFString).prefix(120)) } ?? ""
            emit(["kind": "focus", "at": at, "epoch": epoch, "revision": revision, "key": key as Any? ?? NSNull(), "title": title])
        }
        guard let window = target, let key = key, !pending, at - lastRead >= 250 else { return }
        pending = true
        lastRead = at
        let jobEpoch = epoch
        let jobRevision = revision
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let text = Recorder.readText(window)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.pending = false
                self.observe() // Recheck actual OS focus, not only the previous event.
                guard self.running, self.epoch == jobEpoch, self.revision == jobRevision, self.currentKey == key, AXIsProcessTrusted() else { return }
                emit(["kind": "text", "at": at, "epoch": jobEpoch, "revision": jobRevision, "key": key, "text": text, "status": text.isEmpty ? "empty" : "ok"])
            }
        }
    }

    static func readText(_ window: AXUIElement) -> String {
        var stack: [(AXUIElement, Int)] = [(window, 0)]
        var lines: [String] = []
        var visited = 0
        let deadline = now() + 180
        while let (element, depth) = stack.popLast(), visited < 120, now() < deadline {
            visited += 1
            _ = AXUIElementSetMessagingTimeout(element, 0.03)
            let role = stringAttribute(element, kAXRoleAttribute as CFString)
            // Never traverse form/editable/secure controls. This prototype only
            // admits static native text, not a blanket accessibility-tree dump.
            if ["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox"].contains(role) { continue }
            if (attribute(element, "AXHidden" as CFString) as? Bool) == true { continue }
            if role == "AXStaticText" {
                let value = stringAttribute(element, kAXValueAttribute as CFString)
                if !value.isEmpty { lines.append(String(value.prefix(1000))) }
            }
            if depth < 7, let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
                for child in children.prefix(40).reversed() { stack.append((child, depth + 1)) }
            }
            if lines.joined(separator: "\n").count >= 2000 { break }
        }
        return String(lines.joined(separator: "\n").prefix(2000))
    }
}

final class FixtureDelegate: NSObject, NSWindowDelegate {
    let target: String
    init(_ target: String) { self.target = target }
    func windowDidBecomeKey(_ notification: Notification) {
        emit(["kind": "fixtureFocus", "target": target, "at": now()])
    }
}
final class Fixtures {
    var windows: [String: NSWindow] = [:]
    var labels: [String: NSTextField] = [:]
    var delegates: [FixtureDelegate] = []
    var timer: Timer?
    var update = 0
    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        for (index, target) in ["A", "B"].enumerated() {
            let window = NSWindow(contentRect: NSRect(x: 120 + index * 100, y: 260 - index * 80, width: 560, height: 280), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Spindle Test \(target)"
            window.isReleasedWhenClosed = false
            let label = NSTextField(labelWithString: "")
            label.frame = NSRect(x: 24, y: 30, width: 510, height: 220)
            label.font = NSFont.systemFont(ofSize: 25)
            label.maximumNumberOfLines = 8
            window.contentView?.addSubview(label)
            let delegate = FixtureDelegate(target)
            delegates.append(delegate)
            window.delegate = delegate
            windows[target] = window
            labels[target] = label
            window.makeKeyAndOrderFront(nil)
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.update += 1
            self?.refresh()
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        emit(["kind": "ready", "at": now()])
    }
    func refresh() {
        for (target, label) in labels {
            label.stringValue = "SPINDLE TEST \(target)\nInvented \(target == "A" ? "learning" : "leisure") example\nContent update: \(update)\nThis text changes without switching windows."
        }
    }
    func command(_ command: [String: Any]) {
        if command["action"] as? String == "quit" { NSApplication.shared.terminate(nil) }
        if command["action"] as? String == "activate", let target = command["target"] as? String, let window = windows[target] {
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let fixtureMode = CommandLine.arguments.contains("--fixture")
let fixtures: Fixtures? = fixtureMode ? Fixtures() : nil
let recorder: Recorder? = fixtureMode ? nil : Recorder()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard line.utf8.count <= 4096, let data = line.data(using: .utf8), let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async {
            if let fixtures = fixtures { fixtures.command(command) }
            else { recorder?.command(command) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
