import { query } from '../config/database';
import { quizSetting } from './quiz-runtime';
export interface QuizSource { id: number; lecture_id: number; answer: string; question: string; topic: string | null; start_time: string | null }
const MAX_SOURCES = 14;
const PACK_CONTENT_CHARS = 6000;
const POLICY = 'topic-spread-v1';
// Rank metadata, then fetch bounded text for 14 IDs, not every lecture body.
// Prefer first occurrences of named topics in evenly spread lecture segments.
export const QUIZ_EVIDENCE_SQL = `
WITH metadata AS (
  SELECT c.id, c.topic,
    row_number() OVER (ORDER BY d.qa_id, d.chunk_index, c.id) AS position,
    row_number() OVER (PARTITION BY lower(btrim(coalesce(c.topic, '')))
      ORDER BY d.qa_id, d.chunk_index, c.id) AS topic_position,
    count(*) OVER () AS total
  FROM dataset_version_chunks d
  JOIN lecture_qna_chunks c ON c.id = d.chunk_id
  JOIN lectures l ON l.id = c.lecture_id
  WHERE l.course_id = $1 AND c.lecture_id = $2 AND d.version_id = $3
), bucketed AS (
  SELECT *, floor((position - 1)::numeric * $4::int / total)::int AS bucket FROM metadata
), selected AS (
  SELECT DISTINCT ON (bucket) id, position FROM bucketed
  ORDER BY bucket, CASE WHEN nullif(btrim(topic), '') IS NOT NULL AND topic_position = 1 THEN 0 ELSE 1 END, position
)
SELECT c.id, c.lecture_id, left(c.chunk_text, 1800) AS answer,
       left(c.question, 180) AS question, left(c.topic, 160) AS topic, c.start_time
FROM selected s JOIN lecture_qna_chunks c ON c.id = s.id
ORDER BY s.position LIMIT $4`;

export function excerpt(text: string, limit: number): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, limit);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const end = ends[ends.length - 1]?.index;
  if (end !== undefined && end >= limit / 2) return head.slice(0, end + 1);
  const space = head.lastIndexOf(' ');
  return head.slice(0, space >= limit / 2 ? space : limit).trim();
}
export function compactSources(rows: QuizSource[]): QuizSource[] {
  const unique = [...new Map(rows.map(s => [s.id, s])).values()].filter(s => s.answer?.trim().length >= 15).slice(0, MAX_SOURCES);
  const budget = Math.floor(PACK_CONTENT_CHARS / Math.max(1, unique.length));
  return unique.map(s => ({ ...s, question: s.question.slice(0, 180), topic: s.topic?.slice(0, 160) ?? null, answer: excerpt(s.answer, Math.min(1800, budget)) }));
}
type Entry = { expires: number; sources: QuizSource[] };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<QuizSource[]>>();
const copy = (sources: QuizSource[]) => sources.map(s => ({ ...s }));
// Lazy source-only cache after explicit quiz request and live eligibility check.
// Restart clears it. No student content, generated questions or model responses.
export async function loadQuizEvidence(courseId: number, lectureId: number, versionId: number):
Promise<{ sources: QuizSource[]; cacheHit: boolean; sharedLoad: boolean }> {
  const key = `${courseId}:${lectureId}:${versionId}:${POLICY}`;
  for (const [name, entry] of cache) if (entry.expires <= Date.now()) cache.delete(name);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return { sources: copy(hit.sources), cacheHit: true, sharedLoad: false }; }
  const shared = pending.get(key);
  if (shared) return { sources: copy(await shared), cacheHit: false, sharedLoad: true };
  const ttl = quizSetting('QUIZ_EVIDENCE_CACHE_TTL_MS', 300_000, 3_600_000);
  const max = quizSetting('QUIZ_EVIDENCE_CACHE_MAX_ENTRIES', 128, 1024);
  const work = (async () => {
    const { rows } = await query<QuizSource>(QUIZ_EVIDENCE_SQL, [courseId, lectureId, versionId, MAX_SOURCES]);
    const sources = compactSources(rows);
    if (sources.some(s => s.lecture_id !== lectureId)) throw new Error('Quiz evidence scope mismatch');
    if (sources.length) {
      while (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: Date.now() + ttl, sources });
    }
    return sources;
  })();
  const registered = pending.size < max;
  if (registered) pending.set(key, work);
  try { return { sources: copy(await work), cacheHit: false, sharedLoad: false }; }
  finally { if (registered && pending.get(key) === work) pending.delete(key); }
}
