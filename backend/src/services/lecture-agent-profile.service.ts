import { query } from '../config/database';
import { LectureAgentProfile } from '../types';
import { logger } from '../utils/logger';

// Outcome of looking up the agent profile for one lecture. Every non-error
// outcome is its own status so a caller can never mistake "no profile" or
// "profile disabled" for a usable agent — and a database failure is never
// represented here at all: it throws (see getAgentProfileByLectureId), so it
// can't be silently confused with NOT_FOUND.
//
// INACTIVE deliberately carries only identifying fields, not the profile's
// instructions, so a disabled agent's configuration can't be used by
// accident.
export type AgentProfileLookup =
  | { status: 'FOUND'; profile: LectureAgentProfile }
  | { status: 'INACTIVE'; lectureId: number; agentName: string }
  | { status: 'NOT_FOUND'; lectureId: number };

// Test-only seam, same idea as the deps parameters elsewhere in this
// codebase (see askLectureAgent, lookupAnswerMemory): production always
// falls through to the shared pool in config/database.ts.
export type AgentProfileQueryFn = (
  text: string,
  params?: unknown[]
) => Promise<{ rows: LectureAgentProfile[] }>;

export interface AgentProfileDeps {
  query?: AgentProfileQueryFn;
}

const PROFILE_BY_LECTURE_SQL = `
  SELECT lecture_id, agent_name, instructions, is_active, created_at, updated_at
  FROM lecture_agent_profiles
  WHERE lecture_id = $1
`;

const defaultQuery: AgentProfileQueryFn = (text, params) => query<LectureAgentProfile>(text, params);

// Deterministic agent selection: the lecture the student is already chatting
// in is the key, one profile per lecture. A single indexed primary-key
// lookup — no LLM call, no routing step.
//
// Resolves with FOUND / INACTIVE / NOT_FOUND. A database failure is logged
// with context and rethrown unchanged (original error object, including its
// driver error code), never converted into a "missing profile" result.
export const getAgentProfileByLectureId = async (
  lectureId: number,
  deps: AgentProfileDeps = {}
): Promise<AgentProfileLookup> => {
  // `WHERE lecture_id = NULL` matches nothing, so an undefined/NaN id would
  // otherwise come back as NOT_FOUND and hide a caller bug. Fail loudly.
  if (!Number.isInteger(lectureId)) {
    throw new TypeError(`[AGENT-PROFILE] lectureId must be an integer, received: ${String(lectureId)}`);
  }

  const run = deps.query ?? defaultQuery;

  let rows: LectureAgentProfile[];
  try {
    ({ rows } = await run(PROFILE_BY_LECTURE_SQL, [lectureId]));
  } catch (err) {
    logger.error(`[AGENT-PROFILE] ❌ Profile lookup failed for lecture #${lectureId}: ${(err as Error).message}`);
    throw err;
  }

  const profile = rows[0];
  if (!profile) return { status: 'NOT_FOUND', lectureId };
  if (!profile.is_active) return { status: 'INACTIVE', lectureId, agentName: profile.agent_name };
  return { status: 'FOUND', profile };
};
