# Spindle.app desktop shell

`Spindle.app` is a thin native window for the existing Preview service. `platforms/macos/DesktopApp.swift` builds `Contents/MacOS/Spindle`, and `platforms/macos/Spindle.Info.plist` becomes `Contents/Info.plist`, with bundle identifier `ai.berlayar.spindle` and display name Spindle. The shell adds no recorder, store, auth or backend. Its `WKWebView` shows the same Node-served controls and portal UI as the browser Preview, and Start, Pause and permissions stay those existing controls. The shell never starts capture, grants TCC permission, registers at login or changes security settings.

Source/build/installation reports and revision-specific proof limits are maintained in [#132](https://github.com/erniesg/spindle/pull/132), [#135](https://github.com/erniesg/spindle/pull/135) and [#143](https://github.com/erniesg/spindle/pull/143). Structural checks alone are not Mac compilation, installed-app, notarization or human acceptance.

## Bundle layout

The coordinator assembles the bundle. It sets `Contents/Resources` to the current packaged runtime: `runtime/node`, `build/core/preview/app.js` with its build closure, and the native helpers (`runtime/SpindlePreview`, `runtime/SpindleFixture`, `runtime/macos-native-build.json`). The shell resolves `Bundle.main.resourceURL` as its trusted root. It refuses to start (`APP_RESOURCES_INCOMPLETE`) unless `runtime/node` is executable and `app.js` is readable. Both paths must resolve inside that root. Ambient Node and PATH lookups are never used.

## Startup protocol

1. The window opens straight away and shows "Starting Spindle…".
2. The shell generates a private 32-byte hex nonce. It then spawns only `Resources/runtime/node Resources/build/core/preview/app.js --desktop-shell`, with the working directory at `Resources`. The environment is an allowlist: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `SPINDLE_DESKTOP_NONCE`, and `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL` when present. Other variables, including `SPINDLE_NEBIUS_CONFIG`, are not inherited. Stdin is a pipe the shell keeps open, so EOF means the shell has gone.
3. With `--desktop-shell`, Node must not open an external browser. Once the local service is actually listening, it prints one line: `{"schema":"spindle.desktop-ready/v1","nonce":"<SPINDLE_DESKTOP_NONCE>","url":"http://127.0.0.1:<port>/..."}`.
4. The shell accepts only a line of at most 4 KiB. It must be a JSON object with exactly those three keys, the matching schema and nonce, and an `http` URL on host `127.0.0.1` with an explicit port and no credentials. It skips other stdout lines without showing or logging them. If 64 KiB of stdout passes with no valid line, startup fails with `READY_SIGNAL_INVALID`. After 45 s it fails with `STARTUP_TIMEOUT`. The web view stays hidden until a valid line arrives.
5. If startup fails or the service exits, the window shows a fixed message, "Spindle could not start (CODE). Nothing is recording.", and a Retry button. CODE is Node's own `Spindle did not start: CODE` (uppercase, digits and underscores, at most 80 characters) or one of the shell's codes. All other stderr is discarded. Retry works only after the previous child has exited.

URLs, the nonce and the token are never logged. No URL or configuration is accepted from the page or a model.

## Navigation

The web view allows navigation only to the announced origin `http://127.0.0.1:<port>`. When the user clicks an `https` link (for example, OAuth) on that page, the link opens in the system browser. Other navigations and popups are cancelled, and no second web view is created. The website data store is non-persistent. Pages cannot open windows automatically, and there is no script message handler or other JavaScript bridge.

## Quit and close

Closing the window or choosing Quit sends SIGTERM to the owned Node process only and returns `terminateLater`. The UI keeps responding and shows "Stopping Spindle…". The app quits only after that process exits. If it is still running after 10 s, the window says so and offers Force Stop, which sends SIGKILL to that one PID. The shell never uses killall or pkill and never signals other processes. Stopping the helper and cleaning up the local service belong to Node.

Menus: Spindle (About, Hide, Quit), Edit (Undo, Redo, Cut, Copy, Paste, Select All) and Window (Minimize, Zoom, Close).

## Compile on a Mac (external)

A Mac agent with the existing Command Line Tools/Xcode and the macOS 15+ SDK can run this from a checkout. It installs nothing:

```sh
mkdir -p .local/desktop-shell
xcrun swiftc -swift-version 5 -O -parse-as-library -target arm64-apple-macos15.0 platforms/macos/DesktopApp.swift -o .local/desktop-shell/Spindle -framework AppKit -framework WebKit -framework Foundation
```

The coordinator owns bundle assembly, signing, the package and any install test. A successful compile proves only that the source compiles. It is not app acceptance. That needs the installed bundle run on a real Mac under [TESTING.md](TESTING.md).

## Checks here

`tests/test_macos_desktop_shell.py` reads the Swift source, plist and this document as text. It checks identity, the absence of extra permission keys, the import set, the spawn arguments, the ready-protocol checks, the environment allowlist, owned-process signalling and the navigation guards. It is not a Swift compile, does not produce or inspect a Mach-O, and proves no window, web view or lifecycle behaviour.
