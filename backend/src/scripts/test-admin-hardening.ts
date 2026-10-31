/**
 * Admin/production hardening, batch 2 (A4, A5, A6):
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
