/**
 * Prepare a human-review queue from an existing, pinned lecture dataset.
 * Read-only, no embedding or LLM calls. Output is NOT verified golden truth.
 *
 * Usage: npm run eval:prepare-golden -- <lectureId> [maxQuestions=30]
 */
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import pool from '../config/database';

async function main() {
  const lectureId = Number(process.argv[2]);
  const maxQuestions = process.argv[3] === undefined ? 30 : Number(process.argv[3]);
  if (!Number.isSafeInteger(lectureId) || lectureId < 1 ||
      !Number.isSafeInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 100) {
    throw new Error('Usage: npm run eval:prepare-golden -- <lectureId> [maxQuestions: 1..100]');
  }
  // Enforce read-only at the PostgreSQL transaction level, not just by convention.
  const client = await pool.connect();
  let output: Record<string, unknown>;
  let groupsCount = 0;
  let selectedCount = 0;
  try {
    await client.query('BEGIN READ ONLY');
  const lecture = await client.query<{ title: string; active_version_id: number | null }>(
    'SELECT title,active_version_id FROM lectures WHERE id=$1', [lectureId]);
  if (!lecture.rows.length || !lecture.rows[0].active_version_id)
    throw new Error('Lecture not found or has no active dataset');
  const versionId = lecture.rows[0].active_version_id;
  const { rows } = await client.query<{
    qa_id: string; question: string; chunk_id: number; chunk_index: number;
    chunk_text: string; source_locator: string | null;
  }>(`
    SELECT d.qa_id,c.question,c.id AS chunk_id,d.chunk_index,c.chunk_text,
           c.start_time AS source_locator
    FROM dataset_version_chunks d
    JOIN lecture_qna_chunks c ON c.id=d.chunk_id
    WHERE d.version_id=$1 AND c.lecture_id=$2 AND c.local_embedding IS NOT NULL
    ORDER BY d.qa_id,d.chunk_index,c.id`, [versionId, lectureId]);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.qa_id) || [];
    group.push(row);
    groups.set(row.qa_id, group);
  }
  const candidates = [...groups.values()]
    .filter(g => g[0].question.trim().length >= 5)
    .sort((a,b) => a[0].qa_id.localeCompare(b[0].qa_id))
    .slice(0,maxQuestions);
  if (!candidates.length) throw new Error('No embedded questions found in active dataset');

  output = {
    schemaVersion: 1,
    status: 'REVIEW_REQUIRED',
    lectureId,
    lectureTitle: lecture.rows[0].title,
    datasetVersionId: versionId,
    note: 'Suggested chunk IDs are NOT verified labels. Review each question, answerability, category and evidence before building golden-evaluator input.',
    cases: candidates.map((group,i) => ({
      id: 'candidate-'+String(i+1).padStart(3,'0'),
      lectureId,
      datasetVersionId: versionId,
      question: group[0].question,
      suggestedChunkIds: group.map(r=>r.chunk_id),
      evidencePreview: group.map(r=>({
        chunkId:r.chunk_id,partIndex:r.chunk_index,
        sourceLocator:r.source_locator,
        excerpt:r.chunk_text.slice(0,600)
      })),
      reviewRequired: true
    }))
  };
  groupsCount = groups.size;
  selectedCount = candidates.length;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const filename = resolve(process.cwd(), 'rag-review-lecture-'+lectureId+'-version-'+String(output.datasetVersionId)+'.json');
  writeFileSync(filename, JSON.stringify(output,null,2)+'\n', {flag:'wx',mode:0o600});
  console.log('Prepared '+selectedCount+' unreviewed questions from '+groupsCount+' source groups.');
  console.log('Review file: '+filename);
  console.log('No dataset rows, vectors or golden labels were modified.');
}
main().catch(e=>{console.error('[RAG GOLDEN PREP] '+(e as Error).message);process.exitCode=1;})
  .finally(()=>pool.end());
