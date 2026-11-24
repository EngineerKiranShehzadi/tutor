/**
 * Read-only retrieval benchmark for Lecture 6's 410-row Excel Q&A dataset.
 *
 * Run from backend/:
 *   ./node_modules/.bin/ts-node --transpile-only src/scripts/run-lecture6-excel-recall.ts \
 *     "$HOME/Downloads/Lecture_06_Final_Dataset_Merged_File.xlsx"
 *
 * It pins lecture 9 / dataset version 14, bypasses answer memory by calling
 * embedding + retrieval services directly, and does not call answer generation
 * or write chats/student questions. It records Phoenix traces if observability
 * is enabled and saves ranked IDs plus Recall/MRR to /tmp by default.
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { query } from '../config/database';
import { generateEmbedding } from '../services/embedding.service';
import { searchChunksHybrid } from '../services/vector-search.service';
import { rerankChunks } from '../services/rerank.service';
import { RequestTrace, recordTrace } from '../observability/tracer';
import { getLectureById } from '../services/lecture.service';

const LECTURE_ID = 9;
const DATASET_VERSION_ID = 14;
const EXPECTED_ROWS = 410;
const OUTPUT_DEFAULT = '/tmp/lecture6-excel-recall-results.json';

type Row = Record<string, unknown>;
type DbChunk = {
  id: number;
  question: string;
  chunk_index: number;
  embedded: boolean;
};

function cell(value: unknown): string {
  return String(value ?? '').trim();
}

function readCases(filePath: string) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet = workbook.Sheets.Final_Dataset;
  if (!sheet) throw new Error('Workbook sheet "Final_Dataset" was not found.');
  const rows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: '' });
  const cases = rows.map((row, i) => ({
    excelId: Number(row.ID),
    question: cell(row.Question),
    referenceAnswer: cell(row.Answer),
    source: cell(row.Source),
    sourceReference: cell(row['Source Reference']),
    scope: cell(row.Scope),
    rowNumber: i + 2,
  }));
  if (cases.length !== EXPECTED_ROWS) {
    throw new Error(`Expected ${EXPECTED_ROWS} Final_Dataset rows; found ${cases.length}. No provider calls made.`);
  }
  if (cases.some(c => !c.excelId || !c.question || !c.referenceAnswer)) {
    throw new Error('A row is missing ID, Question, or Answer. No provider calls made.');
  }
  const questionSet = new Set(cases.map(c => c.question));
  if (questionSet.size !== cases.length) {
    throw new Error('Duplicate questions found. Resolve them before scoring one-row/one-gold-chunk Recall.');
  }
  return cases;
}

async function resolveGoldIds(cases: ReturnType<typeof readCases>) {
  const { rows } = await query<DbChunk>(
    `SELECT c.id, c.question, c.chunk_index,
            (c.local_embedding IS NOT NULL) AS embedded
       FROM lecture_qna_chunks c
       JOIN dataset_version_chunks dvc ON dvc.chunk_id = c.id
      WHERE c.lecture_id = $1 AND dvc.version_id = $2
      ORDER BY c.id`,
    [LECTURE_ID, DATASET_VERSION_ID]
  );
  if (rows.length !== EXPECTED_ROWS) {
    throw new Error(`Lecture ${LECTURE_ID}, version ${DATASET_VERSION_ID}: expected ${EXPECTED_ROWS} DB chunks, found ${rows.length}. No provider calls made.`);
  }
  const byQuestion = new Map<string, DbChunk[]>();
  for (const row of rows) byQuestion.set(row.question, [...(byQuestion.get(row.question) ?? []), row]);
  for (const testCase of cases) {
    const matches = byQuestion.get(testCase.question) ?? [];
    if (matches.length !== 1) {
      throw new Error(`Excel ID ${testCase.excelId}: expected one exact DB question match; found ${matches.length}. No provider calls made.`);
    }
    const match = matches[0];
    if (!match.embedded || match.chunk_index !== 0) {
      throw new Error(`Excel ID ${testCase.excelId}: DB chunk ${match.id} is not embedded or has a nonzero chunk_index.`);
    }
    (testCase as typeof testCase & { expectedChunkId?: number }).expectedChunkId = match.id;
  }
  return rows.length;
}

function idsFromSpans(spans: any[], spanName: string): number[] {
  const span = spans.find(s => s.name === spanName);
  const value = String(span?.metadata.candidateIds ?? '');
  return value.split(',').filter(Boolean).map(Number);
}

function rankOf(ids: number[], expectedId: number): number | null {
  const i = ids.indexOf(expectedId);
  return i < 0 ? null : i + 1;
}

function summarize(cases: any[], key: 'vectorIds' | 'hybridIds' | 'rerankedIds') {
  const valid = cases.filter(c => !c.error && Array.isArray(c[key]));
  const out: Record<string, unknown> = { evaluated: valid.length, failed: cases.length - valid.length };
  for (const k of [1, 5, 10, 15]) {
    const hits = valid.filter(c => c[key].slice(0, k).includes(c.expectedChunkId)).length;
    const reciprocals = valid.map(c => {
      const rank = rankOf(c[key], c.expectedChunkId);
      return rank !== null && rank <= k ? 1 / rank : 0;
    });
    out[`Recall@${k}`] = valid.length ? hits / valid.length : null;
    out[`MRR@${k}`] = valid.length ? reciprocals.reduce((a, b) => a + b, 0) / valid.length : null;
  }
  return out;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: run-lecture6-excel-recall.ts /path/to/Lecture_06_Final_Dataset_Merged_File.xlsx [output.json]');
  const filePath = path.resolve(input);
  if (!fs.existsSync(filePath)) throw new Error(`Workbook not found: ${filePath}`);

  const cases: any[] = readCases(filePath);
  const dbCount = await resolveGoldIds(cases);
  const lecture = await getLectureById(LECTURE_ID);
  console.log(`Preflight passed: ${cases.length} Excel rows ↔ ${dbCount} embedded chunks; lecture=${LECTURE_ID}, datasetVersion=${DATASET_VERSION_ID}.`);
  console.log('Running retrieval and reranking only. No answer-generation calls or chat writes.');

  const results: any[] = [];
  for (const [i, testCase] of cases.entries()) {
    const trace = new RequestTrace('lecture6-excel-recall-case');
    trace.setAttributes({
      evaluationCaseId: `excel-${String(testCase.excelId).padStart(3, '0')}`,
      lectureId: LECTURE_ID,
      datasetVersionId: DATASET_VERSION_ID,
      expectedChunkId: testCase.expectedChunkId,
      evaluationRun: 'lecture6-excel-410-row-recall',
    });
    try {
      const result = await trace.runAsActive(async () => {
        const embedding = await trace.span('generate-query-embedding',
          () => generateEmbedding(testCase.question, true),
          vector => ({ vectorDimension: vector.length }));
        const hybrid = await trace.span('vector-search',
          () => searchChunksHybrid(embedding, testCase.question, LECTURE_ID, 15, DATASET_VERSION_ID),
          chunks => ({ lectureId: LECTURE_ID, datasetVersionId: DATASET_VERSION_ID, candidateLimit: 15, candidateCount: chunks.length, candidateIds: chunks.map(c => c.id).join(',') }));
        const reranked = await trace.span('rerank-candidates',
          () => rerankChunks(testCase.question, hybrid, Math.max(hybrid.length, 1)),
          chunks => ({ rerankerInputCount: hybrid.length, rerankerOutputCount: chunks.length, rerankedIds: chunks.map(c => c.id).join(',') }));
        return { hybrid, reranked };
      });
      const finished = trace.end('SUCCESS', { responseStatus: result.hybrid.length ? 'RETRIEVED' : 'NO_CANDIDATES' });
      await recordTrace(finished);
      const vectorIds = idsFromSpans(finished.spans, 'collect-vector-candidates');
      const hybridIds = idsFromSpans(finished.spans, 'merge-retrieval-candidates');
      const rerankedIds = result.reranked.map(c => c.id);
      results.push({
        id: `excel-${String(testCase.excelId).padStart(3, '0')}`,
        excelRowId: testCase.excelId,
        question: testCase.question,
        referenceAnswer: testCase.referenceAnswer,
        source: testCase.source,
        sourceReference: testCase.sourceReference,
        scope: testCase.scope,
        lectureId: LECTURE_ID,
        datasetVersionId: DATASET_VERSION_ID,
        traceId: finished.traceId,
        expectedChunkId: testCase.expectedChunkId,
        vectorIds,
        hybridIds,
        rerankedIds,
        vectorRank: rankOf(vectorIds, testCase.expectedChunkId),
        hybridRank: rankOf(hybridIds, testCase.expectedChunkId),
        rerankedRank: rankOf(rerankedIds, testCase.expectedChunkId),
        latencyMs: Math.round(finished.durationMs),
      });
    } catch (err) {
      results.push({
        id: `excel-${String(testCase.excelId).padStart(3, '0')}`,
        excelRowId: testCase.excelId,
        question: testCase.question,
        referenceAnswer: testCase.referenceAnswer,
        lectureId: LECTURE_ID,
        datasetVersionId: DATASET_VERSION_ID,
        expectedChunkId: testCase.expectedChunkId,
        vectorIds: [], hybridIds: [], rerankedIds: [],
        vectorRank: null, hybridRank: null, rerankedRank: null,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[${i + 1}/${cases.length}] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 25 === 0 || i + 1 === cases.length) console.log(`[${i + 1}/${cases.length}] complete`);
    await sleep(150);
  }

  const output = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceFile: path.basename(filePath),
    lectureId: LECTURE_ID,
    datasetVersionId: DATASET_VERSION_ID,
    goldDefinition: 'One expected chunk per Excel Q&A row, resolved by exact question match in the pinned DB version.',
    metrics: {
      rawVector: summarize(results, 'vectorIds'),
      hybrid: summarize(results, 'hybridIds'),
      reranked: summarize(results, 'rerankedIds'),
    },
    cases: results,
  };
  const outPath = path.resolve(process.argv[3] ?? OUTPUT_DEFAULT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), { mode: 0o600 });
  console.log(`Saved results to ${outPath}`);
  console.log(JSON.stringify(output.metrics, null, 2));
}

main().catch(err => {
  console.error(`[EXCEL RECALL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
