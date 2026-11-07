// Offline integration checks for document section mapping.
// No database, model or network requests are made.
import assert from 'assert/strict';
import {
  documentToRows,
  supportedDatasetExtension,
  runDocumentExtractor,
} from '../services/document-ingestion.service';
import { buildChunkPiecesReport } from '../services/chunk.service';

async function run() {
  assert.equal(supportedDatasetExtension('lecture.PDF'), '.pdf');
  assert.equal(supportedDatasetExtension('notes.docx'), '.docx');
  assert.equal(supportedDatasetExtension('slides.pptx'), '.pptx');
  assert.equal(supportedDatasetExtension('explanation.txt'), '.txt');
  assert.equal(supportedDatasetExtension('lesson.html'), '.html');
  assert.equal(supportedDatasetExtension('qa.xlsx'), '.xlsx');
  assert.equal(supportedDatasetExtension('virus.exe'), null);

  const rows = await documentToRows('chapter-one.pdf', {
    units: [{ locator: 'Page 3', text: 'Python variables store values. '.repeat(95) }],
    warnings: ['Page 2 has no selectable text'],
  });
  assert.ok(rows.rows.length > 1, 'long pages must be chunked into sections');
  assert.equal(rows.units, 1);
  assert.equal(rows.warnings.length, 1);
  assert.ok(rows.rows[0].question?.includes('chapter-one.pdf | Page 3 | Part 1'));
  assert.equal(rows.rows[0].start_time, 'chapter-one.pdf | Page 3');
  for (const row of rows.rows) {
    assert.ok(row.answer?.length);
    const { pieces, splitInto } = await buildChunkPiecesReport(row);
    assert.equal(splitInto, 1, 'document segments should fit inside the existing chunk limit');
    assert.equal(pieces.length, 1);
    assert.ok(pieces[0].chunkText.includes(row.answer!));
  }

  const same = await documentToRows('chapter-one.pdf', {
    units: [{ locator: 'Page 3', text: 'Python variables store values. '.repeat(95) }],
    warnings: [],
  });
  assert.deepEqual(rows.rows, same.rows, 'source labels must remain stable across uploads');

  const extracted = await runDocumentExtractor(
    Buffer.from('Loops repeat work.\\nA for loop iterates over items.', 'utf8'), '.txt'
  );
  assert.equal(extracted.units[0].locator, 'Document');
  assert.ok(extracted.units[0].text.includes('for loop'));

  await assert.rejects(
    runDocumentExtractor(Buffer.from('not a pdf'), '.pdf'),
    /not a PDF/
  );
  await assert.rejects(
    documentToRows('empty.txt', { units: [], warnings: [] }),
    /No selectable text/
  );
  console.log('Document ingestion checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
