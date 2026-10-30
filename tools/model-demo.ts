// Explicit synthetic schema/consent demonstration; transport is mocked, no network/key lookup.
import { LocalLabels } from '../core/classification/local.js';
import { CallBudget, TextProvider, type ModelDeclaration } from '../core/models/provider.js';
import { ModelOperations, RemoteConsent, type HistoryReader, type TargetReader } from '../core/models/operations.js';
import { filmFixture } from '../tests/fixtures/classification.js';
const model: ModelDeclaration = { provider: 'nebius', id: 'synthetic-not-a-live-model', text: true, jsonObject: true, inputContextTokens: 16384, maxOutputTokens: 512, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, source: 'https://example.org/invented-prices', verifiedAt: new Date().toISOString() } };
const budget = new CallBudget(0.1, 2), consent = new RemoteConsent();
let mockCalls = 0;
const client = new TextProvider(model, budget, async () => 'synthetic-key', async (_url, request) => {
  mockCalls++;
  const proposal = String(request?.body).includes('minutesPerDay');
  const value = proposal ? { minutesPerDay: 20, evidenceIds: ['e1'] } : { decision: 'suggest', categoryId: 'leisure', activityId: 'watching', relatedIds: [] };
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
});
const labels = new LocalLabels(filmFixture.ref.ownerId); labels.setProcessing(true); labels.admit(filmFixture);
const operations = new ModelOperations(consent, client);
const disabled = await operations.classify(labels, 'sample-recording', 'film-visit');
consent.grant({ provider: 'nebius', modelId: model.id, operations: ['classify', 'preview-time-limit'], fields: ['title', 'domain', 'observedSeconds', 'spanDays', 'coverage', 'targetMaximumMinutes'] });
const classification = await operations.classify(labels, 'sample-recording', 'film-visit');
const targets: TargetReader = { get: () => ({ id: 'invented-target', revision: 1, domain: 'video.example', maximumMinutesPerDay: 30 }), current: () => true };
const week: HistoryReader = { query: () => ({ revision: 'invented-week-v1', spanDays: 7, coverage: 1, entries: [{ id: 'invented-week-summary', domain: 'video.example', observedSeconds: 7 * 3600 }] }), current: () => true };
const short: HistoryReader = { query: () => ({ revision: 'invented-ten-seconds', spanDays: 10 / 86400, coverage: 1, entries: [] }), current: () => true };
const insufficient = await operations.previewTimeLimit(short, { limit: 20 }, targets, 'invented-target');
const preview = await operations.previewTimeLimit(week, { limit: 20 }, targets, 'invented-target');
consent.revoke();
console.log(JSON.stringify({ scope: 'synthetic mock, not model inference or authenticated Nebius/NVIDIA execution; no real spend or enforcement', disabled, classification, insufficient, preview, mockCalls, mockBudget: budget.snapshot() }, null, 2));
