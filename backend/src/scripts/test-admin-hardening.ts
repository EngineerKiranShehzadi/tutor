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
import { checkProviderHealth, overallStatus, requiredComponents, ComponentHealth } from '../observability/health.service';
import { recordProviderFailure, recordProviderSuccess, resetProviderSignals } from '../observability/provider-signal';
import { EmbeddingUnavailableError } from '../embedding/embedding-errors';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { parse, validate, specifiedRules } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { ApolloServer } from '@apollo/server';
import { applyMigrations } from './db-setup';
import { getRecentQuestions, getRecentQuestionsPage } from '../services/analytics.service';
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
import { startMaintenanceScheduler, stopMaintenanceScheduler, maintenanceSchedulerState } from '../observability/maintenance.scheduler';
import { finishDatasetVersion } from '../services/dataset-version.service';

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
    const all = (over: Partial<Record<'database' | 'pgvector' | 'embeddingServer' | 'reranker' | 'gemini', ComponentHealth>>) =>
      ({ database: h('healthy'), pgvector: h('healthy'), embeddingServer: h('healthy'), reranker: h('healthy'), gemini: h('healthy'), ...over });
    const reqG = requiredComponents('gemini');
    const reqOther = requiredComponents('groq');
    const geminiDown = overallStatus(all({ gemini: h('unhealthy') }), reqG);
    const geminiDownOther = overallStatus(all({ gemini: h('unhealthy') }), reqOther);
    const rerankDown = overallStatus(all({ reranker: h('unhealthy') }), reqG);
    const unverified = overallStatus(all({ gemini: h('degraded') }), reqG);
    check('A6-1. A dead answer model (Gemini) or reranker → unhealthy (503); unverified (config-only) → degraded (200); Gemini not required when another provider answers',
      reqG.join() === 'database,pgvector,embeddingServer,reranker,gemini' && !reqOther.includes('gemini')
        && geminiDown === 'unhealthy' && rerankDown === 'unhealthy' && unverified === 'degraded' && geminiDownOther === 'degraded',
      `required=${reqG.join()} geminiDown=${geminiDown} rerankDown=${rerankDown} unverified=${unverified} geminiDown(groq answers)=${geminiDownOther}`);

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
