/**
 * One-off, read-only RAG batch runner for the lecture test rows in questions.csv.
 *
 * Run from backend/ with:
 *   npx ts-node --transpile-only src/scripts/run-recall-batch.ts /path/to/questions.csv
 *
 * It runs only rows whose Outcome is exactly "Answered" and whose Lecture
 * contains a PDF/DOCX/PPTX Test label. It does not copy student name/email.
 * It does not write chats or student-question rows to the application DB.
 * It does call the configured embedding, reranker, and answer providers.
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { env } from '../config/env';
import { getLectureById, getLectures } from '../services/lecture.service';
import { getActiveDatasetVersionId } from '../services/rag-answer-memory.service';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunksHybrid } from '../services/vector-search.service';
import { rerankChunks, dedupeAndSelect, reorderForContext } from '../services/rerank.service';
import { generateAnswer } from '../services/answer-generation.service';
import { getAgentProfileByLectureId } from '../services/lecture-agent-profile.service';
import { RequestTrace, recordTrace } from '../observability/tracer';
import type { QnaChunk } from '../types';

type CsvRow = Record<string, unknown>;
type TestCase = { id: string; lectureLabel: string; question: string };

const TEST_LABEL = /\((?:PDF|DOCX|PPTX)\s+Test\)/i;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function text(value: unknown): string {
  return String(value ?? '').trim();
}

function norm(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value: string): Set<string> {
  const ignored = new Set(['hum111', 'lecture', 'pdf', 'docx', 'pptx', 'test', 'the', 'and', 'of', 'for']);
  return new Set(norm(value).split(/\s+/).filter(t => t.length > 2 && !ignored.has(t)));
}

function overlapScore(a: string, b: string): number {
  const aa = tokens(a), bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  for (const token of aa) if (bb.has(token)) shared++;
  return shared / Math.max(aa.size, bb.size);
}

function readTestCases(csvPath: string): TestCase[] {
  const workbook = XLSX.readFile(csvPath, { raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error(`No sheet found in ${csvPath}`);
  const rows = XLSX.utils.sheet_to_json<CsvRow>(sheet, { defval: '' });
  const seen = new Set<string>();
  const cases: TestCase[] = [];

  for (const [index, row] of rows.entries()) {
    const lectureLabel = text(row.Lecture);
    const question = text(row.Question);
    const outcome = text(row.Outcome);
    if (!TEST_LABEL.test(lectureLabel) || outcome !== 'Answered' || !question) continue;

    // Exact duplicates can appear as a cache/memory turn in the export. Keep
    // one actual retrieval case per lecture/question pair.
    const key = `${norm(lectureLabel)}::${norm(question)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ id: `case-${String(index + 1).padStart(3, '0')}`, lectureLabel, question });
  }
  return cases;
}

async function resolveLectureId(label: string): Promise<{ id: number; title: string }> {
  const stripped = label.replace(/\s*\((?:PDF|DOCX|PPTX)\s+Test\)\s*$/i, '').trim();
  const available = await getLectures(undefined, true);
  const scored = available
    .map(lecture => ({ lecture, score: overlapScore(stripped, lecture.title) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 0.45 || (scored[1] && scored[0].score - scored[1].score < 0.08)) {
    const options = scored.slice(0, 8).map(x => `  ${x.lecture.id}: ${x.lecture.title} (match ${x.score.toFixed(2)})`).join('\n');
    throw new Error(
      `Could not safely map test label "${label}" to one lecture. ` +
      `Set an explicit numeric lecture ID in the script's LECTURE_ID_OVERRIDES map.\n${options}`
    );
  }
  return { id: scored[0].lecture.id, title: scored[0].lecture.title };
}

// Fill this map only if the automatic title match reports an ambiguity. Keys
// are the exact Lecture labels printed in questions.csv; values are DB lecture IDs.
const LECTURE_ID_OVERRIDES: Record<string, number> = {};

function csvSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function runOne(testCase: TestCase, lectureId: number, lectureTitle: string) {
  const datasetVersionId = await getActiveDatasetVersionId(lectureId);
  if (!datasetVersionId) {
    throw new Error(`Lecture ${lectureId} (${lectureTitle}) has no active dataset version.`);
  }

  const profileLookup = await getAgentProfileByLectureId(lectureId);
  const agentProfile = profileLookup.status === 'FOUND' ? profileLookup.profile : null;
  const trace = new RequestTrace('recall-batch-case');
  trace.setAttributes({
    evaluationCaseId: testCase.id,
    lectureId,
    datasetVersionId,
    evaluationRun: 'manual-40-case-format-test',
  });

  const result = await trace.runAsActive(async () => {
    const embedding = await trace.span('generate-query-embedding',
      () => generateEmbedding(testCase.question, true),
      vector => ({ vectorDimension: vector.length }));

    const pool = await trace.span('vector-search',
      () => searchChunksHybrid(embedding, testCase.question, lectureId, 15, datasetVersionId),
      chunks => ({
        lectureId,
        datasetVersionId,
        candidateLimit: 15,
        candidateCount: chunks.length,
        candidateIds: chunks.map(c => c.id).join(','),
      }));

    const rankedAll = await trace.span('rerank-candidates',
      () => rerankChunks(testCase.question, pool, Math.max(pool.length, 1)),
      chunks => ({
        rerankerInputCount: pool.length,
        rerankerOutputCount: chunks.length,
        rerankedIds: chunks.map(c => c.id).join(','),
      }));

    const { selected, dedupedAway } = dedupeAndSelect(rankedAll, 5);
    const context = reorderForContext(selected);
    const answer = context.length
      ? await trace.span('generate-grounded-answer',
          () => generateAnswer(testCase.question, context, lectureTitle, [], [], 1, undefined, agentProfile),
          value => ({ contextChunkCount: context.length, contextChunkIds: context.map(c => c.id).join(','), answerCharLength: value.length }))
      : 'I could not find this information in this lecture.';

    return { answer, pool, rankedAll, selected, context, dedupedAway };
  });

  const finished = trace.end('SUCCESS', {
    responseStatus: result.pool.length ? 'ANSWER_GENERATED' : 'NOT_FOUND',
    memoryResult: 'BYPASSED_FOR_RECALL_EVALUATION',
  });
  await recordTrace(finished);

  const vectorSpan = finished.spans.find(span => span.name === 'collect-vector-candidates');
  const hybridSpan = finished.spans.find(span => span.name === 'merge-retrieval-candidates');
  const vectorIds = text(vectorSpan?.metadata.candidateIds).split(',').filter(Boolean).map(Number);
  const hybridIds = text(hybridSpan?.metadata.candidateIds).split(',').filter(Boolean).map(Number);

  return {
    id: testCase.id,
    traceId: finished.traceId,
    question: testCase.question,
    lectureId,
    lectureTitle,
    datasetVersionId,
    answer: result.answer,
    answerable: null,
    vectorIds,
    vectorTop5Ids: vectorIds.slice(0, 5),
    hybridIds: env.RETRIEVAL.HYBRID_SEARCH_ENABLED ? hybridIds : null,
    rerankedIds: result.rankedAll.map(c => c.id),
    finalContextIds: result.selected.map(c => c.id),
    citationChunkIds: result.selected.map(c => c.id),
    refused: result.selected.length === 0,
    latencyMs: Math.round(finished.durationMs),
    human: { answerCorrect: 'UNREVIEWED', grounded: 'UNREVIEWED', citationValid: 'UNREVIEWED' },
    retrievedChunkPreview: result.selected.map((chunk: QnaChunk) => ({ id: chunk.id, text: chunk.chunk_text })),
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    throw new Error('Usage: npx ts-node --transpile-only src/scripts/run-recall-batch.ts /path/to/questions.csv');
  }
  const csvPath = path.resolve(input);
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const cases = readTestCases(csvPath);
  if (!cases.length) throw new Error('No eligible Test rows found (requires Outcome="Answered" and a PDF/DOCX/PPTX Test label).');
  console.log(`Selected ${cases.length} unique answered test questions. Student names/emails will not be copied.`);

  const lectureCache = new Map<string, { id: number; title: string }>();
  // Resolve every lecture before making any provider calls. If one label is
  // ambiguous, the script stops without spending on a partial run.
  for (const label of new Set(cases.map(c => c.lectureLabel))) {
    const overrideId = LECTURE_ID_OVERRIDES[label];
    const lecture = overrideId ? await getLectureById(overrideId) : await resolveLectureId(label);
    lectureCache.set(label, lecture);
    console.log(`Mapped "${label}" -> lecture ${lecture.id}: ${lecture.title}`);
  }

  const output: { schemaVersion: 1; createdAt: string; sourceFile: string; cases: Awaited<ReturnType<typeof runOne>>[] } = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceFile: path.basename(csvPath),
    cases: [],
  };

  for (const [index, testCase] of cases.entries()) {
    const lecture = lectureCache.get(testCase.lectureLabel)!;
    console.log(`[${index + 1}/${cases.length}] ${testCase.id} | lecture ${lecture.id}`);
    try {
      output.cases.push(await runOne(testCase, lecture.id, lecture.title));
    } catch (err) {
      output.cases.push({
        id: testCase.id,
        traceId: '', question: testCase.question,
        lectureId: lecture.id, lectureTitle: lecture.title,
        datasetVersionId: await getActiveDatasetVersionId(lecture.id),
        answer: '', answerable: null,
        vectorIds: [], vectorTop5Ids: [],
        hybridIds: env.RETRIEVAL.HYBRID_SEARCH_ENABLED ? [] : null,
        rerankedIds: [], finalContextIds: [], citationChunkIds: [],
        refused: false, latencyMs: 0,
        human: { answerCorrect: 'UNREVIEWED', grounded: 'UNREVIEWED', citationValid: 'UNREVIEWED' },
        retrievedChunkPreview: [],
        error: err instanceof Error ? err.message : String(err),
      } as Awaited<ReturnType<typeof runOne>>);
      console.error(`  Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(500);
  }

  const outPath = path.resolve(process.argv[3] ?? '/tmp/askaitutor-recall-batch-predictions.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, csvSafeJson(output), { mode: 0o600 });
  console.log(`\nSaved ${output.cases.length} result rows to ${outPath}`);
  console.log('Note: expectedChunkIds are blank. Admin-reviewed gold IDs are required before Recall@5/MRR can be scored.');
  console.log('Keep this output private; it contains test questions, generated answers, and retrieval results.');
  process.exit(0);
}

main().catch(err => {
  console.error(`[RECALL BATCH] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
