import { randomUUID } from 'node:crypto';
import {
  activityIds, categoryIds, cleanDescription, vocabularyVersion,
  type Assignment, type Concept, type ConceptKind, type Field, type Labels, type LabelRule,
  type PermittedEvidence, type SuggestionSource, type SuggestionTicket,
} from './types.js';

const copy = <T>(value: T): T => structuredClone(value);
const keyFor = (recordingId: string, visitId: string) => JSON.stringify([recordingId, visitId]);
const blank = (): Labels => ({ categoryId: 'uncategorized', activityId: null, relatedIds: [] });
const bounded = (value: string, limit: number) => typeof value === 'string' && value.length > 0 && value.length <= limit;
interface Entry { evidence: PermittedEvidence; correctionRevision: number; history: Labels[]; suggestion: { labels: Labels; source: SuggestionSource; description: string | null } | null }

// Bounded in-memory downstream consumer. No files, network, capture, clocks or duration math.
export class LocalLabels {
  readonly ownerId: string;
  #processing = false;
  #lifecycle = 0;
  #catalogueRevision = 1;
  #ruleRevision = 0;
  #concepts = new Map<string, Concept>();
  #temporarySources = new Map<string, Set<string>>();
  #temporaryOrigins = new Map<string, string>();
  #rules = new Map<string, LabelRule>();
  #entries = new Map<string, Entry>();
  #deleted = new Set<string>();
  #pending = new Map<SuggestionTicket, SuggestionTicket>();

  constructor(ownerId: string) {
    if (!bounded(ownerId, 128)) throw new Error('INVALID_OWNER');
    this.ownerId = ownerId;
    for (const [kind, ids] of [['category', categoryIds], ['activity', activityIds]] as const) {
      for (const id of ids) this.#concepts.set(id, { ownerId, id, kind, name: id[0].toUpperCase() + id.slice(1), definition: `Shared ${kind}: ${id}`, aliases: [], revision: 1, retired: false, saved: true, sharedMap: { version: vocabularyVersion, id } });
    }
  }
  setProcessing(enabled: boolean) {
    this.#processing = enabled;
    this.#lifecycle++;
    this.#invalidate();
  }
  #invalidate() { this.#pending.clear(); for (const entry of this.#entries.values()) entry.suggestion = null; }
  #invalidateEntry(key:string) {
    for(const [ticket,admitted] of this.#pending)if(admitted.key===key)this.#pending.delete(ticket);
    const entry=this.#entries.get(key);if(entry)entry.suggestion=null;
  }
  #entry(recordingId: string, visitId: string) {
    if (!this.#processing) throw new Error('PROCESSING_OFF');
    const entry = this.#entries.get(keyFor(recordingId, visitId));
    if (!entry) throw new Error('NOT_FOUND');
    return entry;
  }
  #concept(id: string, kind?: ConceptKind, allowRetired = false) {
    const concept = this.#concepts.get(id);
    if (!concept) throw new Error('UNKNOWN_CONCEPT');
    if (kind && concept.kind !== kind) throw new Error('WRONG_FACET');
    if (!allowRetired && concept.retired) throw new Error('RETIRED_CONCEPT');
    return concept;
  }
  #validateLabels(labels: Labels, allowRetired = false): Labels {
    this.#concept(labels.categoryId, 'category', allowRetired);
    if (labels.activityId !== null) this.#concept(labels.activityId, 'activity', allowRetired);
    if (!Array.isArray(labels.relatedIds) || labels.relatedIds.length > 16) throw new Error('LABEL_BOUND');
    for (const id of labels.relatedIds) {
      const concept = this.#concept(id, undefined, allowRetired);
      if (concept.kind === 'category' || concept.kind === 'activity') throw new Error('WRONG_FACET');
    }
    return { categoryId: labels.categoryId, activityId: labels.activityId, relatedIds: [...new Set(labels.relatedIds)].sort() };
  }
  #field(field: Field<string>, limit: number): Field<string> {
    if (field.state === 'value') {
      if (!bounded(field.value, limit)) throw new Error('INVALID_FIELD');
      return { state: 'value', value: field.value };
    }
    if (!['empty', 'denied', 'unsupported', 'unavailable', 'stale'].includes(field.state)) throw new Error('INVALID_FIELD');
    return { state: field.state }; // Construct: never retain a payload on a denied/missing field.
  }
  admit(input: PermittedEvidence) {
    if (!this.#processing) throw new Error('PROCESSING_OFF');
    if (input.ref.ownerId !== this.ownerId) throw new Error('OWNER_MISMATCH');
    const { recordingId, visitId, evidenceId, evidenceRevision, consentRevision, policyRevision, deletionRevision } = input.ref;
    if (![recordingId, visitId, evidenceId].every(id => bounded(id, 128)) || ![evidenceRevision, consentRevision, policyRevision, deletionRevision].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('INVALID_REF');
    if (!['native', 'browser'].includes(input.source) || !['observed', 'partial', 'unknown'].includes(input.coverage)) throw new Error('INVALID_EVIDENCE');
    const key = keyFor(recordingId, visitId);
    if (this.#deleted.has(key)) throw new Error('DELETED');
    const previous = this.#entries.get(key);
    if (previous && (input.source !== previous.evidence.source || evidenceId !== previous.evidence.ref.evidenceId)) throw new Error('IDENTITY_MISMATCH');
    if (previous && (evidenceRevision <= previous.evidence.ref.evidenceRevision || consentRevision < previous.evidence.ref.consentRevision || policyRevision < previous.evidence.ref.policyRevision || deletionRevision < previous.evidence.ref.deletionRevision)) throw new Error('STALE_EVIDENCE');
    if (!previous && this.#entries.size + this.#deleted.size >= 300) throw new Error('SOURCE_BOUND');
    const domain = this.#field(input.domain, 253);
    if (domain.state === 'value' && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(domain.value)) throw new Error('INVALID_DOMAIN');
    const evidence: PermittedEvidence = { ref: { ownerId: this.ownerId, recordingId, visitId, evidenceId, evidenceRevision, consentRevision, policyRevision, deletionRevision }, source: input.source, coverage: input.coverage, domain, appId: this.#field(input.appId, 128), title: this.#field(input.title, 256), text: this.#field(input.text, 4096) };
    this.#entries.set(key, { evidence, correctionRevision: (previous?.correctionRevision ?? 0) + 1, history: [], suggestion: null });
    this.#invalidateEntry(key);
    this.#scrubTemporary(key);
  }
  concepts() { return copy([...this.#concepts.values()]); }
  createConcept(kind: ConceptKind, name: string, definition: string, retention: { saved: true } | { saved: false; recordingId: string; visitId: string }) {
    if (!['category', 'activity', 'topic', 'project', 'course', 'entity'].includes(kind) || !bounded(name, 80) || !bounded(definition, 256)) throw new Error('INVALID_CONCEPT');
    if (this.#concepts.size >= 256) throw new Error('CATALOGUE_BOUND');
    let source: string | undefined;
    if (!retention.saved) { this.#entry(retention.recordingId, retention.visitId); source = keyFor(retention.recordingId, retention.visitId); }
    const id = `c-${randomUUID()}`;
    const concept: Concept = { ownerId: this.ownerId, id, kind, name, definition, aliases: [], revision: 1, retired: false, saved: retention.saved, sharedMap: null };
    this.#concepts.set(id, concept);
    if (source) { this.#temporarySources.set(id, new Set([source])); this.#temporaryOrigins.set(id, source); }
    this.#catalogueRevision++; this.#invalidate();
    return copy(concept);
  }
  rename(id: string, name: string) {
    if (!bounded(name, 80)) throw new Error('INVALID_CONCEPT');
    const concept = this.#concept(id, undefined, true);
    concept.name = name; concept.revision++; this.#catalogueRevision++; this.#invalidate();
  }
  define(id: string, definition: string, aliases: string[]) {
    if (!bounded(definition, 256) || aliases.length > 8 || !aliases.every(a => bounded(a, 80))) throw new Error('INVALID_CONCEPT');
    const concept = this.#concept(id, undefined, true);
    concept.definition = definition; concept.aliases = [...new Set(aliases)]; concept.revision++;
    this.#catalogueRevision++; this.#invalidate();
  }
  saveConcept(id: string) {
    const concept = this.#concept(id, undefined, true);
    concept.saved = true; concept.revision++; this.#temporarySources.delete(id); this.#temporaryOrigins.delete(id); this.#catalogueRevision++; this.#invalidate();
  }
  mapConcept(id: string, sharedId: string) {
    const concept = this.#concept(id);
    const ids: readonly string[] = concept.kind === 'category' ? categoryIds : concept.kind === 'activity' ? activityIds : [];
    if (!ids.includes(sharedId)) throw new Error('INVALID_MAPPING');
    concept.sharedMap = { version: vocabularyVersion, id: sharedId }; concept.revision++; this.#catalogueRevision++; this.#invalidate();
  }
  retire(id: string) {
    if (id === 'uncategorized') throw new Error('REQUIRED_SENTINEL');
    const concept = this.#concept(id, undefined, true);
    concept.retired = true; concept.revision++; this.#catalogueRevision++; this.#invalidate();
  }
  setRule(rule: LabelRule) {
    const scope = rule.scope;
    if (!bounded(rule.id, 128) || !['native', 'browser'].includes(scope.source) || ![scope.appId, scope.domain, scope.titleContains].some(x => x !== undefined)) throw new Error('INVALID_RULE');
    if ([scope.appId, scope.domain, scope.titleContains].some(x => x !== undefined && !bounded(x, 256))) throw new Error('INVALID_RULE');
    if (!this.#rules.has(rule.id) && this.#rules.size >= 64) throw new Error('RULE_BOUND');
    const labels = this.#validateLabels(rule.labels);
    for (const id of [labels.categoryId, labels.activityId, ...labels.relatedIds]) if (id && !this.#concept(id).saved) throw new Error('SAVE_CONCEPT_FIRST');
    // Rules are explicitly saved user configuration, never an inferred side effect of correction.
    this.#rules.set(rule.id, { id: rule.id, scope: { source: scope.source, ...(scope.appId !== undefined ? { appId: scope.appId } : {}), ...(scope.domain !== undefined ? { domain: scope.domain } : {}), ...(scope.titleContains !== undefined ? { titleContains: scope.titleContains } : {}) }, labels });
    this.#ruleRevision++; this.#invalidate();
  }
  removeRule(id: string) { if (this.#rules.delete(id)) { this.#ruleRevision++; this.#invalidate(); } }
  correct(recordingId: string, visitId: string, labels: Labels) {
    const entry = this.#entry(recordingId, visitId);
    const validated = this.#validateLabels(labels);
    if (entry.history.length >= 20) throw new Error('UNDO_BOUND');
    entry.history.push(validated); entry.correctionRevision++; this.#invalidateEntry(keyFor(recordingId,visitId));
    for (const id of [validated.categoryId, validated.activityId, ...validated.relatedIds]) if (id) this.#temporarySources.get(id)?.add(keyFor(recordingId, visitId));
  }
  undo(recordingId: string, visitId: string) {
    const entry = this.#entry(recordingId, visitId);
    if (!entry.history.length) return false;
    entry.history.pop(); entry.correctionRevision++; this.#invalidateEntry(keyFor(recordingId,visitId));
    const key = keyFor(recordingId, visitId);
    for (const [id, sources] of this.#temporarySources) {
      const used = entry.history.some(labels => labels.categoryId === id || labels.activityId === id || labels.relatedIds.includes(id));
      if (!used && this.#temporaryOrigins.get(id) !== key) sources.delete(key);
    }
    this.#removeUnreferenced();
    return true;
  }
  #stamp(recordingId: string, visitId: string): SuggestionTicket {
    const entry = this.#entry(recordingId, visitId);
    return { key: keyFor(recordingId, visitId), ref: copy(entry.evidence.ref), catalogueRevision: this.#catalogueRevision, ruleRevision: this.#ruleRevision, correctionRevision: entry.correctionRevision, lifecycleRevision: this.#lifecycle };
  }
  permittedFields(recordingId: string, visitId: string, fields: readonly ('appId' | 'domain' | 'title' | 'text')[]) {
    const entry = this.#entry(recordingId, visitId);
    if (fields.length > 4 || fields.some(field => !['appId', 'domain', 'title', 'text'].includes(field))) throw new Error('INVALID_FIELDS');
    return copy({ ref: entry.evidence.ref, source: entry.evidence.source, coverage: entry.evidence.coverage, fields: Object.fromEntries(fields.map(field => [field, entry.evidence[field]])) });
  }
  suggestionCurrent(ticket: SuggestionTicket) {
    const admitted = this.#pending.get(ticket);
    if (!admitted || !this.#processing || JSON.stringify(ticket) !== JSON.stringify(admitted) || !this.#entries.has(admitted.key)) return false;
    return JSON.stringify(this.#stamp(admitted.ref.recordingId, admitted.ref.visitId)) === JSON.stringify(admitted);
  }
  cancelSuggestion(ticket: SuggestionTicket) { this.#pending.delete(ticket); }
  beginSuggestion(recordingId: string, visitId: string) {
    if (this.#pending.size >= 8) throw new Error('JOB_BOUND');
    const ticket = this.#stamp(recordingId, visitId);
    this.#pending.set(ticket, copy(ticket));
    return ticket;
  }
  applySuggestion(ticket: SuggestionTicket, labels: Labels, source: SuggestionSource, description?: string | null) {
    const current = this.suggestionCurrent(ticket);
    const admitted = this.#pending.get(ticket); this.#pending.delete(ticket);
    if (!current || !admitted) return false;
    const entry = this.#entries.get(admitted.key);
    if (!entry || entry.evidence.coverage !== 'observed' || JSON.stringify(this.#stamp(admitted.ref.recordingId, admitted.ref.visitId)) !== JSON.stringify(admitted)) return false;
    if (!bounded(source.engine, 64) || !bounded(source.version, 64) || (source.promptDigest !== null && !/^[a-f0-9]{64}$/.test(source.promptDigest))) return false;
    const text = cleanDescription(description);
    if (text === undefined) return false;
    try { entry.suggestion = { labels: this.#validateLabels(labels), source: { engine: source.engine, version: source.version, promptDigest: source.promptDigest }, description: text }; }
    catch { return false; }
    return true;
  }
  inspect(recordingId: string, visitId: string): Assignment {
    const entry = this.#entry(recordingId, visitId), e = entry.evidence;
    let labels = blank(), source: Assignment['source'] = 'abstention', basis = e.coverage === 'observed' ? 'insufficient-evidence' : 'unknown-or-partial-coverage';
    let inferenceSource: SuggestionSource | null = null, description: string | null = null;
    const override = entry.history.at(-1);
    if (override) { labels = override; source = 'override'; basis = 'exact-user-correction'; }
    else {
      const matched = [...this.#rules.values()].filter(rule => rule.scope.source === e.source && (rule.scope.appId === undefined || e.appId.state === 'value' && e.appId.value === rule.scope.appId) && (rule.scope.domain === undefined || e.domain.state === 'value' && e.domain.value === rule.scope.domain) && (rule.scope.titleContains === undefined || e.title.state === 'value' && e.title.value.includes(rule.scope.titleContains)));
      const specificity = (rule: LabelRule) => [rule.scope.appId, rule.scope.domain, rule.scope.titleContains].filter(x => x !== undefined).length;
      const best = matched.filter(rule => specificity(rule) === Math.max(...matched.map(specificity)));
      if (best.length) {
        const decisions = new Set(best.map(rule => JSON.stringify(rule.labels)));
        if (decisions.size > 1) basis = 'conflicting-rules';
        else { try { labels = this.#validateLabels(best[0].labels); source = 'rule'; basis = `explicit-rule:${best.map(rule => rule.id).sort().join(',')}`; } catch { basis = 'retired-rule-concept'; } }
      } else if (e.coverage === 'observed') {
        if (entry.suggestion) { labels = entry.suggestion.labels; source = 'inference'; basis = `${entry.suggestion.source.engine}:${entry.suggestion.source.version}`; inferenceSource = entry.suggestion.source; description = entry.suggestion.description; }
        else if (e.text.state === 'value' && /\bfunction\s+\w+\s*\(/.test(e.text.value) && !this.#concept('coding', 'activity', true).retired) { labels.activityId = 'coding'; source = 'inference'; basis = 'local-code-cue/v1;uncalibrated'; inferenceSource = { engine: 'local-code-cue', version: 'v1', promptDigest: null }; }
      }
    }
    const ids = [labels.categoryId, ...(labels.activityId ? [labels.activityId] : []), ...labels.relatedIds];
    const { key: _key, ...stamp } = this.#stamp(recordingId, visitId);
    return copy({ schema: 'spindle-assignment/v1', vocabularyVersion, ...stamp, labels, concepts: ids.map(id => this.#concept(id, undefined, true)), source, basis, confidence: null, inferenceSource, description });
  }
  delete(recordingId: string, visitId: string) {
    const key = keyFor(recordingId, visitId);
    // Deletion is available even when processing is paused/revoked.
    if (!this.#entries.delete(key)) return false;
    this.#deleted.add(key); this.#invalidateEntry(key); this.#scrubTemporary(key);
    return true;
  }
  #scrubTemporary(key: string) {
    for (const [id, sources] of this.#temporarySources) {
      sources.delete(key);
      if (this.#temporaryOrigins.get(id) === key) this.#temporaryOrigins.delete(id);
    }
    this.#removeUnreferenced();
  }
  #removeUnreferenced() {
    for (const [id, sources] of this.#temporarySources) {
      if (!sources.size) { this.#concepts.delete(id); this.#temporarySources.delete(id); this.#temporaryOrigins.delete(id); this.#catalogueRevision++; this.#invalidate(); }
    }
  }
  exportConfiguration() {
    // No context, source refs, correction history or temporary vocabulary crosses this boundary.
    return copy({ schema: 'spindle-label-configuration/v1', ownerId: this.ownerId, vocabularyVersion, concepts: [...this.#concepts.values()].filter(c => c.saved), rules: [...this.#rules.values()] });
  }
}
