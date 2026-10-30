import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitResource, type AdmissionRequest } from '../../core/blocking/admission.js';
const request: AdmissionRequest = {
 policy: {version:2, purpose:'linear algebra'},
 resource:'https://example.test/linear-algebra/lesson',
 requestedAt:100, expires:200,
};
test('a local URL cue suggests only an individual resource under the chosen purpose', async () => {
 const result = await admitResource(request, () => request.policy, () => 110);
 assert.equal(result.reason, 'allowed');
 assert.equal(result.grant?.resource, request.resource);
 assert.equal(result.grant?.purpose, 'linear algebra');
 assert.equal(result.grant?.expires, 200);
 for (const resource of ['https://example.test/comedy', 'https://example.test/', 'https://example.test/watch?id=linear-algebra']) {
  assert.equal((await admitResource({...request, resource}, () => request.policy, () => 110)).grant, undefined);
 }
});
test('in-flight inference is rejected after policy change, timeout, malformed verdict or failure', async () => {
 for (const current of [{version:3,purpose:'linear algebra'}, {version:2,purpose:'comedy'}]) {
  const result = await admitResource(request, () => current, () => 110, async () => 'allow');
  assert.equal(result.reason, 'stale');
  assert.equal(result.grant, undefined);
 }
 assert.equal((await admitResource(request, () => request.policy, () => 200, async () => 'allow')).reason, 'expired');
 for (const classifier of [async () => 'uncertain', async () => 'unlock domain', async () => {throw Error('offline');}]) {
  assert.equal((await admitResource(request, () => request.policy, () => 110, classifier)).grant, undefined);
 }
});
test('admission rejects nonfinite and excessive validity and ambiguous URL identities', async () => {
 for (const expires of [Infinity, NaN, 100, 100 + 300001]) {
  assert.equal((await admitResource({...request, expires}, () => request.policy, () => 110)).grant, undefined);
 }
 for (const resource of ['https://u:p@example.test/linear-algebra', 'https://example.test/linear-algebra?mode=comedy', 'file:///linear-algebra']) {
  assert.equal((await admitResource({...request,resource}, () => request.policy, () => 110, async () => 'allow')).grant, undefined);
 }
});
