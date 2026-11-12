import { createHash } from 'crypto';
import { query } from '../config/database';
import { quizSetting } from './quiz-runtime';
import { compactSources, type QuizSource } from './quiz-evidence.service';
const POOL_SIZE = 56;
const PACK_SIZE = 14;
const POLICY = 'rotating-topic-pool-v1';
export interface EvidenceScope { lectureId: number; versionId: number }
export interface EvidencePool extends EvidenceScope { sources: QuizSource[]; cacheHit: boolean; sharedLoad: boolean }
type SourceRow = QuizSource & { version_id: number };
// One read for all cache misses. Pair each lecture with its own pinned version;
// never use independent ANY filters that could mix versions between lectures.
export const QUIZ_EVIDENCE_POOL_SQL = `
WITH requested AS (
  SELECT * FROM unnest($2::int[], $3::int[]) AS r(lecture_id, version_id)
), metadata AS (
  SELECT c.id, c.lecture_id, r.version_id, c.topic,
    row_number() OVER (PARTITION BY c.lecture_id ORDER BY d.qa_id, d.chunk_index, c.id) AS position,
    row_number() OVER (PARTITION BY c.lecture_id, lower(btrim(coalesce(c.topic, '')))
      ORDER BY d.qa_id, d.chunk_index, c.id) AS topic_position,
    count(*) OVER (PARTITION BY c.lecture_id) AS total
  FROM requested r JOIN dataset_version_chunks d ON d.version_id = r.version_id
  JOIN lecture_qna_chunks c ON c.id = d.chunk_id AND c.lecture_id = r.lecture_id
  JOIN lectures l ON l.id = c.lecture_id AND l.course_id = $1
), bucketed AS (
  SELECT *, floor((position - 1)::numeric * $4::int / total)::int AS bucket FROM metadata
), selected AS (
  SELECT DISTINCT ON (lecture_id, bucket) id, lecture_id, version_id, position FROM bucketed
  ORDER BY lecture_id, bucket,
    CASE WHEN nullif(btrim(topic), '') IS NOT NULL AND topic_position = 1 THEN 0 ELSE 1 END, position
)
SELECT c.id, c.lecture_id, s.version_id, left(c.chunk_text, 1800) AS answer,
       left(c.question, 180) AS question, left(c.topic, 160) AS topic, c.start_time
FROM selected s JOIN lecture_qna_chunks c ON c.id = s.id
ORDER BY s.lecture_id, s.position`;
type Entry = { expires: number; sources: QuizSource[] };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<QuizSource[]>>();
const copy = (sources: QuizSource[]) => sources.map(s => ({ ...s }));
const keyFor = (course: number, s: EvidenceScope) => `${course}:${s.lectureId}:${s.versionId}:${POLICY}`;

export async function loadQuizEvidencePools(courseId: number, scopes: EvidenceScope[]): Promise<EvidencePool[]> {
  if (!Number.isSafeInteger(courseId) || courseId <= 0 || scopes.length < 1 || scopes.length > 50 ||
      scopes.some(s => !Number.isSafeInteger(s.lectureId) || s.lectureId <= 0 || !Number.isSafeInteger(s.versionId) || s.versionId <= 0) ||
      new Set(scopes.map(s => s.lectureId)).size !== scopes.length) throw new Error('Invalid quiz evidence scopes');
  for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key);
  const ttl = quizSetting('QUIZ_EVIDENCE_CACHE_TTL_MS', 300_000, 3_600_000);
  const max = quizSetting('QUIZ_EVIDENCE_CACHE_MAX_ENTRIES', 128, 1024);
  const results = new Map<string, Promise<EvidencePool>>();
  const missing: EvidenceScope[] = [];
  for (const s of scopes) {
    const key = keyFor(courseId, s), hit = cache.get(key), shared = pending.get(key);
    if (hit) {
      cache.delete(key); cache.set(key, hit);
      results.set(key, Promise.resolve({ ...s, sources: copy(hit.sources), cacheHit: true, sharedLoad: false }));
    } else if (shared) results.set(key, shared.then(sources => ({ ...s, sources: copy(sources), cacheHit: false, sharedLoad: true })));
    else missing.push(s);
  }
  if (missing.length) {
    const work = query<SourceRow>(QUIZ_EVIDENCE_POOL_SQL,
      [courseId, missing.map(s => s.lectureId), missing.map(s => s.versionId), POOL_SIZE])
      .then(({ rows }) => {
        const grouped = new Map(missing.map(s => [s.lectureId, [] as QuizSource[]]));
        const versions = new Map(missing.map(s => [s.lectureId, s.versionId]));
        for (const row of rows) {
          if (versions.get(row.lecture_id) !== row.version_id) throw new Error('Quiz evidence scope mismatch');
          const { version_id: _version, ...source } = row;
          const group = grouped.get(source.lecture_id)!;
          if (source.answer?.trim().length >= 15 && !group.some(s => s.id === source.id) && group.length < POOL_SIZE) group.push(source);
        }
        return grouped;
      });
    for (const s of missing) {
      const key = keyFor(courseId, s);
      const job = work.then(groups => {
        const sources = groups.get(s.lectureId)!;
        if (sources.length) {
          while (cache.size >= max) cache.delete(cache.keys().next().value!);
          cache.set(key, { sources: copy(sources), expires: Date.now() + ttl });
        }
        return sources;
      });
      const tracked = pending.size < max;
      if (tracked) pending.set(key, job);
      results.set(key, job.then(sources => ({ ...s, sources: copy(sources), cacheHit: false, sharedLoad: false }))
        .finally(() => { if (tracked && pending.get(key) === job) pending.delete(key); }));
    }
  }
  return Promise.all(scopes.map(s => results.get(keyFor(courseId, s))!));
}

// Cache only evidence. Each explicit attempt selects a fresh bounded view of
// the pool; no quiz is generated on page load or in anticipation of a retake.
export function selectQuizEvidence(sources: QuizSource[], seed: string, usedSourceIds: ReadonlySet<number> = new Set()): QuizSource[] {
  const unique = [...new Map(sources.map(s => [s.id, s])).values()];
  const unused = unique.filter(s => !usedSourceIds.has(s.id));
  // Prefer unused chunks, not a hard ban: a short lecture can contain several
  // distinct facts in one chunk. Question novelty is independently enforced.
  const candidates = unused.length >= PACK_SIZE ? unused : [...unused, ...unique.filter(s => usedSourceIds.has(s.id))];
  const count = Math.min(PACK_SIZE, candidates.length), chosen: QuizSource[] = [];
  const topics = new Set<string>();
  for (let i = 0; i < count; i++) {
    const bucket = candidates.slice(Math.floor(i * candidates.length / count), Math.floor((i + 1) * candidates.length / count));
    bucket.sort((a, b) => {
      const rank = (s: QuizSource) => (usedSourceIds.has(s.id) ? 2 : 0) + (s.topic?.trim() && topics.has(s.topic.trim().toLowerCase()) ? 1 : 0);
      return rank(a) - rank(b) || createHash('sha256').update(`${seed}:${a.id}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}:${b.id}`).digest('hex'));
    });
    chosen.push(bucket[0]);
    if (bucket[0].topic?.trim()) topics.add(bucket[0].topic!.trim().toLowerCase());
  }
  return compactSources(chosen);
}
