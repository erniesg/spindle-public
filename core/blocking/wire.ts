import type {PurposeField,PurposeReply} from './purpose.js';

// Envelope carried ONLY by the new purpose Native Messaging slot. Authentication
// supplies the profile; neither account IDs nor capture grants are wire authority.
export interface PurposeEvidenceSource {resource:string;evidenceId:string;mode:'static-resource'}
export interface PurposeProcessingGrant {
 id:string;binding:string;revision:number;modelRevision:string;
 resource:string;purpose:string;policyVersion:number;source:PurposeEvidenceSource;
 fields:readonly PurposeField[];
}
export type PurposeWireRequest=
 | {action:'session'}
 | {action:'grant';binding:string;approved:true;resource:string;purpose:string;policyVersion:number;source:PurposeEvidenceSource;fields:PurposeField[]}
 | {action:'classify';binding:string;grantId:string;request:{requestId:string;resource:string;purpose:string;policyVersion:number;expectedModelRevision:string;expectedConsentRevision:number;title?:string;summary?:string;pageText?:string}}
 | {action:'revoke';binding:string};
export type PurposeWireResponse=
 | {ok:false;code:string}
 | {ok:true;value:{binding:string;configured:boolean}|PurposeProcessingGrant|PurposeReply|{revoked:true}};
export type PurposeTransport=(request:PurposeWireRequest,signal?:AbortSignal)=>Promise<PurposeWireResponse>;
