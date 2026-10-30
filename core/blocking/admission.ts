import { resourceIdentity, type PolicyRevision, type ResourceGrant } from './policy.js';

/** Local bounded baseline, not a semantic model or proof of educational value. */
export function classifyPurposeFromPath(resource: string, purpose: string): string {
 const tokens = purpose.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
 if (!tokens.length || tokens.length > 8) return 'uncertain';
 const words = new Set(new URL(resource).pathname.toLowerCase().split(/[^a-z0-9]+/));
 return tokens.every(token => words.has(token)) ? 'allow' : 'uncertain';
}
export interface AdmissionRequest {
 policy: PolicyRevision;
 resource: string;
 requestedAt: number;
 expires: number;
}
export interface AdmissionResult {
 reason: 'allowed' | 'uncertain' | 'unavailable' | 'stale' | 'expired' | 'invalid';
 grant?: ResourceGrant;
}
export type PurposeClassifier = (resource: string, purpose: string) => Promise<string>;

/** No remote processing, persistence, policy mutation or browser authority here.
 * Callers must additionally bind any installed permission to tab/navigation and host.
 */
export async function admitResource(
 request: AdmissionRequest,
 currentPolicy: () => PolicyRevision | undefined,
 now: () => number,
 classify: PurposeClassifier = async (resource, purpose) => classifyPurposeFromPath(resource, purpose),
): Promise<AdmissionResult> {
 // Snapshot before awaiting untrusted classification: caller mutation cannot replace purpose.
 const {version, purpose} = request.policy;
 const {resource, requestedAt, expires} = request;
 if (!Number.isSafeInteger(version) || version < 1 || !purpose.trim() || purpose.length > 120
  || !Number.isFinite(requestedAt) || !Number.isFinite(expires)
  || expires <= requestedAt || expires - requestedAt > 300000) return {reason:'invalid'};
 try {
  // Sanitization must never collapse distinct arbitrary query-selected resources into one grant.
  // Unsupported identities remain blocked, rather than retaining potentially private queries.
  if (resourceIdentity(resource) !== resource) return {reason:'invalid'};
 } catch { return {reason:'invalid'}; }
 let verdict: string;
 try { verdict = await classify(resource, purpose); } catch { return {reason:'unavailable'}; }
 const current = currentPolicy();
 if (!current || current.version !== version || current.purpose !== purpose) return {reason:'stale'};
 const instant = now();
 if (!Number.isFinite(instant) || instant < requestedAt || instant >= expires) return {reason:'expired'};
 if (verdict !== 'allow') return {reason:'uncertain'};
 return {reason:'allowed', grant:{version, purpose, resource, expires, verdict:'allow'}};
}
