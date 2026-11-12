'use client';

import { useState } from 'react';
import api from '@/lib/api';

interface Playlist { playlistId: string; title: string; channelTitle: string; thumbnail: string | null }
interface Video { videoId: string; title: string; thumbnail: string | null }

export default function YouTubePilotSearch() {
  const [query, setQuery] = useState('Deep Learning');
  const [language, setLanguage] = useState<'hi' | 'en'>('hi');
  const [results, setResults] = useState<Playlist[]>([]);
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    setLoading(true); setError(''); setSelected(null); setVideos([]);
    try {
      const response = await api.get('/youtube/playlists/search', { params: { q: query, language } });
      setResults(response.data.data.playlists);
    } catch { setError('Playlist search unavailable. Ask the admin to enable the YouTube pilot and configure its API key.'); }
    finally { setLoading(false); }
  };
  const preview = async (playlist: Playlist) => {
    setSelected(playlist); setVideos([]); setError('');
    try {
      const response = await api.get('/youtube/playlists/' + encodeURIComponent(playlist.playlistId) + '/preview');
      setVideos(response.data.data.videos);
    } catch { setError('Unable to preview this playlist.'); }
  };
  return (
    <section aria-label="YouTube playlist discovery pilot" className="mb-8 rounded-card border border-[var(--border)] bg-white p-5">
      <div className="mb-3"><h2 className="text-h3 font-semibold">Discover YouTube playlists <span className="text-caption text-[var(--muted)]">(Pilot)</span></h2>
        <p className="text-label text-[var(--muted)]">Search top matches and preview up to 2 videos. Course import will be enabled after transcript tests.</p></div>
      <form onSubmit={e => { e.preventDefault(); void search(); }} className="flex flex-wrap gap-2 mb-4">
        <input aria-label="Playlist topic" value={query} onChange={e => setQuery(e.target.value)} minLength={3} maxLength={120} required className="min-w-[180px] flex-1 border rounded-control p-2" />
        <select aria-label="Lecture language" value={language} onChange={e => setLanguage(e.target.value as 'hi' | 'en')} className="border rounded-control p-2">
          <option value="hi">Hindi</option><option value="en">English</option>
        </select>
        <button disabled={loading} className="bg-[var(--accent)] text-white px-4 py-2 rounded-control disabled:opacity-50">{loading ? 'Searching...' : 'Search playlists'}</button>
      </form>
      {error && <p role="alert" className="text-red-600 text-label mb-3">{error}</p>}
      {results.length > 0 && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{results.map(p =>
        <button type="button" onClick={() => void preview(p)} key={p.playlistId} className="text-left border rounded-control p-3 hover:border-[var(--accent)]">
          {p.thumbnail && <img src={p.thumbnail} alt="" className="w-full aspect-video object-cover rounded-control mb-2" />}
          <strong className="block text-label">{p.title}</strong><span className="block text-caption text-[var(--muted)]">{p.channelTitle}</span><span className="text-caption text-[var(--accent)]">Preview first 2 videos</span>
        </button>
      )}</div>}
      {selected && <div className="mt-5 border-t pt-4"><h3 className="font-semibold mb-3">{selected.title}</h3>
        {videos.length === 0 ? <p className="text-label text-[var(--muted)]">Loading or no embeddable videos found.</p> :
          <div className="grid gap-4 md:grid-cols-2">{videos.map(v => <div key={v.videoId}>
            <div className="aspect-video"><iframe className="w-full h-full" src={'https://www.youtube-nocookie.com/embed/' + v.videoId} title={v.title} allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen loading="lazy" referrerPolicy="strict-origin-when-cross-origin" /></div>
            <p className="text-label mt-2">{v.title}</p>
          </div>)}</div>}
        <p className="text-caption text-[var(--muted)] mt-3">Pilot is preview-only. No videos or captions are downloaded by this page.</p>
      </div>}
    </section>
  );
}
