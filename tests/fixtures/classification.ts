import type { PermittedEvidence } from '../../core/classification/types.js';

// Canonical invented downstream evidence. Not browser capture or a native receipt.
export const filmFixture: PermittedEvidence = {
  ref: { ownerId: 'sample-user', recordingId: 'sample-recording', visitId: 'film-visit', evidenceId: 'sample-evidence', evidenceRevision: 1, consentRevision: 1, policyRevision: 1, deletionRevision: 0 },
  source: 'browser', coverage: 'observed',
  appId: { state: 'value', value: 'chromium' }, domain: { state: 'value', value: 'video.example' },
  title: { state: 'value', value: 'An invented Spanish film' }, text: { state: 'unavailable' },
};
export const codeFixture: PermittedEvidence = {
  ...filmFixture, ref: { ...filmFixture.ref, visitId: 'code-visit' }, source: 'native',
  domain: { state: 'unsupported' }, appId: { state: 'value', value: 'sample-editor' },
  title: { state: 'value', value: 'Invented code' }, text: { state: 'value', value: 'function paperKite() { return 1; }' },
};
