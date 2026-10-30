import type {GoogleCallbackReason} from '../connectors/google/oauth.js';
/** Local prerequisites only, not proof of Google's per-folder authorization or API availability. */
export interface GoogleOutputReadiness {
 pickerConfigured:boolean;grantPresent:boolean;blocker?:'GOOGLE_PICKER_CONFIGURATION_REQUIRED'|'GOOGLE_OUTPUT_GRANT_REQUIRED';
}
/** Public projections only. No OAuth credential material crosses this shared account-client seam. */
export interface GoogleConnectionStatus {
 id:string;accountId?:string;status:'pending'|'connected'|'disconnected';grants:string[];missingGrants:string[];
 mailReadiness?:{canDraft:boolean;canSend:boolean;requiresExactOwnerReview:true};
 roots:string[];rootRevision:number;outputReadiness:GoogleOutputReadiness;revocation?:'confirmed'|'uncertain';recovery?:'no_active_authorization';
 lastAttempt?:{status:'pending'|'failed'|'succeeded'|'disconnected';correlation:string;at:number;expiresAt?:number;code?:string;stage?:string;reason?:GoogleCallbackReason;httpStatus?:number};
}
export interface GoogleConnections {connections:GoogleConnectionStatus[]}
export interface GoogleConnectionStart {connectionId:string;authorizationUrl:string;expiresAt:number}
