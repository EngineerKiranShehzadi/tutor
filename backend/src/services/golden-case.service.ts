import { createHash } from 'crypto';
import { query } from '../config/database';
import { AppError } from '../middleware/errorHandler';

// Golden benchmark CASES — the reviewed question bank that feeds the
// deterministic evaluator. A case is drafted from a pinned dataset version's
// own chunks (never from retrieval), reviewed by a human, and only an APPROVED
// case is exported as benchmark truth. See migration 045.

const VALID_CATEGORIES = new Set([
  'factual', 'conceptual', 'comparison', 'compound', 'follow_up',
  'unsupported', 'ambiguous', 'keyword', 'paraphrase',
]);
const VALID_STATUSES = new Set(['DRAFT', 'APPROVED', 'REJECTED', 'NEEDS_EVIDENCE']);

const posInt = (v: number, name: string): number => {
  if (!Number.isSafeInteger(v) || v < 1) throw new AppError(`Invalid ${name}`, 400);
  return v;
};

export interface GoldenCase {
  id: number;
  caseKey: string;
  lectureId: number;
  datasetVersionId: number;
  question: string;
  expectedAnswer: string | null;
  expectedChunkIds: number[];
  sourceChunkIds: number[];
  category: string;
  answerable: boolean;
  reviewStatus: string;
  generationMethod: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const map = (r: any): GoldenCase => ({
  id: Number(r.id),
  caseKey: r.case_key,
  lectureId: Number(r.lecture_id),
  datasetVersionId: Number(r.dataset_version_id),
  question: r.question,
  expectedAnswer: r.expected_answer ?? null,
  expectedChunkIds: (r.expected_chunk_ids ?? []).map(Number),
  sourceChunkIds: (r.source_chunk_ids ?? []).map(Number),
  category: r.category,
  answerable: r.answerable === true,
  reviewStatus: r.review_status,
  generationMethod: r.generation_method,
  reviewedBy: r.reviewed_by ?? null,
  reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
});

// Deterministic, stable per-version id so re-drafting never renames a case and
// never clashes across versions.
const caseKey = (lectureId: number, datasetVersionId: number, qaId: string): string =>
  `L${lectureId}-V${datasetVersionId}-${createHash('sha256').update(qaId).digest('hex').slice(0, 8)}`;

/**
 * Draft benchmark cases from a dataset version's OWN Q&A chunks. Grounded only
 * in that version; evidence is the source chunk IDs (not retrieval). Existing
 * cases for the same (version, case_key) are left untouched — approved cases
 * are never silently rewritten when this is re-run. Only chunks that carry a
 * real authored question are used; synthetic "Source excerpt:" rows (document /
 * subtitle pieces) are skipped and can be added manually.
 */
export async function generateDraftCases(lectureId: number, datasetVersionId: number) {
  posInt(lectureId, 'lectureId');
  posInt(datasetVersionId, 'datasetVersionId');

  // The version must belong to the lecture.
  const owns = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM dataset_versions WHERE id = $1 AND lecture_id = $2`,
    [datasetVersionId, lectureId]
  );
  if (!owns.rows.length) throw new AppError('Dataset version does not belong to this lecture', 404);

  // One case per qa_id; a split answer's pieces become that case's evidence.
  const { rows } = await query<{ qa_id: string; question: string; answer: string; chunk_ids: number[] }>(
    `SELECT c.qa_id,
            min(c.question) AS question,
            string_agg(c.answer, E'\n' ORDER BY c.chunk_index) AS answer,
            array_agg(c.id ORDER BY c.chunk_index) AS chunk_ids
       FROM dataset_version_chunks d
       JOIN lecture_qna_chunks c ON c.id = d.chunk_id
      WHERE d.version_id = $1 AND c.lecture_id = $2
        AND c.qa_id IS NOT NULL
        AND c.question IS NOT NULL
        AND c.question NOT ILIKE 'Source excerpt:%'
      GROUP BY c.qa_id`,
    [datasetVersionId, lectureId]
  );

  let created = 0;
  for (const r of rows) {
    const key = caseKey(lectureId, datasetVersionId, r.qa_id);
    const ids = (r.chunk_ids ?? []).map(Number);
    const ins = await query<{ id: number }>(
      `INSERT INTO golden_benchmark_cases
         (case_key, lecture_id, dataset_version_id, question, expected_answer,
          expected_chunk_ids, source_chunk_ids, category, answerable,
          review_status, generation_method, generation_metadata)
       VALUES ($1,$2,$3,$4,$5,$6::int[],$6::int[],'factual',TRUE,'DRAFT','DETERMINISTIC_CHUNK',
               jsonb_build_object('qaId',$7::text,'pieceCount',cardinality($6::int[])))
       ON CONFLICT (dataset_version_id, case_key) DO NOTHING
       RETURNING id`,
      [key, lectureId, datasetVersionId, String(r.question ?? '').trim(),
       (r.answer ?? '').slice(0, 20000), ids, r.qa_id]
    );
    if (ins.rows.length) created++;
  }

  const skipped = rows.length - created;
  return { datasetVersionId, lectureId, candidateChunks: rows.length, created, skipped };
}

export async function listGoldenCases(datasetVersionId: number, status?: string, limit = 500) {
  posInt(datasetVersionId, 'datasetVersionId');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new AppError('Limit must be 1–2000', 400);
  if (status !== undefined && !VALID_STATUSES.has(status)) throw new AppError('Invalid review status', 400);
  const params: unknown[] = [datasetVersionId];
  let where = 'dataset_version_id = $1';
  if (status) { params.push(status); where += ` AND review_status = $${params.length}`; }
  params.push(limit);
  const { rows } = await query<any>(
    `SELECT * FROM golden_benchmark_cases WHERE ${where} ORDER BY id LIMIT $${params.length}`,
    params
  );
  return rows.map(map);
}

/**
 * Human review decision for one draft case. Records who/when and lets the
 * reviewer correct the question, category, answerability and expected evidence.
 * Approval is gated: an answerable approved case must carry at least one
 * expected chunk; an unsupported case must carry none.
 */
export async function reviewGoldenCase(
  reviewerId: string,
  id: number,
  input: {
    status: string;
    question?: string;
    category?: string;
    answerable?: boolean;
    expectedChunkIds?: number[];
  }
): Promise<GoldenCase> {
  posInt(id, 'id');
  if (!VALID_STATUSES.has(input.status)) throw new AppError('Invalid review status', 400);
  if (input.category !== undefined && !VALID_CATEGORIES.has(input.category)) throw new AppError('Invalid category', 400);

  const cur = await query<any>(`SELECT * FROM golden_benchmark_cases WHERE id = $1`, [id]);
  if (!cur.rows.length) throw new AppError('Golden case not found', 404);
  const existing = map(cur.rows[0]);

  const question = input.question !== undefined ? String(input.question).trim() : existing.question;
  if (question.length < 5) throw new AppError('Question must be at least 5 characters', 400);
  const category = input.category ?? existing.category;
  const answerable = input.answerable ?? existing.answerable;
  let expected = input.expectedChunkIds !== undefined ? input.expectedChunkIds : existing.expectedChunkIds;
  if (!Array.isArray(expected) || expected.some(x => !Number.isSafeInteger(x) || x < 1) || new Set(expected).size !== expected.length) {
    throw new AppError('expectedChunkIds must be unique positive integers', 400);
  }

  // Integrity rules — enforced at the moment of the decision, not silently.
  if (!answerable && expected.length > 0) throw new AppError('An unsupported case must have no expected chunk IDs', 400);
  if (input.status === 'APPROVED' && answerable && expected.length === 0) {
    throw new AppError('Cannot approve an answerable case with no expected chunk IDs — add evidence or mark NEEDS_EVIDENCE', 400);
  }

  const { rows } = await query<any>(
    `UPDATE golden_benchmark_cases
        SET review_status = $2, question = $3, category = $4, answerable = $5,
            expected_chunk_ids = $6::int[],
            reviewed_by = $7, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, input.status, question, category, answerable, expected, reviewerId]
  );
  return map(rows[0]);
}

/**
 * Bulk-approve the DRAFT cases of a dataset version that already satisfy the
 * approval gate (answerable with at least one expected chunk). Convenience for
 * terminal/CI runs; per-case review via reviewGoldenCase stays the norm.
 * reviewerId may be null (recorded as an anonymous faculty approval).
 */
export async function approveAllDrafts(reviewerId: string | null, datasetVersionId: number) {
  posInt(datasetVersionId, 'datasetVersionId');
  const { rows } = await query<{ id: number }>(
    `UPDATE golden_benchmark_cases
        SET review_status = 'APPROVED', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
      WHERE dataset_version_id = $1 AND review_status = 'DRAFT'
        AND answerable = TRUE AND cardinality(expected_chunk_ids) > 0
      RETURNING id`,
    [datasetVersionId, reviewerId]
  );
  return { datasetVersionId, approved: rows.length };
}

/**
 * Build a gold.json object (exact evaluator shape) from the APPROVED cases of a
 * dataset version. This is the committed bridge from the reviewed case bank to
 * the capture adapter / deterministic evaluator — no manual JSON authoring.
 */
export async function exportApprovedGold(datasetVersionId: number) {
  posInt(datasetVersionId, 'datasetVersionId');
  const { rows } = await query<any>(
    `SELECT g.*, COALESCE(u.name, u.email, g.reviewed_by::text, 'faculty') AS reviewer_label
       FROM golden_benchmark_cases g
       LEFT JOIN users u ON u.id = g.reviewed_by
      WHERE g.dataset_version_id = $1 AND g.review_status = 'APPROVED'
      ORDER BY g.id`,
    [datasetVersionId]
  );
  const cases = rows.map(r => {
    const c = map(r);
    return {
      id: c.caseKey,
      lectureId: c.lectureId,
      datasetVersionId: c.datasetVersionId,
      question: c.question,
      category: c.category,
      answerable: c.answerable,
      expectedChunkIds: c.expectedChunkIds,
      // Reference answer, used only by the optional LLM judge; ignored by the
      // deterministic evaluator's retrieval metrics.
      ...(c.expectedAnswer ? { expectedAnswer: c.expectedAnswer } : {}),
      reviewed: true,
      reviewedBy: String(r.reviewer_label).slice(0, 80),
    };
  });
  return { schemaVersion: 1 as const, cases };
}
