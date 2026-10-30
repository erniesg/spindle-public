export {};
const $ = (id: string) => { const element = document.getElementById(id); if (!element) throw new Error('MISSING_UI_ELEMENT'); return element; };
const button = (id: string) => { const element = $(id); if (!(element instanceof HTMLButtonElement)) throw new Error('MISSING_BUTTON'); return element; };
let port: chrome.runtime.Port | null = null, id = 0;
function show(badge: string, status: string, detail: string) {
  $('badge').textContent = badge; $('status').textContent = status; $('detail').textContent = detail;
  button('connect').disabled = port !== null;
  button('reject').disabled = button('disconnect').disabled = port === null;
}
function hello(schema = 'spindle-browser-probe/v1') { port?.postMessage({ schema, id: ++id, kind: 'hello' }); }
$('connect').addEventListener('click', () => {
  const current = chrome.runtime.connectNative('ai.berlayar.spindle.connection_probe');
  port = current;
  show('Connecting', 'Starting the local process…', 'Waiting for a versioned reply through the browser’s native pipe.');
  current.onMessage.addListener(message => {
    if (port !== current || !message || typeof message !== 'object' || message.schema !== 'spindle-browser-probe/v1' || message.id !== id) return;
    if (message.ok === true && message.code === 'CONNECTED' && message.capture === false)
      show('Connected', 'Local round trip verified', 'The local host replied through Chromium Native Messaging. Capture remains off; no page content was sent.');
    else if (message.code === 'UNSUPPORTED_SCHEMA')
      show('Rejected safely', 'Incompatible version rejected', 'The real host rejected the request. No commands ran and no activity was collected. Disconnect and reconnect to try again.');
    else show('Rejected', 'Request was not accepted', 'Only the fixed versioned connection check is supported.');
  });
  current.onDisconnect.addListener(() => {
    const failed = Boolean(chrome.runtime.lastError);
    if (port !== current) return;
    port = null;
    show('Disconnected', failed ? 'Local host unavailable' : 'Local process disconnected', 'Check the disposable probe registration, then reconnect. No activity was collected.');
  });
  hello();
});
$('reject').addEventListener('click', () => hello('spindle-browser-probe/v99'));
$('disconnect').addEventListener('click', () => {
  const old = port; port = null; old?.disconnect();
  show('Disconnected', 'Local connection closed', 'The browser pipe is closed. The local host exits when its input closes. You can reconnect.');
});
