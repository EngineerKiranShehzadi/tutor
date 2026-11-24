'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const file = path.resolve(__dirname, '../src/services/youtube-video-search.service.ts');
const built = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
assert.equal((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputText)(
  name => name === '../config/env' ? { env: { YOUTUBE: { API_KEY: '' } } } : require(name), mod, mod.exports,
);
const { searchYouTubeVideos } = mod.exports;

const ids = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'dddddddddd4', 'eeeeeeeeee5', 'ffffffffff6'];
const request = (languageCode = 'en') => ({
  topic: 'Binary search trees', languageCode, languageName: languageCode === 'hi' ? 'Hindi' : 'English',
});
const response = payload => ({ ok: true, json: async () => payload });
const searches = (videoIds, nextPageToken) => ({
  items: videoIds.map(videoId => ({ id: { kind: 'youtube#video', videoId } })),
  ...(nextPageToken ? { nextPageToken } : {}),
});
const video = (id, language = 'en', changes = {}) => ({
  id, snippet: { title: 'Binary search trees', channelTitle: 'Learning channel',
    defaultAudioLanguage: language, liveBroadcastContent: 'none', ...changes.snippet },
  status: { privacyStatus: 'public', uploadStatus: 'processed', ...changes.status },
});
function transport(replies) {
  const calls = [];
  const fetch = async (raw, init) => {
    calls.push({ url: new URL(raw), init });
    assert.ok(replies.length, 'No unexpected extra API requests');
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, fetch };
}
const dependencies = mock => ({ apiKey: 'test-key', fetch: mock.fetch });

test('uses official API parameters and returns three videos in search order', async () => {
  const mock = transport([response(searches(ids.slice(0, 4))),
    response({ items: [video(ids[2]), video(ids[0]), video(ids[3]), video(ids[1], 'en-US')] })]);
  const result = await searchYouTubeVideos(request(), dependencies(mock));
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.videos.map(v => v.id), ids.slice(0, 3));
  const query = mock.calls[0].url;
  assert.equal(query.origin, 'https://www.googleapis.com');
  assert.equal(query.pathname, '/youtube/v3/search');
  for (const [key, value] of Object.entries({ type: 'video', maxResults: '25', safeSearch: 'strict',
    order: 'relevance', relevanceLanguage: 'en', key: 'test-key' })) assert.equal(query.searchParams.get(key), value);
  assert.equal(query.searchParams.get('q'), 'Binary search trees tutorial in English');
  assert.equal(mock.calls[1].url.searchParams.get('id'), ids.slice(0, 4).join(','));
  assert.equal(mock.calls[1].url.searchParams.has('maxResults'), false);
});

test('Hindi rejects English audio and unverified metadata, accepting regional audio and explicit claims', async () => {
  const mock = transport([response(searches(ids)), response({ items: [
    video(ids[0], 'en', { snippet: { title: 'Trees in Hindi', defaultLanguage: 'hi' } }),
    video(ids[1], 'hi-IN'),
    video(ids[2], undefined, { snippet: { defaultAudioLanguage: undefined, title: 'Trees in Hindi' } }),
    video(ids[3], undefined, { snippet: { defaultAudioLanguage: undefined, defaultLanguage: 'hi' } }),
    video(ids[4], undefined, { snippet: { defaultAudioLanguage: undefined, title: 'Trees', description: 'हिंदी में explanation' } }),
    video(ids[5], 'en'),
  ] })]);
  const result = await searchYouTubeVideos(request('hi'), dependencies(mock));
  assert.deepEqual(result.videos.map(v => v.id), [ids[1], ids[2], ids[4]]);
  assert.equal(mock.calls[0].url.searchParams.get('relevanceLanguage'), 'hi');
  assert.match(mock.calls[0].url.searchParams.get('q'), /in Hindi$/);
});

test('English titles, subtitles, translated text, and negated claims are not English audio evidence', async () => {
  const mock = transport([response(searches(ids.slice(0, 4))), response({ items: [
    video(ids[0], '', { snippet: { defaultLanguage: 'en' } }),
    video(ids[1], '', { snippet: { title: 'Trees in Hindi with subtitles in English' } }),
    video(ids[2], '', { snippet: { title: 'This lesson is not in English' } }),
    video(ids[3], '', { snippet: { title: 'Binary trees [English]' } }),
  ] })]);
  const result = await searchYouTubeVideos(request(), dependencies(mock));
  assert.deepEqual(result.videos.map(v => v.id), [ids[3]]);
});

test('only confirmed public, processed, non-live videos are returned', async () => {
  const mock = transport([response(searches(ids)), response({ items: [
    video(ids[0], 'en', { status: { privacyStatus: 'private' } }),
    video(ids[1], 'en', { status: { uploadStatus: 'uploaded' } }),
    video(ids[2], 'en', { snippet: { liveBroadcastContent: 'live' } }),
    video(ids[3], 'en', { snippet: { liveBroadcastContent: 'upcoming' } }),
    video(ids[4], 'en', { status: { privacyStatus: undefined } }), video(ids[5]),
    video('notsearched'),
  ] })]);
  assert.deepEqual((await searchYouTubeVideos(request(), dependencies(mock))).videos.map(v => v.id), [ids[5]]);
});

test('deduplicates across pages and uses at most one additional page', async () => {
  const mock = transport([
    response(searches([ids[0], ids[0], 'bad-id'], 'page-2')), response({ items: [video(ids[0])] }),
    response(searches([ids[0], ids[1], ids[2]], 'page-3')), response({ items: [video(ids[1]), video(ids[2])] }),
  ]);
  const result = await searchYouTubeVideos(request(), dependencies(mock));
  assert.deepEqual(result.videos.map(v => v.id), ids.slice(0, 3));
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls[2].url.searchParams.get('pageToken'), 'page-2');
  assert.equal(mock.calls[3].url.searchParams.get('id'), ids.slice(1, 3).join(','));
});

test('does not page indefinitely or fill Hindi results with another language', async () => {
  const mock = transport([
    response(searches([ids[0]], 'page-2')), response({ items: [video(ids[0], 'en')] }),
    response(searches([ids[1]], 'page-3')), response({ items: [video(ids[1], 'en')] }),
  ]);
  assert.deepEqual(await searchYouTubeVideos(request('hi'), dependencies(mock)), { status: 'NO_RESULTS', videos: [] });
  assert.equal(mock.calls.length, 4);
});

test('missing API key stops before any network request', async () => {
  const fetch = async () => assert.fail('No request should be made');
  assert.deepEqual(await searchYouTubeVideos(request(), { apiKey: ' ', fetch }), { status: 'NOT_CONFIGURED', videos: [] });
  assert.equal((await searchYouTubeVideos(request(), { fetch })).status, 'NOT_CONFIGURED');
});

test('quota/configuration failures, network errors, and malformed payloads fail safely without caching errors', async () => {
  for (const bad of [
    { ok: false, status: 403, json: async () => ({ error: { message: 'secret-key', errors: [{ reason: 'quotaExceeded' }] } }) },
    new Error('Network failed: key=secret-key'), response({ items: 'invalid' }),
    response({ error: { message: 'secret-key' }, items: [] }),
    { ok: true, json: async () => { throw new SyntaxError('bad JSON'); } },
  ]) {
    const mock = transport([bad, response(searches([]))]);
    const result = await searchYouTubeVideos(request(), dependencies(mock));
    assert.deepEqual(result, { status: 'UNAVAILABLE', videos: [] });
    assert.equal(JSON.stringify(result).includes('secret-key'), false);
    assert.equal((await searchYouTubeVideos(request(), dependencies(mock))).status, 'NO_RESULTS');
    assert.equal(mock.calls.length, 2);
  }
});

test('deadline bounds a fetch or response body that ignores cancellation', async () => {
  for (const hangInBody of [false, true]) {
    let signal;
    const fetch = async (_url, init) => {
      signal = init.signal;
      const stalled = new Promise(() => {});
      return hangInBody ? { ok: true, json: () => stalled } : stalled;
    };
    const result = await searchYouTubeVideos(request(), { apiKey: 'test', fetch, timeoutMs: 15 });
    assert.deepEqual(result, { status: 'UNAVAILABLE', videos: [] });
    assert.equal(signal.aborted, true);
  }
});

test('partial valid results survive an unavailable fallback page', async () => {
  const mock = transport([response(searches([ids[0]], 'page-2')), response({ items: [video(ids[0])] }), new Error('unavailable')]);
  const result = await searchYouTubeVideos(request(), dependencies(mock));
  assert.equal(result.status, 'OK');
  assert.deepEqual(result.videos.map(v => v.id), [ids[0]]);
});

test('uses validated IDs for links even if metadata contains malicious URLs or markdown', async () => {
  const mock = transport([response(searches([ids[0], 'javascript:alert(1)', 'abcdefghij?'])), response({ items: [
    video(ids[0], 'en', { snippet: { title: '[click](https://evil.example)', channelTitle: 'https://evil.example' } }),
  ] })]);
  const result = await searchYouTubeVideos(request(), dependencies(mock));
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].url, `https://www.youtube.com/watch?v=${ids[0]}`);
  assert.equal(mock.calls[1].url.searchParams.get('id'), ids[0]);
});

test('shares concurrent requests, caches clones, and separates language/key with TTL expiry', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  let currentTime = 100;
  const fetch = async raw => {
    const url = new URL(raw); calls.push(url);
    await gate;
    if (url.pathname.endsWith('/search')) return response(searches([ids[0]]));
    return response({ items: [video(ids[0], 'en')] });
  };
  const deps = { apiKey: 'key-1', fetch, now: () => currentTime };
  const first = searchYouTubeVideos(request(), deps);
  const second = searchYouTubeVideos({ ...request(), topic: '  binary   search trees  ' }, deps);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  a.videos[0].title = 'mutated';
  assert.notEqual(b.videos[0].title, 'mutated');
  assert.notEqual((await searchYouTubeVideos(request(), deps)).videos[0].title, 'mutated');
  assert.equal(calls.length, 2);
  await searchYouTubeVideos(request('hi'), deps);
  assert.equal(calls.length, 4);
  await searchYouTubeVideos(request(), { ...deps, apiKey: 'key-2' });
  assert.equal(calls.length, 6);
  currentTime += 15 * 60 * 1000 + 1;
  await searchYouTubeVideos(request(), deps);
  assert.equal(calls.length, 8);
});
