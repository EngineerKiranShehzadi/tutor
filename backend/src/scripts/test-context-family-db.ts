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
  console.log('Context-family database expansion checks passed');
}

run().catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
