'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.resolve(__dirname, '../src/services/video-recommendation.service.ts');
const built = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.equal((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const tripwire = () => assert.fail('Unexpected live provider call');
const dependencies = {
  '../config/env': { env: { LLM: { QUERY_ROUTER: { PROVIDER: 'test', MODEL: 'test' } } } },
  '../llm/llm-provider.resolver': { resolveLlmProvider: tripwire },
  '../llm/llm-observability.service': { withLlmDiagnostic: tripwire },
  './youtube-video-search.service': { searchYouTubeVideos: tripwire },
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputText)(name => {
  assert.ok(dependencies[name], `Unexpected import: ${name}`);
  return dependencies[name];
}, mod, mod.exports);
const { isVideoSearchCandidate, getVideoRecommendations } = mod.exports;
const intent = (changes = {}) => ({ isVideoRequest: true, topic: 'zero-shot prompting', languageCode: '', languageName: '', ...changes });
const video = (id, changes = {}) => ({ id, title: 'Zero-shot prompting', channelTitle: 'Learning channel', url: 'https://untrusted.example/', ...changes });
const videos = [video('aaaaaaaaaa1'), video('bbbbbbbbbb2'), video('cccccccccc3')];

function mocks(result = intent(), searchResult = { status: 'OK', videos }) {
  const calls = [];
  return {
    calls,
    resolveRequest: async (question, history) => {
      calls.push({ type: 'intent', question, history });
      if (result instanceof Error) throw result;
      return result;
    },
    search: async request => { calls.push({ type: 'search', request }); return searchResult; },
  };
}

test('ordinary questions, existing videos, and negated requests bypass all new providers', async () => {
  const ordinary = [
    'What is zero-shot prompting?', 'hi', 'Summarize this lecture',
    'Summarize this video', 'Explain video compression', 'What is a video?',
    'How do I upload videos to YouTube?', 'Please explain this YouTube video',
    'Can you explain this YouTube video?', 'What do videos illustrate in zero-shot learning?',
    "Don't give me any more videos, explain zero shot", 'No YouTube links, just explain zero shot',
    'mujhe video links nahi chahiye',
  ];
  for (const question of ordinary) {
    assert.equal(isVideoSearchCandidate(question), false, question);
    assert.equal(await getVideoRecommendations(question, [], { resolveRequest: tripwire, search: tripwire }), null, question);
  }
});

test('video request gate accepts direct, Roman Urdu, shorthand, and combined requests', () => {
  for (const question of [
    'Give me 3 videos about zero-shot prompting',
    'zero shot prompt sy related mjy or vodeos ky links do hindi wali',
    'zero-shot prompting videos Hindi', 'zero-shot prompting Hindi videos',
    'How can I get videos on zero-shot prompting?',
    'What are some good videos on zero-shot prompting?',
    'Explain zero-shot prompting and show me 3 videos in Hindi', 'more videos',
  ]) assert.equal(isVideoSearchCandidate(question), true, question);
});

test('English is the default even for Roman Urdu and a previous Hindi conversation', async () => {
  const deps = mocks(intent({ languageCode: 'hi', languageName: 'Hindi' }));
  const history = [{ question: 'Hindi videos please', answer: 'Previous Hindi recommendations' }];
  const reply = await getVideoRecommendations('zero shot prompting sy related mjy videos ky links do', history, deps);
  assert.equal(deps.calls[1].request.languageCode, 'en');
  assert.equal(reply.languageCode, 'en');
  assert.equal(reply.videoCount, 3);
  assert.strictEqual(deps.calls[0].history, history);
});

test('explicit Hindi overrides a mistaken English parser response', async () => {
  const deps = mocks(intent({ languageCode: 'en', languageName: 'English' }));
  const reply = await getVideoRecommendations('zero shot prompting sy related mjy videos ky links do Hindi wali', [], deps);
  assert.deepEqual(deps.calls[1].request, { topic: 'zero-shot prompting', languageCode: 'hi', languageName: 'Hindi' });
  assert.match(reply.answer, /3 Hindi YouTube videos/);
});

test('an explicitly requested language other than Hindi is honored', async () => {
  const deps = mocks(intent());
  await getVideoRecommendations('Show me Urdu videos about zero-shot prompting', [], deps);
  assert.equal(deps.calls[1].request.languageCode, 'ur');
});

test('a language used as the topic does not change the default spoken language', async () => {
  for (const resolved of [intent({ topic: 'Hindi grammar', languageCode: 'hi', languageName: 'Hindi' }), new Error('offline')]) {
    const deps = mocks(resolved);
    await getVideoRecommendations('Find videos about Hindi grammar', [], deps);
    assert.deepEqual(deps.calls[1].request, { topic: 'Hindi grammar', languageCode: 'en', languageName: 'English' });
  }
});

test('a follow-up topic comes from the bounded resolver context, not an invented lecture', async () => {
  const history = [{ question: 'Explain zero-shot prompting', answer: 'Uses no demonstrations.' }];
  const deps = mocks(intent());
  await getVideoRecommendations('more videos', history, deps);
  assert.deepEqual(deps.calls[1].request, { topic: 'zero-shot prompting', languageCode: 'en', languageName: 'English' });
});

test('unknown or missing topic asks for clarification without a search', async () => {
  for (const [question, resolved] of [
    ['Show me videos in Hindi', intent({ topic: '' })],
    ['I need some videos', new Error('offline')],
    ['more videos', { invalid: true }],
    ['Show me videos about this topic', new Error('offline')],
  ]) {
    const deps = mocks(resolved);
    const reply = await getVideoRecommendations(question, [], deps);
    assert.equal(reply.status, 'NEEDS_TOPIC', question);
    assert.equal(deps.calls.filter(c => c.type === 'search').length, 0);
  }
});

test('unsupported explicitly named language never silently becomes English', async () => {
  const deps = mocks(intent({ languageCode: 'tlh', languageName: 'Klingon' }));
  const reply = await getVideoRecommendations('Find videos in Klingon about zero-shot prompting', [], deps);
  assert.equal(reply.status, 'NEEDS_LANGUAGE');
  assert.equal(deps.calls.length, 1);
});

test('provider failure still handles the exact Roman Urdu Hindi request conservatively', async () => {
  const deps = mocks(new Error('offline'));
  await getVideoRecommendations('zero shot prompt sy related mjy or vodeos ky links do hindi wali', [], deps);
  assert.deepEqual(deps.calls[1].request, { topic: 'zero shot prompt', languageCode: 'hi', languageName: 'Hindi' });
});

test('candidate classified as an ordinary lecture question falls through', async () => {
  const deps = mocks(intent({ isVideoRequest: false }));
  assert.equal(await getVideoRecommendations('Give me video compression examples', [], deps), null);
  assert.equal(deps.calls.length, 1);
});

test('intent-provider failure cannot hijack an ordinary video-technology question', async () => {
  for (const question of ['Give me examples of video encoding', 'Show me the definition of video resolution']) {
    const deps = mocks(new Error('offline'));
    assert.equal(await getVideoRecommendations(question, [], deps), null, question);
    assert.equal(deps.calls.filter(c => c.type === 'search').length, 0);
  }
});

test('a negated Hindi preference is not interpreted as requesting Hindi', async () => {
  for (const resolved of [intent(), intent({ languageCode: 'hi', languageName: 'Hindi' })]) {
    const deps = mocks(resolved);
    const reply = await getVideoRecommendations('Show me videos about zero-shot prompting, not in Hindi', [], deps);
    assert.equal(reply.languageCode, 'en');
    assert.equal(deps.calls[1].request.languageCode, 'en');
  }
});

test('unknown explicit language and rejected default ask for a language even when the resolver fails', async () => {
  for (const question of ['Find videos in Swahili about zero-shot prompting', 'Find videos about zero-shot prompting, not in English']) {
    const deps = mocks(new Error('offline'));
    const reply = await getVideoRecommendations(question, [], deps);
    assert.equal(reply.status, 'NEEDS_LANGUAGE', question);
    assert.equal(deps.calls.filter(c => c.type === 'search').length, 0);
  }
});

test('renders at most three unique actual IDs and sanitizes untrusted labels', async () => {
  const malicious = '[Click](javascript:alert(1))\n<script>bad</script> **title**';
  const deps = mocks(intent(), { status: 'OK', videos: [
    video('bad'), video('aaaaaaaaaa1', { title: malicious, channelTitle: '[x](https://evil.test)' }),
    video('aaaaaaaaaa1'), video('bbbbbbbbbb2'), video('cccccccccc3'), video('dddddddddd4'),
  ] });
  const reply = await getVideoRecommendations('Find videos about zero-shot prompting', [], deps);
  assert.equal(reply.videoCount, 3);
  assert.equal((reply.answer.match(/\]\(https:\/\/www.youtube.com\/watch\?v=/g) ?? []).length, 3);
  assert.doesNotMatch(reply.answer, /https:\/\/untrusted.example|<script>|\]\(javascript:/);
  assert.equal(reply.answer.includes('dddddddddd4'), false);
});

test('fewer valid results are reported honestly without filling slots', async () => {
  const deps = mocks(intent(), { status: 'OK', videos: [videos[0]] });
  const reply = await getVideoRecommendations('Find videos about zero-shot prompting', [], deps);
  assert.equal(reply.videoCount, 1);
  assert.match(reply.answer, /only 1 suitable English result/);
});

test('empty results, configuration errors and service failure never fabricate links', async () => {
  for (const status of ['NO_RESULTS', 'NOT_CONFIGURED', 'UNAVAILABLE']) {
    const deps = mocks(intent(), { status, videos: [] });
    const reply = await getVideoRecommendations('Find videos about zero-shot prompting', [], deps);
    assert.equal(reply.status, status);
    assert.equal(reply.videoCount, 0);
    assert.doesNotMatch(reply.answer, /youtube\.com\/watch/);
  }
  const deps = mocks();
  deps.search = async () => { throw new Error('key=secret'); };
  const reply = await getVideoRecommendations('Find videos about zero-shot prompting', [], deps);
  assert.equal(reply.status, 'UNAVAILABLE');
  assert.doesNotMatch(reply.answer, /secret/);
});
