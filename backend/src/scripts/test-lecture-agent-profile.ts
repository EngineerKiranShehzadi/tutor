/**
 * Validates lecture-agent-profile.service.ts (getAgentProfileByLectureId).
 *
 * Pure unit tests: the database dependency is a mock injected through the
 * service's `deps.query` seam, so nothing here connects to PostgreSQL and
 * no row is ever read, inserted, updated, or deleted.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-lecture-agent-profile.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { LectureAgentProfile } from '../types';
import {
  getAgentProfileByLectureId,
  AgentProfileQueryFn,
} from '../services/lecture-agent-profile.service';

interface CaseResult {
  pass: boolean;
  detail?: string;
}
interface Case {
  label: string;
  run: () => Promise<CaseResult>;
}

const cases: Case[] = [];

const profileRow = (overrides: Partial<LectureAgentProfile> = {}): LectureAgentProfile => ({
  lecture_id: 4,
  agent_name: 'Nova',
  instructions: 'Focus on the introductory material of this lecture.',
  is_active: true,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-02T00:00:00Z'),
  ...overrides,
});

// Records every call so tests can assert on SQL text and bound parameters.
const mockQuery = (rows: LectureAgentProfile[]) => {
  const calls: { text: string; params?: unknown[] }[] = [];
  const fn: AgentProfileQueryFn = async (text, params) => {
    calls.push({ text, params });
    return { rows };
  };
  return { fn, calls };
};

cases.push({
  label: '1. Active profile exists: returns FOUND with the exact stored profile',
  run: async () => {
    const row = profileRow();
    const { fn } = mockQuery([row]);
    const r = await getAgentProfileByLectureId(4, { query: fn });
    const pass = r.status === 'FOUND' && r.profile === row
      && r.profile.lecture_id === 4 && r.profile.agent_name === 'Nova'
      && r.profile.instructions === row.instructions && r.profile.is_active === true;
    return { pass, detail: `status=${r.status}` };
  },
});

cases.push({
  label: '2. No profile exists: returns NOT_FOUND (with the lecture id), not an error',
  run: async () => {
    const { fn } = mockQuery([]);
    const r = await getAgentProfileByLectureId(2, { query: fn });
    return { pass: r.status === 'NOT_FOUND' && r.lectureId === 2, detail: JSON.stringify(r) };
  },
});

cases.push({
  label: '3. Inactive profile: returns INACTIVE, distinct from NOT_FOUND, without exposing instructions',
  run: async () => {
    const { fn } = mockQuery([profileRow({ is_active: false, instructions: 'SECRET-DISABLED-INSTRUCTIONS' })]);
    const r = await getAgentProfileByLectureId(4, { query: fn });
    const serialized = JSON.stringify(r);
    const pass = r.status === 'INACTIVE' && r.lectureId === 4 && r.agentName === 'Nova'
      && !('profile' in r) && !('instructions' in r)
      && !serialized.includes('SECRET-DISABLED-INSTRUCTIONS');
    return { pass, detail: serialized };
  },
});

cases.push({
  label: '4. Database failure: the original error is rethrown unchanged, never reported as NOT_FOUND',
  run: async () => {
    const dbError = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    const failing: AgentProfileQueryFn = async () => { throw dbError; };
    let result: unknown = 'resolved';
    let thrown: unknown = null;
    try {
      result = await getAgentProfileByLectureId(4, { query: failing });
    } catch (err) {
      thrown = err;
    }
    const pass = result === 'resolved' && thrown === dbError && (thrown as { code?: string }).code === '57P01';
    return { pass, detail: thrown ? `threw "${(thrown as Error).message}" (same instance: ${thrown === dbError})` : `resolved with ${JSON.stringify(result)}` };
  },
});

cases.push({
  label: '5. lecture_id is bound as a parameter ($1), once per call, never interpolated into the SQL',
  run: async () => {
    const ids = [987654, 31337];
    const details: string[] = [];
    for (const id of ids) {
      const { fn, calls } = mockQuery([]);
      await getAgentProfileByLectureId(id, { query: fn });
      const c = calls[0];
      const ok = calls.length === 1
        && JSON.stringify(c.params) === JSON.stringify([id])
        && /WHERE\s+lecture_id\s*=\s*\$1/.test(c.text)
        && /FROM\s+lecture_agent_profiles/.test(c.text)
        && !c.text.includes(String(id));
      details.push(`id=${id}: calls=${calls.length} params=${JSON.stringify(c?.params)} ok=${ok}`);
      if (!ok) return { pass: false, detail: details.join(' | ') };
    }
    return { pass: true, detail: details.join(' | ') };
  },
});

cases.push({
  label: '6. A non-integer lecture id (undefined / NaN / 1.5 / "4") throws and never queries',
  run: async () => {
    const bad: unknown[] = [undefined, NaN, 1.5, '4', null];
    const { fn, calls } = mockQuery([]);
    let rejected = 0;
    for (const value of bad) {
      try {
        await getAgentProfileByLectureId(value as number, { query: fn });
      } catch (err) {
        if (err instanceof TypeError) rejected++;
      }
    }
    return { pass: rejected === bad.length && calls.length === 0, detail: `rejected=${rejected}/${bad.length}, queries=${calls.length}` };
  },
});

cases.push({
  label: '7. Lookup is read-only: the SQL is a single SELECT (no write statement)',
  run: async () => {
    const { fn, calls } = mockQuery([]);
    await getAgentProfileByLectureId(4, { query: fn });
    const sql = calls[0].text.trim();
    const pass = /^SELECT\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql);
    return { pass, detail: sql.replace(/\s+/g, ' ').slice(0, 120) };
  },
});

cases.push({
  label: '8. Service has no LLM / agent-framework / RAG-pipeline imports and creates no second DB pool',
  run: async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'lecture-agent-profile.service.ts'), 'utf8');
    const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n');
    const forbidden = [/gemini/i, /llm/i, /langgraph/i, /langchain/i, /crewai/i, /chat\.service/, /rerank/i, /vector-search/i, /rag\//];
    const offenders = forbidden.filter(re => re.test(importLines)).map(String);
    const createsPool = /new\s+Pool\s*\(/.test(src);
    return { pass: offenders.length === 0 && !createsPool, detail: `imports ok=${offenders.length === 0}, new Pool=${createsPool}` };
  },
});

async function main(): Promise<void> {
  let failures = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      if (r.pass) {
        console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      } else {
        failures++;
        console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  console.log(`\n${cases.length - failures}/${cases.length} passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
