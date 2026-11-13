'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';
import Link from 'next/link';

export type PersonalCourseStatus = 'PREVIEW_ONLY' | 'QUEUED' | 'PROCESSING' | 'PARTIAL' | 'READY' | 'FAILED' | 'EXPIRED';
interface PersonalVideo {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  position: number;
  ingest_status?: string;
  last_error?: string | null;
}
interface PersonalCourse {
  id: string;
  title: string;
  channel_title: string;
  status: PersonalCourseStatus;
  last_error?: string | null;
  expires_at?: string | null;
  videos: PersonalVideo[];
}
interface Citation {
  videoId: string;
  videoTitle: string;
  startTime: string;
  endTime: string;
  url: string;
}
interface Answer { answer: string; sources: Citation[] }

const ACTIVE: PersonalCourseStatus[] = ['QUEUED', 'PROCESSING'];
const CAN_ASK: PersonalCourseStatus[] = ['READY', 'PARTIAL'];

export default function PersonalYouTubeCourses({ refreshKey = 0 }: { refreshKey?: number }) {
  const [courses, setCourses] = useState<PersonalCourse[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [usage,setUsage]=useState<{courses:number;maxCourses:number;reservedChunkCapacity:number;maxChunkCapacity:number}|null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [question, setQuestion] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await api.get('/youtube/my-courses');
      if (!mounted.current) return;
      setCourses(response.data.data.courses ?? []);
      void api.get('/youtube/my-courses/storage-usage')
        .then(r=>{if(mounted.current)setUsage(r.data.data);})
        .catch(()=>undefined);
      setLoaded(true);
      if (!silent) setError('');
    } catch {
      if (mounted.current && !silent) setError('Unable to load your YouTube courses. Please retry.');
    } finally { inFlight.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    void api.get('/youtube/my-courses/pilot-status')
      .then(response => { if (mounted.current) setEnabled(response.data.data.enabled === true); })
      .catch(() => { if (mounted.current) setEnabled(false); });
    return () => { mounted.current = false; };
  }, [load, refreshKey]);

  useEffect(() => {
    if (!courses.some(c => ACTIVE.includes(c.status))) return;
    const timer = window.setInterval(() => { void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [courses, load]);

  const ingest = async (course: PersonalCourse) => {
    setBusyId(course.id); setError(''); setMessage('');
    try {
      await api.post('/youtube/my-courses/' + encodeURIComponent(course.id) + '/ingest');
      setMessage('Import queued. Progress refreshes automatically.');
      await load();
    } catch { setError('Could not start import. Confirm the experimental pilot is enabled and try again.'); }
    finally { setBusyId(null); }
  };

  const ask = async (course: PersonalCourse) => {
    const text = (question[course.id] ?? '').trim();
    if (text.length < 3 || text.length > 500) return;
    setBusyId(course.id); setError(''); setMessage('');
    try {
      const response = await api.post('/youtube/my-courses/' + encodeURIComponent(course.id) + '/ask', { question: text });
      setAnswers(prev => ({ ...prev, [course.id]: response.data.data as Answer }));
    } catch { setError('AI tutor could not answer. Check course readiness and try again.'); }
    finally { setBusyId(null); }
  };

  const remove = async (course: PersonalCourse) => {
    if (!window.confirm('Remove this personal course and its imported transcripts?')) return;
    setBusyId(course.id); setError(''); setMessage('');
    try {
      await api.delete('/youtube/my-courses/' + encodeURIComponent(course.id));
      setAnswers(prev => { const next = { ...prev }; delete next[course.id]; return next; });
      await load();
      setMessage('Course removed.');
    } catch { setError('Could not remove course.'); }
    finally { setBusyId(null); }
  };

  return (
    <section aria-label="My YouTube Courses" className="mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-h2 font-semibold text-[var(--text)]">My YouTube Courses</h2>
          <p className="text-label text-[var(--muted)]">Courses you add are private to your account. Study and generate quizzes from ready lectures.</p>
        </div>
        <button type="button" onClick={() => void load()} className="text-label underline">Refresh</button>
      </div>
      {error && <p role="alert" className="text-red-600 text-label mb-3">{error}</p>}
      {message && <p role="status" className="text-label mb-3">{message}</p>}
      {usage && <p className="text-label text-[var(--muted)] mb-3" role="status">
        Storage: {usage.courses}/{usage.maxCourses} personal courses ·
        reserved up to {usage.reservedChunkCapacity}/{usage.maxChunkCapacity} transcript chunks.
      </p>}
      {loaded && courses.length === 0 && <p className="text-label text-[var(--muted)]">No personal courses yet. Search a playlist below and choose Add to My Courses.</p>}
      <div className="grid gap-5 md:grid-cols-2">
        {courses.map(course => (
          <article key={course.id} className="rounded-card border border-[var(--border)] bg-white p-6 shadow-md hover:shadow-lg transition-shadow">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="min-w-0 flex-1"><div className="mb-3 w-12 h-12 rounded-control bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center"><i className="fab fa-youtube text-xl" /></div><h3 className="font-semibold text-h3 text-[var(--text)]">{course.title}</h3>
                <p className="text-caption text-[var(--muted)]">{course.channel_title} · {course.videos.length} videos</p></div>
              <span className="text-caption font-semibold rounded-control px-3 py-1 bg-[var(--surface)] text-[var(--muted)]">{course.status.replace('_', ' ')}</span>
            </div>
            {course.expires_at && ['READY','PARTIAL'].includes(course.status) && (
              <p className="text-caption text-[var(--gold)] mt-2">
                Indexed content expires after inactivity around {new Date(course.expires_at).toLocaleDateString()}.
                Open your tutor to extend availability.
              </p>
            )}
            {course.status === 'EXPIRED' && <p className="text-label text-[var(--muted)] mt-2">
              Indexed content expired to save storage. Your old chats remain; select Re-import to study again.
            </p>}
            {course.last_error && <p className="text-caption text-red-600 mt-2">Import issue: {course.last_error}</p>}
            <div className="grid gap-2 mt-3 sm:grid-cols-2">
              {course.videos.map(video => (
                <div key={video.video_id} className="rounded-control border border-[var(--border)] bg-[var(--surface)] p-3">
                  <p className="text-label">{video.position}. {video.title}</p>
                  {video.ingest_status && <p className="text-caption text-[var(--muted)]">Transcript: {video.ingest_status.replace('_', ' ')}</p>}
                  {video.last_error && <p className="text-caption text-red-600">{video.last_error}</p>}
                  <a className="text-caption text-[var(--accent)] underline" href={'https://www.youtube.com/watch?v=' + video.video_id} target="_blank" rel="noopener noreferrer">Watch video</a>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-3 mt-3">
              {enabled && (course.status === 'PREVIEW_ONLY' || course.status === 'FAILED' || course.status === 'PARTIAL' || course.status === 'EXPIRED') &&
                <button type="button" disabled={busyId === course.id} onClick={() => void ingest(course)}
                  className="bg-[var(--accent)] text-white px-4 py-2 rounded-control text-label font-semibold hover:bg-[var(--accent-deep)] disabled:opacity-50">
                  {course.status === 'PREVIEW_ONLY' ? 'Start AI Import' : course.status === 'EXPIRED' ? 'Re-import expired course' : 'Retry Failed Videos'}
                </button>}
              {ACTIVE.includes(course.status) && <span role="status" className="text-label text-[var(--muted)]">Processing transcripts and embeddings…</span>}
              <button type="button" disabled={busyId === course.id} onClick={() => void remove(course)}
                className="border border-[var(--border)] text-[var(--muted)] px-4 py-2 rounded-control text-label disabled:opacity-50">Remove course</button>
            </div>
            {CAN_ASK.includes(course.status) && enabled && (
              <div className="mt-4 pt-4 border-t">
                <p className="text-label text-[var(--muted)] mb-3">Open a lecture to study with the existing video player, tutor, history and teacher avatar.</p>
                <div className="flex flex-wrap gap-2">
                  {course.videos.filter(v => v.ingest_status === 'READY').map(v => (
                    <Link key={v.video_id}
                      href={`/youtube/course/${encodeURIComponent(course.id)}/${encodeURIComponent(v.video_id)}`}
                      className="px-4 py-2 rounded-control bg-[var(--accent)] text-white text-label font-semibold hover:bg-[var(--accent-deep)]">
                      Open Tutor · Lecture {v.position}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {!enabled && <p className="text-caption text-[var(--muted)] mt-3">AI import is disabled until the local testing pilot is configured.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
