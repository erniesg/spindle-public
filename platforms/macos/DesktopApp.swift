// Spindle.app executable (Contents/MacOS/Spindle): a thin AppKit window whose WKWebView
// shows the existing Node-served Preview UI. It owns exactly one bundled Node child,
// never captures, grants permissions or opens Chrome, and exposes no JavaScript bridge.

import AppKit
import Foundation
import WebKit

private let readySchema = "spindle.desktop-ready/v1"
private let maxReadyLine = 4096
private let maxStartupBuffer = 65536
private let startupTimeout: TimeInterval = 45
private let stillStoppingAfter: TimeInterval = 10

/// Validated loopback origin announced by the owned Node service. Never logged.
struct LocalOrigin: Equatable {
    let port: Int

    func owns(_ url: URL?) -> Bool {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == "http" && parts.host == "127.0.0.1" && parts.port == port && parts.user == nil && parts.password == nil
    }
}

/// Accepts only one bounded `spindle.desktop-ready/v1` line echoing our nonce with an
/// http://127.0.0.1:<port> URL. Anything else (remote, file:, javascript:, credentials) is rejected.
func parseReadyLine(_ line: Data, nonce: String) -> (URL, LocalOrigin)? {
    guard line.count <= maxReadyLine,
          let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          Set(object.keys) == ["schema", "nonce", "url"],
          object["schema"] as? String == readySchema,
          object["nonce"] as? String == nonce,
          let text = object["url"] as? String, text.count <= 2048,
          let url = URL(string: text),
          let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme == "http", parts.host == "127.0.0.1",
          parts.user == nil, parts.password == nil,
          let port = parts.port, (1...65535).contains(port)
    else { return nil }
    return (url, LocalOrigin(port: port))
}

private func makeNonce() -> String {
    var generator = SystemRandomNumberGenerator()  // arc4random-backed CSPRNG on Darwin
    return (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
}

/// Bundled Node and app.js under the trusted Resources root; symlinks may not escape it.
private func bundledPaths() -> (resources: URL, node: URL, app: URL)? {
    guard let raw = Bundle.main.resourceURL else { return nil }
    let resources = raw.resolvingSymlinksInPath().standardizedFileURL
    let node = resources.appendingPathComponent("runtime/node").resolvingSymlinksInPath()
    let app = resources.appendingPathComponent("build/core/preview/app.js").resolvingSymlinksInPath()
    let prefix = resources.path + "/"
    let files = FileManager.default
    guard node.path.hasPrefix(prefix), app.path.hasPrefix(prefix),
          files.isExecutableFile(atPath: node.path), files.isReadableFile(atPath: app.path)
    else { return nil }
    return (resources, node, app)
}

/// Only what Node needs; no inherited model/remote configuration or developer variables.
private func childEnvironment(nonce: String) -> [String: String] {
    let parent = ProcessInfo.processInfo.environment
    var env: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SPINDLE_DESKTOP_NONCE": nonce]
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"] { if let value = parent[key] { env[key] = value } }
    return env
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private enum State { case starting, ready, workspaceUnavailable, failed, stopping }

    private var window: NSWindow!
    private var webView: WKWebView!
    private let statusView = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let retryButton = NSButton(title: "Retry", target: nil, action: nil)
    private let forceButton = NSButton(title: "Force Stop", target: nil, action: nil)

    private var state = State.starting
    private var child: Process?
    private var nonce = ""
    private var origin: LocalOrigin?
    private var captureURL: URL?
    private var wantsWorkspace = false
    private var activeNavigation: WKNavigation?
    private var navigationGeneration = 0
    // Public account workspace uses the system browser's AuthKit session.
    // Capture and timer remain in the owned native window; no SSH is needed.
    private let workspaceURL = URL(string: "https://spindle.berlayar.ai/portal")!
    private func ownsWorkspace(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == workspaceURL.scheme && url.host == workspaceURL.host && url.port == workspaceURL.port && url.user == nil && url.password == nil
    }
    private var stdoutBuffer = Data()
    private var failureCode: String?
    private var startupTimer: Timer?
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()
        buildWindow()
        startService()
        NSApp.activate()
    }

    // MARK: Window

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.alignment = .center
        statusLabel.font = .systemFont(ofSize: 15)
        retryButton.target = self; retryButton.action = #selector(retry)
        forceButton.target = self; forceButton.action = #selector(forceStop)
        statusView.orientation = .vertical
        statusView.spacing = 12
        statusView.translatesAutoresizingMaskIntoConstraints = false
        for view in [statusLabel, retryButton, forceButton] as [NSView] { statusView.addArrangedSubview(view) }

        let content = NSView()
        content.addSubview(webView)
        content.addSubview(statusView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusView.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            statusView.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            statusView.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -40),
        ])

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Spindle"
        window.minSize = NSSize(width: 640, height: 480)
        window.contentView = content
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("SpindleMainWindow")
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    private func show(_ next: State, _ message: String) {
        state = next
        statusLabel.stringValue = message
        statusView.isHidden = next == .ready
        webView.isHidden = next != .ready
        retryButton.isHidden = next != .failed && next != .workspaceUnavailable
        forceButton.isHidden = true
    }

    private func buildMenus() {
        let main = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Capture & Timer", action: #selector(showCapture), keyEquivalent: "1").target = self
        appMenu.addItem(withTitle: "Shared Account Workspace", action: #selector(showWorkspace), keyEquivalent: "2").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "About Spindle", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Spindle", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Spindle", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        for (title, menu) in [("Spindle", appMenu), ("Edit", editMenu), ("Window", windowMenu)] {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.submenu = menu
            main.addItem(item)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    // MARK: Owned Node service

    private func startService() {
        guard child == nil else { return }  // never relaunch while the previous service is alive
        origin = nil; failureCode = nil; stdoutBuffer = Data()
        show(.starting, "Starting Spindle…")
        guard let paths = bundledPaths() else { return fail("APP_RESOURCES_INCOMPLETE") }

        nonce = makeNonce()
        let process = Process()
        process.executableURL = paths.node
        process.arguments = [paths.app.path, "--desktop-shell"]
        process.currentDirectoryURL = paths.resources
        process.environment = childEnvironment(nonce: nonce)
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.standardInput = input  // held open; EOF tells Node its shell is gone
        process.standardOutput = output
        process.standardError = errors

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }  // EOF
            DispatchQueue.main.async { self?.receiveStdout(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }  // EOF
            DispatchQueue.main.async { self?.receiveStderr(data) }
        }
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async { self?.serviceEnded(ended) }
        }
        do { try process.run() } catch { return fail("NODE_START_FAILED") }
        child = process
        startupTimer = Timer.scheduledTimer(withTimeInterval: startupTimeout, repeats: false) { [weak self] _ in
            guard let self, self.state == .starting else { return }
            self.fail("STARTUP_TIMEOUT")
            self.child?.terminate()
        }
    }

    private func receiveStdout(_ data: Data) {
        guard state == .starting, !data.isEmpty else { return }  // after readiness output is drained, not shown or logged
        stdoutBuffer.append(data)
        while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = stdoutBuffer[stdoutBuffer.startIndex..<newline]
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...newline)
            if let ready = parseReadyLine(Data(line), nonce: nonce) { return becomeReady(ready.0, ready.1) }
        }
        if stdoutBuffer.count > maxStartupBuffer {
            fail("READY_SIGNAL_INVALID")
            child?.terminate()
        }
    }

    /// Keeps only Node's own fixed `Spindle did not start: CODE` form; other stderr is discarded.
    private func receiveStderr(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        for line in text.split(separator: "\n") where line.hasPrefix("Spindle did not start: ") {
            let code = line.dropFirst("Spindle did not start: ".count)
            if code.count <= 80, code.allSatisfy({ $0.isASCII && ($0.isUppercase || $0.isNumber || $0 == "_") }) {
                failureCode = String(code)
            }
        }
    }

    private func becomeReady(_ url: URL, _ announced: LocalOrigin) {
        startupTimer?.invalidate()
        origin = announced
        captureURL = url
        show(.ready, "")
        wantsWorkspace = false
        activeNavigation = webView.load(URLRequest(url: url))
    }

    private func fail(_ code: String) {
        startupTimer?.invalidate()
        guard !quitting else { return }
        webView.stopLoading()
        show(.failed, "Spindle could not start (\(code)).\nNothing is recording.")
    }

    private func serviceEnded(_ process: Process) {
        guard process === child else { return }
        child = nil
        origin = nil
        startupTimer?.invalidate()
        if quitting { return NSApp.reply(toApplicationShouldTerminate: true) }
        if state != .failed { fail(failureCode ?? "SERVICE_STOPPED") }
    }

    @objc private func showCapture() {
        guard state == .ready || state == .workspaceUnavailable, let captureURL, child?.isRunning == true else { return }
        navigationGeneration += 1
        wantsWorkspace = false
        activeNavigation = nil
        webView.stopLoading()
        show(.ready, "")
        activeNavigation = webView.load(URLRequest(url: captureURL))
    }

    @objc private func showWorkspace() {
        guard state == .ready || state == .workspaceUnavailable, child?.isRunning == true else { return }
        navigationGeneration += 1
        wantsWorkspace = false
        activeNavigation = nil
        webView.stopLoading()
        show(.ready, "")
        // Keep web cookies in the same system browser used for AuthKit. The
        // native capture/timer service stays alive if the workspace is offline.
        NSWorkspace.shared.open(workspaceURL)
    }

    @objc private func retry() {
        if state == .workspaceUnavailable { return showWorkspace() }
        guard child == nil, !quitting else { return }
        startService()
    }

    @objc private func forceStop() {
        guard let pid = child?.processIdentifier, child?.isRunning == true else { return }
        kill(pid, SIGKILL)  // only the owned Node child; its helper pipes close with it
    }

    // MARK: Quit and close

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NSApp.terminate(nil)  // closing the only window quits and stops the owned service
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let process = child, process.isRunning else { return .terminateNow }
        if quitting { return .terminateLater }
        quitting = true
        startupTimer?.invalidate()
        show(.stopping, "Stopping Spindle…")
        process.terminate()  // graceful SIGTERM to the owned Node only; wait asynchronously
        Timer.scheduledTimer(withTimeInterval: stillStoppingAfter, repeats: false) { [weak self] _ in
            guard let self, self.child != nil else { return }
            self.statusLabel.stringValue = "Spindle is still stopping its local service…"
            self.forceButton.isHidden = false
        }
        return .terminateLater
    }

    // MARK: Owned artifact viewing and user-selected downloads

    private func ownsBlob(_ url: URL?) -> Bool {
        guard let url, url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return origin?.owns(inner) == true || ownsWorkspace(inner)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = String(URL(fileURLWithPath: suggestedFilename).lastPathComponent.prefix(240))
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }

    // MARK: Navigation: own local origins and their private blobs only

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let origin, origin.owns(action.request.url) || ownsWorkspace(action.request.url) || ownsBlob(action.request.url) {
            if wantsWorkspace, action.navigationType == .linkActivated,
               action.targetFrame?.isMainFrame == true,
               !action.shouldPerformDownload, ownsWorkspace(action.request.url) {
                // Replay a user workspace link through load() so its actual WKNavigation
                // is tracked just like the menu load. Never adopt a late didStart callback.
                navigationGeneration += 1
                let generation = navigationGeneration
                activeNavigation = nil
                decisionHandler(.cancel)
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.navigationGeneration == generation,
                          self.wantsWorkspace, self.state == .ready, !self.quitting else { return }
                    self.activeNavigation = webView.load(action.request)
                }
                return
            }
            return decisionHandler(action.shouldPerformDownload ? .download : .allow)
        }
        openUserHTTPSLink(action)
        decisionHandler(.cancel)
    }

    // A workspace connection failure is independent of the owned capture service.
    private func workspaceUnavailable() {
        guard wantsWorkspace, state == .ready, child?.isRunning == true, !quitting else { return }
        show(.workspaceUnavailable, "Workspace unavailable; use Capture & Timer; retry connection.\nCapture status is unchanged; check Capture & Timer.")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, wantsWorkspace, ownsWorkspace(navigationResponse.response.url),
           let response = navigationResponse.response as? HTTPURLResponse {
            // Only the workspace entry promises HTML. Owned artifact previews/downloads
            // may successfully return PDF, text or other MIME types.
            let isWorkspaceEntry = response.url?.path == "/portal" || response.url?.path == "/portal/"
            if response.statusCode >= 400 || (isWorkspaceEntry && response.mimeType?.lowercased() != "text/html") {
                workspaceUnavailable()
                return decisionHandler(.cancel)
            }
        }
        decisionHandler(.allow)
    }

    private func workspaceLoadFailed(_ navigation: WKNavigation?, _ error: NSError) {
        // Ignore an older/cancelled request after a menu selection or a later navigation.
        guard navigation != nil, navigation === activeNavigation,
              error.domain != NSURLErrorDomain || error.code != NSURLErrorCancelled else { return }
        workspaceUnavailable()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        workspaceLoadFailed(navigation, error as NSError)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        workspaceLoadFailed(navigation, error as NSError)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.sourceFrame.isMainFrame, ownsBlob(action.request.url) {
            webView.load(action.request)  // Existing authenticated PDF preview, in this app window.
        } else { openUserHTTPSLink(action) }
        return nil  // no second web view or arbitrary external in-app navigation
    }

    /// Explicit user clicks on HTTPS links (for example OAuth) go to the system browser.
    private func openUserHTTPSLink(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated,
              action.sourceFrame.isMainFrame, let url = action.request.url, url.scheme == "https", url.host != nil,
              let current = webView.url, origin?.owns(current) == true || ownsWorkspace(current)
        else { return }
        NSWorkspace.shared.open(url)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard state == .ready, child?.isRunning == true else { return }
        navigationGeneration += 1
        activeNavigation = webView.reload()
    }
}

@main
enum SpindleDesktop {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
