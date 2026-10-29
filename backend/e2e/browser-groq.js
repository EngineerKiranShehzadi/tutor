/**
 * Browser end-to-end with a REAL model (Groq openai/gpt-oss-120b) for answer generation AND the groundedness verifier.
 *   E2E_LLM=groq ./e2e/up.sh && node e2e/browser-groq.js && ./e2e/down.sh
 * Free-tier aware: ~6 model calls in total, limiter + token budget active in the backend. Screenshots -> $E2E_OUT/shots-groq.
 */
const fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/kiran-shehzadi/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const XLSX = require(path.join(__dirname, '../node_modules/xlsx'));

const OUT = process.env.E2E_OUT || '/tmp/askai-e2e';
const SHOTS = path.join(OUT, 'shots-groq'); fs.mkdirSync(SHOTS, { recursive: true });
const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'ctx.json'), 'utf8'));
const LOG = path.join(OUT, 'logs/backend.log');
const FE = 'http://localhost:3055', L = ctx.lectureId;
const PSQL = (sql) => execSync(`PGPASSWORD=test psql -h localhost -p 55432 -U postgres askai_e2e_test -tAc ${JSON.stringify(sql)}`).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const logText = () => fs.readFileSync(LOG, 'utf8');
const count = (re) => (logText().match(re) || []).length;
const results = []; let n = 0;
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };
const shot = (page, label) => page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${label}.png`) });
const activeNo = () => PSQL(`select v.version_no from lectures l join dataset_versions v on v.id=l.active_version_id where l.id=${L}`);

async function newPage(browser, token) {
  const c = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  await c.addInitScript((t) => { try { localStorage.setItem('accessToken', t); localStorage.setItem('askaitutor_avatar_visible', 'false'); } catch (e) {} }, token);
  return c.newPage();
}
// A chat turn is finished when the backend logs its completion line for it (answer saved / memory hit served / rejected).
const DONE = /\[CHAT\] ✅ (Answer saved|Answer-memory)|\[CHAT\] 🛡️|Greeting answered/g;
async function ask(page, q) {
  const doneBefore = count(DONE), groqBefore = count(/\[GROQ\] rate-limit headroom/g);
  await page.getByPlaceholder('Ask about this lecture…').fill(q);
  await page.getByLabel('Send message').click();
  for (let i = 0; i < 240 && count(DONE) === doneBefore; i++) await sleep(1000);
  await sleep(2500);                                    // let the stream finish rendering
  // Source of truth = the answer the backend persisted for this turn; the UI must be showing that same text.
  const saved = PSQL(`select answer from chat_history where lecture_id=${L} order by id desc limit 1`);
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const onScreen = norm(await page.evaluate(() => document.body.innerText)).includes(norm(saved).slice(0, 40));
  const after = (onScreen ? '' : '[NOT ON SCREEN] ') + norm(saved);
  return { answer: after.slice(0, 500), groqCalls: count(/\[GROQ\] rate-limit headroom/g) - groqBefore };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const admin = await newPage(browser, ctx.adminToken);
  const ds = path.join(OUT, 'groq-dataset-v1.xlsx');
  execSync(`node ${path.join(__dirname, 'make-dataset.js')} ${ds}`);
  await admin.goto(`${FE}/admin/lectures/${L}`, { waitUntil: 'domcontentloaded' });
  await admin.getByTestId('dataset-manager').waitFor({ timeout: 90000 });
  await admin.getByTestId('dataset-file-input').setInputFiles(ds);
  await admin.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  await admin.getByTestId('dataset-apply').click();
  await admin.getByText('AI Ready', { exact: false }).first().waitFor({ timeout: 120000 });
  await admin.getByTestId('version-row-1').waitFor();
  check('1. Admin uploads the dataset in the UI → v1 live (real embeddings)', activeNo() === '1', `active=v${activeNo()}`);

  const sp = await newPage(browser, ctx.studentToken);
  await sp.goto(`${FE}/lecture/${L}`, { waitUntil: 'domcontentloaded' });
  await sp.getByPlaceholder('Ask about this lecture…').waitFor({ timeout: 60000 });
  const Q1 = 'What is zero-shot prompting?';

  const a1 = await ask(sp, Q1);
  await shot(sp, 'real-answer-v1');
  const gen1 = count(/ANSWER_VERIFICATION/g), ans1 = count(/GROUNDED_ANSWER/g);
  const mem1 = PSQL('select count(*) from rag_answer_memory');
  check('2. Real model answers from the lecture; the real verifier ran and VERIFIED it (a memory entry is written only for a verified answer)',
    /example/i.test(a1.answer) && !/could not find/i.test(a1.answer) && a1.groqCalls >= 2 && gen1 >= 1 && ans1 >= 1 && mem1 === '1',
    `groq calls for this question=${a1.groqCalls} (answer calls logged=${ans1}, verifier calls logged=${gen1}); cached rows=${mem1}; answer="${a1.answer.slice(0, 170)}…"`);

  const callsBefore = count(/\[GROQ\] rate-limit headroom/g);
  const a1b = await ask(sp, Q1);
  check('3. Same question again → served from the version-bound cache with ZERO model calls', a1b.groqCalls === 0 && count(/Answer-memory EXACT hit|memoryExactHit/g) >= 1 && /example/i.test(a1b.answer),
    `model calls=${a1b.groqCalls} (total still ${callsBefore}), exact cache hits logged=${count(/memoryExactHit/g)}`);

  const a2 = await ask(sp, 'What is the capital of France?');
  await shot(sp, 'real-answer-out-of-scope');
  check('4. Out-of-lecture question → real model refuses ("could not find…"), nothing is cached', /could not find/i.test(a2.answer) && !/paris/i.test(a2.answer) && PSQL('select count(*) from rag_answer_memory') === '1',
    `answer="${a2.answer.slice(0, 120)}" cachedRows=${PSQL('select count(*) from rag_answer_memory')}`);

  // edit via export → merge → publish
  const [dl] = await Promise.all([admin.waitForEvent('download'), admin.getByTestId('dataset-export').click()]);
  const ex = path.join(OUT, 'groq-export-v1.xlsx'); await dl.saveAs(ex);
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(ex).Sheets['dataset']);
  rows[0].answer = "Zero-shot prompting means giving the model only an instruction and no examples; this course also calls it 'cold start prompting'.";
  const f2 = path.join(OUT, 'groq-dataset-v2.xlsx');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Dataset'); XLSX.writeFile(wb, f2);
  await admin.getByTestId('dataset-file-input').setInputFiles(f2);
  await admin.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  await admin.getByTestId('dataset-apply').click();
  for (let i = 0; i < 90 && activeNo() !== '2'; i++) await sleep(1000);
  await admin.getByTestId('live-version-badge').filter({ hasText: 'version 2' }).waitFor({ timeout: 30000 });
  await shot(admin, 'admin-v2-live');

  const a3 = await ask(sp, Q1);
  await shot(sp, 'real-answer-v2');
  check('5. After publish the real model answers from the CORRECTED v2 content (the cached v1 answer is not used)',
    /cold start/i.test(a3.answer) && a3.groqCalls >= 2 && PSQL(`select string_agg(distinct 'v'||v.version_no, ',' order by 'v'||v.version_no) from rag_answer_memory m join dataset_versions v on v.id=m.dataset_version_id`) === 'v1,v2',
    `groq calls=${a3.groqCalls}; cache versions=${PSQL(`select string_agg(distinct 'v'||v.version_no, ',') from rag_answer_memory m join dataset_versions v on v.id=m.dataset_version_id`)}; answer="${a3.answer.slice(0, 170)}…"`);

  await admin.reload({ waitUntil: 'domcontentloaded' });
  await admin.getByTestId('rollback-btn').click();
  await admin.getByTestId('rollback-confirm').click();
  await admin.getByTestId('live-version-badge').filter({ hasText: 'version 1' }).waitFor({ timeout: 30000 });
  const a4 = await ask(sp, Q1);
  await shot(sp, 'real-answer-after-rollback');
  check('6. After rollback the v1 cache is valid again: v1 content, no model call, no v2 text', !/cold start/i.test(a4.answer) && a4.groqCalls === 0 && /example/i.test(a4.answer), `model calls=${a4.groqCalls}; answer="${a4.answer.slice(0, 130)}…"`);

  const hist = PSQL(`select count(*) from chat_history ch where lecture_id=${L} and array_length(source_chunk_ids,1)>0 and (select count(*) from lecture_qna_chunks c where c.id=any(ch.source_chunk_ids)) = array_length(ch.source_chunk_ids,1)`);
  const histAll = PSQL(`select count(*) from chat_history where lecture_id=${L} and array_length(source_chunk_ids,1)>0`);
  check('7. Every earlier answer in the history still has all its source chunks', hist === histAll && Number(histAll) >= 3, `history entries with sources=${histAll}, all resolvable=${hist}`);

  const total = count(/\[GROQ\] rate-limit headroom/g);
  const lastHeadroom = (logText().match(/\[GROQ\] rate-limit headroom: .*/g) || []).slice(-1)[0] || '';
  check('8. Free-tier discipline: no 429, no budget error, small footprint', count(/\[GROQ\] 429/g) === 0 && count(/budget exhausted/g) === 0 && total <= 12, `total Groq calls=${total}, 429s=${count(/\[GROQ\] 429/g)}, last headroom line: ${lastHeadroom.replace(/^.*\[GROQ\] /, '')}`);

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results-groq.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} real-model browser checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('crashed:', e); process.exit(2); });
