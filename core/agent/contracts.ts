import type { ArtifactRef, EvidenceRef, SourceRef } from '../evidence/types.js';
export interface SourceEvent { accountId: string; messageId: string; workspaceId: string; outcome: string }
export interface ChecklistItem { id: string; title: string; state: 'pending'|'in_progress'|'blocked'|'done'|'skipped'; dependsOn: string[]; blocker?: string }
export interface ChecklistRevision { revision: number; reason: string; items: ChecklistItem[] }
export interface ApplicationRevisionRef { applicationId: string; revision: number; contentHash: string }
export interface ExternalActionRef { id: string; state: 'intent'|'uncertain'|'verified'; authorizationId: string }
export interface ToolResult { /** Trusted explicit no-effect failure; omission never proves a write did not commit. */ effect?: 'none'; callId: string; status: 'ok'|'needs_input'|'failed'; data: unknown; artifacts: ArtifactRef[]; evidence: EvidenceRef[]; observations: string[]; error?: { code: string; message: string; producer: string } }
export interface Task {
 browser?: import('./browser-host.js').TaskBrowserState;
 mail?: import('./mail-host.js').TaskMailState;
 preparation?: import('../preparation/types.js').PreparationRecord;
 id: string; sourceEvent: SourceEvent; requestedOutcome: string; status: 'working'|'blocked'|'ready'|'cancelled';
 generation: number; run: {id: string; attempt: number; cursor: number}; checklist: ChecklistRevision;
 checklistHistory: ChecklistRevision[]; observations: ToolResult[]; decisions: Decision[];
 budget: {limit: number; used: number}; pending?: {callId: string; tool: string; effect: ToolDefinition['effect']};
 recovery: 'clean'|'reconciliation_required'; currentResult?: string; blocker?: string; nextAction: string;
 applicationRevision?: ApplicationRevisionRef; externalAction?: ExternalActionRef;
}
export interface Schema { jsonSchema: Readonly<Record<string, unknown>>; parse(value: unknown): unknown }
export interface TrustedScope { sources: SourceRef[]; destinations: string[]; grants: string[] }
export interface RunOptions {
 scope?: TrustedScope; signal?: AbortSignal; timeoutMs?: number;
 /** Autonomous hosts must report a stopped turn-bounded run as blocked; stepping callers may yield. */
 blockOnTurnLimit?:boolean;
 /** Trusted host may invalidate a run without turning supersession into owner cancellation. */
 signalMode?: 'cancel'|'supersede';
 /** Host-owned dynamic scope admits only verified connector snapshots, never model SourceRefs. */
 getScope?: () => TrustedScope;
 /** Narrow host policy; absent means deny ALL external effects. Tools still enforce provider authority. */
 approveExternalWrite?: (task: Readonly<Task>, tool: ToolDefinition, args: unknown) => boolean;
 assertReady?: (task: Readonly<Task>) => void;
}
export interface ToolContext { callId: string; scope: Readonly<TrustedScope>; budget: Readonly<Task['budget']>; taskId: string; runId: string; accountId: string; workspaceId: string; applicationRevision?: ApplicationRevisionRef; signal: AbortSignal; isCurrent(): boolean }
/** Trusted implementations resolve opaque IDs against their own permitted scope. Never accept model paths/grants as authority. */
export interface ToolDefinition { name: string; version: string; capabilities: string[]; effect: 'read'|'write_local'|'external_write'; inputSchema: Schema; outputSchema: Schema; invoke(args: unknown, context: ToolContext): Promise<ToolResult>;
 /** Host-only consumed-field declaration; never exposed in model tool metadata or accepted as arguments.
  * [] proves source/parameter-only behavior; absent means dependencies are unknown. */
 artifactFieldIds?(args:unknown,context:ToolContext):readonly string[];
}
export interface BatchCall { callId: string; name: string; args: unknown; itemId?: string }
export type Decision = {kind:'batch'; calls: BatchCall[]} | {kind:'tool'; name:string; args:unknown; itemId?:string} | {kind:'checklist'; reason:string; items:ChecklistItem[]} | {kind:'ready'; result:string};
/** Runtime-owned cancellation/currentness and a detached post-reservation task-budget snapshot. */
export interface ProviderContext { signal: AbortSignal; isCurrent(): boolean; budget: Readonly<Task['budget']> }
export interface AgentProvider { id: string; next(task: Readonly<Task>, tools: readonly ToolMetadata[], context?: ProviderContext): Promise<Decision> }

export type ToolMetadata = Pick<ToolDefinition,'name'|'version'|'effect'|'capabilities'> & { inputSchema: Schema['jsonSchema']; outputSchema: Schema['jsonSchema'] };
