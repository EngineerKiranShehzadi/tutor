/**
 * Admin/production hardening, batches 2–4 (A4–A6, A9–A12, A15–A20):
 *   A4  upload limits (zip bomb, lying zip, rows, columns) and the linear
 *       possible-duplicate scan (same result as the all-pairs scan)
 *   A5  trust proxy, per-student question limits on GraphQL and /chat/ask-stream
 *   A6  readiness: required components, free provider probe, passive signal
 *
 * Needs a throwaway local Postgres (same guard as the other DB suites).
 * Usage: DATABASE_URL=postgresql://…/askai_…_test ts-node --transpile-only src/scripts/test-admin-hardening.ts
 */
import { assertThrowawayDb } from './test-db-guard-lib';

assertThrowawayDb('test-admin-hardening');

import * as XLSX from 'xlsx';
import express from 'express';
import { AddressInfo } from 'net';
import { deflateRawSync } from 'zlib';
import { spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import pool, { query } from '../config/database';
import { env } from '../config/env';
import { assertSafeXlsx } from '../utils/xlsx-guard';
import { parseExcel } from '../services/chunk.service';
import { findPossibleDuplicates } from '../services/dataset-plan';
import { enforceAskQuota, AskQuotaExceededError, resetAskQuotaForTests, askQuotaTrackedUsers } from '../services/ask-quota.service';
import { chatResolvers } from '../graphql/resolvers/chat.resolver';
import chatRoutes from '../routes/chat.routes';
import { generateAccessToken } from '../utils/jwt';
import { checkProviderHealth, overallStatus, requiredComponents, ComponentHealth, checkAnswerLlm, checkReadiness, resetHealthCache, UNHEALTHY_CACHE_TTL_MS } from '../observability/health.service';
import { recordProviderFailure, recordProviderSuccess, resetProviderSignals } from '../observability/provider-signal';
import { EmbeddingUnavailableError } from '../embedding/embedding-errors';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { parse, validate, specifiedRules } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { ApolloServer } from '@apollo/server';
import { applyMigrations } from './db-setup';
import { getRecentQuestions, getRecentQuestionsPage, getContentGaps, CONTENT_GAPS_MAX_QUESTIONS, getMyStats,
  getLectureChunks, getRegisteredStudents, getStudentJourney } from '../services/analytics.service';
import { getAllUsers } from '../services/user.service';
import { analyticsResolvers } from '../graphql/resolvers/analytics.resolver';
import { queryLimitsRule } from '../graphql/query-limits';
import { typeDefs } from '../graphql/typeDefs';
import datasetRoutes from '../routes/dataset.routes';
import { errorHandler, AppError } from '../middleware/errorHandler';
import { formatGraphQLError } from '../graphql';
import { logger } from '../utils/logger';
import { computeEnrichedOverviewMetrics, overviewCache } from '../services/observability/aggregate.service';
import { rateLimitStore } from '../graphql/resolvers/auth.resolver';
import { ExpiringMap } from '../utils/expiring-map';
import { globalLimiter, userLimiter } from '../middleware/rateLimiter';
import { startMaintenanceScheduler, stopMaintenanceScheduler, maintenanceSchedulerState, runRetention } from '../observability/maintenance.scheduler';
import { finishDatasetVersion, rollbackDataset, failDatasetVersion, reconcileLectureStatuses } from '../services/dataset-version.service';
import { EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import observabilityRoutes from '../routes/observability.routes';
import { resolveLlmProvider } from '../llm/llm-provider.resolver';
import { generateAnswer } from '../services/llm-gemini.service';
import { STAGE_SPAN_KIND, OpenInferenceSpanKind } from '../observability/otel-semconv';
import { OUTPUT_GUARDRAIL_REASONS } from '../rag/guardrails/output/answer-verification.types';

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`);
};
const rejects = (fn: () => unknown): Error | null => { try { fn(); return null; } catch (e) { return e as Error; } };
const statusOf = (e: unknown) => (e as { statusCode?: number } | null)?.statusCode;

const workbook = (rows: unknown[][]): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'S');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
};

// Minimal zip writer (deflate). `declaredSize` lets a test lie about the uncompressed size.
const zip = (files: { name: string; data: Buffer; declaredSize?: number }[]): Buffer => {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const size = f.declaredSize ?? f.data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
};

// The previous all-pairs implementation, verbatim, as the reference.
const referenceDuplicates = (
  added: { sheetRow: number; question: string; answer: string }[],
  carried: { qaId: string; question: string; answer: string }[]
) => {
  const normSpace = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normQuestion = (s: string) => normSpace(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const prep = <T extends { question: string; answer: string }>(x: T) => {
    const q = normQuestion(x.question);
    return { x, q, a: normSpace(x.answer), words: new Set(q.split(' ').filter(Boolean)) };
  };
  const existing = carried.map(prep);
  const out: { sheetRow: number; newQuestion: string; existingQaId: string; existingQuestion: string }[] = [];
  for (const n of added.map(prep)) for (const e of existing) {
    if (n.a === e.a || n.q === e.q || jaccard(n.words, e.words) >= 0.8) {
      out.push({ sheetRow: n.x.sheetRow, newQuestion: n.x.question, existingQaId: e.x.qaId, existingQuestion: e.x.question });
    }
  }
  return out;
};

const run = async () => {
  const lim = env.DATASET as { MAX_ROWS: number; MAX_COLUMNS: number; MAX_UNCOMPRESSED_BYTES: number; MAX_ZIP_ENTRIES: number };
  const limits = { maxUncompressedBytes: lim.MAX_UNCOMPRESSED_BYTES, maxEntries: lim.MAX_ZIP_ENTRIES };

  // ── A4: upload limits ────────────────────────────────────────────────
  {
    const ok = rejects(() => assertSafeXlsx(workbook([['question', 'answer'], ['q', 'a']]), limits));
    check('A4-1. A normal workbook passes the zip check', ok === null, `error=${ok?.message ?? 'none'}`);

    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(lim.MAX_UNCOMPRESSED_BYTES + 1024 * 1024, 0x20) }]);
    const t0 = Date.now();
    const e1 = rejects(() => parseExcel(bomb));
    check(`A4-2. Zip bomb (${Math.round(bomb.length / 1024)} KB → ${Math.round(lim.MAX_UNCOMPRESSED_BYTES / 1048576) + 1} MB) → 400 before parsing, quickly`,
      statusOf(e1) === 400 && /expands to more than/.test(e1?.message ?? '') && Date.now() - t0 < 2000,
      `status=${statusOf(e1)} ms=${Date.now() - t0} msg="${e1?.message}"`);

    const liar = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(lim.MAX_UNCOMPRESSED_BYTES + 1024 * 1024, 0x20), declaredSize: 100 }]);
    const e2 = rejects(() => assertSafeXlsx(liar, limits));
    check('A4-3. A zip that LIES about its uncompressed size is still caught (real inflation is capped)',
      statusOf(e2) === 400 && /expands to more than/.test(e2?.message ?? ''), `msg="${e2?.message}"`);

    const many = zip(Array.from({ length: lim.MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.from('x') })));
    const e3 = rejects(() => assertSafeXlsx(many, limits));
    const e4 = rejects(() => parseExcel(Buffer.from('this is not a zip file at all, just text pretending to be an xlsx')));
    check('A4-4. Too many zip entries → 400; a non-zip "xlsx" → 400 "not a valid .xlsx" (was a 500/parser error)',
      statusOf(e3) === 400 && /too many internal parts/.test(e3?.message ?? '') && statusOf(e4) === 400 && /not a valid \.xlsx/.test(e4?.message ?? ''),
      `entries="${e3?.message}" notZip="${e4?.message}"`);

    const savedRows = lim.MAX_ROWS;
    lim.MAX_ROWS = 10;
    const rows = (n: number) => [['question', 'answer'], ...Array.from({ length: n }, (_, i) => [`q${i}`, `a${i}`])];
    const atLimit = parseExcel(workbook(rows(10))).length;
    const e5 = rejects(() => parseExcel(workbook(rows(11))));
    const blankTail = XLSX.utils.aoa_to_sheet(rows(3)); blankTail['!ref'] = 'A1:B100000';
    const wbBlank = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wbBlank, blankTail, 'S');
    const withBlankTail = parseExcel(XLSX.write(wbBlank, { type: 'buffer', bookType: 'xlsx' }) as Buffer).length;
    lim.MAX_ROWS = savedRows;
    check('A4-5. Row limit: exactly the limit is accepted, one more is a 400; empty rows below the data do not count',
      atLimit === 10 && statusOf(e5) === 400 && /more than 10 rows/.test(e5?.message ?? '') && withBlankTail === 3,
      `atLimit=${atLimit} over="${e5?.message}" blankTail=${withBlankTail}`);

    const wide = XLSX.utils.aoa_to_sheet([['question', 'answer'], ['q', 'a']]);
    wide[XLSX.utils.encode_cell({ r: 1, c: 5000 })] = { t: 's', v: 'stray' };
    wide['!ref'] = `A1:${XLSX.utils.encode_cell({ r: 1, c: 5000 })}`;
    const wbWide = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wbWide, wide, 'S');
    const wideRows = parseExcel(XLSX.write(wbWide, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    check(`A4-6. A stray cell in column 5001 does not make every row 5001 wide (only the first ${lim.MAX_COLUMNS} columns are read)`,
      wideRows.length === 1 && Object.keys(wideRows[0]).length <= lim.MAX_COLUMNS && wideRows[0].question === 'q',
      `keys=${Object.keys(wideRows[0] ?? {}).length}`);

    const dir = join(process.env.HOME ?? '', 'Downloads', 'Final-merged-dataset');
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith('.xlsx'));
      const out = files.map(f => {
        const buf = readFileSync(join(dir, f));
        const wb = XLSX.read(buf, { type: 'buffer' });
        const n = wb.SheetNames.find(x => x.trim().toLowerCase() === 'final_dataset') ?? wb.SheetNames[0];
        const plain = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' }).length;
        let got = -1; try { got = parseExcel(buf).length; } catch { /* counted as a failure below */ }
        return { f, plain, got };
      });
      check(`A4-7. All ${files.length} real merged lecture datasets pass the limits with exactly the same rows as before`,
        files.length > 0 && out.every(o => o.got === o.plain && o.got > 0), out.map(o => `${o.f.slice(0, 18)}:${o.got}/${o.plain}`).join(' '));
    } else {
      console.log(`SKIP  A4-7. real datasets (${dir} not present)`);
    }
  }

  // ── A4: duplicate scan ───────────────────────────────────────────────
  {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const vocab = ['what', 'is', 'the', 'a', 'neural', 'network', 'loss', 'gradient', 'model', 'data', 'why', 'how', 'does', 'layer', 'train'];
    const sentence = () => Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => vocab[Math.floor(rnd() * vocab.length)]).join(' ') + (rnd() < 0.3 ? '?' : '');
    let mismatches = 0; let pairs = 0;
    for (let t = 0; t < 400; t++) {
      const carried = Array.from({ length: Math.floor(rnd() * 25) }, (_, i) => ({ qaId: `qa${i}`, question: sentence(), answer: rnd() < 0.3 ? 'same answer' : sentence() }));
      const added = Array.from({ length: Math.floor(rnd() * 25) }, (_, i) => ({ sheetRow: i + 2, question: rnd() < 0.2 ? '!!!' : sentence(), answer: rnd() < 0.3 ? 'same  answer' : sentence() }));
      const a = JSON.stringify(findPossibleDuplicates(added, carried));
      const b = JSON.stringify(referenceDuplicates(added, carried));
      pairs += (JSON.parse(b) as unknown[]).length;
      if (a !== b) mismatches++;
    }
    check('A4-8. Indexed duplicate scan returns exactly what the all-pairs scan returns (400 random cases, same order)',
      mismatches === 0 && pairs > 1000, `mismatches=${mismatches} pairsCompared=${pairs}`);

    const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({
      question: `${tag} question number ${i} about topic ${i % 97} and detail ${i % 13}`, answer: `${tag} answer ${i}`,
    }));
    const added = big(5000, 'new').map((x, i) => ({ ...x, sheetRow: i + 2 }));
    const carried = big(5000, 'old').map((x, i) => ({ ...x, qaId: `qa${i}` }));
    const t0 = Date.now();
    findPossibleDuplicates(added, carried);
    const ms = Date.now() - t0;
    check('A4-9. 5,000 new rows × 5,000 carried Q&As (25M pairs before) finish in well under 2 s', ms < 2000, `ms=${ms}`);
  }

  // ── A5: trust proxy ──────────────────────────────────────────────────
  {
    const probe = (extra: Record<string, string>) => {
      const e = { ...process.env, ...extra };
      if (!('TRUST_PROXY' in extra)) delete e.TRUST_PROXY;
      const r = spawnSync(join(__dirname, '../../node_modules/.bin/ts-node'), ['--transpile-only', '-e',
        "console.log('TP=' + JSON.stringify(require('./src/config/env').env.TRUST_PROXY))"], { cwd: join(__dirname, '../..'), env: e, encoding: 'utf8' });
      return (r.stdout.split('\n').find(l => l.startsWith('TP=')) ?? 'TP=?').slice(3);
    };
    const prod = probe({ NODE_ENV: 'production' });
    const dev = probe({ NODE_ENV: 'development' });
    const off = probe({ NODE_ENV: 'production', TRUST_PROXY: 'false' });
    const two = probe({ NODE_ENV: 'production', TRUST_PROXY: '2' });

    const app = express();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }); });
    const srv = app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const ip = ((await (await fetch(`http://127.0.0.1:${port}/ip`, { headers: { 'X-Forwarded-For': '203.0.113.7' } })).json()) as { ip: string }).ip;
    srv.close();
    check('A5-1. trust proxy: 1 hop by default in production, off in development, configurable; with it req.ip is the client, not the proxy',
      prod === '1' && dev === 'false' && off === 'false' && two === '2' && ip === '203.0.113.7',
      `production=${prod} development=${dev} TRUST_PROXY=false→${off} TRUST_PROXY=2→${two} req.ip=${ip}`);
  }

  // ── A5: per-student question limits ──────────────────────────────────
  {
    resetAskQuotaForTests();
    const t = Date.now();
    const lim = { perMinute: 3, perDay: 0 };
    for (let i = 0; i < 3; i++) await enforceAskQuota('u1', lim, t + i);
    let fourth: unknown = null;
    try { await enforceAskQuota('u1', lim, t + 10); } catch (e) { fourth = e; }
    let other: unknown = null;
    try { await enforceAskQuota('u2', lim, t + 10); } catch (e) { other = e; }
    let later: unknown = null;
    try { await enforceAskQuota('u1', lim, t + 60_001); } catch (e) { later = e; }
    await enforceAskQuota('u3', lim, t + 10 * 60_000);   // triggers the sweep of idle users
    check('A5-2. Burst limit per student: 4th question within 60 s → 429 with Retry-After; other students unaffected; allowed again after the window; idle users are swept',
      fourth instanceof AskQuotaExceededError && fourth.statusCode === 429 && fourth.retryAfterSec >= 59 && other === null && later === null
        && askQuotaTrackedUsers() === 1,
      `fourth=${(fourth as Error)?.message} retryAfter=${(fourth as AskQuotaExceededError)?.retryAfterSec} tracked=${askQuotaTrackedUsers()}`);

    const user = (await query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('Quota Test', $1, 'x', TRUE, 'STUDENT') RETURNING id`,
      [`quota-${Date.now()}@example.test`])).rows[0].id;
    for (let i = 0; i < 3; i++) await query('INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, NULL, $2)', [user, `q${i}`]);
    await query(`INSERT INTO student_questions (student_id, lecture_id, question, created_at) VALUES ($1, NULL, 'old', LOCALTIMESTAMP - INTERVAL '25 hours')`, [user]);
    let underDaily: unknown = null;
    try { await enforceAskQuota(user, { perMinute: 0, perDay: 4 }); } catch (e) { underDaily = e; }
    let overDaily: unknown = null;
    try { await enforceAskQuota(user, { perMinute: 0, perDay: 3 }); } catch (e) { overDaily = e; }
    check('A5-3. Daily limit counts the student\'s questions of the last 24 h from the database (older ones do not count)',
      underDaily === null && overDaily instanceof AskQuotaExceededError && /today's limit of 3/.test((overDaily as Error).message),
      `under=${underDaily ? (underDaily as Error).message : 'allowed'} over=${(overDaily as Error)?.message}`);

    // Both entry points enforce it, before any work is done.
    const chat = env.CHAT as { RATE_LIMIT_PER_MINUTE: number; DAILY_QUESTION_LIMIT: number };
    const saved = { ...chat };
    chat.DAILY_QUESTION_LIMIT = 3; chat.RATE_LIMIT_PER_MINUTE = 0;
    let gql: { code?: unknown; status?: unknown; message: string } | null = null;
    try {
      await chatResolvers.Mutation.askLectureAgent(
        undefined, { input: { lectureId: 999999, question: 'hello?', sessionId: 0 } },
        { req: { user: { id: user, email: 'quota@example.test', role: 'STUDENT' } } } as never);
    } catch (e) {
      const ge = e as { message: string; extensions?: { code?: unknown; status?: unknown } };
      gql = { code: ge.extensions?.code, status: ge.extensions?.status, message: ge.message };
    }
    const app = express();
    app.use(express.json());
    app.use('/chat', chatRoutes);
    const srv = app.listen(0);
    const port = (srv.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/chat/ask-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateAccessToken(user, 'STUDENT')}` },
      body: JSON.stringify({ lectureId: 999999, question: 'hello?', sessionId: 0 }),
    });
    const body = await res.json().catch(() => null) as { message?: string } | null;
    srv.close();
    Object.assign(chat, saved);
    check('A5-4. Over the limit: GraphQL askLectureAgent → RATE_LIMITED (429); /chat/ask-stream → plain HTTP 429 + Retry-After before the stream opens',
      gql?.code === 'RATE_LIMITED' && gql.status === 429 && res.status === 429 && !!res.headers.get('retry-after')
        && !String(res.headers.get('content-type')).includes('event-stream') && /today's limit/.test(body?.message ?? ''),
      `graphql=${gql?.code}/${gql?.status} stream=${res.status} retryAfter=${res.headers.get('retry-after')} msg="${body?.message}"`);
  }

  // ── A6: readiness ────────────────────────────────────────────────────
  {
    const h = (status: ComponentHealth['status']): ComponentHealth => ({ status, latencyMs: 1 });
    const all = (over: Partial<Record<'database' | 'pgvector' | 'embeddingServer' | 'reranker' | 'answerLlm', ComponentHealth>>) =>
      ({ database: h('healthy'), pgvector: h('healthy'), embeddingServer: h('healthy'), reranker: h('healthy'), answerLlm: h('healthy'), ...over });
    const req = requiredComponents();
    const answerDown = overallStatus(all({ answerLlm: h('unhealthy') }), req);
    const rerankDown = overallStatus(all({ reranker: h('unhealthy') }), req);
    const unverified = overallStatus(all({ answerLlm: h('degraded') }), req);
    // AD10: the answer LLM is always required (renamed from `gemini`).
    check('A6-1. A dead answer model or reranker → unhealthy (503); unverified (config-only) → degraded (200); the answer LLM is always required',
      req.join() === 'database,pgvector,embeddingServer,reranker,answerLlm'
        && answerDown === 'unhealthy' && rerankDown === 'unhealthy' && unverified === 'degraded',
      `required=${req.join()} answerDown=${answerDown} rerankDown=${rerankDown} unverified=${unverified}`);

    resetProviderSignals();
    const hosted = { assertConfigured: () => undefined };
    const fresh = await checkProviderHealth(hosted, 'reranker');
    recordProviderFailure('reranker', new Error('Voyage rerank unavailable (503) after 3 retries'));
    const one = await checkProviderHealth(hosted, 'reranker');
    recordProviderFailure('reranker', new Error('Voyage rerank rate limit or quota exceeded (429) after 3 retries'));
    const two = await checkProviderHealth(hosted, 'reranker');
    recordProviderSuccess('reranker');
    const healed = await checkProviderHealth(hosted, 'reranker');
    recordProviderFailure('reranker', new Error('Voyage rerank accepts at most 1000 documents per request; got 2000'));
    recordProviderFailure('reranker', new Error('Voyage rerank accepts at most 1000 documents per request; got 2000'));
    const inputErrors = await checkProviderHealth(hosted, 'reranker');
    check('A6-2. Hosted provider without a free probe: two availability failures in a row on real calls → unhealthy; one → still healthy; a success heals it; input errors do not count',
      fresh.status === 'healthy' && one.status === 'healthy' && two.status === 'unhealthy' && two.errorCode === 'RATE_LIMITED'
        && healed.status === 'healthy' && inputErrors.status === 'healthy',
      `fresh=${fresh.status} 1fail=${one.status} 2fails=${two.status}/${two.errorCode} afterSuccess=${healed.status} inputErrors=${inputErrors.status}`);

    const probeDown = await checkProviderHealth({ assertConfigured: () => undefined, probe: async () => { throw new EmbeddingUnavailableError('OpenAI not reachable at https://api.openai.com/v1/models: fetch failed'); } }, 'embeddingServer');
    const probeOk = await checkProviderHealth({ assertConfigured: () => undefined, probe: async () => undefined }, 'embeddingServer');
    check('A6-3. Hosted provider with a free probe: probe failing → unhealthy; probe ok → healthy',
      probeDown.status === 'unhealthy' && probeDown.errorCode === 'SERVICE_UNREACHABLE' && probeOk.status === 'healthy',
      `down=${probeDown.status}/${probeDown.errorCode} ok=${probeOk.status}`);
    resetProviderSignals();
  }
  // ── A9: CSV encoder (frontend/src/lib/csv.ts) ────────────────────────
  {
    // Loaded at runtime: it lives in the frontend package, outside the backend's tsc project.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { csvCell, toCsv } = require(join(__dirname, '../../../frontend/src/lib/csv')) as
      { csvCell: (v: unknown) => string; toCsv: (rows: unknown[][]) => string };
    const cells = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tTAB', '\rCR', 'plain', 'say "hi"', null, 42];
    const out = cells.map(csvCell);
    const expected = [`"'=1+1"`, `"'+SUM(A1)"`, `"'-2+3"`, `"'@cmd"`, `"'\tTAB"`, `"'\rCR"`, '"plain"', '"say ""hi"""', '""', '"42"'];
    check('A9-2. CSV cells: = + - @ tab CR get a leading apostrophe; quotes are doubled; null → empty; rows joined with CRLF',
      JSON.stringify(out) === JSON.stringify(expected) && toCsv([['a', 'b'], ['c', '=d']]) === `"a","b"\r\n"c","'=d"`,
      `out=${JSON.stringify(out)}`);
  }

  // ── A10: migration ledger + rerun-safe backfill ──────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const tbl = `ledger_test_${Date.now()}`;
    writeFileSync(join(dir, '001_a.sql'), `CREATE TABLE IF NOT EXISTS ${tbl} (n INT); INSERT INTO ${tbl} VALUES (1);`);
    writeFileSync(join(dir, '002_b.sql'), `INSERT INTO ${tbl} VALUES (2);`);
    const r1 = await applyMigrations(dir);
    const r2 = await applyMigrations(dir);
    writeFileSync(join(dir, '002_b.sql'), `INSERT INTO ${tbl} VALUES (3);`);
    const r3 = await applyMigrations(dir);
    writeFileSync(join(dir, '003_bad.sql'), `INSERT INTO ${tbl} VALUES (4); SELECT * FROM no_such_table_xyz;`);
    const bad = await applyMigrations(dir).then(() => null, e => e as Error);
    const values = (await query<{ n: number }>(`SELECT n FROM ${tbl} ORDER BY n`)).rows.map(r => r.n).join(',');
    const ledger = (await query<{ filename: string }>(`SELECT filename FROM schema_migrations WHERE filename IN ('001_a.sql','002_b.sql','003_bad.sql') ORDER BY 1`)).rows.map(r => r.filename).join(',');
    await query(`DROP TABLE ${tbl}`);
    await query(`DELETE FROM schema_migrations WHERE filename IN ('001_a.sql','002_b.sql','003_bad.sql')`);
    rmSync(dir, { recursive: true, force: true });
    check('A10-1. Ledger: new files applied once, unchanged files skipped, a changed file re-applied, a failing file rolled back and NOT recorded',
      r1.applied.join() === '001_a.sql,002_b.sql' && r2.skipped.length === 2 && r2.applied.length === 0
        && r3.reapplied.join() === '002_b.sql' && r3.skipped.join() === '001_a.sql'
        && !!bad && /003_bad\.sql/.test(bad.message) && values === '1,2,3' && ledger === '001_a.sql,002_b.sql',
      `run1=${r1.applied} run2 skipped=${r2.skipped.length} run3 reapplied=${r3.reapplied} bad="${bad?.message.slice(0, 60)}" rows=${values} ledger=${ledger}`);

    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[a10] backfill', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('A10', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`a10-${Date.now()}@example.test`])).rows[0].id;
    // An empty duplicate "Previous Chats" (what old re-runs left) plus an orphaned chat row.
    await query(`INSERT INTO chat_sessions (student_id, lecture_id, title) VALUES ($1, $2, 'Previous Chats'), ($1, $2, 'Previous Chats')`, [stu, lec]);
    await query(`INSERT INTO chat_history (student_id, lecture_id, question, answer) VALUES ($1, $2, 'old q', 'old a')`, [stu, lec]);
    const migrateSql = readFileSync(join(__dirname, '../db/migrate.sql'), 'utf8');
    await pool.query(migrateSql);
    await pool.query(migrateSql);
    const sessions = (await query<{ n: string }>(`SELECT COUNT(*) n FROM chat_sessions WHERE student_id = $1 AND lecture_id = $2 AND title = 'Previous Chats'`, [stu, lec])).rows[0].n;
    const orphans = (await query<{ n: string }>(`SELECT COUNT(*) n FROM chat_history WHERE student_id = $1 AND session_id IS NULL`, [stu])).rows[0].n;
    check('A10-2. migrate.sql run twice: exactly one "Previous Chats" session per student+lecture (empty duplicates removed), orphaned rows attached',
      sessions === '1' && orphans === '0', `previousChatsSessions=${sessions} orphanRows=${orphans}`);
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { scripts: Record<string, string> };
    check('A10-3. npm run db:migrate runs the full setup sequence (not only schema.sql)',
      pkg.scripts['db:migrate'] === pkg.scripts['db:setup'] && /db-setup\.ts/.test(pkg.scripts['db:migrate']), `db:migrate="${pkg.scripts['db:migrate']}"`);
  }

  // ── A11: student questions are served a page at a time ───────────────
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[a11] questions', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('A11 Student', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`a11-${Date.now()}@example.test`])).rows[0].id;
    await query(`INSERT INTO student_questions (student_id, lecture_id, question)
                 SELECT $1, $2, 'bulk question ' || g FROM generate_series(1, 260) g`, [stu, lec]);
    await query(`INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, 'what is 100% accuracy?'), ($1, $2, 'what is 100 accuracy?')`, [stu, lec]);
    const list = await getRecentQuestions(undefined);
    const huge = await getRecentQuestions(10000);
    const page = await getRecentQuestionsPage({ limit: 10000, offset: 0, lectureId: lec });
    const pct = await getRecentQuestionsPage({ limit: 50, offset: 0, search: '100%', lectureId: lec });
    const last = await getRecentQuestionsPage({ limit: 200, offset: 200, lectureId: lec });
    check('A11-2. recentQuestions: default 10, capped at 100; a page is capped at 200 with the full total; "%" in search is literal; hasMore is right',
      list.length === 10 && huge.length === 100 && page.items.length === 200 && page.total === 262 && page.hasMore
        && pct.total === 1 && pct.items[0].question === 'what is 100% accuracy?' && last.items.length === 62 && !last.hasMore,
      `default=${list.length} asked10000→${huge.length} page=${page.items.length}/${page.total} search"100%"→${pct.total} lastPage=${last.items.length} hasMore=${last.hasMore}`);
  }

  // ── A12: GraphQL limits and introspection ────────────────────────────
  {
    const schema = makeExecutableSchema({ typeDefs });
    const rule = queryLimitsRule({ maxDepth: env.GRAPHQL.MAX_DEPTH, maxFields: env.GRAPHQL.MAX_FIELDS });
    const errs = (q: string) => validate(schema, parse(q), [...specifiedRules, rule]).map(e => e.message);
    const wide = `query { ${Array.from({ length: env.GRAPHQL.MAX_FIELDS + 1 }, (_, i) => `f${i}: lectureStatusList { id }`).join(' ')} }`;
    const tooDeep = queryLimitsRule({ maxDepth: 2, maxFields: 1000 });
    // A real 3-level query (paginatedChatHistory → entries → sources) against a 2-level limit.
    const deepQ = `query { paginatedChatHistory(lectureId: 1, limit: 1, offset: 0) { entries { sources { id } } } }`;
    const fragQ = `fragment E on ChatHistoryEntry { sources { id } } query { paginatedChatHistory(lectureId: 1, limit: 1, offset: 0) { entries { ...E } } }`;
    const schemaOk = validate(schema, parse(deepQ)).length === 0 && validate(schema, parse(fragQ)).length === 0;
    const deepErrs = validate(schema, parse(deepQ), [tooDeep]).map(e => e.message);
    const fragDeepErrs = validate(schema, parse(fragQ), [tooDeep]).map(e => e.message);
    const wideErrs = errs(wide);

    // Every operation the frontend actually sends is valid against the schema AND inside the limits.
    const walkDir = (d: string): string[] => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walkDir(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
    const problems: string[] = []; let ops = 0;
    for (const file of walkDir(join(__dirname, '../../../frontend/src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/gql`([\s\S]*?)`/g)) {
        if (m[1].includes('${')) continue;
        ops++;
        for (const e of validate(schema, parse(m[1]), [...specifiedRules, rule])) problems.push(`${file.split('/frontend/')[1]}: ${e.message}`);
      }
    }
    check('A12-1. Query limits: too deep (also through a fragment) and too many fields are rejected; all frontend operations pass schema validation and the limits',
      schemaOk && deepErrs.some(m => /too deep/.test(m)) && fragDeepErrs.some(m => /too deep/.test(m)) && wideErrs.some(m => /too many fields/.test(m))
        && ops > 20 && problems.length === 0,
      `deep=${deepErrs[0]} viaFragment=${fragDeepErrs[0]} wide=${wideErrs.find(m => /too many/.test(m))} frontendOps=${ops} problems=${problems.slice(0, 3).join(' | ') || 'none'}`);

    const server = new ApolloServer({ typeDefs, resolvers: {}, introspection: false, validationRules: [rule] });
    await server.start();
    const intro = await server.executeOperation({ query: '{ __schema { types { name } } }' });
    await server.stop();
    const introErr = intro.body.kind === 'single' ? intro.body.singleResult.errors?.[0]?.message ?? '' : '';
    const probe = (extra: Record<string, string>) => {
      const e = { ...process.env, ...extra };
      if (!('GRAPHQL_INTROSPECTION' in extra)) delete e.GRAPHQL_INTROSPECTION;
      const r = spawnSync(join(__dirname, '../../node_modules/.bin/ts-node'), ['--transpile-only', '-e',
        "console.log('GI=' + JSON.stringify(require('./src/config/env').env.GRAPHQL.INTROSPECTION))"], { cwd: join(__dirname, '../..'), env: e, encoding: 'utf8' });
      return (r.stdout.split('\n').find(l => l.startsWith('GI=')) ?? 'GI=?').slice(3);
    };
    const prodI = probe({ NODE_ENV: 'production' });
    const devI = probe({ NODE_ENV: 'development' });
    check('A12-2. Introspection is off in production by default (on in development) and a __schema query is then refused',
      prodI === 'false' && devI === 'true' && /introspection/i.test(introErr), `production=${prodI} development=${devI} __schema→"${introErr.slice(0, 90)}"`);
  }

  // ── A15: dead NULL-version cached answers are deleted ────────────────
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[a15] memory', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('A15', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`a15-${Date.now()}@example.test`])).rows[0].id;
    const chunk = (await query<{ id: number }>(`INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, 'q', 'a', 'Question: q') RETURNING id`, [lec])).rows[0].id;
    const ver = (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, 'SUPERSEDED', 'MERGE', 'm', 'c', '{}'::jsonb) RETURNING id`, [lec])).rows[0].id;
    const ins = (v: number | null, nq: string) => query(
      `INSERT INTO rag_answer_memory (student_id, lecture_id, original_question, retrieval_query, normalized_query, question_embedding,
         answer, source_chunk_ids, embedding_model_version, answer_prompt_version, dataset_version_id)
       VALUES ($1, $2, 'q', 'q', $3, array_fill(0.1::real, ARRAY[1024])::vector, 'a', ARRAY[$4::int], 'm', 'p', $5)`, [stu, lec, nq, chunk, v]);
    await ins(null, 'dead row');
    await ins(ver, 'live row');
    await pool.query(readFileSync(join(__dirname, '../db/migrations/015_drop_unversioned_answer_memory.sql'), 'utf8'));
    const left = (await query<{ normalized_query: string }>('SELECT normalized_query FROM rag_answer_memory WHERE lecture_id = $1', [lec])).rows.map(r => r.normalized_query);
    check('A15-1. Migration 015 deletes cached answers with no dataset version (never servable, never purged) and keeps versioned ones',
      left.join() === 'live row', `remaining=${JSON.stringify(left)}`);
  }

  // ── A16: upload rejections are 413/400, never 500 ────────────────────
  {
    const admin = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('A16 Admin', $1, 'x', TRUE, 'ADMIN') RETURNING id`, [`a16-${Date.now()}@example.test`])).rows[0].id;
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[a16] upload', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const app = express();
    app.use(express.json());
    app.use('/datasets', datasetRoutes);
    app.post('/echo', (_req, res) => { res.json({ ok: true }); });
    app.use(errorHandler);
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${generateAccessToken(admin, 'ADMIN')}` };
    const upload = async (name: string, type: string, body: Buffer) => {
      const fd = new FormData();
      fd.append('file', new Blob([body], { type }), name);
      fd.append('dryRun', 'true');
      const r = await fetch(`${base}/datasets/upload/${lec}`, { method: 'POST', headers: auth, body: fd });
      return { status: r.status, message: ((await r.json().catch(() => ({}))) as { message?: string }).message ?? '' };
    };
    const XLSXMIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const big = await upload('big.xlsx', XLSXMIME, Buffer.alloc(env.DATASET.MAX_UPLOAD_BYTES + 1024, 1));
    const csvRenamed = await upload('data.xlsx', 'text/csv', Buffer.from('question,answer\nq,a\n'));
    const pdf = await upload('report.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    const notZip = await upload('fake.xlsx', XLSXMIME, Buffer.from('this is plain text pretending to be a workbook, long enough'));
    const good = await upload('ok.xlsx', 'application/octet-stream', workbook([['question', 'answer'], ['q', 'a']]));
    const badJson = await fetch(`${base}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"broken": ' });
    srv.close();
    check('A16-1. Too large → 413; a .csv/.pdf (even renamed .xlsx) → 400; a non-zip "xlsx" → 400; a real workbook as octet-stream → accepted; malformed JSON → 400 (all were 500 or parser errors)',
      big.status === 413 && /too large/.test(big.message) && csvRenamed.status === 400 && /Only \.xlsx/.test(csvRenamed.message)
        && pdf.status === 400 && notZip.status === 400 && /not a valid \.xlsx/.test(notZip.message) && good.status === 200 && badJson.status === 400,
      `big=${big.status} csvRenamed=${csvRenamed.status} pdf=${pdf.status} notZip=${notZip.status}("${notZip.message}") good=${good.status} badJson=${badJson.status}`);
    check('A16-2. xlsx is SheetJS 0.20.3 (fixes CVE-2023-30533 prototype pollution and CVE-2024-22363 ReDoS), pinned to the SheetJS CDN tarball',
      XLSX.version === '0.20.3' && /cdn\.sheetjs\.com\/xlsx-0\.20\.3/.test(JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).dependencies.xlsx),
      `xlsx=${XLSX.version}`);
  }

  // ── A18: unexpected errors are logged without their raw text ─────────
  {
    const SECRET = 'my phone is 0300-1234567 and my question is about loss functions';
    const captured: string[] = [];
    const orig = { error: logger.error, warn: logger.warn };
    const grab = (...a: unknown[]) => { captured.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); return logger; };
    (logger as unknown as { error: unknown }).error = grab;
    (logger as unknown as { warn: unknown }).warn = grab;
    const flags = env as unknown as { LOG_ERROR_DETAILS: boolean };
    const savedFlag = flags.LOG_ERROR_DETAILS;
    let restBody = ''; let restStatus = 0; let gqlMasked: { message: string; ext: string } | null = null; let gqlApp = '';
    try {
      flags.LOG_ERROR_DETAILS = false;
      const app = express();
      app.get('/boom', () => { throw new Error(`duplicate key value violates unique constraint: (question)=(${SECRET})`); });
      app.use(errorHandler);
      const srv = app.listen(0);
      const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/boom`);
      restStatus = r.status; restBody = await r.text();
      srv.close();
      const masked = formatGraphQLError({ message: `Unexpected: ${SECRET}`, extensions: { code: 'INTERNAL_SERVER_ERROR', stacktrace: ['x'] } }, new Error(SECRET));
      gqlMasked = { message: masked.message, ext: JSON.stringify(masked.extensions) };
      gqlApp = formatGraphQLError({ message: 'Lecture #9 not found', extensions: { code: 'INTERNAL_SERVER_ERROR' } }, new AppError('Lecture #9 not found', 404)).message;
      formatGraphQLError({ message: `Variable "$input" got invalid value { question: "${SECRET}" }`, extensions: { code: 'BAD_USER_INPUT' } }, undefined);
    } finally {
      (logger as unknown as { error: unknown }).error = orig.error;
      (logger as unknown as { warn: unknown }).warn = orig.warn;
      flags.LOG_ERROR_DETAILS = savedFlag;
    }
    const leaked = captured.filter(l => l.includes('0300-1234567'));
    check('A18-1. With LOG_ERROR_DETAILS off: REST 500 and GraphQL errors are logged with a code + content-safe message, never the raw text; clients get a generic message for unexpected errors, AppError messages are kept',
      restStatus === 500 && !restBody.includes('0300') && captured.some(l => /code=\w+ type=Error message=\[len=\d+ sha=/.test(l)) && leaked.length === 0
        && gqlMasked?.message === 'Internal server error' && !gqlMasked.ext.includes('stacktrace') && gqlApp === 'Lecture #9 not found',
      `logLines=${captured.length} leaked=${leaked.length} rest=${restStatus} gqlMasked="${gqlMasked?.message}" appErr="${gqlApp}" sample="${(captured[0] ?? '').slice(0, 110)}"`);
    const prodDetails = (() => {
      const r = spawnSync(join(__dirname, '../../node_modules/.bin/ts-node'), ['--transpile-only', '-e',
        "console.log('LD=' + JSON.stringify(require('./src/config/env').env.LOG_ERROR_DETAILS))"],
        { cwd: join(__dirname, '../..'), env: { ...process.env, NODE_ENV: 'production', LOG_ERROR_DETAILS: '' }, encoding: 'utf8' });
      return (r.stdout.split('\n').find(l => l.startsWith('LD=')) ?? 'LD=?').slice(3);
    })();
    check('A18-2. LOG_ERROR_DETAILS defaults to off in production', prodDetails === 'false', `production default=${prodDetails}`);
  }

  // ── A19: enrichment failure → stable, classified reason ──────────────
  {
    (env.OBSERVABILITY as unknown as { PHOENIX_BASE_URL: string }).PHOENIX_BASE_URL = 'http://127.0.0.1:1';
    const caps = { reachable: true, supportsSpanTraceIdFiltering: true, details: {} } as unknown as Parameters<typeof computeEnrichedOverviewMetrics>[1];
    const traces = [{ traceId: 'a'.repeat(32) }] as unknown as Parameters<typeof computeEnrichedOverviewMetrics>[0];
    const m = await computeEnrichedOverviewMetrics(traces, caps);
    const reason = m.memory.hits.unavailableReason ?? '';
    check('A19-1. Phoenix enrichment failure → unavailableReason is a classified, stable string (no raw error text, host or port)',
      /^Enrichment request failed \(PHOENIX_[A-Z_]+\): /.test(reason) && !/127\.0\.0\.1|ECONNREFUSED|fetch failed/i.test(reason),
      `reason="${reason}"`);
  }

  // ── A20: in-memory maps are bounded ──────────────────────────────────
  {
    const m = new ExpiringMap<number>(3, 0);
    m.set('a', 1, 1000, 0); m.set('b', 2, 1000, 0); m.set('c', 3, 10, 0);
    const expired = m.get('c', 50);
    m.set('d', 4, 1000, 60); m.set('e', 5, 1000, 60);
    const evicted = m.get('a', 60) === undefined && m.size === 3 && m.get('e', 60) === 5;
    rateLimitStore.clear(); overviewCache.clear();
    for (let i = 0; i < 12_000; i++) rateLimitStore.set(`login:10.0.${i >> 8}.${i & 255}`, { count: 1 }, 60_000);
    for (let i = 0; i < 150; i++) overviewCache.set(`{"filter":${i}}`, {} as never, 60_000);
    const sizes = `${rateLimitStore.size}/${overviewCache.size}`;
    rateLimitStore.clear(); overviewCache.clear();
    check('A20-1. ExpiringMap drops expired entries and evicts the oldest past its cap; the auth rate-limit store stays ≤ 10,000 and the overview cache ≤ 100',
      expired === undefined && evicted && sizes === '10000/100', `expiredGet=${expired} evictedOldest=${evicted} sizes(rateLimit/overview)=${sizes}`);
  }

  // ── AD1: authenticated REST traffic is limited per user, anonymous per IP ──
  {
    const app = express();
    app.use('/api/v1', globalLimiter, userLimiter, (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/datasets/versions/1`;
    const hit = async (auth?: string) => (await fetch(base, auth ? { headers: { Authorization: auth } } : {})).status;
    try {
      const admin = `Bearer ${generateAccessToken('00000000-0000-4000-8000-0000000000a1', 'ADMIN')}`;
      const authed: number[] = [];
      for (let i = 0; i < 200; i++) authed.push(await hit(admin));
      check('AD1-1. 200 authenticated GETs in one window (build polling + monitor refresh) are not throttled',
        authed.every(s => s === 200) && env.RATE_LIMIT.USER_MAX >= 200,
        `statuses=${[...new Set(authed)].join(',')} USER_MAX=${env.RATE_LIMIT.USER_MAX}`);

      // A garbage bearer is anonymous: it spends the per-IP bucket like no header at all.
      const anon: number[] = [];
      for (let i = 0; i < env.RATE_LIMIT.MAX; i++) anon.push(await hit(i % 2 ? 'Bearer not-a-real-token' : undefined));
      const overGarbage = await hit('Bearer not-a-real-token');
      const overNone = await hit();
      const stillAuthed = await hit(admin);
      check('AD1-2. Anonymous traffic is still throttled at RATE_LIMIT_MAX per IP; a garbage bearer token counts as anonymous',
        anon.every(s => s === 200) && overGarbage === 429 && overNone === 429,
        `first ${env.RATE_LIMIT.MAX} → ${[...new Set(anon)].join(',')}, then garbage=${overGarbage} none=${overNone}`);
      check('AD1-3. With the IP bucket exhausted, a signed-in operator (e.g. Cancel) still gets through on their own bucket',
        stillAuthed === 200, `authed after IP exhaustion=${stillAuthed}`);
    } finally {
      server.close();
      await globalLimiter.resetKey('127.0.0.1'); await globalLimiter.resetKey('::ffff:127.0.0.1');
      await userLimiter.resetKey('u:00000000-0000-4000-8000-0000000000a1');
    }
  }

  // ── AD2: request-log retention runs even with email alerts off ───────
  {
    const obs = env.OBSERVABILITY as { ALERTS_ENABLED: boolean };
    const saved = obs.ALERTS_ENABLED;
    const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    try {
      obs.ALERTS_ENABLED = false;
      stopMaintenanceScheduler();
      startMaintenanceScheduler();
      const off = maintenanceSchedulerState();
      startMaintenanceScheduler(); // double start is a no-op
      const again = maintenanceSchedulerState();
      stopMaintenanceScheduler();
      obs.ALERTS_ENABLED = true;
      startMaintenanceScheduler();
      const on = maintenanceSchedulerState();
      stopMaintenanceScheduler();
      const stopped = maintenanceSchedulerState();
      check('AD2-1. ALERTS_ENABLED=false: the retention timer is registered and the alert timer is not; with alerts on both are; server.ts starts it outside tests regardless of alerts',
        off.retention && !off.alerts && again.retention && !again.alerts && on.retention && on.alerts && !stopped.retention && !stopped.alerts
          && /if \(env\.NODE_ENV !== 'test'\) \{\s*startMaintenanceScheduler\(\);/.test(serverSrc),
        `off=${JSON.stringify(off)} on=${JSON.stringify(on)} stopped=${JSON.stringify(stopped)}`);
    } finally {
      stopMaintenanceScheduler();
      obs.ALERTS_ENABLED = saved;
    }
  }

  // ── AD3: a cancel that lands during the embedding pass keeps its reason ──
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[ad3] cancel', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const chunkIds: number[] = [];
    for (const q of ['q1', 'q2']) {
      chunkIds.push((await query<{ id: number }>(`INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, $2, 'a', $2) RETURNING id`, [lec, q])).rows[0].id);
    }
    const ver = (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, 'BUILDING', 'MERGE', 'm', 'c', '{"chunksToEmbed": 2}'::jsonb) RETURNING id`, [lec])).rows[0].id;
    for (const [i, c] of chunkIds.entries()) {
      await query('INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) VALUES ($1, $2, $3, 0)', [ver, c, `ad3-${i}`]);
    }
    const CANCEL = 'Cancelled by an admin.';
    let calls = 0;
    // The admin cancels while the last chunk is being embedded; the loop's
    // status re-check (every statusCheckMs) has not run since.
    const r = await finishDatasetVersion(ver, {
      embedBatchSize: 1, statusCheckMs: 60_000, maxAttempts: 1,
      embed: async () => {
        calls++;
        if (calls === 2) await query(`UPDATE dataset_versions SET status = 'FAILED', last_error = $2 WHERE id = $1`, [ver, CANCEL]);
        return new Array(1024).fill(0.01);
      },
    });
    const row = (await query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM dataset_versions WHERE id = $1', [ver])).rows[0];
    check('AD3-1. A cancel during the embedding pass: the post-embed step leaves status FAILED and last_error "Cancelled by an admin." unchanged',
      row.status === 'FAILED' && row.last_error === CANCEL && r.outcome !== 'ACTIVATED',
      `outcome=${r.outcome} status=${row.status} last_error=${JSON.stringify(row.last_error)} embedCalls=${calls}`);
  }

  // ── AD4: Content Gaps reads a bounded, windowed sample ───────────────
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id, status) VALUES ('[ad4] gaps', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx', 'READY') RETURNING id`)).rows[0].id;
    // A published dataset (Content Gaps skips a lecture without one, AD-N6).
    const ver = (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, 'ACTIVE', 'MERGE', 'm', 'c', '{}'::jsonb) RETURNING id`, [lec])).rows[0].id;
    const ch = (await query<{ id: number }>(`INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, 'What is tokenization?', 'a', 'q') RETURNING id`, [lec])).rows[0].id;
    await query(`INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) VALUES ($1, $2, 'ad4-1', 0)`, [ver, ch]);
    await query('UPDATE lectures SET active_version_id = $2 WHERE id = $1', [lec, ver]);
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('AD4', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`ad4-${Date.now()}@example.test`])).rows[0].id;
    await query(`INSERT INTO student_questions (student_id, lecture_id, question)
                 SELECT $1, $2, 'what is tokenization number ' || g FROM generate_series(1, 25000) g`, [stu, lec]);
    // Outside the 90-day window: never counted or analysed.
    await query(`INSERT INTO student_questions (student_id, lecture_id, question, created_at)
                 SELECT $1, $2, 'ancient question', NOW() - INTERVAL '100 days' FROM generate_series(1, 50)`, [stu, lec]);
    try {
      const t0 = Date.now();
      const gaps = await getContentGaps();
      const ms = Date.now() - t0;
      const mine = gaps.find(g => g.lectureId === lec);
      const processed = gaps.reduce((n, g) => n + g.answeredFromLecture + g.notInLecture, 0);
      check('AD4-1. 25,000 questions seeded: at most 20,000 are processed, sampled=true, windowDays=90, questionsAsked stays exact (old ones excluded)',
        !!mine && processed <= CONTENT_GAPS_MAX_QUESTIONS && mine.sampled === true && mine.windowDays === 90 && mine.questionsAsked === 25000,
        `processed=${processed} asked=${mine?.questionsAsked} sampled=${mine?.sampled} ms=${ms}`);
    } finally {
      await query('DELETE FROM student_questions WHERE lecture_id = $1', [lec]);
    }
  }

  // ── AD5: student stats rank by number, not by text ──────────────────
  {
    const mk = async (title: string) => (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ($1, 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`, [title])).rows[0].id;
    const ten = await mk('[ad5] ten questions');
    const nine = await mk('[ad5] nine questions');
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('AD5', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`ad5-${Date.now()}@example.test`])).rows[0].id;
    // Ten questions in one hour of the day, nine in another.
    await query(`INSERT INTO student_questions (student_id, lecture_id, question, created_at)
                 SELECT $1, $2, 'q' || g, date_trunc('day', NOW()) - INTERVAL '1 day' + INTERVAL '3 hours' FROM generate_series(1, 10) g`, [stu, ten]);
    await query(`INSERT INTO student_questions (student_id, lecture_id, question, created_at)
                 SELECT $1, $2, 'q' || g, date_trunc('day', NOW()) - INTERVAL '1 day' + INTERVAL '5 hours' FROM generate_series(1, 9) g`, [stu, nine]);
    const tenHour = Number((await query<{ h: string }>(`SELECT EXTRACT(HOUR FROM date_trunc('day', NOW()) - INTERVAL '1 day' + INTERVAL '3 hours')::text AS h`)).rows[0].h);
    const stats = await getMyStats(stu);
    check('AD5-1. A lecture with 10 questions ranks above one with 9 (most-asked topic, lecture breakdown, peak hour)',
      stats.mostAskedTopic === '[ad5] ten questions' && stats.lectureBreakdown[0]?.lectureId === ten
        && stats.lectureBreakdown[0]?.count === 10 && stats.peakHour === tenHour,
      `mostAsked=${stats.mostAskedTopic} breakdown=${stats.lectureBreakdown.map(b => b.count).join(',')} peakHour=${stats.peakHour} (want ${tenHour})`);
  }

  // ── AD6: admin lists are paged (limit clamped to 100, totals exact) ───
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[ad6] paging', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const ver = (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, 'ACTIVE', 'MERGE', 'm', 'c', '{}'::jsonb) RETURNING id`, [lec])).rows[0].id;
    await query(`WITH c AS (
                   INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text)
                   SELECT $1, 'question ' || g, CASE WHEN g = 77 THEN 'the needle_100% answer' ELSE 'answer ' || g END, 'q' || g
                   FROM generate_series(1, 120) g RETURNING id)
                 INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) SELECT $2, id, 'ad6-' || id, 0 FROM c`, [lec, ver]);
    await query('UPDATE lectures SET active_version_id = $2 WHERE id = $1', [lec, ver]);
    const pager = `AD6 Pager ${Date.now()}`; // unique per run: the suite may reuse a database
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ($2, $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`ad6-${Date.now()}@example.test`, pager])).rows[0].id;
    await query(`INSERT INTO student_questions (student_id, lecture_id, question, created_at)
                 SELECT $1, $2, 'journey q' || g, NOW() - g * INTERVAL '1 minute' FROM generate_series(1, 120) g`, [stu, lec]);

    const chunks = await getLectureChunks(lec, { limit: 1000, offset: 0 });
    const lastPage = await getLectureChunks(lec, { limit: 50, offset: 100 });
    const found = await getLectureChunks(lec, { search: 'needle_100%' });
    const literal = await getLectureChunks(lec, { search: '%' });
    const studentsTotal = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'STUDENT'`)).rows[0].n);
    const usersTotal = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM users`)).rows[0].n);
    const students = await getRegisteredStudents({ limit: 1000 });
    const oneStudent = await getRegisteredStudents({ search: pager, status: 'ACTIVE' });
    const users = await getAllUsers({ limit: 1000 });
    const journey = await getStudentJourney(stu, { limit: 1000 });
    check('AD6-1. lectureChunks/registeredStudents/allUsers/studentJourney: limit=1000 is clamped to 100 and total is exact',
      chunks.items.length === 100 && chunks.total === 120 && chunks.hasMore && lastPage.items.length === 20 && !lastPage.hasMore
        && students.items.length === Math.min(100, studentsTotal) && students.totalStudents === studentsTotal
        && users.items.length === Math.min(100, usersTotal) && users.totalUsers === usersTotal
        && journey.questions.length === 100 && journey.questionCount === 120 && journey.hasMoreQuestions
        && journey.byLecture.length === 1 && journey.byLecture[0].questionCount === 120,
      `chunks=${chunks.items.length}/${chunks.total} students=${students.items.length}/${students.total} users=${users.items.length}/${users.total} journey=${journey.questions.length}/${journey.questionCount}`);
    check('AD6-2. Search runs on the server (answers included, LIKE wildcards literal); a status filter narrows the total',
      found.total === 1 && found.items[0]?.answer === 'the needle_100% answer' && literal.total === 1
        && oneStudent.total === 1 && oneStudent.items[0]?.id === stu,
      `needle=${found.total} literal%=${literal.total} student=${oneStudent.total}`);
  }

  // ── S14: numeric settings fail fast at boot ───────────────────────────
  {
    const tsNode = join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
    const load = (overrides: Record<string, string>) => {
      const r = spawnSync(tsNode, ['--transpile-only', '-e',
        `const { env } = require('./src/config/env'); console.log('ENV:' + JSON.stringify({ chars: env.INPUT_GUARDRAIL.MAX_CHARS, iters: env.ADAPTIVE_RETRIEVAL.MAX_ITERATIONS, rate: env.OBSERVABILITY.SAMPLE_RATE }))`],
        { cwd: join(__dirname, '..', '..'), env: { ...process.env, INPUT_GUARDRAIL_MAX_CHARS: '', ADAPTIVE_RETRIEVAL_MAX_ITERATIONS: '', OBSERVABILITY_SAMPLE_RATE: '', ...overrides }, encoding: 'utf8' });
      const m = /ENV:(\{.*\})/.exec(r.stdout ?? '');
      return { status: r.status, err: r.stderr ?? '', val: m ? JSON.parse(m[1]) as { chars: number; iters: number; rate: number } : null };
    };
    const abc = load({ INPUT_GUARDRAIL_MAX_CHARS: 'abc' });
    const eightK = load({ INPUT_GUARDRAIL_MAX_CHARS: '8k' });
    const unset = load({});
    const zeroIters = load({ ADAPTIVE_RETRIEVAL_MAX_ITERATIONS: '0' });
    const badRate = load({ OBSERVABILITY_SAMPLE_RATE: 'half' });
    check('S14-1. INPUT_GUARDRAIL_MAX_CHARS=abc (or 8k) stops env load with a clear message; unset gives the default; 0 is allowed where it means "off"',
      abc.status !== 0 && /INPUT_GUARDRAIL_MAX_CHARS must be a positive integer \(got "abc"\)/.test(abc.err)
        && eightK.status !== 0 && /got "8k"/.test(eightK.err)
        && unset.status === 0 && unset.val?.chars === 8000 && unset.val?.iters === 1
        && zeroIters.status === 0 && zeroIters.val?.iters === 0
        && badRate.status !== 0 && /OBSERVABILITY_SAMPLE_RATE must be a number \(got "half"\)/.test(badRate.err),
      `abc=${abc.status} 8k=${eightK.status} unset=${JSON.stringify(unset.val)} iters0=${zeroIters.val?.iters} rate=${badRate.status}`);
  }

  // ── S16: the SSE heartbeat stops when the client goes away ───────────
  {
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('S16', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`s16-${Date.now()}@example.test`])).rows[0].id;
    const chat = env.CHAT as { RATE_LIMIT_PER_MINUTE: number; DAILY_QUESTION_LIMIT: number };
    const savedChat = { ...chat };
    chat.RATE_LIMIT_PER_MINUTE = 0; chat.DAILY_QUESTION_LIMIT = 0;
    const realSet = global.setInterval, realClear = global.clearInterval, realQuery = pool.query;
    let heartbeat: unknown = null;
    const clearedAt: number[] = [];
    let pipelineResumedAt = 0;
    (global as { setInterval: unknown }).setInterval = ((fn: () => void, ms?: number) => {
      const h = realSet(fn, ms); if (ms === 15000 && heartbeat === null) heartbeat = h; return h;
    }) as unknown;
    (global as { clearInterval: unknown }).clearInterval = ((h: NodeJS.Timeout) => { if (h === heartbeat) clearedAt.push(Date.now()); return realClear(h); }) as unknown;
    // A slow pipeline: the lecture lookup takes 1.5 s.
    (pool as unknown as { query: unknown }).query = async (text: string, params?: unknown[]) => {
      if (/^SELECT \* FROM lectures WHERE id = \$1/.test(text)) { await new Promise(r => setTimeout(r, 1500)); pipelineResumedAt = Date.now(); }
      return (realQuery as unknown as (t: string, p?: unknown[]) => Promise<unknown>).call(pool, text, params);
    };
    const app = express(); app.use(express.json()); app.use('/chat', chatRoutes);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', () => r()));
    try {
      const ac = new AbortController();
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/chat/ask-stream`, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${generateAccessToken(stu, 'STUDENT')}` },
        body: JSON.stringify({ lectureId: 999999, question: 'slow question?', sessionId: 1 }),
      });
      await new Promise(r => setTimeout(r, 300));
      ac.abort(); // the student closes the tab
      await new Promise(r => setTimeout(r, 2000)); // let the pipeline finish
      const first = clearedAt[0] ?? 0;
      check('S16-1. Client disconnects mid-answer → the heartbeat is cleared at once (before the slow pipeline finishes), not only in finally',
        res.status === 200 && heartbeat !== null && first > 0 && pipelineResumedAt > 0 && first < pipelineResumedAt && first - started < 1200,
        `stream=${res.status} clearedAfter=${first ? first - started : 'never'}ms pipelineResumedAfter=${pipelineResumedAt ? pipelineResumedAt - started : 'n/a'}ms clears=${clearedAt.length}`);
    } finally {
      srv.close();
      (global as { setInterval: unknown }).setInterval = realSet;
      (global as { clearInterval: unknown }).clearInterval = realClear;
      (pool as unknown as { query: unknown }).query = realQuery;
      Object.assign(chat, savedChat);
    }
  }

  // ── AD7: the S3 pointer is written only for an accepted build ────────
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const s3 = require('../services/s3-storage.service') as { isS3Configured: () => boolean; uploadRawDataset: (...a: unknown[]) => Promise<{ bucket: string; key: string }> };
    const realS3 = { cfg: s3.isS3Configured, up: s3.uploadRawDataset };
    const uploads: string[] = [];
    s3.isS3Configured = () => true;
    s3.uploadRawDataset = async (lectureId: unknown, _buf: unknown, name: unknown) => {
      const key = `raw/${String(lectureId)}/${Date.now()}-${String(name)}`; uploads.push(key); return { bucket: 'test-bucket', key };
    };
    const admin = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('AD7 Admin', $1, 'x', TRUE, 'ADMIN') RETURNING id`, [`ad7-${Date.now()}@example.test`])).rows[0].id;
    const mkLecture = async (t: string) => (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ($1, 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`, [t])).rows[0].id;
    const busy = await mkLecture('[ad7] build in flight');
    const free = await mkLecture('[ad7] free');
    // Another update is already building for `busy`: a new build is refused with 409.
    await query(`INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
                 VALUES ($1, 1, 'BUILDING', 'MERGE', 'm', 'c', '{}'::jsonb)`, [busy]);
    const app = express(); app.use(express.json()); app.use('/datasets', datasetRoutes); app.use(errorHandler);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const post = async (lec: number) => {
      const fd = new FormData();
      fd.append('file', new Blob([workbook([['question', 'answer'], ['What is AD7?', 'A pointer test.']])], { type: 'application/octet-stream' }), 'ad7.xlsx');
      const r = await fetch(`${base}/datasets/upload/${lec}`, { method: 'POST', headers: { Authorization: `Bearer ${generateAccessToken(admin, 'ADMIN')}` }, body: fd });
      return r.status;
    };
    const keyOf = async (lec: number) => (await query<{ k: string | null }>('SELECT dataset_s3_key AS k FROM lectures WHERE id = $1', [lec])).rows[0].k;
    try {
      const refused = await post(busy);
      const refusedKey = await keyOf(busy);
      const accepted = await post(free);
      const acceptedKey = await keyOf(free);
      // Stop the background build of the accepted upload (no embedding server here).
      await query(`UPDATE dataset_versions SET status = 'FAILED', last_error = 'test' WHERE lecture_id = $1 AND status = 'BUILDING'`, [free]);
      check('AD7-1. A 409 build (another update in flight) leaves dataset_s3_key unchanged although the raw file was archived; an accepted build records it',
        refused === 409 && refusedKey === null && uploads.length === 2 && accepted === 200 && acceptedKey === uploads[1],
        `refused=${refused} key=${refusedKey} accepted=${accepted} key=${acceptedKey} archived=${uploads.length}`);
    } finally {
      srv.close();
      s3.isS3Configured = realS3.cfg; s3.uploadRawDataset = realS3.up;
    }
  }

  // ── AD8: RETENTION_DAYS=0 can never wipe the request log ─────────────
  {
    const tsNode = join(__dirname, '..', '..', 'node_modules', '.bin', 'ts-node');
    const boot = (v: string) => spawnSync(tsNode, ['--transpile-only', '-e', `require('./src/config/env'); console.log('ENV_OK')`],
      { cwd: join(__dirname, '..', '..'), env: { ...process.env, OBSERVABILITY_RETENTION_DAYS: v }, encoding: 'utf8' });
    const zero = boot('0');
    const word = boot('ninety');
    // Even if 0 reached runRetention some other way, the floor keeps today's rows.
    const obs = env.OBSERVABILITY as { RETENTION_DAYS: number };
    const saved = obs.RETENTION_DAYS;
    const traceId = Date.now().toString(16).padStart(32, 'a');
    await query(`INSERT INTO rag_request_log (trace_id, status, response_status, total_ms) VALUES ($1, 'SUCCESS', 'ANSWERED', 5)`, [traceId]);
    let kept = -1;
    try {
      obs.RETENTION_DAYS = 0;
      await runRetention();
      kept = Number((await query<{ n: string }>(`SELECT COUNT(*) AS n FROM rag_request_log WHERE created_at > NOW() - INTERVAL '1 hour'`)).rows[0].n);
    } finally {
      obs.RETENTION_DAYS = saved;
      await query('DELETE FROM rag_request_log WHERE trace_id = $1', [traceId]);
    }
    check('AD8-1. OBSERVABILITY_RETENTION_DAYS=0 (or a non-number) stops boot; with 0 forced in, retention still keeps recent rows (floor of 1 day)',
      zero.status !== 0 && /OBSERVABILITY_RETENTION_DAYS must be a positive integer \(got "0"\)/.test(zero.stderr ?? '')
        && word.status !== 0 && /got "ninety"/.test(word.stderr ?? '') && kept > 0,
      `zero=${zero.status} word=${word.status} recentRowsKept=${kept}`);
  }

  // ── AD9: rollback validates inside its own transaction ───────────────
  {
    const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[ad9] rollback', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const mkVersion = async (no: number, status: string) => (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, $2, $3, 'MERGE', $4, 'c', '{}'::jsonb) RETURNING id`, [lec, no, status, EMBEDDING_MODEL_VERSION])).rows[0].id;
    const previous = await mkVersion(1, 'SUPERSEDED');
    const current = await mkVersion(2, 'ACTIVE');
    // Two embedded chunks per version, each with its own (distinct) vector.
    for (const [v, base] of [[previous, 1], [current, 3]] as const) {
      for (let i = 0; i < 2; i++) {
        const vec = `[${Array.from({ length: 1024 }, (_, j) => (j === base + i ? 1 : 0.001 * ((j * (base + i)) % 7))).join(',')}]`;
        const c = (await query<{ id: number }>(
          `INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text, local_embedding, embedding_model_version)
           VALUES ($1, $2, 'a', $2, $3::vector, $4) RETURNING id`, [lec, `ad9 q${base}-${i}`, vec, EMBEDDING_MODEL_VERSION])).rows[0].id;
        await query('INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) VALUES ($1, $2, $3, 0)', [v, c, `ad9-${v}-${i}`]);
      }
    }
    await query(`UPDATE lectures SET active_version_id = $1, status = 'READY' WHERE id = $2`, [current, lec]);
    // While rolling back, the module query helper (a second pool connection) is off limits.
    const realQuery = pool.query;
    let poolQueries = 0;
    (pool as unknown as { query: unknown }).query = async () => { poolQueries++; throw new Error('pool.query used during rollback'); };
    let result: { activeVersionId: number } | Error;
    try {
      result = await rollbackDataset(lec).catch(e => e as Error);
    } finally {
      (pool as unknown as { query: unknown }).query = realQuery;
    }
    const after = (await query<{ active_version_id: number }>('SELECT active_version_id FROM lectures WHERE id = $1', [lec])).rows[0];
    check('AD9-1. Rollback validates the target inside its own transaction (no second pool connection) and still switches the pointer',
      !(result instanceof Error) && result.activeVersionId === previous && after.active_version_id === previous && poolQueries === 0,
      `result=${result instanceof Error ? result.message : result.activeVersionId} active=${after.active_version_id} poolQueries=${poolQueries}`);
  }

  // ── AD10: readiness never claims an unprobed answer LLM is healthy ───
  {
    const rag = env.LLM.RAG_ANSWER as { PROVIDER: string };
    const saved = rag.PROVIDER;
    try {
      rag.PROVIDER = 'groq';
      const direct = await checkAnswerLlm();
      const r = await checkReadiness();
      check('AD10-1. RAG_LLM_PROVIDER=groq: readiness is not healthy and answerLlm.errorCode = UNVERIFIED_PROVIDER (it used to probe no LLM at all)',
        direct.status === 'degraded' && direct.errorCode === 'UNVERIFIED_PROVIDER'
          && r.status !== 'healthy' && r.components.answerLlm.errorCode === 'UNVERIFIED_PROVIDER' && !('gemini' in r.components),
        `direct=${JSON.stringify(direct)} overall=${r.status} answerLlm=${JSON.stringify(r.components.answerLlm)}`);
    } finally {
      rag.PROVIDER = saved;
    }
  }

  // ── AD11: an unknown student is a 404 with its own message ──────────
  {
    const server = new ApolloServer({
      typeDefs, resolvers: { Query: analyticsResolvers.Query } as never,
      formatError: (err, original) => formatGraphQLError(err, original),
    });
    await server.start();
    const res = await server.executeOperation(
      { query: 'query($id: String!) { studentJourney(id: $id) { studentId } }', variables: { id: '00000000-0000-4000-8000-00000000dead' } },
      { contextValue: { req: { user: { id: 'admin', email: 'admin@example.test', role: 'ADMIN' } } } as never }
    );
    await server.stop();
    const errs = res.body.kind === 'single' ? res.body.singleResult.errors ?? [] : [];
    const direct = await getStudentJourney('00000000-0000-4000-8000-00000000dead').catch(e => e as AppError);
    check('AD11-1. studentJourney for an unknown id → "Student not found" (AppError 404), not "Internal server error"',
      errs[0]?.message === 'Student not found' && direct instanceof AppError && direct.statusCode === 404,
      `graphql="${errs[0]?.message}" status=${(direct as AppError).statusCode}`);
  }

  // ── AD-N1: one lock order (lecture, then version) — Cancel/activate never deadlock with cleanup ──
  {
    // One in-flight version per lecture, so each race gets its own lecture.
    const mkLecture = async () => (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[adn1] locks', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const mkVersion = async (lec: number, status: string) => (await query<{ id: number }>(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, $2, 'MERGE', $3, 'c', '{}'::jsonb) RETURNING id`, [lec, status, EMBEDDING_MODEL_VERSION])).rows[0].id;
    const cancelLec = await mkLecture();
    const activateLec = await mkLecture();
    const building = await mkVersion(cancelLec, 'BUILDING');
    const ready = await mkVersion(activateLec, 'READY_TO_ACTIVATE');
    for (let i = 0; i < 2; i++) {
      const vec = `[${Array.from({ length: 1024 }, (_, j) => (j === 7 + i ? 1 : 0.001 * ((j * (7 + i)) % 7))).join(',')}]`;
      const c = (await query<{ id: number }>(
        `INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text, local_embedding, embedding_model_version)
         VALUES ($1, $2, 'a', $2, $3::vector, $4) RETURNING id`, [activateLec, `adn1 q${i}`, vec, EMBEDDING_MODEL_VERSION])).rows[0].id;
      await query('INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) VALUES ($1, $2, $3, 0)', [ready, c, `adn1-${i}`]);
    }

    // A second connection takes cleanupOldVersions' order — the lecture, then
    // a version row — while `work` runs. With the old order (version, then
    // lecture) `work` held the version and waited for the lecture: a deadlock.
    const raceAgainstCleanupOrder = async <T>(lec: number, versionId: number, work: () => Promise<T>) => {
      const other = await pool.connect();
      let lockError: string | null = null;
      try {
        await other.query('BEGIN');
        await other.query("SET LOCAL lock_timeout = '5s'");
        await other.query('SELECT id FROM lectures WHERE id = $1 FOR UPDATE', [lec]);
        const pending = work().catch(e => e as Error);
        // Wait until `work` is blocked behind our lecture lock.
        for (let i = 0; i < 100; i++) {
          const { rows } = await other.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
          if (rows[0].n > 0) break;
          await new Promise(r => setTimeout(r, 20));
        }
        await other.query('SELECT id FROM dataset_versions WHERE id = $1 FOR UPDATE', [versionId]).catch(e => { lockError = (e as { code?: string }).code ?? (e as Error).message; });
        await other.query(lockError ? 'ROLLBACK' : 'COMMIT');
        return { result: await pending, lockError };
      } finally {
        other.release();
      }
    };

    const cancel = await raceAgainstCleanupOrder(cancelLec, building, () => failDatasetVersion(building, 'Cancelled by an admin.'));
    const activate = await raceAgainstCleanupOrder(activateLec, ready, () => finishDatasetVersion(ready));
    const row = (await query<{ status: string; active_version_id: number | null }>(
      'SELECT v.status, l.active_version_id FROM dataset_versions v JOIN lectures l ON l.id = v.lecture_id WHERE v.id = $1', [ready])).rows[0];
    const outcome = (r: unknown) => (r instanceof Error ? `error ${(r as { code?: string }).code ?? r.message}` : (r as { outcome: string }).outcome);
    check('AD-N1-1. Cancel (failVersion) and activation run while another transaction holds the lecture and then locks the version: no deadlock (40P01), both finish',
      cancel.lockError === null && outcome(cancel.result) === 'FAILED'
        && activate.lockError === null && outcome(activate.result) === 'ACTIVATED' && row.status === 'ACTIVE' && row.active_version_id === ready,
      `cancel=${outcome(cancel.result)} (other side: ${cancel.lockError ?? 'ok'}), activate=${outcome(activate.result)} (other side: ${activate.lockError ?? 'ok'}), status=${row.status}`);
  }

  // ── AD-N2: upload caps sized to real data, so a parse can't stall chat for seconds ──
  {
    const lim = env.DATASET as { MAX_ROWS: number; MAX_COLUMNS: number; MAX_UNCOMPRESSED_BYTES: number };
    const unset = ['DATASET_MAX_ROWS', 'DATASET_MAX_COLUMNS', 'DATASET_MAX_UNCOMPRESSED_MB'].every(k => process.env[k] === undefined);
    const header = ['question', 'answer', 'topic', 'llm_name', 'start_time', ...Array.from({ length: lim.MAX_COLUMNS - 5 }, (_, i) => `extra_${i}`)];
    const rows = Array.from({ length: lim.MAX_ROWS }, (_, r) => header.map(h => `${h} for row ${r}: a typical sentence of lecture text`));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Final_Dataset');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
    const t0 = Date.now();
    const parsed = parseExcel(buf);
    const ms = Date.now() - t0;
    check('AD-N2-1. Default caps are 1,000 rows / 20 columns / 5 MB uncompressed (were 5,000 / 100 / 50); a workbook at those limits parses in well under 1 s',
      (!unset || (lim.MAX_ROWS === 1000 && lim.MAX_COLUMNS === 20 && lim.MAX_UNCOMPRESSED_BYTES === 5 * 1024 * 1024))
        && parsed.length === lim.MAX_ROWS && ms < 1000,
      `envUnset=${unset} rows=${lim.MAX_ROWS} cols=${lim.MAX_COLUMNS} uncompressedMB=${lim.MAX_UNCOMPRESSED_BYTES / 1048576} file=${Math.round(buf.length / 1024)} KB parse=${ms} ms`);
  }

  // ── AD-N3: a first upload stuck in a processing status is repaired ────
  {
    const mkLecture = async (status: string) => (await query<{ id: number }>(
      `INSERT INTO lectures (title, youtube_url, youtube_video_id, status) VALUES ('[adn3] stuck', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx', $1) RETURNING id`, [status])).rows[0].id;
    const addBuilding = (lec: number, run: (sql: string, p: unknown[]) => Promise<unknown>) => run(
      `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
       VALUES ($1, 1, 'BUILDING', 'MERGE', 'm', 'c', '{}'::jsonb)`, [lec]);
    const stuck = await mkLecture('EMBEDDING');
    const legacy = await mkLecture('PROCESSING');
    const running = await mkLecture('EMBEDDING');
    await addBuilding(running, (sql, p) => query(sql, p));
    // A re-upload commits its new build while reconcile waits for this lecture's lock.
    const racing = await mkLecture('EMBEDDING');
    const other = await pool.connect();
    let repaired: number[] = [];
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM lectures WHERE id = $1 FOR UPDATE', [racing]);
      const pending = reconcileLectureStatuses();
      for (let i = 0; i < 100; i++) {
        const { rows } = await other.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
        if (rows[0].n > 0) break;
        await new Promise(r => setTimeout(r, 20));
      }
      await addBuilding(racing, (sql, p) => other.query(sql, p));
      await other.query('COMMIT');
      repaired = await pending;
    } finally {
      other.release();
    }
    const statusOfLecture = async (id: number) => (await query<{ status: string }>('SELECT status FROM lectures WHERE id = $1', [id])).rows[0].status;
    const st = { stuck: await statusOfLecture(stuck), legacy: await statusOfLecture(legacy), running: await statusOfLecture(running), racing: await statusOfLecture(racing) };
    check('AD-N3-1. No live dataset + EMBEDDING/PROCESSING + nothing in flight → FAILED (upload unblocked); a running build, or one committed while reconcile waited for the lock, is left alone',
      st.stuck === 'FAILED' && st.legacy === 'FAILED' && st.running === 'EMBEDDING' && st.racing === 'EMBEDDING'
        && repaired.includes(stuck) && repaired.includes(legacy) && !repaired.includes(running) && !repaired.includes(racing),
      `${JSON.stringify(st)} repaired⊇stuck,legacy=${repaired.includes(stuck) && repaired.includes(legacy)}`);
  }

  // ── AD-N4/AD-N5: upload reports the real version status; a server fault is a 500 ──
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const s3 = require('../services/s3-storage.service') as { isS3Configured: () => boolean; uploadRawDataset: (...a: unknown[]) => Promise<{ bucket: string; key: string }> };
    const realS3 = { cfg: s3.isS3Configured, up: s3.uploadRawDataset };
    const RAW = 'getaddrinfo ENOTFOUND askai-raw.s3.internal while archiving';
    let s3Fails = false;
    s3.isS3Configured = () => true;
    s3.uploadRawDataset = async () => { if (s3Fails) throw new Error(RAW); return { bucket: 'test-bucket', key: 'raw/adn4.xlsx' }; };
    const admin = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('ADN4 Admin', $1, 'x', TRUE, 'ADMIN') RETURNING id`, [`adn4-${Date.now()}@example.test`])).rows[0].id;
    const mkLecture = async () => (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id) VALUES ('[adn4] upload', 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx') RETURNING id`)).rows[0].id;
    const app = express(); app.use(express.json()); app.use('/datasets', datasetRoutes); app.use(errorHandler);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const post = async (lec: number) => {
      const fd = new FormData();
      fd.append('file', new Blob([workbook([['question', 'answer'], ['What is ADN4?', 'A status test.']])], { type: 'application/octet-stream' }), 'adn4.xlsx');
      const r = await fetch(`${base}/datasets/upload/${lec}`, { method: 'POST', headers: { Authorization: `Bearer ${generateAccessToken(admin, 'ADMIN')}` }, body: fd });
      return { status: r.status, body: await r.json().catch(() => ({})) as { message?: string; data?: Record<string, unknown> } };
    };
    const errorLines: string[] = [];
    const realError = logger.error.bind(logger);
    (logger as { error: unknown }).error = (msg: unknown, ...rest: unknown[]) => { errorLines.push(String(msg)); return realError(msg as string, ...rest as []); };
    try {
      const okLec = await mkLecture();
      const ok = await post(okLec);
      // Stop the background build of the accepted upload (no embedding server here).
      await query(`UPDATE dataset_versions SET status = 'FAILED', last_error = 'test' WHERE lecture_id = $1 AND status = 'BUILDING'`, [okLec]);
      s3Fails = true;
      const broken = await post(await mkLecture());
      check('AD-N4-1. An accepted upload reports versionStatus BUILDING, not the "PROCESSING" lecture status nothing writes any more',
        ok.status === 200 && ok.body.data?.versionStatus === 'BUILDING' && !('status' in (ok.body.data ?? {})),
        `status=${ok.status} data=${JSON.stringify(ok.body.data ? { versionStatus: ok.body.data.versionStatus, status: ok.body.data.status } : null)}`);
      check('AD-N5-1. A server fault during upload (S3 archive error) → 500 "Internal server error" via the shared handler, not a 400 carrying the raw driver text',
        broken.status === 500 && broken.body.message === 'Internal server error' && !String(broken.body.message).includes('ENOTFOUND')
          && !errorLines.some(l => l.startsWith('[UPLOAD]') && l.includes('ENOTFOUND')) && errorLines.some(l => l.startsWith('[ERROR] 500 POST')),
        `status=${broken.status} message=${JSON.stringify(broken.body.message)} logged=${JSON.stringify(errorLines.filter(l => /UPLOAD|ERROR\] 500/.test(l)).map(l => l.slice(0, 60)))}`);
    } finally {
      (logger as { error: unknown }).error = realError;
      srv.close();
      s3.isS3Configured = realS3.cfg; s3.uploadRawDataset = realS3.up;
    }
  }

  // ── AD-N6/AD-N7: Content Gaps vocabulary per lecture; lectureChunks counts Q&A pairs ──
  {
    const stu = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('ADN6', $1, 'x', TRUE, 'STUDENT') RETURNING id`, [`adn6-${Date.now()}@example.test`])).rows[0].id;
    // pieces[i] = how many pieces Q&A i is stored as.
    const mkLecture = async (word: string, pieces: number[] | null) => {
      const lec = (await query<{ id: number }>(`INSERT INTO lectures (title, youtube_url, youtube_video_id, status) VALUES ($1, 'https://youtu.be/xxxxxxxxxxx', 'xxxxxxxxxxx', 'READY') RETURNING id`, [`[adn6] ${word}`])).rows[0].id;
      await query(`INSERT INTO student_questions (student_id, lecture_id, question) VALUES ($1, $2, $3)`, [stu, lec, `what is ${word}zz?`]);
      if (!pieces) return lec; // legacy READY lecture with no published dataset
      const ver = (await query<{ id: number }>(
        `INSERT INTO dataset_versions (lecture_id, version_no, status, mode, embedding_model_version, chunking_config_version, stats)
         VALUES ($1, 1, 'ACTIVE', 'MERGE', 'm', 'c', '{}'::jsonb) RETURNING id`, [lec])).rows[0].id;
      for (const [i, n] of pieces.entries()) {
        for (let p = 0; p < n; p++) {
          const c = (await query<{ id: number }>(`INSERT INTO lecture_qna_chunks (lecture_id, question, answer, chunk_text) VALUES ($1, $2, 'full answer', $3) RETURNING id`,
            [lec, `${word}zz question ${i}`, `piece ${p}`])).rows[0].id;
          await query(`INSERT INTO dataset_version_chunks (version_id, chunk_id, qa_id, chunk_index) VALUES ($1, $2, $3, $4)`, [ver, c, `${word}-${i}`, p]);
        }
      }
      await query('UPDATE lectures SET active_version_id = $2 WHERE id = $1', [lec, ver]);
      return lec;
    };
    const big = await mkLecture('alpha', Array.from({ length: 12 }, () => 1));
    const small = await mkLecture('bravo', [1, 3]);          // 2 Q&As, the second in 3 pieces
    const legacy = await mkLecture('charlie', null);
    try {
      const gaps = await getContentGaps({ maxChunksPerLecture: 5 });
      const g = (id: number) => gaps.find(x => x.lectureId === id);
      const page = await getLectureChunks(small, { limit: 50 });
      check('AD-N6-1. Content Gaps: each lecture gets its own vocabulary share (chunksSampled only where the cap cut it), and a READY lecture with no published dataset is left out instead of scored 0%',
        g(big)?.chunksSampled === true && g(small)?.chunksSampled === false && g(small)?.coverageScore === 100 && g(small)?.chunkCount === 4
          && g(legacy) === undefined,
        `big=${JSON.stringify({ s: g(big)?.chunksSampled, cov: g(big)?.coverageScore })} small=${JSON.stringify({ s: g(small)?.chunksSampled, cov: g(small)?.coverageScore, chunks: g(small)?.chunkCount })} legacyListed=${g(legacy) !== undefined}`);
      check('AD-N7-1. lectureChunks lists and counts each Q&A pair once (a 3-piece answer is one row), with its full answer',
        page.total === 2 && page.items.length === 2 && page.items.every(i => i.answer === 'full answer'),
        `total=${page.total} items=${page.items.length}`);
    } finally {
      await query('DELETE FROM student_questions WHERE lecture_id = ANY($1::int[])', [[big, small, legacy]]);
    }
  }

  // ── AD-N8: real answer-call failures make readiness say the answer LLM is down ──
  {
    const rag = env.LLM.RAG_ANSWER as { PROVIDER: string };
    const saved = rag.PROVIDER;
    rag.PROVIDER = 'groq';
    const provider = resolveLlmProvider('groq') as { generate: (...a: unknown[]) => Promise<unknown> };
    const realGenerate = provider.generate;
    resetProviderSignals();
    try {
      provider.generate = async () => { throw new Error('Request timeout after 30000ms'); };
      const answers = [];
      for (let i = 0; i < 2; i++) answers.push(await generateAnswer('What is a prompt?', [], 'Lecture', []).catch(e => e as Error));
      const down = await checkAnswerLlm();
      const ready = await checkReadiness();
      provider.generate = async (req: unknown) => ({ raw: 'ok', provider: 'groq', model: (req as { model: string }).model, finishReason: 'STOP' });
      await generateAnswer('What is a prompt?', [], 'Lecture', []);
      const healed = await checkAnswerLlm();
      // (Overall readiness is unhealthy here anyway — no local embedding server — so the component is what is checked.)
      check('AD-N8-1. RAG_LLM_PROVIDER=groq: two timed-out answer calls → answerLlm unhealthy (TIMEOUT) in /health/ready (a required component → 503); one success → back to degraded/UNVERIFIED_PROVIDER',
        answers.every(a => a instanceof Error) && down.status === 'unhealthy' && down.errorCode === 'TIMEOUT'
          && ready.components.answerLlm.status === 'unhealthy' && ready.status === 'unhealthy'
          && healed.status === 'degraded' && healed.errorCode === 'UNVERIFIED_PROVIDER',
        `down=${JSON.stringify(down)} readiness.answerLlm=${JSON.stringify(ready.components.answerLlm)} healed=${JSON.stringify(healed)}`);
    } finally {
      provider.generate = realGenerate;
      rag.PROVIDER = saved;
      resetProviderSignals();
    }
  }

  // ── R5: readiness recovers as soon as the answer LLM does ───────────
  {
    const rag = env.LLM.RAG_ANSWER as { PROVIDER: string };
    const health = env.HEALTH as { CACHE_TTL_MS: number };
    const saved = { provider: rag.PROVIDER, ttl: health.CACHE_TTL_MS };
    rag.PROVIDER = 'groq';
    health.CACHE_TTL_MS = 60_000;
    const provider = resolveLlmProvider('groq') as { generate: (...a: unknown[]) => Promise<unknown> };
    const realGenerate = provider.generate;
    const realSetTimeout = globalThis.setTimeout;
    resetProviderSignals();
    resetHealthCache();
    try {
      provider.generate = async () => { throw new Error('Request timeout after 30000ms'); };
      for (let i = 0; i < 2; i++) await generateAnswer('What is a prompt?', [], 'Lecture', []).catch(() => undefined);
      const down = await checkReadiness();          // fills the 60 s cache while the signal says down
      provider.generate = async (req: unknown) => ({ raw: 'ok', provider: 'groq', model: (req as { model: string }).model, finishReason: 'STOP' });
      await generateAnswer('What is a prompt?', [], 'Lecture', []);
      const after = await checkReadiness();         // same 60 s window, cached probe
      check('R5-1. Two failed answer calls → readiness caches answerLlm; one success → the very next readiness (inside the same 60 s TTL) reports it recovered, not unhealthy until the TTL ends',
        down.components.answerLlm.status === 'unhealthy' && after.components.answerLlm.status === 'degraded'
          && after.components.answerLlm.errorCode === 'UNVERIFIED_PROVIDER',
        `down=${JSON.stringify(down.components.answerLlm)} after=${JSON.stringify(after.components.answerLlm)}`);

      // One question whose call is retried three times on 503 is ONE failure, not four.
      resetProviderSignals();
      let attempts = 0;
      provider.generate = async () => { attempts++; throw new Error('503 Service Unavailable: high demand'); };
      (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown;
      await generateAnswer('What is a prompt?', [], 'Lecture', []).catch(() => undefined);
      const oneQuestion = await checkAnswerLlm();
      await generateAnswer('What is a prompt?', [], 'Lecture', []).catch(() => undefined);
      const twoQuestions = await checkAnswerLlm();
      check('R5-2. A question retried on 503 (4 attempts) counts as one failure: answerLlm stays degraded after one such question, unhealthy after two',
        attempts === 8 && oneQuestion.status === 'degraded' && twoQuestions.status === 'unhealthy' && twoQuestions.errorCode === 'SERVICE_UNAVAILABLE',
        `attempts=${attempts} one=${JSON.stringify(oneQuestion)} two=${JSON.stringify(twoQuestions)}`);
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
      provider.generate = realGenerate;
      rag.PROVIDER = saved.provider;
      health.CACHE_TTL_MS = saved.ttl;
      resetProviderSignals();
      resetHealthCache();
    }
  }

  // ── R5b: a failed probe is re-checked within seconds ────────────────
  {
    const health = env.HEALTH as { CACHE_TTL_MS: number };
    const savedTtl = health.CACHE_TTL_MS;
    const db = require('../config/database') as { query: (...a: unknown[]) => Promise<unknown> };
    const realDbQuery = db.query;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    health.CACHE_TTL_MS = 60_000;
    resetHealthCache();
    try {
      db.query = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); };
      const failed = (await checkReadiness()).components.database.status;
      db.query = realDbQuery;
      clock += UNHEALTHY_CACHE_TTL_MS - 1000;
      const stillCached = (await checkReadiness()).components.database.status;
      clock += 2000;
      const recovered = (await checkReadiness()).components.database.status;
      db.query = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); };
      clock += 10_000;
      const healthyCached = (await checkReadiness()).components.database.status;
      check('R5-3. A failed probe is re-checked after UNHEALTHY_CACHE_TTL_MS (5 s), not the 60 s TTL; a passing one keeps the full TTL',
        failed === 'unhealthy' && stillCached === 'unhealthy' && recovered === 'healthy' && healthyCached === 'healthy',
        `failed=${failed} at+4s=${stillCached} at+6s=${recovered} healthy+10s=${healthyCached}`);
    } finally {
      db.query = realDbQuery;
      Date.now = realNow;
      health.CACHE_TTL_MS = savedTtl;
      resetHealthCache();
    }
  }

  // ── X1/X2: trace-list query params reach the service as their real types ──
  {
    // Only the service the route calls is stubbed; the route, its validators and auth are real.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracesSvc = require('../services/observability/traces.service') as { listTraces: (f: Record<string, unknown>) => Promise<unknown> };
    const original = tracesSvc.listTraces;
    const seen: Record<string, unknown>[] = [];
    tracesSvc.listTraces = async f => { seen.push(f); return { traces: [], nextCursor: null, appliedFilters: {} }; };
    const admin = (await query<{ id: string }>(`INSERT INTO users (name, email, password_hash, is_verified, role) VALUES ('X1 Admin', $1, 'x', TRUE, 'ADMIN') RETURNING id`, [`x1-${Date.now()}@example.test`])).rows[0].id;
    const app = express();
    app.use('/obs', observabilityRoutes);
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const get = (qs: string) => fetch(`${base}/obs/traces?${qs}`, { headers: { Authorization: `Bearer ${generateAccessToken(admin, 'ADMIN')}` } }).then(r => r.status);
    try {
      const statuses = [
        await get('errorOnly=true&startTime=2026-10-01T00:00:00Z&endTime=2026-10-02T00:00:00Z'),
        await get('errorOnly=false'),
        await get('limit=5'),
      ];
      check('X1-1. GET /traces?errorOnly=true hands errorOnly=true to listTraces (it was always false, so the Errors page listed successful traces); false/absent stay false',
        statuses.every(s => s === 200) && seen[0]?.errorOnly === true && seen[1]?.errorOnly === false && seen[2]?.errorOnly === false,
        `statuses=${statuses.join(',')} errorOnly=${seen.map(f => f.errorOnly).join(',')}`);
      check('X2-1. startTime/endTime reach listTraces as the ISO strings they are typed as (they were Date objects)',
        seen[0]?.startTime === '2026-10-01T00:00:00Z' && seen[0]?.endTime === '2026-10-02T00:00:00Z',
        `startTime=${Object.prototype.toString.call(seen[0]?.startTime)} ${String(seen[0]?.startTime)}`);
    } finally {
      tracesSvc.listTraces = original;
      srv.close();
    }
  }

  // ── X3/X4: monitor labels cover what the backend actually records ──────
  {
    // Loaded at runtime: it lives in the frontend package, outside the backend's tsc project.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const labels = require(join(__dirname, '../../../frontend/src/lib/monitor-labels')) as {
      STAGE_LABELS: Record<string, string>; VERIFIER_REASON_LABELS: Record<string, string>; ATTENTION_VERIFIER_LABELS: Record<string, string>;
      attentionDetailLabels: (row: Record<string, string | null>) => string[];
    };
    const stageNames = Object.entries(STAGE_SPAN_KIND).filter(([, kind]) => kind !== OpenInferenceSpanKind.LLM).map(([name]) => name);
    const missingStages = stageNames.filter(n => !Object.prototype.hasOwnProperty.call(labels.STAGE_LABELS, n));
    const sorted = (xs: readonly string[]) => [...xs].sort().join(',');
    const verifierKeysOk = sorted(Object.keys(labels.VERIFIER_REASON_LABELS)) === sorted(OUTPUT_GUARDRAIL_REASONS);
    const attentionKeysOk = sorted(Object.keys(labels.ATTENTION_VERIFIER_LABELS)) === sorted(OUTPUT_GUARDRAIL_REASONS.filter(r => r !== 'VERIFIED'));
    const outage = labels.attentionDetailLabels({ responseStatus: 'ERROR', errorCode: null, answerVerificationReason: 'VERIFIER_TIMEOUT' });
    const wrong = labels.attentionDetailLabels({ responseStatus: 'ANSWERED', errorCode: null, answerVerificationReason: 'UNSUPPORTED_CLAIMS' });
    check('X3-1. Every non-LLM span name in STAGE_SPAN_KIND has a "Slowest pipeline steps" label (subquery-retrieval, adaptive-retrieval-iteration were "Other step")',
      missingStages.length === 0, `missing=[${missingStages.join(', ')}]`);
    check('X4-1. Verifier label maps are keyed by OUTPUT_GUARDRAIL_REASONS; a verifier timeout reads as an outage, not as a wrong answer or "Check result unknown"',
      verifierKeysOk && attentionKeysOk && outage.some(l => /outage/.test(l)) && !wrong.some(l => /outage|unknown/i.test(l))
        && !outage.includes('Check result unknown'),
      `verifierKeys=${verifierKeysOk} attentionKeys=${attentionKeysOk} outage=${JSON.stringify(outage)} wrong=${JSON.stringify(wrong)}`);
  }

};

(async () => {
  try {
    await run();
  } catch (err) {
    console.error('Test run crashed:', err);
    results.push({ name: 'run completed', pass: false, detail: (err as Error).message });
  }
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  await pool.end();
  process.exit(failed.length ? 1 : 0);
})();
