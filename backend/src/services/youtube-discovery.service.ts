import { checkCaptionEligibility } from './youtube-caption-eligibility.service';
import { AppError } from '../middleware/errorHandler';

// YouTube metadata only: public discovery is NOT permission to download captions.
// The import/transcript pipeline will be a separate, opt-in integration.
export interface PlaylistMatch {
  playlistId: string;
  title: string;
  channelTitle: string;
  thumbnail: string | null;
}
export interface PreviewVideo { videoId: string; title: string; thumbnail: string | null }

const enabled = (): boolean => process.env.YOUTUBE_PILOT_ENABLED === 'true';
const playlistIdPattern = /^[a-zA-Z0-9_-]{10,100}$/;
export const validPlaylistId = (id: string): boolean => playlistIdPattern.test(id);

async function youtubeGet(endpoint: string, params: Record<string, string>): Promise<any> {
  if (!enabled()) throw new AppError('YouTube pilot is disabled', 503);
  const key = process.env.YOUTUBE_DATA_API_KEY;
  if (!key) throw new AppError('YouTube API key is not configured', 503);
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('key', key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) throw new AppError('YouTube quota or access temporarily unavailable', 503);
      if (response.status === 404) throw new AppError('YouTube playlist not found', 404);
      throw new AppError('YouTube metadata request failed', 502);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('YouTube is temporarily unreachable', 503);
  } finally {
    clearTimeout(timer);
  }
}

const thumb = (item: any): string | null =>
  item?.snippet?.thumbnails?.medium?.url ?? item?.snippet?.thumbnails?.default?.url ?? null;

export async function searchPlaylists(query: string, language = 'hi'): Promise<PlaylistMatch[]> {
  const q = query.trim().replace(/\s+/g, ' ');
  if (q.length < 3 || q.length > 120) throw new AppError('Search must contain 3-120 characters', 400);
  if (!/^(hi|en)$/.test(language)) throw new AppError('Language must be hi or en', 400);
  const data = await youtubeGet('search', {
    part: 'snippet', type: 'playlist', order: 'relevance',
    maxResults: '5', q: q + (language === 'hi' ? ' Hindi course playlist' : ' English course playlist'),
  });
  const candidates = (data.items ?? []).filter((x: any) => validPlaylistId(String(x.id?.playlistId ?? ''))).map((x: any) => ({
    playlistId: x.id.playlistId,
    title: String(x.snippet?.title ?? '').slice(0, 200),
    channelTitle: String(x.snippet?.channelTitle ?? '').slice(0, 150),
    thumbnail: thumb(x),
  }));
  // Search shows only playlists with at least one verified, usable caption
  // among the first two videos. Two concurrent probes bound resource usage.
  const checked: PlaylistMatch[]=[];
  let unverified=0;
  for(let i=0;i<candidates.length;i+=2) {
    const batch=await Promise.all(candidates.slice(i,i+2).map(async(p:PlaylistMatch)=>{
      try {return (await previewPlaylist(p.playlistId)).length?p:null;}
      catch(error) {
        if(error instanceof AppError && error.statusCode===503)unverified++;
        return null;
      }
    }));
    for(const p of batch)if(p)checked.push(p);
  }
  if(!checked.length && unverified>0)
    throw new AppError('YouTube caption verification is temporarily unavailable. Please retry.',503);
  return checked;
}

export async function previewPlaylist(playlistId: string): Promise<PreviewVideo[]> {
  if (!validPlaylistId(playlistId)) throw new AppError('Invalid playlist ID', 400);
  // Pilot safety cap: verify only the first two videos; no embeddings or persistence.
  const data = await youtubeGet('playlistItems', {
    part: 'snippet', playlistId, maxResults: '2',
  });
  const candidates: PreviewVideo[]=(data.items??[]).filter((x:any)=>
    /^[a-zA-Z0-9_-]{11}$/.test(String(x.snippet?.resourceId?.videoId??''))
  ).map((x:any)=>({
    videoId:x.snippet.resourceId.videoId,
    title:String(x.snippet?.title??'').slice(0,200),
    thumbnail:thumb(x),
  }));
  const checks=await Promise.all(candidates.map(async v=>({video:v,state:await checkCaptionEligibility(v.videoId)})));
  const eligible=checks.filter(x=>x.state==='available').map(x=>x.video);
  if(!eligible.length && checks.some(x=>x.state==='unknown'))
    throw new AppError('YouTube caption verification is temporarily unavailable. Please retry.',503);
  return eligible;
}

export async function getPlaylistMetadata(playlistId: string): Promise<PlaylistMatch> {
  if (!validPlaylistId(playlistId)) throw new AppError('Invalid playlist ID', 400);
  const data = await youtubeGet('playlists', { part: 'snippet', id: playlistId, maxResults: '1' });
  const item = data.items?.[0];
  if (!item) throw new AppError('Playlist not found or not public', 404);
  return {
    playlistId,
    title: String(item.snippet?.title ?? '').slice(0, 200) || 'Untitled playlist',
    channelTitle: String(item.snippet?.channelTitle ?? '').slice(0, 150),
    thumbnail: thumb(item),
  };
}
