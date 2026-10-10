/**
 * Validates seed-agent-profiles.ts (mapping, duplicate handling, missing
 * lectures, dry-run vs apply).
 *
 * The database is an in-memory fake injected through runSeed's `query`
 * option: nothing here connects to PostgreSQL, and the fake throws on any
 * SQL shape the seed script is not supposed to issue (e.g. writes to
 * `lectures`, UPDATE/DELETE) so such a regression fails the test.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-seed-agent-profiles.ts
 */
import * as fs from 'fs';
import {
  FRONTEND_CONSTANTS_PATH,
  INSTRUCTIONS_BY_VIDEO_ID,
  MAX_INSTRUCTIONS_CHARS,
  parseFrontendLectures,
  buildSeedConfigs,
  runSeed,
  DbLectureRow,
  ExistingProfileRow,
  SeedQueryFn,
  SeedConfig,
} from './seed-agent-profiles';

interface CaseResult { pass: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

const EXPECTED_AGENTS: Record<string, string> = {
  'pCNit2x2gjY': 'Nova',
  '0YM7Cfp8dIQ': 'Sage',
  '1mi-gFalmSQ': 'Clarity',
  'CIkEryaQ7ok': 'Craft',
  'IQNZNTdZhZg': 'Prism',
  'Hv8judoCF0g': 'Oracle',
  'jGsf0ppO3Js': 'Virtue',
};

const frontendSource = fs.readFileSync(FRONTEND_CONSTANTS_PATH, 'utf8');
const realConfigs = (): SeedConfig[] => buildSeedConfigs(parseFrontendLectures(frontendSource));

const lec = (id: number, videoId: string | null, status = 'READY'): DbLectureRow =>
  ({ id, title: `db lecture ${id}`, youtube_video_id: videoId, status });

// In-memory fake database; records every statement it receives.
function fakeDb(lectures: DbLectureRow[], profiles: ExistingProfileRow[] = []) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const fn: SeedQueryFn = async (text, params) => {
    calls.push({ text, params });
    if (/^\s*SELECT[\s\S]+FROM\s+lectures\b/i.test(text)) {
      const ids = params![0] as string[];
      const rows = lectures.filter(l => l.youtube_video_id !== null && ids.includes(l.youtube_video_id));
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/^\s*SELECT[\s\S]+FROM\s+lecture_agent_profiles\b/i.test(text)) {
      const ids = params![0] as number[];
      const rows = profiles.filter(p => ids.includes(p.lecture_id));
      return { rows: rows as unknown as Record<string, unknown>[], rowCount: rows.length };
    }
    if (/^\s*INSERT\s+INTO\s+lecture_agent_profiles\b/i.test(text)) {
      const [lectureId, agentName] = params as [number, string, string];
      if (profiles.some(p => p.lecture_id === lectureId)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      profiles.push({ lecture_id: lectureId, agent_name: agentName, is_active: true });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL issued by seed script: ${text.trim().slice(0, 80)}`);
  };
  const writes = () => calls.filter(c => /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)/i.test(c.text));
  return { fn, calls, profiles, writes };
}

cases.push({
  label: '1. Frontend constants are the source: exactly 7 lectures with the approved agent names and video ids',
  run: async () => {
    const parsed = parseFrontendLectures(frontendSource);
    const got = Object.fromEntries(parsed.map(l => [l.videoId, l.agentName]));
    const pass = parsed.length === 7 && JSON.stringify(got) === JSON.stringify(EXPECTED_AGENTS);
    return { pass, detail: parsed.map(l => `${l.agentName}:${l.videoId}`).join(', ') };
  },
});

cases.push({
  label: '2. Every instruction is non-blank, within the 4000-char DB limit, and maps to exactly one frontend lecture',
  run: async () => {
    const configs = realConfigs(); // throws if anything is missing/blank/oversize
    const lengths = configs.map(c => `${c.agentName}=${c.instructions.length}`);
    const ok = configs.length === 7
      && configs.every(c => /\S/.test(c.instructions) && c.instructions.length <= MAX_INSTRUCTIONS_CHARS)
      && Object.keys(INSTRUCTIONS_BY_VIDEO_ID).length === 7;
    return { pass: ok, detail: lengths.join(', ') };
  },
});

cases.push({
  label: '3. Instructions contain no cross-lecture references (other lectures\' titles or agent names)',
  run: async () => {
    const configs = realConfigs();
    const offenders: string[] = [];
    for (const c of configs) {
      for (const other of configs) {
        if (other.videoId === c.videoId) continue;
        // Whole-word match: "Craft" must not match "Crafting" in Lecture 2's title.
        if (new RegExp(`\\b${other.agentName}\\b`).test(c.instructions)) {
          offenders.push(`${c.agentName} mentions agent ${other.agentName}`);
        }
      }
      // Any "Lecture N" mention must be the agent's own lecture.
      for (const m of c.instructions.matchAll(/\bLecture\s+(\d+)\b/g)) {
        if (Number(m[1]) !== c.lectureNum) offenders.push(`${c.agentName} mentions Lecture ${m[1]}`);
      }
    }
    return { pass: offenders.length === 0, detail: offenders.join('; ') || 'none' };
  },
});

cases.push({
  label: '4. Invalid configuration aborts before any database access (blank / oversize / missing / unknown id)',
  run: async () => {
    const lectures = parseFrontendLectures(frontendSource);
    const base = { ...INSTRUCTIONS_BY_VIDEO_ID };
    const variants: Record<string, Record<string, string>> = {
      blank: { ...base, 'pCNit2x2gjY': '   \n ' },
      oversize: { ...base, '0YM7Cfp8dIQ': 'x'.repeat(MAX_INSTRUCTIONS_CHARS + 1) },
      missing: Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'jGsf0ppO3Js')),
      unknown: { ...base, 'NOT-A-REAL-ID': 'text' },
    };
    const results: string[] = [];
    for (const [name, map] of Object.entries(variants)) {
      let threw = false;
      try { buildSeedConfigs(lectures, map); } catch { threw = true; }
      results.push(`${name}:${threw ? 'rejected' : 'ACCEPTED(BAD)'}`);
    }
    const boundary = { ...base, 'pCNit2x2gjY': 'x'.repeat(MAX_INSTRUCTIONS_CHARS) };
    let boundaryOk = true;
    try { buildSeedConfigs(lectures, boundary); } catch { boundaryOk = false; }
    results.push(`4000-char boundary:${boundaryOk ? 'accepted' : 'REJECTED(BAD)'}`);
    return { pass: results.every(r => !/BAD/.test(r)), detail: results.join(', ') };
  },
});

cases.push({
  label: '5. Matches by youtube_video_id, not by id/number: shuffled DB ids still bind each agent to the right lecture',
  run: async () => {
    // DB ids deliberately unrelated to lecture numbers (and reversed).
    const db = fakeDb([
      lec(70, 'jGsf0ppO3Js'), lec(60, 'Hv8judoCF0g'), lec(50, 'IQNZNTdZhZg'),
      lec(40, 'CIkEryaQ7ok'), lec(30, '1mi-gFalmSQ'), lec(20, '0YM7Cfp8dIQ'), lec(10, 'pCNit2x2gjY'),
    ]);
    await runSeed(realConfigs(), { apply: true, query: db.fn });
    const byLecture = Object.fromEntries(db.profiles.map(p => [p.lecture_id, p.agent_name]));
    const expected = { 10: 'Nova', 20: 'Sage', 30: 'Clarity', 40: 'Craft', 50: 'Prism', 60: 'Oracle', 70: 'Virtue' };
    return { pass: JSON.stringify(byLecture) === JSON.stringify(expected), detail: JSON.stringify(byLecture) };
  },
});

cases.push({
  label: '6. Current database (lectures #2 and #4 only): inserts Nova->4 and Clarity->2, skips the other five as not in DB',
  run: async () => {
    const db = fakeDb([lec(2, '1mi-gFalmSQ', 'NO_DATASET'), lec(4, 'pCNit2x2gjY', 'READY')]);
    const result = await runSeed(realConfigs(), { apply: false, query: db.fn });
    const inserts = result.plan.filter(p => p.action === 'INSERT').map(p => `${p.config.agentName}->${p.lectureId}`).sort();
    const missing = result.plan.filter(p => p.action === 'SKIP_LECTURE_NOT_IN_DB').map(p => p.config.agentName).sort();
    const pass = JSON.stringify(inserts) === JSON.stringify(['Clarity->2', 'Nova->4'])
      && JSON.stringify(missing) === JSON.stringify(['Craft', 'Oracle', 'Prism', 'Sage', 'Virtue']);
    return { pass, detail: `insert=[${inserts}] skipped-not-in-db=[${missing}]` };
  },
});

cases.push({
  label: '7. Missing lectures are skipped and never created (no write to `lectures`, nothing inserted)',
  run: async () => {
    const db = fakeDb([]); // empty lectures table
    const result = await runSeed(realConfigs(), { apply: true, query: db.fn });
    const pass = result.inserted === 0 && db.writes().length === 0
      && result.plan.every(p => p.action === 'SKIP_LECTURE_NOT_IN_DB');
    return { pass, detail: `inserted=${result.inserted}, writes=${db.writes().length}` };
  },
});

cases.push({
  label: '8. Existing profiles (active or inactive) are skipped and never overwritten',
  run: async () => {
    const db = fakeDb(
      [lec(4, 'pCNit2x2gjY'), lec(2, '1mi-gFalmSQ', 'NO_DATASET')],
      [
        { lecture_id: 4, agent_name: 'ManuallyEdited', is_active: true },
        { lecture_id: 2, agent_name: 'DisabledOne', is_active: false },
      ]
    );
    const result = await runSeed(realConfigs(), { apply: true, query: db.fn });
    const untouched = db.profiles.find(p => p.lecture_id === 4)!.agent_name === 'ManuallyEdited'
      && db.profiles.find(p => p.lecture_id === 2)!.agent_name === 'DisabledOne';
    const noUpdates = db.calls.every(c => !/^\s*(UPDATE|DELETE)/i.test(c.text));
    const insertSql = db.calls.find(c => /INSERT/i.test(c.text));
    const pass = result.inserted === 0 && untouched && noUpdates
      && (insertSql === undefined || /ON\s+CONFLICT\s*\(lecture_id\)\s*DO\s+NOTHING/i.test(insertSql.text))
      && result.plan.filter(p => p.action === 'SKIP_EXISTING_PROFILE').length === 2;
    return { pass, detail: `inserted=${result.inserted}, untouched=${untouched}, skippedExisting=${result.plan.filter(p => p.action === 'SKIP_EXISTING_PROFILE').length}` };
  },
});

cases.push({
  label: '9. Duplicate handling: a video id matching two database lectures is ambiguous — skipped, not guessed',
  run: async () => {
    const db = fakeDb([lec(11, 'pCNit2x2gjY'), lec(12, 'pCNit2x2gjY'), lec(2, '1mi-gFalmSQ', 'NO_DATASET')]);
    const result = await runSeed(realConfigs(), { apply: true, query: db.fn });
    const nova = result.plan.find(p => p.config.agentName === 'Nova')!;
    const novaInserted = db.profiles.some(p => p.agent_name === 'Nova');
    const pass = nova.action === 'SKIP_AMBIGUOUS_LECTURE' && !novaInserted
      && db.profiles.length === 1 && db.profiles[0].lecture_id === 2;
    return { pass, detail: `Nova=${nova.action}; profiles=${JSON.stringify(db.profiles)}` };
  },
});

cases.push({
  label: '10. Idempotent: a second --apply run inserts nothing and reports everything as skipped',
  run: async () => {
    const db = fakeDb([lec(2, '1mi-gFalmSQ', 'NO_DATASET'), lec(4, 'pCNit2x2gjY')]);
    const first = await runSeed(realConfigs(), { apply: true, query: db.fn });
    const second = await runSeed(realConfigs(), { apply: true, query: db.fn });
    const pass = first.inserted === 2 && second.inserted === 0 && db.profiles.length === 2
      && second.plan.filter(p => p.action === 'SKIP_EXISTING_PROFILE').length === 2
      && second.plan.every(p => p.action !== 'INSERT');
    return { pass, detail: `first=${first.inserted}, second=${second.inserted}, rows=${db.profiles.length}` };
  },
});

cases.push({
  label: '11. Dry-run (default) is read-only: plans inserts but issues no write statement',
  run: async () => {
    const db = fakeDb([lec(2, '1mi-gFalmSQ', 'NO_DATASET'), lec(4, 'pCNit2x2gjY')]);
    const result = await runSeed(realConfigs(), { apply: false, query: db.fn });
    const pass = result.inserted === 0 && db.writes().length === 0 && db.profiles.length === 0
      && result.plan.filter(p => p.action === 'INSERT').length === 2;
    return { pass, detail: `planned=${result.plan.filter(p => p.action === 'INSERT').length}, writes=${db.writes().length}` };
  },
});

cases.push({
  label: '12. Insert binds (lecture_id, agent_name, instructions) as parameters; stored text equals the approved text',
  run: async () => {
    const db = fakeDb([lec(4, 'pCNit2x2gjY')]);
    await runSeed(realConfigs(), { apply: true, query: db.fn });
    const insert = db.calls.find(c => /INSERT/i.test(c.text))!;
    const [id, name, text] = insert.params as [number, string, string];
    const pass = id === 4 && name === 'Nova' && text === INSTRUCTIONS_BY_VIDEO_ID['pCNit2x2gjY']
      && !insert.text.includes('Nova') && !insert.text.includes(text.slice(0, 30));
    return { pass, detail: `params=[${id}, ${name}, <${text.length} chars>]` };
  },
});

cases.push({
  label: '13. Script source never writes to lectures and has no UPDATE/DELETE/DROP/TRUNCATE statement',
  run: async () => {
    const src = fs.readFileSync(require.resolve('./seed-agent-profiles'), 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const bad = [/INSERT\s+INTO\s+lectures\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i, /\bTRUNCATE\b/i]
      .filter(re => re.test(src)).map(String);
    return { pass: bad.length === 0, detail: bad.join(', ') || 'clean' };
  },
});

async function main(): Promise<void> {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
