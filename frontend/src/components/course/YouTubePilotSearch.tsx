'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import PersonalYouTubeCourses from './PersonalYouTubeCourses';

interface Playlist { playlistId: string; title: string; channelTitle: string; thumbnail: string | null }
interface Video { videoId: string; title: string; thumbnail: string | null }

export default function YouTubePilotSearch() {
  const { user } = useAuth();
  const [coursesRefresh, setCoursesRefresh] = useState(0);
  const [adding, setAdding] = useState(false);
  const addToMyCourses = async (playlistId: string) => {
    setAdding(true); setMessage('');
    try {
      await api.post('/youtube/my-courses', { playlistId });
      setCoursesRefresh(v => v + 1);
      setMessage('Added to My Courses. You can start the 2-video AI import above if the pilot is enabled.');
    } catch { setMessage('Unable to add playlist to My Courses.'); }
    finally { setAdding(false); }
  };
  const [saved, setSaved] = useState<Playlist[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const loadSaved = async () => {
    try {
      const response = await api.get('/youtube/saved');
      setSaved(response.data.data.playlists.map((p: any) => ({
        playlistId: p.playlist_id, title: p.title,
        channelTitle: p.channel_title, thumbnail: p.thumbnail_url,
      })));
    } catch { setMessage('Could not load saved playlists.'); }
  };
  const save = async (playlist: Playlist) => {
    setSaving(true); setMessage('');
    try {
      await api.post('/youtube/saved', { playlistId: playlist.playlistId });
      await loadSaved();
      setMessage('Playlist saved to your list. AI tutoring is not ready yet.');
    } catch { setMessage('Could not save playlist. Please try again.'); }
    finally { setSaving(false); }
  };
  const remove = async (playlistId: string) => {
    setSaving(true); setMessage('');
    try {
      await api.delete('/youtube/saved/' + encodeURIComponent(playlistId));
      await loadSaved();
      setMessage('Playlist removed from your list.');
    } catch { setMessage('Could not remove playlist.'); }
    finally { setSaving(false); }
  };
  const [query, setQuery] = useState('Deep Learning');
  const [language, setLanguage] = useState<'hi' | 'en'>('hi');
  const [results, setResults] = useState<Playlist[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Playlist | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const search = async () => {
    setLoading(true); setSearched(false); setError(''); setSelected(null); setVideos([]);
    try {
      const response = await api.get('/youtube/playlists/search', { params: { q: query, language } });
      setResults(response.data.data.playlists);
      setSearched(true);
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
        <p className="text-label text-[var(--muted)]">Search top matches, preview up to 2 videos, and add a private course. AI import is a separate opt-in testing step.</p></div>
      <form onSubmit={e => { e.preventDefault(); void search(); }} className="flex flex-wrap gap-2 mb-4">
        <input aria-label="Playlist topic" value={query} onChange={e => setQuery(e.target.value)} minLength={3} maxLength={120} required className="min-w-[180px] flex-1 border rounded-control p-2" />
        <select aria-label="Lecture language" value={language} onChange={e => setLanguage(e.target.value as 'hi' | 'en')} className="border rounded-control p-2">
          <option value="hi">Hindi</option><option value="en">English</option>
        </select>
        <button disabled={loading} className="bg-[var(--accent)] text-white px-4 py-2 rounded-control disabled:opacity-50">{loading ? 'Checking captioned playlists...' : 'Search playlists'}</button>
      </form>
      {user?.role === 'STUDENT' && <PersonalYouTubeCourses refreshKey={coursesRefresh} />}
      {user?.role === 'STUDENT' && <div className="mb-4">
        <button type="button" onClick={() => void loadSaved()} className="text-label underline mb-2">Load My Saved Playlists</button>
        {saved.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{saved.map(p =>
          <div key={p.playlistId} className="border rounded-control p-3">
            <p className="font-semibold text-label">{p.title}</p>
            <p className="text-caption text-[var(--muted)]">Saved bookmark</p>
            <button disabled={saving} type="button" className="text-label underline" onClick={() => void remove(p.playlistId)}>Remove</button>
          </div>)}</div>}
      </div>}
      {message && <p role="status" className="text-label mb-3">{message}</p>}
      {error && <p role="alert" className="text-red-600 text-label mb-3">{error}</p>}
      {searched && results.length===0 && <p role="status" className="text-label text-[var(--muted)] mb-3">No playlists with usable Hindi, Urdu or English captions in the first two videos. Try another topic or language.</p>}
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
        {user?.role === 'STUDENT' && <button type="button" disabled={adding} onClick={() => void addToMyCourses(selected.playlistId)}
          className="mt-3 mr-3 px-4 py-2 bg-[var(--accent)] text-white rounded-control disabled:opacity-50">Add to My Courses (Preview)</button>}
        {user?.role === 'STUDENT' && <button type="button" disabled={saving} onClick={() => void save(selected)}
          className="mt-3 px-4 py-2 bg-[var(--accent)] text-white rounded-control disabled:opacity-50">Save to My Playlists</button>}
        <p className="text-caption text-[var(--muted)] mt-3">Add to My Courses saves a private preview. Transcript import must be started separately; it may fail when captions are unavailable.</p>
      </div>}
    </section>
  );
}
