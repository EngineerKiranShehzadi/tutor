/**
 * Browser end-to-end run for the versioned dataset pipeline (real Chromium, real frontend, real backend,
 * real embedding model; Gemini replaced by the deterministic stub in src/scripts/e2e-server.ts).
 *
 *   ./e2e/up.sh && node e2e/browser-e2e.js && ./e2e/down.sh
 *
 * Writes screenshots to $E2E_OUT/shots and a machine-readable results file to $E2E_OUT/results.json.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/kiran-shehzadi/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const XLSX = require(path.join(__dirname, '../node_modules/xlsx'));

const OUT = process.env.E2E_OUT || '/tmp/askai-e2e';
const SHOTS = path.join(OUT, 'shots');
const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'ctx.json'), 'utf8'));
const FE = 'http://localhost:3055';
const API = 'http://localhost:5055/api/v1';
const PSQL = (sql) => execSync(`PGPASSWORD=test psql -h localhost -p 55432 -U postgres askai_e2e_test -tAc ${JSON.stringify(sql)}`).toString().trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
let shotNo = 0;
const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n        ${detail}`); };
const shot = async (page, label) => { const f = `${String(++shotNo).padStart(2, '0')}-${label}.png`; await page.screenshot({ path: path.join(SHOTS, f), fullPage: false }); return f; };

const L = ctx.lectureId;
const setProxyDelay = (ms) => execSync(`curl -s "localhost:5101/__delay?ms=${ms}"`);
const setLlmDelay = (ms) => fs.writeFileSync(path.join(OUT, 'llm_delay'), String(ms));
const activeVersionNo = () => PSQL(`select v.version_no from lectures l join dataset_versions v on v.id=l.active_version_id where l.id=${L}`);
const versionStatuses = () => PSQL(`select string_agg('v'||version_no||':'||status, ' ' order by version_no) from dataset_versions where lecture_id=${L}`);

async function newPage(browser, token, viewport = { width: 1400, height: 1000 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.addInitScript((t) => { try { localStorage.setItem('accessToken', t); localStorage.setItem('askaitutor_avatar_visible', 'false'); } catch (e) {} }, token);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('   [pageerror]', e.message.slice(0, 160)));
  return { context, page };
}

// Student chat helpers -------------------------------------------------------------------------
async function openStudentLecture(page) {
  await page.goto(`${FE}/lecture/${L}`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Ask about this lecture…').waitFor({ timeout: 60000 });
}
const MARKERS = "(document.body.innerText.match(/According to the lecture:|I could not find this information|having trouble|AI model failed/gi) || []).length";
async function ask(page, q, { expectIn = 90000 } = {}) {
  const before = await page.evaluate(`(() => ${MARKERS})()`);
  const box = page.getByPlaceholder('Ask about this lecture…');
  await box.fill(q);
  await page.getByLabel('Send message').click();
  // a NEW answer (or an error/not-found message) must appear — never match text from an earlier turn
  await page.waitForFunction(({ n, src }) => eval(src) > n, { n: before, src: MARKERS }, { timeout: expectIn });
  await sleep(1200);
}
const lastAnswerText = async (page) => {
  const txt = await page.evaluate(() => document.body.innerText);
  const idx = txt.lastIndexOf('According to the lecture:');
  return idx === -1 ? '' : txt.slice(idx, idx + 400).split('\n')[0];
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const admin = await newPage(browser, ctx.adminToken);
  const adminPage = admin.page;
  const lectureUrl = `${FE}/admin/lectures/${L}`;

  // ───────────────────────── 1. Admin: first upload through the UI ─────────────────────────
  const v1file = path.join(OUT, 'dataset-v1.xlsx');
  execSync(`node ${path.join(__dirname, 'make-dataset.js')} ${v1file}`);
  await adminPage.goto(lectureUrl, { waitUntil: 'domcontentloaded' });
  await adminPage.getByTestId('dataset-manager').waitFor({ timeout: 90000 });
  await shot(adminPage, 'admin-empty-lecture');
  await adminPage.getByTestId('dataset-file-input').setInputFiles(v1file);
  await adminPage.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  const mergeDefault = await adminPage.getByTestId('dataset-mode-merge').isChecked();
  const addedTxt = await adminPage.getByTestId('preview-added').innerText();
  await shot(adminPage, 'admin-first-upload-preview');
  check('1a. Default mode is Merge; first-upload preview lists all 12 rows as Added',
    mergeDefault && /^12\b/.test(addedTxt.trim()), `mergeChecked=${mergeDefault} addedTile="${addedTxt.replace(/\n/g, ' ')}"`);
  await adminPage.getByTestId('dataset-apply').click();
  // wait for lecture READY (status banner) — real embedding of 12 chunks
  await adminPage.getByText('AI Ready', { exact: false }).first().waitFor({ timeout: 120000 });
  await adminPage.getByTestId('version-row-1').waitFor({ timeout: 30000 });
  await sleep(1200);
  await shot(adminPage, 'admin-v1-live');
  const v1status = await adminPage.getByTestId('version-row-1').getAttribute('data-status');
  check('1b. After upload the lecture is AI Ready and v1 shows as Live in the versions list',
    v1status === 'ACTIVE' && PSQL(`select status from lectures where id=${L}`) === 'READY', `v1 row status=${v1status}, DB lecture status=${PSQL(`select status from lectures where id=${L}`)}, embedded=${PSQL(`select count(*) from dataset_version_chunks d join lecture_qna_chunks c on c.id=d.chunk_id where c.local_embedding is not null`)}/12`);

  // ───────────────────────── 2. Student asks → answer + sources; same question → cache ─────────────────────────
  const student = await newPage(browser, ctx.studentToken);
  const sp = student.page;
  await openStudentLecture(sp);
  const Q1 = 'What is zero-shot prompting?';
  await ask(sp, Q1);
  const a1 = await lastAnswerText(sp);
  const chips = await sp.locator('text=/00:0\\d:\\d\\d/').count();
  await shot(sp, 'student-answer-v1');
  const memRows1 = PSQL(`select count(*) from rag_answer_memory`);
  check('2a. Student gets a grounded answer from v1 with lecture-timestamp source chips, and it is cached',
    /no examples/.test(a1) && chips > 0 && memRows1 === '1', `answer="${a1.slice(0, 110)}…" sourceChips=${chips} memoryRows=${memRows1} (memory version=v${PSQL('select v.version_no from rag_answer_memory m join dataset_versions v on v.id=m.dataset_version_id')})`);
  // history ids that must stay resolvable
  const histIds = PSQL(`select string_agg(array_to_string(source_chunk_ids, ','), ',') from chat_history where lecture_id=${L}`).split(',').filter(Boolean).map(Number);

  // ───────────────────────── 3. Export with qa_id → edit → re-upload (Merge) ─────────────────────────
  const [download] = await Promise.all([adminPage.waitForEvent('download'), adminPage.getByTestId('dataset-export').click()]);
  const exported = path.join(OUT, 'export-v1.xlsx');
  await download.saveAs(exported);
  const wb = XLSX.readFile(exported);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const hasQa = rows.length === 12 && rows.every(r => /^qa_[0-9a-f]{12}$/.test(r.qa_id));
  check('3a. Export downloads the live dataset with a permanent qa_id on every Q&A', hasQa, `rows=${rows.length}, columns=${Object.keys(rows[0]).join(',')}, firstQaId=${rows[0].qa_id}`);

  const edited = rows.map(r => ({ ...r }));
  const qaZero = edited[0].qa_id;
  edited[0].answer = 'Zero-shot prompting means giving the model only an instruction with absolutely no examples (EDITED v2).';
  edited[0].question = 'What is zero-shot prompting (revised wording)?';   // question text changed — allowed because qa_id is kept
  edited.push({ qa_id: undefined, topic: undefined, question: 'What is temperature zero?', answer: 'Temperature zero makes the model pick the most likely token every time, so output is nearly deterministic.', start_time: '00:16:00', end_time: '00:16:40', keywords: 'temperature' });
  const v2rows = edited.filter((_, i) => i !== 10 && i !== 11);   // drop two rows from the file (they must be KEPT in Merge)
  const v2file = path.join(OUT, 'dataset-v2-edited.xlsx');
  const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(v2rows), 'Dataset'); XLSX.writeFile(wb2, v2file);

  // make embedding slow + generation slow so the in-flight window is observable
  setProxyDelay(3500);
  await adminPage.getByTestId('dataset-choose-file').waitFor();
  await adminPage.getByTestId('dataset-file-input').setInputFiles(v2file);
  await adminPage.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  const tiles = {};
  for (const k of ['added', 'updated', 'unchanged', 'kept']) tiles[k] = (await adminPage.getByTestId(`preview-${k}`).innerText()).split('\n')[0].trim();
  await shot(adminPage, 'admin-merge-preview');
  check('3b. Merge preview: edited Q&A (found by qa_id) = 1 updated, new row = 1 added, the 2 rows missing from the file are KEPT, nothing removed',
    tiles.added === '1' && tiles.updated === '1' && tiles.unchanged === '9' && tiles.kept === '2', `tiles=${JSON.stringify(tiles)}`);
  await adminPage.getByTestId('dataset-apply').click();
  await adminPage.getByTestId('dataset-progress').waitFor({ timeout: 30000 });
  await sleep(1500);
  const progressTxt = await adminPage.getByTestId('dataset-progress').innerText();
  await shot(adminPage, 'admin-v2-building-progress');
  check('3c. While v2 builds, the page shows progress and says the previous version is still live',
    /Building version 2/.test(progressTxt) && /still live/i.test(progressTxt), `progress card: "${progressTxt.replace(/\n+/g, ' | ').slice(0, 180)}"`);

  // ───────────────────────── 4. DURING the update: students still get the OLD dataset ─────────────────────────
  const activeDuring = activeVersionNo();
  const student2 = await newPage(browser, ctx.student2Token);
  await openStudentLecture(student2.page);
  await ask(student2.page, 'What is zero-shot prompting?');     // student 2: no cache → fresh retrieval during the build
  const duringAnswer = await lastAnswerText(student2.page);
  await shot(student2.page, 'student2-answer-during-update');
  check('4. During the v2 build the old dataset keeps serving: live version is still v1 and a fresh question returns the v1 answer',
    activeDuring === '1' && /no examples/.test(duringAnswer) && !/EDITED/.test(duringAnswer), `active=v${activeDuring}, answer="${duringAnswer.slice(0, 100)}…"`);

  // wait for publish
  for (let i = 0; i < 60 && activeVersionNo() !== '2'; i++) await sleep(1000);
  setProxyDelay(0);
  await adminPage.getByTestId('live-version-badge').filter({ hasText: 'version 2' }).waitFor({ timeout: 30000 });
  await sleep(800);
  await shot(adminPage, 'admin-v2-live');
  check('5a. v2 is published automatically once embedded + validated (versions: ' + versionStatuses() + ')', activeVersionNo() === '2', `active=v${activeVersionNo()}`);

  // ───────────────────────── 5. After publish: old cached answer must NOT come back ─────────────────────────
  await ask(sp, 'What is zero-shot prompting?');       // student 1 asked the same text under v1 (cached)
  const afterPublish = await lastAnswerText(sp);
  await shot(sp, 'student-answer-after-publish');
  // the revised question wording no longer exists as "What is zero-shot prompting?" — retrieval still finds the qa via embedding
  check('5b. After publish the previously cached v1 answer is NOT returned; the student gets the corrected v2 content',
    /EDITED v2/.test(afterPublish), `answer="${afterPublish.slice(0, 120)}…" memory rows now: ${PSQL(`select string_agg('v'||v.version_no||':hits='||m.hit_count, ' ') from rag_answer_memory m join dataset_versions v on v.id=m.dataset_version_id`)}`);

  // ───────────────────────── 6. History source links stay valid ─────────────────────────
  const stillThere = histIds.length > 0 && histIds.every(id => PSQL(`select count(*) from lecture_qna_chunks where id=${id}`) === '1');
  await sp.reload({ waitUntil: 'domcontentloaded' });
  await sp.getByPlaceholder('Ask about this lecture…').waitFor({ timeout: 60000 });
  // open the earlier conversation from the sidebar and look for its timestamp chip
  const histBtn = sp.locator('text=What is zero-shot prompting?').first();
  if (await histBtn.count()) await histBtn.click().catch(() => {});
  await sleep(1500);
  await shot(sp, 'student-history-with-sources');
  const srcCheck = PSQL(`select count(*) from chat_history ch, lateral (select count(*) n from lecture_qna_chunks c where c.id = any(ch.source_chunk_ids)) x where ch.lecture_id=${L} and x.n = array_length(ch.source_chunk_ids,1)`);
  const totalHist = PSQL(`select count(*) from chat_history where lecture_id=${L} and array_length(source_chunk_ids,1) > 0`);
  check('6. Chat-history source links stay valid after the update (every source chunk of every earlier answer still exists)',
    stillThere && srcCheck === totalHist && Number(totalHist) >= 2, `historyEntriesWithSources=${totalHist}, entriesWhoseSourcesAllResolve=${srcCheck}, v1 chunk ids still present=${stillThere}`);

  // ───────────────────────── 7. Rollback with confirmation ─────────────────────────
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  await adminPage.getByTestId('rollback-btn').waitFor({ timeout: 60000 });
  await adminPage.getByTestId('rollback-btn').click();
  await adminPage.getByTestId('rollback-dialog').waitFor();
  await shot(adminPage, 'admin-rollback-confirm');
  const dlg = await adminPage.getByTestId('rollback-dialog').innerText();
  // cancel first: nothing may change
  await adminPage.getByTestId('rollback-cancel').click();
  const afterCancel = activeVersionNo();
  await adminPage.getByTestId('rollback-btn').click();
  await adminPage.getByTestId('rollback-confirm').click();
  await adminPage.getByTestId('live-version-badge').filter({ hasText: 'version 1' }).waitFor({ timeout: 30000 });
  await sleep(1000);
  await shot(adminPage, 'admin-rolled-back-to-v1');
  check('7a. Rollback needs confirmation (Cancel changes nothing), then v1 is live again',
    /Roll back to version 1/.test(dlg) && afterCancel === '2' && activeVersionNo() === '1', `dialog mentions v1=${/version 1/.test(dlg)}, active after Cancel=v${afterCancel}, active after Confirm=v${activeVersionNo()}, versions: ${versionStatuses()}`);
  await ask(sp, 'What is zero-shot prompting?');
  const afterRb = await lastAnswerText(sp);
  await shot(sp, 'student-answer-after-rollback');
  check('7b. After rollback students get v1 content again, and not the v2 text (cache is version-bound)',
    /no examples/.test(afterRb) && !/EDITED/.test(afterRb), `answer="${afterRb.slice(0, 110)}…"`);
  // roll forward again for the next scenarios
  await adminPage.getByTestId('rollback-btn').click();
  await adminPage.getByTestId('rollback-confirm').click();
  await adminPage.getByTestId('live-version-badge').filter({ hasText: 'version 2' }).waitFor({ timeout: 30000 });

  // ───────────────────────── 8. Replace: preview + explicit confirmation ─────────────────────────
  const cur = XLSX.utils.sheet_to_json(XLSX.readFile(await (async () => { const [d] = await Promise.all([adminPage.waitForEvent('download'), adminPage.getByTestId('dataset-export').click()]); const f = path.join(OUT, 'export-v2.xlsx'); await d.saveAs(f); return f; })()).Sheets['dataset']);
  const small = cur.slice(0, 8);
  const smallFile = path.join(OUT, 'dataset-v3-replace-8rows.xlsx');
  const wb3 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb3, XLSX.utils.json_to_sheet(small), 'Dataset'); XLSX.writeFile(wb3, smallFile);
  await adminPage.getByTestId('dataset-mode-replace').check({ force: true });
  await adminPage.getByTestId('dataset-file-input').setInputFiles(smallFile);
  await adminPage.getByTestId('dataset-removal-warning').waitFor({ timeout: 30000 });
  const removedTile = (await adminPage.getByTestId('preview-removed').innerText()).split('\n')[0].trim();
  const applyDisabledBefore = await adminPage.getByTestId('dataset-apply').isDisabled();
  await shot(adminPage, 'admin-replace-preview-needs-confirmation');
  await adminPage.getByTestId('dataset-confirm-removal').check();
  const applyDisabledAfter = await adminPage.getByTestId('dataset-apply').isDisabled();
  check('8. Replace shows how many Q&As will be removed (' + removedTile + '); Apply is disabled until the explicit confirmation is ticked',
    removedTile === '5' && applyDisabledBefore === true && applyDisabledAfter === false, `removedTile=${removedTile} (13 live Q&As − 8 in file), applyDisabledBefore=${applyDisabledBefore}, afterTick=${applyDisabledAfter}`);
  await adminPage.getByTestId('dataset-cancel').click();                 // do not actually replace the dataset in this run
  await adminPage.getByTestId('dataset-mode-merge').check({ force: true });

  // ───────────────────────── 9. Embedding outage → automatic resume, no backend restart ─────────────────────────
  const backendPidBefore = fs.readFileSync(path.join(OUT, 'backend.pid'), 'utf8').trim();
  const proxyPid = fs.readFileSync(path.join(OUT, 'proxy.pid'), 'utf8').trim();
  process.kill(Number(proxyPid), 'SIGKILL');                              // embedding service "goes down"
  await sleep(500);
  const outRows = XLSX.utils.sheet_to_json(XLSX.readFile(path.join(OUT, 'export-v2.xlsx')).Sheets['dataset']).map(r => ({ ...r }));
  const cotIdx = outRows.findIndex(r => /chain-of-thought/i.test(r.question));
  outRows[cotIdx].answer = outRows[cotIdx].answer + ' (EDITED v3 during outage)';
  const outFile = path.join(OUT, 'dataset-v3-outage.xlsx');
  const wb4 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb4, XLSX.utils.json_to_sheet(outRows), 'Dataset'); XLSX.writeFile(wb4, outFile);
  await adminPage.getByTestId('dataset-file-input').setInputFiles(outFile);
  await adminPage.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  await adminPage.getByTestId('dataset-apply').click();
  await adminPage.getByTestId('dataset-progress-error').waitFor({ timeout: 60000 });
  await sleep(1500);
  const errTxt = await adminPage.getByTestId('dataset-progress-error').innerText();
  await shot(adminPage, 'admin-outage-waiting');
  const statusDuring = versionStatuses();
  await ask(sp, 'What is zero-shot prompting?');                          // cached under the live version: answered without any embedding call
  const outageAnswer = await lastAnswerText(sp);
  await shot(sp, 'student-answer-during-embedding-outage');
  check('9a. Embedding service down: the update waits (not failed), the admin sees why, and the live version is untouched',
    /unavailable/i.test(errTxt) && /v3:BUILDING/.test(statusDuring) && activeVersionNo() === '2' && /EDITED v2/.test(outageAnswer), `student still served (cached v2 answer="${outageAnswer.slice(0, 50)}…"); admin sees: "${errTxt.replace(/\n/g, ' ').slice(0, 150)}"; versions: ${statusDuring}; active=v${activeVersionNo()}`);
  // service comes back — restart ONLY the proxy (the backend process is not touched)
  const p = spawn('node', [path.join(__dirname, 'embed-proxy.js'), '5101'], { detached: true, stdio: 'ignore' }); p.unref();
  fs.writeFileSync(path.join(OUT, 'proxy.pid'), String(p.pid));
  for (let i = 0; i < 60 && activeVersionNo() !== '3'; i++) await sleep(1000);
  const backendPidAfter = fs.readFileSync(path.join(OUT, 'backend.pid'), 'utf8').trim();
  const backendAlive = execSync(`ss -ltn | grep -c ':5055 ' || true`).toString().trim();
  await adminPage.getByTestId('live-version-badge').filter({ hasText: 'version 3' }).waitFor({ timeout: 30000 });
  await shot(adminPage, 'admin-outage-recovered-v3-live');
  check('9b. When the embedding service returns, the build resumes and publishes by itself — backend not restarted',
    activeVersionNo() === '3' && backendPidBefore === backendPidAfter && backendAlive === '1', `active=v${activeVersionNo()}, backend pid unchanged=${backendPidBefore === backendPidAfter} (${backendPidAfter}), versions: ${versionStatuses()}`);

  // ───────────────────────── 10. Publish while a student's question is being answered ─────────────────────────
  setLlmDelay(7000);                                                      // answer generation takes ~7s
  const s2 = student2.page;
  const Q10 = 'What is chain-of-thought prompting?';
  const askP = ask(s2, Q10, { expectIn: 120000 });                        // retrieval happens immediately (pins current version v3)
  await sleep(1500);
  // admin edits that exact Q&A and publishes (fast embedding) while the answer is still being generated
  const midRows = XLSX.utils.sheet_to_json(XLSX.readFile(path.join(OUT, 'export-v2.xlsx')).Sheets['dataset']).map(r => ({ ...r }));
  midRows[midRows.findIndex(r => /chain-of-thought/i.test(r.question))].answer = 'Chain-of-thought prompting asks for step by step reasoning (CORRECTED v4 published mid-chat).';
  // (v4 is built from the v2 export + this edit, so it deliberately drops the v3 outage edit as well)
  const midFile = path.join(OUT, 'dataset-v4-midchat.xlsx');
  const wb5 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb5, XLSX.utils.json_to_sheet(midRows), 'Dataset'); XLSX.writeFile(wb5, midFile);
  await adminPage.getByTestId('dataset-file-input').setInputFiles(midFile);
  await adminPage.getByTestId('dataset-preview').waitFor({ timeout: 30000 });
  await adminPage.getByTestId('dataset-apply').click();
  for (let i = 0; i < 60 && activeVersionNo() !== '4'; i++) await sleep(500);
  const publishedWhileAnswering = activeVersionNo() === '4';
  await askP;
  await sleep(1500);
  const midAnswer = await lastAnswerText(s2);
  const memV = PSQL(`select string_agg(distinct 'v'||v.version_no, ',') from rag_answer_memory m join dataset_versions v on v.id=m.dataset_version_id where m.normalized_query like '%chain-of-thought%'`);
  await shot(s2, 'student2-answer-published-mid-chat');
  setLlmDelay(0);
  await ask(s2, 'What is chain-of-thought prompting?');                   // second ask: must be the NEW version (v4), not the v3 answer cached from the first
  const nextAnswer = await lastAnswerText(s2);
  check('10. Publish while a question is being answered: that answer comes consistently from the version it started on (v3), is cached under v3 only, and the next question gets v4',
    publishedWhileAnswering && !/CORRECTED v4/.test(midAnswer) && /EDITED v3 during outage/.test(midAnswer) && memV === 'v3' && /CORRECTED v4/.test(nextAnswer),
    `v4 published while answering=${publishedWhileAnswering}; in-flight answer="${midAnswer.slice(0, 90)}…" (memory versions: ${memV}); next answer="${nextAnswer.slice(0, 80)}…"`);

  // ───────────────────────── 11. Access control ─────────────────────────
  const req = async (method, url, token, body) => {
    const r = await fetch(API + url, { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body });
    return r.status;
  };
  const fd = () => { const f = new FormData(); f.append('file', new Blob([fs.readFileSync(v1file)]), 'x.xlsx'); f.append('dryRun', 'true'); return f; };
  const stud = ctx.studentToken;
  const codes = {
    upload: await req('POST', `/datasets/upload/${L}`, stud, fd()),
    versions: await req('GET', `/datasets/versions/${L}`, stud),
    export: await req('GET', `/datasets/export/${L}`, stud),
    rollback: await req('POST', `/datasets/rollback/${L}`, stud),
    noTokenVersions: await req('GET', `/datasets/versions/${L}`, null),
    badToken: await req('GET', `/datasets/versions/${L}`, stud + 'x'),
    adminOk: await req('GET', `/datasets/versions/${L}`, ctx.adminToken),
  };
  const before = versionStatuses();
  // the student UI must not expose the admin page either
  const sAdmin = await newPage(browser, ctx.studentToken);
  await sAdmin.page.goto(lectureUrl, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const onAdminPage = await sAdmin.page.getByTestId('dataset-manager').count();
  await shot(sAdmin.page, 'student-visiting-admin-page');
  check('11. Admin operations are closed to a logged-in student (upload/versions/export/rollback → 403), anonymous/forged → 401, admin → 200; the admin screen does not render for a student',
    codes.upload === 403 && codes.versions === 403 && codes.export === 403 && codes.rollback === 403 && codes.noTokenVersions === 401 && codes.badToken === 401 && codes.adminOk === 200 && onAdminPage === 0 && before === versionStatuses(),
    `HTTP codes=${JSON.stringify(codes)}; student opening /admin/lectures/${L}: dataset manager rendered=${onAdminPage}; versions unchanged=${before === versionStatuses()}`);

  // ───────────────────────── 12. Simultaneous uploads over HTTP ─────────────────────────
  const dsl = XLSX.utils.sheet_to_json(XLSX.readFile(path.join(OUT, 'export-v2.xlsx')).Sheets['dataset']).map(r => ({ ...r }));
  setProxyDelay(2500);
  const mkUp = (n) => { const rr = dsl.map(r => ({ ...r })); rr[n].answer += ` (parallel edit ${n})`; const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.json_to_sheet(rr), 'D'); const buf = XLSX.write(w, { type: 'buffer', bookType: 'xlsx' }); const f = new FormData(); f.append('file', new Blob([buf]), `p${n}.xlsx`); return f; };
  const par = await Promise.all([3, 4, 5].map(n => fetch(`${API}/datasets/upload/${L}`, { method: 'POST', headers: { authorization: 'Bearer ' + ctx.adminToken }, body: mkUp(n) }).then(r => r.status)));
  await sleep(500);
  const building = PSQL(`select count(*) from dataset_versions where lecture_id=${L} and status in ('BUILDING','READY_TO_ACTIVATE')`);
  for (let i = 0; i < 60 && Number(PSQL(`select count(*) from dataset_versions where lecture_id=${L} and status in ('BUILDING','READY_TO_ACTIVATE')`)) > 0; i++) await sleep(1000);
  setProxyDelay(0);
  const dupes = PSQL(`select count(*) from (select qa_id, chunk_index from dataset_version_chunks where version_id=(select active_version_id from lectures where id=${L}) group by 1,2 having count(*)>1) t`);
  const mixed = PSQL(`select count(*) from dataset_version_chunks d join lecture_qna_chunks c on c.id=d.chunk_id where d.version_id=(select active_version_id from lectures where id=${L}) and c.answer like '%parallel edit%'`);
  const sortedCodes = [...par].sort();
  check('12. Three simultaneous uploads on one lecture: exactly one is accepted, two get 409, only one version builds, no duplicate or mixed rows',
    sortedCodes.join() === '200,409,409' && building === '1' && dupes === '0' && mixed === '1', `status codes=${par.join(',')}, in-flight versions while building=${building}, duplicate qa pieces in live version=${dupes}, rows carrying a parallel edit=${mixed} (must be exactly 1 winner), versions: ${versionStatuses()}`);

  // final overview screenshot
  await adminPage.reload({ waitUntil: 'domcontentloaded' });
  await adminPage.getByTestId('versions-table').waitFor({ timeout: 60000 });
  await sleep(800);
  await shot(adminPage, 'admin-final-versions-list');

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name.slice(0, 40)).join(' | '));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
