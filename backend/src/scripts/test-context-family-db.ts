// Database-backed, read-only context-family regression checks.
// Run only against the disposable local integration database.
import assert from 'assert/strict';
import pool from '../config/database';
import { expandContextCandidates } from '../services/context-family.service';
import type { QnaChunk } from '../types';

async function run(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/askai_fresh_test',
    'Refusing to run against anything except the local askai_fresh_test database');

  const { rows } = await pool.query<{
    version_id: number; lecture_id: number; anchor_id: number; sibling_id: number;
  }>(`
    SELECT f.version_id, c.lecture_id, f.chunk_id AS anchor_id,
           sibling.chunk_id AS sibling_id
    FROM dataset_chunk_families f
    JOIN dataset_version_chunks d
      ON d.version_id=f.version_id AND d.chunk_id=f.chunk_id
    JOIN lecture_qna_chunks c ON c.id=f.chunk_id
    JOIN lectures l ON l.id=c.lecture_id AND l.active_version_id=f.version_id
    JOIN dataset_chunk_families sibling
      ON sibling.version_id=f.version_id
     AND sibling.context_family_id=f.context_family_id
     AND sibling.part_index=f.part_index+1
    JOIN lecture_qna_chunks sc
      ON sc.id=sibling.chunk_id AND sc.lecture_id=c.lecture_id
    WHERE sc.local_embedding IS NOT NULL
    ORDER BY f.version_id DESC
    LIMIT 1`);
  assert.ok(rows.length, 'Test database needs an active multi-part embedded family');
  const { version_id, lecture_id, anchor_id, sibling_id } = rows[0];
  const anchor = await pool.query<QnaChunk>(
    `SELECT id,lecture_id,topic,question,answer,chunk_text,chunk_index,
            start_time,end_time,keywords FROM lecture_qna_chunks WHERE id=$1`,
    [anchor_id]
  );
  assert.equal(anchor.rows.length, 1);
  const expanded = await expandContextCandidates(anchor.rows, lecture_id, 10, version_id);
  assert.ok(expanded.some(c => c.id === sibling_id),
    'Explicit same-version family sibling must be retrieved');
  assert.ok(expanded.every(c => c.lecture_id === lecture_id),
    'Context expansion must never leak another lecture');

  // Pinning a different dataset version must not return a sibling from the first.
  const other = await pool.query<{ id: number }>(
    'SELECT id FROM dataset_versions WHERE lecture_id=$1 AND id<>$2 LIMIT 1',
    [lecture_id, version_id]
  );
  if (other.rows.length) {
    const pinned = await expandContextCandidates(anchor.rows, lecture_id, 10, other.rows[0].id);
    assert.equal(pinned.length, 1, 'Anchor absent from pinned version must not expand');
  }
  // Structural family identity is independent of mutable display labels.
  // Run a real retrieval after temporarily changing only the sibling label.
  // The test database is disposable; restore the original value even on failure.
  const originalLabel = await pool.query<{ question: string }>(
    'SELECT question FROM lecture_qna_chunks WHERE id=$1', [sibling_id]);
  assert.equal(originalLabel.rows.length, 1);
  const renamed = '__context_family_label_independence_test__';
  try {
    await pool.query('UPDATE lecture_qna_chunks SET question=$1 WHERE id=$2',
      [renamed, sibling_id]);
    const afterRename = await expandContextCandidates(anchor.rows, lecture_id, 10, version_id);
    assert.ok(afterRename.some(c => c.id === sibling_id && c.question === renamed),
      'Changing the display question must not break structural family expansion');
  } finally {
    await pool.query('UPDATE lecture_qna_chunks SET question=$1 WHERE id=$2',
      [originalLabel.rows[0].question, sibling_id]);
  }

  // Verify every existing active family (including versions produced by
  // MERGE/REPLACE) has consistent counts and valid same-version parent links.
  const { rows: integrity } = await pool.query<{
    bad_counts: string; bad_links: string; active_versions: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE f.part_count IS DISTINCT FROM sizes.n
        OR f.part_index >= f.part_count)::text AS bad_counts,
      COUNT(*) FILTER (WHERE f.parent_chunk_id IS NOT NULL AND
        (p.chunk_id IS NULL OR p.context_family_id IS DISTINCT FROM f.context_family_id
          OR p.part_index <> 0))::text AS bad_links,
      COUNT(DISTINCT f.version_id)::text AS active_versions
    FROM dataset_chunk_families f
    JOIN dataset_versions v ON v.id=f.version_id AND v.status='ACTIVE'
    JOIN (
      SELECT version_id,context_family_id,COUNT(*)::int AS n
      FROM dataset_chunk_families GROUP BY version_id,context_family_id
    ) sizes ON sizes.version_id=f.version_id
           AND sizes.context_family_id=f.context_family_id
    LEFT JOIN dataset_chunk_families p
      ON p.version_id=f.version_id AND p.chunk_id=f.parent_chunk_id`);
  assert.equal(Number(integrity[0].bad_counts), 0, 'Active family counts must match membership');
  assert.equal(Number(integrity[0].bad_links), 0, 'Active parent links must remain in their family');
  assert.ok(Number(integrity[0].active_versions) > 0, 'No active dataset versions found');

  console.log('Context-family database expansion checks passed');
}

run().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
