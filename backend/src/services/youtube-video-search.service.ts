import { createHash } from 'node:crypto';

export interface VideoSearchRequest {
  topic: string;
  languageCode: string;
  languageName: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  channelTitle: string;
  url: string;
}

export interface VideoSearchResult {
  status: 'OK' | 'NO_RESULTS' | 'NOT_CONFIGURED' | 'UNAVAILABLE';
  videos: YouTubeVideo[];
}

type YouTubeFetch = (url: string, init: {
  signal: AbortSignal;
  headers: Record<string, string>;
}) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface YouTubeSearchDependencies {
  apiKey?: string;
  fetch?: YouTubeFetch;
  now?: () => number;
  timeoutMs?: number;
}

type JsonObject = Record<string, unknown>;
type CachedResult = { expiresAt: number; result: VideoSearchResult };
type SearchState = {
  cache: Map<string, CachedResult>;
  inFlight: Map<string, Promise<VideoSearchResult>>;
};

const states = new WeakMap<YouTubeFetch, SearchState>();
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LANGUAGE_ALIASES: Record<string, string[]> = {
  en: ['English'], hi: ['Hindi', 'हिंदी', 'हिन्दी'], ur: ['Urdu', 'اردو'],
};

const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;

const text = (value: unknown, limit: number): string => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : '';

const clone = (result: VideoSearchResult): VideoSearchResult => ({
  status: result.status, videos: result.videos.map(video => ({ ...video })),
});

function configuredKey(): string {
  // Lazy loading keeps this optional integration independent of DB/JWT setup in tests.
  const { env } = require('../config/env') as { env: { YOUTUBE?: { API_KEY?: string } } };
  return env.YOUTUBE?.API_KEY ?? '';
}

function explicitLanguageClaim(value: string, names: string[]): boolean {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = '(?![\\p{L}\\p{N}])';
    const pattern = new RegExp(
      `(?:\\bin\\s+${escaped}${boundary}` +
      `|(?<![\\p{L}\\p{N}])${escaped}\\s+(?:tutorial|lesson|lecture|explanation|course|mein|me|में)${boundary}` +
      `|(?:^|\\(|\\[|\\|)\\s*${escaped}\\s*(?:\\)|\\]|\\||:|$))`, 'giu',
    );
    for (const match of value.matchAll(pattern)) {
      const before = value.slice(Math.max(0, (match.index ?? 0) - 55), match.index);
      // Captions, translated text, and negated claims do not establish spoken audio.
      if (/\b(?:not|without|no|subtitles?|captions?|translation|transcript)\b[^.!?\n]{0,35}$/iu.test(before)) continue;
      return true;
    }
  }
  return false;
}

function languageMatches(snippet: JsonObject, languageCode: string, languageName: string): boolean {
  const audio = text(snippet.defaultAudioLanguage, 40).toLowerCase();
  const base = languageCode.split('-')[0];
  if (audio) return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(audio) && audio.split('-')[0] === base;
  if (snippet.defaultAudioLanguage !== undefined && snippet.defaultAudioLanguage !== '') return false;
  const names = [...new Set([languageName, ...(LANGUAGE_ALIASES[base] ?? [])])];
  // defaultLanguage and translated metadata describe text, not the language spoken.
  return explicitLanguageClaim(text(snippet.title, 400), names)
    || explicitLanguageClaim(text(snippet.description, 5000), names);
}

async function lookup(
  request: VideoSearchRequest, apiKey: string, fetcher: YouTubeFetch, timeoutMs: number,
): Promise<VideoSearchResult> {
  const controller = new AbortController();
  const videos: YouTubeVideo[] = [];
  const seen = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = (): VideoSearchResult => ({
    status: videos.length ? 'OK' : 'UNAVAILABLE', videos,
  });

  const get = async (resource: string, params: Record<string, string>): Promise<JsonObject> => {
    if (controller.signal.aborted) throw new Error('Lookup ended');
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams({ ...params, key: apiKey }).toString();
    const response = await fetcher(url.toString(), {
      signal: controller.signal, headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('YouTube unavailable');
    const payload = object(await response.json());
    if (controller.signal.aborted || !payload || payload.error || !Array.isArray(payload.items)) {
      throw new Error('Invalid YouTube response');
    }
    return payload;
  };

  const collect = async (): Promise<VideoSearchResult> => {
    let pageToken = '';
    for (let page = 0; page < 2 && videos.length < 3; page += 1) {
      const search = await get('search', {
        part: 'snippet', type: 'video', maxResults: '25', safeSearch: 'strict', order: 'relevance',
        q: `${request.topic} tutorial in ${request.languageName}`,
        relevanceLanguage: request.languageCode,
        ...(pageToken ? { pageToken } : {}),
      });
      const ids: string[] = [];
      for (const item of (search.items as unknown[]).slice(0, 25)) {
        const id = object(object(item)?.id);
        if (!id || (id.kind !== undefined && id.kind !== 'youtube#video')) continue;
        if (typeof id.videoId !== 'string' || !VIDEO_ID.test(id.videoId) || seen.has(id.videoId)) continue;
        seen.add(id.videoId);
        ids.push(id.videoId);
      }
      if (ids.length) {
        const details = await get('videos', { part: 'snippet,contentDetails,status', id: ids.join(',') });
        const byId = new Map<string, JsonObject>();
        for (const item of (details.items as unknown[]).slice(0, 25)) {
          const video = object(item);
          if (video && typeof video.id === 'string' && ids.includes(video.id)) byId.set(video.id, video);
        }
        for (const id of ids) {
          const video = byId.get(id);
          const snippet = object(video?.snippet);
          const status = object(video?.status);
          if (!snippet || status?.privacyStatus !== 'public' || status?.uploadStatus !== 'processed'
            || snippet.liveBroadcastContent !== 'none' || !languageMatches(snippet, request.languageCode, request.languageName)) continue;
          const title = text(snippet.title, 300);
          const channelTitle = text(snippet.channelTitle, 200);
          if (!title || !channelTitle) continue;
          videos.push({ id, title, channelTitle, url: `https://www.youtube.com/watch?v=${id}` });
          if (videos.length === 3) break;
        }
      }
      const next = search.nextPageToken;
      if (typeof next !== 'string' || !next || next.length > 512 || next === pageToken) break;
      pageToken = next;
    }
    return { status: videos.length ? 'OK' : 'NO_RESULTS', videos };
  };

  try {
    const deadline = new Promise<VideoSearchResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(failure()); }, timeoutMs);
    });
    // The race also bounds clients or response bodies that ignore AbortSignal.
    return await Promise.race([collect().catch(failure), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function searchYouTubeVideos(
  request: VideoSearchRequest, deps: YouTubeSearchDependencies = {},
): Promise<VideoSearchResult> {
  let apiKey: string;
  try { apiKey = (deps.apiKey ?? configuredKey()).trim(); }
  catch { return { status: 'NOT_CONFIGURED', videos: [] }; }
  if (!apiKey) return { status: 'NOT_CONFIGURED', videos: [] };
  const topic = text(request.topic, 240).normalize('NFKC');
  const languageCode = text(request.languageCode, 20).toLowerCase();
  const languageName = LANGUAGE_ALIASES[languageCode.split('-')[0]]?.[0] ?? text(request.languageName, 40);
  if (!topic || !/^[a-z]{2}(?:-[a-z]{2,4})?$/.test(languageCode)
    || !/^[\p{L}\s-]{1,40}$/u.test(languageName)) return { status: 'NO_RESULTS', videos: [] };
  const fetcher = deps.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') return { status: 'UNAVAILABLE', videos: [] };
  const now = deps.now ?? Date.now;
  const key = JSON.stringify([
    createHash('sha256').update(apiKey).digest('hex'), topic.toLowerCase(), languageCode, languageName.toLowerCase(),
  ]);
  let state = states.get(fetcher);
  if (!state) { state = { cache: new Map(), inFlight: new Map() }; states.set(fetcher, state); }
  const cached = state.cache.get(key);
  if (cached && cached.expiresAt > now()) return clone(cached.result);
  if (cached) state.cache.delete(key);
  const existing = state.inFlight.get(key);
  if (existing) return clone(await existing);
  if (state.inFlight.size >= MAX_ENTRIES) return { status: 'UNAVAILABLE', videos: [] };
  const timeoutMs = Number.isFinite(deps.timeoutMs)
    ? Math.max(1, Math.min(15_000, deps.timeoutMs!)) : 10_000;
  const pending = lookup({ topic, languageCode, languageName }, apiKey, fetcher, timeoutMs)
    .then(result => {
      if (result.status === 'OK') {
        for (const [entryKey, entry] of state!.cache) if (entry.expiresAt <= now()) state!.cache.delete(entryKey);
        while (state!.cache.size >= MAX_ENTRIES) state!.cache.delete(state!.cache.keys().next().value!);
        state!.cache.set(key, { expiresAt: now() + CACHE_TTL_MS, result: clone(result) });
      }
      return result;
    }).finally(() => { state!.inFlight.delete(key); });
  state.inFlight.set(key, pending);
  return clone(await pending);
}
