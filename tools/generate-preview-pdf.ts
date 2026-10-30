import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const defaultOutput = resolve('build/core/preview/sample.pdf');
const title = 'SPINDLE INVENTED PDF';
const fixtureText = 'Viewer/download fixture only \u2014 not preparation or AI output';
const fixedDate = new Date('2000-01-01T00:00:00.000Z');

export async function generatePreviewPdf(outputPath = defaultOutput): Promise<void> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(title);
  pdf.setSubject(fixtureText);
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);

  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 72, y: 680, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText(fixtureText, { x: 72, y: 636, size: 12, font, color: rgb(0.1, 0.1, 0.1) });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await pdf.save({ useObjectStreams: false, addDefaultPage: false }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generatePreviewPdf(process.argv[2] ? resolve(process.argv[2]) : defaultOutput);
}
