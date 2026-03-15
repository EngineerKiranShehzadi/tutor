'use client';
import { useRouter } from 'next/navigation';
import { PlaylistCard } from '@/components/course/PlaylistCard';
import { VideoItem }    from '@/components/course/VideoItem';
import { LECTURES }     from '@/lib/constants';

export default function CoursesPage() {
  const router = useRouter();
  const goToLecture = (id: string) => router.push(`/lecture/${id}`);

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-6 flex gap-8">
      {/* Sidebar */}
      <div className="w-[360px] shrink-0">
        <PlaylistCard onPlayAll={() => goToLecture(LECTURES[0].id)} />
      </div>

      {/* Lecture list */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold">Course Lectures</h2>
          <button className="px-3.5 py-1.5 border-[1.5px] border-[var(--border)] rounded-full text-sm text-[var(--muted)] flex items-center gap-1.5 hover:bg-[var(--surface)] transition-colors">
            <i className="fas fa-sort text-xs" /> Sort
          </button>
        </div>

        <div className="flex flex-col">
          {LECTURES.map((lec, i) => (
            <VideoItem key={lec.id} lecture={lec} index={i} onClick={() => goToLecture(lec.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
