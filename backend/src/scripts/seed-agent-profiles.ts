/**
 * Seeds one lecture_agent_profiles row per lecture agent.
 *
 *   node_modules/.bin/ts-node --transpile-only src/scripts/seed-agent-profiles.ts           # dry-run (default, read-only)
 *   node_modules/.bin/ts-node --transpile-only src/scripts/seed-agent-profiles.ts --apply   # actually insert
 *
 * Source of truth for WHICH lectures/agents exist is the frontend constants
 * file (frontend/src/lib/constants.ts, the `LECTURES` array): YouTube video
 * id and agent name are read from it at runtime, never duplicated here.
 * Only the lecture-specific instruction text lives in this file.
 *
 * Safety properties:
 *  - Lectures are matched by youtube_video_id only — never by assuming
 *    database ids line up with lecture numbers.
 *  - Never creates lecture rows; a lecture missing from the database is
 *    skipped and reported.
 *  - Never overwrites: an existing profile (active or not) is skipped, and
 *    the insert itself is ON CONFLICT DO NOTHING so even a race cannot
 *    overwrite one. There is deliberately no update/overwrite mode.
 *  - A video id matching more than one database lecture is ambiguous (the
 *    column has no UNIQUE constraint): skipped and reported, never guessed.
 *  - Re-running is safe; already-seeded lectures are reported as skipped.
 *
 * Global grounding / safety / verification rules are NOT stored here — they
 * stay in the backend prompt. These texts only narrow scope and presentation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { query } from '../config/database';

// Mirrors the CHECK constraints in migration 005 so bad input is rejected
// before any database access, with a clearer message than a constraint error.
export const MAX_INSTRUCTIONS_CHARS = 4000;

export const FRONTEND_CONSTANTS_PATH = path.resolve(__dirname, '../../../frontend/src/lib/constants.ts');

// ── Frontend constants (authoritative lecture → agent mapping) ───────────

export interface FrontendLecture {
  num: number;
  title: string;
  videoId: string;
  agentName: string;
}

// Reads only the LECTURES array literal out of the frontend constants source.
// Strict on purpose: if the file's shape changes and entries stop parsing,
// the count/shape checks below fail loudly instead of seeding a partial set.
export function parseFrontendLectures(source: string): FrontendLecture[] {
  const block = source.match(/export const LECTURES[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error('Could not find the LECTURES array in the frontend constants source.');

  const entry = /\{\s*id:\s*'([^']+)'\s*,\s*num:\s*(\d+)\s*,\s*title:\s*'((?:[^'\\]|\\.)*)'\s*,\s*duration:\s*'[^']*'\s*,\s*videoId:\s*'([^']+)'\s*,\s*watched:\s*\d+\s*,\s*agentName:\s*'([^']+)'\s*\}/g;
  const lectures: FrontendLecture[] = [];
  for (const m of block[1].matchAll(entry)) {
    lectures.push({ num: Number(m[2]), title: m[3], videoId: m[4], agentName: m[5] });
  }

  const declaredEntries = (block[1].match(/\bvideoId\s*:/g) ?? []).length;
  if (lectures.length === 0 || lectures.length !== declaredEntries) {
    throw new Error(`Parsed ${lectures.length} of ${declaredEntries} LECTURES entries from the frontend constants — file shape changed?`);
  }
  return lectures;
}

// ── Lecture-specific instruction texts (keyed by YouTube video id) ───────
// Provenance: course structure (six lectures, Week 1 = Lectures 1-3,
// Week 2 = Lectures 4-6) and the Introductory Lecture's scope come from the
// Introductory Lecture's own dataset (slide 39 and related Q&A). Lectures
// 1, 2, 4, 5, 6 have no dataset yet: their scope is title-based only.

export const INSTRUCTIONS_BY_VIDEO_ID: Record<string, string> = {
  // Nova — Introductory Lecture
  'pCNit2x2gjY':
    'Lecture scope: the Introductory Lecture of the course: the institution presenting the course and its purpose, ' +
    "the instructor's background, how the course is organised and taught, the course goals and learning outcomes, " +
    'the TODO and Your Turn tasks, and the first hands-on use of ChatGPT shown in the lecture. ' +
    'Explain the retrieved information in clear, natural wording. ' +
    'When the retrieved context refers to a specific slide or task, mention it so the student can find it in the lecture.',

  // Sage — Lecture 1
  '0YM7Cfp8dIQ':
    'Lecture scope: Lecture 1 (Week 1), "Introduction to Generative AI and Prompt Engineering": the introductory ideas of ' +
    'generative AI and prompt engineering that this lecture presents. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate.',

  // Clarity — Lecture 2
  '1mi-gFalmSQ':
    'Lecture scope: Lecture 2 (Week 1), "Fundamentals of Crafting Simple, Fast, and Accurate Prompts": the guidance this ' +
    'lecture gives for writing prompts that are simple, fast and accurate. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate. ' +
    'When the retrieved context includes example prompts, use them to illustrate your explanation.',

  // Craft — Lecture 3
  'CIkEryaQ7ok':
    'Lecture scope: Lecture 3 (Week 1), "Prompt Formulation Process": the systematic, step-by-step process for ' +
    'constructing an effective prompt. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate. ' +
    'When the retrieved context describes steps of the process, present them in the order the lecture gives them.',

  // Prism — Lecture 4
  'IQNZNTdZhZg':
    'Lecture scope: Lecture 4 (Week 2), "Prompt Engineering Techniques for Text Generation": the prompting techniques this ' +
    'lecture presents for generating text. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate. ' +
    'Use each technique\'s name as the lecture gives it, together with the lecture\'s own description and examples.',

  // Oracle — Lecture 5
  'Hv8judoCF0g':
    'Lecture scope: Lecture 5 (Week 2), "Prompt Engineering for Question Answering (QA)": how this lecture applies prompt ' +
    'engineering to question-answering tasks. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate. ' +
    'Use the lecture\'s own examples wherever the retrieved context provides them.',

  // Virtue — Lecture 6
  'jGsf0ppO3Js':
    'Lecture scope: Lecture 6 (Week 2), "Evaluation, Ethics, and Future of Prompt Engineering": how this lecture treats ' +
    'evaluation, ethics and the future of prompt engineering. ' +
    'Explain the retrieved information in clear, natural wording, keeping the facts and the lecture\'s terminology accurate. ' +
    'Present these as the lecture\'s positions rather than as your own opinions or predictions.',
};

// ── Seed configuration (frontend mapping + instruction text) ─────────────

export interface SeedConfig {
  videoId: string;
  agentName: string;
  lectureNum: number;
  lectureTitle: string;
  instructions: string;
}

// Validates everything that can be checked without touching the database.
// Throws (so the caller aborts before any read or write) on any problem.
export function buildSeedConfigs(
  frontendLectures: FrontendLecture[],
  instructionsByVideoId: Record<string, string> = INSTRUCTIONS_BY_VIDEO_ID
): SeedConfig[] {
  const problems: string[] = [];

  const videoIds = frontendLectures.map(l => l.videoId);
  const agentNames = frontendLectures.map(l => l.agentName);
  if (new Set(videoIds).size !== videoIds.length) problems.push('duplicate videoId in frontend constants');
  if (new Set(agentNames).size !== agentNames.length) problems.push('duplicate agentName in frontend constants');

  for (const l of frontendLectures) {
    const text = instructionsByVideoId[l.videoId];
    if (text === undefined) { problems.push(`no instructions defined for ${l.agentName} (${l.videoId})`); continue; }
    if (!/\S/.test(text)) problems.push(`instructions for ${l.agentName} are blank`);
    if (text.length > MAX_INSTRUCTIONS_CHARS) problems.push(`instructions for ${l.agentName} are ${text.length} chars (max ${MAX_INSTRUCTIONS_CHARS})`);
    if (!/\S/.test(l.agentName)) problems.push(`blank agentName for ${l.videoId}`);
  }
  for (const id of Object.keys(instructionsByVideoId)) {
    if (!videoIds.includes(id)) problems.push(`instructions defined for ${id}, which is not in the frontend LECTURES`);
  }

  if (problems.length > 0) throw new Error(`Seed configuration invalid:\n  - ${problems.join('\n  - ')}`);

  return frontendLectures.map(l => ({
    videoId: l.videoId,
    agentName: l.agentName,
    lectureNum: l.num,
    lectureTitle: l.title,
    instructions: instructionsByVideoId[l.videoId],
  }));
}

// ── Planning (pure) ──────────────────────────────────────────────────────

export interface DbLectureRow { id: number; title: string; youtube_video_id: string | null; status: string }
export interface ExistingProfileRow { lecture_id: number; agent_name: string; is_active: boolean }

export type SeedAction =
  | 'INSERT'
  | 'SKIP_EXISTING_PROFILE'
  | 'SKIP_LECTURE_NOT_IN_DB'
  | 'SKIP_AMBIGUOUS_LECTURE';

export interface SeedPlanItem {
  config: SeedConfig;
  action: SeedAction;
  lectureId?: number;       // set when exactly one DB lecture matched
  detail: string;
}

export function planSeed(
  configs: SeedConfig[],
  dbLectures: DbLectureRow[],
  existingProfiles: ExistingProfileRow[]
): SeedPlanItem[] {
  return configs.map((config): SeedPlanItem => {
    const matches = dbLectures.filter(l => l.youtube_video_id === config.videoId);

    if (matches.length === 0) {
      return { config, action: 'SKIP_LECTURE_NOT_IN_DB', detail: 'no lecture with this youtube_video_id in the database' };
    }
    if (matches.length > 1) {
      return {
        config, action: 'SKIP_AMBIGUOUS_LECTURE',
        detail: `${matches.length} database lectures share this youtube_video_id (ids ${matches.map(m => m.id).join(', ')}) — not guessing`,
      };
    }

    const lecture = matches[0];
    const existing = existingProfiles.find(p => p.lecture_id === lecture.id);
    if (existing) {
      return {
        config, action: 'SKIP_EXISTING_PROFILE', lectureId: lecture.id,
        detail: `lecture #${lecture.id} already has a profile (agent_name="${existing.agent_name}", is_active=${existing.is_active}) — left untouched`,
      };
    }
    return { config, action: 'INSERT', lectureId: lecture.id, detail: `lecture #${lecture.id} (${lecture.status}) has no profile yet` };
  });
}

// ── Execution ────────────────────────────────────────────────────────────

export type SeedQueryFn = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

export interface SeedResult {
  apply: boolean;
  plan: SeedPlanItem[];
  inserted: number;
}

const defaultQuery: SeedQueryFn = (text, params) => query<Record<string, unknown>>(text, params);

export async function runSeed(
  configs: SeedConfig[],
  opts: { apply: boolean; query?: SeedQueryFn }
): Promise<SeedResult> {
  const run = opts.query ?? defaultQuery;

  const { rows: lectureRows } = await run(
    `SELECT id, title, youtube_video_id, status FROM lectures WHERE youtube_video_id = ANY($1)`,
    [configs.map(c => c.videoId)]
  );
  const dbLectures = lectureRows as unknown as DbLectureRow[];

  let existing: ExistingProfileRow[] = [];
  if (dbLectures.length > 0) {
    const { rows } = await run(
      `SELECT lecture_id, agent_name, is_active FROM lecture_agent_profiles WHERE lecture_id = ANY($1)`,
      [dbLectures.map(l => l.id)]
    );
    existing = rows as unknown as ExistingProfileRow[];
  }

  const plan = planSeed(configs, dbLectures, existing);
  let inserted = 0;

  if (opts.apply) {
    for (const item of plan) {
      if (item.action !== 'INSERT') continue;
      // ON CONFLICT DO NOTHING: a profile created between planning and now
      // is left alone instead of being overwritten or raising an error.
      const res = await run(
        `INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions)
         VALUES ($1, $2, $3)
         ON CONFLICT (lecture_id) DO NOTHING`,
        [item.lectureId, item.config.agentName, item.config.instructions]
      );
      if ((res.rowCount ?? 0) === 1) {
        inserted++;
      } else {
        item.action = 'SKIP_EXISTING_PROFILE';
        item.detail = `lecture #${item.lectureId} gained a profile during this run — left untouched`;
      }
    }
  }

  return { apply: opts.apply, plan, inserted };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const LABEL: Record<SeedAction, string> = {
  INSERT: 'INSERT ',
  SKIP_EXISTING_PROFILE: 'SKIP   ',
  SKIP_LECTURE_NOT_IN_DB: 'SKIP   ',
  SKIP_AMBIGUOUS_LECTURE: 'SKIP   ',
};

function report(result: SeedResult): void {
  console.log(`\nMode: ${result.apply ? 'APPLY (writes enabled)' : 'DRY-RUN (no writes) — pass --apply to insert'}\n`);
  for (const item of result.plan) {
    const verb = result.apply && item.action === 'INSERT' ? 'INSERTED' : LABEL[item.action].trim();
    console.log(`  ${verb.padEnd(8)} ${item.config.agentName.padEnd(8)} ${item.config.videoId}  ${item.config.lectureTitle}`);
    console.log(`           -> ${item.detail} [${item.config.instructions.length} chars]`);
  }
  const count = (a: SeedAction) => result.plan.filter(p => p.action === a).length;
  console.log(
    `\nSummary: ${result.apply ? `inserted=${result.inserted}` : `would insert=${count('INSERT')}`}, ` +
    `skipped existing=${count('SKIP_EXISTING_PROFILE')}, ` +
    `skipped not in DB=${count('SKIP_LECTURE_NOT_IN_DB')}, ` +
    `skipped ambiguous=${count('SKIP_AMBIGUOUS_LECTURE')}`
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const unknown = process.argv.slice(2).filter(a => a !== '--apply');
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: seed-agent-profiles.ts [--apply]`);
    process.exit(1);
  }

  const source = fs.readFileSync(FRONTEND_CONSTANTS_PATH, 'utf8');
  const configs = buildSeedConfigs(parseFrontendLectures(source));

  const result = await runSeed(configs, { apply });
  report(result);

  const pool = (await import('../config/database')).default;
  await pool.end();
  process.exit(result.plan.some(p => p.action === 'SKIP_AMBIGUOUS_LECTURE') ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Seed failed:', (err as Error).message);
    process.exit(1);
  });
}
