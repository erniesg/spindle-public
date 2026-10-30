import type {DraftRef,MailSendBinding} from '../connectors/google/outgoing.js';
export interface MailTaskRecord {
 connectionId:string;connectionEpoch:string;googleAccountId:string;incarnation:string;requestId:string;request:string;
 source?:import('./attachments.js').MailSourceSelection;
 /** Durable execution claim; interrupted operations are never automatically stolen. */
 active?:string;
 edits:Record<string,{draft:DraftRef;contentHash:string;result?:DraftRef}>;
}
export interface GmailDraftPublication {
 id:string;requestId:string;binding:MailSendBinding;connectionId:string;
 state:'approved'|'intent'|'verified'|'uncertain'|'denied';
 providerDraftId?:string;providerMessageId?:string;providerThreadId?:string;code?:string;
}
