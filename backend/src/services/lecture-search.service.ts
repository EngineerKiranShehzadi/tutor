// ── Step 2: Lecture search ────────────────────────────────────────────────────
// Receives a structured filter (from Step 1) and returns the most relevant
// lecture content as text blocks for the LLM (Step 3) to answer from.
//
// Data source: LECTURE_KNOWLEDGE in lecture-knowledge.ts
// To swap for a DB/transcript source later: replace the scoring logic here —
// the LectureQueryFilter and LectureSearchResult interfaces stay unchanged.

import { LECTURE_KNOWLEDGE } from './lecture-knowledge';

export interface LectureQueryFilter {
  topic?:      string;
  keywords:    string[];
  lectureNum?: number | null;
  intent:      'explain' | 'example' | 'quiz' | 'summarize' | 'other';
}

export interface LectureSearchResult {
  id:              string;
  num:             number;
  title:           string;
  relevantContent: string; // human-readable text block handed to the LLM
  score:           number;
}

export function searchLectures(
  filter: LectureQueryFilter,
  currentLectureId?: string
): LectureSearchResult[] {
  // If a specific lecture number was identified, return it directly
  if (filter.lectureNum !== null && filter.lectureNum !== undefined) {
    const hit = LECTURE_KNOWLEDGE.find((l) => l.num === filter.lectureNum);
    if (hit) return [buildResult(hit, 100)];
  }

  const queryTerms = buildQueryTerms(filter);
  if (queryTerms.length === 0) return [];

  const scored = LECTURE_KNOWLEDGE.map((lecture) => {
    let score = 0;

    for (const term of queryTerms) {
      // Concept key match (strongest signal — exact concept name)
      if (Object.keys(lecture.concepts).some((k) => k.toLowerCase().includes(term))) score += 12;
      // Topic match
      if (lecture.topics.some((t) => t.includes(term) || term.includes(t.split(' ')[0]))) score += 10;
      // Key-term match
      if (lecture.keyTerms.some((k) => k.includes(term) || term.includes(k))) score += 8;
      // Concept value (description text) match
      if (Object.values(lecture.concepts).some((v) => v.toLowerCase().includes(term))) score += 5;
      // Title match
      if (lecture.title.toLowerCase().includes(term)) score += 6;
    }

    // Small boost for the lecture currently being watched
    if (currentLectureId && lecture.id === currentLectureId) score += 4;

    return { lecture, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => buildResult(s.lecture, s.score));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQueryTerms(filter: LectureQueryFilter): string[] {
  const raw = [
    ...(filter.keywords ?? []),
    ...(filter.topic?.toLowerCase().split(/\s+/) ?? []),
  ];
  return [...new Set(raw.map((t) => t.toLowerCase().trim()).filter((t) => t.length > 2))];
}

function buildResult(
  lecture: (typeof LECTURE_KNOWLEDGE)[number],
  score: number
): LectureSearchResult {
  const conceptLines = Object.entries(lecture.concepts)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const relevantContent =
    `Lecture ${lecture.num}: ${lecture.title} (${lecture.duration})\n` +
    `Topics covered: ${lecture.topics.join(', ')}\n` +
    `Key Concepts:\n${conceptLines}`;

  return { id: lecture.id, num: lecture.num, title: lecture.title, relevantContent, score };
}

export function getLectureById(id: string) {
  return LECTURE_KNOWLEDGE.find((l) => l.id === id);
}

// Converts search results into a clean text block for the LLM prompt
export function serializeResults(results: LectureSearchResult[]): string {
  if (results.length === 0) return 'No matching lecture content found for this query.';
  return results
    .map((r, i) => `--- Source ${i + 1} ---\n${r.relevantContent}`)
    .join('\n\n');
}
