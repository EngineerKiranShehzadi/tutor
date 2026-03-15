import Image from 'next/image';
import { Lecture } from '@/types';
import { CHANNEL } from '@/lib/constants';
import { cn } from '@/lib/cn';

interface Props { lecture: Lecture; index: number; onClick: () => void }

export const VideoItem = ({ lecture, index, onClick }: Props) => {
  const isWatched  = lecture.watched === 100;
  const isWatching = lecture.watched > 0 && lecture.watched < 100;

  return (
    <div
      onClick={onClick}
      className="flex gap-3.5 p-3 rounded-xl cursor-pointer hover:bg-[var(--surface)] transition-colors"
    >
      {/* Number */}
      <div className="w-6 text-[13px] text-[var(--muted)] text-center pt-0.5 shrink-0 font-medium">
        {index + 1}
      </div>

      {/* Thumbnail */}
      <div className="relative w-36 shrink-0 aspect-video rounded-lg overflow-hidden bg-black">
        <Image
          src={`https://i.ytimg.com/vi/${lecture.videoId}/hqdefault.jpg`}
          alt={lecture.title} fill className="object-cover"
        />
        <div className="absolute bottom-1 right-1 bg-black/85 text-white text-[11px] font-semibold px-1 rounded">
          {lecture.duration}
        </div>
        {lecture.watched > 0 && (
          <div className="absolute bottom-0 left-0 h-[3px] bg-[var(--red)]" style={{ width: `${lecture.watched}%` }} />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-[14px] font-semibold leading-snug line-clamp-2 mb-1">{lecture.title}</p>
        <p className="text-[12px] text-[var(--muted)]">{CHANNEL.name} · 1 year ago</p>
      </div>

      {/* Badge */}
      {(isWatched || isWatching) && (
        <div className={cn(
          'shrink-0 self-start px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1',
          isWatched  ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
        )}>
          <i className={isWatched ? 'fas fa-check' : 'fas fa-play'} style={{ fontSize: 9 }} />
          {isWatched ? 'Done' : 'Watching'}
        </div>
      )}
    </div>
  );
};
