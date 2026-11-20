// Offline integration checks for document section mapping.
// No database, model or network requests are made.
import assert from 'assert/strict';
import { visualTimeConflict } from '../services/document-vision.service';
import {
  documentToRows,
  supportedDatasetExtension,
  runDocumentExtractor,
  applyVisualReviewDecisions,
} from '../services/document-ingestion.service';
import { buildChunkPieces, buildChunkPiecesReport, MAX_PIECES_PER_ROW, SPLIT_THRESHOLD_CHARS, toFileRowsReport } from '../services/chunk.service';
import { matchRows } from '../services/dataset-plan';

async function run() {
  const sourceSchedule = 'Spend Time in Park (with Kids) | 16:30 to 17:315';
  assert.equal(visualTimeConflict('Spend Time in Park (with Kids) (16:30 to 17:15)', sourceSchedule), true,
    'visual model must not silently rewrite a source time');
  assert.equal(visualTimeConflict('Spend Time in Park (with Kids) (16:30 to 17:315)', sourceSchedule), false);
  assert.equal(visualTimeConflict('This page contains a balanced-life schedule.', sourceSchedule), false);

  // Shared indexing must never silently discard the tail of an oversized answer.
  const shortRow = { question: 'What is a variable?', answer: 'A named storage location.' };
  assert.deepEqual(await buildChunkPieces(shortRow), (await buildChunkPiecesReport(shortRow)).pieces);
  const oversizedRow = {
    question: 'Explain the full sequence.',
    answer: Array.from({ length: 1800 }, (_, i) => `Distinct explanation segment ${i}: a complete detail for retrieval.`).join('\\n\\n'),
  };
  const preview = await buildChunkPiecesReport(oversizedRow);
  assert.ok(preview.splitInto > MAX_PIECES_PER_ROW, 'oversized fixture must exceed the limit');
  assert.equal(preview.pieces.length, MAX_PIECES_PER_ROW, 'preview retains bounded sample');
  await assert.rejects(buildChunkPieces(oversizedRow), /exceeds the safe chunk limit/);

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
  assert.equal(rows.rows.length, 1, 'one PDF page remains one logical planner row');
  assert.equal(rows.units, 1);
  assert.equal(rows.warnings.length, 1);
  assert.ok(rows.rows[0].question?.includes('chapter-one.pdf | Page 3 | Part 1'));
  assert.equal(rows.rows[0].start_time, 'chapter-one.pdf | Page 3');
  const { pieces: pagePieces, splitInto: pageSplitCount } = await buildChunkPiecesReport(rows.rows[0]);
  assert.ok(pageSplitCount > 1, 'oversized page content splits once at the chunking boundary');
  assert.equal(new Set(pagePieces.map(p => p.chunkIndex)).size, pagePieces.length);
  assert.ok(pagePieces.every(p => p.chunkText.includes('Source excerpt: chapter-one.pdf | Page 3 | Part ')), 'source context is repeated for child chunks');

  // Excel remains a separate path: curated Q&A pairs up to 3,200 characters
  // stay atomic and preserve chunk_index 0.
  assert.equal(SPLIT_THRESHOLD_CHARS, 3200);
  const excelQuestion = 'What does the lecture say?';
  const excelPrefix = `Question: ${excelQuestion}\nAnswer: `;
  const excelAtomic = { question: excelQuestion, answer: 'x'.repeat(3199 - excelPrefix.length) };
  const excelPieces = await buildChunkPiecesReport(excelAtomic);
  assert.equal(excelPieces.splitInto, 1, 'Excel Q&A up to threshold stays whole');
  assert.deepEqual(excelPieces.pieces.map(p => p.chunkIndex), [0]);
  assert.equal(excelPieces.pieces[0].chunkText.length, 3199);

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
  assert.equal(structured.rows.length, 1, 'a short PPTX slide, including visual notes, stays a single source unit');
  assert.equal(structured.rows[0].topic, 'Slide 4');
  assert.match(structured.rows[0].answer!, /No to Fail/);
  assert.match(structured.rows[0].question!, /Slide 4 \| Part 1/);
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

  const unpaired = await documentToRows('questions.docx', {
    units: [{locator:'Slide 5',text:[
      'Questions to ask the image:',
      'What is the main theme?',
      'What colors are visible?',
      'What is the ratio of people to objects?',
      'Please answer these questions using the image.'
    ].join('\n')}],warnings:[]
  });
  assert.equal(unpaired.quality.qaRecords,0,'question lists are not falsely marked as answered');
  const combined=unpaired.rows.map(x=>x.answer).join(' ');
  assert.match(combined,/main theme/);
  assert.match(combined,/colors are visible/);
  assert.match(combined,/ratio of people/);

  const standalone = await documentToRows('intro.docx',{
    units:[{locator:'Slide 3',text:[
      'Achieve Excellence in Technical Skills','Question',
      'What is the Best Learning Methodology to achieve excellence in Technical Skills?',
      'Answer','DO IT YOURSELF'
    ].join('\n')}],warnings:[]
  });
  assert.equal(standalone.quality.qaRecords,1);
  assert.match(standalone.rows.find(x=>x.question?.includes('Best Learning'))?.answer??'',/DO IT YOURSELF/);
  const standaloneAnswer = standalone.rows.find(x=>x.question?.includes('Best Learning'));
  assert.ok(standaloneAnswer,'standalone Q&A is present');
  assert.doesNotMatch(standaloneAnswer!.answer??'',/^nswer\b/i,'Answer label must not leak into answer');
  assert.match((await buildChunkPiecesReport(standaloneAnswer!)).pieces[0].chunkText,/Topic: Achieve Excellence in Technical Skills/,'topic must accompany QA evidence');
  assert.equal(standaloneAnswer!.topic,'Achieve Excellence in Technical Skills');

  const typoLabel = await documentToRows('intro.docx',{
    units:[{locator:'Slide 2',text:[
      'Life','Quesiton','Life = Technical Skills (?) + Human Engineering (?)',
      'Answer','Life = Technical Skills (15%) + Human Engineering (85%)'
    ].join('\n')}],warnings:[]
  });
  assert.equal(typoLabel.quality.qaRecords,1);
  assert.match(typoLabel.rows.find(x=>x.question?.includes('Life ='))?.answer??'',/85%/);

  const longQA = await documentToRows('long-explanation.docx', {
    units:[{locator:'Slide 10',text:[
      'Q: How does a zero-shot prompt work?',
      'A: A zero-shot prompt gives instructions without worked examples. ' +
        'It focuses on explicit task wording and the expected output. '.repeat(55)
    ].join('\n\n')}],warnings:[],
  });
  assert.equal(longQA.rows.length,1,'documentToRows emits one logical Q&A row before chunking');
  const longQAPieces=await buildChunkPiecesReport(longQA.rows[0]);
  assert.ok(longQAPieces.splitInto>1,'oversized Q&A answer splits in the chunk service exactly once');
  assert.ok(longQAPieces.pieces.every(p=>p.chunkText.includes('zero-shot prompt')),'each child repeats its question');
  assert.equal(new Set(longQAPieces.pieces.map(p=>p.chunkIndex)).size,longQAPieces.pieces.length);
  const plannerRow=toFileRowsReport(longQA.rows).rows[0];
  const plannedPieces=await buildChunkPiecesReport({
    topic:plannerRow.topic??undefined,question:plannerRow.question,answer:plannerRow.answer,
    is_document_chunk:plannerRow.isDocumentChunk,is_document_atomic:plannerRow.isDocumentAtomic,
  });
  assert.equal(plannedPieces.splitInto,longQAPieces.splitInto,
    'document marker survives planner mapping, preventing a second, different split');

  assert.equal(questionAnswer.quality.qaRecords,2);
  assert.equal(questionAnswer.quality.qaChildRecords,2);
  assert.equal(longQA.quality.qaRecords,1);
  assert.equal(longQA.quality.qaChildRecords,1);
  assert.equal(longQA.quality.outputRecords,longQA.rows.length);
  await assert.rejects(
    documentToRows('broken.docx',{units:[{locator:'Slide 8',text:'Question: What is AI?'}],warnings:[]}),
    /no matching Answer/
  );
  await assert.rejects(
    documentToRows('broken.docx',{units:[{locator:'Slide 8',text:'Answer: a missing question.'}],warnings:[]}),
    /without its Question/
  );
  const mcqOptions=await documentToRows('mcq-slides.docx',{
    units:[{locator:'Slide 5',text:'Common choices:\nA. Zero shot\nB. Few shot\nExplanation: These are prompting techniques.'}],warnings:[]
  });
  assert.ok(mcqOptions.rows.length>0,'MCQ answer options and ordinary explanation headings must be accepted');
  const inlineQA=await documentToRows('inline.docx',{
    units:[{locator:'Slide 11',text:'Question: Define zero-shot prompting. Answer: Prompting without worked examples.'}],warnings:[]
  });
  assert.equal(inlineQA.quality.qaRecords,1);
  assert.match(inlineQA.rows[0].question!,/Define zero-shot/);
  assert.match(inlineQA.rows[0].answer!,/without worked examples/);

  const titleScoped=await documentToRows('lecture.docx',{
    units:[{locator:'Slide 12',text:'Slide 12: Semantic Context\n'+
      'Definition: a logical group of related material. '.repeat(90)}],warnings:[]
  });
  assert.equal(titleScoped.rows.length,1);
  assert.match(titleScoped.rows[0].answer!,/^Slide 12: Semantic Context/);
  assert.equal(new Set(titleScoped.rows.map(r=>r.start_time)).size,1);
  
  const repeatedLong = await documentToRows('long-explanation.docx',{
    units:[{locator:'Slide 10',text:[
      'Q: How does a zero-shot prompt work?',
      'A: A zero-shot prompt gives instructions without examples. '+
      'It focuses on explicit tasks. '.repeat(80)
    ].join('\n\n')}],warnings:[]
  });
  assert.equal(repeatedLong.rows.length,1);
  assert.equal(repeatedLong.rows[0].qa_id,longQA.rows[0].qa_id,
    'logical document QA IDs must remain stable when answer text changes');

  // Duplicate headings/questions on separate slides receive deterministic
  // source identities, so both MERGE and REPLACE can safely plan the file.
  const duplicateSlides=await documentToRows('duplicates.pptx',{units:[
    {locator:'Slide 24',text:'Question: What is an ethical prompt?\nAnswer: It follows ethical principles.'},
    {locator:'Slide 25',text:'Question: What is an ethical prompt?\nAnswer: It avoids harm and bias.'},
  ],warnings:[]});
  const duplicateFileRows=toFileRowsReport(duplicateSlides.rows).rows;
  assert.notEqual(duplicateFileRows[0].qaId,duplicateFileRows[1].qaId);
  for(const mode of ['MERGE','REPLACE']){
    const fresh=matchRows(duplicateFileRows,[],()=>`new-test-row`);
    assert.deepEqual(fresh.errors,[],`${mode}: duplicate slide questions must not be ambiguous`);
    const active=duplicateFileRows.map((r,i)=>({qaId:r.qaId!,fields:{
      topic:r.topic,question:r.question,answer:r.answer,start_time:r.start_time,end_time:r.end_time,keywords:r.keywords,llm_name:r.llm_name,
    }}));
    const update=matchRows(duplicateFileRows,active,()=>`new-test-row`);
    assert.deepEqual(update.errors,[],`${mode}: repeated upload must match its deterministic source IDs`);
  }

  const mediumSlide=await documentToRows('deck.pptx',{units:[{
    locator:'Slide 7',text:'A slide-level statement. '+ 'Keep this slide content together. '.repeat(45),
  }],warnings:[]});
  const mediumSlidePieces=await buildChunkPiecesReport(mediumSlide.rows[0]);
  assert.equal(mediumSlidePieces.splitInto,1,'PPTX slides below 2,200 chars stay atomic');

  const pptxQASlide=await documentToRows('qa-slide.pptx',{units:[{
    locator:'Slide 8',text:'Question: What is integrity?\nAnswer: Acting by consistent principles. '.repeat(10),
  }],warnings:[]});
  assert.equal(pptxQASlide.rows.length,1,'short slide Q&A stays within its slide-level chunk');
  assert.match((await buildChunkPiecesReport(pptxQASlide.rows[0])).pieces[0].chunkText,/Question: What is integrity/);

  const same = await documentToRows('chapter-one.pdf', {
    units: [{ locator: 'Page 3', text: 'Python variables store values. '.repeat(95) }],
    warnings: [],
  });
  assert.deepEqual(rows.rows, same.rows, 'source labels must remain stable across uploads');

  const extracted = await runDocumentExtractor(
    Buffer.from('Loops repeat work.\\nA for loop iterates over items.', 'utf8'), '.txt'
  );
  assert.equal(extracted.units[0].locator, 'Section 1');
  assert.ok(extracted.units[0].text.includes('for loop'));

  await assert.rejects(
    runDocumentExtractor(Buffer.from('not a pdf'), '.pdf'),
    /not a PDF/
  );
  await assert.rejects(
    documentToRows('empty.txt', { units: [], warnings: [] }),
    /No selectable text/
  );
  // --- applyVisualReviewDecisions: a visual must appear exactly once ---
  const inlineRow = () => ({
    qa_id: 'x1', is_document_chunk: true,
    question: 'Source excerpt: deck.pptx | Slide 16 | Part 1',
    answer: 'Native slide text.\n\n[Diagram and figure interpretation from Slide 16]\n\nVisual topic: Ethics\nThe table shows A, B, C.',
    topic: 'Slide 16', start_time: 'deck.pptx | Slide 16',
  });
  const page16 = { locator: 'Slide 16', confidence: 1, reason: '', image: '', candidateDescription: 'The table shows A, B, C in detail.', candidateIncluded: true };

  const inlineIncluded = applyVisualReviewDecisions([inlineRow()], [page16], { 'Slide 16': { include: true, reviewed: true } }, 'deck.pptx');
  assert.equal(inlineIncluded.length, 1, 'inline visual + include must not add a duplicate record');
  assert.ok(inlineIncluded[0].answer!.includes('[Diagram and figure interpretation from Slide 16]'), 'inline visual preserved when included');
  assert.ok(!inlineIncluded.some(r => typeof r.question === 'string' && r.question.includes('| Slide 16 | Visual')), 'no separate Visual row added for an inline visual');

  const inlineExcluded = applyVisualReviewDecisions([inlineRow()], [page16], { 'Slide 16': { include: false, reviewed: true } }, 'deck.pptx');
  assert.equal(inlineExcluded.length, 1, 'excluding an inline visual keeps the native row');
  assert.ok(!inlineExcluded[0].answer!.includes('[Diagram and figure interpretation'), 'excluded inline visual is stripped out');
  assert.equal(inlineExcluded[0].answer!.trim(), 'Native slide text.', 'native slide text is retained after stripping the visual');

  const nativeOnly = () => ({
    qa_id: 'y1', is_document_chunk: true,
    question: 'Source excerpt: deck.pptx | Slide 27 | Part 1',
    answer: 'Common Approaches heading only.', topic: 'Slide 27', start_time: 'deck.pptx | Slide 27',
  });
  const page27 = { locator: 'Slide 27', confidence: 1, reason: '', image: '', candidateDescription: 'A four-row approaches table with principles.', candidateIncluded: false };

  const separateAdded = applyVisualReviewDecisions([nativeOnly()], [page27], { 'Slide 27': { include: true, reviewed: true } }, 'deck.pptx');
  assert.equal(separateAdded.length, 2, 'a non-inline visual that is included becomes one separate record');
  assert.ok(separateAdded.some(r => typeof r.question === 'string' && r.question.includes('| Slide 27 | Visual 1')), 'separate Visual 1 row is added');

  const separateExcluded = applyVisualReviewDecisions([nativeOnly()], [page27], { 'Slide 27': { include: false, reviewed: true } }, 'deck.pptx');
  assert.equal(separateExcluded.length, 1, 'excluding a non-inline visual adds nothing');

  console.log('Document ingestion checks passed');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
