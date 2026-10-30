/** Local policy only: no model calls, content collection or capture clock. */
export function matchesHost(candidate: string, host: string, subdomains: boolean): boolean {
 return candidate === host || (subdomains && candidate.endsWith(`.${host}`));
}
export function resourceIdentity(raw: string): string {
 const url = new URL(raw);
 if (!['https:', 'http:'].includes(url.protocol)) throw new Error('HTTP_RESOURCE_REQUIRED');
 const video = /(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/watch' ? url.searchParams.get('v') : null;
 url.username = ''; url.password = ''; url.search = ''; url.hash = '';
 if (video && /^[\w-]{1,64}$/.test(video)) url.searchParams.set('v', video);
 return url.href;
}
export interface PolicyRevision { version: number; purpose: string }
export interface ResourceGrant extends PolicyRevision { resource: string; expires: number; verdict: string }
export function eligible(policy: PolicyRevision, grant: ResourceGrant, resource: string, now: number): boolean {
 return grant.verdict === 'allow' && grant.version === policy.version && grant.purpose === policy.purpose
  && grant.resource === resource && Number.isFinite(grant.expires) && grant.expires > now;
}
