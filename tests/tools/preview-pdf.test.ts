import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

const run = promisify(execFile);
const fixtureText = 'Viewer/download fixture only \u2014 not preparation or AI output';
const poppler = process.env.SPINDLE_DOCUMENT_TEST_PDFTOTEXT;
const extractionSkip = !poppler ? 'Configure an absolute trusted SPINDLE_DOCUMENT_TEST_PDFTOTEXT path.' : false;

async function loadGenerator() {
  return import(new URL('../../tools/generate-preview-pdf.js', import.meta.url).href);
}

async function temporaryOutput() {
  const root = join(process.cwd(), '.local', 'pdf-fixture-build');
  await mkdir(root, { recursive: true });
  return join(await mkdtemp(join(root, 'preview-pdf-')), 'new-output', 'sample.pdf');
}

test('generates a parseable one-page invented PDF fixture into a new output directory', async t => {
  const output = await temporaryOutput();
  t.after(() => rm(dirname(dirname(output)), { recursive: true, force: true }));
  const { generatePreviewPdf } = await loadGenerator();

  await generatePreviewPdf(output);

  const pdf = await PDFDocument.load(await readFile(output), { updateMetadata: false });
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getTitle(), 'SPINDLE INVENTED PDF');
  assert.equal(pdf.getSubject(), fixtureText);
});

test('configured trusted extractor reads the fixture text', { skip: extractionSkip }, async t => {
  assert.ok(isAbsolute(poppler!), 'Configure an absolute trusted SPINDLE_DOCUMENT_TEST_PDFTOTEXT path.');
  const output = await temporaryOutput();
  t.after(() => rm(dirname(dirname(output)), { recursive: true, force: true }));
  const { generatePreviewPdf } = await loadGenerator();

  await generatePreviewPdf(output);

  const extracted = (await run(poppler!, [output, '-'])).stdout;
  assert.match(extracted, /SPINDLE INVENTED PDF/);
  assert.match(extracted, new RegExp(fixtureText));
});

test('CLI writes the fixed build-relative output from a private working directory', async t => {
  const root = join(process.cwd(), '.local', 'pdf-fixture-build');
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, 'preview-pdf-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../tools/generate-preview-pdf.js', import.meta.url));

  await run(process.execPath, [script], { cwd });

  const pdf = await PDFDocument.load(await readFile(join(cwd, 'build', 'core', 'preview', 'sample.pdf')), { updateMetadata: false });
  assert.equal(pdf.getTitle(), 'SPINDLE INVENTED PDF');
});

test('generates deterministic bytes without machine-specific metadata', async t => {
  const first = await temporaryOutput();
  const second = join(dirname(dirname(first)), 'second-output', 'sample.pdf');
  t.after(() => rm(dirname(dirname(first)), { recursive: true, force: true }));
  const { generatePreviewPdf } = await loadGenerator();

  await generatePreviewPdf(first);
  await generatePreviewPdf(second);

  assert.deepEqual(await readFile(first), await readFile(second));
});
