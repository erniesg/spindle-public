// Explicit invented-fixture demo only. Never opens a browser, reads activity or writes files.
import { LocalLabels } from '../core/classification/local.js';
import { filmFixture, codeFixture } from '../tests/fixtures/classification.js';
import { categoryIds, type Labels } from '../core/classification/types.js';
const category = process.argv[2] ?? 'learning';
if (!(categoryIds as readonly string[]).includes(category)) throw new Error('Choose one shared category ID; this demo accepts no files or real activity.');
const engine = new LocalLabels(filmFixture.ref.ownerId);
engine.setProcessing(true); // Independent local processing choice for invented data, not recording consent.
engine.admit(filmFixture); engine.admit(codeFixture);
const inspect = () => engine.inspect('sample-recording', 'film-visit');
const before = inspect();
const topic = engine.createConcept('topic', 'Spanish', 'Invented correction-only topic', { saved: false, recordingId: 'sample-recording', visitId: 'film-visit' });
const saved = engine.createConcept('course', 'Paper kites', 'Invented explicitly saved configuration', { saved: true });
engine.rename('leisure', 'Entertainment');
const ticket = engine.beginSuggestion('sample-recording', 'film-visit');
const correction: Labels = { categoryId: category, activityId: 'watching', relatedIds: [topic.id] };
engine.correct('sample-recording', 'film-visit', correction);
const corrected = inspect();
const staleAccepted = engine.applySuggestion(ticket, { ...correction, categoryId: 'work' }, { engine: 'synthetic-not-a-model', version: 'v1', promptDigest: null });
engine.undo('sample-recording', 'film-visit');
const undone = inspect();
engine.correct('sample-recording', 'film-visit', correction);
engine.delete('sample-recording', 'film-visit');
console.log(JSON.stringify({ scope: 'invented local classification only; no capture, model inference, history file or time accounting', before, corrected, staleAccepted, undone, codeSuggestion: engine.inspect('sample-recording', 'code-visit'), deletion: { temporaryRemoved: !engine.concepts().some(c => c.id === topic.id), savedRetained: engine.concepts().some(c => c.id === saved.id) }, savedConfiguration: engine.exportConfiguration() }, null, 2));
