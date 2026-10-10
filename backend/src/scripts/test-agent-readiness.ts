/**
 * Operational agent-readiness tests (Step 7A.2).
 *
 * Definition under test:
 *   agent ready  =  lecture.status = 'READY'  AND  an agent profile row
 *                   exists  AND  is_active = true
 * which is exactly the set of lectures askLectureAgent will serve.
 *
 * Two parts:
 *  Part 1 — mocked pool: contract/mapping checks on the analytics functions
 *           (no database at all).
 *  Part 2 — the real SQL, executed against a PRIVATE, THROWAWAY PostgreSQL
 *           cluster that this script creates under the OS temp dir (unix
 *           socket only) and deletes afterwards. It is never the project's
 *           development database. If PostgreSQL server binaries are not
 *           installed, Part 2 is reported as SKIPPED, not passed.
 *
 * Usage: node_modules/.bin/ts-node --transpile-only src/scripts/test-agent-readiness.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { Client } from 'pg';
import pool from '../config/database';
import {
  getAnalyticsSummary,
  getLectureAgentDetails,
  getLectureStatusList,
  getLectureChunks,
  getQuestionsPerLecture,
} from '../services/analytics.service';
import { getAgentProfileByLectureId } from '../services/lecture-agent-profile.service';

interface CaseResult { pass: boolean; skip?: boolean; detail?: string }
interface Case { label: string; run: () => Promise<CaseResult> }
const cases: Case[] = [];

type PoolQuery = (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
const withPoolQuery = async <T>(impl: PoolQuery, fn: () => Promise<T>): Promise<T> => {
  const original = pool.query;
  (pool as unknown as { query: unknown }).query = impl;
  try { return await fn(); } finally { (pool as unknown as { query: unknown }).query = original; }
};

// ── Part 1: mocked contract ─────────────────────────────────────────────

cases.push({
  label: 'M1. readyAgents query requires READY status AND an active profile (semi-join, no multiplication)',
  run: async () => {
    const seen: string[] = [];
    await withPoolQuery(async (text) => {
      const t = text.replace(/\s+/g, ' ').trim();
      seen.push(t);
      return { rows: [{ count: '2' }], rowCount: 1 };
    }, () => getAnalyticsSummary());
    const ready = seen.find(t => /FROM lectures l WHERE l\.status = 'READY'/.test(t));
    const pass = !!ready && /EXISTS \( SELECT 1 FROM lecture_agent_profiles p WHERE p\.lecture_id = l\.id AND p\.is_active = TRUE \)/.test(ready)
      && !/JOIN lecture_agent_profiles/.test(ready);
    return { pass, detail: ready?.slice(0, 110) };
  },
});

cases.push({
  label: 'M2. Analytics summary keeps its response contract (same four fields, integers)',
  run: async () => {
    const out = await withPoolQuery(async (text) => {
      if (/FROM users/.test(text)) return { rows: [{ count: '10' }], rowCount: 1 };
      if (/COUNT\(\*\) FROM lectures l/.test(text)) return { rows: [{ count: '1' }], rowCount: 1 };
      if (/FROM lectures$/.test(text.trim())) return { rows: [{ count: '7' }], rowCount: 1 };
      if (/FROM student_questions/.test(text)) return { rows: [{ count: '95' }], rowCount: 1 };
      return { rows: [{ count: '0' }], rowCount: 1 };
    }, () => getAnalyticsSummary());
    const keys = Object.keys(out).sort().join(',');
    return { pass: keys === 'readyAgents,totalLectures,totalQuestions,totalStudents' && out.readyAgents === 1 && out.totalLectures === 7 && out.totalStudents === 10 && out.totalQuestions === 95,
      detail: JSON.stringify(out) };
  },
});

cases.push({
  label: 'M3. Agent details map profile state: no row = MISSING, false = INACTIVE, true = ACTIVE; chatReady only for READY + ACTIVE',
  run: async () => {
    const d = new Date('2026-10-11T00:00:00Z');
    const rows = [
      { id: 1, title: 'ready+active',   status: 'READY',      chunk_count: '5', created_at: d, updated_at: d, profile_is_active: true },
      { id: 2, title: 'ready+missing',  status: 'READY',      chunk_count: '5', created_at: d, updated_at: d, profile_is_active: null },
      { id: 3, title: 'ready+inactive', status: 'READY',      chunk_count: '5', created_at: d, updated_at: d, profile_is_active: false },
      { id: 4, title: 'nodata+active',  status: 'NO_DATASET', chunk_count: '0', created_at: d, updated_at: d, profile_is_active: true },
    ];
    const out = await withPoolQuery(async () => ({ rows, rowCount: rows.length }), () => getLectureAgentDetails());
    const got = out.map(r => `${r.id}:${r.agentProfileStatus}:${r.chatReady}`).join(' ');
    const base = out.every(r => typeof r.chunkCount === 'number' && typeof r.createdAt === 'string' && typeof r.status === 'string');
    return { pass: got === '1:ACTIVE:true 2:MISSING:false 3:INACTIVE:false 4:ACTIVE:false' && base, detail: got };
  },
});

// ── Part 2: real SQL on a private throwaway cluster ─────────────────────

interface Scratch { client: Client; stop: () => void }

function findPgBin(name: string): string | null {
  const dirs: string[] = [];
  try {
    for (const v of fs.readdirSync('/usr/lib/postgresql')) dirs.push(`/usr/lib/postgresql/${v}/bin`);
  } catch { /* not installed */ }
  for (const d of dirs) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}

async function startScratch(): Promise<Scratch | null> {
  const initdb = findPgBin('initdb'); const pgCtl = findPgBin('pg_ctl');
  if (!initdb || !pgCtl) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr.'));            // short path: unix socket limit
  const data = path.join(root, 'data');
  const port = 54000 + Math.floor(Math.random() * 900);
  const stop = () => {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const init = spawnSync(initdb, ['-D', data, '-U', 'scratch', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
    if (init.status !== 0) { stop(); return null; }
    const start = spawnSync(pgCtl, ['-D', data, '-w', '-l', path.join(root, 'log'),
      '-o', `-c listen_addresses='' -c unix_socket_directories=${root} -c port=${port}`, 'start'], { stdio: 'ignore' });
    if (start.status !== 0) { stop(); return null; }
    const client = new Client({ host: root, port, user: 'scratch', database: 'postgres' });
    await client.connect();
    const dbSql = path.join(__dirname, '..', 'db');
    await client.query(fs.readFileSync(path.join(dbSql, 'schema.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(dbSql, 'migrate.sql'), 'utf8'));
    return { client, stop: () => { client.end().catch(() => {}); stop(); } };
  } catch {
    stop();
    return null;
  }
}

// lecture key -> [status, profile: 'active' | 'inactive' | 'none', chunks]
const FIXTURE: Record<string, [string, 'active' | 'inactive' | 'none', number]> = {
  readyActive:     ['READY',      'active',   0],
  readyNoProfile:  ['READY',      'none',     0],
  readyInactive:   ['READY',      'inactive', 0],
  noDatasetActive: ['NO_DATASET', 'active',   0],
  processingActive:['PROCESSING', 'active',   0],
  failedNoProfile: ['FAILED',     'none',     0],
  readyActive2:    ['READY',      'active',   3],   // has chunks: the join must not multiply the count
};

async function withScratch(fn: (s: Scratch, ids: Record<string, number>) => Promise<CaseResult>): Promise<CaseResult> {
  const scratch = await startScratch();
  if (!scratch) return { pass: false, skip: true, detail: 'PostgreSQL server binaries unavailable — real-SQL part skipped' };
  try {
    const ids: Record<string, number> = {};
    for (const [key, [status, profile, chunks]] of Object.entries(FIXTURE)) {
      const { rows } = await scratch.client.query(
        `INSERT INTO lectures (title, youtube_url, youtube_video_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [key, `https://youtu.be/${key}`, key, status]
      );
      ids[key] = rows[0].id;
      if (profile !== 'none') {
        await scratch.client.query(
          `INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions, is_active) VALUES ($1, $2, 'scope text', $3)`,
          [ids[key], `Agent-${key}`, profile === 'active']
        );
      }
      for (let i = 0; i < chunks; i++) {
        await scratch.client.query(
          `INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, $2, 'a', 'c')`,
          [ids[key], `q${i}`]
        );
      }
    }
    await scratch.client.query(`INSERT INTO users (name, email, password_hash, role) VALUES ('S', 's@example.com', 'x', 'STUDENT')`);
    const { rows: u } = await scratch.client.query(`SELECT id FROM users LIMIT 1`);
    await scratch.client.query(`INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, 'q1'), ($1, $3, 'q2')`,
      [u[0].id, ids.readyActive, ids.readyActive2]);
    return await withPoolQuery(
      (text, params) => scratch.client.query(text, params as unknown[]) as unknown as Promise<{ rows: unknown[]; rowCount: number | null }>,
      () => fn(scratch, ids)
    );
  } finally {
    scratch.stop();
  }
}

cases.push({
  label: 'A-F. Real SQL: only READY + active profile counts; missing / inactive / non-READY lectures never count; no duplicates',
  run: () => withScratch(async (_s, ids) => {
    const summary = await getAnalyticsSummary();
    const details = await getLectureAgentDetails();
    const byId = new Map(details.map(d => [d.id, d]));
    const expectReady = new Set([ids.readyActive, ids.readyActive2]);
    const rows = Object.entries(ids).map(([k, id]) => {
      const d = byId.get(id)!;
      return { k, ok: d.chatReady === expectReady.has(id), s: `${k}=${d.agentProfileStatus}/${d.chatReady}` };
    });
    const pass = summary.readyAgents === 2                                            // A (x2); B, C, D, processing, failed excluded
      && rows.every(r => r.ok)
      && details.length === Object.keys(FIXTURE).length                               // F: one row per lecture
      && new Set(details.map(d => d.id)).size === details.length
      && byId.get(ids.readyNoProfile)!.agentProfileStatus === 'MISSING'               // B
      && byId.get(ids.readyInactive)!.agentProfileStatus === 'INACTIVE'               // C
      && byId.get(ids.noDatasetActive)!.agentProfileStatus === 'ACTIVE' && !byId.get(ids.noDatasetActive)!.chatReady  // D
      && summary.readyAgents === details.filter(d => d.chatReady).length;             // dashboard == list
    return { pass, detail: `readyAgents=${summary.readyAgents} | ${rows.map(r => r.s).join(' ')}` };
  }),
});

cases.push({
  label: 'E. Mixed statuses and chunk joins: chunk counts stay correct and do not inflate readiness',
  run: () => withScratch(async (_s, ids) => {
    const details = await getLectureAgentDetails();
    const withChunks = details.find(d => d.id === ids.readyActive2)!;
    const summary = await getAnalyticsSummary();
    return { pass: withChunks.chunkCount === 3 && summary.readyAgents === 2, detail: `chunks=${withChunks.chunkCount}, readyAgents=${summary.readyAgents}` };
  }),
});

cases.push({
  label: 'A2. Nonexistent lecture can never be an agent: a profile for it cannot exist (FK), and the count is unaffected',
  run: () => withScratch(async (s) => {
    let rejected = false;
    try {
      await s.client.query(`INSERT INTO lecture_agent_profiles (lecture_id, agent_name, instructions) VALUES (999999, 'Ghost', 'x')`);
    } catch (e) { rejected = (e as { code?: string }).code === '23503'; }
    const summary = await getAnalyticsSummary();
    return { pass: rejected && summary.readyAgents === 2, detail: `fkRejected=${rejected}, readyAgents=${summary.readyAgents}` };
  }),
});

cases.push({
  label: 'P. Parity with chat: lectures reported chatReady are exactly those the chat gate would serve (READY + profile FOUND)',
  run: () => withScratch(async (_s, ids) => {
    const details = await getLectureAgentDetails();
    const mismatches: string[] = [];
    for (const d of details) {
      const lookup = await getAgentProfileByLectureId(d.id);                          // the real chat-gate lookup
      const chatServes = d.status === 'READY' && lookup.status === 'FOUND';
      if (chatServes !== d.chatReady) mismatches.push(`#${d.id}`);
    }
    return { pass: mismatches.length === 0 && details.length === Object.keys(ids).length, detail: mismatches.length ? `mismatch ${mismatches}` : 'dashboard == chat availability for all lectures' };
  }),
});

cases.push({
  label: 'G. Existing analytics unchanged: totals, per-lecture questions, status list and chunk listing behave as before',
  run: () => withScratch(async (_s, ids) => {
    const summary = await getAnalyticsSummary();
    const perLecture = await getQuestionsPerLecture();
    const statusList = await getLectureStatusList();
    const chunks = await getLectureChunks(ids.readyActive2);
    const pass = summary.totalLectures === 7 && summary.totalStudents === 1 && summary.totalQuestions === 2
      && perLecture.length === 2
      && statusList.length === 7 && statusList.every(l => ['READY', 'NO_DATASET', 'PROCESSING', 'FAILED'].includes(l.status))
      && statusList.filter(l => l.status === 'READY').length === 4                    // status semantics unchanged: 4 READY lectures (2 of them are chat-ready)
      && chunks.length === 3 && Object.keys(chunks[0]).sort().join(',') === 'answer,endTime,id,keywords,question,startTime,topic';
    return { pass, detail: `totals=${summary.totalLectures}/${summary.totalStudents}/${summary.totalQuestions}, READY by status=${statusList.filter(l => l.status === 'READY').length}` };
  }),
});

cases.push({
  label: 'S. lecture.status semantics untouched: no code path writes status from agent-profile state; no schema change',
  run: async () => {
    const analytics = fs.readFileSync(path.join(__dirname, '..', 'services', 'analytics.service.ts'), 'utf8');
    const profileSvc = fs.readFileSync(path.join(__dirname, '..', 'services', 'lecture-agent-profile.service.ts'), 'utf8');
    const writesStatus = /UPDATE\s+lectures\s+SET\s+status/i.test(analytics + profileSvc);
    const onlySelects = !/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(analytics.replace(/\/\/.*$/gm, ''));
    return { pass: !writesStatus && onlySelects, detail: `writesStatus=${writesStatus}, analyticsReadOnly=${onlySelects}` };
  },
});

async function main(): Promise<void> {
  let failures = 0; let skipped = 0;
  for (const c of cases) {
    try {
      const r = await c.run();
      if (r.skip) { skipped++; console.log(`SKIP  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
      else if (r.pass) console.log(`PASS  ${c.label}${r.detail ? ` (${r.detail})` : ''}`);
      else { failures++; console.log(`FAIL  ${c.label}${r.detail ? ` (${r.detail})` : ''}`); }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${c.label} (threw: ${(err as Error).message})`);
    }
  }
  const ran = cases.length - skipped;
  console.log(`\n${ran - failures}/${ran} passed${skipped ? ` (${skipped} skipped)` : ''}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
