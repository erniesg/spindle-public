import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalLabels } from '../../core/classification/local.js';
import type { PermittedEvidence, Labels } from '../../core/classification/types.js';
import { filmFixture } from '../fixtures/classification.js';

const labels = (categoryId: string, activityId: string | null = null, relatedIds: string[] = []): Labels => ({ categoryId, activityId, relatedIds });
const evidence = (visitId = 'v1', text = ''): PermittedEvidence => ({
  ref: { ownerId: 'sample-user', recordingId: 'r1', visitId, evidenceId: 'e1', evidenceRevision: 1, consentRevision: 1, policyRevision: 1, deletionRevision: 0 },
  source: 'browser', coverage: 'observed', appId: { state: 'value', value: 'chromium' }, domain: { state: 'value', value: 'video.example' },
  title: { state: 'value', value: 'Invented film' }, text: text ? { state: 'value', value: text } : { state: 'unavailable' },
});
function setup() { const engine = new LocalLabels('sample-user'); engine.setProcessing(true); engine.admit(evidence()); return engine; }

test('cold start and unknown coverage abstain; app/domain alone cannot prove study or project', () => {
  const engine = setup();
  const a = engine.inspect('r1', 'v1');
  assert.equal(a.source, 'abstention'); assert.equal(a.labels.categoryId, 'uncategorized');
  assert.equal(a.labels.activityId, null); assert.deepEqual(a.labels.relatedIds, []);
  engine.admit({ ...evidence('v2', 'function demo() { return 1; }'), coverage: 'unknown' });
  assert.equal(engine.inspect('r1', 'v2').source, 'abstention');
  engine.admit(evidence('v3', 'function demo() { return 1; }'));
  assert.equal(engine.inspect('r1', 'v3').labels.activityId, 'coding');
  assert.equal(engine.inspect('r1', 'v3').confidence, null); // Heuristic, not calibrated model inference.
});

test('exact correction beats explicit scoped rules; correction never creates a future rule; undo works', () => {
  const engine = setup();
  engine.setRule({ id: 'video', scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure', 'watching') });
  engine.correct('r1', 'v1', labels('learning', 'watching'));
  assert.equal(engine.inspect('r1', 'v1').source, 'override');
  engine.admit(evidence('v2'));
  assert.equal(engine.inspect('r1', 'v2').labels.categoryId, 'leisure');
  assert.equal(engine.undo('r1', 'v1'), true);
  assert.equal(engine.inspect('r1', 'v1').source, 'rule');
  engine.removeRule('video');
  assert.equal(engine.inspect('r1', 'v1').source, 'abstention');
});

test('equal-specificity conflicting rules abstain; a narrower explicit rule wins', () => {
  const engine = setup();
  const scope = { source: 'browser' as const, domain: 'video.example' };
  engine.setRule({ id: 'rest', scope, labels: labels('leisure') });
  engine.setRule({ id: 'study', scope, labels: labels('learning') });
  assert.equal(engine.inspect('r1', 'v1').basis, 'conflicting-rules');
  engine.setRule({ id: 'film', scope: { ...scope, titleContains: 'Invented film' }, labels: labels('personal') });
  assert.equal(engine.inspect('r1', 'v1').labels.categoryId, 'personal');
});

test('personal concepts retain IDs through rename; retirement prevents automatic assignment, not history', () => {
  const engine = setup();
  engine.rename('leisure', 'Entertainment');
  assert.equal(engine.concepts().find(c => c.id === 'leisure')?.name, 'Entertainment');
  const project = engine.createConcept('project', 'Paper kites', 'Invented project', { saved: true });
  engine.correct('r1', 'v1', labels('work', 'coding', [project.id]));
  engine.rename(project.id, 'Paper gliders'); engine.retire(project.id);
  assert.equal(engine.inspect('r1', 'v1').labels.relatedIds[0], project.id);
  assert.throws(() => engine.correct('r1', 'v1', labels('work', null, [project.id])), /RETIRED_CONCEPT/);
  assert.throws(() => engine.correct('r1', 'v1', labels('made-up')), /UNKNOWN_CONCEPT/);
  assert.throws(() => engine.correct('r1', 'v1', labels('watching')), /WRONG_FACET/);
});

test('consent, correction, catalogue, rule, replacement and deletion fences reject late suggestions', () => {
  for (const fence of ['pause', 'correction', 'catalogue', 'rule', 'replacement', 'deletion'] as const) {
    const engine = setup(); const ticket = engine.beginSuggestion('r1', 'v1');
    if (fence === 'pause') engine.setProcessing(false);
    if (fence === 'correction') engine.correct('r1', 'v1', labels('personal'));
    if (fence === 'catalogue') engine.rename('leisure', 'Entertainment');
    if (fence === 'rule') engine.setRule({ id: 'r', scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure') });
    if (fence === 'replacement') engine.admit({ ...evidence(), ref: { ...evidence().ref, evidenceRevision: 2 } });
    if (fence === 'deletion') engine.delete('r1', 'v1');
    assert.equal(engine.applySuggestion(ticket, labels('learning'), { engine: 'synthetic', version: 'v1', promptDigest: null }), false, fence);
    if (fence === 'deletion') { assert.throws(() => engine.inspect('r1', 'v1'), /NOT_FOUND/); assert.throws(() => engine.admit(evidence()), /DELETED/); }
  }
});

test('replacing an evidence revision cannot overwrite a different evidence or source identity', () => {
  const engine = setup(); engine.correct('r1', 'v1', labels('personal'));
  assert.throws(() => engine.admit({ ...evidence(), source: 'native', ref: { ...evidence().ref, evidenceRevision: 2 } }), /IDENTITY_MISMATCH/);
  assert.throws(() => engine.admit({ ...evidence(), ref: { ...evidence().ref, evidenceId: 'other-evidence', evidenceRevision: 2 } }), /IDENTITY_MISMATCH/);
  assert.equal(engine.inspect('r1', 'v1').source, 'override');
});

test('undo removes the last borrowed reference to an unsaved concept after its original source is deleted', () => {
  const engine = setup(); engine.admit(evidence('v2'));
  const temporary = engine.createConcept('topic', 'TEMPORARY_SECRET', 'Only linked sources', { saved: false, recordingId: 'r1', visitId: 'v1' });
  engine.correct('r1', 'v2', labels('learning', null, [temporary.id]));
  engine.delete('r1', 'v1');
  assert.ok(engine.concepts().some(c => c.id === temporary.id));
  engine.undo('r1', 'v2');
  assert.ok(!engine.concepts().some(c => c.id === temporary.id));
});

test('retired narrow rule is a visible blocker, not silent fallback to a broader choice', () => {
  const engine = setup();
  engine.setRule({ id: 'broad', scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure') });
  const special = engine.createConcept('category', 'Invented special meaning', 'User choice', { saved: true });
  engine.setRule({ id: 'narrow', scope: { source: 'browser', domain: 'video.example', titleContains: 'Invented' }, labels: labels(special.id) });
  engine.retire(special.id);
  assert.equal(engine.inspect('r1', 'v1').source, 'abstention');
  assert.equal(engine.inspect('r1', 'v1').basis, 'retired-rule-concept');
  engine.removeRule('narrow');
  assert.equal(engine.inspect('r1', 'v1').labels.categoryId, 'leisure');
});

test('source deletion removes correction-only concepts and undo data; explicit saved vocabulary/rules survive', () => {
  const engine = setup();
  const temporary = engine.createConcept('topic', 'Invented temporary topic', 'Only this source', { saved: false, recordingId: 'r1', visitId: 'v1' });
  const saved = engine.createConcept('course', 'Invented saved course', 'Explicit configuration', { saved: true });
  engine.correct('r1', 'v1', labels('learning', null, [temporary.id, saved.id]));
  engine.delete('r1', 'v1');
  assert.ok(!JSON.stringify(engine.concepts()).includes('Invented temporary topic'));
  assert.ok(engine.concepts().some(c => c.id === saved.id));
  assert.throws(() => engine.undo('r1', 'v1'), /NOT_FOUND/);
});

test('same content has different personal meanings without changing shared IDs', () => {
  for (const categoryId of ['learning', 'leisure']) {
    const engine = new LocalLabels(filmFixture.ref.ownerId); engine.setProcessing(true); engine.admit(filmFixture);
    engine.correct(filmFixture.ref.recordingId, filmFixture.ref.visitId, labels(categoryId, 'watching'));
    const result = engine.inspect(filmFixture.ref.recordingId, filmFixture.ref.visitId);
    assert.equal(result.labels.categoryId, categoryId); assert.equal(result.source, 'override');
  }
});

test('successful suggestions are bounded, provenance-bound and one-shot; user rules still win', () => {
  const engine = setup(); const ticket = engine.beginSuggestion('r1', 'v1');
  const source = { engine: 'synthetic-not-a-model', version: 'v1', promptDigest: 'a'.repeat(64) };
  assert.equal(engine.applySuggestion(ticket, labels('learning', 'watching'), source), true);
  const result = engine.inspect('r1', 'v1');
  assert.equal(result.source, 'inference'); assert.deepEqual(result.inferenceSource, source);
  assert.equal(engine.applySuggestion(ticket, labels('work'), source), false);
  engine.setRule({ id: 'r', scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure') });
  assert.equal(engine.inspect('r1', 'v1').source, 'rule');
  for (let i = 0; i < 8; i++) engine.beginSuggestion('r1', 'v1');
  assert.throws(() => engine.beginSuggestion('r1', 'v1'), /JOB_BOUND/);
  engine.setProcessing(false); engine.setProcessing(true);
  assert.doesNotThrow(() => engine.beginSuggestion('r1', 'v1'));
});

test('saved configuration export excludes source context, corrections and temporary concepts', () => {
  const engine = setup();
  const temporary = engine.createConcept('topic', 'TEMPORARY_SECRET', 'Only this source', { saved: false, recordingId: 'r1', visitId: 'v1' });
  engine.correct('r1', 'v1', labels('learning', null, [temporary.id]));
  const config = engine.exportConfiguration();
  assert.ok(!JSON.stringify(config).includes('TEMPORARY_SECRET'));
  assert.ok(!('ref' in config)); assert.ok(!('history' in config));
  const topic = engine.createConcept('topic', 'Invented saved topic', 'Explicit configuration', { saved: true });
  assert.throws(() => engine.mapConcept(topic.id, 'work'), /INVALID_MAPPING/);
  const personalCategory = engine.createConcept('category', 'Wind-down', 'Invented personal grouping', { saved: true });
  engine.mapConcept(personalCategory.id, 'leisure');
  assert.deepEqual(engine.concepts().find(c => c.id === personalCategory.id)?.sharedMap, { version: 'spindle-vocabulary/v1', id: 'leisure' });
  engine.setRule({ id: 'r', scope: { source: 'browser', domain: 'video.example' }, labels: labels(personalCategory.id) });
  engine.retire(personalCategory.id);
  assert.equal(engine.inspect('r1', 'v1').source, 'override');
  engine.undo('r1', 'v1');
  assert.equal(engine.inspect('r1', 'v1').basis, 'retired-rule-concept');
});

test('retained source/tombstone, concept, rule, related-label and undo bounds fail closed', () => {
  const engine = setup();
  for (let i = 0; i < 20; i++) engine.correct('r1', 'v1', labels('personal'));
  assert.throws(() => engine.correct('r1', 'v1', labels('personal')), /UNDO_BOUND/);
  const topic = engine.createConcept('topic', 'Invented topic', 'Sample', { saved: true });
  assert.throws(() => engine.correct('r1', 'v1', labels('work', null, Array(17).fill(topic.id))), /LABEL_BOUND/);
  for (let i = 0; i < 64; i++) engine.setRule({ id: `r${i}`, scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure') });
  assert.throws(() => engine.setRule({ id: 'over', scope: { source: 'browser', domain: 'video.example' }, labels: labels('leisure') }), /RULE_BOUND/);
  while (engine.concepts().length < 256) engine.createConcept('topic', 'Invented topic', 'Sample', { saved: true });
  assert.throws(() => engine.createConcept('topic', 'Over', 'Sample', { saved: true }), /CATALOGUE_BOUND/);
  for (let i = 2; i <= 300; i++) engine.admit(evidence(`v${i}`));
  engine.delete('r1', 'v1');
  assert.throws(() => engine.admit(evidence('over')), /SOURCE_BOUND/);
});

test('processing is explicit; outputs cannot mutate internal state or expose denied fields', () => {
  const engine = new LocalLabels('sample-user');
  assert.throws(() => engine.admit(evidence()), /PROCESSING_OFF/);
  engine.setProcessing(true);
  const denied = Object.defineProperty({ state: 'denied' as const }, 'value', { get() { throw new Error('DENIED_FIELD_READ'); } });
  engine.admit({ ...evidence(), title: denied, text: denied });
  const result = engine.inspect('r1', 'v1'); result.labels.categoryId = 'work'; result.ref.ownerId = 'other-user';
  assert.equal(engine.inspect('r1', 'v1').labels.categoryId, 'uncategorized');
  assert.equal(engine.inspect('r1', 'v1').ref.ownerId, 'sample-user');
  assert.throws(() => engine.admit({ ...evidence('other'), ref: { ...evidence('other').ref, ownerId: 'other-user' } }), /OWNER_MISMATCH/);
  engine.setProcessing(false); assert.throws(() => engine.inspect('r1', 'v1'), /PROCESSING_OFF/);
});
