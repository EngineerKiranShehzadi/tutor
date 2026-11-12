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
  assert.equal(supportedDatasetExtension('legacy.PPT'), '.ppt');
  assert.equal(supportedDatasetExtension('explanation.txt'), '.txt');
  assert.equal(supportedDatasetExtension('lesson.html'), '.html');
  assert.equal(supportedDatasetExtension('qa.xlsx'), '.xlsx');
  assert.equal(supportedDatasetExtension('lesson.srt'), '.srt');
  assert.equal(supportedDatasetExtension('lesson.vtt'), '.vtt');
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

  const visual = await documentToRows('programming.pptx', {
    units: [{
      locator: 'Slide 8',
      text: 'A flowchart decides which branch runs.\\n\\n[Diagram and figure interpretation]\\nDiamond labeled Condition. Yes arrow to Task A. No arrow to Task B.'
    }],
    warnings: ['Vision-grounded description attached'],
  });
  assert.equal(visual.rows[0].start_time, 'programming.pptx | Slide 8');
  assert.match(visual.rows[0].answer!, /Condition/);
  assert.match(visual.rows[0].answer!, /Yes arrow/);
  assert.match(visual.rows[0].answer!, /A flowchart decides/);

  const structured = await documentToRows('flowchart.pptx', {
    units: [{ locator: 'Slide 4',
      text: 'If statements choose a branch.\n\n[Diagram and figure interpretation from Slide 4]\n\nVisual topic: Conditional statements\nA decision diamond controls branching.\nDiagram nodes and labels: Start | marks >= 50 | Pass | Fail\nDiagram edges and directions: Yes to Pass | No to Fail'
    }],
    warnings: [],
  });
  assert.equal(structured.rows.length, 2);
  assert.equal(structured.rows[0].topic, undefined);
  assert.equal(structured.rows[1].topic, 'Conditional statements');
  assert.match(structured.rows[1].answer!, /No to Fail/);
  assert.match(structured.rows[1].question!, /Visual 1/);
  assert.match(structured.rows[0].answer!, /If statements/);

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
