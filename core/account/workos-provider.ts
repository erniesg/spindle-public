import {createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey} from 'jose';

export interface WorkOSConfig {
  clientId: string;
  issuer: string;
  jwksUri: string;
  webRedirectUri: string;
}

/** Only signed stable provider identifiers cross the account boundary. */
export interface WorkOSIdentity {
  subject: string;
  sessionId: string;
  clientId: string;
  /** Unix seconds, matching the verified JWT exp claim. */
  expiresAt: number;
}

/** Test seams; production callers should use the platform fetch and WorkOS JWKS. */
export interface WorkOSProviderDependencies {
  fetch?: typeof fetch;
  keyResolver?: JWTVerifyGetKey;
}

const RESPONSE_LIMIT = 65_536;
const TIMEOUT_MS = 10_000;
const FAILURE = 'WORKOS_AUTHENTICATION_FAILED';
const publicId = /^client_[A-Za-z0-9]+$/;

function workosPath(value: string, prefix: string): string {
  const url = new URL(value);
  const id = url.pathname.slice(prefix.length);
  if (url.origin !== 'https://api.workos.com' || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith(prefix) || !publicId.test(id) || url.href !== value) throw new Error('INVALID_WORKOS_CONFIG');
  return id;
}

function redirectUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.hash || url.search || url.href !== value) throw new Error('INVALID_WORKOS_REDIRECT');
  return url;
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) {
    await response.body?.cancel();
    throw new Error(FAILURE);
  }
  if (!response.body) throw new Error(FAILURE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {await reader.cancel(); throw new Error(FAILURE);}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
  return new TextDecoder('utf-8', {fatal:true}).decode(body);
}

/** WorkOS public-client Authorization Code + PKCE; no API key or client secret. */
export class WorkOSProvider {
  private readonly config: WorkOSConfig;
  private readonly fetcher: typeof fetch;
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(config: WorkOSConfig, dependencies: WorkOSProviderDependencies = {}) {
    if (!publicId.test(config.clientId) ||
        workosPath(config.issuer, '/user_management/') !== workosPath(config.jwksUri, '/sso/jwks/')) {
      throw new Error('INVALID_WORKOS_CONFIG');
    }
    redirectUrl(config.webRedirectUri);
    this.config = {...config};
    this.fetcher = dependencies.fetch ?? fetch;
    this.keyResolver = dependencies.keyResolver ?? createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: TIMEOUT_MS,
      [customFetch]: async (url, init) => {
        const response = await this.fetcher(url, {...init, redirect:'error'});
        if (!response.ok) {await response.body?.cancel(); throw new Error(FAILURE);}
        return new Response(await boundedText(response), {status:response.status, headers:response.headers});
      },
    });
  }

  authorizationUrl(redirectUri: string, state: string, codeChallenge: string): string {
    const redirect = redirectUrl(redirectUri);
    if (redirectUri !== this.config.webRedirectUri &&
        !(redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname))) {
      throw new Error('INVALID_WORKOS_REDIRECT');
    }
    if (!state || state.length > 1024 || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error('INVALID_WORKOS_PKCE');
    const url = new URL('https://api.workos.com/user_management/authorize');
    url.search = new URLSearchParams({client_id:this.config.clientId, redirect_uri:redirectUri,
      response_type:'code', provider:'authkit', state, code_challenge:codeChallenge, code_challenge_method:'S256'}).toString();
    return url.href;
  }

  async exchange(code: string, codeVerifier: string): Promise<WorkOSIdentity> {
    try {
      if (!code || code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error(FAILURE);
      const response = await this.fetcher('https://api.workos.com/user_management/authenticate', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(TIMEOUT_MS),
        headers:{'content-type':'application/json', accept:'application/json'},
        body:JSON.stringify({grant_type:'authorization_code',client_id:this.config.clientId,code,code_verifier:codeVerifier}),
      });
      if (!response.ok) {await response.body?.cancel(); throw new Error(FAILURE);}
      const parsed: unknown = JSON.parse(await boundedText(response));
      if (!parsed || typeof parsed !== 'object' || !('access_token' in parsed) || typeof parsed.access_token !== 'string') throw new Error(FAILURE);
      const {payload} = await jwtVerify(parsed.access_token, this.keyResolver, {
        issuer:this.config.issuer, algorithms:['RS256'], requiredClaims:['sub','sid','client_id','iat','exp'],
      });
      const now = Math.floor(Date.now()/1000);
      // Applications share an issuer and signing keys: client_id is mandatory even without aud.
      if (payload.client_id !== this.config.clientId || typeof payload.sub !== 'string' || !/^user_[A-Za-z0-9]+$/.test(payload.sub) ||
          typeof payload.sid !== 'string' || !/^session_[A-Za-z0-9]+$/.test(payload.sid) ||
          typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > now || payload.iat < 0 ||
          typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= payload.iat ||
          (payload.auth_time !== undefined && (typeof payload.auth_time !== 'number' || !Number.isFinite(payload.auth_time) || payload.auth_time < 0 || payload.auth_time > now || payload.auth_time > payload.iat)) ||
          payload.sub_type !== undefined || (payload.sub_profile !== undefined && payload.sub_profile !== 'user') ||
          (payload.aud !== undefined && payload.aud !== this.config.clientId &&
            !(Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === this.config.clientId))) throw new Error(FAILURE);
      return {subject:payload.sub,sessionId:payload.sid,clientId:this.config.clientId,expiresAt:payload.exp};
    } catch {
      // Tokens, provider response bodies, and transport diagnostics are never exposed.
      throw new Error(FAILURE);
    }
  }
}
