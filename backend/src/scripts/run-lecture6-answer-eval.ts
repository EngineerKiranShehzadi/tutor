/**
 * Lecture 6 correctness/grounding answer run for the 410-row Final_Dataset
 * plus the 11-question Out_Of_Scope_Set_S28-54 sheet.
 *
 * Run from backend/ after copying this file to src/scripts/.
 * Optional third argument is a case limit for a small smoke run.
 * This uses the real askLectureAgent pipeline and pins retrieval to lecture 9,
 * dataset version 14. It bypasses answer memory, creates a fresh temporary
 * chat session per case, then deletes the session/chat row after saving each
 * result. Phoenix/RAG request traces remain available for review.
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { query } from '../config/database';
import { askLectureAgent, createChatSession, deleteChatSession } from '../services/chat.service';
import { getLectureById } from '../services/lecture.service';
import { recordTrace } from '../observability/tracer';

const LECTURE_ID = 9;
const DATASET_VERSION_ID = 14;
const EXPECTED_ANSWERABLE = 410;
const EXPECTED_OOS = 11;
const DEFAULT_OUTPUT = '/tmp/lecture6-answer-eval-results.json';

type XRow = Record<string, unknown>;
type Case = {
  id: string;
  kind: 'ANSWERABLE' | 'EXPECTED_REFUSAL';
  question: string;
  referenceAnswer: string | null;
  source: string | null;
  sourceReference: string | null;
  evidence: string | null;
  scopeReason?: string | null;
  expectedBehavior?: string | null;
  expectedChunkId?: number;
};
type DbChunk = { id: number; question: string; chunk_index: number; embedded: boolean };

const clean = (v: unknown): string => String(v ?? '').trim();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function readCases(file: string): Case[] {
  const wb = XLSX.readFile(file, { raw: false });
  const main = wb.Sheets.Final_Dataset;
  const oos = wb.Sheets['Out_Of_Scope_Set_S28-54'];
  if (!main) throw new Error('Workbook is missing sheet Final_Dataset.');
  if (!oos) throw new Error('Workbook is missing sheet Out_Of_Scope_Set_S28-54.');

  const inScope = XLSX.utils.sheet_to_json<XRow>(main, { defval: '' }).map((r, i): Case => ({
    id: `lec6-${String(r.ID).padStart(3, '0')}`,
    kind: 'ANSWERABLE',
    question: clean(r.Question),
    referenceAnswer: clean(r.Answer),
    source: clean(r.Source),
    sourceReference: clean(r['Source Reference']),
    evidence: clean(r.Evidence),
  }));
  const outOfScope = XLSX.utils.sheet_to_json<XRow>(oos, { defval: '' }).map((r): Case => ({
    id: `lec6-oos-${String(r.ID).padStart(2, '0')}`,
    kind: 'EXPECTED_REFUSAL',
    question: clean(r['Student Question']),
    referenceAnswer: null,
    source: null,
    sourceReference: null,
    evidence: null,
    scopeReason: clean(r['Why It Is Not Answerable From This Material']),
    expectedBehavior: clean(r['Expected RAG Behaviour']),
  }));

  if (inScope.length !== EXPECTED_ANSWERABLE || outOfScope.length !== EXPECTED_OOS) {
    throw new Error(`Workbook row check failed: found ${inScope.length} answerable and ${outOfScope.length} OOS; expected ${EXPECTED_ANSWERABLE} + ${EXPECTED_OOS}. No questions run.`);
  }
  if ([...inScope, ...outOfScope].some(c => !c.question || !c.id) || inScope.some(c => !c.referenceAnswer)) {
    throw new Error('Workbook contains a blank question or answerable reference answer. No questions run.');
  }
  return [...inScope, ...outOfScope];
}

async function preflight(cases: Case[]) {
  const answerable = cases.filter(c => c.kind === 'ANSWERABLE');
  const { rows } = await query<DbChunk>(
    `SELECT c.id, c.question, c.chunk_index,
            (c.local_embedding IS NOT NULL) AS embedded
       FROM lecture_qna_chunks c
       JOIN dataset_version_chunks dvc ON dvc.chunk_id = c.id
      WHERE c.lecture_id = $1 AND dvc.version_id = $2
      ORDER BY c.id`,
    [LECTURE_ID, DATASET_VERSION_ID]
  );
  if (rows.length !== EXPECTED_ANSWERABLE) {
    throw new Error(`Pinned lecture ${LECTURE_ID}/version ${DATASET_VERSION_ID} has ${rows.length} chunks; expected ${EXPECTED_ANSWERABLE}. No answer calls made.`);
  }
  const grouped = new Map<string, DbChunk[]>();
  for (const r of rows) grouped.set(r.question, [...(grouped.get(r.question) ?? []), r]);
  for (const c of answerable) {
    const match = grouped.get(c.question) ?? [];
    if (match.length !== 1 || !match[0].embedded || match[0].chunk_index !== 0) {
      throw new Error(`${c.id}: expected exactly one embedded Q&A chunk in version ${DATASET_VERSION_ID}; found ${match.length}. No answer calls made.`);
    }
    c.expectedChunkId = match[0].id;
  }
}

async function resolveStudentId(email: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]
  );
  if (!rows[0]) throw new Error(`Test account ${email} was not found in users. Set RAG_TEST_EMAIL to an existing student account.`);
  return rows[0].id;
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: run-lecture6-answer-eval.ts /path/to/Lecture_06_Final_Dataset_Merged_File.xlsx [output.json]');
  const workbookPath = path.resolve(input);
  if (!fs.existsSync(workbookPath)) throw new Error(`Workbook not found: ${workbookPath}`);
  const email = process.env.RAG_TEST_EMAIL ?? 'ragtest@local.test';

  const allCases = readCases(workbookPath);
  await preflight(allCases);
  const limit = Number(process.argv[4] ?? 0);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Case limit must be a non-negative integer.');
  const cases = limit > 0 ? allCases.slice(0, limit) : allCases;
  const lecture = await getLectureById(LECTURE_ID);
  if (!lecture.title.toLowerCase().includes('evaluation')) {
    throw new Error(`Lecture id ${LECTURE_ID} title did not match Lecture 6: ${lecture.title}. No answer calls made.`);
  }
  const studentId = await resolveStudentId(email);
  const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const completed = new Map<string, any>();
  if (fs.existsSync(outputPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      for (const c of old.cases ?? []) if (c.answer && !c.error) completed.set(c.id, c);
    } catch { /* an unreadable prior output is replaced after the preflight */ }
  }

  console.log(`Preflight passed: ${EXPECTED_ANSWERABLE} Q&A rows pinned to lecture ${LECTURE_ID}/version ${DATASET_VERSION_ID}, plus ${EXPECTED_OOS} expected-refusal cases.`);
  if (limit > 0) console.log(`Smoke run limited to first ${cases.length} case(s).`);
  console.log(`Resuming ${completed.size}/${cases.length} completed cases. Each request uses the real answer pipeline; answer memory is disabled for this evaluation.`);

  for (const [index, c] of cases.entries()) {
    if (completed.has(c.id)) continue;
    let sessionId: number | undefined;
    let finishedTrace: any;
    const result: any = {
      ...c,
      lectureId: LECTURE_ID,
      datasetVersionId: DATASET_VERSION_ID,
      expectedBehavior: c.expectedBehavior ?? (c.kind === 'ANSWERABLE' ? 'Answer from lecture content.' : undefined),
    };
    try {
      const session = await createChatSession(studentId, LECTURE_ID);
      sessionId = session.id;
      const answerResult = await askLectureAgent(
        { studentId, lectureId: LECTURE_ID, question: c.question, sessionId },
        {
          datasetVersionId: DATASET_VERSION_ID,
          // Do not let a cached answer replace a fresh retrieval/generation result.
          lookupAnswerMemory: async () => ({ hit: null, embedding: null, datasetVersionId: DATASET_VERSION_ID, lookupFailed: false }),
          writeAnswerMemory: async () => {},
          recordMemoryHit: async () => {},
          onTraceComplete: async trace => { finishedTrace = trace; await recordTrace(trace); },
        }
      );
      result.answer = answerResult.answer;
      result.sources = answerResult.sources.map((s: any) => ({
        id: s.id, question: s.question, topic: s.topic ?? null, chunkText: s.chunk_text,
      }));
      result.sourceChunkIds = answerResult.sources.map((s: any) => s.id);
      result.traceId = finishedTrace?.traceId ?? null;
      result.responseStatus = finishedTrace?.attributes?.responseStatus ?? null;
      completed.set(c.id, result);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`[${index + 1}/${cases.length}] ${c.id} failed: ${result.error}`);
      completed.set(c.id, result);
    } finally {
      if (sessionId !== undefined) {
        try { await deleteChatSession(studentId, sessionId); }
        catch (err) { console.error(`Could not clean temporary session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`); }
      }
    }

    const ordered = cases.filter(x => completed.has(x.id)).map(x => completed.get(x.id));
    const output = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceFile: path.basename(workbookPath),
      lectureId: LECTURE_ID,
      datasetVersionId: DATASET_VERSION_ID,
      answerableCount: EXPECTED_ANSWERABLE,
      expectedRefusalCount: EXPECTED_OOS,
      selectedCount: cases.length,
      evaluationNote: 'Generated answers and final retrieved source chunks are recorded. Judge answer correctness against referenceAnswer and grounding against sources[].chunkText; OOS cases should refuse without answering from outside knowledge.',
      cases: ordered,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), { mode: 0o600 });
    if ((index + 1) % 10 === 0 || index + 1 === cases.length) console.log(`[${index + 1}/${cases.length}] processed; saved ${completed.size} results.`);
    await pause(300);
  }
  console.log(`Finished. Results: ${outputPath}`);
}

main().catch(err => {
  console.error(`[LECTURE 6 ANSWER EVAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
