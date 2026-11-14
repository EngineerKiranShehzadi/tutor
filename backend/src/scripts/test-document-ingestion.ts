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

  const questionAnswer = await documentToRows('slide-lecture.docx', {
    units: [{locator:'Slide 9',text:[
      'Slide 9: Fundamentals of Prompt Engineering',
      'Question: What are the five main types of prompts?',
      'Answer: Descriptive, Instructional, Conversational, Creative and Comparative prompts.',
      'Question: What is a Creative Prompt?',
      'Answer: It encourages imaginative output such as a poem.',
    ].join('\n\n')}], warnings:[],
  });
  const qaRows = questionAnswer.rows.filter(r=>!r.question?.startsWith('Source excerpt:'));
  assert.equal(qaRows.length,2,'each question and its answer must form a complete retrieval row');
  assert.match(qaRows[0].question!,/five main types/i);
  assert.match(qaRows[0].answer!,/Comparative/);
  assert.match(qaRows[1].question!,/Creative Prompt/);
  assert.match(qaRows[1].answer!,/imaginative output/);
  for(const q of qaRows){
    const chunk=await buildChunkPiecesReport(q);
    assert.equal(chunk.splitInto,1);
    assert.match(chunk.pieces[0].chunkText,/Question:.*\nAnswer:/);
  }

  const longQA = await documentToRows('long-explanation.docx', {
    units:[{locator:'Slide 10',text:[
      'Q: How does a zero-shot prompt work?',
      'A: A zero-shot prompt gives instructions without worked examples. ' +
        'It focuses on explicit task wording and the expected output. '.repeat(55)
    ].join('\n\n')}],warnings:[],
  });
  assert.ok(longQA.rows.length>1,'long Q&A must split safely');
  for(const child of longQA.rows){
    assert.match(child.question!,/zero-shot prompt/i,'every child retains the parent question');
    assert.ok(child.answer?.trim(),'every child preserves nonempty answer evidence');
    const built=await buildChunkPiecesReport(child);
    assert.equal(built.splitInto,1,'no second Q/A split is allowed');
  }

  assert.equal(questionAnswer.quality.qaRecords,2);
  assert.equal(questionAnswer.quality.qaChildRecords,2);
  assert.equal(longQA.quality.qaRecords,1);
  assert.equal(longQA.quality.qaChildRecords,longQA.rows.length);
  assert.equal(longQA.quality.outputRecords,longQA.rows.length);
  await assert.rejects(
    documentToRows('broken.docx',{units:[{locator:'Slide 8',text:'Question: What is AI?'}],warnings:[]}),
    /no matching Answer/
  );
  await assert.rejects(
    documentToRows('broken.docx',{units:[{locator:'Slide 8',text:'Answer: a missing question.'}],warnings:[]}),
    /without its Question/
  );
  const repeatedLong = await documentToRows('long-explanation.docx',{
    units:[{locator:'Slide 10',text:[
      'Q: How does a zero-shot prompt work?',
      'A: A zero-shot prompt gives instructions without examples. '+
      'It focuses on explicit tasks. '.repeat(80)
    ].join('\\n\\n')}],warnings:[]
  });
  assert.equal(new Set(repeatedLong.rows.map(r=>r.question)).size,repeatedLong.rows.length,
    'long Q/A children require stable unique question identities on repeat uploads');

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
