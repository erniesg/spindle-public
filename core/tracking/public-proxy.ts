import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Private contract with the trusted HTTPS edge (Worker). The edge overwrites both
 * headers on every request: `X-Spindle-Proxy-Token` = this private token and
 * `X-Spindle-Client` = 64-hex HMAC of the real client address. Client-supplied
 * copies are stripped there. No IP, CF-* or X-Forwarded-* value is read here. */
export interface PublicProxyConfig { token: string }
const HEX64 = /^[a-f0-9]{64}$/;

export function validatePublicProxy(config: PublicProxyConfig | undefined, publicOrigin: string | undefined): void {
  if (config === undefined) return;
  if (publicOrigin === undefined) throw Error('PUBLIC_PROXY_REQUIRES_PUBLIC_ORIGIN');
  if (!config || typeof config !== 'object' || Object.keys(config).join(',') !== 'token' || typeof config.token !== 'string' || !HEX64.test(config.token)) throw Error('PUBLIC_PROXY_CONFIG_INVALID');
}

/** The verified client tag, or undefined when the proxy token or tag is missing or wrong.
 * Repeated headers arrive comma-joined and therefore fail the exact format. */
export function proxyClient(req: IncomingMessage, token: string): string | undefined {
  const supplied = req.headers['x-spindle-proxy-token'], client = req.headers['x-spindle-client'];
  if (typeof supplied !== 'string' || !HEX64.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return;
  return typeof client === 'string' && HEX64.test(client) ? client : undefined;
}

/** Bounded, expiring per-client sliding windows. A full table admits nobody new (fail closed). */
export class ClientWindows {
  readonly #clients = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxClients = 4096) {}
  admit(client: string, now = Date.now()): boolean {
    const floor = now - this.windowMs;
    let times = this.#clients.get(client);
    if (!times && this.#clients.size >= this.maxClients) {
      for (const [key, value] of this.#clients) if (value.every(t => t <= floor)) this.#clients.delete(key);
      if (this.#clients.size >= this.maxClients) return false;
    }
    // Entries from a later clock keep counting: a rollback cannot reopen the window.
    times = (times ?? []).filter(t => t > floor);
    if (times.length >= this.limit) { this.#clients.set(client, times); return false; }
    times.push(now); this.#clients.set(client, times); return true;
  }
}
