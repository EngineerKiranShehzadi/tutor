import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { LECTURES, CHANNEL } from '@/lib/constants';
import { cn } from '@/lib/cn';

interface Props { activeLectureId: string }

export const PlaylistColumn = ({ activeLectureId }: Props) => {
  const router = useRouter();
  const done = LECTURES.filter((l) => l.watched === 100).length;

  return (
    <div className="w-[380px] shrink-0 border-l border-[var(--border)] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-[var(--border)] shrink-0">
        <p className="text-[15px] font-bold truncate">Generative AI Fundamentals Master...</p>
        <p className="text-[12px] text-[var(--muted)] mt-0.5">{CHANNEL.name}</p>
        <p className="text-[12px] text-[var(--muted)]">{done} / {LECTURES.length} · {Math.round((done / LECTURES.length) * 100)}% complete</p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto py-2 px-1">
        {LECTURES.map((lec) => {
          const isActive   = lec.id === activeLectureId;
          const isWatched  = lec.watched === 100;
          const isWatching = lec.watched > 0 && lec.watched < 100;

          return (
            <div
              key={lec.id}
              onClick={() => router.push(`/lecture/${lec.id}`)}
              className={cn(
                'flex gap-2.5 p-2 rounded-lg cursor-pointer transition-colors mb-0.5',
                isActive ? 'bg-blue-50' : 'hover:bg-[var(--surface)]'
              )}
            >
              {/* Num */}
              <div className="w-5 flex items-start justify-center pt-1 shrink-0">
                {isActive ? (
                  <i className="fas fa-play text-[10px] text-[var(--red)]" />
                ) : isWatched ? (
                  <i className="fas fa-check text-[11px] text-green-600" />
                ) : (
                  <span className="text-[12px] text-[var(--muted)]">{lec.num + 1}</span>
                )}
              </div>

              {/* Thumb */}
              <div className="relative w-[90px] shrink-0 aspect-video rounded-md overflow-hidden bg-black">
                <Image
                  src={`https://i.ytimg.com/vi/${lec.videoId}/hqdefault.jpg`}
                  alt={lec.title} fill className="object-cover"
                />
                <div className="absolute bottom-1 right-1 bg-black/85 text-white text-[10px] font-semibold px-1 rounded">
                  {lec.duration}
                </div>
                {lec.watched > 0 && (
                  <div className="absolute bottom-0 left-0 h-[2px] bg-[var(--red)]" style={{ width: `${lec.watched}%` }} />
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className={cn('text-[12px] font-semibold line-clamp-2 leading-snug', isActive && 'text-[var(--accent)]')}>
                  {lec.title}
                </p>
                <p className="text-[11px] text-[var(--muted)] mt-0.5 truncate">{CHANNEL.name}...</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
