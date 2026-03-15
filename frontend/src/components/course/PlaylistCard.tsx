import Image from 'next/image';
import { LECTURES, CHANNEL } from '@/lib/constants';

interface Props { onPlayAll: () => void }

export const PlaylistCard = ({ onPlayAll }: Props) => {
  const first = LECTURES[0];
  return (
    <div className="bg-[var(--surface)] rounded-xl overflow-hidden sticky top-[72px]">
      {/* Thumbnail */}
      <div className="relative aspect-video bg-black">
        <Image
          src={`https://i.ytimg.com/vi/${first.videoId}/hqdefault.jpg`}
          alt={first.title} fill className="object-cover"
        />
        <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-1.5 text-white">
          <i className="fas fa-play text-4xl" />
          <span className="text-[13px] font-bold tracking-widest uppercase">Play All</span>
        </div>
      </div>

      {/* Meta */}
      <div className="p-4">
        <h2 className="text-[15px] font-bold leading-snug mb-2">
          Generative AI Fundamentals Master Course
        </h2>
        <div className="flex items-center gap-2 mb-2.5 cursor-pointer">
          <div className="w-7 h-7 rounded-full bg-purple-600 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
            {CHANNEL.initials}
          </div>
          <span className="text-[13px] font-semibold text-[var(--text)]">{CHANNEL.name}</span>
        </div>
        <p className="text-xs text-[var(--muted)] mb-4">
          Playlist · {LECTURES.length} videos · 1,095 views
        </p>
        <div className="flex gap-2">
          <button
            onClick={onPlayAll}
            className="flex-1 py-2 rounded-full bg-[var(--text)] text-white text-[13px] font-bold flex items-center justify-center gap-1.5 hover:bg-gray-800 transition-colors"
          >
            <i className="fas fa-play text-xs" /> Play all
          </button>
          <button className="flex-1 py-2 rounded-full bg-[var(--surface)] border border-[var(--border)] text-[13px] font-bold flex items-center justify-center gap-1.5 hover:bg-gray-200 transition-colors">
            <i className="fas fa-shuffle text-xs" /> Shuffle
          </button>
        </div>
      </div>
    </div>
  );
};
