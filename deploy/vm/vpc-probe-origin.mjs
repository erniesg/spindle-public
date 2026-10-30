// Data-free, PRIVATE capability probe, not a product demo or application acceptance.
// Run only while infra owns reserved127.0.0.1:43180; stop before the real app starts.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
const marker = `spindle-private-vpc-probe-${randomUUID()}`;
const server = createServer((req, res) => {
  if (req.headers.host !== 'spindle.berlayar.ai') { res.writeHead(421); res.end(); return; }
  if (req.method !== 'GET' || req.url !== '/portal') { res.writeHead(404); res.end(); return; }
  // Never log cookies, body, arbitrary query strings or authorization.
  console.log(JSON.stringify({method: 'GET', path: '/portal', host: req.headers.host}));
  res.writeHead(200, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
  res.end(marker + '\n');
});
server.on('error', error => { console.error(error.code ?? 'PROBE_START_FAILED'); process.exitCode = 1; });
server.listen(43180, '127.0.0.1', () => console.log(JSON.stringify({listen: '127.0.0.1:43180', marker})));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
