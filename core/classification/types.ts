// Downstream permitted-evidence seam, not an observation ledger or OS privacy proof.
export const vocabularyVersion = 'spindle-vocabulary/v1' as const;
export const categoryIds = ['work', 'learning', 'communication', 'admin', 'personal', 'leisure', 'uncategorized'] as const;
export const activityIds = ['reading', 'watching', 'listening', 'coding', 'writing', 'meeting'] as const;
export type ConceptKind = 'category' | 'activity' | 'topic' | 'project' | 'course' | 'entity';
export interface Concept {
  ownerId: string; id: string; kind: ConceptKind; name: string; definition: string; aliases: string[];
  revision: number; retired: boolean; saved: boolean;
  sharedMap: { version: typeof vocabularyVersion; id: string } | null;
}
export type Field<T> = { state: 'value'; value: T } | { state: 'empty' | 'denied' | 'unsupported' | 'unavailable' | 'stale' };
export interface EvidenceRef {
  ownerId: string; recordingId: string; visitId: string; evidenceId: string;
  evidenceRevision: number; consentRevision: number; policyRevision: number; deletionRevision: number;
}
export interface PermittedEvidence {
  ref: EvidenceRef;
  source: 'native' | 'browser'; coverage: 'observed' | 'unknown' | 'partial';
  appId: Field<string>; domain: Field<string>; title: Field<string>; text: Field<string>;
}
export interface Labels { categoryId: string; activityId: string | null; relatedIds: string[] }
export interface RuleScope { source: 'native' | 'browser'; appId?: string; domain?: string; titleContains?: string }
export interface LabelRule { id: string; scope: RuleScope; labels: Labels }
export interface Assignment {
  schema: 'spindle-assignment/v1'; vocabularyVersion: typeof vocabularyVersion;
  ref: EvidenceRef; catalogueRevision: number; ruleRevision: number; correctionRevision: number; lifecycleRevision: number;
  labels: Labels; concepts: Concept[];
  source: 'override' | 'rule' | 'inference' | 'abstention';
  basis: string; confidence: number | null; inferenceSource: SuggestionSource | null;
  // Short model-written phrase ("Researching visa requirements") shown only while the
  // inference itself is shown. Overrides and rules carry null: the user's labels stand alone.
  description: string | null;
  // Confidence is epistemic, never allocated seconds or proof of attention.
}
export interface SuggestionTicket {
  key: string; ref: EvidenceRef; catalogueRevision: number; ruleRevision: number;
  correctionRevision: number; lifecycleRevision: number;
}
export interface SuggestionSource { engine: string; version: string; promptDigest: string | null }
// Target is user configuration; matching/accounting/enforcement is not implemented here.
export interface TimeTarget { id: string; conceptIds: string[]; match: 'any' | 'all'; direction: 'at-least' | 'at-most'; seconds: number }
export const descriptionLimit = 60;
/** Normalizes a model description. Returns null for empty/absent, undefined when invalid. */
export function cleanDescription(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) return undefined;
  const text = value.trim().replace(/ {2,}/g, ' ');
  if (!text) return null;
  return text.length <= descriptionLimit ? text : undefined;
}
