'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The real orchestration runs with a strict in-memory database and injected
// providers. No test may connect to PostgreSQL, YouTube, or an LLM.
Object.assign(process.env, {
  NODE_ENV: 'test', DB_PASSWORD: 'offline-video-chat-test',
  JWT_SECRET: 'offline-video-chat-test-secret-32-characters',
  JWT_REFRESH_SECRET: 'offline-video-chat-refresh-secret-32-characters',
  OBSERVABILITY_ENABLED: 'false', PHOENIX_ENABLED: 'false',
  AGENTIC_GRAPH_ENABLED: 'false', ADAPTIVE_TUTORING_MODES_ENABLED: 'false',
});
require('ts-node').register({ transpileOnly: true, project: path.resolve(__dirname, '../tsconfig.json') });
const pool = require('../src/config/database').default;
const { env } = require('../src/config/env');
const { askLectureAgent } = require('../src/services/chat.service');
const { getVideoRecommendations } = require('../src/services/video-recommendation.service');
const { searchYouTubeVideos } = require('../src/services/youtube-video-search.service');

const STUDENT = 'student-a';
const LECTURE = 4;
const SESSION = 101;
const QUESTION = 'Give me three videos about zero-shot prompting in Hindi';
const VIDEO_ANSWER = 'YouTube videos about zero-shot prompting (Hindi):\n\n'
  + '1. [Zero-shot prompting](https://www.youtube.com/watch?v=abc123DEF_1)\n'
  + '2. [Prompting tutorial](https://www.youtube.com/watch?v=abc123DEF_2)\n'
  + '3. [Prompting examples](https://www.youtube.com/watch?v=abc123DEF_3)';
const reply = (status = 'OK') => ({
  answer: status === 'OK' ? VIDEO_ANSWER : 'YouTube search is temporarily unavailable. Please try again later.',
  status, videoCount: status === 'OK' ? 3 : 0, languageCode: 'hi',
});
const chunk = {
  id: 7, lecture_id: LECTURE, topic: 'Zero-shot prompting', question: 'What is zero-shot prompting?',
  answer: 'A prompt without examples.', chunk_text: 'Zero-shot prompting uses no examples.',
  start_time: null, end_time: null, keywords: null, similarity: 0.9, rerankScore: 0.9,
};

async function inWorld(run, options = {}) {
  const statements = [], saved = [], traces = [], videoCalls = [], pipelineCalls = [];
  const oldQuery = pool.query, oldConnect = pool.connect, oldFetch = global.fetch;
  const oldGraph = env.AGENTIC_GRAPH_ENABLED;
  const oldMode = process.env.ADAPTIVE_TUTORING_MODES_ENABLED;
  const oldSocratic = process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED;
  const oldTurns = env.CHAT.HISTORY_TURNS;
  env.AGENTIC_GRAPH_ENABLED = Boolean(options.graph);
  env.CHAT.HISTORY_TURNS = 3;
  process.env.ADAPTIVE_TUTORING_MODES_ENABLED = options.socratic ? 'true' : 'false';
  process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED = options.socratic ? 'true' : 'false';
  const history = [
    { id: 1, student_id: STUDENT, session_id: SESSION, question: 'Explain zero-shot prompting', answer: 'It uses no examples.' },
    { id: 2, student_id: STUDENT, session_id: SESSION, question: 'Give an example', answer: 'Classify the sentiment of a sentence.' },
    { id: 3, student_id: 'student-b', session_id: 202, question: 'OTHER STUDENT PRIVATE QUESTION', answer: 'PRIVATE ANSWER' },
    { id: 4, student_id: STUDENT, session_id: 303, question: 'OTHER SESSION QUESTION', answer: 'OTHER SESSION ANSWER' },
    { id: 5, student_id: STUDENT, session_id: SESSION, question: 'CLEARED QUESTION', answer: 'CLEARED ANSWER', cleared: true },
  ];
  global.fetch = async () => assert.fail('Unexpected live HTTP request');
  pool.connect = async () => assert.fail('Unexpected database connection or Socratic write');
  pool.query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    statements.push({ text, params });
    const rows = values => ({ rows: values, rowCount: values.length });
    if (text === 'SELECT l.*, ap.agent_name FROM lectures l LEFT JOIN lecture_agent_profiles ap ON ap.lecture_id = l.id WHERE l.id = $1') {
      return rows([{ id: params[0], title: 'Prompting', status: options.notReady ? 'PROCESSING' : 'READY', archived_at: options.archived ? new Date() : null }]);
    }
    if (/^SELECT 1 AS ok FROM chat_sessions WHERE id = \$1 AND student_id = \$2 AND lecture_id = \$3$/.test(text)) {
      return rows(params[0] === SESSION && params[1] === STUDENT && params[2] === LECTURE ? [{ ok: 1 }] : []);
    }
    if (/^INSERT INTO student_questions /.test(text)) return rows([]);
    if (/^SELECT question, answer FROM chat_history WHERE session_id = \$1 AND student_id = \$2 AND cleared_by_student = FALSE ORDER BY created_at DESC, id DESC LIMIT \$3$/.test(text)) {
      return rows(history.filter(h => h.session_id === params[0] && h.student_id === params[1] && !h.cleared)
        .sort((a, b) => b.id - a.id).slice(0, params[2]).map(({ question, answer }) => ({ question, answer })));
    }
    if (/^SELECT anchor_question,next_stage FROM socratic_chat_state /.test(text)) {
      return rows([{ anchor_question: 'Explain zero-shot prompting', next_stage: 2 }]);
    }
    if (/^INSERT INTO chat_history /.test(text)) {
      saved.push({ studentId: params[0], lectureId: params[1], question: params[2], answer: params[3], sourceChunkIds: params[4], sessionId: params[5], traceId: params[6] });
      return rows([{ id: 500 + saved.length }]);
    }
    if (/^UPDATE chat_sessions SET updated_at = NOW\(\)/.test(text)) return { rows: [], rowCount: 1 };
    assert.fail(`Unexpected SQL: ${text}`);
  };
  const forbidden = name => async () => { pipelineCalls.push(name); assert.fail(`Unexpected ${name}`); };
  const deps = {
    getLectureReadiness: async () => ({ ready: true, reason: 'READY' }),
    getAgentProfile: async lectureId => ({ status: 'FOUND', profile: { lecture_id: lectureId, agent_name: 'Tutor', instructions: 'Use the lecture evidence.', is_active: true } }),
    runInputGuardrails: async question => ({ action: 'ALLOW', sanitizedInput: question }),
    recommendVideos: async (question, prior) => { videoCalls.push({ question, history: prior }); return reply(); },
    datasetVersionId: 17,
    generateEmbedding: forbidden('embedding'), searchChunks: forbidden('retrieval'),
    rerankChunks: forbidden('reranking'), dedupeAndSelect: () => assert.fail('Unexpected dedupe'),
    reorderForContext: () => assert.fail('Unexpected context reorder'),
    generateAnswer: forbidden('answer generation'), generateGreeting: forbidden('greeting'),
    resolveRetrievalQuery: forbidden('rewriter'), classifyRoute: forbidden('normal router'),
    decomposeQuery: forbidden('decomposition'), runAdaptiveRetrieval: forbidden('adaptive retrieval'),
    runOutputGuardrail: forbidden('lecture answer verification'), getAllLectureChunks: forbidden('summary chunks'),
    generateLectureSummary: forbidden('summary generation'), lookupAnswerMemory: forbidden('answer-memory read'),
    writeAnswerMemory: forbidden('answer-memory write'), recordMemoryHit: forbidden('memory hit'),
    onTraceComplete: trace => traces.push(trace),
  };
  const ask = (question = QUESTION, overrides = {}) => askLectureAgent({
    studentId: STUDENT, lectureId: LECTURE, sessionId: SESSION, question,
    ...(options.socratic ? { tutoringMode: 'SOCRATIC' } : {}), ...overrides,
  }, deps);
  try { return await run({ ask, deps, statements, saved, traces, videoCalls, pipelineCalls }); }
  finally {
    pool.query = oldQuery; pool.connect = oldConnect; global.fetch = oldFetch;
    env.AGENTIC_GRAPH_ENABLED = oldGraph; env.CHAT.HISTORY_TURNS = oldTurns;
    if (oldMode === undefined) delete process.env.ADAPTIVE_TUTORING_MODES_ENABLED; else process.env.ADAPTIVE_TUTORING_MODES_ENABLED = oldMode;
    if (oldSocratic === undefined) delete process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED; else process.env.ADAPTIVE_TUTORING_SOCRATIC_ENABLED = oldSocratic;
  }
}

for (const question of [QUESTION, 'Give me three videos about zero-shot prompting', 'zero shot prompt sy related mjy videos ky links do Hindi wali']) {
  test(`video request is saved without invoking RAG: ${question}`, () => inWorld(async w => {
    assert.deepEqual(await w.ask(question), { answer: VIDEO_ANSWER, sources: [] });
    assert.equal(w.videoCalls.length, 1);
    assert.deepEqual(w.pipelineCalls, []);
    assert.equal(w.saved.length, 1);
    assert.equal(w.saved[0].question, question);
    assert.deepEqual(w.saved[0].sourceChunkIds, []);
    assert.equal(w.saved[0].answer, VIDEO_ANSWER);
    assert.equal(w.saved[0].sessionId, SESSION);
    assert.equal(w.saved[0].studentId, STUDENT);
    assert.equal(w.traces.length, 1);
    assert.equal(w.traces[0].attributes.route, 'VIDEO_REQUEST');
    assert.equal(w.traces[0].attributes.memoryResult, 'NOT_ATTEMPTED');
    assert.equal(w.traces[0].attributes.responseStatus, 'VIDEO_LINKS_RETURNED');
    assert.equal(w.statements.filter(s => /^UPDATE chat_sessions/.test(s.text)).length, 1);
  }));
}

for (const scenario of [
  { name: 'English defaults despite Roman Urdu input', question: 'zero shot prompt sy related mujhe videos ke links do', languageCode: 'en', languageName: 'English', explicit: false, graph: false },
  { name: 'explicit Hindi before LangGraph execution', question: QUESTION, languageCode: 'hi', languageName: 'Hindi', explicit: true, graph: true },
]) {
  test(`full service path: ${scenario.name}`, () => inWorld(async w => {
    const httpCalls = [], intentCalls = [], searchRequests = [];
    const ids = ['abc123DEF_1', 'abc123DEF_2', 'abc123DEF_3'];
    const wrongLanguageId = 'wrongLang01';
    const candidateIds = [wrongLanguageId, ...ids];
    const metadata = id => ({
      id,
      snippet: {
        title: id === ids[0] ? 'Zero-shot [prompting] explained' : `Zero-shot prompting lesson ${id}`,
        channelTitle: 'Example learning channel', liveBroadcastContent: 'none',
        defaultAudioLanguage: id === wrongLanguageId
          ? (scenario.languageCode === 'hi' ? 'en-US' : 'hi-IN')
          : `${scenario.languageCode}-${scenario.languageCode === 'hi' ? 'IN' : 'US'}`,
      },
      status: { privacyStatus: 'public', uploadStatus: 'processed' },
      contentDetails: { duration: 'PT8M' },
    });
    const fakeYouTube = async (rawUrl, init) => {
      const url = new URL(rawUrl);
      httpCalls.push({ url, init });
      assert.equal(url.origin, 'https://www.googleapis.com');
      assert.equal(url.searchParams.get('key'), 'offline-only-youtube-key');
      assert.ok(init.signal instanceof AbortSignal);
      if (url.pathname === '/youtube/v3/search') {
        assert.equal(httpCalls.length, 1, 'only one search is needed for three matches');
        assert.equal(url.searchParams.get('relevanceLanguage'), scenario.languageCode);
        assert.equal(url.searchParams.get('q'), `zero-shot prompting tutorial in ${scenario.languageName}`);
        assert.equal(url.searchParams.get('type'), 'video');
        assert.equal(url.searchParams.get('order'), 'relevance');
        assert.equal(url.searchParams.get('safeSearch'), 'strict');
        return { ok: true, json: async () => ({ items: candidateIds.map(videoId => ({ id: { kind: 'youtube#video', videoId } })) }) };
      }
      assert.equal(url.pathname, '/youtube/v3/videos');
      assert.equal(httpCalls.length, 2);
      assert.equal(url.searchParams.get('id'), candidateIds.join(','));
      assert.equal(url.searchParams.get('part'), 'snippet,contentDetails,status');
      // Detail response order differs from search order, and the highest search
      // result has conflicting audio metadata: neither may change selection.
      return { ok: true, json: async () => ({ items: [ids[2], wrongLanguageId, ids[1], ids[0]].map(metadata) }) };
    };
    w.deps.recommendVideos = async (question, history) => {
      w.videoCalls.push({ question, history });
      return getVideoRecommendations(question, history, {
        resolveRequest: async (latest, prior) => {
          intentCalls.push({ latest, prior });
          return { isVideoRequest: true, topic: 'zero-shot prompting',
            languageCode: scenario.explicit ? 'hi' : '', languageName: scenario.explicit ? 'Hindi' : '' };
        },
        search: async request => {
          searchRequests.push(request);
          return searchYouTubeVideos(request, { apiKey: 'offline-only-youtube-key', fetch: fakeYouTube });
        },
      });
    };

    const result = await w.ask(scenario.question);
    assert.equal(intentCalls.length, 1);
    assert.equal(intentCalls[0].latest, scenario.question);
    assert.deepEqual(intentCalls[0].prior, [
      { question: 'Explain zero-shot prompting', answer: 'It uses no examples.' },
      { question: 'Give an example', answer: 'Classify the sentiment of a sentence.' },
    ]);
    assert.deepEqual(searchRequests, [{ topic: 'zero-shot prompting', languageCode: scenario.languageCode, languageName: scenario.languageName }]);
    assert.equal(httpCalls.length, 2);
    assert.match(result.answer, new RegExp(`^Here are 3 ${scenario.languageName} YouTube videos about zero-shot prompting:`));
    const linkedIds = [...result.answer.matchAll(/\]\(https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})\)/g)].map(match => match[1]);
    assert.deepEqual(linkedIds, ids);
    assert.equal(result.answer.includes(wrongLanguageId), false);
    assert.ok(result.answer.includes('[Zero-shot prompting explained](https://www.youtube.com/watch?v=abc123DEF_1)'));
    assert.deepEqual(result.sources, []);
    assert.equal(w.saved.length, 1);
    assert.equal(w.saved[0].answer, result.answer);
    assert.deepEqual(w.saved[0].sourceChunkIds, []);
    assert.deepEqual(w.pipelineCalls, []);
    assert.equal(w.traces[0].attributes.route, 'VIDEO_REQUEST');
    assert.equal(w.traces[0].attributes.videoCount, 3);
    assert.equal(w.traces[0].attributes.responseStatus, 'VIDEO_LINKS_RETURNED');
  }, { graph: scenario.graph }));
}

test('video resolver sees guarded text and only the owning session\'s uncleared history in order', () => inWorld(async w => {
  const guarded = 'Give me Hindi videos about zero-shot prompting [EMAIL]';
  w.deps.runInputGuardrails = async () => ({ action: 'SANITIZE', sanitizedInput: guarded });
  await w.ask('Give me Hindi videos about zero-shot prompting, email me at private@example.com');
  assert.equal(w.videoCalls[0].question, guarded);
  assert.deepEqual(w.videoCalls[0].history, [
    { question: 'Explain zero-shot prompting', answer: 'It uses no examples.' },
    { question: 'Give an example', answer: 'Classify the sentiment of a sentence.' },
  ]);
  assert.equal(w.saved[0].question, guarded);
  assert.ok(!JSON.stringify(w.statements).includes('private@example.com'));
}));

test('wrong-owner, wrong-lecture, and missing sessions cannot invoke video search or write chat', async () => {
  for (const overrides of [{ studentId: 'student-b' }, { lectureId: 2 }, { sessionId: 999 }]) {
    await inWorld(async w => {
      await assert.rejects(w.ask(QUESTION, overrides), error => error.statusCode === 404);
      assert.deepEqual(w.videoCalls, []);
      assert.deepEqual(w.saved, []);
      assert.equal(w.statements.some(s => /^INSERT/.test(s.text)), false);
      assert.equal(w.statements.some(s => /FROM chat_history/.test(s.text)), false);
    });
  }
});

test('input rejection stops before the video provider and all chat writes', () => inWorld(async w => {
  w.deps.runInputGuardrails = async () => ({ action: 'REJECT', reason: 'PROMPT_INJECTION' });
  await assert.rejects(w.ask(), error => error.statusCode === 400);
  assert.deepEqual(w.videoCalls, []);
  assert.deepEqual(w.saved, []);
  assert.equal(w.statements.some(s => /^INSERT/.test(s.text)), false);
}));

test('withdrawn or unready lectures keep their existing access checks for video requests', async () => {
  for (const options of [{ archived: true }, { notReady: true }]) {
    await inWorld(async w => {
      await assert.rejects(w.ask(), error => error.statusCode === 400);
      assert.deepEqual(w.videoCalls, []);
      assert.deepEqual(w.saved, []);
    }, options);
  }
});

test('dataset readiness and lecture-agent availability are still required', async () => {
  for (const override of [
    { getLectureReadiness: async () => ({ ready: false, reason: 'MISSING_EMBEDDINGS: 1/2' }) },
    { getAgentProfile: async () => ({ status: 'NOT_FOUND' }) },
    { getAgentProfile: async () => ({ status: 'INACTIVE' }) },
  ]) {
    await inWorld(async w => {
      Object.assign(w.deps, override);
      await assert.rejects(w.ask(), error => [400, 503].includes(error.statusCode));
      assert.deepEqual(w.videoCalls, []);
      assert.deepEqual(w.saved, []);
      assert.equal(w.statements.some(s => /^INSERT/.test(s.text)), false);
    });
  }
});

test('experimental graph mode still returns video links before entering graph retrieval', () => inWorld(async w => {
  assert.deepEqual(await w.ask(), { answer: VIDEO_ANSWER, sources: [] });
  assert.equal(w.videoCalls.length, 1);
  assert.deepEqual(w.pipelineCalls, []);
}, { graph: true }));

test('video requests in Socratic mode do not advance or overwrite the current guided topic', () => inWorld(async w => {
  assert.equal((await w.ask()).answer, VIDEO_ANSWER);
  assert.equal(w.saved.length, 1);
  assert.equal(w.statements.some(s => /^(?:INSERT INTO|UPDATE|DELETE FROM) socratic_chat_state/.test(s.text)), false);
  assert.deepEqual(w.pipelineCalls, []);
}, { socratic: true }));

for (const status of ['NOT_CONFIGURED', 'UNAVAILABLE', 'NO_RESULTS']) {
  test(`video search ${status} produces a saved honest response with no fabricated sources`, () => inWorld(async w => {
    w.deps.recommendVideos = async () => reply(status);
    const result = await w.ask();
    assert.equal(result.answer, reply(status).answer);
    assert.deepEqual(result.sources, []);
    assert.equal(w.saved.length, 1);
    assert.equal(w.saved[0].answer.includes('youtube.com/watch'), false);
    assert.deepEqual(w.pipelineCalls, []);
    assert.equal(w.traces[0].attributes.responseStatus, 'VIDEO_LINKS_UNAVAILABLE');
  }));
}

function normalPipeline(w) {
  Object.assign(w.deps, {
    classifyRoute: async () => ({ route: 'FACT_QUESTION', source: 'rule' }),
    lookupAnswerMemory: async () => { w.pipelineCalls.push('memory-read'); return { hit: null, embedding: [0.1], datasetVersionId: 17, lookupFailed: false }; },
    decomposeQuery: async query => ({ mode: 'DIRECT', effectiveQuery: query, subqueries: [], reason: 'NOT_COMPOUND', llmUsed: false }),
    searchChunks: async () => { w.pipelineCalls.push('retrieval'); return [chunk]; },
    rerankChunks: async (_q, chunks) => chunks,
    dedupeAndSelect: chunks => ({ selected: chunks, dedupedAway: [] }),
    reorderForContext: chunks => chunks,
    generateAnswer: async () => { w.pipelineCalls.push('generation'); return 'A prompt without examples.'; },
    runOutputGuardrail: async params => ({ finalAnswer: params.draftAnswer, verified: true, decision: 'VERIFIED', reason: 'VERIFIED', revisionAttempted: false, revisionSucceeded: false, verificationUnavailable: false, unsupportedClaimCount: 0, missingAspectCount: 0, expectedFormat: 'NATURAL_TEXT', formatValidationRequired: false, formatValid: true, formatRepairAttempted: false, formatRepairSucceeded: false, formatRepairRejected: null, piiDetected: false, piiCategories: [] }),
    writeAnswerMemory: async () => { w.pipelineCalls.push('memory-write'); },
  });
}

for (const question of ['What is zero-shot prompting?', 'What is video compression?']) {
  test(`ordinary lecture Q&A keeps retrieval, verification, citations, and answer memory: ${question}`, () => inWorld(async w => {
    normalPipeline(w);
    const result = await w.ask(question);
    assert.equal(result.answer, 'A prompt without examples.');
    assert.deepEqual(result.sources, [chunk]);
    assert.deepEqual(w.videoCalls, []);
    assert.deepEqual(w.pipelineCalls, ['memory-read', 'retrieval', 'generation', 'memory-write']);
    assert.deepEqual(w.saved[0].sourceChunkIds, [7]);
    assert.equal(w.traces[0].attributes.responseStatus, 'ANSWERED');
  }));
}

test('a candidate classified as ordinary content falls through to the existing lecture pipeline', () => inWorld(async w => {
  normalPipeline(w);
  w.deps.recommendVideos = async (question, history) => { w.videoCalls.push({ question, history }); return null; };
  assert.equal((await w.ask('Give me videos explaining zero-shot prompting')).answer, 'A prompt without examples.');
  assert.equal(w.videoCalls.length, 1);
  assert.deepEqual(w.pipelineCalls, ['memory-read', 'retrieval', 'generation', 'memory-write']);
  assert.deepEqual(w.saved[0].sourceChunkIds, [7]);
}));
